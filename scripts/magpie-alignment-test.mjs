/**
 * magpie 2026-11-24 三个更新的移植钉子。
 *
 * | 来源 | 移植点 |
 * |---|---|
 * | qoder 0.2.72 | ~~`asAgentSDK`：Claude Code 身份行 → Agent SDK 行（修 400）~~ **2026-11-26 已撤销**：全渠道指纹清洗在适配器之前就改写了同一句，适配器的正则锚点永远匹配不到，等于空转。见 `vendor/channel-pack/src/qoder-adapter.ts` 的 systemText 注释 |
 * | zcode 0.1.69 | 日内签到去重（`resetZcodeDaySettled` / `SETTLED_ZCODE_OUTCOMES`） |
 * | trae 0.2.53 | `parseCustomBase`：企业自定义模型直连判据 |
 */
import assert from 'node:assert/strict'
import { exitIfDirectRun } from './lib/direct-run.mjs'

export async function verifyMagpieAlignment() {
  // ── ① qoder asAgentSDK ──（2026-11-26 撤销：清洗在适配器之前，改写在真实链路上
  //    恒不命中，留着只会让人以为修过。这里改成钉住「它确实已经不在了」。）
  {
    const mod = await import('../vendor/channel-pack/src/qoder.ts')
    assert.equal(mod.asAgentSDK, undefined, 'asAgentSDK 应已撤销（否则空转逻辑回到仓库里）')
    const adapter = await import('../vendor/channel-pack/src/qoder-adapter.ts')
    assert.equal(typeof adapter.registerQoderLlm, 'function', '适配器仍应导出')
  }

  // ── ② zcode 日内去重 ──
  {
    const mod = await import('../vendor/channel-pack/src/zcode-auth.ts')
    assert.equal(typeof mod.resetZcodeDaySettled, 'function', '必须导出重置函数（供测试隔离）')
    assert.doesNotThrow(() => mod.resetZcodeDaySettled(), '重置应可安全调用')
  }

  // ── ③ trae parseCustomBase 判据 ──
  {
    const { parseCustomBase } = await import('../vendor/channel-pack/src/trae.ts')
    /** 造一个合法的企业自定义模型条目。 */
    const good = (over = {}) => ({
      model_detail: {
        provider: 'custom_openai_compatible',
        model_name: 'erp-model',
        custom_config: {
          status: true,
          auth_type: 0,
          ak: 'sk-xxx',
          base_url: 'https://tokenerpgw.example.com/erp/v1/chat/completions',
        },
        ...over,
      },
    })
    const ok = parseCustomBase(good())
    assert.ok(ok !== undefined, '合法条目应解出直连配置')
    assert.equal(ok.modelName, 'erp-model')
    assert.equal(ok.ak, 'sk-xxx')

    // 每条判据单独破坏一次，都必须回 undefined（否则会误走直连 → 404）
    const breaks = {
      'status 非 true': { model_detail: { ...good().model_detail, custom_config: { ...good().model_detail.custom_config, status: false } } },
      'auth_type 非 0': { model_detail: { ...good().model_detail, custom_config: { ...good().model_detail.custom_config, auth_type: 1 } } },
      'provider 不匹配': { model_detail: { ...good().model_detail, provider: 'openai' } },
      'ak 为空': { model_detail: { ...good().model_detail, custom_config: { ...good().model_detail.custom_config, ak: '  ' } } },
      'model_name 为空': { model_detail: { ...good().model_detail, model_name: '' } },
      'base_url 非 URL': { model_detail: { ...good().model_detail, custom_config: { ...good().model_detail.custom_config, base_url: 'not-a-url' } } },
      'base_url 非 completions': { model_detail: { ...good().model_detail, custom_config: { ...good().model_detail.custom_config, base_url: 'https://x.com/v1/embeddings' } } },
      '无 custom_config': { model_detail: { provider: 'custom_openai_compatible', model_name: 'm' } },
    }
    for (const [label, entry] of Object.entries(breaks)) {
      assert.equal(parseCustomBase(entry), undefined, `${label} 时必须拒绝直连`)
    }
  }

  // ── ④ isTraeModelCallable：custom 模型只有带 customBase 才放行 ──
  {
    const { isTraeModelCallable } = await import('../vendor/channel-pack/src/trae.ts')
    assert.equal(isTraeModelCallable({ id: 'a', name: 'a', isCustomModel: true }), false, '无 customBase 的 custom 仍挡')
    assert.equal(isTraeModelCallable({ id: 'b', name: 'b', isCustomModel: true, customBase: { url: 'https://x/v1/chat/completions', ak: 'k', modelName: 'm' } }), true, '有 customBase 应放行')
    assert.equal(isTraeModelCallable({ id: 'c', name: 'c' }), true, '普通模型照旧')
    assert.equal(isTraeModelCallable({ id: 'd', name: 'd', isEnabled: false }), false, 'config_switch=false 仍挡')
  }

  // ── ⑤ raccoon 会话/轮次头（magpie raccoon 0.1.15） ──
  {
    const {
      raccoonUuidish, raccoonTurnIndex, raccoonSessionId, raccoonSessionTurnHeaders,
    } = await import('../vendor/channel-pack/src/raccoon.ts')
    const userText = text => ({ role: 'user', content: [{ type: 'text', text }] })
    const toolStep = id => ([
      { role: 'assistant', content: [{ type: 'tool-call', id, name: 'read', arguments: '{}' }] },
      { role: 'tool', toolCallId: id, content: [{ type: 'text', text: 'out' }] },
    ])

    // uuidish：UUID v4 形状 + 同 seed 同值（会话稳定的前提）
    const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    assert.match(raccoonUuidish('seed-a'), shape, 'uuidish 必须是 UUID v4 形状')
    assert.equal(raccoonUuidish('seed-a'), raccoonUuidish('seed-a'), '同 seed 必须同值')
    assert.notEqual(raccoonUuidish('seed-a'), raccoonUuidish('seed-b'), '不同 seed 必须不同值')

    // 轮次号：工具步骤不加，用户消息才 +1
    assert.equal(raccoonTurnIndex([]), 0, '没有 user 消息时无轮次')
    assert.equal(raccoonTurnIndex([userText('q1')]), 1)
    assert.equal(raccoonTurnIndex([userText('q1'), ...toolStep('c1')]), 1, '工具步骤不新增轮次')
    assert.equal(raccoonTurnIndex([userText('q1'), ...toolStep('c1'), ...toolStep('c2')]), 1, '同一轮多个工具步骤同轮次')
    assert.equal(raccoonTurnIndex([userText('q1'), ...toolStep('c1'), userText('q2')]), 2, '用户再发一条才 +1')
    assert.equal(raccoonTurnIndex([
      userText('q1'), { role: 'user', content: [{ type: 'text', text: '宿主补的提醒' }] }, ...toolStep('c1'),
    ]), 1, '相邻的 user 补充消息不得算两轮')

    // 会话 id：宿主给了优先；没给按（账号 + 首条 user 消息）派生
    assert.equal(raccoonSessionId({ sessionId: 'sess-A', account: 'acc', messages: [] }), 'sess-A')
    const derived = raccoonSessionId({ account: 'acc', messages: [userText('q1'), ...toolStep('c1')] })
    assert.match(derived, shape, '派生会话 id 也是 UUID v4 形状')
    assert.equal(derived, raccoonSessionId({ account: 'acc', messages: [userText('q1'), ...toolStep('c1'), ...toolStep('c2')] }),
      '后续轮次必须复用同一个派生 id')
    assert.notEqual(derived, raccoonSessionId({ account: 'acc', messages: [userText('q2')] }), '换对话必须换 id')
    assert.notEqual(derived, raccoonSessionId({ account: 'acc-2', messages: [userText('q1')] }), '换账号必须换 id')
    assert.equal(raccoonSessionId({ messages: [userText('q1')] }), '', '没有账号时不编造 id')
    assert.equal(raccoonSessionId({ account: 'acc', messages: [] }), '', '没有首条 user 消息时不编造 id')

    // 三个头的组合
    const headers = raccoonSessionTurnHeaders({ sessionId: 'sess-A', messages: [userText('q1'), ...toolStep('c1')] })
    assert.equal(headers['X-RACCOON-Call-Kind'], 'session_turn')
    assert.equal(headers['X-RACCOON-Session-ID'], 'sess-A')
    assert.equal(headers['X-RACCOON-Turn-ID'], 'sess-A-turn-1')
    const noSession = raccoonSessionTurnHeaders({ messages: [userText('q1')] })
    assert.equal(noSession['X-RACCOON-Session-ID'], undefined, '拿不到会话就不发该头（不编假值）')
    assert.equal(noSession['X-RACCOON-Turn-ID'], undefined)
    assert.equal(noSession['X-RACCOON-Call-Kind'], 'session_turn', 'Call-Kind 恒发')
    // 超长会话 id 截断到 128（magpie 同口径）
    const long = raccoonSessionTurnHeaders({ sessionId: 'x'.repeat(200), messages: [userText('q1')] })
    assert.equal(long['X-RACCOON-Session-ID'].length, 128)
  }

  // ── ⑥ zcode 设备码轮询：ready 但没有 OAuth access token（magpie zcode 0.1.70） ──
  {
    const { pollZcodeLogin } = await import('../vendor/channel-pack/src/zcode-login.ts')
    const flow = { flowId: 'flow-1', flowSecret: 'fixture-secret' }
    const pollWith = data => pollZcodeLogin(flow, async () =>
      new Response(JSON.stringify({ code: 0, data }), { status: 200 }))

    const noOAuth = await pollWith({ status: 'ready', token: 'jwt', user: { user_id: 'u1' } })
    assert.equal(noOAuth.kind, 'failed')
    assert.match(noOAuth.message, /OAuth access token/, '必须点明缺的是 OAuth access token')
    assert.match(noOAuth.message, /重新登录/, '必须给可执行出路')
    assert.doesNotMatch(noOAuth.message, /缺关键字段|状态无法识别/, '不得落进泛化文案')

    // magpie 的判定顺序：先判 ready 无 token，再看其他字段
    const bothMissing = await pollWith({ status: 'ready', user: {} })
    assert.match(bothMissing.message, /OAuth access token/, 'token 也缺时仍先报 OAuth 分支')

    // 两个 token 位分别点出来（排障时不用去猜是哪一个缺）
    const noJwt = await pollWith({ status: 'ready', user: { user_id: 'u1' }, zai: { access_token: 'zai-token' } })
    assert.match(noJwt.message, /data\.token/, '缺 zcode JWT 时点名 data.token')
    const noThirdParty = await pollWith({ status: 'ready', token: 'jwt', user: { user_id: 'u1' } })
    assert.match(noThirdParty.message, /data\.zai 与 data\.bigmodel/, '缺第三方 token 时点名两个块')

    // 正常 ready 不受影响（防过度触发）
    const ok = await pollWith({ status: 'ready', token: 'jwt', user: { user_id: 'u1', name: 'n' }, zai: { access_token: 'zai-token' } })
    assert.equal(ok.kind, 'ready')
    assert.equal(ok.result.zaiAccessToken, 'zai-token')
    assert.equal(ok.result.zcodeJwt, 'jwt')
  }

  console.log('ok  magpie 对齐：qoder 身份行 / zcode 日内去重 / trae 直连判据 / raccoon 会话头 / zcode 无 token 分支')
}

exitIfDirectRun(import.meta.url, () => verifyMagpieAlignment())
