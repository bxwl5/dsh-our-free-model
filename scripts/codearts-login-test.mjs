/**
 * CodeArts 登录启动与回调的端到端回归（不联网、不登录）。
 *
 * 为什么需要它（2026-10-30 真实缺陷）：清理旧 ticket 流程时把 `randomBytes`
 * 的 import 一起删了，`startOAuthFlow` 一被调用就 `ReferenceError` ——
 * 用户点「添加账号」立刻报错。`tsc` 只覆盖 `adapter/**`，`vendor/` 不在范围，
 * 既有套件也没有任何用例直接跑这条路径，于是全绿着坏。
 *
 * 覆盖：
 *   1. `startOAuthFlow()` 能起回调服务器并返回合法 portal 授权 URL
 *      （含 port / code_challenge / ticket_id，且 port ≥ 10000）；
 *   2. 无 code 的回调 → 307 到 portal 失败页 + result 以可读原因 reject；
 *   3. 关闭后端口释放（可再次启动，不泄漏监听）。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const srcRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href

registerHooks({
  resolve(specifier, context, next) {
    if (String(context.parentURL).includes('/vendor/channel-pack/src/') && specifier.endsWith('.js') && !specifier.startsWith('@')) {
      const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
      if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(srcRoot) && url.endsWith('.ts') && existsSync(url)) {
      return {
        format: 'module',
        shortCircuit: true,
        source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        }).outputText,
      }
    }
    return next(url, context)
  },
})

export async function verifyCodeArtsLogin() {
  const { startOAuthFlow } = await import('../vendor/channel-pack/src/login.ts')

  // ① 启动：必须拿到 portal 授权 URL（2026-10-30 缺陷点：randomBytes 未定义）
  const started = await startOAuthFlow({})
  try {
    const url = new URL(started.loginUrl)
    assert.equal(url.origin + url.pathname, 'https://codearts.huaweicloud.com/portal/authorize', '必须是 portal 授权端点')
    const port = Number(url.searchParams.get('port'))
    assert.ok(Number.isInteger(port) && port >= 10_000, `回调端口必须 ≥10000，实际 ${port}`)
    assert.equal(url.searchParams.get('code_challenge_method'), 'SHA-256', 'PKCE 方法对齐真实插件')
    assert.ok((url.searchParams.get('code_challenge') ?? '').length >= 43, '必须带 PKCE challenge')
    assert.ok((url.searchParams.get('ticket_id') ?? '').length === 64, 'v2 票号必须是 32 字节 hex')

    // ② 无 code 的回调：307 到 portal 失败页 + result 立即 reject（不挂死）
    // ⚠ 两处坑：
    //  1) 必须用 undici 的 fetch —— channel-pack-test 挂载期间把 globalThis.fetch
    //     换成了「一律拒绝」的离线钩子（本机回环也被拒）；
    //  2) redirect: 'manual' —— 默认跟随会把 307 跟到 portal 结果页（200），断言失效。
    const { fetch: localFetch } = await import('undici')
    const response = await localFetch(`http://127.0.0.1:${port}/oauth/callback?error=access_denied&error_description=probe`, { redirect: 'manual' })
    assert.equal(response.status, 307, '无 code 必须 307 到结果页')
    assert.match(response.headers.get('location') ?? '', /login_succeed=false/, '失败结果页标记')
    await assert.rejects(() => started.result, /授权回调缺少 code/, '失败原因必须可读')

    console.log('ok  codearts-login: 启动出 portal URL（port/PKCE/ticket 校验）→ 无 code 回调 307 且原因可读')
  } finally {
    await started.close()
  }

  // ③ 关闭后能再次启动（端口不泄漏）
  const again = await startOAuthFlow({})
  const secondPort = Number(new URL(again.loginUrl).searchParams.get('port'))
  assert.ok(secondPort >= 10_000, '二次启动仍必须 ≥10000')
  await again.close()
}

import { exitIfDirectRun } from './lib/direct-run.mjs'
exitIfDirectRun(import.meta.url, 'codearts-login-test')
