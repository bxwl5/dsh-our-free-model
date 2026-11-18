# 核心运行时审计报告（runtime/catalog/channel-catalog/combos/store/probe）

日期：2026-11-19
范围：`src/core/runtime.js`（592 行）、`src/catalog.js`（423 行）、`src/channel-catalog.js`（431 行）、`src/combos.js`（273 行）、`src/store.js`（523 行）、`src/probe.js`（238 行），共 2480 行，逐行通读。
方法：每个问题均先读代码验证；关键项做了实证——① `comboChain` 的名额计数、游标越界钳制、并发交错、负 `stickyLimit` 用 Node 直跑真代码验证；② `JsonStore.update()` 浅合并的嵌套字段风险对全部调用方做了 grep 核对；③ `completeCombo` 已知修复（`advancePastMember` 的 answered/delivered 分离）逐行核对，并验证了它的一个遗留边界；④ `logger.warn?.() ?? logger.log?.()` 双写行为用 Node 求值顺序验证。

---

## 🔴 严重

**[🔴] src/core/runtime.js:399-447 - probeRound 去重存在漏窗：`runProbeRound()` 先启动、后注册，两个并发调用在 await 前的同步窗口里各自启动一整轮探测**
- 原因：`refreshAvailability` 的序列是「先检查 `probeRound !== null`（行 443）→ 调 `runProbeRound()`（行 444，返回 promise）→ 再把 promise 赋给 `probeRound`（行 445）」。`runProbeRound()` 被调用的那一刻就开始执行（构造 `probeable` 数组、调 `probeCatalog` 到第一个 await 为止），而 `probeRound = round` 在它之后才执行——这两行之间没有 await，单线程下看似安全，**但真正的漏窗在 `await` 的恢复侧**：两个 `refreshAvailability` 调用若在不同微任务里先后进入，第一个在行 445 赋值前 yield 过（不会——行 443-446 之间无 await，`runProbeRound` 返回的是已启动的 promise，同步赋值）。经复核：行 443→444→445 之间无 await 点，单线程模型下赋值是原子的，**此窗口实际不存在**。真正的问题在另一处——`refreshCatalog` 的等待循环（行 281-287）与 `refreshAvailability` 的组合：`refreshCatalogOnce` 在行 319 `await refreshAvailability(force)`，而两个并发的 `refreshCatalog` 调用（一个 `probe:true,force:true`、一个 `probe:true,force:false`）会各自等待共享的 `catalogRefresh`，醒来后若条件不满足（行 286 判 `sharedProbed` 已为 true）直接返回缓存值——但当等待者醒来的时刻恰逢第一轮 `refreshCatalogOnce` 已把 `catalogRefresh` 置回 null 且其内部的 probe 回合也结束，而第二个等待者因为 `force:true` 不满足（`sharedForced` 为 false）会**再走一遍循环**，此时 `catalogRefresh === null`，于是启动第二次完整的 listing+kilo+channel+probe 往返。两个并发 `refreshCatalog({probe:true,force:true})` 与 `refreshCatalog({probe:true})` 的交错会让 probe 与 listing 各跑两轮，浪费配额（免费车道按会话计 429）。
- 风险：并发触发（启动刷新 + 用户点「重新探测」+ 定时轮询三者撞车时）重复探测，消耗上游配额并加剧 429 退避；probe 本身有 `probeRound` 幂等保护兜底（第二个 probe 调用会复用同一个 `probeRound` promise），所以实际后果限于 listing/kilo/channel 三段重复执行，probe 段不重复。
- 修复建议：把 `catalogRefresh` 的注册改成「先创建后启动」或把标志位收进 promise 对象本身（`run.catalogRefresh = …`），消除三个模块级变量的 TOCTOU；或让等待循环在条件不满足时重入队列而不是重跑。

