# 独立版（packages/standalone + channel-pack 账号池/签到）代码审计

- 日期：2026-11-19
- 范围：`packages/standalone/service.mjs`、`management.mjs`、`cli.mjs`、`login-terminal.mjs`；`vendor/channel-pack/src/account-pool.ts`、`token-ledger.ts`、`auto-checkin.ts`
- 方法：只读审计；每个结论均先读代码并交叉验证依赖契约（`src/forward.js`、`src/adapter.js`、`src/combos.js`、`src/core/completion.js`、`src/core/runtime.js`、`src/trust.js`、`src/store.js`、`packages/standalone/channels/runtime.mjs`、`worker.mjs`）。
- 基线：HEAD = 455130d（advancePastMember 的 answered/delivered 拆分），审计确认该修复本身与意图一致，漏网场景见 🔴-1 / 🟡-2。

---

## 问题清单

[🔴] packages/standalone/service.mjs:416-424, 437-456 - 成员「已提交后抛异常」时 `return result` 返回 undefined，下游对 `result.error` 取属性直接 TypeError

原因：`completeCombo` 里 `result` 与 `thrown` 是两个独立变量（L416-424）。当成员已经提交（`answered === true`，held 已放行、正文已写给客户端）之后 `complete` 才抛异常（`channels.complete` 的 Worker 在流中报错会 reject——`channels/runtime.mjs:51`；客户端断连触发 abort 时 `call()` 也以 reject 收场——`channels/runtime.mjs:60-63`），此时 `advancePastMember({answered:true, hasHandler:true, thrown})` 正确地返回 false（已交付不换人），代码随后走到 `noteComboServed(...)` 并 `return result`（L447-456）——但 `result` 从未被赋值，是 `undefined`。
风险：调用方 `src/forward.js:780` 在 `await complete(...)` 返回后无条件读 `result.error`，对 `undefined` 取属性抛 TypeError。已核对该 TypeError 的三种下游表现：① 非流式路径不受影响（`handler === undefined` ⇒ `delivered` 恒 false ⇒ 要么 advance 要么抛「链耗尽」，到不了 fall-through）；② 三个流式端点的 `await complete(...)` 都包在 try/catch（forward.js:1011/1195/1390），TypeError 被捕获并以**错误帧**发给客户端——但消息是误导性的 `Cannot read properties of undefined (reading 'error')`，而真实失败原因（`thrown`，例如「zcode 额度用尽」）**既不进错误帧也不进服务端日志**（completeCombo 的 warn 只在 advance 分支 L441 打，fall-through 路径无任何日志），彻底丢失；③ 若抛异常由客户端断连的 abort 引起，`res.destroyed` 为真、错误帧不发，无可见影响但原因同样丢失。触发面是常态路径：流式请求「已出正文后上游/Worker 中途报错」（服务注释自述 zcode 额度错误就是抛出来的）。
附带问题：此路径还会把失败成员记进 `noteComboServed`（L447 无条件执行），污染「本轮由谁作答」的诊断口径——插件端只在 committed 且成功 return 时记（adapter.js:329）。
修复建议：catch 分支里同步构造兜底 outcome（与 `src/forward.js:777-778` 的兜底同形），例如 `thrown = error; result = { text: '', toolCalls: [], error: String(error?.message ?? error), failure: { message: ... } }`；或在 L456 前判 `if (result === undefined) return { ...兜底 }`。同时把 `noteComboServed` 移到 `thrown === undefined` 的条件下（或与插件端对齐：已提交后迟到失败不算「作答成功」）。

[🟡] packages/standalone/service.mjs:43-47, 437-443 - advancePastMember 不区分「abort」：客户端断连会把整条链走完，与插件端语义漂移

原因：`advancePastMember` 的判据只有 `delivered` 与 `failed`（thrown/result.error/result.failure）。客户端断连时 `serveCompletion` 立即 abort controller（forward.js:744-757），当前成员以 thrown/aborted failure 收场 → 判为「可换人」→ `continue` 继续试链上其余成员。插件端 `runCombo` 对此有明确豁免：`result?.advance !== true` 时（"an abort, or a failure that arrived after the single-model recovery budget"）**不换人、直接把真实结局交给调用方**（src/adapter.js:367-374；runChannel 同口径 `advance: !committed && !aborted`，adapter.js:611）。
风险：abort 后每个剩余成员都会进一次 `core.complete` / `channels.complete`（好在两边都先查 `signal.aborted` 快速失败，core/completion.js:40、channels/runtime.mjs:56，不产生真实上游请求），纯粹白转一圈；链耗尽后抛「路由链 … 全部成员失败：请求已取消」，把「用户主动取消」伪装成「全链故障」，日志与（若客户端还在读缓冲）错误帧都失真。与「与插件端 runCombo 同一语义」的自述不一致。
修复建议：给 `advancePastMember` 增加 aborted 维度（如 `aborted === true` 时不允许换人），由调用方把 `request.signal?.aborted` 传入；abort 时 break 并抛出/返回 aborted outcome，对齐 adapter.js 的行为。注意与 🔴-1 一并修，避免 abort 路径再踩 undefined。

