/**
 * Loomy 积分：余额查询（只读）。
 *
 * ## 两个积分池（用户补充确认的机制）
 *
 * Loomy 的积分**分成两个池、分开计算**：
 * - **永久积分**：注册奖励 5000 + 新手任务 10000（`balance`）
 * - **每日赠送池**：每天 5000，**消耗后不回补**（`dailyBalance`）
 *
 * 实测（2026-09-26）：
 * ```
 * balance: 15000        ← 永久
 * dailyBalance: 4992    ← 每日池余额 = dailyQuota(5000) - dailyConsumed(8)
 * availableBalance: 19992  ← 两者之和
 * ```
 *
 * ## 每日额度由官方 `first-login` 发放（插件签到功能已移除，2026-11-06）
 *
 * 官方在**登录成功后立即调用** `POST /api/v1/points/first-login`
 * （渲染 bundle 的短信登录与微信登录两条路径都调，失败仅 warn）。
 * 响应返回完整账户快照：
 * ```
 * { alreadyProcessed, currentBalance, permanentBalance, dailyBalance,
 *   dailyQuota, dailyConsumed, dailyCycleDate, ... }
 * ```
 *
 * ⚠️ **`dailyQuota` 只在 `first-login` 的响应里**，`points/records` 不返回它。
 * 每日赠送池仅在官方端触发（插件的签到功能已于 2026-11-06 按用户要求移除）。
 *
 * ## 读与写严格分离
 *
 * | 动作 | 端点 | 性质 |
 * |---|---|---|
 * | 查余额 | `GET /points/records` | **只读**，无副作用 |
 * | ~~一键签到~~ | `POST /points/first-login` | 已移除（2026-11-06） |
 *
 * 这样「打开面板」不会悄悄触发签到。
 */

import type { CreditBalance, CreditPackage } from './credits.js'
import {
  LOOMY_AUTH_ERROR_CODE,
  LOOMY_REQUEST_TIMEOUT_MS,
  parseLoomyEnvelope,
  type LoomyCredential,
} from './loomy.js'
import type { LoomyProduct } from './loomy-product.js'

/** 两个积分池的明细。 */
export interface LoomyCreditDetail {
  /** 永久积分（`balance`）。 */
  permanent: number
  /** 每日赠送池余额（`dailyBalance`）。 */
  daily: number
  /** 永久 + 每日（`availableBalance`）。 */
  total: number
  /** 每日额度上限 —— 仅官方端发放（`first-login` 专有字段）。 */
  dailyQuota?: number
  /** 今日已消耗 —— 仅官方端发放后可得。 */
  dailyConsumed?: number
  /** 每日额度所属业务日（`YYYY-MM-DD`）—— 仅官方端发放后可得。 */
  dailyCycleDate?: string
}

/** 发一次业务请求并拆信封；失败返回结构化错误（余额查询不抛错）。 */
async function tryRequestLoomy<T>(
  credential: LoomyCredential,
  product: LoomyProduct,
  path: string,
  init: { method: string; body?: unknown },
  fetcher: typeof fetch,
): Promise<{ ok: true; data: T } | { ok: false; code: string; message: string }> {
  const headers: Record<string, string> = { Accept: 'application/json', token: credential.access_token }
  let payload: string | undefined
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(init.body)
  }

  let response: Response
  try {
    response = await fetcher(`${product.apiBase}${path}`, {
      method: init.method,
      headers,
      ...payload === undefined ? {} : { body: payload },
      signal: AbortSignal.timeout(LOOMY_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    return { ok: false, code: 'NETWORK', message: error instanceof Error ? error.message : String(error) }
  }

  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    return { ok: false, code: `HTTP_${response.status}`, message: `响应不是 JSON（HTTP ${response.status}）` }
  }

  const envelope = parseLoomyEnvelope<T>(parsed)
  if (!envelope.ok) {
    return { ok: false, code: envelope.code, message: envelope.message }
  }
  return { ok: true, data: envelope.data as T }
}

/** 把任意值读成有限数字；非法返回 undefined（不编造 0）。 */
function readNumber(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * 查询两个积分池的明细（**只读**）。
 *
 * ⚠️ 用 `points/records` 而不是 `first-login`：后者是**写**端点，
 * 在「打开面板」这种高频路径上调用会意外触发签到。
 *
 * @returns 查不到（凭据失效 / 响应异常）时返回 `null`，与「余额为 0」严格区分。
 */
export async function fetchLoomyCreditDetail(
  credential: LoomyCredential,
  product: LoomyProduct,
  fetcher: typeof fetch = fetch,
): Promise<LoomyCreditDetail | null> {
  const result = await tryRequestLoomy<Record<string, unknown>>(
    credential, product,
    '/points/records?pageNo=1&pageSize=1&recordType=all',
    { method: 'GET' }, fetcher,
  )
  if (!result.ok) return null

  const permanent = readNumber(result.data?.balance)
  const daily = readNumber(result.data?.dailyBalance)
  const available = readNumber(result.data?.availableBalance)
  // `balance` 是核心字段：没有它就说明响应形状不对，不编造数字。
  if (permanent === undefined) return null

  const total = available ?? (permanent + (daily ?? 0))
  return {
    permanent,
    daily: daily ?? 0,
    total,
    dailyQuota: readNumber(result.data?.dailyQuota),
    dailyConsumed: readNumber(result.data?.dailyConsumed),
    dailyCycleDate: typeof result.data?.dailyCycleDate === 'string'
      ? result.data.dailyCycleDate
      : undefined,
  }
}

/** 构造一个资源包条目（两池各一个）。 */
function makePackage(name: string, remaining: number): CreditPackage {
  return {
    name,
    unit: '积分',
    remaining,
    total: remaining,
    used: 0,
    active: true,
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: '',
  }
}

/**
 * 查询积分余额（映射成既有的 `CreditBalance` 形状，供 Channel Pack 账号卡片渲染）。
 *
 * ⚠️ **两个池各作一个 package**，让用户看出「永久」与「每日」是分开计算的
 * （用户明确要求的展示方式）。`total` 用 `availableBalance`（两者之和）。
 *
 * @returns 查不到时返回 `null`（卡片显示原因，**不是** 0）。
 */
export async function fetchLoomyCreditBalance(
  credential: LoomyCredential,
  product: LoomyProduct,
  fetcher: typeof fetch = fetch,
): Promise<CreditBalance | null> {
  const detail = await fetchLoomyCreditDetail(credential, product, fetcher)
  if (detail === null) return null
  return {
    total: detail.total,
    packages: [
      makePackage('永久积分', detail.permanent),
      makePackage('每日赠送', detail.daily),
    ],
    // 两池都视为有效额度，没有「已失效」概念。
    expiredTotal: 0,
  }
}
