/**
 * 守卫：CodeArts 的上下文窗口必须**远端优先、本地兜底**，并与另外九家
 * 写进同一个目录（`model-catalogs/<provider>.json`）。
 *
 * ## 为什么
 *
 * 2026-11-04 用户问「这两家是远程获取不到吗」，对比 magpie 0.3.5 发现：
 * magpie 的 `parseModelInfo` 是
 *
 *     context: num(m.context_window) || CONTEXT_WINDOWS[base]
 *
 * 即**远端优先**；而我们只返回了 `{id, name, rate}`，把上游同一份响应里的
 * `context_window` / `max_tokens` 整块丢掉，容量永远只能查写死 5 条的表，
 * 表外模型一律落到宿主的 131072。
 *
 * 用户 2026-11-04 决定：「修。还是按照那 9 个一样的方式，获取到了，就写进本地。」
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')

export function verifyCodeArtsContextFromRemote() {
  // ① 解析层：远端字段必须被读取
  const models = read('vendor/channel-pack/src/models.ts')
  assert.match(models, /contextWindow\?: number/, 'RemoteModel 必须带 contextWindow')
  assert.match(models, /maxTokens\?: number/, 'RemoteModel 必须带 maxTokens')
  assert.match(models, /positiveNumber\(m\['context_window'\]\)/, "parseModelInfo 必须读上游 context_window")
  assert.match(models, /positiveNumber\(m\['max_tokens'\]\)/, "parseModelInfo 必须读上游 max_tokens")

  // ② 取用层：远端优先，本地表兜底
  const adapter = read('vendor/channel-pack/src/llm-adapter.ts')
  assert.match(
    adapter,
    /remoteModel\?\.contextWindow \?\? CONTEXT_WINDOWS\.get\(/,
    'resolveModel 必须「远端 contextWindow 优先，CONTEXT_WINDOWS 兜底」',
  )
  assert.doesNotMatch(
    adapter,
    /const contextWindow = CONTEXT_WINDOWS\.get\(normalizeModelId\(model\)\)\s*$/m,
    '不得退回「只查本地表」的旧写法',
  )

  // ③ 落盘层：与另外九家同一个目录
  assert.match(
    adapter,
    /writeModelCatalogClosingNew\(PROVIDER, models,/,
    'CodeArts 远端拉到后必须写进统一的 model-catalogs 目录',
  )
  assert.match(adapter, /readModelCatalog<RemoteModel>\(PROVIDER\)/, '重启后必须从统一目录恢复（含容量）')
  assert.match(adapter, /import \{ readModelCatalog, writeModelCatalogClosingNew \}/, '必须从 model-catalog-cache 导入')

  // ④ 刷新按钮那条路径也要落盘
  const service = read('vendor/channel-pack/src/service.ts')
  assert.match(
    service,
    /writeModelCatalogClosingNew\('codearts', models, pool\)/,
    '「重新获取模型」按钮也要写进统一目录',
  )

  console.log('ok  CodeArts 容量远端优先，并与另外九家写进同一个 model-catalogs 目录')
}

verifyCodeArtsContextFromRemote()
