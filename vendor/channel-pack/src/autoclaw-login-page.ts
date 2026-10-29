/**
 * AutoClaw（国内站）短信登录流程 —— **卡片内嵌形态**（2026-10-30）。
 *
 * 旧形态是「本地服务器 + 127.0.0.1 弹窗页」：远程浏览器（DSH 在 NAS、浏览器
 * 在 PC）根本打不开那个地址，登录必败。现改为**无本地 HTTP**：
 *
 * ```
 * account.create        → startAutoclawLoginFlow() → { flowId }（卡片渲染手机号/验证码表单）
 * 卡片「发送验证码」    → autoclawSendCode(flowId, phone)   （60 秒冷却由卡片侧提示）
 * 卡片「登录」          → autoclawVerify(flowId, code)      （服务端持有手机号与 device_id）
 * 成功                  → result 兑现凭据，login.poll 照常收尾
 * ```
 *
 * ## 职责边界（安全，与旧版一致）
 *
 * - 宿主侧持有手机号、`device_id` 与凭据；卡片只做表单提交，看不到 token。
 * - 短信是**真实副作用**：只有用户点「发送验证码」才触发，服务端同样有 60 秒冷却。
 */
import type { AutoClawCredential } from './autoclaw.js'
import type { AutoClawProduct } from './autoclaw-product.js'
import {
  loginAutoclawWithCode,
  normalizeAutoclawPhone,
  sendAutoclawCode,
} from './autoclaw-sms.js'

/** 登录超时：与其它渠道一致，10 分钟。 */
export const AUTOCLAW_LOGIN_TIMEOUT_MS = 10 * 60_000

/** 发送验证码的冷却（毫秒）——服务端强制，卡片提示同口径。 */
export const AUTOCLAW_SMS_COOLDOWN_MS = 60_000

/** 进行中的短信登录流程（卡片内嵌形态）。 */
export interface AutoclawLoginFlow {
  /** 发送验证码；失败时返回可读原因（不终止流程，可重试）。 */
  sendCode: (phone: string) => Promise<{ ok: boolean; message?: string }>
  /** 提交验证码完成登录；失败返回可读原因。 */
  verify: (code: string) => Promise<{ ok: boolean; message?: string }>
  /** 登录成功时以凭据 resolve；超时/关闭时 reject。 */
  result: Promise<AutoClawCredential>
  /** 主动放弃。 */
  close: () => Promise<void>
}

/** 启动一次短信登录流程（无本地服务器）。 */
export async function startAutoclawLoginFlow(options: {
  product: AutoClawProduct
  fetcher: typeof fetch
  deviceId: string
  timeoutMs?: number
}): Promise<AutoclawLoginFlow> {
  const { product, fetcher, deviceId } = options
  const state: { phone: string; lastSentAt: number } = { phone: '', lastSentAt: 0 }

  let resolveResult!: (value: AutoClawCredential) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<AutoClawCredential>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  // 先挂空处理器：用户可能极快取消，这个 promise 会在被消费前 reject。
  result.catch(() => {})

  let settled = false
  const settleOk = (value: AutoClawCredential): void => {
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
    const elapsed = Date.now() - state.lastSentAt
    if (state.lastSentAt !== 0 && elapsed < AUTOCLAW_SMS_COOLDOWN_MS) {
      const wait = Math.ceil((AUTOCLAW_SMS_COOLDOWN_MS - elapsed) / 1000)
      return { ok: false, message: `发送过于频繁，请 ${wait} 秒后再试` }
    }
    const normalized = normalizeAutoclawPhone(phone)
    if (normalized === '') {
      return { ok: false, message: '请输入有效的 11 位手机号（可带 +86）' }
    }
    const sent = await sendAutoclawCode({ product, fetcher, phone: normalized, deviceId })
    if (!sent.ok) {
      // 单步失败不终止流程：让卡片就地提示并允许重试。
      return { ok: false, message: sent.error }
    }
    // 只在发送成功后才记住手机号，避免后续 verify 用一个没收到码的号码。
    state.phone = normalized
    state.lastSentAt = Date.now()
    return { ok: true }
  }

  const verify = async (code: string): Promise<{ ok: boolean; message?: string }> => {
    if (state.phone === '') return { ok: false, message: '请先获取手机验证码' }
    const trimmed = typeof code === 'string' ? code.trim() : ''
    if (trimmed === '') return { ok: false, message: '请输入验证码' }
    const login = await loginAutoclawWithCode({
      product,
      fetcher,
      phone: state.phone,
      code: trimmed,
      deviceId,
    })
    if (!login.ok) return { ok: false, message: login.error }
    settleOk(login.credential)
    return { ok: true }
  }

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    settleErr(new Error('autoclaw: 登录流程已关闭'))
  }

  const timeoutMs = options.timeoutMs ?? AUTOCLAW_LOGIN_TIMEOUT_MS
  const timer = setTimeout(() => {
    settleErr(new Error(`autoclaw: 登录超时（${Math.round(timeoutMs / 1000)} 秒内未完成）`))
  }, timeoutMs)
  timer.unref?.()

  void result.catch(() => {}).finally(() => {
    clearTimeout(timer)
    closed = true
  })

  return { sendCode, verify, result, close }
}
