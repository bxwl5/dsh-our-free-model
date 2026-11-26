// 把宿主侧需要的静态资源复制到 lib/。
//
// `tsc` 只编译 .ts，不会搬运 `.wasm`。而 package.json 的 files 只发布 `lib`，
// 因此 WASM 必须落到 lib/ 才能随插件分发。
import { copyFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')

/** 源 → 目标（相对 packageRoot）。 */
// 2026-11-26：源文件放在包根（本仓库发布的正是那一份，`pack.js` 运行时按
// `dirname(import.meta.url)` 在自身旁边解析它）。此前 `src/` 下还有一份**字节
// 完全相同**的副本（sha256 6419471e…），两份并存只会让人改错文件，已删除；
// 这里改成从包根取，重新 vendor 时把上游二进制放到包根即可。
const ASSETS = [
  ['qoder-auth-wasm.wasm', 'lib/qoder-auth-wasm.wasm'],
]

for (const [from, to] of ASSETS) {
  const source = resolve(packageRoot, from)
  if (!existsSync(source)) {
    throw new Error(`缺少构建资源 ${from}（Qoder 加密推理需要它；见 README）`)
  }
  const target = resolve(packageRoot, to)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(source, target)
  console.log(`Wrote ${target}`)
}
