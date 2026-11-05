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
| 账号渠道（provider） | 15 | 见 §2 主表；免密车道逐条说明见 §3.16 |

「账号渠道 15」这一数字在本仓库有四处独立佐证（2026-11-05 重新核对；此前写 22 是
`autoclaw-intl` / `lobsterai` 移除前的旧值）：

- `README.md` 渠道章节「**账号渠道（15 个）**」；`README_EN.md` "**Account channels (15)**"；
- `client.js` 的 `CHANNEL_PROVIDERS` 表：15 条卡片（每条的 `login` 字段决定交互形态）；
- `scripts/channel-pack-test.mjs`：`assert.equal(adapters.size, 15)`（UI 卡片数由 CHANNEL_PROVIDERS 自动跟随）；
- `vendor/channel-pack/src/index.ts` 的注册段：15 个账号 provider（OFM 挂载时关闭上游 OpenCode 账号接入，故不计入）。

**纯粘贴渠道 0 个**（2026-11-05：`monkeycode` / `kuku` / `accio` / `accio-cn` / `orcaterm`
五个渠道整体移除，最后的粘贴渠道 OrcaTerm 也在其中）。`ADOPTABLE_CHANNELS` 现为空表——
`account.adopt` 对任何 provider 都直接拒绝，前端不再渲染粘贴入口。

> 口径变更（2026-10-24）：`kuku` 已改为百度 App 扫码、`autoclaw` 国内站已改为手机号 +
> 短信验证码，都不再是粘贴渠道；旧的「粘贴型渠道共 5 个」描述已过期。
>
> 粘贴这两个渠道时，面板会给出「先打开官网登录 → F12 到哪抄哪一段」的引导
> （粘贴入口已移除，登录方式表由 `scripts/channel-login-methods-test.mjs` 守卫），
> 不再让用户对着空粘贴框猜。

### 1.2 计数口径（15 / 12 / 0）

| 计数 | 它到底在数什么 | 权威来源 |
| --- | --- | --- |
| **15** | 账号渠道（provider）条数 | `README.md` / `README_EN.md` 的渠道表、`client.js` 的 `CHANNEL_PROVIDERS`、`scripts/channel-pack-test.mjs` 的 `adapters.size === 15` 与 `cards.length === 15`、`vendor/channel-pack/src/index.ts` 注册段 |
| **11** | 「带额度 / 签到能力」的非空契约 | `client.js` 的 `CHANNEL_CREDITS`（11 条非空；workbuddy/loomy/raccoon/commandcode 为空 {} 占位） |
| **0** | 纯粘贴型登录 | `ADOPTABLE_CHANNELS`（空表） |

`autoclaw-intl` 与 `lobsterai` 已于 2026-10-25、`monkeycode` / `kuku` / `accio` / `accio-cn` / `orcaterm` 已于 2026-11-05 整链移除（源码 / 卡片 / 凭据解析 / 测试一并删除），故 15 而不是早先文档里的 22。任何计数文案都必须与同一文件里的断言同值，
维护要求见 §5。

> 本文不收录已从仓库整链移除的渠道：其源码、卡片、凭据解析与测试均已删除，
> 矩阵中不再出现。

---

## 2. 能力矩阵（15 个账号渠道）

图例：**✅** 插件已接入；**⚠️** 上游或模块内有该能力、但插件未接入（括号内写原因）；
**❌** 无此能力或上游没有该端点。

「图片」列的三种取值口径：
**双桥** = 接了 `readImage` + `readImageRequest`（可按预算缩放后重发，抗大截图）；
**单桥** = 只接 `readImage`（原图直发，超限行为未实测）；
**❌** = 未接字节桥，图片块在序列化时退化为 `[image unavailable]` 占位符或直接丢弃
（模型收不到图、也不会报错）。

