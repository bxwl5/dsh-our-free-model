/**
 * Loomy（讯飞）**短信验证码登录**流程（2026-11-20）。
 *
 * ## 为什么取代微信扫码
 *
 * 微信扫码（`loomy-wechat-login.ts`）实测已失效：二维码链路
 *（`open.weixin.qq.com/connect/qrconnect`）在当前 appid 下不再可用，
 * 用户明确「扫码功能失效了，不要了，只留短信登录」。故本流程成为唯一登录
 * 入口，微信那套代码保留在仓库里（不删，将来扫码恢复可切回），但**不再接线**。
 *
 * ## 协议（已实测，2026-11-20）
 *
 * | 步骤 | 端点 | 结果 |
 * | --- | --- | --- |
 * | 发码 | `POST {accountBase}/login/phone/sendMsgCode` | `data.msgid` |
 * | 换 session | `POST {accountBase}/login/phone/checkCode` | `data.session` + `data.userid` |
 *
 * 实测响应：发码返回 `code 000000` + msgid；签名走讯飞九段 HMAC-SHA1
 *（`loomy-sign.ts`），请求体是 `{ base, param }` 两段。
 *
 * ## 与 autoclaw 的模板关系
 *
 * 形状逐项对齐 `autoclaw-login-page.ts` 的 `AutoclawLoginFlow`：
 * `{ sendCode, verify, result, close }`，前端因此可以复用同一套两段式 UI
 *（手机号 → 发码（60s 倒计时）→ 验证码 → 登录）。
 *
 * ## 三条必须守住的约束
 *
 * 1. **短信是真实副作用**：只在用户显式点「发送验证码」时调 `sendLoomySmsCode`，
 *    不放进任何自动流程。
 * 2. **`msgid` 与手机号必须成对**：发码成功才记住手机号，避免 verify 用一个
 *    没收到码的号码去换 session（会得到与真实原因无关的「验证码错误」）。
 * 3. **冷却**：同号两次发码之间至少 {@link LOOMY_SMS_COOLDOWN_MS}，前端倒计时
 *    只是提示，真正的闸门在这里（防绕过 UI 狂刷上游）。
 *
 * @module vendor/channel-pack/src/loomy-sms-login
 */
import type { LoomyProduct } from './loomy-product.js'
import { sendLoomySmsCode } from './loomy-oauth.js'
import { directFetch } from './direct-fetch.js'
import type { LoomyLoginResult } from './loomy-auth.js'

/**
 * 完成一次短信登录所需的最小依赖面（由 `LoomyAuth` 提供）。
 *
 * ⚠️ 故意不直接依赖 `LoomyAuth` 类：那会把本模块绑到它的构造参数与 context 上，
 * 测试要造一堆假对象。这里只要一个函数，`LoomyAuth.loginWithSmsCode` 天然满足
 *（它已包含「换 session + 写凭据 + 回填账号池」的完整语义，不重复实现）。
 */
export type LoomySmsLoginCompleter = (
  phone: string,
  code: string,
  msgid: string,
  flowOptions: { refName?: string },
) => Promise<LoomyLoginResult>

/** 同号两次发码的最小间隔（60 秒，与前端倒计时一致）。 */
export const LOOMY_SMS_COOLDOWN_MS = 60_000

/** 整个登录流程的超时（5 分钟；用户要收短信、切应用，别设太紧）。 */
export const LOOMY_SMS_LOGIN_TIMEOUT_MS = 5 * 60_000

/** 中国大陆手机号归一：容忍 `+86` / 空格 / 连字符，返回 11 位或空串。 */
export function normalizeLoomyPhone(raw: unknown): string {
  const text = String(raw ?? '').replace(/[\s-]/g, '')
  const digits = text.startsWith('+86') ? text.slice(3) : text.startsWith('86') && text.length === 13 ? text.slice(2) : text
  return /^1[3-9]\d{9}$/.test(digits) ? digits : ''
}

/** 卡片内嵌的短信登录流程（RPC 面用 flowId 寻址）。 */
export interface LoomySmsLoginFlow {
  /** 发送验证码；失败返回可读原因（不终止流程，可重试）。 */
  sendCode: (phone: string) => Promise<{ ok: boolean; message?: string }>
  /** 提交验证码完成登录；失败返回可读原因。 */
  verify: (code: string) => Promise<{ ok: boolean; message?: string }>
  /** 登录成功时 resolve 出登录结果（含凭据 JSON 与到期时间）；超时或关闭时 reject。 */
  result: Promise<LoomyLoginResult>
  /** 主动放弃。 */
  close: () => Promise<void>
}

/**
 * 启动一次短信登录流程（无本地服务器、无浏览器）。
 *
 * @returns flow 对象；`result` 在登录成功时给出凭据。
 */
