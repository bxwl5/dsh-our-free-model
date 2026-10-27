/**
 * Accio LlmAdapter。
 *
 * 完整对话能力。两个地区（`accio` / `accio-cn`）共用这一份实现，
 * 差别只在产品配置里的 `region` 与登录站点。
 */

import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
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

/**
 * 模型展示名：远端倍率拼在名字后（**无倍率就只显示名字**）。
 *
 * 用户 2026-10-26 明确要求：
 * - 倍率以**远端** `usageMultiple` 为准（本地兜底表会过期）；
 * - 上游没给倍率（`null`，实测 `auto` 这类路由项）时**不要编造 x1**；
 * - `freeUse: true` 且倍率为 0 → 显示「免费」。
 */
export function accioDisplayName(model: {
  name: string
  nameCn?: string
  priceFactor?: number
  isFree?: boolean
}): string {
  // 中文名优先（用户在国内版看到的应是中文），没有就退英文名。
  const base = model.nameCn !== undefined && model.nameCn !== '' ? model.nameCn : model.name
  if (model.priceFactor === undefined) return base
  if (model.priceFactor === 0) return `${base} · 免费`
  return `${base} · x${model.priceFactor}`
}

/**
 * 思考档位：**只有「开启 / 关闭」两态**（用户 2026-10-27 指定）。
 *
 * ## 为什么不是多档
 *
 * Accio 的目录只下发 `enableThinking`（布尔），**没有档位表**
 * （对比 Qoder 的 `thinking_config.efforts`、kuku 的 `think_list`）。
 * 只有一个「支不支持思考」的开关，故 UI 只给两态，不编造 `低/中/高`。
 *
 * ## 只对 `enableThinking === true` 的模型声明
 *
 * `false`（模型不支持）与 `null`（上游没说明）都**不声明** ——
 * 给一个点了没用的「开启思考」比不给更糟。
 *
 * ## ⚠️ 请求侧尚未接线
 *
 * 本函数只负责**界面选项**。把选择转成上游字段的那一步没做：accio 的
 * 对话链路当前被阿里风控拦截（`rgv587_flag: "sm"` + punish 页，
 * 见 `accio.ts` 的 ADK 信封注释与 issue 记录），**无法实测**上游认哪个
 * 思考字段（ADK 同族通常用 `generationConfig.thinkingConfig.includeThoughts`，
 * 但未验证）。在没有可靠证据前不往请求体塞字段 —— 猜错会让用户以为
 * 「关掉思考了」实际没关，比不给选项更误导。
 *
 * TODO(accio-thinking): 对话链路恢复可用后，按实测结果在
 * `buildGenerateBody` 里接线，并补一条回归断言。
 */
export function accioReasoningInfo(
  model: { supportsThinking?: boolean },
): LlmModelReasoningInfo | undefined {
  if (model.supportsThinking !== true) return undefined
  return {
    efforts: [
      { id: ReasoningEffortId('on'), name: '开启思考' },
      { id: ReasoningEffortId('none'), name: '关闭思考' },
    ],
  }
}

export class AccioAdapter extends LlmAdapter {
  private readonly product: AccioProduct
  private readonly fetchImpl: typeof fetch
  private remoteModels: Array<{
    id: string
    name: string
    contextWindow: number
    maxTokens?: number
    priceFactor?: number
    isFree?: boolean
    nameCn?: string
    supportsThinking?: boolean
    usageDesc?: string
  }> | undefined
  /** 上次成功拉取的时刻；配合 REMOTE_MODELS_TTL_MS 判断是否重拉。 */
  private remoteModelsAt = 0
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
    // 带 TTL：成功即永久缓存会让上游改目录后永远跟不上（同 opencode 目录 TTL）。
    if (this.remoteModels !== undefined && Date.now() - this.remoteModelsAt < REMOTE_MODELS_TTL_MS) return
    if (this.loading !== undefined) return this.loading
    this.loading = (async () => {
      try {
        const credential = await this.options.resolveCredential()
        if (!isCredentialUsable(credential)) return
        this.remoteModels = await fetchModels(this.fetchImpl, this.product, credential)
        this.remoteModelsAt = Date.now()
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
      // 倍率拼进 name（不是 description）：composer 的模型切换菜单只渲染 name。
      name: accioDisplayName(model),
      ...(model.usageDesc === undefined ? {} : { description: model.usageDesc }),
      inputModalities: ['text'],
    }))
  }

  /** 「显示列表」用的完整目录（不套用户黑名单）；缺了它卡片模型数显示「—」。 */
  listAllModels(): readonly { id: string; name: string }[] {
    const source = this.remoteModels ?? this.product.fallbackModels
    return source.map((model) => ({ id: model.id, name: accioDisplayName(model) }))
  }

  /**
   * 单个 id 的友好展示名（供 `model.list` 补回被关闭/已失效的模型用）。
   *
   * 缺了它，被关闭的历史 id 只能以裸内部编码出现在设置页（用户 2026-10-26
   * 报障的「模型列表出现 qmodel 等字段」）。
   */
  displayNameFor(modelId: string): string | undefined {
    const source = this.remoteModels ?? this.product.fallbackModels
    const model = source.find((item) => item.id === modelId)
    return model === undefined ? undefined : accioDisplayName(model)
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
    const source = this.remoteModels ?? this.product.fallbackModels
    const entry = source.find((candidate) => candidate.id === model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      // 远端优先（含倍率），拉不到才回落兜底表。
      name: entry === undefined ? model : accioDisplayName(entry),
      inputModalities: ['text'],
    }
    if (entry?.contextWindow !== undefined) resolved.context = { contextWindow: entry.contextWindow }
    if (entry?.maxTokens !== undefined && entry.maxTokens > 0) resolved.defaultMaxTokens = entry.maxTokens
    // 思考：只有「开启 / 关闭」两态（上游无档位表，见 accioReasoningInfo）。
    if (entry !== undefined) {
      const reasoning = accioReasoningInfo(entry)
      if (reasoning !== undefined) resolved.reasoning = reasoning
    }
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
