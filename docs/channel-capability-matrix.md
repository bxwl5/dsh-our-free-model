# 渠道能力矩阵

> 覆盖范围与计数口径见 §1，矩阵主表见 §2，逐渠道细节与取证件见 §3，
> 复现方式见 §4。
>
> **维护约定**：新增/移除渠道时，四处同源更新 —— `README.md`、`README_EN.md`
> 的渠道表、本文档、以及 `scripts/channel-probe.mjs` 的渠道端点表。

---

## 1. 覆盖范围与计数口径

### 1.1 本矩阵覆盖什么

| 类别 | 数量 | 渠道 |
| --- | --- | --- |
| 免密车道（无需账号） | 2 | 匿名免费车道（OpenCode Zen）、Kilo 免费池 |
| 账号渠道（provider） | 22 | 见 §2 主表；免密车道逐条说明见 §3.19 |

「账号渠道 22」这一数字在本仓库有四处独立佐证，逐字一致：

- `README.md` 渠道章节「**账号渠道（22 个）**」；`README_EN.md` "**Account channels (22)**"；
- `client.js` 的 `CHANNEL_PROVIDERS` 表：22 条卡片（每条的 `login` 字段决定交互形态）；
- `scripts/channel-pack-test.mjs`：`assert.equal(adapters.size, 22)` 与 `assert.equal(cards.length, 22)`；
- `vendor/channel-pack/src/index.ts` 的注册段：22 个账号 provider（OFM 挂载时关闭上游 OpenCode 账号接入，故不计入）。

**粘贴型渠道共 5 个**（上游没有可脚本化的授权流程，只能用 `account.adopt` 粘贴 Cookie / 令牌）：
`monkeycode`、`orcaterm`、`kuku`、`autoclaw`、`autoclaw-intl`。
来源：`vendor/channel-pack/src/channel-pack-rpc.ts` 的 `ADOPTABLE_CHANNELS`（5 条）
与 `scripts/channel-adopt-test.mjs` 的 `pasteOnly` 清单。其余 17 个在插件内即可完成授权
（浏览器授权 / 设备码 / 本地页扫码或短信）。

### 1.2 计数口径核对（结论：22 与 13，已无 12）

仓库里流通两种**互不相同**的计数，收敛后的口径如下：

| 计数 | 它到底在数什么 | 权威来源 | 移除粘贴型渠道后 |
| --- | --- | --- | --- |
| **22** | 账号渠道（provider）条数 | README 双语渠道表、`client.js` 卡片表、`scripts/channel-pack-test.mjs` 的 `adapters.size === 22` 与 `cards.length === 22`、`vendor/channel-pack/src/index.ts` 注册段 | 23 → 22 |
| **13** | 「带额度 / 签到能力的渠道」契约集合 | `client.js` 的 `CHANNEL_CREDITS`（13 条）、`scripts/channel-credits-rpc-test.mjs` 的 13 providers 列表、`scripts/channel-credits-ui-test.mjs` 的 9 个可领取 + workbuddy / cline / raccoon / gemini、`package.json` 描述、`vendor/channel-pack/NOTICE.md` | **不变（仍 13）** |

核对结论（逐条有证据）：

1. 被移除的那个渠道**从未**登记在 `CHANNEL_CREDITS` 里，也不在
   `scripts/channel-credits-rpc-test.mjs` 的 13 providers 列表中 —— 它的能力只到
   「凭据 + 模型目录」，故「13」不因它减少；账号渠道集则是 23 → 22。
2. 曾经的混乱来自**日志文案**而非断言：`scripts/channel-pack-test.mjs` 的几行日志
   一度写成「十二渠道 / 12 providers / 12 account cards」，而同一文件断言的是
   `adapters.size === 22`、`cards.length === 22` —— 12 在任何地方都找不到对应的
   12 元清单。现已全部改为与断言同值：
   - 图片计价日志（遍历全部已挂载适配器）→ `22 个账号渠道`；
   - 挂载日志 → `22 providers`；
   - 账号卡片日志 → `22 account cards`；
   - 额度日志 → `共享渠道余额（13 条额度契约）`（此行跟随额度契约集，**应为 13**）。
