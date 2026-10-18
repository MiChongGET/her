import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, expect, test } from '@playwright/test'
import { HerStore } from '../../src/core/storage/store'

test('human resolution of older unknown survives reload and restart without changing outcome or replaying tools', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'her-resolution-e2e-')), path = join(directory, 'her.sqlite')
  const store = new HerStore(path), conversation = store.createConversation()
  store.addMessage({ id: 'u', conversationId: conversation.id, role: 'user', content: '本地未知状态验收', status: 'complete', createdAt: new Date().toISOString() })
  store.saveTaskRun({ id: 'old-run', requestId: 'old', conversationId: conversation.id, assistantMessageId: 'old-message', status: 'stopped', providerId: 'p', model: 'm', toolCallsCount: 1, activeMs: 1 })
  const original = { id: 'unknown-call', runId: 'old-run', name: 'browser_click', arguments: { target: 'e1' }, status: 'unknown' as const, dispatchPhase: 'preflight' as const, assessment: { effect: 'unknown' as const, target: 'browser:fixture:action', summary: '本地验收：预检可能重建标签，最终点击未发出' }, result: { isError: true, content: [{ type: 'text' as const, text: 'fixture disconnect' }] } }
  store.saveToolCall(original)
  store.addMessage({ id: 'old-message', conversationId: conversation.id, role: 'assistant', content: '等待人工处理', status: 'cancelled', createdAt: new Date().toISOString(), toolCalls: [original] })
  store.saveTaskRun({ id: 'latest-run', requestId: 'latest', conversationId: conversation.id, assistantMessageId: 'latest-message', status: 'stopped', providerId: 'p', model: 'm', toolCallsCount: 0, activeMs: 0 })
  store.addMessage({ id: 'latest-message', conversationId: conversation.id, role: 'assistant', content: '仍有较早未知记录', status: 'cancelled', createdAt: new Date().toISOString() })
  store.close()
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  let app = await _electron.launch({ args: [resolve('.')], env: { ...env, HER_DATA_DIR: directory } })
  try {
    let page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '已处理，解除阻塞' })).toBeVisible()
    await expect(page.getByRole('button', { name: '已处理，解除阻塞' })).toBeDisabled()
    const before = await page.evaluate(id => window.her.getConversationTask(id), conversation.id)
    expect(before?.unknownCalls?.[0].runId).toBe('old-run')
    await page.getByLabel(/我已在目标应用/).check()
    await page.getByRole('button', { name: '已处理，解除阻塞' }).click()
    await expect(page.getByText(/已记录人工处理/)).toBeVisible()
    expect(await page.evaluate(id => window.her.getConversationTask(id), conversation.id)).toMatchObject({ unknownCalls: [] })
    await page.reload()
    await expect(page.getByRole('button', { name: '已处理，解除阻塞' })).toHaveCount(0)
    await app.close()
    app = await _electron.launch({ args: [resolve('.')], env: { ...env, HER_DATA_DIR: directory } })
    page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible()
    expect(await page.evaluate(id => window.her.getConversationTask(id), conversation.id)).toMatchObject({ unknownCalls: [], run: { id: 'latest-run' } })
  } finally { await app.close() }
  try {
    const reopened = new HerStore(path)
    expect(reopened.listToolCalls('old-run')[0]).toMatchObject({ ...original, resolution: { decision: 'handled' } })
    expect(reopened.listToolCalls('latest-run')).toEqual([])
    reopened.close()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
