/**
 * Command Code 登录流程：浏览器 OAuth + 本地回调。
 *
 * ## 与既有渠道的差异
 *
 * 登录成功后拿到的是**一个长期 API Key**，没有 refresh_token、
 * 没有续期流程。因此本模块只负责「拿到 Key 并验证它」，
 * 不存在 `refresh()` 这条路径。
 *
 * ## 端口选择
 *
 * 分两步，顺序不能反（见 {@link listenForCallbackPort}）：
 *
 * 1. **先试官方段**：官方 CLI 从 5959 起逐个试，最多 10 个。这里照做而不是
 *    直接用随机端口，因为 Studio 的授权页可能对回调地址做校验（白名单或形态
 *    匹配）；固定范围比随机端口更不容易撞上「未知回调」的拒绝。
 * 2. **段内全占再退随机回环端口**：用户同时开着官方 CLI、或 accio（5960–5969）
 *    先抢到端口时，10 个端口可能全被占。此时直接报错等于「添加账号」功能在那
 *    台机器上完全不可用，而回退端口是能工作的 —— 回调地址由本插件构造并作为
 *    `callback` 查询参数交给 Studio，端口不固定不影响回调（`trae-oauth.ts` 的
 *    `listenWithFallback` 用同一套理由）。
 *
 * 保留官方段优先是为了不放弃第 1 步的「形态匹配」红利；回退只是兜底。
 *
 * ## 不落状态文件
 *
 * 单进程内闭环：`result` 就是最终结果，没有跨进程状态文件，
 * 也就没有「残留文件被误判成进行中登录」这类问题。
 */

import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'

import {
  COMMANDCODE_CREDITS_PATH,
  COMMANDCODE_LOGIN_MAX_PORT_ATTEMPTS,
  COMMANDCODE_LOGIN_START_PORT,
  COMMANDCODE_LOGIN_TIMEOUT_MS,
  COMMANDCODE_MODELS_PATH,
  COMMANDCODE_WHOAMI_PATH,
  type CommandCodeProduct,
} from './commandcode-product.js'
import {
  buildCommandCodeAuthUrl,
  credentialFromWhoami,
  isCredentialUsable,
  parseCallbackCredentials,
  parseCredits,
  parseWhoami,
  type CommandCodeCredential,
  type CommandCodeCredits,
} from './commandcode.js'

/**
 * 回调路径。Studio 授权完成后会 POST 到这个路径。
 *
 * 载荷形状两种都接（官方 CLI `command-code@1.87.3` 的 createAuthServer 同样双形状）：
 * - `application/json`：`{ apiKey, state, userId, userName, keyName }`（官方称 legacy，仍收）；
 * - `application/x-www-form-urlencoded`：官方 Studio 授权页当前的表单回发形状。
 *   字段名完全相同；只认 JSON 会让表单回发在浏览器里报「不是合法 JSON」。
 */
export const COMMANDCODE_CALLBACK_PATH = '/callback'

/** 打开浏览器的注入点（测试可替换）。 */
export type OpenBrowser = (url: string) => void | Promise<void>

/** 一次登录的结果。 */
export interface CommandCodeLoginResult {
  /** 已验证可用的凭据。 */
  credential: CommandCodeCredential
  /** 实际使用的回调端口（便于排障）。 */
  port: number
}

/** 登录流程的可选依赖。 */
export interface CommandCodeLoginOptions {
  /** 产品配置。 */
  product: CommandCodeProduct
  /** 打开浏览器的实现；缺省时不自动打开（由调用方把 URL 展示给用户）。 */
  openBrowser?: OpenBrowser
  /** fetch 实现（测试注入）。 */
  fetcher?: typeof fetch
  /** 总超时（毫秒）。 */
  timeoutMs?: number
  /** 取消信号。 */
  signal?: AbortSignal
  /**
   * 回调端口候选段（缺省 `COMMANDCODE_LOGIN_START_PORT` 起
   * `COMMANDCODE_LOGIN_MAX_PORT_ATTEMPTS` 个，即官方段 5959–5968）。
   *
   * 仅供测试/嵌入方注入：测试要验证「段内全占时退随机端口」，又不能真的去占
   * 5959–5968（那会与用户正在运行的官方 CLI 抢端口，且结果取决于机器现状）。
   * 生产路径不传，永远走官方段优先 + 随机回退。
   */
  portRange?: { startPort?: number; attempts?: number }
}

