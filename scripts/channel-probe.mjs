#!/usr/bin/env node
/**
 * 渠道端点**手动探活**脚本。
 *
 * ## 它做什么
 *
 * 对每个账号渠道探两类事实：
 * 1. **登录入口**是否可达（官方站点 / 授权页 / 设备码端点）；
 * 2. **模型目录**、**余额/额度**、签到等 HTTP 端点是否还在。
 *
 * 默认**不带凭据**：探的不是「账号能不能用」，而是「端点还在不在」。
 * 因此 `401/403` 记为「存活（需鉴权）」，`400/405` 记为「存活（需参数）」，
 * `404/410` 才是「疑似死链」。需要真实数据时用 `--token` / `--cookie`。
 *
 * ## 为什么是独立脚本
 *
 * 它要打**真实外网**、依赖上游当前状态，且端点死链通常不是代码回归。
 * 因此：
 * - **不进入默认测试套件**（`scripts/test-all.mjs` 不引用本文件）；
 * - 只在手动排障 / 渠道收尾时运行：`node scripts/channel-probe.mjs`；
 * - 退出码默认恒为 0（探活是信息性输出）；需要 CI 式判定时加 `--fail-on-dead`。
 *
 * ## 已固化的实测坑（2026-10-23 实测）
 *
 * | 渠道 | 坑 | 本脚本的处理 |
 * |------|----|--------------|
 * | Qoder / Qoder 中国版 | usage/campaigns 挂 **openapi** host（不是 api2 系列 / qoder.com） | 端点表直接写 `openapi.qoder.sh` / `openapi.qoder.com.cn` |
 * | CodeBuddy / WorkBuddy | `auth/state` 必须 **POST**，GET 返回 404 | `method: 'POST'` |
 * | OfficeAce | `auth/state` 必须 **POST**；`auth/code` 需要先拿 state | POST + `statusLabels` 标注 404 = state 未初始化 |
 * | MiniMax | 模型目录要带 `region=&buildEnv=` 查询参数 | URL 固定带 `region=cn-prod&buildEnv=prod` |
 * | Cline | GET 偶发抖动（连接被重置/超时） | 相关端点 `retry: 1`，传输失败自动重试一次 |
 * | AutoClaw（国内/国际） | `model-config` 在无真实令牌时 **404**，不能据此判死链 | `requiresRealToken: true`，标「需真实令牌终验」 |
 *
 * ## 用法
 *
 * ```bash
 * node scripts/channel-probe.mjs                      # 全部渠道
 * node scripts/channel-probe.mjs --list               # 只列渠道/端点清单
 * node scripts/channel-probe.mjs -c qoder,cline       # 指定渠道
 * node scripts/channel-probe.mjs -k models,balance    # 指定端点类型
 * node scripts/channel-probe.mjs -e usage,campaigns   # 指定端点名（子串，忽略大小写）
 * node scripts/channel-probe.mjs --token "$TOKEN"     # 带 Bearer（多数端点会变 200）
 * node scripts/channel-probe.mjs --cookie "BDUSS=…"   # 粘贴型渠道带 Cookie
 * node scripts/channel-probe.mjs --json               # 机器可读
 * node scripts/channel-probe.mjs --timeout 5000 --retries 2
 * node scripts/channel-probe.mjs --fail-on-dead       # 有死链时退出码 1
 * ```
 *
 * 数据来源：各渠道 `vendor/channel-pack/src/*-product.ts` / `*auth.ts` /
 * `*credits.ts` 中的端点常量（每条都注明来源），不是猜的。
 */

import process from 'node:process'

/** 端点类型及中文标签。 */
const KIND_LABELS = Object.freeze({
  login: '登录',
  models: '模型',
  balance: '余额',
  checkin: '签到',
  identity: '身份',
})

/** 构造一个端点描述（纯数据，方便逐条核对来源）。 */
function ep(name, kind, url, options = {}) {
  return { name, kind, url, method: 'GET', ...options }
}

/**
 * 渠道端点表。
 *
 * ⚠️ 维护约定：
 * - `url: null` 表示该渠道在插件里**没有对应的 HTTP 端点**（例如模型目录来自
 *   本地解密文件、或由控制台会话下发）——不要为了「有一条记录」而编造 URL；
 * - 每条 URL 的 `note`/`source` 必须能指回源码常量，改源码时同步改这里；
 * - 新增渠道时同步 `README.md` 的渠道表与 `docs/channel-capability-matrix.md`。
 */
