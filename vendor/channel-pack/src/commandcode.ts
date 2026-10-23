/**
 * Command Code 凭据模型与协议纯函数。
 *
 * 本模块**不做任何 IO**：解析、构造、判定全部是纯函数，便于单测锁死。
 * 网络行为在 `src/commandcode-auth.ts`（登录）与 `src/commandcode-adapter.ts`（推理）。
 *
 * ## 与既有渠道的关键差异
 *
 * 1. **单个长期 API Key，没有 refresh_token 轮换** —— 凭据不会过期，
 *    也就没有续期流程；失效只能重新登录（`/alpha/whoami` 返回 401）。
 * 2. **鉴权头是标准 `Bearer <key>`**，不加任何前缀（与 Cline 的
 *    `workos:` 前缀相反）。
 * 3. **推理体是标准 OpenAI Chat Completions**，直接复用既有 SSE 解码。
 */

import { COMMANDCODE_STUDIO_AUTH_PATH, type CommandCodeProduct } from './commandcode-product.js'

/**
 * Command Code 凭据（持久化到 `ctx.credentials` 的 JSON）。
 *
 * 字段名沿用本插件统一的 `access_token` 命名（与 `ClineCredential` /
 * `QoderCredential` 一致），便于账号池与展示层复用。
 */
export interface CommandCodeCredential {
  /**
   * API Key。
   *
   * ⚠️ 原样使用，**不加前缀、不改大小写**。Command Code 的 key 本身
   * 不携带可解析的结构（不是 JWT），任何改写都会导致 401。
   */
  access_token: string
  /** 账号 id（`/alpha/whoami` 的 `userId`）。 */
  account_id?: string
  /** 用户名（账号池展示名）。 */
  nickname?: string
  /** 邮箱（若 whoami 返回）。 */
  email?: string
  /** Key 名称（`/alpha/whoami` 的 `keyName`，便于多 key 区分）。 */
  key_name?: string
  /** 创建时间（毫秒时间戳）。 */
  created_at?: number
}

/**
 * `/alpha/whoami` 的响应形状。
 *
 * ⚠️ 字段名按参考实现整理；上游若返回额外字段，解析时忽略即可，
 * 但**必填字段缺失要视为无效凭据**，而不是静默接受。
 */
export interface CommandCodeWhoami {
  /** 账号 id。 */
  userId?: string
  /** 用户名。 */
  userName?: string
  /** 邮箱。 */
  email?: string
  /** 当前 Key 的名称。 */
  keyName?: string
  /** 会员档位（`free` / `pro` / `go` 等）。 */
  plan?: string
}

/**
 * `/alpha/billing/credits` 的响应形状。
 *
 * ⚠️ 具体字段名未经实测确认（参考实现里也只做了容错读取），
 * 因此这里全部标为可选，由 {@link parseCredits} 做宽松归一。
 */
export interface CommandCodeCredits {
  /** 剩余额度（归一后的数值，单位由上游决定）。 */
  balance?: number
  /** 额度上限。 */
  limit?: number
  /** 已用额度。 */
  used?: number
  /** 币种或单位。 */
  currency?: string
  /** 重置时间（毫秒时间戳）。 */
  resetAtMs?: number
}

/** 从任意 JSON 里安全取字符串。 */
function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 从任意 JSON 里安全取有限数值。 */
function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** 判断值是否为非 null 对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 解析 `/alpha/whoami` 响应。
 *
 * 返回 `undefined` 表示响应不可用（形状不对或缺少 `userId`）——
 * 调用方应把它当作**凭据无效**处理，而不是当作网络错误重试。
 */
export function parseWhoami(value: unknown): CommandCodeWhoami | undefined {
  if (!isRecord(value)) return undefined
  const userId = stringValue(value.userId) ?? stringValue(value.user_id) ?? stringValue(value.id)
  if (userId === undefined) return undefined
  return {
    userId,
    userName: stringValue(value.userName) ?? stringValue(value.user_name) ?? stringValue(value.name),
    email: stringValue(value.email),
    keyName: stringValue(value.keyName) ?? stringValue(value.key_name),
    plan: stringValue(value.plan) ?? stringValue(value.tier),
  }
}

/**
 * 把 whoami 归一成凭据。
 *
 * @param apiKey 已验证可用的 API Key
 * @param whoami `/alpha/whoami` 的解析结果
 */
export function credentialFromWhoami(apiKey: string, whoami: CommandCodeWhoami): CommandCodeCredential {
  return {
    access_token: apiKey,
    account_id: whoami.userId,
    nickname: whoami.userName ?? whoami.email ?? whoami.keyName,
    email: whoami.email,
    key_name: whoami.keyName,
    created_at: Date.now(),
  }
}

