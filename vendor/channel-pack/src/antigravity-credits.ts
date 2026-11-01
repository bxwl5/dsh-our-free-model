/**
 * Gemini（Cloud Code Assist）**配额窗口**查询。
 *
 * 逐点移植自 `cmdc-pak-align-wb/internal/upstream/antigravity/quota.go`。
 *
 * ## 端点与身份
 *
 * `POST {sandbox}/v1internal:retrieveUserQuotaSummary`，身份头与推理请求
 * **完全一致**（`antigravityHeaders`），Bearer 用 `access_token`。
 *
 * ## ⚠️ 请求体**必须带 `project`**（2026-10-03 修正）
 *
 * 原版（`quota.go:25`）发的是空对象 `{}`，那是**单账号**抓包的结论。实测第二个
 * Google 账号（`yinghaolin521@gmail.com`）用 `{}` 会被拒：
 *
 * ```
 * 403 PERMISSION_DENIED  SUBSCRIPTION_REQUIRED (#3501)
 * "You do not have a valid license of this product."
 * ```
 *
 * 而**同一个 token、同一组身份头**，只要请求体带上 `{"project":"aicode-consumers"}`
 * 就 200 —— 唯一的变量就是 `project`。同一账号的**推理**请求本来就在信封里带
 * `project`（`antigravity-messages.ts:278`），所以只有配额这条链路会 403：
 * 面板显示「凭据已失效」，而「测试」按钮照样能发请求（用户 m07113 报障）。
 *
 * 字段名是 `project`，**不是** `cloudaicompanionProject` —— 后者会 400
 * `Unknown name "cloudaicompanionProject": Cannot find field.`。值取凭据里的
 * `cloudaicompanionProject`（`loadCodeAssist` 的回报，实测恒为 `aicode-consumers`），
 * 缺失时退到 {@link ANTIGRAVITY_DEFAULT_PROJECT}。
 *
 * ⚠️ 走 **sandbox** 端点而不是 daily：原版 `baseFor(path)` 把
 * `loadCodeAssistPath` / `retrieveQuotaPath` 两类路径固定路由到 sandbox，
 * 其余（含推理）才走轮换端点。忠实移植这个路由，不"顺手统一"。
 *
 * ## ⚠️ 这不是「积分余额」
 *
 * Gemini 免费线是**配额窗口**制（5 小时 / 周两个窗口的**剩余比例**），
 * 不是充值积分。面板如实显示「5 小时窗口 99% / 周窗口 99%」，
 * **不**换算成任何积分数字 —— 那会是编造。
 *
 * ## ⚠️ 桶 id 是判据，`displayName` 不是
 *
 * 响应里第三组桶（`3p-*`）属于 Claude/GPT 产品线，与本 provider 无关。
 * 只认 `antigravity-5h` / `antigravity-weekly` 两个 id，**不按显示名匹配** ——
 * 显示名会被上游改文案，id 不会。
 *
 * ## ⚠️ `resetTime` 解析失败 ⇒ **整条桶丢弃**
 *
 * 原版 `windowOf` 的口径：拿不到可解析的重置时间就无法表达窗口周期，
 * 编一个空串会让面板显示一个**永远不过期**的窗口。宁可少一个包，也不伪造。
 *
 * ## ⚠️ 未授权**不是错误**
 *
 * 没有 access_token 时返回 `{ balance: null, error: '尚未授权 Google 账号' }`
 * （照原版 `MessageUnauthorized`）。面板靠这条文案区分「没登录」与
 * 「查询失败」—— 把它抛成异常会让账号卡片显示成故障。
 *
 * ## 账号规格（`tier`）搭这趟车
 *
 * 面板还要显示「这是 Pro 还是 Free」。规格来自 `loadCodeAssist`，与配额是
 * **两个端点**，但**并行发在同一次调用里**（面板 30 秒刷一次，多一个独立
 * RPC 只会多一份编排）。取到的档位挂在 {@link AntigravityBalanceResult.tier} 上，
 * 失败就 `undefined`（不渲染那一行），**绝不影响配额行**。
 */

