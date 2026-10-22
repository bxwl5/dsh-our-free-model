/**
 * MonkeyCode 凭据与协议纯函数。
 *
 * 与其它渠道最大的差异：**凭据是 Cookie 会话，不是 token**。
 * 因此这里没有 JWT 解码、没有过期时间解析、没有 refresh 流程。
 *
 * ⚠️ Cookie 是**明文敏感凭据**（等价于登录态）。本模块只做形状归一，
 * 不记录、不打印、不派生任何可逆摘要。
 */

import {
  MONKEYCODE_SESSION_COOKIE,
  type MonkeyCodeProduct,
} from './monkeycode-product.js'

/**
 * MonkeyCode 凭据。
 *
 * `access_token` 字段名沿用本插件统一约定，但**值是完整 Cookie 串**
 * （形如 `nebula_session=xxx; _ga=yyy`），不是 Bearer token。
 */
export interface MonkeyCodeCredential {
  /** 完整 Cookie 串（原样透传，不做任何解析或裁剪）。 */
  access_token: string
  /** 账号 id（`/users/me` 的 `id`）。 */
  account_id?: string
  /** 昵称。 */
  nickname?: string
  /** 邮箱。 */
  email?: string
  /** 会员档位（`free` / `basic` / `pro` / `ultra`）。 */
  plan?: string
  /** 创建时间（毫秒时间戳）。 */
  created_at?: number
}

/** `/api/v1/users/me` 的响应形状。 */
export interface MonkeyCodeUser {
  id?: string
  name?: string
  nickname?: string
  email?: string
  plan?: string
}

/** `/api/v1/users/wallet` 的响应形状。 */
export interface MonkeyCodeWallet {
  /** 积分余量。 */
  balance?: number
  /** 今日额度剩余。 */
  daily_token_balance?: number
  /** 今日额度上限。 */
  daily_token_limit?: number
  /** 币种。 */
  currency?: string
}

/** 签到状态。 */
export interface MonkeyCodeCheckinStatus {
  /** 今日是否已签到。 */
  checkedIn: boolean
  /** 连续签到天数。 */
  streak?: number
  /** 本次奖励积分。 */
  reward?: number
}

/** 从任意 JSON 安全取字符串。 */
function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 从任意 JSON 安全取有限数值。 */
function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** 是否非 null 对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 上游响应可能套 `{code, data}` 信封，也可能直接是裸对象。
 *
 * 参考实现两种都兼容；这里统一剥壳，避免每个解析函数各写一遍。
 */
export function unwrapData(value: unknown): unknown {
  if (!isRecord(value)) return value
  if ('data' in value && isRecord(value.data)) return value.data
  return value
}

/**
 * 校验并归一一份 Cookie 串。
 *
 * 只做形状检查：必须含 `nebula_session`，且不含换行（浏览器复制常带换行）。
 * 返回 `undefined` 表示形状不合法。
 */
export function normalizeCookie(raw: string): string | undefined {
  const trimmed = raw.replace(/[\r\n]+/g, ' ').trim()
  if (trimmed === '') return undefined
  if (!trimmed.includes(`${MONKEYCODE_SESSION_COOKIE}=`)) return undefined
  return trimmed
}

/**
 * 判断一份凭据是否「看起来可用」。
 *
 * 本地形状检查（不联网）：Cookie 非空且含会话字段。
 */
export function isCredentialUsable(credential: MonkeyCodeCredential | undefined): credential is MonkeyCodeCredential {
  if (credential === undefined) return false
  const cookie = credential.access_token
  return typeof cookie === 'string' && cookie !== '' && cookie.includes(`${MONKEYCODE_SESSION_COOKIE}=`)
}

/** 解析 `/users/me` 响应。缺 `id` 视为无效。 */
export function parseUser(value: unknown): MonkeyCodeUser | undefined {
  const body = unwrapData(value)
  if (!isRecord(body)) return undefined
  const id = stringValue(body.id)
  if (id === undefined) return undefined
  return {
    id,
    name: stringValue(body.name),
    nickname: stringValue(body.nickname),
    email: stringValue(body.email),
    plan: stringValue(body.plan),
  }
}

/** 把用户信息归一成凭据。 */
export function credentialFromUser(cookie: string, user: MonkeyCodeUser): MonkeyCodeCredential {
  return {
    access_token: cookie,
    account_id: user.id,
    nickname: user.nickname ?? user.name ?? user.email,
    email: user.email,
    plan: user.plan,
    created_at: Date.now(),
  }
}

/**
 * 解析钱包。
 *
 * 三个数值都可能缺失 —— 返回 `undefined` 表示「无法得知」，
 * 与「额度为零」是两件事（账号池不该因此冷却）。
 */
export function parseWallet(value: unknown): MonkeyCodeWallet | undefined {
  const body = unwrapData(value)
  if (!isRecord(body)) return undefined
  const balance = numberValue(body.balance)
  const dailyBalance = numberValue(body.daily_token_balance)
  const dailyLimit = numberValue(body.daily_token_limit)
  if (balance === undefined && dailyBalance === undefined && dailyLimit === undefined) return undefined
  return {
    ...(balance === undefined ? {} : { balance }),
    ...(dailyBalance === undefined ? {} : { daily_token_balance: dailyBalance }),
    ...(dailyLimit === undefined ? {} : { daily_token_limit: dailyLimit }),
    ...(stringValue(body.currency) === undefined ? {} : { currency: stringValue(body.currency) }),
  }
}

/** 解析签到状态。 */
export function parseCheckin(value: unknown): MonkeyCodeCheckinStatus {
  const body = unwrapData(value)
  if (!isRecord(body)) return { checkedIn: false }
  const checkedIn = body.checked_in === true || body.checkedIn === true
  const streak = numberValue(body.streak_days) ?? numberValue(body.streak)
  const reward = numberValue(body.reward)
  return {
    checkedIn,
    ...(streak === undefined ? {} : { streak }),
    ...(reward === undefined ? {} : { reward }),
  }
}

/**
 * 构造请求头。
 *
 * ⚠️ Cookie 原样透传：上游按 same-origin cookie 认证，
 * 任何裁剪或重排都可能让它认不出会话。
 */
export function monkeyCodeHeaders(product: MonkeyCodeProduct, credential: MonkeyCodeCredential): Record<string, string> {
  return {
    Accept: 'application/json',
    Referer: `${product.apiBase}/`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Cookie: credential.access_token,
  }
}
