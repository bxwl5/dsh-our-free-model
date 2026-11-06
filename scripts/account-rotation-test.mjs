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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

/**
 * 运行时用例要 import 真实的 `account-pool.ts`，故需要与其它用例同款的
 * TypeScript 转译钩子（`typescript` 已是 devDependency）。
 *
 * ⚠️ 静态断言（读源码字符串）不需要钩子，但它和运行时用例共处一个文件，
 *    钩子必须在这里注册一次。
 */
const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const ts = (await import('typescript')).default
// 真实 DSH home 只读不写：把环境指到临时目录。
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-account-rotation-'))
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
  // ★ 2026-11-04 用户要求「把轮询开关图二做到上面的卡片里面去吧」——开关从
  //   独立的 ofm_strategyrow 并进了自动签到那一行（ofm_autostrategy），
  //   故这里断言新的类名与位置，**不再**要求已删除的独立行。
  assert.match(client, /ofm_autostrategy/, '要有账号轮询开关容器（已并入自动签到行）')
  assert.match(client, /chan\.strategy\.switch/, '要有开启账号轮询的文案')
  // 开关必须在**自动签到那一行**内部，而不是页面顶层的独立块。
  // ⚠️ 不能用第一个 ofm_row：client.js 里有几十个同名容器，必须锚定
  //   「auto == null ? null : h('div', { className: 'ofm_row' }」这处。
  // 2026-11-07：该行加了专用 class（两端分布），锚定字符串随之更新。
  const autoRowStart = client.indexOf("auto == null ? null : h('div', { className: 'ofm_row ofm_autorow' }")
  assert.ok(autoRowStart >= 0, '找不到自动签到那一行')
  const autoRow = client.slice(autoRowStart, autoRowStart + 4000)
  assert.ok(autoRow.includes('ofm_autostrategy'), '轮询开关必须落在自动签到那一行里')
  // 且必须在 ofm_strategyrow 这种独立块**之外**出现（老的独立卡片已删除）
  assert.equal(client.includes('ofm_strategyrow'), false, '独立的轮询行已按用户要求并入，不应再存在')

  // ⑤c 视觉对齐（用户 2026-11-04：「前面多了一个竖线」「卡片上面的按钮对齐，看着好别扭」）
  //   ① 开关容器**不得**再用 ::before 画分隔线 —— 那道 align-self:stretch 的 1px 线
  //      会随行高（含胶囊 padding）一起变长，看起来就是一根突兀的竖杠。
  assert.equal(
    client.includes('.ofm_autostrategy::before'),
    false,
    '开关容器不得再画分隔线（用户明确反馈那条竖线难看）',
  )
  //   ② 开关与胶囊必须有相同的行内盒高，否则 align-items:center 只是各自居中，
  //      视觉中心仍差 2px —— 那正是「按钮没对齐」的来源。
  const switchCss = client.slice(client.indexOf('.ofm_switch{'))
  assert.match(switchCss.slice(0, 300), /min-height:20px/, '开关要有 20px 行内盒高')
  const pillCss = client.slice(client.indexOf('.ofm_pill{'))
  assert.match(pillCss.slice(0, 300), /min-height:20px/, '胶囊要有 20px 行内盒高（与开关同值才对齐）')
  // ⚠️ 不能用 indexOf('.ofm_row{')：先命中的是 `.ofm_forward .ofm_row{gap:6px}`
  //    这种局部覆盖，得锚定顶层那条同时含 display:flex 的定义。
  const rowCss = client.slice(client.indexOf('.ofm_row{display:flex'))
  assert.match(rowCss.slice(0, 200), /min-height:24px/, '行容器要有最小行高')
  assert.match(client, /account\.getStrategy', \{\}/, '界面读全局策略（无参数）')
  // ★ 2026-11-05：开关只切模式（不传 stickyLimit，后端保留原值）——
  //   旧断言要求每次都带次数，那会把用户自定义过的值悄悄覆写成 10。
  assert.match(client, /account\.setStrategy', stickyLimit === undefined/, '界面切模式时不覆写次数')
  // 前端常量仍须与后端默认同值（首次拨开关时后端按缺省兜底到 10）
  assert.match(client, /const ACCOUNT_STICKY_LIMIT = 10/, '前端默认次数常量仍为 10')

  // ⚠️ 不得再出现在单个渠道的账号折叠区里
  const fold = client.slice(client.indexOf("open === 'accounts' ? h('div'"))
  assert.ok(fold.length > 0, '找不到账号折叠区')
  assert.doesNotMatch(fold.slice(0, 1500), /ofm_acctstrategy|getStrategy/, '账号折叠区里不得有策略控件（已改为全局）')

  // ⑤b 次数固定 10、不再暴露输入框（用户 2026-11-04：
  //    「轮询次数固定 10，不再显示了设置轮询次数了」）
  assert.match(client, /const ACCOUNT_STICKY_LIMIT = 10/, '前端要有固定次数常量 10')
  assert.doesNotMatch(client, /ofm_strategynum|chan\.strategy\.every|chan\.strategy\.times/,
    '次数输入框及其文案必须已删除（用户明确不再显示）')
  // 前后端常量必须同值，否则「用户什么都没改」的状态会在首次拨动开关后跳变
  assert.match(
    store,
    /export const DEFAULT_ACCOUNT_STICKY_LIMIT = 10/,
    '后端默认粘滞次数也必须是 10（与前端 ACCOUNT_STICKY_LIMIT 同值）',
  )
  const css2 = client.slice(client.indexOf('.ofm_autostrategy{'))
  assert.match(css2.slice(0, 400), /align-items:center/, '开关容器单行居中')

  // ⑥ 文案必须与「路由轮询」区分开
  assert.match(client, /'chan\.strategy\.sub': '[^']*同一渠道内的多个账号/, '中文文案要点明「同一渠道内的多个账号」')
  assert.match(client, /'chan\.strategy\.sub': '[^']*10 次/, '文案要写明固定次数 10（界面上已无数字可看）')
  assert.match(client, /'chan\.strategy\.sub': '[^']*本机设置/, '文案要标明是本机设置（多设备各存一份，别让人以为是云端开关）')
  assert.match(client, /'chan\.strategy\.sub': '[^']*unrelated to route rotation/, '英文文案要点明与路由轮询无关')

  console.log('ok  账号轮询（渠道内，全局生效）：策略/RPC/顶部大卡片齐备，且与路由轮询区分')
}

