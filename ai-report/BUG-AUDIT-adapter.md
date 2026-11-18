# 适配器与生命周期审计报告（adapter/messages/anthropic/egress/upstream/reload/recovery/trust/kernel）

日期：2026-11-19
范围：`src/adapter.js`、`src/messages.js`、`src/anthropic.js`、`src/egress.js`、`src/upstream.js`、`src/reload.js`、`src/recovery.js`、`src/trust.js`、`adapter/kernel.js`（共 4524 行，逐行通读）
方法：每个问题均先读代码验证；关键项做了实证——① `dir` 作用域问题用同构 Node 脚本复现出 `ReferenceError`；② 内核契约对照 `node_modules/@deepseek-ai/dsh-llm/lib/index.js`（LlmAdapter 基类 + prepareRoutes 校验体）逐方法核对；③ 约束用全仓 grep 验证。

---

## 🔴 严重

**[🔴] src/egress.js:232-233 - close() 引用块外变量 `dir`，凭据文件清理是永不生效的死代码（异常被吞）**
- 原因：`dir` 在 `startEgressRelay` 的 `else`（subscription 分支，行 151）内声明，而 `handle.close()` 定义在函数体层（行 225-234）。`close()` 里 `path.join(dir, …)` 求值抛 `ReferenceError: dir is not defined`，被行 232/233 各自的 `try { … } catch { /* best-effort */ }` 静默吞掉。已用同构脚本复现：subscription 与 client 两种模式下均抛 ReferenceError。
- 风险：行 230 注释声称的「2026-11-08 终审 R13：进程退净后把落盘的配置文件清掉，不留凭据在盘上」**从未生效**——含订阅 URL（bearer 凭据）与控制 secret 的 `mihomo.yaml`、`egress-provider.yaml` 在每次 close 后都留在数据目录里；且因为是静默吞异常，永远不会有人发现。client 模式下同样抛错（只是无文件可清，暂无额外危害）。
- 修复建议：在 `if/else` 之前声明 `let dir = ''`（或 `let dataPath = null`），清理处改为 `if (managed !== null) { … }`；或直接用已有的 `managed.dir`。顺带让清理失败至少 `log` 一行。

---

## 🟡 一般

**[🟡] src/reload.js:158-175 - 重载的新代码没有任何完整性校验，「升级链路的校验」在本仓不存在**
- 原因：`selfReload` 对磁盘上的新代码只验一件事：`typeof replacement.apply === 'function'`（行 163/172）。全仓 grep `download|checksum|sha256|verifySignature|applyUpdate|installUpdate` 在 `src/`、`index.js`、`scripts/` 均无命中——任务描述中的「下载/校验/备份/替换」链路并不在本仓当前代码里，`reload.js` 只做内存热替换。
- 风险：磁盘上被截断/被篡改的包只要能通过 ESM 解析且有 `apply` 导出就会被加载；代码内容级损坏（如半截写入恰好可解析）没有任何校验点。内存层的回滚（见下条）能兜住「加载即失败」，兜不住「加载成功但行为损坏」。
- 修复建议：若上游升级器（内核侧）确实负责下载与校验，在 `reload.js` 模块头写明这一分工；否则在 re-import 前对包内文件做一次哈希/清单比对，或至少校验 `package.json` 的 `version` 与更新目标一致。

**[🟡] src/reload.js:183-189 - dispose 旧 fiber 无超时，挂死一次后 `isReloading()` 永久为 true，所有后续重载被拒**
- 原因：`await Promise.all(fibers.map(({ fiber }) => fiber.await()))` 没有任何超时。`inFlight` 只在 promise settle 后经 `finally` 清空（行 230）；一个 dispose 永不结束的 fiber 会让 `inFlight` 永不清除，此后 `isReloading()` 恒 true，`reloadFromDisk`（index.js:854）与文件监听路径全部被 "a reload is already in progress" 挡死，且无法从插件内恢复。
- 风险：一次挂死的 dispose = 该插件的热重载能力永久失效（直到进程重启），且没有任何日志区分「正在重载」与「已挂死」。
- 修复建议：给 dispose 加预算（如 30s，超时后记 warn 并继续走替换，或走"restoreCaches + 返回 ok:false"），并让 `inFlight` 在超时分支也能清空。

