/**
 * 模型目录的**定时刷新调度**（独立于凭据续期：两者失败语义不同）。
 *
 * ## 为什么独立于 `refreshAllCredentials`
 *
 * `index.ts` 已有的 30 分钟凭据续期轮询关心的是「令牌别过期」——失败一次就可能
 * 让账号不可用，要按 lead-time 精细分档。目录刷新关心的是「模型/倍率别过期」，
 * 频率天然低一个数量级，失败也只是「继续显示上一次的目录」，不需要退避重试到
 * 秒级。混进同一个循环会让两边都变得难以推理（且凭据轮询的 30 分钟节奏去拉
 * 20 个渠道的目录 = 纯白打上游）。
 *
 * ## 调度策略与理由
 *
 * - **默认间隔 6 小时**（`DEFAULT_MODEL_CATALOG_REFRESH_INTERVAL_MS`，
 *   可用环境变量 `DSH_MODEL_CATALOG_REFRESH_MS` 覆盖）：
 *   模型上下架与倍率调整**不是秒级事件**（上游按天/周变动），30 分钟太密
 *   （20 个渠道 × 48 次/天，会把免费渠道的配额和出口 IP 都打热），
 *   24 小时又太钝（用户装了新版本、上游当天调整倍率，要等到明天才看到）；
 *   6 小时 = 一天至多 4 次全量对账，是「跟得上」与「不打扰上游」的折中。
 *- **启动后延迟 90 秒跑首轮**（`MODEL_CATALOG_FIRST_ROUND_DELAY_MS`）：
 *   首屏渲染、账号池加载、凭据探测都在启动头几秒，目录刷新是**低优先级后台
 *   工作**，不该和它们抢网络/CPU（更不该让首屏等它）；90 秒足够让首屏稳定，
 *   又能让「刚启动就发现目录过期」在用户察觉前自愈。
 *- **失败提前重试**（`MODEL_CATALOG_RETRY_MS`，默认 10 分钟）：
 *   一轮里只要有渠道失败（瞬时网络/凭据抖动），就不该干等 6 小时下一轮 ——
 *   照搬 `refresh.ts` 的失败重试口径。下一轮成功后自动回到 6 小时节奏。
 *   失败渠道的**旧目录原样保留**（由解析助手保证），界面不会因此少模型。
 *
 * ## 硬约束
 *
 * - **串行**：一轮内逐渠道顺序执行（同一时刻只有一个上游请求），轮与轮之间也
 *   串行（链式队列）—— 定时器抖动/手动刷新都不会叠出并发。
 * - **逐渠道 try/catch**：一个渠道抛错/超时不影响其余渠道（报告里分别记
 *   ok/failed）。
 * - `stop()` 清掉全部定时器（含失败重试与在途轮次的再武装），并可安全重复调用。
 *
 * ## 渠道成员怎么接（每个渠道一行）
 *
 * ```ts
 * registerCatalogRefresh({
 *   provider: XXX.id,
 *   label: 'xxx',                       // 日志用；缺省 = provider
 *   fetch: () => fetchXxxCatalog(...),  // 与 resolveCatalog 的 fetchRemote 同一个
 * })
 * ```
 *
 * `fetch` 的契约与 `model-catalog-resolver.ts` 的 `fetchRemote` 完全一致
 * （成功返回完整目录、失败抛错或返回空数组）；本调度器负责「拉到就覆盖缓存」，
 * 渠道侧不再写任何 TTL/刷新逻辑。
 */

import { refreshCatalog } from './model-catalog-resolver.js'
import type { CatalogModel } from './model-catalog-store.js'

/** 默认刷新间隔：6 小时（理由见文件头）。 */
export const DEFAULT_MODEL_CATALOG_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000

/** 启动后首轮延迟：90 秒（理由见文件头）。 */
export const MODEL_CATALOG_FIRST_ROUND_DELAY_MS = 90_000

/** 一轮有失败时的提前重试间隔：10 分钟（对齐 `refresh.ts` 的失败重试口径）。 */
export const MODEL_CATALOG_RETRY_MS = 10 * 60 * 1000

/** 间隔下限：防止环境变量写成 `1000` 把 20 个渠道的上游锤爆。 */
const MIN_INTERVAL_MS = 60_000

/** 环境变量：覆盖刷新间隔（毫秒）。 */
export const MODEL_CATALOG_REFRESH_ENV = 'DSH_MODEL_CATALOG_REFRESH_MS'

/** 一个已注册的渠道刷新任务。 */
export interface CatalogRefreshTask {
  /** provider id（`product.id`）。 */
  provider: string
  /** 日志里的短名；缺省用 provider。 */
  label?: string
  /**
   * 拉取并解析**完整**目录（覆盖语义）。失败应抛错或返回空数组 —— 两者都算
   * 「这次没拿到」，缓存保留上一次成功结果。
   */
  fetch: () => Promise<readonly CatalogModel[]>
}

/** 一轮刷新的结果（供日志与单测断言）。 */
export interface CatalogRefreshReport {
  /** 成功覆盖缓存的 provider（按执行顺序）。 */
  ok: string[]
  /** 失败的 provider + 原因（一个渠道失败不影响其余）。 */
  failed: Array<{ provider: string; message: string }>
}

