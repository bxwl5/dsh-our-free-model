/**
 * Raccoon Work（商汤小浣熊）协议常量与纯函数。
 *
 * ## 与既有 provider 的关系
 *
 * raccoon 是本插件第 9 个 provider，也是**第二个用「本地页承载登录」**的
 * （第一个是 Loomy）：登录页跑在 `127.0.0.1` 的临时 HTTP 服务上，
 * 页面内联渲染二维码与短信表单，宿主侧持有全部敏感状态。
 *
 * ## 三个必须记住的坑
 *
 * 1. **官方桌面端的登录链路不可复用**：它靠 `office-raccoon://auth/callback`
 *    自定义协议回调，而本插件是宿主侧 Node 进程，收不到该回调；且
 *    `/code/authorize` 页面的回调地址是**写死的**，改不成 localhost。
 *    故改为「客户端本地生成 code + 自行轮询」—— 实测任意自造 code 都被接受。
 * 2. **手机号必须 AES-128-CFB 加密**（密钥见 `RACCOON_PHONE_CIPHER_SECRET`），
 *    否则 `send_sms` 回 `100003 params_encryted_error`。
 * 3. **每日 300 积分没有端点**：服务端按日自动发放（`daily_grant`）。
 *    不要把它实现成签到按钮 —— 见 `raccoon-credits.ts`。
 */

import { createCipheriv, createHash, randomBytes } from 'node:crypto'

/** API 基址。 */
export const RACCOON_API_BASE = 'https://xiaohuanxiong.com'

/** 认证端点前缀。 */
export const RACCOON_AUTH_PREFIX = '/api/web/auth/v1'
/** 推理与模型目录前缀。 */
export const RACCOON_LLM_PREFIX = '/api/web/llm/v2'
/** 积分端点前缀。 */
export const RACCOON_POINTS_PREFIX = '/api/web/points/v1'
/** 桌面端端点前缀（含一次性登录奖励）。 */
export const RACCOON_DESKTOP_PREFIX = '/api/web/desktop/v1'
/**
 * 办公产品端点前缀（2026-11-19）。
 *
 * `GET /office/v3/setting_info` 是**每日积分续期的唯一入口**：它是客户端
 * 打开时发的请求，服务端借它判定「今天登录过」，从而把当日 300 分
 * （默认当日 24:00 失效）转为 7 天有效。它同时也能回读 `available_points`，
 * 供 `/points/v1/balance` 返回 403 时兜底（见 `availablePoints` 的注释）。
 */
export const RACCOON_OFFICE_PREFIX = '/api/web/office/v3'

/**
 * 手机号传输层加密密钥。
 *
 * ⚠️ 这是**公开常量**（客户端把它硬编码在前端 bundle 里），只用于防止手机号
 * 明文出现在日志/代理里，**不是安全边界**。故放在本文件不引入新的泄露面。
 * 与 Loomy 的 AccessKey 同性质。
 */
export const RACCOON_PHONE_CIPHER_SECRET = 'senseraccoon2023'

/**
 * 续期提前窗口（秒）。
 *
 * 照抄官方 `scheduleAuth.js` 的 `TOKEN_REFRESH_WINDOW_SECONDS = 300`：
 * access_token 寿命约 3 小时（实测 `exp - nbf = 10805s`），提前 5 分钟刷新
 * 可避免边界失败。
 */
export const RACCOON_TOKEN_REFRESH_WINDOW_SECONDS = 300

/** 请求超时（毫秒）。 */
export const RACCOON_REQUEST_TIMEOUT_MS = 60_000

/** 扫码轮询间隔（毫秒）。与客户端一致。 */
export const RACCOON_QR_POLL_INTERVAL_MS = 2_000

/** 扫码登录整体超时（毫秒）。 */
export const RACCOON_LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/** 扫码状态机的状态值。 */
export const RACCOON_QR_STATUS = {
  pending: 'pending',
  logging: 'logging',
  canceled: 'canceled',
  success: 'success',
} as const

/**
 * raccoon 凭据。
 *
 * ⚠️ `access_token` 字段名**必须**是这个 ——
 * `AccountPool.findAccountIdByCredential` 对非 `codearts` 的 provider
 * 统一取该字段作身份标识。
 */
