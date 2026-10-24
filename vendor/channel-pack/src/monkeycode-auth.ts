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
  MONKEYCODE_ME_PATH,
  MONKEYCODE_MODELS_PATH,
  MONKEYCODE_WALLET_PATH,
  type MonkeyCodeProduct,
} from './monkeycode-product.js'
import {
  credentialFromUser,
  isCredentialUsable,
  monkeyCodeHeaders,
  normalizeCookie,
  parseCheckin,
  parseUser,
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
 * 先调 `/users/me` 确认 Cookie 有效，再拉一次钱包补充额度信息。
 * 无效 Cookie 抛错 —— 不要把一份无效凭据写进去让用户以后才发现。
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
  const result = await call(fetcher, product, probe, MONKEYCODE_ME_PATH, { signal })
  if (result.status === 0) throw new Error('MonkeyCode：无法连接上游（网络不可达）')
  if (result.status === 401 || result.status === 403) {
    throw new Error('MonkeyCode：Cookie 无效或已过期，请重新从浏览器复制')
  }
  if (!result.ok) throw new Error(`MonkeyCode：/users/me 返回 HTTP ${result.status}`)
  const user = parseUser(result.body)
  if (user === undefined) throw new Error('MonkeyCode：/users/me 响应缺少 id，无法确认账号')
  return credentialFromUser(cookie, user)
}

/** 读取当前用户信息。 */
export async function fetchUser(
  fetcher: typeof fetch,
  product: MonkeyCodeProduct,
  credential: MonkeyCodeCredential,
  signal?: AbortSignal,
): Promise<MonkeyCodeUser | undefined> {
  const result = await call(fetcher, product, credential, MONKEYCODE_ME_PATH, { signal })
  return result.ok ? parseUser(result.body) : undefined
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
 * 只调 `/users/me` 看状态码。
 */
export async function probeCredential(
  fetcher: typeof fetch,
  product: MonkeyCodeProduct,
  credential: MonkeyCodeCredential,
  signal?: AbortSignal,
): Promise<'valid' | 'expired' | 'network_error'> {
  if (!isCredentialUsable(credential)) return 'expired'
  const result = await call(fetcher, product, credential, MONKEYCODE_ME_PATH, { signal })
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
  const taskId = isRecord(body) ? (typeof body.id === 'string' ? body.id : undefined) : undefined
  if (taskId === undefined || taskId === '') throw new Error('MonkeyCode：建任务响应缺少 id')
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
