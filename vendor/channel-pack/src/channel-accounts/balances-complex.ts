/**
 * ========================================
 * 渠道账户资产注册表 · credits.balances 复杂组（2026-11-06 纵切阶段 2）
 * ========================================
 *
 * 覆盖 9 个 provider 的 `balances` 方法，逐条照抄 `channel-pack-rpc.ts` 的
 * `case 'credits.balances'` 分支（行号见每段注释）：
 *   codearts / trae / commandcode / autoclaw / officeace / antigravity /
 *   zcode / buddy / workbuddy。
 *
 * 「复杂」的判据（相对 balances-simple.ts）：
 * - 渠道自带**多类业务判定**并要精确文案：codearts 的 4 类账户/错误分类、
 *   zcode 的 enterprise 文案 + 网络异常转 error；
 * - 渠道 helper 需要**显式传输**（第 1/2 参是 fetcher）：commandcode /
 *   officeace / autoclaw；
 * - 产物带**顶层字段**或**逐账号 extra**：trae / buddy / workbuddy 的
 *   `windowDays`、antigravity 的 `extra.accountTier` 与 `force` 透传；
 * - 依赖**只能由装配期闭包提供**的东西：zcode 的 `buildZcodeBalance`。
 *
 * ★ 三条硬约束（与 channel-account.ts 文件头一致）
 * 1. 传输一律走 `env.fetcher`（每 RPC 现建的 codeartsFetcher，绑 signal
 *    取消级联）。**不留兜底、不退回全局默认出口**。原分支在 trae /
 *    antigravity / buddy 兜底三处漏传 fetcher（各自 helper 的默认值是全局
 *    默认出口），迁移按约束 1 显式补上 —— 这是本文件相对原分支唯一的**行为
 *    增强**，请求/解析走的是同一个函数，读数口径不变。
 *    唯一例外是 zcode 的**传输归属**：原 :3650 走 `ZcodeAuth.fetchBalanceFor`
 *    实例方法。⚠ 该实例在 `index.ts:1726` 构造时**没有注入出口**
 *    （`ZcodeAuth` 的构造器用「options.fetchImpl 或进程默认」取传输），走实例
 *    方法等于退回全局默认出口 —— 正是约束 1 禁止的。故取数改用**同一个底层
 *    函数** `fetchZcodeBalance(credential, env.fetcher)`（实例方法内部就是它），
 *    见 makeZcodeBalances 注释。
 * 2. 逐账号编排一律复用 `collectCreditBalances`（顺序执行、单账号失败不中断、
 *    凭据解析在 try 内），不在本文件另写 for 循环。
 * 3. `productById` 白名单**只认 buddy / workbuddy**：其余 provider 若被路由
 *    到这里，必须回 `bad-request`（原 :3666-3669 的兜底），不能猜产品配置。
 *
 2026-11-07 t4-C1 断环：编排 helper 改从 `../credits-helpers.js` import（见文件头）。
 */

import type { ChannelAccount, ChannelAccountEnv, CreditsResult } from '../channel-account.js'
import { collectCreditBalances } from '../credits-helpers.js'
import type { CodeArtsCredential, RpcCreditsBalanceExtra, RpcCreditsBalancesResponse } from '../types.js'
import { fetchCodeArtsAccountInfoDetailed } from '../codearts-credits.js'
import { readCredits } from '../commandcode-credits.js'
import { COMMANDCODE } from '../commandcode-product.js'
import type { CommandCodeCredential } from '../commandcode.js'
import type { AutoClawCredential } from '../autoclaw.js'
import type { OfficeAceCredential } from '../officeace.js'
import { TRAE } from '../trae-product.js'
import { fetchTraeCreditBalance } from '../trae-credits.js'
import type { TraeCredential } from '../trae.js'
import { ANTIGRAVITY } from '../antigravity.js'
import { fetchGeminiCreditBalance } from '../antigravity-credits.js'
import type { AntigravityCredential } from '../antigravity.js'
import { productById } from '../product.js'
import { buddyExpiringWindowDays } from '../buddy-balance-rank.js'
import { fetchZcodeBalance } from '../zcode-upstream.js'
import type { ZcodeBalanceResult } from '../zcode-upstream.js'
import type { ZcodeCredential } from '../zcode.js'
import type { CreditBalance } from '../credits.js'

