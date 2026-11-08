/**
 * ========================================
 * status 真查组 + claim 组渠道账户实现（2026-11-06「学 magpie 架构」纵切 阶段 2-3）
 * ========================================
 *
 * 本文件是**独立实现文件**：只导出 makeStatusClaimAccounts(io)，由装配层
 * （channel-accounts/index.ts 的 add()）按 id 合并进只读注册表。不改任何现有
 * 文件、不碰 channel-pack-rpc.ts 的三个 case。
 *
 * 覆盖：
 *   status 真查：minimax、buddy / workbuddy 兜底（productById 白名单）
 *   claim：      buddy 兜底、minimax、autoclaw、officeace、qoder / qodercn、
 *               codearts、trae
 *   ⚠️ ZCODE claim **不迁**（阶段 4 明确不迁；原分支 :3231-3297 保留）。
 *   ⚠️ codearts / trae 的 status 与 workbuddy 的 claim 由阶段 1 的 R0 账户保留
 *      （nullStatusCapabilityAccount / badRequestClaimAccount），本文件不覆盖，
 *      否则 workbuddy 会用国际版凭据打国内版签到（index.ts:69-72 的真实缺陷）。
 *
 * ★ fetcher 硬约束（channel-account.ts 文件头约束 1）：一切上游请求只能走
 *   env.fetcher（每次 RPC 现建、绑 signal 取消级联的 codeartsFetcher），
 *   绝不在本文件里退回全局默认出口。原分支里不带传输实参、或漏传
 *   fetcher 的调用点，迁入时一律补 env.fetcher：
 *     - status/minimax、claim/minimax、claim/qoder：补第二/第三参；
 *     - claim/codearts：claimCodeArtsDailyCheckin 的第二参漏传会破坏取消级联；
 *     - claim/trae：两处裸默认传输换 env.fetcher；
 *     - claim/autoclaw、claim/officeace：claim 钩子覆盖后 deps.fetcher 是**死参数**，
 *       钩子内部必须**显式**再传一次 env.fetcher。
 *
 * ★ 工厂全、env 瘦：pool（TRAE 设备代次）与 qoderFamily（Qoder 同族产品表）
 *   由 io 在装配期闭包捕获；accounts / resolve / warn / fetcher / provider
 *   一律取 ChannelAccountEnv（装配层已 listAccounts 填好 env.accounts）。
 *
 * 照抄来源（channel-pack-rpc.ts 行号）：
 *   credits.status    minimax      :3002-3018（判据注释 :3008-3009 原样）
 *   credits.status    buddy 兜底    :3020-3029
 *   credits.claimAll  autoclaw     :3040-3075
 *   credits.claimAll  officeace    :3077-3106
 *   credits.claimAll  qoder 族     :3108-3122（:3109 requireQoderFamily → io.qoderFamily）
 *   credits.claimAll  codearts     :3124-3135
 *   credits.claimAll  trae         :3137-3160
 *   credits.claimAll  minimax      :3214-3229
 *   credits.claimAll  buddy 兜底    :3298-3306
 *   helper 契约                   :478-538 / :551-584 / :596-667
 */

import type { AccountPool } from '../account-pool.js'
import type {
  ChannelAccount,
  ChannelAccountEnv,
  CreditsResult,
  CreditsStatusOutcome,
} from '../channel-account.js'
import type { CodeArtsCredential, RpcCreditsClaimAllResponse } from '../types.js'
import type { QoderProduct } from '../qoder-product.js'
import type { MinimaxCredential } from '../minimax.js'
import type { AutoClawCredential } from '../autoclaw.js'
import type { OfficeAceCredential } from '../officeace.js'
import type { QoderCredential } from '../qoder.js'
import type { TraeCredential } from '../trae.js'
import { collectCreditsStatus, collectClaimResults } from '../credits-helpers.js'
import { productById } from '../product.js'
import { MINIMAX } from '../minimax-product.js'
import { TRAE } from '../trae-product.js'
import {
  claimCodeArtsDailyCheckin,
} from '../codearts-credits.js'
import {
  claimMinimaxDailyCheckin,
  fetchMinimaxSigninStatus,
} from '../minimax-credits.js'
import { claimQoderDailyCheckin } from '../qoder-credits.js'
import {
  claimTraeDailyCheckin,
  fetchTraeCheckinStatus,
} from '../trae-credits.js'

