/**
 * 「模型分组」的离线用例（用户 2026-11-18：配置页 + 自选模型组成新的 provider）。
 *
 * 这一层最容易出的事故不是「少列一个模型」，而是**把插件注册搞挂**：
 * 分组 id 会原样交给 `registerAdapter`，撞上已有 provider 就是
 * `DUPLICATE_ADAPTER`，整个插件在那次 reload 里注册不上。所以这里的断言多数
 * 是「什么必须被拒」。
 *
 * 覆盖：
 * 1. `normalizeCustomProviders` —— 存盘值/API 值都可能被手改，坏形状要静默规整；
 * 2. `validateProviderGroups` —— API 层要 400，而不是默默存下来；
 * 3. `computeMembership` —— 分组真的要广播，且仍受用户黑名单约束；
 * 4. 适配器的 `providerInfo` / `listModels` —— 名字与「收起默认分组」的广告行为。
 *
 * 运行：`node scripts/custom-providers-test.mjs`
 */
import assert from 'node:assert/strict'
import {
  CUSTOM_PROVIDER_LIMIT,
  normalizeCustomProviders,
  validateProviderGroups,
} from '../src/store.js'
import { computeMembership } from '../src/core/runtime.js'
import { FreeModelAdapter } from '../src/adapter.js'

const group = (id, name, models) => ({ id, name, models })

// ── 1. 规整：坏形状静默丢掉，好形状原样留下 ───────────────────────────────────
assert.deepEqual(normalizeCustomProviders(undefined), [])
assert.deepEqual(normalizeCustomProviders('nope'), [])
assert.deepEqual(normalizeCustomProviders({ id: 'ofm-a' }), [])

const kept = normalizeCustomProviders([
  group('ofm-daily', '  日常  ', ['merged:glm-5.3', 'merged:glm-5.3', 'free:qwen']),
])
assert.equal(kept.length, 1)
assert.equal(kept[0].name, '日常', '名字要去掉首尾空白')
assert.deepEqual(kept[0].models, ['merged:glm-5.3', 'free:qwen'], '模型去重')

// 撞上别家 provider 的 id 必须被拒：前缀是防 DUPLICATE_ADAPTER 的唯一手段
for (const bad of ['qoder', 'codearts', 'our-free-model', 'our-free-model-region', 'ofm-a', 'OFM-daily', 'ofm_ daily', '']) {
  assert.deepEqual(normalizeCustomProviders([group(bad, 'x', ['m'])]), [], `id ${JSON.stringify(bad)} must be rejected`)
}

// 名字空、模型空 → 整条丢掉（留在选择器里就是个点不开的空分组）
assert.deepEqual(normalizeCustomProviders([group('ofm-empty', '   ', ['m'])]), [])
assert.deepEqual(normalizeCustomProviders([group('ofm-nomodel', '名字', [])]), [])
assert.deepEqual(normalizeCustomProviders([group('ofm-badmodel', '名字', ['', 42])]), [])

// 超长名字截断而不是丢弃：用户敲了 60 个字，意图是清楚的
const longName = normalizeCustomProviders([group('ofm-longer', 'x'.repeat(60), ['m'])])
assert.equal(longName[0].name.length, 40)

// 数量上限：超过就截断，剩下的丢掉
const many = Array.from({ length: CUSTOM_PROVIDER_LIMIT + 3 }, (_, index) =>
  group(`ofm-group-${index}`, `分组 ${index}`, ['m']))
assert.equal(normalizeCustomProviders(many).length, CUSTOM_PROVIDER_LIMIT)

// 重复 id：只留第一条（同 id 两条会让 registerAdapter 直接失败）
const duplicated = normalizeCustomProviders([group('ofm-same1', '一', ['a']), group('ofm-same1', '二', ['b'])])
assert.equal(duplicated.length, 1)
assert.equal(duplicated[0].name, '一')