/** 单个 provider 的 balances 实现签名（信封与 dispatchMethod 的 reply 完全一致）。 */
type BalanceMethod = (env: ChannelAccountEnv) => Promise<CreditsResult<RpcCreditsBalancesResponse>>

/**
 * 装配期注入的上下文（**只放 env 装不下的东西**）。
 *
 * - `zcode`：底层 `fetchZcodeBalance` 直接送 env.fetcher（不再注入实例）。
 *   的传输注释：该实例在 `index.ts:1726` 构造时没有注入出口，走
 *   `fetchBalanceFor` 会退回全局默认出口，违反约束 1。故它只作**运行期兜底
 *   通道**（env.fetcher 被漏传时才会用上），正常接线不经过它。
 * - `buildZcodeBalance`：原实现是 `channel-pack-rpc.ts:1410-1500` 里
 *   `registerChannelPackEndpoints()` 的**内层函数**（它消费内层闭包状态、
 *   且不在模块顶层导出），无法 `import`，故由装配期以回调传入。行为逐字照抄
 *   原函数：过期桶丢弃、未生效桶丢弃、活动额度只补「尚未被桶表达」的那部分、
 *   空桶给具名占位包、汇总由包相加（详见原注释
 *   :1412-1421 / :1449-1455 / :1476-1495）。
 *
 * ⚠ 两者都必传。`buildZcodeBalance` 漏传时 zcode 那一行会在运行期报错
 *   （被 collectCreditBalances 的单账号 try 捕获成 error 文案，不会炸整轮），
 *   但读数会缺失 —— 接线时务必给上。
 */
export interface ComplexBalanceIo {
  /** channel-pack-rpc.ts:1410 的内层函数，原样传入，避免搬动。 */
  readonly buildZcodeBalance: (result: ZcodeBalanceResult) => CreditBalance
}

/** 统一的账户对象构造（运行期禁改，与 index.ts 的冻结约定一致）。 */
function balancesAccount(id: string, balances: BalanceMethod): ChannelAccount {
  return Object.freeze({ id, balances })
}

/**
 * codearts：余额来自 `statistics/plugin`（与账户类型检测同一个响应）。
 *
 * 照抄 :3325-3350。用**带原因的** `fetchBalanceDetailed`：`fetchCodeArtsAccountInfo`
 * 只回 null，会把「AK 限流 / 签名失败 / 凭据过期」压成同一句笼统文案。
 * 四类错误分类（顺序不可换，后两类是「正常状态」不是故障）：
 *   ① 查询失败      → `账户信息查询失败：${result.message}`  （:3333）
 *   ② Token 计费账户 → `Token 计费账户，无积分余额`          （:3339）
 *   ③ 非积分计费账户 → `非积分计费账户，无积分余额`          （:3340）
 *   ④ 积分账户但无 credit metric → `未返回积分数据`          （:3345）
 * ②③④ 都回 `balance: null`，绝不显示成 0（0 会让用户以为积分用光）。
 */