/** Qoder 同族成员的最小结构（rpc.ts:1026-1033 的 QoderFamilyMember 去掉 auth）。 */
export interface StatusClaimQoderFamilyMember {
  readonly product: QoderProduct
}

/**
 * 装配期注入的渠道上下文。两个字段都是 registerChannelPackEndpoints 内已有的
 * 局部变量，船长接线时把 `pool` 与 `qoderFamily` 原样传进来即可。
 */
export interface StatusClaimIo {
  /** 仅 TRAE claim 用：签到设备代次的读 / 写（rpc.ts:3155-3156）。 */
  readonly pool: Pick<
    AccountPool,
    'traeCheckinDeviceGenerationFor' | 'updateTraeCheckinDeviceGeneration'
  >
  /** 仅 qoder / qodercn claim 用：按 member.product.id 查同族产品（rpc.ts:1030-1033）。 */
  readonly qoderFamily: readonly StatusClaimQoderFamilyMember[]
}

// ── status 真查：minimax（照抄 :3002-3018）──────────────────────────────

/**
 * MiniMax **有**独立的签到状态端点（`/minimax-cloud/api/v1/signin/status`），
 * 与 LobsterAI/TRAE/Cline 那几个「如实返回 null」的 provider 不同 ——
 * 故走共享 helper 真查（`fetchMinimaxSigninStatus` 失败时返回 null，
 * 由 helper 逐账号 try/catch 兜住，单账号失败不中断整体）。
 *
 * ⚠️ **判据是 `is_today && status===3`**（见 `minimaxPanelToCheckinStatus`），
 * 不是「没有 Claimable」。`active` 恒 true（拿到响应即 true）。
 *
 * 纵切修复：`fetchMinimaxSigninStatus(credential, env.fetcher)` 补第二参；
 * 原 :3014 只传一参，退回全局默认出口、绕过本 RPC 的 signal 级联。
 */
async function minimaxStatus(env: ChannelAccountEnv): Promise<CreditsStatusOutcome> {
  const value = await collectCreditsStatus<MinimaxCredential, undefined>(
    env.accounts, undefined, {
      resolve: env.resolve,
      fetcher: env.fetcher,
      fetchStatus: (credential) => fetchMinimaxSigninStatus(credential, env.fetcher),
      warn: env.warn,
    },
  )
  // 真查结果由装配层 toStatusEnvelope 翻成 { ok:true, value:{accounts} }。
  return { kind: 'queried', accounts: value }
}

// ── status 真查：buddy 兜底（照抄 :3020-3029）──────────────────────────

/**
 * 原 :3020 兜底：只有 CodeBuddy 系能经 productById() 解析出产品配置
 * （ALL_PRODUCTS = [CODEBUDDY, WORKBUDDY]），其余 provider 一律 bad-request。
 * 纵切修复：补 `fetcher: env.fetcher` —— 原 :3025 未传，collectCreditsStatus
 * 的默认 fetchCheckinStatus 因此退回全局默认出口。
 */
async function buddyFallbackStatus(env: ChannelAccountEnv): Promise<CreditsStatusOutcome> {
  const product = productById(env.provider)
  if (product === undefined) {
    return { kind: 'bad-request', message: `unsupported provider: ${env.provider}` }
  }
  const results = await collectCreditsStatus(env.accounts, product, {
    resolve: env.resolve,
    // 不传 fetchStatus → 用默认 fetchCheckinStatus（显式包装把 fetcher 送进第三参）
    fetcher: env.fetcher,
    warn: env.warn,
  })
  return { kind: 'queried', accounts: results }
}

