/**
 * Command Code 额度查询。
 *
 * `/alpha/billing/credits` 的字段名未经实测确认，因此这里只做**展示用**的
 * 宽松归一，且严格区分两种「没有数值」：
 *
 * - **查询失败 / 字段未识别** → `undefined`：表示「不知道」，
 *   账号池不应因此冷却账号；
 * - **上游明确返回 0** → `0`：表示「确实用完了」，可以据此提示用户。
 *
 * 把两者混为一谈会让一次网络抖动把一个完好账号打进冷却。
 */

import type { CommandCodeProduct } from './commandcode-product.js'
import type { CommandCodeCredential } from './commandcode.js'
import { fetchCredits } from './commandcode-auth.js'

/** 额度快照（展示用）。 */
export interface CommandCodeCreditsSnapshot {
  /** 剩余额度；`undefined` = 未知。 */
  balance?: number
  /** 额度上限；`undefined` = 未知。 */
  limit?: number
  /** 已用额度；`undefined` = 未知。 */
  used?: number
  /** 单位（上游原样）。 */
  currency?: string
  /** 重置时间（毫秒时间戳）；`undefined` = 未知。 */
  resetAtMs?: number
  /**
   * 是否已确认耗尽。
   *
   * ⚠️ 只有**明确**读到「balance 为 0」或「used 已达 limit」时才为 true。
   * 读不到数值时为 false —— 「不知道」不等于「用完了」。
   */
  exhausted: boolean
}

/**
 * 拉取一次额度快照。
 *
 * 永不抛错：失败返回 `undefined`，由调用方决定怎么展示。
 */
export async function readCredits(
  fetcher: typeof fetch,
  product: CommandCodeProduct,
  credential: CommandCodeCredential,
  signal?: AbortSignal,
): Promise<CommandCodeCreditsSnapshot | undefined> {
  const raw = await fetchCredits(fetcher, product, credential, signal)
  if (raw === undefined) return undefined
  const balance = raw.balance
  const limit = raw.limit
  const used = raw.used
  // 耗尽判定：只在能确证时成立。
  const exhausted = (balance !== undefined && balance <= 0)
    || (limit !== undefined && used !== undefined && used >= limit && limit > 0)
  return {
    ...(balance === undefined ? {} : { balance }),
    ...(limit === undefined ? {} : { limit }),
    ...(used === undefined ? {} : { used }),
    ...(raw.currency === undefined ? {} : { currency: raw.currency }),
    ...(raw.resetAtMs === undefined ? {} : { resetAtMs: raw.resetAtMs }),
    exhausted,
  }
}

/**
 * 把额度快照格式化成一行可读文本（设置页 / 账号卡展示用）。
 *
 * 未知字段不编造数字 —— 宁可少显示，也不要让用户以为「还剩 0」。
 */
export function formatCredits(snapshot: CommandCodeCreditsSnapshot | undefined): string {
  if (snapshot === undefined) return '额度暂不可查'
  const parts: string[] = []
  if (snapshot.balance !== undefined) {
    parts.push(snapshot.currency === undefined
      ? `剩余 ${formatNumber(snapshot.balance)}`
      : `剩余 ${formatNumber(snapshot.balance)} ${snapshot.currency}`)
  }
  if (snapshot.limit !== undefined && snapshot.used !== undefined) {
    parts.push(`已用 ${formatNumber(snapshot.used)} / ${formatNumber(snapshot.limit)}`)
  }
  if (snapshot.exhausted) parts.push('已耗尽')
  return parts.length === 0 ? '额度暂不可查' : parts.join(' · ')
}

/** 数字格式化：大数用 K/M 缩写，小数保留一位。 */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}
