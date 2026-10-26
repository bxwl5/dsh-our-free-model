/**
 * KukuAI 对话 API：建消息 → SSE 流式。
 *
 * 两步协议（kuku2api 实测）：
 * 1. `POST /wenchain/genflowpro/sendmsg` 建消息，返回 `session_id` / `reply_id`；
 * 2. `POST /wenchain/genflowpro/sse/getchatcontent` 读 SSE 正文。
 *
 * ## 每轮新建 session
 *
 * 与 OrcaTerm 同因：上游按 sessionId 留存历史，而 OpenAI 客户端每轮自带
 * 全量 messages。复用会话会让历史翻倍，故每轮新建。
 */

import { createHash, randomUUID } from 'node:crypto'

import {
  KUKU_SENDMSG_PATH,
  KUKU_SSE_PATH,
  KUKU_VIP_REMAIN_PATH,
  KUKU_WEB_QUERY,
  KUKU_TASK_COMPLETE_PATH,
  KUKU_USERREPORT_PATH,
  type KukuProduct,
} from './kuku-product.js'
import {
  buildSendmsgBody,
  flattenMessages,
  isCredentialUsable,
  kukuHeaders,
  parseSseFrame,
  type KukuCredential,
} from './kuku.js'
import {
  KUKU_ENGINE_SIGN_KEY,
  KUKU_ENGINE_USER_AGENT,
  KUKU_PASSPORT_BASE,
} from './kuku-qr-login.js'

/** 对话选项。 */
export interface ChatOptions {
  model: string
  messages: readonly { role: string; content: unknown }[]
  system?: string
  signal?: AbortSignal
  /** 思考档位（0 = 关闭）。 */
  thinkMode?: number
}

/** 从任意响应里抽 session/reply id（字段名可能是驼峰或下划线）。 */
function pickId(body: unknown, ...keys: string[]): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value
  }
  // 有些实现套一层 data。
  const data = record.data
  if (typeof data === 'object' && data !== null) return pickId(data, ...keys)
  return undefined
}

/**
 * 跑一轮流式对话（异步生成器）。
 */
