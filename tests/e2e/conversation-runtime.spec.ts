import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, expect, test } from '@playwright/test'
import { startFixtureServer } from '../pi-sdk/wire'

test('new conversation loads grants and messages, sends a real streaming request and restores its reply', async () => {
  const server = await startFixtureServer('openai-responses', 'text', { byteChunks: true })
  const directory = mkdtempSync(join(tmpdir(), 'her-chat-runtime-'))
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  const app = await _electron.launch({ args: [resolve('.')], env: { ...env, HER_DATA_DIR: directory } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible()
    await page.evaluate(async baseUrl => {
      const profile = await window.her.saveProfile({ name: 'fixture', protocol: 'openai-responses', baseUrl: baseUrl + '/v1', model: 'test-model', authMethod: 'none' })
      await window.her.selectProfile(profile.id)
    }, server.baseUrl)
    await page.reload()
    await page.locator('button.new-chat').click()
    const state = await page.evaluate(() => window.her.getBootstrap())
    const id = state.conversations[0].id
    expect(await page.evaluate(id => window.her.getMessages(id), id)).toEqual([])
    expect(await page.evaluate(id => window.her.listFileGrants(id), id)).toEqual([])
    await expect(page.getByText(/hasConversation|无法读取这段对话|资料读取失败/)).toHaveCount(0)
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('hello from the new conversation')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.locator('.message-assistant')).toContainText('你好🌙')
    await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible()
    await expect.poll(async () => (await page.evaluate(id => window.her.getMessages(id), id))[1]?.status).toBe('complete')
    expect(server.requests).toHaveLength(1)
    expect(server.requests[0].body).toMatchObject({ stream: true, model: 'test-model' })
    expect(server.requests[0].headers.authorization).toBeUndefined()
    await page.reload()
    await expect(page.locator('.message-user')).toContainText('hello from the new conversation')
    await expect(page.locator('.message-assistant')).toContainText('你好🌙')
    await expect(page.getByText(/hasConversation|无法读取这段对话|资料读取失败/)).toHaveCount(0)
    await expect(page.locator('.message').nth(0)).toHaveClass(/message-user/)
    await expect(page.locator('.message').nth(1)).toHaveClass(/message-assistant/)
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('second turn')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await expect(page.locator('.message-assistant')).toHaveCount(2)
    await expect.poll(() => server.requests.length).toBe(2)
    expect(JSON.stringify(server.requests[1].body)).toContain('hello from the new conversation')
    expect(JSON.stringify(server.requests[1].body)).toContain('你好🌙')
  } finally {
    await app.close()
    await server.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
