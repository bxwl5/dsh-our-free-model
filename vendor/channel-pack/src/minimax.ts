/**
 * MiniMax Code 协议常量、凭据结构与归一纯函数。
 *
 * ⚠️ **两条来源（远端解析与兜底表）共用的是「输出形状」**（`MinimaxModelEntry`），
 * **不是归一规则** —— 兜底路径由 `fallbackToEntry` 直接搬运人工填好的字面量，
 * **不调用** `normalizeMinimaxModel`。
 * ⇒ 改归一规则时**必须同步核对兜底表**，否则远端失败降级到兜底表时档位与窗口
 * 会不一致（**静默失效**，极难排查）。
 */

import {
  MINIMAX,
  type MinimaxFallbackModel,
  type MinimaxProduct,
} from './minimax-product.js'

/** 凭据结构（存 `ctx.credentials`）。 */
export interface MinimaxCredential {
  /** OAuth access token（前缀 `mmoat_`，实测 60 字符）。 */
  access_token: string
  /**
   * refresh token（实测 60 字符）。
   *
   * ⚠️ **不是 JWT**（非三段）⇒ **不能**从 JWT 解过期时间，
   * 必须用响应 `expires_in` 自算 `expires_at`。
   */
  refresh_token?: string
  /** 恒 `'Bearer'`。 */
  token_type?: string
  /**
   * 毫秒时间戳字符串（本实现写入的形态）。
   *
   * ⚠️ **读取时也兼容秒级时间戳**（`> 1e12` 视为毫秒，否则视为秒）——
   * 与既有 `src/buddy.ts` 的 `credentialExpiresAtMs` 同一约定。
   * 不兼容会让「上游/历史误写成秒」的值被当成 1970 年 ⇒ **恒判已过期**、无谓续期。
   */
  expires_at?: string
  /** 空格分隔的 scope 字符串。 */
  scope?: string
  /**
   * 账号标识（若可解）。
   *
   * ⚠️ 实测本机凭据的 `access_token` **不是 JWT**（见 `decodeJwtExpMs` 的注释），
   * 故该字段对当前凭据**恒为 undefined**。保留仅为兼容上游将来改发 JWT。
   */
  account_id?: string
  /** 展示名。 */
  nickname?: string
}

/**
 * 从 JWT 解出 `exp`（毫秒）。
 *
 * ⚠️⚠️ **实测：MiniMax 的 `access_token` 不是 JWT**（复审者 2026-09-28 读本机凭据形状：
 * 前缀 `mmoat_`、**60 字符、0 个点**；`refresh_token` 前缀 `mmort_` 同样非 JWT）。
 * 故本函数对真实凭据**恒返回 `undefined`**，`minimaxCredentialExpiresAtMs` 实际
 * **永远**走 `expires_at` 回退。
 *
 * ⇒ **登录/续期时必须写入 `expires_at`**（由 `expires_in` 自算），
 * 否则过期时间彻底丢失、账号永远显示「未知」。
 *
 * 保留本函数仅为兼容上游将来改发 JWT —— **不要**据此省略 `expires_at` 的写入。
 */
export function decodeJwtExpMs(token: string): number | undefined {
  const segments = token.split('.')
  if (segments.length !== 3 || segments[1] === undefined) return undefined
  try {
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')) as {
      exp?: unknown
    }
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      // ⚠️ 乘 1000 后仍须有限：`exp` 极大时（如 1e308）会溢出成 `Infinity`，
      // 而 `Infinity` 会被下游当成「永不过期」的有效时刻 —— 宁可返回 undefined
      //（语义为「读不到过期时间」）也不要返回一个假的无限远时刻。
      ? (Number.isFinite(payload.exp * 1000) ? payload.exp * 1000 : undefined)
      : undefined
  } catch {
    return undefined
  }
}

/** 从 JWT 解出 `sub`（账号标识）。 */
export function decodeJwtSub(token: string): string | undefined {
  const segments = token.split('.')
  if (segments.length !== 3 || segments[1] === undefined) return undefined
  try {
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')) as {
      sub?: unknown
    }
    return typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : undefined
  } catch {
    return undefined
  }
}

/**
 * 凭据过期时间（毫秒）。
 *
 * ⚠️ **优先 `expires_at`** —— 实测 `access_token` **不是 JWT**（见 `decodeJwtExpMs`），
 * 故 JWT 路径对真实凭据恒不命中。保留 JWT 分支只为兼容上游将来改发 JWT。
 *
 * ⚠️ **单位兼容**：`expires_at` 是**秒**时按秒换算（判据 `> 1e12` 视为毫秒），
 * 与既有 `src/buddy.ts:162` 的 `credentialExpiresAtMs` 同一约定。
 * 不兼容会让秒级值被当成 1970 年 ⇒ **恒判已过期**、每次使用都触发无谓续期。
 */
