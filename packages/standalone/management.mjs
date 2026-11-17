import { modelAvailability } from '../../src/model-test.js'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { buildStats } from '../../src/core/stats.js'
import { generateKey } from '../../src/forward.js'
import { structuralRejection } from '../../src/trust.js'
import { openLoginTerminal } from './login-terminal.mjs'
import { publicModelVisibility, validateModelVisibility, isModelHidden } from '../../src/store.js'
import { normalizeCombos, buildComboCatalog, isComboEntry } from '../../src/combos.js'

const PREFIX = '/api/management'
const BOOTSTRAP_MS = 10 * 60_000
const SESSION_MS = 8 * 60 * 60_000
const MAX_BODY_BYTES = 16 * 1024
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
])
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
}

function fail(statusCode, message) {
  return Object.assign(new Error(message), { statusCode })
}

function matches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || expected === '') return false
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

async function readBody(req, limit = MAX_BODY_BYTES) {
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw fail(415, '请求必须使用 application/json')
  }
  let bytes = 0
  const chunks = []
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > limit) throw fail(413, '请求内容过大')
    chunks.push(chunk)
  }
  let value
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw fail(400, '请求不是有效 JSON') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail(400, '请求必须是 JSON 对象')
  return value
}

function validateSettings(patch) {
  const visibility = validateModelVisibility(patch)
  const booleans = new Set(['enabled', 'exposeRegionModels', 'streamRecovery', 'standaloneProbe', 'standaloneLanEnabled'])
  const numbers = { probeIntervalMinutes: [1, 1440], defaultMaxTokens: [512, 131072], standaloneLanPort: [0, 65535] }
  const result = {}
  for (const [key, value] of Object.entries(patch)) {
    if (Object.hasOwn(visibility, key)) { result[key] = visibility[key]; continue }
    if (booleans.has(key)) {
      if (typeof value !== 'boolean') throw fail(400, `${key} 必须是布尔值`)
    } else if (Object.hasOwn(numbers, key)) {
      const [min, max] = numbers[key]
      if (!Number.isInteger(value) || value < min || value > max) throw fail(400, `${key} 必须是 ${min} 到 ${max} 的整数`)
    } else if (key === 'combos') {
      /**
       * 路由链（2026-11-17，对齐插件版 `src/combos.js`）。
       *
       * 只校验「是不是数组」，逐项归一交给 `normalizeCombos` —— 它已经处理了
       * 非对象项、重复 id、空 models、未知 strategy、非法 stickyLimit。
       * 在这里重复实现一遍校验只会让两处规则分叉。
       */
      if (!Array.isArray(value)) throw fail(400, 'combos 必须是数组')
    } else throw fail(400, `不支持的设置字段：${key}`)
    result[key] = value
  }
  return result
}

export function managementSettings(value) {
  return {
    ...publicModelVisibility(value),
    enabled: value.enabled !== false,
    exposeRegionModels: value.exposeRegionModels !== false,
    streamRecovery: value.streamRecovery !== false,
    standaloneProbe: value.standaloneProbe === true,
    standaloneLanEnabled: value.standaloneLanEnabled === true,
    standaloneLanPort: value.standaloneLanPort ?? 0,
    probeIntervalMinutes: value.probeIntervalMinutes ?? 15,
    defaultMaxTokens: value.defaultMaxTokens ?? 32768,
    combos: Array.isArray(value.combos) ? value.combos : [],
  }
}