export interface RaccoonCredential {
  /** JWT（服务端下发）。 */
  access_token: string
  /** 续期用（服务端下发）。 */
  refresh_token: string
  /** 过期时间（**毫秒时间戳字符串**），由 JWT 的 exp 推算。 */
  expires_at?: string
  /** `personal` 或组织码。 */
  office_identity?: string
  /** 用户 id。 */
  user_id?: string
  /**
   * 展示用昵称。
   *
   * ⚠️ **服务端的 `name` 是自动生成的默认名**（实测本机账号为 `RaccoonAva`，
   * 即「Raccoon」+ 随机串），微信扫码**不回传微信昵称**
   *（`wechat_bindings` 只有绑定 id 与时间）。故它**不适合做多账号区分** ——
   * 详见 `src/channel-pack-rpc.ts` 的昵称回填逻辑。
   */
  nickname?: string
  /**
   * 绑定/注册的手机号（远端 `user_info.phone`）。
   *
   * 用于**多账号消歧**：昵称是通用默认名时，手机号尾号是唯一可靠的区分依据。
   */
  phone?: string
  /** 设备指纹（32 位 hex），用于 `X-Client-Device-ID`。 */
  device_id?: string
}

/**
 * 解码 JWT payload 的 `exp`，换算成**毫秒**时间戳。
 *
 * ⚠️ 只解码、**不验签** —— 我们只需要知道什么时候该续期，签名由服务端校验。
 * ⚠️ 任何解析失败都返回 `undefined` 而**不抛错**：凭据可能被手工改坏，
 * 那时应当降级成「无过期信息」（宁可试一次），而不是让整个 provider 崩。
 */
export function decodeJwtExpMs(token: string): number | undefined {
  if (typeof token !== 'string' || token.length === 0) return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    // JWT 用 base64url；Node 的 base64 解码器接受 base64url 字符集
    const payload: unknown = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'))
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
    const exp = (payload as Record<string, unknown>).exp
    if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0) return undefined
    return exp * 1000
  } catch {
    return undefined
  }
}

/**
 * 解析凭据的过期时刻（毫秒）。
 *
 * 取值优先级：`expires_at`（显式字段）→ **JWT 的 `exp`**。
 *
 * ⚠️ **回退到 JWT 是必需的，不是锦上添花**：`expires_at` 是可选字段，
 * 老凭据或手工导入的凭据可能没有它。只读 `expires_at` 会让过期判定
 * **恒为 false**，于是 `refreshAll` 永远跳过这些账号 —— 表现为
 * 「凭据悄悄过期、续期从不触发」，与 AGENTS.md 里「续期按 enabled 过滤」
 * 那次缺陷是同一类（静默失效，无任何报错）。
 */