const CHANNELS = [
  // ───────────────────────────── 华为系 ─────────────────────────────
  {
    id: 'codearts',
    name: 'CodeArts',
    loginMode: '浏览器授权（华为 IAM）',
    notes: [
      '登录 URL 由本地回调端口 + PKCE 动态拼出（login.ts buildOAuthLoginUrl），这里探门户登录页。',
      '模型/额度端点走 AK/SK 签名（signRequestHuawei），无签名 401 属正常。',
    ],
    endpoints: [
      ep('登录入口', 'login', 'https://codearts.huaweicloud.com/portal/login', { source: 'login.ts PORTAL_LOGIN_BASE' }),
      ep('模型目录', 'models', 'https://snap-access.cn-north-4.myhuaweicloud.com/v1/model/builtin', {
        auth: 'AK/SK 签名', source: 'models.ts SNAP_MODEL_BUILTIN_URL',
      }),
      ep('模型目录（网关）', 'models', 'https://opengw.developer.huaweicloud.com/api/v1/gateway/config', {
        auth: 'AK/SK 签名', source: 'models.ts OPENGW_GATEWAY_CONFIG_URL',
      }),
      ep('套餐/额度', 'balance', 'https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/statistics/plugin', {
        auth: 'AK/SK 签名', source: 'codearts-credits.ts CODEARTS_PACKAGE_INFO_PATH',
      }),
    ],
  },

  // ─────────────────────── 腾讯 CodeBuddy 系 ────────────────────────
  {
    id: 'buddy',
    name: 'CodeBuddy',
    loginMode: '浏览器授权（cli-external-link）',
    notes: [
      '⚠️ auth/state 必须 POST：GET 返回 404（2026-10-23 实测；buddy.ts 注释同样写 POST）。',
      'auth/state 返回 { state, authUrl }，真正的登录 URL 由它下发——这里只探端点存活。',
    ],
    endpoints: [
      ep('登录入口', 'login', 'https://www.codebuddy.cn/login/?platform=ide', { source: 'buddy.ts WEBSITE_HOME + state' }),
      ep('授权 state', 'login', 'https://copilot.tencent.com/v2/plugin/auth/state?platform=ide', {
        method: 'POST', body: '{}', auth: '无（换取登录地址）', source: 'buddy.ts AUTH_STATE_PATH',
      }),
      ep('模型目录', 'models', 'https://copilot.tencent.com/v3/config', { source: 'buddy.ts CONFIG_PATH' }),
      ep('积分余额', 'balance', 'https://copilot.tencent.com/v2/billing/meter/get-user-resource', {
        method: 'POST', body: '{}', auth: 'Bearer', source: 'credits.ts USER_RESOURCE_PATH',
      }),
      ep('签到状态', 'checkin', 'https://copilot.tencent.com/v2/billing/meter/checkin-activity-status', {
        method: 'POST', body: '{}', auth: 'Bearer', source: 'credits.ts CHECKIN_ACTIVITY_STATUS_PATH',
      }),
    ],
  },
  {
    id: 'workbuddy',
    name: 'WorkBuddy（国际版）',
    loginMode: '浏览器授权（cli-external-link）',
    notes: [
      '⚠️ auth/state 必须 POST（GET 404）；platform=workbuddy-ai 与 CodeBuddy 不同。',
      '国际版**没有**每日签到积分接口（见 product.ts WORKBUDDY 注释）。',
    ],
    endpoints: [
      ep('登录入口', 'login', 'https://www.workbuddy.ai/', { source: 'product.ts WORKBUDDY.endpoint' }),
      ep('授权 state', 'login', 'https://www.workbuddy.ai/v2/plugin/auth/state?platform=workbuddy-ai', {
        method: 'POST', body: '{}', auth: '无（换取登录地址）', source: 'buddy.ts AUTH_STATE_PATH',
      }),
      ep('模型目录', 'models', 'https://www.workbuddy.ai/v3/config', { source: 'buddy.ts CONFIG_PATH' }),
      ep('积分余额', 'balance', 'https://www.workbuddy.ai/v2/billing/meter/get-user-resource', {
        method: 'POST', body: '{}', auth: 'Bearer', source: 'credits.ts USER_RESOURCE_PATH（两产品通用）',
      }),
    ],
  },

  // ───────────────────────────── 网易 LobsterAI ─────────────────────
  {
    id: 'lobsterai',
    name: 'LobsterAI',
    loginMode: '浏览器授权（门户回调）',
    notes: [
      '登录门户是 {portalBase}/portal（lobsterai-product.ts LOBSTERAI_PORTAL_BASE）。',
      '签到槽位 /api/client-activities/slot 需要完整 query（clientVersion/platform/placement），单探会 5xx，标注为「需完整参数」。',
    ],
    endpoints: [
      ep('登录入口', 'login', 'https://lobsterai.youdao.com/portal', { source: 'lobsterai-product.ts LOBSTERAI_PORTAL_BASE' }),
      ep('模型目录', 'models', 'https://lobsterai-server.youdao.com/api/models/available', {
        auth: 'Bearer', source: 'lobsterai.ts LOBSTERAI_MODELS_PATH',
      }),
      ep('积分余额', 'balance', 'https://lobsterai-server.youdao.com/api/user/profile-summary', {
        auth: 'Bearer', source: 'lobsterai-credits.ts LOBSTERAI_PROFILE_SUMMARY_PATH',
      }),
      ep('签到槽位', 'checkin', 'https://lobsterai-server.youdao.com/api/client-activities/slot?placement=desktop_sidebar', {
        method: 'GET', auth: 'Bearer', source: 'lobsterai-credits.ts LOBSTERAI_ACTIVITY_SLOT_PATH',
        statusLabels: { 500: '存活（需完整 query）' },
      }),
    ],
  },

  // ───────────────────────────── Qoder 系 ──────────────────────────
  {
    id: 'qoder',
    name: 'Qoder',
    loginMode: '浏览器授权（device/selectAccounts）',
    notes: [
      '⚠️ usage / campaigns 挂 **openapi.qoder.sh**（不是 api2*.qoder.sh，也不是 qoder.com）。',
      '真实授权 URL 带 PKCE challenge / nonce / machine_id / client_id（qoder.ts buildQoderAuthUrl）；这里只探入口。',
      '模型目录来自本机 ~/.qoder 的 catalog-v6 解密文件，**没有** HTTP 目录端点。',
    ],
    endpoints: [
      ep('登录入口', 'login', 'https://qoder.com/device/selectAccounts', { source: 'qoder.ts QODER_DEVICE_SELECT_PATH + authBase' }),
      ep('模型目录', 'models', null, { note: '本地 catalog-v6 解密（qoder-product.ts fallbackModels），无 HTTP 端点' }),
      ep('余额/用量', 'balance', 'https://openapi.qoder.sh/sash/api/v2/me/usage', {
        auth: 'Bearer + Cosy-ClientType', source: 'qoder-credits.ts QODER_USAGE_PATH',
      }),
      ep('签到活动', 'checkin', 'https://openapi.qoder.sh/sash/api/v1/me/campaigns', {
        auth: 'Bearer + Cosy-ClientType', source: 'qoder-credits.ts QODER_CAMPAIGNS_PATH',
      }),
      ep('登录轮询', 'login', 'https://openapi.qoder.sh/api/v1/deviceToken/poll', {
        source: 'qoder.ts QODER_POLL_PATH', note: '无会话时 404 = 正常（轮询语义）', statusLabels: { 404: '存活（无待授权会话）' },
      }),
    ],
  },
  {
    id: 'qodercn',
    name: 'Qoder（中国版）',
    loginMode: '浏览器授权（device/selectAccounts）',
    notes: ['与 Qoder 同形，host 换成 qoder.cn / openapi.qoder.com.cn（qoder-product.ts QODER_CN）。'],
    endpoints: [
      ep('登录入口', 'login', 'https://qoder.cn/device/selectAccounts', { source: 'qoder.ts QODER_DEVICE_SELECT_PATH + authBase' }),
      ep('模型目录', 'models', null, { note: '本地 catalog-v6 解密，无 HTTP 端点' }),
      ep('余额/用量', 'balance', 'https://openapi.qoder.com.cn/sash/api/v2/me/usage', {
        auth: 'Bearer + Cosy-ClientType', source: 'qoder-credits.ts QODER_USAGE_PATH',
      }),
      ep('签到活动', 'checkin', 'https://openapi.qoder.com.cn/sash/api/v1/me/campaigns', {
        auth: 'Bearer + Cosy-ClientType', source: 'qoder-credits.ts QODER_CAMPAIGNS_PATH',
      }),
    ],
  },

  // ───────────────────────────── TRAE ──────────────────────────────
  {
    id: 'trae',
    name: 'TRAE',
    loginMode: '浏览器授权（trae.cn/authorization）',
    notes: ['真实登录 URL 带 auth_callback_url / machine_id 等一长串参数（trae-oauth.ts buildTraeLoginURL）。'],
    endpoints: [
      ep('登录入口', 'login', 'https://www.trae.cn/authorization', { source: 'trae-product.ts TRAE_CONSOLE_HOST' }),
      ep('模型目录', 'models', 'https://trae-api-cn.mchost.guru/api/ide/v1/get_detail_param', {
        method: 'POST', body: '{}', auth: 'Cloud-IDE-JWT', source: 'trae.ts TRAE_MODELS_PATH',
      }),
      ep('积分余额', 'balance', 'https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage', {
        method: 'POST', body: '{}', auth: 'Cloud-IDE-JWT', source: 'trae.ts TRAE_ENT_USAGE_PATH',
      }),
      ep('签到状态', 'checkin', 'https://api.trae.cn/trae/api/v2/ug/checkin_credits/status', {
        method: 'POST', body: '{}', auth: 'Cloud-IDE-JWT', source: 'trae.ts TRAE_CHECKIN_STATUS_PATH',
      }),
    ],
  },

  // ───────────────────────────── Cline ─────────────────────────────
  {
    id: 'cline',
    name: 'Cline',
    loginMode: '浏览器授权（WorkOS 设备码）',
    notes: [
      '⚠️ GET 偶发抖动（连接被重置/超时）。脚本对该渠道 GET 端点自动重试一次。',
      '余额端点形如 /api/v1/users/{userId}/balance，需要 userId；这里探 /api/v1/users/me 验鉴权可达。',
      'WorkOS 设备码端点必须 POST（GET 404）。',
    ],
    endpoints: [
      ep('登录入口', 'login', 'https://app.cline.bot/', { retry: 1, source: 'cline.ts 注释 app.cline.bot' }),
      ep('设备码', 'login', 'https://api.workos.com/user_management/authorize/device', {
        method: 'POST', body: '{}', auth: '无（换取设备码）', retry: 1, source: 'cline-oauth.ts CLINE_DEVICE_AUTHORIZATION_PATH',
      }),
      ep('模型目录（推荐）', 'models', 'https://api.cline.bot/api/v1/ai/cline/recommended-models', {
        retry: 1, source: 'cline-models.ts CLINE_RECOMMENDED_MODELS_PATH',
        bodyDetail: (text) => countJsonFields(text, ['recommended', 'free', 'clinePass']),
      }),
      ep('模型目录（全量）', 'models', 'https://api.cline.bot/api/v1/models', {
        retry: 1, source: 'cline-models.ts CLINE_MODELS_PATH',
        bodyDetail: (text) => countJsonArray(text, 'data', '个模型'),
      }),
      ep('身份/余额', 'identity', 'https://api.cline.bot/api/v1/users/me', {
        auth: 'Bearer workos', retry: 1, source: 'cline.ts 注释 /api/v1/users/me',
      }),
    ],
  },

  // ───────────────────────────── Gemini ────────────────────────────
  {
    id: 'gemini',
    name: 'Gemini',
    loginMode: '浏览器授权（Google OAuth · PKCE）',
    notes: [
      '模型目录是**静态兜底表**（gemini.ts GEMINI_FALLBACK_MODELS），没有 HTTP 目录端点。',
      '⚠️ 额度/项目端点必须 POST：GET 返回 404（2026-10-23 实测）。',
      '授权 URL 的 client_id / scope 见 gemini-oauth.ts buildGeminiAuthUrl；这里用默认客户端拼一个只验存活的 URL。',
    ],
    endpoints: [
      ep('登录入口', 'login', 'https://accounts.google.com/o/oauth2/v2/auth?client_id=1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A8845%2Foauth-callback&scope=openid%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform&state=probe&access_type=offline&prompt=consent', {
        source: 'gemini-oauth.ts GEMINI_AUTH_ENDPOINT + GEMINI_DEFAULT_CLIENT_ID',
      }),
      ep('模型目录', 'models', null, { note: '静态 fallback 表，无 HTTP 目录端点' }),
      ep('额度', 'balance', 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary', {
        method: 'POST', body: '{}', auth: 'Bearer', source: 'gemini.ts GEMINI_QUOTA_PATH（sandbox）',
      }),
      ep('项目探测', 'identity', 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:loadCodeAssist', {
        method: 'POST', body: '{"metadata":{"ideType":"ANTIGRAVITY"}}', auth: 'Bearer', source: 'gemini.ts GEMINI_LOAD_CODE_ASSIST_PATH',
      }),
    ],
  },

  // ───────────────────────────── 讯飞 Loomy ────────────────────────
  {
    id: 'loomy',
    name: 'Loomy',
    loginMode: '短信验证码 / 微信扫码',
    notes: [
      '没有静态登录页：短信登录走 {accountBase}/login/phone/*（HMAC-SHA1 签名，loomy-oauth.ts）。',
      'account.xfinfr.com 无签名返回 401 = 端点存在，不是死链。',
    ],
    endpoints: [
      ep('登录入口', 'login', 'https://account.xfinfr.com/', { source: 'loomy.ts LOOMY_ACCOUNT_BASE', note: '短信登录端点基址（需 HMAC-SHA1）' }),
      ep('模型目录', 'models', 'https://loomyad.xunfei.cn/api/v1/models', { source: 'loomy-product.ts 注释 GET /api/v1/models' }),
      ep('积分余额', 'balance', 'https://loomyad.xunfei.cn/api/v1/points/records?pageNo=1&pageSize=1&recordType=all', {
        auth: 'token', source: 'loomy-credits.ts 查余额路径',
      }),
      ep('签到（首登）', 'checkin', 'https://loomyad.xunfei.cn/api/v1/points/first-login', {
        method: 'POST', body: '{}', auth: 'token', source: 'loomy-credits.ts 一键签到（写端点，探活只验存在）',
        note: '写端点：带真实 token 探测会产生签到副作用', statusLabels: { 400: '存活（需真实 token）' },
      }),
    ],
  },

  // ───────────────────────────── 小浣熊 Raccoon ────────────────────
  {
    id: 'raccoon',
    name: 'Raccoon',
    loginMode: '扫码 / 短信（本地承载页）',
    notes: [
      '登录页由插件本地服务器承载（raccoon-login-page.ts），官方站只验可达。',
      '语言/重试头等由 adapter 统一注入；本脚本只探端点。',
    ],
    endpoints: [
      ep('登录入口', 'login', 'https://xiaohuanxiong.com/', { source: 'raccoon.ts RACCOON_API_BASE' }),
      ep('模型目录', 'models', 'https://xiaohuanxiong.com/api/web/llm/v2/model_catalog', { source: 'raccoon-product.ts 注释 GET /model_catalog' }),
      ep('积分余额', 'balance', 'https://xiaohuanxiong.com/api/web/points/v1/balance', { source: 'raccoon-credits.ts RACCOON_POINTS_PREFIX/balance' }),
      ep('积分流水', 'balance', 'https://xiaohuanxiong.com/api/web/points/v1/bills?paging.limit=50&paging.offset=0', {
        source: 'raccoon-credits.ts RACCOON_POINTS_PREFIX/bills',
      }),
    ],
  },

  // ───────────────────────────── MiniMax ───────────────────────────
  {
    id: 'minimax',
    name: 'MiniMax Code',
    loginMode: '浏览器授权（OAuth 设备码）',
    notes: [
      '⚠️ 模型目录必须带 region/buildEnv 查询参数（本脚本用 region=cn-prod&buildEnv=prod）。',
      '厂商源码 product.region=\'cn\'、buildEnv=\'prod\'（minimax-product.ts）；2026-10-23 实测 region=cn 与 region=cn-prod 均 200，二者等价。',
      '设备码端点必须 POST（GET 404）。',
    ],
    endpoints: [
      ep('登录入口', 'login', 'https://account.minimax.cn/', { source: 'minimax-product.ts accountHost' }),
      ep('设备码', 'login', 'https://account.minimax.cn/oauth2/device/code', {
        method: 'POST', body: '{}', auth: '无（换取设备码）', source: 'minimax-product.ts MINIMAX_DEVICE_CODE_PATH',
      }),
      ep('模型目录', 'models', 'https://agent.minimax.cn/mavis/api/v1/models?region=cn-prod&buildEnv=prod', {
        source: 'minimax-product.ts MINIMAX_MODELS_PATH + region/buildEnv',
        bodyDetail: (text) => countMinimaxModels(text),
      }),
      ep('额度明细', 'balance', 'https://agent.minimax.cn/minimax-cloud/api/v1/credit/details', {
        auth: 'Bearer', source: 'minimax-credits.ts MINIMAX_CREDIT_DETAILS_PATH',
      }),
      ep('签到状态', 'checkin', 'https://agent.minimax.cn/minimax-cloud/api/v1/signin/status?timezone_id=Asia%2FShanghai', {
        auth: 'Bearer', source: 'minimax-credits.ts MINIMAX_SIGNIN_STATUS_PATH',
      }),
    ],
  },

  // ───────────────────────────── ZCode ─────────────────────────────
  {
    id: 'zcode',
    name: 'ZCode',
    loginMode: '浏览器授权（bigmodel / z.ai）',
    notes: [
      '真正授权 URL 由 /api/v1/.../login 初始化接口返回（zcode-login.ts，含 authorize_url），这里探站点与已固化端点。',
    ],
    endpoints: [
      ep('登录入口', 'login', 'https://zcode.z.ai/', { source: 'zcode.ts ZCODE_ORIGIN' }),
      ep('模型目录', 'models', 'https://api.z.ai/api/anthropic/v1/models', { source: 'zcode-upstream.ts 注释 GET /api/anthropic/v1/models' }),
      ep('客户端配置', 'models', 'https://zcode.z.ai/api/v1/client/configs?app_version=3.14.3&platform=unknown', {
        source: 'zcode-upstream.ts ZCODE_CLIENT_CONFIGS_URL',
      }),
      ep('积分余额', 'balance', 'https://zcode.z.ai/api/v1/zcode-plan/billing/balance', {
        auth: 'Bearer', source: 'zcode-upstream.ts ZCODE_BILLING_BALANCE_URL',
      }),
    ],
  },

  // ───────────────────────────── Command Code ──────────────────────
  {
    id: 'commandcode',
    name: 'Command Code',
    loginMode: '浏览器授权（Studio 自动回调）',
    notes: [
      '⚠️ 授权页是 **/studio/auth/cli**：旧 /cli/authorize 实测 404（官方 changelog 0.32.5「dead studio links」）。',
      'URL 固定带 callback=http://127.0.0.1:<port>/callback、state、mode=redirect（官方 CLI command-code@1.87.3）。',
    ],
    endpoints: [
      ep('登录入口', 'login', 'https://commandcode.ai/studio/auth/cli?callback=http%3A%2F%2F127.0.0.1%3A5959%2Fcallback&state=probe&mode=redirect', {
        source: 'commandcode-product.ts COMMANDCODE_STUDIO_AUTH_PATH',
      }),
      ep('模型目录', 'models', 'https://api.commandcode.ai/provider/v1/models', {
        source: 'commandcode-product.ts COMMANDCODE_MODELS_PATH',
        bodyDetail: (text) => countJsonArray(text, 'data', '个模型'),
      }),
      ep('积分余额', 'balance', 'https://api.commandcode.ai/alpha/billing/credits', {
        auth: 'Bearer', source: 'commandcode-product.ts COMMANDCODE_CREDITS_PATH',
      }),
      ep('身份', 'identity', 'https://api.commandcode.ai/alpha/whoami', {
        auth: 'Bearer', source: 'commandcode-product.ts COMMANDCODE_WHOAMI_PATH',
      }),
    ],
  },

  // ───────────────────────────── OfficeAce ─────────────────────────
  {
    id: 'officeace',
    name: 'OfficeAce 果办',
    loginMode: '浏览器授权（华为 IAM + 轮询授权码）',
    notes: [
      '⚠️ auth/state 必须 POST（GET 404）；auth/code 需要先 POST state 拿到 state 再轮询。',
      '权限校验是 GET + SDK-HMAC 签名；订阅开通是 POST（officeace.ts validatePermission / subscribe）。',
      '模型目录与推理网关由 subscription.model_info 下发，没有固定的公共目录 URL。',
    ],
    endpoints: [
      ep('登录入口', 'login', 'https://auth.huaweicloud.com/authui/login.html', { source: 'officeace-product.ts loginBase + OFFICEACE_AUTHORIZE_PATH' }),
      ep('授权 state', 'login', 'https://agentarts.cn-southwest-2.myhuaweicloud.com/v1/claw/auth/state', {
        method: 'POST', body: '{}', auth: '无（换取 state）', source: 'officeace-product.ts OFFICEACE_STATE_PATH',
      }),
      ep('轮询授权码', 'login', 'https://agentarts.cn-southwest-2.myhuaweicloud.com/v1/claw/auth/code?state=probe', {
        source: 'officeace-product.ts OFFICEACE_CODE_PATH',
        note: 'state 未初始化时 404 属正常', statusLabels: { 404: '存活（state 未初始化）' },
      }),
      ep('身份/模型信息', 'identity', 'https://agentarts.cn-southwest-2.myhuaweicloud.com/v1/claw/client-permission-validate', {
        auth: 'SDK-HMAC', source: 'officeace-product.ts OFFICEACE_PERMISSION_PATH',
      }),
      ep('订阅/模型信息', 'models', 'https://agentarts.cn-southwest-2.myhuaweicloud.com/v1/claw/client-subscription', {
        method: 'POST', body: '{}', auth: 'Bearer', source: 'officeace-product.ts OFFICEACE_SUBSCRIPTION_PATH',
      }),
    ],
  },

  // ───────────────────────────── Accio 系 ─────────────────────────
  {
    id: 'accio',
    name: 'Accio',
    loginMode: '浏览器授权（OAuth + PKCE）',
    notes: [
      '登录 URL 带 response_type/client_id/redirect_uri/state/PKCE（accio.ts buildAccioAuthUrl）。',
      '模型目录是 POST /api/llm/config；无 token 时 HTTP 200 但 body 报 auth failed。',
    ],
    endpoints: [
      ep('登录入口', 'login', 'https://www.accio.com/oauth/authorize', { source: 'accio.ts buildAccioAuthUrl（loginBase/oauth/authorize）' }),
      ep('模型目录', 'models', 'https://phoenix-gw.alibaba.com/api/llm/config', {
        method: 'POST', body: '{}', source: 'accio-product.ts ACCIO_LLM_CONFIG_PATH',
        bodyDetail: (text) => (/"code"\s*:\s*"?403"?|auth failed/i.test(text) ? '（无 token：body 报 auth failed，端点存活）' : ''),
      }),
      ep('额度', 'balance', 'https://phoenix-gw.alibaba.com/api/entitlement/quota', {
        auth: 'accessToken query', source: 'accio-product.ts ACCIO_QUOTA_PATH',
      }),
      ep('用户资料', 'identity', 'https://phoenix-gw.alibaba.com/api/auth/userinfo', {
        auth: 'accessToken query', source: 'accio-product.ts ACCIO_USERINFO_PATH',
      }),
    ],
  },
  {
    id: 'accio-cn',
    name: 'Accio 国内版',
    loginMode: '浏览器授权（OAuth + PKCE）',
    notes: ['与 Accio 同形，loginBase 换成 www.accio-ai.com（accio-product.ts ACCIO_CN）。'],
    endpoints: [
      ep('登录入口', 'login', 'https://www.accio-ai.com/oauth/authorize', { source: 'accio.ts buildAccioAuthUrl（loginBase/oauth/authorize）' }),
      ep('模型目录', 'models', 'https://phoenix-gw.alibaba.com/api/llm/config', {
        method: 'POST', body: '{}', source: 'accio-product.ts ACCIO_LLM_CONFIG_PATH',
        bodyDetail: (text) => (/"code"\s*:\s*"?403"?|auth failed/i.test(text) ? '（无 token：body 报 auth failed，端点存活）' : ''),
      }),
      ep('额度', 'balance', 'https://phoenix-gw.alibaba.com/api/entitlement/quota', {
        auth: 'accessToken query', source: 'accio-product.ts ACCIO_QUOTA_PATH',
      }),
    ],
  },

  // ───────────────────────────── 粘贴型渠道 ────────────────────────
  {
    id: 'orcaterm',
    name: 'OrcaTerm',
    loginMode: '粘贴 Cookie（ot_session）',
    notes: [
      '上游三条登录链路都无法在插件内自动完成（orcaterm-product.ts 注释），只能粘贴 Cookie。',
      '模型集合由控制台会话下发；插件里只有兜底表，**没有**独立 HTTP 目录端点，也没有额度查询端点。',
    ],
    endpoints: [
      ep('登录入口', 'login', 'https://orcaterm.cloud.tencent.com/terminal', { source: 'orcaterm-product.ts consoleBase' }),
      ep('模型目录', 'models', null, { note: '控制台会话下发 + fallback 表（deepseek-v3.2 / hunyuan-t1）' }),
      ep('余额', 'balance', null, { note: '插件无额度查询端点' }),
    ],
  },
  {
    id: 'kuku',
    name: 'KukuAI',
    loginMode: '粘贴 Cookie（BDUSS）',
    notes: ['模型目录用兜底表（kuku-product.ts KUKU_FALLBACK_MODELS），没有 HTTP 目录端点。'],
    endpoints: [
      ep('登录入口', 'login', 'https://kuku.baidu.com/', { source: 'kuku-product.ts apiBase' }),
      ep('模型目录', 'models', null, { note: '静态兜底目录，无 HTTP 目录端点' }),
      ep('会员余额', 'balance', 'https://kuku.baidu.com/bizapi/gfpro/getgfvipremain', {
        auth: 'Cookie BDUSS', source: 'kuku-product.ts KUKU_VIP_REMAIN_PATH',
      }),
      ep('免费积分', 'checkin', 'https://kuku.baidu.com/api/genflowpro/freepoint/homenew', {
        auth: 'Cookie BDUSS', source: 'kuku-product.ts KUKU_FREEPOINT_PATH',
      }),
    ],
  },
  {
    id: 'monkeycode',
    name: 'MonkeyCode',
    loginMode: '粘贴 Cookie（nebula_session）',
    notes: ['WebSocket 对话走 /api/v1/users/tasks/stream（WS，非 HTTP 探活范围）。'],
    endpoints: [
      ep('登录入口', 'login', 'https://monkeycode-ai.com/', { source: 'monkeycode-product.ts apiBase' }),
      ep('模型目录', 'models', 'https://monkeycode-ai.com/api/v1/users/models/available', {
        auth: 'Cookie nebula_session', source: 'monkeycode-product.ts MONKEYCODE_MODELS_PATH',
      }),
      ep('钱包/额度', 'balance', 'https://monkeycode-ai.com/api/v1/users/wallet', {
        auth: 'Cookie nebula_session', source: 'monkeycode-product.ts MONKEYCODE_WALLET_PATH',
      }),
      ep('签到', 'checkin', 'https://monkeycode-ai.com/api/v1/users/wallet/checkin', {
        auth: 'Cookie nebula_session', source: 'monkeycode-product.ts MONKEYCODE_CHECKIN_PATH',
      }),
    ],
  },
  {
    id: 'autoclaw',
    name: 'AutoClaw',
    loginMode: '粘贴令牌（OAuth 回调端口白名单）',
    notes: [
      '⚠️ model-config 在**无真实令牌/假令牌**时返回 404 —— 不能据此判死链，必须真实令牌终验。',
      'OAuth 回调端口白名单：[18432, 19654, 19723, 53699]（autoclaw-product.ts）；插件当前只支持粘贴令牌。',
      '认证头是 X-Authorization（不是 Authorization）。',
    ],
    endpoints: [
      ep('登录入口', 'login', null, { note: 'OAuth（Zai/Google），无静态登录页；当前走粘贴令牌' }),
      ep('模型目录', 'models', 'https://autoglm-acceleration-api.zhipuai.cn/proxy/autoclaw-model-config', {
        requiresRealToken: true, source: 'autoclaw-product.ts AUTOCLAW_MODEL_CONFIG_PATH',
        note: '需真实令牌终验（假令牌 404）',
      }),
      ep('余额', 'balance', null, { note: '插件无额度查询端点' }),
    ],
  },
]

