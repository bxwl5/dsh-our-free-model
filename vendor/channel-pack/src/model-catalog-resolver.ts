/**
 * 统一的「**远端优先 + 落盘缓存 + 兜底**」模型目录解析助手。
 *
 * ## 解决什么
 *
 * 各渠道适配器各自实现了一份 `ensureRemoteModels()`（TTL/永久缓存 + 失败冷却）+
 * `remoteModels ?? fallbackModels`。行为虽同源，实现已漂移出多种口味：
 * 有的成功即永久缓存（上游下架永远跟不上）、有的带 TTL；有的失败保留旧列表、
 * 有的把兜底表并进远端结果。用户要求（2026-10-26）把语义统一为：
 *
 * 1. **远端优先 + 覆盖**：拉到了就用远端的**全部**，**不与兜底表做并集**
 *    （AutoClaw 那类「目录残缺要补兜底」的渠道例外，由适配器在自己的
 *    fetch/parse 里显式补齐后再返回 —— 本助手不做猜测性合并）；
 * 2. **没有倍率的直接不显示倍率**：字段是可选的，缺就是不显示；
 * 3. **定时刷新**：目录新鲜度由 `model-catalog-refresh.ts` 的调度负责，本助手
 *    命中内存/落盘缓存就**不再打远端**（首屏零等待，请求量不放大）；
 * 4. **凭据失效 / 未登录 / 拉取失败 → 显示上一次的列表**：失败**保留**内存与
 *    落盘里上一次成功的结果，绝不清空、也不回退到兜底表（除非从未成功拉取过）；
 * 5. **兜底表只服务「第一次」**：全新安装、从未成功拉取过时，兜底表告诉新用户
 *    这个渠道有哪些模型 —— 这正是兜底表的唯一正当职责。
 *
 * ## 解析链（按序短路）
 *
 * ```
 * resolve(provider, { fetchRemote, fallback })
 *   ① 内存镜像（本模块持有；定时刷新成功后也写它 ⇒ 适配器下次调用即见新目录）
 *   ② 落盘缓存 loadCatalog(provider)（上次成功拉取的完整目录；冷启动即命中）
 *   ③ 远端：经 RemoteCatalogGate（并发去重 + 失败冷却）拉一次；
 *      成功（非空）→ 写内存 + 写落盘（覆盖）→ 返回远端
 *      失败/空    → 保留 ①②，什么都没拉到过才用 ④
 *   ④ 兜底表 fallback()（仅此时）
 * ```
 *
 * ## 渠道成员怎么接（**只改自己渠道的 fetch/parse**）
 *
 * ```ts
 * private async ensureRemoteModels(): Promise<void> {
 *   this.remoteModels = await resolveCatalog({
 *     provider: this.product.id,
 *     fetchRemote: () => fetchXxxCatalog(...),   // ← 唯一要写的部分
 *   })
 * }
 * ```
 *
 * - 不要再写 TTL / 冷却 / 合并逻辑 —— 那些都在这里和调度器里；
 * - `this.remoteModels` 只是**派生视图**（每次 `listModels`/`resolveModel` 都会
 *   重新取一遍，内存命中是 Map 读，开销可忽略），**权威是本模块的内存镜像**：
 *   定时刷新成功后镜像已更新，适配器下一次调用就能看到新目录；
 * - 适配器自己的 `listAllModels()` 继续 `remoteModels ?? fallbackModels`，
 *   与解析链④天然一致。
 */

import { loadCatalog, saveCatalog, type CatalogModel } from './model-catalog-store.js'
import { RemoteCatalogGate, REMOTE_CATALOG_COOLDOWN_MS } from './remote-catalog-gate.js'

/** 镜像里的一条目录：模型列表 + 拉取时间（诊断与「上次刷新」展示用）。 */
interface MirrorEntry {
  models: CatalogModel[]
  fetchedAt: number
}

