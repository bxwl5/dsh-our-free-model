/**
 * 远端模型目录的**持久快照**（落盘），让「上次拉成功的那份目录」跨进程存活。
 *
 * ## 解决什么（用户 2026-10-27 指定）
 *
 * 各渠道的**兜底模型表**是编译期快照：价格、上下文、上下架全都停在打包那天。
 * 而远端目录只存在内存里（`this.remoteModels`），进程一重启就没了 ——
 * 于是**只要这次启动的网络/凭据不顺**，用户看到的就是几天前甚至几个月前的
 * 那张表，倍率、新模型、下架状态全都不对。
 *
 * 用户要求的语义（逐字）：
 *
 * > 远端拉取全量覆盖兜底表（不是增量，是直接写入到兜底表），全部渠道都这样。
 *
 * 即：**远端目录是唯一事实来源**，拉成功就把整份目录写下来；以后即使拉不到，
 * 也用「最后成功的那一份」顶上，而不是退回编译期兜底表。
 *
 * ## 与 `dead-model-store` 的关系
 *
 * 同一套 home 解析与原子写策略（见 `dead-model-store.ts` 的说明），
 * 区别只有两点：
 * 1. **按 provider 一个文件**（`model-catalogs/<provider>.json`）—— 目录体量
 *    比失效表大得多，且各渠道互不影响：某个渠道文件损坏不该拖垮其它渠道；
 * 2. 存的是**适配器解析后的远端条目原样数组**，本模块**不懂**各家的字段结构，
 *    只做「是不是一个带 id 的对象数组」这层通用校验（各适配器读字段时本来就
 *    逐字段做 `typeof` 防御，故不必在这里重复一遍 schema）。
 *
 * ## ⚠️ 只做「全量替换」，不做合并
 *
 * `writeModelCatalog()` 是**整份覆盖**，从不与已有文件求并集。这与用户要求的
 * 「不是增量」一致：上游下架的模型必须在快照里**消失**，否则会永久残留。
 *
 * ## 为什么不能只靠 `remoteModelsAt` 的 TTL
 *
 * TTL 只管「内存里的这份还新不新」，管不了「内存是空的怎么办」。恢复快照后
 * 把 `remoteModelsAt` 置为 `Date.now()`，让 TTL 照常生效 —— 下次过期就重试，
 * 成功即覆盖快照，失败则继续用旧快照（最多每 TTL 重试一次，不会放大请求）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveChannelPackHome } from './channel-pack-store.js'

/** 存放全部渠道目录快照的目录名（与 `state.json` 同级）。 */
export const MODEL_CATALOG_DIR = 'model-catalogs'

/** 快照格式版本。改字段结构时必须 +1，旧文件会被忽略而不是被误读。 */
const SCHEMA = 1

/**
 * 单个渠道快照的最大条目数。
 *
 * cline 实测 460 条、buddy 32 条，正常远低于这个上限；设上限只为防
 * 「上游异常返回上万条」把磁盘和解析时间拖垮。
 */
const MAX_ENTRIES = 2_000

/** 记日志用的 logger（由 {@link configureModelCatalogCache} 注入）。 */
let logger: { warn(message: string): void; info?(message: string): void } | undefined

/**
 * 注入的 ctx（由 {@link configureModelCatalogCache} 注入）。
 *
 * ⚠️ 必须用它解析 home：`resolveChannelPackHome` 的第二优先级是
 * `profileContext.home`、第三才是 `$DSH_HOME`，传 `undefined` 会跳过 profile home，
 * 让快照落到与 `state.json` 不同的目录（同类缺陷见 `dead-model-store.ts` 的长注释）。
 */
let injectedCtx: Context | undefined

/**
 * 已解析的快照目录；`undefined` = 尚未解析，`null` = 解析过了但定位不到 home。
 *
 * `null` 是**显式哨兵**：此时全部读写退化为内存（与 `MemoryDeadModelStore` 同策），
 * 而不是每次都把 home 解析重算一遍。
 */
let resolvedDir: string | null | undefined

/** 内存镜像：避免每次开设置页都读一次盘。 */
const memoryCache = new Map<string, unknown[]>()

/**
 * 注入 ctx（与 `configureDeadModelStore` 同款：日志与 home 解析都从 ctx 取）。
 *
 * 必须在任何 `registerXxxLlm` 之前调用一次。
 *
 * ⚠️ **不清 `memoryCache`**：本函数在 HMR / fiber 重启时会被再调一次
 * （`llm-register-compat.ts` 的模块头记录了那个重启竞态）。清掉内存镜像在
 * 「home 定位失败 / 目录不可写，目录只存在于内存」的降级路径下是真实的数据丢失。
 * `resolvedDir` 置空只是让它按新 ctx 重算一次路径，不影响已缓存的内容。
 */
