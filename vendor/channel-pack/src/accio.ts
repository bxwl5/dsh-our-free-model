/**
 * Accio 凭据与协议纯函数。
 *
 * ## 三个必须记住的点
 *
 * 1. **token 不走 Authorization 头**：GET 拼 query、POST 放 body。
 * 2. **请求体是 Gemini 风格**：`{ contents: [{role, parts}], tools?, token }`。
 * 3. **响应是 ADK 帧**：`{ content: { role, parts: [{text} | {thought,text} | {function_call}] }, turn_complete? }`。
 */

import {
  ACCIO_REGION_HEADER,
  type AccioProduct,
} from './accio-product.js'

/** Accio 凭据。 */
export interface AccioCredential {
  /** 访问令牌。 */
  access_token: string
  /** 续期令牌。 */
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

/** 判断凭据形状是否可用。 */
export function isCredentialUsable(credential: AccioCredential | undefined): credential is AccioCredential {
  if (credential === undefined) return false
  const token = credential.access_token
  return typeof token === 'string' && token !== '' && token === token.trim()
}

/** 凭据是否已过期（留 60 秒余量）。 */
export function isCredentialExpired(credential: AccioCredential, nowMs: number = Date.now()): boolean {
  if (credential.expire_time === undefined) return false
  return credential.expire_time - 60_000 <= nowMs
}

/**
 * 构造请求头。
 *
 * ⚠️ **不带 Authorization** —— Accio 的 token 走 query/body。
 * 带了反而可能被当成冲突凭据。
 */
export function accioHeaders(product: AccioProduct): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    [ACCIO_REGION_HEADER]: product.region,
    Origin: product.loginBase,
    Referer: `${product.loginBase}/`,
  }
}

/** 解析 OAuth token 响应。 */
export function parseTokenResponse(value: unknown): AccioCredential | undefined {
  if (!isRecord(value)) return undefined
  const body = isRecord(value.data) ? value.data : value
  const accessToken = stringValue(body.accessToken) ?? stringValue(body.access_token)
  if (accessToken === undefined) return undefined
  const refreshToken = stringValue(body.refreshToken) ?? stringValue(body.refresh_token)
  // expiresAt 可能是毫秒时间戳，也可能是秒。
  const expiresRaw = numberValue(body.expiresAt) ?? numberValue(body.expires_at)
  const expireTime = expiresRaw === undefined ? undefined : expiresRaw < 1e12 ? expiresRaw * 1000 : expiresRaw
  return {
    access_token: accessToken,
    ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
    ...(expireTime === undefined ? {} : { expire_time: expireTime }),
    created_at: Date.now(),
  }
}

/**
 * 构造 Gemini 风格的推理请求体。
 *
 * 形状（Agent2API 实测）：
 * ```
 * { contents: [{ role: 'user'|'model', parts: [{ text }] }], tools?, token }
 * ```
 * ⚠️ `token` 在 **body 里**，不是请求头。
 */
export function buildGenerateBody(options: {
  token: string
  messages: readonly { role: string; content: unknown }[]
  system?: string
  tools?: readonly { name: string; description?: string; parameters?: unknown }[]
}): Record<string, unknown> {
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = []
  if (options.system !== undefined && options.system.trim() !== '') {
    // Gemini 风格把 system 放在最前面的 user 轮（上游没有独立 system 字段）。
    contents.push({ role: 'user', parts: [{ text: options.system.trim() }] })
  }
  for (const message of options.messages) {
    const text = contentToText(message.content)
    if (text.trim() === '') continue
    contents.push({
      // harness 的 assistant → Gemini 的 model。
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: text.trim() }],
    })
  }
  const body: Record<string, unknown> = { contents, token: options.token }
  if (options.tools !== undefined && options.tools.length > 0) {
    body.tools = [{
      functionDeclarations: options.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
      })),
    }]
  }
  return body
}

/**
 * 解析一帧 ADK 响应。
 *
 * 帧形态：
 * - `{ content: { parts: [{ text }] } }` —— 正文
 * - `{ content: { parts: [{ thought: true, text }] } }` —— 思考
 * - `{ content: { parts: [{ function_call: { name, args_json } }] } }` —— 工具调用
 * - `{ turn_complete: true, finish_reason, usage_metadata }` —— 结束
 */
export function parseAdkFrame(
  value: unknown,
): { kind: 'delta'; text?: string; reasoning?: string } | { kind: 'done'; finishReason?: string } | { kind: 'error'; message: string } | undefined {
  if (!isRecord(value)) return undefined
  // 业务错误常在 200 的帧里（不是 HTTP 状态码）。
  const errorCode = value.error_code ?? value.errorCode
  if (errorCode !== undefined && errorCode !== 0 && errorCode !== '0') {
    return {
      kind: 'error',
      message: stringValue(value.error_message) ?? stringValue(value.errorMessage) ?? `error_code=${String(errorCode)}`,
    }
  }
  if (value.turn_complete === true) {
    return { kind: 'done', ...(stringValue(value.finish_reason) === undefined ? {} : { finishReason: stringValue(value.finish_reason) }) }
  }
  const content = value.content
  if (!isRecord(content) || !Array.isArray(content.parts)) return undefined
  const texts: string[] = []
  const reasonings: string[] = []
  for (const part of content.parts) {
    if (!isRecord(part)) continue
    const text = stringValue(part.text)
    if (text === undefined) continue
    if (part.thought === true) reasonings.push(text)
    else texts.push(text)
  }
  if (reasonings.length > 0) return { kind: 'delta', reasoning: reasonings.join('') }
  if (texts.length > 0) return { kind: 'delta', text: texts.join('') }
  return undefined
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

/**
 * 生成 PKCE 的 code verifier / challenge（S256）。
 *
 * 返回 `{ verifier, challenge }`；challenge 是 verifier 的 SHA-256 的
 * base64url 编码（无 padding）。
 */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const { randomBytes, createHash } = await import('node:crypto')
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** 构造授权 URL。 */
export function buildAccioAuthUrl(
  product: AccioProduct,
  redirectUri: string,
  state: string,
  challenge: string,
): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: product.clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  return `${product.loginBase}/oauth/authorize?${query.toString()}`
}
