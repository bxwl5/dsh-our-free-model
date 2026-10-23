#!/usr/bin/env node
/**
 * KukuAI 扫码登录的**独立自测工具** —— 默认不联网、不扫码、不写凭据。
 *
 * 目的：把 `vendor/channel-pack/src/kuku-qr-login.ts` 的协议三步（取码 → 轮询 →
 * 换会话）用**本地假上游**钉死，这样接线（RPC / UI）之前就能确认模块本身是对的，
 * 真机调试只需要验证「上游还认这套参数」，不必同时怀疑自己的解析逻辑。
 *
 * 用法：
 *   node scripts/kuku-qr-selftest.mjs            # 本地假上游跑通全链（默认，不联网）
 *   node scripts/kuku-qr-selftest.mjs --live     # ⚠️ 真连 passport **取码**（只读，不扫码）
 *
 * `--live` 只做 `getqrcode`（+ 取图）：这两个接口不需要任何凭据、也不产生登录态。
 * 它**不会**轮询到成功（那需要人真的扫码），也不写任何凭据文件。
 *
 * 协议来源：
 *   IKUNHEIHIE/kuku2api@main src/passport.mjs（MIT）—— 取码/轮询/bdusslogin/STOKEN 交换
 * 本项目侧的结论与风险见 项目文件/research/paste-login-feasibility.md §3.2。
 */
import { createServer } from 'node:http'
import { registerHooks } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href

/**
 * 让源码里的 `./x.js` 解析到 `./x.ts`。
 *
 * 模块按 NodeNext 约定写扩展名（`import … from './kuku.js'`），而这里直接 import
 * `.ts`；不装钩子就是 `ERR_MODULE_NOT_FOUND`。
 *
 * **无条件注册**（不按「是否直接执行」门控）：这个文件既可以 `node` 直接跑，也可以
 * 被测试套件 `import { verifyKukuQrSelftest }` 复用，两条路径都需要映射。
 * `registerHooks` 是链式的（解析不了就 `nextResolve` 继续往下传），重复注册无害 ——
 * 先前按「直接执行」门控的结果是：被 import 时报 `Cannot find module …/kuku.js`。
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.endsWith('.js')) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
      if (fs.existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

/**
 * 是否被 `node scripts/kuku-qr-selftest.mjs` 直接执行。
 *
 * 用 `pathToFileURL` 而不是手拼 `file://` 前缀：路径里有中文、空格或 Windows
 * 盘符时手拼会得到错误 URL。只用来决定「跑不跑 main」，与钩子无关。
 */
const isDirectRun = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

/** 一张 1×1 的合法 PNG（假上游用它当二维码图片）。 */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** 假 ticket（32 字符 hex，形状与上游一致；**不是**真实凭据）。 */
const FAKE_TICKET = 'a'.repeat(32)
/** 假 BDUSS（192 字符，与实测长度一致；**不是**真实凭据）。 */
const FAKE_BDUSS = `fake${'b'.repeat(188)}`
/** 假 PTOKEN。 */
const FAKE_PTOKEN = `fake${'c'.repeat(60)}`
/** 假 STOKEN。 */
const FAKE_STOKEN = `fake${'d'.repeat(60)}`

/**
 * 假上游：按 passport 的真实形状应答，并记录收到的每个请求。
 *
 * `script` 控制 `/channel/unicast` 的状态序列，用来分别验证 pending / scanned /
 * confirmed / expired 四条路径。
 */
