/**
 * MonkeyCode WebSocket 传输层（手写 RFC 6455 客户端，**零依赖**）。
 *
 * ## 为什么手写
 *
 * MonkeyCode 的对话正文只从 `WS /api/v1/users/tasks/stream` 下发。本插件
 * 零依赖（只有 jose / undici / typescript 三个 devDeps），不能引入 `ws`，
 * 所以这里实现客户端需要的最小 RFC 6455 子集：
 *
 * | 能力 | 说明 |
 * |---|---|
 * | 握手 | `node:http(s).request()` + `upgrade` 事件，校验 `Sec-WebSocket-Accept` |
 * | 帧解析 | opcode / FIN / mask / 7bit·126·127 长度 / 掩码解码 |
 * | 帧写入 | 客户端帧**必须掩码**（RFC 6455 §5.3），服务端帧不掩码 |
 * | 控制帧 | 收到 ping 自动回 pong；收到 close 回 close 并结束 |
 * | 流式读取 | 增量缓冲，TCP 拆包/粘包由调用方无感 |
 *
 * ## 为什么单独一个模块
 *
 * 传输层不碰任何 MonkeyCode 业务语义（任务 id、事件 JSON 都在别处），
 * 因此可以用一个本地 `node:http` 服务器完整单测：握手向量、小帧、
 * 126 扩展长度帧、掩码、ping/pong、拆包，全部不出网。
 *
 * ## 已知边界
 *
 * - 不走插件的网络出口（`network.fetch` 的代理链）：Node 的 `http.request`
 *   直连目标主机。若用户依赖 HTTP 代理访问上游，WS 会失败（见 adapter 头注释）。
 * - 不实现压缩扩展（`permessage-deflate`）：握手不声明，服务端不会启用。
 * - 不实现分片消息重组（continuation 帧忽略）：上游 JSON 事件均单帧下发。
 */

import { createHash, randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'

/** RFC 6455 握手魔数。 */
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 帧操作码。 */
export const WS_OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const

/** 单帧负载上限（16 MiB，与参考实现一致）。超过视为协议错误。 */
export const WS_MAX_PAYLOAD = 16 * 1024 * 1024

/**
 * 计算 `Sec-WebSocket-Accept`。
 *
 * `base64(SHA1(key + GUID))` —— RFC 6455 §4.2.2。
 */
export function wsAcceptKey(key: string): string {
  return createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
}

/** 生成客户端握手 key（16 随机字节的 base64）。 */
export function createWsKey(): string {
  return randomBytes(16).toString('base64')
}

/** 一帧解出来的内容。 */
export interface WsFrame {
  /** FIN 位：是否为消息的最后一帧。 */
  fin: boolean
  /** 操作码（1=text / 2=binary / 8=close / 9=ping / 10=pong）。 */
  opcode: number
  /** 已解掩码的负载。 */
  payload: Buffer
}

/** 一次解析的结果：一帧 + 它占用的字节数。 */
export interface ParsedFrame {
  frame: WsFrame
  /** 本帧在缓冲区里占用的总字节数（头部 + 扩展长度 + 掩码 + 负载）。 */
  consumed: number
}

/**
 * 从缓冲区头部尝试解出一帧。
 *
 * 返回 `undefined` 表示**数据还不够**（调用方继续等下一个 TCP 包）；
 * 数据足够但帧非法（负载超限）时抛错。
 *
 * 该函数是纯函数：不持有状态、不消费缓冲区，便于单测。
 */
export function parseFrame(buffer: Buffer, maxPayload: number = WS_MAX_PAYLOAD): ParsedFrame | undefined {
  if (buffer.length < 2) return undefined
  const first = buffer[0]!
  const second = buffer[1]!
  const fin = (first & 0x80) !== 0
  const opcode = first & 0x0f
  const masked = (second & 0x80) !== 0
  let length = second & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return undefined
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return undefined
    const big = buffer.readBigUInt64BE(2)
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('ws frame length exceeds Number.MAX_SAFE_INTEGER')
    length = Number(big)
    offset = 10
  }
  if (length > maxPayload) throw new RangeError(`ws frame too large: ${length} > ${maxPayload}`)
  let maskKey: Buffer | undefined
  if (masked) {
    if (buffer.length < offset + 4) return undefined
    maskKey = buffer.subarray(offset, offset + 4)
    offset += 4
  }
  if (buffer.length < offset + length) return undefined
  const payload = Buffer.from(buffer.subarray(offset, offset + length))
  if (maskKey !== undefined) {
    for (let index = 0; index < payload.length; index += 1) payload[index] = payload[index]! ^ maskKey[index & 3]!
  }
  return { frame: { fin, opcode, payload }, consumed: offset + length }
}