export async function* streamChat(
  fetcher: typeof fetch,
  product: KukuProduct,
  credential: KukuCredential,
  options: ChatOptions,
): AsyncGenerator<{ text?: string; reasoning?: string }, void, undefined> {
  if (!isCredentialUsable(credential)) {
    throw new Error('KukuAI：没有可用凭据，请先粘贴含 BDUSS 的 Cookie')
  }

  const sessionId = randomUUID()
  const replyId = randomUUID()
  const clientSessionId = randomUUID()
  // device_id 是客户端自报的数字 id；用时间戳派生一个稳定的长整数。
  const deviceId = String(Date.now())
  // 会话三件套：上游要求每次请求把 bdstoken/uinfo/uk 拼进 query，
  // 由 userreport 用登录 Cookie 换来（见 ensureKukuTokenTriple 的说明）。
  const triple = await ensureKukuTokenTriple(fetcher, product, credential, { signal: options.signal })
  const tokenQuery = kukuTokenQuery(triple)

  const sendResponse = await fetcher(`${product.apiBase}${KUKU_SENDMSG_PATH}?${tokenQuery.slice(1)}`, {
    method: 'POST',
    headers: { ...kukuHeaders(product, credential), 'Content-Type': 'application/json' },
    body: JSON.stringify(buildSendmsgBody({
      text: flattenMessages(options.messages, options.system),
      model: options.model,
      sessionId,
      replyId,
      clientSessionId,
      deviceId,
      // 三件套必须内嵌进 client_added（只拼 query 会回 invalid session_id）。
      bdstoken: triple.bdstoken,
      uinfo: triple.uinfo,
      uk: triple.uk,
      ...(options.thinkMode === undefined ? {} : { thinkMode: options.thinkMode }),
    })),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (!sendResponse.ok) {
    const text = await sendResponse.text().catch(() => '')
    throw new Error(`KukuAI：建消息返回 HTTP ${sendResponse.status}${text === '' ? '' : `：${text.slice(0, 200)}`}`)
  }
  const sendBody: unknown = await sendResponse.json().catch(() => undefined)
  // 上游可能回新的 session/reply id；取不到就用本地生成的。
  const actualSession = pickId(sendBody, 'session_id', 'sessionId') ?? sessionId
  const actualReply = pickId(sendBody, 'reply_id', 'replyId') ?? replyId

  const query = new URLSearchParams({
    session_id: actualSession,
    reply_id: actualReply,
    client_session_id: clientSessionId,
    device_id: deviceId,
  }).toString()
  const sseResponse = await fetcher(`${product.apiBase}${KUKU_SSE_PATH}?${query}&${tokenQuery.slice(1)}`, {
    method: 'POST',
    headers: {
      ...kukuHeaders(product, credential),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ session_id: actualSession, reply_id: actualReply, msg_id: '' }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (!sseResponse.ok) {
    const text = await sseResponse.text().catch(() => '')
    throw new Error(`KukuAI：流式接口返回 HTTP ${sseResponse.status}${text === '' ? '' : `：${text.slice(0, 200)}`}`)
  }
  if (sseResponse.body === null) throw new Error('KukuAI：流式响应没有正文')

  const reader = sseResponse.body.getReader()
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
        const frame = parseSseFrame(line.slice(5))
        if (frame === undefined) continue
        if (frame.kind === 'done') return
        if (frame.kind === 'error') throw new Error(`KukuAI 上游错误：${frame.message}`)
        yield frame
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined)
  }
}

/**
 * 探活：调 VIP 剩余额度接口看状态码。
 *
 * 选它是因为它是最轻量的鉴权探针（不需要建会话、不消耗额度）。
 */
export async function probeCredential(
  fetcher: typeof fetch,
  product: KukuProduct,
  credential: KukuCredential,
  signal?: AbortSignal,
): Promise<'valid' | 'expired' | 'network_error'> {
  if (!isCredentialUsable(credential)) return 'expired'
  try {
    // ⚠️ 必须打 **userreport**（对话同域）而不是 `getgfvipremain`：
    // 实测 bizapi 域对**已失效**的 Cookie 仍返回 HTTP 200 + `status.code=0`
    // （连用户名都照常给），于是探测误判 valid，直到真正对话才失败
    //（2026-10-25 用户遇到的就是这条路径）。
    // userreport 的 `errno` 才是可靠的登录态判据（-6 = 未登录）。
    const response = await fetcher(`${product.apiBase}${KUKU_USERREPORT_PATH}?${KUKU_WEB_QUERY}`, {
      method: 'GET',
      headers: kukuHeaders(product, credential),
      ...(signal === undefined ? {} : { signal }),
    })
    if (response.status === 401 || response.status === 403) return 'expired'
    if (!response.ok) return 'network_error'
    const body: unknown = await response.json().catch(() => undefined)
    if (typeof body !== 'object' || body === null) return 'network_error'
    const errno = (body as Record<string, unknown>).errno
    if (typeof errno === 'number' && errno !== 0) return 'expired'
    return 'valid'
  } catch {
    return 'network_error'
  }
}

/**
 * 查询 KukuAI 积分余额。
 *
 * ## 上游形态（2026-10-25 按 `aimod-cc/Agent2API` 的 `providers/kuku/balance.rs`）
 *
 * ```text
 * GET /bizapi/gfpro/getgfvipremain?channel=chunlei&clienttype=400&version=1.4.4
 * → { "status": { "code": 0, "msg": "success" },
 *     "data": { "uname": "…",
 *               "list": [ { "assetType": 1, "assetName": "token",
 *                           "totalPoint": "1100", "bonusPoint": "1100", … },
 *                         { "assetName": "duration", … } ] } }
 * ```
 *
 * ⚠ **判据在顶层 `status.code`**，不是 `data.status.code` —— 上游注释记录了
 * 初版按后者解析、取到默认 `-1`、报「未知错误」的坑。
 *
 * ⚠ 积分取 `list` 里 `assetName === 'token'` 的 `totalPoint`（**字符串**，
 * 需转数字）；Go 参考实现在找不到时回落第一项。`totalPoint` 是 token 额度
 * 而不是「元」，所以单位仍叫积分。
 *
 * 返回 `undefined` 表示拿不到（网络失败 / 业务码非 0 / 结构不认识）——
 * 由调用方显示「未配置查询」或跳过，**绝不显示成 0**（0 会让用户以为用光了）。
 */
export async function fetchKukuPoints(
  fetcher: typeof fetch,
  product: KukuProduct,
  credential: KukuCredential,
  signal?: AbortSignal,
): Promise<number | undefined> {
  if (!isCredentialUsable(credential)) return undefined
  try {
    // bizapi 不认 app_id（与目录接口的 WEB_QUERY 不同），只带这三个。
    const query = new URLSearchParams({ channel: 'chunlei', clienttype: '400', version: '1.4.4' })
    const response = await fetcher(`${product.apiBase}${KUKU_VIP_REMAIN_PATH}?${query}`, {
      method: 'GET',
      headers: kukuHeaders(product, credential),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) return undefined
    const body: unknown = await response.json().catch(() => undefined)
    if (typeof body !== 'object' || body === null) return undefined
    const record = body as Record<string, unknown>
    const status = record.status
    const code = typeof status === 'object' && status !== null
      ? (status as Record<string, unknown>).code
      : undefined
    if (typeof code === 'number' && code !== 0) return undefined
    const data = record.data
    if (typeof data !== 'object' || data === null) return undefined
    const list = (data as Record<string, unknown>).list
    if (!Array.isArray(list)) return undefined
    const parse = (value: unknown): number | undefined => {
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value.trim())
        return Number.isFinite(n) ? n : undefined
      }
      return undefined
    }
    const token = list.find((item) => {
      if (typeof item !== 'object' || item === null) return false
      return (item as Record<string, unknown>).assetName === 'token'
    })
    const fromToken = token === undefined ? undefined : parse((token as Record<string, unknown>).totalPoint)
    if (fromToken !== undefined) return fromToken
    // 回落第一项（与 Go 参考实现同口径）。
    const first = list[0]
    return first === undefined || typeof first !== 'object' || first === null
      ? undefined
      : parse((first as Record<string, unknown>).totalPoint)
  } catch {
    return undefined
  }
}

/**
 * KukuAI 每日签到（「免费领积分」活动的任务领取）。
 *
 * ## 上游形态（2026-10-25 按 `aimod-cc/Agent2API` 的 `providers/kuku/checkin.rs`）
 *
 * ```text
 * GET  /api/genflowpro/freepoint/homenew?{WEB_QUERY}
 *      → {errno, data:{activities:[{activity_key, activity_name, period_no,
 *         tabs:[{tasks:[{task_type, task_name, task_status,
 *         single_reward_point, claimable_point}]}]}]}}
 * POST /api/genflowpro/freepoint/taskComplete?{WEB_QUERY}
 *      body: task_type=LOGIN|CHAT  (x-www-form-urlencoded)
 *      → {errno, data:{complete_status, reward_point}}
 * ```
 *
 * ## 两个实测要点（上游注释记录，照抄别自己发明）
 *
 * - `claimable_point` **恒为 0**，不能拿它当领取门槛（「完成一次对话」
 *   状态是 `UNFINISHED` 却照样能领到 +50）。
 * - `taskComplete` **幂等**：重复领返回 `SUCCESS` + `reward_point=0`
 *   （或 `BADGE_ALREADY_RECEIVED`），所以「已领过」不算失败。
 *
 * 只领 `LOGIN` / `CHAT` 两类：`INVITE_VISIT` / `INVITE_DOWNLOAD` 要真实
 * 受邀人，接口上强领只会失败（与上游同一取舍）。
 */
export const KUKU_CLAIMABLE_TASK_TYPES = ['LOGIN', 'CHAT'] as const

/** 签到结果（与 `collectClaimResults` 的单账号口径对齐）。 */
export interface KukuCheckinOutcome {
  /** 领到的积分数；0 表示「今天已领过」而不是失败。 */
  claimed: number
  /** 说明文案（给用户看的）。 */
  message: string
}

/** 查当前可领任务（仅用于展示；领取不依赖它，见 `claimable_point` 恒 0）。 */
export async function fetchKukuCheckinTasks(
  fetcher: typeof fetch,
  product: KukuProduct,
  credential: KukuCredential,
  signal?: AbortSignal,
): Promise<Array<{ taskType: string; taskName: string; status: string }>> {
  if (!isCredentialUsable(credential)) return []
  try {
    const response = await fetcher(`${product.apiBase}${KUKU_FREEPOINT_PATH}?${KUKU_WEB_QUERY}`, {
      method: 'GET',
      headers: kukuHeaders(product, credential),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) return []
    const body: unknown = await response.json().catch(() => undefined)
    if (typeof body !== 'object' || body === null) return []
    const tasks: Array<{ taskType: string; taskName: string; status: string }> = []
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) { for (const item of node) walk(item); return }
      if (typeof node !== 'object' || node === null) return
      const record = node as Record<string, unknown>
      const taskType = typeof record.task_type === 'string' ? record.task_type : undefined
      if (taskType !== undefined) {
        tasks.push({
          taskType,
          taskName: typeof record.task_name === 'string' ? record.task_name : taskType,
          status: typeof record.task_status === 'string' ? record.task_status : '',
        })
        return
      }
      for (const child of Object.values(record)) walk(child)
    }
    walk((body as Record<string, unknown>).data)
    return tasks
  } catch {
    return []
  }
}

