/**
 * 模型目录的**落盘缓存**：让「上次成功拉到的完整目录」在进程重启后仍然可用。
 *
 * ## 为什么需要它（2026-10-26 用户明确要求）
 *
 * 用户原话：「模型列表和倍率全部远端获取，并定时刷新（重新获取），获取到了后，
 * 直接覆盖本地（连兜底表也覆盖掉）……兜底表的作用只是告诉新使用这个插件的
 * 用户这个渠道有哪些模型。」
 *
 * 这句话把三层数据源的职责定死了：
 *
 * | 层 | 用途 | 何时用 |
 * |---|---|---|
 * | 远端目录 | **唯一权威**（模型 + 倍率） | 每次刷新、TTL 到期 |
 * | **落盘缓存（本模块）** | 上次成功拉取的快照 | 进程重启后 / 拉取失败 / **凭据失效或被删除** |
 * | 兜底表（`*-product.ts`） | 冷启动样本 | 从未成功拉到过（新装用户） |
 *
 * 没有本模块时，进程一重启 `remoteModels` 就没了，只能回落到**已经过期的
 * 兜底表** —— 用户会看到旧模型与旧倍率（实测 qoder 有 4 个模型倍率不一致，
 * 最大差 2.5 倍，其中 `dfmodel` 实际免费却被标成 x0.1）。
 *
 * ## 为什么不并进 `state.json`
 *
 * 同 `dead-model-store.ts` / `permanent-lock-store.ts` 记录的那类风险：
 * `state.json` 是 dsh home 级、全局共享的，而本仓库写盘是**整体替换**语义 ——
 * 旧版本代码整体重写时会静默抹掉它不认识的字段。独立文档则无人争抢。
 *
 * ## 结构
 *
 * ```json
 * {
 *   "schema": 1,
 *   "providers": {
 *     "qoder": {
 *       "fetchedAt": 1792990000000,
 *       "models": [
 *         { "id": "auto", "name": "Auto", "priceFactor": 0.5, "contextWindow": 200000 }
 *       ]
 *     }
 *   }
 * }
 * ```
 *
 * `upstreamKey` 单独留着：有些渠道的「目录 id」与「请求时用的上游键」不同
 * （Qoder 就是 —— 目录 `key` 既当 id 又当上游键，但其它渠道未必）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveChannelPackHome } from './channel-pack-store.js'

/** 落盘 schema 版本（结构不兼容时递增）。 */
const SCHEMA = 1
/** 落盘文件名。 */
export const MODEL_CATALOG_FILE = 'model-catalog.json'

/**
 * 一个模型的**完整**能力描述。
 *
 * 字段全部可选（除 id/name）：不同渠道能提供的元信息差异很大，
 * **拿不到就留空**，不要编造默认值（用户明确要求「没有倍率的直接不显示倍率」）。
 */
export interface CatalogModel {
  /** 模型 id（DSH 侧的选择值）。 */
  id: string
  /** 展示名（**不含**倍率后缀，后缀在展示层拼）。 */
  name: string
  /**
   * 计费倍率。
   *
   * ⚠️ **`0` 是合法值**（免费），不能用 `> 0` 过滤。
   * ⚠️ **`undefined` 表示上游没给**，此时展示层**不显示倍率**。
   */
  priceFactor?: number
  /** 促销前原价（与 `priceFactor` 不同时才值得展示）。 */
  originalPriceFactor?: number
  /** 上下文窗口（token 数）。 */
  contextWindow?: number
  /** 是否接受图片输入。 */
  supportsImage?: boolean
  /** 是否支持思考档位。 */
  supportsThinking?: boolean
  /** 是否免费额度模型。 */
  isFree?: boolean
  /** 请求时用的上游键（与 id 不同时才有值）。 */
  upstreamKey?: string
}

/** 单个渠道的目录快照。 */
export interface CatalogSnapshot {
  /** 拉取成功的时间（毫秒）。 */
  fetchedAt: number
  /** 完整模型列表。 */
  models: readonly CatalogModel[]
}

/** 全量落盘结构。 */
export interface CatalogDocument {
  schema: number
  providers: Record<string, CatalogSnapshot>
}

/** 内存镜像（避免每次列模型都读盘）。 */
let cache: CatalogDocument | undefined
/** 注入的 ctx（用于解析 home）。 */
let injectedCtx: Context | undefined
/** 注入的 logger。 */
let logger: { warn(message: string): void } | undefined

/** 注入 ctx 与 logger（由 index.ts 在启动时调用）。 */
export function configureModelCatalogStore(options: {
  ctx?: Context
  logger?: { warn(message: string): void }
}): void {
  injectedCtx = options.ctx
  logger = options.logger
  cache = undefined
}

/** 落盘文件路径（home 解析失败时返回 undefined，此时退化为纯内存）。 */
function catalogPath(): string | undefined {
  try {
    const home = resolveChannelPackHome(injectedCtx as Context)
    return home === undefined ? undefined : join(home, 'channel-pack', MODEL_CATALOG_FILE)
  } catch {
    return undefined
  }
}

