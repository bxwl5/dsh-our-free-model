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
 * - 会话字段 `BDUSS` 按 cookie 对精确匹配 —— 值里内嵌同名不算数
 *   （`xBDUSS=…` 这种粘连串拒绝）；
 * - 会话值长度 20–4096：真实 session token 至少几十字符，`abc` 这种长度
 *   只可能是误粘贴或占位值，收下也只会换来一次上游 401；
 * - 字符集限可打印 ASCII：中文、制表符、控制字符一律拒绝；
 * - 噪声清洗：折叠换行（浏览器多行复制）、剥 `Cookie:` 头名 / `Bearer `
 *   前缀（误当成令牌粘贴）/ 成对引号、剥尾部 Set-Cookie 属性段。
 *   BDUSS 实测 192 字符，下限 20 对真实值足够宽松。
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
  const prefix = `${KUKU_SESSION_COOKIE}=`
  const hit = text.split(';').find(part => part.trim().startsWith(prefix))
  if (hit === undefined) return undefined
  const value = hit.trim().slice(prefix.length).trim()
  if (value.length < SESSION_VALUE_MIN || value.length > SESSION_VALUE_MAX) return undefined
  if (!/^[\x21-\x7E]+$/.test(value)) return undefined
  return text
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