export function minimaxCredentialExpiresAtMs(
  credential: MinimaxCredential,
): number | undefined {
  const raw = credential.expires_at
  if (raw !== undefined) {
    // ⚠️ 只认**纯数字**串：`'1e12'` / `' 123 '` / `'123abc'` 一律视为非法并回退 JWT
    //（`Number(' 123 ')` 会静默变 123，`Number('')` 会变 0 —— 都不能放行）
    if (/^\d+$/.test(raw)) {
      const value = Number(raw)
      // > 1e12 视为毫秒，否则视为秒（既有约定）
      const parsed = value > 1_000_000_000_000 ? value : value * 1000
      if (Number.isFinite(parsed) && parsed > 0) return parsed
    }
  }
  return decodeJwtExpMs(credential.access_token)
}

/** 凭据是否已过期（无过期信息时保守视为未过期）。 */
export function isMinimaxExpired(credential: MinimaxCredential, nowMs = Date.now()): boolean {
  const expiresAt = minimaxCredentialExpiresAtMs(credential)
  return expiresAt !== undefined && nowMs >= expiresAt
}

/** 凭据是否可续期（必须有 refresh_token）。 */
export function isMinimaxRefreshable(credential: MinimaxCredential): boolean {
  return typeof credential.refresh_token === 'string' && credential.refresh_token.length > 0
}

/**
 * 「已花掉的 refresh_token → 续期结果」的缓存保留时长：**30 天**。
 *
 * 数值照 magpie（minimax 插件）的 `KEEP_RENEWED_MS`：`30 * 24 * 3600 * 1000`。
 */
export const MINIMAX_RENEWED_KEEP_MS = 30 * 24 * 3_600_000

/**
 * **已花掉的 refresh_token → 它能换出的新凭据**（进程生命周期，永不落盘）。
 *
 * ## 为什么必须有它（真实缺陷路径）
 *
 * MiniMax 的 refresh_token **用一次即废**：续期成功那一刻旧值就作废。于是有这条
 * 死路 —— 续期成功、但**写盘失败**（Windows 上凭据文件被另一个进程/杀软占用）：
 *
 * 1. 磁盘上留着的还是**已被上游消费**的旧 refresh_token；
 * 2. 下一轮（30 分钟后或任何一个 RPC）读到的仍是旧值，再拿去换；
 * 3. 上游回 `invalid_grant` → `refreshCredentialFor` 把它判成
 *    「refresh_token 已失效，请重新登录」→ 账号被当成**终态**登出；
 * 4. 而实际上新令牌一直在内存里、只是没写下去 —— 用户被要求重新登录整号。
 *
 * 有了这份缓存，第 2 步在**发请求之前**就能认出「这枚 token 本进程已经花过」，
 * 直接把续期结果拿来用（并重试落盘），绝不会再把它发第二遍。
 *
 * ## 为什么要 30 天，而不是 magpie 早期的一分钟
 *
 * magpie 的注释记着这件事（`opencode-minimax-auth/index.mjs:941-951`）：早先
 * 「落盘成功后才保留一分钟」，等于**默认写盘一定成功**；磁盘写失败时旧 token
 * 会在一分钟后被原样重发，撞 `invalid_grant` 把账号登出。因为一枚 token 一旦
 * 被 MiniMax 消费就**永远不会再有效**，所以「它换出的结果」对它的解释力应当
 * 与进程同寿 —— magpie 把上限定成 30 天（`KEEP_RENEWED_MS`）。
 *
 * ## 与 `service.ts` 的串行队列（`SerialQueue`）的关系
 *
 * **无关，且不重叠**：那把锁防的是「多入口并发花同一枚 token」，本缓存防的是
 * 「花过之后还拿旧值去花」。{@link MinimaxRenewedCache.renew} 内部另有
 * in-flight 合并（同一枚 token 的并发请求共用一次网络），同样不改 `service.ts`
 * 里 CodeArts 那套队列的语义。
 */
export class MinimaxRenewedCache {
  /** 已花掉的 refresh_token → 它换出的凭据与记账时刻。 */
  private readonly renewed = new Map<string, { credential: MinimaxCredential; atMs: number }>()
  /** 在途续期：同一枚 token 的并发请求共用同一个 Promise（对齐 magpie 的 `renewing`）。 */
  private readonly renewing = new Map<string, Promise<MinimaxCredential>>()

