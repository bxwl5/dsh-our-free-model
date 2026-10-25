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
 *
 * 2026-10-25 更正：原表里的 `deepseek-v3.2` / `hunyuan-t1` 是**开发期
 * 测试连通性用的探针 id，实际不可用**（用户实测确认），却因为上游没有
 * 目录接口而被当成"全部模型"长期展示。现按上游 `aimod-cc/Agent2API`
 * 的 `providers/orcaterm/models.rs`（2026-10-16 逐个真发对话实测可用）
 * 与用户 2026-10-25 控制台截图逐项对齐，换成真实清单。
 */
const ORCATERM_FALLBACK_MODELS: readonly OrcaTermFallbackModel[] = [
  { id: 'hy4-preview', name: 'Hy4-preview', contextWindow: 128_000 },
  { id: 'hy3', name: 'Hy3', contextWindow: 128_000 },
  { id: 'kimi-k3', name: 'Kimi-K3', contextWindow: 128_000 },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 128_000 },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 128_000 },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 128_000 },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 128_000 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 128_000 },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 128_000 },
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

/**
 * 上游的模型挂载名（`TokenHub/<name>`）。
 *
 * 上游 `aimod-cc/Agent2API` 的 `providers/orcaterm/models.rs` 记录：对话
 * 请求的 `user.model` 必须是 `TokenHub/<name>` 形态，裸名会被上游判为
 * 未知名而回流内 `LLM_ERROR`。这里保留该前缀作为**挂载名**，目录里的
 * `id` 仍是裸名（与上游面板展示一致，便于用户认）。
 */
export const ORCATERM_MODEL_MOUNT_PREFIX = 'TokenHub/'

/** 上游默认档（实测可用，兜底用；对应上游 `DEFAULT_MODEL`）。 */
export const ORCATERM_DEFAULT_MODEL = 'glm-5.3-flash'

/**
 * 把用户选中的模型名归一成上游挂载名。
 *
 * 接受裸名（`glm-5.3-flash`）与全名（`TokenHub/glm-5.3-flash`）两种形态；
 * 空值回落到默认档。
 *
 * ⚠️ 目录内的模型**原样放行**（含上游未挂载的 `hy4-preview`）：上游会把
 * 明确错误下发到流里，由 `orcaterm-adapter.ts` 报给用户，比静默换成
 * 别的模型诚实。未知模型也回退到默认档（上游对未知名回流内 `LLM_ERROR`，
 * 与其直接失败不如回退到实测可用的档）。
 */
export function resolveOrcaTermModel(name: string | undefined): string {
  const trimmed = (name ?? '').trim()
  const bare = trimmed.startsWith(ORCATERM_MODEL_MOUNT_PREFIX)
    ? trimmed.slice(ORCATERM_MODEL_MOUNT_PREFIX.length).trim()
    : trimmed
  if (bare === '') return `${ORCATERM_MODEL_MOUNT_PREFIX}${ORCATERM_DEFAULT_MODEL}`
  const known = ORCATERM_FALLBACK_MODELS.some((model) => model.id === bare)
  return `${ORCATERM_MODEL_MOUNT_PREFIX}${known ? bare : ORCATERM_DEFAULT_MODEL}`
}

// ── 端点路径（挂 lightaiBase）──

/** 建会话。 */
export const ORCATERM_CONVERSATION_PATH = '/assistant/conversation'
/** 对话（SSE）。 */
export const ORCATERM_CHAT_PATH = '/assistant/chat'

/** Cookie 名。 */
export const ORCATERM_SESSION_COOKIE = 'ot_session'

/**
 * 会话字段的**候选名**。
 *
 * 2026-10-24 用户实测：控制台登录后浏览器里实际写的是 **`ot_sid`**
 * （同时还有 `userId` / `skey` / `ownerUin` / `uin` 等身份 Cookie），
 * 并没有 `ot_session` —— 上游改过字段名。只认旧名会让「完整 Cookie 也登不进去」，
 * 所以两个名字都收；`ot_sid` 的值形如 `<base64>.<hmac>`，与旧值同为不透明会话串。
 */
export const ORCATERM_SESSION_COOKIES = ['ot_session', 'ot_sid'] as const

/** 对话时固定带的查询参数（实测值）。 */
export const ORCATERM_CHAT_QUERY = { name: 'orcaterm', mode: '0', csrfCode: '', sseresume: 'true' } as const

/** 建会话时打的标签。 */
export const ORCATERM_CONVERSATION_TAG = 'orcaterm'
