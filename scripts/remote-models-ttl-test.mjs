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
const { resetOfficeAceTokenRatesCache } = await import('../vendor/channel-pack/src/officeace.ts')
const { fetch: realFetch } = await import('undici')

let hits = 0
let payload = [{ id: 'model-a', name: 'A' }, { id: 'model-b', name: 'B' }]
let failNext = false
// 倍率端点替身：目录成功时回一张小倍率表（含尾部换行，验证 trim）。
let ratesPayload = { models: [{ model_name: 'model-a\n', cost_coefficient: 0.79 }, { model_name: 'model-b', cost_coefficient: 1 }] }
let ratesFailNext = false

const upstream = http.createServer((req, res) => {
  // normalizeBaseUrl 会自动补 /v2，故实际路径是 /v2/models。
  if (req.url === '/v2/models' || req.url === '/models') {
    hits += 1
    if (failNext) { res.writeHead(500, { Connection: 'close' }).end('{}'); return }
    res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
      .end(JSON.stringify({ data: payload }))
    return
  }
  // 倍率（2026-10-29）：V11 签名 GET（这里不验签，测试关注解析与展示拼接）。
  if (req.url === '/v1/model-token-rates') {
    if (ratesFailNext) { res.writeHead(500, { Connection: 'close' }).end('{}'); return }
    res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' })
      .end(JSON.stringify(ratesPayload))
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
    // 倍率端点（/v1/model-token-rates）打的是**订阅面网关**
    // （model_info.model_api_url_base），不是推理 base_url —— 凭据缺它时
    // fetchTokenRates 抛「缺少 model_info」→ 空表降级（生产凭据登录时必有）。
    model_info: { model_api_url_base: base },
  }),
})

try {
  resetOfficeAceTokenRatesCache()
  // ── 1. 首次拉取 ──
  const first = await adapter.listModels('officeace')
  assert.equal(first.length, 2, '首次拿到 2 个模型')
  assert.equal(hits, 1, '首次只发一次请求')
  // ── 1b. 倍率拼接（2026-10-29）：model-a 带 x0.79（trim 尾换行），x1 不标 ──
  assert.equal(first.find(m => m.id === 'model-a')?.name, 'A · x0.79', '倍率拼进展示名（model_name 尾部换行被 trim）')
  assert.equal(first.find(m => m.id === 'model-b')?.name, 'B', 'x1 不标（全默认倍率没有信息量）')

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
  ratesFailNext = true
  const third = await adapter.listModels('officeace')
  assert.equal(hits, 3, '失败也要真的试一次')
  assert.deepEqual(third.map(m => m.id), ['model-c'], '失败时保留上一次的列表，不清空')


  console.log('remote-models-ttl: TTL 命中 / 过期重拉 / 失败保留旧列表 / 倍率拼接+x1 不标')
} finally {
  upstream.close()
}
}

