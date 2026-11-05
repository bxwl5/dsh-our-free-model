# 渠道登录方式矩阵

> 一句话：15 个账号渠道里，**18 个的登录全自动完成**（浏览器/本地页/短信码/扫码，不需要手抄凭据），
> **1 个（`loomy`）在微信未绑手机号时会在弹窗内补要短信码**；纯粘贴登录形态已全部移除。本文的「一键」指：点「添加账号」后只需在浏览器内完成授权，
> 插件自己把 token 收回来，**不需要手动复制任何东西**。

## 1. 总表

| # | provider | 登录机制 | 一键 | 需人工操作 | 本地监听 | 代码证据 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `codearts` | 浏览器授权 → 本地回调收授权码（两步式） | ✅ | 浏览器登录 | 是 | `channel-pack-rpc.ts:1613` |
| 2 | `buddy` | 浏览器授权 → 轮询 token（`auth/state` 换登录页） | ✅ | 浏览器登录 | 否 | `channel-pack-rpc.ts:1481-1506`、`buddy-oauth.ts:137,178` |
| 3 | `workbuddy` | 同 `buddy`（同一实现，不同产品配置） | ✅ | 浏览器登录 | 否 | 同上 + `product.ts` 的 `WORKBUDDY` |
| 4 | `qoder` | 设备码轮询（不起本地端口） | ✅ | 浏览器点授权/选账号 | 否 | `qoder-oauth.ts:119,205` |
| 5 | `qodercn` | 同 `qoder`（同族不同端点） | ✅ | 浏览器点授权/选账号 | 否 | 同上 |
| 6 | `trae` | 浏览器授权 → 本地回调 | ✅ | 浏览器登录 | 是 | `trae-oauth.ts:99,263` |
| 7 | `cline` | WorkOS 设备码轮询 | ✅ | 浏览器点授权 | 否 | `cline-oauth.ts:178,230` |
| 8 | `antigravity` | Google OAuth → 本地回调 | ✅ | Google 登录 | 是 | `antigravity-auth.ts:4`、`antigravity-oauth.ts:103` |（原名 `gemini`，2026-11-01 改名）|
| 9 | `minimax` | OAuth 设备码 + PKCE | ✅ | 浏览器点授权 | 否 | `minimax-oauth.ts:72,113` |
| 10 | `zcode` | 服务端中介的设备授权 + 轮询 | ✅ | 浏览器登录 | 否 | `zcode-login.ts:1-40` |
| 11 | `commandcode` | 浏览器 OAuth → 本地回调（5959 起，最多 10 个） | ✅ | 浏览器登录 | 是 | `commandcode-auth.ts:12`、`commandcode-product.ts:139` |
| 12 | `officeace` | 自助 OAuth + 轮询授权码（回调不落本机） | ✅ | 浏览器登录 | 否 | `channel-pack-rpc.ts:1552` 起 |
| 13 | `loomy` | 微信扫码，本地页承载 | ⚠️ | 微信扫码（未绑手机号时补短信码） | 是 | `channel-pack-rpc.ts:1793` 起 |
| 14 | `raccoon` | 微信扫码（服务端下发 code）/ 短信，本地页承载 | ✅ | 微信扫码或短信 | 是 | `raccoon-login-page.ts`、`raccoon-oauth.ts` 的 `/api/iam/v1` 函数 |
| 15 | `autoclaw` | 手机号 + 短信验证码，**卡片内嵌表单**（2026-10-30，无本地页） | ✅ | 输手机号 + 验证码 | 否 | `autoclaw-login-page.ts`、`autoclaw-sms.ts` |

统计：**一键 14 / 半自动 1 / 纯粘贴 0**（共 15 个渠道；2026-11-05 移除 monkeycode/kuku/accio/accio-cn，深夜追加移除 orcaterm）。

## 2. 三种流为什么不能统一

- **设备码**（`qoder`/`qodercn`、`cline`、`minimax`、`zcode`）：插件只拿到 `verification_uri`
  与 `user_code`，不监听任何端口，因此不受本机端口冲突影响。
- **本地回调**（`codearts`、`trae`、`antigravity`、`commandcode`）：在
  `127.0.0.1` 上起一次性 HTTP 服务接授权码。`commandcode` 从 5959 起逐个试 10 个端口
  其余用候选端口探测（`codearts` 只认 `code`，旧 ticket 轮询兜底已于 2026-10-29 删除），
  `antigravity` 的端口是动态 0（不是固定 8845）。
- **轮询 token**（`buddy`/`workbuddy`、`officeace`）：浏览器授权在**上游服务端**完成，
  插件只用 `state` 或授权码轮询结果，所以不起本地端口。
  （`account.adopt` 的粘贴表与代码口径一致：只剩 OrcaTerm）。
- **本地页承载扫码/短信**（`loomy`、`raccoon`）：起本地页显示二维码或短信表单，
  用户在页面里完成，插件轮询登录态；对外统一返回 `loginUrl`，前端无需改动。都不需要手抄
  凭据，故计入「一键」；`loomy` 的界面声明是 `browser+sms`，**仅当该微信账号未绑手机号时**
  弹窗内会补要手机号 + 短信码（面板本身不渲染短信表单），因此单独标成「半自动」。
