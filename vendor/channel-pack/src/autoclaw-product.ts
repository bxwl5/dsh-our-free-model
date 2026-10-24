/**
 * AutoClaw（智谱) 产品配置。
 *
 * ## 协议来源
 *
 * 公开的 `aimod-cc/Agent2API`（Rust，MIT）逆向整理：
 * - 国内：`https://autoglm-acceleration-api.zhipuai.cn`
 * - 国际：`https://autoglm-api.autoglm.ai`
 * - 对话：`POST {base}/autoclaw-proxy/proxy/autoclaw/chat/completions`（OpenAI 兼容）
 * - 模型目录：`GET {base}/proxy/autoclaw-model-config`
 *   ⚠️ 目录**不在** `/autoclaw` 那一级，顺着 `chat/completions` 找永远找不到
 *
 * ## ⚠️ 认证头是 `X-Authorization`，不是 `Authorization`
 *
 * 规格文档写的是 `Authorization: Bearer …`，而**源实现**用的是
 * `X-Authorization`。按文档写会得到 401，且报错形态与「token 失效」相同。
 * 本插件按源实现（`X-Authorization`）。
 *
 * ## 登录
 *
 * 上游是 OAuth（Zai / Google），且**回调端口有白名单**：
 * `[18432, 19654, 19723, 53699]` —— 只有这四个端口能收回调。
 * 本插件当前采用「粘贴 token」形态（与其它需要手动取凭据的渠道一致），
 * 完整 OAuth 待后续版本。
 */

/** AutoClaw 地区。 */
export type AutoClawRegion = 'cn' | 'intl'

/** AutoClaw 产品配置。 */
export interface AutoClawProduct {
  id: 'autoclaw' | 'autoclaw-intl'
  displayName: string
  region: AutoClawRegion
  /** API 基址。 */
  apiBase: string
  /** 对话代理前缀。 */
  proxyPrefix: string
  /** 默认凭据 ref。 */
  defaultCredentialRef: string
  /** 兜底模型目录。 */
  fallbackModels: readonly AutoClawFallbackModel[]
}

/** 兜底模型条目。 */
export interface AutoClawFallbackModel {
  id: string
  name: string
  contextWindow: number
  maxTokens?: number
}

/**
 * 兜底模型目录（真实目录由 {@link AUTOCLAW_MODEL_CONFIG_PATH} 下发）。
 *
 * ⚠️ 该端点鉴权头是 **`Authorization`**（标准 Bearer），不是对话用的 `X-Authorization` ——
 * 用 `X-Authorization` 打它会 401 `{"error":"Invalid token"}`，极容易被误判成 token 失效。
 */
const AUTOCLAW_FALLBACK_MODELS: readonly AutoClawFallbackModel[] = [
  // 2026-10-24 按上游 `GET /autoclaw-proxy/proxy/autoclaw-model-config` 实拉结果同步
  //（原来只有 1 条 `autoglm-air` 实验模型，用来验证「能否显示」；现已全量覆盖）。
  { id: 'zai_auto', name: 'Auto', contextWindow: 1048576 },
  { id: 'zai_auto-fast', name: 'Auto-Fast', contextWindow: 1048576 },
  { id: 'zaicoding_glm-5.3', name: 'GLM-5.3', contextWindow: 1048576 },
]

/** 国内版。 */
export const AUTOCLAW: AutoClawProduct = {
  id: 'autoclaw',
  displayName: 'AutoClaw',
  region: 'cn',
  apiBase: 'https://autoglm-acceleration-api.zhipuai.cn',
  proxyPrefix: '/autoclaw-proxy/proxy/autoclaw',
  defaultCredentialRef: 'AUTOCLAW_TOKEN',
  fallbackModels: AUTOCLAW_FALLBACK_MODELS,
}

/** 国际版。 */
export const AUTOCLAW_INTL: AutoClawProduct = {
  ...AUTOCLAW,
  id: 'autoclaw-intl',
  displayName: 'AutoClaw 国际版',
  region: 'intl',
  apiBase: 'https://autoglm-api.autoglm.ai',
  defaultCredentialRef: 'AUTOCLAW_INTL_TOKEN',
}

/** 全部产品。 */
export const ALL_AUTOCLAW_PRODUCTS: readonly AutoClawProduct[] = [AUTOCLAW, AUTOCLAW_INTL]

/** 按 id 取产品配置。 */
export function autoClawProductById(id: string): AutoClawProduct | undefined {
  return ALL_AUTOCLAW_PRODUCTS.find((product) => product.id === id)
}

/** 模型目录路径（**不在** proxyPrefix 下）。 */
export const AUTOCLAW_MODEL_CONFIG_PATH = '/autoclaw-proxy/proxy/autoclaw-model-config'

/** 官方 OAuth 回调端口白名单（仅这四个能收回调）。 */
export const AUTOCLAW_CALLBACK_PORTS: readonly number[] = [18432, 19654, 19723, 53699]
