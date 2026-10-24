/**
 * KukuAI 扫码登录**本地页**的端到端测试（不联网、不扫码）。
 *
 * 覆盖接线层：起本地页 → 页面内联二维码 → `/kuku/poll` 走「pending → confirmed」→
 * `result` 落定成凭据。上游用 `kuku-qr-selftest.mjs` 导出的假 passport 复刻真实形状。
 *
 * ⚠️ 必须用 undici 的 fetch：channel-pack-test 挂载期间把 globalThis.fetch 换成了
 * 「一律拒绝」的离线钩子，而这里要真的连 127.0.0.1。
 */
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { createFakePassport } from './kuku-qr-selftest.mjs'

function get(url) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: 'GET', timeout: 10_000 }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    request.on('timeout', () => { request.destroy(); reject(new Error(`请求超时：${url}`)) })
    request.end()
  })
}

export async function verifyKukuQrPage() {
  const page = await import('../vendor/channel-pack/src/kuku-qr-login-page.ts')
  const { fetch: realFetch } = await import('undici')
  const fake = createFakePassport(['pending', 'confirmed'])
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve))
  const passportBase = `http://127.0.0.1:${fake.server.address().port}`

  const started = await page.startKukuLoginFlow({ fetcher: realFetch, passportBase, timeoutMs: 15_000 })
  try {
    // 1) 页面：内联二维码 + 轮询路径
    const pageResponse = await get(started.loginUrl)
    assert.equal(pageResponse.status, 200)
    assert.match(pageResponse.text, /data:image\/png;base64,/, '页面必须内联二维码图片')
    assert.ok(pageResponse.text.includes(page.KUKU_LOGIN_PAGE_PATHS.poll), '页面必须带轮询路径')

    // 2) 轮询：第一次 pending，第二次 confirmed（假上游按 script 推进）
    const first = JSON.parse((await get(`${new URL(started.loginUrl).origin}${page.KUKU_LOGIN_PAGE_PATHS.poll}`)).text)
    assert.equal(first.state, 'pending')
    const second = JSON.parse((await get(`${new URL(started.loginUrl).origin}${page.KUKU_LOGIN_PAGE_PATHS.poll}`)).text)
    assert.equal(second.state, 'confirmed')

    // 3) 凭据落定：BDUSS/PTOKEN/STOKEN 都进了凭据串
    const credential = await started.result
    assert.match(credential.access_token, /BDUSS=/, '凭据必须带 BDUSS')
    assert.match(credential.access_token, /STOKEN=/, '凭据必须带 STOKEN')

    console.log('ok  kuku-qr-page: 本地页内联二维码 → pending → confirmed → 凭据落定（BDUSS/STOKEN）')
  } finally {
    await started.close()
    await new Promise((resolve) => fake.server.close(resolve))
  }
}

// 单独运行时必须失败（不能静默 exit 0）：见 scripts/lib/direct-run.mjs。
import { exitIfDirectRun } from './lib/direct-run.mjs'
exitIfDirectRun(import.meta.url, 'kuku-qr-page-test')
