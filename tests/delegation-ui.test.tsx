// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import TaskStatus from '../src/renderer/src/TaskStatus'
import type { HerApi, TaskEvent } from '../src/shared/types'

afterEach(cleanup)
const task: TaskEvent = { conversationId: 'owner', requestId: 'request', run: { id: 'run', conversationId: 'owner', requestId: 'request', assistantMessageId: 'assistant', providerId: 'provider', activeMs: 0, model: 'model', status: 'waiting_approval', toolCallsCount: 1 } as TaskEvent['run'], approval: { id: 'approval', runId: 'run', callId: 'call', revision: 'frozen', purpose: '安排私密工作', target: '已核对的小王', summary: '发送信息', actionLabel: '发送此消息', preview: { fields: [{ label: '账号', value: '工作账号' }], recipient: '小王的唯一地址', finalText: '精确最终正文', transferDestination: '已核对渠道' }, dataClasses: ['联系方式'], providerName: '实际传输服务', scopeSummary: '仅此收件人和正文' } }
function show(value = task) { return render(<TaskStatus task={value} canContinue={false} onContinue={() => {}} onStop={() => {}} />) }
it('shows frozen action facts and sends only a per-call choice', () => {
  const decideToolApproval = vi.fn().mockResolvedValue(undefined)
  window.her = { decideToolApproval } as unknown as HerApi
  show()
  for (const value of ['安排私密工作', '工作账号', '小王的唯一地址', '精确最终正文', '已核对渠道', '联系方式', '实际传输服务', '仅此收件人和正文']) expect(screen.getByText(value, { exact: false })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '发送此消息' }))
  expect(decideToolApproval).toHaveBeenCalledWith({ approvalId: 'approval', revision: 'frozen', decision: 'approve' })
})
it('does not invent transfer when no actual provider or destination is present', () => {
  show({ ...task, approval: { ...task.approval!, providerName: undefined, preview: { fields: [] } } })
  expect(screen.queryByText(/实际传输服务|传输目的地/)).toBeNull()
  expect(screen.getByText(/可拒绝此步骤/)).toBeTruthy()
})
it('ignores obsolete browser-wide allow flags', () => {
  show({ ...task, browserAutoApproved: true, approval: { ...task.approval!, allowConversation: true } })
  expect(screen.queryByRole('button', { name: /自动允许浏览器|关闭浏览器自动/ })).toBeNull()
})

