import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { createModelRuntime, createRuntimeStores } from '../../src/core/runtime.js'
import { generateKey, rankLanAddresses, startForwardServer, startLanRelay } from '../../src/forward.js'
import { isLoopbackHost } from '../../src/trust.js'
import { isModelHidden } from '../../src/store.js'
import { commitsAnswer } from '../../src/adapter.js'
import { createManagement } from './management.mjs'
import { createChannelRuntime } from './channels/runtime.mjs'
import {
  COMBO_CHANNEL, isComboEntry, normalizeCombos, buildComboCatalog,
  comboChain, noteComboServed, pruneRotation,
} from '../../src/combos.js'

const PRODUCT = 'our-free-model-standalone'
const VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

/**
 * 路由链「能否换下一个成员」的**唯一判据**。
 *
 * 导出供 `scripts/standalone-combo-test.mjs` 直接测**真代码** —— 测试原先的
 * `runChain` 是手抄的平行实现，已经与真实逻辑漂移过（它没有
 * `answered`/`delivered` 之分，因此覆盖不到「非流式路径必须换人」这条）。
 *
 * ## 两层语义（2026-11-18 二次审查修正）
 *
 * | 概念 | 含义 |
 * |---|---|
 * | `answered` | 该成员**产出了**不可撤回的正文（`commitsAnswer`） |
 * | `delivered` | 这份正文**已经写给客户端**（需要 `handler`） |
 *
 * 换人判定只能用 `delivered`。非流式路径（`forward.js` 的 `complete` 调用
 * 不传 `onChunk`）里 `handler === undefined`，内容只累积在 `held` 中、
 * 从未交付 —— 此时必须继续换下一个成员，否则客户端拿到「部分正文 + 错误」，
 * 而上游 token 已经花掉。
 *
 * @param {{answered?: boolean, hasHandler?: boolean, thrown?: unknown, result?: any}} state
 * @returns {boolean} true = 允许换下一个成员
 */
export function advancePastMember({ answered = false, hasHandler = false, thrown, result } = {}) {
  const delivered = answered === true && hasHandler === true
  const failed = thrown !== undefined || result?.error !== undefined || result?.failure !== undefined
  return !delivered && failed
}

export function resolveStandaloneDataDir(env = process.env, home = os.homedir()) {
  const configured = typeof env.OFM_HOME === 'string' ? env.OFM_HOME.trim() : ''
  return configured === '' ? path.join(home, '.our-free-model') : path.resolve(configured)
}

