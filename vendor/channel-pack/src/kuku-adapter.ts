/**
 * KukuAI LlmAdapter。
 *
 * 与 OrcaTerm 同形态（建消息 → SSE），完整对话能力。
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

import { KUKU, type KukuProduct } from './kuku-product.js'
import { isCredentialUsable, type KukuCredential } from './kuku.js'
import { streamChat } from './kuku-auth.js'
import { providerCatalogVisible } from './account-pool.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'

/** 适配器依赖。 */
export interface KukuAdapterOptions {
  product?: KukuProduct
  resolveCredential: () => Promise<KukuCredential | undefined>
  fetchImpl?: typeof fetch
  accountPool?: {
    disabledModelsFor(provider: string): ReadonlySet<string> | undefined
  } & Parameters<typeof providerCatalogVisible>[0]
}

/** KukuAI 适配器。 */
export class KukuAdapter extends LlmAdapter {
  private readonly product: KukuProduct
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: KukuAdapterOptions) {
    super()
    this.product = options.product ?? KUKU
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    if (this.options.accountPool !== undefined
      && !await providerCatalogVisible(this.options.accountPool, this.product.id)) {
      return []
    }
    // 上游没有公开的模型目录端点（模型名由客户端自报），用兜底表。
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? this.product.fallbackModels
      : this.product.fallbackModels.filter((model) => !disabled.has(model.id))
    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      name: model.name,
      inputModalities: ['text'],
    }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const entry = this.product.fallbackModels.find((candidate) => candidate.id === model)
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
      throw new LlmError('KukuAI：没有可用凭据，请先在渠道面板粘贴含 BDUSS 的 Cookie', 'MISSING_CREDENTIAL')
    }
    try {
      for await (const delta of streamChat(this.fetchImpl, this.product, credential, {
        model: options.model,
        messages: options.messages,
        ...(options.system === undefined ? {} : { system: options.system }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })) {
        if (delta.reasoning !== undefined) yield { type: 'reasoning-delta', text: delta.reasoning }
        if (delta.text !== undefined) yield { type: 'text-delta', text: delta.text }
      }
    } catch (error) {
      if (options.signal?.aborted === true) throw new LlmError('KukuAI：请求已取消', 'ABORTED')
      const message = error instanceof Error ? error.message : String(error)
      if (/401|403|BDUSS|凭据/.test(message)) {
        throw new LlmError(`KukuAI：凭据无效或已过期，请重新粘贴 Cookie（${message}）`, 'AUTH')
      }
      throw new LlmError(message, 'TRANSPORT')
    }
    yield { type: 'finish', reason: 'stop' }
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
      retryableCodes: ['TRANSPORT', 'TIMEOUT'],
      maxRetries: 2,
      initialDelayMs: 900,
      maxDelayMs: 4_000,
      jitterRatio: 0.25,
    }
  }
}

/** 注册到内核。 */
export function registerKukuLlm(ctx: Context, options: KukuAdapterOptions): KukuAdapter {
  const product = options.product ?? KUKU
  const adapter = new KukuAdapter(options)
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
