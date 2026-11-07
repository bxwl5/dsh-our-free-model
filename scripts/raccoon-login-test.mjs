/**
 * Raccoon Work 登录：**官方网页授权（OAuth + loopback 回调）** 的纯函数与本地页测试。
 *
 * ## 背景（2026-10-27 用户拍板）
 *
 * 旧的「微信扫码 / 短信」双 Tab 页面整套废弃：
 * - 扫码：上游 `/login/mp` 改为服务端下发 code 后，旧链路对任何 code 都 404，
 *   用户扫码后一直 pending（`raccoon-login-page.ts` 原注释已记录）；
 * - 短信：要过阿里云滑块，失败率高且需多步手填。
 *
 * 现改为官方桌面端的网页授权：浏览器登录并授权 →
 * 302 回 `http://127.0.0.1:<port>/auth/callback?code=...&state=...` →
 * 宿主侧换码落定。**无需扫码、无需验证码、无需复制地址。**
 * 2026-11-07（用户）：壳页（只含一个「去登录」链接）删除 —— loginUrl 直接是
 * 上游授权页，点「添加账号」即直达。
 *
 * 本用例锁死：
 *   1. 授权 URL 的硬约束（/code/authorize、login_source、desktop_callback=loopback、
 *      appname、loopback redirect、64 位 hex state）；
 *   2. loopback 回调的 state 校验（伪造 state 必须 400）；
 *   3. 换码成功/失败两条路径。
 *
 * 不联网：全部走注入的假 fetch；本地页用 node:http 直连。
 */
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'

/** 造一个 JWT（不签名，只为读 exp）。 */
function jwt(exp) {
  const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64url')
  return `${enc({ alg: 'HS256' })}.${enc({ exp })}.sig`
}

function getText(url) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: 'GET', timeout: 8000 }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    request.on('timeout', () => { request.destroy(); reject(new Error(`请求超时：${url}`)) })
    request.end()
  })
}

