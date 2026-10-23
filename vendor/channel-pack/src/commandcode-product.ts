/**
 * Command Code 产品配置。
 *
 * ## 为什么是又一套独立配置
 *
 * Command Code 与既有渠道的差异点与任何一个都不重合：
 *
 * | 维度 | 既有渠道 | **commandcode** |
 * |------|----------|-----------------|
 * | 登录 | OAuth / 设备码 / 手动 Cookie | **浏览器 OAuth + 本地回调** |
 * | 凭据 | access_token + refresh_token | **单个长期 API Key** |
 * | 续期 | refresh_token 轮换 | **无（Key 长期有效）** |
 * | 鉴权头 | Bearer / 自定义签名 | **标准 `Bearer <key>`** |
 * | 推理体 | 各家自有 | **标准 OpenAI 兼容** |
 *
 * ## 数据来源
 *
 * 协议来自公开的 `Mars-Sea/dsh-commandcode-provider`（同为 DSH 插件，
 * TypeScript，MIT）实测整理：
 * - API 基址：`https://api.commandcode.ai`
 * - 模型目录：`GET /provider/v1/models` → `{ object: 'list', data: [...] }`
 * - 对话：`POST /provider/v1/chat/completions`（OpenAI 兼容 SSE）
 * - 身份：`GET /alpha/whoami`
 * - 计费：`GET /alpha/billing/credits`
 * - 授权页：`https://commandcode.ai`（Studio）
 */

/** 兜底模型目录中的一个条目。 */
export interface CommandCodeFallbackModel {
  /** 模型 id（远端原样）。 */
  id: string
  /** 展示名。 */
  name: string
  /** 上下文窗口。 */
  contextWindow: number
  /** 单次输出上限。 */
  maxTokens?: number
  /** 是否接受图片输入。 */
  supportsImage?: boolean
  /** 简介。 */
  description?: string
}

/** Command Code 产品配置。 */
export interface CommandCodeProduct {
  /** provider 标识：注册到 `ctx.llm` 的路由名。 */
  id: 'commandcode'
  /** 设置页 / 模型选择器展示名。 */
  displayName: string
  /** API 基址。推理、模型目录、身份、计费全部挂在它下面。 */
  apiBase: string
  /** Studio 基址（浏览器授权页）。 */
  studioBase: string
  /**
   * 客户端标识请求头。
   *
   * 官方 CLI 会带一组身份头；本插件照原样下发，避免网关策略差异。
   */
  clientHeaders: Readonly<Record<string, string>>
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /** 模型列表不可用时的兜底目录。 */
  fallbackModels: readonly CommandCodeFallbackModel[]
}

/**
 * 兜底模型目录。
 *
 * ⚠️ 这张表是**编译期快照**，上游增删模型时不会自己跟着变。
 * 它只在远端 `/provider/v1/models` 拉取失败时整表兜底；远端可用时以远端为准。
 */
const COMMANDCODE_FALLBACK_MODELS: readonly CommandCodeFallbackModel[] = [
  {
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    contextWindow: 200_000,
    maxTokens: 64_000,
    supportsImage: true,
    description: 'Anthropic Claude Sonnet 4.5',
  },
  {
    id: 'gpt-5',
    name: 'GPT-5',
    contextWindow: 400_000,
    maxTokens: 128_000,
    supportsImage: true,
    description: 'OpenAI GPT-5',
  },
]

/** Command Code provider 配置。 */
export const COMMANDCODE: CommandCodeProduct = {
  id: 'commandcode',
  displayName: 'Command Code',
  apiBase: 'https://api.commandcode.ai',
  studioBase: 'https://commandcode.ai',
  clientHeaders: {
    'HTTP-Referer': 'https://commandcode.ai',
    'X-Title': 'Command Code',
  },
  defaultCredentialRef: 'COMMANDCODE_API_KEY',
  fallbackModels: COMMANDCODE_FALLBACK_MODELS,
}

/** 全部 Command Code 产品配置（保留数组以便将来扩展 staging）。 */
export const ALL_COMMANDCODE_PRODUCTS: readonly CommandCodeProduct[] = [COMMANDCODE]

/** 按 provider id 取产品配置；未知 id 返回 undefined。 */
export function commandCodeProductById(id: string): CommandCodeProduct | undefined {
  return ALL_COMMANDCODE_PRODUCTS.find((product) => product.id === id)
}

// ── 端点路径常量 ──
// 抽成常量而非散落字面量：登录、模型、身份、计费四处都要用。

/**
 * 浏览器授权页路径（挂 `studioBase`）。
 *
 * 依据官方 CLI `command-code@1.87.3` 的 `buildCommandAuthUrl`（源码原文）与
 * 2026-10-23 LIVE 实测：`/studio/auth/cli` 未登录时 302 → `/signin?returnTo=…`，
 * 旧 `/cli/authorize` 直接 404（官方 changelog 0.32.5「fix: CLI login UX and
 * dead studio links (#1979)」）。
 */
export const COMMANDCODE_STUDIO_AUTH_PATH = '/studio/auth/cli'
/** 身份校验（挂 `apiBase`）。 */
export const COMMANDCODE_WHOAMI_PATH = '/alpha/whoami'
/** 计费/额度（挂 `apiBase`）。 */
export const COMMANDCODE_CREDITS_PATH = '/alpha/billing/credits'
/** 模型目录（挂 `apiBase`）。 */
export const COMMANDCODE_MODELS_PATH = '/provider/v1/models'
/** 对话（OpenAI 兼容，挂 `apiBase`）。 */
export const COMMANDCODE_CHAT_PATH = '/provider/v1/chat/completions'

/**
 * 登录本地回调端口范围。
 *
 * 从 5959 起逐个试，最多试 10 个（与官方 CLI 行为一致）。
 */
export const COMMANDCODE_LOGIN_START_PORT = 5959
export const COMMANDCODE_LOGIN_MAX_PORT_ATTEMPTS = 10
/** 一次登录尝试的总时限。 */
export const COMMANDCODE_LOGIN_TIMEOUT_MS = 120_000
