/**
 * Qoder LLM 适配器。
 *
 * ## 两条推理路径
 *
 * Qoder 有**两套**推理端点，认**两套不同的模型名** —— 这是本项目
 * 最容易踩的坑，务必分清：
 *
 * | 路径 | 端点 | 模型名 | 说明 |
 * |---|---|---|---|
 * | **加密（本适配器默认）** | `api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1` | **目录 key**（`qfmodel` / `dmodel`） | 客户端真实链路；body 由 `src/qoder-wasm.ts` 加密；能拿到 Qwen3.8 系列 |
 * | 公开 | `api2-v2.qoder.sh/model/v1/chat/completions` | 通用名（`qwen-flash`） | 标准 OpenAI；但目录 key 一律 `Unsupported model` |
 *
 * **真实缺陷**（用户报障）：「向 qwen3.8-flash 发消息后没收到回复就终止」。
 * 根因是早期把**目录 key 发给了公开端点** → `invalid_model_error`，
 * 而错误帧又被解析器静默吞掉。
 *
 * ⚠️ `api2.qoder.sh`（加密）与 `api2-v2.qoder.sh`（公开）**不是同一个 host**，
 * 混用会 404。
 *
 * OpenAI 协议层的通用逻辑（消息序列化、SSE 消费、错误归类）复用
 * `src/openai-compat.ts`；加密端点的响应信封由 `src/qoder-envelope.ts` 剥离。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { randomUUID } from 'node:crypto'
import { AccountPool, providerCatalogVisible } from './account-pool.js'
import { writeModelCatalogClosingNew, restoreModelCatalog } from './model-catalog-cache.js'
import { isQoderExpired, type QoderCredential } from './qoder.js'
import { QoderEncryptedInfer, type QoderInferMessage, type QoderInferRequest, type QoderInferTool, type QoderInferToolCall } from './qoder-wasm.js'
import { unwrapQoderEnvelopeStream } from './qoder-envelope.js'
import { QODER, type QoderFallbackModel, type QoderModelPromotion, type QoderProduct } from './qoder-product.js'
import { projectRequestImage, type ImageRequestTarget } from './image-budget.js'
import { buildCosyHeaders } from './qoder-cosy.js'
import {
  registerAdapterIdempotent,
} from './llm-register-compat.js'
import {
  collectImages,
  consumeOpenAiSse,
  contentToText,
  errorDetail,
  httpErrorCode,
  isTransportError,
  ModelQueuedError,
  serializeMessages,
} from './openai-compat.js'
import {
  BILLING_BUSINESS_CODE,
  QUEUE_BUSINESS_CODE,
  QUEUE_MAX_ATTEMPTS,
  QUEUE_MAX_DELAY_MS,
  isBillingBusinessCode,
  isQueueBusinessCode,
  looksLikeBillingError,
  nextUtc8DayStartMs,
  parseQueueError,
  queueDelayMs,
  type QueueInfo,
} from './model-queue.js'

/**
 * 本模块内使用的别名（`export { … as …
 * }` **不会**在模块内建立可用的名字 —— 那只对导入方生效）。
 */
type QoderQueueInfo = QueueInfo
const parseQoderQueueError = parseQueueError
const qoderQueueDelayMs = queueDelayMs

/**
 * ⚠️ **向后兼容的再导出**：排队解析的实现已移到 `src/model-queue.ts`
 * （因为 SSE 消费器也要用，而它不能被本模块反向 import —— 会成环）。
 * 这里保留同名导出，避免既有调用方与测试失效。
 */
export {
  BILLING_BUSINESS_CODE as QODER_BILLING_CODE,
  QUEUE_BUSINESS_CODE as QODER_QUEUE_CODE,
  QUEUE_MAX_ATTEMPTS as QODER_QUEUE_MAX_ATTEMPTS,
  QUEUE_MAX_DELAY_MS as QODER_QUEUE_MAX_DELAY_MS,
  isBillingBusinessCode,
  isQueueBusinessCode,
  looksLikeBillingError,
  nextUtc8DayStartMs,
  parseQueueError as parseQoderQueueError,
  queueDelayMs as qoderQueueDelayMs,
  type QueueInfo as QoderQueueInfo,
}

/**
 * 判断一个错误是否为**额度受限**（`QUOTA_EXCEEDED`）。
 *
 * ⚠️ 必须同时认 `code` **与** `message`：
 * - `code`：`openai-compat` 抛的 `LlmError(…, 'QUOTA_EXCEEDED')`（主判据）；
 * - `message`：兜底 —— 若哪天错误从别的路径冒出来（如未被包装的原始文本），
 *   文案里仍带 `Billing daily count exceeded`，可据此识别。
 *
 * ⚠️ 用 `code` 判据**而不是**重新解析错误文本：`ModelQueuedError` 已证明
 * 「在适配器里重解析一遍」会与上游判定漂移（同一份判据两处实现必然不同步）。
 */
function isQuotaExceededError(error: unknown): boolean {
  if (error instanceof LlmError) {
    if (error.code === 'QUOTA_EXCEEDED' || error.code === 'QUOTA') return true
  }
  if (error instanceof Error) {
    // 仅在**没有**更精确的 code 时用文案兜底（避免把正常文本误判）
    if (!(error instanceof LlmError)) return looksLikeBillingError(error.message)
  }
  return false
}

/** 本适配器注册的 provider 路由名（历史常量，等价于 `QODER.id`）。 */
export const PROVIDER = 'qoder'

/**
 * 思考档位 id → 中文展示名。
 *
 * ⚠️ **必须与官方 IDE 一致**，取证是 asar 里的 i18n 表
 * （`settings.efforts`，`scripts/probe-qoder-effort-i18n2.mjs` 可取）：
 * ```
 * none:关闭思考  minimal:最小  low:低  medium:中  high:高  xhigh:极高  max:最大
 * ```
 * 用户截图里的「关闭思考 / 低 / 中 / 极高 / 最大」正是这套。
 *
 * ⚠️ DSH 的档位选择器**直接渲染 `efforts[].name`**（不本地化），
 * 所以这里给中文就是中文界面 —— 与 Qoder IDE 逐字一致。
 * ⚠️ `minimal` 当前目录未下发，但白名单 `Qj` 里有，保留以备上游启用。
 */
const QODER_EFFORT_NAMES: Readonly<Record<string, string>> = {
  none: '关闭思考',
  minimal: '最小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
}

/**
 * 该模型在 UI 上可选的思考档位（复刻客户端 `gU()` 的行为）。
 *
 * 三条口径：
 * 1. `efforts` 原样取用（目录顺序保持 —— 官方客户端也按对象键序渲染）；
 * 2. `supportsDisable` 为真时**追加** `none`（即「关闭思考」）；
 *    客户端 `gU()`：`… || e.includes('none') ? e : [...e, 'none']`。
 * 3. 两者皆无 → 返回空数组，调用方**不声明 `reasoning`**
 *    （UI 显示「当前模型未提供推理等级」，对应 IDE 的「不支持」）。
 *
 * ⚠️ **`qmodel` / `qmodel_latest` 这类「有 `disabled` 但无 `efforts`」的模型
 * 会得到 `['none']`** —— 即只提供「关闭思考」一项。这是**远端事实**
 * （用户 2026-09-28 确认「上面两个没有思考档位就是关闭的意思」），
 * **不要**给它们补默认档位。
 */
export function qoderEffortsFor(model: QoderFallbackModel): string[] {
  const efforts = [...(model.efforts ?? [])]
  if (model.supportsDisable === true && !efforts.includes('none')) efforts.push('none')
  return efforts
}

/**
 * 排队总时长上限（毫秒），可用 `DSH_QODER_QUEUE_TIMEOUT_MS` 覆盖。
 *
 * ⚠️ **不能用 `parseInt(…) || 默认值`**：`0` 是**合法**配置（表示「不等，立即
 * 判超时」，单测就靠它验证该开关），而 `0` 是 falsy，会被 `||` 静默换成 30 分钟
 * —— 那会让这个开关在「想关掉排队等待」时**恰好失效**。故显式判 `undefined`。
 */
function resolveQueueTimeoutMs(): number {
  const raw = process.env.DSH_QODER_QUEUE_TIMEOUT_MS
  if (raw === undefined || raw.length === 0) return 30 * 60_000
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30 * 60_000
}

/**
 * 读 `AbortSignal.aborted`（**刻意做成函数**）。
 *
 * 为什么不能内联 `signal?.aborted === true`：TS 会在 `await` 之前的一次
 * early-throw 之后把该表达式**静态窄化**为字面量 `false`，于是「等待期间被
 * 中止」这第二次检查会被判为「无重叠的比较」而**编译报错** —— 那个报错本身
 * 是假阳性（`aborted` 是随时间的可变状态）。经函数读取即可保留真实语义，
 * 也把「这里为什么再查一次」的意图写清楚。
 */
function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

/**
 * 从 SSE 层抛出的 {@link ModelQueuedError} 里取出排队信息。
 *
 * `ModelQueuedError.queueInfo` 是已经解析好的 `QueueInfo`，但类型放宽成了
 * `Record<string, unknown>`（共享模块不该暴露 provider 私有类型）。
 * 这里原样取回 —— **不要再解析一次**（那会与已解析的结果产生两套口径）。
 */
