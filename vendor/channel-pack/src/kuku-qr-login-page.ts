/**
 * KukuAI 扫码登录流程（**卡片内嵌形态**，2026-10-30）。
 *
 * 旧形态是「本地服务器 + 127.0.0.1 弹窗页」——远程浏览器（DSH 在 NAS、浏览器
 * 在 PC）根本打不开那个地址，登录必败。现改为**无本地 HTTP**：
 *
 * ```
 * account.create → startKukuLoginFlow() → { qrDataUrl, flowId }（二维码 data URL
 *                  直接渲染进渠道卡片，居中 + 提示文字）
 * 卡片轮询       → kukuPoll(flowId)        → { state }（服务端长轮询上游 30s）
 * 卡片点「刷新」 → kukuReload(flowId)       → 新的 { qrDataUrl }
 * 扫码确认       → 服务端在这里完成 ticket→凭据交换，login.poll 照常收尾
 * ```
 *
 * flowId 由调用方生成并保存在内存表里；超时/关闭语义与旧版一致（10 分钟）。
 * 旧形态的本地页与 `renderKukuQrPage` 已随之删除（2026-10-30）。
 */
import type { KukuCredential } from './kuku.js'
import {
  completeKukuQrLogin,
  fetchKukuQrImage,
  pollKukuQrStatus,
  requestKukuQrCode,
  type KukuQrSession,
} from './kuku-qr-login.js'

/** 登录超时：与其它渠道一致，10 分钟。 */
export const KUKU_LOGIN_TIMEOUT_MS = 10 * 60_000

/** 上游二维码有效期约 3 分钟，卡片据此提示刷新。 */
export const KUKU_QR_TTL_SECONDS = 180

/** 进行中的扫码登录流程（卡片内嵌形态）。 */
export interface KukuLoginFlow {
  /** 当前二维码（data URL，可直接 <img src>）。 */
  qrDataUrl: string
  /** 服务端长轮询一次上游（约 30s）；confirmed 时内部完成换凭据。 */
  poll: () => Promise<KukuPollOutcome>
  /** 重新申请二维码（旧的作废）。 */
  reload: () => Promise<void>
  /** 凭据落定（confirmed / 超时 / 关闭）。 */
  result: Promise<KukuCredential>
  /** 主动放弃（卡片取消/关闭时调用）。 */
  close: () => Promise<void>
}

export type KukuPollOutcome =
  | { state: 'pending' }
  | { state: 'scanned' }
  | { state: 'confirmed' }
  | { state: 'expired'; error?: string }
  /**
   * 上游回了没见过的形状（`KukuQrState` 的 `unknown`，不猜）。
   * 页面侧按 `pending` 同样处理：继续轮询。此前页面联合缺这个成员，
   * 把 `polled.state` 原样返回时 TS2322（2026-10-31 门禁）——
   * 也就是说**真实发生的 unknown 一路被强转掩盖**。
   */
  | { state: 'unknown' }

interface FlowState {
  session: KukuQrSession
  qrDataUrl: string
}

/** 申请一次二维码（含取图重试）。 */
async function freshSession(fetcher: typeof fetch, passportBase?: string): Promise<FlowState> {
  const options = passportBase === undefined ? { fetcher } : { fetcher, passportBase }
  const session = await requestKukuQrCode(options)
  const image = await fetchKukuQrImage(session, options)
  return { session, qrDataUrl: image.dataUrl }
}

/** 启动一次扫码登录流程（无本地服务器）。 */
export async function startKukuLoginFlow(options: {
  fetcher: typeof fetch
  /** 仅测试注入：passport 基址覆盖。 */
  passportBase?: string
  timeoutMs?: number
}): Promise<KukuLoginFlow> {
  const { fetcher, passportBase } = options
  const flowOptions = passportBase === undefined ? { fetcher } : { fetcher, passportBase }
  let state = await freshSession(fetcher, passportBase)

  let resolveResult!: (value: KukuCredential) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<KukuCredential>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  result.catch(() => {})

  let settled = false
  const settleOk = (value: KukuCredential): void => {
    if (settled) return
    settled = true
    resolveResult(value)
  }
  const settleErr = (error: unknown): void => {
    if (settled) return
    settled = true
    rejectResult(error)
  }

  // 同一时刻只允许一个长轮询在飞（上游一次挂 30s）。
  let polling = false

  const reload = async (): Promise<void> => {
    state = await freshSession(fetcher, passportBase)
  }

  const poll = async (): Promise<KukuPollOutcome> => {
    if (settled) return { state: 'confirmed' }
    if (polling) return { state: 'pending' }
    polling = true
    try {
      const polled = await pollKukuQrStatus(state.session, flowOptions)
      if (polled.state === 'confirmed' && polled.ticket !== undefined) {
        // ticket → BDUSS/STOKEN 的交换放在这里做：卡片只拿到状态，拿不到凭据。
        const completed = await completeKukuQrLogin(state.session, polled.ticket, flowOptions)
        settleOk(completed.credential)
        return { state: 'confirmed' }
      }
      // `unknown` 原样透传：客户端对非 expired 一律继续轮询（不特判），
      // 与 `pending` 同效果 —— 「不猜」的语义在两端保持一致。
      return polled.state === 'confirmed' ? { state: 'confirmed' } : { state: polled.state }
    } catch (error) {
      // 二维码过期 / 上游错误：卡片显示「刷新二维码」，RPC 侧清掉占位账号。
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
    settleErr(new Error('kuku: 登录流程已关闭'))
  }

  const timeoutMs = options.timeoutMs ?? KUKU_LOGIN_TIMEOUT_MS
  const timer = setTimeout(() => {
    settleErr(new Error(`kuku: 登录超时（${Math.round(timeoutMs / 1000)} 秒内未完成）`))
  }, timeoutMs)
  timer.unref?.()

  void result.catch(() => {}).finally(() => {
    clearTimeout(timer)
    closed = true
  })

  return { qrDataUrl: state.qrDataUrl, poll, reload, result, close }
}
