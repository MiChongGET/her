import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, expect, test } from '@playwright/test'

test('a fresh database boots the conversation sidebar without a renderer crash', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'her-startup-'))
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  const app = await _electron.launch({ args: [resolve('.')], env: { ...env, HER_DATA_DIR: directory } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible()
    await expect(page.getByText('还没有消息', { exact: true })).toBeVisible()
    const state = await page.evaluate(() => window.her.getBootstrap())
    expect(state.settings.activeProfileId).toBeNull()
    expect(state.conversations[0]).toMatchObject({ title: '新对话', lastMessage: '' })
    expect(typeof state.conversations[0].updatedAt).toBe('string')
    await page.reload()
    await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible()
    await expect(page.getByText('还没有消息', { exact: true })).toBeVisible()
  } finally {
    await app.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the new conversation button creates distinct conversations that survive restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'her-conversation-create-'))
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  const launch = () => _electron.launch({ args: [resolve('.')], env: { ...env, HER_DATA_DIR: directory } })
  let app = await launch()
  try {
    const page = await app.firstWindow()
    const createButton = page.locator('button.new-chat')
    await expect(createButton).toBeVisible()
    const initial = await page.evaluate(() => window.her.getBootstrap())
    for (let count = 2; count <= 3; count++) {
      await createButton.click()
      await expect(page.getByText('还没有消息', { exact: true })).toHaveCount(count)
    }
    await expect(page.getByText(/无法新建对话/)).toHaveCount(0)
    const created = await page.evaluate(() => window.her.getBootstrap())
    expect(created.conversations).toHaveLength(3)
    expect(new Set(created.conversations.map(item => item.id)).size).toBe(3)
    expect(created.conversations.some(item => item.id === initial.conversations[0].id)).toBe(true)
    await app.close()
    app = await launch()
    const restarted = await app.firstWindow()
    await expect(restarted.getByText('还没有消息', { exact: true })).toHaveCount(3)
    const restored = await restarted.evaluate(() => window.her.getBootstrap())
    expect(restored.conversations).toEqual(created.conversations)
  } finally {
    await app.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
