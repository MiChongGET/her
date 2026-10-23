// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import SettingsPanel from '../src/renderer/src/SettingsPanel'
import type { HerApi } from '../src/shared/types'

afterEach(cleanup)
function setup(fails = false, overrides: Partial<HerApi> = {}) {
  let enabled = true
  const skills = () => [{ id: 'ego-browser', name: 'ego-browser', description: '浏览器操作', version: '2.1.0', sourceUrl: 'https://github.com/citrolabs/ego-lite/tree/main/skills/ego-browser', content: '# Official skill\nRun ego-browser skill', enabled }]
  window.her = { listModelCatalog: async () => [], getSystemPrompt: async () => '', getDefaultSystemPrompt: async () => '',
    listSkills: async () => skills(), setSkillEnabled: async (_id: string, value: boolean) => { if (fails) throw new Error('保存失败'); enabled = value; return skills() }, openExternal: vi.fn(), ...overrides
  } as unknown as HerApi
  render(<SettingsPanel profiles={[]} settings={{ activeProfileId: null, shortcut: '', stopShortcut: '', launchAtLogin: false, appearance: 'light' }} dataDirectory="test" onClose={() => {}} onConfigurationChanged={async () => ({ profiles: [], settings: { activeProfileId: null, shortcut: '', stopShortcut: '', launchAtLogin: false, appearance: 'light' } })} onAppearanceChanged={() => {}} onSelectProfile={async () => {}} />)
}
it('opens an independent skill list, displays original content and persists toggles', async () => {
  setup()
  fireEvent.click(screen.getByRole('tab', { name: /^技能$/ }))
  const item = await screen.findByRole('article', { name: 'ego-browser' })
  expect(within(item).getByText('2.1.0')).toBeTruthy()
  expect((within(item).getByRole('checkbox', { name: '启用 ego-browser' }) as HTMLInputElement).checked).toBe(true)
  fireEvent.click(within(item).getByText('查看原文'))
  expect(item.querySelector('pre')?.textContent).toBe('# Official skill\nRun ego-browser skill')
  fireEvent.click(within(item).getByRole('checkbox', { name: '启用 ego-browser' }))
  await screen.findByText('已停用')
  expect((within(item).getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
})
it('keeps the enabled state when saving the skill preference fails', async () => {
  setup(true)
  fireEvent.click(screen.getByRole('tab', { name: /^技能$/ }))
  const item = await screen.findByRole('article', { name: 'ego-browser' })
  fireEvent.click(within(item).getByRole('checkbox'))
  await screen.findByText('保存失败')
  expect((within(item).getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
})

it('keeps settings usable when an older preload lacks the skills API', async () => {
  setup(false, { listSkills: undefined, setSkillEnabled: undefined })
  expect(() => fireEvent.click(screen.getByRole('tab', { name: /^技能$/ }))).not.toThrow()
  expect((await screen.findByRole('alert')).textContent).toContain('完全退出并重新打开 Her')
  expect(screen.queryByRole('status')).toBeNull()
  fireEvent.click(screen.getByRole('tab', { name: '模型服务' }))
  expect(screen.getByRole('dialog', { name: '设置' })).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['sync', 'async'] as const)('keeps skills loading failures inside the panel (%s)', async mode => {
  setup(false, { listSkills: () => {
    if (mode === 'sync') throw new Error('private host diagnostic')
    return Promise.reject(new Error('private host diagnostic'))
  } })
  expect(() => fireEvent.click(screen.getByRole('tab', { name: /^技能$/ }))).not.toThrow()
  expect((await screen.findByRole('alert')).textContent).toContain('无法加载技能')
  expect(screen.queryByText('private host diagnostic')).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.getByRole('dialog', { name: '设置' })).toBeTruthy()
})