export function createFakePassport(script) {
  const seen = []
  const state = { polls: 0, qrImageCalls: 0 }
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const record = {
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      cookie: request.headers.cookie ?? '',
      referer: request.headers.referer ?? '',
      userAgent: request.headers['user-agent'] ?? '',
      method: request.method ?? 'GET',
      body: '',
    }
    let raw = ''
    request.on('data', (chunk) => { raw += chunk })
    request.on('end', () => {
      record.body = raw
      seen.push(record)
      const jsonp = url.searchParams.get('callback')
      const send = (payload, { headers = {}, status = 200 } = {}) => {
        const text = jsonp === null ? JSON.stringify(payload) : `${jsonp}(${JSON.stringify(payload)});`
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
        response.end(text)
      }

      if (url.pathname === '/v2/api/getqrcode') {
        // 真实上游在没有设备 Cookie 时也会先发 BAIDUID；这里照做，用来验证罐子吸收。
        return send(
          { errno: 0, sign: 'selftest-sign-0001', imgurl: `${url.host}/v2/api/qrcode?sign=selftest-sign-0001`, prompt: '请使用百度 App 扫码' },
          { headers: { 'set-cookie': ['BAIDUID=SELFTEST_BAIDUID:FG=1; Path=/', 'PTOKEN_DEV=1; Path=/'] } },
        )
      }

      if (url.pathname === '/v2/api/qrcode') {
        state.qrImageCalls += 1
        // ⚠️ 真实上游**第一次取图可能是 0 字节**（实测）；假上游照样复现，
        // 这样「重试」这条分支是被真的跑过的，而不是只写在注释里。
        const body = state.qrImageCalls === 1 ? Buffer.alloc(0) : PNG_1PX
        response.writeHead(200, { 'content-type': 'image/png' })
        return response.end(body)
      }

      if (url.pathname === '/channel/unicast') {
        if (url.searchParams.get('channel_id') !== 'selftest-sign-0001') {
          return send({ errno: 2, msg: 'unknown channel' })
        }
        const step = script[Math.min(state.polls, script.length - 1)]
        state.polls += 1
        if (step === 'pending') return send({ errno: 1 })
        if (step === 'scanned') return send({ errno: 0, channel_v: JSON.stringify({ status: '1' }) })
        if (step === 'expired') return send({ errno: 0, channel_v: JSON.stringify({ status: '2' }) })
        // confirmed：channel_v 是**字符串化**对象，v 是 32 位 ticket。
        return send({ errno: 0, channel_v: JSON.stringify({ status: '0', v: FAKE_TICKET, u: 'https://kuku.baidu.com' }) })
      }

      if (url.pathname === '/v2/api/bdusslogin') {
        if (url.searchParams.get('bduss') !== FAKE_TICKET) {
          return send({ errno: -9999, msg: 'invalid ticket' })
        }
        // ⚠️ 成功响应**没有 errno 字段** —— 这是本模块最容易写错的一处，
        // 假上游必须照这个形状来，否则测不出「errno === 0 判失败」那个缺陷。
        return send(
          { data: { u: 'https://kuku.baidu.com' }, errInfo: {} },
          {
            headers: {
              'set-cookie': [
                `BDUSS=${FAKE_BDUSS}; Path=/; HttpOnly`,
                `PTOKEN=${FAKE_PTOKEN}; Path=/; HttpOnly`,
                // 账号作用域：应当进凭据串（真实 /wenchain 调用需要它）。
                `STOKEN=${FAKE_STOKEN}; Path=/; HttpOnly`,
                // 设备作用域：**不该**进凭据串（凭据会落盘，多带字段只是多一份泄露面）。
                'BAIDUID=SELFTEST_DEVICE:FG=1; Path=/',
                'H_PS_UID=selftest-device-uid; Path=/',
              ],
            },
          },
        )
      }

      if (url.pathname === '/v3/login/api/auth') {
        const form = new URLSearchParams(raw)
        if (form.get('bduss') !== FAKE_BDUSS || form.get('ptoken') !== FAKE_PTOKEN) {
          return send({ errno: 110003, errmsg: 'sign error' })
        }
        if (typeof form.get('sig') !== 'string' || (form.get('sig') ?? '').length !== 32) {
          return send({ errno: 110003, errmsg: 'missing sig' })
        }
        return send({ errno: 0, stoken_list: { genflowpro: FAKE_STOKEN } })
      }

      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html>not found</html>')
    })
  })
  return { server, seen, state }
}

/** 起假上游并返回基址。 */
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('假上游未能获得端口')
  return `http://127.0.0.1:${address.port}`
}

/** 断言助手：失败时带上说明。 */
function check(condition, message) {
  if (!condition) throw new Error(message)
}

