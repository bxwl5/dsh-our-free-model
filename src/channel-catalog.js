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
export async function readChannelRosters(llm, packProviders, onError) {
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
  for (const info of listed) {
    const provider = typeof info?.id === 'string' ? info.id : ''
    if (provider === '' || OWN_ROUTES.has(provider)) continue
    if (!packProviders.has(provider)) continue
    try {
      const models = await llm.listModels(provider)
      const roster = Array.isArray(models) ? models : []
      if (roster.length === 0) continue
      providers.push(provider)
      rows.push(...buildChannelCatalog([{ provider, models: roster }]))
    } catch (error) {
      onError?.(provider, error)
    }
  }
  return { rows, providers }
}
