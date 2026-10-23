/**
 * DPoP proof（RFC 9449）与华为云 V11-HMAC-SHA256 签名。
 *
 * 为什么单独一个文件：这两件事在 OfficeAce 的链路里各只出现一次，
 * 但都**极易写错且写错后表现为 401/400**，与「凭据失效」形态相同 ——
 * 混在业务流程里会让排障方向完全跑偏。独立出来便于单测锁死。
 *
 * ## DPoP
 *
 * 一个 ES256 的 JWS：头部嵌**公钥 JWK**，载荷带 `htm`/`htu`/`iat`/`jti`。
 * ⚠️ `htu` 用**完整地址且不带 fragment**；`htm` 大写。
 *
 * ## V11-HMAC-SHA256
 *
 * 与 SDK-HMAC 的差别（实测记录）：
 * 1. 派生密钥的**十六进制字符串**参与第二次 HMAC，不是原始字节；
 * 2. 待签串的组装顺序不同（见 `buildV11CanonicalRequest`）。
 */

/** 一份 P-256 密钥对（私钥用于签名，公钥 JWK 嵌进 JWS 头）。 */
export interface DpopKeyPair {
  /** 私钥（CryptoKey，ES256 签名用）。 */
  privateKey: CryptoKey
  /** 公钥 JWK（嵌进 JWS 头）。 */
  publicJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string }
}

/** base64url 编码（无 padding）。 */
export function base64UrlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * 生成一对 P-256 密钥。
 *
 * 用 WebCrypto（`crypto.subtle`）：与插件其它地方（`sign.ts`）同一套 API，
 * 不引入 Node 专有调用，也不加依赖。
 */
export async function createDpopKeyPair(): Promise<DpopKeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey
  return {
    privateKey: pair.privateKey,
    publicJwk: {
      kty: 'EC',
      crv: 'P-256',
      x: String(exported.x ?? ''),
      y: String(exported.y ?? ''),
    },
  }
}

/**
 * 构造一份 DPoP proof。
 *
 * @param key 密钥对
 * @param method HTTP 方法（会被转成大写）
 * @param url 完整地址（**不带 fragment**）
 */
export async function createDpopProof(
  key: DpopKeyPair,
  method: string,
  url: string,
): Promise<string> {
  const header = {
    alg: 'ES256',
    typ: 'dpop+jwt',
    jwk: key.publicJwk,
  }
  const jtiBytes = crypto.getRandomValues(new Uint8Array(32))
  const payload = {
    htm: method.toUpperCase(),
    htu: url,
    iat: Math.floor(Date.now() / 1000),
    jti: Array.from(jtiBytes).map((byte) => byte.toString(16).padStart(2, '0')).join(''),
  }
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key.privateKey,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`
}

/** 十六进制编码。 */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** HMAC-SHA256，返回原始字节。 */
export async function hmacSha256(key: Uint8Array | string, data: string): Promise<Uint8Array> {
  const keyBytes = typeof key === 'string' ? new TextEncoder().encode(key) : key
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes.slice().buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data))
  return new Uint8Array(signature)
}

/**
 * 生成华为云的 `X-Sdk-Date`：**`YYYYMMDDTHHMMSSZ`**（Basic ISO8601，无分隔符）。
 *
 * ⚠️ 这不是标准 ISO8601（`2026-01-01T00:00:00Z`）。写错格式会被上游判为
 * 签名不匹配（401），而报错形态与「凭据失效」相同，极易误判。
 * V11 的 scope 取它的前 8 位当日期（`date[..8]` = `YYYYMMDD`）。
 */
export function formatSdkDate(timestampMs: number): string {
  const d = new Date(timestampMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
    + `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
}

/** SHA-256 十六进制摘要。 */
export async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))
  return toHex(new Uint8Array(digest))
}

/**
 * 构造 canonicalRequest（SDK 与 V11 共用）。
 *
 * 格式（参考实现逐字）：
 * ```
 * METHOD \n canonicalURI \n canonicalQuery \n canonicalHeaders \n signedHeaders \n payloadHash
 * ```
 * ⚠️ `canonicalURI` **强制补尾斜杠**（`/a/b` → `/a/b/`）；
 * 不补会得到完全不同的签名。
 */