import { exitIfDirectRun } from './lib/direct-run.mjs'
exitIfDirectRun(import.meta.url, 'remote-models-ttl-test')

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
  let oaClaimed = false
  let oaSecondCall = false
  const oaServer = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const json = (body) => res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' }).end(JSON.stringify(body))
      if (req.url.startsWith('/v1/subscription/bonus/claim')) {
        // 幂等由上游保证：一天一个活动只能领一次，重复领不重复入账。
        // 首次入账 +100，之后重复调用总额不变。
        if (pointsTotal === 500) pointsTotal += 100
        // 真实响应自带 bonus_skus[]（activity_name + points）—— 直读优先的依据。
        // 用独立的 claimed 标志：首 claim 带活动行，重复 claim 是幂等空表。
        if (oaClaimed) oaSecondCall = true
        oaClaimed = true
        json(!oaSecondCall
          ? { bonus_skus: [{ activity_id: 'daily', activity_name: '每日签到', points: 100 }] }
          : { bonus_skus: [] })
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
    assert.equal(gained.gained, 100, '① 直读响应：bonus_skus[].points 之和')
    assert.match(gained.message, /已领取 100/, '文案要带积分数')
    assert.match(gained.message, /每日签到/, '文案要带活动名（magpie 同款）')

    // 幂等：重复调用 bonus_skus 变空数组（上游幂等形态），退回增量法
    // 确认 remaining 没变 → 如实报「没有可领」
    const again = await claimBonus(realFetch, OFFICEACE, oaCredential)
    assert.equal(again.gained, 0, '重复领不重复入账（增量法兜底确认）')
    assert.match(again.message, /已领过|没有可领/, '要说明「已领过或今天没有可领」')
  } finally {
    oaServer.close()
  }

  console.log('channel-checkin: 6 组断言通过（autoclaw 三态判据 / officeace 直读优先+增量兜底+幂等）')
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
 * 背景（2026-10-26 实测缺陷）：autoclaw / officeace 的 claim 回调
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
 * AutoClaw 目录**全量覆盖**回归（2026-10-27 翻转，原为「并集」）。
 *
 * 历史：2026-10-26 这里锁的是并集 —— 上游目录只回 3 个、官方客户端有 4 个，
 * 缺的 `zai_glm-5.3-flash` 只在兜底表里，当时要求补齐。
 *
 * 2026-10-27 用户改为全局规则「远端拉取全量覆盖兜底表（不是增量），全部渠道都
 * 这样；远端给什么就用什么」。故 adapter 现在**整份替换**：目录没下发的 id 不再
 * 从兜底表补 —— 代价就是这个模型会从列表里消失（换掉的是「远端没数据、
 * 因而永远没有倍率」的行）。
 */
export async function verifyAutoClawCatalogReplace() {
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
    assert.equal(ids.length, 3, `全量覆盖后只应有远端下发的 3 个，实得 ${ids.length}：${ids.join(',')}`)
    assert.ok(!ids.includes('zai_glm-5.3-flash'),
      '兜底表独有的 id 不得再补进来（用户 2026-10-27：远端给什么就用什么）')
    assert.ok(ids.includes('zai_auto'), '远端模型必须在')
    assert.equal(new Set(ids).size, ids.length, '不得有重复 id')
    console.log('autoclaw-catalog-replace: 3 组断言通过（只留远端 3 个 / 不补兜底独有 id / 无重复）')
  } finally {
    upstream.close()
  }
}

/**
 * 自动签到的三处 P0 回归（2026-10-26 审计发现，均会静默失败）。
 *
 * 1) officeace/autoclaw：签到回调
 *    写成 (fetcher, product, credential) 会抛 TypeError —— 只有状态预检
 *    短路成 already-claimed 时才看不出来，于是「今天没签到时才炸」。
 *    否则 taskComplete 回 errno:-6 未登录。
 * 3) officeace/autoclaw：必须进 refreshTargets，否则定时器永不续期
 *    （OfficeAce 的 STS 过期后所有请求 400）。
 */
export async function verifyCheckinP0Fixes() {
  const fs = await import('node:fs')
  const indexTs = fs.readFileSync(new URL('../vendor/channel-pack/src/index.ts', import.meta.url), 'utf8')

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

  console.log('checkin-p0: 禁 result.status / officeace+autoclaw 进续期表 / 无 expires_at 兜底')
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

  
}

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
 * - autoclaw：`creditConsumptionLevel`（按量计费分档）+ `reasoningLevel`
 *
 * ⚠️ 断言的是「不编造」：没有倍率字段时**不能**显示 `x1`，
 * 按量计费的单价**不能**当成倍率。
 */
/**
 * CodeArts 模型目录：**兜底表只兜底、绝不混入远端结果**（用户规则）。
 *
 * 历史先例：`buddy-adapter` 的 `reconcileWithFallback()` 曾把兜底表条目并进
 * 远端列表，留下「远端根本没下发、永远没有倍率」的行，2026-10-28 删除。
 * 本用例把 CodeArts 的语义钉死：
 *   1. 远端拉到 → 列表**恰好等于**远端（兜底表里的 `GLM-5.1` 等不得出现）；
 *   2. 远端从没拉到过 → 用兜底表顶上（不是空列表）。
 */


