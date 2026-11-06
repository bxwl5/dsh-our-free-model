/**
 * 渠道账户资产 · balances 简单组（2026-11-06「学 magpie 架构」纵切 阶段 2）。
 *
 * 本文件只负责**六家**（opencode / loomy / raccoon / minimax / qoder 族 / cline）
 * 的 `credits.balances` 实现，逐字照抄 `channel-pack-rpc.ts` 原 switch 分支的
 * 钩子与文案：
 *
 * | provider | 原分支锚点 | 本文件实现 |
 * |---|---|---|
 * | opencode | :3365-3426 | 零网络本地 map（**不**走 collectCreditBalances） |
 * | loomy     | :3611-3623 | `collectCreditBalances` + `io.loomy.fetchCreditBalance` |
 * | raccoon   | :3624-3633 | `collectCreditBalances` + `io.raccoon.fetchCreditBalance` |
 * | minimax   | :3447-3462 | `collectCreditBalances` + `fetchMinimaxCreditBalance(credential, env.fetcher)` |
 * | qoder 族  | :3352-3364 | `collectCreditBalances` + `io.qoderFamily` 的 product |
 * | cline     | :3591-3609 | `collectCreditBalances` + 带原因的 `fetchBalanceDetailed` |
 *
 * ★ **只换分发入口，钩子不重写**（团队定稿 §4-8）：重写会破坏
 *   `collectCreditBalances` 的「顺序执行 / 单账号失败不中断 / 凭据解析在 try 内」
 *   编排（见 `channel-pack-rpc.ts:682-736`）。
 *
 * ★ **env.fetcher 必用**：每个 `collectCreditBalances` 调用都显式填
 *   `fetcher: env.fetcher`（本 RPC 现建的 codeartsFetcher，绑 signal 取消级联），
 *   绝不退回全局默认出口（定稿 §1-2 / §4-2）。
 *
 * 2026-11-07 t4-C1 断环：编排 helper 改从 `../credits-helpers.js` import（见文件头）。
 */

import type {
  ChannelAccount,
  ChannelAccountEnv,
  CreditsResult,
} from '../channel-account.js'
import type { RpcCreditsBalancesResponse } from '../types.js'
import type { CreditBalance } from '../credits.js'
import { collectCreditBalances } from '../credits-helpers.js'
import { fetchLoomyCreditBalance } from '../loomy-credits.js'
import { fetchRaccoonCreditBalance } from '../raccoon-credits.js'
import type { LoomyCredential } from '../loomy.js'
import type { RaccoonCredential } from '../raccoon.js'
import type { MinimaxCredential } from '../minimax.js'
import type { QoderCredential } from '../qoder.js'
import type { ClineCredential } from '../cline.js'
import { LOOMY } from '../loomy-product.js'
import { RACCOON } from '../raccoon-product.js'
import { CLINE } from '../cline-product.js'
import type { QoderProduct } from '../qoder-product.js'
import { fetchMinimaxCreditBalance } from '../minimax-credits.js'
import { fetchQoderCreditBalance } from '../qoder-credits.js'
import { fetchClineCreditBalance } from '../cline-credits.js'

/**
 * Qoder 同族成员（**只用到 product**）。
 *
 * 与 `channel-pack-rpc.ts:1026-1033` 的 `QoderFamilyMember` 结构兼容：
 * 那个接口多一个 `auth` 字段，本模块不需要它，故只声明用得到的部分。
 */
export interface SimpleBalanceQoderMember {
  readonly product: QoderProduct
}

/**
 * 装配期注入的上下文（**工厂全、env 瘦**：见 `channel-account.ts` 文件头）。
 *
 * 只捕获 Qoder 同族成员表 —— 其余上下文（`resolve` / `warn` / `fetcher` /
 * `accounts` / `signal`）全部走 `ChannelAccountEnv`。
 * 2026-11-06 全码审查修复后，loomy / raccoon 改走底层余额函数送 env.fetcher，
 * 不再需要注入认证实例。
 */