export function raccoonCredentialExpiresAtMs(credential: RaccoonCredential): number | undefined {
  const raw = credential.expires_at
  if (typeof raw === 'string' && raw.trim().length > 0) {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  // 回退：access_token 是 JWT，本地解码 exp 即可
  return decodeJwtExpMs(credential.access_token)
}

/**
 * 凭据是否已过期。
 *
 * 无任何过期信息（既无 `expires_at` 也不是 JWT）时视为**不过期**：
 * 宁可用一个可能过期的凭据去试（服务端会回 401，我们能识别并续期），
 * 也不要凭猜测阻止用户使用。
 */
export function isRaccoonExpired(credential: RaccoonCredential): boolean {
  const expiresAt = raccoonCredentialExpiresAtMs(credential)
  return expiresAt !== undefined && expiresAt <= Date.now()
}

/**
 * 凭据是否可静默续期。
 *
 * 判据是 `refresh_token` 非空 —— raccoon **有** refresh 端点
 * （`POST /api/web/auth/v1/refresh`），与 Loomy（恒 false）不同。
 */
export function isRaccoonRefreshable(credential: RaccoonCredential): boolean {
  return typeof credential.refresh_token === 'string' && credential.refresh_token.trim().length > 0
}

/** 远端模型条目中本插件关心的字段。 */
export interface RaccoonModelMeta {
  /** 模型 id（发给 `chat/completions` 的 `model`）。 */
  id: string
  /** 展示名主体（远端 `description`）。 */
  description: string
  /** **当前生效**倍率（远端 `billing_effective_multiplier`）。 */
  effectiveMultiplier: number
  /** 原价倍率（远端 `billing_multiplier`）。 */
  baseMultiplier: number
  /** 计费状态。 */
  status: 'normal' | 'discount' | 'limited_free'
  /** 状态角标文案（远端 `billing_status_note`，如「限免一个月」）。 */
  statusNote: string
}

/** 倍率格式化：去掉浮点噪声，`0.75` → `0.75`、`1` → `1`、`0.1` → `0.1`。 */
function formatMultiplier(value: number): string {
  // 最多 4 位小数，并去掉尾随 0（服务端实测值最多 2 位，留余量）
  return String(Number(value.toFixed(4)))
}

/**
 * 最终展示名：`GLM-5-3 · x0.75` / `SenseNova-6.8-Flash · 免费` /
 * `GLM-5-3-Flash · x0.2→x0.1` / `Kimi-K3 · x1`。
 *
 * ⚠️ 倍率必须拼进 `name`（**不是** `description`）：composer 的模型切换菜单
 * 只渲染 `name`，`description` 仅用于 `/model` 弹窗。这是被用户报障纠正过的结论。
 *
 * ⚠️ **1 倍也要显示**（真实缺陷，用户报障：「为什么 Kimi-K3 没有倍率，
 * ide 是 1 倍，1 倍也要显示倍率」）。早期按「1 倍是默认，显示属噪声」省略它，
 * 结果该模型在列表里**看起来没有计费信息** —— 用户无法区分
 * 「它就是 1 倍」与「我们没取到它的倍率」。IDE 的模型选择器同样显示「1 倍」，故对齐。
 *
 * 三条展示规则：
 * - 生效价为 **0** → 显示「免费」（**不是** `x0`）；
 * - 生效价 **严格小于**原价 → 显示 `x原价→x折后价`（箭头比「（促销 …）」短，
 *   适合窄菜单；与 TRAE/buddy 的形态统一）；
 * - 其余（**含 1 倍**）→ 显示 `x生效价`。
 */
export function raccoonDisplayName(model: RaccoonModelMeta): string {
  const name = typeof model.description === 'string' && model.description.length > 0
    ? model.description
    : model.id
  const effective = model.effectiveMultiplier
  // 非有限数 / 负数：不追加后缀，避免产出「模型名 · 」这种孤立分隔符。
  // ⚠️ 这条只处理「取不到倍率」，与「倍率恰好是 1」是两回事（后者要显示）。
  if (typeof effective !== 'number' || !Number.isFinite(effective) || effective < 0) return name

  if (effective === 0) return `${name} · 免费`

  const base = model.baseMultiplier
  const hasBase = typeof base === 'number' && Number.isFinite(base) && base > 0
  // 促销：有原价、原价大于生效价、且生效价非 0（0 已在上面处理）
  if (hasBase && base > effective) {
    return `${name} · x${formatMultiplier(base)}→x${formatMultiplier(effective)}`
  }
  // 含 1 倍在内，一律显示生效价（见上方注释：省略会让用户以为「没取到倍率」）
  return `${name} · x${formatMultiplier(effective)}`
}

/**
 * 业务端点请求头。
 *
 * 依据客户端 `createHeaders()`。`X-Client-Platform` 对
 * `desktop/v1/login/points/grant` **必需**（取值必须是
 * `desktop-windows` / `desktop-macos` / `desktop-linux`）。
 */
export function raccoonHeaders(
  credential: RaccoonCredential,
  opts: { platform?: string; version?: string } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${credential.access_token}`,
    // 个人账号为空串；客户端总是发送该头
    'X-Org-Code': credential.office_identity ?? '',
    'X-Raccoon-Language': 'zh',
  }
  if (opts.platform !== undefined && opts.platform.length > 0) {
    headers['X-Client-Platform'] = opts.platform
  }
  if (opts.version !== undefined && opts.version.length > 0) {
    headers['X-Client-Version'] = opts.version
  }
  if (credential.device_id !== undefined && credential.device_id.length > 0) {
    headers['X-Client-Device-ID'] = credential.device_id
  }
  return headers
}

// ── 会话 / 轮次头（magpie 0.1.15 移植） ─────────────────────────────────────
//
// 官方桌面端把**每条 chat 请求**都署名到「哪个会话的第几轮」：
//
//   X-RACCOON-Call-Kind: session_turn
//   X-RACCOON-Session-ID: <整个会话恒定>
//   X-RACCOON-Turn-ID:    <session>-turn-<n>   （同一轮的多个工具步骤同一个 n）
//
// 对应 magpie `opencode-raccoon-auth` 的 `sessionFor` / `turnOf` / `uuidish`。
// 我们**只在 `GenerateOptions` 里拿得到 `sessionId`**（宿主 agent-loop 冻结在
// 请求信封上的 `session.id`），没有 magpie 那种 `chat.headers` 钩子 ——
// 所以「宿主给了就用它，没给就从账号 + 首条 user 消息派生」。

/** `X-RACCOON-Call-Kind` 的取值（官方桌面端会话轮次）。 */
export const RACCOON_CALL_KIND_SESSION_TURN = 'session_turn'

/** 会话 id 的长度上限（照 magpie 的 `slice(0, 128)`）。 */
const RACCOON_SESSION_ID_MAX = 128

/**
 * 造一个 **UUID v4 形状**的**确定性** id。
 *
 * 照 magpie 的 `uuidish()`：`sha256(seed)` 取前 16 字节，把第 7 字节高 4 位
 * 改成 `4`（版本位）、第 9 字节高 2 位改成 `10`（变体位），再拼成
 * `8-4-4-4-12`。官方桌面端的兜底会话 id 就是这个形状。
 *
 * ⚠ **不能用 `randomUUID()`** —— 那样每次请求都会换一个会话 id，
 * 等于把「同一会话稳定」这条要求反过来做。
 */
export function raccoonUuidish(seed: string): string {
  const bytes = Buffer.from(createHash('sha256').update(seed, 'utf8').digest().subarray(0, 16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** 一条消息里所有 `text` 块拼成的文本（拿不到就空串）。 */
function raccoonMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { text: string } =>
      typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string')
    .map((block) => block.text)
    .join('')
}

/** 请求里**第一条** user 消息的文本（会话派生 seed 的一半）。 */
export function raccoonFirstUserText(
  messages: readonly { role: string; content: unknown }[],
): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const text = raccoonMessageText(message.content).trim()
    if (text.length > 0) return text
  }
  return ''
}

/**
 * 本次请求是会话里的**第几个用户轮次**（从 1 开始；没有 user 消息返回 0）。
 *
 * ⚠ **连续的 user 消息只算一轮**（数的是「轮次起点」而不是裸条数）：
 * 宿主会在用户消息后面补 user 角色的提醒/通知，`serializeMessages` 也会把
 * 工具结果里的图片提成额外的 user 消息 —— 按裸条数计，同一轮的**第二个**
 * 工具步骤就会被算成 `turn-2`，正是 magpie 明确要避免的。
 *
 * 工具结果是一等 `role: 'tool'` 消息，不进计数 ⇒ 同一轮的多个工具步骤
 * 拿到同一个 `n`，用户再发一条消息才 +1。
 */
export function raccoonTurnIndex(
  messages: readonly { role: string; content: unknown }[],
): number {
  let turn = 0
  let previousWasUser = false
  for (const message of messages) {
    const isUser = message.role === 'user'
    if (isUser && !previousWasUser) turn += 1
    previousWasUser = isUser
  }
  return turn
}

/**
 * 派生「账号」标识（会话派生 seed 的另一半）。
 *
 * 顺序：组织码 `office_identity`（个人账号是空串 → 跳过）→ 用户 id → 账号池 id。
 * ⚠ 这些字段**不随续期变**（只有 `access_token` 会换），故续期/换 token 不会
 * 把会话 id 改掉。
 */
export function raccoonAccountKey(
  credential: Pick<RaccoonCredential, 'office_identity' | 'user_id'> | undefined,
  accountId?: string,
): string {
  for (const candidate of [credential?.office_identity, credential?.user_id, accountId]) {
    const value = typeof candidate === 'string' ? candidate.trim() : ''
    if (value.length > 0) return value
  }
  return ''
}

/**
 * 会话 id：**宿主给了就用宿主的**，没给才从（账号 + 首条 user 消息）派生。
 *
 * - 宿主路径：`GenerateOptions.sessionId`（DSH 会话 id）—— 一个 DSH 会话内恒定，
 *   换账号/换模型/续期都不变，只有「新会话」才变。
 * - 派生路径：`uuidish('raccoon-session|<账号>\0<首条 user 文本>')` —— 同一会话里
 *   后续轮次的首条 user 消息不变 ⇒ 复用同一个 id。任一半缺失则返回空串
 *   （宁可不发该头，也不发一个每次请求都变的 id）。
 */
export function raccoonSessionId(input: {
  sessionId?: string | undefined
  account?: string | undefined
  messages: readonly { role: string; content: unknown }[]
}): string {
  const hostSession = input.sessionId?.trim()
  if (hostSession !== undefined && hostSession.length > 0) {
    return hostSession.slice(0, RACCOON_SESSION_ID_MAX)
  }
  const account = input.account?.trim()
  const first = raccoonFirstUserText(input.messages)
  if (account === undefined || account.length === 0 || first.length === 0) return ''
  return raccoonUuidish(`raccoon-session|${account}\u0000${first}`)
}

/**
 * 三个会话/轮次头（一次算齐，适配器直接在 `headers()` 里展开）。
 *
 * `X-RACCOON-Call-Kind` 恒发（官方桌面端也恒发）；会话 id 拿不到时退回
 * 「只发 Call-Kind」（与 magpie 的 `if (session)` 同口径），绝不发假值。
 */
export function raccoonSessionTurnHeaders(input: {
  sessionId?: string | undefined
  account?: string | undefined
  messages: readonly { role: string; content: unknown }[]
}): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RACCOON-Call-Kind': RACCOON_CALL_KIND_SESSION_TURN,
  }
  const session = raccoonSessionId(input)
  if (session.length === 0) return headers
  headers['X-RACCOON-Session-ID'] = session
  const turn = raccoonTurnIndex(input.messages)
  if (turn > 0) headers['X-RACCOON-Turn-ID'] = `${session}-turn-${turn}`
  return headers
}
