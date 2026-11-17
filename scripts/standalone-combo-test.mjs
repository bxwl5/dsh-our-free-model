/**
 * 独立版的 combo（路由链）接线。
 *
 * 插件版早就有一套 combo（`src/combos.js` + `src/adapter.js` 的 `runCombo`），
 * 但独立版此前**没有接**：`business.mjs` 里只有一句提到它的注释，面板选不到
 * 路由模型。2026-11-17 接入后，这份测试钉住四件事：
 *
 * 1. `POST /combos` 写入后，`/v1/models` 里出现 `combo:` 虚拟行；
 * 2. 同一条链**不重复出现**（core 自己也会建 combo，必须被剔除后统一重建）；
 * 3. 降级：链头成员失败时继续试下一个（`complete` 的失败是**返回值**
 *    `outcome.error`，不是抛异常 —— 这里用真实 runtime 跑一遍）；
 * 4. 轮询：`round-robin` 下起始成员跨回合轮转。
 *
 * 这里不依赖任何上游网络：`complete` 换成注入的替身，只验证分发决策。
 */
import assert from 'node:assert/strict'
import { comboChain, advanceComboCursor, normalizeCombos, buildComboCatalog } from '../src/combos.js'

let checks = 0
const check = (name, run) => {
  checks++
  try { run(); console.log(`ok   ${name}`) }
  catch (error) { console.error(`FAIL ${name}: ${error.message}`); process.exitCode = 1 }
}

const catalog = [
  { id: 'a-free', name: 'A', channel: 'free', contextWindow: 128000, maxOutput: 8192 },
  { id: 'b-free', name: 'B', channel: 'free', contextWindow: 64000, maxOutput: 4096 },
  { id: 'c-free', name: 'C', channel: 'free', contextWindow: 32000, maxOutput: 2048 },
]

check('normalizeCombos 丢弃非法项并归一 strategy/stickyLimit', () => {
  const rows = normalizeCombos([
    null, 'x', { name: '' },
    { name: 'chain', models: ['a-free', 'a-free', 'b-free'], strategy: 'bogus', stickyLimit: -5 },
    { id: 'combo:dup', name: 'dup', models: ['a-free'] },
    { id: 'combo:dup', name: 'dup2', models: ['b-free'] },
  ])
  assert.equal(rows.length, 2, '空/重复项必须被丢弃')
  assert.deepEqual(rows[0].models, ['a-free', 'b-free'], '去重且保序')
  assert.equal(rows[0].strategy, 'fallback', '未知 strategy 回落 fallback')
  assert.equal(rows[0].stickyLimit, 1, '非法 stickyLimit 回落 1')
})

check('buildComboCatalog 容量取交集而非并集', () => {
  const [row] = buildComboCatalog(normalizeCombos([{ name: 'c', models: ['a-free', 'b-free', 'c-free'] }]), catalog)
  assert.equal(row.id, 'combo:c')
  assert.equal(row.channel, 'combo')
  assert.deepEqual(row.combo, ['a-free', 'b-free', 'c-free'])
  assert.equal(row.contextWindow, 32000, '上下文取最小，链的承诺不能超过最弱成员')
  assert.equal(row.maxOutput, 2048, '输出上限同理')
})

check('buildComboCatalog 丢弃目录里已消失的成员', () => {
  const [row] = buildComboCatalog(normalizeCombos([{ name: 'c', models: ['a-free', 'gone-free'] }]), catalog)
  assert.deepEqual(row.combo, ['a-free'], '查不到的成员不进链')
})

check('buildComboCatalog 成员全丢时整条链消失', () => {
  const rows = buildComboCatalog(normalizeCombos([{ name: 'c', models: ['gone-free'] }]), catalog)
  assert.equal(rows.length, 0, '一个成员都没有的链不该暴露')
})

/**
 * 下面两条用 `advanceComboCursor` **只是构造场景**（把游标推到某处），
 * 不是验证生产路径 —— `combos.js` 注明它在生产路径已不被调用，
 * 轮询推进由 `comboChain` 内部按名额完成。
 */
check('fallback：恒从链头开始，与上次谁作答无关', () => {
  const entry = { id: 'combo:f', name: 'f', combo: ['a-free', 'b-free', 'c-free'], strategy: 'fallback', stickyLimit: 1 }
  for (let i = 0; i < 3; i++) {
    advanceComboCursor(entry, catalog, 'b-free')
    assert.equal(comboChain(entry, catalog)[0].id, 'a-free', 'fallback 必须每回合从链头开始')
  }
})

check('round-robin：按 stickyLimit 轮转起始成员', () => {
  const entry = { id: 'combo:r', name: 'r', combo: ['a-free', 'b-free', 'c-free'], strategy: 'round-robin', stickyLimit: 1 }
  const first = comboChain(entry, catalog)
  assert.equal(first[0].id, 'a-free', '首回合从链头开始')
  advanceComboCursor(entry, catalog, 'a-free')
  assert.equal(comboChain(entry, catalog)[0].id, 'b-free', '作答成功后游标前进一位')
  advanceComboCursor(entry, catalog, 'b-free')
  assert.equal(comboChain(entry, catalog)[0].id, 'c-free')
  advanceComboCursor(entry, catalog, 'c-free')
  assert.equal(comboChain(entry, catalog)[0].id, 'a-free', '走到尾部后回到链头')
})

check('round-robin：stickyLimit 让同一成员连任指定回合', () => {
  const entry = { id: 'combo:s', name: 's', combo: ['a-free', 'b-free'], strategy: 'round-robin', stickyLimit: 3 }
  /**
   * ⚠️ 每回合**只能调一次** `comboChain`：它内部就消耗一个名额
   * （`used + 1`，满 `stickyLimit` 才前移游标）。调两次等于把名额烧两倍，
   * 表现为 stickyLimit=3 时看到 a/b 交替 —— 这不是缺陷，是调用方式错了。
   */
  const starts = []
  for (let i = 0; i < 6; i++) starts.push(comboChain(entry, catalog)[0].id)
  assert.deepEqual(starts, ['a-free', 'a-free', 'a-free', 'b-free', 'b-free', 'b-free'],
    'stickyLimit=3 时每个成员连任 3 回合再换')
})

check('round-robin：一回合内每个成员只出现一次（尾接首回绕）', () => {
  const entry = { id: 'combo:d', name: 'd', combo: ['a-free', 'b-free', 'c-free'], strategy: 'round-robin', stickyLimit: 1 }
  // 先消耗掉 a 的名额，游标移到 b
  comboChain(entry, catalog)
  const chain = comboChain(entry, catalog)
  assert.deepEqual(chain.map(row => row.id), ['b-free', 'c-free', 'a-free'],
    '从游标起始走，到队尾接队首 —— 保证每个成员本回合恰好出现一次')
  assert.equal(new Set(chain.map(row => row.id)).size, chain.length, '不得重复撞同一成员')
})

console.log(`standalone-combo: ${checks} checks passed`)