import { roundCredits, type CreditBalance, type CreditPackage } from './credits.js'
import {
  ANTIGRAVITY,
  ANTIGRAVITY_CREDITS_TIMEOUT_MS,
  ANTIGRAVITY_DEFAULT_PROJECT,
  ANTIGRAVITY_ENDPOINT_SANDBOX,
  ANTIGRAVITY_LOAD_CODE_ASSIST_BODY,
  ANTIGRAVITY_LOAD_CODE_ASSIST_PATH,
  ANTIGRAVITY_QUOTA_CACHE_TTL_MS,
  ANTIGRAVITY_QUOTA_PATH,
  antigravityHeaders,
  type AntigravityCredential,
  type AntigravityProduct,
} from './antigravity.js'

/** 未授权时的文案（原版 `MessageUnauthorized`，面板据此区分「没登录」）。 */
export const ANTIGRAVITY_UNAUTHORIZED_MESSAGE = '尚未授权 Google 账号'

/**
 * 窗口桶 id（2026-11-01 按上游实测更正）。
 *
 * ⚠️ 旧值 `antigravity-5h` / `antigravity-weekly` 是**臆测**——上游从未下发过
 * 这两个 id。个人 free-tier 实测（Antigravity 2.28.2 凭据 + `project:
 * aicode-consumers`）：Gemini 组桶 id 为 `gemini-5h` / `gemini-weekly`，三方
 * 模型组（Claude/GPT）为 `3p-5h` / `3p-weekly`（Agent2API `balance.rs` 模块头
 * 同款清单）。匹配按**后缀语义**而非全等：`5h` 结尾 → 五小时窗，`weekly` 结尾
 * → 周窗，Gemini 组优先于 3p 组（面板只展示 Gemini 桶）。
 */
export const ANTIGRAVITY_BUCKET_FIVE_HOUR = 'gemini-5h'
export const ANTIGRAVITY_BUCKET_WEEKLY = 'gemini-weekly'

/** 桶 id → 窗口语义（None = 不是配额窗桶，如三方组按需扩展时再接）。 */
function bucketWindowOf(bucketId: string): 'fiveHour' | 'weekly' | undefined {
  if (bucketId === 'gemini-5h' || bucketId === '3p-5h' || bucketId.endsWith('-5h')) return 'fiveHour'
  if (bucketId === 'gemini-weekly' || bucketId === '3p-weekly' || bucketId.endsWith('-weekly')) return 'weekly'
  return undefined
}

/** 面板里两个窗口的显示名（**不是**积分，故不写「积分」二字）。 */
export const ANTIGRAVITY_WINDOW_LABEL_FIVE_HOUR = '5 小时窗口'
export const ANTIGRAVITY_WINDOW_LABEL_WEEKLY = '周窗口'

/** 配额单位：剩余**百分比**。 */
const ANTIGRAVITY_QUOTA_UNIT = '%'

/**
 * 账号规格（Google 档位）。
 *
 * ⚠️ **判据是 `paidTier`，不是 `currentTier`**：实测两个账号的 `currentTier`
 * 都是 `{id:'free-tier',name:'Antigravity'}`，**完全一样**；真正区分「有没有
 * Google AI Pro」的是 `paidTier`（`g1-pro-tier` / `Google AI Pro` 对
 * `free-tier` / `Antigravity Starter Quota`）。原版 `project.go:25-34` 的
 * `loadCodeAssistResponse` **没有 `paidTier` 字段**，所以原版做不到这件事
 * —— 这是我们的新增能力，不要"对齐原版"把它删掉。
 *
 * ⚠️ `currentTier` 只作兜底（`paidTier` 缺席时）。
 */
export interface AntigravityAccountTier {
  /** 上游档位 id（`g1-pro-tier` / `free-tier`），hover 里原样展示。 */
  readonly id: string
  /** 上游档位名（`Google AI Pro`），hover 里原样展示。 */
  readonly name: string
  /** 面板上的短标签：`Pro` / `Free` / `Ultra`。 */
  readonly label: string
}

/**
 * 档位 id / 名 → 面板短标签。
 *
 * 顺序有意义：`Ultra` → `Pro` → `Free`。上游把「Pro 但已降级」也叫
 * `free-tier`（`Antigravity Starter Quota`），故不能只看 id 的 `-tier` 后缀。
 */
function tierLabel(id: string, name: string): string {
  const combined = `${id} ${name}`.toLowerCase()
  if (combined.includes('ultra')) return 'Ultra'
  if (combined.includes('pro')) return 'Pro'
  if (combined.includes('free')) return 'Free'
  return name !== '' ? name : id
}

