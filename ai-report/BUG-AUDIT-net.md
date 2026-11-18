# BUG-AUDIT-net — 网络层四文件审计报告

审计对象：`index.js`（1962 行）、`src/forward.js`（1446 行）、`src/stream.js`（598 行）、`src/http.js`（592 行）。
辅助核对（仅用于验证行为，不单独立项）：`src/trust.js`、`src/failure.js`、`src/reload.js`、`src/open-external.js`、`src/store.js`、`src/push.js`、`src/deferred-response.js`、`src/egress.js`、`src/upstream.js`。

方法：逐文件通读 + 关键疑点做最小复现实验（Node v20.15.1）：

1. **中继上游断连实验**：复刻 `startLanRelay` 的 `target.on('response') → up.pipe(res)` 管道，上游写部分响应后 `socket.destroy()`。实测：无论是否给 `up` 挂 `error` 监听，下游响应都**不会结束**，客户端挂起直至自身超时（20s 后 `UND_ERR_BODY_TIMEOUT`）；挂监听时确认 `up` 发出 `ECONNRESET`。
2. **write-after-destroy 实验**：客户端断开后对 `ServerResponse` 继续 `write`/`end`：返回 `false`、不抛异常、无 `error` 事件、进程不崩（含无任何 `error` 监听的路径）。

行号均为当前工作区文件实际行号。

---

## 🔴 严重

**[🔴] src/forward.js:694-709 - LAN 中继对「上游响应中途出错」零处理，客户端连接永久挂起**
原因：`target.on('response', upstream => { ... upstream.pipe(res) })` 只处理了成功路径。`target.on('error')`（704-709）只覆盖连接期错误——一旦 `response` 事件发出，后续错误（上游中途 `ECONNRESET`、TLS 断开、mihomo 被杀）发在 `upstream`（IncomingMessage）上，而它**没有任何 `error`/`aborted` 监听**。`res.once('close')`（712-714）只在客户端先离开时销毁 `target`，上游先死时不会触发。`upstream.pipe(res)` 不转发错误、也不结束目标流（已实测复现）。中继 socket 无超时，挂起会一直保持。
风险：上游网络闪断/出口节点切换/网关进程被杀时，每个在途请求留下一对永不关闭的 socket（下游 res + 中继连接），客户端（含 SSE 调用方）无限等待直到自己超时；高频故障场景下连接与内存持续累积。这是清单 #4「未销毁的 stream」的典型实例。
修复建议：在 response 处理器内补 `upstream.on('error', …)` 与 `upstream.on('aborted', …)`：非 SSE（有 content-length）直接 `if (!res.writableEnded) res.destroy()`；SSE 可先写一帧错误事件再 `res.end()`。可同时给 `target`/`upstream` 设空闲超时兜底。

**[🔴] src/http.js:333-348 - `readRemainder` 收了 `signal` 参数但从未使用，JSON 响应体读取无超时、不可中止**
原因：签名 `readRemainder(head, signal)`，函数体内 336-342 的 `head.reader.read()` 循环既不 race deadline 也不挂 abort 监听（345 行的 `signal` 只用于事后错误分类）。对照同文件：`readSse` 每次读都 race `deadline` + `signal`（465-489），`headRead` 也有 deadline（276-300），唯独非 SSE JSON 分支的补读没有任何 watchdog。`postStreamed` 的 JSON 分支（412 行）走到这里后就脱离了所有中止机制。
风险：上游发出 HTTP 200 + JSON/HTML 体、读完嗅探头部后 stall 时，本轮请求无限挂起，调用方 abort 也取消不掉；连接与内存保持占用，只能靠 undici 默认 bodyTimeout 兜底（**是否被 egress 层 dispatcher 配置覆盖：待人工确认**，未在本次范围内证实）。
修复建议：与 `headRead`/`readSse.next` 同构——用 `Promise.race([reader.read(), aborted/deadline])`，finally 里清理 timer 与 abort 监听；或在 `deadlineFor` 之上给整个 remainder 读取设总预算。

---

## 🟡 一般