/** 日志接口（与 ctx.logger 兼容；全部可选，缺省静默）。 */
export interface CatalogRefreshLogger {
  info?(message: string): void
  warn?(message: string): void
}

/**
 * 模块级任务注册表：provider → 任务。
 *
 * ⚠️ 用 Map 而不是数组：同一渠道重复注册（HMR / apply 重入）时**后写覆盖**，
 * 不会每轮把同一个渠道刷两遍。`registerCatalogRefresh` 返回的注销函数按
 * 「仍是自己那一个」判断，避免旧实例把新实例的任务顺手删掉。
 */
const tasks = new Map<string, CatalogRefreshTask>()

/**
 * 注册一个渠道的目录刷新任务（应在适配器接线时调用一次）。
 *
 * @returns 注销函数（幂等；HMR / fiber 卸载时调用）。
 */
export function registerCatalogRefresh(task: CatalogRefreshTask): () => void {
  if (typeof task.provider !== 'string' || task.provider.length === 0) return () => {}
  if (typeof task.fetch !== 'function') return () => {}
  tasks.set(task.provider, task)
  return () => {
    if (tasks.get(task.provider) === task) tasks.delete(task.provider)
  }
}

/** 当前已注册的任务（诊断/单测用；顺序 = 注册顺序）。 */
export function catalogRefreshTasks(): readonly CatalogRefreshTask[] {
  return [...tasks.values()]
}

/** 清空注册表（**仅单测**；生产代码不应调用 —— 那会让定时刷新静默失效）。 */
export function clearCatalogRefreshTasksForTest(): void {
  tasks.clear()
}

/**
 * 读环境变量覆盖的刷新间隔。
 *
 * 非法（非数字 / ≤0）→ 默认 6 小时；过小 → 抬到 60 秒下限并 warn（"锤爆上游"
 * 是配置错误里代价最高的那类，宁可静默纠正也不能照单执行）。
 */
export function modelCatalogRefreshIntervalMs(
  logger?: Pick<CatalogRefreshLogger, 'warn'>,
): number {
  const raw = process.env[MODEL_CATALOG_REFRESH_ENV]
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_MODEL_CATALOG_REFRESH_INTERVAL_MS
  const value = Number(raw.trim())
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MODEL_CATALOG_REFRESH_INTERVAL_MS
  if (value < MIN_INTERVAL_MS) {
    logger?.warn?.(
      `[channel-pack] ${MODEL_CATALOG_REFRESH_ENV}=${raw} 过小，已抬到 ${MIN_INTERVAL_MS}ms`
      + `（目录刷新默认 ${DEFAULT_MODEL_CATALOG_REFRESH_INTERVAL_MS}ms）`,
    )
    return MIN_INTERVAL_MS
  }
  return Math.floor(value)
}

/**
 * 跑**一轮**目录刷新：串行、逐渠道 try/catch。
 *
 * 这是调度器与手动刷新共用的执行体；任务快照在轮次开始时取，轮内新注册的渠道
 * 留到下一轮（避免「迭代中改集合」的不确定行为）。
 *
 * @param logger - 日志（缺省静默）。
 * @returns 逐渠道结果；**本函数永不抛错**。
 */
export async function refreshRegisteredCatalogs(
  logger?: CatalogRefreshLogger,
): Promise<CatalogRefreshReport> {
  const report: CatalogRefreshReport = { ok: [], failed: [] }
  const snapshot = [...tasks.values()]
  if (snapshot.length === 0) return report
  for (const task of snapshot) {
    const label = task.label ?? task.provider
    try {
      // refreshCatalog：拉成功才覆盖内存 + 落盘；失败/空返回 false 且缓存原样保留。
      const refreshed = await refreshCatalog(task.provider, task.fetch)
      if (refreshed) {
        report.ok.push(task.provider)
      } else {
        report.failed.push({ provider: task.provider, message: '未拿到目录（空结果或拉取失败）' })
        logger?.warn?.(`[channel-pack] ${label} 的模型目录刷新未拿到结果，继续使用上一次的目录`)
      }
    } catch (error) {
      // 兜底：refreshCatalog 自己已 catch，这里只防未来改动把它变成会抛的实现。
      const message = error instanceof Error ? error.message : String(error)
      report.failed.push({ provider: task.provider, message })
      logger?.warn?.(`[channel-pack] ${label} 的模型目录刷新异常：${message}`)
    }
  }
  if (report.ok.length > 0) {
    logger?.info?.(
      `[channel-pack] 模型目录已刷新 ${report.ok.length} 个渠道`
      + `（失败 ${report.failed.length} 个${report.failed.length > 0 ? `：${report.failed.map((item) => item.provider).join(', ')}` : ''}）`,
    )
  }
  return report
}

