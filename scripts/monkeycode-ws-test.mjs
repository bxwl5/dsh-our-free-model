/** MonkeyCode WebSocket：握手/帧编解码/事件容错解析/真实连接。 */
import assert from 'node:assert/strict'
import http from 'node:http'

/**
 * 取 monkeycode-ws.ts 的导出。
 *
 * Node 22 的 strip-only TS 模式拒绝「参数属性」（`constructor(private readonly socket: Socket)`），
 * 而本模块的 MonkeyCodeWsClient 正好用了它，直接 `import(...ts)` 会报
 * ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。channel-pack-test.mjs 的 source 模式用
 * registerHooks + typescript 转译；这里为让本文件能独立运行，检测到该错误时
 * 自备同一套最小转译钩子后重试（source 模式下首次导入即成功，不会重复注册）。
 */
async function loadWsModule() {
  const specifier = '../vendor/channel-pack/src/monkeycode-ws.ts'
  try {
    return await import(specifier)
  } catch (error) {
    if (error?.code !== 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') throw error
    const [{ registerHooks }, fs, { fileURLToPath }, tsModule] = await Promise.all([
      import('node:module'), import('node:fs'), import('node:url'), import('typescript'),
    ])
    const ts = tsModule.default
    registerHooks({
      load(url, context, nextLoad) {
        if (url.endsWith('.ts') && url.includes('/vendor/channel-pack/src/')) {
          const fileName = fileURLToPath(url)
          return {
            format: 'module',
            source: ts.transpileModule(fs.readFileSync(fileName, 'utf8'), {
              compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
              fileName,
            }).outputText,
            shortCircuit: true,
          }
        }
        return nextLoad(url, context)
      },
    })
    return await import(specifier)
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 监听 127.0.0.1 的随机端口，返回 "host:port"。 */
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `127.0.0.1:${server.address().port}`
}

/** 关掉服务器和它上面残留的连接（含已 upgrade 的 socket）。 */
async function closeServer(server, sockets = []) {
  for (const socket of sockets) socket.destroy()
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}

async function main() {
  const {
    WS_GUID, WS_OPCODE, WS_MAX_PAYLOAD, wsAcceptKey, createWsKey, parseFrame, encodeFrame,
    MonkeyCodeWsClient, WsHandshakeError, openWebSocket, parseTaskStreamEvent, toWebSocketUrl,
  } = await loadWsModule()

  // ── 1. 握手（纯函数） ──
  assert.equal(WS_GUID, '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
  assert.equal(wsAcceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=', 'RFC 6455 §1.3 官方向量')
  assert.notEqual(wsAcceptKey('AAAAAAAAAAAAAAAAAAAAAA=='), wsAcceptKey('BBBBBBBBBBBBBBBBBBBBBB=='))

  const key = createWsKey()
  assert.match(key, /^[A-Za-z0-9+/]{22}==$/, '16 字节的 base64 形态')
  assert.equal(Buffer.from(key, 'base64').length, 16, '解码后正好 16 字节')
  assert.notEqual(createWsKey(), createWsKey(), '每次握手 key 都不同')

  assert.equal(toWebSocketUrl('https://x.com', '/a/b', { id: '1' }), 'wss://x.com/a/b?id=1')
  assert.equal(toWebSocketUrl('http://x.com', '/a/b'), 'ws://x.com/a/b', 'http → ws')
  assert.equal(toWebSocketUrl('ws://x.com:8080', '/s'), 'ws://x.com:8080/s', '已带 ws 原样保留')
  assert.equal(toWebSocketUrl('wss://x.com:8443', '/s'), 'wss://x.com:8443/s', 'wss 与端口保留')

  // ── 2. 帧编解码（纯函数） ──
  assert.deepEqual({ ...WS_OPCODE }, { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 })
  assert.equal(WS_MAX_PAYLOAD, 16 * 1024 * 1024)

  // 短帧：无扩展长度
  const short = encodeFrame(WS_OPCODE.text, 'hi', { mask: false })
  assert.deepEqual([...short], [0x81, 0x02, 0x68, 0x69], 'FIN+text，长度 2，服务端不掩码')
  const parsedShort = parseFrame(short)
  assert.ok(parsedShort, '短帧可解析')
  assert.equal(parsedShort.frame.fin, true)
  assert.equal(parsedShort.frame.opcode, WS_OPCODE.text)
  assert.equal(parsedShort.frame.payload.toString('utf8'), 'hi')
  assert.equal(parsedShort.consumed, short.length, 'consumed 覆盖整帧')

  // 长度档位边界：125/126 用 7bit、126..65535 用 16bit、>=65536 用 64bit
  const sized = (total) => encodeFrame(WS_OPCODE.binary, Buffer.alloc(total, 0x61), { mask: false })
  assert.equal(sized(125)[1], 125, '125 → 7bit 长度')
  assert.equal(sized(126)[1], 126, '126 → 16bit 扩展长度')
  assert.deepEqual([...sized(65535).subarray(2, 4)], [0xff, 0xff], '65535 → 16bit ffff')
  assert.equal(sized(65535)[1], 126, '65535 仍用 16bit')
  assert.equal(sized(65536)[1], 127, '65536 → 64bit 扩展长度')
  assert.deepEqual([...sized(65536).subarray(2, 10)], [0, 0, 0, 0, 0, 1, 0, 0])
  assert.deepEqual([...sized(70000).subarray(2, 10)], [0, 0, 0, 0, 0, 1, 0x11, 0x70])

  for (const total of [126, 300, 65535, 65536, 70000]) {
    const wire = sized(total)
    const parsed = parseFrame(wire)
    assert.ok(parsed, `${total} 字节帧可解析`)
    assert.equal(parsed.frame.payload.length, total)
    assert.equal(parsed.frame.payload[0], 0x61)
    assert.equal(parsed.frame.payload[total - 1], 0x61)
    assert.equal(parsed.consumed, wire.length, `${total} 字节帧 consumed 覆盖整帧`)
  }

  // 客户端掩码帧：4 字节掩码键循环 XOR
  const manualHead = Buffer.from([0x81, 0x85, 0x01, 0x02, 0x03, 0x04])
  const manualPlain = Buffer.from('hello')
  const manualMask = [0x01, 0x02, 0x03, 0x04]
  const manualCipher = Buffer.from(manualPlain.map((byte, index) => byte ^ manualMask[index & 3]))
  assert.notDeepEqual([...manualCipher], [...manualPlain], '线上负载确实是密文')
  const parsedManual = parseFrame(Buffer.concat([manualHead, manualCipher]))
  assert.ok(parsedManual, '掩码帧可解析')
  assert.equal(parsedManual.frame.payload.toString('utf8'), 'hello', '按 4 字节掩码键循环解掩码')
  assert.equal(parsedManual.consumed, manualHead.length + manualPlain.length)

  const masked = encodeFrame(WS_OPCODE.text, 'mask me')
  assert.equal(masked[1] & 0x80, 0x80, '客户端编码默认掩码')
  assert.equal(parseFrame(masked).frame.payload.toString('utf8'), 'mask me')

  // fin / opcode / 负载类型
  const fragmented = encodeFrame(WS_OPCODE.continuation, Buffer.from('x'), { mask: false, fin: false })
  assert.equal(fragmented[0], 0x00, 'fin=false 且 opcode=continuation')
  assert.equal(parseFrame(fragmented).frame.fin, false)
  for (const [name, code] of Object.entries(WS_OPCODE)) {
    const parsed = parseFrame(encodeFrame(code, 'p', { mask: false }))
    assert.ok(parsed, `${name} 帧可解析`)
    assert.equal(parsed.frame.opcode, code, `${name} opcode 保真`)
    assert.equal(parsed.frame.payload.toString('utf8'), 'p', `${name} 负载保真`)
  }
  const fromBytes = parseFrame(encodeFrame(WS_OPCODE.binary, new Uint8Array([1, 2, 3]), { mask: false }))
  assert.deepEqual([...fromBytes.frame.payload], [1, 2, 3], 'Uint8Array 负载')

  // 粘包：一个缓冲区里连续两帧，靠 consumed 推进
  const glued = Buffer.concat([encodeFrame(WS_OPCODE.text, 'a', { mask: false }), encodeFrame(WS_OPCODE.text, 'b', { mask: false })])
  const gluedFirst = parseFrame(glued)
  assert.equal(gluedFirst.frame.payload.toString('utf8'), 'a')
  const gluedSecond = parseFrame(glued.subarray(gluedFirst.consumed))
  assert.equal(gluedSecond.frame.payload.toString('utf8'), 'b', '同一缓冲区连续两帧')
  assert.equal(gluedSecond.consumed, glued.length - gluedFirst.consumed)

  // 数据不足 → undefined（不抛错）
  assert.equal(parseFrame(Buffer.alloc(0)), undefined, '空缓冲')
  assert.equal(parseFrame(Buffer.from([0x81])), undefined, '只有 1 字节')
  assert.equal(parseFrame(Buffer.from([0x81, 0x7e, 0x00])), undefined, '126 长度字段只到一半')
  assert.equal(parseFrame(Buffer.from([0x81, 0x7f, 0, 0, 0, 0, 0, 0, 0, 1])), undefined, '127 头完整但负载缺失')
  assert.equal(parseFrame(Buffer.from([0x81, 0x05, 0x61, 0x62])), undefined, '7bit 声明 5 字节但只给 2 字节')
  assert.equal(parseFrame(Buffer.from([0x81, 0x82, 0x01, 0x02])), undefined, '掩码键不足 4 字节')
  assert.equal(parseFrame(Buffer.concat([manualHead, manualCipher.subarray(0, 4)])), undefined, '掩码帧负载少 1 字节')

  // 超 maxPayload / 超安全整数 → RangeError（不是 undefined，也不是静默丢弃）
  assert.throws(
    () => parseFrame(encodeFrame(WS_OPCODE.text, '123456', { mask: false }), 5),
    (error) => error instanceof RangeError && /too large: 6 > 5/.test(error.message),
    '超 maxPayload 抛 RangeError',
  )
  assert.throws(() => parseFrame(Buffer.from([0x81, 0x7e, 0x01, 0x00]), 100), /too large: 256 > 100/, '16bit 声明长度同样受限')
  assert.throws(
    () => parseFrame(Buffer.concat([Buffer.from([0x82, 0x7f]), Buffer.alloc(8, 0xff)])),
    /exceeds Number.MAX_SAFE_INTEGER/,
    '64bit 长度超出安全整数',
  )

  // ── 3. 任务流事件容错解析 ──
  assert.deepEqual(parseTaskStreamEvent('{"type":"done"}'), { kind: 'done' })
  assert.deepEqual(parseTaskStreamEvent('{"type":"finish"}'), { kind: 'done' })
  assert.deepEqual(parseTaskStreamEvent('{"type":"completed"}'), { kind: 'done' })
  assert.deepEqual(parseTaskStreamEvent('{"type":"DONE"}'), { kind: 'done' }, '类型大小写不敏感')
  assert.deepEqual(parseTaskStreamEvent('{"type":"error","message":"boom"}'), { kind: 'error', message: 'boom' })
  assert.deepEqual(parseTaskStreamEvent('{"type":"error","error":{"message":"deep"}}'), { kind: 'error', message: 'deep' }, '嵌套错误对象')
  assert.deepEqual(parseTaskStreamEvent('{"type":"abort"}'), { kind: 'error', message: '上游返回 abort 事件' }, '无消息时给兜底文案')
  assert.deepEqual(parseTaskStreamEvent('{"type":"abort","reason":"用户取消"}'), { kind: 'error', message: '用户取消' })

  assert.deepEqual(parseTaskStreamEvent('{"type":"text","content":"hi"}'), { kind: 'text', text: 'hi' })
  assert.deepEqual(parseTaskStreamEvent('{"type":"delta","delta":"abc"}'), { kind: 'text', text: 'abc' })
  assert.deepEqual(parseTaskStreamEvent('{"type":"content","text":"yo"}'), { kind: 'text', text: 'yo' })
  assert.deepEqual(parseTaskStreamEvent('{"type":"message","message":"m"}'), { kind: 'text', text: 'm' })
  assert.deepEqual(parseTaskStreamEvent('{"type":"round","content":{"text":"nested"}}'), { kind: 'text', text: 'nested' }, '正文可再套一层对象')
  assert.deepEqual(parseTaskStreamEvent('{"type":"delta","data":{"content":"enveloped"}}'), { kind: 'text', text: 'enveloped' }, '正文可套在 data 里')
  assert.deepEqual(parseTaskStreamEvent('{"event":"text","content":"ev"}'), { kind: 'text', text: 'ev' }, 'type 缺失时认 event')
  assert.deepEqual(parseTaskStreamEvent('{"kind":"error","message":"kd"}'), { kind: 'error', message: 'kd' }, 'type 缺失时认 kind')

  // 无 type 但直接带正文：仍然收下
  assert.deepEqual(parseTaskStreamEvent('{"content":"loose"}'), { kind: 'text', text: 'loose' })
  assert.deepEqual(parseTaskStreamEvent('{"message":"loose"}'), { kind: 'text', text: 'loose' })
  assert.deepEqual(parseTaskStreamEvent('{"data":{"content":"deep"}}'), { kind: 'text', text: 'deep' })
  assert.deepEqual(parseTaskStreamEvent('{"foo":1}'), { kind: 'ignore' }, '无 type 且无正文 → ignore')

  // 认不出的 type 一律 ignore（不能当 error 中断整轮对话）
  assert.deepEqual(parseTaskStreamEvent('{"type":"heartbeat"}'), { kind: 'ignore' })
  assert.deepEqual(parseTaskStreamEvent('{"type":"whatever","content":"x"}'), { kind: 'ignore' }, '未知类型即使带正文也忽略')
  assert.deepEqual(parseTaskStreamEvent('{"type":"text"}'), { kind: 'ignore' }, 'text 类型但正文缺失')
  assert.deepEqual(parseTaskStreamEvent('{"type":"text","content":""}'), { kind: 'ignore' }, '空正文不算正文')

  // 非法输入不抛错
  assert.deepEqual(parseTaskStreamEvent('not json'), { kind: 'ignore' })
  assert.deepEqual(parseTaskStreamEvent(''), { kind: 'ignore' })
  assert.deepEqual(parseTaskStreamEvent('   '), { kind: 'ignore' })
  assert.deepEqual(parseTaskStreamEvent('123'), { kind: 'ignore' }, '非对象 JSON')
  assert.deepEqual(parseTaskStreamEvent('[1,2]'), { kind: 'ignore' })
  assert.deepEqual(parseTaskStreamEvent('null'), { kind: 'ignore' })

  // Buffer 输入（二进制帧内容）同样能解析
  assert.deepEqual(parseTaskStreamEvent(Buffer.from('{"type":"text","content":"buf"}')), { kind: 'text', text: 'buf' })
  assert.deepEqual(parseTaskStreamEvent(Buffer.from([0xff, 0xfe, 0x00])), { kind: 'ignore' }, '非法 UTF-8 二进制')

  // ── 4. 真实连接：本地 node:http 假上游 ──
  const fixture = { keys: [], headers: undefined, rawClient: Buffer.alloc(0), pending: Buffer.alloc(0), frames: [], sockets: [], pong: undefined, resolvePong: undefined }
  const pongArrived = new Promise((resolve) => { fixture.resolvePong = resolve })

  const upstream = http.createServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('upgrade required')
  })
  const down = (socket, opcode, payload) => socket.write(encodeFrame(opcode, payload, { mask: false }))
  const serve = async (socket) => {
    down(socket, WS_OPCODE.text, 'hello')
    // 126 扩展长度帧故意拆成两次 TCP 写：客户端必须先因数据不足而等待
    const medium = encodeFrame(WS_OPCODE.text, 'm'.repeat(200), { mask: false })
    socket.write(medium.subarray(0, 3))
    await delay(30)
    socket.write(medium.subarray(3))
    down(socket, WS_OPCODE.binary, Buffer.from(JSON.stringify({ type: 'text', content: 'bin-body' })))
    down(socket, WS_OPCODE.ping, 'p')
    await Promise.race([pongArrived, delay(1500)]) // 兜底，避免测试挂死
    down(socket, WS_OPCODE.text, 'after-pong')
    const closeCode = Buffer.alloc(2)
    closeCode.writeUInt16BE(1000, 0)
    down(socket, WS_OPCODE.close, closeCode)
    await delay(50)
    socket.end()
  }
  upstream.on('upgrade', (req, socket) => {
    const key = String(req.headers['sec-websocket-key'] ?? '')
    fixture.keys.push(key)
    fixture.headers = req.headers
    fixture.sockets.push(socket)
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${wsAcceptKey(key)}\r\n\r\n`,
    )
    socket.on('error', () => { /* 客户端断开 */ })
    socket.on('data', (chunk) => {
      fixture.rawClient = Buffer.concat([fixture.rawClient, chunk])
      fixture.pending = Buffer.concat([fixture.pending, chunk])
      let parsed
      while ((parsed = parseFrame(fixture.pending)) !== undefined) {
        fixture.pending = fixture.pending.subarray(parsed.consumed)
        fixture.frames.push(parsed.frame)
        if (parsed.frame.opcode === WS_OPCODE.pong) {
          fixture.pong = parsed.frame.payload.toString('utf8')
          fixture.resolvePong?.()
        }
      }
    })
    void serve(socket)
  })

  const upstreamAddress = await listen(upstream)
  let client
  try {
    client = await openWebSocket(`ws://${upstreamAddress}/api/v1/users/tasks/stream?task=1`, {
      headers: { 'X-Test-Token': 'ws-test' },
      handshakeTimeoutMs: 5000,
      idleTimeoutMs: 5000,
    })
    assert.ok(client instanceof MonkeyCodeWsClient, 'openWebSocket 返回 MonkeyCodeWsClient 实例')

    const messages = []
    for await (const message of client.messages()) messages.push(message)

    // 握手请求确实按 RFC 6455 发
    assert.equal(Buffer.from(fixture.keys[0], 'base64').length, 16, '客户端 Sec-WebSocket-Key 是 16 字节随机数')
    assert.equal(String(fixture.headers['sec-websocket-version']), '13')
    assert.equal(String(fixture.headers.upgrade).toLowerCase(), 'websocket')
    assert.equal(String(fixture.headers.connection).toLowerCase(), 'upgrade')
    assert.equal(fixture.headers['x-test-token'], 'ws-test', '自定义头透传')

    // 下行帧顺序：text / 拆包的 126 长帧 / binary / ping(吞掉) / text / close
    assert.deepEqual(
      messages.map((message) => message.opcode),
      [WS_OPCODE.text, WS_OPCODE.text, WS_OPCODE.binary, WS_OPCODE.text],
      'ping 与 close 不进业务消息',
    )
    assert.equal(messages[0].text, 'hello')
    assert.equal(messages[1].text, 'm'.repeat(200), '126 扩展长度帧跨 TCP 分包后仍完整')
    assert.equal(messages[2].text, '{"type":"text","content":"bin-body"}', 'binary 帧按 UTF-8 解出')
    assert.equal(messages[3].text, 'after-pong')

    // ping → pong 回带原负载；客户端帧必须掩码
    assert.equal(fixture.pong, 'p', '收到 ping 必须回带原负载的 pong')
    assert.equal(fixture.rawClient[0] & 0x0f, WS_OPCODE.pong, '客户端首发帧是 pong')
    assert.equal((fixture.rawClient[1] & 0x80) !== 0, true, '客户端帧必须置掩码位（RFC 6455 §5.3）')

    // close → 回 close 并结束迭代
    // ⚠️ 必须等回复真正到达：客户端的 close 回复是异步刷出的（socket.write 只是
    // 排队 → libuv flush → loopback 传输 → 服务端 data 事件），for-await 一返回
    // 就断言会撞上竞态。ping→pong 之所以稳定，是因为 fixture 显式 await 了
    // pongArrived；close 没有对应的等待点，这里轮询补上同一保证。
    const deadline = Date.now() + 1500
    let closeFrame
    while (Date.now() < deadline) {
      closeFrame = fixture.frames.find((frame) => frame.opcode === WS_OPCODE.close)
      if (closeFrame !== undefined) break
      await delay(10)
    }
    assert.ok(closeFrame, '客户端收到 close 后回 close')
    assert.equal(closeFrame.payload.readUInt16BE(0), 1000, 'close code 1000')

    // 二进制帧内容可直接喂给事件解析
    assert.deepEqual(parseTaskStreamEvent(messages[2].data), { kind: 'text', text: 'bin-body' })
  } finally {
    client?.close()
    await closeServer(upstream, fixture.sockets)
  }

  // 非 101（400）→ WsHandshakeError，带 HTTP 状态
  const rejecting = http.createServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('no upgrade here')
  })
  const rejectingAddress = await listen(rejecting)
  try {
    await assert.rejects(
      () => openWebSocket(`ws://${rejectingAddress}/api/v1/users/tasks/stream`),
      (error) => error instanceof WsHandshakeError && error.status === 400 && /HTTP 400/.test(error.message),
      '非 101 必须抛 WsHandshakeError',
    )
  } finally {
    await closeServer(rejecting)
  }

  // Accept 被改写 → 拒绝（中间人防护）
  const liar = http.createServer((req, res) => { res.writeHead(400).end() })
  liar.on('upgrade', (req, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + 'Sec-WebSocket-Accept: not-the-right-hash\r\n\r\n',
    )
    socket.destroy()
  })
  const liarAddress = await listen(liar)
  try {
    await assert.rejects(
      () => openWebSocket(`ws://${liarAddress}/`),
      (error) => error instanceof WsHandshakeError && /Accept mismatch/.test(error.message),
      'Accept 不匹配必须拒绝',
    )
  } finally {
    await closeServer(liar)
  }

  // 地址/协议校验
  await assert.rejects(() => openWebSocket('not a url'), /invalid url/)
  await assert.rejects(() => openWebSocket('ftp://x/y'), /unsupported protocol/)

  console.log('ok  monkeycode-ws: 握手向量/key/URL 映射、7bit·16bit·64bit 长度与长度边界、掩码循环 XOR、数据不足返回 undefined、超限抛 RangeError、粘包推进、事件容错（done/error/text/无 type/非法 JSON/未知 type 一律 ignore）、本地假上游真实连接（拆包、ping→pong、close 收尾、400 与非 101 抛 WsHandshakeError）')
}

export async function verifyMonkeyCodeWs() { await main() }
