/**
 * CodeArts 登录：新式 IAM OAuth（portal 授权 + 本地回调 + PKCE/DPoP）。
 *
 * 2026-10-29：旧 ticket 流程（doer/redirect + snap-manager login/ticket 轮询）
 * 已整体删除 —— 用户确认旧界面早已不存在、portal OAuth 从未触发过回退，
 * 双协议只剩维护成本（magpie opencode-codearts-auth 同款单协议形态）。
 * 回调服务器只认 `code`；portal 判定不可用时直接报错，不再走 secret 回退。
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import type { CodeArtsCredential, LoginFlowOptions, LoginFlowResult } from './types.js'
import {
  CLIENT_ID, REDIRECT_PATH, credentialFromTokenResponse, exchangeAuthorizationCode,
  generateDpopKeyPair, generatePkcePair,
} from './oauth.js'
import type { DpopKeyPair, PkcePair } from './oauth.js'

/** 凭据的过期时间戳（毫秒）；时间戳无法解析时回退为 +24 小时。 */
export function expiresFromCredential(credential: CodeArtsCredential): number {
  if (credential.expires_at) {
    const parsed = Date.parse(credential.expires_at)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Date.now() + 86_400_000
}

/** 新式 IAM OAuth 的 portal 授权端点（对齐真实插件的 getPortalHost + /authorize）。 */
export const PORTAL_AUTHORIZE_BASE = 'https://codearts.huaweicloud.com/portal/authorize'
/** portal 登录结果页（登录完成后重定向目标，对齐真实插件回调处理器的 login_succeed 页）。 */
export const PORTAL_LOGIN_BASE = 'https://codearts.huaweicloud.com/portal/login'

/** 构建 portal 登录结果页 URL（真实插件在回调成功后 307 重定向到此页）。 */
export function buildPortalLoginResultUrl(succeeded: boolean): string {
  return `${PORTAL_LOGIN_BASE}?login_succeed=${succeeded}&uri_scheme=${CLIENT_ID}&locale=${OAUTH_LOCALE}`
}
/** portal 期望的插件名（逆向常量，硬编码）。 */
export const LOGIN_PLUGIN_NAME = 'snap_AIIDE'
/** portal 期望的插件版本（逆向常量，硬编码为真实扩展版本，勿用本包版本）。 */
export const LOGIN_PLUGIN_VERSION = '5.2.0'
/** 主题色 kind（对齐 IDE 的 activeColorTheme.kind：2 = Dark）。 */
export const OAUTH_THEME = '2'
/** 界面语言（对齐 env.language）。 */
export const OAUTH_LOCALE = 'zh-cn'

/** 构建新式 IAM OAuth 的 portal 授权 URL（参数完全对齐真实插件 buildLoginUrl）。 */
export function buildOAuthLoginUrl(port: number, pkce: PkcePair, ticketId: string): string {
  return `${PORTAL_AUTHORIZE_BASE}?theme=${OAUTH_THEME}&locale=${OAUTH_LOCALE}`
    + `&uri_scheme=${CLIENT_ID}&client_id=${CLIENT_ID}&port=${port}`
    // code_challenge_method 对齐真实插件 PKCEGenerator.CODE_CHALLENGE_METHOD = "SHA-256"
    // （非 RFC 标准缩写 S256；portal 以此识别 OAuth 授权，错值会回退旧 ticket 流程）。
    + `&code_challenge=${pkce.codeChallenge}&code_challenge_method=SHA-256`
    // 注意：真实插件 URL 不含 auth_callback_url——portal 仅凭 port 参数构造回调。
    // 多余的 auth_callback_url 会被 portal 视为异常并回退旧流程，切勿添加。
    + `&ticket_id=${ticketId}&plugin-name=${LOGIN_PLUGIN_NAME}&plugin-version=${LOGIN_PLUGIN_VERSION}`
}

/** 新式 OAuth 的本地回调服务器：收到 code 换取凭据并 resolve（只认 code，见内注释）。 */
export function startOAuthCallbackServer(
  ticketId: string,
  pkce: PkcePair,
  keyPair: DpopKeyPair,
  options: LoginFlowOptions,
): Promise<{ port: number; server: ReturnType<typeof createServer>; result: Promise<LoginFlowResult> }> {
  let resolveResult!: (value: LoginFlowResult) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<LoginFlowResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${request.socket.localPort}`)
    if (url.pathname !== REDIRECT_PATH && !url.pathname.startsWith(REDIRECT_PATH)) {
      response.writeHead(404).end('Not found')
      return
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, CORS_HEADERS).end()
      return
    }
    // 只认 `code`（2026-10-29 移除 secret 回退分支：旧 ticket 流程已删，
    // portal 判定 OAuth 不可用时回退形态不再被支持 —— 缺 code 直接报错，
    // 比静默轮询一个已不存在的 ticket 端点更可读）。
    const code = url.searchParams.get('code')
    if (!code) {
      // 对齐 magpie：无 code 的回调立即 307 到 portal 失败结果页并 reject，
      // 不留一个挂死的登录流程。
      const said = url.searchParams.get('error_description') ?? url.searchParams.get('error')
      response.writeHead(307, { ...CORS_HEADERS, Location: buildPortalLoginResultUrl(false) }).end()
      rejectResult(new Error(`CodeArts：授权回调缺少 code${said ? `：${said}` : ''}`))
      return
    }
    // localPort 在监听中的服务器上必然存在；?? 0 仅用于类型收窄。
    void exchangeAuthorizationCode(code, pkce.codeVerifier, request.socket.localPort ?? 0, keyPair, options.fetcher).then(
      (token) => {
        const credential = credentialFromTokenResponse(token, pkce, keyPair)
        // 对齐真实插件：换取成功后 307 重定向浏览器到 portal 登录结果页。
        response.writeHead(307, { ...CORS_HEADERS, Location: buildPortalLoginResultUrl(true) }).end()
        resolveResult({ access: JSON.stringify(credential), expires: expiresFromCredential(credential), loginUrl: '' })
      },
      (error) => {
        response.writeHead(307, { ...CORS_HEADERS, Location: buildPortalLoginResultUrl(false) }).end()
        rejectResult(error)
      },
    )
  })

  return listenOnCallbackPort(server).then((port) => ({ port, server, result }))
}

/** 新式 OAuth 回调等待预算（浏览器打开 + 用户操作，180 秒）。 */
const OAUTH_CALLBACK_TIMEOUT_MS = 180_000
/** 回调端口下限（对齐真实插件对回调端口的 ≥10000 要求）。 */
const MIN_CALLBACK_PORT = 10_000

/** 启动回调服务器并确保监听端口 ≥10000（真实插件要求，低端口会被 portal 拒绝）。 */
function listenOnCallbackPort(
  server: ReturnType<typeof createServer>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        const address = server.address()
        const assigned = typeof address === 'object' && address ? address.port : 0
        if (assigned >= MIN_CALLBACK_PORT) {
          resolve(assigned)
          return
        }
        // 端口 < 10000：关闭后用随机 [10000, 65535] 端口重试（对齐真实插件）。
        server.close(() => {
          const retry = Math.floor(Math.random() * (65_536 - MIN_CALLBACK_PORT)) + MIN_CALLBACK_PORT
          tryListen(retry)
        })
      })
    }
    tryListen(0)
  })
}

/**
 * 已启动但尚未完成的 OAuth 登录流程。
 *
 * 拆出这一层是为了支持**两步式登录**（Channel Pack 的「+ 新建账号」）：
 * 调用方先拿到 `loginUrl` 立刻打开窗口，再自行 await `result`。
 *
 * 为什么必须拆：浏览器只在用户点击后的短暂窗口（transient activation，
 * 约 5 秒）内允许 `window.open`。若把「起服务器 → 打开浏览器 → 等用户授权」
 * 整个流程做成一次阻塞调用，调用方拿到 URL 时手势早已过期，`window.open`
 * 会被弹窗拦截器拒绝。
 */
export interface StartedOAuthFlow {
  /** 展示给用户的登录 URL。 */
  loginUrl: string
  /** 用户完成授权（或超时/失败）后落定的结果。 */
  result: Promise<LoginFlowResult>
  /** 关闭回调服务器；**幂等**，可重复调用。 */
  close: () => Promise<void>
}

/**
 * 启动 OAuth 登录流程并**立即返回**登录 URL（不打开浏览器、不等用户）。
 *
 * `result` 已内置超时：两步式路径没有外层 try/finally 兜底，
 * 若超时不在此处生效，回调服务器会一直挂着。
 * 结果一旦落定就自动关闭服务器，避免两步式路径泄漏监听端口。
 */
export async function startOAuthFlow(options: LoginFlowOptions = {}): Promise<StartedOAuthFlow> {
  const ticketId = randomBytes(32).toString('hex')
  const pkce = generatePkcePair()
  const keyPair = await generateDpopKeyPair()
  const { port, server, result } = await startOAuthCallbackServer(ticketId, pkce, keyPair, options)
  const loginUrl = buildOAuthLoginUrl(port, pkce, ticketId)

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  const resultWithUrl = Promise.race([
    result,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('CodeArts OAuth login timed out')), OAUTH_CALLBACK_TIMEOUT_MS)
      timer.unref?.()
    }),
  ]).then((outcome) => ({ ...outcome, loginUrl }))

  // 先挂一个空处理器：结果可能在调用方 await 之前就落定（用户授权极快、
  // 或立刻超时），那一段窗口里 Node 会把它当成未处理拒绝并打印告警。
  resultWithUrl.catch(() => {}).finally(() => { void close() })

  return { loginUrl, result: resultWithUrl, close }
}

/**
 * 运行完整的新式 IAM OAuth 登录流程（默认登录方式）。
 *
 * 阻塞语义：打开浏览器并等待用户完成授权后才返回。
 * 需要「立即拿到 URL」的场景（Channel Pack 两步式登录）请用 {@link startOAuthFlow}。
 */
export async function runOAuthFlow(options: LoginFlowOptions = {}): Promise<LoginFlowResult> {
  const started = await startOAuthFlow(options)
  try {
    const opener = options.openBrowser ?? openBrowser
    await opener(started.loginUrl)
    return await started.result
  } finally {
    await started.close()
  }
}
