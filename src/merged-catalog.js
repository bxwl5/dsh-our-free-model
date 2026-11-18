/**
 * 「按模型合并」的目录层（用户 2026-11-18）。
 *
 * ## 它解决什么
 *
 * 模型选择器严格按 provider 分组 —— 20 个账号渠道就占 20 个组，同一个
 * GLM-5.3 在选择器里出现五次，用户无法判断「该选哪一个」，而这五条背后
 * 是两个授权、三个额度池。用户的原话是「按照渠道分，太乱了，想按照模型分，
 * 相同模型合成一个，底层按照额度自动分配」。
 *
 * 本模块只做**目录**这一半：把各渠道的行按模型规格归并成一条虚拟行，成员
 * 记在 `merged` 上。选谁、失败了怎么换，是 `adapter.js` 的 `runMerged`。
 *
 * ## 归一化的棘轮只往松里调
 *
 * 同一个模型在不同渠道的 id 写法差异很大（实测 13 个渠道 237 行）：
 *
 * ```text
 * glm-5.3 / GLM-5.3 / glm-5.3-flash     大小写、点号
 * cline-pass/glm-5.3                    vendor 前缀（cline 自带 lane 段）
 * deepseek-v4.1-flash-1017              日期后缀
 * hy4flash-free / hy4flash              免费标记后缀
 * ```
 *
 * 归一化必须**保守**：把两个真不同的模型并成一条，会让用户选到的模型和
 * 实际下发的不一致（比"多几个分组"糟糕得多）。所以只剥三类确定无歧义的
 * 修饰：vendor 前缀段、`-free` 免费标记、纯四位数字日期后缀。剥完仍不同
 * 就是不同。
 *
 * 归并有两个键，任一相同即同一模型：
 *
 * 1. **id 键** —— 上面三类修饰剥完后的 id；
 * 2. **展示名键** —— 剥掉倍率后缀后的名字再按同样规则归一。
 *
 * 第二个键是为了 qoder / qodercn：它们的 id 是内部代号（`gmodel`、
 * `qmodel_38max`、`kmodel_latest`），而 codearts / trae 用产品名。只按 id
 * 归并时同一个 GLM-5.3 会变成两条同名条目 —— 正是用户抱怨的现象。
 *
 * ⚠️ **计费倍率（扣除系数）既不参与归并键，也不参与任何决策**（用户
 * 2026-11-18：「完全去掉系数影响」）。它只在渠道自己的选择器里作为该渠道的
 * 报价出现；合并行把成员名里的那段后缀剥掉（`stripMultiplierSuffix`），
 * 排序只看账号额度健康度（见 `adapter.js` 的 `orderMergedLanes`）。
 *
 * @module merged-catalog
 */

/**
 * 合并行的 id 前缀。
 *
 * 刻意与渠道 id 的 `channel:`、链路 id 的 `combo:` 区分开：这三种行在
 * 目录里同时存在，前缀是唯一能一眼判种别的字段。`merged:` 不是任何
 * provider 的合法 id，所以宿主不会把它当成某家的模型。
 */
export const MERGED_PREFIX = 'merged:'

/** 这条目录行是不是合并出来的虚拟行。 */
export function isMergedEntry(entry) {
  return typeof entry?.id === 'string' && entry.id.startsWith(MERGED_PREFIX)
}

/**
 * 一个 model id 的**归并键**。
 *
 * 全部小写；分隔符统一成 `-`；剥掉 vendor 前缀、`-free`、纯数字日期后缀。
 *
 * @param {string} id 渠道自己的 model id
 * @returns {string} 归并键（永不为空：空了就退回小写原串）
 */
