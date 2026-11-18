# client.js 代码审计报告（BUG-AUDIT）

- 对象：`临时项目/our-free-model/client.js`（6296 行，浏览器端手写 bundle，7 个设置页 tab：free / channels / saver / routing / ledger / logs / gateway）
- 方式：全文逐段精读（1–6296），对 XSS sink、事件绑定、定时器、localStorage、竞态、格式化逐项 grep + 人工验证
- 结论：**未发现🔴严重问题**；🟡 一般问题 5 条、🟢 建议 6 条，均给出真实行号与证据。

---

## 🔴 严重

**本轮未发现满足"严重"定义的问题。** 重点核验过的三类（XSS、监听器重复绑定、轮询泄漏）证据见文末「确认无误的部分」。

---

## 🟡 一般

**[🟡] client.js:2934 - Forward「应用」按钮发送 `actualPort ?? port`，用户输入的新端口被旧回写值覆盖**

- 位置：`port: draft.actualPort ?? draft.port`（2934 行），对照 LAN 分支 2979 行用的是 `draft?.port`。
- 原因/风险：`actualPort` 是后端"端口被占用时回写的实际绑定端口"（见 2871–2872 注释）。一旦发生过回写，用户在端口框里输入新值（`draft.port` 已更新），点「应用」发出的却是旧 `actualPort`，修改被静默忽略；且同一面板两条 apply 口径不一致，LAN 端口修改是生效的，容易误判成"只有主端口改不动"。
- 修复建议：发送 `draft.port`，或在 UI 上区分"当前实际端口"与"期望端口"两个字段；至少给 `actualPort ?? port` 加注释说明意图。

**[🟡] client.js:5681 - ModelPicker 在 render 期间调用含 setState 的 `loadQuota`，与自身注释声明的设计矛盾**

- 位置：`if (reading === undefined) { if (expanded) loadQuota(provider); return null }`（5681 行）；5610–5611 注释明确写着"放在 effect 里而不是渲染过程里：`loadQuota` 要 setState，render 中 setState 会自触发重渲染"。
- 原因/风险：5614–5617 的 effect 已按 `expandedProviders` 承担了同一职责；5681 这处 render 副作用依赖 `pending.current` 守卫（5570）才没有变成循环 setState。当前行为正确但属 React 反模式，且任何后来者移除守卫或调整 effect 依赖都会直接触发无限重渲染。
- 修复建议：删除 5681 处 render 内调用，统一交给 5614 的 effect（它已覆盖"展开且未查过"的集合）。

**[🟡] client.js:5946 - RoutingPage `remove` 无错误处理，`void remove(...)` 直连 onClick，失败即 unhandled rejection**

- 位置：`remove = async id => { ... await post('/combos', ...) }`（5946–5952），调用点 `onDelete: () => { if (confirm === chain.id) void remove(chain.id); else setConfirm(chain.id) }`（5992）。
- 原因/风险：`save` 有 ChainEditor.submit 的 try/catch 包裹（5751–5764），而 `remove` 裸奔：`post('/combos')` 失败（超时/400）时 promise rejection 无人接，用户连点两次"删除"后界面毫无反馈，卡片还在，控制台才见错误。与本文件 2026-11-01/2026-11-05 审计陆续补齐的"失败必须给反馈"口径（见 2947–2958、4263–4269 注释）不一致。
- 修复建议：`remove` 内 try/catch，失败走 `showToast({ tone: 'warn' })`，并在 finally 里 `setConfirm('')`。

**[🟡] client.js:4239,4254,4372,5120,5123,3049,5575 - 多个异步 loader 无 alive/generation 保护，组件卸载后 setState**

- 位置：`loadAuto`（4239）、`loadStrategy`（4254）、`loadAnomalies`（4372）、`loadGateway`（5120）、`loadRelay`（5123）、Egress 的 `revealUrl`（3049）、ModelPicker 的 `loadQuota`（5575–5579）等。
- 原因/风险：fetch 返回时组件可能已随 tab 切换卸载（本文件其他 loader 都有 `alive` 标志或 generation ref，如 2731/2881/5275/3686/4295）。React 18 对卸载后 setState 只是静默无操作，无内存泄漏（闭包随后可回收），但违背了文件自身一致采用的保护风格，且 Egress `revealUrl` 里 `setUrlValue(await readUrl())` 在快速切换 tab 后会把值写进已卸载组件。
- 修复建议：低优先级统一收口——给这几个 loader 套 `useEffect` 内的 `alive` 模式，或抽一个 `useSafeState`。

