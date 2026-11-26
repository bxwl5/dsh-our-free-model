# docs/verification 说明（历史验收快照）

> **历史快照声明（2026-10 验收记录）**：本目录是 2026-10-09 那轮 standalone UI 验收的原始
> 留存——4 篇验收记录 + 4 个截图/布局数据目录（共 48 个文件）。文中出现的**命令、脚本与
> 数字都不代表现状**：当时采样用的三个脚本已不存在，套件总数也从 33 条变成今天的
> **87 条**（以 `scripts/test-all.mjs` 的 `suites` 清单为准）。保留本目录只为留档：截图与
> 尺寸/布局数据不可复现，但操作步骤不要照抄。

## 逐篇失效清单

「失效」= 文中出现的路径在今天的仓库里**不存在**：`.mjs` 逐个用 `ls scripts/` 核对；`.verify/`
是本地临时目录（`.gitignore:9`，`git ls-files .verify` 为空），从未进过仓库。
「数字过期」= 当时的套件计数与今天的 87 条不符，仅作历史记录。

| 验收记录 | 配套截图/数据目录 | 已失效的命令/路径 | 数字过期 |
| --- | --- | --- | --- |
| [`2026-10-09-standalone-model-browser.md`](2026-10-09-standalone-model-browser.md) | `standalone-model-browser/`（8 个文件） | `node scripts/measure-standalone-ui.mjs`（`:28`，脚本已删除）；`.verify/ui-phase1-load-data`（`:15`） | 33/33（`:26`）、3/3（`:27`） |
| [`2026-10-09-standalone-settings-page.md`](2026-10-09-standalone-settings-page.md) | `standalone-settings-page/`（11 个文件） | `node scripts/measure-standalone-ui.mjs`（`:36`，脚本已删除）；`.verify/ui-settings-data`（`:16`、`:39`）、`.verify/settings-preview.log`（`:39`） | 33/33（`:34`）、3/3（`:35`） |
| [`2026-10-09-standalone-ui-phase1.md`](2026-10-09-standalone-ui-phase1.md) | `standalone-ui-phase1/`（14 个文件） | `node scripts/standalone-channels-test.mjs`（`:32`）、`node scripts/measure-standalone-ui.mjs --record`（`:35`）、`node scripts/standalone-ui-preview.mjs`（`:140`）——三个脚本均已删除；`.verify/ui-phase1-pr-contributor.log`（`:33`）、`.verify/ui-phase1-pr-release.log`（`:34`）、`.verify/ui-phase1-url.txt`（`:141`）、`.verify/ui-phase1-data`（`:46`） | 33/33（`:33`）、0/3（`:34`）、15/15（`:31`）、11/11（`:32`） |
| [`2026-10-09-standalone-usage-dashboard.md`](2026-10-09-standalone-usage-dashboard.md) | `standalone-usage-dashboard/`（11 个文件） | 没有失效的 `.mjs`：`build-standalone-ui.mjs --check`（`:29`）、`standalone-frontend-test.mjs`（`:30`）、`test-all.mjs`（`:31`、`:32`）仍在 `scripts/` 下；失效的只有 `.verify/ui-usage-data`（`:15`、`:35`）与 `.verify/ui-usage-history-data`（`:16`、`:35`） | 33/33 与其中的 16/16（管理专项）、11/11（渠道专项）同见 `:31`，3/3（`:32`） |

同批命令的脚本今天仍在 `scripts/` 下（只保证路径存在，不代表仍能通过）：`npm run build:standalone-ui`、
`npm run typecheck:standalone`、`node scripts/build-standalone-ui.mjs --check`、
`node scripts/standalone-frontend-test.mjs`、`node scripts/standalone-management-test.mjs`。

## 需要重跑请看

`node scripts/test-all.mjs`（可选 `--mode contributor` / `--mode release` / `--only <名字>`），
它运行当前全部 87 个套件；不要把本目录里的旧命令当作当前验收入口。