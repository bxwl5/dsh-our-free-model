/**
 * 模型目录的统一解析助手：**远端 → 落盘缓存 → 兜底表** 三层回退。
 *
 * ## 为什么要有这一层
 *
 * 2026-10-26 之前，20 个渠道各自实现了一份 `ensureRemoteModels` + TTL + 
 * `remoteModels ?? fallbackModels`，结果出现三类不一致：
 *
 * 1. **有的做并集、有的做覆盖** —— 并集的渠道会让上游已下架的模型永远留在
 *    列表里（用户选到不能用的模型）；
 * 2. **倍率来源不统一** —— 有的用兜底表的过期值（实测 qoder 4 个模型倍率
 *    不一致，最大差 2.5 倍），有的根本没解析；
 * 3. **进程重启就丢** —— 只在内存里缓存，重启后回落兜底表（旧模型 + 旧倍率）。
 *
 * 本模块把这三件事收成一处，各渠道只负责「怎么拉、怎么解析」。
 *
 * ## 语义（用户 2026-10-26 明确要求）
 *
 * - **覆盖**：拉到就用远端的**全部**，不与兜底表做并集；
 * - **落盘**：拉取成功即写 `model-catalog.json`，重启后仍可用；
 * - **失败保留**：拉取失败不清空已有数据（网络抖一下不该让模型全没了）；
 * - **凭据失效也能显示**：拉不到时用落盘缓存（用户要求「登录失效/删除凭证
 *   显示上一次的模型列表」）；
 * - **兜底表只是冷启动样本**：只有从未成功拉到过时才用它。
 */

import type { CatalogModel, CatalogSnapshot } from './model-catalog-store.js'
import { loadCatalog, saveCatalog } from './model-catalog-store.js'

/** 目录数据来源（排障与 UI 提示用）。 */
export type CatalogSource = 'remote' | 'cache' | 'fallback'

/** 解析结果。 */
export interface ResolvedCatalog {
  /** 最终可用的模型列表。 */
  models: readonly CatalogModel[]
  /** 这批数据来自哪一层。 */
  source: CatalogSource
  /** 落盘/远端快照的时间（`fallback` 时为 undefined）。 */
  fetchedAt?: number
}

/** 单次解析的参数。 */
export interface ResolveCatalogOptions {
  /** 渠道 id。 */
  provider: string
  /**
   * 拉远端目录。**返回空数组或抛错都算「这次没拿到」**，
   * 此时保留旧数据并回退到缓存/兜底。
   */
  fetchRemote: () => Promise<readonly CatalogModel[] | undefined>
  /** 兜底表（冷启动样本）。 */
  fallback: readonly CatalogModel[]
  /** 是否强制重拉（忽略内存 TTL）。 */
  force?: boolean
}

/**
 * 进程内的内存缓存：provider → 快照。
 *
 * 与落盘缓存分工：内存避免每次 `listModels` 都读盘；落盘负责跨进程。
 * 内存命中时**不读盘、不联网**（首屏性能的关键）。
 */
const memory = new Map<string, CatalogSnapshot>()

/** 进行中的拉取（并发去重：`listModels` 与 `resolveModel` 会被并发调用）。 */
const inflight = new Map<string, Promise<void>>()

/** 内存 TTL：与落盘快照的「新鲜度」判定共用同一个阈值。 */
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000

/** 失败后的冷却时间：避免未登录时每次列模型都打一遍上游。 */
export const CATALOG_FAILURE_COOLDOWN_MS = 30_000

/** provider → 上次失败时间。 */
const failedAt = new Map<string, number>()

/** 仅供单测：清空内存状态。 */
export function resetCatalogResolverForTest(): void {
  memory.clear()
  inflight.clear()
  failedAt.clear()
}

/**
 * 解析某渠道的模型目录（三层回退 + 覆盖语义）。
 *
 * ⚠️ 调用方**不应**自己再判 `remoteModels !== undefined`：所有判定都在这里。
 */
export async function resolveCatalog(options: ResolveCatalogOptions): Promise<ResolvedCatalog> {
  const { provider, fetchRemote, fallback, force } = options

  // ① 内存命中（且未过期、非强制刷新）→ 直接返回，不读盘不联网。
  const cachedMemory = memory.get(provider)
  if (cachedMemory !== undefined && force !== true && Date.now() - cachedMemory.fetchedAt < CATALOG_TTL_MS) {
    return { models: cachedMemory.models, source: 'remote', fetchedAt: cachedMemory.fetchedAt }
  }

  // ② 尝试拉远端（并发去重 + 失败冷却）。
  const shouldFetch = force === true
    || (failedAt.get(provider) === undefined || Date.now() - failedAt.get(provider)! >= CATALOG_FAILURE_COOLDOWN_MS)
  if (shouldFetch) {
    const existing = inflight.get(provider)
    if (existing !== undefined) {
      await existing
    } else {
      const task = (async () => {
        try {
          const models = await fetchRemote()
          if (models !== undefined && models.length > 0) {
            const snapshot: CatalogSnapshot = { fetchedAt: Date.now(), models }
            memory.set(provider, snapshot)
            // 拉取成功即**覆盖**落盘（用户要求：获取到了直接覆盖本地）。
            saveCatalog(provider, models, snapshot.fetchedAt)
            failedAt.delete(provider)
          } else {
            failedAt.set(provider, Date.now())
          }
        } catch {
          // 失败静默：保留旧数据，由下面的回退层接管。
          failedAt.set(provider, Date.now())
        } finally {
          inflight.delete(provider)
        }
      })()
      inflight.set(provider, task)
      await task
    }
    // 拉取后重新读内存（可能刚被本任务写入）。
    const refreshed = memory.get(provider)
    if (refreshed !== undefined) {
      return { models: refreshed.models, source: 'remote', fetchedAt: refreshed.fetchedAt }
    }
  }

  // ③ 回退到落盘缓存（**凭据失效/删除凭证时的数据源**）。
  const cachedDisk = loadCatalog(provider)
  if (cachedDisk !== undefined && cachedDisk.models.length > 0) {
    // 预热内存，避免下次又读盘。
    memory.set(provider, cachedDisk)
    return { models: cachedDisk.models, source: 'cache', fetchedAt: cachedDisk.fetchedAt }
  }

  // ④ 最后才用兜底表（冷启动样本：新装用户从未拉到过时）。
  return { models: fallback, source: 'fallback' }
}

/**
 * 拼展示名：`名称 · x0.5` / `名称 · 免费` / **纯名称**（无倍率）。
 *
 * 用户明确要求「没有倍率的直接不显示倍率」—— 上游没给 `priceFactor` 时
 * 绝不编造 `x1` 之类的默认值。
 */
export function catalogDisplayName(
  model: CatalogModel,
  options: { localize?: (model: CatalogModel) => string } = {},
): string {
  const base = options.localize === undefined ? model.name : options.localize(model)
  // ⚠️ 0 是合法倍率（免费），必须用 `=== 0` 而不是真值判断。
  if (model.priceFactor === 0) return `${base} · 免费`
  if (typeof model.priceFactor === 'number') {
    const before = model.originalPriceFactor
    if (typeof before === 'number' && before !== model.priceFactor) {
      return `${base} · x${before}→x${model.priceFactor}`
    }
    return `${base} · x${model.priceFactor}`
  }
  return base
}
