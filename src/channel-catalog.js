/**
 * Catalog rows for the absorbed channel providers.
 *
 * The plugin registers one route (`our-free-model`) and serves two families of
 * models: its own free lane, and the channel providers the vendored pack
 * registers (`zcode`, `trae`, `qoder`, `cline`, ...). The
 * routing page's member picker has to offer **both**, because a chain that can
 * only reach the free-lane models cannot cover the case it exists for -- a
 * lane whose credential lapsed while other channels sat idle.
 *
 * ## Where the rows come from
 *
 * `ctx.llm.listProviders()` names every provider this host has a registered
 * adapter for; `ctx.llm.listModels(provider)` gives that provider's roster as
 * the adapter itself reports it. Both are the *same* source the gateway page
 * and the channel panel read, so the picker cannot disagree with them.
 *
 * `listModels` applies the channel's own disabled-model blacklist. That is
 * deliberate: a model the user switched off in the channel panel must not be
 * offered as a chain link, or the chain would silently never answer.
 *
 * ## Why these rows carry `channel` and not a wire
 *
 * An absorbed row carries `channel: 'channel:<provider>'` and is served by
 * delegating the whole call back to the host (`ctx.llm.prepareCall`) rather
 * than by any wire this plugin speaks. The adapter therefore never needs the
 * provider's endpoint, credential or protocol -- the host already owns those.
 *
 * @module src/channel-catalog.js
 */

/** Catalog `channel` value prefix for rows that belong to an absorbed provider. */
export const CHANNEL_PREFIX = 'channel:'

/**
 * 拿不到真实容量时对外声称的上下文窗口 **512K**（用户 2026-11-09 定）。
 *
 * 仍是「伪装值」，不是任何模型的真实容量：它只在 `buildChannelCatalog` 与
 * 链路容量交集里占位。之所以从 131072 抬到 512000，是因为冷启动时序让大量
 * 真实模型暂时落到兜底，131K 会被误读成「模型只有 128K」；512K 至少不把
 * 1M 级的模型低估得那么刺眼。**真正修好冷启动靠目录行持久化（catalog.json
 * 的 `channelRows`）+ light 模式读盘回退，不靠把这个数字调大。**
 *
 * ⚠️ 只用于「上下文」；输出上限的兜底仍是 32768，两者不要混。
 * 全仓库所有「上下文窗口未知」的兜底统一 import 本常量,避免各写各的魔数。
 * 注意:模型能力表里的 `maxOutput: 131072`、stream/recovery 的
 * `checkpointLimit: 131072`、设置页 512–131072 的输出上限是**不同语义**,不改。
 *
 * 取 **512000** 而不是 524288(2^19):前端 `kilo()` 用 1000 进制渲染
 * (`131072 → "131K"`), 524288 会显示成 "524K"。要显示成 512K,数值必须是
 * 512000。
 */
export const FALLBACK_CONTEXT_WINDOW = 512_000

/**
 * 历次用过的伪装值。回灌磁盘/进程内缓存时要跳过它们 —— 否则冷启动那轮
 * 残缺快照会把占位符当成真值一路传下去。真实模型恰好等于这些数值时跳过
 * 也无害(回退值同值)。
 */
export const PLACEHOLDER_CONTEXT_WINDOWS = new Set([131_072, FALLBACK_CONTEXT_WINDOW])

/** Route ids this plugin owns, which must never be absorbed. */
const OWN_ROUTES = new Set(['our-free-model', 'our-free-model-region'])

/**
 * `channel:zcode` -> `zcode`.
 *
 * Only the segment before the first slash is the provider: a model name may
 * contain slashes of its own (`channel:cline/anthropic/claude-sonnet-5.5`), and
 * reading to the end of the string would produce a provider that never existed.
 */
export function providerOfChannel(channel) {
  if (typeof channel !== 'string' || !channel.startsWith(CHANNEL_PREFIX)) return undefined
  const rest = channel.slice(CHANNEL_PREFIX.length)
  const slash = rest.indexOf('/')
  const provider = slash < 0 ? rest : rest.slice(0, slash)
  return provider === '' ? undefined : provider
}

/** Is this catalog row an absorbed channel model (rather than free lane/kilo)? */
export function isChannelEntry(entry) {
  return providerOfChannel(entry?.channel) !== undefined
}

