/**
 * AutoClaw LlmAdapter。
 *
 * 对话是标准 OpenAI 兼容（`POST {base}/autoclaw-proxy/proxy/autoclaw/chat/completions`），
 * 故消息序列化与 SSE 解码复用 `src/openai-compat.ts`。
 *
 * ⚠️ 唯一必须记住的差异：**认证头是 `X-Authorization`**（见 autoclaw.ts）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
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

export class AutoClawAdapter extends LlmAdapter {
  private readonly product: AutoClawProduct
  private readonly fetchImpl: typeof fetch
  private remoteModels: Array<{ id: string; name: string; contextWindow: number; maxTokens?: number }> | undefined
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
      name: model.name,
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
    return source.map((model) => ({ id: model.id, name: model.name }))
  }

  /**
   * 单个 id 的友好展示名（供 `model.list` 补回被关闭/已失效的模型用）。
   *
   * 远端目录是**并集**（见 `ensureRemoteModels`），兜底表里的老 id 也在其中；
   * 真找不到时才让调用方退回裸 id。
   */
  displayNameFor(modelId: string): string | undefined {
    const source = this.remoteModels ?? this.product.fallbackModels
    return source.find((model) => model.id === modelId)?.name
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
      name: entry?.name ?? model,
      inputModalities: ['text'],
    }
    if (entry?.contextWindow !== undefined) resolved.context = { contextWindow: entry.contextWindow }
    if (entry?.maxTokens !== undefined && entry.maxTokens > 0) resolved.defaultMaxTokens = entry.maxTokens
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
