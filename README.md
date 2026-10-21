<div align="center">
  <img src="icon.svg" alt="Our Free Model — DeepSeek Harness 免费模型插件" width="120">

# dsh-our-free-model

**简体中文** | [English](README_EN.md)

  <img alt="许可证" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square">
  <img alt="零依赖" src="https://img.shields.io/badge/dependencies-zero-4b6fff?style=flat-square">
  <img alt="无构建步骤" src="https://img.shields.io/badge/build%20step-none-7da1de?style=flat-square">
  <img alt="适配内核" src="https://img.shields.io/badge/dsh-0.1.5--0.1.7--rc.2-2f6f4f?style=flat-square">
  <img alt="状态" src="https://img.shields.io/badge/status-beta-f0a441?style=flat-square">

</div>

<div align="center">

> 装上这个插件即可使用：无需登录、注册、填 API Key。
> 模型清单跟随上游刷新，可用性由本机网络出口实测得出。
> 另附一个 OpenAI / Anthropic 兼容的本地网关与局域网转发。

</div>

---

## 特性

- **开箱即用**——不需要账号、Key或申请配额。
- **两个免密车道**——匿名免费车道（OpenCode Zen 网关）与 Kilo 免费池（Kilo AI 公共网关），均直连、不经第三方中转。
- **十三个账号渠道**——CodeArts、CodeBuddy / WorkBuddy、LobsterAI、Qoder / Qoder 中国版、TRAE、Cline、Loomy、Raccoon、MiniMax Code、ZCode、Gemini 等，开箱即用；凭据只写入宿主凭据库。
- **清单跟随上游**——模型集合、上下文长度与能力每次刷新重新拉取，插件内不保存静态快照。
- **选择器只广播可用模型**——上游声明但网关明确拒绝路由的模型从下拉框移除，仅在设置页保留记录并注明拒因；网关自身故障（5xx）、配额限制（429）、超时与断网不视为对模型的判定。
- **思考强度实际生效**——声明了思考档位的模型给出它自己的档位菜单（Off / Low / High / Max 等），选中值按原值下发到上游 `reasoning_effort`；其余模型走预算阶梯（Light / Balanced / Deep）。两者都逐次调用留痕。
- **按响应体形状判定流式响应**——网关在高负载下会以 `application/json` 的 content-type 返回完整 SSE 帧序列；插件按响应体形状分流，不会因此把可用模型判为不可用。
- **省 Token**——工具输出压缩（git diff / grep / 构建日志等）在请求发出前就地重写；提示词瘦身两族默认全关；另有五个不占用上游请求的本地应答。
- **路由（降级链）**——把任意车道的模型串成命名链，以 `combo:<name>` 作为虚拟模型出现在选择器与网关上，支持 `fallback` 与 `round-robin`。
- **本地网关**——`/v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1/messages/count_tokens`、`/v1/models`，带 Key 鉴权与局域网转发中继。
- **用量看板**——Token 热力图、总量曲线、输出速度与首字延迟逐次采样，数据全部留在本机。
- **不依赖浏览器界面**——仅将 llm 作为硬依赖，在 dsh-tui 等无 web server 的 composition 中同样完成启动并输出模型。

## 安装

> **⚠️ 不要通过 npm 安装。** npm 上的同名包不是本仓库发布的，内容与本仓库不一致。请只按本文方式安装：本地源码目录，或本仓库 Release 的 tarball。

**命令行（纯 dsh web）**

```
dsh plugin --profile web add /绝对路径/dsh-our-free-model
```

安装完成后重启应用一次，`--profile` 填写实际使用的 profile 名称。

**以真实目录手工安装（tarball）**

1. 创建 `<DSH_HOME>/profiles/<profile>/vendor/`，在审核过的本仓库目录运行 `npm pack --ignore-scripts --pack-destination "<DSH_HOME>/profiles/<profile>/vendor"`。
2. 在 profile 的 `package.json` 的 dependencies 中加入 `"dsh-our-free-model": "file:./vendor/dsh-our-free-model-2.5.7-priv.1.tgz"`。文件名版本跟随仓库 `package.json`。
3. 在 `dsh.profile.bundles` 末尾追加 `"dsh-our-free-model"`。

手工复制发布文件时必须复制完整包，包括 `adapter/`、`src/`、`locale/` 和 `vendor/channel-pack/`；只复制入口脚本会导致渠道加载失败。不要再向 cordis.patch.yml 添加条目——被 bundles 引用的包，其自带 patch 层会自动生效，两处同时注册会报 duplicate loader entry。

