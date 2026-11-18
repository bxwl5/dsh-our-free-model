# 任务 0：全仓库 Bug 审计（合并报告）

日期：2026-11-19
审计方式：5 个并行审计代理（网络转发层 / 核心运行时 / 适配器与外围 / 浏览器端 / standalone 管理面），覆盖 index.js、src/**（含 core）、adapter/、client.js、packages/standalone/**、vendor/channel-pack 关键文件，共约 1.9 万行。所有结论均由代理「先读代码验证 + 关键项 Node 最小复现实证」后落笔，本文件为合并视图；逐条详情与「确认无误的部分」见各分报告。

## 统计总览

| 级别 | 数量 | 说明 |
|---|---|---|
| 🔴 严重 | **7** | 上线必炸 / 静默丢功能 |
| 🟡 一般 | **37** | 概率性故障 / 可维护性隐患 |
| 🟢 建议 | 19+ | 性能与坏味道（各分报告 §🟢） |

## 🔴 严重问题清单（7 项）

### [🔴] src/egress.js:232-233 - `close()` 引用块外变量 `dir`，凭据文件清理静默失效
- **原因**：`const dir = path.join(dataDir, 'egress')` 声明在 `if/else` 的 **else 分支**（subscription 模式，行 151）；`close()` 定义在函数体顶层（行 225，handle 对象字面量内），两者**不同块**。client 模式（用户直接填 http 代理）下 else 块从未执行，`path.join(dir, …)` 抛 `ReferenceError: dir is not defined`，被 `try { … } catch { /* best-effort */ }` **静默吞掉**。
- **验证**：真实调用 `startEgressRelay({config: () => ({mode:'client', …})}).close()` 无异常但清理未执行；同构最小复现确认 ReferenceError 被 catch 吞。
- **风险**：「2026-11-08 终审 R13」承诺的凭据文件清理（mihomo.yaml 含订阅 URL bearer 凭据）在 client 模式下**从未生效且无声**。subscription 模式（主流）不受影响（dir 已初始化）。另 client 模式本不落盘 mihomo.yaml，实际泄漏为零——但代码意图（两模式都清理）与事实不符，且错误不可观测。
- **修复建议**：把 `dir` 提升到 if/else 之前的函数体顶层声明（`let dir = path.join(dataDir, 'egress')`），或 close 内改为调用句柄上记录的路径。

### [🔴] src/forward.js:694-709 - LAN 中继对「上游响应中途出错」零处理，客户端永久挂起
- **原因**：`target.on('response', upstream => …upstream.pipe(res))` 只覆盖成功路径；`response` 发出后的上游错误（ECONNRESET）发在 `upstream` 对象上，**该对象无 error/aborted 监听**，`pipe` 不转发错误也不结束下游。
- **验证**：最小复现——上游写部分响应后 `socket.destroy()`，客户端挂起 20s 直至 UND_ERR_BODY_TIMEOUT；挂监听确认 ECONNRESET 发出。
- **风险**：上游闪断 / 出口节点切换时，每个在途请求留一对永不关闭的 socket（客户端 + 中继）。
- **修复建议**：`upstream.on('error'/'aborted', …)` 中 `res.destroy()`；中继 socket 设空闲超时兜底。

### [🔴] src/http.js:333-348 - `readRemainder` 收了 `signal` 参数但从未使用，JSON 体读取无超时不可中止
- **原因**：对照同文件 `readSse`（每次读 race deadline+signal）与 `headRead`（有 watchdog），唯独 `postStreamed` JSON 分支进入 `readRemainder` 后完全脱离中止机制（`reader.read()` 循环既不 race deadline 也不挂 abort；signal 仅用于事后分类）。
- **风险**：上游读完嗅探头后 stall → 请求无限挂起，调用方 abort 取消不掉。
- **修复建议**：readRemainder 内部与 readSse 相同的 race（deadline + signal → stop()）。

### [🔴] packages/standalone/service.mjs:416-456 - 成员「已提交后抛异常」时 `return result` 返回 undefined
- **原因**：`completeCombo` 中 `result`/`thrown` 是两个独立变量。成员已提交（`answered=true, hasHandler=true`，`advancePastMember` 正确不换人）后 `complete` **抛异常**（channels Worker 流中报错 reject、客户端断连 abort）时走到 `return result`——`result` 从未赋值。
- **风险**：下游 `forward.js:780` 无条件读 `result.error` 抛 TypeError，被流式 catch 捕获后以误导性错误帧「Cannot read properties of undefined」发给客户端；**真实失败原因（如 zcode 额度用尽）既不进错误帧也不进日志，彻底丢失**。非流式不受影响（handler undefined 恒不提交）。附带：`noteComboServed` 把失败成员记成「本轮作答者」，污染诊断。
- **修复建议**：成员循环的 catch 里若 `answered && hasHandler`，构造兜底 outcome（`{error: thrown.message, text: 已交付内容不计}`）再 return。

### [🔴] src/core/runtime.js:281-287 - `refreshCatalog` 等待循环的 force/probe 标志 TOCTOU
- **原因**：等待共享刷新的调用方醒来后若条件不满足（`!force || sharedForced` 不成立）会**跌落回循环外重新走完整一轮** listing+kilo+channel。
- **风险**：启动刷新 + 手动探测 + 定时轮询三者撞车时重复消耗上游配额（probe 段有 `probeRound` 幂等兜底不重复，重复的是 listing/channel 段）。
- **修复建议**：等待方拿到 `shared` 结果后，若自身条件不被满足应直接返回 shared 值（或把 force/probe 语义在共享前合并），不再重跑。

### [🔴] src/combos.js:230-231 + adapter.js:270 - `comboChain` 是带副作用的读函数，名额在「回合开始」消耗
- **原因**：sticky 名额在 `comboChain`（读取候选时就推进游标）消耗，而回合可能因快照错位、候选全被拦而从未真正发生。
- **风险**：名额被空耗、轮转漂移——这是 2026-11-04 / 11-10 两次「看起来没在轮」用户报障的根源之一。
- **修复建议**：把名额消耗挪到「确认有候选实际派发」之后（与 `noteComboServed` 同点），或加「本轮未派发则回滚名额」。
- **注意**：此改动横跨插件端与独立版两条路径，需配合 route-test 与 standalone-combo-test 全量回归；若时间不足可先记档不动（行为是漂移而非崩溃）。

### [🔴] src/store.js:76-81 - `update()` 浅合并是结构性隐患（当前无触发，降级记录）
- **原因**：`load()` 对旧配置文件浅合并，新嵌套 section 无默认值时 `undefined.xxx` 崩。
- **验证**：全量 grep 核对当前所有嵌套 section 消费方（forward.lan / tokenSaver / localOptimize / chanGateway）**都有 `?? {}` 守卫**，现网不触发。
- **风险**：任何新增消费方忘记守卫即崩（深合并缺失）。
- **修复建议**：`load()` 对每层 section 做递归默认值填充，或提供 `store.section(name, defaults)` 助手。

## 🟡 一般问题（37 项，按域归组）

### 网络转发层（net，5 项）
1. index.js:363-368、586-594 — dispose 竞态分支把句柄置 `undefined` 后立即解引用，TypeError 被外层 catch 吞成误导性 "could not start"（哨兵应为 null）
2. forward.js:1157-1173、1229-1235 — Responses 流式收尾按「播报槽位」回放 finalCalls，中间调用被过滤时后续错位顶槽；fc_N 与 call_id 两套 id 空间不一致（触发组合苛刻，待人工确认影响面）
3. index.js:105-113 vs 889、1530-1538 — 文档承诺 managed 分发模式停用热重载，代码未实现（注释自认 t6 待办）
4. http.js:106-107、152 — classifyFailure 裸子串 `/region/i`、`/not supported/` 过宽，可误判 REGION_BLOCKED/MODEL_UNAVAILABLE，污染面板可用性与重试策略
5. http.js:535、stream.js:136-148 — readSse 行缓冲与 block.text 无累计上限（RAW_JSON_LIMIT 只管 rawJson），异常上游可放大内存

### 核心运行时（core，13 项）
6. service.mjs:437-456 — completeCombo「已交付+抛异常」路径返回 undefined outcome（见 🔴#4，同根）
7. runtime.js:246 — `logger.warn?.(m) ?? logger.log?.(m)`：Node 实测 warn 存在时 `??` 右侧仍执行，同一消息双写两遍
8. probe.js:184-210 — detectEgress 循环不检查 caller signal 已 aborted，dispose 后仍可能多打最多 2 个外部 echo
9. probe.js:233 — onResult 回调抛错杀死整个 worker（Promise.all reject），整轮探测半途而废且退避 streak 跳过
10. availability.results/manualResults 无任何清理（无界但增长极慢；rotation/chainCooldown/latestTests 均有清理）
11. probeBackoff 在 disposed 分支不重算
12. isFreeLane 正则不认 `:free` 形态
13. roster 预算耗尽后剩余 provider 静默跳过
14. channelProviders 在 light 轮被截短
15. testModel 返回陈旧 lastServed
16. runtime.js:246 双写（同 7，归 core 计数）
17. 其余杂项见 BUG-AUDIT-core.md §🟡

### 适配器与外围（adapter，7 项）
18. reload.js — 升级链路**无任何内容校验**（无 download/checksum/verify 代码，selfReload 只验 `typeof apply === 'function'`）
19. reload.js — dispose 旧 fiber 无超时，挂死一次后 `isReloading()` 永久 true，热重载整体报废
20. reload.js — restoreCaches 部分失败被逐条吞掉仍报 `restored: true`（回滚假成功）
21. adapter.js:900 — advanceVerdict 用 `|| code === CODE.client || CODE.region` 强制对请求级 4xx/region 换人，与 runChannel:637（4xx 不连撞整条链）语义相反，两条成员路径漂移
22. messages.js:86-108 — repairToolPairing 依赖「调用先于结果」顺序假设，结果先行的合法历史会整条丢弃
23. messages.js:413-415 — 工具名 128 截断只作用于声明，历史回放不截断，>128 工具名导致声明与回放不一致 → 严格上游 400
24. egress.js close 链路错误被双层吞（close 内部 + index.js `.catch(() => {})`），不可观测

### 浏览器端（client，7 项）
25. client.js:2934 — Forward「应用」发 `draft.actualPort ?? draft.port`：端口被回写后用户改端口提交的是旧值，修改被静默忽略（LAN 分支 2979 口径不一致）
26. client.js:5681 — ModelPicker 在 render 中调用含 setState 的 loadQuota，与自身 5610 注释矛盾（靠 pending 守卫不炸的反模式）
27. client.js:5946/5992 — RoutingPage remove 无 try/catch 且 void remove() 直连 onClick，删除失败 unhandled rejection、界面无反馈
28. client.js:4239/4254/4372/5120/5123/3049/5575 — 7 处异步 loader 无 alive/generation 保护（React 18 静默无害，但与文件自身风格不符）
29. client.js:2890/3058 — setCopied 1600ms 定时器无清理（对照 CopyButton 5321 有清理）
30. client.js:6028 — bench 结果 `{ttft}` 插值缺 `?? '—'` 兜底，可能渲染 "undefined ms"
31. client.js:4542-4568 — AnomalyPanel absolute/remaining 对无效 resetAtMs 无 isFinite 防护，渲染 "aN:aN"/"NaN天"

### standalone 管理面（standalone，5 项）
32. service.mjs:43-47 — advancePastMember 不区分 abort：客户端断连后走完整条链，与插件端「abort 不换人」语义漂移（adapter.js:367-374）
33. management.mjs:201-219 — `/login/terminal` 在鉴权之前，Origin + Sec-Fetch-Site 对 curl 类客户端可伪造；密码模式下唯一免密触发端点
34. login-terminal.mjs — 终端助手复制的 forwardKey 已不是面板凭据（密码迁移后 /session 只认 OFM_PASSWORD），功能失效且无谓暴露密钥进剪贴板
35. management.mjs:65-74 — POST /settings 的 combos 分支缺单链 ≤1000 校验（绕过 POST /combos 归一化前检查）
36. management.mjs:451-455 — route catch 在 headersSent/destroyed 时空分支且无日志，管理面异常静默蒸发

## 🟢 建议问题（19+ 项，摘要）

- 性能：三个 id 铸造器手写 hex 循环重复；http.js 与 route/classify.js 两套同域 classifyFailure；重复 DOM 构建 4 处（client 2942/2989/5165/5204）
- 坏味道：recordUsage 72 行、testModel 58 行、rebuildCatalog 55 行、completeCombo 约 100 行三层嵌套、apply 约 1175 行；reviveKiloCatalog/reviveChannelCatalog 同构可共享
- 可读性：轮询周期魔法数字散落（15s/45s/90s/3s…未收敛成表）；64KB 提交阈值、2500/5000ms 冷却等魔法数；ACCOUNT_STICKY_LIMIT（client:3199）死常量；LedgerPage:4939 entries 死变量；Shell glider（6078-6085）不响应 resize
- 其他：mintSessionId 同毫秒 >63 次漂出上游窗口；trust 围栏不核对 remoteAddress；foldAnthropicOutcome 畸形 index 合槽；Claude 线丢远程 URL 图片与 Chat 线不一致；表单 onInput/onChange 混用

## 审计同时确认无误的重点（抽样）

- XSS：client.js 零 innerHTML/eval，公告走自研白名单 tokenizer（47 标签白名单 + safeUrl + sanitizeStyle），无绕过
- 密钥治理：无硬编码密钥；egress 的 mihomo secret/outletAuth 均每次启动随机、只进句柄不落盘
- 内核接缝：`@deepseek-ai` import 全包唯一出现在 adapter/kernel.js（惰性+降级），无 instanceof 内核类
- 时序安全：timingSafeEqual 先比长度再比较，正确
- advancePastMember 判据本身：answered/delivered 拆分与 455130d 意图一致，held 丢弃/补发路径正确
- 账号池：RMW 无中间 await、冷却「只接受更长解禁时刻」、签到幂等链完整
- 探测全链路：AbortController/timer/listener 均 finally 清理；probeRound 无漏窗（行 443-446 无 await）
