/**
 * 「按模型合并」的离线用例（用户 2026-11-18）。
 *
 * 覆盖三层，全部不碰网络：
 *
 * 1. `merged-catalog.js` 的归一化与归并 —— 这是唯一「并错了就静默给出错误
 *    模型」的地方，必须逐条钉死；
 * 2. 广告抑制包装 —— 宿主选择器建目录时**只**该看不到 `listModels`，其余
 *    成员（`listAllModels` / `resolveModel` / `prepareCall` / `stream`）必须
 *    原样透传，否则渠道设置页与实际下发会一起坏掉；
 * 3. 账号池的健康度画像 —— 「额度自动分配」的唯一依据。
 *
 * 运行：`node scripts/merged-catalog-test.mjs`
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  MERGED_PREFIX,
  buildMergedCatalog,
  canonicalModelKey,
  canonicalNameKey,
  filterRosterByAccount,
  filterRosterByProvider,
  isMergedEntry,
  mergedIdForProviderModel,
  mergedModelId,
  stripMultiplierSuffix,
} from '../src/merged-catalog.js'

/**
 * 渠道包那一侧是 TypeScript（`vendor/channel-pack/src`），本仓库**没有**运行期
 * 的 TS 加载器 —— `channel-pack-test.mjs` 用 `registerHooks` 现场转译。这里照
 * 同一套路，只为了让本用例能直接调那两个纯函数，而不是把逻辑复制一份到测试里
 * （复制出来的断言证明不了真实实现）。
 *
 * 用 `typescript` 的 `transpileModule`（只擦类型、不做类型检查）：类型检查是
 * `tsc --noEmit` 的职责，测试只需要能跑。
 */
const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const ts = (await import('typescript')).default
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.endsWith('.js')) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href
      if (fs.existsSync(fileURLToPath(url))) return { url, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) {
      const source = fs.readFileSync(fileURLToPath(url), 'utf8')
      return {
        format: 'module',
        source: ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
          fileName: fileURLToPath(url),
        }).outputText,
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})

const { withMergedAdvertisementSuppression } = await import('../vendor/channel-pack/src/merged-advertisement.ts')
const { modelLaneHealth } = await import('../vendor/channel-pack/src/account-pool.ts')

// ── 1. 归一化 ────────────────────────────────────────────────────────────────
// 大小写与分隔符统一
assert.equal(canonicalModelKey('GLM-5.3'), 'glm-5.3')
assert.equal(canonicalModelKey('glm_5.3'), 'glm-5.3')
assert.equal(canonicalModelKey('  GLM-5.3  '), 'glm-5.3')

// vendor / lane 前缀只剥一层（模型名本身可能带斜杠）
assert.equal(canonicalModelKey('cline-pass/glm-5.3'), 'glm-5.3')
assert.equal(canonicalModelKey('anthropic/claude-sonnet-5.5'), 'claude-sonnet-5.5')
assert.equal(canonicalModelKey('nvidia/nemotron-3.5-super-vl:free'), 'nemotron-3.5-super-vl:free')

// 免费标记与快照日期后缀
assert.equal(canonicalModelKey('hy4flash-free'), 'hy4flash')
assert.equal(canonicalModelKey('hy4flash'), 'hy4flash')
assert.equal(canonicalModelKey('deepseek-v4.1-flash-1017'), 'deepseek-v4.1-flash')
assert.equal(canonicalModelKey('deepseek-v4.1-flash'), 'deepseek-v4.1-flash')

// ⚠️ 保守性：只差一个真词根的模型**不能**被并到一起（并错比多几个分组糟得多）
assert.notEqual(canonicalModelKey('glm-5.3'), canonicalModelKey('glm-5.3-flash'))
assert.notEqual(canonicalModelKey('deepseek-v4-flash'), canonicalModelKey('deepseek-v4.1-flash'))
assert.notEqual(canonicalModelKey('minimax-m3'), canonicalModelKey('minimax-m3.1'))
assert.notEqual(canonicalModelKey('kimi-k3'), canonicalModelKey('kimi-k3.1-pro'))
// 版本号里的四位数字不是日期后缀（`gpt-6-2060` 是个模型名，不是快照）
assert.equal(canonicalModelKey('gpt-6-2060'), 'gpt-6-2060')

