/**
 * OrcaTerm 凭据与协议纯函数。
 *
 * 与 MonkeyCode 同为 Cookie 会话渠道，但对话协议不同：
 * OrcaTerm 是「建会话 → SSE」，可以完整实现推理。
 *
 * ## SSE 帧的两种非 JSON 形态（必须处理）
 *
 * 实测（Agent2API 记录）：
 * - 结束帧：`data: [DONE]`
 * - 错误帧：`data: [ERROR]: [LLM_ERROR]: …` —— **不是 JSON**，
 *   直接 JSON.parse 会抛错，被当成传输故障
 */

import {
  ORCATERM_SESSION_COOKIE,
  ORCATERM_SESSION_COOKIES,
  type OrcaTermProduct,
} from './orcaterm-product.js'

/** OrcaTerm 凭据。 */
export interface OrcaTermCredential {
  /** 完整 Cookie 串（原样透传）。 */
  access_token: string
  /** 账号标识（若有）。 */
  account_id?: string
  /** 昵称。 */
  nickname?: string
  /** 创建时间（毫秒时间戳）。 */
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
 * - 会话字段 `ot_session` 按 cookie 对精确匹配 —— 值里内嵌同名不算数
 *   （`xot_session=…` 这种粘连串拒绝）；
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
  // 会话字段按候选名逐个试（`ot_session` 旧名 / `ot_sid` 现名）。
  // 精确到 `name=` 前缀，避免 `xot_session=` 这类粘连串被误认。
  let value: string | undefined
  for (const name of ORCATERM_SESSION_COOKIES) {
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

/** 判断凭据形状是否可用（不联网）。 */
export function isCredentialUsable(credential: OrcaTermCredential | undefined): credential is OrcaTermCredential {
  if (credential === undefined) return false
  const cookie = credential.access_token
  if (typeof cookie !== 'string' || cookie === '') return false
  return ORCATERM_SESSION_COOKIES.some(name => cookie.includes(`${name}=`))
}

/** 构造请求头。 */
export function orcaTermHeaders(product: OrcaTermProduct, credential: OrcaTermCredential): Record<string, string> {
  return {
    Accept: 'application/json',
    Referer: `${product.consoleBase}/terminal`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Cookie: credential.access_token,
  }
}

/**
 * 解析一帧 SSE 数据。
 *
 * 返回：
 * - `{ kind: 'delta', text, reasoning }` —— 正文/思考增量
 * - `{ kind: 'done' }` —— 结束
 * - `{ kind: 'error', message }` —— 上游错误帧
 * - `undefined` —— 无关帧（空行、心跳、无内容）
 *
 * ⚠️ 错误帧 `data: [ERROR]: [LLM_ERROR]: …` **不是 JSON**，
 * 必须先按前缀识别再尝试 JSON 解析。
 */
export function parseChatFrame(
  data: string,
): { kind: 'delta'; text?: string; reasoning?: string } | { kind: 'done' } | { kind: 'error'; message: string } | undefined {
  const trimmed = data.trim()
  if (trimmed === '') return undefined
  if (trimmed === '[DONE]') return { kind: 'done' }
  // 上游错误帧：`[ERROR]: [LLM_ERROR]: …`（不是 JSON）。
  if (trimmed.startsWith('[ERROR]')) {
    return { kind: 'error', message: trimmed.replace(/^\[ERROR\]:?\s*/, '') }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // 既不是 [DONE]、也不是 [ERROR]、也不是 JSON —— 忽略，不要当成故障。
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  // 上游错误也可能藏在 JSON 里（code !== 0）。
  const code = parsed.code
  if (typeof code === 'number' && code !== 0) {
    const message = stringValue(parsed.msg) ?? stringValue(parsed.message) ?? `上游返回 code=${code}`
    return { kind: 'error', message }
  }
  // 思考增量：`reasoning: true` 表示这一帧是思考。
  const isReasoning = parsed.reasoning === true
  const content = stringValue(parsed.content)
  const reasoningContent = stringValue(parsed.reasoningContent)
  if (isReasoning) {
    const text = reasoningContent ?? content
    return text === undefined ? undefined : { kind: 'delta', reasoning: text }
  }
  const text = content ?? reasoningContent
  return text === undefined ? undefined : { kind: 'delta', text }
}

/**
 * 把 harness 消息拍平成上游要的单条输入。
 *
 * ⚠️ 上游的输入通道只有一条 `start` 消息，历史必须拍平（与 KukuAI 同口径）。
 * 角色用 `## system` / `## user` / `## assistant` 标记，保持可读。
 */
export function flattenMessages(
  messages: readonly { role: string; content: unknown }[],
  system?: string,
): string {
  const parts: string[] = []
  if (system !== undefined && system.trim() !== '') parts.push(`## system\n${system.trim()}`)
  for (const message of messages) {
    const text = contentToText(message.content)
    if (text.trim() === '') continue
    const role = message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user'
    parts.push(`## ${role}\n${text.trim()}`)
  }
  return parts.join('\n\n')
}

/** 从 harness 内容块里抽纯文本（忽略图片等非文本块）。 */
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
