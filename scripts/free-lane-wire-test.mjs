/**
 * The free lane's wire facts, re-measured against the live gateway on 2026-10-14,
 * re-checked against the **v2** client fingerprint on 2026-10-16, and re-checked
 * against the session-encoding gate on 2026-10-17.
 *
 * These are the things that changed and that a future edit can silently break:
 * the lane's base path, the four session headers, the shape *and encoding* of
 * the session id, the User-Agent (now the canonical v2 token and nothing else,
 * at the newest release the updater names), the OpenCode `<env>` block both wires
 * must carry, and the absence of the v1-only `x-opencode-request` header. The
 * tool gate's own contract lives in `fingerprint-test.mjs`.
 *
 * Run: node scripts/free-lane-wire-test.mjs
 */

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-wire-'))
process.env.DSH_HOME = scratch

const seen = []
const server = http.createServer((req, res) => {
  const pieces = []
  req.on('data', piece => pieces.push(piece))
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(pieces).toString('utf8') })
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [] }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
server.unref()

// A fake OpenCode updater: `/version/<answer>` says `{version: <answer>}`, and
// `/version/error`, `/version/redirect` exercise the two failure shapes.
const versionCalls = []
const versionServer = http.createServer((req, res) => {
  versionCalls.push(req.url)
  const answer = decodeURIComponent(req.url.split('?')[0].replace(/^\/version\//, ''))
  if (answer === 'redirect') {
    res.writeHead(302, { location: '/version/9.9.9' })
    res.end()
    return
  }
  if (answer === 'error') {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end('{"error":"boom"}')
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ version: answer }))
})
await new Promise(resolve => versionServer.listen(0, '127.0.0.1', resolve))
versionServer.unref()
const versionBase = `http://127.0.0.1:${versionServer.address().port}/version/`
process.env.OUR_FREE_MODEL_BASE = `http://127.0.0.1:${server.address().port}`

const up = await import('../src/upstream.js')
const { postStreamed, getJson } = await import('../src/http.js')

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`}`)
}
const declared = (body, name) => (body.tools ?? []).find(tool => (tool.function?.name ?? tool.name) === name)

console.log('=== 1. the lane lives under /inference/v1 ===')
{
  check('chat model', up.endpointFor('cat-jam-free'), '/inference/v1/chat/completions')
  check('responses model', up.endpointFor('muse-spark-1.3-contributor-free'), '/inference/v1/responses')
  check('messages model', up.endpointFor('union-alpha'), '/inference/v1/messages')
  check('wire for chat', up.wireFor('cat-jam-free'), 'chat')
  check('wire for responses', up.wireFor('muse-spark-1.3-contributor-free'), 'responses')
  check('wire for messages', up.wireFor('union-alpha'), 'messages')
}

console.log('\n=== 2. the four v2 session headers, and no v1-only request header ===')
{
  const session = 'ses_0123456789abABCDEFGHIJKLMN'
  const headers = up.gatewayHeaders({ session, stream: true })
  check('pooled credential', headers.authorization, 'Bearer public')
  check('reported as the cli client', headers['x-opencode-client'], 'cli')
  check('session header', headers['x-opencode-session'], session)
  check('session-id header repeats it', headers['x-opencode-session-id'], session)
  check('session affinity repeats it', headers['x-session-affinity'], session)
  check('session id repeats it', headers['x-session-id'], session)
  // v1 sent `x-opencode-request`; v2 answers that header with 403 FreeTierError.
  check('no x-opencode-request', 'x-opencode-request' in headers, false)
  check('the User-Agent is the canonical v2 token', headers['user-agent'], 'opencode/latest/2.2.5/cli')
  check('streaming accept', headers.accept, 'text/event-stream')
}

