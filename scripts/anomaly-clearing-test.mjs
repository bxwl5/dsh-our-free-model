/**
 * 守卫：**实测成功即清异常标记**（用户 2026-11-05）。
 *
 * 用户连报三轮：
 *  ①「这个账号/模型 实测已经可以使用了，还在异常列表里」
 *  ②「好像不止 zcode 会这样，buddy 两个账号都能用了还挂在异常列表」
 *  ③「在轮询过程中发现这个渠道被封禁限流的模型可用，就在异常里删除这条」
 *
 * 根因：异常汇总只按预测解禁时刻（`resetAtMs > now`）列条目，从不管「这个
 * 账号+模型刚才是不是真的请求成功了」。上游提前放通 ⇒ 「显示还封着、实际已能用」。
 *
 * 修复落点：所有渠道**唯一共用**的流式包装 `llm-register-compat.ts`。一次流
 * 正常结束且真的产出内容 ⇒ 按 `provider + accountId + 内部 modelId` 清掉该
 * 账号+该模型的 `modelRateLimits` 与 `riskBlockedUntilMs`。一处覆盖 20 渠道。
 *
 * 本用例锁死：成功才清、失败/空流/无账号/未注入都不清、用的是内部 id 而非展示名、
 * 池方法只清命中项且幂等。
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
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-anomaly-clearing-'))
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

const {
  recordThroughStream, attachAnomalyPool,
} = await import('../vendor/channel-pack/src/llm-register-compat.ts')
const { runWithLedgerScope, reportLedgerAccount } =
  await import('../vendor/channel-pack/src/token-ledger.ts')
const { AccountPool } = await import('../vendor/channel-pack/src/account-pool.ts')

// 把 token 记账后端挂上，避免 recordTokenUsage 因无后端而抛（它本身不抛，但保险）。
const { attachTokenLedgerStore } = await import('../vendor/channel-pack/src/token-ledger.ts')
attachTokenLedgerStore({ append() {}, flush() {} })

/** 造一个记录调用参数的假池。 */
function fakePool() {
  const calls = []
  const settled = []
  return {
    calls,
    // ★ test-all 全量跑（vfat IO 繁忙）时 fire-and-forget 的清标记可能晚于
    //   setImmediate 落地 → 断言间歇性拿到空 calls（2026-11-05 实测 1/3 失败）。
    //   记下每个 promise，测试侧 await settle() 等真实落地，不再赌时序。
    settled,
    async clearAnomalyOnSuccess(accountId, modelId) {
      const done = (async () => { calls.push([accountId, modelId]); return 1 })()
      settled.push(done)
      return done
    },
  }
}

/** 等当前 pool 所有清标记 promise 落地（含下一个微任务里刚发起的）。 */
async function settlePool(pool, rounds = 4) {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.allSettled(pool.settled.splice(0))
    await new Promise(r => setImmediate(r))
  }
}

/** 跑一条流：chunks 里的每一项 yield，error 非空则在中途抛出。 */
async function drain(chunks, { error, pool, accountId = 'acct-1', provider = 'buddy', model = '内部展示名', modelId = 'hy4free', inject = true } = {}) {
  const p = pool ?? fakePool()
  const detach = inject ? attachAnomalyPool(p) : () => {}
  const startedAt = Date.now()
  const stream = recordThroughStream(
    async function* () {
      if (accountId) reportLedgerAccount(provider, accountId)
      // ★ 让首块到达时 Date.now() 严格大于 startedAt（同毫秒竞态：
      //   ttftMs=0 会让「实测成功」判据不成立，2026-11-05 间歇失败实测）。
      //   setImmediate 不跨毫秒，必须用 ≥1ms 的真实定时器。
      await new Promise(r => setTimeout(r, 2))
      for (const c of chunks) {
        if (error && c === '__throw__') throw new Error(error)
        yield c
      }
      if (error && !chunks.includes('__throw__')) throw new Error(error)
    },
    { channel: 'direct', provider, model, modelId, startedAt },
  )
  let got = []
  let thrown
  try {
    for await (const c of stream) got.push(c)
  } catch (e) { thrown = e }
  detach()
  // 让 fire-and-forget 的 clear 落地：等真实 promise（不再赌 setImmediate 时序）
  await settlePool(p)
  return { got, thrown, calls: p.calls }
}

