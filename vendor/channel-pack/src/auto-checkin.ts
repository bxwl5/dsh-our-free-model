/**
 * 「每日首次启动自动签到」—— 开关、当日记录与执行体。
 *
 * ## 它做什么
 *
 * DSH 启动后延迟一小段（默认 30 秒，见下），若这个开关开着、且**今天（UTC+8）
 * 还没跑过**，就串行遍历「账号池里真的有账号的渠道」，逐个调内部
 * `credits.claimAll`；跑完把日期与**逐渠道结果**写进文档 ⇒ **当天不再触发**。
 * 用户手动点「全部渠道签到」不受此限（那是显式操作，永远放行）。
 *
 * ⚠️ **开关默认打开**（用户 2026-10-02 明确要求：「自动签到默认保持打开状态」）。
 * 这与「这是代用户打上游的写操作」相权：该特性本身是用户要的，默认开启才符合
 * 「每日第一次打开 DSH 就自动签到」的预期；用户随时可以在状态灯上关掉。
 * 判据是**只有显式 `false` 才算关闭**（与本仓库账号的 `enabled !== false` 同惯例）。
 *
 * ## 为什么延迟 30 秒
 *
 * 两个理由，任一成立都不该立刻跑：
 * 1. **不跟启动抢资源**：一轮签到是「渠道数 × 账号数」次串行上游请求（反风控
 *    口径，见 `collectCreditBalances` 的顺序查询），启动瞬间打它会拖慢首屏；
 * 2. **等凭据续期先跑一轮**：宿主启动时的续期调度器**本身也要立刻跑一轮**
 *    （见 `index.ts` 的注释：短寿命 provider 的凭据在关机期间早就过期）。
 *    若抢在续期之前签到，过期凭据会让整轮变成失败。
 * 即便如此仍可能抢在续期完成前（多账号时续期本身就要几秒到几十秒），故**再加
 * 一道保险**：**逐渠道**记账 —— 只有能证明「今天这一轮已被处理」的渠道才记完成，
 * 其余渠道下次启动（或当日稍后的一次补跑）再来（见下文「per-provider 记账」）。
 * 延迟可用 `DSH_CHANNEL_PACK_AUTO_CHECKIN_DELAY_MS` 覆盖，`0` 合法（表示立刻跑，
 * 单测用它）。
 *
 * ## 什么算「今天已被处理」
 *
 * ⚠️ **不是** `claimed + alreadyClaimed`，而是各渠道用
 * `ClaimOutcome.coversToday` 声明出来的 `summary.coversToday`
 * （真实缺陷，2026-10-02 审查 PR !33 定位：Qoder 活动每日 10:00（UTC+8）才刷新，
 * 上午那轮看到的 `CLAIMED` 属于**昨天**，拿它记账会让当天额度**整天漏领**）。
 *
 * ## ★ per-provider 记账（2026-10-26，两个真实缺陷）
 *
 * 本模块原先只有**一个全局日期**（`lastDate`）：一轮跑完就写「今天已处理」，
 * 当天再也不触发。两个后果都是用户能直接看到的：
 *
 * - **A：失败渠道当天不重试。** officeace 这类当天因凭据过期或上游抖动
 *   失败的渠道，整天再也不会被自动补救（而失败往往是**暂时的**）；
 * - **B：Qoder 的 10:00 窗口漏领。** 自动签到若在 10:00（UTC+8）刷新前跑，看到的是
 *   「昨天已领」⇒ `coversToday=false`（机制已存在，见 `credits.ts` 的字段说明），
 *   但**记账逻辑照样写全局日期** ⇒ 10:00 后刷新出来的新轮次当天整天没人领。
 *
 * 现在记账粒度是**逐渠道**（`AutoCheckinDoc.providers`），判据仍是
 * `summary.coversToday`（本轮记账的唯一判据，不另立口径）：
 *
 * | 本轮该渠道的结局 | 记账 | 会不会再跑 |
 * |---|---|---|
 * | `coversToday > 0` | `done` | 今天不再跑（已完成） |
 * | `coversToday === 0`（渠道说「这不是今天的轮次」） | `stale++` | 隔 {@link AUTO_CHECKIN_STALE_RETRY_MS} 再试 |
 * | 调用异常 / `failed` / 上游错误 | `failed++` | 隔 {@link AUTO_CHECKIN_MIN_RETRY_MS} 再试 |
 * | 不支持签到 / 排除表摘掉 | `skipped` | 今天不再跑（重试没有意义） |
 *
 * 上限（防无限重跑）：同一渠道当天**总共**跑满
 * {@link AUTO_CHECKIN_MAX_ATTEMPTS_PER_DAY} 次即置 `given-up`（**今日已放弃**），
 * 并把最后一次的短结果（失败原因）留在账本里给面板展示 —— 面板文字会带上
 * 「今日已放弃」，用户能看出今天不会再有自动补救。
 *
 * 两次尝试之间的**最小间隔**按结局分两档（见 {@link nextAttemptAt}）：
 * 真失败隔 {@link AUTO_CHECKIN_MIN_RETRY_MS}（30 分钟）；「还没到今天的轮次」
 * （`stale` / `none`）则**直接等到当日刷新时刻**（{@link AUTO_CHECKIN_REFRESH_HOUR_UTC8}
 * 点），刷新前不再烧额度 —— 这一条是缺陷 B 的正面修法。
 *
 * ## 补跑时机：不引入「渠道刷新时刻表」，只靠两次机会
 *
 * 1. **下次 DSH 启动**：`runIfDue()` 不再看全局日期，而是逐渠道问
 *    `providerNeedsRun()`，所以「当天还有没处理完的渠道」就会补跑；
 * 2. **当日稍后的一次补跑**：一轮结束后若仍有渠道待跑（或启动时发现「还没到
 *    可再试的时刻」），用**已有的** `deps.schedule`（与启动延迟同一个注入点，
 *    `unref` 过）排一次；时刻取「最早可以再试的那一刻」，且不跨 UTC+8 日界
 *    （跨日后的账本按空处理，次日由下一次启动决定 —— 不引入常驻的每日定时器）。
 *    这样 Qoder 在 10:00 后能自己补上，而**不需要**在记账层写任何「哪个渠道
 *    几点刷新」的表（那必然漂移 —— 判据只能由看得见刷新语义的渠道自己给，
 *    见 `credits.ts`）。定时器由 `stop()`（宿主卸载）与 `setEnabled(false)`
 *    （用户关掉开关）取消。
 *
 * ## 向后兼容（旧格式 → 新格式）
 *
 * 旧文档只有 `lastDate` 等全局字段、没有 `providers`。读的时候**照常读出来**
 * （`sanitizeAutoCheckin` 不认 schema 版本），语义是「今天已跑过一轮」——
 * 也就是 `ranToday` 仍为真、面板文字不变；但**不阻止补跑**：per-provider 账本
 * 缺失 ⇒ 每个渠道都算「今天还没处理」⇒ 下一次启动会把它们各跑一遍（签到本身
 * 幂等）。写回时自动升级成 v2（带 `providers`），旧字段继续写、继续被读。
 *
 * ## 为什么单独一份文档，而不是塞进 ui-preferences.json
 *
 * `ui-preferences.json` 是**同 dsh home、多 profile 共享**的文档，而本仓库写盘
 * 是**整体替换**语义（见 `badge-preferences.ts` 的文件头对 state.json 记过的
 * 同一条理由）。同机上另一条工作区跑着**没有本功能**的旧版本插件时，它保存显示
 * 偏好会把这里的字段静默抹掉 —— 后果是「开关自己关了」或「今天又跑一次」。
 * 独立文档的读写者只有本文件，旧版本代码碰不到它。
 *
 * ## ⚠️ 不支持的渠道怎么判：**不建第二份能力名单**
 *
 * 「哪些渠道能签到」的权威是客户端的 `credits-capabilities.js`（12 个渠道逐项
 * 登记）。在本模块再抄一份必然漂移（本仓库已有「两份名单漂移」的真实缺陷）。
 * 故判据交给 `credits.claimAll` 自己：cline / raccoon / **workbuddy** 三条分支
 * **不发任何上游请求**就返回「不支持每日签到」，本模块把这类错误计为**跳过**，
 * 既不算失败也不重试。
 *
 * ⚠️ 其中 **workbuddy 的那条守卫是本功能先补上的**：此前它会落到 buddy 产品
 * 分支、真去发必然失败的签到请求（客户端从不调用它，是因为能力表写着 false，
 * 所以这个洞一直没被触发）。补上之后，「调用即判定」这条规则才真正安全。
 *
 * ## ⚠️「调用即判定」管不到的一类：签到**有代价**的渠道
 *
 * zcode 有签到，但每次领取都要现场产阿里云 captcha（web 版会拉起 headful
 * Chromium，且阿里云按设备限流 150 次/小时）。「等它返回错误再判定」来不及 ——
 * 代价发生在**调用期间**。故另有一张**排除表** `isAutoCheckinExcluded()`，
 * 在调 `claim` **之前**生效（详见那里的说明与维护口径）。用户仍可手动签到。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { QODER_BILLING_UTC_OFFSET_MS } from './model-queue.js'
import { resolveChannelPackHome } from './channel-pack-store.js'
import { formatClaimGains } from './credits.js'
import { ZCODE } from './zcode-product.js'
import type { BadgeRpcResult } from './usage-badge.js'
import type { RpcCreditsClaimAllResponse, RpcUsageAutoCheckinState } from './types.js'

/** 独立文档的文件名（与 state.json / ui-preferences.json 同目录）。 */
export const AUTO_CHECKIN_FILE = 'auto-checkin.json'

/**
 * 文档 schema 版本。
 *
 * - `v1`：只有全局 `lastDate`（**只读兼容**，见文件头「向后兼容」）；
 * - `v2`（2026-10-26）：追加逐渠道账本 `providers`。
 *
 * ⚠️ 版本号**不参与判据**：`sanitizeAutoCheckin` 不按 schema 分支（旧文档缺字段
 * 一律按默认值补齐），故读到 v1 文档的行为是确定的，不需要额外的迁移代码路径。
 */
const SCHEMA = 'dsh-codearts-auth/auto-checkin/v2'

/**
 * 逐账号签到结果的**归一化四态**。
 *
 * 刻意不复用 `ClaimOutcome.kind` 的字面量：那一组是**渠道产出侧**的语义
 * （`inactive` 还带 `actionRequired`），而这里要的是**展示侧**只需要区分的
 * 四类。多一个 `skipped`：该渠道今天压根没跑（无签到接口 / 排除表摘掉），
 * 与「跑了但没领到」不是一回事。
 */
export type AutoCheckinResultOutcome = 'claimed' | 'already-claimed' | 'failed' | 'skipped'

/**
 * 一条**逐账号**签到明细（表格的一行）。
 *
 * 用户 2026-10-27 给的表格形态：
 * ```
 * 领取成功 | xx渠道绿 +200 | xx渠道 +1000 | xx渠道 +100
 * 领取异常 | xx渠道        | xx渠道        | xx渠道
 * ```
 * 即「按渠道横向铺开、按结果纵向分组」。故这里必须保留 `provider` + `accountId`
 * 两个维度，前端才能自己决定怎么排版。
 */
export interface AutoCheckinAccountResult {
  provider: string
  accountId: string
  /** 账号昵称（上游可能没给 ⇒ 回落 `accountId`；**不要**在前端二次回落）。 */
  accountName: string
  outcome: AutoCheckinResultOutcome
  /**
   * 本次领取到的数量；只有 `claimed` 有意义。
   *
   * ⚠️ `0` 是**合法值**（「领取成功但 +0 分」，实测 officeace 等渠道存在）。
   * 展示侧不能把 0 当成「没领到」而改判失败。
   */
  amount: number
  /** 数量的单位；缺省按积分（与 `ClaimOutcome.unit` 同口径）。 */
  unit: 'token' | 'credit'
  /** 异常原因 / 提示文案（`failed` 与 `already-claimed` 时给出）。 */
  message?: string
  /**
   * ★ 这一行属于哪个「签到日」（per-row，2026-11-04）。
   *
   * 为什么不是全局 `resultsDay`：zcode 的签到日是 **09:00 分界**（`19:40 → 次日
   * 09:00`），而其余渠道是 00:00 分界。用全局字段会让 `00:30` 时把 zcode 昨晚
   * 20:00 领的那行判成「昨天」而清空（用户要求「09:00 刷新」），也会反过来影响
   * 其他渠道的展示。故日界随行携带。
   *
   * ⚠️ 缺省（旧文档）回落到 `resultsDay`，见 `state()` 的读取逻辑。
   */
  day?: string
}

/**
 * 单个渠道的当日账本条目。
 *
 * ⚠️ 这里的 `status` 是**记账结论**，不是 `ClaimOutcome.kind`：判据只有一条
 * 「这个渠道今天是否已被真正处理过」（`coversToday > 0`），见文件头那张表。
 */
