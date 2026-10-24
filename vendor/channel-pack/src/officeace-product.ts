/**
 * OfficeAce（华为云果办 / OfficeClaw）产品配置。
 *
 * ## 协议来源
 *
 * 公开的 `aimod-cc/Agent2API`（Rust，MIT）逆向整理，
 * 与 `Q-shuang-dot/officeace2api` 逐条一致：
 * - 云端网关：`https://agentarts.cn-southwest-2.myhuaweicloud.com`
 * - IAM：`https://iam.myhuaweicloud.com`
 * - 登录：`https://auth.huaweicloud.com/authui/login.html`
 *
 * ## 登录是「自助 OAuth + 轮询」
 *
 * 与其它渠道最大的不同：**回调不落本机**。
 * 用户在浏览器登录华为云后，云端回调页只是终点页；授权码由本插件
 * **轮询** `GET /v1/claw/auth/code?state=<state>` 取回：
 * - `202` = 还没登完，继续等
 * - `404` = state 不认识/已过期，直接判作废（**必须读状态码**，
 *   否则失败会拖到超时才报，用户看到的是静默挂起）
 * - `200` = 拿到授权码
 *
 * ## 三套签名
 *
 * | 用途 | 算法 |
 * |---|---|
 * | STS 换临时凭据 | **DPoP**（ES256 JWS） |
 * | 业务接口 | **SDK-HMAC-SHA256** |
 * | 部分接口 | **V11-HMAC-SHA256**（派生密钥按小写十六进制参与 HMAC） |
 */

/** OfficeAce 产品配置。 */
export interface OfficeAceProduct {
  id: 'officeace'
  displayName: string
  /** 云端网关基址。 */
  cloudBase: string
  /** IAM 基址。 */
  iamBase: string
  /** 登录页基址。 */
  loginBase: string
  /** STS 换 token 基址。 */
  stsBase: string
  /** OAuth client id（官方值）。 */
  clientId: string
  /**
   * 回调地址（**指向云端，不是本机 loopback**）。
   *
   * 这是与其它 OAuth 渠道最不同的一点：授权码要轮询去取，不是等回调。
   */
  redirectUri: string
  /** 默认凭据 ref。 */
  defaultCredentialRef: string
  /** 兜底模型目录。 */
  fallbackModels: readonly OfficeAceFallbackModel[]
}

/** 兜底模型条目。 */
export interface OfficeAceFallbackModel {
  id: string
  name: string
  contextWindow: number
  maxTokens?: number
}

/** 兜底模型目录（真实目录由 `client-permission-validate` 下发）。 */
const OFFICEACE_FALLBACK_MODELS: readonly OfficeAceFallbackModel[] = [
  { id: 'officeace-default', name: 'OfficeAce', contextWindow: 128_000 },
]

/** OfficeAce provider 配置。 */
export const OFFICEACE: OfficeAceProduct = {
  id: 'officeace',
  displayName: 'OfficeAce 果办',
  cloudBase: 'https://agentarts.cn-southwest-2.myhuaweicloud.com',
  iamBase: 'https://iam.myhuaweicloud.com',
  loginBase: 'https://auth.huaweicloud.com',
  // ⚠️ STS 的 OAuth2 token 端点**只在 `cn-north-4` 提供**，不是业务面所在的
  // `cn-southwest-2`。用错 region 会在换码时报：
  //   HTTP 404 {"error_code":"STS5.1007","error_msg":"this API is not supported in this region"}
  // 依据：参考实现 `Q-shuang-dot/officeace2api` 的 `DEFAULT_TOKEN_URL`
  // （`https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens`）。
  stsBase: 'https://sts.cn-north-4.myhuaweicloud.com',
  clientId: 'pdp5_for_agentarts',
  redirectUri: 'https://agentarts.cn-southwest-2.myhuaweicloud.com/v1/claw/auth/callback',
  defaultCredentialRef: 'OFFICEACE_CREDENTIAL',
  fallbackModels: OFFICEACE_FALLBACK_MODELS,
}

/** 按 id 取产品配置。 */
export function officeAceProductById(id: string): OfficeAceProduct | undefined {
  return id === OFFICEACE.id ? OFFICEACE : undefined
}

// ── 端点路径 ──

/** 取 state（无鉴权）。 */
export const OFFICEACE_STATE_PATH = '/v1/claw/auth/state'
/** 轮询授权码（**必须读状态码**：202 继续 / 404 作废 / 200 成功）。 */
export const OFFICEACE_CODE_PATH = '/v1/claw/auth/code'
/** 身份校验 + 模型信息（SDK-HMAC 签名）。 */
export const OFFICEACE_PERMISSION_PATH = '/v1/claw/client-permission-validate'
/** 开通订阅（仅 model_info 为空时调）。 */
export const OFFICEACE_SUBSCRIPTION_PATH = '/v1/claw/client-subscription'
/** STS 换临时凭据（表单 + DPoP 头）。 */
export const OFFICEACE_STS_TOKENS_PATH = '/v1/oauth2/tokens'
/** IAM projects（补 project_id）。 */
export const OFFICEACE_IAM_PROJECTS_PATH = '/v3/projects'

/** 授权页路径（挂 loginBase）。 */
export const OFFICEACE_AUTHORIZE_PATH = '/authui/login.html'

/** 轮询授权码的间隔（毫秒）。 */
export const OFFICEACE_POLL_INTERVAL_MS = 2_000
/** 一次登录的总时限。 */
export const OFFICEACE_LOGIN_TIMEOUT_MS = 600_000
