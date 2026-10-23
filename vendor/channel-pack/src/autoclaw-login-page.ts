/**
 * AutoClaw（国内站）本地登录页 —— 手机号 + 短信验证码。
 *
 * 范式照 `raccoon-login-page.ts`：
 *
 * ```
 * 本地服务器（127.0.0.1:随机端口）
 *   GET  /autoclaw/login       → 弹窗页（手机号 → 发送验证码 → 输入验证码）
 *   POST /autoclaw/sms/send    → 发码（宿主侧调上游；页面只传手机号）
 *   POST /autoclaw/sms/verify  → 提交验证码完成登录
 * ```
 *
 * 对外仍返回 `loginUrl`（指向本地页），前端照常 `window.open` + `login.poll`
 * —— 与 codearts / lobsterai / qoder / loomy / raccoon 的「两步式」完全一致，
 * **客户端无需任何改动**。
 *
 * ## 职责边界（安全）
 *
 * - 宿主侧持有手机号、`device_id` 与凭据；页面只做表单提交，看不到 token。
 * - 短信是**真实副作用**：只有用户在页面上点「发送验证码」才会触发，且有 60 秒冷却。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AutoClawCredential } from './autoclaw.js'
import type { AutoClawProduct } from './autoclaw-product.js'
import {
  loginAutoclawWithCode,
  normalizeAutoclawPhone,
  sendAutoclawCode,
} from './autoclaw-sms.js'

/** 本地页路径。 */
export const AUTOCLAW_LOGIN_PAGE_PATHS = {
  login: '/autoclaw/login',
  smsSend: '/autoclaw/sms/send',
  smsVerify: '/autoclaw/sms/verify',
} as const

/** 登录超时：与其它渠道一致，10 分钟。 */
export const AUTOCLAW_LOGIN_TIMEOUT_MS = 10 * 60_000

/** 已启动的登录流程。 */
export interface StartedAutoclawLoginFlow {
  /** 指向本地页的 URL，调用方 `window.open` 它。 */
  loginUrl: string
  /** 登录成功时以凭据 resolve；超时/关闭/用户取消时 reject。 */
  result: Promise<AutoClawCredential>
  close: () => Promise<void>
}

interface FlowState {
  phone: string
}

/** 启动一次短信登录流程。 */
export async function startAutoclawLoginFlow(options: {
  product: AutoClawProduct
  fetcher: typeof fetch
  deviceId: string
  timeoutMs?: number
}): Promise<StartedAutoclawLoginFlow> {
  const { product, fetcher, deviceId } = options
  const state: FlowState = { phone: '' }

  let resolveResult!: (value: AutoClawCredential) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<AutoClawCredential>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  // 先挂空处理器：用户可能极快关闭弹窗，这个 promise 会在被消费前 reject。
  result.catch(() => {})

  let settled = false
  const settleOk = (value: AutoClawCredential): void => {
    if (settled) return
    settled = true
    resolveResult(value)
  }
  const settleErr = (error: unknown): void => {
    if (settled) return
    settled = true
    rejectResult(error)
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response, { state, product, fetcher, deviceId, settleOk }).catch(
      (error: unknown) => {
        try {
          response
            .writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
            .end(`内部错误：${error instanceof Error ? error.message : String(error)}`)
        } catch { /* 响应可能已发出 */ }
      },
    )
  })

  const port = await listenOnRandomPort(server)
  const loginUrl = `http://127.0.0.1:${port}${AUTOCLAW_LOGIN_PAGE_PATHS.login}`

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    settleErr(new Error('autoclaw: 登录流程已关闭'))
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
  }

  const timeoutMs = options.timeoutMs ?? AUTOCLAW_LOGIN_TIMEOUT_MS
  const timer = setTimeout(() => {
    settleErr(new Error(`autoclaw: 登录超时（${Math.round(timeoutMs / 1000)} 秒内未完成）`))
  }, timeoutMs)
  timer.unref?.()

  void result.catch(() => {}).finally(() => {
    clearTimeout(timer)
    if (!closed) {
      closed = true
      void new Promise<void>((resolve) => { server.close(() => resolve()) })
    }
  })

  return { loginUrl, result, close }
}

