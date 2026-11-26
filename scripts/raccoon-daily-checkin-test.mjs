/**
 * 商汤小浣熊「每日签到 = 积分续期」的回归钉子（2026-11-19）。
 *
 * ## 这条测试保护什么
 *
 * 商汤的每日 300 分由服务端 00:00 自动发放（无端点），但默认**当日 24:00
 * 清零**；完成一次登录态动作（`GET /office/v3/setting_info`）后转为 7 天。
 * 用户实测账单：连续 7 天的 `daily_grant` 全部「当日 24:00」并当晚作废，
 * 只有登录过的那天是「+7 天」—— 所以不签 = 每天白丢 300 分。
 *
 * 本测试钉住三条语义：
 * 1. 今天已经是 7 天窗口 → `already-claimed`（幂等，且**不发** setting_info）
 * 2. 今天是当日清零态     → 发 setting_info，返回 `extended`（**不是** claimed）
 * 3. `extended` 必须计入 `coversToday`，且**不得**计入 claimed/totalCredit
 *    （余额一分未增，计进去会显示「今日领取 +300」，与事实不符）
 */
import assert from 'node:assert/strict'
import { exitIfDirectRun } from './lib/direct-run.mjs'

/** 北京时区的今天（与服务端账单同口径）。 */
function beijingToday() {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
}

/** 明天（用于构造 7 天窗口的 expire_at）。 */
function tomorrowOf(day) {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 6)
  return `${d.toISOString().slice(0, 10)}T23:59:59+08:00`
}

/**
 * 造一个假 fetcher：按 URL 分派，记录每次调用。
 * @param {{ today: string, alreadyExtended: boolean, touchFails?: boolean }} plan
 */
function makeFetcher(plan) {
  const calls = []
  const fetcher = async (url, init) => {
    const text = String(url)
    calls.push(text)
    const dailyExpire = plan.alreadyExtended
      ? tomorrowOf(plan.today)
      : `${plan.today}T23:59:59+08:00`
    const bills = {
      code: 0,
      message: '',
      data: {
        items: [
          { created_at: `${plan.today}T00:00:00+08:00`, biz_type: 'daily_grant', points: 300, expire_at: dailyExpire },
          // 干扰项：非 daily_grant 必须被忽略
          { created_at: `${plan.today}T09:00:00+08:00`, biz_type: 'desktop', points: -2, expire_at: '' },
        ],
      },
    }
    if (text.includes('/points/v1/bills')) {
      return { status: 200, json: async () => bills }
    }
    if (text.includes('/office/v3/setting_info')) {
      if (plan.touchFails === true) {
        return { status: 200, json: async () => ({ code: 40001, message: '会话已失效', data: undefined }) }
      }
      return { status: 200, json: async () => ({ code: 0, message: 'success', data: { available_points: 4016 } }) }
    }
    throw new Error(`意外的 URL: ${text}`)
  }
  return { fetcher, calls }
}

