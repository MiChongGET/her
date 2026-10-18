import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, expect, test } from '@playwright/test'

test('real Electron retains disk File provenance through the isolated preload bridge', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'her-file-bridge-'))
  const documentPath = join(directory, 'fixture.txt')
  writeFileSync(documentPath, 'local constant fixture')
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  const app = await _electron.launch({ args: [resolve('.')], env: { ...env, HER_DATA_DIR: join(directory, 'data') } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '添加资料', exact: true })).toBeVisible()
    const conversationId = await page.evaluate(async () => (await window.her.createConversation()).id)
    await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'disk-provenance-probe'; document.body.append(input) })
    await page.locator('#disk-provenance-probe').setInputFiles(documentPath)
    const files = await page.evaluate(async id => {
      const input = document.querySelector<HTMLInputElement>('#disk-provenance-probe')!
      return window.her.addDroppedFiles(id, Array.from(input.files!))
    }, conversationId)
    expect(files[0]).toMatchObject({ name: 'fixture.txt', mimeType: 'text/plain', size: 22 })
    expect(JSON.stringify(files)).not.toContain(directory)
    const rejection = await page.evaluate(async id => {
      try { await window.her.addDroppedFiles(id, [new File(['synthetic'], 'fake.txt')]); return '' }
      catch (error) { return (error as Error).message }
    }, conversationId)
    expect(rejection).toContain('磁盘')
    await page.evaluate(async ({ id, grantId }) => {
      await window.her.revokeFileGrant(grantId)
      const grants = await window.her.listFileGrants(id)
      if (grants.length) throw new Error('revocation retained active grant')
    }, { id: conversationId, grantId: files[0].grantId })
    const stale = await page.evaluate(async ({ id, fileId }) => {
      try { await window.her.openFileSource({ conversationId: id, fileId }); return '' }
      catch (error) { return (error as Error).message }
    }, { id: conversationId, fileId: files[0].id })
    expect(stale).toContain('失效')
  } finally {
    await app.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