function queueInfoOf(error: ModelQueuedError): QoderQueueInfo {
  return error.queueInfo as QoderQueueInfo
}


/**
 * 把 DSH 的工具 schema 映射成加密端点认的 `tools[]`。
 *
 * 形态取自客户端 `$Hc(A)`：
 * `{type:'function', function:{name, description?, parameters?}}` ——
 * `description` / `parameters` **缺省时该键不出现**（不是填空串/空对象）。
 *
 * ⚠️ 这是 `options.tools` 的**唯一出口**。适配器若不下发它，模型在 wire 上
 * 看不到任何函数定义，只能用正文里的 XML 文本臆造工具调用 —— 用户报障
 * 「qwen3.8-flash 执行任务出现任务调用 xml 泄露任务终止」的根因。
 *
 * @param tools - DSH 的 `GenerateOptions.tools`（可能缺席）。
 * @returns 可直接写入请求体顶层 `tools` 的数组；无工具时为空数组。
 */
export function buildQoderTools(
  tools: readonly { name: string; description: string; parameters: Record<string, unknown> }[] | undefined,
): QoderInferTool[] {
  if (tools === undefined || tools.length === 0) return []
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      ...(tool.description.length > 0 ? { description: tool.description } : {}),
      ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
    },
  }))
}

/** {@link buildQoderHistory} 的入参：DSH 序列化后的 wire 消息（OpenAI 形态）。 */
interface QoderWireMessage {
  role?: unknown
  content?: unknown
  tool_calls?: unknown
  tool_call_id?: unknown
}

/** 把 wire 消息的 content 归一化为字符串（工具调用消息的正文是空串）。 */
function qoderContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type: string; text: unknown } =>
        typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
      .map((block) => String(block.text))
      .join('')
  }
  // `null`（assistant 只带 tool_calls 时的 OpenAI 规范值）与畸形值都退化为空串：
  // 客户端 `t2c()` 的 content 恒为字符串（`udn(r, '')`）。
  return ''
}

/**
 * 把 wire 消息的 content 数组**逐字段搬运**成多模态 parts。
 *
 * ## 为什么必须保留数组（真实缺陷，用户报障）
 *
 * 「给 qodercn 的 qwen3.8-flash 发送图片，模型说没读到图片」。
 *
 * 根因**不在** `chat_context.imageUrls` —— 客户端官方实现 `Hyc()` 就把那个字段
 * **恒置 `null`**（obf 产物原文：`function Hyc(A,e,t){return{text:A,features:[],
 * extra:{…},chatPrompt:"",imageUrls:null}}`），我们那行是忠实复刻。
 * 图片的正确通道是 **`messages[].content` 的多模态数组**：客户端 `eQc()` 把
 * `{type:'base64',media_type,data}` 转成 `{type:'image_url',image_url:{url}}`，
 * `bJc()` 再转成 `{type:'input_image',image_url:…}` 后发出。
 *
 * 而上游 `serializeMessages`（`src/openai-compat.ts`）**已经**把图片正确转成了
 * `{type:'image_url',image_url:{url:'data:…'}}` 放进 content 数组 ——
 * 是 `buildQoderHistory` 用 `qoderContentText()` 把它压成纯文本吃掉的。
 *
 * ⚠️ 这是本文件第三个同型缺陷（前两个：`tools` 不下发、工具历史丢
 * `tool_calls`）—— 都是「序列化层没保留多模态结构」。改动时务必三者一起想。
 *
 * ⚠️ **只保留协议认识的两个键**（与 `buildQoderInferPayload` 的「逐字段搬运」
 * 同一原则）：不要把 DSH 的内部字段（`id` / `source` / `attachment` 等）
 * 原样发给上游。
 *
 * @returns 规范化后的 parts；**无图或全部畸形**时返回 undefined（调用方据此
 *          决定是否降级为字符串，以免把纯文本消息也改成数组形态）。
 */
function qoderContentParts(content: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(content)) return undefined
  const parts: Array<Record<string, unknown>> = []
  let hasImage = false
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue
    const block = raw as { type?: unknown; text?: unknown; image_url?: { url?: unknown } }
    if (block.type === 'text') {
      const text = String(block.text ?? '')
      if (text.length > 0) parts.push({ type: 'text', text })
      continue
    }
    if (block.type === 'image_url') {
      // ⚠️ 只搬 `url`：`image_url` 里可能还有 `detail` 等字段，客户端 `bJc()`
      // 只在存在时透传 `detail`，这里与它对齐（缺省不写该键）。
      const url = block.image_url?.url
      if (typeof url !== 'string' || url.length === 0) continue
      const detail = (block.image_url as { detail?: unknown }).detail
      parts.push({
        type: 'image_url',
        image_url: {
          url,
          ...(typeof detail === 'string' && detail.length > 0 ? { detail } : {}),
        },
      })
      hasImage = true
      continue
    }
    // 其余类型（如 Anthropic 风格的 `image`、`tool_result` 内层块）不由本函数处理：
    // 它们要么已被 `serializeMessages` 转成 image_url，要么不属于推理载荷。
  }
  // 无图时返回 undefined，让调用方继续用字符串形态（上游对字符串兼容性最好）。
  return hasImage ? parts : undefined
}

/**
 * 把 `serializeMessages` 的 wire 消息转成加密端点的 `messages[]`。
 *
 * ## 真实缺陷（本次修复）
 *
 * 早期实现写成「只保留 `content` 为字符串的消息」：
 *
 * ```ts
 * messages.filter((m) => typeof m.content === 'string')
 * ```
 *
 * 这有两个后果，都会让**多步工具调用**彻底坏掉：
 * 1. assistant 带工具调用时 `content` 是 **`null`**（OpenAI 规范）→ 整条消息
 *    被丢弃，模型**看不到自己调用过什么**；
 * 2. `role:'tool'` 消息的 `tool_call_id` 被一并丢掉 → 工具结果无法与调用配对。
 *
 * 于是模型只能反复重调同一个工具或凭空编造结果 —— 与 TRAE 那条已记录的
 * 同型缺陷（「消息序列化漏做 → 模型看不到工具调用与结果」）完全一致。
 *
 * 形态对齐客户端：assistant 挂 `tool_calls`，`role:'tool'` 挂 `tool_call_id`。
 */
export function buildQoderHistory(messages: readonly QoderWireMessage[]): QoderInferMessage[] {
  const history: QoderInferMessage[] = []
  for (const message of messages) {
    if (typeof message.role !== 'string') continue
    // ⚠️ 含图消息必须保留 content **数组**（见 `qoderContentParts` 的缺陷说明）；
    // 纯文本仍走字符串，保持与既有形态和上游兼容性逐字节一致。
    const parts = qoderContentParts(message.content)
    const content = parts === undefined ? qoderContentText(message.content) : parts
    const toolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
      ? (message.tool_calls as QoderInferToolCall[])
      : undefined
    const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : undefined
    // 三者皆空的消息没有承载意义（如只有 reasoning 的帧），跳过以免发出
    // 「空 assistant」这种会让上游困惑的条目。
    //
    // ⚠️ 判空必须把**图片**算作内容：`parts` 为非空数组（含 image_url）时
    // 即便 `qoderContentText` 结果为空串也不能丢弃 —— 否则「只发一张图、
    // 不带文字」的消息会被整条吃掉（用户报障场景之一）。
    const isEmpty = parts === undefined
      ? content.length === 0
      : (content as Array<Record<string, unknown>>).length === 0
    if (isEmpty && toolCalls === undefined && toolCallId === undefined) continue
    history.push({
      role: message.role,
      content,
      ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
      ...(toolCallId === undefined ? {} : { tool_call_id: toolCallId }),
    })
  }
  return history
}

/**
 * SSE 空闲超时（毫秒）。
 *
 * 分两阶段：等待首 token 的窗口与两次 chunk 之间的最大静默，均可用环境变量
 * 覆盖（便于测试用短超时触发 TIMEOUT 路径）。**每次 `stream()` 调用时读取**
 * —— 模块顶层常量会在 import 时定型，导致测试里设环境变量不生效。
 *
 * 这层保护的必要性：半开 SSE 连接下 `reader.read()` 会永久挂起，
 * adapter 的 generator 永不返回，会话卡死在「运行中」，用户无法恢复。
 */
function resolveFirstTokenTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_QODER_SSE_FIRST_TOKEN_TIMEOUT_MS ?? '', 10) || 120_000
}
function resolveChunkTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_QODER_SSE_CHUNK_TIMEOUT_MS ?? '', 10) || 120_000
}

