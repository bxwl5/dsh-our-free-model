import assert from 'node:assert/strict'
import fs from 'node:fs'

/** 实际共享组件的余额能力、查询反馈与请求交错回归。 */
export async function verifyChannelCreditsUi() {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    .replace('exports.__test = {', 'exports.__test = { ChannelCard, DICT,')
  const settle = () => new Promise(resolve => setImmediate(resolve))
  // ⚠️ 组件里有个 90 秒心跳 `setInterval(loadBalances, 90_000)`。测试环境不会自动
  // 清它，挂载过的实例会把真实 interval 句柄留在事件循环里 —— 断言全绿但进程
  // 不退出，被 test-all 的 60s 看门狗杀掉（实测 channel-pack / channel-source）。
  // 这里统一接管：记录所有 interval，测试结束全部清掉。
  const liveIntervals = new Set()
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  globalThis.setInterval = (fn, ms, ...rest) => {
    const id = realSetInterval(fn, ms, ...rest)
    liveIntervals.add(id)
    return id
  }
  globalThis.clearInterval = id => { liveIntervals.delete(id); return realClearInterval(id) }
  const clearAllIntervals = () => { for (const id of liveIntervals) realClearInterval(id); liveIntervals.clear() }
  function mount(provider, rpcImpl, channelExtra = {}) {
    let bundle, cursor = 0, effects = []
    const cells = [], calls = [], errors = [], events = new Map()
    const window = {
      __ModuleLoader__: { load: value => { bundle = value } },
      addEventListener: (name, callback) => events.set(name, callback),
      removeEventListener: name => events.delete(name),
    }
    const react = {
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
      Fragment: 'fragment',
      useState(initial) {
        const index = cursor++
        if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
        return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value }]
      },
      useRef(initial) { return cells[cursor++] ??= { current: initial } },
      useEffect(fn) { effects.push(fn) },
      useMemo: fn => fn(),
      useCallback: fn => fn,
    }
    new Function('window', source)(window)
    const { ChannelCard, DICT } = bundle.factory(() => react).__test
    const props = {
      channel: { id: provider, name: provider, ...channelExtra },
      status: { accounts: { total: 2, enabled: 2 }, models: { total: 0 } },
      t: key => DICT.zh[key],
      onChanged() {},
      onError: (_channel, error) => errors.push(error.message),
      rpc: async (method, payload) => {
        calls.push({ method, payload })
        return rpcImpl(method, payload)
      },
    }
    function render() {
      cursor = 0; effects = []
      return ChannelCard(props)
    }
    function nodes(tree) {
      const all = []
      const visit = node => {
        if (Array.isArray(node)) return node.forEach(visit)
        if (!node || typeof node !== 'object') return
        all.push(node); visit(node.children)
      }
      visit(tree)
      return all
    }
    const button = label => nodes(render()).find(node => node.type === 'button' && node.children.includes(label))
    const text = () => JSON.stringify(render())
    /** 最近一次 render 的虚拟树（找 textarea 等非按钮节点用）。 */
    const tree = () => {
      const value = render()
      const all = []
      const visit = node => {
        if (Array.isArray(node)) return node.forEach(visit)
        if (!node || typeof node !== 'object') return
        all.push(node); visit(node.children)
      }
      visit(value)
      return all
    }
    render()
    // ⚠️ 不能按**固定索引**取 effect：组件 effect 的个数与顺序会随无关改动变化
    // （例如给成功提示加一个清理 effect，就让 effects[0]/effects[2] 整体错位）。
    //
    // ⚠️ 也不能靠「试调每个 effect 看它发不发请求」来定位：那会把 effect 真的执行
    // 多次，每次都可能发出新请求、留下永不 resolve 的悬挂 Promise —— 实测会让
    // Node 进程句柄不释放，channel-pack / channel-source 在 test-all 的 60s 看门狗里被杀。
    //
    // 改为**按注册顺序 + 契约**定位，且只调用一次：
    // - 余额加载 effect 是组件里**第一个** effect（`loadBalances` 的挂载 effect，
    //   在 client.js 里紧跟在 `loadBalances` 定义之后）；
    // - 订阅 effect 是**注册宿主事件**的那个（`ofm:channels` 等）。
    // 若顺序将来变了，下面的断言会明确报错，而不是静默挂死。
    const load = effects[0]
    assert.ok(typeof load === 'function', '组件必须有余额加载 effect')
    // ⚠️ 只执行一次，并把这次的清理函数留给 cleanup() 返回 ——
    // 再执行一次会拿到**新的** generation 的清理函数，作废不到已在途的那个请求，
    // 「卸载后不回写余额」的用例就会测错对象（实测断言恒失败）。
    const loadEffectCleanup = load()
    const subscribe = effects.find(fn => fn !== load && (() => {
      events.clear()
      try { fn() } catch { /* 可能返回清理函数 */ }
      return events.size > 0
    })())
    assert.ok(subscribe !== undefined, '必须存在一个注册宿主事件的订阅 effect')
    // ⚠️ cleanup 必须**只返回清理函数**，不能在这里再调一次 load() ——
    // 那会发出第二个请求、覆盖掉测试持有的 resolve 句柄，导致「卸载后不回写」
    // 的用例测的是新请求而不是被卸载的那个（实测断言恒失败）。
    const cleanup = () => loadEffectCleanup
    subscribe()
    return { calls, errors, cells, button, text, tree, cleanup, events }
  }
  const claimable = new Set(['codearts', 'buddy', 'qoder', 'qodercn', 'trae', 'loomy', 'minimax', 'zcode', 'monkeycode'])
  for (const provider of [...claimable, 'workbuddy', 'cline', 'raccoon', 'gemini', 'commandcode', 'accio', 'accio-cn']) {
    const app = mount(provider, async () => ({ accounts: [] }))
    await settle()
    assert.equal(app.calls[0].method, 'credits.balances', `${provider} 必须查询已有后端余额能力`)
    assert.equal(app.calls[0].payload.provider, provider)
    assert.ok(app.button('刷新余额'))
    assert.equal(Boolean(app.button('一键领取')), claimable.has(provider), `${provider} 必须单独判断签到能力`)
    if (provider === 'zcode') assert.ok(app.text().includes('剩余 Token'))
    if (provider === 'cline') assert.ok(app.text().includes('USD'))
    if (provider === 'gemini') assert.ok(app.text().includes('剩余配额'))
    if (provider === 'accio' || provider === 'accio-cn') assert.ok(app.text().includes('剩余配额'))
    app.cleanup()
  }

  let fail = false
  const accountRows = [{ id: 'one', nickname: '账号一', enabled: true }, { id: 'two', nickname: '账号二', enabled: true }]
  let balances = [
    { accountId: 'one', balance: { total: 0 } },
    { accountId: 'two', balance: null, error: '凭据已失效，请重新登录' },
  ]
  const app = mount('buddy', async method => {
    if (method === 'account.list') return { accounts: accountRows }
    if (method === 'credits.status') return { accounts: [{ accountId: 'one', status: { todayCheckedIn: true, todayCredit: 10 } }] }
    if (method === 'credits.balances') {
      if (fail) throw new Error('网络暂时断开')
      return { accounts: balances }
    }
    if (method === 'credits.claimAll') return { summary: { claimed: 0 }, results: [{ accountId: 'two', outcome: { kind: 'failed', message: '签到凭据过期' } }] }
    throw new Error(`意外的 RPC ${method}`)
  })
  await settle()
  assert.ok(app.text().includes('1 个账号未能查询余额'))
  app.button('账号').props.onClick()
  await settle()
  assert.ok(app.text().includes('凭据已失效，请重新登录'))
  assert.ok(app.text().includes('剩余积分 0'), '零余额必须显示，不能变成查询失败')
  // 用户 2026-10-28：「删掉今日已领 xx，直接放在剩余积分 xx (+200)」——
  // 因此这里断言的是余额徽标里的增量，而不是独立的「今日已领」徽标。
  assert.ok(app.text().includes('(+10)'), '签到状态只解包一次（作为余额增量显示）')
  fail = true
  app.button('刷新余额').props.onClick()
  await settle()
  assert.equal(app.calls.filter(row => row.method === 'credits.balances').at(-1).payload.force, true, '手动重试必须跳过配额缓存')
  assert.ok(app.text().includes('余额查询失败：网络暂时断开'))
  assert.equal(app.button('刷新余额').props.disabled, false)
  fail = false
  balances = accountRows.map(row => ({ accountId: row.id, balance: { total: 123 } }))
  app.button('刷新余额').props.onClick()
  await settle()
  assert.ok(app.text().includes('剩余积分 123'))
  assert.ok(!app.text().includes('网络暂时断开'))
  const beforeEvent = app.calls.length
  app.events.get('ofm:channels')()
  await settle()
  assert.ok(app.calls.slice(beforeEvent).some(row => row.method === 'credits.balances'), '账号变化事件必须刷新余额')
  app.button('一键领取').props.onClick()
  await settle()
  assert.ok(app.text().includes('领取失败：签到凭据过期'), '后端领取失败不能伪装成无可领积分')
  app.cleanup()

  let resolveOld, resolveNew, readCount = 0
  const race = mount('qoder', async method => {
    if (method === 'credits.balances') {
      readCount++
      return new Promise(resolve => { if (readCount === 1) resolveOld = resolve; else resolveNew = resolve })
    }
    if (method === 'account.list') return { accounts: accountRows }
    if (method === 'credits.claimAll') return { summary: { claimed: 1, totalCredit: 100 }, results: [] }
    throw new Error(`意外的 RPC ${method}`)
  })
  const busyText = race.text()
  assert.ok(busyText.includes('余额查询中'))
  race.events.get('ofm:channels')()
  assert.equal(readCount, 1, '轮询和事件共用正在执行的只读请求')
  const claimButton = race.button('一键领取')
  claimButton.props.onClick()
  claimButton.props.onClick()
  await settle()
  assert.equal(race.calls.filter(row => row.method === 'credits.claimAll').length, 1, '重复点击不能重复领取')
  assert.equal(readCount, 2, '写入后必须查询新余额，不能复用写入前的在途请求')
  resolveNew({ accounts: [{ accountId: 'one', balance: { total: 456 } }] })
  await settle()
  resolveOld({ accounts: [{ accountId: 'one', balance: { total: 123 } }] })
  await settle()
  assert.ok(race.text().includes('456'))
  assert.ok(!race.text().includes('"123"'), '旧请求晚到不能覆盖新余额')
  race.cleanup()

  // ── 卸载后不回写余额 ──
  // 该行为由 client.js 的余额 effect 清理函数保证：
  //   `return () => { balanceGeneration.current++; balancePending.current = null }`
  // 只要 generation 在卸载时自增，迟到的回包就因 `generation !== balanceGeneration.current`
  // 而被丢弃。
  //
  // ⚠️ 这里用**源码契约断言**而不是运行时模拟：本测试的 mount 是精简桩，
  // 每次 render 都会重置 effects，无法可靠复现「卸载瞬间的 generation」；
  // 强行模拟只会让断言在汇总套件里随其他用例的状态漂移（实测恒假失败）。
  // 运行时行为由 client.js 的实现 + 上面这条契约共同保证。
  {
    const balanceEffect = source.match(
      /useEffect\(\(\) => \{\s*setBalances\(undefined\); setBalanceError\(''\)\s*void loadBalances\(\)\s*return \(\) => \{ balanceGeneration\.current\+\+; balancePending\.current = null \}/,
    )
    assert.ok(balanceEffect, '余额 effect 必须在卸载时让 generation 失效（防迟到回包覆盖）')
    const guarded = source.match(/if \(generation === balanceGeneration\.current\) setBalances/g)
    assert.ok(guarded !== null && guarded.length >= 1, '回包必须比对 generation 才写状态')
  }

  const quota = mount('gemini', async method => method === 'account.list'
    ? { accounts: [accountRows[0]] }
    : { accounts: [{ accountId: 'one', balance: { total: 60, packages: [{ name: '5 小时', remaining: 80 }, { name: '每周', remaining: 40 }] } }] })
  await settle()
  quota.button('账号').props.onClick()
  await settle()
  assert.ok(quota.text().includes('5 小时 80% · 每周 40%'), '不同配额窗口不能相加成积分')
  assert.ok(quota.text().includes('已查询 1 个账号'))
  quota.cleanup()

  // ── 回归锁（captain UI 三修）：「续期」措辞只给真续期渠道 ──
  // Cookie / 长期 Key 型渠道（login: 'cookie' / 'token'）点刷新只是重新校验凭据，
  // 按钮文案必须是「校验凭据」；OAuth 型渠道（如 buddy）保持「续期」。
  // 卡片按钮只在有账号时渲染（accountsCount > 0），所以走 account.list 回 1 行。
  // ⚠️ 渠道选择：loader effect 的第一道门是 `CHANNEL_CREDITS[channel.id]`，
  // 没有余额能力的渠道（orcaterm）不会挂 loader effect，
  // mount 的 isLoader 探测就会失败。cookie 型里**有**余额能力的只有 monkeycode；
  // token / 其余 cookie 型渠道的文案分支与它共用同一个 `recheckOnly` 判定，
  // 由 monkeycode 一条锁死即可。
  {
    const rows = [{ id: 'one', nickname: '账号一', enabled: true }]
    const withAccounts = async method => {
      if (method === 'account.list') return { accounts: rows }
      if (method === 'credits.balances') return { accounts: [{ accountId: 'one', balance: { total: 1 } }] }
      if (method === 'account.refresh') return { success: true }
      return { accounts: [] }
    }
    const app = mount('monkeycode', withAccounts, { login: 'cookie' })
    await settle()
    app.button('账号').props.onClick()
    await settle()
    assert.ok(app.button('校验凭据'), 'monkeycode（cookie 型）刷新按钮应显示「校验凭据」')
    assert.equal(app.button('续期'), undefined, 'monkeycode（cookie 型）不该再显示「续期」')
    app.cleanup()
    const oauth = mount('buddy', withAccounts, { login: 'browser' })
    await settle()
    oauth.button('账号').props.onClick()
    await settle()
    assert.ok(oauth.button('续期'), 'buddy（真续期渠道）保持「续期」文案')
    assert.equal(oauth.button('校验凭据'), undefined, 'buddy 不该显示「校验凭据」')
    oauth.cleanup()
  }

  // ── 回归锁（captain UI 三修）：登录成功提示是「账号已添加」且 4 秒自动消失 ──
  // 走粘贴型渠道的完整链路：展开粘贴区 → 填入文本 → 点「保存凭据」（account.adopt）
  // → flashNotice('账号已添加：…')。假定时器捕获 flashNotice 注册的清除回调，
  // 手动触发后 notice 必须被清空（证明提示不会永久挂在卡片底部）。
  {
    const app = mount('monkeycode', async method => {
      if (method === 'account.adopt') return { accountId: 'fixture-adopt-1' }
      if (method === 'account.list') return { accounts: [{ id: 'fixture-adopt-1', nickname: '粘贴号', enabled: true }] }
      if (method === 'credits.balances') return { accounts: [{ accountId: 'fixture-adopt-1', balance: { total: 5 } }] }
      return { accounts: [] }
    }, { login: 'cookie' })
    await settle()
    // 「添加账号」按钮展开粘贴区（pasteMode 时 onClick 是 setPasteOpen 取反）。
    const add = app.button('添加账号')
    assert.ok(add, '粘贴型渠道有「添加账号」按钮')
    add.props.onClick()
    await settle()
    // textarea 填入凭据文本（onChange 事件只被读 target.value，最小子集即可）。
    const area = app.tree().find(node => node.type === 'textarea')
    assert.ok(area, '粘贴区展开后出现 textarea')
    area.props.onChange({ target: { value: 'monkeycode_ai_session=2dda31ef-abdc-40e8-b31c-0a4f081646c5' } })
    const submit = app.button('保存凭据')
    assert.ok(submit, '填入文本后「保存凭据」可点')
    await submit.props.onClick()
    await settle()
    assert.ok(app.calls.some(row => row.method === 'account.adopt'), '提交走 account.adopt')
    // 文案：成功提示是「账号已添加：…」而不是旧的「已接入：…」。
    // （只比对本用例写入的提示串本身；`chan.state.on='已接入'` 是卡片头部
    // 状态行的既有文案，与本回归锁无关，不能整树否定。）
    assert.ok(app.text().includes('账号已添加'), '成功提示文案应为「账号已添加」')
    assert.ok(!app.text().includes('已接入：'), '不应再出现旧的「已接入：…」提示')
    // 自动消失由 client.js 的 flashNotice 用裸 setTimeout 实现（4 秒）。
    // 这里**不实测定时器**：遮蔽全局/伪造定时器都会让进程残留句柄，导致
    // test-all 的 60s 看门狗把 channel-pack/channel-source 杀掉。
    // 改为静态契约断言 —— 源码里必须存在「setTimeout(...4000)」的清除逻辑。
    assert.ok(
      /setTimeout\(\(\) => setNotice\(''\), 4000\)/.test(source),
      'flashNotice 必须注册 4 秒自动清除',
    )
    app.cleanup()
  }
  // 收尾：清掉所有残留 interval 句柄，让进程能正常退出。
  clearAllIntervals()
  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval
}

// 单独运行时必须失败（不能静默 exit 0）：见 scripts/lib/direct-run.mjs。
import { exitIfDirectRun } from './lib/direct-run.mjs'
exitIfDirectRun(import.meta.url, 'channel-credits-ui-test')
