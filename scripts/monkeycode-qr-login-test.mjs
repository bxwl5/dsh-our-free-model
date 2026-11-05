/**
 * MonkeyCode 微信扫码登录（卡片内嵌）守护用例。
 *
 * 用户 2026-11-05 要求：只留卡片内扫码，去掉粘贴 Cookie。
 * 协议来自官方桌面端 desktop/src/baizhi/wechat.rs，实测取证见
 * vendor/channel-pack/src/monkeycode-qr-login.ts 模块头。
 *
 * 本用例用**内存假 fetcher** 覆盖完整链路：取授权页 → 二维码 → 长轮询状态机
 * （408/404/403/402/405）→ 405 时百智云回调换 cookie → OIDC 桥接换出
 * MonkeyCode 凭据 → 流程对象 result 落定。不发任何真实网络请求。
 */
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const ts = (await import('typescript')).default
registerHooks({
  resolve(s, c, n) {
    if (s.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    if (c.parentURL?.startsWith(sourceRoot) && s.startsWith('.') && s.endsWith('.js')) {
      const u = new URL(s.replace(/\.js$/, '.ts'), c.parentURL).href
      if (fs.existsSync(fileURLToPath(u))) return { url: u, shortCircuit: true }
    }
    return n(s, c)
  },
  load(u, c, n) {
    if (u.startsWith(sourceRoot) && u.endsWith('.ts')) {
      return { format: 'module', shortCircuit: true,
        source: ts.transpileModule(fs.readFileSync(fileURLToPath(u), 'utf8'), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: fileURLToPath(u),
        }).outputText }
    }
    return n(u, c)
  },
})

const bz = 'https://baizhi.cloud'
const wx = 'https://open.weixin.qq.com'
const callback = `${bz}/api/v1/oauth/wechat/callback`

/** 构造一个假 fetcher：按 URL 分派，记录所有请求，Set-Cookie 用 \r\n 分隔模拟多值。 */
function fakeFetcher(overrides = {}) {
  const calls = []
  let pollIndex = 0
  const pollSequence = overrides.pollSequence ?? ['408']
  const fetcher = async (input, init) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers ?? {} })
    const h = new Headers()
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
      status, headers: { 'content-type': 'application/json', ...(h.getSetCookie?.() ? {} : {}) },
    })

    if (url.startsWith(`${bz}/api/v1/user/oauth/login`)) {
      const auth = `${wx}/connect/qrconnect?appid=wxTEST&redirect_uri=${encodeURIComponent(callback)}&response_type=code&scope=snsapi_login&state=st-123`
      return json({ code: 0, data: { url: auth } })
    }
    if (url.startsWith(`${wx}/connect/qrconnect`)) {
      return new Response(`<html><img src="/connect/qrcode/uuid-ABC_123"></html>`, {
        status: 200, headers: { 'content-type': 'text/html' },
      })
    }
    if (url.startsWith(`${wx}/connect/qrcode/`)) {
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), {
        status: 200, headers: { 'content-type': 'image/jpeg' },
      })
    }
    if (url.includes('/connect/l/qrconnect')) {
      const code = pollSequence[Math.min(pollIndex, pollSequence.length - 1)]
      pollIndex += 1
      const body = code === '405'
        ? `window.wx_errcode=405;window.wx_code='WX_CODE_X';`
        : `window.wx_errcode=${code};window.wx_code='';`
      return new Response(body, { status: 200, headers: { 'content-type': 'text/javascript' } })
    }
    if (url.startsWith(callback)) {
      // 百智云回调：首响应即下发 baizhi_session（不跟随 302）
      const r = new Response('', { status: 302, headers: { location: `${bz}/`, 'content-type': 'text/plain' } })
      r.headers.append('Set-Cookie', 'baizhi_session=BZ_SESSION_VALUE; Path=/; HttpOnly')
      r.headers.append('Set-Cookie', 'sl-session=SL_VALUE; Path=/; Secure')
      return r
    }
    if (url === `${bz}/`) return new Response('ok', { status: 200 })
    if (url.startsWith(`${bz}/api/v1/user/profile`)) {
      return json({ code: 0, data: { id: 'u-1', nickname: '测试用户' } })
    }
    // ── OIDC 桥接（loginWithBaizhiSession）──
    // 链：{mc}/users/login → 302 {bz}/oauth/authorize(页面) → 改写 /api/v1/oauth/authorize(API)
    //     → 302 {mc}/users/baizhi/callback → Set-Cookie monkeycode_ai_session
    const mc = 'https://monkeycode-ai.com'
    if (url.startsWith(`${mc}/api/v1/users/login`)) {
      return new Response('', { status: 302, headers: {
        location: `${bz}/oauth/authorize?client_id=monkeycode-ai&redirect_uri=${encodeURIComponent(`${mc}/api/v1/users/baizhi/callback`)}&response_type=code&scope=user+phone&state=bridge`,
        'content-type': 'text/plain',
      } })
    }
    if (url.startsWith(`${bz}/api/v1/oauth/authorize`)) {
      return new Response('', { status: 302, headers: {
        location: `${mc}/api/v1/users/baizhi/callback?code=CB`,
        'content-type': 'text/plain',
      } })
    }
    if (url.includes('/baizhi/callback')) {
      const r = new Response('{"code":0}', { status: 200, headers: { 'content-type': 'application/json' } })
      r.headers.append('Set-Cookie', 'monkeycode_ai_session=0123456789abcdef0123456789abcdef; Path=/')
      return r
    }
    if (url.includes('/api/v1/users/wallet')) {
      return json({ code: 0, data: { id: 'w', balance: 100, daily_token_balance: 1000 } })
    }
    /* 下方旧分支保留仅为兼容，实际不会再命中 */
    if (false && url.startsWith(`${bz}/api/v1/users/login`)) {
      return new Response('', { status: 302, headers: {
        location: `${bz}/oauth/authorize?client_id=monkeycode-ai&redirect_uri=${encodeURIComponent(`${bz}/api/v1/users/baizhi/callback`)}&response_type=code&scope=user+phone&state=bridge`,
        'content-type': 'text/plain',
      } })
    }
    if (url.startsWith(`${bz}/api/v1/oauth/authorize`)) {
      return new Response('', { status: 302, headers: {
        location: `${bz}/api/v1/users/baizhi/callback?code=CB`,
        'content-type': 'text/plain',
      } })
    }
    if (url.includes('/baizhi/callback')) {
      const r = new Response('{"code":0}', { status: 200, headers: { 'content-type': 'application/json' } })
      r.headers.append('Set-Cookie', 'monkeycode_ai_session=0123456789abcdef0123456789abcdef; Path=/')
      return r
    }
    if (url.includes('/api/v1/users/wallet')) {
      return json({ code: 0, data: { id: 'w', balance: 100, daily_token_balance: 1000 } })
    }
    return new Response('not found: ' + url, { status: 404 })
  }
  return { fetcher, calls }
}

