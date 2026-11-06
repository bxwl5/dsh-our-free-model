/**
 * ========================================
 * 渠道账户资产接口（2026-11-06「学 magpie 架构」纵切）
 * ========================================
 *
 * magpie 是「一个渠道一个包，模型/对话/余额/积分/签到全在里面」；
 * 本仓库此前按 RPC 方法横切（credits.status / claimAll / balances 三个
 * case 内部各自按 provider switch），同一渠道的账户资产被拆到三处。
 *
 * 本文件定义接口与「线上信封」类型，不含任何渠道实现：
 * - 装配层（dispatchMethod 的三个 case）构造 ChannelAccountEnv 并查表；
 * - 注册表实现复用 collectCreditsStatus / collectClaimResults /
 *   collectCreditBalances 三个通用编排 helper（共享 CreditsEndpointDeps）。
 *
 * ★ 贯穿全局的硬约束（团队 t1/t2/t3 + 定稿）：
 * 1. env.fetcher 必传、无默认值 —— 唯一来源是每个 RPC 现建的
 *    codeartsFetcher（channel-pack-rpc.ts:1519-1527，绑 signal 取消级联）。
 *    绝不在本模块/注册表里另建传输函数或退回全局默认出口。
 * 2. status:null 有「渠道无此能力 / 单账号查询失败 / bad-request /
 *    前端根本不发」四层语义，接口层用 CreditsStatusOutcome.kind 显式分开。
 * 3. 三方法都可选：缺席 = 该 (provider, method) 尚未迁移，分派层落原
 *    switch 分支；「渠道无此能力」由已迁移方法的 outcome 表达，不是方法缺席。
 */

import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {
  ProviderAccountEntry,
  RpcCreditsAccountStatus,
  RpcCreditsStatusResponse,
  RpcCreditsClaimAllResponse,
  RpcCreditsBalancesResponse,
} from './types.js'

/** 线上 RPC 信封；形状与 reply() / handleMethod() 完全一致。 */
export type CreditsResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } }

/**
 * credits.status 的内部返回 —— 四层语义显式分列，禁止把任何一种压成
 * 「一个 status:null」（见文件头约束 2）。
 * - no-status-capability：渠道无独立签到状态端点，ok:true + 逐账号 null；
 * - queried：真查，其中 accounts 里的 status:null 是单账号查询失败；
 * - bad-request：已知但不在 productById 白名单的 provider，不是 null。
 * （前端守卫拦下、根本不发 RPC 的情形不进后端方法。）
 */
export type CreditsStatusOutcome =
  | { kind: 'no-status-capability'; accounts: readonly RpcCreditsAccountStatus[] }
  | { kind: 'queried'; accounts: readonly RpcCreditsAccountStatus[] }
  | { kind: 'bad-request'; message: string }

/** 「渠道无此能力」的唯一构造入口：codearts/TRAE/CLINE 三段同构 map 收敛到此。 */
export function nullStatusAccounts(
  accounts: readonly ProviderAccountEntry[],
): RpcCreditsAccountStatus[] {
  return accounts.map((entry) => ({
    accountId: entry.id, nickname: entry.nickname, status: null,
  }))
}

/** 装配层把 outcome 翻成线上信封；no-status-capability 与 queried 都是 ok:true。 */
export function toStatusEnvelope(
  outcome: CreditsStatusOutcome,
): CreditsResult<RpcCreditsStatusResponse> {
  return outcome.kind === 'bad-request'
    ? { ok: false, error: { code: 'bad-request', message: outcome.message } }
    : { ok: true, value: { accounts: [...outcome.accounts] } }
}

/**
 * 每次 RPC 现建的调用环境（装配层 = dispatchMethod 的三个 case）。
 *
 * ★ fetcher 必传、无 `?? fetch` 兜底、无默认：它必须是 :1519-1527 的
 *   codeartsFetcher（绑定本 RPC signal 的取消级联）。
 * ★ 渠道特有 auth 实例 / pool / qoderFamily 一律不进 env：由
 *   buildChannelAccountRegistry() 在装配期闭包捕获（工厂全、env 瘦）。
 */
export interface ChannelAccountEnv {
  readonly provider: string
  readonly accounts: readonly ProviderAccountEntry[]
  readonly resolve: (ref: CredentialRef) => Promise<{ value: string } | undefined>
  readonly warn?: (message: string) => void
  /** ★ 必传：每 RPC 现建的 codeartsFetcher（signal/出口级联）。 */
  readonly fetcher: typeof fetch
  readonly signal?: AbortSignal
  /** credits.balances 的 req.force，仅 antigravity 读。 */
  readonly force?: boolean
}

/** 一个 provider 在三个积分 case 上的行为集合；三方法都可选（见文件头约束 3）。 */
export interface ChannelAccount {
  readonly id: string
  status?(env: ChannelAccountEnv): Promise<CreditsStatusOutcome>
  claim?(env: ChannelAccountEnv): Promise<CreditsResult<RpcCreditsClaimAllResponse>>
  balances?(env: ChannelAccountEnv): Promise<CreditsResult<RpcCreditsBalancesResponse>>
}

/** 只读注册表：装配期构建一次，运行期禁止增删（防并发 RPC 互相改表）。 */
export type ChannelAccountRegistry = ReadonlyMap<string, ChannelAccount>

/** 空注册表（阶段 0 骨架用；此时三 case 的 early-return 永远不命中）。 */
export const EMPTY_CHANNEL_ACCOUNT_REGISTRY: ChannelAccountRegistry =
  new Map<string, ChannelAccount>()
