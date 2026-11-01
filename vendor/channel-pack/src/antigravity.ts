/**
 * Gemini（Google Cloud Code Assist 免费线）协议层：产品常量、凭据、字母序信封、
 * 模型档表与 JSON Schema 清洗。
 *
 * ## 来源与取证基准
 *
 * 逐点移植自 `F:\project\cmdc-pak-align-wb\internal\upstream\antigravity\`
 * （`client.go` / `model.go` / `translate.go` / `types.go`）。
 * ⚠️ 常量基准 = cmdc-pak **0.8.6.1（两轮 MITM）+ 0.8.8（oracle 61 探针）**；
 * `cmdc-pak v0.8.9.exe` 已全量字符串加密（`x-machine-id` / `antigravity` /
 * 两个 sessionId / `aicode-consumers` / `v1internal` 全部 0 命明文），
 * 静态取证失效。详见 `docs/ANTIGRAVITY-PORT-PLAN.md` §九。
 *
 * ## 三条必须保留的上游对齐细节（计划 §2.2）
 *
 * 1. **身份五头逐字写死、不许随机**（{@link ANTIGRAVITY_IDENTITY_HEADERS}）。
 *    ⚠️ 且**不带** `x-goog-api-key` / `x-goog-api-client`。
 * 2. **流式请求刻意不带 `Accept` 头** —— 抓包一致。见 {@link antigravityHeaders}
 *    的 `includeAccept` 开关（默认 false）。
 * 3. **信封逐层字母序序列化**（{@link marshalAlphabetical}）。Go 的
 *    `encoding/json` 对 `map` 键自动字母序排，而 TS 的 `JSON.stringify`
 *    按 V8 插入序 —— 不排序就与上游看到的字节不同。
 *
 * ## ⚠️ 2026-10-05 更正：`sessionId` 不是常量
 *
 * 早前按历次抓包把推理/冒烟各钉一个常量（`3124275334370613369` /
 * `-6686302828062879362`）。真机对照实验推翻了它：
 *
 *     sessionId = f(project, contents[0].text, lane)
 *
 * 换 project 会变；换 model / maxOutputTokens / systemInstruction / 对话轮数
 * 都不变。那两个"常量"只是**特定输入的输出**被反复抓到。
 *
 * 写死的后果是**所有用户、所有对话共用一个会话** —— 而原版的会话归并与
 * `thoughtSignature` 回填都挂在这个字段上。现在走
 * {@link deriveGeminiSessionId} 确定性派生（同对话稳定、跨对话隔离）。
 *
 * 注意：原版哈希本体尚未反推出来（已否证 50+ 种），故**取值不与原版逐字相同**，
 * 对齐的是依赖维度与"同输入同输出"。`ANTIGRAVITY_SESSION_ID_*` 仅作覆盖示例保留。
 *
 * ## 实测确认的三条事实（计划 §七）
 *
 * - **模型名是准入钥匙**：发裸 `gemini-3.8-flash` 上游 404，必须带档位后缀
 *   （`gemini-3.8-flash-high`）。
 * - **lite 已整体移除**（用户 2026-10-03 拍板「不要 lite 模型」）：真机实测
 *   `gemini-3.8-flash-lite` 在两端点上**恒 404**
 *   （`{"error":{"code":404,"message":"Requested entity was not found.","status":"NOT_FOUND"}}`），
 *   与是否传档位无关 ⇒ 该模型名不在本账号的准入表里，暴露它只会让用户选中即失败。
 * - **思考预算是自由旋钮**：名字叫 `medium` 但预算给 10000 → 实测 213 token；
 *   给 4000 → 164 token。名字只是标签，预算才是行为。
 * - **「关闭思考」是假关**：关掉 `includeThoughts` 照样思考照样计费
 *   （实测 195 token）⇒ 不提供 `none` 档，`includeThoughts` **恒 true**。
 */

