/**
 * OfficeAce 凭据与 OAuth 流程。
 *
 * ## 九步（参考实现逐条，见 officeace-product.ts 模块头）
 *
 * ```
 * ① POST {cloud}/v1/claw/auth/state                    → state
 * ② 本地生成 PKCE(S256) 与 P-256 DPoP 密钥对
 * ③ 拼 authorizeUrl，浏览器登华为云
 * ④ GET  {cloud}/v1/claw/auth/code?state=<state>       → 轮询取授权码
 *      202 继续等 / 404 作废 / 200 拿到 code
 * ⑤ POST {sts}/v1/oauth2/tokens（表单 + DPoP 头）      → 临时 AK/SK/STS
 * ⑥ GET  {cloud}/v1/claw/client-permission-validate（SDK-HMAC）
 *      → 身份三件套 + subscription.model_info（可能为空 = 未开通）
 * ⑥a GET {iam}/v3/projects（仅 project_id 空时）→ 按 region 补 project_id
 * ⑥b POST {cloud}/v1/claw/client-subscription（仅 model_info 空时）→ 开通
 * ⑦ 入库
 * ```
 */

import {
  OFFICEACE_CODE_PATH,
  OFFICEACE_IAM_PROJECTS_PATH,
  OFFICEACE_PERMISSION_PATH,
  OFFICEACE_STATE_PATH,
  OFFICEACE_STS_TOKENS_PATH,
  OFFICEACE_SUBSCRIPTION_PATH,
  type OfficeAceProduct,
} from './officeace-product.js'
import {
  buildCanonicalRequest,
  createDpopProof,
  formatSdkDate,
  createDpopKeyPair,
  sha256Hex,
  signSdkHmac,
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
  /** 模型信息（开通后下发）。 */
  model_info?: unknown[]
  /** 创建时间。 */
  created_at?: number
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
    ...(Array.isArray(value.model_info) ? { model_info: value.model_info } : {}),
    created_at: Date.now(),
  }
}

/** 从任意 JSON 安全取字符串。 */
function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 是否非 null 对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断凭据形状是否可用（推理凭据齐备即可）。 */
export function isCredentialUsable(credential: OfficeAceCredential | undefined): credential is OfficeAceCredential {
  if (credential === undefined) return false
  return typeof credential.base_url === 'string' && credential.base_url !== ''
    && typeof credential.app_key === 'string' && credential.app_key !== ''
    && typeof credential.app_secret === 'string' && credential.app_secret !== ''
}

/** 生成 PKCE 对。 */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const verifier = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const challenge = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
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
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: product.clientId,
    redirect_uri: product.redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })
  return `${product.loginBase}${'/authui/login.html'}?${query.toString()}`
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
  // 响应可能直接带推理凭据（baseUrl/appKey/appSecret），也可能只带 AK/SK。
  const credential = parseCredential(body)
  if (credential !== undefined) return credential
  const accessKey = stringValue(body.access_key) ?? stringValue(body.accessKey)
  const secretKey = stringValue(body.secret_key) ?? stringValue(body.secretKey)
  const baseUrl = stringValue(body.baseUrl) ?? stringValue(body.base_url)
  if (accessKey === undefined || secretKey === undefined || baseUrl === undefined) {
    throw new Error('OfficeAce：换临时凭据响应缺少必需字段')
  }
  return {
    base_url: baseUrl,
    app_key: stringValue(body.appKey) ?? stringValue(body.app_key) ?? '',
    app_secret: stringValue(body.appSecret) ?? stringValue(body.app_secret) ?? '',
    access_key: accessKey,
    secret_key: secretKey,
    ...(stringValue(body.security_token) === undefined ? {} : { security_token: stringValue(body.security_token) }),
    created_at: Date.now(),
  }
}

/**
 * ⑥ 身份校验 + 模型信息（SDK-HMAC 签名）。
 */
export async function validatePermission(
  fetcher: typeof fetch,
  product: OfficeAceProduct,
  credential: OfficeAceCredential,
  signal?: AbortSignal,
): Promise<{ accountId?: string; nickname?: string; projectId?: string; modelInfo?: unknown[] }> {
  const path = OFFICEACE_PERMISSION_PATH
  const host = new URL(product.cloudBase).host
  const payloadHash = await sha256Hex('')
  const timestampMs = Date.now()
  const sdkDate = formatSdkDate(timestampMs)
  const { canonicalRequest, signedHeaders } = buildCanonicalRequest({
    method: 'GET', path, query: '', host,
    headers: [['host', host], ['x-sdk-date', sdkDate]],
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
    },
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new Error(`OfficeAce：身份校验返回 HTTP ${response.status}`)
  const body: unknown = await response.json().catch(() => undefined)
  if (!isRecord(body)) return {}
  const subscription = isRecord(body.subscription) ? body.subscription : undefined
  const modelInfo = subscription !== undefined && Array.isArray(subscription.model_info)
    ? subscription.model_info
    : undefined
  return {
    ...(stringValue(body.account_id) === undefined ? {} : { accountId: stringValue(body.account_id) }),
    ...(stringValue(body.nickname) === undefined ? {} : { nickname: stringValue(body.nickname) }),
    ...(stringValue(body.project_id) === undefined ? {} : { projectId: stringValue(body.project_id) }),
    ...(modelInfo === undefined ? {} : { modelInfo }),
  }
}
