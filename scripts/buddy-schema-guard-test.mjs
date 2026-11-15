/**
 * WorkBuddy AI 的 deepseek-v4.1-flash-sg 拒绝带 REA surrogate 路径守卫的
 * 出站 tools schema（magpie 0.2.34 / #1080）：
 *
 *   "pattern": "^[^\uD800-\uDFFF]*$"
 *   → 400: invalid function call parameters   （任何工具都还没被调用就 400）
 *
 * magpie 的 fitSchema 把这个**精确字面量**从出站 schema 里删掉；其它 pattern、
 * 外层 allOf 与 REA 自己的校验都保留。
 *
 * 我们出站是**原样透传**（`buddy-adapter.ts` 的 `tools = options.tools?.map(...)`，
 * parameters 一字不动），实测探针确认守卫会带出去。本套件锁定清洗函数的判据：
 *   ① 该精确字面量被删除，其余字段不动；
 *   ② 嵌套位置（properties / items / anyOf / 嵌套对象）都清得到；
 *   ③ 其它 pattern 一律保留；
 *   ④ 非对象 / 数组根都不炸。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const llm = 'data:text/javascript,' + encodeURIComponent(`export * from ${JSON.stringify(kernel)}
  export class LlmError extends Error { constructor(m,c,o){super(m,o);this.code=c} }`)
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

const GUARD = '^[^\\uD800-\\uDFFF]*$'

let cleanToolsSchema
try {
  ;({ cleanToolsSchema } = await import('../vendor/channel-pack/src/buddy-adapter.ts'))
} catch (error) {
  console.error(`FAIL  导入 buddy-adapter — ${error.message}`)
  process.exit(1)
}

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

check('① 精确字面量被删，其余字段不动', () => {
  const schema = {
    type: 'object',
    properties: { path: { type: 'string', description: 'p', pattern: GUARD }, n: { type: 'number', minimum: 0 } },
    required: ['path'],
  }
  const out = cleanToolsSchema(structuredClone(schema))
  assert.equal(out.properties.path.pattern, undefined, '守卫必须被删')
  assert.equal(out.properties.path.description, 'p', 'description 必须保留')
  assert.equal(out.properties.n.minimum, 0, '相邻字段必须不动')
  assert.deepEqual(out.required, ['path'], 'required 不动')
})

check('② 嵌套位置都清得到', () => {
  const schema = {
    type: 'object',
    properties: {
      inner: {
        type: 'object',
        properties: { deep: { type: 'string', pattern: GUARD } },
        items: { type: 'array', items: { type: 'string', pattern: GUARD } },
        anyOf: [{ type: 'string', pattern: GUARD }, { type: 'number' }],
      },
    },
  }
  const out = cleanToolsSchema(structuredClone(schema))
  const inner = out.properties.inner
  assert.equal(inner.properties.deep.pattern, undefined, '嵌套 properties')
  assert.equal(inner.items.items.pattern, undefined, 'items 内')
  assert.equal(inner.anyOf[0].pattern, undefined, 'anyOf 内')
  assert.equal(inner.anyOf[1].type, 'number', 'anyOf 的另一个分支不动')
})

check('③ 其它 pattern 一律保留', () => {
  const schema = {
    type: 'object',
    properties: {
      a: { type: 'string', pattern: '^[a-z]+$' },
      b: { type: 'string', pattern: GUARD },
      c: { type: 'string', pattern: '^[^\\u0000-\\u001F]*$' },
    },
  }
  const out = cleanToolsSchema(structuredClone(schema))
  assert.equal(out.properties.a.pattern, '^[a-z]+$')
  assert.equal(out.properties.b.pattern, undefined, '只有精确字面量被删')
  assert.equal(out.properties.c.pattern, '^[^\\u0000-\\u001F]*$')
})

check('④ 非对象/数组根不炸；工具层包装不动', () => {
  assert.deepEqual(cleanToolsSchema({ type: 'string' }), { type: 'string' })
  assert.deepEqual(cleanToolsSchema([1, 2]), [1, 2])
  assert.equal(cleanToolsSchema(null), null)
  const tool = {
    type: 'function',
    function: {
      name: 'edit_file', description: 'd',
      parameters: { type: 'object', properties: { p: { type: 'string', pattern: GUARD } } },
    },
  }
  const [outTool] = cleanToolsSchema([tool])
  assert.equal(outTool.function.name, 'edit_file', '工具包装保留')
  assert.equal(outTool.function.parameters.properties.p.pattern, undefined, '工具参数内的守卫被删')
})

if (failures > 0) console.error(`buddy-schema-guard-test: ${failures} failure(s)`)
else console.log('buddy-schema-guard-test: the surrogate path guard never leaves the door')
process.exitCode = failures > 0 ? 1 : 0
