import type { AccountPool } from './account-pool.js'
import type { ProviderAccountEntry } from './types.js'
import { REFRESH_LEAD_MS } from './refresh.js'

/**
 * 「续期成功但落盘失败」的终态信号。
 *
 * 与网络/凭据异常严格区分：refresh_token 是一次性轮换的，续期成功即旧值作废，
 * 落盘失败后**任何重试都不可能成功** —— 账号已进入「需重新登录」终态。
 * 调用方据此把它与「网络抖动（可重试）」走不同的日志与账号标记分支
 * （2026-10-31 审查 P2-1：此前混为一谈，用户被误导去等一个不存在的重试）。
 */
export class SaveFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SaveFailedError'
  }
}

/**
 * 账号池「有效期」的共享回写与 lead-time 判据。
 *
 * ## 为什么需要这个模块（issue !IKIRTT 的真实缺陷）
 *
 * UI 账号卡片的「有效期：已过期」读的是**账号池的 `expiresAt`**
 * （`plugin-src/client/channel-pack.js` 的 `account.expiresAt <= Date.now()`），
 * 而不是凭据里 access_token 的真实 `exp`。于是只要凭据被更新过而**索引没跟上**，
 * 就会出现「显示已过期、但发消息完全正常」的数据源分叉。
 *
 * 这条分叉有两条产生路径，都真实发生过：
 *
 * 1. **按需续期不回写**：`refreshAccountCredential`（RPC `account.refresh` 走的
 *    路径）原先只有 raccoon 记得 `pool.updateAccount({ expiresAt })`，
 *    其余七个 provider 只 `credentials.set` —— 续期成功了、凭据换新了，
 *    UI 却纹丝不动，且没有任何自救手段（「重测」按钮的 refresh 是刻意的 no-op）。
 * 2. **定时器首轮要等满一个周期**：`src/index.ts` 的多账号续期只有 `setInterval`、
 *    没有启动时首轮，短寿命 provider（cline 1h / codearts 2h / raccoon 3h）
 *    在宿主关闭期间到期后，最长要等 30 分钟才第一次被处理。
 *
 * 本模块把 raccoon 已经验证过的写法抽成一份实现，让九个 provider 共用 ——
 * 与 AGENTS.md「差异收敛到产品配置、缺陷只修一遍」的一贯做法一致。
 */

/** 池内条目的现值（用于「变了才写盘」的短路）。 */
export interface ExpiryCurrentValue {
  expiresAt?: number
  refreshable?: boolean
}

/**
 * 回写有效期所需的**最小**账号池能力。
 *
 * 刻意不依赖整个 `AccountPool` 类：本模块只做「反查 + 打补丁」两件事，
 * 与账号池的缓存、落盘、模型黑名单等无关。收窄到接口也让单测可以直接
 * 传一个结构替身，而不必先构造真池。
 */
export interface ExpirySyncPool {
  updateAccount(
    id: string,
    patch: Partial<Pick<ProviderAccountEntry, 'expiresAt' | 'refreshable'>>,
  ): Promise<void>
  findAccountIdByCredential(provider: string, identity: string): Promise<string>
}

/** 从各家凭据取过期信息的能力（各 provider 凭据类型不同，故以提取器注入）。 */
export interface ExpiryAccessors<TCredential> {
  /** access_token 的过期时刻（毫秒）；`undefined` 表示凭据里读不到。 */
  expiresAtOf: (credential: TCredential) => number | undefined
  /**
   * 凭据是否仍可续期。
   *
   * ⚠️ **不提供时只同步 `expiresAt`、绝不碰 `refreshable`**。Loomy 必须走这条：
   * 它的 `isLoomyRefreshable` **恒为 `false`**（服务端没有任何 refresh 端点，
   * 这是诚实标记），若让共享实现据此把池里写 `false`，反而会把账号池改成
   * 与该产品实际行为不符的状态。
   */
  refreshableOf?: (credential: TCredential) => boolean
  /**
   * `AccountPool.findAccountIdByCredential` 的凭据身份。
   *
   * ⚠️ 该参数的语义是「**凭据内容**」（通常是 access_token）而**不是 ref 名**，
   * 传 ref 名会恒匹配失败且**静默无报错**（raccoon 踩过，见其方法注释）。
   */
  identityOf: (credential: TCredential) => string
}

/** 容差：毫秒时间戳来自 JWT 的秒级 `exp`，换算后可能有 1 秒内的舍入。 */
const EXPIRY_TOLERANCE_MS = 1000

