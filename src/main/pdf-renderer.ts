import { BrowserWindow, ipcMain, net, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PdfInspection, PdfRenderReply, PdfRequest } from '../shared/types'
import type { PdfRenderer } from '../core/documents/pdf'
import { FileAccessError } from '../core/files/errors'

const PAGE = 'her://app/pdf/index.html'
const CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; font-src 'self' data:; img-src 'self' data:; style-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'"
export class ElectronPdfRenderer implements PdfRenderer {
  private readonly active = new Set<() => void>()
  private stopped = false
  constructor(private readonly directory: string, private readonly preload: string) {}
  execute(bytes: Uint8Array, request: PdfRequest, signal: AbortSignal): Promise<PdfInspection | PdfRenderReply> {
    signal.throwIfAborted()
    if (this.stopped) return Promise.reject(new FileAccessError('PDF 读取正在停止。'))
    const isolated = session.fromPartition(`her-pdf-${randomUUID()}`, {cache:false})
    const root = resolve(this.directory)
    isolated.protocol.handle('her', async input => {
      const url = new URL(input.url)
      const path = resolve(root, '.' + decodeURIComponent(url.pathname))
      if (url.hostname !== 'app' || url.search || !(url.pathname === '/pdf/index.html' || url.pathname.startsWith('/assets/pdfjs/') || /^\/assets\/pdf-[\w-]+\.js$/.test(url.pathname)) || !path.startsWith(root + sep)) return new Response('Not found',{status:404})
      const response = await net.fetch(pathToFileURL(path).href)
      const headers = new Headers(response.headers); headers.set('Content-Security-Policy',CSP)
      return new Response(response.body,{status:response.status,headers})
    })
    isolated.webRequest.onBeforeRequest((details, callback) => { const url = new URL(details.url); callback({cancel:url.protocol !== 'her:' || url.hostname !== 'app'}) })
    isolated.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false))
    isolated.setPermissionCheckHandler(()=>false)
    const window = new BrowserWindow({show:false,focusable:false,skipTaskbar:true,webPreferences:{session:isolated,preload:this.preload,sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInWorker:false,webSecurity:true,webviewTag:false}})
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}))
    window.webContents.on('will-navigate',event=>event.preventDefault())
    window.webContents.on('will-attach-webview',event=>event.preventDefault())
    return new Promise((done, fail) => {
      let settled=false
      const finish = (error?: Error, value?: PdfInspection | PdfRenderReply) => {
        if(settled) return; settled=true
        clearTimeout(timer); signal.removeEventListener('abort',cancel); ipcMain.removeListener('her:pdf-result',result)
        this.active.delete(stop)
        if(!window.isDestroyed()) window.destroy()
        isolated.protocol.unhandle('her')
        if(error) fail(error); else done(value!)
      }
      const cancel = () => finish(signal.reason instanceof Error ? signal.reason : new Error('PDF 读取已取消。'))
      const stop = () => finish(new FileAccessError('PDF 读取正在停止。'))
      const result = (event: Electron.IpcMainEvent, reply: {value?: PdfInspection | PdfRenderReply; error?: string}) => {
        if(event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== PAGE) return
        if(signal.aborted) {cancel();return}
        finish(reply.error ? new FileAccessError(reply.error) : undefined,reply.value)
      }
      const timer=setTimeout(()=>finish(new FileAccessError('PDF 读取超时，请减少页数后重试。')),120000)
      this.active.add(stop); signal.addEventListener('abort',cancel,{once:true}); ipcMain.on('her:pdf-result',result)
      window.webContents.once('render-process-gone',()=>finish(new FileAccessError('PDF 渲染进程已退出。')))
      window.once('closed',()=>finish(new FileAccessError('PDF 渲染窗口已关闭。')))
      // Copy the exact authorized view, never its pooled backing ArrayBuffer.
      void window.loadURL(PAGE).then(()=>{ if(!settled) window.webContents.send('her:pdf-request',{bytes:new Uint8Array(bytes),request}) },()=>finish(new FileAccessError('PDF 本地渲染资源无法加载。')))
    })
  }
  async shutdown(): Promise<void> { this.stopped=true; for(const stop of [...this.active]) stop() }
}
