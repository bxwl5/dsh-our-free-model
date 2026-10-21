/**
 * Our Free Model — plugin entry (Host half).
 *
 * Wiring: one adapter instance, two provider routes (usable now / region-limited
 * on this egress), a live-catalog + availability-probe loop behind them, the
 * browser-facing JSON API the settings page reads, and the OpenAI-compatible
 * forward listener.
 *
 * On top of the model lane the plugin owns a small distribution channel of its
 * own: a remote announcement feed the repository owner publishes by pushing a
 * JSON document, an in-app self-updater that verifies and installs new releases
 * from the same repository, and a self hot-reload that swaps the running plugin
 * for the code now on disk. All three report to the browser over one
 * Server-Sent-Events route, because the kernel has no notification service and
 * the settings page should not have to poll.
 *
 * Every harness facility is reached through `ctx`, and only the one the plugin
 * cannot exist without is declared in `inject`, so a composition that omits the
 * rest degrades a feature rather than failing the plugin: no web server means no
 * in-app dashboard, no attachments means image blocks fall back to the text
 * projection the runtime already performs. See `inject` below.
 *
 * @module index.js
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { externalUrl, openExternal } from './src/open-external.js'
import { ROUTE_LABELS, ROUTE_MAIN, ROUTE_REGION } from './src/adapter.js'
import { DATA_DIR_NAME, resolveDshHome, publicModelVisibility, validateModelVisibility, isModelHidden } from './src/store.js'
import { isKiloEntry } from './src/catalog.js'
import { STATE } from './src/probe.js'
import { generateKey, rankLanAddresses, startForwardServer, startLanRelay } from './src/forward.js'
import { chanGatewayCredential, chanGatewayEnabled, chanGatewayPort, startChanRelay } from './src/chan-relay.js'
import { CODE, UpstreamError } from './src/http.js'
import { egressActive, egressFetch, outletLabel, readOutletSelection, startEgressRelay } from './src/egress.js'
import { DEFAULT_LEVEL, budgetLadder, hasDeclaredEffortMenu } from './src/effort.js'
import { modelAvailability } from './src/model-test.js'
import { createPushHub } from './src/push.js'
import { rejectionFor, isLoopbackHost, connectionAdmissionView } from './src/trust.js'
import { resolveAttributionUserAgent } from './adapter/kernel.js'
import { buildComboCatalog, isComboEntry, normalizeCombos, pruneRotation } from './src/combos.js'
import { addSavings, describeSavingsTotal, emptySavings, saverConfig, savingsPercent } from './src/token-saver/index.js'
import { CAVEMAN_LEVELS, PONYTAIL_LEVELS } from './src/token-saver/prompts.js'
import { OPTIMIZATIONS } from './src/local-optimize.js'
import { createModelRuntime, createRuntimeStores } from './src/core/runtime.js'

export { fromOpenAiMessages } from './src/core/completion.js'
import { buildStats } from './src/core/stats.js'
export { buildStats }

export const name = 'our-free-model'

/** The installed package directory — the self-updater and hot reload operate here. */
const PKG_URL = new URL('./', import.meta.url)
const PKG_DIR = fileURLToPath(PKG_URL)
const ENTRY_URL = new URL('index.js', import.meta.url).href

/** Published version of the installed package, read once at load. */
function readPackageVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version ?? '')
  } catch {
    return ''
  }
}

// Bind the version to this module generation. Re-registering cached old exports
// after a failed reload must not pick up the new package.json still on disk.
export const version = readPackageVersion()

/**
 * `llm` is what the plugin exists for, so it is the only hard requirement of the
 * plugin itself.
 *
 * Cordis withholds from a context any service its fiber does not name in
 * `inject`, and keeps that fiber PENDING while a named one is absent — which is
 * how v1.2.1 stayed permanently inactive on a composition with no HTTP server,
 * the surface issue #4 reported. So nothing else may be named here: a headless
 * composition would rather serve models without a settings page than serve
 * nothing.
 *
 * What that costs and what still works:
 * - `webServer` — the in-app dashboard and the SSE push channel. Reached through
 *   a nested `ctx.inject` fiber (see the browser-facing API section), which pends
 *   on its own and never blocks the lane above.
 * - `timer` (`ctx.interval`) — nothing. The background loops are plain unref'd
 *   timers (see `every`), because reading a mixin off an undeclared service
 *   throws rather than answering `undefined`.
 * - `connection`, `attachments` — one feature each: the fence falls back to its
 *   structural replica, image blocks to the text projection. Both are read with
 *   `ctx.get()`, which is the opportunistic lookup that answers `undefined`.
 */
export const inject = ['llm']

/**
 * Who owns the plugin's bytes — the distribution mode:
 *
 * - `self` (default): the plugin updates itself from its repository, publishes
 *   its announcement feed, and hot-reloads, exactly as before.
 * - `managed`: the plugin arrived through a distribution pack (a
 *   integration pack, a Mojobox install). The pack manager owns the bytes now,
 *   so the in-app updater, the announcement channel and the hot reload stand
 *   down — two writers to one installed directory is a corrupted install. The
 *   model lane is untouched; this is about who ships the code, not what it does.
 *
 * `config.distribution` (what a pack's bundle patch passes) outranks the
 * settings file, and the settings API never accepts the field back, so an
 * install that shipped managed stays managed.
 */
const MANAGED_MESSAGE = 'this installation is managed; updates are handled by the pack that installed it'

/** Effective distribution mode: config override first, then the settings file. */
function distributionOf(config, settings) {
  if (config?.distribution === 'managed' || settings.get().distribution === 'managed') return 'managed'
  return 'self'
}

