/**
 * KukuAI（百度库库）扫码登录：passport 二维码 → 轮询 → 换会话 → kuku 凭据。
 *
 * ## 为什么要扫码（而不是继续粘贴 Cookie）
 *
 * kuku 的真实调用需要 **(BDUSS, STOKEN) 一对**，而 `STOKEN` 是 passport 铸造的
 * **HttpOnly** Cookie —— 用户在 DevTools 里**根本看不到它**，只能复制到 BDUSS。
 * 所以「粘贴 Cookie」这条路永远缺一半：扫码（或短信）走一遍真实登录，让 passport
 * 把两个值都写进响应头，是唯一可规模化的取法。
 * 依据：`项目文件/research/paste-login-feasibility.md` §3.2。
 *
 * ## 协议（纯 HTTP，无鉴权前置）
 *
 * ```
 * 1. GET  /v2/api/getqrcode?lp=pc&qrloginfrom=pc&apiver=v3&tpl=genflowpro&callback=<jsonp>
 *       → { errno: 0, sign, imgurl, prompt }        ← 无需任何凭据
 * 2. GET  /v2/api/qrcode?sign=<sign>&lp=pc&qrloginfrom=pc
 *       → PNG 字节（实测**首次可能返回 0 字节**，同一 sign 几秒后就有图）
 * 3. GET  /channel/unicast?channel_id=<sign>&_sdkFrom=1&apiver=v3&tpl=genflowpro
 *       → { errno, channel_v }，channel_v 是**字符串化的对象**：
 *           status "0" 已确认（v = 一次性 ticket）/ "1" 已扫码 / "2" 已过期
 *           未扫时上游回 { errno: 1 }（**不是** status 2，别把两者搞混）
 * 4. GET  /v2/api/bdusslogin?bduss=<ticket>&u=https://kuku.baidu.com&qrcode=1
 *       → Set-Cookie: BDUSS=…; PTOKEN=…           ← 成功时**没有 errno 字段**
 * 5. POST /v3/login/api/auth   （md5 签名的表单）
 *       → { errno: 0, stoken_list: { genflowpro: <STOKEN> } }
 * ```
 *
 * ## 三个刻意的判断（都有实测依据，别"顺手优化"掉）
 *
 * 1. **`bdusslogin` 的成功判据是「没有 errno」，不是 `errno === 0`。**
 *    上游成功回 `{data, errInfo}`，压根不带 errno；拒绝才带（假 ticket 回 `-9999`）。
 *    写成 `errno === 0` 会把每一次真实登录都判失败，然后拿着 32 位 ticket 当 BDUSS 用。
 * 2. **`errno: 1` 是「还没扫」，不是错误。** 把它当失败会让用户一打开页面就报错。
 * 3. **没见过的形状回 `unknown` 并带上原始判据，不猜。** 猜错的表现是「流程看着像
 *    坏了」而其实只是上游改了字段名 —— 留证据比猜有用。
 *
 * ## 纯模块
 *
 * 这里**不起服务器、不渲染页面、不写凭据**：只做协议三步，全部依赖可注入。
 * 本地弹窗页已删（2026-10-30，卡片内嵌形态取代；见 kuku-qr-login-page.ts）。
 */

import { createHash, randomBytes } from 'node:crypto'

import { normalizeCookie, type KukuCredential } from './kuku.js'

/** passport 基址。 */
export const KUKU_PASSPORT_BASE = 'https://passport.baidu.com'

/**
 * 取码 / 轮询必须带的 `Referer`。
 *
 * passport 对 `/v2/api/*` 做防盗链：缺 Referer 时它回 **404 HTML** 而不是 JSON，
 * 在调用方看来就是「接口不存在」—— 一个纯靠猜永远查不出的失败。
 */
export const KUKU_QR_REFERER = 'https://kuku.baidu.com/genflowpro/login'

/** bdusslogin 的 `u` 参数（登录后要跳回的站点）。 */
export const KUKU_QR_TARGET = 'https://kuku.baidu.com'

/** 浏览器 UA：passport 对空 UA / 爬虫 UA 可能直接拒绝。 */
export const KUKU_QR_USER_AGENT
  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'GenFlowPro/1.6.5.130 Chrome/120.0.0.0 Electron/28.0.0.0 Safari/537.36'

