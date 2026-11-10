import fs from 'node:fs'
import path from 'node:path'
import { FreeModelAdapter, ROUTE_MAIN, ROUTE_REGION } from '../adapter.js'
import { buildCatalog, buildKiloCatalog, isKiloEntry, parseListing, reviveKiloCatalog } from '../catalog.js'
import { buildComboCatalog, isComboEntry, normalizeCombos, pruneRotation, comboLastServed } from '../combos.js'
import { isChannelEntry, readChannelRosters, reviveChannelCatalog, mergeChannelCatalogRows } from '../channel-catalog.js'
import { JsonStore, SETTINGS_INITIAL, STATS_INITIAL, STATS_VERSION, migrateStats, pruneDays, recordTurn, recordUsage, isModelHidden } from '../store.js'
import { STATE, detectEgress, probeCatalog } from '../probe.js'
import { CODE, UpstreamError, getJson } from '../http.js'
import { runModelTest, modelAvailability } from '../model-test.js'
import { DEFAULT_LEVEL } from '../effort.js'
import { fetchKiloListing } from '../kilo.js'
import { sessionForConversation } from '../upstream.js'
import { createForwardCompletion, publicModelRows } from './completion.js'

const FALLBACK_CATALOG = buildCatalog([
  'mimo-v2.6-flash-free', 'mimo-v2.5-free', 'ling-3.0-flash-fin-free',
  'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free', 'space-bunny-free',
  'muse-spark-1.3-contributor-free', 'muse-spark-1.2-contributor-free',
])

/** 路径由产品入口决定；核心不解析 DSH_HOME，也不发现宿主服务。 */
export function createRuntimeStores({ dataDir, logger = console }) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) {
    throw new TypeError('dataDir must be an absolute path')
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const open = (file, initial) => new JsonStore(path.join(dataDir, file), structuredClone(initial), {
    log: message => logger.warn?.(message),
  })
  // Seed the recommended combo only for a genuinely fresh install. Existing
  // settings files that predate combos must not gain a new advertised model
  // merely because a new default was added to SETTINGS_INITIAL; user edits to
  // an existing `combos` field still win through JsonStore's normal merge.
  const settingsInitial = structuredClone(SETTINGS_INITIAL)
  const settingsPath = path.join(dataDir, 'settings.json')
  if (fs.existsSync(settingsPath)) settingsInitial.combos = []
  const settings = new JsonStore(settingsPath, settingsInitial, {
    log: message => logger.warn?.(message),
  })
  const stats = open('stats.json', STATS_INITIAL)
  const availability = open('availability.json', { version: 1, at: 0, egress: null, results: {} })
  const catalogStore = open('catalog.json', {
    version: 1, at: 0, entries: FALLBACK_CATALOG.map(entry => entry.id),
    /** 渠道目录行的持久化快照(含真实 contextWindow),冷启动据此上屏。 */
    channelRows: [],
  })
  if (stats.get().version !== STATS_VERSION) stats.edit(migrateStats)
  return {
    settings, stats, availability, catalogStore,
    dispose() {
      settings.dispose(); stats.dispose(); availability.dispose(); catalogStore.dispose()
    },
  }
}

/**
 * 两个产品共同使用的模型运行时。宿主仅注入能力，不传入 Cordis ctx。
 * 创建不启动网络任务；入口先绑定本地监听器，再决定何时刷新和探测。
 */
