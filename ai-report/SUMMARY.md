# 自动化优化执行总结（SUMMARY）

> 📌 本目录是 **2026-11 的审查快照**，不是当前缺陷清单。怎么看条目是否已修、已确认关闭的清单，见 [`ai-report/README.md`](README.md)。

日期：2026-11-19（任务 0→6 依序执行）
执行环境：本地仓库 `/media/kuye/128G/DSH/github工作区/临时项目/our-free-model`，Node 20.15.1 + DSH Tauri runtime（测试运行器）。

## 1. 任务 0 审计结果汇总

| 级别 | 数量 | 分布 |
|---|---|---|
| 🔴 严重 | **7** | egress 1 / net 2 / core 3（其中 1 项核验后降级为隐患）/ standalone 1（含 service.mjs undefined-outcome，与 core 报告同根合并计 1）/ client 0 |
| 🟡 一般 | **37** | net 5 / core 13 / adapter 7 / client 7 / standalone 5 |
| 🟢 建议 | 19+ | 详见各分报告 §🟢 |

分报告（全部含「确认无误的部分」与实证方法）：
- `ai-report/BUG-AUDIT.md`（合并视图 + 🔴 全清单）
- `ai-report/BUG-AUDIT-net.md` / `-core.md` / `-adapter.md` / `-client.md` / `-standalone.md`
- `ai-report/kernel-seam-audit.md`（任务 1）

审计方法：5 个并行审计代理逐行通读 + 关键疑点 Node 最小复现实证；我本人对每条 🔴 做了二次复核（其中 egress `dir` 作用域、standalone undefined-outcome、forward mid-stream 挂起三项均独立复现确认；core 的「probeRound 漏窗」初判被复核推翻并在报告中更正）。

## 2. 各任务状态

| 任务 | 状态 | commit |
|---|---|---|
| 0 审计 | ✅ 完成（6 份报告） | 3134aa6 |
| 1 内核接缝审计 | ✅ 通过，零修改（grep 验收无结果；vendor 豁免与 instanceof 均合规） | d40d600 |
| 2 修 🔴 | ✅ **修 4 条，跳过 3 条**（见下） | 25b1a59 |
| 3 探测性能 | ✅ 超时 45s→5s、并发 2→5、TTL 缓存 10 分钟、/reprobe force 绕过 | 1e8b659 |
| 4 JSDoc 类型化 | ✅ **达成实质，验收口径有差额**（见下） | c6dafc0 |
| 5 client.js 拆分 | ⛔ **跳过**——与宿主 ModuleLoader 加载契约冲突（详见下） | — |
| 6 升级链路加固 | ✅ dispose 超时 + restoreCaches 失败如实计数 + 回滚失败记 error 日志；「备份保留 3 份」前提不适用（当前代码无磁盘备份环节） | 3b0f458 |
| integrity/catalog 同步 | ✅ 随任务 3/4/6 各刷新 | 24adb92 等 |

最终验证：**87/87 套件通过**（新增 reload-rollback 套件），typecheck 0 错误，catalog 守卫绿。

## 3. 各任务改动文件

- 任务 1：无代码改动（报告 only）
- 任务 2：`src/egress.js`、`src/forward.js`、`src/http.js`、`src/core/runtime.js`、`packages/standalone/service.mjs`、`scripts/standalone-combo-test.mjs`
- 任务 3：`src/probe.js`、`src/core/runtime.js`
- 任务 4：`src/adapter.js`、`src/messages.js`（纯 JSDoc，行为零变化）
- 任务 6：`src/reload.js`、`scripts/reload-rollback-test.mjs`（新增）、`scripts/test-all.mjs`（注册）

## 4. 风险点与需人工重点 review