// ── claim：buddy 兜底（照抄 :3298-3306）───────────────────────────────

/**
 * 原 case 末尾兜底。⚠️ 只登记在 `buddy` 上：workbuddy 的 claim 必须保留 R0
 * bad-request（index.ts:72），否则落到 productById 拿到的 buddy 产品上，
 * 用国际版凭据发国内版签到请求（一次必然失败的真实上游请求）。
 *
 * precheckStatus：不传（默认 true）—— CodeBuddy 系拆成「查状态 + 领取」两步。
 */
async function buddyFallbackClaim(
  env: ChannelAccountEnv,
): Promise<CreditsResult<RpcCreditsClaimAllResponse>> {
  const product = productById(env.provider)
  if (product === undefined) {
    return {
      ok: false,
      error: { code: 'bad-request', message: `unsupported provider: ${env.provider}` },
    }
  }
  const value = await collectClaimResults(env.accounts, product, {
    resolve: env.resolve,
    // 纵切修复：原 :3302 未传 fetcher，默认 claimDailyCheckin / fetchCheckinStatus
    // 会退回全局默认出口；这里显式送 env.fetcher 保住取消级联。
    fetcher: env.fetcher,
    warn: env.warn,
  })
  return { ok: true, value }
}

// ── claim：MINIMAX（照抄 :3214-3229）──────────────────────────────────

/**
 * ⚠️ **必须开启状态预检**（`precheckStatus` 默认为 true，不要传 false）。
 *
 * 理由与 TRAE 那条同型（见下方 TRAE 分支的详细注释）：MiniMax 的
 * `claimMinimaxDailyCheckin` 靠响应体的 `claim_result` 判幂等
 *（`1`=真领取、`2`=已领过），这在 **HTTP 层**是可靠的；但状态预检是
 * 第二道防线 —— 若某天服务端对已领账号也回 `claim_result: 1`，
 * 预检能靠 `todayCheckedIn` 先挡住，避免把「今天已领」报成「+积分」。
 * 反之传 false 会让已签到账号走到 claim 请求（多发一次 POST）。
 *
 * 纵切修复：fetchStatus 与 claim 都补第二参 env.fetcher（原 :3225/:3226
 * 只传 credential，退回全局默认出口）。
 */
async function minimaxClaim(
  env: ChannelAccountEnv,
): Promise<CreditsResult<RpcCreditsClaimAllResponse>> {
  const value = await collectClaimResults<MinimaxCredential, undefined>(
    env.accounts, undefined, {
      resolve: env.resolve,
      fetcher: env.fetcher,
      fetchStatus: (credential) => fetchMinimaxSigninStatus(credential, env.fetcher),
      claim: (credential) => claimMinimaxDailyCheckin(credential, env.fetcher),
      warn: env.warn,
    },
  )
  return { ok: true, value }
}

// ── claim：AUTOCLAW（照抄 :3040-3075）────────────────────────────────

/**
 * AutoClaw 的签到是「完成客户端任务」通用入口的一个 task_id
 * （`autoclaw-task-complete` + `task_id=daily_signin`），走 userapi 域
 * 的官方客户端指纹签名头。上游按天幂等，且**成功判据是
 * body 里的 reward_points/success**，不能只看 HTTP 200。
 *
 * ★ deps.fetcher 只是给默认实现用的**死参数**（claim 被覆盖）；钩子内部
 *   `claimAutoclawDailyCheckin({ fetcher: env.fetcher })` 必须显式再传一次。
 * precheckStatus: false —— 上游一次调用即完成，外部再查一次纯属重复请求。
 */
