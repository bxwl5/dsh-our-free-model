import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { verifyLoginLaunchers } from './standalone-login-terminal-test.mjs'

// 这些用例断言的是「免密车道 + Kilo」的目录形状（合并 / 隐藏过滤），与
// 「未登录渠道是否可见」无关；显式关闭可见性保持期望稳定。
// 默认可见性（未登录也列静态模型表）由 channel-pack-test 的 zcode 断言覆盖。
process.env.DSH_HIDE_MODELS_WITHOUT_ACCOUNT = '1'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-management-'))
const dataDir = path.join(scratch, 'data')
const model = 'mimo-v2.6-flash-free'
const kilo = 'nvidia/nemotron-3.5-lightning:free'
let calls = 0
let holdNextCall = false
let notifyCall
let notifyClosed
const upstream = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: req.url === '/models'
        ? [{ id: kilo, isFree: true, name: '测试免费模型' }]
        : [{ id: model }] }))
    } else {
      calls++
      if (holdNextCall) {
        holdNextCall = false
        res.once('close', () => notifyClosed())
        notifyCall()
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end([
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'OK' } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''))
    }
  })
})
upstream.listen(0, '127.0.0.1')
await once(upstream, 'listening')
const base = `http://127.0.0.1:${upstream.address().port}`
process.env.OUR_FREE_MODEL_BASE = base
process.env.OUR_FREE_MODEL_KILO_BASE = base
const { startStandalone } = await import('../packages/standalone/service.mjs')
// 限速器/密码口径直接测**真实现**（导出函数 + 可注入时钟，避免等真实时间）。
const { createLoginThrottle, normalizeSourceAddress, panelPasswordState } = await import('../packages/standalone/management.mjs')
let service
let cookie
let key
let failures = 0
let checks = 0
const check = async (name, run) => {
  checks++
  try { await run(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.log(`FAIL ${name}: ${error.stack}`) }
}
const getKey = () => JSON.parse(fs.readFileSync(service.keyFile, 'utf8')).forwardKey
/**
 * 面板密码（2026-11-17 起认证方式由 API Key 改为 `OFM_PASSWORD`）。
 *
 * ⚠️ 必须**显式设置**：不设密码时服务端是**完全免认证**的（用户明确要求
 *   「如果不设置，直接不需要认证」），那样下面所有「未登录应 401」的安全
 *   边界都无从验证。设了密码才能测出鉴权确实生效。
 */
const PANEL_PASSWORD = 'fixture-management-password-9f2c'
process.env.OFM_PASSWORD = PANEL_PASSWORD
const request = async (route, { body, cookie: cookieValue = cookie, headers = {}, method } = {}) => {
  if (headers.host) {
    // fetch 会自行设置 Host；用真实 HTTP 请求验证恶意 Host，不误测客户端归一化。
    return new Promise((resolve, reject) => {
      const raw = http.request(service.url + route, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: { cookie: cookieValue ?? '', 'content-type': 'application/json', ...headers },
      }, res => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode }))
      })
      raw.once('error', reject)
      raw.end(body === undefined ? undefined : JSON.stringify(body))
    })
  }
  const response = await fetch(service.url + route, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...cookieValue ? { cookie: cookieValue } : {},
      ...body === undefined ? {} : { 'content-type': 'application/json' },
      connection: 'close',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  return response
}
const login = async body => {
  const response = await request('/api/management/session', { body, cookie: '' })
  assert.equal(response.status, 200)
  const setCookie = response.headers.get('set-cookie')
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Strict/)
  assert.match(setCookie, /Path=\/api\/management/)
  return setCookie.split(';')[0]
}

