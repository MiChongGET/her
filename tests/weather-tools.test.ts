import { afterEach, expect, it, vi } from 'vitest'
import { WeatherService } from '../src/core/weather/service'
import { registerWeatherTools } from '../src/core/weather/tools'
import { SimpleToolRegistry } from '../src/core/tools/registry'
import { ToolApprovalService } from '../src/core/tools/approval'
import { DelegationService } from '../src/core/delegations/service'
import { HerStore } from '../src/core/storage/store'
import type { ToolExecutionContext } from '../src/core/tools/types'
import type { UserIntent } from '../src/core/delegations/types'
import { cityResponse, forecastResponse, weatherCity, weatherNow } from './weather-fixtures'

const stores: HerStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

function fixture() {
  const store = new HerStore(':memory:'); stores.push(store)
  const service = new WeatherService({ store, now: () => weatherNow, fetch: async input => Response.json(String(input).includes('geocoding-api') ? cityResponse() : forecastResponse()) })
  const registry = new SimpleToolRegistry()
  registerWeatherTools(registry, service)
  const emit = vi.fn()
  const approvals = new ToolApprovalService(emit)
  const context: ToolExecutionContext = { runId: 'run', callId: 'call', conversationId: 'daily', signal: new AbortController().signal,
    actionPolicy: new DelegationService(store), authorize: (assessment, value) => approvals.authorize(value.callId, assessment, value) }
  return { service, store, registry, emit, context }
}

it('executes the actual weather tools through the common gate without a confirmation', async () => {
  const f = fixture()
  const search = await f.registry.execute('search_weather_cities', { query: '合肥' }, f.context)
  expect(search.isError).not.toBe(true)
  expect(JSON.parse(search.content[0].type === 'text' ? search.content[0].text : '')).toEqual(expect.arrayContaining([weatherCity]))
  const result = await f.registry.execute('get_weather', { cityId: weatherCity.id }, f.context)
  expect(result.isError).not.toBe(true)
  expect(JSON.stringify(result)).toContain('Open-Meteo')
  expect(JSON.stringify(result)).toContain('22')
  expect(f.service.getState().city).toBeNull()
  expect(f.emit).not.toHaveBeenCalled()
})

it('asks for a city without locating the user and rejects unknown tool fields', async () => {
  const f = fixture()
  const result = await f.registry.execute('get_weather', {}, f.context)
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result)).toContain('询问用户城市')
  const injected = await f.registry.execute('get_weather', { cityId: weatherCity.id, url: 'http://localhost' }, f.context)
  expect(injected.isError).toBe(true)
  expect(JSON.stringify(injected)).toContain('Invalid tool arguments')
})

it('does not grant an ordinary executor the weather exception by tool name or descriptor', async () => {
  const f = fixture()
  const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'should not dispatch' }] }))
  f.registry.register({ name: 'get_weather', description: 'fake', parameters: { type: 'object' } }, execute, {
    describeAction: async () => ({ effect: 'read', targetId: 'weather:open-meteo', capability: 'weather.read', confirmation: 'scope', opaque: false,
      dataClasses: [], target: 'weather', summary: 'fake', actionLabel: 'read', preview: { fields: [] } })
  })
  const context = { ...f.context, authorize: undefined }
  await expect(f.registry.execute('get_weather', {}, context)).rejects.toThrow('需要用户确认')
  expect(execute).not.toHaveBeenCalled()
})

it('still respects a stopped runtime before dispatching a weather tool', async () => {
  const f = fixture()
  await expect(f.registry.execute('search_weather_cities', { query: '合肥' }, { ...f.context, validateRuntime: () => false })).rejects.toThrow('失效')
  expect(f.emit).not.toHaveBeenCalled()
})

it('does not bypass a user hold on all actions of the current intent', async () => {
  const f = fixture()
  const daily = f.store.ensureDailyConversation()
  const intent: UserIntent = { id: 'weather-intent', messageId: 'message', conversationId: daily.id, text: '查看天气', source: 'user', kind: 'unclassified', spans: [] }
  f.store.saveUserIntent(intent)
  f.store.saveUserIntent({ ...intent, id: 'hold-intent', messageId: 'hold-message', text: '暂停所有动作' })
  f.store.savePriorityControl({ id: 'hold', intentId: 'hold-intent', conversationId: daily.id, candidateIntentIds: [intent.id], heldIntentIds: [intent.id],
    candidates: [], heldDelegationIds: [], revision: 1, status: 'waiting', kind: 'pause', effect: 'all', history: 'written', createdAt: new Date(weatherNow).toISOString() })
  await expect(f.registry.execute('search_weather_cities', { query: '合肥' }, { ...f.context, conversationId: daily.id, intent })).rejects.toThrow('用户已暂停')
  expect(f.emit).not.toHaveBeenCalled()
})
