import { useEffect, useRef, useState } from 'react'
import type { Appearance, AuthMethod, CatalogModel, BootstrapState, DesktopSettings, FileGrant, ProviderProfile, ProviderProtocol, SaveProfileInput, TestKind } from '../../shared/types'
import { Icon } from './Visuals'
import FileAccessPanel from './FileAccessPanel'
import McpSettingsPanel from './McpSettingsPanel'
import SkillsPanel from './SkillsPanel'

interface Props {
  profiles: ProviderProfile[]
  settings: DesktopSettings
  initialProfileId?: string
  dataDirectory: string
  onRevokeFileGrant?(grant: FileGrant): Promise<void>
  onClose(): void
  onConfigurationChanged(): Promise<Pick<BootstrapState, 'profiles' | 'settings'>>
  onAppearanceChanged(appearance: Appearance): void
  onSelectProfile(id: string): Promise<void>
}

interface ModelRow { id: string; longOutput: boolean; multimodal: boolean }
const emptyRows = (): ModelRow[] => [{ id: '', longOutput: false, multimodal: false }]
const rowsOf = (item?: ProviderProfile): ModelRow[] => item ? item.models.map((entry) => ({ id: entry.id, longOutput: entry.longOutput, multimodal: entry.multimodal })) : emptyRows()
const defaultIndexOf = (item?: ProviderProfile) => item ? Math.max(0, item.models.findIndex((entry) => entry.id === item.model)) : 0

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : '操作未完成，请重试。'
}

