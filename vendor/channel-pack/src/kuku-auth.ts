/**
 * KukuAI 对话 API：建消息 → SSE 流式。
 *
 * 两步协议（kuku2api 实测）：
 * 1. `POST /wenchain/genflowpro/sendmsg` 建消息，返回 `session_id` / `reply_id`；
 * 2. `POST /wenchain/genflowpro/sse/getchatcontent` 读 SSE 正文。
 *
 * ## 每轮新建 session
 *
 * 与 OrcaTerm 同因：上游按 sessionId 留存历史，而 OpenAI 客户端每轮自带
 * 全量 messages。复用会话会让历史翻倍，故每轮新建。
 */

import { randomUUID } from 'node:crypto'

import {
  KUKU_SENDMSG_PATH,
  KUKU_SSE_PATH,
  KUKU_VIP_REMAIN_PATH,
  type KukuProduct,
} from './kuku-product.js'
import {
  buildSendmsgBody,
  flattenMessages,
  isCredentialUsable,
  kukuHeaders,
  parseSseFrame,
  type KukuCredential,
} from './kuku.js'

/** 对话选项。 */
export interface ChatOptions {
  model: string
  messages: readonly { role: string; content: unknown }[]
  system?: string
  signal?: AbortSignal
  /** 思考档位（0 = 关闭）。 */
  thinkMode?: number
}

/** 从任意响应里抽 session/reply id（字段名可能是驼峰或下划线）。 */
function pickId(body: unknown, ...keys: string[]): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value
  }
  // 有些实现套一层 data。
  const data = record.data
  if (typeof data === 'object' && data !== null) return pickId(data, ...keys)
  return undefined
}

/**
 * 跑一轮流式对话（异步生成器）。
 */
export async function* streamChat(
  fetcher: typeof fetch,
  product: KukuProduct,
  credential: KukuCredential,
  options: ChatOptions,
): AsyncGenerator<{ text?: string; reasoning?: string }, void, undefined> {
  if (!isCredentialUsable(credential)) {
    throw new Error('KukuAI：没有可用凭据，请先粘贴含 BDUSS 的 Cookie')
  }

  const sessionId = randomUUID()
  const replyId = randomUUID()
  const clientSessionId = randomUUID()
  // device_id 是客户端自报的数字 id；用时间戳派生一个稳定的长整数。
  const deviceId = String(Date.now())

  const sendResponse = await fetcher(`${product.apiBase}${KUKU_SENDMSG_PATH}`, {
    method: 'POST',
    headers: { ...kukuHeaders(product, credential), 'Content-Type': 'application/json' },
    body: JSON.stringify(buildSendmsgBody({
      text: flattenMessages(options.messages, options.system),
      model: options.model,
      sessionId,
      replyId,
      clientSessionId,
      deviceId,
      ...(options.thinkMode === undefined ? {} : { thinkMode: options.thinkMode }),
    })),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (!sendResponse.ok) {
    const text = await sendResponse.text().catch(() => '')
    throw new Error(`KukuAI：建消息返回 HTTP ${sendResponse.status}${text === '' ? '' : `：${text.slice(0, 200)}`}`)
  }
  const sendBody: unknown = await sendResponse.json().catch(() => undefined)
  // 上游可能回新的 session/reply id；取不到就用本地生成的。
  const actualSession = pickId(sendBody, 'session_id', 'sessionId') ?? sessionId
  const actualReply = pickId(sendBody, 'reply_id', 'replyId') ?? replyId

  const query = new URLSearchParams({
    session_id: actualSession,
    reply_id: actualReply,
    client_session_id: clientSessionId,
    device_id: deviceId,
  }).toString()
  const sseResponse = await fetcher(`${product.apiBase}${KUKU_SSE_PATH}?${query}`, {
    method: 'POST',
    headers: {
      ...kukuHeaders(product, credential),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ session_id: actualSession, reply_id: actualReply, msg_id: '' }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (!sseResponse.ok) {
    const text = await sseResponse.text().catch(() => '')
    throw new Error(`KukuAI：流式接口返回 HTTP ${sseResponse.status}${text === '' ? '' : `：${text.slice(0, 200)}`}`)
  }
  if (sseResponse.body === null) throw new Error('KukuAI：流式响应没有正文')

  const reader = sseResponse.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line.startsWith('data:')) continue
        const frame = parseSseFrame(line.slice(5))
        if (frame === undefined) continue
        if (frame.kind === 'done') return
        if (frame.kind === 'error') throw new Error(`KukuAI 上游错误：${frame.message}`)
        yield frame
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
}

/**
 * 探活：调 VIP 剩余额度接口看状态码。
 *
 * 选它是因为它是最轻量的鉴权探针（不需要建会话、不消耗额度）。
 */
export async function probeCredential(
  fetcher: typeof fetch,
  product: KukuProduct,
  credential: KukuCredential,
  signal?: AbortSignal,
): Promise<'valid' | 'expired' | 'network_error'> {
  if (!isCredentialUsable(credential)) return 'expired'
  try {
    const response = await fetcher(`${product.apiBase}${KUKU_VIP_REMAIN_PATH}`, {
      method: 'GET',
      headers: kukuHeaders(product, credential),
      ...(signal === undefined ? {} : { signal }),
    })
    void response.body?.cancel().catch(() => undefined)
    if (response.status === 401 || response.status === 403) return 'expired'
    return response.ok ? 'valid' : 'network_error'
  } catch {
    return 'network_error'
  }
}
