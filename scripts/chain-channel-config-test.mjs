/**
 * 路由里的**渠道成员**必须按内核锁定的 config 原样派发。
 *
 * 真实缺陷（2026-11-10，用户报「qodercn 每回合都被撞一次」，且强调
 * 「我单测这个渠道可用、对话也正常」）：症状只在链路里出现，因为单测与直接
 * 对话都不经过 `prepareCall` 的配置锁，只有渠道成员走这条路。
 *
 * 内核 `callConfigEquals` 只比较 provider / model / reasoningEffort /
 * temperature / maxTokens / stop。旧实现用 `{ ...options, ...locked }` 合并，
 * 「键存在才覆盖」——`locked` 没声明的键会保留 `options` 的原值，于是像
 * `maxTokens`（qoder 的 resolveModel 在 remoteModel.maxTokens 缺失时不设
 * defaultMaxTokens，内核就不会补这个字段）这类组合必然被判为「config 变了」。
 *
 * 本测试用内核逐字相同的比较规则，断言修复后的转发配置**每个字段都等于**
 * locked，并且覆盖「locked 缺 maxTokens / 缺 reasoningEffort / 带 stop」等形状。
 */
import assert from 'node:assert/strict'
import { FreeModelAdapter, ROUTE_MAIN } from '../src/adapter.js'

/** 内核 `LlmRuntime.callConfigEquals` 的逐字复制（见 dsh-llm lib/index.js）。 */
function callConfigEquals(a, b) {
  if (a.provider !== b.provider || a.model !== b.model
    || a.reasoningEffort !== b.reasoningEffort || a.temperature !== b.temperature
    || a.maxTokens !== b.maxTokens) return false
  if (a.stop === undefined || b.stop === undefined) return a.stop === b.stop
  return a.stop.length === b.stop.length && a.stop.every((s, i) => s === b.stop?.[i])
}

const CHANNEL_PROVIDER = 'chan'
const CHANNEL_MODEL = 'dfmodel'
const CHANNEL_ID = `channel:${CHANNEL_PROVIDER}/${CHANNEL_MODEL}`
const CHAIN_ID = 'combo:cfg'

const catalog = [
  {
    id: CHANNEL_ID,
    name: 'DeepSeek-Flash · x0.1',
    channel: `channel:${CHANNEL_PROVIDER}`,
    providerModel: CHANNEL_MODEL,
    provider: CHANNEL_PROVIDER,
    contextWindow: 1_000_000,
    maxOutput: 32768,
    vision: false,
    reasoning: true,
  },
  {
    id: CHAIN_ID,
    name: 'cfg',
    channel: 'combo',
    combo: [CHANNEL_ID],
    strategy: 'fallback',
    stickyLimit: 1,
    vision: false,
    reasoning: true,
    contextWindow: 1_000_000,
    maxOutput: 32768,
    canDisableThinking: false,
    regionSensitive: false,
    lanes: [`channel:${CHANNEL_PROVIDER}`],
  },
]

/**
 * @param lockedConfig 内核声明的权威 config（`handle.config` 的内容）
 */
