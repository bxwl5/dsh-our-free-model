/**
 * 百智云（baizhi.cloud）**微信扫码登录** —— 卡片内嵌形态。
 *
 * ## 协议来源（权威）
 *
 * 官方桌面端 `chaitin/MonkeyCode` → `desktop/src/baizhi/wechat.rs`，注释写明是
 * `agent/internal/baizhi/wechat.go` 的 Rust 移植，用的是**微信网页版 qrconnect
 * 协议**（多年稳定）。本文件是该流程的 TypeScript 纯 HTTP 移植，零依赖。
 *
 * ```
 * 1. GET  {bz}/api/v1/user/oauth/login?platform=wechat&redirect_url={bz}/
 *         → { data: { url: "https://open.weixin.qq.com/connect/qrconnect?..." } }
 * 2. GET  授权页 HTML → 正则 /connect/qrcode/([A-Za-z0-9_-]+) 取 uuid
 * 3. GET  {授权页域}/connect/qrcode/{uuid} → JPEG 二维码（转 data URL 下发卡片）
 * 4. GET  https://lp.open.weixin.qq.com/connect/l/qrconnect?uuid={uuid}&_={ts}
 *         → `window.wx_errcode=408;window.wx_code='';`（微信侧最长挂 ~25s）
 *         408 待扫码 / 404 已扫待确认 / 403 取消 / 402|500 过期 / 405 确认（带 wx_code）
 * 5. 405 时 GET {redirect_uri}?code={wx_code}&state={state}（不跟随 302）
 *         → 首响应 Set-Cookie 即百智云会话（baizhi_session / sl-session）
 * 6. GET  {bz}/api/v1/user/profile（带新 cookie）确认登录真的建立
 * ```
 *
 * ⚠️ 这里只负责拿到**百智云会话 cookie**。MonkeyCode 自己的
 *    `monkeycode_ai_session` 由调用方拿这份 cookie 走
 *    {@link loginWithBaizhiSession}（`monkeycode-auth.ts`，OIDC 桥接）换出，
 *    适配器/对话/签到全不用改。
 *
 * ⚠️ 与 kuku 一样：本地页在远程浏览器（DSH 在 NAS）打不开，故二维码以
 *    data URL 直接渲染进渠道卡片，轮询/刷新走 DSH 自己的 HTTP 路由。
 */

import { MONKEYCODE_BAIZHI_BASE } from './monkeycode-auth.js'

/** 长轮询基址：微信开放平台固定 `lp.` 前缀（官方 wechat.rs 同款推导）。 */
const WECHAT_LP_BASE = 'https://lp.open.weixin.qq.com'
/** 一次扫码会话有效期（与卡片 10 分钟窗口一致，见 qr-login-page）。 */
export const MONKEYCODE_QR_TIMEOUT_MS = 10 * 60_000

/** 微信授权页里二维码 uuid 的抓取正则。 */
const QRCODE_UUID_RE = /\/connect\/qrcode\/([A-Za-z0-9_-]+)/
/** 长轮询应答里 errcode / code 的抓取正则。 */
const WX_ERRCODE_RE = /wx_errcode=(\d+)/
const WX_CODE_RE = /wx_code='([^']*)'/

/** 扫码状态（卡片据此展示提示，expired 时自动换码）。 */
export type MonkeyCodeQrState =
  | { state: 'pending' }
  | { state: 'scanned' }
  | { state: 'canceled' }
  | { state: 'expired' }
  | { state: 'confirmed' }

/** 一次扫码会话的内部状态。 */
export interface MonkeyCodeQrSession {
  uuid: string
  state: string
  /** 百智云回调地址（不含 code/state）。 */
  callbackUrl: string
  /** 授权页域名，用于取二维码图。 */
  qrBase: string
}

/** 扫码登录结果：百智云完整 Cookie 串（供 OIDC 桥接换 MonkeyCode 会话）。 */
export interface MonkeyCodeQrResult {
  baizhiCookie: string
}