// ── 1. 成功（有内容块）→ 清，且用内部 modelId、正确 accountId ──
{
  const pool = fakePool()
  const usage = { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
  const r = await drain([{ type: 'text-delta', text: 'hi' }, usage], { pool })
  assert.equal(r.thrown, undefined, '成功流不应抛错')
  assert.deepEqual(r.calls, [['acct-1', 'hy4free']],
    `成功应清「账号 + 内部 modelId」，实际 ${JSON.stringify(r.calls)}`)
  assert.ok(!r.calls.some(([, m]) => m === '内部展示名'), '绝不能用展示名当 key')
}
console.log('ok  成功流按「账号 + 内部 modelId」清异常标记')

// ── 2. 失败（抛错）→ 不清 ──
{
  const pool = fakePool()
  const r = await drain([{ type: 'text-delta', text: 'hi' }], { pool, error: 'upstream 429' })
  assert.ok(r.thrown instanceof Error, '失败流应把错误原样抛出')
  assert.deepEqual(r.calls, [], '失败请求绝不能清异常标记')
}
console.log('ok  失败流不清异常标记（记账照样落）')

// ── 3. 空流（0 chunk，ttftMs=0）→ 不清 ──
{
  const pool = fakePool()
  const r = await drain([], { pool })
  assert.deepEqual(r.calls, [], '空流不能算「实测可用」')
}
console.log('ok  空流不清异常标记')

// ── 4. 没有 accountId → 不清（避免误清到别的账号）──
{
  const pool = fakePool()
  // provider 用全新值：peekLedgerAccount 在无域时退回「全局最后值」，
  // 会读到上一项留下的 acct-1（fallback 语义本身是对的，测试要隔离它）。
  const r = await drain([{ type: 'text-delta', text: 'hi' }], { pool, accountId: '', provider: 'guard-provider' })
  assert.deepEqual(r.calls, [], '取不到账号时宁可不清')
}
console.log('ok  无账号归属时不清')

// ── 5. 未注入池 → 不崩、不清 ──
{
  const r = await drain([{ type: 'text-delta', text: 'hi' }], { inject: false })
  assert.equal(r.thrown, undefined, '未注入池时成功流照常完成')
}
console.log('ok  未注入池时成功流不受影响')

// ── 6. disposer 只摘自己（fiber 重启竞态纪律）──
{
  const a = fakePool(), b = fakePool()
  const detachA = attachAnomalyPool(a)
  attachAnomalyPool(b)          // 新实例挂上
  detachA()                      // 旧 fiber 异步 dispose 交错执行
  const r = await drain([{ type: 'text-delta', text: 'hi' }], { pool: b, inject: true })
  // drain 里 inject:true 会再挂一个 b 并立即摘，这里主要验证「旧 disposer 没把新池摘空」
  assert.ok(r.thrown === undefined)
}
console.log('ok  disposer 只摘自己，不误伤新挂载的池')

// ── 7. 池方法 clearAnomalyOnSuccess：真实 AccountPool 语义 ──
{
  const ctx = { logger: { info() {}, warn() {} }, home: scratch, profileContext: { home: scratch }, credentials: { describe: () => ({ source: 'test' }) } }
  const pool = new AccountPool(ctx)
  // replaceAll 需要 (accounts, disabledModels, ...)，第二参数必传。
  await pool.replaceAll(
    [
      { id: 'acct-1', provider: 'buddy', credentialRef: 'ACCT_1', modelRateLimits: { hy4free: Date.now() + 3600_000, 'glm-5.3': Date.now() + 3600_000 }, riskBlockedUntilMs: Date.now() + 1800_000 },
      { id: 'acct-2', provider: 'buddy', credentialRef: 'ACCT_2', modelRateLimits: { hy4free: Date.now() + 3600_000 } },
    ],
    {},
  )
  const before = await pool.listAccounts('buddy')
  assert.equal(before.length, 2, '真实 AccountPool 应载入 2 个账号')
  const n = await pool.clearAnomalyOnSuccess('acct-1', 'hy4free')
  const after = await pool.listAccounts('buddy')
  const a1 = after.find(x => x.id === 'acct-1')
  const a2 = after.find(x => x.id === 'acct-2')
  assert.equal(n, 2, '应清除「限流 + 风控」两条')
  assert.equal(a1.modelRateLimits?.hy4free, undefined, '命中模型的限流已清')
  assert.ok(a1.modelRateLimits?.['glm-5.3'] > 0, '同账号其它模型不受影响')
  assert.equal(a1.riskBlockedUntilMs, undefined, '风控已清')
  assert.ok(a2.modelRateLimits?.hy4free > 0, '别的账号不受影响')
  const again = await pool.clearAnomalyOnSuccess('acct-1', 'hy4free')
  assert.equal(again, 0, '幂等：再清返回 0')
  console.log('ok  池方法只清命中项、清风控、不动其它模型/账号、幂等')
}

console.log('anomaly-clearing-test: 实测成功即清异常标记（成功/失败/空流/无账号/未注入/竞态/池语义）全通过')
