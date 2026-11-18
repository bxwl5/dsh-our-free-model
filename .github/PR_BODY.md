## 按模型合并选择器分组 + 分组启停 + 风控/失效模型自动治理

### 问题

模型选择器严格按渠道分组：20 个账号渠道各自一组，同一个 GLM-5.3 在选择器里出现 5 次，且其中不少条目因为渠道下架/额度用尽/账号权限而必然失败。合并目录、失效模型、风控冷却此前也缺乏自动治理，全靠人工点「重新获取模型」。

### 改动

**1. 按模型合并选择器分组**
- 新增 `src/merged-catalog.js`：同名模型跨渠道并成一条 `merged:` 虚拟行，选择器从 20+ 个渠道分组收敛为一个「Our Free Model」
- 归并键 = id 键 ∪ 展示名键（并查集）：qoder/qodercn 的不透明代号（`gmodel`/`kmodel_latest`…）经展示名归入正确产品族
- 展示名剥离单渠道报价后缀（`· x1.5` 等），不编造系数

**2. 自选模型分组（新的 provider）**
- 设置页新增「模型分组」标签：从当前模型池勾选模型组成 `ofm-*` 自定义 provider
- 分组支持启用/停用（停用 = 选择器整组消失，路由保留、旧会话可用）
- 可隐藏默认分组；模型按名称首词分族展示，支持整族全选/清除

**3. 风控（3012）选号剔除（方案 A）**
- `getAvailableAccount` 剔除 `riskBlockedUntilMs` 未到期的账号，避免冷却期反复撞墙升级惩罚（30min → 24h）
- 全部账号都在冷却时回退按原顺序交付，不把 provider 整条掐死

**4. 失效模型自动下架**
- `isModelGoneError` 识别 buddy 形态「model [id] service info not found」，直调失败即落账
- `recordDeadModel` 落账后广播（`llm/adapters-updated` + 专用事件 `channel-pack/dead-model-marked`，避免自监听递归），宿主合并组 1s 去抖重建，死模型即时从选择器消失

**5. 启动首轮强制重拉远端目录**
- 挂载 30s 后串行刷新各渠道 `refreshCatalog`（间隔 800ms），目录过期窗口从快照 TTL 缩短到单次启动
- 失败保留原目录；只问已登录渠道

**6. 日额度用尽不再当 30s 抖动**
- `Billing daily count exceeded` / `insufficient_quota` 归类为 billing · account · 30min 冷却（此前 unknown/transient · 30s，每半分钟白撞一次注定失败的渠道，拖慢每次请求 0.5–3s）

### 测试

新增 5 个套件（merged-catalog / merged-advertisement / custom-providers / risk-block / dead-model），全部挂进 test-all。**87/91 通过**；4 个失败（zcode-app-version、artifact-freshness、standalone-package、catalog）为基线既有，与本次改动无关。

### 已知取舍

- `Backend [...] is not supported`（buddy 3 条）**刻意不认**为失效——换套餐/账号类型后可能恢复，与「supported 属换套餐即恢复」的既有口径一致
- 合并行的渠道级排序仍只看账号健康度，不感知账号级风控标记（账号层剔除已在账号池生效）
EOF