| # | 渠道（provider · 展示名） | 登录方式 | 对话 | 模型目录 | 额度查询 | 签到 | 图片 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `codearts` · CodeArts | 浏览器授权（华为云 IAM，本地回调 + PKCE） | ✅ | ✅ 远端 | ✅ | ✅ | ❌（非文本块被丢弃） |
| 2 | `buddy` · WorkBuddy 国内版（CodeBuddy 端点） | 浏览器授权（两步：`POST /v2/plugin/auth/state` → authUrl） | ✅ | ✅ 远端 | ✅ | ✅ | ✅ 双桥 |
| 3 | `workbuddy` · WorkBuddy 国际版 | 浏览器授权（同上，`platform=workbuddy-ai`） | ✅ | ✅ 远端 | ✅ | ❌（后端无签到接口） | ✅ 双桥 |
| 4 | `qoder` · Qoder | 浏览器授权（OAuth；推理走加密端点，需 WASM 签名） | ✅ | ✅ 本机客户端解密目录（`catalog-v6`） | ✅ | ✅ | ✅ 双桥 |
| 5 | `qodercn` · Qoder 中国版 | 浏览器授权（同上，读 `~/.qoder-cn`） | ✅ | ✅ 本机客户端解密目录 | ✅ | ✅ | ✅ 双桥 |
| 6 | `trae` · TRAE | 浏览器授权（官方登录页，手机号） | ✅ | ✅ 远端 | ✅ | ✅ | ✅ 单桥 |
| 7 | `cline` · Cline | 浏览器授权（Cline OAuth） | ✅ | ✅ 内嵌目录 + models.dev 远端补充 | ✅（单位 dollars） | ❌（无签到端点） | ✅ 双桥 |
| 8 | `loomy` · Loomy | 本地页微信扫码；短信验证码为备用路径 | ✅ | ✅ 远端 | ✅ | ✅ | ✅ 单桥 |
| 9 | `raccoon` · Raccoon Work | 本地页微信扫码 + 短信双路径（不依赖官方客户端回调） | ✅ | ✅ 远端 | ✅ | ❌（每日积分由服务端自动发放；另有新手任务领取） | ✅ 双桥 |
| 10 | `minimax` · MiniMax Code | OAuth 设备码 + PKCE | ✅（Anthropic Messages 协议族） | ✅ 远端 | ✅ | ✅ | ✅ 单桥 |
| 11 | `zcode` · ZCode | 浏览器授权（官方 CLI 设备授权流 `/oauth/cli/init` → 轮询） | ✅（Anthropic Messages 协议族） | ✅ 静态白名单（远端接口保留） | ✅（单位 tokens） | ✅ | ✅ 双桥 |
| 12 | `antigravity` · Antigravity（原 `gemini`，2026-11-01 改名） | 浏览器授权（Google OAuth，本地回调；只做 OAuth） | ✅ | ✅ 远端（`fetchAvailableModels`；claude/gpt-oss 家族放行，3.8 系分段合并，同名条目消歧） | ✅（分组配额桶：Gemini 组 + Claude·GPT 组） | ❌（无每日签到） | ✅ 双桥 |
| 13 | `commandcode` · Command Code | 浏览器授权（自动回调；授权页 `/studio/auth/cli`） | ✅ | ✅ 远端 | ✅（`/alpha/billing/credits`，`readCredits`） | ❌ | ❌ |
| 14 | `officeace` · OfficeAce 果办 | 浏览器授权（自助 OAuth + 轮询授权码，回调不落本机） | ✅ | ✅ 远端 | ❌ | ❌ | ❌ |
| 15 | `autoclaw` · AutoClaw（国内） | 手机号 + 短信验证码（卡片内嵌表单，无本地页） | ✅ | ✅ 远端（`autoclaw-model-config`） | ✅ 钱包（`agent-assetmgr/wallets`） | ✅ 签到（`task_complete`） | ❌ |

**按维度汇总**：

| 维度 | 已接入 | 未接入 / 不支持 |
| --- | --- | --- |
| 对话 | 15（全部） | — |
| 模型目录 | 远端目录 15 条 | 无静态兜底渠道（`orcaterm` 已删除；`antigravity` 等均接远端目录） |
| 额度查询 | 点名集合：`codearts` `trae` `minimax` `commandcode` `autoclaw` `officeace` `antigravity` `cline` `loomy` `raccoon` `zcode` 有专用分支；`buddy` 系走 `productById()` 通用回落；`qoder` `qodercn` 无分支 |
| 签到（claim） | **9 条**：codearts / buddy / qoder / qodercn / trae / minimax / zcode / officeace / autoclaw（loomy 签到已于 2026-11-06 移除） | 无 claim：workbuddy / cline / raccoon / antigravity / commandcode / loomy |
| 图片（双桥） | 8 条：`buddy` `workbuddy` `qoder` `qodercn` `cline` `raccoon` `antigravity` `zcode` | 单桥 3 条：`trae` `loomy` `minimax`；未接 9 条 |
| 粘贴型登录 | 纯粘贴 0 条；卡片内嵌 1 条（`autoclaw` 短信）；`loomy` `raccoon` 仍为本地页 | — |

