/**
 * Raccoon Work 本地登录页（宿主侧承载弹窗页）。
 *
 * ## 为什么需要本地服务器
 *
 * 官方桌面端的登录靠 `office-raccoon://auth/callback` 自定义协议回调，
 * 而本插件是宿主侧 Node 进程，**收不到该回调**；`/code/authorize` 页面的
 * 回调地址又是写死的，改不成 localhost。故改为：
 *
 * ```
 * 本地服务器（127.0.0.1:随机端口）
 *   GET  /raccoon/login       → 弹窗页：Tab 切换「微信扫码 / 短信登录」
 *   GET  /raccoon/poll        → 前端轮询登录状态（宿主侧持有 qrcode_code）
 *   POST /raccoon/sms/send    → 提交手机号 + 阿里云 captcha_param
 *   POST /raccoon/sms/verify  → 提交验证码完成登录
 * ```
 *
 * 微信扫码的 `code` 由**宿主侧本地随机生成**（实测服务端接受任意自造 code
 * 并进入 `pending`），完全绕开那个收不到的自定义协议回调。
 *
 * ## 与其余 provider 的契约一致性
 *
 * 对外仍返回 `loginUrl`（指向本地 `/raccoon/login`），前端照常 `window.open`
 * —— 与 codearts / lobsterai / qoder / trae / cline / loomy 的「两步式」
 * 体验完全一致。
 *
 * ## ⚠️ 职责边界（安全约束）
 *
 * - **宿主侧**持有全部敏感状态：`qrcode_code`、手机号、凭据
 * - **页面侧**只做展示与表单提交：**不知道** `phoneCipherSecret`、token 等秘密
 * - 二维码由**宿主侧**生成 SVG 内联进 HTML（页面不需要任何 QR 逻辑，也不需要 CDN）
 * - 手机号加密在宿主侧的 `/raccoon/sms/send` 里完成
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  RACCOON_LOGIN_TIMEOUT_MS,
  type RaccoonCredential,
} from './raccoon.js'
import {
  buildRaccoonAuthorizeUrl,
  buildRaccoonScanUrl,
  createRaccoonQrSession,
  exchangeRaccoonAuthorizationCode,
  loginRaccoonWithSmsCode,
  pollRaccoonQrSession,
  sendRaccoonSmsCode,
} from './raccoon-oauth.js'
import { RACCOON, type RaccoonProduct } from './raccoon-product.js'
import { renderQrSvg } from './raccoon-qr.js'

/** 本地登录页的路径。 */
export const RACCOON_LOGIN_PAGE_PATHS = {
  login: '/raccoon/login',
  poll: '/raccoon/poll',
  smsSend: '/raccoon/sms/send',
  smsVerify: '/raccoon/sms/verify',
  /** OAuth 授权页的回调落点（`desktop_callback=loopback` 指向这里）。 */
  authCallback: '/auth/callback',
} as const

/** 一次登录流程的句柄。 */
export interface StartedRaccoonLoginFlow {
  /** 弹窗地址（本地服务器）。 */
  loginUrl: string
  /** 登录结果（凭据）。 */
  result: Promise<RaccoonCredential>
  /** 主动关闭本地服务器。 */
  close: () => Promise<void>
}

/** 流程内部状态（**只存在于宿主侧**）。 */
interface FlowState {
  /** 服务端下发的扫码 code（宿主侧持有，页面不知道）。 */
  qrCode: string
  /** 服务端下发的扫码路径（申请失败时为 undefined）。 */
  scanPath: string | undefined
  /** 扫码是否确认不可用（接口失败 / 上游扫码页 404）—— 面板据此提示改用短信登录。 */
  qrUnavailable: boolean
  /** 当前展示的短信目标手机号（未发过短信时为空）。 */
  phone: string
  /** 最近一次轮询的二维码有效期（供页面展示倒计时）。 */
  lastExpiredAt: string | undefined
  /**
   * OAuth 授权流程的 `state`（32 字节 hex）。
   *
   * 授权页要求 loopback 回调的 `state` 必须是 **64 位 hex**，否则拒绝
   * （见 `buildRaccoonAuthorizeUrl` 的注释）。回调时逐字比对，不符即拒绝 ——
   * 这是防「别人的回调链接被塞进来」的唯一凭据。
   */
  oauthState: string
}

/** 二维码内容：服务端 `scan_path` + `code/appname/source`（与官方前端一致）。 */
function qrContentUrl(product: RaccoonProduct, state: FlowState): string {
  if (state.scanPath === undefined) return ''
  return buildRaccoonScanUrl(product, {
    qrcodeCode: state.qrCode,
    scanPath: state.scanPath,
    expiresIn: 300,
    pollInterval: 2,
  })
}

