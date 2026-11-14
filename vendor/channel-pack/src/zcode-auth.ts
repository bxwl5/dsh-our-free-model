/**
 * ZCode 认证/凭据服务（`ctx.zcodeAuth`）。
 *
 * ## 凭据的**唯一**来源：插件自己的授权流
 *
 * 用户在 Channel Pack 面板点「添加账号」→ 走官方 CLI 设备授权流
 * （`zcode-login.ts`）→ 凭据写进 `ctx.credentials`。
 * **不读取本机 ZCode 客户端的任何数据**（2026-10-05 决策，理由见
 * `zcode.ts` 文件头）。
 *
 * ## 与其它 auth 服务的关键差异
 *
 * 其它 `ctx.xxxAuth` 管「浏览器登录 → 拿 token → **续期**」。
 * ZCode 的凭据是**静态**的（JWT 的 payload 里没有 `exp`）⇒ **不可续期**，
 * 失效时上游回 401/1002，由适配器归为 AUTH 提示用户重新登录。
 *
 * 本服务的职责是：
 *
 * 1. **登录与存凭据**（`startLogin` / `login`），含顺带换取 coding-plan key
 * 2. **探活**：凭据是否可用（能不能拿到额度）
 * 3. **额度**：`billing/balance`
 * 4. **签到**：补激活上报 → preview → claim（每个 plan 单独 mint captcha）
 * 5. **captcha 配置**：`client/configs`（拿 region/prefix/sceneId）
 *
 * ## ⚠ 必须 `extends Service`
 *
 * 其余八个 auth 服务全部继承 `@deepseek-ai/cordis` 的 `Service` 基类，
 * 由基类构造函数完成 `ctx.provide(<name>, this)` 注册。
 * 初版 `ZcodeAuth` 是个**裸 class**，既没继承也没自己 provide ——
 * 结果是 `ctx.zcodeAuth` **恒为 undefined**（行为探针实证），
 * 与注释里「注册为 ctx.zcodeAuth」的声明直接矛盾。
 *
 * 服务名由 `product.id` 派生为 `zcodeAuth`，与 `RaccoonAuth` 同款做法。
 *
 * ## ⚠ 不注册任何斜杠命令
 *
 * 与其余 provider 一致：登录/状态/额度/签到全部在 Channel Pack 面板完成。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { AccountPool } from './account-pool.js'
import type { CheckinStatus } from './credits.js'
import type { ClaimOutcome } from './credits.js'
import {
  isUsableZcodeCredential,
  phoneFromUserId,
  type ZcodeCredential,
} from './zcode.js'
import { ZCODE, type ZcodeProduct, type ZcodeRemoteModelLike } from './zcode-product.js'
import type { ZcodeClaimablePlan } from './zcode-upstream.js'
import {
  ZCODE_CAPTCHA_FALLBACK,
  validateCaptchaParam,
  type ZcodeCaptchaConfig,
} from './zcode-captcha.js'
import { captchaRequirementObservability } from './captcha-requirement.js'
import { CaptchaCarrier, CarrierUnavailableError, type CarrierOutcome } from './captcha-carrier.js'
import { buildCarrierPageHtml } from './zcode-carrier-page.js'
import { captchaDemand, captchaSupplyStats, setCaptchaDemand } from './captcha-supply.js'
import { TtlCache } from './ttl-cache.js'
import { generateDeviceMid, runZcodeLogin, type ZcodeLoginProvider } from './zcode-login.js'
import { fetchCodingPlanApiKey } from './zcode-transport.js'
import {
  formatZcodeDiagnostic,
  formatZcodeUnusualActivityMessage,
  isZcodeUnusualActivityCode,
  mentionsZcodeUnusualActivity,
  noteZcodeRequestFailed,
  noteZcodeRequestOk,
  noteZcodeRequestSent,
} from './zcode-diagnostics.js'
import {
  claimZcodePlan,
  fetchZcodeBalance,
  fetchZcodeCaptchaConfig,
  fetchZcodeClaimablePlans,
  fetchZcodeModels,
  reportZcodeActivation,
  type ZcodeBalanceResult,
  type ZcodeClaimOutcome,
} from './zcode-upstream.js'

/** 一次探活的结果。 */
export interface ZcodeProbeResult {
  /** 凭据是否可用。 */
  available: boolean
  /** 展示名（脱敏手机号 / 设备码）。 */
  accountLabel?: string
  /** 剩余额度（探活成功时）。 */
  remaining?: number
  /** 不可用时的原因（人类可读）。 */
  reason?: string
}

/**
 * 领取路径注入的 param 产出回调。
 *
 * ## ⚠ 实参是「**本次领取用的那份** captcha 配置」，不是可选装饰
 *
 * 阿里云验签时会把 param 与请求头 `x-aliyun-captcha-verify-region` **成对**校验，
 * 两边不是同一个 region 就必然 `400 / 3007`（captcha 校验失败）。
 *
 * ⚠ 真实缺陷（Gitee issue IKJNPS，用户报障，非 cn 区账号 100% 复现）：
 * 「一键领取」此前由调用方自己去 `fetchCaptchaConfig()` 拿配置产 param，
 * 而 region 走 `claimDailyFor` 的**兜底常量** `ZCODE_CAPTCHA_FALLBACK.region`
 * （`cn`）。于是 z.ai 国际渠道（服务端下发 `region: "sgp"`）这类账号
 * 会稳定发出「sgp 签的 param + cn 的 region 头」⇒ 恒 `3007`，一个都领不到。
 *
 * ⇒ 由 {@link ZcodeAuth.claimDailyWith} 解析**一次**配置，并把同一份传进来，
 * 让「param 的来源」与「region 的来源」**在类型上就是同一份**。
 */
export type ZcodeClaimCaptchaMint = (config: ZcodeCaptchaConfig) => Promise<string>

/** `ZcodeAuth` 的构造选项。 */
export interface ZcodeAuthOptions {
  /** 产品配置；默认 {@link ZCODE}。 */
  product?: ZcodeProduct
  /** 服务名覆盖（默认由产品 id 派生为 `zcodeAuth`）。 */
  serviceName?: string
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
  /**
   * 账号池（测试用）。
   *
   * 生产路径靠 `ctx.get('accountPool')` 惰性取（见 `accountPool()`），
   * 但单测里未必把池注册到 ctx 上 —— 故保留这个注入口。
   */
  accountPool?: AccountPool
  /**
   * **内部载体链**的诊断日志（缺省完全不输出）。
   *
   * 与 `ZcodeAdapterOptions.log` 同因：那两条告警（「内部载体的 param 被上游拒」
   * 「累计拒 N 次 ⇒ 本次运行禁用内部载体」）是排查内部载体为什么不起作用的**唯一**线索，
   * 缺省不接就等于线上什么都看不见。由 `index.ts` 注入 `ctx.logger?.warn?.()`。
   */
  carrierLog?: (message: string) => void
}

/**
 * 内部载体（DSH Desktop 的 webview guest 产 param）是否**允许**参与产出。
 *
 * ⚠ 只有显式 `0` 表示关闭（关掉 ⇒ **既不有界等待、也不取供给槽**，逐字回到一期的
 *   那条 chromium 链）。判据与 `captchaQueueEnabledFromEnv` / `captchaBackoffConfigFromEnv`
 *   同款：**未设置/空串 = 默认开**。
 *
 * ⚠ **不许**写成 `parseInt(env) || 默认值` 那类判断 —— `0` 恰恰是本开关**唯一**
 *   有意义的取值，`||` 会把它当成假值静默换成默认（本仓库在
 *   `DSH_QODER_QUEUE_TIMEOUT_MS` 上犯过一次，AGENTS.md 有记录）。
 *   网在 `tests/unit/zcode-carrier-auth.spec.ts` 的「只有显式 `0` 关掉」那条。
 */
export function internalCarrierEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['DSH_ZCODE_INTERNAL_CARRIER']
  return raw === undefined || raw.trim().length === 0 ? true : raw.trim() !== '0'
}

/**
 * 换取 coding-plan api-key 的**总超时**（毫秒）。
 *
 * ⚠ 它是 3 个只读 GET（`getCustomerInfo` → 列 `api_keys` → `copy`），
 * 正常合计不到 1 秒。留 8 秒只为容忍慢网；**绝不能**因为它把「登录」
 * 挂住 —— 登录完成后调用方还要接着轮询结果、发消息。
 */
const CODING_PLAN_KEY_TIMEOUT_MS = 8_000

/**
 * 给一个 promise 加超时（超时以异常形式抛出，交给调用方记录）。
 *
 * ⚠ `Promise.race` 会给**每一个**输入都挂上处理器，故原 promise 之后才
 * reject 也不会变成 unhandled rejection —— 不需要额外的 `.catch()`。
 */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`超时（${String(ms)}ms）`)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** ZCode 认证服务。 */
