import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, CircleCheck, Layers3, Plus, Route, Save, ShieldAlert, Trash2, X } from 'lucide-react'
import { Badge, Button, Card, Input } from './components/ui'
import type { Host, RoutingChain, Summary } from './types'
import './routing.css'

/**
 * 路由（降级链）—— 功能对齐插件版 `routing.*` 那一组界面。
 *
 * ## 一条链是什么
 * 一个**虚拟模型 ID**（`combo:<slug>`）背后是一串真实模型：调用方只看到
 * 链名，链内部按顺序尝试，前一个失败就换下一个。它解决的不是「负载均衡」，
 * 而是「这一路死了但别的路还活着」——额度墙、地区拒绝、凭据过期、5xx
 * 全都表现为「本轮死了」，而机器上另外三条车道可能完全空闲。
 *
 * ## 两种策略
 * - **顺序降级**（`fallback`）：永远从链头开始，可预测，适合「质量阶梯」。
 * - **轮询**（`round-robin`）：从游标位置开始，按 `stickyLimit` 连任若干回合，
 *   适合「等价模型之间分摊额度」。
 *
 * ## 为什么「成员」要分 available / missing
 * 存储里的链是用户输入，可能指向已经下线的模型。插件版的规则是**原样保留**
 * 缺成员（车道恢复后自己回来），而不是静默删掉。界面必须把这两种状态分开
 * 显示，否则用户会以为链还是三路冗余。
 */
