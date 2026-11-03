import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { computeMembership } from '../src/core/runtime.js'
import { isModelHidden, publicModelVisibility, validateModelVisibility } from '../src/store.js'
import { buildComboCatalog } from '../src/combos.js'
import { filterModels } from '../packages/standalone/frontend/models-data.mjs'
import { visibilityCopy } from '../packages/standalone/frontend/visibility-data.mjs'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  .replace('exports.__test = {', 'exports.__test = { Shell, FreePage, ChannelCard, DICT, Roster, ModelCard, Preferences, ModelPicker, ChainEditor, ChainCard, ChainCapacity, CheckinPanel, AnomalyPanel,')
let bundle
const window = { __ModuleLoader__: { load: value => { bundle = value } } }
let cursor = 0
const cells = []
let captureEffects = false
const effects = []
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: 'fragment',
  useState(initial) {
    const at = cursor++
    if (!(at in cells)) cells[at] = typeof initial === 'function' ? initial() : initial
    return [cells[at], value => { cells[at] = typeof value === 'function' ? value(cells[at]) : value }]
  },
  useRef(initial) { const at = cursor++; return cells[at] ??= { current: initial } },
  useEffect(effect) { if (captureEffects) effects.push(effect) },
  useMemo: callback => callback(),
  useCallback: callback => callback,
}
let release, reject
const calls = []
const fetch = async (url, options) => {
  calls.push({ url, options })
  if (url.endsWith('/combos/preview')) {
    const { models } = JSON.parse(options.body)
    const capacity = buildComboCatalog([{ id: 'combo:preview', models }], capacityModels)[0] ?? null
    return { ok: true, text: async () => JSON.stringify({ capacity }) }
  }
  return new Promise((resolve, fail) => {
    release = () => resolve({ ok: true, text: async () => '{}' })
    reject = fail
  })
}
new Function('window', 'fetch', source)(window, fetch)
const { Shell, FreePage, ChannelCard, DICT, Roster, ModelCard, Preferences, ModelPicker, ChainEditor, ChainCard, ChainCapacity } = bundle.factory(() => react).__test
const t = key => DICT.zh[key] ?? key
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes)
  : tree && typeof tree === 'object' ? [tree, ...nodes(tree.children)] : []
/**
 * 递归取出渲染树里**所有**文本片段。
 *
 * ⚠️ 不能用 `node.children.includes(text)`：文本可能在更深一层（本仓库的表格
 * 组件把 `rows` 数组直接塞进 children，于是多嵌套一层），那样断言会假红。
 */
const texts = tree => Array.isArray(tree) ? tree.flatMap(texts)
  : typeof tree === 'string' || typeof tree === 'number' ? [String(tree)]
  : tree && typeof tree === 'object' ? texts(tree.children) : []
const render = (Component, props) => { cursor = 0; return Component(props) }
let summaryReads = 0, statsReads = 0
const props = {
  t, data: { catalog: [], settings: {} }, counts: {}, busy: false,
  summary: { status: 'ready', reload: () => { summaryReads++ } },
  stats: { reload: () => { statsReads++ } },
  setBusy: () => assert.fail('catalog requests must not lock settings writes'),
}
const page = () => nodes(render(Shell, props)).find(node => node.type === FreePage)
const first = page().props.reprobe()
const duplicate = page().props.refresh()
assert.equal(calls.length, 1, 'a pending probe excludes duplicate catalog operations')
assert.equal(page().props.catalogBusy, true)
assert.equal(page().props.busy, false, 'other settings remain available while probing')
await duplicate
release()
await first
assert.equal(page().props.catalogBusy, false)
assert.equal(summaryReads, 1)
assert.equal(statsReads, 1)
const failed = page().props.reprobe()
reject(new Error('isolated probe failure'))
await failed
assert.equal(page().props.catalogBusy, false, 'failure must release the probe controls')
const retry = page().props.refresh()
assert.equal(calls.length, 3, 'a failed probe can be retried')
release()
await retry

