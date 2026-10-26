/**
 * AutoClaw 凭据与请求构造纯函数。
 *
 * ⚠️ **认证头是 `X-Authorization`**（源实现如此，规格文档写的 `Authorization`
 * 是错的）。按文档写会 401，且与「token 失效」形态相同，极易误判。
 */

import type { AutoClawProduct } from './autoclaw-product.js'
import { AUTOCLAW_SMS_APP_ID, AUTOCLAW_SMS_APP_KEY, autoclawSign } from './autoclaw-sms.js'

/** AutoClaw 凭据。 */
export interface AutoClawCredential {
  /** 访问令牌（Bearer）。 */
  access_token: string
  /** 刷新令牌（可选）。 */
  refresh_token?: string
  /** 过期时间（毫秒时间戳）。 */
  expire_time?: number
  /** 账号标识。 */
  account_id?: string
  /** 昵称。 */
  nickname?: string
  /** 创建时间。 */
  created_at?: number
  /** 短信登录用的稳定设备号（登录 / 签到 / 续期三处请求体共用）。 */
  device_id?: string
}

/** 从任意 JSON 安全取字符串。 */
function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 是否非 null 对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 判断凭据形状是否可用。 */
export function isCredentialUsable(credential: AutoClawCredential | undefined): credential is AutoClawCredential {
  if (credential === undefined) return false
  const token = credential.access_token
  return typeof token === 'string' && token !== '' && token === token.trim()
}

/** 凭据是否已过期（留 60 秒余量）。 */
export function isCredentialExpired(credential: AutoClawCredential, nowMs: number = Date.now()): boolean {
  if (credential.expire_time === undefined) return false
  return credential.expire_time - 60_000 <= nowMs
}

/**
 * 构造请求头。
 *
 * ⚠️ `X-Authorization`（不是 `Authorization`）—— 见模块头注释。
 */
/**
 * 桌面端版本（上游 `DESKTOP_APP_VERSION`；userapi 域另有
 * `AUTOCLAW_USERAPI_VERSION`，两个域各按各的门控，别混）。
 */
const AUTOCLAW_DESKTOP_VERSION = '1.18.5'

/**
 * 平台标识（上游 `platform_tm`）。
 *
 * ⚠️ **Linux 必须回落 `win`**：上游注释记录了实测 —— 被绑为 Windows 的账号
 * 收到 `X-Tm: linux` 一律 403/406，而 `win` / `mac` / 不带该头都放行。
 * 上游只拒绝「恰好等于 linux」的值。官方桌面端只有 Windows / macOS，
 * Linux 不是它认得的客户端平台，故这里同样回落。
 */
const autoclawPlatformTm = (): string => {
  if (process.platform === 'darwin') return 'mac'
  return 'win'
}

export function autoClawHeaders(product: AutoClawProduct, credential: AutoClawCredential): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    // 源实现给的是 `Accept: */*`（LLM 代理两种响应形态都可能回；
    // 不是 text/event-stream —— 要不要流式由 body.stream 决定）。
    Accept: '*/*',
    // 认证头名照抄源实现：`X-Authorization`，不是 `Authorization`。
    'X-Authorization': `Bearer ${credential.access_token}`,
    // 客户端指纹（上游 `brand_headers`）：缺了会被上游按非官方客户端拒。
    'X-Product': 'autoclaw',
    'X-Client-Type': 'pc',
    'X-Tm': autoclawPlatformTm(),
    'X-Version': AUTOCLAW_DESKTOP_VERSION,
    'X-Lang': 'zh-CN',
    'X-Channel': 'official',
    'x_trace_id': 'autoclaw-desktop',
    Origin: product.apiBase,
    Referer: `${product.apiBase}/`,
  }
}

/**
 * **模型目录**专用请求头。
 *
 * ⚠️ 与对话头不同：目录端点（`AUTOCLAW_MODEL_CONFIG_PATH`）认的是标准
 * **`Authorization: Bearer`**，用 `X-Authorization` 会 401 `{"error":"Invalid token"}`
 * —— 那个报错和「token 真失效」一模一样，2026-10-24 排查时差点误判。
 * 实测：`GET /autoclaw-proxy/proxy/autoclaw-model-config` + Authorization → 200 三个模型。
 */
