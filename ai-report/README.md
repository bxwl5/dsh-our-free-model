# ai-report：2026-11 审查快照（先读这一页）

本目录是 **2026-11-19 那一轮自动化审计的原始快照**（任务 0 的 `BUG-AUDIT*.md`：合并视图
+ 5 份分报告；任务 1 的内核接缝审计；任务 3/4/6 的执行报告。汇总见 [`SUMMARY.md`](SUMMARY.md)）。

**它不是当前缺陷清单，也不是待办列表。** 报告里的行号、结论都是当时的代码状态；
其中有一部分问题后来已经修掉或随功能下线而关闭，报告本身不会自动更新。

## 怎么判断某一条是否还成立

按顺序看三处：

1. **条目自带状态标注**：直接在对应条目的「原因 / 风险 / 修复建议」上下找
   「已修」「已删」「已移除」「已下线」字样，以及括注的日期、commit 或 `文件:行`。
   有标注就是已关闭，不必再按原文去复现。
2. **`SUMMARY.md` 的任务状态表**（§2 各任务状态、§3 各任务改动文件、末尾的 🔴 清单）：
   那里记录了每条 🔴 的处置结论与 commit。
3. **都没写 = 状态未跟踪**：报告写完后没人跟进过，需要自己按当前代码重新核实，
   不要默认它仍然存在、也不要默认它已修。

## 已确认关闭的清单（2026-11-26 复核）

| 报告条目 | 最终结论 | 当前证据 |
|---|---|---|
| `BUG-AUDIT-standalone.md` 🟡 `management.mjs:201-219` `/api/management/login/terminal` 位于鉴权之前、防护头可伪造 | **已删**（决策三，2026-11-19）：端点与「本机取令牌」入口整体下线，注册处只剩注释说明为何删 | `packages/standalone/management.mjs:232-233`、`:346-353`（路由不存在，仅注释；注释点名审计 🟡#33/#34）；`scripts/standalone-management-test.mjs:154-165` 钉住「该端点不得返回 200」 |
| `BUG-AUDIT-standalone.md` 🟡 `login-terminal.mjs:20-22, 52-54` 复制的是 `forwardKey`，与只认 `OFM_PASSWORD` 的登录模型脱节 | **已失效退出运行路径**：端点没了，该功能无入口；`login-terminal.mjs` 仅作为实现库 + 测试保留，不进运行时 | `packages/standalone/management.mjs:232-233`、`:350-353`；`scripts/test-all.mjs:42` 注明其测试由 `standalone-management-test.mjs` 调用 |
| `BUG-AUDIT-standalone.md` 🟡 `management.mjs:65-74` `POST /settings` 的 `combos` 分支绕过「单链 ≤1000」 | **已修**（2026-11-19 决策二）：`validateSettings` 与 `POST /combos` 共用 `COMBO_MEMBER_LIMIT` | `packages/standalone/management.mjs:118-122`、`:512` |
| `BUG-AUDIT-standalone.md` 🔴 `service.mjs:416-424, 437-456` 成员「已提交后抛异常」返回 `undefined` outcome | **已修**：catch 分支构造兜底 outcome，迟到失败如实上报 | `packages/standalone/service.mjs:441-444`；`SUMMARY.md` §2 任务 2 第 4 条 |
| 审计范围内的签到跳过表（`auto-checkin.ts`，审计 §「确认无误的部分 4. 签到幂等与日键」只覆盖了日键与幂等，没单列 raccoon） | **已改为真实续期**（2026-11-19）：raccoon 已从「不支持签到、只查不发上游请求」的跳过名单移除，走 `GET /office/v3/setting_info` 把当日 300 分续成 7 天，凭据失效按真失败进重试 | `vendor/channel-pack/src/auto-checkin.ts:950-953` |

未列在上表里的条目，**状态未知**——按上一节第 3 步自行核实。

## 维护约定

- **不要删条目**。这些报告是决策证据（为什么当初这么判、后来为什么改），
  修完只需在条目旁补一行 `> ✅ 已修/已删（日期，commit 或 文件:行）`。
- 每轮复核后，把新确认关闭的条目补进上表，并把复核日期写进标题。
- 新写报告请另起文件并在 `SUMMARY.md` 里登记，不要就地重写历史结论。