/**
 * 领取今日可领任务（LOGIN + CHAT）。
 *
 * 幂等：已领过返回 `claimed: 0` 且 `message` 说明「今天已领过」。
 * 拿不到任何任务时返回 `claimed: 0` 并说明原因 —— 不抛错，避免把
 * 「今天没得领」显示成「签到失败」。
 */
export async function claimKukuDailyCheckin(
  fetcher: typeof fetch,
  product: KukuProduct,
  credential: KukuCredential,
  signal?: AbortSignal,
): Promise<KukuCheckinOutcome> {
  if (!isCredentialUsable(credential)) return { claimed: 0, message: '凭据不可用' }
  /**
   * ⚠️ 必须先用**自愈后的** Cookie（2026-10-26 审计发现的 P0）：
   * 凭据里的 STOKEN 会过期，而 taskComplete 与 userreport 一样只认当前有效的
   * 那个。原先直接用旧 Cookie，实测回 `errno:-6 未登录`，于是「kuku 签到永远
   * 失败」。自愈函数已在对话链路验证可用（换发后 errno:0）。
   */
  let working = credential
  try {
    const live = await exchangeKukuStokenLive(fetcher, product, credential, signal)
    if (live !== undefined) {
      const replaced = credential.access_token
        .split(';')
        .map(part => part.trim())
        .filter(part => part !== '' && !part.startsWith('STOKEN='))
      replaced.push(`STOKEN=${live}`)
      working = { ...credential, access_token: replaced.join('; ') }
    }
  } catch {
    // 换发失败就用原凭据试一次（可能本来就没过期）。
  }
  let total = 0
  let succeeded = 0
  for (const taskType of KUKU_CLAIMABLE_TASK_TYPES) {
    try {
      const response = await fetcher(`${product.apiBase}${KUKU_TASK_COMPLETE_PATH}?${KUKU_WEB_QUERY}`, {
        method: 'POST',
        headers: { ...kukuHeaders(product, working), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ task_type: taskType }).toString(),
        ...(signal === undefined ? {} : { signal }),
      })
      if (!response.ok) continue
      const body: unknown = await response.json().catch(() => undefined)
      if (typeof body !== 'object' || body === null) continue
      const data = (body as Record<string, unknown>).data
      if (typeof data !== 'object' || data === null) continue
      const record = data as Record<string, unknown>
      const status = typeof record.complete_status === 'string' ? record.complete_status : ''
      // BADGE_ALREADY_RECEIVED / SUCCESS + reward 0 都是「已领过」，算成功。
      const reward = typeof record.reward_point === 'number'
        ? record.reward_point
        : Number(record.reward_point ?? 0)
      if (Number.isFinite(reward) && reward > 0) total += reward
      if (status === 'SUCCESS' || status === 'BADGE_ALREADY_RECEIVED' || reward >= 0) succeeded += 1
    } catch {
      // 单个任务失败不影响另一个。
    }
  }
  if (succeeded === 0) return { claimed: 0, message: '上游未返回可领取结果（可能今日无可领任务）' }
  return total > 0
    ? { claimed: total, message: `已领取 ${total} 积分` }
    : { claimed: 0, message: '今日已领取过（任务幂等）' }
}

