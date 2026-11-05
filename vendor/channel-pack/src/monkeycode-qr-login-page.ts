/**
 * MonkeyCode（百智云）**微信扫码登录流程** —— 卡片内嵌形态，照 KukuLoginFlow。
 *
 * ```
 * account.create → startMonkeyCodeLoginFlow() → { qrDataUrl, flowId }
 *                   （二维码 data URL 直接渲染进渠道卡片）
 * 卡片轮询       → monkeycode/poll?flow=     → { state }（服务端长轮询上游 ~25s）
 * 卡片点「刷新」 → monkeycode/reload?flow=   → 新的 { qrDataUrl }
 * 扫码确认       → 微信 wx_code → 百智云回调 → baizhi_session cookie
 *                → loginWithBaizhiSession() → MonkeyCode 凭据（OIDC 桥接）
 *                → 凭据落盘，login.poll 照常收尾
 * ```
 *
 * ⚠️ 与 kuku 的关键差别：kuku 的二维码直接换本渠道凭据；MonkeyCode 的微信扫码
 *    先得到的是**百智云**会话，必须再走一次 OIDC 桥接（仓库里已有
 *    `loginWithBaizhiSession`，官方 `desktop/src/baizhi/monkeycode.rs` 同款），
 *    换出 `monkeycode_ai_session` 才是适配器认识的凭据。
 */

import type { MonkeyCodeCredential } from './monkeycode.js'
import { loginWithBaizhiSession } from './monkeycode-auth.js'
import { MONKEYCODE } from './monkeycode-product.js'
import {
  MONKEYCODE_QR_TIMEOUT_MS,
  pollMonkeyCodeQrLogin,
  startMonkeyCodeQrLogin,
  type MonkeyCodeQrSession,
  type MonkeyCodeQrState,
} from './monkeycode-qr-login.js'

export { MONKEYCODE_QR_TIMEOUT_MS }

/** 与 KukuPollOutcome 对齐的轮询结果。 */
export type MonkeyCodePollOutcome =
  | { state: MonkeyCodeQrState['state'] }
  | { state: 'expired'; error?: string }

/** 进行中的扫码登录流程。 */
export interface MonkeyCodeLoginFlow {
  /** 当前二维码（data URL，可直接 <img src>）。 */
  qrDataUrl: string
  /** 服务端长轮询一次上游（微信侧 ~25s）；confirmed 时内部完成换凭据。 */
  poll: () => Promise<MonkeyCodePollOutcome>
  /** 重新申请二维码（旧的作废）。 */
  reload: () => Promise<void>
  /** 凭据落定（confirmed / 超时 / 关闭）。 */
  result: Promise<MonkeyCodeCredential>
  /** 主动放弃（卡片取消/关闭时调用）。 */
  close: () => Promise<void>
}

/** 启动一次扫码登录流程（无本地服务器）。 */
export async function startMonkeyCodeLoginFlow(options: {
  fetcher: typeof fetch
  /** 仅测试注入：百智云基址覆盖。 */
  baizhiBase?: string
  /** 仅测试注入：微信长轮询基址覆盖。 */
  lpBase?: string
  timeoutMs?: number
}): Promise<MonkeyCodeLoginFlow> {
  const { fetcher, baizhiBase, lpBase } = options
  const flowOptions = { fetcher, baizhiBase, lpBase }

  let qrDataUrl = ''
  let session: MonkeyCodeQrSession | undefined
  const fresh = async (): Promise<void> => {
    const started = await startMonkeyCodeQrLogin(flowOptions)
    qrDataUrl = started.qrDataUrl
    session = started.session
  }
  await fresh()

  let resolveResult!: (value: MonkeyCodeCredential) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<MonkeyCodeCredential>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  result.catch(() => {})

  let settled = false
  const settleOk = (value: MonkeyCodeCredential): void => {
    if (settled) return
    settled = true
    resolveResult(value)
  }
  const settleErr = (error: unknown): void => {
    if (settled) return
    settled = true
    rejectResult(error)
  }

  // 同一时刻只允许一个长轮询在飞（微信侧一次挂 ~25s）。
  let polling = false

  const reload = async (): Promise<void> => { await fresh() }

  const poll = async (): Promise<MonkeyCodePollOutcome> => {
    if (settled) return { state: 'confirmed' }
    if (polling) return { state: 'pending' }
    polling = true
    try {
      if (session === undefined) throw new Error('扫码会话未初始化')
      const polled = await pollMonkeyCodeQrLogin({ ...flowOptions, session })
      if (polled.state === 'confirmed' && polled.baizhiCookie !== undefined) {
        // 百智云会话 → MonkeyCode 会话（OIDC 桥接）。
        // 凭据落定放在这里做：卡片只拿到状态，拿不到凭据。
        const credential = await loginWithBaizhiSession(fetcher, MONKEYCODE, polled.baizhiCookie)
        settleOk({ ...credential, created_at: Date.now() })
        return { state: 'confirmed' }
      }
      if (polled.state === 'expired' || polled.state === 'canceled') {
        // 过期/取消：换一张新码，让卡片能继续（不结束整个流程）。
        await fresh()
        return { state: 'expired' }
      }
      return { state: polled.state }
    } catch (error) {
      settleErr(error)
      return { state: 'expired', error: error instanceof Error ? error.message : String(error) }
    } finally {
      polling = false
    }
  }

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    settleErr(new Error('monkeycode: 登录流程已关闭'))
  }

  const timeoutMs = options.timeoutMs ?? MONKEYCODE_QR_TIMEOUT_MS
  const timer = setTimeout(() => {
    settleErr(new Error(`monkeycode: 登录超时（${Math.round(timeoutMs / 1000)} 秒内未完成）`))
  }, timeoutMs)
  timer.unref?.()
  void result.catch(() => {}).finally(() => {
    clearTimeout(timer)
    closed = true
  })

  return { qrDataUrl, poll, reload, result, close }
}