  constructor(
    private readonly keepMs = MINIMAX_RENEWED_KEEP_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * 顺着「已花掉的 refresh_token」链，取本进程见过的最新凭据。
   *
   * 对齐 magpie 的 `latest()`（最多跟 16 跳）：磁盘上可能是第 1 枚 token，
   * 而本进程已经续过两轮 —— 直接照搬磁盘那份就会再烧一次已死的 token。
   * 没命中任何一环时原样返回入参（引用不变），调用方据此判「有没有命中」。
   */
  latest(credential: MinimaxCredential): MinimaxCredential {
    let current = credential
    for (let hop = 0; hop < 16; hop += 1) {
      const spent = current.refresh_token
      if (typeof spent !== 'string' || spent.length === 0) break
      const done = this.renewed.get(spent)
      if (done === undefined || this.now() - done.atMs >= this.keepMs) break
      const merged: MinimaxCredential = { ...current, ...done.credential }
      // 结果与现值相同（或上游原样回吐）就别再绕圈，防死循环。
      if (merged.access_token === current.access_token && merged.refresh_token === current.refresh_token) break
      current = merged
    }
    return current
  }

  /** 这枚 refresh_token 是否**已经花过**且结果还在保留期内（命中即可免发请求）。 */
  spent(credential: MinimaxCredential): boolean {
    const token = credential.refresh_token
    if (typeof token !== 'string' || token.length === 0) return false
    const done = this.renewed.get(token)
    return done !== undefined && this.now() - done.atMs < this.keepMs
  }

  /**
   * 用 `credential` 的 refresh_token 换新令牌（同一枚并发合并成一次请求）。
   *
   * ⚠️ 结果为**续期响应本身**（含新 access/refresh/expires_at），调用方负责落盘。
   * ⚠️ 登记发生在**`run` 成功之后、调用方落盘之前**：写盘失败不影响缓存
   * （这正是本缓存存在的理由）；`run` 抛错则什么都不登记（失败可重试）。
   */
  async renew(
    credential: MinimaxCredential,
    run: (spentRefreshToken: string) => Promise<MinimaxCredential>,
  ): Promise<MinimaxCredential> {
    const spent = credential.refresh_token
    if (typeof spent !== 'string' || spent.length === 0) {
      throw new Error('凭据缺少 refresh_token，无法续期')
    }
    // 先认缓存：并发的另一条路径可能刚续完。
    const running = this.renewing.get(spent)
    if (running !== undefined) return running
    if (this.spent(credential)) {
      const done = this.renewed.get(spent)
      if (done !== undefined) return done.credential
    }
    const task = (async () => {
      const next = await run(spent)
      this.forgetOld()
      this.renewed.set(spent, { credential: next, atMs: this.now() })
      return next
    })().finally(() => {
      this.renewing.delete(spent)
    })
    this.renewing.set(spent, task)
    return task
  }

  /** 丢掉超出保留期的条目（对齐 magpie 的 `forgetOld()`；在每次登记前调用）。 */
  forgetOld(): void {
    const nowMs = this.now()
    for (const [token, done] of this.renewed) {
      if (nowMs - done.atMs >= this.keepMs) this.renewed.delete(token)
    }
  }

  /** 已登记条数（观测 / 单测用）。 */
  get size(): number {
    return this.renewed.size
  }

  /** 清空（登出 / 单测用；进程重启时自然也是空的）。 */
  clear(): void {
    this.renewed.clear()
    this.renewing.clear()
  }
}

/**
 * 进程级共享缓存（进程生命周期，不落盘）。
 *
 * 放成模块级单例而不是实例字段：`MinimaxAuth` 可能被多个 ctx（app / 定时器 /
 * 多产品实例 minimax-code 与 minimax-code-global）各建一个，而 token 的
 * 「已花掉」事实是**进程级**的 —— 实例字段会让另一份实例又去烧同一枚 token。
 * 键用 refresh_token 本身，天然按账号隔离，多产品共用一张表也不会串。
 */
export const MINIMAX_RENEWED = new MinimaxRenewedCache()

/**
 * 构造业务请求头。
 *
 * ⚠️ MiniMax 的业务端点**只需 Bearer**（实测签到 / 积分 / 目录均如此），
 * 不需要 machine 头或签名（与 Qoder 的 `/sash/` 端点是**不同**情形）。
 */
export function minimaxHeaders(credential: MinimaxCredential): Headers {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${credential.access_token}`)
  headers.set('Accept', 'application/json')
  return headers
}

/**
 * 推理请求的头（**Anthropic Messages** 端点）。
 *
 * ⚠️ **实测不需要 `anthropic-version` 头**（2026-09-29 真实请求：只带
 * `Authorization` + `Content-Type` + `Accept` 即 HTTP 200）。
 * 故**不照抄 Anthropic 官方文档**加那个头 —— 加未经验证的头是猜测。
 *
 * ⚠️ `Accept: text/event-stream`（不是 `application/json`）：
 * 请求体带 `stream: true`，响应是 SSE。
 */
export function minimaxInferHeaders(credential: MinimaxCredential): Headers {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${credential.access_token}`)
  headers.set('Content-Type', 'application/json')
  headers.set('Accept', 'text/event-stream')
  return headers
}

