# 发布链路缺口与补全方案

> 状态：**现状说明 + 待决方案**。本文只描述仓库里**真实存在**的东西，并引用可核对的
> 行号；凡是当前不存在的工具、目录、密钥，都明确标为「缺」，不描述其行为。
>
> 编写时的基线：`main` @ `93dafa4`（`package.json` 版本 `2.5.7-priv.1`）。
> 相关的既有文档：[`RELEASING.md`](RELEASING.md)（418 行，含中英双语）、
> [`contributor-ci-signing.md`](contributor-ci-signing.md)（123 行）。

## 0. 一句话结论

`docs/RELEASING.md` 描述的是一条**已经不存在的**发布链路：它引用的
`feed/`、`scripts/build-manifest.mjs`、`scripts/live-audit.mjs`、`scripts/release-e2e.mjs`、
`scripts/prepare-release.mjs`、`src/feed.js`、`src/updater.js`、`.github/workflows/prepare-release.yml`
在本仓库里**全部没有**（实测：磁盘与 `git ls-files` 均无）。这些文件连同「公告中心 / 插件升级」
整块功能在 `95657a7`（`chore: 移除公告中心、插件升级、赞助广告、聚合渠道与推荐项目`）
被一并删除，`README.md:6` 的副标题也写着「已移除 EAC 协付、公告/升级/赞助/聚合功能」。

**所以当前真正可执行的发布动作只有一个：刷新 catalog 的 revision 字段。**
`docs/RELEASING.md` 里其余步骤（重签清单、`--check`、live audit、CDN purge、tag/Release 脚本）
现在一条也跑不了 —— 不是「跑起来会失败」，而是脚本文件本身不存在。

---

## 1. 现有链路（真实存在、可执行的部分）

### 1.1 `catalog-test.mjs` 到底校验什么

`scripts/catalog-test.mjs`（178 行）是**唯一**与发布记录相关的离线套件，被
`scripts/test-all.mjs:31` 的 `releaseSuites = new Set(['catalog'])` 选进 `--mode release`。
它检查的东西分四组：

| 组 | 位置 | 内容 |
| --- | --- | --- |
| schema 结构 | `catalog-test.mjs:63-96` | `manifestVersion` 必须是 `0.15`；`$schema` 必须等于 vendored schema 的固定 URL；`id` 匹配 namespacedId 正则；`name`/`version`/`license` 与 `package.json` 一致；`facets.host.entry` 在磁盘上存在；顶层字段不得越界（只允许 `x-` 前缀扩展） |
| 版本钉住 | `catalog-test.mjs:73-76` | 两份 README 里 `"dsh-our-free-model": "file:./vendor/dsh-our-free-model-<ver>.tgz"` 的版本号必须等于 `pkg.version` |
| provenance | `catalog-test.mjs:120-128` | `provenance.subject` 的 `id`/`version`/`sourceRevision` 与 manifest 三方一致；`LICENSE` 含 `MIT License` 与 `Copyright`；`upstreamRuntime` 固定为 `@deepseek-ai/dsh-llm` + `adapter/kernel.js`；`mojobox.recordInstalled === false` 且 `artifactDigest === null` |
| adapter 隔离 | `catalog-test.mjs:131-160` | 发布文件里除 `adapter/` 与 `vendor/` 外，任何 `.js/.mjs/.cjs` 不得出现 `@deepseek-ai/`；`index.js` 必须经由 `./adapter/kernel.js` 触达内核；`inject` 必须恰好是 `['llm']` |

**关键事实：`catalog/integrity.json` 只被 `readJson` 读进来，从未参与任何比较。**
`catalog-test.mjs:55` 是 `const integrity = readJson('catalog/integrity.json')`，
全文件对 `integrity` 的引用只有这一处（`grep -nE "integrity[.\[]" scripts/catalog-test.mjs`
只命中第 55 行本身）。`scripts/lib/published-bytes.mjs` 虽然被 `catalog-test.mjs:31` import，
但**全文没有调用** `publishedBytes()`（`grep -n "publishedBytes(" scripts/catalog-test.mjs` 无输出）。

实测后果（对 HEAD `93dafa4` 的 git blob 逐文件算 SHA-256 后比对）：