**安装失败：`profile "desktop" is managed exclusively by the Electron application`**

桌面端（Electron）的 profile 只允许桌面应用自己管理，命令行 `dsh plugin add` 无法写入。请在桌面端的插件管理器里完成安装；命令行安装仅适用于纯 web profile。

## 使用

**选择模型**——打开输入框的模型选择器，选择 Our Free Model 分组下的任意模型。选择结果按会话持久化。

**调整思考强度**——同一菜单中的 Effort。声明了档位的模型给出自己的档位（如 Off / Low / High / Max），选中值按原值下发；其余模型给 Light / Balanced / Deep 三档。思考与可见回答共享同一输出额度，因此思考不可关闭的模型会将三档整体上移（模型卡上标注了每档实际数值）。

**供本机其它工具调用**——设置 → Our Free Model → 本地转发，启用后复制 base URL 并生成 Key。支持：

- `GET /v1/models`
- `POST /v1/chat/completions`（流式与非流式）
- `POST /v1/responses`
- `POST /v1/messages`（流式与非流式，Anthropic Messages）
- `POST /v1/messages/count_tokens`（本地估算）

端口被占用时插件不会静默失效：先在同一端口重试数轮，仍被占用则顺延至下一个可用端口，并在设置页标注实际端口。

**供同一网络中的其它设备使用**——同一面板下方的"局域网访问"，默认关闭；启用后中继绑定可路由地址并要求使用独立的局域网 Key（与本机 Key 互不通用）。启用期间任何能够访问该主机的用户均可使用此 Key 消耗本机额度，请仅在可信网络中启用。

**重新核对地区**——点击"重新探测可用性"按当前出口重新探测。切换 VPN 后再执行一次，地区受限模型会在分组之间自动迁移。

## 设置页

七个页面，入口在 设置 → Our Free Model：

| 页面 | 内容 |
| --- | --- |
| 免费模型 | 模型清单与可用性、能力、各思考档位实际下发的输出上限、实测首字延迟、单次调用基准测试 |
| 渠道接入 | 十三个渠道卡：登录、账号池、模型开关、每日积分领取 |
| 省 Token | 压缩开关、两族提示词档位、五个本地应答与节省统计 |
| 路由 | 降级链编辑器 |
| 数据看板 | Token 消耗、平均生成速度、成功率、账号透视与模型性能表 |
| 运行日志 | 逐请求明细：结果、耗时、首字、速度、Token 细分 |
| 网关设置 | 网关开关/端点/密钥、局域网转发、接入客户端配方 |

## 实现结构

```
index.js            Host 半身：适配器注册、清单与可用性探测、存储、路由、转发端口
adapter/            内核接缝：全包唯一允许 import @deepseek-ai/* 的位置
client.js           浏览器半身：手写 ModuleLoader bundle，无构建步骤
src/adapter.js      结构性 LlmAdapter：providerInfo、listModels、resolveModel、stream
src/upstream.js     网关身份：凭据、session/request id 铸造、按线协议选端点
src/stream.js       三种线协议解码归一为 harness StreamChunk
src/messages.js     harness 消息 -> 各线协议形态，外加工具调用配对修复
src/effort.js       思考档位 -> 输出预算
src/forward.js      独立的 OpenAI 兼容监听器（另含 Anthropic Messages 端点）
src/kilo.js         Kilo 免费池渠道
src/channel.js      十三个账号渠道的公共骨架
src/combos.js       降级链：虚拟清单行、两种策略、容量取交集
src/recovery.js     长思考截断后的有界自动恢复
src/token-saver/    压缩管线：提示词注入 -> 工具输出压缩，失败开放
src/route/          全车道统一的失败词汇与冷却策略
src/trust.js        插件路由的请求信任围栏
```

### 几个值得了解的架构决定

**一个适配器，多条 provider 路由。** harness 的模型选择器严格按 provider 路由分组，而清单的线格式中不存在 group / tag / badge 字段。因此要呈现独立的 region-limited 标题，唯一方式是再注册一条路由；客户端会丢弃空分组，一旦地区限制解除，两个分组会自动合并为一个。

**以结构化方式实现适配器，不 import @deepseek-ai/dsh-llm。** 内核从不执行 instanceof 检查，因此鸭子类型即可满足。这使插件不必将依赖固定在特定内核版本上，也是同一份代码能同时运行于 0.1.5 与 0.1.7 的原因。

