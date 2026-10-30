/**
 * 远端模型目录**持久快照**回归（用户 2026-10-27 指定）。
 *
 * ## 需求原文
 *
 * > 远端拉取全量覆盖兜底表（不是增量，是直接写入到兜底表），全部渠道都这样。
 *
 * ## 本用例锁死的行为
 *
 * 1. **写入是整份覆盖，不是并集**：第二次写入后旧条目必须消失（上游下架的模型
 *    不能在快照里残留，否则重启后又会冒出来）；
 * 2. **按 provider 分文件**：一个渠道的快照损坏/缺失不影响另一个；
 * 3. **版本/归属不符按「没有快照」处理**：宁可回退兜底表，也不误读别人的目录；
 * 4. **文件损坏不抛错**：返回 undefined（调用方回退兜底表），绝不把半个解析结果
 *    交给渲染层；
 * 5. **通用校验**：非数组 / 空数组 / 条目缺 id / 重复 id 都要被挡掉或去重，
 *    因为这份数据会被适配器直接当远端目录用；
 * 6. **内存镜像**：写过的渠道即使文件被删也还能读（进程内不会因一次清理掉线）；
 * 7. `restoreModelCatalog()` **不覆盖**已有目录（只有为空时才读快照）。
 */
import assert from 'node:assert/strict'
import fs, { readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const ts = (await import('typescript')).default

// ⚠️ `resolveChannelPackHome` 的第一优先级就是 `DSH_CHANNEL_PACK_STATE_DIR` ——
// 靠它隔离，绝不能落到真实的 ~/.dsh（会污染用户正在用的目录）。
const home = fs.mkdtempSync(join(os.tmpdir(), 'ofm-catalog-'))
process.env.DSH_HOME = home
process.env.DSH_CHANNEL_PACK_STATE_DIR = home

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

{
  const mod = await import('../vendor/channel-pack/src/model-catalog-cache.ts')
  const { readModelCatalog, writeModelCatalog, restoreModelCatalog, resetModelCatalogCacheForTest, MODEL_CATALOG_DIR } = mod
  resetModelCatalogCacheForTest()

  const dir = join(home, 'channel-pack', MODEL_CATALOG_DIR)

  // ---- 1) 写入是整份覆盖（不是并集）----
  writeModelCatalog('buddy', [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }])
  assert.deepEqual(readModelCatalog('buddy')?.map((m) => m.id), ['a', 'b'], '首次写入应可读回')
  writeModelCatalog('buddy', [{ id: 'a', name: 'A2' }])
  assert.deepEqual(readModelCatalog('buddy'), [{ id: 'a', name: 'A2' }],
    '第二次写入必须是整份覆盖：已下架的 b 不能残留')

  // ---- 2) 按 provider 分文件，互不影响 ----
  writeModelCatalog('workbuddy', [{ id: 'x', name: 'X' }])
  assert.ok(existsSync(join(dir, 'buddy.json')) && existsSync(join(dir, 'workbuddy.json')),
    '两个渠道应各写一个文件')
  assert.deepEqual(readModelCatalog('workbuddy'), [{ id: 'x', name: 'X' }])

  // ---- 3) 版本不符：按没有快照处理 ----
  const buddyPath = join(dir, 'buddy.json')
  writeFileSync(buddyPath, JSON.stringify({ schema: 999, provider: 'buddy', models: [{ id: 'z' }] }))
  resetModelCatalogCacheForTest()
  assert.equal(readModelCatalog('buddy'), undefined, 'schema 不符必须当作没有快照')

  // ---- 3b) 归属不符：不能误读别的渠道的目录 ----
  writeFileSync(buddyPath, JSON.stringify({ schema: 1, provider: 'workbuddy', models: [{ id: 'z' }] }))
  resetModelCatalogCacheForTest()
  assert.equal(readModelCatalog('buddy'), undefined, 'provider 不符必须当作没有快照')

  // ---- 4) 文件损坏：不抛错，返回 undefined ----
  writeFileSync(buddyPath, '{ this is not json')
  resetModelCatalogCacheForTest()
  assert.equal(readModelCatalog('buddy'), undefined, '损坏的快照不能让调用方炸掉')

  // ---- 5) 通用校验 ----
  const cases = [
    ['空数组不落盘', []],
    ['非数组不落盘', 'nope'],
    ['条目缺 id 全被丢', [{ name: 'no id' }]],
  ]
  for (const [label, models] of cases) {
    rmSync(dir, { recursive: true, force: true })
    resetModelCatalogCacheForTest()
    writeModelCatalog('probe', models)
    assert.equal(existsSync(join(dir, 'probe.json')), false, `${label}：不应写出文件`)
  }
  // 部分合法 + 重复 id → 只保留合法且去重后的
  writeModelCatalog('probe', [
    { id: 'k', name: 'K' },
    { id: 'k', name: 'K-dup' },
    { name: 'no-id' },
    null,
    'string-entry',
    { id: '', name: 'empty-id' },
  ])
  resetModelCatalogCacheForTest()
  assert.deepEqual(readModelCatalog('probe'), [{ id: 'k', name: 'K' }],
    '重复 id 必须去重、非法条目必须丢弃')

  // ---- 6) 内存镜像：文件被删也能读 ----
  resetModelCatalogCacheForTest()
  assert.deepEqual(readModelCatalog('probe')?.map((m) => m.id), ['k'], '重置后应能从磁盘读回')
  rmSync(join(dir, 'probe.json'))
  assert.deepEqual(readModelCatalog('probe')?.map((m) => m.id), ['k'],
    '已读过的渠道应命中内存镜像，不因文件被删而消失')

  // ---- 7) restoreModelCatalog 不覆盖已有目录 ----
  const live = [{ id: 'fresh', name: 'Fresh' }]
  assert.equal(restoreModelCatalog('probe', live), live, '已有目录时必须原样返回，不能被快照顶替')
  resetModelCatalogCacheForTest()
  writeModelCatalog('snap', [{ id: 'saved', name: 'Saved' }])
  resetModelCatalogCacheForTest()
  assert.deepEqual(restoreModelCatalog('snap', undefined), [{ id: 'saved', name: 'Saved' }],
    '目录为空时必须用快照顶上')
  assert.equal(restoreModelCatalog('missing-provider', undefined), undefined,
    '没有快照时必须返回 undefined（调用方回退兜底表）')

  // ---- 8) 非法 provider 名不落盘（防路径穿越）----
  writeModelCatalog('../escape', [{ id: 'e' }])
  assert.equal(existsSync(join(home, 'channel-pack', 'escape.json')), false,
    '带路径片段的 provider 名必须被拒绝')

  // ---- 9) 落盘内容结构（schema / provider / savedAt 三项必须齐）----
  writeModelCatalog('shape', [{ id: 'one', name: 'One' }])
  const body = JSON.parse(readFileSync(join(dir, 'shape.json'), 'utf-8'))
  assert.equal(body.schema, 1)
  assert.equal(body.provider, 'shape')
  assert.equal(typeof body.savedAt, 'number')
  assert.deepEqual(body.models, [{ id: 'one', name: 'One' }])

  // ══ 10) 新增模型默认关闭（用户 2026-10-30 规则，全部渠道一致）═════════════
  //
  // 规则：远端目录整份覆盖不变，但**上一份没有的** id 自动写入黑名单；
  // 用户显式设置过的 id（黑名单里已有 true/false）不翻转；无旧基准（首次
  // 拉到）时不关任何东西。入口是 writeModelCatalogClosingNew（15 处写快照
  // 的收口），旧基准由 write/restore/read 三条路径自动维护。
  {
    rmSync(dir, { recursive: true, force: true })
    resetModelCatalogCacheForTest()
    /** 账号池替身：只实现新入口用到的两个方法。 */
    const makePool = () => {
      const calls = { closed: [] }
      return {
        calls,
        listDisabledModels(p) { return this._map[p] ?? {} },
        async setModelsDisabled(p, ids) { calls.closed.push({ p, ids: [...ids] }) },
        _map: {},
      }
    }

    // 10a) 无旧基准（首次拉到）：不关任何模型 —— 冷启动必须是全量可见。
    const poolA = makePool()
    await mod.writeModelCatalogClosingNew('alpha', [{ id: 'm1' }, { id: 'm2' }], poolA)
    assert.deepEqual(poolA.calls.closed, [], '首次拉到目录（无旧基准）不得关闭任何模型')
    assert.deepEqual(readModelCatalog('alpha')?.map((m) => m.id), ['m1', 'm2'], '快照照常写入')

    // 10b) 第二次拉取带新模型：新增的 m3 自动关闭，原有的不动。
    const poolB = makePool()
    await mod.writeModelCatalogClosingNew('alpha', [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }], poolB)
    assert.deepEqual(poolB.calls.closed, [{ p: 'alpha', ids: ['m3'] }],
      '新增模型必须被自动关闭，且只关新增的')

    // 10c) 用户显式设置过的 id 不翻转：m4 已被用户关着（true）、m5 被用户开着（false），
    //      刷新后两者都不得再动。
    const poolC = makePool()
    poolC._map['alpha'] = { m4: true, m5: false }
    await mod.writeModelCatalogClosingNew('alpha', [
      { id: 'm1' }, { id: 'm4' }, { id: 'm5' }, { id: 'm6' },
    ], poolC)
    assert.deepEqual(poolC.calls.closed, [{ p: 'alpha', ids: ['m6'] }],
      '用户显式关/开的模型不得被目录刷新翻转，只关无记录的新增')

    // 10d) 下架（旧条目消失）不产生任何关闭动作；同进程第二次刷新的基准是上一份。
    const poolD = makePool()
    await mod.writeModelCatalogClosingNew('alpha', [{ id: 'm1' }], poolD)
    assert.deepEqual(poolD.calls.closed, [], '只减不增的刷新不得触发关闭')
    await mod.writeModelCatalogClosingNew('alpha', [{ id: 'm1' }, { id: 'm7' }], poolD)
    assert.deepEqual(poolD.calls.closed, [{ p: 'alpha', ids: ['m7'] }],
      '第二次刷新的新增判据必须是第一次刷新后的目录')

    // 10e) 无账号池（替身/单测形态）：只写快照、不关模型、不抛错。
    await mod.writeModelCatalogClosingNew('beta', [{ id: 'b1' }], undefined)
    assert.deepEqual(readModelCatalog('beta')?.map((m) => m.id), ['b1'], '无池时快照仍要写')

    // 10f) 磁盘快照恢复（restoreModelCatalog）会预填旧基准：重启后第一次远端
    //      拉取只关真正的新增，而不是把整表当新增。
    rmSync(dir, { recursive: true, force: true })
    resetModelCatalogCacheForTest()
    mod.writeModelCatalog('gamma', [{ id: 'g1' }, { id: 'g2' }])
    resetModelCatalogCacheForTest() // 模拟进程重启（内存镜像清空）
    assert.deepEqual(mod.restoreModelCatalog('gamma', undefined), [{ id: 'g1' }, { id: 'g2' }],
      '重启后 restore 应从磁盘恢复')
    const poolF = makePool()
    await mod.writeModelCatalogClosingNew('gamma', [{ id: 'g1' }, { id: 'g2' }, { id: 'g3' }], poolF)
    assert.deepEqual(poolF.calls.closed, [{ p: 'gamma', ids: ['g3'] }],
      '重启后第一次刷新：恢复出的目录就是旧基准，只关真新增')

    console.log('ok  model-catalog-cache: 新增模型默认关闭（首拉不关/只关新增/用户选择不翻转/基准逐次更新/无池降级/重启后基准恢复）')
  }

  rmSync(home, { recursive: true, force: true })
  delete process.env.DSH_CHANNEL_PACK_STATE_DIR
  resetModelCatalogCacheForTest()
  hooks.deregister()
  console.log('ok  model-catalog-cache: 整份覆盖、按渠道隔离、版本/归属校验、损坏降级、去重、内存镜像、restore 不覆盖、路径穿越防护')
}