/** 调度器构造选项（全部可注入，便于单测用毫秒级时序）。 */
export interface ModelCatalogRefreshSchedulerOptions {
  /** 刷新间隔；缺省读环境变量，再缺省 6 小时。 */
  intervalMs?: number
  /** 首轮延迟；缺省 90 秒。 */
  firstRoundDelayMs?: number
  /** 一轮有失败后的提前重试间隔；缺省 10 分钟。 */
  retryMs?: number
  /** 日志（`ctx.logger` 直接传）。 */
  logger?: CatalogRefreshLogger
  /** 执行体注入（单测用；缺省 {@link refreshRegisteredCatalogs}）。 */
  runTasks?: (logger?: CatalogRefreshLogger) => Promise<CatalogRefreshReport>
  /** 定时器注入（单测用；缺省全局 setTimeout/clearTimeout）。 */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

/**
 * 目录刷新调度器：启动延迟首轮 → 按间隔轮询；有失败则提前重试。
 *
 * ⚠️ 形态照搬 `refresh.ts` 的 `RefreshScheduler`：
 * - **单个定时器**（每轮结束后按结果再武装下一次），天然不会重叠；
 * - **generation 代号**：`stop()`/`start()` 推进它，让在途轮次结束后**放弃**
 *   再武装 —— 否则插件卸载后定时器会借在途轮次「复活」；
 * - 定时器一律 `unref()`：后台刷新不该阻止进程退出。
 */
export class ModelCatalogRefreshScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined
  private generation = 0
  private started = false
  /** 轮次串行队列：定时触发与手动 `runNow()` 共用，保证永不并发。 */
  private chain: Promise<CatalogRefreshReport> = Promise.resolve({ ok: [], failed: [] })
  private readonly intervalMs: number
  private readonly firstRoundDelayMs: number
  private readonly retryMs: number
  private readonly logger: CatalogRefreshLogger | undefined
  private readonly runTasks: (logger?: CatalogRefreshLogger) => Promise<CatalogRefreshReport>
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void

  constructor(options: ModelCatalogRefreshSchedulerOptions = {}) {
    this.intervalMs = options.intervalMs ?? modelCatalogRefreshIntervalMs(options.logger)
    this.firstRoundDelayMs = options.firstRoundDelayMs ?? MODEL_CATALOG_FIRST_ROUND_DELAY_MS
    this.retryMs = options.retryMs ?? MODEL_CATALOG_RETRY_MS
    this.logger = options.logger
    this.runTasks = options.runTasks ?? refreshRegisteredCatalogs
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
  }

  /** 启动（幂等：重复调用不会叠出第二个定时器）。 */
  start(): void {
    if (this.started) return
    this.started = true
    this.generation++
    this.arm(this.firstRoundDelayMs)
  }

  /**
   * 停止：清定时器 + 推进代号（在途轮次结束后不再武装）。
   *
   * 可安全重复调用；stop 后可以再次 `start()`（重新从首轮延迟开始）。
   */
  stop(): void {
    this.started = false
    this.generation++
    if (this.timer !== undefined) {
      this.clearTimer(this.timer)
      this.timer = undefined
    }
  }

  /**
   * 立即跑一轮（手动刷新入口 / 单测断言用）。
   *
   * 与定时轮共享串行队列：若正有一轮在跑，本次排队等待，绝不并发。
   * 不改变定时器节奏（不重置间隔）。
   */
  runNow(): Promise<CatalogRefreshReport> {
    return this.enqueue()
  }

  /** 武装下一次定时触发（覆盖旧定时器）。 */
  private arm(delayMs: number): void {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer)
      this.timer = undefined
    }
    const generation = this.generation
    const timer = this.setTimer(() => {
      if (generation !== this.generation) return
      // 清掉已触发的句柄：之后 stop() 不会重复 clear 一个已执行的 timer。
      if (this.timer === timer) this.timer = undefined
      void this.tick(generation)
    }, delayMs)
    // ⚠️ 后台刷新不得阻止进程退出（DSH 可能随时关闭；未落盘的结果下次启动重拉）。
    timer.unref?.()
    this.timer = timer
  }

  /** 一轮定时触发的完整生命周期：执行 → 按结果武装下一次。 */
  private async tick(generation: number): Promise<void> {
    const report = await this.enqueue()
    // 在途期间被 stop()/start() 打断 ⇒ 放弃再武装（否则卸载后调度器「复活」）。
    if (generation !== this.generation || !this.started) return
    this.arm(report.failed.length > 0 ? this.retryMs : this.intervalMs)
  }

  /** 把一轮执行追加到串行队列。 */
  private enqueue(): Promise<CatalogRefreshReport> {
    const next = this.chain.then(() => this.runTasks(this.logger))
    // 队列自身吞掉异常，保证后续轮次仍能排队（runTasks 契约是不抛，这里只兜底）。
    // ⚠️ 整轮崩溃也要按「失败」计，让 tick 走 10 分钟提前重试，而不是干等 6 小时。
    this.chain = next.catch((error: unknown): CatalogRefreshReport => {
      const message = error instanceof Error ? error.message : String(error)
      this.logger?.warn?.(`[channel-pack] 模型目录刷新轮次异常：${message}`)
      return { ok: [], failed: [{ provider: '(round)', message }] }
    })
    return this.chain
  }
}
