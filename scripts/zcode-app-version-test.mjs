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
  zcodeEffectiveActivityGrants, zcodeRemainingByModel,
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
  assert.equal(seen.length, 1)
  assert.match(seen[0], /[?&]app_version=3\.16\.3(&|$)/)
  assert.doesNotMatch(seen[0], /app_version=3\.14\.3/)
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

console.log(`\nzcode-app-version: ${checks} checks passed`)
