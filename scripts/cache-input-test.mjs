/**
 * Anthropic 缓存读必须计入输入（2026-11-16 用户报「缓存也算输入」）。
 *
 * 语义差异是根：
 * - OpenAI/Responses 的 `input_tokens` **已含** `cached_tokens`（子集）
 * - Anthropic Messages 的 `input_tokens` **不含** `cache_read_input_tokens`
 *
 * `mapUsage()` 按 OpenAI 语义做 `inputTokens = prompt_tokens - cached_tokens`，
 * 所以 `message_start` 处必须先把「非缓存输入 + 缓存读」合成 `prompt_tokens`；
 * 否则减完归零、缓存整笔被吃掉。
 */
import assert from 'node:assert/strict'
import { mapUsage } from '../src/stream.js'

let failures = 0
const check = async (name, run) => {
  try { await run(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

/** 复现 message_start 的构造方式（与 stream.js 里一致）。 */
const fromAnthropic = ({ input, cacheRead, cacheWrite, output }) => mapUsage({
  prompt_tokens: (input ?? 0) + (cacheRead ?? 0),
  completion_tokens: output,
  prompt_tokens_details: { cached_tokens: cacheRead, cache_write_tokens: cacheWrite },
})

await check('① 缓存读计入总量：非缓存 100 + 缓存读 800 → 900', async () => {
  const mapped = fromAnthropic({ input: 100, cacheRead: 800, output: 50 })
  assert.equal(mapped.inputTokens, 100, 'inputTokens 应为非缓存部分')
  assert.equal(mapped.cacheReadTokens, 800, '缓存读单列保留')
  // toOpenAiUsage 会做 inputTokens + cacheRead，还原成总输入
  assert.equal(mapped.inputTokens + mapped.cacheReadTokens, 900)
})

await check('② 旧写法（不并缓存）会把输入抹成 0 —— 回归锚点', async () => {
  const broken = mapUsage({
    prompt_tokens: 100,        // 只有非缓存输入
    completion_tokens: 50,
    prompt_tokens_details: { cached_tokens: 800 },
  })
  assert.equal(broken.inputTokens, 0, '100-800 被 Math.max(0,…) 抹平')
  assert.equal(broken.inputTokens + (broken.cacheReadTokens ?? 0), 800, '总量只剩缓存，非缓存丢光')
})

await check('③ 无缓存时行为不变', async () => {
  const mapped = fromAnthropic({ input: 1214, cacheRead: 0, output: 212 })
  assert.equal(mapped.inputTokens, 1214)
  assert.equal(mapped.cacheReadTokens, undefined, '0 不落字段')
})

await check('④ 思考已含在输出里：outputTokens 不被裁剪', async () => {
  const mapped = fromAnthropic({ input: 15, cacheRead: 0, output: 200 })
  assert.equal(mapped.outputTokens, 200, 'Anthropic 的 output_tokens 本就含 thinking')
})

await check('⑤ 缓存写单独保留，不并进非缓存输入', async () => {
  const mapped = fromAnthropic({ input: 100, cacheRead: 0, cacheWrite: 50, output: 10 })
  assert.equal(mapped.inputTokens, 100)
  assert.equal(mapped.cacheWriteTokens, 50)
})

if (failures > 0) console.error(`cache-input-test: ${failures} failure(s)`)
else console.log('cache-input-test: cache reads are counted as input')
process.exitCode = failures > 0 ? 1 : 0
