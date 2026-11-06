/**
 * 渠道账户资产注册表（2026-11-06「学 magpie 架构」纵切）。
 *
 * 阶段 0 骨架：返回空表，三个 case 的 early-return 永远不命中，
 * 用于验证「两套路径并存、未迁移行为零变化」的机制本身。
 * 后续阶段按 (provider, method) 逐项往 entries 里追加实现。
 *
 * ★ 工厂全、env 瘦：pool / auth 实例 / qoderFamily / 内部函数等上下文
 *   由本工厂在装配期闭包捕获，不进 ChannelAccountEnv。
 */

import type { AccountPool } from '../account-pool.js'
import type {
  ChannelAccount,
  ChannelAccountRegistry,
} from '../channel-account.js'

/** 装配期注入的渠道上下文；按阶段逐项补字段（阶段 0 仅 pool）。 */
export interface RegistryIo {
  readonly pool: AccountPool
}

/**
 * 在 registerChannelPackEndpoints 内、dispatchMethod 之外调用一次，
 * 返回冻结的只读表。entries 为空时即 OPT-IN 全关（阶段 0）。
 */
export function buildChannelAccountRegistry(
  _io: RegistryIo,
): ChannelAccountRegistry {
  const entries: ChannelAccount[] = [
    // 阶段 1 起逐项追加；每家只捕获自己需要的 io 字段。
  ]
  return new Map(entries.map((account) => [account.id, Object.freeze(account)]))
}
