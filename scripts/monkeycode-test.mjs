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

  // ── Cookie 归一 ──
  assert.equal(normalizeCookie(`nebula_session=abc; _ga=x`), 'nebula_session=abc; _ga=x')
  assert.equal(normalizeCookie(`  nebula_session=abc\r\n  `), 'nebula_session=abc', '换行被清理')
  assert.equal(normalizeCookie('foo=bar'), undefined, '缺会话字段拒绝')
  assert.equal(normalizeCookie(''), undefined)
  assert.equal(isCredentialUsable({ access_token: 'nebula_session=x' }), true)
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
    const cred = await loginWithCookie(realFetch, product, 'nebula_session=good')
    assert.equal(cred.account_id, 'u-1')
    assert.equal(cred.nickname, 'alice')
    // 无效 Cookie 抛错
    await assert.rejects(() => loginWithCookie(realFetch, product, 'foo=bar'), /nebula_session/)
    mode = 'expired'
    await assert.rejects(() => loginWithCookie(realFetch, product, 'nebula_session=bad'), /无效或已过期/)
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

    // 对话必须明确拒绝（不能返回空流）
    await assert.rejects(
      () => collect(adapter.stream({ model: 'm1', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })),
      (e) => e.code === 'UNSUPPORTED_CONTENT' && /暂未支持/.test(e.message),
    )

    // 重试策略：只读渠道不重试
    const policy = adapter.providerRetryPolicy()
    assert.equal(policy.maxRetries, 0)
    assert.equal(policy.retryableCodes.length, 0)
    assert.equal(typeof policy.initialDelayMs, 'number', '扁平字段')

    console.log('ok  monkeycode: Cookie 归一/信封剥离/解析/登录/钱包/模型/签到/探活三态，对话明确拒绝且重试策略为空')
  } finally {
    upstream.closeAllConnections?.()
    await new Promise(r => upstream.close(r))
  }
}

export async function verifyMonkeyCode() { await main() }
