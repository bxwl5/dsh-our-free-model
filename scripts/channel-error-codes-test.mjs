/**
 * 上游错误码归类的**词边界**与 **HTTP 402** 回归（2026-11-04 全仓审查）。
 *
 * ## 两个真实缺陷
 *
 * ### ① 裸 `includes('1005')` 会把「别的码的数字片段」也算上
 *
 * `1005` / `1113` / `3007` / `3009` / `1002` 原先一律用裸 `includes`。一旦上游
 * 在别处回出 `11005`、`plan-1005-trust`、`30077` 这类串，判定就会**假阳性**：
 * - `isZcodeQuotaExhausted` 误判 ⇒ 把一个**完全可用**的账号标记成「当日用尽」
 *   并切走（与 qoder 那次「把 rate_limit 当成 billing」同型）；
 * - `isZcodeCaptchaRejected` 误判 ⇒ 白产一个 captcha 并重发，多烧一次
 *   设备级配额（Alibaba captcha 对设备有硬上限）。
 *
 * 同文件的 `3012` 早已修成词边界，其余码当时没跟上 —— 本用例把它们钉住。
 *
 * ### ② 5 份 `httpErrorCode` 副本全都不认 `402`
 *
 * `402 Payment Required` 是**额度用尽**的规范码，与 429（限流，等一会儿会恢复）
 * 的用户动作**完全相反**。缺失时它会落进兜底 `HTTP_402`：既不在 harness 的
 * 可重试集合里、也不触发换号，最终把一个明确的「没额度了」当成陌生 HTTP 错误
 * 直接抛给用户。
 */
import assert from 'node:assert/strict'

/** 某个数字是否在正文里以**独立词**出现（与被测实现同口径，但独立写一遍）。 */
const token = (body, code) => new RegExp(`(?<![0-9A-Za-z_-])${code}(?![0-9A-Za-z_-])`).test(body)

export async function verifyChannelErrorCodes() {
  const zcode = await import('../vendor/channel-pack/src/zcode-adapter.ts')
  const transport = await import('../vendor/channel-pack/src/zcode-transport.ts')
  const compat = await import('../vendor/channel-pack/src/openai-compat.ts')
  const diagnostics = await import('../vendor/channel-pack/src/zcode-diagnostics.ts')

  // ── 1. hasZcodeCode 的词边界 ──
  const boundaries = [
    // [正文, 码, 期望]
    ['{"code":1005,"msg":"exceed quota limit"}', 1005, true],
    ['error: 1005 blocked', 1005, true],
    ['{"code":11005}', 1005, false],            // 更长的码，不是 1005
    ['plan-1005-trust', 1005, false],           // 标识符片段
    ['trust_1005', 1005, false],
    ['x1005y', 1005, false],
    ['5001005', 1005, false],
    ['{"code":1113}', 1113, true],
    ['{"code":3013}', 1113, false],
    ['{"code":3007}', 3007, true],
    ['{"code":13007}', 3007, false],
  ]
  for (const [body, code, expected] of boundaries) {
    assert.equal(diagnostics.hasZcodeCode(body, code), expected,
      `hasZcodeCode(${JSON.stringify(body)}, ${code}) 应为 ${expected}`)
    // 与被测实现交叉校验一遍：两边口径必须完全一致。
    assert.equal(diagnostics.hasZcodeCode(body, code), token(body, code),
      `hasZcodeCode 与独立实现口径不一致：${JSON.stringify(body)}`)
  }

  // ── 2. 额度判定不再被数字片段骗到 ──
  assert.equal(zcode.isZcodeQuotaExhausted(429, '{"code":1005}'), true, '真 1005 判额度用尽')
  assert.equal(zcode.isZcodeQuotaExhausted(429, '{"code":11005}'), false,
    '11005 不是 1005 —— 不得把可用账号误标成额度用尽')
  assert.equal(zcode.isZcodeQuotaExhausted(429, 'plan-1005-trust'), false,
    '标识符里的 1005 不算额度用尽')
  assert.equal(zcode.isZcodeQuotaExhausted(429, '{"code":3009}'), false, '并发限流必须先排除')

  // ── 3. captcha 判定同理（误判要多烧一次设备级配额） ──
  assert.equal(zcode.isZcodeCaptchaRejected(200, '{"code":3007}'), true, '真 3007 判 captcha 被拒')
  assert.equal(zcode.isZcodeCaptchaRejected(200, '{"code":13007}'), false,
    '13007 不是 3007 —— 不得白产 captcha')

  // ── 4. 换通道判据只在「429 + 1005/1113」时成立 ──
  assert.equal(transport.shouldFallbackToOtherChannel(429, '{"code":1005}'), true)
  assert.equal(transport.shouldFallbackToOtherChannel(429, '{"code":1113}'), true)
  assert.equal(transport.shouldFallbackToOtherChannel(200, '{"code":1005}'), false, '非 429 不换腿')
  assert.equal(transport.shouldFallbackToOtherChannel(429, '{"code":11005}'), false, '数字片段不换腿')
  assert.equal(transport.shouldFallbackToOtherChannel(429, '{"code":3012}'), false,
    '风控 3012 不换腿（重试会加重冷却惩罚）')

  // ── 5. HTTP 402 在所有错误码表里都必须归为额度用尽 ──
  assert.equal(compat.httpErrorCode(402), 'QUOTA_EXCEEDED', 'openai-compat 共享映射必须认 402')
  assert.equal(zcode.httpErrorCodeForZcode(402, ''), 'QUOTA_EXCEEDED', 'zcode 映射必须认 402')
  // 429 仍是限流（语义不能被 402 抢走）
  assert.equal(compat.httpErrorCode(429), 'RATE_LIMIT')
  assert.equal(zcode.httpErrorCodeForZcode(429, ''), 'RATE_LIMIT')

  // ── 6. 仍是纯函数：不得因为词边界改动而改变既有归类 ──
  assert.equal(compat.httpErrorCode(401), 'AUTH')
  assert.equal(compat.httpErrorCode(400), 'INVALID_REQUEST')
  assert.equal(compat.httpErrorCode(503), 'SERVER')
  assert.equal(compat.httpErrorCode(418), 'HTTP_418', '未列出的状态码仍走兜底')
  assert.equal(zcode.httpErrorCodeForZcode(200, '{"code":3007}'), 'RATE_LIMIT', '3007 仍归限流')
  assert.equal(zcode.httpErrorCodeForZcode(200, '{"code":3012}'), 'PERMISSION', '3012 仍归风控')

  console.log('ok  错误码词边界 + HTTP 402 归类（zcode/transport/openai-compat）')
}

