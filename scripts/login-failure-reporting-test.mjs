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
  // 2026-10-30：去重逻辑从 refreshOfficeAceAccounts 抽到 refreshOneOfficeAceCredential
  // （定时轮与「用时续期」共用同一张 in-flight 表），守卫跟着新结构走。
  const start = indexSource.indexOf('const refreshOneOfficeAceCredential')
  assert.ok(start > 0, 'refreshOneOfficeAceCredential 不见了')
  const block = indexSource.slice(start, start + 1200)
  assert.match(block, /officeAceRefreshInFlight/, 'refresh_token 一次性轮换必须有并发去重闸')
  assert.match(block, /refresh_token \?\? ''/, '去重键必须是凭据身份（refresh_token）而不是渠道 id')

  // 字段名守卫：判据读 expire_time（不是不存在的 expires_at）
  const accounts = indexSource.slice(indexSource.indexOf('const refreshOfficeAceAccounts'), indexSource.indexOf('const refreshOfficeAceAccounts') + 1600)
  assert.match(accounts, /expire_time/, 'OfficeAce 续期判据必须读 expire_time')
  assert.doesNotMatch(accounts, /\?\.expires_at/, 'OfficeAce 凭据没有 expires_at 字段（写错会让 lead 判据失效）')

  // 用时续期必须存在且被适配器解析器调用（2026-10-30 修复点）
  //
  // 2026-10-30 二次修订：通用实现从 index.ts 的内联闭包**抽到
  // `src/expiry-sync.ts`**（`ensureCredentialFresh`）。原因是它内联时
  // **没有任何单测能覆盖**，静态守卫只断言「有这段代码」，于是
  // `pool.listAccounts(...).find(...)`（async 当同步用）一路活到线上，
  // 把一次性 refresh_token 烧成死链。现在行为契约由 credential-freshness
  // 用例真跑，这里只守「index.ts 确实接上了它」。
  const expirySource = readFileSync(new URL('../vendor/channel-pack/src/expiry-sync.ts', import.meta.url), 'utf8')
  assert.match(expirySource, /export async function ensureCredentialFresh/, '缺少用时续期通用实现（应在 expiry-sync.ts）')
  assert.match(indexSource, /import \{ ensureCredentialFresh, shouldRefreshNow \} from '\.\/expiry-sync\.js'/, 'index.ts 必须从 expiry-sync 引入用时续期')
  assert.match(indexSource, /ensureOfficeAceCredentialFresh\(/, 'OfficeAce 解析器必须走用时续期')
  assert.match(indexSource, /refreshOne: refreshOneAutoClawCredential/, 'AutoClaw 也必须走用时续期')
  console.log('ok  officeace/autoclaw 续期：expire_time 判据、refresh_token 去重键、用时续期已接入')
}
