import type { ToolResult } from '../../shared/types'
import type { McpConnectionManager } from './manager'
import type { McpServicePolicy } from './registry-adapter'
import { webUrl } from './browser'

const fields: Record<string, string[]> = { search: ['query', 'limit', 'engines'], fetchWebContent: ['url', 'maxChars', 'readability', 'includeLinks', 'renderMode'] }
const failed = (): ToolResult => ({ isError: true, content: [{ type: 'text', text: '网页检索失败或返回格式不兼容；请检查网络、搜索引擎阻断或验证码。未将失败作为零结果；不会回退启动浏览器。' }] })
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export function createWebSearchAdapter(_manager: McpConnectionManager, serviceId: string): McpServicePolicy {
  function validate(name: string, args: Record<string, unknown>) {
    if (!fields[name] || Object.keys(args).some(key => !fields[name].includes(key))) throw new Error('搜索工具或参数不在允许清单中。')
    if (name === 'search') {
      if (typeof args.query !== 'string' || !args.query.trim() || args.limit !== undefined && (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 50) || args.engines !== undefined && (!Array.isArray(args.engines) || !args.engines.length || args.engines.some(engine => engine !== 'bing'))) throw new Error('查询或搜索引擎不在允许范围；当前验证的请求模式引擎为 Bing。')
    } else {
      webUrl(args.url)
      if (!Number.isInteger(args.maxChars) || Number(args.maxChars) < 1000 || Number(args.maxChars) > 10000) throw new Error('请指定 1000–10000 的 maxChars，避免超出 Host 结果上限。')
      if (args.renderMode !== 'request') throw new Error('网页提取必须显式使用 renderMode=request；禁止浏览器回退。')
    }
  }
  return {
    allowedTools: Object.keys(fields),
    parameters(name, schema) {
      const source = object(schema.properties)
      const properties = Object.fromEntries(fields[name].filter(key => key in source).map(key => [key, source[key]]))
      if (name === 'search') properties.engines = { type: 'array', minItems: 1, items: { type: 'string', enum: ['bing'] } }
      else {
        properties.maxChars = { type: 'integer', minimum: 1000, maximum: 10000 }
        properties.renderMode = { type: 'string', enum: ['request'], description: 'HTTP request only; never launch a browser.' }
      }
      return { type: 'object', additionalProperties: false, properties, required: name === 'search' ? ['query'] : ['url', 'renderMode', 'maxChars'] }
    },
    async assess(name, args) { validate(name, args); return { effect: 'read', target: `web-search:${serviceId}`, summary: name === 'search' ? `公开网页搜索：${args.query}` : `请求公开网页：${args.url}` } },
    async execute(name, args, context, dispatch) {
      context.signal.throwIfAborted(); validate(name, args)
      let result: ToolResult
      try { result = await dispatch(name, args) } catch { context.signal.throwIfAborted(); return failed() }
      context.signal.throwIfAborted()
      if (result.isError || result.truncated) return failed()
      try {
        const blocks = result.content.filter(block => block.type === 'text')
        if (blocks.length !== 1) return failed()
        const value = object(JSON.parse(blocks[0].text))
        if (name === 'fetchWebContent') {
          if (value.retrievalMethod !== 'request' || typeof value.content !== 'string' || typeof value.title !== 'string') return failed()
          webUrl(value.url); webUrl(value.finalUrl)
          return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
        }
        if (!Array.isArray(value.results) || !Array.isArray(value.partialFailures) || !Array.isArray(value.engines) || typeof value.query !== 'string' || value.totalResults !== value.results.length) return failed()
        const results = value.results.map(item => {
          const hit = object(item)
          if (['title', 'url', 'description', 'source', 'engine'].some(key => typeof hit[key] !== 'string')) throw new Error('Invalid search hit')
          webUrl(hit.url)
          return { title: hit.title, url: hit.url, snippet: hit.description, source: hit.source, engine: hit.engine }
        })
        if (value.partialFailures.some(item => ['engine', 'code', 'message'].some(key => typeof object(item)[key] !== 'string'))) return failed()
        const status = value.partialFailures.length ? results.length ? 'partial' : 'failed' : results.length ? 'success' : 'empty'
        const normalized = { ...value, results, status }
        return { ...(status === 'failed' ? { isError: true } : {}), content: [{ type: 'text', text: JSON.stringify(normalized) }], structuredContent: normalized }
      } catch { return failed() }
    }
  }
}