export interface AutoCheckinProviderLedger {
  /** 账本所属的 UTC+8 日期（`YYYY-MM-DD`）；与 `day` 不等即视为空账本。 */
  day: string
  /**
   * - `done`：今天已真正处理（`coversToday > 0`）⇒ 今天不再跑；
   * - `pending`：还没跑过 / 该再跑（`attempts` 里有上次的结局）；
   * - `given-up`：达到重跑上限，**今日已放弃**（`lastText` 保留最后一次的短结果）；
   * - `skipped`：不支持签到或被排除表摘掉 ⇒ 重试没有意义，今天不再跑。
   */
  status: 'done' | 'pending' | 'given-up' | 'skipped'
  /** 今天这个渠道**真跑过** `claimAll` 的次数（跳过不计）。 */
  attempts: number
  /** 最后一次尝试的时刻（毫秒）；0 = 今天还没跑过。 */
  lastAt: number
  /** 最后一次尝试的结局（供「下次为什么还要跑」与面板展示）。 */
  lastOutcome: 'claimed' | 'already-claimed' | 'stale' | 'failed' | 'skipped' | 'error' | 'none'
  /** 最后一次尝试的短结果（如 `2 个 +200积分` / `出错` / `非今日轮次`）。 */
  lastText: string
}

/**
 * 文档内容。
 *
 * `lastDate` / `lastResult` 是**上一轮**的全局摘要（状态灯与面板文字用它，语义
 * 与旧版逐字一致）；「今天还要不要再跑」的判据在 `providers` 里逐渠道给出。
 * `channels` 是**逐渠道**结果，供面板上那行常驻的自动签到状态文字使用
 * （用户 2026-10-02：「自动签到状态下，下方应该也显示文字状态，这样才能够知道
 * 各个渠道的签到状态」）。
 */
export interface AutoCheckinDoc {
  /**
   * 自动签到开关。**默认打开**（用户 2026-10-02 明确要求：「自动签到默认保持打开
   * 状态」）—— 故判据是「只有显式 `false` 才算关闭」，与本仓库账号的
   * `enabled !== false` 惯例一致。
   */
  enabled: boolean
  /** 上次**完成**自动签到的 UTC+8 日期（`YYYY-MM-DD`）；空串 = 从未跑过。 */
  lastDate: string
  /** 上次结果摘要（中文短句，展示在状态灯提示里）。 */
  lastResult: string
  /** 上次跑完的时刻（毫秒）；0 = 从未跑过。 */
  lastAt: number
  /**
   * ★ **逐渠道当日账本**（2026-10-26）：`provider → 今天处理到哪一步`。
   *
   * 「今天还要不要再跑」的判据**只**看这里（`providerNeedsRun`）。空对象 =
   * 今天还没跑过任何渠道（**包括从旧文档升级上来的情形**，见文件头「向后兼容」）。
   * ⚠️ 只在 `day` 等于今天时有效；跨日后整份账本按空处理（不需要定时清理，
   * 判据里比一次日期即可，见 `ledgerFor`）。
   */
  providers: Record<string, AutoCheckinProviderLedger>
  /** 逐渠道结果（顺序即遍历顺序）；空数组 = 没有可展示的逐渠道信息。 */
  channels: Array<{ provider: string; text: string }>
  /**
   * ★ **逐账号**签到明细（2026-10-27，用户要求做成表格）。
   *
   * ## 为什么不能复用 `channels`
   *
   * `channels` 是**渠道级**的一句话（`2 个 +200积分`），而用户要的表格是
   * 「领取成功 / 领取异常 × 渠道 × 账号 × 积分」的逐账号行 —— 一个渠道有多个
   * 账号时，渠道级文案看不出是哪个账号领了、哪个失败了。`claimAll` 的响应里
   * 本来就有逐账号的 `results[]`，只是此前被 `describeChannel` 拍平丢了。
   *
   * ## 口径：**全天累计**，不是「上一轮」
   *
   * 用户 2026-10-27 明确要求：「这个签到表显示的是全天的，而不是上一次的结果」。
   * 故本数组按**账号**累积当天所有轮次（自动签到可能跑多次、用户也可能手动点
   * 「一键领取」），同一账号再次出现时按 {@link mergeAccountResult} 合并 ——
   * 例如第一轮领到 `+200`、第二轮返回「今天已领」，表里必须仍是 `+200`，
   * 而不是被后来的「已领」覆盖掉。
   *
   * - `outcome` 是归一化的四态，不是上游原文 —— 前端据此选颜色/文案，
   *   不要去 `includes('失败')` 这类字符串判断（改措辞就失效）；
   * - `amount` 只在 `outcome === 'claimed'` 时有意义，且**可能为 0**
   *   （上游「领取成功但 +0 分」是真实存在的形态，不能当失败）。
   */
  results: AutoCheckinAccountResult[]
  /**
   * `results` 归属的 UTC+8 日期（`YYYY-MM-DD`）；空串 = 还没有任何明细。
   *
   * ⚠️ 必须**独立于 `lastDate`**：`lastDate` 的语义是「最近一次有渠道被处理过的
   * 日子」，而明细要回答的是「这份表格是哪天的数据」。手动领取不会动 `lastDate`
   * （它只由自动签到那一轮写），若共用会让「今天手动领了，但表格说数据是昨天的」
   * —— 于是 `state()` 把它当跨日清空，用户手动领完看不到自己刚领的那一条。
   */
  resultsDay: string
  /**
   * 用户点过「关闭」的那一轮（存的是那一刻的 `lastAt`）。
   *
   * ⚠️ 存 `lastAt` 而不是布尔：新一轮跑出来 `lastAt` 变了，状态文字就会**重新出现**
   *（否则用户关过一次以后就再也看不到新的结果）。0 = 未曾关闭过。
   */
  dismissedRunAt: number
}

/** 默认：打开 + 无记录。 */
export const DEFAULT_AUTO_CHECKIN: AutoCheckinDoc = {
  enabled: true,
  lastDate: '',
  lastResult: '',
  lastAt: 0,
  providers: {},
  channels: [],
  results: [],
  resultsDay: '',
  dismissedRunAt: 0,
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 逐渠道条目的上限：渠道总数就 12 个，留一点余量即可（脏数据不该撑大文档）。 */
const MAX_CHANNEL_ENTRIES = 24

/** 归一化逐渠道结果（丢非法项、截断超长文本、限制条数）。 */
function sanitizeChannels(raw: unknown): Array<{ provider: string; text: string }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ provider: string; text: string }> = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    if (typeof record.provider !== 'string' || record.provider.length === 0) continue
    if (typeof record.text !== 'string') continue
    out.push({ provider: record.provider, text: record.text.slice(0, 120) })
    if (out.length >= MAX_CHANNEL_ENTRIES) break
  }
  return out
}

/** 逐账号明细的合法 `outcome`（脏值一律丢弃整行，见 `sanitizeResults`）。 */
const RESULT_OUTCOMES: ReadonlyArray<AutoCheckinResultOutcome> = ['claimed', 'already-claimed', 'failed', 'skipped']

/** 逐账号明细的条数上限（20 渠道 × 少量账号，留余量；脏数据不该撑大文档）。 */
const MAX_RESULT_ENTRIES = 120

/**
 * 归一化逐账号签到明细。
 *
 * ⚠️ 未知 `outcome` **丢整行**而不是回落到 `failed`：这张表是给用户看
 * 「今天领到了什么」的，把一条看不懂的记录标成「领取异常」会凭空制造告警。
 * 与 `sanitizeProviders` 的「回落比不可用更合理」取向相反 —— 那边的判据影响
 * 行为（要不要再跑），这边只影响展示。
 */
function sanitizeResults(raw: unknown): AutoCheckinAccountResult[] {
  if (!Array.isArray(raw)) return []
  const out: AutoCheckinAccountResult[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    if (typeof record.provider !== 'string' || record.provider.length === 0) continue
    if (typeof record.accountId !== 'string' || record.accountId.length === 0) continue
    const outcome = RESULT_OUTCOMES.includes(record.outcome as AutoCheckinResultOutcome)
      ? record.outcome as AutoCheckinResultOutcome
      : undefined
    if (outcome === undefined) continue
    const amountRaw = Number(record.amount)
    const unit = record.unit === 'token' ? 'token' : 'credit'
    const message = typeof record.message === 'string' && record.message !== '' ? record.message.slice(0, 200) : undefined
    const day = typeof record.day === 'string' && DATE_RE.test(record.day) ? record.day : undefined
    out.push({
      provider: record.provider,
      accountId: record.accountId,
      accountName: typeof record.accountName === 'string' && record.accountName !== ''
        ? record.accountName.slice(0, 120)
        : record.accountId,
      outcome,
      amount: Number.isFinite(amountRaw) && amountRaw > 0 ? amountRaw : 0,
      unit,
      ...(message === undefined ? {} : { message }),
      ...(day === undefined ? {} : { day }),
    })
    if (out.length >= MAX_RESULT_ENTRIES) break
  }
  return out
}

/** 账本 `status` 的合法值（脏数据一律回落到 `pending`，见 `sanitizeProviders`）。 */
const LEDGER_STATUSES: ReadonlyArray<AutoCheckinProviderLedger['status']> = ['done', 'pending', 'given-up', 'skipped']
/** 账本 `lastOutcome` 的合法值。 */
const LEDGER_OUTCOMES: ReadonlyArray<AutoCheckinProviderLedger['lastOutcome']> = ['claimed', 'already-claimed', 'stale', 'failed', 'skipped', 'error', 'none']

/**
 * 归一化逐渠道账本（丢非法项、钳计数、截断文本）。
 *
 * ⚠️ 未知 `status` 回落到 `pending`（= 今天还会再跑）：账本是「谁还没处理完」的
 * 判据，脏值往「已放弃」那边回落会让渠道**整天漏签**，往 `pending` 回落最多多发
 * 一轮请求（幂等）。判据口径与 `sanitizeAutoCheckin` 的「回落比不可用更合理」一致。
 */
function sanitizeProviders(raw: unknown): Record<string, AutoCheckinProviderLedger> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, AutoCheckinProviderLedger> = {}
  let count = 0
  for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
    if (provider.length === 0 || provider.length > 64) continue
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const record = value as Record<string, unknown>
    const day = typeof record.day === 'string' && DATE_RE.test(record.day) ? record.day : ''
    const attemptsRaw = Number(record.attempts)
    const status = LEDGER_STATUSES.includes(record.status as AutoCheckinProviderLedger['status'])
      ? record.status as AutoCheckinProviderLedger['status']
      : 'pending'
    const lastOutcome = LEDGER_OUTCOMES.includes(record.lastOutcome as AutoCheckinProviderLedger['lastOutcome'])
      ? record.lastOutcome as AutoCheckinProviderLedger['lastOutcome']
      : 'none'
    const lastAtRaw = Number(record.lastAt)
    out[provider] = {
      day,
      status,
      attempts: Number.isFinite(attemptsRaw) && attemptsRaw > 0 ? Math.min(Math.floor(attemptsRaw), 99) : 0,
      lastAt: Number.isFinite(lastAtRaw) && lastAtRaw > 0 ? lastAtRaw : 0,
      lastOutcome,
      lastText: typeof record.lastText === 'string' ? record.lastText.slice(0, 120) : '',
    }
    count += 1
    if (count >= MAX_CHANNEL_ENTRIES) break
  }
  return out
}

/**
 * 归一化文档：非法值一律回落默认值（**不抛错**）。
 *
 * ⚠️ 与 RPC 写入路径的严格校验**不冲突**：那条路径面对用户输入，要拒绝非法值；
 * 这条路径面对**磁盘上的脏数据**（手工编辑过、被旧版本写坏），回落比整机不可用
 * 更合理 —— 判据口径与 `sanitizeBadgePreference` 一致。
 * ⚠️ 缺新字段的**旧文档**（没有 `channels` / `lastAt` / `enabled` / `providers`）
 * 必须照常读出来：前三个是本功能上线后追加的，而 `enabled` 缺失要按**默认打开**
 * 处理（不是关闭）；`providers` 缺失要按**空账本**处理（= 今天还没处理任何渠道，
 * 下一次启动会补跑，见文件头「向后兼容」）。
 */
export function sanitizeAutoCheckin(raw: unknown): AutoCheckinDoc {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...DEFAULT_AUTO_CHECKIN }
  const record = raw as Record<string, unknown>
  const ms = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
  return {
    // ⚠️ **只有显式 `false` 才算关闭**（默认是打开的，见 `AutoCheckinDoc.enabled`）：
    // 写成 `=== true` 会让旧文档（没有该字段）与脏数据把开关静默关掉，与
    // 「默认保持打开状态」相反。`'false'` / `0` 这些非布尔值一律按打开处理 ——
    // 它们不是用户点出来的值。
    enabled: record.enabled !== false,
    lastDate: typeof record.lastDate === 'string' && DATE_RE.test(record.lastDate) ? record.lastDate : '',
    lastResult: typeof record.lastResult === 'string' ? record.lastResult : '',
    lastAt: ms(record.lastAt),
    providers: sanitizeProviders(record.providers),
    channels: sanitizeChannels(record.channels),
    // 旧文档没有该字段 ⇒ 空数组（面板不渲染表格，与「今天没跑过」一致）。
    results: sanitizeResults(record.results),
    resultsDay: typeof record.resultsDay === 'string' && DATE_RE.test(record.resultsDay) ? record.resultsDay : '',
    dismissedRunAt: ms(record.dismissedRunAt),
  }
}

/**
 * 取「UTC+8 的当天日期」（`YYYY-MM-DD`）。
 *
 * ⚠️ 必须用**算术平移**而不是本机时区：日界归服务端（各渠道的每日额度按 UTC+8
 * 结算），取本机时区会在用户出差/改系统时区时得到错的「今天」—— 偏东会提前把
 * 当天记为已跑（真的漏签），偏西会一天跑两次。偏移量复用 `model-queue.ts` 的
 * `QODER_BILLING_UTC_OFFSET_MS`（同一口径，不另立常量）。
 */
