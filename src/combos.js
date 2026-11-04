/**
 * Combos: one model name that is really an ordered chain.
 *
 * The failure this exists for is not exotic. A quota wall, a region refusal, an
 * expired credential or a 5xx from one upstream all arrive as "your turn died",
 * even though three other lanes on this machine were idle and would have
 * answered. A combo turns that into a retry the user never sees: the chain is
 * walked in order, and the first candidate that produces output wins.
 *
 * A combo is a *virtual catalog entry*. It carries `channel: 'combo'` and a
 * `combo` list of real model ids, so the picker advertises it beside the real
 * models and the forward gateway dials it by name. `combo:` is the prefix, and
 * it is deliberately not a valid provider id — `parseProviderModelId` refuses
 * it, so a channel row can never be mistaken for a combo.
 *
 * Two strategies:
 *
 * - `fallback` — always start at the head of the list. Predictable, and the
 *   right choice when the list is a quality ladder.
 * - `round-robin` — start at the next candidate each turn (sticky for
 *   `stickyLimit` consecutive turns), so a chain of equivalent models spreads
 *   its load. The rotation cursor lives in memory: a restart losing it costs
 *   nothing but a different starting point.
 *
 * Capacities are the *intersection*, not the union. A chain that advertises
 * vision because its head supports it hands a fallback an image it cannot read;
 * a chain that advertises a 1M window because its head has one overruns a
 * fallback at 128K. The honest numbers are the ones every candidate can honour.
 *
 * @module src/combos.js
 */

import { createHash } from 'node:crypto'

export const COMBO_CHANNEL = 'combo'
export const COMBO_PREFIX = 'combo:'
export const COMBO_STRATEGIES = ['fallback', 'round-robin']

/** Rotation cursors, keyed by combo id. In-memory on purpose (see the header). */
const rotation = new Map()

/**
 * 每条链路**最近一次真正答出内容的成员**（诊断用，键 = combo id）。
 *
 * ## 为什么需要（2026-11-04 用户反馈「设了 10 次就换，一直没实现」）
 *
 * 轮询本身是生效的（实测 stickyLimit=10 时前 10 回合用首个成员、第 11 回合切到
 * 第二个），但**外面完全看不出来**：`bench` 与报告里的 `model` 字段始终是链路名
 * `combo:xxx`，不告诉你这一回合实际打到哪个成员。于是「它到底有没有轮」只能靠
 * 猜 —— 用户自然得出「没实现」的结论。
 *
 * 记下来之后，`testModel` 与链路日志都能如实显示「本轮由谁作答」。
 * 内存即可：它只是可观测性，重启丢失无影响。
 */
const lastServed = new Map()

/** 记下某条链路这一回合最终由谁作答。 */
export function noteComboServed(comboIdValue, memberId) {
  if (typeof comboIdValue !== 'string' || comboIdValue === '') return
  if (typeof memberId !== 'string' || memberId === '') return
  lastServed.set(comboIdValue, memberId)
}

/** 读某条链路上一次由谁作答（没有则空串）。 */
export function comboLastServed(comboIdValue) {
  return lastServed.get(comboIdValue) ?? ''
}

export function isComboEntry(entry) {
  return entry?.channel === COMBO_CHANNEL && Array.isArray(entry.combo)
}

/** `My Fast Chain` -> `combo:my-fast-chain`. */
export function comboId(name) {
  const normalized = String(name ?? '').trim().toLowerCase()
  if (normalized === '') return ''
  const slug = normalized
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  // Non-Latin names still need a stable, URL-safe identity after a reload.
  const identity = slug && !/[^\x20-\x7e]/.test(normalized) ? slug
    : `${slug || 'u'}-${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`
  return `${COMBO_PREFIX}${identity}`
}

/**
 * Coerce the stored settings value into a list of well-formed combos.
 *
 * A stored combo is user input that survived a JSON file, so every field is
 * treated as untrusted: a non-array `models` becomes empty (and the combo is
 * then dropped, because a chain with no links is a model that cannot answer),
 * a non-string id is dropped, and an unknown strategy falls back to `fallback`
 * rather than being honoured as a typo.
 */
export function normalizeCombos(raw) {
  const rows = Array.isArray(raw) ? raw : []
  const seen = new Set()
  const out = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const id = typeof row.id === 'string' && row.id.startsWith(COMBO_PREFIX) ? row.id : comboId(row.name ?? row.id)
    if (id === '' || seen.has(id)) continue
    const models = [...new Set((Array.isArray(row.models) ? row.models : [])
      .map(value => String(value ?? '').trim())
      .filter(value => value !== '' && value !== id))]
    if (models.length === 0) continue
    seen.add(id)
    out.push({
      id,
      name: String(row.name ?? '').trim() || id.slice(COMBO_PREFIX.length),
      models,
      strategy: COMBO_STRATEGIES.includes(row.strategy) ? row.strategy : 'fallback',
      stickyLimit: Number.isFinite(Number(row.stickyLimit)) && Number(row.stickyLimit) > 0 ? Math.trunc(Number(row.stickyLimit)) : 1,
      enabled: row.enabled !== false,
    })
  }
  return out
}

/**
 * Build the virtual catalog rows for every enabled combo.
 *
 * Models that are not in the catalog *right now* are dropped from the chain
 * rather than kept as a hopeful entry: a chain whose second link does not exist
 * would report "tried 2 candidates" for a turn that only ever had one. The
 * combo itself disappears when fewer than one candidate survives, which is the
 * same rule the picker applies to a lane with no models.
 *
 * @param {Array<object>} combos - from `normalizeCombos`
 * @param {Array<object>} catalog - every real catalog entry
 */