**[🔴] src/core/runtime.js:424 + src/combos.js:41,218-231 - comboChain 在「回合开始」消耗名额，但回合可能永不发生（快照过期被拒），导致名额被空耗、轮转漂移**
- 原因：`comboChain` 是**有副作用的**（行 230-231 每次调用都 `rotation.set` 推进 `used`，满额时前移游标），它被 `runCombo`（adapter.js:270-271）在回合开头无条件调用。但 `runCombo` 拿到链条后若 `candidates.length === 0`（行 281）或后续全部候选被 `enabled=false` 拦截（`runSingle` 行 695-699 直接 return，不产出 advance），该回合没有任何成员被服务，名额却已被消耗。实测确认（Node 直跑）：连续调用会稳定推进游标。更实际的路径：`prepareCall` 快照与回合快照错位时 adapter 注释自己承认会兜底重试（adapter.js:276-279），每次兜底都是一次真实的名额消耗。
- 风险：`stickyLimit=N` 的语义（「同一成员连续服务 N 回合」）被稀释为「N 次尝试」；配额统计与「轮到谁」的直觉漂移。这是设计权衡而非崩溃级缺陷，但游标是**内存态、跨重启归零**（combos.js:22 注释自知），叠加空耗后用户感知的「不轮」概率显著上升——正是 2026-11-04/11-10 两次用户报障的根源之一。
- 修复建议：把「消耗名额」从 `comboChain`（读函数）挪到 `runCombo` 确认至少有一个候选实际进入派发之后（单独的 `consumeComboSlot(entry)`），或在 `rejectedTurn(0)` 路径回滚本次消耗。

**[🔴] src/store.js:76-81 + 152-218 - `update()` 浅合并会把旧配置文件的嵌套 section 整段洗掉，`tokenSaver` 是现实暴露面**
- 唯一的异常路径如下，属低概率但确实存在：一个**早于 `forward.lan` 字段存在**的旧 `settings.json`（只含 `forward: { enabled, host, port }`）被加载后，运行时 `update({ forward: … })` 的来源均为深合并保护过的调用点；但若一次崩溃发生在 `load()`（行 58 `{ ...this.value, ...parsed }` 把磁盘上**手编辑/外部工具写入的半旧格式**并进来）之后、任何深合并调用点之前，后续任何拿 `SETTINGS_INITIAL` 判断的代码读到的 `settings.get().forward.lan` 都是 `undefined`——`index.js:429` 等处已用 `?? {}` 兜底，故不崩。真正会崩的读取在 `src/token-saver/index.js:40`（`section.prompts ?? {}` 已兜底）与 `index.js:1018`（`?? {}` 已兜底）。经全量核对：**当前所有嵌套 section 的消费方都有 `?? {}` 守卫**，此问题在现网路径上不触发，故降级为 🟡（见下）。
- 风险（保留描述因为它是结构性隐患）：任何新消费方忘记 `?? {}` 就会把「旧配置 + 新代码」变成崩溃。`load()` 的浅合并使「旧文件缺新嵌套字段」成为常态而非异常。
- 修复建议：`load()` 对 `SETTINGS_INITIAL` 中已知的嵌套 section（forward/chanGateway/egress/tokenSaver/localOptimize）做一层递归默认合并（deep-fill defaults），或在 `update()` 里支持嵌套 patch 语义。

---

## 🟡 一般

**[🟡] src/core/runtime.js:396-447 - probeBackoff 状态（probeThrottleStreak/probeBackoffUntil）在 probeRound 抢占失败时不重算，`force` 语义不完整**
- 原因：`refreshAvailability(force)` 中，若 `probeRound !== null`（行 443）就直接返回进行中的回合，`force` 参数被静默丢弃——但一个**非 force** 的周期轮询恰在此刻撞上手动强制探测时，它拿到的是同一份结果，行为正确；可反过来，周期轮询先进入（`probeBackoffUntil` 生效，行 442 直接返回 `{}`），随后用户 force 探测正常走——语义是对的。真正的不一致：`runProbeRound` 内部若 `disposed` 中途退出（行 423），`availability.update({ at: Date.now(), egress })`（行 424）已可能执行（在 `probeCatalog` 的 onResult 回调里逐条 edit，flush 已发生），但 `probeThrottleStreak`/`probeBackoffUntil` 不更新——下一轮从旧 streak 继续累计，退避时长可能跳变。
- 风险：仅影响退避时长的平滑性，不影响可用性判断正确性（results 已逐条写入）。
- 修复建议：把 streak/backoff 的更新移进 try 或在 disposed 分支显式保留旧值并注释。

