/**
 * 路由内的渠道成员必须把调用方的 controls 交给内核 resolve。
 *
 * 真实缺陷（2026-11-10，与 qodercn 每回合被撞同一个根因的另一半）：
 * `prepareChannelCall` 早先只把 `{ provider, model }` 传给 `llm.prepareCall`，
 * 调用方的 `maxTokens` / `temperature` / `stop` **整个丢掉**。于是内核 resolve
 * 出的权威 config 里没有这些值，而派发又要求与它逐字段相等：
 *
 *   - 删不干净 ⇒ `INVALID_PREPARED_CALL`（渠道成员每回合失败）；
 *   - 删干净了 ⇒ 用户的 maxTokens / temperature / stop **静默失效**。
 *
 * 本测试同时锁住两件事：
 *   ① `prepare` 收到的 controls 与调用方一致（含 undefined 语义）；
 *   ② 内核 resolve 后的 config 包含这些 controls 时，转发配置照抄它们。
 *
 * ⚠️ `reasoningEffort` 必须**不在**透传集合里：本插件档位 id 与渠道私有档位
 *    不同域，透传会撞 400。这条也一并断言。
 */
import assert from 'node:assert/strict'
import { FreeModelAdapter, ROUTE_MAIN } from '../src/adapter.js'

const P = 'chan'
const M = 'dfmodel'
const CHANNEL_ID = `channel:${P}/${M}`
const CHAIN_ID = 'combo:controls'

const catalog = [
  { id: CHANNEL_ID, name: 'Flash', channel: `channel:${P}`, providerModel: M, provider: P, contextWindow: 1_000_000, maxOutput: 32768, vision: false, reasoning: true },
  { id: CHAIN_ID, name: 'controls', channel: 'combo', combo: [CHANNEL_ID], strategy: 'fallback', stickyLimit: 1, vision: false, reasoning: true, contextWindow: 1_000_000, maxOutput: 32768, canDisableThinking: false, regionSensitive: false, lanes: [`channel:${P}`] },
]

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

/** 模拟内核：把传进来的 controls 当作已 resolve，回填成 locked config。 */
function run(options, { resolveDrops = [] } = {}) {
  const seenPrepare = []
  const seenDispatch = []
  const key = JSON.stringify(options)
  const adapter = new FreeModelAdapter({
    state: () => ({
      catalog,
      membership: { [ROUTE_MAIN]: [CHAIN_ID] },
      settings: { enabled: true, defaultMaxTokens: 32768, streamRecovery: false },
      attributionUserAgent: 'offline-chain-channel-controls-test',
    }),
    recordUsage: () => {},
    recordTurn: () => {},
    warn: () => {},
    log: () => {},
    prepareChannelCall: async (provider, model, signal, controls) => {
      seenPrepare.push({ provider, model, controls: controls === undefined ? '<none>' : controls })
      // 内核行为：config = { provider, model, ...按 resolve 结果保留的 controls }
      const locked = { provider, model }
      for (const field of ['maxTokens', 'temperature', 'stop']) {
        if (resolveDrops.includes(field)) continue
        const value = controls?.[field]
        if (value !== undefined) locked[field] = value
      }
      return {
        config: locked,
        stream: opts => (async function* () {
          seenDispatch.push(opts)
          yield { type: 'text-delta', text: 'ok' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })(),
      }
    },
  })
  return { adapter, seenPrepare, seenDispatch, key }
}

const drive = async (adapter, extra = {}) => {
  const controller = new AbortController()
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: ROUTE_MAIN,
    model: CHAIN_ID,
    sessionId: 'chain-channel-controls-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    signal: controller.signal,
    ...extra,
  })) chunks.push(chunk)
  return chunks
}

// ① controls 必须真的被交给 prepare（这是本次修复的核心）。
await check('调用方的 maxTokens/temperature/stop 必须交给内核 prepare', async () => {
  const run1 = run({})
  await drive(run1.adapter, { maxTokens: 12345, temperature: 0.42, stop: ['END'] })
  const prep = run1.seenPrepare[0]
  assert.equal(prep.controls.maxTokens, 12345, '⚠️ maxTokens 不能被丢在 prepare 之外')
  assert.equal(prep.controls.temperature, 0.42)
  assert.deepEqual(prep.controls.stop, ['END'])
})