```
actual 65 files / listed 67 files
onlyListed: src/providers/index.js, src/providers/registry.json   ← 已删除但仍在记录里
DRIFT client.js                    532575 → 371760
DRIFT index.js                     113071 →  79390
DRIFT package.json                   2986 →   2842
DRIFT src/adapter.js                42849 →  39688
DRIFT src/catalog.js                28564 →  20148
DRIFT src/combos.js                  7856 →   7853
DRIFT src/core/runtime.js           19156 →  16458
DRIFT src/http.js                   28004 →  27971
DRIFT src/store.js                  24277 →  22376
DRIFT src/upstream.js               27279 →  27273
DRIFT vendor/channel-pack/pack.js 2926187 → 3069530
driftCount = 11（另 2 个文件已不存在）
```

即：`catalog/integrity.json` 记的是 `2.5.7`（该文件的 `version` 字段）时的字节，
而 `package.json` 现在是 `2.5.7-priv.1`，文件也换过一轮。**这份记录今天已经和实物不符，
但没有任何测试会红** —— 因为校验它的工具（`build-manifest.mjs --check`）被删了，
而 `catalog-test.mjs` 从来没真正比过摘要。

### 1.2 revision 两步提交（仍然有效，且是唯一的发布动作）

`catalog/dsh-plugin.json` 的 `source.revision` 与 `catalog/provenance.json` 的
`subject.sourceRevision` 记录「最近一次触及发布内容的 commit」，比较对象**刻意不是 HEAD**。
规则写在 `docs/RELEASING.md:96-108`（中文）/ `docs/RELEASING.md:294-311`（英文），
实现是 `catalog-test.mjs:112-116` + `catalog-test.mjs:166-172`：

```js
// catalog-test.mjs:168
execFileSync('git', ['log', '-1', '--format=%H', '--', 'package.json', ...(pkg.files ?? [])], …)
```

当前值 `8574348c2c6a974c41396238f2cbc5bffab9e7c4` 与上面这条命令的输出一致（已实测），
所以两步提交的约定今天仍在生效：

1. **内容 commit**：代码 + `catalog/*.json` 一起进；
2. **刷新 commit**：紧接着一个只改上述两个 revision 字段的 commit，指向第 1 步的哈希。

只改 `docs/`、`scripts/`、`catalog/` 的 commit **不移动**这个指针。
`--contributor` 模式（`catalog-test.mjs:36`、`catalog-test.mjs:112`）跳过 revision 对齐，
只跑结构 / provenance / 隔离三组；`npm run test:contributor`（`package.json:25`）走这条。

**注意：`scripts/refresh-revision.mjs` 也已被删除。** 它原本就是自动写这两处字段的工具
（`git show d857f8e:scripts/refresh-revision.mjs` 可查），现在只能手工改 JSON。

### 1.3 现在的 CI 实际跑什么

`.github/workflows/test.yml` 三个 job，与发布**没有任何**签名或清单环节：

| job | 行 | 命令 |
| --- | --- | --- |
| `offline` | `test.yml:16-38` | `node scripts/test-all.mjs --mode "$TEST_MODE"`（PR → `contributor`，其它 → `all`）；`fetch-depth: 0` 是为了让 `catalog-test` 能走 git 历史 |
| `typecheck` | `test.yml:42-50` | `npm run typecheck` → `tsc --noEmit -p tsconfig.json`，**只覆盖 `adapter/**/*`**（`tsconfig.json` 的 `include`） |
| `standalone-frontend` | `test.yml:52-61` | 独立端类型检查 + `build-standalone-ui.mjs --check` |

`test.yml:3-5` 的注释已经写明：「This repository ships no in-app updater and no signed
manifest, so there is no release-signing job — the release records under `catalog/` are
verified by `catalog-test.mjs` instead.」—— CI 是**知情**的，只是 `RELEASING.md` 没跟上。

`.github/workflows/build-macos.yml` 与发布清单无关：它只构建 macOS `.dmg` 并作为
GitHub Release 的**非官方社区构件**上传（`build-macos.yml:1-6` 注释、`release_tag` 带
`-macos-unofficial` 后缀），不触碰 `feed/` 或 `catalog/`。

### 1.4 发布文件集合

`package.json:31-44` 的 `files` 共 12 项，展开后是 **65 个文件、4 432 236 字节**
（实测，LF 归一化后）。最大的三个：`vendor/channel-pack/pack.js` 3 080 102 字节、
`client.js` 378 038 字节、`vendor/channel-pack/qoder-auth-wasm.wasm` 298 606 字节。