export function configureModelCatalogCache(ctx: Context): void {
  injectedCtx = ctx
  logger = ctx.logger as { warn(message: string): void; info?(message: string): void } | undefined
  resolvedDir = undefined
}

/** 仅供单测：清空进程级状态（注入的 ctx 一并清掉）。 */
export function resetModelCatalogCacheForTest(): void {
  injectedCtx = undefined
  logger = undefined
  resolvedDir = undefined
  memoryCache.clear()
}

/** 解析快照目录；定位不到 home 时返回 `null`（退化为内存）。 */
function catalogDir(): string | null {
  if (resolvedDir !== undefined) return resolvedDir
  const home = resolveChannelPackHome(injectedCtx ?? ({} as Context))
  resolvedDir = home === undefined ? null : join(home, 'channel-pack', MODEL_CATALOG_DIR)
  if (resolvedDir === null) {
    logger?.warn('[channel-pack] 无法定位 DSH home，模型目录快照仅存在于内存中')
  }
  return resolvedDir
}

/** provider 名会成为文件名，做一层保守过滤，避免路径穿越。 */
function fileNameFor(provider: string): string | undefined {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(provider) ? `${provider}.json` : undefined
}

/**
 * 通用校验：只接受「非空数组，且每一项都是带非空字符串 id 的对象」。
 *
 * 不校验各家的其余字段是**刻意**的：那属于适配器自己的契约，且它们读字段时
 * 全部逐字段做 `typeof` 防御。这里挡掉的是「文件被写坏 / 手改成乱七八糟结构」
 * 这类会让适配器直接在 `.id` 上炸掉的情况。
 */
function sanitizeModels(raw: unknown): unknown[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const out: unknown[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const id = (item as Record<string, unknown>).id
    if (typeof id !== 'string' || id.length === 0) continue
    // 上游偶尔会重复下发同一个 id（accio 实测 79 条 / 77 个唯一 code）：
    // 快照里必须是去重后的，否则恢复出来的列表会出现同名条目两次。
    if (seen.has(id)) continue
    seen.add(id)
    out.push(item)
    if (out.length >= MAX_ENTRIES) break
  }
  return out.length === 0 ? undefined : out
}

/**
 * 读取某渠道上一次成功拉取的完整目录。
 *
 * @returns `undefined` 表示「没有可用快照」（从未成功过 / 文件损坏 / 版本不符）。
 *   调用方此时应回退编译期兜底表。
 */
export function readModelCatalog<T = unknown>(provider: string): T[] | undefined {
  const cached = memoryCache.get(provider)
  if (cached !== undefined) return cached as T[]
  const file = fileNameFor(provider)
  const dir = catalogDir()
  if (file === undefined || dir === null) return undefined
  const path = join(dir, file)
  try {
    if (!existsSync(path)) return undefined
    const body = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    if (typeof body !== 'object' || body === null) return undefined
    const record = body as Record<string, unknown>
    // 版本或归属不符：当作没有快照。宁可回退兜底表，也不要误读别人的目录。
    if (record.schema !== SCHEMA || record.provider !== provider) return undefined
    const models = sanitizeModels(record.models)
    if (models === undefined) return undefined
    memoryCache.set(provider, models)
    // 磁盘快照被读起来时，它就是「上一份目录」——后续 writeModelCatalog 的新增
    // 判据以它为基准。没有这行，进程重启后第一次远端拉取会把**全部**模型当成
    // 新增（previousIds 为空集 ⇒ 全部不在基准里），触发整表关闭。
    if (!previousIds.has(provider)) {
      previousIds.set(provider, new Set(models.map((item) => (item as { id?: unknown }).id as string)))
    }
    return models as T[]
  } catch (error) {
    // 损坏按**无快照**处理：回退兜底表最多是「旧」，而拿半个解析结果去渲染
    // 可能直接崩设置页。
    logger?.warn(`[channel-pack] 读取模型目录快照 ${path} 失败，按无快照处理: ${String(error)}`)
    return undefined
  }
}

/**
 * **快照写入前的旧目录**（per-provider）。
 *
 * `writeModelCatalog` 是整份覆盖，覆盖后「上次有哪些模型」这个信息就没了。
 * 而「新增模型默认关闭」（用户 2026-10-30 规则）需要知道**这次新增了哪些 id**
 * —— 判据只能是「上一份目录里有没有」，所以必须在覆盖前把旧 id 集合存下来。
 *
 * 键 = provider；值 = 那一刻快照里的 id 集合。适配器启动时经
 * {@link rememberCatalogIds} 预填（从磁盘快照恢复的目录也算「上一份」）。
 */
