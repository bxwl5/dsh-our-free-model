/**
 * 登录方式矩阵的漂移守卫。
 *
 * 三份东西必须始终一致，任一处改动忘了同步就在这里失败：
 *   1. `client.js` 的 `CHANNEL_PROVIDERS`（每张卡片的 `login` 字段 = 界面交互形态）；
 *   2. `vendor/channel-pack/src/channel-pack-rpc.ts` 的 `ADOPTABLE_CHANNELS`（真正走粘贴的渠道）；
 *   3. `docs/channel-login-methods.md` 的总表（人读的口径）。
 *
 * 纯静态解析，不起服务、不联网，故可放进默认回归。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

/** 界面声明：id → login（'browser' | 'browser+sms' | 'cookie' | 'token'）。 */
function parseClientLogins() {
  const source = read('client.js')
  const entries = [...source.matchAll(/\{ id: '([a-z0-9-]+)',[^\n]*?login: '([a-z+]+)'[^\n]*\}/g)]
  return new Map(entries.map(([, id, login]) => [id, login]))
}

/** 真正的粘贴表：只接受 account.adopt 的渠道。 */
function parseAdoptableChannels() {
  const source = read('vendor/channel-pack/src/channel-pack-rpc.ts')
  const match = /const ADOPTABLE_CHANNELS[^=]*=\s*\{([\s\S]*?)\n\}/.exec(source)
  assert.ok(match !== null, 'ADOPTABLE_CHANNELS 不见了')
  // 键可能带引号，两种写法都要认。
  return new Set([...match[1].matchAll(/^ {2}'?([a-z][a-z0-9-]*)'?: \{/gm)].map(([, id]) => id))
}

/** 文档总表：id → 一键档位（'✅' | '⚠️' | '❌'）。 */
function parseDocTiers() {
  const doc = read('docs/channel-login-methods.md')
  const tiers = new Map()
  for (const line of doc.split('\n')) {
    const cells = line.split('|').map(cell => cell.trim())
    if (cells.length < 6) continue
    const idMatch = /^`([a-z0-9-]+)`$/.exec(cells[2])
    if (idMatch === null) continue
    tiers.set(idMatch[1], cells[4])
  }
  return tiers
}

const CLIENT_TO_TIER = { browser: '✅', 'browser+sms': '⚠️', cookie: '❌', token: '❌', sms: '✅' }

const client = parseClientLogins()
const adoptable = parseAdoptableChannels()
const doc = parseDocTiers()

// ── 1) 界面声明本身：21 张卡片（2026-10-25 移除 autoclaw-intl），取值都在已知集合内 ──
assert.equal(client.size, 21, `CHANNEL_PROVIDERS 应为 21 条，实际 ${client.size}`)
for (const [id, login] of client) {
  assert.ok(CLIENT_TO_TIER[login] !== undefined, `${id} 的 login 取值未知：${login}`)
}

// ── 2) 粘贴表与会话/文档三方对齐 ──
// 纯粘贴渠道必须都在 ADOPTABLE_CHANNELS 里；反向允许 `sms` 渠道保留粘贴兜底
// （AutoClaw 的 appKey 是逆向常数，失效时用户仍可回到粘贴令牌）。
const pasteChannels = [...client].filter(([, login]) => login === 'cookie' || login === 'token').map(([id]) => id)
for (const id of pasteChannels) {
  assert.ok(adoptable.has(id), `${id} 是纯粘贴渠道，必须在 ADOPTABLE_CHANNELS 里`)
}
for (const id of adoptable) {
  const kind = client.get(id)
  assert.ok(
    kind === 'cookie' || kind === 'token' || kind === 'sms',
    `${id} 的 login='${kind}' 不应出现在粘贴表（只允许 cookie/token/sms）`,
  )
}

// ── 3) 文档覆盖：id 集合与界面一致，档位与 login 一致 ──
assert.deepEqual([...doc.keys()].sort(), [...client.keys()].sort(), '文档总表的渠道集合与 client.js 不一致')
for (const [id, login] of client) {
  assert.equal(doc.get(id), CLIENT_TO_TIER[login], `${id} 文档档位与 login='${login}' 不一致`)
}

// ── 4) 文档自报的统计必须和实际一致 ──
const counts = { '✅': 0, '⚠️': 0, '❌': 0 }
for (const tier of doc.values()) counts[tier] += 1
const stats = `一键 ${counts['✅']} / 半自动 ${counts['⚠️']} / 纯粘贴 ${counts['❌']}`
assert.ok(
  read('docs/channel-login-methods.md').includes(stats),
  `文档缺少与当前一致的统计行：${stats}`,
)

// 纯粘贴渠道必须给出「去官网登录 + 抄哪一段」的引导，否则用户不知道去哪拿 Cookie。
{
  const lines = read('client.js').split('\n')
  for (const provider of ['monkeycode', 'orcaterm']) {
    const line = lines.find((item) => item.includes(`id: '${provider}'`))
    assert.ok(line !== undefined, `${provider} 卡片必须存在`)
    assert.ok(line.includes('loginPage:'), `${provider} 必须带官网登录页链接`)
    {
      // 允许带说明（上游改过字段名时会在括号里注明旧名），只要求写了 cookieName。
      assert.ok(/cookieName: '[^']+'/.test(line), `${provider} 必须写明要复制的 Cookie 名`)
    }
  }
}

console.log(`ok  channel-login-methods: ${client.size} 渠道，${stats}；文档/界面/粘贴表三方一致`)