export default function SettingsPanel(props: Props) {
  const initialId = props.profiles.some(item => item.id === props.initialProfileId) ? props.initialProfileId : props.settings.activeProfileId ?? props.profiles[0]?.id
  const initialProfile = props.profiles.find((item) => item.id === initialId)
  const [tab, setTab] = useState<'models' | 'desktop' | 'system-prompt' | 'mcp' | 'files' | 'skills'>('models')
  const [editingId, setEditingId] = useState<string | undefined>(initialId)
  const [name, setName] = useState(initialProfile?.name ?? '')
  const [protocol, setProtocol] = useState<ProviderProtocol>(initialProfile?.protocol ?? 'openai')
  const [baseUrl, setBaseUrl] = useState(initialProfile?.baseUrl ?? '')
  const [modelRows, setModelRows] = useState(rowsOf(initialProfile))
  const [defaultIndex, setDefaultIndex] = useState(defaultIndexOf(initialProfile))
  const [testModel, setTestModel] = useState('')
  const [maxOutputTokens, setMaxOutputTokens] = useState(initialProfile?.maxOutputTokens?.toString() ?? '')
  const [contextWindow, setContextWindow] = useState(initialProfile?.contextWindow?.toString() ?? '')
  const [authMethod, setAuthMethod] = useState<AuthMethod>(initialProfile?.authMethod ?? 'api-key')
  const [source, setSource] = useState(initialProfile?.catalogProvider ? 'catalog' : 'custom')
  const [catalogProvider, setCatalogProvider] = useState(initialProfile?.catalogProvider ?? '')
  const [catalog, setCatalog] = useState<CatalogModel[]>([])
  const [apiKey, setApiKey] = useState('')
  const [headers, setHeaders] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [clearHeaders, setClearHeaders] = useState(false)
  const [shortcut, setShortcut] = useState(props.settings.shortcut)
  const [stopShortcut, setStopShortcut] = useState(props.settings.stopShortcut)
  const [launchAtLogin, setLaunchAtLogin] = useState(props.settings.launchAtLogin)
  const [appearance, setAppearance] = useState(props.settings.appearance)
  const [appearanceBusy, setAppearanceBusy] = useState(false)
  const [systemPrompt, setSystemPrompt] = useState('')
  const [defaultSystemPrompt, setDefaultSystemPrompt] = useState('')
  const [systemPromptReady, setSystemPromptReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState<TestKind | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const advancedOptionsRef = useRef<HTMLDetailsElement>(null)
  const mounted = useRef(true)
  const closeRef = useRef(props.onClose)
  closeRef.current = props.onClose
  const profile = props.profiles.find((item) => item.id === editingId)
  const formIdentity = JSON.stringify([profile?.id, profile?.name, profile?.protocol, profile?.baseUrl, profile?.model, profile?.models.map((entry) => [entry.id, entry.longOutput]), profile?.maxOutputTokens, profile?.contextWindow, profile?.authMethod, profile?.catalogProvider])
  const displayedFormIdentity = useRef(formIdentity)
  const testEntry = profile ? profile.models.find((entry) => entry.id === testModel) ?? profile.models.find((entry) => entry.id === profile.model) ?? profile.models[0] : undefined

  useEffect(() => {
    if (displayedFormIdentity.current === formIdentity) return
    displayedFormIdentity.current = formIdentity
    setName(profile?.name ?? '')
    setProtocol(profile?.protocol ?? 'openai')
    setBaseUrl(profile?.baseUrl ?? '')
    setModelRows(rowsOf(profile))
    setDefaultIndex(defaultIndexOf(profile))
    setTestModel('')
    setMaxOutputTokens(profile?.maxOutputTokens?.toString() ?? '')
    setContextWindow(profile?.contextWindow?.toString() ?? '')
    setAuthMethod(profile?.authMethod ?? 'api-key')
    setSource(profile?.catalogProvider ? 'catalog' : 'custom')
    setCatalogProvider(profile?.catalogProvider ?? '')
    setApiKey('')
    setHeaders('')
    setClearKey(false)
    setClearHeaders(false)
    setConfirmDelete(false)
  }, [formIdentity])

  useEffect(() => {
    mounted.current = true
    const dialog = dialogRef.current
    dialog?.focus()
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') closeRef.current()
      if (event.key !== 'Tab' || !dialog) return
      const elements = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')]
      const first = elements[0]
      const last = elements.at(-1)
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    dialog?.addEventListener('keydown', onKeyDown)
    window.her.listModelCatalog().then(models => { if (mounted.current) setCatalog(models) }).catch(() => { if (mounted.current) setError('无法加载 Pi 模型目录，请重试。') })
    Promise.all([window.her.getSystemPrompt(), window.her.getDefaultSystemPrompt()]).then(([current, defaultPrompt]) => {
      if (!mounted.current) return
      setDefaultSystemPrompt(defaultPrompt)
      setSystemPrompt(current || defaultPrompt)
      setSystemPromptReady(true)
    }).catch(() => { if (mounted.current) setError('系统提示词加载失败，请关闭设置后重试。') })
    return () => { mounted.current = false; dialog?.removeEventListener('keydown', onKeyDown) }
  }, [])

  function resetModels() { setModelRows(emptyRows()); setDefaultIndex(0) }
  function updateRow(index: number, change: Partial<ModelRow>) { setModelRows((rows) => rows.map((row, i) => i === index ? { ...row, ...change } : row)) }
  function removeRow(index: number) {
    setModelRows((rows) => rows.filter((_, i) => i !== index))
    setDefaultIndex((current) => index < current ? current - 1 : index === current ? 0 : current)
  }

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    setNotice('')
    let customHeaders: Record<string, string> | undefined
    if (clearHeaders) customHeaders = {}
    else if (headers.trim()) {
      try {
        const parsed: unknown = JSON.parse(headers)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.values(parsed).every((value) => typeof value === 'string')) throw new Error()
        customHeaders = parsed as Record<string, string>
      } catch { if (advancedOptionsRef.current) advancedOptionsRef.current.open = true; setError('额外请求头必须是 JSON 对象，且每个值都是字符串。例如 {"X-Project": "my-project"}。'); return }
    }
    const models = modelRows.map((row) => ({ id: row.id.trim(), longOutput: row.longOutput, multimodal: row.multimodal }))
    if (source === 'catalog' && !catalogProvider) { setError('请选择 Pi 目录模型。'); return }
    const input: SaveProfileInput = {
      ...(editingId ? { id: editingId } : {}),
      name: name.trim(),
      protocol,
      baseUrl: baseUrl.trim(),
      model: models[defaultIndex]?.id ?? '',
      models,
      authMethod,
      ...(source === 'catalog' ? { catalogProvider } : {}),
      ...(clearKey ? { apiKey: '' } : apiKey ? { apiKey } : {}),
      ...(customHeaders !== undefined ? { customHeaders } : {}),
      maxOutputTokens: maxOutputTokens.trim() === '' ? null : Number(maxOutputTokens),
      ...(contextWindow.trim() === '' ? {} : { contextWindow: Number(contextWindow) })
    }
    setBusy(true)
    try {
      const saved = await window.her.saveProfile(input)
      const current = await props.onConfigurationChanged()
      if (!mounted.current) return
      setApiKey('')
      setHeaders('')
      setClearKey(false)
      setClearHeaders(false)
      setEditingId(saved.id)
      if (!current.settings.activeProfileId && current.profiles.some((item) => item.id === saved.id)) await props.onSelectProfile(saved.id)
      if (mounted.current) setNotice('服务已保存')
    } catch (cause) { if (mounted.current) setError(`保存失败：${messageOf(cause)}`) }
    finally { if (mounted.current) setBusy(false) }
  }

  async function test(kind: TestKind) {
    if (!profile || busy) return
    setError('')
    setNotice('')
    setBusy(true)
    setTesting(kind)
    try {
      const result = profile.models.length > 1 ? await window.her.testProfile(profile.id, kind, testEntry!.id) : await window.her.testProfile(profile.id, kind)
      await props.onConfigurationChanged()
      if (!mounted.current) return
      if (mounted.current) setNotice(`${kind === 'chat' ? '文字' : kind === 'vision' ? '视觉' : '工具'}测试：${result.message}`)
    } catch (cause) { if (mounted.current) setError(`测试失败：${messageOf(cause)} 请检查已保存的地址、模型和密钥。`) }
    finally { if (mounted.current) { setBusy(false); setTesting(null) } }
  }

  async function deleteProfile() {
    if (!profile) return
    setBusy(true)
    setError('')
    try {
      await window.her.deleteProfile(profile.id)
      const current = await props.onConfigurationChanged()
      if (!mounted.current) return
      setEditingId(current.profiles[0]?.id)
      setConfirmDelete(false)
      setNotice('服务已删除，聊天记录已保留')
    } catch (cause) { if (mounted.current) setError(`删除失败：${messageOf(cause)}`) }
    finally { if (mounted.current) setBusy(false) }
  }

  async function savePreferences(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await window.her.setDesktopPreferences({ shortcut: shortcut.trim(), stopShortcut: stopShortcut.trim(), launchAtLogin })
      const current = await props.onConfigurationChanged()
      if (!mounted.current) return
      setShortcut(current.settings.shortcut)
      setStopShortcut(current.settings.stopShortcut)
      setLaunchAtLogin(current.settings.launchAtLogin)
      setNotice('桌面偏好已保存')
    } catch (cause) { if (mounted.current) setError(messageOf(cause)) }
    finally { if (mounted.current) setBusy(false) }
  }

  async function changeAppearance(next: Appearance) {
    if (appearanceBusy || next === appearance) return
    setAppearanceBusy(true)
    setError('')
    setNotice('')
    try {
      const saved = await window.her.setAppearance(next)
      props.onAppearanceChanged(saved.appearance)
      if (!mounted.current) return
      setAppearance(saved.appearance)
      setNotice('外观已保存')
    } catch (cause) { if (mounted.current) setError(`外观保存失败：${messageOf(cause)}`) }
    finally { if (mounted.current) setAppearanceBusy(false) }
  }

  async function saveSystemPrompt(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const prompt = systemPrompt.trim()
      await window.her.setSystemPrompt(prompt === defaultSystemPrompt.trim() ? '' : prompt)
      if (!mounted.current) return
      setSystemPrompt(prompt || defaultSystemPrompt)
      setNotice('系统提示词已保存')
    } catch (cause) { if (mounted.current) setError(messageOf(cause)) }
    finally { if (mounted.current) setBusy(false) }
  }

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) props.onClose() }}>
    <div className="settings-dialog settings-panel-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1} ref={dialogRef}>
      <header className="settings-header"><div><h2 id="settings-title">设置</h2><p className="eyebrow">让这里更合你的习惯。</p></div><button className="icon-button" aria-label="关闭设置" onClick={props.onClose}><Icon name="close" /></button></header>
      <div className="settings-body">
        <div className="settings-tabs" role="tablist" aria-label="设置类别"><button role="tab" aria-selected={tab === 'models'} onClick={() => { setTab('models'); setError(''); setNotice('') }}>模型服务</button><button role="tab" aria-selected={tab === 'mcp'} onClick={() => { setTab('mcp'); setError(''); setNotice('') }}>MCP 工具</button><button role="tab" aria-selected={tab === 'skills'} onClick={() => { setTab('skills'); setError(''); setNotice('') }}>技能</button><button role="tab" aria-selected={tab === 'files'} onClick={() => { setTab('files'); setError(''); setNotice('') }}>资料授权</button><button role="tab" aria-selected={tab === 'desktop'} onClick={() => { setTab('desktop'); setError(''); setNotice('') }}>桌面偏好</button><button role="tab" aria-selected={tab === 'system-prompt'} onClick={() => { setTab('system-prompt'); setError(''); setNotice('') }}>系统提示词</button></div>
      <div className={`settings-content${tab === 'models' ? ' model-settings-content' : tab === 'mcp' ? ' mcp-settings-content' : ''}`}>
        {error && <div className="error-banner" role="alert">{error}</div>}{notice && <div className="success-banner" role="status"><Icon name="check" />{notice}</div>}
        {tab === 'skills' ? <SkillsPanel /> : tab === 'files' ? <FileAccessPanel persistent onRevoke={props.onRevokeFileGrant} /> : tab === 'mcp' ? <McpSettingsPanel /> : tab === 'models' ? <div className="model-settings">
          <aside className="service-list" aria-label="已保存的服务"><div className="service-list-title"><span>我的服务</span><button className="icon-button" aria-label="新建模型服务" disabled={busy} onClick={() => { setEditingId(undefined); setAuthMethod('api-key'); setSource('custom'); setCatalogProvider(''); setName(''); setProtocol('openai'); setBaseUrl(''); resetModels(); setMaxOutputTokens(''); setContextWindow(''); setApiKey(''); setHeaders(''); setClearKey(false); setClearHeaders(false); setNotice(''); setError(''); setConfirmDelete(false) }}><Icon name="plus" /></button></div>
            {props.profiles.length === 0 && <p className="service-empty">添加你的第一个服务，<br />开始和 Her 聊天。</p>}
            {props.profiles.map((item) => <button key={item.id} className={`service-item ${item.id === editingId ? 'selected' : ''}`} aria-label={`编辑 ${item.name}`} disabled={busy} onClick={() => { setEditingId(item.id); setNotice(''); setError('') }}><span className="service-monogram">{item.protocol === 'anthropic' ? 'A' : item.protocol === 'openai-responses' ? 'R' : 'O'}</span><span><strong>{item.name}</strong><small>{item.model}</small></span>{props.settings.activeProfileId === item.id && <span className="service-active" aria-label="当前使用"><Icon name="check" /></span>}</button>)}
            <button className="text-button add-service" disabled={busy} onClick={() => { setEditingId(undefined); setAuthMethod('api-key'); setSource('custom'); setCatalogProvider(''); setName(''); setProtocol('openai'); setBaseUrl(''); resetModels(); setMaxOutputTokens(''); setContextWindow(''); setApiKey(''); setHeaders(''); setClearKey(false); setClearHeaders(false); setNotice(''); setError(''); setConfirmDelete(false) }}><Icon name="plus" />添加服务</button>
          </aside>

          <div className="service-editor"><div className="service-editor-scroll"><div className="editor-heading"><div><h3>{profile ? '服务配置' : '添加模型服务'}</h3><p>选择熟悉的模型，用自己的连接方式。</p></div>{profile && <button className="text-button" disabled={busy || props.settings.activeProfileId === profile.id} onClick={() => { setError(''); void props.onSelectProfile(profile.id).then(() => { if (mounted.current) setNotice('已设为当前服务') }).catch((cause) => { if (mounted.current) setError(`切换失败：${messageOf(cause)}`) }) }}>{props.settings.activeProfileId === profile.id ? '当前服务' : '设为当前'}</button>}</div>
            <form id="profile-form" className="profile-form" onSubmit={(event) => void saveProfile(event)}>
              <label className="field">模型来源<select aria-label="模型来源" value={source} onChange={event => { setSource(event.target.value); setCatalogProvider('') }}><option value="custom">自定义兼容服务</option><option value="catalog">Pi 模型目录</option></select></label>
              {source === 'catalog' && <label className="field">Pi 目录模型<select aria-label="Pi 目录模型" value={catalogProvider ? `${catalogProvider}/${modelRows[0]?.id}` : ''} onChange={event => {
                const model = catalog.find(item => `${item.provider}/${item.id}` === event.target.value)
                if (!model) return
                setCatalogProvider(model.provider); setProtocol(model.protocol); setBaseUrl(model.baseUrl)
                setModelRows([{ id: model.id, longOutput: false, multimodal: model.multimodal }]); setDefaultIndex(0)
                setContextWindow(String(model.contextWindow)); setMaxOutputTokens(String(model.maxOutputTokens))
              }}><option value="">请选择模型</option>{catalog.map(model => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.provider} · {model.name}</option>)}</select><small>{modelRows[0]?.multimodal ? '支持图片' : '仅文本'}；工具能力请通过连接测试确认。</small></label>}
              <label className="field">认证方式<select aria-label="认证方式" value={authMethod} onChange={event => setAuthMethod(event.target.value as AuthMethod)}><option value="api-key">API Key</option><option value="headers">仅自定义请求头</option><option value="none">无密钥</option></select></label>
              <div className="field-grid"><label className="field">服务名称<input required value={name} onChange={(event) => setName(event.target.value)} placeholder="比如：我的 Claude" /></label><label className="field">协议<select disabled={source === 'catalog'} aria-label="协议" value={protocol} onChange={(event) => setProtocol(event.target.value as ProviderProtocol)}><option value="openai">OpenAI 兼容</option><option value="anthropic">Claude / Anthropic</option><option value="openai-responses">OpenAI Responses</option></select></label></div>
              <label className="field">Base URL<input readOnly={source === 'catalog'} aria-label="Base URL" required type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://example.com/proxy/v1" /><small>{protocol === 'anthropic' ? '填写包含路径前缀的基址，Her 会追加对应的接口路径。' : '填写包含路径前缀的基址（填到 /v1 即可），Her 会追加对应的接口路径。'}</small></label>
              <div className="field"><label htmlFor="api-key">API Key</label><input id="api-key" type="password" autoComplete="new-password" value={apiKey} disabled={clearKey || authMethod !== 'api-key'} onChange={(event) => setApiKey(event.target.value)} placeholder={profile?.hasApiKey ? '已保存 · 留空保留，输入新值替换' : '输入密钥（服务无需鉴权时可留空）'} /><small>密钥由系统保护，已保存的值不会回显。{profile && <> · 认证方式：{profile.authMethod === 'api-key' ? 'API Key' : profile.authMethod === 'headers' ? '额外请求头' : '无密钥'}</>}</small>{profile?.hasApiKey && <label className="checkbox-field"><input type="checkbox" checked={clearKey} onChange={(event) => { setClearKey(event.target.checked); setApiKey('') }} />清除已保存的密钥</label>}</div>
              <fieldset className="field model-list"><legend>模型</legend>
                {modelRows.map((row, index) => <div className="model-row" key={index}>
                  <input type="radio" name="default-model" aria-label={`设为默认模型 ${index + 1}`} checked={defaultIndex === index} onChange={() => setDefaultIndex(index)} />
                  <input readOnly={source === 'catalog'} aria-label={index === 0 ? 'Model ID' : `Model ID ${index + 1}`} required value={row.id} onChange={(event) => updateRow(index, { id: event.target.value })} placeholder={protocol === 'anthropic' ? '例如 claude-sonnet-4-6' : '填写服务支持的模型 ID'} />
                  <label className="checkbox-field"><input type="checkbox" aria-label={`1M ${index + 1}`} checked={row.longOutput} onChange={(event) => updateRow(index, { longOutput: event.target.checked })} />1M</label>
                  <label className="checkbox-field"><input type="checkbox" aria-label={`多模态 ${index + 1}`} checked={row.multimodal} onChange={(event) => updateRow(index, { multimodal: event.target.checked })} />多模态</label>
                  <button type="button" className="icon-button" aria-label={`删除模型 ${index + 1}`} disabled={modelRows.length === 1} onClick={() => removeRow(index)}><Icon name="close" /></button>
                </div>)}
                <button type="button" className="text-button add-model" disabled={source === 'catalog' || modelRows.length >= 20} onClick={() => setModelRows((rows) => [...rows, { id: '', longOutput: false, multimodal: false }])}><Icon name="plus" />添加模型</button>
                <small>选中的是默认模型，新对话默认使用它；勾选 1M 后该模型的单次输出上限为 1,000,000 token；勾选多模态后该模型支持图片、声音、视频、文件等输入。</small>
              </fieldset>
              <details className="profile-advanced" ref={advancedOptionsRef} onInvalidCapture={(event) => { event.currentTarget.open = true }}><summary>高级选项</summary>
                {<label className="field">最大输出 token 数<input aria-label="最大输出 token 数" readOnly={source === 'catalog'} type="number" min={1} max={1000000} step={1} value={maxOutputTokens} onChange={(event) => setMaxOutputTokens(event.target.value)} placeholder="留空使用默认 262144" /><small>单次回答的输出上限,不同模型支持的上限不同。若上游拒绝请求，请在这里填写较小的值。</small></label>}
                <label className="field">上下文容量（tokens）<input aria-label="上下文容量" readOnly={source === 'catalog'} required type="number" min={1024} max={10000000} step={1} value={contextWindow} onChange={(event) => setContextWindow(event.target.value)} placeholder="请填写模型上下文容量" /><small>模型支持的最大上下文窗口（输入 + 输出），自定义服务必须填写。</small></label>
                <div className="field"><label htmlFor="custom-headers">额外请求头</label><textarea id="custom-headers" rows={3} spellCheck={false} value={headers} disabled={clearHeaders} onChange={(event) => setHeaders(event.target.value)} placeholder={profile?.hasCustomHeaders ? '已保存 · 留空保留，填写 JSON 替换' : '{"X-Project": "my-project"}'} /><small>可选的 JSON 对象，值需为字符串；保存后不会回显。</small>{profile?.hasCustomHeaders && <label className="checkbox-field"><input type="checkbox" checked={clearHeaders} onChange={(event) => { setClearHeaders(event.target.checked); setHeaders('') }} />清除已保存的请求头</label>}</div>
              </details>
            </form>
            {profile && <section className="connection-tests"><h3>连接测试</h3><p>测试使用已保存的配置。修改后请先保存。</p>{profile.models.length > 1 && <label className="field">测试模型<select aria-label="测试模型" value={testEntry!.id} onChange={(event) => setTestModel(event.target.value)}>{profile.models.map((entry) => <option key={entry.id} value={entry.id}>{entry.id}</option>)}</select></label>}{(['chat', 'tools', 'vision'] as const).map((kind) => <div className="test-row" key={kind}><div><strong>{kind === 'chat' ? '文字流式' : kind === 'vision' ? '图片识别' : '工具调用'}</strong><small>{testEntry!.tests[kind].status === 'untested' ? '尚未验证' : testEntry!.tests[kind].message}</small></div><span className={`test-badge ${testEntry!.tests[kind].status}`}>{testEntry!.tests[kind].status === 'passed' ? '已验证' : testEntry!.tests[kind].status === 'failed' ? '失败' : '未验证'}</span><button className="secondary-button" disabled={busy} onClick={() => void test(kind)}>{testing === kind ? '测试中…' : kind === 'chat' ? '测试文字' : kind === 'vision' ? '测试视觉' : '测试工具'}</button></div>)}<p className="test-explanation">文字流式、工具调用和图片识别分别验证。</p></section>}
            </div>
            <div className="profile-footer">
              {confirmDelete && <div className="delete-confirm"><span>删除这个服务？聊天记录会保留。</span><button className="danger-button" autoFocus disabled={busy} onClick={() => void deleteProfile()}>确认删除服务</button><button className="text-button" onClick={() => setConfirmDelete(false)}>取消</button></div>}
              <div className="form-actions profile-actions"><button className="primary-button" type="submit" form="profile-form" disabled={busy}>{busy && !testing ? '正在保存…' : '保存服务'}</button>{profile && <button className="text-button danger" type="button" disabled={busy} onClick={() => setConfirmDelete(!confirmDelete)}><Icon name="trash" />删除服务</button>}</div>
            </div>
          </div>
        </div> : tab === 'desktop' ? <form className="desktop-settings" onSubmit={(event) => void savePreferences(event)}><h3>随时回来聊聊。</h3><p className="desktop-intro">关闭窗口后，Her 会留在菜单栏。使用快捷键就能唤出她。</p><fieldset className="appearance-settings" disabled={appearanceBusy}><legend>外观</legend><div className="appearance-options" role="radiogroup" aria-label="外观">{([['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']] as const).map(([value, label]) => <label key={value} className={appearance === value ? 'selected' : ''}><input type="radio" name="appearance" value={value} checked={appearance === value} onChange={() => void changeAppearance(value)} />{label}</label>)}</div><small>选择后立即生效，并自动保存到这台设备。</small></fieldset><label className="field">唤出快捷键<input aria-label="唤出快捷键" required value={shortcut} onChange={(event) => setShortcut(event.target.value)} placeholder="CommandOrControl+Shift+H" /><small>例如 CommandOrControl+Shift+H。快捷键被占用时会提示你更换。</small></label><label className="field">全局停止快捷键<input aria-label="全局停止快捷键" value={stopShortcut} onChange={event => setStopShortcut(event.target.value)} placeholder="CommandOrControl+Shift+Escape" /><small>窗口隐藏时也能停止当前任务；停止不代表撤销已发生的动作。</small></label><label className="checkbox-field desktop-checkbox"><input type="checkbox" aria-label="登录时启动 Her" checked={launchAtLogin} onChange={(event) => setLaunchAtLogin(event.target.checked)} /><span>登录时启动 Her<small>安装版可用。在你登录 Mac 后，让 Her 在菜单栏待命。</small></span></label><button className="primary-button" type="submit" disabled={busy}>{busy ? '正在保存…' : '保存偏好'}</button><div className="data-directory"><span>本地数据目录</span><code>{props.dataDirectory}</code><small>聊天记录保存在本机，模型推理使用你选择的云端服务。</small></div></form> : <form className="system-prompt-settings" onSubmit={(event) => void saveSystemPrompt(event)}><h3>系统提示词</h3><p className="desktop-intro">直接编辑当前提示词，定义 Samantha 的性格和行为方式。留空使用默认提示词。</p><label className="field">当前提示词<textarea aria-label="系统提示词" rows={12} spellCheck={false} maxLength={16384} disabled={!systemPromptReady || busy} value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} placeholder="提示词加载后可编辑" /><small>系统提示词会影响 Samantha 的回答风格和行为。保存后，下次发送或继续对话时生效，正在运行的任务不受影响。{systemPrompt && <span className="char-count"> · 已输入 {systemPrompt.length} / 16384 字符</span>}</small></label><div className="form-actions"><button className="primary-button" type="submit" disabled={busy || !systemPromptReady}>{busy ? '正在保存…' : '保存提示词'}</button><button className="text-button" type="button" disabled={busy || !systemPromptReady || systemPrompt === defaultSystemPrompt} onClick={() => setSystemPrompt(defaultSystemPrompt)}>恢复默认</button></div></form>}
      </div>
      </div>
    </div>
  </div>
}
