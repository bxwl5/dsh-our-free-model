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

  // ── 4) 页面：不可用 → 默认短信 Tab + 提示 ──
  const unavailableHtml = page.renderRaccoonLoginPage(RACCOON, { unavailable: true })
  assert.ok(unavailableHtml.includes('扫码暂不可用'), '不可用时必须给出提示')
  assert.ok(unavailableHtml.includes('data-active="1" type="button">短信登录'), '不可用时应默认短信 Tab')

  // ── 5) 流程：申请失败 → 立刻标记不可用（短信仍可用），页面照常打开 ──
  const started = await page.startRaccoonLoginFlow({
    fetcher: async () => new Response('not found', { status: 404 }),
    timeoutMs: 4000,
  })
  try {
    const pageResponse = await getText(started.loginUrl)
    assert.equal(pageResponse.status, 200)
    assert.ok(pageResponse.text.includes('扫码登录暂不可用'), '接口失败时页面必须提示扫码不可用')
    assert.ok(pageResponse.text.includes('data-active="1" type="button">短信登录'), '并默认切到短信 Tab')
  } finally {
    await started.close()
  }

  console.log('ok  raccoon-qr: 新接口申请/扫码 URL/轮询映射/缺 token 视为未完成/不可用时默认短信')
}

// 单独运行时必须失败（不能静默 exit 0）：见 scripts/lib/direct-run.mjs。
import { exitIfDirectRun } from './lib/direct-run.mjs'
exitIfDirectRun(import.meta.url, 'raccoon-qr-test')