const codeartsBalances: BalanceMethod = async (env) => {
  const values = await collectCreditBalances<CodeArtsCredential, undefined>(env.accounts, undefined, {
    // 原 :3325 的 deps 未显式给 fetcher（钩子自己闭包了 codeartsFetcher）；
    // 迁移统一填 env.fetcher，钩子内同样显式使用。
    fetcher: env.fetcher,
    resolve: (ref) => env.resolve(ref),
    fetchBalanceDetailed: async (credential) => {
      const result = await fetchCodeArtsAccountInfoDetailed(credential, env.fetcher)
      if (!result.ok) return { balance: null, error: `账户信息查询失败：${result.message}` }
      const info = result.info
      if (!info.isCreditPackage) {
        return {
          balance: null,
          error: info.isTokenPackage
            ? 'Token 计费账户，无积分余额'
            : '非积分计费账户，无积分余额',
        }
      }
      if (info.credit === undefined) return { balance: null, error: '未返回积分数据' }
      return { balance: info.credit }
    },
    warn: (msg) => env.warn?.(msg),
  })
  return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
}

/**
 * trae：余额来自 TRAE 企业版用量端点（`fetchTraeCreditBalance`）。
 *
 * 照抄 :3427-3445。⚠ **必须带回顶层 `windowDays`**：TRAE 的资源包现在带
 * `deductionEndTime`（条目级 `expire_time`，秒→毫秒），面板要按「长期 / 临时」
 * 分桶显示；没有窗口天数前端会拒绝渲染分类行（`credit-expiry.js` 的
 * `normalizeWindowDays` 把「无该字段」视为「没有作废维度」）。窗口语义与
 * buddy 系一致，故同样取 `buddyExpiringWindowDays()`（可被
 * `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 覆盖）。
 */
const traeBalances: BalanceMethod = async (env) => {
  const values = await collectCreditBalances(env.accounts, TRAE, {
    fetcher: env.fetcher,
    resolve: (ref) => env.resolve(ref),
    // 原 :3430 未把传输送进第三参（helper 的默认实现退回全局默认出口）；
    // 按约束 1 显式传 env.fetcher。
    fetchBalance: (credential, product) =>
      fetchTraeCreditBalance(credential as TraeCredential, product, env.fetcher),
    warn: (msg) => env.warn?.(msg),
  })
  return {
    ok: true,
    value: {
      accounts: values,
      windowDays: buddyExpiringWindowDays(),
    } satisfies RpcCreditsBalancesResponse,
  }
}

/**
 * commandcode：额度由 `readCredits` 读取（与 commandcode-service 共用实现，
 * 含「耗尽」判定；读不到数值时返回 null，不编 0）。
 *
 * 照抄 :3463-3476。产品常量 `COMMANDCODE` 与原分支一样是**静态** import
 * （原分支没有动态 import，这里不擅自改）。
 */
const commandcodeBalances: BalanceMethod = async (env) => {
  const values = await collectCreditBalances<CommandCodeCredential, typeof COMMANDCODE>(env.accounts, COMMANDCODE, {
    fetcher: env.fetcher,
    resolve: (ref) => env.resolve(ref),
    fetchBalance: async (credential) => {
      const snapshot = await readCredits(env.fetcher, COMMANDCODE, credential)
      if (snapshot === undefined || snapshot.balance === undefined) return null
      return { total: snapshot.balance, packages: [], expiredTotal: 0 }
    },
    warn: (msg) => env.warn?.(msg),
  })
  return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
}

/**
 * autoclaw：**积分制**，余额来自 `GET {userapi}/agent-assetmgr/api/v2/wallets`
 * （v1 降级）。⚠ 这个域认标准 `Authorization`，用对话链的 `X-Authorization`
 * 会回 `code 410000 用户未登录` —— 实测踩过。
 *
 * 照抄 :3478-3515（含原分支的两处**动态 import**：autoclaw-sms.js 的
 * `fetchAutoClawWallets` 与 autoclaw-product.js 的 `AUTOCLAW` 产品常量）。
 * `wallets === undefined`（拿不到）→ `未返回积分数据`，绝不显示成 0。
 */