/** `QoderAdapter` 的构造选项。 */
export interface QoderAdapterOptions {
  /** 默认凭据 ref（仅用于类型/日志，实际解析走 `resolveCredential`）。 */
  credentialRef: CredentialRef
  /** 从凭据存储解析凭据。 */
  resolveCredential: (modelId?: string) => Promise<QoderCredential | undefined>
  /** 静默续期凭据。 */
  refresh: () => Promise<void>
  /** 多账号池（用于限流时切换账号与模型黑名单）。 */
  accountPool?: AccountPool
  /**
   * 补齐凭据缺失的 **`uid`**（加密推理必需）。
   *
   * ⚠️ 为什么需要这个钩子：`uid` 是后加的字段，**在此之前的旧凭据里没有它**，
   * 而 `generate_runtime_auth_fields` 依赖它派生 `encrypt_user_info`。
   * 缺 uid 时 WASM 产出**签名无效**的请求 → 服务端回
   * `Signature invalid (101)`（真实缺陷，用户报障）。
   *
   * 传入旧凭据，实现应调一次 userinfo 取 `id`、**回写凭据存储**，
   * 并返回补好 uid 的新凭据；无法补齐时返回 undefined。
   *
   * 未提供该钩子、且凭据缺 uid 时，会**明确报错**而不是发出必然失败的请求。
   */
  resolveUid?: (credential: QoderCredential) => Promise<QoderCredential | undefined>
  /**
   * 读取图片附件的原始字节（内联为 data URL 用）。
   *
   * 由调用方桥接 `ctx.attachments.readImage(ref)`；未提供时收到图片会报
   * `UNSUPPORTED_CONTENT`（而不是静默丢弃）。
   */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /**
   * 读取图片附件的**请求版本**（按像素预算与字节目标缩放后的字节）。
   *
   * ⚠️ 与 {@link readImage} 的错误契约**相反**：不可用时必须返回 `undefined`
   * 而不是抛错 —— 缩放是优化，不能因为"想缩图"把一次本来能成功的请求打死。
   * 判据与回退都在共享的 `projectRequestImage` 里（buddy / raccoon 用同一份）。
   *
   * 背景（issue !IKITT9）：qoder 撞的是**请求体体积**上限（实测 8 张原图能过、
   * 15 张 ≈57 MiB 直接 `TRANSPORT: fetch failed`），与腾讯的图片 token 预算
   * 是两种约束，但同样只能靠缩放解决。
   */
  readImageRequest?: (
    attachment: unknown,
    target: ImageRequestTarget,
  ) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 产品配置；默认 {@link QODER}。 */
  product?: QoderProduct
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
  /**
   * 当前生效账号的 id（额度受限时用于**标记该账号**）。
   *
   * ⚠️ 做成**回调**而不是构造期常量：账号会在 `refreshAll` / 限流切换 /
   * Channel Pack 手动启停后变化，构造期快照会标记到**已经不再使用**的账号上。
   * 未提供时跳过标记（仍会尝试切号），不会因此崩。
   */
  currentAccountId?: () => string | undefined
  /**
   * 注入的休眠实现（**测试用**）。
   *
   * 排队重试要真等（最长 10s × 180 次），单测不能真睡 —— 注入后即可断言
   * 「等了几次、每次多久」，并在毫秒级完成。
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** Qoder 模型适配器。使用 Bearer access_token 鉴权，仅支持 SSE。 */
/**
 * 远端模型目录路径（挂 `product.catalogBase`，需 COSY 签名）。
 *
 * `Encode=1` 只影响**请求体**编码，GET 无体，故这里保留参数与原样一致。
 */
const QODER_CATALOG_PATH = '/algo/api/v2/model/list?Encode=1'

/**
 * 目录缓存有效期（1 小时），与上游参考实现同步。
 *
 * 上游 `providers/qoder/models.rs` 的注释：「缓存 1 小时；失败保留现有清单」。
 * 目录变动不是秒级事件，1 小时既不放大请求量（每渠道每小时最多 1 次），
 * 又能让新上架模型在一个工作时段内出现。
 */
const QODER_CATALOG_TTL_MS = 3_600_000

/**
 * 解析 Qoder 目录响应为**完整的兜底表同构条目**。
 *
 * ## ⚠️ 三个曾经踩过的坑（2026-10-26 实测，都必须保留注释）
 *
 * 1. **`id` 必须取 `key`，不是 `display_name`**。
 *    上游参考实现用 display_name 去空白当 id（它对 `key` 另有 `upstreamKey`
 *    字段），但**我们的架构里 `QoderFallbackModel.id` 就是目录 key**
 *    （`qoder-product.ts` 的字段注释：「模型目录 **key**（如 `qfmodel`）」，
 *    加密推理端点也只认 key）。照抄上游会让远端条目 id=`Auto` 而兜底表
 *    id=`auto` —— 并集去重完全失效，同一个模型在列表里出现两次。
 * 2. **`price_factor` 必须带出来**，否则远端条目的展示名没有倍率后缀
 *    （用户一眼看到「模型没有倍率」，正是这个漏的）。
 *    注意 **0 是合法倍率**（免费），不能用 `> 0` 过滤。
 * 3. **并集不能无条件「远端优先」**。远端条目若字段不全（例如目录某天不返回
 *    `price_factor`），会覆盖掉兜底表里带倍率的同 id 条目。故这里产出的条目
 *    是**补全后**的完整形态；`modelSource` 再按「兜底优先、远端补新」合并。
 *
 * ## 字段映射（均已对照真实响应）
 *
 * | 目标字段 | 上游字段 | 说明 |
 * |---|---|---|
 * | `id` | `key` | 加密推理端点认它 |
 * | `name` | `display_name` | 展示名原文 |
 * | `priceFactor` | `price_factor` | 0 = 免费，合法 |
 * | `originalPriceFactor` | `original_price_factor` | 促销前原价 |
 * | `contextWindow` | `context_config` **档位最大值** | **不是** `max_input_tokens` |
 * | `supportsImage` | `is_vl` | |
 * | `supportsThinking` | `is_reasoning` 或 `thinking_config` | |
 * | `isFree` | `is_free` | |
 * | `promotion` | `promotion` | active/discount_factor/before_promotion_price_factor/window_* |
 */
export function parseQoderCatalog(
  payload: unknown,
  fallbackModels: readonly QoderFallbackModel[] = [],
): QoderFallbackModel[] {
  if (payload === null || typeof payload !== 'object') return []
  const chat = (payload as Record<string, unknown>).chat
  if (!Array.isArray(chat)) return []
  const local = new Map(fallbackModels.map((model) => [model.id, model]))
  const out: QoderFallbackModel[] = []
  const seen = new Set<string>()
  for (const raw of chat) {
    if (raw === null || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const key = typeof item.key === 'string' ? item.key.trim() : ''
    const displayName = typeof item.display_name === 'string' ? item.display_name.trim() : ''
    // ⚠️ 只有 key 是必需的。`display_name` 缺失的条目按既有约定**跳过**（无法
    // 给出可读名）；但 `display_name` **等于内部编码**时不能原样显示 —— 那会让
    // 模型列表出现 `qmodel_38max` 这类字段（用户 2026-10-26 报障）。此时退回
    // 兜底表的本地化名，再不行才用原始 key。
    if (key === '' || displayName === '') continue
    if (seen.has(key)) continue
    seen.add(key)
    const localName = local.get(key)?.name
    const name = displayName === key && localName !== undefined && localName !== key
      ? localName
      : displayName
    // 上下文窗口：取档位表的**最大档**（官方客户端只认档位表；max_input_tokens
    // 经常自相矛盾，兜底表注释里有 CN dmodel 的实例）。
    let contextWindow = 200_000
    const contextConfig = item.context_config
    if (contextConfig !== null && typeof contextConfig === 'object') {
      for (const tier of Object.values(contextConfig as Record<string, unknown>)) {
        if (tier === null || typeof tier !== 'object') continue
        const count = (tier as Record<string, unknown>).token_count
        if (typeof count === 'number' && Number.isFinite(count) && count > contextWindow) contextWindow = count
      }
    }
    const priceFactor = typeof item.price_factor === 'number' ? item.price_factor : undefined
    const originalPriceFactor = typeof item.original_price_factor === 'number'
      ? item.original_price_factor
      : undefined
    // 思考档位：`thinking_config.enabled.efforts` 的**键名**即档位 id，
    // 其中 `is_default: true` 的那一项是默认档；`thinking_config.disabled`
    // 存在表示官方允许「关闭思考」（对应 `supportsDisable`，由适配器追加 `none`）。
    //
    // ⚠️ 不解析它就会退化成「远端覆盖兜底表 + 档位字段全丢」——
    // 用户报障「更新上游模型后没法选思考程度了」正是此因（2026-10-26）。
    const thinking = item.thinking_config
    let efforts: string[] | undefined
    let defaultEffort: string | undefined
    let supportsDisable: boolean | undefined
    if (thinking !== null && typeof thinking === 'object') {
      const config = thinking as Record<string, unknown>
      if (config.disabled !== undefined && config.disabled !== null) supportsDisable = true
      const enabled = config.enabled
      if (enabled !== null && typeof enabled === 'object') {
        const menu = (enabled as Record<string, unknown>).efforts
        if (menu !== null && typeof menu === 'object') {
          const levels = Object.keys(menu as Record<string, unknown>)
          if (levels.length > 0) efforts = levels
          for (const level of levels) {
            const detail = (menu as Record<string, unknown>)[level]
            if (detail !== null && typeof detail === 'object'
              && (detail as Record<string, unknown>).is_default === true) defaultEffort = level
          }
        }
      }
    }
    const entry: QoderFallbackModel = {
      id: key,
      name,
      contextWindow,
      supportsImage: item.is_vl === true,
      supportsThinking: item.is_reasoning === true
        || (item.thinking_config !== undefined && item.thinking_config !== null),
      ...(item.is_free === true ? { isFree: true } : {}),
      ...(priceFactor === undefined ? {} : { priceFactor }),
      ...(originalPriceFactor === undefined ? {} : { originalPriceFactor }),
      ...(efforts === undefined ? {} : { efforts }),
      ...(defaultEffort === undefined ? {} : { defaultEffort }),
      ...(supportsDisable === undefined ? {} : { supportsDisable }),
    }
    const promotion = parseQoderPromotion(item.promotion)
    if (promotion !== undefined) entry.promotion = promotion
    out.push(entry)
  }
  return out
}

/** 解析目录里的 `promotion`（错峰折扣）。形状不全时返回 undefined。 */
function parseQoderPromotion(raw: unknown): QoderModelPromotion | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const item = raw as Record<string, unknown>
  const discountFactor = typeof item.discount_factor === 'number' ? item.discount_factor : undefined
  const before = typeof item.before_promotion_price_factor === 'number'
    ? item.before_promotion_price_factor
    : undefined
  const windowStart = typeof item.window_start === 'string' ? item.window_start : undefined
  const windowEnd = typeof item.window_end === 'string' ? item.window_end : undefined
  if (discountFactor === undefined && before === undefined && windowStart === undefined) return undefined
  const badge = item.badge
  const badgeZh = badge !== null && typeof badge === 'object'
    ? (badge as Record<string, unknown>).zh
    : undefined
  return {
    active: item.active === true,
    ...(discountFactor === undefined ? {} : { discountFactor }),
    ...(before === undefined ? {} : { beforePromotionPriceFactor: before }),
    ...(windowStart === undefined ? {} : { windowStart }),
    ...(windowEnd === undefined ? {} : { windowEnd }),
    ...(typeof badgeZh === 'string' ? { badgeText: badgeZh } : {}),
  }
}

export class QoderAdapter extends LlmAdapter {
  private readonly product: QoderProduct
  private readonly fetchImpl: typeof fetch
  /** 产品级兜底模型索引（`product.fallbackModels` 的 id → 条目）。 */
  private readonly fallbackIndex: ReadonlyMap<string, QoderFallbackModel>
  /**
   * 远端目录缓存（COSY 签名拉取）；`undefined` 表示还没成功拉到过。
   *
   * ⚠️ 类型必须是完整的 `QoderFallbackModel`，**不能**收窄成
   * `{ id, name, supportsImage }`：思考档位（`efforts`/`defaultEffort`/
   * `supportsDisable`）与上下文窗口都要从这里流到 `resolveModel`，
   * 收窄会让「更新上游后没法选思考程度」复发（2026-10-26 用户报障）。
   */
  private remoteModels: QoderFallbackModel[] | undefined
  /** 上次成功拉取的时刻（配合 TTL 判断是否重拉）。 */
  private remoteModelsAt = 0
  /** 进行中的拉取（并发请求共用同一个 Promise，避免打爆上游）。 */
  private loadingRemote: Promise<void> | undefined