**[🟡] index.js:363-368、586-594 - dispose 竞态分支把句柄置为 `undefined`，随后立即解引用，TypeError 被 catch 吞成误导性错误**
原因：三处「dispose 已落，立刻回收」的补丁（forward 363-366、chanRelay 586-590、outletRelay 727-730）把句柄置为 `undefined`，而全文件哨兵值是 `null`（所有判空都是 `!== null`）。`forward = undefined` 后 368 行马上读 `forward.fellBack`，`chanRelay = undefined` 后 594 行读 `chanRelay.port`——TypeError 被 `syncForwardOnce` 的 catch（372-375）捕获，写成 `forwardError = "Cannot read properties of undefined…"`。outletRelay 分支（727-730）之后无解引用，无此问题。
风险：dispose 竞态窗口内（热重载/卸载瞬间服务刚起）面板显示一条莫名其妙的「forward listener could not start」；且 `forward` 变成 `undefined` 后，后续 `syncForwardOnce` 的早退判断 `forward !== null`（325 行）为真，`forward.host` 会再抛 TypeError——本代已 dispose 时影响有限，但错误状态具有误导性。
修复建议：dispose 分支保持哨兵一致（置 `null`），置空前先把 `fellBack`/`bindError` 捕获到局部变量再计算 `forwardNotice`；或 dispose 检测后直接 `return`。

**[🟡] src/forward.js:1157-1173、1229-1235 - Responses 流式收尾按「播报槽位」位置回放，中间调用被截断过滤时错位**
原因：`announceCall` 为每个播报的 function_call 占一个 `order` 槽位；收尾时 `for (const entry of order)` 用 `finalCalls[callPos++]` 位置回放。位置回放的隐含假设是「播报过的调用与幸存调用一一对应」，但 `executableCalls`（1066-1074）会在 `truncated === true` 时把参数没解析完的调用整体剔除——若被剔除的是**中间**某个已播报的调用，后面的幸存调用会顶进前者的槽位：流式参数 delta 记在 `fc_N` 名下，最终行的 `call_id`/内容却对应另一个调用。另外播报用 `item_id`/`call_id: fc_N`，最终行用 harness 侧 `call.id`（1234 行），两套 id 空间不一致，靠 `call_id` 关联流式增量的客户端会错配。
风险：仅出现在「同一轮多个工具调用 + 输出上限把中间某个调用的 JSON 截断」的组合场景；届时客户端把 A 调用的参数流拼到 B 调用的结果上（对真实客户端的实际影响：**待人工确认**，取决于客户端是只读 `response.completed` 还是合并增量）。
修复建议：收尾回放改为按调用身份（`callIndexes` 里存 harness call id，与 `finalCalls` 按 id 对齐）而非纯位置；被过滤的调用在流内补一个移除/失败语义的帧，或 `finalCalls` 播报与回放统一用同一 id。

**[🟡] index.js:105-113（文档承诺）vs 184-186、889、1530-1538 - `managed` 分发模式未按承诺停用热重载，`POST /reload` 仍然可用**
原因：模块文档声明 `managed` 安装「the updater, the announcement channel and hot reload stand down」（避免 pack 管理器与插件双写同一安装目录）；但 185-186 行注释自认 `managed` 语义「未实现，属 t6 待实现项」，`hotReload: reloadFromDisk` 无条件传入路由（889），`POST /reload`（1530-1538）对 managed 安装照常生效。当前「升级接线」只剩热重载（自更新器/公告中心已删，残留键读入即剥，1383-1390），无远端下载代码，故无下载校验问题——缺的是这条已文档化的门。
风险：经分发包安装（managed）的环境里，本机调用方过围栏后 `POST /api/our-free-model/reload` 即可与 pack 管理器并发改写安装目录，损坏安装；与文档承诺相悖。
修复建议：`distribution === 'managed'` 时不注册 `hotReload`（或路由内返回 409/501 并说明原因），把 t6 落地；同时更新模块文档与实现一致。

**[🟡] src/http.js:106-107、152 - `classifyFailure` 子串启发式过宽，普通错误可被误判为 REGION_BLOCKED / MODEL_UNAVAILABLE**
原因：`/not available in your country|region/i` 会命中任何含 "region" 一词的错误消息（如 "invalid region parameter in request"），`/model is unavailable|not supported/` 同理。这些分类直接决定可用性探测的判定（REGION_BLOCKED 归入区域门控语义）与重试策略（4xx CLIENT 不可重试 vs REGION 走重探）。
风险：上游文案变化或含敏感词的普通 4xx/5xx 被归为「区域受限」，模型在面板上长期挂着错误的「地区受限」判定，或反过来错过本应触发的重探。
修复建议：把裸 `region`/`not supported` 收紧为短语级匹配（如 `not available in your (country|region)`、`model .* (is )?unavailable`），并优先依赖结构化 `type` 字段（`RegionError`/`ModelError`）——这部分已正确，只需收窄兜底正则。

