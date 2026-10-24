/** OfficeAce：DPoP/两套签名/Basic 推理/轮询取码（读状态码）/凭据解析。 */
import assert from 'node:assert/strict'
import http from 'node:http'

const collect = async (it) => { const out = []; for await (const c of it) out.push(c); return out }

async function main() {
  const {
    base64UrlEncode, createDpopKeyPair, createDpopProof, toHex, hmacSha256, sha256Hex,
    buildCanonicalRequest, signSdkHmac, signV11, formatSdkDate,
  } = await import('../vendor/channel-pack/src/officeace-dpop.ts')
  const {
    normalizeBaseUrl, basicAuthHeader, parseCredential, isCredentialUsable,
    createPkcePair, buildAuthorizeUrl, fetchState, pollAuthCode, validatePermission,
  } = await import('../vendor/channel-pack/src/officeace.ts')
  const { OFFICEACE } = await import('../vendor/channel-pack/src/officeace-product.ts')
  const { OfficeAceAdapter } = await import('../vendor/channel-pack/src/officeace-adapter.ts')
  const { fetch: realFetch } = await import('undici')

  // ── base64url ──
  assert.equal(base64UrlEncode('hi'), 'aGk')
  assert.equal(base64UrlEncode(new Uint8Array([251, 255])), '-_8', 'URL 安全字符')

  // ── DPoP ──
  const key = await createDpopKeyPair()
  assert.equal(key.publicJwk.kty, 'EC')
  assert.equal(key.publicJwk.crv, 'P-256')
  assert.ok(key.publicJwk.x.length > 20)
  const proof = await createDpopProof(key, 'post', 'https://sts.example.com/v1/oauth2/tokens')
  const [h, p, sig] = proof.split('.')
  assert.equal(sig.length > 40, true, '有签名段')
  const header = JSON.parse(atob(h.replace(/-/g, '+').replace(/_/g, '/')))
  assert.equal(header.alg, 'ES256')
  assert.equal(header.typ, 'dpop+jwt')
  assert.equal(header.jwk.crv, 'P-256', '头部嵌公钥 JWK')
  const payload = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')))
  assert.equal(payload.htm, 'POST', 'htm 转大写')
  assert.equal(payload.htu, 'https://sts.example.com/v1/oauth2/tokens')
  assert.equal(typeof payload.iat, 'number')
  assert.equal(payload.jti.length, 64, 'jti 是 32 字节的 hex')

  // ── canonicalRequest：URI 强制补尾斜杠 ──
  const { canonicalRequest, signedHeaders } = buildCanonicalRequest({
    method: 'get', path: '/v1/claw/client-permission-validate', query: '',
    host: 'agentarts.example.com',
    headers: [['host', 'agentarts.example.com'], ['x-sdk-date', formatSdkDate(Date.parse('2026-01-01T00:00:00Z'))]],
    payloadHash: 'abc',
  })
  assert.ok(canonicalRequest.startsWith('GET\n/v1/claw/client-permission-validate/\n'), 'URI 补尾斜杠 + 方法大写')
  assert.equal(signedHeaders, 'host;x-sdk-date')

  // ── SDK-HMAC ──
  const sdk = await signSdkHmac({
    accessKey: 'AK', secretKey: 'SK', canonicalRequest, signedHeaders,
    timestampMs: Date.parse('2026-01-01T00:00:00Z'),
  })
  assert.ok(sdk.authorization.startsWith('SDK-HMAC-SHA256 Access=AK,'))
  assert.equal(sdk.sdkDate, '20260101T000000Z', '华为云日期格式（非标准 ISO8601）')

  // ── V11：AK/SK 顺序与 hex 串密钥 ──
  const v11 = await signV11({
    accessKey: 'AK', secretKey: 'SK', region: 'cn-southwest-2', service: 'agentarts',
    canonicalRequest, signedHeaders, timestampMs: Date.parse('2026-01-01T00:00:00Z'),
  })
  assert.ok(v11.authorization.includes('Credential=AK/20260101/cn-southwest-2/agentarts'), 'scope 含日期/地区/服务')
  // 独立复算：step1 = hmac(key=AK, data=SK)；derived = hmac(step1, scope+0x01)[..32]；签名用 hex 串当密钥
  const step1 = await hmacSha256('AK', 'SK')
  const scope = '20260101/cn-southwest-2/agentarts'
  const seed = new Uint8Array([...new TextEncoder().encode(scope), 1])
  const derived = (await hmacSha256(step1, new TextDecoder().decode(seed))).slice(0, 32)
  const signingKeyHex = toHex(derived)
  const stringToSign = ['V11-HMAC-SHA256', '20260101T000000Z', scope, await sha256Hex(canonicalRequest)].join('\n')
  const expected = toHex(await hmacSha256(signingKeyHex, stringToSign))
  assert.ok(v11.authorization.endsWith(`Signature=${expected}`), 'V11 签名与独立复算一致')

  // ── 凭据解析 ──
  assert.equal(normalizeBaseUrl('https://gw.example.com'), 'https://gw.example.com/v2')
  assert.equal(normalizeBaseUrl('https://gw.example.com/v2'), 'https://gw.example.com/v2')
  assert.equal(normalizeBaseUrl('https://gw.example.com/v2/'), 'https://gw.example.com/v2')
  const cred = parseCredential({ baseUrl: 'https://gw.example.com/v2', appKey: 'k', appSecret: 's' })
  assert.equal(cred.base_url, 'https://gw.example.com/v2')
  assert.equal(cred.app_key, 'k')
  assert.equal(isCredentialUsable(cred), true)
  assert.equal(isCredentialUsable({ base_url: '', app_key: 'k', app_secret: 's' }), false)
  assert.equal(parseCredential({ appKey: 'k' }), undefined, '缺 base_url 拒绝')
  // Basic 头
  assert.equal(basicAuthHeader(cred), `Basic ${btoa('k:s')}`)

  // ── PKCE ──
  const pkce = await createPkcePair()
  assert.equal(pkce.verifier.length, 64)
  assert.equal(pkce.challenge.length, 64)
  assert.notEqual(pkce.verifier, pkce.challenge)
  // 授权 URL 的 redirect_uri 指向云端（不是本机）
  const authUrl = buildAuthorizeUrl(OFFICEACE, 'st', pkce.challenge)
  assert.ok(authUrl.includes(encodeURIComponent(OFFICEACE.redirectUri)) || authUrl.includes('agentarts'), '回调指向云端')
  // 授权地址必须**两层嵌套**：外层 login.html 承载登录，内层才是 OAuth authorize。
  // 只拼一层时华为云会安静地渲染通用登录页，登录完没有回调（用户报障的形态）。
  assert.ok(authUrl.startsWith('https://auth.huaweicloud.com/authui/login.html?service='), '外层必须是 login.html?service=')
  const inner = decodeURIComponent(new URL(authUrl).searchParams.get('service') ?? '')
  assert.ok(inner.startsWith('https://auth.huaweicloud.com/authui/v1/oauth2/authorize?'), '内层必须是 oauth2/authorize')
  const innerParams = new URL(inner).searchParams
  // 华为云要 SHA-256（不是 PKCE 规范里的 S256 字面量）。
  assert.equal(innerParams.get('code_challenge_method'), 'SHA-256')
  assert.equal(innerParams.get('scope'), 'openid')
  assert.equal(innerParams.get('response_type'), 'code')
  assert.equal(innerParams.get('client_id'), OFFICEACE.clientId)
  assert.equal(innerParams.get('state'), 'st')
  assert.equal(innerParams.get('code_challenge'), pkce.challenge)

  // ── 假上游 ──
  let pollCount = 0
  let pollMode = 'pending_then_ok'
  const seen = []
  const upstream = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, auth: req.headers.authorization })
      const json = (s, b) => res.writeHead(s, { 'Content-Type': 'application/json', Connection: 'close' }).end(JSON.stringify(b))
      if (req.url === '/v1/claw/auth/state') return json(200, { state: 'st-1' })
      if (req.url.startsWith('/v1/claw/auth/code')) {
        pollCount++
        if (pollMode === 'gone') return json(404, { error: 'unknown state' })
        // 前两次 202，第三次 200
        if (pollCount < 3) return res.writeHead(202, { Connection: 'close' }).end('')
        return json(200, { code: 'auth-code-1' })
      }
      if (req.url.startsWith('/v1/claw/client-permission-validate')) {
        return json(200, { account_id: 'acc-1', nickname: 'alice', project_id: 'proj-1', subscription: { model_info: [{ id: 'm1' }] } })
      }
      if (req.url === '/v2/models') return json(200, { data: [{ id: 'm1', name: 'Model One', context_length: 128000 }] })
      if (req.url === '/v2/chat/completions') {
        if (req.headers.authorization !== `Basic ${btoa('k:s')}`) {
          res.writeHead(401, { Connection: 'close' }).end('{}')
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' })
        res.end([
          'data: {"choices":[{"delta":{"content":"你好"},"finish_reason":null}]}',
          'data: {"choices":[{"delta":{"content":"世界"},"finish_reason":"stop"}]}',
          'data: [DONE]',
        ].join('\n\n') + '\n\n')
        return
      }
      json(404, {})
    })
  })
  await new Promise(r => upstream.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${upstream.address().port}`
  const product = { ...OFFICEACE, cloudBase: base, loginBase: base }

  try {
    // ── ① 取 state ──
    assert.equal(await fetchState(realFetch, product), 'st-1')

    // ── ④ 轮询：先 202 再 200 ──
    pollCount = 0
    const code = await pollAuthCode(realFetch, product, 'st-1', { intervalMs: 10, timeoutMs: 5000 })
    assert.equal(code, 'auth-code-1')
    assert.equal(pollCount, 3, '前两次 202 后拿到 code')

    // ── ④ 轮询：404 立即失败（不拖到超时）──
    pollMode = 'gone'
    const started = Date.now()
    await assert.rejects(() => pollAuthCode(realFetch, product, 'bad', { intervalMs: 10, timeoutMs: 60_000 }), /state 已失效/)
    assert.ok(Date.now() - started < 2000, '404 立即失败，不等到超时')
    pollMode = 'pending_then_ok'

    // ── ⑥ 身份校验 ──
    const perm = await validatePermission(realFetch, product, { base_url: `${base}/v2`, app_key: 'k', app_secret: 's', access_key: 'AK', secret_key: 'SK' })
    assert.equal(perm.accountId, 'acc-1')
    assert.equal(perm.projectId, 'proj-1')
    assert.equal(perm.modelInfo.length, 1)
    // 校验请求带 SDK-HMAC
    const permReq = seen.find(x => x.url.startsWith('/v1/claw/client-permission-validate'))
    assert.ok(permReq.auth.startsWith('SDK-HMAC-SHA256 Access=AK,'), '用 SDK-HMAC 签名')

    // ── 适配器端到端（OpenAI 兼容 + Basic）──
    const adapter = new OfficeAceAdapter({
      product, fetchImpl: realFetch,
      resolveCredential: async () => ({ base_url: `${base}/v2`, app_key: 'k', app_secret: 's' }),
    })
    const models = await adapter.listModels('officeace')
    assert.equal(models.length, 1)
    assert.equal(models[0].name, 'Model One')
    const chunks = await collect(adapter.stream({
      model: 'm1', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }))
    assert.equal(chunks.filter(c => c.type === 'text-delta').map(c => c.text).join(''), '你好世界')
    assert.ok(chunks.some(c => c.type === 'finish'))

    // 无凭据
    const noCred = new OfficeAceAdapter({ product, fetchImpl: realFetch, resolveCredential: async () => undefined })
    await assert.rejects(
      () => collect(noCred.stream({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })),
      e => e.code === 'MISSING_CREDENTIAL',
    )

    console.log('ok  officeace: DPoP(ES256)/SDK-HMAC/V11(AK-SK 顺序+hex 密钥)/Basic 推理/轮询读状态码/凭据解析')
  } finally {
    upstream.closeAllConnections?.()
    await new Promise(r => upstream.close(r))
  }
}

export async function verifyOfficeAce() { await main() }

// 单独运行时必须失败（不能静默 exit 0）：见 scripts/lib/direct-run.mjs。
import { exitIfDirectRun } from './lib/direct-run.mjs'
exitIfDirectRun(import.meta.url, 'officeace-test')
