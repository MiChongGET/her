import type { PdfInspection, PdfRenderReply, PdfRequest } from '../../shared/types'
interface PdfBridge {
  receive(callback: (input: {bytes:Uint8Array;request:PdfRequest}) => void): void
  complete(reply: {value?:PdfInspection|PdfRenderReply;error?:string}): void
}
const bridge = (window as unknown as {pdfBridge:PdfBridge}).pdfBridge
bridge.receive(async ({bytes,request}) => {
  let worker: import('pdfjs-dist').PDFWorker | undefined
  let loading: import('pdfjs-dist').PDFDocumentLoadingTask | undefined
  try {
    const path = '/assets/pdfjs/build/pdf.mjs'
    const pdfjs: typeof import('pdfjs-dist') = await import(/* @vite-ignore */ path)
    pdfjs.GlobalWorkerOptions.workerSrc = '/assets/pdfjs/build/pdf.worker.mjs'
    worker = new pdfjs.PDFWorker()
    await worker.promise
    if (!(worker.port instanceof Worker)) throw new Error('dedicated-worker-required')
    loading=pdfjs.getDocument({data:new Uint8Array(bytes),worker,cMapUrl:'/assets/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'/assets/pdfjs/standard_fonts/',wasmUrl:'/assets/pdfjs/wasm/',iccUrl:'/assets/pdfjs/iccs/',useWorkerFetch:false,useSystemFonts:false,enableXfa:false,stopAtErrors:true})
    const doc = await loading.promise
    if(request.kind==='inspect') {
      const pages: PdfInspection['pages']=[]
      for(let pageNumber=1;pageNumber<=doc.numPages;pageNumber++) {
        try {
          const page=await doc.getPage(pageNumber)
          const text=await page.getTextContent()
          pages.push({pageNumber,textStatus:text.items.some(item=>'str' in item && item.str.trim())?'present':'empty'})
          page.cleanup()
        } catch { pages.push({pageNumber,textStatus:'unknown'}) }
      }
      bridge.complete({value:{pageCount:doc.numPages,pages}})
    } else {
      if(!request.pageNumbers.length || request.pageNumbers.length>3 || new Set(request.pageNumbers).size!==request.pageNumbers.length || request.pageNumbers.some(n=>!Number.isSafeInteger(n)||n<1||n>doc.numPages)) {bridge.complete({error:'PDF 页码无效，请选择文档范围内 1 到 3 个不同的物理页。'});return}
      const result: PdfRenderReply={pages:[],failures:[]}
      for(const pageNumber of request.pageNumbers) {
        try {
          const page=await doc.getPage(pageNumber)
          const base=page.getViewport({scale:1}); const viewport=page.getViewport({scale:2000/Math.max(base.width,base.height)})
          const canvas=document.createElement('canvas'); canvas.width=Math.max(1,Math.floor(viewport.width)); canvas.height=Math.max(1,Math.floor(viewport.height))
          await page.render({canvas,viewport}).promise
          const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('png')),'image/png'))
          result.pages.push({pageNumber,bytes:new Uint8Array(await blob.arrayBuffer()),width:canvas.width,height:canvas.height})
          canvas.width=canvas.height=0; page.cleanup()
        } catch { result.failures.push({pageNumber,error:'页面无法渲染，内容尚未读取。'}) }
      }
      bridge.complete({value:result})
    }
  } catch(error) {
    bridge.complete({error:(error as Error)?.name==='PasswordException'?'PDF 已加密，需要先提供可读取的未加密副本。':'PDF 无法读取，请检查文件是否损坏或本地渲染资源是否完整。'})
  } finally { await loading?.destroy(); worker?.destroy() }
})
