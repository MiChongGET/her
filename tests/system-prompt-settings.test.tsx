// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import SettingsPanel from '../src/renderer/src/SettingsPanel'
import type { HerApi, SystemPromptPreview, SystemPromptPreviewInput } from '../src/shared/types'

afterEach(cleanup)
const settings = { activeProfileId: null, shortcut: '', stopShortcut: '', launchAtLogin: false, appearance: 'light' as const }
const props = { profiles: [], settings, dataDirectory: 'test', onClose() {}, onAppearanceChanged() {}, onSelectProfile: async () => {}, onConfigurationChanged: async () => ({ profiles: [], settings }) }
const actual = { conversationId: 'topic', profileId: 'service', model: 'recorded-model', usedAt: '2026-10-24T00:00:00.000Z', text: 'ACTUAL REQUEST TEXT', parts: [{ id: 'base', title: '基础提示词', source: '全局编辑内容', content: 'ACTUAL REQUEST TEXT', status: 'included' as const }], toolNames: ['read_text'] }
function result(input: SystemPromptPreviewInput): SystemPromptPreview {
  return { contextWindow: 128000, parts: [{ id: 'base', title: '基础提示词', source: '全局编辑内容', content: input.prompt, status: 'included' }, { id: 'tools', title: '工具与权限', source: 'Host 工具发现与审批机制', content: 'DISCOVER WHEN RUNNING', status: 'conditional' }], actual: null }
}
function setup(overrides: Partial<HerApi> = {}) {
  const save = vi.fn(async () => {})
  window.her = { listModelCatalog: async () => [], getSystemPrompt: async () => 'SAVED CUSTOM', getDefaultSystemPrompt: async () => 'NEW DEFAULT', setSystemPrompt: save,
    previewSystemPrompt: vi.fn(async (input: SystemPromptPreviewInput) => result(input)), ...overrides } as unknown as HerApi
  const view = render(<SettingsPanel {...props} conversationId="topic" />)
  fireEvent.click(screen.getByRole('tab', { name: '系统提示词' }))
  return { ...view, save }
}

it('previews unsaved text with sources and conditions without saving it', async () => {
  const { save } = setup()
  const editor = await screen.findByLabelText('系统提示词')
  await waitFor(() => expect((editor as HTMLTextAreaElement).value).toBe('SAVED CUSTOM'))
  fireEvent.change(editor, { target: { value: 'UNSAVED EDIT' } })
  fireEvent.click(screen.getByRole('button', { name: '刷新预览' }))
  expect(await screen.findByText('UNSAVED EDIT', { selector: 'pre' })).toBeTruthy()
  expect(screen.getByText('Host 工具发现与审批机制')).toBeTruthy()
  expect(screen.getByText('条件性加入')).toBeTruthy()
  expect(save).not.toHaveBeenCalled()
})

it('shows actual request metadata separately from the editable draft', async () => {
  setup({ previewSystemPrompt: async input => ({ ...result(input), actual }) })
  await waitFor(() => expect((screen.getByLabelText('系统提示词') as HTMLTextAreaElement).value).toBe('SAVED CUSTOM'))
  fireEvent.click(screen.getByRole('tab', { name: '最近实际使用' }))
  const record = await screen.findByLabelText('实际系统提示词') as HTMLTextAreaElement
  expect(record.value).toBe('ACTUAL REQUEST TEXT')
  expect(record.readOnly).toBe(true)
  expect(screen.getByText(/recorded-model/)).toBeTruthy()
  expect((screen.getByLabelText('系统提示词') as HTMLTextAreaElement).value).toBe('SAVED CUSTOM')
})

it('shows an honest empty state when no request has been recorded', async () => {
  setup()
  await waitFor(() => expect((screen.getByLabelText('系统提示词') as HTMLTextAreaElement).value).toBe('SAVED CUSTOM'))
  fireEvent.click(screen.getByRole('tab', { name: '最近实际使用' }))
  expect(await screen.findByText(/暂无实际记录/)).toBeTruthy()
  expect(screen.queryByLabelText('实际系统提示词')).toBeNull()
})

it.each(['draft', 'topic', 'model'] as const)('discards a preview that arrives after the %s has changed', async change => {
  let resolve!: (value: SystemPromptPreview) => void
  const response = new Promise<SystemPromptPreview>(done => { resolve = done })
  const view = setup({ previewSystemPrompt: () => response })
  const editor = screen.getByLabelText('系统提示词') as HTMLTextAreaElement
  await waitFor(() => expect(editor.value).toBe('SAVED CUSTOM'))
  fireEvent.click(screen.getByRole('button', { name: '刷新预览' }))
  if (change === 'draft') fireEvent.change(editor, { target: { value: 'LATEST DRAFT' } })
  else view.rerender(<SettingsPanel {...props} conversationId={change === 'topic' ? 'another-topic' : 'topic'} promptModel={change === 'model' ? 'another-model' : undefined} />)
  await act(async () => resolve({ ...result({ prompt: 'STALE RESULT' }), actual }))
  expect(editor.value).toBe(change === 'draft' ? 'LATEST DRAFT' : 'SAVED CUSTOM')
  expect(screen.queryByText('STALE RESULT', { selector: 'pre' })).toBeNull()
  expect(screen.queryByLabelText('实际系统提示词')).toBeNull()
})

it('keeps an unsaved prompt when switching settings categories', async () => {
  setup()
  const editor = screen.getByLabelText('系统提示词') as HTMLTextAreaElement
  await waitFor(() => expect(editor.value).toBe('SAVED CUSTOM'))
  fireEvent.change(editor, { target: { value: 'KEEP THIS DRAFT' } })
  fireEvent.click(screen.getByRole('tab', { name: '桌面偏好' }))
  fireEvent.click(screen.getByRole('tab', { name: '系统提示词' }))
  expect((screen.getByLabelText('系统提示词') as HTMLTextAreaElement).value).toBe('KEEP THIS DRAFT')
})

it('retains custom text after a failed save and only restores defaults into the draft', async () => {
  const save = vi.fn(async () => { throw new Error('保存失败') })
  setup({ setSystemPrompt: save })
  const editor = screen.getByLabelText('系统提示词') as HTMLTextAreaElement
  await waitFor(() => expect(editor.value).toBe('SAVED CUSTOM'))
  fireEvent.click(screen.getByRole('button', { name: '保存提示词' }))
  expect(await screen.findByText('保存失败')).toBeTruthy()
  expect(editor.value).toBe('SAVED CUSTOM')
  fireEvent.click(screen.getByRole('button', { name: '恢复默认' }))
  expect(editor.value).toBe('NEW DEFAULT')
  expect(save).toHaveBeenCalledTimes(1)
})
