/**
 * OrcaTerm LlmAdapter。
 *
 * 与 MonkeyCode 的关键差别：**对话可以完整实现**。
 * OrcaTerm 是「建会话 → SSE」，协议明确（Agent2API 有 curl 直连实测记录），
 * 不需要 WebSocket，也不需要手写帧解码。
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

import { ORCATERM, type OrcaTermProduct } from './orcaterm-product.js'
import { isCredentialUsable, type OrcaTermCredential } from './orcaterm.js'
import { streamChat } from './orcaterm-auth.js'
import { providerCatalogVisible } from './account-pool.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'

/** 适配器依赖。 */
export interface OrcaTermAdapterOptions {
  /** 产品配置（测试可注入不同 lightaiBase）。 */
  product?: OrcaTermProduct
  /** 凭据解析器。 */
  resolveCredential: () => Promise<OrcaTermCredential | undefined>
  /** fetch 实现（测试注入）。 */
  fetchImpl?: typeof fetch
  /** 账号池。 */
  accountPool?: {
    disabledModelsFor(provider: string): ReadonlySet<string> | undefined
  } & Parameters<typeof providerCatalogVisible>[0]
}

/** OrcaTerm 适配器。 */
export class OrcaTermAdapter extends LlmAdapter {
  private readonly product: OrcaTermProduct
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: OrcaTermAdapterOptions) {
    super()
    this.product = options.product ?? ORCATERM
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
    // 上游没有公开的模型目录端点（模型由控制台下发，且请求体只带 model 名），
    // 故用兜底表。这不是偷懒：拿不到目录时给一张已知可用的表，比返回空
    // 让用户以为渠道没配好更诚实。
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

  /**
   * 流式对话。
   *
   * 把上游的 `content` / `reasoningContent` 增量映射成 harness 的
   * `text-delta` / `reasoning-delta`，收尾补一个 `finish` 块。
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const credential = await this.options.resolveCredential()
    if (!isCredentialUsable(credential)) {
      throw new LlmError('OrcaTerm：没有可用凭据，请先在渠道面板粘贴 Cookie', 'MISSING_CREDENTIAL')
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
      if (options.signal?.aborted === true) throw new LlmError('OrcaTerm：请求已取消', 'ABORTED')
      const message = error instanceof Error ? error.message : String(error)
      // 凭据失效与上游错误要分开：前者用户能自己修（重新粘贴 Cookie）。
      if (/401|403|Cookie|凭据/.test(message)) {
        throw new LlmError(`OrcaTerm：凭据无效或已过期，请重新粘贴 Cookie（${message}）`, 'AUTH')
      }
      throw new LlmError(message, 'TRANSPORT')
    }
    yield { type: 'finish', reason: 'stop' }
  }

  /**
   * 退避策略。
   *
   * ⚠️ 必须是扁平字段（内核调度器读顶层 initialDelayMs 等）。
   */
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

/** 注册到内核的 llm 服务。 */
export function registerOrcaTermLlm(ctx: Context, options: OrcaTermAdapterOptions): OrcaTermAdapter {
  const product = options.product ?? ORCATERM
  const adapter = new OrcaTermAdapter(options)
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