**[🟡] src/core/runtime.js:407-422 - probeable 过滤与 probe 结果写入的 key 用 `entry.id`，组合链被探测排除是正确的，但 `probeCatalog` 的 results 对象按 `model.id` 写入（probe.js:232），与 `runProbeRound` 返回值的一致性依赖调用方善用**
- 原因：`probeCatalog`（probe.js:222-237）的 `results` 以 `model.id` 为键；`runProbeRound` 把它原样返回。若上游某天给两个 lane 传同 id 行（free lane 的 base id 与 Kilo 的 `org/model` 理论上不冲突，但 channel 模型 id 形如 `channel:provider/model`），目录重建后 `availability.results` 中会留下**已从目录消失的模型的陈旧判定**，且 `results` 与 `manualResults` 都没有任何清理/修剪逻辑（全仓 grep `manualResults|results` 的 delete/prune 均无命中）。
- 风险：`availability.json` 无界增长（每模型一条小记录，加 manual 结果）；被删模型的历史判定永远留在盘上。增长速率极慢（模型数百个量级），实际是卫生问题。
- 修复建议：`runProbeRound` 末尾或 `rebuildCatalog` 里对 `availability.results` 按 `catalog` id 集合修剪一次。

**[🟡] src/core/runtime.js:246 - `warn: message => logger.warn?.(message) ?? logger.log?.(message)` 的回退分支在 warn 存在时永不执行，warn 不存在时会**双写**
- 原因：`logger.warn?.(message)` 当 `warn` 存在且返回 undefined（console.warn 的常态）时，`??` 右侧 `logger.log?.(message)` **仍然执行**（`undefined ?? x` 取 x）。Node 实测确认：配置 `{warn, log}` 的 logger 会把同一条消息写两遍（WARN 一条、LOG 一条）。仅当 `warn` 属性缺失（`?.` 短路返回 undefined）时本意「回退到 log」才成立，但 warn 存在时也落入右侧——回退写成了追加。
- 风险：适配器失败告警在带 `log` 的宿主里每条重复输出，污染日志，可能掩盖真实告警频率。
- 修复建议：改为 `message => { if (typeof logger.warn === 'function') logger.warn(message); else logger.log?.(message) }` 或 `const warnFn = logger.warn?.bind(logger) ?? logger.log?.bind(logger)`。

**[🟡] src/store.js:104-128 - flush 失败后 `dirty` 恒为 true，但「写失败只告警一次」的标志 `writeFailed` 只在**成功**时复位（行 112），连续失败静默的注释与实现不符的是：重复失败确实安静，可一旦后续某次成功，之前丢失的更新已无法找回**
- 厇史包袱说明：这是有意的 fail-soft（行 114 注释），且 dispose 的最终 flush 会重试。真正的问题：`update()`/`edit()` 在 `writeFailed === true` 期间照常返回合并后的值，调用方（如 `testModel` 的 `persist`，runtime.js:476-482）用 `return !availability.writeFailed` 把失败如实上报——这条链路是通的。剩余风险：**磁盘满**场景下 `fs.writeFileSync(temp, …)` 每次都失败，`writeFailed` 只在第一次打日志，用户在几百次 mutation 后仍只看到一行告警，而内存里的 value 与磁盘的差距持续扩大；进程一旦退出（dispose 也不成功）即全丢。
- 风险：静默数据丢失窗口与内存状态膨胀成正比；日志只在第一次出现。
- 修复建议：`writeFailed` 状态下周期性（如每 100 次失败或每 5 分钟）重复告警一次，或在 `get()` 里暴露 stale 状态供面板显示「未持久化」。

**[🟡] src/probe.js:184-210 - detectEgress 对 caller signal 的监听依赖 `finally` 清理，但三个 echo 源是**顺序重试**，caller 中止只影响当前 attempt；source 之间的间隙（`continue` 路径）里 caller abort 不会被立即感知**
- 原因：每个 attempt 的 `finally`（行 205-207）正确移除 `relayAbort` 监听器，但循环本身没有检查外层 `signal.aborted`：若 caller 在第 1 个 echo 失败、第 2 个尚未开始时 abort，循环仍会发起第 2/3 个 echo 请求（各自的 `controller` 只在收到 caller abort 事件时中止——但监听器是每 attempt 新加的，新 attempt 开始时 `signal.aborted` 已为 true，`relayAbort` 会同步触发——`addEventListener` 对已 aborted 的 signal **不会同步触发回调**，需手动检查）。实测语义：对已 aborted 的 signal 添加 listener 不触发。于是第 2 个 echo 请求会带着**未中止的 controller** 发出去，直到 8s 超时或响应返回。
- 风险：调用方已放弃（如 `watchEgress` 的 lifetime 已 dispose）后，detectEgress 仍可能多打最多 2 个外部请求（ipify/ipinfo/ipapi），浪费且在 dispose 场景下延长了 generation 的 IO 尾巴。
- 修复建议：每个 attempt 开始前加 `if (signal?.aborted) break`。

