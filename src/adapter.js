/**
 * The provider adapter.
 *
 * It satisfies the harness adapter contract structurally — `registerAdapter`
 * validates by calling the methods, not by an `instanceof` test — which is what
 * lets this plugin mount on more than one kernel line without importing a
 * version-pinned adapter base class.
 *
 * Two routes are published from one adapter instance, because the harness groups
 * the model picker strictly by provider route and offers no other grouping
 * field: `our-free-model` carries what this egress can use right now, and
 * `our-free-model-region` carries what the gateway refuses on this egress. A
 * group with no models is dropped from the picker by the client, so a user whose
 * VPN unlocks the region-gated models sees one group, and a user without sees
 * the second group labelled as such.
 *
 * @module src/adapter.js
 */

import { applyFingerprint, baseModelId, endpointFor, mintRequestId, sessionForConversation, wireFor } from './upstream.js'
import { toChatMessages, toClaudeMessages, toResponseInput, toToolDefs, repairToolPairing } from './messages.js'
import { CODE, UpstreamError, postStreamed } from './http.js'
import { postKiloStreamed } from './kilo.js'
import { finishReason, readStream, sanitizeUsage, windowTokens } from './stream.js'
import { DEFAULT_LEVEL, MIN_BUDGET, budgetFor, defaultEffortFor, effortPatchFor, effortsFor, hasDeclaredEffortMenu, resolveLevel } from './effort.js'
import { createChannel } from './channel.js'
import { recoveryPolicy, canRecover, canRecoverSilentStop, recoveryMessages, continuationMessages, checkpointFits, addUsage, createBlockTracker } from './recovery.js'
import { isKiloEntry } from './catalog.js'
import { isComboEntry, comboChain, noteComboServed, comboRotationSlot } from './combos.js'
import { isChannelEntry, parseChannelModelId, FALLBACK_CONTEXT_WINDOW } from './channel-catalog.js'
import { applyTokenSavers, saverConfig } from './token-saver/index.js'
import { classifyFailure, describeVerdict, shouldAdvance } from './route/classify.js'
import { FALLBACK_IMAGE_PRICING } from './image-pricing.js'

export const ROUTE_MAIN = 'our-free-model'
export const ROUTE_REGION = 'our-free-model-region'

/** Group headings — the only strings the picker shows as a section title. */
export const ROUTE_LABELS = {
  [ROUTE_MAIN]: 'Our Free Model',
  [ROUTE_REGION]: 'Our Free Model · region-limited',
}

const STYLE_FOR_WIRE = { chat: 'chat', responses: 'flat', messages: 'claude' }

export class FreeModelAdapter {
  /**
   * @param {object} dependencies
   * @param {() => {catalog: Array<object>, membership: Record<string, string[]>, settings: object, attributionUserAgent: string}} dependencies.state
   * @param {(ref: object) => string | undefined} [dependencies.resolveImage]
   * @param {(record: object) => void} dependencies.recordUsage
   * @param {(record: object) => void} [dependencies.recordTurn]
   * @param {(message: string) => void} [dependencies.warn]
   * @param {(message: string) => void} [dependencies.log]
   *
   * ⚠️ `log` 与 `warn` 是**两个**依赖，别把 `log` 当成 `warn` 的别名随手省掉
   * （真实缺陷，2026-11-10）：`runCombo` 每次作答都调 `this.deps.log?.(...)`
   * 记「本轮由谁作答」，而装配层（`src/core/runtime.js`）**只注入了 `warn`**、
   * 没有 `log` ⇒ 可选链静默吞掉，一行都不输出。后果是用户完全无法确认轮询
   * 有没有在转（反馈原话「为什么路由功能没有在轮询」），而实测它一直在转
   * （账本里 trae/raccoon/officeace 的分布就是证据）。语义上也该分开：
   * `log` 是「正常诊断信息」，`warn` 是「确实出问题了」——把成功作答也写成
   * warn 会让真正的告警被淹没。
   */
  constructor(dependencies) {
    this.deps = dependencies
    /**
     * 链路成员的临时禁用期：模型 id -> 解禁时刻（ms）。
     *
     * 为什么需要它：一条链路每个回合都从队首开始走。队首那个渠道今早已经
     * 把额度打光、或者凭据过期，于是**每一回合**都要先在它身上失败一次再换人
     * ——用户看到的是每次都慢上十几秒，日志里是同一条上游错误反复出现。
     * 失败信息本身（`verdict.cooldownMs`）已经说明了「多久之后再来」，这里只是
     * 把它记下来，下一回合把还在禁期里的成员排到队尾，而不是丢掉它们：
     * 额度是会恢复的，链路不该因为一次 429 就永久少一个成员。
     */
    this.chainCooldown = new Map()
  }

  providerInfo(provider) {
    return { id: provider, name: ROUTE_LABELS[provider] ?? provider }
  }

  /**
   * A fully resolved policy, not a configuration fragment.
   *
   * Both the 0.1.5 and 0.1.7 kernels store this object verbatim instead of
   * running it through their policy resolver, and the backoff scheduler reads the
   * delay fields off the top level. Reporting them nested under `backoff` makes
   * every scheduled delay `NaN`, which the durable session log then rejects —
   * turning a recoverable transient failure into an aborted turn.
   */
  providerRetryPolicy() {
    return Object.freeze({
      mode: 'normal',
      maxRetries: 2,
      // A regional refusal is a property of the egress, not a transient fault;
      // retrying it only spends quota. It is deliberately absent here. So is
      // RATE_LIMIT: this lane's 429 carries a *growing* retry-after, and the two
      // automatic retries turned every quota wall into three walls — the same
      // turn, paid thrice, arriving later (issue #13).
      retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
      initialDelayMs: 700,
      maxDelayMs: 8000,
      jitterRatio: 0.2,
    })
  }

  /**
   * Resolve provider-side request-image pricing for one exact model route.
   *
   * 宿主 spill-policy 遇到 undefined 会放弃整条含图结果的落盘（issue #151）。
   * 免费出口没有统一视觉计价协议，提供同步估算以支持预算与落盘。
   *
   * Must stay synchronous: the token meter resolves it per measurement, with no
   * I/O window (issue #42).
   *
   * @param {string} _provider - a route passed to `registerAdapter()` for this instance.
   * @param {string} _model - exact model id passed to GenerateOptions.model.
   * @returns {typeof FALLBACK_IMAGE_PRICING} 视觉 Token 估算，不是厂商真实消耗。
   */
  imageRequestPricing(_provider, _model) {
    return FALLBACK_IMAGE_PRICING
  }

  /** Models this route advertises right now. */
  async listModels(provider) {
    const state = this.deps.state()
    const ids = new Set(state.membership[provider] ?? [])
    return state.catalog
      .filter(entry => ids.has(entry.id))
      .map(entry => ({
        provider,
        id: entry.id,
        name: entry.name,
        description: describe(entry, state.settings),
        inputModalities: entry.vision ? ['text', 'image'] : ['text'],
      }))
  }

