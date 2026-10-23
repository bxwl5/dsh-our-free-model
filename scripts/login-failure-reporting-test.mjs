/**
 * 后台登录失败必须上报给前端（静态守卫）。
 *
 * 缺陷（2026-10-23 修）：17 个自动化渠道里只有 4 个（commandcode / officeace /
 * accio / gemini）把失败原因写进 `pendingLoginFailures`；其余 12 个只
 * `logger.warn` + 删除占位账号，于是前端 `login.poll` 恒返回 `{done:false}`，
 * 只能干等 10 分钟超时，用户永远看不到「端口被占 / 授权被拒 / 网络失败」。
 *
 * 本用例不跑网络，只做静态检查：**每一处 `background … login failed` 的 warn，
 * 后面几行内必须有 `recordLoginFailure(id, …)` 或 `pendingLoginFailures.set(id, …)`**。
 * 这样以后新增渠道分支忘了上报，会在回归里立刻变红。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../vendor/channel-pack/src/channel-pack-rpc.ts', import.meta.url), 'utf8')
const lines = source.split('\n')

assert.match(source, /const recordLoginFailure = /, '统一上报函数 recordLoginFailure 不见了')

const REPORT = /recordLoginFailure\(id,|pendingLoginFailures\.set\(id,/
const failures = []
let checked = 0

for (let index = 0; index < lines.length; index += 1) {
  if (!/background .*login failed for \$\{id\}/.test(lines[index])) continue
  checked += 1
  // 失败表态就在这条 warn 之后的几行内（各分支写法不同：有的先注释再 removeAccount）。
  const window = lines.slice(index + 1, index + 5).join('\n')
  if (!REPORT.test(window)) {
    failures.push(`${index + 1}: ${lines[index].trim().slice(0, 90)}`)
  }
}

assert.ok(checked >= 14, `只找到 ${checked} 处后台登录 catch，明显少于预期（14 处）`)
assert.deepEqual(failures, [], `以下分支只写日志、没有上报失败原因：\n${failures.join('\n')}`)

console.log(`ok  login-failure-reporting: ${checked} 处后台登录失败均会上报给 login.poll`)