cells.length = 0
let models = [{ id: 'retired', dead: true, disabled: true }]
let accounts = [{ id: 'account', nickname: 'Fixture', enabled: true }]
const rpcCalls = []
let changed = 0
const channelProps = {
  t, channel: { id: 'codearts', name: 'CodeArts' }, status: {},
  onError: (_provider, error) => { throw error },
  onChanged: () => { changed++ },
  rpc: async (method, payload) => {
    rpcCalls.push({ method, payload })
    if (method === 'model.clearDead') models = models.map(model => ({ ...model, dead: false }))
    if (method === 'model.setDisabled') models = models.map(model => ({ ...model, disabled: payload.disabled }))
    if (method === 'account.update') accounts = accounts.map(row => ({ ...row, ...payload.patch }))
    return { models, accounts }
  },
}
const button = (tree, text) => nodes(tree).find(node => node.type === 'button' && node.children.includes(text))
let card = render(ChannelCard, channelProps)
await button(card, '模型').props.onClick()
card = render(ChannelCard, channelProps)
assert.ok(nodes(card).some(node => node.children.includes('已隐藏')))
await button(card, '恢复显示').props.onClick()
assert.equal(rpcCalls.find(call => call.method === 'model.clearDead').payload.modelId, 'retired')
assert.equal(models[0].disabled, true, 'restoring a retired model preserves the user blacklist')
assert.equal(rpcCalls.some(call => call.method === 'model.setDisabled'), false)
card = render(ChannelCard, channelProps)
await button(card, '开启').props.onClick()
assert.equal(models[0].disabled, false)
card = render(ChannelCard, channelProps)
await button(card, '账号').props.onClick()
card = render(ChannelCard, channelProps)
assert.ok(nodes(card).some(node => node.children.includes('已启用')))
await button(card, '停用').props.onClick()
card = render(ChannelCard, channelProps)
assert.ok(nodes(card).some(node => node.children.includes('已停用')))
assert.ok(button(card, '启用'))
assert.equal(changed, 3)
console.log('ok  client probe isolation/retry, account action labels, hidden status and retired model restoration')

/*
 * 「今日已领」徽标（用户 2026-10-28）。
 *
 * 用户原话：「像 WorkBuddy 国内版一样，在账号列表界面，显示今日已领 xxx 积分，
 * 所有支持签到的渠道都这样改」。此前后端只有 `buddy` / `minimax` 的 credits API
 * 会回 `today_credit`，其余渠道恒为 0 —— 于是徽标只在那两个渠道出现。
 * 现在改由**逐账号签到台账**（`usage.autoCheckin().results`）供给，故这里用
 * `codearts`（一个本来没有 todayCredit 的渠道）来锁行为。
 */
{
  cells.length = 0
  // `credits.balances` 必须回一个真实余额：增量「(+200)」是拼在余额徽标里的，
  // 没有余额就整块不渲染，断言会假绿。
  const ledgerRpc = async method => method === 'credits.balances'
    ? { accounts: [{ accountId: 'account', balance: { total: 12345 } }] }
    : { models, accounts }
  const claimedCard = async auto => {
    cells.length = 0
    const base = {
      t, channel: { id: 'codearts', name: 'CodeArts' }, status: {}, rpc: ledgerRpc,
      auto, onError: (_provider, error) => { throw error }, onChanged: () => {},
    }
    const view = render(ChannelCard, base)
    // 账号折叠默认收起（`open` 初值 null）；展开动作本身是 async 的
    // （`toggleFold` 里直接 await loadAccounts），必须 await 后再渲染。
    const fold = nodes(view).find(node => node.type === 'button' && texts(node).includes('账号'))
    assert.ok(fold, '账号折叠开关必须存在')
    await fold.props.onClick()
    // `toggleFold` 里 `loadBalances()` 是 `void` 起的（回车即走），而余额徽标要等它
    // resolve 才渲染 —— 多排两轮微任务再渲染，否则读到的是「加载中」。
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    return render(ChannelCard, base)
  }

  // ① 台账里有今天 claimed 的行 ⇒ 显示「今日已领 1,000」（千分位）
  const withLedger = await claimedCard({
    results: [{ provider: 'codearts', accountId: 'account', accountName: 'Fixture', outcome: 'claimed', amount: 1000, unit: 'credit' }],
  })
  assert.ok(texts(withLedger).some(text => text.includes('(+1,000)')),
    '台账里有今天的领取记录时，余额徽标必须带「(+1,000)」增量')
  assert.equal(texts(withLedger).some(text => text.includes('今日已领')), false,
    '独立的「今日已领」徽标必须已经删掉（用户 2026-10-28：太挤了）')

  // ② token 与积分量纲不同：token 走 M/K 缩写并带单位
  const tokenLedger = await claimedCard({
    results: [{ provider: 'codearts', accountId: 'account', accountName: 'Fixture', outcome: 'claimed', amount: 100000000, unit: 'token' }],
  })
  assert.ok(texts(tokenLedger).some(text => text.includes('(+100.0Mtoken)')), 'token 必须用 M 缩写并带 token 单位')

  // ③ 只有 already-claimed / failed ⇒ 不显示徽标（没领到就不该写「已领」）
  const alreadyOnly = await claimedCard({
    results: [{ provider: 'codearts', accountId: 'account', accountName: 'Fixture', outcome: 'already-claimed', amount: 0, unit: 'credit' }],
  })
  assert.equal(texts(alreadyOnly).some(text => text.includes('(+')), false,
    '当天只「已领过」而没有新领取时不得显示增量')

  // ④ 台账里是别的渠道的行 ⇒ 不能串到本卡片
  const otherProvider = await claimedCard({
    results: [{ provider: 'workbuddy', accountId: 'account', accountName: 'Fixture', outcome: 'claimed', amount: 999, unit: 'credit' }],
  })
  assert.equal(texts(otherProvider).some(text => text.includes('(+')), false,
    '其它渠道的领取记录不得串到本渠道卡片上')
  /*
   * ⚠️ 必须把本块的异步尾巴排空再清空 `cells`。
   *
   * ChannelCard 的折叠动作里有 `void loadCredits()` / `void loadBalances()` ——
   * 它们在本块结束后才 resolve，回调会写回 `cells` 里 ChannelCard 的槽位。
   * 而 `render()` 只重置游标、不清数组，后面的 ChainEditor 用例会读到**别的
   * 组件残留的** useState 槽位（实测：`capacity` 变 null，断言直接崩）。
   */
  await new Promise(resolve => setImmediate(resolve))
  cells.length = 0
  effects.length = 0
}
console.log('ok  today-claimed amount is folded into the balance badge for every claim-capable channel')

