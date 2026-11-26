import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { foldForwardOutcome } from '../../../src/core/completion.js'
import { recordTurn, recordUsage } from '../../../src/store.js'

/**
 * 渠道 Worker 的环境变量**白名单**（审计 P2）。
 *
 * 旧实现 `{ ...process.env }` 把整份环境（含 `OFM_PASSWORD`）继承给 Worker：
 * 渠道包是随仓库分发的三方打包产物，任何一处 `console.log(process.env)`
 * 或错误上报都会把管理面密码带出去。改成按需透传。
 *
 * 清单来源：扫 `channels/business.mjs`（渠道包实际运行体）与 `worker.mjs` 里
 * `process.env.X`、`env.X`、`env["X"]`、`envValue("X")` 四种读法，把**用到**的
 * 全列进来 —— 少一个就会改变渠道行为（超时、缓存目录、代理、凭据位置）。
 * `scripts/standalone-test.mjs` 用同样的四种正则做回归校验。
 *
 * ⚠️ `OFM_PASSWORD` **永不透传**；新增渠道环境变量时同步补这份清单。
 */
export const CHANNEL_ENV_KEYS = [
  // 运行时基础
  'PATH', 'TZ', 'LANG', 'LC_ALL', 'NODE_ENV',
  // 账户 / 凭据位置（credentials.mjs 与渠道包各自按平台读）
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SCOOP', 'SCOOP_GLOBAL', 'XDG_DATA_HOME', 'XDG_DATA_DIRS',
  // 独立端数据目录
  'OFM_HOME', 'DSH_HOME',
  // 代理（大写到小写都要，Undici 与渠道包分别读不同形态；ALL_PROXY 是回退项）
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  // 渠道缓存 / 本机浏览器
  'OFM_CODEARTS_CACHE_DIR', 'ZCODE_CHROME_PATH',
  // 渠道包内部开关 / 超时（business.mjs 实际读取）
  'CI', 'JEST_WORKER_ID', 'UNDICI_NO_WASM_SIMD',
  'DSH_HIDE_MODELS_WITHOUT_ACCOUNT', 'DSH_REASONING_LOOP_GUARD',
  'DSH_REASONING_LOOP_AUTO_RESUME', 'DSH_REASONING_LOOP_AUTO_RESUME_MAX',
  'DSH_COURSE_LEAK_STRIP', 'DSH_THINK_LEAK_STRIP', 'DSH_DEAD_MODEL_TTL_DAYS',
  'DSH_OPENAI_GATEWAY_ENABLED', 'DSH_OPENAI_GATEWAY_PORT', 'DSH_OPENAI_GATEWAY_API_KEY',
  'DSH_BUDDY_EXPIRING_WINDOW_DAYS',
  'DSH_CHANNEL_PACK_AUTO_CHECKIN_DELAY_MS', 'DSH_CHANNEL_PACK_BADGE_TTL_MS',
  'DSH_ZCODE_CAPTCHA_BACKOFF', 'DSH_ZCODE_CAPTCHA_POOL',
  'DSH_ZCODE_CAPTCHA_POOL_TTL_MS', 'DSH_ZCODE_CAPTCHA_QUEUE',
  'DSH_CODEARTS_SSE_FIRST_TOKEN_TIMEOUT_MS', 'DSH_CODEARTS_SSE_CHUNK_TIMEOUT_MS',
  'DSH_BUDDY_SSE_FIRST_TOKEN_TIMEOUT_MS', 'DSH_BUDDY_SSE_CHUNK_TIMEOUT_MS', 'DSH_BUDDY_SATURATION_DELAY_MS',
  'DSH_QODER_QUEUE_TIMEOUT_MS', 'DSH_QODER_QUEUE_STALL_MS',
  'DSH_QODER_SSE_FIRST_TOKEN_TIMEOUT_MS', 'DSH_QODER_SSE_CHUNK_TIMEOUT_MS',
  'DSH_TRAE_CHANNELS', 'DSH_TRAE_MAX_MODE', 'DSH_TRAE_MAX_MODELS',
  'DSH_TRAE_HIDE_INTERNAL', 'DSH_TRAE_MAX_COMPLETION_TOKENS',
  'DSH_TRAE_SSE_FIRST_TOKEN_TIMEOUT_MS', 'DSH_TRAE_SSE_CHUNK_TIMEOUT_MS', 'DSH_TRAE_ROTATE_MACHINE_ID',
  'DSH_CLINE_SSE_FIRST_TOKEN_TIMEOUT_MS', 'DSH_CLINE_SSE_CHUNK_TIMEOUT_MS',
  'DSH_LOOMY_FIRST_TOKEN_TIMEOUT_MS', 'DSH_LOOMY_CHUNK_TIMEOUT_MS',
  'DSH_RACCOON_FIRST_TOKEN_TIMEOUT_MS', 'DSH_RACCOON_CHUNK_TIMEOUT_MS',
  'DSH_ZCODE_MAX_CONCURRENCY', 'DSH_ZCODE_SSE_IDLE_TIMEOUT_MS', 'DSH_ZCODE_REQUEST_TIMEOUT_MS',
  // 渠道自己的令牌 / 运行时信息 / 内置 OAuth 客户端
  'QODER_MACHINE_TOKEN_PATH', 'QODER_RUNTIME_INFO',
  'CMDC_PAK_GOOGLE_CLIENT_ID', 'CMDC_PAK_GOOGLE_CLIENT_SECRET',
]

