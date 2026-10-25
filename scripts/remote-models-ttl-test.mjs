/**
 * 远端模型目录 TTL 回归：**成功不再永久缓存**。
 *
 * 背景（2026-10-25）：7 个渠道的 `ensureRemoteModels()` 原先判据是
 * `if (this.remoteModels !== undefined) return` —— 拉成功一次就永久缓存，
 * 上游下架/新增模型后进程不重启永远不跟上（与 OrCaTerm 静态表过期同源）。
 * 这个套件锁住三件事：
 *   1. TTL 内不重复拉取（不能把请求量放大）；
 *   2. TTL 过期后会重新拉取，并采用新目录；
 *   3. 拉取失败时**保留旧列表**，不因一次抖动清空。
 */
import assert from 'node:assert/strict'
import http from 'node:http'

export async function verifyRemoteModelsTtl() {
const { OfficeAceAdapter } = await import('../vendor/channel-pack/src/officeace-adapter.ts')
const { OFFICEACE } = await import('../vendor/channel-pack/src/officeace-product.ts')
const { fetch: realFetch } = await import('undici')

let hits = 0
let payload = [{ id: 'model-a', name: 'A' }, { id: 'model-b', name: 'B' }]
let failNext = false

const upstream = http.createServer((req, res) => {
  // normalizeBaseUrl 会自动补 /v2，故实际路径是 /v2/models。
  if (req.url === '/v2/models' || req.url === '/models') {
    hits += 1
    if (failNext) { res.writeHead(500, { Connection: 'close' }).end('{}'); return }
    res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
      .end(JSON.stringify({ data: payload }))
    return
  }
  res.writeHead(404, { Connection: 'close' }).end('{}')
})
await new Promise(r => upstream.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${upstream.address().port}`

const adapter = new OfficeAceAdapter({
  product: { ...OFFICEACE },
  fetchImpl: realFetch,
  resolveCredential: async () => ({
    base_url: base,
    app_key: 'k', app_secret: 's', access_key: 'ak', secret_key: 'sk',
    security_token: 't', refresh_token: 'r', expire_time: 0,
    nickname: 'n', created_at: 0, account_id: 'a', principal_id: 'p',
  }),
})

try {
  // ── 1. 首次拉取 ──
  const first = await adapter.listModels('officeace')
  assert.equal(first.length, 2, '首次拿到 2 个模型')
  assert.equal(hits, 1, '首次只发一次请求')

  // ── 2. TTL 内不重复拉取 ──
  await adapter.listModels('officeace')
  await adapter.listModels('officeace')
  assert.equal(hits, 1, 'TTL 内命中缓存，不应再发请求')

  // ── 3. 模拟 TTL 过期：直接改写时间戳（不 sleep 5 分钟）──
  adapter.remoteModelsAt = 0
  payload = [{ id: 'model-c', name: 'C' }]
  const second = await adapter.listModels('officeace')
  assert.equal(hits, 2, 'TTL 过期后必须重新拉取')
  assert.deepEqual(second.map(m => m.id), ['model-c'], '必须采用新目录（不再永久缓存）')

  // ── 4. 拉取失败保留旧列表 ──
  adapter.remoteModelsAt = 0
  failNext = true
  const third = await adapter.listModels('officeace')
  assert.equal(hits, 3, '失败也要真的试一次')
  assert.deepEqual(third.map(m => m.id), ['model-c'], '失败时保留上一次的列表，不清空')

  // ── 5. kuku 有远端目录接口（原实现误以为「上游没有」）──
  const { KUKU, KUKU_MODEL_LIST_PATH, KUKU_WEB_QUERY } = await import('../vendor/channel-pack/src/kuku-product.ts')
  assert.equal(KUKU_MODEL_LIST_PATH, '/wenchain/genflowpro/model/list', 'kuku 目录路径与上游一致')
  assert.ok(KUKU_WEB_QUERY.includes('app_id=123971023'), 'kuku 目录查询串与官方 Web 客户端一致')
  assert.equal(KUKU.fallbackModels.length, 13, 'kuku 静态兜底是 13 个真实模型')
  assert.ok(!KUKU.fallbackModels.some(m => m.id === 'kuku'), '占位 id `kuku` 不是真实模型，必须移除')
  assert.ok(KUKU.fallbackModels.some(m => m.id === 'auto'), 'auto 是上游自动选路档')

  console.log('remote-models-ttl: 5 组断言通过（TTL 命中 / 过期重拉 / 失败保留旧列表 / kuku 目录）')
} finally {
  upstream.close()
}
}

import { exitIfDirectRun } from './lib/direct-run.mjs'
exitIfDirectRun(import.meta.url, 'remote-models-ttl-test')

/**
 * KukuAI 积分与签到解析回归。
 *
 * 上游形态按 `aimod-cc/Agent2API` 的 `providers/kuku/{balance,checkin}.rs`：
 * - 余额：`data.list[assetName=="token"].totalPoint`（**字符串**）
 * - 判据在**顶层** `status.code`（不是 `data.status.code`）
 * - 签到：`taskComplete` 幂等，`SUCCESS` + reward 0 表示「已领过」
 */
export async function verifyKukuCredits() {
  const http = await import('node:http')
  const { fetchKukuPoints, claimKukuDailyCheckin } = await import('../vendor/channel-pack/src/kuku-auth.ts')
  const { KUKU } = await import('../vendor/channel-pack/src/kuku-product.ts')
  const { fetch: realFetch } = await import('undici')

  let balanceBody = {
    status: { code: 0, msg: 'success' },
    data: { uname: 'u', list: [
      { assetType: 1, assetName: 'token', totalPoint: '1100' },
      { assetType: 2, assetName: 'duration', totalPoint: '9' },
    ] },
  }
  let claimReward = 50
  let claimStatus = 'SUCCESS'

  const upstream = http.createServer((req, res) => {
    const send = (body) => res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' }).end(JSON.stringify(body))
    if (req.url.startsWith('/bizapi/gfpro/getgfvipremain')) { send(balanceBody); return }
    if (req.url.startsWith('/api/genflowpro/freepoint/taskComplete')) {
      req.resume()
      req.on('end', () => send({ errno: 0, data: { complete_status: claimStatus, reward_point: claimReward } }))
      return
    }
    res.writeHead(404, { Connection: 'close' }).end('{}')
  })
  await new Promise(r => upstream.listen(0, '127.0.0.1', r))
  const product = { ...KUKU, apiBase: `http://127.0.0.1:${upstream.address().port}` }
  const credential = { access_token: 'BDUSS=abcdefghijklmnopqrstuvwxyz0123456789' }

  try {
    // ── 1. 余额取 assetName==token 的 totalPoint（字符串转数字）──
    assert.equal(await fetchKukuPoints(realFetch, product, credential), 1100, '取 token 项而不是第一项')

    // ── 2. 判据在顶层 status.code ──
    balanceBody = { status: { code: 5, msg: 'boom' }, data: { list: [{ assetName: 'token', totalPoint: '999' }] } }
    assert.equal(await fetchKukuPoints(realFetch, product, credential), undefined, '业务码非 0 时返回 undefined（不是 0）')

    // ── 3. 结构不认识也返回 undefined，绝不显示成 0 ──
    balanceBody = { status: { code: 0 }, data: { other: [] } }
    assert.equal(await fetchKukuPoints(realFetch, product, credential), undefined, '没有 list 时 undefined')

    // ── 4. 签到：正常领到积分 ──
    balanceBody = { status: { code: 0 }, data: { list: [] } }
    claimReward = 50
    claimStatus = 'SUCCESS'
    const first = await claimKukuDailyCheckin(realFetch, product, credential)
    assert.equal(first.claimed, 100, 'LOGIN + CHAT 各 50，合计 100')

    // ── 5. 幂等：已领过返回 0 且说明原因，不算失败 ──
    claimReward = 0
    claimStatus = 'BADGE_ALREADY_RECEIVED'
    const second = await claimKukuDailyCheckin(realFetch, product, credential)
    assert.equal(second.claimed, 0, '重复领返回 0')
    assert.match(second.message, /已领取/, '要说明「已领过」而不是失败')

    console.log('kuku-credits: 5 组断言通过（余额取 token 项 / 业务码 / 结构容错 / 签到 / 幂等）')
  } finally {
    upstream.close()
  }
}