import { randomBytes } from 'node:crypto'
import type { LlmModelReasoningInfo } from '@deepseek-ai/dsh-llm'
import { LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { DEFAULT_IMAGE_PIXEL_BUDGET } from './image-budget.js'

// ---------------------------------------------------------------------------
// 端点
// ---------------------------------------------------------------------------

/** 主端点（`client.go` 的 `EndpointDaily`）。 */
export const ANTIGRAVITY_ENDPOINT_DAILY = 'https://daily-cloudcode-pa.googleapis.com'
/** 沙箱端点（`client.go` 的 `EndpointSandbox`）。 */
export const ANTIGRAVITY_ENDPOINT_SANDBOX = 'https://daily-cloudcode-pa.sandbox.googleapis.com'
/**
 * prod 端点（Agent2API `V1_BASE_URL_PROD`；2026-11-01 补）。
 *
 * ⚠️ project 发现（loadCodeAssist / onboardUser）**固定走 prod**：规格坑 #16 +
 * Agent2API `PROJECT_BASE_URL` 的注释原话「the daily host rejects these
 * auth/onboarding calls」—— 之前只登记 daily/sandbox 两条是缺口。
 */
export const ANTIGRAVITY_ENDPOINT_PROD = 'https://cloudcode-pa.googleapis.com'
/**
 * 端点轮换顺序（原版 `NewClient` 的初始 `endpoints`）。
 *
 * ⚠️ 用户 2026-10-03 澄清：**两端点的差异未获实验支持**（404 与 project 两类
 * 失败在两端点上行为完全一致）。换端点**零成本无害**，但**不能当 quota 的
 * 有效解法** —— 主救场手段是**换账号**。
 */
export const ANTIGRAVITY_ENDPOINTS: readonly string[] = [ANTIGRAVITY_ENDPOINT_DAILY, ANTIGRAVITY_ENDPOINT_SANDBOX]

/** 流式推理路径（SSE）。 */
export const ANTIGRAVITY_STREAM_PATH = '/v1internal:streamGenerateContent?alt=sse'
/** 配额查询路径（**Summary 变体**，请求体见 `antigravity-credits.ts`）。 */
export const ANTIGRAVITY_QUOTA_PATH = '/v1internal:retrieveUserQuotaSummary'
/**
 * 远端模型目录路径（`fetchAvailableModels`，2026-11-01 接入）。
 *
 * 三环境轮流（Agent2API 规格 §3.1：sandbox → daily → prod，429/5xx/传输失败
 * 才换下一条；4xx 不换 —— 那是「这次请求本身不对」）。实测个人 free-tier
 * 账号三个环境都下发全量清单。
 */
export const ANTIGRAVITY_FETCH_AVAILABLE_MODELS_PATH = '/v1internal:fetchAvailableModels'
/**
 * 账号档位 / 项目探测路径。
 *
 * 面板的「账号规格」一栏用它（原版 `project.go:15` 的 `loadCodeAssistPath`，
 * 但原版的 `loadCodeAssistResponse` **没有 `paidTier` 字段**，故原版区分不开
 * pro / free —— 见 `antigravity-credits.ts` 的 `parseGeminiAccountTier`）。
 */
export const ANTIGRAVITY_LOAD_CODE_ASSIST_PATH = '/v1internal:loadCodeAssist'
/**
 * 档位探测的请求体（**逐字**，content-length 恰为 38）。
 *
 * ⚠️ 对齐原版 `project.go:97-103`：**不带** `platform` / `pluginType` /
 * `cloudaicompanionProject`，多一个字段就可能被上游识别成非官方客户端。
 */
export const ANTIGRAVITY_LOAD_CODE_ASSIST_BODY = '{"metadata":{"ideType":"ANTIGRAVITY"}}'

// ---------------------------------------------------------------------------
// 身份伪装（逐字常量，不许随机）
// ---------------------------------------------------------------------------

/**
 * 上游身份五头。
 *
 * ⚠️ **逐字写死**：任何一个字符不同都可能被上游识别为非官方客户端。
 * ⚠️ **不要**加 `x-goog-api-key` / `x-goog-api-client` —— 原版不带。
 */
export const ANTIGRAVITY_IDENTITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'User-Agent': 'antigravity/4.3.0 (cmdc-pak)',
  'x-client-name': 'antigravity',
  'x-client-version': '4.3.0',
  'x-machine-id': 'cmdc-pak',
  'x-vscode-sessionid': 'proxy',
})

// ---------------------------------------------------------------------------
// 项目与会话常量
// ---------------------------------------------------------------------------

/**
 * 上游项目号（`loadCodeAssist` 探测为空/失败时的**兜底**）。
 *
 * ⚠️ 2026-10-05 更正：这不是"恒为此值"。真机对照实验证明原版读
 * `loadCodeAssist` 的 `cloudaicompanionProject`（假上游返回 `CCP-TWO`，
 * 信封里就是 `CCP-TWO`）。免费档账号的 LCA 返回空 project，才回落到这个串
 * —— 这也是历次抓包都看到 `aicode-consumers` 的原因。
 */
export const ANTIGRAVITY_DEFAULT_PROJECT = 'aicode-consumers'

/**
 * 两条会话派生路径的标签。
 *
 * ⚠️ 2026-10-05 更正：早前以为这两条路径各自对应一个**预置常量**
 * （推理 `3124275334370613369` / 冒烟 `-6686302828062879362`）。真机对照实验
 * 推翻了它：`sessionId = f(project, contents[0].text, lane)`，那两个"常量"
 * 只是特定输入的输出被反复抓包，被误当成了身份常量。
 *
 * 因此标签不再参与**取值**，只用于区分两条派生路径（lane 进哈希）。
 */
export const ANTIGRAVITY_SESSION_LANE_INFER = 'infer'
export const ANTIGRAVITY_SESSION_LANE_SMOKE = 'smoke'

/**
 * 按 `(project, 首条 user 文本, lane)` **确定性派生** sessionId。
 *
 * ⚠️ 取"首条 user 文本"的规则见 `antigravity-messages.ts` 的 `antigravityFirstUserText`
 * （只有 `contents[0]` 参与、且只看其中的文本 part）。
 *
 * 与原版的依赖维度对齐（2026-10-05 真机对照实验）：
 *
 * - **吃**：`project`、`contents[0]` 的文本、lane（推理 / 冒烟）
 * - **不吃**：model、maxOutputTokens、systemInstruction、对话轮数、后续文本、机器特征
 *
 * ⚠️ **取值不与原版逐字相同**。原版的哈希函数本体尚未反推出来（已否证
 * FNV-1a/1、murmur64A、MD5/SHA 系列等 50+ 种），这里用 FNV-1a 复刻的是
 * **依赖维度与"同输入同输出"**，不是数值。想要数值一致得先做动态断点。
 *
 * 输出形态对齐原版：有符号 int64 的十进制串（原版取到的值正负都有）。
 *
 * ## `generation`（会话升代自愈）
 *
 * 上游按 `sessionId` 在**服务端**累计对话输入；长工具循环会把累计推过 1M，
 * 此后该 sessionId 的**每个**请求都 400
 * `The input token count exceeds the maximum number of tokens allowed 1048576`，
 * 直到该服务端会话过期。升一代 = 换一个全新 sessionId = 上游开新会话，
 * 对话无感恢复（`Antigravity-Manager` 的 `[FIX session-1M]` 与 wb 的
 * `SessionOverflowBump` 是两个独立佐证）。
 *
 * ⚠️ `generation === 0` 时**不把代数拼进输入** —— 必须与升代前逐字同值，
 * 否则升级这个功能本身就会让所有进行中的对话换一次 sessionId（丢 prompt cache）。
 */