/**
 * The model id a chain link uses for an absorbed row.
 *
 * The id has to be unique across every lane, and several providers legitimately
 * ship the same model name (`GLM-5.3` exists on more than one). Prefixing with
 * the provider keeps them apart and makes the stored chain readable, and the
 * `channel:` prefix keeps it from colliding with a free-lane id or a combo.
 */
export function channelModelId(provider, model) {
  return `${CHANNEL_PREFIX}${provider}/${model}`
}

/**
 * Split a `channel:` id back into its provider and the provider's own model
 * name. Returns `undefined` for anything that is not an absorbed id.
 *
 * The model name may itself contain slashes (Cline ships
 * `anthropic/claude-sonnet-5.5`), so only the *first* slash splits.
 */
export function parseChannelModelId(id) {
  const channel = providerOfChannel(id)
  if (channel === undefined) return undefined
  const slash = id.indexOf('/', CHANNEL_PREFIX.length)
  if (slash < 0) return undefined
  const model = id.slice(slash + 1)
  return model === '' ? undefined : { provider: channel, model }
}

/**
 * Build absorbed-channel catalog rows from what the host reports.
 *
 * @param {Array<{provider: string, models: Array<object>}>} rosters
 *   one entry per provider, `models` in the host's own order
 * @returns {Array<object>} catalog rows, provider by provider in input order
 */
export function buildChannelCatalog(rosters) {
  const seen = new Set()
  const rows = []
  for (const roster of Array.isArray(rosters) ? rosters : []) {
    const provider = roster?.provider
    if (typeof provider !== 'string' || provider === '') continue
    for (const model of Array.isArray(roster.models) ? roster.models : []) {
      const name = typeof model?.id === 'string' ? model.id.trim() : ''
      if (name === '') continue
      const id = channelModelId(provider, name)
      if (seen.has(id)) continue
      seen.add(id)
      const contextWindow = Number(model.contextWindow)
      const maxOutput = Number(model.maxOutput ?? model.maxTokens)
      rows.push({
        id,
        name: typeof model.name === 'string' && model.name !== '' ? model.name : name,
        channel: `${CHANNEL_PREFIX}${provider}`,
        vision: Array.isArray(model.inputModalities) && model.inputModalities.includes('image'),
        reasoning: true,
        contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? Math.trunc(contextWindow) : FALLBACK_CONTEXT_WINDOW,
        maxOutput: Number.isFinite(maxOutput) && maxOutput > 0 ? Math.trunc(maxOutput) : 32768,
        // The host owns the thinking menu for its own providers and applies the
        // right one on dispatch; this plugin must not claim to know it.
        canDisableThinking: false,
        regionSensitive: false,
        /** The provider's own model name, for the wire and for display. */
        providerModel: name,
        provider,
      })
    }
  }
  return rows
}

/**
 * 从持久化的 `channelRows` 回读目录行,逐字段校验。
 *
 * 这些行是 `buildChannelCatalog` 的成品(不是宿主 listing 行),所以只需重建
 * 结构、验证 id 形态与容量数字,损坏项直接丢弃 —— 宁可少一列候选,也不能让
 * 一条畸形记录污染整张目录。字段与 `reviveKiloCatalog` 同策略。
 *
 * 用途有二(用户 2026-11-09 报障:重启后路由里模型上下文掉回 131K):
 *  - 冷启动:磁盘真值先上屏,不必等 6s 预算内的完整扫描;
 *  - light 模式:上一次完整扫描的结果从磁盘回灌,而不是只靠进程内
 *    `previousRows`(冷启动那轮被预算掐断时它本身就是兜底值)。
 *
 * @param {unknown} stored
 * @returns {Array<object>}
 */
