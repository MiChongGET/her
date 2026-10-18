// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import TaskStatus from '../src/renderer/src/TaskStatus'
import type { HerApi, TaskEvent } from '../src/shared/types'
afterEach(cleanup)
const task: TaskEvent = { requestId: 'r', conversationId: 'c', run: { id: 'latest', requestId: 'r', conversationId: 'c', assistantMessageId: 'm', providerId: 'p', model: 'm', status: 'paused', toolCallsCount: 1, activeMs: 0 }, unknownCalls: [{ runId: 'older', callId: 'call', revision: 'token', summary: 'Send to exact page', dispatchPhase: 'preflight' }] }
it('requires explicit human acknowledgement of the exact older unknown; resolution alone never continues or replays', async () => {
  const resolve = vi.fn(async () => ({ ...task, unknownCalls: [] })), proceed = vi.fn()
  window.her = { resolveUnknownToolCall: resolve } as unknown as HerApi
  render(<TaskStatus task={task} canContinue onContinue={proceed} onStop={() => {}} />)
  expect(screen.getByText('Send to exact page')).toBeTruthy()
  expect((screen.getByRole('button', { name: '已处理，解除阻塞' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByLabelText(/我已在目标应用/))
  fireEvent.click(screen.getByRole('button', { name: '已处理，解除阻塞' }))
  await waitFor(() => expect(resolve).toHaveBeenCalledWith({ conversationId: 'c', runId: 'older', callId: 'call', revision: 'token', decision: 'handled' }))
  expect(proceed).not.toHaveBeenCalled()
  expect(screen.getByText(/原动作仍为结果未知/)).toBeTruthy()
})
it('cannot resolve while task is active and does not hide a rejected stale resolution', async () => {
  const resolve = vi.fn(async () => { throw new Error('记录已变化') })
  window.her = { resolveUnknownToolCall: resolve } as unknown as HerApi
  const view = render(<TaskStatus task={{ ...task, run: { ...task.run, status: 'running' } }} canContinue={false} onContinue={() => {}} onStop={() => {}} />)
  expect(screen.queryByRole('button', { name: '已处理，解除阻塞' })).toBeNull()
  view.rerender(<TaskStatus task={task} canContinue onContinue={() => {}} onStop={() => {}} />)
  fireEvent.click(screen.getByLabelText(/我已在目标应用/)); fireEvent.click(screen.getByRole('button', { name: '放弃此动作，解除阻塞' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('记录已变化'))
  expect(screen.getByText('Send to exact page')).toBeTruthy()
})
it('preserves Continue for existing trusted native read recovery while the Host still blocks unsafe mutations', () => {
  const proceed = vi.fn()
  render(<TaskStatus task={task} canContinue onContinue={proceed} onStop={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: '继续任务' }))
  expect(proceed).toHaveBeenCalledOnce()
})