async function autoclawClaim(
  env: ChannelAccountEnv,
): Promise<CreditsResult<RpcCreditsClaimAllResponse>> {
  // 与原分支同款动态 import，只把相对路径从 ./ 改成 ../（本文件在 channel-accounts/ 下）。
  const { claimAutoclawDailyCheckin } = await import('../autoclaw-sms.js')
  const { AUTOCLAW: AUTOCLAW_PRODUCT } = await import('../autoclaw-product.js')
  const value = await collectClaimResults<AutoClawCredential, typeof AUTOCLAW_PRODUCT>(
    env.accounts, AUTOCLAW_PRODUCT, {
      fetcher: env.fetcher,
      resolve: env.resolve,
      claim: async (credential) => {
        const outcome = await claimAutoclawDailyCheckin({
          product: AUTOCLAW_PRODUCT,
          fetcher: env.fetcher,
          credential,
        })
        // ⚠️ 必须返回 ClaimOutcome（带 kind），不是 {claimed,message}：
        // computeClaimSummary 按 kind 分类，缺 kind 会走 default 计成
        // failed 且 coversToday=0 —— auto-checkin 的 shouldMarkToday
        // 因此永不满足，每次启动都重跑一轮（2026-10-26 实测发现）。
        return outcome.claimed > 0
          ? { kind: 'claimed', credit: outcome.claimed, streakDays: 1, isStreakDay: true, message: outcome.message }
          // ⚠️ 上游「签到成功但没有积分数」返回 success=true 且 reward=0
          // （如当日已通过客户端完成任务），这是**真签到**，必须记成
          // claimed（credit 0），否则会被错判成 failed → 自动签到永远重跑。
          : /签到成功/.test(outcome.message)
            ? { kind: 'claimed', credit: 0, streakDays: 1, isStreakDay: true, message: outcome.message }
            : /已签到|已领/.test(outcome.message)
              ? { kind: 'already-claimed', message: outcome.message }
              : { kind: 'failed', code: -1, message: outcome.message }
      },
      precheckStatus: false,
      warn: env.warn,
    },
  )
  return { ok: true, value }
}

// ── claim：officeace（照抄 :3077-3106）───────────────────────────────

/**
 * OfficeAce 的签到：`POST {gateway}/v1/subscription/bonus/claim`（V11 签名）——
 * 上游一次调用把当天所有可领奖励（每日签到 + 一次性新人礼）一起发下来，
 * 幂等由上游保证，积分增量 = 领奖前后 remaining 之差。
 *
 * ★ deps.fetcher 是死参数（claim 被覆盖）；钩子内部
 *   `claimBonus(env.fetcher, OFFICEACE, credential)` 必须显式再传一次。
 * precheckStatus: false —— 没有独立的今日状态端点，外部预检会打错请求。
 */
async function officeaceClaim(
  env: ChannelAccountEnv,
): Promise<CreditsResult<RpcCreditsClaimAllResponse>> {
  const { claimBonus } = await import('../officeace.js')
  const { OFFICEACE } = await import('../officeace-product.js')
  const value = await collectClaimResults<OfficeAceCredential, typeof OFFICEACE>(
    env.accounts, OFFICEACE, {
      fetcher: env.fetcher,
      resolve: env.resolve,
      claim: async (credential) => {
        const outcome = await claimBonus(env.fetcher, OFFICEACE, credential)
        // 同 autoclaw：返回 ClaimOutcome（computeClaimSummary 按 kind 分类）。
        // ⚠️ `gained === undefined` 表示领前/领后余额读数没拿到（上游幂等、
        // 重复领不报错），claimBonus 如实回「已签到」—— 这是**已签过**，
        // 必须记成 already-claimed，而不是 failed（否则自动签到当天不重试、
        // 却又因为 coversToday=0 每次启动都重跑，2026-10-26 实测形态）。
        return outcome.gained === undefined
          ? { kind: 'already-claimed', message: outcome.message }
          : (outcome.gained ?? 0) > 0
            ? { kind: 'claimed', credit: outcome.gained ?? 0, streakDays: 1, isStreakDay: true, message: outcome.message }
            : /已领|没有可领/.test(outcome.message)
              ? { kind: 'already-claimed', message: outcome.message }
              : { kind: 'failed', code: -1, message: outcome.message }
      },
      precheckStatus: false,
      warn: env.warn,
    },
  )
  return { ok: true, value }
}