console.log('\n=== 3. the session id must carry the descending encoding the gate accepts ===')
{
  const id = up.sessionForConversation('wire:conversation')
  check('canonical shape', up.SESSION_RE.test(id), true)
  // The gate validates the encoding, not only the `ses_…` shape (measured
  // 2026-10-17). The twelve hex digits are the 48-bit complement of
  // `ts_ms << 12 | counter`, so the counter reads as `0xfff - counter` and has
  // to land in 1–63 — low 12 bits inside 0xfc0–0xfff.
  const encoded = BigInt(`0x${id.slice(4, 16)}`)
  const counter = Number((~encoded) & 0xfffn)
  check('the encoding is descending', up.SESSION_DESCENDING_RE.test(id.slice(4, 16)), true)
  check('the counter stays in the accepted 1-63 window', counter > 0 && counter <= 63, true)
  check('one conversation, one session', up.sessionForConversation('wire:conversation'), id)
  check('another conversation, another session', up.sessionForConversation('wire:other') !== id, true)
  const saved = JSON.parse(fs.readFileSync(path.join(scratch, 'our-free-model', 'session-map.json'), 'utf8'))
  check('session mapping is persisted outside the user directory', saved.sessions['wire:conversation'], id)
  const caller = 'ses_ffffffffffffABCDEFGHIJKLMN'
  check('a canonical caller id passes through', up.sessionForConversation(caller), caller)
  // A caller id with the right shape but the wrong encoding is a 403 upstream,
  // so it must be re-encoded rather than forwarded (probed live 2026-10-17).
  const ascending = 'ses_123456789abcABCDEFGHIJKLMN'
  const reencoded = up.sessionForConversation(ascending)
  check('an ascending caller id is re-encoded', reencoded === ascending, false)
  check('and the re-encoded id is canonical', up.isCanonicalSession(reencoded), true)
  check('and it stays stable per conversation', up.sessionForConversation(ascending), reencoded)
}

console.log('\n=== 4. the v2 tool gate: read + shell, official definitions, no tool_choice none ===')
{
  const empty = { tool_choice: 'none' }
  up.applyFingerprint(empty, false)
  check('read is declared', declared(empty, 'read') !== undefined, true)
  check('shell is declared', declared(empty, 'shell') !== undefined, true)
  check('the read schema is the official one', declared(empty, 'read').function.parameters.required, ['path'])
  check('the shell schema is the official one', declared(empty, 'shell').function.parameters.required, ['command'])
  check('a caller tool_choice none is dropped', empty.tool_choice, undefined)

  const claude = {}
  up.applyFingerprint(claude, 'claude')
  check('Messages shape uses input_schema', declared(claude, 'read').input_schema.required, ['path'])

  // A caller tool that reuses a gate name with another definition moves aside,
  // and the response side still restores the caller's own spelling.
  const caller = { tools: [{ type: 'function', function: { name: 'read', description: 'the caller read', parameters: { type: 'object', properties: {} } } }] }
  const map = up.applyFingerprint(caller, false)
  check('only one declaration carries the gate name', caller.tools.filter(tool => tool.function.name === 'read').length, 1)
  check('…and it is the official definition', declared(caller, 'read').function.parameters.required, ['path'])
  check('the caller declaration survived under an alias', caller.tools.find(tool => tool.function.name === 'read_client').function.description, 'the caller read')
  check('…and the alias restores the caller name', up.restoreToolName('read_client', map), 'read')
}

console.log('\n=== 5. the User-Agent is the canonical v2 token, whatever the host attributes ===')
{
  // v2 matches the whole string against `opencode/<channel>/<version>/<client>`,
  // so the harness attribution cannot ride along any more: a v1 token is refused
  // by name, and a prefixed/suffixed string is no longer a v2 client.
  await postStreamed({
    path: up.endpointFor('cat-jam-free'),
    body: { model: 'cat-jam-free', messages: [{ role: 'user', content: 'ping' }], stream: true },
    session: up.sessionForConversation('wire:ua'),
    attributionUserAgent: 'deepseek-harness/0.1.7 (+https://github.com/deepseek-ai/deepseek-harness)',
    onData: () => {},
    timeoutMs: 5000,
  })
  const sent = seen[seen.length - 1]
  check('the request reached the chat path', sent.url, '/inference/v1/chat/completions')
  check('the refused token is gone', /deepseek[-_]harness/i.test(sent.headers['user-agent'] ?? ''), false)
  check('the UA is the canonical v2 token', sent.headers['user-agent'], up.CLIENT_UA)
  check('…and carries no attribution suffix', sent.headers['user-agent'].includes(' '), false)
  check('session-id went out', typeof sent.headers['x-opencode-session-id'] === 'string', true)
  check('the four session headers agree', [
    sent.headers['x-opencode-session'],
    sent.headers['x-session-affinity'],
    sent.headers['x-session-id'],
  ].every(value => value === sent.headers['x-opencode-session-id']), true)
  check('no v1 request header went out', 'x-opencode-request' in sent.headers, false)
}