try {
  await check('登录限速器：来源与全局双维度滑动窗口，可注入时钟', () => {
    let clock = 1_000
    const throttle = createLoginThrottle({ now: () => clock })
    for (let index = 0; index < 4; index++) {
      assert.equal(throttle.check('10.0.0.1').allowed, true, `第 ${index + 1} 次检查应放行`)
      throttle.fail('10.0.0.1')
    }
    assert.deepEqual(throttle.snapshot('10.0.0.1'), { source: 4, global: 4, windowMs: 60_000 })
    assert.equal(throttle.check('10.0.0.1').allowed, true, '第 5 次失败前仍放行')
    throttle.fail('10.0.0.1')
    const blocked = throttle.check('10.0.0.1')
    assert.equal(blocked.allowed, false)
    assert.equal(blocked.scope, 'source')
    assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 60_000)
    assert.equal(throttle.check('10.0.0.2').allowed, true, '其他来源不受影响')
    throttle.reset('10.0.0.1')
    assert.equal(throttle.check('10.0.0.1').allowed, true, '成功登录清零该来源')
    throttle.fail('10.0.0.3')
    clock += 60_000
    assert.equal(throttle.snapshot('10.0.0.3').source, 0, '窗口外失败自动过期')
    const globalThrottle = createLoginThrottle({ now: () => clock, sourceLimit: 100, globalLimit: 3 })
    for (let index = 0; index < 3; index++) globalThrottle.fail(`source-${index}`)
    const globalBlocked = globalThrottle.check('fresh-source')
    assert.equal(globalBlocked.allowed, false, '全局阈值命中后新来源也要拒绝')
    assert.equal(globalBlocked.scope, 'global')
  })
  await check('来源地址归一化覆盖 IPv6 映射与 zone id', () => {
    assert.equal(normalizeSourceAddress('::ffff:127.0.0.1'), '127.0.0.1')
    assert.equal(normalizeSourceAddress('::FFFF:192.168.1.9'), '192.168.1.9')
    assert.equal(normalizeSourceAddress('fe80::1%eth0'), 'fe80::1')
    assert.equal(normalizeSourceAddress('::1'), '::1')
    assert.equal(normalizeSourceAddress(''), 'unknown')
  })
  await check('OFM_PASSWORD 只用 trim 判未设置，比较保留原值', () => {
    assert.deepEqual(panelPasswordState('  secret  '), { password: '  secret  ', required: true, padded: true })
    assert.equal(panelPasswordState('   ').required, false, '纯空白视作未设置（既有语义不变）')
    assert.equal(panelPasswordState('').required, false)
    assert.deepEqual(panelPasswordState(null), { password: '', required: false, padded: false })
  })
  await check('macOS 与 Windows 固定启动器安全引用路径，令牌只经 stdin 复制', verifyLoginLaunchers)
  // /login/terminal 已删除（决策三，2026-11-19）：端点消失本身值得钉住，
  // 防止有人把它加回来 —— 那会是重新引入一个免鉴权的本地动作触发面。
  service = await startStandalone({ dataDir, port: 0, refresh: false, logger: { warn() {} } })
  key = getKey()
  await check('本机取令牌端点已删除（决策三）', async () => {
    const response = await request('/api/management/login/terminal', {
      method: 'POST', cookie: '',
      headers: { origin: 'http://127.0.0.1', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: '{}',
    })
    // 同源防护（403）或路由不存在（404）都算「不再可用」；
    // 唯一不允许的是 200（端点还活着）。
    assert.notEqual(response.status, 200, '免鉴权端点必须不复存在')
    assert.ok(response.status < 500, '不应以 5xx 形式报内部错误')
  })
  await check('页面资源本地提供且不包含密钥，健康接口仍兼容', async () => {
    const page = await request('/', { cookie: '' })
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type'), /text\/html/)
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/)
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer')
    const body = await page.text()
    assert.match(body, /本地控制台/)
    assert.match(page.headers.get('content-security-policy'), /script-src 'self';/)
    const scripts = [...body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    assert.ok(scripts.length > 0)
    assert.ok(scripts.every(([, attributes, content]) => /\bsrc=/.test(attributes) && !content.trim()),
      '管理页脚本必须通过同源外部资源加载，不能依赖被 CSP 禁止的内联脚本')
    const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'unsupported'
    assert.ok(body.includes(`data-login-platform="${platform}"`))
    assert.ok(!body.includes(key))
    const manifest = JSON.parse(fs.readFileSync(new URL('../packages/standalone/web/assets.json', import.meta.url), 'utf8'))
    assert.ok(manifest.includes('app.js') && manifest.includes('app.css'))
    assert.ok(manifest.some(name => /^channels-.+\.js$/.test(name)))
    for (const asset of manifest) {
      const response = await request(`/assets/${asset}`, { cookie: '' })
      assert.equal(response.status, 200, asset)
      assert.match(response.headers.get('content-type'), asset.endsWith('.css') ? /text\/css/ : /javascript/)
      assert.ok(!(await response.text()).includes(key), asset)
      assert.equal((await request(`/assets/${asset}`, { method: 'HEAD' })).status, 200)
      assert.equal((await request(`/assets/${asset}`, { method: 'POST' })).status, 405)
    }
    for (const route of ['/assets/settings.json', '/assets/assets.json', '/assets/unknown.js', '/frontend/app.tsx', '/assets/%2e%2e%2fservice.mjs']) {
      assert.equal((await request(route, { cookie: '', headers: { authorization: `Bearer ${key}` } })).status, 404, route)
    }
    const health = await (await request('/health')).json()
    assert.equal(health.product, 'standalone')
    assert.equal(health.capabilities.webUi, true)
    // 健康响应要暴露真实子组件状态（渠道 ready 是常态，不是致命）。
    assert.equal(health.ok, true)
    assert.equal(health.channels.state, 'ready')
    assert.equal(health.channels.error, '')
  })
  await check('所有管理数据和操作要求登录，OPTIONS 不放行跨域', async () => {
    for (const route of ['summary', 'stats', 'key']) assert.equal((await request(`/api/management/${route}`, { cookie: '' })).status, 401)
    for (const route of ['settings', 'key/rotate', 'models/refresh', 'models/test']) {
      assert.equal((await request(`/api/management/${route}`, { body: {}, cookie: '' })).status, 401)
    }
    const response = await request('/api/management/settings', { cookie: '', method: 'OPTIONS' })
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('access-control-allow-origin'), null)
  })
  await check('一次性链接只兑换一次，错误凭证不消耗有效凭证', async () => {
    const bootstrapToken = new URLSearchParams(new URL(service.managementUrl).hash.slice(1)).get('login')
    assert.ok(bootstrapToken)
    assert.ok(!service.managementUrl.includes(key))
    assert.equal((await request('/api/management/session', { cookie: '', body: { bootstrapToken: 'wrong' } })).status, 401)
    cookie = await login({ bootstrapToken })
    assert.equal((await request('/api/management/session', { cookie: '', body: { bootstrapToken } })).status, 401)
    const secondCookie = await login({ password: PANEL_PASSWORD })
    assert.notEqual(cookie, secondCookie)
  })
  await check('摘要与统计不泄露密钥，管理会话不能调用推理接口', async () => {
    const response = await request('/api/management/summary')
    assert.equal(response.status, 200)
    const summary = await response.json()
    assert.equal(summary.dataDir, dataDir)
    assert.equal(summary.automaticRefresh, false)
    assert.equal(summary.networkMode, 'live')
    assert.ok(!JSON.stringify(summary).includes(key))
    const stats = await (await request('/api/management/stats')).json()
    assert.equal(stats.requests, 0)
    assert.ok(!JSON.stringify(stats).includes(key))
    assert.equal((await request('/v1/models')).status, 401)
    // 管理面凭据 = 面板密码（2026-11-17 起 API Key 不再解锁管理面）。
    assert.equal((await request('/api/management/summary', { cookie: '', headers: { authorization: `Bearer ${PANEL_PASSWORD}` } })).status, 200)
    // 反向：本机 API Key 当 Bearer 必须被管理面拒绝 —— 推理/管理两套凭据彻底分离。
    assert.equal((await request('/api/management/summary', { cookie: '', headers: { authorization: `Bearer ${key}` } })).status, 401)
  })
  await check('同源防护覆盖登录、读取和写入，拒绝伪造 Host 及插件来源', async () => {
    for (const headers of [
      { origin: 'https://evil.example' },
      { origin: 'http://127.0.0.1:1' },
      { referer: 'http://evil.example/' },
      { referer: 'dsh-app://app' },
      { 'sec-fetch-site': 'cross-site' },
      { host: 'evil.example' },
    ]) {
      assert.equal((await request('/api/management/summary', { headers })).status, 403, JSON.stringify(headers))
      assert.equal((await request('/api/management/settings', { headers, body: { enabled: false } })).status, 403)
      assert.equal((await request('/api/management/session', { headers, body: { password: PANEL_PASSWORD } })).status, 403)
    }
    const response = await request('/api/management/settings', { body: {}, headers: { origin: service.url, referer: `${service.url}/` } })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('access-control-allow-origin'), null)
  })
  await check('设置严格校验字段类型范围和请求体，不发生部分保存', async () => {
    for (const body of [
      null, [], { enabled: 'false' }, { enabled: false, unknown: 1 },
      { forwardKey: 'injected' }, { standalonePort: 80 }, { defaultMaxTokens: 0 },
      { defaultMaxTokens: 131073 }, { probeIntervalMinutes: 0 },
      { probeIntervalMinutes: 1441 }, { probeIntervalMinutes: '15' },
      { standaloneProbe: {} }, { enabled: false, probeIntervalMinutes: 0 },
      { hideFreeModels: 'true' }, { hideEacModels: 1 }, { hiddenModelIds: null },
      { hiddenModelIds: [1] }, { hiddenModelIds: [''] }, { hiddenModelIds: [' x'] },
      { hiddenModelIds: ['x\n'] }, { hiddenModelIds: ['x'.repeat(301)] },
      { hiddenModelIds: Array(1001).fill('model') },
      { enabled: false, hiddenModelIds: [false] },
    ]) assert.equal((await request('/api/management/settings', { body })).status, 400)
    assert.equal(getKey(), key)
    assert.equal(service.runtime.state().settings.enabled, true)
    const malformed = await fetch(service.url + '/api/management/settings', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{',
    })
    assert.equal(malformed.status, 400)
    assert.equal((await request('/api/management/settings', { body: {}, headers: { 'content-type': 'text/plain' } })).status, 415)
    assert.equal((await request('/api/management/settings', { body: { huge: 'x'.repeat(17000) } })).status, 413)
  })
  await check('超大请求体排干后仍能收到 413（不因异步迭代器提前退出而重置连接）', async () => {
    // 真实 1MB body：旧实现超限直接 throw，`for await` 提前 return 会销毁
    // socket；客户端可能只看到 ECONNRESET。现在先 drain 再回 413。
    const response = await request('/api/management/session', { cookie: '', body: { padding: 'x'.repeat(1024 * 1024) } })
    assert.equal(response.status, 413)
    assert.equal(response.headers.get('connection'), 'close')
    assert.match(await response.text(), /请求内容过大/)
  })
  await check('设置保存后立即落盘，推理暂停时管理页面可恢复服务', async () => {
    const patch = { enabled: false, exposeRegionModels: false, streamRecovery: false, standaloneProbe: true, defaultMaxTokens: 8192, probeIntervalMinutes: 12 }
    assert.equal((await request('/api/management/settings', { body: patch })).status, 200)
    const saved = JSON.parse(fs.readFileSync(service.keyFile, 'utf8'))
    for (const [name, value] of Object.entries(patch)) assert.equal(saved[name], value)
    assert.equal((await request('/v1/models', { headers: { authorization: `Bearer ${key}` } })).status, 503)
    assert.equal((await request('/')).status, 200)
    assert.equal((await request('/api/management/summary')).status, 200)
    const before = calls
    assert.equal((await request('/api/management/models/test', { body: { model } })).status, 503)
    assert.equal(calls, before)
    assert.equal((await request('/api/management/settings', { body: { enabled: true } })).status, 200)
    assert.equal((await request('/v1/models', { headers: { authorization: `Bearer ${key}` } })).status, 200)
  })
  await check('持久化失败不谎报成功且保留原配置与密钥', async () => {
    const nativeRename = fs.renameSync
    fs.renameSync = (source, target) => {
      if (target === service.keyFile) throw Object.assign(new Error('模拟磁盘不可写'), { code: 'EACCES' })
      return nativeRename(source, target)
    }
    try {
      assert.equal((await request('/api/management/settings', { body: { enabled: false } })).status, 500)
      assert.equal(service.runtime.state().settings.enabled, true)
      assert.equal((await request('/api/management/key/rotate', { body: { confirm: true } })).status, 500)
      assert.equal(service.runtime.state().settings.forwardKey, key)
      assert.equal(getKey(), key)
    } finally { fs.renameSync = nativeRename }
    assert.equal((await request('/api/management/settings', { body: { enabled: true } })).status, 200)
  })
  await check('刷新不默认推理，主动探测和单模型测试执行核心并写入统计', async () => {
    const before = calls
    assert.equal((await request('/api/management/models/refresh', { body: {} })).status, 200)
    assert.equal(calls, before)
    const models = (await (await request('/api/management/summary')).json()).catalog
    assert.deepEqual(models.map(row => row.id), [model, kilo])
    assert.equal((await request('/api/management/models/refresh', { body: { probe: true } })).status, 200)
    assert.equal(calls, before + 1)
    assert.equal((await request('/api/management/models/refresh', { body: { probe: 'yes' } })).status, 400)
    const tested = await request('/api/management/models/test', { body: { model } })
    assert.equal(tested.status, 200)
    const testResult = await tested.json()
    assert.equal(testResult.text, 'OK')
    assert.equal(testResult.persisted, true)
    const measured = (await (await request('/api/management/summary')).json()).catalog.find(row => row.id === model)
    assert.equal(measured.availabilitySource, 'manual')
    assert.equal(measured.availability, 'available')
    assert.equal(measured.ttftMs, testResult.ttftMs)
    assert.equal(measured.latencyMs, testResult.totalMs)
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'availability.json'), 'utf8'))
    assert.equal(saved.manualResults[model].ttftMs, testResult.ttftMs)
    assert.equal(calls, before + 2)
    assert.equal((await request('/api/management/models/test', { body: { model: 'missing' } })).status, 404)
    assert.equal(calls, before + 2)
    const stats = await (await request('/api/management/stats')).json()
    assert.equal(stats.requests, 1)
    assert.equal(stats.turns, 1)
    assert.equal(stats.grand.input, 11)
    assert.equal(stats.grand.output, 7)
  })
  await check('取消单模型测试会关闭真实上游请求且管理会话仍可使用', async () => {
    const started = new Promise(resolve => { notifyCall = resolve })
    const closed = new Promise(resolve => { notifyClosed = resolve })
    const controller = new AbortController()
    const before = calls
    holdNextCall = true
    const pending = fetch(`${service.url}/api/management/models/test`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ model }), signal: controller.signal,
    })
    const cancelled = pending.then(() => null, error => error)
    const deadline = AbortSignal.timeout(5000)
    const wait = promise => Promise.race([promise, new Promise((_, reject) => {
      deadline.addEventListener('abort', () => reject(new Error('取消测试未在五秒内关闭上游')), { once: true })
    })])
    try {
      await wait(started)
      controller.abort()
      assert.equal((await cancelled)?.name, 'AbortError')
      await wait(closed)
      assert.equal(calls, before + 1)
      assert.equal((await request('/api/management/summary')).status, 200)
    } finally { controller.abort(); holdNextCall = false }
  })
  await check('模型隐藏只过滤公开清单，保留管理入口和历史调用并持久化', async () => {
    const listing = async () => (await (await request('/v1/models', { headers: { authorization: `Bearer ${key}` } })).json()).data
    assert.equal((await request('/api/management/settings', { body: { hiddenModelIds: [model, model] } })).status, 200)
    assert.deepEqual((await listing()).map(row => row.id), [kilo])
    const summary = await (await request('/api/management/summary')).json()
    assert.deepEqual(summary.settings.hiddenModelIds, [model])
    assert.equal(summary.catalog.find(row => row.id === model).hiddenByUser, true)
    assert.equal(summary.catalog.find(row => row.id === model).routable, false)
    assert.equal(JSON.stringify(summary).includes(key), false)
    assert.equal((await request('/api/management/models/test', { body: { model } })).status, 200,
      'hidden history ids remain callable')
    assert.equal((await request('/api/management/settings', { body: { hiddenModelIds: [], hideFreeModels: true } })).status, 200)
    assert.deepEqual(await listing(), [])
    assert.equal((await (await request('/api/management/summary')).json()).catalog.length, 2)
    const hiddenSettings = { hiddenModelIds: [model], hideFreeModels: false }
    assert.equal((await request('/api/management/settings', { body: hiddenSettings })).status, 200)
    const stored = JSON.parse(fs.readFileSync(service.keyFile, 'utf8'))
    for (const [name, value] of Object.entries(hiddenSettings)) assert.deepEqual(stored[name], value)
  })
  await check('轮换要求确认，旧密钥与其他会话失效，当前管理会话保留', async () => {
    const other = await login({ password: PANEL_PASSWORD })
    assert.equal((await request('/api/management/key/rotate', { body: {} })).status, 400)
    const rotated = await request('/api/management/key/rotate', { body: { confirm: true } })
    assert.equal(rotated.status, 200)
    const nextKey = (await rotated.json()).key
    assert.notEqual(nextKey, key)
    assert.equal(getKey(), nextKey)
    assert.equal((await request('/api/management/summary', { cookie: other })).status, 401)
    assert.equal((await request('/api/management/summary')).status, 200)
    assert.equal((await request('/v1/models', { headers: { authorization: `Bearer ${key}` } })).status, 401)
    assert.equal((await request('/v1/models', { headers: { authorization: `Bearer ${nextKey}` } })).status, 200)
    assert.equal((await request('/api/management/session', { cookie: '', body: { password: 'wrong-password' } })).status, 401)
    key = nextKey
  })
  await check('会话到期和登出后不能读管理数据', async () => {
    const nativeNow = Date.now
    const started = nativeNow()
    try {
      Date.now = () => started + 8 * 60 * 60_000 + 1000
      assert.equal((await request('/api/management/summary')).status, 401)
    } finally { Date.now = nativeNow }
    cookie = await login({ password: PANEL_PASSWORD })
    const response = await request('/api/management/logout', { body: {} })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('set-cookie'), /Max-Age=0/)
    assert.equal((await request('/api/management/summary')).status, 401)
    cookie = await login({ password: PANEL_PASSWORD })
  })
  await check('HTTPS 反代登录加 Secure，明文 HTTP 保持可用并如实返回 transportInsecure', async () => {
    // 明文（本机 / --lan-panel）不能加 Secure，否则浏览器不回传 Cookie 就登不上。
    const plain = await request('/api/management/session', { cookie: '', body: { password: PANEL_PASSWORD } })
    assert.equal(plain.status, 200)
    assert.equal((await plain.json()).transportInsecure, true)
    assert.equal(/; Secure/i.test(plain.headers.get('set-cookie') ?? ''), false)
    // 经 HTTPS 反代（x-forwarded-proto: https）才加 Secure。
    const secure = await request('/api/management/session', {
      cookie: '', body: { password: PANEL_PASSWORD }, headers: { 'x-forwarded-proto': 'https' },
    })
    assert.equal(secure.status, 200)
    assert.equal((await secure.json()).transportInsecure, false)
    assert.match(secure.headers.get('set-cookie'), /; Secure/i)
    // 清除 Cookie 的属性必须与设置处一致（HTTPS 下也要 Secure）。
    const secureCookie = secure.headers.get('set-cookie').split(';')[0]
    const cleared = await request('/api/management/logout', {
      cookie: secureCookie, body: {}, headers: { 'x-forwarded-proto': 'https' },
    })
    assert.equal(cleared.status, 200)
    assert.match(cleared.headers.get('set-cookie'), /Max-Age=0/)
    assert.match(cleared.headers.get('set-cookie'), /; Secure/i)
  })
  await check('重启保留设置与密钥但清除会话，新的登录链接独立生成', async () => {
    const oldUrl = service.managementUrl
    const previousPort = service.port
    await service.close()
    service = await startStandalone({ dataDir, refresh: false, logger: { warn() {} } })
    assert.equal(service.port, previousPort)
    assert.equal(getKey(), key)
    assert.notEqual(service.managementUrl, oldUrl)
    assert.equal(service.runtime.state().settings.defaultMaxTokens, 8192)
    assert.equal(service.runtime.state().settings.standaloneProbe, true)
    assert.deepEqual(service.runtime.state().settings.hiddenModelIds, [model])
    assert.equal(service.runtime.state().settings.hideFreeModels, false)
    assert.equal((await request('/api/management/summary')).status, 401)
    const token = new URLSearchParams(new URL(service.managementUrl).hash.slice(1)).get('login')
    const nativeNow = Date.now
    const started = nativeNow()
    try {
      Date.now = () => started + 10 * 60_000 + 1000
      assert.equal((await request('/api/management/session', { cookie: '', body: { bootstrapToken: token } })).status, 401)
    } finally { Date.now = nativeNow }
    cookie = await login({ password: PANEL_PASSWORD })
    const visible = await (await request('/v1/models', { headers: { authorization: `Bearer ${key}` } })).json()
    assert.equal(visible.data.some(row => row.id === model), false)
    assert.equal((await request('/api/management/settings', { body: { hiddenModelIds: [] } })).status, 200)
    assert.equal((await (await request('/v1/models', { headers: { authorization: `Bearer ${key}` } })).json()).data.some(row => row.id === model), true)
  })
  await check('设置变更重新安排周期任务且 --no-refresh 保持无自动请求', async () => {
    const nativeTimeout = globalThis.setTimeout
    let scheduled
    globalThis.setTimeout = (callback, delay, ...args) => {
      const handle = nativeTimeout(callback, delay, ...args)
      if ([12, 5].some(minutes => minutes * 60_000 === delay)) scheduled = { handle, delay }
      return handle
    }
    try {
      const before = calls
      assert.equal((await request('/api/management/settings', { body: { probeIntervalMinutes: 5 } })).status, 200)
      assert.equal(scheduled, undefined)
      assert.equal(calls, before)
      await service.close()
      service = await startStandalone({ dataDir, refresh: true, logger: { warn() {} } })
      await service.ready
      cookie = await login({ password: PANEL_PASSWORD })
      assert.equal(scheduled.delay, 5 * 60_000)
      const oldHandle = scheduled.handle
      assert.equal((await request('/api/management/settings', { body: { probeIntervalMinutes: 12, standaloneProbe: false } })).status, 200)
      assert.equal(scheduled.delay, 12 * 60_000)
      assert.equal(oldHandle._destroyed, true)
    } finally {
      globalThis.setTimeout = nativeTimeout
    }
  })
  /**
   * 以下两个用例各自**新建实例**：限速器是每实例内存态，公开测试里不该
   * 靠放宽生产阈值来通过；新实例也避免把 429 状态带到主实例的后续登录。
   */
  await check('连续密码错误触发 429（Retry-After + 限速日志不含密码）', async () => {
    const warnings = []
    const limited = await startStandalone({
      dataDir: path.join(scratch, 'rate-limit'), port: 0, refresh: false,
      logger: { warn: message => warnings.push(String(message)) },
    })
    try {
      const attempt = password => fetch(limited.url + '/api/management/session', {
        method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify({ password }), signal: AbortSignal.timeout(10000),
      })
      for (let index = 0; index < 5; index++) {
        assert.equal((await attempt('definitely-wrong-password')).status, 401, `第 ${index + 1} 次错误密码应是 401`)
      }
      const blocked = await attempt('definitely-wrong-password')
      assert.equal(blocked.status, 429)
      assert.match(await blocked.text(), /稍后重试/)
      assert.ok(Number(blocked.headers.get('retry-after')) >= 1, '429 应带 Retry-After')
      // 锁定期内**正确密码**也不能绕过（否则限速形同虚设）。
      assert.equal((await attempt(PANEL_PASSWORD)).status, 429)
      assert.ok(warnings.some(message => message.includes('登录限速')), '命中限速必须打 warn')
      assert.equal(warnings.some(message => message.includes('definitely-wrong-password')), false, '日志绝不能包含密码')
    } finally { await limited.close() }
  })
  await check('OFM_PASSWORD 含首尾空格时按原值登录并打出口径提示', async () => {
    const previous = process.env.OFM_PASSWORD
    const padded = '  padded-panel-password  '
    const warnings = []
    process.env.OFM_PASSWORD = padded
    let paddedService
    try {
      paddedService = await startStandalone({
        dataDir: path.join(scratch, 'padded-password'), port: 0, refresh: false,
        logger: { warn: message => warnings.push(String(message)) },
      })
      const attempt = password => fetch(paddedService.url + '/api/management/session', {
        method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify({ password }), signal: AbortSignal.timeout(10000),
      })
      assert.equal((await attempt(padded)).status, 200, '原值（含首尾空格）必须能登录')
      // trim 后的值不是密码本身 —— 与「未设置」判定无关，必须 401。
      assert.equal((await attempt(padded.trim())).status, 401)
      assert.ok(warnings.some(message => message.includes('首尾空格')), '启动时提示已按原值比较')
      assert.equal(warnings.some(message => message.includes('padded-panel-password')), false)
    } finally {
      await paddedService?.close()
      if (previous === undefined) delete process.env.OFM_PASSWORD
      else process.env.OFM_PASSWORD = previous
    }
  })
} finally {
  await service?.close()
  upstream.closeAllConnections()
  await new Promise(resolve => upstream.close(resolve))
  const cleanupTarget = fs.realpathSync(scratch)
  assert.ok(cleanupTarget.startsWith(fs.realpathSync(os.tmpdir()) + path.sep))
  fs.rmSync(cleanupTarget, { recursive: true, force: true })
}
console.log(`\nstandalone-management: ${checks - failures}/${checks} checks passed`)
process.exitCode = failures ? 1 : 0