const catalog = [
  { id: 'free' }, { id: 'region' }, { id: 'kilo', channel: 'kilo' },
  { id: 'aggregate', channel: 'aggregate' },
  { id: 'combo', channel: 'combo' }, { id: 'account', channel: 'buddy' },
]
const refused = { results: { free: { state: 'unavailable' }, region: { state: 'unavailable' } } }
const membership = settings => Object.values(computeMembership(catalog, refused, settings)).flat()
assert.deepEqual(membership({}), catalog.map(row => row.id), 'default fallback preserves the advertised catalog')
assert.deepEqual(membership({ hideFreeModels: true }), ['aggregate', 'combo', 'account'])
assert.deepEqual(membership({ hiddenModelIds: ['free'] }), ['region', 'kilo', 'aggregate', 'combo', 'account'])
assert.deepEqual(membership({ hideFreeModels: true, hiddenModelIds: ['combo'] }), ['aggregate', 'account'],
  'refusedAll cannot restore preferences; unrelated channels remain isolated')
const region = computeMembership(catalog, { results: { region: { state: 'region-blocked' } } }, { hiddenModelIds: ['region'] })
assert.equal(Object.values(region).flat().includes('region'), false)
for (const patch of [{ hideFreeModels: 1 }, { hiddenModelIds: [''] }, { hiddenModelIds: [3] }, null, []]) {
  assert.throws(() => validateModelVisibility(patch), error => error.statusCode === 400)
}
assert.deepEqual(publicModelVisibility({ hiddenModelIds: ['free', 'free', null], forwardKey: 'private' }),
  { hiddenModelIds: ['free'], hideFreeModels: false })
// 渠道模型的 provider 就是它自己（`channel:raccoon/...`），宿主的选择器里
// 已经有那一组。再以本插件的 route 广播一遍，同一批模型会多出一份 ——
// 用户看到「Our Free Model」底下挂着别人家的模型，以为链路把它们收了进来。
{
  const real = [
    { id: 'free-1' }, { id: 'kilo/1', channel: 'kilo' },
    { id: 'channel:raccoon/m1', channel: 'channel:raccoon' },
    { id: 'combo:mine', channel: 'combo' },
  ]
  const advertised = Object.values(computeMembership(real, {}, {})).flat()
  assert.ok(advertised.includes('free-1'), '免费车道照常广播')
  assert.ok(advertised.includes('kilo/1'), 'Kilo 是本插件自己的车道')
  assert.ok(advertised.includes('combo:mine'), '组合线路照常广播')
  assert.equal(advertised.includes('channel:raccoon/m1'), false, '渠道模型不重复广播')
  // 不广播 ≠ 不能拨：catalog 里还在，链路成员与转发网关都按 id 解析。
  assert.ok(real.some(row => row.id === 'channel:raccoon/m1'))
}

