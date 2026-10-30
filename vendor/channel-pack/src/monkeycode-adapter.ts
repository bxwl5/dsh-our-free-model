/**
 * MonkeyCode LlmAdapter。
 *
 * ## 能力
 *
 * | 能力 | 状态 |
 * |---|---|
 * | 账号信息 | ✅ |
 * | 额度查询 | ✅ |
 * | 模型目录 | ✅ |
 * | 每日签到 | ✅ |
 * | 对话推理 | ✅（走 WebSocket，见下） |
 *
 * ## 对话为什么走 WebSocket
 *
 * 上游不是「一次 HTTP 请求 = 一次对话」，而是两步：
 * 1. `POST /api/v1/users/tasks` 建任务（提交拍平后的需求正文）→ 拿 task id；
 * 2. 连 WebSocket `/api/v1/users/tasks/stream?id=<taskId>&mode=develop` 逐帧读正文。
 *
 * 本插件零依赖（运行时无依赖，devDeps 只有 jose / undici / typescript），
 * 因此 RFC6455 客户端是**手写**的，见 `monkeycode-ws.ts`（握手、帧编解码、
 * 掩码、ping/pong）。
 *
 * ## ⚠️ 未实机验证的部分
 *
 * 上游 WebSocket 的**事件 type 取值未经真实账号确认** —— 参考实现
 * `monkeycode2api` 自己写明「事件语法无法在无实机下 100% 敲定」。
 * 因此 `parseTaskStreamEvent` 采用**容错解析**：同时接受多种终止/正文
 * type，认不出的帧**忽略而不是报错**。这样即使上游换了事件名，
 * 最坏情况是少显示一点正文，而不是把整轮对话打死在一个未知事件上。
 *
 * 建任务用的 `model_id` 是上游的模型 UUID（远端目录下发），
 * 若上游更换 UUID 而本地目录未刷新，对话会失败 —— 这是需要真实账号才能发现的问题。
 *
 * ## 模型仍会出现在选择器里
 *
 * `listModels` 照常返回目录；没有已登录账号时返回空数组（不抛错），
 * 避免界面上多出一条 provider 报错。
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
  flattenMessages,
  isCredentialUsable,
  type MonkeyCodeCredential,
} from './monkeycode.js'
import { fetchModels, streamChat } from './monkeycode-auth.js'
import { writeModelCatalogClosingNew, restoreModelCatalog } from './model-catalog-cache.js'
import { providerCatalogVisible } from './account-pool.js'
import { registerAdapterIdempotent } from './llm-register-compat.js'
import { emitDeltaBlocks } from './delta-blocks.js'

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
 * 目录、能力播报，以及走 WebSocket 拉流的对话推理（见模块头注释）。
 */
/**
 * 远端模型目录缓存有效期（5 分钟），与 `opencode-adapter.ts` 的目录 TTL 同档。
 *
 * 上游改目录不是秒级事件，但也不该等到进程重启；5 分钟既不放大请求量
 * （每渠道每 5 分钟最多 1 次），又能让新上架的模型在一个工作时段内出现。
 */
const REMOTE_MODELS_TTL_MS = 300_000

/**
 * MonkeyCode 的**参考单价基数**：`input_price = 1000` 对应 `x1`。
 *
 * 用户 2026-10-27 的决定：把上游积分单价换算成**相对倍率**展示，
 * 因为「不同模型之间的倍率差异」才是用户要的信息，
 * 而「每次实际扣多少积分」受上下文长度、输出 token 数影响，
 * 无法用单一数字表达 —— 显示绝对积分反而误导。
 *
 *   1000 → x1     800 → x0.8     600 → x0.6     400 → x0.4     200 → x0.2
 *
 * ⚠️ 这是**本渠道内部**的相对刻度，不是跨渠道可比的价格（与 Qoder 的
 * `price_factor` 量纲不同，别混在一起读）。
 */
export const MONKEYCODE_PRICE_BASE = 1000

