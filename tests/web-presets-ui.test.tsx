// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import McpSettingsPanel from '../src/renderer/src/McpSettingsPanel'
import { PRESETS } from '../src/core/mcp/presets'
import type { HerApi, McpPreset } from '../src/shared/types'
afterEach(cleanup)
it('shows each preset environment default and explains when no extra variables are needed', async () => {
  window.her = { listMcpServices: async () => [], listMcpPresets: async () => PRESETS } as unknown as HerApi
  render(<McpSettingsPanel />)
  const defaults = await screen.findByRole('table', { name: '预设默认环境变量' })
  expect(within(defaults).getByText('PEEKABOO_ALLOW_TOOLS')).toBeTruthy()
  expect(within(defaults).getByText('app,window,see,click,type,press,scroll,menu')).toBeTruthy()
  expect(within(defaults).getByText('PEEKABOO_DISABLE_MCP_AUTOCONNECT')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('预设'), { target: { value: 'markitdown' } })
  expect(within(defaults).getByText('MARKITDOWN_ENABLE_PLUGINS')).toBeTruthy()
  expect(within(defaults).getByText('false')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('预设'), { target: { value: 'open-websearch' } })
  for (const [key, value] of Object.entries({ MODE: 'stdio', SEARCH_MODE: 'request', DEFAULT_SEARCH_ENGINE: 'bing', ALLOWED_SEARCH_ENGINES: 'bing', USE_PROXY: 'false', OPEN_WEBSEARCH_QUIET_STARTUP: 'true', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' })) {
    const row = within(defaults).getByText(key).closest('tr')!
    expect(within(row).getByText(value)).toBeTruthy()
  }
  fireEvent.change(screen.getByLabelText('预设'), { target: { value: 'playwright' } })
  expect(screen.queryByRole('table', { name: '预设默认环境变量' })).toBeNull()
  expect(screen.getByText('此预设无需额外环境变量。')).toBeTruthy()
})

it('shows actual saved environment values in plain text and preserves drafts when values and preset metadata arrive late', async () => {
  let loadPresets!: (items: McpPreset[]) => void
  const presets = new Promise<McpPreset[]>(resolve => { loadPresets = resolve })
  let loadEnvironment!: (values: Record<string, string>) => void
  const environment = new Promise<Record<string, string>>(resolve => { loadEnvironment = resolve })
  const service = { id: 'docs', name: '文档读取', enabled: false, revision: 1, transport: 'stdio' as const, command: '/markitdown-mcp', args: [], secretKeys: ['MARKITDOWN_ENABLE_PLUGINS', 'API_KEY'], hasSecrets: true, presetId: 'markitdown' }
  const save = vi.fn(async () => ({ ...service, revision: 2 }))
  const getEnvironment = vi.fn(() => environment)
  window.her = { listMcpServices: async () => [service], listMcpPresets: () => presets, getMcpEnvironment: getEnvironment, saveMcpService: save, getMcpStatus: async () => ({ serviceId: 'docs', revision: 1, state: 'disconnected', toolCount: 0 }) } as unknown as HerApi
  render(<McpSettingsPanel />)
  fireEvent.change(await screen.findByDisplayValue('文档读取'), { target: { value: '保留草稿' } })
  fireEvent.change(screen.getByLabelText('API_KEY', { exact: true }), { target: { value: 'draft-private-value' } })
  loadEnvironment({ MARKITDOWN_ENABLE_PLUGINS: 'true', API_KEY: 'saved-environment-value' })
  loadPresets(PRESETS)
  const credentials = within(screen.getByRole('region', { name: 'MCP 凭据' }))
  const defaults = await credentials.findByRole('table', { name: '预设默认环境变量' })
  expect(within(defaults).getByText('MARKITDOWN_ENABLE_PLUGINS')).toBeTruthy()
  expect(within(defaults).getByText('false')).toBeTruthy()
  expect(credentials.getByText(/已保存的值可能不同/)).toBeTruthy()
  const savedInput = screen.getByLabelText('MARKITDOWN_ENABLE_PLUGINS', { exact: true }) as HTMLInputElement
  await waitFor(() => expect(savedInput.value).toBe('true'))
  expect(savedInput.type).toBe('text')
  expect(getEnvironment).toHaveBeenCalledWith('docs', 1)
  expect((screen.getByLabelText('MCP 名称') as HTMLInputElement).value).toBe('保留草稿')
  expect((screen.getByLabelText('API_KEY', { exact: true }) as HTMLInputElement).value).toBe('draft-private-value')
  expect((screen.getByLabelText('API_KEY', { exact: true }) as HTMLInputElement).type).toBe('text')
  fireEvent.click(screen.getByRole('button', { name: '保存 MCP 服务' }))
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: '保留草稿', secretValues: { API_KEY: 'draft-private-value' }, clearSecretKeys: [] })))
})

