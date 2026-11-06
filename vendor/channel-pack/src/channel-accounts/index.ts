/**
 * 渠道账户资产注册表（2026-11-06「学 magpie 架构」纵切）。
 *
 * 阶段 1：注册 6 个零网络常量组合（3 status 无能力 + 3 claim 纯错），
 * 第一次让三 case 的 early-return 真正命中；其余组合继续落原 if 链。
 * 后续阶段按 (provider, method) 逐项追加实现。
 *
 * ★ 工厂全、env 瘦：pool / auth 实例 / qoderFamily / 内部函数等上下文
 *   由本工厂在装配期闭包捕获，不进 ChannelAccountEnv。
 */

import type { AccountPool } from '../account-pool.js'
import type {
  ChannelAccount,
  ChannelAccountEnv,
  ChannelAccountRegistry,
  CreditsResult,
  CreditsStatusOutcome,
} from '../channel-account.js'
import { nullStatusAccounts } from '../channel-account.js'
import type { RpcCreditsClaimAllResponse } from '../types.js'

/** 装配期注入的渠道上下文；按阶段逐项补字段（阶段 0/1 仅 pool）。 */
export interface RegistryIo {
  readonly pool: AccountPool
}

/** 阶段 1-R0：渠道无独立签到状态端点 → ok:true + 逐账号 status:null。 */
function nullStatusCapabilityAccount(id: string): ChannelAccount {
  return Object.freeze({
    id,
    async status(env: ChannelAccountEnv): Promise<CreditsStatusOutcome> {
      return { kind: 'no-status-capability', accounts: nullStatusAccounts(env.accounts) }
    },
  })
}

/** 阶段 1-R0：渠道不支持每日签到 → 可读 bad-request（文案逐字照抄原分支）。 */
function badRequestClaimAccount(id: string, message: string): ChannelAccount {
  return Object.freeze({
    id,
    async claim(_env: ChannelAccountEnv): Promise<CreditsResult<RpcCreditsClaimAllResponse>> {
      return { ok: false, error: { code: 'bad-request', message } }
    },
  })
}

/**
 * 在 registerChannelPackEndpoints 内、dispatchMethod 之外调用一次，
 * 返回冻结的只读表。未在此登记的 (provider, method) 落原 switch 分支。
 */
export function buildChannelAccountRegistry(
  _io: RegistryIo,
): ChannelAccountRegistry {
  // ★ 同一 provider 的多个方法必须合并进**同一个** ChannelAccount 对象：
  //   Map 以 id 为 key，两个同 id 对象后者会覆盖前者（阶段 1 的 cline 就同时
  //   有 status 与 claim）。按 id 分组后再合并方法。
  const byId = new Map<string, ChannelAccount>()
  const add = (account: ChannelAccount) => {
    const prev = byId.get(account.id)
    byId.set(account.id, Object.freeze(prev === undefined ? account : { ...prev, ...account }))
  }

  // ── 阶段 1：R0 零网络纯常量 ──────────────────────────────────────
  // status × codearts / trae / cline：三段同构 map 收敛到 nullStatusAccounts
  add(nullStatusCapabilityAccount('codearts'))
  add(nullStatusCapabilityAccount('trae'))
  add(nullStatusCapabilityAccount('cline'))
  // claim × cline / workbuddy / raccoon：纯错误守卫（workbuddy 必须早于
  // productById 兜底，否则会用国际版凭据打国内版签到请求）
  add(badRequestClaimAccount('cline', 'Cline 不支持每日签到（其后端没有签到接口）'))
  add(badRequestClaimAccount('workbuddy', 'WorkBuddy 国际版不支持每日签到（其后端没有签到接口）'))
  add(badRequestClaimAccount('raccoon', 'Raccoon Work 不支持每日签到（积分由服务端自动发放，奖励见「新手任务」）'))
  // 阶段 2 起逐项 add；每家只捕获自己需要的 io 字段。

  return new Map([...byId].map(([id, account]) => [id, Object.freeze(account)]))
}