/**
 * STOKEN 交换那一步的 UA。
 *
 * 用客户端原生引擎的原串：取码/轮询这些浏览器腿用浏览器 UA 没问题，但交换腿
 * 可能被指纹化（同一个 BDUSS 用浏览器 UA 换 STOKEN 会拿到 errno 110003）。
 */
export const KUKU_ENGINE_USER_AGENT = 'genflow;1.6.5;PC;PC-Windows;10.0.26200;GenFlowPro'

/**
 * STOKEN 交换的签名密钥（客户端内置常量）。
 *
 * 来源：`IKUNHEIHIE/kuku2api` 的 `src/passport.mjs`（MIT）—— 该常量是从客户端
 * 二进制里逆出来的，上游 `genflow_engine_get_login_auth_param` 用同一把。
 * 没有它 passport 对**合法**的 BDUSS/PTOKEN 也回 errno 110003。
 */
export const KUKU_ENGINE_SIGN_KEY = '34868b316de55815273b2616954b0286'

/** 单次请求默认超时（毫秒）。适用于取码 / 取图 / bdusslogin / STOKEN 交换。 */
export const KUKU_QR_REQUEST_TIMEOUT_MS = 15_000

/**
 * 扫码状态轮询的超时（毫秒）。
 *
 * ⚠️ **`/channel/unicast` 是长轮询，不是普通 GET**：实测（2026-10-24，两次采样）
 * 未扫码时上游会**挂住约 30 秒**才回 `{"errno":1}`。用上面那 15 秒会让每一次
 * 轮询都在超时后抛 `network` —— 表面上「一直失败」，实际是上游正常在等。
 *
 * 给 45 秒：比实测的 30 秒留 50% 余量（网络抖动 / 上游排队），又不会让一次
 * 卡死的轮询把整个登录拖到用户放弃。
 */
export const KUKU_QR_POLL_TIMEOUT_MS = 45_000

/** 取图重试次数：实测首次可能返回 0 字节，同一 sign 稍后就有图。 */
const QR_IMAGE_ATTEMPTS = 3

/** 账号作用域 Cookie：只有这几个要进凭据，BAIDUID 等设备 Cookie 留在 jar 里。 */
const ACCOUNT_COOKIE = /^(?:BDUSS|PTOKEN|STOKEN|PASS_STOKEN)/

/** 一次扫码失败的可分类原因。 */
export type KukuQrErrorCode =
  /** 传输层失败（DNS/TLS/超时/连接被重置）。 */
  | 'network'
  /** 非 2xx。 */
  | 'http'
  /** 响应既不是 JSON 也不是可解析的 JSONP。 */
  | 'unparsable'
  /** `getqrcode` 明确拒绝（`errno !== 0` 或无 `sign`）。 */
  | 'qr_refused'
  /** 取图连续多次拿到空正文。 */
  | 'qr_image_empty'
  /** `bdusslogin` 明确拒绝（带 errno，例如假 ticket 的 -9999）。 */
  | 'bduss_login_refused'
  /** 登录流程走完但响应里没有 BDUSS。 */
  | 'no_bduss'
  /** STOKEN 交换被拒（仅在 `requireStoken: true` 时抛出）。 */
  | 'stoken_exchange_refused'
  /** 拿到的 Cookie 串过不了 `normalizeCookie` 的形状检查。 */
  | 'credential_invalid'

/**
 * 扫码流程的可分类错误。
 *
 * `code` 是稳定契约（UI 据此选文案），`message` 面向用户且**不含上游原文** ——
 * passport 会把请求片段回显进错误体，直接透传等于把 ticket 打进日志。
 */
export class KukuQrError extends Error {
  readonly code: KukuQrErrorCode
  /** 上游 HTTP 状态（若有）。 */
  readonly status: number | undefined
  /** 上游 errno（若有）。 */
  readonly errno: number | undefined

  constructor(
    code: KukuQrErrorCode,
    message: string,
    extra: { status?: number; errno?: number; cause?: unknown } = {},
  ) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause })
    this.name = 'KukuQrError'
    this.code = code
    this.status = extra.status
    this.errno = extra.errno
  }
}