**[🟡] src/reload.js:106-114 - restoreCaches 部分失败被逐条吞掉，返回值仍宣称 restored:true**
- 原因：`restoreCaches` 对每个条目两层 `try/catch { /* best effort */ }`，失败的条目既不计数也不上报；`selfReload` 的失败分支（行 178/208/224）拿到的永远是 `restored: true`。
- 风险：缓存恢复半途失败时，进程里同时存在新旧两代模块（注册表是旧的、loadCache 里残留新的），调用方与设置页都以为已安全回滚——这是比抛错更难排查的漂移态。
- 修复建议：统计失败条目数并计入返回值（如 `restored: 'partial'` 或附 `restoreFailures` 字段），至少 log 一行。

**[🟡] src/adapter.js:900 vs 631-639 - 两条成员路径对 4xx/region 的「换人」语义相反**
- 原因：`runSingle` 的 `advanceVerdict` 里 `advance: shouldAdvance(verdict) || code === CODE.client || code === CODE.region`——`shouldAdvance` 对请求级 4xx（`client_error`：retryable=false、cooldownMs=0，见 route/classify.js:169）本来判 false，但这个 OR 强制把它翻成 true；region 同理。而 `runChannel`（行 637-639）严格遵守 `shouldAdvance(verdict)`，其注释（行 624-627）明确写着「region_blocked / authorization_required / 请求级 4xx 这类『换成员也没用』的失败不再连撞整条链」。同一类失败：免费车道成员会把整条链撞完，渠道成员不会。
- 风险：上下文超限/参数错这类 request-scoped 4xx 在含免费成员的链路上逐个成员重放同一份 body（每个都 400），浪费配额并拖慢失败回报；两条路径行为漂移也说明这个 OR 缺少成文的理由（代码处无任何注释解释为何 OR `CODE.client`/`CODE.region`）。
- 修复建议：二选一对齐——要么删掉 OR 子句与 runChannel 对齐，要么把「模型个体差异导致的 4xx 值得一试下一个模型」写成两处共享的注释并让 runChannel 同样豁免。

**[🟡] src/messages.js:96-108 - repairToolPairing 依赖「调用先于结果」的消息顺序，畸形/重排历史会把合法 tool 结果整条丢弃**
- 原因：两趟扫描，第二趟处理到结果消息时，`keptCalls` 只包含**已在更早消息里处理过的** assistant 调用（行 98 注释自认 "a call always precedes its own answer"）。若上游/转发调用方送来的历史里 `role:'tool'` 行排在对应 assistant 调用之前（转发监听器接受外部 OpenAI 调用方，消息顺序不由本插件控制；或历史被外部工具重排），这些结果因 `keptCalls` 尚空而被丢弃（行 100-102），对应的 assistant 调用随后又因「无结果」被删——配对双方一起消失。
- 风险：合法对话历史被静默截短，模型看到的是「从未调用过工具」，行为漂移且无任何告警。对宿主自身会话（V3/V4 格式）顺序有保证，影响面限于 forward 监听器的外来负载。
- 修复建议：第一趟先收集全部 assistant 调用 id（不只是 answered），第二趟再按结果归属过滤；或对「结果先于调用」的情况放宽为保留并交上游裁决。

**[🟡] src/messages.js:413-415 与 228 / 313 / 368 - 工具名 128 截断只作用于工具声明，不作用于历史回放与响应还原**
- 原因：`toToolDefs` 把三个线的声明名截到 `MAX_TOOL_NAME_LEN`（128）；但历史里的 `tool-call` 块经 `toChatMessages`（行 228）/`toClaudeMessages`（行 313）/`toResponseInput`（行 368）回放时用 `String(block.name ?? '')` 原样发送，无截断、也无 alias 映射（`applyFingerprint` 的别名有 `restoreToolName` 还原，长度截断没有对应机制）。
- 风险：调用方工具名 >128 字符时（MCP 长名工具现实存在），声明与历史回放不一致——严格上游按「未声明的 tool 名」回 400；响应侧模型叫的是截断名，调用方不认识，工具调用链断裂，且无告警。
- 修复建议：回放路径对超长名做与声明一致的截断（配合一个与 alias 同形的还原表），或在 `toToolDefs` 阶段对超长名直接拒发并给 warning，而不是无声截断。

