/**
 * AutoClaw（国内站）短信登录：手机号 + 验证码，零依赖。
 *
 * ## 协议来源（2026-10-24 真机验证通过）
 *
 * | 项 | 值 |
 * | --- | --- |
 * | 发码 | `POST {apiBase}/userapi/v1/agent-send-code` |
 * | 换令牌 | `POST {apiBase}/userapi/v1/agent-login` |
 * | 签名 | `X-Auth-Sign = md5("<appId>&<ts>&<appKey>")`，`ts` 为**秒** |
 * | 常数 | `appId = 100003`、`appKey = 38d2391985e2369a5fb8227d8e6cd5e5`、`source_id = autoclaw` |
 * | 请求头 | `X-Auth-Appid` / `X-Auth-TimeStamp` / `X-Auth-Sign` / `X-Lang: zh-CN` / `X-Channel: official` |
 * | 发码体 | `{ phone, source_id, device_id }` |
 * | 登录体 | `{ phone, code: Number(code), source_id, device_id }` |
 *
 * 真机实测（176****9846）：`agent-login` 返回 `access_token`（JWT，337 字符）+
 * `refresh_token`（339 字符），JWT 的 `exp` 恰好是**登录后 24 小时**；`data.user_id`
 * 是 32 位 hex（**服务端 UUID 空间**，与 JWT 里的数字 id 不是一套），这里按服务端值优先。
 *
 * ## 三个必须守住的约束
 *
 * 1. **过期时间不许编造**：权威是 JWT 的 `exp`，其次上游声明值，都读不到就留空
 *    （调用方按「该续期」处理）。兄弟插件曾写死 7 天（真实寿命 24 小时），导致续期
 *    判据双跳过、用户看到「刚启动有积分、过一会登录失效、日志零字」。
 * 2. **`device_id` 必须跨请求稳定**：它进登录 / 签到 / 续期三处请求体。这里持久化到
 *    `<pack home>/channel-pack/autoclaw-device.json`，首次生成 UUID 后复用。
 * 3. **短信是真实副作用**：只在用户显式点「发送验证码」时调用
 *    {@link sendAutoclawCode}，不放进任何自动流程。
 *
 * @module vendor/channel-pack/src/autoclaw-sms
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AutoClawCredential } from './autoclaw.js'
import type { AutoClawProduct } from './autoclaw-product.js'

/** 国内站认证常数（逆向自官方客户端，随客户端升级可能失效）。 */
export const AUTOCLAW_SMS_APP_ID = '100003'
export const AUTOCLAW_SMS_APP_KEY = '38d2391985e2369a5fb8227d8e6cd5e5'
export const AUTOCLAW_SEND_CODE_PATH = '/userapi/v1/agent-send-code'
export const AUTOCLAW_LOGIN_PATH = '/userapi/v1/agent-login'
export const AUTOCLAW_SOURCE_ID = 'autoclaw'
const REQUEST_TIMEOUT_MS = 20_000
const PHONE_RE = /^1[3-9]\d{9}$/

/** `md5(appId & timestamp & appKey)`，`timestamp` 为秒。 */
export function autoclawSign(
  appId: string,
  timestamp: string | number,
  appKey: string,
): string {
  return createHash('md5').update(`${appId}&${timestamp}&${appKey}`).digest('hex')
}

/** 两个端点共用的认证头。 */
export function autoclawAuthHeaders(
  timestamp: number = Math.floor(Date.now() / 1000),
  appId: string = AUTOCLAW_SMS_APP_ID,
  appKey: string = AUTOCLAW_SMS_APP_KEY,
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Auth-Appid': appId,
    'X-Auth-TimeStamp': String(timestamp),
    'X-Auth-Sign': autoclawSign(appId, timestamp, appKey),
    'X-Lang': 'zh-CN',
    'X-Channel': 'official',
  }
}

/** 归一手机号：容忍空格/横线/`+86`/`86` 前缀。 */
export function normalizeAutoclawPhone(raw: string): string {
  const digits = String(raw ?? '').replace(/[\s-]/g, '')
  const local = digits.startsWith('+86')
    ? digits.slice(3)
    : digits.startsWith('86') && digits.length === 13
      ? digits.slice(2)
      : digits
  return PHONE_RE.test(local) ? local : ''
}

/** `device_id` 的持久化路径（放在 pack 自己的数据目录里）。 */
export function autoclawDeviceIdPath(home: string): string {
  return join(home, 'channel-pack', 'autoclaw-device.json')
}

/**
 * 读取或生成**稳定**的 `device_id`。
 *
 * 读不到（首次 / 文件损坏 / 只读）时生成 UUID 并尽力持久化；持久化失败也照常返回，
 * 只是下一次会换一个新的（登录仍能成功，只是设备身份不稳定）。
 */