/** 管理读写要求鉴权；登录恢复仅允许同源页面触发固定本机动作。 */
export function createManagement({ stores, runtime, channels, info, onSettingsChanged, loginTerminal = openLoginTerminal }) {
  let bootstrap = { token: crypto.randomBytes(32).toString('base64url'), until: Date.now() + BOOTSTRAP_MS }
  const sessions = new Map()
  let cookieName
  let closed = false
  let terminalOpening = false
  let terminalOpenedAt = null
  const loginPlatform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'unsupported'
  const assets = new Map([...ASSETS].map(([url, [file, type]]) => [
    url, { type, body: file === 'index.html'
      ? Buffer.from(fs.readFileSync(new URL(`./web/${file}`, import.meta.url), 'utf8')
        .replace('data-login-platform="unsupported"', `data-login-platform="${loginPlatform}"`))
      : fs.readFileSync(new URL(`./web/${file}`, import.meta.url)) },
  ]))
  // 只公开构建清单中经过路径校验的 JS/CSS，绝不按请求路径读取磁盘。
  const manifest = JSON.parse(fs.readFileSync(new URL('./web/assets.json', import.meta.url), 'utf8'))
  if (!Array.isArray(manifest) || manifest.some(name => typeof name !== 'string' || !/^[\w-]+\.(js|css)$/.test(name))) {
    throw new Error('独立端资源清单无效')
  }
  for (const name of manifest) assets.set(`/assets/${name}`, {
    type: name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
    body: fs.readFileSync(new URL(`./web/${name}`, import.meta.url)),
  })
  const json = (res, status, payload, headers = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers })
    res.end(JSON.stringify(payload))
  }
  const cookie = req => {
    const parts = String(req.headers.cookie ?? '').split(';')
    return parts.map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
  }
  const clearCookie = () => `${cookieName}=; Path=${PREFIX}; HttpOnly; SameSite=Strict; Max-Age=0`
  const pruneSessions = () => {
    for (const [id, until] of sessions) if (until <= Date.now()) sessions.delete(id)
  }
  /**
   * 面板**密码**（环境变量 `OFM_PASSWORD`，2026-11-17 用户要求）。
   *
   * ## 语义（用户原话）
   * 「把 api key 登录变成环境变量里面的 ofm_password 登录，127.0.0.1 和局域网都是，
   *  如果不设置，直接不需要认证，点退出后认证界面只有登录，没有输入密码，
   *  如果设置了，需要输入密码才能登录」面板令牌已更名为 OFM_PASSWORD
   *
   * 于是有两条互斥的形态：
   *
   * | `OFM_PASSWORD` | 行为 |
   * |---|---|
   * | 未设置 / 空 | **完全免认证** —— 回环与局域网一律直接进控制台；     * |               | 登录页只剩一个「登录」按钮（没有密码框） |
   * | 已设置 | 登录页输密码；`/v1/*` 推理**不受影响**，仍只认 LAN key |
   *
   * ## 为什么不再接受 API Key 登录
   * 此前 `forwardKey` 同时是「推理凭据」和「管理面凭据」，一个泄露两边全开。
   * 改成密码后两套凭据彻底分离：密码只解锁管理面，API Key 只调推理。
   *
   * ⚠️ 只有**空值 / 纯空白**才算未设置 —— 别的都当成真实密码（哪怕很短），
   *   不做长度校验：容器里 `-e OFM_PASSWORD=x` 也应当按用户本意生效。
   */
  const panelPassword = String(process.env.OFM_PASSWORD ?? '').trim()
  /** 登录页是否需要密码框。同时用于 `/auth` 这个**免认证**接口。 */
  const passwordRequired = () => panelPassword !== ''
  const authenticated = req => {
    // 未设密码 = 不认证任何人，也放行所有人（用户明确要求「直接不需要认证」）。
    if (!passwordRequired()) return true
    const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1]
    // 脚本 / 自动化可以用密码当 Bearer 调管理 API。
    if (matches(bearer, panelPassword)) return true
    pruneSessions()
    return sessions.has(cookie(req))
  }
  const persist = patch => {
    const previous = stores.settings.get()
    stores.settings.update(patch)
    stores.settings.flush()
    if (stores.settings.writeFailed) {
      // 不向页面谎报保存成功；保留原运行配置并由后续写入重试落盘。
      stores.settings.value = previous
      throw fail(500, '无法保存设置，请检查数据目录权限和磁盘空间')
    }
  }
  const summary = () => {
    const state = runtime.state()
    const available = stores.availability.get()
    const routable = new Set(runtime.publicModelRows().map(entry => entry.id))
    return {
      ...info(),
      channels: channels?.state(),
      settings: managementSettings(stores.settings.get()),
      catalogSyncedAt: stores.settings.get().catalogSyncedAt ?? 0,
      probedAt: available.at ?? 0,
      catalog: state.catalog.map(entry => {
        const measured = modelAvailability(entry.id, available, Boolean(entry.channel))
        return ({
        id: entry.id, name: entry.name, channel: entry.channel ?? 'anonymous',
        vision: entry.vision === true, reasoning: entry.reasoning === true || (entry.reasoning !== null && typeof entry.reasoning === 'object'),
        contextWindow: entry.contextWindow ?? entry.context_window, maxOutput: entry.maxOutput ?? entry.max_tokens,
        routable: routable.has(entry.id),
        hiddenByUser: isModelHidden(entry, state.settings),
        hiddenByGroup: isModelHidden(entry, { ...state.settings, hiddenModelIds: [] }),
        ...measured, availability: measured.availabilitySource === 'listing' ? 'listed' : measured.availability,
      }) }),
    }
  }

  async function route(req, res, pathname) {
    const method = req.method ?? 'GET'
    if (method === 'POST' && pathname === `${PREFIX}/login/terminal`) {
      // 此入口发生在登录前，必须有浏览器的同源 Origin，拒绝跨站和无来源调用。
      if (req.headers.origin !== new URL(`http://${req.headers.host}`).origin ||
          req.headers['sec-fetch-site'] !== 'same-origin') {
        throw fail(403, '请从本机登录页面点击获取令牌')
      }
      const body = await readBody(req)
      if (Object.keys(body).length !== 0) throw fail(400, '获取令牌不接受路径或命令参数')
      if (terminalOpening || (terminalOpenedAt !== null && Date.now() - terminalOpenedAt < 30_000)) {
        throw fail(429, '已请求打开终端，请检查弹出的窗口，30 秒后可重试')
      }
      terminalOpening = true
      try {
        await loginTerminal(info().dataDir)
        terminalOpenedAt = Date.now()
        json(res, 200, { ok: true })
      } finally { terminalOpening = false }
      return
    }
    /**
     * `GET /auth` —— **免认证**，只回答「这个面板要不要密码」。
     *
     * 为什么需要单独一条：登录页渲染时还没有任何会话，拿不到 summary；
     * 而表单要不要显示密码框完全取决于 `OFM_PASSWORD` 是否设置。
     * 把这条放在 `authenticated()` 之前是有意的 —— 它不泄露任何秘密，
     * 只暴露一个布尔值（攻击者本来也能从前端行为看出来）。
     */
    if (method === 'GET' && pathname === `${PREFIX}/auth`) {
      json(res, 200, { required: passwordRequired() })
      return
    }
    if (method === 'POST' && pathname === `${PREFIX}/session`) {
      const body = await readBody(req)
      const validBootstrap = bootstrap !== null && bootstrap.until > Date.now() && matches(body.bootstrapToken, bootstrap.token)
      /**
       * 三种进入方式，按用户 2026-11-17 的要求收敛为**密码优先**：
       * 1. 未设 `OFM_PASSWORD` → 直接放行（登录页只有一个「登录」按钮，`body.password` 为空）
       * 2. 设了 → 校验 `body.password`（同时容忍 `body.key`，便于既有脚本与
       *    `#login=` 一次性链接复用同一入口）
       * 3. 一次性 bootstrap 链接（本机 CLI 打印）继续有效，不受密码影响
       */
      const passwordOk = !passwordRequired()
        || matches(body.password, panelPassword)
        || matches(body.key, panelPassword)
      if (!validBootstrap && !passwordOk) {
        throw fail(401, passwordRequired() ? '密码不正确' : '登录链接已失效')
      }
      pruneSessions()
      if (sessions.size >= 64) throw fail(429, '管理会话过多，请稍后重试')
      if (validBootstrap) bootstrap = null
      const id = crypto.randomBytes(32).toString('base64url')
      sessions.set(id, Date.now() + SESSION_MS)
      json(res, 200, { ok: true }, {
        'set-cookie': `${cookieName}=${id}; Path=${PREFIX}; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`,
      })
      return
    }
    if (!authenticated(req)) throw fail(401, '请先登录管理页面')
    if (method === 'POST' && pathname === `${PREFIX}/logout`) {
      await readBody(req)
      sessions.delete(cookie(req))
      json(res, 200, { ok: true }, { 'set-cookie': clearCookie() })
    } else if (method === 'GET' && pathname === `${PREFIX}/summary`) {
      json(res, 200, summary())
    } else if (method === 'GET' && pathname === `${PREFIX}/stats`) {
      // ⚠️ `includeCacheRead` 必须与插件设置页同口径（用户 2026-10-25 要求
      // 「今日消耗 / 累计消耗 / 消耗分布 / 用量一览的总 token 都算上缓存」）。
      // 缺了这个选项，独立端与插件看板的总量会系统性差一截 —— 缓存读同样是
      // 模型真实处理过的 token，只是计费打折。口径来源见 src/core/stats.js。
      json(res, 200, buildStats(stores.stats.get(), runtime.catalog, { includeCacheRead: true }))
    } else if (method === 'POST' && pathname === `${PREFIX}/channels/rpc` && channels) {
      // 渠道备份导入包含多账号凭据，仍限制总大小，但不能套设置表单的 16KB。
      const body = await readBody(req, 8 * 1024 * 1024)
      if (body.method === 'gateway.getEnabled' || body.method === 'gateway.setEnabled') {
        if (body.method === 'gateway.setEnabled') {
          if (typeof body.payload?.enabled !== 'boolean') throw fail(400, 'enabled 必须是布尔值')
          persist({ enabled: body.payload.enabled })
          await onSettingsChanged()
        }
        const base = new URL(info().baseUrl)
        json(res, 200, { ok: true, value: {
          enabled: stores.settings.get().enabled !== false, running: stores.settings.get().enabled !== false,
          blockedByEnv: false, address: { host: base.hostname, port: Number(base.port) },
          apiKey: { value: stores.settings.get().forwardKey, path: `${info().dataDir}/settings.json`, fromEnv: false },
          models: runtime.publicModelRows(), modelsSource: 'catalog',
        } })
      } else {
        const controller = new AbortController()
        const abort = () => controller.abort()
        res.once('close', abort)
        try { json(res, 200, await channels.rpc(body, controller.signal)) }
        finally { res.removeListener('close', abort) }
      }
    } else if (method === 'POST' && pathname === `${PREFIX}/settings`) {
      const patch = validateSettings(await readBody(req))
      persist(patch)
      await onSettingsChanged()
      json(res, 200, { settings: managementSettings(stores.settings.get()), lan: info().lan })
    }
    /**
     * 路由（降级链）—— 结构与插件端 `index.js` 的 `combos.list` / `save` / `preview`
     * 一一对应（2026-11-17 用户要求「把插件端功能全部读一遍再改」「轮询可以添加
     * 渠道的成员等等」）。
     *
     * ## 三个端点，为什么不是一个
     * - `GET  /combos`          —— 链路 + **候选模型** + **解析结果(usable)**
     * - `POST /combos`          —— 整表替换，回写 `usable`
     * - `POST /combos/preview`  —— 编辑器里「链路能力交集」的实时预览
     *
     * 预览必须单独一条：它算的是**还没保存**的草稿链，不能借道 GET。
     */
    const comboModels = () => {
      /**
       * 候选 = 本服务的全部真实模型，排除链路自身（**链路不能嵌套**：
       * `buildComboCatalog` 建索引时就跳过 combo 行，嵌套只会变成死成员）。
       *
       * ⚠️ 与插件端同步的一条规则：推理总开关关闭（`settings.enabled === false`）
       * 时，免费车道与 Kilo 的模型实际不可用（adapter 会拦），候选里再列出来
       * 只会误导 —— 排除「无 channel 字段（免费车道）」与 `channel === 'kilo'`
       * 两类行。渠道模型不受该开关影响。
       *
       * `provider` 是分组的键：同名 GLM-5.3 会来自好几家，平铺成一列时用户
       * 无从分辨，必须按供应商分组展示。
       */
      const enabled = stores.settings.get().enabled !== false
      return runtime.catalog
        .filter(entry => !isComboEntry(entry))
        .filter(entry => enabled || (entry.channel !== undefined && entry.channel !== 'kilo'))
        .map(entry => ({
          id: entry.id,
          name: entry.name ?? entry.id,
          channel: entry.channel ?? 'free',
          vision: entry.vision === true,
          contextWindow: entry.contextWindow,
          maxOutput: entry.maxOutput,
          ...entry.provider === undefined ? {} : { provider: entry.provider },
        }))
    }
    /** 链路的解析结果：`models` 是**当前目录里查得到**的成员，带能力交集。 */
    const comboUsable = () => runtime.catalog
      .filter(entry => isComboEntry(entry))
      .map(entry => ({
        id: entry.id, name: entry.name, models: entry.combo,
        contextWindow: entry.contextWindow, maxOutput: entry.maxOutput, vision: entry.vision === true,
      }))

    if (method === 'GET' && pathname === `${PREFIX}/combos`) {
      json(res, 200, {
        combos: normalizeCombos(stores.settings.get().combos),
        models: comboModels(),
        usable: comboUsable(),
        strategies: ['fallback', 'round-robin'],
      })
    } else if (method === 'POST' && pathname === `${PREFIX}/combos/preview`) {
      const body = await readBody(req)
      if (!Array.isArray(body.models)) throw fail(400, 'models 必须是模型 id 数组')
      if (body.models.length > 1000) throw fail(400, '一条链最多引用 1000 个模型')
      const rows = buildComboCatalog(normalizeCombos([{ name: 'preview', models: body.models }]), runtime.catalog)
      const row = rows[0]
      json(res, 200, {
        capacity: row === undefined ? null : {
          contextWindow: row.contextWindow, maxOutput: row.maxOutput, vision: row.vision === true,
        },
      })
    } else if (method === 'POST' && pathname === `${PREFIX}/combos`) {
      /**
       * 整表替换（不是逐条 CRUD）：前端编辑器天然持有完整列表，逐条增删会引入
       * 「删到一半失败」的中间态。**非法项由 `normalizeCombos` 归一丢弃**，
       * 所以一次失败的编辑最多被归一，不会把设置写坏。
       *
       * 链长上限 1000 与 preview 对齐 —— 无上限的链会被 `completeCombo` 顺序
       * 全走一遍，放大重试面。
       */
      const body = await readBody(req)
      if (!Array.isArray(body.combos)) throw fail(400, '请提供 combos 数组')
      for (const row of body.combos) {
        if (row !== null && typeof row === 'object' && Array.isArray(row.models) && row.models.length > 1000) {
          throw fail(400, '一条链最多引用 1000 个模型')
        }
      }
      const rows = normalizeCombos(body.combos)
      persist({ combos: rows })
      await onSettingsChanged?.()
      json(res, 200, { combos: rows, usable: comboUsable() })
    } else if (method === 'GET' && pathname === `${PREFIX}/lan/key`) {
      json(res, 200, { key: stores.settings.get().standaloneLanKey ?? '' })
    } else if (method === 'POST' && pathname === `${PREFIX}/lan/key/rotate`) {
      const body = await readBody(req)
      if (body.confirm !== true || Object.keys(body).length !== 1) throw fail(400, 'LAN key rotation requires only confirm: true')
      persist({ standaloneLanKey: generateKey() })
      json(res, 200, { key: stores.settings.get().standaloneLanKey })
    } else if (method === 'GET' && pathname === `${PREFIX}/key`) {
      json(res, 200, { key: stores.settings.get().forwardKey })
    } else if (method === 'POST' && pathname === `${PREFIX}/key/rotate`) {
      const body = await readBody(req)
      if (body.confirm !== true) throw fail(400, '请确认轮换 API Key')
      const id = cookie(req)
      persist({ forwardKey: generateKey() })
      // 仅当前管理会话保留；旧密钥与其他会话立即失效。
      const until = sessions.get(id)
      sessions.clear()
      if (until) sessions.set(id, until)
      bootstrap = null
      json(res, 200, { key: stores.settings.get().forwardKey })
    } else if (method === 'POST' && pathname === `${PREFIX}/models/refresh`) {
      const body = await readBody(req)
      if (body.probe !== undefined && typeof body.probe !== 'boolean') throw fail(400, 'probe 必须是布尔值')
      await runtime.refreshCatalog({ probe: body.probe === true, force: body.probe === true })
      json(res, 200, summary())
    } else if (method === 'POST' && pathname === `${PREFIX}/models/test`) {
      const body = await readBody(req)
      if (stores.settings.get().enabled === false) throw fail(503, '推理服务已暂停，请先在服务设置中启用')
      if (typeof body.model !== 'string' || body.model.length > 300) throw fail(400, '请选择有效模型')
      const controller = new AbortController()
      const abort = () => controller.abort()
      res.once('close', abort)
      try {
        const result = await runtime.testModel(body.model, undefined, { signal: controller.signal })
        if (!controller.signal.aborted) json(res, 200, result)
      } catch (error) {
        if (!controller.signal.aborted) throw fail(error.status === 404 ? 404 : error.code === 'TIMEOUT' ? 504 : 502, String(error.message ?? '模型测试失败'))
      } finally {
        res.removeListener('close', abort)
      }
    } else throw fail(404, '管理接口不存在')
  }

  return {
    setPort(port) { cookieName = `ofm_management_${port}` },
    get bootstrapFragment() { return bootstrap === null ? '' : `#login=${bootstrap.token}` },
    async handleRequest(req, res) {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      const asset = assets.get(pathname)
      const isApi = pathname === PREFIX || pathname.startsWith(`${PREFIX}/`)
      if (!asset && !isApi) return false
      // 不接受插件专用 dsh-app Referer；独立管理只允许本页面的 HTTP 来源。
      const referer = req.headers.referer
      const origin = req.headers.origin
      const malformedSource = [referer, origin].some(value => value !== undefined && (
        typeof value !== 'string' || !value.startsWith('http://')
      ))
      if (closed || !cookieName) json(res, 503, { error: '服务正在停止或启动' })
      else if (malformedSource || structuralRejection(req) !== undefined) json(res, 403, { error: '管理接口仅允许本机同源访问' })
      else if (asset) {
        if (req.method !== 'GET' && req.method !== 'HEAD') json(res, 405, { error: '资源仅支持 GET 或 HEAD' })
        else {
          res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': asset.type })
          res.end(req.method === 'HEAD' ? undefined : asset.body)
        }
      } else {
        try { await route(req, res, pathname) } catch (error) {
          if (!res.destroyed && !res.headersSent) json(res, error.statusCode ?? 500, {
            error: error.statusCode ? error.message : '管理操作失败，请查看服务日志',
          })
        }
      }
      return true
    },
    dispose() { closed = true; bootstrap = null; sessions.clear() },
  }
}
