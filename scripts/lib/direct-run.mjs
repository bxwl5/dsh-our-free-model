/**
 * 「只能被汇总套件 import」的测试模块的入口守卫。
 *
 * ## 为什么需要
 *
 * 这些文件只 `export async function verifyXxx()`，由 `channel-pack-test.mjs --source`
 * （或其它汇总套件）import 后调用。它们的依赖是**动态 import 的 .ts 源码**，所以直接
 * `node scripts/xxx-test.mjs` 时一个断言都不会跑 —— 却会**静默 exit 0**，看起来像通过。
 * 本仓库已经踩过两次（`commandcode-auth-test`、`accio-test`）。
 *
 * ## 用法
 *
 * ```js
 * import { exitIfDirectRun } from './lib/direct-run.mjs'
 * exitIfDirectRun(import.meta.url, 'channel-adopt-test')
 * ```
 *
 * 被汇总套件 import 时 `process.argv[1]` 是汇总脚本本身，本函数不动（返回 false）；
 * 直接运行时打印可执行提示并置 `exitCode = 1`，让「零断言」不再伪装成成功。
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * @param {string} importMetaUrl - 调用方的 `import.meta.url`。
 * @param {string} name - 用于提示的文件名（不含 `.mjs`）。
 * @returns {boolean} 是否判定为「被直接运行」。
 */
export function exitIfDirectRun(importMetaUrl, name) {
  if (process.argv[1] === undefined) return false
  if (importMetaUrl !== pathToFileURL(path.resolve(process.argv[1])).href) return false
  console.error(`${name}: 这是被汇总套件 import 的模块测试，单独运行不会执行任何断言。`)
  console.error('请改用：node scripts/channel-pack-test.mjs --source（或对应的汇总套件）')
  process.exitCode = 1
  return true
}