/** 取一个 tier 对象里的 id / name；两者都空即视为不存在。 */
function pickTier(raw: unknown): { id: string; name: string } | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : ''
  const name = typeof record.name === 'string' ? record.name : ''
  if (id === '' && name === '') return undefined
  return { id, name }
}

/**
 * 从 `loadCodeAssist` 响应里解出账号规格。
 *
 * ⚠️ 只读 `paidTier` / `currentTier` 的 `id` / `name`。响应里还有
 * `description`、`privacyNotice.noticeText`（一大段英文隐私说明）、
 * `allowedTiers` —— **一个都不要展示**。
 */
export function parseGeminiAccountTier(payload: unknown): AntigravityAccountTier | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const record = payload as Record<string, unknown>
  const tier = pickTier(record.paidTier) ?? pickTier(record.currentTier)
  if (tier === undefined) return undefined
  return { id: tier.id, name: tier.name, label: tierLabel(tier.id, tier.name) }
}

/** 归一后的一个配额窗口。 */
export interface AntigravityQuotaWindow {
  readonly bucketId: string
  /** 上游自报的窗口名（`5h` / `weekly`），仅诊断用。 */
  readonly window: string
  /** 窗口重置时刻（原样透传给面板的 `cycleEndTime`）。 */
  readonly resetTime: string
  /** 剩余比例 0..1（上游原值，未取整）。 */
  readonly remainingFraction: number
}

/** 一次配额查询的结果（**不抛错**，失败用 `error` 表达）。 */
export interface AntigravityBalanceResult {
  balance: CreditBalance | null
  error?: string
  /**
   * 账号规格（`loadCodeAssist` 顺带取的档位）。
   *
   * ⚠️ **可选且与 `error` 无关**：档位查询失败（网络/上游改协议）绝不能让
   * 配额行跟着报错 —— 它只是一栏附注信息。拿不到就不渲染那一行。
   */
  tier?: AntigravityAccountTier
}

/** {@link fetchGeminiCreditBalance} 的可选参数。 */
export interface AntigravityCreditOptions {
  /** 跳过缓存（面板「刷新」按钮）。 */
  force?: boolean
  /** 时钟注入（测试用）。 */
  now?: () => number
  /** fetch 注入（测试用）。 */
  fetcher?: typeof fetch
}

/**
 * 60 秒缓存。
 *
 * 面板 30 秒刷一次，60 秒缓存既扛得住连续刷新，又不至于让「快用完了」
 * 滞后太久（原版 `quotaCacheTTL` 同值）。键用 **access_token** ——
 * 它是账号的稳定标识，且配额本身就是按 token 归属的。
 */
const cache = new Map<string, { at: number; result: AntigravityBalanceResult }>()

/** 清空缓存（测试与「重置限流标记」用）。 */
export function clearGeminiCreditCache(): void {
  cache.clear()
}

/** 解析单个桶；任何硬约束不满足即返回 `undefined`（**不编造**）。 */
export function parseGeminiQuotaWindow(raw: unknown): AntigravityQuotaWindow | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const bucketId = typeof record.bucketId === 'string' ? record.bucketId : ''
  if (bucketId === '') return undefined
  const fraction = record.remainingFraction
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return undefined
  const resetTime = typeof record.resetTime === 'string' ? record.resetTime : ''
  // ⚠️ 不可解析的重置时间 ⇒ 整条丢弃（见文件头注释）。
  if (resetTime === '' || Number.isNaN(Date.parse(resetTime))) return undefined
  const window = typeof record.window === 'string' ? record.window : ''
  return { bucketId, window, resetTime, remainingFraction: fraction }
}

/**
 * 从响应体里挑出两个 Gemini 桶。
 *
 * 形状（原版注释里的实测结论，**普通 JSON 不是 protobuf**）：
 * ```json
 * {"groups":[{"displayName":"Gemini Models","buckets":[
 *   {"bucketId":"antigravity-weekly","window":"weekly","resetTime":"…","remainingFraction":0.99},
 *   {"bucketId":"antigravity-5h","window":"5h","resetTime":"…","remainingFraction":0.99}]},
 *  {"displayName":"Claude and GPT models","buckets":[…]}]}
 * ```
 *
 * ⚠️ 按 `bucketId` 匹配，**不按 `displayName` / `window`**：显示名是文案、
 * 会变；`window` 字段在实测里出现过缺失。id 是唯一稳定判据。
 */
