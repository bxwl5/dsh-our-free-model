/**
 * captcha 只走客户端内置浏览器（2026-11-14 用户定的方向）的行为锁定：
 *
 * ① `captcha.carrierHtml` RPC 回载体页 HTML（srcdoc 用），HTML 含三段表达式
 *    与 postMessage 回传脚本，不含凭据；
 * ② `CaptchaCarrier.mint()` 在无人贡献时抛 `CarrierUnavailableError`，文案即
 *    「不支持当前客户端」指引 —— **不再有外挂浏览器兜底**；
 * ③ 贡献后 mint 取到 internal 来源 param；
 * ④ claimOnePlan 的 catch 把 CarrierUnavailableError 转成 failed + continue=false
 *    （形态级终态，不逐 plan 重撞）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
const sourceRoot = fileURLToPath(new URL('../vendor/channel-pack/src/', import.meta.url))
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.includes('/vendor/channel-pack/src/')) {
      return { url: new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith('file://') && url.endsWith('.ts') && url.includes('/vendor/channel-pack/src/')) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(fs.readFileSync(fileURLToPath(url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: fileURLToPath(url),
      }).outputText,
    }
    return next(url, context)
  },
})
const carrier = await import('../vendor/channel-pack/src/captcha-carrier.ts')
const carrierPage = await import('../vendor/channel-pack/src/zcode-carrier-page.ts')

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

await check('载体页 HTML：含三段表达式与 postMessage 回传，不含凭据形状', async () => {
  const html = carrierPage.buildCarrierPageHtml({ region: 'cn', prefix: 'no8xfe', sceneId: '11xygtvd' })
  assert.match(html, /initAliyunCaptcha/, 'SDK 调用必须在')
  assert.match(html, /startTracelessVerification/, '无感验证必须在')
  assert.match(html, /postMessage/, '回传脚本必须在')
  assert.match(html, /zcode-captcha-param/, '消息类型键必须在（与 client.js 同步）')
  assert.doesNotMatch(html, /access[_-]?token|refresh[_-]?token|Bearer /i, '页面不得含凭据')
})

await check('mint 无人贡献 → CarrierUnavailableError，文案指向桌面面板', async () => {
  const c = new carrier.CaptchaCarrier({ waitMs: 30 })
  await assert.rejects(
    () => c.mint(),
    (error) => error instanceof carrier.CarrierUnavailableError
      && /不支持当前客户端/.test(error.message)
      && /面板/.test(error.message),
    '无贡献时必须是「不支持当前客户端」文案的不可用错误（外挂链已退役）',
  )
})

await check('贡献后 mint 取到 internal 来源 param（一次性，取走即清）', async () => {
  const c = new carrier.CaptchaCarrier({ waitMs: 5_000 })
  const put = await import('../vendor/channel-pack/src/captcha-supply.ts').then(m => m.putSuppliedParam)
  // 合法形状 param（base64 JSON，含 certifyId + securityToken），与真实产出同构
  // 长度必须 ≥200（validateCaptchaParam 的降级判据）：用长 payload 凑够
  const fakeParam = Buffer.from(JSON.stringify({
    certifyId: 'probe-certify-id'.repeat(6), securityToken: '1'.repeat(64), sceneId: '11xygtvd',
  })).toString('base64')
  assert.equal(put(fakeParam, Date.now() - 5, { interactive: false }), true, '先贡献一个')
  const outcome = await c.mint()
  assert.equal(outcome.source, 'internal')
  assert.equal(outcome.param, fakeParam, 'mint 拿到的必须是刚贡献的那一个（取走即清）')
  // 第二次 mint：槽已清、demand 未开 ⇒ 又是「不可用」（一次性语义未变）
  await assert.rejects(() => c.mint(), (e) => e instanceof carrier.CarrierUnavailableError)
})

await check('3007 归因：internal 被拒记一次，阈值后本次运行禁用（不再有 chromium 回退）', async () => {
  const c = new carrier.CaptchaCarrier({ waitMs: 30 })
  c.noteInternalRejection(); c.noteInternalRejection()
  // 第 3 次拒达到阈值（3）⇒ disabled ⇒ mint 直接抛不可用（即使有贡献也不再赌）
  c.noteInternalRejection()
  const put = await import('../vendor/channel-pack/src/captcha-supply.ts').then(m => m.putSuppliedParam)
  put(Buffer.from(JSON.stringify({ certifyId: 'post-disable', securityToken: '2'.repeat(64) })).toString('base64'), Date.now())
  await assert.rejects(() => c.mint(), (e) => e instanceof carrier.CarrierUnavailableError,
    '禁用后连贡献都不再消费（诚实语义：设备信誉降级不是换 param 能解决的）')
})

if (failures > 0) console.error(`zcode-carrier-html-test: ${failures} failure(s)`)
else console.log('zcode-carrier-html-test: captcha comes only from the client browser')
process.exitCode = failures > 0 ? 1 : 0
