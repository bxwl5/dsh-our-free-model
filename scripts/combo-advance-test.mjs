/**
 * The combo chain's advance policy, driven through the real Adapter against a
 * local HTTP stand-in.
 *
 * The commit rule is the feature's whole contract, and it lives across two
 * files: `commitsAnswer` (what may not be taken back) and `advanceVerdict`
 * (what a candidate's failure must report so the chain may move on). The two
 * must agree on one definition of "answer": visible text or a streamed tool
 * call — never thinking. A model that burns a minute of reasoning and then
 * hits a quota wall is the single most valuable case to fail over, and these
 * scenarios pin it from both sides:
 *
 * - reasoning deltas, then an in-stream rate-limit refusal -> the chain moves
 *   to the next candidate and the caller never sees the held thinking;
 * - reasoning deltas, then a stream that ends cleanly with no finish token
 *   (closeAll's reasoning block-end must not commit either);
 * - visible text, then a refusal -> committed, the failure ends the turn;
 * - a refusal before any output -> the plain advance that always worked.
 *
 * Single-model checkpoint recovery is switched off (`streamRecovery: false`)
 * so the chain's own advance is the only recovery path a scenario can take.
 *
 * Run: node scripts/combo-advance-test.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import process from 'node:process'
import { chatFrames } from './lib/fake-kernel.mjs'

let activeCase
const TASK = 'COMBO_TASK_SENTINEL: answer the original question'
const ANSWER = 'VISIBLE_ANSWER_SENTINEL'
const sse = payload => `data: ${JSON.stringify(payload)}\n\n`
const reasoningFrames = text => [
  sse({ choices: [{ index: 0, delta: { reasoning: text } }] }),
  sse({ choices: [{ index: 0, delta: { reasoning: `${text} (part two)` } }] }),
].join('')

const server = http.createServer((req, res) => {
  const pieces = []
  req.on('data', piece => pieces.push(piece))
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(pieces).toString('utf8'))
    if (!JSON.stringify(body).includes(TASK)) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(chatFrames('healthy local boot probe'))
      return
    }
    const scenario = activeCase
    const ordinal = scenario.requests.length
    scenario.requests.push({ body, path: req.url })
    const answer = scenario.answers[ordinal] ?? { status: 500, body: '{"error":{"message":"unexpected extra request"}}' }
    if (answer.status !== undefined) {
      res.writeHead(answer.status, { 'content-type': 'application/json' })
      res.end(answer.body ?? '')
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(answer.body ?? '')
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
server.unref()
process.env.OUR_FREE_MODEL_BASE = `http://127.0.0.1:${server.address().port}`

const { FreeModelAdapter, ROUTE_MAIN } = await import('../src/adapter.js')
console.log('[probe] static fn type:', typeof FreeModelAdapter.classifyStreamOutcomes, '| url:', import.meta.url)
const { buildCatalog } = await import('../src/catalog.js')
const { buildComboCatalog, normalizeCombos, comboId, comboChain, advanceComboCursor } = await import('../src/combos.js')

const MODELS = ['deepseek-v4-flash-free', 'mimo-v2.5-free', 'mimo-v2.6-flash-free']
const COMBO_ID = 'combo:failover'
const CHINESE_NAME = '\u514d\u8d39\u4f18\u5148'
const COMBOS = normalizeCombos([
  { name: 'failover', models: ['deepseek-v4-flash-free', 'mimo-v2.5-free'], strategy: 'fallback', stickyLimit: 1 },
  { name: CHINESE_NAME, models: ['deepseek-v4-flash-free', 'mimo-v2.5-free'] },
  // Round-robin with a large sticky limit: the cursor is supposed to stay put
  // for `stickyLimit` turns, which is exactly the shape that used to make a
  // spent head look like "it keeps rotating back to the first member".
  { name: 'rotation', models: ['deepseek-v4-flash-free', 'mimo-v2.5-free', 'mimo-v2.6-flash-free'], strategy: 'round-robin', stickyLimit: 10 },
])
const ROTATION_ID = comboId('rotation')
const FREE_CATALOG = buildCatalog(MODELS)
const CATALOG = [...FREE_CATALOG, ...buildComboCatalog(COMBOS, FREE_CATALOG)]

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

function setup(answers, model = COMBO_ID) {
  const scenario = { answers, requests: [] }
  activeCase = scenario
  const turns = []
  const controller = new AbortController()
  const adapter = new FreeModelAdapter({
    state: () => ({
      catalog: CATALOG,
      membership: { [ROUTE_MAIN]: MODELS },
      settings: { enabled: true, defaultMaxTokens: 32768, streamRecovery: false },
      attributionUserAgent: 'offline-combo-advance-test',
    }),
    recordUsage: () => {},
    recordTurn: row => turns.push(row),
    warn: () => {},
  })
  const stream = adapter.stream({
    provider: ROUTE_MAIN,
    model,
    maxTokens: 4096,
    sessionId: 'combo-advance-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: TASK }] }],
    signal: controller.signal,
  })
  return { scenario, turns, controller, stream }
}

async function drive(answers, model) {
  const run = setup(answers, model)
  const chunks = []
  try {
    for await (const chunk of run.stream) chunks.push(chunk)
    return {
      ...run,
      chunks,
      finish: chunks.find(chunk => chunk.type === 'finish')?.reason,
      text: chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''),
    }
  } finally {
    run.controller.abort()
  }
}

const noThinking = chunks => chunks.every(chunk => chunk.type !== 'reasoning-delta'
  && !(chunk.type === 'block-end' && chunk.block?.type === 'reasoning'))

await check('non-Latin chain names survive normalization and a JSON settings round trip (#379)', () => {
  const names = [CHINESE_NAME, '\u5148\u514d\u8d39\u540e\u534f\u4ed8', '\u65e5\u672c\u8a9e', '\ud83d\ude80']
  const rows = normalizeCombos(names.map(name => ({ name, models: MODELS.slice(0, 2) })))
  assert.equal(rows.length, names.length)
  assert.equal(new Set(rows.map(row => row.id)).size, names.length)
  for (const [i, row] of rows.entries()) {
    assert.equal(row.name, names[i])
    assert.match(row.id, /^combo:[a-z0-9-]+$/)
    assert.equal(comboId(` ${names[i]} `), row.id, 'whitespace does not change identity')
  }
  assert.deepEqual(normalizeCombos(JSON.parse(JSON.stringify(rows))), rows)
  assert.equal(comboId('My Fast Chain'), 'combo:my-fast-chain', 'existing ASCII ids stay stable')
  assert.equal(comboId('  '), '', 'an empty name still has no identity')
})

await check('mixed-lane chains retain composite member ids and advertise the capability intersection (#372)', () => {
  const members = [
    { id: 'free-model', channel: 'free', vision: true, contextWindow: 131072, maxOutput: 16384 },
    { id: 'open_router/google/gemma:free', channel: 'aggregate', vision: false, contextWindow: 1000000, maxOutput: 32768 },
  ]
  const normalized = normalizeCombos([{ name: CHINESE_NAME, models: members.map(row => row.id) }])
  const [entry] = buildComboCatalog(normalized, members)
  assert.equal(entry.contextWindow, 131072)
  assert.equal(entry.maxOutput, 16384)
  assert.equal(entry.vision, false)
  assert.deepEqual(entry.combo, members.map(row => row.id))
  assert.deepEqual(comboChain(entry, members).map(row => row.id), entry.combo)
})

await check('mixed Unicode chain names keep distinct identities after reload (#385)', () => {
  const rows = normalizeCombos(['\u514d\u8d39 Pro', '\u4ed8\u8d39 Pro']
    .map(name => ({ name, models: MODELS })))
  assert.equal(rows.length, 2)
  assert.deepEqual(normalizeCombos(JSON.parse(JSON.stringify(rows))), rows)
  const saved = { id: 'combo:pro', name: '\u514d\u8d39 Pro', models: MODELS }
  assert.equal(normalizeCombos([saved])[0].id, saved.id, 'existing persisted ids remain stable')
})

await check('a Chinese-named chain routes through the Adapter and records its own id (#379)', async () => {
  const id = comboId(CHINESE_NAME)
  assert.ok(CATALOG.some(row => row.id === id), 'the saved chain is advertised')
  const run = await drive([
    { body: sse({ choices: [{ index: 0, delta: { content: ANSWER } }] }) + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n' },
  ], id)
  assert.equal(run.scenario.requests.length, 1)
  assert.equal(run.scenario.requests[0].body.model, MODELS[0], 'the virtual id never reaches the provider')
  assert.equal(run.text, ANSWER)
  assert.equal(run.finish?.kind, 'stop')
  assert.equal(run.turns[0].model, id)
  assert.equal(run.turns[0].ok, true)
})

await check('thinking then an in-stream quota wall advances to the next candidate', async () => {
  const run = await drive([
    // The free lane speaks the chat wire; the in-band refusal arrives after the
    // reasoning deltas, when the status line is long spent.
    { body: reasoningFrames('weighing the options carefully') + sse({ error: { message: 'rate limit exceeded' } }) },
    { body: sse({ choices: [{ index: 0, delta: { content: ANSWER } }] }) + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n' },
  ])
  assert.equal(run.scenario.requests.length, 2, 'the chain must try the second candidate')
  assert.equal(run.finish?.kind, 'stop', 'the second candidate answers the turn')
  assert.ok(run.text.includes(ANSWER), 'the caller gets the second candidate’s answer')
  assert.ok(noThinking(run.chunks), 'the failed candidate’s held thinking is discarded')
  assert.equal(run.chunks.filter(chunk => chunk.type === 'finish').length, 1, 'exactly one finish')
  assert.equal(run.turns.length, 1, 'one logical turn')
  assert.equal(run.turns[0].model, COMBO_ID, 'the turn is recorded under the chain’s own id')
  assert.equal(run.turns[0].ok, true)
  assert.equal(run.turns[0].attempts, 2)
})

await check('a reasoning block-end does not commit the chain', async () => {
  const run = await drive([
    // Reasoning deltas, then a clean EOF with no finish token: closeAll closes
    // the thinking block with a block-end right before the failure surfaces.
    { body: reasoningFrames('a long analysis that never got to speak') },
    { body: sse({ choices: [{ index: 0, delta: { content: ANSWER } }] }) + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n' },
  ])
  assert.equal(run.scenario.requests.length, 2, 'the reasoning block-end must not have committed the chain')
  assert.equal(run.finish?.kind, 'stop')
  assert.ok(run.text.includes(ANSWER))
  assert.ok(noThinking(run.chunks), 'the held thinking goes out with the discarded attempt')
  assert.equal(run.turns[0].attempts, 2)
})

await check('visible text commits the chain: a later refusal ends the turn', async () => {
  const run = await drive([
    { body: sse({ choices: [{ index: 0, delta: { content: ANSWER } }] }) + sse({ error: { message: 'rate limit exceeded' } }) },
  ])
  assert.equal(run.scenario.requests.length, 1, 'a committed candidate is not retried on another model')
  assert.equal(run.finish?.kind, 'error', 'the failure ends the turn the normal way')
  assert.ok(run.text.includes(ANSWER), 'the released answer stays with the caller')
  assert.equal(run.turns.length, 1)
  assert.equal(run.turns[0].ok, false)
  assert.equal(run.turns[0].attempts, 1)
})

await check('a refusal before any output still advances (the plain case)', async () => {
  const run = await drive([
    { status: 429, body: '{"error":{"message":"rate limit exceeded"}}' },
    { body: sse({ choices: [{ index: 0, delta: { content: ANSWER } }] }) + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n' },
  ])
  assert.equal(run.scenario.requests.length, 2)
  assert.equal(run.finish?.kind, 'stop')
  assert.ok(run.text.includes(ANSWER))
  assert.equal(run.turns[0].attempts, 2)
})

for (const [status, type, message, attempts] of [
  [400, '', 'bad request', 2],
  [400, '', 'maximum context length exceeded', 2],
  [403, 'RegionError', 'not available in your country', 2],
  [403, 'AuthorizationRequired', 'login required', 1],
  [403, 'FreeTierError', 'free tier can only be used from within OpenCode', 1],
]) await check(`chain refusal: ${type || message}`, async () => {
  const run = await drive([
    { status, body: JSON.stringify({ error: { type, message } }) },
    { body: chatFrames(ANSWER) },
  ])
  assert.equal(run.scenario.requests.length, attempts)
  assert.equal(run.finish?.kind, attempts === 2 ? 'stop' : 'error')
  if (attempts === 2) assert.equal(run.text, ANSWER)
})

await check('a dead head is skipped for the rest of its slot, but the rotation stays cyclic', async () => {
  /*
   * 规则（用户 2026-11-04）：
   *
   * > 1-N 循环轮动每个渠道，成功了就继续下 9 次请求，失败了就下一个渠道。
   * > 循环的轮，不存在降级/隔离/抛弃。
   *
   * 本用例守两件事：
   *  1. 队首额度打光时，**这一轮**直接顺延到下一个渠道作答（不白撞死链）；
   *  2. 「成功」不会把游标搬到别处 —— 作答的渠道接着服务它剩下的次数，
   *     次序始终跟着用户在路由里排的顺序走。
   *
   * ⚠️ 这里原先把「成功之后也要推进游标」写成了期望，那正是导致
   *    「一直轮 buddy、别的渠道几乎不出现」的原因，已按用户规则改掉。
   */
  const adapter = new FreeModelAdapter({
    state: () => ({
      catalog: CATALOG,
      membership: { [ROUTE_MAIN]: MODELS },
      settings: { enabled: true, defaultMaxTokens: 32768, streamRecovery: false },
      attributionUserAgent: 'offline-combo-rotation-test',
    }),
    recordUsage: () => {},
    recordTurn: () => {},
    warn: () => {},
  })
  const turn = async answers => {
    const scenario = { answers, requests: [] }
    activeCase = scenario
    const controller = new AbortController()
    const chunks = []
    try {
      for await (const chunk of adapter.stream({
        provider: ROUTE_MAIN,
        model: ROTATION_ID,
        maxTokens: 4096,
        sessionId: 'combo-rotation-test',
        messages: [{ role: 'user', content: [{ type: 'text', text: TASK }] }],
        signal: controller.signal,
      })) chunks.push(chunk)
    } finally { controller.abort() }
    return { scenario, chunks, finish: chunks.find(chunk => chunk.type === 'finish')?.reason }
  }
  const dead = { status: 429, body: JSON.stringify({ error: { message: 'quota exhausted for today' } }) }
  const ok = { body: sse({ choices: [{ index: 0, delta: { content: ANSWER } }] }) + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n' }

  const first = await turn([dead, ok])
  assert.equal(first.finish?.kind, 'stop')
  assert.deepEqual(first.scenario.requests.map(row => row.body.model), [MODELS[0], MODELS[1]],
    'the first turn walks the stored order past the dead head')

  /*
   * ★ 轮询铁律（用户 2026-11-05）：失败/禁期/限流不参与轮询 —— 游标只按名额走。
   *
   * 队首死掉的那次：本回合顺延到 `MODELS[1]` 作答（用户没看到死链的超时白等
   * 是因为失败通常很快）；但**下一回合仍从游标处开始** —— 若游标还在死掉的
   * 队首名额里，就再撞它一次、再顺延。这就是「失败占 0 次、不隔离、不抛弃」：
   * 名额不给它记，但它随时会被轮到、随时会被重试。
   *
   * ⚠️ 旧期望「下一回合从作答者的下一个开始」是 fallback（降级）的语义，
   * 已按铁律改掉 —— 那会让游标被失败者拽着走，名额全乱。
   */
  // 游标仍停在队首名额里（铁律：失败不动游标）⇒ 每回合都先撞一次队首
  // （占 0 次、不记名额）再顺延。桩要照样准备 [dead, ok]。
  const second = await turn([dead, ok])
  assert.equal(second.finish?.kind, 'stop')
  assert.deepEqual(second.scenario.requests.map(row => row.body.model), [MODELS[0], MODELS[1]],
    '下一回合仍从游标处开始：先撞死掉的队首（占 0 次）再顺延到下一个作答')

  /*
   * 第三回合：同理 —— 游标仍停留在队首名额的计数上，先撞队首再顺延。
   * 直到该名额的计数走满，游标才前进到下一个成员。
   */
  const third = await turn([dead, ok])
  assert.equal(third.finish?.kind, 'stop')
  assert.deepEqual(third.scenario.requests.map(row => row.body.model), [MODELS[0], MODELS[1]],
    '队首名额走满之前，每回合都是「撞队首（0 次）→ 顺延作答」')
})

