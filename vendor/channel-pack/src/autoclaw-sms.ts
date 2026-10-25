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

// ── userapi 域的「官方客户端指纹」头 ────────────────────────────────────────
//
// 上游 `aimod-cc/Agent2API` 的 `providers/autoclaw/refresh.rs` `signed_auth_headers`
// 记录：**userapi 域**（刷新 / 余额 / 签到 / 模型目录）这套链路**必须**带下面
// 这批品牌头，且刻意与转发链路不一致：
//
// - `X-Harness-Type: zcode` **保留** —— 转发链（`/chat/completions`）自
//   2026-09-22 起不发它（上游对该值区别对待：403 pay-view / 406），但 userapi
//   链当天实测带着它照常 200。在这条链上删减，风险方向是**签名失败**
//   （code 400002），收益是零。
// - `X-Version` 是**客户端版本门控**：模型目录等接口按它决定下发哪一档清单。
//
// ⚠ 这套头与 `autoclawAuthHeaders()`（SMS 登录用）**不是同一套** —— 后者是
// 登录/续期专用的精简版，别合并。

/** 客户端版本（userapi 域的版本门控；上游 `CLIENT_VERSION`）。 */
export const AUTOCLAW_USERAPI_VERSION = '1.18.5'

/** 任务完成端点（`/autoclaw-proxy/proxy/autoclaw-task-complete`）。 */
export const AUTOCLAW_TASK_COMPLETE_PATH = '/autoclaw-proxy/proxy/autoclaw-task-complete'

/** 任务列表端点（失败归因用：拿不到说明登录态有问题）。 */
export const AUTOCLAW_TASK_LIST_PATH = '/autoclaw-proxy/proxy/autoclaw-task-list'

/** 每日签到任务 id（`autoclaw-task-complete` 的 `task_id`）。 */
export const AUTOCLAW_DAILY_SIGNIN_TASK = 'daily_signin'

/**
 * userapi 域请求头（官方客户端指纹 + `X-Auth-Sign`）。
 *
 * 签名口径与 SMS 登录完全一致（`md5(appId & timestamp & appKey)`，
 * 上游注释明确「不要复制，复制会让 appId/appKey、时间戳单位与品牌头分叉，
 * 而签名一旦分叉就是稳定 400002」—— 因此这里的 appId/appKey 直接复用
 * `AUTOCLAW_SMS_APP_ID` / `AUTOCLAW_SMS_APP_KEY`，**不另立常量**。
 */
export function autoclawUserapiHeaders(
  token: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: '*/*',
    'X-Version': AUTOCLAW_USERAPI_VERSION,
    'X-Product': 'autoclaw',
    'X-Client-Type': 'pc',
    'X-Harness-Type': 'zcode',
    'X-Tm': process.platform === 'win32' ? 'win' : 'linux',
    'X-Lang': 'zh-CN',
    'X-Channel': 'official',
    'X-Auth-Appid': AUTOCLAW_SMS_APP_ID,
    'X-Auth-TimeStamp': String(timestamp),
    'X-Auth-Sign': autoclawSign(AUTOCLAW_SMS_APP_ID, timestamp, AUTOCLAW_SMS_APP_KEY),
    ...(token === '' ? {} : { Authorization: `Bearer ${token}` }),
  }
}