export function autoClawCatalogHeaders(
  product: AutoClawProduct,
  credential: AutoClawCredential,
  timestamp: number = Math.floor(Date.now() / 1000),
): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${credential.access_token}`,
    // 签名三件套（与 userapi 域同口径，见 autoclaw-sms.ts 的 autoclawSign）。
    // 上游 catalog.rs：目录接口除 Bearer 外还要这套可复算的签名头，
    // 且**与刷新接口共用同一份实现**（复制会让 appId/appKey 与时间戳单位
    // 各自演进，签名一旦分叉就是稳定 400002）。
    'X-Auth-Appid': AUTOCLAW_SMS_APP_ID,
    'X-Auth-TimeStamp': String(timestamp),
    'X-Auth-Sign': autoclawSign(AUTOCLAW_SMS_APP_ID, timestamp, AUTOCLAW_SMS_APP_KEY),
    /**
     * ⚠️ **版本门控**：目录下发的模型集合按它分档（2026-10-26 实测）。
     *
     * 同一账号、同一凭据，只改这一个头：
     * - `1.18.5` → **4 个**（含 `zai_glm-5.3-flash`）
     * - `1.12.1` / `1.12.0` / `1.13.0` / `1.6.5` → 3 个（缺 flash）
     *
     * 这正是「官方客户端显示 4 个、插件只有 3 个」的直接原因 —— 此前本函数
     * **完全没发这个头**，上游按最低档下发。上游注释也写明它是客户端版本门控
     * （`CLIENT_VERSION`：「模型目录等 userapi 接口按它决定下发哪一档清单」）。
     */
    'X-Version': AUTOCLAW_DESKTOP_VERSION,
    Origin: product.apiBase,
    Referer: `${product.apiBase}/`,
  }
}

/** 对话端点。 */
export function chatEndpoint(product: AutoClawProduct): string {
  return `${product.apiBase}${product.proxyPrefix}/chat/completions`
}

/** 访问令牌的长度上下限（形状检查，不联网）。 */
const TOKEN_MIN = 16
const TOKEN_MAX = 4096

/** 清洗并校验一个 Bearer 访问令牌；形状不合法返回 `undefined`。 */
function normalizeAccessToken(raw: string): string | undefined {
  let token = raw.trim()
  token = token.replace(/^bearer\s+/i, '')
  token = token.replace(/^"([^"]*)"$/, '$1').trim()
  if (token.length < TOKEN_MIN || token.length > TOKEN_MAX) return undefined
  if (!/^[\x21-\x7E]+$/.test(token)) return undefined
  return token
}

/**
 * 从凭据 JSON 解析（字段名兼容多种拼写）。
 *
 * `access_token` 经 {@link normalizeAccessToken} 清洗与形状校验 ——
 * `account.adopt` 粘贴的令牌常带 `Bearer ` 前缀、成对引号或首尾空白；
 * 长度 16–4096、可打印 ASCII 无空白，不满足即拒绝（`abc` 这种短值
 * 收下也只会换来一次上游 401）。智谱系 API key 形如 `id.secret`，
 * 实测远长于下限 16。
 */
export function parseCredential(value: unknown): AutoClawCredential | undefined {
  if (!isRecord(value)) return undefined
  const tokenRaw = stringValue(value.access_token) ?? stringValue(value.accessToken)
    ?? stringValue(value.token)
  if (tokenRaw === undefined) return undefined
  const token = normalizeAccessToken(tokenRaw)
  if (token === undefined) return undefined
  const expiresRaw = value.expire_time ?? value.expiresAt ?? value.expires_at
  const expireTime = typeof expiresRaw === 'number' && Number.isFinite(expiresRaw)
    ? (expiresRaw < 1e12 ? expiresRaw * 1000 : expiresRaw)
    : undefined
  return {
    access_token: token,
    ...(stringValue(value.refresh_token) === undefined && stringValue(value.refreshToken) === undefined
      ? {} : { refresh_token: stringValue(value.refresh_token) ?? stringValue(value.refreshToken) }),
    ...(expireTime === undefined ? {} : { expire_time: expireTime }),
    ...(stringValue(value.account_id) === undefined ? {} : { account_id: stringValue(value.account_id) }),
    ...(stringValue(value.nickname) === undefined ? {} : { nickname: stringValue(value.nickname) }),
    created_at: Date.now(),
  }
}

/**
 * 解析模型目录响应。
 *
 * 上游形态未完全确定（参考实现只记录路径），故做宽松归一：
 * 依次尝试 `models` / `data` / 顶层数组三种形态。
 */
/**
 * 解析 AutoClaw 的模型目录（`/autoclaw-proxy/proxy/autoclaw-model-config`）。
 *
 * ⚠️ **AutoClaw 是「按量计费」，不是倍率套餐**（用户 2026-10-26 明确说明，
 * 与 zcode 同类）。故本函数**不产出倍率**，只如实取：
 * - `creditConsumptionLevel`（积分消耗档：`低`/`中`/`高`）—— 这是**分档标签**，
 *   不是数字倍率，展示成「积分·低」而不是 `x0.5`；
 * - `reasoningLevel`（思考档位表，如 `['low','high','max']`）+ `reasoning`；
 * - `tooltip`（上游给的中文说明，用作 description）。
 *
 * 早期实现只取 `{id, name, contextWindow, maxTokens}`，把档位与说明全丢了
 * （用户报障「从远端拉取但推理强度没了」）。
 */
export interface AutoClawModelRow {
  id: string
  name: string
  contextWindow: number
  maxTokens?: number
  /** 积分消耗档（上游 `creditConsumptionLevel`，中文分档）。 */
  creditLevel?: string
  /** 思考档位 id 表（上游 `reasoningLevel`）。 */
  efforts?: string[]
  /** 上游是否支持思考（`reasoning`）。 */
  supportsThinking?: boolean
  /** 上游中文说明（`tooltip`）。 */
  tooltip?: string
}

export function parseModelConfig(value: unknown): AutoClawModelRow[] {
  const list = Array.isArray(value) ? value
    : isRecord(value) && Array.isArray(value.models) ? value.models
    : isRecord(value) && Array.isArray(value.data) ? value.data
    : undefined
  if (list === undefined) return []
  const rows: AutoClawModelRow[] = []
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as Record<string, unknown>
    const id = stringValue(item.id) ?? stringValue(item.model) ?? stringValue(item.name)
    if (id === undefined) continue
    const name = stringValue(item.name) ?? stringValue(item.displayName) ?? id
    const contextRaw = item.contextWindow ?? item.context_length ?? item.maxInputTokens
    const contextWindow = typeof contextRaw === 'number' && contextRaw > 0 ? contextRaw : 128_000
    const maxRaw = item.maxTokens ?? item.max_output_tokens
    const maxTokens = typeof maxRaw === 'number' && maxRaw > 0 ? Math.min(maxRaw, contextWindow) : undefined
    // 思考档位：`reasoningLevel` 是**字符串数组**（实测 `['low','high','max']`）。
    const levelsRaw = item.reasoningLevel
    const efforts = Array.isArray(levelsRaw)
      ? levelsRaw.filter((level): level is string => typeof level === 'string' && level !== '')
      : undefined
    const creditLevel = stringValue(item.creditConsumptionLevel)
    const tooltip = stringValue(item.tooltip)
    rows.push({
      id,
      name,
      contextWindow,
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(creditLevel === undefined ? {} : { creditLevel }),
      ...(efforts === undefined || efforts.length === 0 ? {} : { efforts }),
      ...(item.reasoning === true ? { supportsThinking: true } : {}),
      ...(tooltip === undefined ? {} : { tooltip }),
    })
  }
  return rows
}
