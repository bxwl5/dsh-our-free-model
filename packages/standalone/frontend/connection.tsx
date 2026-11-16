import { useState } from 'react'
import { Cable, Check, CircleCheck, Copy, Eye, EyeOff, KeyRound, Link2, LockKeyhole, RotateCcw, ShieldAlert, Terminal } from 'lucide-react'
import { Button, Card } from './components/ui'
import type { Host, Summary } from './types'

export function Connection({ summary, host, active }: { summary: Summary; host: Host; active: boolean }) {
  const [apiKey, setApiKey] = useState('')
  const [lanKey, setLanKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')
  if (!active) return null
  const endpoint = `${summary.baseUrl}/v1`
  const model = summary.catalog.find(row => row.routable)?.id ?? 'MODEL_ID'
  const example = `curl ${summary.baseUrl}/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify({ model, messages: [{ role: 'user', content: '你好' }] })}'`
  const run = async (action: () => Promise<void>, message = '') => {
    setBusy(true); setNotice(''); setError('')
    try { await action(); if (message) setNotice(message) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败，请重试。') }
    finally { setBusy(false) }
  }
  const copy = async (id: string, text: string, message: string) => run(async () => {
    await host.copy(text)
    setCopied(id)
    window.setTimeout(() => setCopied(current => current === id ? '' : current), 1600)
  }, message)
  const toggleKey = () => void run(async () => {
    if (apiKey) { setApiKey(''); return }
    setApiKey(await host.getApiKey())
  })
  /**
   * 局域网接入口径（2026-11-17 新增）。
   *
   * 此前这里只显示 `127.0.0.1:<port>` 与本机 key —— 用户在局域网里照抄，
   * 必然 401（实测：本机 key 打到 LAN 中继回 401）。开了 `--lan` 的用户
   * 在面板里**找不到**局域网地址与 LAN Key，只能去挖 settings.json。
   */
  const lan = summary.lan
  const lanEndpoint = lan?.baseUrls?.[0] ?? (lan?.port !== null && lan?.port !== undefined
    ? `http://<本机IP>:${lan.port}/v1` : '')
  const lanExample = lanEndpoint
    ? `curl ${lanEndpoint}/chat/completions \\
  -H "Authorization: Bearer YOUR_LAN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify({ model, messages: [{ role: 'user', content: '你好' }] })}'`
    : ''
  const toggleLanKey = () => void run(async () => {
    if (lanKey) { setLanKey(''); return }
    setLanKey(await host.getLanKey())
  })
  const rotateLan = () => {
    if (!window.confirm('轮换后旧 LAN Key 会立即失效，局域网客户端需要更新。确认继续吗？')) return
    void run(async () => setLanKey(await host.rotateLanKey()), 'LAN Key 已轮换，请更新局域网客户端配置。')
  }
  const rotate = () => {
    if (!window.confirm('轮换后旧 API Key 会立即失效，确认继续吗？')) return
    void run(async () => setApiKey(await host.rotateKey()), '密钥已轮换，请更新所有客户端配置。')
  }
  return <div className="connection-browser" data-testid="connection-ready">
    <header className="dashboard-heading"><div><div className="heading-eyebrow">CONNECT YOUR TOOLS</div>
      <h1>API 接入</h1><p>使用 OpenAI 兼容接口，把本地模型接入你的工具。</p></div>
      <Cable size={22} aria-hidden="true" /></header>
    {notice && <p className="connection-feedback" role="status"><CircleCheck size={15} />{notice}</p>}
    {error && <p className="connection-error" role="alert"><ShieldAlert size={16} />{error}</p>}
    <Card className="connection-card"><div className="connection-card-heading"><span className="cx-icon"><KeyRound size={16} /></span><div><h2>连接凭据</h2><p>管理会话与推理密钥相互独立。</p></div></div>
      <label className="field-label" htmlFor="connection-endpoint">API Base URL</label>
      <div className="copy-field"><div className="cx-field"><Link2 size={14} /><input id="connection-endpoint" readOnly value={endpoint} /></div>
        <Button variant="outline" className={copied === 'endpoint' ? 'cx-copied' : undefined} disabled={busy} onClick={() => void copy('endpoint', endpoint, '地址已复制。')}>{copied === 'endpoint' ? <Check size={14} /> : <Copy size={14} />}复制地址</Button></div>
      <label className="field-label" htmlFor="connection-key">API Key</label>
      <div className="copy-field"><div className={`cx-field${apiKey ? ' cx-revealed' : ''}`}><LockKeyhole size={14} /><input id="connection-key" type={apiKey ? 'text' : 'password'} readOnly value={apiKey} placeholder="点击查看后显示" /></div>
        <Button variant="outline" disabled={busy} onClick={toggleKey}>{apiKey ? <EyeOff size={14} /> : <Eye size={14} />}{apiKey ? '隐藏密钥' : '查看密钥'}</Button>
        <Button variant="outline" className={copied === 'key' ? 'cx-copied' : undefined} disabled={!apiKey || busy} onClick={() => void copy('key', apiKey, '密钥已复制。')}>{copied === 'key' ? <Check size={14} /> : <Copy size={14} />}复制</Button></div>
      <p className="footnote">密钥用于客户端调用，请妥善保管。</p>
    </Card>
    {/**
      * 局域网接入（2026-11-17 新增）。
      *
      * 为什么单独一块：上面的「连接凭据」是**本机**口径（`127.0.0.1` + `forwardKey`），
      * 在局域网设备上照抄必然 401。实测：本机 key 打到 LAN 中继回 401，
      * 只有 `standaloneLanKey` 才认。这两套凭据刻意互不越权，所以必须在
      * 界面上分开呈现，并明确写出「用哪个 key 配哪个地址」。
      */}
    {lan?.running && lanEndpoint && <Card className="connection-card" data-testid="connection-lan">
      <div className="connection-card-heading"><span className="cx-icon"><Cable size={16} /></span><div>
        <h2>局域网接入</h2><p>同一网段的手机、平板、另一台电脑用这一组，不要用上面的本机地址。</p></div></div>
      <label className="field-label" htmlFor="connection-lan-endpoint">LAN Base URL</label>
      <div className="copy-field"><div className="cx-field"><Link2 size={14} /><input id="connection-lan-endpoint" readOnly value={lanEndpoint} /></div>
        <Button variant="outline" className={copied === 'lan-endpoint' ? 'cx-copied' : undefined} disabled={busy} onClick={() => void copy('lan-endpoint', lanEndpoint, 'LAN 地址已复制。')}>{copied === 'lan-endpoint' ? <Check size={14} /> : <Copy size={14} />}复制地址</Button></div>
      <label className="field-label" htmlFor="connection-lan-key">LAN Key</label>
      <div className="copy-field"><div className={`cx-field${lanKey ? ' cx-revealed' : ''}`}><LockKeyhole size={14} /><input id="connection-lan-key" type={lanKey ? 'text' : 'password'} readOnly value={lanKey} placeholder="点击查看后显示" /></div>
        <Button variant="outline" disabled={busy} onClick={toggleLanKey}>{lanKey ? <EyeOff size={14} /> : <Eye size={14} />}{lanKey ? '隐藏密钥' : '查看密钥'}</Button>
        <Button variant="outline" className={copied === 'lan-key' ? 'cx-copied' : undefined} disabled={!lanKey || busy} onClick={() => void copy('lan-key', lanKey, 'LAN Key 已复制。')}>{copied === 'lan-key' ? <Check size={14} /> : <Copy size={14} />}复制</Button></div>
      <p className="footnote">LAN Key 与本机 API Key 是两套独立凭据：能调模型，但进不了本机管理面。端口 {lan.port}。</p>
      {lanExample && <>
        <label className="field-label">快速开始（局域网）</label>
        <div className="copy-field" style={{ justifyContent: 'flex-end' }}>
          <Button variant="ghost" className={copied === 'lan-example' ? 'cx-copied' : undefined} disabled={busy} onClick={() => void copy('lan-example', lanExample, '示例已复制。')}>{copied === 'lan-example' ? <Check size={14} /> : <Copy size={14} />}复制示例</Button></div>
        <pre className="connection-example cx-code">{lanExample}</pre>
      </>}
      <div className="settings-footer" style={{ border: 0, marginTop: 4, paddingTop: 8 }}>
        <span>轮换后旧 LAN Key 立即失效，需要更新所有局域网客户端。</span>
        <Button variant="outline" className="cx-danger-btn" disabled={busy} onClick={rotateLan}><RotateCcw size={15} />轮换 LAN Key</Button></div>
    </Card>}
    {lan && !lan.running && <Card className="connection-card">
      <div className="connection-card-heading"><span className="cx-icon"><Cable size={16} /></span><div>
        <h2>局域网接入未开启</h2><p>{lan.error ?? '用 --lan --lan-port <端口> 启动服务后，这里会显示局域网地址与 LAN Key。'}</p></div></div>
    </Card>}
    <Card className="connection-card"><div className="connection-card-heading"><span className="cx-icon"><Terminal size={16} /></span><div><h2>快速开始</h2><p>将 YOUR_API_KEY 替换为上方密钥。</p></div>
      <Button variant="ghost" className={copied === 'example' ? 'cx-copied' : undefined} disabled={busy} onClick={() => void copy('example', example, '示例已复制。')}>{copied === 'example' ? <Check size={14} /> : <Copy size={14} />}复制示例</Button></div>
      <pre className="connection-example cx-code">{example}</pre>
    </Card>
    <Card className="connection-card connection-danger"><div className="connection-card-heading"><span className="cx-icon cx-icon-danger"><ShieldAlert size={16} /></span><div><h2>轮换 API Key</h2><p>轮换后旧密钥立即失效，需要更新所有客户端。</p></div></div>
      <Button variant="outline" className="cx-danger-btn" disabled={busy} onClick={rotate}><RotateCcw size={15} />轮换密钥</Button></Card>
  </div>
}
