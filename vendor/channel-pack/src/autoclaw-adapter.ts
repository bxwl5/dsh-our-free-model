/**
 * AutoClaw LlmAdapter。
 *
 * 对话是标准 OpenAI 兼容（`POST {base}/autoclaw-proxy/proxy/autoclaw/chat/completions`），
 * 故消息序列化与 SSE 解码复用 `src/openai-compat.ts`。
 *
 * ⚠️ 唯一必须记住的差异：**认证头是 `X-Authorization`**（见 autoclaw.ts）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'

import {
  AUTOCLAW,
  AUTOCLAW_MODEL_CONFIG_PATH,
  type AutoClawProduct,
} from './autoclaw-product.js'
import {
  autoClawCatalogHeaders,
  autoClawHeaders,
  chatEndpoint,
  isCredentialUsable,
  parseModelConfig,
  type AutoClawCredential,
  type AutoClawModelRow,
} from './autoclaw.js'
import {
  normalizeAutoClawMaxTokens,
  normalizeAutoClawSystem,
  resolveAutoClawModelRoute,
} from './autoclaw-sms.js'
import {
  consumeOpenAiSse,
  errorDetail,
  errorMessage,
  httpErrorCode,
  isTransportError,
  serializeMessages,
} from './openai-compat.js'
import { providerCatalogVisible } from './account-pool.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'

const FIRST_TOKEN_TIMEOUT_MS = 300_000
const CHUNK_TIMEOUT_MS = 300_000

/** 适配器依赖。 */
export interface AutoClawAdapterOptions {
  product?: AutoClawProduct
  resolveCredential: () => Promise<AutoClawCredential | undefined>
  fetchImpl?: typeof fetch
  accountPool?: {
    disabledModelsFor(provider: string): ReadonlySet<string> | undefined
  } & Parameters<typeof providerCatalogVisible>[0]
}

/** AutoClaw 适配器。 */
/**
 * 远端模型目录缓存有效期（5 分钟），与 `opencode-adapter.ts` 的目录 TTL 同档。
 *
 * 上游改目录不是秒级事件，但也不该等到进程重启；5 分钟既不放大请求量
 * （每渠道每 5 分钟最多 1 次），又能让新上架的模型在一个工作时段内出现。
 */
const REMOTE_MODELS_TTL_MS = 300_000

/** 思考档位的中文名（上游 `reasoningLevel` 的键）。 */
const AUTO_CLAW_EFFORT_NAMES: Readonly<Record<string, string>> = {
  low: '低',
  medium: '中',
  high: '高',
  max: '极高',
  minimal: '最少',
  xhigh: '极高',
}

/**
 * 模型展示名（用户 2026-10-27 指定的格式）。
 *
 * 形态：`名称 · 消耗档 [· 促销]`
 *
 * 例：
 * ```
 * Auto · 低
 * Auto-Fast · 中
 * GLM-5.3 · 高 · 限时半价
 * GLM-5.3-Flash · 低
 * ```
 *
 * ## 两段各自的来源与口径
 *
 * 1. **消耗档**（`creditConsumptionLevel`）：上游只给 `低`/`中`/`高` 三个
 *    中文标签，**没有任何数字倍率**。故原样显示，不换算成 `x0.5`。
 *    AutoClaw 是按量计费，与 Qoder 那种倍率套餐不同。
 * 2. **促销**（`metadata.__pricingPromotion.badge`）：上游给的是**文案**
 *    （实测 `"限时半价"`），不是数字。原样显示，不推断成 `x0.5`
 *    —— `scope` 是 `['autoLegal']`，无法保证等价于「所有场景都 5 折」。
 *
 * ## 「额度用尽」为什么不在名字里
 *
 * 用户 2026-10-27 要求：额度状态改用**红色标签**单独显示（与 ZCode 的
 * 绿色余量标签同一套机制）。故它由 {@link autoClawQuotaLabel} 产出，
 * 经 `model.list` 的 `quota` 字段交给前端渲染。
 *
 * ⚠️ **不显示「剩多少 M」**：上游的积分钱包（`/agent-assetmgr/.../wallets`）
 * 按来源分账（活动奖励 / 每日签到 / 订阅 / 加油包），**没有模型维度**，
 * 拆到每个模型只能是编造。真实的是「用尽 vs 能用」这个二值状态。
 */
export function autoClawDisplayName(model: AutoClawModelRow): string {
  const parts: string[] = [model.name]
  // 1. 消耗档：只显示标签本身（`低`/`中`/`高`）。
  if (model.creditLevel !== undefined && model.creditLevel !== '') parts.push(model.creditLevel)
  // 2. 促销徽标（上游原文）。
  if (model.promotion !== undefined && model.promotion !== '') parts.push(model.promotion)
  return parts.join(' · ')
}

