/**
 * CatPaw LlmAdapter。
 *
 * ## 能力边界（**故意如此**）
 *
 * | 能力 | 状态 |
 * |---|---|
 * | 凭据校验 | ✅ |
 * | 模型目录（`POST /api/agent/maas/model-types`） | ✅ |
 * | **对话推理** | ❌ **暂不支持** |
 *
 * 上游的对话是**有状态会话协议**（`round → event(running) → turn → 工具循环
 * → event(completed)`），需要维护 `x-session-id → conversationId` 映射与
 * 已同步消息的指纹链，且「每轮必须回报 event(completed)」是硬约束 ——
 * 违反会让上游把会话判为「执行中」，下一轮直接拒绝。
 *
 * 参考实现该协议约 1200 行。**不提供一个可能让会话卡死的假实现**：
 * 那比明确「不支持」更糟 —— 用户会看到永远不来的回复，且没有任何线索。
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

import { CATPAW, type CatPawProduct } from './catpaw-product.js'
import {
  fetchModelTypes,
  isCredentialUsable,
  type CatPawCredential,
} from './catpaw.js'
import { providerCatalogVisible } from './account-pool.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'

/** 适配器依赖。 */
export interface CatPawAdapterOptions {
  product?: CatPawProduct
  resolveCredential: () => Promise<CatPawCredential | undefined>
  fetchImpl?: typeof fetch
  accountPool?: {
    disabledModelsFor(provider: string): ReadonlySet<string> | undefined
  } & Parameters<typeof providerCatalogVisible>[0]
}

/** CatPaw 适配器。 */
export class CatPawAdapter extends LlmAdapter {
  private readonly product: CatPawProduct
  private readonly fetchImpl: typeof fetch
  private remoteModels: Array<{ id: string; name: string; contextWindow: number; maxTokens?: number }> | undefined
  private loading: Promise<void> | undefined

  constructor(private readonly options: CatPawAdapterOptions) {
    super()
    this.product = options.product ?? CATPAW
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  private async ensureRemoteModels(): Promise<void> {
    if (this.remoteModels !== undefined) return
    if (this.loading !== undefined) return this.loading
    this.loading = (async () => {
      try {
        const credential = await this.options.resolveCredential()
        if (!isCredentialUsable(credential)) return
        this.remoteModels = await fetchModelTypes(this.fetchImpl, this.product, credential)
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

  /**
   * 对话推理 —— **当前明确不支持**。
   *
   * 抛 `UNSUPPORTED_CONTENT` 并说明原因，而不是返回空流：
   * 空流会被 DSH 当成「模型返回了空回答」，用户看到空白回复加成功标记。
   */
  // eslint-disable-next-line require-yield
  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new LlmError(
      'CatPaw：对话功能暂未支持（该渠道的对话是有状态会话协议，需要'
      + 'round/event/turn 时序与指纹链；当前版本只提供凭据与模型目录，'
      + '推理能力待后续版本实现）',
      'UNSUPPORTED_CONTENT',
    )
  }

  /** 只读渠道：无重试意义。 */
  providerRetryPolicy(): {
    retryableCodes: readonly string[]
    maxRetries: number
    initialDelayMs: number
    maxDelayMs: number
    jitterRatio: number
  } {
    return { retryableCodes: [], maxRetries: 0, initialDelayMs: 1_000, maxDelayMs: 1_000, jitterRatio: 0 }
  }
}

/** 注册到内核。 */
export function registerCatPawLlm(ctx: Context, options: CatPawAdapterOptions): CatPawAdapter {
  const product = options.product ?? CATPAW
  const adapter = new CatPawAdapter(options)
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
