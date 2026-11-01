/**
 * Gemini（Cloud Code Assist）模型适配器。
 *
 * 协议实现（信封构造、SSE 消费）在 `antigravity-messages.ts`，
 * 认证在 `antigravity-auth.ts`，配额在 `antigravity-credits.ts`。
 *
 * ## ⚠️ 本适配器独有的四件事（照 `docs/GEMINI-PORT-PLAN.md` §3.1/§3.2）
 *
 * 1. **两层救场**：先换端点（廉价兜底），再换账号（主救场）。
 *    ⚠️ 端点差异**未获实验支持**（404 / project 两类错误两端点行为完全一致），
 *    换端点零成本无害，但**不能当 quota 的有效解法**。
 * 2. **签名回填 + 去签重试**：`functionCall` 上的 `thoughtSignature` 由
 *    `antigravity-sigstore.ts` 落盘缓存，下一轮按「工具名 + 规范化参数」回填；
 *    上游仍拒签名时**去签重试一次**。
 * 3. **图片两跳**：先 `projectRequestImage`（插件侧缩放，640,000 px），
 *    拿不到才 `readImage`（原图）。两者都拿不到**抛错**，绝不静默丢图。
 * 4. **`toolChoice` 恒 AUTO**：`@deepseek-ai/dsh-llm` 的 `GenerateOptions`
 *    **没有** `toolChoice` 字段（实测 `lib/types/types.d.ts:380-416`），
 *    故不传；`translateGeminiRequest` 内部默认走 `AUTO`。
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { ModelQuota } from './types.js'
import { providerCatalogVisible, type AccountPool } from './account-pool.js'
import { cachedGroupBuckets } from './antigravity-credits.js'
import { collectImages, httpErrorCode } from './openai-compat.js'
import { projectRequestImage } from './image-budget.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'
import { reportLedgerAccount } from './token-ledger.js'
import {
  ANTIGRAVITY,
  ANTIGRAVITY_ENDPOINTS,
  ANTIGRAVITY_IDLE_TIMEOUT_MS,
  ANTIGRAVITY_MAX_IMAGE_BYTES_INLINE,
  ANTIGRAVITY_MAX_REQUEST_BODY_BYTES,
  ANTIGRAVITY_SESSION_LANE_INFER,
  ANTIGRAVITY_STREAM_PATH,
  ANTIGRAVITY_UPSTREAM_FLASH,
  antigravityCanonicalModelId,
  antigravityFallbackEntries,
  antigravityHeaders,
  antigravityModelSpec,
  antigravityReasoningInfo,
  isGeminiExpired,
  marshalAlphabetical,
  matchSegmentSuffix,
  newGeminiRequestId,
  normalizeBase64,
  type AntigravityCredential,
  type AntigravityModelEntry,
  type AntigravityProduct,
  type AntigravityRemoteModelEntry,
} from './antigravity.js'
import { writeModelCatalogClosingNew, restoreModelCatalog } from './model-catalog-cache.js'
import { RemoteCatalogGate } from './remote-catalog-gate.js'
import { consumeGeminiSse, translateGeminiRequest } from './antigravity-messages.js'
import { persistGeminiProject, resolveGeminiProject } from './antigravity-project.js'
import type { AntigravitySigStore } from './antigravity-sigstore.js'

/** 最多换几个账号（含起始账号）。 */
const ANTIGRAVITY_MAX_ROTATE = 3
/** 429 命中后原账号的冷却时长（计划 §3.1）。 */
const ANTIGRAVITY_RATE_LIMIT_COOLDOWN_MS = 60_000
/** 401 命中后原账号的冷却时长（计划 §3.1）。 */
const ANTIGRAVITY_AUTH_COOLDOWN_MS = 300_000

/**
 * 判定「签名被上游拒绝」（原版 `IsSignatureError` 的口径）。
 *
 * ⚠️ 必须**宽**：上游对签名问题的报错文案不统一（`thought_signature`、
 * `Invalid signature`、`signature is required`…），而漏判的后果是
 * 用户看到一次莫名其妙的 400；误判的后果只是多发一次不带签名的请求
 * （那条路径本来就要试）。
 */
export function isGeminiSignatureError(text: string): boolean {
  const lower = text.toLowerCase()
  if (lower.includes('signature')) return true
  return lower.includes('thought') && lower.includes('invalid')
}

/** 400 的正文是否指向配额/权限类问题（决定「先换端点再换账号」）。 */
function isGeminiSwitchableText(text: string): boolean {
  const lower = text.toLowerCase()
  return ['quota', 'permission', 'unsupported', 'project'].some((word) => lower.includes(word))
}

/** 400 的正文是否明确是配额耗尽（归类 `QUOTA_EXCEEDED`）。 */
function isGeminiQuotaText(text: string): boolean {
  const lower = text.toLowerCase()
  return ['quota', 'resource_exhausted', 'resource exhausted', 'rate limit', 'exceeded']
    .some((word) => lower.includes(word))
}

/**
 * 判定「上游的**服务端会话**累计输入超过 1M」。
 *
 * ## 为什么单独成一类
 *
 * 上游按 `sessionId` 在服务端累计对话输入；长工具循环会把累计推过 1M，
 * 此后该 sessionId 的**每个**请求都 400
 * `The input token count exceeds the maximum number of tokens allowed 1048576`，
 * 直到该服务端会话过期。**削本地历史没用**（累计在服务端、按 sessionId 计），
 * 原地重试/换端点也没用 —— 唯一出路是**升代换一个全新 sessionId**。
 *
 * ⚠️ 判据逐字抄自 `Antigravity-Manager` 的 `[FIX session-1M]`
 * （`proxy/handlers/antigravity.rs:983`）：`status == 400 && 正文含
 * "exceeds the maximum number of tokens"`。这是三家唯一给出**具体触发条件**的
 * 实现，且 wb 独立撞上同一现象（`SessionOverflowBump`）。
 *
 * ⚠️ 必须**先于** {@link isGeminiQuotaText} 判定：该文案里的 "exceeds" 不含
 * `isGeminiQuotaText` 的关键词 `"exceeded"`，但真出现 `exceeded` 变体时不能被
 * 误判成「配额耗尽」而触发换号 —— 换号解决不了服务端会话累计。
 */