3. 结论：本文以 **README 为准**（账号渠道 22 + 免密车道 2 + 粘贴型 5）。
   任何新增的计数文案都必须与同一文件里的断言同值，并同步本节；维护要求见 §5 第 3 条。

> 本文不收录已从仓库整链移除的渠道：其源码、卡片、凭据解析与测试均已删除，
> 矩阵中不再出现。

---

## 2. 能力矩阵（22 个账号渠道）

图例：**✅** 插件已接入；**⚠️** 上游或模块内有该能力、但插件未接入（括号内写原因）；
**❌** 无此能力或上游没有该端点。

「图片」列的三种取值口径：
**双桥** = 接了 `readImage` + `readImageRequest`（可按预算缩放后重发，抗大截图）；
**单桥** = 只接 `readImage`（原图直发，超限行为未实测）；
**❌** = 未接字节桥，图片块在序列化时退化为 `[image unavailable]` 占位符或直接丢弃
（模型收不到图、也不会报错）。

| # | 渠道（provider · 展示名） | 登录方式 | 对话 | 模型目录 | 额度查询 | 签到 | 图片 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `codearts` · CodeArts | 浏览器授权（华为云 IAM，本地回调 + ticketId） | ✅ | ✅ 远端 | ✅ | ✅ | ❌（非文本块被丢弃） |
| 2 | `buddy` · WorkBuddy 国内版（CodeBuddy 端点） | 浏览器授权（两步：`POST /v2/plugin/auth/state` → authUrl） | ✅ | ✅ 远端 | ✅ | ✅ | ✅ 双桥 |
| 3 | `workbuddy` · WorkBuddy 国际版 | 浏览器授权（同上，`platform=workbuddy-ai`） | ✅ | ✅ 远端 | ✅ | ❌（后端无签到接口） | ✅ 双桥 |
| 4 | `lobsterai` · LobsterAI | 浏览器授权（slot → context 三步） | ✅ | ✅ 远端 | ✅ | ✅ | ✅ 双桥 |
| 5 | `qoder` · Qoder | 浏览器授权（OAuth；推理走加密端点，需 WASM 签名） | ✅ | ✅ 本机客户端解密目录（`catalog-v6`） | ✅ | ✅ | ✅ 双桥 |
| 6 | `qodercn` · Qoder 中国版 | 浏览器授权（同上，读 `~/.qoder-cn`） | ✅ | ✅ 本机客户端解密目录 | ✅ | ✅ | ✅ 双桥 |
| 7 | `trae` · TRAE | 浏览器授权（官方登录页，手机号） | ✅ | ✅ 远端 | ✅ | ✅ | ✅ 单桥 |
| 8 | `cline` · Cline | 浏览器授权（Cline OAuth） | ✅ | ✅ 内嵌目录 + models.dev 远端补充 | ✅（单位 dollars） | ❌（无签到端点） | ✅ 双桥 |
| 9 | `loomy` · Loomy | 本地页微信扫码；短信验证码为备用路径 | ✅ | ✅ 远端 | ✅ | ✅ | ✅ 单桥 |
| 10 | `raccoon` · Raccoon Work | 本地页微信扫码 + 短信双路径（不依赖官方客户端回调） | ✅ | ✅ 远端 | ✅ | ❌（每日积分由服务端自动发放；另有新手任务领取） | ✅ 双桥 |
| 11 | `minimax` · MiniMax Code | OAuth 设备码 + PKCE | ✅（Anthropic Messages 协议族） | ✅ 远端 | ✅ | ✅ | ✅ 单桥 |
| 12 | `zcode` · ZCode | 浏览器授权（官方 CLI 设备授权流 `/oauth/cli/init` → 轮询） | ✅（Anthropic Messages 协议族） | ✅ 静态白名单（远端接口保留） | ✅（单位 tokens） | ✅ | ✅ 双桥 |
| 13 | `gemini` · Gemini | 浏览器授权（Google OAuth，本地回调；只做 OAuth） | ✅ | ❌ 静态（Cloud Code 无目录端点） | ✅（配额窗口） | ❌（无每日签到） | ✅ 双桥 |
| 14 | `commandcode` · Command Code | 浏览器授权（自动回调；授权页 `/studio/auth/cli`） | ✅ | ✅ 远端 | ❌ ⚠️（上游 `/alpha/billing/credits` 未接入共享 credits RPC） | ❌ | ❌ |
| 15 | `officeace` · OfficeAce 果办 | 浏览器授权（自助 OAuth + 轮询授权码，回调不落本机） | ✅ | ✅ 远端 | ❌ | ❌ | ❌ |
| 16 | `accio` · Accio | 浏览器授权（国际站） | ✅ | ✅ 远端 | ❌ | ❌ | ❌ |
| 17 | `accio-cn` · Accio 国内版 | 浏览器授权（国内站） | ✅ | ✅ 远端 | ❌ | ❌ | ❌ |
| 18 | `orcaterm` · OrcaTerm | 粘贴 Cookie（`ot_session`） | ✅ | ❌ 静态（上游无公开目录端点） | ❌ | ❌ | ❌ |
| 19 | `kuku` · KukuAI | 粘贴 Cookie（`BDUSS`） | ✅ | ❌ 静态（上游无公开目录端点） | ❌ | ❌ | ❌ |
| 20 | `monkeycode` · MonkeyCode | 粘贴 Cookie（`nebula_session`） | ✅（建任务 + WebSocket 两步） | ✅ 远端 | ⚠️ 模块内已实现 `/api/v1/users/wallet`，未接入共享 credits RPC | ⚠️ 模块内已实现 `/api/v1/users/wallet/checkin`，未接入 | ❌ |
| 21 | `autoclaw` · AutoClaw | 粘贴令牌（上游 OAuth 被阿里云验证码 SDK 阻断） | ✅ | ✅ 远端（`autoclaw-model-config`） | ❌ | ❌ | ❌ |
| 22 | `autoclaw-intl` · AutoClaw 国际版 | 粘贴令牌（国际站） | ✅ | ✅ 远端 | ❌ | ❌ | ❌ |

