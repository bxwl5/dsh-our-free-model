/**
 * 粘贴凭据渠道（account.adopt）：形状校验复用各渠道解析函数。
 *
 * 三层用例：
 * 1. hint 注册表（UI 交互形态）；
 * 2. 解析函数直测 —— RPC 透传的就是这些函数的结果，这里锁死
 *    「RPC 层不另写判据」：合法收下、非法拒绝、噪声清洗后收下；
 * 3. RPC 端到端（仅在有 mount 环境时，由 channel-pack-test.mjs 传入
 *    { call, creds }）：非法凭据必须 bad-request 拒收且不落盘、不进账号池；
 *    噪声凭据清洗后收下，落盘值即清洗值，账号池有条目。
 *    同时锁死 adopt 写入走 host 契约的 credentials.set（原实现误写成
 *    ctx.credentials.write —— 真实 host 没有该方法，adopt 落不了盘）。
 */
import assert from 'node:assert/strict'

// 合法形状的测试值：32 字符会话值 / 192 字符 BDUSS / 24 字符令牌
// （长度边界见各渠道解析函数：会话值下限 20、令牌下限 16）。
const SESSION = '0123456789abcdef0123456789abcdef'
const BDUSS = 'abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh'
const TOKEN = 'autoclaw-token-1234567890'

async function main() {
  const { adoptableChannelHint } = await import('../vendor/channel-pack/src/channel-pack-rpc.ts')

  // 5 个粘贴型渠道都必须有提示文案（UI 据此决定「添加账号」的交互形态）。
  // 真·粘贴型：上游没有可脚本化的 OAuth，只能由用户复制 Cookie / 令牌。
  const pasteOnly = ['monkeycode', 'orcaterm', 'kuku', 'autoclaw', 'autoclaw-intl']
  for (const provider of pasteOnly) {
    const hint = adoptableChannelHint(provider)
    assert.equal(typeof hint, 'string', `${provider} 必须有粘贴提示`)
    assert.ok(hint.length > 0, `${provider} 提示不能为空`)
  }
  // OAuth 渠道**必须**走单点登录（不能误设成粘贴框）：
  // 这些渠道的上游有浏览器授权流程，做成粘贴框是体验倒退。
  const oauth = ['commandcode', 'officeace', 'accio', 'accio-cn']
  for (const provider of oauth) {
    assert.equal(adoptableChannelHint(provider), undefined, `${provider} 应走 OAuth，不应在粘贴表里`)
  }
  // 既有 OAuth 渠道同样不应误入。
  for (const provider of ['buddy', 'workbuddy', 'codearts', 'cline', 'gemini', 'qoder']) {
    assert.equal(adoptableChannelHint(provider), undefined, `${provider} 不应支持粘贴`)
  }

  // ── 解析函数直测：account.adopt 透传的就是这些结果 ──
  const { normalizeCookie: normalizeMonkeyCode } = await import('../vendor/channel-pack/src/monkeycode.ts')
  const { normalizeCookie: normalizeOrcaTerm } = await import('../vendor/channel-pack/src/orcaterm.ts')
  const { normalizeCookie: normalizeKuku } = await import('../vendor/channel-pack/src/kuku.ts')
  const { parseCredential: parseAutoClaw } = await import('../vendor/channel-pack/src/autoclaw.ts')

  // monkeycode：合法收下 / 噪声清洗后收下 / 非法拒绝
  assert.equal(normalizeMonkeyCode(`nebula_session=${SESSION}`), `nebula_session=${SESSION}`)
  assert.equal(normalizeMonkeyCode(`  Cookie: "nebula_session=${SESSION}; Path=/; HttpOnly"`), `nebula_session=${SESSION}`)
  assert.equal(normalizeMonkeyCode('nebula_session=abc'), undefined)
  assert.equal(normalizeMonkeyCode('foo=bar'), undefined)
  // orcaterm
  assert.equal(normalizeOrcaTerm(`ot_session=${SESSION}; x=1`), `ot_session=${SESSION}; x=1`)
  assert.equal(normalizeOrcaTerm(`Bearer ot_session=${SESSION}`), `ot_session=${SESSION}`)
  assert.equal(normalizeOrcaTerm('ot_session=abc'), undefined)
  assert.equal(normalizeOrcaTerm('foo=bar'), undefined)
  // kuku
  assert.equal(normalizeKuku(`BDUSS=${BDUSS}; STOKEN=x`), `BDUSS=${BDUSS}; STOKEN=x`)
  assert.equal(normalizeKuku(`Cookie: BDUSS=${BDUSS}; Path=/`), `BDUSS=${BDUSS}`)
  assert.equal(normalizeKuku('BDUSS=short'), undefined)
  assert.equal(normalizeKuku('foo=bar'), undefined)
  // autoclaw（autoclaw 与 autoclaw-intl 共用 parseCredential）
  assert.equal(parseAutoClaw({ token: TOKEN }).access_token, TOKEN)
  assert.equal(parseAutoClaw({ token: `Bearer ${TOKEN}` }).access_token, TOKEN)
  assert.equal(parseAutoClaw({ token: 'abc' }), undefined)
  assert.equal(parseAutoClaw({}), undefined)

  console.log('ok  channel-adopt: 5 个粘贴型渠道有提示；解析函数合法/非法/噪声输入形状校验')
}