`index.js:716-720` 的注释解释了为什么 `vendor/channel-pack` 要被 bundle 成单个 `pack.js`：
「one file, so the release manifest stays inside its file cap」—— 那个 cap 属于已删除的
`src/updater.js`（`MAX_FILES = 80`、`MAX_FILE_BYTES = 4 MiB`、`MAX_MANIFEST_BYTES = 256 KiB`，
见 `git show d857f8e:src/updater.js`）。65 < 80，所以即使把升级器装回来，文件数也还够用。

---

## 2. 缺什么

### 2.1 工具（全部缺失，且无替代品）

| 缺失文件 | 原本的职责 | 现在的影响 |
| --- | --- | --- |
| `scripts/build-manifest.mjs` | 遍历 `package.json` 的 `files`，用 `publishedBytes()` 做 LF 归一化后写 `feed/manifest.json`（含 `base: "../"` 与 Ed25519 `signature`）与 `catalog/integrity.json`；`--check` 只读比对并非零退出 | **没有任何东西能生成或校验摘要**。`catalog/integrity.json` 已经漂移 11 个文件而无人发现（§1.1） |
| `scripts/live-audit.mjs` | 以已安装用户身份走 `downloadManifest` → `stageRelease` → `verifyStaged`，打印 OK 才算发布成功 | 没有「发布后复核」这一步 |
| `scripts/release-e2e.mjs` | 把全部发布文件改写成 CRLF 再跑一次 `--check`，证明摘要算的是 LF 字节 | 没有行尾归一化的回归门禁 |
| `scripts/prepare-release.mjs` | 从**可信 main** 读候选 Git 对象、用 Environment 里的私钥生成 `release.patch` + `receipt.json` 构件 | `contributor-ci-signing.md` 的整条受保护签名流程无法执行 |
| `scripts/refresh-revision.mjs` | 自动把两处 revision 写成「最近内容 commit」 | 只能手工改两个 JSON 字段，容易改错 |

此外 `src/feed.js`（公告源）与 `src/updater.js`（下载 / 验签 / 暂存 / 回滚 / 固定 SHA 解析）
都不存在，`index.js` 里也没有 `/update/*`、`/announcement(s)`、`/reload` 任何路由
（实测 `grep -c "routePath === '" index.js` = 27 个分支中无一命中）。
`index.js:9-14` 与 `index.js:102-107` 的注释**仍在描述**这套已删掉的功能，属于陈旧注释。

### 2.2 目录与密钥

| 缺失项 | 证据 |
| --- | --- |
| `feed/` 目录 | 磁盘无、`git ls-files` 无。`feed/manifest.json`、`feed/announcements.json` 都不存在 |
| 发布私钥 | 仓库里从来没有过（正确）。但**连公钥也没有**：`PINNED_MANIFEST_PUBLIC_KEY`（原值 `MCowBQYDK2VwAyEAeLdSVwYFyazc2PIBC0oLsvo4LghGEQz9iXIl3CqRuXI=`，见 `git show d857f8e:src/updater.js:77`）随 `src/updater.js` 一起消失。全仓库 `grep -rn "BEGIN PUBLIC KEY\|createPublicKey\|verifyManifestSignature"` 无命中 |
| Environment `release-signing` | `contributor-ci-signing.md:47-51` 要求创建，但对应的 workflow（`prepare-release.yml`、`release-sign.yml`）已被删除，没有承载者 |
| `release-readiness` 检查 | `RELEASING.md:11`、`RELEASING.md:78-85` 把它当作必需检查；实际 `test.yml` 只有 `offline`/`typecheck`/`standalone-frontend` 三个 job，`package.json:26` 的 `test:release` 只是本地脚本，不是 CI 门禁 |

### 2.3 文档自身的矛盾

`docs/RELEASING.md` 有 40 处引用不存在的文件或检查（`build-manifest.mjs`、`live-audit.mjs`、
`release-e2e.mjs`、`prepare-release.mjs`、`feed/*`、`release-readiness`）。
`docs/contributor-ci-signing.md` 有 6 处。这两份文档现在**不能照着做**，
应视为「上游 2.5.7 的设计记录」而非操作手册。

---

## 3. 补全方案