/**
 * 解析 `/alpha/billing/credits` 响应。
 *
 * 上游字段名不确定，故做**宽松归一**：依次尝试常见命名，
 * 全部缺失时返回 `undefined`（表示「无法得知」，而不是「额度为零」——
 * 这两者对账号池的决策完全不同）。
 */
export function parseCredits(value: unknown): CommandCodeCredits | undefined {
  if (!isRecord(value)) return undefined
  // 有些实现套一层 { data: {...} } 信封。
  const body = isRecord(value.data) ? value.data : value
  const balance = numberValue(body.balance)
    ?? numberValue(body.credits)
    ?? numberValue(body.remaining)
    ?? numberValue(body.available)
  const limit = numberValue(body.limit) ?? numberValue(body.total) ?? numberValue(body.quota)
  const used = numberValue(body.used) ?? numberValue(body.consumed)
  const resetRaw = numberValue(body.resetAt) ?? numberValue(body.reset_at) ?? numberValue(body.resetAtMs)
  if (balance === undefined && limit === undefined && used === undefined) return undefined
  return {
    balance,
    limit,
    used,
    currency: stringValue(body.currency) ?? stringValue(body.unit),
    // 秒级时间戳统一抬到毫秒；已经足够大的值原样保留。
    resetAtMs: resetRaw === undefined ? undefined : resetRaw < 1e12 ? resetRaw * 1000 : resetRaw,
  }
}

/**
 * 构造推理请求的鉴权头。
 *
 * ⚠️ **不加前缀**：Command Code 用的是标准 Bearer（与 Cline 的
 * `workos:` 前缀相反）。把前缀写错会得到 401，而 401 的文案通常
 * 与真实原因无关，容易误判成「Key 失效」。
 */
export function commandCodeBearerValue(credential: CommandCodeCredential): string {
  return `Bearer ${credential.access_token}`
}

/**
 * 判断一份凭据是否「看起来可用」。
 *
 * 只做本地形状检查（不联网）：Key 非空、无首尾空白。
 * 真正的有效性由 `/alpha/whoami` 判定。
 */
export function isCredentialUsable(credential: CommandCodeCredential | undefined): credential is CommandCodeCredential {
  if (credential === undefined) return false
  const key = credential.access_token
  return typeof key === 'string' && key !== '' && key === key.trim()
}

/**
 * 构造浏览器授权 URL。
 *
 * 与官方 CLI（`command-code@1.87.3`）逐字对齐：
 * `{studioBase}{authPath}?callback=<本地回调>&state=<防伪随机串>&mode=redirect`
 *
 * 三个事实来自官方 CLI `buildCommandAuthUrl` 源码 + 2026-10-23 LIVE 实测：
 * - 授权路径是 `/studio/auth/cli`；旧的 `/cli/authorize` 已 404（死链）；
 * - 官方回调地址用 `http://127.0.0.1:<port>/callback`，**不是** `localhost`。
 *   本模块的回调服务器只 `listen(port, '127.0.0.1')`；在同时启用 IPv4/IPv6
 *   的机器上 `localhost` 可能先解析到 `::1`，导致浏览器回调连不上；
 * - URL 固定带 `mode=redirect`（官方登录流程从不传 `client` 参数）。
 *
 * @param product 产品配置
 * @param port 本地回调端口
 * @param state 一次性防伪串（回调必须原样带回）
 */
export function buildCommandCodeAuthUrl(product: CommandCodeProduct, port: number, state: string): string {
  const callback = `http://127.0.0.1:${port}/callback`
  const query = new URLSearchParams({ callback, state, mode: 'redirect' })
  return `${product.studioBase}${COMMANDCODE_STUDIO_AUTH_PATH}?${query.toString()}`
}

/**
 * 从回调 body 里提取凭据。
 *
 * 回调载荷由 Studio 页面 POST 到本地端口，形状与官方 CLI 一致：
 * `{ apiKey, state, userId, userName, keyName }`
 *
 * 返回 `undefined` 表示载荷不完整——**必须拒绝**，而不是用缺失字段
 * 拼一份半残凭据（那会让用户在很久之后才发现 Key 是空的）。
 */
export function parseCallbackCredentials(value: unknown): CommandCodeCredential | undefined {
  if (!isRecord(value)) return undefined
  const apiKey = stringValue(value.apiKey)
  const state = stringValue(value.state)
  const userId = stringValue(value.userId)
  if (apiKey === undefined || state === undefined || userId === undefined) return undefined
  return {
    access_token: apiKey,
    account_id: userId,
    nickname: stringValue(value.userName) ?? stringValue(value.email),
    email: stringValue(value.email),
    key_name: stringValue(value.keyName),
    created_at: Date.now(),
  }
}

/** 回调载荷里必须与请求时下发的 `state` 一致的字段名。 */
export const COMMANDCODE_CALLBACK_STATE_FIELD = 'state' as const