export function reviveChannelCatalog(stored) {
  const seen = new Set()
  const rows = []
  for (const row of Array.isArray(stored) ? stored : []) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    if (typeof row.id !== 'string' || row.id.trim() === '' || !isChannelEntry(row)) continue
    const provider = providerOfChannel(row.channel)
    if (provider === undefined) continue
    const parsed = parseChannelModelId(row.id)
    if (parsed === undefined || parsed.provider !== provider) continue
    const contextWindow = Number(row.contextWindow)
    const maxOutput = Number(row.maxOutput)
    const id = row.id.trim()
    if (seen.has(id)) continue
    seen.add(id)
    rows.push({
      id,
      name: typeof row.name === 'string' && row.name !== '' ? row.name : parsed.model,
      channel: row.channel,
      vision: row.vision === true,
      reasoning: row.reasoning !== false,
      contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? Math.trunc(contextWindow) : FALLBACK_CONTEXT_WINDOW,
      maxOutput: Number.isFinite(maxOutput) && maxOutput > 0 ? Math.trunc(maxOutput) : 32768,
      canDisableThinking: row.canDisableThinking !== false,
      regionSensitive: row.regionSensitive === true,
      providerModel: typeof row.providerModel === 'string' && row.providerModel !== '' ? row.providerModel : parsed.model,
      provider: typeof row.provider === 'string' && row.provider !== '' ? row.provider : provider,
    })
  }
  return rows
}

/**
 * 把一次扫描的结果并入持久化目录行,供写盘(以及重启回灌)使用。
 *
 * ## 为什么不能直接 `rows` 覆盖(2026-11-09 报障的第二层)
 *
 * 完整扫描有 {@link ROSTER_BUDGET_MS} 预算:冷机时常常只扫到前几家就 break,
 * 且渠道包是**异步挂载**的 —— 启动那轮 `packProviders` 往往还是空的,
 * `rows` 直接就是 `[]`。若拿它覆盖磁盘,上一次攒下的真值会被一次残缺扫描
 * 全部洗掉,下次重启更空,反复劣化。
 *
 * 规则:
 * - `scannedProviders` 里**没出现**的 provider:整家保留磁盘旧行(本轮没扫,
 *   不代表它不存在;凭据过期/未登录时尤其如此);
 * - 出现过的 provider:磁盘旧行作废,以本轮 `fresh` 为权威启用清单(用户刚
 *   关掉的模型必须能消失);
 * - 本轮行的上下文若是**伪装值**,而磁盘同 id 有真实容量 → 回填真值,
 *   避免预算中途耗尽把已解析到的真值洗成占位符。
 *
 * @param {readonly object[]} fresh - 本轮 `readChannelRosters` 产出的行
 * @param {readonly object[]} cached - 磁盘上已有的行(已 revive 校验)
 * @param {readonly string[]} scannedProviders - 本轮确实问过 listModels 的 provider
 * @returns {Array<object>}
 */
export function mergeChannelCatalogRows(fresh, cached, scannedProviders) {
  const scanned = new Set(Array.isArray(scannedProviders) ? scannedProviders : [])
  const safeFresh = Array.isArray(fresh) ? fresh : []
  const safeCached = Array.isArray(cached) ? cached : []
  const byId = new Map(safeCached.map(row => [row.id, row]))
  const out = []
  const seen = new Set()
  // ① 本轮没扫到的 provider:磁盘行整体保留。
  for (const row of safeCached) {
    if (scanned.has(row.provider)) continue
    if (seen.has(row.id)) continue
    seen.add(row.id)
    out.push(row)
  }
  // ② 本轮扫到的 provider:以 fresh 为权威,必要时回填磁盘真值。
  for (const row of safeFresh) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    const prior = byId.get(row.id)
    if (prior !== undefined && PLACEHOLDER_CONTEXT_WINDOWS.has(Number(row.contextWindow))) {
      const real = Number(prior.contextWindow)
      if (Number.isFinite(real) && real > 0 && !PLACEHOLDER_CONTEXT_WINDOWS.has(real)) {
        out.push({ ...row, contextWindow: Math.trunc(real) })
        continue
      }
    }
    out.push(row)
  }
  return out
}

/**
 * Read every absorbed provider's roster off the host.
 *
 * Failure is per provider: one channel whose credential lapsed must not empty
 * the whole picker. A provider that throws contributes nothing this round and
 * the reason is reported through `onError`.
 *
 * @param {{listProviders?: () => readonly {id: string}[], listModels?: (provider: string) => Promise<readonly object[]>}} llm
 * @param {Set<string>} packProviders - provider ids the vendored pack registered
 * @param {(provider: string, error: unknown) => void} [onError]
 * @returns {Promise<{rows: Array<object>, providers: string[]}>}
 */