export function buildComboCatalog(combos, catalog) {
  const byId = new Map()
  for (const entry of catalog) if (!isComboEntry(entry)) byId.set(entry.id, entry)
  const out = []
  for (const combo of combos) {
    if (combo.enabled === false) continue
    const members = combo.models.map(id => byId.get(id)).filter(entry => entry !== undefined)
    if (members.length === 0) continue
    out.push({
      id: combo.id,
      name: combo.name,
      channel: COMBO_CHANNEL,
      combo: members.map(entry => entry.id),
      strategy: combo.strategy,
      stickyLimit: combo.stickyLimit,
      // Intersection, not union — see the module header.
      vision: members.every(entry => entry.vision === true),
      reasoning: members.some(entry => entry.reasoning === true),
      contextWindow: Math.min(...members.map(entry => number(entry.contextWindow) ?? 131072)),
      maxOutput: Math.min(...members.map(entry => number(entry.maxOutput) ?? 32768)),
      canDisableThinking: members.every(entry => entry.canDisableThinking !== false),
      regionSensitive: false,
      /** Which lanes this chain can reach, for the detail line. */
      lanes: [...new Set(members.map(entry => entry.channel ?? 'free'))],
    })
  }
  return out
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined
}

/**
 * Resolve a combo row into the ordered candidate entries for one turn.
 *
 * `fallback` returns the list as stored, always from its head. `round-robin`
 * starts at the rotating cursor and walks **forward to the end** — it never
 * wraps the tail back to the head of the same turn, because a candidate that
 * just failed (a spent quota, a region refusal) must not hand the turn back to
 * a member that was already skipped. The cursor keeps its place for
 * `stickyLimit` turns, which is the behaviour the upstream router settled on:
 * a strict per-turn rotation defeats prompt caching on every provider in the
 * chain, and a strictly sticky cursor makes the other candidates decoration.
 *
 * @param {object} entry - a combo catalog row
 * @param {Array<object>} catalog
 * @param {{peek?: boolean}} [options] - `peek` computes the order without consuming a turn
 */
export function comboChain(entry, catalog, options = {}) {
  const ids = Array.isArray(entry?.combo) ? entry.combo : []
  const byId = new Map()
  for (const row of catalog) byId.set(row.id, row)
  const members = ids.map(id => byId.get(id)).filter(row => row !== undefined)
  if (members.length <= 1 || entry.strategy !== 'round-robin') return members
  const limit = Number.isFinite(Number(entry.stickyLimit)) && Number(entry.stickyLimit) > 0 ? Math.trunc(Number(entry.stickyLimit)) : 1
  const cursor = rotation.get(entry.id) ?? { index: 0, used: 0 }
  const index = Math.min(Math.max(cursor.index, 0), members.length - 1)
  /**
   * 顺序是「从游标往后走，走到队尾再接到队首」：**一回合内每个成员只出现一次**，
   * `runCombo` 因此不会在有答案之前重复撞同一个成员。真正让用户觉得「一直回到
   * buddy」的不是这里的回绕，而是**跨回合**的游标：游标停在队尾那一回合之后
   * 如果不前移，下一回合又从同一个起点开始，看起来就像从头轮。所以失败/命中
   * 之后由 `advanceComboCursor` 把游标推到「刚试过的那个成员的下一个」。
   */
  const ordered = [...members.slice(index), ...members.slice(0, index)]
  if (options.peek !== true) {
    const used = cursor.used + 1
    rotation.set(entry.id, used >= limit ? { index: (index + 1) % members.length, used: 0 } : { index, used })
  }
  return ordered
}

/**
 * 失败换人：把轮询游标前移到 `afterId` 的下一个成员（用户 2026-11-04 的规则）。
 *
 * > 1-N 循环轮动每个渠道，成功了就继续下 9 次请求，失败了就下一个渠道。
 * > 循环的轮，不存在降级/隔离/抛弃。
 *
 * 语义只有一条：**失败的那个渠道这一轮不占次数，紧接着的下一个渠道接着服务**。
 * 游标只是往前挪一格，链条始终是 1→N→1→N 的闭环 —— 转一圈回来仍会轮到
 * 失败的渠道、届时照样先试它，所以不存在「隔离」或「抛弃」。
 */
export function advanceComboCursor(entry, catalog, afterId) {
  if (entry?.strategy !== 'round-robin') return
  const ids = Array.isArray(entry?.combo) ? entry.combo : []
  const present = new Set(catalog.map(row => row.id))
  const members = ids.filter(id => present.has(id))
  if (members.length <= 1) return
  const at = members.indexOf(afterId)
  if (at < 0) return
  /*
   * `used: 1` 而不是 0（2026-11-04 实测修正，别改回 0）：
   *
   * `used` 记的是「**当前游标所指成员**已连续服务了几回合」。失败换人时，
   * 接手的那一家**就在本回合接手并作答**，所以它已经服务了 1 回合，计数该是 1。
   *
   * 写 0 会让它白拿一次：下一回合 `comboChain` 再加 1 才等于初始值，
   * 于是这个渠实际能连任 `stickyLimit + 1` 回合，而别人只有 `stickyLimit`。
   * 60 回合实测的偏差很直观：
   *
   *   used=0 → { buddy:19, officeace:11 }（codearts 全程失败时）
   *   used=1 → { buddy:20, officeace:10 }（各渠道严格 10 次，完全均分）
   */
  rotation.set(entry.id, { index: (at + 1) % members.length, used: 1 })
}

/** Drop rotation cursors for combos that no longer exist, so the map cannot grow forever. */
export function pruneRotation(combos) {
  const live = new Set(combos.map(combo => combo.id))
  for (const key of rotation.keys()) if (!live.has(key)) rotation.delete(key)
  for (const key of lastServed.keys()) if (!live.has(key)) lastServed.delete(key)
}

