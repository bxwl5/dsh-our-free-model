import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown, ArrowUp, ChevronDown, ChevronRight, CircleCheck, Plus, Route, Save, ShieldAlert, X,
} from 'lucide-react'
import { Badge, Button, Card, Input } from './components/ui'
import type { Host, RoutingCandidate, RoutingChain, RoutingUsable, Summary } from './types'
import './routing.css'

/**
 * 路由（降级链）—— 逐项对齐插件端 `RoutingPage` / `ChainEditor` /
 * `ModelPicker` / `ChainCard` / `ChainCapacity`（2026-11-17）。
 *
 * ## 一条链是什么
 * 一个**虚拟模型 ID**（`combo:<slug>`）背后是一串真实模型：调用方只看到链名，
 * 链内部按顺序尝试，前一个失败就换下一个。它解决的不是负载均衡，而是
 * 「这一路死了但别的路还活着」——额度墙、地区拒绝、凭据过期、5xx 全都表现为
 * 「本轮死了」，而机器上另外几条车道可能完全空闲。
 *
 * ## 从插件端照搬的几个关键决定
 * 1. **候选按供应商分组、默认折叠**：一屏四十多个模型全展开等于让人滚动寻找，
 *    而用户通常已经知道自己要哪一家。有搜索词时全展开（否则搜出结果却看到
 *    一排收起的标题）。
 * 2. **链路不能嵌套**：候选取 `!isComboEntry`，否则嵌套链在 `buildComboCatalog`
 *    里永远解析不到，选进去只会变成死成员。
 * 3. **缺成员不删、只标注**：车道临时关闭不代表用户写错了，替他改写配置比
 *    显示「不可用」更糟。
 * 4. **能力取交集**：链路承诺的上下文/输出/视觉不能超过最弱成员。
 * 5. **成员顺序即链**：所以是就地增删/上下移/拖拽，而不是文本框——文本框里
 *    一个拼写错误会变成一条静默解析不到的链。
 */