export function resolveAutoclawDeviceId(home: string): string {
  const file = autoclawDeviceIdPath(home)
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    const value = (parsed as { deviceId?: unknown } | undefined)?.deviceId
    if (typeof value === 'string' && value.length >= 8) return value
  } catch { /* 首次或损坏，下面重建 */ }
  const deviceId = randomUUID()
  try {
    mkdirSync(join(home, 'channel-pack'), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ deviceId, createdAt: Date.now() }, null, 2)}\n`, 'utf8')
  } catch { /* 只读环境：不阻塞登录 */ }
  return deviceId
}

/** 上游统一响应：`code === 0` 才算成功。 */
interface AutoclawEnvelope {
  code?: number
  msg?: string
  data?: Record<string, unknown>
}

async function postEnvelope(
  product: AutoClawProduct,
  fetcher: typeof fetch,
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; json: AutoclawEnvelope } | { ok: false; error: string }> {
  let response: Response
  try {
    response = await fetcher(`${product.apiBase}${path}`, {
      method: 'POST',
      headers: autoclawAuthHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  const text = await response.text().catch(() => '')
  if (!response.ok) return { ok: false, error: `HTTP ${response.status}：${text.slice(0, 200)}` }
  let json: AutoclawEnvelope
  try {
    json = JSON.parse(text) as AutoclawEnvelope
  } catch {
    return { ok: false, error: `上游返回非 JSON：${text.slice(0, 200)}` }
  }
  if (json.code !== 0) return { ok: false, error: json.msg ?? `上游错误码 ${json.code}` }
  return { ok: true, json }
}

/** 发送登录验证码（**真实短信副作用**，只应由用户显式操作触发）。 */
export async function sendAutoclawCode(options: {
  product: AutoClawProduct
  fetcher: typeof fetch
  phone: string
  deviceId: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const phone = normalizeAutoclawPhone(options.phone)
  if (phone === '') return { ok: false, error: '手机号格式不正确' }
  const result = await postEnvelope(options.product, options.fetcher, AUTOCLAW_SEND_CODE_PATH, {
    phone,
    source_id: AUTOCLAW_SOURCE_ID,
    device_id: options.deviceId,
  })
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}

/** 从 JWT 取 payload（不验签，只读 `exp` / `user_id`）。 */
function jwtClaims(token: string): Record<string, unknown> {
  const parts = token.split('.')
  if (parts.length < 2) return {}
  try {
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

const stripBearer = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/^Bearer\s+/i, '').trim() : ''

/**
 * 把 `agent-login` 的响应对成仓库自己的 `AutoClawCredential`。
 *
 * 过期时间优先 JWT `exp`；`account_id` 用服务端 `user_id`（UUID 空间，优先于 JWT 的
 * 数字 id —— 两者混用会让同一账号分裂成两条）。
 */
export function toAutoclawCredential(
  data: Record<string, unknown> | undefined,
  deviceId: string,
  phone: string,
): { ok: true; credential: AutoClawCredential } | { ok: false; error: string } {
  const accessToken = stripBearer(data?.access_token)
  if (accessToken === '') return { ok: false, error: '上游响应缺少 access_token' }
  const claims = jwtClaims(accessToken)
  const declared = typeof data?.expires_at === 'number'
    ? (data.expires_at as number) * ((data.expires_at as number) < 1e12 ? 1000 : 1)
    : typeof data?.expires_in === 'number'
      ? Date.now() + (data.expires_in as number) * 1000
      : undefined
  const jwtExpires = typeof claims.exp === 'number' ? claims.exp * 1000 : undefined
  // 用户报障「短信登录后没有返回账号信息」：上游的登录响应**不保证**带 `user_id`
  //（实测 data 里常只有 token 三件套），JWT payload 也可能没有 —— 此时若把
  // `account_id` 留空，账号池建出来的条目没有身份，界面上就是「没有账号信息」。
  // 因此按 `data.user_id` → JWT `user_id` → `data.user_name` → 手机号 逐级兜底，
  // 保证每条凭据都有一个可展示、可去重的稳定标识。
  const userId = data?.user_id ?? claims.user_id
    ?? claims.uid ?? claims.sub
  const userName = typeof data?.user_name === 'string' ? data.user_name : undefined
  const userPhone = typeof data?.user_phone === 'string' ? data.user_phone : phone
  const fallbackId = userPhone !== '' ? `phone:${userPhone}` : undefined
  const credential: AutoClawCredential = {
    access_token: accessToken,
    refresh_token: stripBearer(data?.refresh_token) || undefined,
    expire_time: jwtExpires ?? declared,
    account_id: userId === undefined ? fallbackId : String(userId),
    nickname: userName ?? `AutoClaw ${userPhone.slice(-4)}`,
    created_at: Date.now(),
    device_id: deviceId,
  }
  return { ok: true, credential }
}

/** 用手机号 + 验证码完成登录，返回可直接落盘的凭据。 */
/** 续期端点：优先 `/userapi/v1/refresh`，失败退 `/userapi/v1/agent-refresh`。 */
export const AUTOCLAW_REFRESH_PATHS = ['/userapi/v1/refresh', '/userapi/v1/agent-refresh'] as const

/**
 * 用 refresh_token 续期（上游两条端点，逐个试）。
 *
 * 真机依据（2026-10-24）：短信登录拿到的 access_token 是 24 小时 JWT，带 refresh_token；
 * 续期响应与登录同构（`code === 0` + `data.access_token`），**过期时间同样以 JWT exp 为准**。
 * 若响应没给新的 refresh_token，沿用旧的（上游会轮换）。
 */
export async function refreshAutoclawCredential(options: {
  product: AutoClawProduct
  fetcher: typeof fetch
  credential: AutoClawCredential
}): Promise<{ ok: true; credential: AutoClawCredential } | { ok: false; error: string }> {
  const refreshToken = stripBearer(options.credential.refresh_token)
  if (refreshToken === '') return { ok: false, error: '没有 refresh_token，请重新登录' }
  const deviceId = options.credential.device_id ?? 'our-free-model-device'
  let lastError = ''
  for (const path of AUTOCLAW_REFRESH_PATHS) {
    const timestamp = Math.floor(Date.now() / 1000)
    try {
      const response = await options.fetcher(`${options.product.apiBase}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Appid': AUTOCLAW_SMS_APP_ID,
          'X-Auth-TimeStamp': String(timestamp),
          'X-Auth-Sign': autoclawSign(AUTOCLAW_SMS_APP_ID, timestamp, AUTOCLAW_SMS_APP_KEY),
        },
        body: JSON.stringify({
          refresh_token: refreshToken,
          source_id: AUTOCLAW_SOURCE_ID,
          device_id: deviceId,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const text = await response.text()
      if (!response.ok) {
        lastError = `HTTP ${response.status}：${text.slice(0, 160)}`
        continue
      }
      let json: AutoclawEnvelope
      try {
        json = JSON.parse(text) as AutoclawEnvelope
      } catch {
        lastError = `非 JSON 响应：${text.slice(0, 160)}`
        continue
      }
      if (json.code !== 0 || json.data?.access_token === undefined) {
        lastError = json.msg ?? `上游错误码 ${json.code}`
        continue
      }
      const mapped = toAutoclawCredential(json.data, deviceId, options.credential.nickname ?? '')
      if (!mapped.ok) {
        lastError = mapped.error
        continue
      }
      // ⚠️ **身份不得漂移**：续期响应通常不带 `user_id`，此时若退回 JWT 里的数字 id，
      // 就会和服务端 UUID 混成两套 id 空间（同一账号被判成两个）。所以只有上游**显式**
      // 给了 `user_id` 才更新，否则原样保留。
      const serverUserId = json.data.user_id
      const accountId = typeof serverUserId === 'string' && serverUserId !== ''
        ? serverUserId
        : typeof serverUserId === 'number'
          ? String(serverUserId)
          : options.credential.account_id
      return {
        ok: true,
        credential: {
          ...mapped.credential,
          // 上游轮换 refresh_token 时用新的；没给就沿用旧的（否则下次续期会因缺 token 失败）。
          refresh_token: mapped.credential.refresh_token ?? options.credential.refresh_token,
          account_id: accountId,
          nickname: options.credential.nickname ?? mapped.credential.nickname,
        },
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  return { ok: false, error: lastError === '' ? '续期失败（上游未返回 access_token）' : lastError }
}

export async function loginAutoclawWithCode(options: {
  product: AutoClawProduct
  fetcher: typeof fetch
  phone: string
  code: string
  deviceId: string
}): Promise<{ ok: true; credential: AutoClawCredential } | { ok: false; error: string }> {
  const phone = normalizeAutoclawPhone(options.phone)
  if (phone === '') return { ok: false, error: '手机号格式不正确' }
  const code = options.code.trim()
  if (!/^\d{4,8}$/.test(code)) return { ok: false, error: '验证码必须是 4–8 位数字' }
  const result = await postEnvelope(options.product, options.fetcher, AUTOCLAW_LOGIN_PATH, {
    phone,
    code: Number(code),
    source_id: AUTOCLAW_SOURCE_ID,
    device_id: options.deviceId,
  })
  if (!result.ok) return { ok: false, error: result.error }
  return toAutoclawCredential(result.json.data, options.deviceId, phone)
}
