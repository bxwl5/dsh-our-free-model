/**
 * OrcaTerm 对话 API：建会话 → SSE 流式。
 *
 * 上游是两步：
 * 1. `POST {lightai}/assistant/conversation` 建会话（带 uuid/title/ts/tags）；
 * 2. `POST {lightai}/assistant/chat?name=orcaterm&mode=0&…` 发消息读 SSE。
 *
 * ## 每轮新建会话
 *
 * 上游按 conversationId 在服务端留存历史，但 OpenAI 客户端每轮自带全量
 * messages。若复用会话，历史会**翻倍**（服务端记一份 + 客户端再发一份）。
 * 故每轮新建会话，把历史拍平进单条输入。
 */

import { randomUUID } from 'node:crypto'

import {
  ORCATERM_CHAT_PATH,
  ORCATERM_CHAT_QUERY,
  ORCATERM_CONVERSATION_PATH,
  ORCATERM_CONVERSATION_TAG,
  type OrcaTermProduct,
} from './orcaterm-product.js'
import {
  flattenMessages,
  isCredentialUsable,
  orcaTermHeaders,
  parseChatFrame,
  type OrcaTermCredential,
} from './orcaterm.js'

/** 流式对话的选项。 */
export interface ChatOptions {
  /** 模型 id。 */
  model: string
  /** harness 消息。 */
  messages: readonly { role: string; content: unknown }[]
  /** 系统提示。 */
  system?: string
  /** 取消信号。 */
  signal?: AbortSignal
}

/** 建会话。返回 conversationId。 */
async function createConversation(
  fetcher: typeof fetch,
  product: OrcaTermProduct,
  credential: OrcaTermCredential,
  signal?: AbortSignal,
): Promise<string> {
  const id = randomUUID()
  const response = await fetcher(`${product.lightaiBase}${ORCATERM_CONVERSATION_PATH}`, {
    method: 'POST',
    headers: {
      ...orcaTermHeaders(product, credential),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id,
      title: '新对话',
      ts: Date.now(),
      customTitle: '',
      aiTitle: '',
      tags: [ORCATERM_CONVERSATION_TAG],
    }),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    throw new Error(`OrcaTerm：建会话返回 HTTP ${response.status}`)
  }
  // ⚠️ 上游的业务错误走 **HTTP 200 + body 的 `code`**（不是非 2xx）：
  // 实测 `VERIFY_SKEY_UIN_FAILED` 就是 `{code:500, message:"VERIFY_SKEY_UIN_FAILED"}`，
  // 只看 response.ok 会把它当成功，最后表现成「对话返回空」而看不出原因
  //（2026-10-25 实测）。故先探一次 body。
  const raw = await response.text().catch(() => '')
  let parsed: unknown
  try { parsed = raw === '' ? undefined : JSON.parse(raw) } catch { parsed = undefined }
  if (parsed !== undefined && typeof parsed === 'object' && parsed !== null) {
    const record = parsed as Record<string, unknown>
    const code = typeof record.code === 'number' ? record.code : undefined
    const message = typeof record.message === 'string' ? record.message : ''
    if (code !== undefined && code !== 0) {
      // skey 失效是凭据问题，归因到「重新登录」而不是笼统的上游错误。
      if (/VERIFY_SKEY|UIN|SESSION|TOKEN|AUTH/i.test(message)) {
        throw new Error(`OrcaTerm：登录态已失效（${message || code}）—— 请重新粘贴 Cookie`)
      }
      throw new Error(`OrcaTerm：建会话被上游拒绝（code ${code}）${message === '' ? '' : `：${message}`}`)
    }
  }
  // 上游回 `{code:0, data:{…}}`；conversationId 的形态是 `cid-<uuid>-orcaterm`。
  // 实测上游接受直接拼出的 cid（与返回的 id 一致），故不强依赖响应体字段。
  return `cid-${id}-${ORCATERM_CONVERSATION_TAG}`
}

