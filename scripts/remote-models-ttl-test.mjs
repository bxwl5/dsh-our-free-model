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
