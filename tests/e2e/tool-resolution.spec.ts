import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, expect, test } from '@playwright/test'
import { HerStore } from '../../src/core/storage/store'
import { dataPaths } from '../../src/core/storage/paths'

test('human decision about an older unknown outcome survives reload and restart without changing the call or replaying tools', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'her-resolution-e2e-')), paths = dataPaths(directory)
  const conversationId = randomUUID()
  const store = new HerStore(paths.database)
  store.createWorkConversation(conversationId, randomUUID(), '本地未知状态验收')
  // An older task that stopped after dispatching an action whose outcome is unknown, then a newer task that ended normally.
  const seed = (taskId: string, status: 'stopped' | 'completed') => {
    const requestId = randomUUID()
    store.enqueueInput(conversationId, taskId, null, requestId); store.claimInput(requestId); store.updateInputStatus(requestId, 'cancelled')
    store.createTask({ id: taskId, conversationId, requestId, generation: 0, status, serviceId: 's', modelId: 'm', configRevision: 1, error: null, assistantMessageId: `${taskId}-message` })
  }
  seed('old-run', 'stopped')
  store.insertToolCall({ taskId: 'old-run', callId: 'unknown-call', toolName: 'browser_click', args: '{"target":"e1"}', effect: 'unknown', target: 'browser:b:action' })
  store.updateToolCall('old-run', 'unknown-call', { status: 'unknown', phase: 'action', dispatched: true, result: '{"isError":true,"content":[]}' })
  store.quarantineTarget('browser:b:action', conversationId, 'old-run', 'unknown-call')
  seed('latest-run', 'stopped')
  const before = store.getToolCallRecord('old-run', 'unknown-call')
  store.close()

  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  const launch = () => _electron.launch({ ...(process.env.HER_TEST_APP_EXECUTABLE ? { executablePath: process.env.HER_TEST_APP_EXECUTABLE, args: [] } : { args: [resolve('.')] }), env: { ...env, HER_DATA_DIR: directory } })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    await page.getByRole('button', { name: '一起在做的事', exact: true }).click()
    await page.getByRole('button', { name: '本地未知状态验收', exact: true }).click()
    const resolveButton = page.getByRole('button', { name: '已处理，解除阻塞' })
    await expect(resolveButton).toBeVisible()
    await expect(resolveButton).toBeDisabled()
    const shown = await page.evaluate(id => window.her.getConversationTask(id), conversationId)
    expect(shown?.unknownCalls?.[0].runId).toBe('old-run')
    await page.getByLabel(/我已在目标应用/).check()
    await resolveButton.click()
    await expect(page.getByText(/已记录人工处理/)).toBeVisible()
    expect((await page.evaluate(id => window.her.getConversationTask(id), conversationId))?.unknownCalls ?? []).toEqual([])
    await page.reload()
    await page.getByRole('button', { name: '一起在做的事', exact: true }).click()
    await page.getByRole('button', { name: '本地未知状态验收', exact: true }).click()
    await expect(page.getByRole('button', { name: '已处理，解除阻塞' })).toHaveCount(0)
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '日常', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '一起在做的事', exact: true }).click()
    await page.getByRole('button', { name: '本地未知状态验收', exact: true }).click()
    const restarted = await page.evaluate(id => window.her.getConversationTask(id), conversationId)
    expect(restarted?.unknownCalls ?? []).toEqual([])
    expect(restarted?.run.id).toBe('latest-run')
  } finally { await app.close() }
  try {
    const reopened = new HerStore(paths.database)
    // Only the decision was added: the call is still unknown, with its result untouched, and nothing was replayed.
    expect(reopened.getToolCallRecord('old-run', 'unknown-call')).toEqual({ ...before, resolution: 'handled' })
    expect(reopened.countToolCalls('latest-run')).toBe(0)
    expect(reopened.listQuarantinedTargets()).toEqual([])
    reopened.close()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