  async resolveModel(provider, model) {
    const state = this.deps.state()
    const entry = state.catalog.find(candidate => candidate.id === baseModelId(model))
    if (entry === undefined) {
      return {
        provider,
        id: baseModelId(model),
        name: baseModelId(model),
        context: { contextWindow: FALLBACK_CONTEXT_WINDOW },
        defaultMaxTokens: 8192,
      }
    }
    const ceiling = Math.min(entry.maxOutput, state.settings.defaultMaxTokens ?? 32768)
    const efforts = effortsFor(entry, undefined, state.settings.defaultMaxTokens)
    return {
      provider,
      id: entry.id,
      name: entry.name,
      inputModalities: entry.vision ? ['text', 'image'] : ['text'],
      context: { contextWindow: entry.contextWindow },
      defaultMaxTokens: ceiling,
      ...efforts === undefined ? {} : { reasoning: { efforts, defaultEffort: defaultEffortFor(entry) } },
    }
  }

  /**
   * Bind model metadata and the dispatch closure to one state snapshot, so a
   * catalog refresh arriving mid-turn cannot mix one generation's capacities
   * with another's endpoint table.
   */
  async prepareCall(provider, model) {
    const snapshot = this.deps.state()
    const entry = snapshot.catalog.find(candidate => candidate.id === baseModelId(model)) ?? null
    return {
      model: await this.resolveModel(provider, model),
      stream: options => this.stream(options, entry, snapshot),
    }
  }