**使用自有 JSON 存储，不接入 settings seam。** settings 注册 API 在两版内核间不一致；私有 JSON 存储行为一致，且转发 Key 存放于 0600 权限文件中，不进入任何共享设置文档。

**Token 压缩跑在唯一收口上，且失败开放。** 提示词注入与工具输出压缩在 payload 完成全部改写之后执行，收口在 `payloadFor()`：适配器自己的派发与本地网关（它同样经适配器发起）都从这唯一一处经过。每一步都失败开放——压缩器抛错就跳过，过滤器抛错就原样放行，一个请求绝不能因为一个"本来是为了让它更便宜"的环节而失败。

**combo 是一条虚拟清单行，降级在适配器里解析。** 链路以 `channel:'combo'` 加一串真实模型 id 并入合并后的清单，因此选择器照常广播它、本地网关照常按名调用它；链的展开与推进判定发生在适配器的 `runStream()` 内，两个调用方都不必知道降级这件事。

## 三个实际消耗过调试时间的内核行为

**providerRetryPolicy() 会被原样保存并使用。** 两版内核均不解析其返回值，而退避调度器读取的是顶层的 initialDelayMs / maxDelayMs / jitterRatio。将这三项嵌套在 `backoff:{}` 中，调度器读到 undefined，于是 `undefined * 2ⁿ = NaN`，而持久会话日志会直接拒绝非有限数值——一个本可恢复的瞬时故障因此导致整轮对话报废。应返回已解析完毕的扁平策略。

**一次被中断的工具调用会永久污染该会话。** 缺少对应结果的工具调用在重放时，上游返回 400 invalid_request_error，此后该会话中的每一次请求都会失败。本插件在发送前修复配对，三种线协议共用同一处修复逻辑。

**未在 inject 中声明的服务，属性直读会抛错（与返回 undefined 不同）。** 将 inject 缩减为仅剩 llm 之后，`typeof ctx.interval === 'function'` 直接抛出错误，插件在所有 composition 中均不再激活；改用 `ctx.get('webServer')` 后返回 undefined——原因不在于缺少 web server，而在于插件先于 web 半身加载。正确做法是 `ctx.inject(deps, callback)`：为所需服务开启一条独立的 fiber 使其待命。

## 已知边界

"不限量"指不存在额度体系：无需充值、不按 token 计费。但该车道按 session 统计速率，短时间内打满会返回 429，插件将该模型标记为"已达限额"，不做隐藏，下一轮探测自动恢复。

部分模型上游本身延迟较高（曾实测首字延迟超过 30 秒）；此为上游延迟，看板会如实显示。

输出速度有时会显示 —：答案集中在一两个大帧中落地、或思考过程根本不流式返回的模型，不存在可用于计算的时间窗。看板宁可留空，也不会将"思考耗时"计入"输出速度"。

思考过程为静默等待，且与正文共享输出预算。实测部分模型可在思考阶段静默 60–70 秒，期间上游计费但不发送任何思考帧；此类回合会以 stop 收尾而正文为空。转发端点与局域网中继通过心跳保持连接，但心跳维持的是连接，不能解决超时问题：链路的空闲看门狗仅在读到真实内容帧时重置。预算只能由调用方给出：将单次输出上限提升，或改用模型卡中标注 `reasoning: false` 的模型。

自动恢复存在次数、时间与上下文边界：仅恢复纯思考 EOF 与纯思考空停，最多追加一次请求；已输出正文、工具调用、用户取消与明确错误不触发恢复。缺失 usage 时的用量仅为已知部分。

能力标注以探测可证明者为限。公开清单与实测均无法取得证据的，不予标注。

源码为明文 JavaScript。作为本地插件必须如此——请将其视为该分发形态的固有属性，混淆无法解决该问题。

## 上游是哪些源

两条公开免密来源，均直连、不经任何第三方中转。

**免费车道：OpenCode 的免密网关 `https://opencode.ai/inference/v1/*`**

| 用途 | 目标 | 携带何种凭据 |
| --- | --- | --- |
| 推理请求 | `POST …/inference/v1/chat/completions`、`…/responses`、`…/messages`（按模型分流） | `Authorization: Bearer public`——该车道本身即为公开免密额度 |
| 模型清单 | `GET …/inference/v1/models` | 同上 |
| 出口地区判定 | api.ipify.org / ipinfo.io / ipapi.co，仅读取本机公网 IP 与国家码 | 无 |

**Kilo 渠道：Kilo AI 的公共网关 `https://api.kilo.ai/api/gateway`**