**[🟡] src/probe.js:222-237 - probeCatalog 的共享 cursor 在 worker 抛错时（理论上 probeModel 不抛，全部内化）无 finally 保护；`onResult` 回调若抛错会**杀死整个 worker**，剩余模型本轮不再被探测**
- 原因：`onResult` 是 runtime.js 传入的回调（行 408），其内部 `availability.edit(...)` 若 mutate 函数抛错（structuredClone 深拷贝大对象、或 value 含不可克隆内容如 undefined→函数），异常从 `onResult(model.id, result)`（probe.js:233）冒泡进 worker async 函数，`Promise.all` 整体 reject，`runProbeRound` 行 408 的 await 抛出，**后面的模型不再探测**且 `availability.update({at…})`（runtime.js:424）与退避统计全部跳过；该异常沿 `refreshCatalogOnce` → `refreshCatalog` → 调用方（index.js:1256 有 catch，周期轮询也有 catch），不崩进程但整轮探测半途而废。
- 风险：一次 store 异常 = 一轮探测只有部分模型有新判定，且退避 streak 被跳过（下一轮从 0 开始，可能立即再打满配额）。
- 修复建议：`probeCatalog` 里 `try { onResult(...) } catch {}` 内化，或至少在 `runProbeRound` 的 onResult 回调里包 try/catch。

**[🟡] packages/standalone/service.mjs:437-456 - completeCombo 在「已交付 + 成员抛异常」时返回 `undefined` outcome，forward.js 三个消费方全部对 `outcome.error` 解引用，会抛 TypeError**
- 原因：`advancePastMember` 返回 false 的路径（行 437 不成立 = 已交付或成功），直接 `return result`（行 456）。当 `thrown !== undefined` 且 `hasHandler === true`（客户端已收到部分正文后成员抛错），`result` 是 undefined（行 416-424 只在 catch 里记 `thrown`）。`forward.js:946`（`outcome.error !== undefined`）、`:1023`、`:1363` 三处都会对 undefined 解引用 `.error` 抛 TypeError。流式路径（:976）有外层 try/catch 兜住（行 1011），非流式路径（:944）**没有** try/catch，异常直接炸到顶层 handler（需确认其兜底，forward.js 顶层 handler 是否兜底未在本次范围验证）。
- 风险：客户端已收到部分正文后成员抛错（网络中断类错误在流中抛出是常态），非流式路径返回 500 而非结构化错误帧；日志里是一次 TypeError 而非原始错误信息，排障困难。
- 修复建议：行 456 改为 `return thrown !== undefined ? { error: String(thrown?.message ?? thrown) } : result`，保证 outcome 契约恒成立。

**[🟡] src/core/runtime.js:466-523 - testModel 的 `latestTests` Map 在**异常路径**下依赖 finally 清理（行 520-522 有），但 `persist` 的闭包持有 token 比较——并发同 id 测试时旧测试的 persist 被 token 检查正确拒绝；然而 `latestTests.set(id, token)`（行 473）在 `catalog.find` 之后才执行，而 `runModelTest` 可能**永不 settle**（其内部 `Promise.race([measure, aborted])` 的 measure 侧若 adapter 流挂起且 controller 未 abort）**
- 复核修正：`runModelTest` 的 finally（model-test.js:64-72）在 race 胜出后总会执行（timer/监听器清理 + `iterator.return()`），且 `controller` 的超时（300s）保证 race 必然 settle——**该风险不成立，撤回**。保留的问题只剩：`testModel` 对 combo 入口返回 `comboLastServed`（行 509），但**没有清除** `lastServed`——上一次手动测试留下的「本轮由谁作答」会在新一次测试尚未作答前就返回旧值，UI 显示的 member 可能是**上上轮**的成员。语义污染而非崩溃。
- 风险：手动测试的「本轮由谁作答」可能显示陈旧成员名。
- 修复建议：`testModel` 起始处 `noteComboServed(entry.id, '')` 清空，或 comboLastServed 附带时间戳供 UI 判断新鲜度。

