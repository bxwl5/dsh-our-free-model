/**
 * 把「裸 delta 流」转成内核认的 ContentBlock 流。
 *
 * ## 为什么需要它
 *
 * 内核的 `StreamChunk` 契约要求 `text-delta` / `reasoning-delta` 必须带
 * `index`（非负整数），且以 `block-start` / `block-end` 成对包裹 ——
 * `block-end` 还要带**完整的 block**（它是「这一块的最终内容」，不是结束标记）。
 *
 * 早期接入的几个渠道（orcaterm / kuku / monkeycode / accio）直接发
 * `{type:'text-delta', text}`，于是内核报
 * `text-delta index must be a non-negative safe integer`
 *（2026-10-25 用户实测 orcaterm）。本 helper 让它们不必各写一遍生命周期。
 *
 * ## 语义
 *
 * - 首个正文 delta 到达时发 `block-start`，之后同类的 delta 复用同一 index；
 * -  reasoning 与 text 各占一个 block，按首次出现的顺序分配 index；
 * - 结束时为每个**有内容**的 block 发 `block-end`（带完整文本）；
 * - `finish` 由调用方发（不同渠道的 reason 判定不同，不在这里统一）。
 */
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/** 一个正在累积的块。 */
interface PendingBlock {
  index: number
  kind: 'text' | 'reasoning'
  text: string
}

/**
 * 把 `{ text?, reasoning? }` 的 delta 流转成内核的 block 流。
 *
 * @param deltas 上游 delta 流（文本与/或思考增量）
 * @param options.keepWhitespaceReasoning 纯空白思考是否也算一个块
 *        （默认否：纯空白不发射，避免留下空 reasoning 块）
 */
export async function* emitDeltaBlocks(
  deltas: AsyncIterable<{ text?: string; reasoning?: string }>,
  options: { keepWhitespaceReasoning?: boolean } = {},
): AsyncGenerator<StreamChunk, void, undefined> {
  const blocks: PendingBlock[] = []
  let nextIndex = 0
  for await (const delta of deltas) {
    if (delta.text !== undefined && delta.text !== '') {
      // 块在**首个 delta** 到达时才开（与 buddy-adapter 同款）：避免空块。
      let block = blocks.find(candidate => candidate.kind === 'text')
      if (block === undefined) {
        block = { index: nextIndex++, kind: 'text', text: '' }
        blocks.push(block)
        yield { type: 'block-start', index: block.index, blockType: 'text' }
      }
      block.text += delta.text
      yield { type: 'text-delta', index: block.index, text: delta.text }
    }
    if (delta.reasoning !== undefined && delta.reasoning !== '') {
      let block = blocks.find(candidate => candidate.kind === 'reasoning')
      if (block === undefined) {
        block = { index: nextIndex++, kind: 'reasoning', text: '' }
        blocks.push(block)
        yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
      }
      block.text += delta.reasoning
      yield { type: 'reasoning-delta', index: block.index, text: delta.reasoning }
    }
  }
  // 收尾：为**每个已开启的块**发 block-end（带完整文本）。
  // ⚠️ 已发过 block-start 的块**必须**配一个 block-end —— 跳过会让内核看到
  // 永不关闭的块（比留一个空块更糟：实测纯空白 reasoning 走「跳过」分支时
  // 块就悬在那里了）。故这里只跳过 `block.text === ''` 的纯空块，
  // 纯空白 reasoning 照样收尾（内容原样给，交给上层决定显示）。
  // 顺序按 index 升序，保证块的开启/关闭次序一致。
  for (const block of [...blocks].sort((a, b) => a.index - b.index)) {
    if (block.text === '') continue
    yield block.kind === 'text'
      ? { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
      : { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }
  }
}
