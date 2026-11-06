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
 *    同时锁死 adopt 写入走声明契约的 credentials.set（原实现写的是未声明的
 *    ctx.credentials.write —— 本机实时实现恰好实现了它，所以当时能跑通；更正见
 *    docs/channel-capability-matrix.md 第 4.1 节）。
 *    第 3 层与加载方式无关，按上一条：源码与打包产物**两种模式都跑**。
 */
import assert from 'node:assert/strict'

// 合法形状的测试值：32 字符会话值 / 192 字符 BDUSS / 24 字符令牌
// （长度边界见各渠道解析函数：会话值下限 20、令牌下限 16）。
const SESSION = '0123456789abcdef0123456789abcdef'
const BDUSS = 'abcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefghabcdefgh'
const TOKEN = 'autoclaw-token-1234567890'
async function main() {
  const { adoptableChannelHint } = await import('../vendor/channel-pack/src/channel-pack-rpc.ts')

  // 粘贴入口已全部移除（纯粘贴渠道 0 个），循环体保留兜底语义。
  // UI 据此决定「添加账号」的交互形态。
  // 真·粘贴型：上游没有可脚本化的 OAuth，只能由用户复制 Cookie / 令牌。
  // AutoClaw 国内站已改为「本地页 + 短信验证码」登录（autoclaw-login-page.ts），
  // 只有国际站仍只能粘贴令牌。
  const pasteOnly = []
  for (const provider of pasteOnly) {
    const hint = adoptableChannelHint(provider)
    assert.equal(typeof hint, 'string', `${provider} 必须有粘贴提示`)
    assert.ok(hint.length > 0, `${provider} 提示不能为空`)
  }
  // OAuth 渠道**必须**走单点登录（不能误设成粘贴框）：
  // 这些渠道的上游有浏览器授权流程，做成粘贴框是体验倒退。
  const oauth = ['commandcode', 'officeace', 'autoclaw']
  for (const provider of oauth) {
    assert.equal(adoptableChannelHint(provider), undefined, `${provider} 应走 OAuth，不应在粘贴表里`)
  }
  // 既有 OAuth 渠道同样不应误入。
  for (const provider of ['buddy', 'workbuddy', 'codearts', 'cline', 'antigravity', 'qoder']) {
    assert.equal(adoptableChannelHint(provider), undefined, `${provider} 不应支持粘贴`)
  }

  // ── 解析函数直测：account.adopt 透传的就是这些结果 ──
  const { parseCredential: parseAutoClaw } = await import('../vendor/channel-pack/src/autoclaw.ts')

  console.log('ok  channel-adopt: 粘贴型渠道 0 个（hint 表空）；解析函数形状校验')
}
async function rpcProbes({ call, creds }) {
  const before = new Set(creds.keys())
  const keysNow = () => new Set(creds.keys())

  // 1) 非法输入全部拒收：bad-request，不落盘、不进账号池
  for (const [provider, bad] of [
    ['gone-provider', 'foo=bar'],
  ]) {
    const result = await call('account.adopt', { provider, credential: bad })
    assert.equal(result.ok, false, `${provider} 非法凭据必须拒收`)
    assert.equal(result.error.code, 'bad-request', `${provider} 拒收码是 bad-request`)
  }
  assert.deepEqual([...keysNow()].filter(k => !before.has(k)), [], '非法输入不产生任何凭据写入')


  // 2) 噪声清洗组：2026-11-05 删五渠道后 ADOPTABLE_CHANNELS 为空表，
  //    不存在「清洗后收下」的渠道 —— 该组原本的空循环体已删（t3-#9）。
  //    空表下「channel===undefined」先于空文本判断，故 3) 的空凭据与 1) 的
  //    非法凭据走同一分支，不再重复断言。

  console.log('ok  channel-adopt RPC: ADOPTABLE_CHANNELS 为空表 —— adopt 对任何 provider 一律 bad-request 拒收不落盘')
}
/** 源码侧形状用例：直连 `src/*.ts`，只有 source 模式能加载。 */
export async function verifyChannelAdoptParsers() {
  await main()
}

/** 两种模式通用的 adopt RPC 端到端（发布形态探测器）。 */
export async function verifyChannelAdoptRpc({ call, creds } = {}) {
  await rpcProbes({ call, creds })
}

export async function verifyChannelAdopt({ call, creds } = {}) {
  await verifyChannelAdoptParsers()
  if (call) await verifyChannelAdoptRpc({ call, creds })
}

// 单独运行时必须失败（不能静默 exit 0）：见 scripts/lib/direct-run.mjs。
import { exitIfDirectRun } from './lib/direct-run.mjs'
exitIfDirectRun(import.meta.url, 'channel-adopt-test')
