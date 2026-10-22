/**
 * MonkeyCode LlmAdapter。
 *
 * ## 当前能力边界（**故意如此**）
 *
 * | 能力 | 状态 |
 * |---|---|
 * | 账号信息 | ✅ |
 * | 额度查询 | ✅ |
 * | 模型目录 | ✅ |
 * | 每日签到 | ✅ |
 * | **对话推理** | ❌ **暂不支持** |
 *
 * 对话走 WebSocket（`/api/v1/users/tasks/stream`），而本插件零依赖、
 * 参考实现自己承认「WS 事件语法无法在无实机下 100% 敲定」。因此这里
 * **不提供一个静默失败的假实现**，而是在 `stream()` 里抛出明确的错误，
 * 让用户在界面上一眼看到原因，而不是等一个永远不来的回复。
 *
 * ## 模型仍会出现在选择器里
 *
 * `listModels` 照常返回目录 —— 这样用户能看到「这个渠道有什么模型」，
 * 选中后才得到「对话暂不支持」的提示。隐藏模型反而让人以为渠道没配好。
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
  MONKEYCODE,
  type MonkeyCodeProduct,
} from './monkeycode-product.js'
import {
  isCredentialUsable,
  type MonkeyCodeCredential,
} from './monkeycode.js'
import { fetchModels } from './monkeycode-auth.js'
import { providerCatalogVisible } from './account-pool.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'

/** 适配器依赖。 */
export interface MonkeyCodeAdapterOptions {
  /** 产品配置（测试可注入不同 apiBase）。 */
  product?: MonkeyCodeProduct
  /** 凭据解析器。 */
  resolveCredential: () => Promise<MonkeyCodeCredential | undefined>
  /** fetch 实现（测试注入）。 */
  fetchImpl?: typeof fetch
  /** 账号池。 */
  accountPool?: {
    disabledModelsFor(provider: string): ReadonlySet<string> | undefined
  } & Parameters<typeof providerCatalogVisible>[0]
}

/**
 * MonkeyCode 适配器。
 *
 * 只实现目录与能力播报；推理路径明确拒绝（见模块头注释）。
 */
export class MonkeyCodeAdapter extends LlmAdapter {
  private readonly product: MonkeyCodeProduct
  private readonly fetchImpl: typeof fetch
  /** 远端模型目录缓存。 */
  private remoteModels: Array<{ id: string; name: string; contextWindow: number; maxTokens?: number; isHidden?: boolean }> | undefined
  private loading: Promise<void> | undefined

  constructor(private readonly options: MonkeyCodeAdapterOptions) {
    super()
    this.product = options.product ?? MONKEYCODE
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /** 确保远端目录已加载。失败静默（用兜底表）。 */
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
    // 隐藏模型不播报（平台把下架/无权限的标成 is_hidden）。
    // 兜底表没有 isHidden 字段，故用显式判等而不是 `in` 检查。
    const all: Array<{ id: string; name: string; contextWindow: number; maxTokens?: number; isHidden?: boolean }> =
      this.remoteModels ?? this.product.fallbackModels.map((model) => ({ ...model }))
    const source = all.filter((model) => model.isHidden !== true)
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? source
      : source.filter((model) => !disabled.has(model.id))
    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      name: model.name,
      // MonkeyCode 当前只支持纯文本对话。
      inputModalities: ['text'],
    }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    await this.ensureRemoteModels()
    const source = this.remoteModels ?? [...this.product.fallbackModels]
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
   * 抛 `UNSUPPORTED_CONTENT` 而不是返回空流：空流会被 DSH 当成
   * 「模型返回了空回答」，用户看到的是空白回复加一个成功标记，
   * 完全无从排查。这里的错误消息直接说明原因与现状。
   */
  // eslint-disable-next-line require-yield
  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new LlmError(
      'MonkeyCode：对话功能暂未支持（该渠道走 WebSocket 协议，当前版本只提供'
      + '账号、额度、模型目录与签到；推理能力待后续版本实现）',
      'UNSUPPORTED_CONTENT',
    )
  }

  /** 只读渠道：无重试意义（对话本来就不支持）。 */
  providerRetryPolicy(): {
    retryableCodes: readonly string[]
    maxRetries: number
    initialDelayMs: number
    maxDelayMs: number
    jitterRatio: number
  } {
    return {
      retryableCodes: [],
      maxRetries: 0,
      initialDelayMs: 1_000,
      maxDelayMs: 1_000,
      jitterRatio: 0,
    }
  }
}

/** 注册到内核的 llm 服务。 */
export function registerMonkeyCodeLlm(ctx: Context, options: MonkeyCodeAdapterOptions): MonkeyCodeAdapter {
  const product = options.product ?? MONKEYCODE
  const adapter = new MonkeyCodeAdapter(options)
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
