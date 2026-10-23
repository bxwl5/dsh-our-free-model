/**
 * CatPaw 凭据与模型目录。
 *
 * ⚠️ 认证是 **Cookie 形态的 `X-Passport-Token` 头**（不是 Bearer）。
 * 按 Bearer 写会 401，且与「凭据失效」形态相同。
 */

import {
  CATPAW,
  CATPAW_MODEL_TYPES_PATH,
  CATPAW_TOKEN_HEADER,
  type CatPawProduct,
} from './catpaw-product.js'

/** CatPaw 凭据。 */
export interface CatPawCredential {
  /** 通行证令牌（原样放进 `X-Passport-Token` 头）。 */
  access_token: string
  /** 用户 uid（部分接口需要）。 */
  user_uid?: string
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
export function isCredentialUsable(credential: CatPawCredential | undefined): credential is CatPawCredential {
  if (credential === undefined) return false
  const token = credential.access_token
  return typeof token === 'string' && token !== '' && token === token.trim()
}

/**
 * 构造请求头。
 *
 * ⚠️ `X-Passport-Token`（Cookie 形态），不是 `Authorization: Bearer`。
 */
export function catPawHeaders(product: CatPawProduct, credential: CatPawCredential): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    [CATPAW_TOKEN_HEADER]: credential.access_token,
    ...(credential.user_uid === undefined ? {} : { 'X-User-Uid': credential.user_uid }),
    Origin: product.apiBase,
    Referer: `${product.apiBase}/`,
  }
}

/** 从凭据 JSON 解析。 */
export function parseCredential(value: unknown): CatPawCredential | undefined {
  if (!isRecord(value)) return undefined
  const token = stringValue(value.access_token) ?? stringValue(value.accessToken)
    ?? stringValue(value.token) ?? stringValue(value.passportToken)
  if (token === undefined) return undefined
  return {
    access_token: token,
    ...(stringValue(value.user_uid) === undefined && stringValue(value.userUid) === undefined
      ? {} : { user_uid: stringValue(value.user_uid) ?? stringValue(value.userUid) }),
    ...(stringValue(value.account_id) === undefined ? {} : { account_id: stringValue(value.account_id) }),
    ...(stringValue(value.nickname) === undefined ? {} : { nickname: stringValue(value.nickname) }),
    created_at: Date.now(),
  }
}

/**
 * 解析模型目录响应。
 *
 * 上游是 `POST /api/agent/maas/model-types`，形态未逐字段确认，
 * 故做宽松归一：顶层数组 / `data` / `modelTypes` 三种形态都试。
 */
export function parseModelTypes(value: unknown): Array<{ id: string; name: string; contextWindow: number; maxTokens?: number }> {
  const body = isRecord(value) && isRecord(value.data) ? value.data : value
  const list = Array.isArray(body) ? body
    : isRecord(body) && Array.isArray(body.modelTypes) ? body.modelTypes
    : isRecord(body) && Array.isArray(body.models) ? body.models
    : isRecord(body) && Array.isArray(body.data) ? body.data
    : undefined
  if (list === undefined) return []
  const rows: Array<{ id: string; name: string; contextWindow: number; maxTokens?: number }> = []
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as Record<string, unknown>
    const id = stringValue(item.modelTypeId) ?? stringValue(item.id) ?? stringValue(item.host_model_id)
    if (id === undefined) continue
    const name = stringValue(item.name) ?? stringValue(item.displayName) ?? id
    const contextRaw = item.contextWindow ?? item.context_length ?? item.default_context_window
    const contextWindow = typeof contextRaw === 'number' && contextRaw > 0 ? contextRaw : 128_000
    const maxRaw = item.maxTokens ?? item.max_output_tokens
    const maxTokens = typeof maxRaw === 'number' && maxRaw > 0 ? Math.min(maxRaw, contextWindow) : undefined
    rows.push({ id, name, contextWindow, ...(maxTokens === undefined ? {} : { maxTokens }) })
  }
  return rows
}

/**
 * 拉模型目录。
 *
 * ⚠️ 是 **POST**（不是 GET）—— 写成 GET 会得到 405。
 */
export async function fetchModelTypes(
  fetcher: typeof fetch,
  product: CatPawProduct,
  credential: CatPawCredential,
  signal?: AbortSignal,
): Promise<Array<{ id: string; name: string; contextWindow: number; maxTokens?: number }>> {
  const response = await fetcher(`${product.apiBase}${CATPAW_MODEL_TYPES_PATH}`, {
    method: 'POST',
    headers: catPawHeaders(product, credential),
    body: JSON.stringify({}),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new Error(`CatPaw：模型目录返回 HTTP ${response.status}`)
  const rows = parseModelTypes(await response.json().catch(() => undefined))
  if (rows.length === 0) throw new Error('CatPaw：模型目录为空或形态未识别')
  return rows
}

/**
 * 探活。
 *
 * 用模型目录接口：它是唯一无需建会话的轻量鉴权探针。
 */
export async function probeCredential(
  fetcher: typeof fetch,
  product: CatPawProduct,
  credential: CatPawCredential,
  signal?: AbortSignal,
): Promise<'valid' | 'expired' | 'network_error'> {
  if (!isCredentialUsable(credential)) return 'expired'
  try {
    const response = await fetcher(`${product.apiBase}${CATPAW_MODEL_TYPES_PATH}`, {
      method: 'POST',
      headers: catPawHeaders(product, credential),
      body: JSON.stringify({}),
      ...(signal === undefined ? {} : { signal }),
    })
    void response.body?.cancel().catch(() => undefined)
    if (response.status === 401 || response.status === 403) return 'expired'
    return response.ok ? 'valid' : 'network_error'
  } catch {
    return 'network_error'
  }
}