**[🟡] client.js:2890,3058 - `setCopied` 的 1600ms setTimeout 无清理（对照 CopyButton 5321–5325 有清理）**

- 位置：`setTimeout(() => setCopied(''), 1600)`（Forward 2890、Egress 3058），无 cleanup，组件卸载后仍执行 setState。
- 原因/风险：与上条同类；同文件 `CopyButton`（5321–5325）对同样的"复制成功提示"已用带清理的 `useEffect`，三处口径不一。
- 修复建议：复用 `CopyButton`，或把这两处也改成 effect + cleanup。

**[🟡] client.js:6028 - bench 结果插值 `{ttft}` 无 undefined 兜底，可能渲染 "undefined ms"**

- 位置：`t('bench.result').replace('{ttft}', result.ttftMs).replace('{tps}', result.tokensPerSecond ?? '—').replace('{reasoning}', result.reasoningTokens ?? '—')`（6028）。
- 原因/风险：同一行里 `tokensPerSecond`、`reasoningTokens` 都有 `?? '—'`，唯独 `ttftMs` 没有；后端半途返回/字段缺失时按钮结果会显示字面 "undefined"。
- 修复建议：补 `result.ttftMs ?? '—'`。

**[🟡] client.js:4542-4568 - AnomalyPanel 的 `absolute`/`remaining` 对无效时间戳无 isFinite 防护**

- 位置：`absolute(row.resetAtMs)`（4542–4548、4630）、`remaining(row.resetAtMs)`（4556–4568、4632）。
- 原因/风险：`resetAtMs` 为 `undefined`/字符串时 `new Date(NaN)` 不抛错，`getHours()` 返回 NaN，`padStart` 产出 `"aN:aN"`、剩余时长产出 `"NaN天NaN小时"` 级别的乱码直接上屏（文件内其他时间处理如 `remainingText`/`expiryText` 3318/3330 有 `Number.isFinite` 前置检查，此处漏了）。
- 修复建议：入口处 `Number.isFinite(row.resetAtMs)` 不通过则整行按"—"渲染。

---

## 🟢 建议

**[🟢] client.js:2942-2958,2989-3007,5165-5172,5204-5212 - "密钥显示/复制/轮换"行重复实现 4 次**

- 原因/风险：Forward 主转发、Forward LAN、GatewayPage 网关 key、relay key 四处几乎同构（`<code>` 掩码 + show/hide + copy + rotate），文案键都一致。已有 `CopyButton`（5318）却未复用，改一处文案/交互要同步四处。
- 修复建议：抽 `SecretRow({ label, value, shown, onToggle, onCopy, onRotate })`。

**[🟢] client.js:4178-4212 - autoclaw 短信 send/verify 两个 onClick 同构，可提取**

- 原因/风险：两个按钮的 fetch + 15s 超时 + json 容错 + `setSmsMessage` 结构完全相同，仅 URL/body/成功分支不同。
- 修复建议：抽 `postAutoclaw(flowId, path, body)`。

**[🟢] client.js:4956,5056,5153,5185,5457,5858,6039 等 - 错误横幅 `ofm_callout ofm_error` 模式散落 7+ 处**

- 原因/风险：`h('div', { className: 'ofm_callout ofm_error' }, h('div', null, ...))` 反复手写；已有 `PanelError`（5308）但只服务面板态。
- 修复建议：抽一个 `ErrorCallout({ text })`。

**[🟢] client.js:2098 之外 - 轮询周期/UI 定时常量未像 RPC_TIMEOUT 一样集中命名**

- 位置：15s（2917、3035）、45s（4340、4378）、90s（3721–3723）、60s（2734）、10s（5037）、3s（3510）、2.5s（3562）、1s（3406）、500ms（3292）、4000ms 重试（4319）、1600ms（2890/3058）、1400ms（5323）、4000ms notice（3622）、holdMs 默认 10000（2352）等。
- 原因/风险：`RPC_TIMEOUT`（2098）已把 RPC 超时收敛并注释了取值依据，但 setInterval 周期仍以魔法数字散落；调整"渠道页轮询节奏"需要全文件搜索。
- 修复建议：仿 RPC_TIMEOUT 建 `POLL = { transport: 500, login: 3000, ... }` 一张表。