**[🟡] src/store.js:53-68 - load() 对**数组型**JSON 文件（如 `{"days": [..]}` 结构漂移）的防御只挡「顶层非对象」，`parsed.days` 为数组时 `recordUsage` 的 `Object.entries(state.days ?? {})`（行 457）会对数组产生数字键，统计错乱但**不崩**；真正的问题在 `migrateStats` 的 `Object.entries(value?.days ?? {})` 对数组同样产生数字键迁移，把错误结构永久固化到 v3**
- 原因：`load()` 合并后 `days` 可能是数组（旧版本损坏文件），`migrateStats`（行 457）不校验 `days` 是不是 plain object，直接 entries 迁移；`recordUsage`（行 314-335）`{ ...(state.days ?? {}) }` 对数组展开产生索引键，`pruneDays`（行 517）`Object.keys` 排序后数字键排在日期键前面，切片丢弃的是**最新数据**（数组键 "0","1"… 排最前，`keys.slice(0, len-120)` 丢的是排序后头部——数字键会被先丢，这一方向反而是对的；但 `days[day]` 写入时数组变对象的行为在 JSON.stringify 后仍是对象，结构混乱但可自愈）。综合评估：自愈路径存在（新写入覆盖），migrateStats 只在版本不匹配时跑一次。
- 风险：仅影响「损坏文件 + 版本升级」同时发生的窄场景；常规损坏已被 `.corrupt-*` 备份 + 保留原文件策略兜住。
- 修复建议：`migrateStats` 与 `recordUsage` 入口处 `if (!isPlainObject(state.days)) state.days = {}`。

**[🟡] src/catalog.js:170-174 - isFreeLane 的正则 `/(?:^|[-_])free(?:$|[-_.])/` 不匹配 `:free` 后缀，Kilo 之外的第三方「org/model:free」形态 id 会被当作付费模型丢弃**
- 原因：正则的边界类是 `[-_.]`，不含 `:`。`baseModelId`（upstream.js）对 `org/model:free` 的 base 处理方式未在本次范围核对，但 free lane 的 listing 实际不含该形态（Kilo 行走 `isKiloFreeRow` 的 `isFree === true` 判定，不经 `isFreeLane`），因此**当前无实际触发路径**。
- 风险：仅当上游 listing 未来引入 `:free` 形态 id 时，这些模型会静默消失在目录外（buildCatalog 行 217 `if (!isFreeLane(id)) continue`），且无日志。
- 修复建议：把 `:` 加入边界类，或对被过滤的 listing id 计数并在全被过滤时打一行日志。

**[🟡] src/channel-catalog.js:349-352 - 名册预算耗尽的 onError 报告用「下一家 provider」的名义打出，最后一家的预算耗尽不会被报告**
- 原因：`break` 前的 `onError?.(provider, …)` 用的是**当前循环变量的 provider**（即将被跳过的那家），语义正确；但 `for…of` 结束后若还有剩余 provider 未遍历（预算在列表中途耗尽），那些 provider 没有任何报告——用户看到「这家本轮没扫到」只对撞上 break 的那一家成立，后面的家是静默跳过。
- 风险：仅影响诊断完整性：路由编辑器里「为什么没有这家渠道的模型」对部分 provider 无日志可查。
- 修复建议：break 后补一行 `logger.warn('…remaining providers deferred')`（runtime 层的 onError 已有字符串，channel-catalog 层补一条汇总即可）。

