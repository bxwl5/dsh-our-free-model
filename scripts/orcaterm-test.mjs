/** OrcaTerm：Cookie 归一、SSE 帧解析、建会话+流式对话、错误帧处理。 */
import assert from 'node:assert/strict'
import http from 'node:http'

const collect = async (it) => { const out = []; for await (const c of it) out.push(c); return out }

async function main() {
  const {
    normalizeCookie, isCredentialUsable, parseChatFrame, flattenMessages, contentToText,
    orcaTermHeaders,
  } = await import('../vendor/channel-pack/src/orcaterm.ts')
  const { ORCATERM } = await import('../vendor/channel-pack/src/orcaterm-product.ts')
  const { streamChat, probeCredential } = await import('../vendor/channel-pack/src/orcaterm-auth.ts')
  const { OrcaTermAdapter } = await import('../vendor/channel-pack/src/orcaterm-adapter.ts')
  const { fetch: realFetch } = await import('undici')

  // ── Cookie 归一 ──
  assert.equal(normalizeCookie('ot_session=abc; x=1'), 'ot_session=abc; x=1')
  assert.equal(normalizeCookie('  ot_session=abc\r\n'), 'ot_session=abc')
  assert.equal(normalizeCookie('foo=bar'), undefined)
  assert.equal(isCredentialUsable({ access_token: 'ot_session=x' }), true)
  assert.equal(isCredentialUsable({ access_token: 'x=1' }), false)

  // ── SSE 帧解析：四种形态 ──
  assert.deepEqual(parseChatFrame('[DONE]'), { kind: 'done' })
  assert.deepEqual(parseChatFrame('[ERROR]: [LLM_ERROR]: 额度不足'), { kind: 'error', message: '[LLM_ERROR]: 额度不足' })
  assert.deepEqual(parseChatFrame('{"content":"你好","code":0}'), { kind: 'delta', text: '你好' })
  assert.deepEqual(parseChatFrame('{"reasoningContent":"想一下","reasoning":true,"code":0}'), { kind: 'delta', reasoning: '想一下' })
  // 非零 code 视为错误
  const err = parseChatFrame('{"code":500,"msg":"boom"}')
  assert.equal(err.kind, 'error')
  // 无关帧不报错
  assert.equal(parseChatFrame(''), undefined)
  assert.equal(parseChatFrame('not json at all'), undefined)
  assert.equal(parseChatFrame('{"code":0}'), undefined)

  // ── 消息拍平 ──
  const flat = flattenMessages([
    { role: 'user', content: [{ type: 'text', text: '第一问' }] },
    { role: 'assistant', content: [{ type: 'text', text: '第一答' }] },
    { role: 'user', content: [{ type: 'text', text: '第二问' }] },
  ], 'be nice')
  assert.ok(flat.includes('## system\nbe nice'))
  assert.ok(flat.includes('## user\n第一问'))
  assert.ok(flat.includes('## assistant\n第一答'))
  assert.equal(contentToText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\nb')

  // ── 请求头 ──
  const h = orcaTermHeaders(ORCATERM, { access_token: 'ot_session=x' })
  assert.equal(h.Cookie, 'ot_session=x')

  // ── 假上游：建会话 + SSE ──
  let mode = 'ok'
  const seen = []
  const upstream = http.createServer((req, res) => {
    const body = []
    req.on('data', c => body.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(body).toString('utf8')
      if (mode === 'expired') { res.writeHead(401, { Connection: 'close' }).end('{}'); return }
      if (req.url.startsWith('/assistant/conversation')) {
        seen.push({ path: 'conversation', body: JSON.parse(raw) })
        res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' }).end('{"code":0,"data":{}}')
        return
      }
      if (req.url.startsWith('/assistant/chat')) {
        seen.push({ path: 'chat', body: JSON.parse(raw) })
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
        if (mode === 'upstream_error') {
          res.end('data: [ERROR]: [LLM_ERROR]: 额度不足\n\n')
          return
        }
        res.end([
          'data: {"code":0,"reasoningContent":"思考","reasoning":true}',
          'data: {"code":0,"content":"你好"}',
          'data: {"code":0,"content":"世界"}',
          'data: [DONE]',
        ].join('\n\n') + '\n\n')
        return
      }
      res.writeHead(404, { Connection: 'close' }).end('{}')
    })
  })
  await new Promise(r => upstream.listen(0, '127.0.0.1', r))
  const product = { ...ORCATERM, lightaiBase: `http://127.0.0.1:${upstream.address().port}` }
  const cred = { access_token: 'ot_session=good' }

  try {
    // ── 流式对话 ──
    const deltas = []
    for await (const d of streamChat(realFetch, product, cred, {
      model: 'deepseek-v3.2',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      system: 'be nice',
    })) deltas.push(d)
    assert.equal(deltas.length, 3, '两段正文 + 一段思考')
    assert.equal(deltas[0].reasoning, '思考')
    assert.equal(deltas[1].text, '你好')
    assert.equal(deltas[2].text, '世界')
    // 建会话带了 tags
    const conv = seen.find(x => x.path === 'conversation')
    assert.deepEqual(conv.body.tags, ['orcaterm'])
    // 对话带了 conversationId 与拍平输入
    const chat = seen.find(x => x.path === 'chat')
    assert.ok(chat.body.conversationId.startsWith('cid-'))
    assert.ok(chat.body.input.input.includes('## user\nhi'))
    assert.ok(chat.body.input.input.includes('## system\nbe nice'))
    assert.equal(chat.body.stream, true)

    // ── 上游错误帧必须抛错 ──
    mode = 'upstream_error'
    await assert.rejects(
      async () => { for await (const _ of streamChat(realFetch, product, cred, { model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })) {} },
      /额度不足/,
    )
    mode = 'ok'

    // ── 探活 ──
    assert.equal(await probeCredential(realFetch, product, cred), 'valid')
    mode = 'expired'
    assert.equal(await probeCredential(realFetch, product, cred), 'expired')
    mode = 'ok'

    // ── 适配器端到端 ──
    const adapter = new OrcaTermAdapter({
      product, fetchImpl: realFetch, resolveCredential: async () => cred,
    })
    const chunks = await collect(adapter.stream({
      model: 'deepseek-v3.2',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }))
    const reasoning = chunks.filter(c => c.type === 'reasoning-delta').map(c => c.text).join('')
    const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
    assert.equal(reasoning, '思考')
    assert.equal(text, '你好世界')
    assert.ok(chunks.some(c => c.type === 'finish'))

    // 无凭据 → MISSING_CREDENTIAL
    const noCred = new OrcaTermAdapter({ product, fetchImpl: realFetch, resolveCredential: async () => undefined })
    await assert.rejects(
      () => collect(noCred.stream({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })),
      e => e.code === 'MISSING_CREDENTIAL',
    )

    // 重试策略扁平
    const policy = adapter.providerRetryPolicy()
    assert.equal(typeof policy.initialDelayMs, 'number')
    assert.equal('backoff' in policy, false)

    console.log('ok  orcaterm: Cookie 归一/SSE 四种帧/消息拍平/建会话+流式/错误帧抛错/探活/适配器端到端')
  } finally {
    upstream.closeAllConnections?.()
    await new Promise(r => upstream.close(r))
  }
}

export async function verifyOrcaTerm() { await main() }
