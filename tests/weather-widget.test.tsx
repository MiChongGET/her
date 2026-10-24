// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WeatherWidget } from '../src/renderer/src/WeatherWidget'
import type { HerApi, WeatherState } from '../src/shared/types'
import { weatherCity, weatherNow } from './weather-fixtures'

const report = { city: weatherCity, fetchedAt: new Date(weatherNow).toISOString(), current: { time: new Date(weatherNow).toISOString(), temperature: 22, code: 0, isDay: true, windSpeed: 8 }, daily: [], hourly: [] }
let state: WeatherState
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(weatherNow)
  state = { city: null, report: null, stale: false, updating: false }
  window.her = { getWeatherState: async () => state, searchWeatherCities: async () => [weatherCity],
    selectWeatherCity: async () => ({ city: weatherCity, report, stale: false, updating: false }),
    refreshWeather: async () => state, onWeatherState: () => () => {}, openExternal: async () => {} } as unknown as HerApi
})
afterEach(() => { cleanup(); vi.useRealTimers() })

it('lets the user choose a disambiguated city and displays weather in the topbar', async () => {
  render(<WeatherWidget />)
  const trigger = await screen.findByRole('button', { name: '选择天气城市' })
  fireEvent.click(trigger)
  fireEvent.change(screen.getByLabelText('城市名称'), { target: { value: '合肥' } })
  fireEvent.click(screen.getByRole('button', { name: '搜索城市' }))
  fireEvent.click(await screen.findByRole('button', { name: '合肥 · 安徽省 · 中国' }))
  const weather = await screen.findByRole('button', { name: /合肥天气/ })
  expect(weather.textContent).toContain('22°C')
  expect(weather.title).toContain('晴')
  expect(weather.title).toContain('更新')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(weather)
})

it('marks a failed refresh without a banner and retains only a recent temperature', async () => {
  state = { city: weatherCity, report, stale: true, updating: false, error: '天气暂时无法更新，请稍后重试。' }
  render(<WeatherWidget />)
  const trigger = await screen.findByRole('button', { name: /合肥天气/ })
  expect(trigger.textContent).toContain('22°C')
  expect(trigger.title).toContain('未更新')
  expect(screen.queryByRole('alert')).toBeNull()
})

it('hides the temperature when cached weather is more than two hours old', async () => {
  vi.setSystemTime(weatherNow + 121 * 60_000)
  state = { city: weatherCity, report, stale: true, updating: false }
  render(<WeatherWidget />)
  const trigger = await screen.findByRole('button', { name: /合肥天气/ })
  expect(trigger.textContent).not.toContain('22')
  expect(trigger.title).toContain('暂无可用天气')
})

it('discards old search results after the user changes the city input', async () => {
  let finish!: (cities: typeof weatherCity[]) => void
  window.her.searchWeatherCities = () => new Promise(resolve => { finish = resolve })
  render(<WeatherWidget />)
  fireEvent.click(await screen.findByRole('button', { name: '选择天气城市' }))
  fireEvent.change(screen.getByLabelText('城市名称'), { target: { value: '合肥' } })
  fireEvent.click(screen.getByRole('button', { name: '搜索城市' }))
  fireEvent.change(screen.getByLabelText('城市名称'), { target: { value: '上海' } })
  await act(async () => { finish([weatherCity]) })
  expect(screen.queryByRole('button', { name: '合肥 · 安徽省 · 中国' })).toBeNull()
  expect((screen.getByLabelText('城市名称') as HTMLInputElement).value).toBe('上海')
})

it('keeps search failures inside the popover and closes with Escape returning focus', async () => {
  window.her.searchWeatherCities = async () => { throw new Error('network') }
  render(<WeatherWidget />)
  const trigger = await screen.findByRole('button', { name: '选择天气城市' })
  fireEvent.click(trigger)
  fireEvent.change(screen.getByLabelText('城市名称'), { target: { value: '合肥' } })
  fireEvent.click(screen.getByRole('button', { name: '搜索城市' }))
  await screen.findByText('城市暂时无法搜索，请稍后重试。')
  fireEvent.keyDown(screen.getByLabelText('城市名称'), { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(document.activeElement).toBe(trigger)
})
