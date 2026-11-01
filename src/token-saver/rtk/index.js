/**
 * RTK token saver: compact tool output inside an outgoing request body.
 *
 * A long agent turn is mostly tool output — diffs, listings, search results,
 * build logs — and almost all of it is redundancy a model does not need: paths
 * repeated per match, progress lines per compiled crate, hunk bodies far larger
 * than the change they describe. This module rewrites those blobs into the
 * compacted shapes the RTK tool defines, in place, just before the request is
 * handed to the provider.
 *
 * Three rules bound what may be touched:
 *
 * - Only tool *output* is compacted. System prompts, user turns and assistant
 *   text are hand-written context; rewriting them would change what the user
 *   asked for.
 * - Error results are never compacted (`is_error` on the Anthropic wire,
 *   `status: "error"` on Kiro's). An error trace is the model's only evidence
 *   of what failed; hiding it makes the model retry the same call, and the user
 *   pays for the loop.
 * - A blob is replaced only when the replacement is non-empty and strictly
 *   smaller. An empty tool result reads as "the tool printed nothing", which is
 *   a different fact than the one the tool reported, and a larger one costs the
 *   context it was meant to save.
 *
 * Every filter failure is fail-open: the original text is sent. This module
 * sits between the user's turn and the provider, so its worst acceptable
 * outcome is saving nothing.
 *
 * Two facts about this module's surface:
 *
 * - {@link module:src/token-saver/rtk/index.js~compressRequest} — the only
 *   production entry point, addressed by the three wires this plugin builds:
 *   `chat`, `messages`, `responses`.
 * - The original wire-agnostic `compressMessages` walk (OpenAI chat/responses
 *   items, Anthropic blocks, the Kiro conversationState shape) was removed on
 *   2026-11-01: nothing in production ever called it — the plugin only ever
 *   goes through `compressRequest`（审计确认）.
 *
 * @module src/token-saver/rtk/index.js
 */

import { RAW_CAP, MIN_COMPRESS_SIZE } from './constants.js'
import { autoDetectFilter } from './autodetect.js'
import { safeApply } from './applyFilter.js'


/**
 * Compact one text blob, adding the outcome to `stats`.
 *
 * The size gate lives here rather than in the filters so every shape shares it:
 * a blob under the minimum is left alone (markers would cost more than the
 * saving), a blob over the cap is left alone (regex over a runaway dump is pure
 * latency), and an unrecognised blob is left alone (no filter fits). When a
 * filter *does* run, its output still has to be non-empty and strictly smaller,
 * which is the last line of defence against a filter bug reaching the wire.
 *
 * Exported because callers holding a bare string (a tool result they built
 * themselves) should not have to wrap it in a fake message to compact it.
 *
 * @param {string} text - the candidate blob
 * @param {{bytesBefore:number, bytesAfter:number, hits:Array<{shape:string,filter:string,saved:number}>}} stats - mutated in place
 * @param {string} shape - the wire shape label recorded on a hit
 * @returns {string} the compacted text, or `text` unchanged
 */
export function compressText(text, stats, shape) {
  const bytesIn = text.length
  stats.bytesBefore += bytesIn

  if (bytesIn < MIN_COMPRESS_SIZE || bytesIn > RAW_CAP) {
    stats.bytesAfter += bytesIn
    return text
  }

  const fn = autoDetectFilter(text)
  if (!fn) {
    stats.bytesAfter += bytesIn
    return text
  }

  const out = safeApply(fn, text)

  // Safety: never return empty, never grow the input
  if (!out || out.length === 0 || out.length >= bytesIn) {
    stats.bytesAfter += bytesIn
    return text
  }

  stats.bytesAfter += out.length
  stats.hits.push({ shape, filter: fn.filterName || fn.name, saved: bytesIn - out.length })
  return out
}

// ── the host plugin's three wires ────────────────────────────────────────────
// （原 wire-agnostic 入口 compressMessages / compressKiroFormat 与日志辅助
// formatRtkLog 已于 2026-11-01 死代码清理中删除：生产只用 compressRequest，
// 看板汇总文案由 token-saver/index.js 的 describeSavingsTotal 负责。）

// ── the host plugin's three wires ────────────────────────────────────────────

