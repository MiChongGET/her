import type { HerStore } from '../storage/store'
import type { WeatherCity, WeatherReport, WeatherState } from '../../shared/types'
import { abortable } from '../tools/abort'

const REFRESH_MS = 30 * 60_000
const EXPIRE_MS = 2 * 60 * 60_000
const unavailable = () => new Error('天气暂时无法更新，请稍后重试。')

interface WeatherOptions {
  store: Pick<HerStore, 'getSettings' | 'setSettings'>
  fetch?: typeof fetch
  now?: () => number
  signal?: AbortSignal
  onState?: (state: WeatherState) => void
}

interface ForecastData {
  current: Record<string, unknown>
  daily: Record<string, unknown[]>
  hourly: Record<string, unknown[]>
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw unavailable()
  return value
}
function nullable(value: unknown): number | null { return value === null ? null : number(value) }
function timestamp(value: unknown): string { return new Date(number(value) * 1000).toISOString() }
function localDate(time: number, city: WeatherCity): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: city.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time))
}

function parseCity(value: unknown): WeatherCity | null {
  if (!value || typeof value !== 'object') return null
  const city = value as Record<string, unknown>
  if (!Number.isSafeInteger(city.id) || (city.id as number) <= 0 || typeof city.name !== 'string' || !city.name ||
    typeof city.latitude !== 'number' || Math.abs(city.latitude) > 90 || !Number.isFinite(city.latitude) ||
    typeof city.longitude !== 'number' || Math.abs(city.longitude) > 180 || !Number.isFinite(city.longitude) ||
    typeof city.timezone !== 'string') return null
  try { new Intl.DateTimeFormat('en', { timeZone: city.timezone }) } catch { return null }
  return { id: city.id as number, name: city.name, region: typeof city.admin1 === 'string' ? city.admin1 : '',
    country: typeof city.country === 'string' ? city.country : '', latitude: city.latitude, longitude: city.longitude, timezone: city.timezone }
}

/** One fixed public provider; neither model arguments nor IPC can supply a URL or headers. */
export class WeatherService {
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private readonly cities = new Map<number, WeatherCity>()
  private city: WeatherCity | null
  private report: WeatherReport | null
  private updating = false
  private error?: string
  private revision = 0

  constructor(private readonly options: WeatherOptions) {
    this.fetch = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
    const saved = options.store.getSettings().weather
    this.city = saved?.city ?? null
    this.report = saved?.report?.city.id === this.city?.id ? saved?.report ?? null : null
    if (this.city) this.cities.set(this.city.id, this.city)
  }

  getState(): WeatherState {
    const age = this.report ? this.now() - Date.parse(this.report.fetchedAt) : Infinity
    return structuredClone({ city: this.city, report: age <= EXPIRE_MS ? this.report : null,
      stale: !!this.city && (!!this.error || !this.report || !this.fresh(this.report)), updating: this.updating, ...(this.error ? { error: this.error } : {}) })
  }

  private fresh(report: WeatherReport): boolean {
    return this.now() - Date.parse(report.fetchedAt) < REFRESH_MS && report.daily[0]?.date === localDate(this.now(), report.city)
  }

  private publish(): WeatherState {
    const state = this.getState()
    this.options.onState?.(state)
    return state
  }

  private save(): void {
    if (this.city) this.options.store.setSettings({ ...this.options.store.getSettings(), weather: { city: this.city, ...(this.report ? { report: this.report } : {}) } })
  }

  private async request(url: URL, caller?: AbortSignal): Promise<unknown> {
    const signal = AbortSignal.any([AbortSignal.timeout(8000), ...(this.options.signal ? [this.options.signal] : []), ...(caller ? [caller] : [])])
    signal.throwIfAborted()
    try {
      const response = await abortable(this.fetch(url, { signal, redirect: 'error', credentials: 'omit' }), signal)
      if (!response.ok) throw unavailable()
      return await abortable(response.json(), signal)
    } catch {
      caller?.throwIfAborted()
      this.options.signal?.throwIfAborted()
      throw unavailable()
    }
  }

