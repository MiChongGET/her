import { PdfService, registerPdfTools } from '../core/documents/pdf'
import { ElectronPdfRenderer } from './pdf-renderer'
import { DocumentService, registerDocumentTools } from '../core/documents/service'
import { createMarkItDownParser, MARKITDOWN_POLICY } from '../core/documents/markitdown'
import { app, BrowserWindow, dialog, globalShortcut, Menu, Notification, nativeImage, nativeTheme, net, powerMonitor, protocol, session, Tray, type MenuItemConstructorOptions } from 'electron'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, mkdirSync } from 'node:fs'
import { dataPaths } from '../core/storage/paths'
import { HerStore } from '../core/storage/store'
import { ProfileService } from '../core/storage/profiles'
import { ChatService, SYSTEM } from '../core/conversation/chat'
import { AgentHost } from '../core/agent/host'
import { FileAccessService } from '../core/files/access'
import { registerFileTools } from '../core/files/tools'
import { createDefaultRegistry } from '../core/tools/registry'
import { WeatherService } from '../core/weather/service'
import { registerWeatherTools } from '../core/weather/tools'
import { EgoBrowserTools } from '../core/tools/ego-browser'
import { combineRegistries } from '../core/tools/combine'
import { secretCodec } from './credentials'
import { WorkspaceService } from '../core/conversation/workspace'
import { TopicHandoffService } from '../core/conversation/topic-handoff'
import { registerIpc } from './ipc'
import { clipboardWriteAllowed } from './ipc-policy'
import { McpConfigService } from '../core/mcp/config'
import { PresetDependencies } from '../core/mcp/dependencies'
import { McpPrerequisiteError } from '../core/mcp/errors'
import { createWebSearchAdapter } from '../core/mcp/web-search'
import { HttpComparison } from '../core/delegations/http-comparison'
import { BrowserActions } from '../core/tools/browser-actions'
import { createPeekabooAdapter } from '../core/mcp/peekaboo'
import { McpConnectionManager } from '../core/mcp/manager'
import { ToolArtifactStore } from '../core/tools/artifacts'
import { PendingWorkNotifier, DeliveryState } from './pending-work-notifier'
import { getNotificationPermission } from './notification-permission'
import { createShutdown } from './shutdown'
import { updateShortcuts } from './shortcuts'
import type { Appearance, DesktopSettings } from '../shared/types'