export interface SimpleBalanceIo {
  /**
   * Qoder 同族成员表（国际版 + 中国版）。
   *
   * ⚠️ `qoder` 与 `qodercn` **共享同一份实现、但 id 不同**（定稿 §2.2b）：
   * 两个 key 都命中 `isQoderFamily(req.provider)`，故按 product.id 各注册一个
   * ChannelAccount，实现体完全共享。
   */
  readonly qoderFamily: readonly SimpleBalanceQoderMember[]
}

/** 余额信封：与原分支逐字同形的 `{ok:true,value:{accounts}}`。 */
type BalancesEnvelope = CreditsResult<RpcCreditsBalancesResponse>

/**
 * 造一个**只有 balances** 的 ChannelAccount。
 *
 * ⚠️ `status` / `claim` 一律**缺席** —— 缺席 = 该 (provider, method) 尚未迁移，
 *   分派层落原 switch 分支（`channel-account.ts` 文件头约束 3）。
 */
function balancesOnlyAccount(
  id: string,
  balances: (env: ChannelAccountEnv) => Promise<BalancesEnvelope>,
): ChannelAccount {
  return Object.freeze({ id, balances })
}

/**
 * opencode：**零网络**本地 map（原分支 :3365-3426 逐字照抄）。
 *
 * ⚠️⚠️ **这里不查远端余额**（设计决定，2026-10-02，与用户确认走「限额状态」路 A）。
 *
 * ## 为什么
 *
 * OpenCode Zen **没有公开的余额查询端点**：实测 `/zen/v1/` 下的
 * `balance` / `credits` / `usage` / `billing` / `quota` / `limits` /
 * `subscription` / `workspace` 等 15 个候选路径**全部 404**
 * （返回官网页面 HTML，不是 API 的 JSON 404）。
 * 它确实有额度概念（余额耗尽回 `402 Insufficient account funds`），
 * 但那个数字只在控制台网页里看，没有 API 可查。
 *
 * ⇒ 徽标展示**我们真正测得到的东西**：每个通道（账号槽 / 匿名通道）
 * 当前是否可用、是否处于限额冷却。数据全部来自**本地状态**
 * （账号池的 `modelRateLimits` 与 `enabled`），**零网络请求**。
 *
 * ## 语义映射（不伪装成「余额」）
 *
 * `CreditBalance.total` 在此表示「**当前可用通道数**」，单位固定
 * 「通道」；限额中的通道数放进 `expiredTotal`，面板据此显示
 * 「另有 N 限额中」——与其它 provider 的「已失效资源包」口径一致，
 * 徽标的 UI 逻辑不用改。
 *
 * ⚠️ 因此本实现**不走** `collectCreditBalances`（那会解析凭据并发网络请求），
 *   也**不注入** fetcher（本就无网络；误注入会引发无意义请求）。
 */
function opencodeBalanceAccount(): ChannelAccount {
  return balancesOnlyAccount('opencode', async (env) => {
    const values = env.accounts.map((account) => {
      const now = Date.now()
      const limits = Object.entries(account.modelRateLimits ?? {})
      const limitedUntil = limits.reduce((max, [, resetAt]) => Math.max(max, Number(resetAt) || 0), 0)
      // 只数**尚未到期**的限额（已过期的交给 sweepExpiredRateLimits 清理）。
      const limitedModels = limits.filter(([, resetAt]) => Number(resetAt) > now).length
      const available = account.enabled && limitedUntil <= now ? 1 : 0
      // ⚠️ `CreditPackage` 的必填字段对 opencode 大多**无意义**
      // （remaining/used/cycle* 都是「资源包计费周期」的概念，
      // 而我们表达的是「通道是否可用」）。按类型要求填中性值，
      // 徽标 UI 实际只读 `unit` / `total` / `active`（见 badge-model.js
      // 的 creditGroupsOf），故这些字段不会出现在展示里。
      const balance: CreditBalance = {
        total: available,
        packages: [{
          name: limitedModels > 0 ? `${limitedModels} 个模型限额中` : '可用通道',
          unit: '通道',
          remaining: available,
          total: available,
          used: 0,
          active: true,
          cycleStartTime: '',
          cycleEndTime: '',
          expiredTime: '',
        }],
        expiredTotal: account.enabled && limitedUntil > now ? 1 : 0,
      }
      return {
        accountId: account.id,
        nickname: account.nickname,
        balance,
        ...(!account.enabled
          ? { error: '已停用' }
          : limitedUntil > now
            ? { error: `限额中，${new Date(limitedUntil).toLocaleString('zh-CN')} 恢复` }
            : {}),
      }
    })
    return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
  })
}