**[🟡] src/egress.js:227-233 + index.js:697,1212 - 生命周期收尾的错误被双层吞掉，失败不可观测**
- 原因：`close()` 内部的清文件已在 🔴#1 中被吞；向上，index.js 的 dispose 与同步路径 `await closing.close().catch(() => {})` / `void outletRelay?.close?.()` 再吞一层。`killChild` 里 `proc.kill()` 的失败也只留注释。
- 风险：出口代理「关没关干净」（子进程是否真的退了、凭据文件是否还在、端口是否释放）在日志里完全不可见；叠加 🔴#1，R13 清理失败从设计预期变成了必然且无声。
- 修复建议：`close()` 返回/记录清理摘要（child exit code、被毁 socket 数、rm 结果），调用方至少把非零结果打 warn。

---

## 🟢 建议

**[🟢] src/upstream.js（全文）- 如实澄清：本文件没有重试逻辑；真正的重复代码是「三个 48 位 id 铸造器」与「两套 classifyFailure」**
- 逐行核对：`upstream.js` 内无任何重试/退避循环。重复代码的实际位置：
  - `canonicalizeSession`（166-173）、`mintSessionId`（204-211）、`mintRequestId`（219-224）三处各自手写「BigInt 移位 + 6 字节 hex 渲染」循环（208-209 与 221-222 逐字重复），只有 `base62Fixed/base62From` 抽了公共函数；
  - `src/http.js:90` 的 `classifyFailure(status, payload, retryAfterMs)` 与 `src/route/classify.js` 的 `classifyFailure({code,message})` 是同包内两套语义重叠的失败分类器（wire 层 vs 路由层），`adapter.js` 只用后者、`http.js` 只用前者，规则表各自维护，未来漂移风险真实存在。
- 建议：抽一个 `hex48(value)` 助手；在两个 classifyFailure 的头部互相注明分工与「改规则要同步」的清单。

**[🟢] src/upstream.js:204-211 - mintSessionId 同一毫秒内铸造超过 63 次会漂出上游接受的低 12 位窗口**
- `seq` 只在毫秒翻页时归零；`~(ts*0x1000+seq)` 的低 12 位是 `0xfff - seq`，窗口只收 `seq 1..63`。同毫秒第 64 个 id 起落出 `0xfc0–0xfff`，上游 403。当前 `mintSessionId` 仅探测脚本使用（grep 验证：src 主路径只用 `canonicalizeSession`），影响有限。
- 建议：加一行注释声明上限，或 `seq > 63` 时人为等待下一毫秒。

**[🟢] src/adapter.js:248, 481 - runCombo / runChannel 开头的 `settings` 是死变量**
- 两处声明后全函数无引用（awk 验证：runCombo 内除声明与注释外零命中）。建议删除，避免读者误以为链路/渠道路径受 `settings.enabled` 之类的开关影响。

**[🟢] src/adapter.js:185-209 - 迭代器被调用方丢弃且不 abort 时，底层请求会一直跑到总时限（最长 30 分钟）**
- `stream()` 只在 `done/throw/return` 时 cleanup；宿主正常契约会 abort `options.signal`（会传播），但若某内核代在放弃消费时不 abort 也不 return，生成器停在 yield 处，`policy.totalTimeoutMs`（上限 1800000ms）内请求与定时器都活着。
- 建议：在模块头或 `stream()` 注释写明「放弃消费必须 abort 或 return」的契约假设。

**[🟢] src/trust.js:137-159 - 结构围栏只验调用方自报的 Host 头，不核对 `req.socket.remoteAddress`**
- DNS rebinding 防御依赖 Host 头合法性；「只有本机进程能到」这一保证实际来自别处 listener 的 loopback bind（行 31-35 注释亦承认）。若某组合错误地把监听绑到 0.0.0.0，本围栏不会拦远程调用方（其 Host 可写 localhost）。属纵深防御缺口，非可利用漏洞。
- 建议：`structuralReason` 里加一条 `net.isIP(remoteAddress)` 后判断 loopback，一行的代价买到独立于 bind 配置的保证。

