/**
 * 自动签到**逐渠道记账**回归（2026-10-26，两个真实缺陷）。
 *
 * 锁住四类行为（任务契约点名的那四条），外加几条实现时发现的坑：
 *
 * 1. **失败渠道不记日期**（缺陷 A）：一轮里某渠道失败 ⇒ 它不记「今天完成」，
 *    当天后续启动会补跑；成功的渠道**不重跑**（幂等请求只发给真正需要的渠道）。
 * 2. **coversToday=false 不记日期**（缺陷 B）：Qoder 在 10:00（UTC+8）刷新前报
 *    「昨天已领」⇒ 该渠道留在待补跑，最早在**当日刷新时刻**再问；10:00 之后那轮
 *    能真正领到并记完成。
 * 3. **重跑上限**：同一渠道当天最多 3 次；超限置 `given-up`（今日已放弃），
 *    失败原因保留在账本与面板文字里，且**不再打上游**。
 * 4. **旧格式兼容**：只有全局 `lastDate` 的 v1 文档照常读出（`ranToday` 为真），
 *    但 per-provider 账本缺失 ⇒ 下一次启动照样补跑。
 *
 * 另外几条守卫：
 * 5. 真实现场形态：Qoder 10:00 前回 **inactive**（`NOT_REFRESHED_YET_HINT`，无痕迹）
 *    时，重试额度**不能**在刷新前被烧完（否则 08:00 启动会在 09:30 用尽 3 次）；
 * 6. 整轮全失败时**不**把 `lastDate` 写成今天（否则面板会说「今日已签到」）；
 * 7. 不支持签到的渠道记 `skipped`，当天不重试；
 * 8. 补跑定时器走既有 `deps.schedule` 注入点：`stop()` / `setEnabled(false)` 能取消、
 *    「还没到重试时刻」的启动会排到那一刻、不跨 UTC+8 日界；
 * 9. 刷新时刻常量与 `qoder-credits.ts` 的 `QODER_CAMPAIGN_REFRESH_HOUR_UTC8` 同值；
 * 10. 待补跑计数只数**当前账号池里**的渠道（否则残留账本会让补跑排成死循环）；
 * 11. 有待跑渠道时 `state().running` 立刻为真（面板「进行中」反馈不丢）。
 *
 * 全部用**假上游**（注入的 `claim`）与**内存 store**：零网络、零真实凭据、
 * 零文件系统写入、零等待。`DSH_HOME` 指向临时目录，绝不碰真实
 * `$DSH_HOME/channel-pack/auto-checkin.json`。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const ts = (await import('typescript')).default

// 真实 DSH home 只读不写：把环境指到临时目录（`resolveChannelPackHome` 会读它）。
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-auto-checkin-ledger-'))
process.env.DSH_HOME = scratch
process.env.DSH_CHANNEL_PACK_STATE_DIR = scratch

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href
      if (fs.existsSync(fileURLToPath(url))) return { url, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: ts.transpileModule(fs.readFileSync(fileURLToPath(url), 'utf8'), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
          fileName: fileURLToPath(url),
        }).outputText,
      }
    }
    return nextLoad(url, context)
  },
})

let checks = 0
const check = async (name, run) => { await run(); checks += 1; console.log('ok  ' + name) }

try {
  const ac = await import('../vendor/channel-pack/src/auto-checkin.ts')

  // 时间基准：2026-10-26 09:00 UTC+8 = 01:00Z（Qoder 刷新在 10:00 UTC+8 = 02:00Z）。
  const at0900 = Date.parse('2026-10-26T01:00:00Z')
  const at0930 = Date.parse('2026-10-26T01:30:00Z')
  const at1005 = Date.parse('2026-10-26T02:05:00Z')
  const at2300 = Date.parse('2026-10-26T15:00:00Z')
  // 23:45 UTC+8：再等 30 分钟就越过 UTC+8 日界（次日 00:00 = 16:00Z）。
  const at2345 = Date.parse('2026-10-26T15:45:00Z')
  const MIN = 60_000

  const memoryStore = (initial) => {
    let doc = ac.sanitizeAutoCheckin(initial ?? {})
    return {
      kind: 'memory',
      load: () => ({
        ...doc,
        providers: { ...doc.providers },
        channels: doc.channels.map((c) => ({ ...c })),
        results: doc.results.map((r) => ({ ...r })),
      }),
      save: async (next) => {
        doc = {
          ...next,
          providers: { ...next.providers },
          channels: next.channels.map((c) => ({ ...c })),
          results: next.results.map((r) => ({ ...r })),
        }
      },
      peek: () => doc,
    }
  }

  const summary = (over) => ({
    ok: true,
    value: {
      results: [],
      summary: {
        claimed: 0, totalCredit: 0, alreadyClaimed: 0, inactive: 0, failed: 0, coversToday: 0,
        totalByUnit: { credit: 0, token: 0 }, ...over,
      },
    },
  })
  const claimed = (n = 1, credit = 100) => summary({ claimed: n, totalCredit: credit, coversToday: n, totalByUnit: { credit, token: 0 } })
  const already = (coversToday) => summary({ alreadyClaimed: 1, coversToday })
  const failedSummary = () => summary({ failed: 1 })
  const upstreamError = (message = 'HTTP 502') => ({ ok: false, error: { code: 'upstream', message } })
  const unsupported = () => ({ ok: false, error: { code: 'unsupported', message: '该渠道不支持每日签到' } })

  const harness = ({ providers, responses, now, initial }) => {
    const calls = []
    const scheduled = []
    const clock = { ms: now }
    const store = memoryStore(initial)
    const engine = ac.createAutoCheckin({
      store,
      listProviderIds: async () => providers,
      claim: async (provider) => {
        calls.push(provider)
        const queue = responses[provider] ?? []
        const next = queue.length > 1 ? queue.shift() : queue[0]
        return typeof next === 'function' ? next(provider) : (next ?? claimed())
      },
      now: () => clock.ms,
      schedule: (fn, ms) => {
        const slot = { fn, ms, cancelled: false, cancel() { slot.cancelled = true } }
        scheduled.push(slot)
        return slot
      },
      warn: () => {},
    })
    return { engine, calls, scheduled, clock, store, ledger: (p) => store.peek().providers[p] }
  }

  // ── 1. 失败渠道不记日期、成功渠道不重跑（缺陷 A） ──
  await check('失败渠道留在待补跑，成功的渠道不重跑（缺陷 A）', async () => {
    const h = harness({
      providers: ['buddy', 'kuku'],
      responses: { buddy: [claimed(2, 200)], kuku: [upstreamError('凭据已失效')] },
      now: at0900,
    })
    await h.engine.runIfDue()
    assert.deepEqual(h.calls, ['buddy', 'kuku'], '第一轮两个渠道各跑一次')
    assert.equal(h.ledger('buddy').status, 'done', '成功的渠道记 done')
    assert.equal(h.ledger('kuku').status, 'pending', '失败的渠道**不**记完成')
    assert.equal(h.ledger('kuku').attempts, 1, '失败的尝试计数 1')
    assert.equal(h.ledger('kuku').lastText, '出错', '失败原因落盘（面板展示用）')
    assert.equal(h.store.peek().lastDate, ac.utc8DateString(at0900), '整轮有渠道被处理过 ⇒ lastDate 记今天')

    h.clock.ms = at0900 + 5 * MIN
    await h.engine.runIfDue()
    assert.deepEqual(h.calls, ['buddy', 'kuku'], '未到重试间隔时一个渠道都不重跑')

    h.clock.ms = at0900 + 31 * MIN
    await h.engine.runIfDue()
    assert.deepEqual(h.calls, ['buddy', 'kuku', 'kuku'], '只有失败的渠道补跑，成功的渠道幂等不重打')
    assert.equal(h.ledger('kuku').attempts, 2, '补跑计入 attempts')
  })

  // ── 2. coversToday=false 不记日期、10:00 后补上（缺陷 B） ──
  await check('coversToday=false 不记完成，等到 10:00 刷新后再领（缺陷 B）', async () => {
    const h = harness({
      providers: ['qoder'],
      responses: { qoder: [already(0), claimed(1, 100)] },
      now: at0930,
    })
    await h.engine.runIfDue()
    assert.deepEqual(h.calls, ['qoder'], '刷新前也跑一次（与旧行为一致）')
    const stale = h.ledger('qoder')
    assert.equal(stale.status, 'pending', '「非今日轮次」**不**算今天完成')
    assert.equal(stale.lastOutcome, 'stale', '账本区分「非今日轮次」与真失败')
    assert.equal(h.store.peek().lastDate, '', '整轮没有任何渠道证明今天 ⇒ 不写 lastDate')
    assert.match(h.store.peek().lastResult, /均非今日轮次/, '摘要显式标注「非今日轮次」，不说成「今天已领」')
    assert.equal(ac.providerNeedsRun(stale, at0930), false, '刷新前不立刻重问')
    assert.equal(ac.providerNeedsRun(stale, at1005), true, '10:00（UTC+8）之后可以再问')
    assert.equal(ac.nextAttemptAt(stale, at0930), ac.utc8RefreshBoundaryMs(at0930), '下次时刻 = 当日刷新时刻')

    h.clock.ms = at1005
    await h.engine.runIfDue()
    assert.deepEqual(h.calls, ['qoder', 'qoder'], '刷新后补跑')
    assert.equal(h.ledger('qoder').status, 'done', '刷新后领到 ⇒ 记今天完成')
    assert.equal(h.ledger('qoder').lastOutcome, 'claimed', '结局是 claimed')
    assert.equal(h.store.peek().lastDate, ac.utc8DateString(at1005), '这一轮才写 lastDate')

    h.clock.ms = at2300
    await h.engine.runIfDue()
    assert.deepEqual(h.calls, ['qoder', 'qoder'], '已完成的渠道当天不再跑')
  })

  // ── 3. 重跑上限 ──
  await check('同一渠道当天最多 3 次，超限记「今日已放弃」并保留原因', async () => {
    const h = harness({
      providers: ['kuku'],
      responses: { kuku: [upstreamError('HTTP 502'), upstreamError('HTTP 502'), upstreamError('errno:-6 未登录')] },
      now: at0900,
    })
    await h.engine.runIfDue()
    assert.equal(h.ledger('kuku').attempts, 1)
    h.clock.ms = at0900 + 31 * MIN
    await h.engine.runIfDue()
    assert.equal(h.ledger('kuku').attempts, 2)
    h.clock.ms = at0900 + 62 * MIN
    await h.engine.runIfDue()
    const given = h.ledger('kuku')
    assert.equal(given.attempts, 3, '第 3 次尝试')
    assert.equal(given.status, 'given-up', '达到上限 ⇒ 今日已放弃')
    assert.match(given.lastText, /今日已放弃/, '面板文字带出「今日已放弃」')
    assert.equal(given.lastAt, at0900 + 62 * MIN, '最后一次尝试时刻落盘')
    assert.match(h.store.peek().lastResult, /今日已放弃/, '本轮摘要也说出「今日已放弃」')

    h.clock.ms = at2300
    await h.engine.runIfDue()
    assert.equal(h.calls.length, 3, '超限后当天不再调用上游')
    assert.equal(ac.providerNeedsRun(given, at2300), false, 'given-up 的渠道任何时刻都不再跑')
  })

  // ── 4. 旧格式兼容 ──
  await check('旧 v1 文档（只有 lastDate）照常读，且下一次启动补跑', async () => {
    const legacy = {
      schema: 'dsh-codearts-auth/auto-checkin/v1',
      enabled: true,
      lastDate: '2026-10-26',
      lastResult: '11 个渠道：4 个失败',
      lastAt: at0900 - 60 * MIN,
      channels: [{ provider: 'kuku', text: '1 个失败' }],
      dismissedRunAt: 0,
    }
    const sanitized = ac.sanitizeAutoCheckin(legacy)
    assert.deepEqual(sanitized.providers, {}, '旧文档没有 per-provider 账本 ⇒ 空账本（不猜「今天已完成」）')
    assert.equal(sanitized.lastDate, '2026-10-26', '旧字段照常读出')
    assert.equal(sanitized.enabled, true, '开关照常读出')
    assert.deepEqual(sanitized.channels, [{ provider: 'kuku', text: '1 个失败' }], '逐渠道文字照常读出')

    const h = harness({
      providers: ['kuku', 'buddy'],
      responses: { kuku: [claimed(1, 100)], buddy: [claimed(1, 100)] },
      now: at0930,
      initial: legacy,
    })
    assert.equal(h.engine.state().ranToday, true, '旧语义保留：面板仍说「今日已自动签到」')
    await h.engine.runIfDue()
    assert.deepEqual(h.calls, ['buddy', 'kuku'], '旧文档不阻止补跑：两个渠道都会再跑一次')
    assert.equal(h.ledger('kuku').status, 'done', '补跑后记 done（并升级成 v2 账本）')
    assert.equal(h.ledger('buddy').day, '2026-10-26', '新账本带日期')
  })

  // ── 4b. 真实现场：Qoder 10:00 前回 inactive（无痕迹），不能在刷新前烧完重试额度 ──
  await check('Qoder 10:00 前回 inactive（无痕迹）也不会在刷新前烧完重试额度', async () => {
    // 实测形态（qoder-credits.ts）：刷新前 `kind: 'inactive'` + NOT_REFRESHED_YET_HINT，
    // 汇总里 claimed/alreadyClaimed/failed 全 0、coversToday 0 —— 与「非今日轮次」不同形
    // 但同义。若按普通 30 分钟重试，08:00 启动会在 08:30/09:00/09:30 烧完 3 次额度。
    const notRefreshed = summary({ inactive: 1 })
    const h = harness({
      providers: ['qoder'],
      responses: { qoder: [notRefreshed, claimed(1, 100)] },
      now: Date.parse('2026-10-26T00:00:00Z'), // 08:00 UTC+8
    })
    await h.engine.runIfDue()
    const first = h.ledger('qoder')
    assert.equal(first.status, 'pending', '「还没刷新」不算今天完成')
    assert.equal(first.lastOutcome, 'none', '没有痕迹的结局记 none')
    assert.equal(
      ac.nextAttemptAt(first, Date.parse('2026-10-26T00:00:00Z')),
      ac.utc8RefreshBoundaryMs(Date.parse('2026-10-26T00:00:00Z')),
      '下次时刻直接等到 10:00（不是 30 分钟后）',
    )
    // 08:30 / 09:00 / 09:30 三次启动都不该打上游（额度留到刷新之后）。
    for (const at of ['00:30:00', '01:00:00', '01:30:00']) {
      h.clock.ms = Date.parse(`2026-10-26T${at}Z`)
      await h.engine.runIfDue()
    }
    assert.deepEqual(h.calls, ['qoder'], '刷新前只在 08:00 跑过一次，重试额度没被烧掉')
    assert.equal(h.ledger('qoder').attempts, 1, 'attempts 仍是 1（没到上限）')
    // 10:05 补跑，这次领到。
    h.clock.ms = at1005
    await h.engine.runIfDue()
    assert.deepEqual(h.calls, ['qoder', 'qoder'], '10:00 之后补跑')
    assert.equal(h.ledger('qoder').status, 'done', '补跑领到 ⇒ 今天完成')
  })

  // ── 5. 全失败不写 lastDate ──
  await check('整轮全失败时不把 lastDate 写成今天', async () => {
    const h = harness({
      providers: ['kuku'],
      responses: { kuku: [upstreamError('凭据已失效')] },
      now: at0900,
    })
    await h.engine.runIfDue()
    assert.equal(h.store.peek().lastDate, '', '没有任何渠道证明今天 ⇒ 不写 lastDate')
    assert.equal(h.engine.state().ranToday, false, '面板不会说「今日已签到」')
    assert.match(h.engine.state().lastResult, /1 个渠道出错/, '摘要照常给出失败原因')
  })

  // ── 6. 不支持签到的渠道不重试 ──
  await check('不支持签到的渠道记 skipped，当天不重试', async () => {
    const h = harness({
      providers: ['cline'],
      responses: { cline: [unsupported()] },
      now: at0900,
    })
    await h.engine.runIfDue()
    assert.equal(h.ledger('cline').status, 'skipped')
    assert.equal(h.ledger('cline').attempts, 0, '跳过的渠道不计入 attempts（它没真跑）')
    h.clock.ms = at2300
    await h.engine.runIfDue()
    assert.equal(h.calls.length, 1, 'skipped 的渠道当天不再调上游')
  })

  // ── 7. 补跑排定 ──
  await check('有待补跑渠道时排一次当日补跑（复用 schedule，不跨日界）', async () => {
    const h = harness({
      providers: ['kuku'],
      responses: { kuku: [upstreamError('HTTP 502')] },
      now: at0900,
    })
    await h.engine.runIfDue()
    assert.equal(h.scheduled.length, 1, '失败后排出一次补跑')
    assert.equal(h.scheduled[0].ms, ac.AUTO_CHECKIN_MIN_RETRY_MS, '补跑时刻 = 最小重试间隔')
    h.engine.stop()
    assert.equal(h.scheduled[0].cancelled, true, 'stop() 取消补跑定时器')

    const late = harness({
      providers: ['kuku'],
      responses: { kuku: [upstreamError('HTTP 502')] },
      now: at2345,
    })
    await late.engine.runIfDue()
    assert.equal(late.scheduled.length, 0, '越过 UTC+8 日界的补跑不排（次日由下一次启动决定）')

    // 启动时「还没到重试时刻」也要把补跑排到那一刻（不必等下次启动）。
    const waiting = harness({
      providers: ['kuku'],
      responses: { kuku: [upstreamError('HTTP 502')] },
      now: at0900,
    })
    await waiting.engine.runIfDue()
    assert.equal(waiting.scheduled.length, 1)
    // 模拟「宿主重启」：同一份账本、20 分钟后启动（还没到 30 分钟的重试间隔）。
    const restarted = harness({
      providers: ['kuku'],
      responses: { kuku: [upstreamError('HTTP 502')] },
      now: at0900 + 20 * MIN,
      initial: waiting.store.peek(),
    })
    await restarted.engine.runIfDue()
    assert.deepEqual(restarted.calls, [], '未到重试时刻 ⇒ 这一轮不调上游')
    assert.equal(restarted.scheduled.length, 1, '但要排到最早可试的那一刻')
    assert.equal(restarted.scheduled[0].ms, 10 * MIN, '补跑时刻 = 剩余的重试间隔')

    // 关掉开关必须撤掉已排定的补跑（用户关掉后不该再被后台打一轮上游）。
    const off = harness({
      providers: ['kuku'],
      responses: { kuku: [upstreamError('HTTP 502')] },
      now: at0900,
    })
    await off.engine.runIfDue()
    assert.equal(off.scheduled.length, 1, '先排了一次补跑')
    await off.engine.setEnabled(false)
    assert.equal(off.scheduled[0].cancelled, true, 'setEnabled(false) 撤掉补跑定时器')
  })

  // ── 8. 账本纯函数 ──
  await check('账本纯函数：跨日按空账本、脏 status 回落 pending', async () => {
    const yesterday = { day: '2026-10-25', status: 'done', attempts: 3, lastAt: at0900, lastOutcome: 'claimed', lastText: '2 个 +200积分' }
    assert.equal(ac.providerNeedsRun(yesterday, at0900), true, '昨天的 done 不影响今天（今天还没跑）')
    assert.equal(ac.nextAttemptAt(yesterday, at0900), at0900, '跨日条目 ⇒ 立刻可跑')
    const dirty = ac.sanitizeAutoCheckin({
      providers: {
        kuku: { day: '2026-10-26', status: 'wat', attempts: 'x', lastAt: -1, lastOutcome: 'boom', lastText: 123 },
        '': { day: '2026-10-26' },
        ok: { day: '2026-10-26', status: 'done', attempts: 999, lastAt: at0900, lastOutcome: 'claimed', lastText: 'x' },
      },
    })
    assert.deepEqual(Object.keys(dirty.providers).sort(), ['kuku', 'ok'], '空 provider 名被丢弃')
    assert.equal(dirty.providers.kuku.status, 'pending', '未知 status 回落 pending（宁多重试，不整天漏签）')
    assert.equal(dirty.providers.kuku.attempts, 0, '非法 attempts 回落 0')
    assert.equal(dirty.providers.kuku.lastOutcome, 'none', '未知 outcome 回落 none')
    assert.equal(dirty.providers.kuku.lastText, '', '非字符串 lastText 回落空串')
    assert.equal(dirty.providers.ok.attempts, 99, 'attempts 被钳到上限 99（脏数据不撑大文档）')
  })

  // ── 8b. 状态反馈：有待跑渠道时 running 立刻为真（面板「进行中」） ──
  await check('有待跑渠道时 setEnabled 返回的 state 立刻显示 running', async () => {
    const h = harness({
      providers: ['kuku'],
      responses: { kuku: [upstreamError('HTTP 502')] },
      now: at0900,
    })
    const state = await h.engine.setEnabled(true)
    // 一轮是异步跑完的：这里要的是**返回瞬间**就能看到「进行中」。
    assert.equal(state.running, true, '打开开关后 state.running 立刻为真（界面不会像没生效）')
    await h.engine.runIfDue()
    // 跑完（仍有待补跑）后不再声称进行中。
    assert.equal(h.engine.state().running, false, '跑完一轮后 running 回落 false')
  })

  // ── 9. 刷新时刻常量漂移守卫 ──
  await check('刷新时刻常量与 qoder-credits 的权威值同值', async () => {
    const qoderSource = fs.readFileSync(fileURLToPath(new URL('../vendor/channel-pack/src/qoder-credits.ts', import.meta.url)), 'utf8')
    const match = /export const QODER_CAMPAIGN_REFRESH_HOUR_UTC8 = (\d+)/.exec(qoderSource)
    assert.ok(match, 'qoder-credits.ts 里应有 QODER_CAMPAIGN_REFRESH_HOUR_UTC8')
    assert.equal(
      ac.AUTO_CHECKIN_REFRESH_HOUR_UTC8,
      Number(match[1]),
      'auto-checkin 的补跑时刻常量必须与渠道侧权威值同值（漂移会让补跑算错时刻）',
    )
    assert.equal(ac.AUTO_CHECKIN_REFRESH_HOUR_UTC8, 10, 'Qoder 活动每日 10:00（UTC+8）刷新')
    assert.equal(ac.utc8RefreshBoundaryMs(Date.parse('2026-10-26T01:59:59Z')), Date.parse('2026-10-26T02:00:00Z'), '刷新边界算术')
    assert.equal(ac.utc8DayStartMs(Date.parse('2026-10-26T01:59:59Z')), Date.parse('2026-10-25T16:00:00Z'), 'UTC+8 日界 = UTC 前一日 16:00')
  })

  // ── 10. 待补跑计数只数当前账号池里的渠道 ──
  await check('待补跑计数只数当前账号池里的渠道（防补跑死循环）', async () => {
    const providers = {
      kuku: { day: '2026-10-26', status: 'pending', attempts: 1, lastAt: at0900, lastOutcome: 'error', lastText: '出错' },
      gone: { day: '2026-10-26', status: 'pending', attempts: 1, lastAt: at0900, lastOutcome: 'error', lastText: '出错' },
    }
    assert.equal(ac.pendingProviderCount(providers, at0900), 2, '不传 only 时数全部（纯函数默认）')
    assert.equal(ac.pendingProviderCount(providers, at0900, ['kuku']), 1, '传 only 时只数当前账号池里的渠道')
    assert.equal(ac.pendingProviderCount(providers, at0900, []), 0, '账号池为空 ⇒ 没有待补跑')
  })

  // ── 11. 逐账号明细（签到结果表格，2026-10-27）──
  await check('逐账号明细：按账号聚合、ZCode 多 plan 相加、优先级与四态映射', async () => {
    const row = (accountId, outcome, nickname) => ({ accountId, nickname, outcome })
    // ① 同一账号多个 plan 都 claimed ⇒ 金额相加成一行
    const zcode = ac.aggregateAccountRows('zcode', [
      row('acc1', { kind: 'claimed', credit: 50_000_000, unit: 'token', streakDays: 0, isStreakDay: false }, '主号'),
      row('acc1', { kind: 'claimed', credit: 50_000_000, unit: 'token', streakDays: 0, isStreakDay: false }, '主号'),
    ])
    assert.equal(zcode.length, 1, '同一账号的多条 outcome 必须聚合成一行')
    assert.equal(zcode[0].outcome, 'claimed')
    assert.equal(zcode[0].amount, 100_000_000, '多个 plan 的收益必须相加')
    assert.equal(zcode[0].unit, 'token', '单位取渠道上报的 token')
    assert.equal(zcode[0].accountName, '主号')

    // ② 优先级：claimed > already-claimed > failed > skipped
    const mixed = ac.aggregateAccountRows('kuku', [
      row('a', { kind: 'inactive', message: '今天没有可领的' }),
      row('a', { kind: 'claimed', credit: 100, streakDays: 1, isStreakDay: true }),
    ])
    assert.equal(mixed[0].outcome, 'claimed', 'claimed 必须压过 inactive')
    assert.equal(mixed[0].amount, 100)

    // ③ inactive 归到 skipped（不是 failed —— 今天没东西可领不算异常）
    const idle = ac.aggregateAccountRows('officeace', [row('b', { kind: 'inactive', message: '今日无可领' })])
    assert.equal(idle[0].outcome, 'skipped', 'inactive 必须映射成 skipped 而不是 failed')

    // ④ failed 带原因
    const bad = ac.aggregateAccountRows('trae', [row('c', { kind: 'failed', code: 500, message: 'HTTP 502' })])
    assert.equal(bad[0].outcome, 'failed')
    assert.equal(bad[0].message, 'HTTP 502', '失败原因必须透传（表格的「说明」列）')

    // ⑤ 「领取成功但 +0 分」是合法形态，不能因为 0 就改判失败
    const zero = ac.aggregateAccountRows('monkeycode', [row('d', { kind: 'claimed', credit: 0, streakDays: 0, isStreakDay: false })])
    assert.equal(zero[0].outcome, 'claimed')
    assert.equal(zero[0].amount, 0, '+0 分是合法的「领取成功」')
  })

  await check('逐账号明细：脏数据丢整行、跨日不展示、旧文档无 results 照常读', async () => {
    // ① 未知 outcome 丢整行（不能回落成 failed 凭空制造告警）
    const dirty = ac.sanitizeAutoCheckin({
      results: [
        { provider: 'kuku', accountId: 'a', outcome: 'claimed', amount: 100 },
        { provider: 'kuku', accountId: 'b', outcome: '没这个状态' },
        { provider: '', accountId: 'c', outcome: 'claimed' },
        { provider: 'kuku', accountId: '', outcome: 'claimed' },
      ],
    })
    assert.equal(dirty.results.length, 1, '只有第一行合法，其余丢弃')
    assert.equal(dirty.results[0].accountId, 'a')

    // ② 旧文档（完全没有 results 字段）必须照常读出空数组
    const legacy = ac.sanitizeAutoCheckin({ lastDate: '2026-10-26', lastResult: '旧' })
    assert.deepEqual(legacy.results, [], '旧文档缺 results ⇒ 空数组，不是 undefined')

    // ③ accountName 缺失时回落 accountId（前端不再二次回落）
    const noName = ac.sanitizeAutoCheckin({
      results: [{ provider: 'kuku', accountId: 'acc-9', outcome: 'claimed', amount: 5 }],
    })
    assert.equal(noName.results[0].accountName, 'acc-9', '没有昵称时用 accountId 填，避免表格出现空白格')
  })

  // ── 12. 端到端：claimAll 的逐账号结果必须真的落进 doc.results 并能被 state() 读到 ──
  await check('端到端：逐账号明细落盘并在 state() 暴露（表格数据源）', async () => {
    /*
     * 为什么必须有这条：`summary()` 夹具的 `results` 恒为空数组，前面所有用例
     * 都只验了渠道级文案，**从未验证过逐账号明细真的写进文档**。
     * 如果这一步断了，用户要等到第二天自动签到跑完才发现表格是空的。
     */
    const withRows = (providerRows, over = {}) => ({
      ok: true,
      value: {
        results: providerRows,
        summary: {
          claimed: providerRows.filter(r => r.outcome.kind === 'claimed').length,
          totalCredit: providerRows.reduce((n, r) => n + (r.outcome.kind === 'claimed' ? r.outcome.credit : 0), 0),
          alreadyClaimed: 0, inactive: 0, failed: 0,
          coversToday: providerRows.length,
          totalByUnit: { credit: providerRows.reduce((n, r) => n + (r.outcome.kind === 'claimed' ? r.outcome.credit : 0), 0), token: 0 },
          ...over,
        },
      },
    })
    const h = harness({
      providers: ['codearts', 'qoder'],
      responses: {
        codearts: [withRows([
          { accountId: 'acc-1', nickname: '主号', outcome: { kind: 'claimed', credit: 1000, streakDays: 3, isStreakDay: true } },
          { accountId: 'acc-2', nickname: '小号', outcome: { kind: 'already-claimed', message: '今天已经领过了' } },
        ])],
        qoder: [withRows([
          { accountId: 'q-1', nickname: 'q1', outcome: { kind: 'failed', code: 500, message: '未开启活动' } },
        ], { claimed: 0, failed: 0, coversToday: 1 })],
      },
      now: at0900,
    })
    await h.engine.runIfDue()

    const doc = h.store.peek()
    assert.equal(doc.results.length, 3, '三个账号的明细都必须落盘（含 already-claimed 与 failed）')
    const byAccount = new Map(doc.results.map(r => [r.accountId, r]))
    assert.equal(byAccount.get('acc-1').outcome, 'claimed')
    assert.equal(byAccount.get('acc-1').amount, 1000)
    assert.equal(byAccount.get('acc-1').accountName, '主号', '昵称要带上（表格「账号」列）')
    assert.equal(byAccount.get('acc-2').outcome, 'already-claimed')
    assert.equal(byAccount.get('acc-2').message, '今天已经领过了')
    assert.equal(byAccount.get('q-1').outcome, 'failed')
    assert.equal(byAccount.get('q-1').message, '未开启活动')

    // state() 是 RPC 的数据源，必须能读到同一份明细
    const state = h.engine.state()
    assert.equal(state.results.length, 3, 'state() 必须暴露 results（前端表格读它）')
    assert.ok(state.results.every(r => typeof r.provider === 'string' && r.provider.length > 0), '每行都要带 provider')

    // 跨日：昨天的明细不能在「今日领取」里出现
    h.clock.ms = at0900 + 24 * 60 * MIN
    assert.deepEqual(h.engine.state().results, [], '跨日后 results 必须为空（不该显示昨天的记录）')
  })

  console.log(`auto-checkin-ledger: ${checks} 组断言通过（失败渠道补跑 / 非今日轮次 / 刷新前 inactive 不烧额度 / 重跑上限 / 旧格式兼容 / 全失败不记日 / 跳过不重试 / 补跑排定 / 纯函数边界 / running 反馈 / 常量漂移 / 计数过滤 / 逐账号明细聚合 / 明细容错 / 明细端到端落盘）`)
} finally {
  hooks.deregister()
  fs.rmSync(scratch, { recursive: true, force: true })
}