export function createModelRuntime({
  settings, stats, availability, catalogStore,
  logger = console,
  attributionUserAgent = 'our-free-model',
  resolveImage,
  onTopology = () => {},
  /**
   * 宿主的 llm 服务（可选）。给了才能把渠道包的模型列进目录并在链上转发：
   * 目录来自它的 `listProviders`/`listModels`，转发走它的 `prepareCall`。
   * 不给时本运行时只服务免费车道，行为与接入前一致。
   */
  llm,
  /** 渠道包注册的 provider id 集合；只有它们算「本插件的渠道」。 */
  packProviders = new Set(),
  onChannelError,
}) {
  let catalog = materializeCatalog(catalogStore.get().entries ?? [])
  let kiloCatalog = reviveKiloCatalog(catalogStore.get().kiloRows)
  /** The virtual rows a combo contributes; rebuilt last, after every real lane. */
  let comboCatalog = []
  /** The free lane's own roster: the base every other lane is merged onto. */
  let freeCatalog = catalog
  /**
   * 渠道包各 provider 的目录行；由 {@link refreshChannelCatalog} 重建。
   *
   * 冷启动先从 `catalog.json` 的 `channelRows` 回灌上一次成功扫描的真值:
   * 6s 预算内的完整扫描常常在冷机时被掐断,若这里从空数组起,路由页就会把
   * 所有渠道模型显示成兜底容量(用户 2026-11-09 报障「重启后回到 131K」)。
   * 回灌的行随后被完整扫描逐 provider 覆盖,不会挡住新目录。
   */
  let channelCatalog = reviveChannelCatalog(catalogStore.get().channelRows)
  /** 本轮取到目录的渠道 provider id（用于空状态说清原因）。 */
  let channelProviders = []
  let egress = availability.get().egress ?? null
  let gatewayLatency = { ms: 0, at: 0 }
  let disposed = false
  const lifetime = new AbortController()
  let reprobeTimer

  /**
   * Rebuild the merged catalog from its parts, in precedence order.
   *
   * Rebuilt rather than appended to, because every one of these lists can shrink:
   * a provider the user switched off, a chain whose head was removed, a Kilo
   * model that went paid. Appending only ever grew the view, so a removed row
   * stayed dialable until the next full listing round happened to reset it.
   *
   * Combos come last on purpose — a chain's links have to already exist as real
   * rows, which is also what makes `buildComboCatalog` drop a link that is gone
   * instead of keeping a hopeful placeholder.
   */
  const rebuildCatalog = () => {
    const seen = new Set()
    const merged = []
    for (const entry of [...freeCatalog, ...kiloCatalog, ...channelCatalog]) {
      if (entry === null || entry === undefined || seen.has(entry.id)) continue
      seen.add(entry.id)
      merged.push(entry)
    }
    const combos = normalizeCombos(settings.get().combos)
    /**
     * ★ 链路成员从目录消失时在这里告警（2026-11-11 审查，从 runCombo 移来）。
     *
     * `settings.combos` 存的是**用户写的原样名单**（save 时有意不删失效成员，
     * 见 index.js 的注释），而 `buildComboCatalog` 会把当时目录里查不到的成员
     * 静默过滤 —— 于是「目录缩水」后这条链的成员悄悄变少：渠道扫描失败、
     * 模型被下架、channelRow 快照没落盘，都表现为「配置里写了却从不轮到」。
     * 这里对照的是**原始名单 vs 聚合产物**，是唯一能看到差值的位置；runCombo
     * 拿到的 `entry.combo` 已是过滤后的，在那里比较永远相等（死代码）。
     *
     * 告警而不是拒绝：目录是流动的（渠道上下线、探测刷新），把缺成员当硬错误
     * 会让整条链在窗口期不可用；记录一行让「被丢掉」与「轮到了但失败」从此
     * 可区分即可。只在**变化**时告警（按链路 id 记忆上次缺失集合），目录每次
     * 刷新都会走这里，逐次重复会刷屏。
     */
    const missingReport = new Map()
    for (const combo of combos) {
      if (combo.enabled === false) continue
      const missing = combo.models.filter(id => !merged.some(entry => entry.id === id))
      if (missing.length > 0) missingReport.set(combo.id, missing)
    }
    for (const [comboId, missing] of missingReport) {
      const previous = reportedMissingCombos.get(comboId)
      const same = previous !== undefined
        && previous.length === missing.length
        && previous.every((id, i) => id === missing[i])
      if (!same) {
        const combo = combos.find(row => row.id === comboId)
        logger.warn?.(`our-free-model: chain "${combo?.name ?? comboId}" is missing `
          + `${missing.length}/${combo.models.length} member(s) from the catalog `
          + `and they will not be rotated until they reappear: ${missing.join(', ')}`)
      }
      reportedMissingCombos.set(comboId, missing)
    }
    for (const comboId of [...reportedMissingCombos.keys()]) {
      if (!missingReport.has(comboId)) reportedMissingCombos.delete(comboId)
    }
    comboCatalog = buildComboCatalog(combos, merged)
    pruneRotation(combos)
    for (const entry of comboCatalog) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      merged.push(entry)
    }
    catalog = merged
  }
  /** 每条链路上一次报告的缺失成员（`rebuildCatalog` 的去重记忆）。 */
  const reportedMissingCombos = new Map()
  rebuildCatalog()
  const state = () => ({
    catalog,
    membership: computeMembership(catalog, availability.get(), settings.get()),
    settings: settings.get(),
    attributionUserAgent,
  })
  const emitTopology = () => { if (!disposed) onTopology() }
  /**
   * 把一次渠道模型的调用交回宿主。
   *
   * 宿主已为每个 provider 注册了适配器，`prepareCall` 返回的 `stream` 已经绑定
   * 了那一代的适配器实例；本插件只负责把 provider/model 换成渠道自己的名字。
   * 缺 `prepareCall`（旧内核）时返回 undefined，由适配器给出明确错误而不是
   * 静默失败。
   */
  /**
   * 渠道成员的 `prepareCall` 桥。
   *
   * ## ⚠️ 必须把调用方的 controls 一并传下去（真实缺陷，2026-11-10）
   *
   * 早先的签名只传 `{ provider, model }`，把调用方的 `maxTokens` /
   * `temperature` / `stop` **整个丢掉**。后果是一条链式反应：
   *
   * 1. 内核 `resolveCallWithInfo` 拿到的 `config` 里没有这些 controls，于是
   *    它只能按适配器的 `defaultMaxTokens` 兜底（适配器没声明该字段时就彻底没有）；
   * 2. `handle.config`（即锁定的权威配置）因此可能**缺少**调用方真正想要的值；
   * 3. 适配器派发时又要与这份 config 逐字段相等，只能把调用方的值删掉 ⇒
   *    **用户的 maxTokens / temperature / stop 在路由内的渠道成员上从没生效过**；
   *    删不干净时就抛 `INVALID_PREPARED_CALL`（qodercn 每回合被撞的直接原因）。
   *
   * 正确做法就是这里把 controls 原样交给内核，让它 resolve 出**包含调用方意图**
   * 的权威配置 —— 之后派发阶段自然逐字段相等，既不用删也不用猜。
   *
   * `reasoningEffort` **有意不传**：本插件的档位 id（`off`/`low`/`high`…）与
   * 渠道私有的档位域（`light`/`xhigh`/`max`）不同域，透传会撞 400。档位由渠道
   * 按自己的默认值决定（见 `runChannel` 的说明）。
   */
  const prepareChannelCall = typeof llm?.prepareCall === 'function'
    ? async (provider, model, signal, controls) => {
      if (disposed) throw new UpstreamError('the model runtime is disposed', CODE.aborted)
      /**
       * 只透传内核 `callConfigEquals` 会参与比较、且渠道能理解的三项。
       * `undefined` 的键**不进对象**（否则会覆盖内核自己的默认值语义）。
       */
      const forwardedControls = {}
      if (controls?.maxTokens !== undefined) forwardedControls.maxTokens = controls.maxTokens
      if (controls?.temperature !== undefined) forwardedControls.temperature = controls.temperature
      if (controls?.stop !== undefined) forwardedControls.stop = controls.stop
      const handle = await llm.prepareCall({ provider, model, ...forwardedControls }, signal)
      // `config` 是内核为这次派发锁定的权威配置；适配器必须照它派发，
      // 否则会被 `INVALID_PREPARED_CALL` 拒绝。
      return { config: handle?.config, stream: options => handle.stream(options) }
    }
    : undefined

  const adapter = new FreeModelAdapter({
    state,
    resolveImage,
    prepareChannelCall,
    recordUsage: record => {
      if (disposed) return
      recordUsage(stats, record)
      stats.edit(value => pruneDays(value, 120))
    },
    recordTurn: record => {
      if (!disposed) recordTurn(stats, record)
      /*
       * ★ 2026-11-04 排查「qodercn 路由内一直失败、直测却通」：把失败的原始
       * 报错落日志 —— recordTurn 只累计数，看不到失败原因；adapter 里能拿到
       * `failure.message` 的地方（runSingle/runChannel 的 fail 分支）已经记了
       * `model`，这里按它过滤打印。
       */
      if (record?.ok === false && typeof record?.message === 'string' && record.message !== '') {
        logger.warn?.(`our-free-model turn failed: ${record.model} — ${record.message.slice(0, 300)}`)
      }
    },
    warn: message => logger.warn?.(message) ?? logger.log?.(message),
    /**
     * ★ `log` 是**独立依赖**，不能省（真实缺陷，2026-11-10）。
     *
     * `runCombo` 每次作答都调 `this.deps.log?.(...)` 写「本轮由谁作答 + 名额
     * 进度」，而本对象此前**只注入了 `warn`** ⇒ 可选链静默吞掉，一行都不输出。
     * 用户因此完全无法确认轮询有没有在转（原话：「为什么路由功能没有在轮询」），
     * 而实测它一直在轮（渠道账本里 trae/raccoon/officeace 的分布就是证据）。
     *
     * ⚠️ 语义上也要与 `warn` 分开：成功作答是正常诊断信息，写成 warn 会让
     *   真正的告警（失败顺延、限流换号）淹没在成功日志里。
     * ⚠️ 走 `logger.warn` 而不是 `logger.info`：DSH 宿主的 `info` 通道在当前
     *   桌面版不落盘（实测 `desktop.log` 里只有 WARN 及以上），用 info 等于
     *   换一个地方继续静默。
     */
    log: message => logger.warn?.(message),
    onRegionBlocked: () => {
      if (disposed || reprobeTimer !== undefined) return
      reprobeTimer = setTimeout(() => {
        reprobeTimer = undefined
        if (!disposed) void refreshAvailability(true).catch(error => {
          logger.warn?.(`our-free-model: region reprobe failed (${error?.message ?? error})`)
        })
      }, 4000)
      reprobeTimer.unref?.()
    },
  })

  // 手动强制刷新不能借用一个因限流而跳过探测的普通刷新。
  let catalogRefresh = null
  let catalogRefreshForced = false
  let catalogRefreshProbed = false
  async function refreshCatalog(opts) {
    const { probe = true, force = false } = opts ?? {}
    if (disposed) return catalog
    while (catalogRefresh !== null) {
      const shared = catalogRefresh
      const sharedForced = catalogRefreshForced
      const sharedProbed = catalogRefreshProbed
      const value = await shared
      if (disposed || ((!force || sharedForced) && (!probe || sharedProbed))) return value
    }
    const run = refreshCatalogOnce({ probe, force })
    catalogRefresh = run
    catalogRefreshForced = force
    catalogRefreshProbed = probe
    try { return await run } finally {
      if (catalogRefresh === run) {
        catalogRefresh = null; catalogRefreshForced = false; catalogRefreshProbed = false
      }
    }
  }

  async function refreshCatalogOnce({ probe, force }) {
    let ids = []
    try {
      ids = parseListing(await fetchListing())
    } catch (error) {
      if (!disposed) logger.warn?.(`our-free-model: model listing refresh failed (${error?.message ?? error}); keeping the cached catalog`)
    }
    if (disposed) return catalog
    if (ids.length > 0) {
      freeCatalog = buildCatalog(ids)
      catalogStore.update({ at: Date.now(), entries: freeCatalog.map(entry => entry.id) })
      catalogStore.flush()
      settings.update({ catalogSyncedAt: Date.now() })
    } else {
      freeCatalog = materializeCatalog(catalogStore.get().entries ?? [])
    }
    await refreshKiloRoster()
    await refreshChannelCatalog()
    if (disposed) return catalog
    rebuildCatalog()
    if (probe) await refreshAvailability(force)
    emitTopology()
    return catalog
  }

  async function refreshKiloRoster() {
    try {
      const payload = await fetchKiloListing({ signal: lifetime.signal })
      if (disposed) return
      if (payload?.error || !Array.isArray(payload?.data)) throw new Error('invalid Kilo model listing')
      kiloCatalog = buildKiloCatalog(payload.data)
      catalogStore.update({ kiloRows: kiloCatalog })
    } catch (error) {
      if (!disposed) logger.warn?.(`our-free-model: Kilo channel listing failed (${error?.code ?? error?.message ?? 'unknown'}); keeping its cached roster`)
    }
  }

  /**
   * 重建渠道模型的目录行。
   *
   * 与免费车道不同，这里**不探测**：渠道模型的可用性由各自渠道自己维护
   * （账号池、黑名单、远端目录），拿本机探测去判它们只会花掉账号额度换来
   * 一个错误结论。清单本身来自宿主 `listModels`，那就是权威。
   *
   * 单家失败降级为「这家本轮没有目录」——一个渠道的凭据过期不该让整张
   * 候选清单变空，否则用户连别的渠道也选不了。
   */
  /**
   * 重读渠道名册。
   *
   * @param {{ light?: boolean }} [options] `light: true` 时**只问各渠道当前启用了
   *   哪些模型**，跳过逐模型 `resolveModelInfo`（见 `readChannelRosters` 的说明）。
   *   路由编辑器的「添加成员」走的就是这条轻量路径：它只要启用清单，
   *   不需要为了容量元数据去逐个解析（那是启动/定时轮询才需要的完整扫描）。
   */
  async function refreshChannelCatalog(options = {}) {
    if (disposed) return channelCatalog
    const light = options.light === true
    const cachedRows = reviveChannelCatalog(catalogStore.get().channelRows)
    const { rows, providers } = await readChannelRosters(llm, packProviders, (provider, error) => {
      onChannelError?.(provider, error)
      if (provider !== 'listProviders') {
        logger.warn?.(`our-free-model: channel ${provider} model list unavailable (${String(error?.message ?? error)}); skipping this round`)
      }
    }, light ? { light: true, previousRows: channelCatalog, cachedRows } : {})
    if (disposed) return channelCatalog
    if (light) {
      // light 只刷新启用清单,容量全靠回灌;它会把「本轮没扫到的 provider」的
      // 行丢掉(那些 provider 此刻可能只是没登录),所以**不写盘** —— 否则一次
      // 打开路由页就会把磁盘缓存削掉一大半。内存目录仍按本轮结果更新,让
      // 启用开关立刻反映;下一次完整扫描会把磁盘真值重新并回来。
      channelCatalog = rows
    } else {
      // 完整扫描:按 provider 合并磁盘真值,避免 6s 预算掐断 / 包未挂载时的
      // 残缺结果把上一次攒下的真值洗掉(见 mergeChannelCatalogRows)。
      channelCatalog = mergeChannelCatalogRows(rows, cachedRows, providers)
      catalogStore.update({ channelRows: channelCatalog })
      catalogStore.flush()
    }
    channelProviders = providers
    rebuildCatalog()
    emitTopology()
    return channelCatalog
  }

  async function fetchListing() {
    if (disposed) return { data: [] }
    const started = Date.now()
    const listing = await getJson('/inference/v1/models', {
      session: sessionForConversation('catalog:our-free-model'),
      attributionUserAgent,
      signal: lifetime.signal,
    })
    if (!disposed) gatewayLatency = { ms: Date.now() - started, at: Date.now() }
    return listing
  }

  let probeRound = null
  let probeThrottleStreak = 0
  let probeBackoffUntil = 0
  async function runProbeRound() {
    // The absorbed channels get no per-model probes: their verdicts would be
    // spent against a different gateway than the one that serves them, and a
    // roster the listing named is advertised as-is (its health is the listing
    // round's, refreshed on the same cadence). A combo is excluded because it
    // has no endpoint of its own: probing one would send the chain's own id to
    // the free lane as a model name, spending quota to collect a verdict about
    // nothing.
    const probeable = catalog.filter(entry => !isKiloEntry(entry) && !isComboEntry(entry) && !isChannelEntry(entry))
    const results = await probeCatalog(probeable, { attributionUserAgent, signal: lifetime.signal }, (id, result) => {
      if (disposed) return
      availability.edit(value => ({
        ...value,
        results: {
          ...value.results,
          [id]: {
            state: result.state,
            ...result.detail === undefined ? {} : { detail: result.detail },
            ...result.ttftMs === undefined ? {} : { ttftMs: result.ttftMs },
            latencyMs: result.latencyMs, startedAt: result.startedAt, at: Date.now(),
          },
        },
      }))
    }, 2)
    if (disposed) return {}
    availability.update({ at: Date.now(), egress })
    availability.flush()
    const verdicts = Object.values(results)
    if (verdicts.length > 0 && verdicts.every(row => row.state === STATE.unavailable)) {
      logger.warn?.(`our-free-model: the gateway refused all ${verdicts.length} models this round (${verdicts[0].detail ?? 'no detail'}); keeping them advertised`)
    }
    const allThrottled = verdicts.length > 0 && verdicts.every(row => row.state === STATE.throttled)
    probeThrottleStreak = allThrottled ? probeThrottleStreak + 1 : 0
    probeBackoffUntil = allThrottled
      ? Date.now() + Math.min(30 * 2 ** (probeThrottleStreak - 1), 120) * 60_000
      : 0
    if (allThrottled) {
      logger.warn?.(`our-free-model: the probe round hit the lane's quota; availability probes pause for ${Math.round((probeBackoffUntil - Date.now()) / 60_000)} minutes (your own requests are unaffected, and the reprobe button forces a round)`)
    }
    emitTopology()
    return results
  }
  async function refreshAvailability(force = false) {
    if (disposed || (!force && probeBackoffUntil > Date.now())) return {}
    if (probeRound !== null) return probeRound
    const round = runProbeRound()
    probeRound = round
    try { return await round } finally { if (probeRound === round) probeRound = null }
  }

  async function watchEgress() {
    if (disposed) return false
    const seen = await detectEgress({ signal: lifetime.signal })
    if (disposed || seen === undefined) return false
    const previous = availability.get().egress
    const changed = previous === null || previous === undefined
      || previous.ip !== seen.ip || (seen.country !== undefined && previous.country !== seen.country)
    egress = seen
    if (changed) {
      availability.update({ egress: seen })
      availability.flush()
      logger.info?.(`our-free-model: egress changed to ${seen.ip}${seen.country ? ` (${seen.country})` : ''}; re-probing availability`)
      await refreshAvailability(true)
    }
    return true
  }

  const latestTests = new Map()
  async function testModel(id, effort = DEFAULT_LEVEL, { signal } = {}) {
    if (disposed) throw new UpstreamError('Model runtime stopped', CODE.aborted)
    if (settings.get().enabled === false) throw new UpstreamError('Inference is paused', CODE.client)
    const entry = catalog.find(candidate => candidate.id === id)
    if (!entry) throw new UpstreamError('Unknown model "' + id + '"', CODE.client, { status: 404 })
    const token = {}
    latestTests.set(id, token)
    const selectedEffort = effort === undefined || effort === '' ? DEFAULT_LEVEL : effort
    const linkedSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal
    const persist = row => {
      if (disposed || linkedSignal.aborted || latestTests.get(id) !== token) return false
      availability.edit(value => ({ ...value, manualResults: { ...value.manualResults, [id]: row } }))
      availability.flush()
      emitTopology()
      return !availability.writeFailed
    }
    try {
      /**
       * 探测消息用**块数组**，不用裸字符串。
       *
       * 免费车道这条链路由本插件自己解析消息，字符串够用；但渠道模型的调用
       * 要交回宿主（`prepareCall` → 渠道适配器 → 内核的图像策略），而内核对
       * content 一律按块数组处理（`contentHasImage` 直接 `.some()`）。裸字符串
       * 会在那里抛 `content.some is not a function`，看起来像渠道坏了，实际是
       * 探测请求的形状不对。块数组是两种链路都接受的写法。
       */
      const probeMessages = [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: OK' }] }]
      const measured = await runModelTest(testSignal => adapter.stream({
        provider: ROUTE_MAIN, model: entry.id,
        messages: probeMessages,
        reasoningEffort: selectedEffort, sessionId: 'bench:' + entry.id + ':' + selectedEffort,
        signal: testSignal,
      }, entry, state()), { signal: linkedSignal })
      if (linkedSignal.aborted || disposed) throw new UpstreamError('Text test cancelled', CODE.aborted)
      const persisted = persist({ state: STATE.available, source: 'manual', at: Date.now(), ttftMs: measured.ttftMs, latencyMs: measured.totalMs })
      /**
       * 链路（combo）要如实告诉调用方**这一轮实际由谁作答**。
       *
       * 否则 `model` 字段永远是 `combo:xxx`，用户看不出轮询有没有在工作
       * （2026-11-04 反馈「设了 10 次就换，一直没实现」—— 其实在轮，
       * 只是看不出来）。非链路模型没有这个字段，行为不变。
       */
      const served = isComboEntry(entry) ? comboLastServed(entry.id) : ''
      return {
        model: entry.id,
        ...served === '' ? {} : { member: served },
        effort: selectedEffort, ok: true, ...measured, persisted,
      }
    } catch (error) {
      // Cancellation is a user action, not a fresh availability verdict. Other failures
      // remain unknown instead of silently banning a paid/region-gated route.
      if (error?.code !== CODE.aborted) persist({ state: STATE.unknown, source: 'manual', at: Date.now(), detail: String(error?.message ?? error).slice(0, 200) })
      throw error
    } finally {
      if (latestTests.get(id) === token) latestTests.delete(id)
    }
  }

  return {
    testModel, state, adapter, refreshCatalog, refreshAvailability, watchEgress, fetchListing,
    refreshChannelCatalog,
    get channelProviders() { return channelProviders },
    complete: createForwardCompletion({
      adapter, signal: lifetime.signal,
      state: () => {
        const snapshot = state()
        // Hiding advertisements must not invalidate requests using a saved id.
        return { ...snapshot, membership: computeMembership(snapshot.catalog, availability.get(), {
          ...snapshot.settings, hiddenModelIds: [], hideFreeModels: false,
        }) }
      },
    }),
    publicModelRows: () => publicModelRows(state()),
    // A settings write that changes the chains (a combo edited) rebuilds the
    // merged view without a listing round.
    syncAggregateCatalog() {
      if (disposed) return catalog
      rebuildCatalog()
      emitTopology()
      return catalog
    },
    get catalog() { return catalog },
    get egress() { return egress },
    get gatewayLatency() { return gatewayLatency },
    setAttributionUserAgent(value) { attributionUserAgent = value },
    dispose() {
      if (disposed) return
      disposed = true
      lifetime.abort()
      clearTimeout(reprobeTimer)
    },
  }
}