/** 已启动的登录流程。 */
export interface StartedCommandCodeLogin {
  /** 展示给用户的登录 URL。 */
  loginUrl: string
  /** 实际绑定的回调端口（便于排障与测试）。 */
  port: number
  /**
   * 是否走了随机回环端口回退（官方段 5959–5968 全被占用）。
   *
   * 只用于排障与测试断言：`loginUrl` 里的 `callback=` 已经用实际端口拼好，
   * 调用方**不需要**为回退做任何额外处理。
   */
  portFallback: boolean
  /** 用户完成授权（或超时/失败）后落定的结果。 */
  result: Promise<CommandCodeLoginResult>
  /** 关闭回调服务器；**幂等**。 */
  close: () => Promise<void>
}

/**
 * 校验一个 API Key 是否可用。
 *
 * 只调 `/alpha/whoami`：401 → 无效；其它非 2xx → 服务端错误；
 * 传输失败 → 网络错误。三者对调用方的意义不同，不能混为一谈。
 */
export async function validateApiKey(
  fetcher: typeof fetch,
  product: CommandCodeProduct,
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ ok: true; credential: CommandCodeCredential } | { ok: false; reason: 'invalid_key' | 'server_error' | 'network_error'; status?: number }> {
  try {
    const response = await fetcher(`${product.apiBase}${COMMANDCODE_WHOAMI_PATH}`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...product.clientHeaders, Authorization: `Bearer ${apiKey}` },
      ...(signal === undefined ? {} : { signal }),
    })
    // 身份校验只看状态码，及时释放正文连接。
    void response.body?.cancel().catch(() => undefined)
    if (response.status === 401) return { ok: false, reason: 'invalid_key', status: 401 }
    if (!response.ok) return { ok: false, reason: 'server_error', status: response.status }
    // 2xx 但正文可能不可解析 —— 此时仍然认为 Key 有效（状态码已是权威判据），
    // 只是拿不到昵称等展示字段。
    return { ok: true, credential: { access_token: apiKey, created_at: Date.now() } }
  } catch {
    return { ok: false, reason: 'network_error' }
  }
}

/**
 * 校验 Key 并返回带账号信息的完整凭据。
 *
 * 与 {@link validateApiKey} 的区别：这里**要求** whoami 正文可解析，
 * 因为它要给账号池提供昵称与 account_id。用于登录流程；
 * 快速探活请用 `validateApiKey`。
 */
export async function resolveCredential(
  fetcher: typeof fetch,
  product: CommandCodeProduct,
  apiKey: string,
  signal?: AbortSignal,
): Promise<CommandCodeCredential> {
  const response = await fetcher(`${product.apiBase}${COMMANDCODE_WHOAMI_PATH}`, {
    method: 'GET',
    headers: { Accept: 'application/json', ...product.clientHeaders, Authorization: `Bearer ${apiKey}` },
    ...(signal === undefined ? {} : { signal }),
  })
  if (response.status === 401) throw new Error('Command Code：API Key 无效（whoami 返回 401），请重新登录')
  if (!response.ok) throw new Error(`Command Code：whoami 返回 HTTP ${response.status}`)
  const whoami = parseWhoami(await response.json().catch(() => undefined))
  if (whoami === undefined) throw new Error('Command Code：whoami 响应缺少 userId，无法确认账号')
  const credential = credentialFromWhoami(apiKey, whoami)
  if (!isCredentialUsable(credential)) throw new Error('Command Code：登录返回的 Key 为空或含首尾空白')
  return credential
}

