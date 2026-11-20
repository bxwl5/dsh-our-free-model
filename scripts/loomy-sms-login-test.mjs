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
 */
import assert from 'node:assert/strict'
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

  console.log('ok  loomy 短信登录：归一/未发码/发码失败/冷却/成功路径')
}

exitIfDirectRun(import.meta.url, () => verifyLoomySmsLogin())