  /**
   * @param {object} options - GenerateOptions
   * @param {object|null} pinned - catalog row frozen by `prepareCall`, if any
   * @param {object} [snapshot] - state generation frozen by `prepareCall`
   */
  stream(options, pinned, snapshot = this.deps.state()) {
    const controller = new AbortController()
    const onAbort = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted === true) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
    const iterator = this.runStream({ ...options, signal: controller.signal }, pinned, snapshot)
    const cleanup = () => options.signal?.removeEventListener('abort', onAbort)
    const step = async (method, value) => {
      try {
        const row = await iterator[method](value)
        if (row.done) cleanup()
        return row
      } catch (error) {
        cleanup()
        throw error
      }
    }
    // 原生生成器把 return 排在 pending next 后；先取消请求才能立即退出。
    return {
      [Symbol.asyncIterator]() { return this },
      next: value => step('next', value),
      return: value => { controller.abort(); cleanup(); return step('return', value) },
      throw: error => { controller.abort(error); cleanup(); return step('throw', error) },
    }
  }

  /**
   * One turn: a combo walks its chain, everything else is a single model.
   *
   * A combo is a virtual model, so it reaches here as a pinned catalog row like
   * any other; the only difference is that its row carries a chain instead of an
   * endpoint. Resolving that here — rather than at the picker or the gateway —
   * means both callers get the failover for free.
   */
  async * runStream(options, pinned, snapshot) {
    const modelId = baseModelId(options.model)
    const entry = pinned ?? snapshot.catalog.find(candidate => candidate.id === modelId) ?? null
    if (entry !== null && isComboEntry(entry)) {
      yield * this.runCombo(options, entry, snapshot)
      return
    }
    if (entry !== null && isChannelEntry(entry)) {
      yield * this.runChannel(options, entry)
      return
    }
    yield * this.runSingle(options, entry, snapshot, {})
  }

  /**
   * Walk a combo's chain until one candidate produces output.
   *
   * The commit rule is the whole design. Chunks are held in a buffer until the
   * first answer-bearing delta, so a candidate that fails before that point is
   * discarded whole: the caller never saw a byte of it, and switching models is
   * invisible. Reasoning deltas are deliberately *not* a commit — "thought for a
   * minute, then hit a quota wall" is the single most valuable case to fail over,
   * and the held thinking is dropped along with the rest of the discarded try.
   *
   * Once an answer delta has been handed over the answer is the caller's, and a
   * later failure ends the turn the normal way — the single-model recovery path
   * inside `runSingle` still gets its continuation attempt first.
   */
  async * runCombo(options, entry, snapshot) {
    const settings = snapshot.settings ?? {}
    const started = Date.now()
    const rejectedTurn = attempts => {
      this.deps.recordTurn?.({ at: started, model: entry.id, ok: false, recovered: false, attempts, origin: 'harness' })
    }
    // 2026-11-07（用户）：开关（settings.enabled）只管**免费车道**。链路成员若是
    // 渠道模型，开关关掉也不应拦截（历史遗漏：路由早已支持渠道模型）；免费成员
    // 的拦截由 runSingle 内部的同款判断承担 —— 这里不再一刀切。
    /**
     * ★ 轮询铁律（用户 2026-11-05）：**无视禁期、无视限流**。
     *
     * `orderByCooldown` 是给 fallback（质量阶梯）用的：把禁期成员压到队尾，
     * 让健康的先上。但轮询的次序必须严格等于 `comboChain` 按名额排出来的
     * 顺序 —— 重排会让「本轮名额的主人」掉到队尾，别人顶上，游标名义在转
     * 实际名额全乱（探针实测：officeace 头部 ×10 不动，就是重排+失败换人
     * 互相拉扯的结果）。
     *
     * 轮到坏成员：本回合内顺延到下一个候选（循环里的失败分支），
     * 该发请求不给它记名额。
     */
    const isRoundRobin = entry.strategy === 'round-robin'
    const candidates = isRoundRobin
      ? comboChain(entry, snapshot.catalog)
      : this.orderByCooldown(comboChain(entry, snapshot.catalog))
    /**
     * ★ 链路成员**从目录里消失**时必须出声（真实盲区，2026-11-10）。
     *
     * `comboChain` 用 `ids.map(id => byId.get(id)).filter(row => row !== undefined)`
     * 把「目录里查不到的成员」**静默丢掉**——于是链路上少了一个成员，用户与
     * 排查者都看不出来：成员明明写在设置里，却从不出现在日志、也从不被调用。
     *
     * 这正是本次「qodercn 在路由里从未出现」的候选解释之一（它的模型行若在
     * 目录快照里缺失，就会被这样丢掉）。差别很关键：
     * - 「被丢掉」= 配置里写了但根本没参与轮询（要修的是目录/可见性）；
     * - 「轮到了但失败」= 会走下面的 `advanced past` 日志（要修的是上游）。
     * 两者此前**都表现为「从没出现」**，无法区分，故这里补一条明确诊断。
     */
    const declared = Array.isArray(entry.combo) ? entry.combo : []
    if (declared.length > 0 && candidates.length < declared.length) {
      const present = new Set(candidates.map(row => row.id))
      const missing = declared.filter(id => !present.has(id))
      this.deps.warn?.(
        `our-free-model: chain "${entry.name}" is missing ${missing.length}/${declared.length} member(s) `
        + `from the catalog and they will not be rotated: ${missing.join(', ')}`,
      )
    }
    if (candidates.length === 0) {
      rejectedTurn(0)
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `the chain "${entry.name}" has no model available on this egress`, code: CODE.server } } }
      return
    }
    const tried = []
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]
      // 链上的候选可以是三种东西之一，派发路径各不相同：
      // - 免费车道模型：走 `runSingle`（本插件自己的 wire）；
      // - 渠道模型：走 `runChannel`（交回宿主 `prepareCall`）；
      // - 嵌套链路：不允许（normalizeCombos 已经排除自引用，这里只兜底）。
      // 早先这里无条件走 `runSingle`，渠道候选会被当成免费车道模型名去拼请求，
      // 上游回 400 —— 症状是「链路里的渠道成员永远失败」，而单独测那个渠道是通的。
      const iterator = isChannelEntry(candidate)
        ? this.runChannel({ ...options, model: candidate.id }, candidate)
        : this.runSingle(options, candidate, snapshot, {
          wire: wireOf(candidate),
          turnModel: entry.id,
          recordTurn: false,
          allowAdvance: true,
        })
      let committed = false
      let result
      const held = []
      while (true) {
        const row = await iterator.next()
        if (row.done === true) { result = row.value; break }
        if (committed) { yield row.value; continue }
        held.push(row.value)
        if (commitsAnswer(row.value)) {
          committed = true
          for (const chunk of held) yield chunk
          held.length = 0
        }
      }
      if (committed) {
        // 这个成员刚刚答出来了，禁期立刻作废 —— 否则一次误判会让它在队尾
        // 待满整个冷却时长。
        this.chainCooldown.delete(candidate.id)
        /**
         * ⚠️ 记下「本轮实际由谁作答」并**打日志**（2026-11-04 用户反馈
         * 「设了 10 次就换，一直没实现」）。
         *
         * 轮询本来是生效的（实测 stickyLimit=10 时第 11 回合才切换），但
         * 对外只暴露链路名 `combo:xxx`，用户无法确认它到底有没有轮 ——
         * 「看不到」等于「没实现」。这条日志让每次作答都留下可核对的记录。
         */
        noteComboServed(entry.id, candidate.id)
        /**
         * ★ 字号必须带上**游标进度**（`2026-11-10`）：只写 `served by X` 时，
         * 用户看到连续 10 次都是同一个成员，仍会怀疑「是不是没在轮」。
         * 把「第几个名额 / sticky 上限」一并写出来，就不用二次推算：
         *
         * ```text
         * served by channel:trae/glm-5.3-flash (candidate 1/5, round-robin, sticky 10, slot 3/10)
         * ```
         *
         * `slot` 取自 `comboChain` 已经写回的游标（`used` 在满额那一刻归零，
         * 故这里用 `used || limit` 表达「本轮是这一期名额的最后一次」）。
         */
        const slot = comboRotationSlot(entry)
        this.deps.log?.(
          `our-free-model: chain "${entry.name}" served by ${candidate.id}`
          + ` (candidate ${index + 1}/${candidates.length}`
          + `, strategy ${entry.strategy ?? 'fallback'}`
          + `${entry.strategy === 'round-robin' ? `, sticky ${entry.stickyLimit ?? 1}` : ''}`
          + `${slot === null ? '' : `, slot ${slot}`})`,
        )
        /*
         * ★ 成功作答后**不动游标**（用户 2026-11-04 的轮询规则）：
         *
         * > 1-N 循环轮动每个渠道，成功了就继续下 9 次请求，失败了就下一个渠道。
         * > 循环的轮，不存在降级/隔离/抛弃。
         *
         * 「成功」的含义就是**这个渠道接着服务**：游标原地不动，靠 `comboChain`
         * 的 `used` 计数攒满 `stickyLimit` 次后才自然前移一位。
         *
         * ⚠️ 这里原先写的是 `advanceComboCursor(...)` —— 那是**失败换人**用的
         * （前移到下一个渠道），拿它处理「成功」等于「刚答出来的渠道立刻被跳
         * 过」，且计数被清零 ⇒ 它永远攒不满 10 次。于是队首渠道反复兜底、
         * 其它渠道几乎不出现（用户截图里 officeace 只出现 1 次就是它）。
         */
        this.deps.recordTurn?.({ at: started, model: entry.id, ok: result?.ok === true, recovered: result?.recovered === true, attempts: index + 1, origin: 'harness' })
        return
      }
      if (result?.advance !== true) {
        // Not a candidate fault — an abort, or a failure that arrived after the
        // single-model recovery budget was spent. Hand the caller the real
        // ending instead of pretending another model could have saved it.
        for (const chunk of held) yield chunk
        rejectedTurn(index + 1)
        return
      }
      const reason = result.verdict === null || result.verdict === undefined ? 'failed' : describeVerdict(result.verdict)
      // ★ 失败详情落日志（2026-11-05）：`failure` 由 runSingle/runChannel 的
      // 失败 return 顺带带出；只记 verdict 概括看不出是 429 还是派发层错误。
      const failureMessage = result?.failure?.message ?? result?.error?.message ?? ''
      this.deps.warn?.(`our-free-model: chain "${entry.name}" candidate ${candidate.id} failed — ${reason}${failureMessage ? `: ${failureMessage.slice(0, 300)}` : ''}`)
      this.markFaulty(candidate.id, result.verdict)
      /**
       * ★ 失败的成员（轮询铁律，2026-11-05）：
       *
       * > 循环的轮，不存在降级/隔离/抛弃。
       *
       * 本回合内顺延到下一个候选作答；**游标不动** —— 名额归属只在
       * `comboChain`（回合开始计一次），被跳过的成员不额外占名额，也不被
       * 剔出循环：转一圈回来仍会轮到它、届时照样先试。markFaulty 的禁期
       * 照记，但只有 fallback（顺序降级）模式读它重排。
       */
      tried.push(`${candidate.id} (${reason})`)
      this.deps.warn?.(`our-free-model: chain "${entry.name}" advanced past ${candidate.id} — ${reason}`)
    }
    rejectedTurn(candidates.length)
    // 2026-11-08 终审 R10：链路耗尽改不可重试码——此前返 CODE.server 而宿主
    // retryableCodes 含 SERVER，内核会把**整条链**原样重放（×2），每候选独立
    // 预算下最坏 N×30min×3。耗尽是「这条链的全部成员都拒了本次回合」，重放
    // 同一条链没有意义；真要再试由用户重新发起回合。
    yield { type: 'finish', reason: { kind: 'error', failure: {
      message: `the chain "${entry.name}" exhausted every candidate: ${tried.join('; ')}`,
      code: CODE.client,
    } } }
  }

  /**
   * 把还在禁期里的成员挪到队尾。
   *
   * 顺序本身是策略的一部分（fallback = 质量阶梯，round-robin = 轮转），所以
   * 只做「稳定分组」：健康的保持原有相对顺序在前，禁期内的保持原有相对顺序在
   * 后。全员都在禁期里时不重排 —— 那样等于每回合都从队尾开始，反倒随机。
   */
  orderByCooldown(candidates) {
    if (this.chainCooldown.size === 0) return candidates
    const now = Date.now()
    for (const [id, until] of this.chainCooldown) if (until <= now) this.chainCooldown.delete(id)
    if (this.chainCooldown.size === 0) return candidates
    const healthy = candidates.filter(candidate => !this.chainCooldown.has(candidate.id))
    const cooling = candidates.filter(candidate => this.chainCooldown.has(candidate.id))
    return healthy.length === 0 ? candidates : [...healthy, ...cooling]
  }

  /** 记录一次成员失败给出的冷却时长；判不出来时按一分钟保守处理。 */
  markFaulty(id, verdict) {
    const suggested = Number(verdict?.cooldownMs)
    const wait = Number.isFinite(suggested) && suggested > 0 ? suggested : 60_000
    // 上限 30 分钟：上游偶尔回一个荒谬的 retry-after，不该让成员消失半天。
    this.chainCooldown.set(id, Date.now() + Math.min(wait, 30 * 60_000))
    // 别让它无限增长：过期项顺手清掉。
    if (this.chainCooldown.size > 64) {
      const now = Date.now()
      for (const [key, until] of this.chainCooldown) if (until <= now) this.chainCooldown.delete(key)
    }
  }

  /**
   * One turn for an absorbed channel model — delegated, not spoken here.
   *
   * A channel model's endpoint, credential and wire belong to the provider that
   * registered it. This plugin has no business re-implementing any of them, so
   * the whole call is handed back to the host: `prepareCall(provider, model)`
   * resolves that provider's own adapter and returns a bound `stream`.
   *
   * Two things are rewritten on the way through, and only these two:
   *
   * - `provider`/`model` name the *channel*, not this route (the host would
   *   otherwise re-enter this same adapter and recurse);
   * - the caller's `reasoningEffort` is dropped. This plugin's effort ids are
   *   the free lane's ladder (`off`/`low`/`high`…); the channel's own ids are
   *   upstream-private (`light`, `xhigh`, `max`) and passing one through would
   *   produce a 400. The channel applies its own default, which is what a user
   *   who never configured that channel expects anyway.
   *
   * Failures are yielded as the normal terminal `finish` chunk rather than
   * thrown, so a chain can classify them and advance like any other candidate.
   */
  async * runChannel(options, entry) {
    const settings = (this.deps.state().settings) ?? {}
    const started = Date.now()
    const target = parseChannelModelId(entry.id)
    const fail = (message, code) => ({
      type: 'finish',
      reason: { kind: 'error', failure: { message, code } },
    })
    // 2026-11-07（用户）：渠道车道不受「启用免费模型」开关影响 —— 该开关只关
    // 本插件自己的免费车道；渠道模型凭据在各自渠道，与开关无关（历史遗漏修复：
    // 路由/链路调用渠道模型曾被这里一刀切拦死）。
    if (target === undefined) {
      this.deps.recordTurn?.({ at: started, model: entry.id, ok: false, recovered: false, attempts: 0, origin: 'harness' })
      yield fail(`"${entry.id}" is not a channel model id`, CODE.server)
      return { advance: false, verdict: null, ok: false }
    }
    const prepare = this.deps.prepareChannelCall
    if (typeof prepare !== 'function') {
      this.deps.recordTurn?.({ at: started, model: entry.id, ok: false, recovered: false, attempts: 0, origin: 'harness' })
      yield fail(`channel ${target.provider} is unavailable: the host does not expose prepareCall`, CODE.server)
      return { advance: false, verdict: null, ok: false }
    }

    let handle
    try {
      handle = await prepare(target.provider, target.model, options.signal)
    } catch (error) {
      const message = String(error?.message ?? error)
      this.deps.recordTurn?.({ at: started, model: entry.id, ok: false, recovered: false, attempts: 0, origin: 'harness', message })
      yield fail(`channel ${target.provider} could not resolve "${target.model}": ${message}`, CODE.server)
      return { advance: false, verdict: null, ok: false, failure: { message } }
    }

    /**
     * 派发前必须让调用与 handle 锁定的配置**逐字段相等**，否则内核的
     * `callConfigEquals` 会以 `INVALID_PREPARED_CALL` 拒绝。
     *
     * 所以这里从 handle 自己报告的 `config` 取权威值，而不是从我们这边的
     * `options` 猜：provider / model 一定是渠道自己的名字，`maxTokens` 等
     * 字段若被渠道适配器解析出默认值也必须照它说的传。`signal` 不参与比较，
     * 保留调用方的取消链路。
     */
    const locked = handle?.config ?? { provider: target.provider, model: target.model }
    const forwarded = { ...options, ...locked }
    delete forwarded.reasoningEffort
    if (locked.reasoningEffort !== undefined) forwarded.reasoningEffort = locked.reasoningEffort
    let ok = false
    let committed = false
    let lastFailureMessage = ''
    /**
     * 渠道适配器报告失败有**两种**形态，都必须当成候选失败处理：
     *
     * 1. 抛异常（传输层、解析层）；
     * 2. 正常结束流，但最后一个 `finish` 块的 reason 是 `error`。
     *
     * 第 2 种是渠道适配器的常规形态（它们把上游业务错误规整成终止块），早先
     * 这里只看 `kind === 'stop'` 判成功、其余一律 `advance: false`，于是链路
     * 遇到「额度用尽」这种**正是它存在意义**的失败时反而不降级，把上游错误
     * 原样甩给用户。
     */
    let failed = false
    try {
      for await (const chunk of handle.stream(forwarded)) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.trim() !== '') committed = true
        if (chunk?.type === 'tool-call-delta') committed = true
        if (chunk?.type === 'finish') {
          if (chunk.reason?.kind === 'stop') ok = true
          else if (chunk.reason?.kind === 'error') {
            failed = true
            lastFailureMessage = chunk.reason?.failure?.message ?? String(chunk.reason?.failure ?? '')
          }
        }
        yield chunk
      }
    } catch (error) {
      const message = String(error?.message ?? error)
      this.deps.recordTurn?.({ at: started, model: entry.id, ok: false, recovered: false, attempts: 1, origin: 'harness', message })
      // Before any answer-bearing delta this is still an invisible candidate
      // fault, so a chain may move on; afterwards the caller already saw output.
      yield fail(`channel ${target.provider} failed: ${message}`, CODE.server)
      // ★ failure 随 return 带出（审查 2026-11-05）：runCombo 的失败日志靠它，
      //   否则 `failureMessage` 恒空、排查「轮到某成员就换人」没有线索。
      return { advance: !committed, verdict: null, ok: false, failure: { message } }
    }
    // ⚠️ 把最后的 finish 错误块一并带给 recordTurn（2026-11-04 排查 qodercn 用）：
    // 渠道适配器把上游业务错误规整成 `finish(error)`，那个 reason 里才有真话。
    this.deps.recordTurn?.({ at: started, model: entry.id, ok: !failed && ok, recovered: false, attempts: 1, origin: 'harness',
      message: lastFailureMessage })
    // 已经交出内容就不能再换模型（调用方看得到那段输出）；还没交出的失败
    // 才是「换一个再来」的场景。
    return { advance: failed && !committed, verdict: null, ok: !failed && ok }
  }

  /**
   * 结局分类的纯函数（审查 2026-11-05：runSingle 359 行的拆分边界③）。
   *
   * 「这次流结束该走哪条恢复路径」的三选一判定：推理中断续写（interrupted）、
   * 正文撞上限续写（maxTokensCut）、空停续写（silentStop）。无副作用，只读入参。
   *
   * ⚠️ 判据必须与原版逐字一致（2026-11-05 实测教训：第一版把
   * `reason.kind === 'max-tokens'` 误写成 `outcome.finish === 'length'` ——
   * finishReason 的 max-tokens 映射覆盖 length/max_tokens/max_output_tokens/
   * incomplete 四种 token，写成单值会让其余三种漏掉续写、直接报错）。
   * `reasonKind` 必须传调用方算好的 `reason.kind`（含 brokenToolCall 强制
   * max-tokens 的三元），不要在函数里重算。
   */
  static classifyStreamOutcomes({ outcome, policy, elapsed, recovering, reasonKind }) {
    const interrupted = canRecover(outcome, policy, elapsed)
    const maxTokensCut = policy.enabled && !recovering && reasonKind === 'max-tokens' && outcome.brokenToolCall !== true
      && outcome.sawText === true && outcome.sawToolCall !== true
      && typeof outcome.answerText === 'string' && outcome.answerText.trim() !== ''
    const silentStop = !interrupted && !maxTokensCut && reasonKind === 'stop'
      && (outcome.finish === undefined || ['stop', 'end_turn', 'stop_sequence'].includes(outcome.finish))
      && canRecoverSilentStop(outcome, policy, elapsed)
    return { interrupted, maxTokensCut, silentStop }
  }

  /**
   * One model's turn — the original single-lane path.
   *
   * @param {object} [plan] - `{ wire?, turnModel?, recordTurn?, allowAdvance? }`.
   *   `turnModel` re-attributes the logical turn, so a combo's link is recorded
   *   physically under its own id while the turn belongs to the chain;
   *   `recordTurn: false` leaves the turn record to the caller; `allowAdvance`
   *   makes a pre-output failure report itself as advanceable instead of ending
   *   the turn outright.
   * @returns the turn's own summary, which only a combo caller reads.
   */
  async * runSingle(options, entry, snapshot, plan = {}) {
    const settings = snapshot.settings ?? {}
    const started = Date.now()
    const turnModel = plan.turnModel ?? baseModelId(options.model)
    const recordRejectedTurn = () => {
      if (plan.recordTurn === false) return
      this.deps.recordTurn?.({
        at: started,
        model: turnModel,
        ok: false,
        recovered: false,
        attempts: 0,
        origin: 'harness',
      })
    }

    // ★ 开关拦截（免费车道核心语义，2026-11-07 确认保留）：settings.enabled=false
    //    时免费模型一律拒绝 —— 「启用免费模型」开关的真正含义。
    if (settings.enabled === false) {
      recordRejectedTurn()
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'our free model is switched off in its settings page', code: 'CONFIG_DISABLED' } } }
      return { advance: false, verdict: null, ok: false }
    }
    if (entry === null) {
      recordRejectedTurn()
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `our free model does not serve "${options.model}" on this egress`, code: CODE.server } } }
      return { advance: false, verdict: null, ok: false }
    }

    const kilo = isKiloEntry(entry)
    // The absorbed channels speak the Chat wire regardless of what their ids
    // resemble; only the free lane splits endpoints per model.
    const wire = plan.wire ?? wireOf(entry)
    const style = STYLE_FOR_WIRE[wire]
    const warnings = []
    const resolveImage = this.deps.resolveImage
    const messages = repairToolPairing(options.messages ?? [])
    const budget = budgetFor(options.reasoningEffort, entry, options.maxTokens, settings.defaultMaxTokens)
    const declared = toToolDefs(options.tools, style)
    const policy = recoveryPolicy(settings.streamRecovery)
    const session = sessionForConversation(options.sessionId)
    const recoveryId = mintRequestId()
    let attemptMessages = messages
    let attemptBudget = budget
    let nextIndex = 0
    let totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    let rejectedInputUsage = false
    const trustedOutcome = outcome => {
      // Only this Kilo router has a confirmed inflated multimodal stamp.
      // Other lanes may advertise a conservative/fallback window, so exceeding
      // that metadata alone must not erase their otherwise valid accounting.
      if (!kilo || entry.id !== 'kilo-auto/free' || outcome?.sawUsage !== true) return outcome
      const usage = sanitizeUsage(outcome.usage, entry.contextWindow)
      if (usage === outcome.usage) return outcome
      rejectedInputUsage = true
      return usage === undefined
        ? { ...outcome, sawUsage: false, usage: { inputTokens: 0, outputTokens: 0 } }
        : { ...outcome, usage }
    }
    const collectUsage = outcome => {
      const trusted = trustedOutcome(outcome)
      totalUsage = addUsage(totalUsage, trusted?.usage, trusted?.sawUsage)
      // Once one attempt's input is unknown, no sum of the other attempts can
      // restore an exact prompt/total. Keep decode counts but let the host use
      // its local input estimate, including after an honest continuation.
      if (rejectedInputUsage) {
        totalUsage = {
          inputTokens: 0,
          outputTokens: totalUsage.outputTokens,
          ...totalUsage.reasoningTokens === undefined ? {} : { reasoningTokens: totalUsage.reasoningTokens },
        }
      }
      return trusted
    }
    const blocks = createBlockTracker()
    let turnRecorded = false
    const finishTurn = (ok, recovered = false, attempts = 1, message) => {
      if (turnRecorded) return
      turnRecorded = true
      if (plan.recordTurn === false) return
      this.deps.recordTurn?.({
        at: started,
        model: turnModel,
        ok,
        recovered,
        attempts,
        origin: 'harness',
        // ★ 失败原因随 turn 记录带出（审查 2026-11-05）：runtime 失败日志按
        //   record.message 过滤打印，免费车道失败原本没有这条线索。
        ...(message ? { message } : {}),
      })
    }

    // One pipeline report per dispatch build, so the usage record can carry what
    // the token savers measured for the body that actually shipped.
    let attemptSavings = null

    // 一次逻辑回合的丢弃内容告警只由首个 payload 收集。检查点估算和续写段都要另建
    // 一份 payload，共用同一个数组会让 `image-dropped` 按 build 次数重复累积，还会
    // 让已经交出去的首段样本跟着后面的 build 一起变长。
    const payloadFor = (input, ceiling, sink, savingsSink) => {
      const payload = buildPayload(wire, entry.id, input, options, ceiling, resolveImage, sink)
      if (declared.length > 0) payload.tools = declared
      if (typeof options.temperature === 'number' && Number.isFinite(options.temperature)) payload.temperature = options.temperature
      if (wire !== 'responses' && Array.isArray(options.stop) && options.stop.length > 0) payload.stop = options.stop
      // ⚠️ 续写回合**不再**下发 `tool_choice: 'none'`：v2 门禁见到 `none` 一律
      // 403 FreeTierError（旧实现靠它压住工具调用）。压制手段改为续写指令本身
      // ——`recoveryMessages()` 的正文里已经写着「Do not call tools」，这条提示
      // 是 v1 时代就有的，不依赖 tool_choice。
      // A declared thinking menu means the selected level is the real control
      // on the wire: it rides the request as the model's own effort field (a
      // JSON merge patch, ZCode's declaration shape). The free lane's own ids
      // now declare menus too (see `src/catalog.js`), so the gate is the entry
      // rather than the lane — an entry without a menu still keeps the free
      // lane's token-budget behaviour, untouched.
      if (kilo || hasDeclaredEffortMenu(entry)) {
        const patch = effortPatchFor(options.reasoningEffort, entry)
        if (patch !== null) Object.assign(payload, patch)
      }
      // The token savers run last, after every other mutation, so the byte counts
      // they report and the fingerprint's rename map both describe the body that
      // actually ships. Applied on estimation builds too — the checkpoint size
      // gate has to measure the payload it is gating, not a fatter draft of it.
      const savings = applyTokenSavers(payload, wire, saverConfig(settings))
      if (savingsSink !== undefined) savingsSink.report = savings
      return payload
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (options.signal?.aborted === true) {
        finishTurn(false, false, attempt)
        if (attempt > 0) yield { type: 'usage', usage: totalUsage }
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'request aborted', code: CODE.aborted } } }
        return { advance: false, verdict: null, ok: false }
      }
      const attemptStarted = Date.now()
      const recovering = attempt === 1
      const savingsSink = {}
      const payload = payloadFor(attemptMessages, attemptBudget, recovering ? [] : warnings, savingsSink)
      attemptSavings = savingsSink.report ?? null
      // The absorbed channels have no tool-name gate; their models see the
      // caller's tools exactly as declared, so the fingerprint pass is free-lane
      // only.
      const renameMap = kilo ? new Map() : applyFingerprint(payload, wire === 'messages' ? 'claude' : style === 'flat')
      const controller = new AbortController()
      const onAbort = () => controller.abort(options.signal?.reason)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      const remainingMs = Math.max(1, policy.totalTimeoutMs - (attemptStarted - started))
      let expired = false
      const timeoutMs = recovering ? Math.min(policy.maxContinuationMs, remainingMs) : remainingMs
      const timer = policy.enabled ? setTimeout(() => {
        expired = true
        controller.abort()
      }, timeoutMs) : undefined
      timer?.unref?.()
      const channel = createChannel()
      const request = (kilo
        ? postKiloStreamed({ body: payload, signal: controller.signal, onData: value => channel.push(value) })
        : postStreamed({
          path: endpointFor(entry.id), body: payload, session,
          attributionUserAgent: snapshot.attributionUserAgent,
          signal: controller.signal,
          onData: value => channel.push(value),
        }))
        .then(() => channel.push(undefined))
        .catch(error => channel.push(error instanceof Error ? error : new Error(String(error))))
      let firstDeltaAt
      let delivered = false
      let sawAnswer = false
      let recorded = false
      let continuationScheduled = false
      let partialOutcome
      let usageAdded = false
      const record = (ok, outcome, extra = {}) => {
        if (recorded) return
        recorded = true
        const usage = outcome?.sawUsage === true ? outcome.usage : undefined
        this.deps.recordUsage({
          at: attemptStarted,
          model: entry.id,
          effort: resolveLevel(options.reasoningEffort, entry)?.id ?? '',
          ok,
          input: usage?.inputTokens ?? 0,
          output: usage?.outputTokens ?? 0,
          reasoning: usage?.reasoningTokens ?? 0,
          cacheRead: usage?.cacheReadTokens ?? 0,
          decodeTokens: ok ? windowTokens(usage, outcome?.sawReasoning === true) : 0,
          ttftMs: firstDeltaAt === undefined ? undefined : firstDeltaAt - attemptStarted,
          decodeMs: firstDeltaAt === undefined ? 0 : Date.now() - firstDeltaAt,
          origin: 'harness',
          recoveryId,
          attempt,
          elapsedMs: Date.now() - attemptStarted,
          ...recovering ? { recoveryAttempt: true } : {},
          ...outcome?.sawUsage === true ? {} : { noUsage: true },
          ...warnings.length === 0 ? {} : { warnings },
          ...savingsFields(attemptSavings),
          ...extra,
        })
      }
      /**
       * Whether another model could answer this failure.
       *
       * Three things veto it, and each one is a different kind of "no": the
       * caller did not ask for a chain, the caller walked away, or this model
       * already put an *answer* on the wire — a switch after that point would
       * splice two models' prose together in front of the user.
       *
       * The veto reads `sawAnswer`, not `delivered`, on purpose. `delivered`
       * also covers reasoning deltas, but a combo holds those in its own
       * buffer and drops them whole when it advances — the user never saw
       * them, so they must not pin the chain to a model that hit a quota wall
       * after a minute of thinking ("thought for a minute, then hit the wall"
       * is the single most valuable case to fail over). Answer-bearing output
       * — visible text or a streamed tool call — is what `commitsAnswer`
       * commits on, and once committed the combo ignores `advance` anyway, so
       * this predicate and the commit rule stay two views of one definition.
       */
      const advanceVerdict = (code, message, status) => {
        if (plan.allowAdvance !== true || options.signal?.aborted === true || sawAnswer) {
          return { advance: false, verdict: null, ...(message ? { failure: { message } } : {}) }
        }
        const verdict = classifyFailure({ status, code, message })
        return { advance: shouldAdvance(verdict) || code === CODE.client || code === CODE.region, verdict, failure: { message } }
      }
      try {
        const reader = readStream(channel.read(), wire, renameMap, () => Date.now(), {
          startIndex: nextIndex, checkpointLimit: policy.checkpointLimit,
          onState: value => { partialOutcome = value },
        })
        let outcome
        try {
          while (true) {
            const row = await reader.next()
            if (row.done) { outcome = row.value; break }
            if (options.signal?.aborted === true) throw new UpstreamError('request aborted', CODE.aborted)
            const chunk = row.value
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.trim() !== '') sawAnswer = true
            // 续写禁用工具；网关不遵守时也不把工具块交给宿主执行。
            if (recovering && (chunk.blockType === 'tool-call' || chunk.type === 'tool-call-delta' || chunk.block?.type === 'tool-call')) {
              throw new UpstreamError('our free model continuation unexpectedly requested a tool', 'STREAM_CUT')
            }
            if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
              delivered = true
              if (firstDeltaAt === undefined) firstDeltaAt = Date.now()
            }
            blocks.accept(chunk)
            yield chunk
          }
        } finally {
          await reader.return()
        }
        nextIndex = outcome.nextIndex
        outcome = collectUsage(outcome)
        usageAdded = true
        if (options.signal?.aborted === true) {
          record(false, outcome, { aborted: true })
          finishTurn(false, false, attempt + 1, 'request aborted')
          yield { type: 'usage', usage: totalUsage }
          yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'request aborted', code: CODE.aborted } } }
          return { advance: false, verdict: null, ok: false }
        }
        const reason = outcome.brokenToolCall === true ? { kind: 'max-tokens' } : finishReason(outcome.finish)
        // finishReason 是兜底映射，failed/cancelled 也会落成 stop：正常收尾的判定必须显式查原 token。
        const elapsed = Date.now() - started
        // 三选一恢复路径判定收敛在 classifyStreamOutcomes（纯函数，判据见其说明）；
        // interrupted 的判定也一并入内（与调用点的 canRecover 同一入参同一结果）。
        const { interrupted, maxTokensCut, silentStop } = FreeModelAdapter.classifyStreamOutcomes({ outcome, policy, elapsed, recovering, reasonKind: reason.kind })
        if (!recovering && (interrupted || silentStop || maxTokensCut)) {
          const remainingTokens = budget - (outcome.sawUsage ? outcome.usage.outputTokens ?? 0 : 0)
          const continuationBudget = Math.min(remainingTokens, policy.maxOutputTokens)
          const nextMessages = maxTokensCut
            ? continuationMessages(messages, outcome.answerText)
            : recoveryMessages(messages, outcome.reasoningText)
          if (continuationBudget >= MIN_BUDGET
            && checkpointFits(payloadFor(nextMessages, continuationBudget, []), entry, maxTokensCut ? outcome.answerText : outcome.reasoningText, continuationBudget)) {
            record(false, outcome, { truncated: true, recoveryScheduled: true })
            this.deps.warn?.(maxTokensCut
              ? 'our-free-model: the answer hit the output token ceiling; continuing once from where it stopped'
              : silentStop
                ? 'our-free-model: a stopped turn held only its reasoning; continuing once from its checkpoint'
                : 'our-free-model: interrupted reasoning; continuing once from its checkpoint')
            attemptMessages = nextMessages
            attemptBudget = continuationBudget
            continuationScheduled = true
            continue
          }
        }
        const failedEnding = outcome.finish === 'failed' || outcome.finish === 'cancelled'
        const normalEnding = outcome.finish === undefined || ['stop', 'end_turn', 'stop_sequence'].includes(outcome.finish)
        if (outcome.sawFinish !== true || failedEnding || (recovering && (!sawAnswer
          || outcome.sawToolCall === true || reason.kind !== 'stop' || !normalEnding))) {
          const seconds = Math.round((Date.now() - started) / 1000)
          const code = recovering || delivered || outcome.sawToolCall === true ? 'STREAM_CUT'
            : failedEnding ? CODE.server : CODE.transport
          const message = recovering
            ? `our free model continuation ended without a complete answer after ${seconds}s; automatic recovery exhausted`
            : failedEnding ? `our free model upstream response ended with status ${outcome.finish}`
            : delivered || outcome.sawToolCall === true
              ? `our free model closed the stream after ${seconds}s, before its finish token; automatic recovery was not safe`
              : 'our free model closed the stream before its finish token, without answering; retrying'
          record(false, outcome, { truncated: true })
          finishTurn(false, false, attempt + 1, message)
          yield { type: 'usage', usage: totalUsage }
          yield { type: 'finish', reason: { kind: 'error', failure: { message, code } } }
          return { ok: false, ...advanceVerdict(code, message, undefined) }
        }
        if (outcome.sawText !== true && outcome.sawToolCall !== true && outcome.sawReasoning !== true && reason.kind === 'stop') {
          record(false, outcome)
          finishTurn(false, false, attempt + 1, 'our free model returned an empty response')
          yield { type: 'usage', usage: totalUsage }
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'our free model returned an empty response', code: CODE.empty } } }
          return { ok: false, ...advanceVerdict(CODE.empty, 'empty response') }
        }
        record(true, outcome, recovering ? { recovered: reason.kind === 'stop' } : {})
        finishTurn(true, recovering && reason.kind === 'stop', attempt + 1)
        yield { type: 'usage', usage: totalUsage }
        // Keep the provider token when the harness fallback maps an abnormal
        // ending to stop. Strict consumers (manual tests) must not certify it.
        yield { type: 'finish', reason, ...(reason.kind === 'stop' && !normalEnding ? { upstreamFinish: outcome.finish } : {}) }
        if (warnings.length > 0) this.deps.warn?.(`our-free-model: dropped unsupported content for ${entry.id}: ${warnings.join(', ')}`)
        return { advance: false, verdict: null, ok: true, recovered: recovering && reason.kind === 'stop' }
      } catch (error) {
        if (error?.code === CODE.region) this.deps.onRegionBlocked?.(entry.id)
        const aborted = options.signal?.aborted === true
        let failure = toFailure(error)
        if ((delivered || partialOutcome?.sawToolCall === true) && this.providerRetryPolicy().retryableCodes.includes(failure.code)) {
          failure = { ...failure, code: 'STREAM_CUT' }
        }
        if (!aborted && (recovering || expired)) {
          failure = { ...failure, code: recovering || delivered || partialOutcome?.sawToolCall === true ? 'STREAM_CUT' : CODE.timeout,
            message: expired
              ? `our free model reached its ${Math.round(timeoutMs / 1000)}s time limit before its finish token${recovering ? ', during the continuation from its checkpoint' : ''}`
              : `our free model continuation failed: ${failure.message}` }
        }
        if (!usageAdded) partialOutcome = collectUsage(partialOutcome)
        record(false, partialOutcome, { ...(recovering || expired) ? { truncated: true } : {}, ...aborted ? { aborted: true } : {} })
        finishTurn(false, false, attempt + 1, failure.message)
        for (const chunk of blocks.close()) yield chunk
        if (recovering || partialOutcome?.sawUsage === true) yield { type: 'usage', usage: totalUsage }
        yield { type: 'finish', reason: { kind: aborted ? 'aborted' : 'error', failure } }
        return {
          ok: false,
          ...aborted
            ? { advance: false, verdict: null, failure: { message: failure.message } }
            : advanceVerdict(failure.code, failure.message, failure.status),
        }
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        controller.abort()
        await request
        if (!recorded) record(false, trustedOutcome(partialOutcome), { aborted: true })
        if (!continuationScheduled && !turnRecorded) finishTurn(false, false, attempt + 1)
      }
    }
  }
}

