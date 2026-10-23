# 渠道登录方式矩阵

> 一句话：22 个账号渠道里，**16 个的登录在浏览器/本地页内完成**（不需要手抄凭据），
> **1 个（`loomy`）界面会额外要短信验证码**，**5 个只能粘贴凭据**。本文的「一键」指：点「添加账号」后只需在浏览器内完成授权，
> 插件自己把 token 收回来，**不需要手动复制任何东西**。

## 1. 总表

| # | provider | 登录机制 | 一键 | 需人工操作 | 本地监听 | 代码证据 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `codearts` | 浏览器授权 → 本地回调收授权码（两步式） | ✅ | 浏览器登录 | 是 | `channel-pack-rpc.ts:1613` |
| 2 | `buddy` | 浏览器授权 → 轮询 token（`auth/state` 换登录页） | ✅ | 浏览器登录 | 否 | `channel-pack-rpc.ts:1481-1506`、`buddy-oauth.ts:137,178` |
| 3 | `workbuddy` | 同 `buddy`（同一实现，不同产品配置） | ✅ | 浏览器登录 | 否 | 同上 + `product.ts` 的 `WORKBUDDY` |
| 4 | `lobsterai` | 浏览器授权 → 本地回调（与 codearts 同款） | ✅ | 浏览器登录 | 是 | `channel-pack-rpc.ts:1651` 起 |
| 5 | `qoder` | 设备码轮询（不起本地端口） | ✅ | 浏览器输码 | 否 | `qoder-oauth.ts:119,205` |
| 6 | `qodercn` | 同 `qoder`（同族不同端点） | ✅ | 浏览器输码 | 否 | 同上 |
| 7 | `trae` | 浏览器授权 → 本地回调 | ✅ | 浏览器登录 | 是 | `trae-oauth.ts:99,263` |
| 8 | `cline` | WorkOS 设备码轮询 | ✅ | 浏览器输码 | 否 | `cline-oauth.ts:178,230` |
| 9 | `gemini` | Google OAuth → 本地回调 | ✅ | Google 登录 | 是 | `gemini-auth.ts:4`、`gemini-oauth.ts:103` |
| 10 | `minimax` | OAuth 设备码 + PKCE | ✅ | 浏览器输码 | 否 | `minimax-oauth.ts:72,113` |
| 11 | `zcode` | 服务端中介的设备授权 + 轮询 | ✅ | 浏览器登录 | 否 | `zcode-login.ts:1-40` |
| 12 | `commandcode` | 浏览器 OAuth → 本地回调（5959 起，最多 10 个） | ✅ | 浏览器登录 | 是 | `commandcode-auth.ts:12`、`commandcode-product.ts:139` |
| 13 | `officeace` | 自助 OAuth + 轮询授权码（回调不落本机） | ✅ | 浏览器登录 | 否 | `channel-pack-rpc.ts:1552` 起 |
| 14 | `accio` | PKCE + 轮询 | ✅ | 浏览器登录 | 是 | `accio-auth.ts:321,353` |
| 15 | `accio-cn` | 同 `accio`（国内端点） | ✅ | 浏览器登录 | 是 | 同上 |
| 16 | `loomy` | 微信扫码（短信备用），本地页承载 | ⚠️ | 微信扫码 | 是 | `channel-pack-rpc.ts:1793` 起 |
| 17 | `raccoon` | 微信扫码 / 短信，本地页承载 | ✅ | 微信扫码或短信 | 是 | `channel-pack-rpc.ts:1848` 起、`raccoon-oauth.ts:116,140` |
| 18 | `monkeycode` | 粘贴 Cookie（`nebula_session`） | ❌ | 手动复制 Cookie | 否 | `channel-pack-rpc.ts:4448` |
| 19 | `orcaterm` | 粘贴 Cookie（`ot_session`） | ❌ | 手动复制 Cookie | 否 | `channel-pack-rpc.ts:4455` |
| 20 | `kuku` | 粘贴 Cookie（`BDUSS`） | ❌ | 手动复制 Cookie | 否 | `channel-pack-rpc.ts:4462` |
| 21 | `autoclaw` | 粘贴令牌 | ❌ | 手动复制令牌 | 否 | `channel-pack-rpc.ts:4469` |
| 22 | `autoclaw-intl` | 粘贴令牌 | ❌ | 手动复制令牌 | 否 | `channel-pack-rpc.ts:4476` |