> ✅ **决策（2026-10-25，用户）**：本仓库是**私有库、仅自己使用**，**B/C 档不做**。
> 客户端自动升级链路（`feed/` + `src/updater.js` + 签名工作流）保持删除状态；
> 发布动作只有两步：`node scripts/refresh-integrity.mjs` + catalog revision 刷新，
> 且两者都已由 `catalog-test` 强制。下面的 B/C 保留为**将来若公开分发时的参考**。

分三档，**按需要选，不要一次全上**。A 档是「让记录说真话」，B 档是「恢复可校验的发布」，
C 档是「恢复签名与受保护签名流程」。每档都列出可执行命令与门禁。

### 3.1 A 档：只修记录一致性（最小、无密钥、无新依赖）

目标：让 `catalog/integrity.json` 重新描述真实字节，且这件事由测试守住。

1. **补一个纯摘要生成器** `scripts/build-manifest.mjs`，行为限定为：
   - 输入：`package.json` 的 `files`（展开目录，跳过 `node_modules` 与 `.` 开头项）；
   - 归一化：复用 `scripts/lib/published-bytes.mjs` 的 `publishedBytes()`（已存在，正是
     为「工作区 CRLF vs git blob LF」而写的，见该文件头部注释）；
   - 输出：`catalog/integrity.json`（`{ version, algorithm: 'sha256', files: [{path,size,sha256}] }`）；
   - `--check`：只读比对，不一致非零退出并逐条打印 `path: size X in the record, Y on disk`。

   这份脚本**不写 `feed/manifest.json`、不签名**——A 档刻意不碰签名信任根。

2. **把 `--check` 接进门禁**：在 `scripts/test-all.mjs` 的 `releaseSuites` 里加一条
   `['release-bytes', 'build-manifest.mjs', ['--check']]`，让它只在 `--mode release` 跑。
   注意 `test-all.mjs` 的 suite 条目是 `[name, script, args]` 三元组（`test-all.mjs:33` 起），
   `build-manifest.mjs` 需要支持被 `spawn(process.execPath, [script, ...args])` 直接执行
   （即顶层执行 `main()`，而不是只导出函数）。

3. **让 `catalog-test.mjs` 真正使用 `integrity`**：它现在读了不用（§1.1）。
   最小改法是删掉第 55 行那个未使用的 `const integrity`，或者（更好）保留并在
   `sub('integrity')` 段里加一条「`integrity.version === pkg.version`」。**不要**在
   `catalog-test.mjs` 里重算全部摘要——那会让这个「结构 + 隔离」套件变成字节套件，
   职责和 §3.1 第 2 步重复。

4. **两步提交不变**：A 档产出的 `catalog/integrity.json` 属于 `catalog/`，
   按 `RELEASING.md:106-107` 的规则它**不移动** revision 指针，因此不需要额外刷新 commit。

验收命令：

```bash
node scripts/build-manifest.mjs --check     # 必须 0
node scripts/catalog-test.mjs               # 必须 0（含 revision 对齐）
node scripts/test-all.mjs --mode release    # 只跑 catalog + release-bytes
```

**回退**：删掉 `scripts/build-manifest.mjs` 与 `test-all.mjs` 里的那条 suite 条目，
`catalog/integrity.json` 用 `git checkout -- catalog/integrity.json` 还原。A 档不改变任何
运行期行为，回退无风险。

### 3.2 B 档：恢复「发布清单 + 发布后复核」（需要决定是否恢复升级器）

前提问题：**要不要把 `src/updater.js` 装回来？** 只有装回来，清单才有消费方。
如果答案是否，B 档应当**停在这里**，只保留 A 档；给一个没有读者的清单签名没有意义。

若决定恢复，按这个顺序（每步都能独立回退）：

1. **目录结构**

   ```
   feed/
     manifest.json        # 签名清单：version / base: "../" / publishedAt / files[] / signature
     announcements.json   # 公告（只有恢复公告中心才需要）
   catalog/
     integrity.json       # 同一份 files[]，去掉 base/notes/signature
     dsh-plugin.json      # source.revision
     provenance.json      # subject.sourceRevision
   scripts/
     build-manifest.mjs   # A 档的脚本 + 签名 + --check
     live-audit.mjs       # 以已安装用户视角走一遍下载→暂存→校验
     release-e2e.mjs      # CRLF 归一化回归
     refresh-revision.mjs # 自动写两处 revision
   ```

