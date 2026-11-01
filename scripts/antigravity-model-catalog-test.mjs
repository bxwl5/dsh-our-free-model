/**
 * Antigravity 远端模型目录三项改动回归（2026-11-01 用户需求）：
 *
 * 1. **claude / gpt-oss 放行**：`parseGeminiAvailableModels` 不再只接 gemini- 前缀；
 *    `antigravityModelSpec` 对它们原样透传（`gpt-oss-120b-medium` 的 -medium 是名字的一部分）；
 *    `antigravityCanonicalModelId` 不剥非 gemini- 前缀的后缀。
 * 2. **分段族合并**：`gemini-3.8-flash-{low,medium,high}` 三条 → 单条
 *    `gemini-3.8-flash`（efforts 下拉 low/medium/high，无 tiered）。
 * 3. **剩余额度**：`remainingFraction` → `quotaFor` 的 percent 绿标。
 *
 * 取证基准：2026-11-01 探针实测（/tmp/ag-probe-*.py 系列）：
 * - claude-sonnet-4-6 / claude-opus-4-6-thinking / gpt-oss-120b-medium 推理 200；
 * - claude 工具回传要求 id 配对；Gemini 忽略 id 字段（带不带都 200）；
 * - claude 400：`max_tokens must be greater than thinking.budget_tokens`。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { exitIfDirectRun } from './lib/direct-run.mjs'

exitIfDirectRun(import.meta.url, 'antigravity-model-catalog-test')

/** 上游 fetchAvailableModels 实测响应的关键切片（2026-11-01 抓包）。 */
const UPSTREAM_SLICE = {
  models: {
    tab_jump_flash_lite_preview: { maxTokens: 16384, maxOutputTokens: 4096 },
    'chat_23310': { maxTokens: 32768 },
    'gemini-2.5-pro': {
      displayName: 'Gemini 2.5 Pro', recommended: true, supportsThinking: true, thinkingBudget: 1024,
      supportsImages: true, maxTokens: 1048576, maxOutputTokens: 65535,
      quotaInfo: { remainingFraction: 1, resetTime: '2026-11-01T15:59:58Z' },
    },
    'gemini-3.8-flash-medium': {
      displayName: 'Gemini 3.8 Flash (Medium)', recommended: true, supportsThinking: true,
      supportsImages: true, maxTokens: 1048576, maxOutputTokens: 65536,
      quotaInfo: { remainingFraction: 0.6, resetTime: '2026-11-08T10:59:58Z' },
    },
    'gemini-3.8-flash-low': {
      displayName: 'Gemini 3.8 Flash (Low)', recommended: true, supportsThinking: true,
      supportsImages: true, maxTokens: 1048576, maxOutputTokens: 65536,
      quotaInfo: { remainingFraction: 0.9 },
    },
    'gemini-3.8-flash-high': {
      displayName: 'Gemini 3.8 Flash (High)', recommended: true, supportsThinking: true,
      supportsImages: true, maxTokens: 1048576, maxOutputTokens: 65536,
      quotaInfo: { remainingFraction: 0.85 },
    },
    'gemini-3.8-flash-tiered': { supportsThinking: true, supportsImages: true, recommended: true, maxTokens: 1048576, maxOutputTokens: 65536 },
    'claude-sonnet-4-6': {
      displayName: 'Claude Sonnet 4.6 (Thinking)', recommended: true, supportsThinking: true, thinkingBudget: 1024,
      supportsImages: true, maxTokens: 250000, maxOutputTokens: 64000,
      quotaInfo: { remainingFraction: 0.85 },
    },
    'claude-opus-4-6-thinking': {
      displayName: 'Claude Opus 4.6 (Thinking)', recommended: true, supportsThinking: true, thinkingBudget: 1024,
      supportsImages: true, maxTokens: 250000, maxOutputTokens: 64000,
      quotaInfo: { remainingFraction: 0 },
    },
    'gpt-oss-120b-medium': {
      displayName: 'GPT-OSS 120B (Medium)', recommended: true, supportsThinking: true, thinkingBudget: 8192,
      maxTokens: 131072, maxOutputTokens: 32768,
      quotaInfo: { remainingFraction: 0.455 },
    },
  },
}

