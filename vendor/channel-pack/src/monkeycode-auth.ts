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
): Promise<Array<{ id: string; name: string; contextWindow: number; maxTokens?: number; isHidden?: boolean }>> {
  const result = await call(fetcher, product, credential, MONKEYCODE_MODELS_PATH, { signal })
  if (!result.ok) throw new Error(`MonkeyCode：模型目录返回 HTTP ${result.status}`)
  const body = unwrapData(result.body)
  if (!Array.isArray(body)) throw new Error('MonkeyCode：模型目录不是数组')
  const rows: Array<{ id: string; name: string; contextWindow: number; maxTokens?: number; isHidden?: boolean }> = []
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
    rows.push({
      id, name, contextWindow,
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(item.is_hidden === true ? { isHidden: true } : {}),
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
  const taskId = await createTask(fetcher, product, credential, options)
  const url = toWebSocketUrl(product.apiBase, MONKEYCODE_STREAM_PATH, {
    id: taskId,
    mode: 'develop',
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