/**
 * loomy（原分支 :3611-3623 逐字照抄）。
 *
 * 2026-11-06「学 magpie 架构」试点：渠道只提供 fetchBalance 实现，
 * 逐账号编排（顺序执行 / 单账号失败不中断 / 凭据解析在 try 内）
 * 统一交给 collectCreditBalances —— 与其余 8 家同构，手写循环删除。
 * 余额来自 `GET /points/records`（**只读**，无副作用）；刻意不用
 * `first-login`：那是**写**端点，高频面板路径会意外触发签到。
 *
 * ⚠️ 2026-11-06 全码审查修复：原走 `io.loomy.fetchCreditBalance` 实例方法，
 *   其 `fetchImpl = options.fetcher ?? fetch`（实例构造未注入）⇒ 退回全局出口、
 *   丢 signal 级联。改用底层 `fetchLoomyCreditBalance(credential, LOOMY, env.fetcher)`。
 */
function loomyBalanceAccount(_io: SimpleBalanceIo): ChannelAccount {
  return balancesOnlyAccount('loomy', async (env) => {
    const values = await collectCreditBalances<LoomyCredential, typeof LOOMY>(env.accounts, LOOMY, {
      resolve: env.resolve,
      fetcher: env.fetcher,
      fetchBalance: (credential) => fetchLoomyCreditBalance(credential, LOOMY, env.fetcher),
      warn: env.warn,
    })
    return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
  })
}

/**
 * raccoon（原分支 :3624-3633 逐字照抄）。
 *
 * 余额来自 `GET /points/v1/balance`（**只读**，无副作用）。
 * 2026-11-06「学 magpie 架构」：编排交给 collectCreditBalances。
 *
 * ⚠️ 2026-11-06 全码审查修复：同 loomy，实例方法内部退回全局出口，
 *   改用底层 `fetchRaccoonCreditBalance(RACCOON, credential, env.fetcher)`。
 */
function raccoonBalanceAccount(_io: SimpleBalanceIo): ChannelAccount {
  return balancesOnlyAccount('raccoon', async (env) => {
    const values = await collectCreditBalances<RaccoonCredential, undefined>(env.accounts, undefined, {
      resolve: env.resolve,
      fetcher: env.fetcher,
      fetchBalance: (credential) => fetchRaccoonCreditBalance(RACCOON, credential, env.fetcher),
      warn: env.warn,
    })
    return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
  })
}

/**
 * minimax（原分支 :3447-3462 逐字照抄 + **补 fetcher 第二参**）。
 *
 * 余额来自 `GET /minimax-cloud/api/v1/credit/details`。
 *
 * ⚠️ **该端点是平铺响应**（`total_count` 与 `base_resp` 同级、**没有
 * `data` 键**）—— 与签到端点不同。`fetchMinimaxCreditBalance` 内部已
 * 用 `unwrapEnvelopeData` 兼容两种形状。
 * ⚠️ 查不到时（null）由 helper 统一补「余额查询失败」文案，卡片显示
 * 原因而非 0 —— 这与「余额为 0」是**两回事**，不能混为一谈
 *（本机实测 `total_count: 0` 且 `details` 缺失正是「真的为 0」）。
 *
 * ⚠️ **补第二参 `env.fetcher`**：原分支 :3458 只传 1 参 ⇒
 *   `minimax-credits.ts:461` 落进隐式全局 `fetch`（无 abort、无出口绑定）。
 */
