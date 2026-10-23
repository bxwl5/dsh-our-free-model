/** AutoClaw：X-Authorization 头、模型目录路径、OpenAI 兼容对话、两地区。 */
import assert from 'node:assert/strict'
import http from 'node:http'

const collect = async (it) => { const out = []; for await (const c of it) out.push(c); return out }

async function main() {
  const {
    isCredentialUsable, isCredentialExpired, autoClawHeaders, chatEndpoint,
    parseCredential, parseModelConfig,
  } = await import('../vendor/channel-pack/src/autoclaw.ts')
  const { AUTOCLAW, AUTOCLAW_INTL, AUTOCLAW_MODEL_CONFIG_PATH, AUTOCLAW_CALLBACK_PORTS } = await import('../vendor/channel-pack/src/autoclaw-product.ts')
  const { AutoClawAdapter } = await import('../vendor/channel-pack/src/autoclaw-adapter.ts')
  const { fetch: realFetch } = await import('undici')

  // ── 凭据 ──
  assert.equal(isCredentialUsable({ access_token: 'tok' }), true)
  assert.equal(isCredentialUsable({ access_token: ' tok ' }), false)
  assert.equal(isCredentialExpired({ access_token: 't', expire_time: Date.now() - 1 }), true)
  assert.equal(isCredentialExpired({ access_token: 't' }), false)
  assert.equal(parseCredential({ accessToken: 'a' }).access_token, 'a', '驼峰兼容')
  assert.equal(parseCredential({ token: 'b' }).access_token, 'b', 'token 字段兼容')
  assert.equal(parseCredential({}), undefined)
  assert.equal(parseCredential({ token: 'c', expiresAt: 1_700_000_000 }).expire_time, 1_700_000_000_000, '秒级抬毫秒')

  // ── ⚠️ 认证头是 X-Authorization ──
  const h = autoClawHeaders(AUTOCLAW, { access_token: 'tok' })
  assert.equal(h['X-Authorization'], 'Bearer tok', '认证头是 X-Authorization')
  assert.equal(h.Authorization, undefined, '不能用标准 Authorization')

  // ── 端点 ──
  assert.equal(chatEndpoint(AUTOCLAW), 'https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw/chat/completions')
  assert.equal(chatEndpoint(AUTOCLAW_INTL), 'https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw/chat/completions')
  // ⚠️ 模型目录不在 proxyPrefix 下
  assert.equal(AUTOCLAW_MODEL_CONFIG_PATH, '/proxy/autoclaw-model-config')
  assert.equal(AUTOCLAW_MODEL_CONFIG_PATH.startsWith('/autoclaw'), false, '目录路径不在 /autoclaw 下')
  // 回调端口白名单
  assert.deepEqual([...AUTOCLAW_CALLBACK_PORTS], [18432, 19654, 19723, 53699])

  // ── 模型目录解析（三种形态）──
  assert.equal(parseModelConfig([{ id: 'm1', name: 'M1' }]).length, 1, '顶层数组')
  assert.equal(parseModelConfig({ models: [{ id: 'm2' }] }).length, 1, 'models 字段')
  assert.equal(parseModelConfig({ data: [{ id: 'm3' }] }).length, 1, 'data 字段')
  assert.equal(parseModelConfig({}).length, 0)
  assert.equal(parseModelConfig({ models: [{ model: 'm4', contextWindow: 64000 }] })[0].contextWindow, 64_000)

  // ── 假上游 ──
  let mode = 'ok'
  const seen = []
  const upstream = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers })
      const json = (s, b) => res.writeHead(s, { 'Content-Type': 'application/json', Connection: 'close' }).end(JSON.stringify(b))
      if (req.url === '/proxy/autoclaw-model-config') {
        if (req.headers['x-authorization'] !== 'Bearer tok') return json(401, {})
        return json(200, { models: [{ id: 'autoglm-air', name: 'AutoGLM Air', contextWindow: 128000 }] })
      }
      if (req.url === '/autoclaw-proxy/proxy/autoclaw/chat/completions') {
        if (req.headers['x-authorization'] !== 'Bearer tok') return json(401, {})
        if (mode === 'expired') return json(401, { error: 'expired' })
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
        res.end([
          'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}',
          'data: {"choices":[{"delta":{"content":"世界"},"finish_reason":"stop"}]}',
          'data: [DONE]',
        ].join('\n\n') + '\n\n')
        return
      }
      json(404, {})
    })
  })
  await new Promise(r => upstream.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${upstream.address().port}`
  const product = { ...AUTOCLAW, apiBase: base }
  const cred = { access_token: 'tok' }

  try {
    const adapter = new AutoClawAdapter({ product, fetchImpl: realFetch, resolveCredential: async () => cred })
    // 模型目录
    const models = await adapter.listModels('autoclaw')
    assert.equal(models.length, 1)
    assert.equal(models[0].name, 'AutoGLM Air')
    // 走的是 /proxy/autoclaw-model-config
    assert.ok(seen.some(x => x.url === '/proxy/autoclaw-model-config'))

    // 对话
    const chunks = await collect(adapter.stream({
      model: 'autoglm-air', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], system: 'sys',
    }))
    assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), '你好世界')
    assert.ok(chunks.some(c => c.type === 'finish'))
    // 对话请求带 X-Authorization
    const chatReq = seen.find(x => x.url === '/autoclaw-proxy/proxy/autoclaw/chat/completions')
    assert.equal(chatReq.headers['x-authorization'], 'Bearer tok')
    assert.equal(chatReq.headers.authorization, undefined)

    // 401 → AUTH
    mode = 'expired'
    await assert.rejects(
      () => collect(adapter.stream({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })),
      e => e.code === 'AUTH',
    )
    mode = 'ok'

    // 无凭据
    const noCred = new AutoClawAdapter({ product, fetchImpl: realFetch, resolveCredential: async () => undefined })
    await assert.rejects(
      () => collect(noCred.stream({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })),
      e => e.code === 'MISSING_CREDENTIAL',
    )

    const policy = adapter.providerRetryPolicy()
    assert.equal(typeof policy.initialDelayMs, 'number')
    assert.equal('backoff' in policy, false)

    console.log('ok  autoclaw: X-Authorization 头/目录路径不在 proxyPrefix 下/OpenAI 兼容对话/两地区/凭据解析')
  } finally {
    upstream.closeAllConnections?.()
    await new Promise(r => upstream.close(r))
  }
}

export async function verifyAutoClaw() { await main() }