function buildPayload(wire, modelId, messages, options, budget, resolveImage, warnings) {
  if (wire === 'responses') {
    const input = toResponseInput(messages, resolveImage, warnings)
    return {
      model: modelId,
      input: input.length > 0 ? input : [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '...' }] }],
      stream: true,
      store: false,
      max_output_tokens: budget,
    }
  }
  if (wire === 'messages') {
    const shaped = toClaudeMessages(messages, resolveImage, warnings)
    return {
      model: modelId,
      messages: shaped.messages,
      stream: true,
      max_tokens: budget,
      ...shaped.system === undefined ? {} : { system: shaped.system },
    }
  }
  const chat = toChatMessages(messages, resolveImage, warnings)
  return {
    model: modelId,
    messages: typeof options.system === 'string' && options.system !== ''
      ? [{ role: 'system', content: options.system }, ...chat]
      : chat,
    stream: true,
    max_tokens: budget,
  }
}

/**
 * Shape one thrown error into the harness's `LlmFailure` vocabulary.
 *
 * The harness writes this object straight into a durable session event, and that
 * log rejects anything that does not survive a lossless JSON round trip — an
 * Error instance, a `NaN`, an explicit `undefined` field. A rejected append
 * aborts the whole turn, so a malformed failure is strictly worse than a sparse
 * one: only the whitelisted fields are carried, each validated, and each dropped
 * rather than emitted in a degraded form.
 */
