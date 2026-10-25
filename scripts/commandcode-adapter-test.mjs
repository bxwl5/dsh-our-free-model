/** Command Code 适配器：本地假上游验证对话链路，不出网。 */
import assert from 'node:assert/strict'
import http from 'node:http'

const collect = async (iterable) => {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}
const sse = frames => `data: ${frames.join('\n\ndata: ')}\n\ndata: [DONE]\n\n`

async function main() {
  const { CommandCodeAdapter } = await import('../vendor/channel-pack/src/commandcode-adapter.ts')
  const { COMMANDCODE } = await import('../vendor/channel-pack/src/commandcode-product.ts')
  const { fetch: realFetch } = await import('undici')

  const seen = []
  let mode = 'ok'
  const upstream = http.createServer((req, res) => {
    const body = []
    req.on('data', c => body.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(body).toString('utf8')
      if (req.url === '/provider/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' }).end(JSON.stringify({
          object: 'list',
          data: [
            { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', context_length: 200000, max_output_tokens: 64000, supported_endpoints: ['image'] },
            { id: 'gpt-6-astra', name: 'GPT-6 Astra', context_length: 400000 },
          ],
        }))
        return
      }
      if (req.url === '/provider/v1/messages') {
        seen.push({ auth: req.headers.authorization, body: JSON.parse(raw), anthropic: true })
        if (mode === '401') { res.writeHead(401, { 'Content-Type': 'application/json', Connection: 'close' }).end('{"error":"invalid"}'); return }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
        // Anthropic 的命名事件流：message_start → content_block_* → message_delta → message_stop
        const ev = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
        res.end([
          ev('message_start', { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 0 } } }),
          ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
          ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } }),
          ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '世界' } }),
          ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
          ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
          ev('message_stop', { type: 'message_stop' }),
        ].join(''))
        return
      }
      if (req.url === '/provider/v1/chat/completions') {
        seen.push({ auth: req.headers.authorization, body: JSON.parse(raw) })
        if (mode === '401') { res.writeHead(401, { 'Content-Type': 'application/json', Connection: 'close' }).end('{"error":"invalid"}'); return }
        if (mode === '429') { res.writeHead(429, { 'Content-Type': 'application/json', Connection: 'close' }).end('{"error":"rate limited"}'); return }
        if (mode === '500') { res.writeHead(500, { 'Content-Type': 'application/json', Connection: 'close' }).end('{"error":"boom"}'); return }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
        res.end(sse([
          JSON.stringify({ choices: [{ delta: { content: '你好' }, finish_reason: null }] }),
          JSON.stringify({ choices: [{ delta: { content: '世界' }, finish_reason: null }] }),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
        ]))
        return
      }
      res.writeHead(404, { Connection: 'close' }).end('{}')
    })
  })
  await new Promise(r => upstream.listen(0, '127.0.0.1', r))
  const product = { ...COMMANDCODE, apiBase: `http://127.0.0.1:${upstream.address().port}` }

  const makeAdapter = (overrides = {}) => new CommandCodeAdapter({
    product,
    fetchImpl: realFetch,
    resolveCredential: async () => ({ access_token: 'good-key', account_id: 'u-1' }),
    ...overrides,
  })

  try {
    // ── providerInfo 防御性归一化 ──
    const adapter = makeAdapter()
    assert.equal(adapter.providerInfo('commandcode').id, 'commandcode')
    assert.equal(adapter.providerInfo(undefined).id, 'commandcode', 'provider 非字符串时回退')

    // ── listModels ──
    const models = await adapter.listModels('commandcode')
    assert.equal(models.length, 2)
    assert.equal(models[0].id, 'claude-sonnet-5-5')
    assert.deepEqual(models[0].inputModalities, ['text', 'image'], '支持图片的模型要播报 image')
    assert.deepEqual(models[1].inputModalities, ['text'], '不支持图片只报 text')

    // ── resolveModel ──
    const resolved = await adapter.resolveModel('commandcode', 'claude-sonnet-5-5')
    assert.equal(resolved.name, 'Claude Sonnet 5.5')
    assert.equal(resolved.context.contextWindow, 200000)
    assert.equal(resolved.defaultMaxTokens, 64000, '必须声明 defaultMaxTokens')

    // ── stream 正常路径 ──
    mode = 'ok'
    const chunks = await collect(adapter.stream({
      model: 'gpt-6-astra',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      system: 'be nice',
      maxTokens: 1024,
    }))
    const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
    assert.equal(text, '你好世界')
    assert.ok(chunks.some(c => c.type === 'finish'), '必须有收尾块')
    // 鉴权头是标准 Bearer
    assert.equal(seen[0].auth, 'Bearer good-key')
    // system 进了 wire
    assert.equal(seen[0].body.messages[0].role, 'system')
    assert.equal(seen[0].body.messages[0].content, 'be nice')
    // max_tokens 按调用方给值下发
    assert.equal(seen[0].body.max_tokens, 1024)
    assert.equal(seen[0].body.stream, true)

    // ── 401 → AUTH ──
    mode = '401'
    await assert.rejects(
      () => collect(makeAdapter().stream({ model: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })),
      e => e.code === 'AUTH',
    )

    // ── 429 → RATE_LIMIT ──
    mode = '429'
    await assert.rejects(
      () => collect(makeAdapter().stream({ model: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })),
      e => e.code === 'RATE_LIMIT',
    )

    // ── 500 → 服务端错误 ──
    mode = '500'
    await assert.rejects(
      () => collect(makeAdapter().stream({ model: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })),
      e => e.code !== 'AUTH' && e.code !== 'RATE_LIMIT',
    )

    // ── 无凭据 → MISSING_CREDENTIAL ──
    const noCred = makeAdapter({ resolveCredential: async () => undefined })
    await assert.rejects(
      () => collect(noCred.stream({ model: 'x', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })),
      e => e.code === 'MISSING_CREDENTIAL',
    )

    // ── 工具调用透传 ──
    mode = 'ok'
    const withTools = makeAdapter()
    await collect(withTools.stream({
      model: 'gpt-6-astra',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object', properties: {} } }],
    }))
    const last = seen[seen.length - 1].body
    assert.equal(last.tools.length, 1)
    assert.equal(last.tools[0].function.name, 'read')

    // ── Claude 系列必须走 Anthropic Messages 端点（2026-10-25 实测缺陷）──
    // 把 claude-* 发到 /provider/v1/chat/completions 会被上游 400：
    // `must be called via /provider/v1/messages (Anthropic Messages shape)`。
    mode = 'ok'
    seen.length = 0
    const claudeAdapter = makeAdapter()
    const claudeChunks = await collect(claudeAdapter.stream({
      model: 'claude-sonnet-5-5',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      system: 'be nice',
      maxTokens: 512,
    }))
    const claudeText = claudeChunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
    assert.equal(claudeText, '你好世界', 'Claude 走 Anthropic 端点也要能解出正文')
    assert.equal(seen.length, 1, 'Claude 只应发一次请求')
    assert.equal(seen[0].anthropic, true, 'Claude 必须打到 /provider/v1/messages')
    assert.equal(seen[0].body.max_tokens, 512, 'Anthropic 用 max_tokens')
    assert.equal(seen[0].body.system, 'be nice', 'Anthropic 的 system 是顶层字段')
    assert.equal(seen[0].body.messages[0].role, 'user', 'Anthropic 的 system 不混进 messages')
    assert.equal(seen[0].body.tools, undefined, '没工具时不下发 tools')

    // ── 重试策略必须是扁平字段 ──
    const policy = adapter.providerRetryPolicy()
    assert.equal(typeof policy.initialDelayMs, 'number', 'initialDelayMs 必须在顶层')
    assert.equal(typeof policy.maxDelayMs, 'number', 'maxDelayMs 必须在顶层')
    assert.equal(typeof policy.jitterRatio, 'number', 'jitterRatio 必须在顶层')
    assert.equal('backoff' in policy, false, '不能嵌套 backoff')
    assert.equal(policy.retryableCodes.includes('AUTH'), false, 'AUTH 不可重试')
    assert.equal(policy.retryableCodes.includes('RATE_LIMIT'), false, '429 不可重试')

    console.log('ok  commandcode-adapter: 目录/解析/流式/错误分类/工具/重试策略，system 与 max_tokens 正确下发')
  } finally {
    upstream.closeAllConnections?.()
    await new Promise(r => upstream.close(r))
  }
}

export async function verifyCommandCodeAdapter() {
  await main()
}

// 单独运行时必须失败（不能静默 exit 0）：见 scripts/lib/direct-run.mjs。
import { exitIfDirectRun } from './lib/direct-run.mjs'
exitIfDirectRun(import.meta.url, 'commandcode-adapter-test')
