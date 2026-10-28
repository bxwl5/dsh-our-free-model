/**
 * OfficeAce 凭据与 OAuth 流程。
 *
 * ## 九步（参考实现逐条，见 officeace-product.ts 模块头）
 *
 * ```
 * ① POST {cloud}/v1/claw/auth/state                    → state
 * ② 本地生成 PKCE(SHA-256 challenge, base64url) 与 P-256 DPoP 密钥对
 * ③ 拼 authorizeUrl，浏览器登华为云
 * ④ GET  {cloud}/v1/claw/auth/code?state=<state>       → 轮询取授权码
 *      202 继续等 / 404 作废 / 200 拿到 code
 * ⑤ POST {sts}/v1/oauth2/tokens（表单 + DPoP 头）      → 临时 AK/SK/STS
 *      （+ refresh_token + id_token；推理网关三件套不在这发里）
 * ⑥ GET  {cloud}/v1/claw/client-permission-validate（SDK-HMAC）
 *      → 身份三件套 + subscription.model_info（网关 base_url/app_key/app_secret；
 *      为空 = 未开通，需走 ⑥b）
 * ⑥a GET {iam}/v3/projects（仅 project_id 空时）→ 按 region 补 project_id
 * ⑥b POST {cloud}/v1/claw/client-subscription（仅 model_info 空时）→ 开通
 * ⑦ 入库（凭据 + refresh_token + DPoP 私钥，续期链靠它们）
 * ```
 */

import {
  OFFICEACE_BONUS_CLAIM_PATH,
  OFFICEACE_CODE_PATH,
  OFFICEACE_IAM_PROJECTS_PATH,
  OFFICEACE_PERMISSION_PATH,
  OFFICEACE_STATE_PATH,
  OFFICEACE_STS_TOKENS_PATH,
  OFFICEACE_SUBSCRIPTION_PATH,
  type OfficeAceProduct,
} from './officeace-product.js'
import {
  base64UrlEncode,
  buildCanonicalRequest,
  createDpopProof,
  createDpopProofFromJwk,
  formatSdkDate,
  createDpopKeyPair,
  sha256Hex,
  signSdkHmac,
  signV11,
  type DpopKeyPair,
} from './officeace-dpop.js'

/**
 * OfficeAce 凭据。
 *
 * ⚠️ **推理与业务接口用的是两套凭据**（参考实现 `credentials.rs` 逐字）：
 *
 * | 用途 | 凭据 | 鉴权 |
 * |---|---|---|
 * | 推理 / 模型目录 | `base_url` + `app_key` + `app_secret` | **Basic** |
 * | 业务接口（额度/签到） | `access_key` + `secret_key`（+ STS） | SDK-HMAC / V11 |
 *
 * 推理是标准 OpenAI 兼容（`POST {base}/v2/chat/completions`），
 * 故适配器直接复用 `openai-compat.ts` 的 SSE 消费。
 */
export interface OfficeAceCredential {
  /**
   * 推理网关基址（形如 `https://modelgw-xxxx.example.com/v2`）。
   *
   * 上游可能返回带或不带 `/v2` 的形态，适配器统一归一。
   */
  base_url: string
  /** 推理用的 app key。 */
  app_key: string
  /** 推理用的 app secret。 */
  app_secret: string
  /** 业务接口的 AK（可选；仅有推理凭据时额度查询不可用）。 */
  access_key?: string
  /** 业务接口的 SK。 */
  secret_key?: string
  /** 临时 STS token。 */
  security_token?: string
  /** 项目 id。 */
  project_id?: string
  /** 账号标识。 */
  account_id?: string
  /** 昵称。 */
  nickname?: string
  /**
   * 模型信息（开通后下发）。
   *
   * ⚠️ 真实形态是**对象**（`model_api_url_base` + `model_auth_info.
   * {model_app_key, model_app_secret}`），不是数组。两份参考实现一致：
   * officeace2api `_fetchModelInfo`、Agent2API `fetch_permission`（实测
   * 2026-10：validate 嵌在 `subscription.model_info`，开通响应在顶层）。
   */
  model_info?: unknown
  /**
   * 一次性 refresh token（STS 换码响应下发）。
   *
   * 续期（`grant_type=refresh_token` 换新 AK/SK）的唯一钥匙，每次轮换作废
   * 上一份（重放报 STS5.1806）。参考实现都强调必须在登录时落库 —— 丢了
   * 只能重新登录。
   */
  refresh_token?: string
  /** 临时凭据到期时刻（毫秒；STS `credentials.expiration`）。 */
  expire_time?: number
  /**
   * 本次登录的 DPoP 密钥对（JWK 形态）。
   *
   * 续期签 proof 必须用**同一把**私钥（officeace2api `refresh.mjs` 与
   * Agent2API 同款约束：「丢了只能重登」），所以登录时一并落库。
   */
  dpop?: OfficeAceDpopJwkPair
  /** 创建时间。 */
  created_at?: number
}

/** 落库用的 DPoP 密钥对（JWK）。 */
export interface OfficeAceDpopJwkPair {
  /** 私钥 JWK（含 `d`，敏感）。 */
  privateJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string; d: string }
  /** 公钥 JWK（嵌 proof 头用）。 */
  publicJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string }
}

/** 归一推理基址：确保以 `/v2` 结尾。 */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (trimmed === '') return ''
  return trimmed.endsWith('/v2') ? trimmed : `${trimmed}/v2`
}

/** 构造推理用的 Basic 鉴权头。 */
export function basicAuthHeader(credential: OfficeAceCredential): string {
  const raw = `${credential.app_key}:${credential.app_secret}`
  const bytes = new TextEncoder().encode(raw)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `Basic ${btoa(binary)}`
}

