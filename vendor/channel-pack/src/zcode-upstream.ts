/**
 * ZCode 上游 HTTP 客户端（额度 / 签到 / 模型目录）。
 *
 * ## 这一层与其它 provider 的差异
 *
 * 其它 provider 的「额度 / 签到」是各家私有协议；ZCode 这套的**特点**是
 * 同一组请求头要在三处复用，且**鉴权要求按端点不同**（实测）：
 *
 * | 端点 | 需要 `Authorization: Bearer <jwt>` | 需要 `X-Device-Mid` |
 * |---|---|---|
 * | `GET /zcode-plan/billing/balance` | **是**（缺则 401） | **是**（缺则 400 code 3001） |
 * | `GET /zcode-plan/billing/preview` | 否 | 是 |
 * | `POST /api/v1/event/report` | 否 | 是 |
 * | `POST /zcode-plan/billing/claim` | **是** | 是（另需 captcha 头） |
 * | `GET /api/v1/client/configs` | **是** | 是 |
 *
 * ⚠ 这两条都踩过：不带 `Authorization` 查额度得 **401**；
 * 不带 `X-Device-Mid` 得 **400 `{"code":3001,"msg":"parameter error"}`**。
 *
 * ## 签到为什么要「补激活上报」
 *
 * 服务端**不会主动推送**活动。`preview` 的内容依赖**客户端活跃信号**：
 *
 * ```
 * 补 POST /api/v1/event/report {app_launch, app_daily_active} 之前：
 *   preview → {"code":0,"data":{"plans":[]}}          ← 空
 * 补之后：
 *   preview → {"code":0,"data":{"plans":[{plan_id:"zcode-v3-start-plan-trust-…"}]}}
 * ```
 *
 * **⇒ 「每日随机派发」不是随机推送，而是「服务端按活跃信号决定要不要给」。**
 * 所以要领额度必须**先补两条事件**，再查 preview，再 claim。
 */

import type { ZcodeCredential } from './zcode.js'
import { resolveZcodeAppVersion } from './zcode.js'
import { hasZcodeUnusualActivity, parseZcodeBusinessCode } from './zcode-diagnostics.js'
import type { ZcodeRemoteModelLike } from './zcode-product.js'

/** ZCode 平台 origin（官方默认）。 */
export const ZCODE_ORIGIN = 'https://zcode.z.ai'

/** 免费额度通道的 Anthropic 端点。 */
export const ZCODE_PLAN_MESSAGES_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/anthropic/v1/messages`

/**
 * 按通道返回「Messages」端点。
 *
 * ⚠ **积分制（`start-plan`）无论账号是 bigmodel 还是 zai，都走 `zcode.z.ai`**
 * —— 官方分派表（`resources/config/provider/zcode-builtin.json`）的规则 2/5
 * 明确如此，2026-10-03 实测复核。**不要**因为账号是国际版就改域名。
 *
 * ⚠ 订阅制（`coding-plan`）才走 `api.z.ai`（官方规则 0/1，2026-10-03 实测
 * `GET https://api.z.ai/api/anthropic/v1/models` 返回 200 + 11 个模型）。
 */
export function zcodeMessagesUrl(channel: 'start-plan' | 'coding-plan'): string {
  if (channel === 'coding-plan') return 'https://api.z.ai/api/anthropic/v1/messages'
  return ZCODE_PLAN_MESSAGES_URL
}

/** 额度余额端点（**需要 Authorization**）。 */
export const ZCODE_BILLING_BALANCE_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/balance`

/** 可领活动预览端点（**不需要 Authorization**）。 */
export const ZCODE_BILLING_PREVIEW_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/preview`

