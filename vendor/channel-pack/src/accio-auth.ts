/**
 * Accio API：OAuth 换 token、续期、模型目录、额度、SSE 推理。
 *
 * ⚠️ 所有调用都**不带 Authorization 头** —— token 走 query 或 body。
 */

import {
  ACCIO_GENERATE_PATH,
  ACCIO_LLM_CONFIG_PATH,
  ACCIO_QUOTA_PATH,
  ACCIO_REFRESH_PATH,
  ACCIO_TOKEN_PATH,
  ACCIO_USERINFO_PATH,
  type AccioProduct,
} from './accio-product.js'
import {
  accioHeaders,
  buildGenerateBody,
  isCredentialUsable,
  parseAdkFrame,
  parseTokenResponse,
  type AccioCredential,
} from './accio.js'

/**
 * 取一个数字字段；**`0` 是合法值**，所以只在「不是有限数字」时返回 undefined。
 *
 * 不能写成 `value ? value : undefined` —— 那会把 `usagePercent: 0`（额度完全未用）
 * 当成缺失，面板就会报「余额查询失败」而不是「剩余 100%」。
 */
function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 用授权码换 token。 */
export async function exchangeCode(
  fetcher: typeof fetch,
  product: AccioProduct,
  code: string,
  verifier: string,
  redirectUri: string,
  signal?: AbortSignal,
): Promise<AccioCredential> {
  const response = await fetcher(`${product.gatewayBase}${ACCIO_TOKEN_PATH}`, {
    method: 'POST',
    headers: accioHeaders(product),
    body: JSON.stringify({
      code,
      codeVerifier: verifier,
      clientId: product.clientId,
      redirectUri,
    }),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new Error(`Accio：换 token 返回 HTTP ${response.status}`)
  const credential = parseTokenResponse(await response.json().catch(() => undefined))
  if (credential === undefined) throw new Error('Accio：换 token 响应缺少 accessToken')
  return credential
}

/** 续期。 */
/**
 * 「上游明确拒绝续期」的终态信号（refresh_token 已作废，重试无意义）。
 *
 * 上游 `refresh_token` 端点的拒绝形态是 **HTTP 200 + 业务码**：
 * `{"success":false,"code":"502","message":"auth not pass"}` —— 2026-10-31
 * 实测：登录态被上游整体吊销时（access_token 与 refresh_token 同时作废，
 * 对话回 `error_code:402 unauthorized`、额度回 `401 NOT_LOGIN`），refresh
 * 两种路径（`/api/auth/refresh_token` 与 `/api/auth/safe/refresh_token`）
 * 都回这一形态，与「请求形态不对」无关（用上游 Agent2API 同款头族复测同样
 * 被拒）。调用方据此提示**重新登录**，而不是让用户反复点续期。
 */
export class AccioRefreshRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AccioRefreshRejectedError'
  }
}

/** 读上游 JSON 的 `message` 字段（拒绝原因原文）。 */
async function upstreamRejectMessage(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { message?: unknown; code?: unknown }
    const message = typeof body.message === 'string' && body.message !== '' ? body.message : undefined
    const code = typeof body.code === 'string' || typeof body.code === 'number' ? String(body.code) : undefined
    return message === undefined ? undefined : code === undefined ? message : `${message}（code ${code}）`
  } catch {
    return undefined
  }
}

