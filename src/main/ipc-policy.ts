export function isTrustedRenderer(url: string, developmentUrl: string | undefined, mainFrame: boolean): boolean {
  if (!mainFrame) return false
  try {
    const current = new URL(url)
    if (developmentUrl) return current.origin === new URL(developmentUrl).origin
    return current.protocol === 'her:' && current.hostname === 'app' && current.pathname === '/index.html'
  } catch { return false }
}

export function externalUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('链接不正确。')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('链接不正确。') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('仅支持打开 HTTP 或 HTTPS 网页链接。')
  }
  return url.toString()
}

export function clipboardWriteAllowed(permission: string, requestingUrl: string, mainFrame: boolean, sameWindow: boolean, developmentUrl?: string): boolean {
  return sameWindow && permission === 'clipboard-sanitized-write' && isTrustedRenderer(requestingUrl, developmentUrl, mainFrame)
}