it('original owner cards show scope and keep prepare separate from informed denial confirmation', async () => {
  const module = await import('../src/renderer/src/TaskStatus')
  expect(module).toHaveProperty('DelegationCards')
  const details = { conversationId: 'owner', scopes: [{ id: 'scope', revision: 2, scope: { purpose: '卡片目的', objects: ['对象甲'], completion: '交付', allowedCapabilities: ['read'], origins: [], constraints: {} } }], delegations: [{ id: 'delegation', revision: 1, status: 'active', resumeRequired: false, canResume: false, resumeControls: [], scope: { purpose: '卡片目的', objects: ['对象甲'], completion: '交付', allowedCapabilities: ['read'], origins: [], constraints: {} } }], controls: [{ id: 'control', revision: 1, kind: 'withdraw', effect: 'all', candidates: [{ delegationId: 'delegation', scopeRevision: 1, currentRevision: 1, purpose: '卡片目的', denials: [{ id: 'denial', target: '收件人甲', capability: 'message.send', dataClasses: ['联系方式'] }] }] }] }
  const prepareDelegationDenial = vi.fn(async () => { details.controls[0] = { ...details.controls[0], revision: 2, selection: { delegationId: 'delegation', scopeRevision: 1, denialId: 'denial' } } as typeof details.controls[0] })
  const confirmDelegationDenial = vi.fn().mockResolvedValue(undefined)
  window.her = { getDelegationDetails: vi.fn(async () => structuredClone(details)), prepareDelegationDenial, confirmDelegationDenial } as unknown as HerApi
  const Cards = module.DelegationCards
  render(<Cards conversationId="owner" refreshKey="1" />)
  fireEvent.click(await screen.findByRole('button', { name: '选择此拒绝步骤' }))
  expect(confirmDelegationDenial).not.toHaveBeenCalled()
  expect(prepareDelegationDenial).toHaveBeenCalledWith({ conversationId: 'owner', controlId: 'control', revision: 1, delegationId: 'delegation', scopeRevision: 1, denialId: 'denial' })
  const confirm = await screen.findByRole('button', { name: '明确撤回此步骤的拒绝' })
  expect(screen.getByText(/不会立即执行/)).toBeTruthy()
  fireEvent.click(confirm)
  expect(confirmDelegationDenial).toHaveBeenCalledWith({ conversationId: 'owner', controlId: 'control', revision: 2 })
})
it('owner change discards a late private detail result', async () => {
  const module = await import('../src/renderer/src/TaskStatus')
  expect(module).toHaveProperty('DelegationCards')
  let release!: (value: any) => void
  window.her = { getDelegationDetails: vi.fn((id: string) => id === 'owner' ? new Promise(done => { release = done }) : Promise.resolve({ conversationId: id, delegations: [], scopes: [], controls: [] })) } as unknown as HerApi
  const Cards = module.DelegationCards
  const view = render(<Cards conversationId="owner" refreshKey="1" />)
  view.rerender(<Cards conversationId="other" refreshKey="1" />)
  await import('@testing-library/react').then(async ({ act }) => { await act(async () => release({ conversationId: 'owner', scopes: [], controls: [], delegations: [{ id: 'd', revision: 1, status: 'active', resumeRequired: false, canResume: false, resumeControls: [], scope: { purpose: '不应泄露的私密详情', objects: [], completion: 'done', allowedCapabilities: [], origins: [], constraints: {} } }] })) })
  expect(screen.queryByText('不应泄露的私密详情')).toBeNull()
})

it('withdrawal control can be abandoned without granting permission or selecting a denial', async () => {
  const { DelegationCards } = await import('../src/renderer/src/TaskStatus')
  const resolveDelegationControl = vi.fn().mockResolvedValue(undefined)
  window.her = { getDelegationDetails: vi.fn().mockResolvedValue({ conversationId: 'owner', delegations: [], scopes: [], controls: [{ id: 'control', revision: 3, kind: 'withdraw', effect: 'all', candidates: [{ delegationId: 'd', scopeRevision: 1, currentRevision: 2, purpose: '原委托', denials: [] }] }] }), resolveDelegationControl } as unknown as HerApi
  render(<DelegationCards conversationId="owner" refreshKey="1" />)
  fireEvent.click(await screen.findByRole('button', { name: '保留拒绝，放弃此修改' }))
  expect(resolveDelegationControl).toHaveBeenCalledWith({ conversationId: 'owner', controlId: 'control', revision: 3, kind: 'ordinary', delegationIds: [], candidateRevisions: [{ delegationId: 'd', currentRevision: 2 }] })
})
it('input-only control card explicitly describes the ordinary input barrier being released', async () => {
  const { DelegationCards } = await import('../src/renderer/src/TaskStatus')
  const resolveDelegationControl = vi.fn().mockResolvedValue(undefined)
  window.her = { getDelegationDetails: vi.fn().mockResolvedValue({ conversationId: 'owner', delegations: [], scopes: [], controls: [{ id: 'control', revision: 3, kind: 'pause', effect: 'mutation', candidates: [], hasOwnedInputs: true }] }), resolveDelegationControl } as unknown as HerApi
  render(<DelegationCards conversationId="owner" refreshKey="1" />)
  const button = await screen.findByRole('button', { name: '此控制不针对当前话题，解除此处阻塞' })
  expect(screen.getByText(/此控制还阻塞了本话题的普通输入/)).toBeTruthy()
  fireEvent.click(button)
  expect(resolveDelegationControl).toHaveBeenCalledWith({ conversationId: 'owner', controlId: 'control', revision: 3, kind: 'ordinary', delegationIds: [], candidateRevisions: [], releaseOwnedInputs: true })
})
