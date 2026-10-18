import type { DesktopSettings } from '../shared/types'

const normalized = (value: string) => value.toLowerCase().replace(/cmdorctrl|commandorcontrol/g, 'mod').replace(/command|cmd/g, 'meta').replace(/control|ctrl/g, 'ctrl').split('+').map(part => part.trim()).sort().join('+')

export function updateShortcuts(previous: Pick<DesktopSettings, 'shortcut' | 'stopShortcut'>, next: Pick<DesktopSettings, 'shortcut' | 'stopShortcut'>,
  bindings: { register(key: string, action: () => void): boolean; unregister(key: string): void; show(): void; stop(): void }, persist: () => void): void {
  if (next.shortcut && normalized(next.shortcut) === normalized(next.stopShortcut)) throw new Error('唤出和停止快捷键不能相同。')
  const added: string[] = []
  try {
    for (const [field, action] of [['shortcut', bindings.show], ['stopShortcut', bindings.stop]] as const) {
      const key = next[field]
      if (key === previous[field] || !key) continue
      if (!bindings.register(key, action)) throw new Error(field === 'stopShortcut' ? '停止快捷键无效或被占用，请更换；仍可使用停止按钮。' : '唤出快捷键无效或被占用，请更换。')
      added.push(key)
    }
    persist()
  } catch (error) {
    added.forEach(key => bindings.unregister(key))
    throw error
  }
  for (const field of ['shortcut', 'stopShortcut'] as const) if (previous[field] && previous[field] !== next[field]) bindings.unregister(previous[field])
}
