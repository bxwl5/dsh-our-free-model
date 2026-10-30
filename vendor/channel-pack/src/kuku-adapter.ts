/**
 * KukuAI LlmAdapter。
 *
 * 与 OrcaTerm 同形态（建消息 → SSE），完整对话能力。
 */

import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'

import { KUKU, KUKU_MODEL_LIST_PATH, KUKU_WEB_QUERY, type KukuProduct } from './kuku-product.js'
import { writeModelCatalogClosingNew, restoreModelCatalog } from './model-catalog-cache.js'
import { isCredentialUsable, kukuHeaders, type KukuCredential } from './kuku.js'
import { streamChat } from './kuku-auth.js'
import { providerCatalogVisible } from './account-pool.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'
import { emitDeltaBlocks } from './delta-blocks.js'

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
 * kuku 的一个目录条目（远端 `data.model_list[]`）。
 *
 * 上游响应（2026-10-27 实测 `?clienttype=400&app_id=…`）：
 * ```
 * { status: {...}, data: {
 *     model_list: [{ id, model_name, display_name, description, cost_ratio, vip_type }],
 *     think_list: [{ id, think_name, description }],
 *     default_model_id, default_think_id } }
 * ```
 * - `model_name` 是**真实 id**（`gateway-deepseek-v4.1-flash-volcengine`），
 *   `display_name` 才是展示名（`DeepSeek-V4.1-Flash`）；
 * - `cost_ratio` 是**倍率字符串**（`"0.16x"`、`"3.60x"`），`""` 表示无倍率
 *   （`auto` 这种路由项就是空串）—— **不能当成 1 处理**，用户明确要求
 *   「没有倍率的直接不显示倍率」；
 * - `think_list` 是**全局思考档位表**（`低/中/高/极高`），不是每模型字段，
 *   请求时按 `think_mode` 传档位 id。
 */
export interface KukuModelEntry {
  id: string
  name: string
  /** 倍率（已从 `"0.16x"` 解析成数字）；缺失表示上游没给，展示时不写后缀。 */
  priceFactor?: number
  /** 上游给的原文描述（`description`），用作模型说明。 */
  description?: string
  /** 会员专属（`vip_type: 1`）。 */
  vipOnly?: boolean
}

/** 思考档位（`data.think_list[]`）。 */
export interface KukuThinkLevel {
  id: string
  name: string
  description?: string
}

/**
 * 解析远端目录：模型列表 + 思考档位表。
 *
 * ⚠️ 之前只提取 `{id, name}`，把 `cost_ratio`（倍率）、`description`、
 * `think_list`（思考强度）全丢了 —— 用户报障「从远端拉取但倍率和推理强度
 * 没有」。这里一并解析出来。
 */
export function parseKukuCatalog(value: unknown): {
  models: KukuModelEntry[]
  thinkLevels: KukuThinkLevel[]
  defaultThinkId?: string
} {
  const data = (value !== null && typeof value === 'object' && 'data' in value)
    ? (value as Record<string, unknown>).data
    : value
  const root = (data !== null && typeof data === 'object') ? data as Record<string, unknown> : {}
  const models: KukuModelEntry[] = []
  const seen = new Set<string>()
  const list = Array.isArray(root.model_list) ? root.model_list : []
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const id = typeof item.model_name === 'string' ? item.model_name.trim()
      : typeof item.modelName === 'string' ? item.modelName.trim()
        : typeof item.modelId === 'string' ? item.modelId.trim() : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const display = typeof item.display_name === 'string' && item.display_name.trim() !== ''
      ? item.display_name.trim() : id
    const entry: KukuModelEntry = { id, name: display }
    // `"0.16x"` → 0.16；`""` / 非法 → 不带倍率（不编造 x1）。
    const ratio = typeof item.cost_ratio === 'string' ? item.cost_ratio.trim() : ''
    const parsed = ratio === '' ? Number.NaN : Number.parseFloat(ratio.replace(/x$/i, ''))
    if (Number.isFinite(parsed) && parsed >= 0) entry.priceFactor = parsed
    if (typeof item.description === 'string' && item.description.trim() !== '') {
      entry.description = item.description.trim()
    }
    if (item.vip_type === 1) entry.vipOnly = true
    models.push(entry)
  }
  const thinkLevels: KukuThinkLevel[] = []
  const thinkSeen = new Set<string>()
  const thinkList = Array.isArray(root.think_list) ? root.think_list : []
  for (const raw of thinkList) {
    if (raw === null || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const id = typeof item.id === 'string' ? item.id.trim() : String(item.id ?? '').trim()
    const name = typeof item.think_name === 'string' ? item.think_name.trim() : ''
    if (id === '' || name === '' || thinkSeen.has(id)) continue
    thinkSeen.add(id)
    thinkLevels.push({
      id,
      name,
      ...(typeof item.description === 'string' && item.description.trim() !== ''
        ? { description: item.description.trim() } : {}),
    })
  }
  const defaultThinkId = typeof root.default_think_id === 'string' ? root.default_think_id.trim() : undefined
  return { models, thinkLevels, ...(defaultThinkId === undefined ? {} : { defaultThinkId }) }
}