统计：**一键 16 / 半自动 1 / 纯粘贴 5**。

## 2. 三种流为什么不能统一

- **设备码**（`qoder`/`qodercn`、`cline`、`minimax`、`zcode`）：插件只拿到 `verification_uri`
  与 `user_code`，不监听任何端口，因此不受本机端口冲突影响。
- **本地回调**（`codearts`、`lobsterai`、`trae`、`gemini`、`commandcode`、`accio`）：在
  `127.0.0.1` 上起一次性 HTTP 服务接授权码。`commandcode` 从 5959 起逐个试 10 个端口
  （与官方 CLI 一致，`commandcode-product.ts:139`），其余用候选端口探测。
- **轮询 token**（`buddy`/`workbuddy`、`officeace`）：浏览器授权在**上游服务端**完成，
  插件只用 `state` 或授权码轮询结果，所以不起本地端口。
- **本地页承载扫码**（`loomy`、`raccoon`）：起本地页显示二维码/短信表单，用户在页面里
  完成，插件轮询登录态。两者都不需要手抄凭据，故计入「一键」；`loomy` 的界面声明是
  `browser+sms`，会额外要求短信验证码，单独标成「半自动」。
- **粘贴**（5 个）：上游没有可脚本化的授权流，只能手工复制。

## 3. 与界面的口径一致性

`client.js` 的 `CHANNEL_PROVIDERS`（`client.js:2712` 起，22 条卡片）用 `login` 字段声明
交互形态：`browser` × 16、`browser+sms` × 1（`loomy`）、`cookie` × 3、`token` × 2。
与本表一一对应 —— 界面上的「扫码/短信」入口就是 `browser+sms`，粘贴框就是 `cookie`/`token`。

## 4. 未登录时看不看得到模型（相关开关）

- DSH 会把 `listModels` 返回空的 provider **整组隐藏**
  （`dsh-api-session-controller/lib/index.js:604` 的 `.filter(group => group.models.length > 0)`）。
- 本插件用 `providerCatalogVisible()` 做门控，见 `vendor/channel-pack/src/account-pool.ts:1306-1330`，
  开关是环境变量 **`DSH_HIDE_MODELS_WITHOUT_ACCOUNT`**：默认开启（=隐藏未登录渠道的模型），
  显式设为 `0` / `false` / `no` / `off` 时**显示**。
- 只影响「目录展示」，不影响路由：被隐藏的模型仍能 `resolveModel` 与正常收发。
- 各渠道在无凭据时能否给出模型，取决于适配器有没有静态兜底表 —— 实测清单见
  `项目文件/research/prelogin-catalog.md`。

## 5. 已知待办

| 事项 | 状态 | 说明 |
| --- | --- | --- |
| 5 个粘贴型渠道能否自动化登录 | 研究中 | 见 `项目文件/research/paste-login-feasibility.md`（GitHub 仓库 / 官方 API / 内嵌浏览器三条路） |
| 未登录展示模型列表 | 研究中 | 已有环境变量开关；是否做成设置页开关待评估，见 `项目文件/research/prelogin-catalog.md` |

## 6. 维护约定

1. 新增渠道时，在本表加行，并在 `client.js` 的 `CHANNEL_PROVIDERS` 里同步 `login` 字段；
   两者不一致会被 `scripts/channel-login-methods-test.mjs` 判红。
2. 粘贴型渠道一旦实现自动登录，必须同时：改本表、改 `client.js` 的 `login` 字段、
   从 `channel-pack-rpc.ts` 的 `ADOPTABLE_CHANNELS` 移除（否则会留下「既能粘贴、又能登录」
   的两条入口）。