const LANE_LABEL: Record<string, string> = {
  free: '免费车道', kilo: 'Kilo', combo: '链路',
}
const laneOf = (row?: RoutingCandidate) => {
  const raw = row?.provider ?? row?.channel ?? 'free'
  if (LANE_LABEL[raw] !== undefined) return LANE_LABEL[raw]
  const provider = raw.startsWith('channel:') ? raw.slice('channel:'.length) : raw
  return provider
}
const kilo = (value?: number) => {
  if (typeof value !== 'number' || value <= 0) return '—'
  return value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(0)}K` : String(value)
}

/** 链路能力交集：上下文 / 最长输出 / 视觉。没有交集就不画（不编一个假数）。 */
function ChainCapacity({ capacity }: { capacity?: { contextWindow?: number; maxOutput?: number; vision?: boolean } | null }) {
  if (capacity === undefined || capacity === null) return null
  return <div className="routing-capacity" aria-label="链路能力交集">
    <span className="routing-capacity-label">链路能力交集</span>
    <Badge>上下文 {kilo(capacity.contextWindow)}</Badge>
    <Badge>输出 {kilo(capacity.maxOutput)}</Badge>
    <Badge>{capacity.vision === true ? '视觉' : '纯文本'}</Badge>
  </div>
}

export function Routing({ summary, host, active }: { summary: Summary; host: Host; active: boolean }) {
  const [chains, setChains] = useState<RoutingChain[] | undefined>(undefined)
  const [candidates, setCandidates] = useState<RoutingCandidate[]>([])
  const [usable, setUsable] = useState<RoutingUsable[]>([])
  const [draft, setDraft] = useState<RoutingChain | undefined>(undefined)
  const [confirmId, setConfirmId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const reload = async () => {
    try {
      const data = await host.getCombos()
      setChains(data.combos); setCandidates(data.models ?? []); setUsable(data.usable ?? [])
      setError('')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法读取链路设置') }
  }
  useEffect(() => { if (active) void reload() }, [active])

  const byId = useMemo(() => new Map(candidates.map(row => [row.id, row])), [candidates])
  const usableOf = (id: string) => usable.find(row => row.id === id)

  const run = async (action: () => Promise<void>, message = '') => {
    setBusy(true); setError(''); setNotice('')
    try { await action(); if (message) setNotice(message) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败') }
    finally { setBusy(false) }
  }

  const write = async (rows: RoutingChain[], message: string) => {
    const answer = await host.saveCombos(rows)
    setChains(answer.combos); setUsable(answer.usable ?? [])
    // 候选模型可能因保存而变化（例如链自身进入/离开 catalog），重拉一次最稳。
    await reload()
    setDraft(undefined); setConfirmId('')
    setNotice(message)
  }

  const blank = (): RoutingChain => ({ id: '', name: '', models: [], strategy: 'fallback', stickyLimit: 1, enabled: true })

  if (!active) return null

  return <div className="routing-browser" data-testid="routing-ready">
    <header className="dashboard-heading"><div>
      <div className="heading-eyebrow">ROUTING / FALLBACK CHAINS</div>
      <h1>路由</h1>
      <p>把多个模型串成降级链：前一个失败就换下一个，调用方只看到一个模型 ID。</p>
    </div>
    <Badge>已存链路 {chains?.length ?? 0}</Badge></header>

    {notice && <p className="connection-feedback" role="status"><CircleCheck size={15} />{notice}</p>}
    {error && <p className="connection-error" role="alert"><ShieldAlert size={16} />{error}</p>}

    {chains === undefined
      ? <Card className="routing-card"><p className="footnote">正在读取…</p></Card>
      : draft !== undefined
        /* 编辑器占满整行：成员列表与选择器都需要横向空间，挤进网格列里就无法排序。
           编辑期间**不再列卡片** —— 否则用户点开一条链，看到的却是另外两条挂在
           这个表单底下，会被读成表单的一部分。 */
        ? <ChainEditor
          key={draft.id === '' ? 'new' : draft.id}
          chain={draft} candidates={candidates} busy={busy} host={host}
          onCancel={() => { setDraft(undefined); setNotice('') }}
          onSave={row => void run(async () => {
            const known = (chains ?? []).some(chain => chain.id === row.id)
            const rows = known ? chains.map(chain => chain.id === row.id ? row : chain) : [...(chains ?? []), row]
            await write(rows, '链路已保存。')
          })}
        />
        : <Card className="routing-card">
          <div className="connection-card-heading"><span className="cx-icon"><Route size={16} /></span><div>
            <h2>已存链路</h2>
            <p>链路按输入顺序保存；引用当前不可用模型的链路会原样保留，车道恢复后自己回来。</p></div>
            <Button onClick={() => setDraft(blank())} disabled={busy}><Plus size={15} />新建链路</Button>
          </div>

          {chains.length === 0
            ? <p className="footnote">还没有降级链。一条链即一个虚拟模型：选中后按顺序尝试链上每个真实模型，用来兜住车道临时不可用。</p>
            : <ul className="routing-chain-list">{chains.map(chain => {
              const answered = usableOf(chain.id)
              const resolved = answered?.models ?? chain.models.filter(id => byId.has(id))
              const missing = chain.models.filter(id => !byId.has(id))
              const usableNow = chain.enabled !== false && resolved.length > 0
              return <li key={chain.id} className="routing-chain">
                <div className="routing-chain-head">
                  <div><strong>{chain.name}</strong><code>{chain.id}</code></div>
                  <div className="routing-chain-badges">
                    <Badge tone={usableNow ? 'success' : 'warning'}>{usableNow ? '可用' : '当前不可用'}</Badge>
                    <Badge>{chain.strategy === 'round-robin' ? '轮询' : '顺序降级'}</Badge>
                    <Badge>{chain.models.length} 个成员</Badge>
                    {chain.enabled === false && <Badge>已停用</Badge>}
                  </div>
                </div>
                <ChainCapacity capacity={answered} />
                <p className="routing-chain-flow"><span className="routing-chain-label">解析为</span>
                  {resolved.length === 0 ? '—' : resolved.map(id => {
                    const row = byId.get(id)
                    return <Badge key={id}>{row?.name ?? id} · {laneOf(row)}</Badge>
                  })}
                </p>
                {missing.length > 0 && <>
                  <p className="routing-chain-missing"><ShieldAlert size={13} />不在清单中的成员：{missing.join('、')}</p>
                  <p className="footnote">链路原样保存，不因车道关闭而改写；ID 回到清单即自动恢复。拼写错误请编辑链路。</p>
                </>}
                <div className="routing-chain-actions">
                  <Button variant="outline" disabled={busy} onClick={() => setDraft({ ...chain, models: [...chain.models] })}>编辑</Button>
                  <Button variant="outline" className="cx-danger-btn" disabled={busy}
                    onClick={() => {
                      if (confirmId !== chain.id) { setConfirmId(chain.id); return }
                      void run(async () => { await write(chains.filter(row => row.id !== chain.id), '链路已删除。') })
                    }}>{confirmId === chain.id ? '确认删除' : '删除'}</Button>
                </div>
              </li>
            })}</ul>}
          {confirmId !== '' && <p className="footnote">删除后这个模型 ID 立即从清单消失，正在引用它的客户端会拿到 404。</p>}
        </Card>}
  </div>
}

/** 链路编辑器：名称 / 策略 / 粘滞 / 启用 / 成员（可拖拽排序）/ 能力预览 / 成员选择器。 */
function ChainEditor({ chain, candidates, busy, host, onSave, onCancel }: {
  chain: RoutingChain
  candidates: RoutingCandidate[]
  busy: boolean
  host: Host
  onSave: (row: RoutingChain) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(chain.name ?? '')
  const [strategy, setStrategy] = useState<RoutingChain['strategy']>(chain.strategy === 'round-robin' ? 'round-robin' : 'fallback')
  const [stickyLimit, setStickyLimit] = useState(String(chain.stickyLimit ?? 1))
  const [enabled, setEnabled] = useState(chain.enabled !== false)
  const [members, setMembers] = useState<string[]>(Array.isArray(chain.models) ? chain.models : [])
  const [picking, setPicking] = useState(false)
  const [capacity, setCapacity] = useState<{ contextWindow?: number; maxOutput?: number; vision?: boolean } | null | undefined>(undefined)
  const dragIndex = useRef(-1)

  /**
   * 能力交集预览：算的是**还没保存**的草稿链，所以走 `preview` 而不是 GET。
   * 成员变化就重算（空链不发请求，直接清空）。
   */
  useEffect(() => {
    let alive = true
    if (members.length === 0) { setCapacity(undefined); return () => { alive = false } }
    void host.previewCombo(members)
      .then(answer => { if (alive) setCapacity(answer) })
      .catch(() => { if (alive) setCapacity(null) })
    return () => { alive = false }
  }, [members.join('\u0000')])

  const move = (index: number, delta: number) => {
    const at = index + delta
    if (at < 0 || at >= members.length) return
    const next = [...members]
    ;[next[index], next[at]] = [next[at], next[index]]
    setMembers(next)
  }
  const dropAt = (index: number) => {
    const from = dragIndex.current
    dragIndex.current = -1
    if (from < 0 || from === index) return
    const next = [...members]
    const [row] = next.splice(from, 1)
    next.splice(index, 0, row)
    setMembers(next)
  }
  const toggle = (id: string) => setMembers(current => current.includes(id)
    ? current.filter(existing => existing !== id)
    : [...current, id])

  const byId = useMemo(() => new Map(candidates.map(row => [row.id, row])), [candidates])
  const canSave = name.trim() !== '' && members.length > 0

  return <Card className="routing-card routing-editor">
    <div className="connection-card-heading"><span className="cx-icon"><Route size={16} /></span><div>
      <h2>{chain.id === '' ? '新建链路' : '编辑链路'}</h2>
      <p>成员顺序即尝试顺序；{strategy === 'round-robin' ? '轮询会按粘滞次数轮换起点。' : '顺序降级每回合都从链头开始。'}</p></div></div>

    {/**
      * 名称 / 策略 / 粘滞 / 启用 —— **排在同一行**（2026-11-17 用户：
      * 「降序和轮询两个右边空太多了，不行就放到名称右边去」）。
      *
      * 原来每个字段各占一行、标签在输入框上方，右半边大片留白，
      * 四个字段白占四行高度。现在用 `flex` 横排：名称吃掉剩余宽度，
      * 策略是分段控件、粘滞只在轮询时出现、启用是勾选。
      */}
    <div className="routing-fields">
      <div className="routing-field routing-field-grow">
        <label className="field-label" htmlFor="routing-name">名称</label>
        <Input id="routing-name" value={name} placeholder="例如：主力线路" disabled={busy}
          onChange={event => setName(event.target.value)} />
      </div>

      <div className="routing-field">
        <span className="field-label">策略</span>
        <div className="routing-seg" role="group">
          {([['fallback', '顺序降级'], ['round-robin', '轮询']] as const).map(([value, label]) =>
            <button key={value} type="button" disabled={busy} aria-pressed={strategy === value}
              className={`routing-seg-btn${strategy === value ? ' is-active' : ''}`}
              onClick={() => { if (!busy) setStrategy(value) }}>{label}</button>)}
        </div>
      </div>

      {strategy === 'round-robin' && <div className="routing-field routing-field-num">
        <label className="field-label" htmlFor="routing-sticky">粘滞次数</label>
        <Input id="routing-sticky" type="number" min={1} max={100} className="routing-num" disabled={busy}
          value={stickyLimit} onChange={event => setStickyLimit(event.target.value)} />
      </div>}

      <label className="routing-toggle">
        <input type="checkbox" checked={enabled} disabled={busy} onChange={() => setEnabled(value => !value)} />
        <span>启用</span>
      </label>
    </div>

    <div className="routing-members-head">
      <span className="field-label">成员（按顺序）</span>
      <span className="footnote">{members.length} 个成员</span>
    </div>
    {members.length === 0
      ? <p className="footnote">还没有成员——点「添加成员」从清单里挑一个。</p>
      : <ol className="routing-members">{members.map((id, index) => {
        const row = byId.get(id)
        return <li key={`${id}#${index}`} className="routing-member" draggable={!busy}
          onDragStart={() => { dragIndex.current = index }}
          onDragOver={event => { if (dragIndex.current < 0) return; event.preventDefault() }}
          onDrop={event => { event.preventDefault(); dropAt(index) }}
          onDragEnd={() => { dragIndex.current = -1 }}>
          <span className="routing-order">{index + 1}</span>
          <span className={`routing-member-name${row === undefined ? ' is-missing' : ''}`}>
            {row?.name ?? id}<code>{id}</code>
            <Badge>{laneOf(row)}</Badge>
            {row?.contextWindow !== undefined && <Badge>上下文 {kilo(row.contextWindow)}</Badge>}
          </span>
          <span className="routing-member-actions">
            <Button variant="ghost" aria-label="上移" title="上移" disabled={busy || index === 0}
              onClick={() => move(index, -1)}><ArrowUp size={14} /></Button>
            <Button variant="ghost" aria-label="下移" title="下移" disabled={busy || index === members.length - 1}
              onClick={() => move(index, 1)}><ArrowDown size={14} /></Button>
            <Button variant="ghost" aria-label="移除" title="移除" disabled={busy}
              onClick={() => toggle(id)}><X size={14} /></Button>
          </span>
        </li>
      })}</ol>}

    <ChainCapacity capacity={capacity} />

    {/* 选择器打开时这行整行消失：插件端的经验是「上下各一个取消」会让用户
        不知道该点哪个，而它们做的事其实不同。 */}
    {picking
      ? <ModelPicker candidates={candidates} chosen={members} busy={busy}
        onPick={toggle} onClose={() => setPicking(false)} />
      : <div className="routing-actions">
        <Button variant="outline" disabled={busy} onClick={() => setPicking(true)}><Plus size={15} />添加成员</Button>
      </div>}

    <div className="routing-foot">
      <Button disabled={busy || !canSave} onClick={() => onSave({
        ...chain, name: name.trim(), strategy, stickyLimit: Math.max(1, Math.min(100, Number(stickyLimit) || 1)),
        enabled, models: members,
      })}><Save size={15} />保存链路</Button>
      <button type="button" className="text-button" disabled={busy} onClick={onCancel}>取消</button>
    </div>
  </Card>
}

