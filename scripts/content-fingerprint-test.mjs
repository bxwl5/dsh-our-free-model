/**
 * 内容级风控指纹清洗：**全渠道**（含免费车道）+ **底层出口层**。
 *
 * 锁三件事：
 * 1. 两侧规则表逐条一致（渠道包 `.ts` 与免费车道 `.js` 各留一份，靠本用例对齐）；
 * 2. 消息层语义 —— 只改 system/assistant、跳过 user/tool、未命中逐字符不变；
 * 3. **底层出口层** —— 任意渠道的 JSON 请求体（chat / responses / Claude / Gemini
 *    四种 wire 拼写）都能被清洗，且无命中时**原始字节**原样发出。
 *
 * 用户要求原文（2026-11-04）：「our-free-model 的全部模型，全部指纹清洗，包含免费
 * 模型」「直接在底层(出口层/请求层)进行指纹清洗」。
 */
import assert from 'node:assert/strict'

const IDENTITY = 'You are an AI agent powered by DeepSeek Harness'
const WEBGUI = 'You are interacting with the user through the DeepSeek Harness Web GUI'
const CLAUDE = 'You are Claude Code'
const GIT = 'Main branch (you will usually use this for PRs)'

/** 四种 wire 拼写的脏请求体。 */
const dirtyBodies = () => ({
  chat: { model: 'm', messages: [
    { role: 'system', content: `${IDENTITY}.` },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: `sure. ${WEBGUI} whose URL…` },
  ] },
  responses: { model: 'm', input: [
    { role: 'system', content: [{ type: 'input_text', text: `${CLAUDE}, Anthropic's official CLI.` }] },
    { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
  ] },
  claude: { model: 'm', system: `${WEBGUI} whose URL…`, messages: [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: `${IDENTITY}.` }] },
  ] },
  // ⚠️ 指纹必须放在**该被清洗的角色**里：Gemini 的 `model` 才是 assistant。
  // 放进 user parts 就是「用户原话」，按判据**不能**改 —— 那样测出来会假红。
  gemini: { model: 'm', contents: [
    { role: 'user', parts: [{ text: 'master' }] },
    { role: 'model', parts: [{ text: `${GIT}: master` }, { text: `${IDENTITY}.` }] },
  ] },
})

/** 该字符串是否仍含任一指纹。 */
const stillDirty = text => [IDENTITY, WEBGUI, CLAUDE, GIT].some(fingerprint => text.includes(fingerprint))

async function verifyMessageSemantics() {
  const pack = await import('../vendor/channel-pack/src/content-fingerprint.ts')
  // 只改 system / assistant / developer
  const messages = [
    { role: 'system', content: [{ type: 'text', text: `${IDENTITY}.` }] },
    { role: 'user', content: [{ type: 'text', text: `${IDENTITY}.` }] },
    { role: 'tool', content: [{ type: 'text', text: `${IDENTITY}.` }] },
    { role: 'assistant', content: `${WEBGUI} whose URL…` },
    { role: 'developer', content: [{ type: 'text', text: `${CLAUDE}!` }] },
  ]
  const out = pack.scrubMessages(messages)
  assert.equal(out[0].content[0].text, 'You are an AI assistant.', 'system 被改写')
  assert.equal(out[1].content[0].text, `${IDENTITY}.`, 'user 原样保留（实测那里不拦）')
  assert.equal(out[2].content[0].text, `${IDENTITY}.`, 'tool 原样保留')
  assert.ok(out[3].content.startsWith('You are interacting with the user through the Web GUI'), 'assistant 历史被改写（否则旧会话每轮都失败）')
  assert.equal(out[4].content[0].text, 'You are a helpful assistant!', 'developer 同 system')
  // 未命中：同一字符串引用（前缀缓存无损）
  const clean = { role: 'system', content: `${IDENTITY.replace('agent', 'bot')}.` }
  assert.equal(pack.scrubMessages([clean])[0], clean, '未命中的消息必须是同一个对象（不重建）')
  // 不原地改调用方数组
  assert.equal(messages[0].content[0].text, `${IDENTITY}.`, '调用方入参不被就地修改')
  console.log('ok  消息层：system/assistant/developer 改写，user/tool 逐字保留，未命中零重建，入参不被就地修改')
}

