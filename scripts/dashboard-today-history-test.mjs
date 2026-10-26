/**
 * 看板「今日」必须来自**落盘日聚合**，不是进程内内存树。
 *
 * ## 锁住的缺陷（2026-10-26 用户报障）
 *
 * 「数据看板 → 今日」里两张表（各账号用量透视、模型性能指标与用量一览）
 * 取的是 `usage.tokenLedger` 的 `snapshot.channels` —— 那是**进程内存**里的
 * 环形缓冲聚合树，DSH 一重启就空。于是重启后两张表整块变成「暂无数据」，
 * 而落盘的 `token-ledger.json` 里当天的数据明明还在。
 *
 * 这个套件用 stub React 真实渲染 `LedgerPage`，喂三种后端返回：
 *   1. 「重启后」：`snapshot` 空 + `history` 里有今天 → 两张表必须有行；
 *   2. 「同一进程内」：两边都有 → 行为不变（不回归）；
 *   3. 「今天尚未落盘」：`history` 空 → 回落内存快照，不空表。
 * 外加跨时区断言：「今天」按 **UTC+8** 取键，本机时区不同也要命中。
 *
 * Run: node scripts/dashboard-today-history-test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
// `LedgerPage` 不在 `__test` 的默认导出里（与独立端构建同一个替换点）。
const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
  .replace('exports.__test = {', 'exports.__test = { LedgerPage,')

/** UTC+8 的今日日键 —— 与 `token-ledger.ts` 的 `utc8DayKey` 同口径。 */
function utc8Today() {
  const shifted = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`
}

const TODAY = utc8Today()

const DAY_TOTALS = {
  requests: 9, reportedRequests: 9, inputTokens: 900, outputTokens: 1800,
  cacheReadTokens: 3900, cacheWriteTokens: 0, reasoningTokens: 270,
  errors: 1, avgTtftMs: 300, avgTps: 40,
}
const ACCOUNT_TOTALS = {
  requests: 7, reportedRequests: 7, inputTokens: 700, outputTokens: 1400,
  cacheReadTokens: 3000, cacheWriteTokens: 0, reasoningTokens: 210,
  errors: 0, avgTtftMs: 300, avgTps: 40,
}
const TODAY_CHANNELS = [{
  channel: 'direct',
  providers: [{
    provider: 'codearts',
    accounts: [{ accountId: 'codearts-1', models: [{ model: 'deepseek-v4.1-flash', ...ACCOUNT_TOTALS }], totals: ACCOUNT_TOTALS }],
    totals: ACCOUNT_TOTALS,
  }],
  totals: ACCOUNT_TOTALS,
}]

/**
 * 用 stub React 渲染 `LedgerPage`，返回两张表的结构化读数。
 *
 * @param {{snapshot: unknown, history: unknown[]}} backend - 两个 RPC 的返回值。
 */
async function render(backend) {
  let cursor = 0
  const cells = []
  let pendingEffects = []
  const react = {
    createElement: (type, props, ...children) => ({
      type, props: props ?? {}, children: children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false),
    }),
    Fragment: 'fragment',
    useState(initial) {
      const at = cursor++
      if (!(at in cells)) cells[at] = typeof initial === 'function' ? initial() : initial
      return [cells[at], value => { cells[at] = typeof value === 'function' ? value(cells[at]) : value }]
    },
    useEffect(effect) { pendingEffects.push(effect) },
    useMemo: callback => callback(),
    useRef(initial) { const at = cursor++; return (cells[at] ??= { current: initial }) },
    useCallback: callback => callback,
  }
  const values = {
    'usage.tokenLedger': { snapshot: backend.snapshot },
    'usage.tokenLedgerHistory': { history: backend.history, totals: backend.totals ?? DAY_TOTALS },
  }
  const ctx = {
    connection: {
      rpc: {
        call: (_mount, _endpoint, payload) => {
          const value = values[payload?.method]
          return Promise.resolve(value === undefined
            ? { ok: false, error: { message: `no stub for ${payload?.method}` } }
            : { ok: true, value })
        },
      },
    },
  }
  let bundle
  const window = { __ModuleLoader__: { load: record => { bundle = record } } }
  const document = {
    createElement: () => ({ setAttribute() {}, style: {}, remove() {} }),
    head: { appendChild() {} },
    body: { appendChild() {}, removeChild() {} },
    querySelector: () => null,
    documentElement: { lang: 'zh-CN' },
  }
  new Function('window', 'document', 'navigator', source)(window, document, { language: 'zh-CN' })
  const exports = bundle.factory(name => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: (children, container) => ({ type: 'portal', props: { container }, children: [children] }) }
    throw new Error(`the browser half may only require react or react-dom; it asked for "${name}"`)
  })
  const props = { t: key => key, ctx }
  const renderOnce = () => { cursor = 0; return exports.__test.LedgerPage(props) }
  let tree = renderOnce()
  // 首帧是 loading（effect 里的异步取数还没落地）：跑几轮把状态推到位。
  for (let pass = 0; pass < 4; pass += 1) {
    const effects = pendingEffects
    pendingEffects = []
    for (const effect of effects) void effect()
    await new Promise(resolve => setTimeout(resolve, 20))
    tree = renderOnce()
  }

  // 函数组件（KpiCard / Section / PageHero）必须**展开**才能看到它们渲染出的
  // 文本与表格 —— stub createElement 只记录 `type`，不会替我们调用。
  const nodes = []
  const collect = node => {
    if (Array.isArray(node)) { node.forEach(collect); return }
    if (node === null || typeof node !== 'object') return
    if (typeof node.type === 'function') {
      // stub 的 createElement 把子节点放在 `children`，组件按 React 的约定从
      // `props.children` 读 —— 展开时必须把两者合起来喂进去。
      const rendered = node.type({ ...(node.props ?? {}), children: node.children })
      collect(rendered)
      return
    }
    nodes.push(node)
    collect(node.children)
  }
  collect(tree)
  const texts = []
  const textOf = node => {
    if (typeof node === 'string') texts.push(node)
    else if (typeof node === 'number') texts.push(String(node))
    else if (Array.isArray(node)) node.forEach(textOf)
    else if (node && typeof node === 'object') {
      if (typeof node.type === 'function') { textOf(node.type({ ...(node.props ?? {}), children: node.children })); return }
      textOf(node.children)
    }
  }
  textOf(tree)
  const tables = nodes.filter(node => node.props?.className === 'ofm_table')
  return {
    tables: tables.length,
    rows: tables.map(table => {
      const body = (table.children ?? []).find(child => child?.type === 'tbody')
      return (body?.children ?? []).length
    }),
    emptyNotes: texts.filter(text => text === 'dash.empty').length,
    hasAccount: texts.includes('codearts-1'),
    hasModel: texts.includes('deepseek-v4.1-flash'),
    // 「今日消耗 Token」卡片：9 请求的合计 = 900 + 1800 + 3900 = 6600 → 6.600K
    kpiToday: texts.includes('6.600K'),
    kpiLabels: texts.filter(text => text.startsWith('dash.kpi')),
  }
}

const RESTARTED = { snapshot: { channels: [], totals: {}, entries: [] }, history: [{ day: TODAY, channels: TODAY_CHANNELS, totals: DAY_TOTALS }] }

/** 三组断言（跨时区子进程也跑这一份，故抽成函数）。 */
async function assertGroups() {
  // ── 1. 重启后：内存快照空，日聚合有今天 ───────────────────────────────────
  {
    const view = await render(RESTARTED)
    assert.equal(view.tables, 2, '两张表都应渲染（不是被「暂无数据」替代）')
    assert.deepEqual(view.rows, [1, 1], '各账号透视与模型一览各有一行（来自今天的日聚合）')
    assert.equal(view.emptyNotes, 0, '不得出现「暂无数据」占位')
    assert.equal(view.hasAccount, true, '账号行来自落盘日聚合')
    assert.equal(view.hasModel, true, '模型行来自落盘日聚合')
    assert.equal(view.kpiToday, true, '今日 KPI 合计来自日聚合桶（900+1800+3900）')
    console.log('ok  重启后（内存快照为空）：两张表与今日 KPI 都从落盘日聚合读到了今天')
  }

  // ── 2. 同一进程内：快照与日聚合都有 → 行为不变 ───────────────────────────
  {
    const view = await render({ snapshot: { channels: TODAY_CHANNELS, totals: DAY_TOTALS, entries: [] }, history: [{ day: TODAY, channels: TODAY_CHANNELS, totals: DAY_TOTALS }] })
    assert.deepEqual(view.rows, [1, 1], '两边都有数据时表格照常渲染')
    assert.equal(view.emptyNotes, 0)
    assert.equal(view.hasAccount, true)
    assert.equal(view.kpiToday, true)
    console.log('ok  未重启时行为不变：快照与日聚合一致，表格与 KPI 照旧')
  }

  // ── 3. 今天这一格尚未落盘（首次安装 / 落盘防抖窗口内）→ 回落内存快照 ────
  {
    const view = await render({ snapshot: { channels: TODAY_CHANNELS, totals: DAY_TOTALS, entries: [] }, history: [] })
    assert.deepEqual(view.rows, [1, 1], '日聚合还没有今天时回落到内存快照（同一进程内的最近数据）')
    assert.equal(view.hasAccount, true)
    console.log('ok  今天这一格尚未落盘时回落内存快照：不把用户刚用过的数据藏起来')
  }
}

/** 本机时区的今日日键（缺陷版本就是这么算的 —— 用作对照）。 */
function localToday() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

if (process.argv.includes('--tz-assert')) {
  // 跨时区子进程：只跑第 1 组（TZ 由父进程设成 America/Los_Angeles）。
  const view = await render(RESTARTED)
  assert.deepEqual(view.rows, [1, 1], '跨时区时两张表仍要从今天的日聚合取数')
  assert.equal(view.hasAccount, true)
  assert.equal(view.kpiToday, true)
  const local = localToday()
  console.log(JSON.stringify({ local, utc8: TODAY, discriminates: local !== TODAY }))
  process.exit(0)
}

await assertGroups()

// ── 4. 跨时区：本机日期 ≠ UTC+8 日期时，仍要命中今天那一格 ─────────────────
//
// 父进程的时区不参与判定（本机就是 Asia/Shanghai 时两者恒等，断言等于没写）。
// 一律开一个 TZ=America/Los_Angeles 的子进程：洛杉矶与 UTC+8 相差 15~16 小时，
// 一天里绝大多数时刻两者的日期**不同**，那时「按本机时区取日键」的旧实现
// 必然找不到今天那一格。子进程自报是否真的能区分，避免静默假绿。
const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--tz-assert'], {
  cwd: root,
  env: { ...process.env, TZ: 'America/Los_Angeles' },
  encoding: 'utf8',
})
assert.equal(child.status, 0, `跨时区子进程失败：\n${child.stdout}\n${child.stderr}`)
const report = JSON.parse(child.stdout.trim().split('\n').at(-1))
if (report.discriminates) {
  console.log(`ok  跨时区（本机 ${report.local} vs UTC+8 ${report.utc8}）：日键按 UTC+8 取，仍命中今天`)
} else {
  console.log(`skip 跨时区判别：此刻洛杉矶日期与 UTC+8 相同（${report.utc8}），两种口径无法区分；仅验证渲染不崩`)
}

console.log('dashboard-today-history: 4 组断言通过（重启后回读日聚合 / 口径不变 / 回落快照 / 跨时区日键）')
// stub React 与 client.js 的副作用会留下句柄（与本仓库其它渲染探针一致：显式退出）。
process.exit(0)
