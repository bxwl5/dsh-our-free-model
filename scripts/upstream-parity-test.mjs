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
/**
 * 从**构建产物** `vendor/channel-pack/testkit.js` 导入内部函数。
 *
 * ## 为什么不是在运行期打包源码
 * 第一版让本文件在运行时调 esbuild 打包 `.ts`：本机可行（Node 24 能直接
 * 吃 `.ts`），但 CI 的 `offline` job 只跑 `npm install --ignore-scripts`
 * —— esbuild 的二进制没装，用例直接
 * `ERR_MODULE_NOT_FOUND: .../node_modules/esbuild/lib/main.js` 挂掉。
 *
 * 现在改为构建期产出（见 `scripts/build-channel-pack.mjs` 的 testkit 段），
 * 运行期零依赖。`testkit.js` 不在 `package.json` 的 `files` 里，
 * 所以它是仓库内测试资产、不进发布包。
 */
const {
  classifyTraeError, classifyTraeStreamCode, recordsTraeRateLimit, shouldRotateTraeAccount,
  fetchTokenRates, resetOfficeAceTokenRatesCache,
} = await import('../vendor/channel-pack/testkit.js')

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

// ── ② OfficeAce 倍率首次读取重试 ────────────────────────────────────────
//
// 此前只尝试一次：网络抖动 / 网关刚签发令牌未就绪 / 偶发 5xx 都会让本次目录
// **完全没有倍率**，而「首屏没倍率」和「这个模型没倍率」看起来一模一样。
{
  const credential = {
    access_key: 'ak',
    secret_key: 'sk',
    project_id: 'p',
    model_info: { model_api_url_base: 'https://gw.example.com' },
  }
  const okBody = JSON.stringify({ models: [{ model_name: 'glm-5.3', cost_coefficient: 0.79 }] })
  const jsonResponse = (status, body) => new Response(body, { status, headers: { 'content-type': 'application/json' } })

  await check('OfficeAce 倍率：瞬时 5xx 后会重试并成功拿到倍率', async () => {
    resetOfficeAceTokenRatesCache()
    let calls = 0
    const fetcher = async () => {
      calls++
      return calls < 3 ? jsonResponse(503, 'busy') : jsonResponse(200, okBody)
    }
    const rates = await fetchTokenRates(fetcher, credential)
    assert.equal(calls, 3, '前两次 503 应当重试，第三次成功')
    assert.equal(rates.get('glm-5.3'), 0.79, '最终应拿到倍率')
  })

  await check('OfficeAce 倍率：401 是确定性结论，不重试（白打上游没意义）', async () => {
    resetOfficeAceTokenRatesCache()
    let calls = 0
    const fetcher = async () => { calls++; return jsonResponse(401, 'denied') }
    const rates = await fetchTokenRates(fetcher, credential)
    assert.equal(calls, 1, '401 不该重试')
    assert.equal(rates.size, 0, '失败降级为空表，不影响模型可用')
  })

  await check('OfficeAce 倍率：一直 5xx 时最多尝试 TOKEN_RATES_ATTEMPTS 次后放弃', async () => {
    resetOfficeAceTokenRatesCache()
    let calls = 0
    const fetcher = async () => { calls++; return jsonResponse(500, 'boom') }
    const rates = await fetchTokenRates(fetcher, credential)
    assert.equal(calls, 3, '上限 3 次，不能无限重试')
    assert.equal(rates.size, 0)
  })

  await check('OfficeAce 倍率：200 但空表不重试（那是上游的真实答案）', async () => {
    resetOfficeAceTokenRatesCache()
    let calls = 0
    const fetcher = async () => { calls++; return jsonResponse(200, JSON.stringify({ models: [] })) }
    await fetchTokenRates(fetcher, credential)
    assert.equal(calls, 1, '空表是确定性结果，重试无意义')
  })
}