// ── 2. 校验：API 层要么吃下，要么 400 ────────────────────────────────────────
const rejects = (patch, why) => {
  assert.throws(() => validateProviderGroups(patch), error => error.statusCode === 400, why)
}
rejects(null, 'null patch')
rejects([], 'array patch')
rejects({ customProviders: 'nope' }, 'groups must be an array')
rejects({ customProviders: many }, 'too many groups')
rejects({ customProviders: [group('qoder', '名', ['m'])] }, 'id must carry the ofm- prefix')
rejects({ customProviders: [group('ofm-xx1', '', ['m'])] }, 'empty name')
rejects({ customProviders: [group('ofm-xx1', 'y'.repeat(41), ['m'])] }, 'name too long')
rejects({ customProviders: [group('ofm-xx1', '名', 'm')] }, 'models must be an array')
rejects({ customProviders: [group('ofm-xx1', '名', [''])] }, 'model ids must be nonempty')
rejects({ hideBaseGroup: 'yes' }, 'hideBaseGroup must be a boolean')

// 合法的补丁：只保留认识的键，值是被规整过的
const patch = validateProviderGroups({
  customProviders: [group('ofm-daily', '日常', ['merged:glm-5.3'])],
  hideBaseGroup: true,
  somethingElse: 'ignored',
})
assert.deepEqual(Object.keys(patch).sort(), ['customProviders', 'hideBaseGroup'])
assert.equal(patch.customProviders[0].id, 'ofm-daily')
assert.equal(patch.hideBaseGroup, true)
assert.deepEqual(validateProviderGroups({}), {}, '空补丁 = 不动任何东西')

// ── 3. 广播：分组真的进了 membership，且仍受黑名单约束 ────────────────────────
const catalog = [
  { id: 'free:qwen', name: 'Qwen', contextWindow: 32768, maxOutput: 8192 },
  { id: 'merged:glm-5.3', name: 'GLM-5.3', channel: 'merged', merged: [], contextWindow: 131072, maxOutput: 32768 },
  { id: 'channel:qoder/gmodel', name: 'GLM-5.3', channel: 'channel:qoder/gmodel' },
]
const noProbe = {}

// 没配分组：只有默认路由，和以前一模一样
assert.deepEqual(
  Object.keys(computeMembership(catalog, noProbe, {})).sort(),
  ['our-free-model'].sort(),
)

const withGroup = computeMembership(catalog, noProbe, {
  customProviders: [
    group('ofm-daily', '日常', ['merged:glm-5.3', 'free:qwen']),
    group('ofm-gone1', '已下架', ['merged:not-there']),
  ],
})
assert.deepEqual(withGroup['ofm-daily'], ['merged:glm-5.3', 'free:qwen'])
assert.equal(withGroup['ofm-gone1'], undefined, '全是目录里没有的模型 → 整条不广播')

// 渠道行可以点名进分组（用户明确要某一家的型号）
const channelPick = computeMembership(catalog, noProbe, {
  customProviders: [group('ofm-pick1', '单点', ['channel:qoder/gmodel'])],
})
assert.deepEqual(channelPick['ofm-pick1'], ['channel:qoder/gmodel'])
assert.equal(channelPick['our-free-model'].includes('channel:qoder/gmodel'), false, '渠道行仍不在默认路由里')

// 黑名单仍生效：用户拉黑的模型不该借分组回到选择器
const hidden = computeMembership(catalog, noProbe, {
  hiddenModelIds: ['merged:glm-5.3'],
  customProviders: [group('ofm-daily', '日常', ['merged:glm-5.3', 'free:qwen'])],
})
assert.deepEqual(hidden['ofm-daily'], ['free:qwen'])

// 总开关关闭时，免费车道在分组里同样消失（isModelHidden 的口径一致）
const paused = computeMembership(catalog, noProbe, {
  enabled: false,
  customProviders: [group('ofm-daily', '日常', ['merged:glm-5.3', 'free:qwen'])],
})
assert.deepEqual(paused['ofm-daily'], ['merged:glm-5.3'])

// 坏形状的分组不会让目录重建抛错
assert.doesNotThrow(() => computeMembership(catalog, noProbe, { customProviders: 'garbage' }))

// ── 3b. 启停：enabled:false 只掐广告，不掐路由 ────────────────────────────────
const offGroup = group('ofm-daily', '日常', ['merged:glm-5.3', 'free:qwen'])
// 规整时缺省 enabled 视为 true —— 旧存档没有这个字段，全部应当继续工作
assert.equal(normalizeCustomProviders([offGroup])[0].enabled, true)
const toggled = normalizeCustomProviders([{ ...offGroup, enabled: false }])
assert.equal(toggled[0].enabled, false)

