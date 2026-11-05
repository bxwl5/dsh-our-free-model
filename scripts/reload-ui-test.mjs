/**
 * 热重载按钮（首页插件设置）守护用例。
 *
 * 用户 2026-11-05：本机以前开过热重载、NAS 没按钮也不重载，改 pack.js 只能重启。
 * 功能来自仓库历史（99c0153 引入，95657a7/c7e6ca6 随公告中心删掉），本轮恢复。
 *
 * 本用例用离线假内核验证：
 * 1. src/reload.js 的核心导出都在（selfReload / watchPackage / isReloading）；
 * 2. POST /reload 先回 202 再异步触发（假内核无 loader/registry 时安全降级、不崩）；
 * 3. POST /settings {autoReloadWatch:true} 被接受，且 /summary 回显该字段；
 * 4. 静态守卫：前端设置页确实渲染了按钮与开关文案，后端路由/白名单都在。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { callRoute, fakeContext, until } from './lib/fake-kernel.mjs'

const repo = new URL('../', import.meta.url)
const read = rel => fs.readFileSync(fileURLToPath(new URL(rel, repo)), 'utf8')

// 1) 模块导出
const reload = await import('../src/reload.js')
for (const fn of ['selfReload', 'watchPackage', 'isReloading', 'purgeCaches', 'restoreCaches']) {
  assert.equal(typeof reload[fn], 'function', `src/reload.js 应导出 ${fn}`)
}

// 2) 静态守卫：后端接线 + 前端设置页按钮
const index = read('index.js')
assert.match(index, /hotReload:\s*reloadFromDisk/, 'deps 必须暴露 hotReload')
assert.match(index, /routePath === '\/reload'/, 'POST /reload 路由必须存在')
assert.match(index, /'autoReloadWatch'/, 'settings 白名单必须含 autoReloadWatch')
assert.match(index, /autoReloadWatch:\s*settings\.autoReloadWatch === true/, 'publicSettings 必须回显开关')
const client = read('client.js')
assert.match(client, /post\('\/reload'/, '前端必须调用 POST /reload')
assert.match(client, /t\('reload\.now'\)/, '设置页必须渲染「热重载插件」按钮')
assert.match(client, /autoReloadWatch:/, '设置页必须有自动重载开关')

// 3) 离线假内核：路由行为
const dead = http.createServer()
await new Promise(r => dead.listen(0, '127.0.0.1', r))
const deadBase = `http://127.0.0.1:${dead.address().port}`
await new Promise(r => dead.close(r))
process.env.OUR_FREE_MODEL_BASE = deadBase

const { apply, inject } = await import('../index.js')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-reload-ui-'))
process.env.DSH_HOME = home
const routes = []
const ctx = fakeContext({ inject, mounted: ['llm', 'webServer', 'attachments'], onRegister: route => routes.push(route) })
apply(ctx, {})
const api = () => routes.find(route => route.kind === 'prefix')?.handler
await until(() => api() !== undefined, { what: 'settings API', timeoutMs: 5000 })

try {
  // 开关：写进去、读回来
  const setRes = await callRoute(api(), 'POST', '/api/our-free-model/settings', { autoReloadWatch: true })
  assert.equal(setRes.status, 200, 'POST /settings 接受 autoReloadWatch')
  assert.equal(setRes.json.settings.autoReloadWatch, true, '/settings 回显开关为 true')
  const summary = await callRoute(api(), 'GET', '/api/our-free-model/summary')
  assert.equal(summary.json.settings.autoReloadWatch, true, '/summary 回显开关')

  // 按钮：先回 202（异步换 fiber）；假内核无 loader/registry 时降级、不崩
  const reloadRes = await callRoute(api(), 'POST', '/api/our-free-model/reload', {})
  assert.equal(reloadRes.status, 202, 'POST /reload 必须立即回 202（不等 fiber 销毁）')
  assert.equal(reloadRes.json.ok, true, '/reload 回 ok:true')
  // 给 setImmediate 的异步 selfReload 一个落地窗口：进程不应抛未捕获错误
  await new Promise(r => setTimeout(r, 120))
} finally {
  for (const disposer of ctx.__disposers.reverse()) {
    try { disposer() } catch { /* best effort */ }
  }
  fs.rmSync(home, { recursive: true, force: true })
}

console.log('ok  热重载：模块导出/后端路由/settings 开关回显/前端按钮齐全，POST /reload 先回 202 且无 loader 时安全降级')