export function utc8DateString(nowMs: number = Date.now()): string {
  return new Date(nowMs + QODER_BILLING_UTC_OFFSET_MS).toISOString().slice(0, 10)
}

/** 环境变量：启动后延迟多久再尝试自动签到（毫秒）。 */
export const DSH_CHANNEL_PACK_AUTO_CHECKIN_DELAY_MS = 'DSH_CHANNEL_PACK_AUTO_CHECKIN_DELAY_MS'

/** 默认延迟（毫秒）。理由见文件头「为什么延迟 30 秒」。 */
export const AUTO_CHECKIN_DELAY_MS = 30_000

/**
 * 同一渠道**当天**最多跑几次 `claimAll`（含第一次）。
 *
 * ## 为什么需要上限
 *
 * per-provider 记账的代价是「没处理完就再跑」。若不设上限，一个**真的**坏掉的
 * 渠道（凭据被吊销 / 上游永久 4xx）会跟着「每次启动 + 每次补跑」反复打上游，
 * 而它的失败率是 100% —— 白耗请求、还可能触发风控。
 *
 * 取 3：够覆盖「凭据还没续上（启动竞态）/ 上游抖动 / 刷新窗口」这三类**暂时**
 * 失败，又不会让一个坏渠道整天打上游。达到上限即置 `given-up`（今日已放弃），
 * 失败原因留在账本的 `lastText` 里给面板展示。
 */
export const AUTO_CHECKIN_MAX_ATTEMPTS_PER_DAY = 3

/**
 * 真失败（调用异常 / 上游报错 / `failed`）后的最小重试间隔。
 *
 * 30 分钟的理由：与「启动后 30 秒跑一轮」同一量级地避免**重启风暴**（用户一天开
 * 十次 DSH 不该打十轮上游），又能在同一小时内给「续期刚完成」留一次机会。
 */
export const AUTO_CHECKIN_MIN_RETRY_MS = 30 * 60_000

/**
 * 「今天这一轮还没到」（渠道说 `coversToday === false`，或干脆**什么都没发生**）
 * 之后的重试间隔 —— **仅当当日的刷新时刻已经过去**时使用；刷新时刻之前一律等到
 * 刷新时刻（见 {@link nextAttemptAt}）。
 */
export const AUTO_CHECKIN_STALE_RETRY_MS = 30 * 60_000

/**
 * 「日刷新时刻」（UTC+8 的小时）：渠道报「这不是今天的轮次」时，最早什么时候
 * 再问一次。
 *
 * ⚠️ **这不是「哪个渠道几点刷新」的表** —— 那种表必然漂移，本仓库已有先例
 * （见 `credits.ts` 的 `coversToday` 说明：刷新语义只能由看得见它的渠道自己给）。
 * 这里只是一个**保守的下一次提问时刻**：已知上游里唯一的日刷新时刻是 Qoder 的
 * 10:00（UTC+8），与 `qoder-credits.ts` 的 `QODER_CAMPAIGN_REFRESH_HOUR_UTC8`
 * **必须同值**（`scripts/auto-checkin-ledger-test.mjs` 有漂移守卫用例）。
 * 不直接 import 那个模块：它经 `qoder-machine.ts` 拖进子进程/机器指纹依赖，
 * 而记账层只该依赖 `credits.ts` 的语义。
 */
export const AUTO_CHECKIN_REFRESH_HOUR_UTC8 = 10

/**
 * ★ ZCode 的签到窗口（UTC+8，2026-11-04 用户确认的**上游业务口径**）。
 *
 * 一天的真实循环是：
 *
 * ```
 * 09:00  token 清零（当日额度作废，签到记录同时刷新）      ← 日界
 * 19:40  签到开放（此后开展「今天」的签到窗口）
 * 23:00  领到的 token 开始可用
 * 次日 09:00  token 再次清零（循环回到第一行）
 * ```
 *
 * 三处都必须照这个窗口对齐，缺一个就会踩坑：
 *
 * - **日界不是 00:00 而是 09:00**：账本按 `utc8DateString` 记日（00:00 分界）时，
 *   19:40 领完、00:05 再启动一次就会被判成「新的一天、还没签」⇒ 白跑一轮
 *   （每次都是 3 个账号各 mint 一次 captcha）。故 zcode 的账本日界用
 *   {@link zcodeCheckinDayString}（09:00 分界）。
 * - **19:40 之前不能跑**：`preview` 在窗口外回的是**空列表**，而
 *   `fetchCheckinStatus` 只能靠「有没有可领 plan」推断今天签没签 ⇒ 早跑会被
 *   判成 `already-claimed` / `coversToday` 为真，把当天记成 `done` 后
 *   **19:40 之后再也不跑**（真漏签）。故要显式门控。
 * - **09:00 前不算「今天」**：与第一条同源，`19:40–24:00` 与 `00:00–09:00`
 *   属于**同一个** zcode 签到日。
 *
 * ## ★ 为什么从整点 19:00 挪到 19:40（2026-11-09 实测）
 *
 * 用户 2026-11-09 报「签到又失败了、而且没拉起浏览器」。当天取证：
 *
 * | 时刻 | 事实 |
 * |---|---|
 * | 19:02 | 窗口枪准点跑完，3 个账号全判 `already-claimed`（「今日暂无可领额度」） |
 * | 19:28 | 实测 `marketing/touch`：A/B 号 `deliveries: []`，**只有 C 号有投放** |
 * | 19:32–19:33 | 用户手动点，三个账号依次领到 300M token |
 *
 * 即「窗口一开就跑」时上游**还没把投放铺开**，且**逐个账号**铺得很分散
 * （19:28 时两个号仍是空的）。`serializeUpstream` 之外的另一个既有口径也印证
 * 这点 —— 见 `zcode-product.ts` 的「19:00 投放、（20:00）前领不到东西」。
 *
 * 故开窗时刻取 **19:40**：留 40 分钟给上游铺量，同时离 23:00「token 可真正
 * 用于推理」仍有充裕余量（早领本来也不产生收益）。
 *
 * ⚠️ 这是**时刻**，不是「哪个渠道几点刷新」的表 —— 后者必然漂移（见
 * `credits.ts` 的 `coversToday` 说明）。这里只有一个渠道、一个已知硬窗口。
 */
export const ZCODE_CHECKIN_OPEN_HOUR_UTC8 = 19

/**
 * 与 {@link ZCODE_CHECKIN_OPEN_HOUR_UTC8} 配对的**分钟位**（UTC+8）。
 *
 * ⚠️ 必须与小时一起当「当日第几分钟」比较，不能只比小时：
 * `hour >= 19` 会把 19:00–19:39 也算进窗口，正是 2026-11-09 那次失败的形态
 * （见 {@link ZCODE_CHECKIN_OPEN_HOUR_UTC8} 的取证表）。
 */
export const ZCODE_CHECKIN_OPEN_MINUTE_UTC8 = 40

/** ZCode 的 token 清零 / 签到记录刷新时刻（UTC+8）：也就是它的**日界**；
 * 领到的额度到这一刻才真正可用于推理。 */
export const ZCODE_TOKEN_RESET_HOUR_UTC8 = 9

/**
 * ZCode 当天最多跑几轮 `claimAll`。
 *
 * 比通用的 {@link AUTO_CHECKIN_MAX_ATTEMPTS_PER_DAY}（3）更紧：每次领取要现场
 * 产一个阿里云 captcha，而阿里云按**设备**限流「同设备每小时 150 次」——
 * 3 个账号失败 3 轮就是 9 次 captcha，纯烧设备配额（用户明确要求限流）。
 * 取 2：够覆盖「19:40 刚到、上游还没投放」这一类时序抖动一次。
 */
export const ZCODE_MAX_ATTEMPTS_PER_DAY = 2

const DAY_MS = 86_400_000

/** UTC+8 的「此刻是几点」（0–23）。 */
export function utc8HourOfDay(nowMs: number = Date.now()): number {
  const shifted = new Date(nowMs + QODER_BILLING_UTC_OFFSET_MS)
  return shifted.getUTCHours()
}

/**
 * UTC+8 的「此刻是当日第几分钟」（0–1439）。
 *
 * ★ 签到开窗是 **19:40**，不是整点 ⇒ 判据必须细到分钟（见
 * {@link ZCODE_CHECKIN_OPEN_MINUTE_UTC8}）。只比小时会把 19:00–19:39 误判成
 * 已开窗，而那 40 分钟正是上游还没铺开投放的时段。
 */
export function utc8MinuteOfDay(nowMs: number = Date.now()): number {
  const shifted = new Date(nowMs + QODER_BILLING_UTC_OFFSET_MS)
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
}

/**
 * ZCode 的签到日（**09:00 分界**，不是 00:00）。
 *
 * `19:40 → 次日 09:00` 是同一天：所以把时刻整体**往前推 9 小时**再取 UTC+8
 * 日期，日界自然落在 09:00。例：
 * - `11-04 20:00` → 推 9h = `11-04 11:00` → `2026-11-04`
 * - `11-05 08:00` → 推 9h = `11-04 23:00` → `2026-11-04`（**同一天** ✓）
 * - `11-05 09:00` → 推 9h = `11-05 00:00` → `2026-11-05`（换天 ✓）
 */
export function zcodeCheckinDayString(nowMs: number = Date.now()): string {
  return utc8DateString(nowMs - ZCODE_TOKEN_RESET_HOUR_UTC8 * 3_600_000)
}

/**
 * 此刻是否在 ZCode 的签到窗口内（`19:40 – 次日 09:00`）。
 *
 * ⚠️ 窗口外的 `preview` 是空列表，跑一轮只会被误判成「今天已签」而**锁死当天**
 * （见 {@link ZCODE_CHECKIN_OPEN_HOUR_UTC8} 的说明）—— 所以这不是「优化」，
 * 是正确性前提。
 *
 * ⚠️ 开窗侧必须比到**分钟**：`19:00–19:39` 仍是窗口外（上游还没铺投放）。
 * 关窗侧（`< 09:00`）保持整点即可 —— 那是 token 清零时刻，不是区间估计。
 */
export function inZcodeCheckinWindow(nowMs: number = Date.now()): boolean {
  const minuteOfDay = utc8MinuteOfDay(nowMs)
  const openMinute = ZCODE_CHECKIN_OPEN_HOUR_UTC8 * 60 + ZCODE_CHECKIN_OPEN_MINUTE_UTC8
  return minuteOfDay >= openMinute || minuteOfDay < ZCODE_TOKEN_RESET_HOUR_UTC8 * 60
}

/**
 * 下一次 zcode 签到窗口打开的绝对毫秒（窗口外才需要；窗口内返回 `nowMs`）。
 *
 * 用途：窗口外启动时把补跑排到 **19:40**，而不是干等到下次启动。
 */
export function nextZcodeWindowOpenMs(nowMs: number = Date.now()): number {
  if (inZcodeCheckinWindow(nowMs)) return nowMs
  const shifted = nowMs + QODER_BILLING_UTC_OFFSET_MS
  const dayStartShifted = Math.floor(shifted / DAY_MS) * DAY_MS
  const openMinute = ZCODE_CHECKIN_OPEN_HOUR_UTC8 * 60 + ZCODE_CHECKIN_OPEN_MINUTE_UTC8
  const openShifted = dayStartShifted + openMinute * 60_000
  return openShifted - QODER_BILLING_UTC_OFFSET_MS
}

/**
 * 该渠道的「今天」是哪一天（账本日界）。
 *
 * ⚠️ 只有 zcode 特殊（09:00 分界）：其余渠道的上游刷新口径各不相同，但都没有
 * 一个「19:40 才开放、09:00 就清零」的硬窗口，故沿用 00:00（`utc8DateString`）。
 */
export function checkinDayString(provider: string, nowMs: number = Date.now()): string {
  return provider === ZCODE.id ? zcodeCheckinDayString(nowMs) : utc8DateString(nowMs)
}

/** 该渠道此刻是否**允许**跑（zcode 有窗口，其余渠道恒真）。 */
export function checkinWindowOpen(provider: string, nowMs: number = Date.now()): boolean {
  return provider === ZCODE.id ? inZcodeCheckinWindow(nowMs) : true
}

/** 该渠道当天最多跑几次（zcode 更紧，见 {@link ZCODE_MAX_ATTEMPTS_PER_DAY}）。 */
export function maxAttemptsPerDay(provider: string): number {
  return provider === ZCODE.id ? ZCODE_MAX_ATTEMPTS_PER_DAY : AUTO_CHECKIN_MAX_ATTEMPTS_PER_DAY
}

/**
 * 「UTC+8 当天 00:00」的绝对毫秒。
 *
 * ⚠️ 与 `utc8DateString` 同一口径（算术平移，不看本机时区）：用 `Date` 的本地
 * 时间 API 会在用户出差 / 改系统时区时把「今天」算错。
 */
export function utc8DayStartMs(nowMs: number = Date.now()): number {
  const shifted = nowMs + QODER_BILLING_UTC_OFFSET_MS
  return Math.floor(shifted / DAY_MS) * DAY_MS - QODER_BILLING_UTC_OFFSET_MS
}