/** 模型展示名：把倍率拼上去（无倍率就只显示名字，用户明确要求）。 */
export function kukuDisplayName(model: { name: string; priceFactor?: number }): string {
  if (model.priceFactor === undefined) return model.name
  return `${model.name} · ${model.priceFactor === 0 ? '免费' : `x${model.priceFactor}`}`
}

export class KukuAdapter extends LlmAdapter {
  private readonly product: KukuProduct
  private readonly fetchImpl: typeof fetch
  /** 远端模型目录（拉到后用；拉不到回落到 `product.fallbackModels`）。 */
  private remoteModels: KukuModelEntry[] | undefined
  /** 远端思考档位表（`data.think_list`）；`undefined` 表示还没拉到。 */
  private remoteThinkLevels: KukuThinkLevel[] | undefined
  /** 上游默认档位 id（`default_think_id`）。 */
  private remoteDefaultThinkId: string | undefined
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
    const source = restoreModelCatalog(this.product.id, this.remoteModels) ?? this.product.fallbackModels
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? source
      : source.filter((model) => !disabled.has(model.id))
    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      // 倍率拼进 name（不是 description）：composer 的模型切换菜单只渲染 name。
      name: kukuDisplayName(model),
      ...(model.description === undefined ? {} : { description: model.description }),
      inputModalities: ['text'],
    }))
  }

  /** 「显示列表」用的完整目录（不套用户黑名单）；缺了它卡片模型数会显示「—」。 */
  listAllModels(): readonly { id: string; name: string }[] {
    const source = restoreModelCatalog(this.product.id, this.remoteModels) ?? this.product.fallbackModels
    return source.map((model) => ({ id: model.id, name: kukuDisplayName(model) }))
  }

  /**
   * 单个 id 的友好展示名（供 `model.list` 补回被关闭/已失效的模型用）。
   *
   * 缺了它，被关闭的历史 id 只能以裸内部编码出现在设置页（用户 2026-10-26
   * 报障的「模型列表出现 qmodel 等字段」）。
   */
  displayNameFor(modelId: string): string | undefined {
    const source = restoreModelCatalog(this.product.id, this.remoteModels) ?? this.product.fallbackModels
    const model = source.find((item) => item.id === modelId)
    return model === undefined ? undefined : kukuDisplayName(model)
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
        const catalog = parseKukuCatalog(record.data)
        if (catalog.models.length > 0) {
          this.remoteModels = catalog.models
          this.remoteThinkLevels = catalog.thinkLevels
          this.remoteDefaultThinkId = catalog.defaultThinkId
          this.remoteModelsAt = Date.now()
          void writeModelCatalogClosingNew(this.product.id, catalog.models, this.options.accountPool)
        }
      } catch {
        // 静态表接管。
      } finally {
        this.loading = undefined
      }
    })()
    await this.loading
    // 远端这次没拉到：用上次成功落盘的快照顶替编译期兜底表（用户 2026-10-27）。
    // ⚠️ 只恢复**模型目录**：思考档位（`remoteThinkLevels` / `remoteDefaultThinkId`）
    // 是随目录一起下发的独立字段，没有落盘，此时退回静态表 —— 表现为「离线启动时
    // 思考档位只有默认那几档」，不影响模型本身可用。
    this.remoteModels = restoreModelCatalog(this.product.id, this.remoteModels)
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    await this.ensureRemoteModels()
    const remote = this.remoteModels?.find((candidate) => candidate.id === model)
    const fallback = this.product.fallbackModels.find((candidate) => candidate.id === model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      // 远端优先（含倍率），拉不到才回落兜底表。
      name: remote !== undefined ? kukuDisplayName(remote) : fallback?.name ?? model,
      inputModalities: ['text'],
    }
    const contextWindow = fallback?.contextWindow
    if (contextWindow !== undefined) resolved.context = { contextWindow }
    if (fallback?.maxTokens !== undefined && fallback.maxTokens > 0) {
      resolved.defaultMaxTokens = fallback.maxTokens
    }
    /**
     * 思考强度：档位来自远端 `data.think_list`（`低/中/高/极高`），
     * 请求时按 `think_mode` 传档位 id。
     *
     * ⚠️ 之前**完全没有** `reasoning`，所以界面上根本选不到思考程度
     * （用户 2026-10-26 报障）。档位 id 是上游的**数字字符串**，交给
     * `ReasoningEffortId` 保证类型契约。
     */
    const levels = this.remoteThinkLevels
    if (levels !== undefined && levels.length > 0) {
      const preferred = this.remoteDefaultThinkId
      const fallbackDefault = levels[levels.length - 1].id
      const defaultId = preferred !== undefined && levels.some((level) => level.id === preferred)
        ? preferred
        : fallbackDefault
      resolved.reasoning = {
        efforts: levels.map((level) => ({
          id: ReasoningEffortId(level.id),
          name: level.name,
        })),
        defaultEffort: ReasoningEffortId(defaultId),
      }
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

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const credential = await this.options.resolveCredential()
    if (!isCredentialUsable(credential)) {
      throw new LlmError('KukuAI：没有可用凭据，请先在渠道面板粘贴含 BDUSS 的 Cookie', 'MISSING_CREDENTIAL')
    }
    /**
     * 把内核传来的档位 id 映射成上游的 `think_mode` 数值。
     *
     * 上游 `think_list[].id` 是数字字符串（`"1"`…`"4"`），而 DSH 传下来的是
     * `ReasoningEffortId`（同样是字符串）。非数字 / 未知档位一律不传，
     * 交给上游默认档 —— 传错值会让上游按「无效档位」处理。
     */
    const requested = options.reasoningEffort
    const thinkMode = requested === undefined
      ? undefined
      : (() => {
        const text = String(requested)
        const known = this.remoteThinkLevels?.some((level) => level.id === text) ?? false
        const numeric = Number.parseInt(text, 10)
        return known && Number.isFinite(numeric) ? numeric : undefined
      })()
    try {
      // 内核契约：delta 必须带 index 且以 block-start/block-end 成对包裹。
      yield* emitDeltaBlocks(streamChat(this.fetchImpl, this.product, credential, {
        model: options.model,
        messages: options.messages,
        ...(options.system === undefined ? {} : { system: options.system }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        // 思考档位：上游按 `think_mode`（档位 id）选择强度。
        // ⚠️ 缺省时**不传**，让上游用自己声明的默认档（`default_think_id`）；
        // 硬写 0 会变成「关闭思考」，与用户选的默认档不符。
        ...thinkMode === undefined ? {} : { thinkMode },
      }))
    } catch (error) {
      if (options.signal?.aborted === true) throw new LlmError('KukuAI：请求已取消', 'ABORTED')
      const message = error instanceof Error ? error.message : String(error)
      // 凭据类 → AUTH（重试无意义，只会继续撞墙）
      if (/401|403|BDUSS|凭据|未登录|invalid session/i.test(message)) {
        throw new LlmError(`KukuAI：凭据无效或已过期，请重新粘贴 Cookie（${message}）`, 'AUTH')
      }
      // 上游业务错误（session_id 失效、任务不存在、上游错误帧）→ SERVER_ERROR。
      // ⚠️ 绝不能标成 TRANSPORT：那会让内核重试，而重试会把**原生 Error**
      // 塞进 `llm/retry` 事件载荷 —— 内核序列化不了，于是用户看到的是
      // 「llm/retry carries non-JSON-serializable data」而不是真实原因
      //（2026-10-25 实测：kuku / monkeycode 都踩到）。
      if (/session_id|task not found|订阅失败|上游错误|HTTP \d/.test(message)) {
        throw new LlmError(message, 'SERVER_ERROR')
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