**按维度汇总**：

| 维度 | 已接入 | 未接入 / 不支持 |
| --- | --- | --- |
| 对话 | 22（全部） | — |
| 模型目录 | 非静态目录 19 条（其中 `qoder`/`qodercn` 来自官方客户端本机解密文件 `catalog-v6`） | 仅静态兜底表 3 条：`gemini`、`orcaterm`、`kuku` |
| 额度查询 | 13 条（`codearts` `buddy` `workbuddy` `lobsterai` `qoder` `qodercn` `trae` `cline` `loomy` `raccoon` `minimax` `zcode` `gemini`） | 9 条：其余新渠道（含 `monkeycode`/`commandcode` 的「模块内有实现但未接线」） |
| 签到 | 9 条（`codearts` `buddy` `lobsterai` `qoder` `qodercn` `trae` `loomy` `minimax` `zcode`） | 服务端显式守卫「无签到端点」3 条（`workbuddy` `cline` `raccoon`）+ `gemini`（无 claim 能力，只有配额窗口）+ 未接入 9 条 |
| 图片（双桥） | 9 条：`buddy` `workbuddy` `lobsterai` `qoder` `qodercn` `cline` `raccoon` `gemini` `zcode` | 单桥 3 条：`trae` `loomy` `minimax`；未接 10 条 |
| 粘贴型登录 | 5 条 | — |

---

## 3. 逐渠道细节与取证

### 3.1 CodeArts（`codearts`）

- 登录：华为云 IAM 授权，登录 URL 由本地回调端口 + ticketId 动态拼出（`login.ts` `buildLoginUrl`）。
- 模型 / 额度端点走 **AK/SK 签名**（`signRequestHuawei`）；余额来自 `statistics/plugin`，
  非积分账户（Token 计费）**如实报「无积分余额」**而不是 0。
- 签到：`claimCodeArtsDailyCheckin`，领取流程自带账户类型 + 活动列表预检（`precheckStatus: false`）。
- 图片：`llm-adapter.ts` 只保留文本块，其余块被丢弃 —— 无字节桥，也没有占位符。

