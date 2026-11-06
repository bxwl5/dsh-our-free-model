/**
 * 纵切差分守卫（2026-11-06 团队定稿 §4-4 / §6 阶段 1+）。
 *
 * 对已迁移的 (provider, method) 组合：直接调注册表的 ChannelAccount 方法，
 * 断言其返回信封与「原 switch 分支逐字构造的期望值」deepEqual。
 * 相等才说明 early-return 换路径没有改变线上行为。
 *
 * 不依赖 RPC mount（那些由 channel-pack-test.mjs 的 verifyChannelCreditsRpc 覆盖），
 * 本套件只锁「注册表实现本身的行为等价」，可在 test-all 里独立直跑。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const root = new URL('../', import.meta.url)
const sourceRoot = pathToFileURL(path.join(fileURLToPath(root), 'vendor/channel-pack/src/')).href
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const llmKernel = kernel  // @deepseek-ai/dsh-llm 在注册表模块里不被 import，此处与 kernel 同源兜底

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-llm') return { url: llmKernel, shortCircuit: true }
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
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

const { buildChannelAccountRegistry } = await import(
  pathToFileURL(path.join(fileURLToPath(root), 'vendor/channel-pack/src/channel-accounts/index.ts')).href
)
const { toStatusEnvelope, nullStatusAccounts } = await import(
  pathToFileURL(path.join(fileURLToPath(root), 'vendor/channel-pack/src/channel-account.ts')).href
)
const { verifyExtraSlice } = await import(
  new URL('./lib/channel-account-slice-extra.mjs', import.meta.url).href
)

// 装配期 io 离线桩：三个工厂构造期只读 qoderFamily / loomy / raccoon / zcode /
// buildZcodeBalance / pool，运行期真正发请求的路径由下面 env.fetcher 抛错哨兵拦住。
const noopFetch = async () => { throw new Error('守卫：不应发网络请求') }
const offlineIo = {
  pool: {
    traeCheckinDeviceGenerationFor: () => 0,
    updateTraeCheckinDeviceGeneration: async () => {},
  },
  loomy: { fetchCreditBalance: noopFetch },
  raccoon: { fetchCreditBalance: noopFetch },
  zcode: { fetchBalanceFor: noopFetch },
  qoderFamily: [
    { product: { id: 'qoder' }, auth: {} },
    { product: { id: 'qodercn' }, auth: {} },
  ],
  buildZcodeBalance: (r) => ({ total: 0, packages: [] }),
}
const registry = buildChannelAccountRegistry(offlineIo)

const fakeAccounts = [
  { id: 'acct-a', nickname: '账号一', credentialRef: 'REF_A' },
  { id: 'acct-b', nickname: '账号二', credentialRef: 'REF_B' },
]
const env = {
  provider: 'unused',
  accounts: fakeAccounts,
  resolve: async () => undefined,
  warn: () => {},
  fetcher: async () => { throw new Error('阶段 1 常量分支不得发网络请求') },
}

const checks = []
const check = async (name, run) => {
  await run()
  checks.push(name)
}

// ── status × codearts / trae / cline：原分支 ok:true + 逐账号 status:null ──
for (const provider of ['codearts', 'trae', 'cline']) {
  await check(`status/${provider}`, async () => {
    const account = registry.get(provider)
    assert.ok(account?.status, `${provider} 必须已迁移 status`)
    const outcome = await account.status({ ...env, provider })
    assert.equal(outcome.kind, 'no-status-capability')
    assert.deepEqual(toStatusEnvelope(outcome), {
      ok: true,
      value: {
        accounts: fakeAccounts.map((a) => ({ accountId: a.id, nickname: a.nickname, status: null })),
      },
    })
  })
}

// ── claim × cline / workbuddy / raccoon：原分支 bad-request，文案逐字 ──
const claimMessages = {
  cline: 'Cline 不支持每日签到（其后端没有签到接口）',
  workbuddy: 'WorkBuddy 国际版不支持每日签到（其后端没有签到接口）',
  raccoon: 'Raccoon Work 不支持每日签到（积分由服务端自动发放，奖励见「新手任务」）',
}
for (const [provider, message] of Object.entries(claimMessages)) {
  await check(`claim/${provider}`, async () => {
    const account = registry.get(provider)
    assert.ok(account?.claim, `${provider} 必须已迁移 claim`)
    assert.deepEqual(await account.claim({ ...env, provider }), {
      ok: false,
      error: { code: 'bad-request', message },
    })
  })
}

// ── 阶段 2/3/4 全组合差分守卫（55 项，含 workbuddy/zcode 合并真值表）──
const extra = await verifyExtraSlice({ registry, env, nullStatusAccounts, toStatusEnvelope })

hooks.deregister()
console.log(`ok  channel-account-slice: R0 ${checks.length} 组 + 扩展 ${extra.count} 组差分守卫通过；zcode.claim 仍缺席（阶段 4 不迁）`)