**[🟡] src/combos.js:96 - comboRotationSlot 对 `cursor.used === 0`（满额刚前移）显示为 `limit/limit`，与「名额已耗尽、下回合换人」的真实语义一致，但**游标前移后的第一次显示**（used=0，index 已指向新成员）也显示 `1/limit`——实测 Node 验证：turn3 slot 显示 `1/2` 且 starts at b，正确；但 turn2 结束后（used 满额归零前移）与 turn3 开始前的窗口里，`runCombo` 日志的 slot 取值（adapter.js:342 在作答成功后读）取到的是**本回合 comboChain 已写回的值**，turn2 显示 `2/2`——正确。唯一误导窗口：stickyLimit=1 时每次作答后 slot 恒显示 `1/1`，用户无从分辨「这一轮是名额期第几次」**
- 降级说明：行为与注释声明一致（combos.js:83-85），不算缺陷；列出仅为记录 `used || limit` 的启发式在 limit=1 时的信息量退化。
- 修复建议：无（保持现状），或在 UI 层对 stickyLimit=1 不显示 slot。

**[🟡] src/core/runtime.js:354-382 - refreshChannelCatalog 的 light 模式**不写盘**，但 `channelProviders` 照样更新——若 light 轮恰好扫到的 provider 集合比完整扫描小（预算掐断），`channelProviders` 缩小后，依赖它做「空状态解释」的 UI 会把「本轮没扫到」误报为「该渠道未挂载」**
- 原因：行 378 `channelProviders = providers` 在 light/full 两分支共享，light 的 `providers` 可能因 ROSTER_BUDGET_MS 被截短（channel-catalog.js:349 的 break 同样作用于 light 路径）。
- 风险：轻微的诊断口径漂移；不影响路由与目录真值。
- 修复建议：light 轮不更新 `channelProviders`（或与 full 轮的结果取并集）。

---

## 🟢 建议

**[🟢] src/core/runtime.js:299-322 - refreshCatalogOnce 超过 50 行（含目录刷新、Kilo 名册、渠道名册、探测四段串行），每段失败策略不同，建议拆分为四个显式步骤函数**
- 收益：行 312 的 `else` 分支（listing 失败回灌 catalogStore 缓存）与行 307 的成功分支是**两套 freeCatalog 来源**，拆开后「从哪来」一目了然；也便于给每段加独立的耗时日志。

**[🟢] src/core/runtime.js:466-523 - testModel 约 58 行，混合了 token 去重、信号链接、探测消息构造、结果持久化与 combo 信息补齐五件事，建议把 `persist` 与错误分类提出为私有函数**

**[🟢] 目录刷新与探测结果的竞态（缓存一致性，审查重点 7）——现状是安全的，说明如下**
- `refreshCatalogOnce` 行 319 先 `await refreshAvailability(force)` 再 `emitTopology()`（行 320），而 `runProbeRound` 的 onResult 逐条 `availability.edit` 是同步合并进内存 store 的——目录（`catalog` 闭包变量）与探测结果（`availability` store）的更新顺序是「目录先变，探测随后跟上」，`state()` 每次读取都是最新组合；`computeMembership`（行 566-592）在探测进行中读到的是**旧判定 + 新目录**，最坏表现是「新模型短暂显示 unknown」，下一轮 emitTopology 修正。无需修复；若要更紧，可在 `refreshAvailability` 完成后再触发一次 `rebuildCatalog`（当前没有，因为 membership 不写回 catalog）。唯一注意点：`refreshChannelCatalog`（行 354-382）**内部自带** `rebuildCatalog + emitTopology`（行 379-380），它会先于行 318 的 `rebuildCatalog()` 让 combo 行基于**半新目录**构建一次——随后行 318 再修一次，最终一致，但中间态会发两次 topology 事件（监听方需幂等，`registration.replace` 是幂等的，实际无害）。

**[🟢] src/store.js:311-383 - recordUsage 约 72 行，day 桶、lifetime 桶、samples 环、savings 四段可以各自提为纯函数；samples 的字段展开（行 348-371）与 savingsSample 的合并逻辑建议提为独立函数以便单测**

**[🟢] src/core/runtime.js:112-166 - rebuildCatalog 55 行，缺失成员告警的「记忆比对」逻辑（行 136-157）可提为独立函数；`missingReport` 的 Map 构建与告警去重是两个正交关注点**

**[🟢] src/catalog.js:390-418 - reviveKiloCatalog 的字段校验重复出现 `typeof x === 'string' && x !== ''` 三段式，可提一个 `nonEmptyString(value, fallback)` 助手；channel-catalog.js 的 reviveChannelCatalog（行 170-200）与它同构，共享助手可减重复**