---

### 2.1 模型目录的唯一事实来源与落盘快照（2026-10-27）

用户当天拍板的两条规则，**全部 15 个渠道**统一执行：

1. **远端目录全量覆盖兜底表**：「不是增量，是直接写入」—— 远端拉成功就把整份目录
   当作事实来源，**不再与编译期兜底表合并**。兜底表只剩一个用途：远端**从未成功过**
   （首次启动就离线 / 凭据失效）时顶替。
2. **落盘快照跨进程存活**：拉成功即写 `$DSH_HOME/channel-pack/model-catalogs/<provider>.json`
   （原子写 tmp+rename，按渠道分文件，schema+provider 双校验，损坏即当无快照）。
   重启或离线时用「上次成功的那一份」，而不是退回几个月前的编译期表。

配套的两处收紧：

- **思考档位只认远端**（`reasoning.supportedEfforts` 等）。本地兜底表里的档位 id 若
  上游不认，透传过去只会被静默忽略或报错，比不显示选择器更糟。
  受影响：`buddy` / `workbuddy` / `qoder` / `qodercn` / `loomy`。
- **CodeArts 补上了读盘路径**：它一直 `saveModelsCache()` 写
  `~/.cache/deveco/codearts_models.json`，但 `availableCodeArtsModels()` **全仓库没有
  调用点** —— 缓存只写不读，重启后照样退回兜底表。现已接上。

各处历史策略的归宿：

| 位置 | 旧策略 | 现在 |
| --- | --- | --- |
| `buddy` / `workbuddy` | `reconcileWithFallback()`：兜底表打底 + 远端补字段 + 追加 `agentReferenced` | 整份替换（`agentReferenced` 仅留作诊断） |
| `autoclaw` | 并集：补回目录不下发的 `zai_glm-5.3-flash` | 整份替换。实测 **2026-10-28 上游已下发该 id**（目录回 4 个），故当前无损失；若哪天又不下发，它会消失 |
| `qoder` / `qodercn` | 已是整份替换，但思考档位从兜底表补齐 | 档位不再补齐 |
| `cline` | 远端为权威、兜底表只给已认识的 id 补元数据 | 未动（本就符合规则） |
| `officeace` | 上游 `GET {base}/models` 只回 `{id,object,created,owned_by}` | 未动：**上游没有任何倍率字段**，无倍率可显示 |


---

## 3. 逐渠道细节与取证

### 3.1 CodeArts（`codearts`）

- 登录：华为云 IAM 授权，登录 URL 由本地回调端口 + PKCE 动态拼出（`login.ts` `buildOAuthLoginUrl`）；旧 ticket 轮询兜底已删（2026-10-29）。
- 模型 / 额度端点走 **AK/SK 签名**（`signRequestHuawei`）；余额来自 `statistics/plugin`，
  非积分账户（Token 计费）**如实报「无积分余额」**而不是 0。
- 签到：`claimCodeArtsDailyCheckin`，领取流程自带账户类型 + 活动列表预检（`precheckStatus: false`）。
- 图片：`llm-adapter.ts` 只保留文本块，其余块被丢弃 —— 无字节桥，也没有占位符。

### 3.2 CodeBuddy 系（`buddy` / `workbuddy`）

- 登录：同一套 `cli-external-link` 两步流程，`POST /v2/plugin/auth/state`（**GET 会 404**）拿
  `{ state, authUrl }`；产品差异（`platform` / endpoint / `X-Product-Code` / UA）全在 `product.ts`。
- 模型目录：`GET /v3/config` → `data.data.models`，**整份替换**兜底表（见 2.1），
  并落盘到 `model-catalogs/{buddy,workbuddy}.json`。
- 额度：`POST /v2/billing/meter/get-user-resource`；国际版**没有**签到接口，
  服务端分支显式拒绝（`credits.claimAll` 的 `workbuddy` 守卫），避免用国际版凭据打国内签到。
- 图片：两产品都接双桥（`readImage` + `readImageRequest`）。

### 3.3 ~~LobsterAI~~（已于 2026-10-25 移除）

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