function runChain(lockedConfig, callerOptions = {}) {
  const seen = []
  let dispatched = false
  const adapter = new FreeModelAdapter({
    state: () => ({
      catalog,
      membership: { [ROUTE_MAIN]: [CHAIN_ID] },
      settings: { enabled: true, defaultMaxTokens: 32768, streamRecovery: false },
      attributionUserAgent: 'offline-chain-channel-config-test',
    }),
    recordUsage: () => {},
    recordTurn: () => {},
    warn: () => {},
    log: () => {},
    prepareChannelCall: async (provider, model) => {
      assert.equal(provider, CHANNEL_PROVIDER)
      assert.equal(model, CHANNEL_MODEL)
      return {
        config: lockedConfig,
        stream: options => (async function* () {
          seen.push(options)
          // 模拟内核的配置锁：不一致就不能派发。
          if (!callConfigEquals(options, lockedConfig)) {
            throw new Error('prepared LLM call config changed before adapter dispatch')
          }
          dispatched = true
          yield { type: 'text-delta', text: 'ok' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })(),
      }
    },
  })
  const controller = new AbortController()
  return { adapter, controller, seen, dispatched: () => dispatched }
}

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

const drive = async (run, extra = {}) => {
  const chunks = []
  for await (const chunk of run.adapter.stream({
    provider: ROUTE_MAIN,
    model: CHAIN_ID,
    sessionId: 'chain-channel-config-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    signal: run.controller.signal,
    ...extra,
  })) chunks.push(chunk)
  return chunks
}

// ① 关键回归：locked 没有 maxTokens（qoder 的真实形状），调用方却带了一个。
await check('locked 缺 maxTokens 时，调用方的 maxTokens 必须被丢掉（qodercn 真实形状）', async () => {
  const run = runChain({ provider: CHANNEL_PROVIDER, model: CHANNEL_MODEL })
  const chunks = await drive(run, { maxTokens: 32768 })
  const finish = chunks.find(c => c.type === 'finish')
  assert.equal(finish?.reason?.kind, 'stop', `链路必须成功作答，实际：${JSON.stringify(finish?.reason)}`)
  assert.equal(run.dispatched(), true, '渠道成员的流必须真的被派发')
  assert.equal(run.seen.length, 1, '只应派发一次')
  assert.equal('maxTokens' in run.seen[0], false, '⚠️ locked 没声明的 maxTokens 不能漏过去（否则内核判 config 变了）')
})

// ② locked 声明了 maxTokens ⇒ 必须照抄（且覆盖调用方的值）。
await check('locked 声明 maxTokens 时以 locked 为准', async () => {
  const run = runChain({ provider: CHANNEL_PROVIDER, model: CHANNEL_MODEL, maxTokens: 8192 })
  await drive(run, { maxTokens: 32768 })
  assert.equal(run.seen[0].maxTokens, 8192, '必须用 locked 的 maxTokens，不是调用方的')
})

// ③ reasoningEffort：locked 没有就必须删（本插件档位与渠道私有 id 不同域）。
await check('locked 缺 reasoningEffort 时调用方的档位不能漏过去', async () => {
  const run = runChain({ provider: CHANNEL_PROVIDER, model: CHANNEL_MODEL })
  await drive(run, { reasoningEffort: 'high' })
  assert.equal('reasoningEffort' in run.seen[0], false, '⚠️ 渠道私有档位不能带上本插件的 high')
})

// ④ temperature / stop 同样以 locked 为准（这次是「有」的方向）。
await check('temperature 与 stop 照抄 locked', async () => {
  const stop = ['\n\n']
  const run = runChain({ provider: CHANNEL_PROVIDER, model: CHANNEL_MODEL, temperature: 0.3, stop })
  await drive(run, { temperature: 1, stop: ['END'] })
  assert.equal(run.seen[0].temperature, 0.3, 'temperature 必须等于 locked')
  assert.deepEqual(run.seen[0].stop, stop, 'stop 必须等于 locked')
})

// ⑤ locked 缺 temperature / stop ⇒ 调用方的值不能漏过去。
await check('locked 缺 temperature/stop 时同样不能漏', async () => {
  const run = runChain({ provider: CHANNEL_PROVIDER, model: CHANNEL_MODEL })
  await drive(run, { temperature: 0.9, stop: ['X'] })
  assert.equal('temperature' in run.seen[0], false)
  assert.equal('stop' in run.seen[0], false)
})

// ⑥ provider/model 必须重写成渠道自己的名字（不能回跳到路由本身）。
await check('provider/model 必须是渠道自己的名字', async () => {
  const run = runChain({ provider: CHANNEL_PROVIDER, model: CHANNEL_MODEL })
  await drive(run)
  assert.equal(run.seen[0].provider, CHANNEL_PROVIDER)
  assert.equal(run.seen[0].model, CHANNEL_MODEL)
})

// ⑦ 整个转发对象必须通过内核的逐字比较。
await check('转发配置与 locked 通过内核 callConfigEquals', async () => {
  const locked = { provider: CHANNEL_PROVIDER, model: CHANNEL_MODEL, maxTokens: 4096, temperature: 0.2 }
  const run = runChain(locked)
  await drive(run, { maxTokens: 32768, temperature: 0.7, reasoningEffort: 'off' })
  assert.equal(callConfigEquals(run.seen[0], locked), true, '必须逐字段相等')
})

if (failures > 0) console.error(`chain-channel-config-test: ${failures} failure(s)`)
else console.log('chain-channel-config-test: channel members dispatch exactly the locked config')
process.exitCode = failures > 0 ? 1 : 0