---

## 与已知事实的核对

**service.mjs 的 `completeCombo` 已有 `advancePastMember` 判据（answered/delivered 分离）——修复本身完整，核对通过**，具体：
- `advancePastMember`（service.mjs:43-47）正确实现 `delivered = answered && hasHandler`，换人判据 `!delivered && failed` 与插件端 `runCombo` 的「committed 后不换人」语义一致（adapter.js:317-365）。
- sink 的提交判据复用插件端同一份 `commitsAnswer`（service.mjs:10 导入、:395 使用），usage/空白 text-delta 不提交，与插件端无漂移。
- 作答成功后**不**调 `advanceComboCursor`（service.mjs:449-455 注释明确），游标推进只发生在 `comboChain` 内部按 stickyLimit 名额完成——无「双倍推进」回归。
- 但发现一个该修复未覆盖的边界：**已交付 + thrown** 的路径返回 undefined outcome（见上文 🟡 第 8 条），建议补上。

---

## 确认无误的部分

以下项目经实际验证无问题，列出以缩小后续排查面：

1. **`comboChain` 的名额推进在单线程语义下正确**（Node 实测：stickyLimit=2 时 `a,a,b,b,c,c,a` 严格轮转，slot 显示 `1/2→2/2` 配对正确；stickyLimit=1 时每次换人；负数/0/NaN 的 stickyLimit 在 `comboChain` 与 `normalizeCombos` 两处都有 `Number.isFinite && > 0 ? trunc : 1` 钳制，实测 -5 被按 1 处理）。
2. **游标越界钳制**：成员从目录消失时 `Math.min(Math.max(cursor.index, 0), members.length - 1)`（combos.js:219）把 index 钳回有效区间，实测 b 消失后链条 `c,a` 正确回绕，b 回来后 `a,b,c` 恢复；`buildComboCatalog`（combos.js:169-170）对成员全消失的链返回空（combo 行整个不出现），`runCombo` 对 `candidates.length === 0` 有明确的错误 finish（adapter.js:281-284），单成员链不消耗名额（combos.js:216 直接返回）。
3. **`rotation`/`lastServed` Map 的无界增长已由 `pruneRotation` 兜住**（combos.js:268-272，runtime.js:159 与 standalone service.mjs:328 两处调用点都在目录重建后执行）。
4. **`probe` 的 AbortController 清理路径完整**：`detectEgress` 的 timer/listener 在 finally 清理（probe.js:205-207）；`getJson` 的 controller/timer/listener 在 finally 清理（http.js:588-591）；`headRead` 同样 finally 清理（http.js:293-299）；`readSse` 的每读超时/中止监听在 finally 清理（http.js:482-488）；`runModelTest` 的 timer/两个监听器/iterator.return 在 finally 清理（model-test.js:64-72）；`readHead` 失败路径 cancel reader（http.js:242-243）。`probeModel` 自身不持 controller——依赖调用方传入的 signal（`lifetime.signal` 或 runModelTest 的 controller），而这两者的生命周期都有归属，无泄漏路径。
5. **`refreshAvailability` 的 `probeRound` 去重在单线程模型下无漏窗**：行 443-446 之间无 await，赋值原子（审查重点 1 的初判「漏窗」经复核不成立——见 🔴 第 1 条的实际结论：重复执行风险在 `refreshCatalog` 的等待循环而非 probeRound 本身）。
6. **`availability` 存储的写入时序无丢更新**：probe 结果逐条 `edit`（同步合并）→ 末尾 `update` + `flush`（runtime.js:424-425）；`edit` 基于内存 value 的深拷贝做 read-modify-write，store 单线程串行，无丢更新窗口。`watchEgress` 的 `update({ egress })` 与 probe 的 `edit` 都走同一 store 的合并语义，字段不相交。`JsonStore` 的 temp+rename 原子写（store.js:109-111）与失败重挂 dirty（行 122）保证崩溃安全。
7. **`catalogStore.update` + `flush` 的成对调用**在 free（runtime.js:309-310）、channel（:375-376）、kilo（:330，无 flush 但随下次 free/channel 的 flush 落盘——`update` 会 `schedule()` 800ms 延迟写，无丢失）三处正确。
8. **`computeMembership` 的「整条车道被拒」守卫**（runtime.js:570-572）：`refusedAll` 时保留全部模型可见，与 probe.js:163 注释的 laneLocked 语义闭环一致。
9. **`buildComboCatalog` 的容量交集**（vision every / contextWindow min / maxOutput min，combos.js:179-183）方向正确；`number()` 助手挡住 NaN/非正数。
10. **`mergeChannelCatalogRows` 的三层合并规则**（未扫描的 provider 保留磁盘行、扫描过的以 fresh 为权威、占位容量回填磁盘真值，channel-catalog.js:225-254）与注释声明一致，`PLACEHOLDER_CONTEXT_WINDOWS` 同时挡旧值 131072 与新值 512000。
11. **`normalizeCombos` 的输入防御完整**：非对象行丢弃、空 models 丢弃、自引用过滤（`value !== id`）、未知 strategy 回退 fallback、重复 id 去重（combos.js:126-149）。
12. **`probe` 的状态分类不对称性**（probe.js:151-178）与注释声明一致：5xx 不因 reason phrase 误判（`gatewayTrouble` 先行排除）、400/404/422 路由拒绝判 unavailable、其余保守 unknown。
13. **`stateOf` 对 401/403/407/408/425/429 的映射**经 `CODE` 枚举核对无误（quota→throttled、region→regionBlocked、laneLocked→unavailable）。
14. **`JsonStore.load` 的损坏文件保护**（保留原文件 + `.corrupt-*` 备份，store.js:60-68）与 dispose 的「先 flush 后锁写」顺序（store.js:130-140）正确。
15. **`latestTests` token 机制**：并发同 id 手动测试时旧测试的 persist 被 `latestTests.get(id) !== token` 正确拒绝（runtime.js:477），异常路径 finally 清理（行 520-522）。

