/**
 * 两条「凭据续期」修复的回归（移植 magpie 的两处实现）。
 *
 * ## ① workbuddy 的**提前续期**（ahead）
 *
 * Magpie 的 workbuddy 插件（`opencode-workbuddy-auth/index.mjs:317` 的 `ahead`、
 * `:337` 的 `aheadHeld`）在 access token 只剩 10 天时就主动续期，理由是
 * **access 活 28 天、refresh 只活 30 天**：只按「过期前 1 小时」续，续期点落在
 * 第 27 天 23 时，refresh_token 会在那 2 天的窗口里先死，整号报废。
 * 失败按 1 分钟起翻倍、封顶 30 分钟重试，且**不动登录态**。
 *
 * 本套件锁定：
 * - 判据（10 天窗口 + 寿命 ≥ 20 天）对 28/30 天这对参数命中，对 2 小时的短寿命
 *   凭据**不**命中（否则短寿命凭据会被无限续）；
 * - 「1 小时 lead」原判据**逐字未变**（`REFRESH_LEAD_MS` 仍是 1 小时，
 *   `computeFirstRefreshDelayMs` 的延迟区间仍是 now+1h 附近）；
 * - 武装延迟排在「剩 10 天」那一刻（只剩 9 天时是 0＝立刻续，只剩 25 天时是 15 天后），
 *   短寿命凭据仍按 1 小时 lead；
 * - 失败退避 1→2→4…封顶 30 分钟，成功后清账。
 *
 * ## ② minimax「已花掉的 refresh_token → 续期结果」的进程内缓存
 *
 * Magpie 的 minimax 插件（`opencode-minimax-auth/index.mjs:27` 的
 * `KEEP_RENEWED_MS = 30d`、`:954` 的 `latest()`、`:965` 的 `forgetOld()`）记着这条
 * 死路：**续期成功但写盘失败** → 磁盘上留着已作废的旧 refresh_token → 下一轮再拿
 * 它去换 → `invalid_grant` → 账号被当终态登出。MiniMax 的 refresh_token 用一次即废，
 * 所以「它换出的结果」必须在进程内留着，且 `invalid_grant` 只有在**确实没有缓存命中**
 * 时才允许当终态。
 *
 * 本套件用真实的 `MinimaxAuth` + 假上游 + 会抛错的凭据存储复现整条路径：
 * 第一次续期成功但落盘失败 → **第二次续期一个请求都不发**、只用缓存结果重试落盘；
 * 缓存被清空（≈ 进程重启）后才允许 `invalid_grant` 收成终态。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    if (context.parentURL?.startsWith(sourceRoot) && specifier.endsWith('.js')) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href
      if (url.startsWith(sourceRoot) && fs.existsSync(fileURLToPath(url))) return { url, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(fs.readFileSync(fileURLToPath(url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: fileURLToPath(url),
      }).outputText,
    }
    return next(url, context)
  },
})

const DAY = 86_400_000
const MINUTE = 60_000

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}
const checkAsync = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

// ────────────────────────────── ① 提前续期 ──────────────────────────────

const {
  AheadRetryGate,
  REFRESH_AHEAD_MS,
  REFRESH_AHEAD_MIN_LIFE_MS,
  REFRESH_AHEAD_RETRY_MAX_MS,
  REFRESH_LEAD_MS,
  RefreshScheduler,
  aheadRetryDelayMs,
  computeAheadRefreshDelayMs,
  computeFirstRefreshDelayMs,
  isAheadRefreshDue,
} = await import('../vendor/channel-pack/src/refresh.ts')
const buddy = await import('../vendor/channel-pack/src/buddy.ts')

/** 造一枚带 iat/exp 的假 JWT（CodeBuddy 的 access_token 就是 RS256 JWT）。 */
const jwt = (issuedAtMs, lifeMs) => {
  const payload = Buffer.from(JSON.stringify({
    iat: Math.floor(issuedAtMs / 1000),
    exp: Math.floor((issuedAtMs + lifeMs) / 1000),
  })).toString('base64url')
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.c2ln`
}
const longLivedCredential = (nowMs, lifeMs, leftMs) => ({
  access_token: jwt(nowMs + leftMs - lifeMs, lifeMs),
  refresh_token: 'refresh-token',
  expires_at: String(nowMs + leftMs),
})

check('① 判据常量照 magpie：10 天窗口 / 20 天寿命门槛 / 1 小时 lead 未变', () => {
  assert.equal(REFRESH_AHEAD_MS, 10 * DAY, 'AHEAD_MS 必须是 10 天')
  assert.equal(REFRESH_AHEAD_MIN_LIFE_MS, 20 * DAY, 'LONG_MS 必须是 2× AHEAD')
  assert.equal(REFRESH_LEAD_MS, 3_600_000, '原有 1 小时 lead 一个数都不能动')
  // 源码级钉子：免得日后有人「顺手统一」成 1 天（magpie 的宿主就把 lead 钳到 1 天）
  const source = fs.readFileSync(new URL('../vendor/channel-pack/src/refresh.ts', import.meta.url), 'utf8')
  assert.match(source, /export const REFRESH_LEAD_MS = 3_600_000/)
  assert.match(source, /export const REFRESH_AHEAD_MS = 10 \* 86_400_000/)
})

check('② 28 天寿命 + 剩 9 天 ⇒ 命中提前续期；剩 11 天 ⇒ 还没到', () => {
  const now = Date.now()
  assert.equal(isAheadRefreshDue({ expiresAtMs: now + 9 * DAY, lifeMs: 28 * DAY, nowMs: now }), true)
  assert.equal(isAheadRefreshDue({ expiresAtMs: now + 11 * DAY, lifeMs: 28 * DAY, nowMs: now }), false)
  assert.equal(isAheadRefreshDue({ expiresAtMs: now + 10 * DAY, lifeMs: 28 * DAY, nowMs: now }), true, '窗口边界含 10 天')
})

check('③ 短寿命凭据（2 小时）不进提前续期 —— 1 小时 lead 语义原样保留', () => {
  const now = Date.now()
  assert.equal(isAheadRefreshDue({ expiresAtMs: now + 90 * MINUTE, lifeMs: 2 * 3_600_000, nowMs: now }), false)
  // 读不到寿命（不是 JWT / 没有 iat）同样退回 1 小时 lead
  assert.equal(isAheadRefreshDue({ expiresAtMs: now + 9 * DAY, lifeMs: undefined, nowMs: now }), false)
  assert.equal(computeAheadRefreshDelayMs(now + 9 * DAY, undefined, now), undefined)
})

check('④ 已过期 / refresh_token 已过期 都不走提前续期', () => {
  const now = Date.now()
  assert.equal(isAheadRefreshDue({ expiresAtMs: now - 1, lifeMs: 28 * DAY, nowMs: now }), false, '已过期走常规立即续')
  assert.equal(isAheadRefreshDue({
    expiresAtMs: now + 9 * DAY, lifeMs: 28 * DAY, refreshExpiresAtMs: now - 1, nowMs: now,
  }), false, 'refresh_token 已死，提前续期也换不出东西')
  assert.equal(isAheadRefreshDue({
    expiresAtMs: now + 9 * DAY, lifeMs: 28 * DAY, refreshExpiresAtMs: now + DAY, nowMs: now,
  }), true)
})

check('⑤ 窗口开启时刻：剩 27 天 ⇒ 17 天后触发；已进窗口 ⇒ 0', () => {
  const now = Date.now()
  const delay = computeAheadRefreshDelayMs(now + 27 * DAY, 28 * DAY, now)
  assert.ok(Math.abs(delay - 17 * DAY) <= 1000, `应为 17 天，实际 ${delay}ms`)
  assert.equal(computeAheadRefreshDelayMs(now + 9 * DAY, 28 * DAY, now), 0)
})

check('⑥ 原有 1 小时 lead 的延迟区间不变（now+1h 附近，随机秒 0-59）', () => {
  const now = Date.now()
  const delay = computeFirstRefreshDelayMs(now + 4 * DAY, now)
  // 落在 now+1h 附近，再叠加 0-59 秒随机偏移（`setSeconds` 会改秒位）
  assert.ok(delay >= 3_541_000 && delay <= 3_659_000, `1 小时 lead 的随机区间变了：${delay}ms`)
  assert.equal(computeFirstRefreshDelayMs(now + 30 * MINUTE, now), 0, '临期（≤1h）仍立即续')
  assert.equal(computeFirstRefreshDelayMs(Number.NaN, now), 0, '读不到过期时间仍立即续')
})

check('⑦ 退避：1 分钟起、翻倍、封顶 30 分钟', () => {
  assert.equal(aheadRetryDelayMs(1), MINUTE)
  assert.equal(aheadRetryDelayMs(2), 2 * MINUTE)
  assert.equal(aheadRetryDelayMs(3), 4 * MINUTE)
  assert.equal(aheadRetryDelayMs(6), REFRESH_AHEAD_RETRY_MAX_MS, '第 6 次就该顶到 30 分钟')
  assert.equal(aheadRetryDelayMs(100), REFRESH_AHEAD_RETRY_MAX_MS, '再多次也不超过 30 分钟')
})

check('⑧ 退避表：失败记窗口、成功清账、按 token 隔离', () => {
  const gate = new AheadRetryGate()
  const now = Date.now()
  const first = gate.fail('t1', now)
  assert.equal(first, MINUTE)
  assert.equal(gate.waiting('t1', now), true)
  assert.equal(gate.waiting('t2', now), false, '另一枚 token 不受影响')
  assert.equal(gate.waiting('t1', now + MINUTE), false, '过了退避窗口就该重试')
  const second = gate.fail('t1', now)
  assert.equal(second, 2 * MINUTE, '连续失败翻倍')
  gate.clear('t1')
  assert.equal(gate.waiting('t1', now), false, '成功即清账')
  assert.equal(gate.size, 0)
})

check('⑨ buddy：寿命由 JWT 的 iat/exp 得出；武装延迟排在「剩 10 天」那一刻', () => {
  const now = Date.now()
  // 28 天寿命、只剩 9 天 ⇒ 立刻续（提前续期窗口内）
  const due = longLivedCredential(now, 28 * DAY, 9 * DAY)
  assert.equal(buddy.credentialLifeMs(due), 28 * DAY)
  assert.equal(buddy.buddyAheadRefreshDue(due, now), true)
  assert.equal(buddy.buddyRefreshArmDelayMs(due, now), 0)
  // 28 天寿命、还剩 25 天 ⇒ 排在「剩 10 天」那一刻（15 天后），
  // ⚠️ 绝不能退回 1 小时 lead —— 那是第 28 天，比提前窗口晚得多。
  const early = longLivedCredential(now, 28 * DAY, 25 * DAY)
  const delay = buddy.buddyRefreshArmDelayMs(early, now)
  assert.ok(Math.abs(delay - 15 * DAY) <= 1000, `应为 15 天后（剩 10 天时），实际 ${delay}ms`)
  assert.ok(delay > DAY, '长寿命凭据不得按 1 小时 lead 排')
  assert.equal(buddy.buddyAheadRefreshDue(early, now), false)
  // 2 小时寿命 ⇒ 不提前续期，武装延迟还是 1 小时 lead
  const short = longLivedCredential(now, 2 * 3_600_000, 90 * MINUTE)
  assert.equal(buddy.buddyAheadRefreshDue(short, now), false)
  // 不是 JWT（解不出寿命）⇒ 退回原有行为
  assert.equal(buddy.credentialLifeMs({ access_token: 'opaque', refresh_token: 'r' }), undefined)
  assert.equal(buddy.buddyAheadRefreshDue({
    access_token: 'opaque', refresh_token: 'r', expires_at: String(now + 9 * DAY),
  }, now), false)
})

await checkAsync('⑩ 调度器：armAfter(0) 立刻触发；arm(now+2h) 仍按 1 小时 lead 不立刻触发', async () => {
  const calls = []
  const scheduler = new RefreshScheduler(async () => { calls.push(Date.now()) })
  scheduler.armAfter(0)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(calls.length, 1, 'armAfter(0) 必须立刻跑一次')

  const later = []
  const second = new RefreshScheduler(async () => { later.push(Date.now()) })
  second.arm(Date.now() + 2 * 3_600_000)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(later.length, 0, '未临期不得提前续期')
  second.stop()
  scheduler.stop()
})

await checkAsync('⑪ 调度器：失败仍按既有逃逸路径重试（onError 被调一次）', async () => {
  const errors = []
  const scheduler = new RefreshScheduler(async () => { throw new Error('network down') }, (error) => errors.push(error))
  scheduler.armAfter(0)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(errors.length, 1, '非终态失败必须交给 onError（登录态由调用方决定）')
  scheduler.stop()
})

// ─────────────────────── ② minimax 已花掉 token 的结果缓存 ───────────────────────

const {
  MINIMAX_RENEWED,
  MINIMAX_RENEWED_KEEP_MS,
  MinimaxRenewedCache,
} = await import('../vendor/channel-pack/src/minimax.ts')
const { MinimaxAuth } = await import('../vendor/channel-pack/src/minimax-auth.ts')

check('⑫ 保留期照 magpie KEEP_RENEWED_MS = 30 天', () => {
  assert.equal(MINIMAX_RENEWED_KEEP_MS, 30 * 24 * 3_600_000)
})

const credentialOf = (access, refresh, extra = {}) => ({
  access_token: access, refresh_token: refresh, token_type: 'Bearer', scope: 'agent.default', ...extra,
})

await checkAsync('⑬ 缓存：花掉的 token 能跟到最新结果（含链式多跳）', async () => {
  const cache = new MinimaxRenewedCache()
  const c0 = credentialOf('a0', 'r0')
  await cache.renew(c0, async () => credentialOf('a1', 'r1'))
  assert.equal(cache.latest(c0).access_token, 'a1')
  await cache.renew(credentialOf('a1', 'r1'), async () => credentialOf('a2', 'r2'))
  assert.equal(cache.latest(c0).access_token, 'a2', '磁盘上是最初那枚，也必须跟到最新')
  assert.equal(cache.spent(c0), true)
  assert.equal(cache.spent(credentialOf('a3', 'r3')), false)
})

await checkAsync('⑭ 缓存：同一枚 token 的并发续期只发一次请求', async () => {
  const cache = new MinimaxRenewedCache()
  let calls = 0
  const run = async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return credentialOf('a1', 'r1') }
  const [x, y] = await Promise.all([cache.renew(credentialOf('a0', 'r0'), run), cache.renew(credentialOf('a0', 'r0'), run)])
  assert.equal(calls, 1, '同一枚 token 必须合并成一次')
  assert.equal(x.access_token, 'a1')
  assert.equal(y.access_token, 'a1')
})

await checkAsync('⑮ 缓存：超过 30 天不再作答（fail-safe 回落到真续期）', async () => {
  let now = 1_000_000
  const cache = new MinimaxRenewedCache(MINIMAX_RENEWED_KEEP_MS, () => now)
  const c0 = credentialOf('a0', 'r0')
  await cache.renew(c0, async () => credentialOf('a1', 'r1'))
  assert.equal(cache.latest(c0).access_token, 'a1')
  now += 30 * 24 * 3_600_000
  assert.equal(cache.latest(c0).access_token, 'a0', '过期条目不得再冒充结果')
  assert.equal(cache.spent(c0), false)
})

/** 最小 credis 替身：一个可注入「写盘失败」的凭据存储。 */
function makeHost(state) {
  return {
    ctx: {
      provide() {},
      logger: {
        warn: (message) => state.warns.push(String(message)),
        error: (message) => state.errors.push(String(message)),
        info: (message) => state.infos.push(String(message)),
      },
      credentials: {
        async resolve(ref) {
          return state.store.has(ref) ? { value: state.store.get(ref), source: 'test' } : undefined
        },
        async set(ref, value) {
          state.saves += 1
          if (state.failSave) {
            state.failSave = false
            throw new Error('EBUSY: credentials file is locked')
          }
          state.store.set(ref, value)
        },
        async unset(ref) { state.store.delete(ref) },
      },
    },
  }
}

function makeUpstream(state) {
  return async (url, init) => {
    const body = String(init?.body ?? '')
    state.requests.push(body)
    const spent = new URLSearchParams(body).get('refresh_token')
    if (state.rejectRefreshTokens.has(spent)) {
      return Response.json({ error: 'invalid_grant' }, { status: 400 })
    }
    state.seq += 1
    return Response.json({
      access_token: `mmoat_${state.seq}`,
      refresh_token: `r${state.seq}`,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'agent.default',
    })
  }
}

const newState = () => ({
  store: new Map(), saves: 0, failSave: false, seq: 0,
  requests: [], warns: [], errors: [], infos: [], rejectRefreshTokens: new Set(),
})

const REF = 'MINIMAX_ACCOUNT_A'

await checkAsync('⑯ 写盘失败后的下一次续期：一个请求都不发，只重试落盘（关键回归）', async () => {
  MINIMAX_RENEWED.clear()
  const state = newState()
  state.store.set(REF, JSON.stringify(credentialOf('mmoat_old', 'r0', {
    expires_at: String(Date.now() - 1000),
    nickname: '展示名',
  })))
  const { ctx } = makeHost(state)
  const auth = new MinimaxAuth(ctx, { fetchImpl: makeUpstream(state), serviceName: 'minimaxAuthTest' })

  state.failSave = true
  await assert.rejects(() => auth.refreshAccountCredential(REF), /EBUSY/)
  assert.equal(state.requests.length, 1, '第一次续期该发一个请求')
  assert.match(state.requests[0], /refresh_token=r0/)

  // 磁盘上仍是 r0（写盘失败的后果）——第二次续期必须**命中缓存**
  await auth.refreshAccountCredential(REF)
  assert.equal(state.requests.length, 1, '写盘失败后绝不能再把旧 refresh_token 发出去')
  const saved = JSON.parse(state.store.get(REF))
  assert.equal(saved.refresh_token, 'r1')
  assert.equal(saved.access_token, 'mmoat_1')
  assert.equal(saved.nickname, '展示名', '续期响应不带 nickname，必须合并保留')
})

await checkAsync('⑰ 缓存没了（≈ 进程重启）才允许 invalid_grant 收成终态', async () => {
  const state = newState()
  state.store.set(REF, JSON.stringify(credentialOf('mmoat_old', 'r0', { expires_at: String(Date.now() - 1000) })))
  const { ctx } = makeHost(state)
  const auth = new MinimaxAuth(ctx, { fetchImpl: makeUpstream(state), serviceName: 'minimaxAuthTest2' })
  MINIMAX_RENEWED.clear()
  state.rejectRefreshTokens.add('r0')

  await assert.rejects(
    () => auth.refreshAccountCredential(REF),
    (error) => {
      assert.equal(error.name, 'RefreshTokenExpiredError', '无缓存命中才判终态')
      return true
    },
  )
  assert.equal(state.requests.length, 1)
})

await checkAsync('⑱ invalid_grant 但别处已续过（磁盘换了 token 且本进程有结果）⇒ 采纳，不判终态', async () => {
  MINIMAX_RENEWED.clear()
  const state = newState()
  const elsewhere = credentialOf('mmoat_elsewhere', 'token-elsewhere')
  state.rejectRefreshTokens.add('spent-by-other')
  // 另一条路径（本进程）已经把 token-elsewhere 换成了 token-newest
  await MINIMAX_RENEWED.renew(elsewhere, async () => credentialOf('mmoat_newest', 'token-newest', {
    expires_at: String(Date.now() + 3_600_000),
  }))
  const { ctx } = makeHost(state)
  const auth = new MinimaxAuth(ctx, { fetchImpl: makeUpstream(state), serviceName: 'minimaxAuthTest3' })

  const got = await auth.refreshCredentialFor(
    credentialOf('mmoat_stale', 'spent-by-other'),
    { reread: async () => elsewhere },
  )
  assert.equal(got.access_token, 'mmoat_newest')
})

await checkAsync('⑲ refreshAll 落盘失败不得把账号钉成 refreshable:false（自愈路径不许被封死）', async () => {
  MINIMAX_RENEWED.clear()
  const state = newState()
  const ref = 'MINIMAX_ACCOUNT_B'
  state.store.set(ref, JSON.stringify(credentialOf('mmoat_b0', 'rb0', { expires_at: String(Date.now() - 1000) })))
  state.failSave = true
  const { ctx } = makeHost(state)
  const auth = new MinimaxAuth(ctx, { fetchImpl: makeUpstream(state), serviceName: 'minimaxAuthTest4' })
  const patches = []
  const pool = {
    async listAccounts() { return [{ id: 'B', credentialRef: ref, refreshable: true, enabled: true, createdAt: 1 }] },
    async updateAccount(id, patch) { patches.push([id, patch]) },
    async findAccountIdByCredential() { return 'B' },
  }

  await auth.refreshAll(pool)
  assert.equal(state.requests.length, 1)
  assert.deepEqual(patches, [], '落盘失败后账号仍可续期，不能被写死')
  assert.ok(state.errors.some((message) => message.includes('落盘失败')), '必须留 error 级日志')
  assert.ok(
    state.errors.some((message) => message.includes('内存中的续期结果')),
    '日志要说清下一轮靠内存结果重试落盘',
  )
})

await checkAsync('⑳ 批量续期在 lead 判据未到之前就把缓存结果补落盘（零请求）', async () => {
  MINIMAX_RENEWED.clear()
  const state = newState()
  const ref = 'MINIMAX_ACCOUNT_C'
  // 磁盘凭据 access token 还有 4 小时 ⇒ 远没到 1 小时 lead 窗口
  state.store.set(ref, JSON.stringify(credentialOf('mmoat_c0', 'rc0', { expires_at: String(Date.now() + 4 * 3_600_000) })))
  const { ctx } = makeHost(state)
  const auth = new MinimaxAuth(ctx, { fetchImpl: makeUpstream(state), serviceName: 'minimaxAuthTest5' })

  // 模拟「401 / RPC 触发的那次续期」：续期成功但写盘失败
  state.failSave = true
  await assert.rejects(() => auth.refreshAccountCredential(ref), /EBUSY/)
  assert.equal(state.requests.length, 1)

  // 下一轮批量续期：lead 判据还没到，但缓存里有结果 ⇒ 零请求补落盘
  const pool = {
    async listAccounts() { return [{ id: 'C', credentialRef: ref, refreshable: true, enabled: true, createdAt: 1 }] },
    async updateAccount() {},
    async findAccountIdByCredential() { return 'C' },
  }
  await auth.refreshAll(pool)
  assert.equal(state.requests.length, 1, '补落盘不得再发续期请求')
  const repaired = JSON.parse(state.store.get(ref))
  assert.equal(repaired.refresh_token, 'r1', '缓存结果必须被写回磁盘')
  assert.equal(repaired.access_token, 'mmoat_1')
  assert.ok(state.infos.some((message) => message.includes('补落盘')), '补落盘要留日志')
})

check('㉑ 顺序契约：refreshCredentialFor 先认缓存、再发请求（静态钉子）', () => {
  const source = fs.readFileSync(new URL('../vendor/channel-pack/src/minimax-auth.ts', import.meta.url), 'utf8')
  const cacheAt = source.indexOf('MINIMAX_RENEWED.latest(credential)')
  const networkAt = source.indexOf('MINIMAX_RENEWED.renew(credential')
  assert.ok(cacheAt > 0 && networkAt > 0, '两处都必须存在')
  assert.ok(cacheAt < networkAt, '缓存必须在发请求之前')
  assert.match(
    source,
    /const afterCache = MINIMAX_RENEWED\.latest\(credential\)[\s\S]{0,600}?MinimaxRefreshTokenExpiredError\('refresh_token 已失效/,
    '终态只在缓存与磁盘都拿不到新结果时才抛',
  )
})

if (failures > 0) console.error(`refresh-ahead-minimax-cache-test: ${failures} failure(s)`)
else console.log('refresh-ahead-minimax-cache-test: ahead renews early, a spent token is never sent twice')
process.exitCode = failures > 0 ? 1 : 0