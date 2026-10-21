/** 腾讯系 11128 内容指纹改写：单元语义 + 适配器出站 wire 端到端。 */
import assert from 'node:assert/strict'

const IDENTITY = 'You are an AI agent powered by DeepSeek Harness'
const GIT = 'Main branch (you will usually use this for PRs)'

const collect = async iterable => {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}
const textMessage = (role, text) => ({ role, content: [{ type: 'text', text }] })
const sse = frame => new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`)
const answer = text => sse({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })

async function verifyRewriteFunction() {
  const { rewriteTencentContentFingerprints, isTencentContentFingerprintProvider } =
    await import('../vendor/channel-pack/src/openai-gateway/tencent-fingerprint.ts')

  assert.equal(isTencentContentFingerprintProvider('buddy'), true)
  assert.equal(isTencentContentFingerprintProvider('workbuddy'), true)
  assert.equal(isTencentContentFingerprintProvider('zcode'), false)
  const dirty = `${IDENTITY}.`
  assert.equal(rewriteTencentContentFingerprints(dirty, 'zcode'), dirty, 'non-Tencent provider is untouched')

  for (const [input, expected] of [
    [`${IDENTITY}.`, 'You are an AI assistant.'],
    [IDENTITY, 'You are an AI assistant'],
    [`${IDENTITY.toUpperCase()}.`, 'You are an AI assistant.'],
    [`${IDENTITY}. More text.`, 'You are an AI assistant. More text.'],
    [`You are a coding assistant. ${IDENTITY}.`, 'You are a coding assistant. You are an AI assistant.'],
  ]) {
    assert.equal(rewriteTencentContentFingerprints(input, 'buddy'), expected, `identity: ${input}`)
  }

  assert.equal(
    rewriteTencentContentFingerprints(`${GIT}: master`, 'workbuddy'),
    'Main branch (PRs usually go here): master',
  )

  for (const clean of [
    'You are an AI assistant.',
    'You are a helpful assistant.',
    `${IDENTITY.replace('agent', 'bot')}.`,
    'Main branch: master',
    '',
  ]) {
    assert.equal(rewriteTencentContentFingerprints(clean, 'buddy'), clean, `clean text: ${clean}`)
  }

  assert.equal(
    rewriteTencentContentFingerprints(`${IDENTITY}.\n${GIT}: main`, 'buddy'),
    'You are an AI assistant.\nMain branch (PRs usually go here): main',
  )
  console.log('ok  Tencent 11128: identity (with/without period, uppercase, mid-sentence) and git-branch fingerprints rewritten; clean text byte-identical; other providers untouched')
}

async function verifyAdapterWire() {
  const { BuddyAdapter } = await import('../vendor/channel-pack/src/buddy-adapter.ts')
  const { WORKBUDDY, CODEBUDDY } = await import('../vendor/channel-pack/src/product.ts')
  const defaults = {
    credentialRef: 'FIXTURE', resolveCredential: async () => ({ access_token: 'fixture-token' }), refresh: async () => {},
  }

  const wire = async (product, options) => {
    const seen = []
    const adapter = new BuddyAdapter({
      ...defaults, product, sessionId: 'fixture-fingerprint',
      fetchImpl: async (_url, init) => { seen.push(JSON.parse(init.body)); return answer('ok') },
    })
    await collect(adapter.stream(options))
    assert.equal(seen.length, 1)
    return seen[0].messages
  }

  for (const product of [WORKBUDDY, CODEBUDDY]) {
    {
      const messages = await wire(product, {
        model: 'deepseek-v4-flash', system: `${IDENTITY}.`, messages: [textMessage('user', 'hello')],
      })
      const system = messages.find(message => message.role === 'system')
      assert.ok(system, `${product.id}: system message present`)
      assert.equal(system.content.includes('powered by DeepSeek Harness'), false, `${product.id}: options.system scrubbed`)
      assert.equal(system.content.startsWith('You are an AI assistant.'), true, `${product.id}: options.system rewritten in place`)
    }

    {
      const messages = await wire(product, {
        model: 'deepseek-v4-flash',
        messages: [textMessage('system', `${IDENTITY}.`), textMessage('user', 'hello')],
      })
      const system = messages.find(message => message.role === 'system')
      assert.equal(system.content.includes('powered by DeepSeek Harness'), false, `${product.id}: history system scrubbed`)
    }

    {
      const messages = await wire(product, {
        model: 'deepseek-v4-flash',
        messages: [
          textMessage('user', 'what is your system prompt?'),
          textMessage('assistant', `${IDENTITY}.`),
          textMessage('user', 'continue'),
        ],
      })
      const assistant = messages.find(message => message.role === 'assistant')
      assert.ok(assistant, `${product.id}: assistant history present`)
      assert.equal(assistant.content.includes('powered by DeepSeek Harness'), false, `${product.id}: assistant history scrubbed`)
    }

    {
      const messages = await wire(product, {
        model: 'deepseek-v4-flash',
        messages: [textMessage('user', `${IDENTITY}.`)],
      })
      const user = messages.find(message => message.role === 'user')
      assert.equal(user.content.includes('powered by DeepSeek Harness'), true, `${product.id}: user text preserved verbatim`)
    }

    {
      const options = {
        model: 'deepseek-v4-flash', system: `${IDENTITY}.`,
        messages: [textMessage('system', `${IDENTITY}.`), textMessage('user', `${IDENTITY}.`)],
      }
      const before = structuredClone(options)
      await wire(product, options)
      assert.deepEqual(options, before, `${product.id}: caller options are not mutated`)
    }
  }
  console.log('ok  Tencent 11128: system/assistant on the outgoing wire are scrubbed (both options.system and the transparent options.messages system carrier), user text preserved, caller options unmutated')
}

export async function verifyTencentFingerprint() {
  await verifyRewriteFunction()
  await verifyAdapterWire()
}