/** 成员选择器：搜索 + 供应商筛选 + 按供应商分组（默认折叠，搜索时全展开）。 */
function ModelPicker({ candidates, chosen, busy, onPick, onClose }: {
  candidates: RoutingCandidate[]
  chosen: string[]
  busy: boolean
  onPick: (id: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [only, setOnly] = useState('')
  const [openGroups, setOpenGroups] = useState<string[]>([])
  const needle = query.trim().toLowerCase()

  const providerOf = (row: RoutingCandidate) => row.provider ?? row.channel ?? 'free'
  const matched = candidates.filter(row => {
    if (only !== '' && providerOf(row) !== only) return false
    if (needle === '') return true
    return `${row.id} ${row.name ?? ''} ${providerOf(row)}`.toLowerCase().includes(needle)
  })
  const groups = useMemo(() => {
    const map = new Map<string, RoutingCandidate[]>()
    for (const row of matched) {
      const key = providerOf(row)
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(row)
    }
    return [...map.entries()]
  }, [matched])
  const providerIds = useMemo(() => [...new Set(candidates.map(providerOf))].sort(), [candidates])
  /** 有查询词就全展开：否则用户搜出结果却看到一排收起的标题，会以为没搜到。 */
  const isOpen = (provider: string) => needle !== '' || openGroups.includes(provider)
  const toggleGroup = (provider: string) => setOpenGroups(current => current.includes(provider)
    ? current.filter(name => name !== provider) : [...current, provider])

  return <div className="routing-picker">
    <div className="routing-picker-head">
      <span className="field-label">选择模型</span>
      <button type="button" className="text-button" onClick={onClose}>✕ 收起</button>
    </div>
    <div className="routing-picker-filters">
      <Input aria-label="搜索模型" placeholder="搜索模型 ID 或名称" value={query}
        onChange={event => setQuery(event.target.value)} />
      {providerIds.length > 1 && <select className="ui-input routing-provider" aria-label="按供应商筛选"
        value={only} onChange={event => setOnly(event.target.value)}>
        <option value="">全部</option>
        {providerIds.map(id => <option key={id} value={id}>{id}</option>)}
      </select>}
    </div>

    {candidates.length === 0
      ? <p className="footnote">还没有可路由的渠道模型：请先在渠道页登录账号并启用模型。</p>
      : matched.length === 0
        ? <p className="footnote">没有匹配的模型。</p>
        : <div className="routing-pick-list">{groups.map(([provider, rows]) => {
          const expanded = isOpen(provider)
          const picked = rows.filter(row => chosen.includes(row.id)).length
          return <div key={provider} className="routing-pickgroup">
            <button type="button" className="routing-pickgrouphead" aria-expanded={expanded}
              onClick={() => toggleGroup(provider)}>
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span className="routing-pickgrouptitle">{laneOf(rows[0])}（{rows.length}）</span>
              {picked > 0 && <Badge tone="blue">{picked} 已加入</Badge>}
            </button>
            {expanded && <div className="routing-pickgroupbody">{rows.map(row => {
              const isPicked = chosen.includes(row.id)
              return <button key={row.id} type="button" disabled={busy}
                className={`routing-pick${isPicked ? ' is-picked' : ''}`}
                title={isPicked ? '再点一次移出链路' : '点击加入链路'} onClick={() => onPick(row.id)}>
                <b title={row.name}>{row.name ?? row.id}</b>
                {isPicked && <span className="routing-pickcheck">✓</span>}
              </button>
            })}</div>}
          </div>
        })}</div>}
  </div>
}
