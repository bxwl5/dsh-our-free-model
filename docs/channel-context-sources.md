# 各渠道「上下文窗口」的来源：本地还是远端

> 排查时间 2026-11-04。结论按**当前磁盘缓存 + 实测返回值**双向核对，
> 不是读代码猜的：每一条都标了「缓存里有没有容量字段」与「resolveModel 的取值链」。

## 一句话结论

**没有任何一个渠道是「纯远端实时」的。** 全部走「远端拉取一次 → 落盘缓存 →
之后永远读缓存；缓存没有该字段时，退到代码里写死的表」。差别只在最后一层的
兜底表是通用表还是产品专用表。

## 三层结构（通用模式）

渠道包几乎所有适配器都共用同一套分层：

```
resolveModel(provider, model)
  ├─ ① remoteContextWindows / remoteMeta    ← 远端目录拉下来后解析出的容量
  │     └─ 来源：fetchModels() 打渠道自己的 /models 端点，结果落盘到
  │              ~/.dsh/channel-pack/model-catalogs/<provider>.json
  ├─ ② productFallbackContextWindows        ← 按产品写死的兜底表（产品专用）
  └─ ③ CONTEXT_WINDOWS / CONTEXT_WINDOWS2   ← 全局写死的表（通用兜底）
```

关键点：**①②③ 都命中不了时，`resolved.context` 整个字段就不设** ——
于是上游 `buildChannelCatalog` 会填自己的兜底值。2026-11-09 起该上下文
伪装值改为 **512000（界面显示 512K）**（此前是 131072），输出上限仍是 32768。
所以「看到 512K」= 该渠道这次没提供容量信息。

`ensureRemoteModels()` 是「有值即返回」的一次性懒加载，只在进程内首次
需要时拉一次远端；之后（含重启后）都读磁盘快照（`restoreFromDisk()`）。

## 逐个渠道

| 渠道 | 磁盘缓存 | 缓存含容量 | 实际容量来源 | 判定 |
|---|---|---|---|---|
| `channel:codearts` | **无缓存文件** | — | `CONTEXT_WINDOWS`（写死 5 条表） | **纯本地** |
| `channel:officeace` | 25 条 | **0/25** | `CONTEXT_WINDOWS2` 写死表 | **纯本地** |
| `channel:trae` | 35 条 | **0/35 含 contextWindow**（字段是 `maxMode`/`reasoningConfig`） | `CONTEXT_WINDOWS2` 写死表 | **纯本地** |
| `channel:qoder` | 14 条 | 14/14 | 远端目录 | 远端一次 + 缓存 |
| `channel:qodercn` | 11 条 | 11/11 | 远端目录 | 远端一次 + 缓存 |
| `channel:buddy` | 32 条 | 28/32 | 远端目录 | 远端一次 + 缓存 |
| `channel:workbuddy` | 23 条 | 21/23 | 远端目录 | 远端一次 + 缓存 |
| `channel:raccoon` | 6 条 | 6/6 | 远端目录 | 远端一次 + 缓存 |
| `channel:minimax` | 2 条 | 2/2 | 远端目录 | 远端一次 + 缓存 |
| `channel:zcode` | 2 条 | 2/2 | 远端目录 | 远端一次 + 缓存 |
| `channel:autoclaw` | 5 条 | 5/5 | 远端目录 | 远端一次 + 缓存 |
| `channel:loomy` | 9 条 | 8/9 | 远端目录 | 远端一次 + 缓存 |

**纯本地三家：codearts、officeace、trae。** 剩下九家是远端拉一次然后吃缓存。

（另有 `kuku` 13 条缓存 0 条含容量、`cline` 463 条仅 18 条含容量，
这两家当前未作为路由候选使用，但同样属于「拿不到就兜底」。）

## 对用户的实际影响

- **纯本地三家的容量升级要改代码**：模型方把上下文从 100 万提到 200 万，
  插件不会知道，得改 `CONTEXT_WINDOWS` / `CONTEXT_WINDOWS2` 或产品兜底表。
- **其余九家**只要远端目录改了，下次拉取（重启或点「重新获取模型」）就生效。
- **磁盘缓存的时效**：文件里能看到 `11月4日 15:44`、`16:00` 这类时间戳，
  说明本轮确实重写过；但它是「有值即返回」的懒加载，不会自动定期刷新。

## 为什么 officeace 明明有远端目录却仍是纯本地

它的 `/models` 端点（`officeace.json` 25 条）只下发 `id` / `name` / `rate`
（倍率），**根本不含 `contextWindow`**。所以远端这一层对容量永远返回空，
必然落到 `CONTEXT_WINDOWS2`。这也解释了为什么之前修 OfficeAce 上下文时
是直接改本地表而不是等远端。

`trae` 同理：它的目录带 `maxMode`、`reasoningConfig`、`isEnabled`，
容量不在其中。

## 需求「在添加成员时只拉已启用模型」与此的关系

已经落地（`combos.list` 的 light 刷新）。light 模式**跳过**逐模型
`resolveModelInfo`，因此不触碰上面这套三层解析 —— 只问 `llm.listModels()`
拿启用清单。好处是点「添加成员」从秒级降到约 30ms，且开关立刻反映；
代价是**新出现**的模型第一次看到时容量是本插件的伪装值 512K，
下一次完整扫描（启动/定时）会补齐。

## 2026-11-09 补记：重启后上下文掉回兜底值

用户报障：全新安装 / 重启后路由页里模型上下文显示 131K，点「刷新模型列表」
无效，「重新获取模型」短暂修复、重启复现，随后又会自己恢复。根因不在上面
三层解析，而在**本插件自己的目录行没有持久化**：

- `channelCatalog` 是 `runtime.js` 的进程内变量；`catalogStore` 只存免费车道
  id 和 `kiloRows`，从没存过渠道行。远端目录（channel-pack 的
  `model-catalogs/*.json`）虽然落盘，本插件重建目录时却只靠
  `resolveModelInfo` 间接拿，冷启动那轮完整扫描又常被 6s 预算掐断。
- light 模式只复用进程内 `previousRows`；冷启动它为空或就是占位符，于是
  「复用上次结果」=「复用错误值」，路由页（恰好走 light）最后一个恢复。
- 定时轮询（默认 15 分钟）跑完一轮完整扫描后缓存变热，所以「自己恢复」。

修复（本次）：
1. `catalog.json` 新增 `channelRows`：完整扫描后按 provider 合并写盘
   （`mergeChannelCatalogRows` 保证残缺扫描不洗掉真值），冷启动先
   `reviveChannelCatalog` 回灌上屏。
2. light 模式新增 `cachedRows` 磁盘回退层，且伪装值不入回灌 map。
3. 伪装值 131072 → **512000**（界面显示 512K），仍只是占位符，不是真实容量。