/**
 * 本轮是否需要为该凭据发一次续期请求（lead-time 语义）。
 *
 * 与单凭据时代 `computeFirstRefreshDelayMs` 的 `expiresAt - now <= REFRESH_LEAD_MS`
 * 同一判据：**距过期不足 1 小时（或已过期、或读不到过期时间）才刷**。
 *
 * ## 为什么判据用**凭据的**过期时间而不是账号池的 `expiresAt`
 *
 * 池值正是本缺陷里可能陈旧的那份数据（按需续期不回写、老版本从未回写）。
 * 拿它当判据会让「凭据其实快过期」的账号被跳过；而凭据本体是权威值，
 * 读它只是一次本地存储访问，不花网络也不花模型额度。
 *
 * @param expiresAtMs 凭据 access_token 的过期时刻；`undefined` 一律视为需要刷。
 */
export function shouldRefreshNow(expiresAtMs: number | undefined, nowMs = Date.now()): boolean {
  if (expiresAtMs === undefined || !Number.isFinite(expiresAtMs)) return true
  return expiresAtMs - nowMs <= REFRESH_LEAD_MS
}

/**
 * 把凭据的过期信息同步回账号池（UI 读的就是这里）。
 *
 * 三条从 raccoon 既有实现继承下来的硬规矩，改动时必须保持：
 *
 * 1. **失败只记日志、绝不上抛**：调用点是「凭据已经续期成功」之后，
 *    此时因为写索引失败而报错，会让用户以为续期失败、甚至触发无谓的重新登录。
 *    索引是展示层数据，不该反噬凭据本身。
 * 2. **优先用调用方给的 `accountId`**：`refreshAll` 手里本来就有 entry，
 *    无需反查；只有在缺失时才退化为按凭据身份遍历账号池比对。
 * 3. **现值一致时不写盘**：账号列表是整体落盘的，否则定时器每 30 分钟
 *    会把 39 条记录全量重写一遍，白耗 I/O。
 *
 * ⚠️ `expiresAt` 取不到时**不覆盖**池内旧值：`updateAccount` 做的是
 * `{ ...entry, ...patch }`，把字段写成 `undefined` 后落盘会被 `JSON.stringify`
 * 整个丢弃，UI 于是显示「未知」—— 保留旧信息比抹掉它更有价值。
 */