### 3.2 CodeBuddy 系（`buddy` / `workbuddy`）

- 登录：同一套 `cli-external-link` 两步流程，`POST /v2/plugin/auth/state`（**GET 会 404**）拿
  `{ state, authUrl }`；产品差异（`platform` / endpoint / `X-Product-Code` / UA）全在 `product.ts`。
- 模型目录：`GET /v3/config` → `data.data.models`。
- 额度：`POST /v2/billing/meter/get-user-resource`；国际版**没有**签到接口，
  服务端分支显式拒绝（`credits.claimAll` 的 `workbuddy` 守卫），避免用国际版凭据打国内签到。
- 图片：两产品都接双桥（`readImage` + `readImageRequest`）。

### 3.3 LobsterAI（`lobsterai`）

- 登录：slot → context 三步；签到必填 `clientVersion`（动态解析 + 缓存）。
- 额度：资源包按 `expiresAt` 归一到「长期 / 临时」，回传 `windowDays`。
- 图片：双桥（`lobsterai-adapter.ts` 对取字节失败保 `[image unavailable]` 占位）。

### 3.4 Qoder / Qoder 中国版（`qoder` / `qodercn`）

- 登录：浏览器授权；两站端点与模型池不同，`provider` 分开（`qoder` / `qodercn`）。
- 模型目录：来自**本机官方客户端** `~/.qoder/.models/{uid}/catalog-v6`（中国版 `~/.qoder-cn/...`）的解密文件。
- 额度：`GET {openApiBase}/sash/api/v2/me/usage`（只需 Bearer + `Cosy-ClientType`；**usage/campaigns 挂 openapi host**，不是 api2 系）。
- 签到：领取流程自带活动列表（`loadCampaigns` → 逐个 claim，`precheckStatus: false`）。
- 图片：双桥。

### 3.5 TRAE（`trae`）

- 登录：官方登录页（手机号）；展示名用脱敏手机号区分多账号（`repairAccountNicknames`）。
- 额度：积分资源包；签到状态端点需要发起 Ug 请求（多步）。
- 图片：**单桥**（只有 `readImage`，未接缩放桥）。

### 3.6 Cline（`cline`）

- 登录：Cline OAuth；凭据 1 小时寿命，续期由 30 分钟一轮的批量续期覆盖。
- 模型目录：内嵌 `BUILTIN_MODEL_CATALOG` + 远端 `free` 数组，并用 **models.dev** 补名字、
  上下文窗口与图片能力（内嵌表覆盖不到远端 460 个 id）。
- 额度：`GET /api/v1/users/{accountId}/balance`，单位 dollars。
- 签到：**无签到端点**（对整个 sidecar 做字符串扫描，`checkin` / `daily` / `campaign` 全无命中）；
  客户端能力矩阵登记为 `dailyCheckin: false`，服务端也显式拒绝，不落成泛化的 unsupported 文案。
- 图片：双桥。

### 3.7 Loomy（`loomy`）

- 登录：**本地页承载的微信扫码**，短信验证码为备用路径（`login.sendSms` / `login.submitSms`
  **仅对 Loomy 开放**）。
- 额度：今日赠送额度 + 永久积分；按余额优先选号（今日额度耗尽后服务端会**静默**扣永久积分，
  故有 `LoomyBalanceSelector` 与「锁定永久积分」开关）。
- 签到：`POST /points/first-login`（响应自带 `alreadyProcessed` 判幂等）；
  无独立状态端点，`credits.status` 如实返回 `null`。
- 图片：单桥。

### 3.8 Raccoon Work（`raccoon`）

- 登录：本地页承载的微信扫码 + 短信双路径；**不依赖官方桌面端**（`office-raccoon://` 回调收不到，
  改为宿主本地生成 code + 自行轮询）。
- 模型目录：远端，`visible` 过滤 + 带倍率的展示名。
- 额度：账单；**无签到端点**（每日 300 积分由服务端按日自动发放，账单里是 `daily_grant`），
  另有「新手任务 / 桌面端登录奖励」走 `onboarding.claim`（一次性，幂等）。
