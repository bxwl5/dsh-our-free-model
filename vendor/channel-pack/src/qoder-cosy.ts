/**
 * Qoder COSY 请求签名（Node 原生 crypto 实现，零依赖）。
 *
 * ## 为什么要它
 *
 * Qoder 的推理网关（`/algo/...` 这一族，含**模型目录**
 * `GET /algo/api/v2/model/list?Encode=1`）不认普通 Bearer，而是一套自签名鉴权。
 * 实测（2026-10-26）：只带 Bearer 请求目录端点会得到
 * `403 {"code":"101","message":"Signature invalid"}` —— 这正是
 * qoder/qodercn 这两个渠道的模型列表只能靠静态表、上游上新后必须发版的原因。
 *
 * ## 算法（六步）
 *
 * 1. 组装用户身份 JSON（键序 uid / security_oauth_token / name / aid / email）；
 * 2. 一次性 16 字符 AES 密钥，用它 AES-128-CBC 加密身份 JSON → `info`；
 * 3. 用内置 RSA 公钥（PKCS#1 v1.5）加密该 AES 密钥 → `key`；
 * 4. `{version,requestId,info,cosyVersion,ideVersion}` 序列化后 base64 → `payload`；
 * 5. `MD5(payload \n key \n 时间戳 \n 请求体 \n 签名路径)`；
 * 6. `Authorization: Bearer COSY.<payload>.<签名>` + 一组 `Cosy-*` 头。
 *
 * 签名路径要**去掉 `/algo` 前缀、不含查询串**（服务端按同一规则校验）。
 *
 * ## 来源与可信度
 *
 * 逐行对照 `aimod-cc/Agent2API` 的 `providers/qoder/cosy.rs`（MIT）。该实现
 * 自述「两者的正确性已与 Node 的 `crypto` 逐字节对拍（AES-CBC 密文、MD5 签名、
 * 编码后的请求体全部一致；RSA 走 Rust 加密 → Node 私钥解密的往返验证）」——
 * 因此这里直接用 Node 内置 `crypto` 复刻，不需要 WASM。
 *
 * ⚠️ 键序**必须**照抄：身份 JSON 与 payload 都参与签名/解密，键序变了串就变了。
 * 故这两处用手写模板而不是 `JSON.stringify(object)` 顺带保证顺序。
 */

import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'

/** 网关 COSY 协议版本（客户端内置常量）。 */
export const QODER_COSY_VERSION = '1.1.38'
/** 客户端类型（桌面端）。 */
const CLIENT_TYPE = '5'
/** 数据策略（与客户端一致）。 */
const DATA_POLICY = 'disagree'
/** 登录协议版本。 */
const LOGIN_VERSION = 'v2'
/** 机器类型。 */
const MACHINE_TYPE = '5'
/** 客户端 IP 占位（源实现写死回环地址）。 */
const CLIENT_IP = '127.0.0.1'

/**
 * 客户端内置的 RSA 公钥模数（1024 位，十六进制）。
 *
 * 来源：源实现 `RSA_PUBLIC_KEY` 的 PEM 正文。服务端用它对应的私钥解开 `key`，
 * 拿到一次性 AES 密钥后解密 `info`。改它等于换一把不认识我们的公钥。
 */
const RSA_MODULUS_HEX = 'c0f22307e5cd362e296bb04470f6de8fbf935ce24e8fcf511a0e2701329769c4'
  + 'a76e499bb938036a52af1eaf818cf79a2600620e3ce87e371d2ca6d85803606a1b3fa5e874643c9ed2db7e85673ef722'
  + '7fca56e2e7c08f0927609bb896a9f24be1782099a66016a5bfdc3f1ff756bfc9e88d7b5dc5be30bf45a0223a00ebcecf'
/** RSA 公钥指数。 */
const RSA_EXPONENT = 65537n

/** 请求体编码用的自定义字符表（源实现 `CUSTOM_ALPHABET`）。 */
const CUSTOM_ALPHABET = '_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!'
/** 标准 base64 字符表。 */
const STD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 签名所需的用户身份。 */
export interface QoderCosyIdentity {
  /** 用户 id（凭据里的 `uid`）。 */
  userId: string
  /** 访问令牌（凭据里的 `access_token`）。 */
  authToken: string
  name: string
  email: string
  /** 机器 id（凭据里的 `machine_id`）。 */
  machineId: string
}

/** 机器操作系统标识（源实现 `machineOs`：`{arch}_{platform}`）。 */
function machineOs(): string {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  const platform = process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin' ? 'darwin' : 'linux'
  return `${arch}_${platform}`
}

/** 手写 JSON 字符串转义（与源实现 `json_text` 同语义）。 */
function jsonText(value: string): string {
  return JSON.stringify(value)
}

/**
 * AES-128-CBC 加密后 base64。
 *
 * ⚠️ **IV 就是密钥本身**（源实现如此）；PKCS#7 补位由 OpenSSL 完成
 * （Node 的 `createCipheriv` 默认就补）。
 */
function aes128CbcBase64(key16: string, plaintext: Buffer): string {
  const key = Buffer.from(key16, 'utf8')
  if (key.length !== 16) throw new Error('Qoder 签名密钥长度无效')
  const cipher = createCipheriv('aes-128-cbc', key, key)
  return Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64')
}

/** 大整数模幂（BigInt 版 `modpow`）。 */
function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n
  let b = base % modulus
  let e = exponent
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus
    b = (b * b) % modulus
    e >>= 1n
  }
  return result
}