export async function verifyRaccoonLogin() {
  const oauth = await import('../vendor/channel-pack/src/raccoon-oauth.ts')
  const page = await import('../vendor/channel-pack/src/raccoon-login-page.ts')
  const { RACCOON } = await import('../vendor/channel-pack/src/raccoon-product.ts')

  const STATE = 'a'.repeat(64)

  // ── 1) 授权 URL 的三个硬约束 ──
  // 缺任何一个，授权页都会拒绝 loopback 回调（2026-10-27 实测）。
  const authorize = new URL(oauth.buildRaccoonAuthorizeUrl(RACCOON, {
    state: STATE,
    redirectUri: 'http://127.0.0.1:1234/auth/callback',
  }))
  assert.equal(authorize.pathname, '/code/authorize', '必须指向官方授权页')
  assert.equal(authorize.searchParams.get('login_source'), 'desktop', '必须走桌面端登录')
  assert.equal(authorize.searchParams.get('appname'), '办公小浣熊客户端')
  assert.equal(authorize.searchParams.get('desktop_callback'), 'loopback',
    '⚠️ 缺这个参数授权页不接受 127.0.0.1 回调，只认 office-raccoon:// 自定义协议')
  assert.equal(authorize.searchParams.get('state'), STATE)
  assert.equal(authorize.searchParams.get('redirect'), 'http://127.0.0.1:1234/auth/callback')

  // ── 2) 页面结构 ──
  const html = page.renderRaccoonLoginPage(RACCOON, { authorizeUrl: authorize.href })
  assert.ok(html.includes('去登录'), '页面必须有「去登录」按钮')
  assert.ok(html.includes('code/authorize'), '按钮指向官方授权页')
  assert.ok(!html.includes('微信扫码'), '旧扫码 Tab 必须已移除')
  assert.ok(!html.includes('短信登录'), '旧短信 Tab 必须已移除')
  assert.ok(!html.includes('AliyunCaptcha'), '不再加载阿里云滑块脚本')
  // 安全：页面不得内联任何秘密
  assert.ok(!/access_token|refresh_token|phoneCipher|qrcode_code/i.test(html), '页面不得内联任何秘密')

  // ── 3) loginUrl 直链授权页（2026-11-07 用户：壳页多次一举，已删）──
  const started = await page.startRaccoonLoginFlow({
    fetcher: async () => new Response('not found', { status: 404 }),
    timeoutMs: 5000,
  })
  let stateFromPage
  try {
    // loginUrl 必须是上游授权页（https），带全部硬参数；不再有本地壳页。
    const login = new URL(started.loginUrl)
    assert.equal(login.protocol, 'https:', `loginUrl 应直链授权页：${started.loginUrl}`)
    assert.equal(login.pathname, '/code/authorize', '授权页路径')
    assert.equal(login.searchParams.get('login_source'), 'desktop')
    assert.equal(login.searchParams.get('desktop_callback'), 'loopback')
    assert.equal(login.searchParams.get('appname'), '办公小浣熊客户端')
    const redirect = login.searchParams.get('redirect') ?? ''
    assert.ok(redirect.startsWith('http://127.0.0.1:'), 'redirect 必须是 loopback 回调')
    // 从授权 URL 抽取真实的 state，用于下一步的伪造测试。
    const m = started.loginUrl.match(/[?&]state=([0-9a-f]{64})/)
    assert.ok(m !== null, '授权 URL 必须带 64 位 hex state')
    stateFromPage = m[1]

    // 本地 authCallback 服务器仍在（授权后的落点），端口取自 redirect 参数。
    const port = new URL(redirect).port
    assert.ok(port !== '', 'redirect 必须带 loopback 端口')
    const callback = (query) => getText(`http://127.0.0.1:${port}/auth/callback?${query}`)

    // ── 4) 伪造 state 必须被拒 ──
    const forged = await callback('code=whatever&state=' + 'b'.repeat(64))
    assert.equal(forged.status, 400, '⚠️ 伪造 state 必须 400（防别人的回调链接被塞进来）')

    // ── 5) 缺 code 必须被拒 ──
    const noCode = await callback('state=' + stateFromPage)
    assert.equal(noCode.status, 400, '缺授权码必须 400')

    // ── 6) 换码失败 → 502（不外泄 token）──
    const failed = await callback('code=bad-code&state=' + stateFromPage)
    assert.equal(failed.status, 502, '换码失败必须 502')
    assert.ok(!/access_token|token/.test(failed.text) || failed.text.includes('登录未完成'))
  } finally {
    await started.close()
  }

  // ── 7) 换码成功路径（独立流程，注入成功的假 fetch）──
  const exp = Math.floor(Date.now() / 1000) + 3600
  const tokenFetcher = async (input) => {
    assert.ok(String(input).endsWith('/login_with_authorization_code'), `换码端点不对：${input}`)
    return Response.json({
      code: 0,
      data: { access_token: jwt(exp), refresh_token: 'refresh-token-1' },
    })
  }
  const okFlow = await page.startRaccoonLoginFlow({ fetcher: tokenFetcher, timeoutMs: 5000 })
  try {
    const m = okFlow.loginUrl.match(/[?&]state=([0-9a-f]{64})/)
    assert.ok(m !== null, '授权 URL 必须带 state')
    const port = new URL(new URL(okFlow.loginUrl).searchParams.get('redirect') ?? 'http://127.0.0.1/').port
    assert.ok(port !== '', 'redirect 必须带 loopback 端口')
    const done = await getText(`http://127.0.0.1:${port}/auth/callback?code=good-code&state=${m[1]}`)
    assert.equal(done.status, 200, '换码成功必须 200')
    const credential = await okFlow.result
    assert.ok(typeof credential.access_token === 'string' && credential.access_token !== '')
    assert.equal(credential.refresh_token, 'refresh-token-1')
  } finally {
    await okFlow.close().catch(() => {})
  }

  // ── 8) 授权码失效（上游 200035）要给出可执行提示 ──
  await assert.rejects(
    async () => oauth.exchangeRaccoonAuthorizationCode(RACCOON, 'expired-code', async () =>
      Response.json({ code: 200035, message: 'authorization_code_not_found_error' })),
    /授权码已失效/,
  )

  console.log('ok  raccoon-login: 授权 URL 三约束/页面无秘密与旧 Tab/伪造 state 拒绝/缺码拒绝/换码成功与失效')
}

// 单独运行时必须失败（不能静默 exit 0）：见 scripts/lib/direct-run.mjs。
import { exitIfDirectRun } from './lib/direct-run.mjs'
exitIfDirectRun(import.meta.url, 'raccoon-login-test')