export function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const home = resolveDshHome()
  const dataDir = path.resolve(home, DATA_DIR_NAME)
  fs.mkdirSync(dataDir, { recursive: true })
  const packageVersion = version

  // A hot reload re-enters apply with fresh stores; the generation counter lives
  // on globalThis so the new instance knows it replaced a predecessor, and does
  // the post-swap bookkeeping itself (the old closure must not touch stores
  // after its own dispose — that would race the new instance's writes).
  const generation = (globalThis[Symbol.for('our-free-model.generation')] ?? 0) + 1
  globalThis[Symbol.for('our-free-model.generation')] = generation

  const stores = createRuntimeStores({ dataDir, logger })
  const { settings, stats, availability } = stores

  if (generation > 1) {
    settings.update({ reloadedAt: Date.now(), reloadCount: generation - 1 })
    settings.flush()
  }

  /** `managed` stands down everything that would rewrite the installed bytes. */
  const distribution = distributionOf(config, settings)
  const managed = distribution === 'managed'

  let forward = null
  let forwardError = ''
  // Non-fatal: the listener is up, but not where the settings asked for it.
  let forwardNotice = ''
  /** The optional LAN relay: a second door, with a key of its own. */
  let relay = null
  let relayError = ''
  /** The optional egress outlet (subscription or single client), off by
   *  default. Named `outlet*` so the `egress` IP/country snapshot stays clear. */
  let outletRelay = null
  let outletError = ''
  /** Last reading of the outlet's own view of itself, cached for `/summary`. */
  let outletNode = { node: '', delayMs: 0, at: 0 }

  // ── push channel ────────────────────────────────────────────────────────────
  const push = createPushHub({ logger })

  /** Set when this generation is disposed; late async callbacks must stand down. */
  let disposed = false

  const modelRuntime = createModelRuntime({
    ...stores,
    logger,
    attributionUserAgent: 'deepseek-harness',
    resolveImage: imageResolver(ctx, logger),
    onTopology: () => emitTopology(),
  })
  const { state, adapter, refreshCatalog, refreshAvailability, watchEgress, fetchListing, publicModelRows, syncAggregateCatalog } = modelRuntime
  const runForwarded = modelRuntime.complete

  // ── registration ────────────────────────────────────────────────────────────
  const routes = () => Object.keys(state().membership)
  const registration = ctx.llm.registerAdapter([ROUTE_MAIN, ROUTE_REGION], adapter)
  ctx.llm.registerConfigurableProviders?.([
    { provider: ROUTE_MAIN, displayName: ROUTE_LABELS[ROUTE_MAIN], settingsNs: ctx.fiber?.entry?.options?.id ?? name, settingsPath: [] },
  ])

  // Advertise a probe endpoint for the in-app "detect models" button. It offers
  // what the picker itself advertises — a model the gateway refuses to route at
  // all must not be addable to a profile just because it still appears in the
  // upstream listing.
  ctx.llm.registerModelDiscovery?.(ctx.fiber?.entry?.options?.id ?? name, async () => {
    await refreshCatalog({ probe: true, force: true })
    const advertised = new Set(Object.values(state().membership).flat())
    return modelRuntime.catalog
      .filter(entry => advertised.has(entry.id))
      .map(entry => ({
        id: entry.id,
        name: entry.name,
        contextWindow: entry.contextWindow,
        maxTokens: entry.maxOutput,
        inputModalities: entry.vision ? ['text', 'image'] : ['text'],
      }))
  })

  ctx.on?.('loader/volatile-update', () => {
    registration.replace(routes())
  })

  /**
   * A freshly started outlet needs a moment before its nodes carry traffic: the
   * first read comes back empty, and a re-probe fired on that cold path would
   * record "unavailable" for models the new exit would have unlocked. Retry a
   * few times and let the re-probe run only once the exit answers.
   */
  async function settleOutletWatch() {
    let lastError
    for (let attempt = 0; attempt < 4; attempt++) {
      await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 2500 : 5000))
      if (disposed) return
      try {
        if (await watchEgress()) {
          // The exit answers, but url-test may not have ranked a node yet: read
          // the selection now, and once more a beat later so the settings page
          // does not sit on an empty node until the next periodic tick.
          await readOutletStatus().catch(() => {})
          const later = setTimeout(() => {
            if (!disposed) void readOutletStatus().catch(() => {})
          }, 5000)
          later.unref?.()
          return
        }
      } catch (error) {
        lastError = error
      }
    }
    logger.warn?.(
      `our-free-model: egress changed but the new exit never answered; leaving verdicts alone`
      + (lastError ? ` (${lastError?.message ?? lastError})` : ''),
    )
  }

  // ── forward listener ────────────────────────────────────────────────────────
  // Both reconciles get a serialisation gate: two callers (the boot refresh and
  // every settings POST) used to overlap, and whichever bind finished last wrote
  // its entry-time snapshot of the settings back over the other one - rolling
  // the user's just-saved `enabled` edits back, or leaving an orphan listener
  // behind. The waiter re-runs after the first settles; the early-exit below
  // makes that rerun free when nothing changed.
  let forwardSyncInFlight = null
  async function syncForward() {
    while (forwardSyncInFlight !== null) await forwardSyncInFlight.catch(() => {})
    const run = syncForwardOnce()
    forwardSyncInFlight = run
    try { await run } finally { if (forwardSyncInFlight === run) forwardSyncInFlight = null }
  }
  async function syncForwardOnce() {
    const desired = settings.get().forward ?? {}
    const wanted = desired.enabled === true
    // A listener already bound where the settings want it is left alone. Two
    // callers reconcile the same state — the boot refresh and every settings
    // POST — and the second one used to close and re-bind the port anyway,
    // resetting whatever request was in flight on the old socket.
    if (forward !== null && wanted
      && forward.host === (desired.host || '127.0.0.1')
      && forward.requestedPort === (Number.isFinite(Number(desired.port)) ? Math.trunc(Number(desired.port)) : 0)) return
    if (forward === null && !wanted) return
    if (forward !== null) {
      const closing = forward
      forward = null
      await closing.close().catch(() => {})
    }
    if (!wanted) {
      forwardError = ''
      forwardNotice = ''
      return
    }
    // Checked again here, not only where the settings page posts: a headless
    // composition has no page to click, and `settings.json` is the way in. A
    // routable bind would spend this machine's free lane on the whole subnet.
    if (!isLoopbackHost(desired.host || '127.0.0.1')) {
      forwardError = 'the forward listener binds a loopback address only'
      logger.warn?.(`our-free-model: forward listener not started (${forwardError})`)
      return
    }
    try {
      forward = await startForwardServer({
        config: () => {
          const current = settings.get().forward ?? {}
          return { host: current.host || '127.0.0.1', port: current.port ?? 0, enabled: current.enabled === true, key: forwardKey() }
        },
        complete: (request, onChunk) => runForwarded(request, onChunk),
        modelRows: () => publicModelRows(),
        // Read per request, not captured: the settings page can flip a switch
        // while the listener is up, and a captured snapshot would keep answering
        // a disabled optimization until the next restart.
        optimize: () => optimizeConfig(settings.get().localOptimize),
        log: message => logger.warn?.(`our-free-model forward: ${message}`),
        onTrace: event => logger.info?.(`our-free-model request: ${JSON.stringify(event)}`),
      })
      forwardError = ''
      // Keep the requested configuration; the bound port belongs to runtime state.
      forwardNotice = forward.fellBack === true && forward.bindError !== null
        ? `port ${forward.requestedPort} is not available on this machine (${forward.bindError.code}); the listener is on port ${forward.port} instead`
        : ''
      if (forwardNotice !== '') logger.warn?.(`our-free-model forward: ${forwardNotice}`)
    } catch (error) {
      forwardError = String(error?.message ?? error)
      logger.warn?.(`our-free-model: forward listener could not start (${forwardError})`)
    }
  }

  function forwardKey() {
    const current = settings.get()
    if (typeof current.forwardKey === 'string' && current.forwardKey !== '') return current.forwardKey
    const minted = generateKey()
    settings.update({ forwardKey: minted })
    settings.flush()
    return minted
  }

  /**
   * The relay's own key. Never the local one: a key that has to travel to other
   * devices on a network is a key that will eventually leak, and a leak must
   * cost a rotation here rather than every tool already wired to the local port.
   */
  function relayKey() {
    const current = settings.get()
    if (typeof current.forwardLanKey === 'string' && current.forwardLanKey !== '') return current.forwardLanKey
    const minted = generateKey()
    settings.update({ forwardLanKey: minted })
    settings.flush()
    return minted
  }

  /**
   * IPv4 addresses another machine on this network could dial, best first.
   *
   * Read fresh on every ask — the panel polls it while the relay is on — because
   * the answer is a property of the machine's interfaces and they change under a
   * laptop that switched networks. The ordering lives in `rankLanAddresses`
   * (`src/forward.js`), next to the relay it describes.
   */
  function lanAddresses() {
    return rankLanAddresses(os.networkInterfaces())
  }

  /**
   * Reconcile the optional LAN relay.
   *
   * Deliberately not folded into `syncForward`: the two doors have separate
   * lives, and toggling the relay must not close and re-bind the local port
   * under a request that is already in flight on it.
   */
  let relaySyncInFlight = null
  async function syncRelay() {
    while (relaySyncInFlight !== null) await relaySyncInFlight.catch(() => {})
    const run = syncRelayOnce()
    relaySyncInFlight = run
    try { await run } finally { if (relaySyncInFlight === run) relaySyncInFlight = null }
  }
  async function syncRelayOnce() {
    const desired = settings.get().forward ?? {}
    const lan = desired.lan ?? {}
    const wanted = lan.enabled === true
    const host = String(lan.host ?? '').trim() || '0.0.0.0'
    const port = Number.isFinite(Number(lan.port)) && Number(lan.port) > 0 ? Math.trunc(Number(lan.port)) : 0
    if (relay !== null && wanted && forward !== null && relay.host === host && relay.port === port) return
    if (relay === null && !wanted) return
    if (relay !== null) {
      const closing = relay
      relay = null
      await closing.close().catch(() => {})
    }
    if (!wanted) {
      relayError = ''
      return
    }
    // Without the local listener there is nothing to relay to, and a relay on
    // the local port would dial itself. Both are settings mistakes worth naming
    // here rather than surfacing as a socket error later.
    if (desired.enabled !== true || forward === null) {
      relayError = 'the local forward listener is not running'
      return
    }
    if (port !== 0 && port === forward.port) {
      relayError = 'the LAN relay needs a port of its own'
      logger.warn?.(`our-free-model: LAN relay not started (${relayError})`)
      return
    }
    try {
      relay = await startLanRelay({
        config: () => {
          const current = settings.get().forward ?? {}
          const currentLan = current.lan ?? {}
          return {
            enabled: currentLan.enabled === true,
            host: String(currentLan.host ?? '').trim() || '0.0.0.0',
            port: currentLan.port ?? 0,
            lanKey: relayKey(),
            localKey: forwardKey(),
            targetPort: forward?.port ?? 0,
          }
        },
        log: message => logger.warn?.(`our-free-model lan relay: ${message}`),
        onTrace: event => logger.info?.(`our-free-model request: ${JSON.stringify(event)}`),
      })
      relayError = ''
      // The port that was actually bound goes back into the settings, so the
      // address the page shows is the address that answers. Out of the CURRENT
      // settings — not the entry-time snapshot: an overlapped save during the
      // bind would otherwise be rolled back to the values this run started with.
      const settledForward = settings.get().forward ?? {}
      settings.update({ forward: { ...settledForward, lan: { ...(settledForward.lan ?? {}), port: relay.port } } })
      settings.flush()
    } catch (error) {
      relayError = String(error?.message ?? error)
      logger.warn?.(`our-free-model: LAN relay could not start (${relayError})`)
    }
  }

  // ── the channels' gateway relay ─────────────────────────────────────────────
  /**
   * The absorbed pack serves every 白嫖 provider through one OpenAI-compatible
   * gateway on the loopback. The relay is this plugin's own door in front of
   * it: callers authenticate with `chanGateway.relay.key` and the forwarded
   * hop is re-stamped with the gateway's own credential, which never leaves
   * the host. Off until asked for; the settings page owns the switch.
   */
  let chanRelay = null
  let chanRelayError = ''
  let chanRelaySyncInFlight = null

  function chanRelayKey() {
    const relay = settings.get().chanGateway?.relay ?? {}
    if (typeof relay.key === 'string' && relay.key !== '') return relay.key
    const minted = generateKey()
    settings.update({ chanGateway: { ...(settings.get().chanGateway ?? {}), relay: { ...(settings.get().chanGateway?.relay ?? {}), key: minted } } })
    settings.flush()
    return minted
  }

  function rotateChanRelayKey() {
    const minted = generateKey()
    settings.update({ chanGateway: { ...(settings.get().chanGateway ?? {}), relay: { ...(settings.get().chanGateway?.relay ?? {}), key: minted } } })
    settings.flush()
    return minted
  }

  /** The gateway's address and credential, read fresh: both can move (env). */
  function chanGatewayTarget() {
    return {
      port: chanGatewayPort(process.env),
      enabledByEnv: chanGatewayEnabled(process.env),
      credential: chanGatewayCredential({ profileContext: optional('profileContext'), env: process.env }),
    }
  }

  async function syncChanRelay() {
    while (chanRelaySyncInFlight !== null) await chanRelaySyncInFlight.catch(() => {})
    const run = syncChanRelayOnce()
    chanRelaySyncInFlight = run
    try { await run } finally { if (chanRelaySyncInFlight === run) chanRelaySyncInFlight = null }
  }
  async function syncChanRelayOnce() {
    const relay = settings.get().chanGateway?.relay ?? {}
    const wanted = relay.enabled === true
    const host = String(relay.host ?? '').trim() || '127.0.0.1'
    const port = Number.isFinite(Number(relay.port)) && Number(relay.port) > 0 ? Math.trunc(Number(relay.port)) : 0
    const target = chanGatewayTarget()
    if (chanRelay !== null && wanted && chanRelay.host === host && chanRelay.port === port) return
    if (chanRelay === null && !wanted) return
    if (chanRelay !== null) {
      const closing = chanRelay
      chanRelay = null
      await closing.close().catch(() => {})
    }
    if (!wanted) { chanRelayError = ''; return }
    if (port !== 0 && target.port === port) {
      chanRelayError = 'the relay needs a port of its own (the gateway listens on ' + target.port + ')'
      logger.warn?.(`our-free-model: channel gateway relay not started (${chanRelayError})`)
      return
    }
    try {
      chanRelay = await startChanRelay({
        config: () => {
          const current = settings.get().chanGateway?.relay ?? {}
          const targetNow = chanGatewayTarget()
          return {
            enabled: current.enabled === true,
            host: String(current.host ?? '').trim() || '127.0.0.1',
            port: current.port ?? 0,
            lanKey: chanRelayKey(),
            gatewayHost: '127.0.0.1',
            gatewayPort: targetNow.port,
            gatewayKey: targetNow.credential?.key ?? '',
          }
        },
        log: message => logger.warn?.(`our-free-model channel relay: ${message}`),
      })
      chanRelayError = ''
      // The bound port goes back into the settings, so the page shows the
      // address that actually answers (the OS picks when 0 was asked for).
      const settled = settings.get().chanGateway ?? {}
      settings.update({ chanGateway: { ...settled, relay: { ...(settled.relay ?? {}), port: chanRelay.port } } })
      settings.flush()
    } catch (error) {
      chanRelayError = String(error?.message ?? error)
      logger.warn?.(`our-free-model: channel gateway relay could not start (${chanRelayError})`)
    }
  }

  function chanRelayStatus() {
    const relay = settings.get().chanGateway?.relay ?? {}
    const target = chanGatewayTarget()
    return {
      relay: {
        enabled: relay.enabled === true,
        running: chanRelay !== null,
        host: chanRelay?.host ?? (String(relay.host ?? '').trim() || '127.0.0.1'),
        port: chanRelay?.port ?? relay.port ?? 0,
        hasKey: typeof relay.key === 'string' && relay.key !== '',
        error: chanRelayError,
      },
      gateway: {
        port: target.port,
        enabledByEnv: target.enabledByEnv,
        keyFound: target.credential !== null,
        keyFromEnv: target.credential?.fromEnv === true,
        keyPath: target.credential?.path ?? '',
      },
    }
  }


  // ── egress outlet ───────────────────────────────────────────────────────────
  /** One gateway round trip at a time; the panel polls, the throttle decides. */
  let latencyMeasureInFlight = null
  /**
   * Which node the outlet is carrying traffic on, and what it costs to reach the
   * gateway through it. Purely informational: every failure is a missing reading,
   * never an error, because the outlet itself may be perfectly healthy while the
   * controller call that describes it is not.
   */
  /**
   * The settings page asks "how long does opencode take to answer right now", and
   * the honest answer is a real round trip through the outlet — not the age of the
   * last catalog refresh. Re-reading the listing is the cheapest call that proves
   * the whole path (it is the same request the catalog uses, and free), so it is
   * reused here, throttled so a panel left open cannot turn into a loop.
   */
  async function measureGatewayLatency() {
    if (modelRuntime.gatewayLatency.at !== 0 && Date.now() - modelRuntime.gatewayLatency.at < 60_000) return
    if (latencyMeasureInFlight !== null) return await latencyMeasureInFlight.catch(() => {})
    const run = fetchListing()
      .then(() => {})
      .catch(error => {
        logger.debug?.(`our-free-model: gateway latency reading failed (${error?.message ?? error})`)
      })
    latencyMeasureInFlight = run
    try { await run } finally { if (latencyMeasureInFlight === run) latencyMeasureInFlight = null }
  }

  async function readOutletStatus() {
    const relay = outletRelay
    if (relay === null) {
      outletNode = { node: '', delayMs: 0, at: 0 }
      return { node: '', nodeDelayMs: 0, nodeAt: 0, latencyMs: 0, latencyAt: 0 }
    }
    await measureGatewayLatency().catch(() => {})
    const selection = await readOutletSelection(relay).catch(() => null)
    // A settled read is cached for `/summary`, which cannot await a round trip.
    if (outletRelay === relay) {
      outletNode = { node: selection?.node ?? '', delayMs: selection?.delayMs ?? 0, at: Date.now() }
    }
    return {
      node: selection?.node ?? '',
      nodeDelayMs: selection?.delayMs ?? 0,
      nodeAt: Date.now(),
      latencyMs: modelRuntime.gatewayLatency.ms,
      latencyAt: modelRuntime.gatewayLatency.at,
    }
  }
  // Same serialisation gate as the two listeners above: the boot chain and every
  // settings POST call this, and overlapping runs would leak a spawned mihomo
  // (the loser overwrites `outletRelay` while the winner's child still runs).
  let outletSyncInFlight = null
  /** What the currently running outlet was started with — restart on change. */
  let outletFingerprint = ''
  async function syncEgress() {
    while (outletSyncInFlight !== null) await outletSyncInFlight.catch(() => {})
    const run = syncEgressOnce()
    outletSyncInFlight = run
    try { await run } finally { if (outletSyncInFlight === run) outletSyncInFlight = null }
  }
  async function syncEgressOnce() {
    const desired = settings.get().egress ?? {}
    const wanted = desired.enabled === true
    const mode = desired.mode === 'client' ? 'client' : 'subscription'
    const url = String(desired.url ?? '').trim()
    const mihomoPath = String(desired.mihomoPath ?? '').trim()
    const fingerprint = `${mode}\n${url}\n${mihomoPath}`
    if (outletRelay !== null && wanted && outletFingerprint === fingerprint && !outletRelay.dead) return
    if (outletRelay === null && !wanted) return
    if (outletRelay !== null) {
      const closing = outletRelay
      outletRelay = null
      outletFingerprint = ''
      await closing.close().catch(() => {})
      // The way out changed under every fetch: re-detect the exit so the pill and
      // the model verdicts describe the path the next request actually takes.
      void settleOutletWatch()
    }
    if (!wanted) {
      outletError = ''
      return
    }
    if (url === '') {
      outletError = 'the outlet needs a subscription or proxy URL'
      logger.warn?.(`our-free-model: egress outlet not started (${outletError})`)
      return
    }
    try {
      outletRelay = await startEgressRelay({
        config: () => {
          const current = settings.get().egress ?? {}
          return {
            mode: current.mode === 'client' ? 'client' : 'subscription',
            url: String(current.url ?? '').trim(),
            mihomoPath: String(current.mihomoPath ?? '').trim(),
          }
        },
        dataDir,
        log: message => logger.info?.(`our-free-model egress: ${message}`),
        onDead: scheduleOutletRestart,
      })
      outletFingerprint = fingerprint
      outletError = ''
      outletUpSince = Date.now()
      logger.info?.(`our-free-model: egress outlet up (${outletLabel(url)} via ${mode})`)
      // Same as the close path: the exit IP, its country and the region-gated
      // verdicts all moved with the outlet, so settle them now instead of at the
      // next periodic watch.
      void settleOutletWatch()
    } catch (error) {
      outletError = String(error?.message ?? error)
      logger.warn?.(`our-free-model: egress outlet could not start (${outletError})`)
    }
  }

  // A managed mihomo that dies mid-run used to leave the outlet bricked until
  // the user touched the settings page: the relay stays up but its dial port is
  // gone, so every upstream turn fails. syncEgressOnce already restarts a dead
  // relay with an unchanged fingerprint — this only calls it, with a backoff so
  // a mihomo that dies at boot cannot spin into a start/exit loop. A run that
  // lasted two minutes counts as healthy and resets the ladder.
  const OUTLET_STABLE_MS = 120_000
  let outletUpSince = 0
  let outletRestartAttempts = 0
  let outletRestartTimer = null
  function scheduleOutletRestart() {
    if (outletRestartTimer !== null) return
    if (Date.now() - outletUpSince >= OUTLET_STABLE_MS) outletRestartAttempts = 0
    const delay = Math.min(15_000 * 2 ** outletRestartAttempts, 600_000)
    outletRestartAttempts += 1
    logger.warn?.(`our-free-model: egress outlet went down; restarting in ${Math.round(delay / 1000)}s (attempt ${outletRestartAttempts})`)
    outletRestartTimer = setTimeout(() => {
      outletRestartTimer = null
      void syncEgress().catch(() => {})
    }, delay)
    outletRestartTimer.unref?.()
  }

  // ── browser-facing API ──────────────────────────────────────────────────────
  /**
   * Read a service the composition may or may not mount.
   *
   * `ctx.get` is cordis' opportunistic lookup: it answers `undefined` instead of
   * throwing when the service is absent — and also while it is merely not
   * provided yet, which matters because plugins load before the browser half has
   * published anything. So a service read this way is a snapshot: `connection` is
   * therefore resolved per request below, and `webServer` gets its own fiber (see
   * the `ctx.inject` at the end of this section).
   */
  const optional = service => (typeof ctx.get === 'function' ? ctx.get(service) : undefined)
  /**
   * The trust fence's view of the connection service, looked up per request.
   *
   * The browser half publishes `connection` after plugins have loaded, so reading
   * it once here would freeze in "absent" and leave every request on the replica
   * fence for the life of the process. The view takes the service *thunk* rather
   * than the service, and its `admit` answers `undefined` — not a no-op function
   * — while the service is missing, which is what makes the fence fall through to
   * its own structural check instead of reading as "admitted".
   */
  const fenceConnection = connectionAdmissionView(() => optional('connection'))
  // ── the absorbed free-channel pack ──────────────────────────────────────────
  /**
   * The 白嫖 channels — CodeArts (华为云), CodeBuddy / WorkBuddy (腾讯), LobsterAI
   * (有道), Qoder / Qoder CN (阿里系), TRAE (字节), Cline, Loomy (讯飞), Raccoon
   * (商汤), MiniMax Code, ZCode (智谱) and Gemini (Google) — are
   * carried with local integration adaptations from the plugin that shipped them, vendored under
   * `vendor/channel-pack` (provenance in `vendor/channel-pack/NOTICE.md`). Mounting the
   * pack keeps every login flow, account pool, credit claim, model blacklist
   * and its local OpenAI gateway working as they were validated upstream,
   * instead of being re-implemented here and drifting.
   *
   * The pack runs on a fiber of its own, after `credentials`, `commands` and
   * `llm` exist. A composition without them — a headless TUI, the offline test
   * harness — keeps the free lane and loses only the channels, the same trade
   * this plugin makes for every optional service. `channelPack` is the state
   * bit `/summary` reports so the page can say *why* the channel list is empty
   * instead of showing nothing.
   */
  let channelPack = { state: 'pending', error: '' }
  ctx.inject(['credentials', 'commands', 'llm'], scoped => {
    let stopped = false
    scoped.effect(() => () => { stopped = true }, 'our-free-model: channel pack')
    // Dynamic import: the pack's own imports (the kernel's llm and credential
    // modules) are host-provided, and a composition that lacks them must still
    // load this plugin's free lane. `pack.js` is the bundled form of the
    // vendored tree (see scripts/build-channel-pack.mjs) — one file, so the
    // release manifest stays inside its file cap.
    void import('./vendor/channel-pack/pack.js').then(pack => {
      if (stopped) return
      pack.apply(scoped, {
        disableOpencode: true,
        outlet: { active: egressActive, fetch: egressFetch, fetchSigned: (input, init, send) => egressFetch(input, init, send) },
      })
      channelPack = { state: 'ready', error: '' }
      logger.info?.('our-free-model: free-channel pack mounted (CodeArts, CodeBuddy, and 11 more)')
    }).catch(error => {
      if (stopped) return
      channelPack = { state: 'failed', error: String(error?.message ?? error).slice(0, 300) }
      logger.warn?.(`our-free-model: free-channel pack unavailable (${channelPack.error})`)
    })
  })

  const logAdmissionRejection = surface => ({ status, source, reason }) => {
    // Fixed fields only: headers, request URLs and admission errors may contain
    // credentials. JSON API and SSE must report the same admission boundary.
    logger.warn?.(`our-free-model: ${surface} admission rejected status=${status} source=${source} reason=${reason}`)
  }
  const api = createApiRoutes({
    settings, stats, availability, catalog: () => modelRuntime.catalog, state,
    refreshCatalog, refreshAvailability, syncForward, syncRelay, syncEgress,
    onVisibilityChanged: emitTopology,
    // ── fallback chains ─────────────────────────────────────────────────────
    combos: {
      list: () => ({
        combos: normalizeCombos(settings.get().combos),
        // Every id a chain may reference, with the display name the picker uses —
        // the editor offers a searchable list instead of a free-text field, so a
        // typo cannot become a chain link that silently never resolves.
        models: state().catalog.map(entry => ({
          id: entry.id, name: entry.name, channel: entry.channel ?? 'free', vision: entry.vision === true,
          contextWindow: entry.contextWindow, maxOutput: entry.maxOutput,
        })),
        usable: state().catalog.filter(isComboEntry).map(publicCombo),
        strategies: ['fallback', 'round-robin'],
      }),
      preview: patch => {
        if (patch === null || typeof patch !== 'object' || !Array.isArray(patch.models)
          || patch.models.length > 1000 || patch.models.some(id => typeof id !== 'string' || id.length > 300)) {
          throw httpError(400, 'models must be an array of model ids')
        }
        const entries = buildComboCatalog(normalizeCombos([{ name: 'preview', models: patch.models }]), state().catalog)
        return { capacity: entries.length ? publicCombo(entries[0]) : null }
      },
      save: async patch => {
        if (patch === null || typeof patch !== 'object') throw httpError(400, 'the request body must be a JSON object')
        const rows = normalizeCombos(patch.combos)
        // Stored as entered. Links that name nothing right now are kept on purpose:
        // a chain that reaches an EAC model is still correct on a day the lane is
        // closed, and dropping the link would quietly rewrite the user's chain.
        settings.update({ combos: rows })
        settings.flush()
        const catalog = syncAggregateCatalog()
        return { combos: rows, usable: catalog.filter(isComboEntry).map(publicCombo) }
      },
    },
    // ── token savers ────────────────────────────────────────────────────────
    tokenSaver: {
      get: () => ({ ...publicTokenSaver(settings.get().tokenSaver), savings: buildStats(stats.get(), state().catalog).savings }),
      set: async patch => {
        if (patch === null || typeof patch !== 'object') throw httpError(400, 'the request body must be a JSON object')
        const current = settings.get().tokenSaver ?? {}
        const prompts = { ...(current.prompts ?? {}) }
        if (patch.prompts !== null && typeof patch.prompts === 'object') {
          if (patch.prompts.caveman !== undefined) {
            const level = String(patch.prompts.caveman)
            if (!CAVEMAN_LEVELS.includes(level)) throw httpError(400, `caveman level must be one of ${CAVEMAN_LEVELS.join(', ')}`)
            prompts.caveman = level
          }
          if (patch.prompts.ponytail !== undefined) {
            const level = String(patch.prompts.ponytail)
            if (!PONYTAIL_LEVELS.includes(level)) throw httpError(400, `ponytail level must be one of ${PONYTAIL_LEVELS.join(', ')}`)
            prompts.ponytail = level
          }
        }
        settings.update({ tokenSaver: {
          ...current,
          prompts,
          ...patch.enabled === undefined ? {} : { enabled: patch.enabled === true },
          ...patch.rtk === undefined ? {} : { rtk: patch.rtk === true },
        } })
        settings.flush()
        return publicTokenSaver(settings.get().tokenSaver)
      },
    },
    // ── the five local answers ──────────────────────────────────────────────
    localOptimize: {
      get: () => publicLocalOptimize(settings.get().localOptimize),
      set: async patch => {
        if (patch === null || typeof patch !== 'object') throw httpError(400, 'the request body must be a JSON object')
        const current = settings.get().localOptimize ?? {}
        const next = { ...current }
        if (patch.enabled !== undefined) next.enabled = patch.enabled === true
        for (const kind of OPTIMIZATION_KINDS) if (patch[kind] !== undefined) next[kind] = patch[kind] === true
        settings.update({ localOptimize: next })
        settings.flush()
        return publicLocalOptimize(settings.get().localOptimize)
      },
    },
    // Connection recipes for the local gateway, generated from the live port and
    // key so the page never shows a stale address after a port fallback.
    clients: () => clientSnippets({
      forward: { running: forward !== null, port: forward?.port ?? 0, lan: { running: relay !== null, port: relay?.port ?? 0, addresses: lanAddresses() } },
      key: settings.get().forwardKey ?? '',
      lanKey: settings.get().forwardLanKey ?? '',
      models: publicModelRows().map(row => row.id),
    }),
    // The absorbed channel pack's liveness, for the 白嫖接入 page: the page
    // renders its channel grid from this bit plus the pack's own RPC.
    channels: () => channelPack,
    chanRelay: {
      status: chanRelayStatus,
      apply: async patch => {
        const current = settings.get().chanGateway ?? {}
        const relay = { ...(current.relay ?? {}) }
        if (patch === null || typeof patch !== 'object') throw httpError(400, 'the request body must be a JSON object')
        if (patch.enabled !== undefined) relay.enabled = patch.enabled === true
        if (patch.host !== undefined) {
          const host = String(patch.host ?? '').trim()
          if (host !== '' && host !== '127.0.0.1' && host !== 'localhost' && host !== '0.0.0.0' && host !== '::') {
            throw httpError(400, 'host must be one of 127.0.0.1, localhost, 0.0.0.0, ::')
          }
          relay.host = host === 'localhost' ? '127.0.0.1' : host
        }
        if (patch.port !== undefined) {
          const port = Number(patch.port)
          if (!Number.isInteger(port) || port < 0 || port > 65535) throw httpError(400, 'port must be an integer between 0 and 65535')
          relay.port = port
        }
        settings.update({ chanGateway: { ...current, relay } })
        settings.flush()
        await syncChanRelay()
        return chanRelayStatus()
      },
      key: () => chanRelayKey(),
      rotate: rotateChanRelayKey,
    },
    forwardInfo: () => ({
      running: forward !== null,
      port: forward?.port ?? 0,
      error: forwardError,
      notice: forwardNotice,
      egress: modelRuntime.egress,
      lan: {
        running: relay !== null,
        port: relay?.port ?? 0,
        host: relay?.host ?? '',
        error: relayError,
        addresses: lanAddresses(),
      },
    }),
    // The subscription URL is a credential: only its masked label ever leaves
    // this process. `active` mirrors what egressFetch is actually doing right
    // now (direct until the relay finishes starting, direct again once closed).
    egressInfo: () => ({
      running: outletRelay !== null,
      active: outletRelay !== null,
      mode: outletRelay?.mode ?? '',
      outlet: outletRelay === null ? '' : outletLabel(outletRelay.url ?? ''),
      // Cached readings: `/summary` is synchronous, so the live controller call
      // lives in `outletStatus` below and only the last answer is echoed here.
      node: outletNode.node,
      nodeDelayMs: outletNode.delayMs,
      nodeAt: outletNode.at,
      latencyMs: modelRuntime.gatewayLatency.ms,
      latencyAt: modelRuntime.gatewayLatency.at,
      // `dead` is the managed mihomo dying after startup — surfaced through the
      // same field so the settings page shows why traffic fell back to direct.
      error: outletError !== '' ? outletError : (outletRelay?.dead ?? ''),
    }),
    // The settings page polls this while the outlet is on: which node url-test is
    // carrying traffic on is mihomo's own state, and it changes without anything
    // else in this process moving.
    outletStatus: () => readOutletStatus(),
    rotateKey: () => {
      const minted = generateKey()
      settings.update({ forwardKey: minted })
      settings.flush()
      return minted
    },
    rotateLanKey: () => {
      const minted = generateKey()
      settings.update({ forwardLanKey: minted })
      settings.flush()
      return minted
    },
    testModel: (id, effort, options) => modelRuntime.testModel(id, effort, options),
    meta: () => ({
      version: packageVersion,
      distribution,
      generation,
      reloadedAt: settings.get().reloadedAt ?? 0,
      reloadCount: settings.get().reloadCount ?? 0,
      dataDir,
      autoReloadWatch: settings.get().autoReloadWatch === true,
      lastReload: globalThis[Symbol.for('our-free-model.last-reload')] ?? undefined,
      purgeSample: globalThis[Symbol.for('our-free-model.purge-sample')] ?? undefined,
    }),
    /** Fixed for this generation; the settings API cannot flip it (see below). */
    managedDistribution: managed,
    push,
    connection: fenceConnection,
    onAdmissionRejection: logAdmissionRejection('settings API'),
    /** Read on every ask, so a machine that changed networks answers with the
     *  interfaces it has now rather than the ones the relay started on. */
    lanAddresses,
    logger,
  })

  // The dashboard half runs in its own fiber so that a composition without an
  // HTTP server cannot take the model lane down with it.
  //
  // `ctx.inject(deps, callback)` is cordis' "run this once these services exist":
  // the callback pends while `webServer` is absent *or merely not provided yet*,
  // and is re-run if the service is replaced. That pending is the whole point —
  // reading `ctx.get('webServer')` once at apply time answered `undefined` in the
  // real web composition (plugins load before the browser half publishes it), the
  // routes never registered, and the settings page had no data source while a web
  // server was busy serving it.
  ctx.inject(['webServer'], scoped => {
    const server = scoped.webServer
    scoped.effect(() => server.register({ kind: 'prefix', path: '/api/our-free-model', handler: api }), 'our-free-model: api routes')
    // The events stream is an exact route: exact dispatch outranks the prefix, so
    // the hub's handler owns the socket while every other path still lands on the
    // JSON API.
    scoped.effect(() => server.register({ kind: 'exact', path: '/api/our-free-model/events', handler: eventsRoute }), 'our-free-model: events stream')
    logger.info?.('our-free-model: settings API mounted at /api/our-free-model')
  })

  /** Adopt one request as a live push stream, after the trust fence. */
  function eventsRoute(req, res) {
    const rejection = rejectionFor(req, fenceConnection, logAdmissionRejection('events'))
    if (rejection !== undefined) {
      res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(rejection === 401 ? 'unauthorized' : rejection === 503 ? 'admission unavailable' : 'forbidden')
      return
    }
    push.attach(req, res, helloPayload())
  }

  function helloPayload() {
    return {
      version: packageVersion,
      reloadedAt: settings.get().reloadedAt ?? 0,
    }
  }

  // ── boot + background loop ──────────────────────────────────────────────────
  ctx.effect(() => () => {
    modelRuntime.dispose()
    stores.dispose()
  }, 'our-free-model: stores')

  ctx.effect(() => () => {
    void forward?.close().catch(() => {})
    void relay?.close().catch(() => {})
    void chanRelay?.close().catch(() => {})
    void outletRelay?.close().catch(() => {})
  }, 'our-free-model: forward listener')

  ctx.effect(() => () => { registration() }, 'our-free-model: adapter routes')

  ctx.effect(() => () => {
    disposed = true
    // The geography-reprobe timer belongs to this generation; without this it
    // outlives teardown and fires a forced probe round after the stores it
    // reads have been disposed (the rejection gets swallowed, quota burned).
    modelRuntime.dispose()
    push.dispose()
  }, 'our-free-model: push + stores')

  ctx.effect(() => {
    void (async () => {
      modelRuntime.setAttributionUserAgent(await resolveAttributionUserAgent(logger))
      if (disposed) return
      // First: the catalog refresh and its probe round below go through
      // egressFetch, so the outlet must be carrying traffic before they run.
      await syncEgress()
      if (disposed) return
      // The listeners next, ahead of the round that goes out: they answer local
      // sockets and nothing in them depends on the gateway. Binding them after
      // the full listing + probe round meant a lane that stalled held the port
      // down for the whole round — the settings page still said it was on, and
      // it only started when the user clicked 应用, whose POST calls
      // `syncForward()` by itself.
      await syncForward()
      if (disposed) return
      await syncRelay()
      if (disposed) return
      await syncChanRelay()
      if (disposed) return
      // Every await here is a chance for teardown to have run underneath this
      // boot: a resumed refresh would force a probe round against stores it
      // disposed. The round is boot's only network step, so it is the one held
      // to a failure of its own — a throw here used to take the watcher, the
      // topology event and the upgrade marker below down with it, reported as
      // a single "startup refresh failed" line.
      try {
        await refreshCatalog({ probe: true, force: true })
      } catch (error) {
        logger.warn?.(`our-free-model: startup refresh failed (${error?.message ?? error})`)
      }
      if (disposed) return
      emitTopology()
      push.emit('hello', helloPayload())
    })().catch(error => logger.warn?.(`our-free-model: startup refresh failed (${error?.message ?? error})`))
  }, 'our-free-model: boot refresh')

  /**
   * Run one task every `ms` for as long as this generation lives.
   *
   * A plain unref'd timer chain, on purpose. `ctx.interval` is a mixin over the
   * `timer` service, and reading it from a fiber that did not name `timer` in
   * `inject` throws inside the real cordis proxy (`cannot get property "timer"
   * without inject`) instead of answering `undefined` — that one read is what
   * stopped the whole plugin from activating. `timer` is not worth declaring on a
   * headless composition, and the mixin adds nothing here beyond `setTimeout` plus
   * a disposer: it must not hold the process open, and `disposed` ends it when the
   * fiber goes away. Without any loop the availability probe would run once at
   * boot, so a model that throttled, recovered, or moved behind the region gate
   * would keep the picker position it was first given.
   */
  // `ms` may be a function: the period is re-read on every re-arm, so an
  // interval changed on the settings page takes effect from the next cycle
  // instead of echoing a number the running timer will never observe.
  function every(task, ms) {
    const period = () => typeof ms === 'function' ? ms() : ms
    let handle = setTimeout(function tick() {
      if (disposed) return
      task()
      handle = setTimeout(tick, period())
      handle.unref?.()
    }, period())
    handle.unref?.()
    ctx.effect(() => () => clearTimeout(handle), 'our-free-model: interval')
  }

  // The probe period is in minutes, and one minute is the floor — a value of 0 or
  // a negative one would otherwise spin. This used to read `Math.max(60, …)`,
  // which floored every interval below an hour *including the shipped default of
  // 15*, so the number on the settings page was silently ignored.
  every(() => {
    void (async () => {
      await watchEgress()
      await refreshCatalog({ probe: true })
    })().catch(error => logger.warn?.(`our-free-model: periodic refresh failed (${error?.message ?? error})`))
  }, () => positiveOr(settings.get().probeIntervalMinutes, 15, 1) * 60_000)
  // A failing egress watch means the network is down, which is worth one line —
  // and only the first of a streak, or a dead link would write every two minutes
  // until the next restart. A success resets the flag for the next outage.
  let egressWarned = false
  every(() => {
    void watchEgress()
      .then(() => {
        egressWarned = false
        // url-test re-ranks on its own 5-minute cycle; the node shown on the
        // settings page follows the same cadence as the exit reading.
        void readOutletStatus().catch(() => {})
      })
      .catch(error => {
        if (!egressWarned) logger.warn?.(`our-free-model: egress watch failed (${error?.message ?? error})`)
        egressWarned = true
      })
  }, 120_000)

  function emitTopology() {
    try { ctx.emit?.('llm/adapters-updated') } catch { /* no listener surface */ }
    registration.replace(routes())
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * An error the settings API presents with its own status line, not a bare 500.
 * Used where a refusal is the *correct* answer — a managed install declining to
 * update itself — so the page can say why instead of blaming a fault.
 */
function httpError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

/**
 * A period that cannot become a hot loop.
 *
 * `setTimeout(fn, NaN)` is `setTimeout(fn, 1)` in Node, and a settings file the
 * user edits by hand (the only way in on a headless composition) can carry
 * anything. Both timers below take their period from a stored number, so the
 * guard belongs here rather than in each caller.
 */function positiveOr(value, fallback, floor = 1) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.max(floor, Math.trunc(number))
}