/**
 * AutoClaw 每日签到。
 *
 * ## 上游形态（`aimod-cc/Agent2API` 的 `providers/autoclaw/checkin.rs`）
 *
 * ```text
 * POST {userapi}/autoclaw-proxy/proxy/autoclaw-task-complete
 * body: {"task_id":"daily_signin"}
 * → {"data":{"already_completed":true,"reward_points":0,"success":false,
 *            "task_id":"daily_signin"}}
 * ```
 *
 * ## 三个要点（照抄上游实测，别自己发明）
 *
 * 1. **不是签到专用接口** —— `autoclaw-task-complete` 是「完成客户端任务」的
 *    通用入口，`daily_signin` 只是其中一个 task_id（同级还有
 *    `daily_inspiration_center` / `upgrade_pc_app`）。
 * 2. **HTTP 200 + body 里的成功标记**：判「签到成功」要看
 *    `reward_points > 0`（或 `success === true`），**不能只看 HTTP 状态码**
 *    —— 那会把「今天已领过」当成一次成功领取。
 * 3. 上游**按天幂等**：重复调用不会重复入账，返回「已领取」。
 *
 * ## 失败归因
 * 上游在签到失败时额外拉一次 `autoclaw-task-list`：拿不到列表说明**登录态
 * 有问题**，能拿到而 `daily_signin` 已完成则说明是「今天已签到」而不是接口坏。
 * 这里不复制那次往返（正常路径不多花请求），只把可判定的原因说清楚。
 */
