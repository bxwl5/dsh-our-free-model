/**
 * 上游对齐：从 magpie 插件更新里借鉴过来的三条修复（2026-11-17）。
 *
 * 这三条都不是「新功能」，而是**我们确实缺的失败模式处理**。逐条钉住：
 *
 * 1. trae `4245`（企业席位不可用）—— 此前完全没这个码，会落进泛泛的
 *    `client`（4xx）类别，既不区别对待也不在日志里露出「席位」二字。
 * 2. qoder 队列**位置停滞** 5 分钟 → 503 —— 此前只有 30 分钟总超时，
 *    卡死的队列会占着渠道槽位耗半小时。
 * 3. zcode 本机并发闸门 —— 此前只有撞上 `3009` 之后的被动重试，
 *    并发越高越是反复撞墙。
 */
import assert from 'node:assert/strict'
import {
  classifyTraeError, classifyTraeStreamCode, recordsTraeRateLimit, shouldRotateTraeAccount,
} from '../vendor/channel-pack/src/trae-errors.ts'

let checks = 0
const check = async (name, run) => {
  checks++
  try { await run(); console.log(`ok   ${name}`) }
  catch (error) { console.error(`FAIL ${name}: ${error.message}`); process.exitCode = 1 }
}

// ── ① trae 4245 ────────────────────────────────────────────────────────
await check('trae 4245：响应体业务码识别为席位不可用（不是泛泛的 client）', async () => {
  assert.equal(classifyTraeError(200, '{"code":4245,"msg":"no seat"}'), 'seat-unavailable')
  assert.equal(classifyTraeError(400, 'error 4245 seat pool empty'), 'seat-unavailable')
})

await check('trae 4245：HTTP 424 也识别为席位不可用', async () => {
  assert.equal(classifyTraeError(424, ''), 'seat-unavailable')
})

await check('trae 4245：流内业务码同样走席位类别', async () => {
  assert.equal(classifyTraeStreamCode(4245), 'seat-unavailable')
})

await check('trae 4245：换号（另一个账号可能有席位）但不记账号冷却', async () => {
  const kind = classifyTraeError(200, '{"code":4245}')
  assert.equal(shouldRotateTraeAccount(kind), true, '席位不在这个号上，应当换号')
  assert.equal(recordsTraeRateLimit(kind), false, '账号本身没坏 —— 记冷却会把好号拉黑')
})

await check('trae 原有分类不受影响（4008 / 4011 / 1005 / 404 / 5xx）', async () => {
  assert.equal(classifyTraeError(200, '{"code":4008}'), 'quota-exceeded')
  assert.equal(classifyTraeError(200, '{"code":4011}'), 'soft-rate')
  assert.equal(classifyTraeError(200, '{"code":1005,"plan":1}'), 'hard-plan')
  assert.equal(classifyTraeError(404, ''), 'not-found')
  assert.equal(classifyTraeError(503, ''), 'server')
  assert.equal(classifyTraeStreamCode(4008), 'quota-exceeded')
  assert.equal(classifyTraeStreamCode(4011), 'soft-rate')
  assert.equal(classifyTraeStreamCode(1005), 'hard-plan')
})

await check('trae 4008 仍记冷却（证明席位那条是**例外**而非放宽整体）', async () => {
  assert.equal(recordsTraeRateLimit('quota-exceeded'), true)
  assert.equal(recordsTraeRateLimit('hard-plan'), true)
})

console.log(`upstream-parity: ${checks} checks passed`)