/**
 * Coerce the settings a timer or the wire reads.
 *
 * The settings page's own cleared input field posts `0`: on the output ceiling
 * that read as `min(model capacity, 0)` and every turn came back capped at the
 * 512-token floor, and on a period it asked for a probe round a minute. A value
 * that is not a positive number is "the user did not set one", so it falls back
 * to what ships rather than being clamped into an extreme.
 */
function sanitizeSettings(patch, current) {
  const next = { ...patch }
  const positive = (key, fallback) => {
    if (next[key] === undefined) return
    const value = Number(next[key])
    next[key] = Number.isFinite(value) && value > 0 ? Math.trunc(value) : (Number(current[key]) || fallback)
  }
  positive('probeIntervalMinutes', 15)
  positive('feedPollMinutes', 30)
  positive('defaultMaxTokens', 32768)
  if (next.updateCheckHours !== undefined) {
    // Zero is a real answer here: it means "stop checking for updates".
    const hours = Number(next.updateCheckHours)
    next.updateCheckHours = Number.isFinite(hours) && hours >= 0 ? Math.trunc(hours) : (Number(current.updateCheckHours) || 6)
  }
  return next
}

/**
 * Resolve an image attachment into a data URL the provider can accept.
 *
 * The attachment service exposes a host path, not bytes; reading it here keeps the
 * plugin free of a second credential path. An unresolvable image is reported as a
 * warning and dropped — the runtime has already text-projected files, and a
 * text-only model never sees an image block in the first place.
 */