/** 从凭据 JSON 解析（字段名兼容多种拼写）。 */
export function parseCredential(value: unknown): OfficeAceCredential | undefined {
  if (!isRecord(value)) return undefined
  const baseUrl = stringValue(value.baseUrl) ?? stringValue(value.base_url)
    ?? stringValue(value.api_base) ?? stringValue(value.apiBase)
  const appKey = stringValue(value.appKey) ?? stringValue(value.app_key)
  const appSecret = stringValue(value.appSecret) ?? stringValue(value.app_secret)
  if (baseUrl === undefined || appKey === undefined || appSecret === undefined) return undefined
  return {
    base_url: baseUrl,
    app_key: appKey,
    app_secret: appSecret,
    ...(stringValue(value.access_key) === undefined ? {} : { access_key: stringValue(value.access_key) }),
    ...(stringValue(value.accessKey) === undefined ? {} : { access_key: stringValue(value.accessKey) }),
    ...(stringValue(value.secret_key) === undefined ? {} : { secret_key: stringValue(value.secret_key) }),
    ...(stringValue(value.secretKey) === undefined ? {} : { secret_key: stringValue(value.secretKey) }),
    ...(stringValue(value.security_token) === undefined ? {} : { security_token: stringValue(value.security_token) }),
    ...(stringValue(value.project_id) === undefined ? {} : { project_id: stringValue(value.project_id) }),
    ...(stringValue(value.account_id) === undefined ? {} : { account_id: stringValue(value.account_id) }),
    ...(stringValue(value.nickname) === undefined ? {} : { nickname: stringValue(value.nickname) }),
    ...(stringValue(value.refresh_token) === undefined ? {} : { refresh_token: stringValue(value.refresh_token) }),
    ...(typeof value.expire_time === 'number' && Number.isFinite(value.expire_time) ? { expire_time: value.expire_time } : {}),
    ...(isRecord(value.dpop) ? { dpop: value.dpop as OfficeAceDpopJwkPair } : {}),
    ...(value.model_info === undefined ? {} : { model_info: value.model_info }),
    created_at: Date.now(),
  }
}

/** 从任意 JSON 安全取字符串。 */
function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * 取数字字段；**`0` 是合法值**（`current_value: "0"` 表示一分未用），
 * 只在「不是有限数字」时返回 undefined。字符串数字（上游配额全发字符串）也接受。
 */
function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** 解析上游时间字段（ISO 字符串 → 毫秒；无效/缺失返回 undefined）。 */
function parseTimeValue(value: unknown): number | undefined {
  const text = stringValue(value)
  if (text === undefined) return undefined
  const ms = Date.parse(text)
  return Number.isNaN(ms) ? undefined : ms
}

/** 是否非 null 对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 解一枚 JWT（`id_token` / `refresh_token`）的 payload。
 *
 * **不验签**：只取显示名，不用于任何鉴权判断（与参考实现同口径）。
 * 不是三段 / 解不出 base64 / 不是 JSON 都返回 undefined（fail-open）。
 */