export function buildCanonicalRequest(options: {
  method: string
  path: string
  query: string
  host: string
  /** 额外的签名头（按 `x-sdk-date` 等）。 */
  headers: Array<[string, string]>
  payloadHash: string
}): { canonicalRequest: string; signedHeaders: string } {
  const uri = options.path.endsWith('/') ? options.path : `${options.path}/`
  const sorted = [...options.headers].map(([k, v]) => [k.toLowerCase(), v] as const).sort((a, b) => a[0] < b[0] ? -1 : 1)
  const canonicalHeaders = sorted.map(([k, v]) => `${k}:${v}\n`).join('')
  const signedHeaders = sorted.map(([k]) => k).join(';')
  const canonicalRequest = [
    options.method.toUpperCase(),
    uri,
    options.query,
    canonicalHeaders,
    signedHeaders,
    options.payloadHash,
  ].join('\n')
  return { canonicalRequest, signedHeaders }
}

/**
 * SDK-HMAC-SHA256 签名（华为云标准形态）。
 *
 * `stringToSign = "SDK-HMAC-SHA256" \n <X-Sdk-Date> \n sha256hex(canonicalRequest)`
 * `signature = hmacSha256hex(secretKey, stringToSign)`
 */
export async function signSdkHmac(options: {
  accessKey: string
  secretKey: string
  canonicalRequest: string
  signedHeaders: string
  timestampMs: number
}): Promise<{ authorization: string; sdkDate: string }> {
  const sdkDate = formatSdkDate(options.timestampMs)
  const canonicalHash = await sha256Hex(options.canonicalRequest)
  const stringToSign = ['SDK-HMAC-SHA256', sdkDate, canonicalHash].join('\n')
  const signature = toHex(await hmacSha256(options.secretKey, stringToSign))
  return {
    sdkDate,
    authorization: `SDK-HMAC-SHA256 Access=${options.accessKey}, SignedHeaders=${options.signedHeaders}, Signature=${signature}`,
  }
}

/**
 * V11-HMAC-SHA256 签名。
 *
 * 与 SDK 的差别（参考实现文件头第 3 条 + `Algorithm::V11` 分支逐字）：
 * ```
 * scope        = <date[..8]>/<region>/<service>
 * stringToSign = "V11-HMAC-SHA256" \n <date> \n <scope> \n sha256hex(canonicalRequest)
 * step1        = hmacSha256(key = AK, data = SK)        ← ⚠️ 参数顺序反直觉
 * seed         = scope 字节 + 0x01
 * derived      = hmacSha256(step1, seed)[..32]
 * signingKey   = derived 的**十六进制字符串**
 * signature    = hmacSha256hex(signingKey, stringToSign)  ← ⚠️ 用 hex 串当密钥
 * ```
 *
 * ⚠️ **本实现按参考实现逐字复刻，但未经实机验证**：V11 的两处反直觉设计
 * （AK/SK 顺序、hex 串当密钥）都是参考实现作者的实测结论，
 * 本插件没有真实账号复核过。若 OfficeAce 返回 401，先查这里。
 */
export async function signV11(options: {
  accessKey: string
  secretKey: string
  region: string
  service: string
  canonicalRequest: string
  signedHeaders: string
  timestampMs: number
}): Promise<{ authorization: string; sdkDate: string }> {
  const sdkDate = formatSdkDate(options.timestampMs)
  // scope 取 sdkDate 的前 8 位（YYYYMMDD）—— 依赖上面那个格式。
  const scope = `${sdkDate.slice(0, 8)}/${options.region}/${options.service}`
  const canonicalHash = await sha256Hex(options.canonicalRequest)
  const stringToSign = ['V11-HMAC-SHA256', sdkDate, scope, canonicalHash].join('\n')
  // ⚠️ key = AK，data = SK（与 SDK 的 key = SK 相反）。
  const step1 = await hmacSha256(options.accessKey, options.secretKey)
  const seed = new Uint8Array([...new TextEncoder().encode(scope), 1])
  const derived = (await hmacSha256(step1, new TextDecoder().decode(seed))).slice(0, 32)
  const signingKeyHex = toHex(derived)
  // ⚠️ 用十六进制字符串当密钥，不是那 32 个字节。
  const signature = toHex(await hmacSha256(signingKeyHex, stringToSign))
  return {
    sdkDate,
    authorization: `V11-HMAC-SHA256 Credential=${options.accessKey}/${scope}, SignedHeaders=${options.signedHeaders}, Signature=${signature}`,
  }
}