it('does not apply a previous service environment to the currently edited service', async () => {
  let loadA!: (values: Record<string, string>) => void
  const delayedA = new Promise<Record<string, string>>(resolve => { loadA = resolve })
  const base = { enabled: false, revision: 1, transport: 'stdio' as const, command: '/node', args: [], secretKeys: ['FLAG'], hasSecrets: true }
  window.her = { listMcpServices: async () => [{ ...base, id: 'a', name: 'A 服务' }, { ...base, id: 'b', name: 'B 服务' }], listMcpPresets: async () => [], getMcpEnvironment: (id: string) => id === 'a' ? delayedA : Promise.resolve({ FLAG: 'B value' }), getMcpStatus: async (id: string) => ({ serviceId: id, revision: 1, state: 'disconnected', toolCount: 0 }) } as unknown as HerApi
  render(<McpSettingsPanel />)
  await screen.findByDisplayValue('A 服务')
  fireEvent.click(screen.getByRole('button', { name: /B 服务/ }))
  await screen.findByDisplayValue('B value')
  fireEvent.change(screen.getByLabelText('FLAG', { exact: true }), { target: { value: 'B draft' } })
  loadA({ FLAG: 'A old value' })
  await waitFor(() => expect((screen.getByLabelText('FLAG', { exact: true }) as HTMLInputElement).value).toBe('B draft'))
  expect(screen.queryByDisplayValue('A old value')).toBeNull()
})

it('enables adding the verified optional search preset and keeps it disabled after creation', async () => {
  const create = vi.fn(async () => ({ id: 's', name: 'Optional search', enabled: false, revision: 1, transport: 'stdio' as const, command: '/node', args: [], secretKeys: [], hasSecrets: false, presetId: 'open-websearch' }))
  window.her = { listMcpServices: async () => [], listMcpPresets: async () => PRESETS, checkPresetDependencies: async () => [{ component: 'Node.js', status: 'ready' }, { component: 'open-websearch', status: 'ready' }], createMcpPreset: create, getMcpStatus: async () => ({ serviceId: 's', revision: 1, state: 'disconnected', toolCount: 0 }) } as unknown as HerApi
  render(<McpSettingsPanel />)
  await waitFor(() => expect(screen.getByRole('option', { name: /open-webSearch/ })).toBeTruthy())
  fireEvent.change(screen.getByLabelText('预设'), { target: { value: 'open-websearch' } })
  fireEvent.click(screen.getByRole('button', { name: '检查预设依赖' }))
  await waitFor(() => expect((screen.getByRole('button', { name: '添加已验证预设' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '添加已验证预设' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Optional search · 已停用' })).toBeTruthy())
  expect(create).toHaveBeenCalledWith('open-websearch')
})
it('adds a verified document preset from MarkItDown readiness and explains its empty raw tool list', async () => {
  const create = vi.fn(async () => ({ id: 'docs', name: '文档读取', enabled: true, revision: 1, transport: 'stdio' as const, command: '/private-runtime/markitdown-mcp', args: [], secretKeys: ['MARKITDOWN_ENABLE_PLUGINS'], hasSecrets: true, presetId: 'markitdown' }))
  window.her = { listMcpServices: async () => [], listMcpPresets: async () => PRESETS, getMcpEnvironment: async () => ({ MARKITDOWN_ENABLE_PLUGINS: 'false' }), checkPresetDependencies: async () => [{ component: 'MarkItDown', status: 'ready' }], createMcpPreset: create, getMcpStatus: async () => ({ serviceId: 'docs', revision: 1, state: 'ready', toolCount: 0 }) } as unknown as HerApi
  render(<McpSettingsPanel />)
  await waitFor(() => expect(screen.getByRole('option', { name: /MarkItDown/ })).toBeTruthy())
  fireEvent.change(screen.getByLabelText('预设'), { target: { value: 'markitdown' } })
  expect((screen.getByRole('button', { name: '添加已验证预设' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '检查预设依赖' }))
  await waitFor(() => expect((screen.getByRole('button', { name: '添加已验证预设' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '添加已验证预设' }))
  await waitFor(() => expect(screen.getByRole('button', { name: '文档读取 · 已启用' })).toBeTruthy())
  expect(create).toHaveBeenCalledWith('markitdown')
  expect(screen.getByText(/文档解析仅供已授权文件使用/)).toBeTruthy()
})
