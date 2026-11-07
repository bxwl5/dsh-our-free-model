/**
 * Loomy 微信扫码登录流程（本地服务器承载弹窗页）。
 *
 * ## 为什么需要本地服务器
 *
 * 官方客户端用 Electron `BrowserWindow` 的 `will-redirect` 截获微信 code，
 * 而那个回调页（`loomy.xunfei.cn/oauth/wechat/callback`）实测 **404**。
 * 本插件没有 `will-redirect`，故**不用回调页收 code** —— 改为：
 *
 * ```
 * 本地服务器（127.0.0.1:随机端口）
 *   GET /wechat/qr       → 弹窗页：内联二维码（data URL）+ 前端轮询 + 绑定手机号表单
 *   GET /wechat/poll     → 前端轮询：长轮询微信，返回状态（待扫码/已扫码/已确认）
 *   POST /wechat/complete→ 提交微信 code（或手机号+验证码）完成登录
 * ```
 *
 * 微信 `code` 由**长轮询**（`loomy-wechat.ts`）直接拿到，完全绕开那个 404 回调页。
 *
 * ## 与其余 provider 的契约一致性
 *
 * 对外仍返回 `loginUrl`（指向本地 `/wechat/qr`），前端照常 `window.open` ——
 * 与 codearts / lobsterai / qoder / trae / cline 的「两步式」体验完全一致。
 *
 * ## ⚠️ redirect_uri 必须是官方地址
 *
 * 微信校验域名白名单（实测换本地地址会得到「redirect_uri 参数错误」），
 * 故 `buildLoomyWechatAuthUrl` 里写死官方地址 —— 它只用于**取 uuid**，
 * 不参与回调（我们从长轮询拿 code）。
 */

import { randomUUID } from 'node:crypto'
import type { LoomyProduct } from './loomy-product.js'
import {
  LOOMY_WECHAT_POLL_STATUS,
  fetchLoomyWechatQrImage,
  fetchLoomyWechatUuid,
  pollLoomyWechatOnce,
  type LoomyWechatPollStatus,
} from './loomy-wechat.js'
import {
  bindLoomyCheckCode,
  bindLoomySendMsg,
  bindLoomySkip,
  bindLoomyThirdAccount,
  type LoomyLoginResult,
} from './loomy-oauth.js'

/** 整个扫码 + 绑定的超时（毫秒）。 */
export const LOOMY_WECHAT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/** 本地弹窗页的路径。 */
export const LOOMY_WECHAT_QR_PATH = '/wechat/qr'
/** 前端轮询端点。 */
export const LOOMY_WECHAT_POLL_PATH = '/wechat/poll'
/** 提交端点（微信 code 或手机号验证码）。 */
export const LOOMY_WECHAT_COMPLETE_PATH = '/wechat/complete'

/** 微信登录流程的选项。 */
export interface LoomyWechatLoginOptions {
  product: LoomyProduct
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 超时（毫秒）。 */
  timeoutMs?: number
}

/** `startLoomyWechatLoginFlow` 的返回值（与其余 provider 的 `StartedXxxLoginFlow` 同形）。 */
export interface StartedLoomyWechatLoginFlow {
  /** 卡片内嵌流程 ID（RPC 面 loomy.wechatQr/Poll/Sms 用它寻址）。 */
  flowId: string
  /** 登录结果（凭据 + 手机号）。 */
  result: Promise<LoomyLoginResult & { phone: string; nickname?: string }>
}

/** 服务器内部状态。 */
interface FlowState {
  /** 卡片内嵌模式的流程 ID（RPC 面用它寻址；本地壳页模式不使用）。 */
  flowId: string
  uuid: string
  /** 最近一次长轮询的 errcode（作为下次的 `last` 参数）。 */
  lastErrcode: string
  /** 微信确认后拿到的 code（一次性）。 */
  wechatCode: string
  /** bindAuth 返回的上下文（拿 code 后填充）。 */
  rcode: string
  /** `bindAuthThirdAccount` 的 bind 值。 */
  bind: 0 | 1
  /** 微信昵称（展示用）。 */
  nickname: string
  /** 绑手机号流程里 `bindSendMsg` 返回的 msgid。 */
  bindMsgid: string
}

/**
 * 启动微信扫码登录流程。
 *
 * 立即返回 `loginUrl`（本地弹窗页）与 `result` promise，**不阻塞** ——
 * 与其余 provider 的「两步式」约束一致（`window.open` 只在用户手势窗口内有效）。
 */
export async function startLoomyWechatLoginFlow(
  options: LoomyWechatLoginOptions,
): Promise<StartedLoomyWechatLoginFlow> {
  const fetcher = options.fetcher ?? fetch
  const product = options.product
  const state: FlowState = {
    flowId: '',
    uuid: '',
    lastErrcode: '',
    wechatCode: '',
    rcode: '',
    bind: 0,
    nickname: '',
    bindMsgid: '',
  }

  let resolveResult!: (value: LoomyLoginResult & { phone: string; nickname?: string }) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<LoomyLoginResult & { phone: string; nickname?: string }>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  // 先挂空处理器：这个 promise 可能在被消费前就 reject（用户极快完成或立刻失败），
  // 那一段窗口里 Node 会报 unhandled rejection（与 lobsterai-oauth 同因）。
  result.catch(() => {})

  let settled = false
  const settleOk = (value: LoomyLoginResult & { phone: string; nickname?: string }): void => {
    if (settled) return
    settled = true
    resolveResult(value)
  }
  const settleErr = (error: unknown): void => {
    if (settled) return
    settled = true
    rejectResult(error)
  }

  // 先取 uuid（失败则整个流程起不来，直接抛给调用方）。
  state.uuid = await fetchLoomyWechatUuid(randomUUID(), fetcher)

  // 2026-11-07（用户）：卡片内嵌形态——不再起本地壳页服务器。二维码/轮询/绑定
  // 手机号经 RPC（loomy.wechatQr / loomy.wechatPoll / loomy.wechatSms）由渠道卡片
  // 直接渲染与提交；本函数只负责注册流程并返回 flowId 与 result promise。
  state.flowId = randomUUID()
  LOOMY_WECHAT_FLOWS.set(state.flowId, {
    state,
    product,
    fetcher,
    settleOk,
    settleErr,
    isSettledOk: () => settled,
  })

  return { flowId: state.flowId, result }
}