export class ZcodeAuth extends Service {
  private readonly product: ZcodeProduct
  private readonly fetchImpl: typeof fetch
  /** 注入的账号池（测试用；生产走 ctx.get）。 */
  private readonly injectedPool: AccountPool | undefined
  /**
   * 常驻 captcha 浏览器。
   *
   * ⚠ 常驻是必需的：浏览器**进程**冷启动实测约 690ms，每次拉一台会让首字延迟凭空多一秒。
   * ⚠ 但**不是**「每次 mint 都要新建 page」：那个 1.2 秒（中位 1246ms）是页面停在
   * `about:blank` 时的历史结论，origin 修正后同一页面可连续 mint —— 现行**复用常驻页面**，
   * 稳态一次约 0.4–0.5 秒（中位 426ms / 平均 546ms）。依据与矩阵见 `zcode-captcha.ts` 的
   * `CAPTCHA_PAGE_ORIGIN`，口径统一见 README 的 ZCode 章节。
   * 另：mint 本身现在是**按需**的（先探后取，见 `captcha-requirement.ts`），
   * 上游不要验证的窗口里这条路一次都不走。
   * 生命周期由 `stop()` 收尾。
   */
  /**
   * captcha **预取池**（挂在与浏览器同一个生命周期上）。
   *
   * ⚠ 惰性创建：纯插件登录、从不用推理的用户不该为它做任何事。
   */
  /**
   * 最近一次 `mintCaptcha` 用的 captcha 配置。
   *
   * 池的 `mint` 回调不带参数（它的语义是「产一个 param」），故配置由这里传递。
   * 配置来自服务端 `client/configs` 且极少变化，跟着最近一次调用走即可。
   */
  private captchaMintConfig: { region: string; prefix: string; sceneId: string } | undefined
  /**
   * captcha **产出失败退避**（设备级信誉保护）。
   *
   * ⚠ 它**不惰性创建**：闸门要在第一次
   * `mintCaptcha` 之前就生效，且构造它无任何副作用。
   */
  /**
   * captcha 产出的**全局串行队列**（对齐官方 `jnn`/`wnn`）。
   *
   * ⚠ 必须是**实例字段**：队列靠共享的尾巴指针生效，每次新建等于没有队列。
   */
  /**
   * captcha **载体链**（二期 Task 5 接线）：内部载体（DSH Desktop 的 guest 产的 param）
   * 优先，等不到再落回 {@link mintWithChromium} 那条既有链。
   *
   * ## 注入的那条 chromium 腿**就是既有那条链**，一行语义都没改
   * `mintWithChromium` = {@link mintWithChromium}（退避闸门 → `captchaQueue` 串行
   * → 预取池 take），也就是 Task 5 之前的 `mintCaptcha` 函数体。
   * ⚠ **不许**在这里另开一条「直接调浏览器」的捷径：那等于把
   *   「同设备每小时 150 次」的两道护栏（冷却闸门 + 全局串行）拆掉。
   *
   * ## param 的年龄口径（与 `elapsedMs` 的关系，别记混三个数）
   * | 数 | 谁算的 | 锚点 | 用途 |
   * |---|---|---|---|
   * | `atMs` | `src/channel-pack-rpc.ts` 的 `captcha.contribute`：server 到达时刻 **− elapsedMs** | **server 时钟** | 槽的年龄基准（= 推算的产出时刻） |
   * | `elapsedMs` | client 报的「产出 → 回传」相对耗时（同机单向差值） | 两端**同一台机器** | 把到达时刻往前推成真实产出时刻 |
   * | 年龄 | `takeFreshParam(now) - atMs` | server 时钟 | 超过 `PARAM_MAX_AGE_MS` 一律丢 |
   *
   * ⚠ 不用 client 的**绝对**时间戳（跨端时钟漂移会把时效闸弄废），
   *   也不用纯到达时刻（那会**低估**一个 client→server 跳数的年龄）—— 详见
   *   `src/captcha-supply.ts` 的 `SupplySlot.atMs` 注释。
   * ⚠ 与适配器日志里那个 `mintMs` **不是一回事**：`mintMs` 是「取 param」这一跳的
   *   墙上时钟差（`src/zcode-adapter.ts`，含载体链那至多 1.5 秒的有界等待），
   *   只用于前置耗时诊断，不参与任何时效判定。
   *
   * ⚠ **实例字段**（不是每请求新建）：被上游拒的累计计数与「本次运行是否已禁用」
   *   必须跨请求活着，否则永远到不了阈值。
   */
  readonly carrier: CaptchaCarrier
  /** 内部载体的 env 开关（构造期读一次，与 `captchaQueueEnabledFromEnv` 同一读取点）。 */
  private readonly internalCarrierEnabled: boolean
  /**
   * 载体页小服务（评审 C1/C2 的形态 B）—— 已随外挂链退役删除。
   *
   * ## 为什么它必须挂在**插件自己的 `/api/…` 之外**（这轮修掉的致命缺陷）
   * 桌面版主进程对 guest 的请求有两道硬闸（asar `lib/main.js`，DSH Desktop 0.2.0-rc.2）：
   * `allowedNavigation()` 与 `configureSession().onBeforeRequest` 都以
   * `isApplicationHost(url)` 拒绝「**端口相同** 且 主机相同/回环」的地址 ——
   * 而插件的 `/api/channel-pack/captcha-carrier` 正好就是那个端口 ⇒ guest 连文档都建不起来。
   * 换端口即绕开（那也是 `isApplicationHost` 判定的盲区），代价是要自己监听一个回环端口。
   *
   * ## 为什么**懒起**而不是构造期就起
   * web 版根本不会有人来问地址（`dshDesktop.browser` 拿不到 ⇒ 贡献循环整体 return，
   * 一个 RPC 都不发）—— 那就别给 web 版开一个常驻监听器（凭空多一个端口是行为变化）。
   * 懒起也让「起了就一定用得上」成立：唯一调用方是 `captcha.carrierUrl` 那条 RPC。
   */
  /** 构造期注入的诊断日志（载体链与载体页小服务共用同一条通道，见 `ZcodeAuthOptions`）。 */
  private readonly carrierLog: ((message: string) => void) | undefined
  /**
   * captcha 产出的**观测计数**（对齐官方 `mnn` 的 ARMS 上报思路）。
   *
   * 官方把每次结果作为 `traceless_passed` / `interactive_displayed` 上报，
   * 并维护两个计数器 —— 那是它判断「设备信誉是否在恶化」的手段。
   * 我们至少要把这两个数**记下来并通过日志暴露**，否则降级发生时
   * 用户和我们都没有任何趋势可看（这正是这次排查最缺的东西）。
   */
  private readonly captchaStats = {
    /** 无感验证直接通过的次数。 */
    tracelessPassed: 0,
    /** 弹出了交互式验证（滑块/拼图）的次数 —— **升高的信号要警惕**。 */
    interactiveDisplayed: 0,
    /** 产出失败的次数。 */
    failed: 0,
    /**
     * 「不带验证头先探」的次数（先探后取生效的直接证据）。
     *
     * ⚠ 这里**只是形状占位，不是状态**：真实计数是**进程级**的 ——
     * 由 `captcha-requirement.ts` 的 `noteProbeFirst()` / `noteKnownRequiredHit()`
     * 累加（调用点只有 `zcode-adapter.ts` 内层循环那一处，`attempt === 0` 才记），
     * 本类只**读出并展开**同一份事实（见 `captchaObservability()` 的
     * `...captchaRequirementObservability()`）。
     * **别在本类里对它 `+= 1`** —— 两份状态必然漂移。
     */
    probeFirstCount: 0,
    /** 「命中需要验证记忆」的次数（= 省掉一次 `3007` 往返的次数）。同为形状占位。 */
    knownRequiredCount: 0,
  }
  /** 最近一次失败原因（供 `status()` 暴露给 UI）。 */
  private lastError: string | undefined

  constructor(ctx: Context, options: ZcodeAuthOptions = {}) {
    const product = options.product ?? ZCODE
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.fetchImpl = options.fetchImpl ?? fetch
    this.injectedPool = options.accountPool
    this.internalCarrierEnabled = internalCarrierEnabledFromEnv()
    this.carrierLog = options.carrierLog
    this.carrier = new CaptchaCarrier({
      // 2026-11-14：外挂 chromium 腿退役 —— 内置浏览器（面板 srcdoc 载体页）是
      // 唯一 param 来源。等不到贡献就抛 CarrierUnavailableError（claim 转成
      // 「不支持当前客户端」文案），不再找本机浏览器。
      ...(this.carrierLog === undefined ? {} : { log: this.carrierLog }),
    })
  }

  /** 凭据 ref 名（供 Channel Pack 展示）。 */
  get credentialRefName(): string {
    return this.product.defaultCredentialRef
  }

  /** 产品配置（测试与 Channel Pack 用）。 */
  get productConfig(): ZcodeProduct {
    return this.product
  }

  /**
   * 读取当前凭据（**唯一来源：插件自己存的那份**）。
   *
   * ## ⚠ 不再有第二个来源（2026-10-05 用户决策）
   *
   * 旧实现会回退去解密官方客户端的 `~/.zcode/v2/credentials.json`
   * （「装了 ZCode 就零操作可用」）。该能力**已整体删除**，理由见
   * `src/zcode.ts` 文件头。⇒ 现在没有 ZCode 账号就是没有，
   * UI 必须引导用户走 Channel Pack 里的登录，**不要**再暗示「装了客户端就能用」。
   *
   * 返回 `undefined` 表示「没有可用的 ZCode 登录态」。
   */
  async current(): Promise<ZcodeCredential | undefined> {
    return await this.readStoredCredential()
  }

  /**
   * 读插件自存的凭据（`ctx.credentials`）。
   *
   * ## ⚠ 必须同时认**账号池里的 ref**（真实缺陷）
   *
   * 凭据可能落在**两个**地方，ref 名不同：
   *
   * | 来源 | ref |
   * |---|---|
   * | RPC `account.create`（用户点「添加账号」） | **`ZCODE_ACCOUNT_XXXX`**（`refName`） |
   * | 单凭据回退 / 手工写入 | `ZCODE_CREDENTIAL`（`defaultCredentialRef`） |
   *
   * 早期只读后者 —— 于是「用户在 Channel Pack 登录成功」之后，
   * `probe()` / `fetchBalance()` / `status()` / `fetchCheckinStatus()`
   * **全都读不到凭据**（它们都走本方法），表现为：
   * **能聊天（适配器读账号条目的 ref），但面板显示「未配置」、积分查不出**。
   *
   * ⇒ 顺序：**账号池（用户的显式登录）> 单凭据 ref（回退）**。
   * 与适配器的解析顺序保持一致，避免「适配器能用而面板不能用」。
   *
   * ⚠ **形状校验必须做**：凭据存储里可能有**任何**字符串（用户手填、旧版本
   * 残留）。`isUsableZcodeCredential` 保证后续代码拿到的是完整对象。
   */
  private async readStoredCredential(): Promise<ZcodeCredential | undefined> {
    // ① 账号池：用户显式登录创建的账号条目（ref 形如 ZCODE_ACCOUNT_XXXX）。
    const fromPool = await this.readCredentialFromPool()
    if (fromPool !== undefined) return fromPool
    // ② 单凭据回退 ref。
    return await this.readCredentialFromRef(this.product.defaultCredentialRef as CredentialRef)
  }

  /**
   * 从账号池里第一个**凭据可用**的 zcode 账号读取。
   *
   * ⚠ **不看 `enabled`** —— 与其余 provider 的既有约定一致
   * （`AGENTS.md`：停用只影响自动选号，与凭据是否可用无关）。
   * 用户停用了账号，面板仍应能显示它的额度与状态。
   */
  private async readCredentialFromPool(): Promise<ZcodeCredential | undefined> {
    const pool = this.accountPool()
    if (pool === undefined) return undefined
    try {
      for (const entry of pool.listAccountsByProvider(this.product.id)) {
        const credential = await this.readCredentialFromRef(entry.credentialRef as CredentialRef)
        if (credential !== undefined) return credential
      }
    } catch {
      // 账号池异常（未初始化/存储损坏）→ 退回单凭据路径。
    }
    return undefined
  }

  /** 从某个 ref 解析凭据（带形状校验）。 */
  private async readCredentialFromRef(ref: CredentialRef): Promise<ZcodeCredential | undefined> {
    try {
      const resolved = await this.ctx.credentials.resolve(ref)
      if (resolved === undefined || resolved === null) return undefined
      const parsed = JSON.parse(resolved.value) as unknown
      if (!isUsableZcodeCredential(parsed)) return undefined
      // 补上来源标记（旧凭据里没有这个字段）。
      return { ...parsed, source: parsed.source ?? 'plugin' }
    } catch {
      // 未配置或 JSON 损坏都视为「这份 ref 不可用」，让调用方试下一个。
      return undefined
    }
  }

  /**
   * 取账号池。
   *
   * ⚠ 用 `ctx.get` 而非构造注入：本服务可能在**账号池注册之前**被构造
   * （`index.ts` 里 `new ZcodeAuth(ctx)` 早于 `registerChannelPackRpc`，
   * 且测试里账号池可能是后提供的）。惰性读取能让两种情况都成立。
   */
  private accountPool(): AccountPool | undefined {
    try {
      const pool = this.ctx.get('accountPool' as never) as AccountPool | undefined
      if (pool !== undefined && pool !== null) return pool
    } catch {
      // 服务未注册 —— 正常（headless / 单测）。
    }
    return this.injectedPool
  }