/** 一次登录尝试独占的 Cookie 罐。 */
export interface KukuCookieJar {
  get(name: string): string | undefined
  set(name: string, value: string): void
  has(name: string): boolean
  /** 拼成 `Cookie:` 头的值；空罐返回空串（**不要**发空的 `Cookie:` 头，见下）。 */
  header(): string
  /** 吸收响应里的 `Set-Cookie`。 */
  absorb(response: Response): void
  /** 罐内全部 Cookie 名（诊断用）。 */
  names(): readonly string[]
}

/**
 * 建一个 Cookie 罐。
 *
 * 每次登录尝试**必须**独占一个罐：两个人同时扫码不能共用会话。
 * 罐里只存 `name → value`，不处理 Domain/Path/Expires —— passport 这一串接口
 * 都在同一个 host 下，带属性只会让 `Cookie:` 头变脏。
 */
export function createKukuCookieJar(initial: Record<string, string> = {}): KukuCookieJar {
  const cookies = new Map<string, string>(Object.entries(initial))
  return {
    get: (name) => cookies.get(name),
    set: (name, value) => { cookies.set(name, value) },
    has: (name) => cookies.has(name),
    header: () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
    names: () => [...cookies.keys()],
    absorb: (response) => {
      for (const raw of readSetCookie(response)) {
        const [pair] = raw.split(';')
        if (pair === undefined) continue
        const at = pair.indexOf('=')
        if (at <= 0) continue
        const name = pair.slice(0, at).trim()
        const value = pair.slice(at + 1).trim()
        if (name === '') continue
        // 上游用「同名 + 空值 + expired」删 Cookie；照做，否则会留着失效值。
        if (value === '' || /expires=.*(?:1970|Thu, 01 Jan 1970)/i.test(raw)) cookies.delete(name)
        else cookies.set(name, value)
      }
    },
  }
}

/** 读 `Set-Cookie`：优先 undici 的 `getSetCookie()`，退化时按「逗号 + name=」切。 */
function readSetCookie(response: Response): readonly string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie()
  const joined = headers.get('set-cookie')
  if (joined === null || joined === '') return []
  // 退化路径：Expires 里的逗号会误切，但只有拿不到 getSetCookie 时才会走到这里。
  return joined.split(/,(?=\s*[A-Za-z0-9_\-]+=)/)
}

/** 一次扫码登录的会话。 */
export interface KukuQrSession {
  /** passport 下发的一次性 sign（既是取图凭据，也是轮询的 `channel_id`）。 */
  sign: string
  /** 二维码图片地址（可直接给 `<img src>`；但更推荐 `fetchKukuQrImage` 内联）。 */
  imageUrl: string
  /** 上游给的提示文案（可能为空）。 */
  prompt: string
  /** 本次登录独占的 Cookie 罐（`bdusslogin` 会把 BDUSS 写进来）。 */
  jar: KukuCookieJar
  /** 本次会话用的 passport 基址（测试注入后一直沿用）。 */
  passportBase: string
  /** 申请时间（毫秒）。上游有效期约 3 分钟，UI 据此提示"刷新二维码"。 */
  createdAt: number
}

/** 扫码状态。 */
export type KukuQrState =
  /** 未扫码（上游常态：`{ errno: 1 }`）。 */
  | 'pending'
  /** 已扫码，等用户在手机上点确认 —— **必须继续轮询**。 */
  | 'scanned'
  /** 已确认，`ticket` 就是换会话要用的值。 */
  | 'confirmed'
  /** 二维码过期，必须重新 `requestKukuQrCode`。 */
  | 'expired'
  /** 上游回了没见过的形状：**不猜**，带上原始判据由调用方决定。 */
  | 'unknown'

/** 一次轮询的结果。 */
export interface KukuQrPollResult {
  state: KukuQrState
  /**
   * 仅 `confirmed` 时存在：passport 下发的一次性 **ticket**。
   *
   * ⚠️ 它**不是** BDUSS：长度 32 左右，还要经 `bdusslogin` 才能换成真正的会话
   * Cookie。把 ticket 当 BDUSS 存进账号池是这条链最容易犯的错（存进去之后每次
   * 调用都 401，而看日志只能看到"凭据已存在"）。
   */
  ticket?: string
  /** 上游原始判据，只用于排障，**不参与决策**。 */
  probe: { errno: number | null; status: string | null; fields: string }
}

