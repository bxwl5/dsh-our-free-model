/**
 * 模型目录三层回退（远端 → 落盘 → 兜底）回归。
 *
 * 用户 2026-10-26 要求：模型与倍率全部远端获取、覆盖兜底、落盘缓存
 * （凭据失效/删除凭证时显示上次列表）、定时刷新。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerHooks } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

// ⚠️ 不能用 `new URL('..').pathname`：路径含中文时它是 percent-encoded，
// createRequire 会拼出不存在的路径。用 fileURLToPath 解码。
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const require = createRequire(`${ROOT}/package.json`)
const ts = require('typescript')
const sourceRoot = pathToFileURL(`${ROOT}/vendor/channel-pack/src/`).href
registerHooks({
  resolve(s, c, n) {
    if (c.parentURL?.startsWith(sourceRoot) && s.endsWith('.js')) {
      const u = new URL(s.replace(/\.js$/, '.ts'), c.parentURL).href
      if (existsSync(fileURLToPath(u))) return { url: u, shortCircuit: true }
    }
    return n(s, c)
  },
  load(u, c, n) {
    if (u.startsWith(sourceRoot) && u.endsWith('.ts')) {
      return {
        format: 'module',
        source: ts.transpileModule(readFileSync(fileURLToPath(u), 'utf8'), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
          fileName: fileURLToPath(u),
        }).outputText,
        shortCircuit: true,
      }
    }
    return n(u, c)
  },
})

const dir = mkdtempSync(join(tmpdir(), 'ofm-catalog-'))
process.env.DSH_CHANNEL_PACK_STATE_DIR = dir

const store = await import(`${ROOT}/vendor/channel-pack/src/model-catalog-store.ts`)
const resolver = await import(`${ROOT}/vendor/channel-pack/src/catalog-resolver.ts`)
const refresher = await import(`${ROOT}/vendor/channel-pack/src/catalog-refresher.ts`)

const fallback = [
  { id: 'old', name: 'OldModel', priceFactor: 0.1, contextWindow: 1000 },
]

// ── 1. 从未拉到过 → 用兜底表（冷启动样本）──
resolver.resetCatalogResolverForTest()
store.resetModelCatalogStoreForTest()
let r = await resolver.resolveCatalog({ provider: 'p1', fetchRemote: async () => undefined, fallback })
assert.equal(r.source, 'fallback', '从未成功拉到过时用兜底表')
assert.equal(r.models.length, 1)

// ── 2. 拉到远端 → 覆盖（不与兜底并集）+ 落盘 ──
resolver.resetCatalogResolverForTest()
const remoteModels = [
  { id: 'new1', name: 'NewOne', priceFactor: 0.5 },
  { id: 'new2', name: 'NewTwo', priceFactor: 0 },
]
r = await resolver.resolveCatalog({ provider: 'p1', fetchRemote: async () => remoteModels, fallback })
assert.equal(r.source, 'remote')
assert.equal(r.models.length, 2, '⚠️ 覆盖语义：远端 2 个就是 2 个，不并兜底 1 个')
assert.equal(r.models.some(m => m.id === 'old'), false, '兜底表模型不得混入')
assert.ok(store.loadCatalog('p1') !== undefined, '拉取成功必须落盘')

// ── 3. 进程重启（清内存）→ 用落盘缓存，不是兜底表 ──
resolver.resetCatalogResolverForTest()
r = await resolver.resolveCatalog({ provider: 'p1', fetchRemote: async () => { throw new Error('凭据失效') }, fallback })
assert.equal(r.source, 'cache', '⚠️ 凭据失效时必须显示上次拉到的列表')
assert.equal(r.models.length, 2)
assert.equal(r.models[1].priceFactor, 0, '0 倍率（免费）必须原样保留')

// ── 4. 拉取失败不清空已有数据 ──
resolver.resetCatalogResolverForTest()
r = await resolver.resolveCatalog({ provider: 'p1', fetchRemote: async () => undefined, fallback, force: true })
assert.equal(r.models.length, 2, '失败时保留上次结果，不清空')

// ── 5. 落盘损坏 → 按空表处理（回落到兜底，不抛错）──
resolver.resetCatalogResolverForTest()
store.resetModelCatalogStoreForTest()
const { writeFileSync } = await import('node:fs')
writeFileSync(join(dir, 'channel-pack', 'model-catalog.json'), '{ 这不是 JSON', 'utf-8')
store.resetModelCatalogStoreForTest()
r = await resolver.resolveCatalog({ provider: 'p1', fetchRemote: async () => undefined, fallback })
assert.equal(r.source, 'fallback', '落盘损坏时回落兜底表而不是抛错')

// ── 6. 展示名：无倍率就不显示倍率 ──
assert.equal(resolver.catalogDisplayName({ id: 'a', name: 'A', priceFactor: 0.5 }), 'A · x0.5')
assert.equal(resolver.catalogDisplayName({ id: 'a', name: 'A', priceFactor: 0 }), 'A · 免费')
assert.equal(resolver.catalogDisplayName({ id: 'a', name: 'A' }), 'A', '⚠️ 无倍率必须只显示名字，不编造 x1')
assert.equal(
  resolver.catalogDisplayName({ id: 'a', name: 'A', priceFactor: 0.2, originalPriceFactor: 1 }),
  'A · x1→x0.2', '有原价时显示箭头',
)

// ── 7. 定时刷新：串行、单渠道失败不影响其他 ──
const order = []
let stopped = false
const handle = refresher.startCatalogRefresher(
  () => [
    { provider: 'a', refresh: async () => { order.push('a'); return true } },
    { provider: 'b', refresh: async () => { order.push('b'); throw new Error('boom') } },
    { provider: 'c', refresh: async () => { order.push('c'); return true } },
  ],
  { intervalMs: 0, firstDelayMs: 0, logger: { warn() {}, info() {} } },
)
const ok = await handle.runOnce()
handle.stop()
assert.deepEqual(order, ['a', 'b', 'c'], '必须串行且全部执行（b 抛错不能中断）')
assert.equal(ok, 2, '只统计成功的渠道')

// ── 8. 定时刷新：失败的渠道不算成功 ──
const handle2 = refresher.startCatalogRefresher(
  () => [{ provider: 'x', refresh: async () => false }],
  { intervalMs: 0, firstDelayMs: 0 },
)
assert.equal(await handle2.runOnce(), 0, '返回 false 表示没拿到新目录')
handle2.stop()

rmSync(dir, { recursive: true, force: true })
console.log('model-catalog-store: 8 组断言通过（兜底冷启动 / 覆盖语义 / 落盘缓存 / 失败保留 / 损坏容错 / 展示名 / 串行刷新 / 成功计数）')
