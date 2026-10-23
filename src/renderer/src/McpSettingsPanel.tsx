import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { DependencyCheck, McpPreset, McpConnectionStatus, McpServiceConfig, ModelTool, SaveMcpServiceInput } from '../../shared/types'

import { Icon } from './Visuals'
import DependencyChecks from './DependencyChecks'

const connectionLabels = { disconnected: '未连接', connecting: '连接中', ready: '已连接', error: '连接失败' }

const messageOf = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。'

export default function McpSettingsPanel() {
  const [services, setServices] = useState<McpServiceConfig[]>([])
  const [selected, setSelected] = useState<string>()
  const [presets, setPresets] = useState<McpPreset[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    void window.her.listMcpServices().then(items => { if (live) { setServices(items); setSelected(items[0]?.id) } }).catch(cause => { if (live) setError(messageOf(cause)) })
    void window.her.listMcpPresets().then(items => { if (live) setPresets(items) }).catch(cause => { if (live) setError(messageOf(cause)) })
    return () => { live = false }
  }, [])
  const config = services.find(item => item.id === selected)
  return <div className="mcp-settings">
    <aside className="service-list mcp-service-list" aria-label="MCP 服务列表">
      <div className="service-list-title"><span>工具服务</span><span>{services.length}</span></div>
      {services.length === 0 && <p className="service-empty">添加工具，让 Samantha<br />多一双帮忙的手。</p>}
      {services.map(item => <button className={`service-item mcp-service-item ${item.id === selected ? 'selected' : ''}`} key={item.id} aria-label={`${item.name} · ${item.enabled ? '已启用' : '已停用'}`} aria-current={item.id === selected ? 'true' : undefined} onClick={() => setSelected(item.id)}><span className={`status-dot ${item.enabled ? '' : 'offline'}`} /><span className="mcp-service-copy"><strong title={item.name}>{item.name}</strong><small>{item.enabled ? '已启用' : '已停用'} · {item.transport === 'stdio' ? '本地' : 'HTTP'}</small></span></button>)}
      <button className="text-button add-service" onClick={() => setSelected(undefined)}><Icon name="plus" />添加 MCP 服务</button>
    </aside>
    <div className="mcp-editor">{error && <p className="error-banner" role="alert">{error}</p>}
      <McpEditor key={`${config?.id ?? 'new'}:${config?.revision ?? 0}`} config={config} preset={presets.find(item => item.id === config?.presetId)} onSaved={saved => {
        setServices(items => [...items.filter(item => item.id !== saved.id), saved]); setSelected(saved.id)
      }} onDeleted={id => { setServices(items => items.filter(item => item.id !== id)); setSelected(undefined) }}>
        <PresetPicker presets={presets} expanded={!config} onSaved={saved => { setServices(items => [...items, saved]); setSelected(saved.id) }} />
      </McpEditor>
    </div>
  </div>
}