| 用途 | 目标 | 携带何种凭据 |
| --- | --- | --- |
| 推理请求 | `POST …/api/gateway/chat/completions`（SSE 流式） | **无**——免费池（`isFree: true`，含 `kilo-auto/free` 自动路由）不需账号、Key 或登录态 |
| 模型清单 | `GET …/api/gateway/models` | 无 |

关于隐私与信任：没有号池、没有中转。上表即为本插件全部出网目标；`npm test` 的离线套件完全不出网，仅 `host-selftest.mjs` 与 `scripts/probes/` 会主动请求这些地址，且需手动运行。

你的 prompt、工具结果与随附图像会作为正常推理请求发送至所选模型对应的上游——与调用任何模型 API 相同。除此之外插件不上传任何内容：用量看板数据、设置、转发 Key 均只落在本机 `DSH_HOME/our-free-model/`。

**Kilo 免费池在其模型卡中明确声明：prompt 可能被上游提供方记录，并用于改进其服务**——请勿发送敏感内容。模型集合与额度政策由上游决定，随时可能变更；插件仅能如实将不可用的模型从选择器中移除。

## 免责声明

- **本插件是一个客户端，不是模型服务方。** 所有模型响应均由上述第三方上游生成并传输；插件不托管、不修改、不过滤任何模型输出。模型可能产出错误、过时或有偏颇的内容，请自行核实后再使用。
- **免费不等于无限，也不等于私有。** 免费额度由上游单方面提供，随时可能限流、收费或下线；Kilo 免费池明确声明 prompt 可能被上游记录。**请勿通过本插件的免费车道发送密码、密钥、个人身份信息、商业机密或任何你不愿第三方处理的内容**；生产与敏感场景请使用你自己的付费 API。
- **上游条款由你遵守。** 使用各渠道即表示你同意对应上游的服务条款与用量政策；因违反上游政策导致的限流、封禁或其它后果由使用者自行承担。
- **本插件与上述任何上游厂商无隶属或背书关系。** 各厂商名称与商标归其各自所有者所有，仅在说明来源时引用。

## 安全与隐私

所有状态写入 `DSH_HOME/our-free-model/`；用量与设置仅落在本机，不上传至任何位置。

转发监听仅绑定回环地址，默认 127.0.0.1，无 Key 请求一律拒绝。将地址改为可路由接口会被直接拒绝（`POST /settings` 返回 400）——该端口的流量消耗的是本机这条免密车道，不应由一个字符串决定是否向整个子网开放。绑定前先经 DNS 解析并要求结果全为回环，避免 hosts 文件把 localhost 指向可路由接口。

局域网访问是另开的一扇门，并不放宽上述规则：本机监听仍只绑回环、修改地址仍被拒绝；需要跨机器使用时必须显式启用，中继绑定可路由地址，且每个请求都需携带局域网 Key——连 `/`、`/health` 这类存活探针也一并鉴权。中继仅转发 `/v1/*` 下五条白名单路径，不代理任意 loopback 服务；入口处将局域网 Key 换为本机 Key，两把 Key 互不通用；携带跳数标记的请求直接拒绝，因此端口即使配置为本机监听的同一端口也不会自环。

转发 Key 由 crypto 运行时生成、以 `timingSafeEqual` 比对、存放于 0600 权限文件中。本仓库不含任何硬编码凭据。

插件的 HTTP 路由带请求信任围栏：插件的 `/api/our-free-model` 前缀在 webServer 的最长前缀分发下优先于内核 `/api`，曾绕过内核鉴权。当前每个请求先经由 composition 的 connection 服务准入（与内核 `/api` 完全同级的 cookie/token 校验）；connection 缺失的 composition 退回结构化围栏——loopback Host、拒绝跨站 `sec-fetch-site`、Origin/Referer 必须与 Host 同源同端口（fail closed）。

卸载只需移除 bundle 条目，插件不留任何补丁；其数据目录为纯 JSON，可直接删除。

## 开发

```
npm test                     # 全部离线套件 + 清单一致性检查，一条命令
node scripts/client-lint.mjs # 浏览器半身：文案键与样式键双向覆盖、bundle 可执行
```

需要 Node ^22.19.0 || >=24.0.0。无安装步骤、无依赖。

```
npm run typecheck # tsc --noEmit，严格检查 adapter/ 接缝（可选：需要 typescript）
```

## 许可证

MIT，见 LICENSE。

本项目为独立插件，与任何模型提供方无隶属、认可或赞助关系。使用该插件访问免费额度受各提供方自身条款约束。
