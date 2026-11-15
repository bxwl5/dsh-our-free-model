/**
 * 「账号没有免费通道」的两种报文都必须被认出来（magpie #905 / #1121）。
 *
 * 2026-11-15 用户报障原文：
 *   `codearts: The API does not exist or has not been published in the environment`
 *
 * 这句话听着像**路径打错 / API 未发布**，实际是：该账号没有开通 benefit
 * （免费额度）通道，网关把「benefit 环境不存在」回成了 APIG 的通用 404 文案。
 * 同一个模型**去掉签名的 `maas_type: benefit` 头**再发就是它的普通通道，正常作答。
 *
 * 我们的判据原来只认 `InferHub.4004.200` / `'4004'`，这一支缺失 ⇒ 原始报文
 * 直接抛给用户，一个字都没提它其实是「没开免费通道」。
 *
 * 锁定：
 *   ① `InferHub.APIG.0101.404` 与正文字面都被认出；
 *   ② 既有的 `4004` 两支仍为真（不回归）；
 *   ③ 无关错误码/正文一律为假（不许把真错误吞进「没免费通道」分支）。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const llm = 'data:text/javascript,' + encodeURIComponent(`export * from ${JSON.stringify(kernel)}
  export class LlmError extends Error { constructor(message, code, options) { super(message, options); this.code = code; this.status = options?.status } }`)

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-llm') return { url: llm, shortCircuit: true }
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    if (context.parentURL?.startsWith(sourceRoot) && specifier.endsWith('.js')) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href
      if (url.startsWith(sourceRoot) && fs.existsSync(fileURLToPath(url))) return { url, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(fs.readFileSync(fileURLToPath(url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: fileURLToPath(url),
      }).outputText,
    }
    return next(url, context)
  },
})

const { isNoBenefitChannelError } = await import('../vendor/channel-pack/src/llm-adapter.ts')

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

const REPORTER_TEXT = 'The API does not exist or has not been published in the environment'

check('① InferHub.APIG.0101.404 被认出（用户报障的确切报文）', () => {
  assert.equal(isNoBenefitChannelError('InferHub.APIG.0101.404', REPORTER_TEXT), true)
  // 只有码、正文被网关改写时也算
  assert.equal(isNoBenefitChannelError('InferHub.APIG.0101.404', ''), true)
})

check('① 只有正文字面（码被改写）也认得出', () => {
  assert.equal(isNoBenefitChannelError('', REPORTER_TEXT), true)
  assert.equal(isNoBenefitChannelError('APIGW.0101', REPORTER_TEXT), true)
  // 大小写不敏感
  assert.equal(isNoBenefitChannelError('', 'THE API DOES NOT EXIST OR HAS NOT BEEN PUBLISHED IN THE ENVIRONMENT'), true)
})

check('② 既有 4004 两支不回归', () => {
  assert.equal(isNoBenefitChannelError('InferHub.4004.200', 'benefit not found'), true)
  assert.equal(isNoBenefitChannelError('4004', ''), true)
})

check('③ 无关错误码与正文一律为假（不吞真错误）', () => {
  for (const [code, text] of [
    ['InferHub.002002009.404', 'model is not registered'],
    ['InferHub.4291.200', 'benefit exhausted'],
    ['InferHub.ModelArts.81111.429', 'TPM exceeded'],
    ['', 'the model does not exist'],          // 模型下架 ≠ 没免费通道
    ['', 'the container image does not exist'],
    ['', 'rate limit reached'],
    ['TM.00001041', 'concurrency limit'],
  ]) {
    assert.equal(isNoBenefitChannelError(code, text), false, `${code} / ${text} 不应被判为没免费通道`)
  }
})

if (failures > 0) console.error(`codearts-no-benefit-channel-test: ${failures} failure(s)`)
else console.log('codearts-no-benefit-channel-test: APIG.0101.404 is a missing free channel, not a wrong path')
process.exitCode = failures > 0 ? 1 : 0