// ───────────────────────────── 参数解析 ─────────────────────────────

function fail(message) {
  console.error(`channel-probe: ${message}`)
  process.exit(2)
}

function parseArgs(argv) {
  const options = {
    channels: [], kinds: [], endpoints: [],
    timeout: 10_000, retries: 0, json: false, list: false,
    failOnDead: false, token: process.env.OFM_PROBE_TOKEN ?? '', cookie: '', headers: {},
  }
  const take = (index, flag) => {
    const value = argv[index]
    if (value === undefined) fail(`参数 ${flag} 缺少值`)
    return value
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--channel': case '-c':
        options.channels.push(...take(++i, arg).split(',').map(s => s.trim()).filter(Boolean))
        break
      case '--kind': case '-k':
        for (const kind of take(++i, arg).split(',').map(s => s.trim()).filter(Boolean)) {
          if (!(kind in KIND_LABELS)) fail(`未知端点类型 ${kind}（可选：${Object.keys(KIND_LABELS).join(', ')}）`)
          options.kinds.push(kind)
        }
        break
      case '--endpoint': case '-e':
        options.endpoints.push(...take(++i, arg).split(',').map(s => s.trim().toLowerCase()).filter(Boolean))
        break
      case '--timeout': {
        const value = Number(take(++i, arg))
        if (!Number.isFinite(value) || value < 500) fail('--timeout 必须是 >=500 的毫秒数')
        options.timeout = value
        break
      }
      case '--retries': {
        const value = Number(take(++i, arg))
        if (!Number.isInteger(value) || value < 0 || value > 5) fail('--retries 必须是 0–5 的整数')
        options.retries = value
        break
      }
      case '--token': options.token = take(++i, arg); break
      case '--cookie': options.cookie = take(++i, arg); break
      case '--header': {
        const pair = take(++i, arg)
        const colon = pair.indexOf(':')
        if (colon <= 0) fail('--header 格式为 name:value')
        options.headers[pair.slice(0, colon).trim()] = pair.slice(colon + 1).trim()
        break
      }
      case '--json': options.json = true; break
      case '--list': options.list = true; break
      case '--fail-on-dead': options.failOnDead = true; break
      case '--help': case '-h': printUsage(); process.exit(0); break
      default: fail(`未知参数 ${arg}（--help 查看用法）`)
    }
  }
  return options
}