/**
 * 构造一帧。
 *
 * `mask` 默认 **true**：RFC 6455 规定客户端发往服务端的每一帧都必须掩码。
 * 服务端（测试夹具）构造下行帧时显式传 `{ mask: false }`。
 */
export function encodeFrame(
  opcode: number,
  payload: Buffer | Uint8Array | string,
  options: { mask?: boolean; fin?: boolean } = {},
): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload)
  const fin = options.fin !== false
  const mask = options.mask !== false
  const head: number[] = [(fin ? 0x80 : 0) | (opcode & 0x0f)]
  const maskBit = mask ? 0x80 : 0
  if (body.length < 126) {
    head.push(body.length | maskBit)
  } else if (body.length <= 0xffff) {
    head.push(126 | maskBit, (body.length >>> 8) & 0xff, body.length & 0xff)
  } else {
    head.push(127 | maskBit)
    const length = BigInt(body.length)
    for (let shift = 7; shift >= 0; shift -= 1) head.push(Number((length >> BigInt(shift * 8)) & 0xffn))
  }
  const headBuffer = Buffer.from(head)
  if (!mask) return Buffer.concat([headBuffer, body])
  const maskKey = randomBytes(4)
  const masked = Buffer.allocUnsafe(body.length)
  for (let index = 0; index < body.length; index += 1) masked[index] = body[index]! ^ maskKey[index & 3]!
  return Buffer.concat([headBuffer, maskKey, masked])
}

/** 连接选项。 */
export interface WsConnectOptions {
  /** 额外请求头（Cookie / Origin / User-Agent 等）。 */
  headers?: Record<string, string>
  /** 取消信号：握手期与连接期都生效。 */
  signal?: AbortSignal
  /** 握手超时（毫秒，默认 15s）。 */
  handshakeTimeoutMs?: number
  /** 读空闲超时（毫秒，默认 120s；0 表示禁用）。 */
  idleTimeoutMs?: number
  /** 单帧负载上限（默认 16 MiB）。 */
  maxPayload?: number
}

/** 一条上游消息（已解帧、已解掩码）。 */
export interface WsMessage {
  /** 1=text / 2=binary。 */
  opcode: number
  /** 按 UTF-8 解出的文本（binary 帧也按 UTF-8 解，上游可能用 binary 发 JSON）。 */
  text: string
  /** 原始负载。 */
  data: Buffer
}

/**
 * 字节读取器：把 `Socket` 的 data/end/error 事件转成可 await 的队列。
 *
 * 不直接用 `socket[Symbol.asyncIterator]()`：每次调用都会新建迭代器，
 * 而流只能被一个消费者读，多个迭代器会互相抢数据。
 */
class SocketReader {
  private readonly queue: Buffer[] = []
  private ended = false
  private failure: unknown
  private notify: (() => void) | undefined
  private readonly detach: () => void

  constructor(socket: Socket, initial: Buffer, idleTimeoutMs: number) {
    if (initial.length > 0) this.queue.push(initial)
    const onData = (chunk: Buffer): void => { this.queue.push(chunk); this.wake() }
    const onEnd = (): void => { this.ended = true; this.wake() }
    const onClose = (): void => { this.ended = true; this.wake() }
    const onError = (error: Error): void => { this.failure = error; this.wake() }
    const onTimeout = (): void => {
      this.failure = new Error(`ws idle timeout after ${idleTimeoutMs}ms`)
      this.wake()
      socket.destroy()
    }
    socket.on('data', onData)
    socket.on('end', onEnd)
    socket.on('close', onClose)
    socket.on('error', onError)
    if (idleTimeoutMs > 0) {
      socket.setTimeout(idleTimeoutMs)
      socket.on('timeout', onTimeout)
    }
    this.detach = (): void => {
      socket.off('data', onData)
      socket.off('end', onEnd)
      socket.off('close', onClose)
      socket.off('error', onError)
      socket.off('timeout', onTimeout)
      if (idleTimeoutMs > 0) socket.setTimeout(0)
    }
  }