/** 扫码登录的可注入依赖。 */
export interface KukuQrLoginOptions {
  /** fetch 实现（测试注入）。 */
  fetcher?: typeof fetch
  /** passport 基址覆盖（测试/自建代理）。 */
  passportBase?: string
  /** 单次请求超时（毫秒）。 */
  timeoutMs?: number
  /** 取消信号。 */
  signal?: AbortSignal
}

/** `completeKukuQrLogin` 的额外选项。 */
export interface KukuQrCompleteOptions extends KukuQrLoginOptions {
  /** `bdusslogin` 的 `u` 参数（登录后跳回的站点）。 */
  target?: string
  /**
   * STOKEN 交换失败是否致命。
   *
   * 默认 `false`：拿不到 STOKEN 时仍返回 BDUSS-only 的凭据并把原因放进 `warnings`。
   * 理由是现有适配器只校验 BDUSS（`kuku.ts` 的 `isCredentialUsable`），把交换腿
   * 设成硬失败会让「扫码成功但账号进不了池」，比缺一半更糟。真实调用要 STOKEN 时
   * 传 `true`，让问题在登录当场暴露而不是等到第一次对话。
   */
  requireStoken?: boolean
}

/** 一次完整扫码登录的产物。 */
export interface KukuQrLoginResult {
  /** 可直接落账号池的凭据（`access_token` 是完整 Cookie 串）。 */
  credential: KukuCredential
  /** 单独拎出来的 STOKEN（`undefined` 表示没换到）。 */
  stoken: string | undefined
  /** 实际进凭据的 Cookie 名（排障用）。 */
  cookieNames: readonly string[]
  /** 非致命问题（例如 STOKEN 未换到）。空数组表示一切顺利。 */
  warnings: readonly string[]
}

// ── JSONP / 解析 ──

/** 生成本次请求的 JSONP 回调名（passport 只有在带 `callback` 时才回 JSONP）。 */
function jsonpName(): string {
  return `bd__cbs__${randomBytes(4).toString('hex')}`
}

/**
 * 拆 JSONP 外壳。
 *
 * passport 大部分接口在有 `callback` 时回 `name({...});`，某些情况又直接回 JSON。
 * 两种都要认 —— 只认一种会在某次上游小改动后静默变成「无响应」。
 */
function unwrapJsonp(text: string): string {
  const match = /^[^(]*\(([\s\S]*)\)\s*;?\s*$/.exec(text)
  return match?.[1] ?? text
}

/**
 * 把 passport 的响应正文解析成对象。
 *
 * 三层退化，每层都有实测依据：
 * 1. 直接 `JSON.parse`（多数接口）；
 * 2. 剥 JSONP 外壳后再试；
 * 3. 上游某些接口回的是 **JS 字面量**（`loginrecord:{ 'email':[] }`，键带单引号），
 *    把单引号键归一成双引号再试。
 *
 * ⚠️ 这里**只做文本归一，绝不 eval**：上游正文是不可信输入，`eval` 等于把
 * passport 的脚本当本地代码跑。
 */
export function parseKukuPassportBody(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const candidates = [trimmed, unwrapJsonp(trimmed)]
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown
    } catch {
      // 继续退化
    }
    try {
      return JSON.parse(candidate.replace(/([,{\s])'([^']+)'\s*:/g, '$1"$2":')) as unknown
    } catch {
      // 继续退化
    }
  }
  return undefined
}

/** 是否非 null 对象（数组不算）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 安全取字符串。 */
function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

/** passport 所有接口共用的固定参数。 */
const GENERIC_PARAMS = { apiver: 'v3', tpl: 'genflowpro' } as const

/** 拼一个带固定参数的 URL。 */
function passportUrl(base: string, path: string, params: Record<string, string>): string {
  const query = new URLSearchParams({ ...params, ...GENERIC_PARAMS, tt: String(Date.now()) })
  return `${base}${path}?${query.toString()}`
}