/** 按白名单构造 Worker 环境；`OFM_CODEARTS_CACHE_DIR` 恒定以本实例数据目录为准。 */
export function channelWorkerEnv(env = process.env, dataDir) {
  const output = {}
  for (const name of CHANNEL_ENV_KEYS) {
    if (name === 'OFM_PASSWORD') continue // 显式排除（防御性：清单里永远不该出现）
    const value = env[name]
    if (typeof value === 'string') output[name] = value
  }
  output.OFM_CODEARTS_CACHE_DIR = path.join(dataDir, 'channel-pack', 'codearts-cache')
  return output
}

/** 一实例一 Worker，避免原渠道业务的模块单例串目录、串账号。 */
export async function createChannelRuntime({ dataDir, logger = console, stats }) {
  const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
    workerData: { dataDir },
    execArgv: process.execArgv.filter(arg => !arg.startsWith('--input-type')),
    env: channelWorkerEnv(process.env, dataDir),
  })
  const pending = new Map()
  let sequence = 0
  let closed = false
  let closing
  let rows = []
  let providers = []
  let refreshing
  let refreshTimer
  let finishClose
  let failed
  let readyResolve, readyReject
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const rejectAll = error => {
    failed = error
    readyReject(error)
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }
  worker.on('error', rejectAll)
  worker.on('exit', code => {
    if (!closed) rejectAll(new Error(`渠道进程已退出（${code}）`))
    finishClose?.()
  })
  worker.on('message', message => {
    if (message.type === 'ready') { providers = message.providers; readyResolve(); return }
    if (message.type === 'log') { logger[message.level]?.(message.message); return }
    if (message.type === 'closed') { finishClose?.(); return }
    if (message.type === 'changed') {
      if (closed) return
      clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => { void refresh().catch(error => logger.warn?.(`渠道目录刷新失败：${error.message}`)) }, 200)
      refreshTimer.unref?.()
      return
    }
    const entry = pending.get(message.id)
    if (!entry) return
    if (message.type === 'chunk') {
      try { entry.onChunk?.(message.chunk) } catch (error) { entry.reject(error); worker.postMessage({ type: 'cancel', id: message.id }) }
    } else if (message.type === 'error') entry.reject(Object.assign(new Error(message.message), { statusCode: message.statusCode }))
    else entry.resolve(message.value)
  })
  function call(type, payload = {}, signal, onChunk, timeoutMs = 120000) {
    if (closed || failed) return Promise.reject(failed ?? new Error('渠道已停止'))
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('请求已取消'))
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const finish = fn => value => { clearTimeout(timer); signal?.removeEventListener('abort', abort); pending.delete(id); fn(value) }
      const abort = () => {
        worker.postMessage({ type: 'cancel', id })
        entry.reject(signal?.reason ?? new Error('渠道请求超时或已取消'))
      }
      const timer = setTimeout(abort, timeoutMs)
      timer.unref?.()
      const entry = { resolve: finish(resolve), reject: finish(reject), onChunk }
      pending.set(id, entry)
      signal?.addEventListener('abort', abort, { once: true })
      worker.postMessage({ type, id, ...payload })
    })
  }
  function refresh() {
    if (refreshing) return refreshing
    refreshing = call('models').then(value => { rows = value; return rows }).finally(() => { refreshing = undefined })
    return refreshing
  }
  const runtime = {
    get providers() { return providers },
    state() { return { state: failed ? 'failed' : 'ready', error: failed ? failed.message : '' } },
    publicModelRows: () => rows,
    refresh,
    handles: model => providers.some(provider => model.startsWith(`${provider}/`)),
    async rpc(body, signal) {
      if (typeof body?.method !== 'string' || !Object.hasOwn(body, 'payload')) throw Object.assign(new Error('渠道请求缺少 method 或 payload'), { statusCode: 400 })
      return call('rpc', { call: { method: body.method, payload: body.payload } }, signal, undefined, 10 * 60000)
    },
    async complete(request, onChunk) {
      const outcome = { text: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }
      const started = Date.now()
      let first = 0
      let ok = false
      try {
        const { signal, ...wire } = request
        await call('complete', { request: wire }, signal, chunk => {
          if (!first) first = Date.now()
          foldForwardOutcome(outcome, chunk)
          onChunk?.(chunk)
        }, 30 * 60000)
        ok = outcome.error === undefined
        return outcome
      } finally {
        if (!closed && stats) {
          const usage = outcome.usage
          recordUsage(stats, {
            model: request.model, at: Date.now(), input: usage?.prompt_tokens ?? 0, output: usage?.completion_tokens ?? 0,
            reasoning: usage?.completion_tokens_details?.reasoning_tokens ?? 0, cacheRead: usage?.prompt_tokens_details?.cached_tokens ?? 0,
            ok, origin: 'forward', ttftMs: first ? first - started : undefined,
            decodeMs: first ? Date.now() - first : 0, decodeTokens: usage?.completion_tokens ?? 0,
            noUsage: usage === undefined, elapsedMs: Date.now() - started, aborted: request.signal?.aborted === true,
          })
          recordTurn(stats, { model: request.model, ok, recovered: false })
        }
      }
    },
    close() {
      if (closing) return closing
      closed = true
      clearTimeout(refreshTimer)
      rejectAll(new Error('渠道正在停止'))
      closing = (async () => {
        let timer
        await new Promise(resolve => {
          finishClose = resolve
          worker.postMessage({ type: 'close' })
          timer = setTimeout(resolve, 1500)
        })
        clearTimeout(timer)
        await worker.terminate()
      })()
      return closing
    },
  }
  try {
    const timeout = setTimeout(() => readyReject(new Error('渠道初始化超时')), 30000)
    try { await ready } finally { clearTimeout(timeout) }
    runtime.ready = refresh().catch(error => { if (!closed) logger.warn?.(`渠道启动清单刷新失败：${error.message}`) })
    return runtime
  } catch (error) { await runtime.close(); throw error }
}
