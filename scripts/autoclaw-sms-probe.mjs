#!/usr/bin/env node
/**
 * AutoClaw（国内站）短信登录的**手动验证工具** —— 默认不入回归，不联网、不发短信。
 *
 * 目的：把「手机号 + 短信验证码」这条链的**请求形状、签名、凭据解析**先钉死，
 * 等实现进 vendor/channel-pack 时可直接搬运，减少真机调试次数（真机代价 = 真发短信）。
 *
 * 用法：
 *   node scripts/autoclaw-sms-probe.mjs                 # dry-run：只打印将要发出的请求
 *   node scripts/autoclaw-sms-probe.mjs --selftest      # 本地假上游跑通全链，不联网
 *   node scripts/autoclaw-sms-probe.mjs --send --phone 138xxxxxxxx
 *                                                       # ⚠️ 真发一条短信到该号码
 *
 * 端点与签名来源（只读核对）：
 *   iJetLi/dsh-providers-hub@master src/autoclaw-oauth.ts:29-30,609-800
 *   iJetLi/dsh-providers-hub@master src/autoclaw-product.ts:287-290
 *   iJetLi/dsh-providers-hub@master src/autoclaw.ts:74-83
 * 本项目侧的结论与风险见 项目文件/research/paste-login-feasibility.md §3.1。
 */
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'

const DEFAULT_BASE = 'https://autoglm-acceleration-api.zhipuai.cn'
const APP_ID = '100003'
const APP_KEY = '38d2391985e2369a5fb8227d8e6cd5e5'
const SOURCE_ID = 'autoclaw'
const SEND_CODE_PATH = '/userapi/v1/agent-send-code'
const LOGIN_PATH = '/userapi/v1/agent-login'
const PHONE_RE = /^1[3-9]\d{9}$/

/** 归一手机号：容忍空格/横线/`+86`/`86` 前缀（用户可能直接粘贴通讯录格式）。 */
export function normalizePhone(raw) {
  const digits = String(raw ?? '').replace(/[\s-]/g, '')
  const local = digits.startsWith('+86') ? digits.slice(3) : digits.startsWith('86') && digits.length === 13 ? digits.slice(2) : digits
  return PHONE_RE.test(local) ? local : ''
}

/** `X-Auth-Sign = md5(appId & timestamp & appKey)`，timestamp 为**秒**。 */
export function sign(appId, timestamp, appKey) {
  return createHash('md5').update(`${appId}&${timestamp}&${appKey}`).digest('hex')
}

/** 两个端点共用的请求头。 */
export function authHeaders(timestamp, signed = sign(APP_ID, timestamp, APP_KEY)) {
  return {
    'Content-Type': 'application/json',
    'X-Auth-Appid': APP_ID,
    'X-Auth-TimeStamp': String(timestamp),
    'X-Auth-Sign': signed,
    'X-Lang': 'zh-CN',
    'X-Channel': 'official',
  }
}

/** 发码请求体。`device_id` 会进登录/签到/续期三处，必须与后续请求保持一致。 */
export function sendCodeBody(phone, deviceId) {
  return { phone, source_id: SOURCE_ID, device_id: deviceId }
}

/** 登录请求体：`code` 是**数字**，不是字符串（照抄上游客户端行为）。 */
export function loginBody(phone, code, deviceId) {
  return { phone, code: Number(code), source_id: SOURCE_ID, device_id: deviceId }
}

/** 从 JWT 取 payload（不校验签名，只用它读 exp / user_id）。 */
function jwtClaims(token) {
  const parts = String(token).split('.')
  if (parts.length < 2) return {}
  try {
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
  } catch {
    return {}
  }
}

/** 把 agent-login 的响应对成凭据；过期时间优先用 JWT 的 exp，读不到就留空（不编造）。 */
export function toCredential(data, deviceId, phone) {
  const access = String(data?.access_token ?? '').replace(/^Bearer\s+/i, '').trim()
  if (access === '') throw new Error('响应缺少 access_token')
  const claims = jwtClaims(access)
  const declared = typeof data.expires_at === 'number'
    ? data.expires_at * (data.expires_at < 1e12 ? 1000 : 1)
    : typeof data.expires_in === 'number'
      ? Date.now() + data.expires_in * 1000
      : undefined
  const expiresAt = typeof claims.exp === 'number' ? claims.exp * 1000 : declared
  const userId = data.user_id ?? claims.user_id
  return {
    access_token: access,
    refresh_token: String(data.refresh_token ?? '').replace(/^Bearer\s+/i, '').trim(),
    expires_at: expiresAt,
    device_id: deviceId,
    user_id: userId === undefined ? undefined : String(userId),
    user_name: data.user_name,
    user_phone: data.user_phone ?? phone,
  }
}

