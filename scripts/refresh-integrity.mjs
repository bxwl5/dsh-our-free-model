#!/usr/bin/env node
/**
 * 生成 / 校验 `catalog/integrity.json` —— 发布文件的字节数与 SHA-256 记录。
 *
 * 这个文件此前**漂移了 13 处且无人发现**：`catalog-test.mjs` 把它读进来后从未比较，
 * `publishedBytes()` 也被 import 却从未调用。现在：
 *
 *   node scripts/refresh-integrity.mjs            # 按 HEAD 重新生成
 *   node scripts/refresh-integrity.mjs --check    # 与 HEAD 比对，不一致就非零退出
 *
 * 口径（与 `.gitattributes` 的 `* text=auto eol=lf` 对齐）：取 **git blob** 的字节，
 * 再过一遍 `publishedBytes()` 把 CRLF 归一成 LF —— 用户下载到的就是这份字节。
 * 文件集合 = `package.json` + `files` 清单（目录自动展开）。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { publishedBytes } from './lib/published-bytes.mjs'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))
const target = path.join(root, 'catalog', 'integrity.json')

function git(args) {
  return execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })
}

/**
 * 计算发布文件集合的完整性记录。
 *
 * @param {{rev?: string}} [options]
 * @returns {{version: string, algorithm: string, files: Array<{path: string, size: number, sha256: string}>} | null}
 *   git 不可用时返回 `null`（调用方据此跳过，而不是把「没有 git」当成漂移）。
 */
export function computePublishedIntegrity(options = {}) {
  const rev = options.rev ?? 'HEAD'
  let listing
  try {
    listing = git(['ls-tree', '-r', '--name-only', rev]).toString('utf8').split('\n').filter(Boolean)
  } catch {
    return null
  }
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const wanted = (file) => file === 'package.json'
    || (pkg.files ?? []).some((entry) => file === entry || file.startsWith(`${String(entry).replace(/\/$/, '')}/`))
  const files = listing
    .filter(wanted)
    .sort()
    .map((file) => {
      const body = publishedBytes(git(['show', `${rev}:${file}`]))
      return { path: file, size: body.length, sha256: createHash('sha256').update(body).digest('hex') }
    })
  return { version: pkg.version, algorithm: 'sha256', files }
}

/** 统一序列化格式（2 空格 + 结尾换行），保证 `--check` 的字节比较稳定。 */
function format(record) {
  return `${JSON.stringify(record, null, 2)}\n`
}

/** 对比两份记录，返回人类可读的差异（空数组表示一致）。 */
export function diffIntegrity(expected, actual) {
  const diffs = []
  if (expected.version !== actual.version) diffs.push(`version ${expected.version} → ${actual.version}`)
  const byPath = new Map(actual.files.map((file) => [file.path, file]))
  for (const file of expected.files) {
    const found = byPath.get(file.path)
    if (found === undefined) { diffs.push(`记录多出（HEAD 已无此文件）：${file.path}`); continue }
    byPath.delete(file.path)
    if (found.size !== file.size || found.sha256 !== file.sha256) {
      diffs.push(`漂移：${file.path}（${file.size}→${found.size} 字节）`)
    }
  }
  for (const file of byPath.values()) diffs.push(`记录缺少：${file.path}`)
  return diffs
}

function main() {
  const check = process.argv.includes('--check')
  const record = computePublishedIntegrity()
  if (record === null) {
    if (check) { console.log('ok  integrity 校验跳过：git 不可用'); return }
    console.error('refresh-integrity: 生成需要 git')
    process.exitCode = 1
    return
  }
  if (check) {
    const current = JSON.parse(readFileSync(target, 'utf8'))
    const diffs = diffIntegrity(current, record)
    if (diffs.length > 0) {
      console.error(`integrity 与 HEAD 不一致（${diffs.length} 处）：`)
      for (const line of diffs.slice(0, 30)) console.error(`  - ${line}`)
      if (diffs.length > 30) console.error(`  …还有 ${diffs.length - 30} 处`)
      console.error('修法：node scripts/refresh-integrity.mjs')
      process.exitCode = 1
      return
    }
    console.log(`ok  integrity 与 HEAD 一致（${record.files.length} 个文件，version ${record.version}）`)
    return
  }
  writeFileSync(target, format(record), 'utf8')
  console.log(`integrity 已刷新：${record.files.length} 个文件，version ${record.version}`)
}

const isDirectRun = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isDirectRun) main()