const previousIds = new Map<string, ReadonlySet<string>>()

/**
 * 记住一份目录的 id 集合，作为下一次 {@link writeModelCatalog} 的「旧目录」基准。
 *
 * 两个调用时机：
 * 1. 适配器启动时用磁盘快照（或兜底表）预填 —— 否则进程重启后第一次拉远端，
 *    所有模型都会被当成「新增」全部关掉，那不是用户要的；
 * 2. `writeModelCatalog` 覆盖成功后自填 —— 一次进程内连续两次刷新，
 *    第二次的新增判据是第一次的结果，而不是启动时的老快照。
 */
export function rememberCatalogIds(provider: string, models: readonly unknown[]): void {
  const ids = new Set<string>()
  for (const item of models) {
    const id = (item as { id?: unknown } | null)?.id
    if (typeof id === 'string' && id.length > 0) ids.add(id)
  }
  previousIds.set(provider, ids)
}

/**
 * 找出 `models` 里**上一份目录没有的** id（新增模型）。
 *
 * 没有旧基准（`rememberCatalogIds` 从未调过、且磁盘无快照）时返回空集：
 * 首次拉到目录的全部条目都算「原有的」—— 冷启动就该是全量可见，
 * 把整张表判成「新增」会让新用户面对一个全关的渠道。
 */
export function newModelIdsSinceLastCatalog(
  provider: string,
  models: readonly unknown[],
): string[] {
  const previous = previousIds.get(provider)
  if (previous === undefined) return []
  const fresh: string[] = []
  for (const item of models) {
    const id = (item as { id?: unknown } | null)?.id
    if (typeof id === 'string' && id.length > 0 && !previous.has(id)) fresh.push(id)
  }
  return fresh
}

/**
 * 把一次**成功的**远端目录整份写入快照（覆盖旧文件，绝不合并）。
 *
 * 失败只 warn 不抛：目录已经在内存里生效，落盘只是「下次启动更快更准」的增强，
 * 不能因为它导致整轮模型列表拿不到（磁盘满 / 只读挂载都可能）。
 */
export function writeModelCatalog(provider: string, models: readonly unknown[]): void {
  const sanitized = sanitizeModels(models)
  if (sanitized === undefined) return
  memoryCache.set(provider, sanitized)
  const file = fileNameFor(provider)
  const dir = catalogDir()
  if (file === undefined || dir === null) return
  try {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, file)
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify({
      schema: SCHEMA,
      provider,
      savedAt: Date.now(),
      models: sanitized,
    }), 'utf-8')
    renameSync(tmp, path)
    // 覆盖成功后把这份 id 集合记为「旧目录」：同进程内连续两次刷新，
    // 第二次的新增判据必须是第一次的结果（而不是启动时的老快照）。
    previousIds.set(provider, new Set(sanitized.map((item) => (item as { id?: unknown }).id as string)))
  } catch (error) {
    logger?.warn(`[channel-pack] 写入模型目录快照失败（${provider}）: ${String(error)}`)
  }
}

/**
 * 「写快照 + 新增模型默认关闭」的一体化入口（用户 2026-10-30 规则）。
 *
 * ## 规则
 *
 * 远端目录**整份覆盖**（既有规则，见 `writeModelCatalog`）不变；在此基础上，
 * 本次目录里**上一份没有的** id（新增模型）自动写入黑名单 —— 上游悄悄上架的
 * 新模型不该默认进入用户的模型选择器与计费路径，要用户在 Channel Pack
 * 手动打开才可见。
 *
 * ## 为什么放这里，而不是每个适配器自己写
 *
 * 写快照的点有 15 处、分布在 14 个适配器 + CodeArts 的 service —— 逐处手写
 * 「对照旧 id → 求新增 → 批量关」必然漏（先例：`restoreFromDisk` 漏倍率）。
 * 收口在写快照的必经之路，新增调用点天然继承本规则。
 *
 * ## 失败策略
 *
 * 关闭失败**不回滚**快照：目录已经是远端的新事实，把它回滚成旧表会让
 * 「上游下架的模型」永久残留（与既有「全量覆盖」规则冲突）。关闭失败只
 * warn，用户下次在面板手动关即可。
 *
 * @param pool 有 `setModelsDisabled` / `listDisabledModels` 的账号池；
 *   `undefined`（无池的替身 / 单测）时只写快照、不关新模型 —— 与
 *   `providerCatalogVisible` 接受可选池的既有口径一致。
 */
