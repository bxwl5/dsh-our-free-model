/**
 * Accio 产品配置。
 *
 * ## 协议来源
 *
 * 公开的 `aimod-cc/Agent2API`（Rust，MIT）逆向整理（桌面端 app.asar）：
 * - 业务网关：`https://phoenix-gw.alibaba.com`（国际/国内**同一个** host）
 * - 推理网关：`https://phoenix-gw.alibaba.com/api/adk/llm`
 * - 登录站点：国际 `www.accio.com` / 国内 `www.accio-ai.com`
 * - `client_id` 两地逐字相同：`accio-work`
 *
 * ## 三个独特点（与其它渠道都不同）
 *
 * 1. **token 不走 `Authorization` 头** —— GET 拼进 query，POST 放进 JSON body。
 *    写成标准 Bearer 头会 401。
 * 2. **请求体是 Gemini 风格信封**（`contents` / `tools` / `token`），
 *    不是 OpenAI 形状。
 * 3. **响应是 ADK 自有帧**（`content.parts` / `turn_complete`），
 *    不是 OpenAI 的 `choices[].delta`。
 *
 * ## 地区是一等公民
 *
 * 两个地区共用网关，差别只在 `x-package-region`（`GLOBAL` / `CN`）与登录站点。
 * 因此做成两个 provider（`accio` / `accio-cn`），共用同一份实现。
 */

/** Accio 地区。 */
export type AccioRegion = 'GLOBAL' | 'CN'

/** Accio 产品配置。 */
export interface AccioProduct {
  /** provider 标识（`accio` 或 `accio-cn`）。 */
  id: 'accio' | 'accio-cn'
  /** 展示名。 */
  displayName: string
  /** 地区（决定 `x-package-region` 与登录站点）。 */
  region: AccioRegion
  /** 登录站点基址。 */
  loginBase: string
  /** 业务网关基址。 */
  gatewayBase: string
  /** 推理网关基址。 */
  llmBase: string
  /** OAuth client id（两地相同）。 */
  clientId: string
  /** 默认凭据 ref。 */
  defaultCredentialRef: string
  /** 兜底模型目录。 */
  fallbackModels: readonly AccioFallbackModel[]
}

/** 兜底模型条目。 */
export interface AccioFallbackModel {
  id: string
  name: string
  contextWindow: number
  maxTokens?: number
  /**
   * ⚠️ 以下可选字段与远端行对齐（适配器 `remoteModels` 的行形状，2026-10-31
   * tsc 门禁）：适配器把「远端行 | 兜底行」做联合，收窄后只见公共字段 ——
   * 兜底行缺字段时 `usageDesc` / `supportsThinking` 在联合上「不存在」
   * （TS2339/TS2559 ×3）。全可选，兜底表不填即无该信息。
   */
  /** 消耗系数（倍率；拼 name 用 `· xN`）。 */
  priceFactor?: number
  /** 免费标记（模型列表按「计费/来源」分组用）。 */
  isFree?: boolean
  /** 中文展示名（zh locale 优先用）。 */
  nameCn?: string
  /** 是否支持思考（accioReasoningInfo 的判据输入）。 */
  supportsThinking?: boolean
  /** 上游用量说明（用作 description）。 */
  usageDesc?: string
}

/**
 * 兜底模型目录。
 *
 * ⚠️ 真实目录由 `POST /api/llm/config` 下发；这张表只在拉取失败时用。
 */
