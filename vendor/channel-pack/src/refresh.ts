/** 在凭据过期前提前这么长时间触发刷新（1 小时；对齐真实插件的 36e5）。 */
export const REFRESH_LEAD_MS = 3_600_000
/** 普通刷新失败后的重试间隔（10 分钟；对齐 RENEW_TOKEN_INTERVAL_WHEN_LAST_TIME_FAILED）。 */
export const REFRESH_RETRY_MS = 600_000
/** 异常网络（fetch failed 等）后的重试间隔（1 分钟；对齐 …_BY_ABNORMAL_NETWORK）。 */
export const REFRESH_ABNORMAL_NETWORK_RETRY_MS = 60_000

/**
 * **提前续期**（ahead）的触发窗口：access token 只剩这么长就该主动续期。
 *
 * 10 天，对齐 magpie（workbuddy 插件）的 `AHEAD_MS`。
 *
 * ## 为什么 1 小时 lead 对「28 天 / 30 天」这对参数太晚
 *
 * WorkBuddy 的 access_token 活 **28 天**、refresh_token 只活 **30 天**
 * （magpie `:318-321` 的 `lifeOf`/`ahead` 注释）。按 {@link REFRESH_LEAD_MS}
 * （1 小时）续期，续期点落在第 27 天 23 时：只要那 2 天的窗口里 DSH 没在跑
 * （关机 / 休眠 / 定时器根本没被武装），refresh_token 就先一步死掉 ——
 * 等不到续期的那一刻，整个账号**直接报废**，只能重新登录。
 *
 * 提前到「剩 10 天」续，寿命就越续越长：任何一次落在第 18–28 天之间的运行
 * 都会把 access 推回 28 天、refresh 推回 30 天，把「必须开机」的窗口从 2 天
 * 拉宽到 10 天 —— 而 2 天的窗口本来连一次出差都撑不过去。
 */
export const REFRESH_AHEAD_MS = 10 * 86_400_000
/**
 * 「长寿命凭据」的判据：签发寿命 ≥ 2× {@link REFRESH_AHEAD_MS}（20 天）。
 *
 * 对齐 magpie 的 `LONG_MS`：**只有**长寿命令牌走提前续期，短寿命的（如
 * CodeArts 2 小时 / Cline 1 小时）继续用 1 小时 lead —— 否则提前续期会在
 * 寿命的一半处就触发，续完立刻又进窗口，变成「无限续期」。
 */
export const REFRESH_AHEAD_MIN_LIFE_MS = 2 * REFRESH_AHEAD_MS
/** 提前续期失败后的首次重试间隔（1 分钟，连续失败翻倍；对齐 `AHEAD_RETRY_MS`）。 */
export const REFRESH_AHEAD_RETRY_MS = 60_000
/** 提前续期失败的退避上限（30 分钟；对齐 `AHEAD_RETRY_MOST`）。 */
export const REFRESH_AHEAD_RETRY_MAX_MS = 30 * 60_000

/** 判定是否为「异常网络」类错误（对齐真实插件的 isAbnormalNetwork）。 */
function isAbnormalNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /fetch failed|ENOTFOUND|ECONNREFUSED|proxy|unresolved host|getaddrinfo/i.test(message)
}

/**
 * 判定 refresh_token 是否已失效（终态：停止调度并提示重新登录）。
 *
 * 结构化判定而非 instanceof：CodeArts（oauth.ts）与 Buddy（buddy-oauth.ts）
 * 各自导出同名 `RefreshTokenExpiredError`，跨模块 identity 不同，
 * 用 instanceof 会让其中一个 provider 的失效信号穿透为「可重试」而无限重试。
 */
function isRefreshTokenExpired(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  // 只认结构化信号（各 provider 统一设 `name='RefreshTokenExpiredError'`）。
  // 2026-11-06 审计移除了旧的 `/refresh[_ ]?token/i` message 兜底：任何恰好
  // 提到 "refresh token" 的普通网络错误都会被误判成终态、停掉续期调度。
  return error.name === 'RefreshTokenExpiredError'
}

/**
 * 计算首次刷新触发前的毫秒数（对齐真实插件 getFirstRefreshTime）：
 * - 无有效过期时间或距过期 ≤1h → 0（立即刷新）；
 * - 否则触发点 = now + 1h，再叠加 0-59 秒随机偏移。
 */
