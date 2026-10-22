/** KukuAI：BDUSS Cookie 归一、SSE 帧、sendmsg 载荷、流式对话。 */
import assert from 'node:assert/strict'
import http from 'node:http'

const collect = async (it) => { const out = []; for await (const c of it) out.push(c); return out }

async function main() {
  const {
    normalizeCookie, isCredentialUsable, buildSendmsgBody, parseSseFrame,
    flattenMessages, kukuHeaders,
  } = await import('../vendor/channel-pack/src/kuku.ts')
  const { KUKU, KUKU_CLIENT_TYPE, KUKU_CHANNEL, KUKU_PROTOCOL_V } = await import('../vendor/channel-pack/src/kuku-product.ts')
  const { streamChat, probeCredential } = await import('../vendor/channel-pack/src/kuku-auth.ts')
  const { KukuAdapter } = await import('../vendor/channel-pack/src/kuku-adapter.ts')
  const { fetch: realFetch } = await import('undici')

  // ── Cookie 归一（BDUSS）──
  assert.equal(normalizeCookie('BDUSS=abc; STOKEN=x'), 'BDUSS=abc; STOKEN=x')
  assert.equal(normalizeCookie('  BDUSS=abc\r\n'), 'BDUSS=abc')
  assert.equal(normalizeCookie('foo=bar'), undefined, '缺 BDUSS 拒绝')
  assert.equal(isCredentialUsable({ access_token: 'BDUSS=x' }), true)
  assert.equal(isCredentialUsable({ access_token: 'x=1' }), false)

  // ── sendmsg 载荷 ──
  const body = buildSendmsgBody({
    text: 'hello', model: 'kuku',
    sessionId: 's1', replyId: 'r1', clientSessionId: 'c1', deviceId: '123',
  })
  assert.equal(body.channel, KUKU_CHANNEL)
  assert.equal(body.v, KUKU_PROTOCOL_V)
  assert.equal(body.device_type, Number(KUKU_CLIENT_TYPE))
  assert.equal(body.sub_type, 'chat_create')
  assert.equal(body.data.text, 'hello')
  assert.equal(body.data.model_name, 'kuku')
  // ⚠️ client_added 必须是字符串化 JSON
  assert.equal(typeof body.data.client_added, 'string')
  const parsed = JSON.parse(body.data.client_added)
  assert.equal(parsed.clienttype, KUKU_CLIENT_TYPE)
  assert.equal(parsed.device_os, 'windows')
  // rich_input_params 带文本块
  assert.equal(body.data.rich_input_params[0].text, 'hello')

  // ── SSE 帧 ──
  assert.deepEqual(parseSseFrame('[DONE]'), { kind: 'done' })
  assert.deepEqual(parseSseFrame('{"errno":0,"content":"你好"}'), { kind: 'delta', text: '你好' })
  assert.deepEqual(parseSseFrame('{"errno":0,"data":{"content":"嵌套"}}'), { kind: 'delta', text: '嵌套' })
  assert.deepEqual(parseSseFrame('{"errno":0,"reasoning_content":"想"}'), { kind: 'delta', reasoning: '想' })
  const err = parseSseFrame('{"errno":500,"errmsg":"boom"}')
  assert.equal(err.kind, 'error')
  assert.equal(parseSseFrame(''), undefined)
  assert.equal(parseSseFrame('not json'), undefined)

  // ── 消息拍平 ──
  const flat = flattenMessages([
    { role: 'user', content: [{ type: 'text', text: '问' }] },
    { role: 'assistant', content: [{ type: 'text', text: '答' }] },
  ], 'sys')
  assert.equal(flat, 'sys\n\n问\n\n答')

  // ── 请求头 ──
  const h = kukuHeaders(KUKU, { access_token: 'BDUSS=x' })
  assert.equal(h.Cookie, 'BDUSS=x')

  // ── 假上游 ──
  let mode = 'ok'
  const seen = []
  const upstream = http.createServer((req, res) => {
    const body = []
    req.on('data', c => body.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(body).toString('utf8')
      if (mode === 'expired') { res.writeHead(401, { Connection: 'close' }).end('{}'); return }
      if (req.url.startsWith('/wenchain/genflowpro/sendmsg')) {
        seen.push({ path: 'sendmsg', body: JSON.parse(raw) })
        res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
          .end(JSON.stringify({ errno: 0, data: { session_id: 'srv-s', reply_id: 'srv-r' } }))
        return
      }
      if (req.url.startsWith('/wenchain/genflowpro/sse/getchatcontent')) {
        seen.push({ path: 'sse', url: req.url, body: JSON.parse(raw) })
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
        if (mode === 'upstream_error') { res.end('data: {"errno":500,"errmsg":"额度不足"}\n\n'); return }
        res.end([
          'data: {"errno":0,"reasoning_content":"思考"}',
          'data: {"errno":0,"content":"你好"}',
          'data: {"errno":0,"content":"世界"}',
          'data: [DONE]',
        ].join('\n\n') + '\n\n')
        return
      }
      if (req.url.startsWith('/bizapi/gfpro/getgfvipremain')) {
        res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' }).end('{"errno":0}')
        return
      }
      res.writeHead(404, { Connection: 'close' }).end('{}')
    })
  })
  await new Promise(r => upstream.listen(0, '127.0.0.1', r))
  const product = { ...KUKU, apiBase: `http://127.0.0.1:${upstream.address().port}` }
  const cred = { access_token: 'BDUSS=good' }

  try {
    // ── 流式对话 ──
    const deltas = []
    for await (const d of streamChat(realFetch, product, cred, {
      model: 'kuku', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], system: 'sys',
    })) deltas.push(d)
    assert.equal(deltas.length, 3)
    assert.equal(deltas[0].reasoning, '思考')
    assert.equal(deltas[1].text, '你好')
    // sendmsg 载荷正确
    const send = seen.find(x => x.path === 'sendmsg')
    assert.ok(send.body.data.text.includes('sys'))
    assert.ok(send.body.data.text.includes('hi'))
    // SSE 用了上游返回的 session/reply
    const sse = seen.find(x => x.path === 'sse')
    assert.ok(sse.url.includes('session_id=srv-s'), 'SSE 用上游返回的 session')
    assert.ok(sse.url.includes('reply_id=srv-r'))

    // ── 上游错误帧 ──
    mode = 'upstream_error'
    await assert.rejects(
      async () => { for await (const _ of streamChat(realFetch, product, cred, { model: 'kuku', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })) {} },
      /额度不足/,
    )
    mode = 'ok'

    // ── 探活 ──
    assert.equal(await probeCredential(realFetch, product, cred), 'valid')
    mode = 'expired'
    assert.equal(await probeCredential(realFetch, product, cred), 'expired')
    mode = 'ok'

    // ── 适配器端到端 ──
    const adapter = new KukuAdapter({ product, fetchImpl: realFetch, resolveCredential: async () => cred })
    const chunks = await collect(adapter.stream({
      model: 'kuku', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }))
    assert.equal(chunks.filter(c => c.type === 'reasoning-delta').map(c => c.text).join(''), '思考')
    assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), '你好世界')
    assert.ok(chunks.some(c => c.type === 'finish'))

    const noCred = new KukuAdapter({ product, fetchImpl: realFetch, resolveCredential: async () => undefined })
    await assert.rejects(
      () => collect(noCred.stream({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })),
      e => e.code === 'MISSING_CREDENTIAL',
    )

    const policy = adapter.providerRetryPolicy()
    assert.equal(typeof policy.initialDelayMs, 'number')
    assert.equal('backoff' in policy, false)

    console.log('ok  kuku: BDUSS 归一/sendmsg 载荷（client_added 字符串化）/SSE 帧/上游 session 复用/错误帧/探活/适配器端到端')
  } finally {
    upstream.closeAllConnections?.()
    await new Promise(r => upstream.close(r))
  }
}

export async function verifyKuku() { await main() }
