/**
 * OAuth 渠道后台登录失败时，前端必须能拿到**可读的失败原因**。
 *
 * 缺陷（本用例锁死）：Command Code / OfficeAce / Accio 三个分支的 `.catch()`
 * 原先只写 `ctx.logger.warn`，随后 `pool.removeAccount(id)` 把占位条目删掉。
 * 于是前端 `login.poll` 既看不到账号、也看不到失败表记录，只能干等到自己的
 * 10 分钟超时，显示「登录已过期」—— 真实原因（回调返回错误、token 交换失败、
 * whoami 401 …）永远到不了用户眼前。
 *
 * 对照实现：`gemini` / `codearts` 分支把原因写进 `pendingLoginFailures`，
 * `login.poll` 读到后返回 `{ done: true, success: false, error }`。
 *
 * ⚠️ 本用例**不 mock 内部函数**，走真实链路：
 *   account.create → 真实 OAuth 状态机（本地回调服务器 / 轮询）
 *   → 真实失败 → pendingLoginFailures → login.poll
 * 上游用 `directLane.fetch` 注入的本地替身，**不出网**（只连 127.0.0.1 的回调端口）。
 *
 * ⚠️ 仅适用于 `--source` 模式（channel-pack-test.mjs 的 verifySourceRegressions）：
 * 此时 RPC 与本文件 import 的是**同一份** `direct-fetch.ts` 模块实例，
 * `directLane` 才是那个被真实请求读取的全局槽。打包态下 pack.js 自带另一份。
 */
import assert from 'node:assert/strict'

/** 反复 poll，直到拿到终态或超时。 */
async function pollUntilDone(call, accountId, provider, budgetMs = 8000) {
  const deadline = Date.now() + budgetMs
  let last
  while (Date.now() < deadline) {
    last = (await call('login.poll', { accountId, provider })).value
    if (last?.done === true) return last
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`${provider} 的 login.poll 在 ${budgetMs}ms 内没有给出终态，最后结果：${JSON.stringify(last)}`)
}

/**
 * 「上游全失败」的替身。
 *
 * - `whoami-401`：Command Code 的回调成功送达，但 whoami 拒绝该 Key。
 * - `token-500`：Accio 用授权码换 token 失败。
 * - `state-404`：OfficeAce 的授权码轮询被判 state 失效。
 */
