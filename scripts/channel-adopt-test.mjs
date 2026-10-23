/** 粘贴凭据渠道（account.adopt）：形状校验复用各渠道解析函数。 */
import assert from 'node:assert/strict'

async function main() {
  const { adoptableChannelHint } = await import('../vendor/channel-pack/src/channel-pack-rpc.ts')

  // 8 个粘贴型渠道都必须有提示文案（UI 据此决定「添加账号」的交互形态）。
  // 真·粘贴型：上游没有可脚本化的 OAuth，只能由用户复制 Cookie / 令牌。
  const pasteOnly = ['monkeycode', 'orcaterm', 'kuku', 'catpaw', 'autoclaw', 'autoclaw-intl']
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

  console.log('ok  channel-adopt: 6 个粘贴型渠道有提示；Command Code / OfficeAce / Accio 走 OAuth 不误入')
}

export async function verifyChannelAdopt() { await main() }
