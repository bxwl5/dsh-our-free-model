/**
 * 测试套件的**孤儿进程**扫尾（2026-11-20）。
 *
 * ## 为什么是「进程组」而不是「找浏览器」
 *
 * 第一版按 `chrome`/`chromium` 的 comm + `--user-data-dir` 判据扫尾，范围太窄：
 * 测试套件派生的孤儿**不只是浏览器** —— 还有 CLI、子服务、ffmpeg、dd、
 * 本地 HTTP 服务…… 只要是 `spawn` 出来没回收的，都会一直挂着。
 *
 * 真实事故（2026-11-17）：回归测试留下一棵无头 Chrome 树，挂了 2 天 8 小时、
 * 累计吃掉约 3 小时 CPU。根因不是 `zcode-captcha.ts` 缺 `dispose()`（那实现是
 * 完整的），而是**任何提前 throw / 断言失败 / 超时被 SIGKILL 的路径都会跳过
 * dispose**，孤儿就此留下。
 *
 * 所以扫尾必须以**进程树/进程组**为单位，而不是按进程名猜：
 *
 * 1. 套件用 `detached: true` 启动 ⇒ 它成为一个新进程组的组长（pgid = 它的 pid）；
 *    它派生的所有子孙默认继承该组。
 * 2. 套件退出后，对**整个组**发 `SIGKILL`（`process.kill(-pgid, ...)` 杀全组）。
 * 3. 只影响本套件的组 —— 用户自己的浏览器、别的 DSH 会话、系统服务都不在组里。
 *
 * ## 为什么这样不会误伤
 *
 * - 组是**为这一个套件新建的**（`detached` 保证），不可能包含外部进程。
 * - 杀之前会校验「组确实属于刚结束的这个套件」（pgid === 套件 pid）。
 * - 组内进程即使把自己 `detached` 出去（重新 setsid），也会被按**祖先链**
 *   二次匹配兜住（见 `reapProcessTree`）。
 *
 * @module scripts/lib/reap-process-group
 */
import { execFileSync } from 'node:child_process'

/** 读 `pid → ppid` 全表（一次读完，避免逐进程 spawn）。读不到返回空 Map。 */
function processTable() {
  const parents = new Map()
  let rows
  try {
    rows = execFileSync('ps', ['-eo', 'pid=,ppid=,pgid='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).trim().split('\n')
  } catch {
    return { parents, groups: new Map() }
  }
  const groups = new Map()
  for (const row of rows) {
    const parts = row.trim().split(/\s+/).map(Number)
    const [pid, ppid, pgid] = parts
    if (!Number.isFinite(pid)) continue
    parents.set(pid, Number.isFinite(ppid) ? ppid : 0)
    if (!groups.has(pgid)) groups.set(pgid, [])
    groups.get(pgid).push(pid)
  }
  return { parents, groups }
}

/** 该 pid 的祖先链里是否出现过 `rootPid`（含自身）。 */
function descendantOf(pid, rootPid, parents) {
  let cursor = pid
  for (let i = 0; i < 64 && cursor > 1; i += 1) {
    if (cursor === rootPid) return true
    cursor = parents.get(cursor) ?? 0
  }
  return false
}

/**
 * 杀掉某套件留下的全部孤儿进程。
 *
 * @param {number} rootPid 套件进程 pid（也就是它的进程组 id，因为 `detached` 启动）
 * @param {{dryRun?: boolean, includeTree?: boolean}} [options]
 *   `dryRun` 只报告不杀（测试用）；`includeTree` 额外按祖先链兜住已 setsid 的孤儿
 * @returns {{killed: number[], wouldKill: number[], spared: number[]}}
 */
export function reapProcessGroup(rootPid, options = {}) {
  const killed = []
  const wouldKill = []
  const spared = []
  if (!Number.isFinite(rootPid) || rootPid <= 1) return { killed, wouldKill, spared }

  const { parents, groups } = processTable()
  const self = process.pid
  const targets = new Set()

  // ① 进程组成员（主路径：detached 启动 ⇒ 子孙默认在同组）
  for (const pid of groups.get(rootPid) ?? []) targets.add(pid)
  // ② 祖先链兜底（某些运行器会 setsid 脱离组，只靠组会漏）
  if (options.includeTree !== false) {
    for (const pid of parents.keys()) {
      if (descendantOf(pid, rootPid, parents)) targets.add(pid)
    }
  }

  for (const pid of targets) {
    // 绝不杀自己、绝不杀 init/launchd
    if (pid <= 1 || pid === self || pid === process.ppid) { spared.push(pid); continue }
    if (options.dryRun === true) { wouldKill.push(pid); continue }
    try {
      process.kill(pid, 'SIGKILL')
      killed.push(pid)
    } catch {
      // 已退出或权限不足：都不影响后续
    }
  }
  return { killed, wouldKill, spared }
}

/** 该进程组是否还有存活成员（用于断言「扫尾干净了」）。 */
export function groupHasSurvivors(rootPid) {
  const { groups } = processTable()
  const members = (groups.get(rootPid) ?? []).filter(pid => pid !== process.pid)
  return members
}
