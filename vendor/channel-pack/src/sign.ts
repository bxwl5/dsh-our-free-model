/** 华为云 SDK-HMAC-SHA256 请求签名 extraHeaders */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data.slice().buffer as ArrayBuffer)
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function hmacSha256Hex(key: Uint8Array, data: Uint8Array): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey('raw', key.slice().buffer as ArrayBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, data.slice().buffer as ArrayBuffer)
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 规范化 query（华为 APIG 签名规范）：按 key 排序、值 RFC3986 编码。
 *
 * ⚠ 真实缺陷（2026-10-29 实锤）：原实现把 query **原样**放进 canonical request。
 * 对无 query 的端点（builtin/statistics）没事；一旦带多个参数（agent-center 的
 * `?offset=0&limit=100`），canonical 里 offset 排在 limit 前，与服务端按规范
 * 重算的顺序（limit 在前）不一致 → `APIG.0301 verify ak sk signature fail`。
 * 实测：同一凭据 `?limit=100&offset=0`（恰好已排序）200、
 * `?offset=0&limit=100` 401；用「排序后的 query 签名 + 原始顺序 URL 发请求」
 * 200 —— 坐实。magpie 的 canonicalQuery 同款排序，agent-center 一直能过。
 */
export function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .join('&')
}

/** RFC3986 保留字符编码（华为规范引用）——与 encodeURIComponent 的差别是 !'()* 不转义。 */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
}

export function buildCanonicalRequest(
  method: string,
  uri: string,
  query: string,
  headers: Map<string, string>,
  payloadHash: string,
): string {
  const signedHeaders: string[] = []
  headers.forEach((_, k) => signedHeaders.push(k))
  signedHeaders.sort()
  const headerLines = signedHeaders.map((k) => `${k}:${headers.get(k) ?? ''}`)
  return [method, uri, query, headerLines.join('\n'), '', signedHeaders.join(';'), payloadHash].join('\n')
}

/** 签名一个华为请求；返回需合并到请求中的头映射。 */
export async function signRequestHuawei(
  ak: string,
  sk: string,
  securityToken: string,
  method: string,
  urlStr: string,
  body: Uint8Array,
  extraHeaders?: Readonly<Record<string, string>>,
): Promise<Map<string, string>> {
  const url = new URL(urlStr)
  let uri = url.pathname
  if (!uri.endsWith('/')) uri += '/'
  const query = canonicalQuery(url)
  const dateStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const payloadHash = await sha256Hex(body)

  const headers = new Map<string, string>()
  headers.set('host', url.host)
  headers.set('x-sdk-date', dateStamp)
  headers.set('x-sdk-content-sha256', payloadHash)
  headers.set('x-security-token', securityToken)
  // 额外的签名头（如 glm-5.3-flash 的 maas_type: benefit）：与 Rust 参考实现
  // sign_request_huawei 的 extra_headers 一致，参与 canonical 计算并包含在
  // SignedHeaders 中，需原样随请求发送，否则服务端验签失败。
  if (extraHeaders !== undefined) {
    for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value)
  }
  // GET 请求（排队状态轮询）不携带请求体，因此无 content-type。
  if (method.toUpperCase() !== 'GET') headers.set('content-type', 'application/json')

  const signedHeaders: string[] = []
  headers.forEach((_, k) => signedHeaders.push(k))
  signedHeaders.sort()

  const canonicalRequest = buildCanonicalRequest(method, uri, query, headers, payloadHash)
  const canonicalHash = await sha256Hex(new TextEncoder().encode(canonicalRequest))
  const stringToSign = `SDK-HMAC-SHA256\n${dateStamp}\n${canonicalHash}`
  const signature = await hmacSha256Hex(new TextEncoder().encode(sk), new TextEncoder().encode(stringToSign))
  headers.set('Authorization', `SDK-HMAC-SHA256 Access=${ak},SignedHeaders=${signedHeaders.join(';')},Signature=${signature}`)
  return headers
}
