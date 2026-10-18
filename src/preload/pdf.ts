import { contextBridge, ipcRenderer } from 'electron'
import type { PdfInspection, PdfRenderReply, PdfRequest } from '../shared/types'
contextBridge.exposeInMainWorld('pdfBridge', {
  receive: (callback: (input: {bytes:Uint8Array;request:PdfRequest}) => void) => {
    ipcRenderer.once('her:pdf-request', (_event, input) => callback(input))
  },
  complete: (reply: {value?:PdfInspection|PdfRenderReply;error?:string}) => ipcRenderer.send('her:pdf-result',reply)
})