function imageResolver(ctx, logger) {
  if (typeof ctx.get !== 'function') return undefined
  const cache = new Map()
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024
  return ref => {
    // Looked up per call, not once at apply time: this is the third instance of
    // the same cordis trap the release note describes for `webServer` and
    // `connection` — a service that plugins load before is not provided yet, so a
    // one-shot read silently cost the whole feature (here: image attachments,
    // with nothing in the log to say so).
    const attachments = ctx.get('attachments')
    if (attachments === undefined || typeof attachments.imageHostPath !== 'function') return undefined
    const id = String(ref?.attachmentId ?? '')
    if (id === '') return undefined
    const cached = cache.get(id)
    if (cached !== undefined) return cached
    try {
      const hostPath = attachments.imageHostPath(ref)
      if (typeof hostPath !== 'string' || hostPath === '') return undefined
      const size = fs.statSync(hostPath).size
      if (size > MAX_IMAGE_BYTES) { logger.warn?.(`our-free-model: image ${id} is ${size} bytes, above the ${MAX_IMAGE_BYTES} send limit`); return undefined }
      const media = typeof ref.mediaType === 'string' ? ref.mediaType : 'image/png'
      const url = `data:${media};base64,${fs.readFileSync(hostPath).toString('base64')}`
      if (cache.size > 48) cache.clear()
      cache.set(id, url)
      return url
    } catch (error) {
      logger.warn?.(`our-free-model: could not read image ${id} (${error?.message ?? error})`)
      return undefined
    }
  }
}

