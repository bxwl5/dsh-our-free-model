/**
 * CatPaw（美团）产品配置。
 *
 * ## 协议来源
 *
 * 公开的 `aimod-cc/Agent2API`（Rust，MIT）逆向整理。
 *
 * ## ⚠️ 对话是**有状态会话协议**（本渠道与其它都不同）
 *
 * 上游不是「一次请求 = 一次对话」，而是一套状态机：
 * ```
 * 全新会话   round(全量)   → event(running) → turn(user) → … → event(completed)
 * 长会话新轮 round(增量)   → event(running) → turn(user) → … → event(completed)
 * 工具续接   （不 round）  →                  turn(tool 结果) → …
 * ```
 * 需要维护 `x-session-id → conversationId` 映射与已同步消息的**指纹链**，
 * 且三条硬约束违反会导致会话卡死或上游 504：
 * 1. **每轮结束必须回报 `event(completed)`**，否则会话停在上游「执行中」，
 *    下一轮 round 被拒（`会话正在执行中，无法创建新轮次`）；
 * 2. round 与 turn 的顺序不能颠倒；
 * 3. 增量判定必须与指纹链一致。
 *
 * 参考实现该协议用了约 **1200 行**（conversation + fingerprint + decision）。
 * 本插件当前版本**只实现可靠的部分**（凭据 + 模型目录），
 * 对话能力待专门实现 —— 状态机时序写错会让用户看到「会话卡死」，
 * 比明确「不支持」更糟。
 */

/** CatPaw 产品配置。 */
export interface CatPawProduct {
  id: 'catpaw'
  displayName: string
  /** 客户网关基址（积分与设置）。 */
  gatewayBase: string
  /** 桌面端直连域名（对话与模型）。 */
  apiBase: string
  /** 默认凭据 ref。 */
  defaultCredentialRef: string
  /** 兜底模型目录。 */
  fallbackModels: readonly CatPawFallbackModel[]
}

/** 兜底模型条目。 */
export interface CatPawFallbackModel {
  id: string
  name: string
  contextWindow: number
  maxTokens?: number
}

/** 兜底模型目录（真实目录由 `POST /api/agent/maas/model-types` 下发）。 */
const CATPAW_FALLBACK_MODELS: readonly CatPawFallbackModel[] = [
  { id: 'catpaw-default', name: 'CatPaw', contextWindow: 128_000 },
]

/** CatPaw provider 配置。 */
export const CATPAW: CatPawProduct = {
  id: 'catpaw',
  displayName: 'CatPaw',
  gatewayBase: 'https://catx.nocode.cn',
  apiBase: 'https://ai.catpaw.meituan.com',
  defaultCredentialRef: 'CATPAW_CREDENTIAL',
  fallbackModels: CATPAW_FALLBACK_MODELS,
}

/** 按 id 取产品配置。 */
export function catPawProductById(id: string): CatPawProduct | undefined {
  return id === CATPAW.id ? CATPAW : undefined
}

// ── 端点路径 ──

/** 模型目录（**POST**，不是 GET）。 */
export const CATPAW_MODEL_TYPES_PATH = '/api/agent/maas/model-types'
/** 提交历史（round）。 */
export const CATPAW_ROUND_PATH = '/api/agent/conversation/round'
/** 提交本轮消息（turn，SSE）。 */
export const CATPAW_TURN_PATH = '/api/agent/conversation/turn'
/** 状态回报（running / completed）。 */
export const CATPAW_EVENT_PATH = '/api/agent/conversation/event'
/** 停止本轮。 */
export const CATPAW_TURN_STOP_PATH = '/api/agent/conversation/turn/stop'
/** 积分余额（挂在 gatewayBase）。 */
export const CATPAW_BALANCE_PATH = '/api/gateway/credit/balance'

/** 凭据头名（**Cookie 形态，不是 Bearer**）。 */
export const CATPAW_TOKEN_HEADER = 'X-Passport-Token'

/** turn 的总超时（参考实现用 15 分钟）。 */
export const CATPAW_TURN_TIMEOUT_MS = 900_000
