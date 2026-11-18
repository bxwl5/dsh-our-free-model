/**
 * 方案 A 验证（用户 2026-11-18）：风控冷却期账号被 `getAvailableAccount`
 * 剔除；全部风控时回退；过期不剔除；round-robin 同样剔除。
 *
 * 用与 `account-rotation-test.mjs` 相同的手法：真实 AccountPool（TS 源经
 * registerHooks 转译）+ 伪造 store 后端，直测选号行为。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const ts = (await import('typescript')).default
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.endsWith('.js')) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href
      if (fs.existsSync(fileURLToPath(url))) return { url, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) {
      const source = fs.readFileSync(fileURLToPath(url), 'utf8')
      return {
        format: 'module',
        source: ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
          fileName: fileURLToPath(url),
        }).outputText,
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})

const { AccountPool } = await import('../vendor/channel-pack/src/account-pool.ts')

const entry = (id, extra = {}) => ({
  id, provider: 'zcode', nickname: id, enabled: true, credentialRef: `R_${id}`, createdAt: 1, ...extra,
})
const makePool = (accounts) => {
  const state = { accounts, disabledModels: {}, loomyPermanentLocked: false, gatewayEnabled: true, providerOrder: [] }
  const ctx = {
    logger: { warn() {}, info() {} },
    credentials: { resolve: async ref => ({ value: JSON.stringify({ kind: 'zcode', ref }) }) },
  }
  // 构造函数会 createChannelPackStore(ctx)——ctx 无后端时会落 memory 并种子默认账号，
  // 所以像 account-rotation-test.mjs:239-241 那样构造后用 defineProperty 覆盖 store。
  const pool = new AccountPool(ctx)
  Object.defineProperty(pool, 'store', {
    value: { kind: 'memory', mtimeMs: undefined, load: () => JSON.parse(JSON.stringify(state)), save: async () => {} },
    writable: true, configurable: true,
  })
  Object.defineProperty(pool, 'loaded', { value: false, writable: true, configurable: true })
  return pool
}
const pick = async accounts => (await makePool(accounts).getAvailableAccount('zcode', 'GLM-5.3', undefined))?.entry?.id

// ① 一个风控 + 一个干净 → 只选干净的（这就是方案 A 的主体行为）
assert.equal(await pick([
  entry('a1', { riskBlockedUntilMs: Date.now() + 30 * 60 * 1000 }),
  entry('a2'),
]), 'a2', '冷却期账号被剔除')

// ② 全部在冷却 → 回退到原顺序第一个（不让估计值把 provider 整条掐死）
assert.equal(await pick([
  entry('a1', { riskBlockedUntilMs: Date.now() + 30 * 60 * 1000 }),
  entry('a2', { riskBlockedUntilMs: Date.now() + 31 * 60 * 1000 }),
]), 'a1', '全部冷却时回退')

// ③ 风控时刻已过期 → 不剔除（到点就该复活）
assert.equal(await pick([
  entry('a1', { riskBlockedUntilMs: Date.now() - 1 }),
  entry('a2'),
]), 'a1', '过期风控不剔除')

// ④ round-robin 也剔除（铁律的例外：3012 有升级惩罚，与限流不同）
const rrPool = makePool([
  entry('a1', { riskBlockedUntilMs: Date.now() + 30 * 60 * 1000 }),
  entry('a2'),
])
rrPool.accountStrategyValue = () => 'round-robin'
assert.equal((await rrPool.getAvailableAccount('zcode', 'GLM-5.3', undefined))?.entry?.id, 'a2',
  'round-robin 同样剔除风控账号')

// ⑤ 非法 riskBlockedUntilMs（NaN）当「无标记」处理，不误剔除
assert.equal(await pick([
  entry('a1', { riskBlockedUntilMs: Number.NaN }),
  entry('a2'),
]), 'a1', 'NaN 标记不剔除')

console.log('risk-block-test: ok')