function printUsage() {
  console.log(`渠道端点手动探活（不进入默认测试套件）

用法：node scripts/channel-probe.mjs [选项]

  -c, --channel <id[,id]>    只探指定渠道（${CHANNELS.map(c => c.id).join(', ')}）
  -k, --kind <kind[,kind]>   只探指定端点类型（${Object.keys(KIND_LABELS).join(', ')}）
  -e, --endpoint <name>      只探端点名包含该子串的项（不区分大小写，可逗号分隔）
      --timeout <ms>         单请求超时（默认 10000）
      --retries <n>          传输失败重试次数（默认 0；Cline 端点固定至少重试一次）
      --token <value>        给需要的端点带 Authorization: Bearer <value>
      --cookie <value>       给所有端点带 Cookie（粘贴型渠道用）
      --header <name:value>  附加请求头（可重复）
      --json                 输出机器可读 JSON
      --list                 只列出渠道/端点清单，不发请求
      --fail-on-dead         出现「疑似死链/不可达」时退出码 1
  -h, --help                 显示本帮助

判定口径：2xx=存活；401/403=存活（需鉴权）；400/405/415/422=存活（需参数/方法）；
3xx=存活（跳转）；404/410=疑似死链；5xx=上游错误；网络失败=不可达。
AutoClaw 的 model-config 例外：无真实令牌时 404 属预期，标「需真实令牌终验」。`)
}

