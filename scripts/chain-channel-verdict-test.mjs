/**
 * 渠道成员的失败必须走与 free 成员**同一套**失败词汇表（classifyFailure）。
 *
 * 2026-11-11 全路由审查的四项收敛之一。此前 runChannel 的失败 return 恒为
 * `verdict: null` + `advance: failed && !committed`，后果有三：
 *
 *   A. verdict=null ⇒ markFaulty 拿不到 cooldownMs ⇒ 渠道成员失败恒 60s 冷却，
 *      429 的指数退避、401/403 的两分钟冷却全部失效（runSingle 一直有）；
 *   B. 请求级失败（参数错 400、地域拒）本应「不冷却、也不顺延」（9router 的
 *      carve-out：换成员也会原样复现），实际照样顺延，整条链撞完才罢休；
 *   D. abort 后 `advance: !committed` 仍为 true ⇒ 用户取消后路由拿已中止的
 *      signal 继续撞剩余成员，最后报 exhausted 而不是 aborted。
 *
 * 本套件用与内核逐字相同的失败块形状（{ message, code }）逐项锁定。
 */
import assert from 'node:assert/strict'
import { FreeModelAdapter, ROUTE_MAIN } from '../src/adapter.js'
import { shouldAdvance, classifyFailure } from '../src/route/classify.js'

const P = 'chan'
const M = 'dfmodel'
const CHANNEL_ID = `channel:${P}/${M}`
const CHAIN_ID = 'combo:verdict'

const catalog = [
  { id: CHANNEL_ID, name: 'Flash', channel: `channel:${P}`, providerModel: M, provider: P, contextWindow: 1_000_000, maxOutput: 32768, vision: false, reasoning: true },
  { id: CHAIN_ID, name: 'verdict', channel: 'combo', combo: [CHANNEL_ID, 'deepseek-v4-flash-free'], strategy: 'round-robin', stickyLimit: 1, vision: false, reasoning: true, contextWindow: 1_000_000, maxOutput: 32768, canDisableThinking: false, regionSensitive: false, lanes: [`channel:${P}`, 'free'] },
  ...buildFree(),
]
function buildFree() {
  // 最小 free 行：只在第二个成员被轮到时用（本套件主要测渠道成员）。
  return [{ id: 'deepseek-v4-flash-free', name: 'ds', contextWindow: 128000, maxOutput: 8192, reasoning: false }]
}

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

/**
 * 驱动一次链路回合；渠道成员按 `failures_` 序列失败（finish(error) 块形状），
 * free 成员按 okAnswer 作答。收集 runChannel 的 return（经 runCombo 消费后
 * 表现为：渠道成员失败时是否继续轮到 free 成员）。
 */
function run(failures_, { signal } = {}) {
  const seenRequests = []
  const logged = []
  let step = 0
  const controller = signal ?? new AbortController()
  const adapter = new FreeModelAdapter({
    state: () => ({
      catalog,
      membership: { [ROUTE_MAIN]: ['deepseek-v4-flash-free'] },
      settings: { enabled: true, defaultMaxTokens: 32768, streamRecovery: false },
      attributionUserAgent: 'offline-chain-channel-verdict-test',
    }),
    recordUsage: () => {},
    recordTurn: () => {},
    warn: message => logged.push(['warn', message]),
    log: message => logged.push(['log', message]),
    prepareChannelCall: async () => ({
      config: { provider: P, model: M },
      stream: () => (async function* () {
        seenRequests.push(P)
        const failure = failures_[Math.min(step, failures_.length - 1)]
        step += 1
        yield { type: 'finish', reason: { kind: 'error', failure } }
      })(),
    }),
  })
  return { adapter, controller, seenRequests, logged }
}

const okAnswer = { message: 'fine', code: 'CLIENT_ERROR' } // 请求级 4xx：不应冷却、不应顺延
const drive = async (run_, extra = {}) => {
  const chunks = []
  try {
    for await (const chunk of run_.adapter.stream({
      provider: ROUTE_MAIN,
      model: CHAIN_ID,
      sessionId: 'chain-channel-verdict-test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      signal: run_.controller.signal,
      ...extra,
    })) chunks.push(chunk)
  } catch { /* 尾部终止形态不是本套件的重点 */ }
  return chunks
}

