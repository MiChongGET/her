// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import DependencyChecks from '../src/renderer/src/DependencyChecks'
import McpSettingsPanel from '../src/renderer/src/McpSettingsPanel'
import FileAccessPanel from '../src/renderer/src/FileAccessPanel'
import type { DependencyCheck, HerApi, McpServiceConfig } from '../src/shared/types'

const missing: DependencyCheck = { component: 'MarkItDown', status: 'missing', message: '需要文档解析器', setup: { steps: ['先安装 uv，再执行命令'], links: [{ label: '查看 uv 安装步骤', url: 'https://docs.astral.sh/uv/getting-started/installation/' }], command: "sh '/Applications/Her.app/Contents/Resources/dependencies/markitdown/install.sh'" } }
const saved: McpServiceConfig = { id: 'document-a', name: '文档工具 A', presetId: 'markitdown', enabled: true, transport: 'stdio', command: '/old/markitdown-mcp', args: [], revision: 1, secretKeys: [], hasSecrets: false }
let api: Pick<HerApi, 'openExternal' | 'listMcpServices' | 'listMcpPresets' | 'getMcpStatus' | 'listMcpTools' | 'checkPresetDependencies' | 'testMcpService' | 'listPersistentFileGrants'>
let copy: ReturnType<typeof vi.fn>
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail }); return { resolve, reject, promise } }
beforeEach(() => {
  api = { openExternal: vi.fn().mockResolvedValue(undefined), listMcpServices: vi.fn().mockResolvedValue([]),
    listMcpPresets: vi.fn().mockResolvedValue([{ id: 'markitdown', name: '文档读取', executable: true, defaultEnabled: true, guidance: '固定解析器' }, { id: 'peekaboo', name: 'Mac 操作', executable: true, defaultEnabled: true, guidance: '原生工具' }]),
    getMcpStatus: vi.fn().mockImplementation(async id => ({ serviceId: id, revision: 1, state: 'error', toolCount: 0, message: '原连接失败' })), listMcpTools: vi.fn().mockResolvedValue([]),
    checkPresetDependencies: vi.fn().mockResolvedValue([missing]), testMcpService: vi.fn().mockResolvedValue({ status: 'failed', message: '启动失败，请检查安装' }), listPersistentFileGrants: vi.fn().mockResolvedValue([]) }
  window.her = api as HerApi
  copy = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } })
})
afterEach(cleanup)
it('offers fixed install actions and copies commands without changing missing status', async () => {
  render(<DependencyChecks checks={[missing]} />)
  expect(screen.getByText('未安装')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '查看 uv 安装步骤' }))
  await waitFor(() => expect(api.openExternal).toHaveBeenCalledWith(missing.setup!.links[0].url))
  fireEvent.click(screen.getByRole('button', { name: '复制 MarkItDown 安装命令' }))
  await screen.findByText('已复制，请在终端运行，完成后重新检查。')
  expect(copy).toHaveBeenCalledWith(missing.setup!.command)
  expect(screen.getByText('未安装')).toBeTruthy()
})
it('hides install controls for ready items, and shows permission steps independently', () => {
  render(<DependencyChecks checks={[{ ...missing, status: 'ready' }, { component: 'Accessibility', status: 'permission_required', message: '需授权', setup: { links: [], steps: ['在系统设置开启辅助功能'] } }]} />)
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.getByText('在系统设置开启辅助功能')).toBeTruthy()
})
it('keeps commands selectable and explains clipboard or browser failures', async () => {
  copy.mockRejectedValue(new Error('clipboard denied'))
  vi.mocked(api.openExternal).mockRejectedValue(new Error('browser failed'))
  render(<DependencyChecks checks={[missing]} />)
  fireEvent.click(screen.getByRole('button', { name: '复制 MarkItDown 安装命令' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('手动复制'))
  expect(screen.getByText(missing.setup!.command!)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '查看 uv 安装步骤' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('browser failed'))
})
it('drops late action feedback after the checks change', async () => {
  const late = deferred<void>(); copy.mockReturnValue(late.promise)
  const { rerender } = render(<DependencyChecks checks={[missing]} />)
  fireEvent.click(screen.getByRole('button', { name: '复制 MarkItDown 安装命令' }))
  rerender(<DependencyChecks checks={[{ ...missing, status: 'ready' }]} />)
  await act(async () => late.reject(new Error('old clipboard')))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.queryByText(/已复制/)).toBeNull()
})
it('new presets can recheck after installation without losing custom draft fields', async () => {
  vi.mocked(api.checkPresetDependencies).mockResolvedValueOnce([missing]).mockResolvedValueOnce([{ component: 'MarkItDown', status: 'ready', message: '依赖现在可用' }])
  render(<McpSettingsPanel />)
  fireEvent.change(await screen.findByLabelText('预设'), { target: { value: 'markitdown' } })
  fireEvent.change(screen.getByLabelText('MCP 名称'), { target: { value: '我的草稿' } })
  fireEvent.click(screen.getByRole('button', { name: '检查预设依赖' }))
  await screen.findByRole('button', { name: '查看 uv 安装步骤' })
  fireEvent.click(screen.getByRole('button', { name: '重新检查依赖' }))
  await screen.findByText('依赖现在可用')
  expect(screen.queryByRole('button', { name: '查看 uv 安装步骤' })).toBeNull()
  expect(screen.getByLabelText('MCP 名称')).toHaveProperty('value', '我的草稿')
})
it('failed saved-preset connections show setup while retaining the original error and draft', async () => {
  vi.mocked(api.listMcpServices).mockResolvedValue([saved])
  render(<McpSettingsPanel />)
  const name = await screen.findByDisplayValue('文档工具 A')
  fireEvent.change(name, { target: { value: '保存前的草稿' } })
  fireEvent.click(screen.getByRole('button', { name: '测试 MCP 连接' }))
  await screen.findByRole('button', { name: '查看 uv 安装步骤' })
  expect(screen.getByText('启动失败，请检查安装')).toBeTruthy()
  expect(screen.getByText('原连接失败')).toBeTruthy()
  expect(name).toHaveProperty('value', '保存前的草稿')
  expect(api.checkPresetDependencies).toHaveBeenCalledWith('markitdown', saved.id)
})
it('caught connection failures still expose preset setup and preserve the thrown error', async () => {
  vi.mocked(api.listMcpServices).mockResolvedValue([saved])
  vi.mocked(api.testMcpService).mockRejectedValue(new Error('spawn failed'))
  render(<McpSettingsPanel />)
  await screen.findByDisplayValue('文档工具 A')
  fireEvent.click(screen.getByRole('button', { name: '测试 MCP 连接' }))
  await screen.findByRole('button', { name: '查看 uv 安装步骤' })
  expect(screen.getByText('spawn failed')).toBeTruthy()
})
it('does not leak saved-preset results into another service after switching', async () => {
  const late = deferred<DependencyCheck[]>()
  vi.mocked(api.listMcpServices).mockResolvedValue([saved, { ...saved, id: 'b', name: '文档工具 B' }])
  vi.mocked(api.checkPresetDependencies).mockReturnValue(late.promise)
  render(<McpSettingsPanel />)
  await screen.findByDisplayValue('文档工具 A')
  fireEvent.click(screen.getByRole('button', { name: '检查服务依赖' }))
  fireEvent.click(screen.getByRole('button', { name: '文档工具 B · 已启用' }))
  await screen.findByDisplayValue('文档工具 B')
  await act(async () => late.resolve([missing]))
  expect(screen.queryByRole('button', { name: '查看 uv 安装步骤' })).toBeNull()
})
it('document access uses the same installation help without requiring a saved parser', async () => {
  render(<FileAccessPanel persistent />)
  fireEvent.click(screen.getByRole('button', { name: '检查解析器依赖' }))
  await screen.findByRole('button', { name: '查看 uv 安装步骤' })
  expect(screen.getByRole('button', { name: '复制 MarkItDown 安装命令' })).toBeTruthy()
  expect(await screen.findByText(/尚未启用文档解析配置/)).toBeTruthy()
})