/** account.adopt RPC 端到端（需要 channel-pack-test.mjs 的 mount 环境）。 */
async function rpcProbes({ call, creds }) {
  const before = new Set(creds.keys())
  const keysNow = () => new Set(creds.keys())

  // 1) 非法输入全部拒收：bad-request，不落盘、不进账号池
  for (const [provider, bad] of [
    ['monkeycode', 'nebula_session=abc'],
    ['orcaterm', 'foo=bar'],
    ['kuku', 'BDUSS=short'],
    ['autoclaw', 'abc'],
    ['autoclaw-intl', 'Bearer "x'],
  ]) {
    const result = await call('account.adopt', { provider, credential: bad })
    assert.equal(result.ok, false, `${provider} 非法凭据必须拒收`)
    assert.equal(result.error.code, 'bad-request', `${provider} 拒收码是 bad-request`)
  }
  assert.deepEqual([...keysNow()].filter(k => !before.has(k)), [], '非法输入不产生任何凭据写入')

  // 2) 噪声输入清洗后收下：落盘值即清洗值，账号池有条目
  for (const [provider, noisy, expectedToken] of [
    ['monkeycode', `  Cookie: "nebula_session=${SESSION}; Path=/; HttpOnly"`, `nebula_session=${SESSION}`],
    ['orcaterm', `Bearer ot_session=${SESSION}\r\n`, `ot_session=${SESSION}`],
    ['kuku', `Cookie: BDUSS=${BDUSS}; Path=/`, `BDUSS=${BDUSS}`],
    ['autoclaw', `Bearer ${TOKEN}`, TOKEN],
    ['autoclaw-intl', `  "${TOKEN}"  `, TOKEN],
  ]) {
    const result = await call('account.adopt', { provider, credential: noisy })
    assert.equal(result.ok, true, `${provider} 噪声凭据清洗后应收下：${JSON.stringify(result)}`)
    assert.ok(result.value.accountId, `${provider} adopt 返回 accountId`)
    const prefix = `${provider.toUpperCase().replace(/-/g, '_')}_ACCOUNT_`
    const ref = [...keysNow()].find(k => !before.has(k) && k.startsWith(prefix))
    assert.ok(ref, `${provider} adopt 后应写入 ${prefix}* 凭据 ref`)
    const stored = JSON.parse(creds.get(ref).value)
    assert.equal(stored.access_token, expectedToken, `${provider} 落盘凭据应为清洗后的值`)
    const accounts = (await call('account.list', { provider })).value.accounts
    const adopted = accounts.find(a => a.credentialRef === ref)
    assert.ok(adopted, `${provider} adopt 后账号池有条目`)
    assert.equal(adopted.enabled, true, 'adopt 的账号默认启用')
    before.add(ref) // 后续渠道的 diff 基线纳入已验证的 ref
  }

  // 3) 空凭据：RPC 层最小判据（空文本）直接拒绝
  const empty = await call('account.adopt', { provider: 'monkeycode', credential: '   ' })
  assert.equal(empty.ok, false)
  assert.equal(empty.error.code, 'bad-request')

  console.log('ok  channel-adopt RPC: 非法凭据 bad-request 拒收不落盘；噪声清洗后收下且落盘为清洗值；账号池有条目')
}

export async function verifyChannelAdopt({ call, creds } = {}) {
  await main()
  if (call) await rpcProbes({ call, creds })
}