**[🟢] client.js:3199 - `ACCOUNT_STICKY_LIMIT` 已成死常量**

- 位置：`const ACCOUNT_STICKY_LIMIT = 10`（3199），全文件仅 4440 行 JSDoc `{@link ACCOUNT_STICKY_LIMIT}` 引用它，无实际代码使用（策略切换 4458 特意不传 stickyLimit）。
- 原因/风险：保留它会让后来者误以为前端仍负责写这个值（3193–3198 注释还要求"与后端必须是同一个数"），实际该职责已完全移交后端。
- 修复建议：删除常量，注释改为文字说明。

**[🟢] client.js:4939 - LedgerPage 的 `entries` 变量未使用**

- 位置：`const entries = ledger.snapshot?.entries ?? []`（4939），LedgerPage 后续（4940–5025）无引用；LogsPage 5041 另有自己的同名变量。
- 原因/风险：死代码，且它会在 LedgerPage 每次渲染白取一份 400 条明细数组的引用。
- 修复建议：删除该行。

**[🟢] client.js:6078-6085 - Shell 标签页 glider 只在 tab/locale 变化时测量，窗口 resize / 字体加载后错位**

- 位置：`useEffect(... setGlider({left: node.offsetLeft, ...}), [tab, t.locale])`。
- 原因/风险：胶囊高亮背景按首次测量定位，窗口宽度变化导致 tab 换行/移位后，glider 停在旧坐标，视觉与激活项分离，直到下次切 tab 才校正。
- 修复建议：监听 `resize`（或 ResizeObserver on the nav）重新测量。

**[🟢] client.js:4133,4166,4174 - 表单控件 onInput 与全文件 onChange 惯例混用**

- 位置：Loomy 手机号/autoclaw 手机号与验证码输入框用 `onInput`，其余全部输入框用 `onChange`。React 下两者行为等价，仅一致性/可读性问题。
- 修复建议：统一为 `onChange`。

---

## 确认无误的部分

**1) XSS：未发现任何注入点，sanitize 链完整且被一致使用**

- 全文件 **零** `innerHTML` / `insertAdjacentHTML` / `outerHTML` 赋值，也无 `dangerouslySetInnerHTML`、`document.write`、`eval`、`new Function`（grep 验证，唯一命中是 2216 行 sanitizeStyle 里对 `javascript:` 的**拦截**正则）。
- 公告 HTML 只进自研 tokenizer：`ALLOWED_TAGS` 白名单 47 个标签（2188）、`DROP_CONTENT_TAGS` 整体丢弃 script/style/iframe/svg/math 等 24 类（2190）、节点上限 4000（2192/2271）、属性再过 `sanitizeAttrs`（2222–2253）——只放行 style/href/src/title/alt/width/height，且 `a[href]` 经 `safeUrl`（仅 http(s)/mailto/#，2197–2206）并强制 `target=_blank` + `rel="noopener noreferrer"`（2238–2239）；`img[src]` 额外允许的 data URL 锁死 `png|jpe?g|gif|webp` 与 base64 字符集（2204），SVG/参数注入进不来；`style` 经 `sanitizeStyle` 白名单 5 个属性 + 黑名单 `url(|expression|javascript:|@|<|>`（2208–2220）。未闭合标签 unwrap、闭合标签栈匹配（2284–2301）、`<script>` 内容随 skipUntil 丢弃（2286–2288）逻辑均正确。
- 消费端只有两条路：React 树（文本默认转义）或 `htmlToDom`（2324–2335）——其中 `setAttribute` 循环遍历的 props 全部产自上述白名单，`style` 走 `Object.assign(el.style, …)` 不走字符串解析。toast（2352–2405）：`body` 走 `textContent`（2375）、`html` 走 `htmlToDom(parseSafeHtml(html))`（2380）、按钮 label 走 `textContent`（2390）、title 走 `createTextNode`（2359）。`__test` 导出的四个函数（6293）与实现同一份引用，`scripts/sanitize-test.mjs` 有独立测试。**未发现绕过 sanitize 的直接拼接。**