export function canonicalModelKey(id) {
  let key = String(id ?? '').trim().toLowerCase()
  if (key === '') return ''
  // `cline-pass/glm-5.3` → `glm-5.3`。只剥**一段**：`anthropic/claude-sonnet-5.5`
  // 这类厂商段也只该剥一层就够，多剥会把 `meta/muse-ember` 和 `muse-ember` 之外
  // 的东西也算进来 —— 但两者本来就该是同一条，剥一层正好。
  const slash = key.lastIndexOf('/')
  if (slash >= 0) key = key.slice(slash + 1)
  // 分隔符统一：`deepseek_v4.1-flash` 与 `deepseek-v4.1-flash` 是同一个模型。
  key = key.replace(/[_\s]+/g, '-')
  // 免费标记：`hy4flash-free` 与 `hy4flash` 是同一个模型的两个套餐名。
  key = key.replace(/-free$/, '')
  // 快照日期后缀：`deepseek-v4.1-flash-1017` 的 `1017` 是月日（MMDD）。
  // ⚠️ 只在**四月日**时才剥：四位数字也可能是模型版本（`gpt-6-2060`）。
  // 判据是首两位构成合法月份（01–12）且后两位构成合法日（01–31）——
  // `1017`（10 月 17 日）成立，`2060`（20 月）不成立，于是版本号保留。
  const suffix = /-(\d{2})(\d{2})$/.exec(key)
  if (suffix !== null) {
    const month = Number(suffix[1])
    const day = Number(suffix[2])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      key = key.slice(0, -5)
    }
  }
  return key.replace(/^-+|-+$/g, '') || String(id).trim().toLowerCase()
}

/**
 * **展示名**的归并键：先剥倍率后缀，再按 id 键的规则归一。
 *
 * 和 `canonicalModelKey` 的唯一差别是 `/` 不当厂商分隔符剥掉 ——
 * 名字里的斜杠属于模型名（`A/B` 是「A 的 B 版」），不是 provider 前缀。
 * 两者用同一个键空间，好让 `gmodel`（qoder 的不透明 id）和它的展示名
 * `GLM-5.3` 经由另一个渠道的 `glm-5.3` 归到一起。
 *
 * @param {string} name 渠道自己报的展示名（可能带 ` · x1.5`）
 * @returns {string} 归并键；没有可用名字时为空串
 */
export function canonicalNameKey(name) {
  const stripped = stripMultiplierSuffix(name).replace(/\s*\/\s*/gu, '-')
  if (stripped === '') return ''
  return canonicalModelKey(stripped)
}

/** 合并行在目录里的 id。用归并键，保证同名模型只有一条。 */
export function mergedModelId(canonicalKey) {
  return `${MERGED_PREFIX}${canonicalKey}`
}

/**
 * 去掉展示名末尾的**计费倍率后缀**（`GLM-5.3 · x1.5` → `GLM-5.3`）。
 *
 * ## 为什么合并行要剥掉它
 *
 * 渠道包把倍率拼进 `name`（`glm-5.3 · x1.5`），因为 composer 的模型菜单只渲染
 * `name`。但倍率是**单个渠道**的报价：一条合并行背后有 2~6 个渠道，各自倍率
 * 不同，把其中一家的 `x1.5` 挂在合并行上等于报了个假价。
 *
 * 用户 2026-11-18 明确要求「完全去掉系数影响」—— 所以合并层既不读倍率做排序，
 * 也不在展示名里带任何系数：一条模型的名字就是模型名。
 *
 * 认的形态（都是渠道包真实产出的）：
 *
 * ```text
 * GLM-5.3 · x1.5              ← codearts / officeace / loomy 规范化形态
 * Qwen3.8-Max · x0.5→x0.2     ← qoder / trae / buddy 折扣价
 * MiniMax M3 （x4.0）          ← loomy 远端原值：末尾括号，全角半角都认
 * Kimi-K3 · 免费               ← raccoon 的免费文案
 * ```
 *
 * 刻意**不认**没有分隔符的 `x`（`Spark X2.5` 这类名字里本来就带 X 的模型），
 * 也不认名字中间的括号 —— 那是模型名的一部分（`loomy.ts:splitLoomyRate`
 * 同一条判据）。去掉后缀后名字为空（畸形数据）时原样返回。
 *
 * @param {string} name
 * @returns {string}
 */
export function stripMultiplierSuffix(name) {
  const text = typeof name === 'string' ? name.trim() : ''
  if (text === '') return text
  const rate = String.raw`x\s*\d+(?:\.\d+)?(?:\s*(?:→|->)\s*x\s*\d+(?:\.\d+)?)?`
  const tail = new RegExp(`^(.*?)\\s*·\\s*(?:免费|${rate})\\s*$`, 'iu').exec(text)
  if (tail !== null && String(tail[1]).trim() !== '') return String(tail[1]).trim()
  const bracket = new RegExp(`^(.*?)\\s*[（(]\\s*${rate}\\s*[)）]\\s*$`, 'iu').exec(text)
  if (bracket !== null && String(bracket[1]).trim() !== '') return String(bracket[1]).trim()
  return text
}

