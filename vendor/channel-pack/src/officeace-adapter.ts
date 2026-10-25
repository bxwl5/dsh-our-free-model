/**
 * OfficeAce LlmAdapter。
 *
 * 推理是**标准 OpenAI 兼容**（`POST {base}/chat/completions` + **Basic** 鉴权），
 * 故消息序列化与 SSE 解码全部复用 `src/openai-compat.ts`，
 * 本文件只实现 OfficeAce 特有的部分：Basic 鉴权、基址归一、模型目录。
 *
 * ## 为什么与其它华为云渠道（CodeArts）不同
 *
 * CodeArts 的业务与推理都走 SDK-HMAC 签名；OfficeAce 把两者拆开了：
 * **推理用推理网关的基本鉴权（Basic）**，业务接口才用 AK/SK 签名。
 * 混用会得到 401。
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

import { OFFICEACE, type OfficeAceProduct } from './officeace-product.js'
import {
  basicAuthHeader,
  isCredentialUsable,
  normalizeBaseUrl,
  type OfficeAceCredential,
} from './officeace.js'
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
export interface OfficeAceAdapterOptions {
  product?: OfficeAceProduct
  resolveCredential: () => Promise<OfficeAceCredential | undefined>
  fetchImpl?: typeof fetch
  accountPool?: {
    disabledModelsFor(provider: string): ReadonlySet<string> | undefined
  } & Parameters<typeof providerCatalogVisible>[0]
}

/**
 * 远端模型目录的缓存有效期（5 分钟）。
 *
 * 与 `opencode-adapter.ts` 的 `DEFAULT_CATALOG_TTL_MS` 同档。取 5 分钟的理由：
 * 上游改目录不是秒级事件，但也不该等到进程重启；5 分钟既不放大请求量
 * （每渠道每 5 分钟最多 1 次），又能让新上架的模型在一个工作时段内出现。
 */
const REMOTE_MODELS_TTL_MS = 300_000

/** OfficeAce 适配器。 */
export class OfficeAceAdapter extends LlmAdapter {
  private readonly product: OfficeAceProduct
  private readonly fetchImpl: typeof fetch
  private remoteModels: Array<{ id: string; name: string; contextWindow: number; maxTokens?: number }> | undefined
  /** 上次成功拉取的时刻。配合 {@link REMOTE_MODELS_TTL_MS} 决定是否重拉。 */
  private remoteModelsAt = 0
  private loading: Promise<void> | undefined

  constructor(private readonly options: OfficeAceAdapterOptions) {
    super()
    this.product = options.product ?? OFFICEACE
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 拉模型目录（OpenAI 格式）。失败静默（用兜底表）。
   *
   * ⚠ **必须带 TTL**：原先的判据是 `if (this.remoteModels !== undefined) return`
   * —— 拉成功一次就永久缓存，上游下架/新增模型后进程不重启永远不跟上
   *（2026-10-25 实测：与 OrCaTerm 静态表过期是同一类问题）。现按
   * {@link REMOTE_MODELS_TTL_MS} 过期重拉；**失败时保留旧列表**，
   * 不能因为一次网络抖动就把已拿到的目录清空。
   */
  private async ensureRemoteModels(): Promise<void> {
    const fresh = this.remoteModels !== undefined && Date.now() - this.remoteModelsAt < REMOTE_MODELS_TTL_MS
    if (fresh) return
    if (this.loading !== undefined) return this.loading
    this.loading = (async () => {
      try {
        const credential = await this.options.resolveCredential()
        if (!isCredentialUsable(credential)) return
        const base = normalizeBaseUrl(credential.base_url)
        const response = await this.fetchImpl(`${base}/models`, {
          method: 'GET',
          headers: { Accept: 'application/json', Authorization: basicAuthHeader(credential) },
        })
        if (!response.ok) return
        const body: unknown = await response.json().catch(() => undefined)
        if (typeof body !== 'object' || body === null) return
        const record = body as Record<string, unknown>
        if (!Array.isArray(record.data)) return
        const rows: Array<{ id: string; name: string; contextWindow: number; maxTokens?: number }> = []
        for (const raw of record.data) {
          if (typeof raw !== 'object' || raw === null) continue
          const item = raw as Record<string, unknown>
          const id = typeof item.id === 'string' && item.id !== '' ? item.id : undefined
          if (id === undefined) continue
          const contextRaw = item.context_length ?? item.contextWindow
          const contextWindow = typeof contextRaw === 'number' && contextRaw > 0 ? contextRaw : 128_000
          rows.push({ id, name: typeof item.name === 'string' && item.name !== '' ? item.name : id, contextWindow })
        }
        if (rows.length > 0) { this.remoteModels = rows; this.remoteModelsAt = Date.now() }
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

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const credential = await this.options.resolveCredential()
    if (!isCredentialUsable(credential)) {
      throw new LlmError('OfficeAce：没有可用凭据，请先登录', 'MISSING_CREDENTIAL')
    }
    const base = normalizeBaseUrl(credential.base_url)
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
      response = await this.fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          // ⚠️ Basic 鉴权（推理网关），不是 SDK-HMAC。
          Authorization: basicAuthHeader(credential),
        },
        body: JSON.stringify(body),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (error) {
      if (options.signal?.aborted === true) throw new LlmError('OfficeAce：请求已取消', 'ABORTED')
      if (isTransportError(error)) throw new LlmError(`OfficeAce：连接失败（${errorMessage(error)}）`, 'TRANSPORT')
      throw new LlmError(`OfficeAce：请求失败（${errorMessage(error)}）`, 'TRANSPORT')
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const detail = errorDetail(text)
      if (response.status === 401 || response.status === 403) {
        throw new LlmError(
          `OfficeAce：凭据无效或已过期（HTTP ${response.status}）${detail === '' ? '' : `：${detail}`}`,
          'AUTH',
          { status: response.status },
        )
      }
      if (response.status === 429) {
        throw new LlmError(`OfficeAce：触发限流（HTTP 429）${detail === '' ? '' : `：${detail}`}`, 'RATE_LIMIT', { status: 429 })
      }
      throw new LlmError(
        `OfficeAce：上游返回 HTTP ${response.status}${detail === '' ? '' : `：${detail}`}`,
        httpErrorCode(response.status),
        { status: response.status },
      )
    }

    yield* consumeOpenAiSse(response, { signal: options.signal }, {
      label: 'officeace',
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
export function registerOfficeAceLlm(ctx: Context, options: OfficeAceAdapterOptions): OfficeAceAdapter {
  const product = options.product ?? OFFICEACE
  const adapter = new OfficeAceAdapter(options)
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
