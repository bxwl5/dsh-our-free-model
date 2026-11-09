import assert from 'node:assert/strict'
import { CHANNEL_PREFIX, FALLBACK_CONTEXT_WINDOW, buildChannelCatalog, channelModelId, isChannelEntry, parseChannelModelId, providerOfChannel, readChannelRosters, reviveChannelCatalog, mergeChannelCatalogRows } from '../src/channel-catalog.js'

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
assert.equal(rows[0].contextWindow, FALLBACK_CONTEXT_WINDOW, 'missing contextWindow falls back')
// 前端 kilo() 用 1000 进制渲染，512000 才显示成「512K」（524288 会显示 524K）。
assert.equal(FALLBACK_CONTEXT_WINDOW, 512_000, 'the disguise renders as 512K in the UI (user 2026-11-09)')
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
  listProviders: () => [{ id: 'our-free-model' }, { id: 'zcode' }, { id: 'deepseek-official' }, { id: 'gone' }],
  listModels: async p => {
    if (p === 'gone') throw new Error('credential lapsed')
    if (p === 'zcode') return [{ id: 'GLM-5.3' }]
    return [{ id: 'should-not-appear' }]
  },
}
const errors = []
const got = await readChannelRosters(llm, new Set(['zcode', 'gone']), (p, e) => errors.push(`${p}:${e.message}`))
assert.deepEqual(got.providers, ['zcode'], 'only the provider that answered')
assert.equal(got.rows.length, 1)
assert.deepEqual(errors, ['gone:credential lapsed'], 'a lapsed channel reports but does not break the read')
assert.ok(!got.rows.some(r => r.id.includes('deepseek-official')), 'non-pack vendors are not absorbed')

// resolveModelInfo 提供真实容量时覆盖兜底值（历史报障「所有渠道模型都显示同一个兜底容量」）
const rich = {
  listProviders: () => [{ id: 'zcode' }],
  listModels: async () => [{ id: 'GLM-5.3' }, { id: 'GLM-5.3-Flash' }],
  resolveModelInfo: async (provider, model) => model === 'GLM-5.3'
    ? { context: { contextWindow: 200000 }, defaultMaxTokens: 16000 }
    : { context: { contextWindow: 128000 }, defaultMaxTokens: 8192 },
}
const enriched = await readChannelRosters(rich, new Set(['zcode']))
assert.equal(enriched.rows.length, 2)
assert.equal(enriched.rows[0].contextWindow, 200000, 'real context replaces the fallback')
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
assert.equal(partialRows.rows[0].contextWindow, FALLBACK_CONTEXT_WINDOW, 'a failed resolve keeps the honest fallback')
assert.equal(partialRows.rows[1].contextWindow, 64000)

// 无 llm 时安全返回
assert.deepEqual(await readChannelRosters(undefined, new Set()), { rows: [], providers: [] })
// listProviders 抛错时安全返回
assert.deepEqual(await readChannelRosters({ listProviders: () => { throw new Error('x') } }, new Set(['z'])), { rows: [], providers: [] })

// ── 冷启动持久化 / light 读盘回退 / 合并策略（2026-11-09 报障） ──────────
// 症状：全新安装或重启后路由里模型上下文掉回 131K，点「刷新模型列表」无效，
// 「重新获取模型」短暂修复、重启复现。根因是渠道目录行只在进程内存里，且
// light 模式只能复用进程内 previousRows（冷启动那轮还常是兜底值）。

// ① 磁盘回读：逐字段校验，损坏/非渠道行被丢弃，真值保留。
const storedRows = [
  { id: 'channel:zcode/GLM-5.3', name: 'GLM 5.3', channel: 'channel:zcode', vision: false, reasoning: true, contextWindow: 1_000_000, maxOutput: 128000, canDisableThinking: false, regionSensitive: false, providerModel: 'GLM-5.3', provider: 'zcode' },
  { id: 'channel:qoder/auto', name: 'Auto', channel: 'channel:qoder', contextWindow: 200000, maxOutput: 8192, providerModel: 'auto', provider: 'qoder' },
  { id: 'not-a-channel', channel: 'free', contextWindow: 999 },
  { id: 'channel:zcode/GLM-5.3', channel: 'channel:zcode', contextWindow: 1 }, // 重复 id
  null, 'garbage',
]
const revived = reviveChannelCatalog(storedRows)
assert.equal(revived.length, 2, 'revive keeps well-formed unique channel rows')
assert.equal(revived[0].contextWindow, 1_000_000, 'persisted true capacity survives a restart')
assert.equal(revived[1].maxOutput, 8192)
assert.equal(reviveChannelCatalog([{ id: 'channel:z/x', channel: 'channel:z', contextWindow: -5 }])[0].contextWindow, FALLBACK_CONTEXT_WINDOW, 'a bad capacity falls back rather than going negative')