/**
 * 模型展示名：`名称 · x<相对倍率>`（用户 2026-10-27 指定）。
 *
 * 例：
 * ```
 * qwen3.6-plus · x0.2
 * glm-5 · x0.4
 * qwen3.7-max · x0.6
 * glm-5.1 · x0.8
 * ```
 *
 * ## 口径说明
 *
 * - `input_price ÷ 1000` → 倍率。1000 为 `x1` 基准（{@link MONKEYCODE_PRICE_BASE}）。
 * - **不显示原始积分值**（用户明确要求：实际扣多少积分不好衡量，不需要知道）。
 * - `is_free: true` → 显示「免费」（比 `x0` 更准确）。
 * - 上游没给 `input_price` → **只显示名字**，不编造 `x1`
 *   （与全仓「无倍率不显示倍率」的约定一致）。
 */
export function monkeyCodeDisplayName(model: {
  name: string
  isFree?: boolean
  inputPrice?: number
}): string {
  if (model.isFree === true) return `${model.name} · 免费`
  if (model.inputPrice === undefined) return model.name
  const rate = model.inputPrice / MONKEYCODE_PRICE_BASE
  // 去掉浮点噪声（200/1000 → 0.2，不是 0.20000000000000001），
  // 同时避免 `x1.0000000000000002` 这种只因除法误差出现的怪值。
  const rounded = Math.round(rate * 1000) / 1000
  return `${model.name} · x${rounded}`
}

export class MonkeyCodeAdapter extends LlmAdapter {
  private readonly product: MonkeyCodeProduct
  private readonly fetchImpl: typeof fetch
  /** 远端模型目录缓存。 */
  private remoteModels: Array<{
    id: string
    name: string
    contextWindow: number
    maxTokens?: number
    isHidden?: boolean
    isFree?: boolean
    inputPrice?: number
    accessLevel?: string
    supportsImage?: boolean
  }> | undefined
  /** 上次成功拉取的时刻；配合 REMOTE_MODELS_TTL_MS 判断是否重拉。 */
  private remoteModelsAt = 0
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
    // 带 TTL：成功即永久缓存会让上游改目录后永远跟不上（同 opencode 目录 TTL）。
    if (this.remoteModels !== undefined && Date.now() - this.remoteModelsAt < REMOTE_MODELS_TTL_MS) return
    if (this.loading !== undefined) return this.loading
    this.loading = (async () => {
      try {
        const credential = await this.options.resolveCredential()
        if (!isCredentialUsable(credential)) return
        this.remoteModels = await fetchModels(this.fetchImpl, this.product, credential)
        this.remoteModelsAt = Date.now()
        void writeModelCatalogClosingNew(this.product.id, this.remoteModels, this.options.accountPool)
      } catch {
        // 兜底表接管。
      } finally {
        this.loading = undefined
      }
    })()
    await this.loading
    // 远端这次没拉到：用上次成功落盘的快照顶替编译期兜底表（用户 2026-10-27）。
    this.remoteModels = restoreModelCatalog(this.product.id, this.remoteModels)
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
      restoreModelCatalog(this.product.id, this.remoteModels) ?? this.product.fallbackModels.map((model) => ({ ...model }))
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

  /** 「显示列表」用的完整目录（不套用户黑名单；上游标 is_hidden 的仍排除）。 */
  listAllModels(): readonly { id: string; name: string }[] {
    const all: Array<{
      id: string
      name: string
      isHidden?: boolean
      isFree?: boolean
      inputPrice?: number
    }> = restoreModelCatalog(this.product.id, this.remoteModels) ?? this.product.fallbackModels.map((model) => ({ ...model }))
    return all.filter((model) => model.isHidden !== true)
      .map((model) => ({ id: model.id, name: monkeyCodeDisplayName(model) }))
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
    return model === undefined ? undefined : monkeyCodeDisplayName(model)
  }