2. **命令序列**（与 `RELEASING.md:40-55` 对齐，但只写当前能跑的）

   ```bash
   # 1) 改版本：package.json 的 version、两份 README 的本地 tarball 版本号、
   #    catalog/dsh-plugin.json 与 catalog/provenance.json 的 version 字段
   # 2) 重签（私钥不入库，从安全目录读路径）
   node scripts/build-manifest.mjs --key /安全目录/ofm-release-key.pem
   # 3) 只读复验
   node scripts/build-manifest.mjs --check
   # 4) 内容 commit（代码 + feed/ + catalog/）
   git add -A && git commit -m "release: vX.Y.Z"
   # 5) 刷新 commit（只改两处 revision）
   node scripts/refresh-revision.mjs && git add catalog/ && git commit -m "chore(catalog): 刷新 revision"
   # 6) tag + Release
   git tag -a vX.Y.Z -m "…" && git push origin vX.Y.Z
   gh release create vX.Y.Z --title "…" --notes-file docs/releases/vX.Y.Z.md
   # 7) 以已安装用户身份复核
   node scripts/live-audit.mjs
   ```

3. **CI 门禁**（`test.yml` 加第 4 个 job，或把 2 条命令并入 `offline`）

   ```yaml
   release-bytes:
     runs-on: ubuntu-latest
     steps:
       - uses: actions/checkout@<pin>          # fetch-depth: 0，catalog-test 要走 git 历史
       - uses: actions/setup-node@<pin>        # node 22
       - run: npm install --ignore-scripts
       - run: node scripts/build-manifest.mjs --check   # 清单/记录 vs 实物字节
       - run: node scripts/catalog-test.mjs             # 结构 + provenance + revision 对齐
   ```

   两条都**不需要私钥**（`--check` 只读），因此可以放在无 Secrets 的普通 job 里，
   符合 `contributor-ci-signing.md:7-10` 的「贡献者无需私钥即可验证」原则。
   `catalog-test.mjs` 在 PR 上应传 `--contributor`（跳过 revision 对齐），
   在 `main` 上跑完整模式。

4. **公私钥存放**

   | 项 | 位置 | 说明 |
   | --- | --- | --- |
   | 私钥（Ed25519 PEM） | 仓库外安全目录 + GitHub Environment `release-signing` 的 `RELEASE_MANIFEST_PRIVATE_KEY`（**PEM 内容**，非路径） | `RELEASING.md:57-63` 已明确两种用法不要混用：本地 CLI 的 `--key` 收**路径**，受保护 workflow 收**内容** |
   | 公钥 | 编译进 `src/updater.js` 的 `PINNED_MANIFEST_PUBLIC_KEY`（原值见 §2.2） | 只读、随代码走；换钥等于换信任根，必须与「旧客户端仍能验旧签名」一起评估 |
   | 占位签名 | **禁止** | `RELEASING.md:61-63`：「没有既有私钥时拒绝写入……不得提交占位签名或替换公钥」 |

   B 档在**没有**拿到既有私钥之前，`build-manifest.mjs` 应当拒绝写 `feed/manifest.json`
   （原实现的 `refusing to write an unsigned manifest` 行为），但**允许**写
   `catalog/integrity.json`（它不含签名）—— 这样 A 档的收益在无私钥时也能拿到。

### 3.3 C 档：恢复受保护签名流程（只在确实需要时）

依赖 B 档。核心约束（`contributor-ci-signing.md:107-113`）不变：
签名 job 只读 Git 对象、**不执行候选代码**、私钥只在 Environment 变量里、产出是待审查补丁
而非自动提交。若恢复，需重建：

- `.github/workflows/prepare-release.yml`（`workflow_dispatch` + `candidate_sha` 输入 +
  `environment: release-signing` + 只 `contents: read`）；
- `scripts/prepare-release.mjs`（`--base` / `--candidate` / `--output`，从 Git blob 读文件，
  Node 启动 git 子进程前移除私钥环境变量）；
- 合并门禁要求 `offline`、`typecheck`、`release-bytes`（B 档新增）全绿。

**注意**：`contributor-ci-signing.md:56-57` 明确写了首次引入时 workflow 还没进 main，
维护者得先用本地签名方法完成当前 PR。恢复 C 档时同样要先 B 档跑通一轮。

---

## 4. 风险与回退