export function Routing({ summary, host, active }: { summary: Summary; host: Host; active: boolean }) {
  const [chains, setChains] = useState<RoutingChain[] | undefined>(undefined)
  const [draft, setDraft] = useState<RoutingChain | undefined>(undefined)
  const [picking, setPicking] = useState(false)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = async () => {
    try { setChains(await host.getCombos()); setError('') }
    catch (reason) { setError(reason instanceof Error ? reason.message : '无法读取链路设置') }
  }
  useEffect(() => { if (active) void load() }, [active])

  /** 可选成员：目录里所有**非 combo** 的真实模型（链不能嵌套链）。 */
  const candidates = useMemo(
    () => summary.catalog.filter(row => !row.id.startsWith('combo:')),
    [summary.catalog],
  )
  const nameOf = (id: string) => candidates.find(row => row.id === id)?.name ?? id
  const available = useMemo(() => new Set(candidates.map(row => row.id)), [candidates])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return candidates.filter(row => q === '' || row.id.toLowerCase().includes(q) || String(row.name ?? '').toLowerCase().includes(q))
  }, [candidates, search])

  const run = async (action: () => Promise<void>, message = '') => {
    setBusy(true); setError(''); setNotice('')
    try { await action(); if (message) setNotice(message) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败') }
    finally { setBusy(false) }
  }

  const blank = (): RoutingChain => ({ id: '', name: '', models: [], strategy: 'fallback', stickyLimit: 1, enabled: true })
  const startNew = () => { setDraft(blank()); setPicking(false); setSearch(''); setNotice('') }
  const edit = (chain: RoutingChain) => { setDraft({ ...chain, models: [...chain.models] }); setPicking(false); setSearch(''); setNotice('') }

  const move = (index: number, delta: number) => {
    if (!draft) return
    const next = [...draft.models]
    const at = index + delta
    if (at < 0 || at >= next.length) return
    ;[next[index], next[at]] = [next[at], next[index]]
    setDraft({ ...draft, models: next })
  }
  const toggleMember = (id: string) => {
    if (!draft) return
    const has = draft.models.includes(id)
    setDraft({ ...draft, models: has ? draft.models.filter(row => row !== id) : [...draft.models, id] })
  }

  const save = () => {
    if (!draft) return
    if (draft.name.trim() === '') { setError('请填写链路名称'); return }
    if (draft.models.length === 0) { setError('至少添加一个成员，否则这条链无法作答'); return }
    void run(async () => {
      // 整表替换：把当前 draft 并入列表（按 id 匹配则替换，否则追加）。
      const base = [...(chains ?? [])]
      const index = draft.id === '' ? -1 : base.findIndex(row => row.id === draft.id)
      const row: RoutingChain = { ...draft, name: draft.name.trim() }
      if (index >= 0) base[index] = row
      else base.push(row)
      await host.saveCombos(base)
      /**
       * ⚠️ 保存后必须**重新读取**，不能直接用 `saveCombos` 的返回值当列表。
       *
       * `POST /combos` 返回的是归一后的**配置**（`models`），而界面上的
       * 「N 个成员 / 链路走向」用的是**按当前目录解析出来的** `members`。
       * 直接拿返回值渲染，`members` 是 undefined ⇒ 每条链都显示
       * 「当前没有任何成员可解析」（实测就是这样）。
       */
      await load()
      setDraft(undefined); setPicking(false)
    }, '链路已保存。')
  }

  const remove = (chain: RoutingChain) => {
    if (!window.confirm(`删除后 ${chain.id} 立即从清单消失，正在引用它的客户端会拿到 404。确认删除？`)) return
    void run(async () => {
      await host.saveCombos((chains ?? []).filter(row => row.id !== chain.id))
      await load()
      if (draft?.id === chain.id) setDraft(undefined)
    }, '链路已删除。')
  }

  if (!active) return null

  return <div className="routing-browser" data-testid="routing-ready">
    <header className="dashboard-heading"><div>
      <div className="heading-eyebrow">ROUTING / FALLBACK CHAINS</div>
      <h1>路由</h1>
      <p>把多个模型串成降级链：前一个失败就换下一个，调用方只看到一个模型 ID。</p>
    </div><Route size={22} aria-hidden="true" /></header>

    {notice && <p className="connection-feedback" role="status"><CircleCheck size={15} />{notice}</p>}
    {error && <p className="connection-error" role="alert"><ShieldAlert size={16} />{error}</p>}

    {/* ── 编辑器 ── */}
    {draft && <Card className="routing-card routing-editor">
      <div className="connection-card-heading"><span className="cx-icon"><Layers3 size={16} /></span><div>
        <h2>{draft.id === '' ? '新建链路' : '编辑链路'}</h2>
        <p>成员按顺序保存；引用当前不可用模型的链路会原样保留，车道恢复后自己回来。</p></div></div>

      <label className="field-label" htmlFor="routing-name">名称</label>
      <Input id="routing-name" placeholder="例如：主力线路" value={draft.name}
        onChange={event => setDraft({ ...draft, name: event.target.value })} />

      <div className="routing-row">
        <div>
          <label className="field-label" htmlFor="routing-strategy">策略</label>
          <select id="routing-strategy" className="ui-input" value={draft.strategy}
            onChange={event => setDraft({ ...draft, strategy: event.target.value as RoutingChain['strategy'] })}>
            <option value="fallback">顺序降级</option>
            <option value="round-robin">轮询</option>
          </select>
        </div>
        <div>
          <label className="field-label" htmlFor="routing-sticky">轮询粘滞次数</label>
          <Input id="routing-sticky" type="number" min={1} max={1000} value={String(draft.stickyLimit)}
            disabled={draft.strategy !== 'round-robin'}
            onChange={event => setDraft({ ...draft, stickyLimit: Math.max(1, Number(event.target.value) || 1) })} />
          <p className="footnote">轮询时同一个模型连续用多少次再换下一个。</p>
        </div>
      </div>

      <label className="field-label">成员（按顺序）</label>
      {draft.models.length === 0
        ? <p className="footnote">还没有成员——点「添加成员」从清单里挑一个。</p>
        : <ol className="routing-members">{draft.models.map((id, index) => <li key={id} className="routing-member">
          <span className="routing-order">{index + 1}</span>
          <span className={`routing-member-name${available.has(id) ? '' : ' is-missing'}`}>
            {nameOf(id)}<code>{id}</code>
            {!available.has(id) && <Badge tone="danger">当前不可用</Badge>}
          </span>
          <span className="routing-member-actions">
            <Button variant="ghost" aria-label="上移" title="上移" disabled={index === 0 || busy}
              onClick={() => move(index, -1)}><ArrowUp size={14} /></Button>
            <Button variant="ghost" aria-label="下移" title="下移" disabled={index === draft.models.length - 1 || busy}
              onClick={() => move(index, 1)}><ArrowDown size={14} /></Button>
            <Button variant="ghost" aria-label="移除" title="移除" disabled={busy}
              onClick={() => toggleMember(id)}><X size={14} /></Button>
          </span>
        </li>)}</ol>}

      <div className="routing-actions">
        <Button variant="outline" disabled={busy} onClick={() => { setPicking(!picking); setSearch('') }}>
          <Plus size={15} />{picking ? '✕ 收起' : '添加成员'}</Button>
        <Button variant="outline" disabled={busy} onClick={() => { setDraft(undefined); setPicking(false); setNotice('') }}>取消</Button>
        <Button disabled={busy} onClick={save}><Save size={15} />保存链路</Button>
      </div>

      {/* ── 成员选择器 ── */}
      {picking && <div className="routing-picker">
        <Input aria-label="搜索模型" placeholder="搜索模型 ID 或名称" value={search}
          onChange={event => setSearch(event.target.value)} />
        {filtered.length === 0
          ? <p className="footnote">没有匹配的模型。</p>
          : <ul className="routing-pick-list">{filtered.map(row => {
            const picked = draft.models.includes(row.id)
            return <li key={row.id}>
              <button type="button" className={`routing-pick${picked ? ' is-picked' : ''}`} disabled={busy}
                title={picked ? '再点一次移出链路' : '点击加入链路'} onClick={() => toggleMember(row.id)}>
                <span className="routing-pick-name">{row.name ?? row.id}<code>{row.id}</code></span>
                <span className="routing-pick-side">
                  {row.routable === false && <Badge>当前不可用</Badge>}
                  {picked && <Badge tone="blue">已加入</Badge>}
                </span>
              </button>
            </li>
          })}</ul>}
      </div>}
    </Card>}

    {/* ── 已存链路 ── */}
    <Card className="routing-card">
      <div className="connection-card-heading"><span className="cx-icon"><Route size={16} /></span><div>
        <h2>已存链路</h2>
        <p>一条链即一个虚拟模型：选中后按顺序尝试链上每个真实模型，用来兜住车道临时不可用。</p></div>
        {!draft && <Button onClick={startNew} disabled={busy}><Plus size={15} />新建链路</Button>}
      </div>

      {chains === undefined
        ? <p className="footnote">正在读取…</p>
        : chains.length === 0
          ? <p className="footnote">还没有降级链。</p>
          : <ul className="routing-chain-list">{chains.map(chain => <li key={chain.id} className="routing-chain">
            <div className="routing-chain-head">
              <div>
                <strong>{chain.name}</strong>
                <code>{chain.id}</code>
              </div>
              <div className="routing-chain-badges">
                <Badge>{chain.strategy === 'fallback' ? '顺序降级' : `轮询 · 粘滞 ${chain.stickyLimit}`}</Badge>
                <Badge tone={(chain.members?.length ?? 0) === 0 ? 'danger' : 'success'}>
                  {chain.members?.length ?? 0} 个成员
                </Badge>
                {!chain.enabled && <Badge>已停用</Badge>}
              </div>
            </div>
            <p className="routing-chain-flow">
              {(chain.members ?? []).length === 0
                ? '当前没有任何成员可解析 —— 这条链不会出现在模型清单里。'
                : (chain.members ?? []).join('  →  ')}
            </p>
            {chain.missing !== undefined && chain.missing.length > 0 && <p className="routing-chain-missing">
              <ShieldAlert size={13} />不在清单中的成员：{chain.missing.join('、')}
            </p>}
            <div className="routing-chain-actions">
              <Button variant="outline" disabled={busy} onClick={() => edit(chain)}>编辑</Button>
              <Button variant="outline" className="cx-danger-btn" disabled={busy} onClick={() => remove(chain)}>
                <Trash2 size={14} />删除</Button>
            </div>
          </li>)}</ul>}
    </Card>
  </div>
}