console.log('\n=== 6. 目录请求与推理请求使用同一串 v2 UA ===')
{
  // The host still passes an attribution UA (its API is unchanged); the v2
  // fingerprint means this lane cannot put it on the wire.
  const attributionUserAgent = 'our-free-model-standalone/2.3.0'
  await getJson('/inference/v1/models', { attributionUserAgent })
  check('目录请求使用 v2 指纹 UA', seen.at(-1).headers['user-agent'], up.CLIENT_UA)
  await postStreamed({
    path: up.endpointFor('mimo-v2.6-flash-free'),
    body: { model: 'mimo-v2.6-flash-free', messages: [{ role: 'user', content: 'ping' }], stream: true },
    session: up.sessionForConversation('wire:standalone'),
    attributionUserAgent,
    onData: () => {},
    timeoutMs: 5000,
  })
  check('推理请求使用同一串', seen.at(-1).headers['user-agent'], up.CLIENT_UA)
  const unrelated = 'other-client/3.0 (+https://example.com/our-free-model-standalone)'
  await getJson('/inference/v1/models', { attributionUserAgent: unrelated })
  check('任何归属串都不再改变线上 UA', seen.at(-1).headers['user-agent'], up.CLIENT_UA)
}

console.log('\n=== 7. OpenCode\'s <env> block rides on both wires, verbatim ===')
{
  // Zen's free tier asks for the block as well as the UA (magpie, 2026-11):
  // without it the day's allowance is tiny and 429 runs out before 00:00 UTC.
  const { buildPayload } = await import('../src/adapter.js')
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-work-'))
  const prompt = 'You are a coding agent.'
  const told = { role: 'user', content: `The current working directory is \x60${workdir}\x60. Read task.md first.` }

  const chat = buildPayload('chat', 'cat-jam-free', [told], { system: prompt }, 1024, undefined, [])
  const chatSystem = chat.messages.find(message => message.role === 'system')
  check('the chat body has a system turn', chatSystem === undefined ? undefined : chatSystem.role, 'system')
  check('…it is the first turn', chat.messages[0].role, 'system')
  check('…it carries <env>', /<env>/.test(chatSystem.content), true)
  check('…with the two-space line the gate matches', /\n {2}Working directory: [^\n]*\n/.test(chatSystem.content), true)
  check('…naming the directory the user stated', /  Working directory: ([^\n]+)/.exec(chatSystem.content)?.[1], workdir)
  check('…and never the placeholder', /unknown/i.test(chatSystem.content), false)
  check('…the host prompt is still the prefix', chatSystem.content.startsWith(`${prompt}\n\nHere is some useful information`), true)
  check('…the block ends the system turn', chatSystem.content.trimEnd().endsWith('</env>'), true)
  check('…with the temporary-directory line', / {2}Prefer .*\/opencode over generic system temporary directories such as \/tmp;/.test(chatSystem.content), true)
  check('…and the user turn is untouched', /<env>/.test(String(chat.messages[1].content)), false)

  // The Messages wire assembles its system text in messages.js, before the body.
  const claude = buildPayload('messages', 'union-alpha', [
    { role: 'system', content: prompt },
    told,
  ], {}, 1024, undefined, [])
  check('the Messages wire carries the block too', /<env>/.test(claude.system ?? ''), true)
  check('…naming the stated directory', /  Working directory: ([^\n]+)/.exec(claude.system ?? '')?.[1], workdir)
  check('…and the host prompt is its prefix', (claude.system ?? '').startsWith(`${prompt}\n\n`), true)
}

console.log('\n=== 7b. a block that is already there is never doubled ===')
{
  const { buildPayload } = await import('../src/adapter.js')
  const opencode = [
    'Host prompt.',
    '',
    'Here is some useful information about the environment you are running in:',
    '<env>',
    '  Working directory: /opt/agent',
    '  Workspace root folder: /opt/agent',
    '  Is directory a git repo: no',
    '  Platform: linux',
    '  Prefer /tmp/opencode over generic system temporary directories such as /tmp; it is pre-created and approved for external access.',
    '</env>',
  ].join('\n')
  const told = { role: 'user', content: 'Working directory: /opt/agent' }
  // Through `options.system` (chat) and through a system message in the history (messages).
  const chat = buildPayload('chat', 'cat-jam-free', [told], { system: opencode }, 1024, undefined, [])
  const chatSystem = chat.messages.filter(message => message.role === 'system').map(message => message.content).join('\n')
  check('chat: one block, not two', (chatSystem.match(/<\/env>/g) ?? []).length, 1)
  check('chat: the host block is kept as written', /  Working directory: \/opt\/agent/.test(chatSystem), true)
  const carried = buildPayload('chat', 'cat-jam-free', [{ role: 'system', content: opencode }, told], {}, 1024, undefined, [])
  check('chat: a system message that carries it is not doubled', (carried.messages.map(message => message.content).join('\n').match(/<\/env>/g) ?? []).length, 1)
  const claude = buildPayload('messages', 'union-alpha', [{ role: 'system', content: opencode }, told], {}, 1024, undefined, [])
  check('messages: one block, not two', ((claude.system ?? '').match(/<\/env>/g) ?? []).length, 1)
}