export function parseGeminiQuotaWindows(payload: unknown): {
  fiveHour?: AntigravityQuotaWindow
  weekly?: AntigravityQuotaWindow
} {
  if (typeof payload !== 'object' || payload === null) return {}
  const groups = (payload as Record<string, unknown>).groups
  if (!Array.isArray(groups)) return {}
  let fiveHour: AntigravityQuotaWindow | undefined
  let weekly: AntigravityQuotaWindow | undefined
  for (const group of groups) {
    if (typeof group !== 'object' || group === null || Array.isArray(group)) continue
    const buckets = (group as Record<string, unknown>).buckets
    if (!Array.isArray(buckets)) continue
    for (const bucket of buckets) {
      const parsed = parseGeminiQuotaWindow(bucket)
      if (parsed === undefined) continue
      // 按 bucketId 的**窗口语义**匹配（实测桶 id 为 gemini-5h / gemini-weekly /
      // 3p-5h / 3p-weekly；旧的 antigravity-* 全等匹配永远落空 —— 用户报障
      // 「配额响应里没有 Gemini 配额桶」的根因）。
      const windowKind = bucketWindowOf(parsed.bucketId)
      if (windowKind === 'fiveHour' && fiveHour === undefined) fiveHour = parsed
      if (windowKind === 'weekly' && weekly === undefined) weekly = parsed
    }
  }
  return {
    ...(fiveHour === undefined ? {} : { fiveHour }),
    ...(weekly === undefined ? {} : { weekly }),
  }
}

/**
 * 分组桶解析（2026-11-01 起：模型绿标需要**按组**的余量）。
 *
 * `retrieveUserQuotaSummary` 实测下发两个分组桶：Gemini 组（`gemini-weekly` /
 * `gemini-5h`）与 Claude/GPT 组（`3p-weekly` / `3p-5h`），两组**独立计数**
 *（同 token 实测：gemini-weekly 99.9% / 3p-weekly 95.8%）。而
 * `fetchAvailableModels` 的模型级 `quotaInfo.remainingFraction` 是**粗粒度
 * 快照**（归一到 1/0 两态），永远显示 100% —— 模型名后面的「剩 N%」绿标
 * 必须用组桶的精确值。
 *
 * 组别判据用 `bucketId` 前缀（`gemini-*` / `3p-*`），窗口语义仍走
 * {@link bucketWindowOf}。
 */
export interface AntigravityGroupBuckets {
  /** Gemini 组周窗（`gemini-weekly`）。 */
  geminiWeekly?: AntigravityQuotaWindow
  /** Gemini 组 5 小时窗（`gemini-5h`）。 */
  geminiFiveHour?: AntigravityQuotaWindow
  /** Claude/GPT 组周窗（`3p-weekly`）。 */
  threePWeekly?: AntigravityQuotaWindow
  /** Claude/GPT 组 5 小时窗（`3p-5h`）。 */
  threePFiveHour?: AntigravityQuotaWindow
}

export function parseGeminiGroupBuckets(payload: unknown): AntigravityGroupBuckets {
  if (typeof payload !== 'object' || payload === null) return {}
  const groups = (payload as Record<string, unknown>).groups
  if (!Array.isArray(groups)) return {}
  const out: AntigravityGroupBuckets = {}
  for (const group of groups) {
    if (typeof group !== 'object' || group === null || Array.isArray(group)) continue
    const buckets = (group as Record<string, unknown>).buckets
    if (!Array.isArray(buckets)) continue
    for (const bucket of buckets) {
      const parsed = parseGeminiQuotaWindow(bucket)
      if (parsed === undefined) continue
      const kind = bucketWindowOf(parsed.bucketId)
      if (kind === undefined) continue
      const isThreeP = parsed.bucketId.startsWith('3p-')
      const slot =
        kind === 'weekly' ? (isThreeP ? 'threePWeekly' : 'geminiWeekly')
        : isThreeP ? 'threePFiveHour' : 'geminiFiveHour'
      if (out[slot] === undefined) out[slot] = parsed
    }
  }
  return out
}

/**
 * 模型绿标的**组桶快照缓存**（按 token）。
 *
 * `credits.balances` RPC（面板刷新/打开渠道卡）每次都会真查桶；把组桶余量
 * 存在这里，`model.list` 的同步 `quotaFor` 就能读到精确值而不必自己发请求
 *（quotaFor 是同步接口，见 adapter 注释的 `[...all]` 崩溃先例）。
 *
 * ⚠️ 缓存与余额缓存同 TTL：过期后 adapter 读到的值可能偏旧，但「偏旧的
 * 百分比」仍远好于粗快照的恒 100%（用户报障的根因）；下一次
 * `credits.balances` 会自然刷新。
 */