// ───────────────────────────── 探活执行 ─────────────────────────────

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/** 状态码 → 判定。 */
function classifyStatus(endpoint, response) {
  const status = response.status
  if (endpoint.statusLabels?.[status] !== undefined) {
    return { level: 'ok', label: endpoint.statusLabels[status] }
  }
  if (endpoint.requiresRealToken === true) {
    return { level: 'warn', label: `需真实令牌终验（HTTP ${status}）` }
  }
  if (status >= 200 && status < 300) return { level: 'ok', label: '存活' }
  if (status === 401 || status === 403) return { level: 'ok', label: '存活（需鉴权）' }
  if (status === 400 || status === 405 || status === 415 || status === 422) return { level: 'ok', label: '存活（需参数/方法）' }
  if (status === 404 || status === 410) return { level: 'bad', label: '疑似死链' }
  if (status === 429) return { level: 'ok', label: '存活（限流）' }
  if (status >= 300 && status < 400) return { level: 'ok', label: '存活（跳转）' }
  if (status >= 500) return { level: 'warn', label: '上游错误' }
  return { level: 'warn', label: `HTTP ${status}` }
}

function describeError(error) {
  if (error === undefined || error === null) return ''
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return '超时'
  const cause = error.cause
  const code = cause?.code ?? error.code
  const message = error.message ?? String(error)
  return code === undefined ? message : `${code}：${message}`
}

