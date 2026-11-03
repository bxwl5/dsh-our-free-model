import assert from 'node:assert/strict'
import { CHANNEL_PREFIX, buildChannelCatalog, channelModelId, isChannelEntry, parseChannelModelId, providerOfChannel, readChannelRosters } from '../src/channel-catalog.js'

// id 编解码：模型名里的斜杠只切第一刀
assert.equal(channelModelId('cline', 'anthropic/claude-sonnet-5.5'), 'channel:cline/anthropic/claude-sonnet-5.5')
assert.deepEqual(parseChannelModelId('channel:cline/anthropic/claude-sonnet-5.5'), { provider: 'cline', model: 'anthropic/claude-sonnet-5.5' })
assert.equal(parseChannelModelId('glm-5.3-flash-free'), undefined)
assert.equal(parseChannelModelId('combo:my-chain'), undefined)
assert.equal(parseChannelModelId('channel:zcode'), undefined)
assert.equal(providerOfChannel('channel:zcode'), 'zcode')
assert.equal(providerOfChannel('kilo'), undefined)

// 条目判定
assert.equal(isChannelEntry({ channel: 'channel:zcode' }), true)
assert.equal(isChannelEntry({ channel: 'kilo' }), false)
assert.equal(isChannelEntry({}), false)

// 构建：同名模型跨 provider 不冲突，缺字段走保守默认
const rows = buildChannelCatalog([
  { provider: 'zcode', models: [{ id: 'GLM-5.3', name: 'GLM-5.3' }] },
  { provider: 'qoder', models: [{ id: 'GLM-5.3', name: 'GLM 5.3 (Qoder)', contextWindow: 200000, maxOutput: 8192, inputModalities: ['text','image'] }] },
])
assert.equal(rows.length, 2)
assert.equal(rows[0].id, 'channel:zcode/GLM-5.3')
assert.equal(rows[1].id, 'channel:qoder/GLM-5.3')
assert.notEqual(rows[0].id, rows[1].id, 'same model name on two providers must not collide')
assert.equal(rows[0].contextWindow, 131072, 'missing contextWindow falls back')
assert.equal(rows[0].maxOutput, 32768)
assert.equal(rows[0].vision, false)
assert.equal(rows[1].vision, true)
assert.equal(rows[1].contextWindow, 200000)
assert.equal(rows[1].providerModel, 'GLM-5.3')

// 空 id / 重复 id 被丢弃
const dedup = buildChannelCatalog([{ provider: 'p', models: [{ id: '' }, { id: '  ' }, { id: 'a' }, { id: 'a' }] }])
assert.equal(dedup.length, 1)

// roster 读取：只吸包内 provider；单家失败不拖垮其它
const llm = {
  listProviders: () => [{ id: 'our-free-model' }, { id: 'zcode' }, { id: 'deepseek-official' }, { id: 'kuku' }],
  listModels: async p => {
    if (p === 'kuku') throw new Error('credential lapsed')
    if (p === 'zcode') return [{ id: 'GLM-5.3' }]
    return [{ id: 'should-not-appear' }]
  },
}
const errors = []
const got = await readChannelRosters(llm, new Set(['zcode', 'kuku']), (p, e) => errors.push(`${p}:${e.message}`))
assert.deepEqual(got.providers, ['zcode'], 'only the provider that answered')
assert.equal(got.rows.length, 1)
assert.deepEqual(errors, ['kuku:credential lapsed'], 'a lapsed channel reports but does not break the read')
assert.ok(!got.rows.some(r => r.id.includes('deepseek-official')), 'non-pack vendors are not absorbed')

// resolveModelInfo 提供真实容量时覆盖兜底值（修复「所有渠道模型都显示 131K/33K」）
const rich = {
  listProviders: () => [{ id: 'zcode' }],
  listModels: async () => [{ id: 'GLM-5.3' }, { id: 'GLM-5.3-Flash' }],
  resolveModelInfo: async (provider, model) => model === 'GLM-5.3'
    ? { context: { contextWindow: 200000 }, defaultMaxTokens: 16000 }
    : { context: { contextWindow: 128000 }, defaultMaxTokens: 8192 },
}
const enriched = await readChannelRosters(rich, new Set(['zcode']))
assert.equal(enriched.rows.length, 2)
assert.equal(enriched.rows[0].contextWindow, 200000, 'real context replaces the 131072 fallback')
assert.equal(enriched.rows[0].maxOutput, 16000, 'real maxOutput replaces the 32768 fallback')
assert.equal(enriched.rows[1].contextWindow, 128000)
assert.equal(enriched.rows[1].maxOutput, 8192)

// resolveModelInfo 单个失败只影响那一行（保留兜底），不拖垮整轮
const partial = {
  listProviders: () => [{ id: 'zcode' }],
  listModels: async () => [{ id: 'a' }, { id: 'b' }],
  resolveModelInfo: async (_p, m) => { if (m === 'a') throw new Error('boom'); return { context: { contextWindow: 64000 } } },
}
const partialRows = await readChannelRosters(partial, new Set(['zcode']))
assert.equal(partialRows.rows[0].contextWindow, 131072, 'a failed resolve keeps the honest fallback')
assert.equal(partialRows.rows[1].contextWindow, 64000)

// 无 llm 时安全返回
assert.deepEqual(await readChannelRosters(undefined, new Set()), { rows: [], providers: [] })
// listProviders 抛错时安全返回
assert.deepEqual(await readChannelRosters({ listProviders: () => { throw new Error('x') } }, new Set(['z'])), { rows: [], providers: [] })

console.log('channel-catalog: all assertions passed')

// ── 与 combos 的接线：渠道条目可以作为链成员，且容量取交集 ──────────────
import { buildComboCatalog, normalizeCombos } from '../src/combos.js'
import { buildChannelCatalog as buildCC } from '../src/channel-catalog.js'

const channelRows = buildCC([
  { provider: 'zcode', models: [{ id: 'GLM-5.3', contextWindow: 200000, maxOutput: 16000, inputModalities: ['text', 'image'] }] },
])
const catalog = [
  { id: 'deepseek-v4.1-flash-free', name: 'free', channel: undefined, vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 384000 },
  ...channelRows,
]
const [combo] = buildComboCatalog(normalizeCombos([{ name: 'mix', models: ['deepseek-v4.1-flash-free', 'channel:zcode/GLM-5.3'] }]), catalog)
assert.ok(combo, 'a chain may mix a free-lane model with a channel model')
assert.deepEqual(combo.combo, ['deepseek-v4.1-flash-free', 'channel:zcode/GLM-5.3'])
assert.equal(combo.contextWindow, 200000, 'capacity is the intersection, not the head')
assert.equal(combo.maxOutput, 16000)
assert.equal(combo.vision, true, 'both members accept images, so the chain does too')
assert.deepEqual(combo.lanes, ['free', 'channel:zcode'], 'lanes name the real providers')

const textOnly = buildCC([{ provider: 'kuku', models: [{ id: 'text-only', inputModalities: ['text'] }] }])
const [mixed] = buildComboCatalog(normalizeCombos([{ name: 'v', models: ['deepseek-v4.1-flash-free', 'channel:kuku/text-only'] }]), [...catalog, ...textOnly])
assert.equal(mixed.vision, false, 'one text-only member must clear vision for the whole chain')

console.log('channel-catalog: combo interop passed')
