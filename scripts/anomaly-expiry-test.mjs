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

  // ② 后端：verification 条目不得再把过去时刻塞进 resetAtMs
  const rpc = read('vendor/channel-pack/src/channel-pack-rpc.ts')
  const verifyBlock = rpc.slice(rpc.indexOf("kind: 'verification-blocked'"))
  const block = verifyBlock.slice(0, verifyBlock.indexOf('})') + 2)
  assert.match(block, /resetAtMs: 0/, 'verification-blocked 的 resetAtMs 必须置 0（没有解禁时间）')
  assert.match(block, /happenedAtMs: verifyAt/, '发生时刻必须走 happenedAtMs')

  // ③ 窗口收窄：不再是 24 小时
  assert.match(rpc, /VERIFY_VISIBLE_MS = 60 \* 60 \* 1000/, '验证受阻的可见窗口应为 1 小时')
  assert.doesNotMatch(
    rpc,
    /verifyAt > 0 && now - verifyAt <= 24 \* 60 \* 60 \* 1000/,
    '不得退回 24 小时窗口（会让凌晨的记录挂满一天）',
  )

  // ④ 界面：验证受阻显示「上次发生」，不是解封时间
  const client = read('client.js')
  assert.match(client, /row\.happenedAtMs \? absolute\(row\.happenedAtMs\)/, '界面要渲染 happenedAtMs')

  console.log('ok  异常条目：verification-blocked 不再伪装成「解禁时间」，可见窗口收窄到 1 小时')
}

verifyAnomalyExpiry()