/** 单次解析的入参。 */
export interface ResolveCatalogOptions {
  /**
   * 真正的远端拉取 + 解析（**渠道成员唯一要实现的部分**）。
   *
   * 契约：成功返回**完整**目录（覆盖语义，不与兜底合并）；没拿到就抛错或返回
   * 空数组 —— 两者等价，都会走失败路径。
   */
  fetchRemote: () => Promise<readonly CatalogModel[]>
  /**
   * 兜底表（编译期快照）。**只在从未成功拉取过**（内存/落盘/远端全空）时使用。
   * 返回数组或 `undefined`；给了却返回 undefined 等同没给。
   */
  fallback?: () => readonly CatalogModel[] | undefined
}

/** 解析助手的可注入依赖（单测用；缺省接真实的落盘存储）。 */
export interface ModelCatalogResolverDeps {
  load?: (provider: string) => { fetchedAt: number; models: CatalogModel[] } | undefined
  save?: (provider: string, models: readonly CatalogModel[], fetchedAt: number) => boolean
  /** 失败/空结果后的冷却毫秒（对齐 `REMOTE_CATALOG_COOLDOWN_MS`）。 */
  cooldownMs?: number
  now?: () => number
}

export class ModelCatalogResolver {
  private readonly mirror = new Map<string, MirrorEntry>()
  private readonly gates = new Map<string, RemoteCatalogGate>()
  /** 每 provider 的强制刷新在飞去重（与展示闸门分离：刷新不受冷却钳制）。 */
  private readonly refreshing = new Map<string, Promise<boolean>>()
  private readonly load: (provider: string) => { fetchedAt: number; models: CatalogModel[] } | undefined
  private readonly save: (provider: string, models: readonly CatalogModel[], fetchedAt: number) => boolean
  private readonly cooldownMs: number
  private readonly now: () => number

  constructor(deps: ModelCatalogResolverDeps = {}) {
    this.load = deps.load ?? loadCatalog
    this.save = deps.save ?? saveCatalog
    this.cooldownMs = deps.cooldownMs ?? REMOTE_CATALOG_COOLDOWN_MS
    this.now = deps.now ?? (() => Date.now())
  }

  /** 解析链①：内存镜像（非空才算命中）。 */
  peek(provider: string): readonly CatalogModel[] | undefined {
    const entry = this.mirror.get(provider)
    return entry !== undefined && entry.models.length > 0 ? entry.models : undefined
  }

  /** 镜像里该目录的拉取时间（毫秒）；未命中返回 `undefined`。 */
  fetchedAtOf(provider: string): number | undefined {
    return this.mirror.get(provider)?.fetchedAt
  }

  /** 丢弃某渠道的内存镜像（登录态变化 / 用户主动刷新目录时用；落盘不受影响）。 */
  forget(provider: string): void {
    this.mirror.delete(provider)
    this.gates.delete(provider)
  }

  /**
   * 解析该渠道当前应展示/使用的模型目录（见文件头的解析链）。
   *
   * ⚠️ **永不抛错**：远端失败被闸门吞掉并落到兜底链 —— 调用点在列模型/首屏路径上，
   * 抛错会把整个 provider 从模型列表里打掉。
   */
  async resolve(provider: string, options: ResolveCatalogOptions): Promise<CatalogModel[]> {
    // ① 内存镜像：命中即返回（远端拉取不在本路径上 —— 定时刷新负责新鲜度）。
    const cached = this.peek(provider)
    if (cached !== undefined) return [...cached]
    // ② 落盘缓存：上次成功拉取的完整目录。冷启动即命中 ⇒ 首屏零等待；
    //    同时回填镜像，后续调用连读盘都省掉。
    const entry = this.load(provider)
    if (entry !== undefined && entry.models.length > 0) {
      this.mirror.set(provider, { models: [...entry.models], fetchedAt: entry.fetchedAt })
      return [...entry.models]
    }
    // ③ 远端：闸门保证同 provider 的并发调用只拉一次、失败后冷却。
    //    ⚠️ run 内部抛错被闸门吞掉（返回 false），不会向上传播。
    await this.gateFor(provider).run(async () => {
      const models = await options.fetchRemote()
      if (models === undefined || models.length === 0) return false
      this.adopt(provider, models)
      return true
    })
    // 拉取成功 ⇒ 镜像已有；失败 ⇒ 保持 ②的落盘结果（若有过）。再查一次镜像
    // 而不是复用 entry：并发场景下另一个调用可能在 await 期间已 adopt 了。
    const after = this.peek(provider)
    if (after !== undefined) return [...after]
    // ④ 兜底表：只有「从未成功拉取过」才会走到这里 —— 兜底表的唯一正当职责。
    const fallback = options.fallback?.()
    return fallback === undefined ? [] : [...fallback]
  }

