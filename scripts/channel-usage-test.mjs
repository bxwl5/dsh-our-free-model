/**
 * 看板口径回归：渠道台账合并 + 缓存读计入合计。
 *
 * 背景（2026-10-25 实测缺口）：看板 `/stats` 只读 `stats.json`，而 20 个渠道
 * 只写 `token-ledger.json`，于是累计 Token 少了 5,690 万、最近三天整天为 0。
 * 这个套件锁住三件事：
 *   1. 台账能按「渠道/模型」聚合，且多账号合并不重复；
 *   2. 合并后 `days` 的 total 与 `grand` 的合计**必须相等**（图表与累计同源）；
 *   3. `includeCacheRead` 开关真的改变口径，默认行为不变（不误伤独立端）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const { buildStats } = await import('../src/core/stats.js')
const { readChannelUsage, mergeChannelStats, resolveChannelLedgerPath } = await import('../src/core/channel-usage.js')

const scratch = mkdtempSync(path.join(tmpdir(), 'ofm-channel-usage-'))
const ledgerPath = path.join(scratch, 'token-ledger.json')

const ledger = {
  schema: 'dsh-codearts-auth/token-ledger/v1',
  days: {
    '2026-10-24': {
      'direct|raccoon|acc-1|sn-model-a': { requests: 10, inputTokens: 1000, outputTokens: 200, reasoningTokens: 50, cacheReadTokens: 5000, errors: 1, ttftSumMs: 3000, ttftCount: 10, tpsSum: 900, tpsCount: 10 },
      // 同渠道同模型的第二个账号：必须并成一行，不能双计
      'direct|raccoon|acc-2|sn-model-a': { requests: 5, inputTokens: 500, outputTokens: 100, reasoningTokens: 25, cacheReadTokens: 2500, errors: 0, ttftSumMs: 1500, ttftCount: 5, tpsSum: 450, tpsCount: 5 },
      'direct|workbuddy|acc-3|wb-model-b': { requests: 4, inputTokens: 400, outputTokens: 80, reasoningTokens: 0, cacheReadTokens: 0, errors: 0, ttftSumMs: 800, ttftCount: 4, tpsSum: 200, tpsCount: 4 },
    },
    '2026-10-25': {
      'direct|raccoon|acc-1|sn-model-a': { requests: 2, inputTokens: 200, outputTokens: 40, reasoningTokens: 10, cacheReadTokens: 1000, errors: 0, ttftSumMs: 600, ttftCount: 2, tpsSum: 180, tpsCount: 2 },
      // 坏行：键形状不对，必须被忽略而不是崩掉
      'garbage-key': { requests: 99, inputTokens: 999999, outputTokens: 0, cacheReadTokens: 0 },
    },
  },
}
writeFileSync(ledgerPath, JSON.stringify(ledger))

// ── 1. 台账聚合 ─────────────────────────────────────────────────────────────
const usage = readChannelUsage(ledgerPath)
assert.ok(usage !== undefined, '台账应可读取')
assert.deepEqual(Object.keys(usage.days).sort(), ['2026-10-24', '2026-10-25'], '天数对齐')
const day24 = usage.days['2026-10-24']
assert.equal(day24.models.length, 2, '两个渠道模型各一行（同渠道两账号已合并）')
const raccoon = day24.models.find(row => row.model === 'raccoon/sn-model-a')
assert.equal(raccoon.input, 1500, '多账号 input 相加')
assert.equal(raccoon.output, 300, '多账号 output 相加')
assert.equal(raccoon.cacheRead, 7500, '多账号 cacheRead 相加')
assert.equal(raccoon.calls, 15, '多账号 requests 相加')
assert.equal(raccoon.failed, 1, '多账号 errors 相加')
assert.ok(usage.days['2026-10-25'].models.every(row => row.model !== 'garbage-key'), '坏键被忽略')

// ── 2. 读不到台账时返回 undefined（调用方原样放行） ─────────────────────────
assert.equal(readChannelUsage(path.join(scratch, 'nope.json')), undefined, '缺文件 → undefined')
writeFileSync(path.join(scratch, 'broken.json'), '{ not json')
assert.equal(readChannelUsage(path.join(scratch, 'broken.json')), undefined, '坏 JSON → undefined')

// ── 3. 空台账不改变载荷 ─────────────────────────────────────────────────────
const stats = {
  days: { '2026-10-24': { total: 300, models: { 'free-model': { input: 100, output: 200, reasoning: 0, cacheRead: 900, calls: 3, failed: 0, ttftMs: 500, ttftSamples: 3, decodeMs: 1000, decodeTokens: 200 } } } },
  requests: 3,
  failedRequests: 0,
  models: { 'free-model': { input: 100, output: 200, reasoning: 0, cacheRead: 900, calls: 3, failed: 0 } },
  samples: [],
}
const base = buildStats(stats, [{ id: 'free-model', name: 'Free Model' }], { includeCacheRead: true })
const untouched = mergeChannelStats(base, undefined, { includeCacheRead: true })
assert.equal(untouched, base, '无台账时返回原对象，不做无谓改写')

// ── 4. 合并后图表合计 === grand 合计（两种口径都要自洽） ─────────────────────
for (const includeCacheRead of [true, false]) {
  const merged = mergeChannelStats(buildStats(stats, [], { includeCacheRead }), usage, { includeCacheRead })
  const chart = merged.days.reduce((sum, row) => sum + row.total, 0)
  const grand = merged.grand.input + merged.grand.output + (includeCacheRead ? merged.grand.cacheRead : 0)
  assert.equal(chart, grand, `includeCacheRead=${includeCacheRead} 时图表与累计必须一致`)
  assert.ok(merged.days.some(row => row.day === '2026-10-25'), '台账的新日期补进曲线')
}

// ── 5. 缓存读口径真的生效，且默认不变 ───────────────────────────────────────
const withCache = buildStats(stats, [], { includeCacheRead: true })
const withoutCache = buildStats(stats, [])
assert.equal(withCache.days[0].total, 300 + 900, '开启后 total 含缓存读')
assert.equal(withoutCache.days[0].total, 300, '默认口径保持历史行为（独立端不受影响）')
assert.equal(withCache.grand.cacheRead, 900, 'grand.cacheRead 单列可用')
assert.equal(withCache.grand.input + withCache.grand.output + withCache.grand.cacheRead, withCache.days[0].total, '累计与曲线同源')

// ── 6. 请求数 / 失败数并入 ──────────────────────────────────────────────────
const merged = mergeChannelStats(base, usage, { includeCacheRead: true })
assert.equal(merged.requests, 3 + 21, '渠道物理请求累加（10+5+4+2，坏行不计）')
assert.equal(merged.requestFailures, 0 + 1, '渠道错误累加')
assert.equal(merged.grand.turns, base.grand.turns, '逻辑回合不因渠道而虚增')

// ── 7. 台账路径与渠道侧一致 ─────────────────────────────────────────────────
delete process.env.DSH_CHANNEL_PACK_STATE_DIR
assert.equal(resolveChannelLedgerPath('/home/x'), path.join('/home/x', 'channel-pack', 'token-ledger.json'))
process.env.DSH_CHANNEL_PACK_STATE_DIR = '/tmp/override-state'
assert.equal(resolveChannelLedgerPath('/home/x'), path.join('/tmp/override-state', 'channel-pack', 'token-ledger.json'), '环境变量优先')
delete process.env.DSH_CHANNEL_PACK_STATE_DIR

console.log('channel-usage: 7 组断言通过（台账聚合 / 容错 / 口径 / 路径一致）')