console.log('\n=== 7c. Claude Code\'s own <env> is not taken for OpenCode\'s ===')
{
  const { buildPayload } = await import('../src/adapter.js')
  // Claude Code writes `Working directory:` with no indent, so the gate's own
  // pattern does not match it: the lane's block still has to be added.
  const claudeCode = 'You are Claude Code.\n\n<env>\nWorking directory: /opt/cc\nIs directory a git repo: yes\n</env>'
  const chat = buildPayload('chat', 'cat-jam-free', [{ role: 'user', content: 'hi' }], { system: claudeCode }, 1024, undefined, [])
  const content = chat.messages[0].content
  check('the unindented block is not recognised', (content.match(/<\/env>/g) ?? []).length, 2)
  check('…so the lane adds its own', /\n {2}Working directory: [^\n]*\n/.test(content), true)
  check('…and the Claude Code text is untouched', content.startsWith(claudeCode), true)
}

console.log('\n=== 8. the User-Agent follows the newest release, else the constant ===')
{
  const probeCount = () => seen.filter(entry => entry.url?.startsWith('/update/api/latest/cli/npm')).length
  up.resetClientVersion()
  const probes = probeCount()
  check('before any probe: the constant', up.clientUserAgent(), 'opencode/latest/2.2.5/cli')
  check('…and gatewayHeaders sends the same', up.gatewayHeaders({ session: 'ses_0123456789abABCDEFGHIJKLMN', stream: true })['user-agent'], 'opencode/latest/2.2.5/cli')
  // The background refresh only runs against the real upstream. This lane is
  // pointed at a stub, so asking would be pointless — and the getter must stay
  // silent, because it sits on the request path.
  for (let i = 0; i < 3; i += 1) up.clientUserAgent()
  await new Promise(resolve => setTimeout(resolve, 30))
  check('a lane pointed at a stub asks the updater nothing', probeCount(), probes)
  // The lane's own endpoint answers a body without a version: keep the constant.
  check('a body without a version keeps the constant', await up.refreshClientVersion(), undefined)
  check('the probe asks ?current=<the version in use>', seen.filter(entry => entry.url?.startsWith('/update/api/latest/cli/npm')).at(-1)?.url, '/update/api/latest/cli/npm?current=2.2.5')

  // A newer release is adopted and sent at once.
  check('a newer release is adopted', await up.refreshClientVersion(`${versionBase}2.5.0`), '2.5.0')
  check('…and the lane sends it', up.clientUserAgent(), 'opencode/latest/2.5.0/cli')
  check('…the probe carried the version in use', versionCalls.at(-1), '/version/2.5.0?current=2.2.5')

  // Older, malformed, failed and redirected answers are all ignored.
  check('a v1 release is never adopted', await up.refreshClientVersion(`${versionBase}1.19.0`), undefined)
  check('…the UA is unchanged', up.clientUserAgent(), 'opencode/latest/2.5.0/cli')
  check('a non-release string is refused', await up.refreshClientVersion(`${versionBase}2.5.0-beta`), undefined)
  check('a two-part version is refused', await up.refreshClientVersion(`${versionBase}2.6`), undefined)
  check('an error status changes nothing', await up.refreshClientVersion(`${versionBase}error`), undefined)
  check('a redirect is not followed', await up.refreshClientVersion(`${versionBase}redirect`), undefined)
  check('…and the adopted version still rides', up.clientUserAgent(), 'opencode/latest/2.5.0/cli')

  // A warm cache (or a reset) never asks again.
  up.resetClientVersion()
  const warm = probeCount()
  for (let i = 0; i < 3; i += 1) up.clientUserAgent()
  await new Promise(resolve => setTimeout(resolve, 30))
  check('a warm cache asks the updater nothing', probeCount(), warm)
  check('reset puts the constant back', up.clientUserAgent(), 'opencode/latest/2.2.5/cli')
}

versionServer.close()
server.close()
fs.rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nall wire checks passed' : `\n${failures} wire check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
