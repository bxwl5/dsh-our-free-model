/**
 * Accio 凭据与协议纯函数。
 *
 * ## 三个必须记住的点
 *
 * 1. **token 不走 Authorization 头**：GET 拼 query、POST 放 body。
 * 2. **请求体是 Gemini 风格**：`{ contents: [{role, parts}], tools?, token }`。
 * 3. **响应是 ADK 帧**：`{ content: { role, parts: [{text} | {thought,text} | {function_call}] }, turn_complete? }`。
 */

import { randomUUID } from 'node:crypto'

import {
  ACCIO_APP_KEY,
  ACCIO_APP_VERSION,
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
/**
 * 推理 / 目录请求的公共头。
 *
 * ⚠️ `appKey` **必填**（上游 `aimod-cc/Agent2API` 的 `providers/accio/endpoints.rs`
 * 记录）：不带它打 `generateContent`，上游**不报错**，而是回一段普通文本
 * 「Your app version is no longer supported. Please update…」—— HTTP 200、
 * `data:` 帧，形态与正常回答完全一样，会被当成模型输出吐给下游。
 * 带上任意非空取值即恢复（实测 `35298846` / `12345678` 都通，空串等同于没带）
 * —— 上游只校验「有没有」，不校验取值。
 *
 * 其余 `x-app-version` / `x-platform` / `x-os` / `x-language` /
 * `Accept-Language` 与上游 `api_headers()` 逐字段对齐（同一份客户端指纹）。
 */
export function accioHeaders(product: AccioProduct): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'Accept-Language': 'en',
    'x-language': 'en',
    'x-platform': 'desktop',
    'x-os': process.platform === 'win32' ? 'windows' : process.platform,
    'x-app-version': ACCIO_APP_VERSION,
    [ACCIO_REGION_HEADER]: product.region,
    appKey: ACCIO_APP_KEY,
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
  model?: string
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
  /**
   * ADK 信封字段（上游 `providers/accio/protocol.rs` 的四个必须照抄点）。
   *
   * - `tenant` / `iai_tag` / `empid`：桌面端客户端指纹，缺了会被上游风控
   *   （实测回 `{"rgv587_flag":"sm", …}` 的 punish 页，HTTP 200 但 body 是
   *   风控跳转而不是 SSE，最终表现为「模型可用但返回空」）。
   * - `request_id` / `message_id`：**`message_id` 必填** —— 上游注释记录
   *   缺了它回 `{"error_code":"400","error_message":"invalid params"}`
   *   （同样是 HTTP 200 的帧）。形态不限，用同源随机串加前缀。
   */
  // 与 `accio-auth.ts` 同款：Node 内建 crypto（该文件顶部已 import）。
  const requestId = randomUUID()
  const body: Record<string, unknown> = {
    model: options.model,
    tenant: 'accio-agent',
    iai_tag: 'phoenix-desktop',
    empid: '',
    request_id: requestId,
    message_id: `msg-${requestId}`,
    token: options.token,
    contents,
  }
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

/**
 * 构造授权 URL。
 *
 * ⚠️ Accio **没有**标准的 `/oauth/authorize` 端点：那个路径会被前端路由兜底成官网首页
 *（用户看到的就是「点了没反应，一直空白页」）。真实授权入口是登录页本身：
 *
 *   {loginBase}/login?return_url=<本机回调>&state=…&code_challenge=…
 *                 &code_challenge_method=S256&client_id=accio-work
 *
 * 参数名是 **`return_url`** 而不是 `redirect_uri`，也没有 `response_type`。
 * 依据：桌面端 `aimod-cc/Agent2API` 的 `providers/accio/oauth.rs::build_authorize_url`，
 * 实测 `GET /login?...` 返回的是真正的登录页（`<title>Login to Accio</title>`），
 * 而 `/oauth/authorize?...` 与任意不存在的路径返回同一个首页。
 */
export function buildAccioAuthUrl(
  product: AccioProduct,
  redirectUri: string,
  state: string,
  challenge: string,
): string {
  const query = new URLSearchParams({
    return_url: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    client_id: product.clientId,
  })
  return `${product.loginBase}/login?${query.toString()}`
}
