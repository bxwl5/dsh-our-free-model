/**
 * AutoClaw 短信登录的纯函数测试（不联网、不发短信）。
 *
 * 只在 `--source` 模式下运行：`channel-pack-test.mjs` 的加载钩子会把 `.ts` 转译进来。
 * 覆盖：签名算法、手机号归一、两个请求的形状与签名、凭据映射（JWT exp 优先、
 * UUID user_id 优先、Bearer 前缀剥离）、上游错误码透传。
 */
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'

/**
 * 直连本地登录页（不能走 `globalThis.fetch`：channel-pack-test 在挂载期间把它
 * 换成了「一律拒绝」的离线钩子，用来保证测试不出网）。
 */
function localCall(url, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: payload === undefined ? 'GET' : 'POST',
      headers: payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    if (payload !== undefined) request.write(payload)
    request.end()
  })
}

const KEY = '38d2391985e2369a5fb8227d8e6cd5e5'

/** 造一个 JWT（不签名，只为读 payload）。 */
function jwt(payload) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.sig`
}

export async function verifyAutoclawSms() {
  const sms = await import('../vendor/channel-pack/src/autoclaw-sms.ts')
  const { AUTOCLAW } = await import('../vendor/channel-pack/src/autoclaw-product.ts')

  // 1) 签名：固定输入 → 固定 MD5（与兄弟插件 `calculateAutoclawSign` 同式）。
  assert.equal(sms.autoclawSign('100003', 1700000000, KEY), '2586ea4cc4191242c9acdc2ee7e96ac8')
  const headers = sms.autoclawAuthHeaders(1700000000)
  assert.equal(headers['X-Auth-Sign'], '2586ea4cc4191242c9acdc2ee7e96ac8')
  assert.equal(headers['X-Auth-Appid'], '100003')
  assert.equal(headers['X-Auth-TimeStamp'], '1700000000')
  assert.equal(headers['X-Channel'], 'official')

  // 2) 手机号归一：容忍 +86 / 86 / 空格横线，拒绝非法。
  assert.equal(sms.normalizeAutoclawPhone('+8617683839846'), '17683839846')
  assert.equal(sms.normalizeAutoclawPhone('8617683839846'), '17683839846')
  assert.equal(sms.normalizeAutoclawPhone('176 8383 9846'), '17683839846')
  assert.equal(sms.normalizeAutoclawPhone('12345'), '')
  assert.equal(sms.normalizeAutoclawPhone('+1 555 0100'), '')

  // 3) 发码请求：URL / 头 / 体都要对，且签名可复算。
  const seen = []
  const fakeFetch = body => async (input, init) => {
    const url = String(input)
    seen.push({ url, headers: init?.headers, body: JSON.parse(init.body) })
    return Response.json(body)
  }
  const deviceId = 'fixture-device'
  const sent = await sms.sendAutoclawCode({
    product: AUTOCLAW,
    fetcher: fakeFetch({ code: 0, msg: 'SUCCESS' }),
    phone: '+8617683839846',
    deviceId,
  })
  assert.deepEqual(sent, { ok: true })
  assert.ok(seen[0].url.endsWith('/userapi/v1/agent-send-code'), seen[0].url)
  assert.equal(seen[0].body.phone, '17683839846')
  assert.equal(seen[0].body.source_id, 'autoclaw')
  assert.equal(seen[0].body.device_id, deviceId)
  assert.equal(
    seen[0].headers['X-Auth-Sign'],
    sms.autoclawSign(seen[0].headers['X-Auth-Appid'], seen[0].headers['X-Auth-TimeStamp'], KEY),
    '发码请求的签名必须等于 md5(appId&ts&appKey)',
  )

  // 4) 登录请求 + 凭据映射：JWT exp 优先于上游声明；UUID user_id 优先；Bearer 剥离。
  const exp = Math.floor(Date.now() / 1000) + 86_400
  const access = `Bearer ${jwt({ exp, user_id: 424242 })}`
  const loginFetch = fakeFetch({
    code: 0,
    data: {
      access_token: access,
      refresh_token: 'Bearer refresh-xyz',
      // 故意给一个假的声明值，验证 JWT exp 优先。
      expires_at: 1,
      user_id: 'db83134a66ecc2a95cb5f8ea485a7df8',
    },
  })
  const login = await sms.loginAutoclawWithCode({
    product: AUTOCLAW,
    fetcher: loginFetch,
    phone: '17683839846',
    code: '645067',
    deviceId,
  })
  assert.equal(login.ok, true)
  const credential = login.credential
  assert.ok(!credential.access_token.startsWith('Bearer'), 'access_token 必须剥掉 Bearer')
  assert.equal(credential.refresh_token, 'refresh-xyz')
  assert.equal(credential.expire_time, exp * 1000, '过期时间必须用 JWT exp，不是上游声明值')
  assert.equal(credential.account_id, 'db83134a66ecc2a95cb5f8ea485a7df8', 'account_id 用服务端 UUID')
  assert.equal(credential.device_id, deviceId, 'device_id 必须随凭据保存')
  assert.equal(credential.nickname, 'AutoClaw 9846')
  const loginSeen = seen[1]
  assert.ok(loginSeen.url.endsWith('/userapi/v1/agent-login'))
  assert.equal(loginSeen.body.code, 645067, 'code 必须发数字')
  assert.equal(loginSeen.body.phone, '17683839846')

  // 5) 错误码透传：code !== 0 时给出上游 msg，且不产生凭据。
  const bad = await sms.loginAutoclawWithCode({
    product: AUTOCLAW,
    fetcher: fakeFetch({ code: 1001, msg: '验证码错误' }),
    phone: '17683839846',
    code: '000000',
    deviceId,
  })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /验证码错误/)

  // 6) 非法输入在本地就被拒，不发请求。
  const noNetwork = async () => { throw new Error('不应该发请求') }
  assert.equal((await sms.sendAutoclawCode({ product: AUTOCLAW, fetcher: noNetwork, phone: '123', deviceId })).ok, false)
  assert.equal((await sms.loginAutoclawWithCode({ product: AUTOCLAW, fetcher: noNetwork, phone: '17683839846', code: 'abc', deviceId })).ok, false)


  // 7) 本地登录页端到端（照 raccoon 范式）：起页 → 发码 → 提交验证码 → result 落定。
  //    fetcher 注入本地假上游，全程不联网；页面只拿到状态，拿不到 token。
  const page = await import('../vendor/channel-pack/src/autoclaw-login-page.ts')
  const upstream = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/userapi/v1/agent-send-code')) return Response.json({ code: 0, msg: 'SUCCESS' })
    if (url.endsWith('/userapi/v1/agent-login')) {
      return Response.json({
        code: 0,
        data: {
          access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600, user_id: 7 }),
          refresh_token: 'r-1',
          user_id: 'fixture-uuid',
        },
      })
    }
    throw new Error(`假上游没有该端点：${url} ${init?.method ?? 'GET'}`)
  }
  const started = await page.startAutoclawLoginFlow({ product: AUTOCLAW, fetcher: upstream, deviceId, timeoutMs: 5000 })
  assert.match(started.loginUrl, /^http:\/\/127\.0\.0\.1:\d+\/autoclaw\/login$/)
  const origin = new URL(started.loginUrl).origin
  const pageResponse = await localCall(started.loginUrl)
  assert.equal(pageResponse.status, 200)
  assert.match(pageResponse.text, /发送验证码/, '登录页必须包含发码按钮')
  const sendResponse = JSON.parse((await localCall(`${origin}${page.AUTOCLAW_LOGIN_PAGE_PATHS.smsSend}`, { phone: '+8617683839846' })).text)
  assert.deepEqual(sendResponse, { ok: true })
  const verifyResponse = JSON.parse((await localCall(`${origin}${page.AUTOCLAW_LOGIN_PAGE_PATHS.smsVerify}`, { code: '645067' })).text)
  assert.deepEqual(verifyResponse, { ok: true })
  const settled = await started.result
  assert.equal(settled.account_id, 'fixture-uuid')
  assert.equal(settled.device_id, deviceId)
  await started.close()


  // 8) 续期：优先 /userapi/v1/refresh，失败退 /userapi/v1/agent-refresh；JWT exp 优先，
  //    响应没给新 refresh_token 时沿用旧的，账号身份不漂移。
  const refreshedExp = Math.floor(Date.now() / 1000) + 86_400
  const refreshPaths = []
  const refreshSuccess = await sms.refreshAutoclawCredential({
    product: AUTOCLAW,
    fetcher: async (input) => {
      refreshPaths.push(new URL(String(input)).pathname)
      return Response.json({
        code: 0,
        data: { access_token: jwt({ exp: refreshedExp, user_id: 9 }), expires_at: 1 },
      })
    },
    credential: { access_token: 'old-access', refresh_token: 'old-refresh', account_id: 'keep-me', nickname: 'AutoClaw 9846' },
  })
  assert.equal(refreshSuccess.ok, true)
  assert.deepEqual(refreshPaths, ['/userapi/v1/refresh'], '应优先用 /userapi/v1/refresh')
  assert.equal(refreshSuccess.credential.expire_time, refreshedExp * 1000, '续期同样以 JWT exp 为准')
  assert.equal(refreshSuccess.credential.refresh_token, 'old-refresh', '响应没给新 refresh_token 时沿用旧的')
  assert.equal(refreshSuccess.credential.account_id, 'keep-me', '续期不得让账号身份漂移')

  const fallbackPaths = []
  const refreshFallback = await sms.refreshAutoclawCredential({
    product: AUTOCLAW,
    fetcher: async (input) => {
      const path = new URL(String(input)).pathname
      fallbackPaths.push(path)
      if (path === '/userapi/v1/refresh') return new Response('boom', { status: 500 })
      return Response.json({ code: 0, data: { access_token: jwt({ exp: refreshedExp }) } })
    },
    credential: { access_token: 'old', refresh_token: 'r-1' },
  })
  assert.equal(refreshFallback.ok, true, '第一条端点失败应退第二条')
  assert.deepEqual(fallbackPaths, ['/userapi/v1/refresh', '/userapi/v1/agent-refresh'])

  assert.equal((await sms.refreshAutoclawCredential({ product: AUTOCLAW, fetcher: noNetwork, credential: { access_token: 'x' } })).ok, false, '没有 refresh_token 必须拒绝且不发请求')

  console.log('ok  autoclaw-sms: 签名/手机号归一/发码与登录请求形状/JWT exp 优先/UUID user_id/Bearer 剥离/错误透传/本地页端到端/续期与端点回退')
}

// 单独运行时必须失败（不能静默 exit 0）：见 scripts/lib/direct-run.mjs。
import { exitIfDirectRun } from './lib/direct-run.mjs'
exitIfDirectRun(import.meta.url, 'autoclaw-sms-test')