/**
 * ★ **运行时**验证：buddy 到底会不会真的换号（用户 2026-11-04 追问
 * 「buddy 现在能轮询了吗？」）。
 *
 * 静态 grep 只能证明「代码里出现了 rotateCandidates」，证明不了「请求真的换了
 * 账号」—— 这正是上一轮踩过的坑：buddy 走 `pickBuddyCredential` 自己选号，
 * 曾经 6 次真实请求全落在同一个账号，而当时的静态测试是绿的。
 *
 * 本用例用**真实 AccountPool**，按 `pickBuddyCredential` 里那行完全相同的调用
 * （`pool.rotateCandidates(product.id, candidates)`）连续取号，断言第一个候选
 * 确实在 10 次之后换人。
 */
export async function verifyBuddyRotationRuntime() {
  const { AccountPool } = await import('../vendor/channel-pack/src/account-pool.ts')
  const { DEFAULT_ACCOUNT_STICKY_LIMIT } = await import('../vendor/channel-pack/src/channel-pack-store.ts')

  // 固定 10（用户要求）：两个常量必须同值，否则「用户没改」的状态会在拨开关后跳变
  assert.equal(DEFAULT_ACCOUNT_STICKY_LIMIT, 10, '后端默认粘滞次数必须是 10')

  const state = {
    accounts: [
      { id: 'b1', provider: 'buddy', nickname: '一号', enabled: true, credentialRef: 'B1', createdAt: 1 },
      { id: 'b2', provider: 'buddy', nickname: '二号', enabled: true, credentialRef: 'B2', createdAt: 2 },
    ],
    disabledModels: {}, loomyPermanentLocked: false, gatewayEnabled: true, providerOrder: [],
  }
  const store = {
    kind: 'file',
    mtimeMs: () => 1000,
    load: () => JSON.parse(JSON.stringify(state)),
    save: async () => {},
  }
  const ctx = {
    store,
    logger: { warn() {}, info() {} },
    credentials: { resolve: async () => undefined, describe: async () => undefined, set: async () => {}, unset: async () => {} },
    permanentLocks: undefined,
  }
  const pool = new AccountPool(ctx)
  Object.defineProperty(pool, 'store', { value: store, writable: true, configurable: true })
  Object.defineProperty(pool, 'loaded', { value: false, writable: true, configurable: true })

  // 与 pickBuddyCredential 完全同形的候选构造（顺序 = 用户手排顺序）
  const candidates = () => pool
    .listAccountsByProvider('buddy')
    .filter(a => a.enabled)
    .map(a => ({ id: a.id, credentialRef: a.credentialRef }))

  // ① 顺序模式：怎么取都是同一个（历史行为不变）
  await pool.setAccountStrategy('sequential', DEFAULT_ACCOUNT_STICKY_LIMIT)
  const seq = []
  for (let i = 0; i < 25; i += 1) seq.push(pool.rotateCandidates('buddy', candidates())[0].id)
  assert.deepEqual([...new Set(seq)], ['b1'], '顺序模式下必须永远用第一个账号（历史行为不能变）')

  // ② 轮询模式：每 10 次换一个账号 —— 这就是「buddy 能否轮询」的直接答案
  await pool.setAccountStrategy('round-robin', DEFAULT_ACCOUNT_STICKY_LIMIT)
  const picked = []
  for (let i = 0; i < 25; i += 1) picked.push(pool.rotateCandidates('buddy', candidates())[0].id)
  assert.deepEqual(picked.slice(0, 10), Array(10).fill('b1'), '前 10 次粘在第一个账号')
  assert.deepEqual(picked.slice(10, 20), Array(10).fill('b2'), '第 11 次起换到第二个账号')
  assert.deepEqual(picked.slice(20, 25), Array(5).fill('b1'), '第 21 次起转回第一个')
  assert.equal(new Set(picked).size, 2, '⚠️ buddy 必须真的用到两个账号（曾 6 次请求全落在同一个）')

  // ③ 游标按渠道分开：动 buddy 不能带偏别的渠道
  const buddyCursor = picked.slice(0, 3)
  const other = pool.rotateCandidates('workbuddy', [
    { id: 'w1', credentialRef: 'W1' }, { id: 'w2', credentialRef: 'W2' },
  ])[0].id
  assert.equal(other, 'w1', '其它渠道的游标必须独立（buddy 转过 3 次不影响它）')
  assert.deepEqual(picked.slice(0, 3), buddyCursor, 'buddy 游标本身不受其它渠道影响')

  // ④ 单个账号时轮询不报错、不大于 1 的候选直接原样返回
  assert.deepEqual(
    pool.rotateCandidates('codearts', [{ id: 'only', credentialRef: 'O' }]).map(c => c.id),
    ['only'],
    '单号渠道在轮询模式下必须原样返回（不能崩）',
  )

  console.log('ok  运行时：buddy 真的会轮询换号（10 次一换，顺序模式不变）')
}

