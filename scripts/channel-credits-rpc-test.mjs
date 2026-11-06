import assert from 'node:assert/strict'
import { exitIfDirectRun } from './lib/direct-run.mjs'

/** 使用实际已打包 RPC，只提供账号池 ref，禁止真实网络与旧单凭据回退。 */
export async function verifyChannelCreditsRpc({ ctx, call, creds }) {
  const originalFetch = globalThis.fetch
  const providers = ['buddy', 'workbuddy', 'qoder', 'qodercn', 'loomy', 'minimax', 'zcode', 'antigravity']
  let quotaRequests = 0, quotaFailed = true
  const originalResolve = ctx.credentials.resolve
  const resolvedRefs = []
  ctx.credentials.resolve = async ref => { resolvedRefs.push(ref); return originalResolve(ref) }
  try {
    for (const provider of providers) {
      const ref = `FIXTURE_CREDITS_${provider.toUpperCase()}`
      creds.set(ref, { value: JSON.stringify({
        access_token: 'fixture-credits-token', token_type: 'Bearer', user_id: 'fixture-user',
        zcode_jwt: 'fixture-credits-jwt', device_mid: 'fixture-device', account_label: '隔离账号',
      }) })
      await ctx.accountPool.addAccount({
        id: `fixture-credits-${provider}`, provider, nickname: '隔离账号',
        credentialRef: ref, enabled: true, refreshable: false, createdAt: 1,
      })
    }
    globalThis.fetch = async input => {
      const pathname = new URL(String(input)).pathname
      let body
      if (pathname.includes('get-user-resource')) {
        body = { code: 0, data: { Response: { Data: { Accounts: [{
          PackageName: 'fixture', CycleCapacityRemain: 123, Status: 1,
        }] } } } }
      } else if (pathname.includes('/me/usage')) {
        body = { qoderUsage: { userQuota: { total: 123, remaining: 123, used: 0, unit: 'credits' } } }
      } else if (pathname.includes('/points/records')) {
        body = { code: '000000', data: { balance: 123, dailyBalance: 0, availableBalance: 123 } }
      } else if (pathname.includes('/credit/details')) {
        body = { base_resp: { status_code: 0 }, total_count: 1, details: [{ remaining_amount: '123.00' }] }
      } else if (pathname.includes('/profile-summary')) {
        body = { code: 0, success: true, data: { totalCreditsRemaining: 123, creditItems: [] } }
      } else if (pathname.includes('/zcode-plan/billing/balance')) {
        /**
         * ZCode 的额度是**活动制**：`balances[]` 是真实余量桶（带到期），
         * `plans[]` 是已领取的套餐（带 `effective_at` 生效时刻）。
         *
         * 用户 2026-10-28 的两条要求正好都在这里验：
         * ① 余额要按**时刻**算（没生效不算、过期不算）；
         * ② 同一份额度在 `plans` 与 `balances` 两种形态下**不能相加**。
         *
         * 故这个替身刻意造出四种情形，见下面的断言。
         */
        const nowSec = Math.floor(Date.now() / 1000)
        body = { code: 0, data: { server_time: nowSec, plans: [
          { plan_id: 'plan-effective', name: 'ZCODE GLOBAL BUILD', status: 'active',
            starts_at: nowSec - 3600, ends_at: nowSec + 43200,
            entitlements: [{ entitlement_id: 'ent-effective', show_name: 'GLM-5.3-Flash', unit_type: 'token',
              capabilities: ['model:glm-5.3-flash'], grant_units: 300000000, period: 'one_time', effective_at: nowSec - 1 }] },
          { plan_id: 'plan-future', name: 'FUTURE', status: 'active',
            starts_at: nowSec - 3600, ends_at: nowSec + 43200,
            entitlements: [{ entitlement_id: 'ent-future', show_name: 'GLM-5.3', unit_type: 'token',
              capabilities: ['model:glm-5.3'], grant_units: 999999999, period: 'one_time', effective_at: nowSec + 7200 }] },
        ], balances: [
          { plan_id: 'plan-old', entitlement_id: 'ent-live', show_name: 'GLM-5.3-Flash', unit_type: 'token',
            total_units: 5000000, remaining_units: 5000000, expires_at: nowSec + 3600, capabilities: ['model:glm-5.3-flash'] },
          { plan_id: 'plan-expired', entitlement_id: 'ent-expired', show_name: 'GLM-5.3', unit_type: 'token',
            total_units: 3000000, remaining_units: 3000000, expires_at: nowSec - 1, capabilities: ['model:glm-5.3'] },
        ] } }
      } else if (pathname.includes('/zcode-plan/billing/preview')) {
        body = { code: 0, data: { plans: [] } }
      } else if (pathname.endsWith(':retrieveUserQuotaSummary')) {
        quotaRequests++
        if (quotaFailed) return new Response('本机配额查询失败', { status: 502 })
        body = { groups: [{ buckets: [
          // 2026-11-01 按上游实测更正桶 id：gemini-5h / gemini-weekly（旧 antigravity-* 是臆测值）
          { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.8, resetTime: new Date(Date.now() + 3600000).toISOString() },
          { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.4, resetTime: new Date(Date.now() + 86400000).toISOString() },
        ] }] }
      } else throw new Error(`未预期的替身端点：${pathname}`)
      return Response.json(body)
    }
    // 2026-11-06 全码审查修复（t3-#2/#3）：status 与 claimAll 此前零端到端覆盖。
    // minimax/buddy 的 status 走注册表真查；cline/workbuddy/raccoon 的 claimAll
    // 走注册表 R0 bad-request —— 断言失败即分派层回归。
    {
      const statusResult = await call('credits.status', { provider: 'minimax' })
      assert.equal(statusResult.ok, true, 'credits.status/minimax（注册表真查）应 ok')
      assert.ok(Array.isArray(statusResult.value?.accounts), 'credits.status/minimax 应逐账号返回')
      const claimCline = await call('credits.claimAll', { provider: 'cline' })
      assert.equal(claimCline.ok, false, 'credits.claimAll/cline（R0 守卫）应 bad-request')
      assert.equal(claimCline.error?.code, 'bad-request')
      assert.equal(claimCline.error?.message, 'Cline 不支持每日签到（其后端没有签到接口）')
      const claimWb = await call('credits.claimAll', { provider: 'workbuddy' })
      assert.equal(claimWb.ok, false, 'credits.claimAll/workbuddy（R0 守卫）应 bad-request')
      assert.equal(claimWb.error?.message, 'WorkBuddy 国际版不支持每日签到（其后端没有签到接口）')
    }
    // t3-#6/#7：分派层补两条可失败断言 ——
    // ① 未知 provider 三 case 一律 bad-request（productById 兜底）；
    // ② zcode.claim 走原 case 分支（阶段 4 不迁）：借「损坏凭据」驱动原分支的
    //    凭据解析失败路径，证明该分支仍活着且行为不变（不 warn、N:1 results）。
    {
      for (const method of ['credits.status', 'credits.claimAll', 'credits.balances']) {
        const r = await call(method, { provider: 'no-such-channel' })
        assert.equal(r.ok, false, `${method} 未知 provider 应 bad-request`)
        assert.equal(r.error?.code, 'bad-request')
        assert.match(r.error?.message ?? '', /unsupported provider/, `${method} 兜底文案`)
      }
      const ref = 'FIXTURE_ZCODE_CLAIM_ORIG'
      creds.set(ref, { value: JSON.stringify({ access_token: 't', zcode_jwt: 'j', device_mid: 'd' }) })
      await ctx.accountPool.addAccount({
        id: 'fixture-zcode-claim-orig', provider: 'zcode', nickname: '原分支探针',
        credentialRef: ref, enabled: true, refreshable: false, createdAt: 1,
      })
      const zc = await call('credits.claimAll', { provider: 'zcode' })
      assert.equal(zc.ok, true, 'zcode.claim 原分支应正常应答（多 plan captcha 流程）')
      assert.ok(Array.isArray(zc.value?.results) && zc.value.results.length >= 1,
        'zcode.claim 原分支应逐账号产出 results（1 账号 N 条）')
      assert.ok(zc.value.summary, 'zcode.claim 原分支返回 computeClaimSummary')
    }
    for (const provider of providers.filter(id => id !== 'zcode' && id !== 'antigravity')) {
      resolvedRefs.length = 0
      const result = await call('credits.balances', { provider })
      assert.equal(result.ok, true)
      assert.equal(result.value.accounts[0].balance?.total, 123, `${provider} 的账号池凭据应能查询余额`)
      assert.ok(resolvedRefs.includes(`FIXTURE_CREDITS_${provider.toUpperCase()}`))
    }
    assert.equal((await ctx.zcodeAuth.current()).zcode_jwt, 'fixture-credits-jwt')
    assert.equal((await ctx.zcodeAuth.status()).configured, true)
    /**
     * ZCode 余额卡的口径（用户 2026-10-28）：
     * - 有效桶 5,000,000 计入；
     * - **已生效**的活动额度 300,000,000 计入；
     * - 还没到 `effective_at` 的 999,999,999 **不计入**；
     * - 已经过 `expires_at` 的 3,000,000 **不计入**。
     */
    /**
     * ⚠ `ZcodeAuth` 在**构造期**捕获了 `fetchImpl`（＝挂载时那个 offlineFetch），
     * 而本用例是**运行期**才替换 `globalThis.fetch` 的 —— 不显式换掉这一个字段，
     * 请求会走 offlineFetch 并抛「external network is disabled」。
     * 其它渠道没这个问题（它们逐请求读 `globalThis.fetch`）。
     */
    const savedZcodeFetch = ctx.zcodeAuth.fetchImpl
    ctx.zcodeAuth.fetchImpl = globalThis.fetch
    let zcodeBalance
    try {
      zcodeBalance = await call('credits.balances', { provider: 'zcode' })
    } finally {
      ctx.zcodeAuth.fetchImpl = savedZcodeFetch
    }
    assert.equal(zcodeBalance.ok, true)
    assert.equal(zcodeBalance.value.accounts[0].balance.total, 305_000_000,
      '余额 = 有效桶 + 已生效活动额度；没生效/已过期的都不算')
    creds.delete('FIXTURE_CREDITS_QODER')
    const missing = await call('credits.balances', { provider: 'qoder' })
    assert.equal(missing.value.accounts[0].balance, null)
    assert.equal(missing.value.accounts[0].error, '凭据未配置', '缺失凭据必须返回原因，不能伪造零余额')
    const unavailableQuota = await call('credits.balances', { provider: 'antigravity' })
    assert.equal(unavailableQuota.value.accounts[0].balance, null)
    quotaFailed = false
    const cachedQuota = await call('credits.balances', { provider: 'antigravity' })
    assert.equal(cachedQuota.value.accounts[0].balance, null)
    assert.equal(quotaRequests, 1, '自动查询保留原有缓存')
    const freshQuota = await call('credits.balances', { provider: 'antigravity', force: true })
    assert.equal(quotaRequests, 2, '手动重试必须真正查询上游替身')
    assert.equal(freshQuota.value.accounts[0].balance.total, 60)
    await verifyRefreshDispatch({ ctx, call, creds })
  } finally {
    ctx.credentials.resolve = originalResolve
    globalThis.fetch = originalFetch
    for (const provider of providers) {
      await ctx.accountPool.removeAccount(`fixture-credits-${provider}`)
      creds.delete(`FIXTURE_CREDITS_${provider.toUpperCase()}`)
    }
  }
}