/**
 * 合并超时与外部取消信号。
 *
 * `timeoutMs` 是**本次请求**的超时（`callPassport` 按接口传入）：轮询腿用
 * `KUKU_QR_POLL_TIMEOUT_MS`，其余用 `KUKU_QR_REQUEST_TIMEOUT_MS`。
 * 调用方显式给的 `options.timeoutMs` 优先级最高（测试用短超时）。
 */
function requestSignal(options: KukuQrLoginOptions, timeoutMs: number): AbortSignal | undefined {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? timeoutMs)
  if (options.signal === undefined) return timeout
  return AbortSignal.any([options.signal, timeout])
}

/** 一次 passport 调用的结果。 */
interface PassportReply {
  status: number
  /** 解析后的对象（解析不出来是 `undefined`）。 */
  body: unknown
  /** 原始文本（诊断用，**不要**整段外传）。 */
  text: string
  response: Response
}

/**
 * 发一次请求并吸收 Cookie。
 *
 * 空罐时**不发** `Cookie:` 头：passport 某些路由把空的 `Cookie:` 当成独立的 404
 * 触发条件（与缺 Referer 同一类静默失败）。
 *
 * `timeoutMs` 由调用方按接口给：轮询腿是长轮询（约 30 秒），不能用 15 秒。
 */
async function callPassport(
  url: string,
  options: KukuQrLoginOptions,
  init: {
    method?: string
    body?: string
    headers?: Record<string, string>
    jar?: KukuCookieJar
    timeoutMs?: number
  } = {},
): Promise<PassportReply> {
  const fetcher = options.fetcher ?? fetch
  const jar = init.jar
  const cookie = jar?.header() ?? ''
  const headers: Record<string, string> = {
    'user-agent': KUKU_QR_USER_AGENT,
    referer: KUKU_QR_REFERER,
    accept: 'application/json, text/plain, */*',
    ...init.headers,
  }
  if (cookie !== '') headers.cookie = cookie

  const signal = requestSignal(options, init.timeoutMs ?? KUKU_QR_REQUEST_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetcher(url, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    throw new KukuQrError('network', '无法连接百度 passport（网络或超时），请稍后重试', { cause: error })
  }
  jar?.absorb(response)
  const text = await response.text().catch(() => '')
  return { status: response.status, body: parseKukuPassportBody(text), text, response }
}

// ── 第 1 步：申请二维码 ──

/**
 * 申请一张登录二维码。
 *
 * 实测这一步**不需要任何凭据**：只有设备 Cookie（BAIDUID）会跟着回来，用户现有的
 * 登录态一个字节都不碰 —— 所以可以放心地在「添加账号」时先取码。
 *
 * @throws {KukuQrError} `qr_refused`（上游拒绝）/ `network` / `http` / `unparsable`
 */
export async function requestKukuQrCode(options: KukuQrLoginOptions = {}): Promise<KukuQrSession> {
  const passportBase = options.passportBase ?? KUKU_PASSPORT_BASE
  const jar = createKukuCookieJar()
  const url = passportUrl(passportBase, '/v2/api/getqrcode', {
    lp: 'pc',
    qrloginfrom: 'pc',
    gid: '',
    oauthLog: '',
    callback: jsonpName(),
  })
  const reply = await callPassport(url, options, { jar })
  const body = isRecord(reply.body) ? reply.body : undefined
  const sign = stringValue(body?.sign)
  const errno = body?.errno === undefined ? undefined : Number(body.errno)
  if (sign === undefined || (errno !== undefined && errno !== 0)) {
    throw new KukuQrError('qr_refused', '百度 passport 拒绝下发登录二维码，请稍后重试', {
      status: reply.status,
      ...(errno === undefined ? {} : { errno }),
    })
  }
  const imgurl = stringValue(body?.imgurl)
  return {
    sign,
    imageUrl: imgurl === undefined
      ? `${passportBase}/v2/api/qrcode?sign=${encodeURIComponent(sign)}&lp=pc&qrloginfrom=pc`
      : `https://${imgurl.replace(/^https?:\/\//, '')}`,
    prompt: stringValue(body?.prompt) ?? '',
    jar,
    passportBase,
    createdAt: Date.now(),
  }
}

/**
 * 取二维码图片字节，并转成可直接内联的 data URL。
 *
 * ⚠️ **必须容忍空正文**：实测紧跟 `getqrcode` 的第一次取图会回 200 + 0 字节，
 * 同一个 sign 几百毫秒后就有真图。把空正文当成功会让用户看到一个扫不出东西的
 * 白框（而日志里一切正常）。这里重试 3 次、递增退避，仍为空才报错。
 *
 * @throws {KukuQrError} `qr_image_empty` / `http` / `network`
 */
export async function fetchKukuQrImage(
  session: KukuQrSession,
  options: KukuQrLoginOptions = {},
): Promise<{ dataUrl: string; bytes: number; contentType: string }> {
  const fetcher = options.fetcher ?? fetch
  const url = `${session.passportBase}/v2/api/qrcode`
    + `?sign=${encodeURIComponent(session.sign)}&lp=pc&qrloginfrom=pc`
  let lastStatus = 0
  for (let attempt = 0; attempt < QR_IMAGE_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250 * attempt)
        timer.unref?.()
      })
    }
    const cookie = session.jar.header()
    // 每次重试都新建信号：AbortSignal.timeout 是一次性的，复用会让第二次立刻 abort。
    const signal = requestSignal(options, KUKU_QR_REQUEST_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetcher(url, {
        headers: {
          'user-agent': KUKU_QR_USER_AGENT,
          referer: KUKU_QR_REFERER,
          accept: 'image/png,image/*;q=0.5',
          ...(cookie === '' ? {} : { cookie }),
        },
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      throw new KukuQrError('network', '取二维码图片失败（网络或超时）', { cause: error })
    }
    lastStatus = response.status
    session.jar.absorb(response)
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined)
      throw new KukuQrError('http', `取二维码图片返回 HTTP ${response.status}`, { status: response.status })
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length === 0) continue
    const contentType = response.headers.get('content-type') ?? 'image/png'
    return {
      dataUrl: `data:${contentType.split(';')[0] ?? 'image/png'};base64,${buffer.toString('base64')}`,
      bytes: buffer.length,
      contentType,
    }
  }
  throw new KukuQrError('qr_image_empty', '二维码图片连续多次为空，请重新申请二维码', { status: lastStatus })
}