interface HandleDeps {
  state: FlowState
  product: AutoClawProduct
  fetcher: typeof fetch
  deviceId: string
  settleOk: (value: AutoClawCredential) => void
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: HandleDeps,
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${request.socket.localPort ?? 0}`)

  if (url.pathname === AUTOCLAW_LOGIN_PAGE_PATHS.login) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(renderAutoclawLoginPage(deps.product))
    return
  }

  if (url.pathname === AUTOCLAW_LOGIN_PAGE_PATHS.smsSend && request.method === 'POST') {
    const body = await readJsonBody(request)
    const phone = normalizeAutoclawPhone(typeof body.phone === 'string' ? body.phone : '')
    if (phone === '') {
      writeJson(response, { ok: false, message: '请输入有效的 11 位手机号（可带 +86）' })
      return
    }
    const sent = await sendAutoclawCode({ product: deps.product, fetcher: deps.fetcher, phone, deviceId: deps.deviceId })
    if (!sent.ok) {
      // 单步失败不终止流程：让页面就地提示并允许重试。
      writeJson(response, { ok: false, message: sent.error })
      return
    }
    // 只在发送成功后才记住手机号，避免后续 verify 用一个没收到码的号码。
    deps.state.phone = phone
    writeJson(response, { ok: true })
    return
  }

  if (url.pathname === AUTOCLAW_LOGIN_PAGE_PATHS.smsVerify && request.method === 'POST') {
    const body = await readJsonBody(request)
    const code = typeof body.code === 'string' ? body.code.trim() : ''
    if (deps.state.phone === '') {
      writeJson(response, { ok: false, message: '请先获取手机验证码' })
      return
    }
    if (code === '') {
      writeJson(response, { ok: false, message: '请输入验证码' })
      return
    }
    const login = await loginAutoclawWithCode({
      product: deps.product,
      fetcher: deps.fetcher,
      phone: deps.state.phone,
      code,
      deviceId: deps.deviceId,
    })
    if (!login.ok) {
      writeJson(response, { ok: false, message: login.error })
      return
    }
    deps.settleOk(login.credential)
    writeJson(response, { ok: true })
    return
  }

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
}

function writeJson(response: ServerResponse, payload: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 64 * 1024) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
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

/** 渲染登录页：单文件、无外部依赖（不引 CDN、不引脚本库）。 */
export function renderAutoclawLoginPage(product: AutoClawProduct): string {
  const title = product.displayName ?? 'AutoClaw'
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} 登录</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 14px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; background: #0f1115; color: #e6e8ee; }
  .card { width: min(360px, 92vw); padding: 24px; border-radius: 14px; background: #171a21; box-shadow: 0 12px 40px rgba(0,0,0,.45); }
  h1 { font-size: 17px; margin: 0 0 4px; }
  p.sub { margin: 0 0 18px; color: #9aa3b2; font-size: 12px; }
  label { display: block; font-size: 12px; color: #9aa3b2; margin: 12px 0 6px; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border-radius: 9px; border: 1px solid #2b3040; background: #0f1319; color: inherit; font-size: 14px; }
  .row { display: flex; gap: 8px; margin-top: 16px; }
  button { flex: 1; padding: 10px 12px; border-radius: 9px; border: 0; font-size: 14px; cursor: pointer; background: #3d5afe; color: #fff; }
  button:disabled { opacity: .55; cursor: not-allowed; }
  button.ghost { background: #232838; color: #cfd6e4; flex: 0 0 auto; }
  .status { min-height: 20px; margin-top: 14px; font-size: 12px; color: #9aa3b2; }
  .status.ok { color: #4ade80; }
  .status.err { color: #f87171; }
</style>
</head>
<body>
<div class="card">
  <h1>${title} 登录</h1>
  <p class="sub">用手机号接收短信验证码，全程在本机完成，不会上传任何凭据。</p>
  <label for="phone">手机号</label>
  <input id="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="13800000000">
  <div class="row">
    <button id="send" type="button">发送验证码</button>
  </div>
  <label for="code">短信验证码</label>
  <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="6 位数字">
  <div class="row">
    <button id="verify" type="button">登录</button>
    <button id="cancel" class="ghost" type="button">关闭</button>
  </div>
  <div id="status" class="status" role="status"></div>
</div>
<script>
const paths = ${JSON.stringify(AUTOCLAW_LOGIN_PAGE_PATHS)}
const status = document.getElementById('status')
const send = document.getElementById('send')
const verify = document.getElementById('verify')
const phone = document.getElementById('phone')
const code = document.getElementById('code')
function say(text, kind) { status.textContent = text; status.className = 'status' + (kind ? ' ' + kind : '') }
let cooldown = 0
let timer = null
function startCooldown() {
  cooldown = 60
  send.disabled = true
  send.textContent = cooldown + ' 秒后重发'
  timer = setInterval(() => {
    cooldown -= 1
    if (cooldown <= 0) { clearInterval(timer); send.disabled = false; send.textContent = '发送验证码'; return }
    send.textContent = cooldown + ' 秒后重发'
  }, 1000)
}
send.addEventListener('click', async () => {
  if (cooldown > 0) return
  say('正在发送…')
  try {
    const response = await fetch(paths.smsSend, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: phone.value }) })
    const data = await response.json()
    if (data.ok) { say('验证码已发送，请查收短信', 'ok'); startCooldown() } else { say(data.message || '发送失败', 'err') }
  } catch (error) { say('发送失败：' + error, 'err') }
})
verify.addEventListener('click', async () => {
  say('正在登录…')
  try {
    const response = await fetch(paths.smsVerify, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code.value }) })
    const data = await response.json()
    if (data.ok) { say('登录成功，本页即将关闭', 'ok'); setTimeout(() => window.close(), 800) } else { say(data.message || '登录失败', 'err') }
  } catch (error) { say('登录失败：' + error, 'err') }
})
document.getElementById('cancel').addEventListener('click', () => window.close())
</script>
</body>
</html>`
}