// 关闭的分组不广播任何模型（选择器里整组消失）
const offMembership = computeMembership(catalog, noProbe, {
  customProviders: [{ ...offGroup, enabled: false }],
})
assert.equal(offMembership['ofm-daily'], undefined, 'a disabled group broadcasts nothing')

// 同一批里开与关可以混着：启用的照常，停用的不出现
const mixedMembership = computeMembership(catalog, noProbe, {
  customProviders: [
    { ...offGroup, enabled: false },
    group('ofm-work11', '工作', ['merged:glm-5.3']),
  ],
})
assert.deepEqual(mixedMembership['ofm-work11'], ['merged:glm-5.3'])
assert.equal(mixedMembership['ofm-daily'], undefined)

// enabled 形状不对 → API 层 400（写盘前拦住，UI 有得解释）
rejects({ customProviders: [{ ...offGroup, enabled: 'yes' }] }, 'enabled must be a boolean')

// ── 4. 广告：名字取自配置，默认分组可收起 ────────────────────────────────────
const makeAdapter = settings => new FreeModelAdapter({
  state: () => ({
    catalog,
    membership: {
      'our-free-model': ['free:qwen'],
      'ofm-daily': ['merged:glm-5.3'],
    },
    settings,
    attributionUserAgent: 'test',
  }),
})

// providerInfo：分组用自己的名字，别的一律回落内置标签
assert.equal(makeAdapter({ customProviders: [group('ofm-daily', '日常', ['merged:glm-5.3'])] }).providerInfo('ofm-daily').name, '日常')
assert.equal(makeAdapter({}).providerInfo('ofm-daily').name, 'ofm-daily', '配置里没有就回落成 id')
assert.equal(makeAdapter({}).providerInfo('our-free-model').name.length > 0, true)
// id 必须原样回传，否则 registerAdapter 的 prepareRoutes 会拒掉整批路由
assert.equal(makeAdapter({}).providerInfo('ofm-daily').id, 'ofm-daily')

// listModels：分组只列自己那几个模型
const listed = await makeAdapter({ customProviders: [group('ofm-daily', '日常', ['merged:glm-5.3'])] }).listModels('ofm-daily')
assert.deepEqual(listed.map(row => row.id), ['merged:glm-5.3'])
assert.equal(listed[0].provider, 'ofm-daily', 'provider 字段要回填成这条路由')

// 收起默认分组：只在「有分组 + 开了开关 + 是默认路由」时发生
const hiddenBase = { customProviders: [group('ofm-daily', '日常', ['merged:glm-5.3'])], hideBaseGroup: true }
assert.deepEqual(await makeAdapter(hiddenBase).listModels('our-free-model'), [])
assert.deepEqual(await makeAdapter(hiddenBase).listModels('our-free-model-region'), [])
assert.deepEqual((await makeAdapter(hiddenBase).listModels('ofm-daily')).map(row => [row.provider, row.id, row.name]), [['ofm-daily', 'merged:glm-5.3', 'GLM-5.3']])

// 没有分组时绝不收起：否则选择器就空了
assert.equal((await makeAdapter({ hideBaseGroup: true }).listModels('our-free-model')).length, 1)
// 开关关着也不收起
assert.equal((await makeAdapter({ customProviders: hiddenBase.customProviders }).listModels('our-free-model')).length, 1)

// ── 4b. 停用的广告与名字 ──────────────────────────────────────────────────────
// listModels：关闭的分组返回空 —— 选择器丢空组，整个分组从选择器消失
const offAdapter = makeAdapter({ customProviders: [{ ...offGroup, enabled: false }] })
assert.deepEqual(await offAdapter.listModels('ofm-daily'), [], 'a disabled group lists no models')

// providerInfo：名字带「（已关闭）」—— 路由仍在注册表里（老会话还能发），
// 名字里的标记是宿主侧能看出「这组现在是关的」的唯一位置
const info = offAdapter.providerInfo('ofm-daily')
assert.equal(info.id, 'ofm-daily', 'id must survive untouched')
assert.ok(info.name.endsWith('（已关闭）'), `name marks the disabled state: ${info.name}`)

// 启用的分组不带标记
const onAdapter = makeAdapter({ customProviders: [offGroup] })
assert.equal(onAdapter.providerInfo('ofm-daily').name, '日常')

console.log('custom-providers-test: ok')