for (const language of ['zh', 'en']) {
  cells.length = 0
  const translate = key => DICT[language][key]
  const writes = []
  const summary = { settings: { hiddenModelIds: ['free'], hideFreeModels: false, hideEacModels: false },
    catalog: [{ id: 'free', name: 'Free fixture', route: null, hiddenByUser: true, availability: 'available' }] }
  const roster = render(Roster, { summary, t: translate, onApply: patch => writes.push(patch), only: 'free' })
  const row = nodes(roster).find(node => node.type === ModelCard)
  assert.ok(row, 'route:null entries must retain a recovery control')
  const card = render(ModelCard, row.props)
  const control = nodes(card).find(node => node.props.label === translate('visibility.showModel'))
  assert.equal(control.props.checked, false)
  control.props.onChange()
  assert.deepEqual(writes.pop(), { hiddenModelIds: [] })
  nodes(roster).find(node => node.props.label === translate('pref.hideFreeModels')).props.onChange()
  assert.deepEqual(writes.pop(), { hideFreeModels: true })
}
console.log('ok  visibility fallback isolation, validation, recovery controls and bilingual plugin actions')

const capacityModels = [
  { id: 'large', name: 'Large', contextWindow: 1000000, maxOutput: 64000, vision: true },
  { id: 'small', name: 'Small', contextWindow: 128000, maxOutput: 16000, vision: false },
]
cells.length = 0
// 供应商分组默认折叠，模型行不渲染，所以先断言「折叠态」再点开：
// 折叠时只看得到组头（供应商名 + 数量），这正是默认视图该有的样子。
let picker = render(ModelPicker, { t, models: capacityModels, chosen: [], onPick() {} })
const groupHead = nodes(picker).find(node => node.type === 'button' && node.props['aria-expanded'] === 'false')
assert.ok(groupHead, 'provider groups start collapsed')
assert.equal(
  nodes(picker).filter(node => node.props.className === 'ofm_pickrow').length, 0,
  'a collapsed group renders no model rows',
)
groupHead.props.onClick()
picker = render(ModelPicker, { t, models: capacityModels, chosen: [], onPick() {} })
assert.equal(
  nodes(picker).find(node => node.type === 'button' && node.props.className === 'ofm_pickgrouphead').props['aria-expanded'], 'true',
  'clicking the group head expands it',
)
// 候选行只显示「名称」：id/容量（2026-11-03 第一轮）与行内渠道标签（同日第二轮）
// 都已从列表移除——供应商分组标题就是渠道名，行内再挂一遍是重复信息。这里确认
// 行上只有模型名与选中勾。
const pickerRows = nodes(picker).filter(node => node.props.className === 'ofm_pickrow')
assert.equal(pickerRows.length, capacityModels.length, 'every model of the expanded group has a row')
for (const row of pickerRows) {
  assert.ok(texts(row).some(text => text === 'Large' || text === 'Small'), 'the row still names the model')
  assert.ok(!texts(row).some(text => text.includes('·')), 'no id/capacity fragment is rendered on the row')
  assert.ok(!texts(row).some(text => text.includes('渠道') || text.includes('Lane') || text.includes('ZCode') || text.includes('Kilo')),
    'no inline lane label on the row — the group heading already names the provider')
}
captureEffects = true
// ModelPicker 现在自带 useChannelRpc + 两个新槽位，必须在本段前清槽（本文件的
// 惯例：每个场景各占一套 useState 槽位）。
cells.length = 0
const editorProps = { t, models: capacityModels, chain: { name: 'Fixture', models: ['small', 'large'] } }
render(ChainEditor, editorProps)
for (const effect of effects.splice(0)) effect()
await new Promise(resolve => setImmediate(resolve))
let editor = render(ChainEditor, editorProps)
let capacity = nodes(editor).find(node => node.type === ChainCapacity).props.capacity
assert.equal(capacity.contextWindow, 128000)
assert.equal(capacity.maxOutput, 16000)
assert.equal(capacity.vision, false)
effects.length = 0
button(editor, t('routing.removeMember')).props.onClick()
render(ChainEditor, editorProps)
for (const effect of effects.splice(0)) effect()
await new Promise(resolve => setImmediate(resolve))
editor = render(ChainEditor, editorProps)
capacity = nodes(editor).find(node => node.type === ChainCapacity).props.capacity
assert.equal(capacity.contextWindow, 1000000, 'removing the small member refreshes the real intersection')
captureEffects = false
effects.length = 0
const savedCard = render(ChainCard, { t, chain: { id: 'combo:fixture', name: 'Fixture', models: ['large'] },
  resolved: ['large'], missing: [], lookup: new Map(capacityModels.map(row => [row.id, row])), capacity, onEdit() {} })