/**
 * 展示名：优先用成员里**最像产品名的那一个**。
 *
 * 各渠道的上报名混杂三种形态（实测）：
 *
 * ```text
 * GLM-5.3            ← 产品名（首选）
 * M3.1-Flash         ← 被截断的家族名前缀丢了（MiniMax 被剥成 M3.1）
 * Hy4 flash          ← 空格拼出来的
 * deepseek-v4-flash  ← 裸 id
 * ```
 *
 * 判据按优先级排：**含大写字母**（产品名几乎都有，裸 id 没有）→ **不含空格**
 * （空格说明它是拼出来的）→ **长度**（同分时取更长的不容易被截断，但超过
 * 归并键太多说明带了 "(free)" 之类的尾巴）。
 *
 * 最后兜底用归并键而不是原 id —— 归并键已经是去掉装饰后的稳定形态。
 */
function displayNameOf(models, canonicalKey) {
  const candidates = models
    .map(model => (typeof model.name === 'string' ? model.name.trim() : ''))
    .filter(name => name !== '')
  if (candidates.length === 0) return canonicalKey
  const score = name => {
    let value = 0
    if (/[A-Z]/.test(name)) value += 4
    if (!/\s/.test(name)) value += 2
    // 裸 id 特征：全小写且含连字符
    if (name === name.toLowerCase() && name.includes('-')) value -= 3
    // 长度接近归并键的最像「该模型的正式名」
    value -= Math.abs(name.length - canonicalKey.length) / 20
    return value
  }
  return candidates.reduce((best, name) => (score(name) > score(best) ? name : best), candidates[0])
}

/**
 * 只留下**注册过账号**的渠道（用户 2026-11-18：「只要渠道注册账号的，
 * 没注册账号的不要」）。
 *
 * 为什么在**名册**这一层筛而不是在合并行上筛：账号是 provider 级的
 * （一家渠道登录一次，它所有模型都能用），所以没账号的渠道整行丢弃 ——
 * 它的模型若只在这一家提供，那一行合并条目就不该出现在选择器里
 * （选了必然失败，还会把 `runMerged` 拖进「全员失败」分支）。
 *
 * `hasAccount` 返回 `undefined` 表示**读不出来**（账号池还没就绪、渠道包
 * 未挂载、读取出错）。此时保留该渠道：宁可多显示一条可能失败的行，也不要
 * 在冷启动那一瞬间把用户的选择器清空。
 *
 * @param {{providers: Array<{provider: string, models: Array<object>}>}} roster
 * @param {(provider: string) => boolean | undefined} hasAccount
 * @returns {{providers: Array<object>}} 过滤后的名册（不改入参）
 */
export function filterRosterByAccount(roster, hasAccount) {
  const providers = []
  for (const row of Array.isArray(roster?.providers) ? roster.providers : []) {
    const provider = typeof row?.provider === 'string' ? row.provider : ''
    if (provider === '') continue
    if (typeof hasAccount === 'function' && hasAccount(provider) === false) continue
    providers.push(row)
  }
  return { providers }
}

/**
 * 按「渠道是否被用户关闭」过滤名册（用户 2026-11-18：「我们聚合的模型再加个
 * 过滤，渠道管理页用户是可以关闭的」）。
 *
 * ## 为什么不能复用 listModels
 *
 * 合并层的输入是渠道包 provide 的 `channelPackRoster` —— 一份**未抑制**的
 * 名册。它存在的理由正是「抑制之后 listModels 恒为空，没有别的来源能知道
 * 哪个渠道有哪些模型」，所以它必须绕开抑制。代价是它**也绕开了**用户
 * 关掉的那一层：渠道管理页把一个渠道整条关闭时，落盘的是「该渠道全部模型
 * 进黑名单 + 全部账号停用」两个动作，而名册这一侧只做了账号可见性判断 ——
 * 于是被关掉的渠道依然出现在合并组里，用户选中的那条必然发不出去。
 *
 * 所以这里补一次显式的「关闭」判定，判据与渠道管理页的 `closed` 完全对齐
 * （见 `channel-pack-rpc.ts` 的 `provider.status`）：
 *
 * ```
 * 渠道的模型总数 > 0 且 全部被标为停用  ⇒ 该渠道被用户关闭
 * ```
 *
 * ## 为什么用「全关」而不是「关了一个模型」
 *
 * 单模型关闭（`model.setDisabled`）由渠道包在名册里**按模型**剔过了
 * （`disabledModelsFor` 参与构造 `models`），这里若再按模型过滤，会把
 * 「渠道没关、只关了一个型号」误判成整个渠道消失。只有「一个不剩」才是
 * 渠道级关闭的信号。
 *
 * ## 读不出来一律保留
 *
 * `isProviderClosed` 返回 `undefined` 表示渠道状态未知（账号池未就绪、
 * 渠道包未挂载）。与 {@link filterRosterByAccount} 同一条纪律：宁可多显示
 * 一条可能失败的行，也不要在冷启动那一瞬把用户的选择器清空。
 *
 * @param {{providers: Array<object>}} roster
 * @param {(provider: string) => boolean | undefined} isProviderClosed
 * @returns {{providers: Array<object>, dropped: string[]}} 过滤后的名册与被丢掉的渠道
 */