const ACCIO_FALLBACK_MODELS: readonly AccioFallbackModel[] = [
  // 2026-10-24 按上游 `POST /api/llm/config` 实拉结果同步（9 个 provider 组拍平、
  // 去重、剔除 visible:false 后共 43 条）。原来只有 2 条实验模型，
  // 用来验证「能否显示」；现在全量覆盖，两个地区共用同一份（上游两地目录一致）。
  { id: 'auto', name: 'Auto', contextWindow: 1050000 },
  { id: '1Helix-G6aS8tR2qN7m', name: 'GPT 6 Astra', contextWindow: 1050000 },
  { id: '1Helix-3EjR3WN1dY6s', name: 'GPT 5.6 Luna', contextWindow: 1050000 },
  { id: '1Helix-B33T3WN1dY6s', name: 'GPT 5.6 Terra', contextWindow: 1050000 },
  { id: '1Helix-B3jR3WN1dY6s', name: 'GPT 5.6 Sol', contextWindow: 1050000 },
  { id: '1Helix-G6Lu8nK4qR2m', name: 'GPT 6 Luna', contextWindow: 1050000 },
  { id: '1Helix-G6So7pW3xN9q', name: 'GPT 6 Sol', contextWindow: 1050000 },
  { id: '1Helix-B3jR8wN1dY6s', name: 'GPT 5.5', contextWindow: 1050000 },
  { id: '1Helix-G46W8nP2qR6m', name: 'Grok 4.6', contextWindow: 500000 },
  { id: '1Orbit-I9eY7YK8bW1f', name: 'Claude Sonnet 4.6', contextWindow: 1000000 },
  { id: '1Orbit-I93V4tK8bW1f', name: 'Claude Haiku 4.5', contextWindow: 200000 },
  { id: '1Orbit-H55aN8xR6cP2m', name: 'Claude Haiku 5.5', contextWindow: 1000000 },
  { id: '1Orbit-I93F4tK8bW1f', name: 'Claude Sonnet 5', contextWindow: 1000000 },
  { id: '1Orbit-Q7hN2R6cP2m', name: 'Claude Opus 4.7', contextWindow: 1000000 },
  { id: '1Orbit-Q5pN8xR6cP2m', name: 'Claude Opus 5', contextWindow: 1000000 },
  { id: '1Orbit-Q55pN8xR6cP2m', name: 'Claude Opus 5.5', contextWindow: 1000000 },
  { id: '1Orbit-Q2XN3xR6cP2m', name: 'Claude Opus 4.8', contextWindow: 1000000 },
  { id: '1Orbit-Q2XN3dX6cP2m', name: 'Claude Fable 5', contextWindow: 1000000 },
  { id: '1Orbit-F51W8nP2qR6m', name: 'Claude Fable 5.1', contextWindow: 1000000 },
  { id: '1Orbit-Q7hN3xR6cP2m', name: '极致', contextWindow: 1000000 },
  { id: '1Orbit-Q2dN3xR6cP2m', name: 'Claude Opus 4.6', contextWindow: 1000000 },
  { id: '1Nexus-R3wF8qJ5vB6h', name: 'Standard', contextWindow: 1000000 },
  { id: '1Nexus-R36W8qJ5vB6h', name: 'Gemini 3 Flash', contextWindow: 1000000 },
  { id: '1Nexus-R3wF8qJ5vc7o', name: 'Gemini 3.5 Flash', contextWindow: 1000000 },
  { id: '1Nexus-R7GF8qJ6vd8p', name: 'Gemini 3.7 Flash', contextWindow: 1000000 },
  { id: '1Nexus-R8HF9qK7we1s', name: 'Gemini 3.8 Flash', contextWindow: 1000000 },
  { id: '1Orbit-I9eY4tK8bW1f', name: '专业', contextWindow: 1000000 },
  { id: '1Nexus-utXDaAethymI', name: 'Gemini 4 Argon', contextWindow: 1048576 },
  { id: '1Drift-T3TB6WS9a23w', name: 'Qwen 3.8 Max', contextWindow: 1000000 },
  { id: '1Drift-T3T9WWS9a23w', name: 'Qwen 3.8 Max', contextWindow: 1000000 },
  { id: '1Drift-N8kP2Q7wR5mX', name: 'Qwen 3.8 27B', contextWindow: 512000 },
  { id: '1Drift-F8hS3mK7pL6I', name: 'Qwen 3.8 Flash', contextWindow: 1000000 },
  { id: '1Drift-A3bM5nK8pQ2w', name: 'Qwen 3.5 A3B', contextWindow: 256000 },
  { id: '1Nova-Q3xM8vJ1rH6z', name: 'DeepSeek V4 Flash', contextWindow: 1000000 },
  { id: '1Nova-bW7yT4kL9pN2', name: 'DeepSeek V4 Pro', contextWindow: 1000000 },
  { id: '1Synapse-G5aJ8wL1dV4s', name: 'Kimi K2.6', contextWindow: 256000 },
  { id: '1Chronos-dX3cV9sA2mK7', name: 'GLM 5.1', contextWindow: 200000 },
  { id: '1Chronos-E2yU6nF9kH3r', name: 'GLM-5', contextWindow: 200000 },
  { id: '1Chronos-G5p2V9sA2mK7', name: 'GLM-5.2', contextWindow: 1000000 },
  { id: '1Chronos-L53W8nP2qR6m', name: 'GLM-5.3', contextWindow: 1000000 },
  { id: '1Chronos-F53X9nQ3rT8w', name: 'GLM 5.3 Flash', contextWindow: 1000000 },
  { id: '1Zenith-M27hS2SR5xQ2p', name: 'MiniMax M3', contextWindow: 1000000 },
  { id: 'rlab-1.0-storyboard', name: 'Multi-shot Video', contextWindow: 128000 },
]