  async searchCities(query: string, signal?: AbortSignal): Promise<WeatherCity[]> {
    if (typeof query !== 'string' || query.trim().length < 2 || query.trim().length > 100) throw new Error('请输入 2–100 个字符的城市名。')
    const url = new URL('https://geocoding-api.open-meteo.com/v1/search')
    url.search = new URLSearchParams({ name: query.trim(), count: '10', language: 'zh', format: 'json' }).toString()
    const data = await this.request(url, signal) as { results?: unknown[] }
    if (!data || (data.results !== undefined && !Array.isArray(data.results))) throw new Error('城市暂时无法搜索，请稍后重试。')
    const cities = (data.results ?? []).map(parseCity).filter((city): city is WeatherCity => !!city)
    for (const city of cities) {
      if (this.cities.size >= 100 && !this.cities.has(city.id)) {
        const first = [...this.cities.keys()].find(id => id !== this.city?.id)
        if (first !== undefined) this.cities.delete(first)
      }
      this.cities.set(city.id, city)
    }
    return cities
  }

  async selectCity(id: number): Promise<WeatherState> {
    const city = this.cities.get(id)
    if (!city) throw new Error('请先搜索并选择城市。')
    this.revision++
    this.city = city
    this.report = null
    this.error = undefined
    this.save()
    this.publish()
    return this.refresh(true)
  }

  async refresh(force = false): Promise<WeatherState> {
    if (!this.city || this.options.signal?.aborted) return this.getState()
    if (!force && this.report && !this.error && this.fresh(this.report)) return this.getState()
    const city = this.city, revision = ++this.revision
    this.updating = true
    this.publish()
    try {
      const report = await this.fetchReport(city)
      if (revision === this.revision && !this.options.signal?.aborted) {
        this.report = report; this.error = undefined; this.save()
      }
    } catch {
      if (revision === this.revision && !this.options.signal?.aborted) this.error = unavailable().message
    } finally {
      if (revision === this.revision) this.updating = false
    }
    return this.publish()
  }

  async getWeather(cityId?: number, signal?: AbortSignal): Promise<WeatherReport> {
    signal?.throwIfAborted()
    const city = cityId === undefined ? this.city : this.cities.get(cityId)
    if (!city) throw new Error(cityId === undefined ? '尚未设置天气城市，请先询问用户城市，再搜索并查询。' : '请先搜索并选择城市。')
    if (this.report?.city.id === city.id && this.fresh(this.report) && !this.error) return structuredClone(this.report)
    const revision = this.revision
    const report = await this.fetchReport(city, signal)
    signal?.throwIfAborted()
    if (this.city?.id === city.id && revision === this.revision) {
      this.report = report; this.error = undefined; this.save(); this.publish()
    }
    return report
  }

  private async fetchReport(city: WeatherCity, signal?: AbortSignal): Promise<WeatherReport> {
    const url = new URL('https://api.open-meteo.com/v1/forecast')
    url.search = new URLSearchParams({ latitude: String(city.latitude), longitude: String(city.longitude), timezone: city.timezone,
      forecast_days: '7', temperature_unit: 'celsius', wind_speed_unit: 'kmh', timeformat: 'unixtime',
      current: 'temperature_2m,weather_code,is_day,wind_speed_10m',
      daily: 'weather_code,temperature_2m_min,temperature_2m_max,precipitation_probability_max,wind_speed_10m_max',
      hourly: 'temperature_2m,weather_code,precipitation_probability,wind_speed_10m' }).toString()
    const data = await this.request(url, signal) as ForecastData
    try {
      if (!data.current || !Array.isArray(data.daily?.time) || data.daily.time.length !== 7 || !Array.isArray(data.hourly?.time)) throw unavailable()
      return {
        city, fetchedAt: new Date(this.now()).toISOString(),
        current: { time: timestamp(data.current.time), temperature: number(data.current.temperature_2m), code: number(data.current.weather_code),
          isDay: number(data.current.is_day) === 1, windSpeed: number(data.current.wind_speed_10m) },
        daily: data.daily.time.map((time, i) => ({ date: localDate(number(time) * 1000, city), code: number(data.daily.weather_code[i]),
          min: number(data.daily.temperature_2m_min[i]), max: number(data.daily.temperature_2m_max[i]),
          precipitationProbability: nullable(data.daily.precipitation_probability_max[i]), windSpeed: nullable(data.daily.wind_speed_10m_max[i]) })),
        hourly: data.hourly.time.flatMap((time, i) => number(time) >= number(data.daily.time[2]) ? [] : [{ time: timestamp(time),
          temperature: nullable(data.hourly.temperature_2m[i]), code: nullable(data.hourly.weather_code[i]),
          precipitationProbability: nullable(data.hourly.precipitation_probability[i]), windSpeed: nullable(data.hourly.wind_speed_10m[i]) }])
      }
    } catch { throw unavailable() }
  }
}
