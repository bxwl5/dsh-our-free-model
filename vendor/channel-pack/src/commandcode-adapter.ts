/**
 * Command Code LlmAdapter。
 *
 * 走 `/provider/v1/chat/completions`（标准 OpenAI 兼容 SSE），
 * 因此消息序列化与流解码全部复用 `src/openai-compat.ts`，
 * 本文件只负责「Command Code 特有的部分」：鉴权、模型目录、错误分类。
 *
 * ## 为什么不重写 SSE 解码
 *
 * `consumeOpenAiSse` 已经处理了三件容易踩的事：`data:` 后无空格、
 * `reasoning_content` 单独成块、`tool_calls` 按 index 合并。重写一遍
 * 只会引入同一批 bug，且失去既有的截断/配对修复。
 *
 * ## 凭据
 *
 * 单个长期 API Key，没有 refresh 流程。401 只能重新登录，
 * 因此 `stream()` 在 401 时直接抛 AUTH，不做重试。
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
  COMMANDCODE,
  COMMANDCODE_CHAT_PATH,
  COMMANDCODE_MESSAGES_PATH,
  requiresAnthropicMessages,
  type CommandCodeProduct,
  type CommandCodeFallbackModel,
} from './commandcode-product.js'
import {
  commandCodeBearerValue,
  isCredentialUsable,
  type CommandCodeCredential,
} from './commandcode.js'
import { fetchModelCatalog } from './commandcode-auth.js'
import { writeModelCatalogClosingNew, restoreModelCatalog } from './model-catalog-cache.js'
import {
  consumeOpenAiSse,
  contentToText,
  errorDetail,
  errorMessage,
  httpErrorCode,
  isTransportError,
  serializeMessages,
} from './openai-compat.js'
import { providerCatalogVisible } from './account-pool.js'
import { consumeAnthropicSse, toAnthropicMessages, toAnthropicTools } from './zcode-anthropic.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'

/** 首 token 空闲超时（毫秒）。 */
const FIRST_TOKEN_TIMEOUT_MS = 300_000
/** chunk 之间的空闲超时（毫秒）。 */
const CHUNK_TIMEOUT_MS = 300_000

/** 适配器依赖。 */
export interface CommandCodeAdapterOptions {
  /** 产品配置（测试可注入不同 apiBase）。 */
  product?: CommandCodeProduct
  /** 凭据解析器：返回当前可用凭据（账号池轮转由上层负责）。 */
  resolveCredential: () => Promise<CommandCodeCredential | undefined>
  /** fetch 实现（测试注入）。 */
  fetchImpl?: typeof fetch
  /** 账号池（用于「没有已登录账号时返回空目录」）。 */
  accountPool?: {
    disabledModelsFor(provider: string): ReadonlySet<string> | undefined
  } & Parameters<typeof providerCatalogVisible>[0]
  /** 单次输出上限兜底（模型目录未声明时）。 */
  fallbackMaxTokens?: number
}

/** 兜底目录 → 统一模型条目。 */
function fallbackRows(product: CommandCodeProduct): CommandCodeFallbackModel[] {
  return [...product.fallbackModels]
}

/**
 * Command Code 适配器。
 */
/**
 * 远端模型目录缓存有效期（5 分钟），与 `opencode-adapter.ts` 的目录 TTL 同档。
 *
 * 上游改目录不是秒级事件，但也不该等到进程重启；5 分钟既不放大请求量
 * （每渠道每 5 分钟最多 1 次），又能让新上架的模型在一个工作时段内出现。
 */
const REMOTE_MODELS_TTL_MS = 300_000

export class CommandCodeAdapter extends LlmAdapter {
  private readonly product: CommandCodeProduct
  private readonly fetchImpl: typeof fetch
  /** 远端模型目录缓存。 */
  private remoteModels: Array<{ id: string; name: string; contextWindow: number; maxTokens?: number; supportsImage?: boolean }> | undefined
  /** 上次成功拉取的时刻；配合 REMOTE_MODELS_TTL_MS 判断是否重拉。 */
  private remoteModelsAt = 0
  /** 正在进行中的目录加载（并发去重）。 */
  private loading: Promise<void> | undefined