export function filterRosterByProvider(roster, isProviderClosed) {
  const providers = []
  const dropped = []
  for (const row of Array.isArray(roster?.providers) ? roster.providers : []) {
    const provider = typeof row?.provider === 'string' ? row.provider : ''
    if (provider === '') continue
    let closed
    try {
      closed = typeof isProviderClosed === 'function' ? isProviderClosed(provider) : undefined
    } catch {
      // 判据自己抛错 = 状态不明 = 保留。没人能保证某个渠道的状态查询不会
      // 因为账号池还没加载完而抛，而这条路上的任何一次异常都会让整轮目录
      // 重建失败 —— 宁愿多留一条可能失败的行。
      closed = undefined
    }
    if (closed === true) {
      dropped.push(provider)
      continue
    }
    providers.push(row)
  }
  return { providers, dropped }
}

/**
 * 把各渠道名册合并成虚拟目录行。
 *
 * @param {{providers: Array<{provider: string, models: Array<{id: string, name?: string}>}>}} roster
 *   渠道包 `channelPackRoster` 的返回值（未抑制、已剔除用户黑名单）
 * @param {(provider: string, modelId: string) => object} [healthOf]
 *   可选的健康度注入点；合并层不在这里 await，排序留给下发时做
 * @param {ReadonlySet<string>} [closedProviders]
 *   被用户关闭的渠道集合（渠道管理页整条关掉的那几家）。这些渠道的成员
 *   **不参与归并**：若某条合并行只剩它们，这条行直接消失；若还有别的渠道
 *   提供同一模型，行保留、只是少了这些候选。
 * @returns {Array<object>} 按归并键排序的合并行
 */