// ② light 模式：previousRows 是冷启动的残缺兜底，磁盘缓存必须补上真值。
const coldLlm = {
  listProviders: () => [{ id: 'zcode' }],
  listModels: async () => [{ id: 'GLM-5.3' }],
  // 完整扫描才会调用；light 绝不能调它。
  resolveModelInfo: async () => { throw new Error('light must not resolve') },
}
const coldPrevious = [{ id: 'channel:zcode/GLM-5.3', contextWindow: FALLBACK_CONTEXT_WINDOW, maxOutput: 32768 }]
const coldRows = await readChannelRosters(coldLlm, new Set(['zcode']), undefined, {
  light: true, previousRows: coldPrevious, cachedRows: revived,
})
assert.equal(coldRows.rows[0].contextWindow, 1_000_000, 'light reads the persisted true capacity, not the in-memory placeholder')
assert.equal(coldRows.rows[0].maxOutput, 128000, 'and the persisted maxOutput')

// ③ 伪装值不得回灌：磁盘若存的是占位符，不能覆盖进程内真值。
const placeholderCache = [{ id: 'channel:zcode/GLM-5.3', contextWindow: 131_072, maxOutput: 32768 }]
const realPrevious = [{ id: 'channel:zcode/GLM-5.3', contextWindow: 1_000_000, maxOutput: 128000 }]
const guarded = await readChannelRosters(coldLlm, new Set(['zcode']), undefined, {
  light: true, previousRows: realPrevious, cachedRows: placeholderCache,
})
assert.equal(guarded.rows[0].contextWindow, 1_000_000, 'the old 131072 placeholder never overwrites a real value')

// ④ 合并：只扫到部分 provider 时，未扫到的磁盘真值整家保留；
//    扫到的行若是伪装值、磁盘有真值则回填；新模型不被旧缓存挡住。
const disk = [
  { id: 'channel:zcode/GLM-5.3', channel: 'channel:zcode', provider: 'zcode', contextWindow: 1_000_000 },
  { id: 'channel:qoder/auto', channel: 'channel:qoder', provider: 'qoder', contextWindow: 200000 },
]
const partialFresh = [
  { id: 'channel:zcode/GLM-5.3', channel: 'channel:zcode', provider: 'zcode', contextWindow: FALLBACK_CONTEXT_WINDOW },
  { id: 'channel:zcode/GLM-5.3-Flash', channel: 'channel:zcode', provider: 'zcode', contextWindow: 262144 },
]
const merged = mergeChannelCatalogRows(partialFresh, disk, ['zcode'])
assert.equal(merged.length, 3, 'unscanned provider keeps its row; a new model joins')
assert.equal(merged.find(r => r.id === 'channel:zcode/GLM-5.3').contextWindow, 1_000_000, 'a placeholder in the fresh scan is backfilled from disk')
assert.equal(merged.find(r => r.id === 'channel:qoder/auto').contextWindow, 200000, 'the provider the budget skipped is not wiped')
assert.equal(merged.find(r => r.id === 'channel:zcode/GLM-5.3-Flash').contextWindow, 262144)
// 空扫描（包未挂载 / 预算 0）不得清空磁盘。
assert.equal(mergeChannelCatalogRows([], disk, []).length, 2, 'an empty scan never wipes the persisted cache')

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

const textOnly = buildCC([{ provider: 'gone', models: [{ id: 'text-only', inputModalities: ['text'] }] }])
const [mixed] = buildComboCatalog(normalizeCombos([{ name: 'v', models: ['deepseek-v4.1-flash-free', 'channel:gone/text-only'] }]), [...catalog, ...textOnly])
assert.equal(mixed.vision, false, 'one text-only member must clear vision for the whole chain')

console.log('channel-catalog: combo interop passed')