**2) 事件监听器：无重复绑定、无泄漏**

- 全文件仅 3 处 `addEventListener`：toast 卡片内 close/action 按钮（2369、2391）——监听器挂在卡片自身元素上，`card.remove()` 后随元素一并 GC；`ofm:channels`（3746）——与 3747 的 `removeEventListener` 在同一 useEffect 中对称成对，且 deps（3748）变化时先移除再重绑，不叠加。
- 无 setInterval 内 addEventListener 的模式；DnD、点击等交互全部走 React 合成事件（props），随卸载自动清理。`ctx.slots.inject`/`ctx.effect` 的资源（style 元素 6237–6258）由 dispose 回调移除。

**3) 定时器：14 处 interval/定时全部核对，页面切换即随 React 卸载清理；45 秒 provider.status 轮询清理正确**

- 任务点名的 `provider.status` 45s 轮询：`setInterval(() => { void loadStatus(); void loadAuto() }, 45_000)`（4335–4340）在 `useEffect` cleanup `clearInterval`（4341），deps 为 `[available, loadStatus, loadAuto]`；tab 切走组件卸载即清理；`available=false` 时不建定时器（4334）。配套的失败重试 `statusRetry` setTimeout 也在同一 cleanup 里 `clearTimeout`（4328）。
- 其余逐一核对：`/stats` 60s（2732→2735 带 alive）、LAN 地址 15s（2917→2918）、outlet 15s（3035→3036）、RPC transport 探测 500ms（3292→3293 带 alive）、短信倒计时 1s（3406→3407）、login.poll 3s（3486→3511 带 alive）、Loomy 二维码 2.5s（3562→3563 带 alive）、balances 90s（3722–3724，setTimeout+setInterval 双句柄都在 cleanup 清，且 `loadBalances` 有 pending 去重 3677–3678，同秒双触发不会发两个请求）、anomalies 45s（4378→4379）、logs 自动刷新 10s（5037→5038）、CopyButton 1.4s（5323→5324）、SavingsMeter 60ms（5393→5394）、notice 4s（3622，卸载清理 3618）。`api()`/`rpc()` 的 AbortController 超时句柄均有 finally 清理（2110→2119、3300→3306）。toast 自毁定时器（2399）作用于 `document.body` 上的独立宿主，属设计内，不随 React 卸载（并做了 `unref?.()` 兜底）。

**4) localStorage：5 处读写全部有 try-catch**（3632、3637、6070、6079、6271、6273），隐私模式降级为会话内默认值，不会抛出。

**5) 竞态防护（已验证有效的地方）**：`usePanel` alive 标志（5275–5285）、balances 的 generation + pending 去重（3677–3696）、provider.status 的 generation + request 序号 + transport 一致性三重校验（4295–4310，手动刷新与 45s 轮询并发时旧响应会被 `current()` 丢弃）、startLogin 的 attempt 对象 + popup 泄漏防护（3411–3476，transport 变化/卸载都会取消并关弹窗 3576–3588）、`sameChannelTransport` 防同 transport 抖动重渲染（3258–3262、3289）。

**6) 数值格式化（主体健康）**：`kilo`（2140，`Number(value) || 0`）、`formatTokens`（3349，isFinite）、`fmtInt/fmtTokens/fmtMs/fmtTps`（4855–4873，全部 isFinite 前置）、`fmtPct`（4871，whole>0 判断）、`ago`（2147，`!ts → '—'`）、`expiryText/remainingText`（3318–3337，isFinite 且区分"未来到期"与"已过期"）、`quotaSummaryOf`（3367–3379）、`todayClaimedAmount`（3889–3897）、`CheckinPanel.formatAmount`（4673–4679）、端口输入 onBlur 校验（5198）。除上文 🟡 的 6028 与 4542–4568 两处外无 NaN/undefined 直出。

**7) 超时口径**：`api()` 统一 8s AbortController 兜底（2100–2110），慢路由按 `RPC_TIMEOUT`（2098，含取值依据注释）或显式参数放宽（`/bench` 330s：6027；`/refresh` `/reprobe` 600s：6092；`account.create` 90s：3425），autoclaw 裸 fetch 也有 15s `AbortSignal.timeout`（4186、4205）。
