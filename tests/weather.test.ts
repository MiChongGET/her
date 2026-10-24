import { afterEach, describe, expect, it } from 'vitest'
import { WeatherService } from '../src/core/weather/service'
import { HerStore } from '../src/core/storage/store'
import { cityResponse, forecastResponse, otherWeatherCity, weatherCity, weatherNow } from './weather-fixtures'

const stores: HerStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

function setup() {
  const store = new HerStore(':memory:'); stores.push(store)
  let now = weatherNow, offline = false
  const urls: URL[] = []
  const network: typeof fetch = async (input, options) => {
    const url = new URL(String(input)); urls.push(url)
    expect(options?.redirect).toBe('error')
    if (offline) throw new Error('secret local path /private/hidden')
    return Response.json(url.hostname === 'geocoding-api.open-meteo.com' ? cityResponse() : forecastResponse())
  }
  const service = new WeatherService({ store, fetch: network, now: () => now })
  return { service, store, urls, network, advance: (ms: number) => { now += ms }, fail: () => { offline = true } }
}

describe('manual city weather', () => {
  it('does not locate or request weather until the user selects a searched city', async () => {
    const f = setup()
    await f.service.refresh()
    expect(f.service.getState()).toMatchObject({ city: null, report: null })
    expect(f.urls).toHaveLength(0)
    const cities = await f.service.searchCities('合肥')
    expect(cities).toEqual([weatherCity, otherWeatherCity])
    expect(f.service.getState().city).toBeNull()
    await f.service.selectCity(weatherCity.id)
    expect(f.service.getState()).toMatchObject({ city: weatherCity, report: { current: { temperature: 22 }, daily: expect.any(Array) }, stale: false })
    const url = f.urls[1]
    expect(url.hostname).toBe('api.open-meteo.com')
    expect(url.searchParams.get('forecast_days')).toBe('7')
    expect(url.searchParams.get('temperature_unit')).toBe('celsius')
    expect(f.service.getState().report!.daily).toHaveLength(7)
    expect(f.service.getState().report!.hourly).toHaveLength(48)
    expect(f.service.getState().report!.daily[0].date).toBe('2026-10-24')
    expect(f.service.getState().report!.current.time).toBe('2026-10-24T03:00:00.000Z')
    const restarted = new WeatherService({ store: f.store, fetch: f.network, now: () => weatherNow })
    expect(restarted.getState()).toEqual(f.service.getState())
    expect(f.urls).toHaveLength(2)
  })

  it('shares a fresh selected-city cache without changing it for another-city tool query', async () => {
    const f = setup()
    await f.service.searchCities('城市'); await f.service.selectCity(weatherCity.id)
    await f.service.getWeather()
    expect(f.urls).toHaveLength(2)
    const report = await f.service.getWeather(otherWeatherCity.id)
    expect(report.city).toEqual(otherWeatherCity)
    expect(f.service.getState().city).toEqual(weatherCity)
    expect(f.store.getSettings().weather?.city).toEqual(weatherCity)
  })

  it('refreshes only when due during periodic or resume checks', async () => {
    const f = setup()
    await f.service.searchCities('合肥'); await f.service.selectCity(weatherCity.id)
    f.advance(29 * 60_000); await f.service.refresh()
    expect(f.urls).toHaveLength(2)
    f.advance(60_000); await f.service.refresh()
    expect(f.urls).toHaveLength(3)
    expect(f.service.getState().stale).toBe(false)
  })

  it('does not reuse yesterday\'s forecasts across the selected city\'s midnight', async () => {
    const f = setup()
    let now = Date.parse('2026-10-24T15:59:00Z'), calls = 0
    const service = new WeatherService({ store: f.store, now: () => now, fetch: async input => {
      if (String(input).includes('geocoding-api')) return Response.json(cityResponse())
      const data = forecastResponse(); calls++
      if (calls > 1) {
        data.daily.time = data.daily.time.map(time => time + 86400)
        data.hourly.time = data.hourly.time.map(time => time + 86400)
      }
      return Response.json(data)
    } })
    await service.searchCities('合肥'); await service.selectCity(weatherCity.id)
    now += 2 * 60_000
    expect((await service.getWeather()).daily[0].date).toBe('2026-10-25')
    expect(calls).toBe(2)
  })

  it('allows a periodic force refresh even when the previous response completed after the timer started', async () => {
    const f = setup()
    await f.service.searchCities('合肥'); await f.service.selectCity(weatherCity.id)
    f.advance(30 * 60_000 - 500)
    await f.service.refresh(true)
    expect(f.urls).toHaveLength(3)
  })

  it('keeps a failed refresh visibly stale and hides a report older than two hours, including after restart', async () => {
    const f = setup()
    await f.service.searchCities('城市'); await f.service.selectCity(weatherCity.id)
    f.advance(31 * 60_000); f.fail()
    await f.service.refresh()
    expect(f.service.getState()).toMatchObject({ stale: true, error: '天气暂时无法更新，请稍后重试。', report: { current: { temperature: 22 } } })
    await expect(f.service.getWeather()).rejects.toThrow('天气暂时无法更新')
    f.advance(90 * 60_000)
    expect(f.service.getState()).toMatchObject({ stale: true, report: null, city: weatherCity })
    const restarted = new WeatherService({ store: f.store, now: () => weatherNow + 121 * 60_000 })
    expect(restarted.getState().report).toBeNull()
  })

  it('does not replace the new city with an older in-flight result', async () => {
    const f = setup()
    let finish!: (response: Response) => void
    let count = 0
    const service = new WeatherService({ store: f.store, now: () => weatherNow, fetch: async input => {
      if (String(input).includes('geocoding-api')) return Response.json(cityResponse())
      if (++count === 1) return new Promise<Response>(resolve => { finish = resolve })
      return Response.json(forecastResponse(18))
    } })
    await service.searchCities('城市')
    const first = service.selectCity(weatherCity.id)
    await service.selectCity(otherWeatherCity.id)
    finish(Response.json(forecastResponse(30))); await first
    expect(service.getState()).toMatchObject({ city: otherWeatherCity, report: { city: otherWeatherCity, current: { temperature: 18 } } })
    expect(f.store.getSettings().weather?.report?.current.temperature).toBe(18)
  })

  it('validates city identifiers and searches, and refuses incomplete forecasts', async () => {
    const f = setup()
    await expect(f.service.selectCity(123)).rejects.toThrow('请先搜索')
    await expect(f.service.searchCities(' ')).rejects.toThrow('请输入')
    const service = new WeatherService({ store: f.store, fetch: async input => Response.json(String(input).includes('geocoding-api') ? cityResponse() : { current: {} }) })
    await service.searchCities('合肥'); await service.selectCity(weatherCity.id)
    expect(service.getState()).toMatchObject({ report: null, error: expect.any(String) })
    expect(f.store.getSettings().weather?.report).toBeUndefined()
  })

  it('honors tool cancellation without continuing a network request', async () => {
    const f = setup()
    const service = new WeatherService({ store: f.store, fetch: async (_input, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true })
    }) })
    const controller = new AbortController()
    const pending = service.searchCities('合肥', controller.signal)
    controller.abort(new Error('stopped'))
    await expect(pending).rejects.toThrow('stopped')
    expect(service.getState().city).toBeNull()
  })
})