/** 一次 `listen` 尝试的结果。 */
export type PortBindAttempt =
  | { ok: true; port: number }
  | { ok: false; error: Error }

/**
 * 在 `127.0.0.1` 上尝试监听**一个**端口，失败不抛。
 *
 * `port = 0` 表示交给系统分配（回环随机端口）。成功时返回**实际**端口：
 * 端口 0 的请求端口不是绑定端口，必须从 `server.address()` 取。
 *
 * 必须**先**注册 `'error'` 再 `listen`：listen 失败是异步事件，没有监听者会
 * 变成进程级 unhandled error（`trae-oauth.ts` 的 `listenOrReject` 记过同一个坑）。
 */
export async function bindLoopbackPort(server: Server, port: number): Promise<PortBindAttempt> {
  return new Promise<PortBindAttempt>((resolve) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening)
      resolve({ ok: false, error })
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      const address = server.address()
      // `address()` 在绑定 TCP 端口时是对象；管道/异常形态退回请求端口。
      const actual = typeof address === 'object' && address !== null ? address.port : port
      resolve({ ok: true, port: actual })
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

/**
 * 在 `[startPort, startPort + attempts)` 这个**固定段**内找第一个可用端口。
 *
 * 段内全被占用时返回 `undefined`（不抛）：调用方还要决定是否回退，
 * 把「段内失败」和「彻底失败」拆开才能分别表述。
 */
export async function listenOnPortRange(
  server: Server,
  startPort: number = COMMANDCODE_LOGIN_START_PORT,
  attempts: number = COMMANDCODE_LOGIN_MAX_PORT_ATTEMPTS,
  errors: string[] = [],
): Promise<number | undefined> {
  for (let offset = 0; offset < attempts; offset++) {
    const candidate = startPort + offset
    const attempt = await bindLoopbackPort(server, candidate)
    if (attempt.ok) return attempt.port
    errors.push(`${candidate}: ${attempt.error.message}`)
  }
  return undefined
}

/** 回调端口绑定结果：实际端口 + 是否走了随机回退。 */
export interface CallbackPortBinding {
  /** 实际绑定的端口。 */
  port: number
  /** `true` 表示官方段全占，走的是系统分配的随机回环端口。 */
  fallback: boolean
}

/**
 * 启动回调服务器的端口选择：**官方段优先，段内全占再退随机回环端口**。
 *
 * ## 为什么不是「全失败就报错」（原行为）
 *
 * 5959 起 10 个端口与两拨进程抢：官方 `command-code` CLI 用同一段，accio 用
 * 5960–5969（`accio-auth.ts:346-359`，与官方段重叠 9 个）。用户同时开着官方
 * CLI 时，这 10 个端口全被占是常态，而原来的实现此时直接抛「端口全部被占用」，
 * 「添加账号」在那台机器上完全不可用。
 *
 * 回退是安全的：回调地址由本插件构造（`buildCommandCodeAuthUrl` 用**实际**
 * 端口拼 `callback=` 查询参数），Studio 原样回跳，端口不固定不影响回调。
 * `trae-oauth.ts:520-570` 的 `listenWithFallback` 是同一套判断：能拿到首选端口
 * 就用它（行为可预期），拿不到就退随机端口保证功能可用。
 *
 * 顺序不能反：先用随机端口会放弃「官方段可能被授权页白名单接受」的红利。
 *
 * @throws 连随机回环端口都绑不上（例如回环网络栈不可用）时抛错，并带上段内明细。
 */
export async function listenForCallbackPort(
  server: Server,
  startPort: number = COMMANDCODE_LOGIN_START_PORT,
  attempts: number = COMMANDCODE_LOGIN_MAX_PORT_ATTEMPTS,
): Promise<CallbackPortBinding> {
  const errors: string[] = []
  const ranged = await listenOnPortRange(server, startPort, attempts, errors)
  if (ranged !== undefined) return { port: ranged, fallback: false }

  const random = await bindLoopbackPort(server, 0)
  if (random.ok) return { port: random.port, fallback: true }

  throw new Error(
    `Command Code：回调端口 ${startPort}–${startPort + attempts - 1} 全部被占用`
    + `（通常意味着本机有其它 CLI 正在登录），回退随机回环端口也失败：${random.error.message}`
    + `。段内明细：${errors.join('; ')}`,
  )
}

/**
 * 启动登录流程并**立即返回**登录 URL（不打开浏览器、不等用户）。
 *
 * `result` 已内置超时；结果落定后自动关闭回调服务器。
 */
export async function startCommandCodeLogin(options: CommandCodeLoginOptions): Promise<StartedCommandCodeLogin> {
  const fetcher = options.fetcher ?? fetch
  const { product } = options
  const state = randomUUID()

  let resolveResult!: (value: CommandCodeLoginResult) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<CommandCodeLoginResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  // 手工创建的 Promise 要过一会儿才交给 race 消费，而回调处理器可能在
  // 「构造完成」与「被 await」之间就 reject 它 —— 那段窗口会被 Node
  // 视为未处理的拒绝并打印告警。先挂空处理器打上「已处理」标记。
  result.catch(() => {})

  let port = 0
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
    if (!url.pathname.startsWith(COMMANDCODE_CALLBACK_PATH)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Method not allowed')
      return
    }
    // 回调载荷体积设上限：这是个对 localhost 开放的无鉴权端点，
    // 不能让任意本机进程用超大 body 撑爆内存。
    const chunks: Buffer[] = []
    let size = 0
    let aborted = false
    request.on('data', (chunk: Buffer) => {
      if (aborted) return
      size += chunk.length
      if (size > 64 * 1024) {
        aborted = true
        response.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Payload too large')
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (aborted) return
      void (async () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        const contentType = String(request.headers['content-type'] ?? '').toLowerCase()
        let payload: unknown
        if (contentType.includes('application/x-www-form-urlencoded')) {
          // 官方 Studio 授权页当前用表单回发（官方 CLI 的 handleBrowserCallback
          // 正是按 URLSearchParams 解析）；JSON 形状官方仍收，两种都接。
          payload = Object.fromEntries(new URLSearchParams(raw))
        } else {
          try {
            payload = JSON.parse(raw)
          } catch {
            response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('登录回调不是合法 JSON')
            return
          }
        }
        const gotState = (payload as Record<string, unknown> | null)?.state
        if (gotState !== state) {
          // state 不匹配说明回调不是本次登录发起的（或为伪造）。
          // 用 400 而不是静默忽略：让用户在浏览器里看到明确反馈。
          response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('登录回调 state 不匹配')
          return
        }
        const credential = parseCallbackCredentials(payload)
        if (credential === undefined) {
          response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('登录回调缺少必填字段')
          return
        }
        // 拿到 Key 后立刻验证：把无效 Key 挡在落盘之前，而不是等用户
        // 下次调用时才失败。
        try {
          const verified = await resolveCredential(fetcher, product, credential.access_token, options.signal)
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            .end('<html><body><h2>登录成功，可以关闭此窗口了</h2></body></html>')
          resolveResult({ credential: verified, port })
        } catch (error) {
          response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('登录换取凭据失败')
          rejectResult(error)
        }
      })()
    })
  })

  const binding = await listenForCallbackPort(
    server,
    options.portRange?.startPort,
    options.portRange?.attempts,
  )
  port = binding.port
  const loginUrl = buildCommandCodeAuthUrl(product, port, state)

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    // 先断开所有活动连接：`server.close()` 只停止接受新连接，
    // keep-alive 连接会让它一直等下去（在测试里表现为 socket hang up）。
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  const timeoutMs = options.timeoutMs ?? COMMANDCODE_LOGIN_TIMEOUT_MS
  const resultWithTimeout = Promise.race([
    result,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Command Code 登录超时（${Math.round(timeoutMs / 1000)} 秒内未完成）`)),
        timeoutMs,
      )
      timer.unref?.()
    }),
  ])
  resultWithTimeout.catch(() => {}).finally(() => { void close() })

  return { loginUrl, port, portFallback: binding.fallback, result: resultWithTimeout, close }
}

/**
 * 运行完整登录流程：起回调服务器 → 打开浏览器 → 等回调 → 验证 Key。
 *
 * 单进程内闭环，不落状态文件。
 */
export async function runCommandCodeLogin(options: CommandCodeLoginOptions): Promise<CommandCodeCredential> {
  const started = await startCommandCodeLogin(options)
  try {
    if (options.openBrowser !== undefined) await options.openBrowser(started.loginUrl)
    const { credential } = await started.result
    return credential
  } finally {
    await started.close()
  }
}

/**
 * 拉取一次额度。
 *
 * 返回 `undefined` 表示「无法得知」（字段未识别或网络失败），
 * 与「额度为零」是两件事 —— 账号池不该因为一次查询失败就冷却账号。
 */
export async function fetchCredits(
  fetcher: typeof fetch,
  product: CommandCodeProduct,
  credential: CommandCodeCredential,
  signal?: AbortSignal,
): Promise<CommandCodeCredits | undefined> {
  try {
    const response = await fetcher(`${product.apiBase}${COMMANDCODE_CREDITS_PATH}`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...product.clientHeaders, Authorization: `Bearer ${credential.access_token}` },
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) return undefined
    return parseCredits(await response.json().catch(() => undefined))
  } catch {
    return undefined
  }
}

/**
 * 拉取一次模型目录。
 *
 * 形状按参考实现：`{ object: 'list', data: [...] }`，每个条目至少有
 * `id` / `name` / `context_length`。形状不对时抛错（而不是返回空数组）——
 * 空数组会让上层误以为「这个账号没有可用模型」。
 */
export async function fetchModelCatalog(
  fetcher: typeof fetch,
  product: CommandCodeProduct,
  credential: CommandCodeCredential,
  signal?: AbortSignal,
): Promise<Array<{ id: string; name: string; contextWindow: number; maxTokens?: number; supportsImage?: boolean }>> {
  const response = await fetcher(`${product.apiBase}${COMMANDCODE_MODELS_PATH}`, {
    method: 'GET',
    headers: { Accept: 'application/json', ...product.clientHeaders, Authorization: `Bearer ${credential.access_token}` },
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new Error(`Command Code：模型目录返回 HTTP ${response.status}`)
  const body: unknown = await response.json().catch(() => undefined)
  if (typeof body !== 'object' || body === null) throw new Error('Command Code：模型目录响应不是对象')
  const record = body as Record<string, unknown>
  if (!Array.isArray(record.data)) throw new Error('Command Code：模型目录缺少 data 数组')
  const rows: Array<{ id: string; name: string; contextWindow: number; maxTokens?: number; supportsImage?: boolean }> = []
  for (const raw of record.data) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as Record<string, unknown>
    const id = typeof item.id === 'string' && item.id !== '' ? item.id : undefined
    const name = typeof item.name === 'string' && item.name !== '' ? item.name : undefined
    const contextRaw = item.context_length ?? item.contextWindow
    const contextWindow = typeof contextRaw === 'number' && Number.isFinite(contextRaw) && contextRaw > 0 ? contextRaw : undefined
    if (id === undefined || name === undefined || contextWindow === undefined) continue
    const maxRaw = item.max_output_tokens ?? item.maxTokens
    const maxTokens = typeof maxRaw === 'number' && Number.isFinite(maxRaw) && maxRaw > 0
      ? Math.min(maxRaw, contextWindow)
      : undefined
    const endpoints = item.supported_endpoints ?? item.supportedEndpoints
    const supportsImage = Array.isArray(endpoints) ? endpoints.includes('image') : undefined
    rows.push({ id, name, contextWindow, maxTokens, supportsImage })
  }
  if (rows.length === 0) throw new Error('Command Code：模型目录为空')
  return rows
}
