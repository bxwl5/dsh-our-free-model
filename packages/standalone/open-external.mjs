/**
 * ⚠️ 未接线的冗余实现（2026-11-18 审查确认）。
 *
 * 真正在跑的同类逻辑是插件端的 `src/open-external.js`（`index.js` 的
 * `externalUrl` 路由用它，由 `scripts/open-external-test.mjs` 覆盖）。
 * 本文件是独立版早期「由服务端拉起本机浏览器」设计的副本，但独立版
 * 最终采用了另一条路径：`login-terminal.mjs` 把令牌写进系统剪贴板，
 * 用户自己粘进网页。因此**没有任何代码 import 本模块**。
 *
 * 保留原因：`scripts/prepare-desktop.mjs` 的复制清单与
 * `scripts/pack-standalone.mjs` 的打包清单都列着它，删除需同步改三处
 * 并确认没有外部消费；收益（~1KB）低于改动风险。若将来要清理，
 * 一并删这三个清单项与文件本身。
 */
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

export async function openExternal(value, { platform = process.platform, exec = runFile, systemRoot = process.env.SystemRoot ?? 'C:\\Windows' } = {}) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false
  try {
    if (platform === 'win32') {
      const command = `Start-Process -FilePath '${url.href.replaceAll("'", "''")}' -ErrorAction Stop`
      await exec(path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 10000 })
    } else await exec(platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', [url.href], { timeout: 10000 })
    return true
  } catch { return false }
}