  private wake(): void {
    const notify = this.notify
    this.notify = undefined
    notify?.()
  }

  /** 取下个字节块；流正常结束返回 `undefined`，出错抛错。 */
  async read(): Promise<Buffer | undefined> {
    for (;;) {
      const chunk = this.queue.shift()
      if (chunk !== undefined) return chunk
      if (this.failure !== undefined) throw this.failure
      if (this.ended) return undefined
      await new Promise<void>((resolve) => { this.notify = resolve })
    }
  }

  dispose(): void {
    this.detach()
  }
}

/**
 * 一条已建立的 WebSocket 连接。
 *
 * 只暴露对话需要的最小面：读消息、回 pong、发 close、销毁。
 */
export class MonkeyCodeWsClient {
  private readonly reader: SocketReader
  private readonly maxPayload: number
  private readonly removeAbort: (() => void) | undefined
  private closed = false

  constructor(
    private readonly socket: Socket,
    initial: Buffer,
    options: WsConnectOptions = {},
  ) {
    this.maxPayload = options.maxPayload ?? WS_MAX_PAYLOAD
    this.reader = new SocketReader(socket, initial, options.idleTimeoutMs ?? 120_000)
    const signal = options.signal
    if (signal !== undefined) {
      const onAbort = (): void => { this.destroy(new Error('ws aborted')) }
      if (signal.aborted) onAbort()
      else {
        signal.addEventListener('abort', onAbort, { once: true })
        this.removeAbort = (): void => { signal.removeEventListener('abort', onAbort) }
      }
    }
  }

  /**
   * 逐帧读取**原始帧**（含 ping / pong / close 控制帧），不做任何自动应答。
   *
   * ⚠️ 需要自动回 pong、按 close 优雅收尾时用 {@link messages}；
   * 直接消费本方法必须自己处理控制帧，否则对端会因收不到 pong 而断开。
   */
  async *frames(): AsyncGenerator<WsFrame> {
    let buffer = Buffer.alloc(0)
    try {
      for (;;) {
        const chunk = await this.reader.read()
        if (chunk === undefined) {
          // 流在帧中途结束属于传输错误；干净的 EOF（缓冲区为空）当正常结束。
          if (buffer.length > 0) throw new Error(`ws stream ended mid-frame (${buffer.length} trailing bytes)`)
          return
        }
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
        let parsed: ParsedFrame | undefined
        while ((parsed = parseFrame(buffer, this.maxPayload)) !== undefined) {
          buffer = buffer.subarray(parsed.consumed)
          yield parsed.frame
        }
      }
    } finally {
      this.reader.dispose()
    }
  }

  /** 逐条读取上游消息（text / binary）。 */
  async *messages(): AsyncGenerator<WsMessage> {
    for await (const frame of this.frames()) {
      if (frame.opcode === WS_OPCODE.ping) {
        this.sendPong(frame.payload)
        continue
      }
      if (frame.opcode === WS_OPCODE.pong) continue
      if (frame.opcode === WS_OPCODE.close) {
        // ⚠️ 必须用 close() 而不是 sendClose() + destroy()：
        // socket.write() 只是把数据排进缓冲，而 socket.destroy() 会**丢弃**
        // 尚未刷出的缓冲 —— 于是 close 回复发不到对端，对端只能看到连接被
        // 粗暴断开（本缺陷由 monkeycode-ws-test 的「收到 close 要回 close」用例捕获）。
        // close() 走 socket.end()，会先刷出再优雅关闭。
        this.close()
        return
      }
      if (frame.opcode === WS_OPCODE.text || frame.opcode === WS_OPCODE.binary) {
        yield { opcode: frame.opcode, text: frame.payload.toString('utf8'), data: frame.payload }
        continue
      }
      // continuation 与未知控制帧：忽略（上游事件都是单帧下发）。
    }
  }

  /** 回 pong（RFC 6455 §5.5.3：pong 必须回带 ping 的负载）。 */
  sendPong(payload: Buffer = Buffer.alloc(0)): void {
    this.write(WS_OPCODE.pong, payload)
  }