export function startLoomySmsLoginFlow(options: {
  /** 产品配置（`LOOMY`）。 */
  product: LoomyProduct
  /** 注入的 fetcher（测试用；生产走全局 fetch）。 */
  fetcher?: typeof fetch
  /** 完成登录的回调（生产传 `auth.loginWithSmsCode.bind(auth)`）。 */
  complete: LoomySmsLoginCompleter
  /** 凭据 refName（多账号时区分）。 */
  refName?: string
  /** 超时覆盖（测试用）。 */
  timeoutMs?: number
}): LoomySmsLoginFlow {
  /**
   * ⚠️ 兜底必须是 **`directFetch`（包内 undici + 出口层）**，不是全局 `fetch`
   * （2026-11-26 迁移，本文件是全仓同类调用里最后一处 `?? fetch`）。
   *
   * 2026-11-21 的真实故障就是这类兜底的后果：`this.fetchImpl is not a function`
   * —— 全局 `fetch` 在某些宿主里不存在/被别的插件改坏，而本插件在构造函数里
   * 捕获的 `fetchImpl` 一旦是 `undefined` 就永远是 `undefined`。`directFetch`
   * 走包内 undici，并仍然尊重用户代理与插件出口，不读 `globalThis.fetch`。
   */
  const fetcher = options.fetcher ?? directFetch
  const state = {
    /** 已验证可用、已收到码的手机号；`''` = 尚未成功发码。 */
    phone: '',
    /** 该手机号对应的上游 msgid。 */
    msgid: '',
    /** 上次发码成功的时间戳（冷却判据）。 */
    lastSentAt: 0,
  }

  let resolveResult: (value: LoomyLoginResult) => void = () => {}
  let rejectResult: (error: unknown) => void = () => {}
  const result: Promise<LoomyLoginResult> = new Promise<LoomyLoginResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  // 先挂空处理器：用户可能极快取消，这个 promise 会在被消费前 reject。
  result.catch(() => {})

  let settled = false
  const settleOk = (value: LoomyLoginResult): void => {
    if (settled) return
    settled = true
    resolveResult(value)
  }
  const settleErr = (error: unknown): void => {
    if (settled) return
    settled = true
    rejectResult(error)
  }

  const sendCode = async (phone: string): Promise<{ ok: boolean; message?: string }> => {
    // ⚠️ 流程已结束（超时 / 用户关闭 / 已登录成功）后**一律拒绝**：
    // 短信是真实副作用，卡片已经显示「已取消」时还去打上游是错的。
    if (settled) return { ok: false, message: '登录流程已结束' }
    const elapsed = Date.now() - state.lastSentAt
    if (state.lastSentAt !== 0 && elapsed < LOOMY_SMS_COOLDOWN_MS) {
      const wait = Math.ceil((LOOMY_SMS_COOLDOWN_MS - elapsed) / 1000)
      return { ok: false, message: `发送过于频繁，请 ${wait} 秒后再试` }
    }
    const normalized = normalizeLoomyPhone(phone)
    if (normalized === '') {
      return { ok: false, message: '请输入有效的 11 位手机号（可带 +86）' }
    }
    try {
      const msgid = await sendLoomySmsCode(normalized, options.product, fetcher)
      // 只在发码成功后才记住手机号与 msgid（约束 ②）。
      state.phone = normalized
      state.msgid = msgid
      state.lastSentAt = Date.now()
      return { ok: true }
    } catch (error) {
      // 单步失败不终止流程：让卡片就地提示并允许重试。
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  const verify = async (code: string): Promise<{ ok: boolean; message?: string }> => {
    /**
     * ⚠️ **必须挡在 `options.complete(...)` 之前**（2026-11-26 修复，真实缺陷）：
     * 超时或用户点「关闭」之后 `settled` 已为真，`settleOk` 只会把结果丢掉 ——
     * 但 `complete` 是**带副作用**的（换 session、写凭据落盘、回填账号池）。
     * 于是出现「前端显示已取消，账号其实已登录」的分裂状态。
     *
     * 判据是 `settled` 而不是 `closed`：登录成功后再次 `verify` 也必须被拒
     * （同一流程只能完成一次）。
     */
    if (settled) return { ok: false, message: '登录流程已结束' }
    if (state.phone === '' || state.msgid === '') return { ok: false, message: '请先获取手机验证码' }
    const trimmed = typeof code === 'string' ? code.trim() : ''
    if (!/^\d{4,8}$/.test(trimmed)) return { ok: false, message: '请输入收到的验证码' }
    try {
      // 交给 LoomyAuth：换 session + 写凭据 + 回填账号池，一处实现（不重复）。
      const login = await options.complete(
        state.phone,
        trimmed,
        state.msgid,
        options.refName === undefined ? {} : { refName: options.refName },
      )
      settleOk(login)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    settleErr(new Error('loomy: 登录流程已关闭'))
  }

  const timeoutMs = options.timeoutMs ?? LOOMY_SMS_LOGIN_TIMEOUT_MS
  const timer = setTimeout(() => {
    settleErr(new Error(`loomy: 登录超时（${Math.round(timeoutMs / 1000)} 秒内未完成）`))
  }, timeoutMs)
  timer.unref?.()

  void result.catch(() => {}).finally(() => {
    clearTimeout(timer)
    closed = true
  })

  return { sendCode, verify, result, close }
}