const autoclawBalances: BalanceMethod = async (env) => {
  const { fetchAutoClawWallets } = await import('../autoclaw-sms.js')
  const { AUTOCLAW: AUTOCLAW_PRODUCT } = await import('../autoclaw-product.js')
  const values = await collectCreditBalances<AutoClawCredential, typeof AUTOCLAW_PRODUCT>(env.accounts, AUTOCLAW_PRODUCT, {
    fetcher: env.fetcher,
    resolve: (ref) => env.resolve(ref),
    fetchBalanceDetailed: async (credential) => {
      const wallets = await fetchAutoClawWallets({
        product: AUTOCLAW_PRODUCT,
        fetcher: env.fetcher,
        credential,
      })
      if (wallets === undefined) return { balance: null, error: '未返回积分数据' }
      const total = wallets.reduce((sum, w) => sum + w.balance, 0)
      return {
        balance: {
          total,
          packages: wallets.map((w) => ({
            name: w.displayName,
            unit: 'credits',
            remaining: w.balance,
            total: w.balance,
            used: 0,
            active: true,
            cycleStartTime: '',
            cycleEndTime: '',
            expiredTime: '',
          })),
          expiredTotal: 0,
        },
      }
    },
    warn: (msg) => env.warn?.(msg),
  })
  return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
}

/**
 * officeace（果办）：**积分制**，余额来自 `GET {gateway}/v1/subscription`
 * （V11-HMAC-SHA256 签名 + `x-subscription-type: v2`）。
 *
 * 照抄 :3517-3551（含原分支的两处**动态 import**：officeace.js 的
 * `fetchSubscriptionSnapshot` 与 officeace-product.js 的 `OFFICEACE`）。
 * 口径：`total` = 可用剩余（套餐 + 未过期奖励）；`skus[].quotas[]` 的
 * `officeace_points` 剩余 = sku_value - current_value（与 officeace2api
 * `quota.mjs` 的 summarizeSubscription 同款）；`expiresAt === 0`（未知）
 * 的包把 `cycleEndTime` 留空而不是编一个 ISO 时间。
 */
const officeaceBalances: BalanceMethod = async (env) => {
  const { fetchSubscriptionSnapshot } = await import('../officeace.js')
  const { OFFICEACE } = await import('../officeace-product.js')
  const values = await collectCreditBalances<OfficeAceCredential, typeof OFFICEACE>(env.accounts, OFFICEACE, {
    fetcher: env.fetcher,
    resolve: (ref) => env.resolve(ref),
    fetchBalance: async (credential) => {
      const snapshot = await fetchSubscriptionSnapshot(env.fetcher, OFFICEACE, credential)
      return {
        // total 口径与面板其它渠道一致：可用剩余（套餐 + 未过期奖励）。
        total: snapshot.remaining,
        packages: snapshot.packages.map((pkg) => ({
          name: pkg.name,
          unit: 'credits',
          remaining: pkg.remaining,
          total: pkg.total,
          used: pkg.used,
          active: true,
          cycleStartTime: '',
          cycleEndTime: pkg.expiresAt === 0 ? '' : new Date(pkg.expiresAt).toISOString(),
          expiredTime: '',
        })),
        expiredTotal: 0,
      }
    },
    warn: (msg) => env.warn?.(msg),
  })
  return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
}

/**
 * antigravity：余额 = **配额窗口**（不是充值积分），
 * `POST /v1internal:retrieveUserQuotaSummary` 两个桶（`gemini-5h` /
 * `gemini-weekly`）的剩余比例。
 *
 * 照抄 :3553-3589，三个不能再丢的点：
 * - 用 `fetchBalanceDetailed`（而非 `fetchBalance`）：Gemini 的「未授权」
 *   与「查询失败」是两回事 —— 前者显示「尚未授权 Google 账号」，后者显示具体
 *   原因（网络/HTTP/响应形状）。helper 只在 `error` 缺失时才补「余额查询失败」。
 * - `env.force` **透传**：面板「刷新」按钮要跳过 60 秒缓存（原 `req.force`）。
 * - `extra.accountTier` **透传**：`loadCodeAssist` 与配额并行取，档位挂在
 *   `result.tier`；翻译成面板要的 `{label, title}`（label 是短标签，title 是
 *   上游原文 `Google AI Pro（g1-pro-tier）`）。档位取不到时 `extra` 缺席
 *   （**不是错误**，面板不渲染那一行）。
 */
