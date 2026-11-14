/**
 * captcha **载体链**（2026-11-14 重构，用户定的方向）：**客户端内置浏览器是唯一
 * param 来源** —— 面板（client.js）轮询需求位，用 srcdoc 载体页 mint，经
 * `captcha.contribute` RPC 送进供给槽；本类只做「取槽 / 有界等待」。
 *
 * ## 外挂浏览器链为什么整个退役
 *
 * 用户部署形态两类：桌面三端（宿主 Electron，面板 iframe 常驻）与 NAS/web
 * （无头，本机无任何浏览器）。外挂链在 NAS **永远失败**（找不到可执行文件），
 * 在桌面**每次冷启都弹窗口 + 烧一轮设备级风控指纹**（阿里云同设备 150 次/小时）。
 * 内部载体三端同一行为：param 由**用户自己的浏览器**产出，与部署形态无关；
 * 上游校验的是阿里云签发的 param 本身（实测 2026-11-14：载体页 param 发真实
 * claim，上游接受——`code:1003`，校验通过后才到 plan 层）。
 *
 * ## 等不到贡献时怎么办（不再回退）
 *
 * 抛 {@link CarrierUnavailableError}：claim 把它转成「签到不支持当前客户端」
 * 的明确文案。NAS/web 的用户看到的是可行动的指引；桌面版若面板没开过
 * （无人贡献）同样如此 —— 修法是打开一次面板，而不是装浏览器。
 *
 * ## 保留的两条既有护栏（逐字不动的语义）
 * 1. 时效判定只在供给槽的 `takeFreshParam`（唯一那道闸）；
 * 2. 「内部 param 被上游拒」累计到阈值即本次运行禁用内部载体
 *    （`noteInternalRejection`）——禁用后 mint 直接抛不可用，别再赌。
 *
 * ## 归因
 * `CarrierOutcome.source` 只剩 `'internal'` 一种，保留字段是为了诊断日志
 * 与既有调用点（`mintClaimCaptcha` 的归因注释）不必整批改写。
 */
import {
  captchaDemand,
  captchaSupplyStats,
  DEFAULT_CARRIER_WAIT_MS,
  takeFreshParam,
  waitForFreshParam,
} from './captcha-supply.js'

/** 内部载体的 param 被上游拒到第几次就本次运行停用（阈值取自 spec 9.3）。 */
export const CARRIER_REJECT_DISABLE_THRESHOLD = 3

/**
 * 没有任何 param 来源可用（面板从未贡献 / 内部载体被禁用 / env 关掉）。
 *
 * claim 把它的 message 原样给用户： NAS/web 形态这是**预期终态**——
 * 文案就是指引；桌面三端出现它 = 面板没开过，指引是「打开 Our Free Model
 * 面板一次」。外挂浏览器链退役后没有别的来源，这不是错误重试能解决的。
 */
export class CarrierUnavailableError extends Error {
  constructor(message = CARRIER_UNAVAILABLE_MESSAGE) {
    super(message)
    this.name = 'CarrierUnavailableError'
  }
}

/**
 * mint 无来源时的统一文案（claim 原样给用户）。
 *
 * ⚠ 语义是「这条部署形态做不了 zcode 的安全验证」，不是「坏了」：
 * NAS/web 是预期形态；桌面三端出现它 = 面板没开过（打开 Our Free Model
 * 面板一次，GUI 会自动开始贡献）。
 */
export const CARRIER_UNAVAILABLE_MESSAGE =
  'zcode 签到不支持当前客户端：captcha 需要在 DSH 桌面版的 Our Free Model 面板中完成（打开面板即自动产出）'

/** 一次产出的结果：param 加上来源标记（现只余 internal；字段保留供诊断日志）。 */
export interface CarrierOutcome {
  param: string
  source: 'internal' | 'chromium'
}

export interface CaptchaCarrierDeps {
  /** 等内部载体贡献的上限（毫秒）。默认与 client 贡献心跳同量级，取自供给槽模块。 */
  waitMs?: number
  /** 时钟（注入以便单测推进 param 年龄）。 */
  now?: () => number
  /** 诊断日志。 */
  log?: (message: string) => void
}

export class CaptchaCarrier {
  private readonly waitMs: number
  private readonly nowImpl: () => number
  private readonly log: ((message: string) => void) | undefined
  /** 内部载体的 param 被上游拒的累计次数（达到阈值即禁用，见文件头）。 */
  private rejections = 0
  private disabled = false
  private readonly counters = { internalUsed: 0, chromiumUsed: 0 }

  constructor(deps: CaptchaCarrierDeps) {
    this.waitMs = deps.waitMs ?? DEFAULT_CARRIER_WAIT_MS
    this.nowImpl = deps.now ?? (() => Date.now())
    this.log = deps.log
  }

  /** 内部载体是否已被本次运行禁用（禁用后连槽里有货也不用，见 `mint`）。 */
  internalDisabled(): boolean {
    return this.disabled
  }

