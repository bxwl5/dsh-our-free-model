/**
 * KukuAI（百度文库 Kuku）产品配置。
 *
 * ## 协议来源
 *
 * 公开的 `IKUNHEIHIE/kuku2api`（Node.js，MIT）实测整理：
 * - 主站：`https://kuku.baidu.com`
 * - 登录：百度 passport（BDUSS Cookie 或短信验证码）
 * - 对话：`POST /wenchain/genflowpro/sendmsg` → SSE `/wenchain/genflowpro/sse/getchatcontent`
 *
 * ## 认证
 *
 * 用 **BDUSS Cookie**（百度账号体系的登录态）。用户在浏览器登录
 * kuku.baidu.com 后复制 Cookie 即可，与 MonkeyCode / OrcaTerm 同形态。
 *
 * ## 协议常量
 *
 * `clienttype` / `version` / `channel` / `v` 是客户端自报的固定值
 * （不是动态签名），照官方 PC 客户端原样下发。
 */

/** KukuAI 产品配置。 */
export interface KukuProduct {
  id: 'kuku'
  displayName: string
  /** 主站基址。 */
  apiBase: string
  /** 默认凭据 ref。 */
  defaultCredentialRef: string
  /** 兜底模型目录。 */
  fallbackModels: readonly KukuFallbackModel[]
}

/** 兜底模型条目。 */
export interface KukuFallbackModel {
  /** 模型 wire 名（`model_name`）。 */
  id: string
  /** 展示名（`model_display_name`）。 */
  name: string
  contextWindow: number
  maxTokens?: number
  /** 是否支持思考档位。 */
  thinking?: boolean
}

/**
 * 兜底模型目录。
 *
 * ⚠️ 上游模型集合由服务端下发，这张表只是拉取失败时的兜底。
 * `id` 同时用作 `model_name` 与 `model_display_name`（实测上游两者一致时可用）。
 */
const KUKU_FALLBACK_MODELS: readonly KukuFallbackModel[] = [
  { id: 'kuku', name: 'Kuku', contextWindow: 128_000 },
]

/** KukuAI provider 配置。 */
export const KUKU: KukuProduct = {
  id: 'kuku',
  displayName: 'KukuAI',
  apiBase: 'https://kuku.baidu.com',
  defaultCredentialRef: 'KUKU_SESSION_COOKIE',
  fallbackModels: KUKU_FALLBACK_MODELS,
}

/** 按 id 取产品配置。 */
export function kukuProductById(id: string): KukuProduct | undefined {
  return id === KUKU.id ? KUKU : undefined
}

// ── 客户端自报常量（照官方 PC 客户端）──

/** 客户端类型。 */
export const KUKU_CLIENT_TYPE = '401'
/** 客户端版本。 */
export const KUKU_VERSION = '1.6.5.130'
/** 渠道标识。 */
export const KUKU_CHANNEL = 'kuku_pc_genflowpro_v1'
/** 协议版本。 */
export const KUKU_PROTOCOL_V = 'cd1755270722192e4536f605'

// ── 端点路径 ──

/** 建消息。 */
export const KUKU_SENDMSG_PATH = '/wenchain/genflowpro/sendmsg'
/** 流式取正文。 */
export const KUKU_SSE_PATH = '/wenchain/genflowpro/sse/getchatcontent'
/** 免费积分首页（额度）。 */
export const KUKU_FREEPOINT_PATH = '/api/genflowpro/freepoint/homenew'
/** VIP 剩余额度。 */
export const KUKU_VIP_REMAIN_PATH = '/bizapi/gfpro/getgfvipremain'

/** 登录态 Cookie 名。 */
export const KUKU_SESSION_COOKIE = 'BDUSS'
