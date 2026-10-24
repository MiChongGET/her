import type { ActionDescriptor } from '../delegations/types'
import type { SimpleToolRegistry } from '../tools/registry'
import type { ToolExecutor } from '../tools/types'
import type { WeatherService } from './service'
import { weatherDescription } from '../../shared/weather'

const executors = new WeakSet<ToolExecutor>()
const actions = new WeakSet<ActionDescriptor>()

/** Only a compiled weather executor can produce the proof; names and descriptors grant nothing. */
export function bindWeatherAction(executor: ToolExecutor, action: ActionDescriptor): void {
  if (executors.has(executor) && action.effect === 'read' && !action.opaque && action.capability === 'weather.read' && action.targetId === 'weather:open-meteo') actions.add(action)
}
export function isWeatherAction(action: ActionDescriptor): boolean { return actions.has(action) }

export function registerWeatherTools(registry: SimpleToolRegistry, service: WeatherService): void {
  const search: ToolExecutor = async (args, context) => ({ content: [{ type: 'text', text: JSON.stringify(await service.searchCities(args.query as string, context.signal)) }] })
  const weather: ToolExecutor = async (args, context) => {
    const report = await service.getWeather(args.cityId as number | undefined, context.signal)
    return { content: [{ type: 'text', text: JSON.stringify({ ...report,
      current: { ...report.current, description: weatherDescription(report.current.code) },
      daily: report.daily.map(day => ({ ...day, description: weatherDescription(day.code) })),
      units: { temperature: '°C', windSpeed: 'km/h', precipitationProbability: '%' },
      source: 'Open-Meteo', sourceUrl: 'https://open-meteo.com/', note: '当前天气为模型计算数据；日期与预报按城市时区解释。' }) }] }
  }
  for (const [definition, executor] of [
    [{ name: 'search_weather_cities', description: 'Search weather cities by name. Returns candidates with cityId (id), region, country and timezone. Ask the user to distinguish ambiguous names; querying does not change the topbar city.',
      parameters: { type: 'object', properties: { query: { type: 'string', minLength: 2, maxLength: 100 } }, required: ['query'], additionalProperties: false } }, search],
    [{ name: 'get_weather', description: 'Get current weather, 7 days including today, and hourly weather for today/tomorrow. Optional cityId must come from search_weather_cities; omit to use the saved topbar city. If no city is saved, ask the user for a city and search it. Does not change the topbar city. Temperature °C, wind km/h.',
      parameters: { type: 'object', properties: { cityId: { type: 'integer', minimum: 1 } }, additionalProperties: false } }, weather]
  ] as const) {
    const safe: ToolExecutor = async (args, context) => {
      try { return await executor(args, context) }
      catch (error) {
        context.signal.throwIfAborted()
        return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : '天气查询失败，请稍后重试。' }] }
      }
    }
    executors.add(safe)
    registry.register(definition, safe, {
      assess: async () => ({ effect: 'read', target: 'weather:open-meteo', summary: '查询城市天气' }),
      describeAction: async () => ({ effect: 'read', targetId: 'weather:open-meteo', target: 'Open-Meteo 公共天气数据', capability: 'weather.read',
        confirmation: 'scope', opaque: false, dataClasses: ['城市'], summary: '查询城市或天气，不更改天气城市', actionLabel: '查询', preview: { fields: [] }, origin: 'https://api.open-meteo.com', providerName: 'Open-Meteo' })
    })
  }
}