/** 走完一条完整的扫码链，返回每个阶段的观察值。 */
async function walkFullChain(mod, base, script) {
  const fake = createFakePassport(script)
  const origin = await listen(fake.server)
  try {
    // 1) 取码
    const session = await mod.requestKukuQrCode({ passportBase: origin })
    check(session.sign === 'selftest-sign-0001', `取码 sign 不符：${session.sign}`)
    check(session.prompt === '请使用百度 App 扫码', '取码未带回 prompt')
    check(session.imageUrl.includes('selftest-sign-0001'), `imageUrl 未带 sign：${session.imageUrl}`)
    check(session.jar.get('BAIDUID') === 'SELFTEST_BAIDUID:FG=1', '罐子未吸收 BAIDUID')
    check(session.createdAt > 0, 'createdAt 未设置')

    // 2) 取图：第一次 0 字节必须被重试掉
    const image = await mod.fetchKukuQrImage(session, { passportBase: origin })
    check(image.bytes === PNG_1PX.length, `取图字节数不符：${image.bytes}`)
    check(image.dataUrl.startsWith('data:image/png;base64,'), `data URL 形状不符：${image.dataUrl.slice(0, 40)}`)
    check(fake.state.qrImageCalls === 2, `取图应重试一次（0 字节 → 有图），实际调用 ${fake.state.qrImageCalls} 次`)

    // 3) 轮询到 confirmed
    const states = []
    let ticket
    for (let attempt = 0; attempt < 8; attempt++) {
      const polled = await mod.pollKukuQrStatus(session, { passportBase: origin })
      states.push(polled.state)
      if (polled.state === 'confirmed') { ticket = polled.ticket; break }
    }
    check(ticket === FAKE_TICKET, `轮询未拿到 ticket（状态序列 ${states.join('→')}）`)

    // 4) 换会话 + STOKEN
    const result = await mod.completeKukuQrLogin(session, ticket, { passportBase: origin })
    check(result.stoken === FAKE_STOKEN, `STOKEN 未换到：${result.stoken}`)
    check(result.warnings.length === 0, `不应有 warning：${result.warnings.join('; ')}`)
    check(result.credential.access_token.includes(`BDUSS=${FAKE_BDUSS}`), '凭据里没有 BDUSS')
    check(result.credential.access_token.includes(`PTOKEN=${FAKE_PTOKEN}`), '凭据里没有 PTOKEN')
    // STOKEN 是**账号作用域**（真实 /wenchain 调用需要），必须进凭据串。
    check(result.credential.access_token.includes(`STOKEN=${FAKE_STOKEN}`), '凭据里没有 STOKEN')
    // 设备作用域 Cookie **不该**进凭据串：凭据会落盘，多带字段只是多一份泄露面。
    check(!result.credential.access_token.includes('BAIDUID'), '凭据串不应包含 BAIDUID')
    check(!result.credential.access_token.includes('H_PS_UID'), '凭据串不应包含设备 Cookie H_PS_UID')
    check(typeof result.credential.created_at === 'number', 'created_at 未设置')

    return { session, states, ticket, result, seen: fake.seen, image }
  } finally {
    fake.server.closeAllConnections?.()
    await new Promise((resolve) => fake.server.close(resolve))
  }
}

