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

// ── OfficeAce 续期判据的字段名守卫（2026-10-29 实测缺陷）──────────────────────
// 旧实现读 `expires_at`（OfficeAceCredential 里不存在，字段名是 `expire_time`），
// 导致 lead 窗口判据恒为 undefined ⇒ 每 30 分钟无条件续期、烧掉一次性
// refresh_token ⇒ 续期链被 1806 打死（现场：STS 停在 09:31，10 小时无人续期，
// 倍率/签到全部 APIG.0602）。这里做静态守卫，防止字段名再次写错。
{
  const indexSource = readFileSync(new URL('../vendor/channel-pack/src/index.ts', import.meta.url), 'utf8')
  const start = indexSource.indexOf('const refreshOfficeAceAccounts')
  assert.ok(start > 0, 'refreshOfficeAceAccounts 不见了')
  const block = indexSource.slice(start, start + 2000)
  assert.match(block, /expire_time/, 'OfficeAce 续期判据必须读 expire_time')
  assert.doesNotMatch(block, /\?\.expires_at/, 'OfficeAce 凭据没有 expires_at 字段（写错会让 lead 判据失效）')
  assert.match(block, /officeAceRefreshInFlight/, 'refresh_token 一次性轮换必须有并发去重闸')
  assert.match(block, /refresh_token \?\? ''/, '去重键必须是凭据身份（refresh_token）而不是渠道 id')
  console.log('ok  officeace 续期：判据读 expire_time、去重键用 refresh_token')
}