/** 从 JSON 文本里数数组长度（字段不存在则返回空）。 */
function countJsonArray(text, field, unit) {
  try {
    const body = JSON.parse(text)
    const value = body?.[field]
    return Array.isArray(value) ? `${value.length} ${unit}` : ''
  } catch {
    return ''
  }
}

/** 数多个数组字段的总条数（Cline recommended-models）。 */
function countJsonFields(text, fields) {
  try {
    const body = JSON.parse(text)
    const total = fields.reduce((sum, field) => sum + (Array.isArray(body?.[field]) ? body[field].length : 0), 0)
    return total > 0 ? `${total} 条模型` : ''
  } catch {
    return ''
  }
}

/** Minimax 目录：providers[0].config.models 的键数。 */
function countMinimaxModels(text) {
  try {
    const body = JSON.parse(text)
    const models = body?.providers?.[0]?.config?.models
    return models !== undefined && typeof models === 'object' ? `${Object.keys(models).length} 个模型` : ''
  } catch {
    return ''
  }
}

async function probeEndpoint(channel, endpoint, options) {
  const record = {
    channel: channel.id,
    channelName: channel.name,
    endpoint: endpoint.name,
    kind: endpoint.kind,
    method: endpoint.url === null ? '-' : endpoint.method,
    url: endpoint.url,
    status: null,
    level: 'skip',
    label: '无 HTTP 端点',
    note: endpoint.note ?? '',
    source: endpoint.source ?? '',
    retried: 0,
  }
  if (endpoint.url === null) return record

  const headers = {
    accept: '*/*',
    'user-agent': 'ofm-channel-probe/1.0 (+manual liveness check)',
    ...endpoint.headers,
  }
  if (options.token !== '' && endpoint.auth !== 'none') headers.authorization = `Bearer ${options.token}`
  if (options.cookie !== '') headers.cookie = options.cookie
  Object.assign(headers, options.headers)

  const init = { method: endpoint.method, headers, redirect: 'manual' }
  if (endpoint.method === 'POST') {
    headers['content-type'] ??= 'application/json'
    init.body = endpoint.body ?? '{}'
  }

  const attempts = Math.max(0, options.retries, endpoint.retry ?? 0) + 1
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(endpoint.url, { ...init, signal: AbortSignal.timeout(options.timeout) })
      const verdict = classifyStatus(endpoint, response)
      let detail = ''
      if (verdict.label === '存活（跳转）') {
        const location = response.headers.get('location')
        if (location !== null && location !== '') detail = `→ ${location.length > 90 ? `${location.slice(0, 90)}…` : location}`
      }
      if (endpoint.bodyDetail !== undefined) {
        try {
          const text = (await response.text()).slice(0, 200_000)
          detail = endpoint.bodyDetail(text) || detail
        } catch { /* 正文不可读不影响存活判定 */ }
      } else {
        try { await response.body?.cancel?.() } catch { /* 忽略 */ }
      }
      return {
        ...record,
        status: response.status,
        ...verdict,
        note: [record.note, detail].filter(Boolean).join('；'),
        retried: attempt - 1,
      }
    } catch (error) {
      lastError = error
      if (attempt < attempts) await sleep(300 * attempt)
    }
  }
  return { ...record, level: 'bad', label: '不可达', note: [record.note, describeError(lastError)].filter(Boolean).join('；'), retried: attempts - 1 }
}

