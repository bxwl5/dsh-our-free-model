/**
 * Catalog rows for the absorbed channel providers.
 *
 * The plugin registers one route (`our-free-model`) and serves two families of
 * models: its own free lane, and the channel providers the vendored pack
 * registers (`zcode`, `kuku`, `trae`, `qoder`, `cline`, `accio`, ...). The
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
        contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? Math.trunc(contextWindow) : 131072,
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
   * - 复用 `previousRows` 里同 id 行的容量元数据（上次完整扫描的结果）；
   * - 新出现的行用兜底值，下一次完整扫描会补齐。
   *
   * @type {{ light?: boolean, previousRows?: readonly object[] }}
   */
  const light = options.light === true
  const previous = new Map()
  for (const row of Array.isArray(options.previousRows) ? options.previousRows : []) {
    if (typeof row?.id === 'string') previous.set(row.id, row)
  }
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
  // 因此把每个渠道模型都标成 131072/32768 的兜底值，用户看到「所有渠道模型都是
  // 131K/33K」。适配器自己的 `resolveModelInfo` 才带真实容量（它读远端目录 +
  // 产品兜底表 + 静态表三级），所以这里逐模型补一次查询；失败不阻塞目录，
  // 那一行保持未知而不是编一个假数字。
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
     * 它每慢一秒，宿主就晚一秒开始监听 HTTP。实测「20 个渠道 × 每家几十个模型
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
        // 复用上次完整扫描拿到的容量（同 id 才算），新行留给兜底值。
        for (const model of roster) {
          const prior = previous.get(channelModelId(provider, String(model?.id ?? '')))
          if (prior === undefined) continue
          const context = Number(prior.contextWindow)
          const maxOutput = Number(prior.maxOutput)
          if (Number.isFinite(context) && context > 0) model.contextWindow = Math.trunc(context)
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
