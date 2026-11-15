/**
 * CodeArts 大请求体（APIG 签名上限 12 MB）不得被误判成「登录过期」。
 *
 * 2026-11-15 对齐 magpie opencode-codearts-auth 0.3.20（#1121）：
 * 华为 APIG 只能签 12 MB 以内的 body，超过时回的是一条**看起来像鉴权失败**的
 * 401 —— `calc ak sk signature fail:body too large`。原实现三条判据
 * （`status === 401` / `APIG.0301` / `signature fail`）全都命中它，于是：
 *   白刷一次凭据（IAM 往返 + token 轮换）→ 重试同一个超大 body → 再吃网关
 *   ~30 秒延迟 → 抛 AUTH → DSH 渲染成「API 密钥无效」→ 用户去重新登录。
 *
 * 锁定四件事：
 *   ① 该报文被 `isBodyTooLargeError` 认出（401/403/413 三种状态）；
 *   ② `isAuthError` 对它返回 **false**（不再触发刷凭据）；
 *   ③ 其它真正的鉴权报文行为**逐字不变**（401 空体、APIG.0602、签名失败）；
 *   ④ 文案给出可操作出路且**明说不需要重新登录**。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// ⚠️ sourceRoot 必须是 **URL 形式**（`.href`，百分号编码），与钩子收到的
//    `url` 同一套编码；用 fileURLToPath 的本地路径做前缀永远匹配不上
//    含中文/空格的工作区路径，钩子会静默失效。
const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
// 宿主内核的桩：既有离线测试共用同一份（schemastery 的 default 等）。
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const llm = 'data:text/javascript,' + encodeURIComponent(`export * from ${JSON.stringify(kernel)}
  export class LlmError extends Error { constructor(message, code, options) { super(message, options); this.code = code; this.status = options?.status } }`)

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-llm') return { url: llm, shortCircuit: true }
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    // 只把**仍在 vendor/channel-pack/src 下**的 .js 重写成 .ts：
    // `llm-register-compat.ts` 有 `../../../src/image-pricing.js` 这类上跳引用，
    // 目标是仓库根的编译产物，改 .ts 会 ENOENT。
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

const {
  isAuthError,
  isBodyTooLargeError,
  codeartsBodyTooLargeMessage,
  CODEARTS_MAX_SIGNABLE_BODY_BYTES,
} = await import('../vendor/channel-pack/src/llm-adapter.ts')

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

// APIG 的真实报文（magpie 0.3.20 逐字引用）
const REAL_401 = '{"error_code":"APIG.0301","error_msg":"calc ak sk signature fail:body too large"}'

check('① 401/403/413 三种状态都能认出 body too large', () => {
  for (const status of [401, 403, 413]) {
    assert.equal(isBodyTooLargeError(status, REAL_401), true, `HTTP ${status} 应认出`)
  }
  // 大小写与空白不敏感
  assert.equal(isBodyTooLargeError(401, 'BODY   TOO   LARGE'), true)
})

check('① 非 401/403/413 状态不认（避免把 400 的别的原因吃掉）', () => {
  assert.equal(isBodyTooLargeError(400, 'body too large'), false)
  assert.equal(isBodyTooLargeError(500, 'body too large'), false)
})

check('② isAuthError 对 body too large 返回 false（不再刷凭据）', () => {
  assert.equal(
    isAuthError(401, REAL_401), false,
    '这条 401 必须**不**被当成鉴权失败 —— 否则白刷凭据 + 重试超大 body',
  )
})

check('③ 真正的鉴权报文行为逐字不变', () => {
  assert.equal(isAuthError(401, ''), true, '裸 401 仍是鉴权')
  assert.equal(isAuthError(403, 'APIG.0602 Invalid token'), true, 'APIG.0602 仍是鉴权')
  assert.equal(isAuthError(200, 'signature fail'), true, '签名失败文案仍是鉴权')
  assert.equal(isAuthError(403, 'TM.00000001 网络繁忙'), false, '上游繁忙不是鉴权')
  assert.equal(isAuthError(403, 'InferHub.002002009 model is not registered'), false, '无权不是鉴权')
})

check('④ 文案给出可操作出路，且明说不需要重新登录', () => {
  const text = codeartsBodyTooLargeMessage(20 * 1024 * 1024)
  assert.match(text, /20\.0 MB/, '要报出实际体量')
  assert.match(text, /12 MB/, '要点明上限')
  assert.match(text, /新开一个对话|减少.*图片/, '要给可操作出路')
  assert.match(text, /不需要重新登录/, '必须明确否认「登录过期」这个误判')
})

check('④ 上限常量就是 12 MiB', () => {
  assert.equal(CODEARTS_MAX_SIGNABLE_BODY_BYTES, 12 * 1024 * 1024)
})

if (failures > 0) console.error(`codearts-body-too-large-test: ${failures} failure(s)`)
else console.log('codearts-body-too-large-test: an oversized body is a 413, not a stale sign-in')
process.exitCode = failures > 0 ? 1 : 0
