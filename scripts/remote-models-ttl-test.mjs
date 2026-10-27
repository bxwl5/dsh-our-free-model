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

/**
 * AutoClaw / OfficeAce 签到判据回归。
 *
 * 上游形态按 `aimod-cc/Agent2API`：
 * - autoclaw：`autoclaw-task-complete` 的 `task_id=daily_signin`，
 *   **成功判据是 body 里的 reward_points/success**，不能只看 HTTP 200
 *   （否则「今天已领过」会被当成一次成功领取）。
 * - officeace：`POST /v1/subscription/bonus/claim`，幂等由上游保证
 *   （重复领不报错），增量 = 领奖前后 remaining 之差。
 */
export async function verifyChannelCheckinJudgements() {
  const http = await import('node:http')
  const { fetch: realFetch } = await import('undici')

  // ── AutoClaw ──
  const { claimAutoclawDailyCheckin } = await import('../vendor/channel-pack/src/autoclaw-sms.ts')
  const { AUTOCLAW } = await import('../vendor/channel-pack/src/autoclaw-product.ts')
  let taskBody = { data: { already_completed: true, reward_points: 0, success: false, task_id: 'daily_signin' } }
  let taskStatus = 200
  const acServer = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (!req.url.startsWith('/autoclaw-proxy/proxy/autoclaw-task-complete')) {
        res.writeHead(404, { Connection: 'close' }).end('{}'); return
      }
      res.writeHead(taskStatus, { 'Content-Type': 'application/json', Connection: 'close' }).end(JSON.stringify(taskBody))
    })
  })
  await new Promise(r => acServer.listen(0, '127.0.0.1', r))
  const acProduct = { ...AUTOCLAW, apiBase: `http://127.0.0.1:${acServer.address().port}` }
  const acCredential = { access_token: 'Bearer jwt-token-value-1234567890', refresh_token: 'r', expire_time: 0, account_id: 'a', nickname: 'n', created_at: 0, device_id: 'd' }
  try {
    // 1) HTTP 200 但 success:false + already_completed:true → 已领过，不是成功
    taskStatus = 200
    taskBody = { data: { already_completed: true, reward_points: 0, success: false, task_id: 'daily_signin' } }
    const already = await claimAutoclawDailyCheckin({ product: acProduct, fetcher: realFetch, credential: acCredential })
    assert.equal(already.claimed, 0, '已领过不能算成功领取')
    assert.match(already.message, /已签到/, '要说明「今天已签到过」')

    // 2) reward_points > 0 → 成功且报到数
    taskBody = { data: { already_completed: false, reward_points: 200, success: true, task_id: 'daily_signin' } }
    const won = await claimAutoclawDailyCheckin({ product: acProduct, fetcher: realFetch, credential: acCredential })
    assert.equal(won.claimed, 200, 'reward_points>0 才算成功并上报积分数')
    assert.match(won.message, /已领取 200/, '文案要带积分数')

    // 3) 401 → 登录态过期（明确归因，不当成「已领过」）
    taskStatus = 401
    const expired = await claimAutoclawDailyCheckin({ product: acProduct, fetcher: realFetch, credential: acCredential })
    assert.equal(expired.claimed, 0)
    assert.match(expired.message, /登录态已过期/, '401 要归因到登录态')
  } finally {
    acServer.close()
  }

  // ── OfficeAce ──
  const { claimBonus } = await import('../vendor/channel-pack/src/officeace.ts')
  const { OFFICEACE } = await import('../vendor/channel-pack/src/officeace-product.ts')
  // 订阅响应按 parseSubscriptionSnapshot 的真实结构造：skus[].quotas[] 里
  // `officeace_points` 的 sku_value - current_value 即剩余积分。
  let pointsTotal = 500
  let pointsUsed = 0
  const oaServer = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const json = (body) => res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' }).end(JSON.stringify(body))
      if (req.url.startsWith('/v1/subscription/bonus/claim')) {
        // 幂等由上游保证：一天一个活动只能领一次，重复领不重复入账。
        // 首次入账 +100，之后重复调用总额不变。
        if (pointsTotal === 500) pointsTotal += 100
        json({ ok: true })
        return
      }
      if (req.url.startsWith('/v1/subscription')) {
        json({ skus: [{ sku_name: '基础套餐', sku_code: 'basic', quotas: [
          { sku_attr_code: 'officeace_points', sku_value: pointsTotal, current_value: pointsUsed },
        ] }] })
        return
      }
      res.writeHead(404, { Connection: 'close' }).end('{}')
    })
  })
  await new Promise(r => oaServer.listen(0, '127.0.0.1', r))
  const oaCredential = {
    base_url: `http://127.0.0.1:${oaServer.address().port}`,
    app_key: 'k', app_secret: 's', access_key: 'ak', secret_key: 'sk',
    security_token: 't', refresh_token: 'r', expire_time: 0,
    nickname: 'n', created_at: 0, account_id: 'a', principal_id: 'p',
    model_info: { model_api_url_base: `http://127.0.0.1:${oaServer.address().port}` },
  }
  try {
    const gained = await claimBonus(realFetch, OFFICEACE, oaCredential)
    assert.equal(gained.gained, 100, '增量 = 领奖前后 remaining 之差')
    assert.match(gained.message, /已领取 100/, '文案要带增量')

    // 幂等：重复调用 remaining 不再变（上游保证），文案说明已领过/无可领
    const again = await claimBonus(realFetch, OFFICEACE, oaCredential)
    assert.equal(again.gained, 0, '重复领不重复入账')
    assert.match(again.message, /已领过|没有可领/, '要说明「已领过或今天没有可领」')
  } finally {
    oaServer.close()
  }

  console.log('channel-checkin: 5 组断言通过（autoclaw 三态判据 / officeace 增量与幂等）')
}

/**
 * AutoClaw 出站归一化回归（上游 2026-09-22 起的两道闸 + 模型路由）。
 *
 * 上游 `providers/autoclaw/{adapter,prompt,models}.rs`：
 * - system 必须以 OpenClaw 身份句开头；**首条不是 system 时要补一条**
 *   （少这一步，不带系统提示的请求被稳定拒成 406 空响应体）；
 * - `max_tokens` 小于 10000 的小正整数被预校验拒成 406（8192 拒、10000 过）；
 * - 模型要发两个标识：`X-Request-Model` 头 = 完整路由 ID，
 *   `body.model` = 剥前缀后的 ID。
 */