function failingUpstream(mode, calls) {
  return async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${url}`)
    if (mode === 'whoami-401' && url.includes('/alpha/whoami')) {
      return new Response('{"error":"fixture key rejected"}', { status: 401 })
    }
    if (mode === 'token-500' && url.includes('/api/oauth/token')) {
      return new Response('fixture token exchange exploded', { status: 500 })
    }
    if (mode === 'state-404' && url.includes('/v1/claw/auth/code')) {
      return new Response('{"error":"fixture state gone"}', { status: 404 })
    }
    if (mode === 'state-404' && url.includes('/v1/claw/auth/state')) {
      return Response.json({ data: { state: 'fixture-officeace-state' } })
    }
    throw new Error(`替身没有预期的端点：${method} ${url}`)
  }
}

export async function verifyChannelOauthFailure({ call, lane } = {}) {
  assert.equal(typeof call, 'function', 'verifyChannelOauthFailure 需要 channel-pack-test 的 call 上下文')
  const { directLane } = await import('../vendor/channel-pack/src/direct-fetch.ts')
  // 打包态下 RPC 用的是 pack.js 自己那份 direct-fetch，`lane` 由调用方传入；
  // source 模式下两者是同一实例，等价。
  const activeLane = lane ?? directLane
  const savedLane = activeLane.fetch
  const calls = []
  const installUpstream = (mode) => {
    calls.length = 0
    activeLane.fetch = failingUpstream(mode, calls)
  }
  // 本机回调端点走 undici 直连，绕开测试里被禁用的 globalThis.fetch。
  const { fetch: localFetch } = await import('undici')

  try {
    // ── ① Command Code：回调送达但 Key 被 whoami 拒绝 ────────────────
    {
      installUpstream('whoami-401')
      const created = await call('account.create', { provider: 'commandcode' })
      assert.equal(created.ok, true, `account.create 应成功：${JSON.stringify(created)}`)
      const started = created.value
      assert.ok(started?.accountId && started?.loginUrl, 'Command Code 必须返回 accountId 与 loginUrl')

      const authUrl = new URL(started.loginUrl)
      const callbackUrl = new URL(authUrl.searchParams.get('callback'))
      const state = authUrl.searchParams.get('state')
      assert.equal(callbackUrl.pathname, '/callback')
      assert.ok(callbackUrl.port !== '', '回调地址必须带本地端口')

      // 用户还没在浏览器里完成授权：占位条目在，poll 是「仍在等」而不是失败。
      const pending = (await call('login.poll', { accountId: started.accountId, provider: 'commandcode' })).value
      assert.deepEqual(pending, { done: false }, '登录完成前必须是中间态')

      // 模拟 Studio 页面把 Key POST 回本地回调端口 —— 与真实流程同形。
      const posted = await localFetch(callbackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: 'fixture-key', state, userId: 'fixture-user', userName: 'Fixture' }),
      })
      assert.equal(posted.status, 500, 'whoami 拒绝时回调必须回 500')

      const failed = await pollUntilDone(call, started.accountId, 'commandcode')
      assert.equal(failed.success, false, '失败必须显式标注 success:false')
      assert.match(failed.error ?? '', /API Key 无效/, `失败原因必须可读，实际：${JSON.stringify(failed.error)}`)

      // 失败表是「消费一次即删」：第二次 poll 不再重复报同一条错误。
      const after = (await call('login.poll', { accountId: started.accountId, provider: 'commandcode' })).value
      assert.deepEqual(after, { done: false }, '失败原因只上报一次（消费后删除）')

      // 失败后占位条目必须被清掉，不留无凭据的幽灵账号。
      const listed = (await call('account.list', { provider: 'commandcode' })).value.accounts
      assert.equal(listed.some((row) => row.id === started.accountId), false, '失败后占位条目必须已删除')

      console.log('ok  Command Code OAuth 失败：回调 500 → login.poll 收到 success:false 与 whoami 原因，只报一次且不留占位')
    }

    // ── ② Accio：授权码换 token 失败 ───────────────────────────────
    {
      installUpstream('token-500')
      const created = await call('account.create', { provider: 'accio' })
      assert.equal(created.ok, true, `account.create 应成功：${JSON.stringify(created)}`)
      const started = created.value
      assert.ok(started?.accountId && started?.loginUrl, 'Accio 必须返回 accountId 与 loginUrl')

      const authUrl = new URL(started.loginUrl)
      const redirect = new URL(authUrl.searchParams.get('redirect_uri'))
      assert.equal(redirect.pathname, '/callback')
      assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256', 'Accio 必须用 PKCE')

      redirect.searchParams.set('code', 'fixture-code')
      redirect.searchParams.set('state', authUrl.searchParams.get('state'))
      const answered = await localFetch(redirect)
      assert.equal(answered.status, 500, 'token 交换失败时回调必须回 500')

      const failed = await pollUntilDone(call, started.accountId, 'accio')
      assert.equal(failed.success, false, '失败必须显式标注 success:false')
      assert.match(
        failed.error ?? '', /换 token 返回 HTTP 500/,
        `失败原因必须可读，实际：${JSON.stringify(failed.error)}`,
      )
      console.log('ok  Accio OAuth 失败：回调 500 → login.poll 收到 success:false 与 token 交换原因')
    }

    // ── ③ OfficeAce：轮询授权码被判 state 失效（无本地回调端口）────
    {
      installUpstream('state-404')
      const created = await call('account.create', { provider: 'officeace' })
      assert.equal(created.ok, true, `account.create 应成功：${JSON.stringify(created)}`)
      const started = created.value
      assert.ok(started?.accountId && started?.loginUrl, 'OfficeAce 必须返回 accountId 与 loginUrl')

      const failed = await pollUntilDone(call, started.accountId, 'officeace')
      assert.equal(failed.success, false, '失败必须显式标注 success:false')
      assert.match(failed.error ?? '', /state 已失效/, `失败原因必须可读，实际：${JSON.stringify(failed.error)}`)
      console.log('ok  OfficeAce OAuth 失败：授权码轮询 404 → login.poll 收到 success:false 与 state 失效原因')
    }

    // ── ④ 超时保护：不完成登录时后台 Promise 必须 reject，而不是永久挂起 ──
    // 三个分支的 `result` 都套了 `Promise.race([result, timeout])`：
    //   Command Code  COMMANDCODE_LOGIN_TIMEOUT_MS = 120s
    //   Accio         LOGIN_TIMEOUT_MS = 300s
    //   OfficeAce     pollAuthCode timeoutMs = 600s（默认）
    // 超时 reject 走的是与失败同一条 `.catch()` ⇒ 同样写入失败表并删占位条目，
    // 所以「用户一直不完成登录」不会让占位账号永久留在池里。
    // 这里用可注入的短超时直接验证「真的会 reject」（真实常量跑 120s 不现实）。
    {
      installUpstream('unused')
      const { startAccioLogin } = await import('../vendor/channel-pack/src/accio-auth.ts')
      const { ACCIO } = await import('../vendor/channel-pack/src/accio-product.ts')
      const startedAt = Date.now()
      const started = await startAccioLogin({ product: ACCIO, fetcher: activeLane.fetch, timeoutMs: 200 })
      await assert.rejects(
        () => started.result,
        /Accio 登录超时/,
        'Accio 必须在超时后 reject（RPC 的 catch 才会清掉占位条目）',
      )
      assert.ok(Date.now() - startedAt < 5000, '超时必须是定时器触发的，不能靠外部等待')
      await started.close()

      const { startCommandCodeLogin } = await import('../vendor/channel-pack/src/commandcode-auth.ts')
      const { COMMANDCODE } = await import('../vendor/channel-pack/src/commandcode-product.ts')
      const cc = await startCommandCodeLogin({
        product: COMMANDCODE, fetcher: activeLane.fetch, timeoutMs: 200,
      })
      await assert.rejects(() => cc.result, /Command Code 登录超时/, 'Command Code 必须在超时后 reject')
      await cc.close()
      console.log('ok  OAuth 超时保护：Accio/Command Code 的登录 Promise 会按 timeoutMs reject（不是永久挂起）')
    }
  } finally {
    activeLane.fetch = savedLane
  }
}
