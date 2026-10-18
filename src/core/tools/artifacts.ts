import { FileAccessService } from '../files/access'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ArtifactReference } from '../../shared/types'
import { ARTIFACT_CLEANUP_ERROR, HerStore } from '../storage/store'
import type { ToolExecutionContext } from './types'

export class ToolArtifactStore {
  private readonly stopped = new AbortController()
  private readonly active = new Set<Promise<ArtifactReference>>()
  constructor(private readonly store: HerStore, private readonly lifetime?: AbortSignal, private readonly files?: FileAccessService) {}

  async put(bytes: Uint8Array, owner: { conversationId: string; sourceFileId?: string }, mimeType: string, taskContext?: ToolExecutionContext): Promise<ArtifactReference> {
    this.stopped.signal.throwIfAborted()
    const operation = this.putOwned(bytes, owner, mimeType, taskContext)
    this.active.add(operation)
    void operation.then(() => this.active.delete(operation), () => this.active.delete(operation))
    return operation
  }

  async shutdown(): Promise<void> {
    this.stopped.abort(new Error('图片存储正在停止。'))
    await Promise.allSettled([...this.active])
  }

  private async putOwned(bytes: Uint8Array, owner: { conversationId: string; sourceFileId?: string }, mimeType: string, taskContext?: ToolExecutionContext): Promise<ArtifactReference> {
    this.lifetime?.throwIfAborted()
    if (bytes.byteLength > 10 * 1024 * 1024) throw new Error('工具图片最大 10 MiB。')
    if (!mimeType.startsWith('image/')) throw new Error('工具资料必须是图片。')
    if (!this.store.hasConversation(owner.conversationId)) throw new Error('图片所属会话不存在。')
    if (!this.store.artifactDirectory) throw new Error('图片存储需要应用资料目录。')
    const context = { ...(taskContext ?? { ...owner, runId: 'artifact', callId: 'artifact' }), signal: AbortSignal.any([this.stopped.signal, ...this.lifetime ? [this.lifetime] : [], ...taskContext ? [taskContext.signal] : []]) }
    if (context.conversationId !== owner.conversationId) throw new Error('图片所属会话不匹配。')
    this.authorizeSource(owner.sourceFileId, context)
    const reference: ArtifactReference = { id: randomUUID(), ...owner, mimeType, byteLength: bytes.byteLength }
    const path = join(this.store.artifactDirectory, reference.id)
    this.store.beginArtifactFiles(reference.id, owner.conversationId)
    try {
      try { await mkdir(this.store.artifactDirectory, { recursive: true, mode: 0o700 }) }
      catch { throw new Error('图片资料写入失败，请检查应用数据目录权限和可用空间。') }
      context.signal.throwIfAborted()
      try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }) }
      catch { throw new Error('图片资料写入失败，请检查应用数据目录权限和可用空间。') }
      context.signal.throwIfAborted()
      if (!this.store.hasConversation(owner.conversationId)) throw new Error('图片所属会话不存在。')
      this.authorizeSource(owner.sourceFileId, context)
      this.store.saveArtifact(reference)
    } catch (error) {
      try { await unlink(path) }
      catch (cleanupError) { if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(ARTIFACT_CLEANUP_ERROR) }
      // After abort the aggregate quit deadline may already have closed SQLite.
      // Filesystem-only late cleanup leaves its durable owner for the next open.
      if (!context.signal.aborted && this.store.hasConversation(owner.conversationId)) this.store.forgetArtifactFiles(reference.id)
      throw error
    }
    return reference
  }

  async read(id: string, context: ToolExecutionContext): Promise<Uint8Array> {
    context.signal.throwIfAborted()
    const reference = this.authorize(id, context)
    let bytes: Buffer
    try { bytes = await readFile(join(this.store.artifactDirectory, reference.id), { signal: context.signal }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('图片资料文件缺失，无法读取。')
      throw error
    }
    context.signal.throwIfAborted()
    this.authorize(id, context)
    if (bytes.byteLength !== reference.byteLength) throw new Error('图片资料已损坏，无法读取。')
    return new Uint8Array(bytes)
  }

  private authorizeSource(id: string | undefined, context: ToolExecutionContext): void {
    context.signal.throwIfAborted()
    if (id === undefined) return
    if (!this.files) throw new Error('源文件授权不可用。')
    this.files.validateSources({ fileIds: [id] }, context)
  }

  authorize(id: string, context: ToolExecutionContext): ArtifactReference {
    this.lifetime?.throwIfAborted()
    this.stopped.signal.throwIfAborted()
    const reference = this.store.getArtifact(id)
    if (!reference || reference.conversationId !== context.conversationId || !this.store.hasConversation(context.conversationId)) {
      throw new Error('当前会话无权读取此图片资料。')
    }
    this.authorizeSource(reference.sourceFileId, context)
    return reference
  }
}
