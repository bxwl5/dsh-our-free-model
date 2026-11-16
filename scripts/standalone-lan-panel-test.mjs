/**
 * 面板中继（`--lan-panel` / `standaloneLanPanel`）：把面板与管理 API 也经
 * LAN 中继暴露出去，但**必须显式开启**，且鉴权仍归面板自己。
 *
 * 2026-11-16 用户实测驱动：Docker 版本装来就是给局域网设备用的，而中继原来
 * 只放行推理路径 —— 手机/另一台电脑打开 `http://<nas>:<port>/` 只能看到连接
 * 失败，面板、渠道登录、模型开关一个都打不开。用户原话：
 *   「我使用docker本来就是给局域网设备使用啊」「我需要能访问到面板啊」
 *
 * 锁定六件事：
 *   ① 默认关：`--lan` 不带 `--lan-panel` 时，面板路径在中继上仍是 404（旧行为不变）
 *   ② 开启后：`/` 与 `/assets/*` 返回 200（静态页可访问）
 *   ③ 开启后：`/api/management/summary` **未登录** → 401（面板自己的门，不是中继放过）
 *   ④ 开启后：LAN key 对面板**无效**（两套凭据互不越权）
 *   ⑤ 开启后：用一次性 bootstrap token 换到 Cookie，随后 summary → 200
 *   ⑥ 推理路径仍然只认 LAN key：本机 forwardKey 打中继 → 401（不因开了面板而放宽）
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-lan-panel-'))
const model = 'mimo-v2.6-flash-free'
const upstream = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: req.url === '/models' ? [] : [{ id: model }] }))
  })
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`
process.env.OUR_FREE_MODEL_BASE = upstreamUrl
process.env.OUR_FREE_MODEL_KILO_BASE = upstreamUrl

const { startLanRelay } = await import('../src/forward.js')
const { startStandalone } = await import('../packages/standalone/service.mjs')

const startRelay = async ({ config, ...options }) => startLanRelay({
  ...options,
  config: () => ({ ...config(), host: '127.0.0.1' }),
})

const request = async (base, route, { body, key, headers = {}, method } = {}) => {
  const response = await fetch(base + route, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      connection: 'close',
      ...body === undefined ? {} : { 'content-type': 'application/json' },
      ...key ? { authorization: `Bearer ${key}` } : {},
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  const text = await response.text()
  let value
  try { value = JSON.parse(text) } catch { value = text }
  return { status: response.status, value, headers: response.headers, text }
}

let failures = 0
const check = async (name, run) => {
  try { await run(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

const base = { port: 0, refresh: false, logger: { warn() {} }, startRelay }

// ── ① 默认关 ──────────────────────────────────────────────
{
  const dataDir = path.join(scratch, 'default-off')
  const service = await startStandalone({ ...base, dataDir, lanEnabled: true, lanPort: 0 })
  try {
    await service.ready
    const saved = JSON.parse(fs.readFileSync(service.keyFile, 'utf8'))
    assert.equal(service.lan.panel, false, 'lanPanel 默认必须是 false')
    const url = `http://127.0.0.1:${service.lan.port}`
    await check('① 默认关：面板路径在中继上仍是 404（带合法 LAN key 也不放行）', async () => {
      // 不带 key 时先撞推理的 LAN key 门禁（401），这是既有顺序；
      // 带 key 才走到路径判定 —— 面板路径不在 RELAY_PATHS 里 → 404。
      assert.equal((await request(url, '/')).status, 401, '无 key 先撞门外')
      for (const route of ['/', '/assets/app.js', '/api/management/summary']) {
        const response = await request(url, route, { key: saved.standaloneLanKey })
        assert.equal(response.status, 404, `${route} 应 404（面板中继未开启），实际 ${response.status}`)
      }
    })
    await check('① 默认关：推理路径照常只认 LAN key', async () => {
      assert.equal((await request(url, '/v1/models', { key: saved.standaloneLanKey })).status, 200)
      assert.equal((await request(url, '/v1/models', { key: saved.forwardKey })).status, 401)
    })
  } finally { await service.close() }
}

// ── ②③④⑤⑥ 开启后 ────────────────────────────────────────
{
  const dataDir = path.join(scratch, 'panel-on')
  const service = await startStandalone({
    ...base, dataDir, lanEnabled: true, lanPanel: true, lanPort: 0,
  })
  try {
    await service.ready
    const saved = JSON.parse(fs.readFileSync(service.keyFile, 'utf8'))
    const url = `http://127.0.0.1:${service.lan.port}`
    assert.equal(service.lan.panel, true, 'lanPanel 开启后 lan.panel 应为 true')

    await check('② 开启后：静态面板可访问', async () => {
      const home = await request(url, '/')
      assert.equal(home.status, 200, home.text.slice(0, 120))
      assert.match(home.text, /<html|<!doctype/i, '首页应是 HTML')
      const asset = await request(url, '/assets/app.js')
      assert.equal(asset.status, 200)
      assert.ok(asset.text.length > 1000, 'assets 应有实际内容')
    })

    await check('③ 开启后：未登录访问管理 API → 401（面板自己的门）', async () => {
      for (const route of ['/api/management/summary', '/api/management/key', '/api/management/settings']) {
        const response = await request(url, route)
        assert.equal(response.status, 401, `${route} 未登录应 401，实际 ${response.status}`)
      }
    })

    await check('④ 开启后：LAN key 对面板无效（两套凭据互不越权）', async () => {
      const response = await request(url, '/api/management/summary', { key: saved.standaloneLanKey })
      assert.equal(response.status, 401, 'LAN key 不该能读管理面')
    })

    await check('⑤ 开启后：一次性 bootstrap token 经中继换 Cookie，随后管理面 200', async () => {
      // 一次性 token 只能从**本机**取得（`#login=` 片段 / 本机日志）。
      // 这里从 service.managementUrl 取，等价于用户在本机日志里看到的那条。
      const token = new URL(service.managementUrl).hash.replace(/^#login=/, '')
      assert.ok(token.length > 20, '应能取到 bootstrap token')
      const session = await request(url, '/api/management/session', { body: { bootstrapToken: token } })
      assert.equal(session.status, 200, `换 session 应 200，实际 ${session.status} ${session.text.slice(0, 120)}`)
      const cookie = session.headers.get('set-cookie')
      assert.ok(cookie && cookie.includes('ofm_management_'), '应下发管理 Cookie')
      const cookiePair = cookie.split(';')[0]
      const summary = await request(url, '/api/management/summary', { headers: { cookie: cookiePair } })
      assert.equal(summary.status, 200, `带 Cookie 读 summary 应 200，实际 ${summary.status}`)
      assert.equal(summary.value.product, 'our-free-model-standalone', 'summary 应来自真面板')
      // 一次性语义：同一个 token 再换一次必须失败
      const replay = await request(url, '/api/management/session', { body: { bootstrapToken: token } })
      assert.equal(replay.status, 401, 'bootstrap token 必须一用即焚')
    })

    await check('⑥ 开启后：推理路径仍只认 LAN key（不因开面板而放宽）', async () => {
      assert.equal((await request(url, '/v1/models', { key: saved.standaloneLanKey })).status, 200)
      assert.equal((await request(url, '/v1/models', { key: saved.forwardKey })).status, 401)
      assert.equal((await request(url, '/v1/models')).status, 401, '无 key 必须 401')
    })

    await check('⑥ 中继不注入本机 key：面板请求带不回推理权限', async () => {
      // 面板路径不带 hop 标记、不替换 Authorization；用错误 key 打面板依旧 401
      const response = await request(url, '/api/management/summary', { key: 'ofm-not-a-real-key' })
      assert.equal(response.status, 401)
    })
  } finally { await service.close() }
}

upstream.closeAllConnections?.()
await new Promise(resolve => upstream.close(resolve))
fs.rmSync(scratch, { recursive: true, force: true })

if (failures > 0) console.error(`standalone-lan-panel-test: ${failures} failure(s)`)
else console.log('standalone-lan-panel-test: the panel is reachable over LAN only when asked for')
process.exitCode = failures > 0 ? 1 : 0