/**
 * The settings page's HTTP surface.
 *
 * Every route runs the trust fence first: the connection service's own
 * admission when the composition mounts it (the same check the kernel applies
 * to `/api`), otherwise the structural replica in src/trust.js. The plugin's
 * prefix outranks `/api` in webServer's longest-prefix dispatch, so without
 * this fence these routes would answer callers the app itself would refuse.
 */
/** The fixed failure classes the pool proxy may surface to the client. */

export function createApiRoutes(deps) {
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const routePath = url.pathname.replace(/^\/api\/our-free-model/, '').replace(/\/+$/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()
    const rejection = rejectionFor(req, deps.connection, deps.onAdmissionRejection)
    const send = (status, payload) => {
      const body = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
    }
    if (rejection !== undefined) return send(rejection, {
      error: rejection === 401 ? 'unauthorized' : rejection === 503 ? 'admission unavailable' : 'forbidden',
    })
    try {
      if (method === 'GET' && routePath === '/summary') {
        return send(200, buildSummary(deps))
      }
      if (method === 'GET' && routePath === '/stats') {
        return send(200, buildStats(deps.stats.get(), deps.catalog()))
      }
      if (method === 'GET' && routePath === '/outlet') {
        return send(200, await deps.outletStatus())
      }
      // ── fallback chains ────────────────────────────────────────────────────
      if (method === 'GET' && routePath === '/combos') {
        return send(200, deps.combos.list())
      }
      if (method === 'POST' && routePath === '/combos') {
        const body = await readJson(req)
        return send(200, { ok: true, ...await deps.combos.save(body) })
      }
      if (method === 'POST' && routePath === '/combos/preview') {
        return send(200, deps.combos.preview(await readJson(req)))
      }
      // ── token savers ───────────────────────────────────────────────────────
      if (method === 'GET' && routePath === '/token-saver') {
        return send(200, deps.tokenSaver.get())
      }
      if (method === 'POST' && routePath === '/token-saver') {
        const body = await readJson(req)
        return send(200, { ok: true, tokenSaver: await deps.tokenSaver.set(body) })
      }
      // ── the five local answers ─────────────────────────────────────────────
      if (method === 'GET' && routePath === '/local-optimize') {
        return send(200, deps.localOptimize.get())
      }
      if (method === 'POST' && routePath === '/local-optimize') {
        const body = await readJson(req)
        return send(200, { ok: true, localOptimize: await deps.localOptimize.set(body) })
      }
      // ── connection recipes ─────────────────────────────────────────────────
      if (method === 'GET' && routePath === '/clients') {
        return send(200, deps.clients())
      }
      if (method === 'GET' && routePath === '/meta') {
        return send(200, deps.meta())
      }
      if (method === 'POST' && routePath === '/open-external') {
        const target = externalUrl((await readJson(req))?.url)
        if (target === null) return send(400, { error: 'bad-url' })
        let opened = false
        try { opened = await (deps.openExternal ?? openExternal)(target) === true } catch { /* manual link remains available */ }
        return send(200, { ok: true, opened })
      }
      if (method === 'POST' && routePath === '/settings') {
        const patch = await readJson(req)
        const visibility = validateModelVisibility(patch)
        const current = deps.settings.get()
        const next = sanitizeSettings({ ...current, ...pick(patch, ['enabled', 'exposeRegionModels', 'probeIntervalMinutes', 'defaultMaxTokens', 'autoReloadWatch']), ...visibility }, current)
        if (patch.forward !== undefined) {
          const forward = { ...(current.forward ?? {}), ...pick(patch.forward, ['enabled', 'host', 'port']) }
          // The listener spends this machine's lane, and a routable bind address
          // would let the whole subnet spend it too. Refused here so the settings
          // page says why, and again in `syncForward` for a hand-edited file.
          if (forward.enabled === true && !isLoopbackHost(forward.host ?? '127.0.0.1')) {
            return send(400, { error: 'the forward listener binds a loopback address only' })
          }
          if (forward.port !== undefined) {
            const port = Number(forward.port)
            forward.port = Number.isFinite(port) && port >= 0 && port <= 65535 ? Math.trunc(port) : (current.forward?.port ?? 0)
          }
          // The LAN relay is a second door on the same feature, so it travels in
          // the same `forward` patch — but it does *not* inherit the loopback
          // rule, because reaching another machine is its entire purpose.
          if (patch.forward.lan !== undefined) {
            const lan = { ...(current.forward?.lan ?? {}), ...pick(patch.forward.lan, ['enabled', 'port']) }
            if (lan.port !== undefined) {
              const port = Number(lan.port)
              // Zero asks the OS to choose, which is the sane default here: the
              // local port is frequently taken on a machine that already runs
              // something else.
              lan.port = Number.isFinite(port) && port >= 0 && port <= 65535 ? Math.trunc(port) : (current.forward?.lan?.port ?? 0)
            }
            forward.lan = lan
          }
          next.forward = forward
        }
        if (patch.egress !== undefined) {
          const egressPatch = pick(patch.egress, ['enabled', 'mode', 'url', 'mihomoPath'])
          if (egressPatch.mode !== undefined && egressPatch.mode !== 'subscription' && egressPatch.mode !== 'client') {
            return send(400, { error: 'the egress mode is "subscription" or "client"' })
          }
          for (const key of ['url', 'mihomoPath']) {
            if (egressPatch[key] !== undefined) {
              const value = String(egressPatch[key]).trim()
              if (value.length > 2048) return send(400, { error: `the egress ${key} is too long` })
              egressPatch[key] = value
            }
          }
          const egress = { ...(current.egress ?? {}), ...egressPatch }
          if (egress.enabled === true && String(egress.url ?? '') === '') {
            return send(400, { error: 'the outlet needs a subscription or proxy URL' })
          }
          next.egress = egress
        }
        deps.settings.update(next)
        deps.settings.flush()
        if (deps.settings.writeFailed) {
          deps.settings.value = current
          return send(500, { error: 'could not persist settings' })
        }
        if (Object.keys(visibility).length > 0) deps.onVisibilityChanged?.()
        await deps.syncForward()
        await deps.syncRelay()
        await deps.syncEgress()
        return send(200, { ok: true, settings: publicSettings(deps.settings.get(), deps.forwardInfo(), deps.egressInfo()) })
      }
      if (method === 'POST' && routePath === '/refresh') {
        await deps.refreshCatalog({ probe: true, force: true })
        return send(200, { ok: true, ...buildSummary(deps) })
      }
      if (method === 'POST' && routePath === '/reprobe') {
        await deps.refreshAvailability(true)
        return send(200, { ok: true, ...buildSummary(deps) })
      }
      if (method === 'GET' && routePath === '/forward/key') {
        return send(200, { key: deps.settings.get().forwardKey ?? '' })
      }
      if (method === 'POST' && routePath === '/forward/rotate') {
        return send(200, { key: deps.rotateKey() })
      }
      // The channels' gateway relay (the pack's loopback OpenAI endpoint,
   // re-exposed under this plugin's own key). Status never carries a secret;
      // the key routes are read by the same fence as every other route here.
      if (method === 'GET' && routePath === '/chan-gateway') {
        return send(200, deps.chanRelay.status())
      }
      if (method === 'POST' && routePath === '/chan-gateway/apply') {
        const body = await readJson(req)
        return send(200, await deps.chanRelay.apply(body))
      }
      if (method === 'GET' && routePath === '/chan-gateway/key') {
        return send(200, { key: deps.chanRelay.key() })
      }
      if (method === 'POST' && routePath === '/chan-gateway/rotate') {
        return send(200, { key: deps.chanRelay.rotate() })
      }
      if (method === 'GET' && routePath === '/forward/lan/key') {
        return send(200, { key: deps.settings.get().forwardLanKey ?? '' })
      }
      if (method === 'POST' && routePath === '/forward/lan/rotate') {
        return send(200, { key: deps.rotateLanKey() })
      }
      // The relay binds every interface, so which address a peer should dial is a
      // property of this machine right now — not of the moment the relay started.
      // The panel polls this while the relay is on: a laptop that switched
      // networks (or brought a VPN up) holds different addresses, and the one it
      // was showing is the one the user copies to the other machine.
      if (method === 'GET' && routePath === '/forward/lan/addresses') {
        return send(200, { addresses: deps.lanAddresses() })
      }
      // The subscription/proxy URL is a credential, so it lives outside every
      // routine payload and leaves the process only when the settings page asks
      // for it — the same shape as the forward keys above.
      if (method === 'GET' && routePath === '/egress/url') {
        return send(200, { url: deps.settings.get().egress?.url ?? '' })
      }
      if (method === 'POST' && routePath === '/bench') {
        const body = await readJson(req)
        const controller = new AbortController()
        const abort = () => controller.abort(new UpstreamError('Text test cancelled', CODE.aborted))
        res.once?.('close', abort)
        try {
          const result = await deps.testModel(String(body.model ?? ''), body.effort === undefined ? undefined : String(body.effort), { signal: controller.signal })
          if (!controller.signal.aborted) return send(200, result)
          return
        } catch (error) {
          if (!controller.signal.aborted) throw httpError(error.status === 404 ? 404 : error.code === CODE.timeout ? 504 : 502, String(error.message ?? error))
          return
        } finally { res.removeListener?.('close', abort) }
      }
      return send(404, { error: 'not found' })
    } catch (error) {
      const status = Number(error?.statusCode)
      return send(Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500, { error: String(error?.message ?? error) })
    }
  }
}