export function computeFirstRefreshDelayMs(expiresAtMs: number, nowMs = Date.now()): number {
  if (!Number.isFinite(expiresAtMs)) return 0
  const leadTrigger = nowMs + REFRESH_LEAD_MS
  if (leadTrigger >= expiresAtMs) return 0
  const trigger = new Date(leadTrigger)
  trigger.setSeconds(Math.floor(60 * Math.random()))
  const delay = trigger.getTime() - nowMs
  return delay > 0 ? delay : 0
}

/**
 * 是否该走**提前续期**（ahead）：已进入 {@link REFRESH_AHEAD_MS} 窗口、且这枚
 * access token 是被签成「长寿命」的（寿命 ≥ {@link REFRESH_AHEAD_MIN_LIFE_MS}）。
 *
 * 判据与 magpie 的 `ahead()` 同形（`left > 0 && left <= AHEAD_MS && life >= LONG_MS`），
 * 只额外要求「refresh_token 还活着」—— 已经过了 `refresh_expires_at` 的凭据
 * 再提前也换不出东西，只会白烧一次请求（这点 magpie 由 `refreshable()` 表达）。
 *
 * ⚠️ `left > 0`：**已过期**的凭据不走提前续期，仍走「立即续」的常规路径，
 * 这样这条判据永远不会把「已经坏了」的账号绕开。
 *
 * @param params.expiresAtMs       access token 的过期时刻（读不到 ⇒ 不续）
 * @param params.lifeMs            这枚令牌**被签发时的寿命**（exp - iat；
 *                                 读不到 ⇒ 无法区分长/短命，退回 1 小时 lead）
 * @param params.refreshExpiresAtMs refresh_token 的过期时刻（可选）
 */
export function isAheadRefreshDue(params: {
  expiresAtMs: number | undefined
  lifeMs: number | undefined
  refreshExpiresAtMs?: number | undefined
  nowMs?: number
}): boolean {
  const { expiresAtMs, lifeMs, refreshExpiresAtMs } = params
  const nowMs = params.nowMs ?? Date.now()
  if (expiresAtMs === undefined || !Number.isFinite(expiresAtMs)) return false
  if (lifeMs === undefined || !Number.isFinite(lifeMs) || lifeMs < REFRESH_AHEAD_MIN_LIFE_MS) return false
  if (refreshExpiresAtMs !== undefined && Number.isFinite(refreshExpiresAtMs) && nowMs >= refreshExpiresAtMs) return false
  const left = expiresAtMs - nowMs
  return left > 0 && left <= REFRESH_AHEAD_MS
}

/**
 * 距「提前续期窗口开启」还有多少毫秒；**不适用**时 `undefined`（寿命不够、
 * 读不到寿命或过期时刻）。
 *
 * 返回值 `0` 表示已经进入窗口（调用方应立即续一次），与
 * {@link computeFirstRefreshDelayMs} 的「0 = 立即」同一约定，便于取二者之小。
 */
export function computeAheadRefreshDelayMs(
  expiresAtMs: number | undefined,
  lifeMs: number | undefined,
  nowMs = Date.now(),
): number | undefined {
  if (expiresAtMs === undefined || !Number.isFinite(expiresAtMs)) return undefined
  if (lifeMs === undefined || !Number.isFinite(lifeMs) || lifeMs < REFRESH_AHEAD_MIN_LIFE_MS) return undefined
  const opensAtMs = expiresAtMs - REFRESH_AHEAD_MS
  return opensAtMs > nowMs ? opensAtMs - nowMs : 0
}

/**
 * 提前续期连续失败 `failures` 次后的重试延迟：1 分钟起、每次翻倍、封顶 30 分钟
 * （对齐 magpie `aheadFailed`：`min(AHEAD_RETRY_MS * 2 ** (n - 1), AHEAD_RETRY_MOST)`）。
 */
export function aheadRetryDelayMs(failures: number): number {
  const times = Number.isFinite(failures) && failures >= 1 ? Math.floor(failures) : 1
  // `2 ** times` 在 times 很大时是 Infinity，`Math.min` 会把它收成上限 —— 预期的封顶行为。
  return Math.min(REFRESH_AHEAD_RETRY_MS * 2 ** (times - 1), REFRESH_AHEAD_RETRY_MAX_MS)
}