export async function verifyRaccoonDailyCheckin() {
  const credits = await import('../vendor/channel-pack/src/raccoon-credits.ts')
  const { RACCOON } = await import('../vendor/channel-pack/src/raccoon-product.ts')
  const credential = { access_token: 'fixture-token', token_type: 'Bearer' }
  const product = RACCOON
  const today = beijingToday()

  // ① 已延期 → already-claimed，且**不触碰** setting_info（幂等，不白发请求）
  {
    const { fetcher, calls } = makeFetcher({ today, alreadyExtended: true })
    const outcome = await credits.claimRaccoonDailyCheckin(product, credential, fetcher)
    assert.equal(outcome.kind, 'already-claimed', '今天已延期必须报 already-claimed，不是 extended')
    assert.match(outcome.message, /今日已延期/, '幂等文案要说清「今天已延期」')
    assert.equal(calls.filter(u => u.includes('setting_info')).length, 0, '已延期时不得再打 setting_info')
  }

  // ② 当日清零态 → 发 setting_info，返回 extended（关键：不是 claimed）
  {
    const { fetcher, calls } = makeFetcher({ today, alreadyExtended: false })
    const outcome = await credits.claimRaccoonDailyCheckin(product, credential, fetcher)
    assert.equal(calls.filter(u => u.includes('setting_info')).length, 1, '当日清零态必须触发一次 setting_info')
    assert.equal(outcome.kind, 'extended', '续期必须报 extended —— claimed 会渲染「+300」，而余额未增')
    // extended 不带 credit 字段（类型上就不该有），确认没被塞进金额
    assert.equal(outcome.credit, undefined, 'extended 不得携带 credit（没有新积分）')
    assert.ok(typeof outcome.expiresAt === 'string' && outcome.expiresAt !== '', '要带出新到期时间供明细显示')
    assert.match(outcome.message, /积分已延期/, '文案要与前端文案对齐')
  }

  // ③ setting_info 业务码失败 → failed（真实异常不该被当成已签到吞掉）
  {
    const { fetcher } = makeFetcher({ today, alreadyExtended: false, touchFails: true })
    const outcome = await credits.claimRaccoonDailyCheckin(product, credential, fetcher)
    assert.equal(outcome.kind, 'failed', '会话失效必须如实报 failed，否则当天静默漏签')
  }

  // ④ 汇总口径：extended 计入 coversToday，但不计 claimed / totalCredit
  {
    const helpers = await import('../vendor/channel-pack/src/credits-helpers.ts')
    const summary = helpers.computeClaimSummary([
      { kind: 'extended', message: '积分已延期' },
      { kind: 'claimed', credit: 600, streakDays: 0, isStreakDay: false },
    ])
    assert.equal(summary.coversToday, 2, 'extended 必须计入「今天已处理」，否则每 30 分钟重复签到')
    assert.equal(summary.claimed, 1, 'extended 不得计入 claimed')
    assert.equal(summary.totalCredit, 600, 'extended 不得把积分算进总额（余额未增）')
    assert.equal(summary.extended, 1, 'extended 必须在汇总层单独计数（2026-11-26）')
  }

  // ④-b 小浣熊「一轮只有续期」的汇总口径（2026-11-26 真实缺陷的回归钉子）
  //
  // 缺陷现场：汇总层没有 extended 这一栏 ⇒ 四个计数全 0 ⇒ 渠道行
  // `parts.length === 0` ⇒ 显示「无可领」，而逐账号明细写着「积分已延期」。
  {
    const helpers = await import('../vendor/channel-pack/src/credits-helpers.ts')
    const ac = await import('../vendor/channel-pack/src/auto-checkin.ts')
    const summary = helpers.computeClaimSummary([{ kind: 'extended', message: '积分已延期' }])
    assert.equal(summary.extended, 1, 'extended 必须单独计数')
    assert.equal(summary.claimed, 0, '续期不是领取，不得计入 claimed')
    assert.equal(summary.alreadyClaimed, 0, '今天第一次续期不是「之前领过」')
    assert.equal(summary.coversToday, 1, '续期确实处理了今天这一轮')
    const text = ac.describeChannel(summary)
    assert.match(text, /积分已延期/, '渠道行必须说清「积分已延期」')
    assert.ok(!text.includes('无可领'), '⚠️ 纯续期不得掉进「无可领」兜底（旧缺陷）')
    assert.equal(text, '1 个积分已延期', `渠道行文案契约：「N 个积分已延期」，实际是「${text}」`)
    // 账本结局——自动签到那一轮（`describeRun` 是整轮摘要，也要报出来）
    const runText = ac.describeRun({
      providers: 1, claimed: 0, totalCredit: 0, totalByUnit: { credit: 0, token: 0 },
      alreadyClaimed: 0, extended: 1, inactive: 0, failed: 0, coversToday: 1,
      skipped: 0, errors: 0, givenUp: 0,
    })
    assert.match(runText, /积分已延期/, '整轮摘要也要报出续期')
    assert.ok(!runText.includes('没有需要领取的账号'), '⚠️ 纯续期不得落进「没有需要领取的账号」兜底（旧缺陷）')
  }

  // ⑤ 展示态映射：extended 必须映射到自己的组，不能落到 claimed
  //
  // ⚠️ 原用例调的是不存在的 `autoCheckinRowsFromOutcomes?.(...)`（可选调用 ⇒
  //    永远 undefined ⇒ 整段断言被跳过）。2026-11-26 改调真实的
  //    `aggregateAccountRows`（它才是逐账号明细的产出函数）。
  {
    const ac = await import('../vendor/channel-pack/src/auto-checkin.ts')
    const rows = ac.aggregateAccountRows('raccoon', [
      { accountId: 'a1', nickname: '账号一', outcome: { kind: 'extended', message: '积分已延期' } },
    ])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].outcome, 'extended', 'extended 不得被折叠成其他展示态')
    assert.equal(rows[0].amount, 0, 'extended 不产生金额')
  }

  // ⑥ 结局强弱表只有一份（2026-11-26：此前 merge/aggregate/record 三份不一致）
  {
    const ac = await import('../vendor/channel-pack/src/auto-checkin.ts')
    assert.equal(ac.outcomeRank('claimed'), 4, 'claimed 最强')
    assert.equal(ac.outcomeRank('extended'), 3, 'extended 低于 claimed、高于 already-claimed')
    assert.equal(ac.outcomeRank('already-claimed'), 2)
    assert.equal(ac.outcomeRank('failed'), 1)
    assert.equal(ac.outcomeRank('skipped'), 0, 'skipped 不参与升级')
    assert.equal(ac.outcomeRank('stale'), 0, '账本专用结局同样兜底 0')
    assert.equal(ac.outcomeRank(undefined), 0)
    const extendedRow = { provider: 'raccoon', accountId: 'a1', accountName: '账号一', outcome: 'extended', amount: 0, unit: 'credit', message: '积分已延期' }
    assert.equal(
      ac.mergeAccountResult(extendedRow, { ...extendedRow, outcome: 'failed', message: '上游 502' }).outcome,
      'extended',
      '⚠️ extended 不被后来的 failed 覆盖（旧实现把 extended 记成 0 强，任何结局都能盖掉它）',
    )
  }

  // ⑦ 编程错误守卫：product 缺省却走默认 fetchStatus ⇒ 抛错，不静默降级
  //
  // 小浣熊分支此前就是这种形态（漏传 `precheckStatus: false`）：默认
  // `fetchStatus` 会把 raccoon 凭据发给 **buddy** 的签到状态端点，只因 `product`
  // 为 undefined 先抛 TypeError 才碰巧没发出请求。现在必须显式失败。
  {
    const helpers = await import('../vendor/channel-pack/src/credits-helpers.ts')
    await assert.rejects(
      () => helpers.collectClaimResults([], undefined, { resolve: async () => undefined }),
      /precheckStatus/,
      '⚠️ product 为 undefined + 默认 fetchStatus + 未跳过预检 ⇒ 必须抛编程错误',
    )
    const skipped = await helpers.collectClaimResults([], undefined, {
      resolve: async () => undefined,
      precheckStatus: false,
    })
    assert.equal(skipped.results.length, 0)
    assert.equal(skipped.summary.extended, 0, '空账号池的汇总也要带上恒存在的 extended 栏')
    // 注入自己的 fetchStatus（minimax 形态）时 product 缺省是合法的，不得抛错
    const injected = await helpers.collectClaimResults([], undefined, {
      resolve: async () => undefined,
      fetchStatus: async () => null,
    })
    assert.equal(injected.results.length, 0)
  }

  // ⑧ RPC 分支契约（静态）：小浣熊的 claimAll 必须显式传 precheckStatus: false
  {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(new URL('../vendor/channel-pack/src/channel-pack-rpc.ts', import.meta.url), 'utf8')
    const start = source.indexOf('if (req.provider === RACCOON.id) {')
    const end = source.indexOf('if (req.provider === MINIMAX.id) {', start)
    assert.ok(start > 0 && end > start, '必须能定位 raccoon 分支')
    const branch = source.slice(start, end)
    assert.match(branch, /collectClaimResults<RaccoonCredential, undefined>/)
    assert.match(branch, /precheckStatus: false/, '⚠️ 小浣熊分支必须跳过 buddy 式的状态预检（参照 autoclaw/officeace）')
  }

  console.log('ok  raccoon 每日签到：幂等分支/续期分支/失败分支 + 汇总与展示态口径 + 强弱表/预检守卫/RPC 契约')
}

exitIfDirectRun(import.meta.url, () => verifyRaccoonDailyCheckin())
