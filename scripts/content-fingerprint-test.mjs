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
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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
  // 思考字段与工具参数：CodeArts / OpenAI 兼容两家把 assistant 的思考放在与
  // `content` **平级**的 `reasoning_content` 上，工具参数则是模型产出的 JSON 字符串。
  // 这两处都是 assistant 自己的产出，会随历史每轮回传 —— 必须一起清（2026-11-04）。
  codearts: { model: 'm', messages: [
    { role: 'system', content: `${IDENTITY}.` },
    { role: 'user', content: 'run it' },
    {
      role: 'assistant',
      content: 'ok',
      reasoning_content: `thinking… ${WEBGUI} whose URL…`,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ text: `${CLAUDE}.` }) } }],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'done' },
  ] },
})

/** 递归判断 JSON 里是否还残留任一指纹（含工具参数这种被序列化进字符串的字段）。 */
const stillDirtyDeep = value => {
  if (typeof value === 'string') return stillDirty(value)
  if (Array.isArray(value)) return value.some(stillDirtyDeep)
  if (value && typeof value === 'object') return Object.values(value).some(stillDirtyDeep)
  return false
}

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

  // ── 思考字段 + 工具参数（2026-11-04 审查补的两处缺口）──
  const thinking = {
    role: 'assistant',
    content: 'hi',
    reasoning_content: `${WEBGUI} whose URL…`,
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'w', arguments: JSON.stringify({ t: `${IDENTITY}.` }) } }],
  }
  const scrubbedThinking = pack.scrubWireMessage(thinking)
  assert.equal(stillDirty(scrubbedThinking.reasoning_content), false, '平级 reasoning_content 必须被清洗（此前漏洗 = 指纹随历史回传）')
  assert.equal(stillDirty(scrubbedThinking.tool_calls[0].function.arguments), false, 'tool_calls 参数必须被清洗（此前只有出口层管，签名车道因此 403）')
  assert.equal(scrubbedThinking.content, 'hi', 'content 不受影响')
  assert.equal(scrubbedThinking.tool_calls[0].function.name, 'w', '工具名不动')
  // 带推理块的 harness 形状：块类型 reasoning 也要清（此前只认 text）
  const reasoningBlock = { role: 'assistant', content: [{ type: 'reasoning', text: `${IDENTITY}.` }] }
  assert.equal(stillDirty(pack.scrubWireMessage(reasoningBlock).content[0].text), false, 'reasoning 块必须被清洗')
  // 未命中时仍是同一个对象
  const cleanThinking = { role: 'assistant', content: 'a', reasoning_content: 'b' }
  assert.equal(pack.scrubWireMessage(cleanThinking), cleanThinking, '未命中的 thinking 消息不重建')

  console.log('ok  消息层：system/assistant/developer 改写，user/tool 逐字保留，未命中零重建，入参不被就地修改；思考字段与工具参数一并清洗')
}