// 空输入不产生空键（空键会把所有烂行并成一条）
assert.equal(canonicalModelKey(''), '')
assert.equal(canonicalModelKey('   '), '')
assert.equal(canonicalModelKey(undefined), '')

// id 编解码
assert.equal(mergedModelId('glm-5.3'), `${MERGED_PREFIX}glm-5.3`)
assert.equal(isMergedEntry({ id: 'merged:glm-5.3' }), true)
assert.equal(isMergedEntry({ id: 'channel:trae/glm-5.3' }), false, '渠道行不是合并行')
assert.equal(isMergedEntry({ id: 'combo:x' }), false)
assert.equal(isMergedEntry(null), false)

// ── 2. 归并 ──────────────────────────────────────────────────────────────────
const roster = {
  providers: [
    { provider: 'trae', models: [{ id: 'glm-5.3', name: 'GLM-5.3' }, { id: 'DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash' }] },
    { provider: 'workbuddy', models: [{ id: 'glm-5.3', name: 'GLM-5.3' }, { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro' }] },
    { provider: 'cline', models: [{ id: 'cline-pass/glm-5.3', name: 'GLM 5.3' }, { id: 'cline-pass/glm-5.3-flash', name: 'GLM 5.3 Flash' }] },
    { provider: 'zcode', models: [{ id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash' }] },
    // 坏输入不该让整张表塌掉
    { provider: 'broken', models: [{ id: '' }, { id: '   ' }, null, { name: 'no-id' }] },
    { provider: '', models: [{ id: 'ghost' }] },
    null,
  ],
}
const entries = buildMergedCatalog(roster)
const byKey = new Map(entries.map(entry => [entry.canonicalKey, entry]))

// 同一模型跨三个渠道 → 一条，成员三个
const glm = byKey.get('glm-5.3')
assert.ok(glm !== undefined, 'glm-5.3 is merged into one row')
assert.equal(glm.merged.length, 3, 'three channels serve glm-5.3')
assert.deepEqual(
  glm.merged.map(m => m.provider).sort(),
  ['cline', 'trae', 'workbuddy'],
)
assert.equal(glm.laneCount, 3)
assert.equal(glm.name, 'GLM-5.3', 'display name prefers the human-written one')

// 不同模型不能被并
const flash = byKey.get('glm-5.3-flash')
assert.ok(flash !== undefined)
assert.notEqual(flash.id, glm.id, 'glm-5.3-flash is its own row')
assert.deepEqual(flash.merged.map(m => m.provider).sort(), ['cline', 'zcode'])

// 单成员也生成合并行（否则选择器里会冒出「按渠道」的分组标题）
const kimi = byKey.get('kimi-k3.1-pro')
assert.ok(kimi !== undefined)
assert.equal(kimi.merged.length, 1)

// 坏输入被丢掉而不是抛
assert.equal(entries.some(entry => entry.canonicalKey === ''), false)
assert.equal(entries.some(entry => entry.canonicalKey === 'ghost'), false, 'a provider id is required')

// 排序稳定（按归并键）
const keys = entries.map(entry => entry.canonicalKey)
assert.deepEqual(keys, [...keys].sort((a, b) => a.localeCompare(b)))

// 空名册 → 空目录（不是抛错）
assert.deepEqual(buildMergedCatalog(undefined), [])
assert.deepEqual(buildMergedCatalog({ providers: [] }), [])

// 旧会话迁移：渠道 id → 合并 id
assert.equal(mergedIdForProviderModel(entries, 'trae/glm-5.3'), glm.id)
assert.equal(mergedIdForProviderModel(entries, 'cline-pass/glm-5.3'), glm.id)
assert.equal(mergedIdForProviderModel(entries, 'trae/glm-5.3-flash'), flash.id)
assert.equal(mergedIdForProviderModel(entries, 'trae/does-not-exist'), undefined)

// ── 2b. 计费倍率：剥掉，不留痕 ───────────────────────────────────────────────
// 渠道包把倍率拼进展示名（各渠道形态不同），合并行背后有多家、报价各异，
// 所以名字里的那一段必须剥掉 —— 用户 2026-11-18：「完全去掉系数影响」。
assert.equal(stripMultiplierSuffix('GLM-5.3 · x1.5'), 'GLM-5.3')
assert.equal(stripMultiplierSuffix('Qwen3.8-Max · x0.5→x0.2'), 'Qwen3.8-Max')
assert.equal(stripMultiplierSuffix('MiniMax M3 （x4.0）'), 'MiniMax M3', 'loomy 远端原值：全角括号')
assert.equal(stripMultiplierSuffix('Qwen 3.8 Max (x12.0)'), 'Qwen 3.8 Max', '半角括号也认')
assert.equal(stripMultiplierSuffix('Kimi-K3 · 免费'), 'Kimi-K3', 'raccoon 的免费文案')
assert.equal(stripMultiplierSuffix('GLM-5.3'), 'GLM-5.3')
assert.equal(stripMultiplierSuffix('Spark X2.5'), 'Spark X2.5', '名字里的 X 不是后缀')
assert.equal(stripMultiplierSuffix('GLM-5.3 · 旗舰'), 'GLM-5.3 · 旗舰', '档位名不是倍率')
assert.equal(stripMultiplierSuffix(''), '')
assert.equal(stripMultiplierSuffix(undefined), '')

// 同一模型在不同渠道卖不同价 → **仍然是一条**，名字里不带任何系数
const rated = buildMergedCatalog({
  providers: [
    { provider: 'codearts', models: [{ id: 'glm-5.3', name: 'GLM-5.3 · x1.5' }] },
    { provider: 'raccoon', models: [{ id: 'GLM-5.3', name: 'GLM-5.3 · x0.8' }] },
    { provider: 'trae', models: [{ id: 'glm-5.3', name: 'GLM-5.3' }] },
  ],
})
assert.equal(rated.length, 1, 'different prices are still the same model')
assert.equal(rated[0].name, 'GLM-5.3', 'no coefficient in the merged display name')
assert.equal(/x\s*\d/i.test(rated[0].name), false)
assert.equal(rated[0].merged.length, 3)
assert.deepEqual(
  rated[0].merged.map(lane => Object.keys(lane).sort().join(',')),
  ['model,provider', 'model,provider', 'model,provider'],
  'lanes carry no multiplier field at all',
)

// 全部同价 → 后缀照样剥掉（不是「系数一致就保留」）
const uniform = buildMergedCatalog({
  providers: [
    { provider: 'a', models: [{ id: 'kimi-k3', name: 'Kimi-K3 · x1' }] },
    { provider: 'b', models: [{ id: 'kimi-k3', name: 'Kimi-K3 · x1' }] },
  ],
})
assert.equal(uniform[0].name, 'Kimi-K3')

// ── 2c. 下发排序：只看额度健康度，不看系数 ───────────────────────────────────
const { FreeModelAdapter } = await import('../src/adapter.js')
const adapter = new FreeModelAdapter({
  state: () => ({ catalog: [], membership: {}, settings: {}, attributionUserAgent: 'test' }),
})
const lane = (provider, extra = {}) => ({ provider, model: 'glm-5.3', ...extra })
const orderedEntry = (id, lanes, health, stickyTurns = 1) => ({
  id,
  name: 'GLM-5.3',
  stickyTurns,
  merged: lanes,
  laneHealth: health,
})
const providersOf = order => order.map(l => l.provider)
const freeLane = count => ({ freeAccounts: count, limitedAccounts: 0, hasAccount: true })

// 额度多的一方先走
const byQuota = orderedEntry('merged:quota', [lane('w1'), lane('w5'), lane('w3')], {
  'w1/glm-5.3': freeLane(1),
  'w5/glm-5.3': freeLane(5),
  'w3/glm-5.3': freeLane(3),
})
assert.deepEqual(providersOf(adapter.orderMergedLanes(byQuota, byQuota.merged)), ['w5', 'w3', 'w1'])

// 即便有人塞了倍率字段，也不影响次序（系数彻底不参与决策）
const priced = orderedEntry('merged:priced', [
  lane('expensive', { multiplier: 9 }),
  lane('cheap', { multiplier: 0.1 }),
], {
  'expensive/glm-5.3': freeLane(4),
  'cheap/glm-5.3': freeLane(1),
})
assert.deepEqual(providersOf(adapter.orderMergedLanes(priced, priced.merged)), ['expensive', 'cheap'])

// 全灭且解禁还没到的压队尾，不剔除（到点就该复活）
const cooling = orderedEntry('merged:cooling', [lane('dead'), lane('alive')], {
  'dead/glm-5.3': { freeAccounts: 0, limitedAccounts: 2, resetAtMs: Date.now() + 60_000, hasAccount: true },
  'alive/glm-5.3': freeLane(1),
})
assert.deepEqual(providersOf(adapter.orderMergedLanes(cooling, cooling.merged)), ['alive', 'dead'])

// 等价候选（同额度）之间轮转，stickyTurns 个回合内不动
const tie = orderedEntry('merged:tie', [lane('a'), lane('b'), lane('c')], {
  'a/glm-5.3': freeLane(1),
  'b/glm-5.3': freeLane(1),
  'c/glm-5.3': freeLane(1),
}, 2)
const first = providersOf(adapter.orderMergedLanes(tie, tie.merged))
assert.deepEqual(providersOf(adapter.orderMergedLanes(tie, tie.merged)), first, 'sticky turns hold the pick')
const seen = []
for (let turn = 0; turn < 3; turn += 1) {
  seen.push(providersOf(adapter.orderMergedLanes(tie, tie.merged)))
  adapter.orderMergedLanes(tie, tie.merged) // 跳过 sticky
}
assert.equal(new Set(seen.map(order => order[0])).size, 3, 'rotation walks through every lane')
for (const order of seen) assert.deepEqual([...order].sort(), ['a', 'b', 'c'])

// ── 2d. 不透明 id 按展示名归并 ───────────────────────────────────────────────
// qoder / qodercn 的 id 是内部代号（`gmodel`），codearts / trae 用产品名，
// 只看 id 就会在选择器里出现两条 `GLM-5.3`。展示名是渠道自己声明的
// 「这是哪个模型」，所以名字相同的必须归到一起。
assert.equal(canonicalNameKey('GLM-5.3 · x1.5'), 'glm-5.3', 'coefficient is stripped before keying')
assert.equal(canonicalNameKey('Kimi  K3'), 'kimi-k3', 'spaces collapse like separators')
assert.equal(canonicalNameKey('A/B'), 'a-b', "a slash in a name is part of the name, not a vendor prefix")
assert.equal(canonicalNameKey(''), '')
assert.equal(canonicalNameKey(undefined), '')

const alias = buildMergedCatalog({
  providers: [
    { provider: 'codearts', models: [{ id: 'glm-5.3', name: 'GLM-5.3 · x1.5' }] },
    { provider: 'qoder', models: [{ id: 'gmodel', name: 'GLM-5.3 · x0.5' }] },
    { provider: 'qodercn', models: [{ id: 'gmodel', name: 'GLM-5.3' }] },
    { provider: 'buddy', models: [{ id: 'hy4-preview', name: 'Hy4 preview' }] },
    { provider: 'workbuddy', models: [{ id: 'hy4-preview-x', name: 'Hy4 preview X' }] },
  ],
})
assert.equal(alias.length, 3, 'glm group + two distinct hy4 variants')
assert.equal(alias.filter(e => e.name.startsWith('Hy4')).length, 2, 'the -x variant stays its own row')
const mergedGlm = alias.find(entry => entry.canonicalKey === 'glm-5.3')
assert.ok(mergedGlm !== undefined, 'the group is keyed by the readable id, not the qoder codename')
assert.deepEqual(mergedGlm.merged.map(lane => lane.provider).sort(), ['codearts', 'qoder', 'qodercn'])
assert.equal(mergedGlm.name, 'GLM-5.3')
assert.equal(alias.some(entry => entry.canonicalKey === 'gmodel'), false, 'the codename never becomes the row id')

// ── 2e. 没注册账号的渠道整个丢掉 ─────────────────────────────────────────────
// 账号是 provider 级的：一家没登录，它所有模型都不该出现在选择器里。
const rosterAll = {
  providers: [
    { provider: 'logged', models: [{ id: 'glm-5.3', name: 'GLM-5.3' }] },
    { provider: 'anonymous', models: [{ id: 'glm-5.3', name: 'GLM-5.3' }, { id: 'only-here', name: 'Only Here' }] },
    { provider: 'unknown', models: [{ id: 'kimi-k3', name: 'Kimi-K3' }] },
  ],
}
const known = new Map([['logged', true], ['anonymous', false]])
const kept = filterRosterByAccount(rosterAll, provider => known.get(provider))
assert.deepEqual(kept.providers.map(row => row.provider), ['logged', 'unknown'], 'unknown ≠ missing: keep it')
assert.equal(rosterAll.providers.length, 3, 'input roster is untouched')

// 只在一家未登录渠道提供的模型 → 整条合并行消失
const afterFilter = buildMergedCatalog(kept)
assert.equal(afterFilter.some(entry => entry.canonicalKey === 'only-here'), false)
assert.deepEqual(
  afterFilter.find(entry => entry.canonicalKey === 'glm-5.3').merged.map(lane => lane.provider),
  ['logged'],
)

// 没有回调 / 空名册都不该炸
assert.deepEqual(filterRosterByAccount(rosterAll).providers.length, 3)
assert.deepEqual(filterRosterByAccount(undefined, () => false), { providers: [] })

// ── 3. 广告抑制：只掐 listModels ─────────────────────────────────────────────
const calls = []
const fakeAdapter = {
  listModels: async () => { calls.push('listModels'); return [{ id: 'glm-5.3' }] },
  listAllModels: () => { calls.push('listAllModels'); return [{ id: 'glm-5.3', name: 'GLM-5.3' }] },
  resolveModel: async (provider, model) => { calls.push('resolveModel'); return { provider, id: model } },
  prepareCall: async (provider, model) => {
    calls.push('prepareCall')
    return { stream: async function * () { yield { type: 'text-delta', text: 'ok' } } }
  },
  stream: async function * () { calls.push('stream'); yield { type: 'text-delta', text: 'ok' } },
  providerInfo: provider => ({ id: provider, name: 'Fake' }),
}
const wrapped = withMergedAdvertisementSuppression(fakeAdapter)
assert.deepEqual(await wrapped.listModels('trae'), [], 'the picker sees no models under this provider')
assert.deepEqual(await wrapped.listAllModels('trae'), [{ id: 'glm-5.3', name: 'GLM-5.3' }], 'the channel panel keeps its full catalog')
assert.deepEqual(await wrapped.resolveModel('trae', 'glm-5.3'), { provider: 'trae', id: 'glm-5.3' }, 'resolution is untouched')
assert.deepEqual(wrapped.providerInfo('trae'), { id: 'trae', name: 'Fake' }, 'identity is untouched')
// 函数身份稳定（宿主按函数身份缓存时不会失配）
assert.equal(wrapped.listModels, wrapped.listModels)
assert.equal(wrapped.listAllModels, wrapped.listAllModels)
// 真正下发：prepareCall → call.stream 必须仍然通
const call = await wrapped.prepareCall('trae', 'glm-5.3')
const chunks = []
for await (const chunk of call.stream({ provider: 'trae', model: 'glm-5.3' })) chunks.push(chunk)
assert.deepEqual(chunks, [{ type: 'text-delta', text: 'ok' }], 'dispatch still works through the wrapper')
assert.ok(calls.includes('prepareCall'), 'prepareCall reached the real adapter')

// 底层实现里的 this 仍然指向原对象（本层不劫持 this）
const selfRef = {
  value: 42,
  read() { return this.value },
  listModels: async () => [{ id: 'x' }],
}
const selfWrapped = withMergedAdvertisementSuppression(selfRef)
assert.equal(selfWrapped.read(), 42, 'methods keep their original `this`')

// ── 4. 额度健康度：只用本地硬信号 ────────────────────────────────────────────
const now = 1_000_000
const poolWith = accounts => ({
  listAllAccounts: async () => accounts,
  hasLoggedInAccount: async () => accounts.some(a => a.enabled),
})
const limited = {
  id: 'a1', provider: 'trae', enabled: true,
  modelRateLimits: { 'glm-5.3': now + 60_000 },
}
const free = { id: 'a2', provider: 'trae', enabled: true }
const expired = {
  id: 'a3', provider: 'trae', enabled: true,
  modelRateLimits: { 'glm-5.3': now - 1 },
}
const disabled = {
  id: 'a4', provider: 'trae', enabled: false,
  modelRateLimits: { 'glm-5.3': now + 60_000 },
}

// 一好一坏：还有空闲账号 → 健康，无解禁时刻（没有「全灭」）
const mixed = await modelLaneHealth(poolWith([limited, free]), 'trae', 'glm-5.3', now)
assert.equal(mixed.freeAccounts, 1)
assert.equal(mixed.limitedAccounts, 1)
assert.equal(mixed.resetAtMs, undefined, 'one free account means the lane is not cooling down')
assert.equal(mixed.hasAccount, true)

// 全部被卡：给出最早的解禁时刻
const allLimited = await modelLaneHealth(poolWith([limited, { ...limited, id: 'a5', modelRateLimits: { 'glm-5.3': now + 30_000 } }]), 'trae', 'glm-5.3', now)
assert.equal(allLimited.freeAccounts, 0)
assert.equal(allLimited.limitedAccounts, 2)
assert.equal(allLimited.resetAtMs, now + 30_000, 'the earliest release wins')

// 过期的标记等于没标记（到点就该复活，不等谁来清理）
const revived = await modelLaneHealth(poolWith([expired]), 'trae', 'glm-5.3', now)
assert.equal(revived.freeAccounts, 1)
assert.equal(revived.limitedAccounts, 0)
assert.equal(revived.resetAtMs, undefined)

// 停用的账号不参与（与选号侧一致）
const onlyDisabled = await modelLaneHealth(poolWith([disabled]), 'trae', 'glm-5.3', now)
assert.equal(onlyDisabled.freeAccounts, 0)
assert.equal(onlyDisabled.limitedAccounts, 0)

// 别的渠道的限流不该算到这家头上
const otherProvider = await modelLaneHealth(
  poolWith([{ ...limited, provider: 'buddy' }, free]),
  'trae', 'glm-5.3', now,
)
assert.equal(otherProvider.freeAccounts, 1, 'limits are per provider')

// 没有账号池 → 不判断，按健康处理（否则所有渠道都会被判死、排出随机顺序）
const noPool = await modelLaneHealth(undefined, 'trae', 'glm-5.3', now)
assert.equal(noPool.hasAccount, true)
assert.equal(noPool.freeAccounts, 0)

// 账号池抛错 → 降级为健康，绝不把异常抛给目录重建
const broken = await modelLaneHealth({ listAllAccounts: async () => { throw new Error('lapsed') } }, 'trae', 'glm-5.3', now)
assert.equal(broken.hasAccount, true)

/**
 * 被用户在渠道管理页关掉的渠道不进合并组（用户 2026-11-18：「我们聚合的
 * 模型再加个过滤，渠道管理页用户是可以关闭的」）。
 *
 * 渠道页的开关落盘的是「全部模型进黑名单 + 全部账号停用」，而合并层读的是
 * **未抑制**名册 —— 若不显式过一遍关闭状态，关掉的渠道会继续占着候选位，
 * 用户选中即失败。
 */
const twoLaneRoster = {
  providers: [
    { provider: 'codearts', models: [{ id: 'glm-5.3', name: 'GLM-5.3' }] },
    { provider: 'buddy', models: [{ id: 'glm-5.3', name: 'GLM-5.3' }] },
  ],
}
// 基线：两个渠道并成一条两候选的行
const before = buildMergedCatalog(twoLaneRoster)
assert.equal(before.length, 1)
assert.equal(before[0].laneCount, 2)

// 关掉 buddy：行还在，但只剩 codearts 一个候选
const oneOff = buildMergedCatalog(twoLaneRoster, new Set(['buddy']))
assert.equal(oneOff.length, 1)
assert.equal(oneOff[0].laneCount, 1)
assert.deepEqual(oneOff[0].merged.map(lane => lane.provider), ['codearts'])

// 全部关掉：这条行整体消失（不能留下一条没有任何候选的空行）
assert.equal(buildMergedCatalog(twoLaneRoster, new Set(['buddy', 'codearts'])).length, 0)

// 传空集合 / 不传 = 行为不变（老调用点零改动）
assert.equal(buildMergedCatalog(twoLaneRoster, new Set()).length, 1)
assert.deepEqual(buildMergedCatalog(twoLaneRoster, new Set()), before)

// 名册过滤：被关掉的渠道不进名册，其余原样保留
const filtered = filterRosterByProvider(twoLaneRoster, provider => provider === 'buddy')
assert.deepEqual(filtered.dropped, ['buddy'])
assert.deepEqual(filtered.providers.map(row => row.provider), ['codearts'])

// 判据返回 undefined（读不出来）→ 保留，冷启动不清空选择器
assert.equal(filterRosterByProvider(twoLaneRoster, () => undefined).providers.length, 2)
// 判据抛错也不该让整轮重建失败
assert.doesNotThrow(() => filterRosterByProvider(twoLaneRoster, () => { throw new Error('unready') }))

console.log('merged-catalog-test: ok')
