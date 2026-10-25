/**
 * Gemini 地区限制（`UNSUPPORTED_LOCATION`）的可操作提示回归。
 *
 * ## 背景（用户报障原话）
 *
 * > 配额查询被拒（HTTP 403）（UNSUPPORTED_LOCATION）：Your current account is not
 * > eligible for Gemini Code Assist for individuals because it is not currently
 * > available in your location.
 *
 * 这不是登录失败、也不是额度用完：Google 只允许在**支持的国家/地区**使用
 * Gemini Code Assist 个人版。旧实现只把原始 `reason` + `message` 拼出来，
 * 用户会以为账号或登录坏了，于是反复重新登录。
 *
 * 本用例锁死：`UNSUPPORTED_LOCATION` 必须附带**可操作**的指引
 *（说明是地区限制 + 建议开启出口代理换地区），且不误报在其它 reason 上。
 */
import assert from 'node:assert/strict'
import { exitIfDirectRun } from './lib/direct-run.mjs'

export async function verifyGeminiLocationHint() {
  const { fetchGeminiCreditBalance } = await import('../vendor/channel-pack/src/gemini-credits.ts')

  const MK = (reason, message) => JSON.stringify({
    error: { code: 403, status: 'PERMISSION_DENIED', message, details: [{ reason }] },
  })

  // 1) 地区限制 → 必须给出地区 + 出口代理指引
  {
    const body = MK(
      'UNSUPPORTED_LOCATION',
      'Your current account is not eligible for Gemini Code Assist for individuals because it is not currently available in your location.',
    )
    const result = await fetchGeminiCreditBalance(
      { access_token: 'fake-token' },
      undefined,
      { force: true, fetcher: async () => new Response(body, { status: 403 }) },
    )
    assert.equal(result.balance, null, '拒绝时应返回 null balance')
    const error = result.error ?? ''
    assert.ok(error.includes('UNSUPPORTED_LOCATION'), '必须保留原始 reason 便于排查')
    assert.ok(/地区限制/.test(error), '必须点明这是地区限制（不是凭据问题）')
    assert.ok(/出口代理/.test(error), '必须给出可操作建议：开启出口代理')
    assert.ok(!/凭据已失效/.test(error), '不得误导成凭据失效')
  }

  // 2) 其它 reason 不得被塞进地区指引（避免文案污染）
  {
    const body = MK('SUBSCRIPTION_REQUIRED', 'You do not have a valid license of this product.')
    const result = await fetchGeminiCreditBalance(
      { access_token: 'fake-token-2' },
      undefined,
      { force: true, fetcher: async () => new Response(body, { status: 403 }) },
    )
    const error = result.error ?? ''
    assert.ok(error.includes('SUBSCRIPTION_REQUIRED'))
    assert.ok(!/地区限制/.test(error), '非地区限制不得附带地区指引')
  }

  console.log('ok  gemini: UNSUPPORTED_LOCATION 给出地区限制 + 出口代理指引，其它 reason 不污染')
}

exitIfDirectRun(import.meta.url, 'gemini-location-hint-test')
