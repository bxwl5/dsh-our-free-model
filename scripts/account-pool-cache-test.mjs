/**
 * 账号池「外部改动感知」回归（真实报障）。
 *
 * ## 背景
 *
 * `AccountPool.ensureLoaded()` 早期是 `if (this.loaded) return` —— 加载一次后
 * **永不重读文件**。而写入路径 `queueStoreSave()` 写的是 `this.cache`（内存快照），
 * 于是任何「手工改状态文件」的补救（清限流标记、补账号）都会：
 *   1. 立刻读不到（路由读内存）；
 *   2. 在下一次写操作（签到/刷新积分/改开关）时被内存快照**整体覆盖回去**。
 *
 * 用户只剩「重启进程」一条路 —— 长任务场景下等于不可用。
 *
 * ## 本用例锁死的行为
 *
 * - 文件 mtime 未变 → 零重读（连续多次访问只 load 一次）；
 * - 文件 mtime 变化（外部改）→ 重读并反映新内容；
 * - **自己写盘后不重读**（写后 mtime 已同步，避免自触发）；
 * - 非文件后端（无 mtimeMs）→ 沿用「只加载一次」。
 */
import assert from 'node:assert/strict'
import { exitIfDirectRun } from './lib/direct-run.mjs'

/** 可控 mtime 的假 store。 */
function makeStore(initial) {
  const state = { accounts: initial, disabledModels: {}, loomyPermanentLocked: false, gatewayEnabled: true, providerOrder: [] }
  const store = {
    kind: 'file',
    loads: 0,
    stamp: 1000,
    mtimeMs() { return this.stamp },
    load() { this.loads += 1; return JSON.parse(JSON.stringify(state)) },
    async save(next) {
      Object.assign(state, JSON.parse(JSON.stringify(next)))
      this.stamp += 1
    },
  }
  return { store, state }
}

export async function verifyAccountPoolCache() {
  const { AccountPool } = await import('../vendor/channel-pack/src/account-pool.ts')
  const { store, state } = makeStore([
    { id: 'a1', provider: 'buddy', nickname: 'one', enabled: true, credentialRef: 'A1', createdAt: 1 },
  ])

  const ctx = {
    store,
    logger: { warn() {}, info() {} },
    credentials: { resolve: async () => undefined, describe: async () => undefined, set: async () => {}, unset: async () => {} },
    permanentLocks: undefined,
  }
  // 用 createChannelPackStore 之外的路径：直接替换到池实例上（构造函数会自己建 store）
  const pool = new AccountPool(ctx)
  // 绕开真实 store 工厂：把私有字段指向我们的假 store（仅测试用）
  Object.defineProperty(pool, 'store', { value: store, writable: true, configurable: true })
  Object.defineProperty(pool, 'loaded', { value: false, writable: true, configurable: true })

  // 1) 首次访问 → 载入一次
  const first = await pool.listAccounts('buddy')
  assert.equal(first.length, 1, '首次载入读到 1 个账号')
  assert.equal(store.loads, 1, '首次访问只 load 一次')

  // 2) mtime 未变 → 连续访问零重读
  await pool.listAccounts('buddy')
  await pool.listAccounts('buddy')
  assert.equal(store.loads, 1, 'mtime 未变时不得重读')

  // 3) 外部改动文件（mtime 变）→ 重读并反映新内容
  state.accounts.push(
    { id: 'a2', provider: 'buddy', nickname: 'two', enabled: true, credentialRef: 'A2', createdAt: 2 },
  )
  store.stamp += 1
  const afterExternal = await pool.listAccounts('buddy')
  assert.equal(afterExternal.length, 2, '外部新增的账号必须可见（这是本缺陷的核心）')
  assert.equal(store.loads, 2, '外部改动后重读一次')

  // 4) 再次访问不重复重读
  await pool.listAccounts('buddy')
  assert.equal(store.loads, 2, '只重读一次，不重复')

  // 5) 自己写盘后不重读
  await pool.updateAccount('a1', { nickname: 'renamed' })
  const beforeSelfWrite = store.loads
  const afterSelf = await pool.listAccounts('buddy')
  assert.equal(store.loads, beforeSelfWrite, '自己写盘后不得再重读（mtime 已同步）')
  assert.equal(afterSelf.find(row => row.id === 'a1')?.nickname, 'renamed', '自有改动立即可见')

  // ── 限流报错里的「该渠道还有哪些模型可用」──
  {
    const { availableModelsForChannel } = await import('../vendor/channel-pack/src/account-pool.ts')
    const now = Date.now()
    const limitedUntil = now + 60 * 60_000
    const accounts = [
      // 只在 m1 上受限，m2/m3 正常
      { id: 'x', provider: 'workbuddy', enabled: true, modelRateLimits: { m1: limitedUntil, m3: 0 } },
    ]
    const models = [
      { id: 'm1', name: '模型一' },
      { id: 'm2', name: '模型二' },
      { id: 'm3', name: '模型三' },
    ]
    assert.deepEqual(
      availableModelsForChannel(accounts, models, 'm1', now),
      ['模型二', '模型三'],
      '必须排除失败的模型，且 0 值标记视为不受限',
    )
    // 全受限 → 空数组（调用方据此提示「该渠道所有模型都受限」）
    assert.deepEqual(
      availableModelsForChannel(
        [{ id: 'y', provider: 'workbuddy', enabled: true, modelRateLimits: { m2: limitedUntil, m3: limitedUntil } }],
        models, 'm1', now,
      ),
      [],
      '全部受限时返回空数组',
    )
    // 已过期标记视为可用
    assert.deepEqual(
      availableModelsForChannel(
        [{ id: 'z', provider: 'workbuddy', enabled: true, modelRateLimits: { m2: now - 1000 } }],
        models, 'm1', now,
      ),
      ['模型二', '模型三'],
      '过期标记不再限制',
    )
  }

  console.log('ok  account-pool-cache: 外部改动可感知、mtime 未变零重读、自写不自触发、限流时可列出同渠道可用模型')
}

exitIfDirectRun(import.meta.url, 'account-pool-cache-test')
