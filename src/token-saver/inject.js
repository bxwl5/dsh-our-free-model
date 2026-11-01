/**
 * System-prompt injection for the three wires this plugin builds.
 *
 * The prompt families in `./prompts.js` only matter once their text is inside
 * the outgoing body, and each wire keeps its system text somewhere else:
 * a `{role:'system'}` message on `chat`, the `system` field on `messages`
 * (a string or a list of blocks), and `instructions` or a system item on
 * `responses`. This module puts one prompt into whichever of those the body
 * has, exactly once, without disturbing anything around it.
 *
 * Idempotency and stripping share one mechanism: the injected text travels as
 * a marker-delimited segment
 *
 *     <!-- ofm-token-saver -->
 *     <prompt text>
 *     <!-- /ofm-token-saver -->
 *
 * The upstream RTK injector deduped on the raw prompt as an exact `\n\n`
 * delimited segment instead (`systemInject.js`, `hasPrompt`), but it never had
 * to take an injection back. This port needs `stripInjected` for the
 * user-facing off switch and for round-trip tests, and a bare prompt cannot be
 * told apart from the user's own system text of the same wording — so the
 * segment carries a marker, and stripping removes exactly the marked region
 * plus the separator that joined it to its neighbours. The exact-segment test
 * itself is kept: a body is "already injected" only when this very segment is
 * present, so two different prompts coexist and a re-injection of either is a
 * no-op.
 *
 * Every failure is fail-open: an unrecognised wire or body shape changes
 * nothing and says so. This module sits between the user's turn and the
 * provider, so its worst acceptable outcome is injecting nothing.
 *
 * @module src/token-saver/inject.js
 */

/** Opens the injected region; its presence is what `hasInjected` reports. */
export const INJECT_MARKER = '<!-- ofm-token-saver -->'

/** Closes the region {@link INJECT_MARKER} opens; a cut needs both. */
const MARKER_END = '<!-- /ofm-token-saver -->'

/**
 * Joins prompt segments — the same `\n\n` the project's projectors use
 * (`messages.js` joins system parts with it, and the sealed-lane pacing hint in
 * `adapter.js` appends with it), so one system message reads the same however
 * it was assembled.
 */
const SEP = '\n\n'

const result = (payload, injected, reason) => ({ payload, injected, reason })

/**
 * Put `text` into the body's system text, once.
 *
 * Mutates `payload` in place; the returned object carries the same reference
 * so a caller can chain without reassigning. `reason` is one of:
 * `'injected'`, `'already-injected'`, `'no-text'`, `'shape-not-recognised'`,
 * `'inject-failed'` (a frozen or proxied body refused the write).
 *
 * @param {object} payload - the request body about to be posted
 * @param {'chat'|'messages'|'responses'} wire - which provider shape it is
 * @param {string} text - the prompt text, verbatim from `./prompts.js`
 * @returns {{payload: object, injected: boolean, reason: string}}
 */
export function injectSystem(payload, wire, text) {
  try {
    if (payload === null || typeof payload !== 'object') return result(payload, false, 'shape-not-recognised')
    if (typeof text !== 'string' || text === '') return result(payload, false, 'no-text')
    const segment = `${INJECT_MARKER}${SEP}${text}${SEP}${MARKER_END}`
    if (wire === 'chat') return injectChat(payload, segment)
    if (wire === 'messages') return injectMessages(payload, segment)
    if (wire === 'responses') return injectResponses(payload, segment)
    return result(payload, false, 'shape-not-recognised')
  } catch {
    // Fail-open: a frozen body (or one behind a proxy that throws on set) must
    // never fail the turn over a token-saving nicety.
    return result(payload, false, 'inject-failed')
  }
}

// ── shared helpers ───────────────────────────────────────────────────────────

const isSystem = message => message !== null && typeof message === 'object'
  && (message.role === 'system' || message.role === 'developer')

const isResponsesSystem = item => isSystem(item) && item.type === 'message'

/** Is the exact segment already present in a message's string or block content? */
function contentHasSegment(content, segment) {
  if (typeof content === 'string') return content.includes(segment)
  if (Array.isArray(content)) {
    return content.some(block => block !== null && typeof block === 'object'
      && typeof block.text === 'string' && block.text.includes(segment))
  }
  return false
}

/** Is a complete marker region present in a string or block content? */

// ── chat (OpenAI Chat Completions) ───────────────────────────────────────────

function injectChat(payload, segment) {
  const messages = payload.messages
  if (!Array.isArray(messages)) return result(payload, false, 'shape-not-recognised')
  if (messages.some(message => isSystem(message) && contentHasSegment(message.content, segment))) {
    return result(payload, false, 'already-injected')
  }
  const target = chatSystemMessage(messages)
  if (target === undefined) {
    messages.unshift({ role: 'system', content: segment })
    return result(payload, true, 'injected')
  }
  appendChatSegment(target, segment)
  return result(payload, true, 'injected')
}