  constructor(private readonly options: QoderAdapterOptions) {
    super()
    this.product = options.product ?? QODER
    this.fetchImpl = options.fetchImpl ?? fetch
    this.fallbackIndex = new Map(
      (this.product.fallbackModels ?? []).map((model) => [model.id, model]),
    )
  }

  /**
   * 可中止的休眠；信号中止时立即 resolve（不抛错，由调用方检查 signal）。
   *
   * ⚠️ **必须响应 `signal`**：排队等待最长可达 30 分钟，用户中途取消会话时
   * 不能让 generator 卡在 `setTimeout` 里 —— 那会表现为「点了停止但没反应」。
   */
  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.options.sleep !== undefined) {
      await this.options.sleep(ms, signal)
      return
    }
    if (ms <= 0 || signal?.aborted === true) return
    await new Promise<void>((resolve) => {
      const onAbort = (): void => { clearTimeout(timer); resolve() }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页
   * 会用该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。
   * 一旦 provider 不是字符串（上游传入 undefined），直接回退到本产品的 id，
   * 避免 `undefined.toUpperCase is not a function` 在客户端炸开。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 模型接受的输入模态。
   *
   * 按**模型**判定（兜底表的 `supportsImage`），不是按 provider 一刀切。
   * 未声明时**保守报 text**：宁可少报能力（用户改用文本描述），
   * 也不要报一个服务端不认的模态（请求会失败）。
   *
   * ⚠️ 兜底表是本地估计值，不是远端权威数据 —— 见 `qoder-product.ts` 的说明。
   */
  private inputModalitiesFor(model: string): readonly ('text' | 'image')[] {
    return this.entryFor(model)?.supportsImage === true ? ['text', 'image'] : ['text']
  }

  /**
   * 拉取远端模型目录（COSY 签名），带 TTL 缓存。
   *
   * ## 为什么现在能拉了
   *
   * 此前注释写「目录端点需要 WASM 签名，本插件不实现」—— 那是个**误判**：
   * 签名不需要 WASM，用 Node 原生 `crypto` 就能复刻（见 `qoder-cosy.ts`，
   * 算法逐行对照上游 `providers/qoder/cosy.rs`）。2026-10-26 实测：
   * 带 COSY 头请求 `{catalogBase}/algo/api/v2/model/list?Encode=1`，
   * 国际版回 **14 个模型**、国内版回 **10 个** —— 而只带 Bearer 是
   * `403 {"code":"101","message":"Signature invalid"}`。
   *
   * ## 失败策略
   *
   * 与上游一致：**失败保留现有清单**（`remoteModels` 不动），而不是清空。
   * 清空会让「网络抖一下」变成「模型全没了」。拉不到时 `listModels` 自然
   * 回落到产品兜底表。
   */
  private async ensureRemoteModels(): Promise<void> {
    if (this.remoteModels !== undefined && Date.now() - this.remoteModelsAt < QODER_CATALOG_TTL_MS) return
    if (this.loadingRemote !== undefined) return this.loadingRemote
    this.loadingRemote = (async () => {
      try {
        const credential = await this.options.resolveCredential()
        if (credential === undefined || credential.access_token === '') return
        const url = `${this.product.catalogBase}${QODER_CATALOG_PATH}`
        const headers = buildCosyHeaders(undefined, url, {
          userId: credential.uid ?? '',
          authToken: credential.access_token,
          name: credential.nickname ?? '',
          email: '',
          machineId: credential.machine_id,
        })
        const response = await this.fetchImpl(url, {
          method: 'GET',
          headers: { Accept: 'application/json', ...headers },
        })
        if (!response.ok) return
        const payload: unknown = await response.json().catch(() => undefined)
        const rows = parseQoderCatalog(payload, this.product.fallbackModels)
        if (rows.length > 0) {
          this.remoteModels = rows
          this.remoteModelsAt = Date.now()
          void writeModelCatalogClosingNew(this.product.id, rows, this.options.accountPool)
        }
      } catch {
        // 兜底表接管（含 uid 缺失时 buildCosyHeaders 抛错的情况）。
      } finally {
        this.loadingRemote = undefined
      }
    })()
    await this.loadingRemote
    // 远端这次没拉到：用上次成功落盘的快照顶替编译期兜底表（用户 2026-10-27）。
    this.remoteModels = restoreModelCatalog(this.product.id, this.remoteModels)
  }

  /**
   * 可用模型集合：**远端与兜底的并集**（远端优先）。
   *
   * 取并集而不是替换，理由与 autoclaw 相同：目录下发的集合可能**不完整**
   * （权限、灰度、套餐档位都会影响），而兜底表里的模型实测可用。直接替换会
   * 让用户「模型突然少了几个」。
   */
  /**
   * 按 id 取模型条目：**远端优先，兜底补缺**。
   *
   * ⚠️ **倍率必须以远端为准**（用户 2026-10-26 指出「本地兜底表的倍率都是
   * 过期的」）。实测差异（qoder 14 个里 4 个不一致）：
   *
   * | id | 远端 | 兜底 |
   * |---|---|---|
   * | `qmodel_38max` | 0.5 | 0.2 |
   * | `kmodel_latest` | 1 | 1.4 |
   * | `dfmodel` | **0（免费）** | 0.1 |
   * | `mmodel` | 0.1 | 0.2 |
   *
   * 兜底表是**采集时刻的快照**，上游随时会调价 —— 拿它当权威会让用户按错误
   * 倍率预期计费。故所有展示/解析路径都走这里，而不是裸 `fallbackIndex`。
   *
   * 远端未就绪（还没拉到 / 拉取失败）时才退回兜底，这是唯一的数据源。
   */
  private entryFor(modelId: string): QoderFallbackModel | undefined {
    const remote = this.remoteModels?.find((model) => model.id === modelId)
    return remote ?? this.fallbackIndex.get(modelId)
  }

  private modelSource(): readonly QoderFallbackModel[] {
    // 远端内存目录 → 落盘快照 → 编译期兜底表（用户 2026-10-27）。
    const remoteModels = restoreModelCatalog<QoderFallbackModel>(this.product.id, this.remoteModels)
    if (remoteModels === undefined) return this.product.fallbackModels
    /**
     * **远端直接覆盖兜底**（用户 2026-10-26 明确要求）。
     *
     * 与 autoclaw 的「并集」策略不同，这里是覆盖：Qoder 的目录是**权威清单**，
     * 兜底表只是「拉不到时」的离线快照。并集的问题在于兜底表里已被上游下架的
     * 模型（如旧套餐档位）会一直留在列表里 —— 用户会选到不能用的模型。
     *
     * ⚠️ 但覆盖的前提是**远端条目字段必须完整**：`parseQoderCatalog` 已把
     * id(key)/name/priceFactor/contextWindow/promotion **以及思考档位**（
     * `thinking_config` → `efforts`/`defaultEffort`/`supportsDisable`）全部映射好。
     *
     * ⚠️ 思考档位**不做兜底补齐**（用户 2026-10-27）：「远端给什么，就用什么，
     * 远端无思考程度，就算本地有也没用的啊。」档位 id 必须被上游接受，本地表里
     * 的值只会在用户点下去之后被静默忽略或报错，比不显示更糟。
     *
     * 2026-10-26 曾在此按兜底表补齐（当时用户报障「模型还在，但思考程度选不了」）；
     * 那条需求已被本次决定覆盖：远端某次没下发 `thinking_config` 时，宁可不显示
     * 档位选择器，也不要给一个可能不生效的值。
     */
    return remoteModels
  }
  /**
   * 完整模型目录（**不应用用户黑名单**），含最终展示名（倍率/免费标记）。
   *
   * 设置页必须渲染被关闭的模型（否则用户无法重新打开），而 `listModels` 会按
   * 黑名单过滤掉它们 —— RPC 层只能凭裸 id 补回，展示名与倍率随之丢失
   * （用户报障：「关闭的就没有显示倍率」）。详见 `model.list` 端点的注释。
   */
  /**
   * 预热远端目录（供 `provider.status` 这类**异步**入口调用）。
   *
   * `listAllModels()` 是同步契约（多处依赖它不触发网络），所以设置页的模型名
   * 只能读已缓存的 `remoteModels`。首次打开设置页时远端还没拉过，就会显示
   * 兜底表的**过期倍率**（用户 2026-10-26 指出「本地兜底表的倍率都是过期的」）。
   * 这里让异步调用方先等一次远端，再把同一份数据交给同步读取。
   *
   * 失败静默（兜底表接管），与 `ensureRemoteModels` 同语义。
   */
  async warmCatalog(): Promise<void> {
    await this.ensureRemoteModels()
  }

  /**
   * **强制**重新拉取远端目录（忽略 TTL），供界面的「重新获取模型」按钮使用。
   *
   * 与 {@link warmCatalog} 的区别：后者只保证「有一份数据」，TTL 内直接返回缓存；
   * 用户点按钮时意图是「上游刚改了目录，现在就要拿最新的」，必须绕过 TTL。
   *
   * 返回 `true` 表示这次真的拿到了新目录；`false`（网络失败 / 凭据失效 /
   * 该渠道无远端目录）时**保留旧数据**且不抛错 —— 调用方据此提示用户即可。
   */
  async refreshCatalog(): Promise<boolean> {
    const previous = this.remoteModelsAt
    // 清零 TTL 标记，让 `ensureRemoteModels` 的短路条件失效。
    this.remoteModelsAt = 0
    await this.ensureRemoteModels()
    const refreshed = this.remoteModelsAt !== 0 && this.remoteModelsAt !== previous
    // 失败时恢复原标记，避免下一次 `warmCatalog` 做无谓的重拉。
    if (!refreshed) this.remoteModelsAt = previous
    return refreshed
  }

  listAllModels(): readonly { id: string; name: string }[] {
    // ⚠️ 同步方法：只能读**已缓存**的远端目录；未预热时退回兜底表。
    // 倍率以远端为准（见 `entryFor` 的对比表），故异步入口应先 `warmCatalog()`。
    return this.modelSource().map((model) => ({ id: model.id, name: qoderDisplayName(model) }))
  }

  /**
   * 单个 id 的**友好展示名**（找不到返回 undefined）。
   *
   * 供 `model.list` 在「补回被关闭/已失效的模型」时使用：那些 id 不在当前
   * 目录里，RPC 层原本只能拿裸 id 当名字 —— 而 Qoder 的 id 是内部编码
   * （`qmodel_38max`），界面就会出现「qmodel 等字段」（2026-10-26 用户报障）。
   *
   * 查表顺序：**兜底表优先**（本地化名最稳，且不依赖远端是否下架该模型），
   * 再退回远端目录。两者都没有才由调用方用裸 id。
   */
  displayNameFor(modelId: string): string | undefined {
    const local = this.fallbackIndex.get(modelId)
    if (local !== undefined) return qoderDisplayName(local)
    const remote = this.remoteModels?.find((model) => model.id === modelId)
    return remote === undefined ? undefined : qoderDisplayName(remote)
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠️ 没有任何已登录账号时返回空数组 → DSH 的 `buildModelCatalog` 把整个
    // provider 分组隐藏（它显式 `.filter(group => group.models.length > 0)`）。
    // ⚠️ 必须返回 `[]` 而**不能抛错**（抛错会被归入 catalog 的 `failures`，
    // 界面上反而多出一条 provider 报错）。
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return []
    // 先尝试拉远端目录（带 1 小时 TTL；失败静默回落兜底表）。
    await this.ensureRemoteModels()
    // 用户在 Channel Pack 关闭的模型（黑名单制：不在表里即默认打开）。
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const source = this.modelSource()
    const listed = disabled === undefined || disabled.size === 0
      ? source
      : source.filter((model) => !disabled.has(model.id))
    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      // 倍率拼进 `name`（**不是** `description`）：composer 的模型切换菜单
      // 只渲染 name，description 仅用于 /model 弹窗。见 qoderDisplayName。
      name: qoderDisplayName(model),
      inputModalities: this.inputModalitiesFor(model.id),
    }))
  }

  /**
   * 解析模型元信息。
   *
   * ⚠️ **`reasoning` 是「思考强度」选择器出现在模型菜单里的唯一入口**
   * （composer 读 `resolveModel().reasoning`）。此前本适配器**只声明了
   * `context`，从不声明 `reasoning`** → 中国版/国际版全都看不到档位选择器，
   * 尽管目录早已下发 `thinking_config`（用户报障「qoder中国版可以设置思考档位，
   * 我们应该按照他的设置给出可设置的档位选择」）。
   */
  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    // 异步入口：先预热远端目录，避免用兜底表的过期倍率/上下文。
    await this.ensureRemoteModels()
    // 远端优先：兜底表的 name/contextWindow 都是采集时快照（倍率尤其会过期）。
    const entry = this.entryFor(model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      // ⚠️ 用 `qoderDisplayName`（带倍率后缀 + 中文档位名），不是裸 `entry.name`。
      // composer 与 /model 弹窗都读这个 name —— 裸名会让「倍率」在会话内消失，
      // 只有选择器里有（用户会以为两处不一致）。
      name: entry === undefined ? model : qoderDisplayName(entry),
      inputModalities: this.inputModalitiesFor(model),
    }
    // 上下文窗口：兜底表是**本地估计值**。未知模型不编造 context
    // （宁可让 DSH 用默认值，也不要报一个假的窗口大小）。
    if (entry !== undefined) resolved.context = { contextWindow: entry.contextWindow }
    // 思考档位：见 `qoderEffortsFor` 的三条口径（含「关闭思考」的追加规则）。
    if (entry !== undefined) {
      const efforts = qoderEffortsFor(entry)
      if (efforts.length > 0) {
        const fallback = entry.defaultEffort
        resolved.reasoning = {
          efforts: efforts.map((id) => ({
            id: ReasoningEffortId(id),
            name: QODER_EFFORT_NAMES[id] ?? id,
          })),
          // ⚠️ `defaultEffort` 必须落在 `efforts` 内 —— DSH 会直接拿它发请求，
          // 给一个不存在的档位会抛 `UNSUPPORTED_REASONING_EFFORT`
          // （同 `trae-adapter.ts` 的教训）。
          ...fallback !== undefined && efforts.includes(fallback)
            ? { defaultEffort: ReasoningEffortId(fallback) }
            : {},
        }
      }
    }
    return resolved
  }

  /**
   * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
   * 基类尚未提供该方法，缺少时会在每轮请求开始时抛
   * `registration.adapter.prepareCall is not a function`。
   * 与 `BuddyAdapter` / `LobsteraiAdapter` 同款 shim。
   */
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
    // 图片能力按**模型**判定（兜底表 supportsImage）。
    //
    // 这里**不能**放宽成「总是接受」：DSH 在 LlmRuntime 里按适配器播报的
    // `inputModalities` 决定要不要把图片投影成文本占位符，声明支持就必须真支持。
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      if (!this.inputModalitiesFor(options.model).includes('image')) {
        throw new LlmError(
          `qoder: 模型 "${options.model}" 不支持图片输入`,
          'UNSUPPORTED_CONTENT',
        )
      }
      if (this.options.readImage === undefined) {
        throw new LlmError('qoder: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT')
      }
      // 保留**空 Map**（而非降级为 undefined）：图片存在但全部读取失败时，
      // 空 Map 仍会让 userContentParts 产出 [image unavailable] 占位符。
      imageUrls = new Map()
      const readImage = this.options.readImage
      for (const [id, ref] of imageRefs) {
        // ⚠️ 先试**请求版本**（缩放），拿不到才发原图 —— 见 projectRequestImage。
        const projected = await projectRequestImage(ref, {
          readImageRequest: this.options.readImageRequest,
          pixelBudget: this.product.imagePixelBudget,
          maxBytes: this.product.imageMaxBytes,
        })
        const image = projected ?? await readImage(ref)
        if (image === undefined) continue
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
      }
    }

    // 1. 获取凭据（过期则先静默续期）
    let credential = await this.options.resolveCredential(options.model)
    if (credential === undefined || isQoderExpired(credential)) {
      await this.options.refresh()
      credential = await this.options.resolveCredential(options.model)
    }
    if (credential === undefined || credential.access_token.length === 0) {
      throw new LlmError('qoder: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }

    // 2. 补齐 **uid**（加密推理必需）。
    //
    // ⚠️ `uid` 是后加字段，旧凭据里没有；缺它时 WASM 会产出**签名无效**的
    // 请求，服务端回 `Signature invalid (101)`（真实缺陷，用户报障）。
    // 这里调用注入的钩子补一次（实现会调 userinfo 并回写凭据）。
    credential = await this.ensureUid(credential)

    // 3. 走**加密推理**路径（客户端真实链路，认模型目录 key）。
    //
    // 目录 key（`qfmodel` 等）只有这条路能用；公开端点是另一套通用名。
    const messages = serializeMessages(options.messages, imageUrls)
    const systemText = options.system !== undefined && options.system.length > 0
      ? options.system
      : undefined

    /** 最后一条 user 消息即本轮提问；其余作为历史。 */
    const userMessages = messages.filter((m) => m.role === 'user')
    const lastUser = userMessages.at(-1)
    // ⚠️ 带图消息的 content 是**多模态数组**（见 `qoderContentParts`），
    // 只判 `typeof === 'string'` 会让 `chat_context.text` / `originalContent`
    // 退化成空串 —— 那会让模型收到「一张没有配文的图」，与用户实际输入不符。
    // 故两种形态都要取文本（数组时取其中的 text 块）。
    const userText = typeof lastUser?.content === 'string'
      ? lastUser.content
      : (Array.isArray(lastUser?.content)
          ? (lastUser.content as Array<{ type?: unknown; text?: unknown }>)
              .filter((block) => block.type === 'text')
              .map((block) => String(block.text ?? ''))
              .join('')
          : '')
    // ⚠️ 必须走 buildQoderHistory：早期内联的「只留 content 为字符串」过滤器
    // 会丢掉 assistant 的 tool_calls（content 为 null）与 tool 的 tool_call_id，
    // 使多步工具调用彻底坏掉（模型看不到自己调用过什么）。
    const history = buildQoderHistory(messages)
    // ⚠️ 工具定义必须真的下发：加密端点的顶层 `tools`。不下发时模型只能
    // 用正文里的 XML 文本臆造工具调用 → harness 认不出 → 任务终止
    // （用户报障「qwen3.8-flash 执行任务出现任务调用 xml 泄露任务终止」）。
    const tools = buildQoderTools(options.tools)

    // 远端优先（倍率/上下文以目录为准，兜底只是离线快照）。
    const fallback = this.entryFor(options.model)

    /** 用给定凭据构造一次加密请求（首次与 401 重试共用，避免两处漂移）。 */
    const buildRequest = async (c: QoderCredential): Promise<QoderInferRequest> => {
      const client = await QoderEncryptedInfer.create({
        user: {
          uid: c.uid!,
          securityOauthToken: c.security_oauth_token ?? c.access_token,
        },
        machineId: c.machine_id,
        metadata: { ...this.product.clientMetadata },
        host: this.product.encryptedInferBase,
      })
      return client.prepareInfer({
        modelKey: options.model,
        userText,
        ...(systemText !== undefined ? { systemText } : {}),
        isReasoning: fallback?.supportsThinking ?? false,
        history,
        // 工具定义：这是模型**唯一**能学到函数 schema 的通道，
        // 缺了它模型只能用正文 XML 臆造调用（真实缺陷）。
        tools,
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
        ...(fallback?.supportsImage !== undefined ? { isVl: fallback.supportsImage } : {}),
        // 官方 `model_config` 的 display_name / max_input_tokens 必须带上。
        ...(fallback?.name !== undefined ? { displayName: fallback.name } : {}),
        ...(fallback?.contextWindow !== undefined ? { maxInputTokens: fallback.contextWindow } : {}),
        // ⚠️ **`business` 必填**，否则服务端把请求路由到错误的后端节点。
        //
        // 实测（2026-09-20）：不带 `business` 时 `qfmodel`（Qwen3.8-Flash）
        // 恒落到故障节点 `oa_qwen-plus-2025-04-28` 并返回
        // `[FAIL]node:... msg:Execution failed`；补上 `business` 后立即正常
        // （其余模型如 `qmodel_38max` 恰好不受影响，故早期排查易误判为
        // 「该模型服务端故障」）。`agent` / `sec_scan` 等取值都能通。
        //
        // 源码依据：`MPi(A) { return A === 'sec_scan' ? 'security' : 'default' }`
        // —— 服务端按 `business.type` 选路由池，缺字段会走异常分支。
        business: { type: 'agent' },
      })
    }

    // 3. 发送（⚠️ 头必须原样透传：Authorization 是 WASM 生成的
    //    `Bearer COSY.<载荷>.<签名>`，用普通 Bearer 覆盖会 403 Signature invalid）
    //
    // ## 三种 403 的语义**互不相同**，必须分开处理
    //
    // | 形态 | 判据 | 处理 |
    // |---|---|---|
    // | **排队** | 业务码 `10605`（`model_queued`） | 按服务端给的延迟**内部等待后重试**（见下） |
    // | 重复请求 | 业务码（客户端 `_TA="duplicate_request"`） | 不刷新凭据，直接重发一次 |
    // | 认证失败 | 业务码 `105`（`auth_error`）或 401 | 续期凭据后重试（**唯一**该走 refresh 的情形） |
    //
    // ⚠️ **真实缺陷**（用户报障，2026-09-27）：旧实现把**所有** 401/403 都当认证
    // 失败 → 排队时白白续期一次，再落到 harness 的 5 次通用退避（500/1000/2000/
    // 4000/8000 ≈ 共 15.5 秒）—— 而服务端明确要求等 30 秒，于是**永远等不到**；
    // 中国版那条「等 2 秒就能成功」的瞬时排队也因走错路径而反复失败。
    const queueDeadline = Date.now() + resolveQueueTimeoutMs()
    let queueAttempts = 0
    let authRefreshed = false
    let duplicateRetried = false
    let response: Response
    /**
     * 已尝试过的账号 id（额度受限切号用）。
     *
     * ⚠️ 必须跨重试保留（不能在每次迭代里新建）：它是「**已试过哪些账号**」的
     * 记录，用来保证每个账号最多试一次、试完才判定「全部受限」。每次迭代重置
     * 会让切换在两个账号之间**无限来回**。
     */
    const triedAccounts = new Set<string>()
    /**
     * **当前生效账号的 id**（会随额度受限切号而更新）。
     *
     * ⚠️ 是**局部可变**状态、而不是每次都问 `this.options.currentAccountId()`：
     * 那个回调返回的是「池当前的默认账号」，一旦我们切到下一个账号它**不会跟着变**
     * —— 若用它标记，切到 B 后失败时会**再标记一次 A**，而 B 从未被标记，
     * 下次取号又把 B 选中，于是在 A/B 之间**反复空转**
     *（写单测时实测到了：标记记录是 `['acct-A','acct-A']` 而非 `['acct-A','acct-B']`）。
     */
    let activeAccountId = this.options.currentAccountId?.()
    if (activeAccountId !== undefined && activeAccountId.length > 0) {
      triedAccounts.add(activeAccountId)
    }
    // 4. 剥掉加密端点的响应信封，交给统一的 OpenAI SSE 消费器。
    //
    // ⚠️ **必须放在重试循环内**：排队错误的**第二种**下发形态是
    // **HTTP 200 + SSE 内嵌 `{code:"10605",…}` 帧**（真实缺陷，用户报障
    // 2026-09-27 —— 第一版修复只覆盖了 HTTP 403 形态，于是这条路径被
    // SSE 消费器归为 `SERVER` 直接抛给 harness，以 500…8000ms 快退避重试
    // 5 次，而服务端要求等 30 秒，**永远等不到**）。
    for (;;) {
      response = await this.sendEncrypted(await buildRequest(credential), options)

      if (!response.ok && (response.status === 401 || response.status === 403)) {
        // ⚠️ 必须**先读体再判断**，且 body 只能读一次 —— 排队信息就藏在
        // `message` 那个 JSON 字符串里（见 `parseQoderQueueError`）。
        const errorText = await response.text().catch(() => '')
        const queueInfo = parseQoderQueueError(errorText)

        if (queueInfo !== undefined) {
          await this.waitForQueue(queueInfo, ++queueAttempts, queueDeadline, options)
          continue
        }

        // ⚠️ **额度受限也要切账号**（用户要求，2026-09-27）。
        //
        // 这条与 SSE 层那条**必须都有**：Qoder 的额度错误实测走 SSE 通道
        // （HTTP 200），但若哪天服务端改成用 HTTP 状态码下发，只处理一条就会漏。
        // 两处调用**同一个** `switchAccountOnQuota`，不会漂移。
        if (isBillingBusinessCode(response.status) || looksLikeBillingError(errorText)) {
          const switched = await this.switchAccountOnQuota(options, triedAccounts, activeAccountId)
          if (switched !== undefined) {
            credential = switched.credential
            activeAccountId = switched.accountId
            authRefreshed = false // 新账号可再续期一次
            continue
          }
          throw new LlmError(`qoder: ${errorDetail(errorText)}`, 'QUOTA_EXCEEDED', { status: response.status })
        }

        // 非排队：认证失败才续期（且每次请求最多一次，避免刷爆 userinfo）。
        if (!authRefreshed) {
          authRefreshed = true
          await this.options.refresh()
          const refreshed = await this.options.resolveCredential(options.model)
          if (refreshed === undefined || refreshed.access_token.length === 0) {
            throw new LlmError('qoder: credential expired and refresh failed', 'AUTH', { status: response.status })
          }
          credential = await this.ensureUid(refreshed)
          continue
        }
        throw new LlmError(`qoder: ${errorDetail(errorText)}`, httpErrorCode(response.status), { status: response.status })
      }

      // 重复请求（客户端 `duplicate_request`）：凭据没问题，重发一次即可。
      if (!response.ok && response.status === 409 && !duplicateRetried) {
        duplicateRetried = true
        continue
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => '')
        throw new LlmError(`qoder: ${errorDetail(errorText)}`, httpErrorCode(response.status), { status: response.status })
      }

      // ⚠️ 消费 SSE 时**捕获流内排队错误**，走与 HTTP 层**完全相同**的等待逻辑。
      // `consumeOpenAiSse` 是生成器：无法「try 一次再重试」，故这里手动迭代，
      // 捕获到排队就等待后重发整条请求（排队期间未产出任何 chunk，可安全重放）。
      const inner = consumeOpenAiSse(
        unwrapQoderEnvelopeStream(response, 'qoder'),
        { signal: options.signal },
        {
          label: 'qoder',
          firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
          chunkTimeoutMs: resolveChunkTimeoutMs(),
          ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        },
      )
      const iterator = inner[Symbol.asyncIterator]()
      let queued = false
      for (;;) {
        let step: IteratorResult<StreamChunk>
        try {
          step = await iterator.next()
        } catch (error) {
          if (error instanceof ModelQueuedError) {
            await this.waitForQueue(
              queueInfoOf(error),
              ++queueAttempts,
              queueDeadline,
              options,
            )
            queued = true
            break
          }
          // ⚠️ **额度受限（110）要标记 + 切账号**（用户要求，2026-09-27）。
          //
          // ⚠️ 必须**在这里**捕获（SSE 层）而不只在 HTTP 层：Qoder 的额度错误
          // 实测以 **HTTP 200 + SSE 内嵌帧** 下发（与排队同通道），
          // 只在 HTTP 层处理会漏掉真实链路。
          if (isQuotaExceededError(error)) {
            const switched = await this.switchAccountOnQuota(options, triedAccounts, activeAccountId)
            if (switched !== undefined) {
              credential = switched.credential
              activeAccountId = switched.accountId
              queued = true // 复用「回到循环顶部重发」的语义
              break
            }
            throw error // 无可用账号 → 如实抛出（已含额度语义）
          }
          throw error
        }
        if (step.done === true) break
        yield step.value
      }
      if (queued) continue
      return
    }
  }

  /**
   * 额度受限时：**标记当前账号该模型受限到 UTC+8 当日 24:00，然后切下一个账号**。
   *
   * ## 用户要求（2026-09-27）
   *
   * > qoder 碰到当日额度受限应该像 workbuddy/codebuddy 一样，设置一个模型受限时间
   * > （他们是返回错误中带时间，qoder 和 qodercn 需要自己设置当日 24:00 受限）
   * > 然后切换账号池中的下一个可用模型
   *
   * ## ⚠️ 与 buddy/CodeArts 的**关键差异**
   *
   * 它们的错误文案里**带重置时间**（`parseRateLimitError` 从中解析）；
   * Qoder **不带** —— 故这里用 {@link nextUtc8DayStartMs} **自己算**
   * 「UTC+8 当日 24:00」。**不能**复用 `parseRateLimitError`：它会因解析不到
   * 时间而退回「1 小时后」（`Date.now() + 3_600_000`），那对**按自然日**结算的
   * 额度是错的 —— 会让标记过早失效，用户 1 小时后再撞一次同样的墙。
   *
   * @param activeAccountId - **当前正在使用的**账号 id（见下）。
   * @returns 新凭据；无可用账号时 `undefined`（调用方如实抛出原错误）。
   */
  private async switchAccountOnQuota(
    options: GenerateOptions,
    tried: Set<string>,
    activeAccountId: string | undefined,
  ): Promise<{ credential: QoderCredential; accountId: string } | undefined> {
    const pool = this.options.accountPool
    if (pool === undefined) return undefined

    // ① 记录「本账号 + 本模型」受限到 UTC+8 当日 24:00。
    //
    // ⚠️ 只标记**该模型**（不标记账号全部模型）：额度是「模型 + 账号」维度的，
    // 该账号在别的模型上仍可能可用（`modelRateLimits` 的既有语义即如此）。
    //
    // ⚠️ 用的是调用方传入的 `activeAccountId`，**不是** `this.options.currentAccountId()`：
    // 后者是「会话启动时/池当前的默认账号」，一旦我们切换到下一个账号，它**不会
    // 跟着变** —— 若用它标记，切到 B 后失败时会**再标记一次 A**，而 B 从未被标记，
    // 下次取号又把 B 选中，导致在 A/B 之间**反复空转**（写单测时实测到了：
    // 标记记录是 `['acct-A','acct-A']` 而非 `['acct-A','acct-B']`）。
    if (activeAccountId !== undefined && activeAccountId.length > 0) {
      await pool.updateModelRateLimit(activeAccountId, options.model, nextUtc8DayStartMs())
      tried.add(activeAccountId)
    }

    // ② 取下一个可用账号。
    //
    // ⚠️ 必须传 `tried`：池按「限流重置时间最早到期」排序，**刚失败的账号可能
    // 仍排第一**，不排除就会拿回同一个、命中下面的检查而立即放弃切换。
    // （与 buddy 的注释同因，见 `buddy-adapter.ts` 的 1200 行附近。）
    const next = await pool.getAvailableAccount(this.product.id, options.model, tried)
    if (next === null || tried.has(next.entry.id)) return undefined
    tried.add(next.entry.id)

    const credential = next.credential as QoderCredential
    // 切号后必须重新过一遍 uid 补齐（每个账号的 uid 不同，缺了会签名无效）。
    return { credential: await this.ensureUid(credential), accountId: next.entry.id }
  }

  /**
   * 排队等待（HTTP 层与 SSE 层**共用**）。
   *
   * 两处形态必须走同一套判据，否则会再次出现「只修了一条路径」的缺陷。
   */
  private async waitForQueue(
    queueInfo: QoderQueueInfo | undefined,
    attempts: number,
    deadline: number,
    options: GenerateOptions,
  ): Promise<void> {
    // ⚠️ **先判时间、再判次数**：时间上限是硬约束（用户可调），次数上限只是
    // 防御性兜底。反过来写会让「180 次空转」在绝大多数情况下先生效，
    // 使 `DSH_QODER_QUEUE_TIMEOUT_MS` **形同虚设**（写用例时实测到了）。
    //
    // ⚠️ 用 `>=` 而不是 `>`：上限为 **0** 是合法配置（「不等，立即判超时」），
    // 而同一毫秒内 `Date.now() > now + 0` 为 **false**，会让它**先等一次**才
    // 超时 —— 那与「0 = 不等待」的语义不符（单测专门守这一点）。
    if (Date.now() >= deadline) {
      throw new LlmError('qoder: 排队等待超时', 'QUEUE')
    }
    if (attempts > QUEUE_MAX_ATTEMPTS) {
      throw new LlmError(
        `qoder: 排队重试超过上限（${QUEUE_MAX_ATTEMPTS} 次）`,
        'QUEUE',
      )
    }    if (options.signal?.aborted === true) {
      throw new LlmError('qoder: 排队等待期间请求已取消', 'QUEUE')
    }
    const waitMs = qoderQueueDelayMs(queueInfo)
    // ⚠️ 拿不到服务端延迟时**不忙等**：用保守的短退避，避免瞬间烧掉机会
    // （客户端 W7c() 此时会退回 ltA() 指数退避）。
    await this.sleep(waitMs ?? 1_000, options.signal)
    // ⚠️ 这次检查**不是**上一次的重复：它检测的是「**等待期间**被中止」。
    // `AbortSignal.aborted` 是随时间的可变状态，但 TS 会静态窄化成字面量
    // `false` 而报「无重叠」—— 故经**不透明函数**读取，避免静态收窄掩盖
    // 这个真实场景（`await` 之后状态可能已变）。
    if (isAborted(options.signal)) {
      throw new LlmError('qoder: 排队等待期间请求已取消', 'QUEUE')
    }
    // ⚠️ 排队**不刷新凭据**、不换账号：它与认证和额度都无关。
  }

  /**
   * 确保凭据带 **`uid`**（加密推理必需），必要时经注入钩子补齐。
   *
   * ⚠️ 缺 uid 时**不能静默用空串发请求** —— 那样 WASM 会产出签名无效的
   * 请求，服务端回 `Signature invalid (101)`，用户看到的是「签名错误」
   * 而非「凭据不完整」，极难定位（真实缺陷）。这里宁可明确报错。
   */
  private async ensureUid(credential: QoderCredential): Promise<QoderCredential> {
    if (credential.uid !== undefined && credential.uid.length > 0) return credential

    const patched = await this.options.resolveUid?.(credential)
    if (patched?.uid !== undefined && patched.uid.length > 0) return patched

    throw new LlmError(
      'qoder: 凭据缺少 uid，加密推理无法签名（请重新登录该账号）',
      'MISSING_CREDENTIAL',
    )
  }

  /** 发送一次**加密**推理请求（`agent_chat_generation`）。 */
  private async sendEncrypted(
    request: { url: string; headers: Record<string, string>; body: string },
    options: GenerateOptions,
  ): Promise<Response> {
    const headers = new Headers(request.headers)
    headers.set('Accept', 'text/event-stream')
    try {
      return await this.fetchImpl(request.url, {
        method: 'POST',
        headers,
        body: request.body,
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      if (isTransportError(error)) {
        throw new LlmError(`qoder: transport error: ${error instanceof Error ? error.message : String(error)}`,
          'TRANSPORT', { cause: error as Error })
      }
      throw error
    }
  }
}

/**
 * 判断当前是否落在错峰折扣窗口内（本地推算）。
 *
 * ⚠️ **为什么不直接用目录的 `promotion.active`**：那是**目录下发那一刻**的
 * 快照，客户端长时间不重启就会过期 —— 用它会让用户在窗口外看到折后价
 * （按折扣价预期、实际按原价计费），或窗口内看不到折扣。
 * 窗口本身（`windowStart`/`windowEnd`）稳定，故按当前时间**本地推算**。
 *
 * 窗口按 **UTC+8** 计（目录 `timezone: Asia/Singapore`，与用户所在时区一致）；
 * 支持跨零点（如 22:00–08:00）。窗口字段缺失时回退到目录的 `active`。
 */
export function promotionActiveNow(promotion: QoderModelPromotion, now: Date): boolean {
  const { windowStart, windowEnd } = promotion
  if (windowStart === undefined || windowEnd === undefined) return promotion.active
  const toMinutes = (hhmm: string): number | undefined => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
    if (m === null) return undefined
    const h = Number(m[1]); const min = Number(m[2])
    return h < 24 && min < 60 ? h * 60 + min : undefined
  }
  const start = toMinutes(windowStart)
  const end = toMinutes(windowEnd)
  if (start === undefined || end === undefined) return promotion.active

  // 取 UTC+8 的「墙上时间」（目录时区与用户一致，故无需真实时区换算）
  const utc8 = new Date(now.getTime() + 8 * 3_600_000)
  const minutes = utc8.getUTCHours() * 60 + utc8.getUTCMinutes()
  return start <= end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end
}