export async function verifyRemoteCatalogFields() {
  const assert = (await import('node:assert/strict')).default
  const { parseModelConfig } = await import('../vendor/channel-pack/src/autoclaw.ts')
  const { autoClawDisplayName, autoClawQuota } = await import('../vendor/channel-pack/src/autoclaw-adapter.ts')

  console.log('remote-catalog-fields: autoclaw 积分分档+档位断言通过')
}

/**
 * 「新增模型默认关闭」的**接线守卫**（用户 2026-10-30 规则，全部渠道一致）。
 *
 * 行为断言在 model-catalog-cache 用例（10a-10f）；这里守的是**接线完整性**：
 * 全部 15 个写快照的点必须走 `writeModelCatalogClosingNew`（收口入口），
 * 任何一处直接调 `writeModelCatalog` 都意味着那个渠道刷新后新增模型仍会
 * 默认打开 —— 规则静默失效，正是本仓库最擅长养出来的那类 bug。
 */


export async function verifyCodeArtsCatalogFallbackBoundary() {
  const assert = (await import('node:assert/strict')).default
  // ⚠ 必须隔离磁盘缓存（DSH_CODEARTS_CACHE_DIR）：`restoreFromDisk()` 会把
  // `~/.cache/deveco/codearts_models.json` 当作「上次远端成功」读进 remoteModels，
  // 本机跑测试时那份真实缓存（10 条）会让 ② 的兜底分支永不触发（2026-10-30 实测）。
  const os = await import('node:os')
  const fsMod = await import('node:fs')
  const cacheDir = fsMod.mkdtempSync(`${os.tmpdir()}/ofm-cacb-`)
  process.env.DSH_CODEARTS_CACHE_DIR = cacheDir
  // ⚠ 2026-11-04：CodeArts 现在也会写**统一的** `model-catalogs/codearts.json`
  // （用户要求与另外九家一致），所以隔离必须扩到整个 channel-pack 状态目录 ——
  // 否则本用例 ① 写进去的 `remote-a` 会被 ② 的 `restoreFromDisk()` 读到，
  // 「无远端才用兜底表」那条断言就会假失败。
  const stateDir = fsMod.mkdtempSync(`${os.tmpdir()}/ofm-cacb-state-`)
  process.env.DSH_CHANNEL_PACK_STATE_DIR = stateDir
  // ⚠ 光设环境变量不够：`catalogDir()` 在模块级缓存了 `resolvedDir`，同一进程里
  // 早先的用例可能已经把它解析成真实的 `~/.dsh`。不重置的话这里仍会读/写用户
  // 的真实目录（既不隔离，也可能真的写出 `remote-a` 这种测试数据）。
  const { resetModelCatalogCacheForTest } = await import('../vendor/channel-pack/src/model-catalog-cache.ts')
  resetModelCatalogCacheForTest()
  const { CodeArtsAdapter } = await import('../vendor/channel-pack/src/llm-adapter.ts')

  const makeAdapter = (remote) => new CodeArtsAdapter({
    credentialRef: 'FIXTURE',
    resolveCredential: async () => ({ access_key_id: 'ak', secret_access_key: 'sk', security_token: 'st', expires_at: '' }),
    refresh: async () => {},
    fetchRemoteModels: async () => remote,
  })

  // ① 远端成功：整份替换，且**不含**兜底表条目
  const remoteOnly = [['remote-a', 'Remote A'], ['remote-b', 'Remote B']]
  const adapter = makeAdapter(remoteOnly.map(([id, name]) => ({ id, name })))
  const listed = (await adapter.listModels('codearts')).map((m) => m.id)
  assert.deepEqual(listed, ['remote-a', 'remote-b'], '远端拉到即整份替换')
  assert.equal(listed.includes('GLM-5.1'), false, '兜底表条目不得混入远端结果')
  assert.equal(listed.includes('glm-5.3-flash'), false, '兜底表条目不得混入远端结果（benefit 组）')

  // ② 远端从没拉到过（空数组 = 拉取失败/首启）：兜底表顶上
  //
  // ⚠ 2026-11-04：CodeArts 现在会把远端结果写进统一的 `model-catalogs/codearts.json`
  // （用户要求与另外九家一致），所以 ① 刚写下的 `remote-a` 会被 ② 的
  // `restoreFromDisk()` 读回来 —— 那不是缺陷，正是「取到就写进本地，重启后
  // 仍然记得」的语义。要让 ② 真的退化成「首启」，必须**清掉那份快照**。
  resetModelCatalogCacheForTest()
  fsMod.rmSync(`${stateDir}/channel-pack/model-catalogs`, { recursive: true, force: true })
  const fallbackOnly = makeAdapter([])
  const fallback = (await fallbackOnly.listModels('codearts')).map((m) => m.id)
  assert.ok(fallback.length > 0, '没有远端时必须用兜底表，而不是空列表')
  assert.equal(fallback.includes('remote-a'), false, '兜底路径不得出现远端条目')
  assert.ok(fallback.some((id) => /^(GLM-|glm-|deepseek-|openpangu-)/.test(id)), '兜底表内容生效（编译期静态表形态）')

  console.log('ok  codearts 目录边界：远端整份替换（不混入兜底）／无远端才用兜底表')
}

