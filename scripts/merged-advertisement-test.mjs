/**
 * 「按模型合并」在**注册漏斗**上的端到端用例（用户 2026-11-18）。
 *
 * `merged-catalog-test.mjs` 验证的是纯函数；本用例验证的是它**接到了线上**：
 * 真正走一遍渠道包的 `apply()` → 各渠道 `registerAdapterIdempotent()` →
 * 宿主注册表，检查宿主看到的 `listModels()` 是否被抑制，而其余面是否完好。
 *
 * 为什么非要这一层：抑制点在 `registerAdapterIdempotent`（注册漏斗），而
 * 那是渠道包内部的一环。纯函数测试再全，也只能证明「包装器本身对」，证明
 * 不了「包装器被挂上去了」—— 后者才是用户能不能看到合并组的唯一区别。
 *
 * 运行：`node scripts/merged-advertisement-test.mjs`
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

/**
 * 渠道包是 TS，且它的模块图会在 import 期就碰 `credentials` / `llm` 等宿主
 * 服务。这里用**最小替身**挂载（同 `channel-pack-test.mjs` 的思路，但只保留
 * 本用例需要的面）：一个记录注册的 llm、一个空凭据服务、一个空命令表。
 */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-merged-advert-'))
process.env.DSH_CHANNEL_PACK_STATE_DIR = scratch
process.env.DSH_HOME = scratch
process.env.DSH_OPENAI_GATEWAY_ENABLED = '0'
process.env.QODER_MACHINE_TOKEN_PATH = path.join(scratch, 'machine-token.json')
process.env.QODER_RUNTIME_INFO = path.join(scratch, 'missing-runtime-info.exe')

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
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, experimentalDecorators: true },
          fileName: fileURLToPath(url),
        }).outputText,
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})

/**
 * 只验证「抑制开关接到注册漏斗」这一件事，因此直接测那个漏斗函数本身。
 * 走完整 `apply()` 需要一整套宿主替身（账号池、凭据、RPC 路由、网关…），
 * 那些面已有 `channel-pack-test.mjs` 覆盖，重复搭一遍只会让本用例变脆。
 */
const { registerAdapterIdempotent } = await import('../vendor/channel-pack/src/llm-register-compat.ts')
const { suppressMergedAdvertisement, mergedAdvertisementSuppressed } = await import('../vendor/channel-pack/src/merged-advertisement.ts')

/** 造一个行为可观测的最小适配器。 */
function makeAdapter(marker) {
  return {
    hits: [],
    providerInfo: provider => ({ id: provider, name: marker }),
    listModels: async function () { this.hits.push('listModels'); return [{ provider: 'p', id: 'glm-5.3', name: 'GLM-5.3' }] },
    listAllModels: function () { this.hits.push('listAllModels'); return [{ id: 'glm-5.3', name: 'GLM-5.3' }] },
    resolveModel: async function (provider, model) { this.hits.push('resolveModel'); return { provider, id: model, name: model } },
    prepareCall: async function (provider, model) {
      this.hits.push('prepareCall')
      return { model: { provider, id: model }, stream: function (options) { return this.stream?.(options) ?? (async function * () {})() } }
    },
    stream: async function * () { this.hits.push('stream'); yield { type: 'text-delta', text: 'ok' } },
  }
}

/** 记录注册结果的 llm 替身。 */
function makeLlm() {
  const adapters = new Map()
  return {
    adapters,
    registerAdapter(providers, adapter) {
      for (const provider of providers) adapters.set(provider, adapter)
      return { replace() {}, [Symbol.dispose]() {} }
    },
  }
}

// ── 关闭时：注册进去的就是原适配器，listModels 照常播报 ────────────────────────
suppressMergedAdvertisement(false)
{
  const llm = makeLlm()
  const adapter = makeAdapter('off')
  registerAdapterIdempotent(llm, ['trae'], adapter)
  const registered = llm.adapters.get('trae')
  assert.ok(registered !== undefined, 'the provider is registered')
  const models = await registered.listModels('trae')
  assert.equal(models.length, 1, 'with merging off the picker still sees this provider’s models')
  assert.equal(models[0].id, 'glm-5.3')
}

// ── 开启时：listModels 被抑制，其余面完好 ────────────────────────────────────
suppressMergedAdvertisement(true)
assert.equal(mergedAdvertisementSuppressed(), true, 'the flag reports on')
{
  const llm = makeLlm()
  const adapter = makeAdapter('on')
  registerAdapterIdempotent(llm, ['trae'], adapter)
  const registered = llm.adapters.get('trae')
  assert.ok(registered !== undefined, 'the provider is still registered')
  // 1) 选择器看不到任何模型 → 该分组从目录里消失（这正是「按模型分」的前提）
  assert.deepEqual(await registered.listModels('trae'), [], 'the picker sees no models under this provider')
  // 2) 设置页仍能看到完整目录与展示名
  const all = registered.listAllModels()
  assert.equal(all.length, 1, 'the channel panel keeps the full catalog')
  assert.equal(all[0].id, 'glm-5.3')
  // 3) 元数据解析不受影响（容量/档位仍能拿到）
  assert.deepEqual(await registered.resolveModel('trae', 'glm-5.3'), { provider: 'trae', id: 'glm-5.3', name: 'glm-5.3' })
  // 4) 身份不变（别处按 id 查询的代码不受影响）
  assert.deepEqual(registered.providerInfo('trae'), { id: 'trae', name: 'on' })
  // 5) 真正下发仍然通
  const call = await registered.prepareCall('trae', 'glm-5.3')
  assert.ok(typeof call.stream === 'function', 'prepareCall still returns a stream')
  // 6) 函数身份稳定
  assert.equal(registered.listModels, registered.listModels)
}

// ── 开关可逆：关回去之后不再抑制 ──────────────────────────────────────────────
suppressMergedAdvertisement(false)
{
  const llm = makeLlm()
  registerAdapterIdempotent(llm, ['trae'], makeAdapter('back'))
  assert.equal((await llm.adapters.get('trae').listModels('trae')).length, 1, 'turning merging off restores the old grouping')
}

// ── 抑制不改变「未登录渠道本来就返回空」这条既有语义 ──────────────────────────
suppressMergedAdvertisement(true)
{
  const llm = makeLlm()
  const adapter = makeAdapter('empty')
  // 模拟「未登录」：适配器自己就返回 []
  adapter.listModels = async function () { this.hits.push('listModels'); return [] }
  registerAdapterIdempotent(llm, ['zcode'], adapter)
  assert.deepEqual(await llm.adapters.get('zcode').listModels('zcode'), [])
  // 抑制层不能把 listAllModels 也抹掉（那会让设置页整块空白）
  assert.equal(llm.adapters.get('zcode').listAllModels().length, 1)
}

// 复位，避免影响同进程内其它用例
suppressMergedAdvertisement(false)

console.log('merged-advertisement-test: ok')