/** `startRaccoonLoginFlow` 的选项。 */
export interface RaccoonLoginFlowOptions {
  product?: RaccoonProduct
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 超时（毫秒）。 */
  timeoutMs?: number
}

/**
 * 启动登录流程。
 *
 * 立即返回 `loginUrl` 与 `result` promise，**不阻塞** —— 与其余 provider 的
 * 「两步式」约束一致（`window.open` 只在用户手势窗口内有效）。
 */
export async function startRaccoonLoginFlow(
  options: RaccoonLoginFlowOptions = {},
): Promise<StartedRaccoonLoginFlow> {
  const product = options.product ?? RACCOON
  const fetcher = options.fetcher ?? fetch
  // 旧「本地随机 code + /login/mp」链路已随上游迁移失效（2026-10-24 实测该页对任何 code 都 404），
  // 故扫码只走服务端下发 code 的新接口；申请失败就如实标记「扫码不可用」，短信仍可用。
  const session = await createRaccoonQrSession(product, fetcher)
  const { randomBytes } = await import('node:crypto')
  const state: FlowState = {
    qrCode: session?.qrcodeCode ?? '',
    scanPath: session?.scanPath,
    qrUnavailable: session === undefined,
    phone: '',
    lastExpiredAt: undefined,
    // 64 位 hex（32 字节）—— 授权页对 loopback 回调的硬性要求。
    oauthState: randomBytes(32).toString('hex'),
  }
  // 探测扫码落地页：只有拿到**明确的非 2xx** 才判定不可用（网络异常不误报）。
  if (state.scanPath !== undefined) {
    try {
      const probe = await fetcher(qrContentUrl(product, state), {
        method: 'GET',
        signal: AbortSignal.timeout(8000),
      })
      state.qrUnavailable = probe.status >= 400
    } catch { /* 探测失败按「可用」处理，避免误报 */ }
  }

  let resolveResult!: (value: RaccoonCredential) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<RaccoonCredential>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  // 先挂空处理器：这个 promise 可能在被消费前就 reject（用户极快失败/立刻关闭），
  // 那一段窗口里 Node 会报 unhandled rejection（与 loomy-wechat-login 同因）。
  result.catch(() => {})

  let settled = false
  let settledOk = false
  const settleOk = (value: RaccoonCredential): void => {
    if (settled) return
    settled = true
    settledOk = true
    resolveResult(value)
  }
  const settleErr = (error: unknown): void => {
    if (settled) return
    settled = true
    rejectResult(error)
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response, {
      state, product, fetcher, settleOk, settleErr,
      isSettledOk: () => settledOk,
    }).catch(
      (error: unknown) => {
        try {
          response
            .writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
            .end(`内部错误：${error instanceof Error ? error.message : String(error)}`)
        } catch {
          // 响应可能已发出，忽略
        }
      },
    )
  })

  const port = await listenOnRandomPort(server)
  const loginUrl = `http://127.0.0.1:${port}${RACCOON_LOGIN_PAGE_PATHS.login}`

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    // 尚未落定则先 reject，避免调用方拿到一个永远悬挂的 promise。
    settleErr(new Error('raccoon: 登录流程已关闭'))
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }

  const timeoutMs = options.timeoutMs ?? RACCOON_LOGIN_TIMEOUT_MS
  const timer = setTimeout(() => {
    settleErr(new Error(`raccoon: 登录超时（${Math.round(timeoutMs / 1000)} 秒内未完成）`))
  }, timeoutMs)
  timer.unref?.()

  // 结果落定即关服务器（含超时与失败路径）。
  void result
    .catch(() => {})
    .finally(() => {
      clearTimeout(timer)
      if (!closed) {
        closed = true
        void new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
      }
    })

  return { loginUrl, result, close }
}

/** 一次请求的依赖集合。 */
interface HandleDeps {
  state: FlowState
  product: RaccoonProduct
  fetcher: typeof fetch
  settleOk: (value: RaccoonCredential) => void
  /** 失败落定（OAuth 回调里的拒绝 / 换码失败都要立刻结束，而不是等超时）。 */
  settleErr: (error: unknown) => void
  /** 是否已成功落定（页面轮询据此停止）。 */
  isSettledOk: () => boolean
}

