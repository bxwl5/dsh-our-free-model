# 渠道登录方式矩阵

> 一句话：22 个账号渠道里，**18 个的登录全自动完成**（浏览器/本地页/短信码/扫码，不需要手抄凭据），
> **1 个（`loomy`）在微信未绑手机号时会在弹窗内补要短信码**，**3 个只能粘贴凭据**。本文的「一键」指：点「添加账号」后只需在浏览器内完成授权，
> 插件自己把 token 收回来，**不需要手动复制任何东西**。

## 1. 总表

| # | provider | 登录机制 | 一键 | 需人工操作 | 本地监听 | 代码证据 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `codearts` | 浏览器授权 → 本地回调收授权码（两步式） | ✅ | 浏览器登录 | 是 | `channel-pack-rpc.ts:1613` |
| 2 | `buddy` | 浏览器授权 → 轮询 token（`auth/state` 换登录页） | ✅ | 浏览器登录 | 否 | `channel-pack-rpc.ts:1481-1506`、`buddy-oauth.ts:137,178` |
| 3 | `workbuddy` | 同 `buddy`（同一实现，不同产品配置） | ✅ | 浏览器登录 | 否 | 同上 + `product.ts` 的 `WORKBUDDY` |
| 4 | `lobsterai` | 浏览器授权 → 本地回调（与 codearts 同款） | ✅ | 浏览器登录 | 是 | `channel-pack-rpc.ts:1651` 起 |
| 5 | `qoder` | 设备码轮询（不起本地端口） | ✅ | 浏览器点授权/选账号 | 否 | `qoder-oauth.ts:119,205` |
| 6 | `qodercn` | 同 `qoder`（同族不同端点） | ✅ | 浏览器点授权/选账号 | 否 | 同上 |
| 7 | `trae` | 浏览器授权 → 本地回调 | ✅ | 浏览器登录 | 是 | `trae-oauth.ts:99,263` |
| 8 | `cline` | WorkOS 设备码轮询 | ✅ | 浏览器点授权 | 否 | `cline-oauth.ts:178,230` |
| 9 | `gemini` | Google OAuth → 本地回调 | ✅ | Google 登录 | 是 | `gemini-auth.ts:4`、`gemini-oauth.ts:103` |
| 10 | `minimax` | OAuth 设备码 + PKCE | ✅ | 浏览器点授权 | 否 | `minimax-oauth.ts:72,113` |
| 11 | `zcode` | 服务端中介的设备授权 + 轮询 | ✅ | 浏览器登录 | 否 | `zcode-login.ts:1-40` |
| 12 | `commandcode` | 浏览器 OAuth → 本地回调（5959 起，最多 10 个） | ✅ | 浏览器登录 | 是 | `commandcode-auth.ts:12`、`commandcode-product.ts:139` |
| 13 | `officeace` | 自助 OAuth + 轮询授权码（回调不落本机） | ✅ | 浏览器登录 | 否 | `channel-pack-rpc.ts:1552` 起 |
| 14 | `accio` | PKCE + 本地回调（5960–5969）；**可改用粘贴令牌** | ✅ | 浏览器登录 | 是 | `accio-auth.ts:321,353` |
| 15 | `accio-cn` | 同 `accio`（国内端点）；**可改用粘贴令牌** | ✅ | 浏览器登录 | 是 | 同上 |
| 16 | `loomy` | 微信扫码，本地页承载 | ⚠️ | 微信扫码（未绑手机号时补短信码） | 是 | `channel-pack-rpc.ts:1793` 起 |
| 17 | `raccoon` | 微信扫码 / 短信，本地页承载 | ✅ | 微信扫码或短信 | 是 | `channel-pack-rpc.ts:1848` 起、`raccoon-oauth.ts:116,140` |
| 18 | `monkeycode` | 粘贴 Cookie（`nebula_session`） | ❌ | 手动复制 Cookie | 否 | `channel-pack-rpc.ts:4448` |
| 19 | `orcaterm` | 粘贴 Cookie（`ot_session`） | ❌ | 手动复制 Cookie | 否 | `channel-pack-rpc.ts:4455` |
| 20 | `kuku` | 百度 App 扫码，**本地弹窗页**承载 | ✅ | 手机扫码 + 确认 | 是（本地页） | `kuku-qr-login.ts`、`kuku-qr-login-page.ts` |
| 21 | `autoclaw` | 手机号 + 短信验证码，**本地弹窗页**承载 | ✅ | 输手机号 + 验证码 | 是（本地页） | `autoclaw-login-page.ts`、`autoclaw-sms.ts` |
| 22 | `autoclaw-intl` | 粘贴令牌 | ❌ | 手动复制令牌 | 否 | `channel-pack-rpc.ts:4476` |