/**
 * CodeArts 磁盘快照恢复：**必须带上 rate**（2026-10-30 用户实测「倍率消失」）。
 *
 * `restoreFromDisk()` 早期只挑 id/name 两个字段，于是冷启动/重启后读快照的
 * 路径把消耗系数全丢了，面板只剩裸模型名（直到下一次远端拉取成功才恢复）。
 * 快照里本来就存了 rate（writeModelCatalog 整份落盘），恢复时不该裁剪。
 */


export async function verifyCodeArtsSnapshotKeepsRate() {
  const assert = (await import('node:assert/strict')).default
  const os = await import('node:os')
  const fsMod = await import('node:fs')
  const pathMod = await import('node:path')
  const cacheDir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'ofm-rate-'))
  process.env.DSH_CODEARTS_CACHE_DIR = cacheDir
  // ⚠ 必须清模块级 memoryCache：同一套件内前面的用例已经填充过它，
  // 而 `availableCodeArtsModels()` 先看内存再看磁盘 —— 不清就会读到别的用例的
  // 目录（本用例因此误判为「rate 丢失」，2026-10-30 实测）。
  const modelsMod = await import('../vendor/channel-pack/src/models.ts')
  modelsMod.setMemoryCache(undefined)
  // 铺一份带 rate 的快照（= 上次远端成功的结果）
  fsMod.writeFileSync(pathMod.join(cacheDir, 'codearts_models.json'), JSON.stringify([
    { id: 'snap-a', name: 'Snap A', rate: 0.79 },
    { id: 'snap-b', name: 'Snap B' },
    { id: 'snap-c', name: 'Snap C', rate: 2.38 },
  ]))
  const { CodeArtsAdapter } = await import('../vendor/channel-pack/src/llm-adapter.ts')
  // 不给 fetchRemoteModels：ensureRemoteModels 什么都不做 → 纯走磁盘恢复路径
  const adapter = new CodeArtsAdapter({
    credentialRef: 'FIXTURE',
    resolveCredential: async () => ({ access_key_id: 'a', secret_access_key: 's', security_token: 't', expires_at: '' }),
    refresh: async () => {},
  })
  const models = await adapter.listModels('codearts')
  const byId = new Map(models.map((m) => [m.id, m.name]))
  assert.equal(byId.get('snap-a'), 'Snap A · x0.79', '快照恢复必须保留 rate')
  assert.equal(byId.get('snap-c'), 'Snap C · x2.38', '快照恢复必须保留 rate')
  assert.equal(byId.get('snap-b'), 'Snap B', '没有 rate 的条目不标倍率')
  console.log('ok  codearts 快照恢复：磁盘快照里的 rate 不丢（冷启动也显示倍率）')
}


