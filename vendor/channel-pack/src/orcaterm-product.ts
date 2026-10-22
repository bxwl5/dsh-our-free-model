/**
 * OrcaTerm（腾讯云 LightAI）产品配置。
 *
 * ## 协议来源
 *
 * 公开的 `aimod-cc/Agent2API`（Rust，MIT）实测整理（2026-10-16）：
 * - 控制台：`https://orcaterm.cloud.tencent.com/terminal`
 * - 对话平面：`https://lightai.cloud.tencent.com`
 * - 认证：**`ot_session` Cookie**（控制台登录后由页面 JS 写入，非 HttpOnly）
 *
 * ## ⚠️ 登录只能粘贴 Cookie
 *
 * 上游有三条登录链路，没有一条能在插件里自动完成：
 * 1. 桌面客户端：回调走自定义协议 `orcaterm://`，Web 侧收不到；
 * 2. 微信扫码：state 由上游服务端会话绑定，代跑无法区分失败形态；
 * 3. **Web 控制台**：扫码后把令牌写进 `ot_session` Cookie —— 本条可用，
 *    但扫码动作仍须用户自己在官方页面完成。
 *
 * 因此登录形态与 MonkeyCode 相同：用户在官方控制台登录，复制 Cookie 粘贴。
 *
 * ## 对话是「建会话 → SSE」两步
 *
 * 1. `POST {lightai}/assistant/conversation` 建一个会话；
 * 2. `POST {lightai}/assistant/chat?...` 发消息并读 SSE。
 *
 * 多轮：上游按 conversationId 在服务端留存历史，但 OpenAI 客户端每轮自带
 * 全量 messages —— 故按请求内会话处理（每轮新建会话，历史拍平进输入）。
 */

/** OrcaTerm 产品配置。 */
export interface OrcaTermProduct {
  /** provider 标识。 */
  id: 'orcaterm'
  /** 展示名。 */
  displayName: string
  /** 控制台基址（登录页）。 */
  consoleBase: string
  /** 对话平面基址。 */
  lightaiBase: string
  /** 默认凭据 ref。 */
  defaultCredentialRef: string
  /** 兜底模型目录。 */
  fallbackModels: readonly OrcaTermFallbackModel[]
}

/** 兜底模型条目。 */
export interface OrcaTermFallbackModel {
  id: string
  name: string
  contextWindow: number
  maxTokens?: number
}

/**
 * 兜底模型目录。
 *
 * ⚠️ 上游模型集合由控制台下发，这张表只是**拉取失败时**的兜底。
 */
const ORCATERM_FALLBACK_MODELS: readonly OrcaTermFallbackModel[] = [
  { id: 'deepseek-v3.2', name: 'DeepSeek V3.2', contextWindow: 128_000 },
  { id: 'hunyuan-t1', name: 'Hunyuan T1', contextWindow: 128_000 },
]

/** OrcaTerm provider 配置。 */
export const ORCATERM: OrcaTermProduct = {
  id: 'orcaterm',
  displayName: 'OrcaTerm',
  consoleBase: 'https://orcaterm.cloud.tencent.com',
  lightaiBase: 'https://lightai.cloud.tencent.com',
  defaultCredentialRef: 'ORCATERM_SESSION_COOKIE',
  fallbackModels: ORCATERM_FALLBACK_MODELS,
}

/** 按 id 取产品配置。 */
export function orcaTermProductById(id: string): OrcaTermProduct | undefined {
  return id === ORCATERM.id ? ORCATERM : undefined
}

// ── 端点路径（挂 lightaiBase）──

/** 建会话。 */
export const ORCATERM_CONVERSATION_PATH = '/assistant/conversation'
/** 对话（SSE）。 */
export const ORCATERM_CHAT_PATH = '/assistant/chat'

/** Cookie 名。 */
export const ORCATERM_SESSION_COOKIE = 'ot_session'

/** 对话时固定带的查询参数（实测值）。 */
export const ORCATERM_CHAT_QUERY = { name: 'orcaterm', mode: '0', csrfCode: '', sseresume: 'true' } as const

/** 建会话时打的标签。 */
export const ORCATERM_CONVERSATION_TAG = 'orcaterm'
