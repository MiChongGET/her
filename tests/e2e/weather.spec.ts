import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { _electron, expect, test, type ElectronApplication } from '@playwright/test'
import { HerStore } from '../../src/core/storage/store'
import { cityResponse, forecastResponse, weatherCity } from '../weather-fixtures'

test('manual weather city flows through real IPC, survives renderer reload, and handles offline refresh', async ({}, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), 'her-weather-'))
  let app: ElectronApplication | undefined
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined)) as Record<string, string>
    env.HER_DATA_DIR = directory
    app = await _electron.launch({ args: [resolve('.')], env })
    const page = await app.firstWindow()
    await expect(page.getByRole('button', { name: '选择天气城市' })).toBeVisible()
    await app.evaluate(({ net }, fixtures) => {
      const original = net.fetch.bind(net)
      Reflect.set(globalThis, 'weatherRequests', [])
      net.fetch = async (input, options) => {
        const url = new URL(String(input))
        if (!['geocoding-api.open-meteo.com', 'api.open-meteo.com'].includes(url.hostname)) return original(input, options)
        Reflect.get(globalThis, 'weatherRequests').push(url.hostname)
        if (Reflect.get(globalThis, 'weatherOffline')) throw new Error('offline')
        return new Response(JSON.stringify(url.hostname.startsWith('geocoding') ? fixtures.cities : fixtures.forecast), { headers: { 'content-type': 'application/json' } })
      }
    }, { cities: cityResponse(), forecast: forecastResponse() })
    await page.getByRole('button', { name: '选择天气城市' }).click()
    await page.getByLabel('城市名称').fill('合肥')
    await page.getByRole('button', { name: '搜索城市' }).click()
    await page.getByRole('button', { name: '合肥 · 安徽省 · 中国' }).click()
    const trigger = page.getByRole('button', { name: /合肥天气/ })
    await expect(trigger).toContainText('22°C')
    const weatherBox = await trigger.boundingBox(), mottoBox = await page.locator('.topbar-motto').boundingBox()
    expect(weatherBox!.x + weatherBox!.width).toBeLessThan(mottoBox!.x)
    await page.screenshot({ path: testInfo.outputPath('weather-topbar-light.png') })
    await page.reload()
    await expect(page.getByRole('button', { name: /合肥天气/ })).toContainText('22°C')
    await page.evaluate(() => window.her.setAppearance('dark'))
    await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark')
    await page.getByRole('button', { name: /合肥天气/ }).click()
    await expect(page.getByLabel('城市名称')).toBeFocused()
    await page.screenshot({ path: testInfo.outputPath('weather-popover-dark.png') })
    // CDP clicks bypass Electron's native window-drag hit testing. Check that the
    // header beneath the popover cannot swallow a physical mouse click.
    await expect(page.locator('.chat-header')).toHaveCSS('-webkit-app-region', 'no-drag')
    await expect(page.getByRole('dialog')).toHaveCSS('-webkit-app-region', 'no-drag')
    await page.getByRole('button', { name: '关闭天气' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.chat-header')).toHaveCSS('-webkit-app-region', 'drag')
    await expect(page.getByRole('button', { name: /合肥天气/ })).toBeFocused()
    await page.getByRole('button', { name: /合肥天气/ }).click()
    await page.getByLabel('城市名称').press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('button', { name: /合肥天气/ })).toBeFocused()
    await app.evaluate(() => Reflect.set(globalThis, 'weatherOffline', true))
    await page.getByRole('button', { name: /合肥天气/ }).click()
    await page.getByRole('button', { name: '刷新天气' }).click()
    await expect(page.getByText('天气暂时无法更新，请稍后重试。')).toBeVisible()
    await expect(page.getByRole('button', { name: /合肥天气/ })).toContainText('22°C')
    await expect(page.getByRole('button', { name: /合肥天气/ })).toHaveAttribute('title', /未更新/)
    expect(await app.evaluate(() => Reflect.get(globalThis, 'weatherRequests'))).toEqual(['geocoding-api.open-meteo.com', 'api.open-meteo.com', 'api.open-meteo.com'])
    await app.close(); app = undefined
    const store = new HerStore(join(directory, 'Her-Pi-v1', 'her.sqlite'))
    try { expect(store.getSettings().weather).toMatchObject({ city: weatherCity, report: { city: weatherCity, current: { temperature: 22 } } }) }
    finally { store.close() }
  } finally {
    await app?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