assert.equal(nodes(savedCard).find(node => node.type === ChainCapacity).props.capacity.contextWindow, 1000000)
assert.ok(nodes(ChainCapacity({ t, capacity })).some(node => node.children.includes(`${t('tag.context')} 1.0M`)))

/*
 * 已存链路的成员列表支持**拖动排序**（用户 2026-11-03）。
 *
 * 成员行的顺序就是链路的顺序，↑↓ 按钮之外直接拖行更直观。实现走 HTML5 DnD：
 * onDragStart 记下来源行，目标行的 onDrop 把它移到自己这一位。驱动真实事件
 * （不能自己再写一份「按 index 重排」—— 那测的是测试，不是组件）。
 */
{
  captureEffects = false
  cells.length = 0
  const dragProps = { t, models: capacityModels, chain: { name: 'Drag', models: ['small', 'large'] } }
  let dragEditor = render(ChainEditor, dragProps)
  let rows = nodes(dragEditor).filter(node => node.props.className === 'ofm_member')
  assert.equal(rows.length, 2, 'the fixture chain has two member rows')
  assert.ok(rows[0].props.draggable === true, 'member rows are draggable')

  // 把第 0 行（small）拖到第 1 行（large）上 → 顺序翻转为 large, small
  const target = rows[1]
  target.props.onDragStart ? null : null
  rows[0].props.onDragStart()
  target.props.onDragOver({ preventDefault() {}, currentTarget: { classList: { add() {}, remove() {} } } })
  target.props.onDrop({ currentTarget: { classList: { add() {}, remove() {} } } })
  dragEditor = render(ChainEditor, dragProps)
  const names = nodes(dragEditor).filter(node => node.props.className === 'ofm_member')
    .map(row => row.children.find(child => child.props?.className === 'ofm_id').children[0])
  assert.deepEqual(names, ['Large', 'Small'], 'dragging row 0 onto row 1 reorders the chain')

  // 拖到自己头上是无操作
  const again = nodes(dragEditor).filter(node => node.props.className === 'ofm_member')
  again[0].props.onDragStart()
  again[0].props.onDrop({ currentTarget: { classList: { add() {}, remove() {} } } })
  dragEditor = render(ChainEditor, dragProps)
  const same = nodes(dragEditor).filter(node => node.props.className === 'ofm_member')
    .map(row => row.children.find(child => child.props?.className === 'ofm_id').children[0])
  assert.deepEqual(same, ['Large', 'Small'], 'dropping a row on itself keeps the order')
}
console.log('ok  combo picker capacities, saved card and live server intersection refresh')
/*
 * 选择器是**开关**，不是追加。
 *
 * 用户报障（2026-11-03）：连点同一个模型，链里就重复出现同一个条目。原因是
 * `ChainEditor` 传给 picker 的 `onPick` 是 `[...current, id]`，只加不减；而保存时
 * `normalizeCombos` 用 Set 去重只留 1 个，于是界面显示 5 个、存下去剩 1 个。
 *
 * ⚠️ 必须驱动 **ChainEditor 里那个真实的 onPick**，不能自己再写一份开关逻辑来测：
 * 那样测的是测试自己的实现，原 bug 照样能过。
 */
{
  captureEffects = false
  cells.length = 0
  const toggleProps = { t, models: capacityModels, chain: { name: 'Toggle', models: [] } }
  /**
   * 打开选择器并返回它。
   *
   * 「添加成员」只在收起时存在；打开后那一行整行消失，选择器标题行自己带一个
   * 「✕ 收起」。所以只有第一次需要点它；之后直接读当前帧里的 ModelPicker。
   */
  const openPicker = () => {
    let tree = render(ChainEditor, toggleProps)
    let picker = nodes(tree).find(node => node.type === ModelPicker)
    if (picker === undefined) {
      // `h(Button, ...)` 在树里是 `type: <Button 函数>` 的节点，className 要等
      // Button 自身执行时才生成，所以按「children 里有那段文案」定位。
      const add = nodes(tree).find(node => typeof node.type === 'function'
        && node.children.includes(t('routing.addMember')))
      assert.ok(add, 'the add-member button is rendered while closed')
      add.props.onClick()
      tree = render(ChainEditor, toggleProps)
      picker = nodes(tree).find(node => node.type === ModelPicker)
    }
    assert.ok(picker, 'the picker is open')
    return picker
  }
  // 每次 click 后必须重新 render 才能读出新状态：组件用的是 useState 槽位，
  // 旧的树只是那一帧的快照。
  let pickerNode = openPicker()
  const target = capacityModels[0].id
  const chosenNow = () => {
    pickerNode = openPicker()
    return pickerNode.props.chosen
  }
  pickerNode.props.onPick(target)
  assert.deepEqual(chosenNow(), [target], 'first click adds the model')
  // 再点一次同一个 = 取消；这是原实现最直接的失败点
  pickerNode.props.onPick(target)
  assert.deepEqual(chosenNow(), [], 'clicking the same model again removes it')
  // 连点三次必须停在「在/不在」两态之间，绝不累积重复
  for (let i = 0; i < 3; i += 1) {
    pickerNode = openPicker()
    pickerNode.props.onPick(target)
    const current = chosenNow()
    assert.equal(new Set(current).size, current.length, 'chosen list never contains duplicates')
    assert.ok(current.length <= 1, 'repeated clicks never accumulate')
  }
  // ⚠️ 打开选择器后，表单里不能同时存在两个「取消」（用户 2026-11-03）：
  // 「添加成员」那一行整行消失，收起的入口只有选择器标题行的 ✕。
  {
    const tree = render(ChainEditor, toggleProps)
    const labels = nodes(tree).filter(node => node.children !== undefined && node.children.includes(t('routing.cancel')))
    assert.equal(labels.length, 1, 'exactly one 取消 in the editor: the picker row is gone, only the bottom cancel remains')
    // ModelPicker 是组件节点（children 要等它自己执行才存在），按同一条注释
    // 里的写法直接 render 它，再在渲染后的 DOM 里找标题行的 ✕。
    const pickerTree = nodes(render(ModelPicker, { ...pickerNode.props }))
    const close = pickerTree.find(node => node.props?.className === 'ofm_textbtn')
    assert.ok(close, 'the picker owns a 收起 control in its own heading')
    assert.ok(texts(close).includes(t('routing.pickClose')))
    assert.equal(typeof close.props.onClick, 'function', 'the 收起 control actually closes it')
  }
}
console.log('ok  model picker toggles a member instead of appending it')