/**
 * 额度状态的**标签文本**（红色框用，用户 2026-10-27 指定）。
 *
 * 上游只给二值（`metadata.forbiddenNotice` 存在即用尽），故只有
 * 「额度用尽」这一种文本；没用到 → `undefined`，前端就不渲染标签。
 */
export function autoClawQuotaLabel(model: AutoClawModelRow): string | undefined {
  return model.quotaExhausted === true ? '额度用尽' : undefined
}

/**
 * 额度用完时的提示文案（放到 `description`，比 name 里塞长句干净）。
 *
 * 上游原文含具体恢复时间（如「24 小时后会进行重置」）与替代建议
 * （「推荐切换至 Auto 模型」），对用户是可执行信息，值得原样透出。
 */
export function autoClawQuotaNotice(model: AutoClawModelRow): string | undefined {
  if (model.quotaExhausted !== true) return undefined
  return model.quotaNotice
}

export class AutoClawAdapter extends LlmAdapter {
  private readonly product: AutoClawProduct
  private readonly fetchImpl: typeof fetch
  private remoteModels: AutoClawModelRow[] | undefined
  /** 上次成功拉取的时刻；配合 REMOTE_MODELS_TTL_MS 判断是否重拉。 */
  private remoteModelsAt = 0
  private loading: Promise<void> | undefined

