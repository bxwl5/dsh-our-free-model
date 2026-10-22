/**
 * MonkeyCode（长亭百智云）产品配置。
 *
 * ## 协议来源
 *
 * 公开的 `ZFXing-lite/monkeycode2api`（Go，MIT）实测整理：
 * - 基址：`https://monkeycode-ai.com`
 * - 认证：**Cookie 会话**（`nebula_session`），不是 OAuth token
 * - 模型：`GET /api/v1/users/models/available`
 * - 额度：`GET /api/v1/users/wallet`
 * - 签到：`GET/POST /api/v1/users/wallet/checkin`
 *
 * ## ⚠️ 没有可脚本化的登录
 *
 * MonkeyCode 走 OAuth 授权 + Cookie 会话，**没有设备码或本地回调**。
 * 登录只能由用户从浏览器复制 Cookie（参考实现也是这么做的）。
 * 因此本渠道的登录是「粘贴 Cookie」，体验与其它渠道不同。
 *
 * ## ⚠️ 对话走 WebSocket
 *
 * `/api/v1/users/tasks/stream` 是 WebSocket，不是 SSE。本插件零依赖，
 * 需要手写 RFC6455 客户端；且参考实现明确说「WS 事件语法无法在无实机下
 * 100% 敲定」。故**对话能力暂不实现**，先落地只读部分（账号/额度/模型）。
 */

/** MonkeyCode 产品配置。 */
export interface MonkeyCodeProduct {
  /** provider 标识。 */
  id: 'monkeycode'
  /** 展示名。 */
  displayName: string
  /** API 基址。 */
  apiBase: string
  /** 默认凭据 ref。 */
  defaultCredentialRef: string
  /** 兜底模型目录。 */
  fallbackModels: readonly MonkeyCodeFallbackModel[]
}

/** 兜底模型条目。 */
export interface MonkeyCodeFallbackModel {
  id: string
  name: string
  contextWindow: number
  maxTokens?: number
}

/**
 * 兜底模型目录。
 *
 * ⚠️ 免费额度只覆盖**基础档**模型（每日 1000 万 token）。
 * 这里列的是参考实现记录的基础档 UUID，真实目录由远端下发。
 */
const MONKEYCODE_FALLBACK_MODELS: readonly MonkeyCodeFallbackModel[] = [
  { id: '03dc8f96-8d9a-4094-a2b3-c4128b3a78a4', name: 'Kimi K2.5', contextWindow: 256_000 },
  { id: '8e22c508-97ad-490b-b38e-113faeeca275', name: 'MiniMax M2.5', contextWindow: 200_000 },
  { id: 'd937e77c-6941-48cf-913c-ec51cce138bb', name: 'Qwen 3.5 Plus', contextWindow: 128_000 },
]

/** MonkeyCode provider 配置。 */
export const MONKEYCODE: MonkeyCodeProduct = {
  id: 'monkeycode',
  displayName: 'MonkeyCode',
  apiBase: 'https://monkeycode-ai.com',
  defaultCredentialRef: 'MONKEYCODE_SESSION_COOKIE',
  fallbackModels: MONKEYCODE_FALLBACK_MODELS,
}

/** 按 id 取产品配置。 */
export function monkeyCodeProductById(id: string): MonkeyCodeProduct | undefined {
  return id === MONKEYCODE.id ? MONKEYCODE : undefined
}

// ── 端点路径 ──

/** 当前用户（验证 Cookie）。 */
export const MONKEYCODE_ME_PATH = '/api/v1/users/me'
/** 钱包与每日额度。 */
export const MONKEYCODE_WALLET_PATH = '/api/v1/users/wallet'
/** 签到状态（GET）/ 执行签到（POST）。 */
export const MONKEYCODE_CHECKIN_PATH = '/api/v1/users/wallet/checkin'
/** 平台可选模型。 */
export const MONKEYCODE_MODELS_PATH = '/api/v1/users/models/available'

/** Cookie 名（登录后浏览器种下）。 */
export const MONKEYCODE_SESSION_COOKIE = 'nebula_session'

/** 免费用户每日基础模型 token 上限（1000 万）。 */
export const MONKEYCODE_FREE_DAILY_TOKENS = 10_000_000
/** 每日签到积分。 */
export const MONKEYCODE_CHECKIN_CREDIT = 100
