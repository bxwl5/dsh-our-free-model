/**
 * 「用时续期」判据回归（2026-10-30，用户报「OfficeAce 老是凭证过期」）。
 *
 * 背景：OfficeAce 的 STS 寿命约 2 小时（AutoClaw 约 5.7 小时），而续期只有
 * 一个 30 分钟定时器（距过期不足 1 小时才续）。DSH 关闭/重启/休眠期间必然
 * 过期，过期时签到/余额/倍率全部 `APIG.0602`。修复是在**每次取凭据前**判一次
 * 临期就先续（`ensureCredentialFresh`，两条路径共用 in-flight 去重表）。
 *
 * 本用例只测**判据链**（不联网）：临期/已过期/无 expire_time 都要续；
 * 未临期与无 refresh_token 不续（避免烧掉一次性 token）。
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

export async function verifyCredentialFreshness() {
  const { shouldRefreshNow } = await import('../vendor/channel-pack/src/expiry-sync.ts')
  const now = Date.now()

  // 与 index.ts 的 ensureCredentialFresh 同一条判据链（保持逐字一致）
  const decide = (credential) => {
    if (typeof credential.refresh_token !== 'string' || credential.refresh_token === '') return 'skip-no-token'
    const expiresAt = typeof credential.expire_time === 'number' ? credential.expire_time : undefined
    if (expiresAt !== undefined && !shouldRefreshNow(expiresAt)) return 'skip-fresh'
    return 'refresh'
  }

  assert.equal(decide({ refresh_token: 'r', expire_time: now + 30 * 60_000 }), 'refresh', '临期（30 分钟内到期）必须续')
  assert.equal(decide({ refresh_token: 'r', expire_time: now - 10 * 60_000 }), 'refresh', '已过期必须续')
  assert.equal(decide({ refresh_token: 'r', expire_time: now + 3 * 3_600_000 }), 'skip-fresh', '未临期不得续（省一次性 token）')
  assert.equal(decide({ refresh_token: 'r' }), 'refresh', '没有 expire_time 按「可能已过期」处理，照常续')
  assert.equal(decide({ expire_time: now - 1_000 }), 'skip-no-token', '没有 refresh_token 无法续，直接放行')

  console.log('ok  credential-freshness: 用时续期判据（临期/过期/缺字段续，未临期与无 token 不续）')
}

import { exitIfDirectRun } from './lib/direct-run.mjs'
exitIfDirectRun(import.meta.url, 'credential-freshness-test')