export async function syncAccountExpiry<TCredential>(params: {
  /** 账号池；未提供时静默跳过（兼容不传 pool 的既有调用方）。 */
  pool: ExpirySyncPool | undefined
  /** 账号池里该 provider 的 id，如 `'cline'` / `'codearts'`。 */
  provider: string
  /** 已从凭据算好的过期信息。 */
  credential: TCredential
  accessors: ExpiryAccessors<TCredential>
  /** 调用方已知的账号 id；缺失时按凭据身份反查。 */
  accountId?: string
  /** 池内现值，提供时启用「变了才写盘」短路。 */
  current?: ExpiryCurrentValue
  /** 日志前缀，如 `'[cline]'`。 */
  tag: string
  warn?: (message: string) => void
}): Promise<void> {
  const { pool, provider, credential, accessors, accountId, current, tag } = params
  if (pool === undefined) return
  try {
    let id = accountId
    if (id === undefined || id.length === 0) {
      id = await pool.findAccountIdByCredential(provider, accessors.identityOf(credential))
    }
    if (id === undefined || id.length === 0) return

    const expiresAt = accessors.expiresAtOf(credential)
    const refreshable = accessors.refreshableOf?.(credential)
    if (expiresAt === undefined && refreshable === undefined) return
    const expiryChanged = expiresAt !== undefined
      && (current?.expiresAt === undefined
        || Math.abs(current.expiresAt - expiresAt) > EXPIRY_TOLERANCE_MS)
    const refreshableChanged = refreshable !== undefined
      && (current === undefined || current.refreshable !== refreshable)
    if (!expiryChanged && !refreshableChanged) return

    await pool.updateAccount(id, {
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(refreshable === undefined ? {} : { refreshable }),
    })
  } catch (error) {
    params.warn?.(
      `${tag} 凭据处理成功但回写账号池的有效期失败（不影响使用）：`
      + `${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * `refreshAll` 的单账号编排：需要刷就刷、不需要就把池值对账。
 *
 * 「不需要续期」的分支**不是**一句 `continue` 就完事 —— 存量账号的凭据早已在
 * 别处（IDE / 上一轮定时续期）续好了，只有池里还是旧值；若跳过时对账缺失，
 * UI 会**永远**显示「已过期」，正是本 issue 里最难自愈的那一半。
 *
 * @returns 是否真的发了一次续期请求（供调用方计数/日志）。
 */
export async function refreshAccountWithReconcile<TCredential>(params: {
  pool: ExpirySyncPool
  provider: string
  tag: string
  accountId: string
  credential: TCredential
  accessors: ExpiryAccessors<TCredential>
  /** 池内现值（通常就是 `entry` 本身）。 */
  current?: ExpiryCurrentValue
  /** 执行真正的续期并**落盘凭据**；失败应抛错。 */
  refresh: (credential: TCredential) => Promise<TCredential>
  /** 续期成功后写回凭据存储。 */
  save: (credential: TCredential) => Promise<void>
  warn?: (message: string) => void
  info?: (message: string) => void
}): Promise<boolean> {
  const { pool, provider, tag, accountId, credential, accessors, current, refresh, save } = params
  const expiresAt = accessors.expiresAtOf(credential)

  if (!shouldRefreshNow(expiresAt)) {
    // 凭据仍在有效期内：只把池值对账，不发请求。
    await syncAccountExpiry({
      pool,
      provider,
      credential,
      accessors,
      accountId,
      current,
      tag,
      warn: params.warn,
    })
    return false
  }

  const refreshed = await refresh(credential)
  // ⚠️ 续期响应缺访问令牌时**绝不能**把 `undefined` 落盘：那会把一份好凭据
  // 覆盖成 `"undefined"` 字符串，账号直接报废（只能重新登录）。
  if (refreshed === undefined) {
    throw new Error(`${tag} 续期响应缺少访问令牌，凭据未更新`)
  }
  // ⚠️⚠️ 落盘必须**独立 try** 且失败要走 error 级「需重新登录」措辞 —— 与
  // `ensureCredentialFresh` 的 ② 段是**同一条契约**：refresh_token 一次性轮换，
  // 续期成功即旧值作废，落盘失败后「重试续期」永远不可能成功。此前这句裸抛，
  // 调用方把异常当网络抖动记成「将按调度器策略重试」，用户会一直等一个
  // 永远不成功的重试（2026-10-31 审查 P2-1）。失败后把异常改写成
  // `SaveFailedError` 继续抛：调用方的终态分支（RefreshTokenExpiredError /
  // 不可续期标记）兜不住它，但能如实落进 catch 日志，而不是伪装成网络问题。
  try {
    await save(refreshed)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    params.warn?.(`${tag} 账号 ${accountId} 续期已成功但**落盘失败**（一次性 refresh_token 已被上游消费，需重新登录）: ${detail}`)
    throw new SaveFailedError(`${tag} 账号 ${accountId} 续期后落盘失败: ${detail}`)
  }
  await syncAccountExpiry({
    pool,
    provider,
    credential: refreshed,
    accessors,
    accountId,
    current,
    tag,
    warn: params.warn,
  })
  params.info?.(`${tag} 账号 ${accountId} 已续期`)
  return true
}

/**
 * 「用时续期」所需的最小账号池能力。
 *
 * ⚠⚠ **`listAccountsByProvider` 必须是同步的。**
 *
 * `AccountPool.listAccounts` 是 `async`（它要逐个 `credentials.describe` 才拼得出
 * `ProviderAccountStatus`），返回 Promise；对它做 `.find(...)` 或 `for...of`
 * 会当场抛 `TypeError`。2026-10-30 的事故就是把它当同步用：
 * 续期成功后、落盘前抛错 ⇒ 上游已消费掉一次性 refresh_token，本地却仍留着
 * 旧值 ⇒ 续期链被打死，只能重新登录（用户原话：「你把 officeace 的续期彻底玩坏了」）。
 *
 * 这里把类型收窄成同步方法，**编译期**就能挡住同类误用（`vendor/` 不在
 * `tsc` 的 include 里，所以这条约束靠本模块的类型签名 + 单测来守）。
 */
export interface FreshnessPool {
  listAccountsByProvider(provider: string): ReadonlyArray<{
    id: string
    credentialRef: string
    expiresAt?: number
  }>
  updateAccount(id: string, patch: { expiresAt?: number }): Promise<void>
}

/** 续期一条凭据的日志出口（与 cordis 的 logger 形状对齐，便于注入替身）。 */
export interface FreshnessLog {
  info?: (message: string) => void
  warn?: (message: string) => void
  error?: (message: string) => void
}

/**
 * **用时续期**：取凭据之前判一次，临期或已过期就先续，续完再返回。
 *
 * ## 为什么光有定时器不够
 * OfficeAce 的 STS 寿命约 **2 小时**（AutoClaw 约 5.7 小时），而定时器是
 * 「每 30 分钟检查一次、距过期不足 1 小时才续」（{@link REFRESH_LEAD_MS}）。
 * 于是这些窗口必然过期：DSH 关闭 / 重启期间、重启后第一轮还没跑到的空档、
 * 机器休眠醒来后（定时器被挂起）。过期期间签到 / 余额 / 倍率全部
 * `APIG.0602 security token has expired`，用户看到的就是「老是凭证过期」。
 *
 * ## 顺序契约（**本函数最要紧的部分**）
 *
 * `refresh_token` 是**一次性轮换**的：上游在续期成功那一刻就把旧值消费掉了。
 * 所以「续期成功」之后**任何一步失败都不能挡住落盘**，否则磁盘上留下的是一枚
 * 已作废的 token —— 续期链当场死亡。本函数据此拆成三段，各自的失败策略不同：
 *
 * 1. **续期**（网络）：失败 ⇒ 告警并返回旧凭据，让上游错误按既有归因呈现；
 * 2. **落盘**（本地）：失败 ⇒ **error 级别**报出来（用户需要知道要重新登录），
 *    仍返回新凭据（内存里这份是好的，本次请求可用）；
 * 3. **记账**（展示层 `expiresAt`）：失败只告警，**绝不影响**已落盘的新凭据。
 *
 * 这三段刻意不共用一个 try —— 共用正是 2026-10-30 事故的成因。
 */
export async function ensureCredentialFresh<T extends { refresh_token?: string; expire_time?: number }>(params: {
  /** provider id（如 `'officeace'`），用于反查账号条目。 */
  providerId: string
  /** 单凭据场景的默认 ref（没有账号池条目时落到这里）。 */
  defaultCredentialRef: string
  credential: T
  /** 账号池条目 id；空串表示「不在池里」，走默认 ref。 */
  accountId: string
  /** 真正的续期；失败应抛错。 */
  refreshOne: (value: unknown) => Promise<unknown>
  /** 写回凭据存储。 */
  save: (ref: string, credential: T) => Promise<void>
  pool: FreshnessPool
  log?: FreshnessLog
  /** 日志前缀，如 `'officeace'`。 */
  tag: string
  /** 当前时刻（测试注入）。 */
  now?: number
}): Promise<T> {
  const { providerId, defaultCredentialRef, credential, accountId, refreshOne, save, pool, log, tag } = params
  if (typeof credential.refresh_token !== 'string' || credential.refresh_token === '') return credential
  const expiresAt = typeof credential.expire_time === 'number' ? credential.expire_time : undefined
  if (!shouldRefreshNow(expiresAt, params.now)) return credential

  // ① 续期
  let next: T
  try {
    next = await refreshOne(credential) as T
  } catch (error) {
    log?.warn?.(`[channel-pack] ${tag} 用时续期失败（继续用旧凭据）: ${describeError(error)}`)
    return credential
  }

  // 账号条目用**同步**方法查（见 FreshnessPool 的注释）；查不到只是记账降级，不影响落盘。
  // ⚠️⚠️ 这一步本身也**绝不能抛**：它夹在 ① 续期 与 ② 落盘 之间，而续期成功
  // 即意味着旧 refresh_token 已被上游消费 —— 这句若把异常冒出去，`save` 一次
  // 都不会执行，磁盘上留下死 token 且**日志 0 条**（2026-10-30 officeace 事故
  // 的同形态残留缝，2026-10-31 审查发现并实测复现）。失败 ⇒ 降级用默认 ref
  // 并告警，落盘照做：写错 ref 的代价是「凭据存进一份可发现的多余位置」，
  // 远小于整条续期链被打死。
  let entry: ReturnType<FreshnessPool['listAccountsByProvider']>[number] | undefined
  try {
    entry = accountId === '' ? undefined : pool.listAccountsByProvider(providerId).find((row) => row.id === accountId)
  } catch (error) {
    entry = undefined
    log?.warn?.(`[channel-pack] ${tag} 反查账号条目失败，凭据落盘降级到默认 ref: ${describeError(error)}`)
  }
  const targetRef = entry?.credentialRef ?? defaultCredentialRef

  // ② 落盘：紧跟续期，且不与任何其它步骤共用 try
  try {
    await save(targetRef, next)
  } catch (error) {
    log?.error?.(
      `[channel-pack] ${tag} 用时续期已成功但**落盘失败**（旧 refresh_token 已被上游消费，需重新登录）: ${describeError(error)}`,
    )
    return next
  }
  log?.info?.(`[channel-pack] ${tag} 用时续期成功（新到期 ${new Date(next.expire_time ?? 0).toISOString()}）`)

  // ③ 记账：只喂 UI 徽标，出错不反噬凭据
  try {
    if (entry !== undefined) {
      const nextExpiry = typeof next.expire_time === 'number' ? next.expire_time : undefined
      if (nextExpiry !== undefined && nextExpiry !== entry.expiresAt) {
        await pool.updateAccount(entry.id, { expiresAt: nextExpiry })
      }
    }
  } catch (error) {
    log?.warn?.(`[channel-pack] ${tag} 续期成功但回写账号池有效期失败（不影响使用）: ${describeError(error)}`)
  }
  return next
}

/** 异常转一行文案（日志用；不吞栈，因为这里只做单行摘要）。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