function materializeCatalog(ids) {
  const rebuilt = buildCatalog(ids)
  return rebuilt.length > 0 ? rebuilt : FALLBACK_CATALOG
}

export function computeMembership(catalog, availabilitySnapshot, settings) {
  const expose = settings?.exposeRegionModels !== false
  const verdictOf = entry => modelAvailability(entry.id, availabilitySnapshot, Boolean(entry.channel)).availability
  const probeable = catalog.filter(entry => !entry.channel)
  const refusedAll = probeable.length > 0 && probeable.every(entry => verdictOf(entry) === STATE.unavailable)
  let usable = catalog.filter(entry => verdictOf(entry) !== STATE.unavailable)
  if (refusedAll) usable = catalog
  const main = []
  const region = []
  for (const entry of usable) {
    // 渠道模型（`channel:<provider>/<model>`）不在这里广播：它们的 provider
    // 就是自己（raccoon / buddy / ...），宿主的选择器里已经有那一组。再以本
    // 插件的 route 报一遍，同一批模型会多出一份，用户看到「Our Free Model」
    // 底下挂着 8 个别人家的模型，还以为链路把它们收了进来。
    // 这**不影响**调用：`prepareCall` 与转发网关都按 catalog 里的 id 解析，
    // 链路成员照样能被拨出去（隐藏广告不等于拒绝请求）。
    if (typeof entry.channel === 'string' && entry.channel.startsWith('channel:')) continue
    if (isModelHidden(entry, settings)) continue
    const verdict = verdictOf(entry)
    if (verdict !== STATE.regionBlocked) main.push(entry.id)
    else if (expose) region.push(entry.id)
  }
  const membership = {}
  if (main.length > 0) membership[ROUTE_MAIN] = main
  if (region.length > 0) membership[ROUTE_REGION] = region
  return membership
}