async function verifyRefreshDispatch({ ctx, call, creds }) {
  const providers = [
    'codearts', 'buddy', 'workbuddy', 'qoder', 'qodercn', 'trae',
    'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'antigravity',
  ]
  for (const provider of providers) {
    const service = ctx[`${provider}Auth`]
    assert.ok(service, `${provider} auth service is mounted`)
    const saved = service.refreshAccountCredential
    const accountId = `fixture-refresh-${provider}`, ref = `FIXTURE_REFRESH_${provider.toUpperCase()}`
    const calls = []
    try {
      await ctx.accountPool.addAccount({
        id: accountId, provider, nickname: 'offline-refresh', credentialRef: ref,
        enabled: false, refreshable: true, createdAt: 1,
      })
      service.refreshAccountCredential = async (...args) => { calls.push(args) }
      const result = await call('account.refresh', { accountId })
      assert.deepEqual(result, { ok: true, value: { success: true } }, provider)
      assert.equal(calls.length, 1, provider)
      assert.deepEqual(calls[0], [ref, ctx.accountPool, accountId], `${provider}: exact ref, pool and id`)
      service.refreshAccountCredential = async () => { throw new Error('offline refresh rejected') }
      const rejected = await call('account.refresh', { accountId })
      assert.equal(rejected.ok, false, `${provider}: refresh failure is not success`)
      assert.match(rejected.error.message, /offline refresh rejected/)
    } finally {
      service.refreshAccountCredential = saved
      await ctx.accountPool.removeAccount(accountId)
    }
  }
  console.log('ok  refresh RPC: all 12 providers pass exact ref/pool/id; disabled accounts refresh; failures return ok:false')
  await verifyNewProviderRefreshDispatch({ ctx, call, creds })
}