/** 处理一次本地请求。 */
async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: HandleDeps,
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${request.socket.localPort ?? 0}`)
  const { state, product } = deps

  /**
   * OAuth 授权回调（`desktop_callback=loopback` 的落点）。
   *
   * 授权页在用户点「授权」后把浏览器 302 到
   * `http://127.0.0.1:<port>/auth/callback?code=...&state=...`，
   * 本处理器用 `code` 换凭据并落定登录结果 —— **用户无需填验证码、
   * 也无需复制任何地址**（这是相对扫码/短信的核心改进）。
   *
   * ⚠️ 安全约束（照 magpie 的同款实现）：
   * - `state` 必须**逐字等于**本次流程生成的值，否则 400（防伪造回调）；
   * - `code` 只接受一个、非空、长度 ≤ 4096；
   * - 响应带 `no-store` 与严格 CSP，且不回显任何 token。
   */
  if (url.pathname === RACCOON_LOGIN_PAGE_PATHS.authCallback) {
    const reply = (status: number, text: string): void => {
      response.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'",
      })
      response.end(text)
    }
    if (request.method !== 'GET') { reply(405, '仅支持 GET'); return }
    const query = url.searchParams
    const gotState = query.getAll('state')
    if (gotState.length !== 1 || gotState[0] !== state.oauthState) {
      reply(400, '回调不属于本次登录，请回到登录页重试。')
      return
    }
    if (query.get('error') !== null) {
      reply(400, '登录未获授权，请回到登录页重试。')
      deps.settleErr(new Error('raccoon: 授权被拒绝'))
      return
    }
    const codes = query.getAll('code')
    const code = codes[0] ?? ''
    if (codes.length !== 1 || code === '' || code.length > 4096) {
      reply(400, '回调缺少有效授权码，请回到登录页重试。')
      return
    }
    try {
      const credential = await exchangeRaccoonAuthorizationCode(product, code, deps.fetcher)
      reply(200, '商汤小浣熊登录成功，可以关闭此页。')
      deps.settleOk(credential)
    } catch (error) {
      reply(502, `登录未完成：${error instanceof Error ? error.message : String(error)}`)
      deps.settleErr(error)
    }
    return
  }

  if (url.pathname === RACCOON_LOGIN_PAGE_PATHS.login) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    const port = request.socket.localPort ?? 0
    response.end(renderRaccoonLoginPage(product, {
      authorizeUrl: buildRaccoonAuthorizeUrl(product, {
        state: state.oauthState,
        redirectUri: `http://127.0.0.1:${port}${RACCOON_LOGIN_PAGE_PATHS.authCallback}`,
      }),
    }))
    return
  }

  if (url.pathname === RACCOON_LOGIN_PAGE_PATHS.poll) {
    // OAuth 流程下页面只需知道「还没好 / 成功 / 失败」；成功由 /auth/callback
    // 里的 settleOk 落定，本端点不再承担换凭据的职责。
    writeJson(response, { status: deps.isSettledOk() ? 'success' : 'pending' })
    return
  }
  if (url.pathname === RACCOON_LOGIN_PAGE_PATHS.smsSend && request.method === 'POST') {
    const body = await readJsonBody(request)
    const phone = typeof body.phone === 'string' ? body.phone.trim() : ''
    const captchaParam = typeof body.captchaParam === 'string' ? body.captchaParam : ''
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, message: '请输入有效的 11 位手机号' }))
      return
    }
    try {
      await sendRaccoonSmsCode(product, phone, captchaParam, deps.fetcher)
      // 只在发送成功后才记住手机号：否则后续 verify 会用一个没收到验证码的号码
      state.phone = phone
      writeJson(response, { ok: true })
    } catch (error) {
      // 单步失败**不终止**流程（用户可能只是滑块过期/验证码输错），
      // 把原因回给页面让它就地提示并允许重试。
      writeJson(response, {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      })
    }
    return
  }

  if (url.pathname === RACCOON_LOGIN_PAGE_PATHS.smsVerify && request.method === 'POST') {
    const body = await readJsonBody(request)
    const smsCode = typeof body.smsCode === 'string' ? body.smsCode.trim() : ''
    if (state.phone.length === 0) {
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, message: '请先获取手机验证码' }))
      return
    }
    if (smsCode.length === 0) {
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, message: '请输入验证码' }))
      return
    }
    try {
      const credential = await loginRaccoonWithSmsCode(product, state.phone, smsCode, deps.fetcher)
      deps.settleOk(credential)
      writeJson(response, { ok: true })
    } catch (error) {
      writeJson(response, {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      })
    }
    return
  }

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
}

/** 写一个 JSON 响应。 */
function writeJson(response: ServerResponse, payload: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

/** 读取并解析请求体（上限 64KB，避免被塞爆）。 */
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > 64 * 1024) throw new Error('请求体过大')
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf-8')
  if (text.length === 0) return {}
  try {
    const parsed = JSON.parse(text) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/**
 * 在 `127.0.0.1` 的随机空闲端口上启动服务器。
 *
 * 绑 `127.0.0.1` 而非 `0.0.0.0`：弹窗页只可能来自本机浏览器，不对外暴露。
 */
function listenOnRandomPort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      if (port === 0) {
        reject(new Error('raccoon: 本地登录页服务器未能获得端口'))
        return
      }
      resolve(port)
    })
  })
}