function pick(source, keys) {
  const out = {}
  for (const key of keys) if (source?.[key] !== undefined) out[key] = source[key]
  return out
}

/** The most a browser-API request body may weigh. The settings patch and the
 *  announcement acks are the largest real payloads here by orders of magnitude;
 *  without a cap, any caller past the fence could buffer unbounded bytes into
 *  the host process — a different standard than the forward listener's 8 MB. */
const MAX_API_BODY_BYTES = 1024 * 1024

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_API_BODY_BYTES) throw httpError(413, 'request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try { return JSON.parse(text) } catch (error) {
    // A body that was sent but is not JSON is a client bug, not "no body":
    // answering {} made POST /settings a silent 200 no-op. Empty bodies stay
    // legal ({} above) because no-body POSTs are real routes here.
    throw httpError(400, `invalid JSON body (${error?.message ?? error})`)
  }
}


/**
 * The token-saver section as the browser may see it.
 *
 * Normalized rather than echoed: a stored level id that is not in the family's
 * list would otherwise reach a `<select>` with no matching option and render as
 * "off" while the pipeline was still using something else.
 */
function publicTokenSaver(section) {
  const config = saverConfig({ tokenSaver: section })
  return {
    enabled: config.enabled,
    rtk: config.rtk,
    prompts: { caveman: config.caveman, ponytail: config.ponytail },
    cavemanLevels: CAVEMAN_LEVELS,
    ponytailLevels: PONYTAIL_LEVELS,
  }
}

