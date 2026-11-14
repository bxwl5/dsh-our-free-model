/**
 * CodeArts 每日签到必须领取**全部**每日类活动，而不是只领第一个。
 *
 * 2026-11-14 对齐 magpie opencode-codearts-auth 0.3.18（#1110）：活动列表里
 * `USER_LOGIN` 类型同时挂着普通每日签到（100）与赛事每日签到（1000/天），
 * 一次性报名礼也是 `USER_LOGIN`。旧实现 `find` 第一个 —— 排在前面的是已确认
 * 活动时整个函数提前返回 already-claimed，两个每日签到都漏领（每天最多差 1100）。
 *
 * 本套件用注入 fetcher 的纯流程测试锁定：
 *   ① 两个可领活动都被 claim + confirm，积分求和（100 + 1000 = 1100）；
 *   ② 一次性报名礼（标题不含 签到/每日）不领；
 *   ③ 第一个活动已领取（CLAIMED）时不再提前返回，后面的照领；
 *   ④ 未报名的赛事签到被上游拒绝（未报名）→ inactive，普通签到仍领到；
 *   ⑤ 赛事活动用完（不在列表）→ 只领普通签到，行为不变。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import ts from 'typescript'

const sourceRoot = fileURLToPath(new URL('../vendor/channel-pack/src/', import.meta.url))
// @deepseek-ai/* 仅被类型引用（`import type`），运行时不需要真实模块 ——
// 指到一个空模块即可（值引用会在 load 阶段报错，那时说明引入了真依赖）。
const kernel = 'data:text/javascript,export {}'
const hooks = registerHooks({
  resolve(specifier, context, next) {
    // vendor/channel-pack/src 内部的相对引用全部按 .ts 解析（源码里写 .js 是
    // ESM 习惯，编译产物才有 .js —— 单测直跑源码时必须重写）。
    if (specifier.startsWith('@deepseek-ai/')) {
      return { url: kernel, shortCircuit: true }
    }
    if (specifier.startsWith('.') && context.parentURL?.includes('/vendor/channel-pack/src/')) {
      return { url: new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith('file://' + sourceRoot) && url.endsWith('.ts')) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(fs.readFileSync(fileURLToPath(url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: fileURLToPath(url),
      }).outputText,
    }
    return next(url, context)
  },
})
const { claimCodeArtsDailyCheckin, findDailyCheckinActivities } = await import('../vendor/channel-pack/src/codearts-credits.ts')

const credential = { access_key_id: 'AK', secret_access_key: 'SK', security_token: 'TOKEN', expires_at: new Date(Date.now() + 3600000).toISOString() }

/** 构造一个活动列表条目。 */
const activity = (id, title, { claimable = true, status = 'ENTRY', amount = 100 } = {}) => ({
  campaignId: id, type: 'USER_LOGIN', title, claimable, status, amount, benefitAmount: amount,
})

/** 注入式 fetcher：按 URL 分流，记录 claim/confirm 的 campaignId 顺序。 */
function fixture({ activities, claimFailures = {} } = {}) {
  const claimed = []
  const confirmed = []
  const fetcher = async (url, options = {}) => {
    const u = String(url)
    const respond = data => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } })
    if (u.includes('/snap-manager/v1/statistics/plugin')) {
      return respond({ package: { is_credit_package: true, package_name_cn: '积分账户' }, metrics: {} })
    }
    if (u.includes('/ops/delivery')) {
      return respond({ items: activities.map(a => ({ ...a })) })
    }
    if (u.includes('/ops/claim')) {
      const body = JSON.parse(options.body ?? '{}')
      const campaignId = body.campaignId
      claimed.push(campaignId)
      const failure = claimFailures[campaignId]
      if (failure !== undefined) return new Response(JSON.stringify({ code: failure.code ?? -1, message: failure.message }), { status: 200, headers: { 'content-type': 'application/json' } })
      return respond({ id: `benefit-${campaignId}`, benefitAmount: activities.find(a => String(a.campaignId) === String(campaignId))?.benefitAmount ?? 100 })
    }
    if (u.includes('/ops/confirm')) {
      const body = JSON.parse(options.body ?? '{}')
      confirmed.push(body.campaignId)
      return respond({ ok: true })
    }
    return new Response('unexpected ' + u, { status: 404 })
  }
  return { fetcher, claimed, confirmed }
}