const antigravityBalances: BalanceMethod = async (env) => {
  const values = await collectCreditBalances<AntigravityCredential, typeof ANTIGRAVITY>(env.accounts, ANTIGRAVITY, {
    fetcher: env.fetcher,
    resolve: (ref) => env.resolve(ref),
    fetchBalanceDetailed: async (credential) => {
      // 原 :3577 只传了 force（helper 的 options.fetcher 缺省时退回全局默认出口）；
      // 按约束 1 显式补 env.fetcher，其余选项一字不动。
      const { balance, error, tier } = await fetchGeminiCreditBalance(credential, ANTIGRAVITY, {
        force: env.force === true,
        fetcher: env.fetcher,
      })
      const extra: RpcCreditsBalanceExtra | undefined = tier === undefined
        ? undefined
        : { accountTier: { label: tier.label, title: `${tier.name}（${tier.id}）` } }
      return {
        balance,
        ...error === undefined ? {} : { error },
        ...extra === undefined ? {} : { extra },
      }
    },
    warn: (msg) => env.warn?.(msg),
  })
  return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
}

/**
 * zcode：余额来自 `GET /zcode-plan/billing/balance`（**只读**，无副作用），
 * 单位是 token 而面板语义是积分：如实回数值，`balance: null` 表示查不到。
 *
 * 照抄 :3634-3664，渠道独有的业务判定全收在 fetchBalanceDetailed 一个钩子里：
 * - 网络异常真抛（`fetchWithTimeout`）→ **转成带原因的 error 行**，单账号抖动
 *   不炸整轮（原手写循环的 try/catch 语义完整保留）；
 * - `result === undefined`（凭据失效 / HTTP 异常）→ `额度查询失败（凭据失效或网络异常）`；
 * - `enterprise === true` → `企业版账号不下发额度数字，请在 ZCode 内查看`
 *   （企业版只给外链，**不要**显示成 0 —— 0 是「已用光」的语义）；
 * - 正常 → `buildZcodeBalance` 逐桶映射（多桶不丢，见 ComplexBalanceIo 注释）。
 *
 * ⚠ **传输归属（与「严格照抄」唯一的有意偏差）**：原 :3650 调
 * `zcode.fetchBalanceFor(credential)`，即 `ZcodeAuth` 实例方法；而该实例在
 * `index.ts:1726` 构造时**没有注入出口**（构造器取「options.fetchImpl 或进程
 * 默认」），走实例方法会退回全局默认出口、丢掉本 RPC 的 signal 取消级联 ——
 * 正是 channel-account.ts 约束 1 明令禁止的。故取数改用**同一个底层函数**
 * `fetchZcodeBalance(credential, env.fetcher)`（`fetchBalanceFor` 内部就是它），
 * 请求与解析逻辑一字不差，只有传输换成绑 signal 的 env.fetcher。
 * ⚠️ 不再保留实例方法兜底（2026-11-06 审查修复）：那条兜底会退回全局出口。
 */