async function verifyTransport() {
  const pack = await import('../vendor/channel-pack/src/content-fingerprint.ts')
  for (const [wire, body] of Object.entries(dirtyBodies())) {
    const text = JSON.stringify(body)
    const scrubbed = pack.scrubJsonText(text)
    assert.ok(scrubbed !== undefined, `${wire}: 脏请求体必须被清洗`)
    assert.equal(stillDirty(scrubbed), false, `${wire}: 清洗后不得残留任何指纹`)
    // 深检：工具参数是「字符串里再套 JSON」，浅层文本搜索可能漏判
    assert.equal(stillDirtyDeep(JSON.parse(scrubbed)), false, `${wire}: 深层（含工具参数/思考字段）也不得残留`)
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

  // ★ ZCode 官方身份块（3012 准入）与指纹清洗共存（用户 2026-11-05：
  //   「不管什么客户端、什么方式都要把指纹清洗、提示词注入成功」）。
  //   zcode-adapter 把 body.system 构造成块数组：前 3 块是官方身份段（必须逐字保留，
  //   否则 3012），第 4 块是调用方 DSH 的 system（含指纹，必须被洗掉），
  //   最后一块带 cache_control 断点（prefix caching，不能丢）。
  const officialPrefix = 'You are ZCode, an interactive agent'
  const stableSection = 'You are an agent working with the user toward their goals'
  const zcodeSystem = [
    { type: 'text', text: officialPrefix },
    { type: 'text', text: stableSection },
    { type: 'text', text: '# Environment\\nPlatform: linux' },
    { type: 'text', text: `${IDENTITY}.\\n\\nYou are a coding agent.`, cache_control: { type: 'ephemeral' } },
  ]
  const zBody = JSON.stringify({ model: 'glm-5.3-flash', system: zcodeSystem, messages: [] })
  const zScrubbed = pack.scrubJsonText(zBody)
  assert.ok(zScrubbed !== undefined, 'ZCode 请求体：调用方 system 含指纹 → 必须被清洗')
  const zAfter = JSON.parse(zScrubbed)
  assert.equal(zAfter.system.length, 4, 'ZCode system 块数不变')
  assert.equal(zAfter.system[0].text, officialPrefix, '官方 cliPrefix 逐字保留（3012 准入）')
  assert.equal(zAfter.system[1].text, stableSection, '官方 stable 段逐字保留（3012 准入）')
  assert.equal(zAfter.system[2].text, '# Environment\\nPlatform: linux', '环境段不动')
  assert.ok(!zAfter.system[3].text.includes(IDENTITY), '调用方 system 里的 DSH 指纹已被清洗')
  assert.deepEqual(zAfter.system[3].cache_control, { type: 'ephemeral' }, '最后一块的 cache_control 断点不丢')
  assert.equal(zAfter.system[0].cache_control, undefined, '未命中的官方块保持原对象、不被凭空加断点')
  // 官方身份块本身不含任何规则表指纹 → 单独发时出口层零重建（保住前缀缓存）
  const officialOnly = JSON.stringify({ system: zcodeSystem.slice(0, 3), messages: [] })
  assert.equal(pack.scrubJsonText(officialOnly), undefined, '纯官方身份块不含指纹 → 零重建')

  // ★ 组合检测的所有锚点（2026-10-21 Windows 文档 + 2026-11-05 NAS 实测）：
  //   上游对 system 做多短语 AND 检测，规则表缺任一条都会稳定 11128。
  const comboSystem = [
    'You are an AI agent powered by DeepSeek Harness.',
    'You are a coding agent powered by the hy4free model.',
    'Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root; absolute paths identify files or directories on the host.',
    'You are interacting with the user through the Web GUI whose URL the runtime context names.',
  ].join('\n\n')
  const comboOut = pack.scrubJsonText(JSON.stringify({ model: 'm', messages: [{ role: 'system', content: comboSystem }] }))
  assert.ok(comboOut !== undefined, '组合锚点：必须被清洗')
  const comboAfter = JSON.parse(comboOut).messages[0].content
  assert.ok(!comboAfter.includes('DeepSeek Harness'), '身份句品牌词必须去掉')
  assert.ok(!comboAfter.includes('DeepSeek Harness Web GUI'), '组合锚点短串必须去掉')
  assert.ok(!comboAfter.includes('Tokens prefixed with @ are paths'), '路径句组合首句必须改写')
  assert.ok(comboAfter.includes('denote paths'), '路径句改成等义表达')

  console.log('ok  出口层：chat/responses/Claude/Gemini 四种 wire 都被清洗，结构不变，user 原样，干净请求零重建，非 JSON 体不猜；ZCode 官方身份块逐字保留 + cache_control 不丢；组合检测三锚点（身份句/WebGUI短串/路径句）全部改写')
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

  // ── 签名车道（`skipScrub`）：出口层必须一个字节都不改 ──
  // CodeArts 的 body 在 `llm-adapter` 里已签过名，这里再改就会 403（APIG.0301）。
  const signedSent = []
  const signedOutlet = createChannelFetch({
    skipScrub: true,
    fetchImpl: async (input, init) => {
      signedSent.push({ url: String(input), body: init?.body })
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
    readSystemProxy: async () => '',
  })
  try {
    const signedBody = JSON.stringify(dirtyBodies().codearts)
    await signedOutlet.fetch('https://api.example.com/v1/chat/completions', { method: 'POST', body: signedBody })
    assert.equal(signedSent.at(-1).body, signedBody, '签名车道：出口层不得改写 body（否则与服务端重算的哈希对不上）')
  } finally {
    await signedOutlet.close()
  }
  console.log('ok  渠道出口层：createChannelFetch 清洗脏请求、干净请求原字节转发、签名车道 skipScrub 零改动')
}

/**
 * ★ ★ **所有适配器都必须接上出口层 fetch**（用户 2026-11-05：
 * 「不管什么客户端、什么方式(Windows/NAS/Mac/Web UI) 都要把指纹清洗成功」）。
 *
 * ## 为什么需要这条静态守卫
 *
 * `02680fb`「指纹清洗推广到全部渠道 + 落到出口层」只实现了 `createChannelFetch`
 * 里的清洗函数，**没把 `network.fetch` 注入各适配器**。各适配器默认
 * `options.fetchImpl ?? fetch`（全局 fetch）⇒ 出口层清洗被整个绕过。
 *
 * 本机 DSH 0.2.2 靠消息层 wrapAdapterWithTokenLedger→scrubGenerateOptions 兜住；
 * NAS DSH 0.2.1-rc.2 的派发链绕过消息层 ⇒ buddy 直连稳定 400/11128。
 * 这个差异直到用户报障才暴露，且靠"看代码"极难发现（21 个注册散落 2000 行）。
 *
 * ⇒ 用静态断言锁死：每个 `registerXxxLlm(ctx, {...})` 注册块里都必须出现
 *   `fetchImpl: network.fetch`（签名车道 CodeArts 例外，用 signedNetwork.fetch）。
 * 将来新增适配器若忘了接，本用例立刻红。
 *
 * ⚠️ 同时锁死 minimax / opencode 不再用硬编码裸 `fetch(`（它们原先没有
 *   fetchImpl 字段，注入了也用不上）。
 */
export async function verifyAllAdaptersWired() {
  const root = new URL('../vendor/channel-pack/src/', import.meta.url)
  const index = readFileSync(fileURLToPath(new URL('index.ts', root)), 'utf8')

  // 找所有注册调用的起点（含换行后的 `{`）
  const re = /const (\w+)\s*=\s*register\w+Llm\(ctx, \{|(\w+Adapter)\s*=\s*register\w+Llm\(ctx, \{/g
  const starts = []
  for (const m of index.matchAll(re)) starts.push({ name: m[1] ?? m[2], at: m.index })
  assert.ok(starts.length >= 20, `应至少找到 20 个适配器注册，实际 ${starts.length}`)

  // 每个注册点之后到下一个注册点之间，必须出现 fetchImpl
  const segmentEnd = (i) => i + 1 < starts.length ? starts[i + 1].at : index.length
  const missing = []
  for (let i = 0; i < starts.length; i += 1) {
    const seg = index.slice(starts[i].at, segmentEnd(i))
    if (!/fetchImpl:\s*(network|signedNetwork)\.fetch/.test(seg)) {
      missing.push(starts[i].name)
    }
  }
  assert.deepEqual(missing, [],
    `以下适配器未接出口层 fetch（会绕过全渠道指纹清洗）：${missing.join(', ')}`)

  // 锁死两个原先硬编码全局 fetch 的适配器：options 有 fetchImpl、发请求用 this.fetchImpl
  for (const file of ['minimax-adapter.ts', 'opencode-adapter.ts']) {
    const src = readFileSync(fileURLToPath(new URL(file, root)), 'utf8')
    assert.match(src, /fetchImpl\?:\s*typeof fetch/, `${file}: options 缺 fetchImpl 字段`)
    assert.match(src, /this\.fetchImpl\s*=\s*options\.fetchImpl\s*\?\?\s*fetch/,
      `${file}: 构造函数未把 fetchImpl 落到实例`)
    assert.match(src, /await this\.fetchImpl\(/, `${file}: 推理请求仍在用裸 fetch`)
  }

  console.log(`ok  全渠道出口层接线：${starts.length} 个适配器全部注入 network.fetch（minimax/opencode 已改用实例 fetch）`)
}

/**
 * ★ ★ 全局 fetch 兜底（「不管怎么样，发出去的请求一定是指纹清洗过的」）。
 *
 * 这是唯一不依赖任何接线的层：直接把 globalThis.fetch 包一层，任意调用方
 * （适配器、旧路由、热重载残留、外部库）发出的带指纹请求都会被清。
 */
export async function verifyGlobalFetchScrub() {
  const pack = await import('../vendor/channel-pack/src/content-fingerprint.ts')
  const sent = []
  const original = async (input, init) => {
    sent.push({ url: String(input), body: init?.body })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const dirty = JSON.stringify({ model: 'm', messages: [
    { role: 'system', content: `${IDENTITY}.` },
    { role: 'user', content: 'hi' },
  ] })
  const clean = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })

  // ① 任意路径发出的脏请求：经 scrubbedFetch 必被清洗（这是全局兜底的核心）
  await pack.scrubbedFetch(original, 'https://any.example.com/v1/chat', { method: 'POST', body: dirty })
  assert.ok(!sent.at(-1).body.includes(IDENTITY), '任意路径脏请求的指纹必须被清掉')
  assert.ok(sent.at(-1).body.includes('You are an AI assistant'), '替换成中性表达')

  // ② 干净请求零改动（保前缀缓存）
  await pack.scrubbedFetch(original, 'https://any.example.com/v1/chat', { method: 'POST', body: clean })
  assert.equal(sent.at(-1).body, clean, '干净请求必须原字节转发')

  // ③ 非 JSON 体 / 无 body 不猜、不破坏
  await pack.scrubbedFetch(original, 'https://any.example.com/v1/chat', { method: 'POST', body: new Uint8Array([1,2,3]) })
  assert.deepEqual(sent.at(-1).body, new Uint8Array([1,2,3]), '非字符串体原样')
  await pack.scrubbedFetch(original, 'https://any.example.com/health', { method: 'GET' })
  assert.equal(sent.at(-1).body, undefined, 'GET 无体请求原样')

  // ④ installGlobalFetchScrub 幂等 + disposer 只摘自己（不污染其它用例的全局态）
  //    汇总套件里 apply() 可能已经装过包装 ⇒ before 本身就是包装器，此时安装
  //    应幂等跳过；用「先确保干净起点」的方式隔离：记录当前，装一次，再验证
  //    「重复装不叠层」和「跳过那代的 disposer 不摘掉已有包装」。
  const before = globalThis.fetch
  const a = pack.installGlobalFetchScrub()
  const afterA = globalThis.fetch
  const b = pack.installGlobalFetchScrub()
  assert.equal(globalThis.fetch, afterA, '重复安装不叠层')
  b() // B 是「跳过」的那一代，dispose 不得摘掉 A（或已有包装）
  assert.equal(globalThis.fetch, afterA, 'B 的 disposer 不得摘掉已有包装')
  a()
  // 未装过的情况下 A 会还原；已装过的情况下 A 是「跳过」代，什么都不做。
  assert.ok(globalThis.fetch === before || globalThis.fetch === afterA,
    'A 的 disposer 只还原自己那一代，不越权')
  console.log('ok  全局 fetch 兜底：任意路径脏请求必清洗、干净请求零改动、非 JSON 不猜、幂等不叠层、disposer 只摘自己')
}

export async function verifyContentFingerprint() {
  await verifyMessageSemantics()
  await verifyTransport()
  await verifyChannelOutlet()
  await verifyAllAdaptersWired()
  await verifyGlobalFetchScrub()
}

import { exitIfDirectRun } from './lib/direct-run.mjs'
if (!exitIfDirectRun(import.meta.url, 'content-fingerprint-test')) {
  await verifyContentFingerprint()
}
