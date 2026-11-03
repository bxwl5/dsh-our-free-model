/**
 * ZCode「每日活动额度」的客户端版本门槛（2026-10-28）。
 *
 * ## 为什么要有一个专门的套件
 *
 * ZCode 的每日活动额度（`marketing/touch` 投放为主、`/billing/preview` 为辅）是**按客户端
 * 版本**下发的。真凭据实测（同一账号、同一 JWT、只改 `app_version`）：
 *
 * ```
 * 3.14.3 / 3.16.x / 3.17.0 / 3.21.0+ / 4.0.0 → deliveries = []（无投放）
 * 3.17.2 ~ 3.20.x                            → [zcode-v3-start-plan-1103]，300,000,000 token
 * ```
 *
 * ⚠ **窗口会往上漂**（2026-11-03 实测）：`3.16.3` 在 10-28 还「已知可用」，今天已整条
 * 出窗，症状与最初一模一样（面板显示「今日额度尚未到账」）。故兜底值的语义是
 * **「钉在当期窗口内」而不是「钉死一个数」**：上游移动窗口时必须重扫
 * `marketing/touch` 并同步改 `src/zcode.ts` 的三个常量。
 *
 * 本仓库此前一直发 `3.14.3`（常量 + 凭据里登录时写下的值），于是每一轮都判成
 * 「今日额度尚未到账」—— 一键领取看起来正常，实际永远领不到那 3 亿。
 *
 * 这个套件锁死三件事：
 * 1. `resolveZcodeAppVersion` 的钳制矩阵（**存量凭据 `3.14.3` / `3.16.3` 都必须被抬进窗口**）；
 * 2. 请求头与 `?app_version=` 用的确实是钳制后的值（不是凭据里那个旧值）；
 * 3. 领取**先不带验证头试一发**，只在 `3007` 时才去产 captcha（没有浏览器的形态
 *    也能领）。
 *
 * Run: node scripts/zcode-app-version-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const target = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (fs.existsSync(target)) return { url: target.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) return {
      format: 'module', shortCircuit: true,
      source: stripTypeScriptTypes(fs.readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform', sourceUrl: url }),
    }
    return nextLoad(url, context)
  },
})

let checks = 0
const check = (name, run) => { run(); checks++; console.log(`ok  ${name}`) }

const { resolveZcodeAppVersion, ZCODE_APP_VERSION_FALLBACK } = await import('../vendor/channel-pack/src/zcode.ts')
const {
  buildZcodeHeaders, fetchZcodeClaimablePlans, fetchZcodeBalance, claimZcodePlan,
  zcodeEffectiveActivityGrants, zcodeRemainingByModel, parseZcodeMarketingTouch,
} = await import('../vendor/channel-pack/src/zcode-upstream.ts')

const credential = (appVersion) => ({
  zcode_jwt: 'header.payload.signature',
  device_mid: 'device-mid-test',
  ...(appVersion === undefined ? {} : { app_version: appVersion }),
})

check('兜底版本钉在当期窗口内（3.20.9）', () => {
  assert.equal(ZCODE_APP_VERSION_FALLBACK, '3.20.9')
})

check('版本钳制矩阵：旧凭据被抬起、窗口内原样、窗口外与垃圾值回落', () => {
  const cases = [
    [undefined, '3.20.9', '缺字段'],
    ['', '3.20.9', '空串'],
    ['  3.14.3  ', '3.20.9', '存量凭据（登录时写的 3.14.3）'],
    ['3.16.0', '3.20.9', '3.16.0（出窗，实测无投放）'],
    ['3.16.3', '3.20.9', '3.16.3（本仓库 2026-11-03 前的兜底，今天已出窗）'],
    ['3.17.0', '3.20.9', '3.17.0 差一个补丁（实测无投放）'],
    ['3.17.2', '3.17.2', '窗口下限（官方客户端当前版本，实测有投放）'],
    ['3.18.0', '3.18.0', '窗口内'],
    ['3.20.9', '3.20.9', '窗口上限（钉住的兜底值）'],
    ['3.21.0', '3.20.9', '窗口之上（实测无投放）'],
    ['4.0.0', '3.20.9', '跨大版本（实测同样拿不到活动额度）'],
    ['v3.17.2-beta.1', 'v3.17.2-beta.1', '带前缀/预发布后缀'],
    ['not-a-version', '3.20.9', '垃圾值'],
  ]
  for (const [stored, want, why] of cases) {
    assert.equal(resolveZcodeAppVersion(stored), want, `${why}: ${String(stored)}`)
  }
})

check('请求头用钳制后的版本（存量 3.14.3 凭据也发钉住的 3.20.9）', () => {
  const headers = buildZcodeHeaders(credential('3.14.3'), { authorization: 'Bearer x' })
  assert.equal(headers['X-ZCode-App-Version'], '3.20.9')
  assert.equal(headers['User-Agent'], 'ZCode/3.20.9')
  // 窗口内的值不被改写
  const kept = buildZcodeHeaders(credential('3.18.0'), {})
  assert.equal(kept['X-ZCode-App-Version'], '3.18.0')
})

check('preview 的 ?app_version= 也是钳制后的值', async () => {
  const seen = []
  const fetchImpl = async (input) => {
    seen.push(String(input))
    return new Response(JSON.stringify({ code: 0, data: { plans: [] } }), { status: 200 })
  }
  await fetchZcodeClaimablePlans(credential('3.14.3'), fetchImpl)
  // 自 2026-11-02 起两个来源都查（投放 + preview），故这里只挑 preview 那条断言。
  const preview = seen.find(url => url.includes('/billing/preview'))
  assert.ok(preview !== undefined, '必须查 preview')
  assert.match(preview, /[?&]app_version=3\.20\.9(&|$)/)
  assert.doesNotMatch(preview, /app_version=3\.14\.3/)
})

check('balance 里的活动清单同样按新版本查', async () => {
  const seen = []
  const fetchImpl = async (input) => {
    seen.push(String(input))
    return new Response(JSON.stringify({ code: 0, data: { balances: [] } }), { status: 200 })
  }
  const result = await fetchZcodeBalance(credential('3.14.3'), fetchImpl)
  assert.ok(result !== undefined)
  const preview = seen.find(url => url.includes('/billing/preview'))
  assert.ok(preview !== undefined, 'balance 会附带查一次 preview')
  assert.match(preview, /app_version=3\.20\.9/)
})

check('领取**不带验证头**时不发 captcha 头（没有浏览器的形态也能领）', async () => {
  let headers
  const fetchImpl = async (_input, init) => {
    headers = init.headers
    return new Response(JSON.stringify({ code: 0, data: { plan: { plan_id: 'p', status: 'active' } } }), { status: 200 })
  }
  const outcome = await claimZcodePlan(credential('3.14.3'), 'zcode-v3-start-plan-1103', undefined, fetchImpl)
  assert.equal(outcome.ok, true)
  assert.equal(headers['X-ZCode-App-Version'], '3.20.9')
  // 头名在 `buildZcodeHeaders` 里是小写（HTTP 头不区分大小写，这里按实际写法断言）
  assert.equal(headers['x-aliyun-captcha-verify-param'], undefined)
  assert.equal(headers['x-aliyun-captcha-verify-region'], undefined)
})

check('需要验证时两个验证头成对下发', async () => {
  let headers
  const fetchImpl = async (_input, init) => {
    headers = init.headers
    return new Response(JSON.stringify({ code: 0, data: { plan: {} } }), { status: 200 })
  }
  await claimZcodePlan(credential('3.16.3'), 'p', { param: 'captcha-param', region: 'cn' }, fetchImpl)
  assert.equal(headers['x-aliyun-captcha-verify-param'], 'captcha-param')
  assert.equal(headers['x-aliyun-captcha-verify-region'], 'cn')
})

check('请求头补齐官方必带的三项 + X-Platform 的 platform-arch 形态', async () => {
  const { buildZcodeHeaders } = await import('../vendor/channel-pack/src/zcode-upstream.ts')
  const headers = buildZcodeHeaders({ device_mid: 'fixture-uuid', app_version: '3.20.9' }, { authorization: 'Bearer x' })
  /**
   * 官方 `zai-org/ZCode` 的 `packages/shared/src/zcode-source-headers.ts`：
   * `X-Title: "Z Code@electron"` 是**硬编码常量**；社区实现
   * `pjpv/zcode-switch` 的 claim 头另有 `X-Os-Version` 与 `x-request-id`。
   * 我们此前三项全缺，且 `X-Platform` 发的是裸 `win32`（官方是 `${platform}-${arch}`）。
   */
  assert.equal(headers['X-Title'], 'Z Code@electron', 'X-Title 照抄官方常量')
  assert.match(String(headers['X-Os-Version']), /^\d+\.\d+/, 'X-Os-Version 形状是数字版本串')
  assert.match(String(headers['x-request-id']), /^[0-9a-f-]{36}$/, 'x-request-id 是 UUID')
  assert.equal(headers['X-Platform'], 'win32-x64', 'X-Platform 是 platform-arch')
  // 每请求新 id，不复用。
  const again = buildZcodeHeaders({ device_mid: 'fixture-uuid', app_version: '3.20.9' })
  assert.notEqual(again['x-request-id'], headers['x-request-id'], 'x-request-id 每请求不同')
  // 验证头仍然只在带 captcha 时出现（不要无条件发一个空 param）。
  assert.equal('x-aliyun-captcha-verify-param' in headers, false, '不带 captcha 时不得发验证头')
  const withCaptcha = buildZcodeHeaders({ device_mid: 'u', app_version: '3.20.9' }, { captcha: { param: 'p', region: 'cn' } })
  assert.equal(withCaptcha['x-aliyun-captcha-verify-param'], 'p')
})

