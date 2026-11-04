/**
 * 守卫：路由候选**按需重读**渠道名册，且**不得**订阅 `llm/adapters-updated`。
 *
 * ## 事故经过（2026-11-04）
 *
 * 需求是「在渠道里开启模型后，路由添加成员应该立刻看到，不用热重载」。
 * 第一版实现订阅渠道包的 `llm/adapters-updated` 事件去刷新聚合目录 —— 但本插件
 * 的 `emitTopology()` **自己也 emit 同一个事件**：
 *
 * ```
 * 监听器 → refreshChannelCatalog() → emitTopology() → emit(同一事件) → 监听器 → …
 * ```
 *
 * `refreshChannelCatalog()` 要遍历全部渠道 × 全部模型（每个还打
 * `ensureRemoteModels`，含读盘）。递归起来主线程 100% 卡死：HTTP 端口不响应、
 * 桌面端启动 watchdog 超时，用户看到「CPU 飙升、框架卡死、无法启动」，
 * 只能禁用插件。
 *
 * ## 现在的做法
 *
 * 改用**按需读取**：`GET /combos`（点「添加成员」时必然调用）先重读一次渠道
 * 名册再返回候选。更简单、不遗漏，也没有任何事件时序/递归风险。
 *
 * ## 本守卫锁死
 *
 * 1. **不得**再出现 `ctx.on('llm/adapters-updated')` 订阅（防有人「优化」回来）；
 * 2. `combos.list` 必须真的重读名册（否则又回到「不重启看不到新模型」）；
 * 3. 该重读必须有节流（编辑器加载与每次保存都会重拉）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')

// ── 1. 不得订阅 llm/adapters-updated ──
assert.equal(/ctx\.on\?\.\(\s*['"]llm\/adapters-updated['"]/.test(source), false,
  '不得订阅 llm/adapters-updated：本插件的 emitTopology() 自己也 emit 它，'
  + '订阅会造成「emit → 监听 → refreshChannelCatalog → emit → …」无限递归，'
  + '主线程 100% 卡死（11-04 实际事故）。渠道模型时效性请用 GET /combos 的按需重读。')

// ── 2. combos.list 必须重读渠道名册 ──
const listStart = source.indexOf('list: async () =>')
assert.ok(listStart >= 0,
  'combos.list 必须是 async 并按需重读渠道名册（否则「渠道开了模型，路由添加成员看不到」会复发）')
const listBody = source.slice(listStart, listStart + 1600)
assert.ok(/refreshChannelCatalog\(/.test(listBody),
  'combos.list 里必须调用 refreshChannelCatalog() 重读名册')
assert.ok(/await\s+modelRuntime\.refreshChannelCatalog\(/.test(listBody),
  '必须 await 它，否则候选列表还是旧快照')
// 失败不能让编辑器打不开
assert.ok(/catch/.test(listBody), '重读失败必须被 catch：编辑器不能因为名册读取失败就打不开')

// ── 3. 必须有节流 ──
assert.ok(/channelRosterReadAt/.test(source),
  '按需重读必须节流：编辑器在加载与每次保存后都会重拉 /combos，每次都全量扫太浪费')

// ── 4. 路由处理器必须 await 这个 async list ──
assert.ok(/await\s+deps\.combos\.list\(\)/.test(source),
  'GET /combos 的处理器必须 await combos.list() —— 否则返回的是 Promise，前端拿到空对象')

// ── 5. 名册扫描仍要有时间预算与并发上限（启动不能被拖死）──
const catalogSource = fs.readFileSync(new URL('../src/channel-catalog.js', import.meta.url), 'utf8')
assert.ok(/ROSTER_BUDGET_MS/.test(catalogSource),
  'readChannelRosters 必须有时间预算 —— 它在启动与编辑器路径上都会被 await')
assert.ok(/ROSTER_RESOLVE_CONCURRENCY/.test(catalogSource),
  'resolveModelInfo 必须限并发 —— 原实现把全量模型一次性 Promise.all 出去')
assert.equal(/await Promise\.all\(roster\.map/.test(catalogSource), false,
  '不得恢复成对全量模型直接 Promise.all')

console.log('ok  路由候选按需重读渠道名册（不订阅事件、有节流、async 已 await）')

/**
 * 附加守卫：`/combos` 必须走 **light** 模式刷新。
 *
 * 用户 2026-11-04 明确要求：「点添加成员时拉取**各渠道已启用的模型**，
 * 不是刷新全部渠道的模型列表」。两者区别在于是否逐模型 `resolveModelInfo`
 * —— 那一步只影响容量元数据（contextWindow / maxOutput），与「哪些模型开着」
 * 无关，却是整条路径上最重的部分（每模型一次，且会打到适配器的
 * `ensureRemoteModules`，含读盘）。
 *
 * 走 light 后：`llm.listModels` 照问（宿主返回的本就是已启用模型，开关立刻反映），
 * 但不逐模型解析，容量复用上一次完整扫描的结果。
 */
export function verifyCombosLightRefresh() {
  const readonly = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.ok(/refreshChannelCatalog\(\{\s*light:\s*true\s*\}\)/.test(readonly),
    '/combos 的刷新必须传 { light: true }：只取「已启用清单」，不为容量逐模型解析')

  const catalog = fs.readFileSync(new URL('../src/channel-catalog.js', import.meta.url), 'utf8')
  assert.ok(/light/.test(catalog) && /previousRows/.test(catalog),
    'readChannelRosters 必须支持 light 模式并复用上次的容量元数据')
  assert.ok(/if \(light\) \{/.test(catalog),
    'light 模式必须真的跳过 resolveModelInfo 分支')

  console.log('ok  /combos 走 light 刷新（只取已启用模型，不逐模型解析容量）')
}

// 本文件是自执行型守卫（test-all 直接运行），末尾立即校验 light 模式。
verifyCombosLightRefresh()
