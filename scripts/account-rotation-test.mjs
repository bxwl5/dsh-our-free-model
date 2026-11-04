/**
 * 守卫：账号选择要支持「轮询 / 顺序」开关与轮询次数（2026-11-04 用户要求）。
 *
 * 用户原话：
 * > 关于渠道的多账号，默认是按照顺序来进行使用的，非要把账号1用到封禁/限流/
 * > 欠费，才会用账号2。这个很不合理，要加入轮询/顺序开关，还有轮询次数的设置。
 * > 在账号界面
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')

export function verifyAccountRotation() {
  // ① 状态字段
  const store = read('vendor/channel-pack/src/channel-pack-store.ts')
  assert.match(store, /accountStrategy\?: Record<string, AccountStrategy>/, '状态里要有按 provider 的策略表')
  assert.match(store, /accountStickyLimit\?: Record<string, number>/, '状态里要有按 provider 的轮询次数')
  assert.match(store, /DEFAULT_ACCOUNT_STICKY_LIMIT/, '要有默认轮询次数常量')
  assert.match(store, /export function sanitizeAccountStrategy/, '要有策略清洗（脏值回落到 sequential）')

  // ② 清洗语义：脏值必须丢弃该键 ⇒ 回落到顺序模式，而不是猜成轮询
  const stratFn = store.slice(store.indexOf('export function sanitizeAccountStrategy'))
  const stratBody = stratFn.slice(0, stratFn.indexOf('\n}\n') + 3)
  assert.match(stratBody, /'sequential'/, 'sequential 必须在白名单里')
  assert.match(stratBody, /'round-robin'/, 'round-robin 必须在白名单里')
  assert.match(stratBody, /!==/, '非白名单值必须被丢弃（不写进 out）')

  // ③ 账号池：轮询确实改变候选顺序
  const pool = read('vendor/channel-pack/src/account-pool.ts')
  assert.match(pool, /private accountStrategyFor\(/, '要有按 provider 取策略的方法')
  assert.match(pool, /private accountStickyFor\(/, '要有按 provider 取轮询次数的方法')
  assert.match(pool, /if \(strategy === 'round-robin' && candidates\.length > 1\)/, '轮询分支必须存在')
  assert.match(pool, /this\.accountRotation\.set\(/, '必须有轮转游标推进')
  assert.match(pool, /async setAccountStrategy\(/, '必须有写入策略的入口')

  // ⚠️ 关键：顺序模式的默认值必须是 sequential，否则老用户升级后行为突变
  assert.match(pool, /this\.accountStrategyCache\[provider\] \?\? 'sequential'/, '缺键必须回落到顺序模式')

  // ④ RPC
  const rpc = read('vendor/channel-pack/src/channel-pack-rpc.ts')
  assert.match(rpc, /case 'account\.getStrategy'/, '要有读取策略的 RPC')
  assert.match(rpc, /case 'account\.setStrategy'/, '要有写入策略的 RPC')

  // ⑤ 界面
  const ui = read('packages/standalone/frontend/channels.mjs')
  assert.match(ui, /account\.getStrategy/, '账号界面要读当前策略')
  assert.match(ui, /account\.setStrategy/, '账号界面要能写策略')
  assert.match(ui, /' 账号轮询'/, '界面要有「账号轮询」开关')
  assert.match(ui, /次后切换/, '界面要有轮询次数设置')

  console.log('ok  账号轮询/顺序开关 + 轮询次数（后端策略、RPC、账号界面三处齐备）')
}

verifyAccountRotation()
