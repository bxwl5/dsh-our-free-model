/**
 * Raccoon Work 登录与续期的纯 API 层。
 *
 * ## 两条登录路径
 *
 * 1. **微信扫码**（首选）：`code` 由**客户端本地随机生成**，服务端只做轮询查询。
 *    实测任意自造 code 都被接受并进入 `pending`，故完全绕开官方那条
 *    `office-raccoon://auth/callback` 自定义协议回调 —— 那是本插件（宿主侧
 *    Node 进程）无法接收的。
 * 2. **短信验证码**（次选）：手机号需 AES-128-CFB 加密，且 `send_sms` 要求
 *    先过阿里云滑块拿到 `captcha_param`。
 *
 * ## 为什么不用官方桌面端的授权码链路
 *
 * `desktopLogin.js` 走「网页授权 → `office-raccoon://auth/callback?code=` →
 * `POST /login_with_authorization_code`」。回调地址在网页里是**写死的**，
 * 改不成 localhost，插件收不到回调。故该链路只保留 `exchangeRaccoonAuthorizationCode`
 * 供将来（如支持自定义协议的环境）复用。
 *
 * ## 本模块是纯 API 层
 *
 * 不含本地 HTTP 服务器（那是 `raccoon-login-page.ts` 的职责），
 * 也不做凭据持久化（那是 `raccoon-auth.ts` 的职责）。全部函数可离线单测。
 */

import { randomBytes } from 'node:crypto'
import {
  RACCOON_QR_STATUS,
  RACCOON_REQUEST_TIMEOUT_MS,
  decodeJwtExpMs,
  encryptRaccoonPhone,
  raccoonHeaders,
  type RaccoonCredential,
} from './raccoon.js'
import { type RaccoonProduct } from './raccoon-product.js'

/** 扫码轮询的状态值。 */
export type RaccoonQrStatus = 'pending' | 'logging' | 'canceled' | 'success'

/** 一次扫码轮询的结果。 */
export interface RaccoonQrPollResult {
  status: RaccoonQrStatus
  /** 仅 `success` 时存在。 */
  accessToken?: string
  /** 仅 `success` 时存在。 */
  refreshToken?: string
  /** 仅 `success` 时存在（毫秒时间戳字符串）。 */
  expiresAt?: string
  /** 仅 `logging` 时存在（二维码有效期）。 */
  expiredAt?: string
}

/** 业务响应信封（失败可能带 HTTP 400/401，也可能 HTTP 200 + 非 0 code）。 */
interface RaccoonEnvelope {
  code: number
  message: string
  details: string
  data: Record<string, unknown> | undefined
}

/** 解析业务信封。`code === 0` 为成功。 */
function parseEnvelope(payload: unknown, status: number): RaccoonEnvelope {
  const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
  const code = typeof record.code === 'number' ? record.code : (status >= 400 ? status : 0)
  const message = typeof record.message === 'string' ? record.message : ''
  const details = typeof record.details === 'string' ? record.details : ''
  const data = typeof record.data === 'object' && record.data !== null && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : undefined
  return { code, message, details, data }
}

/** 把信封里的错误拼成一条可读信息（服务端文案优先）。 */
function envelopeError(envelope: RaccoonEnvelope, fallback: string): Error {
  const parts = [envelope.message, envelope.details].filter((s) => s.length > 0)
  const text = parts.length > 0 ? parts.join(': ') : fallback
  return new Error(`raccoon: ${text}`)
}