export function deriveGeminiSessionId(
  project: string,
  firstUserText: string,
  lane: string,
  generation: number = 0,
): string {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  const base = `${project}\u0000${lane}\u0000${firstUserText}`
  const input = generation > 0 ? `${base}\u0000${generation}` : base
  for (const byte of Buffer.from(input, 'utf8')) {
    hash = (hash ^ BigInt(byte)) & mask
    hash = (hash * prime) & mask
  }
  // 按**有符号** 64 位解释（原版取值有正有负）。
  return BigInt.asIntN(64, hash).toString()
}

// ---------------------------------------------------------------------------
// 超时与缓存
// ---------------------------------------------------------------------------

/**
 * SSE 空闲超时（毫秒）。
 *
 * ⚠️ 与 minimax / cline 等适配器同款：上游在生成大 functionCall 参数期间
 * 可能长时间不 flush 任何字节，裸 `reader.read()` 会**无限期挂起**
 * （表现为「发消息后永远转圈」）。超时归类为可重试的 `TIMEOUT`，
 * harness 才能重试该步骤。
 */
export const ANTIGRAVITY_IDLE_TIMEOUT_MS = 120_000
/** 配额查询超时。 */
export const ANTIGRAVITY_CREDITS_TIMEOUT_MS = 30_000
/** 配额缓存 TTL（原版 `quotaCacheTTL`）。 */
export const ANTIGRAVITY_QUOTA_CACHE_TTL_MS = 60_000
/** 凭据过期余量（原版 `Credentials.Valid()` 留 60 秒）。 */
export const ANTIGRAVITY_EXPIRY_LEAD_MS = 60_000

// ---------------------------------------------------------------------------
// 产品
// ---------------------------------------------------------------------------

/** Gemini 产品描述（与 minimax 的 `MinimaxProduct` 同形态）。 */
export interface AntigravityProduct {
  readonly id: string
  readonly displayName: string
  readonly defaultCredentialRef: string
  /** 图片像素预算（第一跳缩放用）。 */
  readonly imagePixelBudget: number
  /** 默认最大输出 token（用户 2026-10-03 定为 64000，原版是 65536）。 */
  readonly maxOutputTokens: number
}

export const ANTIGRAVITY: AntigravityProduct = {
  id: 'antigravity',
  displayName: 'Google Antigravity',
  defaultCredentialRef: 'ANTIGRAVITY_ACCESS_TOKEN',
  imagePixelBudget: DEFAULT_IMAGE_PIXEL_BUDGET,
  maxOutputTokens: 64_000,
}

// ---------------------------------------------------------------------------
// 凭据
// ---------------------------------------------------------------------------

/**
 * Gemini 凭据（原版 `oauth.Credentials`）。
 *
 * ⚠️ 字段名与 OAuth 响应**逐字一致**（`access_token` / `expiry` …），
 * 因为整份 JSON 会被原样落盘并在刷新时回写。
 */
export interface AntigravityCredential {
  access_token: string
  refresh_token?: string
  token_type?: string
  expires_in?: number
  scope?: string
  /** RFC3339 时间戳（原版 `expiry`）。 */
  expiry?: string
  sub?: string
  email?: string
  cloudaicompanionProject?: string
}

/**
 * 解析凭据 JSON。
 *
 * ⚠️ **失败返回 `undefined` 而不抛错**（与 `parseMinimaxCredential` 同口径）：
 * 凭据损坏是**可预期**的运行态（用户手工编辑过、旧版本格式），
 * 抛错会让整批 `refreshAll` 中断。
 */
export function parseGeminiCredential(value: string): AntigravityCredential | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const raw = parsed as Record<string, unknown>
  if (typeof raw.access_token !== 'string' || raw.access_token === '') return undefined
  const out: AntigravityCredential = { access_token: raw.access_token }
  if (typeof raw.refresh_token === 'string' && raw.refresh_token !== '') {
    out.refresh_token = raw.refresh_token
  }
  if (typeof raw.token_type === 'string' && raw.token_type !== '') out.token_type = raw.token_type
  if (typeof raw.expires_in === 'number' && Number.isFinite(raw.expires_in)) {
    out.expires_in = raw.expires_in
  }
  if (typeof raw.scope === 'string' && raw.scope !== '') out.scope = raw.scope
  if (typeof raw.expiry === 'string' && raw.expiry !== '') out.expiry = raw.expiry
  if (typeof raw.sub === 'string' && raw.sub !== '') out.sub = raw.sub
  if (typeof raw.email === 'string' && raw.email !== '') out.email = raw.email
  if (typeof raw.cloudaicompanionProject === 'string' && raw.cloudaicompanionProject !== '') {
    out.cloudaicompanionProject = raw.cloudaicompanionProject
  }
  return out
}

/**
 * 凭据过期时刻（毫秒）。
 *
 * ⚠️ 取不到时返回 `undefined`（**不编造**）—— `shouldRefreshNow` 会把它当作
 * 「需要续期」，从而走一次真实的 refresh 请求；比假装没过期安全。
 */