/** 「UTC+8 当天 10:00」（日刷新时刻）的绝对毫秒。 */
export function utc8RefreshBoundaryMs(nowMs: number = Date.now()): number {
  return utc8DayStartMs(nowMs) + AUTO_CHECKIN_REFRESH_HOUR_UTC8 * 3_600_000
}

/**
 * 某个渠道**最早**什么时候可以再跑；`null` = 今天不用再跑。
 *
 * 纯函数（只吃账本条目与时刻）⇒ 单测零等待、零文件系统、零网络。
 *
 * 判据顺序：
 * 1. 没有今天的条目（含旧文档升级上来的空账本）⇒ **立刻可跑**（今天还没处理）；
 * 2. `done` / `given-up` / `skipped` ⇒ 今天不再跑；
 * 3. `pending`：`attempts` 已达上限 ⇒ 不再跑（应由调用方置 `given-up`）；
 * 4. `pending` 且上次结局是 `stale` / `none`（渠道说「不是今天的轮次」/ 干脆什么
 *    都没发生）⇒ 等到**当日刷新时刻**（还没到）或 `lastAt + STALE_RETRY_MS`（已过）；
 * 5. 其余（`failed` / `error`）⇒ `lastAt + MIN_RETRY_MS`。
 *
 * ⚠️⚠️ **第 4 条里的「等到刷新时刻」不能省**（2026-10-26 实现时发现）：Qoder 在
 * 10:00 之前返回的是 `inactive`（`NOT_REFRESHED_YET_HINT`，**没有**任何
 * `claimed/alreadyClaimed` 痕迹），此时 `coversToday === 0` 且 `failed === 0`
 * —— 若按「30 分钟后重试」算，08:00 那次启动会在 08:30 / 09:00 / 09:30 把
 * {@link AUTO_CHECKIN_MAX_ATTEMPTS_PER_DAY} 次额度**在刷新之前**全部烧完，
 * 10:00 之后再也不跑 ⇒ 缺陷 B 原样复发（甚至更糟：连旧行为都不如）。
 * 故「什么都没发生」与「非今日轮次」共用同一条时刻判据。
 */
export function nextAttemptAt(
  entry: AutoCheckinProviderLedger | undefined,
  nowMs: number = Date.now(),
  provider?: string,
): number | null {
  /**
   * ⚠️ 窗口门控必须**先于**账本判断（zcode）：
   * 窗口外的 `preview` 是空列表，跑了会被误判成「今天已签」并锁死当天
   * （见 {@link ZCODE_CHECKIN_OPEN_HOUR_UTC8}）。故窗口外一律返回「窗口打开时刻」，
   * 无论是「今天还没跑」还是「待补跑」。
   */
  if (provider !== undefined && !checkinWindowOpen(provider, nowMs)) {
    return nextZcodeWindowOpenMs(nowMs)
  }
  if (entry === undefined || entry.day !== checkinDayString(provider ?? '', nowMs)) return nowMs
  if (entry.status !== 'pending') return null
  if (entry.attempts >= maxAttemptsPerDay(provider ?? '')) return null
  const last = entry.lastAt > 0 ? entry.lastAt : nowMs
  if (entry.lastOutcome === 'stale' || entry.lastOutcome === 'none') {
    const boundary = utc8RefreshBoundaryMs(nowMs)
    return nowMs < boundary ? boundary : last + AUTO_CHECKIN_STALE_RETRY_MS
  }
  return last + AUTO_CHECKIN_MIN_RETRY_MS
}

/** 这个渠道现在该不该跑（`nextAttemptAt` 的可读封装）。 */
export function providerNeedsRun(
  entry: AutoCheckinProviderLedger | undefined,
  nowMs: number = Date.now(),
  provider?: string,
): boolean {
  const at = nextAttemptAt(entry, nowMs, provider)
  return at !== null && at <= nowMs
}

/**
 * 今天还有几个渠道**待补跑**（`pending`；`given-up` 不算）。
 *
 * ⚠️ `only` 是**必须**给的（可选只为兼容纯函数单测）：账本里可能留着**已经不在
 * 账号池里**的渠道条目（账号被删 / 渠道关闭）。不过滤会让「待补跑数」永远大于 0
 * ⇒ `scheduleFollowUp` 反复排一个 0ms 的补跑（真实死循环，2026-10-26 实现时踩到）。
 */
export function pendingProviderCount(
  providers: Record<string, AutoCheckinProviderLedger>,
  nowMs: number = Date.now(),
  only?: readonly string[],
): number {
  const keys = only ?? Object.keys(providers)
  let count = 0
  for (const provider of keys) {
    const entry = providers[provider]
    // ⚠️ 日界必须 per-provider（zcode 是 09:00 分界，见 `checkinDayString`）。
    if (entry !== undefined && entry.day === checkinDayString(provider, nowMs) && entry.status === 'pending') count += 1
  }
  return count
}

/**
 * 下一轮补跑该在什么时刻（所有待跑渠道里最早的那个）；`null` = 今天没有待跑的。
 *
 * ⚠️ 越过 UTC+8 日界的时刻一律丢弃：跨日后的账本按空处理（`nextAttemptAt` 的
 * 第 1 条），而**次日是否再跑由下一次启动决定** —— 本模块刻意不引入「常驻的每日
 * 定时器」（那是 `index.ts` 的续期调度器那类设施的事，不在本缺陷范围内）。
 */
export function nextPendingAttemptAt(
  providers: Record<string, AutoCheckinProviderLedger>,
  nowMs: number = Date.now(),
  only?: readonly string[],
): number | null {
  const endOfDay = utc8DayStartMs(nowMs) + DAY_MS
  const keys = only ?? Object.keys(providers)
  let best: number | null = null
  for (const provider of keys) {
    const at = nextAttemptAt(providers[provider], nowMs, provider)
    if (at === null || at >= endOfDay) continue
    if (best === null || at < best) best = at
  }
  return best
}

/**
 * 读延迟配置。
 *
 * ⚠️ 不能写成 `Number(env.X) || 默认值`：`0` 是**合法**值（立刻执行），
 * 而 `0` 是 falsy 会被静默换成 30 秒 —— 与本仓库 `DSH_CHANNEL_PACK_BADGE_TTL_MS`、
 * `DSH_QODER_QUEUE_TIMEOUT_MS` 记过的是同一个坑。
 */
export function autoCheckinDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DSH_CHANNEL_PACK_AUTO_CHECKIN_DELAY_MS]
  if (typeof raw !== 'string' || raw.trim().length === 0) return AUTO_CHECKIN_DELAY_MS
  const parsed = Number(raw.trim())
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : AUTO_CHECKIN_DELAY_MS
}

/** 文档后端：文件（正常）或内存（定位不到 dsh home 时的显式降级）。 */
export type AutoCheckinStoreKind = 'file' | 'memory'

/** 文档读写接口（同步读、异步写，与 `BadgePreferenceStore` 同款约定）。 */
export interface AutoCheckinStore {
  readonly kind: AutoCheckinStoreKind
  /** 载入文档；不存在 / 损坏 / 字段非法时返回默认值。 */
  load(): AutoCheckinDoc
  /** 整份写入（原子写）。 */
  save(doc: AutoCheckinDoc): Promise<void>
}

class MemoryAutoCheckinStore implements AutoCheckinStore {
  readonly kind = 'memory' as const
  private doc: AutoCheckinDoc = { ...DEFAULT_AUTO_CHECKIN }

  load(): AutoCheckinDoc {
    return { ...this.doc }
  }

  async save(doc: AutoCheckinDoc): Promise<void> {
    this.doc = { ...doc }
  }
}

class FileAutoCheckinStore implements AutoCheckinStore {
  readonly kind = 'file' as const

  constructor(
    private readonly path: string,
    private readonly logger: { warn(message: string): void } | undefined,
  ) {}

  load(): AutoCheckinDoc {
    try {
      if (!existsSync(this.path)) return { ...DEFAULT_AUTO_CHECKIN }
      return sanitizeAutoCheckin(JSON.parse(readFileSync(this.path, 'utf-8')) as unknown)
    } catch (error) {
      // 损坏时回落默认值而不是抛错：这是后台任务，读不到文档不该让插件起不来。
      // ⚠️ 默认值现在是「**打开**」（见 `DEFAULT_AUTO_CHECKIN`），所以回落的后果
      // 是「今天照常自动签到」，不是「不签」。早先这里写的是「= 开关关闭」，
      // 那是默认值翻转前的旧语义 —— 留着会把排障引到反方向。
      this.logger?.warn(`[channel-pack] 读取 ${this.path} 失败，自动签到按默认设置（开启）处理: ${String(error)}`)
      return { ...DEFAULT_AUTO_CHECKIN }
    }
  }

  async save(doc: AutoCheckinDoc): Promise<void> {
    mkdirSync(join(this.path, '..'), { recursive: true })
    const tmp = `${this.path}.${process.pid}.tmp` // 2026-11-08 终审 R3：pid 后缀防跨进程互相覆盖/ENOENT
    writeFileSync(tmp, JSON.stringify({
      schema: SCHEMA,
      enabled: doc.enabled,
      lastDate: doc.lastDate,
      lastResult: doc.lastResult,
      lastAt: doc.lastAt,
      // ★ v2 逐渠道账本（2026-10-26）。旧版本插件读这份文档时只会看到
      //   它认识的字段（旧字段全部保留），故升级不会让另一条工作区的旧版本崩。
      providers: doc.providers,
      channels: doc.channels,
      // ★ v2 逐账号明细（2026-10-27）。旧版本插件只读它认识的字段，多一个数组
      //   不会让另一条工作区的旧版本崩。
      results: doc.results,
      resultsDay: doc.resultsDay,
      dismissedRunAt: doc.dismissedRunAt,
    }, null, 2), 'utf-8')
    renameSync(tmp, this.path)
  }
}

/** 创建文档后端（home 与账号池 / 偏好文档用**同一个** `resolveChannelPackHome`）。 */
export function createAutoCheckinStore(ctx: Context): AutoCheckinStore {
  const home = resolveChannelPackHome(ctx)
  if (home === undefined) {
    ctx.logger?.warn?.('[channel-pack] 无法定位 DSH home，自动签到开关仅存在于内存中')
    return new MemoryAutoCheckinStore()
  }
  return new FileAutoCheckinStore(join(home, 'channel-pack', AUTO_CHECKIN_FILE), ctx.logger)
}

/** 一轮执行的累计口径（账号级计数来自各渠道的 `summary`）。 */
interface RunTotals {
  /** 真正跑过 `claimAll` 的渠道数（不含被跳过的）。 */
  providers: number
  claimed: number
  totalCredit: number
  /**
   * ★ **按单位分组**的合计（2026-10-04）。
   *
   * ⚠️ 展示路径**必须**用它而不是 {@link totalCredit}：后者跨单位求和，
   * 会把 ZCode 的 token 与其余渠道的积分加成一个数（真实缺陷，见
   * `RpcCreditsClaimSummary.totalByUnit`）。
   */
  totalByUnit: Record<'token' | 'credit', number>
  alreadyClaimed: number
  inactive: number
  failed: number
  /**
   * 其中**能证明「今天这一轮已被处理」**的账号数（来自 `summary.coversToday`）。
   *
   * ⚠️ 这是判「今天这一轮已被处理」的**唯一**口径 —— 不能用
   * `claimed + alreadyClaimed`：那两项里混着「刷新前那一轮」的痕迹
   * （Qoder 活动 10:00 UTC+8 才刷新），拿它们记账会让当天新额度整天漏领。
   * 字段语义见 `src/credits.ts` 的 `ClaimOutcomeCommon.coversToday`。
   */
  coversToday: number
  /** 渠道级：不支持签到（`claimAll` 未发上游请求就返回的那些）。 */
  skipped: number
  /** 渠道级：其它错误（凭据、网络……）。 */
  errors: number
  /**
   * 渠道级：本轮达到重跑上限、**今日已放弃**的渠道数（2026-10-26）。
   *
   * 与 `errors` 分开：`errors` 是「这一轮出错」，`givenUp` 是「今天不再自动试了」
   * —— 后者必须让用户看见（否则「今日已放弃」只躺在文档里，用户以为还在自动补救）。
   */
  givenUp: number
}

function emptyTotals(): RunTotals {
  return { providers: 0, claimed: 0, totalCredit: 0, totalByUnit: { token: 0, credit: 0 }, alreadyClaimed: 0, inactive: 0, failed: 0, coversToday: 0, skipped: 0, errors: 0, givenUp: 0 }
}

/**
 * 「不支持每日签到」的判据：`credits.claimAll` 对 cline / raccoon / workbuddy
 * 返回的**显式**错误文案（这三条分支都不发上游请求）。
 *
 * ⚠️ 兜底认 `unsupported provider`：那是 `productById` 找不到产品时的文案，
 * 语义同样是「这个渠道没有可用的签到实现」，计成失败只会制造假警报。
 * ⚠️ 判据必须**窄**：只匹配这两个短语，不要泛化成「含 unsupported」之类，
 * 免得把真正的参数错误也吞掉。
 */
export function isUnsupportedCheckin(message: string): boolean {
  return message.includes('不支持每日签到') || message.includes('unsupported provider')
}

