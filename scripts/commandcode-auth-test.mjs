/** Command Code 登录流程端到端：本地回调服务器 + 假上游，不出网。 */
import assert from 'node:assert/strict'
import http from 'node:http'

async function main() {
  const {
    startCommandCodeLogin, validateApiKey, resolveCredential,
    fetchCredits, fetchModelCatalog, COMMANDCODE_CALLBACK_PATH,
  } = await import('../vendor/channel-pack/src/commandcode-auth.ts')
  const { COMMANDCODE } = await import('../vendor/channel-pack/src/commandcode-product.ts')
  // ⚠️ channel-pack-test 把 globalThis.fetch 换成了禁止出网的 offlineFetch。
  // 本测试要打**本地假上游**（127.0.0.1），不涉及外网，因此取 undici 的
  // fetch 实现作为「真实 fetch」注入，而不是用被替换过的全局变量。
  const { fetch: realFetch } = await import('undici')

  // ── 假上游：whoami / credits / models ──
  const upstream = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? ''
    const key = auth.replace(/^Bearer /, '')
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
    }
    if (req.url === '/alpha/whoami') {
      if (key === 'good-key') return json(200, { userId: 'u-1', userName: 'alice', keyName: 'cli', plan: 'pro' })
      if (key === 'server-err') return json(500, { error: 'boom' })
      return json(401, { error: 'invalid' })
    }
    if (req.url === '/alpha/billing/credits') return json(200, { balance: 500, limit: 1000 })
    if (req.url === '/provider/v1/models') {
      return json(200, {
        object: 'list',
        data: [
          { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', context_length: 200000, max_output_tokens: 64000, supported_endpoints: ['chat', 'image'] },
          { id: 'gpt-5', name: 'GPT-5', context_length: 400000 },
          { id: 'bad-row' }, // 缺 name / context_length，应被跳过
        ],
      })
    }
    json(404, { error: 'not found' })
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`
  const product = { ...COMMANDCODE, apiBase: upstreamBase }

  try {
    // ── validateApiKey 三态 ──
    const goodProbe = await validateApiKey(realFetch, product, 'good-key')
    if (!goodProbe.ok) console.error('DEBUG good-key 失败:', JSON.stringify(goodProbe))
    assert.equal(goodProbe.ok, true)
    const invalid = await validateApiKey(realFetch, product, 'bad-key')
    assert.equal(invalid.ok, false)
    assert.equal(invalid.reason, 'invalid_key')
    const serverErr = await validateApiKey(realFetch, product, 'server-err')
    assert.equal(serverErr.ok, false)
    assert.equal(serverErr.reason, 'server_error')
    // 网络失败（端口关闭）：取一个刚释放的端口，避免硬编码 1 在某些系统上
    // 立即 RST 而触发未捕获的 socket 错误。
    const deadPort = await new Promise(resolve => {
      const probe = http.createServer()
      probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)) })
    })
    const netErr = await validateApiKey(realFetch, { ...product, apiBase: `http://127.0.0.1:${deadPort}` }, 'good-key')
    assert.equal(netErr.ok, false)
    assert.equal(netErr.reason, 'network_error')

    // ── resolveCredential 带账号信息 ──
    const cred = await resolveCredential(realFetch, product, 'good-key')
    assert.equal(cred.access_token, 'good-key')
    assert.equal(cred.account_id, 'u-1')
    assert.equal(cred.nickname, 'alice')
    assert.equal(cred.key_name, 'cli')
    // 401 要抛错（而不是返回半残凭据）。
    await assert.rejects(() => resolveCredential(realFetch, product, 'bad-key'), /401/)

    // ── credits ──
    assert.equal((await fetchCredits(realFetch, product, cred)).balance, 500)
    // 上游不可达 = undefined（不是 0）。
    assert.equal(await fetchCredits(realFetch, { ...product, apiBase: `http://127.0.0.1:${deadPort}` }, cred), undefined)

    // ── models ──
    const models = await fetchModelCatalog(realFetch, product, cred)
    assert.equal(models.length, 2, '缺字段的条目被跳过')
    assert.equal(models[0].id, 'claude-sonnet-4-5')
    assert.equal(models[0].supportsImage, true)
    assert.equal(models[1].maxTokens, undefined, '缺 max_output_tokens 时不下发')

    // ── 登录流程端到端 ──
    const started = await startCommandCodeLogin({ product, fetcher: realFetch, timeoutMs: 5000 })
    try {
      // 从登录 URL 里取出 state，模拟 Studio 回调。
      const url = new URL(started.loginUrl)
      const state = url.searchParams.get('state')
      assert.ok(state, '授权 URL 必须带 state')
      // 授权 URL 对齐官方 CLI：新路径 + 127.0.0.1 回调 + mode=redirect。
      assert.equal(url.pathname, '/studio/auth/cli', '旧 /cli/authorize 已 404，必须用新路径')
      assert.equal(url.searchParams.get('mode'), 'redirect')
      const cbParam = url.searchParams.get('callback')
      if (cbParam !== `http://127.0.0.1:${started.port}/callback`) console.error('DEBUG callback:', JSON.stringify(cbParam), 'port:', started.port)
      assert.equal(cbParam, `http://127.0.0.1:${started.port}/callback`)

      // 错误 state 必须被拒绝（400），且不影响后续正确回调。
      const badState = await new Promise((resolve, reject) => {
        const req = http.request(`http://127.0.0.1:${started.port}${COMMANDCODE_CALLBACK_PATH}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' },
        }, res => { res.resume(); resolve(res.statusCode) })
        req.on('error', reject)
        req.end(JSON.stringify({ apiKey: 'good-key', state: 'forged', userId: 'u-1' }))
      })
      assert.equal(badState, 400, '伪造 state 被拒绝')

      // 正确回调。
      const okStatus = await new Promise((resolve, reject) => {
        const req = http.request(`http://127.0.0.1:${started.port}${COMMANDCODE_CALLBACK_PATH}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' },
        }, res => { res.resume(); resolve(res.statusCode) })
        req.on('error', reject)
        req.end(JSON.stringify({ apiKey: 'good-key', state, userId: 'u-1', userName: 'alice', keyName: 'cli' }))
      })
      assert.equal(okStatus, 200, '正确回调返回 200')

      const { credential, port } = await started.result
      assert.equal(credential.access_token, 'good-key')
      assert.equal(credential.account_id, 'u-1')
      assert.equal(port, started.port)
    } finally {
      await started.close()
    }

    // ── 无效 Key 的回调必须让登录失败 ──
    const bad = await startCommandCodeLogin({ product, fetcher: realFetch, timeoutMs: 5000 })
    try {
      const state = new URL(bad.loginUrl).searchParams.get('state')
      await new Promise((resolve, reject) => {
        const req = http.request(`http://127.0.0.1:${bad.port}${COMMANDCODE_CALLBACK_PATH}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' },
        }, res => { res.resume(); resolve(res.statusCode) })
        req.on('error', reject)
        req.end(JSON.stringify({ apiKey: 'bad-key', state, userId: 'u-1' }))
      })
      await assert.rejects(() => bad.result, /401|无效/)
    } finally {
      await bad.close()
    }

    // ── 官方 Studio 当前主形状：application/x-www-form-urlencoded 回调 ──
    const formLogin = await startCommandCodeLogin({ product, fetcher: realFetch, timeoutMs: 5000 })
    try {
      const state = new URL(formLogin.loginUrl).searchParams.get('state')
      const formStatus = await new Promise((resolve, reject) => {
        const body = new URLSearchParams({
          apiKey: 'good-key', state, userId: 'u-1', userName: 'alice', keyName: 'cli',
        }).toString()
        const req = http.request(`http://127.0.0.1:${formLogin.port}${COMMANDCODE_CALLBACK_PATH}`, {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Connection: 'close' },
        }, res => { res.resume(); resolve(res.statusCode) })
        req.on('error', reject)
        req.end(body)
      })
      assert.equal(formStatus, 200, 'form-urlencoded 回调返回 200')
      const { credential } = await formLogin.result
      assert.equal(credential.access_token, 'good-key')
      assert.equal(credential.account_id, 'u-1')
      assert.equal(credential.nickname, 'alice')
    } finally {
      await formLogin.close()
    }

    // ── 超时 ──
    const timed = await startCommandCodeLogin({ product, fetcher: realFetch, timeoutMs: 300 })
    await assert.rejects(() => timed.result, /超时/)
    await timed.close()

    console.log('ok  commandcode-auth: whoami 三态、credits/models 拉取、回调 state 校验、无效 Key 拒绝、超时、完整登录闭环')
  } finally {
    // keep-alive 连接会让 close() 一直等，先强制断开。
    upstream.closeAllConnections?.()
    await new Promise(resolve => upstream.close(resolve))
  }
}

export async function verifyCommandCodeAuth() {
  await main()
}