export async function verifyAutoClawOutbound() {
  const http = await import('node:http')
  const { fetch: realFetch } = await import('undici')
  const {
    normalizeAutoClawMaxTokens,
    normalizeAutoClawSystem,
    resolveAutoClawModelRoute,
  } = await import('../vendor/channel-pack/src/autoclaw-sms.ts')
  const { AutoClawAdapter } = await import('../vendor/channel-pack/src/autoclaw-adapter.ts')
  const { AUTOCLAW } = await import('../vendor/channel-pack/src/autoclaw-product.ts')

  // ── 1. system 归一化 ──
  assert.match(normalizeAutoClawSystem('你是助手'), /^You are a personal assistant running inside OpenClaw\./, '无身份句要前置前缀')
  assert.match(normalizeAutoClawSystem('你是助手'), /你是助手$/, '客户端提示词逐字保留在后')
  // 幂等：已带身份句只改写、不再前置
  const already = normalizeAutoClawSystem('You are a personal assistant running inside OpenClaw.\n\nbe nice')
  assert.equal(already.match(/You are a personal assistant running inside OpenClaw\./g)?.length, 1, '已带身份句不重复前置')
  // 外来身份句改写（忽略大小写）
  assert.match(normalizeAutoClawSystem('You are Claude Code, Anthropic official CLI'), /You are a coding assistant/)

  // ── 2. max_tokens 下限 ──
  assert.equal(normalizeAutoClawMaxTokens(8192), 10_000, '小于下限抬到 10000')
  assert.equal(normalizeAutoClawMaxTokens(20000), 20000, '达标不动')
  assert.equal(normalizeAutoClawMaxTokens(0), undefined, '0 视为没给')
  assert.equal(normalizeAutoClawMaxTokens(-5), undefined, '负数视为没给')
  assert.equal(normalizeAutoClawMaxTokens('x'), undefined, '非数字视为没给')

  // ── 3. 模型路由 ──
  assert.deepEqual(resolveAutoClawModelRoute('glm-5.3'), { routeModelId: 'zaicoding_glm-5.3', bodyModelId: 'glm-5.3' })
  assert.deepEqual(resolveAutoClawModelRoute('GLM-5.3'), { routeModelId: 'zaicoding_glm-5.3', bodyModelId: 'glm-5.3' }, '大小写不触发回退')
  assert.deepEqual(resolveAutoClawModelRoute('glm-5.3-flash'), { routeModelId: 'zai_glm-5.3-flash', bodyModelId: 'glm-5.3-flash' })
  assert.deepEqual(resolveAutoClawModelRoute('zaicoding_glm-5.3'), { routeModelId: 'zaicoding_glm-5.3', bodyModelId: 'glm-5.3' }, '显式路由写法透传')
  assert.deepEqual(resolveAutoClawModelRoute('claude-sonnet-4-5'), { routeModelId: 'zai_auto', bodyModelId: 'auto' }, '未知回落默认路由')
  assert.deepEqual(resolveAutoClawModelRoute(''), { routeModelId: 'zai_auto', bodyModelId: 'auto' }, '空值回落默认路由')

  // ── 4. 无 system 的请求也要带身份前缀消息（真实打一次 mock）──
  const seen = []
  const upstream = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      seen.push({
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      })
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
      res.end('data: {"choices":[{"delta":{"content":"可以"},"finish_reason":null}]}\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise(r => upstream.listen(0, '127.0.0.1', r))
  const product = { ...AUTOCLAW, apiBase: `http://127.0.0.1:${upstream.address().port}` }
  const adapter = new AutoClawAdapter({
    product,
    fetchImpl: realFetch,
    resolveCredential: async () => ({
      access_token: 'Bearer jwt-1234567890', refresh_token: 'r', expire_time: 0,
      account_id: 'a', nickname: 'n', created_at: 0, device_id: 'd',
    }),
  })
  try {
    const out = []
    for await (const chunk of adapter.stream({
      model: 'glm-5.3',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) if (chunk.type === 'text-delta') out.push(chunk.text)
    assert.equal(out.join(''), '可以', '对话链路要能解出正文')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].headers['x-request-model'], 'zaicoding_glm-5.3', 'X-Request-Model 是完整路由 ID')
    assert.equal(seen[0].body.model, 'glm-5.3', 'body.model 是剥前缀后的 ID')
    const messages = seen[0].body.messages
    assert.equal(messages[0].role, 'system', '无 system 输入也要补一条 system')
    assert.match(messages[0].content, /^You are a personal assistant running inside OpenClaw\./, '补的这条带身份前缀')
    assert.equal(seen[0].headers['x-tm'], process.platform === 'darwin' ? 'mac' : 'win', 'Linux 回落 win（上游不认 linux）')
    assert.equal(seen[0].headers['x-harness-type'], undefined, '对话链不发 X-Harness-Type（上游对它区别对待）')
  } finally {
    upstream.close()
  }

  console.log('autoclaw-outbound: 4 组断言通过（system 归一 / max_tokens / 路由 / 无 system 兜底）')
}

/** delta-blocks：内核 StreamChunk 契约回归。 */
/** delta-blocks：内核 StreamChunk 契约回归（index + block-start/end 配对）。 */
export async function verifyDeltaBlocks() {
  const { emitDeltaBlocks } = await import('../vendor/channel-pack/src/delta-blocks.ts')
  const collect = async (it) => { const out = []; for await (const c of it) out.push(c); return out }
  async function* deltas(list) { for (const d of list) yield d }

// 1) 纯文本：block-start → text-delta(带 index) → block-end(完整文本)
const a = await collect(emitDeltaBlocks(deltas([{text:'你'},{text:'好'}])))
assert.deepEqual(a.map(c=>c.type), ['block-start','text-delta','text-delta','block-end'], '块生命周期完整')
assert.equal(a[0].index, 0, 'index 是非负整数')
assert.equal(a[3].block.text, '你好', 'block-end 带完整文本')

// 2) reasoning + text：两个块，index 各占一个
const b = await collect(emitDeltaBlocks(deltas([{reasoning:'想'},{text:'答'}])))
assert.deepEqual(b.map(c=>c.type), ['block-start','reasoning-delta','block-start','text-delta','block-end','block-end'])
assert.equal(b[0].index, 0); assert.equal(b[2].index, 1, '两类各占一个 index')

// 3) 空流：什么都不发
const c = await collect(emitDeltaBlocks(deltas([])))
assert.deepEqual(c, [], '空流不产生任何块')

// 4) 纯空白 reasoning：块必须配对（block-start 已发就不能跳过 block-end）
const d = await collect(emitDeltaBlocks(deltas([{reasoning:'  '},{text:'答'}])))
assert.deepEqual(d.map(x=>x.type), ['block-start','reasoning-delta','block-start','text-delta','block-end','block-end'], '纯空白思考也配对收尾')
assert.equal(d.filter(x=>x.type==='block-start').length, d.filter(x=>x.type==='block-end').length, 'start 与 end 数量相等')

// 4b) 空字符串增量不产生块
const d2 = await collect(emitDeltaBlocks(deltas([{text:''},{text:'答'}])))
assert.deepEqual(d2.map(x=>x.type), ['block-start','text-delta','block-end'], '空串增量被忽略')

// 5) 交替增量复用同一块
const e = await collect(emitDeltaBlocks(deltas([{text:'a'},{text:'b'},{text:'c'}])))
assert.equal(e.filter(x=>x.type==='block-start').length, 1, '同类增量只开一个块')
assert.equal(e.filter(x=>x.type==='text-delta').every(x=>x.index===0), true, 'index 稳定')
assert.equal(e.at(-1).block.text, 'abc')

  console.log('delta-blocks: 5 组断言通过（块生命周期 / index 分配 / 空流 / 纯空白 / 块复用）')
}

/**
 * 三个新渠道签到的 ClaimOutcome 形状回归。
 *
 * 背景（2026-10-26 实测缺陷）：kuku / autoclaw / officeace 的 claim 回调
 * 一度返回 `{claimed, message}`，而 `computeClaimSummary` 按 `kind` 分类 ——
 * 缺 kind 走 default 全部计成 failed、coversToday=0，auto-checkin 的
 * shouldMarkToday 永不满足 ⇒ **每次启动都重跑一轮**。
 * 本组断言锁住映射：领到→claimed（带 credit）、幂等已领→already-claimed
 * （coversToday 计数）、真失败→failed。
 */
export async function verifyClaimOutcomeShape() {
  const { computeClaimSummary } = await import('../vendor/channel-pack/src/channel-pack-rpc.ts')
  // 与 rpc 分支里逐字一致的映射
  const map = (claimed, message) => claimed > 0
    ? { kind: 'claimed', credit: claimed, streakDays: 1, isStreakDay: true, message }
    : /已领取过|已领|没有可领|已签到/.test(message)
      ? { kind: 'already-claimed', message }
      : { kind: 'failed', code: -1, message }

  const claimed = map(100, '已领取 100 积分')
  const idempotent = map(0, '今天已签到过（上游按天幂等）')
  const noneToday = map(0, '今天没有可领的奖励（或已领过）')
  const failed = map(0, '凭据不可用')

  assert.equal(claimed.kind, 'claimed')
  assert.equal(claimed.credit, 100, '领到的积分数要进 credit（totalCredit 的来源）')
  assert.equal(idempotent.kind, 'already-claimed', '幂等已领不是失败')
  assert.equal(noneToday.kind, 'already-claimed', '今天没有可领按已领计（coversToday）')
  assert.equal(failed.kind, 'failed')

  const summary = computeClaimSummary([claimed, idempotent, noneToday, failed])
  assert.equal(summary.claimed, 1)
  assert.equal(summary.totalCredit, 100)
  assert.equal(summary.alreadyClaimed, 2)
  assert.equal(summary.failed, 1)
  assert.ok(summary.coversToday >= 3, `coversToday 应≥3（auto-checkin 记日期的判据），实得 ${summary.coversToday}`)
  // 反证：缺 kind 的旧形状必须被本测试暴露（走 default 计 failed）
  const legacy = computeClaimSummary([{ claimed: 100, message: '旧形状' }])
  assert.equal(legacy.failed, 1, '缺 kind 的形状会被计成 failed —— 这正是要防的回归')
  assert.equal(legacy.coversToday, 0, '且 coversToday=0，auto-checkin 会反复重跑')

  console.log('claim-outcome-shape: 5 组断言通过（kind 分类 / credit / 幂等 / coversToday / 旧形状反证）')
}

/**
 * MonkeyCode 官方流协议回归（对照 chaitin/MonkeyCode 开源实现，2026-10-26）。
 *
 * 官方帧：`{type, data, kind, seq, timestamp}`，其中 `data` 是 **base64 编码**
 * 的 JSON（实测抓帧证实）。正文只在 `task-running` 且解码后
 * `update.sessionUpdate === 'agent_message_chunk'` 的 `content.text`；
 * 终止事件是 `task-ended`。此前的 `done/round/message/delta` 全是猜测值。
 */
export async function verifyMonkeyCodeOfficialProtocol() {
  const { parseTaskStreamEvent } = await import('../vendor/channel-pack/src/monkeycode-ws.ts')
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64')

  // 帧一律 JSON.stringify 构造 —— 模板串嵌套引号会构造出非法帧（实测踩过）。
  const frame = (data, extra = {}) => JSON.stringify({ type: 'task-running', data, ...extra })

  // 1) 正文：base64 data + agent_message_chunk
  const text = parseTaskStreamEvent(frame(b64({ sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好' } } }), { kind: 'agent_message_chunk' }))
  assert.equal(text.kind, 'text'); assert.equal(text.text, '你好', 'base64 data 解码出正文')

  // 2) 同是 task-running 但非正文类 sessionUpdate → 忽略
  for (const update of ['agent_thought_chunk', 'usage_update', 'available_commands_update']) {
    assert.equal(parseTaskStreamEvent(frame(b64({ update: { sessionUpdate: update, content: {} } }))).kind, 'ignore', `${update} 不是正文`)
  }

  // 3) 终止与错误（官方事件名）
  assert.equal(parseTaskStreamEvent('{"type":"task-ended"}').kind, 'done')
  const err = parseTaskStreamEvent('{"type":"task-error","data":"boom"}')
  assert.equal(err.kind, 'error')

  // 4) 心跳/游标忽略
  assert.equal(parseTaskStreamEvent('{"type":"ping"}').kind, 'ignore')
  assert.equal(parseTaskStreamEvent('{"type":"cursor","data":"{\\"cursor\\":\\"x\\"}"}').kind, 'ignore')

  // 5) 明文 JSON data 也收（防上游去编码）
  const plain = parseTaskStreamEvent(frame(JSON.stringify({ update: { sessionUpdate: 'agent_message_chunk', content: { text: 'OK' } } })))
  assert.equal(plain.kind, 'text'); assert.equal(plain.text, 'OK', '明文 JSON data 兼容')

  console.log('monkeycode-protocol: 5 组断言通过（base64 正文 / 非正文忽略 / task-ended / 心跳 / 明文兼容）')
}

/**
 * MonkeyCode 百智云桥接登录回归（对照 chaitin/MonkeyCode 的
 * desktop/src/baizhi/monkeycode.rs `login_monkeycode`）。
 *
 * 关键技巧：授权**页面** URL 改写成授权 **API** URL，纯 HTTP 走完 OIDC 链路。
 * 用本地假上游复现 4 跳：login → authorize(页面) → authorize(API) → callback。
 */
export async function verifyBaizhiBridge() {
  const http = await import('node:http')
  const { fetch: realFetch } = await import('undici')
  const { loginWithBaizhiSession } = await import('../vendor/channel-pack/src/monkeycode-auth.ts')
  const { MONKEYCODE } = await import('../vendor/channel-pack/src/monkeycode-product.ts')

  const seen = []
  let sawPageRewrite = false
  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    seen.push({ path: url.pathname, cookie: req.headers.cookie ?? '' })
    const send = (status, headers = {}) => {
      res.writeHead(status, { Connection: 'close', ...headers }).end('')
    }
    // 1) 起手：云端 /users/login → 302 到百智授权**页面**
    if (url.pathname === '/api/v1/users/login') {
      const target = `http://127.0.0.1:${port}/oauth/authorize?client_id=monkeycode-ai`
        + `&redirect_uri=${encodeURIComponent(`http://127.0.0.1:${port}/api/v1/users/baizhi/callback`)}`
        + '&response_type=code&scope=user+phone&state=test-state'
      send(302, { Location: target })
      return
    }
    // 2) 授权**页面**：真实链路里由页面 JS 改写成 API —— 我们期望客户端
    //    直接跳过它打 /api/v1/oauth/authorize，故这里若被请求说明改写没生效。
    if (url.pathname === '/oauth/authorize') {
      send(500)
      return
    }
    // 3) 授权 API：校验百智 cookie 后 302 回 callback
    if (url.pathname === '/api/v1/oauth/authorize') {
      if (!/baizhi_session=/.test(req.headers.cookie ?? '')) { send(401); return }
      sawPageRewrite = true
      send(302, { Location: `http://127.0.0.1:${port}/api/v1/users/baizhi/callback?code=tmp-code` })
      return
    }
    // 4) callback：种下 monkeycode_ai_session
    if (url.pathname === '/api/v1/users/baizhi/callback') {
      send(302, {
        Location: `http://127.0.0.1:${port}/`,
        'Set-Cookie': 'monkeycode_ai_session=3a47cb66-4a25-4e37-8d20-2eea2069c923; Path=/; HttpOnly',
      })
      return
    }
    // 4b) 授权完成后浏览器会停在根路径（真实链路 302 → mc 首页）
    if (url.pathname === '/') { send(200); return }
    // 5) 探活（loginWithCookie 会打钱包端点）
    if (url.pathname === '/api/v1/users/wallet') {
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
        .end(JSON.stringify({ code: 0, data: { id: '00000000-0000-0000-0000-000000000000', balance: 100 } }))
      return
    }
    send(404)
  })
  await new Promise(r => upstream.listen(0, '127.0.0.1', r))
  const port = upstream.address().port
  const product = { ...MONKEYCODE, apiBase: `http://127.0.0.1:${port}` }
  try {
    // ── 1. 缺 baizhi_session 时明确报错 ──
    await assert.rejects(
      () => loginWithBaizhiSession(realFetch, product, 'monkeycode_ai_session=xxx'),
      /百智云.*baizhi_session/,
      '粘贴非百智云 cookie 要明确提示',
    )
    // ── 2. 完整链路走通 ──
    const credential = await loginWithBaizhiSession(
      realFetch, product, 'baizhi_session=ok-123; sl-session=s', undefined,
      { baizhiBase: `http://127.0.0.1:${port}` },
    )
    assert.ok(sawPageRewrite, '授权页面必须被改写成 API（这是纯 HTTP 走通的关键）')
    assert.match(credential.access_token, /monkeycode_ai_session=3a47cb66/, '最终凭据带桥接得到的会话')
    assert.ok(typeof credential.account_id === 'string' && credential.account_id.length > 0, '身份从会话值派生')
    // ── 3. 页面那一跳不能被真的请求（改写生效的直接证据）──
    assert.equal(seen.some(row => row.path === '/oauth/authorize'), false, '不得请求授权页面本身')
    console.log('baizhi-bridge: 3 组断言通过（缺 cookie 报错 / 链路走通 / 页面改写生效）')
  } finally {
    upstream.close()
  }
}

/**
 * KukuAI 官方 SSE 协议回归（2026-10-26 实测帧序列）。
 *
 * 上游是按 `type` 分派的命名事件，正文只在 `TEXT_BLOCK_DELTA` 的 `data.delta`：
 * `USER_QUERY → REPLY_START → HINT_BLOCK → MODEL_CALL_START →
 *  TEXT_BLOCK_START → TEXT_BLOCK_DELTA* → TEXT_BLOCK_END →
 *  MODEL_CALL_END → REPLY_END → ACTUAL_POINT → TURN_DONE`
 *
 * 此前只认 content/text/data.content，上游一个都没有 ⇒ 正文永远空。
 */
export async function verifyKukuSseProtocol() {
  const { parseSseFrame, buildSendmsgBody } = await import('../vendor/channel-pack/src/kuku.ts')

  // 1) 正文只在 TEXT_BLOCK_DELTA 的 data.delta
  const delta = parseSseFrame(JSON.stringify({ type: 'TEXT_BLOCK_DELTA', data: { delta: '你好' } }))
  assert.deepEqual(delta, { kind: 'delta', text: '你好' })

  // 2) 结束事件
  for (const type of ['REPLY_END', 'TURN_DONE', 'DIALOGUE_END']) {
    assert.deepEqual(parseSseFrame(JSON.stringify({ type })), { kind: 'done' }, `${type} 是结束`)
  }

  // 3) 错误帧带明细
  const err = parseSseFrame(JSON.stringify({ type: 'ERROR', data: { error_code: 2800001, error_msg: 'task not found' } }))
  assert.equal(err.kind, 'error'); assert.match(err.message, /task not found/)

  // 4) 不携带正文的命名事件必须忽略（否则会把元数据当正文吐出去）
  for (const type of ['USER_QUERY', 'REPLY_START', 'HINT_BLOCK', 'MODEL_CALL_START', 'TEXT_BLOCK_START', 'TEXT_BLOCK_END', 'MODEL_CALL_END', 'ACTUAL_POINT']) {
    assert.equal(parseSseFrame(JSON.stringify({ type, data: { id: 'x' } })), undefined, `${type} 不携带正文`)
  }

  // 5) sendmsg：session_id 必须空串、且不得带 reply_id（实测报 invalid reply_id）
  const body = buildSendmsgBody({
    text: 'hi', model: 'auto', sessionId: 'ignored', replyId: 'ignored',
    clientSessionId: 'csi', deviceId: 'd', bdstoken: 'bt', uinfo: 'ui', uk: '42',
  })
  assert.equal(body.session_id, '', '新建会话 session_id 必须是空串')
  assert.equal('reply_id' in body, false, 'sendmsg 不得带 reply_id')
  const clientAdded = JSON.parse(body.data.client_added)
  assert.equal(clientAdded.bdstoken, 'bt', '三件套要内嵌进 client_added')
  assert.equal(clientAdded.uinfo, 'ui')
  assert.equal(clientAdded.uk, '42')
  assert.equal(clientAdded.app_id, 123971023, '客户端形态字段 app_id')
  assert.equal(clientAdded.channel, 'chunlei')

  console.log('kuku-sse: 5 组断言通过（TEXT_BLOCK_DELTA / 结束事件 / 错误帧 / 忽略元数据 / sendmsg 形态）')
}

/**
 * AutoClaw 目录并集回归（2026-10-26）。
 *
 * 上游目录接口下发的集合**不完整**：官方客户端有 4 个模型，目录只回 3 个，
 * 缺 `zai_glm-5.3-flash`（它在上游静态表 models.rs 里存在且实测可调用）。
 * 故 adapter 必须把远端与兜底表做**并集**，直接替换会吞掉第 4 个。
 */
export async function verifyAutoClawCatalogUnion() {
  const http = await import('node:http')
  const { fetch: realFetch } = await import('undici')
  const { AutoClawAdapter } = await import('../vendor/channel-pack/src/autoclaw-adapter.ts')
  const { AUTOCLAW } = await import('../vendor/channel-pack/src/autoclaw-product.ts')

  // 上游目录只回 3 个（模拟真实下发集合）
  const upstream = http.createServer((req, res) => {
    const send = (body) => res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' }).end(JSON.stringify(body))
    if (req.url.startsWith('/autoclaw-proxy/proxy/autoclaw-model-config')) {
      send({ models: [
        { id: 'zai_auto', name: 'Auto', contextWindow: 1048576 },
        { id: 'zai_auto-fast', name: 'Auto-Fast', contextWindow: 1048576 },
        { id: 'zaicoding_glm-5.3', name: 'GLM-5.3', contextWindow: 1048576 },
      ] })
      return
    }
    res.writeHead(404, { Connection: 'close' }).end('{}')
  })
  await new Promise(r => upstream.listen(0, '127.0.0.1', r))
  const product = { ...AUTOCLAW, apiBase: `http://127.0.0.1:${upstream.address().port}` }
  const adapter = new AutoClawAdapter({
    product,
    fetchImpl: realFetch,
    resolveCredential: async () => ({
      access_token: 'Bearer jwt-1234567890', refresh_token: 'r', expire_time: 0,
      account_id: 'a', nickname: 'n', created_at: 0, device_id: 'd',
    }),
  })
  try {
    const models = await adapter.listModels('autoclaw')
    const ids = models.map(m => m.id)
    assert.equal(ids.length, 4, `应合并出 4 个模型（远端 3 + 兜底补齐 1），实得 ${ids.length}：${ids.join(',')}`)
    assert.ok(ids.includes('zai_glm-5.3-flash'), '第 4 个模型 zai_glm-5.3-flash 必须保留（目录不下发但真实可用）')
    assert.ok(ids.includes('zai_auto'), '远端模型也要在')
    assert.equal(new Set(ids).size, ids.length, '不得有重复 id')
    console.log('autoclaw-catalog-union: 3 组断言通过（并集 4 个 / 补齐第 4 个 / 无重复）')
  } finally {
    upstream.close()
  }
}

/**
 * 自动签到的三处 P0 回归（2026-10-26 审计发现，均会静默失败）。
 *
 * 1) monkeycode：runCheckinWithCaptcha 收**单个 options 对象**，
 *    写成 (fetcher, product, credential) 会抛 TypeError —— 只有状态预检
 *    短路成 already-claimed 时才看不出来，于是「今天没签到时才炸」。
 * 2) kuku：签到必须用**自愈后的** Cookie（STOKEN 会过期），
 *    否则 taskComplete 回 errno:-6 未登录。
 * 3) officeace/autoclaw：必须进 refreshTargets，否则定时器永不续期
 *    （OfficeAce 的 STS 过期后所有请求 400）。
 */
export async function verifyCheckinP0Fixes() {
  const fs = await import('node:fs')
  const rpc = fs.readFileSync(new URL('../vendor/channel-pack/src/channel-pack-rpc.ts', import.meta.url), 'utf8')
  const kukuAuth = fs.readFileSync(new URL('../vendor/channel-pack/src/kuku-auth.ts', import.meta.url), 'utf8')
  const indexTs = fs.readFileSync(new URL('../vendor/channel-pack/src/index.ts', import.meta.url), 'utf8')

  // 1) monkeycode：必须用对象参数调用
  assert.match(
    rpc,
    /runMonkeyCodeCheckinWithCaptcha\(\s*\{\s*fetcher:/,
    'monkeycode 签到必须用单个 options 对象调用（位置参数会抛 TypeError）',
  )
  assert.equal(
    /runMonkeyCodeCheckinWithCaptcha\(codeartsFetcher,/.test(rpc),
    false,
    '不得再用位置参数调用',
  )
  assert.equal(
    /result\.status\?\./.test(rpc),
    false,
    '返回体只有 {ok,checkedIn}，不得读 result.status（TS2339）',
  )

  // 2) kuku：签到前必须先换发 STOKEN
  const claimBody = kukuAuth.slice(
    kukuAuth.indexOf('export async function claimKukuDailyCheckin'),
    kukuAuth.indexOf('export async function claimKukuDailyCheckin') + 3000,
  )
  assert.match(
    claimBody,
    /exchangeKukuStokenLive/,
    'kuku 签到必须先换发自愈后的 STOKEN（否则 errno:-6 未登录）',
  )
  assert.match(
    claimBody,
    /kukuHeaders\(product, working\)/,
    'kuku 签到请求要用换发后的凭据（working），不是原始 credential',
  )

  // 3) officeace / autoclaw 必须进续期表
  const targets = indexTs.slice(indexTs.indexOf('const refreshTargets'), indexTs.indexOf('async function refreshAllCredentials'))
  assert.match(targets, /\['officeace',/, 'officeace 必须进 refreshTargets（否则 STS 过期永不续期）')
  assert.match(targets, /\['autoclaw',/, 'autoclaw 必须进 refreshTargets')
  // 无 expires_at 时不能跳过续期（OfficeAce 实测无该字段）
  assert.match(
    indexTs,
    /expiresAt !== undefined && !shouldRefreshNow\(expiresAt\)\) continue/,
    '无 expires_at 的凭据必须照常续期，不能跳过',
  )

  console.log('checkin-p0: 7 组断言通过（monkeycode 对象参数 / 禁 result.status / kuku 自愈 / officeace+autoclaw 进续期表 / 无 expires_at 兜底）')
}

/**
 * 签到结果三态分类回归（2026-10-26 审计发现的误分类）。
 *
 * 判据总原则：**claimed**（真领到，含 credit 0 但上游明确成功）/
 * **already-claimed**（今天已经领过，幂等）/ **failed**（真的出错）。
 * 三类错判在自动签到这里都有真实后果：
 * - 把成功判成 failed → coversToday=0 → 每次启动都重跑；
 * - 把失败判成 already-claimed → 当天不再补救，用户以为领到了。
 */
export async function verifyClaimClassification() {
  const fs = await import('node:fs')
  const read = (name) => fs.readFileSync(new URL(`../vendor/channel-pack/src/${name}`, import.meta.url), 'utf8')
  const rpc = read('channel-pack-rpc.ts')

  // officeace：gained===undefined（余额读数没拿到，上游幂等回「已签到」）
  // 必须判 already-claimed，不能判 failed。
  const oaStart = rpc.indexOf('await claimBonus(codeartsFetcher')
  assert.ok(oaStart > 0, 'rpc 里必须有 claimBonus 的调用点')
  const oaBlock = rpc.slice(oaStart, oaStart + 1200)
  assert.match(oaBlock, /outcome\.gained === undefined[\s\S]{0,120}already-claimed/,
    'officeace gained=undefined 必须判 already-claimed')

  // autoclaw：「签到成功但无积分数」必须判 claimed（credit 0），不能判 failed。
  // ⚠️ 用「调用点」定位而不是 indexOf(函数名)：后者会命中注释里的提及
  // （实测第一个命中是说明文字，导致断言在空片段上失败）。
  const acStart = rpc.indexOf('await claimAutoclawDailyCheckin(')
  assert.ok(acStart > 0, 'rpc 里必须有 claimAutoclawDailyCheckin 的调用点')
  const acBlock = rpc.slice(acStart, acStart + 1400)
  assert.match(acBlock, /签到成功/,
    'autoclaw 必须识别「签到成功但无积分」这条文案')
  assert.match(acBlock, /kind: 'claimed', credit: 0/,
    'autoclaw「签到成功无积分」必须判 claimed(credit 0)，不能判 failed')

  // kuku：不得再用 reward >= 0 当成功判据（对 complete_status=FAIL 恒真）。
  const kukuAuth = read('kuku-auth.ts')
  // ⚠️ 只看**代码行**（去掉注释再判断）：`reward >= 0` 在注释里出现是正常的
  // （那正是说明为什么删掉它），不能因此判失败。
  const kukuCode = kukuAuth
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .join('\n')
  assert.equal(
    /reward >= 0/.test(kukuCode), false,
    'kuku 代码里不得再用 reward >= 0 判定成功（会把 complete_status=FAIL 误算成已领）',
  )
  assert.match(kukuAuth, /status === 'SUCCESS' \|\| status === 'BADGE_ALREADY_RECEIVED'\) succeeded \+= 1/,
    'kuku 只能凭显式 complete_status 判定成功')
  // kuku 的「今日无可领」也是今天没得领，不是失败（否则自动签到当天反复重跑）。
  assert.match(rpc, /今日无可领\|未返回可领取结果/,
    'kuku「上游未返回可领取结果」必须判 already-claimed，不能判 failed')

  // minimax / loomy：必须按 UTC+8 日界判断「今日」，不能依赖本机时区。
  const minimaxCredits = read('minimax-credits.ts')
  const loomyCredits = read('loomy-credits.ts')
  assert.match(minimaxCredits, /8 \* 60 \* 60 \* 1000|8 \* 3600 \* 1000|utc8|UTC\+8/i,
    'minimax 必须按 UTC+8 日界判断今日')
  // 字段名是 dailyCycleDate（服务端给的业务日），不是 dailyQuotaDate
  // ——任务描述里我写错了名字，t2 查证后用了正确字段。
  assert.match(loomyCredits, /dailyCycleDate/,
    'loomy 必须校验 dailyCycleDate（业务日），不能只看数值')
  assert.match(loomyCredits, /utc8DayKey/,
    'loomy 的日键必须按 UTC+8 换算，与账本口径一致')

  console.log('claim-classification: 6 组断言通过（officeace already-claimed / autoclaw claimed / kuku 显式 status / minimax UTC+8 / loomy dailyQuotaDate）')
}

/**
 * Qoder COSY 目录回归（2026-10-26，P0 修复 + 用户三点要求）。
 *
 * 用户要求：①远端**直接覆盖**兜底（不是并集）②模型名**必须带倍率**
 * ③「自动/平衡/快速」这类档位型用**中文名**。
 */
export async function verifyQoderCatalog() {
  const http = await import('node:http')
  const { fetch: realFetch } = await import('undici')
  const { QoderAdapter, parseQoderCatalog, qoderDisplayName } = await import('../vendor/channel-pack/src/qoder-adapter.ts')
  const { QODER } = await import('../vendor/channel-pack/src/qoder-product.ts')
  const { buildCosyHeaders, cosySignaturePath, encodeCosyBody } = await import('../vendor/channel-pack/src/qoder-cosy.ts')

  // ── 1. 签名路径与 COSY 头 ──
  assert.equal(cosySignaturePath('https://api3.qoder.sh/algo/api/v2/model/list?Encode=1'), '/api/v2/model/list')
  const headers = buildCosyHeaders(undefined, 'https://api3.qoder.sh/algo/api/v2/model/list?Encode=1', {
    userId: 'u1', authToken: 'tok', name: 'n', email: '', machineId: 'm1',
  })
  assert.match(headers.Authorization, /^Bearer COSY\.[A-Za-z0-9+/=]+\.[0-9a-f]{32}$/)
  assert.equal(headers['Cosy-Sigpath'], '/api/v2/model/list')
  assert.equal(headers['Cosy-Bodylength'], '0')
  assert.throws(() => buildCosyHeaders(undefined, 'https://x/algo/a', { userId: '', authToken: 't', name: '', email: '', machineId: 'm' }), /用户标识/)
  assert.throws(() => buildCosyHeaders(undefined, 'https://x/algo/a', { userId: 'u', authToken: '', name: '', email: '', machineId: 'm' }), /访问令牌/)

  // ── 2. body 编码可逆 ──
  const encoded = encodeCosyBody(Buffer.from('{"a":1}', 'utf8')).toString()
  assert.equal(encoded.length, Buffer.from('{"a":1}','utf8').toString('base64').length)
  assert.equal(/[+/=]/.test(encoded), false)

  // ── 3. 解析：id 取 key（不是 display_name）、倍率必须带出来 ──
  const parsed = parseQoderCatalog({ chat: [
    { key: 'auto', display_name: 'Auto', price_factor: 0.5, is_vl: true,
      context_config: { '200K': { token_count: 200000 }, '1M': { token_count: 1000000 } } },
    { key: 'gfmodel', display_name: 'GLM-5.3-Flash', price_factor: 0.1 },
    { key: 'freeone', display_name: 'FreeOne', price_factor: 0 },
    { key: 'dupkey', display_name: 'First' },
    { key: 'dupkey', display_name: 'Second' },
    { key: '', display_name: 'NoKey' },
    { key: 'noname' },
  ] })
  assert.equal(parsed.length, 4, '按 key 去重、跳过缺 key/缺名的')
  assert.equal(parsed[0].id, 'auto', '⚠️ id 必须取 key，不是 display_name 去空白')
  assert.equal(parsed[0].priceFactor, 0.5, '必须带出 price_factor')
  assert.equal(parsed[0].contextWindow, 1000000, '上下文取档位表最大档')
  assert.equal(parsed[2].priceFactor, 0, '⚠️ 0 是合法倍率（免费），不能被过滤')
  assert.equal(parsed[1].id, 'gfmodel', 'GLM 这类产品名 id 用 key')

  // ── 4. 展示名：档位型中文 + 倍率后缀 ──
  assert.equal(qoderDisplayName({ id: 'auto', name: 'Auto', contextWindow: 1, priceFactor: 0.5 }), '自动 · x0.5')
  assert.equal(qoderDisplayName({ id: 'efficient', name: 'Efficient', contextWindow: 1, priceFactor: 0.3 }), '快速 · x0.3')
  assert.equal(qoderDisplayName({ id: 'performance', name: 'Performance', contextWindow: 1, priceFactor: 1.1 }), '平衡 · x1.1')
  assert.equal(qoderDisplayName({ id: 'gfmodel', name: 'GLM-5.3-Flash', contextWindow: 1, priceFactor: 0.1 }), 'GLM-5.3-Flash · x0.1', '产品名不翻译')
  assert.equal(qoderDisplayName({ id: 'x', name: 'X', contextWindow: 1, priceFactor: 0 }), 'X · 免费', '0 倍率显示免费')
  // 无倍率字段 → 只显示名字，不编造 x1（用户明确要求）
  assert.equal(qoderDisplayName({ id: 'n', name: 'NoPrice', contextWindow: 1 }), 'NoPrice', '无倍率只显示名字')

  // ── 4b. 促销口径（对照 magpie @magpie-community/opencode-qoder-auth 的 rateOf/freeOf）──
  // 规则 1：`price_factor` 已是生效价，促销 active 时**不得**再拿 before×discount 重算
  //        （旧实现会重复打折，显示比实际更低的价）。
  // 窗口 22:00-08:00（UTC+8）；用固定「窗口内」时间验证。
  const inWindow = new Date('2026-10-26T23:30:00+08:00')
  const outWindow = new Date('2026-10-26T12:00:00+08:00')
  const promoModel = {
    id: 'promo', name: 'Promo', contextWindow: 1,
    priceFactor: 0.4, // 目录已在窗口内采集 → 折后价
    originalPriceFactor: 2,
    promotion: {
      active: true, beforePromotionPriceFactor: 2, discountFactor: 0.2,
      windowStart: '22:00', windowEnd: '08:00',
    },
  }
  assert.equal(
    qoderDisplayName(promoModel, inWindow), 'Promo · x2→x0.4',
    '窗口内：当前价用 price_factor(0.4)，不得重算成 before×discount(0.4 巧合相同，故用另一组验证)',
  )
  // 关键反例：price_factor 已是 0.4，若重算 before×discount 会得到 2×0.2=0.4 —— 巧合。
  // 用 discount=0.1 构造可区分的场景：price_factor=0.2（已折），重算会得 0.2 之外的值。
  const distinguish = { ...promoModel, priceFactor: 0.15, promotion: { ...promoModel.promotion, discountFactor: 0.1 } }
  assert.equal(
    qoderDisplayName(distinguish, inWindow), 'Promo · x2→x0.15',
    '⚠️ 防重复打折：必须用 price_factor(0.15)，不能用 before×discount(0.2)',
  )

  // 规则 2：`price_factor === 0` 且促销 active 且有原价 → **不是免费**，还原为 before×discount
  const zeroPromo = {
    id: 'zp', name: 'ZeroPromo', contextWindow: 1,
    priceFactor: 0,
    promotion: {
      active: true, beforePromotionPriceFactor: 2, discountFactor: 0.2,
      windowStart: '22:00', windowEnd: '08:00',
    },
  }
  assert.equal(
    qoderDisplayName(zeroPromo, inWindow), 'ZeroPromo · x2→x0.4',
    '⚠️ 促销中的 0 不是免费，真实价是 before×discount(0.4)',
  )
  // 规则 3：`price_factor === 0` 且无进行中促销 → 真免费
  const trueFree = { id: 'tf', name: 'TrueFree', contextWindow: 1, priceFactor: 0, originalPriceFactor: 0.1 }
  assert.equal(qoderDisplayName(trueFree, inWindow), 'TrueFree · 免费', '无促销的 0 才是真免费')
  // 规则 4：窗口外按**原价**计费并显示原价，不显示划线
  //（price_factor 若在窗口内采集则是折后快照，窗口外直接用会误导用户按低价预期）
  assert.equal(
    qoderDisplayName(promoModel, outWindow), 'Promo · x2',
    '窗口外：必须显示原价 x2，不能显示折后快照 x0.4',
  )

  // ── 5. 倍率必须以**远端**为准（兜底表是采集时快照，会过期）──
  // 实测差异：qmodel_38max 远端 0.5/兜底 0.2、kmodel_latest 1/1.4、
  // dfmodel 0(免费)/0.1、mmodel 0.1/0.2。
  const ad2 = new QoderAdapter({
    product: { ...QODER, fallbackModels: [
      { id: 'dfmodel', name: 'DeepSeek-Flash', contextWindow: 1000, priceFactor: 0.1 },
    ] },
    fetchImpl: async () => new Response(JSON.stringify({ chat: [
      { key: 'dfmodel', display_name: 'DeepSeek-Flash', price_factor: 0 },
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    resolveCredential: async () => ({ security_oauth_token: 's', access_token: 't', machine_id: 'm', uid: 'u' }),
    refresh: async () => {},
  })
  await ad2.warmCatalog()
  const all2 = ad2.listAllModels()
  assert.equal(all2.length, 1)
  assert.match(all2[0].name, /免费/, '⚠️ 倍率必须用远端的 0（免费），不是兜底的 0.1')
  const resolved2 = await ad2.resolveModel('qoder', 'dfmodel')
  assert.match(resolved2.name, /免费/, 'resolveModel 也必须带远端倍率（否则会话内看不到倍率）')

  // ── 6. 远端直接覆盖兜底（不是并集）──
  const upstream = http.createServer((req, res) => {
    const send = (body) => res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' }).end(JSON.stringify(body))
    if (req.url.startsWith('/algo/api/v2/model/list')) {
      if (!String(req.headers.authorization ?? '').startsWith('Bearer COSY.')) { res.writeHead(403, { Connection: 'close' }).end('{}'); return }
      send({ chat: [{ key: 'onlyremote', display_name: 'OnlyRemote', price_factor: 1 }] })
      return
    }
    res.writeHead(404, { Connection: 'close' }).end('{}')
  })
  await new Promise(r => upstream.listen(0, '127.0.0.1', r))
  const product = { ...QODER, catalogBase: `http://127.0.0.1:${upstream.address().port}` }
  const adapter = new QoderAdapter({
    product, fetchImpl: realFetch,
    resolveCredential: async () => ({ security_oauth_token: 's', access_token: 'tok', machine_id: 'm1', uid: 'u1', nickname: 'n' }),
    refresh: async () => {},
  })
  try {
    const models = await adapter.listModels(product.id)
    assert.equal(models.length, 1, '⚠️ 覆盖语义：远端 1 个就是 1 个，不并兜底 17 个')
    assert.equal(models[0].id, 'onlyremote')
    console.log('qoder-catalog: 5 组断言通过（签名/COSY 头 / body 编码 / id=key+倍率 / 中文名+倍率后缀 / 覆盖语义）')
  } finally {
    upstream.close()
  }
}

/**
 * 远端目录**字段完整性**回归（2026-10-27）。
 *
 * 用户报障：「从远端拉取，但倍率、推理强度没有」。根因不是没拉，而是
 * 各渠道的解析器只提取 `{id, name}`，把上游确实下发的字段丢了。
 *
 * 本套件用**真实上游响应形状**（逐字取自实测抓包）校验四个渠道：
 * - kuku：`cost_ratio`（倍率）+ `think_list`（思考档位）
 * - accio：`usageMultiple`（倍率，`null` 表示无）+ `modelDisplayNameCn`
 * - autoclaw：`creditConsumptionLevel`（按量计费分档）+ `reasoningLevel`
 * - monkeycode：`input_price`（按量计费单价）+ `is_free`
 *
 * ⚠️ 断言的是「不编造」：没有倍率字段时**不能**显示 `x1`，
 * 按量计费的单价**不能**当成倍率。
 */
export async function verifyRemoteCatalogFields() {
  const assert = (await import('node:assert/strict')).default
  const { parseKukuCatalog, kukuDisplayName } = await import('../vendor/channel-pack/src/kuku-adapter.ts')
  const { accioDisplayName } = await import('../vendor/channel-pack/src/accio-adapter.ts')
  const { parseModelConfig } = await import('../vendor/channel-pack/src/autoclaw.ts')
  const { autoClawDisplayName } = await import('../vendor/channel-pack/src/autoclaw-adapter.ts')
  const { monkeyCodeDisplayName } = await import('../vendor/channel-pack/src/monkeycode-adapter.ts')

  // ── kuku：cost_ratio 是倍率字符串，think_list 是全局档位表 ──
  const kuku = parseKukuCatalog({
    model_list: [
      { id: '1', model_name: 'auto', display_name: 'Auto', description: '', cost_ratio: '', vip_type: 0 },
      { id: '2', model_name: 'gw-deepseek', display_name: 'DeepSeek-V4.1-Flash', description: '快', cost_ratio: '0.16x', vip_type: 0 },
      { id: '10', model_name: 'ms-kimi-k3', display_name: 'Kimi-K3', description: '', cost_ratio: '3.60x', vip_type: 1 },
    ],
    think_list: [
      { id: '1', think_name: '低', description: '快速问答' },
      { id: '3', think_name: '高', description: '专业办公场景（默认）' },
    ],
    default_think_id: '3',
  })
  assert.equal(kuku.models.length, 3, 'kuku 按 model_name 取 id')
  assert.equal(kuku.models[0].id, 'auto', 'kuku id 用 model_name 不是数字 id')
  assert.equal(kuku.models[0].priceFactor, undefined, '⚠️ cost_ratio 为空 → 无倍率（不编造 x1）')
  assert.equal(kukuDisplayName(kuku.models[0]), 'Auto', '无倍率只显示名字')
  assert.equal(kuku.models[1].priceFactor, 0.16, 'cost_ratio "0.16x" 解析成 0.16')
  assert.equal(kukuDisplayName(kuku.models[1]), 'DeepSeek-V4.1-Flash · x0.16')
  assert.equal(kuku.models[2].vipOnly, true, 'vip_type=1 标记会员专属')
  assert.equal(kuku.thinkLevels.length, 2, 'think_list 解析成档位表')
  assert.deepEqual(kuku.thinkLevels.map(l => l.name), ['低', '高'])
  assert.equal(kuku.defaultThinkId, '3', '默认档来自 default_think_id')

  // ── accio：usageMultiple 是倍率，null 表示上游未下发 ──
  assert.equal(accioDisplayName({ name: 'GPT 6 Astra', priceFactor: 3.5 }), 'GPT 6 Astra · x3.5')
  assert.equal(accioDisplayName({ name: 'auto', nameCn: '自动' }), '自动', '中文名优先')
  assert.equal(accioDisplayName({ name: 'x', priceFactor: 0 }), 'x · 免费', '0 倍率是免费')
  assert.equal(accioDisplayName({ name: 'y' }), 'y', '⚠️ 无倍率不显示 x1')

  // ── autoclaw：按量计费分档，不是数字倍率 ──
  const ac = parseModelConfig([
    { id: 'zai_auto', name: 'Auto', reasoning: true, contextWindow: 1048576, maxTokens: 393216,
      creditConsumptionLevel: '低', reasoningLevel: ['low', 'high', 'max'], tooltip: '自动选模型',
      metadata: { timeout: '7200' } },
    { id: 'zai_auto-fast', name: 'Auto-Fast', creditConsumptionLevel: '中',
      metadata: { forbiddenNotice: { title: '限时权益已用完', desc: '免费额度已用完，24 小时后重置' } } },
    { id: 'zaicoding_glm-5.3', name: 'GLM-5.3', creditConsumptionLevel: '高',
      metadata: {
        __pricingPromotion: { badge: '限时半价', enabled: true, scope: ['autoLegal'] },
        forbiddenNotice: { title: '限时权益已用完', desc: 'GLM5.3 免费额度已用完' },
      } },
    { id: 'zai_glm-5.3-flash', name: 'GLM-5.3-Flash', creditConsumptionLevel: '低' },
  ])
  assert.equal(ac.length, 4)
  assert.equal(ac[0].creditLevel, '低', 'creditConsumptionLevel 是分档标签')
  assert.deepEqual(ac[0].efforts, ['low', 'high', 'max'], 'reasoningLevel 解析成思考档位')
  assert.equal(ac[0].supportsThinking, true)
  assert.equal(ac[0].tooltip, '自动选模型')
  // ⚠️ 上游只给「低/中/高」标签，无数字倍率 —— 展示层不得换算成 x0.5。
  assert.equal(autoClawDisplayName(ac[0]), 'Auto · 低')
  assert.equal(autoClawDisplayName(ac[1]), 'Auto-Fast · 中 · 额度用完', 'forbiddenNotice 存在 = 该模型额度用完')
  assert.equal(ac[1].quotaExhausted, true)
  assert.equal(ac[1].quotaNotice, '免费额度已用完，24 小时后重置')
  assert.equal(autoClawDisplayName(ac[2]), 'GLM-5.3 · 高 · 限时半价 · 额度用完',
    '促销用上游文案，不推断成 x0.5')
  assert.equal(ac[2].promotion, '限时半价')
  assert.equal(autoClawDisplayName(ac[3]), 'GLM-5.3-Flash · 低', '无促销无告警时只有两段')
  assert.equal(ac[3].quotaExhausted, undefined, '缺失 forbiddenNotice → 不是用完状态')

  // ── monkeycode：input_price 换算成**相对倍率**（1000 = x1）──
  // 用户 2026-10-27 口径：只体现模型间倍率差异，不显示绝对积分。
  assert.equal(monkeyCodeDisplayName({ name: 'a', inputPrice: 1000 }), 'a · x1', '1000 是基准 x1')
  assert.equal(monkeyCodeDisplayName({ name: 'b', inputPrice: 800 }), 'b · x0.8')
  assert.equal(monkeyCodeDisplayName({ name: 'c', inputPrice: 600 }), 'c · x0.6')
  assert.equal(monkeyCodeDisplayName({ name: 'd', inputPrice: 400 }), 'd · x0.4')
  assert.equal(monkeyCodeDisplayName({ name: 'e', inputPrice: 200 }), 'e · x0.2')
  assert.equal(monkeyCodeDisplayName({ name: 'f', inputPrice: 0 }), 'f · x0', '0 也如实换算')
  assert.equal(monkeyCodeDisplayName({ name: 'glm-5', isFree: false }), 'glm-5', '⚠️ 无 input_price 不编造 x1')
  assert.equal(monkeyCodeDisplayName({ name: 'free-one', isFree: true }), 'free-one · 免费')

  console.log('remote-catalog-fields: 4 渠道断言通过（kuku 倍率+档位 / accio 倍率+中文名 / autoclaw 积分分档+档位 / monkeycode 不掉价）')
}
