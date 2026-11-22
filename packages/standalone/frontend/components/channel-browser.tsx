import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleAlert, Network, Search, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import { providers } from 'ofm-provider-list'
import { shared } from 'ofm-shared-client'
import { Button, Card, Input } from './ui'
import type { Summary } from '../types'

interface Status { closed?: boolean; accounts?: { total: number; enabled: number }; models?: { total: number; disabled: number } }
type Rpc = (method: string, payload?: object) => Promise<any>
const t = Object.assign((key: string) => shared.DICT.zh[key] ?? key, { locale: 'zh' })

export function ChannelBrowser({ rpc, summary }: { rpc: Rpc; summary: Summary & { reload?(): void } }) {
  const [statuses, setStatuses] = useState<Record<string, Status>>()
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [auto, setAuto] = useState<{ enabled: boolean; running?: boolean; ranToday?: boolean; results?: Array<{ provider: string; accountId: string; accountName: string; outcome: string; amount?: number; unit?: string; message?: string }> }>()
  const [busy, setBusy] = useState(false)
  /**
   * 异常汇总（2026-11-22 从插件版移植）：限流/风控/验证受阻的账号清单。
   * 数据源与插件版同一 RPC（`account.anomalies`）；没有条目时面板自己返回 null。
   */
  const [anomalies, setAnomalies] = useState<Array<{ provider?: string; accountId?: string; nickname?: string; reason?: string; until?: number }>>([])
  /**
   * 账号轮询（**同一渠道内**多个账号之间怎么轮）—— 全局一项，对全部渠道生效。
   *
   * ⚠️ 与**路由轮询**（combo 成员之间、通常就是不同渠道）是两套独立机制，
   * 文案里必须点明，否则用户会混淆（用户 2026-11-04 明确区分过）。
   */
  const [strategy, setStrategy] = useState<{ strategy: string; stickyLimit: number; usableProviders: number }>()
  const mounted = useRef(false)
  const sequence = useRef(0)
  const reload = useCallback(async () => {
    const started = ++sequence.current
    try {
      const value = await rpc('provider.status', { providers: providers.map(row => row.id) })
      if (!mounted.current || started !== sequence.current) return
      setStatuses(value.statuses ?? {})
      setError('')
    } catch (failure) {
      if (mounted.current && started === sequence.current) setError((failure as Error).message)
    }
  }, [rpc])
  useEffect(() => {
    mounted.current = true
    void reload()
    void rpc('usage.autoCheckin', {}).then(value => {
      if (mounted.current) setAuto(value.autoCheckin)
    }).catch(() => {})
    void rpc('account.anomalies', {}).then(value => {
      if (mounted.current) setAnomalies(Array.isArray(value.anomalies) ? value.anomalies : [])
    }).catch(() => {})
    void rpc('account.getStrategy', {}).then(value => {
      if (mounted.current) setStrategy(value)
    }).catch(() => {})
    const timer = setInterval(() => { void reload() }, 45000)
    return () => { mounted.current = false; sequence.current++; clearInterval(timer) }
  }, [rpc, reload])
  const onChanged = useCallback(() => {
    void reload()
    window.dispatchEvent(new CustomEvent('ofm:channels'))
    summary.reload?.()
  }, [reload, summary.reload])
  const onError = useCallback((_provider: unknown, failure: Error) => { if (mounted.current) setError(failure.message) }, [])
  const connected = providers.filter(provider => statuses?.[provider.id]?.accounts?.enabled && !statuses[provider.id].closed).length
  const accounts = Object.values(statuses ?? {}).reduce((sum, row) => sum + (row.accounts?.total ?? 0), 0)
  const rows = providers.filter(provider => {
    const status = statuses?.[provider.id]
    const isConnected = (status?.accounts?.enabled ?? 0) > 0 && !status?.closed
    return `${provider.name} ${provider.org}`.toLowerCase().includes(search.toLowerCase().trim())
      && (filter === 'all' || (status !== undefined && (filter === 'connected' ? isConnected : !isConnected)))
  })
  // 分类标签展示全量数量；搜索后的匹配数量由结果栏单独展示。
  const counts: Record<string, number> = {
    all: providers.length,
    connected,
    pending: providers.filter(provider => {
      const status = statuses?.[provider.id]
      return status !== undefined && (status.closed || (status.accounts?.enabled ?? 0) <= 0)
    }).length,
  }
  return <>
    <div className="channel-summary-strip">
      <div className="ch-metric"><span className="ch-metric-icon"><Network size={16} /></span>
        <div className="ch-metric-body"><span className="ch-metric-label">已接入渠道</span>
          <strong className="ch-metric-value">{statuses ? connected : <span className="ch-skeleton" />}<small> / {providers.length}</small></strong></div></div>
      <div className="ch-metric"><span className="ch-metric-icon"><ShieldCheck size={16} /></span>
        <div className="ch-metric-body"><span className="ch-metric-label">本机账号</span>
          <strong className="ch-metric-value">{statuses ? accounts : <span className="ch-skeleton" />}</strong></div></div>
      <div className="checkin-control"><span className="status-dot" /><span>{auto?.running ? '签到进行中' : auto?.ranToday ? '今日签到已执行' : '每日自动签到'}</span>
        <button type="button" role="switch" aria-label="每日自动签到" aria-checked={auto?.enabled === true}
          className={`ui-switch ${auto?.enabled ? 'on' : ''}`} disabled={!auto || busy} onClick={() => {
            setBusy(true)
            void rpc('usage.autoCheckin', { enabled: !auto?.enabled }).then(value => { if (mounted.current) setAuto(value.autoCheckin) })
              .catch(failure => { if (mounted.current) setError(failure.message) }).finally(() => { if (mounted.current) setBusy(false) })
          }}><span /></button>
      </div>
      {/**
        * 账号轮询开关（2026-11-17 重构）。
        *
        * 用户要求：「把右边直接改为和左边样式一样的」「不需要多余的文字」。
        *
        * 之前这里是一个**未加样式**的裸 flex 块，塞了四样东西：
        * 「账号轮询」+ 小字「渠道内多账号，全局生效」+ 可编辑的次数输入框 + 一段 hint。
        * 视觉上和左边的签到药丸完全不同，还允许改「每个账号连续 N 次」。
        *
        * 现在：与 `.checkin-control` 同款药丸 —— 状态点 + 单行文字 + 开关，
        * **没有**小字、没有输入框、没有 hint。次数由 `DEFAULT_ACCOUNT_STICKY_LIMIT`
        * 固定（用户此前已说过「轮询次数固定 10 不再支持修改」），拨开关时原样回传。
        */}
      {strategy && (strategy.usableProviders ?? 0) > 0 ? <div className="account-strategy-control">
        <span className="status-dot" />
        <span>账号轮询</span>
        <button type="button" role="switch" aria-label="账号轮询" aria-checked={strategy.strategy === 'round-robin'}
          className={`ui-switch ${strategy.strategy === 'round-robin' ? 'on' : ''}`} disabled={busy} onClick={() => {
            const next = strategy.strategy === 'round-robin' ? 'sequential' : 'round-robin'
            setBusy(true)
            void rpc('account.setStrategy', { strategy: next, stickyLimit: strategy.stickyLimit })
              .then(() => rpc('account.getStrategy', {})).then(value => { if (mounted.current) setStrategy(value) })
              .catch(failure => { if (mounted.current) setError(failure.message) }).finally(() => { if (mounted.current) setBusy(false) })
          }}><span /></button>
      </div> : null}
    </div>
    {error && <div className="channel-error" role="alert"><CircleAlert size={16} /><span>{error}</span><Button variant="ghost" onClick={() => { void reload() }}>重试</Button></div>}
    {/**
      * 渠道卡片**平铺**（2026-11-17，对齐插件端 `ChannelsPage`）。
      *
      * 原来是两级：一级卡片只显示「名称 + 账号数 + 管理渠道按钮」，
      * 点进去才在二级详情里看到真正的 `ChannelCard`。管理一个渠道要点两次，
      * 15 个渠道就要 15 次进出；而且一级卡片上那点信息（账号/模型数）
      * 二级详情里本来就有，纯属重复。
      *
      * 插件端的做法是 `CHANNEL_PROVIDERS.map(... h(ChannelCard ...))` ——
      * 全部渠道的完整卡片直接铺在一级列表里。这里改成同一形态：
      * 二级详情、侧栏切换、「管理渠道」按钮全部删除，
      * 搜索/筛选结果直接渲染 `shared.ChannelCard`。
      */}
    <>
      <div className="channel-toolbar"><div className="channel-search"><Search size={17} /><Input aria-label="搜索渠道" placeholder="搜索渠道或供应商…" value={search} onChange={event => setSearch(event.target.value)} /></div>
        <div className="channel-filters" aria-label="渠道状态筛选">{[['all', '全部渠道'], ['connected', '已接入'], ['pending', '待接入']].map(([id, label]) =>
          <button key={id} aria-pressed={filter === id} disabled={id !== 'all' && !statuses} onClick={() => setFilter(id)}>{label}<span>{id === 'all' || statuses ? counts[id] : '—'}</span></button>)}</div>
      </div>
      <div className="channel-results-meta"><span>{rows.length} 个渠道</span><span><SlidersHorizontal size={13} />登录、账号与模型都在各自卡片内直接管理</span></div>
      <div className="provider-grid">{rows.map(provider =>
        <shared.ChannelCard key={provider.id} channel={provider} status={statuses?.[provider.id]} rpc={rpc} t={t} onChanged={onChanged} onError={onError} />
      )}</div>
      {/**
        * 2026-11-22 从插件版移植的两块汇总板块（对齐 `ChannelsPage` 的卡片下方
        * 布局）：异常汇总（限流/风控/验证受阻，有条目才出现）+ 签到结果表格
        *（逐账号台账，无行时组件内部返回 null）。数据源与插件版同一 RPC，
        * 面板组件直接复用 client.js 的实现 —— 不复制代码，避免两份漂移。
        */}
      {anomalies.length > 0 && <shared.AnomalyPanel anomalies={anomalies} channelName={(id: string) => providers.find(row => row.id === id)?.name ?? id} t={t} />}
      <shared.CheckinPanel results={Array.isArray(auto?.results) ? auto.results : []} channelName={(id: string) => providers.find(row => row.id === id)?.name ?? id} t={t} />
      {rows.length === 0 && <Card className="channel-empty"><Search size={24} /><h2>没有匹配的渠道</h2><p>试试其他名称，或切换筛选条件。</p><Button variant="outline" onClick={() => { setSearch(''); setFilter('all') }}>重置筛选</Button></Card>}
    </>
  </>
}
