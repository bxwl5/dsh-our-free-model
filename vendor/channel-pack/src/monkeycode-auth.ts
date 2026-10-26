/**
 * MonkeyCode 账号 API。
 *
 * 全部走 Cookie 会话认证。本模块只做**只读**操作（账号信息、钱包、
 * 模型目录）与签到；**对话能力未实现** —— 它走 WebSocket，
 * 而本插件零依赖且参考实现自己承认「WS 事件语法未确定」。
 *
 * ## 为什么不做对话
 *
 * 1. 需要手写 RFC6455 客户端（握手 + 帧编解码 + 掩码 + ping/pong），
 *    约 150 行零依赖代码；
 * 2. 即使写完，事件格式（`round` / `message` / `delta`）未经实机确认，
 *    可能解析出空正文；
 * 3. 拿不到真实账号就无法验证。
 *
 * 因此本渠道当前提供：**账号信息、额度查询、模型目录、每日签到**。
 * 模型会出现在选择器里，但发起对话会得到明确的「暂不支持」提示 ——
 * 这比给一个静默失败的假实现更诚实。
 */

import { createHash } from 'node:crypto'

import {
  openWebSocket,
  parseTaskStreamEvent,
  toWebSocketUrl,
} from './monkeycode-ws.js'
import {
  MONKEYCODE_PUBLIC_HOST,
  MONKEYCODE_PUBLIC_IMAGE_ID,
  MONKEYCODE_STREAM_PATH,
  MONKEYCODE_TASKS_PATH,
} from './monkeycode-product.js'
import {
  MONKEYCODE_CHECKIN_PATH,
  MONKEYCODE_MODELS_PATH,
  MONKEYCODE_PROBE_PATH,
  MONKEYCODE_WALLET_PATH,
  type MonkeyCodeProduct,
} from './monkeycode-product.js'
import {
  credentialFromSession,
  isCredentialUsable,
  monkeyCodeHeaders,
  normalizeCookie,
  parseCheckin,
  parseWallet,
  unwrapData,
  type MonkeyCodeCheckinStatus,
  type MonkeyCodeCredential,
  type MonkeyCodeUser,
  type MonkeyCodeWallet,
} from './monkeycode.js'

/** 一次 HTTP 调用的结果。 */
interface CallResult {
  ok: boolean
  status: number
  body: unknown
}

/**
 * 判断是不是普通对象（排除 null 与数组）。
 *
 * 与 `accio.ts` / `autoclaw.ts` / `commandcode.ts` / `kuku.ts` 里的同名函数
 * 实现一致。此前本文件直接调用它却没定义也没 import —— 建任务响应一走到
 * 「取 id」那行就抛 `ReferenceError: isRecord is not defined`，导致
 * MonkeyCode 渠道**每次对话必崩**（2026-10-25 真实调用测试发现）。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 带 Cookie 调一次上游 JSON 接口。
 *
 * 不抛错（网络失败返回 `{ok:false, status:0}`）——
 * 让调用方按「可用性」处理，而不是每处都写 try/catch。
 */
