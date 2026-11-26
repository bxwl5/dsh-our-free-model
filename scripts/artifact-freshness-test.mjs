/**
 * 产物新鲜度门禁（2026-11-07 全码审查 t3-#11 / t4-C14）。
 *
 * 改了 src / client.js 忘重打包，是本仓库实际发生过的事故形态
 * （business.mjs 源哈希在 4 个中间提交里全部失配，7efc3e6 才补齐）。
 * 本套件把四道 --check 串起来，任一失败即 test-all 红：
 *   1. build-channel-pack --check        pack.js vs vendor/channel-pack/src
 *   2. build-standalone-channels --check business.mjs vs pack.js
 *   3. refresh-integrity --check         catalog/integrity.json vs HEAD 字节
 *   4. build-standalone-ui --check       packages/standalone/web vs frontend/
 *
 * ## 2026-11-26：这条门禁此前**在 CI 里恒为「跳过」**
 *
 * 证据（run 45524879215，offline job 日志）：
 *   `ok  pack.js 新鲜度 —— 跳过（环境无 esbuild，无法重建比对）`
 *   `ok  artifact-freshness: 3 道门禁 2 通过 / 1 跳过（无 esbuild 环境）`
 * 根因：第 1 道需要 esbuild，而 `package.json` 的 devDependencies **没有** esbuild、
 * CI 又用 `npm install --ignore-scripts` —— 永远装不出来，于是「跳过」把
 * 「改 src 忘重打包」这一类它本该拦的事故重新放行了。
 *
 * 现在的三处修法：
 *   · 第 4 道补上（`build-standalone-ui --check` 早就支持，却只有 CI 的另一个
 *     job 在用；本地 `npm test` 改了 `.tsx` 忘重跑 vite 也能全绿）。
 *   · esbuild / vite 的解析改成「就近找」：优先用户给的 `ESBUILD_BINARY_PATH`，
 *     其次 `packages/standalone/node_modules`（`npm ci --prefix packages/standalone`
 *     就能同时提供 esbuild 与 vite），最后才是维护机上的持久二进制。
 *   · **「跳过」在 CI 里算失败**：`process.env.CI` 存在时直接非零退出，坏环境
 *     不能再伪装成绿。本地没有工具链时仍然只跳过并说明（开发机不该被卡住）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const inCI = process.env.CI === 'true' || process.env.CI === '1'

/**
 * esbuild 解析（2026-11-26）。
 *
 * 三处细节必须一起处理，否则门禁会「假绿」或「假红」：
 *   1. **版本必须对得上**。pack.js 由 `packages/standalone/node_modules/esbuild`
 *      （0.25.9）打包，而 Vite 自带 `vite/node_modules/esbuild`（0.28.2）——
 *      两者用错一次就报 `Host version "x" does not match binary version "y"`。
 *   2. **模块与二进制是两件事**：`build-channel-pack.mjs` 用
 *      `require.resolve('esbuild', { paths })` 找模块，用 `ESBUILD_BINARY_PATH`
 *      找二进制；CI 里 `npm ci --prefix packages/standalone --ignore-scripts`
 *      只装得下模块与平台包，postinstall 不会把 `esbuild/bin/esbuild` 接到
 *      平台二进制上。
 *   3. **vfat 卷上的平台二进制没有执行位**，只能外挂维护机上的持久二进制。
 */
const LOCAL_BIN_DIR = '/home/kuye/Documents/deepseek-harness/esbuild-bin'
const standalone = path.join(root, 'packages/standalone')

const readVersion = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).version } catch { return undefined }
}
const esbuildVersion = readVersion(path.join(standalone, 'node_modules/esbuild/package.json'))
const viteVersion = readVersion(path.join(standalone, 'node_modules/vite/node_modules/esbuild/package.json'))

/** 某个 node_modules 下平台包里的原生二进制；不可执行（vfat）时返回 undefined。 */
function platformBinary(nodeModules) {
  const platformRoot = path.join(nodeModules, '@esbuild')
  try {
    for (const entry of fs.readdirSync(platformRoot)) {
      const candidate = path.join(platformRoot, entry, 'bin/esbuild')
      if ((fs.lstatSync(candidate).mode & 0o111) !== 0) return candidate
    }
  } catch { /* 没装：交给调用方兜底 */ }
  return undefined
}

/** 维护机持久目录里与版本同名的二进制（`esbuild-0.25.9`）。 */
function persistentBinary(version) {
  if (version === undefined) return undefined
  const named = path.join(LOCAL_BIN_DIR, `esbuild-${version}`)
  return fs.existsSync(named) ? named : undefined
}

/**
 * 为一次 check 组出环境：先给模块目录，再按版本给二进制。
 * @param {{ moduleDir?: string, nodeModules: string }} options
 */