// ② 调用方没设的，不能凭空造一个（undefined 语义要保留）。
await check('调用方未设置的 controls 不得凭空出现', async () => {
  const run1 = run({})
  await drive(run1.adapter)
  const prep = run1.seenPrepare[0]
  assert.equal(prep.controls.maxTokens, undefined)
  assert.equal(prep.controls.temperature, undefined)
  assert.equal(prep.controls.stop, undefined)
})

// ③ 内核 resolve 保留了这些值 ⇒ 派发时照抄（用户的设置真正生效）。
await check('内核 resolve 出的 maxTokens/temperature/stop 必须在派发时生效', async () => {
  const run1 = run({})
  await drive(run1.adapter, { maxTokens: 12345, temperature: 0.42, stop: ['END'] })
  const sent = run1.seenDispatch[0]
  assert.equal(sent.maxTokens, 12345, '⚠️ 用户设的 maxTokens 必须到 wire，而不是被静默删掉')
  assert.equal(sent.temperature, 0.42)
  assert.deepEqual(sent.stop, ['END'])
})

// ④ 内核没保留（例如适配器不认这个字段）⇒ 派发时不能漏出去，否则 INVALID_PREPARED_CALL。
await check('内核未保留的字段必须在派发前删掉（否则配置锁拒绝）', async () => {
  const run1 = run({}, { resolveDrops: ['maxTokens', 'temperature', 'stop'] })
  const chunks = await drive(run1.adapter, { maxTokens: 12345, temperature: 0.42, stop: ['END'] })
  const finish = chunks.find(c => c.type === 'finish')
  assert.equal(finish?.reason?.kind, 'stop', `链路必须成功，实际 ${JSON.stringify(finish?.reason)}`)
  const sent = run1.seenDispatch[0]
  assert.equal('maxTokens' in sent, false)
  assert.equal('temperature' in sent, false)
  assert.equal('stop' in sent, false)
})

// ④b 宿主没给 config 时，绝不能把调用方的 controls 删光（同类排查第三处）。
await check('没有 locked config 时，调用方的 controls 必须原样保留', async () => {
  const seenDispatch = []
  const adapter = new FreeModelAdapter({
    state: () => ({
      catalog,
      membership: { [ROUTE_MAIN]: [CHAIN_ID] },
      settings: { enabled: true, defaultMaxTokens: 32768, streamRecovery: false },
      attributionUserAgent: 'offline-chain-channel-controls-test',
    }),
    recordUsage: () => {},
    recordTurn: () => {},
    warn: () => {},
    log: () => {},
    // 旧内核 / 未实现 config 契约的适配器：handle 上没有 config。
    prepareChannelCall: async (provider, model) => ({
      stream: opts => (async function* () {
        seenDispatch.push(opts)
        yield { type: 'text-delta', text: 'ok' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })(),
    }),
  })
  await drive(adapter, { maxTokens: 12345, temperature: 0.42, stop: ['END'] })
  const sent = seenDispatch[0]
  assert.equal(sent.maxTokens, 12345, '⚠️ 没有 config 时不能把用户的 maxTokens 删掉（会静默失效）')
  assert.equal(sent.temperature, 0.42, '⚠️ temperature 同样不能被删')
  assert.deepEqual(sent.stop, ['END'], '⚠️ stop 同样不能被删')
  assert.equal(sent.provider, P, 'provider 仍须改写成渠道自己的名字')
  assert.equal(sent.model, M)
})

// ⑤ reasoningEffort 绝不能透传给渠道（不同档位域）。
await check('reasoningEffort 不得透传给渠道成员', async () => {
  const run1 = run({})
  await drive(run1.adapter, { reasoningEffort: 'high' })
  const prep = run1.seenPrepare[0]
  assert.equal('reasoningEffort' in prep.controls, false, '⚠️ 本插件档位 id 与渠道私有档位不同域，不能透传')
  assert.equal('reasoningEffort' in run1.seenDispatch[0], false)
})

if (failures > 0) console.error(`chain-channel-controls-test: ${failures} failure(s)`)
else console.log('chain-channel-controls-test: caller controls reach the kernel and then the wire')
process.exitCode = failures > 0 ? 1 : 0