/** 按参数筛出要探的渠道与端点。 */
function selectChannels(options) {
  const unknown = options.channels.filter(id => !CHANNELS.some(channel => channel.id === id))
  if (unknown.length > 0) fail(`未知渠道：${unknown.join(', ')}（--list 查看清单）`)
  return CHANNELS
    .filter(channel => options.channels.length === 0 || options.channels.includes(channel.id))
    .map(channel => ({
      ...channel,
      endpoints: channel.endpoints.filter(endpoint => {
        if (options.kinds.length > 0 && !options.kinds.includes(endpoint.kind)) return false
        if (options.endpoints.length > 0) {
          // 匹配端点名或 URL：中文名之外，允许用 `usage` / `campaigns` / `models`
          // 这类 URL 片段筛选（URL 为 null 的端点只能按中文名匹配）。
          const haystack = `${endpoint.name} ${endpoint.url ?? ''}`.toLowerCase()
          return options.endpoints.some(needle => haystack.includes(needle))
        }
        return true
      }),
    }))
    .filter(channel => channel.endpoints.length > 0)
}

// ───────────────────────────── 输出 ─────────────────────────────

const LEVEL_LABELS = { ok: '✓', warn: '!', bad: '✗', skip: '-' }

/** 近似显示宽度：CJK / 全角按 2 列。 */
function displayWidth(text) {
  let width = 0
  for (const char of text) {
    const cp = char.codePointAt(0)
    if (cp === undefined) continue
    const wide = cp >= 0x1100 && (
      cp <= 0x115f || cp === 0x2329 || cp === 0x232a
      || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
      || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f)
      || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
      || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff)
    )
    width += wide ? 2 : 1
  }
  return width
}