**[🟡] src/http.js:535、src/stream.js:136-137/148 - 流式路径缺累计长度上限，恶意/异常上游可放大内存**
原因：`readSse` 的行缓冲 `buffer += decoder.decode(...)` 在上游持续输出**不含换行**的字节时无上限增长（`RAW_JSON_LIMIT` 只约束 rawJson 累积，450 行，不约束行缓冲）；`BlockSink.text/reasoning` 的 `block.text += …` 无上限（`answerText`/`reasoningText` 有 `checkpointLimit` 封顶，但随流转发用的 `block.text` 与最终 `block-end` 载荷没有）。`postStreamed` 对响应体也没有总量上限。
风险：上游在本车道是半信任方（固定网关）；网关异常或被劫持时，单请求可拖起数百 MB 内存（OOM 面），或把超大 `block-end` 帧整体交给下游。
修复建议：`buffer` 设硬上限（如 8-32MB，超限按 `CODE.transport` 断流，与 rawJson 一致）；`block.text` 设独立上限（超过即截断并置 `checkpointTruncated` 语义）。

---

## 🟢 建议

**[🟢] src/forward.js:1029-1031、1044-1046、1049-1054 - chat 流式收尾路径未判 `res.destroyed`，与同函数其他分支不一致**
原因：流式分发回调里有 `if (res.destroyed) return`（977 行），错误分支（1016 行）也有，但 `outcome.error` 收尾（1029-1031）、`suppressed` 收尾（1044-1046）与正常收尾（1049-1054）的 `sendSse`/`res.write`/`res.end` 没有。已实测：Node 20 上对已销毁响应 write 返回 `false`、不抛异常、不触发未捕获错误——是「无害但不一致」。
风险：无崩溃风险；仅在客户端已断开时做无效写入，日志/语义上噪音。
修复建议：统一收敛到一个 `safeEnd()` 辅助（内部判 `res.destroyed`），三处收尾共用。

**[🟢] index.js:1283-1293 - `every()` 对同步抛错的 task 无防御，一次异常即静默杀死整个循环**
原因：`tick` 里 `task()` 在重臂 `setTimeout`（1288）**之前**执行且无 try/catch；现有三个调用方都用 `void (async…)().catch()` 包裹故不触发，但 `every` 作为通用原语，未来一个同步抛错的 task 会让探测循环无声停摆，无任何日志。
风险：后续维护引入同步异常时，可用性探测/出口监视静默停止，难以察觉。
修复建议：`try { task() } catch (e) { logger.warn… }` 包住 `task()`，保证重臂必达。

**[🟢] index.js:1597-1603 - settings 写盘失败的回滚发生在副作用之后，`autoReloadWatch` 可能与实际 watcher 状态脱节**
原因：顺序是 `update → flush → onSettingsChanged()（syncWatcher）→ writeFailed 检查 → 回滚 value`。若本次 patch 打开 `autoReloadWatch` 且写盘失败，watcher 已启动、value 又回滚，直到下次 onSettingsChanged 前二者不一致。
风险：极小（需同时满足写盘失败 + 恰好改该开关）；表现为「设置显示关、实际在文件变化时热重载」。
修复建议：把 writeFailed 检查移到 `onSettingsChanged` 之前，失败即回滚并返回 500，不触发副作用。

**[🟢] src/http.js:502-516 - `line()` 的 rawJson 启发式会误吞「data 续行恰好以 `{` 开头」的多行 SSE 事件**
原因：任何以 `{` 开头的行直接进入 rawJson 累积（504 行），若同一事件此前的 `data:` 行已在 `data[]` 里，会被 505 行的 `dispatch()` 提前结算，续行则被并进 rawJson 等待拼成完整 JSON。注释（448-450）自认是历史行为。
风险：多行 `data:` 且续行形似 JSON 的流（罕见）会被拆错事件；对当前网关的单行 JSON 帧无影响。
修复建议：仅在 `data[]` 为空时才走 rawJson 启发式；或仅在流首个有效行就判定 raw-JSON 模式后保持该模式（现在部分做到，可再收紧）。