  constructor(private readonly options: CommandCodeAdapterOptions) {
    super()
    this.product = options.product ?? COMMANDCODE
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  providerInfo(provider: string): LlmProviderInfo {
    // 防御性归一化：DSH 会校验 info.id === provider，且模型设置页会
    // 用该 id 计算 key ref（内部 toUpperCase()）。provider 非字符串时回退。
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /** 模型接受的输入模态。无结论时保守报 text。 */
  private inputModalitiesFor(modelId: string): readonly string[] {
    const entry = this.remoteModels?.find((candidate) => candidate.id === modelId)
      ?? this.product.fallbackModels.find((candidate) => candidate.id === modelId)
    return entry?.supportsImage === true ? ['text', 'image'] : ['text']
  }

  /**
   * 确保远端目录已加载。
   *
   * 失败不抛错：目录是**建议性**的，拿不到就用兜底表，
   * 不该让整轮对话因为一次目录请求失败而无法开始。
   */
  private async ensureRemoteModels(): Promise<void> {
    // 带 TTL：成功即永久缓存会让上游改目录后永远跟不上（同 opencode 目录 TTL）。
    if (this.remoteModels !== undefined && Date.now() - this.remoteModelsAt < REMOTE_MODELS_TTL_MS) return
    if (this.loading !== undefined) return this.loading
    this.loading = (async () => {
      try {
        const credential = await this.options.resolveCredential()
        if (!isCredentialUsable(credential)) return
        this.remoteModels = await fetchModelCatalog(this.fetchImpl, this.product, credential)
        this.remoteModelsAt = Date.now()
        void writeModelCatalogClosingNew(this.product.id, this.remoteModels, this.options.accountPool)
      } catch {
        // 静默：兜底表接管。
      } finally {
        this.loading = undefined
      }
    })()
    await this.loading
    // 远端这次没拉到：用上次成功落盘的快照顶替编译期兜底表（用户 2026-10-27）。
    this.remoteModels = restoreModelCatalog(this.product.id, this.remoteModels)
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠️ 没有已登录账号时返回 `[]`（不能抛错）：DSH 会把空分组隐藏，
    // 而抛错会在界面上多出一条 provider 报错。
    if (this.options.accountPool !== undefined
      && !await providerCatalogVisible(this.options.accountPool, this.product.id)) {
      return []
    }
    await this.ensureRemoteModels()
    const source = restoreModelCatalog(this.product.id, this.remoteModels) ?? fallbackRows(this.product)
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? source
      : source.filter((model) => !disabled.has(model.id))
    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      name: model.name,
      inputModalities: this.inputModalitiesFor(model.id),
    }))
  }

  /** 「显示列表」用的完整目录（不套用户黑名单）；缺了它卡片模型数显示「—」。 */
  listAllModels(): readonly { id: string; name: string }[] {
    const source = restoreModelCatalog(this.product.id, this.remoteModels) ?? fallbackRows(this.product)
    return source.map((model) => ({ id: model.id, name: model.name }))
  }

  /**
   * 单个 id 的友好展示名（供 `model.list` 补回被关闭/已失效的模型用）。
   *
   * 没有它，被关闭的历史 id 只能以裸内部编码出现在界面上 —— 用户 2026-10-26
   * 报障的「模型列表出现 qmodel 等字段」正是这一类。
   */
  displayNameFor(modelId: string): string | undefined {
    const source = restoreModelCatalog(this.product.id, this.remoteModels) ?? fallbackRows(this.product)
    return source.find((model) => model.id === modelId)?.name
  }

  /**
   * **强制**重新拉取远端目录（「重新获取模型」按钮），绕过 TTL。
   *
   * `ensureRemoteModels()` 在 TTL 内直接返回，必须让短路条件失效，否则按钮
   * 点了没反应。失败还原旧值，保证「拉不到就显示上次的目录」。
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
    const source = restoreModelCatalog(this.product.id, this.remoteModels) ?? fallbackRows(this.product)
    const entry = source.find((candidate) => candidate.id === model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry?.name ?? model,
      inputModalities: this.inputModalitiesFor(model),
    }
    if (entry?.contextWindow !== undefined) resolved.context = { contextWindow: entry.contextWindow }
    // 必须声明 defaultMaxTokens，否则 DSH 只在调用方显式给值时才下发
    // max_tokens，上限永久退回网关默认值。
    const maxTokens = entry?.maxTokens ?? this.options.fallbackMaxTokens
    if (maxTokens !== undefined && maxTokens > 0) resolved.defaultMaxTokens = maxTokens
    return resolved
  }

  /**
   * 兼容 0.1.1-rc.2：新版 LlmRuntime 会调 prepareCall，
   * 基类尚未提供时缺少会抛 `prepareCall is not a function`。
   */
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
      throw new LlmError('commandcode: 没有可用凭据，请先登录', 'MISSING_CREDENTIAL')
    }

    // 消息序列化复用 openai-compat（含工具配对修复与图片收集）。
    const imageUrls = new Map<string, string>()
    const messages = serializeMessages(options.messages, imageUrls)
    if (options.system !== undefined && options.system.length > 0) {
      messages.unshift({ role: 'system', content: options.system })
    }

    /**
     * Claude 系列必须走 Anthropic Messages 形状的端点。
     *
     * 实测（2026-10-25）：把 `claude-sonnet-5-5` 发到 OpenAI 兼容的
     * `/provider/v1/chat/completions`，上游直接 400：
     * `Model "claude-sonnet-5-5" must be called via /provider/v1/messages
     * (Anthropic Messages shape).` 故按模型家族分派两条端点。
     */
    const anthropic = requiresAnthropicMessages(options.model)
    const body: Record<string, unknown> = anthropic
      ? {
          model: options.model,
          max_tokens: options.maxTokens !== undefined && options.maxTokens > 0 ? options.maxTokens : 8192,
          messages: toAnthropicMessages(messages),
          stream: true,
          ...(options.system !== undefined && options.system.length > 0 ? { system: options.system } : {}),
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
          ...(options.tools === undefined || options.tools.length === 0 ? {} : { tools: toAnthropicTools(options.tools) }),
        }
      : {
          model: options.model,
          messages,
          stream: true,
        }
    // 输出上限：只在本轮确实有值时才下发，避免覆盖模型自身默认。
    // Anthropic 分支已在构造时处理（它的 tools 形态也不同，不能复用这段）。
    if (!anthropic) {
      if (options.maxTokens !== undefined && options.maxTokens > 0) body.max_tokens = options.maxTokens
      if (options.tools !== undefined && options.tools.length > 0) {
        body.tools = options.tools.map((tool) => ({
          type: 'function',
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        }))
      }
      if (options.temperature !== undefined) body.temperature = options.temperature
    }

    let response: Response
    try {
      response = await this.fetchImpl(`${this.product.apiBase}${anthropic ? COMMANDCODE_MESSAGES_PATH : COMMANDCODE_CHAT_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...this.product.clientHeaders,
          Authorization: commandCodeBearerValue(credential),
        },
        body: JSON.stringify(body),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (error) {
      if (options.signal?.aborted === true) throw new LlmError('commandcode: 请求已取消', 'ABORTED')
      if (isTransportError(error)) throw new LlmError(`commandcode: 连接失败（${errorMessage(error)}）`, 'TRANSPORT')
      throw new LlmError(`commandcode: 请求失败（${errorMessage(error)}）`, 'TRANSPORT')
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const detail = errorDetail(text)
      // 401 = Key 失效，只能重新登录，不做重试。
      if (response.status === 401) {
        throw new LlmError(
          `commandcode: API Key 无效或已撤销（HTTP 401）${detail === '' ? '' : `：${detail}`}`,
          'AUTH',
          { status: 401 },
        )
      }
      if (response.status === 429) {
        throw new LlmError(
          `commandcode: 触发限流（HTTP 429）${detail === '' ? '' : `：${detail}`}`,
          'RATE_LIMIT',
          { status: 429 },
        )
      }
      throw new LlmError(
        `commandcode: 上游返回 HTTP ${response.status}${detail === '' ? '' : `：${detail}`}`,
        httpErrorCode(response.status),
        { status: response.status },
      )
    }

    // 两种端点的事件格式不同：OpenAI 兼容是 `data: {...}` 的 choices 增量，
    // Anthropic 是 `event: content_block_delta` 等命名事件。解析器不能混用。
    if (anthropic) {
      if (response.body === null) throw new LlmError('commandcode: 上游未返回响应流', 'EMPTY_RESPONSE')
      yield* consumeAnthropicSse(response.body, {
        label: 'commandcode',
        model: options.model,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        idleTimeoutMs: CHUNK_TIMEOUT_MS,
      })
      return
    }
    yield* consumeOpenAiSse(response, { signal: options.signal }, {
      label: 'commandcode',
      firstTokenTimeoutMs: FIRST_TOKEN_TIMEOUT_MS,
      chunkTimeoutMs: CHUNK_TIMEOUT_MS,
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    })
  }

  /**
   * 交给内核的退避策略。
   *
   * ⚠️ 必须是**扁平**字段：内核的退避调度器读的是顶层的
   * initialDelayMs / maxDelayMs / jitterRatio，嵌套进 backoff:{} 会读到
   * undefined，于是 undefined * 2ⁿ = NaN，持久会话日志直接拒绝非有限数值。
   */
  providerRetryPolicy(): {
    retryableCodes: readonly string[]
    maxRetries: number
    initialDelayMs: number
    maxDelayMs: number
    jitterRatio: number
  } {
    return {
      // AUTH 不在列：Key 失效重试多少次都是 401。
      // 429 不在列：同一轮重试只会继续撞墙。
      retryableCodes: ['TRANSPORT', 'TIMEOUT', 'SERVER_ERROR'],
      maxRetries: 2,
      initialDelayMs: 800,
      maxDelayMs: 4_000,
      jitterRatio: 0.25,
    }
  }
}

/**
 * 把 Command Code 注册到内核的 llm 服务。
 *
 * 返回适配器实例：Channel Pack 的「显示列表」需要直接持有引用
 * （`ctx.llm` 不透传自定义方法）。
 */
export function registerCommandCodeLlm(ctx: Context, options: CommandCodeAdapterOptions): CommandCodeAdapter {
  const product = options.product ?? COMMANDCODE
  const adapter = new CommandCodeAdapter(options)
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