function toFailure(error) {
  const message = typeof error?.message === 'string' && error.message.length > 0
    ? error.message
    : String(error ?? 'our free model request failed')
  const code = typeof error?.code === 'string' && error.code.length > 0 ? error.code : CODE.transport
  const status = error?.status
  const retryAfter = error?.providerRetryAfterMs
  return {
    message,
    code,
    ...Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {},
    ...Number.isFinite(retryAfter) && retryAfter > 0 ? { providerRetryAfterMs: Math.trunc(retryAfter) } : {},
  }
}

/**
 * Which wire serves one catalog row.
 *
 * The absorbed channels speak the Chat wire regardless of what their ids
 * resemble; the free lane splits its endpoints per model id.
 */
function wireOf(entry) {
  if (isKiloEntry(entry)) return 'chat'
  return wireFor(entry.id)
}

/**
 * Does this chunk carry an answer the caller would have to un-see?
 *
 * A combo may only abandon a candidate while the answer is still entirely
 * inside its own buffer. Reasoning deltas are excluded on purpose: thinking is
 * not the answer, and "thought for a minute, then hit a quota wall" is the
 * most valuable failure to fail over — the held thinking is dropped with the
 * rest of the discarded attempt, so the caller never learns it happened. A
 * `block-end` for a reasoning block is the tail of that same reasoning stream
 * (`closeAll` emits it when the SSE loop ends), so it does not commit either;
 * letting it commit would pin the chain one chunk before the failure it
 * exists to survive. Text commits only when it carries visible content, the
 * same bar `sawAnswer` uses, so whitespace noise cannot pin a chain either.
 */