  /**
   * 强制拉取一次并覆盖缓存（定时刷新 / 用户手动刷新用）。
   *
   * 与 {@link resolve} 的差异：
   * - **不受展示闸门的失败冷却钳制**（定时刷新是显式动作，冷却会整轮漏拉；
   *   展示路径的冷却保护的是「首屏反复重试」，这里是低频串行轮询）；
   * - **不读缓存**：就是要去远端拿最新的；
   * - 失败/空 → 返回 `false`，**内存与落盘都原样保留**（不清空）。
   *
   * 同 provider 的并发刷新共享同一次在飞调用。
   */
  async refresh(provider: string, fetchRemote: () => Promise<readonly CatalogModel[]>): Promise<boolean> {
    const inflight = this.refreshing.get(provider)
    if (inflight !== undefined) return await inflight
    const task = (async (): Promise<boolean> => {
      try {
        const models = await fetchRemote()
        if (models === undefined || models.length === 0) return false
        this.adopt(provider, models)
        return true
      } catch {
        // 拉取失败：保留上一次成功结果（不清空），由调用方记日志。
        return false
      } finally {
        if (this.refreshing.get(provider) === task) this.refreshing.delete(provider)
      }
    })()
    this.refreshing.set(provider, task)
    return await task
  }

  /** 把一份**成功拉到的**目录写入内存 + 落盘（唯一允许写缓存的路径）。 */
  private adopt(provider: string, models: readonly CatalogModel[]): void {
    const fetchedAt = this.now()
    const list = [...models]
    // ⚠️ 先写内存再写盘：落盘失败（只记 warn）时本会话仍有内存可用；
    // 下次冷启动丢的是「这一次的刷新」，不影响当前会话。
    this.mirror.set(provider, { models: list, fetchedAt })
    this.save(provider, list, fetchedAt)
  }

  /** 每 provider 一把闸门：并发去重 + 失败冷却（与既有适配器同款语义）。 */
  private gateFor(provider: string): RemoteCatalogGate {
    let gate = this.gates.get(provider)
    if (gate === undefined) {
      gate = new RemoteCatalogGate({ cooldownMs: this.cooldownMs })
      this.gates.set(provider, gate)
    }
    return gate
  }
}

/**
 * 模块级默认实例（内存镜像全进程唯一 —— 这就是「内存缓存」这一层）。
 *
 * ⚠️ 依赖的 `loadCatalog`/`saveCatalog` 是函数引用而非对象，`configureModelCatalogStore`
 * 重建后端不影响这里的引用（home 解析在 store 内部每次重算）。
 */
export const modelCatalogResolver = new ModelCatalogResolver()

/**
 * 解析某渠道当前应展示的模型目录 —— 渠道适配器的唯一入口（见文件头的接入示例）。
 *
 * 薄封装 {@link ModelCatalogResolver.resolve}（走模块级默认实例，镜像全进程共享）。
 */
export function resolveCatalog(
  options: ResolveCatalogOptions & { provider: string },
): Promise<CatalogModel[]> {
  const { provider, ...rest } = options
  return modelCatalogResolver.resolve(provider, rest)
}

/**
 * 强制刷新某渠道的目录并覆盖缓存 —— 定时刷新调度器与手动刷新入口用它。
 *
 * @returns 是否拉到了新目录（`false` = 失败/空，缓存原样保留）。
 */
export function refreshCatalog(
  provider: string,
  fetchRemote: () => Promise<readonly CatalogModel[]>,
): Promise<boolean> {
  return modelCatalogResolver.refresh(provider, fetchRemote)
}
