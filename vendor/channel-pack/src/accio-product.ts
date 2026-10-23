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
}

/**
 * 兜底模型目录。
 *
 * ⚠️ 真实目录由 `POST /api/llm/config` 下发；这张表只在拉取失败时用。
 */
const ACCIO_FALLBACK_MODELS: readonly AccioFallbackModel[] = [
  { id: 'qwen3-max', name: 'Qwen3 Max', contextWindow: 128_000 },
  { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus', contextWindow: 256_000 },
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

/** 登录回调路径。 */
export const ACCIO_CALLBACK_PATH = '/callback'
/** PKCE 回调端口起点。 */
export const ACCIO_LOGIN_START_PORT = 5960
