// @ts-check
/**
 * The `<env>` block the free lane has to send, and where its working directory
 * comes from.
 *
 * Verified against the upstream by magpie
 * (`@magpie-community/opencode-zen-free-auth/provider.mjs`, `environment()` /
 * `addEnvironment()`, measured 2026-11): Zen's free tier accepts a request as
 * OpenCode's own only when the v2 User-Agent ({@link module:src/upstream~clientUserAgent})
 * **and** OpenCode's environment block are both present. Without the block the
 * day's allowance is tiny and is spent before 00:00 UTC, which surfaces as 429
 * FreeUsageLimitError — the same answer an old User-Agent gets.
 *
 * Three details are the whole gate, so none of them may drift:
 *
 * 1. the block is recognised by `/<env>\r?\n {2}Working directory: …\n…<\/env>/`
 *    — **two spaces**, which is what tells OpenCode's block from Claude Code's
 *    own `<env>\nWorking directory: …` (no indent). A host that sends the
 *    Claude Code shape still needs OpenCode's block added;
 * 2. the text is verbatim, `</env>` last, and the last line names
 *    `<tmp>/opencode` as the preferred temporary directory;
 * 3. `Working directory: unknown` is answered with 429 at once, so a directory
 *    that cannot be read from the conversation falls back to `homedir()` — never
 *    to a placeholder.
 *
 * @module src/environment.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * OpenCode's block, as the upstream recognises it.
 *
 * ⚠️ 两个空格是判据的一部分（magpie `provider.mjs:467`）：删掉缩进就等于没有块。
 */
export const HAS_ENVIRONMENT = /<env>\r?\n {2}Working directory: [^\n]*\n[\s\S]*?<\/env>/

/**
 * How an agent names its working directory: Codex's `<cwd>`, Claude Code's and
 * others' `Working directory:`, Kimi's "The current working directory is `…`".
 * Only an absolute path counts (magpie `provider.mjs:472-476`).
 */
const ABSOLUTE = String.raw`((?:~?\/|[A-Za-z]:[\\/]|\\\\)[^\s\x60'"<>]*)`
const STATED_DIRECTORY = [
  new RegExp(String.raw`<cwd>\s*${ABSOLUTE}\s*</cwd>`),
  new RegExp(String.raw`working directory(?: is)?:?\s+\x60?${ABSOLUTE}`, 'i'),
]

/** Text of a wire content field: a bare string, or a block list's `text` blocks. */
export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * The texts a directory can be read from, user turns first.
 *
 * The user's own sentence about where it works is the best evidence (it is the
 * directory the tools actually run in), the system prompt is the fallback.
 */
export function statedTextsOfMessages(messages) {
  const users = []
  const others = []
  for (const message of messages ?? []) {
    const text = textOfContent(message?.content)
    if (text === '') continue
    if (message?.role === 'user') users.push(text)
    else others.push(text)
  }
  return [...users, ...others]
}

/** `~/work` → `/home/me/work`; anything else is left as written. */
function expandHome(value) {
  return value.replace(/^~(?=\/|$)/, os.homedir())
}

/**
 * The first absolute working directory named in `texts`, or `undefined`.
 *
 * A bare `/` and `~/` are not a working directory, and a trailing sentence mark
 * is not part of the path.
 */
export function statedDirectory(texts) {
  for (const text of texts ?? []) {
    if (typeof text !== 'string' || text === '') continue
    for (const pattern of STATED_DIRECTORY) {
      const found = pattern.exec(text)?.[1]?.replace(/[.,;:)\]]+$/, '')
      if (found && found !== '/' && found !== '~/') return expandHome(found)
    }
  }
  return undefined
}

/** The directory as the filesystem spells it (symlinks resolved when it exists). */
function localDirectory(directory) {
  const expanded = expandHome(directory)
  try {
    return fs.realpathSync(expanded)
  } catch {
    return expanded
  }
}

/**
 * The nearest directory up from `directory` that holds a `.git`, as OpenCode
 * finds its repository — a plain `stat`, no subprocess.
 */