  /**
   * **强制**重新拉取远端目录（「重新获取模型」按钮），绕过 TTL。
   *
   * `ensureRemoteModels()` 在 TTL 内直接返回，必须让短路条件失效，否则按钮
   * 点了没反应。失败还原旧值，保证「拉不到就显示上次的目录」。
   */
  async refreshCatalog(): Promise<boolean> {
    const credential = await this.options.resolveCredential()
    if (!isCredentialUsable(credential)) return false
    try {
      const rows = await fetchModels(this.fetchImpl, this.product, credential)
      if (rows.length === 0) return false
      this.remoteModels = rows
      this.remoteModelsAt = Date.now()
      void writeModelCatalogClosingNew(this.product.id, rows, this.options.accountPool)
      return true
    } catch {
      // 拉不到就保留上一次的目录（用户要求）。
      return false
    }
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    await this.ensureRemoteModels()
    const source = restoreModelCatalog(this.product.id, this.remoteModels) ?? [...this.product.fallbackModels]
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
   * 流式对话：建任务 → 连 WebSocket → 逐帧映射成 `text-delta`。
   *
   * 上游一次只收一条正文，历史由 `flattenMessages` 拍平后塞进这条里；
   * `options.model` 直接就是上游要的模型 UUID（远端目录下发的 id，
   * 建任务请求体的 `model_id`）。取消信号透传给建任务与 WebSocket 两段。
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const credential = await this.options.resolveCredential()
    if (!isCredentialUsable(credential)) {
      throw new LlmError('MonkeyCode：没有可用凭据，请先粘贴 Cookie', 'MISSING_CREDENTIAL')
    }
    try {
      const content = flattenMessages(options.messages, options.system)
      // 内核契约：delta 必须带 index 且以 block-start/block-end 成对包裹。
      yield* emitDeltaBlocks(streamChat(this.fetchImpl, this.product, credential, {
        content,
        modelId: options.model,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }))
    } catch (error) {
      if (options.signal?.aborted === true) throw new LlmError('MonkeyCode：请求已取消', 'ABORTED')
      const message = error instanceof Error ? error.message : String(error)
      // 凭据失效与上游错误要分开：前者用户能自己修（重新粘贴 Cookie）。
      if (/401|403|凭据|Cookie/.test(message)) {
        throw new LlmError(`MonkeyCode：凭据无效或已过期，请重新粘贴 Cookie（${message}）`, 'AUTH')
      }
      // 上游业务错误（同账号已有运行中任务 10811、建任务被拒等）→ SERVER_ERROR。
      // ⚠️ 不能标成 TRANSPORT：那会让内核重试，而重试会把**原生 Error** 塞进
      // `llm/retry` 事件载荷，内核序列化不了 —— 用户看到的是
      // 「llm/retry carries non-JSON-serializable data」而不是真实原因
      //（2026-10-25 实测）。code 10811 也没有取消接口可绕过，重试纯属浪费。
      if (/code \d{4,}|HTTP \d|建任务|正在运行|WebSocket|握手/.test(message)) {
        // 10811 附带一次任务列表诊断：把卡住任务的 id / 状态 / 创建时间报出来，
        // 否则用户只看到「请等它结束」却不知道要等多久、也没有可执行的动作。
        // 上游没有取消端点，故只能诊断不能代劳。
        if (/code 10811/.test(message)) {
          const { listMonkeyCodeTasks } = await import('./monkeycode-auth.js')
          const tasks = await listMonkeyCodeTasks(this.fetchImpl, this.product, credential, options.signal)
          const stuck = tasks.filter(task => task.status !== 'completed' && task.status !== 'failed')
          if (stuck.length > 0) {
            const detail = stuck.slice(0, 3).map(task => {
              const when = task.createdAt > 0 ? new Date(task.createdAt).toLocaleString('zh-CN') : '时间未知'
              return `${task.id}（${task.status}，建于 ${when}）`
            }).join('；')
            throw new LlmError(
              `${message}\n卡住的任务：${detail}\n上游没有取消端点，请等它结束，或去 monkeycode 网页端处理。`,
              'SERVER_ERROR',
            )
          }
        }
        throw new LlmError(message, 'SERVER_ERROR')
      }
      throw new LlmError(message, 'TRANSPORT')
    }
    yield { type: 'finish', reason: 'stop' }
  }

  /**
   * 退避策略：对话已可用，传输类错误值得重试。
   *
   * ⚠️ 必须是扁平字段 —— 内核调度器读顶层 `initialDelayMs` 等；
   * 嵌进 `backoff: {}` 会读到 undefined → NaN，持久会话日志会拒绝非有限数值。
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
export function registerMonkeyCodeLlm(ctx: Context, options: MonkeyCodeAdapterOptions): MonkeyCodeAdapter {
  const product = options.product ?? MONKEYCODE
  const adapter = new MonkeyCodeAdapter(options)
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