/** The five local answers, in evaluation order. */
const OPTIMIZATION_KINDS = OPTIMIZATIONS

/**
 * The local-optimization switches as the browser may see them.
 *
 * Each kind is reported individually even when the section is off, because the
 * page shows five separate switches: a master switch that silently blanked them
 * would look like the per-kind values had been lost.
 */
function publicLocalOptimize(section) {
  const config = section ?? {}
  const out = { enabled: config.enabled !== false }
  for (const kind of OPTIMIZATION_KINDS) out[kind] = config[kind] !== false
  return out
}

/** The switches in the shape `tryOptimizations` wants. */
function optimizeConfig(section) {
  const publicView = publicLocalOptimize(section)
  return publicView.enabled === true ? publicView : null
}

/**
 * Connection recipes for the local gateway.
 *
 * Generated rather than stored: the port can move when the requested one is
 * taken, so a snippet baked into the page at mount time is a snippet that lies
 * after a restart. Everything here is derived from what the listeners actually
 * bound and the keys they actually demand.
 */
function clientSnippets({ forward, key, lanKey, models }) {
  const running = forward.running === true
  const base = running ? `http://127.0.0.1:${forward.port}` : 'http://127.0.0.1:<forward-port>'
  const lanAddress = forward.lan.running === true && forward.lan.addresses.length > 0
    ? `http://${forward.lan.addresses[0]}:${forward.lan.port}`
    : ''
  const shownKey = key === '' ? '<forward-key>' : key
  const shownLanKey = lanKey === '' ? '<lan-key>' : lanKey
  const sample = models[0] ?? 'deepseek-v4-flash-free'
  const snippets = [
    {
      id: 'claude-code',
      name: 'Claude Code',
      language: 'bash',
      body: [
        `export ANTHROPIC_BASE_URL=${base}`,
        `export ANTHROPIC_AUTH_TOKEN=${shownKey}`,
        `export ANTHROPIC_MODEL=${sample}`,
        '# the gateway speaks /v1/messages natively — no translation shim needed',
      ].join('\n'),
    },
    {
      id: 'codex',
      name: 'Codex CLI',
      language: 'toml',
      body: [
        '# ~/.codex/config.toml',
        'model_provider = "ofm"',
        `model = "${sample}"`,
        '',
        '[model_providers.ofm]',
        'name = "Our Free Model"',
        `base_url = "${base}/v1"`,
        'wire_api = "responses"',
        `env_key = "OFM_API_KEY"`,
      ].join('\n'),
    },
    {
      id: 'openai-sdk',
      name: 'OpenAI SDK / any OpenAI-compatible tool',
      language: 'python',
      body: [
        'from openai import OpenAI',
        `client = OpenAI(base_url="${base}/v1", api_key="${shownKey}")`,
        `client.chat.completions.create(model="${sample}", messages=[{"role": "user", "content": "hi"}])`,
      ].join('\n'),
    },
    {
      id: 'anthropic-sdk',
      name: 'Anthropic SDK',
      language: 'python',
      body: [
        'from anthropic import Anthropic',
        `client = Anthropic(base_url="${base}", api_key="${shownKey}")`,
        `client.messages.create(model="${sample}", max_tokens=1024, messages=[{"role": "user", "content": "hi"}])`,
      ].join('\n'),
    },
    {
      id: 'curl',
      name: 'curl',
      language: 'bash',
      body: [
        `curl ${base}/v1/chat/completions \\`,
        `  -H "authorization: Bearer ${shownKey}" \\`,
        '  -H "content-type: application/json" \\',
        `  -d '{"model":"${sample}","messages":[{"role":"user","content":"hi"}]}'`,
        '',
        '# the Anthropic surface answers on the same port:',
        `curl ${base}/v1/messages \\`,
        `  -H "x-api-key: ${shownKey}" \\`,
        '  -H "anthropic-version: 2023-06-01" \\',
        '  -H "content-type: application/json" \\',
        `  -d '{"model":"${sample}","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}'`,
      ].join('\n'),
    },
  ]
  if (lanAddress !== '') {
    snippets.push({
      id: 'lan',
      name: 'Another device on your network',
      language: 'bash',
      body: [
        `# the LAN relay is up on this machine; its key is not the local one`,
        `export OPENAI_BASE_URL=${lanAddress}/v1`,
        `export OPENAI_API_KEY=${shownLanKey}`,
      ].join('\n'),
    })
  }
  return {
    running,
    baseUrl: base,
    lanUrl: lanAddress,
    key: shownKey,
    models,
    snippets,
  }
}

