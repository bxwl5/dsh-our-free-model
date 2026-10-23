/** CatPaw：X-Passport-Token 头、模型目录（POST）、对话明确拒绝。 */
import assert from 'node:assert/strict'
import http from 'node:http'

const collect = async (it) => { const out = []; for await (const c of it) out.push(c); return out }

async function main() {
  const {
    isCredentialUsable, catPawHeaders, parseCredential, parseModelTypes,
    fetchModelTypes, probeCredential,
  } = await import('../vendor/channel-pack/src/catpaw.ts')
  const { CATPAW, CATPAW_MODEL_TYPES_PATH, CATPAW_TOKEN_HEADER, CATPAW_TURN_TIMEOUT_MS } = await import('../vendor/channel-pack/src/catpaw-product.ts')
  const { CatPawAdapter } = await import('../vendor/channel-pack/src/catpaw-adapter.ts')
  const { fetch: realFetch } = await import('undici')

  // ── 凭据 ──
  assert.equal(isCredentialUsable({ access_token: 'tok' }), true)
  assert.equal(isCredentialUsable({ access_token: ' tok ' }), false)
  assert.equal(isCredentialUsable({ access_token: '' }), false)
  assert.equal(parseCredential({ token: 'a' }).access_token, 'a')
  assert.equal(parseCredential({ accessToken: 'b' }).access_token, 'b')
  assert.equal(parseCredential({ passportToken: 'c' }).access_token, 'c')
  assert.equal(parseCredential({}), undefined)
  assert.equal(parseCredential({ token: 'd', userUid: 'u1' }).user_uid, 'u1')

  // ── ⚠️ 认证头是 X-Passport-Token（Cookie 形态）──
  const h = catPawHeaders(CATPAW, { access_token: 'tok' })
  assert.equal(h[CATPAW_TOKEN_HEADER], 'tok')
  assert.equal(h.Authorization, undefined, '不是 Bearer 形态')

  // ── 端点形态 ──
  assert.equal(CATPAW_MODEL_TYPES_PATH, '/api/agent/maas/model-types')
  assert.equal(CATPAW_TURN_TIMEOUT_MS, 900_000, 'turn 超时 15 分钟')

  // ── 模型目录解析（多种形态）──
  assert.equal(parseModelTypes([{ modelTypeId: 'm1', name: 'M1' }]).length, 1, '顶层数组')
  assert.equal(parseModelTypes({ data: { modelTypes: [{ modelTypeId: 'm2' }] } }).length, 1, 'data.modelTypes')
  assert.equal(parseModelTypes({ models: [{ id: 'm3' }] }).length, 1, 'models 字段')
  assert.equal(parseModelTypes({ data: [{ host_model_id: 'm4' }] }).length, 1, 'data 数组 + host_model_id')
  assert.equal(parseModelTypes({}).length, 0)
  assert.equal(parseModelTypes({ data: [{ modelTypeId: 'm5', default_context_window: 64000 }] })[0].contextWindow, 64_000)

  // ── 假上游 ──
  let mode = 'ok'
  const seen = []
  const upstream = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, headers: req.headers })
      const json = (s, b) => res.writeHead(s, { 'Content-Type': 'application/json', Connection: 'close' }).end(JSON.stringify(b))
      if (req.url === '/api/agent/maas/model-types') {
        if (req.method !== 'POST') return json(405, {})
        if (req.headers['x-passport-token'] !== 'tok') return json(401, {})
        return json(200, { data: { modelTypes: [{ modelTypeId: 'mt-1', name: 'CatPaw Pro', default_context_window: 128000 }] } })
      }
      json(404, {})
    })
  })
  await new Promise(r => upstream.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${upstream.address().port}`
  const product = { ...CATPAW, apiBase: base }

  try {
    // ── 模型目录（POST）──
    const rows = await fetchModelTypes(realFetch, product, { access_token: 'tok' })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].name, 'CatPaw Pro')
    assert.equal(seen[0].method, 'POST', '目录是 POST 不是 GET')

    // ── 探活 ──
    assert.equal(await probeCredential(realFetch, product, { access_token: 'tok' }), 'valid')
    assert.equal(await probeCredential(realFetch, product, { access_token: 'bad' }), 'expired')
    assert.equal(await probeCredential(realFetch, { ...product, apiBase: 'http://127.0.0.1:1' }, { access_token: 'tok' }), 'network_error')

    // ── 适配器 ──
    const adapter = new CatPawAdapter({ product, fetchImpl: realFetch, resolveCredential: async () => ({ access_token: 'tok' }) })
    assert.equal(adapter.providerInfo('catpaw').id, 'catpaw')
    const models = await adapter.listModels('catpaw')
    assert.equal(models.length, 1)
    assert.deepEqual(models[0].inputModalities, ['text'])

    // 对话必须明确拒绝（不能返回空流）
    await assert.rejects(
      () => collect(adapter.stream({ model: 'mt-1', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })),
      (e) => e.code === 'UNSUPPORTED_CONTENT' && /暂未支持/.test(e.message) && /有状态会话/.test(e.message),
    )

    // 重试策略：只读渠道不重试
    const policy = adapter.providerRetryPolicy()
    assert.equal(policy.maxRetries, 0)
    assert.equal(policy.retryableCodes.length, 0)
    assert.equal(typeof policy.initialDelayMs, 'number', '扁平字段')

    console.log('ok  catpaw: X-Passport-Token 头/目录 POST/多形态解析/探活三态，对话明确拒绝且重试策略为空')
  } finally {
    upstream.closeAllConnections?.()
    await new Promise(r => upstream.close(r))
  }
}

export async function verifyCatPaw() { await main() }