/** 归一后的模型条目（远端与兜底**共用**的形状）。 */
export interface MinimaxModelEntry {
  id: string
  name: string
  /**
   * 上下文窗口。
   *
   * ⚠️ **`0` 是「未知」哨兵**，不是合法窗口 —— 调用方（`resolveModel`）
   * **必须**判 `> 0` 才声明，否则会把 0 当成有效窗口下发给 DSH。
   */
  contextWindow: number
  /**
   * 单次输出上限。
   *
   * ⚠️ **可选**：远端 `limit.output` 非正整数（`0` / 负数 / `NaN` / 缺失）时
   * **整个键不产出**。声明成必填 `number` 会让类型撒谎 —— 调用方若信它，
   * 会把 `undefined` 塞给 DSH 的 `defaultMaxTokens`，触发
   * `INVALID_MODEL_MAX_TOKENS`，**整轮对话起不来**（不是降级，是崩）。
   *
   * 兜底表的每一条都填了它（见 `MinimaxFallbackModel.maxTokens`），
   * 故可选只影响远端路径。
   */
  maxTokens?: number
  supportsImage: boolean
  effortOptions?: readonly string[]
  defaultEffort?: string
  /**
   * 思考开关模式（远端 `thinking_config.mode`）。
   *
   * ⚠️ `'switchable'` ⇒ 该模型**可以关闭思考**，`minimaxReasoningInfo` 会
   * 追加 `none` 档（DSH 的 `LlmModelReasoningInfo` 没有 `supportsDisable` 字段，
   * 「可关闭」就是靠 `efforts` 里出现 `none` 表达的）。
   * `'forced_on'` ⇒ **不可关闭**，绝不追加（M3.1 会硬 400、M2.7 被静默忽略）。
   * 缺失 ⇒ 未知，不声明开关能力。
   */
  thinkingMode?: string
}

/** 只放行**安全正整数**。 */
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** 读成非空字符串。 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** 读成非空字符串数组（去重保序）。 */
function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const text = nonEmptyString(item)
    if (text === undefined || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out.length > 0 ? out : undefined
}

/**
 * 把**远端**模型条目归一。
 *
 * 规则参照 asar `official-model-config-sync.js` 的 `parseModel`：
 * - `contextWindow` 取 `context_window_options` **最大档**；无档位表则回退 `limit.context`
 * - `maxTokens` 取 `limit.output`，**只放行安全正整数**（`0`/负数/`NaN` 会让 DSH 抛
 *   `INVALID_MODEL_MAX_TOKENS`，**整轮对话起不来**）
 * - `supportsImage` = `modalities.input` 含 `'image'`
 * - `effortOptions` 取 `effort_options`（去重保序）
 * - `defaultEffort` 取 `default_effort`，**必须落在 `effortOptions` 内**，否则丢弃
 *
 * ⚠️ **只实现了 snake_case 字段名**（实测远端下发即 snake_case）。asar 的
 * `parseModel` 通过 `aliasValue()` **同时**认 camelCase 别名（实测共 4 组：
 * `context_window_options` ← `contextWindowOptions` / `context_options`；
 * `context_window_option_hints` ← `contextWindowOptionHints` / `context_option_hints`；
 * `effort_options` ← `thinking.effortOptions`；
 * `default_effort` ← `thinking.defaultEffort`），
 * 并带 `≤ 2147483647`（2^31-1）上限校验（`requirePositiveInteger` 超限即抛）——
 * **这些本实现都没有做**。
 *
 * 若哪天远端改下发 camelCase，或下发超过 2^31-1 的值，本函数会**静默取不到值**
 * （窗口退化为 `0` 哨兵 / 回退 `limit.context`），届时需按 asar 补齐。
 */
