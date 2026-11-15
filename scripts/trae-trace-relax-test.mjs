/**
 * TRAE 登录的 login_trace_id 校验放宽为「带则比，不带则放」。
 *
 * 2026-11-15 用户 Windows 实测：浏览器授权成功，回跳的 query 不带
 * `login_trace_id`（或带的值与派生值不同），2026-11-08 终审 R7 引入的
 * 严格相等校验把合法回调拒成「login_trace_id 不匹配」⇒ 登录永远失败。
 * magpie 同期完全不校验该字段（只发不比），同期登录成功 —— 行为差异坐实
 * R7 当年的「上游会回传该字段」是未实测的假设。
 *
 * 新口径：
 *   ① 回调**不带** login_trace_id → 放行（上游行为变化不挡用户）；
 *   ② 回调**带了且匹配** → 放行（正常路径不变）；
 *   ③ 回调**带了但不匹配** → 仍拒（保留 R7 的防伪造价值）。
 *
 * 本套件通过真实的本地回调服务器（startTraeLoginFlow）端到端锁定。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const llm = 'data:text/javascript,' + encodeURIComponent(`export * from ${JSON.stringify(kernel)}
  export class LlmError extends Error { constructor(m,c,o){super(m,o);this.code=c} }`)
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-llm') return { url: llm, shortCircuit: true }
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    if (context.parentURL?.startsWith(sourceRoot) && specifier.endsWith('.js')) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href
      if (url.startsWith(sourceRoot) && fs.existsSync(fileURLToPath(url))) return { url, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(fs.readFileSync(fileURLToPath(url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: fileURLToPath(url),
      }).outputText,
    }
    return next(url, context)
  },
})

const { startTraeLoginFlow, machineTraceId } = await import('../vendor/channel-pack/src/trae-oauth.ts')
const { TRAE } = await import('../vendor/channel-pack/src/trae-product.ts')

/** 一次性上游桩：回调 token 换新（ExchangeToken）+ 用户信息（GetUserInfo）。 */
function upstreamStub() {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push(req.url)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    // 响应结构对齐 Go 端：{ Result: {...} }（parseTraeExchangeResponse /
    // parseTraeUserInfoResponse 都只认 Result 包装）。
    if (req.url.includes('ExchangeToken')) {
      res.end(JSON.stringify({ Result: { Token: 'tk', RefreshToken: 'rt', TokenExpireAt: 1893456000000 } }))
    } else {
      res.end(JSON.stringify({ Result: { UserID: 42, ScreenName: 'tester', NonPlainTextMobile: '', NonPlainTextEmail: '' } }))
    }
  })
  return { server, seen }
}

const product = {
  ...TRAE,
  agentHost: 'http://127.0.0.1:0',
  oauthHost: 'http://127.0.0.1:0',
  consoleHost: 'https://www.trae.cn',
}

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

// 回调投递器：按场景往回调 URL 投查询串
async function deliver(callbackUrl, params) {
  const u = new URL(callbackUrl)
  const res = await fetch(`${u.origin}/authorize?${new URLSearchParams(params)}`)
  await res.text().catch(() => {})
}

// 三个场景各起一次登录（回调服务器一次登录只收一发）
const runScenario = async (scenarioIndex, extraParams) => {
  const up = upstreamStub()
  await new Promise((r) => { up.server.listen(0, '127.0.0.1', r) })
  const port = up.server.address().port
  const productLocal = {
    ...TRAE,
    agentHost: `http://127.0.0.1:${port}`,
    oauthHost: `http://127.0.0.1:${port}`,
    consoleHost: 'https://www.trae.cn',
  }
  const flow = await startTraeLoginFlow({ product: productLocal })
  // 从 loginUrl 解出本次的期望 trace（generateMachineId 是内部随机的，
  // 但 machineTraceId(m, d) 可从 URL 参数反推）
  const loginQ = new URL(flow.loginUrl)
  const expected = machineTraceId(loginQ.searchParams.get('machine_id'), loginQ.searchParams.get('device_id'))
  const params = scenarioIndex === 1 ? { login_trace_id: expected, ...extraParams } : extraParams
  // 投回调（用户场景：真实回调 = refreshToken + userInfo）
  await deliver(new URL(flow.loginUrl).searchParams.get('auth_callback_url'), {
    refreshToken: 'rt-raw',
    userInfo: JSON.stringify({ UserID: 42, ScreenName: 'tester' }),
    ...params,
  })
  const outcome = await Promise.race([
    flow.result.then(() => 'ok').catch((e) => `rejected: ${e.message}`),
    new Promise((r) => setTimeout(() => r('timeout'), 8000)),
  ])
  up.server.closeAllConnections?.()
  await new Promise((r) => up.server.close(r))
  return { outcome, expected }
}

await check('① 回调不带 login_trace_id → 放行', async () => {
  const { outcome } = await runScenario(0, {
    refreshToken: 'rt-raw',
    userInfo: JSON.stringify({ UserID: 42, ScreenName: 'tester' }),
  })
  assert.equal(outcome, 'ok', `应放行，实际：${outcome}`)
})

await check('② 回调带且匹配 → 放行', async () => {
  const { outcome } = await runScenario(1, {})
  assert.equal(outcome, 'ok', `应放行，实际：${outcome}`)
})

await check('③ 回调带但不匹配 → 拒', async () => {
  const { outcome } = await runScenario(2, { login_trace_id: '0000000000000000' })
  assert.match(String(outcome), /login_trace_id 不匹配/, `应拒绝，实际：${outcome}`)
})

if (failures > 0) console.error(`trae-trace-relax-test: ${failures} failure(s)`)
else console.log('trae-trace-relax-test: a callback without a trace passes; a mismatching one still fails')
process.exitCode = failures > 0 ? 1 : 0
