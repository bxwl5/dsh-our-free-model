/**
 * 产物新鲜度门禁（2026-11-07 全码审查 t3-#11 / t4-C14）。
 *
 * 改了 src / client.js 忘重打包，是本仓库实际发生过的事故形态
 * （business.mjs 源哈希在 4 个中间提交里全部失配，7efc3e6 才补齐）。
 * 本套件把三道 --check 串起来，任一失败即 test-all 红：
 *   1. build-channel-pack --check      pack.js vs src
 *   2. build-standalone-channels --check  business.mjs vs src
 *   3. refresh-integrity --check       catalog/integrity.json vs HEAD 字节
 * 全部要求 esbuild/esbuild-bin 可用（与构建同一路径），vfat 环境走 ESBUILD_BINARY_PATH。
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
// 环境适配（2026-11-07 修复 CI 红）：
// - CI（ubuntu，root npm install）：esbuild 在 root/node_modules，build-channel-pack
//   的 require.resolve 候选（cwd/root）天然命中，**不需要**任何环境变量；
// - 本机 vfat：esbuild 包内二进制不可执行，必须 ESBUILD_BINARY_PATH 指向持久目录
//   原生件 + OFM_ESBUILD_DIR 指向 packages/standalone —— 仅在「本机特征」存在时注入
//   （硬编码 /home/kuye 路径进 CI 曾把门禁打红）。
const LOCAL_ESBUILD_BIN = '/home/kuye/Documents/deepseek-harness/esbuild-bin/esbuild-0.25.9'
const isLocalVfat = process.env.ESBUILD_BINARY_PATH !== undefined
  || (await import('node:fs')).existsSync(LOCAL_ESBUILD_BIN)
const BUILD_ENV = isLocalVfat
  ? {
      OFM_ESBUILD_DIR: path.join(root, 'packages/standalone'),
      ESBUILD_BINARY_PATH: process.env.ESBUILD_BINARY_PATH ?? LOCAL_ESBUILD_BIN,
    }
  : {}
const run = (label, cmd, args, env) => {
  try {
    execFileSync(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env }, timeout: 120_000 })
    console.log(`ok  ${label}`)
  } catch (error) {
    const out = `${error.stdout ?? ''}\n${error.stderr ?? ''}`.trim()
    throw new Error(`${label} 失败（exit ${error.status}）：${out.slice(0, 400)}`)
  }
}

run('pack.js 新鲜度', process.execPath, ['scripts/build-channel-pack.mjs', '--check'], BUILD_ENV)
run('business.mjs 新鲜度', process.execPath, ['scripts/build-standalone-channels.mjs', '--check'], BUILD_ENV)
run('integrity 新鲜度', process.execPath, ['scripts/refresh-integrity.mjs', '--check'], BUILD_ENV)
console.log('ok  artifact-freshness: 3 道产物门禁全部一致')