- 图片：双桥（尤其需要：该网关按**请求体字节**设限，实测超 10MB 回 `HTTP_413`）。

### 3.9 MiniMax Code（`minimax`）

- 登录：**OAuth 设备码 + PKCE**（不起本地监听端口，后台轮询换 token）；有真 refresh 端点。
- 协议：**Anthropic Messages** 协议族（`minimax-messages.ts`）；图片必须是**裸 base64** 的
  `image.source.base64`（OpenAI 的 `image_url` 形状会被服务端拒）。
- 模型目录：**必须走远端**（客户端内置表只有 3 个模型，远端 4 个）。
- 签到：`/minimax-cloud/api/v1/signin/status` + `claim_result`（`1` 真领取 / `2` 已领），
  并开启状态预检作为第二道防线。
- 图片：单桥（未接缩放桥；远端 `capabilities.max_image_bytes_inline` 为 10 MiB，超限行为未实测）。

### 3.10 ZCode（`zcode`）

- 登录：官方 CLI **设备授权流**（`/oauth/cli/init` → 浏览器授权 → `/oauth/cli/poll/{flow_id}`），
  `device_mid` 由插件自己生成，**不读本机客户端任何数据**；captcha **按需**产出。
- 协议：**Anthropic Messages** 协议族（`zcode-anthropic.ts`）。
- 模型目录：静态白名单（上游模型池含实测返回空响应的两条，故不枚举远端）。
- 额度：单位 tokens；签到 = 补激活上报 → preview → 逐个 plan claim（**每个 plan 现产一个
  captcha**，复用会得 `3007`）。
- 图片：双桥（不接会在序列化时退化成 `[image unavailable]`，实测症状是模型回
  「我在当前对话中没有收到任何图片」）。

### 3.11 Gemini（`gemini`）

- 登录：**只做 OAuth**（Google，本地回调）；API key / AI Studio 两条线不做。
- 模型目录：**静态**（用户拍板：Cloud Code 没有模型列表端点）；暴露 1 个
  `gemini-3.8-flash` + 4 档 effort，不暴露带后缀名与 lite。
- 额度：`POST /v1internal:retrieveUserQuotaSummary` 两个窗口（`gemini-5h` / `gemini-weekly`）
  的剩余比例；同时带回账号档位（Pro / Free / Ultra）。
- 签到：**无每日签到**（额度按窗口滚动刷新）。
- 图片：双桥（按 640,000 px 预算取缩放版）。

### 3.12 Command Code（`commandcode`）

- 登录：浏览器 OAuth + **本地回调**；授权页 `/studio/auth/cli`（旧路径 `/cli/authorize` 已 404）。
- 凭据：单个**长期 API Key**（无 refresh_token 轮换），鉴权是标准 `Bearer <key>`。
- 推理：标准 OpenAI 兼容 SSE。
- 模型目录：远端 `GET /provider/v1/models`（+ 兜底表）。
- 额度：上游有 `GET /alpha/billing/credits`，**尚未接入**共享 credits RPC（矩阵记 ❌⚠️）。
- 图片：协议层有图片块序列化，但未接字节桥 → 退化为占位符。

### 3.13 OfficeAce 果办（`officeace`）

- 登录：**自助 OAuth + 轮询授权码**，回调不落本机：`GET /v1/claw/auth/code?state=<state>`
  的 `202` 继续等 / `404` 判作废 / `200` 拿码（**必须读状态码**，否则失败会拖到超时）。
- 三套签名：STS 用 DPoP（ES256 JWS）、业务用 SDK-HMAC-SHA256、部分接口 V11-HMAC-SHA256。
- 模型目录：远端 `{base}/models`（+ 兜底表）。
- 额度 / 签到：未接入。
- 图片：协议层支持，但未接字节桥。

### 3.14 Accio / Accio 国内版（`accio` / `accio-cn`）

- 登录：浏览器授权，国际站 `www.accio.com` / 国内站 `www.accio-ai.com`，`client_id` 两地逐字相同
  （`accio-work`）；两地共用同一网关，差别只在 `x-package-region` 与登录站点。
