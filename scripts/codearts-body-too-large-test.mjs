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
  CODEARTS_INFERHUB_BODY_LIMIT_BYTES,
  isOverInferHubBodyLimit,
  codeartsInputModalities,
  isCodeArtsMultimodalModel,
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

// ── ⑤ 过了 APIG，还有 InferHub 自己的 10 MB（magpie 0.3.25，2026-11-25）──
check('⑤ InferHub 10 MB：只有「超体积 + 001001005」这一对才判成 413', () => {
  assert.equal(CODEARTS_INFERHUB_BODY_LIMIT_BYTES, 10 * 1000 * 1000, '十进制 10 MB，照 magpie 实测定值')
  const real = '{"error_code":"InferHub.001001005.400","error_msg":"The request param is invalid"}'
  // 实测对照：9.36 MB 正常回答，10.03 MB 被拒 —— 就是体积。
  assert.equal(isOverInferHubBodyLimit(9.36 * 1000 * 1000, real), false, '9.36 MB 不该判成过大')
  assert.equal(isOverInferHubBodyLimit(10.03 * 1000 * 1000, real), true, '10.03 MB + 001001005 = 体积问题')
  // ⚠️ 小体积的同码是**真参数错**，必须留给下游，不能冒充「太大」。
  assert.equal(isOverInferHubBodyLimit(64 * 1024, real), false, '小请求的 001001005 是参数错')
  assert.equal(isOverInferHubBodyLimit(20 * 1000 * 1000, 'InferHub.001001020.406 not multimodal'), false, '别的 InferHub 码不认')
  assert.equal(isOverInferHubBodyLimit(20 * 1000 * 1000, ''), false, '空报文不认')
})

check('⑤ 两道闸用**同一套**措辞，只有上限数字不同', () => {
  const inferhub = codeartsBodyTooLargeMessage(10.5 * 1000 * 1000, CODEARTS_INFERHUB_BODY_LIMIT_BYTES)
  const apig = codeartsBodyTooLargeMessage(20 * 1024 * 1024)
  assert.match(inferhub, /9\.5 MB/, 'InferHub 那道闸要报 10 MB（= 9.5 MiB）')
  assert.match(inferhub, /新开一个对话|减少.*图片/, '同样是可操作出路')
  assert.match(inferhub, /不需要重新登录/, '同样否认「登录过期」')
  assert.equal(inferhub.replace(/[\d.]+ MB/g, ''), apig.replace(/[\d.]+ MB/g, ''), '除数字外逐字一致，不许造第二套措辞')
})

// ── ⑥ 多模态白名单（magpie 0.3.25 的 MULTIMODAL，2026-11-23 实测）──
check('⑥ 只有白名单里的 5 个模型报 image，其余一律 text', () => {
  for (const id of ['deepseek-v4.1-flash-1017', 'glm-5.3-flash', 'deepseek-v4.1-flash', 'kimi-k3.1-pro', 'kimi-k3']) {
    assert.deepEqual(codeartsInputModalities(id), ['text', 'image'], id + ' 必须报 image')
    assert.equal(isCodeArtsMultimodalModel(id.toUpperCase()), true, id + ' 大小写不敏感')
  }
  for (const id of ['deepseek-v4-flash', 'deepseek-v4-pro', 'GLM-5.2', 'openpangu-2.0-flash', 'kimi-k2']) {
    assert.deepEqual(codeartsInputModalities(id), ['text'], id + ' 不得报 image（报了就等于谎报能力）')
  }
  // 带日期后缀的 id 按 normalizeModelId 也能命中白名单。
  assert.deepEqual(codeartsInputModalities('kimi-k3-1103'), ['text', 'image'], '日期后缀不改变能力')
})

if (failures > 0) console.error(`codearts-body-too-large-test: ${failures} failure(s)`)
else console.log('codearts-body-too-large-test: an oversized body is a 413, not a stale sign-in')
process.exitCode = failures > 0 ? 1 : 0
