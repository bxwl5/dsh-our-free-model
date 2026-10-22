/**
 * KukuAI 凭据与协议纯函数。
 *
 * ## 与其它 Cookie 渠道的差别
 *
 * KukuAI 的登录态是 **BDUSS**（百度账号体系），不是自建会话 Cookie。
 * 用户在浏览器登录 kuku.baidu.com 后，Cookie 里会带 `BDUSS=…`。
 *
 * ## 对话是「建消息 → SSE」两步
 *
 * 1. `POST /wenchain/genflowpro/sendmsg` 建一条消息（返回 session/reply id）；
 * 2. `GET/POST /wenchain/genflowpro/sse/getchatcontent` 读 SSE 正文。
 */

import {
  KUKU_CHANNEL,
  KUKU_CLIENT_TYPE,
  KUKU_PROTOCOL_V,
  KUKU_SESSION_COOKIE,
  KUKU_VERSION,
  type KukuProduct,
} from './kuku-product.js'

/** KukuAI 凭据。 */
export interface KukuCredential {
  /** 完整 Cookie 串。 */
  access_token: string
  /** 账号标识（若有）。 */
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

/**
 * 归一 Cookie 串。
 *
 * 百度账号的登录态字段是 `BDUSS`；必须含它才可能有效。
 */
export function normalizeCookie(raw: string): string | undefined {
  const trimmed = raw.replace(/[\r\n]+/g, ' ').trim()
  if (trimmed === '') return undefined
  if (!trimmed.includes(`${KUKU_SESSION_COOKIE}=`)) return undefined
  return trimmed
}

/** 判断凭据形状是否可用（不联网）。 */
export function isCredentialUsable(credential: KukuCredential | undefined): credential is KukuCredential {
  if (credential === undefined) return false
  const cookie = credential.access_token
  return typeof cookie === 'string' && cookie !== '' && cookie.includes(`${KUKU_SESSION_COOKIE}=`)
}

/** 构造请求头。 */
export function kukuHeaders(product: KukuProduct, credential: KukuCredential): Record<string, string> {
  return {
    Accept: 'application/json',
    Referer: `${product.apiBase}/`,
    Origin: product.apiBase,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Cookie: credential.access_token,
  }
}

/**
 * 构造 sendmsg 的请求体。
 *
 * 字段名与嵌套结构照官方 PC 客户端（kuku2api 实测记录）。
 * `client_added` 是**字符串化的 JSON**，不是嵌套对象 —— 写成对象会被上游拒。
 */
export function buildSendmsgBody(options: {
  text: string
  model: string
  sessionId: string
  replyId: string
  clientSessionId: string
  deviceId: string
  thinkMode?: number
}): Record<string, unknown> {
  const textBlock = { id: 'textId', version: '1.0', type: 'text', text: options.text, data: { content: options.text } }
  return {
    type: 'message',
    sub_type: 'chat_create',
    client_session_id: options.clientSessionId,
    session_id: options.sessionId,
    reply_id: options.replyId,
    uk: '',
    cid: 0,
    channel: KUKU_CHANNEL,
    device_type: Number(KUKU_CLIENT_TYPE),
    created_at: Date.now(),
    msg_type: 1,
    sync_type: 0,
    sync_id: '',
    v: KUKU_PROTOCOL_V,
    data: {
      project_type: 1,
      text: options.text,
      rich_input_params: [textBlock],
      fsid: [],
      quotes: [],
      skills: [],
      experts: [],
      model_name: options.model,
      model_display_name: options.model,
      think_mode: options.thinkMode ?? 0,
      show_text: '',
      device_id: options.deviceId,
      premake_data: {},
      custom_instructions: '',
      memory_sign: false,
      skill_dig_sign: false,
      // ⚠️ 必须是字符串化 JSON，不是嵌套对象。
      client_added: JSON.stringify({
        client_session_id: options.clientSessionId,
        permission_type: 0,
        clienttype: KUKU_CLIENT_TYPE,
        version: KUKU_VERSION,
        device_os: 'windows',
      }),
    },
  }
}

/**
 * 解析一帧 SSE。
 *
 * 上游帧形态（kuku2api 实测）：
 * - `data: {json}` —— 正文/思考增量
 * - `data: [DONE]` —— 结束
 *
 * 返回 `undefined` 表示无关帧。
 */
export function parseSseFrame(
  data: string,
): { kind: 'delta'; text?: string; reasoning?: string } | { kind: 'done' } | { kind: 'error'; message: string } | undefined {
  const trimmed = data.trim()
  if (trimmed === '') return undefined
  if (trimmed === '[DONE]') return { kind: 'done' }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const code = parsed.errno ?? parsed.code
  if (typeof code === 'number' && code !== 0) {
    return { kind: 'error', message: stringValue(parsed.errmsg) ?? stringValue(parsed.msg) ?? `errno=${code}` }
  }
  // 正文可能在 content / text / data.content 里。
  const dataObj = isRecord(parsed.data) ? parsed.data : undefined
  const text = stringValue(parsed.content) ?? stringValue(parsed.text) ?? (dataObj === undefined ? undefined : stringValue(dataObj.content))
  const reasoning = stringValue(parsed.reasoning_content) ?? stringValue(parsed.reasoningContent)
  if (reasoning !== undefined) return { kind: 'delta', reasoning }
  if (text !== undefined) return { kind: 'delta', text }
  return undefined
}

/**
 * 把 harness 消息拍平成单条输入。
 *
 * 与 OrcaTerm 同口径：上游一次只收一条 `text`，历史必须拍平。
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