const groupBucketCache = new Map<string, { at: number; buckets: AntigravityGroupBuckets }>()

/** 写组桶快照（`requestQuotaSummary` 成功路径调用）。 */
function rememberGroupBuckets(token: string, buckets: AntigravityGroupBuckets): void {
  if (Object.keys(buckets).length === 0) return
  groupBucketCache.set(token, { at: Date.now(), buckets })
}

/** 组桶快照的有效期（与面板余额缓存同量级）。 */
export const ANTIGRAVITY_GROUP_BUCKET_TTL_MS = ANTIGRAVITY_QUOTA_CACHE_TTL_MS

/** 读组桶快照（`quotaFor` 用）。过期/无数据返回 `undefined`。 */
export function cachedGroupBuckets(
  token: string,
  maxAgeMs: number = ANTIGRAVITY_GROUP_BUCKET_TTL_MS,
): AntigravityGroupBuckets | undefined {
  const cached = groupBucketCache.get(token)
  if (cached === undefined) return undefined
  if (Date.now() - cached.at > maxAgeMs) return undefined
  return cached.buckets
}

/** 清空组桶缓存（测试用）。 */
export function clearGeminiGroupBucketCache(): void {
  groupBucketCache.clear()
}

/** 剩余比例 → 百分比整数（0..100，越界收敛）。 */
function percentOf(window: AntigravityQuotaWindow): number {
  const clamped = Math.min(1, Math.max(0, window.remainingFraction))
  return Math.round(clamped * 100)
}

/** 一个窗口 → 一个 {@link CreditPackage}（单位是百分比，不是积分）。 */
function makeQuotaPackage(label: string, window: AntigravityQuotaWindow): CreditPackage {
  const remaining = percentOf(window)
  return {
    name: label,
    unit: ANTIGRAVITY_QUOTA_UNIT,
    remaining,
    total: 100,
    used: 100 - remaining,
    active: true,
    cycleStartTime: '',
    cycleEndTime: window.resetTime,
    expiredTime: '',
  }
}

/**
 * 两个窗口 → 插件统一的 {@link CreditBalance}。
 *
 * ⚠️ `total` 取两窗口剩余百分比的**平均**（面板顶部的汇总数字）——
 * 对照 `src/cline-credits.ts:110` 的 `toClineCreditBalance` 口径：
 * 它那里只有一个数字可用，这里有两个，取平均是最不误导的汇总
 * （取 min 会把「周窗口 99% / 5 小时窗口 20%」显示成 20%，
 * 让用户以为整条线快用完了）。
 *
 * ⚠️ `expiredTotal` 恒 0：配额窗口没有"过期积分"这个概念。
 */
export function toGeminiCreditBalance(
  fiveHour?: AntigravityQuotaWindow,
  weekly?: AntigravityQuotaWindow,
): CreditBalance {
  const packages: CreditPackage[] = []
  if (fiveHour !== undefined) packages.push(makeQuotaPackage(ANTIGRAVITY_WINDOW_LABEL_FIVE_HOUR, fiveHour))
  if (weekly !== undefined) packages.push(makeQuotaPackage(ANTIGRAVITY_WINDOW_LABEL_WEEKLY, weekly))
  if (packages.length === 0) return { total: 0, packages: [], expiredTotal: 0 }
  const sum = packages.reduce((acc, item) => acc + item.remaining, 0)
  return {
    total: roundCredits(sum / packages.length),
    packages,
    expiredTotal: 0,
  }
}

/**
 * 查询配额窗口。
 *
 * ⚠️ **本函数不抛错**（与 `fetchClineCreditBalance` / `fetchMinimaxCreditBalance`
 * 同契约）：批量查询时单账号失败不得中断其余账号。
 *
 * @param credential - 目标账号凭据。
 * @param _product - 为与其余 provider 的 `fetch*CreditBalance(credential, product)`
 *   签名保持一致而保留（配额端点是全局固定的，不需要产品配置）。
 */
