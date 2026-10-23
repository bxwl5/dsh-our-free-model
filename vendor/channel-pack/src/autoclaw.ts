/**
 * AutoClaw 凭据与请求构造纯函数。
 *
 * ⚠️ **认证头是 `X-Authorization`**（源实现如此，规格文档写的 `Authorization`
 * 是错的）。按文档写会 401，且与「token 失效」形态相同，极易误判。
 */

import type { AutoClawProduct } from './autoclaw-product.js'

/** AutoClaw 凭据。 */
export interface AutoClawCredential {
  /** 访问令牌（Bearer）。 */
  access_token: string
  /** 刷新令牌（可选）。 */
  refresh_token?: string
  /** 过期时间（毫秒时间戳）。 */
  expire_time?: number
  /** 账号标识。 */
  account_id?: string
  /** 昵称。 */
  nickname?: string
  /** 创建时间。 */
  created_at?: number
}

/** 从任意 JSON 安全取字符串。 */
function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 是否非 null 对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断凭据形状是否可用。 */
export function isCredentialUsable(credential: AutoClawCredential | undefined): credential is AutoClawCredential {
  if (credential === undefined) return false
  const token = credential.access_token
  return typeof token === 'string' && token !== '' && token === token.trim()
}

/** 凭据是否已过期（留 60 秒余量）。 */
export function isCredentialExpired(credential: AutoClawCredential, nowMs: number = Date.now()): boolean {
  if (credential.expire_time === undefined) return false
  return credential.expire_time - 60_000 <= nowMs
}

/**
 * 构造请求头。
 *
 * ⚠️ `X-Authorization`（不是 `Authorization`）—— 见模块头注释。
 */
export function autoClawHeaders(product: AutoClawProduct, credential: AutoClawCredential): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Authorization': `Bearer ${credential.access_token}`,
    Origin: product.apiBase,
    Referer: `${product.apiBase}/`,
  }
}

/** 对话端点。 */
export function chatEndpoint(product: AutoClawProduct): string {
  return `${product.apiBase}${product.proxyPrefix}/chat/completions`
}

/** 从凭据 JSON 解析（字段名兼容多种拼写）。 */
export function parseCredential(value: unknown): AutoClawCredential | undefined {
  if (!isRecord(value)) return undefined
  const token = stringValue(value.access_token) ?? stringValue(value.accessToken)
    ?? stringValue(value.token)
  if (token === undefined) return undefined
  const expiresRaw = value.expire_time ?? value.expiresAt ?? value.expires_at
  const expireTime = typeof expiresRaw === 'number' && Number.isFinite(expiresRaw)
    ? (expiresRaw < 1e12 ? expiresRaw * 1000 : expiresRaw)
    : undefined
  return {
    access_token: token,
    ...(stringValue(value.refresh_token) === undefined && stringValue(value.refreshToken) === undefined
      ? {} : { refresh_token: stringValue(value.refresh_token) ?? stringValue(value.refreshToken) }),
    ...(expireTime === undefined ? {} : { expire_time: expireTime }),
    ...(stringValue(value.account_id) === undefined ? {} : { account_id: stringValue(value.account_id) }),
    ...(stringValue(value.nickname) === undefined ? {} : { nickname: stringValue(value.nickname) }),
    created_at: Date.now(),
  }
}

/**
 * 解析模型目录响应。
 *
 * 上游形态未完全确定（参考实现只记录路径），故做宽松归一：
 * 依次尝试 `models` / `data` / 顶层数组三种形态。
 */
export function parseModelConfig(value: unknown): Array<{ id: string; name: string; contextWindow: number; maxTokens?: number }> {
  const list = Array.isArray(value) ? value
    : isRecord(value) && Array.isArray(value.models) ? value.models
    : isRecord(value) && Array.isArray(value.data) ? value.data
    : undefined
  if (list === undefined) return []
  const rows: Array<{ id: string; name: string; contextWindow: number; maxTokens?: number }> = []
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as Record<string, unknown>
    const id = stringValue(item.id) ?? stringValue(item.model) ?? stringValue(item.name)
    if (id === undefined) continue
    const name = stringValue(item.name) ?? stringValue(item.displayName) ?? id
    const contextRaw = item.contextWindow ?? item.context_length ?? item.maxInputTokens
    const contextWindow = typeof contextRaw === 'number' && contextRaw > 0 ? contextRaw : 128_000
    const maxRaw = item.maxTokens ?? item.max_output_tokens
    const maxTokens = typeof maxRaw === 'number' && maxRaw > 0 ? Math.min(maxRaw, contextWindow) : undefined
    rows.push({ id, name, contextWindow, ...(maxTokens === undefined ? {} : { maxTokens }) })
  }
  return rows
}
