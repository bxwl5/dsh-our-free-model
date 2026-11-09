/**
 * 渠道目录行的持久化（2026-11-09 用户报障：重启后路由里模型上下文掉回兜底值）。
 *
 * ## 报障现象与推断
 *
 * 「全新安装显示 131K；点刷新模型列表无效；『重新获取模型』短暂修复、重启
 * 复现；过一会儿又自己恢复。」`自己恢复` 是关键：定时轮询（默认 15 分钟）跑完
 * 一轮完整扫描后就好了 —— 说明真值一直在，只是**冷启动那条路径没读到**。
 *
 * 根因有两层，都在本插件而不是渠道包：
 *  ① `channelCatalog` 只是进程内变量，`catalog.json` 从没存过渠道行；
 *  ② `combos.list`（路由页）走 light 模式，只复用进程内 `previousRows`，
 *     冷启动它为空或是占位符 ⇒ 路由页最后一个恢复。
 *
 * 本套件锁住修复后的契约：冷启动先上屏磁盘真值、完整扫描写盘、残缺扫描
 * 不洗白缓存、light 只读不写。用真实的 runtime + 真实 catalog.json 文件，
 * 不靠桩推理这条接线。离线可跑。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { createRuntimeStores, createModelRuntime } = await import('../src/core/runtime.js')
const { FALLBACK_CONTEXT_WINDOW } = await import('../src/channel-catalog.js')

const DISGUISE = FALLBACK_CONTEXT_WINDOW
assert.equal(DISGUISE, 512_000, '伪装值应为 512K（500 进制渲染口径，用户 2026-11-09 决定）')

let checks = 0
const check = (label, actual, expected) => {
  assert.deepEqual(actual, expected, label)
  checks++
  console.log(`ok   ${label}`)
}

const seed = () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-channel-cache-'))
  const stores = createRuntimeStores({ dataDir, logger: { warn() {} } })
  stores.settings.update({ enabled: true, combos: [] })
  return { dataDir, stores }
}

/** 一个只回答固定的 provider/模型清单的宿主 llm 桩。 */
const hostWith = ({ providers, models, resolve }) => ({
  listProviders: () => providers.map(id => ({ id })),
  listModels: async provider => (models[provider] ?? []).map(id => ({ id, name: id })),
  resolveModelInfo: async (provider, model) => {
    const hit = resolve?.[`${provider}/${model}`]
    if (hit === undefined) throw new Error(`no resolve for ${provider}/${model}`)
    return hit
  },
})

const channelRow = (provider, model) => `channel:${provider}/${model}`

// ── ① 冷启动：磁盘上有真值 ⇒ 目录行一开始就是真值 ────────────────────────
{
  const { dataDir, stores } = seed()
  // 模拟「上一次成功扫描写下的真值」。
  stores.catalogStore.update({
    channelRows: [
      { id: channelRow('zcode', 'GLM-5.3'), name: 'GLM-5.3', channel: 'channel:zcode', provider: 'zcode', providerModel: 'GLM-5.3', contextWindow: 1_000_000, maxOutput: 128_000, vision: false, reasoning: true },
      { id: channelRow('qoder', 'auto'), name: 'Auto', channel: 'channel:qoder', provider: 'qoder', providerModel: 'auto', contextWindow: 200_000, maxOutput: 8_192, vision: true, reasoning: true },
    ],
  })
  stores.catalogStore.flush()

  // 新运行时 == 一次重启；此时还没扫过任何渠道。
  const runtime = createModelRuntime({ ...stores, logger: { warn() {} }, llm: undefined, packProviders: new Set() })
  const rows = runtime.state().catalog.filter(entry => entry.channel?.startsWith('channel:'))
  check('a restart surfaces the persisted capacity before any scan runs',
    rows.map(row => [row.id, row.contextWindow]), [
      [channelRow('zcode', 'GLM-5.3'), 1_000_000],
      [channelRow('qoder', 'auto'), 200_000],
    ])
  runtime.dispose?.()
  fs.rmSync(dataDir, { recursive: true, force: true })
}