/** 本地假上游全链自测。 */
async function selftest() {
  const mod = await import('../vendor/channel-pack/src/kuku-qr-login.ts')

  // ── ① 全链：pending → scanned → confirmed ──
  const full = await walkFullChain(mod, '', ['pending', 'pending', 'scanned', 'confirmed'])
  check(
    full.states.join('→') === 'pending→pending→scanned→confirmed',
    `状态序列不符：${full.states.join('→')}`,
  )
  console.log(`ok 1 全链 pending→scanned→confirmed：取图重试 1 次、ticket→BDUSS/PTOKEN→STOKEN 全部打通`)

  // ── ② 过期分支：status "2" → expired ──
  {
    const fake = createFakePassport(['expired'])
    const origin = await listen(fake.server)
    try {
      const session = await mod.requestKukuQrCode({ passportBase: origin })
      const polled = await mod.pollKukuQrStatus(session, { passportBase: origin })
      check(polled.state === 'expired', `过期未被识别：${polled.state}`)
      check(polled.ticket === undefined, '过期不应带 ticket')
      check(polled.probe.status === '2', `probe.status 应为 "2"，实际 ${polled.probe.status}`)
    } finally {
      fake.server.closeAllConnections?.()
      await new Promise((resolve) => fake.server.close(resolve))
    }
  }
  console.log('ok 2 过期分支：status "2" → expired，且不带 ticket')

  // ── ③ errno:1 是「还没扫」，不是错误 ──
  {
    const fake = createFakePassport(['pending'])
    const origin = await listen(fake.server)
    try {
      const session = await mod.requestKukuQrCode({ passportBase: origin })
      const polled = await mod.pollKukuQrStatus(session, { passportBase: origin })
      check(polled.state === 'pending', `errno:1 应映射 pending，实际 ${polled.state}`)
      check(polled.probe.errno === 1, `probe.errno 应为 1，实际 ${polled.probe.errno}`)
    } finally {
      fake.server.closeAllConnections?.()
      await new Promise((resolve) => fake.server.close(resolve))
    }
  }
  console.log('ok 3 未扫码：上游常态 { errno: 1 } 映射 pending（不是错误）')

  // ── ④ bdusslogin 成功判据是「没有 errno」，不是 errno === 0 ──
  {
    const fake = createFakePassport(['confirmed'])
    const origin = await listen(fake.server)
    try {
      const session = await mod.requestKukuQrCode({ passportBase: origin })
      const polled = await mod.pollKukuQrStatus(session, { passportBase: origin })
      check(polled.state === 'confirmed', `确认状态未识别：${polled.state}`)
      const result = await mod.completeKukuQrLogin(session, polled.ticket ?? '', { passportBase: origin })
      // 假上游的成功响应是 { data, errInfo } —— 完全不带 errno。
      // 写成 `errno === 0` 的实现在这里会抛 bduss_login_refused。
      check(result.credential.access_token.includes(FAKE_BDUSS), '无 errno 的成功响应被误判为失败')
    } finally {
      fake.server.closeAllConnections?.()
      await new Promise((resolve) => fake.server.close(resolve))
    }
  }
  console.log('ok 4 bdusslogin 成功响应无 errno 字段也能通过（防「errno===0」误判）')

  // ── ⑤ 假 ticket → bduss_login_refused（-9999），且错误信息不含 ticket ──
  {
    const fake = createFakePassport(['confirmed'])
    const origin = await listen(fake.server)
    try {
      const session = await mod.requestKukuQrCode({ passportBase: origin })
      let error
      try {
        await mod.completeKukuQrLogin(session, 'f'.repeat(32), { passportBase: origin })
      } catch (caught) {
        error = caught
      }
      check(error !== undefined, '假 ticket 必须抛错')
      check(error instanceof mod.KukuQrError, `错误类型不符：${error?.constructor?.name}`)
      check(error.code === 'bduss_login_refused', `错误码不符：${error.code}`)
      check(error.errno === -9999, `errno 未带出：${error.errno}`)
      check(!error.message.includes('f'.repeat(32)), '错误信息不应回显 ticket（会进日志/UI）')
    } finally {
      fake.server.closeAllConnections?.()
      await new Promise((resolve) => fake.server.close(resolve))
    }
  }
  console.log('ok 5 假 ticket → bduss_login_refused(-9999)，错误信息不回显 ticket')

  // ── ⑥ STOKEN 交换失败默认不致命；requireStoken 时抛 ──
  {
    const fake = createFakePassport(['confirmed'])
    // 让 STOKEN 交换腿永远拒绝。
    const original = fake.server.listeners('request')[0]
    fake.server.removeAllListeners('request')
    fake.server.on('request', (request, response) => {
      if ((request.url ?? '').startsWith('/v3/login/api/auth')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        return response.end(JSON.stringify({ errno: 110003, errmsg: 'sign error' }))
      }
      original(request, response)
    })
    const origin = await listen(fake.server)
    try {
      const session = await mod.requestKukuQrCode({ passportBase: origin })
      const polled = await mod.pollKukuQrStatus(session, { passportBase: origin })
      const lenient = await mod.completeKukuQrLogin(session, polled.ticket ?? '', { passportBase: origin })
      check(lenient.stoken === undefined, 'STOKEN 交换失败时不应有 stoken')
      check(lenient.warnings.length === 1, `应恰好 1 条 warning，实际 ${lenient.warnings.length}`)
      check(lenient.warnings[0].includes('STOKEN'), `warning 未说明 STOKEN：${lenient.warnings[0]}`)
      check(lenient.credential.access_token.includes(FAKE_BDUSS), 'STOKEN 失败不应影响 BDUSS 凭据')

      // requireStoken: true 时同样的失败必须抛。
      const session2 = await mod.requestKukuQrCode({ passportBase: origin })
      const polled2 = await mod.pollKukuQrStatus(session2, { passportBase: origin })
      let error
      try {
        await mod.completeKukuQrLogin(session2, polled2.ticket ?? '', { passportBase: origin, requireStoken: true })
      } catch (caught) {
        error = caught
      }
      check(error?.code === 'stoken_exchange_refused', `requireStoken 应抛 stoken_exchange_refused，实际 ${error?.code}`)
    } finally {
      fake.server.closeAllConnections?.()
      await new Promise((resolve) => fake.server.close(resolve))
    }
  }
  console.log('ok 6 STOKEN 交换失败：默认降级为 BDUSS-only + warning，requireStoken 时抛错')

  // ── ⑦ 未知形状 → unknown，带原始判据，不猜 ──
  {
    const fake = createFakePassport(['confirmed'])
    const original = fake.server.listeners('request')[0]
    fake.server.removeAllListeners('request')
    fake.server.on('request', (request, response) => {
      if ((request.url ?? '').startsWith('/channel/unicast')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        // 上游改字段名：既不是 errno:1，也没有 channel_v。
        return response.end(JSON.stringify({ errno: 0, channelData: { status: '0' } }))
      }
      original(request, response)
    })
    const origin = await listen(fake.server)
    try {
      const session = await mod.requestKukuQrCode({ passportBase: origin })
      const polled = await mod.pollKukuQrStatus(session, { passportBase: origin })
      check(polled.state === 'unknown', `未知形状应映射 unknown，实际 ${polled.state}`)
      check(polled.probe.fields.includes('channelData'), `probe 应带原始字段名：${polled.probe.fields}`)
    } finally {
      fake.server.closeAllConnections?.()
      await new Promise((resolve) => fake.server.close(resolve))
    }
  }
  console.log('ok 7 未知形状 → unknown 并带原始字段名（不猜、留证据）')

  // ── ⑧ 取码被拒 → qr_refused ──
  {
    const fake = createFakePassport(['pending'])
    const original = fake.server.listeners('request')[0]
    fake.server.removeAllListeners('request')
    fake.server.on('request', (request, response) => {
      if ((request.url ?? '').startsWith('/v2/api/getqrcode')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        return response.end(JSON.stringify({ errno: 1001, msg: 'refused' }))
      }
      original(request, response)
    })
    const origin = await listen(fake.server)
    try {
      let error
      try { await mod.requestKukuQrCode({ passportBase: origin }) } catch (caught) { error = caught }
      check(error?.code === 'qr_refused', `应抛 qr_refused，实际 ${error?.code}`)
      check(error.errno === 1001, `errno 未带出：${error.errno}`)
    } finally {
      fake.server.closeAllConnections?.()
      await new Promise((resolve) => fake.server.close(resolve))
    }
  }
  console.log('ok 8 取码被拒 → qr_refused（带 errno）')

  // ── ⑨ 取图连续空 → qr_image_empty（不是静默白框）──
  {
    const fake = createFakePassport(['pending'])
    const original = fake.server.listeners('request')[0]
    fake.server.removeAllListeners('request')
    fake.server.on('request', (request, response) => {
      if ((request.url ?? '').startsWith('/v2/api/qrcode')) {
        response.writeHead(200, { 'content-type': 'image/png' })
        return response.end(Buffer.alloc(0))
      }
      original(request, response)
    })
    const origin = await listen(fake.server)
    try {
      const session = await mod.requestKukuQrCode({ passportBase: origin })
      let error
      try { await mod.fetchKukuQrImage(session, { passportBase: origin }) } catch (caught) { error = caught }
      check(error?.code === 'qr_image_empty', `连续空图应抛 qr_image_empty，实际 ${error?.code}`)
    } finally {
      fake.server.closeAllConnections?.()
      await new Promise((resolve) => fake.server.close(resolve))
    }
  }
  console.log('ok 9 取图连续为空 → qr_image_empty（不产出扫不出的白框）')

  // ── ⑩ 请求形状：Referer / UA / JSONP callback / 不空 Cookie 头 ──
  {
    const full2 = await walkFullChain(mod, '', ['pending', 'confirmed'])
    const getQr = full2.seen.find((entry) => entry.path === '/v2/api/getqrcode')
    check(getQr !== undefined, '未记录到 getqrcode 请求')
    check(getQr.referer === 'https://kuku.baidu.com/genflowpro/login', `Referer 不符：${getQr.referer}`)
    check(getQr.query.apiver === 'v3' && getQr.query.tpl === 'genflowpro', '固定参数 apiver/tpl 缺失')
    check(getQr.query.lp === 'pc' && getQr.query.qrloginfrom === 'pc', '取码参数 lp/qrloginfrom 缺失')
    check(/^bd__cbs__[0-9a-f]+$/.test(getQr.query.callback ?? ''), `JSONP callback 形状不符：${getQr.query.callback}`)
    check(getQr.cookie === '', `首次取码不应发 Cookie 头（passport 对空 Cookie 头回 404），实际：${getQr.cookie}`)
    const unicast = full2.seen.find((entry) => entry.path === '/channel/unicast')
    check(unicast?.query.channel_id === 'selftest-sign-0001', `轮询 channel_id 应为 sign：${unicast?.query.channel_id}`)
    check(unicast?.query._sdkFrom === '1', '轮询缺 _sdkFrom=1')
    check(unicast.cookie.includes('BAIDUID='), '轮询应带上罐里的设备 Cookie')
    const auth = full2.seen.find((entry) => entry.path === '/v3/login/api/auth')
    check(auth?.method === 'POST', `STOKEN 交换应为 POST，实际 ${auth?.method}`)
    check(auth.userAgent.startsWith('genflow;'), `STOKEN 交换 UA 应为引擎串，实际 ${auth.userAgent}`)
    check(new URLSearchParams(auth.body).get('sig')?.length === 32, 'STOKEN 交换缺 32 位 sig')
    check(new URLSearchParams(auth.body).get('tpl_list') === 'genflowpro|netdisk', 'STOKEN 交换 tpl_list 不符')
  }
  console.log('ok 10 请求形状：Referer/UA/JSONP/固定参数/channel_id/_sdkFrom/sig 全部对齐')

  // ── ⑪ 渲染页面：纯函数、内联二维码、无外部资源 ──
  {
    const html = mod.renderKukuQrPage({
      qrDataUrl: 'data:image/png;base64,AAAA',
      pollPath: '/kuku/poll',
      reloadPath: '/kuku/reload',
    })
    check(html.includes('data:image/png;base64,AAAA'), '页面未内联二维码')
    check(html.includes('/kuku/poll'), '页面未带轮询路径')
    check(html.includes('/kuku/reload'), '页面未带刷新路径')
    check(!/<script[^>]+src=/.test(html), '页面不应引用外部脚本')
    check(!/<link[^>]+href=/.test(html), '页面不应引用外部样式')
    check(html.includes("res.state === 'confirmed'"), '页面未处理 confirmed')
    check(html.includes("res.state === 'expired'"), '页面未处理 expired')
    check(html.includes("res.state === 'scanned'"), '页面未处理 scanned')
  }
  console.log('ok 11 扫码页：内联二维码、零外部资源、四种状态都处理')

  // ── ⑫ 错误分类表：每个 code 都能被构造并被识别 ──
  {
    const codes = [
      'network', 'http', 'unparsable', 'qr_refused', 'qr_image_empty',
      'bduss_login_refused', 'no_bduss', 'stoken_exchange_refused', 'credential_invalid',
    ]
    for (const code of codes) {
      const error = new mod.KukuQrError(code, 'x')
      check(error.code === code, `KukuQrError 未保留 code=${code}`)
      check(error instanceof Error, 'KukuQrError 必须继承 Error')
      check(error.name === 'KukuQrError', 'name 应为 KukuQrError')
    }
  }
  console.log('ok 12 错误分类：9 个 code 全部可构造（network/http/unparsable/qr_refused/qr_image_empty/bduss_login_refused/no_bduss/stoken_exchange_refused/credential_invalid）')

  // ── ⑬ 轮询是**长轮询**：不能用普通请求的 15 秒超时 ──
  //
  // 2026-10-24 实测（两次采样）：未扫码时 `/channel/unicast` 会挂住约 30 秒才回
  // `{"errno":1}`。用 `KUKU_QR_REQUEST_TIMEOUT_MS`（15 秒）会让**每一次**轮询都
  // 超时并抛 network —— 表面上「扫码一直失败」，实际是上游正常在等。
  // 这条断言把这个区别钉死：轮询超时必须**明显大于**普通请求超时。
  {
    check(
      mod.KUKU_QR_POLL_TIMEOUT_MS > mod.KUKU_QR_REQUEST_TIMEOUT_MS * 2,
      `轮询超时(${mod.KUKU_QR_POLL_TIMEOUT_MS}ms) 必须明显大于普通请求超时(${mod.KUKU_QR_REQUEST_TIMEOUT_MS}ms)`
      + ' —— /channel/unicast 是长轮询，实测挂住约 30 秒',
    )
    check(mod.KUKU_QR_POLL_TIMEOUT_MS >= 40_000, `轮询超时应给足余量（实测 30 秒），实际 ${mod.KUKU_QR_POLL_TIMEOUT_MS}ms`)

    // 行为验证：假上游故意慢 400ms 才回 pending。若轮询腿误用短超时（这里注入 150ms），
    // 就会抛 network 而不是返回 pending。
    const fake = createFakePassport(['pending'])
    const original = fake.server.listeners('request')[0]
    fake.server.removeAllListeners('request')
    fake.server.on('request', (request, response) => {
      if ((request.url ?? '').startsWith('/channel/unicast')) {
        setTimeout(() => original(request, response), 400)
        return
      }
      original(request, response)
    })
    const origin = await listen(fake.server)
    try {
      const session = await mod.requestKukuQrCode({ passportBase: origin })
      // 显式注入 150ms：模拟「误用短超时」。必须抛 network —— 证明这个注入点真的生效，
      // 也证明生产默认值不能是短的那个。
      let timedOut
      try {
        await mod.pollKukuQrStatus(session, { passportBase: origin, timeoutMs: 150 })
      } catch (caught) {
        timedOut = caught
      }
      check(timedOut?.code === 'network', `短超时应抛 network，实际 ${timedOut?.code}`)

      // 用生产默认超时（不注入）：400ms 的慢响应必须正常返回 pending。
      const polled = await mod.pollKukuQrStatus(session, { passportBase: origin })
      check(polled.state === 'pending', `慢响应在默认超时下应正常返回 pending，实际 ${polled.state}`)
    } finally {
      fake.server.closeAllConnections?.()
      await new Promise((resolve) => fake.server.close(resolve))
    }
  }
  console.log(`ok 13 长轮询超时：轮询 ${mod.KUKU_QR_POLL_TIMEOUT_MS}ms ≫ 普通 ${mod.KUKU_QR_REQUEST_TIMEOUT_MS}ms，慢响应不再被误判为网络失败`)

  console.log('\nkuku-qr selftest: 13 组断言全部通过（本地假上游，未联网、未扫码、未写凭据）')
}

