/** 粘贴凭据渠道（account.adopt）：形状校验复用各渠道解析函数。 */
import assert from 'node:assert/strict'

async function main() {
  const { adoptableChannelHint } = await import('../vendor/channel-pack/src/channel-pack-rpc.ts')

  // 8 个粘贴型渠道都必须有提示文案（UI 据此决定「添加账号」的交互形态）。
  const expected = [
    'commandcode', 'monkeycode', 'orcaterm', 'kuku',
    'catpaw', 'autoclaw', 'autoclaw-intl',
    'accio', 'accio-cn', 'officeace',
  ]
  for (const provider of expected) {
    const hint = adoptableChannelHint(provider)
    assert.equal(typeof hint, 'string', `${provider} 必须有粘贴提示`)
    assert.ok(hint.length > 0, `${provider} 提示不能为空`)
  }
  // 不支持粘贴的渠道返回 undefined（UI 走原 OAuth 流程）。
  for (const provider of ['buddy', 'workbuddy', 'codearts', 'cline', 'gemini', 'looby']) {
    assert.equal(adoptableChannelHint(provider), undefined, `${provider} 不应支持粘贴`)
  }

  console.log('ok  channel-adopt: 10 个粘贴型渠道有提示，OAuth 渠道不误入')
}

export async function verifyChannelAdopt() { await main() }