/**
 * 提前续期的失败退避表（对齐 magpie 的 `aheadHeld`）。
 *
 * 键是「**被花掉的 refresh_token**」而不是凭据 ref：同一个账号换过一次令牌后
 * 就是另一枚 token，前一枚的失败记录自然失效（magpie `aheadKey` 同形）。
 *
 * ## 为什么不复用 `RefreshScheduler` 的 `REFRESH_RETRY_MS`（10 分钟）
 *
 * 提前续期有 10 天的富余，失败时**不该**急着停手：1 分钟起、翻倍到 30 分钟，
 * 让一次网络抖动在半分钟内就被补上；同时绝不把账号标成失效 —— 失败只影响
 * 「这次续期」，登录态原样保留（magpie `fresh()` 的注释：「a failure here leaves
 * the sign-in as it was and is retried after a wait」）。
 */
export class AheadRetryGate {
  private readonly held = new Map<string, { failures: number; untilMs: number }>()

  /** 记一次失败，返回**下一次**该等多久（毫秒）。 */
  fail(key: string, nowMs = Date.now()): number {
    const failures = (this.held.get(key)?.failures ?? 0) + 1
    const delayMs = aheadRetryDelayMs(failures)
    this.held.set(key, { failures, untilMs: nowMs + delayMs })
    return delayMs
  }

  /** 该 refresh_token 是否仍在退避窗口内。 */
  waiting(key: string, nowMs = Date.now()): boolean {
    const held = this.held.get(key)
    return held !== undefined && held.untilMs > nowMs
  }

  /** 成功后清账：下次失败重新从 1 分钟起。 */
  clear(key: string): void {
    this.held.delete(key)
  }

  /** 记账条数（观测 / 单测用）。 */
  get size(): number {
    return this.held.size
  }
}

/** 静默刷新调度器：一次触发 + 失败重试（失效则停止）。 */
export class RefreshScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending = false
  /** 调度代号：stop()/arm() 都会推进它，用于让在途 run() 放弃失败后的重试武装。 */
  private generation = 0

  constructor(
    private readonly refresh: () => Promise<void>,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  /** 为在 `expiresAtMs` 过期的凭据安排下次刷新；`nowMs` 仅供测试注入。 */
  arm(expiresAtMs: number, nowMs = Date.now()): void {
    this.armAfter(computeFirstRefreshDelayMs(expiresAtMs, nowMs))
  }

  /**
   * 按**显式延迟**武装下一次刷新（{@link arm} 与提前续期共用这一处）。
   *
   * 提前续期要的延迟由调用方算好（如「到剩 10 天那一刻」的毫秒数），而 `arm()` 的
   * `now + 1h` 语义对 28 天寿命的令牌太晚（见 {@link REFRESH_AHEAD_MS}）。
   * 语义与 {@link arm} 完全一致：推进代号、清掉旧定时器、`unref` 掉以免挂住进程。
   */
  armAfter(delayMs: number): void {
    // 先推进代号：使任何在途 run() 的失败路径放弃重试，并隔离旧定时器。
    this.generation++
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const delay = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0
    this.timer = setTimeout(() => {
      void this.run()
    }, delay)
    this.timer.unref?.()
  }

  /** 取消任何待处理的刷新（并让在途 run() 失败后不再重试）。 */
  stop(): void {
    // 先推进代号：登出场景下取消在途刷新失败后的重试武装。
    this.generation++
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** 立即执行一次刷新（供启动时已处于到期窗口内的凭据使用）。 */
  async refreshOnce(): Promise<void> {
    this.stop()
    await this.run()
  }

  private async run(): Promise<void> {
    if (this.pending) return
    this.pending = true
    const generation = this.generation
    try {
      await this.refresh()
    } catch (error) {
      this.onError(error)
      if (generation !== this.generation) {
        // 在途期间被 stop()/arm() 打断：放弃本次失败后的重试，避免登出后调度器复活。
        return
      }
      if (isRefreshTokenExpired(error)) {
        // refresh_token 已失效（终态）：停止调度，提示重新登录。
        return
      }
      // 在途期间可能已新 arm()（this.timer 已指向新定时器 T2）：先清除，避免覆盖后 T2 沦为孤儿定时器。
      if (this.timer !== undefined) {
        clearTimeout(this.timer)
      }
      const retry = isAbnormalNetworkError(error) ? REFRESH_ABNORMAL_NETWORK_RETRY_MS : REFRESH_RETRY_MS
      this.timer = setTimeout(() => {
        void this.run()
      }, retry)
      this.timer.unref?.()
    } finally {
      this.pending = false
    }
  }
}