[🟡] packages/standalone/management.mjs:201-219 - `/api/management/login/terminal` 位于鉴权之前，且其防护（Origin + Sec-Fetch-Site）对非浏览器客户端可整体伪造

原因：该端点在 `authenticated(req)`（L258）之前处理，是「登录前」入口。浏览器侧防护成立（跨站请求的 Origin/`sec-fetch-site` 必不匹配，403 正确拦截）；但两个头对 curl 类客户端都是可随意伪造的普通头。`--lan-panel` 开启时，中继会把 Origin/Referer 改写成上游 authority（forward.js:645-657）、Host 重建为 `127.0.0.1:<targetPort>`，三个检查全部天然通过。
风险：设了 `OFM_PASSWORD` 的部署里，这是唯一一个**无需密码**就能触发的动作端点：同网段攻击者可让服务机反复弹出 Terminal/PowerShell 窗口并把 forwardKey 复制进本机剪贴板（攻击者读不到剪贴板，但构成骚扰与社工面；30 秒限速只减缓不阻止）。与「密码模式下管理面需要鉴权」的模型自相矛盾。
修复建议：密码模式下直接拒绝该端点（410/403）——密码模式下用户不需要剪贴板助手（见下一条，它复制的凭据本就登录不进面板）；或者把它纳入 `authenticated()`。未设密码时该端点同样没有存在价值（见下一条）。

[🟡] packages/standalone/login-terminal.mjs:20-22, 52-54 - 终端助手复制的是 `forwardKey`，而面板登录只认 `OFM_PASSWORD`：功能与鉴权模型脱节（失效）

原因：macOS 分支脚本读 `settings.json` 的 `.forwardKey` 复制到 pbcopy（L20-22），Windows 分支读同一个字段进 `Set-Clipboard`（L52-54）。但密码迁移后 `POST /api/management/session` 只接受 `password`/`key` 与 **`panelPassword`（环境变量 OFM_PASSWORD）** 匹配（management.mjs:242-244），`forwardKey` 已不再是管理面凭据（management.mjs:146-148 注释明确「两套凭据彻底分离」）。
风险：设了密码 → 粘贴剪贴板里的 forwardKey 必然 401（「登录令牌已复制」的提示变成误导）；未设密码 → 面板免登录，助手整段多余，且无谓地把 API Key 复制进剪贴板（密钥暴露面 +1）。结合上一条：该功能在当前鉴权模型下已无合法用途。
修复建议：要么删除/隐藏该入口（前端按钮 + 端点一起下线），要么改造为复制当前鉴权模型真正需要的东西——但 OFM_PASSWORD 不应由服务端替用户复制，故倾向下线，并在前端把登录令牌输入框改为只接受 `#login=` bootstrap 片段。

[🟡] packages/standalone/management.mjs:65-74 - `POST /settings` 的 `combos` 分支缺「单链最多 1000 个模型」校验，绕过 `POST /combos` 的上限

原因：`POST /combos` 在归一化前逐行检查 `row.models.length > 1000`（L376-380），`POST /combos/preview` 同样检查（L357）；但 `validateSettings` 对 `key === 'combos'` 只验「是不是数组」（L73），注释还声称「逐项归一交给 normalizeCombos——它已经处理了……」，而 `normalizeCombos`（src/combos.js:126-149）**没有任何链长上限**。
风险：经 settings 端点写入的链不受 1000 上限约束。16KB body 限制下，用短模型 id 可单链塞入约两三千个成员；此后每次命中该 combo 的推理请求（`completeCombo` L357-459）都会顺序对全部成员发起尝试，其中真实存在的成员各发一次上游请求——把「放大重试面」的既有防线（L371-373 注释自己写明的动机）在另一条入口上整个绕开。
修复建议：把「单链 ≤1000」的检查抽成公共函数，`validateSettings` 的 combos 分支与 `POST /combos` 共用；或至少在 `normalizeCombos` 内统一截断/拒绝超长链，让两处注释与事实一致。

