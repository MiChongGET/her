import { mkdir, readFile, writeFile, unlink, rm } from 'node:fs/promises'
import { unlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { FileAccessError } from '../files/errors'

export const DOCUMENT_CLEANUP_ERROR = '文档资料清理未完成，已保留清理记录。请检查应用数据目录权限后重试删除或重启 Her。'
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'

// The store records the Host UUID and conversation owner BEFORE any bytes are written.
export class DocumentCache {
  constructor(readonly directory: string) {}
  private paths(id: string): { cache: string; staging: string } {
    if (!this.directory || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('文档缓存不可用。')
    return { cache: join(this.directory, id + '.json'), staging: join(this.directory, 'staging', id) }
  }
  async stage(id: string, bytes: Uint8Array, extension: string): Promise<string> {
    if (!/^\.[a-z0-9]+$/.test(extension)) throw new Error('文档格式不正确。')
    const { staging } = this.paths(id)
    await mkdir(staging, { recursive: true, mode: 0o700 })
    const path = join(staging, 'source' + extension)
    await writeFile(path, bytes, { mode: 0o600, flag: 'wx' })
    return path
  }
  async read(id: string): Promise<string | undefined> {
    try {
      const value: unknown = JSON.parse(await readFile(this.paths(id).cache, 'utf8'))
      return typeof value === 'string' ? value : undefined
    } catch { return undefined }
  }
  async write(id: string, text: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await writeFile(this.paths(id).cache, JSON.stringify(text), { flag: 'wx', mode: 0o600 })
  }
  async removeStaging(id: string): Promise<void> {
    try { await rm(this.paths(id).staging, { recursive: true, force: true }) }
    catch { throw new FileAccessError(DOCUMENT_CLEANUP_ERROR) }
  }
  async remove(id: string): Promise<void> {
    try { await unlink(this.paths(id).cache) }
    catch (error) { if (!missing(error)) throw new FileAccessError(DOCUMENT_CLEANUP_ERROR) }
    await this.removeStaging(id)
  }
  removeSync(id: string): void {
    const paths = this.paths(id)
    try { unlinkSync(paths.cache) }
    catch (error) { if (!missing(error)) throw new FileAccessError(DOCUMENT_CLEANUP_ERROR) }
    try { rmSync(paths.staging, { recursive: true, force: true }) }
    catch { throw new FileAccessError(DOCUMENT_CLEANUP_ERROR) }
  }
}
