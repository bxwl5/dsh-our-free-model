/** Command Code 纯函数回归：凭据解析、鉴权头、授权 URL、额度归一。 */
import assert from 'node:assert/strict'

async function main() {
  const {
    parseWhoami, credentialFromWhoami, parseCredits, commandCodeBearerValue,
    isCredentialUsable, buildCommandCodeAuthUrl, parseCallbackCredentials,
  } = await import('../vendor/channel-pack/src/commandcode.ts')
  const { COMMANDCODE } = await import('../vendor/channel-pack/src/commandcode-product.ts')

  // ── whoami 解析 ──
  assert.deepEqual(parseWhoami({ userId: 'u1', userName: 'alice', email: 'a@b.c', keyName: 'cli', plan: 'pro' }), {
    userId: 'u1', userName: 'alice', email: 'a@b.c', keyName: 'cli', plan: 'pro',
  })
  // 驼峰/下划线两种命名都要认（上游未最终确定）。
  assert.deepEqual(parseWhoami({ user_id: 'u2', user_name: 'bob' }), {
    userId: 'u2', userName: 'bob', email: undefined, keyName: undefined, plan: undefined,
  })
  // 信封形状：`{ data: {...} }` / `{ data: { user: {...} } }` 都必须能认出来。
  // 用户报障「whoami 响应缺少 userId」就是早期只读顶层导致的。
  assert.equal(parseWhoami({ data: { userId: 'u3', userName: 'carol' } })?.userId, 'u3')
  assert.equal(parseWhoami({ data: { user: { id: 'u4', nickname: 'dave' } } })?.userName, 'dave')
  assert.equal(parseWhoami({ user: { user_id: 'u5' } })?.userId, 'u5')
  assert.equal(parseWhoami({ data: { uid: 'u6', display_name: 'erin' } })?.userId, 'u6')
  assert.equal(parseWhoami({ data: { account_id: 'u7' } })?.userId, 'u7')
  // 信封里也确实没有身份时仍返回 undefined。
  assert.equal(parseWhoami({ data: { ok: true } }), undefined)

  // 缺 userId = 无效凭据（不能当网络错误重试）。
  assert.equal(parseWhoami({ userName: 'no-id' }), undefined)
  assert.equal(parseWhoami(null), undefined)
  assert.equal(parseWhoami('string'), undefined)

  // ── credits 解析：真实响应形状（2026-10-24 实测）──
  // 上游返回 { credits: { freeCredits, monthlyCredits, purchasedCredits }, windowLimits }，
  // **没有** balance/limit/used。早期按通用形状猜的归一表一个都匹配不上，
  // 于是 parseCredits 恒 undefined → 用户看到「余额查询失败」。
  {
    const real = {
      credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 0, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: { limited: false, exceeded: null, fiveHour: null, weekly: null },
      sandboxAccess: false,
      sandboxMinutes: null,
    }
    const parsed = parseCredits(real)
    assert.ok(parsed !== undefined, '真实响应必须能解析（不能恒 undefined）')
    assert.equal(parsed.balance, 0, '三类积分之和为余额')
    assert.equal(parsed.currency, 'credits')
    assert.equal(parsed.limited, undefined, '未限流时不应带 limited')

    // 有额度时按来源求和
    const withCredits = parseCredits({
      credits: { freeCredits: 10, monthlyCredits: 200, purchasedCredits: 50 },
      windowLimits: { limited: false },
    })
    assert.equal(withCredits.balance, 260, '余额 = free + monthly + purchased')

    // 被窗口限流要单独标出来（与「额度为 0」不是一回事）
    const limited = parseCredits({ credits: { freeCredits: 5 }, windowLimits: { limited: true } })
    assert.equal(limited.limited, true)
    assert.equal(limited.balance, 5)

    // 信封包裹也要认
    assert.equal(parseCredits({ data: { credits: { freeCredits: 7 } } }).balance, 7)
    // 完全无关的响应仍返回 undefined（不编 0）
    assert.equal(parseCredits({ ok: true }), undefined)
  }

  // ── 凭据构造 ──
  const cred = credentialFromWhoami('key-abc', parseWhoami({ userId: 'u1', userName: 'alice', keyName: 'cli' }))
  assert.equal(cred.access_token, 'key-abc')
  assert.equal(cred.account_id, 'u1')
  assert.equal(cred.nickname, 'alice')
  assert.equal(cred.key_name, 'cli')
  assert.equal(typeof cred.created_at, 'number')

  // ── 鉴权头：标准 Bearer，不加前缀 ──
  assert.equal(commandCodeBearerValue({ access_token: 'key-abc' }), 'Bearer key-abc')

  // ── 凭据可用性 ──
  assert.equal(isCredentialUsable({ access_token: 'k' }), true)
  assert.equal(isCredentialUsable({ access_token: '' }), false)
  assert.equal(isCredentialUsable({ access_token: ' k ' }), false, '首尾空白视为不可用')
  assert.equal(isCredentialUsable(undefined), false)

  // ── 额度解析：宽松归一 ──
  assert.deepEqual(parseCredits({ balance: 100, limit: 500 }), {
    balance: 100, limit: 500, used: undefined, currency: undefined, resetAtMs: undefined,
  })
  // 别名与信封。
  assert.equal(parseCredits({ data: { credits: 42 } }).balance, 42)
  assert.equal(parseCredits({ remaining: 7 }).balance, 7)
  // 秒级时间戳抬到毫秒。
  assert.equal(parseCredits({ balance: 1, resetAt: 1_700_000_000 }).resetAtMs, 1_700_000_000_000)
  // 毫秒级原样保留。
  assert.equal(parseCredits({ balance: 1, resetAt: 1_700_000_000_000 }).resetAtMs, 1_700_000_000_000)
  // 完全无法得知 = undefined（不是 0 —— 两者对账号池决策不同）。
  assert.equal(parseCredits({ foo: 'bar' }), undefined)
  assert.equal(parseCredits(null), undefined)

  // ── 授权 URL ──
  const url = buildCommandCodeAuthUrl(COMMANDCODE, 5959, 'state-xyz')
  // 官方 CLI command-code@1.87.3 的 buildCommandAuthUrl 形状：
  // /studio/auth/cli + callback=http://127.0.0.1:<port>/callback + state + mode=redirect。
  assert.equal(
    url,
    'https://commandcode.ai/studio/auth/cli?callback=http%3A%2F%2F127.0.0.1%3A5959%2Fcallback&state=state-xyz&mode=redirect',
  )
  assert.ok(url.startsWith(COMMANDCODE.studioBase), '授权页挂在 studioBase 下')
  assert.ok(url.includes('/studio/auth/cli'), '旧 /cli/authorize 已 404，必须用新路径')
  assert.ok(!url.includes('localhost'), '回调主机固定 127.0.0.1（回调服务器只绑 IPv4）')

  // ── 回调载荷 ──
  const cb = parseCallbackCredentials({ apiKey: 'k', state: 's', userId: 'u', userName: 'n', keyName: 'cli' })
  assert.equal(cb.access_token, 'k')
  assert.equal(cb.account_id, 'u')
  assert.equal(cb.nickname, 'n')
  assert.equal(cb.key_name, 'cli')
  assert.equal(typeof cb.created_at, 'number')
  // 缺任一必填字段都必须拒绝。
  for (const bad of [
    { state: 's', userId: 'u' },
    { apiKey: 'k', userId: 'u' },
    { apiKey: 'k', state: 's' },
    { apiKey: '', state: 's', userId: 'u' },
  ]) {
    assert.equal(parseCallbackCredentials(bad), undefined, `拒绝不完整载荷: ${JSON.stringify(bad)}`)
  }

  // ── 产品配置自检 ──
  assert.equal(COMMANDCODE.id, 'commandcode')
  assert.equal(COMMANDCODE.apiBase, 'https://api.commandcode.ai')
  assert.ok(COMMANDCODE.fallbackModels.length > 0, '兜底目录不能为空')

  console.log('ok  commandcode: whoami/credits 宽松归一、标准 Bearer 头、授权 URL 与回调校验、产品配置自检')
}

export async function verifyCommandCode() {
  await main()
}
