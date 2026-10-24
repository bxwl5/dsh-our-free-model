/** Accio：PKCE、Gemini 信封、ADK 帧、token 不走 Authorization、两地区。 */
import assert from 'node:assert/strict'
import http from 'node:http'

const collect = async (it) => { const out = []; for await (const c of it) out.push(c); return out }

async function main() {
  const {
    isCredentialUsable, isCredentialExpired, accioHeaders, parseTokenResponse,
    buildGenerateBody, parseAdkFrame, createPkcePair, buildAccioAuthUrl,
  } = await import('../vendor/channel-pack/src/accio.ts')
  const { ACCIO, ACCIO_CN, ACCIO_REGION_HEADER } = await import('../vendor/channel-pack/src/accio-product.ts')
  const { streamChat, fetchModels, fetchQuota, exchangeCode, startAccioLogin, ACCIO_CALLBACK_PATH } = await import('../vendor/channel-pack/src/accio-auth.ts')
  const { AccioAdapter } = await import('../vendor/channel-pack/src/accio-adapter.ts')
  const { fetch: realFetch } = await import('undici')

  // ── 凭据 ──
  assert.equal(isCredentialUsable({ access_token: 'tok' }), true)
  assert.equal(isCredentialUsable({ access_token: '' }), false)
  assert.equal(isCredentialUsable({ access_token: ' tok ' }), false)
  assert.equal(isCredentialExpired({ access_token: 't', expire_time: Date.now() - 1000 }), true)
  assert.equal(isCredentialExpired({ access_token: 't', expire_time: Date.now() + 3_600_000 }), false)
  assert.equal(isCredentialExpired({ access_token: 't' }), false, '无过期时间视为不过期')

  // ── 请求头：关键是不带 Authorization ──
  const h = accioHeaders(ACCIO)
  assert.equal(h.Authorization, undefined, 'Accio 的 token 不走 Authorization 头')
  assert.equal(h[ACCIO_REGION_HEADER], 'GLOBAL')
  assert.equal(accioHeaders(ACCIO_CN)[ACCIO_REGION_HEADER], 'CN', '国内版地区头不同')

  // ── token 解析 ──
  assert.equal(parseTokenResponse({ accessToken: 'a', refreshToken: 'r' }).access_token, 'a')
  assert.equal(parseTokenResponse({ data: { accessToken: 'b' } }).access_token, 'b', '支持信封')
  assert.equal(parseTokenResponse({ accessToken: 'c', expiresAt: 1_700_000_000 }).expire_time, 1_700_000_000_000, '秒级抬到毫秒')
  assert.equal(parseTokenResponse({}), undefined)

  // ── Gemini 信封 ──
  const body = buildGenerateBody({
    token: 'tok',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '问' }] },
      { role: 'assistant', content: [{ type: 'text', text: '答' }] },
    ],
    system: 'sys',
  })
  assert.equal(body.token, 'tok', 'token 在 body 里')
  assert.equal(body.contents.length, 3, 'system + user + model')
  assert.equal(body.contents[0].parts[0].text, 'sys')
  assert.equal(body.contents[2].role, 'model', 'assistant 映射成 model')
  // tools
  const withTools = buildGenerateBody({
    token: 't', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    tools: [{ name: 'read', description: 'd', parameters: { type: 'object' } }],
  })
  assert.equal(withTools.tools[0].functionDeclarations[0].name, 'read')

  // ── ADK 帧 ──
  assert.deepEqual(parseAdkFrame({ content: { parts: [{ text: '你好' }] } }), { kind: 'delta', text: '你好' })
  assert.deepEqual(parseAdkFrame({ content: { parts: [{ thought: true, text: '想' }] } }), { kind: 'delta', reasoning: '想' })
  assert.deepEqual(parseAdkFrame({ turn_complete: true, finish_reason: 'STOP' }), { kind: 'done', finishReason: 'STOP' })
  const errFrame = parseAdkFrame({ error_code: 403, error_message: '额度不足' })
  assert.equal(errFrame.kind, 'error')
  assert.equal(errFrame.message, '额度不足')
  // 200 里的业务错误（不是 HTTP 状态码）
  assert.equal(parseAdkFrame({ error_code: 0 }), undefined, 'error_code=0 不是错误')
  assert.equal(parseAdkFrame({}), undefined)

  // ── PKCE ──
  const pkce = await createPkcePair()
  assert.ok(pkce.verifier.length > 20)
  assert.ok(pkce.challenge.length > 20)
  assert.notEqual(pkce.verifier, pkce.challenge)
  // challenge 是 verifier 的 SHA-256 base64url
  const { createHash } = await import('node:crypto')
  assert.equal(pkce.challenge, createHash('sha256').update(pkce.verifier).digest('base64url'))

  // ── 授权 URL ──
  const authUrl = buildAccioAuthUrl(ACCIO, 'http://localhost:5960/callback', 'st', pkce.challenge)
  // ⚠️ 授权入口是**登录页**，不是 `/oauth/authorize`：后者会被前端路由兜底成官网首页，
  // 用户看到的就是「点了没反应、一直空白页」。
  assert.ok(authUrl.startsWith('https://www.accio.com/login?'), '授权入口必须是 /login')
  assert.ok(!authUrl.includes('/oauth/authorize'), '不得再用不存在的 /oauth/authorize')
  const authParams = new URL(authUrl).searchParams
  assert.equal(authParams.get('code_challenge_method'), 'S256')
  assert.equal(authParams.get('client_id'), 'accio-work')
  // 参数名是 return_url，不是 redirect_uri；也没有 response_type。
  assert.equal(authParams.get('return_url'), 'http://localhost:5960/callback')
  assert.equal(authParams.get('redirect_uri'), null)
  assert.equal(authParams.get('response_type'), null)
  assert.equal(authParams.get('state'), 'st')
  assert.equal(authParams.get('code_challenge'), pkce.challenge)
  // 国内版站点不同
  assert.ok(buildAccioAuthUrl(ACCIO_CN, 'http://localhost:5960/callback', 's', 'c').startsWith('https://www.accio-ai.com/'))

  // ── 配额查询：真实响应形状（2026-10-24 实测）──
  // 上游返回 { success:true, code:"200", data:{ usagePercent, refreshCountdownSeconds } }
  {
    const realBody = { success: true, code: '200', message: '0', data: { usagePercent: 0.0, refreshCountdownSeconds: 86400 } }
    const fakeFetch = async () => Response.json(realBody)
    const q = await fetchQuota(fakeFetch, ACCIO, { access_token: 'tok', created_at: Date.now() })
    assert.ok(q !== undefined, '真实响应必须能解析出配额')
    assert.equal(q.usedPercent, 0, 'usagePercent=0 必须被识别为「已用 0%」，不能当成缺失')
    // refreshCountdownSeconds 是「还有多少秒重置」，换算成毫秒时间戳。
    assert.ok(typeof q.resetAtMs === 'number' && q.resetAtMs > Date.now(), '应据 refreshCountdownSeconds 推出重置时刻')
    // 0 不能被 falsy 判断吞掉（历史坑：`if (!used)` 会把 0 当缺失）
    assert.notEqual(q.usedPercent, undefined)
  }

  // ── 假上游 ──
  let mode = 'ok'
  const seen = []
  const upstream = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      seen.push({ url: req.url, headers: req.headers, body: raw === '' ? undefined : JSON.parse(raw) })
      const json = (s, b) => res.writeHead(s, { 'Content-Type': 'application/json', Connection: 'close' }).end(JSON.stringify(b))
      if (req.url.startsWith('/api/oauth/token')) {
        if (mode === 'bad_code') return json(400, { error: 'invalid_grant' })
        return json(200, { accessToken: 'new-tok', refreshToken: 'new-ref', expiresAt: Date.now() + 3_600_000 })
      }
      if (req.url.startsWith('/api/llm/config')) return json(200, { models: [{ id: 'qwen3-max', name: 'Qwen3 Max', contextWindow: 128000 }] })
      if (req.url.startsWith('/api/entitlement/quota')) return json(200, { data: { usedPercent: 0.42, resetAt: Date.now() + 86400000 } })
      if (req.url.startsWith('/api/adk/llm/generateContent')) {
        if (mode === 'expired') { res.writeHead(401, { Connection: 'close' }).end('{}'); return }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
        if (mode === 'biz_error') { res.end('data: {"error_code":403,"error_message":"额度不足"}\n\n'); return }
        res.end([
          'data: {"content":{"parts":[{"thought":true,"text":"思考"}]}}',
          'data: {"content":{"parts":[{"text":"你好"}]}}',
          'data: {"content":{"parts":[{"text":"世界"}]}}',
          'data: {"turn_complete":true,"finish_reason":"STOP"}',
        ].join('\n\n') + '\n\n')
        return
      }
      json(404, {})
    })
  })
  await new Promise(r => upstream.listen(0, '127.0.0.1', r))
  const gwBase = `http://127.0.0.1:${upstream.address().port}`
  const product = { ...ACCIO, gatewayBase: gwBase, llmBase: `${gwBase}/api/adk/llm`, loginBase: gwBase }
  const cred = { access_token: 'tok' }

  try {
    // ── 换 token ──
    const exchanged = await exchangeCode(realFetch, product, 'code', 'verifier', 'http://localhost:5960/callback')
    assert.equal(exchanged.access_token, 'new-tok')
    assert.equal(exchanged.refresh_token, 'new-ref')
    mode = 'bad_code'
    await assert.rejects(() => exchangeCode(realFetch, product, 'bad', 'v', 'http://x'), /HTTP 400/)
    mode = 'ok'

    // ── 模型目录 ──
    const models = await fetchModels(realFetch, product, cred)
    assert.equal(models.length, 1)
    assert.equal(models[0].id, 'qwen3-max')
    // 目录请求的 body 带 token（不是 header）
    const cfgReq = seen.find(x => x.url.startsWith('/api/llm/config'))
    assert.equal(cfgReq.body.token, 'tok')
    assert.equal(cfgReq.headers.authorization, undefined, '目录请求也不带 Authorization')

    // ── 额度 ──
    const quota = await fetchQuota(realFetch, product, cred)
    assert.equal(quota.usedPercent, 0.42)

    // ── 流式对话 ──
    const deltas = []
    for await (const d of streamChat(realFetch, product, cred, {
      model: 'qwen3-max', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) deltas.push(d)
    assert.equal(deltas.length, 3)
    assert.equal(deltas[0].reasoning, '思考')
    assert.equal(deltas[1].text, '你好')
    // 推理请求带 sg_k 且 body 有 token
    const genReq = seen.find(x => x.url.startsWith('/api/adk/llm/generateContent'))
    assert.ok(genReq.url.includes('sg_k='), '推理请求带 sg_k')
    assert.equal(genReq.body.token, 'tok')

    // ── 业务错误帧（200 里）──
    mode = 'biz_error'
    await assert.rejects(
      async () => { for await (const _ of streamChat(realFetch, product, cred, { model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })) {} },
      /额度不足/,
    )
    mode = 'ok'

    // ── 适配器端到端 ──
    const adapter = new AccioAdapter({ product, fetchImpl: realFetch, resolveCredential: async () => cred })
    const chunks = await collect(adapter.stream({
      model: 'qwen3-max', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }))
    assert.equal(chunks.filter(c => c.type === 'reasoning-delta').map(c => c.text).join(''), '思考')
    assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), '你好世界')
    assert.ok(chunks.some(c => c.type === 'finish'))

    // 无凭据
    const noCred = new AccioAdapter({ product, fetchImpl: realFetch, resolveCredential: async () => undefined })
    await assert.rejects(
      () => collect(noCred.stream({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })),
      e => e.code === 'MISSING_CREDENTIAL',
    )

    // ── 回调服务器双栈：浏览器把 localhost 解析成 ::1 时也必须能连上 ──
    // 只绑 127.0.0.1 的历史实现会表现为「授权完页面打不开 / 没反应」。
    const probe = (url) => new Promise((resolve) => {
      const request = http.request(url, { method: 'GET', timeout: 2000 }, (response) => {
        response.resume()
        resolve(response.statusCode)
      })
      request.on('error', () => resolve(undefined))
      request.on('timeout', () => { request.destroy(); resolve(undefined) })
      request.end()
    })
    const started = await startAccioLogin({ product: ACCIO, timeoutMs: 4000 })
    try {
      const redirect = new URL(started.loginUrl).searchParams.get('return_url')
      assert.ok(redirect !== null && redirect !== '', 'loginUrl 必须带 return_url（Accio 的回调参数名）')
      const callbackPort = new URL(redirect).port
      // 错误 state 必须被 400 拒掉 —— 能拿到 400 就证明该地址确实有监听。
      assert.equal(await probe(`http://127.0.0.1:${callbackPort}${ACCIO_CALLBACK_PATH}?code=x&state=wrong`), 400, 'v4 回调必须可达')
      const v6 = await probe(`http://[::1]:${callbackPort}${ACCIO_CALLBACK_PATH}?code=x&state=wrong`)
      if (v6 !== undefined) assert.equal(v6, 400, 'v6 可用时回调必须同样可达')
    } finally {
      await started.close()
    }

    console.log('ok  accio: PKCE/Gemini 信封/ADK 帧（含 200 内业务错误）/token 不走 Authorization/两地区/适配器端到端/回调双栈')
  } finally {
    upstream.closeAllConnections?.()
    await new Promise(r => upstream.close(r))
  }
}

export async function verifyAccio() { await main() }

// 单独执行时本文件需要 channel-pack-test 的 TypeScript 加载钩子；直接跑会
// import .ts 失败或静默零断言，故显式提示（不制造「假绿」）。
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  console.error('accio-test 需要 TypeScript 加载钩子：请运行 node scripts/channel-pack-test.mjs --source')
  process.exitCode = 1
}