/** `--live`：只真连 passport **取码 + 取图**（只读、不扫码、不产生登录态）。 */
async function live() {
  const mod = await import('../vendor/channel-pack/src/kuku-qr-login.ts')
  console.log('⚠️  --live：真连 passport.baidu.com 取码（只读，不扫码，不写凭据）')
  const session = await mod.requestKukuQrCode()
  console.log(`  sign:   ${session.sign}`)
  console.log(`  prompt: ${session.prompt || '（无）'}`)
  console.log(`  image:  ${session.imageUrl}`)
  const image = await mod.fetchKukuQrImage(session)
  console.log(`  图片:   ${image.bytes} 字节，${image.contentType}`)
  // 轮询一次：只读，用来看「还没扫」时上游到底回什么形状（这是最有价值的活体证据）。
  const polled = await mod.pollKukuQrStatus(session)
  console.log(`  轮询一次: state=${polled.state} probe=${JSON.stringify(polled.probe)}`)
  console.log('\n未扫码时的状态应当稳定在 pending。扫码动作必须由人完成；本工具到此为止。')
}

/** 解析参数。 */
function parseArgs(argv) {
  const args = { live: false }
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--live') args.live = true
    else if (flag === '--help' || flag === '-h') {
      console.log('usage: node scripts/kuku-qr-selftest.mjs [--live]')
      process.exit(0)
    } else throw new Error(`未知参数：${flag}`)
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.live) return live()
  return selftest()
}

// 只有直接运行时才跑；被其它测试 import 时不得产生副作用。
if (isDirectRun) {
  main().catch((error) => {
    console.error(`kuku-qr-selftest: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}

/** 供 channel-pack-test 复用（导入时不自动执行）。 */
export async function verifyKukuQrSelftest() {
  await selftest()
}
