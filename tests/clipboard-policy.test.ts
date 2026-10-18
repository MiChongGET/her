import { expect, it } from 'vitest'
import { clipboardWriteAllowed } from '../src/main/ipc-policy'

it('permits only text clipboard writes from the trusted main window and main frame', () => {
  expect(clipboardWriteAllowed('clipboard-sanitized-write', 'her://app/index.html', true, true)).toBe(true)
  for (const permission of ['clipboard-read', 'media', 'display-capture', 'notifications', 'unknown']) {
    expect(clipboardWriteAllowed(permission, 'her://app/index.html', true, true)).toBe(false)
  }
  expect(clipboardWriteAllowed('clipboard-sanitized-write', 'her://app/index.html', false, true)).toBe(false)
  expect(clipboardWriteAllowed('clipboard-sanitized-write', 'her://app/index.html', true, false)).toBe(false)
  expect(clipboardWriteAllowed('clipboard-sanitized-write', 'https://example.com/', true, true)).toBe(false)
  expect(clipboardWriteAllowed('clipboard-sanitized-write', '', true, true)).toBe(false)
  expect(clipboardWriteAllowed('clipboard-sanitized-write', 'her://app/pdf/index.html', true, true)).toBe(false)
  expect(clipboardWriteAllowed('clipboard-sanitized-write', 'http://localhost:5173/', true, true, 'http://localhost:5173/')).toBe(true)
  expect(clipboardWriteAllowed('clipboard-sanitized-write', 'http://localhost:5174/', true, true, 'http://localhost:5173/')).toBe(false)
})