/** 只做最小 URL 编码（官方 wechat.rs 同款：仅字母数字与 -_.~ 保留）。 */
function urlEncode(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i)
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57)
      || c === 45 || c === 95 || c === 46 || c === 126) out += s[i]
    else out += `%${c.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

/** 把 Set-Cookie 列表收进 cookie 罐（同名覆盖）。 */
function absorbSetCookie(jar: Map<string, string>, response: Response): void {
  const list = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : []
  for (const raw of list) {
    const pair = (raw.split(';')[0] ?? '').trim()
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

/** 统一的网络/协议错误。 */
function fail(message: string): never {
  throw new Error(`MonkeyCode 扫码登录：${message}`)
}

/**
 * 启动一次扫码会话：取授权页 → 解析 uuid → 拉二维码图 → 返回 data URL + 会话。
 */
export async function startMonkeyCodeQrLogin(options: {
  fetcher: typeof fetch
  /** 仅测试注入：百智云基址覆盖。 */
  baizhiBase?: string
  /** 仅测试注入：微信长轮询基址覆盖（官方 wechat.rs 的 MC_DESKTOP_WECHAT_LP_BASE）。 */
  lpBase?: string
}): Promise<{ qrDataUrl: string; session: MonkeyCodeQrSession }> {
  const { fetcher } = options
  const bz = (options.baizhiBase ?? MONKEYCODE_BAIZHI_BASE).replace(/\/+$/, '')
  const redirect = urlEncode(`${bz}/`)

  // 1. 授权页地址
  const loginUrl = `${bz}/api/v1/user/oauth/login?platform=wechat&redirect_url=${redirect}`
  const first = await fetcher(loginUrl, { method: 'GET', headers: { Accept: 'application/json' } })
  if (!first.ok) fail(`获取微信授权地址失败（HTTP ${first.status}）`)
  const envelope = await first.json() as { data?: { url?: unknown } }
  const authUrlStr = typeof envelope?.data?.url === 'string' ? envelope.data.url : ''
  if (authUrlStr === '') fail('微信授权地址为空')

  let authUrl: URL
  try { authUrl = new URL(authUrlStr) } catch { fail(`微信授权地址异常：${authUrlStr}`) }
  const state = authUrl.searchParams.get('state') ?? ''
  const callbackUrl = authUrl.searchParams.get('redirect_uri') ?? ''
  if (state === '' || callbackUrl === '') fail('微信授权地址缺少 state/redirect_uri')
  const qrBase = `${authUrl.protocol}//${authUrl.host}`

  // 2. 拉授权页取 uuid
  const page = await fetcher(authUrlStr, {
    method: 'GET',
    headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0' },
  })
  if (!page.ok) fail(`加载微信授权页失败（HTTP ${page.status}）`)
  const html = await page.text()
  const uuid = QRCODE_UUID_RE.exec(html)?.[1]
  if (uuid === undefined) fail('微信授权页里没找到二维码（页面结构可能已变化）')

  // 3. 二维码图片 → data URL
  const img = await fetcher(`${qrBase}/connect/qrcode/${uuid}`, {
    method: 'GET',
    headers: { Accept: 'image/jpeg', Referer: authUrlStr },
  })
  if (!img.ok) fail(`获取微信二维码失败（HTTP ${img.status}）`)
  const bytes = new Uint8Array(await img.arrayBuffer())
  // 分块 btoa，避免大数组展开导致栈溢出
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  const contentType = img.headers.get('content-type') || 'image/jpeg'
  const qrDataUrl = `data:${contentType};base64,${btoa(binary)}`

  return {
    qrDataUrl,
    session: { uuid, state, callbackUrl, qrBase },
  }
}

/**
 * 长轮询一次扫码状态。确认成功时就地完成百智云回调，返回百智云 Cookie。
 *
 * ⚠️ 微信侧一次最长挂 ~25s；调用方（RPC 路由）应做单飞合并，卡片间隔 ≥1.5s。
 */
export async function pollMonkeyCodeQrLogin(options: {
  fetcher: typeof fetch
  session: MonkeyCodeQrSession
  baizhiBase?: string
  lpBase?: string
}): Promise<{ state: MonkeyCodeQrState['state']; baizhiCookie?: string }> {
  const { fetcher, session } = options
  const bz = (options.baizhiBase ?? MONKEYCODE_BAIZHI_BASE).replace(/\/+$/, '')
  const lpBase = (options.lpBase ?? WECHAT_LP_BASE).replace(/\/+$/, '')

  const lpUrl = `${lpBase}/connect/l/qrconnect?uuid=${urlEncode(session.uuid)}&_=${Date.now()}`
  const response = await fetcher(lpUrl, {
    method: 'GET',
    headers: { Accept: '*/*', Referer: `${session.qrBase}/` },
  })
  const text = await response.text()
  const errcode = Number(WX_ERRCODE_RE.exec(text)?.[1] ?? 'NaN')
  if (!Number.isFinite(errcode)) fail(`扫码状态响应异常：${text.slice(0, 120)}`)

  switch (errcode) {
    case 408: return { state: 'pending' }
    case 404: return { state: 'scanned' }
    case 403: return { state: 'canceled' }
    case 402:
    case 500: return { state: 'expired' }
    case 405: {
      const code = WX_CODE_RE.exec(text)?.[1] ?? ''
      if (code === '') fail('扫码确认成功但未返回授权码')
      const baizhiCookie = await completeWechatCallback(fetcher, session, code, bz)
      return { state: 'confirmed', baizhiCookie }
    }
    default: fail(`未知扫码状态 wx_errcode=${errcode}`)
  }
}

/** 用 wx_code 走百智云回调换会话，并以 profile 探测确认。 */
async function completeWechatCallback(
  fetcher: typeof fetch,
  session: MonkeyCodeQrSession,
  code: string,
  bz: string,
): Promise<string> {
  const jar = new Map<string, string>()
  const cb = new URL(session.callbackUrl)
  cb.searchParams.set('code', code)
  cb.searchParams.set('state', session.state)
  // 不跟随 302：Set-Cookie 在首响应即被吸收（官方 wechat.rs 同款）。
  const response = await fetcher(cb.toString(), { method: 'GET', redirect: 'manual' })
  absorbSetCookie(jar, response)
  if (response.status >= 400) {
    const body = await response.text().catch(() => '')
    fail(`微信登录回调被拒（HTTP ${response.status}）${body.slice(0, 120)}`)
  }
  // 回调可能 302 到 redirect_url，中间链路的 cookie 也要收。
  let hops = 0
  let current = response.headers.get('location')
  while (current !== null && current !== '' && hops < 6) {
    const next = new URL(current, bz).toString()
    const hop = await fetcher(next, { method: 'GET', redirect: 'manual', headers: { Cookie: cookieHeader(jar) } })
    absorbSetCookie(jar, hop)
    current = hop.headers.get('location')
    hops += 1
  }
  const cookie = cookieHeader(jar)
  if (!/(?:^|;\s*)baizhi_session\s*=/.test(cookie)) {
    fail('微信登录回调未下发 baizhi_session 会话')
  }
  // 权威确认：会话真的建立了（官方 wechat.rs 的 status()）。
  const profile = await fetcher(`${bz}/api/v1/user/profile`, {
    method: 'GET', headers: { Cookie: cookie, Accept: 'application/json' },
  })
  if (profile.status === 401 || profile.status === 403) {
    fail('微信登录未生效（回调已走通但会话无效）')
  }
  return cookie
}