[🟡] packages/standalone/management.mjs:451-455 - 路由 catch 在 `headersSent`/`destroyed` 时既不响应也不记日志，异常静默蒸发

原因：`try { await route(...) } catch (error) { if (!res.destroyed && !res.headersSent) json(...) }`——条件不满足时走空分支，无任何日志；`createManagement` 的依赖注入里也没有 logger 可用。
风险：`/channels/rpc`、`/models/test` 这类长耗时端点若在写出响应前连接断开（abort 竞态、代理掐断），真实异常（含渠道错误细节）只进 void，排障时管理面「什么都没发生过」。虽然 `models/test` 内部已有 `controller.signal.aborted` 判据缩小了窗口（L421），但 catch 层的静默仍是普遍的。
修复建议：给 `createManagement` 注入 logger（service.mjs 已有 `logger`），catch 的空分支至少 `logger.warn?.(...)` 一行（不带请求头等敏感内容）。

[🟢] packages/standalone/service.mjs:357-459 - `completeCombo` 约 100 行、三层嵌套（for + try/catch + sink 闭包），成员尝试逻辑内联

原因：与插件端 `runCombo`（adapter.js:247-403，同为长函数但结构是「while-iterator + 明确的 committed 分支」）相比，独立版把「sink 缓冲、提交判定、失败收集、成功收尾」全部内联在一个 for 循环里，注释密度极高恰说明局部语境过载。
风险：可维护性；本轮审计发现的 🔴-1 正是「return result 的前提条件」被淹没在长函数尾部导致。
修复建议：拆出 `attemptMember(member, request, handler) => { answered, held, result, thrown }` 纯函数（与测试脚本 `scripts/standalone-combo-test.mjs` 直接测真代码的目标兼容），`completeCombo` 只保留循环与记账。

[🟢] packages/standalone/management.mjs:29-34（同类：src/forward.js:105-110）- `matches` 长度不等即提前返回，向时序侧信道泄露凭据长度

原因：`left.length === right.length && crypto.timingSafeEqual(left, right)` 是 timingSafeEqual 的标准用法（不等长会抛错，先比长度不可避免），但长度比较本身非常量时间。`OFM_PASSWORD` 是人类设置的口令（注释明确不做长度校验、`-e OFM_PASSWORD=x` 也生效），长度 oracle 对低熵口令有微弱利用价值。
风险：低；需要能高频探测同一进程且网络抖动小于分支开销，本地/局域网场景基本不可行。
修复建议：对两侧先各做一次 SHA-256（或 HMAC）再 `timingSafeEqual`，长度即恒定；`src/forward.js` 的 `keyMatches` 若要一并加固同理（forwardKey 是高熵随机串，收益有限）。

[🟢] packages/standalone/service.mjs:598-608 - 启动失败清理链无逐段容错，`channels?.close()` 抛错会跳过 `releaseLock`

原因：catch 块顺序 `management?.dispose(); runtime?.dispose(); await relayChanges; await closeRelay(); if (listener) await listener.close(); await channels?.close(); try { stores?.dispose() } finally { await releaseLock() }`——中间任何一步抛错（例如 Worker 关闭异常），后续 `stores.dispose()` 与 `releaseLock()` 都不执行。
风险：失败启动留下 `service.lock`。缓解因素：锁自带 ESRCH 陈旧回收（L95-113），下次启动多半能自愈；但「进程还活着、仅启动中途失败」时锁会被误判为活跃占用。
修复建议：把清理各步包进独立的 `try { ... } catch { /* log */ }`，保证 `releaseLock()` 恒达（成功路径 L587-594 已经是这么写的）。

[🟢] vendor/channel-pack/src/auto-checkin.ts:457-459 与 vendor/channel-pack/src/token-ledger.ts:350-355 - UTC+8 日键两份独立实现，算法相同但无同源约束

