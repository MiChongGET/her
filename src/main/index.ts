import { PdfService, registerPdfTools } from '../core/documents/pdf'
import { ElectronPdfRenderer } from './pdf-renderer'
import { DocumentService, registerDocumentTools } from '../core/documents/service'
import { createMarkItDownParser, MARKITDOWN_POLICY } from '../core/documents/markitdown'
import { app, BrowserWindow, dialog, globalShortcut, Menu, nativeImage, net, protocol, session, Tray, type MenuItemConstructorOptions } from 'electron'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync } from 'node:fs'
import { HerStore } from '../core/storage/store'
import { ProfileService } from '../core/storage/profiles'
import { ChatService, SYSTEM } from '../core/conversation/chat'
import { FileAccessService } from '../core/files/access'
import { registerFileTools } from '../core/files/tools'
import { createDefaultRegistry } from '../core/tools/registry'
import { secretCodec } from './credentials'
import { registerIpc } from './ipc'
import { clipboardWriteAllowed } from './ipc-policy'
import { McpConfigService } from '../core/mcp/config'
import { PresetDependencies } from '../core/mcp/dependencies'
import { createBrowserAdapter } from '../core/mcp/browser'
import { createWebSearchAdapter } from '../core/mcp/web-search'
import { createPeekabooAdapter } from '../core/mcp/peekaboo'
import { McpConnectionManager } from '../core/mcp/manager'
import { ToolArtifactStore } from '../core/tools/artifacts'
import { createShutdown } from './shutdown'
import { updateShortcuts } from './shortcuts'
import type { DesktopSettings } from '../shared/types'

app.setName('Her')
if (process.env.HER_DATA_DIR) app.setPath('userData', resolve(process.env.HER_DATA_DIR))
protocol.registerSchemesAsPrivileged([
  { scheme: 'her', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

const here = dirname(fileURLToPath(import.meta.url))
const developmentUrl = process.env.ELECTRON_RENDERER_URL
let window: BrowserWindow
let tray: Tray
let store: HerStore | undefined
let chat: ChatService | undefined
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
  const previous = store!.getSettings()
  const updated = { ...previous, ...input, shortcut: input.shortcut.trim(), stopShortcut: input.stopShortcut.trim() }
  if (input.launchAtLogin && !app.isPackaged) throw new Error('登录自启需要安装版 Her，当前源码运行暂不支持。')
  updateShortcuts(previous, updated, { register: registerShortcut, unregister: key => globalShortcut.unregister(key), show: showWindow, stop: () => chat?.cancelActive() }, () => {
    if (input.launchAtLogin !== previous.launchAtLogin) app.setLoginItemSettings({ openAtLogin: input.launchAtLogin })
    store!.setSettings(updated)
  })
  return updated
}

function trayIcon(): Electron.NativeImage {
  const size = 18
  const bitmap = Buffer.alloc(size * size * 4)
  for (let y = 3; y < 15; y++) {
    for (let x = 3; x < 15; x++) {
      if (x < 6 || x > 11 || (y >= 8 && y <= 10)) bitmap[(y * size + x) * 4 + 3] = 255
    }
  }
  const image = nativeImage.createFromBitmap(bitmap, { width: size, height: size })
  image.setTemplateImage(true)
  return image
}

async function start(): Promise<void> {
  const dataDirectory = app.getPath('userData')
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })
  store = new HerStore(join(dataDirectory, 'her.sqlite'))
  if (!store.listConversations().length) store.createConversation()
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
    title: 'Her', backgroundColor: '#f5f3ee',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true
    }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.on('close', event => {
    if (!quitting) { event.preventDefault(); window.hide() }
  })
  const currentStore = store
  const registry = createDefaultRegistry()
  const configs = new McpConfigService(currentStore, secretCodec, lifetime.signal)
  const files = new FileAccessService(currentStore, lifetime.signal)
  registerFileTools(registry, files)
  const artifacts = new ToolArtifactStore(currentStore, lifetime.signal, files)
  const dependencies = new PresetDependencies({ lifetime: lifetime.signal,
    resourcesRoot: app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources') })
  const manager: McpConnectionManager = new McpConnectionManager(configs, registry, artifacts, async config => {
    if (config.presetId === 'peekaboo') {
      await dependencies.verifyPeekaboo(config)
      return createPeekabooAdapter(manager, config.id)
    }
    if (config.presetId === 'playwright' || config.presetId === 'open-websearch') {
      await dependencies.verifyWebPreset(config, config.presetId)
      return config.presetId === 'playwright' ? createBrowserAdapter(manager, config.id) : createWebSearchAdapter(manager, config.id)
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
  chat = new ChatService(currentStore, profiles, event => {
    if (!window.webContents.isDestroyed()) window.webContents.send('her:chat-event', event)
  }, () => {
    const settings = currentStore.getSettings()
    return settings.systemPrompt || SYSTEM
  }, undefined, registry, artifacts, () => Promise.allSettled(configs.list().filter(config => config.enabled).map(config => manager.connect(config.id))), event => {
    if (!window.webContents.isDestroyed()) window.webContents.send('her:request-event', event)
  }, files)
  shutdown = createShutdown({ lifetime, stop: () => chat!.shutdown(),
    drain: () => Promise.allSettled([manager.shutdown(), dependencies.shutdown(), documents.shutdown(), pdf.shutdown(), artifacts.shutdown(), ...pending]),
    forceClose: () => { manager.forceCloseOwnedProcesses(); dependencies.forceCloseOwnedProcesses() }, close: () => currentStore.close() })
  registerIpc({
    window, developmentUrl, store: currentStore, profiles, chat, configs, manager, dependencies, artifacts, files, lifetime: lifetime.signal, pending,
    appVersion: app.getVersion(), dataDirectory, desktopPreferences
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
  const settings = store.getSettings()
  if (!registerShortcut(settings.shortcut)) {
    void dialog.showMessageBox(window, {
      type: 'info', message: '唤出快捷键已被其他应用占用，请在桌面设置中更换。', buttons: ['知道了']
    })
  }
  if (!registerShortcut(settings.stopShortcut, () => chat?.cancelActive())) {
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