// ── ② 完整扫描：把真值写盘，重启后仍在 ──────────────────────────────────
{
  const { dataDir, stores } = seed()
  const llm = hostWith({
    providers: ['zcode'],
    models: { zcode: ['GLM-5.3'] },
    resolve: { 'zcode/GLM-5.3': { context: { contextWindow: 1_000_000 }, defaultMaxTokens: 128_000 } },
  })
  const runtime = createModelRuntime({ ...stores, logger: { warn() {} }, llm, packProviders: new Set(['zcode']) })
  await runtime.refreshChannelCatalog()

  const row = runtime.state().catalog.find(entry => entry.id === channelRow('zcode', 'GLM-5.3'))
  check('a full scan resolves the real capacity', row?.contextWindow, 1_000_000)
  check('…and persists it to catalog.json',
    JSON.parse(fs.readFileSync(path.join(dataDir, 'catalog.json'), 'utf8')).channelRows
      .map(saved => [saved.id, saved.contextWindow]),
    [[channelRow('zcode', 'GLM-5.3'), 1_000_000]])
  runtime.dispose?.()
  fs.rmSync(dataDir, { recursive: true, force: true })
}

// ── ③ 残缺扫描（预算掐断 / 包未挂载）不得洗掉磁盘真值 ────────────────────
{
  const { dataDir, stores } = seed()
  stores.catalogStore.update({
    channelRows: [
      { id: channelRow('zcode', 'GLM-5.3'), name: 'GLM-5.3', channel: 'channel:zcode', provider: 'zcode', providerModel: 'GLM-5.3', contextWindow: 1_000_000, maxOutput: 128_000 },
      { id: channelRow('qoder', 'auto'), name: 'Auto', channel: 'channel:qoder', provider: 'qoder', providerModel: 'auto', contextWindow: 200_000, maxOutput: 8_192 },
    ],
  })
  stores.catalogStore.flush()

  // 这一轮只扫到 zcode，且容量被预算耗尽 ⇒ 落伪装值。
  const llm = hostWith({
    providers: ['zcode'],
    models: { zcode: ['GLM-5.3'] },
    resolve: { 'zcode/GLM-5.3': { context: { contextWindow: DISGUISE } } },
  })
  const runtime = createModelRuntime({ ...stores, logger: { warn() {} }, llm, packProviders: new Set(['zcode']) })
  await runtime.refreshChannelCatalog()

  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'catalog.json'), 'utf8')).channelRows
  const byId = new Map(persisted.map(row => [row.id, row.contextWindow]))
  check('a budget-truncated scan keeps the true value it could not recompute',
    byId.get(channelRow('zcode', 'GLM-5.3')), 1_000_000)
  check('…and never wipes the provider it did not ask this round',
    byId.get(channelRow('qoder', 'auto')), 200_000)
  runtime.dispose?.()
  fs.rmSync(dataDir, { recursive: true, force: true })
}

// ── ④ light 模式：读磁盘真值，但自己绝不写盘 ────────────────────────────
{
  const { dataDir, stores } = seed()
  stores.catalogStore.update({
    channelRows: [
      { id: channelRow('zcode', 'GLM-5.3'), name: 'GLM-5.3', channel: 'channel:zcode', provider: 'zcode', providerModel: 'GLM-5.3', contextWindow: 1_000_000, maxOutput: 128_000 },
      { id: channelRow('qodercn', 'auto'), name: 'Auto', channel: 'channel:qodercn', provider: 'qodercn', providerModel: 'auto', contextWindow: 1_000_000, maxOutput: 8_192 },
    ],
  })
  stores.catalogStore.flush()

  // light 只问启用清单：zcode 在列，qodercn 此刻「没登录」没在列。
  const llm = hostWith({
    providers: ['zcode'],
    models: { zcode: ['GLM-5.3'] },
    resolve: {},
  })
  const runtime = createModelRuntime({ ...stores, logger: { warn() {} }, llm, packProviders: new Set(['zcode', 'qodercn']) })
  await runtime.refreshChannelCatalog({ light: true })

  const row = runtime.state().catalog.find(entry => entry.id === channelRow('zcode', 'GLM-5.3'))
  check('the routing editor reads the persisted capacity, not the disguise', row?.contextWindow, 1_000_000)

  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'catalog.json'), 'utf8')).channelRows
  check('a light read never shrinks the persisted cache',
    persisted.map(saved => saved.id).sort(), [channelRow('qodercn', 'auto'), channelRow('zcode', 'GLM-5.3')].sort())
  runtime.dispose?.()
  fs.rmSync(dataDir, { recursive: true, force: true })
}

console.log(`\nchannel-catalog-persistence: ${checks}/${checks} checks passed`)