/**
 * KukuAI 会话三件套（`bdstoken` / `uinfo` / `uk`）。
 *
 * ## 为什么必须换（上游 `providers/kuku/session.rs`）
 *
 * 对话链路要求每次请求把这三个值拼进 query，它们由
 * `GET /api/genflowpro/common/userreport` 用登录 Cookie 换来（kuku2api 实测）。
 * **少了这一步**，`sendmsg` 直接回
 * `{"status":{"code":200002,"msg":"invalid session_id"}}`，
 * 随后 SSE 那头报 `task not found` —— 表现就是「模型目录能拉到、对话永远空」。
 *
 * 每次对话都打一次 userreport 既没必要也招风控，参考实现与本处同值缓存
 * 600 秒，key 用 BDUSS（同一账号 Cookie 不变，三件套可复用）。
 */
export interface KukuTokenTriple {
  bdstoken: string
  uinfo: string
  uk: string
}

/** 三件套缓存有效期（600 秒，与参考实现同值）。 */
const KUKU_TRIPLE_TTL_MS = 600_000

/** 进程级缓存（key = BDUSS；热重载后自然重建，无落盘必要）。 */
const tripleCache = new Map<string, { triple: KukuTokenTriple; at: number }>()

/**
 * 取（必要时刷新）会话三件套。
 *
 * 失败时抛错并说明原因：`userreport` 的 `errno === -6` 基本是凭据真失效
 * （退出登录 / 换号）或上游临时风控限流（上游注释：换发业务令牌后仍失败
 * 即这种情况，等 1-2 分钟再试）。
 */