/**
 * ★ **落盘往返**：开关必须扛得住重启/重载（用户 2026-11-04：
 * 「为什么每次重启，重载，这个轮询按钮都被关了」）。
 *
 * 真实缺陷根因：`FileStore.load()` 与 `SettingsStore.load()` 都是**白名单重建**
 * 返回对象，只列了 accounts / disabledModels / loomyPermanentLocked /
 * gatewayEnabled / providerOrder，**漏了 accountStrategy 与 accountStickyLimit**。
 * 而 `save()` 那边（FileStore 是原样写出）一直带着它们 —— 于是磁盘上写着
 * `round-robin`，读回来却是 `undefined` ⇒ 回落 `sequential` ⇒ 界面开关「自己关了」。
 *
 * 本用例用**真实 FileStore + 临时目录**走完整的「写盘 → 全新实例重读」，
 * 只有真的跨实例读回来才算通过（单实例内读内存 cache 会假阳性）。
 */
export async function verifyStrategyPersistence() {
  const fsx = await import('node:fs')
  const pathx = await import('node:path')
  const { createChannelPackStore, DEFAULT_ACCOUNT_STICKY_LIMIT: STICKY } =
    await import('../vendor/channel-pack/src/channel-pack-store.ts')
  const { AccountPool } = await import('../vendor/channel-pack/src/account-pool.ts')

  const home = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'ofm-strategy-persist-'))
  const makeCtx = () => ({
    home,
    store: createChannelPackStore({ home, logger: { warn() {}, info() {} } }),
    logger: { warn() {}, info() {} },
    credentials: { resolve: async () => undefined, describe: async () => undefined, set: async () => {}, unset: async () => {} },
    permanentLocks: undefined,
  })

  // 第一次启动：拨到轮询 + 10
  const pool1 = new AccountPool(makeCtx())
  await pool1.addAccount({ id: 'b1', provider: 'buddy', nickname: '一号', enabled: true, credentialRef: 'B1', createdAt: 1 })
  await pool1.setAccountStrategy('round-robin', STICKY)
  assert.deepEqual(pool1.accountStrategy(), { strategy: 'round-robin', stickyLimit: 10 }, '拨动后当场生效')

  // 模拟重启：**全新实例**读同一份磁盘（这点是关键，单实例读 cache 测不出本缺陷）
  const pool2 = new AccountPool(makeCtx())
  assert.deepEqual(
    pool2.accountStrategy(),
    { strategy: 'round-robin', stickyLimit: 10 },
    '⚠️ 重启后轮询开关必须还是开着（否则用户每次都要手动再拨一次）',
  )

  // 反过来也要守：关掉之后重启仍然是关的（不能变成「永远开着」）
  await pool2.setAccountStrategy('sequential', STICKY)
  const pool3 = new AccountPool(makeCtx())
  assert.equal(pool3.accountStrategy().strategy, 'sequential', '关掉之后重启必须仍是关的')

  fsx.rmSync(home, { recursive: true, force: true })
  console.log('ok  运行时：轮询开关扛得住重启/重载（真实 FileStore 落盘往返）')
}