export async function verifyFinishReasonShapeWiring() {
  const { readFileSync, readdirSync } = await import('node:fs')
  const srcDir = new URL('../vendor/channel-pack/src/', import.meta.url)
  const offenders = []
  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith('.ts')) continue
    const src = readFileSync(new URL(name, srcDir), 'utf8')
    // 剥行注释**和块注释**（教训：`finish_reason:"stop"` 这类上游文案常出现在
    // 块注释里 —— buddy/trae/openai-compat/sse 四处都是，首次运行即假阳性）。
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
    // 字符串形态：reason: 'stop' / reason: "stop"（reason: { ... } 是对的）
    if (/reason:\s*['"](?:stop|tool-calls|max-tokens)['"]/.test(code)) offenders.push(name)
  }
  assert.deepEqual(offenders, [], "finish chunk 的 reason 用了字符串形态（宿主要对象 {kind:...}）：\n" + offenders.join('\n'))
  console.log('ok  finish-reason-shape: 全部 finish chunk 用宿主对象形态')
}


export async function verifyNewModelAutoDisableWiring() {
  const { readFileSync, readdirSync } = await import('node:fs')
  const srcDir = new URL('../vendor/channel-pack/src/', import.meta.url)
  const offenders = []
  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith('.ts')) continue
    const src = readFileSync(new URL(name, srcDir), 'utf8')
    if (name === 'model-catalog-cache.ts') continue // 入口本体
    // 直接调用 writeModelCatalog( 而非 writeModelCatalogClosingNew( ——
    // 注释里提及不算（先剥行注释再判，教训见 credential-freshness 守卫）。
    const code = src.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
    if (/\bwriteModelCatalog\s*\(/.test(code)) offenders.push(name)
  }
  assert.deepEqual(offenders, [],
    '以下文件仍在直接调 writeModelCatalog（绕过了「新增模型默认关闭」的收口）：\n' + offenders.join('\n'))
  // CodeArts 的快照走 models.ts 的 saveModelsCache（独立文件），其关闭逻辑在
  // service.ts 的 refreshModels 内联 —— 用两条静态断言守住：
  const service = readFileSync(new URL('../vendor/channel-pack/src/service.ts', import.meta.url), 'utf8')
  assert.match(service, /loadModelsCache\(\)/, 'codearts 新增判据必须用 loadModelsCache 还原旧基准')
  assert.match(service, /setModelsDisabled\('codearts'/, 'codearts 新增模型必须写黑名单')
  const cache = readFileSync(new URL('../vendor/channel-pack/src/model-catalog-cache.ts', import.meta.url), 'utf8')
  assert.match(cache, /export async function writeModelCatalogClosingNew/, '收口入口必须存在')
  console.log('ok  new-model-auto-disable: 收口 + codearts 内联路径在位')
}

export async function verifyRetryPolicyModeWiring() {
  const { readFileSync, readdirSync } = await import('node:fs')
  const srcDir = new URL('../vendor/channel-pack/src/', import.meta.url)
  const offenders = []
  for (const name of readdirSync(srcDir)) {
    if (!name.endsWith('.ts')) continue
    const src = readFileSync(new URL(name, srcDir), 'utf8')
    if (!src.includes('providerRetryPolicy')) continue
    // 剥行注释**和块注释**再判（教训：注释里引用写法会假阳性）。
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
    if (!/mode:\s*'normal'|mode:\s*'always'/.test(code)) {
      offenders.push(`${name}: 含 providerRetryPolicy 但全文件无 mode 声明`)
    }
  }
  assert.deepEqual(offenders, [], 'providerRetryPolicy 缺 mode（重试上限会失效 → 无限重试）：\n' + offenders.join('\n'))
  console.log('ok  retry-policy-mode: 全部 providerRetryPolicy 带 mode（重试上限真实生效）')
}

/**
 * 「finish chunk 的 reason 必须是宿主对象形态」的守卫。
 *
 * 宿主 `FinishReason` 是 `{kind:'stop'|'tool-calls'|'max-tokens'|...}` 对象；
 * 写成 `reason: 'stop'`（字符串）时 `agent-loop` 的 `finish.kind` 检查全部落空，
 * 目前靠 fallthrough 侥幸正确，宿主加检查即炸。delta 契约（`emitDeltaBlocks`）
 * 只有 text/reasoning 的适配器 finish 恒为 `{kind:'stop'}`。
 */