  /** 发送 close 帧（默认 1000 normal closure）。 */
  sendClose(code: number = 1000): void {
    const payload = Buffer.alloc(2)
    payload.writeUInt16BE(code, 0)
    this.write(WS_OPCODE.close, payload)
  }

  /** 主动关闭：先发 close，再结束 socket。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    try { this.sendClose(1000) } catch { /* 对端已断开 */ }
    this.removeAbort?.()
    this.reader.dispose()
    if (!this.socket.destroyed) this.socket.end()
  }

  /** 立即销毁（取消、协议错误）。 */
  destroy(error?: Error): void {
    if (this.closed) return
    this.closed = true
    this.removeAbort?.()
    this.reader.dispose()
    if (!this.socket.destroyed) this.socket.destroy(error)
  }

  private write(opcode: number, payload: Buffer): void {
    if (this.socket.destroyed) return
    try {
      this.socket.write(encodeFrame(opcode, payload))
    } catch {
      // 对端已断开：写入失败不该盖住真正的读取错误。
    }
  }
}

/** 握手失败时抛出的错误（带 HTTP 状态，便于上层分类）。 */
export class WsHandshakeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'WsHandshakeError'
  }
}

/**
 * 建立一条 WebSocket 连接（RFC 6455 客户端握手）。
 *
 * 支持 `ws:` / `wss:`（也接受 `http:` / `https:`，等价映射）。
 * 握手响应的 `Sec-WebSocket-Accept` 必须与本地计算值逐字节相同，
 * 否则视为被中间人改写，直接拒绝。
 */
export function openWebSocket(url: string, options: WsConnectOptions = {}): Promise<MonkeyCodeWsClient> {
  return new Promise<MonkeyCodeWsClient>((resolve, reject) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      reject(new Error(`ws: invalid url "${url}"`))
      return
    }
    const secure = parsed.protocol === 'wss:' || parsed.protocol === 'https:'
    if (!secure && parsed.protocol !== 'ws:' && parsed.protocol !== 'http:') {
      reject(new Error(`ws: unsupported protocol "${parsed.protocol}"`))
      return
    }
    const key = createWsKey()
    const headers: Record<string, string> = {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
      ...(options.headers ?? {}),
    }
    const requestFn = secure ? httpsRequest : httpRequest
    const request = requestFn({
      protocol: secure ? 'https:' : 'http:',
      hostname: parsed.hostname,
      port: parsed.port === '' ? (secure ? 443 : 80) : Number(parsed.port),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      headers,
    })

    let settled = false
    const finish = (error: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      request.destroy()
      reject(error)
    }
    const onAbort = (): void => { finish(new Error('ws handshake aborted')) }
    const timer = setTimeout(
      () => { finish(new WsHandshakeError('ws handshake timed out')) },
      options.handshakeTimeoutMs ?? 15_000,
    )
    if (options.signal !== undefined) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    request.on('upgrade', (response: IncomingMessage, socket: Socket, head: Buffer) => {
      if (settled) {
        socket.destroy()
        return
      }
      const rawAccept = response.headers['sec-websocket-accept']
      const accept = Array.isArray(rawAccept) ? rawAccept[0] : rawAccept
      const expected = wsAcceptKey(key)
      if (accept !== expected) {
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        socket.destroy()
        reject(new WsHandshakeError('ws handshake rejected: Sec-WebSocket-Accept mismatch'))
        return
      }
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve(new MonkeyCodeWsClient(socket, head, options))
    })
    request.on('response', (response: IncomingMessage) => {
      response.resume()
      finish(new WsHandshakeError(`ws handshake failed: HTTP ${response.statusCode ?? 0}`, response.statusCode))
    })
    request.on('error', (error: Error) => { finish(error) })
    request.end()
  })
}

// ── 任务流事件解析（容错） ──

/**
 * 一条任务流事件的归一结果。
 *
 * 上游 WS 的事件语法参考实现自己承认「无法在无实机下 100% 敲定」，
 * 所以这里把「能认出来的」都归一成三种语义，认不出的静默忽略：
 * - `text`：有正文增量；
 * - `done`：流正常结束；
 * - `error`：上游报错或中止；
 * - `ignore`：无关帧（心跳、日志、未知类型）。
 */
export type TaskStreamEvent =
  | { kind: 'text'; text: string }
  | { kind: 'done' }
  | { kind: 'error'; message: string }
  | { kind: 'ignore' }

