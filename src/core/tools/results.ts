import type { ToolContent, ToolResult } from '../../shared/types'

const MAX_TEXT_CHARACTERS = 30_000

export function normalizeToolResult(value: string | ToolResult): ToolResult {
  const result: ToolResult = typeof value === 'string' ? { content: [{ type: 'text', text: value }] } : value
  let remaining = MAX_TEXT_CHARACTERS
  let truncated = result.truncated
  let unsupported = false
  const content: ToolContent[] = result.content.map(block => {
    if (block.type === 'text') {
      const text = block.text.slice(0, remaining)
      remaining -= text.length
      if (text.length < block.text.length) truncated = true
      return { type: 'text', text }
    }
    if (block.type === 'image') return { type: 'image', artifactId: block.artifactId, mimeType: block.mimeType }
    if (block.type === 'resource_link') return { type: 'resource_link', uri: block.uri, name: block.name }
    unsupported = true
    const label = String((block as { type?: unknown }).type ?? 'unknown')
    const text = `Unsupported tool content: ${label}`.slice(0, remaining)
    remaining -= text.length
    return { type: 'text', text }
  })
  return {
    ...result, content,
    ...(unsupported ? { isError: true } : {}),
    ...(truncated ? { truncated: true } : {})
  }
}

// The provider boundary stays text-only until multimodal tool input is implemented.
export function toolResultText(value: string | ToolResult): string {
  const result = normalizeToolResult(value)
  const text = result.content.map(block => {
    if (block.type !== 'text') throw new Error('当前工具模型输入仅支持文字；图片和资源链接尚未接入。')
    return block.text
  }).join('\n')
  if (result.truncated || text.length > MAX_TEXT_CHARACTERS) {
    const marker = '\n[tool result truncated]'
    return text.slice(0, MAX_TEXT_CHARACTERS - marker.length) + marker
  }
  return text
}