- 三个独特点：token **不走** `Authorization` 头（GET 拼 query、POST 放 body）；请求体是
  Gemini 风格信封；响应是 ADK 自有帧（`content.parts` / `turn_complete`）。
- 模型目录：远端（适配器内 `fetchModels`）。
- 额度 / 签到：未接入。图片：未接字节桥。

### 3.15 OrcaTerm（`orcaterm`）

- 登录：**粘贴 Cookie** `ot_session`。上游三条登录链路都无法在插件里自动完成
  （桌面端回调走 `orcaterm://`；微信扫码 state 绑服务端会话；Web 控制台扫码后写 Cookie —— 扫码动作仍须用户自己完成）。
- 对话：**建会话 → SSE** 两步（每轮新建会话，历史拍平进输入）。
- 模型目录：**静态兜底表**（上游没有公开目录端点，模型由控制台下发）。
- 额度 / 签到 / 图片：未接入。

### 3.16 KukuAI（`kuku`）

- 登录：**粘贴 Cookie** `BDUSS`（也可短信验证码登录百度 passport，但插件侧只收 Cookie）。
- 对话：`POST /wenchain/genflowpro/sendmsg` → SSE `/wenchain/genflowpro/sse/getchatcontent`；
  `clienttype` / `version` / `channel` / `v` 照官方 PC 客户端原样下发。
- 模型目录：**静态兜底表**（模型名由客户端自报）。额度 / 签到 / 图片：未接入。

### 3.17 MonkeyCode（`monkeycode`）

- 登录：**粘贴 Cookie** `nebula_session`（走 OAuth 授权 + Cookie 会话，**没有设备码或本地回调**）。
- 对话：**两步 WebSocket** —— `POST /api/v1/users/tasks` 建任务 → 连
  `/api/v1/users/tasks/stream?id=<taskId>&mode=develop` 逐帧读正文；RFC6455 客户端手写
  （`monkeycode-ws.ts`），事件解析容错（认不出的帧忽略而不报错）。
- 模型目录：远端 `GET /api/v1/users/models/available`（+ 兜底表）。
- 额度 / 签到：`monkeycode-auth.ts` **已实现** `GET /api/v1/users/wallet` 与
  `GET|POST /api/v1/users/wallet/checkin`，但**未接入**共享 credits RPC
  （`channel-pack-rpc.ts` 的 `credits.balances` / `credits.claimAll` 无 `monkeycode` 分支，
  `client.js` 的 `CHANNEL_CREDITS` 也没有该条目）—— 面板上因此没有余额/签到区块。
- 图片：未接字节桥。

### 3.18 AutoClaw（国内 / 国际）（`autoclaw` / `autoclaw-intl`）

- 登录：**粘贴令牌**。上游是 OAuth（Zai / Google）且回调端口有白名单
  （`[18432, 19654, 19723, 53699]`），国内站另需阿里云验证码 SDK（`AliyunCaptcha.js`，场景 `sq51tr`），
  插件内无法自动完成，故用粘贴令牌。
- 认证头是 **`X-Authorization`**，不是 `Authorization`（照规格文档写会 401，且报错形态与 token 失效相同）。
- 模型目录：远端 `GET {base}/proxy/autoclaw-model-config`（**不在** `/autoclaw` 那一级；
  无真实令牌时回 404，不能据此判死链）。
- 额度 / 签到 / 图片：未接入。

### 3.19 免密车道（2 条，无需账号）

| 车道 | 对话 | 模型目录 | 额度 | 签到 | 图片 |
| --- | --- | --- | --- | --- | --- |
| 匿名免费车道（OpenCode Zen） | ✅ | ✅ 远端（Zen 目录 + models.dev 能力表） | 通道状态（本地判定，非远端余额） | ❌ | ✅（已接 `readImage`，模态按远端能力表） |
| Kilo 免费池 | ✅ | ✅ 远端清单 | ❌ | ❌ | ❌ |

- 两条车道都由 OFM 自身实现（`src/adapter.js`、`src/upstream.js`、`src/kilo.js`），
  与 `vendor/channel-pack` 无关；账号侧的 OpenCode provider 在 OFM 挂载时**关闭**。
