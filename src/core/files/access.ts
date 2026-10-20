// @ts-nocheck - TODO 10.5: Fix store method calls after core agent integration
import { FileAccessError, fileEntryError } from './errors'
import { randomUUID } from 'node:crypto'
import { constants, realpathSync, statSync, type BigIntStats } from 'node:fs'
import { open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { FileGrant, FileReference, FileSources } from '../../shared/types'
import { HerStore, type StoredFileGrant } from '../storage/store'
import type { ToolExecutionContext } from '../tools/types'

export const MAX_FILE_BYTES = 50 * 1024 * 1024
const identity = (value: BigIntStats) => `${value.dev}:${value.ino}`
const version = (value: BigIntStats) => `${identity(value)}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`
const denied = () => new FileAccessError('文件授权或版本已失效，请重新选择文件。')
const inside = (root: string, path: string) => {
  const part = relative(root, path)
  return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)
}
const mimeType = (path: string) => ({
  '.pdf': 'application/pdf', '.json': 'application/json', '.md': 'text/markdown', '.csv': 'text/csv',
  '.txt': 'text/plain', '.log': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
}[extname(path).toLowerCase()] ?? 'application/octet-stream')

/** Main-process authority. Paths returned here are locators, never read capabilities. */
export class FileAccessService {
  private readonly revokeListeners = new Set<() => void>()
  constructor(private readonly store: HerStore, private readonly lifetime?: AbortSignal) {}

  /** Told after a grant is revoked, so work that relied on it can be stopped right away. */
  onRevoked(listener: () => void): () => void {
    this.revokeListeners.add(listener)
    return () => { this.revokeListeners.delete(listener) }
  }

  private active(context: ToolExecutionContext): void {
    this.lifetime?.throwIfAborted(); context.signal.throwIfAborted()
    if (!this.store.hasConversation(context.conversationId)) throw denied()
  }

  async grant(paths: string[], input: { scope: 'conversation' | 'persistent'; conversationId?: string; kind: 'file' | 'directory' }): Promise<FileGrant[]> {
    try {
      this.lifetime?.throwIfAborted()
      if (!Array.isArray(paths) || paths.length < 1 || paths.length > 100 ||
          !['conversation', 'persistent'].includes(input.scope) || !['file', 'directory'].includes(input.kind) ||
          (input.scope === 'conversation' ? !input.conversationId || !this.store.hasConversation(input.conversationId) : input.conversationId !== undefined)) throw denied()
      const pending: StoredFileGrant[] = []
      for (const path of paths) {
        if (typeof path !== 'string' || !isAbsolute(path)) throw denied()
        const canonical = await realpath(path); const info = await stat(canonical, { bigint: true })
        if (input.kind === 'file' ? !info.isFile() || info.size > BigInt(MAX_FILE_BYTES) : !info.isDirectory()) throw denied()
        pending.push({ grant: { id: randomUUID(), ...input, displayName: basename(canonical), revision: 1 }, path: canonical, identity: identity(info), revoked: false })
      }
      this.lifetime?.throwIfAborted()
      if (input.scope === 'conversation' && !this.store.hasConversation(input.conversationId!)) throw denied()
      for (const value of pending) {
        if (realpathSync(value.path) !== value.path || identity(statSync(value.path, { bigint: true })) !== value.identity) throw denied()
      }
      for (const value of pending) this.store.saveFileGrant(value)
      return pending.map(value => value.grant)
    } catch (error) {
      this.lifetime?.throwIfAborted()
      throw fileEntryError(error)
    }
  }

  async revoke(grantId: string): Promise<void> {
    this.lifetime?.throwIfAborted()
    const value = this.store.getFileGrant(grantId)
    if (!value) throw denied()
    if (!value.revoked) this.store.saveFileGrant({ ...value, revoked: true, grant: { ...value.grant, revision: value.grant.revision + 1 } })
    for (const listener of this.revokeListeners) try { listener() } catch { /* one listener must not block the rest */ }
  }

  listPersistentGrants(): FileGrant[] {
    this.lifetime?.throwIfAborted()
    return this.store.listFileGrants().filter(value => !value.revoked && value.grant.scope === 'persistent').map(value => value.grant)
  }

  listGrants(conversationId: string): FileGrant[] {
    this.active({ conversationId, runId: 'list', callId: 'list', signal: this.lifetime ?? new AbortController().signal })
    return this.store.listFileGrants().filter(value => !value.revoked && (value.grant.scope === 'persistent' || value.grant.conversationId === conversationId)).map(value => value.grant)
  }

  checkGrant(grantId: string, context: ToolExecutionContext, revision?: number): StoredFileGrant {
    this.active(context)
    const value = this.store.getFileGrant(grantId)
    if (!value || value.revoked || (revision !== undefined && value.grant.revision !== revision) ||
        (value.grant.scope === 'conversation' && value.grant.conversationId !== context.conversationId)) throw denied()
    try {
      const info = statSync(value.path, { bigint: true })
      if (realpathSync(value.path) !== value.path || identity(info) !== value.identity ||
          (value.grant.kind === 'directory' ? !info.isDirectory() : !info.isFile())) throw denied()
    } catch (error) { throw fileEntryError(error) }
    return value
  }