/**
 * ⚠️ **自动签到不适合**的渠道：领取过程需要**用户在场 / 外部程序**。
 *
 * ## 为什么不靠「错误文案」判（真实缺陷，2026-10-02 审查 PR !33 定位）
 *
 * 本文件原先的规则是「判据交给 `credits.claimAll` 自己：不支持的渠道会
 * **不发上游请求**就返回错误」。那对 cline / raccoon / workbuddy 成立 ——
 * 它们的守卫在 `claimAll` 里，返回前一个请求都没发。
 *
 * 但**漏了一类**：zcode **有**签到，只是每次领取都要现场产一个阿里云
 * captcha param（`channel-pack-rpc.ts` 的 zcode 分支无条件调 `zcode.mintCaptcha`）。
 * web 版下它会**拉起 headful Chromium**（约 200–400MB），而阿里云按**设备**
 * 限流「同设备每小时 150 次」。默认开启的自动签到等于：用户什么都没点，
 * 开 DSH 就起一棵浏览器进程树、白耗设备级配额；一旦这轮失败又不写 `lastDate`
 * ⇒ **每次启动都重来**，一天开十次就是十轮 captcha。
 *
 * ## 判据与维护口径
 *
 * - 这张表是**第二份名单**，但它记的不是「谁有签到接口」（那仍由
 *   `claimAll` 的守卫 + 客户端能力表负责），而是「谁有签到**代价**」——
 *   后者无处可查，只能显式登记。**新增带 captcha / 外部浏览器的 provider 时，
 *   必须同时登记到这里**（`tests/unit/auto-checkin.spec.ts` 有反向守护用例：
 *   一旦 zcode 的 claim 分支又开始调 `mintCaptcha`，而本表没登记，用例会红）。
 * - 用户仍可在面板里**手动**点 zcode 的「一键领取积分」—— 那是有意行为，
 *   浏览器弹出来是用户自己能理解的交互。
 */
export function isAutoCheckinExcluded(provider: string): boolean {
  /**
   * ★ 2026-11-04：**不再排除 zcode**（用户要求实现自动签到）。
   *
   * 原排除理由是「每次领取都要现场产 captcha，会拉起 headful Chromium，且
   * 阿里云按设备限流」。用户的接受条件是「一天一次、失败限流」—— 这两条现在都由
   * {@link ZCODE_MAX_ATTEMPTS_PER_DAY}（2 轮/天）+ 签到窗口
   * （{@link ZCODE_CHECKIN_OPEN_HOUR_UTC8}：19:40 前不跑）保证：
   * 一个 zcode 签到日最多 2 轮 × 3 账号 = 6 次 captcha，且窗口外一次都不跑。
   *
   * ⚠️ 保留本函数（而不是删掉）：将来若又出现「必须用户在场」的渠道，登记点在这里；
   * 且它仍被 `performRun` 显式调用，删掉会改变调用图（守护用例也在）。
   */
  return false
}

/** 把一轮结果拼成一句中文摘要（给状态灯提示与日志用）。 */
export function describeRun(totals: RunTotals): string {
  const parts: string[] = []
  if (totals.claimed > 0) {
    // ★ 按单位分别报（2026-10-04，真实缺陷）：原先写 `+${totals.totalCredit} 积分`，
    //   而 `totalCredit` 是**跨单位求和** —— ZCode 的 1 亿 token 与 100 积分会被
    //   加成 `100000100` 并标成「积分」。用户报障原文给的期望形态就是
    //   `+100Mtoken, +100积分`（见 `credits.ts` 的 `formatClaimGains`）。
    const amounts = formatClaimGains(totals.totalByUnit ?? { credit: totals.totalCredit })
    parts.push(`${totals.claimed} 个账号领取成功${amounts === null ? '' : `（${amounts}）`}`)
  }
  if (totals.alreadyClaimed > 0) parts.push(`${totals.alreadyClaimed} 个今天已领`)
  // ⚠️ 声称「领取成功 / 今天已领」之前先自问一句：这些痕迹是不是**今天这一轮**的？
  // Qoder 在 10:00（UTC+8）刷新前领到的是**昨天那条**的补领 —— 报「领取成功」没错，
  // 但**不能**让用户以为今天的事办完了（那正是缺陷 B 的界面表现）。故这里显式标注，
  // 与 `describeChannel` 的「非今日轮次」同一口径（coversToday）。
  const traces = totals.claimed + totals.alreadyClaimed
  if (traces > 0 && totals.coversToday === 0) parts.push('均非今日轮次（未到刷新时刻）')
  if (totals.failed > 0) parts.push(`${totals.failed} 个失败`)
  if (totals.errors > 0) parts.push(`${totals.errors} 个渠道出错`)
  if (totals.skipped > 0) parts.push(`${totals.skipped} 个渠道不支持签到`)
  // ★ 「今日已放弃」（2026-10-26）：达到重跑上限的渠道必须让用户看见 ——
  //   否则面板只说「N 个失败」，用户不知道今天**不会**再自动补救了。
  if (totals.givenUp > 0) parts.push(`${totals.givenUp} 个渠道今日已放弃`)
  if (parts.length === 0) return `${totals.providers} 个渠道：没有需要领取的账号`
  return `${totals.providers} 个渠道：${parts.join('，')}`
}

/**
 * 「这一轮有没有渠道能证明今天已被处理」—— 保留为**口径参考**与单测判据。
 *
 * ★ 2026-10-26 起它**不再决定记账**：记账已改为逐渠道（见文件头「per-provider
 * 记账」），每个渠道各自按同一口径（`summary.coversToday > 0`）判「今天完成没
 * 完成」。这个函数留着是因为「整轮有没有任何进展」仍是日志与排障要看的一句话，
 * 而且它的注释就是那条判据的出处（新增渠道时别自己发明第三种口径）。
 *
 * ⚠️⚠️ **为什么不能看 `claimed + alreadyClaimed`**（真实缺陷，2026-10-02 审查
 * PR !33 定位）：那两项里混着「**刷新前那一轮**」的痕迹。Qoder 的活动每日
 * 10:00（UTC+8）才刷新，于是上午 9 点跑的那一轮看到的是**昨天**那条 `CLAIMED`
 * —— 记成「今天已跑」之后，当天 10 点刷新出来的新额度**整天不会再被领**，
 * 而且界面还显示「1 个今天已领」，用户毫无提示。渠道自己用
 * `ClaimOutcome.coversToday` 标出「这条不算今天」，本函数只负责数。
 *
 * 反例（旧行为是「不记、下次启动重试」；新行为是**该渠道留在 pending**）：
 * - 整轮零成功零已领（凭据全过期 / 网络不通 / 启动太早抢在续期之前）；
 * - 跑完但**没有一条能证明今天**（例如只有 Qoder 且赶在 10:00 之前）；
 * - 一个渠道都没跑（全被跳过）：没有意义。
 * 反之「有成功也有失败」时旧行为是整轮记账（否则一个坏账号会让每次启动都重领
 * 好账号）；新行为只把成功的那些记 `done`、失败的留 `pending` —— 幂等请求只发给
 * 真正需要的渠道，这正是本缺陷的修法。
 */

/**
 * 把 `claimAll` 的逐账号结果**按账号聚合**成表格行。
 *
 * ## 为什么需要聚合
 *
 * `results[]` 是**逐 outcome** 的：ZCode 一个账号有多个 plan 时会展开成多条
 * （见 `channel-pack-rpc.ts` 的「一个账号可能有多条 outcome」）。直接铺成表格
 * 会出现同一账号好几行，看起来像重复上报。
 *
 * ## 聚合规则
 *
 * - 有 `claimed` ⇒ 该账号记 `claimed`，数量**相加**（多个 plan 的收益都是真领到的）；
 * - 否则有 `already-claimed` ⇒ `already-claimed`；
 * - 否则有 `failed` ⇒ `failed`（带上第一条失败原因）；
 * - 都没有 ⇒ `skipped`（`inactive` 落这里：今天没东西可领，不是异常）。
 *
 * ⚠️ 单位取**第一条有金额的** outcome 的 `unit`：同一账号的多个 plan 单位必然相同
 * （由同一渠道产出），跨单位相加才是真错误 —— 而那是 `totalCredit` 的历史问题，
 * 本函数不做跨账号/跨渠道求和，故不涉及。
 */
/**
 * 把「本轮的一条账号结果」合并进**当天已有**的结果里（全天累计）。
 *
 * ## 为什么不能直接覆盖
 *
 * 用户 2026-10-27：「这个签到表显示的是全天的，而不是上一次的结果」。
 * 而 `claimAll` 每次只返回**这一轮**的 outcome —— 早上自动签到领到 `+200`，
 * 晚上手动再点一次会返回「今天已领」，直接覆盖就会把 `+200` 抹掉，
 * 表格变成「今天什么都没领到」，与事实相反。
 *
 * ## 合并规则
 *
 * 按 `outcome` 的**信息量**取高的，而不是「后写的赢」：
 *
 * | 已有 | 新来 | 结果 | 理由 |
 * |---|---|---|---|
 * | `claimed` | `already-claimed` / `failed` / `skipped` | **保留 claimed** | 已经领到的事实不会因为再点一次而消失 |
 * | `claimed` | `claimed` | 金额**相加** | 同一天多个 plan / 多次可领的都算真实收益 |
 * | `already-claimed` | `claimed` | 换成 `claimed` | 说明这一轮真领到了 |
 * | `failed` / `skipped` | `claimed` | 换成 `claimed` | 失败后补领成功 |
 * | `failed` | `failed` | 保留**新**的 | 失败原因更新为最近一次的（更贴近现状） |
 * | `skipped` | `failed` | 换成 `failed` | 有结论比「无可领」信息更足 |
 *
 * ⚠️ 金额只在 `claimed + claimed` 时相加：其余情形要么不是收益，要么是
 * 同一笔的重复上报（如「已领」不带金额），相加会虚增。
 */
export function mergeAccountResult(
  previous: AutoCheckinAccountResult | undefined,
  incoming: AutoCheckinAccountResult,
): AutoCheckinAccountResult {
  if (previous === undefined) return incoming
  const rank = (value: AutoCheckinResultOutcome): number =>
    value === 'claimed' ? 3 : value === 'already-claimed' ? 2 : value === 'failed' ? 1 : 0
  const before = rank(previous.outcome)
  const after = rank(incoming.outcome)
  // 新来的更强 ⇒ 换掉（但金额不叠加：这是「同一笔的另一种说法」，不是新增收益）。
  if (after > before) return { ...incoming }
  // 完全同级：claimed + claimed 是真收益，金额相加；其余保留新的（原因/文案更新）。
  if (after === before) {
    if (incoming.outcome === 'claimed') {
      return { ...incoming, amount: (Number(previous.amount) || 0) + (Number(incoming.amount) || 0) }
    }
    return { ...incoming }
  }
  // 新来的更弱（如 claimed 之后又点了「已领」）⇒ 保留已有的事实。
  return previous
}

export function aggregateAccountRows(
  provider: string,
  results: ReadonlyArray<{ accountId: string; nickname?: string; outcome: import('./credits.js').ClaimOutcome }>,
): AutoCheckinAccountResult[] {
  const byAccount = new Map<string, AutoCheckinAccountResult>()
  for (const row of results) {
    const outcome = row.outcome
    const key = row.accountId
    const name = typeof row.nickname === 'string' && row.nickname !== '' ? row.nickname : row.accountId
    const previous = byAccount.get(key)
    const kind = outcome.kind
    // 每条 outcome 归一到四态；`inactive` 不算异常（今天没东西可领）。
    const mapped: AutoCheckinResultOutcome = kind === 'claimed' ? 'claimed'
      : kind === 'already-claimed' ? 'already-claimed'
        : kind === 'failed' ? 'failed'
          : 'skipped'
    const amount = kind === 'claimed' ? (Number.isFinite(outcome.credit) ? outcome.credit : 0) : 0
    const unit = kind === 'claimed' && outcome.unit === 'token' ? 'token' : 'credit'
    const message = kind === 'claimed' ? undefined
      : typeof (outcome as { message?: unknown }).message === 'string' && (outcome as { message?: string }).message !== ''
        ? (outcome as { message?: string }).message
        : undefined
    if (previous === undefined) {
      byAccount.set(key, {
        provider, accountId: key, accountName: name, outcome: mapped, amount, unit,
        ...(message === undefined ? {} : { message }),
      })
      continue
    }
    // 优先级：claimed > already-claimed > failed > skipped
    const rank = (value: AutoCheckinResultOutcome): number =>
      value === 'claimed' ? 3 : value === 'already-claimed' ? 2 : value === 'failed' ? 1 : 0
    if (rank(mapped) > rank(previous.outcome)) {
      byAccount.set(key, {
        ...previous,
        outcome: mapped,
        // 换成更高的结局时，金额取这一条（而不是累加另一条 plan 的）——
        // 只有同为 claimed 时才相加，见下。
        amount,
        unit,
        ...(message === undefined ? {} : { message }),
      })
    } else if (mapped === previous.outcome && mapped === 'claimed') {
      byAccount.set(key, { ...previous, amount: previous.amount + amount })
    }
  }
  return [...byAccount.values()]
}

/**
 * 单个渠道的短状态（面板上那行常驻文字用它逐渠道列出，用户要求「这样才能够知道
 * **各个渠道**的签到状态」）。
 *
 * ⚠️ 必须**短**：9 个渠道要挤在 280px 的面板里一行一个片段，长文案会撑成好几屏。
 * 故只给「几个账号 + 什么结果」，不带渠道名（渠道名由展示层补）。
 */
