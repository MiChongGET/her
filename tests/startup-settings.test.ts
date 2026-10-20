import { describe, expect, it } from 'vitest'
import { HerStore } from '../src/core/storage/store'

describe('startup settings', () => {
  it('provides usable desktop settings before the first settings save', () => {
    const store = new HerStore(':memory:')
    try {
      expect(store.getSettings()).toMatchObject({
        activeProfileId: null, launchAtLogin: false,
        shortcut: expect.any(String), stopShortcut: expect.any(String)
      })
    } finally { store.close() }
  })

  it('preserves saved service selection and explicitly disabled shortcuts', () => {
    const store = new HerStore(':memory:')
    try {
      store.saveSettings({ activeProfileId: 'service-1', shortcut: '', stopShortcut: '', launchAtLogin: true })
      expect(store.getSettings()).toMatchObject({ activeProfileId: 'service-1', shortcut: '', launchAtLogin: true })
    } finally { store.close() }
  })
})
