import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, expect, test } from '@playwright/test'

async function launch() {
  const directory = mkdtempSync(join(tmpdir(), 'her-window-lifecycle-'))
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && entry[0] !== 'ELECTRON_RUN_AS_NODE'))
  const executablePath = process.env.HER_TEST_APP_EXECUTABLE
  const app = await _electron.launch({ ...(executablePath ? { executablePath, args: [] } : { args: [resolve('.')] }), env: { ...env, HER_DATA_DIR: directory } })
  const page = await app.firstWindow()
  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible()
  return { app, directory }
}

test('window lifecycle: normal close hides and activate restores, destroyed window ignores activate', async () => {
  const { app, directory } = await launch()
  try {
    const normal = await app.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.close()
      const hidden = !window.isVisible() && !window.isDestroyed()
      app.emit('activate')
      return { hidden, visible: window.isVisible(), destroyed: window.isDestroyed() }
    })
    expect(normal).toEqual({ hidden: true, visible: true, destroyed: false })
    const destroyed = await app.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      window.destroy()
      let error: string | null = null
      try { app.emit('activate') } catch (cause) { error = (cause as Error).message }
      return { destroyed: window.isDestroyed(), error, windows: BrowserWindow.getAllWindows().length }
    })
    expect(destroyed).toEqual({ destroyed: true, error: null, windows: 0 })
  } finally {
    await app.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('window lifecycle: activate and show menu cannot reopen or touch a window during deferred quit', async () => {
  const { app, directory } = await launch()
  try {
    const closed = app.waitForEvent('close')
    const result = await app.evaluate(({ app, BrowserWindow, Menu }) => new Promise(resolve => {
      const window = BrowserWindow.getAllWindows()[0]
      const menuItem = Menu.getApplicationMenu()!.items[0].submenu!.items.find(item => item.label === '显示 Her')!
      const errors: string[] = []
      const show = () => {
        for (const callback of [() => app.emit('activate'), () => menuItem.click(menuItem, window, {})]) {
          try { callback() } catch (cause) { errors.push((cause as Error).message) }
        }
      }
      // Registered after the production listener: admission has closed, but the
      // shutdown promise cannot settle within this synchronous event callback.
      app.once('before-quit', () => {
        window.hide()
        show()
        const visibleDuringQuit = window.isVisible()
        window.destroy()
        show()
        resolve({ visibleDuringQuit, destroyed: window.isDestroyed(), errors, windows: BrowserWindow.getAllWindows().length })
      })
      app.quit()
    }))
    await closed
    expect(result).toEqual({ visibleDuringQuit: false, destroyed: true, errors: [], windows: 0 })
  } finally {
    await app.close().catch(() => {})
    rmSync(directory, { recursive: true, force: true })
  }
})