export async function readChannelRosters(llm, packProviders, onError, options = {}) {
  /**
   * `light` 模式：**只问「这一家当前启用了哪些模型」**，不逐模型解析容量。
   *
   * ## 为什么要这个模式（2026-11-04 用户要求）
   *
   * 「点『添加成员』时看到最新的已启用模型」这个需求，只需要知道**启用清单**；
   * 而本函数的重开销全在 `resolveModelInfo`（每个模型一次，会打到适配器的
   * `ensureRemoteModels`，含读盘）—— 那是为了拿 contextWindow / maxOutput，
   * 与「哪些模型开着」**无关**。
   *
   * 走 light 模式时：
   * - 仍会问 `llm.listModels(provider)`（宿主返回的本就是**已启用**的模型，
   *   适配器的 `listModels` 内部已按黑名单过滤）⇒ 开关立刻反映；
   * - 复用 `previousRows` + `cachedRows` 里同 id 行的容量元数据；
   * - 新出现的行用兜底值，下一次完整扫描会补齐。
   *
   * ## 为什么多一层 `cachedRows`（2026-11-09 用户报障）
   *
   * `previousRows` 是**进程内**变量,冷启动时为空;而冷启动那轮完整扫描又
   * 常被 6s 预算掐断,`previousRows` 里存的就是兜底值。于是 light 模式「复用
   * 上次结果」等于「复用错误值」,路由页永远显示 131K。`cachedRows` 来自
   * `catalog.json` 的 `channelRows`(上一次成功扫描写盘的真值),跨重启可读,
   * 正好补上这个断层。优先级:进程内(最新) > 磁盘(较旧但真实)。
   *
   * @type {{ light?: boolean, previousRows?: readonly object[], cachedRows?: readonly object[] }}
   */
  const light = options.light === true
  const previous = new Map()
  // 优先级不是简单的「谁新谁赢」:磁盘较旧但通常是真值,进程内较新但冷启动
  // 那轮常是被预算掐断后的占位符。规则:
  //  - 两边都只收「非伪装值」的容量(见 PLACEHOLDER_CONTEXT_WINDOWS);
  //  - 磁盘先放,进程内后放并覆盖 —— 同为真实值时后者更接近当下;
  //  - 进程内若是占位符,直接跳过,绝不能盖掉磁盘真值(2026-11-09 报障)。
  // 占位符干脆不入 map: light 循环里没有 prior 时该行自然落到兜底值,等价。
  const remember = rows => {
    for (const row of Array.isArray(rows) ? rows : []) {
      if (typeof row?.id !== 'string') continue
      if (PLACEHOLDER_CONTEXT_WINDOWS.has(Number(row.contextWindow))) continue
      previous.set(row.id, row)
    }
  }
  remember(options.cachedRows)
  remember(options.previousRows)
  const rows = []
  const providers = []
  if (llm === undefined || llm === null) return { rows, providers }
  let listed = []
  try {
    const value = typeof llm.listProviders === 'function' ? llm.listProviders() : []
    listed = Array.isArray(value) ? value : []
  } catch (error) {
    onError?.('listProviders', error)
    return { rows, providers }
  }
  if (typeof llm.listModels !== 'function') return { rows, providers }
  // `listModels` 只有 id/name/模态，**没有** contextWindow / maxOutput —— 早期版本
  // 因此把每个渠道模型都标成兜底值，用户看到「所有渠道模型都是 131K/33K」。
  // 适配器自己的 `resolveModelInfo` 才带真实容量（它读远端目录 + 产品兜底表 +
  // 静态表三级），所以这里逐模型补一次查询；失败不阻塞目录，那一行保持未知
  // 而不是编一个假数字。
  const resolve = typeof llm.resolveModelInfo === 'function' ? llm.resolveModelInfo.bind(llm) : undefined
  const startedAt = Date.now()
  for (const info of listed) {
    const provider = typeof info?.id === 'string' ? info.id : ''
    if (provider === '' || OWN_ROUTES.has(provider)) continue
    if (!packProviders.has(provider)) continue
    /**
     * ⚠️ **超时就收工，绝不无限期扫下去**（2026-11-04 事故）。
     *
     * 这个函数在**启动路径上被 `await`**（`runtime.js` 的 `refreshCatalog`）：
     * 它每慢一秒，宿主就晚一秒开始监听 HTTP。实测「15 个渠道 × 每家几十个模型
     * 各调一次 `resolveModelInfo`」会拖到分钟级 —— 而每次 `resolveModelInfo`
     * 都打到适配器的 `ensureRemoteModels()`（含 `statSync` 读盘、cordis 响应式
     * 代理开销），冷启动时尤其重。表现就是「CPU 飙升、HTTP 端口无响应、
     * 桌面端 watchdog 报 Harness service is not listening」。
     *
     * ⇒ 预算 {@link ROSTER_BUDGET_MS} 内拿到多少就返回多少，剩下的下一轮再说。
     * 目录是**建议性**的（picker/路由成员候选），少几个模型不影响已有链路可用；
     * 而卡死启动是致命故障 —— 两害相权取轻。
     */
    if (Date.now() - startedAt > ROSTER_BUDGET_MS) {
      onError?.(provider, new Error(`roster budget ${ROSTER_BUDGET_MS}ms exhausted; remaining providers deferred`))
      break
    }
    try {
      const models = await llm.listModels(provider)
      const roster = Array.isArray(models) ? models : []
      if (roster.length === 0) continue
      providers.push(provider)
      if (light) {
        // 复用「进程内上次扫描 / 磁盘 channelRows」拿到的真实容量（同 id 才算）。
        // 只认非伪装值：131K(旧版)/512K(现行) 都是占位符,不能当真值回灌,
        // 否则冷启动那轮残缺快照会把错误值一直传下去。新行留给兜底值,
        // 下一次完整扫描补齐。
        for (const model of roster) {
          const prior = previous.get(channelModelId(provider, String(model?.id ?? '')))
          if (prior === undefined) continue
          const context = Number(prior.contextWindow)
          const maxOutput = Number(prior.maxOutput)
          if (Number.isFinite(context) && context > 0 && !PLACEHOLDER_CONTEXT_WINDOWS.has(context)) model.contextWindow = Math.trunc(context)
          if (Number.isFinite(maxOutput) && maxOutput > 0) model.maxOutput = Math.trunc(maxOutput)
        }
      } else if (resolve !== undefined && roster.length <= 64) {
        await mapWithConcurrency(roster, ROSTER_RESOLVE_CONCURRENCY, async model => {
          // 预算耗尽就不再解析容量：行仍然进目录，只是 contextWindow 保持
          // `listModels` 给的兜底值（未知好过让整轮超时）。
          if (Date.now() - startedAt > ROSTER_BUDGET_MS) return
          try {
            const resolved = await resolve(provider, model.id)
            const context = Number(resolved?.context?.contextWindow)
            const maxTokens = Number(resolved?.defaultMaxTokens)
            if (Number.isFinite(context) && context > 0) model.contextWindow = Math.trunc(context)
            if (Number.isFinite(maxTokens) && maxTokens > 0) model.maxOutput = Math.trunc(maxTokens)
          } catch {
            // 单个模型解析失败只影响它自己那一行。
          }
        })
      }
      rows.push(...buildChannelCatalog([{ provider, models: roster }]))
    } catch (error) {
      onError?.(provider, error)
    }
  }
  return { rows, providers }
}

