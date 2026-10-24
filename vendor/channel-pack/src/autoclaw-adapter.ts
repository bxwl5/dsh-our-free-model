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
  autoClawHeaders,
  chatEndpoint,
  isCredentialUsable,
  parseModelConfig,
  type AutoClawCredential,
} from './autoclaw.js'
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
export class AutoClawAdapter extends LlmAdapter {
  private readonly product: AutoClawProduct
  private readonly fetchImpl: typeof fetch
  private remoteModels: Array<{ id: string; name: string; contextWindow: number; maxTokens?: number }> | undefined
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
    if (this.remoteModels !== undefined) return
    if (this.loading !== undefined) return this.loading
    this.loading = (async () => {
      try {
        const credential = await this.options.resolveCredential()
        if (!isCredentialUsable(credential)) return
        const response = await this.fetchImpl(`${this.product.apiBase}${AUTOCLAW_MODEL_CONFIG_PATH}`, {
          method: 'GET',
          headers: autoClawHeaders(this.product, credential),
        })
        if (!response.ok) return
        const rows = parseModelConfig(await response.json().catch(() => undefined))
        if (rows.length > 0) this.remoteModels = rows
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
  listAllModels(): readonly { id: string; name: string }[] {
    const source = this.remoteModels ?? this.product.fallbackModels
    return source.map((model) => ({ id: model.id, name: model.name }))
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
    if (options.system !== undefined && options.system.length > 0) {
      messages.unshift({ role: 'system', content: options.system })
    }
    const body: Record<string, unknown> = { model: options.model, messages, stream: true }
    if (options.maxTokens !== undefined && options.maxTokens > 0) body.max_tokens = options.maxTokens
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
        headers: { ...autoClawHeaders(this.product, credential), Accept: 'text/event-stream' },
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