/** 内核自动释放的互斥端点，串行化同一数据目录的锁检查与回收。 */
async function acquireProcessGuard(dataDir) {
  // 其他平台保留原来的保守文件锁行为，不使用会遗留文件的 Unix Socket。
  if (process.platform !== 'win32' && process.platform !== 'linux') return null
  let canonical = fs.realpathSync.native(dataDir)
  if (process.platform === 'win32') canonical = canonical.toLowerCase()
  const id = crypto.createHash('sha256').update(canonical).digest('hex')
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\ofm-service-lock-${id}` : `\0ofm-service-lock-${id}`
  const server = net.createServer(socket => socket.destroy())
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(address, resolve)
    })
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      throw Object.assign(new Error('数据目录已被服务占用'), { code: 'EEXIST', cause: error })
    }
    throw error
  }
  server.unref()
  return () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function acquireServiceLock(dataDir) {
  const releaseGuard = await acquireProcessGuard(dataDir)
  const lockFile = path.join(dataDir, 'service.lock')
  const token = crypto.randomUUID()
  let lock
  let ownedStat
  const removeOwnedLock = () => {
    try {
      const current = fs.lstatSync(lockFile)
      if (current.isFile() && current.dev === ownedStat.dev && current.ino === ownedStat.ino) {
        fs.unlinkSync(lockFile)
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  try {
    try { lock = fs.openSync(lockFile, 'wx', 0o600) }
    catch (error) {
      if (error.code !== 'EEXIST' || !releaseGuard) throw error
      const previousStat = fs.lstatSync(lockFile)
      if (!previousStat.isFile()) throw error
      const previous = fs.readFileSync(lockFile, 'utf8')
      let owner
      try { owner = JSON.parse(previous) } catch { throw error }
      if (owner?.product !== PRODUCT || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw error
      // 只有 ESRCH 能证明进程已经退出；无权限、PID 复用等情况均保留原锁。
      let exited = false
      try { process.kill(owner.pid, 0) }
      catch (probeError) { exited = probeError.code === 'ESRCH' }
      if (!exited) throw error
      const current = fs.lstatSync(lockFile)
      if (current.dev !== previousStat.dev || current.ino !== previousStat.ino ||
          fs.readFileSync(lockFile, 'utf8') !== previous) throw error
      fs.unlinkSync(lockFile)
      lock = fs.openSync(lockFile, 'wx', 0o600)
    }
    ownedStat = fs.fstatSync(lock)
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, product: PRODUCT, token }))
  } catch (error) {
    try {
      if (lock !== undefined) {
        fs.closeSync(lock)
        if (ownedStat) removeOwnedLock()
      }
    } finally { await releaseGuard?.() }
    throw error
  }
  return async () => {
    try {
      // 在关闭文件句柄前核对归属，避免异常替换的锁被本实例清理。
      const current = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
      if (current?.token === token && current.pid === process.pid && current.product === PRODUCT) removeOwnedLock()
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    } finally {
      try { fs.closeSync(lock) } finally { await releaseGuard?.() }
    }
  }
}

/** 直接创建核心和 HTTP 服务，不加载插件入口、Cordis 或 DSH 凭据。 */
export async function startStandalone({
  dataDir = resolveStandaloneDataDir(), host = '127.0.0.1', port,
  logger = console, refresh = true, probe, lanEnabled, lanPort, lanPanel,
  startRelay = startLanRelay,
} = {}) {
  if (!isLoopbackHost(host)) throw new TypeError('the standalone service binds a loopback address only')
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new TypeError('dataDir must be an absolute path')
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new TypeError('port must be an integer between 0 and 65535')
  }
  if (lanEnabled !== undefined && typeof lanEnabled !== 'boolean') throw new TypeError('lanEnabled must be a boolean')
  if (lanPanel !== undefined && typeof lanPanel !== 'boolean') throw new TypeError('lanPanel must be a boolean')
  if (lanPort !== undefined && (!Number.isInteger(lanPort) || lanPort < 0 || lanPort > 65535)) {
    throw new TypeError('lanPort must be an integer between 0 and 65535')
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const releaseLock = await acquireServiceLock(dataDir)
  let stores
  let runtime
  let listener
  let management
  let channels
  let timer
  let refreshInFlight
  let closing
  let stopped = false
  let relay
  let relayTarget
  let relayRequestedPort
  let relayError = null
  let relayChanges = Promise.resolve()
  const lanState = () => {
    const value = stores.settings.get()
    const addresses = rankLanAddresses(os.networkInterfaces())
    return {
      enabled: value.standaloneLanEnabled === true,
      // 面板中继（同端口）。默认关 —— 面板带写权限，要不要暴露给同网段由用户定。
      panel: value.standaloneLanEnabled === true && value.standaloneLanPanel === true,
      running: relay !== undefined,
      host: relay?.host ?? '::',
      requestedPort: value.standaloneLanPort ?? 0,
      port: relay?.port ?? null,
      addresses,
      baseUrls: relay ? addresses.map(address => `http://${address}:${relay.port}/v1`) : [],
      error: relayError,
    }
  }
  async function closeRelay() {
    const current = relay
    const target = relayTarget
    relay = undefined
    relayTarget = undefined
    relayRequestedPort = undefined
    await Promise.all([current?.close(), target?.close()])
  }
  function reconcileRelay() {
    relayChanges = relayChanges.then(async () => {
      const value = stores.settings.get()
      const wantedPort = value.standaloneLanPort ?? 0
      relayError = null
      if (stopped || value.enabled === false || value.standaloneLanEnabled !== true) {
        await closeRelay()
        return
      }
      if (relay && relayRequestedPort === wantedPort) return
      await closeRelay()
      try {
        if (typeof value.standaloneLanKey !== 'string' || value.standaloneLanKey === '' ||
            value.standaloneLanKey === value.forwardKey) {
          settingsPersist({ standaloneLanKey: generateKey() })
        }
        // The shared relay targets IPv4 loopback. An IPv6 management bind needs
        // a separate inference-only loopback target, with no management handler.
        if (listener.server.address().address !== '127.0.0.1') {
          relayTarget = await startForwardServer({
            config: () => ({
              host: '127.0.0.1', port: 0,
              enabled: !stopped && stores.settings.get().enabled !== false,
              key: stores.settings.get().forwardKey,
            }),
            /**
             * ⚠️ 必须**延迟读取** `runtime.complete`，不能在这里按值捕获。
             *
             * 这个 relay 在 `runtime` 被 combo 包装**之前**就启动了；按值捕获
             * 拿到的是包装前的 `core.complete`，于是 combo 请求会绕过
             * `completeCombo` 直接交给 core 的 `runCombo`——那份只查 core 自己的
             * catalog，看不到渠道模型，成员就永远「缺失」。
             */
            complete: (request, onChunk) => runtime.complete(request, onChunk),
            modelRows: () => runtime.publicModelRows(),
          })
        }
        const targetPort = relayTarget?.port ?? listener.port
        const started = await startRelay({
          config: () => ({
            enabled: !stopped && stores.settings.get().enabled !== false && stores.settings.get().standaloneLanEnabled === true,
            host: '::', port: wantedPort, targetPort,
            lanKey: stores.settings.get().standaloneLanKey,
            localKey: stores.settings.get().forwardKey,
            // 面板中继开关（见 src/forward.js 的 isPanelPath）
            panel: stores.settings.get().standaloneLanPanel === true,
            /**
             * 是否**免登录直通**面板（中继注入本机 key）。
             *
             * 用户设了面板密码（`OFM_PASSWORD`）时**不直通** —— 那种
             * 情况下让他输入令牌，安全边界更清楚；没设就直通，打开即用。
             * 用户原话：「我需要不带token或者token在环境变量里面设置」。
             */
          }),
          log: message => logger.warn?.(`our-free-model standalone LAN: ${message}`),
        })
        relay = started
        relayRequestedPort = wantedPort
        if (stopped || stores.settings.get().enabled === false || stores.settings.get().standaloneLanEnabled !== true) await closeRelay()
      } catch (error) {
        await closeRelay()
        relayError = `LAN relay could not start (${/^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'START_FAILED'})`
        logger.warn?.(relayError)
      }
    })
    return relayChanges
  }
  function settingsPersist(patch) {
    const previous = stores.settings.get()
    stores.settings.update(patch)
    stores.settings.flush()
    if (stores.settings.writeFailed) {
      stores.settings.value = previous
      throw new Error('could not persist the standalone LAN settings')
    }
  }
  try {
    stores = createRuntimeStores({ dataDir, logger })
    const { settings } = stores
    const savedPort = settings.get().standalonePort
    const requestedPort = port ?? (Number.isInteger(savedPort) && savedPort >= 0 && savedPort <= 65535 ? savedPort : 18900)
    const existingKey = settings.get().forwardKey
    const key = typeof existingKey === 'string' && existingKey !== '' ? existingKey : generateKey()
    const savedLanPort = settings.get().standaloneLanPort
    settings.update({
      forwardKey: key,
      standaloneLanEnabled: lanEnabled ?? settings.get().standaloneLanEnabled === true,
      // 面板中继：**必须显式开启**（--lan-panel）。面板带写权限，默认不暴露给同网段。
      standaloneLanPanel: lanPanel ?? settings.get().standaloneLanPanel === true,
      standaloneLanPort: lanPort ?? (Number.isInteger(savedLanPort) && savedLanPort >= 0 && savedLanPort <= 65535 ? savedLanPort : 0),
      ...probe === undefined ? {} : { standaloneProbe: probe === true },
    })
    settings.flush()
    if (settings.writeFailed) throw new Error('could not persist the standalone API key')
    runtime = createModelRuntime({
      ...stores, logger, attributionUserAgent: `${PRODUCT}/${VERSION}`,
    })
    channels = await createChannelRuntime({ dataDir, logger, stats: stores.stats })
    const core = runtime
    /**
     * 两个 runtime 的**真实**模型行（core 免费模型 + channels 渠道模型）。
     *
     * ## 为什么要把 core 的 combo 行剔掉
     * `src/core/runtime.js` 自己也调 `buildComboCatalog` —— 但它只看 core 的
     * catalog，**看不到 standalone 的渠道模型**。如果两层的 combo 行都留下：
     * ① 同一条链在 `/v1/models` 里出现两次；
     * ② 引用渠道模型的链会被 core 判成「成员缺失」而缩水。
     *
     * 所以这里剔除 core 的 combo 行，由下面统一按**合并后的真实目录**重建一次。
     */
    const realCatalog = () => [
      /**
       * ⚠️ 用 `core.publicModelRows()`（已按可见性/可路由过滤）而**不是**
       * `core.catalog`（全量）。
       *
       * `publicModelRows` 会经 `routableModelIds()` 剔除 `hiddenModelIds` 与
       * `hideFreeModels` 命中的模型；而 combo 的链成员是在这里解析的。
       * 若用全量 catalog，一个被用户隐藏的模型会**通过 combo 重新出现在
       * `/v1/models`** —— 隐藏对它失效（实测踩过：隐藏 mimo 后清单里仍有它）。
       */
      ...core.publicModelRows()
        .map(row => {
          const full = core.catalog.find(c => c.id === row.id)
          return full === undefined ? row : { ...full, ...row }
        })
        .filter(row => !isComboEntry(row)),
      ...channels.publicModelRows()
        .filter(row => !isModelHidden(row, stores.settings.get()))
        .map(row => ({ ...row, contextWindow: row.context_window, maxOutput: row.max_tokens })),
    ]
    /** 归一后的路由链（每次读设置，保存后立即生效）。 */
    const combos = () => {
      const value = normalizeCombos(settings.get().combos)
      pruneRotation(value)
      return value
    }
    /** 按模型名找 combo 定义；不是 combo 返回 undefined。 */
    const comboEntryFor = modelId => {
      if (typeof modelId !== 'string' || !modelId.startsWith('combo:')) return undefined
      const entry = buildComboCatalog(combos(), realCatalog()).find(row => row.id === modelId)
      return entry === undefined ? undefined : { ...entry, models: entry.combo }
    }
    /**
     * 走一条 combo 链：按 `comboChain` 给出的顺序逐个尝试，第一个产出内容的赢。
     *
     * ## 两条必须同时成立的策略（用户 2026-11-17 明确要求）
     * - **降级**：前面的成员失败就换下一个。失败在这里**不会抛异常** ——
     *   `core.complete` / `channels.complete` 是「返回 outcome，失败写进
     *   `outcome.error` 与 `outcome.failure`」的契约。所以必须检查返回值，
     *   否则会把一次失败当成成功直接 return（实测踩过：只试了第一个成员）。
     * - **轮询**：从哪开始由 `comboChain` 决定（`fallback` 恒走链头；
     *   `round-robin` 按 sticky 名额轮转），作答成功后 `advanceComboCursor` 挪游标。
     *
     * ## 为什么要缓冲 chunk
     * 失败成员的 `finish` 块（`reason.kind === 'error'`）也会经过 `onChunk`。
     * 如果直接转发，客户端已经收到「错误」或半截内容，再换下一个成员就是
     * 「一回合里两次作答」——上游计费与客户端语义都乱。
     *
     * 因此：首块**内容**（`text-delta` / `tool-call-delta` / `usage`）到达之前
     * 全部暂存，到达即视为该成员成功并立刻放行（流式延迟只多第一块），
     * 若先等来 `finish` 且带失败则整批丢弃、换下一个成员。
     */
    const completeCombo = async (entry, request, onChunk) => {
      const catalogNow = realCatalog()
      const chain = comboChain(entry, catalogNow)
      if (chain.length === 0) throw new Error(`路由链 ${entry.id} 没有可用的成员模型`)
      const handler = typeof onChunk === 'function' ? onChunk : undefined
      let lastFailure
      for (const member of chain) {
        if (stopped) throw new Error('服务已停止')
        /**
         * `committed` 的语义被拆成两层（2026-11-18 二次审查修正）：
         *
         * | 概念 | 含义 |
         * |---|---|
         * | `answered` | 该成员**产出了**不可撤回的正文（`commitsAnswer`） |
         * | `delivered` | 这份正文**已经写给客户端**（`handler` 存在） |
         *
         * 换人判定只能用 `delivered`：非流式路径（`forward.js:944/1247`）
         * 调 `complete` 时**不传 onChunk**，`handler === undefined`，
         * 内容只累积在 `held` 里、从未交付；此时若因 `answered` 就拒绝换人，
         * 客户端会拿到「部分正文 + 错误」——比换下一个成员重答差得多
         * （上游 token 已花，用户却没得到可用回答）。
         *
         * ⚠️ 上一版把两者混成一个 `committed`，在非流式路径上是**回归**：
         * 修复前「A 发正文后失败 → 换 B → 用户拿到 B 的完整回答」，
         * 修复后变成「A 的部分正文配错误帧」。
         */
        let answered = false
        const held = []
        const sink = chunk => {
          if (answered) { handler?.(chunk); return }
          /**
           * 提交判据与插件端 `runCombo` **同一份**（`commitsAnswer`，已导出）：
           * text-delta 要求非空白、tool-call-delta 恒提交、block-end 按
           * block 类型区分（reasoning 不提交）。usage **不算**提交 ——
           * 「先发 usage 再报错」的成员必须还能降级；空白的 text-delta
           * （如只有换行）也不能钉死一条本可降级的链。
           * （第一版手写判据把 usage 算提交、空白也提交，与插件端漂移。）
           */
          if (commitsAnswer(chunk)) {
            answered = true
            for (const row of held) handler?.(row)
            held.length = 0
            handler?.(chunk)
            return
          }
          held.push(chunk)
        }
        /**
         * ⚠️ 失败有**两种形态**，必须都处理：
         *
         * | 来源 | 失败表现 |
         * |---|---|
         * | `core.complete`（免费模型） | 返回 `outcome.error` / `outcome.failure`（**不抛**） |
         * | `channels.complete`（渠道模型） | **抛异常**（zcode 的额度错误就是抛出来的） |
         *
         * 第一版只检查返回值，于是渠道成员一抛异常就整个中断，链根本没往下走
         * —— 实测 NAS 上「zcode 额度用尽」直接返回给用户，trae/officeace 两条
         * 完好的渠道一次都没试。
         */
        let result
        let thrown
        try {
          result = await (channels.handles(member.id)
            ? channels.complete({ ...request, model: member.id }, sink)
            : core.complete({ ...request, model: member.id }, sink))
        } catch (error) {
          thrown = error
        }
        /**
         * ⚠️ **committed 之后绝不换人**（2026-11-18 审查 高-1）。
         *
         * 已提交 = 客户端已经收到了这个成员的正文（held 已放行、后续 chunk
         * 直通）。此刻如果 complete 返回失败（流尾迟到 error finish ——
         * completion.js 会把它折进 outcome.failure），再 continue 换下一个
         * 成员就是**二次作答**：两个模型的正文拼进同一回合，SSE 客户端还会
         * 再收到一条错误帧；非流式路径正文被吞但 token 已计费。
         *
         * 插件端 `runCombo`（adapter.js:317-335）同一语义：committed 后
         * 无条件按成功返回。迟到的失败如实放在 result 里交给上层。
         */
        /**
         * 🔴 审计修复（2026-11-19）：**已交付后抛异常**时 `result` 是
         * `undefined`（`thrown`/`result` 互斥）——直接 `return result` 会让
         * 网关在流式路径读 `result.error` 抛 TypeError，真实失败原因丢失。
         * 构造兜底 outcome，让迟到的失败如实走到上层。
         */
        if (thrown !== undefined && result === undefined) {
          result = {
            text: '', toolCalls: [], usage: undefined, truncated: false,
            error: thrown instanceof Error ? thrown.message : String(thrown),
            failure: { message: thrown instanceof Error ? thrown.message : String(thrown) },
          }
        }
        if (advancePastMember({ answered, hasHandler: handler !== undefined, thrown, result })) {
          lastFailure = thrown !== undefined
            ? (thrown instanceof Error ? thrown : new Error(String(thrown)))
            : (result.failure ?? { message: result.error })
          logger?.warn?.(`[standalone] 路由链 ${entry.id} 的成员 ${member.id} 失败，换下一个：${lastFailure.message ?? lastFailure}`)
          continue
        }
        if (thrown !== undefined) {
          // 已交付（answered && hasHandler）但 complete 中途抛异常：正文已到
          // 客户端，不能换人；错误也要如实上报 —— 上一版在这里 return undefined。
          logger?.warn?.(`[standalone] 路由链 ${entry.id} 的成员 ${member.id} 已交付后中断：${thrown instanceof Error ? thrown.message : thrown}`)
          noteComboServed(entry.id, member.id)
          return result
        }
        // 成功但没来过内容块（空回复）：此时 held 里还有 finish，补发出去。
        // 非流式（handler 为 undefined）不需要补发 —— 内容由返回的 result 承载。
        if (!answered) for (const row of held) handler?.(row)
        noteComboServed(entry.id, member.id)
        /**
         * ⚠️ **不要**在这里调 `advanceComboCursor`。
         *
         * `combos.js` 的注释写明：生产路径已不调用它 —— 轮询游标的推进**在
         * `comboChain` 内部**按 `stickyLimit` 名额完成（每调一次就消耗一个
         * 名额，满额前移）。再在作答后手动前移会造成「双倍推进」：
         * stickyLimit=1 时实际变成 2 回合轮一次。
         */
        return result
      }
      throw new Error(`路由链 ${entry.id} 全部成员失败：${lastFailure?.message ?? '未知原因'}`)
    }

    runtime = {
      ...core,
      get egress() { return core.egress },
      get gatewayLatency() { return core.gatewayLatency },
      /**
       * 路由链（combo）—— 对齐插件版 `src/combos.js`（2026-11-17）。
       *
       * 插件里一套 combo 是「一个模型名背后一串真实模型」：按 `strategy` 决定
       * 从链头还是轮转位置开始，逐个尝试，第一个产出内容的赢。独立版此前
       * **没有接** `combos.js`（business.mjs 里只有一句提到它的注释），
       * 所以面板选不到 combo 模型。
       *
       * 这里是唯一的接线点：`catalog` 暴露虚拟行，`complete` 负责走链。
       */
      get catalog() {
        const real = realCatalog()
        return [...real, ...buildComboCatalog(combos(), real)]
      },
      /**
       * `state()` 是**管理面**的口径 —— 必须保留被隐藏的模型。
       *
       * 面板要显示「这个模型被隐藏了」以及它的历史调用量，靠的就是这里
       * 有 `hiddenByUser` / `hiddenByGroup` 两列（`management.mjs` 的
       * `summary()` 会再算一遍）。如果这里也按可见性过滤，被隐藏的行会从
       * 管理清单里**消失**，用户就再也取消不了隐藏。
       *
       * 所以：`catalog`（全量）用于 state，`publicModelRows`（过滤后）用于
       * `/v1/models`。combo 成员一律按**全量**解析，可见性只在广播时生效。
       */
      state: () => {
        /**
         * 管理面口径：**core 全量 + 渠道全量**，再拼 combo 行。
         *
         * ⚠️ 渠道行必须来自 `channels.publicModelRows()`（2026-11-18 审查 中-1）：
         * 之前这里漏了它，面板模型页只剩免费模型 —— 渠道筛选、计数、
         * overview 的「免费账号渠道」数全部归零。管理面不做可见性过滤，
         * `hiddenByUser` 由 `summary()` 逐行现算，保留行不会丢取消隐藏能力。
         */
        const real = [
          ...core.catalog.filter(row => !isComboEntry(row)),
          ...channels.publicModelRows(),
        ]
        return { ...core.state(), catalog: [...real, ...buildComboCatalog(combos(), real)] }
      },
      publicModelRows: () => {
        const real = realCatalog()
        return [...real, ...buildComboCatalog(combos(), real)]
      },
      complete: (request, onChunk) => {
        const entry = comboEntryFor(request.model)
        if (entry !== undefined) return completeCombo(entry, request, onChunk)
        return channels.handles(request.model) ? channels.complete(request, onChunk) : core.complete(request, onChunk)
      },
      async refreshCatalog(options) {
        if (stopped) return
        await Promise.all([core.refreshCatalog(options), channels.refresh().catch(error => { if (!stopped) throw error })])
      },
    }
    management = createManagement({
      stores, runtime, channels,
      info: () => ({
        product: PRODUCT, version: VERSION, dataDir,
        baseUrl: `http://${host === '::1' ? '[::1]' : host}:${listener?.port ?? requestedPort}`,
        automaticRefresh: refresh,
        networkMode: process.env.OFM_TEST_UPSTREAM ? 'fixture' : 'live',
        capabilities: { anonymous: true, kilo: true, accountChannels: true, webUi: true, lan: true },
        lan: lanState(),
      }),
      onSettingsChanged: async () => {
        if (!refreshInFlight) scheduleRefresh()
        await reconcileRelay()
      },
    })
    listener = await startForwardServer({
      config: () => ({ host, port: requestedPort, enabled: settings.get().enabled !== false, key: settings.get().forwardKey }),
      // 同上：延迟读取，确保拿到 combo 包装后的 complete。
      complete: (request, onChunk) => runtime.complete(request, onChunk),
      modelRows: () => runtime.publicModelRows(),
      health: () => ({
        ok: true, service: PRODUCT, product: 'standalone', version: VERSION,
        capabilities: { anonymous: true, kilo: true, accountChannels: true, webUi: true },
      }),
      handleRequest: management.handleRequest,
      log: message => logger.warn?.(`our-free-model standalone: ${message}`),
    })
    management.setPort(listener.port)
    settings.update({ standalonePort: listener.port })
    settings.flush()
    await reconcileRelay()

    function scheduleRefresh() {
      clearTimeout(timer)
      if (stopped || !refresh) return
      const minutes = Number(settings.get().probeIntervalMinutes)
      timer = setTimeout(() => { void refreshModels() }, (Number.isFinite(minutes) && minutes > 0 ? Math.max(1, minutes) : 15) * 60_000)
      timer.unref?.()
    }
    function refreshModels(force = false) {
      if (refreshInFlight) return refreshInFlight
      refreshInFlight = runtime.refreshCatalog({ probe: settings.get().standaloneProbe === true, force })
        .catch(error => {
          if (!stopped) logger.warn?.(`our-free-model standalone: catalog refresh failed (${error?.message ?? error})`)
        })
        .finally(() => { refreshInFlight = undefined; scheduleRefresh() })
      return refreshInFlight
    }
    // 启动可强制探测；后续周期刷新遵守核心的限流退避。
    const ready = Promise.all([channels.ready, refresh ? refreshModels(settings.get().standaloneProbe === true) : Promise.resolve()])
    return {
      product: PRODUCT, version: VERSION, dataDir,
      url: `http://${host === '::1' ? '[::1]' : host}:${listener.port}`,
      managementUrl: `http://${host === '::1' ? '[::1]' : host}:${listener.port}/${management.bootstrapFragment}`,
      // 一次性登录片段（`#login=<token>`）。CLI 用它把**局域网**面板链接也拼出
      // 来 —— 否则用户在 Docker 部署下只能拿到 127.0.0.1 那条，得手动改 host
      // 和端口，很容易漏（2026-11-16 实测反馈）。
      bootstrapFragment: management.bootstrapFragment,
      port: listener.port,
      keyFile: path.join(dataDir, 'settings.json'),
      runtime, channels, ready,
      get lan() { return lanState() },
      close() {
        if (closing !== undefined) return closing
        stopped = true
        clearTimeout(timer)
        management.dispose()
        runtime.dispose()
        closing = (async () => {
          try {
            await relayChanges
            await Promise.all([closeRelay(), listener.close(), channels.close()])
          } finally {
            try { stores.dispose() } finally { await releaseLock() }
          }
        })()
        return closing
      },
    }
  } catch (error) {
    stopped = true
    clearTimeout(timer)
    management?.dispose()
    runtime?.dispose()
    await relayChanges
    await closeRelay()
    if (listener) await listener.close()
    await channels?.close()
    try { stores?.dispose() } finally { await releaseLock() }
    throw error
  }
}