// ── 第 2 步：轮询扫码状态 ──

/**
 * 轮询一次扫码状态（**不做循环**，由调用方控制节奏）。
 *
 * 状态映射见 {@link KukuQrState}。要点：
 * - `errno: 1` 且没有 `channel_v` → `pending`（上游"还没人扫"的常态响应，不是错误）；
 * - `status "1"` → `scanned`，**继续轮询**；
 * - `status "2"` → `expired`，必须重新申请二维码（有效期约 3 分钟）；
 * - 其它形状 → `unknown` + 原始判据，**不猜**。
 *
 * ⚠️ **这是长轮询**：实测未扫码时上游挂住约 30 秒才回 `{"errno":1}`，因此用
 * `KUKU_QR_POLL_TIMEOUT_MS`（45 秒）而不是普通的 15 秒 —— 用短超时会让每次
 * 轮询都超时，表现为「扫码一直失败」，而实际是上游正常在等。
 * 每次调用**阻塞到上游回话为止**，调用方不要自己再叠一层高频重试。
 *
 * 传输失败抛 `KukuQrError('network')`；调用方应当**捕获并继续轮询**（扫码期间偶发
 * 抖动是常态，把它当致命错误会让用户在最关键的一步看到红色报错）。
 *
 * @throws {KukuQrError} `network` / `http`
 */