/**
 * Compact one wire's tool output, in place.
 *
 * The payload is mutated and returned under `payload` (the same reference the
 * caller passed) because that is how this plugin's other request stages work —
 * they adjust the body they were handed rather than allocating a copy. Pass
 * `{ enabled: false }` (or `false`) as the third argument for a per-request off
 * switch: the payload is then returned untouched and `stats.enabled` is false,
 * so a caller can log the decision without a second code path.
 *
 * An unrecognised `wire` is a caller bug and compacts nothing; guessing a shape
 * would risk rewriting a field this module does not own.
 *
 * `stats.bytesBefore`/`bytesAfter` measure only the tool-output text that was
 * considered, not the whole request, and they always satisfy
 * `bytesBefore - bytesAfter === saved` with `saved` equal to the sum of
 * `hits[].saved`.
 *
 * @param {object} payload - the outgoing request body
 * @param {'chat'|'messages'|'responses'} wire - which dialect the body is in
 * @param {boolean|{enabled?:boolean}} [options=true] - per-request switch
 * @returns {{payload: object, stats: {enabled:boolean,bytesBefore:number,bytesAfter:number,saved:number,hits:Array<{shape:string,filter:string,saved:number}>}}}
 */
export function compressRequest(payload, wire, options = true) {
  const enabled = resolveEnabled(options)
  const stats = { enabled, bytesBefore: 0, bytesAfter: 0, saved: 0, hits: [] }
  if (!enabled) return { payload, stats }
  if (payload === null || typeof payload !== 'object') return { payload, stats }

  try {
    if (wire === 'chat') compressChatPayload(payload, stats)
    else if (wire === 'messages') compressMessagesPayload(payload, stats)
    else if (wire === 'responses') compressResponsesPayload(payload, stats)
  } catch (error) {
    console.warn('[rtk] compressRequest error:', error?.message ?? error)
    // A blob whose walk threw was counted as "before" but never as "after";
    // putting the books back in order keeps the stats invariant true even on
    // the failure path (the blob is treated as passed through untouched).
    stats.bytesAfter = stats.bytesBefore - stats.hits.reduce((sum, hit) => sum + hit.saved, 0)
  }

  stats.saved = stats.bytesBefore - stats.bytesAfter
  return { payload, stats }
}

/** `chat`: OpenAI Chat Completions — `{role:'tool'}` results, string or text blocks. */
function compressChatPayload(payload, stats) {
  const items = Array.isArray(payload.messages) ? payload.messages : []
  for (const msg of items) {
    if (!msg) continue
    // Assistant turns carry the model's own `tool_calls`; those arguments are
    // the model's input to the tool, not its output, and rewriting them would
    // change what the tool was asked to do.
    if (msg.role !== 'tool') continue
    if (typeof msg.content === 'string') {
      msg.content = compressText(msg.content, stats, 'openai-tool')
      continue
    }
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part && part.type === 'text' && typeof part.text === 'string') {
        part.text = compressText(part.text, stats, 'openai-tool-array')
      }
    }
  }
}

/** `messages`: Anthropic — `tool_result` blocks inside a user turn. */
function compressMessagesPayload(payload, stats) {
  const items = Array.isArray(payload.messages) ? payload.messages : []
  for (const msg of items) {
    if (!msg || !Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (!block || block.type !== 'tool_result') continue
      // An errored tool result is the model's only evidence of the failure.
      if (block.is_error === true) continue
      if (typeof block.content === 'string') {
        block.content = compressText(block.content, stats, 'claude-string')
        continue
      }
      if (!Array.isArray(block.content)) continue
      for (const part of block.content) {
        if (part && part.type === 'text' && typeof part.text === 'string') {
          part.text = compressText(part.text, stats, 'claude-array')
        }
      }
    }
  }
}

/** `responses`: OpenAI Responses — `function_call_output` items in `input`. */
function compressResponsesPayload(payload, stats) {
  const items = Array.isArray(payload.input) ? payload.input : []
  for (const item of items) {
    if (!item || item.type !== 'function_call_output') continue
    if (typeof item.output === 'string') {
      item.output = compressText(item.output, stats, 'openai-responses-string')
      continue
    }
    if (!Array.isArray(item.output)) continue
    for (const part of item.output) {
      if (part && part.type === 'input_text' && typeof part.text === 'string') {
        part.text = compressText(part.text, stats, 'openai-responses-array')
      }
    }
  }
}

/**
 * Normalise the third argument of {@link compressRequest}: a boolean, or an
 * options object whose `enabled` flag is honoured (anything but an explicit
 * `false` means on, so a missing option is the enabled default).
 */
function resolveEnabled(options) {
  if (options === undefined || options === null) return true
  if (typeof options === 'object') return options.enabled !== false
  return options !== false
}