/** 结束类事件名。 */
const TERMINAL_TYPES = new Set(['done', 'finish', 'completed', 'error', 'abort'])
/** 可能携带正文的事件名。 */
const TEXT_TYPES = new Set(['round', 'message', 'assistant', 'delta', 'text', 'content', 'delta_text'])
/** 正文可能落在这些字段里（值是字符串，或再套一层对象）。 */
const TEXT_FIELDS = ['content', 'text', 'delta', 'message'] as const
/** 嵌套对象里再找这些字段。 */
const NESTED_TEXT_FIELDS = ['content', 'text', 'delta'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 从一个「字符串或对象」的值里抽正文。 */
function textFromValue(value: unknown): string | undefined {
  const direct = stringValue(value)
  if (direct !== undefined) return direct
  if (!isRecord(value)) return undefined
  for (const field of NESTED_TEXT_FIELDS) {
    const nested = stringValue(value[field])
    if (nested !== undefined) return nested
  }
  return undefined
}

/** 从事件对象里按优先级抽正文。 */
function extractText(record: Record<string, unknown>): string | undefined {
  for (const field of TEXT_FIELDS) {
    if (!(field in record)) continue
    const text = textFromValue(record[field])
    if (text !== undefined) return text
  }
  // 有些实现把正文套在 `data` 里（与 HTTP 接口的信封习惯一致）。
  if (isRecord(record.data)) {
    for (const field of TEXT_FIELDS) {
      if (!(field in record.data)) continue
      const text = textFromValue(record.data[field])
      if (text !== undefined) return text
    }
  }
  return undefined
}

/** 从任意字段里找错误消息。 */
function extractErrorMessage(record: Record<string, unknown>, type: string): string {
  const direct = stringValue(record.message) ?? stringValue(record.msg) ?? stringValue(record.error)
    ?? stringValue(record.reason) ?? stringValue(record.content)
  if (direct !== undefined) return direct
  if (isRecord(record.error)) {
    const nested = stringValue(record.error.message) ?? stringValue(record.error.msg) ?? stringValue(record.error.reason)
    if (nested !== undefined) return nested
  }
  if (isRecord(record.data)) {
    const nested = stringValue(record.data.message) ?? stringValue(record.data.msg) ?? stringValue(record.data.error)
    if (nested !== undefined) return nested
  }
  return `上游返回 ${type} 事件`
}

/**
 * 解析一帧任务流事件。
 *
 * 非 JSON、非对象、无 `type` 的帧一律 `ignore` —— 上游可能插日志行
 * 或心跳字符串，报错会让整轮对话因一个无关帧中断。
 */
export function parseTaskStreamEvent(raw: string | Buffer): TaskStreamEvent {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8')
  if (text.trim() === '') return { kind: 'ignore' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'ignore' }
  }
  if (!isRecord(parsed)) return { kind: 'ignore' }
  const type = stringValue(parsed.type) ?? stringValue(parsed.event) ?? stringValue(parsed.kind)
  if (type === undefined) {
    // 没有 type 但直接带正文的帧（少数实现如此）：仍然收下。
    const loose = extractText(parsed)
    return loose === undefined ? { kind: 'ignore' } : { kind: 'text', text: loose }
  }
  const normalized = type.toLowerCase()
  if (normalized === 'error' || normalized === 'abort') {
    return { kind: 'error', message: extractErrorMessage(parsed, normalized) }
  }
  if (TERMINAL_TYPES.has(normalized)) return { kind: 'done' }
  if (TEXT_TYPES.has(normalized)) {
    const body = extractText(parsed)
    return body === undefined ? { kind: 'ignore' } : { kind: 'text', text: body }
  }
  return { kind: 'ignore' }
}

/**
 * 把 HTTP 基址映射成 WebSocket 地址。
 *
 * `https` → `wss`，`http` → `ws`；已带 `ws(s)` 时原样使用。
 */
export function toWebSocketUrl(apiBase: string, path: string, query: Record<string, string> = {}): string {
  const base = new URL(apiBase)
  const protocol = base.protocol === 'https:' || base.protocol === 'wss:' ? 'wss:' : 'ws:'
  const url = new URL(path, `${protocol}//${base.host}`)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return url.toString()
}