export async function refreshCredential(
  fetcher: typeof fetch,
  product: AccioProduct,
  credential: AccioCredential,
  signal?: AbortSignal,
): Promise<AccioCredential | undefined> {
  if (credential.refresh_token === undefined) return undefined
  try {
    const response = await fetcher(`${product.gatewayBase}${ACCIO_REFRESH_PATH}`, {
      method: 'POST',
      headers: accioHeaders(product),
      body: JSON.stringify({
        accessToken: credential.access_token,
        refreshToken: credential.refresh_token,
      }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) return undefined
    // ⚠️ 上游拒绝是 **HTTP 200 + `success:false`**（见 AccioRefreshRejectedError
    // 注释）：必须在这里显式区分「拒绝」与「响应形状不认识」—— 前者是终态
    //（重新登录），后者才值得笼统重试。
    const body: unknown = await response.json().catch(() => undefined)
    if (typeof body === 'object' && body !== null && !Array.isArray(body)
      && (body as { success?: unknown }).success === false) {
      const detail = await upstreamRejectMessage(response).catch(() => undefined)
      throw new AccioRefreshRejectedError(
        `Accio：续期被上游拒绝（${detail ?? 'auth not pass'}）。登录态已被上游作废，请到渠道面板重新登录`,
      )
    }
    const refreshed = parseTokenResponse(body)
    if (refreshed === undefined) return undefined
    // 续期响应可能不带 refresh_token —— 沿用旧的。
    return {
      ...refreshed,
      refresh_token: refreshed.refresh_token ?? credential.refresh_token,
      ...(credential.account_id === undefined ? {} : { account_id: credential.account_id }),
      ...(credential.nickname === undefined ? {} : { nickname: credential.nickname }),
    }
  } catch (error) {
    // 拒绝信号原样上抛（终态，调用方要如实展示）；网络异常等仍按 undefined 兜底。
    if (error instanceof AccioRefreshRejectedError) throw error
    return undefined
  }
}

/** 读用户资料（token 走 query）。 */
export async function fetchUserInfo(
  fetcher: typeof fetch,
  product: AccioProduct,
  credential: AccioCredential,
  signal?: AbortSignal,
): Promise<{ accountId?: string; nickname?: string } | undefined> {
  try {
    const query = new URLSearchParams({ accessToken: credential.access_token }).toString()
    const response = await fetcher(`${product.gatewayBase}${ACCIO_USERINFO_PATH}?${query}`, {
      method: 'GET',
      headers: accioHeaders(product),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) return undefined
    const body: unknown = await response.json().catch(() => undefined)
    if (typeof body !== 'object' || body === null) return undefined
    const record = body as Record<string, unknown>
    const data = typeof record.data === 'object' && record.data !== null ? record.data as Record<string, unknown> : record
    return {
      ...(typeof data.userId === 'string' ? { accountId: data.userId } : {}),
      ...(typeof data.nickname === 'string' ? { nickname: data.nickname } : {}),
    }
  } catch {
    return undefined
  }
}

/** 读额度。返回用量百分比（0–1）。 */
export async function fetchQuota(
  fetcher: typeof fetch,
  product: AccioProduct,
  credential: AccioCredential,
  signal?: AbortSignal,
): Promise<{ usedPercent?: number; resetAtMs?: number } | undefined> {
  try {
    const query = new URLSearchParams({ accessToken: credential.access_token }).toString()
    const response = await fetcher(`${product.gatewayBase}${ACCIO_QUOTA_PATH}?${query}`, {
      method: 'GET',
      headers: accioHeaders(product),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) return undefined
    const body: unknown = await response.json().catch(() => undefined)
    if (typeof body !== 'object' || body === null) return undefined
    const record = body as Record<string, unknown>
    const data = typeof record.data === 'object' && record.data !== null ? record.data as Record<string, unknown> : record
    // ⚠️ 上游字段是 **`usagePercent`**（usage），不是 `usedPercent`（used）——
    // 少一个字母就永远取不到值，`fetchQuota` 返回空对象，面板显示「余额查询失败」。
    // 2026-10-24 实测响应：
    //   {"success":true,"code":"200","message":"0",
    //    "data":{"usagePercent":0.00,"refreshCountdownSeconds":86400}}
    // 三个变体都收（上游不同版本/网关可能换写法），并注意 **0 是合法值**，
    // 不能用 `if (!used)` 之类的 falsy 判断把它当缺失。
    const used = numberOrUndefined(data.usagePercent)
      ?? numberOrUndefined(data.usedPercent)
      ?? numberOrUndefined(data.usage_percent)
      ?? numberOrUndefined(data.used_percent)
    // 重置时刻有两种表达：绝对时间戳（resetAt）与**剩余秒数**（refreshCountdownSeconds）。
    const resetRaw = numberOrUndefined(data.resetAt)
    const countdown = numberOrUndefined(data.refreshCountdownSeconds)
      ?? numberOrUndefined(data.refresh_countdown_seconds)
    const resetAtMs = resetRaw !== undefined
      ? (resetRaw < 1e12 ? resetRaw * 1000 : resetRaw)
      : countdown !== undefined && countdown > 0
        ? Date.now() + countdown * 1000
        : undefined
    return {
      ...(used === undefined ? {} : { usedPercent: used }),
      ...(resetAtMs === undefined ? {} : { resetAtMs }),
    }
  } catch {
    return undefined
  }
}

/**
 * 拉模型目录（POST，body 带 token）。
 *
 * 形状不对抛错（不返回空数组）—— 空数组会被误读成「账号没有模型」。
 */
export async function fetchModels(
  fetcher: typeof fetch,
  product: AccioProduct,
  credential: AccioCredential,
  signal?: AbortSignal,
): Promise<Array<{
  id: string
  name: string
  contextWindow: number
  maxTokens?: number
  /** 计费倍率（上游 `usageMultiple`）；`null` 表示上游未下发，展示时不写后缀。 */
  priceFactor?: number
  /** 上游 `freeUse: true` —— 免费额度模型。 */
  isFree?: boolean
  /** 中文展示名（上游 `modelDisplayNameCn`）。 */
  nameCn?: string
  /** 上游是否支持思考（`enableThinking`）。 */
  supportsThinking?: boolean
  /** 成本说明（上游 `usageDescCn` / `usageDesc`）。 */
  usageDesc?: string
}>> {
  const response = await fetcher(`${product.gatewayBase}${ACCIO_LLM_CONFIG_PATH}`, {
    method: 'POST',
    headers: accioHeaders(product),
    body: JSON.stringify({ token: credential.access_token }),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new Error(`Accio：模型目录返回 HTTP ${response.status}`)
  const body: unknown = await response.json().catch(() => undefined)
  if (typeof body !== 'object' || body === null) throw new Error('Accio：模型目录响应不是对象')
  const record = body as Record<string, unknown>
  // ⚠️ 真实形状是**按 provider 分组的数组**（2026-10-24 实测 9 组 / 79 个模型）：
  //   { data: [ { provider, providerDisplayName, modelList: [ {modelCode, modelDisplayName,
  //                contextWindow, visible, multimodal, ...} ] } ] }
  // 早期只认「models / data 直接是模型条目数组」，遇到组数组时每条都没有 id →
  // 解析 0 条 → 抛「模型目录为空」→ 永远落到 2 条静态兜底表（用户报障：只有 2 个模型）。
  // 因此先把组结构拍平；单条形状（老网关/别的实现）继续兼容。
  const rawList = Array.isArray(record.models) ? record.models
    : Array.isArray(record.data) ? record.data
    : undefined
  if (rawList === undefined) throw new Error('Accio：模型目录缺少 models 数组')
  const list: unknown[] = []
  for (const raw of rawList) {
    if (typeof raw !== 'object' || raw === null) continue
    const group = raw as Record<string, unknown>
    const nested = group.modelList ?? group.models
    if (Array.isArray(nested)) {
      // 组级 `visible: false` 表示整组不对外，跳过（实测存在该字段）。
      if (group.visible === false) continue
      for (const item of nested) list.push(item)
    } else {
      list.push(raw)
    }
  }
  if (list.length === 0) throw new Error('Accio：模型目录为空')
  const rows: Array<{
    id: string
    name: string
    contextWindow: number
    maxTokens?: number
    priceFactor?: number
    isFree?: boolean
    nameCn?: string
    supportsThinking?: boolean
    usageDesc?: string
  }> = []
  const seenIds = new Set<string>()
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as Record<string, unknown>
    // 组内字段名：modelCode / modelName；兼容旧的 id / model。
    const id = typeof item.modelCode === 'string' && item.modelCode !== '' ? item.modelCode
      : typeof item.id === 'string' ? item.id
      : typeof item.model === 'string' ? item.model
      : undefined
    if (id === undefined) continue
    // 上游标记隐藏的模型不进候选。
    if (item.visible === false) continue
    // ⚠️ 同一个 modelCode 可能出现在多个 provider 组里（实测 77 个唯一 code / 79 条），
    // 重复项会让选择器出现同名模型两次，必须按 id 去重。
    if (seenIds.has(id)) continue
    seenIds.add(id)
    const name = typeof item.modelDisplayName === 'string' && item.modelDisplayName !== '' ? item.modelDisplayName
      : typeof item.name === 'string' ? item.name
      : typeof item.displayName === 'string' ? item.displayName
      : id
    const contextRaw = item.contextWindow ?? item.context_window ?? item.maxInputTokens
    const contextWindow = typeof contextRaw === 'number' && contextRaw > 0 ? contextRaw : 128_000
    const maxRaw = item.maxTokens ?? item.max_output_tokens
    const maxTokens = typeof maxRaw === 'number' && maxRaw > 0 ? Math.min(maxRaw, contextWindow) : undefined
    /**
     * 倍率（用户 2026-10-26 要求「倍率从远端取、没有就不显示」）。
     *
     * 上游 `usageMultiple` 是**数字**或 `null`：
     * - `3.5` / `0.09` … → 直接用；
     * - `null`（实测 `auto` 这类路由项就是 null）→ **不带倍率**，不编造 x1。
     *
     * `discountRuleList` 是限时折扣：`discountedMultiple` 是折后价。
     * 只有当它确实低于 `usageMultiple` 时才算「当前生效的折扣」。
     */
    const usageMultiple = typeof item.usageMultiple === 'number' && Number.isFinite(item.usageMultiple)
      ? item.usageMultiple : undefined
    let priceFactor = usageMultiple
    const discount = pickAccioDiscount(item.discountRuleList)
    if (discount !== undefined && priceFactor !== undefined && discount < priceFactor) {
      priceFactor = discount
    }
    const nameCn = typeof item.modelDisplayNameCn === 'string' && item.modelDisplayNameCn.trim() !== ''
      ? item.modelDisplayNameCn.trim() : undefined
    const usageDescRaw = typeof item.usageDescCn === 'string' && item.usageDescCn.trim() !== ''
      ? item.usageDescCn.trim()
      : typeof item.usageDesc === 'string' && item.usageDesc.trim() !== '' ? item.usageDesc.trim() : undefined
    rows.push({
      id,
      name,
      contextWindow,
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(priceFactor === undefined ? {} : { priceFactor }),
      ...(item.freeUse === true ? { isFree: true } : {}),
      ...(nameCn === undefined ? {} : { nameCn }),
      ...(typeof item.enableThinking === 'boolean' ? { supportsThinking: item.enableThinking } : {}),
      ...(usageDescRaw === undefined ? {} : { usageDesc: usageDescRaw }),
    })
  }
  if (rows.length === 0) throw new Error('Accio：模型目录为空')
  return rows
}

/**
 * 从 `discountRuleList` 里取**当前生效**的最低折扣倍率。
 *
 * 规则形状（2026-10-27 实测）：
 * ```
 * { ruleId, ruleType: 'LIMITED_TIME', regionList, discountedMultiple,
 *   effectiveStart, effectiveEnd, dailyWindowList, timezone }
 * ```
 * `effectiveStart/End` 为 `null` 表示不限期；有值时只在该区间内生效。
 * 任一规则无法判定就跳过 —— 宁可少打折，也不要把过期折扣一直显示出来。
 */
function pickAccioDiscount(raw: unknown, now: Date = new Date()): number | undefined {
  if (!Array.isArray(raw)) return undefined
  let best: number | undefined
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const rule = entry as Record<string, unknown>
    const value = typeof rule.discountedMultiple === 'number' && Number.isFinite(rule.discountedMultiple)
      ? rule.discountedMultiple : undefined
    if (value === undefined) continue
    if (!accioRuleActive(rule, now)) continue
    if (best === undefined || value < best) best = value
  }
  return best
}

/** 判断一条折扣规则此刻是否生效（区间 + 每日时段）。 */
function accioRuleActive(rule: Record<string, unknown>, now: Date): boolean {
  const start = typeof rule.effectiveStart === 'string' ? Date.parse(rule.effectiveStart) : Number.NaN
  const end = typeof rule.effectiveEnd === 'string' ? Date.parse(rule.effectiveEnd) : Number.NaN
  if (Number.isFinite(start) && now.getTime() < start) return false
  if (Number.isFinite(end) && now.getTime() > end) return false
  const windows = rule.dailyWindowList
  if (!Array.isArray(windows) || windows.length === 0) return true
  // 每日时段：`{ startTime: 'HH:mm', endTime: 'HH:mm' }`（时区取 rule.timezone）。
  const minutes = now.getHours() * 60 + now.getMinutes()
  return windows.some((w) => {
    if (w === null || typeof w !== 'object') return false
    const item = w as Record<string, unknown>
    const from = parseClockMinutes(item.startTime)
    const to = parseClockMinutes(item.endTime)
    if (from === undefined || to === undefined) return true
    // 跨零点窗口（如 22:00→08:00）。
    return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to
  })
}

function parseClockMinutes(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (m === null) return undefined
  const h = Number.parseInt(m[1], 10)
  const min = Number.parseInt(m[2], 10)
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return undefined
  return h * 60 + min
}

/** 对话选项。 */
export interface ChatOptions {
  model: string
  messages: readonly { role: string; content: unknown }[]
  system?: string
  tools?: readonly { name: string; description?: string; parameters?: unknown }[]
  signal?: AbortSignal
}

/**
 * 流式推理（异步生成器）。
 *
 * ⚠️ 上游的业务错误**不体现在 HTTP 状态码上**（常是 200 + 帧里的 error_code），
 * 故每帧都要判 error_code。
 */
export async function* streamChat(
  fetcher: typeof fetch,
  product: AccioProduct,
  credential: AccioCredential,
  options: ChatOptions,
): AsyncGenerator<{ text?: string; reasoning?: string }, void, undefined> {
  if (!isCredentialUsable(credential)) {
    throw new Error('Accio：没有可用凭据，请先登录')
  }
  const { createHash, randomUUID } = await import('node:crypto')
  const requestId = randomUUID()
  // 上游要求 sg_k=<md5(requestId)>。
  const sgK = createHash('md5').update(requestId).digest('hex')

  const response = await fetcher(`${product.llmBase}${ACCIO_GENERATE_PATH}?sg_k=${sgK}`, {
    method: 'POST',
    headers: { ...accioHeaders(product), Accept: 'text/event-stream' },
    body: JSON.stringify(buildGenerateBody({
      token: credential.access_token,
      model: options.model,
      messages: options.messages,
      ...(options.system === undefined ? {} : { system: options.system }),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
    })),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Accio：推理返回 HTTP ${response.status}${text === '' ? '' : `：${text.slice(0, 200)}`}`)
  }
  if (response.body === null) throw new Error('Accio：推理响应没有正文')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        if (!line.startsWith('data:')) continue
        const raw = line.slice(5).trim()
        if (raw === '' || raw === '[DONE]') continue
        let parsed: unknown
        try { parsed = JSON.parse(raw) } catch { continue }
        const frame = parseAdkFrame(parsed)
        if (frame === undefined) continue
        if (frame.kind === 'done') return
        if (frame.kind === 'error') throw new Error(`Accio 上游错误：${frame.message}`)
        yield frame
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
}

/**
 * Accio 登录：本地回调 OAuth + PKCE。
 *
 * 与 Command Code 同型（本地 HTTP 服务收 `code`），差别在：
 * - Accio 用 **PKCE S256**（`code_verifier` / `code_challenge`）；
 * - 授权站点按地区不同（国际 `www.accio.com` / 国内 `www.accio-ai.com`）。
 *
 * ⚠️ 回调地址 `http://localhost:<port>/callback` 需要在 Accio 的 OAuth 客户端
 * 白名单里。若上游对 `accio-work` 这个 client 限制了 redirect_uri，
 * 授权页会直接拒绝 —— 此时用户仍可用「粘贴访问令牌」的路径（已在
 * `ADOPTABLE_CHANNELS` 里保留）。
 */

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

// ⚠️ AccioProduct / AccioCredential 已在文件顶部从**同一对文件**导入；
// 这里曾经重复导入（TS2300 Duplicate identifier，2026-10-31 门禁）——
// 顶部块补上本段实际用到的值导入，避免两份绑定。
import { ACCIO_LOGIN_START_PORT } from './accio-product.js'
import { buildAccioAuthUrl, createPkcePair } from './accio.js'

/** 回调路径。 */
export const ACCIO_CALLBACK_PATH = '/callback'
/** 端口尝试次数。 */
const PORT_ATTEMPTS = 10
/** 登录总时限。 */
const LOGIN_TIMEOUT_MS = 300_000

/** 已启动的 Accio 登录。 */
export interface StartedAccioLogin {
  loginUrl: string
  port: number
  result: Promise<AccioCredential>
  close: () => Promise<void>
}

/**
 * 启动 Accio 登录并立即返回授权 URL。
 *
 * 与 Command Code 的 `startCommandCodeLogin` 同一形态：不等用户，
 * 由调用方展示 URL 并 await `result`。
 */
export async function startAccioLogin(options: {
  product: AccioProduct
  fetcher?: typeof fetch
  timeoutMs?: number
}): Promise<StartedAccioLogin> {
  const fetcher = options.fetcher ?? fetch
  const { product } = options
  const state = randomUUID()
  const pkce = await createPkcePair()

  let resolveResult!: (value: AccioCredential) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<AccioCredential>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  result.catch(() => {})

  let port = 0
  // 处理函数抽出来：v4 与 v6 两个监听器要共用同一份逻辑。
  const handler: import('node:http').RequestListener = (request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
    if (!url.pathname.startsWith(ACCIO_CALLBACK_PATH)) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
      return
    }
    const code = url.searchParams.get('code')
    const gotState = url.searchParams.get('state')
    if (code === null || code === '' || gotState !== state) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('登录回调参数无效')
      return
    }
    const redirectUri = `http://localhost:${port}${ACCIO_CALLBACK_PATH}`
    void exchangeCode(fetcher, product, code, pkce.verifier, redirectUri)
      .then((credential) => {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end('<html><body><h2>登录成功，可以关闭此窗口了</h2></body></html>')
        resolveResult(credential)
      })
      .catch((error: unknown) => {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('登录换取凭据失败')
        rejectResult(error)
      })
  }
  const server = createServer(handler)

  for (let offset = 0; offset < PORT_ATTEMPTS; offset++) {
    const candidate = ACCIO_LOGIN_START_PORT + offset
    const bound = await new Promise<boolean>((resolve) => {
      const onError = (): void => { server.removeListener('listening', onListening); resolve(false) }
      const onListening = (): void => { server.removeListener('error', onError); resolve(true) }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(candidate, '127.0.0.1')
    })
    if (bound) { port = candidate; break }
  }
  if (port === 0) {
    throw new Error(`Accio：回调端口 ${ACCIO_LOGIN_START_PORT} 起 ${PORT_ATTEMPTS} 个全部被占用`)
  }

  // ⚠️ 浏览器可能把 `localhost` 解析成 `::1`：只绑 v4 会「授权完页面打不开 / 没反应」。
  // 因此同一端口再听一个 `[::1]`（失败可容忍 —— 机器没开 IPv6 时 `localhost` 走 v4）。
  // `redirect_uri` 必须继续用 `localhost`：Accio 的 OAuth 客户端按它登记白名单，
  // 改成 `127.0.0.1` 会被拒。
  const secondary = createServer(handler)
  await new Promise<void>((resolve) => {
    secondary.once('error', () => resolve())
    secondary.listen(port, '::1', () => resolve())
  })
  const servers = secondary.listening ? [server, secondary] : [server]

  const redirectUri = `http://localhost:${port}${ACCIO_CALLBACK_PATH}`
  const loginUrl = buildAccioAuthUrl(product, redirectUri, state, pkce.challenge)

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    for (const listener of servers) listener.closeAllConnections?.()
    await Promise.all(servers.map((listener) => new Promise<void>((resolve) => listener.close(() => resolve()))))
  }

  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS
  const withTimeout = Promise.race([
    result,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`Accio 登录超时（${Math.round(timeoutMs / 1000)} 秒内未完成）`)), timeoutMs)
      timer.unref?.()
    }),
  ])
  withTimeout.catch(() => {}).finally(() => { void close() })

  return { loginUrl, port, result: withTimeout, close }
}