async function verifyTransport() {
  const pack = await import('../vendor/channel-pack/src/content-fingerprint.ts')
  for (const [wire, body] of Object.entries(dirtyBodies())) {
    const text = JSON.stringify(body)
    const scrubbed = pack.scrubJsonText(text)
    assert.ok(scrubbed !== undefined, `${wire}: 脏请求体必须被清洗`)
    assert.equal(stillDirty(scrubbed), false, `${wire}: 清洗后不得残留任何指纹`)
    // 结构不能丢：消息条数、角色顺序保持
    const before = JSON.parse(text)
    const after = JSON.parse(scrubbed)
    const listOf = doc => doc.messages ?? doc.input ?? doc.contents
    assert.equal(listOf(after).length, listOf(before).length, `${wire}: 消息条数不变`)
    assert.deepEqual(listOf(after).map(m => m.role), listOf(before).map(m => m.role), `${wire}: 角色顺序不变`)
  }
  // user 的内容绝不能被改（Gemini 的 user parts 同理）
  const userOnly = JSON.stringify({ messages: [{ role: 'user', content: `${IDENTITY}.` }] })
  assert.equal(pack.scrubJsonText(userOnly), undefined, 'user-only 请求体：无改动 → 返回 undefined')
  // 无命中 → undefined（调用方保留原始字节，不重新序列化）
  const clean = JSON.stringify({ messages: [{ role: 'system', content: 'You are an AI assistant.' }] })
  assert.equal(pack.scrubJsonText(clean), undefined, '干净请求体不重建（保住上游前缀缓存）')
  // 非 JSON 体不猜
  assert.equal(pack.scrubJsonText(`${IDENTITY}.`), undefined, '纯文本体不猜、不破坏')
  assert.equal(pack.scrubJsonText('not json but has ' + IDENTITY), undefined, '伪 JSON 不猜')
  // fetch 入参形态
  assert.equal(pack.scrubFetchArguments('https://x/y', { method: 'POST', body: clean }), null, '干净请求：返回 null（原样转发）')
  const patched = pack.scrubFetchArguments('https://x/y', { method: 'POST', body: JSON.stringify(dirtyBodies().chat) })
  assert.ok(patched !== null && patched.init.method === 'POST', '脏请求：保留其它 init 字段')
  assert.equal(stillDirty(patched.init.body), false, '脏请求：body 已清洗')
  assert.equal(pack.scrubFetchArguments('https://x/y', { method: 'POST', body: new Uint8Array([1, 2, 3]) }), null, '非字符串体不猜')
  console.log('ok  出口层：chat/responses/Claude/Gemini 四种 wire 都被清洗，结构不变，user 原样，干净请求零重建，非 JSON 体不猜')
}

async function verifyChannelOutlet() {
  // 20 个渠道的上游请求都从 `createChannelFetch` 出网（index.ts 把它的 fetch 注入
  // 每个适配器）。这一层清洗是「全渠道」的**真正保证**，必须有独立用例。
  const { createChannelFetch } = await import('../vendor/channel-pack/src/channel-fetch.ts')
  const sent = []
  const outlet = createChannelFetch({
    fetchImpl: async (input, init) => {
      sent.push({ url: String(input), body: init?.body })
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
    readSystemProxy: async () => '',
  })
  try {
    await outlet.fetch('https://api.example.com/v1/chat/completions', {
      method: 'POST', body: JSON.stringify(dirtyBodies().chat),
    })
    assert.equal(stillDirty(sent.at(-1).body), false, '渠道出口层已清洗（20 个渠道共用这一层）')

    const cleanBody = JSON.stringify({ messages: [{ role: 'system', content: 'You are an AI assistant.' }] })
    await outlet.fetch('https://api.example.com/v1/chat/completions', { method: 'POST', body: cleanBody })
    assert.equal(sent.at(-1).body, cleanBody, '干净请求：原始字符串原样出网')
  } finally {
    await outlet.close()
  }
  console.log('ok  渠道出口层：createChannelFetch 清洗脏请求、干净请求原字节转发')
}

export async function verifyContentFingerprint() {
  await verifyMessageSemantics()
  await verifyTransport()
  await verifyChannelOutlet()
}

import { exitIfDirectRun } from './lib/direct-run.mjs'
if (!exitIfDirectRun(import.meta.url, 'content-fingerprint-test')) {
  await verifyContentFingerprint()
}