原因：`utc8DateString`（+8h 后取 UTC 日期）与 `utc8DayKey`（+8h 后取 UTC 年月日）算法一致，但分属两个文件、各自维护；`token-ledger` 注释引用的是 `qoder-adapter.ts` 的纪律，`auto-checkin` 引用的是 `model-queue.ts` 的常量，互不引用。
风险：未来某处单独改动（如引入「账本按本地时区」的需求）会与另一处静默漂移——这正是本仓库在其他判据上反复用「同值守护用例」防的坑（如 `AUTO_CHECKIN_REFRESH_HOUR_UTC8` 与 `QODER_CAMPAIGN_REFRESH_HOUR_UTC8`）。
修复建议：抽一个共享的 `utc8DayKey(ts)`（vendor 内部小工具即可），两处引用同一实现；或加一条跨文件同值的守护用例。

---

## 确认无误的部分

**1. management.mjs 鉴权（对照审查点逐项）**
- `matches()`（L29-34）：先比长度再 `timingSafeEqual`，避免 timingSafeEqual 对不等长输入抛错；Bearer 与 session 两条路都走它。
- 会话生成：`crypto.randomBytes(32).toString('base64url')`（L251），256 位随机；过期靠 `sessions` Map 的绝对时刻 + `pruneSessions()`，且在 `authenticated()`（L162）与 `POST /session`（L248）两处都会先修剪，读路径不存在「过期会话仍可用」的窗口。
- Cookie 属性：`HttpOnly; SameSite=Strict; Path=/api/management`（L254）齐全；`SameSite=Strict` 叠加 `structuralRejection`（trust.js:137-159：Host 必须回环、`sec-fetch-site: cross-site` 拒绝、Origin/Referer 与 Host 同源）构成 CSRF 双保险。未加 `Secure` 与纯 HTTP 回环监听一致，不算缺陷。
- `/auth` 免认证只暴露「是否设了密码」的布尔值（L228-231），注释论证成立。
- `/key/rotate` 轮换后清空全部会话仅保留当前、并焚毁 bootstrap token（L397-403）；bootstrap 为 10 分钟一次性、用后即焚（L234、L250）。
- 会话上限 64（L249）、静态资源仅从构建清单读取且路径白名单校验（L110-118）、CSP `script-src 'self'`（L22）均正确。
- **「未设密码时全部接口裸奔」确属设计意图**：`authenticated()` 的免密码放行（L157-158）有用户原话注释（L131-153），`--lan-panel` 的后果（改设置、增删账号、**看凭据**——含 `/api/management/key`、`/lan/key` 与 `/channels/rpc` 的备份导出）在 cli.mjs:53-74 与 forward.js:493-505 均有显式警告，属于文档化的显式取舍而非疏漏。唯一保留意见：该取舍的真实暴露面（云厂商账号凭据可被局域网任意设备导出）比警告文字的分量更重，可考虑在 `lanEnabled && lanPanel && !passwordRequired()` 组合时拒绝启动面板中继或强提示。

**2. service.mjs advancePastMember / held 缓冲**
- `answered`/`delivered` 拆分与 455130d 意图一致：非流式（`handler === undefined`，forward.js:944/1247 不传 onChunk）即使 `answered` 也判未交付、必须换人；流式已交付（`answered && hasHandler`）绝不换人（L437，`delivered = answered && hasHandler`）。反向场景逐条核对：提交判据直接复用插件端导出的 `commitsAnswer`（adapter.js:1125-1133），usage/空白 text-delta/reasoning 均不提交，与插件端一字不差。
- held 缓冲的丢弃路径正确：失败换人时 `held` 随循环体重新声明整批丢弃，不会把失败成员的半截内容/错误帧漏给下一个成员或客户端；成功但无内容块时补发 held（L446）兜底 finish 帧。
- 客户端断连后的写路径安全：三个流式端点的 onChunk 都先判 `res.destroyed`（forward.js:977、1178、1316/1378），held flush 到已死连接不会抛写后毁错误；abort 信号在 core（completion.js:40）与 channels（runtime.mjs:56）都会快速失败。
- comboChain 与 noteComboServed 的并发：`comboChain` 对模块级 `rotation` Map 的读-改-写全程同步（combos.js:211-233），`noteComboServed` 同为同步 set；Node 单线程下不存在 torn state，并发请求按 await 边界交错最多影响「谁先占名额」，计数语义正确。`completeCombo` 不调 `advanceComboCursor`（L448-455 注释），避免双倍推进——与插件端 2026-11-05 铁律一致。
- LAN 中继的 key 分离（`standaloneLanKey` ≠ `forwardKey` 强制重生成，L207-210）与「relayTarget 延迟读取 combo 包装后的 complete」（L220-231）两处历史坑的防护有效。

