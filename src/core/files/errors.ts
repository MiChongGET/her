/** Safe messages from Her's file entry points; never retain errno paths or causes. */
export class FileAccessError extends Error {}

export function fileEntryError(error: unknown): Error {
  if (error instanceof FileAccessError || (error instanceof Error && error.name === 'AbortError')) return error
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'EACCES' || code === 'EPERM') return new FileAccessError('没有读取文件或目录的权限，请检查系统权限后重试。')
  if (code === 'ENOENT' || code === 'ENOTDIR') return new FileAccessError('文件或目录已不存在，请重新选择。')
  return new FileAccessError('资料读取失败，请检查文件是否存在以及读取权限。')
}
