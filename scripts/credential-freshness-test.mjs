/**
 * 「用时续期」判据回归（2026-10-30，用户报「OfficeAce 老是凭证过期」）。
 *
 * 背景：OfficeAce 的 STS 寿命约 2 小时（AutoClaw 约 5.7 小时），而续期只有
 * 一个 30 分钟定时器（距过期不足 1 小时才续）。DSH 关闭/重启/休眠期间必然
 * 过期，过期时签到/余额/倍率全部 `APIG.0602`。修复是在**每次取凭据前**判一次
 * 临期就先续（`ensureCredentialFresh`，两条路径共用 in-flight 去重表）。
 *
 * 本用例只测**判据链**（不联网）：临期/已过期/无 expire_time 都要续；
 * 未临期与无 refresh_token 不续（避免烧掉一次性 token）。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const srcRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href

registerHooks({
  resolve(specifier, context, next) {
    if (String(context.parentURL).includes('/vendor/channel-pack/src/') && specifier.endsWith('.js') && !specifier.startsWith('@')) {
      const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
      if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(srcRoot) && url.endsWith('.ts') && existsSync(url)) {
      return {
        format: 'module',
        shortCircuit: true,
        source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        }).outputText,
      }
    }
    return next(url, context)
  },
})

export async function verifyCredentialFreshness() {
  const { shouldRefreshNow } = await import('../vendor/channel-pack/src/expiry-sync.ts')
  const now = Date.now()

  // 与 index.ts 的 ensureCredentialFresh 同一条判据链（保持逐字一致）
  const decide = (credential) => {
    if (typeof credential.refresh_token !== 'string' || credential.refresh_token === '') return 'skip-no-token'
    const expiresAt = typeof credential.expire_time === 'number' ? credential.expire_time : undefined
    if (expiresAt !== undefined && !shouldRefreshNow(expiresAt)) return 'skip-fresh'
    return 'refresh'
  }

  assert.equal(decide({ refresh_token: 'r', expire_time: now + 30 * 60_000 }), 'refresh', '临期（30 分钟内到期）必须续')
  assert.equal(decide({ refresh_token: 'r', expire_time: now - 10 * 60_000 }), 'refresh', '已过期必须续')
  assert.equal(decide({ refresh_token: 'r', expire_time: now + 3 * 3_600_000 }), 'skip-fresh', '未临期不得续（省一次性 token）')
  assert.equal(decide({ refresh_token: 'r' }), 'refresh', '没有 expire_time 按「可能已过期」处理，照常续')
  assert.equal(decide({ expire_time: now - 1_000 }), 'skip-no-token', '没有 refresh_token 无法续，直接放行')

  console.log('ok  credential-freshness: 用时续期判据（临期/过期/缺字段续，未临期与无 token 不续）')

  await verifyPersistContract()
}

/**
 * 「续期成功必须落盘」的顺序契约回归（2026-10-30 事故）。
 *
 * ## 事故形态
 * `ensureCredentialFresh` 原本内联在 `src/index.ts`，里面写着
 * `pool.listAccounts(providerId).find(...)` —— 而 `AccountPool.listAccounts` 是
 * **async**，返回 Promise，`.find` 当场抛 `TypeError`。由于那句在
 * 「续期成功之后、写盘之前」，每次用时续期都是：
 *   上游消费掉一次性 refresh_token → 本地写盘前炸掉 → 旧 token 原样留在磁盘
 * 续期链因此被打死（用户：「你把 officeace 的续期彻底玩坏了」），而异常还被
 * 外层 catch 吞成一条 warn，日志里完全看不出「token 已经烧了」。
 *
 * ## 本用例守什么
 * 1. **续期成功 ⇒ 必定落盘**，哪怕账号池查询/记账抛错；
 * 2. 账号池查询用**同步**方法（给一个 async 的 `listAccounts` 替身，一旦被
 *    误用就会抛 TypeError，本用例立刻变红）；
 * 3. 记账（`updateAccount`）失败**不回滚**已落盘的凭据、也不把异常抛给调用方；
 * 4. 续期失败 ⇒ 不落盘、返回旧凭据（让上游错误按既有归因呈现）。
 */