/** 国际版。 */
export const ACCIO: AccioProduct = {
  id: 'accio',
  displayName: 'Accio',
  region: 'GLOBAL',
  loginBase: 'https://www.accio.com',
  gatewayBase: 'https://phoenix-gw.alibaba.com',
  llmBase: 'https://phoenix-gw.alibaba.com/api/adk/llm',
  clientId: 'accio-work',
  defaultCredentialRef: 'ACCIO_ACCESS_TOKEN',
  fallbackModels: ACCIO_FALLBACK_MODELS,
}

/** 国内版。 */
export const ACCIO_CN: AccioProduct = {
  ...ACCIO,
  id: 'accio-cn',
  displayName: 'Accio 国内版',
  region: 'CN',
  loginBase: 'https://www.accio-ai.com',
  defaultCredentialRef: 'ACCIO_CN_ACCESS_TOKEN',
}

/** 全部产品。 */
export const ALL_ACCIO_PRODUCTS: readonly AccioProduct[] = [ACCIO, ACCIO_CN]

/** 按 id 取产品配置。 */
export function accioProductById(id: string): AccioProduct | undefined {
  return ALL_ACCIO_PRODUCTS.find((product) => product.id === id)
}

// ── 端点路径 ──

/** 授权码换 token。 */
export const ACCIO_TOKEN_PATH = '/api/oauth/token'
/** 续期。 */
export const ACCIO_REFRESH_PATH = '/api/auth/refresh_token'
/** 用户资料（GET，token 走 query）。 */
export const ACCIO_USERINFO_PATH = '/api/auth/userinfo'
/** 额度。 */
export const ACCIO_QUOTA_PATH = '/api/entitlement/quota'
/** 模型目录（POST，body 带 token）。 */
export const ACCIO_LLM_CONFIG_PATH = '/api/llm/config'
/** 推理（POST，SSE）。 */
export const ACCIO_GENERATE_PATH = '/generateContent'

/** 地区头名。 */
export const ACCIO_REGION_HEADER = 'x-package-region'

/**
 * 推理请求头 `appKey`（**必填**，上游只校验「有没有」不校验取值）。
 *
 * 上游 `aimod-cc/Agent2API` 的 `providers/accio/endpoints.rs`：不带它打
 * `generateContent`，上游回一段「Your app version is no longer supported」
 * 的普通文本（HTTP 200 + `data:` 帧），会被误当成模型输出。取的是
 * accio-manager 的默认值，与桌面端同源。
 */
export const ACCIO_APP_KEY = '35298846'

/** 推理请求头 `x-app-version`（桌面端 appVersion；上游 `DEFAULT_APP_VERSION`）。 */
export const ACCIO_APP_VERSION = '0.32.6'

/** 登录回调路径。 */
export const ACCIO_CALLBACK_PATH = '/callback'
/** PKCE 回调端口起点。 */
export const ACCIO_LOGIN_START_PORT = 5960
