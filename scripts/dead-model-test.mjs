/**
 * 「已失效模型」判定器（`isModelGoneError`）的文案回归。
 *
 * 用户 2026-11-18 报障：buddy 目录里 8 条 `service info not found` 的死模型一直
 * 挂在选择器里 —— 因为判定器认不出这个形态，`withDeadModelPruning` 从不落账，
 * `dead-models.json` 里一条都没有。本测试锁住该形态（以及**不该**被认下的邻居）。
 */
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const ts = (await import('typescript')).default
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.endsWith('.js')) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href
      if (fs.existsSync(fileURLToPath(url))) return { url, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) {
      const source = fs.readFileSync(fileURLToPath(url), 'utf8')
      return {
        format: 'module',
        source: ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
          fileName: fileURLToPath(url),
        }).outputText,
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})

const { isModelGoneError } = await import('../vendor/channel-pack/src/dead-model-store.ts')

let failed = 0
function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`ok  ${label}`)
  } else {
    failed += 1
    console.log(`FAIL ${label}: expected ${expected}, actual ${actual}`)
  }
}
const gone = (text) => isModelGoneError({ message: text })

console.log('--- 应当认下（真实抓到的文案，逐字） ---')
check('buddy glm-4.6', gone('当前模型不可用，请切换模型 model [glm-4.6] service info not found'), true)
check('buddy hunyuan', gone('当前模型不可用，请切换模型 model [hunyuan-2.0-thinking] service info not found'), true)
check('buddy 包装后（带渠道前缀）', gone('buddy: 当前模型不可用，请切换模型 model [glm-5.0] service info not found'), true)
check('传统 model not found', gone('model not found'), true)
check('标准 model_not_found 收尾', gone('request failed: model_not_found'), true)
check('model x does not exist', gone('The model gpt-5.6-astra does not exist'), true)

console.log('--- 不应当认下（会把可用模型藏 30 天） ---')
check(
  'Backend not supported（换套餐即恢复，刻意不认）',
  gone('模型配置异常，请切换其他模型 Backend [hunyuan-stream] is not supported'),
  false,
)
check('裸 service info not found（无模型主语）', gone('service info not found'), false)
check('账号级 401', gone('unauthorized: invalid token'), false)
check('限流', gone('rate limit exceeded for model gpt-5'), false)
check('额度用尽', gone('该模型额度已用尽'), false)
check('字段名式 model_not_found', gone('error_class=model_not_found, retry allowed'), false)
check('风控 3012', gone('上游风控拦截（3012 unusual activity）'), false)
check('无关句子里的 does not exist', gone('model x is fine. the container image does not exist'), false)

if (failed > 0) {
  console.log(`\ndead-model-test: ${failed} failure(s)`)
  process.exit(1)
}
console.log('\ndead-model-test: ok')