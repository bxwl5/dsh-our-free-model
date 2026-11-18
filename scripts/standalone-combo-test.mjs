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
import { advancePastMember } from '../packages/standalone/service.mjs'
import { commitsAnswer } from '../src/adapter.js'

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

/**
 * 分发决策的最小复刻：`completeCombo` 的核心是「失败就换下一个」。
 *
 * 这里用一个和 service.mjs 同形的循环验证**两种失败形态**都必须被吃下：
 * - 免费模型路径：`complete` 返回 `outcome.error`（不抛）
 * - 渠道模型路径：`complete` **抛异常**（zcode 的额度错误就是这样）
 *
 * 实测踩过：第一版只检查返回值，渠道成员一抛就把整条链中断，NAS 上
 * 「zcode 额度用尽」直接返回给用户，后面两条完好渠道一次都没试。
 */
/**
 * 用**真实**的 `advancePastMember` 跑一条链。
 *
 * ⚠️ 这里原先手抄了一份等价逻辑（`const failed = ...`），注释却写着「用真实
 * runtime 跑一遍」—— 副本与真实实现漂移过：它没有 `answered`/`delivered`
 * 之分，因此永远不会覆盖「非流式路径必须换人」。现在直接 import 真实判据。
 *
 * @param {string[]} members
 * @param {(id: string) => Promise<any>} complete  产出 `{error|failure}` 或成功的替身
 * @param {{hasHandler?: boolean, onChunk?: (chunk: any) => void}} options
 *   `hasHandler: false` 模拟非流式（`forward.js` 不传 onChunk 的调用）
 * @param {(id: string, chunk: any) => void} [emit] 每个成员的 chunk 产出（用于测提交语义）
 */
const runChain = async (members, complete, options = {}) => {
  const { hasHandler = true, emit } = options
  let lastFailure
  for (const id of members) {
    let answered = false
    let result
    let thrown
    // 让替身有机会「先产出 chunk，再失败」—— 迟到失败是这条测试的核心场景。
    const sink = chunk => {
      if (answered) return
      if (commitsAnswer(chunk)) answered = true
      emit?.(id, chunk)
    }
    try { result = await complete(id, sink) } catch (error) { thrown = error }
    // 与生产 completeCombo 同步的兜底（审计 🔴#4）：已交付后抛异常时
    // result 是 undefined，必须构造带 error 的 outcome 再结算。
    if (thrown !== undefined && result === undefined) {
      result = {
        text: '', toolCalls: [], usage: undefined, truncated: false,
        error: thrown instanceof Error ? thrown.message : String(thrown),
        failure: { message: thrown instanceof Error ? thrown.message : String(thrown) },
      }
    }
    if (advancePastMember({ answered, hasHandler, thrown, result })) {
      lastFailure = thrown ?? { message: result?.error ?? result?.failure?.message }
      continue
    }
    return { ok: true, servedBy: id, order: members, answered, result }
  }
  throw new Error(`全部失败：${lastFailure?.message ?? ''}`)
}

/** chunk 判据直接用线上那份（`src/adapter.js` 的 `commitsAnswer`），不另抄替身。 */

await check('降级：返回 outcome.error（免费模型路径）时换下一个', async () => {
  const tried = []
  const out = await runChain(['a', 'b'], async id => {
    tried.push(id)
    return id === 'a' ? { error: '额度用尽' } : { text: 'ok' }
  })
  assert.deepEqual(tried, ['a', 'b'], '失败的成员之后必须继续试')
  assert.equal(out.servedBy, 'b', '由第二个成员作答')
})

await check('降级：抛异常的成员（渠道模型路径）也要换下一个', async () => {
  const tried = []
  const out = await runChain(['a', 'b'], async id => {
    tried.push(id)
    if (id === 'a') throw new Error('zcode: 额度已用尽')
    return { text: 'ok' }
  })
  assert.deepEqual(tried, ['a', 'b'], '抛异常不得中断链')
  assert.equal(out.servedBy, 'b')
})

await check('提交语义：流式下已交付正文后，迟到的失败**不换人**（防二次作答）', async () => {
  const tried = []
  const emitted = []
  const out = await runChain(['a', 'b'], async (id, sink) => {
    tried.push(id)
    // 成员 a：先发正文（= 已交付），随后失败（迟到的 error finish）
    sink({ type: 'text-delta', text: 'a 的正文' })
    return { error: '流尾迟到失败' }
  }, { hasHandler: true, emit: (id, c) => emitted.push(`${id}:${c.text ?? ''}`) })
  assert.deepEqual(tried, ['a'], '已交付后不得再试 b（否则客户端收到两份正文）')
  assert.equal(out.servedBy, 'a', '由已交付的成员结算')
  assert.deepEqual(emitted, ['a:a 的正文'], '正文只出现一次')
})

await check('提交语义：已交付后成员**抛异常** → 返回带 error 的 outcome，不得是 undefined', async () => {
  // 审计 🔴#4：thrown 与 result 互斥，已交付路径原实现 return undefined，
  // 网关读 result.error 抛 TypeError，真实失败原因丢失。
  const out = await runChain(['a', 'b'], async (id, sink) => {
    if (id === 'a') {
      sink({ type: 'text-delta', text: 'a 的正文' })
      throw new Error('zcode: 流中额度用尽')
    }
    return { text: 'b' }
  }, { hasHandler: true })
  assert.equal(out.servedBy, 'a', '已交付不换人')
  assert.notEqual(out.result, undefined, '必须返回 outcome 对象')
  assert.match(String(out.result?.error ?? out.result?.failure?.message), /额度用尽/, '真实失败原因要带出去')
})

await check('提交语义：非流式（无 handler）下已产出正文后失败，**必须换人**', async () => {
  const tried = []
  const out = await runChain(['a', 'b'], async (id, sink) => {
    tried.push(id)
    sink({ type: 'text-delta', text: 'a 的正文' })
    // 非流式路径：内容没写给客户端，只在 result 里
    return id === 'a' ? { error: '额度用尽' } : { text: 'b 的完整回答' }
  }, { hasHandler: false })
  assert.deepEqual(tried, ['a', 'b'], '非流式未交付 → 必须继续换人，否则用户只拿到错误')
  assert.equal(out.servedBy, 'b', '由完整作答的成员结算')
})

await check('提交语义：未提交时的失败照常换人（不能因新判据放宽）', async () => {
  const tried = []
  const out = await runChain(['a', 'b'], async id => {
    tried.push(id)
    return id === 'a' ? { error: '额度用尽' } : { text: 'ok' }
  }, { hasHandler: true })
  assert.deepEqual(tried, ['a', 'b'])
  assert.equal(out.servedBy, 'b')
})

await check('提交语义：只发 usage / 空白正文不算提交（仍可换人）', async () => {
  const tried = []
  const out = await runChain(['a', 'b'], async (id, sink) => {
    tried.push(id)
    sink({ type: 'usage', usage: { inputTokens: 10 } })
    sink({ type: 'text-delta', text: '   ' })
    return id === 'a' ? { error: '限额' } : { text: 'ok' }
  }, { hasHandler: true })
  assert.deepEqual(tried, ['a', 'b'], 'usage 与空白不得钉死一条本可降级的链')
  assert.equal(out.servedBy, 'b')
})

await check('降级：全部失败时报最后一个成员的真实原因', async () => {
  await assert.rejects(
    () => runChain(['a', 'b'], async id => (id === 'a' ? { error: '第一因' } : { error: '第二因' })),
    /第二因/, '报错文案必须是最后那个成员的原因，而不是笼统的「全部失败」',
  )
})

console.log(`standalone-combo: ${checks} checks passed`)