/**
 * 跑一轮流式对话，**以异步生成器形式**逐帧产出增量。
 *
 * 用生成器而不是回调：调用方（适配器）本身就要产出 `StreamChunk`，
 * 生成器可以直接 `yield*`，不需要中间队列 + 轮询。
 *
 * 错误帧抛错（带上游原文），正常 `[DONE]` 正常返回。
 */
export async function* streamChat(
  fetcher: typeof fetch,
  product: OrcaTermProduct,
  credential: OrcaTermCredential,
  options: ChatOptions,
): AsyncGenerator<{ text?: string; reasoning?: string }, void, undefined> {
  if (!isCredentialUsable(credential)) {
    throw new Error('OrcaTerm：没有可用凭据，请先粘贴 Cookie')
  }
  const conversationId = await createConversation(fetcher, product, credential, options.signal)

  const query = new URLSearchParams(ORCATERM_CHAT_QUERY as unknown as Record<string, string>).toString()
  const response = await fetcher(`${product.lightaiBase}${ORCATERM_CHAT_PATH}?${query}`, {
    method: 'POST',
    headers: {
      ...orcaTermHeaders(product, credential),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      conversationId,
      user: { model: options.model },
      input: {
        type: 'start',
        input: flattenMessages(options.messages, options.system),
        id: randomUUID(),
      },
      stream: true,
    }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`OrcaTerm：对话返回 HTTP ${response.status}${text === '' ? '' : `：${text.slice(0, 200)}`}`)
  }
  // 与 createConversation 同因：上游业务错误走 HTTP 200 + body 的 code
  //（`VERIFY_SKEY_UIN_FAILED` 即此形态）。这里 content-type 已是 JSON，
  // 说明不是 SSE 流，直接按错误体读。
  const contentType = response.headers.get('content-type') ?? ''
  if (/application\/json/i.test(contentType)) {
    const text = await response.text().catch(() => '')
    let parsed: unknown
    try { parsed = text === '' ? undefined : JSON.parse(text) } catch { parsed = undefined }
    if (parsed !== undefined && typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>
      const code = typeof record.code === 'number' ? record.code : undefined
      const message = typeof record.message === 'string' ? record.message : ''
      if (code !== undefined && code !== 0) {
        if (/VERIFY_SKEY|UIN|SESSION|TOKEN|AUTH/i.test(message)) {
          throw new Error(`OrcaTerm：登录态已失效（${message || code}）—— 请重新粘贴 Cookie`)
        }
        throw new Error(`OrcaTerm：对话被上游拒绝（code ${code}）${message === '' ? '' : `：${message}`}`)
      }
    }
  }
  if (response.body === null) throw new Error('OrcaTerm：对话响应没有正文')

  const reader = response.body.getReader()
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
        const frame = parseChatFrame(line.slice(5))
        if (frame === undefined) continue
        if (frame.kind === 'done') return
        if (frame.kind === 'error') throw new Error(`OrcaTerm 上游错误：${frame.message}`)
        yield frame
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
}

/**
 * 探活：能否建会话。
 *
 * 建会话是唯一无需模型的轻量校验；401 说明 Cookie 失效。
 */
export async function probeCredential(
  fetcher: typeof fetch,
  product: OrcaTermProduct,
  credential: OrcaTermCredential,
  signal?: AbortSignal,
): Promise<'valid' | 'expired' | 'network_error'> {
  if (!isCredentialUsable(credential)) return 'expired'
  try {
    const response = await fetcher(`${product.lightaiBase}${ORCATERM_CONVERSATION_PATH}`, {
      method: 'POST',
      headers: { ...orcaTermHeaders(product, credential), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: randomUUID(), title: '探活', ts: Date.now(),
        customTitle: '', aiTitle: '', tags: [ORCATERM_CONVERSATION_TAG],
      }),
      ...(signal === undefined ? {} : { signal }),
    })
    void response.body?.cancel().catch(() => undefined)
    if (response.status === 401 || response.status === 403) return 'expired'
    return response.ok ? 'valid' : 'network_error'
  } catch {
    return 'network_error'
  }
}
