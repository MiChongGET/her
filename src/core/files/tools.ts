import { FileAccessError, fileEntryError } from './errors'
import { createHash } from 'node:crypto'
import { opendir } from 'node:fs/promises'
import { relative } from 'node:path'
import type { FileReference, FileSources, ToolResult } from '../../shared/types'
import { fitsModelToolResult } from '../tools/result-format'
import { SimpleToolRegistry } from '../tools/registry'
import type { ToolExecutionContext } from '../tools/types'
import { FileAccessService, MAX_FILE_BYTES } from './access'

interface Entry { name: string; relativePath: string; kind: 'file' | 'directory'; file?: FileReference; range?: { offset: number; length: number }; text?: string }
const result = (data: Record<string, unknown>, fileSources: FileSources, truncated = false): ToolResult => ({ content: [], structuredContent: data, fileSources, truncated })

export function registerFileTools(registry: SimpleToolRegistry, access: FileAccessService): void {
  async function guarded(context: ToolExecutionContext, execute: () => Promise<ToolResult>): Promise<ToolResult> {
    try {
      const output = await execute()
      access.validateSources(output.fileSources, context)
      return output
    }
    catch (error) { context.signal.throwIfAborted(); throw fileEntryError(error) }
  }
  async function browse(mode: 'list_files' | 'search_files' | 'search_text', args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const grantId = args.grantId as string
    const root = access.checkGrant(grantId, context)
    const start = typeof args.relativePath === 'string' ? args.relativePath : ''
    const query = typeof args.query === 'string' ? args.query : ''
    const candidates: { path: string; name: string; kind: 'file' | 'directory'; version: string }[] = []
    const visited = new Set<string>()
    let observed = 0
    async function walk(part: string): Promise<void> {
      const current = await access.candidate(grantId, part, context)
      if (!current.info.isDirectory()) {
        if (current.info.isFile()) candidates.push({ path: part, name: root.grant.displayName, kind: 'file', version: `${current.info.ino}:${current.info.size}:${current.info.mtimeNs}:${current.info.ctimeNs}` })
        return
      }
      if (visited.has(current.path)) return
      visited.add(current.path)
      const directory = await opendir(current.path)
      for await (const child of directory) {
        access.checkGrant(grantId, context, root.grant.revision)
        if (++observed > 10_000) throw new FileAccessError('目录超过本次 10000 项扫描上限，请缩小授权目录。')
        const path = relative(root.path, current.path) + '/' + child.name
        const childPath = path.startsWith('/') ? path.slice(1) : path
        let item
        try { item = await access.candidate(grantId, childPath, context) }
        catch { access.checkGrant(grantId, context, root.grant.revision); continue }
        if (!item.info.isFile() && !item.info.isDirectory()) continue
        const kind = item.info.isDirectory() ? 'directory' : 'file'
        candidates.push({ path: childPath, name: child.name, kind, version: `${item.info.ino}:${item.info.size}:${item.info.mtimeNs}:${item.info.ctimeNs}` })
        if (mode !== 'list_files' && kind === 'directory') await walk(childPath)
      }
      await access.candidate(grantId, part, context)
    }
    await walk(start)
    candidates.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    const fingerprint = createHash('sha256').update(JSON.stringify([context.conversationId, grantId, root.grant.revision, mode, start, query, candidates])).digest('hex')
    let index = 0
    if (args.cursor !== undefined) {
      const [signature, offset] = String(args.cursor).split(':')
      if (signature !== fingerprint || !/^\d+$/.test(offset ?? '') || !Number.isSafeInteger(Number(offset)) || Number(offset) > candidates.length) throw new FileAccessError('目录或查询已变化，请从第一页重新读取。')
      index = Number(offset)
    }
    const pageStart = index
    const page = (entries: Entry[], nextIndex: number, reserveBudget = false) => {
      // Skipped candidates can grow cursor/scanned digits after the last accepted match.
      // Reserve the bounded scan maximum and continuation marker when admitting entries.
      const truncated = reserveBudget || nextIndex < candidates.length
      const sources: FileSources = { fileIds: entries.flatMap(entry => entry.file ? [entry.file.id] : []), grants: [{ id: grantId, revision: root.grant.revision }] }
      return result({ scope: { grantId, relativePath: start }, scanned: reserveBudget ? 10_000 : nextIndex - pageStart, truncated, ...(truncated ? { nextCursor: `${fingerprint}:${reserveBudget ? 10_000 : nextIndex}` } : {}), entries }, sources, truncated)
    }
    const entries: Entry[] = []
    let bytes = 0
    while (index < candidates.length && entries.length < 100) {
      const item = candidates[index++]!
      access.checkGrant(grantId, context, root.grant.revision)
      if (mode === 'search_files' && !item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue
      if (mode === 'search_text' && item.kind !== 'file') continue
      const entry: Entry = { name: item.name, relativePath: item.path, kind: item.kind }
      if (item.kind === 'file') {
        let file: FileReference
        try { file = await access.reference(grantId, item.path, context) }
        catch { access.checkGrant(grantId, context, root.grant.revision); continue }
        if (mode === 'search_text') {
          if (bytes + file.size > MAX_FILE_BYTES) { index--; break }
          bytes += file.size
          const data = await access.readBytes(file.id, context)
          let text: string
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(data) } catch { continue }
          if (text.includes('\0')) continue
          const offset = text.indexOf(query)
          if (offset < 0) continue
          entry.range = { offset, length: query.length }; entry.text = text.slice(offset, offset + query.length)
        }
        entry.file = file
      }
      if (!fitsModelToolResult(page([...entries, entry], index, true))) {
        index--
        if (!entries.length) throw new FileAccessError('单条文件信息超过返回上限，请缩小目录范围。')
        break
      }
      entries.push(entry)
    }
    const output = page(entries, index)
    if (!fitsModelToolResult(output)) throw new FileAccessError('文件信息超过返回上限，请缩小目录范围。')
    access.validateSources(output.fileSources, context)
    return output
  }
  for (const name of ['list_files', 'search_files', 'search_text'] as const) {
    registry.register({ name, description: name === 'search_text' ? 'Search UTF-8 text in authorized files; returns the first match per file and a cursor for remaining files.' : 'List or search authorized files, at most 100 entries per page. Use nextCursor until absent.', parameters: {
      type: 'object', additionalProperties: false,
      properties: { grantId: { type: 'string', minLength: 1 }, ...(name === 'list_files' ? { relativePath: { type: 'string' } } : { query: { type: 'string', minLength: 1, maxLength: 1000 } }), cursor: { type: 'string', maxLength: 200 } },
      required: name === 'list_files' ? ['grantId'] : ['grantId', 'query']
    } }, (args, context) => guarded(context, () => browse(name, args, context)), { assess: async args => ({ effect: 'read', target: `grant:${args.grantId}`, summary: '读取已授权的本地资料' }) })
  }
  registry.register({ name: 'read_text', description: 'Read an authorized UTF-8 file segment. Offsets/lengths are UTF-16 code units; truncated applies only to this segment.', parameters: {
    type: 'object', additionalProperties: false, properties: { fileId: { type: 'string', minLength: 1 }, offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1, maximum: 30_000 } }, required: ['fileId']
  } }, (args, context) => guarded(context, async () => {
    const data = await access.readText(args.fileId as string, context, args.offset as number | undefined, args.length as number | undefined)
    const sources = { fileIds: [args.fileId as string] }
    const page = (length: number) => {
      const truncated = data.truncated || length < data.text.length
      return result({ ...data, range: { offset: data.range.offset, length }, truncated,
        nextCursor: truncated ? String(data.range.offset + length) : undefined, text: data.text.slice(0, length) }, sources, truncated)
    }
    const full = page(data.text.length)
    if (fitsModelToolResult(full)) { access.validateSources(sources, context); return full }
    let low = 0; let high = data.text.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (fitsModelToolResult(page(middle))) low = middle
      else high = middle - 1
    }
    if (!low || !fitsModelToolResult(page(low))) throw new FileAccessError('文件来源信息超过返回上限，请重新选择文件。')
    access.validateSources(sources, context)
    return page(low)
  }), { assess: async args => ({ effect: 'read', target: `file:${args.fileId}`, summary: '读取已授权的文本片段' }) })
}