// 直接 `node scripts/channel-error-codes-test.mjs` 时**不会**零断言静默通过：
// 本模块由 `channel-pack-test.mjs --source` import 后调用（它负责把 `.js` 重映射到
// `.ts`）。单独运行缺那层 hooks，动态 import 会直接失败 —— 但为了给出可读的提示
// 而不是一句 MODULE_NOT_FOUND，这里显式跑一遍并让失败可见。
import { exitIfDirectRun } from './lib/direct-run.mjs'
if (!exitIfDirectRun(import.meta.url, 'channel-error-codes-test')) {
  await verifyChannelErrorCodes()
}

/**
 * 第二部分：`{error:{...}}` 帧必须**分类**，不能一律 `SERVER`。
 *
 * ## 背景（2026-11-04 审查 P2-3）
 *
 * `SERVER` 在 harness 的 `DEFAULT_RETRYABLE_CODES` 里。一个「模型不存在」被归成
 * `SERVER` 就会被**白退避重试 5 次**（≈15.5 秒），用户看到「重试延迟：7220毫秒」，
 * 真正的原因被重试掩盖。同文件里「Qoder 风格错误帧」早就做了区分，只有这条
 * 最常见的 OpenAI 形态没做。
 */
export async function verifyErrorFrameClassification() {
  const compat = await import('../vendor/channel-pack/src/openai-compat.ts')
  assert.equal(typeof compat.classifyErrorFrame, 'function', 'classifyErrorFrame 必须导出')

  const cases = [
    // [error 帧, 期望码, 理由]
    [{ code: 'model_not_found', message: 'model xyz does not exist' }, 'INVALID_REQUEST', '模型不存在是确定性的'],
    [{ type: 'invalid_request_error', message: 'bad param' }, 'INVALID_REQUEST', '参数非法'],
    [{ code: 'billing_error', message: 'billing daily count exceeded' }, 'QUOTA_EXCEEDED', '额度耗尽'],
    [{ code: 'insufficient_quota', message: 'no balance' }, 'QUOTA_EXCEEDED', '余额不足'],
    [{ code: 'invalid_api_key', message: 'bad key' }, 'AUTH', '凭据坏了，重试必然再坏'],
    [{ code: 'rate_limit_exceeded', message: 'slow down' }, 'RATE_LIMIT', '限流是可以等的'],
    [{ code: 'context_length_exceeded', message: 'too long' }, 'CONTEXT_WINDOW_EXCEEDED', '交给 compaction'],
    [{ code: 'unknown_thing', message: 'mystery' }, 'SERVER', '拿不准就保持历史行为（可重试）'],
    [{ message: 'upstream exploded' }, 'SERVER', '只有 message 时保守归 SERVER'],
  ]
  for (const [frame, expected, why] of cases) {
    assert.equal(compat.classifyErrorFrame(frame), expected,
      `${JSON.stringify(frame)} 应归 ${expected}（${why}）`)
  }

  // ⚠️ 关键：确定性的错误**不得**是 SERVER（否则被白重试 5 次）。
  const retryable = new Set(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'])
  for (const frame of [{ code: 'model_not_found' }, { code: 'billing_error' }, { code: 'invalid_api_key' }]) {
    assert.equal(retryable.has(compat.classifyErrorFrame(frame)), false,
      `${JSON.stringify(frame)} 不能被归成可重试码`)
  }

  console.log('ok  错误帧分类：确定性错误不再落 SERVER（模型不存在/额度/鉴权/上下文超限）')
}
