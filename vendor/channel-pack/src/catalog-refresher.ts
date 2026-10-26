/**
 * 模型目录的**定时刷新**调度。
 *
 * ## 为什么要独立于凭据续期
 *
 * `index.ts` 已有一个 30 分钟的 `refreshAllCredentials`（续期令牌）。目录刷新
 * 与它**失败语义完全不同**：
 *
 * - 续期失败 → 凭据可能已失效，必须让用户知道；
 * - 目录刷新失败 → **无害**（保留上次结果即可，界面照常可用）。
 *
 * 混在一起的后果是：目录接口抖一下，日志里会出现一堆「凭据续期失败」的
 * 误导性告警，反过来也可能让续期的严重告警被目录噪声淹没。
 *
 * ## 节奏
 *
 * - 启动后**延迟**一小段再跑首轮：不与首屏抢资源（首屏要建模型目录）；
 * - 之后按 `intervalMs` 重跑（默认 6 小时）。
 *
 * 为什么是 6 小时：上游改目录不是秒级事件（实测 Qoder / AutoClaw 的目录
 * 变动以天为单位），但也不能等到进程重启 —— 用户会长期开着 DSH。
 * 6 小时既能在一个工作日内跟上变动，又把请求量压到每渠道每天 4 次。
 * 可用 `DSH_CHANNEL_PACK_CATALOG_REFRESH_MS` 覆盖（`0` 表示关闭定时刷新）。
 *
 * ## 串行与容错
 *
 * **逐渠道串行 + 每个渠道独立 try/catch**：一个渠道失败不能中断其他渠道
 * （反风控口径，与 `collectCreditBalances` 的顺序查询一致）。
 */

/** 首轮延迟：给首屏让路。 */
export const CATALOG_FIRST_DELAY_MS = 45_000
/** 默认刷新间隔（6 小时）。 */
export const CATALOG_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000

/** 一次刷新任务：拉某个渠道的目录（失败应自行吞掉并返回 false）。 */
export interface CatalogRefreshTarget {
  /** 渠道 id（日志用）。 */
  provider: string
  /** 执行刷新；返回 `true` 表示这次真的拿到了新目录。 */
  refresh: () => Promise<boolean>
}

/** 调度器句柄。 */
export interface CatalogRefresher {
  /** 手动跑一轮（串行，逐渠道容错）。返回成功渠道数。 */
  runOnce: () => Promise<number>
  /** 停止定时器。 */
  stop: () => void
}

/** 解析刷新间隔（环境变量可覆盖；`0` 表示关闭）。 */
function resolveIntervalMs(): number {
  const raw = process.env.DSH_CHANNEL_PACK_CATALOG_REFRESH_MS
  if (raw === undefined || raw.trim() === '') return CATALOG_REFRESH_INTERVAL_MS
  const parsed = Number(raw.trim())
  if (!Number.isFinite(parsed) || parsed < 0) return CATALOG_REFRESH_INTERVAL_MS
  return parsed
}

/**
 * 启动目录刷新调度。
 *
 * @param targets 要刷新的渠道（调用方按当前已登录渠道构造）
 * @param options 可注入 logger / 间隔 / 首轮延迟（单测用）
 */
export function startCatalogRefresher(
  targets: () => readonly CatalogRefreshTarget[],
  options: {
    logger?: { warn(message: string): void; info?(message: string): void }
    intervalMs?: number
    firstDelayMs?: number
  } = {},
): CatalogRefresher {
  const intervalMs = options.intervalMs ?? resolveIntervalMs()
  const firstDelayMs = options.firstDelayMs ?? CATALOG_FIRST_DELAY_MS

  const runOnce = async (): Promise<number> => {
    let succeeded = 0
    // ⚠️ 串行：并发打上游容易被反风控，也与其余渠道的查询口径一致。
    for (const target of targets()) {
      try {
        if (await target.refresh()) succeeded += 1
      } catch (error) {
        // 单个渠道失败不影响其他渠道；目录刷新失败本身无害。
        options.logger?.warn(`[channel-pack] 刷新 ${target.provider} 模型目录失败: ${String(error)}`)
      }
    }
    if (succeeded > 0) {
      options.logger?.info?.(`[channel-pack] 模型目录已刷新（${succeeded} 个渠道）`)
    }
    return succeeded
  }

  let timer: ReturnType<typeof setInterval> | undefined
  const firstTimer = firstDelayMs > 0
    ? setTimeout(() => {
      void runOnce()
      if (intervalMs > 0) timer = setInterval(() => void runOnce(), intervalMs)
    }, firstDelayMs)
    : undefined
  // firstDelayMs 为 0 时（单测）立即武装间隔定时器。
  if (firstDelayMs <= 0 && intervalMs > 0) {
    timer = setInterval(() => void runOnce(), intervalMs)
  }

  return {
    runOnce,
    stop: () => {
      if (firstTimer !== undefined) clearTimeout(firstTimer)
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
  }
}