export async function fetchGeminiCreditBalance(
  credential: AntigravityCredential,
  _product: AntigravityProduct = ANTIGRAVITY,
  options: AntigravityCreditOptions = {},
): Promise<AntigravityBalanceResult> {
  const token = credential.access_token ?? ''
  // ⚠️ 未授权**不是错误**：面板据此显示「尚未授权 Google 账号」。
  if (token === '') return { balance: null, error: ANTIGRAVITY_UNAUTHORIZED_MESSAGE }

  const now = options.now?.() ?? Date.now()
  if (options.force !== true) {
    const cached = cache.get(token)
    if (cached !== undefined && now - cached.at < ANTIGRAVITY_QUOTA_CACHE_TTL_MS) return cached.result
  }

  const result = await requestQuota(credential, options.fetcher ?? fetch)
  cache.set(token, { at: now, result })
  return result
}

/** 真正发一次请求并映射结果（**内部，不抛错**）。 */
async function requestQuota(
  credential: AntigravityCredential,
  fetcher: typeof fetch,
): Promise<AntigravityBalanceResult> {
  const project = credential.cloudaicompanionProject ?? ANTIGRAVITY_DEFAULT_PROJECT
  // ⚠️ 档位与配额**并行**发，且档位失败绝不污染配额结果（`catch` 吞成
  // `undefined`）：面板的「账号规格」是一栏附注，不能因为它挂了就把整行
  // 变成错误 —— 那正是「测试能发请求、配额却报错」那类误报的翻版。
  const [quota, tier] = await Promise.all([
    requestQuotaSummary(credential, fetcher, project),
    requestAccountTier(credential, fetcher).catch(() => undefined),
  ])
  return tier === undefined ? quota : { ...quota, tier }
}

/** 配额本体（`retrieveUserQuotaSummary`）。 */
async function requestQuotaSummary(
  credential: AntigravityCredential,
  fetcher: typeof fetch,
  project: string,
): Promise<AntigravityBalanceResult> {
  let response: Response
  try {
    response = await fetcher(`${ANTIGRAVITY_ENDPOINT_SANDBOX}${ANTIGRAVITY_QUOTA_PATH}`, {
      method: 'POST',
      // ⚠️ 身份头与推理请求**完全一致**（含五个伪装头）；流式才刻意不带 Accept，
      // 配额是普通 JSON 请求，`includeAccept` 保持默认 false 与抓包一致。
      headers: antigravityHeaders(credential),
      // ⚠️ 必须带 `project`（见文件头注释）：空对象 `{}` 对第二个账号会 403。
      body: JSON.stringify({ project }),
      signal: AbortSignal.timeout(ANTIGRAVITY_CREDITS_TIMEOUT_MS),
    })
  } catch (error) {
    return { balance: null, error: `配额查询网络失败：${describe(error)}` }
  }

  const text = await response.text().catch(() => '')
  if (!response.ok) {
    return {
      balance: null,
      // ⚠️ 403 有两种成因，文案不能一概说"凭据已失效"：本账号缺 5 小时窗口时
      // 上游对 `{}` 回 `SUBSCRIPTION_REQUIRED`，凭据其实是好的（用户报障形态）。
      // 这里把上游的 `reason` 透出来，否则面板只会误导人去重新登录。
      error: response.status === 401 || response.status === 403
        ? `配额查询被拒（HTTP ${response.status}）${quotaRejectionHint(text)}`
        : `配额查询失败（HTTP ${response.status}）：${text.slice(0, 200)}`,
    }
  }

  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return { balance: null, error: `配额响应不是 JSON（HTTP ${response.status}）` }
  }

  const { fiveHour, weekly } = parseGeminiQuotaWindows(payload)
  // ⚠️ 两个桶都没认出来 ⇒ `null`（真失败），**不伪造 100%**。
  // 原版此时返回空 `Quota{}`；在插件侧空余额会被面板渲染成「0」，
  // 那比「查询失败」更误导（用户会以为额度用光了）。
  if (fiveHour === undefined && weekly === undefined) {
    return { balance: null, error: '配额响应里没有 Gemini 配额桶' }
  }
  // 顺路把**分组桶**余量存进快照缓存：`model.list` 的同步 `quotaFor` 读它
  // 给模型名后面的「剩 N%」绿标（模型级 remainingFraction 是恒 1/0 的粗快照，
  // 用户 2026-11-01 报障「claude 和 gpt 走另外一个桶，余量也是 100% 吗」）。
  // 同 token 实测：gemini-weekly 99.9% / 3p-weekly 95.8%，两组独立计数。
  rememberGroupBuckets(credential.access_token ?? '', parseGeminiGroupBuckets(payload))
  return { balance: toGeminiCreditBalance(fiveHour, weekly) }
}