### 任务 2 修复项
- **🔴-2（forward mid-stream）**：`upstream.once('error'/'aborted')` 里 `res.destroy()` 是对「上游已写部分响应」唯一正确的动作，但会让客户端看到截断响应。建议人工 review：是否要在这条路径补一个 SSE error 帧再销毁（语义更友好，但改变了 fire-and-forget 的简单性）。
- **🔴-3（readRemainder watchdog）**：修复过程中我发现并修掉了自己第一版的次生 bug（watchdog 里先 `reader.cancel()` 再 reject，会让挂起的 read 以 `{done:true}` resolve 抢先赢得 race，watchdog 静默失效——有插桩实测证据）。现实现「只 reject、cancel 统一走外层 catch」，请重点 review `src/http.js:333-370`。
- **🔴-4（combo undefined outcome）**：兜底 outcome 的 `text: ''` 意味着已交付正文不会重复计入 outcome.text（正文已经通过 onChunk 交给网关了）。请 review `service.mjs` 的兜底形态是否符合网关对「已交付+失败」的预期。
- **🔴-5（TOCTOU）**：等待方现在「继续等下一轮共享刷新」而不是重跑。极端情况下（恒有非 force 的在途刷新）force 请求要等到在途轮结束——这是 15 分钟一层的等待，最坏多等一轮。请确认可接受。

### 任务 3
- **探测超时 45s→5s**：若某渠道冷启动首 delta 超过 5s（如 officeace 历史上首帧数十秒），会被误判为 timeout 类 verdict（STATE.unknown，不摘出选择器）。风险可控但值得观察：上线后看「unknown」计数是否上升。
- **TTL 缓存**：以持久化 `availability.at` 为时间戳，重启后 10 分钟内不会重探——与旧版「启动即探」（`refreshCatalog({probe:true, force:true})`）不冲突（启动路径走 force）。请 review 是否接受「重启后 10 分钟内不自动重探」的行为变化。

### 任务 4
- 见下「验收口径差额」。

### 任务 6
- dispose 超时 8s 是拍脑袋值；若真实 fiber 收尾可能超过 8s，请调整。

## 5. 硬性约束遵守情况

| 约束 | 结果 |
|---|---|
| 零依赖 + 无构建步骤 | ✅ 全程未动 package.json（含 files）、未装任何包 |
| 跨内核兼容（无 instanceof 内核类） | ✅ 审计确认全部 instanceof 为自有类/标准类型；未新增 |
| 内核接缝隔离 | ✅ 任务 1 grep 验收通过，未引入新内核 import |
| 接口不可变 | ✅ 三核心方法签名未动；新增导出（advancePastMember、PROBE_* 常量）为纯增量 |
| 禁止触碰文件 | ✅ package.json/lockfile/.env/dist 未动 |
| 禁止命令 | ✅ 未执行 npm install/git push/reset --hard/rm -rf/curl/wget（验证用的临时 fetch 为 node 内代码，非 shell curl） |

**无违反。**

## 6. 任务 4 验收口径差额（如实说明）

任务要求「修改 tsconfig.json 开启 checkJs，使 npx tsc --noEmit 通过」。

事实：**checkJs 在本仓库早已开启**，且 `tsc --noEmit -p tsconfig.json`（仓库既有口径，include 仅 `adapter/**/*`）退出码本来就是 0。

我尝试把 `src/adapter.js`、`src/messages.js` 加入 include 以让它们进入检查：瞬时暴露 **883 个错误**，分布于 import 链上 20+ 文件（egress 160、upstream 72、stream 69……）——即使把这两个文件标注到零，其余文件仍会红。把它们全部标注是数千行级别的工程，且超出「为两个文件补 JSDoc」的任务范围。按「验证失败则回滚」铁律，我回滚了 include 变更，保留并完成了实质部分：

- 9 个 `@typedef`（ModelEntry / ModelListing / StreamOptions / StreamChunk / AdapterState / AdapterDeps / HarnessMessage / ChatMessage / ToolDef）
- 两文件全部导出函数与类方法的 `@param` / `@returns`
- 两文件头部 `// @ts-check`（IDE 内即时严格提示；不影响 CI，因为 include 未含 src）

**未达标的部分**：两文件在 `--strict` 单文件校验下仍各有 85 / 30 个隐式 any 类错误（主要在 runChannel/runSingle 两个 300+ 行函数的内部闭包与联合类型窄化）。建议后续以「每 PR 标注一个文件」的节奏收敛，而不是一次性。

## 7. 任务 5 跳过的完整理由

任务要求把 client.js 拆成原生 ES modules 并以 `<script type="module">` 加载。**执行前提不成立**：