/**
 * The message to append to.
 *
 * `messages[0]` is checked first because that is where `buildPayload` and the
 * sealed-lane pacing hint both keep the system turn; any later system or
 * developer turn is still preferred over adding a second one, which is the
 * upstream behaviour and keeps one system message per body.
 */
function chatSystemMessage(messages) {
  const first = messages[0]
  if (isSystem(first)) return first
  return messages.find(message => isSystem(message))
}

function appendChatSegment(message, segment) {
  const content = message.content
  if (typeof content === 'string') {
    message.content = content === '' ? segment : `${content}${SEP}${segment}`
    return
  }
  if (Array.isArray(content)) {
    content.push({ type: 'text', text: segment })
    return
  }
  message.content = segment
}

function injectMessages(payload, segment) {
  // An Anthropic body is identified by its `messages` list; the `system` field
  // is optional on this wire (`toClaudeMessages` reports `undefined` for an
  // empty system text), so an absent `system` is a shape to fill, not a
  // failure — but a body without `messages` is not a Messages body at all.
  if (!Array.isArray(payload.messages)) return result(payload, false, 'shape-not-recognised')
  const system = payload.system
  if (typeof system === 'string') {
    if (system.includes(segment)) return result(payload, false, 'already-injected')
    payload.system = system === '' ? segment : `${system}${SEP}${segment}`
    return result(payload, true, 'injected')
  }
  if (Array.isArray(system)) {
    if (system.some(block => block !== null && typeof block === 'object'
      && typeof block.text === 'string' && block.text.includes(segment))) {
      return result(payload, false, 'already-injected')
    }
    const block = { type: 'text', text: segment }
    // Insert *before* the last cache_control block, never after it. The
    // provider caches the prompt prefix up to that breakpoint, so text
    // appended past it would be the one part of the system prompt processed
    // and billed uncached on every turn — exactly the cost the injection
    // exists to avoid. Anchoring the new block inside the cached prefix keeps
    // the caller's breakpoint as the last block, so it still terminates the
    // list and the whole system prompt stays cache-eligible.
    let lastCached = -1
    for (let i = system.length - 1; i >= 0; i -= 1) {
      if (system[i]?.cache_control) { lastCached = i; break }
    }
    if (lastCached >= 0) system.splice(lastCached, 0, block)
    else system.push(block)
    return result(payload, true, 'injected')
  }
  if (system === undefined || system === null) {
    payload.system = segment
    return result(payload, true, 'injected')
  }
  return result(payload, false, 'shape-not-recognised')
}

function stripMessages(payload) {
  if (!Array.isArray(payload.messages)) return { payload, stripped: false, reason: 'shape-not-recognised' }
  const system = payload.system
  if (typeof system === 'string') {
    const cut = cutMarked(system)
    if (cut === null) return { payload, stripped: false, reason: 'not-injected' }
    // `toClaudeMessages` reports an empty system as `undefined`, never as `''`,
    // so an emptied field is restored by removing it.
    if (cut === '') delete payload.system
    else payload.system = cut
    return { payload, stripped: true, reason: 'stripped' }
  }
  if (Array.isArray(system)) {
    let changed = false
    for (let i = system.length - 1; i >= 0; i -= 1) {
      const block = system[i]
      if (block === null || typeof block !== 'object' || typeof block.text !== 'string') continue
      const cut = cutMarked(block.text)
      if (cut === null) continue
      changed = true
      if (cut === '') system.splice(i, 1)
      else block.text = cut
    }
    return { payload, stripped: changed, reason: changed ? 'stripped' : 'not-injected' }
  }
  return { payload, stripped: false, reason: 'not-injected' }
}

// ── responses (OpenAI Responses) ─────────────────────────────────────────────

function injectResponses(payload, segment) {
  // `instructions` is the dedicated field and wins when present, matching the
  // upstream dispatch: a body carrying both must not have its system text
  // split across two places.
  if (typeof payload.instructions === 'string') {
    if (payload.instructions.includes(segment)) return result(payload, false, 'already-injected')
    payload.instructions = payload.instructions === '' ? segment : `${payload.instructions}${SEP}${segment}`
    return result(payload, true, 'injected')
  }
  const input = payload.input
  if (!Array.isArray(input)) return result(payload, false, 'shape-not-recognised')
  if (input.some(item => isResponsesSystem(item) && contentHasSegment(item.content, segment))) {
    return result(payload, false, 'already-injected')
  }
  const target = input.find(item => isResponsesSystem(item))
  if (target === undefined) {
    input.unshift({ type: 'message', role: 'system', content: [{ type: 'input_text', text: segment }] })
  } else {
    appendResponsesSegment(target, segment)
  }
  return result(payload, true, 'injected')
}

function appendResponsesSegment(item, segment) {
  const content = item.content
  if (typeof content === 'string') {
    item.content = content === '' ? segment : `${content}${SEP}${segment}`
    return
  }
  if (Array.isArray(content)) {
    content.push({ type: 'input_text', text: segment })
    return
  }
  item.content = [{ type: 'input_text', text: segment }]
}
