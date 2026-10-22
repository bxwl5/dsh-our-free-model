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

/**
 * 归一 Cookie 串。
 *
 * 只做形状检查：必须含 `ot_session=`，且清理换行（浏览器复制常带）。
 */
export function normalizeCookie(raw: string): string | undefined {
  const trimmed = raw.replace(/[\r\n]+/g, ' ').trim()
  if (trimmed === '') return undefined
  if (!trimmed.includes(`${ORCATERM_SESSION_COOKIE}=`)) return undefined
  return trimmed
}

/** 判断凭据形状是否可用（不联网）。 */
export function isCredentialUsable(credential: OrcaTermCredential | undefined): credential is OrcaTermCredential {
  if (credential === undefined) return false
  const cookie = credential.access_token
  return typeof cookie === 'string' && cookie !== '' && cookie.includes(`${ORCATERM_SESSION_COOKIE}=`)
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
