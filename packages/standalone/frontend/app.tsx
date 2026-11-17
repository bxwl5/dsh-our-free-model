import { createRoot } from 'react-dom/client'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'
import { Sidebar, Topbar } from './components/shell'
import { Overview } from './components/overview'
import { Routing } from './routing'
import { Connection } from './connection'
import type { Host, Page, ServiceSettings, Snapshot, RoutingChain } from './types'
import './app.css'

const API = '/api/management'
const pageNames: Page[] = ['overview', 'models', 'usage', 'channels', 'routing', 'settings', 'connection']

/**
 * 复制到剪贴板（2026-11-16，修「复制地址/密钥失败」）。
 *
 * ## 为什么不能只用 `navigator.clipboard`
 *
 * 它在**安全上下文**（HTTPS 或 localhost）之外**根本不存在** —— 而本面板
 * 局域网访问是 `http://<宿主IP>:9981`，既非 HTTPS 也非 localhost，
 * 实测 `window.isSecureContext === false`、`navigator.clipboard === undefined`。
 * 于是 `host.copy` 里那句 `await navigator.clipboard.writeText(value)` 直接抛
 * `TypeError`，用户点了「复制」什么也没发生（也没有提示）。
 *
 * ## 三级降级
 *
 * 1. `navigator.clipboard.writeText` —— 安全上下文下的首选
 * 2. `document.execCommand('copy')` —— 非安全上下文的传统通路（**HTTP 下唯一可用**）
 * 3. 抛错，交给调用方提示「请手动选中复制」
 *
 * @returns 是否成功
 */
export async function copyText(value: string): Promise<boolean> {
  const text = String(value ?? '')
  // ① 现代 API：需要安全上下文
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 落到 ②
  }
  // ② execCommand 兜底：HTTP 下这就是唯一能用的那条
  try {
    const area = document.createElement('textarea')
    area.value = text
    // 放在视口内但视觉上不可见 —— `display:none` 会让 select() 失效
    area.setAttribute('readonly', '')
    area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;'
    document.body.appendChild(area)
    const selection = document.getSelection()
    const previous = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
    area.select()
    area.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    area.remove()
    // 还原用户原本的选区，避免复制行为打断输入
    if (previous !== null && selection !== null) {
      selection.removeAllRanges()
      selection.addRange(previous)
    }
    return ok
  } catch {
    return false
  }
}
type Request = <T = any>(path: string, body?: unknown, timeoutMs?: number, signal?: AbortSignal) => Promise<T>
const messageOf = (error: unknown) => error instanceof Error ? error.name === 'TimeoutError' ? '请求超时，请检查服务是否仍在运行。' : error.message : '请求失败，请重试。'

function LoginScreen({ request }: { request: Request }) {
  /**
   * 登录页（2026-11-17 重构：API Key 登录 → 密码登录）。
   *
   * 用户要求：「把 api key 登录变成环境变量里面的 ofm_password 登录，
   * 127.0.0.1 和局域网都是，如果不设置，直接不需要认证，点退出后认证界面
   * 只有登录，没有输入密码，如果设置了，需要输入密码才能登录」
   *
   * 于是这里分两种形态，由 `GET /auth`（免认证接口）决定：
   *
   * | `required` | 渲染 |
   * |---|---|
   * | `false`（未设 OFM_PASSWORD） | 只有「登录」按钮，没有输入框 |
   * | `true` | 密码框 + 「登录」按钮 |
   *
   * ⚠️ 不再保留「从本机获取令牌」那一整套帮助（终端命令、剪贴板、
   *   各平台说明）—— 那是 API Key 时代的产物，密码由部署者自己定，
   *   没有「去本机捞一个」的必要。
   */
  const [password, setPassword] = useState('')
  const [required, setRequired] = useState<boolean | undefined>(undefined)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const value = await request<{ required: boolean }>('/auth')
        if (alive) setRequired(value.required === true)
      } catch {
        // 拿不到就按「要密码」处理：宁可多问一次，也不要让免密形态误判后 401。
        if (alive) setRequired(true)
      }
    })()
    return () => { alive = false }
  }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    try {
      await request('/session', required ? { password: password.trim() } : {})
      setPassword('')
      window.dispatchEvent(new CustomEvent('ofm:logged-in'))
    } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) }
  }

  // 还在问 `/auth`：不要闪一下空框，给一个稳定的过渡（与 loading 同一语气）。
  if (required === undefined) return <section id="login-screen" className="login-shell" data-testid="login-screen">
    <div className="login-card login-card-enter"><span className="login-card-glow" aria-hidden="true" />
      <div className="brand-mark" aria-hidden="true">ofm<span>.</span></div>
      <span className="eyebrow">OUR FREE MODEL / LOCAL CONSOLE</span>
      <h1>连接你的本地服务</h1><p>正在确认认证方式…</p></div></section>

  return <section id="login-screen" className="login-shell" data-testid="login-screen"><div className="login-card login-card-enter"><span className="login-card-glow" aria-hidden="true" /><div className="brand-mark" aria-hidden="true">ofm<span>.</span></div>
    <span className="eyebrow">OUR FREE MODEL / LOCAL CONSOLE</span><h1>连接你的本地服务</h1>
    <p>{required ? '输入部署时设置的面板密码。' : '当前未设置面板密码，直接进入控制台。'}</p>
    <form id="login-form" onSubmit={event => { void submit(event) }}>
      {required && <>
        <label htmlFor="login-password">面板密码</label>
        <input id="login-password" name="password" type="password" autoComplete="current-password"
          placeholder="OFM_PASSWORD" required autoFocus value={password}
          onChange={event => setPassword(event.target.value)} />
      </>}
      <button className={"primary" + (busy ? " is-busy" : "")} type="submit" disabled={busy}>
        {busy && <span className="ui-spinner" aria-hidden="true" />}
        <span className="login-submit-label">登录</span> <span aria-hidden="true">→</span></button>
    </form>
    {error && <p id="login-error" role="alert" className="error login-error-enter">{error}</p>}
    <small>{required
      ? '密码由部署者通过环境变量 OFM_PASSWORD 设置；会话在 8 小时后或服务重启后失效。'
      : '要加一道门？部署时设置环境变量 OFM_PASSWORD 即可。'}</small></div></section>
}

