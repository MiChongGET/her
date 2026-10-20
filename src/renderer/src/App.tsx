import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { BootstrapState, ChatMessage, ConversationSummary, FileReference, FileGrant, ProviderProfile, SendMessageInput, TaskEvent } from '../../shared/types'
import TaskStatus, { ArtifactPreview } from './TaskStatus'
import FileAccessPanel from './FileAccessPanel'
import DocumentSources, { FilePreview } from './DocumentSources'
import SettingsPanel from './SettingsPanel'
import TrashPanel from './TrashPanel'
import { Icon, HerMark } from './Visuals'

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '操作未完成，请重试。'
}

function upsert(messages: ChatMessage[], message: ChatMessage, preserveExisting = false) {
  const index = messages.findIndex((item) => item.id === message.id)
  if (index === -1) return [...messages, message].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.role === 'user' ? -1 : 1))
  return messages.map((item, i) => i === index && !preserveExisting ? message : item)
}

function effectiveModel(profile: ProviderProfile | undefined, selected: string | null) {
  if (!profile) return undefined
  return selected && profile.models.some((entry) => entry.id === selected) ? selected : profile.model
}

function conversationPreview(content: string) {
  const preview = content.split(/\r?\n/).filter(line => !/^\s*🔧\s*调用工具\s+[\w.:-]+\s*\(/u.test(line)).join(' ').replace(/\s+/g, ' ').trim()
  return preview || (content.trim() ? '工具调用记录' : '还没有消息')
}

function sidebarWidthLimit() {
  return Math.max(200, Math.min(360, window.innerWidth - 520))
}

export default function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null)
  const [bootError, setBootError] = useState('')
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [messagesByConversation, setMessagesByConversation] = useState<Record<string, ChatMessage[]>>({})
  const [tasks, setTasks] = useState<Record<string, TaskEvent | null>>({})
  const [queues, setQueues] = useState<Record<string, ConversationQueueState>>({})
  const taskVersions = useRef(new Map<string, number>())
  const requestVersion = useRef(0)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [messageLoadFailed, setMessageLoadFailed] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [draft, setDraft] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<FileReference[]>([])
  const [selectingFiles, setSelectingFiles] = useState(false)
  const [fileRevision, setFileRevision] = useState(0)
  const [revokedGrants, setRevokedGrants] = useState<string[]>([])
  const [revokingGrants, setRevokingGrants] = useState<string[]>([])
  const fileGeneration = useRef(0)
  const viewGeneration = useRef(0)
  const draftGeneration = useRef(0)
  const currentIdRef = useRef<string | null>(null)
  const fileMounted = useRef(true)
  useEffect(() => { fileMounted.current = true; return () => { fileMounted.current = false; fileGeneration.current++ } }, [])
  function changeConversation(id: string | null) {
    viewGeneration.current++; fileGeneration.current++; currentIdRef.current = id
    setCurrentId(id); setSelectedFiles([]); setSelectingFiles(false)
  }
  const [error, setError] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsProfileId, setSettingsProfileId] = useState<string | undefined>()
  const [calendarDay, setCalendarDay] = useState(() => new Date())
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  const [sidebarHidden, setSidebarHidden] = useState(false)
  const [sidebarMaxWidth, setSidebarMaxWidth] = useState(sidebarWidthLimit)
  const [sidebarWidth, setSidebarWidth] = useState(() => Math.min(sidebarWidthLimit(), window.innerWidth <= 900 ? 210 : window.innerWidth >= 1280 ? 270 : 250))
  const [resizingSidebar, setResizingSidebar] = useState(false)
  const sidebarResize = useRef<{ startX: number; width: number } | null>(null)
  const [trashOpen, setTrashOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [activeRequest, setActiveRequest] = useState<Pick<SendMessageInput, 'requestId' | 'conversationId'> | null>(null)
  const [stopping, setStopping] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)
  const renameDone = useRef(true)
  const pendingRef = useRef(false)
  const requestRef = useRef<Pick<SendMessageInput, 'requestId' | 'conversationId'> | null>(null)
  const configurationVersion = useRef(0)
  const eventMessages = useRef(new Map<string, ChatMessage>())
  const completedRequests = useRef(new Set<string>())
  const loadedConversations = useRef(new Set<string>())
  const bottomRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const followStream = useRef(true)

  const loadBootstrap = useCallback(async () => {
    setBootError('')
    const version = requestVersion.current
    try {
      const state = await window.her.getBootstrap()
      if (version === requestVersion.current && state.activeRequest) {
        requestRef.current = state.activeRequest; setActiveRequest(state.activeRequest); pendingRef.current = true; setBusy(true)
      }
      setBootstrap(state)
      if (!currentIdRef.current) changeConversation(state.conversations[0]?.id ?? null)
      return state
    } catch (cause) {
      setBootError(`无法读取本地数据：${errorMessage(cause)}`)
    }
  }, [])

  const refreshConfiguration = useCallback(async () => {
    const version = ++configurationVersion.current
    try {
      const { profiles, settings } = await window.her.getBootstrap()
      if (version === configurationVersion.current) setBootstrap((state) => state && ({ ...state, profiles, settings }))
      return { profiles, settings }
    } catch (cause) {
      setError(`无法同步设置：${errorMessage(cause)} 请重新打开设置重试。`)
      throw cause
    }
  }, [])

  async function openSettings(profileId?: string) {
    try { await refreshConfiguration(); setSettingsProfileId(profileId); setSettingsOpen(true) }
    catch { /* The configuration refresh displays the error. */ }
  }

  useEffect(() => {
    const midnight = new Date(calendarDay)
    midnight.setHours(24, 0, 0, 0)
    const timer = window.setTimeout(() => setCalendarDay(new Date()), Math.max(0, midnight.getTime() - Date.now()))
    return () => window.clearTimeout(timer)
  }, [calendarDay])

  useEffect(() => {
    const resize = () => {
      const max = sidebarWidthLimit()
      setSidebarMaxWidth(max)
      setSidebarWidth(width => Math.min(width, max))
    }
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  function finishSidebarResize(event: PointerEvent<HTMLDivElement>) {
    sidebarResize.current = null
    setResizingSidebar(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const receiveTask = useCallback((task: TaskEvent) => {
    if (completedRequests.current.has(task.requestId) && ['running', 'awaiting_confirmation'].includes(task.run.status)) return
    requestVersion.current++
    taskVersions.current.set(task.conversationId, (taskVersions.current.get(task.conversationId) ?? 0) + 1)
    setTasks(previous => ({ ...previous, [task.conversationId]: task }))
    if (['running', 'awaiting_confirmation'].includes(task.run.status)) {
      requestRef.current = { requestId: task.requestId, conversationId: task.conversationId }
      setActiveRequest(requestRef.current); pendingRef.current = true; setBusy(true)
    } else if (requestRef.current?.requestId === task.requestId) {
      requestRef.current = null; setActiveRequest(null); pendingRef.current = false; setBusy(false); setStopping(false)
    }
  }, [])

  useEffect(() => {
    if (!currentId) return
    let live = true
    const version = taskVersions.current.get(currentId) ?? 0
    void window.her.getConversationTask(currentId).then(task => {
      if (live && version === (taskVersions.current.get(currentId) ?? 0)) {
        if (task) receiveTask(task)
        else setTasks(previous => ({ ...previous, [currentId]: null }))
      }
    }).catch(cause => { if (live) setError(`无法读取任务：${errorMessage(cause)}`) })
    return () => { live = false }
  }, [currentId, loadAttempt, receiveTask])

  useEffect(() => {
    let subscribed = true
    const unsubscribeRequest = window.her.onRequestEvent(event => {
      requestVersion.current++
      taskVersions.current.set(event.conversationId, (taskVersions.current.get(event.conversationId) ?? 0) + 1)
      if (event.state === 'started') {
        if (completedRequests.current.has(event.requestId) || (requestRef.current && requestRef.current.requestId !== event.requestId)) return
        requestRef.current = { requestId: event.requestId, conversationId: event.conversationId }
        setActiveRequest(requestRef.current); pendingRef.current = true; setBusy(true); setStopping(false)
      } else {
        completedRequests.current.add(event.requestId)
        if (requestRef.current?.requestId !== event.requestId) return
        requestRef.current = null; setActiveRequest(null); pendingRef.current = false; setBusy(false); setStopping(false)
        if (event.error) setError(event.error)
      }
    })
    const unsubscribe = window.her.onChatEvent((event) => {
      if (completedRequests.current.has(event.requestId)) return
      if (event.task) receiveTask(event.task)
      eventMessages.current.set(event.message.id, event.message)
      setMessagesByConversation((previous) => ({ ...previous, [event.conversationId]: upsert(previous[event.conversationId] ?? [], event.message) }))
      setBootstrap((state) => state && ({ ...state, conversations: state.conversations.map((item) => item.id === event.conversationId ? { ...item, lastMessage: event.message.content, updatedAt: event.message.createdAt } : item) }))
      if (event.done) {
        completedRequests.current.add(event.requestId)
        if (requestRef.current?.requestId === event.requestId) {
          requestRef.current = null
          pendingRef.current = false
          setActiveRequest(null)
          setBusy(false)
          setStopping(false)
        }
      }
    })
    void loadBootstrap().then(async state => {
      if (!state || !subscribed) return
      await Promise.all(state.conversations.map(async conversation => {
        const version = taskVersions.current.get(conversation.id) ?? 0
        const task = await window.her.getConversationTask(conversation.id)
        if (subscribed && task && !completedRequests.current.has(task.requestId) && ['running', 'awaiting_confirmation'].includes(task.run.status) && version === (taskVersions.current.get(conversation.id) ?? 0)) receiveTask(task)
      }))
    }).catch(() => {})
    const unsubscribeTask = window.her.onTaskEvent(task => {
      if (!completedRequests.current.has(task.requestId)) receiveTask(task)
    })
    const unsubscribeQueue = window.her.onQueueEvent(queue => {
      setQueues(prev => ({ ...prev, [queue.conversationId]: queue }))
    })
    return () => { subscribed = false; unsubscribeRequest(); unsubscribe(); unsubscribeTask(); unsubscribeQueue() }
  }, [loadBootstrap, receiveTask])

  useEffect(() => {
    setMessageLoadFailed(false)
    if (!currentId || loadedConversations.current.has(currentId)) {
      setLoadingMessages(false)
      return
    }
    let viewing = true
    setLoadingMessages(true)
    window.her.getMessages(currentId).then((messages) => {
      loadedConversations.current.add(currentId)
      setMessagesByConversation((previous) => {
        const live = previous[currentId] ?? []
        return { ...previous, [currentId]: live.reduce((all, item) => upsert(all, item), messages) }
      })
    }).catch((cause) => {
      if (viewing) { setError(`无法读取这段对话：${errorMessage(cause)}`); setMessageLoadFailed(true) }
    }).finally(() => { if (viewing) setLoadingMessages(false) })
    return () => { viewing = false }
  }, [currentId, loadAttempt])

  const activeProfileId = bootstrap?.settings.activeProfileId ?? null
  useEffect(() => { setSelectedModel(null) }, [activeProfileId])

  const messages = currentId ? messagesByConversation[currentId] ?? [] : []
  useEffect(() => {
    if (followStream.current) bottomRef.current?.scrollIntoView?.({ behavior: 'auto' })
  }, [messages, currentId, busy])

  async function selectProfile(id: string) {
    await window.her.selectProfile(id)
    await refreshConfiguration()
  }

  async function createConversation(expectedView?: number) {
    setError('')
    try {
      const conversation = await window.her.createConversation()
      if (expectedView !== undefined && (!fileMounted.current || viewGeneration.current !== expectedView)) return
      loadedConversations.current.add(conversation.id)
      setBootstrap((state) => state && ({ ...state, conversations: [conversation, ...state.conversations] }))
      changeConversation(conversation.id)
      if (expectedView === undefined) setDraft('')
      followStream.current = true
      composerRef.current?.focus()
      return conversation
    } catch (cause) {
      setError(`无法新建对话：${errorMessage(cause)}`)
    }
  }

  async function send(content = draft, retryMessageId?: string) {
    const text = content.trim()
    const profileId = bootstrap?.settings.activeProfileId
    const model = effectiveModel(bootstrap?.profiles.find((item) => item.id === profileId), selectedModel)
    if ((!text && selectedFiles.length === 0) || !profileId || pendingRef.current || loadingMessages || selectingFiles) return
    pendingRef.current = true
    setBusy(true)
    setStopping(false)
    setError('')
    followStream.current = true
    const requestId = crypto.randomUUID()
    const sendingFiles = selectedFiles
    let sendingGeneration = fileGeneration.current
    let sendingView = viewGeneration.current
    const sendingDraft = draftGeneration.current
    try {
      let conversationId = currentId
      if (!conversationId) {
        conversationId = (await createConversation(sendingView))?.id ?? null
        if (!conversationId) return
        // This send owns the new view; subsequent user navigation still invalidates it.
        sendingView = viewGeneration.current
        sendingGeneration = fileGeneration.current
      }
      const input: SendMessageInput = { requestId, conversationId, profileId, ...(model ? { model } : {}), content: text || '请查看附件', ...(retryMessageId ? { retryMessageId } : {}), ...(!retryMessageId && sendingFiles.length ? { fileIds: sendingFiles.map(file => file.id) } : {}) }
      requestVersion.current++
      taskVersions.current.set(conversationId, (taskVersions.current.get(conversationId) ?? 0) + 1)
      requestRef.current = input
      setActiveRequest(input)
      if (!retryMessageId) {
        if (draftGeneration.current === sendingDraft) setDraft('')
        if (fileGeneration.current === sendingGeneration) setSelectedFiles([])
      }
      if (retryMessageId) eventMessages.current.delete(retryMessageId)
      const result = await window.her.sendMessage(input)
      setMessagesByConversation((previous) => {
        let list = previous[conversationId] ?? []
        list = upsert(list, result.userMessage)
        list = upsert(list, result.assistantMessage, eventMessages.current.has(result.assistantMessage.id))
        return { ...previous, [conversationId]: list }
      })
      setBootstrap((state) => {
        if (!state) return state
        const updated = state.conversations.find((item) => item.id === conversationId)
        if (!updated) return state
        const summary: ConversationSummary = { ...updated, title: updated.title === '新的对话' && !updated.titleCustom ? text.replace(/\s+/g, ' ').slice(0, 24) : updated.title, lastMessage: eventMessages.current.get(result.assistantMessage.id)?.content || text, updatedAt: result.userMessage.createdAt }
        return { ...state, conversations: [summary, ...state.conversations.filter((item) => item.id !== conversationId)] }
      })
    } catch (cause) {
      if (requestRef.current && requestRef.current.requestId !== requestId) return
      setError(`发送失败：${errorMessage(cause)} 请检查模型设置后重试。`)
      if (!retryMessageId && fileMounted.current && viewGeneration.current === sendingView) {
        if (draftGeneration.current === sendingDraft) setDraft((value) => value || text)
        if (fileGeneration.current === sendingGeneration) setSelectedFiles(sendingFiles)
      }
      requestRef.current = null
      setActiveRequest(null)
      setStopping(false)
      pendingRef.current = false
      setBusy(false)
    } finally {
      if (!requestRef.current) {
        pendingRef.current = false
        setBusy(false)
      }
    }
  }

  async function selectFiles(kind: 'file' | 'directory' = 'file', scope: 'conversation' | 'persistent' = 'conversation', dropped?: File[]) {
    let token = ++fileGeneration.current
    setSelectingFiles(true); setError('')
    let conversationId = currentIdRef.current
    const current = () => fileMounted.current && token === fileGeneration.current && currentIdRef.current === conversationId
    try {
      if (!conversationId) {
        const conversation = await window.her.createConversation()
        if (!current()) return
        loadedConversations.current.add(conversation.id)
        setBootstrap(state => state && ({ ...state, conversations: [conversation, ...state.conversations] }))
        conversationId = conversation.id
        changeConversation(conversationId)
        token = fileGeneration.current
        setSelectingFiles(true)
      }
      const result = dropped ? { files: await window.her.addDroppedFiles(conversationId, dropped) } : await window.her.selectFiles({ conversationId, kind, scope })
      if (!current()) return
      setSelectedFiles(previous => [...previous, ...result.files.filter(file => !previous.some(item => item.id === file.id))])
      setFileRevision(value => value + 1)
    } catch (cause) { if (current()) setError(errorMessage(cause)) }
    finally { if (current()) setSelectingFiles(false) }
  }

  async function revokeFileGrant(grant: FileGrant) {
    fileGeneration.current++
    setSelectingFiles(false)
    setRevokingGrants(previous => [...previous, grant.id])
    setSelectedFiles(previous => previous.filter(file => file.grantId !== grant.id))
    try {
      await window.her.revokeFileGrant(grant.id)
      if (fileMounted.current) { setRevokedGrants(previous => [...previous, grant.id]); setFileRevision(value => value + 1) }
    } finally { if (fileMounted.current) setRevokingGrants(previous => previous.filter(id => id !== grant.id)) }
  }

  function startRename() {
    const target = bootstrap?.conversations.find((item) => item.id === currentId)
    if (!target) return
    renameDone.current = false
    setRenaming({ id: target.id, title: target.title })
  }

  function cancelRename() {
    renameDone.current = true
    setRenaming(null)
  }

  async function commitRename() {
    if (renameDone.current || !renaming) return
    renameDone.current = true
    const { id, title } = renaming
    setRenaming(null)
    try {
      const updated = await window.her.renameConversation(id, title)
      setBootstrap((state) => state && ({ ...state, conversations: state.conversations.map((item) => item.id === id ? { ...item, title: updated.title, titleCustom: updated.titleCustom } : item) }))
    } catch (cause) { setError(`无法重命名：${errorMessage(cause)}`) }
  }

  async function trashConversation(id: string) {
    setError('')
    try { await window.her.trashConversation(id) }
    catch (cause) { setError(`无法删除对话：${errorMessage(cause)}`); return }
    loadedConversations.current.delete(id)
    setMessagesByConversation((previous) => {
      const { [id]: _removed, ...rest } = previous
      return rest
    })
    setBootstrap((state) => state && ({ ...state, conversations: state.conversations.filter((item) => item.id !== id) }))
    if (currentId === id) {
      changeConversation(bootstrap?.conversations.find((item) => item.id !== id)?.id ?? null)
      setDraft('')
      followStream.current = true
    }
  }

  async function continueCurrentTask() {
    const task = currentId ? tasks[currentId] : null
    const profileId = bootstrap?.settings.activeProfileId
    if (!task || !profileId || pendingRef.current) return
    const conversationId = task.conversationId
    const requestId = crypto.randomUUID()
    requestVersion.current++
    taskVersions.current.set(conversationId, (taskVersions.current.get(conversationId) ?? 0) + 1)
    requestRef.current = { requestId, conversationId }; setActiveRequest(requestRef.current)
    pendingRef.current = true; setBusy(true); setStopping(false); setError('')
    try {
      const result = await window.her.continueTask({ runId: task.run.id, requestId, profileId,
        model: effectiveModel(bootstrap?.profiles.find(item => item.id === profileId), selectedModel) })
      setMessagesByConversation(previous => ({ ...previous, [conversationId]: upsert(upsert(previous[conversationId] ?? [], result.userMessage, true), result.assistantMessage, eventMessages.current.has(result.assistantMessage.id)) }))
    } catch (cause) {
      if (requestRef.current && requestRef.current.requestId !== requestId) return
      setError(`继续失败：${errorMessage(cause)}`)
      if (requestRef.current?.requestId === requestId) { requestRef.current = null; setActiveRequest(null); pendingRef.current = false; setBusy(false); setStopping(false) }
    }
  }

  async function stop() {
    if (!activeRequest || stopping) return
    setStopping(true)
    try { await window.her.cancelMessage(activeRequest.requestId) }
    catch (cause) { setError(`停止失败：${errorMessage(cause)} 请再试一次。`); setStopping(false) }
  }

  if (!bootstrap) return <div className="startup"><HerMark /><h1>Her</h1>{bootError ? <><p role="alert">{bootError}</p><button className="primary-button" onClick={() => void loadBootstrap()}>重新加载</button></> : <p>正在打开我们的对话…</p>}</div>

  const activeProfile = bootstrap.profiles.find((item) => item.id === bootstrap.settings.activeProfileId)
  const currentModel = effectiveModel(activeProfile, selectedModel)
  const currentModelConfig = activeProfile?.models.find((entry) => entry.id === currentModel)
  const currentConversation = bootstrap.conversations.find((item) => item.id === currentId)
  const lastAssistantId = messages.findLast((item) => item.role === 'assistant')?.id
  const yesterday = new Date(calendarDay)
  yesterday.setDate(yesterday.getDate() - 1)
  const conversationGroups: { label: string; items: ConversationSummary[] }[] = [
    { label: '今天', items: [] }, { label: '昨天', items: [] }, { label: '更早', items: [] }
  ]
  for (const item of [...bootstrap.conversations].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))) {
    const day = new Date(item.updatedAt).toDateString()
    const index = day === calendarDay.toDateString() ? 0 : day === yesterday.toDateString() ? 1 : 2
    conversationGroups[index].items.push(item)
  }

  const queue = currentId ? queues[currentId] : null

  return <div className={`app-shell${resizingSidebar ? ' is-resizing' : ''}`}>
    <button className="icon-button sidebar-toggle" aria-label={sidebarHidden ? '显示侧栏' : '隐藏侧栏'} title={sidebarHidden ? '显示侧栏' : '隐藏侧栏'} aria-expanded={!sidebarHidden} aria-controls="conversation-sidebar" onClick={() => setSidebarHidden(hidden => !hidden)}><Icon name="sidebar" /></button>
    <aside id="conversation-sidebar" className="sidebar" aria-label="会话侧栏" hidden={sidebarHidden} style={{ width: sidebarWidth }} data-compact={sidebarWidth < 240}>
      <div className="brand"><HerMark /><div><span className="brand-name">Her<span className="brand-period">.</span></span><p>一点日常，一起想想。</p></div></div>
      <button className="new-chat" aria-label="新对话" onClick={() => { setSelectedModel(null); void createConversation() }}><Icon name="plus" />新对话<span className="new-chat-hint">开始一页</span></button>
      <div className="sidebar-section"><span>我们的对话</span><span>{bootstrap.conversations.length.toString().padStart(2, '0')}</span></div>
      <nav className="conversation-list" aria-label="对话列表">
        {bootstrap.conversations.length === 0 && <p className="sidebar-empty">留一点空间，<br />给接下来要说的话。</p>}
        {conversationGroups.filter(group => group.items.length > 0).map(group => <section key={group.label} className="conversation-group" aria-label={`${group.label}的对话`}>
          <h2 className="conversation-group-title"><button className="conversation-group-toggle" aria-expanded={!collapsedGroups[group.label]} aria-controls={`conversation-group-${group.label}`} onClick={() => setCollapsedGroups(previous => ({ ...previous, [group.label]: !previous[group.label] }))}>{group.label}<Icon name="chevron" /></button></h2>
          <div id={`conversation-group-${group.label}`} hidden={collapsedGroups[group.label]}>
          {group.items.map((item) => <div key={item.id} className="conversation-row">
          <button className={`conversation-item ${item.id === currentId ? 'selected' : ''}`} aria-label={item.title} aria-current={item.id === currentId ? 'page' : undefined} onClick={() => { changeConversation(item.id); setError(''); setDraft(''); followStream.current = true }}>
            <Icon name="chat" /><span><span className="conversation-heading"><strong>{item.title}</strong>{tasks[item.id] && <span className={`task-indicator ${tasks[item.id]!.state}`} title={tasks[item.id]!.state === 'running' ? '执行中' : tasks[item.id]!.state === 'approval' ? '等待确认' : tasks[item.id]!.state === 'paused' ? '已暂停' : '执行中'}>{tasks[item.id]!.state === 'running' ? '●' : tasks[item.id]!.state === 'approval' ? '!' : tasks[item.id]!.state === 'paused' ? '▌▌' : '●'}</span>}<time className="conversation-updated" dateTime={item.updatedAt} title={new Date(item.updatedAt).toLocaleString('zh-CN')}>{group.label === '更早' ? new Date(item.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : new Date(item.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></span><small>{conversationPreview(item.lastMessage)}</small></span>
          </button>
          <button className="conversation-delete" aria-label={`删除对话 ${item.title}`} onClick={() => void trashConversation(item.id)}><Icon name="trash" /></button>
          </div>)}
          </div>
        </section>)}
      </nav>
      <div className="sidebar-bottom"><div className="local-note"><span className="status-dot" />聊天记录保存在本机</div><button className="trash-button" aria-label="回收站" onClick={() => setTrashOpen(true)}><Icon name="trash" /><span>回收站</span></button><button className="settings-button" aria-label="设置" onClick={() => void openSettings()}><Icon name="settings" /><span>设置</span><span className="settings-version">v{bootstrap.appVersion}</span></button></div>
    </aside>
    <div className="sidebar-divider" role="separator" aria-label="调整侧栏宽度" aria-orientation="vertical" aria-controls="conversation-sidebar" aria-valuemin={200} aria-valuemax={sidebarMaxWidth} aria-valuenow={sidebarWidth} tabIndex={0} hidden={sidebarHidden}
      onPointerDown={event => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.focus()
        sidebarResize.current = { startX: event.clientX, width: sidebarWidth }
        event.currentTarget.setPointerCapture(event.pointerId)
        setResizingSidebar(true)
      }}
      onPointerMove={event => {
        if (!sidebarResize.current) return
        setSidebarWidth(Math.max(200, Math.min(sidebarWidthLimit(), sidebarResize.current.width + event.clientX - sidebarResize.current.startX)))
      }}
      onPointerUp={finishSidebarResize} onPointerCancel={finishSidebarResize} onLostPointerCapture={finishSidebarResize}
      onKeyDown={event => {
        const width = event.key === 'Home' ? 200 : event.key === 'End' ? sidebarMaxWidth : event.key === 'ArrowLeft' ? sidebarWidth - 16 : event.key === 'ArrowRight' ? sidebarWidth + 16 : null
        if (width === null) return
        event.preventDefault()
        setSidebarWidth(Math.max(200, Math.min(sidebarMaxWidth, width)))
      }} />

    <main className="chat-main">
      <header className="chat-header"><div className="chat-heading"><div className="chat-title"><p className="eyebrow">一段属于你的对话</p>{renaming ? <input className="title-input" aria-label="对话标题" autoFocus value={renaming.title} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setRenaming({ ...renaming, title: event.target.value })} onBlur={() => void commitRename()} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void commitRename() } else if (event.key === 'Escape') { event.preventDefault(); cancelRename() } }} /> : <div className="title-line"><h1>{currentConversation?.title || '新的开始'}</h1>{currentConversation && <button className="icon-button" aria-label="重命名对话" onClick={startRename}><Icon name="edit" /></button>}</div>}</div></div><div className="model-controls">
        <div className="model-pickers"><div className="model-picker"><span className={`status-dot ${activeProfile ? '' : 'offline'}`} /><select aria-label="当前模型服务" value={activeProfile?.id ?? ''} onChange={(event) => void selectProfile(event.target.value).catch((cause) => setError(`切换失败：${errorMessage(cause)}`))}><option value="" disabled>选择模型服务</option>{bootstrap.profiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><Icon name="chevron" /></div>{activeProfile && <div className="model-picker"><select aria-label="当前模型" value={currentModel} onChange={(event) => setSelectedModel(event.target.value)}>{activeProfile.models.map((entry) => <option key={entry.id} value={entry.id}>{entry.id}</option>)}</select><Icon name="chevron" /></div>}</div>
        {currentModelConfig && <details className="model-capabilities"><summary>工具{currentModelConfig.tests.tools.status === 'passed' ? '已验证' : currentModelConfig.tests.tools.status === 'failed' ? '未通过' : '尚未验证'} · 视觉{currentModelConfig.tests.vision.status === 'passed' ? '已验证' : currentModelConfig.tests.vision.status === 'failed' ? '未通过' : '尚未验证'}<Icon name="chevron" /></summary><p>能力不足时，请在设置中测试或切换模型。</p></details>}
      </div></header>

      <div className="chat-scroll" onScroll={(event) => { const area = event.currentTarget; followStream.current = area.scrollHeight - area.scrollTop - area.clientHeight < 100 }}>
        {loadingMessages ? <div className="chat-loading" role="status">正在接上这段对话…</div> : messages.length === 0 ? <section className="welcome">
          <div className="welcome-mark"><HerMark large /><span className="welcome-orbit orbit-one" /><span className="welcome-orbit orbit-two" /></div>
          <p className="eyebrow">HI, I'M HER</p><h2>{activeProfile ? '我在，慢慢说。' : '先为我们接上一个模型。'}</h2>
          <p>{activeProfile ? '今天的小事、没想通的问题，\n或者只是想找个人聊一会儿。' : '用你自己的服务地址、模型和密钥，\n让这段对话从这里开始。'}</p>
          {!activeProfile && <button className="primary-button" onClick={() => void openSettings()}>配置模型服务<Icon name="arrow" /></button>}
          {activeProfile && <div className="welcome-footnote"><span />不必组织好语言，我们可以一起理清楚。<span /></div>}
        </section> : <>
        {queue && queue.items.length > 0 && <div className="queued-messages" role="status" aria-label="排队中的消息">{queue.items.map(item => <div key={item.requestId} className="queued-message"><span className="queued-indicator">●</span><span className="queued-preview">{item.preview}</span><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div>)}{queue.paused && <div className="queue-paused">{queue.paused === 'stopped' ? '已停止' : queue.paused === 'failed' ? '任务失败' : queue.paused === 'limit' ? '达到限制' : queue.paused === 'source-revoked' ? '来源已撤销' : queue.paused === 'unknown-action' ? '未知动作' : queue.paused === 'compaction-stopped' ? '压缩已停止' : queue.paused === 'compaction-failed' ? '压缩失败' : '等待重启'}</div>}{queue.compacting && <div className="queue-compacting">正在压缩上下文…</div>}</div>}
        <div className="messages" aria-label="聊天消息">{messages.map((message, index) => {
          const previousUser = messages.slice(0, index).findLast((item) => item.role === 'user')
          const retryable = !message.toolCalls?.length && message.id === lastAssistantId && ['failed', 'cancelled'].includes(message.status) && previousUser
          return <article key={message.id} className={`message message-${message.role}`} data-status={message.status}>
            <div className="message-identity"><div className="message-avatar" role="img" aria-label={message.role === 'assistant' ? 'Her' : '你'}>{message.role === 'assistant' ? <HerMark /> : '你'}</div><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div>
            <div className="message-body">
              {message.role === 'user' ? (
                <>
                  <p className="user-text">{message.content}</p>
                  {message.attachments && message.attachments.length > 0 && (
                    <div className="message-attachments">
                      {message.attachments.map((attachment, i) => (
                        <div key={i} className="message-attachment">
                          {attachment.type === 'image' ? (
                            <img src={`data:${attachment.mimeType};base64,${attachment.data}`} alt={attachment.name} />
                          ) : (
                            <div className="attachment-file">
                              <span className="attachment-icon">{attachment.type === 'audio' ? '🎵' : attachment.type === 'video' ? '🎬' : '📄'}</span>
                              <span className="attachment-name">{attachment.name}</span>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : <>{message.toolCalls && message.toolCalls.length > 0 && <details className="tool-calls">
                <summary>工具记录：{message.toolCalls.length} 个步骤</summary>
                {message.toolCalls.map((call) => <div key={call.id} className="tool-call">
                  <div className="tool-call-name">{call.name} · {call.status ?? '历史状态未知'}</div>
                  <pre>{JSON.stringify(call.arguments)}</pre>
                  <pre>{typeof call.result === 'string' ? call.result : call.result ? JSON.stringify(call.result, null, 2) : '执行中…'}</pre>{call.result && typeof call.result !== 'string' && call.result.content.map((block, index) => block.type === 'image' ? <ArtifactPreview key={`${message.conversationId}:${block.artifactId}:${index}:${revokedGrants.length}:${revokingGrants.length}`} id={block.artifactId} conversationId={message.conversationId} /> : null)}
                </div>)}
              </details>}<div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ alt }) => <span className="image-description">{alt || '图片'}</span>, a: ({ href, children }) => <a href={href && /^https?:\/\//i.test(href) ? href : undefined} onClick={(event) => { event.preventDefault(); if (href && /^https?:\/\//i.test(href)) void window.her.openExternal(href).catch((cause) => setError(`无法打开链接：${errorMessage(cause)}`)) }}>{children}</a> }}>{message.content}</ReactMarkdown></div></>}
              <DocumentSources key={`${message.id}:${fileRevision}`} message={message} unavailable={revokedGrants} pending={revokingGrants} unavailableFileIds={messages.flatMap(item => item.files ?? []).filter(file => revokedGrants.includes(file.grantId) || revokingGrants.includes(file.grantId)).map(file => file.id)} />
              {message.status === 'streaming' && <div className="stream-status" role="status"><span className="thinking-dots"><i /><i /><i /></span>{message.content ? '正在写…' : 'Her 正在想…'}</div>}
              {message.status === 'failed' && <p className="message-error">{message.error || '回答未完成。请检查模型服务后重试。'}</p>}
              {message.status === 'cancelled' && <p className="message-interrupted">已停止，已生成的内容保留在这里。</p>}
              {(retryable || message.status === 'failed') && <div className="message-actions">{retryable && <button className="retry-button" disabled={busy} onClick={() => void send(previousUser.content, message.id)}><Icon name="retry" />{message.status === 'failed' ? '重试' : '重新生成'}</button>}{message.status === 'failed' && <button className="retry-button settings-link" onClick={() => void openSettings(message.profileId)}><Icon name="settings" />检查模型设置</button>}</div>}
            </div>
          </article>
        })}</div>
        {busy && !messages.some((item) => item.status === 'streaming') && activeRequest?.conversationId === currentId && <div className="pending-message" role="status"><span className="thinking-dots"><i /><i /><i /></span>正在连接模型…</div>}
        <div ref={bottomRef} />
      </>}
      </div>

      <div className="composer-area" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDrop={event => { event.preventDefault(); const dropped = Array.from(event.dataTransfer.files); if (dropped.length) void selectFiles('file', 'conversation', dropped) }}>
        {currentId && tasks[currentId] && <TaskStatus key={`${tasks[currentId]!.run.id}:${tasks[currentId]!.approval?.id ?? ''}`} task={tasks[currentId]!} message={messages.find(item => item.id === tasks[currentId]!.run.assistantMessageId)} canContinue={!busy && !!activeProfile && tasks[currentId]!.run.assistantMessageId === messages.at(-1)?.id && ['paused', 'stopped', 'failed'].includes(tasks[currentId]!.run.status)} onContinue={() => void continueCurrentTask()} onStop={() => void stop()} />}
        {error && <div className="error-banner" role="alert"><span>{error}</span>{messageLoadFailed && <button onClick={() => { setError(''); setLoadAttempt((attempt) => attempt + 1) }}>重试加载</button>}<button aria-label="关闭错误提示" onClick={() => setError('')}><Icon name="close" /></button></div>}
        {busy && activeRequest?.conversationId !== currentId && <p className="generation-note">Her 正在另一段对话中回答。你可以先写下想说的话。</p>}
        {selectedFiles.length > 0 && <div className="attachments-preview">{selectedFiles.map(file => <div className="attachment-item file-chip" key={file.id}>
          {file.mimeType.startsWith('image/') && currentId && <FilePreview key={`${currentId}:${file.id}:${fileRevision}`} file={file} conversationId={currentId} />}
          <span>{file.name}</span><button type="button" onClick={() => { fileGeneration.current++; setSelectingFiles(false); setSelectedFiles(previous => previous.filter(item => item.id !== file.id)) }} aria-label={`移除 ${file.name}`}>×</button>
        </div>)}</div>}
        {currentId && <FileAccessPanel key={currentId} conversationId={currentId} refreshKey={fileRevision} onRevoke={revokeFileGrant} />}
        {selectingFiles && <p role="status">正在添加资料…</p>}
        <form className="composer" onSubmit={(event) => { event.preventDefault(); void send() }}>
          <div className="composer-input-wrapper">
            <textarea ref={composerRef} aria-label="消息" placeholder={activeProfile ? '想说点什么？' : '配置模型服务后，就可以开始聊天了'} value={draft} rows={2} disabled={!activeProfile} onChange={(event) => { draftGeneration.current++; setDraft(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); void send() } }} />
            <div className="composer-actions">
              <button type="button" className="attach-button" aria-label="添加资料" title="添加图片或文档" disabled={selectingFiles} onClick={() => void selectFiles()}><Icon name="paperclip" /></button>
              <details className="directory-picker"><summary>授权目录</summary><button type="button" disabled={selectingFiles} onClick={() => void selectFiles('directory')}>仅本次对话</button><button type="button" disabled={selectingFiles} onClick={() => void selectFiles('directory', 'persistent')}>长期授权</button></details>
              {activeRequest ? (
                <button type="button" className="send-button stop" aria-label="停止生成" disabled={stopping} onClick={() => void stop()}>
                  <span className="stop-square" />
                </button>
              ) : (
                <button type="submit" className="send-button" aria-label="发送" disabled={(!draft.trim() && selectedFiles.length === 0) || !activeProfile || busy || loadingMessages || selectingFiles}>
                  <Icon name="arrow" />
                </button>
              )}
            </div>
          </div>
          <div className="composer-bottom"><span className="composer-hint">Enter 发送 · Shift + Enter 换行{activeProfile && selectedModel ? ` · ${selectedModel}` : ''}</span></div>
        </form>
      </div>
    </main>

    {trashOpen && <TrashPanel onClose={() => { setTrashOpen(false); composerRef.current?.focus() }} onRestored={(restored) => setBootstrap((state) => state && ({ ...state, conversations: [...state.conversations.filter((item) => item.id !== restored.id), restored].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }))} />}
    {settingsOpen && <SettingsPanel profiles={bootstrap.profiles} settings={bootstrap.settings} initialProfileId={settingsProfileId} dataDirectory={bootstrap.dataDirectory} onRevokeFileGrant={revokeFileGrant} onClose={() => { setSettingsOpen(false); composerRef.current?.focus() }} onConfigurationChanged={refreshConfiguration} onSelectProfile={selectProfile} />}
  </div>
}