/**
 * 账号规格（`loadCodeAssist`）。
 *
 * 请求体是**逐字常量** {@link ANTIGRAVITY_LOAD_CODE_ASSIST_BODY}（对齐原版
 * `project.go:97-103` 的抓包，content-length 恰为 38）—— 不要"顺手"把
 * `cloudaicompanionProject` 塞进去，原版注释明确它不带。
 *
 * 解不出档位就返回 `undefined`（面板不渲染那一行），**不编造**。
 */
async function requestAccountTier(
  credential: AntigravityCredential,
  fetcher: typeof fetch,
): Promise<AntigravityAccountTier | undefined> {
  const response = await fetcher(`${ANTIGRAVITY_ENDPOINT_SANDBOX}${ANTIGRAVITY_LOAD_CODE_ASSIST_PATH}`, {
    method: 'POST',
    headers: antigravityHeaders(credential),
    body: ANTIGRAVITY_LOAD_CODE_ASSIST_BODY,
    signal: AbortSignal.timeout(ANTIGRAVITY_CREDITS_TIMEOUT_MS),
  })
  if (!response.ok) return undefined
  const text = await response.text().catch(() => '')
  if (text === '') return undefined
  try {
    return parseGeminiAccountTier(JSON.parse(text))
  } catch {
    return undefined
  }
}

/** 错误 → 一行可读文案。 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 从 403/401 的响应体里挖出一句能指向真因的话。
 *
 * 上游的错误体是 `{"error":{"status":"PERMISSION_DENIED","details":[{"reason":
 * "SUBSCRIPTION_REQUIRED",…}]}}`。凭据真失效时通常是 `UNAUTHENTICATED` /
 * `invalid_grant`；`SUBSCRIPTION_REQUIRED` 则完全是另一回事（账号形态差异，
 * 不是凭据问题）。挖不出就把正文前 160 字附上，别吞掉现场。
 */
function quotaRejectionHint(text: string): string {
  try {
    const payload: unknown = JSON.parse(text)
    if (typeof payload === 'object' && payload !== null) {
      const error = (payload as Record<string, unknown>).error
      if (typeof error === 'object' && error !== null) {
        const record = error as Record<string, unknown>
        const details = Array.isArray(record.details) ? record.details : []
        const reason = details
          .map((item) => (typeof item === 'object' && item !== null
            ? (item as Record<string, unknown>).reason
            : undefined))
          .find((value): value is string => typeof value === 'string' && value !== '')
        const message = typeof record.message === 'string' ? record.message : ''
        if (reason !== undefined) {
          // `UNSUPPORTED_LOCATION` 是**地区限制**，不是凭据问题也不是额度问题：
          // Google 只允许在支持的国家/地区使用 Antigravity 个人版。
          // 用户报障原话：「配额查询被拒（HTTP 403）（UNSUPPORTED_LOCATION）：
          // Your current account is not eligible … not currently available in your location.」
          // 光把原文抛出来，用户会以为是账号/登录坏了 —— 这里补一条**可操作**的指引：
          // 渠道包的请求走 `network.fetch`，接的是本插件的出口（`pack.apply(..., { outlet })`），
          // 换一个出口地址即可换到支持的地区。
          //
          // ⚠️ 2026-11-02 用户修正文案：旧版写「可在本插件设置页开启『出口代理』」，
          // 但设置页里并没有叫这个名字的页面（实际是「出口代理（订阅分流）」区块），
          // 用户照着找不到入口；且渠道早就不叫 Gemini。现改成直说「请更改出口地址」，
          // 不再指向具体页面。
          const locationHint = reason === 'UNSUPPORTED_LOCATION'
            ? '。Antigravity 个人版在你所在地区不可用，'
              + '不是凭据或额度问题；请更改出口地址'
            : ''
          return `（${reason}）：${message.slice(0, 160)}${locationHint}`
        }
        if (message !== '') return `：${message.slice(0, 160)}`
      }
    }
  } catch {
    // 非 JSON 就走下面的兜底。
  }
  return text === '' ? '' : `：${text.slice(0, 160)}`
}
