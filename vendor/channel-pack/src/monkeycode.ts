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
  MONKEYCODE_SESSION_COOKIES,
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
/**
 * 解包上游的 `{code, message, data}` 信封。
 *
 * ⚠️ **`data` 是数组时也必须解包**（真实缺陷，2026-10-27 实测）：
 * `/users/models/available` 返回 `{code:0, message:'success', data:[…]}`，
 * 而旧实现只认「`data` 是对象」（`isRecord(value.data)` 对数组恒为 `false`）
 * → 整个信封被原样返回 → `fetchModels` 的 `Array.isArray(body)` 判断失败
 * → 抛「模型目录不是数组」→ 适配器静默回落**子集兜底表**。
 *
 * 表现就是：`refreshCatalog` 返回 false、模型列表里没有单价与免费标记，
 * 用户看到的是 14 条「裸名」而不是远端 26 条的真实目录。
 */
export function unwrapData(value: unknown): unknown {
  if (!isRecord(value)) return value
  if (!('data' in value)) return value
  const data = value.data
  // 数组（模型列表）与对象（用户信息 / 任务详情）都是合法的 `data` 形态。
  if (Array.isArray(data) || isRecord(data)) return data
  return value
}

/** 会话 Cookie 值的长度上下限（形状检查，不联网）。 */
const SESSION_VALUE_MIN = 20
const SESSION_VALUE_MAX = 4096
/** 整条 Cookie 串的长度上限（防误粘大段文本）。 */
const COOKIE_MAX = 8192

/** Set-Cookie 响应头的属性段名（从 DevTools 的 Response Headers 复制时会带上）。 */
const SET_COOKIE_ATTRIBUTE = /^(?:path|domain|expires|max-age|secure|httponly|samesite|priority|partitioned|comment)$/i

/** 从尾部剥掉混入的 Set-Cookie 属性段（`Path=/`、`HttpOnly` 等）。 */
function stripSetCookieAttributes(text: string): string {
  const parts = text.split(';')
  let end = parts.length
  while (end > 1) {
    const name = parts[end - 1].trim().split('=')[0].trim()
    if (SET_COOKIE_ATTRIBUTE.test(name)) end -= 1
    else break
  }
  return parts.slice(0, end).join(';').trim()
}

/**
 * 校验并归一一份 Cookie 串。
 *
 * 形状检查（不联网），`account.adopt` 与「粘贴 Cookie 登录」共用本函数：
 * - 会话字段 `nebula_session` 按 cookie 对精确匹配 —— 值里内嵌同名不算数
 *   （`xnebula_session=…` 这种粘连串拒绝）；
 * - 会话值长度 20–4096：真实 session token 至少几十字符，`abc` 这种长度
 *   只可能是误粘贴或占位值，收下也只会换来一次上游 401；
 * - 字符集限可打印 ASCII：中文、制表符、控制字符一律拒绝；
 * - 噪声清洗：折叠换行（浏览器多行复制）、剥 `Cookie:` 头名 / `Bearer `
 *   前缀（误当成令牌粘贴）/ 成对引号、剥尾部 Set-Cookie 属性段。
 * 返回 `undefined` 表示形状不合法。
 */
export function normalizeCookie(raw: string): string | undefined {
  let text = raw.replace(/[\r\n]+/g, ' ').trim()
  text = text.replace(/^cookie\s*:\s*/i, '').replace(/^bearer\s+/i, '')
  text = text.replace(/^"([^"]*)"$/, '$1').trim()
  text = stripSetCookieAttributes(text)
  if (text === '') return undefined
  if (text.length > COOKIE_MAX) return undefined
  if (!/^[\x20-\x7E]+$/.test(text)) return undefined
  // 会话字段按候选名逐个试（`monkeycode_ai_session` 现名 / `nebula_session` 旧名）。
  let value: string | undefined
  for (const name of MONKEYCODE_SESSION_COOKIES) {
    const prefix = `${name}=`
    const hit = text.split(';').find(part => part.trim().startsWith(prefix))
    if (hit === undefined) continue
    const candidate = hit.trim().slice(prefix.length).trim()
    if (candidate !== '') { value = candidate; break }
  }
  if (value === undefined) return undefined
  if (value.length < SESSION_VALUE_MIN || value.length > SESSION_VALUE_MAX) return undefined
  if (!/^[\x21-\x7E]+$/.test(value)) return undefined
  return text
}

/**
 * 判断一份凭据是否「看起来可用」。
 *
 * 本地形状检查（不联网）：Cookie 非空且含会话字段。
 */
export function isCredentialUsable(credential: MonkeyCodeCredential | undefined): credential is MonkeyCodeCredential {
  if (credential === undefined) return false
  const cookie = credential.access_token
  if (typeof cookie !== 'string' || cookie === '') return false
  return MONKEYCODE_SESSION_COOKIES.some(name => cookie.includes(`${name}=`))
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
 * 用**会话 Cookie 的值**派生凭据。
 *
 * 为什么不用钱包里的 `id`：上游 `/api/v1/users/wallet` 的 `id` 是全零占位
 * （`00000000-...`），拿它当 account_id 会让所有账号撞成同一个。
 * 而 `/users/me` 已被上游下线（404），拿不到真实用户 id。
 *
 * 会话值本身是服务端签发的唯一串（`monkeycode_ai_session=<uuid>`），
 * 作为账号标识稳定且唯一；昵称取它的尾 8 位，便于用户区分多账号。
 */
export function credentialFromSession(cookie: string): MonkeyCodeCredential {
  const match = /(?:^|;\s*)monkeycode_ai_session=([^;]+)/.exec(cookie)
    ?? /(?:^|;\s*)nebula_session=([^;]+)/.exec(cookie)
  const session = match?.[1]?.trim() ?? ''
  const tail = session.replace(/-/g, '').slice(-8) || 'unknown'
  return {
    access_token: cookie,
    account_id: session === '' ? undefined : session,
    nickname: `MonkeyCode ${tail}`,
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

/**
 * 把 harness 消息拍平成单条输入。
 *
 * 与 OrcaTerm / KukuAI 同口径：上游一次只收一条 `content`（拍平后的正文），
 * 历史必须自己拼进这一条里。
 */
export function flattenMessages(
  messages: readonly { role: string; content: unknown }[],
  system?: string,
): string {
  const parts: string[] = []
  if (system !== undefined && system.trim() !== '') parts.push(system.trim())
  for (const message of messages) {
    const text = contentToText(message.content)
    if (text.trim() === '') continue
    parts.push(text.trim())
  }
  return parts.join('\n\n')
}

/** 从 harness 内容块抽纯文本。 */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') { parts.push(block); continue }
    if (!isRecord(block)) continue
    const text = stringValue(block.text)
    if (text !== undefined) parts.push(text)
  }
  return parts.join('\n')
}