/**
 * RSA 公钥加密（PKCS#1 v1.5），返回 base64。
 *
 * 布局 `00 || 02 || PS || 00 || M`，PS 为**非零随机**字节。PS 固定会让 RSA
 * 退化成确定性加密（可被指纹化），故必须随机。
 */
function rsaEncryptBase64(plaintext: string): string {
  const modulus = BigInt(`0x${RSA_MODULUS_HEX}`)
  const keyLength = Math.ceil(modulus.toString(2).length / 8)
  const message = Buffer.from(plaintext, 'utf8')
  if (message.length + 11 > keyLength) throw new Error('Qoder 签名内容过长')
  const psLength = keyLength - 3 - message.length
  const ps = randomBytes(psLength)
  for (let i = 0; i < ps.length; i++) if (ps[i] === 0) ps[i] = 1
  const encoded = Buffer.concat([
    Buffer.from([0x00, 0x02]), ps, Buffer.from([0x00]), message,
  ])
  const cipher = modPow(BigInt(`0x${encoded.toString('hex')}`), RSA_EXPONENT, modulus)
  const hex = cipher.toString(16).padStart(keyLength * 2, '0')
  return Buffer.from(hex, 'hex').toString('base64')
}

/** 签名路径：去掉 `/algo` 前缀、不含查询串。 */
export function cosySignaturePath(requestUrl: string): string {
  const path = new URL(requestUrl).pathname
  return path.startsWith('/algo') ? path.slice('/algo'.length) : path
}

/**
 * 按 COSY 规则编码请求体（上游带 `Encode=1` 时请求体不是裸 JSON）。
 *
 * 三步纯字节变换：① 标准 base64；② 按「尾段/中段/首段」重排（各段 ⌊n/3⌋，
 * 余数留在中段）；③ 逐字符替换成自定义字母表（`=` → `$`）。
 */
export function encodeCosyBody(payload: Buffer): Buffer {
  const standard = payload.toString('base64')
  const length = standard.length
  const third = Math.floor(length / 3)
  const tail = standard.slice(length - third)
  const middle = standard.slice(third, length - third)
  const head = standard.slice(0, third)
  const reordered = tail + middle + head
  let out = ''
  for (const char of reordered) {
    if (char === '=') { out += '$'; continue }
    const index = STD_ALPHABET.indexOf(char)
    out += index >= 0 ? CUSTOM_ALPHABET[index] : char
  }
  return Buffer.from(out, 'utf8')
}

/**
 * 构造 COSY 鉴权头。
 *
 * @param body 请求体（GET 传 `undefined`；上游按空体签名）
 * @param requestUrl 完整请求地址（用于取签名路径）
 */
export function buildCosyHeaders(
  body: Buffer | undefined,
  requestUrl: string,
  identity: QoderCosyIdentity,
  now: number = Date.now(),
): Record<string, string> {
  if (identity.userId === '') throw new Error('Qoder 账号缺少用户标识，无法签名')
  if (identity.authToken === '') throw new Error('Qoder 账号缺少访问令牌，请重新登录')

  const aesKey = randomBytes(32).toString('hex').slice(0, 16)
  // 键序照抄源实现（uid/security_oauth_token/name/aid/email）。
  const userInfo = `{"uid":${jsonText(identity.userId)},"security_oauth_token":`
    + `${jsonText(identity.authToken)},"name":${jsonText(identity.name)},"aid":"","email":${jsonText(identity.email)}}`
  const info = aes128CbcBase64(aesKey, Buffer.from(userInfo, 'utf8'))
  const cosyKey = rsaEncryptBase64(aesKey)

  const requestId = randomUUID()
  const timestamp = String(Math.floor(now / 1000))
  // 键序照抄：version/requestId/info/cosyVersion/ideVersion。
  const payloadSource = `{"version":"v1","requestId":"${requestId}","info":"${info}",`
    + `"cosyVersion":"${QODER_COSY_VERSION}","ideVersion":""}`
  const payload = Buffer.from(payloadSource, 'utf8').toString('base64')

  const sigPath = cosySignaturePath(requestUrl)
  const bodyBytes = body ?? Buffer.alloc(0)
  // MD5(payload \n key \n 时间戳 \n 请求体 \n 签名路径)
  const signature = createHash('md5')
    .update(payload).update('\n')
    .update(cosyKey).update('\n')
    .update(timestamp).update('\n')
    .update(bodyBytes).update('\n')
    .update(sigPath)
    .digest('hex')
  const bodyHash = createHash('md5').update(bodyBytes).digest('hex')

  return {
    Authorization: `Bearer COSY.${payload}.${signature}`,
    'Cosy-Key': cosyKey,
    'Cosy-User': identity.userId,
    'Cosy-Date': timestamp,
    'Cosy-Version': QODER_COSY_VERSION,
    'Cosy-Machineid': identity.machineId,
    'Cosy-Machinetoken': identity.machineId,
    'Cosy-Machinetype': MACHINE_TYPE,
    'Cosy-Machineos': machineOs(),
    'Cosy-Clienttype': CLIENT_TYPE,
    'Cosy-Clientip': CLIENT_IP,
    'Cosy-Bodyhash': bodyHash,
    'Cosy-Bodylength': String(bodyBytes.length),
    'Cosy-Sigpath': sigPath,
    'Cosy-Data-Policy': DATA_POLICY,
    'Cosy-Organization-Id': '',
    'Cosy-Organization-Tags': '',
    'Login-Version': LOGIN_VERSION,
    'X-Request-Id': requestId,
  }
}
