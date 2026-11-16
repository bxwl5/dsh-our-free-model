/**
 * 实证：`--lan-panel` 的改动对 **DSH 插件端零影响**。
 *
 * 背景：`src/forward.js` 是插件（`index.js`）与独立版（`packages/standalone`）
 * 共用的。2026-11-16 为独立版加了面板中继（`settings.panel`），必须证明
 * 插件端行为逐字不变 —— 否则一次「只给 Docker 用」的改动会波及桌面版。
 *
 * 保证机制：插件端的 `config()`（`index.js:457-471`）**不返回 `panel` 字段**，
 * 于是 `settings.panel === true` 恒为假，`panelRequest` 恒为 false，所有分支
 * 都走 else 里的原逻辑。
 *
 * 本套件用**与 index.js 同形的 config**（没有 panel 字段）真起中继，逐条锁定
 * 原行为：面板路径 404、无 key/错 key 401、对 key 200 且注入本机 key、
 * enabled=false 503。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { startLanRelay } from '../src/forward.js'

const upstream = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ path: req.url, auth: req.headers.authorization ?? null }))
  })
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const targetPort = upstream.address().port

// ★ 与 index.js 的 config() 同形：**没有 panel 字段**
const relay = await startLanRelay({
  config: () => ({
    enabled: true, host: '127.0.0.1', port: 0, targetPort,
    lanKey: 'lan-key-fixture', localKey: 'local-key-fixture',
  }),
})
const base = `http://127.0.0.1:${relay.port}`
const get = async (route, key) => {
  const res = await fetch(base + route, {
    headers: { connection: 'close', ...key ? { authorization: `Bearer ${key}` } : {} },
    signal: AbortSignal.timeout(5000),
  })
  return { status: res.status, text: await res.text() }
}

let failures = 0
const check = async (name, run) => {
  try { await run(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

await check('插件端：面板路径照旧 404（panel 未定义 ⇒ 不进面板分支）', async () => {
  for (const route of ['/', '/index.html', '/assets/app.js', '/api/management/summary']) {
    const response = await get(route, 'lan-key-fixture')
    assert.equal(response.status, 404, `${route} 应 404，实际 ${response.status}`)
  }
})

await check('插件端：无 key 推理 → 401（原行为）', async () => {
  assert.equal((await get('/v1/models')).status, 401)
})

await check('插件端：错 key 推理 → 401（原行为）', async () => {
  assert.equal((await get('/v1/models', 'wrong-key')).status, 401)
})

await check('插件端：对 key 推理 → 200，上游看到的是本机 key（不是 LAN key）', async () => {
  const response = await get('/v1/models', 'lan-key-fixture')
  assert.equal(response.status, 200)
  assert.match(response.text, /local-key-fixture/, '上游应看到本机 key')
  assert.doesNotMatch(response.text, /lan-key-fixture/, '调用方的 LAN key 不该透到上游')
})

await check('插件端：enabled=false → 503（原行为）', async () => {
  const off = await startLanRelay({
    config: () => ({ enabled: false, host: '127.0.0.1', port: 0, targetPort, lanKey: 'k', localKey: 'l' }),
  })
  try {
    const response = await fetch(`http://127.0.0.1:${off.port}/v1/models`, {
      headers: { authorization: 'Bearer k' }, signal: AbortSignal.timeout(5000),
    })
    assert.equal(response.status, 503)
  } finally { await off.close() }
})

await relay.close()
upstream.closeAllConnections?.()
await new Promise(resolve => upstream.close(resolve))

if (failures > 0) console.error(`plugin-relay-unchanged-test: ${failures} failure(s)`)
else console.log('plugin-relay-unchanged-test: the DSH plugin relay behaves exactly as before')
process.exitCode = failures > 0 ? 1 : 0