async function post(base, path, body, deviceId, fetcher = fetch) {
  const timestamp = Math.floor(Date.now() / 1000)
  const response = await fetcher(`${base}${path}`, {
    method: 'POST',
    headers: authHeaders(timestamp),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await response.text()
  let json
  try { json = JSON.parse(text) } catch { throw new Error(`非 JSON 响应(${response.status})：${text.slice(0, 200)}`) }
  if (!response.ok) throw new Error(`HTTP ${response.status}：${text.slice(0, 200)}`)
  if (json.code !== 0) throw new Error(`业务错误 code=${json.code}：${json.msg ?? text.slice(0, 200)}`)
  return json
}

/** 本地假上游：校验签名与请求体形状，返回上游同形的响应。 */
async function selftest() {
  const seen = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      const body = JSON.parse(raw || '{}')
      const timestamp = request.headers['x-auth-timestamp']
      const expected = sign(APP_ID, timestamp, APP_KEY)
      const ok = request.headers['x-auth-sign'] === expected
      seen.push({ path: request.url, signed: ok, body })
      response.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' })
      if (!ok) return response.end(JSON.stringify({ code: 401, msg: 'bad signature' }))
      if (request.url === SEND_CODE_PATH) return response.end(JSON.stringify({ code: 0, msg: 'SUCCESS' }))
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
      const payload = Buffer.from(JSON.stringify({ user_id: 424242, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')
      return response.end(JSON.stringify({
        code: 0,
        data: {
          access_token: `Bearer ${header}.${payload}.sig`,
          refresh_token: 'refresh-abc',
          user_name: 'selftest',
          user_phone: '13800000000',
        },
      }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const deviceId = 'selftest-device'
  try {
    const sent = await post(base, SEND_CODE_PATH, sendCodeBody('13800000000', deviceId))
    if (sent.code !== 0) throw new Error('发码未返回 code=0')
    const login = await post(base, LOGIN_PATH, loginBody('13800000000', '123456', deviceId))
    const credential = toCredential(login.data, deviceId, '13800000000')
    if (!credential.access_token.startsWith('ey')) throw new Error('access_token 未剥掉 Bearer 前缀')
    if (credential.expires_at === undefined || credential.expires_at < Date.now()) throw new Error('expires_at 未从 JWT exp 推出')
    if (credential.user_id !== '424242') throw new Error('user_id 未从 JWT 兜底')
    if (!seen.every(entry => entry.signed)) throw new Error('假上游收到签名不匹配的请求')
    if (seen.some(entry => entry.body.device_id !== deviceId)) throw new Error('device_id 未贯穿两个请求')
    console.log('ok  autoclaw-sms selftest: 签名/发码/换令牌/JWT 兜底/凭据形状 全部通过（本地假上游，未联网）')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}

function parseArgs(argv) {
  const args = { send: false, login: false, selftest: false, phone: '', code: '', device: '', base: DEFAULT_BASE }
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--send') args.send = true
    else if (flag === '--selftest') args.selftest = true
    else if (flag === '--phone') args.phone = argv[++index] ?? ''
    else if (flag === '--login') args.login = true
    else if (flag === '--code') args.code = argv[++index] ?? ''
    else if (flag === '--device') args.device = argv[++index] ?? ''
    else if (flag === '--base') args.base = argv[++index] ?? DEFAULT_BASE
    else throw new Error(`未知参数：${flag}`)
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.selftest) return selftest()
  const phone = normalizePhone(args.phone)
  if ((args.send || args.login) && phone === '') throw new Error('需要 --phone（11 位手机号，可带 +86）')
  if (args.login) {
    if (!/^\d{4,8}$/.test(args.code)) throw new Error('--login 需要 --code（短信验证码）')
    const deviceId = args.device || randomUUID()
    const result = await post(args.base, LOGIN_PATH, loginBody(phone, args.code, deviceId))
    const credential = toCredential(result.data, deviceId, phone)
    const mask = (value) => (value.length <= 12 ? '***' : `${value.slice(0, 6)}…${value.slice(-4)}（${value.length} 字符）`)
    console.log('ok  agent-login 成功')
    console.log(`  access_token: ${mask(credential.access_token)}`)
    console.log(`  refresh_token: ${credential.refresh_token ? mask(credential.refresh_token) : '（无）'}`)
    console.log(`  expires_at: ${credential.expires_at ? new Date(credential.expires_at).toISOString() : '（未声明，按需续期）'}`)
    console.log(`  user_id: ${credential.user_id ?? '（无）'}  user_phone: ${credential.user_phone ?? phone}`)
    return
  }
  if (args.send) {
    const deviceId = args.device || randomUUID()
    console.log(`⚠️  将向 ${phone} 真实发送一条短信（device_id=${deviceId}）`)
    const sent = await post(args.base, SEND_CODE_PATH, sendCodeBody(phone, deviceId))
    console.log(`发码成功：code=${sent.code}（msgid 由上游短信下发，本端点不返回）`)
    console.log('下一步：拿到验证码后调用 agent-login，或等实现接入插件后走 UI。')
    return
  }
  const deviceId = args.device || randomUUID()
  const timestamp = Math.floor(Date.now() / 1000)
  console.log('dry-run（未联网、未发短信）。将发送：')
  console.log(`  POST ${args.base}${SEND_CODE_PATH}`)
  console.log(`  headers: ${JSON.stringify(authHeaders(timestamp), null, 2)}`)
  console.log(`  body:    ${JSON.stringify(sendCodeBody('<phone>', deviceId))}`)
  console.log(`  ---- 用户收到验证码后 ----`)
  console.log(`  POST ${args.base}${LOGIN_PATH}`)
  console.log(`  body:    ${JSON.stringify(loginBody('<phone>', '<code>', deviceId))}`)
  console.log('真机验证：node scripts/autoclaw-sms-probe.mjs --send --phone <手机号>')
}

main().catch(error => { console.error(`autoclaw-sms-probe: ${error.message}`); process.exitCode = 1 })