let failures = 0
const check = async (name, run) => {
  try { await run(); console.log('  ok  ' + name) }
  catch (error) { failures += 1; console.error('FAIL  ' + name + ' — ' + error.message) }
}

await check('普通签到 + 赛事签到都被领取，积分求和 1100', async () => {
  const f = fixture({ activities: [
    activity('34', '每日签到得积分', { amount: 100 }),
    activity('40', '小红书 Skill 创新赛 签到', { amount: 1000 }),
  ] })
  const outcome = await claimCodeArtsDailyCheckin(credential, f.fetcher)
  assert.equal(outcome.kind, 'claimed', JSON.stringify(outcome))
  assert.equal(outcome.credit, 1100, `积分必须求和 100+1000，实际 ${outcome.credit}`)
  assert.deepEqual(f.claimed, ['34', '40'], '两个活动都要发 claim')
  assert.deepEqual(f.confirmed, ['34', '40'], '两个活动都要 confirm')
})

await check('一次性报名礼（标题不含 签到/每日）不领', async () => {
  const f = fixture({ activities: [
    activity('34', '每日签到得积分', { amount: 100 }),
    activity('42', '小红书 Skill 创新赛 报名礼', { amount: 500 }),
  ] })
  const outcome = await claimCodeArtsDailyCheckin(credential, f.fetcher)
  assert.equal(outcome.kind, 'claimed')
  assert.equal(outcome.credit, 100, `报名礼不计入，实际 ${outcome.credit}`)
  assert.deepEqual(f.claimed, ['34'])
})

await check('第一个活动已领取时不再提前返回，后面的照领', async () => {
  const f = fixture({ activities: [
    activity('34', '每日签到得积分', { claimable: false, status: 'CLAIMED', amount: 100 }),
    activity('40', '赛事 每日签到', { amount: 1000 }),
  ] })
  const outcome = await claimCodeArtsDailyCheckin(credential, f.fetcher)
  assert.equal(outcome.kind, 'claimed', JSON.stringify(outcome))
  assert.equal(outcome.credit, 1000, `只领到赛事那份，实际 ${outcome.credit}`)
  assert.deepEqual(f.claimed, ['40'])
})

await check('未报名的赛事被上游拒绝 → inactive，普通签到仍领到', async () => {
  const f = fixture({
    activities: [
      activity('34', '每日签到得积分', { amount: 100 }),
      activity('40', '赛事 签到', { amount: 1000 }),
    ],
    claimFailures: { 40: { code: -1, message: '需要先通过触发接口激活后参与' } },
  })
  const outcome = await claimCodeArtsDailyCheckin(credential, f.fetcher)
  assert.equal(outcome.kind, 'claimed', JSON.stringify(outcome))
  assert.equal(outcome.credit, 100, '普通签到那份要领到')
  assert.ok(f.claimed.includes('34'), '普通签到必须被 claim')
  assert.ok(f.claimed.includes('40'), '赛事签到也要尝试（上游拒绝才知道无资格）')
})

await check('赛事活动已结束（不在列表）→ 只领普通签到，行为不变', async () => {
  const f = fixture({ activities: [activity('34', '每日签到得积分', { amount: 100 })] })
  const outcome = await claimCodeArtsDailyCheckin(credential, f.fetcher)
  assert.equal(outcome.kind, 'claimed')
  assert.equal(outcome.credit, 100)
  assert.deepEqual(f.claimed, ['34'])
})

await check('findDailyCheckinActivities 的过滤判据（标题域）', async () => {
  const rows = findDailyCheckinActivities([
    activity('1', '每日签到得积分'),
    activity('2', 'xx大赛 签到打卡'),
    activity('3', '每日悦读'),
    activity('4', '新人报名礼'),
    activity('5', 'invite 活动签到'),
  ])
  assert.deepEqual(rows.map(r => r.campaignId), ['1', '2', '3', '5'],
    '标题含 签到/每日 的都算（含赛事的），报名礼不算')
})

if (failures > 0) console.error(`codearts-multi-checkin-test: ${failures} failure(s)`)
else console.log('codearts-multi-checkin-test: every daily campaign is claimed')
process.exitCode = failures > 0 ? 1 : 0