**[🟢] src/anthropic.js:333-339 - ensureState 不修复 openIndex 与 openBlock 的一致性**
- 调用方若种入 `openBlock:'text'` 但漏了 `openIndex`，后续 `contentDelta(state.openIndex, …)` 会发出 `index: undefined` 的帧。ensureState 修复了 blockIndex/toolSlots/tokens，唯独漏这对。建议补一行：`if (state.openBlock !== null && !Number.isSafeInteger(state.openIndex)) state.openBlock = null`。

**[🟢] src/anthropic.js:729-740 - foldAnthropicOutcome 在畸形 chunk（index 为 undefined）时会把不相干的调用并进同一槽**
- `find(candidate => candidate.slot === chunk.index)` 在 `chunk.index === undefined` 时匹配第一个同病条目。仅畸形输入触发，建议 `Number.isSafeInteger(chunk.index)` 前置。

**[🟢] src/messages.js:247-260 - Claude 线丢弃远程 URL 图片而 Chat 线照发，同一会话不同线行为不一致**
- `claudeImageBlock` 只放行 `data:` 且 media 在四类白名单内的 URL，`https://` 图片一律 'image-dropped'（Chat 线 `toChatMessages:204` 原样发 `image_url`）。若免费车道 `/messages` 端点确不支持 URL source，这是保守正确；建议在 `claudeImageBlock` 注释写明「上游不接受 url source」，否则接手者会当成 bug「修」回不一致。

**[🟢] src/egress.js:618-629 - killChild 在 SIGKILL 后不等待退出；close() 未清 mihomo.log**
- SIGKILL 发出后立即返回，子进程可能再活几毫秒（Node 内部 SIGCHLD 会收割，无僵尸风险）；`close()` 清了两个 yaml 但留下 `mihomo.log` 持续增长。建议 SIGKILL 后再等一次 exit；清理 log 可选。

---

## 确认无误的部分

1. **内核 import 边界（约束①）**：全仓 grep `@deepseek-ai` —— `src/**`、`index.js`、`client.js` 命中的全部是**注释/字符串文案**（packages/standalone 内是打包产物的提示文本），唯一的真实 import 是 `adapter/kernel.js:42` 的 `await import('@deepseek-ai/dsh-llm')`，且为惰性加载、失败时降级到字面量 UA。约束遵守 ✓（与 ai-report/kernel-seam-audit.md 的结论一致）。
2. **禁止 instanceof 内核类（约束②）**：9 个文件中全部 `instanceof` 为 `Error`（adapter.js:842、kernel.js:47）、`Request`（egress.js:109）、`Map`（anthropic.js:336、reload.js:152——Map 不是内核类，且该处仅用于诊断分支）。无任何内核类 isinstance 检查 ✓。
3. **三方法签名与内核鸭子类型逐项核对（对照 node_modules/@deepseek-ai/dsh-llm/lib/index.js:1670-1876 实测）**：
   - 内核 `registerAdapter → prepareRoutes` 只做结构化校验（`providerInfo()` 返回值、`providerRetryPolicy()` 期望值），**无 instanceof**；`FreeModelAdapter` 未继承 `LlmAdapter` 基类，纯鸭子类型 ✓。
   - `listModels(provider)`、`resolveModel(provider, model)`（内核多传的 `_signal` 被忽略，契约允许）、`prepareCall` 返回 `{model, stream}`、`stream(options)`、`providerInfo` 返回 `{id, name}` 且 `id === provider`（ROUTE_LABELS 按路由键控，两条路由各得其所）、`providerRetryPolicy()` 顶层平铺 delay 字段（嵌套会 NaN 的坑有注释与 issue 支撑）、`imageRequestPricing` 保持同步——全部与内核契约兼容 ✓。
   - `prepareCall` 冻结 snapshot/entry 防止目录刷新中途错配，是对内核「bind one adapter generation」要求的历史实现 ✓。