/*
 * 签到结果表格 / 异常汇总的**真实渲染**冒烟。
 *
 * 为什么必须有：2026-10-27 这两个板块都出过「整个设置页白屏」——
 * `CheckinPanel` 的 `group()` 在空组时返回 `null`，而调用处写的是
 * `...group(...)`，展开 null 抛 `TypeError: not iterable`。`node --check`
 * 只验语法、lint 只验文案与类名，**都拦不住这类运行时崩溃**。
 * 故这里直接调用组件函数并断言它返回可渲染的节点。
 *
 * ⚠️ 关键用例是「只有部分分组非空」——那正是真实形态（今天没有失败渠道
 * 是常态），也是当初崩掉的那个分支。
 */
{
  const { CheckinPanel, AnomalyPanel } = bundle.factory(() => react).__test
  const channelName = id => id
  /*
   * ⚠️ 必须清空 `cells`：`render` 只重置游标，不清状态数组。前面几十个用例
   * 已经把 cells 塞满了，不清的话本组件会读到**别的组件的** useState 槽位
   * （例如 `open` 拿到一个字符串），渲染结果就与单独运行不一致。
   */
  cells.length = 0

  /**
   * 渲染 → 断言「默认折叠」→ 点开标题行 → 返回展开后的树。
   *
   * ⚠️ 两个板块自 2026-10-28 起**默认折叠**（用户要求），明细行在展开前根本
   * 不在树里。原来的断言直接读第一次渲染的文本，改完默认值就全部假红 ——
   * 这里显式把「折叠时不渲染明细」也变成一条断言，避免以后有人把默认值改
   * 回去而没人发现。
   */
  const expand = (Component, componentProps) => {
    cells.length = 0
    const collapsed = render(Component, componentProps)
    const head = nodes(collapsed).find(node => /ofm_(checkin|anomaly)head\b/.test(String(node.props.className ?? '')))
    assert.ok(head !== undefined, '折叠标题行必须存在（否则用户没法展开）')
    assert.equal(head.props['aria-expanded'], 'false', '默认必须是折叠态')
    head.props.onClick()
    return { collapsed, tree: render(Component, componentProps) }
  }

  // ① 只有 claimed（其余三组为空）—— 当初崩溃的分支
  const onlyClaimed = expand(CheckinPanel, {
    results: [{ provider: 'codearts', accountId: 'a1', accountName: '主号', outcome: 'claimed', amount: 1000, unit: 'credit' }],
    channelName, t,
  })
  assert.ok(onlyClaimed.collapsed, '只有 claimed 时表格必须渲染出来，而不是 null/崩溃')
  assert.equal(onlyClaimed.collapsed.type, 'section')
  assert.ok(!texts(onlyClaimed.collapsed).includes('+1,000'), '默认折叠时明细行不应渲染')
  assert.ok(texts(onlyClaimed.tree).includes('+1,000'), 'claimed 行必须显示带千分位的金额')
  // 绿色底徽章：复用 zcode 余量那两个类
  assert.ok(nodes(onlyClaimed.tree).some(node => String(node.props.className ?? '').includes('ofm_quotabadge')),
    '领取金额必须用绿色底徽章（与 zcode 余量同一个类）')

  // ② 只有 failed
  const onlyFailed = expand(CheckinPanel, {
    results: [{ provider: 'qoder', accountId: 'q1', accountName: 'q1', outcome: 'failed', amount: 0, unit: 'credit', message: '未开启活动' }],
    channelName, t,
  })
  assert.ok(onlyFailed.collapsed, '只有 failed 时同样不能崩')
  assert.ok(texts(onlyFailed.tree).includes('未开启活动'), '失败原因必须出现在「说明」列')

  // ③ 空数组 ⇒ 整块不渲染（不是白屏）
  assert.equal(render(CheckinPanel, { results: [], channelName, t }), null, '没有明细时整块不渲染')

  // ④ 四组齐全
  const all = expand(CheckinPanel, {
    results: [
      { provider: 'a', accountId: '1', accountName: '1', outcome: 'claimed', amount: 200, unit: 'credit' },
      { provider: 'b', accountId: '2', accountName: '2', outcome: 'already-claimed', amount: 0, unit: 'credit' },
      { provider: 'c', accountId: '3', accountName: '3', outcome: 'failed', amount: 0, unit: 'credit', message: 'x' },
      { provider: 'd', accountId: '4', accountName: '4', outcome: 'skipped', amount: 0, unit: 'credit' },
    ],
    channelName, t,
  })
  assert.equal(nodes(all.tree).filter(node => String(node.props.className ?? '').includes('ofm_checkinrow')).length, 4,
    '四个分组各一行')

  // ⑤ token 单位走 M/K 缩写，积分走千分位（两者量纲不同，不能混用一种格式）
  const tokenRow = expand(CheckinPanel, {
    results: [{ provider: 'zcode', accountId: 'z', accountName: 'z', outcome: 'claimed', amount: 100_000_000, unit: 'token' }],
    channelName, t,
  })
  assert.ok(texts(tokenRow.tree).includes('+100.0Mtoken'), 'token 必须用 M 缩写')

  // ⑥ 异常汇总同样要能渲染（同批改动，同一类风险）
  const anomaly = expand(AnomalyPanel, {
    anomalies: [{ provider: 'workbuddy', accountId: 'w', accountName: 'w', modelName: 'hy3', resetAtMs: Date.now() + 3_600_000 }],
    channelName, t,
  })
  assert.ok(anomaly.collapsed && anomaly.collapsed.type === 'section', '异常汇总必须渲染出 section')
  assert.ok(!texts(anomaly.collapsed).includes('hy3'), '默认折叠时异常明细不应渲染')
  assert.ok(texts(anomaly.tree).includes('hy3'), '展开后必须能看到被限流的模型名')
}
console.log('ok  check-in result table and anomaly panel render without crashing on partial groups')