  /**
   * 产出一个 param：内部优先，等不到即 chromium。
   *
   * 三条出口（顺序即优先级）：
   * 1. **槽里已有新鲜 param** → 立刻用。⚠ 这条**不看需求位**：client 既然已经产出了，
   *    再为了「统一走等待」把它留在槽里过期，等于白烧一份配额；
   * 2. **需求位为真**（`captchaDemand`，语义同 `src/captcha-requirement.ts` 的
   *    「上游要验证」）→ 有界等一次贡献，等到就用；
   * 3. 其余一律 chromium，**不白等** —— 需求位为假时每条消息都等 `waitMs`
   *    会把「上游不校验时零成本」这个收益整个赔回去。
   *
   * ⚠ 禁用之后必须**既不等也不取槽**：`waitForFreshParam` 被唤醒时自己会去
   * `takeFreshParam`，所以「只把入口那条 take 短路掉」是不够的 —— 漏掉这一层短路，
   * 内部 param 仍会从等待那条路溜出去，而它正是被上游拒过 3 次的那类东西。
   */
  async mint(options: { signal?: AbortSignal } = {}): Promise<CarrierOutcome> {
    if (!this.disabled) {
      const ready = takeFreshParam(this.nowImpl())
      if (ready !== undefined) {
        this.counters.internalUsed += 1
        return { param: ready, source: 'internal' }
      }
      if (captchaDemand()) {
        // ⚠ 第一个实参是**时钟函数**本身，不是 `this.nowImpl()`：
        // `waitForFreshParam(now, maxWaitMs, …)` 要在超时与被唤醒时各读一次时钟。
        // GUI 贡献循环（client.js 面板）就是被这个等待等出来的：demand 置起后
        // 面板建 srcdoc 载体页 mint，postMessage → contribute → 槽被唤醒。
        const waited = await waitForFreshParam(this.nowImpl, this.waitMs, options)
        if (waited !== undefined) {
          this.counters.internalUsed += 1
          return { param: waited, source: 'internal' }
        }
      }
    }
    throw new CarrierUnavailableError(CARRIER_UNAVAILABLE_MESSAGE)
  }

  /**
   * 带着上一次的产出去撞过上游、结果被 `3007` 拒 ⇒ 记一次归因。
   *
   * 外挂链退役后**没有第二个来源**：内部 param 被拒说明本设备信誉被降级
   * （无感验证被换成了滑块），换浏览器/换链重发都救不了 —— 如实向上抛，
   * claim 的换链分支（`retryClaimWithInjectedChain`）随之退役。
   */
  async mintWithFallbackAfterRejection(
    _outcome: CarrierOutcome,
    _options: { signal?: AbortSignal } = {},
  ): Promise<CarrierOutcome> {
    this.noteInternalRejection()
    throw new CarrierUnavailableError(CARRIER_UNAVAILABLE_MESSAGE)
  }

  /**
   * 记一次「内部载体的 param 被上游拒」，并在到阈值时**本次运行禁用**内部载体。
   *
   * ## 为什么单独暴露（评审 C4）
   * 领取路径（`ZcodeAuth.claimDailyWith`）也要记同一笔账，但它重发时走的是
   * **注入链**（`channel-pack-rpc.ts` 注入的那条），不是本类里那条 chromium 腿 ——
   * 用 `mintWithFallbackAfterRejection` 会顺手多产一个没人用的 param。
   * ⇒ 把「记账 + 阈值禁用」这段（也就是本文件头「累计 N 次就禁用」那套语义）
   * 抽成这个方法，两个调用点共用**同一份**阈值判断，不会漂移成两处真相。
   */
  noteInternalRejection(): void {
    this.rejections += 1
    this.log?.(
      `zcode: 内部载体的 param 被上游拒（第 ${String(this.rejections)} 次）`
      + ' ⇒ 当次改用 chromium 重产',
    )
    if (!this.disabled && this.rejections >= CARRIER_REJECT_DISABLE_THRESHOLD) {
      this.disabled = true
      this.log?.(
        `zcode: 内部载体累计被拒 ${String(this.rejections)} 次 ⇒ 本次运行禁用内部载体，`
        + '只走 chromium（排查：载体页是否被 CSP/网络拦、guest 的 location.origin 是否正常）',
      )
    }
  }

  /**
   * 观测：本链路的取舍计数 + 供给槽统计（面板与日志用，与 `zcode-auth.ts` 的 stats 同处）。
   *
   * ⚠ 槽那份快照里有 `interactive` / `pendingInteractive`（评审 I2）：内部载体被 SDK
   *   降级成**交互式验证**是这台机器设备信誉变差的**唯一**预警（chromium 那条腿
   *   已经会 `warn`，内部载体这段此前只打进 client 控制台，host 侧看不到）。
   *   `pendingInteractive` 说「**当前槽里那条**是不是交互式产物」—— 取走即归零。
   */
  stats(): {
    internalUsed: number
    chromiumUsed: number
    internalRejected: number
    disabledAfter: number
    supply: ReturnType<typeof captchaSupplyStats>
  } {
    return {
      internalUsed: this.counters.internalUsed,
      chromiumUsed: this.counters.chromiumUsed,
      internalRejected: this.rejections,
      disabledAfter: CARRIER_REJECT_DISABLE_THRESHOLD,
      supply: captchaSupplyStats(),
    }
  }

  /** chromium 产出并记账。**唯一**出口，异常原样上抛（退避闸门的语义要保住）。 */
}