/**
 * ★ 轮询铁律（用户 2026-11-05）：账号轮询与路由轮询同一套 —— 无视限流/封禁/
 * 健康度，游标只按名额走。
 *
 * 锁死两件事：
 *  1. 被限流的账号**不被剔出候选**：轮到它照样交出去（适配器内部失败时在
 *     本请求内顺延），它不会从轮换里消失 —— zcode 那种「2 个号被标记整天、
 *     候选只剩 1 个、永远同一号」的形态不会再有。
 *  2. 名额归属校验：候选集合变化导致游标 index 指到别的账号时，`used`
 *     必须归零，不能把 A 剩下的名额平白记到 B 头上。
 */
export async function verifyRoundRobinIgnoresRateLimits() {
  const { AccountPool } = await import('../vendor/channel-pack/src/account-pool.ts')
  const { DEFAULT_ACCOUNT_STICKY_LIMIT: STICKY } =
    await import('../vendor/channel-pack/src/channel-pack-store.ts')

  const state = {
    accounts: [
      { id: 'a1', provider: 'zcode', enabled: true, credentialRef: 'A1', createdAt: 1 },
      { id: 'a2', provider: 'zcode', enabled: true, credentialRef: 'A2', createdAt: 2 },
      { id: 'a3', provider: 'zcode', enabled: true, credentialRef: 'A3', createdAt: 3 },
    ],
    disabledModels: {}, loomyPermanentLocked: false, gatewayEnabled: true, providerOrder: [],
  }
  const store = { kind: 'file', mtimeMs: () => 1000, load: () => JSON.parse(JSON.stringify(state)), save: async () => {} }
  const ctx = {
    store, logger: { warn() {}, info() {} },
    credentials: { resolve: async () => ({ value: '{}' }), describe: async () => undefined, set: async () => {}, unset: async () => {} },
    permanentLocks: undefined,
  }
  const pool = new AccountPool(ctx)
  Object.defineProperty(pool, 'store', { value: store, writable: true, configurable: true })
  Object.defineProperty(pool, 'loaded', { value: false, writable: true, configurable: true })
  await pool.setAccountStrategy('round-robin', STICKY)

  // a2 被限流到明天 —— 旧逻辑会把它剔出候选；铁律下必须照常轮到它
  await pool.updateModelRateLimit('a2', 'glm', Date.now() + 86_400_000)
  const picks = []
  for (let i = 0; i < 33; i += 1) {
    const hit = await pool.getAvailableAccount('zcode', 'glm')
    picks.push(hit ? hit.entry.id : 'null')
  }
  assert.deepEqual(picks.slice(0, 30), [...Array(10).fill('a1'), ...Array(10).fill('a2'), ...Array(10).fill('a3')],
    '⚠️ 轮询必须无视限流：a2 被标记整天也要按名额轮到（每号 10 次、按用户顺序）')

  // 名额归属：把游标手动推到 a2 名额第 7 次，然后删掉 a2 —— a3 接手时 used 必须归零
  // ⚠ pool2 必须感知「外部删除」：store 的 mtime 是恒定的 1000，直接换一个
  //   mtime 会变的假 store，否则 ensureLoaded 认为「自己写的、无需重读」。
  let mtime = 2000
  // ⚠️ save 必须把池写下的字段（含 accountStrategy）真写回 state：
  // FileStore 会持久化它们；假 store 若丢弃，下一次重读就会把策略回落成
  // sequential（缺键默认），轮换「莫名其妙停了」—— 那测的是脚手架不是产品。
  const store2 = {
    kind: 'file',
    mtimeMs: () => mtime,
    load: () => JSON.parse(JSON.stringify(state)),
    save: async (next) => {
      Object.assign(state, JSON.parse(JSON.stringify(next)))
      mtime += 1
    },
  }
  const ctx2 = { ...ctx, store: store2 }
  const pool2 = new AccountPool(ctx2)
  Object.defineProperty(pool2, 'store', { value: store2, writable: true, configurable: true })
  Object.defineProperty(pool2, 'loaded', { value: false, writable: true, configurable: true })
  await pool2.setAccountStrategy('round-robin', STICKY)
  for (let i = 0; i < 17; i += 1) await pool2.getAvailableAccount('zcode', 'glm')  // a1×10, a2×7
  state.accounts.splice(1, 1)  // 删 a2（外部改）
  mtime += 1000  // 让池在下一次访问时感知外部改动
  const after = []
  for (let i = 0; i < 12; i += 1) {
    const hit = await pool2.getAvailableAccount('zcode', 'glm')
    after.push(hit ? hit.entry.id : 'null')
  }
  assert.equal(after[0], 'a3', '游标原在 a2（index1），a2 删除后应落到下一个健康号 a3')
  assert.deepEqual(after.slice(0, 10), Array(10).fill('a3'),
    '⚠️ 接手者必须从 0 数满自己的名额（a3 10 次），不能继承 a2 剩下的 3 次就提前换人')
  assert.equal(after[10], 'a1', 'a3 名额走满后按序回到 a1')

  console.log('ok  运行时：账号轮询无视限流（被标记整天的号照常轮到）、名额归属不串')
}

verifyAccountRotation()
await verifyBuddyRotationRuntime()
await verifyStrategyPersistence()
await verifyRoundRobinIgnoresRateLimits()
hooks.deregister()
