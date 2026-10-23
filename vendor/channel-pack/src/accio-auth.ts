/**
 * Accio API：OAuth 换 token、续期、模型目录、额度、SSE 推理。
 *
 * ⚠️ 所有调用都**不带 Authorization 头** —— token 走 query 或 body。
 */

import {
  ACCIO_GENERATE_PATH,
  ACCIO_LLM_CONFIG_PATH,
  ACCIO_QUOTA_PATH,
  ACCIO_REFRESH_PATH,
  ACCIO_TOKEN_PATH,
  ACCIO_USERINFO_PATH,
  type AccioProduct,
} from './accio-product.js'
import {
  accioHeaders,
  buildGenerateBody,
  isCredentialUsable,
  parseAdkFrame,
  parseTokenResponse,
  type AccioCredential,
} from './accio.js'

/** 用授权码换 token。 */
export async function exchangeCode(
  fetcher: typeof fetch,
  product: AccioProduct,
  code: string,
  verifier: string,
  redirectUri: string,
  signal?: AbortSignal,
): Promise<AccioCredential> {
  const response = await fetcher(`${product.gatewayBase}${ACCIO_TOKEN_PATH}`, {
    method: 'POST',
    headers: accioHeaders(product),
    body: JSON.stringify({
      code,
      codeVerifier: verifier,
      clientId: product.clientId,
      redirectUri,
    }),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new Error(`Accio：换 token 返回 HTTP ${response.status}`)
  const credential = parseTokenResponse(await response.json().catch(() => undefined))
  if (credential === undefined) throw new Error('Accio：换 token 响应缺少 accessToken')
  return credential
}

/** 续期。 */
export async function refreshCredential(
  fetcher: typeof fetch,
  product: AccioProduct,
  credential: AccioCredential,
  signal?: AbortSignal,
): Promise<AccioCredential | undefined> {
  if (credential.refresh_token === undefined) return undefined
  try {
    const response = await fetcher(`${product.gatewayBase}${ACCIO_REFRESH_PATH}`, {
      method: 'POST',
      headers: accioHeaders(product),
      body: JSON.stringify({
        accessToken: credential.access_token,
        refreshToken: credential.refresh_token,
      }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) return undefined
    const refreshed = parseTokenResponse(await response.json().catch(() => undefined))
    if (refreshed === undefined) return undefined
    // 续期响应可能不带 refresh_token —— 沿用旧的。
    return {
      ...refreshed,
      refresh_token: refreshed.refresh_token ?? credential.refresh_token,
      ...(credential.account_id === undefined ? {} : { account_id: credential.account_id }),
      ...(credential.nickname === undefined ? {} : { nickname: credential.nickname }),
    }
  } catch {
    return undefined
  }
}

/** 读用户资料（token 走 query）。 */
export async function fetchUserInfo(
  fetcher: typeof fetch,
  product: AccioProduct,
  credential: AccioCredential,
  signal?: AbortSignal,
): Promise<{ accountId?: string; nickname?: string } | undefined> {
  try {
    const query = new URLSearchParams({ accessToken: credential.access_token }).toString()
    const response = await fetcher(`${product.gatewayBase}${ACCIO_USERINFO_PATH}?${query}`, {
      method: 'GET',
      headers: accioHeaders(product),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) return undefined
    const body: unknown = await response.json().catch(() => undefined)
    if (typeof body !== 'object' || body === null) return undefined
    const record = body as Record<string, unknown>
    const data = typeof record.data === 'object' && record.data !== null ? record.data as Record<string, unknown> : record
    return {
      ...(typeof data.userId === 'string' ? { accountId: data.userId } : {}),
      ...(typeof data.nickname === 'string' ? { nickname: data.nickname } : {}),
    }
  } catch {
    return undefined
  }
}

/** 读额度。返回用量百分比（0–1）。 */
export async function fetchQuota(
  fetcher: typeof fetch,
  product: AccioProduct,
  credential: AccioCredential,
  signal?: AbortSignal,
): Promise<{ usedPercent?: number; resetAtMs?: number } | undefined> {
  try {
    const query = new URLSearchParams({ accessToken: credential.access_token }).toString()
    const response = await fetcher(`${product.gatewayBase}${ACCIO_QUOTA_PATH}?${query}`, {
      method: 'GET',
      headers: accioHeaders(product),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) return undefined
    const body: unknown = await response.json().catch(() => undefined)
    if (typeof body !== 'object' || body === null) return undefined
    const record = body as Record<string, unknown>
    const data = typeof record.data === 'object' && record.data !== null ? record.data as Record<string, unknown> : record
    const used = typeof data.usedPercent === 'number' ? data.usedPercent
      : typeof data.used_percent === 'number' ? data.used_percent
      : undefined
    const resetRaw = typeof data.resetAt === 'number' ? data.resetAt : undefined
    return {
      ...(used === undefined ? {} : { usedPercent: used }),
      ...(resetRaw === undefined ? {} : { resetAtMs: resetRaw < 1e12 ? resetRaw * 1000 : resetRaw }),
    }
  } catch {
    return undefined
  }
}

/**
 * 拉模型目录（POST，body 带 token）。
 *
 * 形状不对抛错（不返回空数组）—— 空数组会被误读成「账号没有模型」。
 */
export async function fetchModels(
  fetcher: typeof fetch,
  product: AccioProduct,
  credential: AccioCredential,
  signal?: AbortSignal,
): Promise<Array<{ id: string; name: string; contextWindow: number; maxTokens?: number }>> {
  const response = await fetcher(`${product.gatewayBase}${ACCIO_LLM_CONFIG_PATH}`, {
    method: 'POST',
    headers: accioHeaders(product),
    body: JSON.stringify({ token: credential.access_token }),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new Error(`Accio：模型目录返回 HTTP ${response.status}`)
  const body: unknown = await response.json().catch(() => undefined)
  if (typeof body !== 'object' || body === null) throw new Error('Accio：模型目录响应不是对象')
  const record = body as Record<string, unknown>
  const list = Array.isArray(record.models) ? record.models
    : Array.isArray(record.data) ? record.data
    : undefined
  if (list === undefined) throw new Error('Accio：模型目录缺少 models 数组')
  const rows: Array<{ id: string; name: string; contextWindow: number; maxTokens?: number }> = []
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as Record<string, unknown>
    const id = typeof item.id === 'string' ? item.id : typeof item.model === 'string' ? item.model : undefined
    if (id === undefined) continue
    const name = typeof item.name === 'string' ? item.name : typeof item.displayName === 'string' ? item.displayName : id
    const contextRaw = item.contextWindow ?? item.context_window ?? item.maxInputTokens
    const contextWindow = typeof contextRaw === 'number' && contextRaw > 0 ? contextRaw : 128_000
    const maxRaw = item.maxTokens ?? item.max_output_tokens
    const maxTokens = typeof maxRaw === 'number' && maxRaw > 0 ? Math.min(maxRaw, contextWindow) : undefined
    rows.push({ id, name, contextWindow, ...(maxTokens === undefined ? {} : { maxTokens }) })
  }
  if (rows.length === 0) throw new Error('Accio：模型目录为空')
  return rows
}

/** 对话选项。 */
export interface ChatOptions {
  model: string
  messages: readonly { role: string; content: unknown }[]
  system?: string
  tools?: readonly { name: string; description?: string; parameters?: unknown }[]
  signal?: AbortSignal
}

/**
 * 流式推理（异步生成器）。
 *
 * ⚠️ 上游的业务错误**不体现在 HTTP 状态码上**（常是 200 + 帧里的 error_code），
 * 故每帧都要判 error_code。
 */
export async function* streamChat(
  fetcher: typeof fetch,
  product: AccioProduct,
  credential: AccioCredential,
  options: ChatOptions,
): AsyncGenerator<{ text?: string; reasoning?: string }, void, undefined> {
  if (!isCredentialUsable(credential)) {
    throw new Error('Accio：没有可用凭据，请先登录')
  }
  const { createHash, randomUUID } = await import('node:crypto')
  const requestId = randomUUID()
  // 上游要求 sg_k=<md5(requestId)>。
  const sgK = createHash('md5').update(requestId).digest('hex')

  const response = await fetcher(`${product.llmBase}${ACCIO_GENERATE_PATH}?sg_k=${sgK}`, {
    method: 'POST',
    headers: { ...accioHeaders(product), Accept: 'text/event-stream' },
    body: JSON.stringify(buildGenerateBody({
      token: credential.access_token,
      messages: options.messages,
      ...(options.system === undefined ? {} : { system: options.system }),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
    })),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Accio：推理返回 HTTP ${response.status}${text === '' ? '' : `：${text.slice(0, 200)}`}`)
  }
  if (response.body === null) throw new Error('Accio：推理响应没有正文')

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
        const raw = line.slice(5).trim()
        if (raw === '' || raw === '[DONE]') continue
        let parsed: unknown
        try { parsed = JSON.parse(raw) } catch { continue }
        const frame = parseAdkFrame(parsed)
        if (frame === undefined) continue
        if (frame.kind === 'done') return
        if (frame.kind === 'error') throw new Error(`Accio 上游错误：${frame.message}`)
        yield frame
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
}

/**
 * Accio 登录：本地回调 OAuth + PKCE。
 *
 * 与 Command Code 同型（本地 HTTP 服务收 `code`），差别在：
 * - Accio 用 **PKCE S256**（`code_verifier` / `code_challenge`）；
 * - 授权站点按地区不同（国际 `www.accio.com` / 国内 `www.accio-ai.com`）。
 *
 * ⚠️ 回调地址 `http://localhost:<port>/callback` 需要在 Accio 的 OAuth 客户端
 * 白名单里。若上游对 `accio-work` 这个 client 限制了 redirect_uri，
 * 授权页会直接拒绝 —— 此时用户仍可用「粘贴访问令牌」的路径（已在
 * `ADOPTABLE_CHANNELS` 里保留）。
 */

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

import { ACCIO_LOGIN_START_PORT, type AccioProduct } from './accio-product.js'
import { buildAccioAuthUrl, createPkcePair, type AccioCredential } from './accio.js'

/** 回调路径。 */
export const ACCIO_CALLBACK_PATH = '/callback'
/** 端口尝试次数。 */
const PORT_ATTEMPTS = 10
/** 登录总时限。 */
const LOGIN_TIMEOUT_MS = 300_000

/** 已启动的 Accio 登录。 */
export interface StartedAccioLogin {
  loginUrl: string
  port: number
  result: Promise<AccioCredential>
  close: () => Promise<void>
}

/**
 * 启动 Accio 登录并立即返回授权 URL。
 *
 * 与 Command Code 的 `startCommandCodeLogin` 同一形态：不等用户，
 * 由调用方展示 URL 并 await `result`。
 */
export async function startAccioLogin(options: {
  product: AccioProduct
  fetcher?: typeof fetch
  timeoutMs?: number
}): Promise<StartedAccioLogin> {
  const fetcher = options.fetcher ?? fetch
  const { product } = options
  const state = randomUUID()
  const pkce = await createPkcePair()

  let resolveResult!: (value: AccioCredential) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<AccioCredential>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  result.catch(() => {})

  let port = 0
  // 处理函数抽出来：v4 与 v6 两个监听器要共用同一份逻辑。
  const handler: import('node:http').RequestListener = (request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
    if (!url.pathname.startsWith(ACCIO_CALLBACK_PATH)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
      return
    }
    const code = url.searchParams.get('code')
    const gotState = url.searchParams.get('state')
    if (code === null || code === '' || gotState !== state) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('登录回调参数无效')
      return
    }
    const redirectUri = `http://localhost:${port}${ACCIO_CALLBACK_PATH}`
    void exchangeCode(fetcher, product, code, pkce.verifier, redirectUri)
      .then((credential) => {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end('<html><body><h2>登录成功，可以关闭此窗口了</h2></body></html>')
        resolveResult(credential)
      })
      .catch((error: unknown) => {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('登录换取凭据失败')
        rejectResult(error)
      })
  }
  const server = createServer(handler)

  for (let offset = 0; offset < PORT_ATTEMPTS; offset++) {
    const candidate = ACCIO_LOGIN_START_PORT + offset
    const bound = await new Promise<boolean>((resolve) => {
      const onError = (): void => { server.removeListener('listening', onListening); resolve(false) }
      const onListening = (): void => { server.removeListener('error', onError); resolve(true) }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(candidate, '127.0.0.1')
    })
    if (bound) { port = candidate; break }
  }
  if (port === 0) {
    throw new Error(`Accio：回调端口 ${ACCIO_LOGIN_START_PORT} 起 ${PORT_ATTEMPTS} 个全部被占用`)
  }

  // ⚠️ 浏览器可能把 `localhost` 解析成 `::1`：只绑 v4 会「授权完页面打不开 / 没反应」。
  // 因此同一端口再听一个 `[::1]`（失败可容忍 —— 机器没开 IPv6 时 `localhost` 走 v4）。
  // `redirect_uri` 必须继续用 `localhost`：Accio 的 OAuth 客户端按它登记白名单，
  // 改成 `127.0.0.1` 会被拒。
  const secondary = createServer(handler)
  await new Promise<void>((resolve) => {
    secondary.once('error', () => resolve())
    secondary.listen(port, '::1', () => resolve())
  })
  const servers = secondary.listening ? [server, secondary] : [server]

  const redirectUri = `http://localhost:${port}${ACCIO_CALLBACK_PATH}`
  const loginUrl = buildAccioAuthUrl(product, redirectUri, state, pkce.challenge)

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    for (const listener of servers) listener.closeAllConnections?.()
    await Promise.all(servers.map((listener) => new Promise<void>((resolve) => listener.close(() => resolve()))))
  }

  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS
  const withTimeout = Promise.race([
    result,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`Accio 登录超时（${Math.round(timeoutMs / 1000)} 秒内未完成）`)), timeoutMs)
      timer.unref?.()
    }),
  ])
  withTimeout.catch(() => {}).finally(() => { void close() })

  return { loginUrl, port, result: withTimeout, close }
}
