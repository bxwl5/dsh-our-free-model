/**
 * 守卫：异常汇总里的条目必须如实反映「现在」。
 *
 * 用户 2026-11-04：
 * > 异常列表界面，现在有两个是早就过了解封时间，还在列表里面
 *
 * 实测那两条是 `verification-blocked`（ZCode），根因两处：
 *  ① 后端把「被阻断的时刻」（过去）填进了 `resetAtMs`，而那是「解禁时刻」
 *     字段，界面照它渲染成解封时间 ⇒ 显示一个早就过去的时刻却迟迟不消失；
 *  ② 可见窗口是 24 小时，一条凌晨的记录能占满一整天。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')

export function verifyAnomalyExpiry() {
  // ① 类型：verification-blocked 有独立的「发生时刻」字段
  const types = read('vendor/channel-pack/src/types.ts')
  assert.match(types, /happenedAtMs\?: number/, '要有 happenedAtMs 承载「已经发生」的时刻')
  assert.match(types, /resetAtMs: number/, 'resetAtMs 保留（限流/风控仍用它表示解禁）')

  // ② 后端：无解封时间的错误按「发生时刻 + 1 小时」折算
  const rpc = read('vendor/channel-pack/src/channel-pack-rpc.ts')
  // 从常量声明切到条目 push 结束，覆盖「折算 → 判据 → 字段」整段
  const from = rpc.indexOf('const VERIFY_DEFAULT_COOLDOWN_MS')
  assert.ok(from > 0, '找不到 1 小时折算常量')
  const block = rpc.slice(from, rpc.indexOf('}', rpc.indexOf('happenedAtMs: verifyAt')) + 1)
  assert.match(block, /VERIFY_DEFAULT_COOLDOWN_MS = 60 \* 60 \* 1000/,
    '无解封时间的错误要按 1 小时折算')
  assert.match(block, /const verifyResetAt = verifyAt \+ VERIFY_DEFAULT_COOLDOWN_MS/,
    'resetAtMs 必须是「发生时刻 + 1 小时」，不能是发生时刻本身')
  assert.match(block, /resetAtMs: verifyResetAt/, '折算结果必须写进 resetAtMs')
  assert.match(block, /happenedAtMs: verifyAt/, '发生时刻仍要保留在 happenedAtMs')
  assert.match(block, /if \(verifyResetAt > now\)/, '过期条目必须不再列出')
  // ⚠️ 正是老 bug：把发生时刻直接当解封时间
  assert.doesNotMatch(block, /resetAtMs: 0/, '不得再置 0（那一列只有「解封时间」一种语义）')
  assert.doesNotMatch(block, /resetAtMs: verifyAt\b/, '不得把发生时刻直接当解封时间')

  // ③ 不再靠「24 小时发生过」判据
  assert.doesNotMatch(
    rpc,
    /verifyAt > 0 && now - verifyAt <= 24 \* 60 \* 60 \* 1000/,
    '不得退回 24 小时窗口（会让凌晨的记录挂满一天）',
  )

  // ④ 界面：解封时间一列统一读 resetAtMs，不再按 kind 分叉
  const client = read('client.js')
  assert.match(client, /absolute\(row\.resetAtMs\)/, '界面要渲染 resetAtMs')
  assert.doesNotMatch(client, /row\.kind === 'verification-blocked' \? '—' : remaining/,
    '验证受阻也要显示剩余时间（它现在有 1 小时冷却）')

  console.log('ok  异常条目：无解封时间的错误按「发生时刻 + 1 小时」显示，过期即从列表消失')
}

verifyAnomalyExpiry()
