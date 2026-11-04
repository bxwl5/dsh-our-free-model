/**
 * SSE 收尾残余：末条事件**不带尾换行**时不得丢帧。
 *
 * ## 真实缺陷（2026-11-04 全仓审查发现）
 *
 * `openai-compat` 与 `llm-adapter`（CodeArts）两条主干都只按 `\n` 切行，
 * 读到 `done` 就直接 `break`，`buffer` 里残留的**最后一条**从此消失：
 * - 丢 `usage` 帧 ⇒ 用量恒 0，且被记成「上游已上报」；
 * - 丢 `delta` 帧 ⇒ 回答静默截断（用户看到的是「说完一半」）。
 *
 * 同仓库 `antigravity-messages` / `minimax-messages` 早就有这层收尾，
 * 唯这两条最主流的路径漏了 —— 本用例锁死它们。
 */
import assert from 'node:assert/strict'

const HEAD = 'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"前半段"}}]}\n\n'

/** 造一个 SSE 响应体：所有帧都带 `\n\n`，**唯独最后一帧不带任何换行**。 */
function responseEndingWithoutNewline(tail) {
  const bytes = new TextEncoder().encode(HEAD + tail)
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const config = () => ({
  label: 'sse-residual',
  firstTokenTimeoutMs: 5_000,
  chunkTimeoutMs: 5_000,
})

async function collect(response, options = {}) {
  const { consumeOpenAiSse } = await import('../vendor/channel-pack/src/openai-compat.ts')
  const chunks = []
  for await (const chunk of consumeOpenAiSse(response, { ...options }, config())) chunks.push(chunk)
  return chunks
}

/** 全部正文块拼起来。 */
const textOf = (chunks) => chunks
  .filter((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'text')
  .map((chunk) => chunk.block.text)
  .join('')

export async function verifySseResidual() {
  // ── 1. 末条 delta 不带换行：必须被计入正文 ──
  const chunks = await collect(responseEndingWithoutNewline(
    'data: {"id":"c1","choices":[{"index":0,"delta":{"content":"后半段"}}]}',
  ))
  const text = textOf(chunks)
  assert.ok(text.includes('前半段'), `前半段应在正文里，实际：${JSON.stringify(text)}`)
  assert.ok(text.includes('后半段'), `末条 delta（不带尾换行）必须被计入，实际：${JSON.stringify(text)}`)

  // ── 2. 末条 usage 帧不带换行：用量必须被采到 ──
  const withUsage = await collect(responseEndingWithoutNewline(
    'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}',
  ))
  const finish = withUsage.find((chunk) => chunk.type === 'finish')
  assert.ok(finish !== undefined, '流必须正常收尾')
  // ⚠️ usage 是**独立 chunk**（`{type:'usage'}`），不在 finish 里 —— 见 openai-compat.ts:903-916。
  const usageChunk = withUsage.find((chunk) => chunk.type === 'usage')
  assert.ok(usageChunk !== undefined, `末条 usage 帧不得丢（实际 chunks：${JSON.stringify(withUsage.map(c => c.type))}）`)
  assert.equal(usageChunk.usage.outputTokens, 7, `末条 usage 帧不得丢（outputTokens 应为 7，实际 ${JSON.stringify(usageChunk.usage)}）`)
  assert.equal(usageChunk.usage.inputTokens, 11, `末条 usage 帧不得丢（inputTokens 应为 11，实际 ${JSON.stringify(usageChunk.usage)}）`)

  // ── 3. 带尾换行的常规流：行为不变 ──
  const normal = await collect(new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        `${HEAD}data: {"id":"c1","choices":[{"index":0,"delta":{"content":"后半段"}}]}\n\ndata: [DONE]\n\n`,
      ))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
  assert.equal(textOf(normal), '前半段后半段', '常规流（带尾换行）拼接结果不变')

  console.log('ok  SSE 收尾：末条帧不带尾换行时 delta 与 usage 都不丢；常规流行为不变')
}

import { exitIfDirectRun } from './lib/direct-run.mjs'
if (!exitIfDirectRun(import.meta.url, 'sse-residual-test')) {
  await verifySseResidual()
}