- 匿名车道实测有多个支持图片输入的免费模型（`src/catalog.js` 的能力表按模型登记 `vision`）。
- Kilo 免费池的「空池」语义：全收费列表 / 显式空列表都算合法，失败时**保留旧缓存**。

---

## 4. 复现与取证方式

| 结论 | 取证命令 / 文件 |
| --- | --- |
| 账号渠道 22、免密车道 2、粘贴型 5 | `grep -n "账号渠道（22" README.md; grep -n "Account channels (22)" README_EN.md`；`node scripts/channel-pack-test.mjs --source`（粘贴型提示与形状解析用例） |
| 卡片与已挂载 provider 一致（各 22） | `node scripts/channel-pack-test.mjs`（断言 `adapters.size === 22`、`cards.length === 22`） |
| 额度 / 签到的渠道集合（13 条契约） | `node scripts/channel-credits-rpc-test.mjs`；`vendor/channel-pack/src/channel-pack-rpc.ts` 的 `credits.balances` / `credits.claimAll` / `credits.status` 分派 |
| 图片双桥 / 单桥 | `vendor/channel-pack/src/index.ts` 各注册块的 `readImage` / `readImageRequest` |
| 发布产物与源码同步（防「改了 src 忘了重打包」） | `node scripts/channel-pack-test.mjs` —— 打包模式**也跑** `account.adopt` 端到端；产物重建见 §4.1 |
| 上游端点是否还活着（手动探活，默认不入 CI） | `node scripts/channel-probe.mjs`（见其文件头用法与已固化实测坑） |


### 4.1 产物重建（发布形态，必做）

`vendor/channel-pack/pack.js` 与 `packages/standalone/channels/business.mjs` 是**发布产物**：
`package.json` 的 `files` 只发 `pack.js`、不发 `src/`。改完 `vendor/channel-pack/src/**` 必须重建，
否则装机版停留在旧逻辑 —— 2026-10-23 发生过一次：形状校验加固与 `credentials.set` 只进了 src，
`pack.js` 里仍是 `credentials.write`（真实 host 无此方法），装机版 `account.adopt` 直接失败，
而当时打包模式回归全绿（adopt 用例被 `sourceMode` 门控）。

```bash
# 必须在仓库根执行：esbuild 的模块注释按 cwd 取相对路径，换目录会让整份产物多出路径差异
cp packages/standalone/node_modules/@esbuild/linux-x64/bin/esbuild /tmp/esbuild-0.25.9
chmod +x /tmp/esbuild-0.25.9
OFM_ESBUILD_DIR="$PWD/packages/standalone" ESBUILD_BINARY_PATH=/tmp/esbuild-0.25.9 \
  node scripts/build-channel-pack.mjs
node scripts/build-standalone-channels.mjs          # 再生成 business.mjs
node scripts/build-standalone-channels.mjs --check  # 复验
```

esbuild 取自仓库自身（`packages/standalone/package-lock.json` 钉 0.25.9）；该版本可逐行复现
已提交产物，除预期的源码改动外**无版本 churn**。二进制必须先复制到 U 盘之外：本工作区挂在
`vfat` 且带 `showexec` / `nosuid` / `nodev`，**U 盘上的非 `.exe` 文件一律不可执行**，直接调用会 `EACCES`。

---

## 5. 维护约定

1. **新增渠道**：在 `README.md` / `README_EN.md` 渠道表加行 → 在本文件 §2 主表加行
   （缺一维就标 ❌ 或 ⚠️，**不要臆造**）→ 若可手动探活，在 `scripts/channel-probe.mjs`
   的渠道表加端点（每条注明源码常量来源）。
2. **能力状态变化**（例如「模块内有实现但未接入」被接线）：改本文件 §2 与 §3 的对应行，
   并在 §4 补一条可复现命令。
3. **口径**：任何「渠道数」文案改动都必须同时覆盖 §1 列出的来源，且日志数字必须与**同一文件里的
   断言**同值（账号渠道一律 22；额度 / 签到契约一律 13），并同步本文 §1.2 —— 避免再次出现
   「日志说 12、断言说 22」。改动 `src/**` 后必须按 §4.1 重建产物。