function McpEditor({ config, preset, onSaved, onDeleted, children }: { config?: McpServiceConfig; preset?: McpPreset; onSaved(config: McpServiceConfig): void; onDeleted(id: string): void; children: ReactNode }) {
  const [name, setName] = useState(config?.name ?? '')
  const [transport, setTransport] = useState(config?.transport ?? 'stdio')
  const [command, setCommand] = useState(config?.command ?? '')
  const [args, setArgs] = useState(JSON.stringify(config?.args ?? []))
  const [cwd, setCwd] = useState(config?.cwd ?? '')
  const [url, setUrl] = useState(config?.url ?? '')
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [environment, setEnvironment] = useState<Record<string, string>>({})
  const [loadingEnvironment, setLoadingEnvironment] = useState(config?.transport === 'stdio' && config.secretKeys.length > 0)
  const [newKey, setNewKey] = useState('')
  const [clear, setClear] = useState<string[]>([])
  const [enabled, setEnabled] = useState(config?.enabled ?? false)
  const [status, setStatus] = useState<McpConnectionStatus>()
  const [tools, setTools] = useState<ModelTool[]>([])
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [checks, setChecks] = useState<DependencyCheck[]>([])
  const [checking, setChecking] = useState(false)
  const [dependencyError, setDependencyError] = useState('')
  const diagnosticVersion = useRef(0)
  const mounted = useRef(true)
  const refreshVersion = useRef(0)
  async function refresh() {
    if (!config) return
    const version = ++refreshVersion.current
    const current = await window.her.getMcpStatus(config.id)
    if (!mounted.current || version !== refreshVersion.current || current.revision !== config.revision) return
    setStatus(current)
    if (current.state === 'ready') {
      const definitions = await window.her.listMcpTools(config.id)
      const latest = await window.her.getMcpStatus(config.id)
      if (mounted.current && version === refreshVersion.current && latest.revision === config.revision) { setTools(definitions); setStatus(latest) }
    } else setTools([])
  }
  useEffect(() => {
    mounted.current = true
    void refresh().catch(cause => { if (mounted.current) setError(messageOf(cause)) })
    if (config?.transport === 'stdio' && config.secretKeys.length > 0) {
      void window.her.getMcpEnvironment(config.id, config.revision)
        .then(values => { if (mounted.current) setEnvironment(values) })
        .catch(cause => { if (mounted.current) setError(messageOf(cause)) })
        .finally(() => { if (mounted.current) setLoadingEnvironment(false) })
    }
    return () => { mounted.current = false; refreshVersion.current++; diagnosticVersion.current++ }
  }, [])
  async function diagnose() {
    if (!config?.presetId) return
    const version = ++diagnosticVersion.current
    setChecking(true); setChecks([]); setDependencyError('')
    try {
      const result = await window.her.checkPresetDependencies(config.presetId, config.id)
      if (mounted.current && version === diagnosticVersion.current) setChecks(result)
    } catch (cause) { if (mounted.current && version === diagnosticVersion.current) setDependencyError(messageOf(cause)) }
    finally { if (mounted.current && version === diagnosticVersion.current) setChecking(false) }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError('')
    try {
      const input: SaveMcpServiceInput = { name, enabled, transport,
        ...(config ? { id: config.id, expectedRevision: config.revision, ...(config.presetId ? { presetId: config.presetId } : {}) } : {}),
        ...(transport === 'stdio' ? { command, args: JSON.parse(args), ...(cwd ? { cwd } : {}) } : { url }), secretValues: secrets, clearSecretKeys: clear }
      const saved = await window.her.saveMcpService(input)
      if (mounted.current) onSaved(saved)
    } catch (cause) { if (mounted.current) setError(messageOf(cause)) }
    finally { if (mounted.current) setSaving(false) }
  }
  async function test() {
    if (!config) return
    setTesting(true); setError(''); setNotice('')
    try {
      const result = await window.her.testMcpService(config.id)
      const latest = await window.her.getMcpStatus(config.id)
      if (mounted.current && latest.revision === config.revision) {
        setNotice(result.message)
        if (result.status === 'failed') await diagnose()
      }
      if (mounted.current) await refresh()
    } catch (cause) { if (mounted.current) { setError(messageOf(cause)); await diagnose(); await refresh().catch(() => {}) } }
    finally { if (mounted.current) setTesting(false) }
  }
  async function toggle() {
    if (!config) return
    setSaving(true); setError('')
    try { const saved = await window.her.setMcpServiceEnabled(config.id, !config.enabled, config.revision); if (mounted.current) onSaved(saved) }
    catch (cause) { if (mounted.current) setError(messageOf(cause)) }
    finally { if (mounted.current) setSaving(false) }
  }
  async function remove() {
    if (!config) return
    setSaving(true); setError('')
    try { await window.her.deleteMcpService(config.id); if (mounted.current) onDeleted(config.id) }
    catch (cause) { if (mounted.current) setError(messageOf(cause)) }
    finally { if (mounted.current) setSaving(false) }
  }
  const keys = [...new Set([...(config?.secretKeys ?? []), ...Object.keys(secrets)])]
  return <section className="mcp-config" aria-label="MCP 配置">
    <div className="mcp-editor-scroll">
      <header className="mcp-heading"><h3>{config ? 'MCP 服务配置' : '添加 MCP 服务'}</h3><p>配置保存在本机。连接测试只发现工具，实际操作由任务执行和确认。</p></header>
      {config && <div className="mcp-connection-state" aria-label="连接状态"><span className="mcp-state" data-state={status?.state}><span className="status-dot" />{status ? connectionLabels[status.state] : '读取中'}</span><span>{status?.state === 'ready' ? `${status.toolCount} 个工具 · ` : ''}配置版本 {config.revision}</span><button className="icon-button" aria-label="刷新连接状态" title="刷新连接状态" onClick={() => void refresh().catch(cause => setError(messageOf(cause)))}><Icon name="retry" /></button></div>}
      {status?.message && <p className="mcp-status-message mcp-note">{status.message}</p>}
      {config?.presetId && config.presetId !== 'playwright' && <section className="mcp-saved-dependencies" aria-label="服务依赖">
        <button type="button" className="secondary-button" disabled={checking || testing || saving} onClick={() => void diagnose()}>{checking ? '正在检查…' : checks.length ? '重新检查服务依赖' : '检查服务依赖'}</button>
        {dependencyError && <p className="error-banner" role="alert">{dependencyError}</p>}
        {checks.some(check => check.status !== 'ready') && <p className="mcp-note" role="status">能力待就绪。打开系统设置不代表已授权或委托已完成；请重新检查，回原话题明确继续。</p>}
        <DependencyChecks checks={checks} label="服务依赖检查" />
      </section>}
      {config?.presetId === 'playwright' && <p className="mcp-note">Playwright 预设已移除。浏览器操作请使用官方 ego-browser Skill；此旧配置不会再执行，可停用或删除。</p>}
      {config?.presetId === 'markitdown' && <p className="mcp-note">文档解析仅供已授权文件使用；此处工具列表为空属于正常状态。扫描页和图表可能无法提取，Excel 公式不会重算。</p>}
      {!config && children}
      <form id="mcp-service-form" className="profile-form" onSubmit={event => void save(event)}><fieldset disabled={saving} className="mcp-fields">
        <div className="field-grid"><label className="field">MCP 名称<input required value={name} onChange={event => setName(event.target.value)} placeholder="给这个工具服务起个名字" /></label><label className="field">传输方式<select value={transport} onChange={event => setTransport(event.target.value as McpServiceConfig['transport'])}><option value="stdio">本地 stdio</option><option value="streamable-http">Streamable HTTP</option></select></label></div>
        {transport === 'stdio' ? <><label className="field">可执行命令<input required value={command} onChange={event => setCommand(event.target.value)} placeholder="可执行文件的完整路径" /></label><label className="field">参数 JSON 数组<textarea rows={2} spellCheck={false} value={args} onChange={event => setArgs(event.target.value)} /></label><label className="field">工作目录<input value={cwd} onChange={event => setCwd(event.target.value)} placeholder="可选，留空使用默认目录" /></label></> : <label className="field">MCP URL<input required type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/mcp" /></label>}
        <label className="checkbox-field mcp-enabled"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />启用 MCP 服务</label>
        <p className="mcp-note">连接配置会保留。具体操作遵循当前委托范围；超出范围或需要单独确认的动作，会在执行前请求本次授权。</p>
        <section className="mcp-credentials" aria-label="MCP 凭据"><h4>{transport === 'stdio' ? '环境变量' : '静态请求头'}</h4><p className="mcp-note">{transport === 'stdio' ? '环境变量以明文显示，留空保留原值；勾选清除后删除。' : '已保存的值不回显，留空保留；仅勾选清除时删除。'}</p>
          {transport === 'stdio' && <PresetEnvironment preset={preset} />}
          {keys.map(key => <div className="mcp-secret-row" key={key}><label className="field">{key}<input type={transport === 'stdio' ? 'text' : 'password'} autoComplete={transport === 'stdio' ? 'off' : 'new-password'} spellCheck={false} disabled={clear.includes(key)} value={Object.hasOwn(secrets, key) ? secrets[key] : transport === 'stdio' && Object.hasOwn(environment, key) ? environment[key] : ''} placeholder={transport === 'stdio' ? loadingEnvironment ? '正在读取…' : '输入值' : config?.secretKeys.includes(key) ? '已设置 · 留空保留' : '输入值'} onChange={event => setSecrets(previous => ({ ...previous, [key]: event.target.value }))} /></label><label className="checkbox-field"><input type="checkbox" checked={clear.includes(key)} onChange={event => setClear(previous => event.target.checked ? [...previous, key] : previous.filter(item => item !== key))} />清除 {key}</label></div>)}
          <div className="mcp-new-secret"><label className="field">凭据名称<input value={newKey} onChange={event => setNewKey(event.target.value)} placeholder={transport === 'stdio' ? '例如 API_KEY' : '例如 Authorization'} /></label><button type="button" className="secondary-button" onClick={() => { if (newKey.trim()) { setSecrets(previous => ({ ...previous, [newKey.trim()]: '' })); setNewKey('') } }}>添加凭据</button></div>
        </section>
      </fieldset></form>
      {config && <details className="mcp-disclosure mcp-tools"><summary>可用工具<span>{tools.length} 项</span><Icon name="chevron" /></summary>
        {tools.length === 0 && <p className="mcp-note">{status?.state === 'ready' ? '此服务暂无可直接调用的工具。' : '测试连接后，在这里查看服务提供的工具。'}</p>}
        <ul aria-label="可用 MCP 工具">{tools.map(tool => <li key={tool.name}><strong>{tool.name}</strong><p>{tool.description}</p></li>)}</ul>
      </details>}
      {config && children}
    </div>
    <footer className="mcp-footer">
      {error && <p className="error-banner" role="alert">{error}</p>}{notice && <p className="success-banner" role="status">{notice}</p>}
      {deleting && <div className="delete-confirm"><span>删除此 MCP 配置？</span><button className="danger-button" autoFocus disabled={saving} onClick={() => void remove()}>确认删除 MCP 服务</button><button className="text-button" onClick={() => setDeleting(false)}>取消</button></div>}
      {config && <p className="mcp-note">测试使用已保存的配置，修改后请先保存。</p>}
      <div className="form-actions mcp-actions"><button className="primary-button" type="submit" form="mcp-service-form" disabled={saving}>{saving ? '正在保存…' : '保存 MCP 服务'}</button>
        {config && <><button className="secondary-button" disabled={testing || saving} onClick={() => void test()}>{testing ? '测试中…' : '测试 MCP 连接'}</button><button className="text-button" disabled={saving} onClick={() => void toggle()}>{config.enabled ? '停用 MCP 服务' : '启用已保存服务'}</button><button className="text-button danger mcp-delete" disabled={saving} onClick={() => setDeleting(true)}>删除 MCP 服务</button></>}
      </div>
    </footer>
  </section>
}

function PresetEnvironment({ preset }: { preset?: McpPreset }) {
  if (!preset?.environmentDefaults) return null
  const entries = Object.entries(preset.environmentDefaults)
  return <div className="mcp-preset-environment"><h4>预设默认环境变量</h4>
    {entries.length ? <><p className="mcp-note">添加预设时自动写入；已保存的值可能不同。</p><table aria-label="预设默认环境变量"><thead><tr><th scope="col">变量名</th><th scope="col">默认值</th></tr></thead><tbody>{entries.map(([key, value]) => <tr key={key}><th scope="row"><code>{key}</code></th><td><code>{value}</code></td></tr>)}</tbody></table></> : <p className="mcp-note">此预设无需额外环境变量。</p>}
  </div>
}

function PresetPicker({ presets, onSaved, expanded }: { presets: McpPreset[]; onSaved: (config: McpServiceConfig) => void; expanded: boolean }) {
  const [selected, setSelected] = useState('peekaboo')
  const [checks, setChecks] = useState<DependencyCheck[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; generation.current++ }
  }, [])
  const preset = presets.find(item => item.id === selected)
  async function check() {
    const current = ++generation.current
    setBusy(true); setError(''); setChecks([])
    try {
      const result = await window.her.checkPresetDependencies(selected, '')
      if (mounted.current && current === generation.current) setChecks(result)
    } catch (cause) { if (mounted.current && current === generation.current) setError(messageOf(cause)) }
    finally { if (mounted.current && current === generation.current) setBusy(false) }
  }
  async function create() {
    setBusy(true); setError('')
    try { const saved = await window.her.createMcpPreset(selected); if (mounted.current) onSaved(saved) }
    catch (cause) { if (mounted.current) setError(messageOf(cause)) }
    finally { if (mounted.current) setBusy(false) }
  }
  return <details className="mcp-disclosure mcp-presets" aria-label="工具预设" open={expanded}>
    <summary><span>从预设添加</span><small>检查依赖，快速接入工具</small><Icon name="chevron" /></summary>
    <div className="mcp-preset-body"><label className="field">预设<select value={selected} disabled={busy} onChange={event => { generation.current++; setSelected(event.target.value); setChecks([]); setError('') }}>{presets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <PresetEnvironment preset={preset} />
      <p className="mcp-note">浏览器操作使用官方 ego-browser Skill。<button type="button" className="text-button" onClick={() => void window.her.openExternal('https://github.com/citrolabs/ego-lite/tree/main/skills/ego-browser').catch(cause => setError(messageOf(cause)))}>查看官方 ego-browser Skill</button></p>
      <p className="mcp-note">检查不会安装软件或启动业务操作。{selected === 'peekaboo' && 'Mac 预设允许前台焦点和共享输入；目标会显示在任务步骤中，可随时停止。'}</p>
      <details className="mcp-install-guide"><summary>安装与权限说明</summary><p>{preset?.guidance}</p></details>
      <div className="form-actions mcp-preset-actions"><button type="button" className="secondary-button" disabled={busy} onClick={() => void check()}>{busy ? '正在处理…' : checks.length ? '重新检查依赖' : '检查预设依赖'}</button>
        {preset?.executable && <button type="button" className="secondary-button" disabled={busy || !checks.some(check => check.component === (selected === 'peekaboo' ? 'Peekaboo' : selected === 'markitdown' ? 'MarkItDown' : 'open-websearch') && check.status === 'ready')} onClick={() => void create()}>添加已验证预设</button>}
      </div>
      {error && <p className="error-banner" role="alert">{error}</p>}
      {checks.some(check => check.status !== 'ready') && <p className="mcp-note" role="status">能力待就绪。打开系统设置不代表已授权或委托已完成；请重新检查，回原话题明确继续。</p>}
      <DependencyChecks checks={checks} />
    </div>
  </details>
}
