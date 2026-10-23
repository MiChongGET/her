import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, expect, test } from '@playwright/test'

test('a fresh database boots the conversation sidebar without a renderer crash', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'her-startup-'))
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  const app = await _electron.launch({ ...(process.env.HER_TEST_APP_EXECUTABLE ? { executablePath: process.env.HER_TEST_APP_EXECUTABLE, args: [] } : { args: [resolve('.')] }), env: { ...env, HER_DATA_DIR: directory } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '日常', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '日常', exact: true })).toHaveAttribute('aria-current', 'page')
    const state = await page.evaluate(() => window.her.getBootstrap())
    expect(state.settings.activeProfileId).toBeNull()
    expect(state.dailyConversationId).toEqual(expect.any(String))
    expect(state).not.toHaveProperty('conversations')
    await page.reload()
    await expect(page.getByRole('button', { name: '日常', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '日常', exact: true })).toHaveAttribute('aria-current', 'page')
  } finally {
    await app.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the new conversation button creates distinct conversations that survive restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'her-conversation-create-'))
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  const launch = () => _electron.launch({ ...(process.env.HER_TEST_APP_EXECUTABLE ? { executablePath: process.env.HER_TEST_APP_EXECUTABLE, args: [] } : { args: [resolve('.')] }), env: { ...env, HER_DATA_DIR: directory } })
  let app = await launch()
  try {
    const page = await app.firstWindow()
    await page.getByRole('button', { name: '一起在做的事', exact: true }).click()
    const createButton = page.getByRole('button', { name: '另开一个话题' }).first()
    await expect(createButton).toBeVisible()
    const initial = await page.evaluate(() => window.her.getBootstrap())
    for (let count = 1; count <= 2; count++) {
      await createButton.click()
      await page.getByRole('button', { name: '返回话题' }).click()
      await expect(page.locator('.topic-card')).toHaveCount(count)
    }
    await expect(page.getByText(/无法新建对话/)).toHaveCount(0)
    const created = await page.evaluate(() => window.her.listWorkItems())
    expect(created).toHaveLength(2)
    expect(new Set(created.map(item => item.conversation.id)).size).toBe(2)
    expect(created.some(item => item.conversation.id === initial.dailyConversationId)).toBe(false)
    await app.close()
    app = await launch()
    const restarted = await app.firstWindow()
    await expect(restarted.getByRole('button', { name: '日常', exact: true })).toHaveAttribute('aria-current', 'page')
    await restarted.getByRole('button', { name: '一起在做的事', exact: true }).click()
    await expect(restarted.locator('.topic-card')).toHaveCount(2)
    const restored = await restarted.evaluate(() => window.her.listWorkItems())
    expect(restored).toEqual(created)
  } finally {
    await app.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