export function normalizeMinimaxModel(raw: unknown): MinimaxModelEntry | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  // ⚠️ `id` 与 `name` 是**两个不同字段**：
  // - 远端 `models` 对象的 **key** 是长名（`MiniMax-M3.1-Flash-Preview`），
  //   由 `parseMinimaxModelsPayload` 注入为 `record.id`
  // - 远端条目的 `name` 字段是**短名**（`M3.1-Flash-Preview`），官方 IDE 就显示它
  // 故两者必须分别取，不能合并。
  const id = nonEmptyString(record.id) ?? nonEmptyString(record.name)
  if (id === undefined) return undefined
  const name = nonEmptyString(record.name) ?? id

  const limit = typeof record.limit === 'object' && record.limit !== null
    ? record.limit as Record<string, unknown>
    : {}

  // 窗口：档位表最大档优先
  const options = Array.isArray(record.context_window_options)
    ? record.context_window_options.filter((v): v is number => positiveInt(v) !== undefined)
    : []
  const limitContext = positiveInt(limit.context)
  const contextWindow = options.length > 0
    ? Math.max(...options)
    : limitContext

  const modalities = typeof record.modalities === 'object' && record.modalities !== null
    ? record.modalities as Record<string, unknown>
    : {}
  const inputs = Array.isArray(modalities.input)
    ? modalities.input.filter((v): v is string => typeof v === 'string')
    : []

  const effortOptions = stringArray(record.effort_options)
  const rawDefault = nonEmptyString(record.default_effort)
  // ⚠️ 默认档必须落在档位表内，否则不发（照 Qoder 的 resolveModel）
  const defaultEffort = rawDefault !== undefined && effortOptions?.includes(rawDefault) === true
    ? rawDefault
    : undefined
  // ⚠️ `thinking_config.mode` 决定「能否关闭思考」（2026-09-29 新增）。
  // 实测三种值：`forced_on`（关不掉）/ `switchable`（可开关）。
  // 缺失 ⇒ 不产出该键（视为未知，**不猜**）。
  const thinkingConfig = typeof record.thinking_config === 'object' && record.thinking_config !== null
    ? record.thinking_config as Record<string, unknown>
    : undefined
  const thinkingMode = thinkingConfig === undefined
    ? undefined
    : nonEmptyString(thinkingConfig.mode)

  // ⚠️ **不要用 `as MinimaxModelEntry` 断言** —— 它会掩盖「可选键未产出」
  // 这类真实的不一致（Task 1 实施者实测：加断言后 `tsc` 静默通过，
  // 去掉后报 TS2322）。`maxTokens` 已声明为可选，故此处**无需断言**。
  const maxTokens = positiveInt(limit.output)
  return {
    id,
    name,
    // 窗口未知时**不编造**：用 0 表示「不知道」，由 resolveModel 判 `> 0`
    contextWindow: contextWindow ?? 0,
    ...maxTokens === undefined ? {} : { maxTokens },
    supportsImage: inputs.includes('image'),
    ...effortOptions === undefined ? {} : { effortOptions },
    ...defaultEffort === undefined ? {} : { defaultEffort },
    ...thinkingMode === undefined ? {} : { thinkingMode },
  }
}

/**
 * 兜底表条目转归一形状。
 *
 * ⚠️ **不是「与远端走同一套规则」** —— 本函数**直接搬运字面量**，不调用
 * `normalizeMinimaxModel`：两条路径只共用**输出形状**（`MinimaxModelEntry`），
 * **不共用归一规则**。兜底表的值是**人工按实测口径填好的字面量**
 * （已符合「档位表最大档」口径），故只需搬运、无需再归一。
 *
 * ⚠️ 因此**改归一规则时必须同步核对兜底表**（例如改了窗口口径，
 * 兜底表不会跟着变）—— 回归用例里有一条一致性断言专门锁这一点。
 */
export function fallbackToEntry(model: MinimaxFallbackModel): MinimaxModelEntry {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    supportsImage: model.supportsImage,
    ...model.effortOptions === undefined ? {} : { effortOptions: model.effortOptions },
    ...model.defaultEffort === undefined ? {} : { defaultEffort: model.defaultEffort },
    ...model.thinkingMode === undefined ? {} : { thinkingMode: model.thinkingMode },
  }
}

/** 默认产品下的兜底条目。 */
export function minimaxFallbackEntries(
  product: MinimaxProduct = MINIMAX,
): readonly MinimaxModelEntry[] {
  return product.fallbackModels.map(fallbackToEntry)
}
