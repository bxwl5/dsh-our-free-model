/**
 * KukuAI 扫码登录的本地页（宿主侧承载弹窗页）。
 *
 * 范式照 `raccoon-login-page.ts` / `autoclaw-login-page.ts`：
 *
 * ```
 * 本地服务器（127.0.0.1:随机端口）
 *   GET /kuku/login    → 弹窗页（内联二维码 + 轮询 + 刷新）
 *   GET /kuku/poll     → 宿主侧长轮询 passport（约 30s），confirmed 时当场换凭据
 *   GET /kuku/reload   → 重新申请二维码后 302 回 /kuku/login
 * ```
 *
 * 对外返回 `loginUrl`，前端照常 `window.open` + `login.poll` —— 与其余两步式渠道一致，
 * **客户端无需任何改动**。
 *
 * ⚠️ 协议细节（见 `kuku-qr-login.ts` 的注释）：`/channel/unicast` 是**长轮询**，
 * 未扫码时上游约 30 秒才回；轮询超时用模块里的 `KUKU_QR_POLL_TIMEOUT_MS`(45s)，
 * 不能复用请求超时，否则每次轮询都超时抛 network、表象是「扫码一直失败」。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { KukuCredential } from './kuku.js'
import {
  completeKukuQrLogin,
  fetchKukuQrImage,
  pollKukuQrStatus,
  renderKukuQrPage,
  requestKukuQrCode,
  type KukuQrSession,
} from './kuku-qr-login.js'

/** 本地页路径。 */
export const KUKU_LOGIN_PAGE_PATHS = {
  login: '/kuku/login',
  poll: '/kuku/poll',
  reload: '/kuku/reload',
} as const

/** 登录超时：与其它渠道一致，10 分钟。 */
export const KUKU_LOGIN_TIMEOUT_MS = 10 * 60_000

/** 上游二维码有效期约 3 分钟，页面据此提示刷新。 */
const KUKU_QR_TTL_SECONDS = 180

/** 已启动的登录流程。 */
export interface StartedKukuLoginFlow {
  loginUrl: string
  result: Promise<KukuCredential>
  close: () => Promise<void>
}

interface FlowState {
  session: KukuQrSession
  qrDataUrl: string
}

/** 申请一次二维码（含取图重试）。 */
async function freshSession(fetcher: typeof fetch, passportBase?: string): Promise<FlowState> {
  const options = passportBase === undefined ? { fetcher } : { fetcher, passportBase }
  const session = await requestKukuQrCode(options)
  const image = await fetchKukuQrImage(session, options)
  return { session, qrDataUrl: image.dataUrl }
}

/** 启动一次扫码登录流程。 */
export async function startKukuLoginFlow(options: {
  fetcher: typeof fetch
  /** 仅测试注入：passport 基址覆盖。 */
  passportBase?: string
  timeoutMs?: number
}): Promise<StartedKukuLoginFlow> {
  const { fetcher, passportBase } = options
  const flowOptions = passportBase === undefined ? { fetcher } : { fetcher, passportBase }
  let state = await freshSession(fetcher, passportBase)

  let resolveResult!: (value: KukuCredential) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<KukuCredential>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  result.catch(() => {})

  let settled = false
  const settleOk = (value: KukuCredential): void => {
    if (settled) return
    settled = true
    resolveResult(value)
  }
  const settleErr = (error: unknown): void => {
    if (settled) return
    settled = true
    rejectResult(error)
  }

  // 同一时刻只允许一个长轮询在飞（页面 1.2s 一轮，上游一次挂 30s）。
  let polling = false

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')

    if (url.pathname === KUKU_LOGIN_PAGE_PATHS.login) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(renderKukuQrPage({
        qrDataUrl: state.qrDataUrl,
        pollPath: KUKU_LOGIN_PAGE_PATHS.poll,
        reloadPath: KUKU_LOGIN_PAGE_PATHS.reload,
        ttlSeconds: KUKU_QR_TTL_SECONDS,
      }))
      return
    }

    if (url.pathname === KUKU_LOGIN_PAGE_PATHS.reload) {
      try {
        state = await freshSession(fetcher, passportBase)
        response.writeHead(302, { Location: KUKU_LOGIN_PAGE_PATHS.login }).end()
      } catch (error) {
        writeJson(response, { state: 'expired', error: errorText(error) })
      }
      return
    }

    if (url.pathname === KUKU_LOGIN_PAGE_PATHS.poll) {
      if (settled) return writeJson(response, { state: 'confirmed' })
      if (polling) return writeJson(response, { state: 'pending' })
      polling = true
      try {
        const polled = await pollKukuQrStatus(state.session, flowOptions)
        if (polled.state === 'confirmed' && polled.ticket !== undefined) {
          // ticket → BDUSS/STOKEN 的交换放在这里做：页面只拿到状态，拿不到凭据。
          const completed = await completeKukuQrLogin(state.session, polled.ticket, flowOptions)
          settleOk(completed.credential)
          writeJson(response, { state: 'confirmed' })
          return
        }
        writeJson(response, { state: polled.state })
      } catch (error) {
        // 二维码过期 / 上游错误：让页面停下并显示刷新按钮，同时让 RPC 侧清掉占位账号。
        settleErr(error)
        writeJson(response, { state: 'expired', error: errorText(error) })
      } finally {
        polling = false
      }
      return
    }

    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      try {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end(errorText(error))
      } catch { /* 响应可能已发出 */ }
    })
  })

  const port = await listenOnRandomPort(server)
  const loginUrl = `http://127.0.0.1:${port}${KUKU_LOGIN_PAGE_PATHS.login}`

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    settleErr(new Error('kuku: 登录流程已关闭'))
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
  }

  const timeoutMs = options.timeoutMs ?? KUKU_LOGIN_TIMEOUT_MS
  const timer = setTimeout(() => {
    settleErr(new Error(`kuku: 登录超时（${Math.round(timeoutMs / 1000)} 秒内未完成）`))
  }, timeoutMs)
  timer.unref?.()

  void result.catch(() => {}).finally(() => {
    clearTimeout(timer)
    if (!closed) {
      closed = true
      server.closeAllConnections?.()
      void new Promise<void>((resolve) => { server.close(() => resolve()) })
    }
  })

  return { loginUrl, result, close }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function writeJson(response: ServerResponse, payload: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

function listenOnRandomPort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'object' && address !== null) resolve(address.port)
      else reject(new Error('无法获取本地端口'))
    })
  })
}