**[🟢] src/http.js:406 - `shape === 'empty'` 抛错路径未取消响应体 reader**
原因：`readHead` 返回后，`empty` 抛错是唯一没经过 `readRemainder`/`replayStream`（两者都会排干或取消）的出口。实际只有「≥4096 字节全空白 + 未 done」的病态响应才会走到，通常 body 已读尽（done=true）无泄漏。
风险：极边缘的连接滞留，GC/undici 兜底。
修复建议：抛错前 `if (!head.done) await head.reader.cancel().catch(() => {})`。

**[🟢] 重复逻辑 - 五份「in-flight 串行化门」与三份「key 铸造」逻辑完全同构**
原因：`syncForward/syncRelay/syncChanRelay/syncEgress/measureGatewayLatency`（index.js:311-317、420-426、543-548、640-650、675-683）是同一模式的五次复制；`forwardKey/relayKey/chanRelayKey`（378-385、392-399、499-506）同构。
风险：修 bug（如上面的哨兵不一致）需要改五处，易漏。
修复建议：提取 `serialize(key, fn)` 与 `ensureKey(store, path)` 工具。

**[🟢] 坏味道 - 巨型函数**
`apply`（index.js:161-1336，约 1175 行）、`createApiRoutes` 的 handler（1457-1679，约 220 行）、`responsesEndpoint`（forward.js:1106-1268）、`messagesEndpoint`（1286-1413）、`relay`（564-716）。注释密度高是主因，但 handler 的路由分发与各 settings 子分支可拆。
修复建议：路由表化（method+path → handler 映射），`apply` 按监听器/出口/API 三节拆文件。

**[🟢] 魔法数字**
`src/deferred-response.js:33` 的 `64 * 1024`（缓冲提交阈值，无注释）；`index.js:280` 的 `2500/5000`（出口冷却等待，无命名）；`index.js:1292` 所在 `every` 的周期虽可配但 120_000（1321 行）固定值无命名。其余关键常量（SNIFF_BYTES、RAW_JSON_LIMIT、SSE_HEARTBEAT_MS、OUTLET_STABLE_MS 等）均已具名且有注释，属良好实践。
修复建议：具名化上述三处即可。

---

## 确认无误的部分