function makeZcodeBalances(io: ComplexBalanceIo): BalanceMethod {
  return async (env) => {
    // 2026-11-06 全码审查修复（t1-B5）：env.fetcher 类型上必传、装配上保证，
    // 删掉「运行期漏传退回 zcode 实例方法」的兜底 —— 那条兜底恰恰会退回
    // 全局出口（实例未注入 fetchImpl）。直接走底层函数送 env.fetcher。
    const values = await collectCreditBalances<ZcodeCredential, undefined>(env.accounts, undefined, {
      fetcher: env.fetcher,
      resolve: (ref) => env.resolve(ref),
      fetchBalanceDetailed: async (credential) => {
        let result: ZcodeBalanceResult | undefined
        try {
          result = await fetchZcodeBalance(credential, env.fetcher)
        } catch (error) {
          return { balance: null, error: `额度查询失败：${error instanceof Error ? error.message : String(error)}` }
        }
        if (result === undefined) {
          return { balance: null, error: '额度查询失败（凭据失效或网络异常）' }
        }
        if (result.enterprise === true) {
          return { balance: null, error: '企业版账号不下发额度数字，请在 ZCode 内查看' }
        }
        return { balance: io.buildZcodeBalance(result) }
      },
      warn: (msg) => env.warn?.(msg),
    })
    return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
  }
}

/**
 * buddy / workbuddy 兜底：原 `case` 的**最后一段**（:3666-3684）。
 *
 * ⚠ `productById()` 白名单**只认 CodeBuddy / WorkBuddy**（product.ts 的
 * `ALL_PRODUCTS`）。其余 provider 若被路由到这里必须回
 * `bad-request: unsupported provider: ${provider}` —— 正是原 :3667-3669 的
 * 兜底语义（已知但未覆盖的 provider 因此仍能拿到可读的 bad-request，而不是
 * 被猜成 buddy 产品去打错端点）。注册表按 id 分派后，未登记的 provider 会落
 * 原 switch 分支并命中同一守卫，两条路径行为一致。
 *
 * ⚠ **必须带回顶层 `windowDays: buddyExpiringWindowDays()`**：面板要把资源包
 * 分成临时 / 永久两桶显示，窗口必须由后端给出（可被
 * `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 覆盖），前端写死就会与选号判据分叉。
 */
const buddyFallbackBalances: BalanceMethod = async (env) => {
  const product = productById(env.provider)
  if (product === undefined) {
    return { ok: false, error: { code: 'bad-request', message: `unsupported provider: ${env.provider}` } }
  }
  const values = await collectCreditBalances(env.accounts, product, {
    // 2026-11-06 全码审查修复（t1-B1）：显式送 env.fetcher，保住出口绑定与
    // signal 取消级联。测试桩已由 signedLane.fetch 转发到当前替换的替身，
    // 补此参后 V3 双模式回归仍绿（不再有「改了会红」的问题）。
    fetcher: env.fetcher,
    resolve: (ref) => env.resolve(ref),
    warn: (msg) => env.warn?.(msg),
  })
  return {
    ok: true,
    value: {
      accounts: values,
      windowDays: buddyExpiringWindowDays(),
    } satisfies RpcCreditsBalancesResponse,
  }
}

/**
 * 复杂组工厂：返回 9 个只实现 `balances` 的 ChannelAccount。
 *
 * 顺序照原 switch 的分支顺序（codearts → trae → commandcode → autoclaw →
 * officeace → antigravity → zcode → buddy 兜底），便于与原文件对照。
 * `buddy` 与 `workbuddy` 共用同一实现（原兜底只有一段），但**必须是两个
 * 独立对象**：注册表以 id 为 key，`add()` 合并时才能与前序阶段已登记的
 * `workbuddy.claim`（index.ts 阶段 1 的 bad-request）共存。
 */
export function makeComplexBalanceAccounts(io: ComplexBalanceIo): ChannelAccount[] {
  return [
    balancesAccount('codearts', codeartsBalances),
    balancesAccount('trae', traeBalances),
    balancesAccount('commandcode', commandcodeBalances),
    balancesAccount('autoclaw', autoclawBalances),
    balancesAccount('officeace', officeaceBalances),
    balancesAccount('antigravity', antigravityBalances),
    balancesAccount('zcode', makeZcodeBalances(io)),
    balancesAccount('buddy', buddyFallbackBalances),
    balancesAccount('workbuddy', buddyFallbackBalances),
  ]
}