/**
 * 生成模型选择器里显示的名字。
 *
 * 形态（**与 TRAE / buddy 三 provider 统一**）：
 *
 * ```
 * Qwen3.8-Flash · 免费            ← priceFactor = 0
 * Qwen3.8-Max · x0.5→x0.2        ← 折扣窗口内：原价→折后价
 * Qwen3.8-Max · x0.5             ← 窗口外：只有原价
 * Sonus · x8                     ← 无促销
 * ```
 *
 * ⚠️ **倍率必须写进 `name` 而不是 `description`**：composer 的模型切换菜单
 * 只渲染 `name`（见 dsh-client-ui-model-selection 的 ModelSelect：
 * `children: model.name`），`description` 仅用于 `/model` 弹窗。
 *
 * ⚠️ **折扣统一用「原价→折后价」箭头**，不再附中文角标（如「错峰 4 折」）：
 * ① 旧形态只有折后价，看不出原价与折扣幅度；② 角标与数字**冗余**
 * （0.2/0.5 本就是 4 折）。TRAE（`x0.4→x0.2`）与 buddy（`x0.79→x0.50`）
 * 早就是这个形态，本次把 Qoder 对齐过去。
 *
 * ⚠️ 折后价**不直接采信目录的 `priceFactor`**：它是采集时刻的生效价，
 * 窗口切换后即失真。改为按 `beforePromotionPriceFactor × discountFactor`
 * 本地推算（实测三条全部吻合），窗口外则用原价。
 */
