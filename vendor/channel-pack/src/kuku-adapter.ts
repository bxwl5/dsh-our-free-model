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

import { KUKU, KUKU_MODEL_LIST_PATH, KUKU_WEB_QUERY, type KukuProduct } from './kuku-product.js'
import { isCredentialUsable, kukuHeaders, type KukuCredential } from './kuku.js'
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
/**
 * 远端模型目录缓存有效期（10 分钟，与上游 `providers/kuku/models.rs` 的
 * `CATALOG_CACHE_TTL_MS` 同值）。
 */
const REMOTE_MODELS_TTL_MS = 600_000

/**
 * 从上游目录响应里提取 `{ id, name }`。
 *
 * 上游响应（实测 2026-10-25）：`data.model_list[]` 每项含
 * `model_name`（真实 id，如 `gateway-deepseek-v4.1-flash-volcengine`）、
 * `display_name`（展示名，如 `DeepSeek-V4.1-Flash`）、`cost_ratio`、`vip_type`。
 * 结构未公开（上游 `models.rs` 也做宽松提取），故递归找，缺 display_name 时用 id 兜底。
 */
function extractKukuModels(value: unknown): Array<{ id: string; name: string }> {
  const out = new Map<string, string>()
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { for (const item of node) walk(item); return }
    if (typeof node !== 'object' || node === null) return
    const record = node as Record<string, unknown>
    const id = typeof record.model_name === 'string' ? record.model_name.trim()
      : typeof record.modelName === 'string' ? record.modelName.trim()
        : typeof record.modelId === 'string' ? record.modelId.trim()
          : undefined
    if (id !== undefined && id !== '') {
      const display = typeof record.display_name === 'string' && record.display_name.trim() !== ''
        ? record.display_name.trim()
        : id
      if (!out.has(id)) out.set(id, display)
      return
    }
    for (const child of Object.values(record)) walk(child)
  }
  walk(value)
  return [...out.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, name]) => ({ id, name }))
}

export class KukuAdapter extends LlmAdapter {
  private readonly product: KukuProduct
  private readonly fetchImpl: typeof fetch
  /** 远端模型目录（拉到后用；拉不到回落到 `product.fallbackModels`）。 */
  private remoteModels: Array<{ id: string; name: string }> | undefined
  /** 上次成功拉取的时刻；配合 REMOTE_MODELS_TTL_MS 判断是否重拉。 */
  private remoteModelsAt = 0
  private loading: Promise<void> | undefined

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

  /** 「显示列表」用的完整目录（不套用户黑名单）；缺了它卡片模型数会显示「—」。 */
  listAllModels(): readonly { id: string; name: string }[] {
    const source = this.remoteModels ?? this.product.fallbackModels
    return source.map((model) => ({ id: model.id, name: model.name }))
  }

  /** 拉远端模型目录（`GET /wenchain/genflowpro/model/list`）。失败静默回落静态表。 */
  private async ensureRemoteModels(): Promise<void> {
    if (this.remoteModels !== undefined && Date.now() - this.remoteModelsAt < REMOTE_MODELS_TTL_MS) return
    if (this.loading !== undefined) return this.loading
    this.loading = (async () => {
      try {
        const credential = await this.options.resolveCredential()
        if (!isCredentialUsable(credential)) return
        const response = await this.fetchImpl(`${this.product.apiBase}${KUKU_MODEL_LIST_PATH}?${KUKU_WEB_QUERY}`, {
          method: 'GET',
          headers: kukuHeaders(this.product, credential),
        })
        if (!response.ok) return
        const body: unknown = await response.json().catch(() => undefined)
        if (typeof body !== 'object' || body === null) return
        const record = body as Record<string, unknown>
        const status = record.status
        if (typeof status === 'object' && status !== null) {
          const code = (status as Record<string, unknown>).code
          if (typeof code === 'number' && code !== 0) return
        }
        const parsed = extractKukuModels(record.data)
        if (parsed.length > 0) {
          this.remoteModels = parsed
          this.remoteModelsAt = Date.now()
        }
      } catch {
        // 静态表接管。
      } finally {
        this.loading = undefined
      }
    })()
    return this.loading
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