/**
 * t4 新增的真续期分支（commandcode / officeace；accio 家族已随渠道删除）。
 *
 * 缺陷（用户实测报「续期提示失败」）：这四个 provider 落 `default` 抛
 * `Unknown provider: <id>`。本用例逐个锁死新行为：
 *   回 200 + 新 expiresAt（audit 实测幂等、顺延 30 天），断言请求形状
 *   （body 带 accessToken/refreshToken）与新 expiresAt/refreshable 写回账号池；
 * - officeace：**真续期** —— 替身 STS `POST /v1/oauth2/tokens` 回 200 +
 *   `credentials.{access_key_id,…}` + 轮换的 refresh_token（实测口径），
 *   断言表单字段（grant_type=refresh_token）与凭据回写；
 * - commandcode：**复核** —— 无网络调用，凭据可用即 success 且
 *   `refreshable` 归 false；凭据缺失时 ok:false。
 */
async function verifyNewProviderRefreshDispatch({ ctx, call, creds }) {
  const originalFetch = globalThis.fetch
  const seen = []
  const expires = Date.now() + 30 * 86400_000
  // 真实的 P-256 JWK（DPoP proof 要真的签名，占位字符会让 importKey 抛
  // Invalid keyData —— 用 node:crypto 生成一对与登录链同形态的密钥）。
  const { generateKeyPairSync } = await import('node:crypto')
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = privateKey.export({ format: 'jwk' })
  const dpopPair = {
    privateJwk: { kty: 'EC', crv: 'P-256', x: String(jwk.x), y: String(jwk.y), d: String(jwk.d) },
    publicJwk: { kty: 'EC', crv: 'P-256', x: String(jwk.x), y: String(jwk.y) },
  }
  // 形态对齐真实上游（audit / t4 实测）：
  // - STS 续期回 credentials.{access_key_id,secret_access_key,security_token,
  //   expiration} + 轮换后的 refresh_token（无 project_id、无 id_token —— 实测缺席）
  const standIn = async (input, init = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    seen.push({ method: init.method ?? 'GET', url: url.href, body: String(init.body ?? '') })
    if (url.pathname === '/alpha/whoami') {
      // commandcode 探活替身：默认 2xx；测试可置 standIn.ccWhoamiStatus 模拟吊销。
      const status = standIn.ccWhoamiStatus ?? 200
      return Response.json(status === 200 ? { success: true, user: { id: 'u-1' } } : { error: 'denied' }, { status })
    }
    if (url.pathname === '/v1/oauth2/tokens') {
      return Response.json({
        credentials: {
          access_key_id: 'AKIA-NEW', secret_access_key: 'SK-NEW',
          security_token: 'sec-new', expiration: new Date(expires).toISOString(),
        },
        refresh_token: 'rt-rotated',
      })
    }
    throw new Error(`未预期的续期替身端点：${url.href}`)
  }
  // RPC 走 `codeartsFetcher` → directFetch（包内 undici，**不读 globalThis.fetch**）。
  // 2026-11-07（t3-#12）接管时序说明：channel-pack-test 先把 lane 绑到「转发当前
  // globalThis.fetch」的函数；本套件临时换成 standIn 并在 finally 恢复 savedLane
  // （= 外层的转发函数），保存/恢复配对，外层契约不受影响。非双头，仅嵌套接管。
  const directLane =
    await import('../vendor/channel-pack/src/direct-fetch.ts').then(m => m.directLane).catch(() => null)
    ?? await import('../vendor/channel-pack/pack.js').then(m => m.directLane ?? null).catch(() => null)
  const savedLane = directLane ? directLane.fetch : null
  if (directLane) directLane.fetch = standIn
  globalThis.fetch = standIn
  const setCredential = async (ref, value) => { creds.set(ref, { value: JSON.stringify(value) }) }
  const dropCredential = (ref) => { creds.delete(ref) }
  try {
    // ── officeace：真续期（STS refresh_token grant + DPoP）──
    {
      const accountId = 'fixture-refresh-officeace', ref = 'FIXTURE_REFRESH_OFFICEACE'
      try {
        await ctx.accountPool.addAccount({
          id: accountId, provider: 'officeace', nickname: 't4-refresh', credentialRef: ref,
          enabled: true, refreshable: true, createdAt: 1,
        })
        // 凭据带 refresh_token + dpop（t1 登录链落库的形态；JWK 必须是真的，
        // DPoP proof 用它签名）
        await setCredential(ref, {
          base_url: 'https://gw.example.com/v2', app_key: 'k', app_secret: 's',
          access_key: 'AK-OLD', secret_key: 'SK-OLD', security_token: 'sec-old',
          refresh_token: 'rt-old', expire_time: Date.now() - 1000,
          dpop: dpopPair,
        })
        seen.length = 0
        const result = await call('account.refresh', { accountId })
        assert.equal(result.ok, true, 'officeace: 不再抛 Unknown provider，续期成功')
        // 请求形状：POST sts /v1/oauth2/tokens，表单 grant_type=refresh_token
        const req = seen.find(s => s.url.includes('/v1/oauth2/tokens'))
        assert.ok(req, 'officeace: 必须打 STS 续期端点')
        assert.equal(req.method, 'POST')
        const form = new URLSearchParams(req.body)
        assert.equal(form.get('grant_type'), 'refresh_token')
        assert.equal(form.get('refresh_token'), 'rt-old')
        assert.equal(form.get('client_id'), 'pdp5_for_agentarts')
        // 凭据回写：新 AK/SK + 轮换的 refresh_token；dpop/推理凭据保留
        const stored = JSON.parse((await ctx.credentials.resolve(ref)).value)
        assert.equal(stored.access_key, 'AKIA-NEW')
        assert.equal(stored.secret_key, 'SK-NEW')
        assert.equal(stored.security_token, 'sec-new')
        assert.equal(stored.refresh_token, 'rt-rotated', '轮换出的新 refresh_token 必须落库')
        assert.equal(stored.refresh_token !== 'rt-old', true, '旧 token 不得残留为新值')
        assert.equal(stored.base_url, 'https://gw.example.com/v2', '推理网关三件套不得被续期覆盖丢失')
        assert.equal(stored.app_key, 'k')
        assert.ok(stored.dpop, 'DPoP 私钥必须随凭据保留（续期链钥匙）')
        // 账号池写回
        const entry = (await ctx.accountPool.listAllAccounts()).find(a => a.id === accountId)
        assert.equal(entry.expiresAt, expires, 'officeace: 新 expiresAt 必须写回账号池')
        assert.equal(entry.refreshable, true)
      } finally {
        await ctx.accountPool.removeAccount(accountId)
        dropCredential(ref)
      }
    }
    // ── commandcode：真探活复核（2026-11-01：刷新分支调 /alpha/whoami）──
    {
      const accountId = 'fixture-refresh-commandcode', ref = 'FIXTURE_REFRESH_COMMANDCODE'
      try {
        await ctx.accountPool.addAccount({
          id: accountId, provider: 'commandcode', nickname: 't4-recheck', credentialRef: ref,
          enabled: true, refreshable: false, createdAt: 1,
        })
        await setCredential(ref, { access_token: 'cc-key-123' })
        seen.length = 0
        const result = await call('account.refresh', { accountId })
        assert.equal(result.ok, true, 'commandcode: whoami 2xx → 复核成功')
        assert.equal(seen.filter(s => s.url.includes('/alpha/whoami')).length, 1, 'commandcode: 复核必须真调 /alpha/whoami')
        const entry = (await ctx.accountPool.listAllAccounts()).find(a => a.id === accountId)
        assert.equal(entry.refreshable, false, 'commandcode: 长期 key 如实保持 refreshable:false')
        // key 被吊销（whoami 401）→ ok:false 且文案引导重新登录（2026-11-01 报障形态）
        standIn.ccWhoamiStatus = 401
        seen.length = 0
        const revoked = await call('account.refresh', { accountId })
        assert.equal(revoked.ok, false, 'commandcode: whoami 401 必须失败')
        assert.match(revoked.error.message, /Key 已失效/)
        assert.equal(seen.filter(s => s.url.includes('/alpha/whoami')).length, 1, 'commandcode: 401 不重试（终态）')
        standIn.ccWhoamiStatus = undefined
        // 凭据不可用 → ok:false（如实报错）
        await setCredential(ref, { access_token: '' })
        const rejected = await call('account.refresh', { accountId })
        assert.equal(rejected.ok, false, 'commandcode: 凭据不可用时必须失败')
        assert.match(rejected.error.message, /凭据不可用/)
      } finally {
        await ctx.accountPool.removeAccount(accountId)
        dropCredential(ref)
      }
    }
    // ── officeace 无 refresh_token：如实报错（不能装成功）──
    {
      const accountId = 'fixture-refresh-officeace-norefresh', ref = 'FIXTURE_REFRESH_OA_NOREFRESH'
      try {
        await ctx.accountPool.addAccount({
          id: accountId, provider: 'officeace', nickname: 't4-norefresh', credentialRef: ref,
          enabled: true, refreshable: false, createdAt: 1,
        })
        await setCredential(ref, { base_url: 'https://gw/v2', app_key: 'k', app_secret: 's', access_key: 'AK', secret_key: 'SK' })
        const rejected = await call('account.refresh', { accountId })
        assert.equal(rejected.ok, false, 'officeace: 无 refresh_token 必须失败')
        assert.match(rejected.error.message, /没有 refresh_token|重新登录/)
      } finally {
        await ctx.accountPool.removeAccount(accountId)
        dropCredential(ref)
      }
    }
    // ── model.list 幽灵补回（2026-11-01 用户报障：MiniMax 面板出现已下架的
    //    MiniMax-M2.7-highspeed）：黑名单里的 id 只有 dead 表也认识才补回 ──
    {
      const accountId = 'fixture-ghost-minimax', ref = 'FIXTURE_GHOST_MINIMAX'
      try {
        await ctx.accountPool.addAccount({
          id: accountId, provider: 'minimax', nickname: 'ghost-check', credentialRef: ref,
          enabled: true, refreshable: true, createdAt: 1,
        })
        await setCredential(ref, { access_token: 'mm-token', refresh_token: 'mm-rt' })
        // 黑名单埋两个"只有黑名单认识"的 id：一个历史上用户关过的下架 id、
        // 一个 dead 表认识的（模拟：先在目录里、后失效）。
        await ctx.accountPool.setModelDisabled('minimax', 'MiniMax-M2.7-highspeed', true)
        await ctx.accountPool.setModelDisabled('minimax', 'MiniMax-M3', true)
        const list = await call('model.list', { provider: 'minimax' })
        if (!list.ok) console.error('DEBUG model.list:', JSON.stringify(list).slice(0, 300))
        assert.equal(list.ok, true)
        const ids = list.value.models.map(row => row.id)
        assert.ok(!ids.includes('MiniMax-M2.7-highspeed'),
          '幽灵 id（仅黑名单认识、目录与 dead 表都没有）不得补回 —— 点进去推理必 404')
        assert.ok(ids.includes('MiniMax-M3'), '黑名单命中的在售模型必须出现在面板（带开关）')
        const m3 = list.value.models.find(row => row.id === 'MiniMax-M3')
        assert.equal(m3.disabled, true, '黑名单命中的在售模型如实标 disabled')
      } finally {
        await ctx.accountPool.removeAccount(accountId)
        dropCredential(ref)
        // 清黑名单，不污染其它用例（清 = 恢复未决定态）
        await ctx.accountPool.clearDisabledModels?.('minimax')
      }
    }
  } finally {
    globalThis.fetch = originalFetch
    if (directLane) directLane.fetch = savedLane
  }
  console.log('ok  refresh RPC (t4): commandcode / officeace 真续期分支 — 走真续期/真探活并回写池；幽灵模型不补回')
}

// 单独运行没有任何断言会执行（由汇总套件 import 调用）⇒ 明确失败，别伪装成通过。
exitIfDirectRun(import.meta.url, 'channel-credits-rpc-test')