- 登录：本地页承载的微信扫码 + 短信双路径；**不依赖官方桌面端**（`office-raccoon://` 回调收不到）。
- 扫码协议（2026-10-24 修正）：官方已把扫码迁到 `POST /api/iam/v1/auth/mp/qrcode` —— 由**服务端下发**
  `qrcode_code` + `scan_path`，二维码内容 = `scan_path?code&appname&source=platform`，轮询走
  `/api/iam/v1/auth/mp/qrcode/login`。旧的「本地随机 code + 固定 `/login/mp`」链路已失效
  （该页对任何 code 都 404，带 Cookie / 微信 UA / Referer 均如此）。
- ⚠️ 上游扫码落地页当前仍 404：插件会探测并在面板上提示「扫码暂不可用」、默认切到短信登录；
  短信链路正常。页面恢复后无需发版（探测为 200 即自动启用）。
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
- 额度：单位 tokens；签到 = 补激活上报 → 取可领活动 → 逐个 plan claim（captcha **按需**：
  先裸发一次，只在 `3007` 时才产，复用会得 `3007`）。
- 可领活动的**权威来源是营销投放** `GET /api/v1/marketing/touch`（2026-11-02 实测）：
  `billing/preview` 对每日活动恒回 `{"code":0,"msg":"","logid":…}`（**连 `data` 都没有**），
  只读它就会永远判成「今日暂无可领额度」。现两条都读、按 `plan_id` 去重（投放优先）。
  投放里 `claim_zcode_plan` 动作给「可领」，`zcode_plan` 元数据给额度/名称，两者缺一不可。
  版本门槛：`marketing/touch` 按 `app_version` 下发，且**窗口会随活动期上移**（2026-11-03
  实测：`3.16.3` 已出窗，`3.17.2 ~ 3.20.x` 有投放）。现行钳制钉在窗口内（兜底 `3.20.9`，
  见 `src/zcode.ts`）；上游换期后若又「今日额度未到账」，重扫 touch 并同步三处常量。
- 图片：双桥（不接会在序列化时退化成 `[image unavailable]`，实测症状是模型回
  「我在当前对话中没有收到任何图片」）。

### 3.11 Antigravity（`antigravity`，原名 `gemini`，2026-11-01 改名）

- 登录：**只做 OAuth**（Google，本地回调）；API key / AI Studio 两条线不做。
- 模型目录：**远端优先**（`fetchAvailableModels`，2026-11-01 接入；静态表降为
  远端失败时的兜底）。放行 Gemini / Claude / GPT-OSS 三族；3.8 系的
  `{low,medium,high}` 分段条目合并成单条 `gemini-3.8-flash`（档位走 efforts
  下拉）；上游撞名的 2.5 系条目按公开名消歧（`Gemini 2.5 Flash` 等）。
- 额度：`POST /v1internal:retrieveUserQuotaSummary` **两个独立分组桶**
  （Gemini 组 `gemini-5h`/`gemini-weekly`；Claude·GPT 组 `3p-5h`/`3p-weekly`，
  2026-11-01 实测确认两组独立计数）+ 模型级 `quotaInfo`（粗快照，仅兜底）；
  同时带回账号档位（Pro / Free / Ultra）。模型名后的绿标用组桶精确值。
- 签到：**无每日签到**（额度按窗口滚动刷新）。
- 图片：双桥（按 640,000 px 预算取缩放版）。

### 3.12 Command Code（`commandcode`）

- 登录：浏览器 OAuth + **本地回调**；授权页 `/studio/auth/cli`（旧路径 `/cli/authorize` 已 404）。
- 凭据：单个**长期 API Key**（无 refresh_token 轮换），鉴权是标准 `Bearer <key>`。
- 推理：标准 OpenAI 兼容 SSE。
- 模型目录：远端 `GET /provider/v1/models`（+ 兜底表）。
- 额度：`GET /alpha/billing/credits` **已接入**共享 credits RPC（`readCredits`，只读余额，无签到端点）。
- 图片：协议层有图片块序列化，但未接字节桥 → 退化为占位符。

### 3.13 OfficeAce 果办（`officeace`）

- 登录：**自助 OAuth + 轮询授权码**，回调不落本机：`GET /v1/claw/auth/code?state=<state>`
  的 `202` 继续等 / `404` 判作废 / `200` 拿码（**必须读状态码**，否则失败会拖到超时）。
- 三套签名：STS 用 DPoP（ES256 JWS）、业务用 SDK-HMAC-SHA256、部分接口 V11-HMAC-SHA256。
- 模型目录：远端 `{base}/models`（+ 兜底表）。
- 额度 / 签到：未接入。
- 图片：协议层支持，但未接字节桥。