export function describeChannel(summary: {
  claimed: number
  totalCredit: number
  alreadyClaimed: number
  inactive: number
  failed: number
  /** 见 `RpcCreditsClaimSummary.coversToday`；缺省按 `claimed+alreadyClaimed` 兜底。 */
  coversToday?: number
  /**
   * ★ 按单位分组的合计（2026-10-04）。**缺省回落到「全部按积分」**，
   * 以兼容尚未上报该字段的旧响应（与 `coversToday` 的兜底同思路）。
   */
  totalByUnit?: Partial<Record<'token' | 'credit', number>>
}): string {
  const parts: string[] = []
  if (summary.claimed > 0) {
    // ⚠️ 「领到了但 +0 分」与「今天已领」必须能分辨：前者写成「已领」会和
    // alreadyClaimed 撞词，用户无法判断这次到底有没有动作。
    //
    // ★ 单位感知（2026-10-04）：原先写裸数字 `+${summary.totalCredit}`，
    //   于是 ZCode 那行显示 `1 个 +100000000` —— 既看不出单位，量级也读不出来。
    //   用户给的期望形态是 `+100Mtoken`（见 `credits.ts` 的 `formatClaimGains`）。
    const amounts = formatClaimGains(summary.totalByUnit ?? { credit: summary.totalCredit })
    parts.push(amounts === null ? `${summary.claimed} 个领取成功` : `${summary.claimed} 个 ${amounts}`)
  }
  if (summary.alreadyClaimed > 0) parts.push(`${summary.alreadyClaimed} 个今天已领`)
  if (summary.failed > 0) parts.push(`${summary.failed} 个失败`)
  if (summary.inactive > 0) parts.push(`${summary.inactive} 个未开启`)
  if (parts.length === 0) return '无可领'
  // ⚠️ 声称「今天已领」之前先自问一句：这些痕迹是不是**今天这一轮**的？
  // Qoder 在 10:00（UTC+8）刷新前看到的 `CLAIMED` 属于昨天 —— 此时那句
  // 「今天已领」既不准确，又会让用户以为今天不必再领。
  const coversToday = summary.coversToday ?? (summary.claimed + summary.alreadyClaimed)
  if (coversToday === 0 && (summary.claimed + summary.alreadyClaimed) > 0) {
    parts.push('非今日轮次')
  }
  return parts.join('，')
}

/** 装配层注入的依赖（全部可替换 ⇒ 单测零网络、零文件系统、零等待）。 */
export interface AutoCheckinDeps {
  store: AutoCheckinStore
  /**
   * 列出**账号池里有账号**的渠道 id。
   * 只遍历有账号的渠道：没有账号的渠道调 `claimAll` 只会拿到空结果，白白走一遍
   * 12 条分支。
   */
  listProviderIds(): Promise<string[]>
  /**
   * 调某个渠道的签到 —— **必须复用 `credits.claimAll` 的实现**（装配层直接调内部
   * `handleMethod`）。本模块不认任何具体渠道，只按返回的信封判「跳过 / 失败」。
   */
  claim(provider: string): Promise<BadgeRpcResult<RpcCreditsClaimAllResponse>>
  now?(): number
  /** 延迟毫秒数；默认读环境变量。 */
  delayMs?: number
  /** 排定延迟执行（注入以便单测零等待）。返回值交给 `stop()` 取消。 */
  schedule?(fn: () => void, ms: number): { cancel(): void }
  warn?(message: string): void
}

/** 自动签到执行体。 */
export interface AutoCheckin {
  /** 实时状态（供 RPC 与状态灯；`enabled` 等取自内存，不重新读盘）。 */
  state(): RpcUsageAutoCheckinState
  /** 写开关；**打开时若今天还没跑过，立刻跑一轮**（否则用户会以为开关没生效）。 */
  setEnabled(enabled: boolean): Promise<RpcUsageAutoCheckinState>
  /**
   * 关闭面板上那行**常驻的**自动签到状态文字（用户点它上方的小按钮时调用）。
   *
   * ⚠️ 与手动签到的结果提示不同：那条是**按时自动消失**；这一条是用户要求
   * 「不要自动取消、给我开放手动关闭」。关闭记的是**这一轮**（当前的 `lastAt`），
   * 故下一轮跑出新结果时它会重新出现。
   */
  dismiss(): Promise<RpcUsageAutoCheckinState>
  /** 启动时调用一次：延迟后排定一轮（内部自己判开关与当天是否已跑）。 */
  start(): void
  /** 立刻按判据跑一轮（供「刚打开开关」与单测用）。 */
  runIfDue(): Promise<void>
  /**
   * ★ 记录一次 `credits.claimAll` 的逐账号结果（**手动与自动共用**）。
   *
   * ## 为什么由调用方（RPC 层）驱动，而不是在这里自己取
   *
   * 用户 2026-10-27：「这个签到表显示的是全天的，而不是上一次的结果」。
   * 而**手动点「一键领取」和自动签到走的是同一个 `credits.claimAll`** ——
   * 若只在自动签到那一轮里记录，手动领到的就永远进不了表格。
   *
   * 故记录点放在两者的共同出口（`handleMethod`），本方法只负责
   * 「把这一轮的结果并进当天」（合并规则见 `mergeAccountResult`）。
   *
   * ⚠️ 跨日自动归零：`resultsDay` 不是今天就把旧明细丢掉重来 ——
   * 「今日领取」不该包含昨天的记录。
   */
  recordClaimResult(provider: string, value: RpcCreditsClaimAllResponse | undefined): Promise<void>
  /** 取消尚未执行的延迟任务（不打断已开始的一轮）。 */
  stop(): void
}

