/** Command Code 登录流程端到端：本地回调服务器 + 假上游，不出网。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href

/**
 * 独立运行时把源码里的 `./x.js` 解析成 `./x.ts`。
 *
 * 源码用 NodeNext 约定写扩展名（`./commandcode-product.js`），而这里直接
 * import `.ts`；不注册钩子就会 `ERR_MODULE_NOT_FOUND`。channel-pack-test 的
 * source 模式注册的是同一套映射（那边还要 ts.transpileModule，因为它的入口
 * `src/index.ts` 用了 Node strip-only 不接受的语法；本文件的两个依赖只用类型
 * 注解，strip-only 足够）。
 *
 * 被 channel-pack-test import 时**不**注册（钩子已由调用方装好）。
 */
function isDirectRun() {
  return process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
}

function installSourceResolution() {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.startsWith(sourceRoot) && specifier.endsWith('.js')) {
        const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
        if (fs.existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
  })
}

async function main() {
  const {
    startCommandCodeLogin, validateApiKey, resolveCredential,
    fetchCredits, fetchModelCatalog, COMMANDCODE_CALLBACK_PATH,
    bindLoopbackPort, listenOnPortRange, listenForCallbackPort,
  } = await import('../vendor/channel-pack/src/commandcode-auth.ts')
  const {
    COMMANDCODE, COMMANDCODE_LOGIN_START_PORT, COMMANDCODE_LOGIN_MAX_PORT_ATTEMPTS,
  } = await import('../vendor/channel-pack/src/commandcode-product.ts')
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

    // ── 端口退避：官方段全占时仍能拿到回调端口（本缺陷的回归用例）──
    //
    // 真实故障场景：用户同时开着官方 `command-code` CLI（5959 起 10 个）或先登录了
    // accio（5960–5969），官方段全被占，原实现直接抛「端口全部被占用」，「添加账号」
    // 在那台机器上完全不可用。
    //
    // 测试不真去占 5959–5968（那会与用户正在跑的官方 CLI 抢端口，结果取决于机器
    // 现状），而是用 `portRange` 注入一段**自己占住**的连续端口，断言：
    //   1. 段内全占 → `listenOnPortRange` 返回 undefined（不抛，把「段内失败」和
    //      「彻底失败」拆开，调用方才能决定回退）；
    //   2. `listenForCallbackPort` 退到随机回环端口，且**实际能连**（不是只返回了
    //      一个数字）；
    //   3. `startCommandCodeLogin` 端到端仍能完成登录，`loginUrl` 的 `callback=`
    //      用的是**实际**端口 —— 这正是回退安全的前提；
    //   4. 段内还有空位时仍优先用段内端口（回退不能变成默认路径）。

    /** 占住 `count` 个**连续**回环端口；返回 `{ base, close }`。 */
    async function occupyContiguous(count) {
      const closeAll = async (servers) => {
        for (const server of servers) {
          server.closeAllConnections?.()
          await new Promise(resolve => server.close(() => resolve()))
        }
      }
      for (let attempt = 0; attempt < 60; attempt++) {
        const servers = []
        const seed = http.createServer()
        const seedOk = await new Promise(resolve => {
          seed.once('error', () => resolve(false))
          seed.once('listening', () => resolve(true))
          seed.listen(0, '127.0.0.1')
        })
        if (!seedOk) continue
        servers.push(seed)
        const base = seed.address().port
        let ok = base + count <= 65_535
        for (let offset = 1; ok && offset < count; offset++) {
          const server = http.createServer()
          const bound = await new Promise(resolve => {
            server.once('error', () => resolve(false))
            server.once('listening', () => resolve(true))
            server.listen(base + offset, '127.0.0.1')
          })
          servers.push(server)
          ok = bound
        }
        if (ok) return { base, close: () => closeAll(servers) }
        await closeAll(servers)
      }
      throw new Error('无法占住连续端口段（本机回环端口过于拥挤）')
    }

    const held = await occupyContiguous(3)
    try {
      // 1) 段内全占 → 返回 undefined，且每个候选端口都留下明细。
      const rangeProbe = http.createServer()
      const rangeErrors = []
      const none = await listenOnPortRange(rangeProbe, held.base, 3, rangeErrors)
      assert.equal(none, undefined, '段内全占时 listenOnPortRange 必须返回 undefined（不抛）')
      assert.equal(rangeErrors.length, 3, '每个候选端口都要记录失败明细')
      assert.ok(rangeErrors.every(line => /EADDRINUSE/.test(line)), `明细应说明端口被占用：${rangeErrors.join('; ')}`)

      // 2) 回退到随机回环端口，且端口真的可连。
      // 探针服务器必须带 request 处理器：没有 'request' 监听的 http.Server 会让
      // 连接一直挂着（表现为「无响应」），那样这条断言验的就不是「在监听」了。
      const fallbackProbe = http.createServer((_req, res) => {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('probe')
      })
      const fallback = await listenForCallbackPort(fallbackProbe, held.base, 3)
      try {
        assert.equal(fallback.fallback, true, '段内全占必须走随机回退')
        assert.ok(
          fallback.port < held.base || fallback.port > held.base + 2,
          `回退端口不能落在被占段内：${fallback.port} vs ${held.base}-${held.base + 2}`,
        )
        const reachable = await new Promise((resolve, reject) => {
          const req = http.request({ host: '127.0.0.1', port: fallback.port, path: '/', method: 'GET', timeout: 2000 }, res => {
            res.resume()
            resolve(res.statusCode)
          })
          req.on('timeout', () => { req.destroy(); reject(new Error('回退端口无响应')) })
          req.on('error', reject)
          req.end()
        })
        assert.equal(reachable, 404, '回退端口上的服务器必须真的在监听（未知路径 404）')
      } finally {
        fallbackProbe.closeAllConnections?.()
        await new Promise(resolve => fallbackProbe.close(() => resolve()))
      }

      // 3) 端到端：注入被占满的段，登录流程仍能完成，callback 用实际端口。
      const fallbackLogin = await startCommandCodeLogin({
        product, fetcher: realFetch, timeoutMs: 5000,
        portRange: { startPort: held.base, attempts: 3 },
      })
      try {
        assert.equal(fallbackLogin.portFallback, true, '段内全占时 startCommandCodeLogin 必须标记回退')
        assert.ok(
          fallbackLogin.port < held.base || fallbackLogin.port > held.base + 2,
          '回退端口不能落在被占段内',
        )
        const url = new URL(fallbackLogin.loginUrl)
        assert.equal(
          url.searchParams.get('callback'),
          `http://127.0.0.1:${fallbackLogin.port}/callback`,
          'callback 必须用**实际**端口拼（否则 Studio 会回跳到没人监听的地址）',
        )
        const state = url.searchParams.get('state')
        const status = await new Promise((resolve, reject) => {
          const req = http.request(`http://127.0.0.1:${fallbackLogin.port}${COMMANDCODE_CALLBACK_PATH}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' },
          }, res => { res.resume(); resolve(res.statusCode) })
          req.on('error', reject)
          req.end(JSON.stringify({ apiKey: 'good-key', state, userId: 'u-1', userName: 'alice', keyName: 'cli' }))
        })
        assert.equal(status, 200, '回退端口上的回调必须能完成登录')
        const { credential, port } = await fallbackLogin.result
        assert.equal(credential.access_token, 'good-key')
        assert.equal(port, fallbackLogin.port, '结果里的端口与实际监听一致')
      } finally {
        await fallbackLogin.close()
      }

      // 4) 段内还有空位时优先用段内端口：回退不能变成默认路径。
      const partlyHeld = await occupyContiguous(1)
      try {
        const ranged = await startCommandCodeLogin({
          product, fetcher: realFetch, timeoutMs: 5000,
          portRange: { startPort: partlyHeld.base, attempts: 3 },
        })
        try {
          assert.equal(ranged.portFallback, false, '段内有空位时不得回退')
          assert.ok(
            ranged.port > partlyHeld.base && ranged.port <= partlyHeld.base + 2,
            `应顺延到段内空位：${ranged.port} vs ${partlyHeld.base}+1..+2`,
          )
        } finally {
          await ranged.close()
        }
      } finally {
        await partlyHeld.close()
      }
    } finally {
      await held.close()
    }

    // 官方段常量本身没被改动（回退是兜底，不是替换）。
    assert.equal(COMMANDCODE_LOGIN_START_PORT, 5959)
    assert.equal(COMMANDCODE_LOGIN_MAX_PORT_ATTEMPTS, 10)

    // 端口 0 的请求端口不是绑定端口：bindLoopbackPort 必须回报实际端口。
    const zeroProbe = http.createServer()
    const zero = await bindLoopbackPort(zeroProbe, 0)
    assert.equal(zero.ok, true, '随机端口必须绑定成功')
    assert.ok(zero.port > 0, `bindLoopbackPort(0) 必须回报系统分配的实际端口，得到 ${zero.port}`)
    zeroProbe.closeAllConnections?.()
    await new Promise(resolve => zeroProbe.close(() => resolve()))

    console.log('ok  commandcode-auth: whoami 三态、credits/models 拉取、回调 state 校验、无效 Key 拒绝、超时、完整登录闭环、端口段全占时退随机回环端口')
  } finally {
    // keep-alive 连接会让 close() 一直等，先强制断开。
    upstream.closeAllConnections?.()
    await new Promise(resolve => upstream.close(resolve))
  }
}

export async function verifyCommandCodeAuth() {
  await main()
}

// 直接 `node scripts/commandcode-auth-test.mjs` 时也要真的跑断言：
// 只导出 `verifyCommandCodeAuth` 会让这个文件在命令行下静默退出 0（假绿）。
// 被 channel-pack-test 以 source 模式 import 时钩子已就绪，跳过安装。
if (isDirectRun()) {
  installSourceResolution()
  await main()
}
