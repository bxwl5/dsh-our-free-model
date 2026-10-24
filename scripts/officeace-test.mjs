/** OfficeAce：DPoP/两套签名/Basic 推理/轮询取码（读状态码）/凭据解析/PKCE 口径。 */
import assert from 'node:assert/strict'
import http from 'node:http'
import crypto from 'node:crypto'

const collect = async (it) => { const out = []; for await (const c of it) out.push(c); return out }

/** 独立的 base64url(SHA-256(input)) 复算（与被测代码完全解耦）。 */
function sha256Base64Url(text) {
  return crypto.createHash('sha256').update(text).digest('base64url')
}

/** 造一枚形态对齐上游的 JWT（payload 可控；签名段随便填，业务不验签）。 */
function fakeJwt(claims) {
  const b64u = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  return `${b64u({ alg: 'none' })}.${b64u(claims)}.sig`
}

async function main() {
  const {
    base64UrlEncode, createDpopKeyPair, createDpopProof, toHex, hmacSha256, sha256Hex,
    buildCanonicalRequest, signSdkHmac, signV11, formatSdkDate, exportDpopJwkPair,
    createDpopProofFromJwk,
  } = await import('../vendor/channel-pack/src/officeace-dpop.ts')
  const {
    normalizeBaseUrl, basicAuthHeader, parseCredential, isCredentialUsable,
    createPkcePair, buildAuthorizeUrl, fetchState, pollAuthCode, validatePermission,
    exchangeCodeForSts, refreshOfficeAceCredential, parseSubscriptionSnapshot,
    fetchSubscriptionSnapshot,
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

  // ── PKCE：base64url 口径（STS5.1805 回归锁）──
  // 真机缺陷：早期实现用十六进制编码 verifier/challenge，华为云 STS 按
  // base64url(sha256(verifier)) 重算比对，hex 永远对不上 → 换码报
  // {"error_code":"STS5.1805","error_msg":"invalid authorization code"}。
  // 权威口径：Q-shuang-dot/officeace2api generatePkce() 与
  // aimod-cc/Agent2API providers/officeace/oauth.rs（均逆向官方客户端）。
  const pkce = await createPkcePair()
  assert.match(pkce.verifier, /^[A-Za-z0-9_-]{43}$/, 'verifier 必须是 43 字符 base64url（RFC 7636）')
  assert.ok(!/[+/=]/.test(pkce.verifier), 'verifier 必须是 URL 安全字母表（不得含 + / =）')
  assert.match(pkce.challenge, /^[A-Za-z0-9_-]{43}$/, 'challenge 必须是 43 字符 base64url')
  assert.ok(!/[+/=]/.test(pkce.challenge), 'challenge 必须是 URL 安全字母表（不得含 + / =）')
  // 独立复算：challenge = base64url(sha256(verifier)) —— 换码时 STS 就是这么校验的。
  assert.equal(pkce.challenge, sha256Base64Url(pkce.verifier), 'challenge 必须等于 base64url(sha256(verifier))')
  assert.notEqual(pkce.challenge, crypto.createHash('sha256').update(pkce.verifier).digest('hex'), 'challenge 不得是 hex（STS5.1805 根因）')
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
  // 换码端点按官方客户端口径校验 PKCE（STS5.1805 的本地复现）：
  // authorize 时绑定的 challenge 与 code_verifier 必须成对。
  let flowChallenge = ''
  // 续期链的「当前有效 refresh_token」（一次性轮换：换出 rt-2 后 rt-1 即作废）。
  let currentRefreshToken = 'rt-1'
  const stsSeen = []
  const subSeen = []
  const upstream = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      seen.push({
        url: req.url, method: req.method, auth: req.headers.authorization,
        'x-security-token': req.headers['x-security-token'],
        'x-project-id': req.headers['x-project-id'],
      })
      const json = (s, b) => res.writeHead(s, { 'Content-Type': 'application/json', Connection: 'close' }).end(JSON.stringify(b))
      if (req.url === '/v1/claw/auth/state') return json(200, { state: 'st-1' })
      if (req.url.startsWith('/v1/claw/auth/code')) {
        pollCount++
        if (pollMode === 'gone') return json(404, { error: 'unknown state' })
        // 前两次 202，第三次 200
        if (pollCount < 3) return res.writeHead(202, { Connection: 'close' }).end('')
        return json(200, { code: 'auth-code-1' })
      }
      if (req.url === '/v1/oauth2/tokens') {
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
        stsSeen.push({
          grantType: form.get('grant_type'),
          clientId: form.get('client_id'),
          code: form.get('code'),
          redirectUri: form.get('redirect_uri'),
          verifier: form.get('code_verifier'),
          refreshToken: form.get('refresh_token'),
          dpop: req.headers.dpop,
          contentType: req.headers['content-type'],
        })
        // PKCE 校验：challenge 必须等于 base64url(sha256(code_verifier))。
        // 早期 hex 实现在这里被拒（STS5.1805）—— 这条断言把根因锁死。
        if (form.get('grant_type') === 'authorization_code'
          && sha256Base64Url(form.get('code_verifier') ?? '') !== flowChallenge) {
          return json(400, { error_code: 'STS5.1805', error_msg: 'invalid authorization code' })
        }
        // 续期请求（grant_type=refresh_token）：实测口径（2026-10-24）——
        // 回 credentials.{access_key_id,secret_access_key,security_token,expiration}
        //（project_id 与 id_token 均缺席），refresh_token 轮换。
        if (form.get('grant_type') === 'refresh_token') {
          // 一次性轮换锁：只有「当前有效那份」能换新；旧值重放报 1806。
          if (form.get('refresh_token') !== currentRefreshToken) {
            return json(400, { error_code: 'STS5.1806', error_msg: 'the refresh token has been used' })
          }
          currentRefreshToken = 'rt-2'
          return json(200, {
            credentials: {
              access_key_id: 'AKIA-2',
              secret_access_key: 'SK-2',
              security_token: 'sec-token-2',
              expiration: '2026-01-03T03:04:05Z',
            },
            refresh_token: 'rt-2',
          })
        }
        // 真实响应形态（officeace2api _exchangeCode / Agent2API exchange_code）：
        // 推理网关三件套不在这发里；昵称藏在 id_token 的 user_profile（base64 JSON）。
        return json(200, {
          credentials: {
            access_key_id: 'AKIA-1',
            secret_access_key: 'SK-1',
            security_token: 'sec-token-1',
            project_id: 'proj-1',
            expiration: '2026-01-02T03:04:05Z',
          },
          refresh_token: 'rt-1',
          id_token: fakeJwt({ user_profile: Buffer.from(JSON.stringify({ account_name: 'alice', principal_id: 'prin-1' })).toString('base64url') }),
        })
      }
      if (req.url === '/v1/subscription') {
        // 订阅/积分端点（t4 实测形态，V11 签名 + x-subscription-type: v2）：
        // skus[].quotas[] 的 officeace_points / online_search_count + bonus_skus[]。
        subSeen.push({
          auth: req.headers.authorization,
          subscriptionType: req.headers['x-subscription-type'],
          securityToken: req.headers['x-security-token'],
        })
        return json(200, {
          subscribe_status: 'SUBSCRIBED',
          skus: [{
            sku_code: 'officeace.personal.package.trial',
            sku_name: '个人体验版',
            expired_time: '2026-11-24T22:47:17.496Z',
            quotas: [
              { sku_attr_code: 'officeace_points', sku_value: '500', current_value: '100', expired_time: '2026-11-24T22:47:17.496Z' },
              { sku_attr_code: 'online_search_count', sku_value: '200', current_value: '20', expired_time: '2026-11-24T22:47:17.496Z' },
              // 过期的配额不进剩余（officeace2api summarizeSubscription 同口径）
              { sku_attr_code: 'officeace_points', sku_value: '300', current_value: '0', expired_time: '2020-01-01T00:00:00Z' },
            ],
          }],
          bonus_skus: [
            { activity_id: 'bonus-new-user-2026', activity_name: '新用户专属福利', points: '4000', current_value: '0', expired_time: '2027-01-22T14:47:20.530Z' },
            // 过期的奖励不进剩余
            { activity_id: 'bonus-old', activity_name: '已过期奖励', points: '999', current_value: '0', expired_time: '2020-01-01T00:00:00Z' },
            // 当日签到奖励（过期时间设为当天结束时是活的）
            { activity_id: 'bonus-daily-checkin-2026', activity_name: '每日签到有礼', points: '100', current_value: '0', expired_time: '2099-01-01T00:00:00Z' },
          ],
        })
      }
      if (req.url.startsWith('/v1/claw/client-permission-validate')) {
        return json(200, {
          account_id: 'acc-1', principal_id: 'prin-1', project_id: 'proj-1',
          subscription: {
            model_info: {
              model_api_url_base: `https://gw.example.com`,
              model_auth_info: { model_app_key: 'k', model_app_secret: 's' },
            },
          },
        })
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
  const product = { ...OFFICEACE, cloudBase: base, loginBase: base, stsBase: base }

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

    // ── ⑤ 换码端到端：PKCE 成对 + 真实响应形态（STS5.1805 回归锁）──
    // 用同一对 verifier/challenge 走完「授权 URL → 轮询 → 换码」：
    // challenge 从授权 URL 里原样取出，假 STS 按 base64url(sha256(code_verifier))
    // 重算比对 —— 早期 hex 实现在这里拿到 400 STS5.1805，修后必须 200。
    {
      pollCount = 0
      const pkce2 = await createPkcePair()
      const authUrl2 = buildAuthorizeUrl(product, 'st-1', pkce2.challenge)
      const inner2 = new URL(decodeURIComponent(new URL(authUrl2).searchParams.get('service') ?? ''))
      flowChallenge = inner2.searchParams.get('code_challenge') ?? ''
      assert.notEqual(flowChallenge, '', '授权 URL 必须带 code_challenge')
      const code = await pollAuthCode(realFetch, product, 'st-1', { intervalMs: 10, timeoutMs: 5000 })
      const dpopKey = await createDpopKeyPair()
      const sts = await exchangeCodeForSts(realFetch, product, code, pkce2.verifier, dpopKey)
      // 换码请求形状（对照 officeace2api _exchangeCode / Agent2API exchange_code）
      assert.equal(stsSeen.length, 1)
      const req = stsSeen[0]
      assert.equal(req.grantType, 'authorization_code')
      assert.equal(req.clientId, OFFICEACE.clientId, 'client_id 必须是官方值 pdp5_for_agentarts')
      assert.equal(req.code, 'auth-code-1')
      assert.equal(req.redirectUri, OFFICEACE.redirectUri, 'redirect_uri 与授权时逐字相同（云端回调）')
      assert.equal(req.verifier, pkce2.verifier, 'code_verifier 必须是授权时 challenge 的原 verifier')
      assert.ok((req.contentType ?? '').startsWith('application/x-www-form-urlencoded'), '表单编码')
      assert.equal((req.dpop ?? '').split('.').length, 3, 'DPoP 头是三段 JWS')
      // 响应解析：credentials.* + refresh_token + id_token 里的昵称
      assert.equal(sts.access_key, 'AKIA-1')
      assert.equal(sts.secret_key, 'SK-1')
      assert.equal(sts.security_token, 'sec-token-1')
      assert.equal(sts.project_id, 'proj-1')
      assert.equal(sts.refresh_token, 'rt-1', '一次性 refresh_token 必须落库（续期链钥匙）')
      assert.equal(sts.expire_time, Date.parse('2026-01-02T03:04:05Z'))
      assert.equal(sts.nickname, 'alice', '昵称从 id_token.user_profile（base64 JSON）解出')
      // DPoP 密钥对可导出落库（续期签 proof 必须同一把私钥）
      const exported = await exportDpopJwkPair(dpopKey)
      assert.equal(exported.privateJwk.kty, 'EC')
      assert.equal(exported.privateJwk.d.length > 20, true, '私钥 JWK 含 d')
      assert.equal(exported.publicJwk.crv, 'P-256')

      // ── ⑥ 身份校验：model_info 是对象；网关三件套从这里下发 ──
      const perm = await validatePermission(realFetch, product, sts)
      assert.equal(perm.accountId, 'acc-1')
      assert.equal(perm.principalId, 'prin-1')
      assert.equal(perm.projectId, 'proj-1')
      assert.equal(perm.baseUrl, 'https://gw.example.com/v2', '基址规范化到 /v2')
      assert.equal(perm.appKey, 'k')
      assert.equal(perm.appSecret, 's')
      assert.equal(perm.modelInfo?.model_auth_info?.model_app_key, 'k', 'model_info 是对象（不是数组）')
      // 校验请求带 SDK-HMAC（AK 来自 STS）+ STS 头（签名头集合含 x-security-token / x-project-id）
      const permReq = [...seen].reverse().find(x => x.url.startsWith('/v1/claw/client-permission-validate'))
      assert.ok(permReq.auth.startsWith('SDK-HMAC-SHA256 Access=AKIA-1,'), '用 SDK-HMAC 签名（AK 来自 STS）')
      assert.equal(permReq['x-security-token'], 'sec-token-1', '必须带 X-Security-Token（且纳入签名）')
      assert.equal(permReq['x-project-id'], 'proj-1', '必须带 X-Project-ID（且纳入签名）')
    }

    // ── ⑥ 无 STS token 的最小凭据：签名头集合退化为 host+x-sdk-date ──
    {
      const perm = await validatePermission(realFetch, product, { base_url: `${base}/v2`, app_key: 'k', app_secret: 's', access_key: 'AK', secret_key: 'SK' })
      assert.equal(perm.accountId, 'acc-1')
      assert.equal(perm.projectId, 'proj-1')
      assert.equal(perm.modelInfo?.model_auth_info?.model_app_key, 'k')
      assert.ok(perm.appKey === 'k' && perm.appSecret === 's' && perm.baseUrl === 'https://gw.example.com/v2')
      const permReq = [...seen].reverse().find(x => x.url.startsWith('/v1/claw/client-permission-validate'))
      assert.ok(permReq.auth.startsWith('SDK-HMAC-SHA256 Access=AK,'), '用 SDK-HMAC 签名')
      assert.equal(permReq['x-security-token'], undefined, '无 STS token 时不带 X-Security-Token')
    }

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

    // ── ⑧ 续期（t4）：refresh_token grant + DPoP（JWK 形态）──
    // 实测口径（2026-10-24，真实账号连续两次 200）：STS 续期回新 AK/SK，
    // refresh_token 轮换（旧值即刻作废）；重放旧值 = STS5.1806。
    {
      const dpopKey = await createDpopKeyPair()
      const exported = await exportDpopJwkPair(dpopKey)
      const loginCred = {
        base_url: 'https://gw.example.com/v2', app_key: 'k', app_secret: 's',
        access_key: 'AKIA-1', secret_key: 'SK-1', security_token: 'sec-token-1',
        refresh_token: 'rt-1', expire_time: Date.parse('2026-01-02T03:04:05Z'),
        dpop: exported,
      }
      const refreshed = await refreshOfficeAceCredential(realFetch, product, loginCred)
      // 请求形状：grant_type=refresh_token，无 code/code_verifier/redirect_uri
      const refreshReq = [...stsSeen].reverse().find(r => r.grantType === 'refresh_token')
      assert.ok(refreshReq, '必须打 STS 续期端点')
      assert.equal(refreshReq.clientId, OFFICEACE.clientId)
      assert.equal(refreshReq.refreshToken, 'rt-1')
      assert.equal(refreshReq.code, null, '续期不带 code')
      assert.equal(refreshReq.verifier, null, '续期不带 code_verifier')
      assert.equal((refreshReq.dpop ?? '').split('.').length, 3, 'DPoP 头（JWK 密钥签的）')
      // 响应解析：新 AK/SK + 轮换 token；推理凭据与 dpop 保留
      assert.equal(refreshed.access_key, 'AKIA-2')
      assert.equal(refreshed.secret_key, 'SK-2')
      assert.equal(refreshed.security_token, 'sec-token-2')
      assert.equal(refreshed.refresh_token, 'rt-2', '轮换出的新 refresh_token 必须带着')
      assert.equal(refreshed.expire_time, Date.parse('2026-01-03T03:04:05Z'))
      assert.equal(refreshed.base_url, 'https://gw.example.com/v2', '续期不得覆盖推理网关三件套')
      assert.equal(refreshed.app_key, 'k')
      assert.deepEqual(refreshed.dpop, exported, 'DPoP 私钥必须原样保留')
      // 重放旧 token = STS5.1806（一次性轮换）
      await assert.rejects(
        () => refreshOfficeAceCredential(realFetch, product, loginCred),
        /STS5\.1806|refresh token has been used/,
        '旧 refresh_token 重放必须报 1806（一次性轮换锁死）',
      )
      // 无 refresh_token / 无 dpop：明确报错（不装成功）
      await assert.rejects(
        () => refreshOfficeAceCredential(realFetch, product, { ...loginCred, refresh_token: undefined }),
        /没有 refresh_token/,
      )
      await assert.rejects(
        () => refreshOfficeAceCredential(realFetch, product, { ...loginCred, dpop: undefined }),
        /没有 DPoP 私钥/,
      )
      // createDpopProofFromJwk 与 createDpopProof 用同一把钥匙产出可验证结构
      const jwkProof = await createDpopProofFromJwk(exported, 'POST', 'https://sts.example.com/v1/oauth2/tokens')
      assert.equal(jwkProof.split('.').length, 3)
      const jwkHeader = JSON.parse(atob(jwkProof.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')))
      assert.equal(jwkHeader.jwk.x, exported.publicJwk.x, 'JWK proof 头部嵌同一公钥')
    }

    // ── ⑨ 订阅/积分（t4）：parseSubscriptionSnapshot + fetchSubscriptionSnapshot ──
    // 实测形态（2026-10-24，真实账号 HTTP 200）：officeace_points 500 总额 /
    // 100 已用 + bonus（新用户 4000 / 每日签到 100）；剩余 = 500-100 + 4000 + 100。
    {
      const snapshot = parseSubscriptionSnapshot({
        subscribe_status: 'SUBSCRIBED',
        skus: [{
          sku_code: 'officeace.personal.package.trial', sku_name: '个人体验版',
          expired_time: '2026-11-24T22:47:17.496Z',
          quotas: [
            { sku_attr_code: 'officeace_points', sku_value: '500', current_value: '100', expired_time: '2026-11-24T22:47:17.496Z' },
            { sku_attr_code: 'officeace_points', sku_value: '300', current_value: '0', expired_time: '2020-01-01T00:00:00Z' },
            { sku_attr_code: 'online_search_count', sku_value: '200', current_value: '20', expired_time: '2026-11-24T22:47:17.496Z' },
          ],
        }],
        bonus_skus: [
          { activity_id: 'bonus-new-user-2026', activity_name: '新用户专属福利', points: '4000', current_value: '0', expired_time: '2027-01-22T14:47:20.530Z' },
          { activity_id: 'bonus-old', activity_name: '已过期奖励', points: '999', current_value: '0', expired_time: '2020-01-01T00:00:00Z' },
          { activity_id: 'bonus-daily-checkin-2026', activity_name: '每日签到有礼', points: '100', current_value: '0', expired_time: '2099-01-01T00:00:00Z' },
        ],
      })
      // 字符串数字（上游实测全发字符串）+ 过期配额剔除
      assert.equal(snapshot.total, 500 + 4000 + 100, '总额 = 套餐(500) + 有效奖励(4000+100)')
      assert.equal(snapshot.used, 100)
      assert.equal(snapshot.remaining, 4500, '剩余 = (500-100) + 4000 + 100')
      assert.equal(snapshot.planName, '个人体验版')
      assert.equal(snapshot.planExpiresAt, Date.parse('2026-11-24T22:47:17.496Z'))
      assert.equal(snapshot.searchRemaining, 180, '联网搜索次数剩余 = 200-20')
      assert.equal(snapshot.packages.length, 3, '套餐 + 新用户 + 每日签到（过期奖励剔除）')
      assert.ok(snapshot.packages.some(p => p.name === '每日签到有礼' && p.remaining === 100))
      // 空响应不炸
      const empty = parseSubscriptionSnapshot({})
      assert.equal(empty.total, 0)
      assert.equal(empty.remaining, 0)
      assert.deepEqual(empty.packages, [])

      // 端到端：凭据（带 model_info.model_api_url_base）→ 假网关 → 快照。
      // 上游发的是裸 host（代码统一补 https）；测试替身显式带 http:// 打本机假上游。
      const credWithGateway = {
        base_url: `${base}/v2`, app_key: 'k', app_secret: 's',
        access_key: 'AKIA-2', secret_key: 'SK-2', security_token: 'sec-token-2',
        model_info: { model_api_url_base: base },
      }
      const liveSnapshot = await fetchSubscriptionSnapshot(realFetch, product, credWithGateway)
      assert.equal(liveSnapshot.total, 4600)
      assert.equal(liveSnapshot.remaining, 4500)
      assert.equal(liveSnapshot.searchRemaining, 180)
      assert.equal(liveSnapshot.planName, '个人体验版')
      // 请求头：V11 签名 + x-subscription-type: v2 + STS token
      const subReq = [...subSeen].pop()
      assert.ok(subReq.auth.startsWith('V11-HMAC-SHA256 Credential=AKIA-2/'), '订阅查询用 V11 签名')
      assert.ok(subReq.auth.includes('/cn-southwest-2/apic'), 'scope 是 <date>/cn-southwest-2/apic')
      assert.equal(subReq.subscriptionType, 'v2', '必须带 x-subscription-type: v2')
      assert.equal(subReq.securityToken, 'sec-token-2', '必须带 X-Security-Token')
      // 缺 model_info 的凭据：明确报错（引导重登）
      await assert.rejects(
        () => fetchSubscriptionSnapshot(realFetch, product, { base_url: `${base}/v2`, app_key: 'k', app_secret: 's', access_key: 'AK', secret_key: 'SK' }),
        /model_api_url_base/,
      )
    }

    console.log('ok  officeace: DPoP(ES256)/SDK-HMAC(含 STS 头)/V11(AK-SK 顺序+hex 密钥)/PKCE(base64url)/换码(STS5.1805 回归)/续期(refresh_token 轮换 + 1806 重放锁)/订阅积分(skus+bonus+过期剔除+V11 签名)/Basic 推理/轮询读状态码/凭据解析')
  } finally {
    upstream.closeAllConnections?.()
    await new Promise(r => upstream.close(r))
  }
}

export async function verifyOfficeAce() { await main() }

// 单独运行时必须失败（不能静默 exit 0）：见 scripts/lib/direct-run.mjs。
import { exitIfDirectRun } from './lib/direct-run.mjs'
exitIfDirectRun(import.meta.url, 'officeace-test')