function jwtClaims(token: string | undefined): Record<string, unknown> | undefined {
  if (token === undefined) return undefined
  const segments = token.split('.')
  if (segments.length < 2) return undefined
  const normalized = segments[1].replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=')
  try {
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** 解 `user_profile`：一段无填充 base64 的 JSON（两种字母表都试，与 Agent2API 一致）。 */
function decodeUserProfile(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined
  const body = value.trim().replace(/=+$/, '')
  if (body === '') return undefined
  for (const candidate of [body.replace(/\+/g, '-').replace(/\//g, '_'), body]) {
    try {
      const normalized = candidate.replace(/-/g, '+').replace(/_/g, '/')
      const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=')
      const binary = atob(padded)
      const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
      if (isRecord(parsed)) return parsed
    } catch {
      // 试另一种字母表。
    }
  }
  return undefined
}

/**
 * 从令牌里取显示名：顶层 `preferred_username`/`name` 优先，
 * 没有再解 `user_profile.account_name`（实测该租户的名字常只在这里 ——
 * Agent2API `jwt_identity` 的记录；officeace2api 只读顶层，是它的已知盲区）。
 */
function tokenDisplayName(token: string | undefined): string | undefined {
  const claims = jwtClaims(token)
  if (claims === undefined) return undefined
  for (const field of ['preferred_username', 'name']) {
    const value = stringValue(claims[field])
    if (value !== undefined) return value
  }
  const profile = decodeUserProfile(claims.user_profile)
  return profile === undefined ? undefined : stringValue(profile.account_name)
}

/** 判断凭据形状是否可用（推理凭据齐备即可）。 */
export function isCredentialUsable(credential: OfficeAceCredential | undefined): credential is OfficeAceCredential {
  if (credential === undefined) return false
  return typeof credential.base_url === 'string' && credential.base_url !== ''
    && typeof credential.app_key === 'string' && credential.app_key !== ''
    && typeof credential.app_secret === 'string' && credential.app_secret !== ''
}

/**
 * 生成 PKCE 对。
 *
 * ⚠️ **verifier 与 challenge 都必须是 base64url（RFC 7636 §4.1/§4.2），
 * 不是十六进制**。真机缺陷：早期版本用 hex 编码，华为云 STS 换码时报
 * `STS5.1805 invalid authorization code` —— STS 按官方客户端的口径
 * （`base64url(sha256(code_verifier))`）重算 challenge 并与 authorize 时
 * 绑定的值比对，hex 的 challenge 永远对不上，于是整枚授权码被判无效。
 *
 * 权威依据（两份能过真机的公开实现完全一致，均逆向自 OfficeAce 官方
 * 客户端 `huawei-oauth.js`）：
 * - `Q-shuang-dot/officeace2api` `src/oauth.mjs` 的 `generatePkce()`：
 *   `verifier = base64url(randomBytes(32))`，
 *   `challenge = base64url(sha256(verifier))`；
 * - `aimod-cc/Agent2API` `providers/officeace/oauth.rs` 的 `LoginFlow::start()`：
 *   `code_verifier = base64url(random_bytes(32))`，
 *   `challenge = base64url(Sha256::digest(code_verifier))`。
 * 本仓库 Accio 渠道（`accio.ts`）同款 base64url —— OfficeAce 此前是唯一的例外。
 */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const verifier = base64UrlEncode(bytes)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const challenge = base64UrlEncode(new Uint8Array(digest))
  return { verifier, challenge }
}

/** ① 取 state。 */
export async function fetchState(
  fetcher: typeof fetch,
  product: OfficeAceProduct,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetcher(`${product.cloudBase}${OFFICEACE_STATE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new Error(`OfficeAce：取 state 返回 HTTP ${response.status}`)
  const body: unknown = await response.json().catch(() => undefined)
  const record = isRecord(body) ? (isRecord(body.data) ? body.data : body) : undefined
  const state = record === undefined ? undefined : stringValue(record.state)
  if (state === undefined) throw new Error('OfficeAce：取 state 响应缺少 state')
  return state
}

/** ③ 拼授权 URL。 */
export function buildAuthorizeUrl(
  product: OfficeAceProduct,
  state: string,
  challenge: string,
): string {
  // ⚠️ 必须**两层**：内层是真正的 OAuth authorize，外层是华为云的登录承载页。
  // 直接把 OAuth 参数拼到 `login.html?` 上不会报错 —— 它会安静地渲染成通用登录页
  //（用户看到的就是「直接到华为云了，没有任何回调」）。对照公开实现
  // `Q-shuang-dot/officeace2api` 的 `buildAuthorizeUrl`：
  //   inner = {authBase}/authui/v1/oauth2/authorize?<oauth params>
  //   outer = {authBase}/authui/login.html?service=<urlencode(inner)>
  // 另有两个易错点：`code_challenge_method` 是 `SHA-256`（不是 `S256`），
  // 且必须带 `scope=openid` —— 缺任一都会在登录后被判参数非法。
  const query = new URLSearchParams({
    client_id: product.clientId,
    code_challenge: challenge,
    code_challenge_method: 'SHA-256',
    state,
    scope: 'openid',
    redirect_uri: product.redirectUri,
    response_type: 'code',
  })
  const inner = `${product.loginBase}/authui/v1/oauth2/authorize?${query.toString()}`
  return `${product.loginBase}/authui/login.html?service=${encodeURIComponent(inner)}`
}

/**
 * ④ 轮询取授权码。
 *
 * ⚠️ **必须读状态码**：
 * - `202` → 还没登完，继续等
 * - `404` → state 不认识/已过期，**立即判作废**并让用户重来
 * - `200` → 拿到 code
 *
 * 不读状态码的实现会把失败拖到超时才报，用户看到的是静默挂起。
 */
export async function pollAuthCode(
  fetcher: typeof fetch,
  product: OfficeAceProduct,
  state: string,
  options: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const intervalMs = options.intervalMs ?? 2_000
  const timeoutMs = options.timeoutMs ?? 600_000
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (options.signal?.aborted === true) throw new Error('OfficeAce：登录已取消')
    if (Date.now() > deadline) throw new Error('OfficeAce：登录超时，请重试')
    const response = await fetcher(
      `${product.cloudBase}${OFFICEACE_CODE_PATH}?state=${encodeURIComponent(state)}`,
      { method: 'GET', headers: { Accept: 'application/json' }, ...(options.signal === undefined ? {} : { signal: options.signal }) },
    )
    // 404 = state 作废，立即失败（不要拖到超时）。
    if (response.status === 404) throw new Error('OfficeAce：state 已失效，请重新发起登录')
    if (response.status === 202) {
      void response.body?.cancel().catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
      continue
    }
    if (!response.ok) throw new Error(`OfficeAce：取授权码返回 HTTP ${response.status}`)
    const body: unknown = await response.json().catch(() => undefined)
    const record = isRecord(body) ? (isRecord(body.data) ? body.data : body) : undefined
    const code = record === undefined ? undefined : stringValue(record.code)
    if (code === undefined) throw new Error('OfficeAce：取授权码响应缺少 code')
    return code
  }
}

/**
 * ⑤ 用授权码换临时凭据（表单 + DPoP 头）。
 */
export async function exchangeCodeForSts(
  fetcher: typeof fetch,
  product: OfficeAceProduct,
  code: string,
  verifier: string,
  dpopKey: DpopKeyPair,
  signal?: AbortSignal,
): Promise<OfficeAceCredential> {
  const url = `${product.stsBase}${OFFICEACE_STS_TOKENS_PATH}`
  const dpopProof = await createDpopProof(dpopKey, 'POST', url)
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: product.clientId,
    redirect_uri: product.redirectUri,
    code_verifier: verifier,
  }).toString()
  const response = await fetcher(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      DPoP: dpopProof,
    },
    body: form,
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`OfficeAce：换临时凭据返回 HTTP ${response.status}${text === '' ? '' : `：${text.slice(0, 200)}`}`)
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (!isRecord(body)) throw new Error('OfficeAce：换临时凭据响应不是对象')
  // ⚠️ 真实响应形态（两份参考实现一致，均逆向自 OfficeAce 官方客户端
  // `huawei-oauth.js` 的 `exchangeCode`）：
  //   { credentials: { access_key_id, secret_access_key, security_token,
  //                    project_id, expiration },
  //     refresh_token, id_token }
  // 推理网关三件套（base_url / app_key / app_secret）**不在这发里**：由随后
  // `client-permission-validate` 的 `subscription.model_info` 下发，见
  // validatePermission —— 这里先留空，由调用方合并。
  const credentials = isRecord(body.credentials) ? body.credentials : body
  const accessKey = stringValue(credentials.access_key_id) ?? stringValue(credentials.accessKeyId)
    ?? stringValue(credentials.access_key) ?? stringValue(credentials.accessKey)
  const secretKey = stringValue(credentials.secret_access_key) ?? stringValue(credentials.secretAccessKey)
    ?? stringValue(credentials.secret_key) ?? stringValue(credentials.secretKey)
  if (accessKey === undefined || secretKey === undefined) {
    throw new Error('OfficeAce：换临时凭据响应缺少 AK/SK')
  }
  const refreshToken = stringValue(body.refresh_token)
  const nickname = tokenDisplayName(stringValue(body.id_token))
    ?? (refreshToken === undefined ? undefined : tokenDisplayName(refreshToken))
  const expiration = stringValue(credentials.expiration)
  const expireTime = expiration === undefined || Number.isNaN(Date.parse(expiration))
    ? undefined
    : Date.parse(expiration)
  return {
    base_url: '',
    app_key: '',
    app_secret: '',
    access_key: accessKey,
    secret_key: secretKey,
    ...(stringValue(credentials.security_token) === undefined ? {} : { security_token: stringValue(credentials.security_token) }),
    ...(stringValue(credentials.project_id) === undefined ? {} : { project_id: stringValue(credentials.project_id) }),
    ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
    ...(expireTime === undefined ? {} : { expire_time: expireTime }),
    ...(nickname === undefined ? {} : { nickname }),
    created_at: Date.now(),
  }
}

/**
 * ⑧ 用 refresh_token 续期临时凭据（真续期）。
 *
 * 实测（2026-10-24，真实账号连续两次）：
 * `POST {sts}/v1/oauth2/tokens`（`grant_type=refresh_token` + DPoP 头）→ 200，
 * 返回 `credentials.{access_key_id, secret_access_key, security_token, expiration}`
 * （**project_id 与 id_token 均缺席**，续期响应比登录响应瘦），
 * `refresh_token` 每次都轮换（旧值即刻作废，重放报 STS5.1806）。
 *
 * ⚠️ **必须用登录时那把 DPoP 私钥签 proof**（参考实现 refresh.mjs 同款约束）；
 * ⚠️ **轮换出的新 refresh_token 必须落库**，丢了只能重新登录。
 * 权威口径：officeace2api `refresh.mjs` 的 `CredentialRefresher.refresh()`
 * （DEFAULT_TOKEN_URL = sts.cn-north-4 / DEFAULT_CLIENT_ID = pdp5_for_agentarts）。
 */
export async function refreshOfficeAceCredential(
  fetcher: typeof fetch,
  product: OfficeAceProduct,
  credential: OfficeAceCredential,
  options: { signal?: AbortSignal } = {},
): Promise<OfficeAceCredential> {
  const refreshToken = credential.refresh_token
  const dpop = credential.dpop
  if (refreshToken === undefined || refreshToken === '') {
    throw new Error('OfficeAce：该账号没有 refresh_token，只能重新登录')
  }
  if (dpop === undefined || dpop.privateJwk.d === '') {
    throw new Error('OfficeAce：凭据里没有 DPoP 私钥，无法续期（重新登录可重建）')
  }
  const url = `${product.stsBase}${OFFICEACE_STS_TOKENS_PATH}`
  const dpopProof = await createDpopProofFromJwk(dpop, 'POST', url)
  const form = new URLSearchParams({
    client_id: product.clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }).toString()
  const response = await fetcher(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', DPoP: dpopProof },
    body: form,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    // STS5.1806 = refresh token 已被使用（一次性轮换，重放即作废）。
    throw new Error(`OfficeAce：续期返回 HTTP ${response.status}${text === '' ? '' : `：${text.slice(0, 200)}`}（refresh_token 单次有效，被拒后需重新登录）`)
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  if (!isRecord(body)) throw new Error('OfficeAce：续期响应不是对象')
  const credentials = isRecord(body.credentials) ? body.credentials : body
  const accessKey = stringValue(credentials.access_key_id) ?? stringValue(credentials.accessKey)
  const secretKey = stringValue(credentials.secret_access_key) ?? stringValue(credentials.secretAccessKey)
  if (accessKey === undefined || secretKey === undefined) {
    throw new Error('OfficeAce：续期响应缺少 AK/SK')
  }
  const rotated = stringValue(body.refresh_token)
  const expiration = stringValue(credentials.expiration)
  const expireTime = expiration === undefined || Number.isNaN(Date.parse(expiration))
    ? undefined
    : Date.parse(expiration)
  return {
    ...credential,
    access_key: accessKey,
    secret_key: secretKey,
    ...(stringValue(credentials.security_token) === undefined ? {} : { security_token: stringValue(credentials.security_token) }),
    ...(stringValue(credentials.project_id) === undefined ? {} : { project_id: stringValue(credentials.project_id) }),
    // 轮换出的新 token 必须带着（丢了链子就断）；上游没给就沿用旧的。
    refresh_token: rotated ?? refreshToken,
    ...(expireTime === undefined ? {} : { expire_time: expireTime }),
  }
}

/**
 * 订阅/积分快照（`GET {gateway}/v1/subscription`，V11-HMAC-SHA256 签名）。
 *
 * 实测（2026-10-24，真实账号，HTTP 200）：
 * - `skus[].quotas[]`：`sku_attr_code` 为 `officeace_points`（积分总额
 *   `sku_value` / 已用 `current_value`）与 `online_search_count`（联网搜索次数），
 *   剩余 = sku_value - current_value（officeace2api 的 AK() 同款算法）；
 * - `bonus_skus[]`：奖励积分（新用户 4000 / 每日签到 100，带过期时间）；
 * - 签名口径：`x-subscription-type: v2` 头 + V11（scope 服务名固定 `apic`）。
 *
 * 权威口径：officeace2api `quota.mjs` 的 `signV11`/`summarizeSubscription`，
 * 网关地址取凭据 `model_info.model_api_url_base`（登录时 validate 下发）。
 */
export interface OfficeAceSubscriptionSnapshot {
  /** 积分总额（套餐 + 有效奖励，未过期口径）。 */
  total: number
  /** 积分已用。 */
  used: number
  /** 积分剩余。 */
  remaining: number
  /** 套餐名（首个 sku）。 */
  planName: string
  /** 套餐到期时刻（毫秒；0 = 未知）。 */
  planExpiresAt: number
  /** 联网搜索次数剩余（未配额则 undefined）。 */
  searchRemaining?: number
  /** 各包明细（面板 packages 用）。 */
  packages: Array<{ name: string; total: number; used: number; remaining: number; expiresAt: number }>
}

/** 解析 `/v1/subscription` 响应为积分快照（officeace2api summarizeSubscription 口径）。 */
export function parseSubscriptionSnapshot(body: unknown, nowMs = Date.now()): OfficeAceSubscriptionSnapshot {
  if (!isRecord(body)) throw new Error('OfficeAce：订阅响应不是对象')
  const skus = Array.isArray(body.skus) ? body.skus.filter(isRecord) : []
  const bonusSkus = Array.isArray(body.bonus_skus) ? body.bonus_skus.filter(isRecord) : []
  const packages: OfficeAceSubscriptionSnapshot['packages'] = []
  let pointsTotal = 0
  let pointsUsed = 0
  let searchRemaining: number | undefined
  let planName = ''
  let planExpiresAt = 0

  for (const sku of skus) {
    const name = stringValue(sku.sku_name) ?? stringValue(sku.sku_code) ?? ''
    const skuExp = parseTimeValue(sku.expired_time)
    if (planName === '') planName = name
    if (planExpiresAt === 0 && skuExp !== undefined) planExpiresAt = skuExp
    const quotas = Array.isArray(sku.quotas) ? sku.quotas.filter(isRecord) : []
    let ptsTotal = 0
    let ptsUsed = 0
    for (const quota of quotas) {
      const quotaExp = parseTimeValue(quota.expired_time)
      if (quotaExp !== undefined && quotaExp <= nowMs) continue
      const code = stringValue(quota.sku_attr_code)
      const total = numberValue(quota.sku_value) ?? 0
      const used = numberValue(quota.current_value) ?? 0
      if (code === 'officeace_points') {
        ptsTotal += total
        ptsUsed += used
      } else if (code === 'online_search_count') {
        searchRemaining = (searchRemaining ?? 0) + Math.max(0, total - used)
      }
    }
    if (ptsTotal > 0 || ptsTotal === -1) {
      packages.push({ name, total: ptsTotal, used: ptsUsed, remaining: Math.max(0, ptsTotal - ptsUsed), expiresAt: skuExp ?? 0 })
    }
    pointsTotal += ptsTotal
    pointsUsed += ptsUsed
  }

  for (const bonus of bonusSkus) {
    const exp = parseTimeValue(bonus.expired_time)
    if (exp !== undefined && exp <= nowMs) continue
    const name = stringValue(bonus.activity_name) ?? stringValue(bonus.activity_id) ?? '奖励积分'
    const total = numberValue(bonus.points) ?? 0
    const used = numberValue(bonus.current_value) ?? 0
    packages.push({ name, total, used, remaining: Math.max(0, total - used), expiresAt: exp ?? 0 })
    pointsTotal += total
    pointsUsed += used
  }

  return {
    total: pointsTotal,
    used: pointsUsed,
    remaining: Math.max(0, pointsTotal - pointsUsed),
    planName,
    planExpiresAt,
    ...(searchRemaining === undefined ? {} : { searchRemaining }),
    packages,
  }
}

/**
 * 订阅面网关地址（`model_info.model_api_url_base`；订阅/倍率/签到三个端点同源）。
 * 上游发的是裸 host（无 scheme），统一补 https；测试替身可显式带 http://。
 */
function resolveSubscriptionGateway(credential: OfficeAceCredential): string {
  const rawBase = credential.model_info !== undefined && isRecord(credential.model_info)
    ? stringValue(credential.model_info.model_api_url_base)
    : undefined
  if (rawBase === undefined || rawBase === '') {
    throw new Error('OfficeAce：凭据缺少 model_info.model_api_url_base（重新登录可重建）')
  }
  const stripped = rawBase.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  if (stripped === '') {
    throw new Error('OfficeAce：凭据缺少 model_info.model_api_url_base（重新登录可重建）')
  }
  return /^https?:\/\//.test(rawBase) ? rawBase.replace(/\/+$/, '') : `https://${stripped}`
}

/** V11 签名的 GET 请求（订阅面通用：`/v1/subscription`、`/v1/model-token-rates`）。 */
async function v11SignedGet(
  fetcher: typeof fetch,
  url: string,
  credential: OfficeAceCredential,
  path: string,
  options: { signal?: AbortSignal } = {},
): Promise<Response> {
  const host = new URL(url).host
  const timestampMs = Date.now()
  const sdkDate = formatSdkDate(timestampMs)
  const projectId = stringValue(credential.project_id)
  const signHeaders: Array<[string, string]> = [
    ['host', host], ['x-sdk-date', sdkDate], ['x-subscription-type', 'v2'],
  ]
  if (credential.security_token !== undefined && credential.security_token !== '') {
    signHeaders.push(['x-security-token', credential.security_token])
  }
  if (projectId !== undefined && projectId !== '') {
    signHeaders.push(['x-project-id', projectId])
  }
  const payloadHash = await sha256Hex('')
  const { canonicalRequest, signedHeaders } = buildCanonicalRequest({
    method: 'GET', path, query: '', host, headers: signHeaders, payloadHash,
  })
  const { authorization } = await signV11({
    accessKey: credential.access_key,
    secretKey: credential.secret_key,
    // ⚠️ V11 的 region 作用域：quota.mjs 固定 cn-southwest-2（网关所在 region）。
    region: 'cn-southwest-2',
    service: 'apic',
    canonicalRequest, signedHeaders, timestampMs,
  })
  return fetcher(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'X-Sdk-Date': sdkDate,
      'X-Subscription-Type': 'v2',
      ...(credential.security_token === undefined || credential.security_token === '' ? {} : { 'X-Security-Token': credential.security_token }),
      ...(projectId === undefined || projectId === '' ? {} : { 'X-Project-ID': projectId }),
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
}

/**
 * 模型消耗倍率（`GET {gateway}/v1/model-token-rates`，V11 签名）。
 *
 * 实测响应形状（magpie officeace-auth 2026-10 实机）：
 * `{"models":[{"model_name":"glm-5.3","cost_coefficient":0.79}]}`，
 * snake_case（解析兼容 camelCase）；`model_name` **可能带尾部换行**，必须 trim。
 *
 * ## 缓存与失败语义（magpie 踩过的真缺陷）
 * - 模块级缓存 20 分钟：目录与倍率同源，保证「显示的倍率 = 实际计费」；
 * - **失败返回上一份成功缓存，而不是空表**：空表会让调用方误判「没有任何模型
 *   有倍率」。解析出 0 条同理（上游换形状 ≠ 真没有），失败并重置计时
 *  （20 分钟内不重复打失败的上游）；
 * - 从来没拿到过（缓存为空 + 本次失败）返回空 Map —— 调用方据此降级为
 *   「名字不带 x 系数」，模型照常可用。
 *
 * ⚠️ 刻意**不做** magpie providers-hub 的「倍率表当模型白名单」：
 * 「进了倍率表 ≠ 已部署、免费模型不入表」（该仓库自注的反向例外），
 * 我们的目录以 `{base}/models` 为准，倍率只用于展示。
 */
export interface OfficeAceTokenRate {
  /** 模型 id（已 trim）。 */
  model: string
  /** 消费倍率（x0.08 ~ x2.38 实测范围；1 = 默认）。 */
  rate: number
}

const TOKEN_RATES_TTL_MS = 20 * 60 * 1000
let tokenRatesCache: { at: number; map: Map<string, number> } = { at: 0, map: new Map() }

/** 清空倍率缓存（测试隔离用）。 */
export function resetOfficeAceTokenRatesCache(): void {
  tokenRatesCache = { at: 0, map: new Map() }
}

export async function fetchTokenRates(
  fetcher: typeof fetch,
  credential: OfficeAceCredential,
  options: { signal?: AbortSignal } = {},
): Promise<Map<string, number>> {
  if (Date.now() - tokenRatesCache.at < TOKEN_RATES_TTL_MS && tokenRatesCache.map.size > 0) {
    return tokenRatesCache.map
  }
  // 失败路径：保留旧缓存并重置计时（20 分钟内不重复打失败的上游）。
  const keepStale = (): Map<string, number> => {
    tokenRatesCache = { at: Date.now(), map: tokenRatesCache.map }
    return tokenRatesCache.map
  }

  let response: Response
  try {
    response = await v11SignedGet(fetcher, `${resolveSubscriptionGateway(credential)}/v1/model-token-rates`, credential, '/v1/model-token-rates', options)
  } catch {
    return keepStale()
  }
  if (!response.ok) return keepStale()

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return keepStale()
  }
  const rows = Array.isArray(body)
    ? body
    : Array.isArray((body as Record<string, unknown> | null)?.models)
      ? ((body as Record<string, unknown>).models as unknown[])
      : Array.isArray((body as Record<string, unknown> | null)?.data)
        ? ((body as Record<string, unknown>).data as unknown[])
        : []

  const map = new Map<string, number>()
  for (const row of rows) {
    if (!isRecord(row)) continue
    const raw = stringValue(row.model_name) ?? stringValue(row.modelName) ?? stringValue(row.model) ?? stringValue(row.name)
    // ⚠ 实测 model_name 带尾部换行（"kimi-k3\n"）→ stringValue 已非空，但 trim 交给这里。
    const name = typeof raw === 'string' ? raw.trim() : ''
    const rate = numberValue(row.cost_coefficient) ?? numberValue(row.costCoefficient) ?? numberValue(row.rate)
    if (name !== '' && rate !== undefined && Number.isFinite(rate)) map.set(name, rate)
  }
  if (map.size === 0) return keepStale()

  tokenRatesCache = { at: Date.now(), map }
  return map
}

/** 拉取订阅/积分快照（V11 签名 + `x-subscription-type: v2`）。 */
export async function fetchSubscriptionSnapshot(
  fetcher: typeof fetch,
  product: OfficeAceProduct,
  credential: OfficeAceCredential,
  options: { signal?: AbortSignal } = {},
): Promise<OfficeAceSubscriptionSnapshot> {
  const response = await v11SignedGet(fetcher, `${resolveSubscriptionGateway(credential)}/v1/subscription`, credential, '/v1/subscription', options)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`OfficeAce：订阅查询返回 HTTP ${response.status}${text === '' ? '' : `：${text.slice(0, 200)}`}`)
  }
  const body: unknown = await response.json().catch(() => undefined)
  return parseSubscriptionSnapshot(body)
}

/**
 * 领取今天的奖励积分（每日签到 + 一次性新人礼）。
 *
 * ## 上游形态（`aimod-cc/Agent2API` 的 `providers/officeace/checkin.rs`）
 *
 * `POST {gateway}/v1/subscription/bonus/claim`（V11 签名，与订阅查询同套）
 * —— 上游**一次调用**把当天所有可领奖励一起发下来，所以「签到」与「新手
 * 任务」在服务端是同一个动作。
 *
 * ## 幂等由上游保证
 * 一天一个活动只能领一次，**重复领不报错**（返回同一份列表、
 * `current_value` 不变），因此这里没有「已领过」这条分支 —— 上游不回错，
 * 重复调就是安全的空动作。
 *
 * ## 返回值
 * `gained` 优先**直读领取响应**的 `bonus_skus[].points`（magpie officeace-auth
 * 同款，2026-10-29：零额外请求）；直读不出（响应为空/形状变化）才退回
 * 「领前/领后两次订阅查询」的增量法。两条路都拿不到时为 `undefined`，
 * 此时**如实说「已签到」而不编一个数字**。
 */
export async function claimBonus(
  fetcher: typeof fetch,
  product: OfficeAceProduct,
  credential: OfficeAceCredential,
  options: { signal?: AbortSignal } = {},
): Promise<{ gained: number | undefined; message: string }> {
  // 领之前记一份余额好算增量；读失败不阻断签到（只是少一个读数，
  // 不能因此判签到失败 —— 与上游同一取舍）。
  let before: number | undefined
  try {
    const snapshot = await fetchSubscriptionSnapshot(fetcher, product, credential, options)
    before = snapshot.remaining
  } catch {
    before = undefined
  }

  const rawBase = credential.model_info !== undefined && isRecord(credential.model_info)
    ? stringValue(credential.model_info.model_api_url_base)
    : undefined
  if (rawBase === undefined || rawBase === '') {
    throw new Error('OfficeAce：凭据缺少 model_info.model_api_url_base（重新登录可重建）')
  }
  const stripped = rawBase.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  const gateway = /^https?:\/\//.test(rawBase) ? rawBase.replace(/\/+$/, '') : `https://${stripped}`
  const url = `${gateway}${OFFICEACE_BONUS_CLAIM_PATH}`
  const host = new URL(url).host
  const timestampMs = Date.now()
  const sdkDate = formatSdkDate(timestampMs)
  const projectId = stringValue(credential.project_id)
  const signHeaders: Array<[string, string]> = [
    ['host', host], ['x-sdk-date', sdkDate], ['x-subscription-type', 'v2'],
  ]
  if (credential.security_token !== undefined && credential.security_token !== '') {
    signHeaders.push(['x-security-token', credential.security_token])
  }
  if (projectId !== undefined && projectId !== '') {
    signHeaders.push(['x-project-id', projectId])
  }
  // POST 的空体：payloadHash 仍是 SHA-256('') —— 上游 SDK 同款口径。
  const payloadHash = await sha256Hex('')
  const { canonicalRequest, signedHeaders } = buildCanonicalRequest({
    method: 'POST', path: OFFICEACE_BONUS_CLAIM_PATH, query: '', host, headers: signHeaders, payloadHash,
  })
  const { authorization } = await signV11({
    accessKey: credential.access_key,
    secretKey: credential.secret_key,
    // ⚠️ V11 的 region 作用域：quota.mjs 固定 cn-southwest-2（网关所在 region）。
    region: 'cn-southwest-2',
    service: 'apic',
    canonicalRequest, signedHeaders, timestampMs,
  })
  const response = await fetcher(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: authorization,
      'X-Sdk-Date': sdkDate,
      'X-Subscription-Type': 'v2',
      ...(credential.security_token === undefined || credential.security_token === '' ? {} : { 'X-Security-Token': credential.security_token }),
      ...(projectId === undefined || projectId === '' ? {} : { 'X-Project-ID': projectId }),
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`OfficeAce：领奖返回 HTTP ${response.status}${text === '' ? '' : `：${text.slice(0, 200)}`}`)
  }

  // ── ① 直读响应（magpie officeace-auth 同款，2026-10-29）：领取响应自带
  // `bonus_skus[]`（activity_name + points），省掉领前/领后两次订阅查询。
  const text = await response.text().catch(() => '')
  if (text !== '') {
    try {
      const body: unknown = JSON.parse(text)
      const bonusSkus = Array.isArray((body as Record<string, unknown>)?.bonus_skus)
        ? ((body as Record<string, unknown>).bonus_skus as unknown[]).filter(isRecord)
        : []
      const rows = bonusSkus.map((row) => ({
        name: stringValue(row.activity_name) ?? stringValue(row.activity_id) ?? '活动奖励',
        points: numberValue(row.points) ?? 0,
      }))
      const direct = rows.reduce((sum, row) => sum + row.points, 0)
      if (rows.length > 0) {
        return direct > 0
          ? { gained: direct, message: `已领取 ${direct} 积分（${rows.map((r) => `${r.name} +${r.points}`).join('；')}）` }
          : { gained: 0, message: '今天没有可领的奖励（或已领过）' }
      }
      // bonus_skus 是空数组：上游幂等的「今天已领完」形态（2xx + 空表）。
      // 退回增量法确认：增量 ≤ 0 时如实报「没有可领」。
    } catch {
      // 2xx 但 JSON 解析失败：领取本身可能已成功（上游幂等，明天再来），
      // 不当失败报（magpie 同款取舍）—— 退回增量法尽力算一个数。
    }
  }

  // ── ② 增量法兜底（响应为空/直读不出）：领前读数没拿到时如实说「已签到」。
  if (before === undefined) return { gained: undefined, message: '已签到' }
  let after: number | undefined
  try {
    const snapshot = await fetchSubscriptionSnapshot(fetcher, product, credential, options)
    after = snapshot.remaining
  } catch {
    after = undefined
  }
  if (after === undefined) return { gained: undefined, message: '已签到' }
  const gained = after - before
  return gained > 0
    ? { gained, message: `已领取 ${gained} 积分` }
    : { gained, message: '今天没有可领的奖励（或已领过）' }
}

/**
 * ⑥ 身份校验 + 模型信息（SDK-HMAC 签名）。
 *
 * 返回里多了网关三件套（`baseUrl`/`appKey`/`appSecret`）：真实响应把推理
 * 网关凭据藏在 `subscription.model_info` 的 `model_auth_info` 里（两份参考
 * 实现一致），本插件的 `exchangeCodeForSts` 又拿不到它们，必须在这里补齐。
 */
export async function validatePermission(
  fetcher: typeof fetch,
  product: OfficeAceProduct,
  credential: OfficeAceCredential,
  signal?: AbortSignal,
): Promise<{
  accountId?: string
  principalId?: string
  nickname?: string
  projectId?: string
  modelInfo?: unknown
  baseUrl?: string
  appKey?: string
  appSecret?: string
}> {
  const path = OFFICEACE_PERMISSION_PATH
  const host = new URL(product.cloudBase).host
  const payloadHash = await sha256Hex('')
  const timestampMs = Date.now()
  const sdkDate = formatSdkDate(timestampMs)
  const projectId = stringValue(credential.project_id)
  // ⚠️ 签名头集合必须与发送的头一致：两份参考实现（officeace2api `signV4`
  // 的 putCommonHeaders、Agent2API signer）都把 `x-security-token` 与
  // `x-project-id` 一并纳入 SignedHeaders。只签 host+x-sdk-date 会被上游
  // 判签名不匹配（401），形态与「凭据失效」相同，极易误判。
  const signHeaders: Array<[string, string]> = [['host', host], ['x-sdk-date', sdkDate]]
  if (credential.security_token !== undefined && credential.security_token !== '') {
    signHeaders.push(['x-security-token', credential.security_token])
  }
  if (projectId !== undefined && projectId !== '') {
    signHeaders.push(['x-project-id', projectId])
  }
  const { canonicalRequest, signedHeaders } = buildCanonicalRequest({
    method: 'GET', path, query: '', host,
    headers: signHeaders,
    payloadHash,
  })
  const { authorization } = await signSdkHmac({
    accessKey: credential.access_key,
    secretKey: credential.secret_key,
    canonicalRequest, signedHeaders, timestampMs,
  })
  const response = await fetcher(`${product.cloudBase}${path}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'X-Sdk-Date': sdkDate,
      ...(credential.security_token === undefined ? {} : { 'X-Security-Token': credential.security_token }),
      ...(projectId === undefined ? {} : { 'X-Project-ID': projectId }),
    },
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new Error(`OfficeAce：身份校验返回 HTTP ${response.status}`)
  const body: unknown = await response.json().catch(() => undefined)
  if (!isRecord(body)) return {}
  // model_info 的两种位置（Agent2API 实测）：validate 嵌在 subscription.model_info，
  // 开通（client-subscription）响应在顶层；字段名一致。非对象一律当「没有」
  //（= 账号未开通，不是错误 —— 是否走开通由调用方决定）。
  const modelInfoRaw = [
    isRecord(body.model_info) ? body.model_info : undefined,
    isRecord(body.subscription) && isRecord(body.subscription.model_info) ? body.subscription.model_info : undefined,
    isRecord(body.modelInfo) ? body.modelInfo : undefined,
  ].find((value) => value !== undefined)
  // 网关三件套（Agent2API gateway_of 逐字）：基址规范化到 /v2，
  // app key/secret 在 model_auth_info 里。
  let baseUrl: string | undefined
  let appKey: string | undefined
  let appSecret: string | undefined
  if (modelInfoRaw !== undefined) {
    const authInfo = isRecord(modelInfoRaw.model_auth_info) ? modelInfoRaw.model_auth_info : undefined
    const rawKey = authInfo === undefined ? undefined : stringValue(authInfo.model_app_key)
    const rawSecret = authInfo === undefined ? undefined : stringValue(authInfo.model_app_secret)
    const rawBase = stringValue(modelInfoRaw.model_api_url_base)
    if (rawKey !== undefined && rawKey !== '') appKey = rawKey
    if (rawSecret !== undefined && rawSecret !== '') appSecret = rawSecret
    if (rawBase !== undefined && rawBase !== '') {
      const stripped = rawBase.replace(/^https?:\/\//, '').replace(/\/+$/, '')
      baseUrl = stripped === '' ? undefined : (stripped.endsWith('/v2') ? `https://${stripped}` : `https://${stripped}/v2`)
    }
  }
  return {
    ...(stringValue(body.account_id) === undefined ? {} : { accountId: stringValue(body.account_id) }),
    ...(stringValue(body.principal_id) === undefined ? {} : { principalId: stringValue(body.principal_id) }),
    ...(stringValue(body.nickname) === undefined ? {} : { nickname: stringValue(body.nickname) }),
    ...(stringValue(body.project_id) === undefined ? {} : { projectId: stringValue(body.project_id) }),
    ...(modelInfoRaw === undefined ? {} : { modelInfo: modelInfoRaw }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(appKey === undefined ? {} : { appKey }),
    ...(appSecret === undefined ? {} : { appSecret }),
  }
}