function commitsAnswer(chunk) {
  if (chunk === null || typeof chunk !== 'object') return false
  if (chunk.type === 'text-delta') return typeof chunk.text === 'string' && chunk.text.trim() !== ''
  if (chunk.type === 'tool-call-delta') return true
  if (chunk.type !== 'block-end') return false
  if (chunk.block?.type === 'reasoning') return false
  if (chunk.block?.type === 'text') return typeof chunk.block.text === 'string' && chunk.block.text.trim() !== ''
  return true
}

/** What the token savers measured for one dispatched body, as usage-record fields. */
function savingsFields(report) {
  if (report === null || report === undefined) return {}
  const saved = Number(report.saved) || 0
  const promptInjected = report.prompt?.injected === true
  if (saved === 0 && promptInjected !== true) return {}
  return {
    savings: {
      saved,
      bytesBefore: Number(report.bytesBefore) || 0,
      // Carried alongside the other two, not derived from them later: the panel
      // shows "before → after", and an after of 0 beside a before of 2599 reads
      // as "the body became empty" rather than "this field was never recorded".
      bytesAfter: Number(report.bytesAfter) || 0,
      blocks: Array.isArray(report.rtk?.hits) ? report.rtk.hits.length : 0,
      ...promptInjected ? { prompt: report.prompt.families ?? [] } : {},
    },
  }
}