function LoadingScreen() { return <div id="loading-screen" className="loading-screen"><div className="loading-inner"><div className="brand-mark loading-brand">ofm<span>·</span></div><span className="loading-bar" aria-hidden="true"><span className="loading-bar-fill" /></span><p>正在连接本地服务…</p></div></div> }
function ChannelMount({ kind, summary }: { kind: 'channels'; summary: Snapshot['summary'] & { reload(): void } }) {
  const [module, setModule] = useState<typeof import('./channels.mjs')>(); const generation = useRef(0); const summaryRef = useRef(summary); summaryRef.current = summary
  useEffect(() => { const current = ++generation.current; let alive = true; void import('./channels.mjs').then(value => { if (alive && current === generation.current) setModule(value) }); return () => { alive = false; generation.current++; module?.hide() } }, [kind])
  useEffect(() => { if (!module) return; module.show(kind, summaryRef.current); return () => module.hide() }, [module, kind])
  return <div id="channel-root" className="ofm_root" role={module ? undefined : 'status'}>{module ? null : '正在加载渠道管理…'}</div>
}
function LazyPage({ name, snapshot, host, active }: { name: 'models' | 'usage' | 'settings'; snapshot: Snapshot; host: Host; active: boolean }) {
  const [module, setModule] = useState<any>(); useEffect(() => { let alive = true; const loaded = name === 'models' ? import('./models') : name === 'usage' ? import('./usage') : import('./settings'); void loaded.then(value => { if (alive) setModule(value) }); return () => { alive = false } }, [name])
  if (!module) return <p role="status">正在加载页面…</p>; const Component = module[name === 'models' ? 'Models' : name === 'usage' ? 'Usage' : 'Settings']; return <Component summary={snapshot.summary} stats={snapshot.stats} host={host} active={active} />
}
function App() {
  const [mode, setMode] = useState<'loading' | 'login' | 'ready'>('loading'), [snapshot, setSnapshot] = useState<Snapshot>(), [page, setPage] = useState<Page>('overview'), [notice, setNotice] = useState(''), [error, setError] = useState('')
  const [visited, setVisited] = useState<Page[]>([])
  const generation = useRef(0), loading = useRef<Promise<void> | undefined>(undefined), authenticated = useRef(false), settingsRevision = useRef(0)
  const enterLogin = (reason = '') => { generation.current++; loading.current = undefined; authenticated.current = false; setSnapshot(undefined); setVisited([]); setPage('overview'); setError(reason); setNotice(''); setMode('login') }
  const request: Request = async (path, body, timeoutMs = 10000, signal) => { const current = generation.current; const response = await fetch(API + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) }); const value = await response.json(); if (!response.ok) { const reason = Object.assign(new Error(value.error ?? `请求失败（${response.status}）`), { status: response.status }); if (current === generation.current && response.status === 401 && path !== '/session') enterLogin(reason.message); throw reason } if (current !== generation.current) throw new Error('管理会话已变化，请重新操作。'); return value }
  const loadData = async () => { if (loading.current) return loading.current; const current = generation.current, revision = settingsRevision.current; const pending = Promise.all([request('/summary'), request('/stats')]).then(([summary, stats]) => { if (current !== generation.current) return; setSnapshot(previous => ({ summary: revision !== settingsRevision.current && previous ? { ...summary, settings: previous.summary.settings } : summary, stats })); authenticated.current = true; setMode('ready'); setError('') }).finally(() => { if (loading.current === pending) loading.current = undefined }); loading.current = pending; return pending }
  const host = useMemo<Host>(() => ({ navigate: next => { if (pageNames.includes(next)) { setPage(next); setVisited(previous => previous.includes(next) ? previous : [...previous, next]); setError(''); setNotice('') } }, refresh: async () => { await loadData() }, copy: async value => { const ok = await copyText(value); setNotice(ok ? '已复制到剪贴板' : '浏览器不允许自动复制，请手动选中复制') }, getApiKey: async () => (await request<{ key: string }>('/key')).key, rotateKey: async () => (await request<{ key: string }>('/key/rotate', { confirm: true })).key, getCombos: async () => await request('/combos') as any, saveCombos: async combos => await request('/combos', { combos }) as any, previewCombo: async models => (await request<{ capacity: any }>('/combos/preview', { models })).capacity, getLanKey: async () => (await request<{ key: string }>('/lan/key')).key, rotateLanKey: async () => (await request<{ key: string }>('/lan/key/rotate', { confirm: true })).key, logout: async () => { await request('/logout', {}); enterLogin('已退出管理') }, error: reason => setError(messageOf(reason)), testModel: (model, signal) => request('/models/test', { model }, 330000, signal), refreshModels: async (probe, signal) => { await request('/models/refresh', { probe }, 300000, signal); if (!signal.aborted) await loadData() }, saveSettings: async (settings: Partial<ServiceSettings>) => { const value = await request<{ settings: ServiceSettings }>('/settings', settings); settingsRevision.current++; setSnapshot(previous => previous ? { ...previous, summary: { ...previous.summary, settings: value.settings } } : previous); return value.settings } }), [page])
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }) }, [page])
  useEffect(() => { const onUnauthorized = () => enterLogin('管理会话已失效，请重新登录'); window.addEventListener('ofm:unauthorized', onUnauthorized); return () => window.removeEventListener('ofm:unauthorized', onUnauthorized) }, [])
  useEffect(() => { const token = new URLSearchParams(location.hash.slice(1)).get('login'); if (token) history.replaceState(null, '', location.pathname + location.search); void (async () => { try { if (token) await request('/session', { bootstrapToken: token }); await loadData() } catch (reason) { enterLogin((reason as any)?.status === 401 && !token ? '' : messageOf(reason)) } })() }, [])
  useEffect(() => { if (mode !== 'ready') return; const timer = window.setInterval(() => { if (!document.hidden) void loadData().catch(reason => setError(messageOf(reason))) }, 15000); return () => window.clearInterval(timer) }, [mode])
  const content: ReactNode = snapshot && page === 'overview' ? <Overview {...snapshot} host={host} /> : snapshot && page === 'connection' ? <Connection summary={snapshot.summary} host={host} active /> : snapshot && page === 'channels' ? <ChannelMount key={page} kind={page} summary={{ ...snapshot.summary, reload: () => { void loadData() } }} /> : snapshot && page === 'routing' ? <Routing summary={snapshot.summary} host={host} active /> : null
  if (mode === 'loading') return <LoadingScreen />
  if (mode === 'login') return <LoginScreen request={async (...args) => { const result = await request(...args); if (args[0] === '/session') await loadData(); return result }} />
  return <div id="app" className="app-shell"><aside className="sidebar"><Sidebar page={page} summary={snapshot?.summary} host={host} /></aside><main><header className="topbar"><Topbar page={page} summary={snapshot?.summary} /></header>{snapshot?.summary.networkMode === 'fixture' && <div className="notice test-mode-notice notice-enter" role="alert">当前为本机替身测试模式：账号、模型回答与额度均为测试数据。</div>}{notice && <div className="notice notice-enter" role="status">{notice}<button className="text-button" onClick={() => setNotice('')}>关闭</button></div>}{error && <div className="notice error-notice notice-enter" role="alert"><AlertCircle size={16} /><span>{error}</span><button className="text-button" onClick={() => { setError(''); void loadData() }}>重试</button></div>}<section className="page">{content}{snapshot && (['models', 'usage', 'settings'] as const).filter(name => visited.includes(name)).map(name => <div key={name} hidden={page !== name}><LazyPage name={name} snapshot={snapshot} host={host} active={page === name} /></div>)}</section><footer>OUR FREE MODEL <span>·</span> 本地运行 · 由你掌控</footer></main></div>
}
createRoot(document.getElementById('root')!).render(<App />)