- **卡片内嵌登录**（`autoclaw`，2026-10-30）：本地页已删——远程浏览器
  （DSH 在 NAS、浏览器在 PC）打不开 127.0.0.1 本地页，登录必败。现改为 `account.create`
  直接回 `flowId`，短信表单直接渲染在渠道卡片里，
  经 DSH 路由 `/api/channel-pack/login/...` 驱动；成功/失败仍由 `login.poll` 收尾，
  前端类型契约不变。

## 3. 与界面的口径一致性

`client.js` 的 `CHANNEL_PROVIDERS`（`client.js:3230` 起，15 条卡片）用 `login` 字段声明
交互形态：`browser` × 14、`browser+sms` × 1（`loomy`）；纯粘贴（`cookie`/`token`）
已全部移除，`account.adopt` 全量拒绝。

## 4. 未登录时看不看得到模型（两层区分）

**结论：没登录账号的渠道不进「系统模型候选」，但「设置页」照常能看到它的模型。**

机制：DSH 会把 `listModels` 返回空的 provider **整组隐藏**
（`dsh-api-session-controller/lib/index.js:604` 的 `.filter(group => group.models.length > 0)`）。
插件里两条路径刻意分开：

| 路径 | 方法 | 是否门控 | 未登录时 |
| --- | --- | --- | --- |
| 系统模型候选（对话框的选择器） | 适配器 `listModels()` → `providerCatalogVisible()` | **是** | 返回 `[]` → 整组不进候选 |
| 设置页（渠道卡片的模型列表 / 模型数） | `model.list` / `provider.status` → `listAllModels()` | **否** | 照常显示（模型数、模型开关都在） |

开关是环境变量 **`DSH_HIDE_MODELS_WITHOUT_ACCOUNT`**：**默认开启（=隐藏）**，
只有显式假值（`0` / `false` / `no` / `off`）才允许在候选里预览未登录渠道。

实测（2026-10-24，离线挂载发布态 `pack.js`，无凭据、fetch 全失败）：

| 开关 | 候选里的结果 |
| --- | --- |
| 默认 | 15 个账号渠道的 `listModels` **全部 0 条**；只有插件自带的免密车道兜底 **8 条**（`src/core/runtime.js:15-19`） |
| `=0` | **22/22** 渠道可见（合计 165 条，离线兜底下限） |

**登录后会刷新**：适配器的远端目录只在**拉取成功**时写缓存（`cline-adapter.ts` 的
`if (!gotRemote) return false`、`buddy-adapter.ts` 的 `models.length === 0` 早退），
未登录时只播报静态兜底表、不写缓存 —— 所以登录后下一次取目录会带凭据重新拉，渠道随即进入候选。

两个必须知道的边界：

1. **`zcode`**：它的 `listModels` 先过 `ready()` 凭据判定；未就绪时走静态 `fallbackModels`
   （仅在 `=0` 预览时可见）—— 与其他渠道行为一致，不再是例外。
2. **`cline` 有无凭据保护**：未登录时只播报静态兜底表、**不发远端请求**（否则
   `models.dev` + recommended-models 各 20 s，首屏会白等）。其余渠道无凭据即短路。

其它事实：

- 无凭据对话会抛 `MISSING_CREDENTIAL`，但不会被误标失效（`dead-model-store.ts:243-252` 忽略该码）。
- DSH 的目录条目只投影 `id/name/description/reasoning`（`index.js:578-583`），
  想在名字上加「未登录」标记只能污染 `name`，不建议。
- 2026-10-24 曾短暂把默认翻转为「显示」，同日按用户要求**恢复默认隐藏**：
  没登录的渠道在候选里点了也用不了，只会让人误判。

## 5. 已知待办（2026-10-24 研究结论）

| 事项 | 状态 | 说明 |
| --- | --- | --- |
| `autoclaw`（国内）短信登录 | **已实现，真机验证通过** | 手机号 + 验证码；2026-10-30 起为**卡片内嵌表单**（本地弹窗页已删，远程浏览器可用）：`autoclaw-login-page.ts`（流程对象）+ `autoclaw-sms.ts`（协议），驱动路由 `/api/channel-pack/login/autoclaw/*`。2026-10-24 真机换到 24h token。⚠️ 常量逆向所得，失效时该渠道暂不可用（粘贴入口已移除）。 |
| ~~`autoclaw-intl` OAuth~~ | 渠道已移除 | 2026-10-25 按用户要求整渠道删除（Z.ai OAuth loopback + 阿里滑块，自动化成本高）。 |
| 未登录展示模型列表 | **默认隐藏（已恢复原逻辑）** | 见 §4：候选里不进、设置页照常显示；`DSH_HIDE_MODELS_WITHOUT_ACCOUNT=0` 可预览；登录后自动刷新进候选。 |
| 登录失败无反馈 | **已修** | 12 个渠道原先失败只写日志；现统一 `recordLoginFailure`，`login.poll` 能拿到原因（`scripts/login-failure-reporting-test.mjs` 守卫）。 |

## 6. 维护约定

1. 新增渠道时，在本表加行，并在 `client.js` 的 `CHANNEL_PROVIDERS` 里同步 `login` 字段；
   两者不一致会被 `scripts/channel-login-methods-test.mjs` 判红。
2. 粘贴型渠道一旦实现自动登录，必须同时：改本表、改 `client.js` 的 `login` 字段、
   从 `channel-pack-rpc.ts` 的 `ADOPTABLE_CHANNELS` 移除（否则会留下「既能粘贴、又能登录」
   的两条入口）。