export async function pollKukuQrStatus(
  session: KukuQrSession,
  options: KukuQrLoginOptions = {},
): Promise<KukuQrPollResult> {
  const url = passportUrl(session.passportBase, '/channel/unicast', {
    channel_id: session.sign,
    gid: '',
    _sdkFrom: '1',
    callback: jsonpName(),
  })
  // ⚠️ 长轮询：未扫码时上游挂住约 30 秒才回，必须用轮询专用超时。
  const reply = await callPassport(url, options, { jar: session.jar, timeoutMs: KUKU_QR_POLL_TIMEOUT_MS })
  if (reply.status < 200 || reply.status >= 300) {
    throw new KukuQrError('http', `扫码状态查询返回 HTTP ${reply.status}`, { status: reply.status })
  }
  const body = isRecord(reply.body) ? reply.body : undefined
  const errno = body?.errno === undefined ? null : Number(body.errno)
  // channel_v 是**字符串化的**对象；上游偶尔直接给对象，两种都认。
  const channel = typeof body?.channel_v === 'string'
    ? parseKukuPassportBody(body.channel_v)
    : body?.channel_v
  const record = isRecord(channel) ? channel : undefined
  const status = record?.status === undefined ? null : String(record.status)
  const probe = {
    errno,
    status,
    fields: body === undefined ? 'unparsed' : Object.keys(body).join(','),
  }

  if (errno === 0 && status === '0') {
    const ticket = stringValue(record?.v)
    if (ticket !== undefined) return { state: 'confirmed', ticket, probe }
    // status 说确认了却没有 ticket：不能当成功，否则下一步会拿空串去换会话。
    return { state: 'unknown', probe }
  }
  if (errno === 0 && status === '1') return { state: 'scanned', probe }
  if (errno === 0 && status === '2') return { state: 'expired', probe }
  // 未扫码的常态响应：{ errno: 1 }，没有 channel_v。
  if (errno === 1 && record === undefined) return { state: 'pending', probe }
  return { state: 'unknown', probe }
}

// ── 第 3 步：把结果转成 kuku 凭据 ──

/**
 * 用 `confirmed` 拿到的 ticket 换出 kuku 凭据。
 *
 * 两步：
 * 1. `bdusslogin`：ticket → passport 把 **BDUSS / PTOKEN** 写进 jar；
 * 2. `v3/login/api/auth`：BDUSS + PTOKEN → **STOKEN**（真实 `/wenchain` 调用需要它）。
 *
 * 第 2 步失败时默认**不致命**（见 {@link KukuQrCompleteOptions.requireStoken}）。
 *
 * @throws {KukuQrError} `bduss_login_refused` / `no_bduss` / `stoken_exchange_refused`
 *   （仅 requireStoken）/ `credential_invalid` / `network` / `http`
 */
export async function completeKukuQrLogin(
  session: KukuQrSession,
  ticket: string,
  options: KukuQrCompleteOptions = {},
): Promise<KukuQrLoginResult> {
  if (ticket.trim() === '') {
    throw new KukuQrError('bduss_login_refused', '扫码结果缺少 ticket，请重新申请二维码')
  }
  const warnings: string[] = []

  // 1) ticket → 会话 Cookie
  const loginUrl = passportUrl(session.passportBase, '/v2/api/bdusslogin', {
    bduss: ticket,
    u: options.target ?? KUKU_QR_TARGET,
    qrcode: '1',
    callback: jsonpName(),
  })
  const loginReply = await callPassport(loginUrl, options, { jar: session.jar })
  const loginBody = isRecord(loginReply.body) ? loginReply.body : undefined
  // ⚠️ 成功时上游**没有 errno 字段**；只有拒绝才带。写成 errno === 0 会判失败每一次真登录。
  const loginErrno = loginBody?.errno === undefined ? null : Number(loginBody.errno)
  if (loginErrno !== null && loginErrno !== 0) {
    throw new KukuQrError('bduss_login_refused', '百度拒绝了这次扫码登录，请重新扫码', {
      status: loginReply.status,
      errno: loginErrno,
    })
  }
  if (loginBody === undefined) {
    throw new KukuQrError('unparsable', '百度登录响应无法解析，请稍后重试', { status: loginReply.status })
  }

  const bduss = session.jar.get('BDUSS') ?? session.jar.get('BDUSS_BFESS')
  if (bduss === undefined || bduss === '') {
    throw new KukuQrError('no_bduss', '百度登录已完成但未下发 BDUSS，请重新扫码', {
      status: loginReply.status,
    })
  }
  const ptoken = session.jar.get('PTOKEN') ?? session.jar.get('PTOKEN_BFESS') ?? ''

  // 2) BDUSS + PTOKEN → STOKEN
  let stoken: string | undefined
  if (ptoken === '') {
    warnings.push('passport 未下发 PTOKEN，已跳过 STOKEN 交换（真实调用可能缺权限）')
  } else {
    try {
      stoken = await exchangeKukuStoken(session, bduss, ptoken, options)
    } catch (error) {
      if (options.requireStoken === true) throw error
      warnings.push(
        `STOKEN 交换失败（${error instanceof KukuQrError ? error.code : 'unknown'}），`
        + '当前只拿到 BDUSS —— 现有适配器可用，但真实 /wenchain 调用可能需要 STOKEN',
      )
    }
  }

  // 3) 组装 Cookie 串：只带账号作用域字段，设备 Cookie 留在 jar 里。
  const cookie = buildCredentialCookie(session.jar)
  const normalized = normalizeCookie(cookie)
  if (normalized === undefined) {
    throw new KukuQrError(
      'credential_invalid',
      `扫码得到的 Cookie 串形状不合法（含 ${session.jar.names().filter((name) => ACCOUNT_COOKIE.test(name)).join(',') || '无账号字段'}）`,
    )
  }

  const names = normalized.split(';').map((part) => part.trim().split('=')[0] ?? '').filter((name) => name !== '')
  return {
    credential: { access_token: normalized, created_at: Date.now() },
    stoken,
    cookieNames: names,
    warnings,
  }
}

