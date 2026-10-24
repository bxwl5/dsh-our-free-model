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
  // 2026-10-24 按上游 `GET /api/v1/users/models/available` 实拉结果同步
  //（26 条中剔除 is_hidden / visible:false 后共 14 条可见）。
  // 原表只有 3 条实验记录且 Qwen UUID 是编的（`...-6941-48cf-...`，真值 `...-410c-...`），
  // 拿它发请求必然 404；现已全量覆盖。
  { id: '7f292d79-1f0b-40de-9b98-46b1ba66f7a2', name: 'qwen3.6-plus', contextWindow: 128000 },
  { id: '46f84b51-566d-439c-98d2-2db8b8d04689', name: 'monkeycode-basic/qwen3.5-plus', contextWindow: 128000 },
  { id: 'c79063e2-a4d4-4f15-8f8c-a604f959c377', name: 'monkeycode-basic/glm-5.3-flash', contextWindow: 128000 },
  { id: '08d76917-9d00-4b30-8496-64e29252d2cd', name: 'qwen3.7-max', contextWindow: 128000 },
  { id: '8e22c508-97ad-490b-b38e-113faeeca275', name: 'minimax-m2.5', contextWindow: 128000 },
  { id: 'a734a35c-6cf2-4b9b-ae39-29f3e18ee1cf', name: 'minimax-m3', contextWindow: 128000 },
  { id: 'c5a183f1-2876-45cf-905d-c1b9a85fc819', name: 'monkeycode-basic/deepseek-flash', contextWindow: 128000 },
  { id: '5e69521a-cc93-4ea8-9ffb-98650a879e74', name: 'deepseek-flash', contextWindow: 128000 },
  { id: 'e07243b6-4dc4-40c4-a486-a9ffa8d46c4a', name: 'glm-5', contextWindow: 128000 },
  { id: 'a290bb6b-843b-427c-b6cc-0e34dd82385d', name: 'monkeycode-basic/minimax-m2.5', contextWindow: 128000 },
  { id: '7e4b3ade-20b1-4b26-9a36-dc2043623a78', name: 'glm-5.1', contextWindow: 128000 },
  { id: '7331f932-5025-458c-9eaa-cb6f455dfc38', name: 'kimi-k2.6', contextWindow: 128000 },
  { id: 'c82ac16d-aaf5-4197-9040-4227ec2299a5', name: 'monkeycode-basic/kimi-k2.5', contextWindow: 128000 },
  { id: 'd4fd356d-56d3-48b1-8096-560699a3aa04', name: 'monkeycode-basic/qwen3.8-flash', contextWindow: 128000 },
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

/** 建任务（对话入口）。 */
export const MONKEYCODE_TASKS_PATH = '/api/v1/users/tasks'
/** 任务流 WebSocket。 */
export const MONKEYCODE_STREAM_PATH = '/api/v1/users/tasks/stream'
/** 公共 devbox 镜像 id（建任务必填）。 */
export const MONKEYCODE_PUBLIC_IMAGE_ID = '2e214f06-79ba-4535-9ac1-89adc2d9c6cc'
/** 公共托管主机占位符（建任务必填）。 */
export const MONKEYCODE_PUBLIC_HOST = 'public_host'

/** Cookie 名（登录后浏览器种下）。 */
export const MONKEYCODE_SESSION_COOKIE = 'nebula_session'

/**
 * 会话字段的**候选名**。
 *
 * 2026-10-24 用户实测：登录后浏览器里实际写的是 **`monkeycode_ai_session`**
 *（`nebula_session` 已不再出现），只认旧名会让「完整 Cookie 也登不进去」。
 * 两个名字都收，精确到 `name=` 前缀匹配。
 */
export const MONKEYCODE_SESSION_COOKIES = ['monkeycode_ai_session', 'nebula_session'] as const

/** 免费用户每日基础模型 token 上限（1000 万）。 */
export const MONKEYCODE_FREE_DAILY_TOKENS = 10_000_000
/** 每日签到积分。 */
export const MONKEYCODE_CHECKIN_CREDIT = 100
