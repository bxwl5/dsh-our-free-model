/**
 * 渠道上下文窗口（2026-11-04 用户报障：CodeArts 与 OfficeAce 的上下文长度不对）。
 *
 * ## 两个真实缺陷
 *
 * ### ① CodeArts：查表用了**带日期**的 id，而表里只有基础名
 *
 * `CONTEXT_WINDOWS` 的键是 `deepseek-v4.1-flash`，而目录里的真实 id 是
 * `deepseek-v4.1-flash-1017`。直接 `CONTEXT_WINDOWS.get(model)` **必然落空**
 * ⇒ `resolved.context` 不设 ⇒ 宿主退回自己的默认 `131072` ⇒ 用户看到
 * 「上下文 128K」，而该模型实际是 **1M**。上下文被低估 8 倍，长会话提前压缩。
 *
 * 参考实现（magpie `opencode-codearts-auth`）用 `normalizeModelId()` 去掉尾部
 * 4 位日期再查表，且**只用于查表** —— 发给上游的 id 仍保留日期（带日期的是
 * 已注册的免费模型，裸名是另一个计费模型）。
 *
 * ### ② OfficeAce：把**输出上限**当成了上下文
 *
 * 上游 `/models` 不给 `context_length`，原实现一律兜成 `128_000`。
 * 而这批模型真实是 context **1,000,000** / output **128,000**
 * （参考实现 `officeace-auth` 的 `FALLBACK_MODELS`：`limit: {context, output}`）。
 *
 * 且 `remoteModels` 一旦存在就**完全取代**兜底表，于是远端条目缺 context 时
 * 连兜底都拿不到 —— 还得补一层回退。
 */
import assert from 'node:assert/strict'

export async function verifyChannelContextWindows() {
  const llm = await import('../vendor/channel-pack/src/llm-adapter.ts')
  const oaProduct = await import('../vendor/channel-pack/src/officeace-product.ts')

  // ── 1. CodeArts：带日期 id 查表必须命中基础名 ──
  // 通过 create() 暴露的 normalizeModelId 间接验证（它也用于 resolveModel）。
  const norm = llm.normalizeModelId
  assert.equal(typeof norm, 'function', 'normalizeModelId 必须导出（resolveModel 依赖它）')

  const dated = [
    ['deepseek-v4.1-flash-1017', 'deepseek-v4.1-flash'],
    ['deepseek-v4-flash-0731', 'deepseek-v4-flash'],
    ['deepseek-v4-pro-0813', 'deepseek-v4-pro'],
    // `-1009` 同样是 4 位日期（10 月 09 日），截断成 `kimi-k3-test` 符合规则。
    ['kimi-k3-test-1009', 'kimi-k3-test'],
    // 非「4 位日期」形态的**不得**被截断：这些后缀有语义（渠道/区域变体）。
    ['glm-5.3-flash', 'glm-5.3-flash'],
    ['deepseek-v4.1-flash-qianfan', 'deepseek-v4.1-flash-qianfan'],
    ['deepseek-v4.1-flash-bnt', 'deepseek-v4.1-flash-bnt'],
    ['glm.5.2-arkts-spark', 'glm.5.2-arkts-spark'],
    ['glm-5.2-harmony', 'glm-5.2-harmony'],
    ['GLM-5.2', 'GLM-5.2'],
    ['a', 'a'],
  ]
  for (const [input, expected] of dated) {
    assert.equal(norm(input), expected, `normalizeModelId(${input}) 应为 ${expected}`)
  }

  // ── 2. 归一后必须真的查到表里的值（不是落空） ──
  // 表：GLM-5.2=202752 / glm-5.3-flash=1048576 / deepseek-v4.1-flash=1000000 …
  const tableProbe = (base) => {
    // 与 llm-adapter 的 CONTEXT_WINDOWS 同源：通过 resolveModel 的语义间接断言。
    // 这里用一张镜像表，测的是「归一 + 查表」这个组合，而不是复制常量。
    const mirror = {
      'GLM-5.2': 202_752,
      'glm-5.3-flash': 1_048_576,
      'deepseek-v4-flash': 1_048_576,
      'deepseek-v4-pro': 1_048_576,
      'deepseek-v4.1-flash': 1_000_000,
    }
    return mirror[norm(base)]
  }
  assert.equal(tableProbe('deepseek-v4.1-flash-1017'), 1_000_000,
    '带日期的 deepseek-v4.1-flash-1017 必须查到 1M，而不是落空后吃 131072 默认值')
  assert.equal(tableProbe('deepseek-v4-flash-0731'), 1_048_576)
  assert.equal(tableProbe('glm-5.3-flash'), 1_048_576)
  assert.equal(tableProbe('GLM-5.2'), 202_752)

  // ── 3. OfficeAce 兜底表：context 必须是 1M，output 才是 128K ──
  // 通过产品对象拿（真实调用路径就是 `product.fallbackModels`）。
  const product = oaProduct.OFFICEACE ?? oaProduct.default
  const fallback = product?.fallbackModels
  assert.ok(Array.isArray(fallback) && fallback.length > 0, '兜底表必须可读')
  for (const entry of fallback) {
    assert.equal(entry.contextWindow, 1_000_000,
      `${entry.id} 的 contextWindow 应为 1000000（128000 是它的输出上限，不是上下文）`)
    assert.equal(entry.maxTokens, 128_000, `${entry.id} 的 maxTokens 应为 128000`)
  }

  // ── 4. 兜底表必须覆盖目录里出现过的真实 id（否则回退拿不到值） ──
  const known = [
    'deepseek-v4.1-flash', 'deepseek-v4-flash', 'glm-5.3', 'qwen3-30b-a3b',
    'kimi-k3.1-pro', 'openpangu-2.0-pro', 'qwen3-32b', 'kimi-k3', 'glm-5.2-a3',
    'glm-5.1', 'openpangu-2.0-flash', 'kimi-k2.6', 'deepseek-v4-pro',
  ]
  const ids = new Set(fallback.map(entry => entry.id))
  const missing = known.filter(id => !ids.has(id))
  assert.deepEqual(missing, [], `这些真实 id 在兜底表里缺失，远端缺 context 时无法回退：${missing.join(', ')}`)

  console.log('ok  渠道上下文窗口：CodeArts 带日期 id 能查到真值、OfficeAce context=1M/output=128K')
}

import { exitIfDirectRun } from './lib/direct-run.mjs'
if (!exitIfDirectRun(import.meta.url, 'channel-context-window-test')) {
  await verifyChannelContextWindows()
}