function minimaxBalanceAccount(): ChannelAccount {
  return balancesOnlyAccount('minimax', async (env) => {
    const values = await collectCreditBalances<MinimaxCredential, undefined>(env.accounts, undefined, {
      resolve: env.resolve,
      fetcher: env.fetcher,
      fetchBalance: (credential) => fetchMinimaxCreditBalance(credential, env.fetcher),
      warn: env.warn,
    })
    return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
  })
}

/**
 * qoder 族（原分支 :3352-3364 逐字照抄）。
 *
 * 余额来自 `GET {product.openApiBase}/sash/api/v2/me/usage`（实测只需
 * Bearer + Cosy-ClientType，**不需要**模型列表那样的 WASM 签名）。
 * 2026-11-06「学 magpie 架构」：逐账号编排交给 collectCreditBalances，
 * 渠道只提供 fetchBalance 实现（product 由本分支闭包传入）。
 *
 * ⚠️ **product 来自 `io.qoderFamily`**（原分支 :3353 的
 *   `requireQoderFamily(req.provider)`），国际版 `qoder` 与中国版
 *   `qodercn` **共享这份实现、但 id 不同**。
 */
function qoderFamilyBalanceAccount(product: QoderProduct): ChannelAccount {
  return balancesOnlyAccount(product.id, async (env) => {
    const values = await collectCreditBalances<QoderCredential, QoderProduct>(env.accounts, product, {
      resolve: env.resolve,
      fetcher: env.fetcher,
      fetchBalance: (credential, p) => fetchQoderCreditBalance(credential, p, env.fetcher),
      warn: env.warn,
    })
    return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
  })
}

/**
 * cline（原分支 :3591-3609 逐字照抄）。
 *
 * 余额来自 `GET /api/v1/users/{accountId}/balance`（实测
 * `{data:{userId, balance}, success:true}`）。
 * ⚠️ 账号 id 必须用凭据里的 `account_id`（`usr-…`），**不是** JWT 的
 * `sub`（`user_…`）—— 传后者实测返回 `400 Invalid request format`。
 * 2026-11-06「学 magpie 架构」：用 fetchBalanceDetailed 保留渠道自带的
 * 具体原因（含 HTTP 状态码与错误体摘要），编排交给通用 helper。
 */
function clineBalanceAccount(): ChannelAccount {
  return balancesOnlyAccount('cline', async (env) => {
    const values = await collectCreditBalances<ClineCredential, typeof CLINE>(env.accounts, CLINE, {
      resolve: env.resolve,
      fetcher: env.fetcher,
      fetchBalanceDetailed: async (credential, product) => {
        const result = await fetchClineCreditBalance(credential, product, env.fetcher, { signal: env.signal })
        return result.balance === null
          ? { balance: null, error: result.error ?? '积分查询失败（凭据失效或响应异常）' }
          : { balance: result.balance }
      },
      warn: env.warn,
    })
    return { ok: true, value: { accounts: values } satisfies RpcCreditsBalancesResponse }
  })
}

/**
 * 造出 balances 简单组的全部 ChannelAccount。
 *
 * 返回 **7 个**对象 / **6 份**实现体：qoder 族两个 key（`qoder` / `qodercn`）
 * 共享同一份实现（`qoderFamilyBalanceAccount`），但 id 不同 —— 两处判据都是
 * `isQoderFamily(req.provider)`，注册表必须**两个都登记**（定稿 §2.2b）。
 *
 * ⚠️ 若 `io.qoderFamily` 为空，则 qoder 族**不登记** ⇒ 分派层落回原
 *   switch 分支（:3352-3364），行为与迁移前一致，不会静默丢能力。
 */
export function makeSimpleBalanceAccounts(io: SimpleBalanceIo): ChannelAccount[] {
  const accounts: ChannelAccount[] = [
    opencodeBalanceAccount(),
    loomyBalanceAccount(io),
    raccoonBalanceAccount(io),
    minimaxBalanceAccount(),
    clineBalanceAccount(),
  ]
  // qoder 族：每个同族成员一个 key（`qoder` / `qodercn`），实现体共享。
  for (const member of io.qoderFamily) {
    accounts.push(qoderFamilyBalanceAccount(member.product))
  }
  return accounts
}