function buildEnv({ moduleDir, nodeModules }) {
  const version = readVersion(path.join(nodeModules, 'esbuild/package.json'))
  const binary = process.env.ESBUILD_BINARY_PATH
    ?? platformBinary(nodeModules)
    ?? persistentBinary(version)
  return {
    ...(moduleDir === undefined ? {} : { OFM_ESBUILD_DIR: moduleDir }),
    ...(binary === undefined ? {} : { ESBUILD_BINARY_PATH: binary }),
  }
}

// pack.js / business.mjs / integrity 三道都要用「打 pack 的那份 esbuild」
const PACK_ENV = buildEnv({
  moduleDir: fs.existsSync(path.join(standalone, 'node_modules/esbuild')) ? standalone : undefined,
  nodeModules: path.join(standalone, 'node_modules'),
})
// 独立端页面由 Vite 构建，二进制必须是 Vite 自带的那份（版本可能不同）
const UI_ENV = buildEnv({ nodeModules: path.join(standalone, 'node_modules/vite/node_modules') })

/** 环境缺工具链时的统一口径：本地只跳过，CI 里算失败。 */
const skip = label => {
  const message = `${label} —— 跳过（环境无构建工具链，无法重建比对）`
  if (inCI) throw new Error(`${message}；CI 里不允许跳过，请先安装 packages/standalone 依赖`)
  console.log(`ok  ${message}`)
  return 'skipped'
}

const run = (label, cmd, args, env, missingPattern) => {
  try {
    execFileSync(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env }, timeout: 180_000 })
    console.log(`ok  ${label}`)
    return 'ok'
  } catch (error) {
    const out = `${error.stdout ?? ''}\n${error.stderr ?? ''}`.trim()
    if (missingPattern.test(out)) return skip(label)
    throw new Error(`${label} 失败（exit ${error.status}）：${out.slice(0, 400)}`)
  }
}

const results = [
  run('pack.js 新鲜度', process.execPath, ['scripts/build-channel-pack.mjs', '--check'], PACK_ENV,
    /esbuild is required|Cannot find module 'esbuild'/),
  run('business.mjs 新鲜度', process.execPath, ['scripts/build-standalone-channels.mjs', '--check'], PACK_ENV,
    /esbuild is required|Cannot find module 'esbuild'/),
  run('integrity 新鲜度', process.execPath, ['scripts/refresh-integrity.mjs', '--check'], PACK_ENV,
    /esbuild is required|Cannot find module 'esbuild'/),
  run('独立端页面新鲜度', process.execPath, ['scripts/build-standalone-ui.mjs', '--check'], UI_ENV,
    /Cannot find (module|package) 'vite'|ERR_MODULE_NOT_FOUND/),
]

/**
 * 版本一致性（2026-11-26）：桌面壳曾停在 2.5.4 长达 13 天，而 macOS workflow
 * 直接用它的版本号生成 release 标题 —— 从 2.5.7-priv.2 构建出的 dmg 自称 2.5.4。
 * 四个地方必须与根 package.json 同值；Cargo.lock 也要跟着（否则 cargo 会重写）。
 */
function assertVersionSync() {
  const rootVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  const desktop = JSON.parse(fs.readFileSync(path.join(root, 'packages/desktop/package.json'), 'utf8')).version
  const tauri = JSON.parse(fs.readFileSync(path.join(root, 'packages/desktop/src-tauri/tauri.conf.json'), 'utf8')).version
  const cargoToml = fs.readFileSync(path.join(root, 'packages/desktop/src-tauri/Cargo.toml'), 'utf8')
  const cargoLock = fs.readFileSync(path.join(root, 'packages/desktop/src-tauri/Cargo.lock'), 'utf8')
  const cargoVersion = /^version = "([^"]+)"/m.exec(cargoToml)?.[1]
  const lockVersion = /name = "ofm-desktop"\r?\nversion = "([^"]+)"/.exec(cargoLock)?.[1]
  const standalone = JSON.parse(fs.readFileSync(path.join(root, 'packages/standalone/package.json'), 'utf8')).version
  const mismatched = Object.entries({
    'packages/desktop/package.json': desktop,
    'packages/desktop/src-tauri/tauri.conf.json': tauri,
    'packages/desktop/src-tauri/Cargo.toml': cargoVersion,
    'packages/desktop/src-tauri/Cargo.lock': lockVersion,
    'packages/standalone/package.json': standalone,
  }).filter(([, value]) => value !== rootVersion)
  if (mismatched.length > 0) {
    throw new Error(`版本与根 package.json（${rootVersion}）不一致：${mismatched.map(([file, v]) => `${file}=${v}`).join('、')}`)
  }
  console.log(`ok  版本一致性：6 处均为 ${rootVersion}`)
}

assertVersionSync()

const skipped = results.filter(result => result === 'skipped').length
console.log(skipped === 0
  ? 'ok  artifact-freshness: 4 道产物门禁全部一致'
  : `ok  artifact-freshness: 4 道门禁 ${results.length - skipped} 通过 / ${skipped} 跳过（无构建工具链）`)