/** Command Code 额度：耗尽判定与格式化，关键是区分「未知」与「零」。 */
import assert from 'node:assert/strict'
import http from 'node:http'

async function main() {
  const { readCredits, formatCredits } = await import('../vendor/channel-pack/src/commandcode-credits.ts')
  const { COMMANDCODE } = await import('../vendor/channel-pack/src/commandcode-product.ts')
  const { fetch: realFetch } = await import('undici')

  let payload = { balance: 500, limit: 1000, used: 500 }
  let status = 200
  const upstream = http.createServer((req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' }).end(JSON.stringify(payload))
  })
  await new Promise(r => upstream.listen(0, '127.0.0.1', r))
  const product = { ...COMMANDCODE, apiBase: `http://127.0.0.1:${upstream.address().port}` }
  const cred = { access_token: 'k' }

  try {
    // ── 正常 ──
    let snap = await readCredits(realFetch, product, cred)
    assert.equal(snap.balance, 500)
    assert.equal(snap.limit, 1000)
    assert.equal(snap.exhausted, false)

    // ── 明确耗尽：balance = 0 ──
    payload = { balance: 0, limit: 1000, used: 1000 }
    snap = await readCredits(realFetch, product, cred)
    assert.equal(snap.balance, 0)
    assert.equal(snap.exhausted, true, 'balance 为 0 才算耗尽')

    // ── used 达 limit ──
    payload = { limit: 1000, used: 1000 }
    snap = await readCredits(realFetch, product, cred)
    assert.equal(snap.exhausted, true, 'used 达 limit 也算耗尽')

    // ── 关键：查询失败 = undefined，不是「耗尽」 ──
    status = 500
    assert.equal(await readCredits(realFetch, product, cred), undefined, '查询失败返回 undefined')

    // ── 关键：字段未识别 = undefined，不是 0 ──
    status = 200
    payload = { foo: 'bar' }
    assert.equal(await readCredits(realFetch, product, cred), undefined, '无法识别字段时返回 undefined')

    // ── 有 balance 但没有 limit/used：仍然可用，且不判耗尽 ──
    payload = { balance: 42 }
    snap = await readCredits(realFetch, product, cred)
    assert.equal(snap.balance, 42)
    assert.equal(snap.exhausted, false, '只有 balance 时不能判耗尽')

    // ── 格式化 ──
    assert.equal(formatCredits(undefined), '额度暂不可查')
    assert.equal(formatCredits({ balance: 500, exhausted: false }), '剩余 500')
    assert.equal(formatCredits({ balance: 1500, currency: 'credits', exhausted: false }), '剩余 1.5K credits')
    assert.equal(formatCredits({ balance: 2_000_000, exhausted: false }), '剩余 2.0M')
    assert.equal(formatCredits({ limit: 1000, used: 1000, exhausted: true }), '已用 1.0K / 1.0K · 已耗尽')

    console.log('ok  commandcode-credits: 耗尽判定只在确证时成立，查询失败/字段未识别均返回 undefined 而非 0')
  } finally {
    upstream.closeAllConnections?.()
    await new Promise(r => upstream.close(r))
  }
}

export async function verifyCommandCodeCredits() {
  await main()
}