function publicCombo(entry) {
  return {
    id: entry.id, name: entry.name, models: entry.combo,
    contextWindow: entry.contextWindow, maxOutput: entry.maxOutput, vision: entry.vision === true,
  }
}

function publicSettings(settings, forwardInfo, egressInfo) {
  return {
    ...publicModelVisibility(settings),
    enabled: settings.enabled !== false,
    exposeRegionModels: settings.exposeRegionModels !== false,
    probeIntervalMinutes: settings.probeIntervalMinutes ?? 15,
    defaultMaxTokens: settings.defaultMaxTokens ?? 32768,
    autoReloadWatch: settings.autoReloadWatch === true,
    reloadedAt: settings.reloadedAt ?? 0,
    reloadCount: settings.reloadCount ?? 0,
    tokenSaver: publicTokenSaver(settings.tokenSaver),
    combos: normalizeCombos(settings.combos).map(combo => ({
      id: combo.id,
      name: combo.name,
      models: combo.models,
      strategy: combo.strategy,
      stickyLimit: combo.stickyLimit,
      enabled: combo.enabled,
    })),
    forward: {
      ...(settings.forward ?? {}),
      running: forwardInfo.running,
      actualPort: forwardInfo.port,
      error: forwardInfo.error,
      notice: forwardInfo.notice ?? '',
      lan: {
        ...(settings.forward?.lan ?? {}),
        running: forwardInfo.lan?.running === true,
        actualPort: forwardInfo.lan?.port ?? 0,
        host: forwardInfo.lan?.host ?? '',
        error: forwardInfo.lan?.error ?? '',
        addresses: forwardInfo.lan?.addresses ?? [],
      },
    },
    // A subscription link is not an endpoint, it is a bearer credential: the
    // path of the URL *is* the token, which is why it is handled like the
    // forward keys and not like `feedUrl`. Stored as given, but never echoed —
    // `urlLabel` is the masked host for the panel, `hasUrl` says whether one is
    // set at all, and the value itself is served only by `GET /egress/url`, on
    // the settings page's own ask (see src/egress.js `outletLabel`).
    egress: {
      ...pick(settings.egress ?? {}, ['enabled', 'mode', 'mihomoPath']),
      hasUrl: String(settings.egress?.url ?? '') !== '',
      urlLabel: outletLabel(settings.egress?.url ?? ''),
      outlet: egressInfo?.outlet ?? '',
      running: egressInfo?.running === true,
      active: egressInfo?.active === true,
      // The node url-test is carrying traffic on, its last measured delay, and
      // how long reaching the gateway took. All three are readings, not state.
      node: egressInfo?.node ?? '',
      nodeDelayMs: egressInfo?.nodeDelayMs ?? 0,
      latencyMs: egressInfo?.latencyMs ?? 0,
      latencyAt: egressInfo?.latencyAt ?? 0,
      error: egressInfo?.error ?? '',
    },
  }
}

function buildSummary(deps) {
  const state = deps.state()
  const snapshot = deps.availability.get()
  const forwardInfo = deps.forwardInfo()
  const defaultMaxTokens = deps.settings.get().defaultMaxTokens
  // Lanes that carry no availability verdict of their own. The absorbed channels
  // are named by a listing round that already succeeded, and a combo is a view
  // over rows that were themselves named — none of them is pinged. A listing is
  // not an inference verdict; explicit tests add their own samples.
  const unprobed = entry => isKiloEntry(entry) || isComboEntry(entry)
  return {
    catalog: state.catalog.map(entry => ({
      ...entry,
      hiddenByUser: isModelHidden(entry, state.settings),
      hiddenByGroup: isModelHidden(entry, { ...state.settings, hiddenModelIds: [] }),
      ...modelAvailability(entry.id, snapshot, unprobed(entry)),
      // What each rung of the effort menu will really put on the wire for this
      // model, so the page never shows a 32K "output ceiling" beside a call that
      // was cut off at 8K. A model with no effort menu has no ladder to show;
      // a menu model's rungs are flat (its level, not the ladder, is the wire
      // control), which is what the card's "default ceiling" tag then reads.
      ...(entry.reasoning === true ? { budgets: budgetLadder(entry, undefined, defaultMaxTokens) } : {}),
      // `null` here is what the picker does not advertise; the roster still lists
      // those models, because "the probe refused it" is the user's only evidence.
      route: (state.membership[ROUTE_MAIN] ?? []).includes(entry.id) ? ROUTE_MAIN
        : (state.membership[ROUTE_REGION] ?? []).includes(entry.id) ? ROUTE_REGION : null,
    })),
    settings: publicSettings(deps.settings.get(), forwardInfo, deps.egressInfo()),
    egress: forwardInfo.egress ?? snapshot.egress ?? null,
    outlet: deps.egressInfo(),
    probedAt: snapshot.at ?? 0,
    version: deps.meta().version,
    distribution: deps.meta().distribution,
    // Whether the absorbed free-channel pack is live on this host, and its
    // failure reason when it is not (see the mount in `apply`).
    channels: deps.channels?.() ?? { state: 'unknown', error: '' },
  }
}