---

## 审查重点覆盖对照

| 重点 | 结论 |
|---|---|
| 🔴1 并发竞态：probeRound 漏窗 | 无漏窗（行 443-446 无 await）；真实重复执行风险在 `refreshCatalog` 等待循环的 force 语义（🔴1） |
| 🔴1 rotation 游标并发一致性 | 单线程 JS 下无并发写窗口；名额在回合开始消耗的副作用设计有边界损耗（🔴2） |
| 🔴1 comboChain sticky 计数幂等性 | **不幂等（有意为之）**：每次调用推进一次；空回合也会消耗（🔴2）；实测计数/轮转正确 |
| 🔴2 availability 写入时序 edit/flush | 无丢更新：edit 同步合并 + 单线程串行 + 失败重挂 dirty；flush 失败的静默窗口见 🟡4 |
| 🔴3 AbortController 清理 | probe 链路全部路径 finally 清理，无泄漏（确认无误 4） |
| 🔴3 Map 无界增长 | rotation/lastServed 有 pruneRotation；chainCooldown 有 pruneCooldowns（adapter.js:452）；**availability.results/manualResults 无清理**（🟡2）；latestTests 有 token 清理 |
| 🟡4 空指针 catalog.find | testModel:470 有 null 检查；service.mjs:317 `full === undefined ? row : …` 有守卫；adapter.js:221 `?? null` + runSingle:700 `entry === null` 分支完整 |
| 🟡5 catch 吞异常 | probe.js:199（echo 重试）、http.js:423/580（JSON parse）、combos.js 无空 catch；均为有意 fail-soft 且注释说明；**唯一值得改的是 probeCatalog 的 onResult 未内化**（🟡6） |
| 🟡6 边界：空链/单成员/全消失/stickyLimit≤0 | 全部有守卫（确认无误 1、2）；comboChain 空链返回 []，runCombo 有明确错误 finish |
| 🟢7 缓存一致性：目录刷新 vs 探测 | 中间态短暂不一致但自愈，两次 topology 事件幂等（🟢3） |
| 🟢8 >50 行函数 | refreshCatalogOnce（24 行体+4 段串行）、testModel（58 行）、recordUsage（72 行）、rebuildCatalog（55 行）、comboChain（23 行，OK）、reviveKiloCatalog/reviveChannelCatalog（同构重复）——见 🟢 各条 |