  /** Synchronous final fence: no await between this check and publication/HTTP dispatch. */
  validateSources(sources: FileSources | undefined, context: ToolExecutionContext): void {
    this.active(context)
    for (const grant of sources?.grants ?? []) this.checkGrant(grant.id, context, grant.revision)
    for (const id of sources?.fileIds ?? []) this.checkFile(id, context)
  }

  private checkFile(id: string, context: ToolExecutionContext) {
    this.active(context)
    const value = this.store.getFileReference(id)
    if (!value || value.conversationId !== context.conversationId) throw denied()
    const grant = this.checkGrant(value.reference.grantId, context, value.grantRevision)
    try {
      const canonical = realpathSync(value.path)
      const info = statSync(canonical, { bigint: true })
      if (canonical !== value.path || !inside(grant.path, canonical) || (grant.grant.kind === 'file' && canonical !== grant.path) ||
          !info.isFile() || info.size > BigInt(MAX_FILE_BYTES) || version(info) !== value.reference.version) throw denied()
    } catch (error) { throw fileEntryError(error) }
    this.active(context)
    return value
  }

  async candidate(grantId: string, relativePath: string, context: ToolExecutionContext): Promise<{ path: string; info: BigIntStats; grant: FileGrant }> {
    const value = this.checkGrant(grantId, context)
    if (typeof relativePath !== 'string' || isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..') || relativePath.includes('\0')) throw denied()
    if (value.grant.kind === 'file' && relativePath !== '') throw denied()
    try {
      const path = await realpath(resolve(value.path, relativePath))
      if (!inside(value.path, path) || (value.grant.kind === 'file' && path !== value.path)) throw denied()
      const info = await stat(path, { bigint: true })
      this.checkGrant(grantId, context, value.grant.revision)
      if (realpathSync(path) !== path || version(statSync(path, { bigint: true })) !== version(info)) throw denied()
      return { path, info, grant: value.grant }
    } catch (error) { this.active(context); throw fileEntryError(error) }
  }

  async reference(grantId: string, relativePath: string, context: ToolExecutionContext): Promise<FileReference> {
    try {
      const candidate = await this.candidate(grantId, relativePath, context)
      if (!candidate.info.isFile() || candidate.info.size > BigInt(MAX_FILE_BYTES)) throw denied()
      this.checkGrant(grantId, context, candidate.grant.revision)
      if (version(statSync(candidate.path, { bigint: true })) !== version(candidate.info)) throw denied()
      const reference: FileReference = { id: randomUUID(), grantId, name: basename(candidate.path), mimeType: mimeType(candidate.path), size: Number(candidate.info.size), version: version(candidate.info) }
      this.store.saveFileReference({ reference, conversationId: context.conversationId, path: candidate.path, grantRevision: candidate.grant.revision })
      return reference
    } catch (error) {
      this.active(context)
      throw fileEntryError(error)
    }
  }

  async resolve(fileId: string, context: ToolExecutionContext): Promise<{ path: string; reference: FileReference }> {
    const value = this.checkFile(fileId, context)
    return { path: value.path, reference: value.reference }
  }

  /** Downstream parsers must consume this fd (or a private copy made from it), never reopen resolve().path. */
  async withFile<T>(fileId: string, context: ToolExecutionContext, consume: (handle: FileHandle, reference: FileReference) => Promise<T>): Promise<T> {
    const value = this.checkFile(fileId, context)
    let handle: FileHandle | undefined
    let result: T
    try {
      handle = await open(value.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const before = await handle.stat({ bigint: true })
      if (!before.isFile() || version(before) !== value.reference.version) throw denied()
      this.checkFile(fileId, context)
      result = await consume(handle, value.reference)
      const after = await handle.stat({ bigint: true })
      if (version(after) !== value.reference.version) throw denied()
      this.checkFile(fileId, context)
    } catch (error) {
      this.active(context)
      throw fileEntryError(error)
    } finally { await handle?.close() }
    this.checkFile(fileId, context)
    return result
  }

  async readBytes(fileId: string, context: ToolExecutionContext): Promise<Uint8Array> {
    const bytes = await this.withFile(fileId, context, async (handle, reference) => {
      const parts: Buffer[] = []; let total = 0
      while (true) {
        this.validateSources({ fileIds: [fileId] }, context)
        const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_FILE_BYTES + 1 - total))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, total)
        if (!bytesRead) break
        total += bytesRead
        if (total > MAX_FILE_BYTES || total > reference.size) throw denied()
        parts.push(buffer.subarray(0, bytesRead))
      }
      return Buffer.concat(parts)
    })
    this.validateSources({ fileIds: [fileId] }, context)
    return bytes
  }

  async readText(fileId: string, context: ToolExecutionContext, offset = 0, length = 30_000) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 30_000) throw new FileAccessError('读取范围不正确。')
    const bytes = await this.readBytes(fileId, context)
    let all: string
    try { all = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new FileAccessError('此文件不是 UTF-8 文本，请使用文档读取工具。') }
    if (all.includes('\0')) throw new FileAccessError('此文件不是文本，请使用文档读取工具。')
    const text = all.slice(offset, offset + length)
    const end = Math.min(offset + text.length, all.length)
    this.validateSources({ fileIds: [fileId] }, context)
    const reference = this.store.getFileReference(fileId)!.reference
    return { source: reference, range: { offset: Math.min(offset, all.length), length: text.length }, truncated: end < all.length, ...(end < all.length ? { nextCursor: String(end) } : {}), text }
  }
}