check('领取实现是「先验证、再 claim」的官方顺序（源码守卫）', () => {
  const source = fs.readFileSync(new URL('../vendor/channel-pack/src/zcode-auth.ts', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('private async claimOnePlan'))
  const mint = body.indexOf('mintClaimCaptcha(')
  const firstClaim = body.indexOf('claimZcodePlan(')
  assert.ok(mint >= 0 && firstClaim >= 0, '两处都应存在')
  /**
   * 2026-11-04 用户要求「复刻官方顺序」。官方
   * `zai-org/ZCode` 的 `docs/zai-start-plan-provider.md:305-324` 是固定状态机
   * `checking-auth -> verifying -> claiming`，其 `claimManualPlan()` 在 claim 的
   * header 里**无条件**展开安全校验结果 —— 官方从不裸发。
   *
   * 本仓库自己的实测也证明旧顺序已失效（`zcode-upstream.ts:928-931`）：
   * 2026-10-28 裸发 `code:0` 成功，**2026-11-03 裸发回 `400 {code:3007}`**。
   * 故守卫方向反过来：**mint 必须在首次 claim 之前**。
   */
  assert.ok(mint < firstClaim, '必须先产 param（verifying）再 claim（claiming），与官方同序')
  // 且第一发 claim 必须带验证头（不是 `undefined`）。
  const firstClaimCall = body.slice(firstClaim, firstClaim + 220)
  assert.match(firstClaimCall, /param:\s*minted\.param/, '第一发 claim 必须带 param')
  // 无浏览器时的裸发降级仍然保留（否则 web/独立服务形态连试都不试）。
  assert.ok(body.includes('plan\.planId, undefined'), '没有浏览器时仍要有裸发降级路径')
  // 裸发降级不得在 3007 上重试（避免多扣一次风控计数）。
  assert.match(body, /outcome\.code === 3007 && mintError !== undefined/, '裸发 3007 只补文案，不重试')
  /**
   * ⚠ 记账点必须**在两条分支之外**：真机实测（2026-11-04）内部载体其实产出了
   * param，只是被上游拒（回到「带 param 首发」那条分支）—— 记账若写在「mint
   * 失败」分支里，这种最常见的情形一条都不记，用户依然看不到。
   */
  assert.match(body, /outcome\.code === 3007 && accountId !== undefined/, '任何 3007 都要落验证受阻账')
})

// ── 活动额度的「生效 / 到期」与「多账号合计」口径（用户 2026-10-28） ──────────

const HOUR = 3600
const NOW = 1_790_200_000_000 // 固定时刻，避免依赖墙上时钟
const nowSec = Math.floor(NOW / 1000)

/** 造一份 balance：一个桶 + 一份 plan 权益。 */
const balanceFixture = ({ bucketExpiresAt, grantEffectiveAt, planEndsAt, grantUnits = 300_000_000 }) => ({
  buckets: [{
    planId: 'plan-0817', entitlementId: 'ent-0817-flash', showName: 'GLM-5.3-Flash',
    unitType: 'token', remainingUnits: 5_000_000, totalUnits: 5_000_000,
    capabilities: ['model:glm-5.3-flash'], expiresAt: bucketExpiresAt,
  }],
  plans: [{
    planId: 'plan-1028', name: 'ZCODE GLOBAL BUILD', status: 'active',
    startsAt: nowSec - HOUR, endsAt: planEndsAt,
    entitlements: [{
      entitlementId: 'ent-1028-flash', showName: 'GLM-5.3-Flash', unitType: 'token',
      capabilities: ['model:glm-5.3-flash'], grantUnits, period: 'one_time', effectiveAt: grantEffectiveAt,
    }],
  }],
  remaining: 5_000_000, total: 5_000_000, expiresAt: bucketExpiresAt, claimablePlans: [],
})

check('活动额度**未生效**时不计入余量（领取 ≠ 立刻可用）', () => {
  const balance = balanceFixture({
    bucketExpiresAt: nowSec + HOUR, grantEffectiveAt: nowSec + 2 * HOUR, planEndsAt: nowSec + 12 * HOUR,
  })
  const grants = zcodeEffectiveActivityGrants(balance, NOW)
  assert.equal(grants.length, 0, '还没到 effective_at')
  assert.equal(zcodeRemainingByModel(balance, NOW).get('glm-5.3-flash'), 5_000_000)
})

check('到了生效点就计入，且与旧期桶**相加**（可叠加）', () => {
  const balance = balanceFixture({
    bucketExpiresAt: nowSec + HOUR, grantEffectiveAt: nowSec - 1, planEndsAt: nowSec + 12 * HOUR,
  })
  const grants = zcodeEffectiveActivityGrants(balance, NOW)
  assert.equal(grants.length, 1)
  assert.equal(grants[0].units, 300_000_000)
  assert.equal(grants[0].endsAtMs, (nowSec + 12 * HOUR) * 1000)
  assert.equal(zcodeRemainingByModel(balance, NOW).get('glm-5.3-flash'), 300_000_000 + 5_000_000)
})

check('计划到期后不再计入（上游可能仍标 active）', () => {
  const balance = balanceFixture({
    bucketExpiresAt: nowSec - 1, grantEffectiveAt: nowSec - HOUR, planEndsAt: nowSec - 1,
  })
  assert.equal(zcodeEffectiveActivityGrants(balance, NOW).length, 0)
  assert.equal(zcodeRemainingByModel(balance, NOW).get('glm-5.3-flash'), undefined, '过期的桶与权益都不算')
})

check('上游已经下发成桶时**不重复相加**（3 亿不会变 6 亿）', () => {
  const balance = balanceFixture({
    bucketExpiresAt: nowSec + 12 * HOUR, grantEffectiveAt: nowSec - HOUR, planEndsAt: nowSec + 12 * HOUR,
  })
  // 同一份权益此刻已被下发成桶
  balance.buckets.push({
    planId: 'plan-1028', entitlementId: 'ent-1028-flash', showName: 'GLM-5.3-Flash',
    unitType: 'token', remainingUnits: 299_000_000, totalUnits: 300_000_000,
    capabilities: ['model:glm-5.3-flash'], expiresAt: nowSec + 12 * HOUR,
  })
  assert.equal(zcodeEffectiveActivityGrants(balance, NOW).length, 0, '已被桶表达')
  assert.equal(zcodeRemainingByModel(balance, NOW).get('glm-5.3-flash'), 5_000_000 + 299_000_000)
})

check('`effective_at: 0` 视为随计划立即生效（实测 …-0817 就是这样）', () => {
  const balance = balanceFixture({
    bucketExpiresAt: nowSec + HOUR, grantEffectiveAt: 0, planEndsAt: nowSec + 12 * HOUR,
  })
  balance.buckets.length = 0 // 清掉桶，避免被「已表达」跳过
  const grants = zcodeEffectiveActivityGrants(balance, NOW)
  assert.equal(grants.length, 1)
  assert.equal(grants[0].effectiveAtMs, (nowSec - HOUR) * 1000, '回落到 plan.starts_at')
})

check('多账号合计 = 各账号同一模型之和（模型界面口径）', () => {
  const a = balanceFixture({ bucketExpiresAt: nowSec + HOUR, grantEffectiveAt: nowSec - 1, planEndsAt: nowSec + 12 * HOUR })
  const b = balanceFixture({ bucketExpiresAt: nowSec + HOUR, grantEffectiveAt: nowSec + HOUR, planEndsAt: nowSec + 12 * HOUR })
  const total = new Map()
  for (const balance of [a, b]) {
    for (const [key, units] of zcodeRemainingByModel(balance, NOW)) {
      total.set(key, (total.get(key) ?? 0) + units)
    }
  }
  // a: 桶 5M + 已生效 300M；b: 只有桶 5M（其活动额度还没生效）
  assert.equal(total.get('glm-5.3-flash'), 305_000_000 + 5_000_000)
})

check('适配器确实按「全部账号」求和（源码守卫）', () => {
  const source = fs.readFileSync(new URL('../vendor/channel-pack/src/zcode-adapter.ts', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('async refreshModelRemaining'))
  assert.match(body.slice(0, 500), /allCredentials\(\)/, '必须先取全部账号')
  assert.match(body.slice(0, 1400), /zcodeRemainingByModel\(balance\)/, '口径交给上游助手')
  assert.match(body.slice(0, 1400), /next\.set\(key, \(next\.get\(key\) \?\? 0\) \+ units\)/, '多账号相加')
})

check('余量不是「只查一次」——按 TTL 重查（到点/过期才会自动反映）', () => {
  const source = fs.readFileSync(new URL('../vendor/channel-pack/src/zcode-adapter.ts', import.meta.url), 'utf8')
  const warm = source.slice(source.indexOf('async warmCatalog'))
  assert.match(warm.slice(0, 2200), /MODEL_REMAINING_TTL_MS/, 'warmCatalog 要看 TTL')
  assert.match(warm.slice(0, 2200), /modelRemainingAt/, 'TTL 基准是上次刷新时刻')
  assert.match(source, /this\.modelRemainingAt = Date\.now\(\)/, '刷新成功后要记时刻')
})

// ── ★ 2026-11-02：每日活动额度由「营销投放」下发，`preview` 是空的 ──────────
//
// 真凭据实测（同一账号、同一 JWT、同一时刻）：
//   GET /zcode-plan/billing/preview → {"code":0,"msg":"","logid":…}   ← 连 data 都没有
//   GET /api/v1/marketing/touch     → claim_zcode_plan / …-start-plan-1102 / 3 亿 token
// 旧实现只读 preview ⇒ 每轮都报「今日暂无可领额度」，用户看到的就是「签到一直没成功」。

/** 一份**真实抓取**的 `marketing/touch` 响应（2026-11-02，字段逐字保留）。 */
const TOUCH_FIXTURE = {
  code: 0,
  msg: '',
  data: {
    server_time: 1793623341,
    language: 'zh-CN',
    deliveries: [{
      campaign_id: '2101141259813175296',
      resource_position: 'banner',
      priority: 50,
      banner: {
        buttons: [
          { text: { format: '', content: '' }, action: { type: 'close', args: null } },
          {
            text: { format: '', content: '' },
            action: { type: 'claim_zcode_plan', args: { plan_id: 'zcode-v3-start-plan-1102' } },
          },
        ],
        background: {
          type: 'bundle',
          args: {
            zcode_plan: {
              plan_id: 'zcode-v3-start-plan-1102',
              name: 'ZCODE GLOBAL BUILD',
              priority: 111,
              starts_at: 1793617200,
              ends_at: 1793667600,
              entitlements: [{
                entitlement_id: 'ent-zcode-v3-start-plan-1102-1',
                show_name: 'GLM-5.3-Flash',
                meter: 'model_usage',
                unit_type: 'token',
                capabilities: ['model:glm-5.3-flash'],
                grant_units: 300_000_000,
                period: 'one_time',
                effective_at: 1793631600,
                priority: 101,
              }],
            },
          },
        },
        success_popup: {
          hero: {
            type: 'bundle',
            args: {
              zcode_plan: {
                plan_id: 'zcode-v3-start-plan-1102',
                name: 'ZCODE GLOBAL BUILD',
                priority: 111,
                entitlements: [{ grant_units: 300_000_000, unit_type: 'token' }],
              },
            },
          },
        },
      },
    }],
  },
}

check('投放里能读出「可领 + 额度 + 名称 + 单位」（与 preview 同构）', () => {
  const plans = parseZcodeMarketingTouch(TOUCH_FIXTURE)
  assert.equal(plans.length, 1)
  assert.equal(plans[0].planId, 'zcode-v3-start-plan-1102')
  assert.equal(plans[0].name, 'ZCODE GLOBAL BUILD')
  assert.equal(plans[0].priority, 111)
  assert.equal(plans[0].grantUnits, 300_000_000)
  assert.equal(plans[0].unitType, 'token')
})

check('只有出现在 `claim_zcode_plan` 动作里的才算可领（元数据不算）', () => {
  const payload = {
    data: {
      deliveries: [{
        banner: {
          buttons: [],
          // 只有描述、没有 claim 动作 ⇒ 是「已领过 / 仅展示」的活动，不能当可领
          background: { args: { zcode_plan: { plan_id: 'zcode-v3-start-plan-1030', name: '已结束' } } },
        },
      }],
    },
  }
  assert.deepEqual(parseZcodeMarketingTouch(payload), [])
})

check('投放解析容错：空投放 / 非对象 / 缺 plan_id 都不抛', () => {
  assert.deepEqual(parseZcodeMarketingTouch({ data: { deliveries: [] } }), [])
  assert.deepEqual(parseZcodeMarketingTouch(undefined), [])
  assert.deepEqual(parseZcodeMarketingTouch({ data: { deliveries: [{ banner: { buttons: [{ action: { type: 'claim_zcode_plan', args: {} } }] } }] } }), [])
})

check('可领活动**同时读 touch 与 preview**，按 plan_id 去重且投放优先', async () => {
  const seen = []
  const fetchImpl = async (input) => {
    const url = String(input)
    seen.push(url)
    if (url.includes('/marketing/touch')) {
      return new Response(JSON.stringify(TOUCH_FIXTURE), { status: 200 })
    }
    if (url.includes('/billing/preview')) {
      // preview 历史形态：另一条套餐（2026-10-03 实测过 …-trust-*）
      return new Response(JSON.stringify({
        code: 0,
        data: { plans: [{ plan_id: 'zcode-v3-start-plan-trust-1003', name: '旧活动', entitlements: [{ grant_units: 100_000_000, unit_type: 'token' }] }] },
      }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }
  const plans = await fetchZcodeClaimablePlans(credential('3.16.3'), fetchImpl)
  assert.ok(seen.some(url => url.includes('/marketing/touch')), '必须查投放（每日活动在这里）')
  assert.ok(seen.some(url => url.includes('/billing/preview')), '仍要查 preview（计费位历史形态）')
  const ids = plans.map(plan => plan.planId).sort()
  assert.deepEqual(ids, ['zcode-v3-start-plan-1102', 'zcode-v3-start-plan-trust-1003'])
  // priority 降序：投放那条是 111，旧活动没有 priority（0）
  assert.equal(plans[0].planId, 'zcode-v3-start-plan-1102')
})

check('touch 带 Authorization（缺了上游回 200 但没有投放）', async () => {
  let touchHeaders
  const fetchImpl = async (input, init) => {
    if (String(input).includes('/marketing/touch')) {
      touchHeaders = init?.headers
      return new Response(JSON.stringify(TOUCH_FIXTURE), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }
  await fetchZcodeClaimablePlans(credential('3.16.3'), fetchImpl)
  assert.equal(touchHeaders?.['Authorization'], 'Bearer header.payload.signature')
  assert.equal(touchHeaders?.['X-Device-Mid'], 'device-mid-test')
})

check('单条链路失败不拖累另一条（投放挂了仍返回 preview 的）', async () => {
  const fetchImpl = async (input) => {
    if (String(input).includes('/marketing/touch')) throw new Error('boom')
    return new Response(JSON.stringify({
      code: 0,
      data: { plans: [{ plan_id: 'p-preview', entitlements: [{ grant_units: 500 }] }] },
    }), { status: 200 })
  }
  const plans = await fetchZcodeClaimablePlans(credential('3.16.3'), fetchImpl)
  assert.deepEqual(plans.map(plan => plan.planId), ['p-preview'])
})

check('balance 的 claimablePlans 也走合并来源（面板才看得见）', async () => {
  const fetchImpl = async (input) => {
    const url = String(input)
    if (url.includes('/marketing/touch')) return new Response(JSON.stringify(TOUCH_FIXTURE), { status: 200 })
    if (url.includes('/billing/preview')) return new Response(JSON.stringify({ code: 0 }), { status: 200 })
    return new Response(JSON.stringify({ code: 0, data: { balances: [], plans: [] } }), { status: 200 })
  }
  const result = await fetchZcodeBalance(credential('3.16.3'), fetchImpl)
  assert.ok(result !== undefined)
  assert.deepEqual(result.claimablePlans, [{ planId: 'zcode-v3-start-plan-1102', showName: 'ZCODE GLOBAL BUILD', amount: 300_000_000 }])
})

check('领取路径拿到的就是投放里的那个 plan_id（端到端形状）', async () => {
  const claimed = []
  const fetchImpl = async (input, init) => {
    const url = String(input)
    if (url.includes('/marketing/touch')) return new Response(JSON.stringify(TOUCH_FIXTURE), { status: 200 })
    if (url.includes('/billing/preview')) return new Response(JSON.stringify({ code: 0 }), { status: 200 })
    if (url.includes('/billing/claim')) {
      claimed.push(JSON.parse(String(init?.body ?? '{}')).plan_id)
      return new Response(JSON.stringify({ code: 0, data: { message: '套餐领取成功' } }), { status: 200 })
    }
    return new Response(JSON.stringify({ code: 0 }), { status: 200 })
  }
  const plans = await fetchZcodeClaimablePlans(credential('3.16.3'), fetchImpl)
  for (const plan of plans) await claimZcodePlan(credential('3.16.3'), plan.planId, undefined, fetchImpl)
  assert.deepEqual(claimed, ['zcode-v3-start-plan-1102'])
})

// ── 账号级风控（3012）进「异常汇总」（用户 2026-11-03） ──────────────────────

check('recordAccountRisk 阶梯：首次 30 分钟，冷却未完再命中升级 24 小时', async () => {
  const { AccountPool, RISK_FIRST_COOLDOWN_MS, RISK_REPEAT_COOLDOWN_MS } =
    await import('../vendor/channel-pack/src/account-pool.ts')
  const state = { accounts: [
    { id: 'zcode-a1', provider: 'zcode', nickname: 'a', enabled: true, credentialRef: 'R1', createdAt: 1, refreshable: false },
  ], disabledModels: {}, gatewayEnabled: true, providerOrder: [] }
  const store = {
    kind: 'file', loads: 0, stamp: 1000,
    mtimeMs() { return this.stamp },
    load() { this.loads += 1; return JSON.parse(JSON.stringify(state)) },
    async save(next) { Object.assign(state, JSON.parse(JSON.stringify(next))); this.stamp += 1 },
  }
  const ctx = {
    logger: { warn() {}, info() {} },
    credentials: { resolve: async () => undefined, describe: async () => undefined, set: async () => {}, unset: async () => {} },
  }
  const pool = new AccountPool(ctx)
  Object.defineProperty(pool, 'store', { value: store, writable: true, configurable: true })
  Object.defineProperty(pool, 'loaded', { value: false, writable: true, configurable: true })

  const t0 = 1_793_700_000_000
  await pool.recordAccountRisk('zcode-a1', t0)
  let entry = state.accounts.find(a => a.id === 'zcode-a1')
  assert.equal(entry.riskBlockedUntilMs, t0 + RISK_FIRST_COOLDOWN_MS, '首次命中记 30 分钟')

  // 冷却未完又命中 ⇒ 升级到 24 小时（这就是「别连续重试」的量化后果）。
  await pool.recordAccountRisk('zcode-a1', t0 + 60_000)
  entry = state.accounts.find(a => a.id === 'zcode-a1')
  assert.equal(entry.riskBlockedUntilMs, t0 + 60_000 + RISK_REPEAT_COOLDOWN_MS, '重复命中升级 24 小时')

  // 冷却到点（24h 期满）后再命中 ⇒ 回落首次档：阶梯是从头数，不是永久升级。
  const afterRepeat = t0 + 60_000 + RISK_REPEAT_COOLDOWN_MS
  await pool.recordAccountRisk('zcode-a1', afterRepeat + 5_000)
  entry = state.accounts.find(a => a.id === 'zcode-a1')
  assert.equal(entry.riskBlockedUntilMs, afterRepeat + 5_000 + RISK_FIRST_COOLDOWN_MS,
    '期满后再命中按首次档')

  // 未知账号：不抛错、不写脏。
  const before = JSON.stringify(state)
  await pool.recordAccountRisk('nope', t0)
  assert.equal(JSON.stringify(state), before, '账号不存在时不得写盘')
})

check('sweepExpiredRiskBlocks 只清「过期且超保留期」的标记', async () => {
  const { AccountPool, RATE_LIMIT_KEEP_MS } = await import('../vendor/channel-pack/src/account-pool.ts')
  const now = Date.now()
  const state = { accounts: [
    { id: 'fresh', provider: 'zcode', nickname: 'f', enabled: true, credentialRef: 'R', createdAt: 1, refreshable: false, riskBlockedUntilMs: now + 60_000 },
    { id: 'expired-kept', provider: 'zcode', nickname: 'e', enabled: true, credentialRef: 'R', createdAt: 1, refreshable: false, riskBlockedUntilMs: now - 60_000 },
    { id: 'expired-gone', provider: 'zcode', nickname: 'g', enabled: true, credentialRef: 'R', createdAt: 1, refreshable: false, riskBlockedUntilMs: now - RATE_LIMIT_KEEP_MS - 60_000 },
    { id: 'dirty', provider: 'zcode', nickname: 'd', enabled: true, credentialRef: 'R', createdAt: 1, refreshable: false, riskBlockedUntilMs: 0 },
  ], disabledModels: {}, gatewayEnabled: true, providerOrder: [] }
  const store = {
    kind: 'file', loads: 0,
    mtimeMs() { return 1000 },
    load() { return JSON.parse(JSON.stringify(state)) },
    async save(next) { Object.assign(state, JSON.parse(JSON.stringify(next))) },
  }
  const ctx = { logger: { warn() {}, info() {} }, credentials: { resolve: async () => undefined, describe: async () => undefined, set: async () => {}, unset: async () => {} } }
  const pool = new AccountPool(ctx)
  Object.defineProperty(pool, 'store', { value: store, writable: true, configurable: true })
  Object.defineProperty(pool, 'loaded', { value: false, writable: true, configurable: true })
  await pool.sweepExpiredRiskBlocks()
  const byId = Object.fromEntries(state.accounts.map(a => [a.id, a]))
  assert.ok(byId.fresh.riskBlockedUntilMs !== undefined, '未到期的保留')
  assert.ok(byId['expired-kept'].riskBlockedUntilMs !== undefined, '刚过期的留档排障')
  assert.ok(!('riskBlockedUntilMs' in byId['expired-gone']), '过期超保留期的删除')
  assert.ok(!('riskBlockedUntilMs' in byId.dirty), '脏值（0）删除')
})

check('验证受阻（产不出 param）自成一条异常，与风控分色（源码守卫 + 行为）', async () => {
  /**
   * 用户 2026-11-04 报「领取失败但异常汇总里什么都没有」。根因：captcha 产出
   * 失败只在领取结果的 toast 里一闪而过，而板块读的是账号上的持久标记。
   *
   * 语义上它**不是风控**：前者是我们缺件（装浏览器即可），后者是上游罚账号
   * （要停手等冷却，3012 有 30 分钟 → 24 小时 → 停用的阶梯）。归成一类会让
   * 用户照着错误的指示操作，所以它是独立的 `kind`。
   */
  const { AccountPool } = await import('../vendor/channel-pack/src/account-pool.ts')
  const state = { accounts: [
    { id: 'zcode-v1', provider: 'zcode', nickname: 'v', enabled: true, credentialRef: 'R1', createdAt: 1, refreshable: false },
  ], disabledModels: {}, gatewayEnabled: true, providerOrder: [] }
  const store = {
    kind: 'file', loads: 0, stamp: 1000,
    mtimeMs() { return this.stamp },
    load() { this.loads += 1; return JSON.parse(JSON.stringify(state)) },
    async save(next) { Object.assign(state, JSON.parse(JSON.stringify(next))); this.stamp += 1 },
  }
  const pool = new AccountPool({
    logger: { warn() {}, info() {} },
    credentials: { resolve: async () => undefined, describe: async () => undefined, set: async () => {}, unset: async () => {} },
  })
  Object.defineProperty(pool, 'store', { value: store, writable: true, configurable: true })
  Object.defineProperty(pool, 'loaded', { value: false, writable: true, configurable: true })
  await pool.recordVerificationBlocked('zcode-v1', 1_793_700_000_000)
  const entry = state.accounts.find(a => a.id === 'zcode-v1')
  assert.equal(entry.verificationBlockedAtMs, 1_793_700_000_000, '记录最近一次发生时刻')
  assert.equal(entry.riskBlockedUntilMs, undefined, '不得污染风控字段（那条有冷却阶梯语义）')

  const rpc = fs.readFileSync(new URL('../vendor/channel-pack/src/channel-pack-rpc.ts', import.meta.url), 'utf8')
  assert.match(rpc, /kind: 'verification-blocked'/, 'RPC 必须能产出该类型')
  assert.match(rpc, /verificationBlockedAtMs/, '读数读的是专用字段')
  const auth = fs.readFileSync(new URL('../vendor/channel-pack/src/zcode-auth.ts', import.meta.url), 'utf8')
  assert.match(auth, /recordVerificationBlocked\(accountId\)/, '领取失败时必须落账')
  const client = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(client, /chan\.anomaly\.verifyBlocked/, '前端有独立文案')
  assert.match(client, /ofm_anomalykind\.verify/, '前端有独立配色（蓝，不是红）')
})

check('两条 3012 落点都接了落账（推理 + 领取，源码守卫）', () => {
  const adapter = fs.readFileSync(new URL('../vendor/channel-pack/src/zcode-adapter.ts', import.meta.url), 'utf8')
  const auth = fs.readFileSync(new URL('../vendor/channel-pack/src/zcode-auth.ts', import.meta.url), 'utf8')
  // 回看窗口 1400：两个分支前面都有一段解释性注释 + 文案，400 会把判据挤出去。
  // 推理路径：守卫必须是 hasZcodeUnusualActivity（先信码后看正文），不能是裸 includes。
  const aSite = adapter.indexOf('recordAccountRisk(activeAccountId)')
  assert.ok(aSite > 0, '推理路径 3012 分支必须落账')
  assert.ok(adapter.slice(aSite - 1400, aSite).includes('hasZcodeUnusualActivity(text)'),
    '推理路径必须用风控判据而不是裸 3012 串匹配')
  // 领取路径：落账必须在 isClaimUnusualActivity 短路的同一分支里（换链之后的最终 outcome）。
  const cSite = auth.indexOf('recordAccountRisk(accountId)')
  assert.ok(cSite > 0, '领取路径 3012 短路必须落账')
  assert.ok(auth.slice(cSite - 1400, cSite).includes('isClaimUnusualActivity'),
    '领取落账必须挂在统一的 3012 判定分支内')
})

check('异常汇总收编 risk-blocked（RPC 出口 + 前端红色徽标，源码守卫）', () => {
  const rpc = fs.readFileSync(new URL('../vendor/channel-pack/src/channel-pack-rpc.ts', import.meta.url), 'utf8')
  const caseSite = rpc.slice(rpc.indexOf("case 'account.anomalies'"))
  assert.ok(caseSite.includes("kind: 'risk-blocked'"), 'anomalies 必须收编风控记录')
  assert.ok(caseSite.includes('riskBlockedUntilMs'), '读的是账号上的风控字段')
  const client = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(client.includes("'chan.anomaly.riskBlocked'"), '前端必须有「风控」文案键')
  assert.ok(client.includes("row.kind === 'risk-blocked' ? ' risk'"), 'kind 徽标必须分流样式类')
  assert.ok(/\.ofm_anomalykind\.risk\{[^}]*state-error/.test(client),
    '风控徽标必须是 error 红（与限流橙色区分，用户要求红色）')
})

console.log(`\nzcode-app-version: ${checks} checks passed`)