/** 进行中的卡片内嵌流程（flowId → 上下文）。进程级：与账号池同生命周期。 */
export interface LoomyWechatFlowContext {
  readonly state: FlowState
  readonly product: LoomyProduct
  readonly fetcher: typeof fetch
  readonly settleOk: (value: LoomyLoginResult & { phone: string; nickname?: string }) => void
  readonly settleErr: (error: unknown) => void
  readonly isSettledOk: () => boolean
}

const LOOMY_WECHAT_FLOWS = new Map<string, LoomyWechatFlowContext>()

/** 按 flowId 取流程；不存在/已过期返回 undefined。 */
export function loomyWechatFlow(flowId: string): LoomyWechatFlowContext | undefined {
  return LOOMY_WECHAT_FLOWS.get(flowId)
}

/** 流程终态后清理（登录成功/失败/超时都应调用）。 */
export function forgetLoomyWechatFlow(flowId: string): void {
  LOOMY_WECHAT_FLOWS.delete(flowId)
}

/* 原 HTTP 壳页实现（handleRequest + 本地服务器）已随卡片内嵌形态移除；
 * 下面的内部函数（qr/poll/sms）是 RPC 面的共享实现。 */

export async function wechatQrOf(flow: LoomyWechatFlowContext): Promise<{ qrDataUrl: string }> {
  const qrDataUrl = await fetchLoomyWechatQrImage(flow.state.uuid, flow.fetcher)
  return { qrDataUrl }
}

export type WechatPollOutcome =
  | { status: LoomyWechatPollStatus | 'error' | 'done' | 'need_phone'; message?: string; nickname?: string }

export async function wechatPollOf(flow: LoomyWechatFlowContext): Promise<WechatPollOutcome> {
  const { state, settleOk, settleErr, product, fetcher } = flow
  if (state.wechatCode.length > 0) {
    return { status: 'done' }
  }
  const polled = await pollLoomyWechatOnce(state.uuid, state.lastErrcode, fetcher)
  if (polled.errcode.length > 0) state.lastErrcode = polled.errcode
  if (polled.status === LOOMY_WECHAT_POLL_STATUS.confirmed && polled.code.length > 0) {
    // 拿到 code 后立刻换 rcode（一次网络往返），把 bind 结果带回卡片：
    // bind=1 直接 skip 换 session 结束；bind=0 卡片出绑定手机号表单。
    try {
      const auth = await bindLoomyThirdAccount(polled.code, product, fetcher)
      state.rcode = auth.rcode
      state.bind = auth.bind
      state.nickname = auth.nickname ?? ''
      if (auth.bind === 1) {
        const login = await bindLoomySkip(auth.rcode, product, fetcher)
        settleOk({ ...login, phone: '', ...state.nickname.length > 0 ? { nickname: state.nickname } : {} })
        return { status: 'done' }
      }
      return { status: 'need_phone', nickname: state.nickname, message: undefined }
    } catch (error) {
      settleErr(error)
      return { status: 'error', message: error instanceof Error ? error.message : String(error) }
    }
  }
  return { status: polled.status } as WechatPollOutcome
}

export async function wechatSmsOf(
  flow: LoomyWechatFlowContext,
  action: 'send_sms' | 'verify_sms' | 'skip',
  payload: { phone?: string; code?: string },
): Promise<{ ok: true } | { ok: false; message: string } | { ok: true; login: LoomyLoginResult & { phone: string; nickname?: string } }> {
  const { state, settleOk, product, fetcher } = flow
  try {
    if (action === 'send_sms') {
      const phone = String(payload.phone ?? '')
      state.bindMsgid = await bindLoomySendMsg(state.rcode, phone, product, fetcher)
      return { ok: true }
    }
    if (action === 'verify_sms') {
      const code = String(payload.code ?? '')
      const phone = String(payload.phone ?? '')
      const login = await bindLoomyCheckCode(
        state.rcode, code, state.bindMsgid, product, fetcher,
      )
      const settled: LoomyLoginResult & { phone: string; nickname?: string } = {
        ...login,
        phone: login.phone.length > 0 ? login.phone : phone,
        ...state.nickname.length > 0 ? { nickname: state.nickname } : {},
      }
      settleOk(settled)
      return { ok: true, login: settled }
    }
    if (action === 'skip') {
      const login = await bindLoomySkip(state.rcode, product, fetcher)
      const settled: LoomyLoginResult & { phone: string; nickname?: string } = {
        ...login,
        phone: '',
        ...state.nickname.length > 0 ? { nickname: state.nickname } : {},
      }
      settleOk(settled)
      return { ok: true, login: settled }
    }
    return { ok: false, message: `未知 action：${String(action)}` }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