export async function verifyAntigravityModelCatalog() {
  const ag = await import('../vendor/channel-pack/src/antigravity.ts')
  const { parseGeminiAvailableModels, antigravityModelSpec, antigravityCanonicalModelId, matchSegmentSuffix } = ag

  const entries = parseGeminiAvailableModels(UPSTREAM_SLICE)
  const byId = new Map(entries.map((item) => [item.id, item]))

  // ── 1. 放行 ──
  assert.equal(byId.has('claude-sonnet-4-6'), true, 'claude-sonnet-4-6 必须在目录里')
  assert.equal(byId.has('claude-opus-4-6-thinking'), true, 'claude-opus-4-6-thinking 必须在目录里')
  assert.equal(byId.has('gpt-oss-120b-medium'), true, 'gpt-oss-120b-medium 必须在目录里')
  // 非 Gemini 条目档位表无 tiered（明确预算制，「自适应」语义弱）
  assert.deepEqual([...byId.get('claude-sonnet-4-6').effortOptions], ['low', 'medium', 'high'],
    'claude 档位表 = low/medium/high（无 tiered）')
  assert.deepEqual([...byId.get('gpt-oss-120b-medium').effortOptions], ['low', 'medium', 'high'])
  // 占位 id 仍然挡掉
  assert.equal(byId.has('tab_jump_flash_lite_preview'), false, '占位 tab_* 仍要挡')
  assert.equal(byId.has('chat_23310'), false, '占位 chat_* 仍要挡')

  // ── 2. 分段合并 ──
  for (const seg of ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high']) {
    assert.equal(byId.has(seg), false, `${seg} 应合并进主模型，不再独立出现`)
  }
  const merged = byId.get('gemini-3.8-flash')
  assert.notEqual(merged, undefined, '合并后的 gemini-3.8-flash 必须存在')
  assert.equal(merged.name, 'Gemini 3.8 Flash')
  assert.deepEqual([...merged.effortOptions], ['low', 'medium', 'high'], '合并条目档位下拉无 tiered')
  assert.equal(merged.maxTokens, 65536)
  assert.equal(merged.contextWindow, 1048576)
  assert.equal(merged.supportsImage, true)
  assert.equal(merged.remainingFraction, 0.6, 'remainingFraction 取族内最小（最保守）')
  assert.equal(byId.has('gemini-3.8-flash-tiered'), false, 'tiered 无 displayName，不进目录')

  // 非分段模型原样保留
  assert.equal(byId.get('gemini-2.5-pro')?.name, 'Gemini 2.5 Pro')

  // 缺一档不合并（只下发了 low+high → 两条独立透传）
  const partial = parseGeminiAvailableModels({
    models: {
      'gemini-x-low': { displayName: 'X (Low)', supportsThinking: true },
      'gemini-x-high': { displayName: 'X (High)', supportsThinking: true },
    },
  })
  assert.equal(partial.length, 2, '两档齐全度不足不合并，原样透传')
  assert.ok(partial.every((item) => item.id.startsWith('gemini-x-')), '未合并条目保留原始 id')

  // ── 2b. 同名消歧（用户报障「Gemini 3.5 Flash Lite 出现多个」）──
  // 上游把四个不同模型（modelVersion 各异，直连探针证实）都标成
  // 「Gemini 3.5 Flash Lite」。不能合并（丢模型），只消歧显示名：
  // 权威 id（agentModelSorts/mquery 引用的 gemini-3.5-flash-lite）保留原名。
  const dupPayload = {
    defaultAgentModelId: 'gemini-3.8-flash-high',
    agentModelSorts: [{ displayName: 'Recommended', groups: [{ modelIds: ['gemini-3.5-flash-lite'] }] }],
    mqueryModelIds: ['gemini-3.5-flash-lite'],
    webSearchModelIds: ['gemini-3.5-flash-lite'],
    models: {
      'gemini-3.5-flash-lite': { displayName: 'Gemini 3.5 Flash Lite', supportsThinking: true },
      'gemini-2.5-flash-lite': { displayName: 'Gemini 3.5 Flash Lite', supportsThinking: true },
      'gemini-2.5-flash': { displayName: 'Gemini 3.5 Flash Lite', supportsThinking: true },
      'gemini-2.5-flash-thinking': { displayName: 'Gemini 3.5 Flash Lite', supportsThinking: true },
      // 不同名条目不受影响
      'gemini-2.5-pro': { displayName: 'Gemini 2.5 Pro', supportsThinking: true },
    },
  }
  const disambiguated = parseGeminiAvailableModels(dupPayload)
  const dupById = new Map(disambiguated.map((item) => [item.id, item]))
  assert.equal(disambiguated.length, 5, '四个撞名模型全保留（不合并丢弃）')
  assert.equal(dupById.get('gemini-3.5-flash-lite')?.name, 'Gemini 3.5 Flash Lite',
    '权威 id（被推荐面引用）保留原名')
  assert.equal(dupById.get('gemini-2.5-flash-lite')?.name, 'Gemini 3.5 Flash Lite (2.5-flash-lite)')
  assert.equal(dupById.get('gemini-2.5-flash')?.name, 'Gemini 3.5 Flash Lite (2.5-flash)')
  assert.equal(dupById.get('gemini-2.5-flash-thinking')?.name, 'Gemini 3.5 Flash Lite (2.5-flash-thinking)')
  assert.equal(dupById.get('gemini-2.5-pro')?.name, 'Gemini 2.5 Pro', '非撞名条目不动')
  // 消歧只改 name：id 与能力字段（effortOptions）原样
  assert.deepEqual([...dupById.get('gemini-2.5-flash')?.effortOptions ?? []], ['low', 'medium', 'high', 'tiered'])

  // ── 2c. 真实抓包 fixture（scripts/antigravity-catalog-fixture.json，2026-11-01）──
  // 锁死消歧在**真实上游响应**上的输出；fixture 不在时不跑（CI 环境无此文件也绿）。
  try {
    const fixture = JSON.parse(readFileSync(new URL('./antigravity-catalog-fixture.json', import.meta.url), 'utf8'))
    const real = parseGeminiAvailableModels(fixture)
    const realById = new Map(real.map((item) => [item.id, item]))
    assert.equal(realById.get('gemini-3.5-flash-lite')?.name, 'Gemini 3.5 Flash Lite')
    assert.equal(realById.get('gemini-2.5-flash-lite')?.name, 'Gemini 3.5 Flash Lite (2.5-flash-lite)')
    assert.equal(realById.get('gemini-2.5-flash')?.name, 'Gemini 3.5 Flash Lite (2.5-flash)')
    assert.equal(realById.get('gemini-2.5-flash-thinking')?.name, 'Gemini 3.5 Flash Lite (2.5-flash-thinking)')
    // 消歧后不应再有同名重复
    const names = real.map((item) => item.name)
    assert.equal(new Set(names).size, names.length, '消歧后显示名无重复')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  // ── 3. 剩余额度 ──
  assert.equal(byId.get('claude-sonnet-4-6')?.remainingFraction, 0.85)
  assert.equal(byId.get('gpt-oss-120b-medium')?.remainingFraction, 0.455)

  // ── 4. canonical id：非 gemini 前缀不剥后缀 ──
  assert.equal(antigravityCanonicalModelId('gpt-oss-120b-medium'), 'gpt-oss-120b-medium',
    '-medium 是 gpt-oss 名字的一部分，绝不能剥')
  assert.equal(antigravityCanonicalModelId('gemini-3.8-flash-medium'), 'gemini-3.8-flash',
    'gemini- 前缀的分段名照旧剥')
  assert.equal(antigravityCanonicalModelId('gemini-3.8-flash-tiered'), 'gemini-3.8-flash')

  // ── 5. model spec：原样透传 + 档位 + claude 预算钳制 ──
  const gpt = antigravityModelSpec('gpt-oss-120b-medium', 'high')
  assert.equal(gpt.upstream, 'gpt-oss-120b-medium', 'gpt-oss 原样透传，不拼档位后缀')
  assert.equal(gpt.thinkingBudget, 10_000, 'high 档预算 10k（< 缺省 64k，claude 校验通过）')
  const claude = antigravityModelSpec('claude-sonnet-4-6', undefined)
  assert.equal(claude.upstream, 'claude-sonnet-4-6')
  assert.equal(claude.thinkingBudget, 4_000)
  // 实调踩过的 400：用户/网关传小 max_tokens（100）< 默认预算 4000 → 上游
  // `max_tokens must be greater than thinking.budget_tokens`。必须钳到 99。
  assert.equal(antigravityModelSpec('claude-sonnet-4-6', undefined, 100).thinkingBudget, 99,
    'maxOutputTokens=100 时预算钳到 99（严格小于）')
  assert.equal(antigravityModelSpec('claude-sonnet-4-6', 'high', 8192).thinkingBudget, 8_191,
    'high 档 10k > 8192 时也钳')
  assert.equal(antigravityModelSpec('claude-sonnet-4-6', 'high', 100_000).thinkingBudget, 10_000,
    'maxOutputTokens 足够大时预算原样')
  assert.equal(antigravityModelSpec('gemini-3.8-flash', 'high').upstream, 'gemini-3.8-flash-high')
  assert.equal(antigravityModelSpec('gemini-2.5-pro').upstream, 'gemini-2.5-pro')
  assert.throws(() => antigravityModelSpec('not-a-model'), /不在本 provider 目录中/)

  // ── 6. matchSegmentSuffix 不碰非 gemini 前缀 ──
  assert.equal(matchSegmentSuffix('gpt-oss-120b-medium'), undefined)
  assert.deepEqual(matchSegmentSuffix('gemini-3.8-flash-low'), { base: 'gemini-3.8-flash', segment: 'low' })

  // ── 7. 消息层 id 配对（claude/gpt-oss 必需；Gemini 无感）──
  const { translateGeminiRequest } = await import('../vendor/channel-pack/src/antigravity-messages.ts')
  const envelope = translateGeminiRequest({
    modelId: 'claude-sonnet-4-6',
    spec: { upstream: 'claude-sonnet-4-6', tier: 'medium', thinkingBudget: 4000, includeThoughts: true },
    messages: [
      { role: 'user', content: '计算 2+3' },
      { role: 'assistant', content: [
        { type: 'tool-call', id: 'gemini_tool_abc_0', name: 'calculator', arguments: '{"expr":"2+3"}' },
      ] },
      { role: 'tool', toolCallId: 'gemini_tool_abc_0', content: [{ type: 'text', text: '5' }] },
    ],
    project: 'aicode-consumers',
    requestId: 'agent/1/x',
  })
  const modelTurn = envelope.request.contents.find((c) => c.role === 'model')
  const toolTurn = envelope.request.contents.find((c) => c.role === 'user'
    && c.parts.some((p) => p.functionResponse !== undefined))
  assert.equal(modelTurn?.parts[0]?.functionCall?.id, 'gemini_tool_abc_0', 'functionCall 必须带本地 id')
  assert.equal(toolTurn?.parts[0]?.functionResponse?.id, 'gemini_tool_abc_0', 'functionResponse 必须带配对 id')
  assert.deepEqual(toolTurn?.parts[0]?.functionResponse?.response, { content: '5' })

  // ── 8. quotaFor：remainingFraction → percent 绿标 ──
  const { AntigravityAdapter } = await import('../vendor/channel-pack/src/antigravity-adapter.ts')
  const adapter = new AntigravityAdapter({
    product: { id: 'antigravity', displayName: 'Antigravity', defaultCredentialRef: 'gemini' },
    fetchRemoteModels: async () => entries,
  })
  // 触发一次完整加载（quotaFor 走 currentModels 同步读，必须先让远端目录进内存）。
  // listModels 需要 providerCatalogVisible；本用例无池 → 目录可见路径成立。
  const listed = await adapter.listModels('antigravity')
  assert.ok(listed.some((model) => model.id === 'claude-sonnet-4-6'), 'listModels 必须含 claude-sonnet-4-6')
  assert.ok(listed.some((model) => model.id === 'gpt-oss-120b-medium'), 'listModels 必须含 gpt-oss-120b-medium')
  assert.ok(!listed.some((model) => model.id === 'gemini-3.8-flash-medium'), '分段条目合并后不再单独列出')
  const mergedListed = listed.find((model) => model.id === 'gemini-3.8-flash')
  assert.notEqual(mergedListed, undefined, '合并主模型必须列出')
  assert.deepEqual(adapter.quotaFor('claude-sonnet-4-6'), { kind: 'remaining', amount: 85, unit: 'percent' })
  assert.deepEqual(adapter.quotaFor('gpt-oss-120b-medium'), { kind: 'remaining', amount: 46, unit: 'percent' })
  assert.deepEqual(adapter.quotaFor('claude-opus-4-6-thinking'), { kind: 'exhausted' }, 'remainingFraction=0 → 红标')
  assert.equal(adapter.quotaFor('gemini-2.5-pro')?.amount, 100, 'remainingFraction=1 → 100%')
}