export async function writeModelCatalogClosingNew(
  provider: string,
  models: readonly unknown[],
  pool: {
    listDisabledModels(p: string): Record<string, boolean>
    setModelsDisabled(p: string, ids: readonly string[]): Promise<void>
  } | undefined,
): Promise<void> {
  // ① 先取「上一份目录」的 id 基准，再覆盖（覆盖会刷新基准）。
  const known = previousIds.get(provider)
    ?? readModelCatalogSafe(provider)
  rememberCatalogIds(provider, models)
  // ② 写快照（整份覆盖，既有语义）。
  writeModelCatalog(provider, models)
  if (pool === undefined || known === undefined) return
  // ③ 新增 = 本次有、上一份没有。没有基准（首次拉到）时不关任何东西。
  const fresh = newModelIdsSinceLastCatalogKnown(provider, models, known)
  if (fresh.length === 0) return
  // ④ 只关「用户从未设置过」的：黑名单里已有记录的 id（无论开或关）是用户的
  //    显式决定，不因目录刷新而翻转 —— 否则「关了又拉 → 又被关回去」。
  const recorded = pool.listDisabledModels(provider)
  const toClose = fresh.filter((id) => recorded[id] !== true && recorded[id] !== false)
  if (toClose.length === 0) return
  try {
    await pool.setModelsDisabled(provider, toClose)
    logger?.info?.(
      `[channel-pack] ${provider}：新增 ${toClose.length} 个模型已默认关闭（${toClose.join(', ')}），需在渠道面板手动打开`,
    )
  } catch (error) {
    logger?.warn(
      `[channel-pack] ${provider}：新增模型自动关闭失败（不影响目录更新）: ${String(error)}`,
    )
  }
}

/** readModelCatalog 的吞错包装（仅用于取旧基准；本模块已有内存镜像，通常命中）。 */
function readModelCatalogSafe(provider: string): ReadonlySet<string> | undefined {
  const models = readModelCatalog(provider)
  if (models === undefined) return undefined
  return new Set(models.map((item) => (item as { id?: unknown }).id as string).filter(
    (id) => typeof id === 'string' && id.length > 0,
  ))
}

/** 用显式传入的旧基准判新增（previousIds 已被 rememberCatalogIds 覆盖，故不能再用它）。 */
function newModelIdsSinceLastCatalogKnown(
  provider: string,
  models: readonly unknown[],
  known: ReadonlySet<string>,
): string[] {
  void provider
  const fresh: string[] = []
  for (const item of models) {
    const id = (item as { id?: unknown } | null)?.id
    if (typeof id === 'string' && id.length > 0 && !known.has(id)) fresh.push(id)
  }
  return fresh
}

/**
 * 「远端没拉到就恢复快照」的一行式入口（12 个适配器共用）。
 *
 * 语义刻意是**不覆盖**：`current` 有值（远端刚成功）就原样返回，只有它为空时
 * 才去读快照。这样调用点不需要判断自己处在哪条路径上，也能安全地在
 * `throw` / 早退之后统一调用。
 *
 * @param current 适配器当前内存里的目录（通常是 `this.remoteModels`）。
 * @returns 可用的目录，或 `undefined`（此时调用方回退编译期兜底表）。
 */
export function restoreModelCatalog<T>(
  provider: string,
  current: readonly T[] | undefined,
): T[] | undefined {
  if (current !== undefined && current.length > 0) {
    // 内存里已有目录（远端刚拉到 / 适配器自填）：把它记为「上一份」基准。
    // 没有这行，同进程内「先 warmCatalog 拉到 → 再 refreshCatalog」时第二次
    // 的新增判据仍是启动前的老快照，第一次的新模型会被重复关闭（幂等无害，
    // 但用户手动打开后又被翻回去就成缺陷了 —— recorded 过滤挡不住第一次的基准漂移）。
    if (!previousIds.has(provider)) rememberCatalogIds(provider, current)
    return current as T[]
  }
  const restored = readModelCatalog<T>(provider)
  // 磁盘快照恢复成功 = 这就是「上一份」（readModelCatalog 内部也会记，双保险
  // 是为了显式表达这条路径的语义；Set 记录是幂等的）。
  if (restored !== undefined && !previousIds.has(provider)) {
    rememberCatalogIds(provider, restored)
  }
  return restored
}

/**
 * 快照的写入时间；没有快照时 `undefined`。
 *
 * 目前只有诊断用得到（设置页不展示时间），保留它是为了让「这条到底是远端
 * 新拉的还是上次的快照」在排障时**可判定**，而不是只能靠猜。
 */
export function modelCatalogSavedAt(provider: string): number | undefined {
  const file = fileNameFor(provider)
  const dir = catalogDir()
  if (file === undefined || dir === null) return undefined
  try {
    const body = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as Record<string, unknown>
    return typeof body?.savedAt === 'number' ? body.savedAt : undefined
  } catch {
    return undefined
  }
}
