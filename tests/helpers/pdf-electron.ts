import { app, protocol, BrowserWindow, nativeImage } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HerStore } from '../../src/core/storage/store'
import { FileAccessService } from '../../src/core/files/access'
import { ToolArtifactStore } from '../../src/core/tools/artifacts'
import { PdfService, registerPdfTools } from '../../src/core/documents/pdf'
import { SimpleToolRegistry } from '../../src/core/tools/registry'
import { ElectronPdfRenderer } from '../../src/main/pdf-renderer'
protocol.registerSchemesAsPrivileged([{scheme:'her',privileges:{standard:true,secure:true,supportFetchAPI:true}}])
app.on('window-all-closed',()=>{})
const root = process.env.HER_PDF_TEST_ROOT!
const evidence = process.env.HER_PDF_TEST_EVIDENCE!
app.setPath('userData', join(evidence,'userdata'))
mkdirSync(evidence,{recursive:true})
const driver = new ElectronPdfRenderer(join(root,'out/renderer'),join(root,'out/preload/pdf.cjs'))
const security: unknown[] = []; const consoleMessages: string[] = [];
const receipts: unknown[] = []; const requests: string[] = []; const targets: unknown[] = []
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', () => {
    void window.webContents.executeJavaScript(`(async()=>({origin:location.origin,herApi:typeof window.herApi,node:typeof process,require:typeof require,remote:await fetch('https://example.invalid/pdf-denied').then(()=>false,()=>true),popup:window.open('https://example.invalid')===null}))()`).then(value=>security.push(value)).catch(()=>{})
  })
  window.webContents.on('did-fail-load', (_e,code,description,url)=>console.error('LOAD',code,description,url))
  window.webContents.on('console-message', event=>consoleMessages.push(event.message))
  const prefs = (window.webContents as unknown as { getLastWebPreferences(): Electron.WebPreferences }).getLastWebPreferences()
  receipts.push({visible:window.isVisible(),prefs:{sandbox:prefs.sandbox,contextIsolation:prefs.contextIsolation,nodeIntegration:prefs.nodeIntegration,nodeIntegrationInWorker:prefs.nodeIntegrationInWorker}})
  window.webContents.debugger.attach('1.3')
  window.webContents.debugger.on('message', (_e,method,params) => {
    if (method === 'Target.attachedToTarget') targets.push(params.targetInfo)
    if (method === 'Network.requestWillBeSent') requests.push(params.request.url)
  })
  void window.webContents.debugger.sendCommand('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:false,flatten:true}).catch(()=>{})
  void window.webContents.debugger.sendCommand('Network.enable').catch(()=>{})
})
void app.whenReady().then(async () => {
try {
  const development = process.env.HER_PDF_TEST_DEVELOPMENT === '1'
  const signal = development ? AbortSignal.timeout(5000) : new AbortController().signal
  const bytes = new Uint8Array(await readFile(join(root,'tests/fixtures/documents/mixed.pdf')))
  console.log('INSPECT mixed');
  const inspect = await driver.execute(bytes,{kind:'inspect'},signal)
  if (!('pageCount' in inspect) || inspect.pageCount !== 3 || inspect.pages.map(p => p.textStatus).join(',') !== 'present,empty,present') throw new Error('Mixed physical text status mismatch')
  if (development) {
    const html = await readFile(join(root, 'out/renderer/pdf/index.html'), 'utf8')
    const script = html.match(/<script[^>]+src="([^"]+)"/)?.[1]
    if (!script) throw new Error('Development HTML has no entry script')
    const entryUrl = new URL(script, 'her://app/pdf/index.html').href
    if (!targets.some((target:any) => target.type === 'worker')) throw new Error('Development worker did not initialize')
    await driver.shutdown()
    if (BrowserWindow.getAllWindows().length) throw new Error('Development window leaked')
    writeFileSync(join(evidence, 'summary.json'), JSON.stringify({ passed:true, development:true, html, entryUrl, bridgeInitialized:true, inspect, targets, requests, receipts, windowsAfter:0 }, null, 2))
    app.exit(0)
    return
  }
  const reply = await driver.execute(bytes,{kind:'render',pageNumbers:[3,2,1]},signal)
  if (!('failures' in reply) || reply.failures.length || reply.pages.map(p=>p.pageNumber).join(',') !== '3,2,1') throw new Error('Page order mismatch')
  const pages = reply.pages.map(page => {
    const png = Buffer.from(page.bytes); const image = nativeImage.createFromBuffer(png); const size = image.getSize()
    if (size.width !== page.width || size.height !== page.height || Math.max(size.width,size.height)>2000 || image.isEmpty()) throw new Error('Invalid actual PNG size')
    const bitmap = image.toBitmap(); let nonwhite=0
    for(let i=0;i<bitmap.length;i+=4) if(bitmap[i]<150 && bitmap[i+1]<150 && bitmap[i+2]<150) nonwhite++
    if(nonwhite<500) throw new Error('Blank page image')
    writeFileSync(join(evidence,`page-${page.pageNumber}.png`),png)
    return {pageNumber:page.pageNumber,...size,nonwhite,bytes:png.length}
  })
  const encrypted = await readFile(join(root,'tests/fixtures/documents/encrypted.pdf'))
  let encryptedError=''; try { await driver.execute(encrypted,{kind:'inspect'},signal) } catch(e) { encryptedError=String(e) }
  if(!encryptedError.includes('加密')) throw new Error('Missing encrypted PDF error')
  let invalidError=''; try { await driver.execute(bytes,{kind:'render',pageNumbers:[4]},signal) } catch(e) { invalidError=String(e) }
  if(!invalidError.includes('页码')) throw new Error('Missing invalid page error')
  if(!targets.some((t:any)=>t.type==='worker' && t.url.includes('pdf.worker.mjs'))) throw new Error('No actual dedicated worker')
  if(!requests.some(url=>url.includes('standard_fonts/'))) throw new Error('No packaged font request')
  const chartInspection=await driver.execute(new Uint8Array(await readFile(join(root,'tests/fixtures/documents/chart.pdf'))),{kind:'inspect'},signal)
  if(!('pageCount' in chartInspection) || chartInspection.pages[0].textStatus!=='present') throw new Error('Chart text status incorrect')
  const chart=await driver.execute(new Uint8Array(await readFile(join(root,'tests/fixtures/documents/chart.pdf'))),{kind:'render',pageNumbers:[1]},signal)
  if(!('failures' in chart) || chart.pages.length!==1) throw new Error('Chart failed')
  const chartImage=nativeImage.createFromBuffer(Buffer.from(chart.pages[0].bytes)); const chartPixels=chartImage.toBitmap(); const chartSize=chartImage.getSize()
  // PDF point (150,200) is well inside the known red bar; nativeImage bitmap is BGRA.
  const pixel=(Math.floor(chartSize.height*(792-200)/792)*chartSize.width+Math.floor(chartSize.width*150/612))*4
  if(chartPixels[pixel]>20 || chartPixels[pixel+1]>20 || chartPixels[pixel+2]<230) throw new Error('Chart red bar missing')
  writeFileSync(join(evidence,'chart.png'),Buffer.from(chart.pages[0].bytes))
  const scanned=await driver.execute(new Uint8Array(await readFile(join(root,'tests/fixtures/documents/scanned.pdf'))),{kind:'inspect'},signal)
  if(!('pageCount' in scanned) || scanned.pageCount!==1 || scanned.pages[0].textStatus!=='empty') throw new Error('Scan status incorrect')
  let corruptError=''; try { await driver.execute(new Uint8Array(await readFile(join(root,'tests/fixtures/documents/corrupt.pdf'))),{kind:'inspect'},signal) } catch(e) {corruptError=String(e)}
  if(!corruptError.includes('无法读取')) throw new Error('Corrupt PDF accepted')
  const store=new HerStore(join(evidence,'integration.sqlite'))
  const files=new FileAccessService(store); const artifacts=new ToolArtifactStore(store,undefined,files)
  const context={conversationId:store.createConversation().id,runId:'pdf-real',callId:'pdf-real',signal,modelSupportsVision:true}
  const [grant]=await files.grant([join(root,'tests/fixtures/documents/mixed.pdf')],{scope:'conversation',kind:'file',conversationId:context.conversationId})
  const file=await files.reference(grant.id,'',context)
  const service=new PdfService(files,artifacts,driver); const registry=new SimpleToolRegistry(); registerPdfTools(registry,service)
  const integrated=await registry.execute('read_pdf_pages',{fileId:file.id,pageNumbers:[2,3]},context)
  const imageBlocks=integrated.content.filter(b=>b.type==='image')
  if(integrated.isError || imageBlocks.length!==2 || integrated.fileSources?.fileIds?.[0]!==file.id) throw new Error('Authorized tool integration failed')
  for(const image of imageBlocks) if(nativeImage.createFromBuffer(Buffer.from(await artifacts.read(image.artifactId,context))).isEmpty()) throw new Error('Artifact not PNG')
  await files.revoke(grant.id)
  let revoked=false; try {await artifacts.read(imageBlocks[0].artifactId,context)} catch {revoked=true}
  if(!revoked) throw new Error('Revoked artifact readable')
  const cancel=new AbortController()
  const priorTargets=targets.length
  const pending=driver.execute(new Uint8Array(await readFile(join(root,'tests/fixtures/documents/slow.pdf'))),{kind:'inspect'},cancel.signal)
  const stopTimer=setInterval(()=>{if(targets.length>priorTargets) {clearInterval(stopTimer);setTimeout(()=>cancel.abort(new Error('test stop after worker startup')),30)}},5)
  let cancelled=false;try{await pending}catch{cancelled=true}finally{clearInterval(stopTimer)}
  if(!cancelled || BrowserWindow.getAllWindows().length) throw new Error('Cancellation leaked work')
  if(!security.length || security.some((v:any)=>v.origin!=='her://app' || v.herApi!=='undefined' || v.node!=='undefined' || v.require!=='undefined' || !v.remote || !v.popup)) throw new Error('Sandbox boundary failed')
  await service.shutdown(); store.close()
  if(BrowserWindow.getAllWindows().length) throw new Error('Owned windows leaked')
  writeFileSync(join(evidence,'summary.json'),JSON.stringify({passed:true,versions:process.versions,inspect,pages,encryptedError,invalidError,corruptError,scanned,chartInspection,integrated,revoked,cancelled,security,consoleMessages,receipts,requests,targets,windowsAfter:0},null,2))
  app.exit(0)
} catch(error) { console.error(error); writeFileSync(join(evidence,'failure.json'),JSON.stringify({receipts,requests,targets},null,2)); await driver.shutdown(); app.exit(1) }

})