async function verifyPersistContract() {
  const { ensureCredentialFresh } = await import('../vendor/channel-pack/src/expiry-sync.ts')

  /** 账号池替身：`listAccounts` 刻意做成 async（误用即 TypeError）。 */
  const makePool = (options = {}) => {
    const calls = { updates: [] }
    const pool = {
      // ⚠ 就是这一句：真实的 AccountPool 里它是 async。任何 `.find` / `for...of`
      // 都会抛 TypeError，从而复现事故。
      async listAccounts() { return [{ id: 'officeace-1', credentialRef: 'OFFICEACE_ACCOUNT_1' }] },
      listAccountsByProvider() { return [{ id: 'officeace-1', credentialRef: 'OFFICEACE_ACCOUNT_1', expiresAt: 1 }] },
      async updateAccount(id, patch) {
        if (options.updateThrows === true) throw new Error('池写盘失败（模拟）')
        calls.updates.push({ id, patch })
      },
    }
    return { pool, calls }
  }

  const expired = { refresh_token: 'rt-old', expire_time: Date.now() - 60_000 }
  const refreshed = { refresh_token: 'rt-new', expire_time: Date.now() + 2 * 3_600_000 }

  // ── ① 正常路径：续期 → 落盘（写到条目自己的 ref，不是默认 ref）──
  {
    const { pool, calls } = makePool()
    const saved = []
    const next = await ensureCredentialFresh({
      providerId: 'officeace',
      defaultCredentialRef: 'OFFICEACE_CREDENTIAL',
      credential: expired,
      accountId: 'officeace-1',
      refreshOne: async () => refreshed,
      save: async (ref, value) => { saved.push({ ref, value }) },
      pool,
      log: {},
      tag: 'officeace',
    })
    assert.deepEqual(saved.map((row) => row.ref), ['OFFICEACE_ACCOUNT_1'], '必须落到账号条目自己的 ref（多账号各写各的）')
    assert.equal(saved[0].value.refresh_token, 'rt-new', '落盘的必须是轮换后的新 token')
    assert.equal(next.refresh_token, 'rt-new')
    assert.deepEqual(calls.updates.map((row) => row.patch.expiresAt), [refreshed.expire_time], '到期时间要回写账号池')
    console.log('ok  credential-freshness: 续期成功 → 落盘到条目 ref + 回写 expiresAt')
  }

  // ── ② 事故复现位：记账失败绝不能挡住落盘 ──
  {
    const { pool } = makePool({ updateThrows: true })
    const saved = []
    const warns = []
    const next = await ensureCredentialFresh({
      providerId: 'officeace',
      defaultCredentialRef: 'OFFICEACE_CREDENTIAL',
      credential: expired,
      accountId: 'officeace-1',
      refreshOne: async () => refreshed,
      save: async (ref, value) => { saved.push({ ref, value }) },
      pool,
      log: { warn: (m) => warns.push(m), error: (m) => warns.push(m) },
      tag: 'officeace',
    })
    assert.equal(saved.length, 1, '记账失败时**仍然必须落盘**（否则一次性 refresh_token 白烧）')
    assert.equal(saved[0].value.refresh_token, 'rt-new')
    assert.equal(next.refresh_token, 'rt-new', '落盘成功应返回新凭据')
    assert.ok(warns.some((m) => m.includes('回写账号池有效期失败')), '记账失败要告警')
    console.log('ok  credential-freshness: 记账失败不影响落盘（事故复现位）')
  }

  // ── ③ 落盘失败：按 error 级别报出来，并仍返回新凭据（内存这份可用）──
  {
    const { pool } = makePool()
    const errors = []
    const next = await ensureCredentialFresh({
      providerId: 'officeace',
      defaultCredentialRef: 'OFFICEACE_CREDENTIAL',
      credential: expired,
      accountId: 'officeace-1',
      refreshOne: async () => refreshed,
      save: async () => { throw new Error('凭据存储写盘失败（模拟）') },
      pool,
      log: { error: (m) => errors.push(m), warn: (m) => errors.push(m) },
      tag: 'officeace',
    })
    assert.equal(next.refresh_token, 'rt-new', '落盘失败也要返回新凭据（本次请求可用）')
    assert.ok(
      errors.some((m) => m.includes('落盘失败') && m.includes('需重新登录')),
      '落盘失败必须用 error 级别讲清「旧 refresh_token 已被消费」',
    )
    console.log('ok  credential-freshness: 落盘失败按 error 上报（提示需重新登录）')
  }

  // ── ④ 续期失败：不落盘、返回旧凭据（不阻断，让上游错误照常归因）──
  {
    const { pool } = makePool()
    const saved = []
    const warns = []
    const next = await ensureCredentialFresh({
      providerId: 'officeace',
      defaultCredentialRef: 'OFFICEACE_CREDENTIAL',
      credential: expired,
      accountId: 'officeace-1',
      refreshOne: async () => { throw new Error('STS5.1806 token has been used') },
      save: async (ref, value) => { saved.push({ ref, value }) },
      pool,
      log: { warn: (m) => warns.push(m), error: (m) => warns.push(m) },
      tag: 'officeace',
    })
    assert.equal(saved.length, 0, '续期失败不得落盘（否则把旧凭据覆盖成垃圾）')
    assert.equal(next.refresh_token, 'rt-old', '续期失败应原样返回旧凭据')
    assert.ok(warns.some((m) => m.includes('STS5.1806')), '续期失败要如实带上上游原因')
    console.log('ok  credential-freshness: 续期失败不落盘、原样返回旧凭据')
  }

  // ── ⑤ 未临期 / 无 refresh_token：一次网络都不发 ──
  {
    const { pool } = makePool()
    let called = 0
    const base = { providerId: 'officeace', defaultCredentialRef: 'X', accountId: 'officeace-1', save: async () => {}, pool, log: {}, tag: 'officeace' }
    await ensureCredentialFresh({ ...base, credential: { refresh_token: 'r', expire_time: Date.now() + 5 * 3_600_000 }, refreshOne: async () => { called += 1 } })
    await ensureCredentialFresh({ ...base, credential: { expire_time: Date.now() - 1_000 }, refreshOne: async () => { called += 1 } })
    assert.equal(called, 0, '未临期与无 refresh_token 都不得发续期请求（省一次性 token）')
    console.log('ok  credential-freshness: 未临期 / 无 token 不发请求')
  }

  // ── ⑥ 静态守卫：index.ts 里不得再出现「async listAccounts 当同步用」──
  {
    const raw = readFileSync(new URL('../vendor/channel-pack/src/index.ts', import.meta.url), 'utf8')
    // ⚠ 必须先剥掉注释再判断：本仓库的注释里**大量引用**了这些错误写法
    // （例如解释本次事故时逐字写了 `pool.listAccounts(...).find(...)`），
    // 不剥注释会让守卫被自己的说明文字打红 —— 那是假阳性，不是缺陷。
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))  // 行注释
      .join('\n')
    assert.doesNotMatch(
      code,
      /pool\.listAccounts\([^)]*\)\s*\.\s*(find|filter|map|some|forEach|reduce)\b/,
      'pool.listAccounts 是 async，禁止在其返回值上直接链式调用数组方法（2026-10-30 事故根因）',
    )
    assert.doesNotMatch(
      code,
      /for\s*\(\s*const\s+\w+\s+of\s+pool\.listAccounts\(/,
      'pool.listAccounts 是 async，禁止 for...of 直接迭代（2026-10-30 事故根因）',
    )
    // 反向验证：守卫必须真的能抓住事故写法（否则它是死的）。
    assert.match(
      'const x = pool.listAccounts(p).find((r) => r.id === id)',
      /pool\.listAccounts\([^)]*\)\s*\.\s*(find|filter|map|some|forEach|reduce)\b/,
      '守卫自身的正则必须能命中事故写法',
    )
    console.log('ok  credential-freshness: 静态守卫——没有把 async listAccounts 当同步用（已剥离注释）')
  }
}

import { exitIfDirectRun } from './lib/direct-run.mjs'
exitIfDirectRun(import.meta.url, 'credential-freshness-test')
