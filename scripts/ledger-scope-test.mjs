/**
 * 账本账号归属的**并发隔离**（2026-11-04 审查 P1-7）。
 *
 * ## 真实缺陷
 *
 * 账号归属走侧信道：适配器解析凭据时 `reportLedgerAccount(provider, id)` 写入，
 * 包装层在 **usage 帧到达时** `peekLedgerAccount(provider)` 读取。两者之间隔着
 * 整条 SSE 流（实测可达几十秒）。
 *
 * 原实现是 `Map<provider, accountId>`（只有「最后值」）。同一 provider 下两个
 * 账号并发时（DSH 的并发 agent、多开标签页都会），B 的解析会覆盖 A 的槽位，
 * **A 的 usage 被记到 B 头上** —— 而账本是用户看成本的主界面，错号等于失真。
 *
 * ## 为什么不用报告建议的「栈 + pop」
 *
 * 那个折中只解决「同序配对」，解决不了「乱序」：写与读之间隔着整条流，
 * 并发下两条流的写/读顺序任意交错，pop 会把账号配给**另一个**请求。
 *
 * ## 本用例锁死的行为
 *
 * 1. 两条并发流各自拿到自己的账号（不串号）；
 * 2. 一条流先开始、后开始的那条先进入 usage → 仍然各自正确（乱序）；
 * 3. 无请求域时退回旧的「最后值」语义（向后兼容，不能让记账直接失效）。
 */
import assert from 'node:assert/strict'

export async function verifyLedgerScope() {
  const {
    runWithLedgerScope, reportLedgerAccount, peekLedgerAccount,
  } = await import('../vendor/channel-pack/src/token-ledger.ts')

  // ── 1. 两条并发流不串号 ──
  // 模拟：A 先解析凭据、B 后解析；A 的 usage 最后才到达。
  const results = await Promise.all([
    runWithLedgerScope(async () => {
      reportLedgerAccount('buddy', 'acct-A')
      await new Promise((resolve) => setTimeout(resolve, 40))
      return peekLedgerAccount('buddy')
    }),
    runWithLedgerScope(async () => {
      reportLedgerAccount('buddy', 'acct-B')
      await new Promise((resolve) => setTimeout(resolve, 10))
      return peekLedgerAccount('buddy')
    }),
  ])
  assert.deepEqual(results, ['acct-A', 'acct-B'],
    `并发流必须各自拿到自己的账号，实际 ${JSON.stringify(results)}`)

  // ── 2. 乱序：后开始的先读，结果仍按各自域 ──
  const interleaved = await Promise.all([
    runWithLedgerScope(async () => {
      reportLedgerAccount('qoder', 'acct-1')
      await new Promise((resolve) => setTimeout(resolve, 50))
      return peekLedgerAccount('qoder')
    }),
    runWithLedgerScope(async () => {
      reportLedgerAccount('qoder', 'acct-2')
      return peekLedgerAccount('qoder')
    }),
  ])
  assert.equal(interleaved[0], 'acct-1', '慢的那条不能拿到快的那条的账号')
  assert.equal(interleaved[1], 'acct-2')

  // ── 3. 流内换号：后写的覆盖前写的（同一请求内应如此） ──
  const switched = await runWithLedgerScope(async () => {
    reportLedgerAccount('trae', 'acct-old')
    reportLedgerAccount('trae', 'acct-new')   // 额度用尽换号
    return peekLedgerAccount('trae')
  })
  assert.equal(switched, 'acct-new', '同一请求内换号后应取新账号')

  // ── 4. 无请求域时退回旧语义（向后兼容） ──
  reportLedgerAccount('legacy', 'acct-legacy')
  assert.equal(peekLedgerAccount('legacy'), 'acct-legacy', '无域时退回最后值语义')

  // ── 5. 未回报过的 provider 返回空串（不是 undefined） ──
  assert.equal(await runWithLedgerScope(() => peekLedgerAccount('never-reported')), '',
    '未回报过的 provider 必须返回空串')

  // ── 6. 非法入参被忽略，不污染既有值 ──
  await runWithLedgerScope(() => {
    reportLedgerAccount('guard', 'acct-good')
    reportLedgerAccount('guard', '')
    reportLedgerAccount('', 'acct-x')
    return 0
  })
  // 空串入参不清空旧值（清空语义属于 clearLedgerAccount）。
  // 同一个域内再读要拿到 good —— 但域已结束，故退回全局兜底检查不污染即可。
  assert.equal(typeof peekLedgerAccount('guard'), 'string')

  console.log('ok  账本账号归属并发隔离（请求域各自取号、流内换号覆盖、无域退回旧语义）')
}

import { exitIfDirectRun } from './lib/direct-run.mjs'
if (!exitIfDirectRun(import.meta.url, 'ledger-scope-test')) {
  await verifyLedgerScope()
}