/** 把任意输入清洗成合法文档（损坏/脏数据一律降级，绝不抛错）。 */
function sanitize(raw: unknown): CatalogDocument {
  const empty: CatalogDocument = { schema: SCHEMA, providers: {} }
  if (raw === null || typeof raw !== 'object') return empty
  const providers = (raw as Record<string, unknown>).providers
  if (providers === null || typeof providers !== 'object') return empty
  const out: Record<string, CatalogSnapshot> = {}
  for (const [provider, snapshotRaw] of Object.entries(providers as Record<string, unknown>)) {
    if (provider === '' || snapshotRaw === null || typeof snapshotRaw !== 'object') continue
    const snapshot = snapshotRaw as Record<string, unknown>
    const fetchedAt = typeof snapshot.fetchedAt === 'number' ? snapshot.fetchedAt : 0
    const modelsRaw = snapshot.models
    if (!Array.isArray(modelsRaw)) continue
    const models: CatalogModel[] = []
    for (const modelRaw of modelsRaw) {
      if (modelRaw === null || typeof modelRaw !== 'object') continue
      const item = modelRaw as Record<string, unknown>
      const id = typeof item.id === 'string' ? item.id : ''
      const name = typeof item.name === 'string' ? item.name : ''
      if (id === '') continue
      models.push({
        id,
        name: name === '' ? id : name,
        // ⚠️ 0 是合法倍率：只在**不是数字**时丢弃，不能判真值。
        ...(typeof item.priceFactor === 'number' ? { priceFactor: item.priceFactor } : {}),
        ...(typeof item.originalPriceFactor === 'number' ? { originalPriceFactor: item.originalPriceFactor } : {}),
        ...(typeof item.contextWindow === 'number' ? { contextWindow: item.contextWindow } : {}),
        ...(item.supportsImage === true ? { supportsImage: true } : {}),
        ...(item.supportsThinking === true ? { supportsThinking: true } : {}),
        ...(item.isFree === true ? { isFree: true } : {}),
        ...(typeof item.upstreamKey === 'string' && item.upstreamKey !== '' ? { upstreamKey: item.upstreamKey } : {}),
      })
    }
    if (models.length === 0) continue
    out[provider] = { fetchedAt, models }
  }
  return { schema: SCHEMA, providers: out }
}

/** 读全量文档（带内存镜像；文件不存在/损坏按空表处理）。 */
export function loadCatalogDocument(): CatalogDocument {
  if (cache !== undefined) return cache
  const path = catalogPath()
  if (path === undefined) {
    cache = { schema: SCHEMA, providers: {} }
    return cache
  }
  try {
    if (!existsSync(path)) {
      cache = { schema: SCHEMA, providers: {} }
      return cache
    }
    cache = sanitize(JSON.parse(readFileSync(path, 'utf-8')) as unknown)
    return cache
  } catch (error) {
    // 损坏时按**空表**处理：宁可回落到兜底表，也不要因为一个渠道的脏数据
    // 让整个模型目录消失。
    logger?.warn(`[channel-pack] 读取 ${path} 失败，按空目录处理: ${String(error)}`)
    cache = { schema: SCHEMA, providers: {} }
    return cache
  }
}

/** 取某渠道的快照（没有则 undefined）。 */
export function loadCatalog(provider: string): CatalogSnapshot | undefined {
  return loadCatalogDocument().providers[provider]
}

/** 原子写回全量文档（tmp + rename）。失败只 warn，不影响调用方。 */
function persist(document: CatalogDocument): void {
  const path = catalogPath()
  if (path === undefined) return
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(document, null, 2), 'utf-8')
    renameSync(tmp, path)
  } catch (error) {
    logger?.warn(`[channel-pack] 写入 ${path} 失败: ${String(error)}`)
  }
}

/**
 * 保存某渠道的目录快照（**覆盖**该渠道的旧快照）。
 *
 * 这是「获取到了后直接覆盖本地」的落点：调用方拿到远端结果就写这里，
 * 不做任何与旧值的合并（用户明确要求覆盖语义）。
 */
export function saveCatalog(provider: string, models: readonly CatalogModel[], fetchedAt = Date.now()): void {
  if (provider === '' || models.length === 0) return
  const document = loadCatalogDocument()
  const next: CatalogDocument = {
    schema: SCHEMA,
    providers: { ...document.providers, [provider]: { fetchedAt, models } },
  }
  cache = next
  persist(next)
}

/** 清掉某渠道的快照（删除凭据/渠道下线时用）。 */
export function clearCatalog(provider: string): void {
  const document = loadCatalogDocument()
  if (document.providers[provider] === undefined) return
  const providers = { ...document.providers }
  delete providers[provider]
  const next: CatalogDocument = { schema: SCHEMA, providers }
  cache = next
  persist(next)
}

/** 仅供单测：清空内存镜像并允许注入路径。 */
export function resetModelCatalogStoreForTest(): void {
  cache = undefined
}