export function isGeminiSessionOverflow(text: string): boolean {
  return text.toLowerCase().includes('exceeds the maximum number of tokens')
}

/**
 * 一次请求内最多升几代。
 *
 * ⚠️ 必须有界：若上游对**新** sessionId 也回同一条 400（例如真被按账号限死），
 * 无界升代会变成死循环。一代失败后如实透传错误，让用户看到上游原文。
 */
const ANTIGRAVITY_MAX_SESSION_BUMPS = 1

/**
 * Gemini 的上下文超限措辞。
 *
 * 实测报文：
 * ```
 * {"error":{"code":400,"message":"The input token count (1200000) exceeds
 *  the maximum number of tokens allowed (1048576).","status":"INVALID_ARGUMENT"}}
 * ```
 *
 * ⚠️ **harness 的 `isContextWindowExceededError` 认不出这句话** —— 实测其五个
 * 分支里最接近的 `EXCEEDS_MODEL_CONTEXT` 要求 `exceed...` 与 `context` 同时
 * 出现（`\b(?:input|prompt|request)\b.{0,40}\bexceed\b.{0,40}\bcontext\b`），
 * 而这句话里**一个 `context` 都没有**。这与 `buddy-adapter.ts` 当年漏判
 * 「prompt is too long: N tokens > M maximum」是**同一类缺陷**，修法也相同：
 * 本仓库补一条专属判据。
 *
 * ⚠️ 判据要求「token count」+「exceeds the maximum」两个特征同时出现，
 * 避免把别的内容类 400 误判成溢出（宽泛措辞会误判，代价见上）。
 */
const ANTIGRAVITY_TOKEN_COUNT_OVERFLOW =
  /\btoken\s+count\b[\s\S]{0,60}?\bexceeds?\s+the\s+maximum\b/i

/**
 * 判定 400 是否表示**上下文超限**（应归 `CONTEXT_WINDOW_EXCEEDED`）。
 *
 * ## 为什么必须单独判（与 {@link isGeminiSessionOverflow} 是**两条不同的路**）
 *
 * | 情形 | 病因 | 处置 |
 * |---|---|---|
 * | 服务端**按 sessionId 累计**超 1M | 上游会话记账 | **升代**换新 sessionId |
 * | 本地历史把**单次请求**撑过窗口 | 本请求太大 | **压缩上下文**后重发 |
 *
 * 前者升代就够（新会话记账归零）；后者升代**没用** —— 请求体本身还是那么大。
 * 所以两条判据不能互相替代。
 *
 * ⚠️ 上游对这两种情形回的是**同一句话**（都是「input token count exceeds …
 * 1048576」），无法从报文区分。因此实际处置是**升级式**的：
 * 先升代（便宜），升过仍失败就归 `CONTEXT_WINDOW_EXCEEDED` 交给 harness 压缩
 * （贵但能根治）。见 `antigravity-adapter.ts` 里两个判据的**先后顺序**。
 *
 * ## 归错码的代价是**不对称**的
 *
 * `dsh-compaction-basic` 的 request-error listener 第一行是
 * `if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE) return next()` —— 归成
 * `INVALID_REQUEST`（`httpErrorCode` 的 400 兜底）就**连一次压缩的机会都没有**，
 * 长会话越过窗口后每轮都报废、用户只能开新会话。
 * 归成溢出的最坏结果只是一次无效的压缩尝试。方向取「宁可多判一次溢出」。
 *
 * 判定口径与 `buddy-adapter.ts` / `llm-adapter.ts` 的 `httpErrorCode` 一致：
 * 用**完整报文**（不先用 `errorDetail` 归一化 —— 那会丢掉 `extError` /
 * `displayMsg` 等结构化字段，实测会漏判）。
 */
function isGeminiContextOverflow(text: string): boolean {
  return isContextWindowExceededError(text) || ANTIGRAVITY_TOKEN_COUNT_OVERFLOW.test(text)
}

/** {@link AntigravityAdapter} 的构造选项。 */
export interface AntigravityAdapterOptions {
  /** 与登录、续期共用的渠道出网能力。 */
  fetchImpl?: typeof fetch
  /** 单凭据回退 ref（无账号池时）。 */
  credentialRef: CredentialRef
  /** 解析当前可用凭据。 */
  resolveCredential: (modelId?: string) => Promise<AntigravityCredential | undefined>
  /** 凭据失效时的处理（续期或换号，由接线侧决定）。 */
  refresh: () => Promise<void>
  /** 账号池（目录门控、黑名单、限流切号）。 */
  accountPool?: AccountPool
  /**
   * 内联一张图片为**原始字节**（由调用方桥接 `ctx.attachments.readImage`）。
   *
   * ⚠️ 契约与 `buddy-adapter.ts:195` 一致：**读不到必须抛错**，不得返回空。
   * 静默丢图会让用户以为图片被模型看到了（与 cline / lobsterai 同口径）。
   */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string }>
  /**
   * 取**请求版本**图片（附件服务按目标尺寸缩放）。
   *
   * ⚠️ 契约与 `readImage` **相反**：不可用时返回 `undefined`（不是抛错）——
   * 缩放是优化，拿不到就发原图（见 `image-budget.ts:151`）。
   */
  readImageRequest?: (
    attachment: unknown,
    target: { width: number; height: number; maxBytes: number },
  ) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** `thoughtSignature` 缓存（未提供则每轮都不带签名）。 */
  sigStore?: AntigravitySigStore
  /**
   * 覆盖上行会话 id。
   *
   * ⚠️ 缺省**不传**（走内容派生：`project` + 首条 user 文本 + `sessionLane`）。
   * 只有复刻历史抓包/联调才钉固定值 —— 恒定值会让所有对话共用一个会话。
   */
  sessionId?: string
  /**
   * 会话派生标签。推理路径用 {@link ANTIGRAVITY_SESSION_LANE_INFER}（缺省），
   * 冒烟/探测路径用 {@link ANTIGRAVITY_SESSION_LANE_SMOKE}。
   */
  sessionLane?: string
  /**
   * 覆盖信封里的 `project`（缺省**自动探测**，见 `antigravity-project.ts`）。
   *
   * ⚠️ 缺省不是「恒为 `aicode-consumers`」—— 那是探测为空时的兜底。
   * 只有联调/复刻历史抓包才显式钉值。
   */
  project?: string
  /**
   * 项目号探测结果缓存（键 = 凭据身份）。
   *
   * ⚠️ 由接线侧**长期持有并复用**（不要每次调用现造）—— 现造等于没有跨请求缓存，
   * 每轮推理都会多打一次 `loadCodeAssist`。不传则退化为单次请求内缓存。
   */
  projectCache?: Map<string, string>
  /** 探测用的 fetch（测试注入；缺省全局 `fetch`）。 */
  projectFetcher?: typeof fetch
  /**
   * 把探测到的项目号回写凭据（跨启动缓存，best-effort）。
   *
   * ⚠️ 只回写**探测到的真值**，不回写兜底串 —— 理由见 `persistGeminiProject`。
   */
  persistProject?: (value: string) => Promise<void>
  /** 回写失败时的告警出口（可选）。 */
  logger?: { warn(message: string): void; info?(message: string): void }
  /** 产品配置；默认 {@link ANTIGRAVITY}。 */
  product?: AntigravityProduct
  /**
   * **强制**重拉远端模型目录（`fetchAvailableModels`）。
   *
   * 由接线侧提供（`antigravityAuth.fetchAvailableModelsOnly(pool)`）；缺省 = 该部署
   * 不支持远端目录，`loadModels` 退回静态兜底表（与旧形态等价）。
   */
  fetchRemoteModels?: () => Promise<readonly AntigravityRemoteModelEntry[]>
  /** 远端目录冷却闸门（并发去重 + 失败冷却）；测试可注入。 */
  catalogGate?: RemoteCatalogGate
}

