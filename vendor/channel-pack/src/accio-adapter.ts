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
import { emitDeltaBlocks } from './delta-blocks.js'
import { resolveCatalog, catalogDisplayName, type ResolvedCatalog } from './catalog-resolver.js'
import type { CatalogModel } from './model-catalog-store.js'

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
/**
 * 远端模型目录缓存有效期（5 分钟），与 `opencode-adapter.ts` 的目录 TTL 同档。
 *
 * 上游改目录不是秒级事件，但也不该等到进程重启；5 分钟既不放大请求量
 * （每渠道每 5 分钟最多 1 次），又能让新上架的模型在一个工作时段内出现。
 */
const REMOTE_MODELS_TTL_MS = 300_000

/** 兜底表条目 → 统一目录条目（兜底表无倍率字段，故不带 priceFactor）。 */
function toCatalogModel(model: AccioFallbackModel): CatalogModel {
  return {
    id: model.id,
    name: model.name,
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
  }
}

export class AccioAdapter extends LlmAdapter {
  private readonly product: AccioProduct
  private readonly fetchImpl: typeof fetch
  /** 解析结果（三层回退），由 ensureRemoteModels 填充。 */
  private catalog: ResolvedCatalog | undefined
  /** 上次成功拉取的时刻；配合 REMOTE_MODELS_TTL_MS 判断是否重拉。 */

  constructor(private readonly options: AccioAdapterOptions) {
    super()
    this.product = options.product ?? ACCIO
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 解析模型目录：**远端 → 落盘缓存 → 兜底表**（2026-10-26 统一改造）。
   *
   * 原先自己实现 TTL + `remoteModels ?? fallbackModels`，有两个缺陷：
   * ①进程重启就丢（回落兜底表的过期数据）②凭据失效时同样回落兜底表，
   * 而用户要求「登录失效/删除凭证显示上一次的模型列表」。现交给共享的
   * `resolveCatalog`，本方法只负责「怎么拉、怎么解析」。
   */
  private async ensureRemoteModels(force = false): Promise<ResolvedCatalog> {
    const resolved = await resolveCatalog({
      provider: this.product.id,
      fallback: this.product.fallbackModels.map(toCatalogModel),
      force,
      fetchRemote: async () => {
        const credential = await this.options.resolveCredential()
        if (!isCredentialUsable(credential)) return undefined
        const rows = await fetchModels(this.fetchImpl, this.product, credential)
        // ⚠️ Accio 上游目录**不含倍率字段**，故 priceFactor 留空
        //（展示层会因此只显示名字，不编造 x1）。
        return rows.map(row => ({
          id: row.id,
          name: row.name,
          ...(row.contextWindow === undefined ? {} : { contextWindow: row.contextWindow }),
        }))
      },
    })
    this.catalog = resolved
    return resolved
  }

  /** 定时刷新入口（供 catalog-refresher 调用）。 */
  async refreshCatalog(): Promise<boolean> {
    const resolved = await this.ensureRemoteModels(true)
    return resolved.source === 'remote'
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    if (this.options.accountPool !== undefined
      && !await providerCatalogVisible(this.options.accountPool, this.product.id)) {
      return []
    }
    const resolved = await this.ensureRemoteModels()
    const source = resolved.models
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
    // 同步契约：只读**已缓存**的解析结果；未预热时用兜底表。
    const source = this.catalog?.models ?? this.product.fallbackModels.map(toCatalogModel)
    // 展示名带倍率（无倍率则只有名字，见 catalogDisplayName）。
    return source.map((model) => ({ id: model.id, name: catalogDisplayName(model) }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const catalog = await this.ensureRemoteModels()
    const entry = catalog.models.find((candidate) => candidate.id === model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      // 展示名带倍率（composer / /model 弹窗读它），与选择器口径一致。
      name: entry === undefined ? model : catalogDisplayName(entry),
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
      yield* emitDeltaBlocks(streamChat(this.fetchImpl, this.product, credential, {
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
      }))    } catch (error) {
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
