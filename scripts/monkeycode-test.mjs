/** MonkeyCode：Cookie 归一、上游解析、只读能力、对话明确拒绝。 */
import assert from 'node:assert/strict'
import http from 'node:http'

const collect = async (it) => { const out = []; for await (const c of it) out.push(c); return out }

async function main() {
  const {
    normalizeCookie, isCredentialUsable, parseUser, parseWallet, parseCheckin,
    credentialFromUser, unwrapData, monkeyCodeHeaders,
  } = await import('../vendor/channel-pack/src/monkeycode.ts')
  const { MONKEYCODE, MONKEYCODE_SESSION_COOKIE } = await import('../vendor/channel-pack/src/monkeycode-product.ts')
  const { loginWithCookie, fetchWallet, fetchModels, runCheckin, probeCredential } = await import('../vendor/channel-pack/src/monkeycode-auth.ts')
  const { MonkeyCodeAdapter } = await import('../vendor/channel-pack/src/monkeycode-adapter.ts')
  const { fetch: realFetch } = await import('undici')

  // ── Cookie 归一（形状校验加固：长度/字符集/噪声清洗）──
  assert.equal(normalizeCookie(`nebula_session=0123456789abcdef0123456789abcdef; _ga=x`), `nebula_session=0123456789abcdef0123456789abcdef; _ga=x`)
  assert.equal(normalizeCookie(`  nebula_session=0123456789abcdef0123456789abcdef\r\n  `), `nebula_session=0123456789abcdef0123456789abcdef`, '换行被清理')
  assert.equal(normalizeCookie('foo=bar'), undefined, '缺会话字段拒绝')
  assert.equal(normalizeCookie(''), undefined)
  assert.equal(normalizeCookie(`nebula_session=abc; _ga=x`), undefined, '会话值过短拒绝')
  assert.equal(normalizeCookie(`xnebula_session=0123456789abcdef0123456789abcdef`), undefined, '值内嵌会话字段名不算数')
  assert.equal(normalizeCookie(`Cookie: nebula_session=0123456789abcdef0123456789abcdef`), `nebula_session=0123456789abcdef0123456789abcdef`, '剥 Cookie: 头名')
  assert.equal(normalizeCookie(`Bearer nebula_session=0123456789abcdef0123456789abcdef`), `nebula_session=0123456789abcdef0123456789abcdef`, '剥 Bearer 前缀')
  assert.equal(normalizeCookie(`"nebula_session=0123456789abcdef0123456789abcdef"`), `nebula_session=0123456789abcdef0123456789abcdef`, '剥成对引号')
  assert.equal(
    normalizeCookie(`nebula_session=0123456789abcdef0123456789abcdef; Path=/; HttpOnly; Secure`),
    `nebula_session=0123456789abcdef0123456789abcdef`,
    '剥尾部 Set-Cookie 属性段',
  )
  assert.equal(normalizeCookie(`nebula_session=0123456789abcdef0123456789abcdef; _ga=x; Path=/`), `nebula_session=0123456789abcdef0123456789abcdef; _ga=x`, '属性段只剥尾部')
  assert.equal(normalizeCookie(`nebula_session=0123456789abcdef0123456789abcdef; 中文=x`), undefined, '非可打印 ASCII 拒绝')
  assert.equal(normalizeCookie(`nebula_session=0123456789abcdef0123456789abcdef; x=${'y'.repeat(9000)}`), undefined, '整串超长拒绝')
  assert.equal(isCredentialUsable({ access_token: `nebula_session=0123456789abcdef0123456789abcdef` }), true)
  assert.equal(isCredentialUsable({ access_token: 'other=x' }), false)

  // ── 信封剥离 ──
  assert.deepEqual(unwrapData({ code: 0, data: { id: 'u' } }), { id: 'u' })
  assert.deepEqual(unwrapData({ id: 'u' }), { id: 'u' }, '裸对象原样返回')

  // ── 解析 ──
  assert.equal(parseUser({ id: 'u1', name: 'alice', plan: 'pro' }).id, 'u1')
  assert.equal(parseUser({ name: 'no-id' }), undefined, '缺 id 视为无效')
  assert.equal(parseUser({ data: { id: 'u2' } }).id, 'u2', '支持信封')
  assert.deepEqual(parseWallet({ balance: 100, daily_token_balance: 500, daily_token_limit: 1000 }), {
    balance: 100, daily_token_balance: 500, daily_token_limit: 1000,
  })
  assert.equal(parseWallet({ foo: 1 }), undefined, '字段未识别返回 undefined')
  assert.equal(parseCheckin({ checked_in: true, streak_days: 3 }).checkedIn, true)
  assert.equal(parseCheckin({}).checkedIn, false)

  // ── 请求头带 Cookie ──
  const h = monkeyCodeHeaders(MONKEYCODE, { access_token: 'nebula_session=abc' })
  assert.equal(h.Cookie, 'nebula_session=abc')
  assert.ok(h.Referer.startsWith(MONKEYCODE.apiBase))

  // ── 假上游 ──
  let mode = 'ok'
  const upstream = http.createServer((req, res) => {
    const json = (s, b) => res.writeHead(s, { 'Content-Type': 'application/json', Connection: 'close' }).end(JSON.stringify(b))
    const cookie = req.headers.cookie ?? ''
    if (!cookie.includes('nebula_session=')) return json(401, { error: 'no session' })
    if (mode === 'expired') return json(401, { error: 'expired' })
    if (req.url === '/api/v1/users/me') return json(200, { id: 'u-1', name: 'alice', plan: 'free' })
    if (req.url === '/api/v1/users/wallet') return json(200, { balance: 100, daily_token_balance: 9_000_000, daily_token_limit: 10_000_000 })
    if (req.url === '/api/v1/users/models/available') {
      return json(200, [
        { id: 'm1', name: 'Kimi K2.5', context_length: 256000 },
        { id: 'm2', name: 'Hidden One', is_hidden: true },
        { name: 'no-id' },
      ])
    }
    if (req.url === '/api/v1/users/wallet/checkin') {
      return req.method === 'POST' ? json(200, { checked_in: true, reward: 100 }) : json(200, { checked_in: false })
    }
    json(404, {})
  })
  await new Promise(r => upstream.listen(0, '127.0.0.1', r))
  const product = { ...MONKEYCODE, apiBase: `http://127.0.0.1:${upstream.address().port}` }

  try {
    // ── 登录 ──
    const cred = await loginWithCookie(realFetch, product, 'nebula_session=good-token-0123456789abcdef')
    assert.equal(cred.account_id, 'u-1')
    assert.equal(cred.nickname, 'alice')
    // 无效 Cookie 抛错
    await assert.rejects(() => loginWithCookie(realFetch, product, 'foo=bar'), /nebula_session/)
    mode = 'expired'
    await assert.rejects(() => loginWithCookie(realFetch, product, 'nebula_session=bad-token-0123456789abcdef'), /无效或已过期/)
    mode = 'ok'

    // ── 钱包 / 模型 / 签到 ──
    assert.equal((await fetchWallet(realFetch, product, cred)).balance, 100)
    const models = await fetchModels(realFetch, product, cred)
    // 上游 3 条：缺 id 的那条被跳过，剩 2 条（含 1 条隐藏）。
    assert.equal(models.length, 2, '缺 id 的条目被跳过')
    assert.equal(models[1].isHidden, true, '隐藏模型保留在 fetchModels 结果里（由适配器过滤）')
    const checkin = await runCheckin(realFetch, product, cred)
    assert.equal(checkin.ok, true)
    assert.equal(checkin.status.reward, 100)

    // ── 探活三态 ──
    assert.equal(await probeCredential(realFetch, product, cred), 'valid')
    mode = 'expired'
    assert.equal(await probeCredential(realFetch, product, cred), 'expired')
    mode = 'ok'
    assert.equal(await probeCredential(realFetch, { ...product, apiBase: 'http://127.0.0.1:1' }, cred), 'network_error')

    // ── 适配器 ──
    const adapter = new MonkeyCodeAdapter({
      product, fetchImpl: realFetch,
      resolveCredential: async () => cred,
    })
    assert.equal(adapter.providerInfo('monkeycode').id, 'monkeycode')
    const listed = await adapter.listModels('monkeycode')
    // 上游 2 条有效（m1 + 隐藏的 m2），过滤后只剩 m1。
    assert.equal(listed.length, 1, '隐藏模型被过滤')
    assert.equal(listed[0].id, 'm1')
    assert.deepEqual(listed[0].inputModalities, ['text'])

    // 对话已实现（走 WebSocket）：本假上游没有 /users/tasks 端点，
    // 因此这里证明的是「适配器确实发出了建任务请求」而不是干脆拒绝。
    // 完整的对话链路（建任务 → WS → 逐帧产出）由 monkeycode-ws-test.mjs 覆盖。
    await assert.rejects(
      () => collect(adapter.stream({ model: 'm1', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })),
      (e) => e.code !== 'UNSUPPORTED_CONTENT' && /建任务/.test(e.message),
      '对话不再抛「暂未支持」，而是真的去建任务',
    )

    // 重试策略：对话可用后，传输类错误值得重试。
    const policy = adapter.providerRetryPolicy()
    assert.equal(policy.maxRetries, 2)
    assert.ok(policy.retryableCodes.includes('TRANSPORT'))
    assert.equal(policy.retryableCodes.includes('AUTH'), false, 'AUTH 不该重试')
    assert.equal(typeof policy.initialDelayMs, 'number', '扁平字段')
    assert.equal('backoff' in policy, false, '不能嵌套 backoff')

    console.log('ok  monkeycode: Cookie 归一/信封剥离/解析/登录/钱包/模型/签到/探活三态，对话真发建任务请求且传输类错误可重试')
  } finally {
    upstream.closeAllConnections?.()
    await new Promise(r => upstream.close(r))
  }
}

export async function verifyMonkeyCode() { await main() }

// 单独运行时必须失败（不能静默 exit 0）：见 scripts/lib/direct-run.mjs。
import { exitIfDirectRun } from './lib/direct-run.mjs'
exitIfDirectRun(import.meta.url, 'monkeycode-test')