// ── claim：Qoder 同族（照抄 :3108-3122）──────────────────────────────

/**
 * Qoder 的领取流程**自带活动列表查询**（loadCampaigns → 逐个 claim），
 * 故 precheckStatus: false 跳过外部那次检查 —— 否则会重复发一次 GET
 * （与 LobsterAI 传 false 的理由同类）。
 *
 * ⚠️ Qoder 的幂等判据是响应体的 `replayed:true`（重复领取同样返回
 * HTTP 200），已在 claimQoderCampaign 内部处理。
 *
 * 纵切改动：原 :3109 `requireQoderFamily(req.provider)` 换成 io.qoderFamily
 * 按 product.id 查（qoder / qodercn 两个 id 共用本实现）；找不到时照抄
 * requireQoderFamily :1046 的抛错语义。泛型第二参数用 `typeof product`
 * （= QoderProduct）；原分支第二实参是 undefined，此处传同一 product，
 * 在 precheckStatus:false + 自定义 claim 钩子下该实参不被默认实现读取，
 * 行为等价。第三参补 env.fetcher（原 :3118 退回全局默认出口）。
 */
async function qoderFamilyClaim(
  io: StatusClaimIo,
  env: ChannelAccountEnv,
): Promise<CreditsResult<RpcCreditsClaimAllResponse>> {
  const member = io.qoderFamily.find((item) => item.product.id === env.provider)
  if (member === undefined) {
    throw new Error(`Unknown Qoder family provider: ${env.provider}`)
  }
  const { product } = member
  const value = await collectClaimResults<QoderCredential, typeof product>(
    env.accounts, product, {
      resolve: env.resolve,
      fetcher: env.fetcher,
      claim: (credential) => claimQoderDailyCheckin(credential, product, env.fetcher),
      precheckStatus: false,
      warn: env.warn,
    },
  )
  return { ok: true, value }
}

// ── claim：codearts（照抄 :3124-3135）────────────────────────────────

/**
 * CodeArts（华为云）走**签名**协议，与两个腾讯系 provider 都不同源：
 * 领取流程自带「账户类型 + 活动列表」预检（见 claimCodeArtsDailyCheckin），
 * 故 precheckStatus: false 跳过外部那次 CodeBuddy 式的状态查询 ——
 * 用 fetchCheckinStatus 打华为端点既发错请求又必然失败。
 *
 * ⚠️ `claimCodeArtsDailyCheckin(credential, env.fetcher)` 的第二参**漏传会
 * 破坏取消级联**（函数默认走全局默认出口，绕过本 RPC 的 signal），必须显式传。
 */
async function codeartsClaim(
  env: ChannelAccountEnv,
): Promise<CreditsResult<RpcCreditsClaimAllResponse>> {
  const value = await collectClaimResults<CodeArtsCredential, undefined>(
    env.accounts, undefined, {
      resolve: env.resolve,
      fetcher: env.fetcher,
      claim: (credential) => claimCodeArtsDailyCheckin(credential, env.fetcher),
      precheckStatus: false,
      warn: env.warn,
    },
  )
  return { ok: true, value }
}

// ── claim：TRAE（照抄 :3137-3160）────────────────────────────────────