/**
 * 用 BDUSS + PTOKEN 向 passport **换发** genflowpro STOKEN。
 *
 * ## 为什么必须现场换（2026-10-26 实测根因）
 *
 * 扫码登录时换到的 STOKEN 会过期，而 `userreport` 只认**当前有效**的 STOKEN。
 * 实测同一份 Cookie：`bizapi`（余额）与 `wenchain`（模型目录）照常 200，
 * 但 `userreport` 回 `errno:-6 未登录` —— 这就是「凭据一直失效、重新登录也不行」
 * 的真相：**不是 Cookie 坏了，是 STOKEN 过期了**。
 *
 * 现场用 BDUSS+PTOKEN 换发后，`userreport` 立刻 `errno:0` 并给出完整三件套。
 * 上游（aimod-cc/Agent2API 的 kuku/session.rs）正是这么做的：
 * `errno != 0` 时换发一次再重试。
 *
 * 签名口径照 `kuku-qr-login.ts` 的 `exchangeKukuStoken`（同一把客户端内置密钥）。
 */
async function exchangeKukuStokenLive(
  fetcher: typeof fetch,
  product: KukuProduct,
  credential: KukuCredential,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const value = (name: string): string =>
    credential.access_token.split(';').map(part => part.trim())
      .find(part => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? ''
  const bduss = value('BDUSS')
  const ptoken = value('PTOKEN')
  if (bduss === '' || ptoken === '') return undefined
  const fields = `appid=1&bduss=${bduss}&ptoken=${ptoken}&return_type=1&tpl=genflowpro`
    + '&tpl_list=genflowpro|netdisk'
  const signature = createHash('md5').update(`${fields}&sign_key=${KUKU_ENGINE_SIGN_KEY}`).digest('hex')
  try {
    const response = await fetcher(`${KUKU_PASSPORT_BASE}/v3/login/api/auth`, {
      method: 'POST',
      headers: {
        'user-agent': KUKU_ENGINE_USER_AGENT,
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Referer: `${product.apiBase}/genflowpro`,
        Origin: product.apiBase,
        Cookie: credential.access_token,
      },
      body: `${fields}&sig=${signature}`,
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) return undefined
    const body: unknown = await response.json().catch(() => undefined)
    if (typeof body !== 'object' || body === null) return undefined
    const list = (body as Record<string, unknown>).stoken_list
    if (typeof list !== 'object' || list === null) return undefined
    const stoken = (list as Record<string, unknown>).genflowpro
    return typeof stoken === 'string' && stoken !== '' ? stoken : undefined
  } catch {
    return undefined
  }
}

export async function ensureKukuTokenTriple(
  fetcher: typeof fetch,
  product: KukuProduct,
  credential: KukuCredential,
  options: { force?: boolean; signal?: AbortSignal } = {},
): Promise<KukuTokenTriple> {
  if (!isCredentialUsable(credential)) throw new Error('KukuAI：没有可用凭据，请先粘贴含 BDUSS 的 Cookie')
  const bduss = credential.access_token.split(';').map(part => part.trim())
    .find(part => part.startsWith('BDUSS='))?.slice('BDUSS='.length) ?? credential.access_token
  const key = bduss.slice(0, 64)
  const cached = tripleCache.get(key)
  if (options.force !== true && cached !== undefined && Date.now() - cached.at < KUKU_TRIPLE_TTL_MS) {
    return cached.triple
  }
  const url = `${product.apiBase}${KUKU_USERREPORT_PATH}?${KUKU_WEB_QUERY}`
  /**
   * 打一次 userreport。`errno !== 0` 时**先换发新 STOKEN 再重试一次**。
   *
   * 这是「凭据一直失效、重新登录也不行」的真正修法（2026-10-26 实测）：
   * 扫码换到的 STOKEN 会过期，而 userreport 只认当前有效的那个；此时
   * bizapi（余额）与 wenchain（模型目录）照常 200，只有 userreport 回
   * `errno:-6 未登录`。现场用 BDUSS+PTOKEN 换发后立刻 errno:0。
   * 上游 kuku/session.rs 正是这个流程。
   */
  const callUserreport = async (cookie: string): Promise<{ body: unknown; errno: number | undefined }> => {
    const response = await fetcher(url, {
      method: 'GET',
      headers: kukuHeaders(product, { ...credential, access_token: cookie }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    const body: unknown = await response.json().catch(() => undefined)
    const errno = typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>).errno as number | undefined
      : undefined
    return { body, errno }
  }
  let { body, errno } = await callUserreport(credential.access_token)
  if (typeof errno === 'number' && errno !== 0) {
    const freshStoken = await exchangeKukuStokenLive(fetcher, product, credential, options.signal)
    if (freshStoken !== undefined) {
      // 用新 STOKEN 覆盖凭据里的旧值（保留其余 cookie）后重试一次。
      const replaced = credential.access_token
        .split(';')
        .map(part => part.trim())
        .filter(part => part !== '' && !part.startsWith('STOKEN='))
        .concat(`STOKEN=${freshStoken}`)
        .join('; ')
      const retried = await callUserreport(replaced)
      body = retried.body
      errno = retried.errno
    }
  }
  const showMsg = typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>).show_msg ?? (body as Record<string, unknown>).errmsg
    : undefined
  if (typeof errno === 'number' && errno !== 0) {
    throw new Error(
      `KukuAI 会话校验未通过（userreport errno=${errno}：${typeof showMsg === 'string' ? showMsg : '未知错误'}）`
      + '—— 请重新登录该账号（或重新粘贴完整 Cookie）后再试；若账号无误，等 1-2 分钟再试',
    )
  }
  const data = typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>).data
    : undefined
  if (typeof data !== 'object' || data === null) throw new Error('KukuAI：userreport 返回缺少 data')
  const record = data as Record<string, unknown>
  const text = (key: string): string => {
    const raw = record[key]
    if (typeof raw === 'string') return raw.trim()
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
    return ''
  }
  const triple: KukuTokenTriple = { bdstoken: text('bdstoken'), uinfo: text('uinfo'), uk: text('uk') }
  if (triple.bdstoken === '') throw new Error('KukuAI：userreport 返回缺少 bdstoken')
  tripleCache.set(key, { triple, at: Date.now() })
  return triple
}

/** 三件套的 query 段（拼在接口 query 之后）。 */
export function kukuTokenQuery(triple: KukuTokenTriple): string {
  return `&bdstoken=${encodeURIComponent(triple.bdstoken)}&uinfo=${encodeURIComponent(triple.uinfo)}&uk=${encodeURIComponent(triple.uk)}`
}
