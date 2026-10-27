/**
 * Raccoon Work 扫码登录：新接口（`/api/iam/v1`）的纯函数 + 本地页测试。
 *
 * 背景（2026-10-24 实测）：旧链路「本地随机 code + 固定 `/login/mp` 页」失效 ——
 * 该页对任何 code 都 404；官方前端改为**服务端下发 code + scan_path**。
 * 本用例锁死新协议的三件事：
 *   1. 申请会话的解析（qrcode_code / scan_path / expires_in / poll_interval）；
 *   2. 扫码 URL 的形状（origin + scan_path + code/appname/source）；
 *   3. 轮询映射（pending/logging/canceled/success，success 必须带 access_token）。
 * 以及「扫码不可用时页面默认展示短信 Tab 并给出提示」。
 *
 * 不联网：全部走注入的假 fetch；本地页用 node:http 直连（挂载测试期间 global fetch 被换掉）。
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

export async function verifyRaccoonQr() {
  const oauth = await import('../vendor/channel-pack/src/raccoon-oauth.ts')
  const page = await import('../vendor/channel-pack/src/raccoon-login-page.ts')
  const { RACCOON } = await import('../vendor/channel-pack/src/raccoon-product.ts')

  // ── 1) 申请会话 ──
  const created = []
  const createFetcher = async (input, init) => {
    created.push({ url: String(input), method: init?.method ?? 'GET' })
    return Response.json({
      code: 'OK',
      data: { qrcode_code: 'qr-test-1', scan_path: '/login/mp', expires_in: 300, poll_interval: 2 },
    })
  }
  const session = await oauth.createRaccoonQrSession(RACCOON, createFetcher)
  assert.ok(session !== undefined, '新接口必须能申请到扫码会话')
  assert.equal(session.qrcodeCode, 'qr-test-1')
  assert.equal(session.scanPath, '/login/mp')
  assert.equal(session.expiresIn, 300)
  assert.equal(session.pollInterval, 2)
  assert.ok(created[0].url.endsWith('/api/iam/v1/auth/mp/qrcode'), `申请端点不对：${created[0].url}`)
  assert.equal(created[0].method, 'POST')

  // ── 2) 扫码 URL 形状 ──
  const scanUrl = new URL(oauth.buildRaccoonScanUrl(RACCOON, session))
  assert.equal(scanUrl.origin, 'https://xiaohuanxiong.com')
  assert.equal(scanUrl.pathname, '/login/mp')
  assert.equal(scanUrl.searchParams.get('code'), 'qr-test-1')
  assert.equal(scanUrl.searchParams.get('appname'), '商汤小浣熊官网')
  assert.equal(scanUrl.searchParams.get('source'), 'platform')

  // ── 3) 轮询映射 ──
  const pending = await oauth.pollRaccoonQrSession(RACCOON, 'qr-test-1', async () =>
    Response.json({ code: 'OK', data: { status: 'pending' } }))
  assert.equal(pending.status, 'pending')
  const logging = await oauth.pollRaccoonQrSession(RACCOON, 'qr-test-1', async () =>
    Response.json({ code: 'OK', data: { status: 'logging', expired_at: '2026-10-24T10:00:00Z' } }))
  assert.equal(logging.status, 'logging')
  assert.equal(logging.expiredAt, '2026-10-24T10:00:00Z')
  const canceled = await oauth.pollRaccoonQrSession(RACCOON, 'qr-test-1', async () =>
    Response.json({ code: 'OK', data: { status: 'canceled' } }))
  assert.equal(canceled.status, 'canceled')
  const exp = Math.floor(Date.now() / 1000) + 3600
  const success = await oauth.pollRaccoonQrSession(RACCOON, 'qr-test-1', async () =>
    Response.json({ code: 'OK', data: { status: 'success', access_token: jwt(exp), token_type: 'Bearer' } }))
  assert.equal(success.status, 'success')
  assert.equal(success.expiresAt, String(exp * 1000), 'success 必须从 JWT exp 推出过期时间')
  const missingToken = await oauth.pollRaccoonQrSession(RACCOON, 'qr-test-1', async () =>
    Response.json({ code: 'OK', data: { status: 'success' } }))
  assert.equal(missingToken.status, 'pending', '缺 access_token 的 success 视为未完成')

  // ── 4) 页面：OAuth 主导（用户 2026-10-27 决定改用网页授权）──
  //
  // 扫码链路已随上游迁移失效（`/login/mp` 对任何 code 都 404），短信要过
  // 阿里云滑块、失败率高。故登录页改为：一张说明卡 + 「去登录」按钮 +
  // 状态轮询，用户在浏览器完成授权后由 `/auth/callback` 自动落定。
  const html = page.renderRaccoonLoginPage(RACCOON, {
    authorizeUrl: oauth.buildRaccoonAuthorizeUrl(RACCOON, {
      state: 'a'.repeat(64),
      redirectUri: 'http://127.0.0.1:1234/auth/callback',
    }),
  })
  assert.ok(html.includes('去登录'), '页面必须有「去登录」按钮')
  assert.ok(/code\/authorize/.test(html), '按钮指向官方授权页')
  assert.ok(html.includes('login_source=desktop'), '必须带 login_source=desktop')
  assert.ok(html.includes('desktop_callback=loopback'), '⚠️ 缺这个参数授权页不接受 127.0.0.1 回调')
  assert.ok(!html.includes('微信扫码'), '不再有扫码 Tab')
  assert.ok(!html.includes('短信登录'), '不再有短信 Tab')
  // 安全：页面不得包含任何密钥/token
  assert.ok(!/access_token|refresh_token|phoneCipher/i.test(html), '页面不得内联任何秘密')

  // ── 5) 授权 URL 的硬约束（授权页对 loopback 的要求）──
  const url = new URL(oauth.buildRaccoonAuthorizeUrl(RACCOON, {
    state: 'b'.repeat(64),
    redirectUri: 'http://127.0.0.1:9999/auth/callback',
  }))
  assert.equal(url.pathname, '/code/authorize')
  assert.equal(url.searchParams.get('state'), 'b'.repeat(64))
  assert.equal(url.searchParams.get('desktop_callback'), 'loopback')
  assert.equal(url.searchParams.get('redirect'), 'http://127.0.0.1:9999/auth/callback')

  // ── 6) 流程：登录页可打开且带授权链接（扫码接口失败也不影响）──
  const started = await page.startRaccoonLoginFlow({
    fetcher: async () => new Response('not found', { status: 404 }),
    timeoutMs: 4000,
  })
  try {
    const pageResponse = await getText(started.loginUrl)
    assert.equal(pageResponse.status, 200)
    assert.ok(pageResponse.text.includes('去登录'), '扫码失败也必须能给 OAuth 登录入口')
    assert.ok(/code\/authorize/.test(pageResponse.text))
  } finally {
    await started.close()
  }

  console.log('ok  raccoon-login: OAuth 授权 URL/loopback 参数/页面无秘密/扫码失败仍可登录')
}

// 单独运行时必须失败（不能静默 exit 0）：见 scripts/lib/direct-run.mjs。
import { exitIfDirectRun } from './lib/direct-run.mjs'
exitIfDirectRun(import.meta.url, 'raccoon-qr-test')