export async function claimAutoclawDailyCheckin(options: {
  product: AutoClawProduct
  fetcher: typeof fetch
  credential: AutoClawCredential
  signal?: AbortSignal
}): Promise<{ claimed: number; message: string }> {
  const token = stripBearer(options.credential.access_token)
  const timestamp = Math.floor(Date.now() / 1000)
  const url = `${options.product.apiBase}${AUTOCLAW_TASK_COMPLETE_PATH}`
  const response = await options.fetcher(url, {
    method: 'POST',
    headers: autoclawUserapiHeaders(token, timestamp),
    body: JSON.stringify({ task_id: AUTOCLAW_DAILY_SIGNIN_TASK }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (response.status === 401) {
    return { claimed: 0, message: '登录态已过期，无法签到（请先续期或重新登录）' }
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    return { claimed: 0, message: `签到返回 HTTP ${response.status}${text === '' ? '' : `：${text.slice(0, 160)}`}` }
  }
  const body: unknown = await response.json().catch(() => undefined)
  const data = body !== null && typeof body === 'object'
    ? (body as { data?: unknown }).data
    : undefined
  const record = data !== null && typeof data === 'object' ? data as Record<string, unknown> : {}
  const reward = typeof record.reward_points === 'number' && Number.isFinite(record.reward_points)
    ? record.reward_points
    : Number(record.reward_points ?? 0)
  const success = record.success === true
  const already = record.already_completed === true
  if (reward > 0) return { claimed: reward, message: `已领取 ${reward} 积分` }
  if (success) return { claimed: 0, message: '签到成功（本轮未返回积分数）' }
  if (already) return { claimed: 0, message: '今天已签到过（上游按天幂等）' }
  return { claimed: 0, message: '上游未返回可领取的积分（今日可能已领过）' }
}

// ── 模型路由（上游 `providers/autoclaw/models.rs` 的 resolve_model_route）──
//
// 上游要求一次转发带两个模型标识，且**两者不同**：
// - `X-Request-Model` 请求头 ← 完整路由 ID（带通道前缀，如 `zaicoding_glm-5.3`）
// - `body.model`           ← **剥掉前缀**后的模型 ID（如 `glm-5.3`）
//
// 我们此前把用户给的 model 原样塞进 body，既没那个头也没做前缀改写 ——
// 于是上游按「未知模型」处理，回 `HTTP 400 非法模型`（2026-10-25 实测）。

/** 已知路由前缀（上游 `KNOWN_ROUTE_PREFIXES`）。 */
const AUTOCLAW_ROUTE_PREFIXES = ['zaicoding_', 'zai_', 'x_'] as const

/** 默认路由（上游 `DEFAULT_ROUTE`；国际版同值）。 */
const AUTOCLAW_DEFAULT_ROUTE = 'zai_auto'

/** 上游静态路由表（`providers/autoclaw/models.rs` 的 `MODELS`）。 */
const AUTOCLAW_MODEL_ROUTES: ReadonlyArray<{ id: string; routeId: string }> = [
  { id: 'glm-5.3', routeId: 'zaicoding_glm-5.3' },
  { id: 'glm-5.3-flash', routeId: 'zai_glm-5.3-flash' },
]

/** 剥掉路由前缀（上游 `strip_route_prefix`）。 */
export function stripAutoClawRoutePrefix(routeId: string): string {
  for (const prefix of AUTOCLAW_ROUTE_PREFIXES) {
    if (routeId.startsWith(prefix)) return routeId.slice(prefix.length)
  }
  return routeId
}

/**
 * 解析模型路由（上游 `resolve_model_route` 的等价实现）。
 *
 * 匹配口径与上游逐字一致：先比**目录 id**、再比展示名 `name`、最后比完整
 * `routeId`，三轮都 `trim` + 忽略 ASCII 大小写。三者都不命中时回退默认路由
 * `zai_auto`（兜住 Anthropic 客户端那类会传 `claude-*` 的调用方）。
 *
 * ⚠️ 大小写差异**不能**触发回退：上游注释记录了因此「客户端请求 GLM-5.3
 * 被换成 auto（选错模型 + 走错计费通道）」的缺陷，故比对一律忽略大小写，
 * 而回退只兜真正未知的名字。
 */
export function resolveAutoClawModelRoute(rawModel: string | undefined): {
  /** 完整路由 ID → 发进 `X-Request-Model` 头。 */
  routeModelId: string
  /** 剥前缀后的模型 ID → 填进 `body.model`。 */
  bodyModelId: string
} {
  const name = String(rawModel ?? '').trim()
  if (name === '') {
    return { routeModelId: AUTOCLAW_DEFAULT_ROUTE, bodyModelId: stripAutoClawRoutePrefix(AUTOCLAW_DEFAULT_ROUTE) }
  }
  const same = (text: string): boolean => text.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0
    || text.toLowerCase() === name.toLowerCase()
  const byId = AUTOCLAW_MODEL_ROUTES.find(entry => same(entry.id))
  const byRoute = AUTOCLAW_MODEL_ROUTES.find(entry => same(entry.routeId))
  const entry = byId ?? byRoute
  if (entry !== undefined) {
    return { routeModelId: entry.routeId, bodyModelId: stripAutoClawRoutePrefix(entry.routeId) }
  }
  // 显式路由写法（`zaicoding_*` / `zai_*` / `x_*`）原样透传，只剥 body 前缀。
  for (const prefix of AUTOCLAW_ROUTE_PREFIXES) {
    if (name.startsWith(prefix)) return { routeModelId: name, bodyModelId: stripAutoClawRoutePrefix(name) }
  }
  return { routeModelId: AUTOCLAW_DEFAULT_ROUTE, bodyModelId: stripAutoClawRoutePrefix(AUTOCLAW_DEFAULT_ROUTE) }
}

// ── 上游 2026-09-22 起的两道闸（prompt.rs + adapter.rs 的归一化）──────────
//
// 不满足任一条，上游**稳定回 406（空响应体）**或 403：
//   1. system 提示词必须以 OpenClaw 身份句开头（外来身份句要被改写成中性说法）；
//   2. `max_tokens` 小于 10000 的小正整数会被预校验拒（8192 实测拒、10000 过）。
//
// 上游口径逐字照抄，别自己发明。

/** 上游闸门要求「以它开头」的身份句。 */
export const AUTOCLAW_IDENTITY_LINE = 'You are a personal assistant running inside OpenClaw.'

/** 出站身份前缀（身份句 + `## Tooling` 段，官方 prompt 开头两行）。 */
const AUTOCLAW_IDENTITY_PREFIX = 'You are a personal assistant running inside OpenClaw.\n\n'
  + '## Tooling\n'
  + 'Available tools are policy-filtered. Names are case-sensitive; call exactly as listed.\n'

/** `max_tokens` 安全下限（实测 8192 拒、10000 过，取后者）。 */
export const AUTOCLAW_MAX_TOKENS_FLOOR = 10_000

/** 外来身份句 → 中性说法（**长的在前**，短的放最后）。 */
const AUTOCLAW_FOREIGN_IDENTITIES: ReadonlyArray<[string, string]> = [
  ['You are ZCode, an interactive coding agent', 'You are an interactive coding agent'],
  ['You are a coding agent running in the Codex CLI tool', 'You are a coding agent running in a terminal CLI tool'],
  ['You are a coding agent running in the Codex CLI', 'You are a coding agent running in a terminal CLI'],
  ['You are running as a coding agent in the Codex CLI', 'You are running as a coding agent in a terminal CLI'],
  // Claude Code 的整句是 "You are Claude Code, Anthropic official CLI…"；
  // 只改到「You are Claude Code」为止，后面的产品说明原样保留。
  ['You are Claude Code', 'You are a coding assistant'],
  ['You are ZCode', 'You are an interactive coding agent'],
  ['You are an AI agent powered by DeepSeek Harness', 'You are an AI agent powered by a local coding harness'],
  // 放最后：它最短、最通用，必须让上面更长的 Codex CLI 句式先有机会命中。
  ['You are Codex', 'You are a coding agent'],
]

/**
 * 把一条 system 正文规范化成上游认得的形态。
 *
 * - 已经以身份句开头时**只改写、不再前置**（幂等：官方客户端自己的请求就带
 *   OpenClaw 提示词，重复前缀会写两遍）；
 * - 否则把身份前缀拼在原有正文**之前**，客户端提示词逐字保留在后
 *   （上游只要求「以身份句开头」，前缀之后接什么它不管）。
 */
export function normalizeAutoClawSystem(text: string): string {
  // 两步都与上游 `prompt.rs::normalize` 同序，**顺序不能反**：
  //   1. 先改写外来身份句（对**所有** system 正文生效，与它是否已带身份句无关）；
  //   2. 再决定要不要前置身份前缀。
  // 此前的实现把改写只放在「已带身份句」分支里 —— 走前缀分支时外来身份句
  // 原样留在前缀之后，上游闸门照样拦（稳定 406）。
  let out = text.trimStart()
  for (const [from, to] of AUTOCLAW_FOREIGN_IDENTITIES) {
    if (out.toLowerCase().includes(from.toLowerCase())) {
      out = out.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), to)
    }
  }
  // 已经以身份句开头时只改写、不再前置（幂等：官方客户端自己的请求就带
  // OpenClaw 提示词，重复前缀会把提示词写两遍）。
  if (out.startsWith(AUTOCLAW_IDENTITY_LINE)) return out
  return `${AUTOCLAW_IDENTITY_PREFIX}\n${out}`
}

/**
 * `max_tokens` 下限归一：小正整数抬到 {@link AUTOCLAW_MAX_TOKENS_FLOOR}。
 *
 * 上游预校验会把小于 10000 的小正整数拒成 **406 空响应体**（实测 8192 拒、
 * 10000 过）。0 / 负数 / 非数字不动（那是「没给」，由上游用默认值）。
 */
export function normalizeAutoClawMaxTokens(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const n = Math.trunc(value)
  if (n <= 0) return undefined
  return n < AUTOCLAW_MAX_TOKENS_FLOOR ? AUTOCLAW_MAX_TOKENS_FLOOR : n
}

// ── 积分钱包（上游 `providers/autoclaw/balance.rs`）─────────────────────────
//
// 两条链路都走 userapi 域（与签到同一个 `autoclawUserapiHeaders`）：
// - 主：`GET /agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw`
//   → `{code:0, data:{schema_version:"wallets.v2", total_balance, wallets:[…]}}`
// - 降级：`GET /agent-assetmgr/api/v1/wallet-instances?wallet_type=all&wallet_scope=all`
//   → `{code:0, data:{total_balance, wallets:[…]}}`（v2 拿不到时才用）
//
// ⚠️ **鉴权头是 `Authorization`，不是对话链的 `X-Authorization`**：实测带
// `X-Authorization` 打钱包接口回 `{"code":410000,"msg":"用户未登录"}`
//（同一个 token 换 `Authorization` 立刻 SUCCESS）。两个域各一套头。

/** 积分钱包 v2 路径（主链路）。 */
export const AUTOCLAW_WALLET_V2_PATH = '/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw'

/** 积分钱包 v1 路径（降级）。 */
export const AUTOCLAW_WALLET_V1_PATH = '/agent-assetmgr/api/v1/wallet-instances?wallet_type=all&wallet_scope=all'

/** 登录态失效的业务码（上游 `AUTH_EXPIRED_CODES`）。 */
const AUTOCLAW_AUTH_EXPIRED_CODES = new Set([410000, 40100, 400002])

/** 一个积分钱包条目。 */
export interface AutoClawWallet {
  type: string
  displayName: string
  balance: number
  priority: number
}

/**
 * 查积分钱包（v2 主链路，v1 降级）。
 *
 * 返回 `undefined` 表示拿不到（网络失败 / 结构不认识 / 登录态失效）——
 * 由调用方显示「未配置查询」或跳过，**绝不显示成 0**（0 会让用户以为积分用光）。
 *
 * 登录态失效时抛错（`AUTH_EXPIRED`）：那是用户能自己修的状态，该明确归因。
 */
export async function fetchAutoClawWallets(options: {
  product: AutoClawProduct
  fetcher: typeof fetch
  credential: AutoClawCredential
  signal?: AbortSignal
}): Promise<AutoClawWallet[] | undefined> {
  const token = stripBearer(options.credential.access_token)
  if (token === '') return undefined
  const headers = autoclawUserapiHeaders(token)
  for (const path of [AUTOCLAW_WALLET_V2_PATH, AUTOCLAW_WALLET_V1_PATH]) {
    const response = await options.fetcher(`${options.product.apiBase}${path}`, {
      method: 'GET',
      headers,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    if (!response.ok) continue
    const body: unknown = await response.json().catch(() => undefined)
    if (typeof body !== 'object' || body === null) continue
    const record = body as Record<string, unknown>
    const code = typeof record.code === 'number' ? record.code : undefined
    if (code === undefined || code === 0) {
      // 两条链路的 data 里都有 `wallets` 数组；解析失败就当这条链路没拿到，
      // 继续试下一条（v1 兜底）。
      const data = record.data
      if (typeof data !== 'object' || data === null) continue
      const list = (data as Record<string, unknown>).wallets
      if (!Array.isArray(list)) continue
      const wallets: AutoClawWallet[] = []
      for (const raw of list) {
        if (typeof raw !== 'object' || raw === null) continue
        const item = raw as Record<string, unknown>
        // 源实现 `filter(w => w?.display)`：display 为假值的不展示。
        if (item.display === false) continue
        const type = typeof item.public_wallet_type === 'string' ? item.public_wallet_type : ''
        const name = typeof item.display_name === 'string' && item.display_name.trim() !== ''
          ? item.display_name.trim()
          : (type !== '' ? type : '积分')
        const balance = typeof item.balance === 'number' && Number.isFinite(item.balance)
          ? item.balance
          : Number(item.balance ?? Number.NaN)
        const priority = typeof item.priority === 'number' && Number.isFinite(item.priority)
          ? item.priority
          : Number.MAX_SAFE_INTEGER
        wallets.push({ type, displayName: name, balance: Number.isFinite(balance) ? balance : 0, priority })
      }
      if (wallets.length > 0) {
        // 按 priority 升序（缺失视为 MAX_SAFE_INTEGER，即排在最后）。
        wallets.sort((a, b) => a.priority - b.priority)
        return wallets
      }
      continue
    }
    if (code !== undefined && AUTOCLAW_AUTH_EXPIRED_CODES.has(code)) {
      throw new Error('AutoClaw：登录态已过期，无法查询积分（请重新登录）')
    }
  }
  return undefined
}