统计：**一键 18 / 半自动 1 / 纯粘贴 3**。

## 2. 三种流为什么不能统一

- **设备码**（`qoder`/`qodercn`、`cline`、`minimax`、`zcode`）：插件只拿到 `verification_uri`
  与 `user_code`，不监听任何端口，因此不受本机端口冲突影响。
- **本地回调**（`codearts`、`lobsterai`、`trae`、`gemini`、`commandcode`、`accio`）：在
  `127.0.0.1` 上起一次性 HTTP 服务接授权码。`commandcode` 从 5959 起逐个试 10 个端口
  （与官方 CLI 一致，`commandcode-product.ts:139`），`accio` 用 5960–5969（两段有重叠），
  其余用候选端口探测。`codearts` 在 portal 回退路径上还有 ticket 轮询兜底（`login.ts:320-334`），
  `gemini` 的端口是动态 0（不是固定 8845）。
- **轮询 token**（`buddy`/`workbuddy`、`officeace`）：浏览器授权在**上游服务端**完成，
  插件只用 `state` 或授权码轮询结果，所以不起本地端口。
- **授权为主 + 粘贴兜底**（`accio`、`accio-cn`）：浏览器授权是默认路径；上游回调白名单尚未真机验证，
  卡片上额外给一个「改用粘贴令牌」入口（`account.adopt` 走 accio 自己的形状校验）。
- **本地页承载扫码/短信**（`loomy`、`raccoon`、`autoclaw`）：起本地页显示二维码或短信表单，
  用户在页面里完成，插件轮询登录态；对外统一返回 `loginUrl`，前端无需改动。都不需要手抄
  凭据，故计入「一键」；`loomy` 的界面声明是 `browser+sms`，**仅当该微信账号未绑手机号时**
  弹窗内会补要手机号 + 短信码（面板本身不渲染短信表单），因此单独标成「半自动」。
- **粘贴**（5 个）：上游没有可脚本化的授权流，只能手工复制。

## 3. 与界面的口径一致性

`client.js` 的 `CHANNEL_PROVIDERS`（`client.js:2712` 起，22 条卡片）用 `login` 字段声明
交互形态：`browser` × 16、`browser+sms` × 1（`loomy`）、`cookie` × 3、`token` × 2。
与本表一一对应 —— 界面上的「扫码/短信」入口就是 `browser+sms`，粘贴框就是 `cookie`/`token`。

## 4. 未登录时看不看得到模型（实测）

**结论：默认就能看到（2026-10-24 起），`zcode` 是唯一例外。**

机制：DSH 会把 `listModels` 返回空的 provider **整组隐藏**
（`dsh-api-session-controller/lib/index.js:604` 的 `.filter(group => group.models.length > 0)`）。
本插件用 `providerCatalogVisible()` 门控，见 `vendor/channel-pack/src/account-pool.ts:1306-1330`，
开关是环境变量 **`DSH_HIDE_MODELS_WITHOUT_ACCOUNT`**：**默认不隐藏**（未登录也展示静态模型表），
显式设 `1` / `true` / `yes` / `on` 时才恢复「未登录就隐藏」。

实测（2026-10-24，离线挂载发布态 `pack.js`，无凭据、fetch 全失败）：

| 开关 | 结果 |
| --- | --- |
| 默认 | **21/22** 渠道可见（合计 163 条，离线兜底下限）；`zcode` 仍 0 条 |
| `=1` | 22 个账号渠道的 `listModels` **全部 0 条**；未登录唯一可见的是插件自带免密车道兜底 **8 条**（`src/core/runtime.js:15-19`） |

**登录后会刷新**：适配器的远端目录只在**拉取成功**时写缓存（`cline-adapter.ts` 的
`if (!gotRemote) return false`、`buddy-adapter.ts` 的 `models.length === 0` 早退），
未登录时只播报静态兜底表、不写缓存 —— 所以登录后下一次取目录会带凭据重新拉，列表自然变全。

两个必须知道的边界：