  /**
   * 探活：凭据是否可用。
   *
   * 判据是**端到端**的 —— 能不能真的查到额度。这样「证书解出来了但
   * 已失效」也会被如实反映（比只看文件存在可靠）。
   */
  async probe(): Promise<ZcodeProbeResult> {
    const credential = await this.current()
    if (credential === undefined) {
      return {
        available: false,
        reason:
          '未找到可用的 ZCode 登录态。请在 Channel Pack 里点「添加账号」完成登录'
          + '（本插件只用它自己的授权流程，不会读取本机 ZCode 客户端的登录态）。',
      }
    }
    try {
      const balance = await fetchZcodeBalance(credential, this.fetchImpl)
      if (balance === undefined) {
        return {
          available: false,
          accountLabel: credential.account_label,
          reason: '额度接口不可用（凭据失效或网络异常）',
        }
      }
      return {
        available: true,
        accountLabel: credential.account_label,
        remaining: balance.remaining,
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.lastError = reason
      return { available: false, accountLabel: credential.account_label, reason }
    }
  }

  /**
   * ★ **插件内登录** —— 走官方 CLI 设备授权流，**不需要 ZCode IDE**。
   *
   * ## 为什么这是「登录」而不是「读凭据」
   *
   * 早期实现**只有**「确认磁盘上有一份官方客户端写的凭据」这一条路，
   * 那要求用户先装并登录官方 ZCode 客户端 —— 与本插件「装完即用」的
   * 定位冲突。而现在**只剩**本方法这一条路（磁盘读取已于 2026-10-05 删除）。
   *
   * 实测确认官方 3.12.3+ 用的是**服务端中介的设备授权流**
   * （`/oauth/cli/init` → 浏览器授权 → `/oauth/cli/poll/{flow_id}`），
   * 完全不经 `zcode://` 回调，**普通 Node 进程就能走完**（见 `zcode-login.ts`）。
   *
   * ## 返回形状与其余 provider 一致
   *
   * `{ loginUrl, result }` —— `loginUrl` 是**真的**授权 URL（前端据此弹窗），
   * `result` 是等待用户授权完成的 Promise。
   *
   * ⚠ 与本文件其它方法不同，这个方法**不是幂等的**：每次调用都会向
   * 服务端申请一条新的授权流程。前端只在用户点「添加账号」时调一次。
   */
  async startLogin(options: { refName?: string; appVersion?: string; provider?: ZcodeLoginProvider } = {}): Promise<{
    loginUrl: string | undefined
    result: Promise<{ refName: string; credential: ZcodeCredential }>
  }> {
    /**
     * ⚠ 授权 URL 必须**立刻**拿到并返回：前端的 `window.open` 只在
     * 用户手势窗口内有效（等用户授权完再返回必被弹窗拦截 ——
     * `AGENTS.md` 记过 CodeArts 早期这个缺陷）。
     *
     * 故这里手工编排「发起 → 回调 URL → 后台轮询」，而不是直接
     * `await runZcodeLogin()`（那会阻塞到授权完成）。
     */
    const ref = (options.refName ?? this.product.defaultCredentialRef) as CredentialRef
    let resolveUrl: (url: string) => void = () => {}
    let rejectUrl: (error: Error) => void = () => {}
    const urlPromise = new Promise<string>((resolve, reject) => {
      resolveUrl = resolve
      rejectUrl = reject
    })

    const result = (async (): Promise<{ refName: string; credential: ZcodeCredential }> => {
      const loginResult = await runZcodeLogin({
        fetchImpl: this.fetchImpl,
        appVersion: options.appVersion ?? this.product.appVersionFallback,
        provider: options.provider,
        onAuthorizeUrl: (url) => resolveUrl(url),
      })
      /** 登录成功后组装凭据，并生成**自用**的 device_mid（见下）。 */
      const credential: ZcodeCredential = {
        zcode_jwt: loginResult.zcodeJwt,
        /**
         * ⚠ **自己生成 device_mid**，而不是读官方客户端的
         * `telemetry-state.json` —— 这正是「脱离 IDE」的关键。
         *
         * 实测依据：同一 JWT 换任意随机 UUID，`billing/balance` 都回 200；
         * 缺它才回 400 code 3001。故它的**值**不被绑定校验，
         * 只需**稳定**（生成后持久化在凭据里，登录一次就固定）。
         */
        device_mid: generateDeviceMid(),
        /**
         * ★ **必须搬 `userId`**（真实缺陷，2026-10-02）。
         *
         * 它是**唯一**稳定的账号标识（服务端下发），也是「同一个账号
         * 被添加两次」的**唯一**可靠判据。此前这一跳把它丢了，
         * 于是无法去重 —— 同一账号点两次「添加账号」就得到两条。
         *
         * ⚠ 不要改用 `device_mid` 做判据：那是我们**随机生成**的，
         * 同一账号重新登录会变（见 `zcode.ts` 的字段注释）。
         */
        ...loginResult.userId.length > 0 ? { user_id: loginResult.userId } : {},
        /**
         * 第三方 access token：按登录 provider 落在对应字段。
         *
         * ⚠ 两者**都可能是 `undefined`**（只会有其一），故用条件展开而不是
         * 直接赋值 —— 否则会给凭据写进 `bigmodel_access_token: undefined`
         * 这样的键。该字段只作**备用身份**，不参与推理（推理用 `zcode_jwt`）。
         */
        ...loginResult.bigmodelAccessToken !== undefined
          ? { bigmodel_access_token: loginResult.bigmodelAccessToken }
          : {},
        ...loginResult.zaiAccessToken !== undefined
          ? { zai_access_token: loginResult.zaiAccessToken }
          : {},
        account_label: loginResult.displayName,
        /**
         * 账号名与脱敏手机号（供账号卡片展示，见 `src/zcode.ts` 的字段注释）。
         *
         * ⚠ 手机号是**从 `userId` 前 11 位派生**的（上游不下发手机号字段）；
         * 取不到合法前缀时 `phoneFromUserId` 返回 `undefined`，故这里要判断后再塞，
         * 否则会给凭据写进一个 `phone: undefined` 的键（JSON 序列化后消失，
         * 但内存对象里会带着，徒增困惑）。
         */
        ...loginResult.displayName.length > 0
          ? { account_name: loginResult.displayName }
          : {},
        ...(phoneFromUserId(loginResult.userId) !== undefined
          ? { phone: phoneFromUserId(loginResult.userId) }
          : {}),
        app_version: options.appVersion ?? this.product.appVersionFallback,
        source: 'plugin',
      }
      /**
       * ★ 登录成功后**顺手换** coding-plan 的 api-key（付费订阅腿）。
       *
       * ⚠ 这是 `fetchCodingPlanApiKey` 的**唯一调用点** —— 它此前建好却没人调，
       * 导致该腿对纯插件登录用户永久不可用（见 `resolveCodingPlanKey` 的说明）。
       *
       * ## 字段按「拿到哪个 OAuth token」落位
       *
       * `zai` 渠道登录 ⇒ `zai_access_token` ⇒ 写 `coding_plan_key_zai`；
       * `bigmodel` 渠道 ⇒ `bigmodel_access_token` ⇒ 写 `coding_plan_key_bigmodel`。
       * 与 `zcode-transport.ts` 里 `zai ?? bigmodel` 的取值优先级一致。
       *
       * ⚠ **换不到不报错**：没买订阅是常态，那时 `start-plan`（免费积分）
       * 照常可用。`resolveCodingPlanKey` 已把失败都吞成 `undefined`。
       */
      const codingPlanKey = await this.resolveCodingPlanKey(credential)
      const withPlanKey: ZcodeCredential = codingPlanKey === undefined
        ? credential
        : {
          ...credential,
          ...(credential.zai_access_token !== undefined
            ? { coding_plan_key_zai: codingPlanKey }
            : { coding_plan_key_bigmodel: codingPlanKey }),
        }
      await this.ctx.credentials.set(ref, JSON.stringify(withPlanKey))
      return { refName: ref, credential: withPlanKey }
    })()

    /**
     * 若发起阶段就失败（网络/服务端拒绝），`onAuthorizeUrl` 永不触发，
     * 故这里把 URL promise 与结果 promise 对齐 —— 避免前端永久等待。
     */
    result.catch((error: unknown) => {
      rejectUrl(error instanceof Error ? error : new Error(String(error)))
    })

    let loginUrl: string | undefined
    try {
      loginUrl = await urlPromise
    } catch (error) {
      // 发起就失败：把错误抛给调用方（前端会显示原因）。
      throw error instanceof Error ? error : new Error(String(error))
    }
    return { loginUrl, result }
  }

  /**
   * 换取 coding-plan（**付费订阅**）通道的 api-key。
   *
   * ## 为什么需要这一步（真实断链，2026-10-05 修）
   *
   * `coding_plan_key_*` **不是登录时下发的** —— 官方用登录拿到的 OAuth
   * access_token **现换**（逆向 `AccountProviderApiKeyResolver`，
   * 见 `zcode-transport.ts` 的 `fetchCodingPlanApiKey`）。
   *
   * ⚠ 此前这条链是**断的**：`fetchCodingPlanApiKey` 建好了却**没有任何调用方**，
   * 而两个 key 字段的**唯一**写入点是「从本机 ZCode 客户端读凭据」——
   * 那条路已于同日删除 ⇒ **纯插件登录用户的 coding-plan 通道一直不可用**
   * （表现为 `glm-5.3` / `glm-5.3-flash` 在通道表里 unavailable）。
   *
   * ⇒ 本方法把缺的那一环接上。原料是齐的：登录结果里**必然**带
   * `zai_access_token` 或 `bigmodel_access_token`（`startLogin` 刚写进去）。
   *
   * ## 失败绝不牵连登录
   *
   * 换不到 key 只意味着「用户没买 coding-plan，或云上没有那个 key」
   * （`reason` 会区分）—— `start-plan`（免费积分）**照常可用**。
   * 故这里**只记日志、返回 `undefined`**，绝不抛。
   *
   * @returns api-key；换不到（没 token / 没订阅 / 超时 / 网络错）时 `undefined`。
   */
  private async resolveCodingPlanKey(credential: ZcodeCredential): Promise<string | undefined> {
    // 没有 OAuth token 就不必发请求（`fetchCodingPlanApiKey` 自己也会回
    // `no-oauth-token`，但这里提前短路，省掉三个无意义的函数调用与日志噪声）。
    if (credential.zai_access_token === undefined && credential.bigmodel_access_token === undefined) {
      return undefined
    }
    try {
      const result = await withTimeout(
        fetchCodingPlanApiKey(credential, this.fetchImpl),
        CODING_PLAN_KEY_TIMEOUT_MS,
      )
      if (result.key === undefined) {
        this.ctx.logger?.warn?.(
          `[channel-pack] zcode coding-plan key 未换到（${result.reason ?? 'unknown'}）；`
          + 'start-plan 通道不受影响',
        )
        return undefined
      }
      return result.key
    } catch (error) {
      this.ctx.logger?.warn?.(
        `[channel-pack] zcode coding-plan key 换取异常：${String(error)}；start-plan 通道不受影响`,
      )
      return undefined
    }
  }

  /**
   * 阻塞式登录（等待用户在浏览器完成授权）。
   *
   * ⚠ 与 `startLogin` 的区别：这个会**等到授权完成**才返回。
   * 供「没有前端、只想在脚本里登录」的场景用；Channel Pack 走 `startLogin`
   * （两步式，避免弹窗被拦截）。
   */
  async login(options: { refName?: string; appVersion?: string } = {}): Promise<{
    refName: string
    credential: ZcodeCredential
  }> {
    const started = await this.startLogin(options)
    return await started.result
  }

  /**
   * 把**当前可用凭据**（插件自存）写进 `ctx.credentials`。
   *
   * ⚠ 若已有插件自存凭据，本方法会**覆盖**它 —— 调用方需自行确认
   * （Channel Pack 的「添加账号」在已有账号时不会走到这里）。
   */
  async persistCurrent(refName?: string): Promise<{
    refName: string
    credential: ZcodeCredential
  }> {
    const credential = await this.current()
    if (credential === undefined) {
      throw new Error(
        'ZCode 凭据不可用：请在 Channel Pack 里点「添加账号」完成登录。',
      )
    }
    const ref = (refName ?? this.product.defaultCredentialRef) as CredentialRef
    /**
     * ⚠ `ctx.credentials.set` 的第二个参数是**字符串**（不是对象）——
     * 与 `RaccoonAuth` 同款约定：把凭据本体序列化成 JSON 存进去，
     * 读的时候再 `JSON.parse`。
     */
    await this.ctx.credentials.set(ref, JSON.stringify(credential))
    return { refName: ref, credential }
  }

  /**
   * 拉取服务端下发的 captcha 配置（**带 60 秒 TTL 缓存**）。
   *
   * ## 为什么要缓存（对齐官方）
   *
   * 官方 `f3()` 对 captcha 配置做了 60 秒 TTL 缓存 + 在飞去重
   *（`out/renderer/assets/styles-*.js` 的 `expiresAt: t + 6e4`）。
   * 此前我们在 `index.ts` 用 `??=` 做**永久缓存** —— 两个问题：
   *
   * 1. **服务端换 `sceneId`／灰度切换后永不生效**（必须重启宿主）；
   * 2. **首次拉取失败会被永久固化**（`??=` 把失败结果也记住）。
   *
   * 现在改成 {@link TtlCache}：60 秒后自动重取，**失败不缓存**。
   *
   * 失败返回 `undefined`，由调用方回退到 `ZCODE_CAPTCHA_FALLBACK`。
   */
  async fetchCaptchaConfig(): Promise<{ region: string; prefix: string; sceneId: string } | undefined> {
    /**
     * ⚠ 缓存的是**配置**而不是「带凭据的请求」：凭据可能变（切号/重新登录），
     * 故缓存的 `load` 每次都重新解析**当时**的凭据。
     */
    return await this.captchaConfigCacheInstance().get()
  }

  /** captcha 配置缓存（60 秒 TTL，对齐官方 `f3()`）。惰性创建。 */
  private captchaConfigCache:
    | TtlCache<{ region: string; prefix: string; sceneId: string } | undefined>
    | undefined

  private captchaConfigCacheInstance(): TtlCache<
    { region: string; prefix: string; sceneId: string } | undefined
  > {
    this.captchaConfigCache ??= new TtlCache({
      ttlMs: 60_000, // 原从 captcha-backoff.js 导入（CAPTCHA_CONFIG_TTL_MS=60_000）；该文件已随外挂链退役
      load: async () => {
        const credential = await this.current()
        if (credential === undefined) return undefined
        return await fetchZcodeCaptchaConfig(credential, this.fetchImpl)
      },
    })
    return this.captchaConfigCache
  }

  /** 查额度（Channel Pack 的「余额」用）。 */
  async fetchBalance(): Promise<ZcodeBalanceResult | undefined> {
    const credential = await this.current()
    if (credential === undefined) return undefined
    return await fetchZcodeBalance(credential, this.fetchImpl)
  }

  /**
   * 用**给定凭据**查额度（Channel Pack 逐账号查询时用）。
   *
   * 与 {@link fetchBalance} 的区别：那个用「当前磁盘凭据」，
   * 这个用调用方给的那份（每个账号条目各自的凭据）——
   * 多账号场景下两者可能不是同一份。
   */
  async fetchBalanceFor(credential: ZcodeCredential): Promise<ZcodeBalanceResult | undefined> {
    return await fetchZcodeBalance(credential, this.fetchImpl)
  }

  /**
   * 产出 captcha param —— `ctx.zcodeAuth` 的公开入口（`account-probe` 与 claim 的注入回调用）。
   *
   * 2026-11-14：外挂 chromium 链退役，公开入口改为**经载体链等内部贡献**
   * （面板 srcdoc 载体页 → postMessage → contribute → 供给槽）。
   * 等不到贡献时抛 {@link CarrierUnavailableError} —— 「不支持当前客户端」。
   */
  async mintCaptcha(
    config?: { region: string; prefix: string; sceneId: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<string> {
    const outcome = await this.mintCaptchaParam(config, options)
    return outcome.param
  }

  async carrierHtml(): Promise<string | null> {
    if (!this.internalCarrierEnabled) return null
    const config = await this.fetchCaptchaConfig() ?? ZCODE_CAPTCHA_FALLBACK
    return buildCarrierPageHtml(config)
  }

  /**
   * claim（领取）路径的 param 产出：**内部载体优先**，等不到即落那条注入的 chromium 链。
   *
   * ## 为什么领取是需求位的**唯一**触发点（2026-09-29 实测）
   * | 端点 | 3.14.4 之后是否索要 captcha |
   * |---|---|
   * | 模型请求（推理） | **否** —— 6 个采样点不带验证头也是 HTTP 200（官方更新说明同口径） |
   * | `/zcode-plan/billing/claim` | **始终是** —— 带非法 captcha 与不带 captcha 都回 `400/3007`，且**校验前置于 plan 校验** |
   *
   * ⇒ 置位点在推理侧就是**死触发点**（推理永远不撞 `3007` ⇒ 需求位恒假 ⇒
   *   client 永远不产 param ⇒ 内部载体接了个空壳）。置位点必须跟着 claim 走。
   *
   * ## 三条出口（与 {@link CaptchaCarrier.mint} 同序）
   * 1. 载体链不参与（`DSH_ZCODE_INTERNAL_CARRIER=0` / 本机从未收到过贡献 ⇒ web 版）
   *    → 逐字走注入的那条链，**零额外开销**（既有行为逐字不变）；
   * 2. **需求位为假** → 不取槽也不等：`captchaDemand` 就是「此刻有人在索要验证」的
   *    信号，窗口外取槽等于把为下一次窗口备的货提前烧掉（且必然白等 `waitMs`）；
   * 3. 需求位为真 → 载体链（先取槽、再有界等一次贡献），取不到才落注入的链。
   *
   * ⚠ 一次性由 `takeFreshParam` 保证（取走即清），故「每 plan 一个」不会被复用成 `3007`。
   * ⚠ 载体链**禁用**（内部 param 被上游拒到阈值）时同样落注入的链 —— 归因纪律见
   *   `src/captcha-carrier.ts` 文件头。
   *
   * ## ⚠ `config` 必须**原样透传**给注入链（真实缺陷，Gitee issue IKJNPS）
   *
   * 注入链（`zcode.mintCaptcha`）拿到的 config 决定 param 由**哪个 region** 签发，
   * 而请求头里的 region 取自**同一份**（`claimDailyWith` 解析的那次）。
   * 这里若「顺手再拉一次配置」或干脆不传，两跳之间（60 秒 TTL 里服务端换 region
   * 也可能）就会漂成两份真相，稳定复现成 `3007` —— 而 param 与 region 不同源
   * 时**重试多少次都没用**，它不是概率问题。
   *
   * ## ★ 返回值带 `source`（评审 C4）
   * 领取端点 `/zcode-plan/billing/claim` **始终索要** captcha（实测：带非法与不带都
   * `400/3007`，且校验**前置于** plan 校验）⇒ 内部 param 在这条路径上被拒的概率
   * 比推理路径高得多，必须能归因。`claimDailyWith` 靠这个 `source` 决定
   * 「记一次 internalRejected + 当次换注入链重发一次」（见那里）。
   */
  private async mintClaimCaptcha(
    _injected: ZcodeClaimCaptchaMint | undefined,
    config: ZcodeCaptchaConfig,
  ): Promise<CarrierOutcome> {
    // 2026-11-14：外挂 chromium 注入链退役 —— 领取与推理同走载体链
    // （面板 srcdoc 载体页贡献）。等不到贡献时抛 CarrierUnavailableError，
    // claim 的 catch 把它转成「不支持当前客户端」。
    if (config !== undefined) this.captchaMintConfig = config
    return await this.carrier.mint()
  }

  /**
   * 内部载体**此刻是否可用**（= 本次要不要走载体链）。两个条件缺一不可：
   *
   * 1. env 没关（`DSH_ZCODE_INTERNAL_CARRIER=0` ⇒ 既不等待也不取槽）；
   * 2. 这个进程**真的收到过**至少一次贡献（`captchaSupplyStats().supplied > 0`）。
   *
   * ## 为什么第 2 条不能省（web 版逐字不变就靠它）
   * web 版里**没有任何人**会去轮询需求位（拿不到 `dshDesktop.browser`，贡献循环整个
   * 不启动），载体链若据此去 `waitForFreshParam`，就会**每次取 param 都白等 1.5 秒**
   * 再走 chromium —— 而 web 版永远不会有贡献，这一等纯亏。拿「收到过贡献」当证据即可两全：
   * 桌面版的贡献与消费在**同一进程**（RPC 直接落槽），一次投放之后才可能有第二次命中。
   *
   * ⚠ 这是一台**闩锁**（once true, stays true）：桌面版 client 后来死了不会自动关掉，
   *   那种情况下每发最多多等 1.5 秒再退回 chromium，且 `carrier().supply.waitTimeouts`
   *   会一路往上涨 —— 那个数就是「该关掉内部载体了」的现场证据（`DSH_ZCODE_INTERNAL_CARRIER=0`）。
   */
  internalCarrierAvailable(): boolean {
    return this.internalCarrierEnabled && captchaSupplyStats().supplied > 0
  }

  /**
   * 推理热路径的 param 产出：**内部载体优先**，等不到再落那条 chromium 链。
   *
   * 返回 {@link CarrierOutcome}（带 `source`）—— 上游回 `3007` 时的**归因**要看它：
   * 只有内部来源的 param 被拒才记一次 `internalRejected`（见 {@link CaptchaCarrier}）。
   *
   * ⚠ 需求位**不在这里**置：置位点是 **claim（领取）入口**
   *   （{@link claimDailyWith} 的 `try/finally`）—— 3.14.4 起上游只对领取索要验证，
   *   推理路径已不再驱动内部载体（依据见 {@link mintClaimCaptcha} 的那张表）。
   *   这里只消费需求位。
   */
  async mintCaptchaParam(
    config?: { region: string; prefix: string; sceneId: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<CarrierOutcome> {
    if (config !== undefined) this.captchaMintConfig = config
    return await this.carrier.mint(options)
  }

  /**
   * 带着 param 的那一发被上游 `3007` 拒 ⇒ 交回载体链做**归因 + 当次回退**。
   *
   * ## 三条纪律（都写进了 `tests/unit/zcode-carrier-auth.spec.ts`）
   * 1. **只按 `outcome.source` 归因**：来源是 `chromium` 的 param 被拒，是「时效/信誉」
   *    问题（`CaptchaBackoff` 管的那本账），**不许**记到载体头上；
   * 2. 载体链本身不可用（env 关 / web 版）⇒ **一个数都不记**，直接换一个新的 chromium
   *    param —— 否则面板会出现「一次都没用过的内部载体被拒 3 次」；
   * 3. chromium 腿撞上**退避冷却**而抛错 ⇒ 保持既有抛出语义（原样上抛，不吞、
   *    不退化成「不带 param 再撞一次」）。
   */
  async mintCaptchaAfterRejection(
    outcome: CarrierOutcome,
    config?: { region: string; prefix: string; sceneId: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<CarrierOutcome> {
    if (config !== undefined) this.captchaMintConfig = config
    return await this.carrier.mintWithFallbackAfterRejection(outcome, options)
  }


  /**
   * captcha 产出的**观测快照**（供 Channel Pack / 诊断读取）。
   *
   * 对齐官方维护 `traceless_passed_count` / `captcha_displayed_count` 的思路：
   * 用户与我们都该能看到「无感通过 vs 被要求交互」的比例趋势。
   */
  captchaObservability(): {
    tracelessPassed: number
    interactiveDisplayed: number
    failed: number
    probeFirstCount: number
    knownRequiredCount: number
    failureStreak: number
    queuePending: number
    cooldownRemainingMs: number
    carrier: ReturnType<CaptchaCarrier['stats']>
  } {
    return {
      ...this.captchaStats,
      /**
       * 「先探后取」的两个计数**读自进程级模块状态**（`captcha-requirement.ts`），
       * 本类上不存副本 —— 复制一份必然漂移。
       *
       * ⚠ 顺序有讲究：必须排在 `...this.captchaStats` **之后**。前面那两项只是
       * 形状占位（恒为 0），反过来写就会被 0 盖掉，读数永远是 0。
       */
      ...captchaRequirementObservability(),
      failureStreak: 0,
      queuePending: 0,
      cooldownRemainingMs: 0,
      /**
       * 内部载体的取舍计数（`internalUsed` / `chromiumUsed` / `internalRejected` /
       * `disabledAfter`），并带一份供给槽快照 `supply`
       * （`supplied` / `used` / `stale` / `waitTimeouts`）—— 链与槽读的是同一份真相。
       *
       * ⚠ env 关掉或 web 版下它长期是**全 0**：载体链根本没参与过（判据见
       * {@link internalCarrierAvailable}），这**不是**「载体坏了」；
       * 反倒是 `supply.waitTimeouts` 一路往上涨才是
       * 「这台机器的 client 不再贡献了，该用 `DSH_ZCODE_INTERNAL_CARRIER=0` 关掉」。
       */
      carrier: this.carrier.stats(),
    }
  }

  /**
   * 用**给定凭据**领取每日额度（Channel Pack 逐账号领取时用）。
   *
   * 与 {@link claimDaily} 的区别同 {@link fetchBalanceFor}。
   *
   * ⚠ `captchaRegion` **不要传**：省略即跟随「本次 mint 用的那份配置」
   * （真实缺陷，Gitee issue IKJNPS —— 传兜底常量 `cn` 会让非 cn 区账号恒 `3007`）。
   * 保留它只是为了在特殊场景显式覆盖，正常入口一律省略。
   */
  async claimDailyFor(
    credential: ZcodeCredential,
    mintCaptcha: ZcodeClaimCaptchaMint | undefined,
    captchaRegion?: string,
  ): Promise<ClaimOutcome[]> {
    return await this.claimDailyWith(credential, mintCaptcha, captchaRegion)
  }

  /**
   * 拉模型目录。
   *
   * ⚠ ZCode 的模型表是**静态白名单**（实测可用的两个），不发网络请求
   * 去枚举 —— 上游 `/v1/models` 是桥的端点（我们不再依赖桥），
   * 而 `client/configs` 的模型池含**实测不可用**的两条
   * （`GLM-5-Turbo` / `GLM-5.2` 返回空响应）。
   * 故直接返回兜底表，语义是「实测可用的清单」。
   */
  async fetchModels(): Promise<ZcodeRemoteModelLike[]> {
    /**
     * ★ **优先上游**（真实缺陷）。
     *
     * 早先这里**直接照抄兜底表**，于是：
     *   - 窗口 / 输出上限用的是兜底表的估值（`200_000` / `32_768`），
     *     而上游说的是 `1_000_000` / `128_000`；
     *   - **思考档位完全不出现**（兜底表当时没有档位字段）。
     *
     * 用户报障正是「上下文窗口 1000000、最大输出 128000，但选不了思考档位」
     * —— 那两个数字来自上游/用户手填，而**档位是代码里根本没有**。
     *
     * ⇒ 档位、视觉能力、窗口、输出上限**全部以上游为准**。
     */
    const remote = await this.fetchRemoteModelsOnly()
    if (remote.length > 0) return remote
    // 上游不可用（未登录 / 网络异常）→ 回退兜底表（其值已与上游对齐）。
    return this.product.fallbackModels.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      supportsImage: model.supportsImage,
      ...model.reasoningLevels !== undefined ? { reasoningLevels: model.reasoningLevels } : {},
      ...model.defaultReasoningLevel !== undefined
        ? { defaultReasoningLevel: model.defaultReasoningLevel }
        : {},
    }))
  }

  /**
   * 只取**真远端**目录；未登录 / 上游失败 / 上游解析出 0 条 ⇒ `[]`。
   *
   * ⚠ 与 {@link fetchModels} 的区别是**不回退兜底表**，专供适配器与本地桥使用。
   *
   * 为什么必须有这条：适配器判「这次拿到目录了吗」的判据是「返回空数组」。
   * 若接线用 `fetchModels()`（失败时回吐兜底表），那个判据**永不命中**
   * ⇒ 兜底表被当成远端结果写进 `remoteModels` 并永久缓存，用户登录 /
   * 网络恢复后**再也不会重拉**（连失败冷却都不会开），只能重启 DSH。
   * 「回退兜底表」这件事只应由**展示侧**（适配器）做一次。
   */
  async fetchRemoteModelsOnly(): Promise<ZcodeRemoteModelLike[]> {
    const credential = await this.current()
    if (credential === undefined) return []
    const remote = await fetchZcodeModels(credential, this.fetchImpl)
    return remote !== undefined && remote.length > 0 ? [...remote] : []
  }

  // ===== 签到（与 CodeArts / Buddy 等共用 CheckinStatus / ClaimOutcome 形状）=====

  /**
   * 查签到状态。
   *
   * ## ⚠ 判据是「有没有可领的 plan」，**不是**「列表是否为空」
   *
   * 与 Qoder 那次教训同型（`AGENTS.md` 记过）：服务端在活动不同阶段
   * 都可能回空列表。而 ZCode 的服务端**不会主动推送**活动 ——
   * 必须先补 `event/report`（`app_launch` + `app_daily_active`），
   * `preview` 才会下发 plan。
   *
   * 故本方法**先补激活信号再查**，否则会稳定误报「今日已领」。
   */
  async fetchCheckinStatus(): Promise<CheckinStatus> {
    const credential = await this.current()
    if (credential === undefined) {
      return emptyCheckinStatus(false, true)
    }
    // 补活跃信号 —— 不补则 preview 恒为空。
    await reportZcodeActivation(credential, this.fetchImpl)
    const plans = await fetchZcodeClaimablePlans(credential, this.fetchImpl)
    /**
     * ⚠ `active` 恒为 `true`（拿到凭据即 true）—— 与 Qoder 的同款约定：
     * 若按「列表非空」判 `active:false`，`collectClaimResults` 会先命中
     * 「活动未开启」分支，把「今天已领」误报成「签到活动未开启」。
     *
     * ⚠ ZCode 是**额度制**（不是积分制）：`ClaimOutcome` / `CheckinStatus`
     * 那些 `credit` 字段的单位是「积分」，而 ZCode 的额度单位是 **token**。
     * 两者不是同一量纲，故这里**一律填 0**，不把 token 数伪装成积分
     * （否则 Channel Pack 的汇总会把 1 亿 token 显示成 1 亿积分）。
     *
     * `todayCheckedIn` 只能由「有没有可领的 plan」推断（ZCode 没有独立的
     * 「今日是否已领」端点）：有可领 = 还没领；没有 = **已领或未投放**（两者
     * 在此层不可分，见 `claimDailyWith` 里对 `marketing/touch` 的取证）。
     *
     * ⚠️ 这个推断在 `inactive` 的方向上是**偏向乐观**的（空投放也报「已签」），
     * 但它**不影响任何判定**：`todayCredit` 恒为 0、`dailyCredit` 恒为 0，
     * 故前端的「今日已领多少」在台账没有 `claimed` 行时仍然返回 `null`
     * （见 `client.js` 的 `todayClaimedAmount`）。真正决定「今天办没办完」的是
     * `computeClaimSummary` 的 `coversToday`，那条路径已按 `inactive` 修正
     * （见 `claimDailyWith`）。
     *
     * ⚠️ 若将来要给 `todayCheckedIn` 填真值，**不能**再靠「列表为空」——
     * 正确的判据是 `billing/balance` 的 `plans[]` 里有没有当日 plan
     * （2026-11-09 实测：领取后立刻出现 `…-start-plan-1109`、`starts_at` 就是
     * 领取那一刻）。那要多打一次 GET（实测 103–235ms），当前没有这个必要。
     */
    return {
      active: true,
      todayCheckedIn: plans.length === 0,
      streakDays: 0,
      dailyCredit: 0,
      todayCredit: 0,
      isStreakDay: false,
      totalCredits: 0,
      checkinDates: [],
      activityName: 'ZCode Start Plan 每日额度',
      themeName: 'ZCode',
      endTime: '',
    }
  }

  /**
   * 领取每日额度。
   *
   * ## 流程（每一步都不能省）
   *
   * 1. 补活跃上报 → 2. 查 preview → 3. 逐个 claim
   *
   * ## ⚠ captcha 是**一次性**的
   *
   * 每个 plan 都必须**重新 mint** 一个新 param（在索要验证的窗口里，复用会得 `3007`）。
   * 本路径**不走先探后取**：每个 plan 都现产一个，故「一次性」在这里是必须遵守的前提，
   * 没有「这次上游没校验所以可以复用」的余地（那只在**推理**路径上由探测结果决定，
   * 见 `captcha-requirement.ts`）。
   * 故 captcha 的产出来自调用方注入的 `mintCaptcha` 回调 ——
   * 让本服务不必知道浏览器怎么起（也便于单测注入桩）。
   *
   * ## ★ 内部载体的需求位跟着**领取**走
   * 领取端点始终索要 captcha（推理侧自 3.14.4 起已不索要）⇒ 需求位在本方法内
   * 置起、在 `finally` 里清掉，per-plan 的 param 产出**内部载体优先**。
   * 依据与落点理由见 {@link claimDailyWith}，产出顺序见 {@link mintClaimCaptcha}。
   *
   * ## ⚠ `1003`（已领取）是**成功**
   *
   * 服务端对「已领取过」回 `code:1003`。把它当失败会让定时任务
   * 反复误报 —— 这与 Buddy / Qoder 的幂等语义一致。
   *
   * ⚠ `captchaRegion` 与 {@link claimDailyFor} 同款：**省略即跟随配置**，别传兜底常量
   * （真实缺陷，Gitee issue IKJNPS）。
   */
  async claimDaily(
    mintCaptcha: ZcodeClaimCaptchaMint | undefined,
    captchaRegion?: string,
  ): Promise<ClaimOutcome[]> {
    const credential = await this.current()
    if (credential === undefined) {
      return [{ kind: 'failed', code: -1, message: '未找到可用的 ZCode 登录态' }]
    }
    return await this.claimDailyWith(credential, mintCaptcha, captchaRegion)
  }

  /**
   * 领取的共用实现（`claimDaily` 与 `claimDailyFor` 都走它）。
   *
   * ## ★ 内部载体的**需求位**归这里（2026-09-29）
   *
   * 领取端点 `/zcode-plan/billing/claim` **始终强制索要** captcha
   * （实测：带非法 captcha 与不带 captcha 都回 `400/3007`，且**校验前置于 plan 校验**），
   * 而**模型请求**自 ZCode 3.14.4（2026-09-29）起**不再校验**（6 个采样点不带验证头也
   * HTTP 200，官方更新说明同口径）⇒ 需求位只能跟领取走。
   *
   * ### 为什么落在这里，而不是 `src/channel-pack-rpc.ts` 的编排层
   * 两条领取入口（RPC 的「一键领取」`claimDailyFor` 与定时自动领取 `claimDaily`）
   * **都收敛到这个方法**；放在编排层就得要求每个调用方自己记得置位 ——
   * 漏一处 = 那条路静默退化成 chromium，而**外部看不出来**（领取照样成功，只是
   * 内部载体白接）。放在这里则「进入领取窗口」与「置位」是同一个动作，无法漏。
   *
   * ### 为什么用 `try/finally`，而不是 TTL 看门狗
   * 领取窗口是**有界**的（几秒 ~ 几十秒：激活上报 + 查 plan + 逐 plan 领取），
   * `finally` 覆盖成功、抛错、提前 return（没浏览器 / 无可领 plan）**全部**出口；
   * 而推理侧当初那道「空闲一个 TTL 自动落下」的看门狗正是为「窗口无界」设计的，
   * 搬过来反而更弱：claim 卡住时它会先于领取结束落下。
   *
   * ⚠ 需求位是**进程级**的位，`finally` 漏写就是「client 无限定地产 param」的最坏形态
   *   （阿里云同设备每小时 150 次，见 `src/captcha-backoff.ts`）
   *   —— 故由 `tests/unit/zcode-carrier-auth.spec.ts` 的源码用例 + 行为用例双向锁死。
   *
   * ## ★★ region 与 param **必须来自同一份配置**（真实缺陷，Gitee issue IKJNPS）
   *
   * 阿里云验签把 param 与 `x-aliyun-captcha-verify-region` **成对**校验，
   * 不一致即 `400 / 3007`。而 region 由**服务端**下发（`client/configs`，
   * 本仓库作者所在账号是 `cn`，z.ai 国际渠道实测是 **`sgp`**），
   * 把它写成本地兜底常量只会在 cn 区账号上「碰巧正确」。
   *
   * 修复前的形态是**两份真相**：`channel-pack-rpc.ts` 的注入回调自己
   * `fetchCaptchaConfig()` 拿配置产 param，而 region 走本方法的**默认参数**
   * `ZCODE_CAPTCHA_FALLBACK.region` ⇒ 非 cn 区账号 100% 领不到
   * （用户报障：15/15 全部 3007；同账号改用配置里的 region 后立即成功 +100M）。
   *
   * ⇒ 这里解析**一次**配置，region 从它取、并把它传给注入回调：
   * 「产 param 的那份」与「写 region 的那份」从此是**同一个对象**。
   */
  private async claimDailyWith(
    credential: ZcodeCredential,
    mintCaptcha: ZcodeClaimCaptchaMint | undefined,
    captchaRegion: string | undefined,
  ): Promise<ClaimOutcome[]> {
    try {
      /**
       * ★ 置位点：进入领取窗口就告诉 GUI 的贡献循环「现在要验证，去产 param 放进槽里」。
       * 放在**任何网络往返之前**（下面还有激活上报与 plan 查询两跳），是为了给
       * client 产出一个提前量 —— 它要「建 guest → 导航载体页 → 加载 SDK → 无感验证」
       * 约 2–4 秒，而槽的有界等待只有 1.5 秒。
       *
       * ⚠ 自 2026-10-28 起「第一发不带验证头」是常态（见 {@link claimOnePlan}），
       *   所以这个位**多数情况下产出的 param 用不上**。仍然留在窗口入口，是为了
       *   保住 `3007` 兜底时的提前量 —— 那时代价是「白产一个 param」，
       *   而挪到晚一点（真撞 3007 才置位）就得每次先白等 1.5 秒的槽超时。
       */
      setCaptchaDemand(true)
      /**
       * ⚠ **不再因为「没有注入链」就早退**（2026-10-28 实测修正）。
       *
       * 旧行为：`mintCaptcha === undefined` ⇒ 直接回「captcha 产出不可用（找不到浏览器？）」。
       * 依据是「claim 端点始终强制索要 captcha」。但真凭据复测（`app_version 3.16.3`）
       * 显示：**不带任何验证头**的 claim 直接 `code:0` 领取成功 —— 常态并不需要验证。
       *
       * 于是在没有浏览器的形态（web / 独立服务）里，那把早退闸门会把「本来能领」的
       * 用户挡在门外。现在改成：先不带验证头领（见 {@link claimOnePlan}），只有上游
       * 真的回 `3007` 时才需要 param，那时才依赖注入链 / 外挂 chromium。
       */

      await reportZcodeActivation(credential, this.fetchImpl)
      const plans = await fetchZcodeClaimablePlans(credential, this.fetchImpl)
      /**
       * ★★ 「没有可领 plan」**不能**记成 `already-claimed`（真实缺陷，2026-11-09）。
       *
       * ## 缺陷形态（用户报障：签到失败、而这次并没有拉起浏览器）
       *
       * 旧行为把空投放归为 `already-claimed`，理由是「两种情况下用户的动作都是
       * 明天再来」—— 但**记账层**看到的不是「明天再来」，而是「今天已经办完了」：
       *
       * ```text
       * already-claimed（→ coversToday += 1）
       *   → auto-checkin 记 status = done
       *   → nextAttemptAt 对非 pending 返回 null
       *   → 当天再也不会重试
       * ```
       *
       * 而 `ZCODE_MAX_ATTEMPTS_PER_DAY = 2` 本来就是为「19:40 刚到、上游还没铺
       * 开投放」准备的第二次机会，被这条错误归类整条吃掉。
       *
       * ## 2026-11-09 的取证（当天就复现了）
       *
       * | 时刻 | 事实 |
       * |---|---|
       * | 19:02 | 自动那轮三个账号全判 `already-claimed`（「今日暂无可领额度」） |
       * | 19:28 | 实测 `marketing/touch`：A/B 号投放 `deliveries: []`，C 号已有 plan |
       * | 19:32–19:33 | 用户手动点，三个账号**依次领到 300M token** |
       *
       * ⇒ 空投放是**上游还没发**，不是「已领」。而且这条路径在
       * `claimOnePlan` **之前**就 return，**永远产不出 captcha**（也就不可能
       * 拉起 chromium）—— 用户观察到的「这次没拉起浏览器」正是它。
       *
       * ## 改法：用 `inactive`（活动未开启）如实表达，并让记账层去重试
       *
       * `inactive` 不计 `coversToday`（见 `computeClaimSummary`），于是：
       *
       * ```text
       * coversToday = 0、failed = 0
       *   → settle('none') → status = pending
       *   → nextAttemptAt：'none' + 当日 10:00 已过 → lastAt + 30min
       *   → 20:10 补跑一次；attempts 到 2 时 giveUpOrRetry 置 given-up
       * ```
       *
       * 正好是用户要求的「空投放不产 captcha、30 分钟后重试一次」。
       *
       * ⚠️ **不用** `already-claimed + coversToday:false`：那样面板会显示
       *   「3 个今天已领，非今日轮次」—— 自相矛盾，比原缺陷更容易误导。
       * ⚠️ 文案不写「已领 / 已签到」字样：面板与账本会把它们归到「今天办完了」。
       */
      if (plans.length === 0) {
        return [{
          kind: 'inactive',
          message: '上游尚未投放今日额度（服务端按日投放，稍后自动重试）',
        }]
      }

      /**
       * ★ 本次领取用的 captcha 配置 —— **param 与 region 的唯一真相源**。
       *
       * ⚠ 放在「没有可领 plan」判断**之后**：那条路不需要 param，
       *   多发一次 `client/configs`（它有 60 秒 TTL，但首次仍是实打实一跳）
       *   去换一份用不上的配置没有意义。
       * ⚠ `fetchCaptchaConfig()` 会把网络异常**抛出来**（`TtlCache` 的语义是
       *   「失败不缓存、向上抛」），这里必须兜住：配置只是「region/prefix/sceneId」，
       *   拉不到就用兜底值继续，绝不该把整个领取变成一条看不懂的失败。
       * ⚠ 同时落进 `captchaMintConfig`：`CaptchaCarrier` 那条 chromium 兜底腿
       *   （`carrier` 字段注释）是读这个字段的 ⇒ 载体链产出的 param 与这里的
       *   region 也同源，不必让它自己再拉一次。
       */
      const captchaConfig = await this.fetchCaptchaConfig().catch(() => undefined) ?? ZCODE_CAPTCHA_FALLBACK
      this.captchaMintConfig = captchaConfig
      const region = captchaRegion ?? captchaConfig.region

      /**
       * ★★ 领取路径的诊断埋点与 `3012` 文案（Gitee issue IKJOQB）。
       *
       * 此前领取路径对 `3012` **既没有专门文案、也没有任何埋点** ——
       * 用户看到裸上游串、看不到「请勿连续重试」（该错误有账号冷却惩罚）。
       * 完整论证见 `toClaimOutcome` 的 `3012` 分支与
       * {@link resolveClaimAccountId}；这里只记三件与**本方法**有关的事：
       *
       * ① 三笔账（sent/ok/failed）按账号记在**每一发**上（含 3007 换链的重发）；
       * ② 账号标识取**池条目 id**，与推理路径合并同一份画像；
       * ③ 命中 `3012` 必须**短路**（见下）。
       */
      const accountId = await this.resolveClaimAccountId(credential)

      const outcomes: ClaimOutcome[] = []
      for (const plan of plans) {
        /**
         * ⚠ 单个 plan 的整段逻辑（mint → 首发 → 3007 换链重发 → 3012 短路判定）
         * 抽在 {@link claimOnePlan} 里：它自带 `try/catch`、且**返回「是否要继续
         * 下一个 plan」**。留在本方法里会让编排逻辑与单发逻辑混在一起，
         * 使本方法超出「单一职责」并撞上源码切片护栏（实测 9246 > 8000）。
         */
        const step = await this.claimOnePlan({
          plan, credential, accountId, mintCaptcha, captchaConfig, region,
        })
        outcomes.push(step.outcome)
        if (!step.continueWithNextPlan) break
      }
      return outcomes
    } finally {
      // ⚠ 领取窗口结束即清位。**漏掉这一行是最坏形态**：需求位是进程级的，
      //   client 只要看到它就一直产（成功冷却 25s 一轮），而没人消费 ⇒ 白烧设备级配额。
      setCaptchaDemand(false)
      /**
       * ★ **领取结束即关掉外挂 chromium**（用户报障 2026-10-02）。
       *
       * > 领取完 chromium 还是留存在任务栏，图标还会闪烁。
       *
       * 放在 `finally` 是**刻意**的：领取**失败**时同样要关 ——
       * 否则「领取失败」会额外留下一个占 200–400MB、还会在任务栏闪烁的进程，
       * 用户下次看到的仍是同一个抱怨。
       *
       * ⚠ **只在这里关**（即只覆盖领取流程）。推理路径
       * （{@link mintCaptchaParam} → 注入的 `zcode.mintCaptchaParam`）**不关** ——
       * 那时 captcha 是推理真的需要（被 `3007` 拒后补产），关掉会让紧接着的
       * 重发再冷启动一次。用户的原始要求就是这么分的：
       * 「如果不是领取积分还请求了 captcha 则再打开不关，领取积分完毕就关」。
       *
       */
    }
  }

  /**
   * 领取**单个 plan** 的完整一步：mint → 首发 → 3007 换链重发 → 判定是否短路。
   *
   * ## 为什么抽成独立方法
   *
   * 它自带 `try/catch`，并**返回「是否继续下一个 plan」** —— 这两个都是
   * 「单发」的概念，不属于编排层。留在 {@link claimDailyWith} 的循环里会让
   * 那个方法同时承担编排与单发两种职责，并撞上源码切片护栏
   * （`tests/unit/zcode-close-chromium.spec.ts` 断言其源码切片 < 8000 字符；
   * 混写时实测 9246）。
   *
   * ## ★★ 3012 短路**只在这里判断一次**（真实缺陷，2026-10-05）
   *
   * 首发的 `3007` 会触发换链重发，而**短路检查曾位于该换链之前**，
   * 于是重发那一发**绕过**了短路。桩测实测（两个 plan，首发 3007 ⇒ 重发 3012）：
   *
   * ```
   * claims=3 outcomes=2   → 被风控的账号继续发了下一个 plan 并成功领取
   * ```
   *
   * 即「一次点击连续触发多次风控」这条**恰在最需要它的场景下失效** ——
   * 上游先因 captcha 拒、再因风控拒，正说明它已在盯这个账号。
   * ⇒ 现在换链的结果**写回 `outcome`**，再由**唯一一处** `isClaimUnusualActivity`
   * 判定短路，首发与重发天然共用，结构上不可能再漏。
   *
   * @returns `outcome` 本条结果；`continueWithNextPlan` 为 `false` 时调用方须 `break`
   *   （即命中 `3012` 风控 —— **不要再发下一个 plan**，那会加重冷却惩罚）。
   */
  private async claimOnePlan(input: {
    plan: ZcodeClaimablePlan
    credential: ZcodeCredential
    accountId: string | undefined
    mintCaptcha: ZcodeClaimCaptchaMint | undefined
    captchaConfig: ZcodeCaptchaConfig
    region: string
  }): Promise<{ outcome: ClaimOutcome; continueWithNextPlan: boolean }> {
    const { plan, credential, accountId, mintCaptcha, captchaConfig, region } = input
    try {
      /**
       * ★★ **先验证、再领取** —— 复刻官方协议顺序（2026-11-04）。
       *
       * ## 为什么改（推翻了 2026-10-28 的「裸发优先」）
       *
       * 官方 `zai-org/ZCode`（8.4k star，公开源码）的
       * `docs/zai-start-plan-provider.md:305-324` 把领取写成一个**固定状态机**：
       *
       * ```text
       * idle -> checking-auth -> verifying -> claiming -> success-dialog
       * ```
       *
       * 原文：「官方版本的领取前安全校验成功后才调用 claim」「官方版本的安全校验
       * 结果通过请求头传递」。它的 `claimManualPlan()`
       * （`bigmodelCodingPlanSubscriptionProvider.ts:338`）在 claim 的 header 里
       * **无条件**展开 `...requestVerificationClaimHeaders(request)` —— 也就是说
       * **官方从不裸发**：每一发 claim 都带着一次已经做完的安全校验。
       *
       * 对照本仓库自己的实测记录（`zcode-upstream.ts:928-931`）：
       * - 2026-10-28（`app_version 3.16.3`）裸发 → `code:0` 成功；
       * - **2026-11-03（3.18.0 钉窗口后）裸发 → `400 {code:3007}`**。
       *
       * 结论：10-28 那次成功是**活动期的宽松窗口**，该窗口已于 11-03 关闭。
       * 在那个窗口里「裸发优先」能省掉整条浏览器链；但在窗口关闭后，它变成
       * **净损失** —— 每个 plan 先发一发注定 `3007` 的请求，既多一次上游风控
       * 计数，又白白多等一个往返。
       *
       * ## 现在的顺序
       *
       * 1. 先 `mint` 一个 param（相当于官方的 `verifying` 阶段）；
       * 2. 带着 `X-Aliyun-Captcha-Verify-*` 发 claim（相当于 `claiming`）；
       * 3. 只有 mint 失败（无浏览器 / 退避冷却）时，才退化成「裸发一试」——
       *    这是给**没有浏览器内核的形态**（web / 独立服务）保留的降级路径，
       *    否则那些形态连试一下的机会都没有。
       *
       * ⚠ 第 3 步的降级**不是**回到旧行为：旧行为是「永远先裸发」，现在是
       *   「先验证；验证产不出来才裸发」。有浏览器时顺序与官方一致。
       * ⚠ captcha 是**一次性**的：每个 plan 必须各自 mint，复用必 `3007`
       *   （见 `zcode-upstream.ts` 的 claim 注释）。
       */
      const claimStartedAt = Date.now()
      /** 本 plan 是否已走过「3007 换链重发」（只影响 3007 的文案措辞）。 */
      let internalRetried = false
      let diagnosticSentAt = claimStartedAt

      /**
       * 阶段 ①：`verifying` —— 产 param。
       *
       * ⚠ mint 失败**不直接判负**：先记下原因，走阶段 ①b 的裸发降级。
       *   这样「没有浏览器」不会把一键领取整条卡死（旧实现的教训，见
       *   `zcode-auth.ts` 的 `mintClaimCaptcha` 注释），同时也如实告诉用户
       *   「这次是没验证成，不是账号被风控」。
       */
      let minted: { param: string, source: 'internal' | 'chromium' } | undefined
      let mintError: Error | undefined
      try {
        minted = await this.mintClaimCaptcha(mintCaptcha, captchaConfig)
      } catch (error) {
        mintError = error instanceof Error ? error : new Error(String(error))
      }

      let outcome: ZcodeClaimOutcome
      if (minted !== undefined) {
        // 阶段 ②：`claiming` —— 带验证头领取（与官方同序）。
        noteZcodeRequestSent(accountId, claimStartedAt)
        outcome = await claimZcodePlan(
          credential, plan.planId, { param: minted.param, region }, this.fetchImpl,
        )
        if (outcome.ok) {
          noteZcodeRequestOk(accountId, Date.now())
        } else {
          noteZcodeRequestFailed(accountId)
        }
        // 内部 param 被 `3007` 拒 ⇒ 记一次归因（阈值禁用逻辑在 carrier）。
        // ⚠ 2026-11-14：外挂链退役后**没有换链重发**——内部 param 被拒说明
        // 本设备信誉被降级（无感验证换成滑块），同一来源再产多少个都一样。
        if (outcome.code === 3007 && minted.source === 'internal') {
          this.carrier.noteInternalRejection()
        }
      } else {
        // 阶段 ①b：面板没贡献（mint 抛 CarrierUnavailableError 走不到这里；
        // 这条兜底对应「mint 本身失败」的残量场景）⇒ 裸发一试。
        noteZcodeRequestSent(accountId, claimStartedAt)
        outcome = await claimZcodePlan(
          credential, plan.planId, undefined, this.fetchImpl,
        )
        if (outcome.ok) {
          noteZcodeRequestOk(accountId, Date.now())
        } else {
          noteZcodeRequestFailed(accountId)
        }
        /**
         * ⚠ 裸发回 `3007` 时**不再重试**：验证本身都产不出来，再发一次只会
         *   再多扣一次风控计数（3012 的阶梯惩罚：30 分钟 → 24 小时 → 停用）。
         *   把 mint 失败的原因并进文案，用户才知道「该打开面板」而不是
         *   「账号被封了」。
         */
        if (outcome.code === 3007 && mintError !== undefined) {
          outcome = {
            ...outcome,
            message: `${outcome.message}（安全验证无法完成：${mintError.message}）`,
          }
        }
      }
      /**
       * ★ 落一条「验证被阻断」到账号池 —— **任何 `3007` 都算**（2026-11-04 用户
       * 报「领取失败但异常汇总里什么都没有」）。
       *
       * ⚠ 记录点必须放在**两条分支之外**：真机实测（2026-11-04）里，内部载体
       *   其实**产出了** param，只是被上游拒了（回到首发带 param 的分支）——
       *   早先把记账写在「mint 失败」分支里，因此这种最常见的情形**一条都不记**，
       *   用户依然看不到。判据只能是「上游要验证而我们没通过」，与 param 从哪来
       *   无关。
       *
       * 与 `3012`（风控）分色：这里是我们没通过验证（要装浏览器 / 验证被拒），
       * 那边是上游罚账号（要停手等冷却）。
       * ⚠ `void …catch()`：展示层记账不许把领取失败变成另一件事。
       */
      if (outcome.code === 3007 && accountId !== undefined) {
        void this.accountPool()?.recordVerificationBlocked(accountId).catch(() => {})
      }
      const mapped = toClaimOutcome(outcome, plan.planId, {
        plan, accountId, sentAt: diagnosticSentAt, status: outcome.httpStatus, internalRetried,
      })
      /**
       * ★★ 命中 `3012`（风控）⇒ **终止本账号的领取，不再发后续 plan**。
       *
       * `3012` 是**账号级**风控且有**冷却惩罚**（30 分钟起步，反复触发升级到
       * 24 小时乃至停用）。而 `preview` 通常下发多个 plan ⇒ 不短路就是
       * 「一次点击连续触发 N 次风控」，亲手把 30 分钟推成 24 小时。
       *
       * ⚠ 判断的是**换链之后**的 `outcome`，故首发与重发两条路径都被覆盖。
       * ⚠ 与 `3007` 方向**相反**，别合并：`3007` 换个新 param 就能过；
       *   `3012` 再发一次只会更糟。
       * ⚠ 只跳过**剩余 plan**，不影响其它账号（RPC 的「一键领取」是逐账号循环）
       *   —— issue 的实测正是「5 个走通、只有 1 个被拦」。
       */
      if (isClaimUnusualActivity(outcome)) {
        this.carrierLog?.(
          `zcode: 账号 ${accountId ?? '-'} 被上游风控拦截（3012）⇒ 本账号停止领取 `
          + `（重试会加重冷却惩罚：30 分钟 → 24 小时 → 停用）`,
        )
        /**
         * ★ 领取路径命中风控 ⇒ **落账到账号池**（用户 2026-11-03 报「异常汇总
         * 不显示风控类型」：一键领取的 3012 只进了单次结果 toast，板块读的是
         * 账号上的持久标记，两边从未接通过）。
         * ⚠ 同样 `void …catch()`：展示层记账不许把领取失败变成另一件事。
         */
        if (accountId !== undefined) {
          void this.accountPool()?.recordAccountRisk(accountId).catch(() => {})
        }
        return { outcome: mapped, continueWithNextPlan: false }
      }
      return { outcome: mapped, continueWithNextPlan: true }
    } catch (error) {
      // CarrierUnavailableError（面板从未贡献 / 内部载体禁用）是**形态级终态**：
      // 原样给用户（文案即指引），并终止本账号的后续 plan —— 每个 plan 都要
      // 一个 param，没有来源时多发只会把同样的失败重复 N 遍。
      if (error instanceof CarrierUnavailableError) {
        return { outcome: { kind: 'failed', code: -1, message: error.message }, continueWithNextPlan: false }
      }
      return {
        outcome: {
          kind: 'failed',
          code: -1,
          message: `${plan.planId}: ${error instanceof Error ? error.message : String(error)}`,
        },
        continueWithNextPlan: true,
      }
    }
  }



  /**
   * 反查领取凭据对应的**账号池条目 id**（诊断画像的 key），供
   * {@link claimDailyWith} 的 `noteZcodeRequest*` 埋点使用。
   *
   * ## 为什么必须与推理路径用同一个 key
   *
   * 推理侧用的是**池条目 id**（`index.ts` 的 `activeZcodeAccountId`）。
   * 若领取侧另用 `user_id` / `credentialRef`，同一个账号会拿到两个序号，
   * 诊断里的「本进程 成功 N/失败 M」被劈成两半 —— 而 issue 要回答的
   * 「这个账号此前成功过几次 / 是否突然开始被拦」正靠这一项。
   *
   * ## ⚠ 用 `findAccountIdByIdentityField` 而**不是** `findAccountIdByCredential`
   *
   * 后者写死了「codearts 用 `access_key_id`、其余用 `access_token`」
   * （见 `account-pool.ts` 的方法注释），而 zcode 凭据里**没有** `access_token`
   * 字段（它用 `zcode_jwt` / `user_id`）⇒ 拿它查 zcode 恒回空串，
   * 诊断会静默退化成「所有账号都是 #1」。
   *
   * ## 处处容错（非关键路径）
   *
   * 账号池可能未注册（headless / 单测）、`user_id` 可能缺失（老凭据）——
   * 这些**都不该影响领取**，故整段吞异常并回 `undefined`：此时诊断退化成
   * 「账号#1 + 只有领取路径的计数」，如实降级，绝不编造。
   */
  private async resolveClaimAccountId(credential: ZcodeCredential): Promise<string | undefined> {
    const userId = credential.user_id
    if (typeof userId !== 'string' || userId.length === 0) return undefined
    const pool = this.accountPool()
    if (pool === undefined) return undefined
    try {
      const id = await pool.findAccountIdByIdentityField(this.product.id, 'user_id', userId)
      return id.length > 0 ? id : undefined
    } catch {
      return undefined
    }
  }

  /**
   * RPC `account.refresh`。
   *
   * ## ⚠⚠ 这里曾经有一个**数据破坏缺陷**（真实缺陷，2026-10-02）
   *
   * **用户报障**：「登录了 2 个账号（两个不同微信各自收到 bigmodel 登录通知），
   * 第二个账号有余额，但插件刷新积分显示 0，发消息报『额度已用尽』，
   * 而 IDE 里同一个账号发消息能收到回复」。
   *
   * **根因**：本方法与 {@link refreshAll} 都拿 `this.current()` 的结果
   * **无条件写回目标 ref** —— 而 `current()` 只返回**第一个凭据可用的账号**。
   * 于是账号 A 的凭据被写进账号 B 的 ref，**B 的原始凭据被永久覆盖**。
   *
   * **实测证据**（用户机器 `~/.dsh/.credentials.yaml`）：两个条目的
   * `zcode_jwt` 的 sha256、`device_mid`、`account_label`（同一昵称）、
   * `bigmodel_access_token` **全部逐字节相同** —— 同一个账号占了两条。
   * 用户确认「是两个不同微信账号」，故**只能是覆盖所致**。
   *
   * ⚠ **此处刻意不写真实值**：ref 名会暴露账号编号、昵称是用户的微信账号名、
   * `device_mid` 是设备标识。需要复核时从本机凭据自行取。
   *
   * **症状为何那么像服务端问题**：IDE 用自己那份真实凭据（B）→ 正常；
   * 插件池里两条都是 A → A 已耗尽 → 报额度用尽。
   *
   * ## 修法：**绝不跨账号写**
   *
   * ZCode **不可续期**（凭据是静态的，没有 refresh 端点），所以「刷新」
   * 唯一正确的语义是：**重新解析该账号自己的 ref，再写回它自己**
   * （用于「用户在别处更新了这个账号的凭据」这种情形）。
   * 与 `BuddyAuth.refreshAll` 的做法一致（那边也是逐账号读自己的 ref）。
   *
   * ⚠ 传了 `refName` 就**只动那一个 ref**；没传才回退到当前账号自己的 ref。
   * 无论如何**不会**拿到 A 的凭据去写 B。
   */
  async refreshAccountCredential(
    refName: string,
    pool?: AccountPool,
    accountId?: string,
  ): Promise<void> {
    /**
     * ⚠ 用**目标账号自己的** ref 重新解析凭据，而不是 `current()`。
     *
     * `current()` 的语义是「池里第一个可用账号」，与「要刷新的那个账号」
     * 可能**不是同一个** —— 这正是那个数据破坏缺陷的成因。
     */
    const own = await this.readCredentialFromRef(refName as CredentialRef)
    if (own !== undefined) {
      await this.ctx.credentials.set(refName as CredentialRef, JSON.stringify(own))
      return
    }
    void pool
    void accountId
    /**
     * 该 ref 自己解析不出凭据（未配置/损坏/被清空）。
     *
     * ## ⚠ 这里**刻意不做**「用别的凭据补上」的兜底
     *
     * 旧实现拿 `current()` 写进来，**副作用**是「该账号凭据损坏时会被
     * 别的账号填上」—— 那正是本次数据破坏的成因。
     *
     * 曾经还有个「用**本机磁盘凭据**补上」的兜底，它同样不可实施：
     * 单账号的磁盘凭据 vs 多账号的池，我们**无法判断**它属于哪一个。
     * 而那条路本身也已随 2026-10-05 的决策整体删除。
     *
     * ⇒ 如实报错，让用户重新登录该账号。这是**唯一**不会造成数据破坏的选项。
     */
    throw new Error(
      `ZCode 账号（${refName}）的凭据不可用或已损坏，请重新登录该账号` +
      '（本插件不会用其它账号的凭据覆盖它）。',
    )
  }

  /**
   * 批量续期（定时调度器调用）。
   *
   * ## ⚠⚠ 这里曾经是**跨账号覆盖**的第二个入口（真实缺陷，2026-10-02）
   *
   * 旧实现：
   * ```ts
   * const credential = await this.current()          // ← 只取「第一个可用账号」
   * for (const account of accounts) {
   *   await set(account.credentialRef, credential)   // ← 覆盖**每一个**账号
   * }
   * ```
   * 于是 30 分钟一轮的定时器会把账号 A 的凭据**铺满整个池**，
   * 抹掉其余账号的真实凭据（详见 {@link refreshAccountCredential} 的实测证据）。
   *
   * 旧注释的本意是「一份新凭据能铺开到所有条目」——
   * 那个前提在**多账号池**下是**错的**：一份凭据只对应**一个**账号。
   *
   * ## 正确做法：逐账号、各写各的
   *
   * ZCode **不可续期**，故这里没有「续期」动作；做的是**逐账号对账**：
   * 每个账号重新解析**自己的** ref，能解出就写回自己（规范化字段），
   * 解不出就**跳过并告警**（不填别人的凭据）。
   *
   * ⚠ **必须用它，不能自己写 `current()` + `getAvailableAccount()`**：
   * `current()` 先读池且**不看 `enabled`**，`getAvailableAccount` **过滤 `enabled`**，
   * 两者可能指向不同账号 ⇒ 「A 的凭据写进 B 的 ref」（见 `src/index.ts` 的 `refresh`）。
   *
   * ⚠ **只按 `refreshable` 过滤、不看 `enabled`**（`AGENTS.md` 既有约定：
   * 停用只影响自动选号，与凭据新鲜度无关）。
   */
  async refreshAll(pool: AccountPool): Promise<void> {
    const accounts = pool.listAccountsByProvider(this.product.id)
    for (const account of accounts) {
      const ref = account.credentialRef as CredentialRef
      try {
        /**
         * ⚠ **读该账号自己的 ref**（不是 `current()`）——这是本方法的关键。
         */
        const own = await this.readCredentialFromRef(ref)
        if (own === undefined) {
          /**
           * ⚠ **跳过，而不是用别的账号填它**。
           *
           * 旧实现会在这里用 `current()` 覆盖 ⇒ 破坏该账号的真实凭据。
           * 现在的选择是「什么都不做 + 留一条可排查的日志」——
           * 数据完整性优先于「把字段补齐」。
           */
          this.ctx.logger?.warn?.(
            `[channel-pack] zcode 账号 ${account.id} 的凭据不可用（跳过，不会用其它账号覆盖）`,
          )
          continue
        }
        await this.ctx.credentials.set(ref, JSON.stringify(own))
      } catch {
        // 单个账号失败不影响其余（与 BuddyAuth.refreshAll 同语义）。
      }
    }
  }

  /**
   * `status()` —— 供 Channel Pack 展示「是否已配置」。
   *
   * 与其余 provider 同形（返回 `{configured, ...}`）。
   */
  async status(): Promise<{ configured: boolean; label?: string; error?: string }> {
    const credential = await this.current()
    if (credential === undefined) {
      return { configured: false, error: this.lastError }
    }
    return { configured: true, label: credential.account_label }
  }

  /**
   * 释放资源。
   *
   * ⚠ 契约要求：`index.ts` 的 cleanup 对**全部** provider 统一调 `stop()`，
   * 缺了它会以 `is not a function` 崩在启动路径上
   * （`LoomyAuth` 的注释记过同一条）。
   *
   * ⚠ 会一并关闭 captcha 浏览器 —— 否则留下孤儿 chromium
   * （约 200-400MB，且用户没有界面能关掉它）。
   *
   * ⚠ 还要**放下内部载体的需求位**：需求位是进程级的，插件停了而位还提着，
   * GUI 那边的贡献循环就会继续按「server 要 param」产 —— 白耗**设备级**的验证配额
   * （阿里云同设备每小时 150 次，见 `src/captcha-backoff.ts`），且产出来的东西没人消费。
   * ⚠ 这一行是需求位的**兜底 owner**（正常路径由 {@link claimDailyWith} 的 `finally` 清），
   *   补的是「领取窗口进行中就被卸载」这一种：`finally` 要等 promise 落定才跑。
   * webview 租约本身由 client 侧归还（`plugin-src/client/index.js` 把停止函数挂在
   * `ctx.effect` 的清理路径上，`zcode-carrier.js` 的 `destroyGuest()` 调 `release`）。
   *
   * ⚠ 还要**关掉载体页小服务**（评审 C1/C2 的形态 B）：它是个真的监听器，
   */
  stop(): void {
    // 2026-11-14：外挂浏览器与预取池已随外挂链退役，只剩需求位要熄灭
    // （面板贡献循环见到熄灭即停止产出，不再烧设备配额）。
    setCaptchaDemand(false)
  }

}

/**
 * 把上游的领取结果映射成 Channel Pack 的 `ClaimOutcome`。
 *
 * @param options.internalRetried 这条结果来自「3007 之后换链重发」那一次。
 *   ⚠ 外挂链退役后 `internalRetried` 恒为 false（换链分支已删），字段保留以
 *   稳定 `toClaimOutcome` 的调用契约；文案分支据此区分「重试仍失败」与首败。
 */
export function toClaimOutcome(
  outcome: ZcodeClaimOutcome,
  planId: string,
  options: {
    internalRetried?: boolean
    plan?: ZcodeClaimablePlan
    /** 诊断现场（Gitee issue IKJOQB，**只为 `3012` 用**）：三者必须成套给。 */
    accountId?: string | undefined
    sentAt?: number
    status?: number
  } = {},
): ClaimOutcome {
  // 3007 = captcha 失败；给出可操作的提示而不是裸码。
  if (outcome.code === 3007) {
    return {
      kind: 'failed',
      code: 3007,
      message: options.internalRetried === true
        ? `captcha 被拒（${planId}）：已改用浏览器链路重试**仍**失败 —— `
          + '设备信誉不足，上游要求交互式验证，请稍后再试、别连点领取'
        : `captcha 校验失败（${planId}），请重试`,
    }
  }
  /**
   * ★★ `3012`（风控）必须单独成文案，**不能**落进下面的通用分支
   * （Gitee issue IKJOQB 的**主诉**）。
   *
   * ## 修复前的用户可见形态（issue 原文，逐字）
   *
   * ```
   * ZCode dbujns@chatai.dpdns.org：失败 — zcode-v3-start-plan-trust-1005:
   * request has been blocked due to unusual activity.
   * ```
   *
   * 这条文案有两个信息缺失，且**第二个有实际代价**：
   * ① 看不出这是**风控**而非普通失败；
   * ② **看不到冷却警告** —— 而「请勿连续重试」恰恰是用户最需要的一句
   *   （issue 作者原话：「我就是不知道有冷却，看到裸文案后以为还有别的问题，
   *   差点连续重试」）。
   *
   * ## 判据与文案都走**共用实现**
   *
   * 此前 `3012` 的文案在推理侧（`zcode-adapter.ts` 的 `describeUpstreamError`）
   * 与领取侧（这里）**各写一份**，而只有前者带了冷却警告 —— 这就是漂移。
   * ⇒ 判据（{@link isZcodeUnusualActivityCode} /
   * {@link looksLikeZcodeUnusualActivity}）与文案
   * （{@link formatZcodeUnusualActivityMessage}）现在都只在
   * `zcode-diagnostics.ts` 里有一份，两处引用同一个。
   *
   * ⚠ **诊断附在这一条上**（issue 的第二个诉求）：`formatZcodeDiagnostic`
   *   的三项（本次是池里第几个账号 / 该账号此前成功过几次 / 距上条请求隔多久）
   *   正好回答「一直如此还是突然开始」「是否频率风控」。
   *   ⚠ 诊断可为空（调用方没给 `accountId`）—— `formatZcodeDiagnostic` 本身
   *   容忍 `undefined`，而 `formatZcodeUnusualActivityMessage` 在诊断为空时
   *   **整段省略**，不会留下空壳「本机诊断：」。
   */
  if (isClaimUnusualActivity(outcome)) {
    /**
     * ⚠ **诊断只在调用方给了现场数据时才附**（判据取 `sentAt !== undefined`）。
     *
     * 为什么不无条件附：`toClaimOutcome` 是**公共纯映射函数**，既有若干
     * 只传 `(outcome, planId)` 的调用点（单测、以及「只要文案不要现场」的场景）。
     * 无条件附会凭空渲染出 `账号#1 · 距上条 —` —— 而那时我们**并不知道**
     * 是哪个账号，`账号#1` 是**编造**的（`normalizeKey` 把所有未知账号归一成
     * 同一个 `-` 桶），违反本模块「如实降级、不编造」的红线。
     * ⇒ 用 `sentAt` 当「有现场」的标记：真实领取路径（`claimDailyWith`）**始终**传，
     * 于是 issue 要的诊断一定在；纯映射调用点则保持干净。
     */
    const diagnostic = options.sentAt === undefined
      ? undefined
      : formatZcodeDiagnostic({
        accountId: options.accountId,
        sentAt: options.sentAt,
        status: options.status ?? outcome.httpStatus ?? 405,
        /**
         * ⚠ **不传 `shape`**：领取请求体只有 `{ plan_id }`，没有 `system` /
         * `messages`，照搬推理侧那套 `describeZcodeRequestShape` 会得到
         * 「身份块 0 字符」，**把一条正常请求误报成身份块缺失**。
         * ⇒ 只用与请求形态无关的那几项（见 `ZcodeDiagnosticInput.shape`）。
         */
        now: Date.now(),
      })
    return {
      kind: 'failed',
      code: 3012,
      message: formatZcodeUnusualActivityMessage({
        subject: planId,
        diagnostic,
        rawResponse: outcome.message,
      }),
    }
  }
  return {
    kind: 'failed',
    // ⚠ `code` 是 `failed` 分支的**必填**字段；上游没给码时用 -1 表示
    // 「无业务码」（HTTP 层失败）。
    code: outcome.code ?? -1,
    message: `${planId}: ${outcome.message ?? `HTTP ${outcome.httpStatus ?? '?'}`}`,
  }
}

/**
 * 领取结果是否为**上游风控拦截**（`3012`）—— 领取路径的统一判据。
 *
 * ## ⚠⚠ 判据有**优先级**：`code` 明确时**只信 `code`**（真实缺陷，2026-10-05 自审发现）
 *
 * 初版写成「`code === 3012` **或** `message` 含 `3012`」—— 那个「或」是错的：
 * 上游 `code` 一旦解析出来就是**权威**，此时再去扫 `message` 的自由文本只会引入误判。
 * 实测被误判的三种真实形态：
 *
 * | `code` | `message` | 初版 | 现在 |
 * |---|---|---|---|
 * | `1005` 额度用尽 | `quota 3012 exceeded` | ❌ 报成风控 | ✅ 如实报额度 |
 * | `1001` plan 不存在 | `plan plan-3012 not found` | ❌ 报成风控 | ✅ 如实报失败 |
 * | `3007` captcha | `captcha verify failed` | ✅ | ✅ |
 *
 * ## 为什么误判的后果**很重**（不是文案问题）
 *
 * 领取路径据此**短路**（`claimDailyWith` 的 `break`）⇒ 一个「plan 名里恰好含
 * `3012`」的普通失败会被当成风控，**跳过本账号本可领取的其余 plan**；
 * 且真实业务码被改写成 `3012` —— 而 `1005`（等额度重置）与 `3012`
 * （别重试，有冷却惩罚）的用户动作**完全相反**。
 *
 * ## 那什么时候才扫 `message`
 *
 * 只在 `code` **缺失**时。**而且要求风控语义共现**（真实缺陷，2026-10-05
 * 对抗性审计打出）——
 *
 * | 形态（无码） | 仅词边界 `3012` | 现在（+语义共现） |
 * |---|---|---|
 * | `too many requests, retry after 3012 ms` | ❌ **误判成风控** | ✅ 不命中 |
 * | `<h1>Error 3012</h1>upstream connect timeout` | ❌ **误判成风控** | ✅ 不命中 |
 * | `request has been blocked due to unusual activity.` | 需配合码 | ✅ 命中 |
 *
 * ⚠ 误判的后果与「漏判」**同样重**，只是方向相反：`429 限流`是「稍后重试即可」，
 * 被改写成「风控、**别重试**」—— 两者用户动作**完全相反**；且领取路径据此
 * **短路**，跳过本可领取的 plan。审计实测该形态下 3 个 plan 只发了 1 发。
 *
 * ⚠ 故判据是 {@link mentionsZcodeUnusualActivity}（词边界 + 语义共现），
 *   **不是**裸数字匹配。
 *
 * ⚠ 与推理侧的差异为何是合理的：`describeUpstreamError` 用
 * 「先 3009、再 1005、再 3007、最后 3012」的**分支顺序**达成了同样的优先级；
 * 而 `toClaimOutcome` 里 `3012` 特判在**通用分支之前**，没有那个顺序保护，
 * 故必须靠这里显式的优先级。
 */
export function isClaimUnusualActivity(outcome: ZcodeClaimOutcome): boolean {
  // ① `code` 明确 ⇒ 它是权威，不做任何文本猜测。
  if (outcome.code !== undefined) return isZcodeUnusualActivityCode(outcome.code)
  // ② 无码 ⇒ 只能看正文，且**必须**要求风控语义共现（见上）。
  return typeof outcome.message === 'string' && mentionsZcodeUnusualActivity(outcome.message)
}

/** 构造一个「不可用」的 `CheckinStatus`（字段全部显式给，满足契约）。 */
export function emptyCheckinStatus(active: boolean, actionRequired = false): CheckinStatus {
  return {
    active,
    todayCheckedIn: false,
    streakDays: 0,
    dailyCredit: 0,
    todayCredit: 0,
    isStreakDay: false,
    totalCredits: 0,
    checkinDates: [],
    activityName: '',
    themeName: '',
    endTime: '',
    ...actionRequired ? { actionRequired: true } : {},
  }
}