export function buildMergedCatalog(roster, closedProviders) {
  /**
   * 两个归并键：**id 键** 与 **展示名键**。
   *
   * 为什么需要第二个：qoder / qodercn 的 id 是不透明的代号（`gmodel`、
   * `qmodel_38max`、`kmodel_latest`），而 codearts / trae 用的是产品名
   * （`glm-5.3`、`qwen3.8-max`、`kimi-k3.1-pro`）。只看 id 键时它们是两组，
   * 选择器里就出现**两条同名条目**（`GLM-5.3` ×2）—— 而用户要的是
   * 「相同模型合成一个」。展示名是这些渠道自己声明「这是哪个模型」的唯一
   * 跨渠道口径，所以按「id 键相同 **或** 展示名键相同」做并查集归并。
   *
   * 只在**名字**上做键，所以 `hy4-preview` 与 `hy4-preview-x` 仍是两条。
   */
  const rows = []
  for (const row of Array.isArray(roster?.providers) ? roster.providers : []) {
    const provider = typeof row?.provider === 'string' ? row.provider : ''
    if (provider === '') continue
    if (closedProviders instanceof Set && closedProviders.has(provider)) continue
    for (const model of Array.isArray(row.models) ? row.models : []) {
      const rawId = typeof model?.id === 'string' ? model.id.trim() : ''
      if (rawId === '') continue
      const idKey = canonicalModelKey(rawId)
      const nameKey = canonicalNameKey(model?.name)
      if (idKey === '' && nameKey === '') continue
      rows.push({ provider, id: rawId, name: model?.name, idKey, nameKey })
    }
  }

  const parent = rows.map((_, index) => index)
  const find = index => {
    let root = index
    while (parent[root] !== root) root = parent[root]
    while (parent[index] !== root) {
      const next = parent[index]
      parent[index] = root
      index = next
    }
    return root
  }
  const union = (a, b) => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB)
  }
  /** 键 → 首次出现的行号；两个键空间用前缀分开，避免同名 id/名字互相串。 */
  const firstOf = new Map()
  rows.forEach((row, index) => {
    for (const [prefix, key] of [['id:', row.idKey], ['name:', row.nameKey]]) {
      if (key === '') continue
      const bucket = `${prefix}${key}`
      if (firstOf.has(bucket)) union(index, firstOf.get(bucket))
      else firstOf.set(bucket, index)
    }
  })

  const groups = new Map()
  rows.forEach((row, index) => {
    const root = find(index)
    let group = groups.get(root)
    if (group === undefined) {
      group = { keys: [], members: [], models: [] }
      groups.set(root, group)
    }
    if (row.idKey !== '' && !group.keys.includes(row.idKey)) group.keys.push(row.idKey)
    group.members.push({ provider: row.provider, model: row.id })
    group.models.push({ provider: row.provider, id: row.id, name: row.name })
  })

  const entries = []
  for (const group of groups.values()) {
    /**
     * 组键：优先取**能对上展示名**的那个 id 键（`glm-5.3` 对得上
     * `GLM-5.3`，`gmodel` 对不上任何名字 —— 它是 qoder 的内部代号），
     * 其次看哪个键在组里出现得更多，最后取字典序最小。
     *
     * 三条判据的次序很重要：先按人数会让 `gmodel`（qoder + qodercn 两家）
     * 压过 `glm-5.3`（只有 codearts 一家），组 id 就变成代号；
     * 而 id 会落进用户的会话记录，必须稳定且可读。
     */
    const nameKeys = new Set()
    for (const model of group.models) {
      const nameKey = canonicalNameKey(model?.name)
      if (nameKey !== '') nameKeys.add(nameKey)
    }
    const counts = new Map()
    for (const member of group.members) {
      const idKey = canonicalModelKey(member.model)
      if (idKey !== '') counts.set(idKey, (counts.get(idKey) ?? 0) + 1)
    }
    const key = [...counts]
      .sort((a, b) => Number(nameKeys.has(b[0])) - Number(nameKeys.has(a[0]))
        || b[1] - a[1]
        || a[0].localeCompare(b[0]))[0]?.[0]
      ?? group.keys[0]
      ?? [...nameKeys][0]
    if (key === undefined || key === '') continue
    const ids = group.members.map(member => `${member.provider}/${member.model}`)
    if (group.members.length === 1) {
      /**
       * 单成员也走合并行（而不是原样返回渠道行）。
       *
       * 理由：用户要的是「一个模型一条」。若单成员退回渠道行，选择器里会
       * 只剩 `trae` / `qoder` 这类分区标题下的零散条目 —— 与"按模型分"
       * 的诉求正好相反，而且分组标题又回来了。
       */
    }
    entries.push({
      id: mergedModelId(key),
      /**
       * 展示名 = 最像产品名的那个成员名，**并把它的倍率后缀剥掉**。
       *
       * 倍率是单渠道的报价：一条合并行背后有 2~6 家，各自倍率不同，
       * 挂着其中一家的 `x0.79` 就是报了个假价（用户 2026-11-18 要求
       * 「完全去掉系数影响」）。
       */
      name: stripMultiplierSuffix(displayNameOf(group.models, key)),
      canonicalKey: key,
      /** 候选渠道，顺序即默认优先级（下发时按额度健康度重排）。 */
      merged: group.members.map(member => ({ provider: member.provider, model: member.model })),
      /** 面板/提示用：这条模型在几个渠道上有。 */
      laneCount: new Set(group.members.map(member => member.provider)).size,
      providerModelIds: ids,
    })
  }
  entries.sort((a, b) => a.canonicalKey.localeCompare(b.canonicalKey))
  return entries
}

/**
 * 渠道 id → 合并行的归并键（旧会话迁移用）。
 *
 * 宿主发消息前用 `modelAvailable()` 校验，而它走 `listModels()` —— 抑制后
 * 渠道分组为空，旧会话里的 `trae/glm-5.3` 会被判不可用。合并层据此把
 * 「那个模型在合并组里的 id」找出来，作为可读的迁移建议。
 *
 * @param {Array<object>} entries 合并行
 * @param {string} providerModelId 形如 `trae/glm-5.3`
 * @returns {string | undefined} 对应的合并行 id
 */
export function mergedIdForProviderModel(entries, providerModelId) {
  const key = canonicalModelKey(String(providerModelId ?? '').split('/').pop() ?? '')
  if (key === '') return undefined
  const hit = entries.find(entry => entry.canonicalKey === key)
  return hit?.id
}