1. **硬编码密钥/敏感信息**：四文件 grep 无任何明文凭据（`src/upstream.js:351` 的 `Bearer public` 是免费车道公共令牌，非机密）。密钥治理整体到位：`generateKey` 用 `crypto.randomBytes(24)`（forward.js:100-102）；比较走 `timingSafeEqual` 且先比长度（105-110）；密钥只经围栏内路由回显，日志只输出固定字段、明确不落请求头/错误文本（index.js:882-886）；订阅 URL 视为凭据、常规载荷只给掩码 `urlLabel`（index.js:1901-1910）；settings 文件 0600 + temp/rename + 损坏自动备份（store.js:104-128、53-68）。
2. **命令注入 / 路径穿越 / SSRF**：`openExternal` 用 `execFile` 参数数组无 shell，URL 白名单 http/https、禁内嵌凭据、2048 上限，PowerShell 单引号转义正确（open-external.js:8-34）。API 路由全部精确匹配、无 fs 路径拼接；LAN 中继上游固定 `127.0.0.1:targetPort`（forward.js:682-688），无用户可控 SSRF 面。绑定前 `resolveLoopbackBind` 做 DNS 全解析并拒绝任何可路由答案（forward.js:182-203），防 hosts 文件绕过，设计扎实。
3. **信任围栏**：API handler 的 URL 解析先于围栏且解析失败兜底 400（index.js:1463-1477，注释明确防畸形 URL 绕过围栏）；连接服务抛错时 fail-closed 503（trust.js:110-113）；`/events` 独立路由同样先过围栏（index.js:1185-1193）。中继防自拨：`x-ofm-relay-hop` 判定覆盖面板与推理两类请求（forward.js:606-609）。
4. **failureReply / openAiError 在 headersSent 后的行为（疑点核实）**：所有调用点均正确——顶层 catch 与中继错误分支都守 `!res.headersSent`（forward.js:333-340、559-561、707-708）；三个流式端点在头已提交后一律改用流内错误帧收尾（1023-1032、1205-1215、1406-1411）；`failureReply` 自身 headersSent 即让位（159-168）。`deferred-response` 层让「首个 delta 提交前」的失败仍能拿到真实状态码（writeHead≥400 清空缓冲并立即提交，deferred-response.js:19-24），与 `serveCompletion` 的 `staged.commit()` 配合正确，属刻意且正确的设计。
5. **SSE 解析容错（疑点核实）**：`readSse` 对畸形输入的容忍是充分的——非字符串块跳过、JSON 解析失败跳过（stream.js:541-545）、CRLF/BOM 归一（http.js:503）、多行 data 合并、兼容省略空行分隔的连续 JSON 事件（522-526）、原始 JSON 体逐行重装（504-515）、`[DONE]` 两种拼法都识别（493、499、525）、尾部不完整 JSON 报 transport 错（552）、解码器收尾 flush 防丢多字节字符（548-550）。流内错误帧分类正确并带 `upstream` 原文（stream.js:546-561）。已发现的唯一启发式缺陷见 🟢-rawJson 项。DSML 清洗器对「引用原文会丢字符」是有注释的刻意取舍（stream.js:22-31）。
6. **定时器清理（疑点核实）**：逐一核对全部有清理路径或等效兜底——`outletRestartTimer` dispose 显式清理（index.js:1226）；`every()` 句柄经闭包清理（1292）且重臂句柄可被最新清理命中；`watchPackage` 的 stop 函数清 watcher+timer 且被 `ctx.effect` 持有（reload.js:264-268、index.js:881）；forward 心跳 unref + `res.once('close')` 自停（forward.js:832-842，返回的 stop 被丢弃但有 close 兜底）；`deferStreamResponse` 的 timer 有 finish/close/dispose 三重清理（deferred-response.js:41-42）；push hub 心跳随最后客户端断开自停、dispose 全清（push.js:33-42、84-90）；JsonStore dispose 清理 + 终写（store.js:130-140）；`settleOutletWatch` 的 5s 延迟定时器未显式清理，但 unref + disposed 守卫，无实际影响。`chanGatewayCredentialCached` 的 5s TTL 有注释论证（index.js:524-541）。
7. **fetch 与 signal（疑点核实）**：`postStreamed` 全程透传 signal（http.js:383），且 abort 语义按「调用方取消 vs 自身超时」区分（388 行注释）；`getJson` 自建 controller，header 与 **body（`response.text()`）** 都在其 15s 预算内（565-591）；`headRead`/`readSse.next` 每次读都 race deadline+abort，并兜住落败 read 的 rejection（276-300、465-489）；`egressFetch` 原样透传 signal（egress.js:118）；`serveCompletion` 把 req aborted / socket close / res close 三路合到同一幂等 abort，finally 移除全部监听（forward.js:743-791）；`/bench` 绑定 res close 并 finally 移除（index.js:1660-1673）。范围外抽查 probe/model-test/kilo/adapter 的调用方均传入 signal 且清理定时器。唯一例外即 🔴-readRemainder 项。
8. **升级接线（疑点核实）**：当前不存在下载/自更新代码路径——旧公告中心与自更新器已删，其历史 settings 键读到即剥（index.js:1383-1390）；「升级」仅剩热重载一条线：`selfReload` 单飞互斥（reload.js:31-36、123-124）、缓存 purge/回滚双路径（74-114、176-179、205-227）、重载后旧 generation 靠 `disposed` 旗标全面退位（index.js:205-206、1208-1227），boot 链每个 await 后都有 disposed 检查（1229-1263）。唯一缺口见 🟡-managed 项。
9. **数据正确性其余面**：`bindForwardPort` 重试/扫描边界正确（requested+offset ≤ 65535，forward.js:301-311）；`listenOnce` 成功/失败两路都成对摘除 once 监听（246-260）；`readBody`/`readJson` 有大小上限 + 非对象体 400（forward.js:124-146、index.js:1694-1710）；`createToolWire` 的 held/classified 状态机对「参数先于名字到达」与 decoy 抑制处理正确（858-916）；`toolKey` 的 index/id/lastToolKey 三级归属有注释论证（stream.js:95-108）；`mapUsage` 对缺失 cache 明细防 NaN（224-241）、`sanitizeUsage` 对超窗 usage 的丢弃规则有 issue 引用（262-279）；Responses 播报 `nextOutputIndex` 分配无冲突（forward.js:1150-1173）。