/**
 * Qoder 目录里那几个「档位型」模型的中文名。
 *
 * 上游目录**不提供中文名**（实测 `display_name` 恒为英文 Auto / Ultimate /
 * Efficient / Performance 等），官方中文客户端是在前端做本地映射的。
 * 用户要求「自动 / 平衡 / 快速之类的中文名就用中文」（2026-10-26）。
 *
 * ⚠️ 只映射**档位型**条目（Auto/Balanced/Efficient/Performance 这类抽象档），
 * **不要**映射有具体产品名的模型（GLM-5.3、DeepSeek-V4-Pro、Kimi-K3 等）——
 * 那些名字是产品标识，翻译反而让人认不出。
 */
const QODER_CHINESE_NAMES: Readonly<Record<string, string>> = {
  auto: '自动',
  ultimate: '旗舰',
  performance: '平衡',
  efficient: '快速',
}

/** 取模型的中文展示名（无映射时原样返回）。 */
function qoderLocalizedName(model: QoderFallbackModel): string {
  return QODER_CHINESE_NAMES[model.id] ?? model.name
}

export function qoderDisplayName(model: QoderFallbackModel, now: Date = new Date()): string {
  const name = qoderLocalizedName(model)
  /**
   * ## 倍率口径（2026-10-26 对照 magpie 的 @magpie-community/opencode-qoder-auth 修正）
   *
   * magpie 的 `rateOf()` / `freeOf()` 是从真实使用中总结出来的，两条关键规则：
   *
   * 1. **`price_factor` 本身就是「当前生效价」，不要再拿 `before × discount`
   *    去重算**。旧实现只要促销 active 就用 `before × discount` 覆盖，
   *    若目录恰在**窗口内**采集（此时 `price_factor` 已是折后价），就会
   *    **重复打折**，显示出比实际更低的价。
   * 2. **`price_factor === 0` 不一定是免费**：促销 active 且有原价时，
   *    那个 0 是「折扣到 0」的占位，真实价是 `before × discount`。
   *    只有「0 且无进行中的促销」才是真免费（Qwen3.8-Flash 那种长期 0×）。
   *
   * 划线价只在**确实高于当前价**时显示（`rateWas > rate`），否则不显示 ——
   * 避免 `x0.5→x0.5` 这种噪声。
   */
  const promo = model.promotion
  const before = promo?.beforePromotionPriceFactor
  const discount = promo?.discountFactor
  const active = promo !== undefined && promotionActiveNow(promo, now)

  let rate = model.priceFactor
  // 无倍率字段 → **只显示名字**，不编造 x1（用户明确要求）。
  if (typeof rate !== 'number') return name

  let rateWas = model.originalPriceFactor
  const hasBefore = typeof before === 'number' && before > 0
  if (active && hasBefore) {
    // 窗口内：当前价用 `price_factor`（它已是折后生效价），划线价是原价。
    rateWas = before
    // 促销到 0 但真实不免费：用 before × discount 还原真实价。
    if (rate === 0 && typeof discount === 'number' && discount > 0) {
      rate = Number((before * discount).toFixed(4))
    }
  } else if (hasBefore) {
    /**
     * **窗口外：按原价计费，显示原价**。
     *
     * `price_factor` 是「目录下发那一刻」的快照 —— 若恰好在窗口内采集，它是
     * 折后价；到了窗口外实际按原价扣费。直接显示折后价会让用户按低价预期、
     * 实际被按原价计费（旧实现这里就是显示 `before`，是对的，必须保留）。
     * 此时不打折，故**不显示划线**（rateWas 置空）。
     */
    rate = before
    rateWas = undefined
  }

  if (rate === 0) return `${name} · 免费`
  // 只在原价确实更高时显示「原价→现价」。
  if (typeof rateWas === 'number' && rateWas > rate) return `${name} · x${rateWas}→x${rate}`
  return `${name} · x${rate}`
}

/**
 * 在 `ctx.llm` 上注册 Qoder provider 路由与适配器。
 *
 * 路由名与展示名由产品配置驱动，得到 `qoder`。
 *
 * ⚠️ 刻意**不**向 DSH 声明可配置 provider（`registerConfigurableProviders`）——
 * 详见 `llm-register-compat.ts` 模块头。
 */
export function registerQoderLlm(ctx: Context, options: QoderAdapterOptions): QoderAdapter {
  const product = options.product ?? QODER
  const adapter = new QoderAdapter(options)
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  // 返回实例：Channel Pack「显示列表」需要 `listAllModels()`（不受黑名单影响、
  // 带最终展示名/倍率）。`ctx.llm` 不透传自定义方法，须由调用方持有引用。
  return adapter
}