/**
 * 渲染登录页 HTML。
 *
 * 导出以便单测断言页面结构（尤其是「不含任何密钥」这条安全约束）。
 *
 * ## 页面职责
 *
 * - 两个 Tab：微信扫码（默认）与短信登录
 * - 二维码由宿主侧生成的 **SVG 内联**进来（页面不需要 QR 逻辑，也不走 CDN）
 * - 每 2 秒轮询 `/raccoon/poll`（与官方客户端一致）
 * - 短信 Tab 加载阿里云滑块脚本，拿到 `captchaParam` 后提交
 *
 * @param qrCode 当前会话的扫码 code（宿主侧生成）。**注意**：本函数只是把它
 *   渲染成二维码 —— 页面拿不到 code 本身（它被编码进二维码图像里）。
 *   这符合职责边界：页面不需要知道 code，只需要展示。
 */
export function renderRaccoonLoginPage(
  product: RaccoonProduct,
  options: { authorizeUrl?: string } = {},
): string {
  /**
   * ## 为什么改成 OAuth 主导（2026-10-27）
   *
   * 之前的「微信扫码 + 短信」两条路都有实测问题：
   * - **扫码**：上游 `/login/mp` 改为服务端下发 code 后，旧链路对任何 code
   *   都回 404（见 `createRaccoonQrSession` 的注释），用户扫码后一直 pending；
   * - **短信**：需要阿里云滑块验证码，失败率高，且要多步手填。
   *
   * 现在改用官方桌面端的**网页授权**（OAuth 授权码 + loopback 回调）：
   * 用户点「去登录」→ 在新窗口完成登录并点「授权」→ 浏览器自动回到
   * 本地 `/auth/callback`，凭据由宿主侧直接拿下。**无需扫码、无需验证码、
   * 无需复制任何地址**（与 magpie 的 `browserSignIn` 同款链路）。
   *
   * 页面上不再有 Tab：只有一张说明卡 + 一个「去登录」按钮 + 轮询状态。
   * 授权 URL 由宿主侧生成（含 state 与 loopback redirect），页面拿不到秘密。
   */
  const authorizeUrl = options.authorizeUrl ?? ''
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Raccoon Work 登录</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: #f5f6f8; color: #1f2329; }
  .card { background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 4px 24px rgba(0,0,0,.08);
          text-align: center; width: 320px; }
  h1 { font-size: 16px; margin: 0 0 6px; }
  p.sub { font-size: 12px; color: #6b7280; margin: 0 0 18px; line-height: 1.6; }
  a.go { display: block; padding: 10px; border-radius: 8px; background: #1664ff; color: #fff;
         text-decoration: none; font-size: 14px; font-weight: 600; }
  a.go:hover { background: #0e54d8; }
  .status { margin-top: 14px; font-size: 12px; color: #6b7280; min-height: 18px; }
  .status[data-error="1"] { color: #d93025; }
  .steps { text-align: left; font-size: 12px; color: #6b7280; line-height: 1.9;
           background: #f8f9fb; border-radius: 8px; padding: 10px 12px; margin: 0 0 16px; }
</style>
</head>
<body>
<div class="card">
  <h1>登录 ${product.displayName}</h1>
  <p class="sub">将在新窗口完成网页授权，无需扫码或短信验证码</p>
  <div class="steps">
    1. 点下方按钮打开登录页<br>
    2. 完成登录并点「授权」<br>
    3. 浏览器自动返回，此处即刻完成
  </div>
  <a class="go" id="go" href="${authorizeUrl}" target="_blank" rel="noopener noreferrer">去登录</a>
  <div class="status" id="status">等待授权…</div>
</div>
<script>
(function () {
  var status = document.getElementById('status');
  var done = false;
  // 轮询登录状态：宿主侧在 /auth/callback 落定结果后，这里会拿到 success。
  function tick() {
    if (done) return;
    fetch(${JSON.stringify(RACCOON_LOGIN_PAGE_PATHS.poll)}).then(function (r) { return r.json(); }).then(function (data) {
      if (data && data.status === 'success') {
        done = true;
        status.setAttribute('data-error', '0');
        status.textContent = '登录成功，可以关闭此页';
        return;
      }
      if (data && data.status === 'failed') {
        done = true;
        status.setAttribute('data-error', '1');
        status.textContent = data.message || '登录失败，请重新点击「去登录」';
        return;
      }
      setTimeout(tick, 2000);
    }).catch(function () { setTimeout(tick, 3000); });
  }
  tick();
})();
</script>
</body>
</html>`
}