1. **client.js 不是普通浏览器脚本**——文件头就是 `window.__ModuleLoader__.load({ id, factory: require => … })`，是宿主 ModuleLoader 的 CJS 风格 bundle；`require('react')` 由宿主运行时供给（`package.json` 的 `dsh.client: {platform:'web', immediately:true, inject:[]}` 声明 + 内核约定路径加载）。
2. 拆出的 `.js` 文件无法被 factory 里的 `require` 解析（require 只认宿主白名单模块）；顶层 `import` 又没有 type=module 环境与 import map。
3. **10 个测试脚本**（client-lint、sanitize、heatmap、channel-login…）与 **`scripts/lib/standalone-shared-ui.mjs`**（独立版渠道页的构建源，注入面直接 `vm` 执行这个 bundle）都依赖「单文件 + ModuleLoader stub」形态；拆分会让它们全部失效。
4. `package.json` 的 files 虽允许改，但解决不了 1-3。

结论：该任务与宿主插件加载契约直接冲突，字面执行必然破坏功能。按铁律跳过并在此记录。**替代建议**（供人工决策）：若目标是改善可维护性，可在 bundle 内部用「区段注释 + 提取脚本生成 bundle」的方式组织源码（源码多文件、产物仍是单文件 bundle），这保留加载契约且测试不受影响——但它本身就是一个构建步骤，需要你拍板是否接受。

## 8. 🔴 修复明细与跳过原因（任务 2）

| # | 位置 | 处理 | 说明 |
|---|---|---|---|
| 1 | src/egress.js:232 `dir` 块外引用 | ✅ 已修 | `dir` 提升到模式分支之前；client 模式 close 不再吞 ReferenceError |
| 2 | src/forward.js:694 mid-stream 挂起 | ✅ 已修 | upstream error/aborted → res.destroy()；复现实验 20s 挂起 → 359ms 终止 |
| 3 | src/http.js:333 readRemainder 无中止 | ✅ 已修 | deadline+abort watchdog；并修掉第一版的 cancel-before-reject 失效 bug；复现实验 TIMEOUT @2.2s |
| 4 | service.mjs combo undefined outcome | ✅ 已修 | 已交付后抛异常构造兜底 outcome；新增 2 条测试钉住 |
| 5 | src/core/runtime.js TOCTOU | ✅ 已修 | 等待方继续共享在途轮，不再跌出重跑 |
| 6 | combos.js 名额提前消耗 | ⏭ 跳过 | 行为语义变更（非崩溃缺陷），横跨插件/独立版两条路径，需要完整轮转回归；风险>收益，记档待人工决策 |
| 7 | store.js 浅合并 | ⏭ 跳过 | update() 浅合并是文档化契约（edit 负责深改），审计核实现网全部消费方有守卫；改深合并会变更所有调用方语义 |

## 9. 🟡/🟢 未修复清单（建议后续人工处理）

按「性价比 × 风险」排序的前 10 条：

1. **adapter.js:900 vs runChannel:637 换人语义漂移**（4xx 是否连撞整条链）——两条成员路径行为不一致，最值得统一
2. **reload.js dispose 无超时** → ✅ 已在任务 6 顺带修复；同类模式在 `restoreCaches` 的 await 链上也建议加
3. **`/login/terminal` 在鉴权之前**（standalone）——curl 可伪造 Origin；建议加一次性 nonce
4. **login-terminal 复制的 forwardKey 已不是面板凭据**（密码迁移后失效）——建议下线该功能或改为复制 session 流程指引
5. **management.mjs POST /settings 的 combos 缺 ≤1000 校验**——绕过 POST /combos 的上限检查
6. **runtime.js:246 `logger.warn?.() ?? logger.log?.()` 双写**——一行修复，建议随手
7. **probe.js detectEgress 不检查 caller signal 已 aborted**——dispose 后多打最多 2 个 echo
8. **client.js:2934 端口回写后修改被静默忽略**——用户可感知的 UI bug
9. **client.js:5946 删除链路失败无反馈**——unhandled rejection
10. **classifyFailure 裸子串过宽**（/region/i、/not supported/）——可用性判定被污染的隐患

🟢 级别（巨型函数拆分、魔法数字收敛、重复代码合并等）见各分报告，均为长期维护项，无上线风险。
