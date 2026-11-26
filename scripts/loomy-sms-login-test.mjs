/**
 * Loomy 短信登录流程的回归钉子（2026-11-20）。
 *
 * ## 背景
 *
 * 微信扫码链路实测失效，用户定稿「只留短信登录」。本流程照 autoclaw 的
 * `AutoclawLoginFlow` 形状重写，成为 Loomy 唯一登录入口。
 *
 * 钉住四条语义：
 * 1. 手机号归一（`+86` / 空格 / 连字符）与非法输入拒绝
 * 2. **发码成功才记住手机号与 msgid**（否则 verify 会用一个没收到码的号码）
 * 3. 60s 冷却（防绕过 UI 狂刷上游短信）
 * 4. 未发码就 verify → 明确报「请先获取验证码」，而不是打上游
 * 5. **结束态守卫**（2026-11-26）：超时 / 关闭 / 已成功之后，`verify` 与
 *    `sendCode` 一律拒绝 —— 否则 `complete` 会真的换 session、写凭据落盘，
 *    出现「前端显示已取消，账号其实已登录」的分裂状态
 * 6. 运输层兜底是 `directFetch`（包内 undici + 出口层），不是裸全局 `fetch`
 *   （2026-11-21 的 `this.fetchImpl is not a function` 同类隐患）
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { exitIfDirectRun } from './lib/direct-run.mjs'

export async function verifyLoomySmsLogin() {
  const mod = await import('../vendor/channel-pack/src/loomy-sms-login.ts')
  const { RACCOON: _r, LOOMY } = await import('../vendor/channel-pack/src/loomy-product.ts')

  // ① 手机号归一
  assert.equal(mod.normalizeLoomyPhone('13800001111'), '13800001111')
  assert.equal(mod.normalizeLoomyPhone('+86 138 0000 1111'), '13800001111')
  assert.equal(mod.normalizeLoomyPhone('8613800001111'), '13800001111')
  assert.equal(mod.normalizeLoomyPhone('138-0000-1111'), '13800001111')
  assert.equal(mod.normalizeLoomyPhone('12345'), '', '非法号必须归一为空串')
  assert.equal(mod.normalizeLoomyPhone(''), '')

  // ② 未发码就 verify：不得打上游
  {
    let touched = 0
    const flow = mod.startLoomySmsLoginFlow({
      product: LOOMY,
      fetcher: async () => { touched += 1; throw new Error('不该发请求') },
      complete: async () => { throw new Error('不该走到登录') },
      timeoutMs: 50,
    })
    const out = await flow.verify('123456')
    assert.equal(out.ok, false)
    assert.match(out.message, /请先获取/, '未发码就校验必须给可读提示')
    assert.equal(touched, 0, '未发码时不得打上游')
    await flow.close()
  }

  // ③ 发码失败 → 不记住手机号，后续 verify 仍要求先发码
  {
    const flow = mod.startLoomySmsLoginFlow({
      product: LOOMY,
      // 发码返回非业务成功（缺 msgid）→ sendLoomySmsCode 抛错
      fetcher: async () => ({ status: 200, json: async () => ({ code: '999999', desc: '失败', data: {} }) }),
      complete: async () => { throw new Error('不该走到登录') },
      timeoutMs: 50,
    })
    const sent = await flow.sendCode('13800001111')
    assert.equal(sent.ok, false, '上游失败必须如实报错')
    const out = await flow.verify('123456')
    assert.equal(out.ok, false)
    assert.match(out.message, /请先获取/, '发码失败后不得记住手机号')
    await flow.close()
  }

  // ④ 冷却：同号第二次发码被拒，且不重复打上游
  {
    let calls = 0
    const flow = mod.startLoomySmsLoginFlow({
      product: LOOMY,
      fetcher: async () => {
        calls += 1
        return { status: 200, json: async () => ({ code: '000000', desc: '成功', data: { msgid: 'mid-1' } }) }
      },
      complete: async () => { throw new Error('不该走到登录') },
      timeoutMs: 50,
    })
    const first = await flow.sendCode('13800001111')
    assert.equal(first.ok, true, '首次发码应成功')
    assert.equal(calls, 1)
    const second = await flow.sendCode('13800001111')
    assert.equal(second.ok, false, '冷却期内第二次必须被拒')
    assert.match(second.message, /过于频繁/)
    assert.equal(calls, 1, '冷却期内不得重复打上游')
    await flow.close()
  }

  // ⑤ 完整成功路径：发码 → 校验 → result resolve
  {
    const flow = mod.startLoomySmsLoginFlow({
      product: LOOMY,
      fetcher: async () => ({ status: 200, json: async () => ({ code: '000000', desc: '成功', data: { msgid: 'mid-2' } }) }),
      complete: async (phone, code, msgid) => {
        assert.equal(phone, '13800001111')
        assert.equal(code, '123456')
        assert.equal(msgid, 'mid-2', 'msgid 必须与发码时的一致')
        return { access: '{"x":1}', expires: 123, ref: 'r', refreshable: false }
      },
      timeoutMs: 200,
    })
    const sent = await flow.sendCode('138 0000 1111')
    assert.equal(sent.ok, true)
    const out = await flow.verify('123456')
    assert.equal(out.ok, true)
    const result = await flow.result
    assert.equal(result.access, '{"x":1}', 'result 必须带出登录结果')
  }

  // ⑥ 超时 / 关闭 / 已成功之后，sendCode 与 verify 必须一律拒绝（2026-11-26）
  //
  // 真实缺陷：`verify` 不看 `settled`，超时或用户点「关闭」之后仍会真正执行
  // `options.complete(...)` —— 而它带副作用（换 session、写凭据落盘、回填账号池），
  // `settleOk` 只是把结果丢掉。前端显示「已取消」，账号其实已登录。
  {
    let completed = 0
    const flow = mod.startLoomySmsLoginFlow({
      product: LOOMY,
      fetcher: async () => ({ status: 200, json: async () => ({ code: '000000', desc: '成功', data: { msgid: 'mid-3' } }) }),
      complete: async () => {
        completed += 1
        return { access: '{}', expires: 1, ref: 'r', refreshable: false }
      },
      timeoutMs: 30,
    })
    assert.equal((await flow.sendCode('13800001111')).ok, true)
    await new Promise((resolve) => setTimeout(resolve, 80)) // 等超时真的发生
    const afterTimeout = await flow.verify('123456')
    assert.equal(afterTimeout.ok, false, '超时后 verify 必须失败')
    assert.match(afterTimeout.message, /登录流程已结束/, '超时后要给可读文案')
    assert.equal(completed, 0, '⚠️ 超时后不得真的完成登录（会写凭据落盘）')
    const sendAfterTimeout = await flow.sendCode('13800001111')
    assert.equal(sendAfterTimeout.ok, false, '⚠️ 超时后不得再发短信（真实副作用）')
    assert.match(sendAfterTimeout.message, /登录流程已结束/)
    await flow.close()
  }

  // ⑥-b 关闭之后同理
  {
    let completed = 0
    const flow = mod.startLoomySmsLoginFlow({
      product: LOOMY,
      fetcher: async () => ({ status: 200, json: async () => ({ code: '000000', desc: '成功', data: { msgid: 'mid-4' } }) }),
      complete: async () => {
        completed += 1
        return { access: '{}', expires: 1, ref: 'r', refreshable: false }
      },
      timeoutMs: 5_000,
    })
    assert.equal((await flow.sendCode('13800001111')).ok, true)
    await flow.close()
    const afterClose = await flow.verify('123456')
    assert.equal(afterClose.ok, false, '关闭后 verify 必须失败')
    assert.match(afterClose.message, /登录流程已结束/)
    assert.equal(completed, 0, '⚠️ 关闭后不得真的完成登录')
  }

  // ⑥-c 成功之后：同一流程不能二次发码/二次登录
  {
    let completed = 0
    let smsCalls = 0
    const flow = mod.startLoomySmsLoginFlow({
      product: LOOMY,
      fetcher: async () => {
        smsCalls += 1
        return { status: 200, json: async () => ({ code: '000000', desc: '成功', data: { msgid: 'mid-5' } }) }
      },
      complete: async () => {
        completed += 1
        return { access: '{}', expires: 1, ref: 'r', refreshable: false }
      },
      timeoutMs: 5_000,
    })
    assert.equal((await flow.sendCode('13800001111')).ok, true)
    assert.equal((await flow.verify('123456')).ok, true)
    await flow.result
    assert.equal(completed, 1, '成功路径只完成一次')
    assert.equal((await flow.verify('123456')).ok, false, '已成功后 verify 必须被拒')
    assert.equal(completed, 1, '⚠️ 已成功后不得再完成一次登录')
    assert.equal((await flow.sendCode('13800001111')).ok, false, '已成功后不得再发短信')
    assert.equal(smsCalls, 1, '⚠️ 已成功后不得再打上游')
  }

  // ⑦ 运输层兜底必须是 `directFetch`，不能是裸全局 `fetch`（2026-11-26）
  //
  // 背景：2026-11-21 的 `this.fetchImpl is not a function` 就是这类兜底的后果 ——
  // 宿主里全局 fetch 缺失/被改坏时，兜底本身就不存在。`directFetch` 走包内
  // undici + 出口层（尊重用户代理与插件出口），不读 `globalThis.fetch`。
  {
    const source = await readFile(new URL('../vendor/channel-pack/src/loomy-sms-login.ts', import.meta.url), 'utf8')
    assert.match(source, /import \{ directFetch \} from '\.\/direct-fetch\.js'/, '必须引入 directFetch')
    assert.match(source, /options\.fetcher \?\? directFetch/, '兜底必须是 directFetch')
    assert.equal(source.includes('options.fetcher ?? fetch'), false, '⚠️ 不允许裸 `?? fetch` 兜底')
  }

  console.log('ok  loomy 短信登录：归一/未发码/发码失败/冷却/成功路径/结束态守卫/传输兜底')
}

exitIfDirectRun(import.meta.url, () => verifyLoomySmsLogin())