/**
 * 把 BDUSS + PTOKEN 换成 STOKEN。
 *
 * 签名公式（`md5` 覆盖含 `sign_key` 的原串）来自客户端内置引擎；没有它 passport
 * 对合法凭据也回 errno 110003。
 *
 * ⚠️ 错误信息**不透传上游正文**：passport 会把请求片段（含 BDUSS）回显进某些错误体，
 * 直接拼进 message 等于把凭据打进日志与 UI。
 */
async function exchangeKukuStoken(
  session: KukuQrSession,
  bduss: string,
  ptoken: string,
  options: KukuQrCompleteOptions,
): Promise<string> {
  const fields = `appid=1&bduss=${bduss}&ptoken=${ptoken}&return_type=1&tpl=genflowpro`
    + `&tpl_list=genflowpro|netdisk`
  const signed = `${fields}&sign_key=${KUKU_ENGINE_SIGN_KEY}`
  const sig = createHash('md5').update(signed).digest('hex')
  const body = `${fields}&sig=${sig}`

  // 上游客户端在这一步还会带 gfprotpl，jar 里没有就补上，尽量与客户端字节对齐。
  if (session.jar.has('BAIDUID') && !session.jar.has('gfprotpl')) session.jar.set('gfprotpl', 'genflowpro')

  const url = `${session.passportBase}/v3/login/api/auth`
  const reply = await callPassport(url, options, {
    method: 'POST',
    body,
    headers: {
      'user-agent': KUKU_ENGINE_USER_AGENT,
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    jar: session.jar,
  })
  const parsed = isRecord(reply.body) ? reply.body : undefined
  const errno = parsed?.errno === undefined ? 0 : Number(parsed.errno)
  const list = isRecord(parsed?.stoken_list) ? parsed.stoken_list : undefined
  const stoken = stringValue(list?.genflowpro)
  if (parsed === undefined || errno !== 0 || stoken === undefined) {
    throw new KukuQrError('stoken_exchange_refused', 'STOKEN 交换被百度拒绝，请重新扫码', {
      status: reply.status,
      errno,
    })
  }
  return stoken
}

/**
 * 把 jar 里的账号作用域 Cookie 拼成凭据串。
 *
 * `BDUSS` 排第一（`normalizeCookie` 按 cookie 对找它，顺序不影响判定，但便于人读）。
 */
function buildCredentialCookie(jar: KukuCookieJar): string {
  const names = jar.names().filter((name) => ACCOUNT_COOKIE.test(name))
  const ordered = [
    ...names.filter((name) => name === 'BDUSS'),
    ...names.filter((name) => name === 'BDUSS_BFESS'),
    ...names.filter((name) => name !== 'BDUSS' && name !== 'BDUSS_BFESS'),
  ]
  return ordered
    .map((name) => `${name}=${jar.get(name) ?? ''}`)
    .filter((pair) => !pair.endsWith('='))
    .join('; ')
}