await check('a candidate that hit its quota is deprioritised next turn, never dropped', async () => {
  // 一条链路每回合都从队首走。队首那个渠道额度打光以后，如果每回合仍然先
  // 撞它一次，用户就每回合白等十几秒。它也不该被删掉 —— 额度会恢复。
  // 正确的行为是：记住失败给出的冷却时长，下回合把它排到队尾。
  const turns = []
  const adapter = new FreeModelAdapter({
    state: () => ({
      catalog: CATALOG,
      membership: { [ROUTE_MAIN]: MODELS },
      settings: { enabled: true, defaultMaxTokens: 32768, streamRecovery: false },
      attributionUserAgent: 'offline-combo-cooldown-test',
    }),
    recordUsage: () => {},
    recordTurn: row => turns.push(row),
    warn: () => {},
  })
  const turn = async answers => {
    const scenario = { answers, requests: [] }
    activeCase = scenario
    const controller = new AbortController()
    const chunks = []
    try {
      for await (const chunk of adapter.stream({
        provider: ROUTE_MAIN,
        model: COMBO_ID,
        maxTokens: 4096,
        sessionId: 'combo-cooldown-test',
        messages: [{ role: 'user', content: [{ type: 'text', text: TASK }] }],
        signal: controller.signal,
      })) chunks.push(chunk)
    } finally { controller.abort() }
    return { scenario, chunks, finish: chunks.find(chunk => chunk.type === 'finish')?.reason }
  }
  const head = { status: 429, body: JSON.stringify({ error: { message: 'quota exhausted for today' } }) }
  const second = { body: sse({ choices: [{ index: 0, delta: { content: ANSWER } }] }) + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n' }

  const first = await turn([head, second])
  assert.equal(first.scenario.requests.length, 2, 'the first turn walks past the dead head')
  assert.equal(first.finish?.kind, 'stop')

  const next = await turn([second])
  assert.equal(next.scenario.requests.length, 1, 'the second turn does not pay the dead head again')
  assert.equal(next.scenario.requests[0].body.model, MODELS[1], 'it starts with the candidate that worked')
  assert.equal(next.finish?.kind, 'stop')
  assert.equal(adapter.chainCooldown.has(MODELS[0]), true, 'the dead candidate is remembered, not removed')
  assert.equal(comboChain(CATALOG.find(row => row.id === COMBO_ID), CATALOG).length, 2,
    'the chain itself is unchanged — the member is only deprioritised')
})

/**
 * ★ 路由轮询的次序（用户 2026-11-04）：
 *
 * > 1-N 循环轮动每个渠道，成功了就继续下 9 次请求，失败了就下一个渠道。
 * > 循环的轮，不存在降级/隔离/抛弃。
 *
 * ## 锁死三件事
 *
 * 1. **成功不动游标**。原先成功分支调的是 `advanceComboCursor`（那是失败换人用的），
 *    等于「刚答出来的渠道立刻被跳过」且计数被清零 —— 它永远攒不满 10 次，
 *    队首渠道反复兜底、其它渠道几乎不出现（用户截图里 officeace 只出现 1 次）。
 * 2. **失败就下一个渠道**，失败者本轮占 0 次，但**留在闭环里**（转一圈仍重试）。
 * 3. **每个健康渠道严格拿满 `stickyLimit` 次**，且次序与用户排的顺序一致。
 *    失败换人那一回合由接手者实际作答，故 `used` 从 1 起算（写 0 会让它白拿一次）。
 */
{
  const MEMBERS = ['buddy', 'qodercn', 'trae', 'raccoon', 'codearts', 'officeace']
  const catalog = MEMBERS.map(name => ({ id: `channel:${name}/m` }))
  const tally = list => list.reduce((map, name) => (map[name] = (map[name] ?? 0) + 1, map), {})
  /** 忠实走 `runCombo` 的循环：逐候选试，失败才推进游标，成功立即停手。 */
  const runTurns = (id, bad, turns) => {
    const entry = { id, combo: catalog.map(row => row.id), strategy: 'round-robin', stickyLimit: 10 }
    const served = []
    for (let turn = 0; turn < turns; turn += 1) {
      const chain = comboChain(entry, catalog)
      let winner = null
      for (const candidate of chain) {
        if (bad.has(candidate.id)) { advanceComboCursor(entry, catalog, candidate.id); continue }
        winner = candidate
        break
      }
      if (winner === null) { served.push('全部失败'); break }
      served.push(winner.id.split('/')[0].replace('channel:', ''))
    }
    return served
  }

  // ① 全健康：严格 10 次一换，次序等于用户排的顺序，闭环回到队首
  const healthy = runTurns('chain-healthy', new Set(), 70)
  assert.deepEqual(tally(healthy), { buddy: 20, qodercn: 10, trae: 10, raccoon: 10, codearts: 10, officeace: 10 },
    '⚠️ 全健康时每个渠道必须严格 10 次；buddy 多出的 10 次是第二圈的开头')
  const firstCycle = healthy.slice(0, 60)
  MEMBERS.forEach((name, slot) => {
    assert.deepEqual(firstCycle.slice(slot * 10, slot * 10 + 10), Array(10).fill(name),
      `⚠️ 第一圈第 ${slot + 1} 个渠道 ${name} 必须连续服务满 10 次（次序=用户在路由里排的顺序）`)
  })

  // ② 中间渠道全坏：它占 0 次，下一家直接接手，其余渠道仍是严格 10 次
  const broken = runTurns('chain-broken', new Set(['channel:codearts/m']), 60)
  assert.equal(tally(broken).codearts, undefined, '⚠️ 全程失败的渠道本轮占 0 次')
  assert.deepEqual(tally(broken), { buddy: 20, qodercn: 10, trae: 10, raccoon: 10, officeace: 10 },
    '⚠️ 坏渠道不能连带其它渠道的次数（曾经出现过 officeace 只拿 1 次 / 拿 11 次的偏差）')

  /*
   * ③ 坏掉的渠道**留在闭环里**：转一圈回来仍会重试它（不隔离、不抛弃）。
   *
   * ⚠️ 期望值别写大：一个渠道只有在**轮到它当队首**时才会被试，
   *    所以是「每圈一次」—— 6 个渠道 × 10 次 = 60 回合才一圈。
   *    跑 3 圈（180 回合）应看到 3 次左右，而不是每回合都撞它。
   */
  const CIRCLE = MEMBERS.length * 10
  const probe = { id: 'chain-retry', combo: catalog.map(row => row.id), strategy: 'round-robin', stickyLimit: 10 }
  const attemptsOnDead = []
  for (let turn = 0; turn < CIRCLE * 3; turn += 1) {
    const chain = comboChain(probe, catalog)
    for (const candidate of chain) {
      if (candidate.id === 'channel:codearts/m') { attemptsOnDead.push(turn); advanceComboCursor(probe, catalog, candidate.id); continue }
      break
    }
  }
  assert.equal(attemptsOnDead.length, 3,
    `⚠️ 坏渠道必须每圈被重试一次（3 圈 = 3 次），实际 ${attemptsOnDead.length} 次 —— 少了说明被隔离/抛弃，多了说明每回合都在撞死链`)
  /*
   * 相邻两次尝试之间正好隔「一圈健康渠道」：这正是「循环的轮」。
   *
   * ⚠️ 间隔是 `(成员数-1) × stickyLimit` 而不是 `成员数 × stickyLimit`：
   *    坏渠道自己**不占次数**（用户规则的「失败了就下一个渠道」），
   *    所以它那一格是 0 回合，一圈只由剩下 5 个健康渠道各 10 次构成。
   */
  const HEALTHY_CIRCLE = (MEMBERS.length - 1) * 10
  for (let i = 1; i < attemptsOnDead.length; i += 1) {
    assert.equal(attemptsOnDead[i] - attemptsOnDead[i - 1], HEALTHY_CIRCLE,
      '⚠️ 重试间隔必须严格等于一圈健康渠道（说明它在闭环里按序回来，而不是被随机/永久跳过）')
  }

  // ④ 队首全坏：第一格被跳过后，第二格从第一格的位置开始服务
  const headBroken = runTurns('chain-head-broken', new Set(['channel:buddy/m']), 60)
  assert.equal(tally(headBroken).buddy, undefined, '⚠️ 队首坏掉时它占 0 次')
  assert.deepEqual(tally(headBroken), { qodercn: 20, trae: 10, raccoon: 10, codearts: 10, officeace: 10 },
    '⚠️ 队首坏掉后其余渠道仍须严格 10 次')
}

server.close()
if (failures > 0) console.error(`combo-advance-test: ${failures} failure(s)`)
else console.log('combo-advance-test: the chain commits on answers only and fails over on everything else')
process.exitCode = failures > 0 ? 1 : 0