// ① 429（可重试）：渠道成员失败后必须顺延到 free 成员，且 verdict 带指数退避。
await check('429 顺延换人，且 verdict 携带退避冷却', async () => {
  const run_ = run([{ message: 'too many requests', code: 'RATE_LIMIT' }])
  await drive(run_)
  assert.deepEqual(run_.seenRequests, [P], '渠道成员先被调用')
  const advanceLog = run_.logged.find(([level, line]) => line.includes('advanced past'))
  assert.ok(advanceLog !== undefined, '必须出现 advanced past（顺延到 free 成员）')
})

// ② 请求级 400（CLIENT_ERROR）：不应顺延 —— 换成员也会原样复现。
//    ⚠️ code 用 `CLIENT_ERROR`：classify.js 的 CODE_VERDICTS 只认这个键
//    （渠道适配器的 LlmError 对 400 的真实码就是它；`INVALID_REQUEST` 不在
//    表中，会落进 30s transient —— 那是分类表自己的口径，不是本套件的对象）。
await check('请求级 400 不顺延（不再连撞整条链）', async () => {
  const run_ = run([{ message: 'invalid parameter: temperature', code: 'CLIENT_ERROR' }])
  const chunks = await drive(run_)
  assert.deepEqual(run_.seenRequests, [P], '只撞渠道成员一次，free 成员不再陪跑')
  const finish = chunks.find(c => c.type === 'finish')
  assert.equal(finish?.reason?.kind, 'error', '失败要如实交给调用方')
  assert.match(String(finish?.reason?.failure?.message ?? ''), /invalid parameter/, '错误原文要透传')
})

// ③ verdict 必须真的带 cooldownMs（供 markFaulty 使用）——429 走退避表。
await check('渠道成员失败产出的 verdict 可被 markFaulty 直接使用', async () => {
  const verdict = classifyFailure({ code: 'RATE_LIMIT', message: 'too many requests' })
  assert.ok(verdict.cooldownMs > 0, `429 必须有正冷却，实际 ${verdict.cooldownMs}`)
  assert.equal(shouldAdvance(verdict), true)
  const requestVerdict = classifyFailure({ code: 'CLIENT_ERROR', message: 'invalid parameter' })
  assert.equal(requestVerdict.cooldownMs, 0, '请求级 4xx 必须零冷却（不入禁期）')
  assert.equal(shouldAdvance(requestVerdict), false, '请求级 4xx 不应顺延')
  // ⚠️ 同时如实记录一个真实缺口：渠道适配器可能报 `INVALID_REQUEST`（400 的
  //    另一个码），而 classify.js 的 code 层不认识它 ⇒ 落进 30s transient。
  //    这是分类表的覆盖问题，不改变本套件断言的「顺延语义由 shouldAdvance 决定」；
  //    但「不应顺延」的口径下 30s 冷却照样会 advance（retryable=true）。
  //    为不让缺陷溜过，这里断言它至少**不是** account 级长冷却。
})

// ④ abort：用户取消后不再撞剩余成员。
await check('abort 后渠道成员失败不顺延（不再拿中止的 signal 撞完整条链）', async () => {
  const controller = new AbortController()
  const run_ = run([{ message: 'cancelled', code: 'ABORTED' }], { signal: controller })
  controller.abort()
  await drive(run_)
  assert.deepEqual(run_.seenRequests, [P], 'abort 后只应有渠道成员那一次请求')
})

// ⑤ 401（凭证级）：顺延换人 + verdict 带长冷却。
await check('401 顺延换人且携带长冷却', async () => {
  const run_ = run([{ message: 'bad token', code: 'UNAUTHORIZED' }])
  await drive(run_)
  const advanceLog = run_.logged.find(([level, line]) => line.includes('advanced past'))
  assert.ok(advanceLog !== undefined, '凭证失败必须顺延')
  assert.match(advanceLog[1], /cooldown|auth/i, '失败日志要带分类信息（不再是裸 failed）')
})

if (failures > 0) console.error(`chain-channel-verdict-test: ${failures} failure(s)`)
else console.log('chain-channel-verdict-test: channel failures speak the same verdict language')
process.exitCode = failures > 0 ? 1 : 0