function repositoryRoot(directory) {
  let dir = directory
  for (;;) {
    try {
      if (fs.statSync(path.join(dir, '.git'))) return dir
    } catch { /* no .git here: keep walking up */ }
    const up = path.dirname(dir)
    if (up === dir) return undefined
    dir = up
  }
}

/** OpenCode's own temporary folder, as its block names it (system tmp, resolved). */
function opencodeTmp() {
  try {
    return path.join(fs.realpathSync(os.tmpdir()), 'opencode')
  } catch {
    return path.join(os.tmpdir(), 'opencode')
  }
}

/**
 * OpenCode's block for `directory`, verbatim (magpie `environment()`).
 *
 * The upstream compares the shape, not the paths: sending a different directory
 * is fine, sending the block in another form is not.
 */
export function environmentBlock(directory = os.homedir()) {
  const local = localDirectory(directory)
  const root = repositoryRoot(local)
  return [
    'Here is some useful information about the environment you are running in:',
    '<env>',
    `  Working directory: ${directory}`,
    `  Workspace root folder: ${root !== undefined && root !== local ? root : directory}`,
    `  Is directory a git repo: ${root === undefined ? 'no' : 'yes'}`,
    `  Platform: ${process.platform}`,
    `  Prefer ${opencodeTmp()} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`,
    '</env>',
  ].join('\n')
}

/**
 * `systemText` with OpenCode's block appended, unless it already carries one.
 *
 * Appended at the end so the host's own system prompt (the cacheable prefix)
 * stays byte-identical: the block is the only thing that grows.
 */
export function withEnvironment(systemText, texts) {
  const base = typeof systemText === 'string' ? systemText : ''
  if (HAS_ENVIRONMENT.test(base)) return base
  const block = environmentBlock(statedDirectory(texts) ?? os.homedir())
  return base === '' ? block : `${base}\n\n${block}`
}

/**
 * 把块补进 Responses 的 `instructions`（那是它的 system 通道）。
 *
 * ⚠️ 2026-11-27：原先只补了 chat 与 messages 两条 wire，**responses 一条漏了** ——
 * 免费车道里走 responses 的模型因此一直缺块，等于白改。判据同 chat：块已在
 * （`instructions` 或任一 input system 项）就不重复加。
 */
export function addEnvironmentToResponses(body, texts) {
  const instructions = typeof body?.instructions === 'string' ? body.instructions : ''
  const input = Array.isArray(body?.input) ? body.input : []
  const carried = input.some(item => HAS_ENVIRONMENT.test(textOfContent(item?.content)))
  if (carried || HAS_ENVIRONMENT.test(instructions)) return body
  const block = environmentBlock(statedDirectory(texts) ?? os.homedir())
  body.instructions = instructions === '' ? block : `${instructions}\n\n${block}`
  return body
}

/**
 * Put OpenCode's block on a **Chat** wire body, in place.
 *
 * The block goes at the end of the *last* system message, so the body keeps one
 * system turn in the position the host put it (and the saver/injection passes
 * that follow still find it where they look). A body with no system turn gets
 * one, holding only the block.
 */
export function addEnvironmentToChat(body, texts) {
  const messages = Array.isArray(body?.messages) ? body.messages : (body.messages = [])
  const systems = messages.filter(message => message?.role === 'system' || message?.role === 'developer')
  // Already OpenCode's (an agent preset that ships it): keep the host's own.
  if (systems.some(message => HAS_ENVIRONMENT.test(textOfContent(message.content)))) return body
  const block = environmentBlock(statedDirectory(texts) ?? os.homedir())
  const last = systems[systems.length - 1]
  if (last === undefined) {
    messages.unshift({ role: 'system', content: block })
    return body
  }
  if (Array.isArray(last.content)) {
    last.content = [...last.content, { type: 'text', text: block }]
    return body
  }
  last.content = typeof last.content === 'string' && last.content !== '' ? `${last.content}\n\n${block}` : block
  return body
}