export function antigravityCredentialExpiresAtMs(credential: AntigravityCredential): number | undefined {
  const expiry = credential.expiry
  if (typeof expiry !== 'string' || expiry === '') return undefined
  const parsed = Date.parse(expiry)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 凭据是否已过期（含 60 秒余量，同原版 `Valid()`）。 */
export function isGeminiExpired(credential: AntigravityCredential, nowMs: number = Date.now()): boolean {
  const expiresAt = antigravityCredentialExpiresAtMs(credential)
  if (expiresAt === undefined) return false
  return expiresAt - nowMs <= ANTIGRAVITY_EXPIRY_LEAD_MS
}

/** 凭据是否具备续期材料。 */
export function isGeminiRefreshable(credential: AntigravityCredential): boolean {
  return typeof credential.refresh_token === 'string' && credential.refresh_token !== ''
}

/** 取用户身份显示名（昵称用）。 */
export function antigravityAccountLabel(credential: AntigravityCredential): string | undefined {
  if (typeof credential.email === 'string' && credential.email !== '') return credential.email
  if (typeof credential.sub === 'string' && credential.sub !== '') return credential.sub
  return undefined
}

/**
 * 构造推理请求头。
 *
 * ⚠️ `includeAccept` 默认 **false**：流式请求**刻意不带 `Accept` 头**
 *（抓包一致）。调用方若要发非流式请求，可显式传 true。
 * ⚠️ 身份五头**逐字**注入，且**不注入** `x-goog-api-key`。
 */
export function antigravityHeaders(
  credential: AntigravityCredential,
  options: { includeAccept?: boolean } = {},
): Headers {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${credential.access_token}`)
  headers.set('Content-Type', 'application/json')
  for (const [key, value] of Object.entries(ANTIGRAVITY_IDENTITY_HEADERS)) headers.set(key, value)
  if (options.includeAccept === true) headers.set('Accept', 'application/json')
  return headers
}

// ---------------------------------------------------------------------------
// 字母序序列化
// ---------------------------------------------------------------------------

/**
 * 递归按键名升序重建值（数组保持顺序）。
 *
 * ⚠️ **不是**为了好看 —— 上游看到的是字节。Go 侧 `marshalAlphabetical`
 * 先 `json.Marshal` 再 `Decode` 到 `any`（得到 `map[string]any`）再 `Marshal`，
 * 于是整棵树（含 `args` 里的用户参数）都变成按字母序的 map。本函数等价。
 *
 * ⚠️ 键全为 ASCII 时，`Array.prototype.sort()` 的 UTF-16 码元序与 Go 的
 * 字节序一致；信封里所有键都是 ASCII。
 */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) out[key] = sortValue(source[key])
  return out
}

/** 按键名升序序列化（{@link sortValue} 的 JSON 出口）。 */
export function sortedStringify(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

/** 与上游一致的字母序信封序列化（Go `marshalAlphabetical` 的等价物）。 */
export function marshalAlphabetical(value: unknown): string {
  return sortedStringify(value)
}

/** 生成每请求随机的 requestId（原版 `newRequestID()`）。 */
export function newGeminiRequestId(nowMs: number = Date.now()): string {
  return `agent/${nowMs}/${randomBytes(4).toString('hex')}`
}

// ---------------------------------------------------------------------------
// 模型档表
// ---------------------------------------------------------------------------

/** 思考档位。 */
export type AntigravityTier = 'low' | 'medium' | 'high' | 'tiered'

/** 主模型上游名（**不带**档位后缀，后缀由 {@link antigravityModelSpec} 拼）。 */
export const ANTIGRAVITY_UPSTREAM_FLASH = 'gemini-3.8-flash'

export const ANTIGRAVITY_BUDGET_LOW = 1_000
export const ANTIGRAVITY_BUDGET_MEDIUM = 4_000
export const ANTIGRAVITY_BUDGET_HIGH = 10_000
/** tiered 档：只发 `includeThoughts`，**不发** `thinkingBudget`。 */
export const ANTIGRAVITY_BUDGET_TIERED = -1

/** 上下文窗口（用户拍板填 1_000_000）。 */
export const ANTIGRAVITY_CONTEXT_WINDOW = 1_000_000

/** 一个可选档位的 id（与 `reasoningEffort` 同域）。 */
export const ANTIGRAVITY_EFFORT_IDS: readonly string[] = ['low', 'medium', 'high', 'tiered']
/** 默认档位。 */
export const ANTIGRAVITY_DEFAULT_EFFORT = 'medium'

/** 档位 id → 中文显示名（用户拍板用中文）。 */
export function antigravityEffortLabel(id: string): string {
  if (id === 'low') return '低'
  if (id === 'medium') return '中'
  if (id === 'high') return '高'
  if (id === 'tiered') return '自适应'
  return id
}

/**
 * 静态模型表条目（与 `MinimaxModelEntry` 同形态，便于复用同一套适配器写法）。
 *
 * ⚠️ `maxTokens` **必须**是安全正整数：DSH 校验不通过会抛
 * `INVALID_MODEL_MAX_TOKENS` 并让**整轮对话起不来**。
 */
export interface AntigravityModelEntry {
  readonly id: string
  readonly name: string
  readonly contextWindow: number
  readonly maxTokens: number
  readonly supportsImage: boolean
  readonly effortOptions?: readonly string[]
  readonly defaultEffort?: string
}

/**
 * 静态兜底表（**远端目录拉不到时的回落**，2026-11-01 更正）。
 *
 * ## 2026-11-01 起主路径是**远端目录**
 *
 * `fetchAvailableModels` 端点实测可用（Agent2API `models.rs` 同款规格：
 * 五头 + 空 body 即可，个人 free-tier 账号也下发全量清单 + 每模型配额）。
 * 静态表退居「远端失败时的兜底」，内容收敛到实测在售的核心 id。
 *
 * ## 兜底表为何只有主模型
 *
 * - ⚠️ **不暴露 4 个带后缀的模型名** —— 档位走 efforts 下拉框。
 * - ⚠️ **不暴露 lite**（用户 2026-10-03 拍板）：旧通道实测恒 404，暴露即坑。
 *   （远端目录里新通道的 lite 系条目由远端路径负责，与本表无关。）
 */
export const ANTIGRAVITY_FALLBACK_MODELS: readonly AntigravityModelEntry[] = [
  {
    id: ANTIGRAVITY_UPSTREAM_FLASH,
    name: 'Gemini 3.8 Flash',
    contextWindow: ANTIGRAVITY_CONTEXT_WINDOW,
    maxTokens: ANTIGRAVITY.maxOutputTokens,
    supportsImage: true,
    effortOptions: ANTIGRAVITY_EFFORT_IDS,
    defaultEffort: ANTIGRAVITY_DEFAULT_EFFORT,
  },
]

/** 取静态兜底表。 */
export function antigravityFallbackEntries(): readonly AntigravityModelEntry[] {
  return ANTIGRAVITY_FALLBACK_MODELS
}

// ---------------------------------------------------------------------------
// 远端模型目录（fetchAvailableModels，2026-11-01 接入）
// ---------------------------------------------------------------------------

/** 远端目录条目（`fetchAvailableModels` 的 `models` 值，字段按需归一）。 */
export interface AntigravityRemoteModelEntry extends AntigravityModelEntry {
  /** 远端配额剩余比例（0-1）；缺省 = 未下发。 */
  readonly remainingFraction?: number
  /** 远端思考预算建议值（非本插件档位表）。 */
  readonly thinkingBudget?: number
}

/**
 * 解析 `fetchAvailableModels` 响应。
 *
 * 上游形态（Agent2API `models.rs` §5.1 同款实测）：
 *
 * ```json
 * { "models": { "<id>": { displayName, supportsImages, supportsThinking,
 *   thinkingBudget, recommended, maxTokens, maxOutputTokens, quotaInfo:
 *   { remainingFraction, resetTime } } }, "deprecatedModelIds": {...} }
 * ```
 *
 * ⚠️ `models` 是**以 id 为键的对象**（不是数组）。
 *
 * ⚠️ **过滤两类噪音 id**（实测响应里确实有）：`chat_23310` / `tab_jump_flash_lite_preview`
 * 这类内部占位条目（无 displayName、无 quotaInfo）不进目录。
 *
 * ## 2026-11-01 起放行 Claude / GPT-OSS 家族（用户要求「应该拉取这些模型」）
 *
 * `claude-sonnet-4-6` / `claude-opus-4-6-thinking` / `gpt-oss-120b-medium` 经
 * `streamGenerateContent` 逐 id 推理探针验证 **200 可用**（Gemini 同信封：
 * 五头 + `model` 顶层字段 + `thinkingConfig`；工具调用首轮返回
 * `functionCall{id,args}`，结果回传要求 `functionResponse` 携带**与 call 相同
 * 的 id** —— 见 `antigravity-messages.ts` 的 id 配对段）。放行即广告，不再按
 * Gemini 前缀白名单拦（用户 2026-11-01 拍板）。
 *
 * ## 2026-11-01 起合并「同模型不同思考强度」的分段条目（用户报障）
 *
 * 远端把 Gemini 3.8 Flash 的三个思考档拆成三条独立条目
 *（`gemini-3.8-flash-low/medium/high`），UI 上占三个模型位。本函数把同族分段
 * 合并成**单条** `gemini-3.8-flash`（档位走既有的 efforts 下拉，同静态兜底表）：
 *
 * - 族名 = 剥掉 `-(low|medium|high)$` 后缀的裸名；`displayName` 取「最短后缀」
 *   一侧的显示名（`(Low)` < `(Medium)` < `(High)` 字典序，`Gemini 3.8 Flash
 *   (Low)` 去掉 ` (Low)` 即 `Gemini 3.8 Flash`）。
 * - 各分段字段取「信息量最大」侧合并（contextWindow/maxOutputTokens 取最大，
 *   supportsImage/支持思考 任一为真即真，remainingFraction 取最小=最保守）。
 * - **只有全部三个档位齐了才合并**（缺任意一个按独立模型透传，不猜族名）。
 * - `-tiered`（无 displayName 的自适应档）**不进族**：上游把它作为编程用入口，
 *   且无显示名；本插件静态表已提供 `gemini-3.8-flash`+`tiered` 下拉档覆盖该
 *   能力，此处若再暴露会与合并后的主模型重复。
 */
export function parseGeminiAvailableModels(payload: unknown): readonly AntigravityRemoteModelEntry[] {
  if (typeof payload !== 'object' || payload === null) return []
  const models = (payload as Record<string, unknown>).models
  if (typeof models !== 'object' || models === null || Array.isArray(models)) return []
  type Seg = {
    base: string
    displayName: string
    entry: AntigravityRemoteModelEntry
  }
  const out: AntigravityRemoteModelEntry[] = []
  const segments = new Map<string, Seg[]>()
  for (const [id, raw] of Object.entries(models as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as Record<string, unknown>
    // ⚠️ 白名单（2026-11-01 第二次放宽）：
    // - `gemini-` 前缀：远端 id 就是上游真名，逐 id 推理探针验证 3.8 系 /
    //   gemini-3-flash 均 200，全部放行。
    // - `claude-` / `gpt-oss-` 前缀：同信封推理探针验证 200（文本 / 思考 /
    //   工具调用 / 工具结果回传全链路），放行（用户点名要这三条）。
    // - 占位 id（chat_NNN / tab_* / models/*）无 displayName，由下面判挡。
    if (!id.startsWith('gemini-') && !id.startsWith('claude-') && !id.startsWith('gpt-oss-')) continue
    const displayName = typeof entry.displayName === 'string' ? entry.displayName : ''
    if (displayName === '') continue
    const contextWindow = positiveIntField(entry.maxTokens) ?? ANTIGRAVITY_CONTEXT_WINDOW
    const maxOutput = positiveIntField(entry.maxOutputTokens) ?? ANTIGRAVITY.maxOutputTokens
    // 思考档位：上游只给 supportsThinking / thinkingBudget，档位表由本插件
    // 的 efforts 统一表达（远端 thinkingBudget 仅记录）。
    const supportsThinking = entry.supportsThinking === true
    const quota = typeof entry.quotaInfo === 'object' && entry.quotaInfo !== null
      ? entry.quotaInfo as Record<string, unknown>
      : {}
    const remaining = typeof quota.remainingFraction === 'number' && Number.isFinite(quota.remainingFraction)
      ? quota.remainingFraction
      : undefined
    const parsed: AntigravityRemoteModelEntry = {
      id,
      name: displayName,
      contextWindow,
      maxTokens: maxOutput,
      supportsImage: entry.supportsImages === true,
      ...(supportsThinking ? { effortOptions: ANTIGRAVITY_EFFORT_IDS, defaultEffort: ANTIGRAVITY_DEFAULT_EFFORT } : {}),
      ...(remaining === undefined ? {} : { remainingFraction: remaining }),
      ...(typeof entry.thinkingBudget === 'number' && Number.isFinite(entry.thinkingBudget)
        ? { thinkingBudget: entry.thinkingBudget }
        : {}),
    }
    // 分段族归并：`gemini-3.8-flash-{low,medium,high}` → 同一 `{base}` 桶。
    // 非分段 id（含 `-tiered`）直接进输出。
    const seg = matchSegmentSuffix(id)
    if (seg === undefined) {
      out.push(parsed)
      continue
    }
    const bucket = segments.get(seg.base) ?? []
    bucket.push({ base: seg.base, displayName, entry: parsed })
    segments.set(seg.base, bucket)
  }
  // 分段合并：三档齐全才合并成一条（族名即裸名，显示名去掉强度后缀）。
  for (const [base, bucket] of segments) {
    if (bucket.length < 3) {
      out.push(...bucket.map((item) => item.entry))
      continue
    }
    // 显示名取「字典序最小」的（`(Low)` < `(Medium)` < `(High)`）再剥掉
    // ` (Low)` 后缀 —— `Gemini 3.8 Flash (Low)` → `Gemini 3.8 Flash`。
    const displayNames = bucket.map((item) => item.displayName).sort()
    const shortest = displayNames[0] ?? base
    const stripped = shortest.replace(/\s*\((?:Low|Medium|High)\)\s*$/i, '').trim()
    const entries = bucket.map((item) => item.entry)
    out.push({
      id: base,
      name: stripped === '' ? base : stripped,
      // 合并取各档最宽能力：窗口/输出取最大，图片/思考任一为真即真。
      contextWindow: Math.max(...entries.map((item) => item.contextWindow)),
      maxTokens: Math.max(...entries.map((item) => item.maxTokens)),
      supportsImage: entries.some((item) => item.supportsImage),
      // 分段族必然 supportsThinking（上游按档位拆分的前提），档位下拉用
      // low/medium/high —— **不含 tiered**：上游分段没有自适应档。
      effortOptions: ['low', 'medium', 'high'],
      defaultEffort: ANTIGRAVITY_DEFAULT_EFFORT,
      // remainingFraction 取最小（=最保守的桶）。
      ...(entries.some((item) => item.remainingFraction !== undefined)
        ? { remainingFraction: Math.min(...entries.map((item) => item.remainingFraction ?? 1)) }
        : {}),
    })
  }
  return out
}

/**
 * 识别「思考强度分段」id（`-low/-medium/-high` 后缀）。
 *
 * ⚠️ **只对 `gemini-` 前缀生效**：claude/gpt-oss 的 id 虽也可能以这些词结尾
 *（如 `gpt-oss-120b-medium`），但那是**模型名本身的一部分**（上游就这一条、
 * 无同族其它档位），剥掉后缀会把两个不同模型并成一个 —— 绝不能碰。
 */
export function matchSegmentSuffix(id: string): { base: string; segment: string } | undefined {
  if (!id.startsWith('gemini-')) return undefined
  for (const segment of ['low', 'medium', 'high'] as const) {
    if (id.endsWith(`-${segment}`)) {
      return { base: id.slice(0, id.length - segment.length - 1), segment }
    }
  }
  return undefined
}

/** 正整数字段提取（`parseGeminiAvailableModels` 内部用）。 */
function positiveIntField(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.round(value)
}

/** 档位 id 归一（未知/缺省一律 medium，同原版 `EffortToTier` 默认分支）。 */
export function antigravityEffortToTier(effort: string | undefined): AntigravityTier {
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'tiered') {
    return effort
  }
  return 'medium'
}

/** 档位 → 思考预算。 */
export function antigravityThinkingBudget(tier: AntigravityTier): number {
  if (tier === 'low') return ANTIGRAVITY_BUDGET_LOW
  if (tier === 'high') return ANTIGRAVITY_BUDGET_HIGH
  if (tier === 'tiered') return ANTIGRAVITY_BUDGET_TIERED
  return ANTIGRAVITY_BUDGET_MEDIUM
}

/** 一次请求的模型规格。 */
export interface AntigravityModelSpec {
  /** 真正发给上游的模型名（带档位后缀）。 */
  readonly upstream: string
  readonly tier: AntigravityTier
  readonly thinkingBudget: number
  /** **恒 true**（「关闭思考」是假关，见文件头）。 */
  readonly includeThoughts: true
}

/**
 * 归一化模型 id：剥掉档位后缀（`-low/-medium/-high/-tiered`），得到目录裸名。
 *
 * ## 2026-11-01 起：只对 `gemini-` 前缀剥档位
 *
 * ⚠️ 远端目录接入后出现了**以档位词结尾的非 Gemini id**（`gpt-oss-120b-medium`）
 * —— `-medium` 是模型名本身的一部分，不是档位。对它们剥后缀会把两个不同模型
 * 并成一个（`gpt-oss-120b-medium` 被剥成不存在的 `gpt-oss-120b`，请求 404）。
 * 故本函数**只剥 `gemini-` 前缀 id 的已知档位**，其余前缀原样返回。
 *
 * ⚠️ 限流标记（`modelRateLimits` 的 key）与 `account.test` 探测链路记录 /
 * 传递的可能是**带档位的名字**（写标记时用的是请求原始 id），而静态表的 id
 * 是裸名 —— 两处校验都必须先归一化，否则「测一下被限流的档位」会被误拒。
 */
export function antigravityCanonicalModelId(modelId: string): string {
  if (!modelId.startsWith('gemini-')) return modelId
  for (const tier of ANTIGRAVITY_EFFORT_IDS) {
    if (modelId.endsWith(`-${tier}`)) return modelId.slice(0, modelId.length - tier.length - 1)
  }
  return modelId
}

/**
 * 由「模型 id + 用户选的档位」得出上游模型规格。
 *
 * ## 2026-11-01 起：远端目录全家族（Gemini + Claude + GPT-OSS）
 *
 * `fetchAvailableModels` 实测：远端下发的 id 就是上游真名，逐 id 推理探针验证
 * `gemini-3.8-flash-medium` / `-tiered` / `gemini-3-flash` / `claude-sonnet-4-6` /
 * `claude-opus-4-6-thinking` / `gpt-oss-120b-medium` 均 200 —— **上游按请求体的
 * `model` 原样路由，名字本身不参与准入校验**（这与文件头「模型名是准入钥匙」
 * 的旧结论并不矛盾：那是旧通道/旧凭据时期的现象，Antigravity free-tier 新通道
 * 实测不再卡名字）。
 *
 * 规则：
 * - **裸 `gemini-3.8-flash`**（静态兜底表条目 / 分段合并后的目录条目）：拼档位
 *   后缀（`-<tier>`）—— 档位是用户在 UI 下拉框选的，efforts 表在它身上声明。
 * - **其余 `gemini-` 前缀 id**（远端目录原样名，如 `gemini-3.8-flash-medium` /
 *   `gemini-3-flash` / `gemini-2.5-pro`）：**原样透传**，不吃档位 —— 这些 id
 *   已是上游真名，拼后缀反而 404。
 * - **`claude-` / `gpt-oss-` 前缀 id**：原样透传，**不发档位后缀** ——
 *   `gpt-oss-120b-medium` 的 `-medium` 是名字的一部分；claude 的思考预算由
 *   `thinkingConfig` 表达（探针实测：budget 必须 < maxOutputTokens，故
 *   `antigravityThinkingBudget` 的 1k/4k/10k 对它们是安全的）。
 * - **其它前缀 / 目录外 id**：拒绝（保留旧「写错名静默跑 3.8」的防线）。
 *
 * ⚠️ 思考档位的传递方式：档位仍然只影响 `thinkingConfig.thinkingBudget`
 *（Claude 家族上游会校验 `budget < max_tokens`，本插件的 1k/4k/10k 档在
 * 默认 64k 输出上限下恒成立）；对**不接受**思考预算的远端条目（如
 * `gpt-oss-120b-medium` 上游建议 8192），档位同样只改预算值 —— 上游自行取整。
 */
export function antigravityModelSpec(modelId: string, effort?: string): AntigravityModelSpec {
  // claude / gpt-oss：原样透传（不吃档位后缀），思考走 thinkingConfig。
  if (modelId.startsWith('claude-') || modelId.startsWith('gpt-oss-')) {
    const tier = antigravityEffortToTier(effort)
    return {
      upstream: modelId,
      tier,
      thinkingBudget: antigravityThinkingBudget(tier),
      includeThoughts: true,
    }
  }
  if (!modelId.startsWith('gemini-')) {
    throw new LlmError(
      `antigravity: 模型 "${modelId}" 不在本 provider 目录中（仅支持 antigravity- 前缀模型）`,
      'INVALID_REQUEST',
      // ⚠️ `status` 只落在 `LlmError.failure`（不是顶层属性），且网关的
      // `failureToOpenAiError` 两处都要读 —— 见 `openai-gateway/stream.ts`。
      { status: 404 },
    )
  }
  // 静态兜底表的裸主模型 / 分段合并后的目录条目：档位后缀走档位表。
  // （合并条目的 id 就是裸名 `gemini-3.8-flash`，与静态表同名同路径；
  // 远端原始分段名 `-medium/-low/-high` 落到下面的原样透传。）
  if (modelId === ANTIGRAVITY_UPSTREAM_FLASH) {
    const tier = antigravityEffortToTier(effort)
    return {
      upstream: `${ANTIGRAVITY_UPSTREAM_FLASH}-${tier}`,
      tier,
      thinkingBudget: antigravityThinkingBudget(tier),
      includeThoughts: true,
    }
  }
  // 远端目录原样名（含分段档 / tiered / 其它家族）：原样透传。
  return {
    upstream: modelId,
    tier: 'medium',
    thinkingBudget: antigravityThinkingBudget('medium'),
    includeThoughts: true,
  }
}

/**
 * 静态表条目 → DSH 的推理档位声明。
 *
 * ⚠️ 无档位时返回 `undefined`（**不声明**）—— 声明空数组会让面板显示一个
 * 点不开的空下拉框。与 `minimaxReasoningInfo` 同口径。
 */
export function antigravityReasoningInfo(entry: AntigravityModelEntry): LlmModelReasoningInfo | undefined {
  const options = entry.effortOptions
  if (options === undefined || options.length === 0) return undefined
  const efforts = options.map((id) => ({ id: ReasoningEffortId(id), name: antigravityEffortLabel(id) }))
  const defaultEffort = entry.defaultEffort !== undefined && options.includes(entry.defaultEffort)
    ? ReasoningEffortId(entry.defaultEffort)
    : undefined
  return { efforts, ...(defaultEffort === undefined ? {} : { defaultEffort }) }
}

// ---------------------------------------------------------------------------
// JSON Schema 清洗
// ---------------------------------------------------------------------------

/**
 * Gemini `FunctionDeclaration.parameters` 接受的键白名单。
 *
 * ⚠️ 白名单**之外**的键（`$schema` / `additionalProperties` / `default` /
 * `examples` / `$ref` …）必须整键删除 —— 上游对未知键是**硬 400**，
 * 而 harness 的工具 schema 由各工具自行声明，出现这些键是常态。
 */
export const ANTIGRAVITY_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'items',
  'minItems',
  'maxItems',
  'properties',
  'required',
  'minProperties',
  'maxProperties',
  'minLength',
  'maxLength',
  'pattern',
  'anyOf',
  'propertyOrdering',
  'minimum',
  'maximum',
])

/**
 * 递归清洗工具参数 schema（原版 `SanitizeGeminiSchema`）。
 *
 * 三条规则：
 * 1. 白名单外的键整键删除；
 * 2. `properties` / `items` / `anyOf` 递归清洗（`items` 可能是对象或数组）；
 * 3. `type` 为数组形态（如 `['string','null']`）时收敛成单个 type 并补
 *    `nullable: true`；`enum` 只要含**任何非字符串**值就整删（Gemini 只接受
 *    字符串枚举）。
 */
export function sanitizeGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (!ANTIGRAVITY_SCHEMA_KEYS.has(key)) continue

    if (key === 'properties') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      const properties: Record<string, unknown> = {}
      for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
        if (typeof child !== 'object' || child === null || Array.isArray(child)) continue
        properties[name] = sanitizeGeminiSchema(child as Record<string, unknown>)
      }
      out.properties = properties
      continue
    }

    if (key === 'items') {
      if (Array.isArray(value)) {
        out.items = value
          .filter((item): item is Record<string, unknown> => (
            typeof item === 'object' && item !== null && !Array.isArray(item)
          ))
          .map((item) => sanitizeGeminiSchema(item))
        continue
      }
      if (typeof value === 'object' && value !== null) {
        out.items = sanitizeGeminiSchema(value as Record<string, unknown>)
      }
      continue
    }

    if (key === 'anyOf') {
      if (!Array.isArray(value)) continue
      out.anyOf = value
        .filter((item): item is Record<string, unknown> => (
          typeof item === 'object' && item !== null && !Array.isArray(item)
        ))
        .map((item) => sanitizeGeminiSchema(item))
      continue
    }

    if (key === 'type') {
      if (typeof value === 'string') {
        out.type = value
        continue
      }
      if (Array.isArray(value)) {
        const types = value.filter((item): item is string => typeof item === 'string')
        const nonNull = types.filter((item) => item !== 'null')
        if (nonNull.length > 0) out.type = nonNull[0]
        // 出现 'null' ⇒ 该字段可空。原版用 nullable 表达。
        if (nonNull.length !== types.length) out.nullable = true
      }
      continue
    }

    if (key === 'enum') {
      if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
        out.enum = [...value]
      }
      continue
    }

    out[key] = value
  }
  return out
}

// ---------------------------------------------------------------------------
// 图片
// ---------------------------------------------------------------------------

/** 已内联的图片（`attachmentId` → base64 与 mediaType）。 */
export interface AntigravityInlineImage {
  mediaType: string
  /** **裸 base64**（不含 `data:` 前缀）—— `inlineData.data` 要的就是它。 */
  data: string
}

/** 上游单张内联图片的体积上限（超出则整请求被拒）。 */
export const ANTIGRAVITY_MAX_IMAGE_BYTES_INLINE = 10 * 1024 * 1024
/**
 * 请求体上限（发送前**真实检查**，见 `antigravity-adapter.ts` 的发送点）。
 *
 * ⚠️ 2026-10-05：这个常量此前**定义了但全仓零引用** —— 看着有防护，实际没有。
 * 现已接上。超限归类走 `CONTEXT_WINDOW_EXCEEDED`（触发 harness 压缩重试）
 * 而不是 `INVALID_REQUEST`（死路）——理由与 `isGeminiContextOverflow` 同：
 * 归错码的代价不对称。
 */
export const ANTIGRAVITY_MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024

/**
 * 校验 base64 是否可用（原版 `imagePart` 的口径）。
 *
 * ⚠️ 先做一次宽松清洗（去 `\n` / `\r` / 空格）再判 —— 上游接受带换行的
 * base64，但本地校验若不容忍换行会把**本来合法**的图片判死。
 */
export function normalizeBase64(data: string): string | undefined {
  if (data === '') return undefined
  const cleaned = data.replace(/[\n\r\s]/g, '')
  if (cleaned === '') return undefined
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) return undefined
  if (cleaned.length % 4 !== 0) return undefined
  return cleaned
}
