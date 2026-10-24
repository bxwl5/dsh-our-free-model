/**
 * Accio LlmAdapter。
 *
 * 完整对话能力。两个地区（`accio` / `accio-cn`）共用这一份实现，
 * 差别只在产品配置里的 `region` 与登录站点。
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

import { ACCIO, type AccioProduct } from './accio-product.js'
import {
  isCredentialExpired,
  isCredentialUsable,
  type AccioCredential,
} from './accio.js'
import { fetchModels, refreshCredential, streamChat } from './accio-auth.js'
import { providerCatalogVisible } from './account-pool.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'

/** 适配器依赖。 */
export interface AccioAdapterOptions {
  product?: AccioProduct
  resolveCredential: () => Promise<AccioCredential | undefined>
  /** 续期成功后回写凭据。 */
  saveCredential?: (credential: AccioCredential) => Promise<void>
  fetchImpl?: typeof fetch
  accountPool?: {
    disabledModelsFor(provider: string): ReadonlySet<string> | undefined
  } & Parameters<typeof providerCatalogVisible>[0]
}

/** Accio 适配器。 */
export class AccioAdapter extends LlmAdapter {
  private readonly product: AccioProduct
  private readonly fetchImpl: typeof fetch
  private remoteModels: Array<{ id: string; name: string; contextWindow: number; maxTokens?: number }> | undefined
  private loading: Promise<void> | undefined

  constructor(private readonly options: AccioAdapterOptions) {
    super()
    this.product = options.product ?? ACCIO
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
        this.remoteModels = await fetchModels(this.fetchImpl, this.product, credential)
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

  /** 「显示列表」用的完整目录（不套用户黑名单）；缺了它卡片模型数显示「—」。 */
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

  /**
   * 取凭据，必要时先续期。
   *
   * Accio 有 refresh_token，且过期后必须换新才能用。
   */
  private async credentialForUse(): Promise<AccioCredential> {
    let credential = await this.options.resolveCredential()
    if (!isCredentialUsable(credential)) {
      throw new LlmError(`Accio：没有可用凭据，请先登录 ${this.product.displayName}`, 'MISSING_CREDENTIAL')
    }
    if (isCredentialExpired(credential) && credential.refresh_token !== undefined) {
      const refreshed = await refreshCredential(this.fetchImpl, this.product, credential)
      if (refreshed !== undefined) {
        await this.options.saveCredential?.(refreshed)
        credential = refreshed
      }
    }
    return credential
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const credential = await this.credentialForUse()
    try {
      for await (const delta of streamChat(this.fetchImpl, this.product, credential, {
        model: options.model,
        messages: options.messages,
        ...(options.system === undefined ? {} : { system: options.system }),
        ...(options.tools === undefined || options.tools.length === 0 ? {} : {
          tools: options.tools.map((tool) => ({
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
          })),
        }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })) {
        if (delta.reasoning !== undefined) yield { type: 'reasoning-delta', text: delta.reasoning }
        if (delta.text !== undefined) yield { type: 'text-delta', text: delta.text }
      }
    } catch (error) {
      if (options.signal?.aborted === true) throw new LlmError('Accio：请求已取消', 'ABORTED')
      const message = error instanceof Error ? error.message : String(error)
      if (/401|403|凭据|登录/.test(message)) {
        throw new LlmError(`Accio：凭据无效或已过期（${message}）`, 'AUTH')
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
export function registerAccioLlm(ctx: Context, options: AccioAdapterOptions): AccioAdapter {
  const product = options.product ?? ACCIO
  const adapter = new AccioAdapter(options)
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
