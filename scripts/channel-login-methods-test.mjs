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

/**
 * 文档总表：id → 一键档位（'✅' | '⚠️' | '❌'）。
 *
 * 顺带钉住表体列数：以前 `antigravity` 那行多写了一个 `|`，把旁注挤成第 9 列，
 * 而旧解析只看前几列，所以档位照样对得上、漂移却没人发现 —— 这里改成
 * 「表体每行的 `|` 段数必须等于表头」。
 */
function parseDocTiers(doc) {
  const lines = doc.split('\n')
  const headerIndex = lines.findIndex(line => /^\|\s*#\s*\|\s*provider\s*\|/.test(line))
  assert.ok(headerIndex !== -1, '文档总表表头（`| # | provider | … |`）不见了')
  const headerSegments = lines[headerIndex].split('|').length
  const tiers = new Map()
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.startsWith('|')) break
    const cells = line.split('|')
    assert.equal(
      cells.length,
      headerSegments,
      `文档总表第 ${index + 1} 行的 \`|\` 段数（${cells.length}）与表头（${headerSegments}）不一致：${line.slice(0, 80)}`,
    )
    const idMatch = /^`([a-z0-9-]+)`$/.exec(cells[2].trim())
    if (idMatch === null) continue
    tiers.set(idMatch[1], cells[4].trim())
  }
  return tiers
}

/**
 * 正文里自报的渠道数字必须等于渠道总数。
 *
 * 只认三种明确口径，避免误伤「12 个渠道原先失败只写日志」「22/22 渠道可见」这类
 * 讲别的事的句子；每种口径至少要出现一次，防止统计句被整段删掉。
 */
const CHANNEL_COUNT_PATTERNS = [
  { pattern: /(\d+)\s*个账号渠道/g, phrase: '「N 个账号渠道」' },
  { pattern: /(\d+)\s*个的登录/g, phrase: '「N 个的登录」' },
  { pattern: /共\s*(\d+)\s*个渠道/g, phrase: '「共 N 个渠道」' },
]

function assertDocChannelCounts(doc, total) {
  let hits = 0
  for (const { pattern, phrase } of CHANNEL_COUNT_PATTERNS) {
    for (const [, digits] of doc.matchAll(pattern)) {
      hits += 1
      assert.equal(Number(digits), total, `文档里的 ${phrase} 写成 ${digits}，渠道总数是 ${total}`)
    }
  }
  assert.ok(hits > 0, '文档里找不到任何「N 个账号渠道 / N 个的登录」式统计句，首句或统计行被删了')
}

const CLIENT_TO_TIER = { browser: '✅', 'browser+sms': '⚠️', cookie: '❌', token: '❌', sms: '✅' }

const client = parseClientLogins()
const adoptable = parseAdoptableChannels()
const docSource = read('docs/channel-login-methods.md')
const doc = parseDocTiers(docSource)

// ── 1) 界面声明本身：15 张卡片（2026-11-05 起五渠道移除），取值都在已知集合内 ──
assert.equal(client.size, 15, `CHANNEL_PROVIDERS 应为 15 条，实际 ${client.size}`)
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
assert.ok(docSource.includes(stats), `文档缺少与当前一致的统计行：${stats}`)

// ── 5) 正文自报的渠道数字必须等于渠道总数（口径来自 client.js 的 CHANNEL_PROVIDERS）──
assertDocChannelCounts(docSource, client.size)

console.log(`ok  channel-login-methods: ${client.size} 渠道，${stats}；文档/界面/粘贴表三方一致，正文数字与表体列数已钉住`)