const pad = (text, width) => text + ' '.repeat(Math.max(0, width - displayWidth(text)))

function printHuman(results, options) {
  let currentChannel = ''
  for (const row of results) {
    if (row.channel !== currentChannel) {
      const channel = CHANNELS.find(item => item.id === row.channel)
      currentChannel = row.channel
      console.log('')
      console.log(`◆ ${channel.id}  ${channel.name}  [${channel.loginMode}]`)
      for (const note of channel.notes ?? []) console.log(`  · ${note}`)
      console.log(`  ${pad('状态', 6)}${pad('类型', 6)}${pad('端点', 18)}${pad('方法', 6)}${pad('结果', 22)}备注`)
    }
    const status = row.status === null ? '-' : String(row.status)
    const note = [row.note, row.retried > 0 ? `已重试 ${row.retried} 次` : ''].filter(Boolean).join('；')
    console.log(`  ${pad(`${LEVEL_LABELS[row.level] ?? '?'} ${status}`, 6)}${pad(KIND_LABELS[row.kind] ?? row.kind, 6)}${pad(row.endpoint, 18)}${pad(row.method, 6)}${pad(row.label, 22)}${note}`)
  }

  const summary = summarize(results)
  console.log('')
  console.log('──── 探活汇总 ────')
  console.log(`渠道 ${summary.channels} 个 / 端点 ${summary.total} 个：存活 ${summary.ok}，警告 ${summary.warn}，死链 ${summary.bad}，跳过 ${summary.skip}`)
  if (summary.attention.length > 0) {
    console.log('')
    console.log('需要关注：')
    for (const row of summary.attention) {
      console.log(`  ${LEVEL_LABELS[row.level]} ${row.channel} ${row.endpoint}（${row.method} ${row.status ?? '-'}）：${row.label}${row.note === '' ? '' : ` — ${row.note}`}`)
    }
  }
  if (options.token === '' && options.cookie === '') {
    console.log('')
    console.log('提示：未带凭据，「存活（需鉴权）」只说明端点存在，不代表账号可用。')
  }
}

function summarize(results) {
  const summary = { total: results.length, ok: 0, warn: 0, bad: 0, skip: 0, channels: new Set(results.map(row => row.channel)).size, attention: [] }
  for (const row of results) {
    if (row.level === 'bad') { summary.bad++; summary.attention.push(row) }
    else if (row.level === 'warn') { summary.warn++; summary.attention.push(row) }
    else if (row.level === 'skip') summary.skip++
    else summary.ok++
  }
  return summary
}

// ───────────────────────────── 主流程 ─────────────────────────────

const options = parseArgs(process.argv.slice(2))
const channels = selectChannels(options)

if (options.list) {
  for (const channel of channels) {
    console.log(`${channel.id}\t${channel.name}\t[${channel.loginMode}]`)
    for (const endpoint of channel.endpoints) {
      console.log(`  ${KIND_LABELS[endpoint.kind] ?? endpoint.kind}\t${endpoint.name}\t${endpoint.method} ${endpoint.url ?? '(无 HTTP 端点)'}`)
    }
  }
  process.exit(0)
}

if (channels.length === 0) {
  console.log('没有匹配的渠道/端点（--list 查看清单）')
  process.exit(0)
}

if (!options.json) {
  console.log(`渠道探活 · ${channels.length} 个渠道 / ${channels.reduce((sum, channel) => sum + channel.endpoints.length, 0)} 个端点 · 超时 ${options.timeout}ms${options.retries > 0 ? ` · 重试 ${options.retries}` : ''}`)
  console.log(`时间 ${new Date().toISOString()}`)
}

const results = []
for (const channel of channels) {
  for (const endpoint of channel.endpoints) {
    results.push(await probeEndpoint(channel, endpoint, options))
  }
}

const summary = summarize(results)
if (options.json) {
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    options: { timeout: options.timeout, retries: options.retries, hasToken: options.token !== '', hasCookie: options.cookie !== '' },
    summary: { ...summary, channels: summary.channels },
    results,
  }, null, 2))
} else {
  printHuman(results, options)
}

if (options.failOnDead && summary.bad > 0) process.exit(1)