async function call(
  fetcher: typeof fetch,
  product: MonkeyCodeProduct,
  credential: MonkeyCodeCredential,
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<CallResult> {
  try {
    const response = await fetcher(`${product.apiBase}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...monkeyCodeHeaders(product, credential),
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    })
    const text = await response.text().catch(() => '')
    let body: unknown
    try {
      body = text === '' ? undefined : JSON.parse(text)
    } catch {
      body = text
    }
    return { ok: response.ok, status: response.status, body }
  } catch {
    return { ok: false, status: 0, body: undefined }
  }
}

/**
 * 用 Cookie 登录（校验并落成凭据）。
 *
 * 打存活探测端点（`/api/v1/users/wallet`）确认 Cookie 有效。
 * 无效 Cookie 抛错 —— 不要把一份无效凭据写进去让用户以后才发现。
 *
 * ⚠️ 探测端点曾是 `/users/me`，已被上游下线（404）——
 * 见 {@link MONKEYCODE_PROBE_PATH} 的说明。
 */
export async function loginWithCookie(
  fetcher: typeof fetch,
  product: MonkeyCodeProduct,
  rawCookie: string,
  signal?: AbortSignal,
): Promise<MonkeyCodeCredential> {
  const cookie = normalizeCookie(rawCookie)
  if (cookie === undefined) {
    throw new Error('MonkeyCode：Cookie 无效（必须包含 monkeycode_ai_session=… 或旧名 nebula_session=…，且不能为空）')
  }
  const probe: MonkeyCodeCredential = { access_token: cookie }
  // ⚠️ 探测打 `/users/wallet`：`/users/me` 已被上游下线（404），拿它探测会让**任何**
  // 合法 Cookie 都被判无效（用户根本登不进去）。
  const result = await call(fetcher, product, probe, MONKEYCODE_PROBE_PATH, { signal })
  if (result.status === 0) throw new Error('MonkeyCode：无法连接上游（网络不可达）')
  if (result.status === 401 || result.status === 403) {
    throw new Error('MonkeyCode：Cookie 无效或已过期，请重新从浏览器复制')
  }
  if (!result.ok) throw new Error(`MonkeyCode：存活探测返回 HTTP ${result.status}`)
  // 钱包能读到即视为凭据有效；身份用**会话 Cookie 的值**派生 —— 钱包里的 `id`
  // 是全零占位，用它会让所有账号撞成同一个 account_id。
  const wallet = parseWallet(result.body)
  if (wallet === undefined) throw new Error('MonkeyCode：钱包响应无法解析，无法确认账号')
  return credentialFromSession(cookie)
}

/** 读取当前用户信息。 */
export async function fetchUser(
  _fetcher: typeof fetch,
  _product: MonkeyCodeProduct,
  _credential: MonkeyCodeCredential,
  _signal?: AbortSignal,
): Promise<MonkeyCodeUser | undefined> {
  // ⚠️ 上游没有可用的用户信息端点（`/users/me` 等全 404），钱包里也没有真正的
  // 用户 id（是全零占位）。这里如实返回 `undefined`（「不知道」），
  // 而不是编一个假身份。调用方应容忍 undefined。
  return undefined
}

/**
 * 读取钱包与每日额度。
 *
 * 返回 `undefined` 表示「无法得知」（网络失败或字段未识别），
 * 与「额度为零」是两件事。
 */
export async function fetchWallet(
  fetcher: typeof fetch,
  product: MonkeyCodeProduct,
  credential: MonkeyCodeCredential,
  signal?: AbortSignal,
): Promise<MonkeyCodeWallet | undefined> {
  const result = await call(fetcher, product, credential, MONKEYCODE_WALLET_PATH, { signal })
  return result.ok ? parseWallet(result.body) : undefined
}

/** 读取签到状态。 */
export async function fetchCheckinStatus(
  fetcher: typeof fetch,
  product: MonkeyCodeProduct,
  credential: MonkeyCodeCredential,
  signal?: AbortSignal,
): Promise<MonkeyCodeCheckinStatus> {
  const result = await call(fetcher, product, credential, MONKEYCODE_CHECKIN_PATH, { signal })
  return result.ok ? parseCheckin(result.body) : { checkedIn: false }
}

/**
 * 执行每日签到。
 *
 * 返回签到结果；失败返回 `{ok:false, reason}` 而不是抛错 ——
 * 「今天已经签过了」不是错误，是正常状态。
 */
export async function runCheckin(
  fetcher: typeof fetch,
  product: MonkeyCodeProduct,
  credential: MonkeyCodeCredential,
  signal?: AbortSignal,
): Promise<{ ok: boolean; reason?: string; status?: MonkeyCodeCheckinStatus }> {
  const result = await call(fetcher, product, credential, MONKEYCODE_CHECKIN_PATH, {
    method: 'POST',
    body: {},
    signal,
  })
  if (result.status === 0) return { ok: false, reason: '网络不可达' }
  if (result.status === 401 || result.status === 403) return { ok: false, reason: 'Cookie 已过期，请重新登录' }
  if (!result.ok) {
    const body = unwrapData(result.body)
    const message = typeof body === 'object' && body !== null && 'msg' in body
      ? String((body as Record<string, unknown>).msg)
      : `HTTP ${result.status}`
    return { ok: false, reason: message }
  }
  // ⚠️ 必须校验**业务码**：上游签到失败时照样回 HTTP 200，把错误塞进 `code`。
  // 2026-10-24 实测已签到的账号再 POST 得到
  //   HTTP 200 {"code":10701,"message":"兑换验证码失败"}
  // 早期只看 `response.ok`，于是业务失败被判成功、`credit` 取不到就填 0，
  // 面板显示「已领取 0 积分」——用户以为领到了，其实什么都没发生。
  const envelope: unknown = result.body
  const envelopeRecord = typeof envelope === 'object' && envelope !== null && !Array.isArray(envelope)
    ? envelope as Record<string, unknown>
    : undefined
  const businessCode = typeof envelopeRecord?.code === 'number' ? envelopeRecord.code : undefined
  if (businessCode !== undefined && businessCode !== 0) {
    const message = typeof envelopeRecord?.message === 'string'
      ? envelopeRecord.message
      : `上游返回业务错误（code=${businessCode}）`
    return { ok: false, reason: message }
  }
  return { ok: true, status: parseCheckin(result.body) }
}

/**
 * 读取模型目录。
 *
 * 形状不对时抛错（而不是返回空数组）—— 空数组会让上层误以为
 * 「这个账号没有可用模型」。
 */
export async function fetchModels(
  fetcher: typeof fetch,
  product: MonkeyCodeProduct,
  credential: MonkeyCodeCredential,
  signal?: AbortSignal,
): Promise<Array<{
  id: string
  name: string
  contextWindow: number
  maxTokens?: number
  isHidden?: boolean
  /** 上游 `is_free`：免费额度模型。 */
  isFree?: boolean
  /** 上游 `input_price`：按量计费**单价**（不是倍率）。 */
  inputPrice?: number
  /** 上游 `access_level`（`basic` 等）：访问等级。 */
  accessLevel?: string
  /** 上游 `support_image`。 */
  supportsImage?: boolean
}>> {
  const result = await call(fetcher, product, credential, MONKEYCODE_MODELS_PATH, { signal })
  if (!result.ok) throw new Error(`MonkeyCode：模型目录返回 HTTP ${result.status}`)
  const body = unwrapData(result.body)
  if (!Array.isArray(body)) throw new Error('MonkeyCode：模型目录不是数组')
  const rows: Array<{
    id: string
    name: string
    contextWindow: number
    maxTokens?: number
    isHidden?: boolean
    isFree?: boolean
    inputPrice?: number
    accessLevel?: string
    supportsImage?: boolean
  }> = []
  for (const raw of body) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as Record<string, unknown>
    const id = typeof item.id === 'string' && item.id !== '' ? item.id : undefined
    const name = typeof item.name === 'string' && item.name !== '' ? item.name : undefined
    if (id === undefined || name === undefined) continue
    const contextRaw = item.context_length ?? item.contextWindow
    const contextWindow = typeof contextRaw === 'number' && Number.isFinite(contextRaw) && contextRaw > 0 ? contextRaw : 128_000
    const maxRaw = item.max_tokens ?? item.maxTokens
    const maxTokens = typeof maxRaw === 'number' && Number.isFinite(maxRaw) && maxRaw > 0
      ? Math.min(maxRaw, contextWindow)
      : undefined
    /**
     * ⚠️ **MonkeyCode 是按量计费**（用户 2026-10-26 说明）：`input_price` 是
     * **单价**（实测 `400`），不是 Qoder 那种「倍率」。故本函数不产出
     * `priceFactor`，只如实带出 `isFree` / `inputPrice` / `accessLevel`，
     * 由展示层决定怎么说（免费的直接标「免费」，其余不编造倍率）。
     */
    const inputPrice = typeof item.input_price === 'number' && Number.isFinite(item.input_price) && item.input_price >= 0
      ? item.input_price : undefined
    const accessLevel = typeof item.access_level === 'string' && item.access_level !== ''
      ? item.access_level : undefined
    rows.push({
      id, name, contextWindow,
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(item.is_hidden === true ? { isHidden: true } : {}),
      ...(item.is_free === true ? { isFree: true } : {}),
      ...(inputPrice === undefined ? {} : { inputPrice }),
      ...(accessLevel === undefined ? {} : { accessLevel }),
      ...(item.support_image === true ? { supportsImage: true } : {}),
    })
  }
  if (rows.length === 0) throw new Error('MonkeyCode：模型目录为空')
  return rows
}

/**
 * 判断凭据是否仍有效（轻量探活）。
 *
 * 打存活探测端点（`/api/v1/users/wallet`）看状态码。
 */
export async function probeCredential(
  fetcher: typeof fetch,
  product: MonkeyCodeProduct,
  credential: MonkeyCodeCredential,
  signal?: AbortSignal,
): Promise<'valid' | 'expired' | 'network_error'> {
  if (!isCredentialUsable(credential)) return 'expired'
  // 同 loginWithCookie：`/users/me` 已 404，探活必须用钱包端点。
  const result = await call(fetcher, product, credential, MONKEYCODE_PROBE_PATH, { signal })
  if (result.status === 0) return 'network_error'
  if (result.status === 401 || result.status === 403) return 'expired'
  return result.ok ? 'valid' : 'network_error'
}

/**
 * 建任务（对话入口）。
 *
 * 上游把「一次对话」建模成一个任务：提交需求正文 → 拿 task id →
 * 挂 WebSocket 拉流。字段来自 `monkeycode2api` 实测：
 * - `cli_name` 固定 `opencode`（平台可用的 agent 运行时）
 * - `image_id` / `host_id` 必填（缺了会 400 参数错误）
 * - `task_type: 'chat'` 表示轻量对话（不建沙箱）
 */
export async function createTask(
  fetcher: typeof fetch,
  product: MonkeyCodeProduct,
  credential: MonkeyCodeCredential,
  options: { content: string; modelId: string; signal?: AbortSignal },
): Promise<string> {
  const result = await call(fetcher, product, credential, MONKEYCODE_TASKS_PATH, {
    method: 'POST',
    body: {
      content: options.content,
      cli_name: 'opencode',
      model_id: options.modelId,
      image_id: MONKEYCODE_PUBLIC_IMAGE_ID,
      host_id: MONKEYCODE_PUBLIC_HOST,
      task_type: 'chat',
      resource: { core: 2, memory: 8 * 1024 * 1024 * 1024, life: 7200 },
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (result.status === 0) throw new Error('MonkeyCode：建任务失败（网络不可达）')
  if (result.status === 401 || result.status === 403) throw new Error('MonkeyCode：凭据无效或已过期，请重新粘贴 Cookie')
  if (!result.ok) throw new Error(`MonkeyCode：建任务返回 HTTP ${result.status}`)
  const body = unwrapData(result.body)
  // ⚠ 上游的业务错误走 HTTP 200 + `{code, message}`，不是非 2xx。若不先看
  // `code`，会把它误报成「响应缺少 id」，把「你已有一个正在运行的任务」这种
  // 可操作的原因藏掉（2026-10-25 实测 code=10811）。
  if (isRecord(body)) {
    const code = typeof body.code === 'number' ? body.code : undefined
    const message = typeof body.message === 'string' ? body.message : ''
    if (code !== undefined && code !== 0 && code !== 200) {
      throw new Error(`MonkeyCode：建任务被上游拒绝（code ${code}）${message === '' ? '' : `：${message}`}`)
    }
    if (message !== '' && body.id === undefined) {
      throw new Error(`MonkeyCode：建任务被上游拒绝：${message}`)
    }
  }
  const taskId = isRecord(body) ? (typeof body.id === 'string' ? body.id : undefined) : undefined
  if (taskId === undefined || taskId === '') {
    const raw = JSON.stringify(result.body ?? null)
    throw new Error(`MonkeyCode：建任务响应缺少 id（原始响应：${raw.slice(0, 200)}）`)
  }
  return taskId
}

/**
 * 跑一轮对话：建任务 → 连 WebSocket → 逐帧产出增量。
 *
 * ⚠️ **WS 事件格式未经实机确认**（参考实现 monkeycode2api 自己写明
 * 「事件语法无法在无实机下 100% 敲定」）。因此解析是**容错**的：
 * 认不出的帧直接忽略，不当作错误 —— 宁可少显示一点，也不要因为一个
 * 未知事件类型把整轮对话打死。
 */
export async function* streamChat(
  fetcher: typeof fetch,
  product: MonkeyCodeProduct,
  credential: MonkeyCodeCredential,
  options: { content: string; modelId: string; signal?: AbortSignal },
): AsyncGenerator<{ text: string }, void, undefined> {
  // 10811 自愈（必须**先查后建**：createTask 撞 10811 会直接抛，自愈代码
  // 得放在它前面）。官方有 `PUT /tasks/stop`（此前照 a2a 参考误判没有）——
  // 建任务前先停掉同账号卡住的旧任务（多半是之前会话的遗留，用户无从处理；
  // 2026-10-26 用户实测连续多轮 10811，只能干等）。
  const existing = await listMonkeyCodeTasks(fetcher, product, credential, options.signal)
  const running = existing.filter(task => task.status !== 'completed' && task.status !== 'finished' && task.status !== 'error')
  if (running.length > 0) {
    for (const task of running) {
      await stopMonkeyCodeTask({ fetcher, product, credential, taskId: task.id, ...(options.signal === undefined ? {} : { signal: options.signal }) })
    }
    // 停止是异步生效的，稍等上游切换状态。
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
  let taskId = ''
  try {
    taskId = await createTask(fetcher, product, credential, options)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/code 10811/.test(message)) {
      throw new Error('MonkeyCode：已尝试停止旧任务但仍被占用（code 10811），请到 monkeycode 网页端手动处理后再试')
    }
    throw error
  }
  // mode 官方只有两个值（chaitin/MonkeyCode 的 biz/task/handler/v1/task.go:382）：
  //   new（等待用户输入）/ attach（回放当前轮次 + 订阅实时流）。
  // 我们建完任务即连流取本轮回答 —— 正是 attach 的语义。此前发的
  // `develop` 是发明值，上游行为未定义。
  const url = toWebSocketUrl(product.apiBase, MONKEYCODE_STREAM_PATH, {
    id: taskId,
    mode: 'attach',
  })
  const client = await openWebSocket(url, {
    headers: monkeyCodeHeaders(product, credential),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  try {
    // ⚠️ 用 messages() 而不是 frames()：前者自动回 pong（不回会被对端断开）
    // 并按 close 优雅收尾；后者只给原始帧，控制帧要自己处理。
    for await (const message of client.messages()) {
      const event = parseTaskStreamEvent(message.text)
      if (event.kind === 'done') return
      if (event.kind === 'error') throw new Error(`MonkeyCode 上游错误：${event.message}`)
      if (event.kind === 'text' && event.text !== '') yield { text: event.text }
    }
  } finally {
    client.close()
  }
}

/**
 * 列出该账号最近的任务（上游 `GET /api/v1/users/tasks?page=1&size=5`）。
 *
 * 上游只在登录流程里用它发现 `image_id`，但对**诊断 10811** 同样有用：
 * 「同账号已有正在运行的任务」这种事，干等用户什么都做不了，
 * 而把卡住任务的 id / 状态 / 创建时间报出来，用户至少知道该等多久、
 * 或者去网页端处理。返回空数组表示查不到（不抛错 —— 诊断失败不该
 * 盖过真正的建任务错误）。
 */
export async function listMonkeyCodeTasks(
  fetcher: typeof fetch,
  product: MonkeyCodeProduct,
  credential: MonkeyCodeCredential,
  signal?: AbortSignal,
): Promise<Array<{ id: string; status: string; createdAt: number; lastActiveAt?: number }>> {
  if (!isCredentialUsable(credential)) return []
  try {
    const response = await fetcher(`${product.apiBase}/api/v1/users/tasks?page=1&size=5`, {
      method: 'GET',
      headers: { Accept: 'application/json', ...monkeyCodeHeaders(product, credential) },
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) return []
    const body: unknown = await response.json().catch(() => undefined)
    if (typeof body !== 'object' || body === null) return []
    const data = (body as Record<string, unknown>).data
    if (typeof data !== 'object' || data === null) return []
    const tasks = (data as Record<string, unknown>).tasks
    if (!Array.isArray(tasks)) return []
    const rows: Array<{ id: string; status: string; createdAt: number; lastActiveAt?: number }> = []
    for (const raw of tasks) {
      if (typeof raw !== 'object' || raw === null) continue
      const item = raw as Record<string, unknown>
      const id = typeof item.id === 'string' ? item.id : undefined
      if (id === undefined) continue
      const at = typeof item.created_at === 'number' ? item.created_at * 1000 : 0
      const last = typeof item.last_active_at === 'number' ? item.last_active_at * 1000 : undefined
      rows.push({
        id,
        status: typeof item.status === 'string' ? item.status : 'unknown',
        createdAt: at,
        ...(last === undefined ? {} : { lastActiveAt: last }),
      })
    }
    return rows
  } catch {
    return []
  }
}

// ── cap.js POW 验证码（官方 chaitin/MonkeyCode 的签到门槛）──────────────────
//
// 官方签到 `POST /api/v1/users/wallet/checkin` 需要 `captcha_token`
//（frontend/src/api/Api.ts 的 DomainCheckInReq）。不带 token 实测回
// `{"code":10701,"message":"兑换验证码失败"}` —— 这正是「签到实际失效」的根因。
//
// 验证码是 **cap.js 工作量证明**（github.com/ackcoder/go-cap），可编程求解、
// 无需浏览器：`POST /api/v1/public/captcha/challenge` 取题 → 本地算 nonce →
// `POST /api/v1/public/captcha/redeem` 换 token。求解算法逐字对照
// go-cap v1.1.3 的 cap.go：
//
// ```go
// b := token + strconv(i+1) + "d"     // target 种子
// target := prng(b, difficulty)        // 前缀目标
// salt := prng(b[:len-1], size)        // 即 token+strconv(i+1)
// hash := sha256(salt + nonce)         // 找 nonce 使 hash 前缀 === target
// ```
//
// prng = FNV-1a(seed) 做 32 位状态 + xorshift32 出十六进制流（cap.go:234）。

/** go-cap 的 prng：FNV-1a 种子 + xorshift32，产出 length 个十六进制字符。 */
function capPrng(seed: string, length: number): string {
  // FNV-1a 32 位
  let state = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    state ^= seed.charCodeAt(i)
    // 乘以 0x01000193（用乘法 + 加法避免 32 位溢出丢失精度）
    state = Math.imul(state, 0x01000193) >>> 0
  }
  let out = ''
  while (out.length < length) {
    // xorshift32（与 go-cap 的三步一致）
    state ^= (state << 13) >>> 0; state = state >>> 0
    state ^= state >>> 17
    state ^= (state << 5) >>> 0; state = state >>> 0
    out += state.toString(16).padStart(8, '0')
  }
  return out.slice(0, length)
}

const capSha256Hex = (input: string): string => {
  return createHash('sha256').update(input).digest('hex')
}

/** 解单个 challenge：找 nonce 使 sha256(salt+nonce) 以 target 开头。 */
function solveCapChallenge(salt: string, target: string): number {
  for (let nonce = 0; nonce < 100_000_000; nonce++) {
    if (capSha256Hex(`${salt}${nonce}`).startsWith(target)) return nonce
  }
  throw new Error(`MonkeyCode：POW 挑战无解（target=${target}）`)
}

/**
 * 完整签到流程：取挑战 → 算 POW → 换 token → 签到。
 *
 * 官方参数 WithChallenge(50, 32, 3)：50 题、salt 32 字符、难度 3（哈希前缀
 * 3 个十六进制字符 ≈ 每题平均 4096 次 sha256，50 题约 20 万次 —— Node
 * 同步算毫秒级）。挑战 2 分钟过期、token 5 分钟过期，故必须一口气做完。
 */
export async function runCheckinWithCaptchaImpl(options: {
  fetcher: typeof fetch
  product: MonkeyCodeProduct
  credential: MonkeyCodeCredential
  signal?: AbortSignal
}): Promise<{ ok: boolean; reason?: string; checkedIn?: boolean }> {
  const { fetcher, product, credential } = options
  const base = product.apiBase
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json', ...monkeyCodeHeaders(product, credential) }
  // 1) 取挑战
  const challengeRes = await fetcher(`${base}/api/v1/public/captcha/challenge`, {
    method: 'POST', headers, ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (!challengeRes.ok) return { ok: false, reason: `验证码挑战返回 HTTP ${challengeRes.status}` }
  const challenge = await challengeRes.json().catch(() => undefined) as
    { token?: string; challenge?: { c?: number; s?: number; d?: number } } | undefined
  const token = challenge?.token
  const c = challenge?.challenge?.c
  const s = challenge?.challenge?.s
  const d = challenge?.challenge?.d
  if (typeof token !== 'string' || typeof c !== 'number' || typeof s !== 'number' || typeof d !== 'number') {
    return { ok: false, reason: '验证码挑战响应缺字段' }
  }
  // 2) 逐题求解（种子构造与 go-cap 逐字一致）
  const solutions: number[] = []
  for (let i = 1; i <= c; i++) {
    const target = capPrng(`${token}${i}d`, d)
    const salt = capPrng(`${token}${i}`, s)
    solutions.push(solveCapChallenge(salt, target))
  }
  // 3) redeem 换 captcha_token
  const redeemRes = await fetcher(`${base}/api/v1/public/captcha/redeem`, {
    method: 'POST', headers, body: JSON.stringify({ token, solutions }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (!redeemRes.ok) return { ok: false, reason: `验证码兑换返回 HTTP ${redeemRes.status}` }
  const redeem = await redeemRes.json().catch(() => undefined) as
    { success?: boolean; tokenData?: string; token?: string; message?: string } | undefined
  const captchaToken = redeem?.tokenData ?? redeem?.token
  if (redeem?.success !== true || typeof captchaToken !== 'string') {
    return { ok: false, reason: `验证码兑换失败：${redeem?.message ?? '未返回 token'}` }
  }
  // 4) 带 token 签到
  const checkinRes = await fetcher(`${base}${MONKEYCODE_CHECKIN_PATH}`, {
    method: 'POST', headers, body: JSON.stringify({ captcha_token: captchaToken }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  const body = await checkinRes.json().catch(() => undefined) as
    { code?: number; message?: string; data?: { checked_in?: boolean } } | undefined
  if (body?.code !== undefined && body.code !== 0) {
    return { ok: false, reason: body.message ?? `业务错误 code=${body.code}` }
  }
  return { ok: true, checkedIn: body?.data?.checked_in === true }
}

/** 兼容旧名（RPC 侧用这个名）。 */
export async function runCheckinWithCaptcha(
  options: Parameters<typeof runCheckinWithCaptchaImpl>[0],
) {
  return runCheckinWithCaptchaImpl(options)
}

/**
 * 停止一个任务（官方 `PUT /api/v1/users/tasks/stop`，body `{id}`）。
 *
 * ⚠️ 此前（照 aimod-cc/Agent2API 的实现）以为上游没有取消端点 —— 那只是
 * 该参考项目**没实现**。官方开源版（chaitin/MonkeyCode 的
 * `biz/task/handler/v1/task.go:183`）明确有 `PUT /tasks/stop`。
 * 用于 10811（同账号已有运行中任务）的自愈：停掉卡住的旧任务再重试建新任务。
 */
export async function stopMonkeyCodeTask(options: {
  fetcher: typeof fetch
  product: MonkeyCodeProduct
  credential: MonkeyCodeCredential
  taskId: string
  signal?: AbortSignal
}): Promise<boolean> {
  if (!isCredentialUsable(options.credential)) return false
  try {
    const response = await options.fetcher(`${options.product.apiBase}${MONKEYCODE_TASKS_PATH}/stop`, {
      method: 'PUT',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...monkeyCodeHeaders(options.product, options.credential) },
      body: JSON.stringify({ id: options.taskId }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    if (!response.ok) return false
    const body: unknown = await response.json().catch(() => undefined)
    if (typeof body === 'object' && body !== null) {
      const code = (body as Record<string, unknown>).code
      if (typeof code === 'number' && code !== 0) return false
    }
    return true
  } catch {
    return false
  }
}

// ── 百智云（baizhi.cloud）会话桥接 ─────────────────────────────────────────
//
// 官方站点的登录其实是**百智云 OIDC 授权**（不是 GitHub）：
// `https://baizhi.cloud/oauth/authorize?client_id=monkeycode-ai&redirect_uri=
//  https://monkeycode-ai.com/api/v1/users/baizhi/callback&response_type=code&
//  scope=user+phone&state=<uuid>`。
//
// 官方桌面端（chaitin/MonkeyCode 的 desktop/src/baizhi/monkeycode.rs
// `login_monkeycode`）把这条链**纯 HTTP 走完**，关键技巧是：
// 授权**页面** URL 改写成授权 **API** URL（`authorize_page_to_api`）——
// WebView 里这一跳由页面 JS 完成，纯 HTTP 则由我们手动改写：
//
// ```text
// GET {mc}/api/v1/users/login            → 302 → {baizhi}/oauth/authorize?…（页面）
// 【改写】{baizhi}/api/v1/oauth/authorize?…（API，带百智 cookie）
//                                        → 302 → {mc}/…/baizhi/callback?code=…
//                                        → Set-Cookie: monkeycode_ai_session
// ```
//
// 前置条件：**必须已持有百智云会话 cookie**（`baizhi_session` / `sl-session`）。
// 官方源码同样要求（`if svc.store.is_empty() { return Err("请先登录百智云账号") }`）。
// 拿到 `monkeycode_ai_session` 之后的凭据形态与 Cookie 粘贴**完全一致**，
// 因此适配器、签到、对话全都不用改。

/** 百智云账号域（授权与 API 都在这）。 */
export const MONKEYCODE_BAIZHI_BASE = 'https://baizhi.cloud'
/** 桥接重定向链上限（上游实测 4~6 跳，留余量防环）。 */
const BRIDGE_MAX_HOPS = 12

/** 从 cookie 串里取某个名字的值。 */
function cookieValue(raw: string, name: string): string | undefined {
  for (const part of raw.split(';')) {
    const trimmed = part.trim()
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    if (trimmed.slice(0, eq).trim() === name) return trimmed.slice(eq + 1).trim()
  }
  return undefined
}

/**
 * 用百智云会话桥接出 MonkeyCode 会话（纯 HTTP，无需浏览器）。
 *
 * @param baizhiCookie 用户在 baizhi.cloud 登录后的完整 Cookie 串
 *        （至少含 `baizhi_session`）。
 * @returns 可直接落盘的 MonkeyCode 凭据（`access_token` 是
 *          `monkeycode_ai_session=…`）。
 */
export async function loginWithBaizhiSession(
  fetcher: typeof fetch,
  product: MonkeyCodeProduct,
  baizhiCookie: string,
  signal?: AbortSignal,
  options: { baizhiBase?: string } = {},
): Promise<MonkeyCodeCredential> {
  const baizhiBase = (options.baizhiBase ?? MONKEYCODE_BAIZHI_BASE).replace(/\/+$/, '')
  const baizhiHost = new URL(baizhiBase).hostname
  const cookie = baizhiCookie.trim()
  if (cookieValue(cookie, 'baizhi_session') === undefined) {
    throw new Error('MonkeyCode：请粘贴**百智云**（baizhi.cloud）的 Cookie，且必须包含 baizhi_session=…')
  }
  const mcCookies = new Map<string, string>()
  const absorb = (response: Response): void => {
    const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
    for (const raw of list) {
      const pair = raw.split(';')[0] ?? ''
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      // 只收会话相关的（_ga/_pk_* 是分析 cookie，收了只是噪声）。
      if (name === 'monkeycode_ai_session' || name === 'monkeycode_ai_team_session' || name === 'nebula_session') {
        mcCookies.set(name, value)
      }
    }
  }
  const mcCookieHeader = (): string =>
    [...mcCookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')

  let current = `${product.apiBase}/api/v1/users/login?redirect=&inviter_id=`
  for (let hop = 0; hop < BRIDGE_MAX_HOPS; hop++) {
    const url = new URL(current)
    const onBaizhi = url.hostname === baizhiHost
    // 授权**页面** → 授权 **API**（WebView 里这一跳由页面 JS 做，纯 HTTP 由我们改写）。
    if (onBaizhi && url.pathname === '/oauth/authorize') {
      const api = new URL(`${baizhiBase}/api/v1/oauth/authorize`)
      const clientId = url.searchParams.get('client_id') ?? ''
      const redirectUri = url.searchParams.get('redirect_uri') ?? url.searchParams.get('redirect_url') ?? ''
      const scope = url.searchParams.get('scope') ?? ''
      const state = url.searchParams.get('state') ?? ''
      if (clientId === '' || redirectUri === '' || scope === '' || state === '') {
        throw new Error('MonkeyCode：桥接失败，授权参数不完整')
      }
      api.searchParams.set('client_id', clientId)
      api.searchParams.set('redirect_uri', redirectUri)
      api.searchParams.set('scope', scope)
      api.searchParams.set('state', state)
      api.searchParams.set('response_type', url.searchParams.get('response_type') ?? 'code')
      current = api.toString()
      continue
    }
    const headers: Record<string, string> = { Accept: '*/*' }
    if (onBaizhi) headers.Cookie = cookie
    else if (mcCookies.size > 0) headers.Cookie = mcCookieHeader()
    const response = await fetcher(current, {
      method: 'GET',
      headers,
      redirect: 'manual',
      ...(signal === undefined ? {} : { signal }),
    })
    absorb(response)
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400) {
      if (location === null || location === '') throw new Error('MonkeyCode：桥接失败，重定向缺少目标地址')
      current = new URL(location, current).toString()
      continue
    }
    if (response.status === 401 || response.status === 403) {
      if (onBaizhi) throw new Error('MonkeyCode：百智云会话已失效，请重新登录 baizhi.cloud 后重试')
      throw new Error(`MonkeyCode：桥接失败（HTTP ${response.status}）`)
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`MonkeyCode：桥接失败（HTTP ${response.status}）`)
    }
    // 链路走完：必须已经拿到会话，否则说明授权被拒。
    const session = mcCookies.get('monkeycode_ai_session') ?? mcCookies.get('nebula_session')
    if (session === undefined || session === '') {
      throw new Error('MonkeyCode：桥接完成但未拿到 monkeycode_ai_session（百智云账号可能未开通 MonkeyCode）')
    }
    const finalCookie = mcCookieHeader()
    // 与 Cookie 粘贴同一条校验路径：探活 + 派生身份。
    return loginWithCookie(fetcher, product, finalCookie, signal)
  }
  throw new Error('MonkeyCode：桥接重定向次数过多')
}