app.setName('Her')
if (process.env.HER_DATA_DIR) app.setPath('userData', resolve(process.env.HER_DATA_DIR))
protocol.registerSchemesAsPrivileged([
  { scheme: 'her', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

const here = dirname(fileURLToPath(import.meta.url))
const sourceResources = resolve(here, '../../resources')
const developmentUrl = process.env.ELECTRON_RENDERER_URL
let window: BrowserWindow
let tray: Tray
let store: HerStore | undefined
let chat: ChatService | undefined
let notifier: PendingWorkNotifier | undefined
let quitting = false
let quitComplete = false
let shutdown: (() => Promise<void>) | undefined
const lifetime = new AbortController()
const pending = new Set<Promise<unknown>>()

function showWindow(): void {
  if (quitting || !window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

function registerShortcut(accelerator: string, action = showWindow): boolean {
  if (!accelerator) return true
  try { return globalShortcut.register(accelerator, action) } catch { return false }
}

function desktopPreferences(input: { shortcut: string; stopShortcut: string; launchAtLogin: boolean }): DesktopSettings {
  const previous = store!.getSettings() || { activeProfileId: null, shortcut: '', stopShortcut: '', launchAtLogin: false }
  const updated: DesktopSettings = { ...previous, ...input, shortcut: input.shortcut.trim(), stopShortcut: input.stopShortcut.trim() }
  if (input.launchAtLogin && !app.isPackaged) throw new Error('登录自启需要安装版 Her，当前源码运行暂不支持。')
  updateShortcuts(previous, updated, { register: registerShortcut, unregister: key => globalShortcut.unregister(key), show: showWindow, stop: () => chat?.cancelActive() }, () => {
    if (input.launchAtLogin !== previous.launchAtLogin) app.setLoginItemSettings({ openAtLogin: input.launchAtLogin })
    store!.setSettings(updated)
  })
  return updated
}

function setAppearance(appearance: Appearance): DesktopSettings {
  const updated = { ...store!.getSettings(), appearance }
  store!.setSettings(updated)
  nativeTheme.themeSource = appearance
  applyEffectiveAppearance()
  return updated
}

function applyEffectiveAppearance(): void {
  if (!window || window.isDestroyed()) return
  const effective = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  window.setBackgroundColor(effective === 'dark' ? '#1c1d1b' : '#f8f7f3')
  window.webContents.send('her:appearance-effective', effective)
}

function trayIcon(): Electron.NativeImage {
  const directory = app.isPackaged ? join(process.resourcesPath, 'native-icons')
    : join(sourceResources, 'branding/her-final/native-icons')
  const image = nativeImage.createFromPath(join(directory, 'her-tray.png'))
  image.setTemplateImage(true)
  return image
}

async function start(): Promise<void> {
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock?.setIcon(join(sourceResources, 'branding/her-final/her-app-icon.png'))
  }
  // Everything lives under Her-Pi-v1/, so files left by the old Her in the user-data folder are never read or touched.
  const paths = dataPaths(app.getPath('userData'))
  const dataDirectory = paths.root
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })
  const newInstallation = !existsSync(paths.database)
  store = new HerStore(paths.database)
  if (newInstallation) store.setSettings({ ...store.getSettings(), appearance: 'system' })
  nativeTheme.themeSource = store.getSettings().appearance
  store.ensureDailyConversation()
  const profiles = new ProfileService(store, secretCodec, lifetime.signal)
  const rendererDirectory = resolve(here, '../renderer')
  protocol.handle('her', request => {
    const url = new URL(request.url)
    const path = resolve(rendererDirectory, '.' + decodeURIComponent(url.pathname))
    if (url.hostname !== 'app' || !path.startsWith(rendererDirectory + sep)) {
      return new Response('Not found', { status: 404 })
    }
    return net.fetch(pathToFileURL(path).toString())
  })
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(
    clipboardWriteAllowed(permission, details.requestingUrl, details.isMainFrame, contents === window?.webContents, developmentUrl)))
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) =>
    clipboardWriteAllowed(permission, details.requestingUrl ?? '', details.isMainFrame, contents === window?.webContents, developmentUrl))
  window = new BrowserWindow({
    width: 1140, height: 800, minWidth: 850, minHeight: 620,
    title: 'Her', backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1d1b' : '#f8f7f3',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      additionalArguments: [`--her-effective-appearance=${nativeTheme.shouldUseDarkColors ? 'dark' : 'light'}`],
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true
    }
  })
  nativeTheme.on('updated', applyEffectiveAppearance)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.on('close', event => {
    if (!quitting) { event.preventDefault(); window.hide() }
  })
  const currentStore = store
  const registry = createDefaultRegistry()
  const weather = new WeatherService({ store: currentStore, signal: lifetime.signal,
    fetch: (input, options) => net.fetch(String(input), options),
    onState: state => { if (!lifetime.signal.aborted && !window.isDestroyed()) window.webContents.send('her:weather-event', state) } })
  registerWeatherTools(registry, weather)
  const refreshWeather = (force = false) => {
    const request = weather.refresh(force)
    pending.add(request)
    void request.finally(() => pending.delete(request)).catch(() => {})
  }
  const weatherTimer = setInterval(() => refreshWeather(true), 30 * 60_000)
  weatherTimer.unref()
  const resumeWeather = () => refreshWeather()
  powerMonitor.on('resume', resumeWeather)
  lifetime.signal.addEventListener('abort', () => { clearInterval(weatherTimer); powerMonitor.removeListener('resume', resumeWeather) }, { once: true })
  refreshWeather(true)
  const configs = new McpConfigService(currentStore, secretCodec, lifetime.signal)
  const files = new FileAccessService(currentStore, lifetime.signal)
  registerFileTools(registry, files)
  const artifacts = new ToolArtifactStore(currentStore, lifetime.signal, files)
  const browser = new EgoBrowserTools({ lifetime: lifetime.signal, artifacts, isEnabled: () => !currentStore.getSettings().disabledSkillIds?.includes('ego-browser') })
  browser.register(registry)
  new BrowserActions(browser).register(registry)
  const dependencies = new PresetDependencies({ lifetime: lifetime.signal,
    resourcesRoot: app.isPackaged ? process.resourcesPath : sourceResources })
  const confinedHttp = new Map<string, number>()
  const currentHttpRevision = (id: string): string | null => {
    const config = configs.list().find(value => value.id === id)
    return config?.enabled && config.presetId === 'open-websearch' && confinedHttp.get(id) === config.revision ? String(config.revision) : null
  }
  const httpComparison = new HttpComparison(currentStore, {
    available: () => configs.list().some(config => currentHttpRevision(config.id) !== null), serviceRevision: currentHttpRevision
  })
  const manager: McpConnectionManager = new McpConnectionManager(configs, registry, artifacts, async config => {
    if (config.presetId === 'peekaboo') {
      await dependencies.verifyPeekaboo(config)
      return createPeekabooAdapter(manager, config.id)
    }
    if (config.presetId === 'playwright') throw new McpPrerequisiteError('Playwright 预设已移除，请在技能设置中启用官方 ego-browser 技能。')
    if (config.presetId === 'open-websearch') {
      await dependencies.verifyWebPreset(config, config.presetId)
      const requestConfinement = await dependencies.webRequestConfinement()
      if (requestConfinement) confinedHttp.set(config.id, config.revision)
      else confinedHttp.delete(config.id)
      return createWebSearchAdapter(manager, config.id, { comparison: httpComparison, requestConfinement })
    }
    if (config.presetId === 'markitdown') { await dependencies.verifyMarkItDown(config); return MARKITDOWN_POLICY }
    if (config.presetId) throw new Error('此预设执行适配尚未接入，请检查依赖。')
    return {} // Custom MCP annotations/names never grant preset trust.
  })
  const documents = new DocumentService(currentStore, files, () => createMarkItDownParser(configs, manager))
  registerDocumentTools(registry, documents)
  const pdf = new PdfService(files, artifacts, new ElectronPdfRenderer(rendererDirectory, join(here, '../preload/pdf.cjs')))
  registerPdfTools(registry, pdf)
  if (currentStore.artifactCleanupWarning) console.warn(currentStore.artifactCleanupWarning)
  if (currentStore.documentCleanupWarning) console.warn(currentStore.documentCleanupWarning)

  const host = new AgentHost(currentStore, profiles, dataDirectory, async (conversationId, signal) =>
    combineRegistries(await manager.prepare(conversationId, signal)), (id, context) => artifacts.read(id, context), files, manager, httpComparison)
  let workspace: WorkspaceService
  const publishPending = () => {
    if (quitting || window.isDestroyed()) return
    const notices = workspace.getPendingActions()
    window.webContents.send('her:workspace-pending-event', notices)
    void notifier?.update(notices, window.isVisible() && !window.isMinimized())
  }
  chat = new ChatService(currentStore, host,
    event => {
      if (window.isDestroyed()) return
      // Task and message have independent consumers; never deliver the nested task twice.
      if (event.task) {
        const task = workspace.routeTask(event.task)
        if (task) window.webContents.send('her:workspace-task-event', task)
      }
      const routed = workspace.routeChat(event)
      if (routed) {
        const { task: _task, ...messageEvent } = routed.event
        window.webContents.send('her:workspace-chat-event', { ...routed, event: messageEvent })
      }
      publishPending()
    },
    event => {
      if (window.isDestroyed()) return
      const routed = workspace.routeRequest(event)
      if (routed) window.webContents.send('her:workspace-request-event', routed)
      publishPending()
    })
  workspace = new WorkspaceService(currentStore, chat)
  const topicHandoffs = new TopicHandoffService(currentStore, chat, workspace)
  await topicHandoffs.recover()

  shutdown = createShutdown({ lifetime, stop: () => chat!.shutdown(),
    drain: () => Promise.allSettled([chat!.shutdown(), manager.shutdown(), dependencies.shutdown(), browser.shutdown(), documents.shutdown(), pdf.shutdown(), artifacts.shutdown(), ...pending]),
    forceClose: () => { manager.forceCloseOwnedProcesses(); dependencies.forceCloseOwnedProcesses(); browser.forceCloseOwnedProcesses() }, close: () => currentStore.close() })
  registerIpc({
    window, developmentUrl, store: currentStore, profiles, chat, workspace, topicHandoffs, weather, configs, manager, dependencies, artifacts, files, lifetime: lifetime.signal, pending,
    appVersion: app.getVersion(), dataDirectory, desktopPreferences, setAppearance, onPendingActionsChanged: publishPending,
    onSkillDisabled: id => { if (id === 'ego-browser') browser.disable() }
  })
  const menuTemplate: MenuItemConstructorOptions[] = [
    { label: 'Her', submenu: [
      { label: '关于 Her', role: 'about' },
      { label: '显示 Her', click: showWindow },
      { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { label: '退出 Her', role: 'quit' }
    ] },
    { label: '编辑', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
    ] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { label: '显示 Her', click: showWindow }] }
  ]
  if (developmentUrl) {
    menuTemplate.push({ label: '开发', submenu: [
      { label: '打开开发者工具', accelerator: 'CmdOrCtrl+Option+I', click: () => window.webContents.openDevTools() },
      { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => window.webContents.reload() }
    ] })
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate))
  tray = new Tray(trayIcon())
  tray.setToolTip('Her')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 Her', click: showWindow }, { type: 'separator' }, { label: '退出 Her', role: 'quit' }
  ]))
  tray.on('click', showWindow)
  notifier = new PendingWorkNotifier({
    permission: getNotificationPermission,
    fingerprint: notice => workspace.notificationFingerprint(notice),
    runFingerprint: notice => workspace.notificationRunFingerprint(notice),
    delivery: new DeliveryState(paths.notificationDelivery),
    updateTray: count => {
      const label = count ? 'Her · 有待处理事项' : 'Her'
      tray.setToolTip(label)
      tray.setTitle(count ? '•' : '')
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: count ? '有待处理事项' : '暂无待处理事项', enabled: false },
        { label: '显示 Her', click: showWindow }, { type: 'separator' }, { label: '退出 Her', role: 'quit' }
      ]))
    },
    showNotification: click => {
      const notification = new Notification({ title: 'Her', body: '有事项需要你处理。', silent: true })
      notification.on('click', click)
      notification.show()
      return () => { notification.removeAllListeners(); notification.close() }
    },
    resolve: input => workspace.resolvePendingAction(input),
    open: notice => {
      workspace.queuePendingActionOpen(notice)
      showWindow()
      window.webContents.send('her:workspace-pending-open-event')
    }
  })
  window.on('show', publishPending)
  window.on('hide', publishPending)
  window.on('minimize', publishPending)
  window.on('restore', publishPending)
  publishPending()
  const settings = store.getSettings()
  if (settings?.shortcut && !registerShortcut(settings.shortcut)) {
    void dialog.showMessageBox(window, {
      type: 'info', message: '唤出快捷键已被其他应用占用，请在桌面设置中更换。', buttons: ['知道了']
    })
  }
  if (settings?.stopShortcut && !registerShortcut(settings.stopShortcut, () => chat?.cancelActive())) {
    void dialog.showMessageBox(window, { type: 'info', message: '全局停止快捷键已被占用，请在桌面设置中更换；仍可使用停止按钮。', buttons: ['知道了'] })
  }
  if (developmentUrl) {
    await window.loadURL(developmentUrl)
  } else {
    await window.loadURL('her://app/index.html')
  }
}

const lock = app.requestSingleInstanceLock()
if (!lock) app.quit()
else {
  app.on('second-instance', () => { if (window) showWindow() })
  app.on('activate', () => { if (window) showWindow() })
  app.on('before-quit', event => {
    if (quitComplete || !shutdown) return
    event.preventDefault()
    quitting = true
    notifier?.dispose()
    void shutdown().then(() => { quitComplete = true; app.quit() })
  })
  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    tray?.destroy()
    if (!shutdown) store?.close()
  })
  app.on('window-all-closed', () => { /* The menu-bar companion keeps running until explicit quit. */ })
  void app.whenReady().then(start).catch(() => {
    dialog.showErrorBox('Her 无法启动', '本地资料或桌面初始化失败。请检查资料目录是否可写，再重试。')
    app.quit()
  })
}
