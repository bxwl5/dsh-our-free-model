import assert from 'node:assert/strict'

/** 使用实际已打包 RPC，只提供账号池 ref，禁止真实网络与旧单凭据回退。 */
export async function verifyChannelCreditsRpc({ ctx, call, creds }) {
  const originalFetch = globalThis.fetch
  const providers = ['buddy', 'workbuddy', 'qoder', 'qodercn', 'loomy', 'minimax', 'zcode', 'gemini']
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
          { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.8, resetTime: new Date(Date.now() + 3600000).toISOString() },
          { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.4, resetTime: new Date(Date.now() + 86400000).toISOString() },
        ] }] }
      } else throw new Error(`未预期的替身端点：${pathname}`)
      return Response.json(body)
    }
    for (const provider of providers.filter(id => id !== 'zcode' && id !== 'gemini')) {
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
    const unavailableQuota = await call('credits.balances', { provider: 'gemini' })
    assert.equal(unavailableQuota.value.accounts[0].balance, null)
    quotaFailed = false
    const cachedQuota = await call('credits.balances', { provider: 'gemini' })
    assert.equal(cachedQuota.value.accounts[0].balance, null)
    assert.equal(quotaRequests, 1, '自动查询保留原有缓存')
    const freshQuota = await call('credits.balances', { provider: 'gemini', force: true })
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
    'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini',
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
  console.log('ok  refresh RPC: all 13 providers pass exact ref/pool/id; disabled accounts refresh; failures return ok:false')
  await verifyNewProviderRefreshDispatch({ ctx, call, creds })
}

/**
 * t4 新增的四个续期分支（commandcode / accio / accio-cn / officeace）。
 *
 * 缺陷（用户实测报「续期提示失败」）：这四个 provider 落 `default` 抛
 * `Unknown provider: <id>`。本用例逐个锁死新行为：
 * - accio / accio-cn：**真续期** —— 替身上游 `POST /api/auth/refresh_token`
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
  // - accio 刷新回 accessToken/refreshToken/expiresAt（token 不轮换、顺延 30 天）
  // - STS 续期回 credentials.{access_key_id,secret_access_key,security_token,
  //   expiration} + 轮换后的 refresh_token（无 project_id、无 id_token —— 实测缺席）
  const standIn = async (input, init = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    seen.push({ method: init.method ?? 'GET', url: url.href, body: String(init.body ?? '') })
    if (url.pathname === '/api/auth/refresh_token') {
      return Response.json({ accessToken: 'accio-new-at', refreshToken: 'accio-rt', expiresAt: expires })
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
  // source 模式下测试与 RPC 共享同一份 direct-fetch 模块实例，注入 directLane 即生效；
  // 打包态下 pack.js 自带另一份 —— 这里从 pack.js 再取一次（ESM 缓存返回同一实例，
  // channel-pack-test 已 import 过它），其 directLane 由测试挂载时绑到 offlineFetch，
  // 换成我们的替身即可。与 channel-oauth-failure-test 的注入思路同源。
  const directLane =
    await import('../vendor/channel-pack/src/direct-fetch.ts').then(m => m.directLane).catch(() => null)
    ?? await import('../vendor/channel-pack/pack.js').then(m => m.directLane ?? null).catch(() => null)
  const savedLane = directLane ? directLane.fetch : null
  if (directLane) directLane.fetch = standIn
  globalThis.fetch = standIn
  const setCredential = async (ref, value) => { creds.set(ref, { value: JSON.stringify(value) }) }
  const dropCredential = (ref) => { creds.delete(ref) }
  try {
    // ── accio / accio-cn：真续期 ──
    for (const provider of ['accio', 'accio-cn']) {
      const accountId = `fixture-refresh-${provider}`, ref = `FIXTURE_REFRESH_${provider.toUpperCase()}`
      try {
        await ctx.accountPool.addAccount({
          id: accountId, provider, nickname: 't4-refresh', credentialRef: ref,
          enabled: true, refreshable: true, createdAt: 1,
        })
        await setCredential(ref, {
          access_token: 'accio-old-at', refresh_token: 'accio-rt',
          expire_time: Date.now() - 1000,
        })
        seen.length = 0
        const result = await call('account.refresh', { accountId })
        assert.equal(result.ok, true, `${provider}: 不再抛 Unknown provider，续期成功`)
        // 请求形状：POST {gatewayBase}/api/auth/refresh_token，body 带 accessToken/refreshToken
        const req = seen.find(s => s.url.includes('/api/auth/refresh_token'))
        assert.ok(req, `${provider}: 必须打真实续期端点`)
        assert.equal(req.method, 'POST')
        const form = JSON.parse(req.body)
        assert.equal(form.accessToken, 'accio-old-at')
        assert.equal(form.refreshToken, 'accio-rt')
        // 账号池写回：expiresAt 顺延 + refreshable 保持 true
        const entry = (await ctx.accountPool.listAllAccounts()).find(a => a.id === accountId)
        assert.equal(entry.expiresAt, expires, `${provider}: 新 expiresAt 必须写回账号池`)
        assert.equal(entry.refreshable, true, `${provider}: 有 refresh_token 必须保持 refreshable`)
        // 凭据已回写（读出的就是新 token）
        const stored = JSON.parse((await ctx.credentials.resolve(ref)).value)
        assert.equal(stored.access_token, 'accio-new-at', `${provider}: 新凭据必须回写`)
        assert.equal(stored.refresh_token, 'accio-rt')
      } finally {
        await ctx.accountPool.removeAccount(accountId)
        dropCredential(ref)
      }
    }
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
    // ── commandcode：复核（无网络调用）──
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
        assert.equal(result.ok, true, 'commandcode: 不再抛 Unknown provider，复核成功')
        assert.equal(seen.length, 0, 'commandcode: 复核不发任何网络请求')
        const entry = (await ctx.accountPool.listAllAccounts()).find(a => a.id === accountId)
        assert.equal(entry.refreshable, false, 'commandcode: 长期 key 如实保持 refreshable:false')
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
  } finally {
    globalThis.fetch = originalFetch
    if (directLane) directLane.fetch = savedLane
  }
  console.log('ok  refresh RPC (t4): commandcode/accio/accio-cn/officeace 四分支 — accio 家族与 officeace 走真续期并回写池，commandcode 走复核')
}
