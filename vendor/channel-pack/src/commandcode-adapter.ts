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
  type CommandCodeProduct,
  type CommandCodeFallbackModel,
} from './commandcode-product.js'
import {
  commandCodeBearerValue,
  isCredentialUsable,
  type CommandCodeCredential,
} from './commandcode.js'
import { fetchModelCatalog } from './commandcode-auth.js'
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
export class CommandCodeAdapter extends LlmAdapter {
  private readonly product: CommandCodeProduct
  private readonly fetchImpl: typeof fetch
  /** 远端模型目录缓存。 */
  private remoteModels: Array<{ id: string; name: string; contextWindow: number; maxTokens?: number; supportsImage?: boolean }> | undefined
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
    if (this.remoteModels !== undefined) return
    if (this.loading !== undefined) return this.loading
    this.loading = (async () => {
      try {
        const credential = await this.options.resolveCredential()
        if (!isCredentialUsable(credential)) return
        this.remoteModels = await fetchModelCatalog(this.fetchImpl, this.product, credential)
      } catch {
        // 静默：兜底表接管。
      } finally {
        this.loading = undefined
      }
    })()
    return this.loading
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠️ 没有已登录账号时返回 `[]`（不能抛错）：DSH 会把空分组隐藏，
    // 而抛错会在界面上多出一条 provider 报错。
    if (this.options.accountPool !== undefined
      && !await providerCatalogVisible(this.options.accountPool, this.product.id)) {
      return []
    }
    await this.ensureRemoteModels()
    const source = this.remoteModels ?? fallbackRows(this.product)
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

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    await this.ensureRemoteModels()
    const source = this.remoteModels ?? fallbackRows(this.product)
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

    const body: Record<string, unknown> = {
      model: options.model,
      messages,
      stream: true,
    }
    // 输出上限：只在本轮确实有值时才下发，避免覆盖模型自身默认。
    if (options.maxTokens !== undefined && options.maxTokens > 0) body.max_tokens = options.maxTokens
    if (options.tools !== undefined && options.tools.length > 0) {
      body.tools = options.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      }))
    }
    if (options.temperature !== undefined) body.temperature = options.temperature

    let response: Response
    try {
      response = await this.fetchImpl(`${this.product.apiBase}${COMMANDCODE_CHAT_PATH}`, {
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