/**
 * 一次名册扫描的**时间预算**（毫秒）。
 *
 * 冷启动实测：不设预算时全部渠道扫完可达分钟级，直接把宿主启动拖死。
 * 6 秒是「足够扫完常见小目录、又不至于让启动明显变慢」的折中；
 * 剩余渠道由后续轮询补齐（渠道目录本身也不是秒级变化的东西）。
 */
const ROSTER_BUDGET_MS = 6_000

/**
 * `resolveModelInfo` 的并发上限。
 *
 * ⚠️ 原来是一个 `Promise.all` 把**全部模型**一次性打出去：几十上千个并发请求
 * 同时压向 `ensureRemoteModels()`，每个都可能读盘 —— 不是「更快」，而是把
 * 主线程与 IO 同时打满。4 路并发足够掩盖单次 RTT，又能让超时预算真正生效。
 */
const ROSTER_RESOLVE_CONCURRENCY = 4

/**
 * 有并发上限的 map（保持输出顺序，内联不引依赖）。
 *
 * @param {readonly unknown[]} items
 * @param {number} limit
 * @param {(item: unknown) => Promise<void>} run
 */
async function mapWithConcurrency(items, limit, run) {
  const size = Math.max(1, Math.trunc(Number(limit)) || 1)
  let cursor = 0
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      await run(items[index])
    }
  })
  await Promise.all(workers)
}
