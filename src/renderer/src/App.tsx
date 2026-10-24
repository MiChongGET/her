import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Appearance, BootstrapState, ChatMessage, ConversationQueueState, ConversationSummary, FileReference, FileGrant, ProviderProfile, SendMessageInput, TaskEvent, WorkspaceSnapshot, WorkspaceSelection, PendingActionNotice } from '../../shared/types'
import WorkspaceNavigation from './WorkspaceNavigation'
import TopicList from './TopicList'
import MemoryUnavailable from './MemoryUnavailable'
import TopicHandoffDialog, { type HandoffResume } from './TopicHandoffDialog'
import type { ConversationDraft } from './conversation-drafts'
import ConversationUsage from './ConversationUsage'
import TaskStatus, { ArtifactPreview, DelegationCards } from './TaskStatus'
import FileAccessPanel from './FileAccessPanel'
import DocumentSources, { FilePreview } from './DocumentSources'
import SettingsPanel from './SettingsPanel'
import TrashPanel from './TrashPanel'
import { Icon, HerMark, SamanthaAvatar } from './Visuals'

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

function sidebarWidthLimit() {
  return Math.max(200, Math.min(360, window.innerWidth - 520))
}

export default function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null)
  const [bootError, setBootError] = useState('')
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null)
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const dailyIdRef = useRef<string | null>(null)
  const nativeReady = useRef(false)
  const nativeOpening = useRef(false)
  const nativeOpenAgain = useRef<number | null>(null)
  const openPendingRef = useRef<(notice: PendingActionNotice, nativeRequest?: number) => Promise<'opened' | 'stale' | 'superseded' | 'failed'>>(async () => 'failed')
  const [overview, setOverview] = useState<PendingActionNotice[]>([])
  const [pendingLoaded, setPendingLoaded] = useState(false)
  const [pendingReadFailed, setPendingReadFailed] = useState(false)
  const selectionVersion = useRef<number | null>(null)
  const selectionRequest = useRef(0)
  const selectionRef = useRef<WorkspaceSelection>({ section: 'daily' })
  const pendingVersion = useRef(0)
  async function refreshPending() {
    const version = pendingVersion.current
    setPendingLoaded(false); setPendingReadFailed(false)
    try {
      const notices = await window.her.getPendingActions()
      if (version === pendingVersion.current) { setOverview(notices); setPendingLoaded(true) }
    } catch {
      if (version === pendingVersion.current) { setPendingReadFailed(true); setPendingLoaded(true) }
    }
  }
  const scrollRef = useRef<HTMLDivElement>(null)
  const dailyScroll = useRef<{ top: number; following: boolean } | null>(null)
  const restoreDailyScroll = useRef(false)
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [messagesByConversation, setMessagesByConversation] = useState<Record<string, ChatMessage[]>>({})
  const [tasks, setTasks] = useState<Record<string, TaskEvent | null>>({})
  const [queues, setQueues] = useState<Record<string, ConversationQueueState>>({})
  const [queueReadFailed, setQueueReadFailed] = useState<Record<string, boolean>>({})
  const [queueTick, setQueueTick] = useState(0)
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [messageLoadFailed, setMessageLoadFailed] = useState(false)
  const [refreshingMessages, setRefreshingMessages] = useState(false)
  const [staleMessages, setStaleMessages] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [draft, setDraft] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<FileReference[]>([])
  const drafts = useRef(new Map<string, ConversationDraft>())
  const draftFailures = useRef(new Map<string, string>())
  const [invalidDraftFiles, setInvalidDraftFiles] = useState<string[]>([])
  const [validatingDraftFiles, setValidatingDraftFiles] = useState(false)
  const [selectingFiles, setSelectingFiles] = useState(false)
  const [fileRevision, setFileRevision] = useState(0)
  const [fileAccessOpenFor, setFileAccessOpenFor] = useState<string | null>(null)
  const [revokedGrants, setRevokedGrants] = useState<string[]>([])
  const [revokingGrants, setRevokingGrants] = useState<string[]>([])
  const fileGeneration = useRef(0)
  const viewGeneration = useRef(0)
  const draftGeneration = useRef(0)
  const textGeneration = useRef(0)
  const currentIdRef = useRef<string | null>(null)
  const fileMounted = useRef(true)
  useEffect(() => { fileMounted.current = true; return () => { fileMounted.current = false; fileGeneration.current++ } }, [])
  const requestsByConversation = useRef(new Map<string, Pick<SendMessageInput, 'requestId' | 'conversationId'>>())
  const submitting = useRef(new Map<string, string>())
  function refreshCurrentRequest() {
    requestRef.current = currentIdRef.current ? requestsByConversation.current.get(currentIdRef.current) ?? null : null
    setActiveRequest(requestRef.current); pendingRef.current = !!requestRef.current; setBusy(!!requestRef.current); setStopping(false)
  }
  function markRunning(request: Pick<SendMessageInput, 'requestId' | 'conversationId'>) {
    requestsByConversation.current.set(request.conversationId, request)
    if (request.conversationId === currentIdRef.current) refreshCurrentRequest()
  }
  function markFinished(request: Pick<SendMessageInput, 'requestId' | 'conversationId'>) {
    if (requestsByConversation.current.get(request.conversationId)?.requestId === request.requestId) requestsByConversation.current.delete(request.conversationId)
    for (const [key, requestId] of submitting.current) if (requestId === request.requestId) submitting.current.delete(key)
    if (request.conversationId === currentIdRef.current) refreshCurrentRequest()
  }
  function changeConversation(id: string | null) {
    viewGeneration.current++; fileGeneration.current++; currentIdRef.current = id
    setCurrentId(id); setSelectedFiles([]); setInvalidDraftFiles([]); setSelectingFiles(false); setFileAccessOpenFor(null); refreshCurrentRequest()
  }

  function saveDraft() {
    const id = currentIdRef.current
    if (!id) return
    drafts.current.set(id, { text: draft, files: selectedFiles, revision: draftGeneration.current,
      scroll: scrollRef.current ? { top: scrollRef.current.scrollTop, following: followStream.current } : undefined })
  }

  async function restoreDraft(id: string, view: number) {
    const saved = drafts.current.get(id)
    const failure = draftFailures.current.get(id)
    if (failure) setError(failure)
    const fileVersion = fileGeneration.current
    draftGeneration.current = saved?.revision ?? draftGeneration.current + 1
    setDraft(saved?.text ?? '')
    setSelectedFiles(saved?.files ?? [])
    if (saved?.scroll) {
      followStream.current = saved.scroll.following
      requestAnimationFrame(() => { if (view === viewGeneration.current && scrollRef.current) scrollRef.current.scrollTop = saved.scroll!.top })
    }
    if (!saved?.files.length) return
    setValidatingDraftFiles(true)
    try {
      const result = await window.her.validateDraftFiles({ conversationId: id, fileIds: saved.files.map(file => file.id) })
      if (view !== viewGeneration.current || fileGeneration.current !== fileVersion || drafts.current.get(id)?.revision !== saved.revision) return
      setInvalidDraftFiles(result.invalidIds)
    } catch (cause) {
      if (view === viewGeneration.current && fileGeneration.current === fileVersion) { setInvalidDraftFiles(saved.files.map(file => file.id)); setError(`无法核对草稿资料：${errorMessage(cause)}`) }
    } finally { if (view === viewGeneration.current) setValidatingDraftFiles(false) }
  }
  const [error, setError] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [avatarPreviewOpen, setAvatarPreviewOpen] = useState(false)
  const avatarTriggerRef = useRef<HTMLButtonElement>(null)
  const avatarCloseRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (avatarPreviewOpen) avatarCloseRef.current?.focus() }, [avatarPreviewOpen, currentId])
  function closeAvatarPreview() {
    setAvatarPreviewOpen(false)
    avatarTriggerRef.current?.focus()
  }
  const panelTrigger = useRef<HTMLElement | null>(null)
  function rememberPanelTrigger() {
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const menu = active?.closest('details.sidebar-more') as HTMLDetailsElement | null
    panelTrigger.current = menu?.querySelector('summary') ?? active
    if (menu) menu.open = false
  }
  const [handoffOpen, setHandoffOpen] = useState(false)
  const handoffOpenRef = useRef(false)
  const handoffResume = useRef<HandoffResume | null>(null)
  const handoffView = useRef(0)
  const [settingsProfileId, setSettingsProfileId] = useState<string | undefined>()
  const [sidebarHidden, setSidebarHidden] = useState(false)
  const [sidebarMaxWidth, setSidebarMaxWidth] = useState(sidebarWidthLimit)
  const [sidebarWidth, setSidebarWidth] = useState(() => Math.min(sidebarWidthLimit(), window.innerWidth >= 1280 ? 240 : 200))
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
  const bottomRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const attachmentMenuRef = useRef<HTMLDetailsElement>(null)
  const fileAccessRef = useRef<HTMLDivElement>(null)
  const followStream = useRef(true)
  useEffect(() => { if (fileAccessOpenFor === currentId) fileAccessRef.current?.querySelector<HTMLButtonElement>('.file-access-close')?.focus() }, [fileAccessOpenFor, currentId])

  function clearSelection(preserveDraft = false) {
    saveDraft()
    if (selectionRef.current.section === 'daily' && scrollRef.current) dailyScroll.current = { top: scrollRef.current.scrollTop, following: followStream.current }
    selectionVersion.current = null
    changeConversation(null)
    setWorkspace(null); setConversations([]); setMessagesByConversation({}); setTasks({}); setQueues({})
    requestsByConversation.current.clear(); eventMessages.current.clear(); eventSequences.current.clear()
    setRenaming(null); if (!preserveDraft) setDraft(''); setError(''); setMessageLoadFailed(false); setRefreshingMessages(false); setStaleMessages(false); setLoadingMessages(true)
  }

  function applySnapshot(snapshot: WorkspaceSnapshot, preserveView = false) {
    selectionVersion.current = snapshot.version
    selectionRef.current = snapshot.selection
    setWorkspace(snapshot)
    setConversations(snapshot.workItems.map(item => item.conversation))
    const id = snapshot.conversation?.id ?? null
    if (!preserveView) {
      changeConversation(id)
      if (id) void restoreDraft(id, viewGeneration.current)
    }
    setMessagesByConversation(id ? { [id]: snapshot.messages } : {})
    setTasks(id ? { [id]: snapshot.task } : {})
    if (snapshot.task) receiveTask(snapshot.task)
    if (snapshot.activeRequest && !completedRequests.current.has(snapshot.activeRequest.requestId)) markRunning(snapshot.activeRequest)
    followStream.current = snapshot.selection.section === 'daily' ? dailyScroll.current?.following ?? true : true
    restoreDailyScroll.current = snapshot.selection.section === 'daily' && dailyScroll.current !== null
    setLoadingMessages(false)
    setRefreshingMessages(false)
    setStaleMessages(false)
    setQueueTick(tick => tick + 1)
  }

  async function selectWorkspace(selection: WorkspaceSelection): Promise<'opened' | 'superseded' | 'failed'> {
    const request = ++selectionRequest.current
    const samePage = !!workspace && selection.section === workspace.selection.section &&
      (selection.conversationId ?? (selection.section === 'daily' ? dailyIdRef.current : undefined)) === workspace.selection.conversationId
    if (samePage) {
      selectionVersion.current = null
      setRefreshingMessages(true)
      setError('')
    } else { handoffOpenRef.current = false; setHandoffOpen(false); clearSelection() }
    selectionRef.current = selection
    try {
      const snapshot = await window.her.selectWorkspace(selection)
      if (!fileMounted.current) return 'failed'
      if (request !== selectionRequest.current) return 'superseded'
      applySnapshot(snapshot, samePage)
      return 'opened'
    } catch (cause) {
      if (request !== selectionRequest.current) return 'superseded'
      if (samePage) {
        setRefreshingMessages(false)
        setStaleMessages(true)
        setError(`无法更新这段对话：${errorMessage(cause)}`)
      } else {
        setLoadingMessages(false); setMessageLoadFailed(true); setError(`无法读取这段对话：${errorMessage(cause)}`)
      }
      return 'failed'
    }
  }

  async function refreshWorkItems() {
    if (selectionRef.current.section !== 'work' || selectionVersion.current === null) return
    const request = ++selectionRequest.current
    try {
      const workItems = await window.her.listWorkItems()
      if (!fileMounted.current || request !== selectionRequest.current) return
      setWorkspace(state => state && ({ ...state, workItems }))
      setConversations(workItems.map(item => item.conversation))
    } catch (cause) {
      if (request === selectionRequest.current) setError(`无法刷新工作列表：${errorMessage(cause)}`)
    }
  }

  async function openPending(notice: PendingActionNotice, nativeRequest?: number): Promise<'opened' | 'stale' | 'superseded' | 'failed'> {
    const request = nativeRequest ?? selectionRequest.current
    if (request !== selectionRequest.current) return 'superseded'
    try {
      const target = await window.her.resolvePendingAction({ id: notice.id, version: notice.version })
      if (request !== selectionRequest.current) return 'superseded'
      if (target) {
        // Only this native selection owns the next increment; user navigation never rebases a queued click.
        if (nativeRequest !== undefined && nativeOpenAgain.current === request) nativeOpenAgain.current = request + 1
        return await selectWorkspace({ section: target.conversationId === dailyIdRef.current ? 'daily' : 'work', conversationId: target.conversationId })
      }
      setError('这件事的状态已更新。')
      setOverview(previous => previous.filter(item => item.id !== notice.id || item.version !== notice.version))
      return 'stale'
    } catch (cause) {
      if (request !== selectionRequest.current) return 'superseded'
      setError(errorMessage(cause))
      return 'failed'
    }
  }

  openPendingRef.current = openPending
  async function drainNativeOpen() {
    if (!nativeReady.current || !fileMounted.current) return
    let request = selectionRequest.current
    if (nativeOpening.current) { nativeOpenAgain.current = request; return }
    nativeOpening.current = true
    try {
      do {
        nativeOpenAgain.current = null
        try {
          const notice = await window.her.getPendingActionOpen()
          if (!fileMounted.current) return
          if (notice) {
            const outcome = await openPendingRef.current(notice, request)
            if (!fileMounted.current) return
            // A delayed read may already hold the newer queued click; let its own wakeup re-read it.
            if (outcome !== 'failed' && (outcome !== 'superseded' || nativeOpenAgain.current === null)) {
              await window.her.ackPendingActionOpen({ id: notice.id, version: notice.version })
            }
          }
        } catch { /* Retain the failed click; a newer queued wakeup can still be handled. */ }
        if (nativeOpenAgain.current !== null) request = nativeOpenAgain.current
      } while (nativeOpenAgain.current !== null)
    } finally { nativeOpening.current = false }
  }

  const loadBootstrap = useCallback(async () => {
    setBootError('')
    try {
      const state = await window.her.getBootstrap()
      if (!fileMounted.current) return
      dailyIdRef.current = state.dailyConversationId
      setBootstrap(state)
      await selectWorkspace({ section: 'daily' })
      nativeReady.current = true
      void drainNativeOpen()
      return state
    } catch (cause) { setBootError(`无法读取本地数据：${errorMessage(cause)}`) }
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
    rememberPanelTrigger()
    try { await refreshConfiguration(); setSettingsProfileId(profileId); setSettingsOpen(true) }
    catch { /* The configuration refresh displays the error. */ }
  }

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

  const eventSequences = useRef(new Map<string, number>())
  function acceptEvent(event: { conversationId: string; runId?: string; seq?: number }): boolean {
    if (!event.runId || event.seq === undefined) return true
    const key = `${event.conversationId}:${event.runId}`
    if (event.seq <= (eventSequences.current.get(key) ?? 0)) return false
    eventSequences.current.set(key, event.seq)
    return true
  }

  const receiveTask = useCallback((task: TaskEvent) => {
    if (completedRequests.current.has(task.requestId) && ['running', 'awaiting_confirmation', 'waiting_approval', 'waiting_resource', 'compacting', 'retrying', 'stopping'].includes(task.run.status)) return

    setTasks(previous => ({ ...previous, [task.conversationId]: task }))
    if (['running', 'awaiting_confirmation', 'waiting_approval', 'waiting_resource', 'compacting', 'retrying', 'stopping'].includes(task.run.status)) markRunning(task)
    else markFinished(task)
  }, [])

  useEffect(() => {
    let subscribed = true
    const unsubscribeRequest = window.her.onWorkspaceRequestEvent(({ selectionVersion: version, event }) => {
      if (version !== selectionVersion.current || event.conversationId !== currentIdRef.current || !acceptEvent(event)) return
      setQueueTick(tick => tick + 1)

      if (event.state === 'started') {
        if (!completedRequests.current.has(event.requestId)) markRunning(event)
      } else {
        completedRequests.current.add(event.requestId)
        const currentRequest = requestsByConversation.current.get(event.conversationId)
        const relevant = !currentRequest || currentRequest.requestId === event.requestId
        markFinished(event)
        if (relevant && event.error && event.conversationId === currentIdRef.current) setError(event.error)
      }
    })
    const unsubscribe = window.her.onWorkspaceChatEvent(({ selectionVersion: version, event }) => {
      if (version !== selectionVersion.current || event.conversationId !== currentIdRef.current || !acceptEvent(event)) return
      if (completedRequests.current.has(event.requestId)) return
      eventMessages.current.set(event.message.id, event.message)
      setMessagesByConversation((previous) => ({ ...previous, [event.conversationId]: upsert(previous[event.conversationId] ?? [], event.message) }))
      setConversations(previous => previous.map(item => item.id === event.conversationId ? { ...item, lastMessage: event.message.content, updatedAt: event.message.createdAt } : item))
      if (event.done) {
        completedRequests.current.add(event.requestId)
        markFinished(event)
      }
    })
    const unsubscribeTask = window.her.onWorkspaceTaskEvent(({ selectionVersion: version, event }) => {
      if (version !== selectionVersion.current || event.conversationId !== currentIdRef.current) return
      // Task envelopes can share a sequence with their chat envelope.
      const key = `task:${event.conversationId}:${event.runId ?? event.run.id}`
      if (event.seq !== undefined && event.seq <= (eventSequences.current.get(key) ?? 0)) return
      if (event.seq !== undefined) eventSequences.current.set(key, event.seq)
      receiveTask(event)
      setQueueTick(tick => tick + 1)
    })
    const unsubscribeNativeOpen = window.her.onPendingActionOpen(() => { void drainNativeOpen() })
    const unsubscribePending = window.her.onPendingActions(notices => { pendingVersion.current++; setOverview(notices); setPendingLoaded(true); setPendingReadFailed(false) })
    void refreshPending()
    void loadBootstrap()
    return () => { subscribed = false; pendingVersion.current++; unsubscribeRequest(); unsubscribe(); unsubscribeTask(); unsubscribePending(); unsubscribeNativeOpen(); nativeReady.current = false }
  }, [loadBootstrap, receiveTask])

  useEffect(() => {
    if (loadAttempt > 0) void selectWorkspace(selectionRef.current)
  }, [loadAttempt])

  const activeProfileId = bootstrap?.settings.activeProfileId ?? null
  useEffect(() => { setSelectedModel(null) }, [activeProfileId])

  const messages = currentId ? messagesByConversation[currentId] ?? [] : []
  useLayoutEffect(() => {
    if (currentId && selectionVersion.current !== null) composerRef.current?.focus()
  }, [currentId])
  useEffect(() => {
    if (!currentId) return
    let live = true
    void window.her.getQueue(currentId).then(state => { if (live) { setQueues(previous => ({ ...previous, [currentId]: state })); setQueueReadFailed(previous => ({ ...previous, [currentId]: false })) } })
      .catch(() => { if (live) setQueueReadFailed(previous => ({ ...previous, [currentId]: true })) })
    return () => { live = false }
  }, [currentId, queueTick])
  useLayoutEffect(() => {
    if (restoreDailyScroll.current && scrollRef.current && dailyScroll.current) {
      scrollRef.current.scrollTop = dailyScroll.current.top
      restoreDailyScroll.current = false
      return
    }
    if (followStream.current) bottomRef.current?.scrollIntoView?.({ behavior: 'auto' })
  }, [messages, currentId, busy])

  async function selectProfile(id: string) {
    await window.her.selectProfile(id)
    await refreshConfiguration()
  }

  async function createConversation(expectedView?: number) {
    setError('')
    const request = ++selectionRequest.current
    try {
      clearSelection(expectedView !== undefined)
      const snapshot = await window.her.createConversation()
      if (!fileMounted.current || request !== selectionRequest.current) return
      applySnapshot(snapshot)
      if (expectedView === undefined) setDraft('')
      followStream.current = true
      composerRef.current?.focus()
      return snapshot.conversation ?? undefined
    } catch (cause) {
      if (request === selectionRequest.current) { setLoadingMessages(false); setError(`无法新建对话：${errorMessage(cause)}`) }
    }
  }

  async function send(content = draft, retryMessageId?: string) {
    const text = content.trim()
    const profileId = bootstrap?.settings.activeProfileId
    const model = effectiveModel(bootstrap?.profiles.find((item) => item.id === profileId), selectedModel)
    if ((!text && selectedFiles.length === 0) || !profileId || submitting.current.has(currentId ?? 'new') || loadingMessages || messageLoadFailed || refreshingMessages || staleMessages || !workspace || selectingFiles || validatingDraftFiles || invalidDraftFiles.length > 0) return
    const requestId = crypto.randomUUID()
    const submissionKey = currentId ?? 'new'
    submitting.current.set(submissionKey, requestId)
    pendingRef.current = true
    setBusy(true)
    setStopping(false)
    setError('')
    followStream.current = true
    const sendingFiles = selectedFiles
    let sendingGeneration = fileGeneration.current
    let sendingView = viewGeneration.current
    const sendingDraft = textGeneration.current
    const sendingRevision = draftGeneration.current
    const originalDraft = draft
    let conversationId = currentId
    try {
      if (!conversationId) {
        conversationId = (await createConversation(sendingView))?.id ?? null
        if (!conversationId) return
        // This send owns the new view; subsequent user navigation still invalidates it.
        sendingView = viewGeneration.current
        sendingGeneration = fileGeneration.current
      }
      const sentConversationId = conversationId
      const input: SendMessageInput = { requestId, conversationId, profileId, ...(model ? { model } : {}), content: text || '请查看附件', ...(!text ? { attachmentOnly: true } : {}), ...(retryMessageId ? { retryMessageId } : {}), ...(!retryMessageId && sendingFiles.length ? { fileIds: sendingFiles.map(file => file.id) } : {}) }
      draftFailures.current.delete(conversationId)

      if (!requestsByConversation.current.has(conversationId)) markRunning(input)
      if (!retryMessageId) {
        if (textGeneration.current === sendingDraft) setDraft('')
        if (fileGeneration.current === sendingGeneration) setSelectedFiles([])
      }
      if (retryMessageId) eventMessages.current.delete(retryMessageId)
      const result = await window.her.sendMessage(input)
      if (result.controlId && requestsByConversation.current.get(conversationId)?.requestId === requestId) markFinished(input)
      if (currentIdRef.current !== conversationId || viewGeneration.current !== sendingView) return
      setQueueTick(tick => tick + 1)
      if (result.queued) {
        const task = await window.her.getConversationTask(conversationId)
        if (viewGeneration.current !== sendingView) return
        if (task) receiveTask(task)
        else markFinished(input)
        refreshCurrentRequest()
        return
      }
      setMessagesByConversation((previous) => {
        let list = previous[sentConversationId] ?? []
        list = upsert(list, result.userMessage)
        list = upsert(list, result.assistantMessage, eventMessages.current.has(result.assistantMessage.id))
        return { ...previous, [sentConversationId]: list }
      })
      const updateSummary = (updated: ConversationSummary): ConversationSummary => ({ ...updated,
        title: text && workspace?.topic?.kind === 'work' && ['新的对话', '新对话'].includes(updated.title) && !updated.titleCustom ? Array.from(text.replace(/\s+/gu, ' ')).slice(0, 24).join('') : updated.title,
        lastMessage: eventMessages.current.get(result.assistantMessage.id)?.content || text, updatedAt: result.userMessage.createdAt })
      setWorkspace(state => state?.conversation?.id === conversationId ? { ...state, conversation: updateSummary(state.conversation) } : state)
      setConversations(previous => previous.map(item => item.id === conversationId ? updateSummary(item) : item))
    } catch (cause) {
      if (!retryMessageId && conversationId && fileMounted.current) {
        const failure = `发送失败：${errorMessage(cause)} 请检查模型设置后重试。`
        draftFailures.current.set(conversationId, failure)
        const saved = drafts.current.get(conversationId)
        if (saved && saved.revision === sendingRevision && !saved.text && saved.files.length === 0) {
          drafts.current.set(conversationId, { ...saved, text: originalDraft, files: sendingFiles })
          if (currentIdRef.current === conversationId && viewGeneration.current !== sendingView) void restoreDraft(conversationId, viewGeneration.current)
        }
      }
      if (viewGeneration.current !== sendingView) return
      if (requestRef.current && requestRef.current.requestId !== requestId) return
      if (currentId) markFinished({ conversationId: currentId, requestId })
      setError(`发送失败：${errorMessage(cause)} 请检查模型设置后重试。`)
      if (!retryMessageId && fileMounted.current && viewGeneration.current === sendingView) {
        if (textGeneration.current === sendingDraft) setDraft((value) => value || text)
        if (fileGeneration.current === sendingGeneration) setSelectedFiles(sendingFiles)
      }
      requestRef.current = null
      setActiveRequest(null)
      setStopping(false)
      pendingRef.current = false
      setBusy(false)
    } finally {
      if (submitting.current.get(submissionKey) === requestId) submitting.current.delete(submissionKey)
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
        const snapshot = await window.her.createConversation()
        if (!current()) return
        applySnapshot(snapshot)
        conversationId = snapshot.conversation!.id
        token = fileGeneration.current
        setSelectingFiles(true)
      }
      const result = dropped ? { files: await window.her.addDroppedFiles(conversationId, dropped) } : await window.her.selectFiles({ conversationId, kind, scope })
      if (!current()) return
      draftGeneration.current++
      setSelectedFiles(previous => [...previous, ...result.files.filter(file => !previous.some(item => item.id === file.id))])
      setFileRevision(value => value + 1)
    } catch (cause) { if (current()) setError(errorMessage(cause)) }
    finally { if (current()) setSelectingFiles(false) }
  }

  async function revokeFileGrant(grant: FileGrant) {
    fileGeneration.current++
    draftGeneration.current++
    setSelectingFiles(false)
    setRevokingGrants(previous => [...previous, grant.id])
    setSelectedFiles(previous => previous.filter(file => file.grantId !== grant.id))
    try {
      await window.her.revokeFileGrant(grant.id)
      if (fileMounted.current) { setRevokedGrants(previous => [...previous, grant.id]); setFileRevision(value => value + 1) }
    } finally { if (fileMounted.current) setRevokingGrants(previous => previous.filter(id => id !== grant.id)) }
  }

  function startRename() {
    const target = workspace?.conversation
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
    const view = viewGeneration.current
    setRenaming(null)
    try {
      const updated = await window.her.renameConversation(id, title)
      setConversations(previous => previous.map(item => item.id === id ? { ...item, title: updated.title, titleCustom: updated.titleCustom } : item))
      setWorkspace(state => state?.conversation?.id === id ? { ...state, conversation: { ...state.conversation, title: updated.title, titleCustom: updated.titleCustom } } : state)
    } catch (cause) { if (view === viewGeneration.current) setError(`无法重命名：${errorMessage(cause)}`) }
  }

  async function trashConversation(id: string) {
    const view = viewGeneration.current
    setError('')
    try { await window.her.trashConversation(id) }
    catch (cause) { if (view === viewGeneration.current) setError(`无法删除对话：${errorMessage(cause)}`); return }
    setMessagesByConversation((previous) => {
      const { [id]: _removed, ...rest } = previous
      return rest
    })
    setConversations(previous => previous.filter(item => item.id !== id))
    setWorkspace(state => state ? { ...state, workItems: state.workItems.filter(item => item.conversation.id !== id) } : state)
    if (view === viewGeneration.current && currentIdRef.current === id) {
      await selectWorkspace({ section: 'daily' })
    }
  }

  async function continueCurrentTask() {
    const task = currentId ? tasks[currentId] : null
    const profileId = bootstrap?.settings.activeProfileId
    if (!task || !profileId || pendingRef.current) return
    const conversationId = task.conversationId
    const continuingView = viewGeneration.current
    const requestId = crypto.randomUUID()

    requestRef.current = { requestId, conversationId }; setActiveRequest(requestRef.current)
    pendingRef.current = true; setBusy(true); setStopping(false); setError('')
    try {
      const result = await window.her.continueTask({ runId: task.run.id, requestId, profileId,
        model: effectiveModel(bootstrap?.profiles.find(item => item.id === profileId), selectedModel) })
      if (continuingView !== viewGeneration.current) return
      setMessagesByConversation(previous => ({ ...previous, [conversationId]: upsert(upsert(previous[conversationId] ?? [], result.userMessage, true), result.assistantMessage, eventMessages.current.has(result.assistantMessage.id)) }))
    } catch (cause) {
      if (continuingView !== viewGeneration.current) return
      if (requestRef.current && requestRef.current.requestId !== requestId) return
      setError(`继续失败：${errorMessage(cause)}`)
      if (requestRef.current?.requestId === requestId) { requestRef.current = null; setActiveRequest(null); pendingRef.current = false; setBusy(false); setStopping(false) }
    }
  }

  async function runtimeAction(action: () => Promise<unknown>) {
    const view = viewGeneration.current
    setError('')
    try {
      const pending = action()
      setQueueTick(tick => tick + 1)
      await pending
      return true
    } catch (cause) { if (view === viewGeneration.current) setError(errorMessage(cause)); return false }
    finally { setQueueTick(tick => tick + 1) }
  }

  async function chooseModel(model: string) {
    const view = viewGeneration.current
    if (!bootstrap?.settings.activeProfileId) return
    if (currentId) {
      try { await window.her.switchModel({ conversationId: currentId, profileId: bootstrap.settings.activeProfileId, model }) }
      catch (cause) { if (view === viewGeneration.current) setError(errorMessage(cause)); return }
    }
    if (view === viewGeneration.current) setSelectedModel(model)
  }

  async function stop() {
    const view = viewGeneration.current
    if (!activeRequest || stopping) return
    setStopping(true)
    try { await window.her.cancelMessage(activeRequest.requestId) }
    catch (cause) { if (view === viewGeneration.current) { setError(`停止失败：${errorMessage(cause)} 请再试一次。`); setStopping(false) } }
  }

  if (!bootstrap) return <div className="startup"><HerMark large /><h1>Her</h1>{bootError ? <><p role="alert">{bootError}</p><button className="primary-button" onClick={() => void loadBootstrap()}>重新加载</button></> : <p>正在打开我们的对话…</p>}</div>

  const activeProfile = bootstrap.profiles.find((item) => item.id === bootstrap.settings.activeProfileId)
  const currentModel = effectiveModel(activeProfile, selectedModel)
  const currentModelConfig = activeProfile?.models.find((entry) => entry.id === currentModel)
  const currentConversation = workspace?.conversation
  const lastAssistantId = messages.findLast((item) => item.role === 'assistant')?.id
  const queue = currentId ? queues[currentId] : null

  return <div className={`app-shell${resizingSidebar ? ' is-resizing' : ''}`} style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}>
    <div className="app-topbar"><span className="topbar-name"><HerMark /></span><span className="topbar-motto">和你一起，把日子慢慢过好</span></div>
    <button className="icon-button sidebar-toggle" aria-label={sidebarHidden ? '显示侧栏' : '隐藏侧栏'} title={sidebarHidden ? '显示侧栏' : '隐藏侧栏'} aria-expanded={!sidebarHidden} aria-controls="conversation-sidebar" onClick={() => setSidebarHidden(hidden => !hidden)}><Icon name="sidebar" /></button>
    <aside id="conversation-sidebar" className="sidebar" aria-label="会话侧栏" hidden={sidebarHidden} style={{ width: sidebarWidth }} data-compact={sidebarWidth < 240}>
      <div className="brand"><button ref={avatarTriggerRef} className="avatar-preview-trigger" type="button" aria-label="放大 Samantha 头像" aria-haspopup="dialog" title="放大 Samantha 头像" onClick={() => setAvatarPreviewOpen(true)}><SamanthaAvatar /></button><div><span className="brand-name">Samantha</span><p>你的私人伙伴</p></div></div>
      <WorkspaceNavigation selection={workspace?.selection ?? selectionRef.current} overview={overview} onSelect={selection => void selectWorkspace(selection)} onOpenPending={notice => void openPending(notice)} />
      <div className="sidebar-spacer" />
      <div className="sidebar-bottom"><div className="local-note">从这里回到日常<br />事情和记忆，都各有来处。</div><details className="sidebar-more"><summary>更多</summary><div className="sidebar-more-popover"><button className="trash-button" aria-label="回收站" onClick={() => { rememberPanelTrigger(); setTrashOpen(true) }}><Icon name="trash" /><span>回收站</span></button><button className="settings-button" aria-label="设置" onClick={() => void openSettings()}><Icon name="settings" /><span>设置</span><span className="settings-version">v{bootstrap.appVersion}</span></button></div></details></div>
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
      <header className="chat-header"><div className="chat-heading"><div className="chat-title"><p className="eyebrow">{selectionRef.current.section === 'daily' ? '接着聊，就好。' : selectionRef.current.section === 'memory' ? '慢慢记住你' : currentConversation ? '一起把这件事聊下去' : '生活里想一起做的事'}</p>{renaming ? <input className="title-input" aria-label="对话标题" autoFocus value={renaming.title} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setRenaming({ ...renaming, title: event.target.value })} onBlur={() => void commitRename()} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void commitRename() } else if (event.key === 'Escape') { event.preventDefault(); cancelRename() } }} /> : <div className="title-line"><h1>{selectionRef.current.section === 'daily' ? '日常' : currentConversation?.title || (selectionRef.current.section === 'memory' ? '她记得的事' : '一起在做的事')}</h1>{currentConversation && workspace?.topic?.kind === 'work' && <button className="icon-button" aria-label="重命名对话" onClick={startRename}><Icon name="edit" /></button>}</div>}</div></div>{selectionRef.current.section === 'work' && currentId && <button className="text-button back-to-topics" onClick={() => void selectWorkspace({ section: 'work' })}>返回话题</button>}{selectionRef.current.section !== 'memory' && currentId && <details className="model-details" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() } }} onBlur={event => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false }}><summary aria-label="对话详情" title="对话详情"><span aria-hidden="true">···</span></summary><div className="model-controls"><h2>模型与能力</h2>
        <div className="model-pickers"><div className="model-picker"><span className={`status-dot ${activeProfile ? '' : 'offline'}`} /><select aria-label="当前模型服务" value={activeProfile?.id ?? ''} onChange={(event) => void selectProfile(event.target.value).catch((cause) => setError(`切换失败：${errorMessage(cause)}`))}><option value="" disabled>选择模型服务</option>{bootstrap.profiles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><Icon name="chevron" /></div>{activeProfile && <div className="model-picker"><select aria-label="当前模型" value={currentModel} disabled={busy || queue?.compacting} onChange={(event) => void chooseModel(event.target.value)}>{activeProfile.models.map((entry) => <option key={entry.id} value={entry.id}>{entry.id}</option>)}</select><Icon name="chevron" /></div>}</div>
        {currentModelConfig && <details className="model-capabilities"><summary>工具{currentModelConfig.tests.tools.status === 'passed' ? '已验证' : currentModelConfig.tests.tools.status === 'failed' ? '未通过' : '尚未验证'} · 视觉{currentModelConfig.tests.vision.status === 'passed' ? '已验证' : currentModelConfig.tests.vision.status === 'failed' ? '未通过' : '尚未验证'}<Icon name="chevron" /></summary><p>能力不足时，请在设置中测试或切换模型。</p></details>}
      </div></details>}</header>

      {!currentId && error && <div className="error-banner page-error" role="alert"><span>{error}</span>{messageLoadFailed && <button onClick={() => { setError(''); setLoadAttempt(attempt => attempt + 1) }}>重试加载</button>}<button aria-label="关闭错误提示" onClick={() => setError('')}><Icon name="close" /></button></div>}

      <div className="chat-scroll" ref={scrollRef} onScroll={(event) => { const area = event.currentTarget; followStream.current = area.scrollHeight - area.scrollTop - area.clientHeight < 100 }}>
        {currentId && !queue && !queueReadFailed[currentId] && <p className="queue-loading" role="status">正在读取待发消息…</p>}
        {currentId && queueReadFailed[currentId] && <div className="error-banner" role="alert">待发消息暂时无法读取。<button onClick={() => setQueueTick(value => value + 1)}>重新读取</button></div>}
        {selectionRef.current.section === 'daily' && !pendingLoaded && <p role="status" className="queue-loading">正在读取待处理信息…</p>}
        {selectionRef.current.section === 'daily' && pendingReadFailed && <div className="error-banner" role="alert">待处理信息暂时无法读取。<button onClick={() => void refreshPending()}>重新读取</button></div>}
        {selectionRef.current.section === 'daily' && overview.map(notice => <div className="pending-notice" key={notice.id}><span>{notice.status === 'waiting_approval' ? '有一件事需要你确认' : '有一件事需要你处理'}</span><button className="text-button" onClick={() => void openPending(notice)}>查看</button></div>)}
        {queue && (queue.items.length > 0 || queue.paused) && <div className="queued-messages" role="status" aria-label="排队中的消息">
          {queue.items.map(item => <div key={item.requestId} className="queued-message"><span className="queued-indicator">●</span><span>接下来聊这句：</span><span className="queued-preview">{item.preview}</span><button className="text-button" aria-label={`撤销排队消息 ${item.preview}`} disabled={queueReadFailed[currentId!]} onClick={() => void runtimeAction(() => window.her.cancelQueuedMessage(queue.conversationId, item.requestId))}>撤销</button></div>)}
          {queue.paused && <div className="queue-paused">{queue.paused === 'stopped' ? '已停止' : queue.paused === 'failed' ? '任务失败' : queue.paused === 'limit' ? '达到限制' : queue.paused === 'source-revoked' ? '来源已撤销' : queue.paused === 'service-changed' ? '服务配置已变化' : queue.paused === 'unknown-action' ? '未知动作' : queue.paused === 'compaction-stopped' ? '压缩已停止' : queue.paused === 'compaction-failed' ? '压缩失败' : '等待重启'}{queue.items.length > 0 && <button className="text-button" disabled={queueReadFailed[currentId!] || queue.running || queue.compacting} onClick={() => void runtimeAction(() => window.her.resumeQueue(queue.conversationId))}>继续队列</button>}</div>}
        </div>}
        {selectionRef.current.section === 'memory' ? <MemoryUnavailable onDaily={() => void selectWorkspace({ section: 'daily' })} /> : messageLoadFailed ? <section className="chat-load-error" role="status"><p>这段对话暂时无法读取。</p><button className="text-button" onClick={() => { setError(''); setLoadAttempt(attempt => attempt + 1) }}>重新加载</button></section> : loadingMessages ? <div className="chat-loading" role="status">正在接上这段对话…</div> : !currentId && selectionRef.current.section === 'work' ? <TopicList items={workspace?.workItems.map(item => ({ ...item, conversation: conversations.find(value => value.id === item.conversation.id) ?? item.conversation })) ?? []} onOpen={id => void selectWorkspace({ section: 'work', conversationId: id })} onCreate={() => { setSelectedModel(null); void createConversation() }} onRename={id => { const item = conversations.find(value => value.id === id); if (item) { renameDone.current = false; setRenaming({ id, title: item.title }) } }} onTrash={id => void trashConversation(id)} /> : messages.length === 0 ? <section className="welcome">
          <h2>{selectionRef.current.section === 'daily' ? '我在，想说什么都可以。' : '这件事，我们从哪里开始？'}</h2>
          {!activeProfile && <p>接上模型服务后，我们就可以继续聊。</p>}
          {!activeProfile && <button className="primary-button" onClick={() => void openSettings()}>配置模型服务<Icon name="arrow" /></button>}
        </section> : <>

        <div className="messages" aria-label="聊天消息">{messages.map((message, index) => {
          const previousUser = messages.slice(0, index).findLast((item) => item.role === 'user')
          const retryable = !message.toolCalls?.length && message.id === lastAssistantId && ['failed', 'cancelled'].includes(message.status) && previousUser
          return <article key={message.id} className={`message message-${message.role}${message.hostStatus ? ' message-host-status' : ''}`} data-status={message.status}>
            <div className="message-identity"><div className="message-avatar" role="img" aria-label={message.hostStatus ? 'Her 状态' : message.role === 'assistant' ? 'Samantha' : '你'}>{message.hostStatus ? <HerMark /> : message.role === 'assistant' ? <SamanthaAvatar /> : '你'}</div><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div>
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
              {message.status === 'streaming' && <div className="stream-status" role="status"><span className="thinking-dots"><i /><i /><i /></span>{message.content ? '正在写…' : 'Samantha 正在想…'}</div>}
              {message.status === 'failed' && <p className="message-error">{message.error || '回答未完成。请检查模型服务后重试。'}</p>}
              {(message.interrupted || (message.status === 'cancelled' && message.content)) && <p className="message-interrupted">已中断片段</p>}
              {message.status === 'cancelled' && <p className="message-interrupted">已停止，已生成的内容保留在这里。</p>}
              {(retryable || message.status === 'failed') && <div className="message-actions">{retryable && <button className="retry-button" disabled={busy} onClick={() => void send(previousUser.content, message.id)}><Icon name="retry" />{message.status === 'failed' ? '重试' : '重新生成'}</button>}{message.status === 'failed' && <button className="retry-button settings-link" onClick={() => void openSettings(message.profileId)}><Icon name="settings" />检查模型设置</button>}</div>}
            </div>
          </article>
        })}</div>
        {busy && !messages.some((item) => item.status === 'streaming') && activeRequest?.conversationId === currentId && <div className="pending-message" role="status"><span className="thinking-dots"><i /><i /><i /></span>正在连接模型…</div>}
      </>}
      {selectionRef.current.section === 'daily' && currentId && !loadingMessages && !messageLoadFailed && messages.some(message => message.role === 'user') && <div className="handoff-invite"><Icon name="leaf" /><span>有想单独聊的事</span><button className="text-button handoff-entry" onClick={() => { if (handoffResume.current?.sourceConversationId !== currentId) handoffResume.current = null; handoffView.current = viewGeneration.current; handoffOpenRef.current = true; setHandoffOpen(true) }}>单独聊这件事</button></div>}
      {currentId && !loadingMessages && !messageLoadFailed && <div className="conversation-actions">
        {workspace?.topic?.kind === 'work' && <DelegationCards key={`delegation:${currentId}`} conversationId={currentId} refreshKey={`${overview.map(item => `${item.id}:${item.version}`).join(',')}:${tasks[currentId]?.seq ?? ''}:${tasks[currentId]?.run.status ?? ''}`} />}
        {tasks[currentId] && (tasks[currentId]!.run.status !== 'completed' || !!tasks[currentId]!.approval || !!tasks[currentId]!.unknownCalls?.length) && <TaskStatus key={`${tasks[currentId]!.run.id}:${tasks[currentId]!.approval?.id ?? ''}`} task={tasks[currentId]!} message={messages.find(item => item.id === tasks[currentId]!.run.assistantMessageId)} canContinue={!tasks[currentId]!.run.delegationId && !busy && !!activeProfile && tasks[currentId]!.run.assistantMessageId === messages.at(-1)?.id && ['paused', 'stopped', 'failed', 'interrupted'].includes(tasks[currentId]!.run.status)} onContinue={() => void continueCurrentTask()} onStop={() => void stop()} />}
      </div>}
      <div ref={bottomRef} />
      </div>

      {selectionRef.current.section !== 'memory' && currentId && <div className="composer-area" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDrop={event => { event.preventDefault(); const dropped = Array.from(event.dataTransfer.files); if (dropped.length) void selectFiles('file', 'conversation', dropped) }}>
        {error && <div className="error-banner" role="alert"><span>{error}</span>{messageLoadFailed && <button onClick={() => { setError(''); setLoadAttempt((attempt) => attempt + 1) }}>重试加载</button>}<button aria-label="关闭错误提示" onClick={() => setError('')}><Icon name="close" /></button></div>}
        {busy && activeRequest?.conversationId !== currentId && <p className="generation-note">Samantha 正在另一段对话中回答。你可以先写下想说的话。</p>}
        {validatingDraftFiles && <p role="status">正在核对草稿资料…</p>}
        {invalidDraftFiles.length > 0 && <p className="file-error" role="alert">部分资料已变化或授权失效，请移除后重新选择。</p>}
        {selectedFiles.length > 0 && <div className="attachments-preview">{selectedFiles.map(file => <div className={`attachment-item file-chip${invalidDraftFiles.includes(file.id) ? ' invalid' : ''}`} key={file.id}>
          <div className="attachment-file-preview">{file.mimeType.startsWith('image/') && currentId ? <FilePreview key={`${currentId}:${file.id}:${fileRevision}`} file={file} conversationId={currentId} /> : <Icon name="paperclip" />}</div>
          <div className="attachment-file-copy"><span title={file.name}>{file.name}</span><small>仅在当前话题</small></div><button className="attachment-file-remove" type="button" onClick={() => { fileGeneration.current++; draftGeneration.current++; setSelectingFiles(false); setInvalidDraftFiles(previous => previous.filter(id => id !== file.id)); setSelectedFiles(previous => previous.filter(item => item.id !== file.id)) }} aria-label={`移除 ${file.name}`}>×</button>
        </div>)}</div>}
        {currentId && <div ref={fileAccessRef} className="file-access-flyout" role="dialog" aria-label="当前资料授权" hidden={fileAccessOpenFor !== currentId} onKeyDown={event => { if (event.key === 'Escape') { setFileAccessOpenFor(null); attachmentMenuRef.current?.querySelector('summary')?.focus() } }}><button className="file-access-close" type="button" aria-label="关闭资料授权" onClick={() => { setFileAccessOpenFor(null); attachmentMenuRef.current?.querySelector('summary')?.focus() }}>×</button><FileAccessPanel key={currentId} conversationId={currentId} refreshKey={fileRevision} onRevoke={revokeFileGrant} /></div>}
        {selectingFiles && <p role="status">正在添加资料…</p>}
        <form className="composer" onSubmit={(event) => { event.preventDefault(); void send() }}>
          <div className="composer-input-wrapper">
            <textarea ref={composerRef} aria-label="消息" placeholder={activeProfile ? '想说什么，就从这里开始…' : '先写下想说的话，接上模型后就能发送'} value={draft} rows={2} onChange={(event) => { draftGeneration.current++; textGeneration.current++; setDraft(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); void send() } }} />
          </div>
          <div className="composer-bottom">
            <details ref={attachmentMenuRef} className="attachment-picker" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() } }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) event.currentTarget.open = false }}>
              <summary className="attachment-trigger"><Icon name="plus" />文字与附件</summary>
              <div className="attachment-popover">
                <button type="button" aria-label="添加资料" disabled={selectingFiles} onClick={() => { attachmentMenuRef.current!.open = false; void selectFiles() }}><Icon name="paperclip" />选择图片或文件</button>
                <button type="button" disabled={selectingFiles} onClick={() => { attachmentMenuRef.current!.open = false; void selectFiles('directory') }}><Icon name="layers" />授权当前话题目录</button>
                <button type="button" disabled={selectingFiles} onClick={() => { attachmentMenuRef.current!.open = false; void selectFiles('directory', 'persistent') }}><Icon name="layers" />授权长期目录</button>
                <div className="attachment-separator" />
                <button type="button" onClick={() => { attachmentMenuRef.current!.open = false; setFileAccessOpenFor(currentId); const details = fileAccessRef.current?.querySelector('details'); if (details) details.open = true }}><Icon name="lock" />查看当前资料授权</button>
                <p>文件限当前话题；目录可长期授权。</p>
              </div>
            </details>
            <span className="composer-hint">Enter 发送 · Shift + Enter 换行</span>
            <div className="composer-actions">
              <ConversationUsage key={`${currentId}:${activeProfile?.id}:${currentModel}`} conversationId={currentId} profileId={activeProfile?.id} model={currentModel} messages={messages} refreshKey={queueTick}
                busy={busy} compacting={queue?.compacting ?? false} compactFailed={queue?.paused === 'compaction-failed'}
                onCompact={() => runtimeAction(() => window.her.compactConversation({ conversationId: currentId!, profileId: activeProfile!.id, model: currentModel }))}
                onStopCompaction={() => runtimeAction(() => window.her.stopCompaction(currentId!))} />
              {activeRequest && (
                <button type="button" className="send-button stop" aria-label="停止生成" disabled={stopping} onClick={() => void stop()}>
                  <span className="stop-square" />
                </button>
              )}
              {<button type="submit" className="send-button" aria-label="发送" disabled={(!draft.trim() && selectedFiles.length === 0) || !activeProfile || loadingMessages || messageLoadFailed || refreshingMessages || staleMessages || !workspace || selectingFiles || validatingDraftFiles || invalidDraftFiles.length > 0}>
                  <Icon name="arrow" />
                </button>}
            </div>
          </div>
        </form>
      </div>}
    </main>

    {avatarPreviewOpen && <div className="modal-backdrop avatar-preview-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) { event.preventDefault(); closeAvatarPreview() } }}>
      <section className="avatar-preview" role="dialog" aria-modal="true" aria-label="Samantha 头像预览" tabIndex={-1} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); closeAvatarPreview() }
        else if (event.key === 'Tab') { event.preventDefault(); avatarCloseRef.current?.focus() }
      }}>
        <button ref={avatarCloseRef} className="avatar-preview-close" type="button" aria-label="关闭头像预览" onClick={closeAvatarPreview}><Icon name="close" /></button>
        <SamanthaAvatar />
      </section>
    </div>}
    {trashOpen && <TrashPanel onClose={() => { setTrashOpen(false); (panelTrigger.current ?? composerRef.current)?.focus() }} onRestored={() => void refreshWorkItems()} />}
    {handoffOpen && currentId && selectionRef.current.section === 'daily' && <TopicHandoffDialog sourceConversationId={currentId} messages={messages} resume={handoffResume.current} onResume={value => { handoffResume.current = value }} onClose={() => { handoffOpenRef.current = false; setHandoffOpen(false); composerRef.current?.focus() }} onCreated={id => { if (handoffOpenRef.current && handoffView.current === viewGeneration.current && selectionRef.current.section === 'daily') { handoffResume.current = null; handoffOpenRef.current = false; setHandoffOpen(false); void selectWorkspace({ section: 'work', conversationId: id }) } }} />}
    {settingsOpen && <SettingsPanel conversationId={currentId ?? undefined} promptModel={selectedModel ?? undefined} profiles={bootstrap.profiles} settings={bootstrap.settings} initialProfileId={settingsProfileId} dataDirectory={bootstrap.dataDirectory} onRevokeFileGrant={revokeFileGrant} onClose={() => { setSettingsOpen(false); (panelTrigger.current ?? composerRef.current)?.focus() }} onConfigurationChanged={refreshConfiguration} onAppearanceChanged={(appearance: Appearance) => setBootstrap(state => state && ({ ...state, settings: { ...state.settings, appearance } }))} onSelectProfile={selectProfile} />}
  </div>
}
