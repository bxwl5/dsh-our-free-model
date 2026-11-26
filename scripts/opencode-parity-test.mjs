/**
 * The OpenCode v2 fingerprint exists twice — once in this plugin's own free lane
 * (`src/upstream.js`) and once in the vendored channel pack
 * (`vendor/channel-pack/src/opencode*.ts`), because the pack is upstream's code
 * and cannot import ours. Two copies of a fingerprint that must be
 * byte-identical is exactly the shape that rots: one side gets the next upstream
 * change and the other keeps answering 403 FreeTierError.
 *
 * This suite is the drift guard. It imports both implementations and asserts
 * they agree on the four things the gate reads: the tool names, the tool
 * definitions themselves, the User-Agent, and the header set (including the v1
 * header neither may send).
 *
 * Run: node scripts/opencode-parity-test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const undiciStub = new URL('./lib/undici-stub.mjs', import.meta.url).href
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    if (specifier === 'undici') return { url: undiciStub, shortCircuit: true }
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const target = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (fs.existsSync(target)) return { url: target.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) return {
      format: 'module', shortCircuit: true,
      source: stripTypeScriptTypes(fs.readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform', sourceUrl: url }),
    }
    return nextLoad(url, context)
  },
})

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`}`)
}

try {
  const up = await import('../src/upstream.js')
  const messages = await import('../vendor/channel-pack/src/opencode-messages.ts')
  const product = await import('../vendor/channel-pack/src/opencode-product.ts')
  const identity = await import('../vendor/channel-pack/src/opencode.ts')

  const chatShape = tools => tools.map(tool => tool.function ?? tool)
  const laneBody = {}
  up.applyFingerprint(laneBody, false)
  const laneTools = chatShape(laneBody.tools)
  const packBody = messages.buildOpencodePayloadWithToolMap({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }] }).payload
  const packTools = chatShape(packBody.tools)

  console.log('=== 1. the gate names agree ===')
  check('gate names', [...messages.FREE_LANE_GATE_TOOLS], [...up.FINGERPRINT_TOOLS])
  check('the pack injects both', packTools.map(tool => tool.name), ['read', 'shell'])
  check('the lane injects both', laneTools.map(tool => tool.name), ['read', 'shell'])

  console.log('\n=== 2. the injected definitions are identical, verbatim ===')
  for (const name of ['read', 'shell']) {
    const lane = laneTools.find(tool => tool.name === name)
    const pack = packTools.find(tool => tool.name === name)
    check(`${name}: description`, pack.description, lane.description)
    check(`${name}: parameters`, JSON.stringify(pack.parameters), JSON.stringify(lane.parameters))
  }

  console.log('\n=== 3. the User-Agent is the canonical v2 token, at the newest version ===')
  const v2Ua = /^opencode\/[a-z0-9-]+\/(\d+)\.(\d+)\.(\d+)\/[a-z0-9-]+$/i
  const laneUa = v2Ua.exec(up.CLIENT_UA)
  // The lane keeps its own constant; this suite only guards the shape on that side,
  // because the version is what rots (Zen answers 429 to an old one since 2026-10-26).
  check('the lane sends a v2 token', laneUa === null ? undefined : Number(laneUa[1]) >= 2, true)
  // The pack's fallback is the version @opencode/cli 2.2.5 really sent (magpie's
  // measurement); it is raised whenever OpenCode's updater names a newer one.
  check('the pack falls back to the measured token', product.OPENCODE.defaultUserAgent, 'opencode/latest/2.2.5/cli')
  check('a detected v1 install version is refused', identity.opencodeUserAgentForVersion('1.18.31'), undefined)
  check('a detected 1.19 install version is refused too', identity.opencodeUserAgentForVersion('1.19.0'), undefined)
  check('the measured version becomes the v2 shape', identity.opencodeUserAgentForVersion('2.2.5'), 'opencode/latest/2.2.5/cli')
  check('a detected v2 install version becomes the v2 shape', identity.opencodeUserAgentForVersion('2.0.29'), 'opencode/latest/2.0.29/cli')
  check('an arbitrary UA override falls back to the token', identity.opencodeUserAgent('opencode/1.18.31'), product.OPENCODE.defaultUserAgent)
  check('a v2 override passes through', identity.opencodeUserAgent('opencode/latest/2.0.29/desktop'), 'opencode/latest/2.0.29/desktop')
  if (up.CLIENT_UA !== product.OPENCODE.defaultUserAgent) {
    console.log(`note the lane's own constant (src/upstream.js CLIENT_UA) is still ${up.CLIENT_UA}`)
  }

  console.log('\n=== 3b. the version probe only ever takes a newer release ===')
  const jsonAnswer = (body, status = 200) => async () => new Response(JSON.stringify(body), { status })
  const probeFetcher = (answer) => {
    const calls = []
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return answer(url) }
    return { calls, fetchImpl }
  }
  identity.resetOpencodeVersionCache()
  const newerProbe = probeFetcher(jsonAnswer({ version: '2.3.0' }))
  check('a newer release is taken', await identity.probeOpencodeVersion(newerProbe.fetchImpl), '2.3.0')
  check('the probe asks ?current=<the version in use>', newerProbe.calls[0]?.url, 'https://opencode.ai/update/api/latest/cli/npm?current=2.2.5')
  check('the probe refuses redirects', newerProbe.calls[0]?.init?.redirect, 'error')
  check('a stale mirror is refused', await identity.probeOpencodeVersion(probeFetcher(jsonAnswer({ version: '2.0.26' })).fetchImpl), undefined)
  check('the version already in use is not an update', await identity.probeOpencodeVersion(probeFetcher(jsonAnswer({ version: '2.2.5' })).fetchImpl), undefined)
  check('a non-release version is refused', await identity.probeOpencodeVersion(probeFetcher(jsonAnswer({ version: '2.2' })).fetchImpl), undefined)
  check('an error status falls back to the constant', await identity.probeOpencodeVersion(probeFetcher(jsonAnswer({ error: 'boom' }, 500)).fetchImpl), undefined)
  check('a thrown fetch falls back to the constant', await identity.probeOpencodeVersion(async () => { throw new Error('offline') }), undefined)

  console.log('\n=== 3c. local probe and remote probe agree on the newest of them ===')
  check('the newer local version wins', identity.newestOpencodeUserAgent('2.4.1', '2.3.0'), 'opencode/latest/2.4.1/cli')
  check('the newer remote version wins', identity.newestOpencodeUserAgent('2.1.0', '2.3.0'), 'opencode/latest/2.3.0/cli')
  check('a v1 local probe never wins', identity.newestOpencodeUserAgent('1.19.0'), 'opencode/latest/2.2.5/cli')
  check('nothing to go on keeps the constant', identity.newestOpencodeUserAgent(), 'opencode/latest/2.2.5/cli')
  identity.resetOpencodeVersionCache()
  check('a resolved UA takes the newer of local and remote', await identity.resolveOpencodeUserAgent(probeFetcher(jsonAnswer({ version: '2.3.0' })).fetchImpl, 'opencode/latest/2.1.0/cli'), 'opencode/latest/2.3.0/cli')
  identity.resetOpencodeVersionCache()
  check('an offline probe keeps the local UA', await identity.resolveOpencodeUserAgent(async () => { throw new Error('offline') }, 'opencode/latest/2.4.0/cli'), 'opencode/latest/2.4.0/cli')
  identity.resetOpencodeVersionCache()
  const cachedProbe = probeFetcher(jsonAnswer({ version: '2.3.0' }))
  await identity.cachedOpencodeVersion(cachedProbe.fetchImpl, { now: 1_000 })
  await identity.cachedOpencodeVersion(cachedProbe.fetchImpl, { now: 2_000 })
  check('a successful probe is cached', cachedProbe.calls.length, 1)
  await identity.cachedOpencodeVersion(cachedProbe.fetchImpl, { now: 1_000 + product.OPENCODE.versionTtlMs + 1 })
  check('the cache expires after the product TTL', cachedProbe.calls.length, 2)
  identity.resetOpencodeVersionCache()

  console.log('\n=== 4. the header sets agree, and neither sends the v1 request header ===')
  const session = 'ses_0123456789abABCDEFGHIJKLMN'
  const laneHeaders = up.gatewayHeaders({ session, stream: true })
  const packHeaders = identity.opencodeHeaders({ projectId: 'a'.repeat(40), generation: 1 }, session, up.CLIENT_UA)
  for (const name of ['x-opencode-session', 'x-opencode-session-id', 'x-session-affinity', 'x-session-id']) {
    check(`both send ${name}`, [laneHeaders[name], packHeaders[name]], [session, session])
  }
  check('both report the cli client', [laneHeaders['x-opencode-client'], packHeaders['x-opencode-client']], ['cli', 'cli'])
  check('both carry the v2 UA', [laneHeaders['user-agent'], packHeaders['user-agent']], [up.CLIENT_UA, up.CLIENT_UA])
  check('neither sends x-opencode-request', ['x-opencode-request' in laneHeaders, 'x-opencode-request' in packHeaders], [false, false])

  console.log('\n=== 5. the channel pack lists the free models this change added ===')
  const free = new Map(product.OPENCODE_FALLBACK_MODELS.map(model => [model.id, model]))
  check('deepseek-v4.1-flash-free is free and reachable', [free.has('deepseek-v4.1-flash-free'), free.get('deepseek-v4.1-flash-free')?.isFree], [true, true])
  check('glm-5.3-flash-free is free and reachable', [free.has('glm-5.3-flash-free'), free.get('glm-5.3-flash-free')?.isFree], [true, true])
  check('both carry a positive context window', [free.get('deepseek-v4.1-flash-free').contextWindow > 0, free.get('glm-5.3-flash-free').contextWindow > 0], [true, true])

  console.log('\n=== 6. a caller tool on a gate name is aliased on both sides ===')
  const conflict = { type: 'function', function: { name: 'read', description: 'the caller read', parameters: { type: 'object', properties: { x: { type: 'string' } } } } }
  const laneConflict = { tools: [conflict] }
  const laneMap = up.applyFingerprint(laneConflict, false)
  check('the lane aliases it', up.restoreToolName('read_client', laneMap), 'read')
  const packConflict = messages.buildOpencodePayloadWithToolMap({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'read', description: 'the caller read', parameters: { type: 'object', properties: { x: { type: 'string' } } } }] })
  check('the pack aliases it', packConflict.toolNameMap.get('read_client'), 'read')
  check('the pack keeps one official read', packConflict.payload.tools.filter(tool => tool.function?.name === 'read').length, 1)

  // The alias has to reach the conversation history too, not just the declaration
  // list: the model reads its own earlier `read` call as a call to the official
  // tool of that name otherwise, and the two definitions disagree. Both sides
  // must rewrite the same rows — this is the drift the suite exists to catch.
  console.log('\n=== 6b. an aliased tool is renamed in the history on both sides ===')
  const history = [
    { role: 'user', content: 'do it' },
    { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
  ]
  const laneHistory = { tools: [conflict], messages: JSON.parse(JSON.stringify(history)) }
  up.applyFingerprint(laneHistory, false)
  const laneName = laneHistory.messages.find(message => Array.isArray(message.tool_calls))?.tool_calls?.[0]?.function?.name
  check('the lane rewrites the prior call', laneName, 'read_client')
  const packHistory = messages.buildOpencodePayloadWithToolMap({ model: 'big-pickle', messages: JSON.parse(JSON.stringify(history)), tools: [{ name: 'read', description: 'the caller read', parameters: { type: 'object', properties: { x: { type: 'string' } } } }] })
  const packName = packHistory.payload.messages.find(message => Array.isArray(message.tool_calls))?.tool_calls?.[0]?.function?.name
  check('the pack rewrites the prior call', packName, 'read_client')
  check('both sides agree on the history spelling', packName, laneName)

  console.log('\n=== 7. neither side sends tool_choice none ===')
  const laneNone = { tools: [], tool_choice: 'none' }
  up.applyFingerprint(laneNone, false)
  check('the lane drops it', laneNone.tool_choice, undefined)
  const packNone = messages.ensureFreeLaneShape({ messages: [{ role: 'user', content: 'hi' }], tools: [], tool_choice: 'none' })
  check('the pack drops it', packNone.tool_choice, undefined)

  console.log('\n=== 8. the channel pack clamps an effort onto the model\'s declared levels ===')
  const adapter = await import('../vendor/channel-pack/src/opencode-adapter.ts')
  const cap = (id, efforts) => ({ id, name: id, modalities: ['text'], contextWindow: 200000, maxOutputTokens: 64000, reasoning: efforts.length > 0, efforts, toolCall: true, isFree: true })
  const deepseek = cap('deepseek-v4.1-flash-free', ['low', 'high', 'max'])
  const toggleOnly = cap('longcat-2.5-preview-free', [])
  check('a declared level goes out unchanged', adapter.resolveOpencodeEffort('deepseek-v4.1-flash-free', 'high', [deepseek]), { effort: 'high', outcome: 'exact' })
  // xhigh(7) is nearest to max(8) among low(3)/high(5)/max(8).
  check('an undeclared level lands on the nearest declared one', adapter.resolveOpencodeEffort('deepseek-v4.1-flash-free', 'xhigh', [deepseek]), { effort: 'max', outcome: 'mapped' })
  // medium(4) sits between low(3) and high(5); the ladder breaks the tie upward.
  check('a tie resolves to the stronger level', adapter.resolveOpencodeEffort('deepseek-v4.1-flash-free', 'medium', [deepseek]), { effort: 'high', outcome: 'mapped' })
  check('a model that declares no menu drops the field', adapter.resolveOpencodeEffort('longcat-2.5-preview-free', 'low', [toggleOnly]), { outcome: 'dropped' })
  check('an unknown model passes the caller value through', adapter.resolveOpencodeEffort('never-seen', 'high', []), { effort: 'high', outcome: 'passthrough' })
  check('no effort asked for, nothing sent', adapter.resolveOpencodeEffort('deepseek-v4.1-flash-free', undefined, [deepseek]), { outcome: 'passthrough' })

  console.log('\n=== 9. the <env> block is OpenCode\'s own, verbatim ===')
  const env = await import('../vendor/channel-pack/src/opencode-environment.ts')
  const BLOCK_OPTIONS = { home: '/home/kuye', platform: 'linux', tmp: '/tmp/opencode' }
  const blockFor = (directory) => [
    'Here is some useful information about the environment you are running in:',
    '<env>',
    `  Working directory: ${directory}`,
    `  Workspace root folder: ${directory}`,
    '  Is directory a git repo: no',
    '  Platform: linux',
    '  Prefer /tmp/opencode over generic system temporary directories such as /tmp; it is pre-created and approved for external access.',
    '</env>',
  ].join('\n')
  check('the block is OpenCode 2.2.5\'s, word for word', env.buildOpencodeEnvironment('/home/kuye/proj', BLOCK_OPTIONS), blockFor('/home/kuye/proj'))
  check('its directory line is indented by two spaces', /<env>\n {2}Working directory: /.test(env.buildOpencodeEnvironment('/x', BLOCK_OPTIONS)), true)
  check('it closes with </env>', env.buildOpencodeEnvironment('/x', BLOCK_OPTIONS).endsWith('\n</env>'), true)
  check('OpenCode\'s own block counts as already there', env.hasOpencodeEnvironment(blockFor('/home/kuye/proj')), true)
  const claudeBlock = 'Here is useful information about the environment you are running in:\n<env>\nWorking directory: /home/kuye/proj\n</env>'
  check('Claude Code\'s block (no two-space indent) is not OpenCode\'s', env.hasOpencodeEnvironment(claudeBlock), false)
  check('an <ENV> in another case is not OpenCode\'s', env.hasOpencodeEnvironment('<ENV>\n  Working directory: /x\n</ENV>'), false)

  console.log('\n=== 10. only the anonymous slot gets the block, at a real absolute directory ===')
  const anonymous = { ...BLOCK_OPTIONS, slotKind: 'anonymous' }
  const codex = { model: 'big-pickle', messages: [{ role: 'user', content: 'fix it; <cwd>/home/kuye/proj</cwd>' }] }
  check('the anonymous slot gets the block', env.addOpencodeEnvironment(codex, anonymous), true)
  check('the block is a system message ahead of the user turn', [codex.messages[0].role, codex.messages[0].content], ['system', blockFor('/home/kuye/proj')])
  check('the user turn is kept as it was', codex.messages[1].content, 'fix it; <cwd>/home/kuye/proj</cwd>')
  const stated = /^ {2}Working directory: (.+)$/m.exec(codex.messages[0].content)?.[1]
  check('its directory is a real absolute path', stated !== undefined && stated.startsWith('/'), true)
  check('its directory is never a placeholder', stated !== 'unknown' && stated !== '/' && stated !== '', true)
  check('a second call is a no-op', env.addOpencodeEnvironment(codex, anonymous), false)

  // Claude Code's own block stays, OpenCode's follows it: taking another agent's
  // block for OpenCode's is what sent Claude Code to a 429 while Pi was served.
  const claude = { messages: [{ role: 'system', content: claudeBlock }, { role: 'user', content: 'go' }] }
  check('another agent\'s block does not count, so the block is added', env.addOpencodeEnvironment(claude, anonymous), true)
  check('OpenCode\'s block follows the agent\'s own', claude.messages[0].content, `${claudeBlock}\n\n${blockFor('/home/kuye/proj')}`)

  // Appended to the last system message, never anchored at the front (the front
  // is the cached prefix).
  const multi = { messages: [{ role: 'system', content: 'A' }, { role: 'user', content: 'hi' }, { role: 'system', content: 'B' }] }
  check('the block is added once', env.addOpencodeEnvironment(multi, anonymous), true)
  check('the earlier system message is untouched', multi.messages[0].content, 'A')
  check('it is appended to the last system message', multi.messages[2].content, `B\n\n${blockFor('/home/kuye')}`)
  check('the user turn stays between them', [multi.messages[0].role, multi.messages[1].role, multi.messages[2].role], ['system', 'user', 'system'])

  // No directory stated anywhere: the home folder, never a placeholder (Zen
  // answers 429 at once to the literal line `Working directory: unknown`).
  const bare = { messages: [{ role: 'user', content: 'hello' }] }
  check('the block is added with no directory stated', env.addOpencodeEnvironment(bare, anonymous), true)
  check('it falls back to the home folder', bare.messages[0].content, blockFor('/home/kuye'))
  check('the word unknown never appears', /\bunknown\b/.test(bare.messages[0].content), false)

  // The three ways agents name their directory all reach the block.
  const kimi = { messages: [{ role: 'user', content: 'The current working directory is `/home/kuye/kimi`' }] }
  env.addOpencodeEnvironment(kimi, anonymous)
  check('Kimi\'s phrasing names the directory', /^ {2}Working directory: \/home\/kuye\/kimi$/m.test(kimi.messages[0].content), true)

  const tilde = { messages: [{ role: 'user', content: 'working directory: ~/proj' }] }
  env.addOpencodeEnvironment(tilde, anonymous)
  check('a ~ path is expanded to an absolute one', /^ {2}Working directory: \/home\/kuye\/proj$/m.test(tilde.messages[0].content), true)

  // A directory that really is a git repository is said to be one, and its
  // working directory is the stated path byte for byte.
  const here = { messages: [{ role: 'user', content: `<cwd>${process.cwd()}</cwd>` }] }
  check('the block is added for a real directory', env.addOpencodeEnvironment(here, anonymous), true)
  check('a git repository is reported as one', /^ {2}Is directory a git repo: yes$/m.test(here.messages[0].content), true)
  check('the directory is the stated path', /^ {2}Working directory: (.+)$/m.exec(here.messages[0].content)?.[1], process.cwd())

  // The channel's own system prompt rides the top-level `system` field; it is not
  // a system *message*, so the block goes into one of those.
  const withSystemField = { model: 'big-pickle', system: 'you are dsh', messages: [{ role: 'user', content: 'hi' }] }
  check('the top-level system field does not count as a system message', env.addOpencodeEnvironment(withSystemField, anonymous), true)
  check('the block lands in a system message', withSystemField.messages[0].content, blockFor('/home/kuye'))
  check('the system field is untouched', withSystemField.system, 'you are dsh')

  console.log('\n=== 11. the account slot\'s body is byte-identical ===')
  const account = { model: 'big-pickle', system: 'you are dsh', messages: [{ role: 'user', content: '<cwd>/home/kuye/proj</cwd>' }] }
  const accountBefore = JSON.stringify(account)
  check('an account slot is never touched', env.addOpencodeEnvironment(account, { ...anonymous, slotKind: 'account' }), false)
  check('its body is byte-identical', JSON.stringify(account), accountBefore)
} finally {
  hooks.deregister()
}

console.log(failures === 0 ? '\nall opencode parity checks passed' : `\n${failures} opencode parity check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
