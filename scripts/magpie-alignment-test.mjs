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

  console.log('ok  magpie 对齐：qoder 身份行 / zcode 日内去重 / trae 直连判据')
}

exitIfDirectRun(import.meta.url, () => verifyMagpieAlignment())