/** 创建自动签到执行体。 */
export function createAutoCheckin(deps: AutoCheckinDeps): AutoCheckin {
  const now = deps.now ?? (() => Date.now())
  let doc = deps.store.load()
  let running = false
  /** 在飞去重：`setEnabled(true)` 与启动排定可能同时想跑。 */
  let inflight: Promise<void> | null = null
  /** 启动延迟那一枪（`start()`）。 */
  let pending: { cancel(): void } | null = null
  /**
   * 当日补跑那一枪（`scheduleFollowUp()`）。
   *
   * ⚠️ 与 {@link pending} **分开两个槽**：启动延迟与补跑是两件不同的事，共用一个
   * 槽会让「补跑已排定」把「启动延迟」当成已排（或反之）—— 表现为启动那轮被
   * 静默吞掉。两者都由 `stop()` 取消。
   */
  let followUp: { cancel(): void } | null = null
  /**
   * ★ **签到窗口打开**那一枪（2026-11-04，用户要求「每天 19:40 准点自动跑一次」）。
   *
   * 与 {@link followUp} 的区别：`followUp` 排的是「待补跑渠道的最早可跑时刻」
   * （`nextPendingAttemptAt`，账本里**已有** pending 条目才算），而启动时若账本里
   * 还没有 zcode 今天的条目（例如上午 10 点启动、19 点才开窗），`followUp` 排不出
   * 任何东西 —— 用户就得等到下次启动。这个槽专门为「窗口打开」补上那一枪。
   *
   * 三个槽互不复用：共用会让「已排定」的判断互相吞掉（见 {@link followUp} 的说明）。
   */
  let windowTimer: { cancel(): void } | null = null

  const today = (): string => utc8DateString(now())

  function state(): RpcUsageAutoCheckinState {
    return {
      enabled: doc.enabled,
      lastDate: doc.lastDate,
      // ⚠️ `ranToday` 的语义**保持旧版**（「今天跑过一轮」）：面板那句「今日已
      // 自动签到」是给用户看的上一次结果，不是「所有渠道都完成了」。真正的
      // 完成度由 `channels` 逐条给出，补跑判据看 `doc.providers`（见 `runIfDue`）。
      ranToday: doc.lastDate !== '' && doc.lastDate === today(),
      running,
      lastResult: doc.lastResult,
      lastAt: doc.lastAt,
      channels: doc.channels.map((entry) => ({ ...entry })),
      /**
       * 逐账号明细（签到结果表格的数据源）。
       *
       * ⚠️ 只返回**今天**的行：跨日后旧行留在磁盘上无妨（下次写会归零），
       * 但界面上「今日领取」不能显示昨天的记录。
       *
       * ⚠️ 判据是「这一行自己的签到日」而**不是** `lastDate`：后者只由自动签到那一轮写，
       * 手动领取不会动它 —— 用 `lastDate` 会把手动领到的行判成"昨天的"而清空。
       *
       * ★ 2026-11-04：日界**逐行判**（`row.day ?? doc.resultsDay` 与该渠道的今日比）。
       * 全局 `resultsDay === today()` 有两个副作用：
       * 1. zcode 的签到日是 09:00 分界（`19:40 → 次日 09:00`）—— `00:30` 时全局
       *    判据会把昨晚 20:00 领的 zcode 行判成「昨天」而清空，与用户要求的
       *    「09:00 刷新」相反；
       * 2. 反过来，任何一次按 zcode 日界写的 `resultsDay` 都会污染其他渠道的行。
       * 逐行携带日界后，两边互不影响。
       */
      results: doc.results
        .filter((row) => {
          const day = row.day ?? doc.resultsDay
          return day !== '' && day === checkinDayString(row.provider, now())
        })
        .map((row) => ({ ...row })),
      // 面板据它决定要不要渲染那行常驻状态文字
      dismissed: doc.lastAt > 0 && doc.dismissedRunAt === doc.lastAt,
    }
  }

  /** 今天这个渠道的账本条目（跨日的条目一律视为不存在，见 `nextAttemptAt`）。 */
  function ledgerEntry(provider: string): AutoCheckinProviderLedger | undefined {
    const entry = doc.providers[provider]
    // ⚠️ 日界 per-provider：zcode 的一天是 `19:40 → 次日 09:00`（09:00 分界），
    // 用全局 `today()`（00:00 分界）会把同一个 zcode 签到日劈成两天。
    return entry !== undefined && entry.day === checkinDayString(provider, now()) ? entry : undefined
  }

  /** 本轮要不要跑这个渠道（跳过 = 今天已完成 / 已放弃 / 还没到重试时刻）。 */
  function shouldRunProvider(provider: string): boolean {
    return providerNeedsRun(ledgerEntry(provider), now(), provider)
  }

  /** 把一条账本写回（返回新文档对象，不改 `doc` 里的旧账本）。 */
  function withLedger(
    providers: Record<string, AutoCheckinProviderLedger>,
    provider: string,
    entry: AutoCheckinProviderLedger,
  ): Record<string, AutoCheckinProviderLedger> {
    return { ...providers, [provider]: entry }
  }

  /**
   * 一轮自动签到：逐渠道发起、按结局记账、补排下次重试。
   *
   * ## 结构说明（为什么 236 行不拆）
   *
   * 单渠道结算的全部状态都在循环体内：`base`（本渠道账本）、`totals`（累计）、
   * `ledgers`/`texts`（逐渠道产物）、`settle` 闭包（复用这四者）。若提成顶层
   * 函数，这些都要变成参数或上下文对象——签名比函数体还长，且 4 轮正确性
   * 修复（2026-10-26 缺陷 A/B、2026-11-04 zcode 窗口/日界、2026-11-05 上限
   * per-provider）每处都依赖局部语境，拆开只会把「一处改动」变成「跨函数追参」。
   * 审查建议（2026-11-05）评估后**维持现状**：以 `settle` 闭包为结算单元，
   * 各分支已有注释与 20 组测试守护。
   */
  async function performRun(providerIds: readonly string[]): Promise<void> {
    const totals = emptyTotals()
    /**
     * ⚠️ 账本日界**不能**在这里算一次全局值：zcode 的一天是 `19:40 → 次日 09:00`
     * （{@link zcodeCheckinDayString}），与其它渠道的 00:00 不同源。故每个渠道
     * 各取一次（`dayOf(provider)`）。
     */
    const dayOf = (provider: string): string => checkinDayString(provider, now())
    const runAt = now()
    const providers = [...providerIds]
    // ★ 本轮要跑的渠道 = 今天还没处理完的那些（per-provider 判据）。
    //   ⚠️ 被跳过的（已完成 / 已放弃 / 未到重试时刻）连 `claimAll` 都不调：
    //   「失败渠道当天重试」不等于「每次启动都把所有渠道再打一遍」。
    const due = new Set(providers.filter((provider) => shouldRunProvider(provider)))
    if (due.size === 0) {
      deps.warn?.(`[channel-pack] 自动签到：今日各渠道均已处理完（${providers.length} 个渠道），本轮无事可做`)
      return
    }
    let ledgers: Record<string, AutoCheckinProviderLedger> = { ...doc.providers }
    /** 本轮各渠道的短状态（按 provider 顺序收集，最后统一排序成 `channels`）。 */
    const texts = new Map<string, string>()
    // 今日已完成的渠道沿用上一次的短结果（面板仍要逐渠道显示），本轮不重跑。
    for (const entry of doc.channels) {
      if (providers.includes(entry.provider) && !due.has(entry.provider)) texts.set(entry.provider, entry.text)
    }

    for (const provider of providers) {
      if (!due.has(provider)) continue
      const previous = ledgerEntry(provider)
      const attempts = (previous?.attempts ?? 0) + 1
      // 记录一次「真跑过 claimAll」的尝试（跳过不计）。先落盘尝试次数，再打上游：
      // 万一这一轮把宿主拖崩，下次启动也不会把「没记过的重试」变成无限重试。
      const day = dayOf(provider)
      const base: AutoCheckinProviderLedger = {
        day,
        status: 'pending',
        attempts,
        lastAt: runAt,
        lastOutcome: previous?.lastOutcome ?? 'none',
        lastText: previous?.lastText ?? '',
      }
      // ⚠️ 排除表先于**任何**上游请求生效（见 isAutoCheckinExcluded 的说明）：
      // 代价发生在**调用期间**（拉起浏览器产 captcha），事后再判断已经太晚 ——
      // 必须在调 `claim` 之前就把它摘掉。
      if (isAutoCheckinExcluded(provider)) {
        totals.skipped += 1
        texts.set(provider, '需手动签到')
        // 排除的渠道今天不再跑（重试没有意义，且每次都有代价）。
        ledgers = withLedger(ledgers, provider, { ...base, attempts: 0, lastOutcome: 'skipped', status: 'skipped', lastText: '需手动签到' })
        continue
      }
      /**
       * ★ 签到窗口门控（2026-11-04，用户要求「每天 19:40 之后才能签」）。
       *
       * 窗口外**绝不**打上游：zcode 的 `preview` 在窗口外回空列表，跑了只会被
       * 误判成「今天已签」而不写 `lastDate` ⇒ 每次启动重来（白烧 captcha），
       * 更糟的是会把当天记成 `done` 而**19:40 之后不再跑**（真漏签）。
       *
       * 记账上留 `pending` 且 `attempts` 不增：这不是一次尝试，只是「还没到点」。
       * 面板给出可读的窗口提示，用户不必猜为什么没动静。
       */
      if (!checkinWindowOpen(provider, now())) {
        const hour = ZCODE_CHECKIN_OPEN_HOUR_UTC8
        const minute = ZCODE_CHECKIN_OPEN_MINUTE_UTC8
        const text = `每日 ${hour}:${String(minute).padStart(2, '0')} 后可签到`
        texts.set(provider, text)
        ledgers = withLedger(ledgers, provider, {
          ...base,
          attempts: previous?.attempts ?? 0,
          lastOutcome: 'none',
          status: 'pending',
          lastText: text,
        })
        continue
      }
      /**
       * 记一次未完成的尝试。
       *
       * ⚠️ 达到上限（`given-up`）时**改面板文字**：只写「出错」会让用户以为今天还在
       * 自动补救，而实际上已经放弃了 —— 用户要求「超限后记入今日已放弃并保留失败
       * 原因供 UI 展示」，故文字里带出原因与「今日已放弃」。
       */
      const settle = (outcome: AutoCheckinProviderLedger['lastOutcome'], text: string): void => {
        const entry = giveUpOrRetry(provider, base, outcome, text)
        if (entry.status === 'given-up') {
          totals.givenUp += 1
          // 账本与面板文字都带上「今日已放弃」：用户要能看出**今天不会**再自动补救了，
          // 而不是只看到一句「出错」以为还在后台重试。
          entry.lastText = `${text}·今日已放弃`
          texts.set(provider, entry.lastText)
        }
        ledgers = withLedger(ledgers, provider, entry)
      }
      let result: BadgeRpcResult<RpcCreditsClaimAllResponse>
      try {
        result = await deps.claim(provider)
      } catch (error) {
        totals.errors += 1
        texts.set(provider, '出错')
        deps.warn?.(`[channel-pack] 自动签到：${provider} 调用异常: ${String(error)}`)
        settle('error', '出错')
        continue
      }
      if (!result.ok) {
        const message = typeof result.error?.message === 'string' ? result.error.message : ''
        if (isUnsupportedCheckin(message)) {
          totals.skipped += 1
          texts.set(provider, '无签到接口')
          // 不支持签到的渠道今天不再跑（与旧行为一致：既不记失败也不重试）。
          ledgers = withLedger(ledgers, provider, { ...base, attempts: 0, lastOutcome: 'skipped', status: 'skipped', lastText: '无签到接口' })
          continue
        }
        totals.errors += 1
        texts.set(provider, '出错')
        deps.warn?.(`[channel-pack] 自动签到：${provider} 失败: ${message || '未知错误'}`)
        settle('error', '出错')
        continue
      }
      totals.providers += 1
      const summary = result.value?.summary
      if (summary === undefined) {
        // 信封成功但没给 summary：上游没回可判定的东西 ⇒ 与失败同处置（重试有限次）。
        texts.set(provider, '无可领')
        settle('error', '无可领')
        continue
      }
      totals.claimed += summary.claimed
      totals.totalCredit += summary.totalCredit
      // ★ 按单位累加（2026-10-04）：`totalByUnit` 缺省时回落到「全部按积分」，
      //   兼容尚未上报该字段的旧宿主响应 —— 与 `coversToday` 的兜底同思路。
      const byUnit = summary.totalByUnit ?? { credit: summary.totalCredit, token: 0 }
      totals.totalByUnit.credit += Number(byUnit.credit) || 0
      totals.totalByUnit.token += Number(byUnit.token) || 0
      totals.alreadyClaimed += summary.alreadyClaimed
      totals.inactive += summary.inactive
      totals.failed += summary.failed
      // ⚠️ 记账口径**只认**这一项：渠道用 `coversToday` 自己声明「这条痕迹是不是
      // 今天这一轮的」。缺省回落到 `claimed + alreadyClaimed`，是为了兼容尚未
      // 上报该字段的旧响应（缺字段 ≠ 0，否则整轮会被判成「什么都没证明」）。
      const coversToday = summary.coversToday ?? (summary.claimed + summary.alreadyClaimed)
      totals.coversToday += coversToday
      const text = describeChannel(summary)
      texts.set(provider, text)
      // ⚠️ 逐账号明细**不在这里记**：手动「一键领取」走的是同一个
      // `credits.claimAll`，但不会经过本函数 —— 记录点统一放在 RPC 层的
      // 共同出口（`AutoCheckin.recordClaimResult`），否则手动领取永远进不了表格。
      // ★ per-provider 记账（2026-10-26）：**只有 coversToday 为真**才算今天完成。
      //   失败与「非今日轮次」都留在 `pending`，下次启动（或当日补跑）再来。
      if (coversToday > 0) {
        ledgers = withLedger(ledgers, provider, {
          ...base,
          status: 'done',
          lastOutcome: summary.claimed > 0 ? 'claimed' : 'already-claimed',
          lastText: text,
        })
        continue
      }
      if (summary.failed > 0) {
        settle('failed', text)
        continue
      }
      // 到这儿只剩「有痕迹但渠道说不是今天的轮次」（Qoder 10:00 前那一轮）或
      // 什么都没发生（inactive）。前者必须**等到刷新时刻**再问，后者按普通重试。
      settle(summary.claimed + summary.alreadyClaimed > 0 ? 'stale' : 'none', text)
    }

    const result = describeRun(totals)
    // 账本只保留**当前账号池里**的渠道：账号删掉/渠道关闭后留下的旧条目会让
    // 「待补跑数」永远大于 0（见 `pendingProviderCount` 的说明）。
    const pruned: Record<string, AutoCheckinProviderLedger> = {}
    for (const provider of providers) {
      const entry = ledgers[provider]
      if (entry !== undefined) pruned[provider] = entry
    }
    /**
     * ★ 与 recordClaimResult 的并发合并（审查 2026-11-05，P3 竞态）：
     * 自动轮打 zcode（captcha 可达数十秒）期间，用户手动领取其它渠道会经
     * `recordClaimResult` 写入 providers[ch]=done 与 channels 文案。上面的
     * `ledgers`/`texts` 都是**回合开始前的快照**，直接 `providers: pruned`
     * 整体替换会把那笔手动记录覆盖回旧值——正是用户报过的
     * 「签到成功但没写进插件」的复发路径。
     *
     * 处理：写盘前从**最新 doc** 逐键合并——providers 先并（本轮快照优先，
     * 但本轮没碰的键保留最新值），channels 按 provider 合并（本轮文字优先，
     * 本轮没写的渠道保留手动回填的文案）。
     */
    const latest = doc.providers
    const mergedProviders: Record<string, AutoCheckinProviderLedger> = {}
    for (const [provider, entry] of Object.entries(latest)) {
      if (providers.includes(provider)) continue  // 本轮写过的渠道：以本轮快照为准（旧条目已被 pruned 过滤）
      mergedProviders[provider] = entry
    }
    Object.assign(mergedProviders, pruned)
    const latestChannels = doc.channels.filter(entry => !providers.includes(entry.provider))
    const runChannels = providers.filter((provider) => texts.has(provider)).map((provider) => ({ provider, text: texts.get(provider) ?? '' }))
    doc = {
      ...doc,
      // ⚠️ `lastDate` 保留**旧语义**：只有「今天确实有渠道被处理过」才写成今天。
      // 面板那句「今日已自动签到」读的就是它 —— 若整轮全失败也写成今天，界面会
      // 说「今日已签到」而用户一分没领到（方向不可逆的误报）。「今天还要不要再跑」
      // 完全看 `providers`，与这个展示字段无关。
      // ⚠️ `lastDate` 走**全局 00:00 口径**（`utc8DateString`），不是 per-provider 日界：
      // 它是面板那句「今日已自动签到」的数据源，改动会波及所有渠道的展示。
      lastDate: totals.coversToday > 0 ? utc8DateString(runAt) : doc.lastDate,
      lastResult: result,
      lastAt: runAt,
      providers: mergedProviders,
      // 逐渠道文字：本轮渠道按遍历顺序 + 本轮未触碰渠道的既有文案（并发保护）
      channels: [...runChannels, ...latestChannels],
      /**
       * 逐账号明细：**沿用 `doc.results`**，本函数不再重建它。
       *
       * ⚠️ 明细由 `recordClaimResult` 在**每次 claim 返回时**合并落盘（手动与自动
       * 共用那条路）。若这里用本轮的局部变量覆盖，会把本轮期间刚写入的行冲掉 ——
       * 更糟的是会把**手动领取**记下的行一起抹掉，因为本函数根本不知道它们。
       *
       * ⚠️ 只保留**当前账号池里**的渠道（与 `pruned` 同口径）：账号删掉/渠道关闭
       * 后留下的旧行会让表格里出现查无此账号的记录。
       */
      results: doc.results.filter((row) => providers.includes(row.provider)),
      resultsDay: doc.resultsDay,
      // ⚠️ 新一轮跑完要**清掉上一次的「已关闭」标记**：否则用户关过一次后，
      // 明天的新结果会被旧标记静默藏住（`dismissed` 的判据是 lastAt 相等）。
      dismissedRunAt: 0,
    }
    try {
      await deps.store.save(doc)
    } catch (error) {
      // 写盘失败 ⇒ 账本丢了，今天可能再跑一次（幂等，代价是多发一轮请求），如实告警。
      deps.warn?.(`[channel-pack] 自动签到结果写入失败（今天可能重复触发一次）: ${String(error)}`)
    }
    const left = pendingProviderCount(pruned, runAt, providers)
    deps.warn?.(
      left === 0
        ? `[channel-pack] 自动签到完成（${utc8DateString(runAt)}）：${result}`
        : `[channel-pack] 自动签到本轮结束（${utc8DateString(runAt)}），${left} 个渠道待补跑：${result}`,
    )
  }

  /**
   * 一次失败/未完成的尝试之后该记什么：达到上限就 `given-up`，否则留 `pending`
   * （由 `nextAttemptAt` 算出下次可跑时刻）。
   */
  function giveUpOrRetry(
    provider: string,
    base: AutoCheckinProviderLedger,
    outcome: AutoCheckinProviderLedger['lastOutcome'],
    text: string,
  ): AutoCheckinProviderLedger {
    // ★ 上限 per-provider（审查 2026-11-05）：zcode 是 2（ZCODE_MAX_ATTEMPTS_PER_DAY），
    //   其余 3。原先用全局常量 ⇒ zcode 永远不会置「今日已放弃」，面板停显失败原因。
    const exhausted = base.attempts >= maxAttemptsPerDay(provider)
    return {
      ...base,
      status: exhausted ? 'given-up' : 'pending',
      lastOutcome: outcome,
      lastText: text,
    }
  }

  /** 排一次「当日补跑」（不引入新定时器：复用 `deps.schedule`，`unref` 过）。 */
  function scheduleFollowUp(providerIds: readonly string[]): void {
    if (followUp !== null) return
    const at = nextPendingAttemptAt(doc.providers, now(), providerIds)
    if (at === null) return
    const ms = Math.max(0, at - now())
    const fire = (): void => {
      followUp = null
      // 到点时再判一次（中途可能被用户关掉开关 / 账本已变）。
      if (!doc.enabled) return
      void runIfDue()
    }
    followUp = (deps.schedule ?? defaultSchedule)(fire, ms)
    deps.warn?.(`[channel-pack] 自动签到：${Math.round(ms / 60_000)} 分钟后补跑未完成的渠道`)
  }

  /**
   * 排一枪「下一个签到窗口打开时再跑」（目前只有 zcode 有窗口）。
   *
   * 调用点在 `start()` 与 `runIfDue()` 末尾：窗口外启动 → 排到 19:40；
   * 到点跑完（无论成败）→ 这里会因为「已在窗口内」而不排，避免自旋。
   *
   * ⚠️ 与 `followUp` 一样必须 `unref()`（见 `defaultSchedule`），否则一个等到
   * 19:40 的定时器会拖住宿主进程退出。
   */
  function scheduleWindowWake(providerIds: readonly string[]): void {
    if (!doc.enabled) return
    if (windowTimer !== null) return
    // 只有真有窗口的渠道在场时才排（其余渠道没有窗口，排了就是空转）。
    const windowed = providerIds.filter((provider) => checkinWindowOpen(provider, now()) === false)
    if (windowed.length === 0) return
    const at = nextZcodeWindowOpenMs(now())
    if (at <= now()) return
    const ms = at - now()
    /**
     * @cap 24 小时：`nextZcodeWindowOpenMs` 正常不会给出更远的时刻（最多当天 19:40），
     * 但 `setTimeout` 的 32 位溢出（> 约 24.8 天会立刻触发）必须挡住 —— 溢出的
     * 后果是「一排就立刻跑」，那是窗口外跑 zcode，会被误判成今天已签。
     */
    if (ms > DAY_MS) return
    const fire = (): void => {
      windowTimer = null
      if (!doc.enabled) return
      deps.warn?.('[channel-pack] 自动签到：zcode 签到窗口已打开（19:40），开始跑一轮')
      void runIfDue()
    }
    windowTimer = (deps.schedule ?? defaultSchedule)(fire, ms)
    deps.warn?.(
      `[channel-pack] 自动签到：zcode 签到窗口将于 ${Math.round(ms / 60_000)} 分钟后打开，已排定到点自动跑`,
    )
  }

  function runIfDue(): Promise<void> {
    if (inflight !== null) return inflight
    if (!doc.enabled) return Promise.resolve()
    // ★ 判据换成 per-provider（2026-10-26）：只有**所有**渠道今天都已有结论
    //   （done / given-up / skipped）才什么都不做。旧的全局日期判据会把
    //   「今天跑过一轮但有渠道失败」当成已完成 ⇒ 那些渠道整天不再补救（缺陷 A），
    //   也会让 10:00 前跑的那一轮挡住 10:00 后的 Qoder 新轮次（缺陷 B）。
    // ⚠️ `running` 要**同步**置真：`setEnabled(true)` 返回的 state 得立刻显示
    // 「进行中」，否则用户点了开关看不到任何反应（见那里的注释）。判据只用**同步
    // 可得**的账本：今天还没有任何条目（= 全新的一天）或有待补跑的渠道 ⇒ 一定会
    // 干活；只有「今天的账本已全部有结论」才不置真（那时确实可能无事可做，由下面的
    // 账号池检查兜底 —— 新增渠道会被它发现并补跑）。
    const todayEntries = Object.values(doc.providers).filter((entry) => entry.day === today())
    if (todayEntries.length === 0 || todayEntries.some((entry) => entry.status === 'pending')) running = true
    const task = (async () => {
      let providerIds: string[] = []
      try {
        providerIds = [...new Set(await deps.listProviderIds())].sort()
      } catch (error) {
        deps.warn?.(`[channel-pack] 自动签到：读取账号池失败，本次跳过: ${String(error)}`)
        return
      }
      if (!providerIds.some((provider) => shouldRunProvider(provider))) {
        // 今天还有待补跑的渠道，但都还没到「可以再试」的时刻（例如 20 分钟前刚
        // 失败过）⇒ 把补跑排到最早那一刻，别让用户非等到下次启动。
        // ⚠️ `scheduleFollowUp` 取的是**未来**时刻，故不会自旋（见那里的说明）。
        if (pendingProviderCount(doc.providers, now(), providerIds) > 0) scheduleFollowUp(providerIds)
        // ★ 19:40 前启动的常见形态就落在这里（zcode 还没到窗口）⇒ 必须排窗口枪，
        // 否则用户上午开 DSH、晚上一直开着，就永远不会自动签。
        scheduleWindowWake(providerIds)
        return
      }
      running = true
      await performRun(providerIds)
      // 还有待补跑的渠道 ⇒ 排一次当日补跑（到点自己再判一次）；都处理完了就把
      // 之前排定的补跑撤掉（否则会留一个到点空转的定时器）。
      if (pendingProviderCount(doc.providers, now(), providerIds) > 0) scheduleFollowUp(providerIds)
      else {
        followUp?.cancel()
        followUp = null
      }
      // 窗口外（19:40 之前 / 09:00 之后已跑完的那种）⇒ 排到窗口打开时刻。
      // 窗口内调用恒不排（`scheduleWindowWake` 自己判），故不会自旋。
      scheduleWindowWake(providerIds)
    })().catch((error: unknown) => {
      deps.warn?.(`[channel-pack] 自动签到异常: ${String(error)}`)
    }).finally(() => {
      running = false
      inflight = null
    })
    inflight = task
    return task
  }

  return {
    state,
    async setEnabled(enabled) {
      doc = { ...doc, enabled }
      await deps.store.save(doc)
      // 关掉开关时撤掉已排定的当日补跑：用户关掉后不该再被后台打一轮上游。
      if (!enabled) {
        followUp?.cancel()
        followUp = null
        windowTimer?.cancel()
        windowTimer = null
      }
      // 打开开关时立刻尝试一轮（今天已跑过则由 runIfDue 内部拦住）。
      // ⚠️ 不 await：一轮要串行打十几个上游，让按钮等它会让界面像卡死；
      // `state()` 里的 `running` 会立刻变成 true，界面据此显示「进行中」。
      if (enabled) void runIfDue()
      return state()
    },
    start() {
      if (pending !== null) return
      const ms = deps.delayMs ?? autoCheckinDelayMs()
      const fire = (): void => {
        pending = null
        void runIfDue()
      }
      // 延迟为 0 = 立刻跑（单测的默认形态，也是用户把环境变量设成 0 时的语义）。
      if (ms <= 0) {
        fire()
        return
      }
      pending = (deps.schedule ?? defaultSchedule)(fire, ms)
    },
    runIfDue,
    async recordClaimResult(provider, value) {
      if (value === undefined) return
      // ⚠️ 手动签到与自动签到共用本方法 ⇒ 日界必须与自动那边同源（zcode 09:00）。
      const day = checkinDayString(provider, now())
      const summary = value.summary
      if (summary === undefined) return
      // 与 `providers` 的记账判据同源：只收**覆盖今天**的结果。
      // 「刷新前那一轮」（Qoder 10:00 前看到昨天那条）不能进今日表格。
      const coversToday = summary.coversToday ?? (summary.claimed + summary.alreadyClaimed)
      if (coversToday <= 0) return
      const incoming = aggregateAccountRows(provider, value.results ?? [])
      if (incoming.length === 0) return
      // ★ 每行带上自己的签到日（zcode 09:00 分界，其余 00:00；见 `checkinDayString`）。
      for (const row of incoming) row.day = day
      /**
       * 跨日归零：**只**与同一签到日的旧行合并（逐行判，不是全局 `resultsDay`）。
       * 否则 zcode 的 09:00 日界会把其他渠道昨天的行一起保留/清掉。
       */
      const base = doc.results.filter((row) => row.provider === provider && (row.day ?? doc.resultsDay) === day)
      const merged = new Map(base.map((row) => [`${row.provider}\u0000${row.accountId}`, row]))
      for (const row of incoming) {
        const key = `${row.provider}\u0000${row.accountId}`
        merged.set(key, mergeAccountResult(merged.get(key), row))
      }
      /*
       * ★ 同步更新**渠道级**状态（真实缺陷，用户 2026-11-04 报「你帮我签到成功后
       * 好像没有写进插件里」）。
       *
       * 症状：手动点「一键领取」成功、逐账号明细也落了盘，但面板上该渠道那行
       * 永远停在自动签到留下的旧文案 —— zcode 就是「需手动签到」，因为它在
       * `isAutoCheckinExcluded` 排除表里，自动签到每轮都只在 `providers` 里写
       * `skipped`，**从不**由 claim 结果回填。于是用户看到「签到成功了」与
       * 「面板还说要手动签到」并存，无法判断到底成没成。
       *
       * 口径与自动签到那一轮一致（`performRun` 的 `coversToday > 0` 分支）：
       * 覆盖到今天就把状态记成 `done`，文案用同一套 `describeChannel`，
       * 保证手动与自动写出来的行**长得一样**。
       *
       * ⚠️ 只覆盖 `done`，不动 `pending`/`given-up`：那是自动签到「还要再试」
       * 的判断依据，手动领一笔不该把它清掉。
       */
      const text = describeChannel(summary)
      const previousLedger = ledgerEntry(provider)
      const sameDay = previousLedger?.day === day
      /*
       * ★ 结局**只许升级、不许降级**：同一天里领到过（`claimed`）之后，用户再点
       * 一次「一键领取」上游只会回「今天已领」——若照抄那条，面板就从「2 个 +600M」
       * 退回「1 个今天已领」，看起来像刚才那笔没了（与 `mergeAccountResult` 同一条
       * 语义，两处必须一致，否则表格说领到了、状态行说没领到）。
       */
      const rankOf = (outcome: AutoCheckinProviderLedger['lastOutcome'] | undefined): number =>
        outcome === 'claimed' ? 3 : outcome === 'already-claimed' ? 2 : outcome === 'failed' ? 1 : 0
      const incomingOutcome: AutoCheckinProviderLedger['lastOutcome'] =
        summary.claimed > 0 ? 'claimed' : 'already-claimed'
      const keepPrevious = sameDay === true && rankOf(previousLedger?.lastOutcome) > rankOf(incomingOutcome)
      const ledger: AutoCheckinProviderLedger = {
        day,
        status: 'done',
        // 手动领取不是自动那一轮的「尝试」，别虚增重试计数（虚增会让
        // `given-up` 提前触发，自动签到少试几次）。
        attempts: sameDay ? previousLedger.attempts : 0,
        lastAt: now(),
        lastOutcome: keepPrevious ? previousLedger.lastOutcome : incomingOutcome,
        lastText: keepPrevious ? previousLedger.lastText : text,
      }
      const channels = doc.channels.some((entry) => entry.provider === provider)
        ? doc.channels.map((entry) => (entry.provider === provider ? { provider, text: ledger.lastText } : entry))
        : [...doc.channels, { provider, text: ledger.lastText }]
      /**
       * ⚠️ 写回时**保留其他渠道仍在有效期内的行**（真实隐患）：
       * `merged` 只含「本渠道同一签到日」的行，直接整体替换会把别的渠道刚领的
       * 行一起删掉 —— 尤其 `00:30` 这类「zcode 还是昨天、其他渠道已是今天」的
       * 时刻，zcode 领一次就会清空其他渠道当天的表格。
       */
      const others = doc.results.filter((row) => {
        if (row.provider === provider) return false
        const rowDay = row.day ?? doc.resultsDay
        return rowDay !== '' && rowDay === checkinDayString(row.provider, now())
      })
      /**
       * ★ 用「provider\0accountId」为键**再合一次**，而不是直接拼数组
       * （真实缺陷，2026-11-04 用户报「签到结果栏炸了，一堆签到结果」）。
       *
       * 原写法 `[...others, ...merged.values()]` 依赖「两者不相交」这个隐含前提，
       * 而 `base` 当时没按 provider 过滤 ⇒ 本渠道的行同时进了 `merged` 和 `others`，
       * 于是每写一次结果就多出一份（当场表格里同一条记录出现 3 次）。
       *
       * 以 Map 重建是**结构上**免疫：只要键相同就只有一行，不依赖调用方是否守规矩；
       * 顺带把历史文档里已经写进去的重复行收敛回一行（自愈，不必手工清盘）。
       */
      const final = new Map<string, AutoCheckinAccountResult>()
      for (const row of others) final.set(`${row.provider}\u0000${row.accountId}`, row)
      for (const row of merged.values()) final.set(`${row.provider}\u0000${row.accountId}`, row)
      doc = {
        ...doc,
        results: [...final.values()],
        // 全局字段只服务**旧文档**（行上没有 `day` 时回落到它）：保持 00:00 口径，
        // 不写 zcode 的 09:00 日界，否则会给其他渠道的旧行换了参照系。
        resultsDay: utc8DateString(now()),
        providers: withLedger(doc.providers, provider, ledger),
        channels: sanitizeChannels(channels),
      }
      try {
        await deps.store.save(doc)
      } catch (error) {
        // 写盘失败只影响表格展示，不能把领取本身判成失败（积分已经到账了）。
        deps.warn?.(`[channel-pack] 签到明细写入失败（不影响已领取的积分）: ${String(error)}`)
      }
    },
    async dismiss() {
      // 记「关闭的是哪一轮」（当前的 lastAt）：下一轮跑完 lastAt 会变，文字自动回来。
      doc = { ...doc, dismissedRunAt: doc.lastAt }
      try {
        await deps.store.save(doc)
      } catch (error) {
        // 写盘失败 ⇒ 重开面板时那行文字会再出现（还可再点一次关闭），如实告警。
        deps.warn?.(`[channel-pack] 自动签到状态文字关闭标记写入失败: ${String(error)}`)
      }
      return state()
    },
    stop() {
      pending?.cancel()
      pending = null
      followUp?.cancel()
      followUp = null
      windowTimer?.cancel()
      windowTimer = null
    },
  }
}

/**
 * 默认排定：`setTimeout` + `unref()`。
 *
 * ⚠️ `unref()` 是必须的：否则一个 30 秒的待执行定时器会**拖住宿主进程退出**
 *（用户关掉 DSH 后进程还要多活半分钟）。与 `index.ts` 的续期定时器同一处理。
 */
function defaultSchedule(fn: () => void, ms: number): { cancel(): void } {
  const timer = setTimeout(fn, ms)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}