/** 发一次 JSON 请求并解析信封。 */
async function postJson(
  url: string,
  body: Record<string, unknown>,
  fetcher: typeof fetch,
  headers: Record<string, string> = {},
): Promise<{ envelope: RaccoonEnvelope; status: number }> {
  let response: Response
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RACCOON_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(
      `raccoon: 请求失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new Error(`raccoon: 响应不是 JSON（HTTP ${response.status}）`)
  }
  return { envelope: parseEnvelope(parsed, response.status), status: response.status }
}

/** 新版扫码 API 基址（官方前端 2026-10 起从 `/api/web/auth/v1` 迁到这里）。 */
export const RACCOON_IAM_BASE = '/api/iam/v1'
/** 申请扫码会话。 */
export const RACCOON_IAM_QR_PATH = `${RACCOON_IAM_BASE}/auth/mp/qrcode`
/** 轮询扫码结果。 */
export const RACCOON_IAM_QR_LOGIN_PATH = `${RACCOON_IAM_BASE}/auth/mp/qrcode/login`
/** 扫码页固定带上的品牌名（与官方前端逐字一致）。 */
export const RACCOON_QR_BRAND = '商汤小浣熊官网'

/** 服务端下发的一次扫码会话。 */
export interface RaccoonQrSession {
  /** 服务端生成的 code（`qr-` 前缀），**不再是本地随机的 32 位 hex**。 */
  qrcodeCode: string
  /** 二维码落地页路径（实测 `/login/mp`）。 */
  scanPath: string
  /** 有效期（秒，实测 300）。 */
  expiresIn: number
  /** 建议轮询间隔（秒，实测 2）。 */
  pollInterval: number
}

/**
 * 向服务端申请一个扫码会话（新版 API）。
 *
 * ⚠️ 2026-10-24 实测：旧前端「本地随机 code + 固定 `/login/mp` 页」的路径已失效 ——
 * `/login/mp` 对任何 code 都 404（含带 Cookie / 微信 UA / Referer）。官方前端改为
 * **服务端下发 code + scan_path**，扫码页再按 `code/appname/source` 拼出来。
 * 旧接口 `/login_with_qrcode_code` 仍在（自造 code 也回 `pending`），故保留为回退。
 *
 * 失败（网络 / 非 2xx / 形状不符）返回 `undefined`，由调用方回退旧流程。
 */
export async function createRaccoonQrSession(
  product: RaccoonProduct,
  fetcher: typeof fetch = fetch,
): Promise<RaccoonQrSession | undefined> {
  try {
    const { envelope, status } = await postJson(`${product.apiBase}${RACCOON_IAM_QR_PATH}`, {}, fetcher)
    if (status >= 400 || envelope.code !== 0 || envelope.data === undefined) return undefined
    const data = envelope.data
    const qrcodeCode = typeof data.qrcode_code === 'string' ? data.qrcode_code : ''
    const scanPath = typeof data.scan_path === 'string' ? data.scan_path : ''
    if (qrcodeCode === '' || scanPath === '') return undefined
    return {
      qrcodeCode,
      scanPath,
      expiresIn: typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 300,
      pollInterval: typeof data.poll_interval === 'number' && data.poll_interval > 0 ? data.poll_interval : 2,
    }
  } catch {
    return undefined
  }
}

/**
 * 构造二维码内容（与官方前端逐字一致）：
 * `new URL(scan_path, origin)` + `code` + `appname` + `source=platform`。
 */
export function buildRaccoonScanUrl(product: RaccoonProduct, session: RaccoonQrSession): string {
  const url = new URL(session.scanPath, product.apiBase)
  url.searchParams.set('code', session.qrcodeCode)
  url.searchParams.set('appname', RACCOON_QR_BRAND)
  url.searchParams.set('source', 'platform')
  return url.href
}

/** 新版轮询：同一个映射，只是换 `login_with_qrcode_code` → `/auth/mp/qrcode/login`。 */
export async function pollRaccoonQrSession(
  product: RaccoonProduct,
  qrcodeCode: string,
  fetcher: typeof fetch = fetch,
): Promise<RaccoonQrPollResult> {
  let envelope: RaccoonEnvelope
  try {
    const result = await postJson(
      `${product.apiBase}${RACCOON_IAM_QR_LOGIN_PATH}`,
      { qrcode_code: qrcodeCode },
      fetcher,
    )
    envelope = result.envelope
  } catch {
    return { status: 'pending' }
  }
  if (envelope.code !== 0 || envelope.data === undefined) return { status: 'pending' }
  const data = envelope.data
  const status = typeof data.status === 'string' ? data.status : ''
  const expiredAt = typeof data.expired_at === 'string' ? data.expired_at : undefined
  if (status === RACCOON_QR_STATUS.canceled) return { status: 'canceled' }
  if (status === RACCOON_QR_STATUS.logging) {
    return { status: 'logging', ...expiredAt !== undefined ? { expiredAt } : {} }
  }
  if (status === RACCOON_QR_STATUS.success) {
    const accessToken = typeof data.access_token === 'string' ? data.access_token : ''
    if (accessToken.length === 0) return { status: 'pending' }
    const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : ''
    const expMs = decodeJwtExpMs(accessToken)
    return {
      status: 'success',
      accessToken,
      ...refreshToken.length > 0 ? { refreshToken } : {},
      ...expMs !== undefined ? { expiresAt: String(expMs) } : {},
    }
  }
  return { status: 'pending' }
}

/**
 * 下发短信验证码。
 *
 * ⚠️ 手机号必须 AES-128-CFB 加密（否则 `100003 params_encryted_error`）。
 * ⚠️ `captcha_param` 是阿里云滑块验证码的产物，**必需**（否则
 * `100006 captcha_verify_error`）。
 */
export async function sendRaccoonSmsCode(
  product: RaccoonProduct,
  phone: string,
  captchaParam: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const { envelope } = await postJson(
    `${product.apiBase}${product.authApiPrefix}/send_sms`,
    {
      captcha_param: captchaParam,
      nation_code: '86',
      phone: encryptRaccoonPhone(phone),
    },
    fetcher,
  )
  if (envelope.code !== 0) {
    if (envelope.code === 100006) {
      throw new Error('raccoon: 图形验证码校验失败，请重新完成滑块验证')
    }
    throw envelopeError(envelope, '下发短信验证码失败')
  }
}

/**
 * 用短信验证码登录。
 *
 * @returns 完整凭据（`expires_at` 由 JWT 的 exp 推算）。
 * @throws 验证码错误/过期、手机号非法、网络失败。
 */
export async function loginRaccoonWithSmsCode(
  product: RaccoonProduct,
  phone: string,
  smsCode: string,
  fetcher: typeof fetch = fetch,
): Promise<RaccoonCredential> {
  const { envelope } = await postJson(
    `${product.apiBase}${product.authApiPrefix}/login_with_sms`,
    {
      nation_code: '86',
      phone: encryptRaccoonPhone(phone),
      sms_code: smsCode,
    },
    fetcher,
  )
  if (envelope.code !== 0) throw envelopeError(envelope, '短信登录失败')
  return credentialFromEnvelope(envelope)
}

/** 从成功信封里取出凭据；缺 `access_token` 时抛错（不产出半截凭据）。 */
function credentialFromEnvelope(envelope: RaccoonEnvelope): RaccoonCredential {
  const data = envelope.data ?? {}
  const accessToken = typeof data.access_token === 'string' ? data.access_token : ''
  const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : ''
  if (accessToken.length === 0) {
    throw new Error('raccoon: 登录响应缺少 access_token')
  }
  const expMs = decodeJwtExpMs(accessToken)
  const officeIdentity = typeof data.office_identity === 'string' ? data.office_identity : ''
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    ...expMs !== undefined ? { expires_at: String(expMs) } : {},
    ...officeIdentity.length > 0 ? { office_identity: officeIdentity } : {},
  }
}

/**
 * 官方桌面端的**网页授权**地址（OAuth 授权码流程的起点）。
 *
 * 参照 magpie 的 `@magpie-community/opencode-raccoon-auth`（其 `browserSignIn`），
 * 三个关键点缺一不可（2026-10-27 实测授权页 307 → `/authorize` 正常）：
 *
 * 1. `login_source=desktop` + `appname=办公小浣熊客户端` —— 走桌面端登录；
 * 2. `desktop_callback=loopback` —— **让授权页接受 127.0.0.1 回调**
 *    （默认只认 `office-raccoon://auth/callback` 自定义协议）；
 * 3. `state` 必须是 **64 位 hex**（32 字节随机数的 hex），否则授权页拒绝
 *    loopback 回调；`redirect` 指向 `http://127.0.0.1:<port>/auth/callback`。
 *
 * ⚠️ 这条链路**替代了扫码与短信**：用户只需在浏览器里登录并点「授权」，
 * 授权码会自动回到本地服务器，无需手填验证码、也无需复制回调地址
 * （扫码链路的 `/login/mp` 已失效 —— 见 `createRaccoonQrSession` 的注释）。
 */
export function buildRaccoonAuthorizeUrl(
  product: RaccoonProduct,
  options: { state: string; redirectUri: string },
): string {
  const url = new URL('/code/authorize', product.apiBase)
  url.searchParams.set('login_source', 'desktop')
  url.searchParams.set('appname', '办公小浣熊客户端')
  url.searchParams.set('state', options.state)
  url.searchParams.set('desktop_callback', 'loopback')
  url.searchParams.set('redirect', options.redirectUri)
  return url.href
}

/**
 * 用授权码换取凭据（官方桌面端链路）。
 *
 * 授权码由 {@link buildRaccoonAuthorizeUrl} 的 loopback 回调带回
 * （`raccoon-login-page.ts` 的 `/auth/callback` 处理器调用本函数）。
 * 上游约定 `code === 200035` 表示授权码不存在/过期/已消费。
 */
export async function exchangeRaccoonAuthorizationCode(
  product: RaccoonProduct,
  authorizationCode: string,
  fetcher: typeof fetch = fetch,
): Promise<RaccoonCredential> {
  const { envelope } = await postJson(
    `${product.apiBase}${product.authApiPrefix}/login_with_authorization_code`,
    { authorization_code: authorizationCode },
    fetcher,
  )
  if (envelope.code !== 0) {
    // 官方约定：200035 = 授权码不存在/过期/已消费
    if (envelope.code === 200035) {
      throw new Error('raccoon: 授权码已失效，请重新发起登录')
    }
    throw envelopeError(envelope, '授权码登录失败')
  }
  return credentialFromEnvelope(envelope)
}

/**
 * 用 refresh_token 换新凭据。
 *
 * ⚠️ 服务端可能**只返回新的 access_token**（不带新 refresh_token），
 * 此时必须**保留旧值** —— 否则续期一次就把账号变成不可续期。
 * ⚠️ 服务端不返回的附加字段（昵称、身份、设备号）也要保留。
 * ⚠️ 401 表示 refresh_token 已失效，**抛「请重新登录」且不重试**。
 */
export async function refreshRaccoonCredential(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
): Promise<RaccoonCredential> {
  const { envelope, status } = await postJson(
    `${product.apiBase}${product.authApiPrefix}/refresh`,
    { refresh_token: credential.refresh_token },
    fetcher,
  )
  if (status === 401 || envelope.code === 200003) {
    throw new Error('raccoon: 登录态已过期，请重新登录')
  }
  if (envelope.code !== 0) throw envelopeError(envelope, '续期失败')

  const data = envelope.data ?? {}
  const accessToken = typeof data.access_token === 'string' ? data.access_token : ''
  if (accessToken.length === 0) {
    throw new Error('raccoon: 续期响应缺少 access_token')
  }
  const nextRefresh = typeof data.refresh_token === 'string' && data.refresh_token.length > 0
    ? data.refresh_token
    : credential.refresh_token
  const expMs = decodeJwtExpMs(accessToken)
  return {
    ...credential,
    access_token: accessToken,
    refresh_token: nextRefresh,
    ...expMs !== undefined ? { expires_at: String(expMs) } : {},
  }
}

/**
 * 拉取用户信息（展示用）。
 *
 * ⚠️ 失败时返回**空对象**而不是抛错：用户信息只用于昵称展示，
 * 不该因为它失败而让整个登录流程失败（登录已经成功了）。
 *
 * ⚠️ `nickname` 取的是远端的 `name`，而**它是服务端自动生成的默认名**
 *（实测 `RaccoonAva`），微信扫码不回传微信昵称 —— 故多账号消歧要靠 `phone`。
 */
export async function fetchRaccoonUserInfo(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
): Promise<{ userId?: string; nickname?: string; officeIdentity?: string; phone?: string }> {
  try {
    const response = await fetcher(`${product.apiBase}${product.authApiPrefix}/user_info`, {
      method: 'GET',
      headers: raccoonHeaders(credential),
      signal: AbortSignal.timeout(RACCOON_REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return {}
    const envelope = parseEnvelope(await response.json(), response.status)
    if (envelope.code !== 0 || envelope.data === undefined) return {}
    const userId = typeof envelope.data.id === 'string' ? envelope.data.id : ''
    const nickname = typeof envelope.data.name === 'string' ? envelope.data.name : ''
    const officeIdentity = typeof envelope.data.office_identity === 'string'
      ? envelope.data.office_identity
      : ''
    const phone = typeof envelope.data.phone === 'string' ? envelope.data.phone : ''
    return {
      ...userId.length > 0 ? { userId } : {},
      ...nickname.length > 0 ? { nickname } : {},
      ...officeIdentity.length > 0 ? { officeIdentity } : {},
      ...phone.length > 0 ? { phone } : {},
    }
  } catch {
    return {}
  }
}
