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

/**
 * 兜底模型条目。
 *
 * ⚠️ 后四个可选字段与远端行 `KukuModelEntry`（kuku-adapter.ts）**对齐**
 * （2026-10-31 tsc 门禁）：适配器把「远端行 | 兜底行」做联合，收窄后只能看到
 * 公共字段 —— 兜底行缺这些可选字段时，`description` / `priceFactor` 在联合上
 * 「不存在」（TS2339 ×2），展示层被迫失明。全可选，兜底表不填即无该信息。
 */
export interface KukuFallbackModel {
  /** 模型 wire 名（`model_name`）。 */
  id: string
  /** 展示名（`model_display_name`）。 */
  name: string
  contextWindow: number
  maxTokens?: number
  /** 是否支持思考档位。 */
  thinking?: boolean
  /** 倍率（从 `"0.16x"` 解析成数字）；兜底表条目可不填。 */
  priceFactor?: number
  /** 上游原文描述（`description`）；兜底表条目可不填。 */
  description?: string
  /** 会员专属（`vip_type: 1`）；兜底表条目可不填。 */
  vipOnly?: boolean
}

/**
 * 兜底模型目录。
 *
 * ⚠️ 上游模型集合由服务端下发，这张表只是拉取失败时的兜底。
 * `id` 同时用作 `model_name` 与 `model_display_name`（实测上游两者一致时可用）。
 */
/**
 * 兜底模型目录。
 *
 * 2026-10-25 更正：原表只有占位 id `kuku`，而它**不是真实模型名** ——
 * 拿它发对话上游只会回空/错误。上游真实模型 id 是
 * `gateway-<family>-<version>-<vendor>` 这类长名（`auto` 是自动选路）。
 * 清单取自上游 `aimod-cc/Agent2API` 的 `providers/kuku/models.rs`
 * `FALLBACK_MODEL_IDS`（kuku2api 2026-09-13 实测的 13 个 `model_name`），
 * 并已由本仓库 2026-10-25 与远端 `model/list` 对照。
 *
 * ⚠ 只是兜底：`kuku-adapter.ts` 会拉远端 `GET /wenchain/genflowpro/model/list`
 * （TTL 10 分钟）。拉不到时才用这张表。
 */
const KUKU_FALLBACK_MODELS: readonly KukuFallbackModel[] = [
  { id: 'auto', name: 'Auto', contextWindow: 128_000 },
  { id: 'gateway-deepseek-v4.1-flash-tencent', name: 'DeepSeek-V4.1-Flash', contextWindow: 128_000 },
  { id: 'gateway-deepseek-v4-pro-tencent', name: 'DeepSeek-V4-Pro', contextWindow: 128_000 },
  { id: 'gateway-deepseek-v4-flash-tencent', name: 'DeepSeek-V4-Flash', contextWindow: 128_000 },
  { id: 'gateway-glm-5.3-flash', name: 'GLM-5.3-Flash', contextWindow: 128_000 },
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 128_000 },
  { id: 'gateway-glm-5.2', name: 'GLM-5.2', contextWindow: 128_000 },
  { id: 'gateway-glm-5.1-kuaishou', name: 'GLM-5.1', contextWindow: 128_000 },
  { id: 'ernie-5.1', name: 'ERNIE-5.1', contextWindow: 128_000 },
  { id: 'ms-kimi-k3', name: 'Kimi-K3', contextWindow: 128_000 },
  { id: 'gateway-kimi-k2.7-code-tencent', name: 'Kimi-K2.7-Code', contextWindow: 128_000 },
  { id: 'gateway-kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 128_000 },
  { id: 'ali-minimax/minimax-m3', name: 'MiniMax-M3', contextWindow: 128_000 },
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

/**
 * `client_added` 里内嵌的客户端形态字段（上游 kuku/chat.rs 的 create_session）。
 *
 * ⚠️ 这几个与上面 `KUKU_CLIENT_TYPE` / `KUKU_VERSION` / `KUKU_CHANNEL` **不是同一套**
 * ——后者是请求体的 `device_type` / `v` / `channel` 字段（Web 版形态），
 * 而 `client_added` 里要的是**桌面客户端形态**（clienttype 400 / version 1.4.4 /
 * channel chunlei / app_id 123971023）。两处都要各自正确，否则上游按形态不符
 * 回 `invalid session_id`（2026-10-26 实测）。
 */
export const KUKU_CLIENT_ADDED_CLIENT_TYPE = 400
export const KUKU_CLIENT_ADDED_VERSION = '1.4.4'
export const KUKU_CHANNEL_NAME = 'chunlei'
export const KUKU_APP_ID = 123971023

// ── 端点路径 ──

/** 建消息。 */
export const KUKU_SENDMSG_PATH = '/wenchain/genflowpro/sendmsg'
/** 流式取正文。 */
export const KUKU_SSE_PATH = '/wenchain/genflowpro/sse/getchatcontent'
/** 免费积分首页（额度）。 */
export const KUKU_FREEPOINT_PATH = '/api/genflowpro/freepoint/homenew'

/**
 * 会话校验 / 换取三件套（挂 `apiBase`）。
 *
 * 上游 `aimod-cc/Agent2API` 的 `providers/kuku/session.rs`：对话链路**每次
 * 请求都要带 `bdstoken` / `uinfo` / `uk`（拼进 query）**，它们由本接口用
 * 登录 Cookie 换来（kuku2api 实测）。少了这一步直接打 `sendmsg` 会拿到
 * `{"status":{"code":200002,"msg":"invalid session_id"}}` —— 我们此前正是
 * 这么做的，于是「模型列表能拉到、对话永远回空」。
 */
export const KUKU_USERREPORT_PATH = '/api/genflowpro/common/userreport'

/**
 * 领取免费积分任务（挂 `apiBase`，POST 表单 `task_type=LOGIN|CHAT`）。
 *
 * 上游 `providers/kuku/checkin.rs`：`taskComplete` 是**幂等**的 —— 重复领
 * 返回 `SUCCESS` + `reward_point=0`（或 `BADGE_ALREADY_RECEIVED`），
 * 因此「已领过」不算失败。
 */
export const KUKU_TASK_COMPLETE_PATH = '/api/genflowpro/freepoint/taskComplete'
/** VIP 剩余额度。 */
export const KUKU_VIP_REMAIN_PATH = '/bizapi/gfpro/getgfvipremain'

/**
 * 模型目录（挂 `apiBase`）。
 *
 * 上游 `aimod-cc/Agent2API` 的 `providers/kuku/models.rs` 记录：路径是
 * `model/list`（2026-10-07 逆向 app.asar + 真实凭证实测；旧路径 `model_list`
 * 已废弃返回 404）。响应是顶层 `{status, data}` 包络，模型名在 `data` 里。
 */
export const KUKU_MODEL_LIST_PATH = '/wenchain/genflowpro/model/list'

/**
 * 目录请求的固定查询串（与官方 Web 客户端一致）。
 *
 * 取自上游 `providers/kuku/mod.rs` 的 `WEB_QUERY`。上游对这批参数敏感，
 * 缺了会拿到空列表或 4xx。
 */
export const KUKU_WEB_QUERY = 'clienttype=400&app_id=123971023&web=1&channel=chunlei&version=1.4.4'

/** 登录态 Cookie 名。 */
export const KUKU_SESSION_COOKIE = 'BDUSS'