**3. account-pool.ts**
- 账号选择的并发一致性：所有 read-modify-write（`updateModelRateLimit`、`recordAccountRisk`、`recordVerificationBlocked`、`clearAnomalyOnSuccess`、`clearModelRateLimits`、`bumpMonotonicGeneration`、`setOpencodeProxy`）在 `readAccounts()` 与 `writeAccounts()` 之间**没有任何 await**，JS 单线程下 RMW 原子；磁盘写经 `storeChain` 串行并在轮到时取最新快照（L363-385），已修复的「已删账号复活/新增账号丢失」竞态不会回归。`getAvailableAccount` 的轮转推进也是同步的，并发请求各自看到推进后的游标，不会双双取回同一「下一个」。
- 冷却状态机无跳变：限流/风控「只接受更长的解禁时刻」（L1442、L1531）；风控阶梯 `current > now ? 24h : 30min`（L1529-1530）在「冷却中再命中→升级、过期后再命中→重新首犯」两个方向都正确；`clearAnomalyOnSuccess` 只清命中的模型键并同时清风控（L1171-1205）；`sweepExpired*` 只删「过期超过保留期」的条目，不会误删未过期冷却。游标名额归属校验（`accountId` 不符时 `used` 归零，L1256-1261）堵住了「候选集缩放导致名额错误继承」的坑。round-robin 不按限流/风控剔号、凭据损坏占名额，均为注释明示的设计取舍（L1280-1288），不作为缺陷。

**4. 签到幂等与日键**
- 全部日键为算术平移：`utc8DateString`/`utc8HourOfDay` 等用 `+8h` 后取 UTC 分量（auto-checkin.ts:457-459、584-599；token-ledger.ts:350-355），本机时区无关；`zcodeCheckinDayString` 的「−9h 再 +8h」净效果是 UTC 01:00（= UTC+8 09:00）分界，三个示例（20:00→当日、08:00→当日、09:00→换天）手工验算全部正确。
- 幂等链完整：`runIfDue` 的 `inflight` 去重覆盖 `setEnabled(true)`/`start()`/补跑/窗口枪四个触发源（L1666-1717）；per-provider 日界 + `coversToday` 口径防「把昨天轮次记成今天」（L1490-1510、1755-1762）；zcode 19:40 窗口门控先于账本判断（L712-714），窗口外跑一轮被误判锁死当天的路径被封死；每渠道每日尝试上限（通用 3 / zcode 2）+ 失败 30 分钟退避 + `given-up`，坏渠道不会跟着启动风暴打上游；`recordClaimResult` 对 `doc` 的读-改-写全程同步（L1753-1854 无中间 await），与 `performRun` 尾部「从最新 doc 合并」（L1540-1562）双向防覆盖，手动/自动并发不丢行；写盘 tmp+rename 原子且带 pid 后缀。重复领取即使发生（写盘失败丢账本），上游 `already-claimed` 兜底，无副作用。
- `AUTO_CHECKIN_REFRESH_HOUR_UTC8 = 10` 与 `QODER_CAMPAIGN_REFRESH_HOUR_UTC8 = 10` 实测同值（qoder-credits.ts:89），漂移守护用例如注释所述存在。

**5. login-terminal.mjs 命令注入面（除 🟡 功能脱节外）**
- 全部参数来自服务端固定值（`info().dataDir`、`process.execPath`、`SystemRoot`），无网页输入进入命令行；macOS 走 `execFile('/usr/bin/osascript', [...])` 无 shell，`shellQuote` 的 `'\''` 转义正确，dataDir 含引号/空格/换行都安全；Windows 走 `-EncodedCommand`（UTF-16LE base64），内层 `quote()` 的 PS 单引号倍写正确；**令牌本身只经 stdin（pbcopy input）或 PS 变量传递，从不进入命令行**——注释声明与实现一致，未发现注入路径。

**6. combos 上限检查位置**
- `POST /combos`（management.mjs:376-380）与 `preview`（L357）的 1000 检查在 `normalizeCombos` **之前**——归一化只会去重/过滤使 `models` 缩小，先检原始长度是保守（更严）方向，本身正确（问题只在 settings 路径缺失，见 🟡-5）。

**7. 其余 catch 路径**
- `token-ledger` 的 catch-all 吞异常是「记账绝不反噬推理」的明示契约（模块头 + 每处注释），实现遵守；`reconcileRelay`/`refreshModels`/`auto-checkin`/`account-pool` 的 catch 均有 warn 落日志；唯一静默点是 management 的 route catch（🟡-6）。