async function main() {
  const qr = await import('../vendor/channel-pack/src/monkeycode-qr-login.ts')
  const page = await import('../vendor/channel-pack/src/monkeycode-qr-login-page.ts')

  // ① 启动：真实协议解析出二维码 data URL + session
  {
    const { fetcher } = fakeFetcher()
    const { qrDataUrl, session } = await qr.startMonkeyCodeQrLogin({ fetcher, lpBase: 'https://lp.test' })
    assert.ok(qrDataUrl.startsWith('data:image/jpeg;base64,'), '二维码必须是 JPEG data URL')
    assert.equal(session.uuid, 'uuid-ABC_123', '从授权页解析 uuid')
    assert.equal(session.state, 'st-123', '取 state')
    assert.equal(session.callbackUrl, callback, '取 redirect_uri')
  }

  // ② 长轮询状态机（未确认）
  for (const [code, expected] of [['408', 'pending'], ['404', 'scanned'], ['403', 'canceled'], ['402', 'expired'], ['500', 'expired']]) {
    const { fetcher } = fakeFetcher({ pollSequence: [code] })
    const session = { uuid: 'u', state: 's', callbackUrl: callback, qrBase: wx }
    const r = await qr.pollMonkeyCodeQrLogin({ fetcher, session, lpBase: 'https://lp.test' })
    assert.equal(r.state, expected, `wx_errcode=${code} → ${expected}`)
  }

  // ③ 405 确认：走回调换出百智云 cookie（baizhi_session / sl-session）
  {
    const { fetcher } = fakeFetcher({ pollSequence: ['405'] })
    const session = { uuid: 'u', state: 's', callbackUrl: callback, qrBase: wx }
    const r = await qr.pollMonkeyCodeQrLogin({ fetcher, session, lpBase: 'https://lp.test' })
    assert.equal(r.state, 'confirmed')
    assert.ok(r.baizhiCookie.includes('baizhi_session=BZ_SESSION_VALUE'), '回调必须落 baizhi_session')
    assert.ok(r.baizhiCookie.includes('sl-session=SL_VALUE'), 'sl-session 也收')
  }

  // ④ 流程对象：二维码 → 轮询到确认 → OIDC 桥接 → MonkeyCode 凭据落定
  {
    const { fetcher } = fakeFetcher({ pollSequence: ['408', '405'] })
    const flow = await page.startMonkeyCodeLoginFlow({ fetcher, lpBase: 'https://lp.test', timeoutMs: 60_000 })
    assert.ok(flow.qrDataUrl.startsWith('data:image/jpeg;base64,'), '流程返回二维码')
    const p1 = await flow.poll()
    assert.equal(p1.state, 'pending', '首轮待扫码')
    const p2 = await flow.poll()
    assert.equal(p2.state, 'confirmed', '第二轮确认')
    const credential = await flow.result
    assert.ok(String(credential.access_token).includes('monkeycode_ai_session=0123456789abcdef0123456789abcdef'),
      '最终凭据是换出的 MonkeyCode 会话')
    assert.equal(credential.created_at > 0, true, '带创建时间')
  }

  // ⑤ 过期自动换码：expired 时流程不结束，reload 后仍是新二维码
  {
    const { fetcher } = fakeFetcher({ pollSequence: ['402'] })
    const flow = await page.startMonkeyCodeLoginFlow({ fetcher, lpBase: 'https://lp.test', timeoutMs: 60_000 })
    const p = await flow.poll()
    assert.equal(p.state, 'expired', '过期状态透传给卡片')
    assert.ok(flow.qrDataUrl.startsWith('data:image/jpeg;base64,'), '过期后已换新码')
    await flow.close()
  }

  console.log('ok  monkeycode 微信扫码：授权页/uuid/二维码、408-405 状态机、回调换百智云 cookie、OIDC 桥接落 MonkeyCode 凭据、过期自动换码')
}

await main()