/** 领取端点（**需要 Authorization + captcha**）。 */
export const ZCODE_BILLING_CLAIM_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/claim`

/** 客户端活跃上报端点（**不需要 Authorization**）。 */
export const ZCODE_EVENT_REPORT_URL = `${ZCODE_ORIGIN}/api/v1/event/report`

/** 客户端配置端点（captcha 配置与模型池都从这里来）。 */
export const ZCODE_CLIENT_CONFIGS_URL = `${ZCODE_ORIGIN}/api/v1/client/configs`

/**
 * 构造 ZCode 的「来源标识」请求头。
 *
 * ⚠ 这些头是官方客户端在真实流量里发的。实测**它们不是 3012 的判据**
 * （判据是请求体里的 system 内容），但它们仍是「像官方客户端」的一部分，
 * 且 `X-Device-Mid` **是硬需求**（缺它 billing 全家桶回 400）。
 */
export function buildZcodeHeaders(
  credential: Pick<ZcodeCredential, 'device_mid' | 'app_version'>,
  options: { authorization?: string; json?: boolean; captcha?: { param: string; region: string } } = {},
): Record<string, string> {
  const appVersion = resolveZcodeAppVersion(credential.app_version)
  const headers: Record<string, string> = {
    'User-Agent': `ZCode/${appVersion}`,
    'HTTP-Referer': ZCODE_ORIGIN,
    'X-ZCode-App-Version': appVersion,
    'X-Release-Channel': 'stable',
    'X-Client-Language': 'zh-CN',
    'X-Client-Timezone': 'Asia/Shanghai',
    'X-Device-Mid': credential.device_mid,
    'X-Platform': 'win32',
    'X-Os-Category': 'windows',
    'anthropic-version': '2023-06-01',
  }
  if (options.json !== false) headers['Content-Type'] = 'application/json'
  if (options.authorization !== undefined) headers['Authorization'] = options.authorization
  if (options.captcha !== undefined) {
    headers['x-aliyun-captcha-verify-param'] = options.captcha.param
    headers['x-aliyun-captcha-verify-region'] = options.captcha.region
  }
  return headers
}

/** 一次额度桶（`balances[]` 的一项）。 */
export interface ZcodeBalanceBucket {
  planId?: string
  /**
   * 该桶属于哪个**权益**（`entitlements[].entitlement_id`）。
   *
   * 有了它才能把「计划里的权益」与「余额桶」一一对上，从而判断
   * **这份活动额度是不是已经以桶的形式下发了**（见
   * {@link zcodeEffectiveActivityGrants}）—— 否则会**重复计算**：
   * 同一份 3 亿既是 `plans[].entitlements[].grant_units`，又出现在
   * `balances[]` 里，两份相加就成了 6 亿。
   */
  entitlementId?: string
  /** 展示名（实测为模型名，如 `GLM-5.3-Flash`）。 */
  showName?: string
  /**
   * ★ **计量单位** —— 上游明确下发，实测为 `"token"`。
   *
   * ⚠ **真实缺陷**（用户报障）：「智谱 plan 给的不是积分是 tokens，
   * 应该显示 `Token: xx.yyM` 这种格式」。
   *
   * 上游 `billing/balance` 的桶里有两个字段直接说明单位：
   * ```json
   * { "meter": "model_usage", "unit_type": "token",
   *   "total_units": 100000000, "used_units": 5460725,
   *   "remaining_units": 94539275 }
   * ```
   * 此前我们把它当泛化的「积分」渲染，于是界面显示 `94539275`（无单位、
   * 且量级看起来像积分），而正确形态是 **`94.54M` tokens**。
   */
  unitType?: string
  /** 计量口径（实测 `model_usage`）。 */
  meter?: string
  totalUnits?: number
  usedUnits?: number
  remainingUnits?: number
  availableUnits?: number
  /** 到期时间（Unix 秒）。 */
  expiresAt?: number
  /**
   * 该桶服务哪些模型（上游 `capabilities`，实测形如 `["model:glm-5.3"]`）。
   *
   * 用户 2026-10-27 要求模型列表显示各自余量：桶与模型的对应关系就在这里，
   * 故必须解析出来（此前整段丢弃，只能靠 `show_name` 猜）。
   */
  capabilities?: readonly string[]
}

/** 余额查询结果。 */
/** `plans[]` 里的一项权益（活动额度的**发放单元**，带生效时间）。 */
export interface ZcodeBalanceEntitlement {
  entitlementId: string
  showName?: string
  unitType?: string
  capabilities?: readonly string[]
  /** 这份权益**能发多少**（实测 `entitlements[].grant_units`）。 */
  grantUnits?: number
  period?: string
  /**
   * 生效时刻（Unix **秒**；缺省或 `0` 表示随计划开始立即生效）。
   *
   * ⚠ 这是本仓库最容易漏掉的一个字段（2026-10-28 用户指出）：领取到的活动额度
   *   **不是立刻可用**的 —— 实测当天领到的 3 亿 `effective_at` 是当晚 23:00，
   *   到点才会真正计入余量。
   */
  effectiveAt?: number
}

/** `billing/balance` 的 `plans[]` 一项（已领取的套餐及其权益）。 */
export interface ZcodeBalancePlan {
  planId: string
  userPlanId?: string
  name?: string
  /** 上游状态，实测 `active`（已过期时上游也可能仍返回，需自行按 `endsAt` 判断）。 */
  status?: string
  startsAt?: number
  /** 到期时刻（Unix **秒**）。 */
  endsAt?: number
  entitlements: readonly ZcodeBalanceEntitlement[]
}

export interface ZcodeBalanceResult {
  /** 是否为「企业版」等不下发额度数字的形态（此时 buckets 为空）。 */
  enterprise?: boolean
  buckets: readonly ZcodeBalanceBucket[]
  /**
   * 已领取的活动套餐（`plans[]`）。
   *
   * ⚠ 必须解析：活动额度有**生效 / 到期**两个时刻，而 `balances[]` 桶只有到期
   * （`expires_at`）。不读 `plans[]` 就既不知道「还没生效」，也不知道
   * 「这份额度本来就是哪一期活动给的」。
   */
  plans: readonly ZcodeBalancePlan[]
  /** 汇总剩余额度（所有桶累加）。 */
  remaining: number
  /** 汇总总量。 */
  total: number
  /** 最早到期时间（Unix 秒），用于展示解禁时刻。 */
  expiresAt?: number
  /** 显示名（首个桶的模型名）。 */
  planName?: string
  /**
   * ★ 可领活动摘要（来自 `billing/preview`）。
   *
   * ⚠ **必需存在的原因**（2026-10-03 实测）：每日赠送的 start-plan 额度
   * **不在 `buckets` 里**，只在 `preview.plans` 里 ——
   * 同一账号 `balances` 返回 0 个桶、`preview` 返回 `…start-plan-trust-1003`。
   * 只读 `buckets` 会让面板显示 0，而用户实际能领 1 亿 tokens。
   *
   * ⚠ 取不到时是**空数组**（不 undefined）：preview 失败属降级，
   * 绝不能让它影响 `remaining`/`total` 本身。
   */
  claimablePlans: ZcodeClaimablePlanSummary[]
}

/** 一次可领活动。 */
export interface ZcodeClaimablePlan {
  planId: string
  priority: number
  name?: string
  /**
   * ★ 本次领取能拿到的**额度数值**（实测自 `plan.entitlements[].grant_units`）。
   *
   * ⚠ 上游**不在** plan 顶层给额度，只在 `entitlements[]` 里。拿不到时
   *   留 undefined —— 此时 `toClaimOutcome` 退回 0（不谎报）。
   */
  grantUnits?: number
  /**
   * ★ 额度单位（`'token'` / 缺省按积分）。
   *
   * ⚠ ZCode 下发 `unit_type: "token"`，**不是**积分 —— 展示必须走
   *   `formatUnits`/`unitLabel`（`plugin-src/client/credits-format.js`）。
   */
  unitType?: string
}

/** 领取结果。 */
export interface ZcodeClaimOutcome {
  planId: string
  /** 上游业务码：`0` 成功、`1003` 已领取（幂等成功）。 */
  code?: number
  ok: boolean
  /** 已领取过（幂等，视为成功）。 */
  alreadyClaimed?: boolean
  httpStatus?: number
  message?: string
}

/**
 * 从数字字段安全取值（上游可能给 `null`）。
 *
 * ⚠⚠ **只认 `number`，不认数字字符串** —— 对**业务码**来说那是个真实缺陷
 * （`{"code":"3012"}` 会被吃成 `undefined`，见 `claimZcodePlan` 里的说明），
 * 现已改用 {@link parseZcodeBusinessCode}。
 *
 * ⚠ 本函数仍用于**额度数值 / priority / 上下文窗口**这些字段：它们若以字符串
 * 下发，会静默退化成 `undefined`（`priority` → 0、`grantUnits` → 不显示额度）。
 * 这属于**既有行为、不在本次改动范围**（改它会牵动 plan 排序与额度展示，
 * 需单独的实发验证），故此处**如实标注限制而不擅自扩大改动**。
 */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * `fetch` 的超时包装（外部输入必须有上限）。
 *
 * ⚠ **必须用调用方传进来的 `fetchImpl`**，不能直接用全局 `fetch`。
 *
 * **真实缺陷**（做 ref 缺口探针时暴露）：早期这里写的是裸 `fetch(...)`，
 * 而所有公开函数都接收 `fetchImpl` 参数**却从不往下传** —— 于是
 * `ZcodeAuth` 注入的桩 fetch 对「额度 / 签到 / captcha 配置」全部无效：
 *   - 单测无法桩住网络（会真的打上游）；
 *   - `fetchImpl` 沦为**死参数**（签名说有、行为上没有）。
 *
 * 症状很隐蔽：`ZcodeAdapter` 的推理路径**自己**用 `this.fetchImpl`，
 * 所以「推理桩得住、额度桩不住」，看起来像是额度接口本身的问题。
 */
async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit & { timeoutMs?: number },
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 查余额。
 *
 * ⚠ **`Authorization` 必需**（缺则 401）；`X-Device-Mid` 也必需
 * （缺则 400 code 3001）。
 *
 * 企业版（`displayMode: "enterprise"`）不下发额度数字、只给外部链接 ——
 * 此时返回 `{enterprise:true, buckets:[]}`，**不要**显示成 0
 * （0 是「已用光」的语义）。
 */
export async function fetchZcodeBalance(
  credential: ZcodeCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<ZcodeBalanceResult | undefined> {
  const response = await fetchWithTimeout(fetchImpl, ZCODE_BILLING_BALANCE_URL, {
    method: 'GET',
    headers: buildZcodeHeaders(credential, { authorization: `Bearer ${credential.zcode_jwt}` }),
  }, 30_000)
  if (!response.ok) return undefined

  let parsed: {
    code?: unknown
    data?: {
      displayMode?: unknown
      balances?: unknown
      plans?: unknown
    }
  }
  try {
    parsed = await response.json() as typeof parsed
  } catch {
    return undefined
  }
  const data = parsed.data
  if (data === undefined) return undefined
  if (typeof data.displayMode === 'string' && data.displayMode === 'enterprise') {
    // ⚠ 企业版**不下发额度数字**，也就没有可领活动 ⇒ 不发 preview 请求。
    return { enterprise: true, buckets: [], plans: [], remaining: 0, total: 0, claimablePlans: [] }
  }

  const rawBuckets = Array.isArray(data.balances) ? data.balances : []
  const buckets: ZcodeBalanceBucket[] = []
  for (const item of rawBuckets) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    buckets.push({
      planId: typeof record.plan_id === 'string' ? record.plan_id : undefined,
      entitlementId: typeof record.entitlement_id === 'string' ? record.entitlement_id : undefined,
      showName: typeof record.show_name === 'string' ? record.show_name : undefined,
      // ⚠ 单位字段必须带上：上游说 `unit_type: "token"`，界面据此显示 M 量级。
      unitType: typeof record.unit_type === 'string' ? record.unit_type : undefined,
      meter: typeof record.meter === 'string' ? record.meter : undefined,
      totalUnits: num(record.total_units),
      usedUnits: num(record.used_units),
      remainingUnits: num(record.remaining_units),
      availableUnits: num(record.available_units),
      expiresAt: num(record.expires_at),
      ...Array.isArray(record.capabilities) ? {
        capabilities: record.capabilities
          .filter((value): value is string => typeof value === 'string' && value !== ''),
      } : {},
    })
  }

  let remaining = 0
  let total = 0
  let expiresAt: number | undefined
  for (const bucket of buckets) {
    // 优先用 available（若给了），否则用 remaining。
    remaining += bucket.availableUnits ?? bucket.remainingUnits ?? 0
    total += bucket.totalUnits ?? 0
    const exp = bucket.expiresAt
    if (exp !== undefined && (expiresAt === undefined || exp < expiresAt)) expiresAt = exp
  }

  return {
    buckets,
    plans: parseBalancePlans(data.plans),
    remaining,
    total,
    expiresAt,
    planName: buckets[0]?.showName,
    claimablePlans: await fetchClaimablePlans(credential, fetchImpl),
  }
}

/** 解析 `balances[].plans`（已领取的套餐 + 权益 + 生效/到期时刻）。 */
function parseBalancePlans(raw: unknown): ZcodeBalancePlan[] {
  if (!Array.isArray(raw)) return []
  const plans: ZcodeBalancePlan[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const planId = typeof record.plan_id === 'string' ? record.plan_id : undefined
    if (planId === undefined || planId === '') continue
    const entitlements: ZcodeBalanceEntitlement[] = []
    for (const entry of Array.isArray(record.entitlements) ? record.entitlements : []) {
      if (typeof entry !== 'object' || entry === null) continue
      const item2 = entry as Record<string, unknown>
      const entitlementId = typeof item2.entitlement_id === 'string' ? item2.entitlement_id : undefined
      if (entitlementId === undefined || entitlementId === '') continue
      entitlements.push({
        entitlementId,
        ...(typeof item2.show_name === 'string' ? { showName: item2.show_name } : {}),
        ...(typeof item2.unit_type === 'string' ? { unitType: item2.unit_type } : {}),
        ...Array.isArray(item2.capabilities) ? {
          capabilities: item2.capabilities
            .filter((value): value is string => typeof value === 'string' && value !== ''),
        } : {},
        ...(num(item2.grant_units) === undefined ? {} : { grantUnits: num(item2.grant_units) }),
        ...(typeof item2.period === 'string' ? { period: item2.period } : {}),
        ...(num(item2.effective_at) === undefined ? {} : { effectiveAt: num(item2.effective_at) }),
      })
    }
    plans.push({
      planId,
      ...(typeof record.user_plan_id === 'string' ? { userPlanId: record.user_plan_id } : {}),
      ...(typeof record.name === 'string' ? { name: record.name } : {}),
      ...(typeof record.status === 'string' ? { status: record.status } : {}),
      ...(num(record.starts_at) === undefined ? {} : { startsAt: num(record.starts_at) }),
      ...(num(record.ends_at) === undefined ? {} : { endsAt: num(record.ends_at) }),
      entitlements,
    })
  }
  return plans
}

/**
 * 一份「**已生效、未过期、且上游还没以余额桶形式下发**」的活动额度。
 *
 * ## 为什么需要这个概念（2026-10-28 用户指出）
 *
 * ZCode 的活动额度有两个跟时间有关的事实：
 *
 * 1. **有效期**：`plans[].ends_at`（到点作废）—— 与余额桶的 `expires_at` 同源；
 * 2. **生效时间**：`plans[].entitlements[].effective_at` —— 领到手 ≠ 立刻可用。
 *    实测当天领到的 3 亿是「现在领、当晚 23:00 生效、次日 09:00 到期」。
 *
 * 所以「当前实际余量」必须**按时刻算**：生效前不算、过期后不算。
 *
 * ## 为什么还要判「有没有桶」
 *
 * 同一份额度会以两种形态出现：`plans[].entitlements[].grant_units`（发放声明）
 * 与 `balances[]` 的桶（真实余量，带 `remaining_units`，用掉会变）。**两者不能相加**，
 * 否则 3 亿会变成 6 亿。故：只要 `balances[]` 里已经出现同一 `entitlement_id`
 * 的桶，就以**桶**为准（它才是扣过的真实余量），这份 grant 不再计入。
 */
export interface ZcodeActivityGrant {
  planId: string
  userPlanId?: string
  entitlementId: string
  planName?: string
  showName?: string
  unitType?: string
  /** 这份额度服务哪些模型（`capabilities` 去掉 `model:` 前缀、小写）。 */
  models: readonly string[]
  /** 本次发放多少（= `grant_units`）。 */
  units: number
  effectiveAtMs: number
  endsAtMs: number
}

/** 把 `capabilities` 归一成模型键（`model:glm-5.3` → `glm-5.3`）。 */
function modelKeysOf(capabilities: readonly string[] | undefined, showName: string | undefined): string[] {
  const keys = new Set<string>()
  for (const capability of capabilities ?? []) {
    const name = String(capability).replace(/^model:/i, '').trim().toLowerCase()
    if (name !== '') keys.add(name)
  }
  if (keys.size === 0 && typeof showName === 'string' && showName.trim() !== '') {
    keys.add(showName.trim().toLowerCase())
  }
  return [...keys]
}

/**
 * 取「此刻已经生效、且还没被余额桶表达」的活动额度。
 *
 * 判定顺序（每一步都不可省）：
 *
 * 1. **计划过期**（`ends_at <= now`）→ 整份跳过（上游可能仍把它标成 `active`，
 *    实测 `zcode-v3-start-plan-0817` 到期后还留在 `plans[]` 里）；
 * 2. **已经下发成桶**（同 `entitlement_id`）→ 跳过，交给桶（真实余量）；
 * 3. **还没生效**（`effective_at > now`）→ 跳过；
 * 4. 否则按 `grant_units` 计入。
 *
 * ⚠ `effective_at` 为 `0`/缺省时按「随计划开始立即生效」处理 ——
 *   实测 `…-0817` 的两份权益就是 `effective_at: 0`。
 */
export function zcodeEffectiveActivityGrants(
  balance: ZcodeBalanceResult,
  nowMs: number = Date.now(),
): ZcodeActivityGrant[] {
  const nowSec = Math.floor(nowMs / 1000)
  /** 余额桶已经表达过的权益（按 id）。 */
  const represented = new Set<string>()
  for (const bucket of balance.buckets) {
    if (typeof bucket.entitlementId === 'string' && bucket.entitlementId !== '') {
      represented.add(bucket.entitlementId)
    }
  }
  const grants: ZcodeActivityGrant[] = []
  for (const plan of balance.plans) {
    if (typeof plan.status === 'string' && plan.status.toLowerCase() !== 'active') continue
    const endsAt = plan.endsAt
    if (endsAt !== undefined && endsAt <= nowSec) continue
    for (const entitlement of plan.entitlements) {
      if (represented.has(entitlement.entitlementId)) continue
      const units = entitlement.grantUnits
      if (typeof units !== 'number' || !Number.isFinite(units) || units <= 0) continue
      const effectiveAt = entitlement.effectiveAt !== undefined && entitlement.effectiveAt > 0
        ? entitlement.effectiveAt
        : (plan.startsAt ?? 0)
      if (effectiveAt > nowSec) continue
      grants.push({
        planId: plan.planId,
        ...(plan.userPlanId === undefined ? {} : { userPlanId: plan.userPlanId }),
        entitlementId: entitlement.entitlementId,
        ...(plan.name === undefined ? {} : { planName: plan.name }),
        ...(entitlement.showName === undefined ? {} : { showName: entitlement.showName }),
        ...(entitlement.unitType === undefined ? {} : { unitType: entitlement.unitType }),
        models: modelKeysOf(entitlement.capabilities, entitlement.showName),
        units,
        effectiveAtMs: effectiveAt * 1000,
        // 计划没有 ends_at 时用「很远」表示（不参与过期判断）。
        endsAtMs: endsAt === undefined ? Number.MAX_SAFE_INTEGER : endsAt * 1000,
      })
    }
  }
  return grants
}

/**
 * 按模型汇总「当前真实余量」（**单个账号**，多账号由调用方相加）。
 *
 * 口径：
 * - `balances[]` 的桶：已过期（`expires_at <= now`）跳过；否则取
 *   `available_units ?? remaining_units`；
 * - 再加上 {@link zcodeEffectiveActivityGrants} 那部分（已生效、未被桶表达）。
 *
 * ⚠ 同一模型出现多个桶时**相加**（不同期的额度可叠加使用）。此前实现取
 *   `Math.max`，在「旧期还剩 5M + 新期 300M」这种真实形态下会**漏掉**其中一份。
 */
export function zcodeRemainingByModel(
  balance: ZcodeBalanceResult,
  nowMs: number = Date.now(),
): Map<string, number> {
  const nowSec = Math.floor(nowMs / 1000)
  const remaining = new Map<string, number>()
  const add = (keys: readonly string[], units: number): void => {
    if (!Number.isFinite(units) || units <= 0) return
    for (const key of keys) remaining.set(key, (remaining.get(key) ?? 0) + units)
  }
  const seenEntitlements = new Set<string>()
  for (const bucket of balance.buckets) {
    if (bucket.expiresAt !== undefined && bucket.expiresAt <= nowSec) continue
    // 同一份权益被上游重复下发时只算一次（防翻倍）。
    if (typeof bucket.entitlementId === 'string' && bucket.entitlementId !== '') {
      if (seenEntitlements.has(bucket.entitlementId)) continue
      seenEntitlements.add(bucket.entitlementId)
    }
    const units = bucket.availableUnits ?? bucket.remainingUnits
    if (typeof units !== 'number') continue
    add(modelKeysOf(bucket.capabilities, bucket.showName), units)
  }
  for (const grant of zcodeEffectiveActivityGrants(balance, nowMs)) {
    add(grant.models, grant.units)
  }
  return remaining
}

/** `ZcodeBalanceResult` 里由 `preview` 带出的可领活动。 */
export interface ZcodeClaimablePlanSummary {
  planId: string
  showName?: string
  amount?: number
}

/**
 * 取「可领活动」摘要（**只读**，不消耗额度）。
 *
 * ## 为什么 balance 要带它（2026-10-03 实测）
 *
 * 同一账号：
 * ```
 * GET /billing/balance  → data.balances = []                          ← 0 个桶
 * GET /billing/preview  → data.plans[0].plan_id = …start-plan-trust-1003
 * ```
 * ⇒ **每日赠送的 start-plan 额度不在 `balances` 桶里**，只在 `plans` 里。
 * 只读 `balances` ⇒ 面板显示 0，而用户实际能领 1 亿 tokens。
 *
 * ⚠ **失败一律降级为空数组**，绝不影响 `balance` 本身 ——
 *   余额是主体，preview 是补充。
 *
 * ⚠ 走**同一个** `preview` 端点与 `fetchZcodeClaimablePlans` 一致；
 *   这里只是不解析成领取结果、只留展示要的三个字段（少一次字段耦合）。
 */
async function fetchClaimablePlans(
  credential: ZcodeCredential,
  fetchImpl: typeof fetch,
): Promise<ZcodeClaimablePlanSummary[]> {
  try {
    const appVersion = resolveZcodeAppVersion(credential.app_version)
    const response = await fetchWithTimeout(
      fetchImpl,
      `${ZCODE_BILLING_PREVIEW_URL}?app_version=${encodeURIComponent(appVersion)}&platform=win32`,
      { method: 'GET', headers: buildZcodeHeaders(credential, { json: false }) },
      15_000,
    )
    if (!response.ok) return []
    const parsed = await response.json() as { data?: { plans?: unknown } }
    const raw = Array.isArray(parsed.data?.plans) ? parsed.data.plans : []
    const out: ZcodeClaimablePlanSummary[] = []
    for (const item of raw as Array<Record<string, unknown>>) {
      if (typeof item !== 'object' || item === null) continue
      const planId = item['plan_id']
      if (typeof planId !== 'string' || planId.length === 0) continue
      out.push({
        planId,
        ...(typeof item['name'] === 'string' ? { showName: item['name'] } : {}),
        ...(typeof item['amount'] === 'number' ? { amount: item['amount'] } : {}),
      })
    }
    return out
  } catch {
    return []
  }
}

/**
 * 补客户端活跃信号。
 *
 * ⚠ **这一步不能省**：不补这两条事件，`preview` 恒为空 `plans: []` ——
 * 于是「今天可领」永远是「没有可领」，用户以为签到坏了。
 *
 * 幂等（服务端按 device_mid + 日期去重），故每次查 preview 前都可以补。
 */
export async function reportZcodeActivation(
  credential: ZcodeCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const appVersion = resolveZcodeAppVersion(credential.app_version)
  for (const event of ['app_launch', 'app_daily_active']) {
    try {
      await fetchWithTimeout(fetchImpl, ZCODE_EVENT_REPORT_URL, {
        method: 'POST',
        headers: buildZcodeHeaders(credential, { json: true }),
        body: JSON.stringify({
          event,
          device_mid: credential.device_mid,
          platform: 'win32',
          app_version: appVersion,
        }),
      }, 20_000)
    } catch {
      // 上报失败不阻塞（下一次调用会再补）。
    }
  }
}

/** 查当前可领的活动。 */
export async function fetchZcodeClaimablePlans(
  credential: ZcodeCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly ZcodeClaimablePlan[]> {
  const appVersion = resolveZcodeAppVersion(credential.app_version)
  const url = `${ZCODE_BILLING_PREVIEW_URL}?app_version=${encodeURIComponent(appVersion)}&platform=win32`
  const response = await fetchWithTimeout(fetchImpl, url, {
    method: 'GET',
    headers: buildZcodeHeaders(credential, { json: false }),
  }, 25_000)
  if (!response.ok) return []
  let parsed: { data?: { plans?: unknown } }
  try {
    parsed = await response.json() as typeof parsed
  } catch {
    return []
  }
  const raw = Array.isArray(parsed.data?.plans) ? parsed.data.plans : []
  const plans: ZcodeClaimablePlan[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    if (typeof record.plan_id !== 'string' || record.plan_id.length === 0) continue
    /**
     * ★ 额度取自 `entitlements[]`（2026-10-03 实测）——
     * plan 顶层**没有**额度字段，只有 `entitlements[0].grant_units`。
     * 不读它 ⇒ `toClaimOutcome` 只能填 0 ⇒ 面板显示「+0 积分」。
     */
    const ents = Array.isArray(record.entitlements)
      ? record.entitlements as Array<Record<string, unknown>>
      : []
    const first = ents[0] ?? {}
    const grantUnits = num(first.grant_units)
    plans.push({
      planId: record.plan_id,
      priority: num(record.priority) ?? 0,
      name: typeof record.name === 'string' ? record.name : undefined,
      ...(grantUnits === undefined ? {} : { grantUnits }),
      ...(typeof first.unit_type === 'string' ? { unitType: first.unit_type } : {}),
    })
  }
  // priority 降序（与官方/第三方实现一致：先领高优先级）。
  plans.sort((a, b) => b.priority - a.priority)
  return plans
}

/**
 * 领取一个 plan。
 *
 * ⚠ **captcha 是一次性的**：每个 plan 都必须**重新 mint** 一个新 param。
 * 复用同一个 param 在索要验证的窗口里会得到 `3007`（captcha 校验失败）；
 * 本路径**每个 plan 都现产一个新的**，不去赌上游这一次校不校验。
 *
 * 业务码语义（桥侧实测记录）：
 *
 * | code | 含义 | 处理 |
 * |---|---|---|
 * | `0` | 成功领取 | ok |
 * | `1003` | **已领取过（幂等，不是错误）** | 视为成功 |
 * | `1001` | plan 不存在 | 失败 |
 * | `1002` | 活动已结束 | 失败 |
 * | `1004` | 不符合条件 | 失败 |
 * | `1005` | 名额用完 | 失败 |
 * | `3007` | captcha 失败（需换新 param） | 失败 |
 * | 401 | 未登录 | 失败 |
 */
export async function claimZcodePlan(
  credential: ZcodeCredential,
  planId: string,
  /**
   * 验证码头。**省略即「不带验证头先试一发」**（2026-10-28 实测）。
   *
   * ## 为什么要允许省略（而不是像旧注释那样说「始终强制」）
   *
   * 旧结论是「claim 端点始终索要 captcha，校验还前置于 plan 校验」。但 2026-10-28
   * 用真凭据复测（`app_version: 3.16.3`）：**不带任何验证头**的 claim 直接回
   * `code:0 / 套餐领取成功 / 300,000,000 token`。也就是说「必然要验证」这件事
   * 至少在 3.16.3 这一档**不成立**了。
   *
   * 这条实测很值钱：验证头要靠浏览器（内部载体或外挂 chromium）产 param，
   * 而在没有浏览器的环境（本仓库的 web/独立服务形态）里那条链根本起不来 ——
   * 旧逻辑下「一键领取」对 ZCode 是**必失败**的。
   *
   * 故调用方的策略改成**先不带验证头试一发，只在上游回 `3007` 时才去产 param**
   * （`zcode-auth.ts` 的 `claimOnePlan`）。既保留上游真要求验证时的旧路径，
   * 又让「上游不要验证」的常态不再付出浏览器代价。
   */
  captcha?: { param: string; region: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ZcodeClaimOutcome> {
  let response: Response
  try {
    response = await fetchWithTimeout(fetchImpl, ZCODE_BILLING_CLAIM_URL, {
      method: 'POST',
      headers: buildZcodeHeaders(credential, {
        authorization: `Bearer ${credential.zcode_jwt}`,
        captcha,
      }),
      body: JSON.stringify({ plan_id: planId }),
    }, 60_000)
  } catch (error) {
    return {
      planId,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }

  /**
   * ★★ 读响应体与解析业务码（真实缺陷，2026-10-05 对抗性审计打出）。
   *
   * ## ① `code` 必须认**纯数字字符串**
   *
   * 原先用 `num(parsed.code)`，而 `num()` **只认 `number`** ⇒ 上游回
   * `{"code":"3012","msg":"request has been blocked due to unusual activity."}`
   * 时 `code` 变成 `undefined`，风控码**整条丢失** —— 用户看到的正是本 issue
   * 要修的那句裸上游串（`…: request has been blocked due to unusual activity.`），
   * 因为该 `msg` 里**不含数字**，连「扫正文」都救不回来。
   * ⇒ 改用 `parseZcodeBusinessCode`（见 `zcode-diagnostics.ts`），
   * 它是全仓库**唯一**的业务码解析口径。
   *
   * ## ② 读体必须被包住（`F4`：此前的「自身不抛」是错的）
   *
   * 原先写成 `await response.text().catch(() => '')` —— 若 `fetch` 返回了
   * **非 Response**（如 `null`，自定义 fetch / 被包装过的实现可能出现），
   * `response.text` 的**属性访问**就同步抛 `TypeError`，`.catch` 根本挂不上
   * ⇒ 整条穿透给调用方。真实 `fetch` 不会回 `null`，故生产影响≈0，
   * 但 `claimDailyWith` 依赖「这里不抛」来配平埋点计数，故仍把它兜住。
   */
  let text = ''
  let code: number | undefined
  let message: string | undefined
  try {
    text = await response.text()
  } catch {
    // 体流中断 / 响应对象异常 ⇒ 按「读不到正文」处理，不让它穿透。
    text = ''
  }
  try {
    const parsed = JSON.parse(text) as { code?: unknown; msg?: unknown; message?: unknown }
    code = parseZcodeBusinessCode(parsed.code)
    message = typeof parsed.msg === 'string' ? parsed.msg
      : typeof parsed.message === 'string' ? parsed.message : undefined
  } catch {
    message = text.slice(0, 200)
  }
  /**
   * ★★ **正文里的风控必须在这里（能看到完整正文的地方）归一成 `code`**
   * （真实缺陷，2026-10-05 审计 N1）。
   *
   * ## 缺陷
   *
   * 上面那条 `message = text.slice(0, 200)` 是为**展示**做的截断，但下游的
   * 判据（`isClaimUnusualActivity`）读的**正是 `message`** ⇒ 当网关正文的
   * 噪声超过 200 字符、而风控短语落在截断点**之后**时，判据看到的是被截掉的串：
   *
   * ```
   * 完整 body 长度=230，hasZcodeUnusualActivity(全body)=true
   * → code=undefined，message 长度=200，含风控短语=false
   * → claimRecognized=false   ← 真风控被降级成通用失败
   * ```
   *
   * 症状**正是本 issue 的原症状**（用户只看到一句看不懂的失败）。
   *
   * ## 修法
   *
   * 判据移到**本层**：这里持有完整 `text`，判得准。命中即把 `code` 归一成
   * `3012`，让下游统一走「有码 ⇒ 只信码」的路径 —— 与
   * `parseZcodeBusinessCode` 同一思路（**在信息最全的地方归一，而不是在
   * 已经丢过信息的下游猜**）。
   *
   * ⚠ **只在 `code` 缺失时兜底**：上游给了权威业务码就绝不覆盖
   *   （`{"code":1005,"msg":"quota 3012 exceeded"}` 必须仍是 1005）。
   * ⚠ 判据是 `hasZcodeUnusualActivity`（**语义短语为主**）——
   *   它本身已排除 `13012` / 限流里的毫秒数等误判形态。
   */
  if (code === undefined && hasZcodeUnusualActivity(text)) {
    code = 3012
  }

  // 1003 = 已领取过 —— **幂等成功，不是错误**。
  const alreadyClaimed = code === 1003
  const ok = response.ok && (code === 0 || alreadyClaimed)
  return {
    planId,
    code,
    ok,
    alreadyClaimed,
    httpStatus: response.status,
    message: message ?? (ok ? undefined : `HTTP ${response.status}`),
  }
}

/**
 * 拉服务端下发的 captcha 配置。
 *
 * ⚠ `platform` 必须是 **`unknown`** —— 实测 `win32` / `win64` / `windows` /
 * `electron` / `desktop` / `linux` 一律 `400 {"code":3001}`。
 * `unknown` 正是官方在非 Electron 上下文的取值。
 *
 * 失败返回 `undefined`，由调用方回退到内置兜底值
 * （{@link ZCODE_CAPTCHA_FALLBACK}）—— **不让配置拉取失败阻塞推理**。
 */
export async function fetchZcodeCaptchaConfig(
  credential: ZcodeCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<{ region: string; prefix: string; sceneId: string } | undefined> {
  const appVersion = resolveZcodeAppVersion(credential.app_version)
  const url = `${ZCODE_CLIENT_CONFIGS_URL}?app_version=${encodeURIComponent(appVersion)}&platform=unknown`
  try {
    const response = await fetchWithTimeout(fetchImpl, url, {
      method: 'GET',
      headers: buildZcodeHeaders(credential, { authorization: `Bearer ${credential.zcode_jwt}`, json: false }),
    }, 20_000)
    if (!response.ok) return undefined
    const parsed = await response.json() as {
      data?: { configs?: { captcha?: { region?: unknown; prefix?: unknown; sceneId?: unknown } } }
    }
    const captcha = parsed.data?.configs?.captcha
    if (captcha === undefined) return undefined
    const region = captcha.region
    const prefix = captcha.prefix
    const sceneId = captcha.sceneId
    if (typeof region !== 'string' || typeof prefix !== 'string' || typeof sceneId !== 'string') {
      return undefined
    }
    return { region, prefix, sceneId }
  } catch {
    return undefined
  }
}

/**
 * 从上游拉**模型目录**（含上下文窗口、最大输出、思考档位、视觉能力）。
 *
 * ## ⚠ 为什么要真拉，不能照抄兜底表
 *
 * **真实缺陷**（用户报障）：模型配置页里上下文窗口显示 **1,000,000**、
 * 最大输出 **128,000**，而思考档位选择器**根本没出现** —— 尽管 ZCode IDE
 * 里可以设置。
 *
 * 兜底表当时填的是 `200_000` / `32_768`（**凭空估的**），且模型都标了
 * `supportsImage: true`（但上游说只有 Flash 有 `capabilities.vision`）。
 * ⇒ 这类「能力字段」必须**抄上游**，不能按「同族应该一样」推断。
 *
 * ## 上游形状（`GET /api/v1/client/configs` 的 `data.builtinModels`）
 *
 * ⚠ `builtinModels` 是**对象**（key 不是模型 id，实测为序号字串），
 * 故必须 `Object.values(...)` 而不是数组下标。实测两条：
 *
 * ```json
 * { "modelId": "GLM-5.3-Flash", "contextWindow": 1000000,
 *   "maxCompletionTokens": 128000,
 *   "capabilities": { "vision": true },
 *   "modalities": { "input": ["text","image","video"], "output": ["text"] },
 *   "reasoning": { "levels": { "low": {...}, "max": {...}, "high": {...} },
 *                  "defaultLevel": "max" } }
 * ```
 *
 * ⚠ `reasoning.levels` 的**键序**就是官方展示顺序（实测 low → max → high
 * 的插入序，但客户端按 `low/high/max` 渲染 —— 故我们**显式排序**为
 * `low → high → max`，与 IDE 截图一致；未知档位排在后面保持原序）。
 *
 * 失败返回 `undefined`，由调用方回退兜底表（**不让目录拉取失败让 provider 不可用**）。
 */
export async function fetchZcodeModels(
  credential: ZcodeCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<ZcodeRemoteModelLike[] | undefined> {
  const appVersion = resolveZcodeAppVersion(credential.app_version)
  const url = `${ZCODE_CLIENT_CONFIGS_URL}?app_version=${encodeURIComponent(appVersion)}&platform=unknown`
  try {
    const response = await fetchWithTimeout(fetchImpl, url, {
      method: 'GET',
      headers: buildZcodeHeaders(credential, { authorization: `Bearer ${credential.zcode_jwt}`, json: false }),
    }, 20_000)
    if (!response.ok) return undefined
    const parsed = await response.json() as { data?: { builtinModels?: unknown } }
    const raw = parsed.data?.builtinModels
    if (typeof raw !== 'object' || raw === null) return undefined
    /**
     * ⚠ `builtinModels` 是**对象**（键为序号）—— 实测：
     * `{"0": {...GLM-5.3}, "1": {...GLM-5.3-Flash}}`。
     * 用 `Array.isArray` 判定会得到「0 个模型」的**假阴性**。
     */
    const entries = Array.isArray(raw) ? raw : Object.values(raw as Record<string, unknown>)
    const models: ZcodeRemoteModelLike[] = []
    for (const item of entries) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      const id = record.modelId ?? record.id
      if (typeof id !== 'string' || id.length === 0) continue
      const contextWindow = num(record.contextWindow)
      const maxCompletionTokens = num(record.maxCompletionTokens ?? record.maxTokens)
      const capabilities = record.capabilities
      const vision = typeof capabilities === 'object' && capabilities !== null
        ? (capabilities as { vision?: unknown }).vision === true
        : false
      /** 档位：按 IDE 的展示序 `low → high → max`，未知档位按原序排后面。 */
      const reasoning = record.reasoning
      let reasoningLevels: string[] | undefined
      let defaultReasoningLevel: string | undefined
      if (typeof reasoning === 'object' && reasoning !== null) {
        const levels = (reasoning as { levels?: unknown }).levels
        if (typeof levels === 'object' && levels !== null) {
          const keys = Object.keys(levels as Record<string, unknown>)
          if (keys.length > 0) reasoningLevels = orderReasoningLevels(keys)
        }
        const def = (reasoning as { defaultLevel?: unknown }).defaultLevel
        if (typeof def === 'string' && def.length > 0) defaultReasoningLevel = def
      }
      models.push({
        id,
        name: typeof record.name === 'string' && record.name.length > 0 ? record.name : id,
        // 缺字段时给保守值（0 会让 DSH 认为无窗口）。
        contextWindow: contextWindow !== undefined && contextWindow > 0 ? contextWindow : 200_000,
        maxTokens: maxCompletionTokens !== undefined && maxCompletionTokens > 0
          ? maxCompletionTokens
          : 32_768,
        supportsImage: vision,
        ...reasoningLevels !== undefined ? { reasoningLevels } : {},
        ...defaultReasoningLevel !== undefined ? { defaultReasoningLevel } : {},
      })
    }
    return models.length > 0 ? models : undefined
  } catch {
    return undefined
  }
}

/**
 * 把档位键排成 IDE 的展示序。
 *
 * ⚠ **不能直接用对象的键序**：上游 JSON 里 `levels` 的插入序实测是
 * `low, max, high`，而 IDE 的档位条显示 `low, high, max`（用户截图为证）。
 * 已知档位按 `low → medium → high → xhigh → max` 排，未知的按原序追加。
 */
function orderReasoningLevels(keys: readonly string[]): string[] {
  const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const known = order.filter((level) => keys.includes(level))
  const unknown = keys.filter((key) => !order.includes(key))
  return [...known, ...unknown]
}
