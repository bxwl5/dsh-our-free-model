/**
 * 元测试：只导出 `verifyXxx()` 的测试模块必须有「直接运行即失败」的守卫。
 *
 * 背景：这类文件由 `channel-pack-test.mjs --source` 等汇总套件 import 后调用，
 * 依赖是动态 import 的 `.ts`。直接 `node scripts/xxx-test.mjs` 会零断言却 exit 0 ——
 * 看起来像通过（本仓库踩过两次：`commandcode-auth-test`、`accio-test`）。
 *
 * 规则：凡导出 `verify*` 的脚本，必须满足其一：
 *   - 引用 `exitIfDirectRun`（scripts/lib/direct-run.mjs 的守卫）；
 *   - 自带 `isDirectRun` / `import.meta.url ===` 形式的守卫；
 *   - 顶层真的调用了 `main()`（自执行型套件）。
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const SELF = 'test-entrypoint-guard-test.mjs'
// test-all 直接运行的套件是**自执行**的（它们自己会跑断言），不需要入口守卫；
// 只有「被别的套件 import」的模块才需要 —— 否则守卫会把它们判成失败。
const testAllSource = readFileSync(path.join(scriptsDir, 'test-all.mjs'), 'utf8')
const directSuites = new Set(
  [...testAllSource.matchAll(/\['[^']+',\s*'([^']+\.mjs)'/g)].map((match) => match[1]),
)
const offenders = []
let checked = 0

for (const file of readdirSync(scriptsDir).filter((name) => name.endsWith('.mjs') && name !== SELF)) {
  if (directSuites.has(file)) continue
  const source = readFileSync(path.join(scriptsDir, file), 'utf8')
  if (!/export\s+async\s+function\s+verify/.test(source)) continue
  checked += 1
  const guarded = /exitIfDirectRun\(/.test(source)
    || /isDirectRun/.test(source)
    || /import\.meta\.url\s*===/.test(source)
    || /^main\(\)|^await main\(/m.test(source)
  if (!guarded) offenders.push(file)
}

assert.ok(checked >= 15, `只扫描到 ${checked} 个测试模块，明显少于预期`)
assert.deepEqual(offenders, [], `以下测试模块单独运行会零断言静默通过，请补 exitIfDirectRun 守卫：\n  ${offenders.join('\n  ')}`)

console.log(`ok  test-entrypoint-guard: ${checked} 个模块测试都有入口守卫（单独运行会失败而非假绿）`)
