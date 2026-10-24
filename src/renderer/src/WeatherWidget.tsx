import { useEffect, useId, useRef, useState } from 'react'
import type { WeatherCity, WeatherState } from '../../shared/types'
import { weatherDescription } from '../../shared/weather'
import { Icon } from './Visuals'

function WeatherIcon({ code, isDay = true }: { code?: number; isDay?: boolean }) {
  const clear = code === 0, partly = code === 1 || code === 2
  const rain = code !== undefined && code >= 51 && code <= 82 && ![71, 73, 75, 77].includes(code)
  const snow = code !== undefined && [71, 73, 75, 77, 85, 86].includes(code)
  const sun = <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>
  return <svg className="weather-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {clear ? isDay ? sun : <path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10Z" /> : <>
      {partly && (isDay ? <g transform="translate(1 -3) scale(.8)">{sun}</g> : <path d="M14 3a5 5 0 0 0 6 6" />)}
      <path d="M6 17a4 4 0 1 1 .5-8A6 6 0 0 1 18 10a3.5 3.5 0 1 1 0 7Z" />
      {rain && <path d="m8 20-1 2m6-2-1 2m6-2-1 2" />}
      {snow && <path d="M8 20v3m-1.5-1.5h3m7-1.5v3m-1.5-1.5h3" />}
      {code !== undefined && code >= 95 && <path d="m13 15-3 5h4l-2 3" />}
      {code !== undefined && [45, 48].includes(code) && <path d="M5 20h14M8 23h8" />}
    </>}
  </svg>
}

const cityLabel = (city: WeatherCity) => [city.name, city.region, city.country].filter(Boolean).join(' · ')

export function WeatherWidget() {
  const [state, setState] = useState<WeatherState | null>(null)
  const [now, setNow] = useState(Date.now)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [cities, setCities] = useState<WeatherCity[]>([])
  const [searching, setSearching] = useState(false)
  const [saving, setSaving] = useState(false)
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const searchRevision = useRef(0)
  const titleId = useId(), inputId = useId()

  useEffect(() => {
    let alive = true, receivedEvent = false
    const unsubscribe = window.her.onWeatherState(value => { receivedEvent = true; if (alive) setState(value) })
    void window.her.getWeatherState().then(value => { if (alive && !receivedEvent) setState(value) }, () => { if (alive) setError('天气暂时无法读取，请稍后重试。') })
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => { alive = false; unsubscribe(); clearInterval(timer); searchRevision.current++ }
  }, [])

  useEffect(() => {
    if (!open) return
    input.current?.focus()
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])

  function close() { setOpen(false); trigger.current?.focus() }

  async function search() {
    const revision = ++searchRevision.current
    setSearching(true); setError(''); setCities([]); setSearched(false)
    try {
      const result = await window.her.searchWeatherCities(query.trim())
      if (revision === searchRevision.current) { setCities(result); setSearched(true) }
    } catch { if (revision === searchRevision.current) setError('城市暂时无法搜索，请稍后重试。') }
    finally { if (revision === searchRevision.current) setSearching(false) }
  }

  async function select(city: WeatherCity) {
    setSaving(true); setError('')
    try { setState(await window.her.selectWeatherCity(city.id)); close() }
    catch { setError('城市暂时无法保存，请重新搜索后再试。') }
    finally { setSaving(false) }
  }

  async function refresh() {
    setError('')
    try { setState(await window.her.refreshWeather()) }
    catch { setError('天气暂时无法更新，请稍后重试。') }
  }

  const report = state?.report && now - Date.parse(state.report.fetchedAt) <= 2 * 60 * 60_000 ? state.report : null
  const stale = state?.stale || (!!report && now - Date.parse(report.fetchedAt) >= 30 * 60_000)
  const description = report ? weatherDescription(report.current.code) : '暂无可用天气'
  const temperature = report ? `${Math.round(report.current.temperature)}°C` : ''
  const updated = report ? new Date(report.fetchedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''
  const title = state?.city ? [cityLabel(state.city), `${description} ${temperature}`.trim(), updated && `更新于 ${updated}`, stale && '未更新', state.updating && '正在更新…'].filter(Boolean).join('\n') : '选择城市，看看那里的天气'

  return <div className="weather-widget" ref={root} onKeyDown={event => {
    if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
  }} onBlur={event => { if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}>
    <button ref={trigger} type="button" className={`weather-trigger${!report || stale ? ' weather-muted' : ''}`}
      aria-label={state?.city ? `${state.city.name}天气，${description}${temperature ? `，${temperature}` : ''}` : '选择天气城市'}
      title={title} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(value => !value)}>
      <WeatherIcon code={report?.current.code} isDay={report?.current.isDay} />
      <span>{state?.city ? temperature || '天气暂无' : '选择城市'}</span>
      {stale && report && <span className="weather-stale-dot" aria-label="未更新" />}
    </button>
    {open && <section className="weather-popover" role="dialog" aria-labelledby={titleId}>
      <header><h2 id={titleId}>{state?.city?.name ?? '选择城市'}</h2><button className="icon-button" aria-label="关闭天气" onClick={close}><Icon name="close" /></button></header>
      {state?.city && <div className="weather-summary"><p>{description}{temperature && ` · ${temperature}`}</p><small>{updated ? `${updated} 更新${stale ? ' · 未更新' : ''}` : '等待天气更新'}</small>
        <button className="text-button" disabled={state.updating || saving} onClick={() => void refresh()}>{state.updating ? '正在更新…' : '刷新天气'}</button></div>}
      <form onSubmit={event => { event.preventDefault(); if (!searching && !saving && query.trim().length >= 2) void search() }}>
        <label htmlFor={inputId}>城市名称</label>
        <div className="weather-search"><input id={inputId} ref={input} value={query} disabled={saving} maxLength={100} placeholder="例如：合肥、上海" onChange={event => {
          searchRevision.current++; setQuery(event.target.value); setCities([]); setSearched(false); setSearching(false); setError('')
        }} /><button type="submit" disabled={searching || saving || query.trim().length < 2}>{searching ? '搜索中…' : '搜索城市'}</button></div>
      </form>
      {(error || state?.error) && <p className="weather-note" role="status">{error || state?.error}</p>}
      {searched && !cities.length && <p className="weather-note" role="status">没有找到城市，试试完整城市名或拼音。</p>}
      {cities.length > 0 && <ul className="weather-cities" aria-label="城市搜索结果">{cities.map(city => <li key={city.id}><button disabled={saving} onClick={() => void select(city)}>{cityLabel(city)}</button></li>)}</ul>}
      <p className="weather-note">所选城市会保留，下次打开继续显示。</p>
      <footer>{[['Open-Meteo', 'https://open-meteo.com/'], ['GeoNames', 'https://www.geonames.org/']].map(([label, url]) => <a key={label} href={url} onClick={event => {
        event.preventDefault(); void window.her.openExternal(url).catch(() => setError('暂时无法打开来源链接。'))
      }}>{label}</a>)}</footer>
    </section>}
  </div>
}
