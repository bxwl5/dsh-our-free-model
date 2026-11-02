/**
 * ZCode「每日活动额度」的客户端版本门槛（2026-10-28）。
 *
 * ## 为什么要有一个专门的套件
 *
 * ZCode 的每日活动额度（`/billing/preview` 下发、`/billing/claim` 领取）是**按客户端
 * 版本**下发的。真凭据实测（同一账号、同一 JWT、只改 `app_version`）：
 *
 * ```
 * 3.14.3 / 3.15.x / 3.16.0 / 4.0.0 → preview.plans = []
 * 3.16.3 ~ 3.20.x                  → [zcode-v3-start-plan-1028]，300,000,000 token
 * ```
 *
 * 本仓库此前一直发 `3.14.3`（常量 + 凭据里登录时写下的值），于是每一轮都判成
 * 「今日额度尚未到账」—— 一键领取看起来正常，实际永远领不到那 3 亿。
 *
 * 这个套件锁死三件事：
 * 1. `resolveZcodeAppVersion` 的钳制矩阵（**存量凭据 `3.14.3` 也必须被抬到 3.16.3**）；
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

check('兜底版本就是服务端认的那个（3.16.3）', () => {
  assert.equal(ZCODE_APP_VERSION_FALLBACK, '3.16.3')
})

check('版本钳制矩阵：旧凭据被抬起、窗口内原样、窗口外与垃圾值回落', () => {
  const cases = [
    [undefined, '3.16.3', '缺字段'],
    ['', '3.16.3', '空串'],
    ['  3.14.3  ', '3.16.3', '存量凭据（登录时写的 3.14.3）'],
    ['3.16.0', '3.16.3', '3.16.0 差一个补丁'],
    ['3.16.2', '3.16.3', '3.16.2 差一个补丁'],
    ['3.16.3', '3.16.3', '窗口下限'],
    ['3.18.0', '3.18.0', '窗口内'],
    ['3.20.9', '3.20.9', '窗口上限'],
    ['3.21.0', '3.16.3', '窗口之上'],
    ['4.0.0', '3.16.3', '跨大版本（实测同样拿不到活动额度）'],
    ['v3.16.3-beta.1', 'v3.16.3-beta.1', '带前缀/预发布后缀'],
    ['not-a-version', '3.16.3', '垃圾值'],
  ]
  for (const [stored, want, why] of cases) {
    assert.equal(resolveZcodeAppVersion(stored), want, `${why}: ${String(stored)}`)
  }
})

check('请求头用钳制后的版本（存量 3.14.3 凭据也发 3.16.3）', () => {
  const headers = buildZcodeHeaders(credential('3.14.3'), { authorization: 'Bearer x' })
  assert.equal(headers['X-ZCode-App-Version'], '3.16.3')
  assert.equal(headers['User-Agent'], 'ZCode/3.16.3')
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
  assert.match(preview, /[?&]app_version=3\.16\.3(&|$)/)
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
  assert.match(preview, /app_version=3\.16\.3/)
})

check('领取**不带验证头**时不发 captcha 头（没有浏览器的形态也能领）', async () => {
  let headers
  const fetchImpl = async (_input, init) => {
    headers = init.headers
    return new Response(JSON.stringify({ code: 0, data: { plan: { plan_id: 'p', status: 'active' } } }), { status: 200 })
  }
  const outcome = await claimZcodePlan(credential('3.14.3'), 'zcode-v3-start-plan-1028', undefined, fetchImpl)
  assert.equal(outcome.ok, true)
  assert.equal(headers['X-ZCode-App-Version'], '3.16.3')
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

check('领取实现是「先裸发、3007 才产 captcha」的顺序（源码守卫）', () => {
  const source = fs.readFileSync(new URL('../vendor/channel-pack/src/zcode-auth.ts', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('private async claimOnePlan'))
  const firstClaim = body.indexOf('claimZcodePlan(')
  const mint = body.indexOf('mintClaimCaptcha(')
  assert.ok(firstClaim >= 0 && mint >= 0, '两处都应存在')
  assert.ok(firstClaim < mint, '首发必须在 mint 之前（先不带验证头试一发）')
  assert.match(body.slice(firstClaim, firstClaim + 200), /plan\.planId, undefined/, '首发不带 captcha')
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

console.log(`\nzcode-app-version: ${checks} checks passed`)