### 3.14 AutoClaw（国内）（`autoclaw`）

- 登录：**国内站 = 手机号 + 短信验证码**（本地弹窗页 `autoclaw-login-page.ts`，协议 `autoclaw-sms.ts`，
  真机已验证 24h token）；**国际站仍粘贴令牌** —— 其 OAuth 回调端口有白名单
  （`[18432, 19654, 19723, 53699]`），国内站另需阿里云验证码 SDK（`AliyunCaptcha.js`，场景 `sq51tr`），
  插件内无法自动完成，故用粘贴令牌。
- 认证头是 **`X-Authorization`**，不是 `Authorization`（照规格文档写会 401，且报错形态与 token 失效相同）。
- 模型目录：远端 `GET {base}/proxy/autoclaw-model-config`（**不在** `/autoclaw` 那一级；
  无真实令牌时回 404，不能据此判死链）。
- 续期：国内站**有** refresh 端点（`/userapi/v1/refresh`，失败退 `/userapi/v1/agent-refresh`），
  短信登录的 refresh_token 会自动续期；国际站没有 refresh_token，刷新只做凭据复核。
- 额度 / 签到 / 图片：未接入 —— 卡片因此不显示余额/签到区（无积分端点）。

### 3.15 免密车道（2 条，无需账号）

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
| 账号渠道 15、免密车道 2、纯粘贴 0 | `grep -n "账号渠道（20" README.md; grep -n "Account channels (20)" README_EN.md`；`node scripts/channel-pack-test.mjs --source`（粘贴型提示与形状解析用例） |
| 卡片与已挂载 provider 一致（各 15） | `node scripts/channel-pack-test.mjs`（断言 `adapters.size === 20`、`cards.length === 20`） |
| 额度 / 签到的渠道集合（11 条非空契约） | `node scripts/channel-credits-rpc-test.mjs`；`vendor/channel-pack/src/channel-pack-rpc.ts` 的 `credits.balances` / `credits.claimAll` / `credits.status` 分派 |
| 图片双桥 / 单桥 | `vendor/channel-pack/src/index.ts` 各注册块的 `readImage` / `readImageRequest` |
| 发布产物与源码同步（防「改了 src 忘了重打包」） | `node scripts/channel-pack-test.mjs` —— 打包模式**也跑** `account.adopt` 端到端；产物重建见 §4.1 |
| 上游端点是否还活着（手动探活，默认不入 CI） | `node scripts/channel-probe.mjs`（见其文件头用法与已固化实测坑） |


### 4.1 产物重建（发布形态，必做）

`vendor/channel-pack/pack.js` 与 `packages/standalone/channels/business.mjs` 是**发布产物**：
`package.json` 的 `files` 只发 `pack.js`、不发 `src/`。改完 `vendor/channel-pack/src/**` 必须重建，
否则装机版停留在旧逻辑 —— 2026-10-23 的实例：`81fc8e7` 的凭据形状加固只进了 src 没重建产物，
于是装机副本实测**仍注册着已移除的粘贴型渠道**，并接受 `nebula_session=abc` 这种形状非法的凭据
（`account.adopt` 返回 `ok:true`）；而当时打包模式回归全绿，因为 adopt 用例被 `sourceMode` 门控、
打包模式根本不跑它。

> **更正（2026-10-24）**：本节此前写「`pack.js` 里仍是 `credentials.write`（真实 host 无此方法），
> 装机版 `account.adopt` 直接失败」——**这个因果是错的**。`write` 确实不在抽象契约里
> （`@deepseek-ai/dsh-credentials` 只声明 `resolve` / `describe` / `set` / `unset`），
> 但本机实时实现 `@deepseek-ai/dsh-credentials-local` 0.2.1-rc.2 实现了这个未声明方法
> （`lib/index.js:608`，且 `write(ref, undefined)` 即 unset）。实测旧产物 adopt 返回 `ok:true`，
> 故改用 `credentials.set` 是**对齐声明契约的加固，不是**修复一个必然失败。
> 真正被方法名坑到的是 `CommandCodeAuth.logout()`：它调 `credentials.delete?.()`，
> 而 `delete` 在抽象契约与实时实现里都不存在，于是静默不生效（已改为 `unset`）。

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
   断言**同值（账号渠道一律 15；额度 / 签到契约一律 13），并同步本文 §1.2 —— 避免再次出现
   「文档说 22、断言说 20」。改动 `src/**` 后必须按 §4.1 重建产物。