/** Gemini（Cloud Code Assist）模型适配器。 */
export class AntigravityAdapter extends LlmAdapter {
  private readonly product: AntigravityProduct
  /** 远端目录（拉到即缓存；undefined = 尚未拉到，用兜底表）。 */
  private remoteModels: readonly AntigravityModelEntry[] | undefined
  /** 目录加载闸门：并发去重 + 失败/空结果冷却（与 minimax 同款）。 */
  private readonly catalogGate: RemoteCatalogGate

  /**
   * 最后已知凭据的 access_token（组桶快照的缓存键）。
   *
   * `quotaFor` 是同步接口、拿不到凭据，故由异步路径（`listModels` /
   * `stream`）顺路记下最近一次解析的 token —— 组桶余量按 token 键缓存在
   * `antigravity-credits.ts`，两处键一致才能读到。空串 = 还没解析过凭据。
   */
  private lastKnownToken = ''

  constructor(private readonly options: AntigravityAdapterOptions) {
    super()
    this.product = options.product ?? ANTIGRAVITY
    this.catalogGate = options.catalogGate ?? new RemoteCatalogGate()
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 模型表：**远端目录优先**（`fetchAvailableModels`，2026-11-01 接入），
   * 拉不到时依次回落「上次成功落盘的快照」→「静态兜底表」。
   *
   * ## 三级回落的依据
   *
   * - 远端缓存与快照都按 minimax-adapter 同款语义：只缓存**真实远端结果**，
   *   兜底表每次现算（纯本地零成本），避免「一次瞬时失败永久钉死兜底表」。
   * - 快照恢复走 `restoreModelCatalog`（与 writeModelCatalogClosingNew 的
   *   新模型自动关闭规则衔接 —— 远端新 id 照样进黑名单，需要用户手动打开）。
   *
   * ⚠️ 远端请求经 {@link RemoteCatalogGate}：并发去重 + 失败/空结果冷却
   * （30s），挡住「每个模型重试一次」的放大。
   */
  private async loadModels(): Promise<readonly AntigravityModelEntry[]> {
    if (this.remoteModels !== undefined) return this.remoteModels
    const fetchRemote = this.options.fetchRemoteModels
    if (fetchRemote !== undefined) {
      await this.catalogGate.run(async () => {
        const fetched = await fetchRemote()
        if (fetched.length === 0) return false
        this.remoteModels = fetched
        // ⚠️ 顺序敏感：迁移**先写**（把 claude/gpt-oss 与合并主模型写成显式
        // 打开/关闭），closingNew **后跑** —— 它只关「黑名单里无显式记录」的
        // 新 id，先写过的就不会被翻转。反过来（closingNew 先写 true）迁移会把
        // 「用户点名要的模型」当成用户显式关闭而不再动（竞态缺陷，本注释即防回归）。
        await this.migrateCatalogOnLoad(this.options.accountPool)
        void writeModelCatalogClosingNew(this.product.id, fetched, this.options.accountPool)
        return true
      })
      if (this.remoteModels !== undefined) return this.remoteModels
    }
    // 远端这次没拉到：用上次成功落盘的快照顶替编译期兜底表（minimax 同款）。
    this.remoteModels = restoreModelCatalog(this.product.id, this.remoteModels)
    if (this.remoteModels !== undefined) return this.remoteModels
    return antigravityFallbackEntries()
  }

  /**
   * **强制**重拉远端目录（「重新获取模型」按钮）。
   *
   * 绕过内存缓存与闸门冷却，直接打远端；失败保留上次目录（返回 false）。
   */
  async refreshCatalog(): Promise<boolean> {
    const fetchRemote = this.options.fetchRemoteModels
    if (fetchRemote === undefined) return false
    try {
      const fetched = await fetchRemote()
      if (fetched.length === 0) return false
      this.remoteModels = fetched
      // 顺序敏感：同 loadModels —— 迁移先写，closingNew 后跑。
      await this.migrateCatalogOnLoad(this.options.accountPool)
      void writeModelCatalogClosingNew(this.product.id, fetched, this.options.accountPool)
      return true
    } catch {
      return false
    }
  }

  /**
   * 单个模型的剩余额度（用户 2026-11-01 要求：模型名后面学 zcode 加剩余%）。
   *
   * ## 数据源优先级（2026-11-01 第二次修正）
   *
   * 1. **分组桶**（`retrieveUserQuotaSummary` 的组桶快照，`cachedGroupBuckets`）
   *    —— 上游按「Gemini 组 / Claude·GPT 组」独立计数（同 token 实测
   *    gemini-weekly 99.9% / 3p-weekly 95.8%），这是**精确值**。模型 → 组：
   *    - `claude-*` / `gpt-oss-*` → 3p 组（桶 `3p-weekly` / `3p-5h`）；
   *    - 其余 `gemini-*` → Gemini 组（`gemini-weekly` / `gemini-5h`）。
   *    同组内 5 小时窗与周窗取**较小**者（两个窗口任一耗尽都不可用）。
   * 2. **模型级 `remainingFraction`**（`fetchAvailableModels` 粗快照）——
   *    实测归一到 1/0 两态（1 = 有余量），只在没有组桶数据时兜底（此时
   *    100% 至少表示「未用尽」，与「不知道」有区别）；0 仍表达「已用尽」红标。
   *
   * 静态兜底表两者都没有 → `undefined`，客户端不渲染标签（不编造 100%）。
   */
  quotaFor(modelId: string): ModelQuota | undefined {
    // ① 组桶精确值（credits.balances 面板刷新时顺路写入的快照）。
    if (this.lastKnownToken !== '') {
      const buckets = cachedGroupBuckets(this.lastKnownToken)
      if (buckets !== undefined) {
        const isThreeP = modelId.startsWith('claude-') || modelId.startsWith('gpt-oss-')
        const windows = isThreeP
          ? [buckets.threePFiveHour, buckets.threePWeekly]
          : [buckets.geminiFiveHour, buckets.geminiWeekly]
        const known = windows.filter((w) => w !== undefined)
        if (known.length > 0) {
          // 任一窗口用尽（fraction=0）→ 红标；否则取最小剩余（最保守）。
          if (known.some((w) => w.remainingFraction <= 0)) return { kind: 'exhausted' }
          const fraction = Math.min(...known.map((w) => w.remainingFraction))
          return { kind: 'remaining', amount: Math.round(fraction * 100), unit: 'percent' }
        }
      }
    }
    // ② 模型级粗快照回落（1 = 有余量 → 100%；0 = 用尽 → 红标）。
    const entry = this.currentModels().find((item) => item.id === modelId)
    const remaining = entry && 'remainingFraction' in entry ? entry.remainingFraction : undefined
    if (typeof remaining !== 'number' || !Number.isFinite(remaining)) return undefined
    if (remaining <= 0) return { kind: 'exhausted' }
    return { kind: 'remaining', amount: Math.round(remaining * 100), unit: 'percent' }
  }

  /**
   * 模型目录**合并迁移**（一次性，幂等）：
   *
   * 1. **分段条目 → 合并条目**：2026-11-01 起 `parseGeminiAvailableModels`
   *    把远端的 `gemini-3.8-flash-{low,medium,high}` 三条合并成
   *    `gemini-3.8-flash` 一条（裸名）。合并后用户在**旧分段条目**上的
   *    开/关状态要搬到合并条目上（任一分段开过 = 打开；全部关 = 关闭），
   *    否则升级后主模型在黑名单无记录 → 被 {@link writeModelCatalogClosingNew}
   *    的「新增默认关闭」规则关掉，对话框里直接消失。
   *    ⚠️ 迭代对象是**合并后的裸名条目**（`this.remoteModels` 是解析产物，
   *    里头已没有分段 id），逐个查 `裸名-{low,medium,high}` 三键的**历史
   *    黑名单记录**——t1 审查实证过反写法（迭代分段 id 再拼裸名）是死代码。
   * 2. **claude/gpt-oss 首次放行**：这两族 id 是本次新增，若走
   *    {@link writeModelCatalogClosingNew} 的「新增自动关闭」规则会被默认
   *    关掉，用户点名要的模型反而看不见 —— 显式打开。
   *
   * ⚠️ 只在**远端目录成功加载后**跑（`loadModels`/`refreshCatalog` 拿到数据时）；
   * 静态兜底表不触发。
   * ⚠️ 调用方必须 **await** 本函数再跑 `writeModelCatalogClosingNew`
   *（顺序契约见 `loadModels` 内注释）。
   * ⚠️ 全 try 包裹：迁移失败不影响目录本身（下次再试）。
   */
  private async migrateCatalogOnLoad(pool: AccountPool | undefined): Promise<void> {
    if (pool === undefined) return
    const models = this.remoteModels
    if (models === undefined || models.length === 0) return
    try {
      const disabled = pool.listDisabledModels(this.product.id)
      const writes: Array<{ id: string; disabled: boolean }> = []

      // ① 分段 → 合并的开关继承（只在合并 id 没有用户显式记录时搬状态）。
      //     黑名单里的旧分段键（目录里已不存在）是**历史记录**，从那里读。
      for (const model of models) {
        if (matchSegmentSuffix(model.id) !== undefined) continue // 分段条目自身不参与（上游回滚形态）
        if (disabled[model.id] === true || disabled[model.id] === false) continue // 用户已显式决定过
        const segments = ['low', 'medium', 'high'].map((segment) => `${model.id}-${segment}`)
        // 黑名单里有旧分段记录才迁移；没有就什么都不动（首次使用）。
        if (!segments.some((id) => disabled[id] === true || disabled[id] === false)) continue
        // 任一分段是显式打开（false）→ 打开；否则（全部关闭）→ 关闭。
        const opened = segments.some((id) => disabled[id] === false)
        writes.push({ id: model.id, disabled: !opened })
      }

      // ② claude / gpt-oss 显式打开（用户点名拉取的模型，不该被默认关闭）。
      for (const model of models) {
        if (!model.id.startsWith('claude-') && !model.id.startsWith('gpt-oss-')) continue
        if (disabled[model.id] === true || disabled[model.id] === false) continue
        writes.push({ id: model.id, disabled: false })
      }

      if (writes.length === 0) return
      for (const { id, disabled: isDisabled } of writes) {
        await pool.setModelDisabled(this.product.id, id, isDisabled)
      }
      this.options.logger?.info?.(
        `[antigravity] 目录合并迁移：${writes.map((w) => `${w.id}→${w.disabled ? '关' : '开'}`).join(', ')}`,
      )
    } catch (error) {
      this.options.logger?.warn?.(`[antigravity] 目录合并迁移失败（不影响目录）: ${String(error)}`)
    }
  }

  /**
   * 当前目录的**同步**读取（不触发远端拉取）。
   *
   * 三级：内存远端缓存 → 落盘快照 → 静态兜底。与 {@link loadModels} 的差别只在
   * 「要不要发请求」—— 供必须同步的消费者用（`listAllModels` / `displayNameFor`，
   * 见 minimax-adapter.ts:218-242 记录的同类约束：写成 async 会让
   * `channel-pack-rpc.ts` 的 `[...all]` / `all.map` 抛 TypeError）。
   */
  private currentModels(): readonly AntigravityModelEntry[] {
    if (this.remoteModels !== undefined) return this.remoteModels
    return restoreModelCatalog(this.product.id, this.remoteModels) ?? antigravityFallbackEntries()
  }

  /**
   * 完整目录（**不套黑名单**），供 Channel Pack「显示列表」用。
   *
   * ⚠️ **必须同步返回数组，不能是 `async`**（`minimax-adapter.ts:218-242`
   * 记录的同类缺陷：写成 async 会让 `channel-pack-rpc.ts:2041 [...all]` 与
   * `:2125 all.map` 抛 `TypeError: all is not iterable`）。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    return this.currentModels().map((model) => ({ id: model.id, name: model.name }))
  }

  /**
   * 单个 id 的友好展示名（供 `model.list` 补回被关闭/已失效的模型用）。
   *
   * 本渠道的目录是本地推导的（没有远端端点），但名字可读 —— 用它避免设置页
   * 把裸 id 当展示名（用户 2026-10-26 报障的同类问题）。
   */
  displayNameFor(modelId: string): string | undefined {
    return this.currentModels().find((model) => model.id === modelId)?.name
  }

  private inputModalitiesFor(
    entry: AntigravityModelEntry | undefined,
  ): readonly ('text' | 'image')[] {
    return entry?.supportsImage === true ? ['text', 'image'] : ['text']
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠️ 无已登录账号时返回 `[]` → DSH 把整个 provider 分组隐藏。
    // **必须返回空数组而不能抛错**（抛错会多一条 provider 报错）。
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return []

    const all = await this.loadModels()
    // 顺路记下「最后已知凭据 token」：`quotaFor` 是**同步**接口读不了凭据
    //（异步会破坏 `listAllModels` 的同步契约），而组桶快照按 token 键存
    //（`cachedGroupBuckets`）。失败吞掉 —— token 只是绿标数据的键，拿不到
    // 就回落模型级粗快照。
    try {
      const credential = await this.options.resolveCredential()
      if (credential?.access_token) this.lastKnownToken = credential.access_token
    } catch { /* 绿标降级，不影响列表 */ }
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? all
      : all.filter((model) => !disabled.has(model.id))

    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      name: model.name,
      inputModalities: this.inputModalitiesFor(model),
    }))
  }

  async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const entry = this.currentModels().find((item) => item.id === model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry?.name ?? model,
      inputModalities: this.inputModalitiesFor(entry),
    }
    // ⚠️ 未知模型不编造 context（宁可让 DSH 用默认值，也不报一个假窗口）
    if (entry !== undefined && entry.contextWindow > 0) {
      resolved.context = { contextWindow: entry.contextWindow }
    }
    // ⚠️ 远端/静态非法值必须过滤：0/负数/NaN 会让 DSH 抛
    // `INVALID_MODEL_MAX_TOKENS`，**整轮对话起不来**（不是降级，是崩）。
    // ⚠️ 先取局部变量再判：`entry.maxTokens` 是可选属性，
    // `Number.isSafeInteger` 不做类型收窄，直接连写会报 TS18048。
    const maxTokens = entry?.maxTokens
    if (maxTokens !== undefined && Number.isSafeInteger(maxTokens) && maxTokens > 0) {
      resolved.defaultMaxTokens = maxTokens
    }
    // ⚠️ 无档位的模型（例如用户手填的未知 id）⇒ `undefined` ⇒ **不声明**
    //（空数组会让面板显示一个点不开的空下拉框）。
    if (entry !== undefined) {
      const reasoning = antigravityReasoningInfo(entry)
      if (reasoning !== undefined) resolved.reasoning = reasoning
    }
    return resolved
  }

  /** 兼容 0.1.1-rc.2 的 `prepareCall` shim（与其余适配器同款）。 */
  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  /** 图片两跳的第一跳（缩放版）；返回 `undefined` 表示「该发原图」。 */
  private async projectImage(
    ref: unknown,
  ): Promise<{ data: Uint8Array; mediaType: string } | undefined> {
    return await projectRequestImage(ref, {
      readImageRequest: this.options.readImageRequest,
      pixelBudget: this.product.imagePixelBudget,
    })
  }

  /**
   * 收集并内联本次请求涉及的全部图片。
   *
   * ⚠️ 两跳都失败时**必须抛错**（`buddy-adapter.ts:1239-1285` 的权威写法）：
   * 静默丢弃会表现为「图片凭空消失、模型答非所问」，是最难排查的一类问题。
   */
  private async collectInlineImages(
    messages: GenerateOptions['messages'],
    entry: AntigravityModelEntry | undefined,
    model: string,
  ): Promise<Map<string, { mediaType: string; data: string }> | undefined> {
    const imageRefs = new Map<string, unknown>()
    for (const message of messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    if (imageRefs.size === 0) return undefined

    // ⚠️ 先判定模型能力：DSH 按适配器播报的 `inputModalities` 决定要不要把
    // 图片投影成文本占位符。声明支持就必须真支持。
    if (entry?.supportsImage !== true) {
      throw new LlmError(
        `antigravity: 模型 "${model}" 不支持图片输入`,
        'UNSUPPORTED_CONTENT',
      )
    }

    const images = new Map<string, { mediaType: string; data: string }>()
    for (const [id, ref] of imageRefs) {
      const projected = await this.projectImage(ref)
      let inline = projected
      if (inline === undefined) {
        const readImage = this.options.readImage
        if (readImage === undefined) {
          throw new LlmError(
            'antigravity: 图片输入需要附件服务（readImage / readImageRequest 均未提供）',
            'UNSUPPORTED_CONTENT',
          )
        }
        try {
          inline = await readImage(ref)
        } catch (error) {
          throw new LlmError(
            'antigravity: 图片附件读取失败；附件服务可能未就绪，或该对象已不存在。',
            'UNSUPPORTED_CONTENT',
            { cause: error },
          )
        }
      }
      if (inline === undefined) {
        throw new LlmError(
          'antigravity: 图片附件读取不到内容；附件服务可能未就绪，或该对象已不存在。',
          'UNSUPPORTED_CONTENT',
        )
      }
      if (inline.data.byteLength > ANTIGRAVITY_MAX_IMAGE_BYTES_INLINE) {
        throw new LlmError(
          `antigravity: 图片体积 ${inline.data.byteLength} 字节超过上游内联上限`
          + ` ${ANTIGRAVITY_MAX_IMAGE_BYTES_INLINE} 字节`,
          'UNSUPPORTED_CONTENT',
        )
      }
      const data = normalizeBase64(Buffer.from(inline.data).toString('base64'))
      if (data === undefined) {
        throw new LlmError('antigravity: 图片编码不是合法 base64', 'UNSUPPORTED_CONTENT')
      }
      images.set(id, { mediaType: inline.mediaType === '' ? 'image/png' : inline.mediaType, data })
    }
    return images
  }

  /**
   * 走 **Cloud Code 流式推理** 发一次请求。
   *
   * 控制流（计划 §3.1 的完整实现）：
   * 1. 签名被拒 → 去签重试一次（同账号同端点）；
   * 2. 403/404、400(quota|permission|unsupported|project) → 先换端点一次；
   * 3. 429 第一次 → 先换端点（廉价尝试），第二次 → 换账号（主救场）；
   * 4. 401 → 先续期一次，续不动 → 换账号；
   * 5. 换账号用**局部可变**的 `currentAccountId`，`tried` 集合跨轮保留；
   * 6. 全部试完 → 抛 `QUOTA_EXCEEDED`（不无限切）。
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // ⚠️ 模型名**先查表再取凭据**：未知 id 立即拒绝（纯本地判定，零网络、
    // 零凭据成本）。放行的后果是上游对未知模型名**静默接受并落回
    // gemini-3.8-flash**（实测假名 200、正常作答 —— 名字根本不参与上游
    // 路由），用户选错模型时拿到的是错误模型的答案且无任何征兆，比报错
    // 难查得多。错误码用 INVALID_REQUEST：不在 harness 可重试集合（不白
    // 退避），也不是 AUTH/QUOTA（不触发换号/续期）。
    // ⚠️ 限流标记 / `account.test` 探测链路传来的是**带档位的名字**
    // （写标记用请求原始 id），先归一化再查表 —— 否则「测一下被限流的
    // 档位」会被误拒（探测功能回归）。
    const entry = this.currentModels().find((item) => item.id === antigravityCanonicalModelId(options.model))
    if (entry === undefined) {
      throw new LlmError(
        `antigravity: 模型 "${options.model}" 不在本 provider 目录中（仅支持 ${ANTIGRAVITY_UPSTREAM_FLASH}）`,
        'INVALID_REQUEST',
        // 模型名写错是确定性失败：带上 404，网关才不会把它当 502 让客户端白重试。
        { status: 404 },
      )
    }

    let credential = await this.options.resolveCredential(options.model)
    if (credential === undefined || isGeminiExpired(credential)) {
      await this.options.refresh()
      credential = await this.options.resolveCredential(options.model)
    }
    if (credential === undefined || credential.access_token === '') {
      throw new LlmError('antigravity: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }
    // 顺路记 token（组桶快照的缓存键，`quotaFor` 同步读它，见字段注释）。
    this.lastKnownToken = credential.access_token

    const requested = options.reasoningEffort === undefined
      ? undefined
      : String(options.reasoningEffort)
    // ⚠️ 档位合法性：与 `antigravityReasoningInfo` 的产出**保持一致**
    //（否则 UI 给了选项、请求却把它丢掉 —— 用户选了「高」而模型按「中」跑）。
    const declared = entry === undefined ? undefined : antigravityReasoningInfo(entry)
    const effort = requested !== undefined
      && declared?.efforts.some((item) => String(item.id) === requested) === true
      ? requested
      : undefined
    const spec = antigravityModelSpec(options.model, effort, options.maxTokens)

    const images = await this.collectInlineImages(options.messages, entry, options.model)

    const sessionLane = this.options.sessionLane ?? ANTIGRAVITY_SESSION_LANE_INFER
    const sigStore = this.options.sigStore
    const pool = this.options.accountPool

    // ⚠️ 起点账号：**局部可变**。不能每次问回调 —— 回调返回的是池的当前
    // 默认账号，换号后不跟着变，会让「换号」变成在两个账号间无限来回。
    let currentAccountId = ''
    if (pool !== undefined && credential.access_token !== '') {
      currentAccountId = await pool
        .findAccountIdByCredential(this.product.id, credential.access_token)
        .catch(() => '')
    }
    // Token 账本（第 2 期）：回报「本笔请求解析出的账号」（空串不回报）。
    if (currentAccountId !== '') reportLedgerAccount(this.product.id, currentAccountId)
    const tried = new Set<string>()
    if (currentAccountId !== '') tried.add(currentAccountId)

    // 项目号缓存：**跨账号共用一份 Map**（键是凭据身份），故放在循环外。
    // 见 `antigravity-project.ts` 的三级缓存。
    const projectCache = this.options.projectCache ?? new Map<string, string>()

    let endpointIdx = 0
    let endpointSwitched = false
    let droppedSignatures = false
    let refreshedOnce = false
    let rotations = 0
    let lastFailure: { status: number; text: string } | undefined
    // 会话升代：按 **base sessionId**（不含代数）计数，只在本请求内有效。
    // 见 `deriveGeminiSessionId` 的 `generation` 段与 `isGeminiSessionOverflow`。
    //
    // ⚠️ base 由信封层算出后**经回调传进来**，这里不自己重算 —— 重算就是
    // 把派生逻辑复制成两份，两处一旦漂移，升代会换错 key（表现为升代无效）。
    const sessionBumps = new Map<string, number>()
    let lastBaseSessionId = ''
    const sessionGeneration = (base: string): number => {
      lastBaseSessionId = base
      return sessionBumps.get(base) ?? 0
    }

    try {
      while (true) {
        // 解析本轮的 project（三级缓存：内存 → 凭据字段 → 现探）。
        //
        // ⚠️ 必须在**循环内**按当前 `credential` 解析：换账号后凭据变了，
        // project 是**按账号**的，用上一个账号的会发错项目号。
        //
        // ⚠️ 探测**失败**（非「探测到空」）⇒ 不发推理。原版实测行为：
        // 注入 500 后原版只在端点间重试 LCA + quota，**不发**
        // `streamGenerateContent`（见 `antigravity-project.ts` 的模块注释）。
        let project = this.options.project
        if (project === undefined) {
          const probe = await resolveGeminiProject({
            credential,
            cache: projectCache,
            ...this.options.projectFetcher === undefined
              ? {}
              : { fetcher: this.options.projectFetcher },
            // ⚠️ 透传调用方信号：否则探测自带的 30s 超时会把更短的调用方超时拖长。
            ...options.signal === undefined ? {} : { signal: options.signal },
          })
          if (probe.error !== undefined) {
            throw new LlmError(
              `antigravity: 项目号探测失败，未发推理（与原版一致）— ${probe.error}`,
              'SERVER',
            )
          }
          project = probe.project
          // 现探到**非兜底**的真值才回写凭据（best-effort，失败不影响推理）。
          // 兜底串不回写：把 `aicode-consumers` 钉进凭据会让该账号将来拿到真实
          // project 时被这个陈旧值挡住（见 `persistGeminiProject`）。
          if (probe.probed === true && this.options.persistProject !== undefined) {
            await persistGeminiProject({
              credential,
              project,
              write: this.options.persistProject,
              ...this.options.logger === undefined ? {} : { logger: this.options.logger },
            })
          }
        }

        // ⚠️ 每轮重新构造信封：`requestId` 每请求随机（原版口径），
        // 且去签重试时 `lookupSignature` 必须换成「返回 undefined」。
        // `sessionId` 由 (project, 首条 user 文本, lane) 确定性派生 —— 同一
        // 对话内稳定（保住上游 prompt cache 命中），不同对话隔离。
        const envelope = translateGeminiRequest({
          modelId: options.model,
          spec,
          messages: options.messages,
          ...options.system === undefined ? {} : { system: options.system },
          ...options.tools === undefined ? {} : { tools: options.tools },
          ...options.temperature === undefined ? {} : { temperature: options.temperature },
          ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
          ...this.options.sessionId === undefined ? {} : { sessionId: this.options.sessionId },
          sessionLane,
          sessionGeneration,
          project,
          requestId: newGeminiRequestId(),
          ...images === undefined ? {} : { images },
          ...droppedSignatures || sigStore === undefined
            ? {}
            : {
              lookupSignature: (name: string, argsJson: string) => {
                // 精确键（工具名 + 逐字参数）优先；miss 时回退到「该工具名最近一次
                // 签名」。参数漂移（路径/时间戳变化）在长任务里是必然事件，没有
                // 这层回退就只能走去签重试，而那条路会把整条思考链丢掉。
                return sigStore.get(name, argsJson) ?? sigStore.latestForTool(name)
              },
            },
        })

        const url = `${ANTIGRAVITY_ENDPOINTS[endpointIdx] ?? ANTIGRAVITY_ENDPOINTS[0]}${ANTIGRAVITY_STREAM_PATH}`
        // ⚠️ 请求体上限必须**发送前**检查：超限时上游要么回一个措辞不稳定的 400，
        // 要么直接断连，两种都比本地判定难查。归类走 `CONTEXT_WINDOW_EXCEEDED`
        // 让 harness 去压缩上下文重试（而不是抛 `INVALID_REQUEST` 这条死路）。
        const wire = marshalAlphabetical(envelope)
        const wireBytes = Buffer.byteLength(wire, 'utf8')
        if (wireBytes > ANTIGRAVITY_MAX_REQUEST_BODY_BYTES) {
          throw new LlmError(
            `antigravity: 请求体 ${wireBytes} 字节超过上限 ${ANTIGRAVITY_MAX_REQUEST_BODY_BYTES} 字节`,
            CONTEXT_WINDOW_EXCEEDED_CODE,
          )
        }
        let response: Response
        try {
          response = await (this.options.fetchImpl ?? fetch)(url, {
            method: 'POST',
            // ⚠️ 流式**刻意不带 `Accept`**（抓包一致，见 `antigravityHeaders`）。
            headers: antigravityHeaders(credential),
            body: wire,
            signal: options.signal,
          })
        } catch (error) {
          // 网络层失败：**如实抛 TRANSPORT**，让 harness 的退避去处理
          // （本适配器不自己重试网络错误 —— 那会与 harness 的退避叠加）。
          if (error instanceof LlmError) throw error
          throw new LlmError(
            `antigravity: 请求发送失败 — ${error instanceof Error ? error.message : String(error)}`,
            'TRANSPORT',
            { cause: error },
          )
        }

        if (response.ok) {
          if (response.body === null) {
            throw new LlmError('antigravity: 响应缺少 body', 'EMPTY_RESPONSE')
          }
          const body = response.body
          try {
            yield* consumeGeminiSse({
              body,
              ...options.signal === undefined ? {} : { signal: options.signal },
              idleTimeoutMs: ANTIGRAVITY_IDLE_TIMEOUT_MS,
              ...sigStore === undefined ? {} : { onSignature: (name, argsJson, sig) => sigStore.put(name, argsJson, sig) },
            })
          } finally {
            // ⚠️ 纯缓存，写失败只记日志（`flush` 内部已兜底）。
            await sigStore?.flush().catch(() => {})
          }
          return
        }

        const text = await response.text().catch(() => '')
        lastFailure = { status: response.status, text }
        const status = response.status

        // 1. 签名被拒 → 去签重试一次（同账号同端点）。
        if (isGeminiSignatureError(text) && !droppedSignatures) {
          droppedSignatures = true
          continue
        }

        // 2. 服务端会话累计超 1M → **升代**换全新 sessionId 重发。
        //
        // ⚠️ 必须排在配额/端点判定**之前**：这条 400 的处置与它们都不同 ——
        // 削本地历史无效（累计在服务端、按 sessionId 计），换端点/换号也无效。
        // 排在后面会被 `endpointFirst`（400 + quota 类文案）先吃掉，白换一次端点。
        //
        // 只在未显式钉 sessionId 时升代：显式钉值意味着调用方要复刻特定会话，
        // 擅自换掉会让它失去意义。
        if (status === 400 && isGeminiSessionOverflow(text) && this.options.sessionId === undefined) {
          const bumped = sessionBumps.get(lastBaseSessionId) ?? 0
          if (bumped < ANTIGRAVITY_MAX_SESSION_BUMPS) {
            sessionBumps.set(lastBaseSessionId, bumped + 1)
            continue
          }
          // 升过代仍报同一条：不再兜圈子，如实透传（见 ANTIGRAVITY_MAX_SESSION_BUMPS）。
        }

        const endpointFirst = status === 403
          || status === 404
          || (status === 400 && isGeminiSwitchableText(text))
        const quotaLike = status === 429 || (status === 400 && isGeminiQuotaText(text))

        // 2.5 上下文超限：**不换端点、不换账号**，直接归 `CONTEXT_WINDOW_EXCEEDED`
        // 交给 harness 压缩。
        //
        // ⚠️ 必须挡在换端点/换号**之前**：请求体本身太大，换端点或换账号都
        // 减小不了它，白跑两轮。而且超限措辞里若出现 `exceeded`（`exceeds` 的
        // 变体），会被 `quotaLike` 吃掉去换号 —— 那是完全无效的动作。
        // 归 `CONTEXT_WINDOW_EXCEEDED` 才能触发 `dsh-compaction-basic` 压缩重试。
        if (status === 400 && isGeminiContextOverflow(text)) {
          throw this.classifyFailure(status, text)
        }

        // 2. 先换端点（廉价兜底，一次）。
        if ((endpointFirst || status === 429) && !endpointSwitched) {
          endpointSwitched = true
          endpointIdx = endpointIdx === 0 ? 1 : 0
          continue
        }

        // 3. 401 → 先续期一次，再考虑换账号。
        if (status === 401 && !refreshedOnce) {
          refreshedOnce = true
          await this.options.refresh().catch(() => {})
          const refreshed = await this.options.resolveCredential(options.model).catch(() => undefined)
          if (refreshed !== undefined && refreshed.access_token !== '') {
            credential = refreshed
            continue
          }
        }

        const rotatable = quotaLike || status === 401 || endpointFirst
        if (rotatable && pool !== undefined) {
          // 记限流/失效冷却：`getAvailableAccount` 会据此跳过该账号。
          if (currentAccountId !== '') {
            const cooldown = status === 401
              ? ANTIGRAVITY_AUTH_COOLDOWN_MS
              : ANTIGRAVITY_RATE_LIMIT_COOLDOWN_MS
            await pool
              .updateModelRateLimit(currentAccountId, options.model, Date.now() + cooldown)
              .catch(() => {})
          }
          if (rotations < ANTIGRAVITY_MAX_ROTATE - 1) {
            const next = await pool.getAvailableAccount(this.product.id, options.model, tried)
            if (next !== null && next !== undefined && !tried.has(next.entry.id)) {
              rotations++
              tried.add(next.entry.id)
              currentAccountId = next.entry.id
              credential = next.credential as unknown as AntigravityCredential
              // 换号后重置端点与去签状态：新账号值得从默认端点、带签名再试一次。
              endpointIdx = 0
              endpointSwitched = false
              droppedSignatures = false
              refreshedOnce = false
              continue
            }
          }
          throw new LlmError(
            `antigravity: 模型 ${options.model} 的所有账号均不可用（限流或额度耗尽），请稍后再试`,
            'QUOTA_EXCEEDED',
            { status },
          )
        }

        // 4. 切完（或没有池）仍失败 → 透传原错误，归类见下。
        throw this.classifyFailure(status, text)
      }
    } finally {
      // 中途异常也要落盘：签名缓存是「下次能命中」的唯一来源。
      await sigStore?.flush().catch(() => {})
      void lastFailure
    }
  }

  /**
   * HTTP 失败 → {@link LlmError}。
   *
   * ⚠️ 归类必须拆细（计划 §3.1）：把 quota 归成 `SERVER` 会让 harness
   * 白重试 5 次（500/1000/2000/4000/8000 ≈ 15.5 秒），而 `QUOTA_EXCEEDED`
   * **不在** `DEFAULT_RETRYABLE_CODES` 里，会立刻把控制权交还用户。
   */
  private classifyFailure(status: number, text: string): LlmError {
    const detail = text === '' ? '' : ` — ${text.slice(0, 500)}`
    const message = `antigravity: HTTP ${status}${detail}`
    // ⚠️ 上下文超限必须**最先**判：`isGeminiQuotaText` 的关键词表里有
    // `exceeded` / `exceeded` 一类的措辞，超限报文很容易被它先吃掉归成
    // `QUOTA_EXCEEDED` —— 而那个码**不触发 compaction**，长会话就此报废。
    // 见 `isGeminiContextOverflow` 的注释（归错码的代价不对称）。
    if (status === 400 && isGeminiContextOverflow(text)) {
      return new LlmError(message, CONTEXT_WINDOW_EXCEEDED_CODE, { status })
    }
    if (status === 400 && isGeminiQuotaText(text)) {
      return new LlmError(message, 'QUOTA_EXCEEDED', { status })
    }
    if (status === 429) return new LlmError(message, 'RATE_LIMIT', { status })
    // ⚠️ 403/404 归 `SERVER`（计划 §3.1 明确），**不**用 `httpErrorCode` 的
    // `AUTH`：这两个码在 Cloud Code 上更多是「入口/模型注册表不认」，
    // 归成 AUTH 会把用户引向「去重新登录」这个无效动作。
    if (status === 403 || status === 404) return new LlmError(message, 'SERVER', { status })
    if (status === 401) return new LlmError(message, 'AUTH', { status })
    return new LlmError(message, httpErrorCode(status), { status })
  }
}

/** 在 `ctx.llm` 上注册 antigravity provider 路由与适配器。 */
export function registerAntigravityLlm(
  ctx: Context,
  options: AntigravityAdapterOptions,
): AntigravityAdapter {
  const product = options.product ?? ANTIGRAVITY
  const adapter = new AntigravityAdapter(options)
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}

/** 供接线侧构造档位 id（避免各处重复 `as ReasoningEffortId`）。 */
export function antigravityEffortId(id: string): ReasoningEffortId {
  return ReasoningEffortId(id)
}