/**
 * The `/model` popup's detail line. The composer renders only the model name, so
 * the capacities that matter for choosing a model — modality, window, whether an
 * effort menu exists — have to fit here.
 *
 * A model that cannot switch its thinking off names the shared ceiling outright:
 * on that lane the rung is not only the answer's budget, and a picker that
 * implied otherwise is how "why is it cut off at 8K when my ceiling is 32K" gets
 * asked.
 */
function describe(entry, settings) {
  const parts = [entry.vision ? 'vision + text input' : 'text input', `${Math.round(entry.contextWindow / 1024)}K context`]
  // A chain's own detail line: which models it will try, in order. Without it a
  // combo in the picker looks like one more model with no endpoint behind it.
  if (isComboEntry(entry)) {
    parts.push(`${entry.combo.length}-model chain: ${entry.combo.join(' -> ')}`)
    if (entry.strategy === 'round-robin') parts.push('rotating start')
    return parts.join(' · ')
  }
  if (entry.reasoning === true) {
    // A declared menu is the model's own level list on the wire — naming the
    // levels is the honest detail line; "budget" would describe the free lane's
    // ladder, which is exactly what a menu model does not use.
    if (Array.isArray(entry.efforts) && entry.efforts.length > 0) {
      parts.push(`thinking levels: ${entry.efforts.join(' / ')}`)
    } else {
      const rung = Math.round(budgetFor(DEFAULT_LEVEL, entry, undefined, settings?.defaultMaxTokens) / 1024)
      parts.push(entry.canDisableThinking === false
        ? `thinking always on · ${rung}K default ceiling, shared with the answer`
        : 'tunable thinking budget')
    }
  }
  return parts.join(' · ')
}