4. **egress 子进程生命周期主干**：spawn 前置失败（binary 不存在/不可执行、URL 为空、listen 失败）与 `waitForPort` 超时两条错误路径都先 `killChild` 再抛（行 188、210）✓；`close()` 顺序正确（先摘 `activeRelay` → 毁 socket → close server → kill child）✓；`killChild` 先 `removeAllListeners('exit')` 恰好抑制了 close 路径上的死亡告警误触发 `onDead` 重启 ✓；`waitForPort` 的 `check()` 在 spawn error/提前退出时立即抛出，不会空转 15 秒 ✓；每次 start 重铸 relay key 与 mixed 端口口令，旧凭据不开新门 ✓；死亡自动重启有指数退避（index.js:753-764）✓。遗留问题即上文 🔴#1 与 🟢 两条边缘项。
5. **sameSecret 时序安全**（egress.js:632-636）：长度先行 + `timingSafeEqual`，长度泄露对 32 字符随机 hex 无信息量，实现正确 ✓。**trust.js 内不存在任何密钥/签名比较**（它是 Host/Origin/Referer 结构围栏），「签名校验被时序绕过」在该文件无攻击面 ✓。
6. **trust.js 围栏语义**：connection 服务失败 → 503 fail-closed（行 110-113）✓；`admit`/`requestRejection` 双拼写与 `{rejection}` 信封处理与 issue #89 注释一致 ✓；dsh-app Referer 白名单要求无 Origin/无 sec-fetch-site 才放行（行 149），桌面转发无法被伪造 Origin 借道 ✓；`authorityOf` 对 scheme/port 默认值、IPv6 方括号（`[::1]` 在 LOOPBACK_NAMES）、`Origin: null`（解析为 hostname "null" → 不匹配 → 拒绝）均正确 ✓。
7. **repairToolPairing 主路径**：无名调用随未应答调用一并删除（issue #92 的毒丸修复）、空 callId 的 `role:'tool'` 行丢弃、双向配对（有调用无结果 / 有结果无调用）三个方向都覆盖，且修复在三个投影之前统一做（adapter.js:713）✓。已知边界即上文 🟡 的顺序假设。
8. **anthropic.js 块纪律**：并行 tool 槽按 `chunk.index` 独立开闭、name 迟到时 hold 分片再重放（行 502-511、524-539）、`closeAllBlocks` 终态兜底、`state.finished` 先行防双 `message_stop`、错误/中止不发 `message_delta`（防伪造成功收尾）——自洽 ✓；`anthropicMessage` 的 stop_reason 优先级（truncated > tool_use）与截断 JSON 降级 max-tokens 的约定一致 ✓。
9. **recovery.js**：纯函数、`canRecover`（无终帧）与 `canRecoverSilentStop`（有终帧）只差 `sawFinish` 判据；`checkpointFits` 用字节保守估算且对图片做占位降权；`addUsage` 只累计有限数值——与 `adapter.js` 的 `classifyStreamOutcomes` 判据逐字对齐（其注释明确警示过漂移教训）✓。
10. **upstream.js session 编码门**：`SESSION_DESCENDING_RE` 与 `canonicalizeSession`（counter=1 恒落 `0xffe`）保证确定性映射；session-map 4096 条上限 + 插入序淘汰 + tmp/rename 原子写；加载侧用 `SESSION_RE` 复验，坏数据自动废弃 ✓。
11. **renderMihomoConfig 注入安全**：subscription/secret/auth/logFile 全部经 `JSON.stringify` 转义后进 YAML（JSON 流标量是合法 YAML），配置文件以 0600 写入，凭据不进日志（`outletLabel` 只回 host）✓。
12. **adapter.js 其他要点**：`toFailure` 白名单字段 + status/RetryAfter 数值校验，保证可无损 JSON 往返（durable log 约束）✓；`commitsAnswer`（导出给 standalone 复用）与 `sawAnswer`/`delivered` 三个视图的定义互相印证且有对照注释 ✓；`buildPayload` 对空输入的占位（'...'）防止空 messages 400 ✓；combo 提交后禁期作废（`chainCooldown.delete`）与轮询「成功不动游标」的语义按注释约定实现 ✓。
