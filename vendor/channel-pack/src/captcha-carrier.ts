/**
 * captcha 产出入口（2026-11-16 重写：**只用系统默认浏览器**）。
 *
 * ## 历史与现在的取舍
 *
 * - 一期：外挂 chromium/scoop 浏览器链（`src/zcode-captcha.ts`）+ 内部载体兜底
 * - 2026-11-14：用户要求「只用客户端内置浏览器」⇒ 外挂链整条退役，只剩面板
 *   `iframe.srcdoc` 载体页贡献 param
 * - 2026-11-16：**用户要求改回「只用系统默认浏览器」**（原话：「不用 chromium 兜底，
 *   直接使用系统默认浏览器，内置浏览器的代码可以删了」）
 *
 * 为什么 11-14 那次是错的（实测结论，记在此避免重犯）：
 *
 * | 场景 | 内置载体 | 结果 |
 * |---|---|---|
 * | 面板开着、有人看着 | 能产 | 可能成功 |
 * | **定时自动签到**（凌晨） | 产不出（无人轮询需求位） | **必然失败** |
 * | NAS/容器 | 无浏览器可跑 | 必然失败 |
 *
 * 且 `waitForFreshParam` 只等 1.5 秒，对阿里云 SDK 冷启动（实测 >4 秒）本就不够。
 * ⇒ 自动签到在这种设计下**结构性不可用**，这正是用户报障的根因。
 *
 * 现在：param 由**系统默认浏览器**产出（`src/zcode-default-browser.ts` 探测 +
 * `src/zcode-captcha.ts` 驱动）。这条路与面板是否打开无关，自动签到才可能工作。
 * 内部载体（供给槽 / 需求位 / 载体页 / carrier 小服务）已整条删除。
 *
 * ⚠ 容器（NAS）里没有浏览器可执行文件 ⇒ 签到在那里必然失败。这是**已接受的
 *   预期形态**，不是缺陷：zcode 签到本来就只在有桌面的机器上做。
 */
/**
 * 一次 captcha 产出的结果。
 *
 * `source` 保留两个取值是为了**诊断可读性**：日志里能区分「浏览器产的」与
 * （历史上）「面板载体产的」。2026-11-16 起只会出现 `browser`。
 */
export interface CarrierOutcome {
  param: string
  source: 'browser'
}

/**
 * 没有任何 param 来源可用时的统一文案（claim 原样给用户）。
 *
 * 语义是「这台机器上没有可用的浏览器」，不是「坏了」：容器/无头环境是预期形态。
 */
export const CARRIER_UNAVAILABLE_MESSAGE =
  'zcode 签到需要本机的默认浏览器来产生 captcha，但当前环境找不到可用的浏览器可执行文件'

export interface CaptchaCarrierDeps {
  /**
   * 用系统默认浏览器产出一个 param。
   *
   * 调用方（`ZcodeAuth`）传的是 `mintWithChromium` —— 名字是历史遗留，
   * 实际链路是「退避闸门 → 串行队列 → `CaptchaPool.take()` → 默认浏览器」。
   */
  mintWithBrowser: (options?: { signal?: AbortSignal }) => Promise<string>
  /** 诊断日志。 */
  log?: (message: string) => void
}

/**
 * captcha 产出器：一层薄封装，只做「调用浏览器 + 记录归因」。
 *
 * 保留这个类（而不是让 `ZcodeAuth` 直接调浏览器）是为了让**归因计数**
 * （`browserUsed` / `browserRejected`）有唯一落点，给 `status()` 与日志用。
 */
export class CaptchaCarrier {
  private readonly mintWithBrowser: (options?: { signal?: AbortSignal }) => Promise<string>
  private readonly log: ((message: string) => void) | undefined
  private readonly counters = { browserUsed: 0, browserRejected: 0 }

  constructor(deps: CaptchaCarrierDeps) {
    this.mintWithBrowser = deps.mintWithBrowser
    this.log = deps.log
  }

  /** 产出一个 param。抛错即「本机产不出」（无浏览器 / 被退避闸门挡住 / SDK 失败）。 */
  async mint(options: { signal?: AbortSignal } = {}): Promise<CarrierOutcome> {
    this.counters.browserUsed += 1
    return { param: await this.mintWithBrowser(options), source: 'browser' }
  }

  /**
   * 上一次的产出被上游 `3007` 拒 ⇒ 换一个新 param 重发。
   *
   * param 是一次性的（复用必 `3007`），所以「被拒」只说明**那一发**无效，
   * 不代表本机产不出 —— 直接再产一个即可。
   */
  async mintWithFallbackAfterRejection(
    _outcome: CarrierOutcome,
    options: { signal?: AbortSignal } = {},
  ): Promise<CarrierOutcome> {
    this.counters.browserRejected += 1
    this.log?.('zcode: 上一次 param 被 3007 拒 ⇒ 重新产一个再发')
    return await this.mint(options)
  }

  /** 诊断计数（`status()` 暴露给 UI）。 */
  stats(): { browserUsed: number; browserRejected: number } {
    return { ...this.counters }
  }
}
