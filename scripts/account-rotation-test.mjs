/**
 * 守卫：**账号轮询**（渠道内多账号之间）—— 全局开关 + 轮询次数。
 *
 * 用户 2026-11-04 的两轮要求：
 *  ①「关于渠道的多账号，默认是按照顺序来进行使用的，非要把账号1用到封禁/
 *     限流/欠费，才会用账号2。这个很不合理，要加入轮询/顺序开关，还有轮询
 *     次数的设置。」
 *  ②「我想了一下不单独加在账号渠道卡片里面了，加在渠道接入上面的大卡片里面去，
 *     设置对全部渠道生效。」
 *  ③「记住这个和路由的轮询不一样，路由是渠道轮询，这个是渠道内的账号轮询」
 *
 * ⚠️ 本测试守的是「**渠道内账号轮询**」。**路由轮询**（combo 成员之间、通常就是
 *    不同渠道）由 `src/combos.js` 负责，两者字段与文案都不得混用。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')
const blockOf = (text, startMarker, endMarker = '\n}\n') => {
  const from = text.indexOf(startMarker)
  assert.ok(from >= 0, `找不到 ${startMarker}`)
  const to = text.indexOf(endMarker, from)
  return text.slice(from, to === -1 ? undefined : to)
}

export function verifyAccountRotation() {
  const store = read('vendor/channel-pack/src/channel-pack-store.ts')
  const pool = read('vendor/channel-pack/src/account-pool.ts')
  const rpc = read('vendor/channel-pack/src/channel-pack-rpc.ts')
  const types = read('vendor/channel-pack/src/types.ts')
  const client = read('client.js')

  // ① 状态字段仍在（结构兼容已落盘的 2.5.7 文档）
  assert.match(store, /accountStrategy\?: Record<string, AccountStrategy>/, '要有策略字段')
  assert.match(store, /accountStickyLimit\?: Record<string, number>/, '要有次数字段')
  assert.match(store, /DEFAULT_ACCOUNT_STICKY_LIMIT/, '要有默认次数常量')

  // ② 全局键：策略只存一份，对全部渠道生效
  assert.match(store, /export const ACCOUNT_STRATEGY_GLOBAL_KEY = '\*'/, '要有全局策略键')
  const sanitize = blockOf(store, 'export function sanitizeAccountStrategy')
  assert.doesNotMatch(sanitize, /for \(const \[provider/, '清洗不得再遍历 per-provider（那是分渠道语义）')
  assert.match(sanitize, /ACCOUNT_STRATEGY_GLOBAL_KEY/, '清洗必须只取全局键')
  const sanitizeSticky = blockOf(store, 'export function sanitizeAccountSticky')
  assert.match(sanitizeSticky, /ACCOUNT_STRATEGY_GLOBAL_KEY/, '次数也要只认全局键')

  // ③ 账号池：策略全局读，游标按渠道存
  assert.match(pool, /private accountStrategyValue\(/, '策略读取入口')
  assert.match(pool, /private accountStickyValue\(/, '次数读取入口')
  assert.match(pool, /if \(this\.accountStrategyValue\(\) !== 'round-robin'\) return candidates/, '轮询分支必须存在')
  assert.match(pool, /this\.accountRotation\.set\(/, '必须有轮转游标推进')
  assert.match(pool, /async setAccountStrategy\(/, '必须有写入策略的入口')
  assert.match(
    pool,
    /return this\.accountStrategyCache\[ACCOUNT_STRATEGY_GLOBAL_KEY\] \?\? 'sequential'/,
    '缺键必须回落到顺序模式（老用户升级后行为不变）',
  )
  assert.match(pool, /this\.accountRotation\.clear\(\)/, '策略变更要清空全部渠道游标')
  // ⚠️ 全局策略 + 每渠道独立游标：游标 key 必须仍是 provider
  const rr = pool.slice(pool.indexOf('rotateCandidates<T>'))
  assert.match(rr.slice(0, 1600), /this\.accountRotation\.(get|set)\(\s*provider/, '轮转游标必须按 provider 分开存')

  // ③b 轮转必须是**池的公共能力** —— buddy/workbuddy 自选号，不走 getAvailableAccount
  assert.match(pool, /rotateCandidates<T>\(/, '轮转要抽成公共方法')
  const indexTs = read('vendor/channel-pack/src/index.ts')
  const buddyPick = indexTs.slice(indexTs.indexOf('const pickBuddyCredential'))
  assert.match(
    buddyPick.slice(0, 4000),
    /pool\.rotateCandidates\(options\.product\.id/,
    'pickBuddyCredential 必须过轮转（否则 buddy/workbuddy 多账号永不换号）',
  )
  // ⚠️ 只能调一次：免费路径与余额分档路径共用同一份顺序
  assert.equal(
    buddyPick.slice(0, 4000).match(/pool\.rotateCandidates\(/g).length,
    1,
    '一次请求只能推进一次轮转（调两次会让「连续 N 次」减半）',
  )

  // ④ RPC：全局读写，请求体不再带 provider
  assert.match(rpc, /case 'account\.getStrategy'/, '要有读取策略的 RPC')
  assert.match(rpc, /case 'account\.setStrategy'/, '要有写入策略的 RPC')
  const getReq = blockOf(types, 'export interface RpcGetAccountStrategyRequest')
  assert.match(getReq, /\{\}/, '读取请求应无参数（全局设置）')
  const setReq = blockOf(types, 'export interface RpcSetAccountStrategyRequest')
  assert.doesNotMatch(setReq, /provider: string/, '写入请求不得再要求 provider')
  assert.match(types, /usableProviders: number/, '要回报「几个渠道会受影响」')

  // ⑤ 界面：**渠道接入页顶部大卡片**（全局）
  assert.match(client, /ofm_strategyrow/, '要有全局策略行')
  assert.match(client, /chan\.strategy\.title/, '要有「账号轮询」标题文案')
  assert.match(client, /account\.getStrategy', \{\}/, '界面读全局策略（无参数）')
  assert.match(client, /account\.setStrategy', \{ strategy/, '界面写全局策略（无 provider）')

  // ⚠️ 不得再出现在单个渠道的账号折叠区里
  const fold = client.slice(client.indexOf("open === 'accounts' ? h('div'"))
  assert.ok(fold.length > 0, '找不到账号折叠区')
  assert.doesNotMatch(fold.slice(0, 1500), /ofm_acctstrategy|getStrategy/, '账号折叠区里不得有策略控件（已改为全局）')

  // ⑥ 文案必须与「路由轮询」区分开
  assert.match(client, /'chan\.strategy\.sub': '[^']*同一渠道内多个账号/, '中文文案要点明「同一渠道内多个账号」')
  assert.match(client, /'chan\.strategy\.sub': '[^']*unrelated to route rotation/, '英文文案要点明与路由轮询无关')

  console.log('ok  账号轮询（渠道内，全局生效）：策略/RPC/顶部大卡片齐备，且与路由轮询区分')
}

verifyAccountRotation()