1. **`zcode` 是例外**：它的 `listModels` 先过 `ready()` 凭据判定（`zcode-adapter.ts:441`），
   未登录时无论开关如何都是 0 条 —— 不要承诺「默认就全显示」。
2. **`cline` 已做无凭据保护**：未登录时只播报静态兜底表、**不发远端请求**（否则
   `models.dev` + recommended-models 各 20 s，首屏会白等）。其余渠道无凭据即短路。

其它实测事实：

- 无凭据仍有模型的渠道共 **21 个**：12 个根本没装远端目录、9 个 fetcher 无凭据即短路。
- **设置页与对话框口径已经分裂**：13 个渠道（有 `listAllModels`、不过门控）未登录在设置页
  就能看到模型（合计 150 条），另 9 个看不到。
- 无凭据对话会抛 `MISSING_CREDENTIAL`，但不会被误标失效（`dead-model-store.ts:243-252` 忽略该码）。
- DSH 的目录条目只投影 `id/name/description/reasoning`（`index.js:578-583`），
  想在名字上加「未登录」标记只能污染 `name`，不建议。

**落地选项**（风险由低到高）：

| 方案 | 改动 | 风险 |
| --- | --- | --- |
| A 仅文档 | 0 代码，只写清开关与例外 | 无（**当前已采用默认显示**） |
| B 设置页加「未登录也显示（预览）」开关，默认关 | 手写约 250–300 行；关键是预览态把 `fetchRemoteModels` 包成 `[]` 以避开 `cline` 的 20 s×2；需重建产物 | 中（发布内容） |
| C 默认显示 + 名字标记 | 同 B + 默认值翻转 | 高（与「未登录隐藏」原需求冲突，且污染模型名） |

## 5. 已知待办（2026-10-24 研究结论）

| 事项 | 状态 | 说明 |
| --- | --- | --- |
| `autoclaw`（国内）短信登录 | **已实现，真机验证通过** | 手机号 + 验证码，**本地弹窗页**承载（范式照 `raccoon`）：`autoclaw-login-page.ts` + `autoclaw-sms.ts`，对外仍返回 `loginUrl`，前端走既有两步式 → **客户端零改动**。2026-10-24 真机换到 24h token。⚠️ 常量逆向所得，失效时该渠道暂不可用（粘贴入口已移除）。 |
| `kuku` 扫码登录 | **已实现** | 百度 passport 扫码：`kuku-qr-login.ts`（协议）+ `kuku-qr-login-page.ts`（本地页 + 长轮询）。两个只有真连才暴露的坑已修：`/channel/unicast` 是**长轮询**（未扫码约 30s 才回，需 45s 超时）；`bdusslogin` **成功响应没有 errno**（写 `errno===0` 会判失败每次真登录）。 |
| `autoclaw-intl` OAuth | 可行但工作量大 | Z.ai OAuth loopback（端口白名单 18432/19654/19723/53699）+ 阿里滑块；国际账号无手机号，短信路不通（仍走粘贴）。 |
| `orcaterm` 书签收号 | 半自动，待实测 | `ot_session` 非 HttpOnly，用户在已登录页点一次书签回传；未知项是 https 页 → `http://127.0.0.1` 的 PNA/混合内容限制。 |
| `monkeycode` | 维持粘贴 | 设备码 client_id 写死 `monkeyai-runtime`、scope 仅 `device:*`；会话 Cookie HttpOnly ⇒ 内嵌浏览器也取不到。 |
| 未登录展示模型列表 | **已改为默认显示** | 见 §4：默认展示静态模型表、登录后刷新；`DSH_HIDE_MODELS_WITHOUT_ACCOUNT=1` 才隐藏；`zcode` 例外。 |
| 登录失败无反馈 | **已修** | 12 个渠道原先失败只写日志；现统一 `recordLoginFailure`，`login.poll` 能拿到原因（`scripts/login-failure-reporting-test.mjs` 守卫）。 |

## 6. 维护约定

1. 新增渠道时，在本表加行，并在 `client.js` 的 `CHANNEL_PROVIDERS` 里同步 `login` 字段；
   两者不一致会被 `scripts/channel-login-methods-test.mjs` 判红。
2. 粘贴型渠道一旦实现自动登录，必须同时：改本表、改 `client.js` 的 `login` 字段、
   从 `channel-pack-rpc.ts` 的 `ADOPTABLE_CHANNELS` 移除（否则会留下「既能粘贴、又能登录」
   的两条入口）。