// Compile the actual standalone page in memory, without rebuilding web output.
const require = createRequire(import.meta.url)
let transformSync
try {
  const candidate = createRequire(new URL('../packages/standalone/package.json', import.meta.url))('esbuild')
  // vfat 盘上原生二进制没有执行位：spawn EACCES 会以**异步** uncaughtException 的
  // 形态爆出来（esbuild 服务进程的 spawn 失败不走 transform 的 Promise 链），
  // try/catch 接不住。所以先探测一次，让这个进程的 uncaughtException 掉一次
  // 探测错误；之后 transform 仍会失败，但走的是同步 catch —— 借此把
  // transformSync 置空，整个 TSX 分支按「esbuild 不可用」跳过。
  let broken = false
  const onUncaught = () => { broken = true }
  process.on('uncaughtException', onUncaught)
  try { candidate.transformSync('let x: number = 1', { loader: 'ts' }) } catch { broken = true }
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setTimeout(resolve, broken ? 0 : 50))
  process.off('uncaughtException', onUncaught)
  if (broken) { console.log('  (esbuild binary not executable on this mount; TSX checks skipped)') }
  if (!broken) transformSync = candidate.transformSync
} catch {}
if (transformSync) {
const modelsSource = fs.readFileSync(new URL('../packages/standalone/frontend/models.tsx', import.meta.url), 'utf8')
const modelsBody = modelsSource.slice(modelsSource.indexOf('const availabilityNames')).replace('export function Models', 'function Models')
cells.length = 0
const standaloneSummary = { settings: { enabled: true, hiddenModelIds: [], hideFreeModels: false, hideEacModels: false },
  catalog: [{ id: 'free', name: 'Free', channel: 'anonymous', routable: true }, { id: 'account', name: 'Account', channel: 'buddy', routable: true }] }
const savedPatches = []
const context = {
  ...react, h: react.createElement, Fragment: 'fragment', providers: [], filterModels, visibilityCopy,
  document: { documentElement: { lang: 'en' } },
  defaultRangeExtractor: () => [],
  useVirtualizer: ({ count }) => ({ getTotalSize: () => count * 112,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 112 })), measureElement() {} }),
  ...Object.fromEntries(['Badge', 'Button', 'Input', 'Boxes', 'Check', 'CircleAlert', 'CircleCheck', 'Copy', 'Eye', 'EyeOff',
    'LoaderCircle', 'Play', 'RefreshCw', 'Search', 'SlidersHorizontal', 'Square', 'X'].map(name => [name, name])),
}
vm.createContext(context)
vm.runInContext(transformSync(modelsBody + '\nglobalThis.Page = Models', { loader: 'tsx', jsxFactory: 'h', jsxFragment: 'Fragment' }).code, context)
const standaloneProps = { active: true, summary: standaloneSummary, host: {
  saveSettings: async patch => {
    savedPatches.push(JSON.parse(JSON.stringify(patch)))
    Object.assign(standaloneSummary.settings, patch)
    for (const model of standaloneSummary.catalog) {
      model.hiddenByUser = isModelHidden(model, standaloneSummary.settings)
      model.hiddenByGroup = isModelHidden(model, { ...standaloneSummary.settings, hiddenModelIds: [] })
    }
  },
  refresh: async () => {}, error: error => { throw error },
} }
let standaloneTree = render(context.Page, standaloneProps)
nodes(standaloneTree).find(node => node.props['aria-label'] === 'Hide model：free').props.onClick()
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(savedPatches.pop(), { hiddenModelIds: ['free'] })
standaloneTree = render(context.Page, standaloneProps)
const group = nodes(standaloneTree).find(node => node.type === 'input' && node.props.role === 'switch')
group.props.onChange({ target: { checked: true } })
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(savedPatches.pop(), { hideFreeModels: true })
standaloneTree = render(context.Page, standaloneProps)
assert.equal(nodes(standaloneTree).find(node => node.props['aria-label'] === 'Show model：free').props.disabled, true)
assert.equal(nodes(standaloneTree).some(node => /(?:Hide|Show) model：account/.test(node.props['aria-label'] ?? '')), false)
nodes(standaloneTree).find(node => node.type === 'input' && node.props.role === 'switch').props.onChange({ target: { checked: false } })
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(Array.from(standaloneSummary.settings.hiddenModelIds), ['free'], 'group restore preserves individual choices')
standaloneTree = render(context.Page, standaloneProps)
nodes(standaloneTree).find(node => node.props['aria-label'] === 'Show model：free').props.onClick()
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(savedPatches.pop(), { hiddenModelIds: [] })
console.log('ok  standalone actual model-row and group controls save preferences and isolate account channels')
} else {
  console.log('ok  standalone TSX visibility controls skipped: esbuild is not installed')
}
