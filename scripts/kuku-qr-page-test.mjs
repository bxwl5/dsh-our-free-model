/**
 * KukuAI 扫码登录**卡片内嵌流程**的端到端测试（不联网、不扫码）。
 *
 * 2026-10-30 改版：本地 127.0.0.1 弹窗页已删（远程浏览器打不开，NAS 场景必败），
 * 改为流程对象——二维码 data URL 直接进渠道卡片，poll/reload 由 DSH GET 路由驱动。
 * 本测试覆盖接线层：起流程 → poll「pending → confirmed」→ result 落定成凭据。
 * 上游用 `kuku-qr-selftest.mjs` 导出的假 passport 复刻真实形状。
 */
import assert from 'node:assert/strict'
import { createFakePassport } from './kuku-qr-selftest.mjs'

export async function verifyKukuQrPage() {
  const page = await import('../vendor/channel-pack/src/kuku-qr-login-page.ts')
  const { fetch: realFetch } = await import('undici')
  const fake = createFakePassport(['pending', 'confirmed'])
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve))
  const passportBase = `http://127.0.0.1:${fake.server.address().port}`

  const flow = await page.startKukuLoginFlow({ fetcher: realFetch, passportBase, timeoutMs: 15_000 })
  try {
    // 1) 二维码：data URL 直接可用（卡片 <img src>）
    assert.match(flow.qrDataUrl, /^data:image\/png;base64,/, '流程必须带内联二维码图片')
    assert.equal(flow.loginUrl, undefined, '卡片形态不再有本地页 URL')

    // 2) 轮询：第一次 pending，第二次 confirmed（假上游按 script 推进）
    const first = await flow.poll()
    assert.equal(first.state, 'pending')
    const second = await flow.poll()
    assert.equal(second.state, 'confirmed')

    // 3) 凭据落定：BDUSS/STOKEN 都进了凭据串
    const credential = await flow.result
    assert.match(credential.access_token, /BDUSS=/, '凭据必须带 BDUSS')
    assert.match(credential.access_token, /STOKEN=/, '凭据必须带 STOKEN')

    console.log('ok  kuku-qr-page: 卡片内嵌二维码 → pending → confirmed → 凭据落定（BDUSS/STOKEN）')
  } finally {
    await flow.close()
    await new Promise((resolve) => fake.server.close(resolve))
  }
}

// 单独运行时必须失败（不能静默 exit 0）：见 scripts/lib/direct-run.mjs。
import { exitIfDirectRun } from './lib/direct-run.mjs'
exitIfDirectRun(import.meta.url, 'kuku-qr-page-test')