### 4.1 风险清单

| 风险 | 触发条件 | 后果 | 缓解 |
| --- | --- | --- | --- |
| **摘要漂移继续累积** | 现在就是这样 | `catalog/integrity.json` 已错 11 个文件。若将来有生态目录（Mojobox）按它审计，会判定发布物被篡改 | A 档：把 `--check` 接进门禁，让漂移在提交前红 |
| **按 `RELEASING.md` 操作而卡死** | 维护者照文档执行第 2 步 | `node scripts/build-manifest.mjs` → `MODULE_NOT_FOUND`，发布流程当场中断，可能被误判为「环境坏了」 | 先修文档（本文 §1、§2 即材料），或在 `RELEASING.md` 顶部加一条「本文引用的工具已随 95657a7 删除，见 release-pipeline-gap.md」 |
| **误把 `2.5.7` 的 `integrity.json` 当成当前版本的记录** | 有人用 `integrity.json` 的 `version` 字段判断发布状态 | 版本号与 `package.json` 的 `2.5.7-priv.1` 不符，结论错误 | A 档第 3 步：让 `catalog-test` 检查 `integrity.version === pkg.version` |
| **恢复升级器但私钥丢失** | B 档拿到代码、拿不到既有私钥 | 若擅自换钥，**所有旧客户端的升级路径同时失效**（旧客户端只认 pin 在代码里的公钥） | 无私钥时 `build-manifest` 只写 `integrity.json`、拒绝写清单；换钥必须单独评估并保留旧公钥验证分支 |
| **`MAX_FILES = 80` 上限** | 发布文件数从 65 继续增长 | 超过 80 后清单被 `parseManifest` 拒绝，升级器整体不可用 | 继续把大块源码 bundle 成单文件（`index.js:715-720` 的既有做法）；把文件数纳入 `--check` 的输出 |
| **`typecheck` 覆盖面被误读** | 有人以为 CI 绿 = 类型安全 | `tsconfig.json` 的 `include` 只有 `adapter/**/*`；`vendor/channel-pack/src/*.ts` 的 `tsc` 需要 `@types/node`（仓库 `devDependencies` 未装，本机实测借用外部 `@types/node` 才能跑） | 文档写明覆盖面；不要把 `typecheck` 当发布门禁 |
| **CDN 缓存分裂态** | 恢复 `feed/` 后仍靠 jsDelivr `@main` | `RELEASING.md:149-191` 记录过「新清单配旧文件」会让 `stageRelease` 校验失败、该网络用户升级不到 | 恢复 `live-audit.mjs`；purge 整树 + 按路径逐个 purge；或直接走固定 SHA 取件（`RELEASING.md:110-137`） |

### 4.2 回退路径

- **A 档**：删除新增的 `scripts/build-manifest.mjs` 与 `test-all.mjs` 里的 suite 条目，
  `git checkout -- catalog/integrity.json`。不改运行期代码，无数据迁移。
- **B 档**：`git revert` 恢复升级器的那个 commit；`feed/` 目录随 commit 一起消失。
  已安装客户端会回到「检查更新失败」而不是「装坏」——升级器在校验失败时保留旧安装
  （`RELEASING.md:141`、`RELEASING.md:169-170` 的既有行为）。
- **C 档**：按 `contributor-ci-signing.md:119-123` 的既有回退：停用 workflow、删除
  Environment Secret、继续用本地既有私钥 + 完整测试。已签名的清单仍按原公钥验证，
  **不需要用户数据迁移**。
- **文档回退**：本文与 `RELEASING.md` 冲突时，以**代码与测试的实际行为**为准
  （`catalog-test.mjs` 的 178 行 + `test-all.mjs` 的 suite 表）。

### 4.3 建议的落地顺序

1. 先在 `RELEASING.md` 顶部加一条指向本文的提示（一行，零风险）；
2. 做 A 档（`build-manifest.mjs --check` + 门禁 + `integrity.version` 断言），
   跑 `node scripts/test-all.mjs --mode release` 确认绿；
3. 决定是否恢复升级器。**不恢复就到此为止**——A 档已经让记录说真话；
4. 决定恢复再做 B 档，并且必须先确认既有私钥可取（否则只写 `integrity.json`）；
5. C 档只在「多贡献者 + 需要审查签名补丁」时才有价值，单人维护可以长期停在 B 档。
