import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, expect, test } from '@playwright/test'

test('native encrypted credentials survive saving a profile without re-entering its key', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'her-credentials-'))
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  const app = await _electron.launch({ args: [resolve('.')], env: { ...env, HER_DATA_DIR: directory } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible()
    const saved = await page.evaluate(async () => {
      const input = {
        name: 'Native credential fixture', protocol: 'openai-responses' as const,
        baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture-model', authMethod: 'api-key' as const
      }
      const created = await window.her.saveProfile({ ...input, apiKey: 'synthetic-credential-fixture' })
      return window.her.saveProfile({ ...input, id: created.id, name: 'Renamed credential fixture' })
    })
    expect(saved).toMatchObject({ name: 'Renamed credential fixture', hasApiKey: true })
    expect(saved).not.toHaveProperty('apiKey')
  } finally {
    await app.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