/**
 * ⚠️ **必须开启状态预检**（`precheckStatus` 默认为 true，不要传 false）。
 *
 * TRAE 的 claim 对「今天已签到」是**幂等**的：实测重复领取同样返回
 * `{code:0, message:"success"}`，与真正领取成功**无法区分**。
 * 早期照抄 LobsterAI 传了 `precheckStatus: false`（那是「领取流程内部
 * 已做 slot/context 预检」的理由，TRAE 没有这回事），于是已签到的账号
 * 被报成「领取成功」（用户报障：显示成功但 +0 积分）。
 * 判据只能是 status 端点的 `checked_in`。
 *
 * 纵切改动：:3149/:3154 两处不带传输实参的调用换 `env.fetcher`；pool 的
 * traeCheckinDeviceGenerationFor / updateTraeCheckinDeviceGeneration 从 io.pool
 * 取；claim 第三参 `entry` **必须保留**（entry.id 用于取签到设备代次）。
 */
async function traeClaim(
  io: StatusClaimIo,
  env: ChannelAccountEnv,
): Promise<CreditsResult<RpcCreditsClaimAllResponse>> {
  const value = await collectClaimResults<TraeCredential, undefined>(
    env.accounts, undefined, {
      resolve: env.resolve,
      fetcher: env.fetcher,
      fetchStatus: (credential) =>
        fetchTraeCheckinStatus(credential as TraeCredential, TRAE, env.fetcher),
      claim: (credential, _product, entry) =>
        claimTraeDailyCheckin(
          credential as TraeCredential,
          TRAE,
          env.fetcher,
        ),
      warn: env.warn,
    },
  )
  return { ok: true, value }
}

/**
 * 阶段 2-3 的 status 真查组 + claim 组实现。
 *
 * 返回的 ChannelAccount[] 由 index.ts 的 add() 按 id 与阶段 1 的 R0 合并
 * （`{...prev, ...account}`）：codearts / trae 的 status 与 workbuddy 的 claim
 * 因此保持 R0 行为不变。装配层把 status 的 CreditsStatusOutcome 经
 * toStatusEnvelope 翻成线上信封；claim 直接返回 CreditsResult 信封。
 *
 * precheckStatus 取值（**按渠道取值，不可统一**）：
 *   buddy / minimax / trae —— 不传（默认 true，必须开预检）
 *   autoclaw / officeace / qoder / qodercn / codearts —— false
 */
export function makeStatusClaimAccounts(io: StatusClaimIo): ChannelAccount[] {
  // 2026-11-07 全码审查（t1-Q1）：qoder 族 claim 与 balances-simple 的空表口径对齐 ——
  // qoderFamily 为空（接线异常）时不登记 claim，分派层落原 if 链 → bad-request，
  // 而不是登记后由 find() 抛错把整轮 claimAll 炸成 handler-failed。
  const qoderFamilyReady = io.qoderFamily.length > 0
  return [
    Object.freeze({
      id: MINIMAX.id,
      status: minimaxStatus,
      claim: minimaxClaim,
    }),
    Object.freeze({
      id: 'buddy',
      status: buddyFallbackStatus,
      claim: buddyFallbackClaim,
    }),
    // ⚠️ 只带 status：workbuddy 的 claim 保留 R0 bad-request（不带 claim 字段）。
    Object.freeze({
      id: 'workbuddy',
      status: buddyFallbackStatus,
    }),
    Object.freeze({
      id: 'autoclaw',
      claim: autoclawClaim,
    }),
    Object.freeze({
      id: 'officeace',
      claim: officeaceClaim,
    }),
    ...(qoderFamilyReady ? [
      Object.freeze({
        id: 'qoder',
        claim: (env: ChannelAccountEnv) => qoderFamilyClaim(io, env),
      }),
      Object.freeze({
        id: 'qodercn',
        claim: (env: ChannelAccountEnv) => qoderFamilyClaim(io, env),
      }),
    ] : []),
    Object.freeze({
      id: 'codearts',
      claim: codeartsClaim,
    }),
    Object.freeze({
      id: TRAE.id,
      claim: (env: ChannelAccountEnv) => traeClaim(io, env),
    }),
  ]
}