  constructor(private readonly options: AutoClawAdapterOptions) {
    super()
    this.product = options.product ?? AUTOCLAW
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /** 拉模型目录（路径**不在** proxyPrefix 下）。 */
  private async ensureRemoteModels(): Promise<void> {
    // 带 TTL：成功即永久缓存会让上游改目录后永远跟不上（同 opencode 目录 TTL）。
    if (this.remoteModels !== undefined && Date.now() - this.remoteModelsAt < REMOTE_MODELS_TTL_MS) return
    if (this.loading !== undefined) return this.loading
    this.loading = (async () => {
      try {
        const credential = await this.options.resolveCredential()
        if (!isCredentialUsable(credential)) return
        const response = await this.fetchImpl(`${this.product.apiBase}${AUTOCLAW_MODEL_CONFIG_PATH}`, {
          method: 'GET',
          // ⚠️ 目录端点用标准 Authorization（不是对话的 X-Authorization），见 autoClawCatalogHeaders。
          headers: autoClawCatalogHeaders(this.product, credential),
        })
        if (!response.ok) return
        const rows = parseModelConfig(await response.json().catch(() => undefined))
        if (rows.length > 0) {
          /**
           * ⚠️ **并集**，不是替换：目录接口下发的集合**不完整**
           *（2026-10-26 用户对照官方客户端发现「客户端 4 个、插件 3 个」）。
           * 缺失的 `zai_glm-5.3-flash` 在上游静态表里存在且实测可调用，
           * 只存在于兜底表 —— 直接 `= rows` 会把它吞掉。
           * 远端优先（含其最新 contextWindow 等），兜底补齐缺的 id。
           */
          const seen = new Set(rows.map(row => row.id))
          const missing = this.product.fallbackModels.filter(model => !seen.has(model.id))
          this.remoteModels = [...rows, ...missing.map(model => ({ ...model }))]
          this.remoteModelsAt = Date.now()
        }
      } catch {
        // 兜底表接管。
      } finally {
        this.loading = undefined
      }
    })()
    return this.loading
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    if (this.options.accountPool !== undefined
      && !await providerCatalogVisible(this.options.accountPool, this.product.id)) {
      return []
    }
    await this.ensureRemoteModels()
    const source = this.remoteModels ?? this.product.fallbackModels
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? source
      : source.filter((model) => !disabled.has(model.id))
    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      // 按量计费：名字带「积分·低/中/高」分档标签，不带倍率后缀。
      name: autoClawDisplayName(model),
      // 描述：优先把「额度用完」的具体原因（含恢复时间/替代建议）透出，
      // 没有才用上游的 tooltip（模型能力介绍）。
      ...(() => {
        const notice = autoClawQuotaNotice(model)
        if (notice !== undefined) return { description: notice }
        return model.tooltip === undefined ? {} : { description: model.tooltip }
      })(),
      inputModalities: ['text'],
    }))
  }

  /**
   * 「显示列表」用的完整目录（不套用户黑名单）。
   *
   * `status` RPC 的模型数量统计走这个方法（`index.ts` 的 modelAdapters），
   * 缺了它卡片就显示「—」—— 与其它渠道不一致。
   */
  /**
   * 预热远端目录（供 `provider.status` 这类**异步**入口调用）。
   *
   * 为什么需要：`listAllModels()` 是同步契约（多处依赖它不触发网络），
   * 所以设置页的模型数只能读 `remoteModels ?? fallbackModels`。首次打开设置页时
   * 远端还没拉过，就会显示兜底表的条数（用户报障：设置页 1 条、对话框 3 条）。
   * 这里让异步调用方先等一次远端，再把同一份数据交给同步读取。
   *
   * 失败静默（兜底表接管），与 `ensureRemoteModels` 同语义。
   */
  async warmCatalog(): Promise<void> {
    await this.ensureRemoteModels()
  }

  listAllModels(): readonly { id: string; name: string }[] {
    const source = this.remoteModels ?? this.product.fallbackModels
    return source.map((model) => ({ id: model.id, name: autoClawDisplayName(model) }))
  }

  /**
   * 单个 id 的友好展示名（供 `model.list` 补回被关闭/已失效的模型用）。
   *
   * 远端目录是**并集**（见 `ensureRemoteModels`），兜底表里的老 id 也在其中；
   * 真找不到时才让调用方退回裸 id。
   */
  displayNameFor(modelId: string): string | undefined {
    const source = this.remoteModels ?? this.product.fallbackModels
    const model = source.find((item) => item.id === modelId)
    return model === undefined ? undefined : autoClawDisplayName(model)
  }

  /**
   * 额度状态的红色标签（供 `model.list` 的 `quota` 字段）。
   *
   * 用户 2026-10-27 要求：`额度用尽` 用红色框显示，别拼进模型名。
   * 上游只给二值（`metadata.forbiddenNotice`），故没有「剩余量」可示 ——
   * 积分钱包按来源分账（活动/签到/订阅/加油包），没有模型维度。
   */
  quotaFor(modelId: string): string | undefined {
    const source = this.remoteModels ?? this.product.fallbackModels
    const model = source.find((item) => item.id === modelId)
    return model === undefined ? undefined : autoClawQuotaLabel(model)
  }

  /** AutoClaw 的额度标签恒为「已用尽」语义 → 红色框。 */
  quotaKind(): 'remaining' | 'exhausted' {
    return 'exhausted'
  }

  /**
   * **强制**重新拉取远端目录（「重新获取模型」按钮），绕过 TTL。
   *
   * `ensureRemoteModels()` 在 TTL 内直接返回，用户点按钮时必须让短路条件失效，
   * 否则「点了没反应」。失败还原旧值 —— 拉不到就继续显示上次的目录。
   */
  async refreshCatalog(): Promise<boolean> {
    const previous = this.remoteModels
    const previousAt = this.remoteModelsAt
    this.remoteModelsAt = 0
    await this.ensureRemoteModels()
    const refreshed = this.remoteModelsAt !== 0 && this.remoteModelsAt !== previousAt
      && this.remoteModels !== undefined
    if (!refreshed) {
      this.remoteModels = previous
      this.remoteModelsAt = previousAt
    }
    return refreshed
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    await this.ensureRemoteModels()
    const source = this.remoteModels ?? this.product.fallbackModels
    const entry = source.find((candidate) => candidate.id === model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry === undefined ? model : autoClawDisplayName(entry),
      inputModalities: ['text'],
    }
    if (entry?.contextWindow !== undefined) resolved.context = { contextWindow: entry.contextWindow }
    if (entry?.maxTokens !== undefined && entry.maxTokens > 0) resolved.defaultMaxTokens = entry.maxTokens
    /**
     * 思考档位：来自远端 `reasoningLevel`（实测 `['low','high','max']`）。
     *
     * ⚠️ 之前**完全没有** `reasoning`，所以界面上选不到思考程度
     * （用户 2026-10-26 报障）。AutoClaw 的档位名是英文 id，直接用。
     */
    if (entry?.efforts !== undefined && entry.efforts.length > 0) {
      resolved.reasoning = {
        efforts: entry.efforts.map((id) => ({
          id: ReasoningEffortId(id),
          name: AUTO_CLAW_EFFORT_NAMES[id] ?? id,
        })),
        // 默认取**最高档**（与上游「默认用最强」的语义一致；档位表末项通常最强）。
        defaultEffort: ReasoningEffortId(entry.efforts.includes('high') ? 'high' : entry.efforts[entry.efforts.length - 1]),
      }
    }
    return resolved
  }

  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ model: LlmResolvedModelInfo; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const credential = await this.options.resolveCredential()
    if (!isCredentialUsable(credential)) {
      throw new LlmError(`AutoClaw：没有可用凭据，请先登录 ${this.product.displayName}`, 'MISSING_CREDENTIAL')
    }
    const imageUrls = new Map<string, string>()
    const messages = serializeMessages(options.messages, imageUrls)
    /**
     * system 提示词收集 + 首条必须是 system。
     *
     * 两个来源都要收：`options.system`（显式参数）与 `options.messages` 里
     * role=system 的消息（harness 的透明载体 —— 实测它才是 406 的触发路径：
     * 只处理 options.system 时，走 messages 的 system 原样到达上游，
     * 而它不带 OpenClaw 身份句，被稳定拒成 406）。
     *
     * 上游 `providers/autoclaw/prompt.rs` 的 normalize()：**首条不是 system
     * 就补一条只带身份前缀的 system 消息**，少这一步同样 406。
     */
    const systemTexts: string[] = []
    for (const message of messages) {
      if (message.role !== 'system') continue
      const content = message.content
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map(part => (part !== null && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
              ? (part as { text: string }).text
              : '')).join('')
          : ''
      if (text.trim() !== '') systemTexts.push(text)
    }
    const kept = messages.filter(message => message.role !== 'system')
    if (options.system !== undefined && options.system.trim() !== '') systemTexts.unshift(options.system)
    // 合并成一条 system：上游要求「以身份句开头」，多条 system 时把客户端
    // 提示词依序拼在同一段后面（逐字保留）。
    const merged = systemTexts.join('\n\n')
    const normalizedSystem = normalizeAutoClawSystem(merged)
    kept.unshift({ role: 'system', content: normalizedSystem })
    // 模型路由：上游要「X-Request-Model 头 = 完整路由 ID」+「body.model =
    // 剥前缀后的 ID」，两者不同。原样透传会被上游按未知模型拒（HTTP 400
    // 非法模型）。判据见 autoclaw-sms.ts 的 resolveAutoClawModelRoute。
    const route = resolveAutoClawModelRoute(options.model)
    // ⚠️ 用 `kept`（已重组：首条是带身份前缀的 system），不是 `messages`
    // （serializeMessages 的原始输出，里面可能残留未归一的 system）。
    const body: Record<string, unknown> = { model: route.bodyModelId, messages: kept, stream: true }
    // 上游预校验：小于 10000 的小正整数 max_tokens 会被拒成 406 空响应体
    //（实测 8192 拒、10000 过），故抬到安全下限。
    const maxTokens = normalizeAutoClawMaxTokens(options.maxTokens)
    if (maxTokens !== undefined) body.max_tokens = maxTokens
    if (options.tools !== undefined && options.tools.length > 0) {
      body.tools = options.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }))
    }

    let response: Response
    try {
      response = await this.fetchImpl(chatEndpoint(this.product), {
        method: 'POST',
        headers: {
          ...autoClawHeaders(this.product, credential),
          Accept: 'text/event-stream',
          'X-Request-Model': route.routeModelId,
        },
        body: JSON.stringify(body),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (error) {
      if (options.signal?.aborted === true) throw new LlmError('AutoClaw：请求已取消', 'ABORTED')
      if (isTransportError(error)) throw new LlmError(`AutoClaw：连接失败（${errorMessage(error)}）`, 'TRANSPORT')
      throw new LlmError(`AutoClaw：请求失败（${errorMessage(error)}）`, 'TRANSPORT')
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const detail = errorDetail(text)
      if (response.status === 401 || response.status === 403) {
        throw new LlmError(
          `AutoClaw：凭据无效或已过期（HTTP ${response.status}）${detail === '' ? '' : `：${detail}`}`,
          'AUTH',
          { status: response.status },
        )
      }
      if (response.status === 429) {
        throw new LlmError(`AutoClaw：触发限流（HTTP 429）${detail === '' ? '' : `：${detail}`}`, 'RATE_LIMIT', { status: 429 })
      }
      throw new LlmError(
        `AutoClaw：上游返回 HTTP ${response.status}${detail === '' ? '' : `：${detail}`}`,
        httpErrorCode(response.status),
        { status: response.status },
      )
    }

    yield* consumeOpenAiSse(response, { signal: options.signal }, {
      label: 'autoclaw',
      firstTokenTimeoutMs: FIRST_TOKEN_TIMEOUT_MS,
      chunkTimeoutMs: CHUNK_TIMEOUT_MS,
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    })
  }

  /** 扁平退避策略。 */
  providerRetryPolicy(): {
    retryableCodes: readonly string[]
    maxRetries: number
    initialDelayMs: number
    maxDelayMs: number
    jitterRatio: number
  } {
    return {
      retryableCodes: ['TRANSPORT', 'TIMEOUT', 'SERVER_ERROR'],
      maxRetries: 2,
      initialDelayMs: 800,
      maxDelayMs: 4_000,
      jitterRatio: 0.25,
    }
  }
}

/** 注册到内核。 */
export function registerAutoClawLlm(ctx: Context, options: AutoClawAdapterOptions): AutoClawAdapter {
  const product = options.product ?? AUTOCLAW
  const adapter = new AutoClawAdapter(options)
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
