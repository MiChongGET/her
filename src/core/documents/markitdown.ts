import { FileAccessError } from '../files/errors'
import { McpConfigService } from '../mcp/config'
import { McpConnectionManager } from '../mcp/manager'
import { MARKITDOWN_MCP_VERSION, MARKITDOWN_VERSION } from '../mcp/presets'
import type { McpServicePolicy } from '../mcp/registry-adapter'
import type { DocumentParser } from './service'

export const MARKITDOWN_POLICY: McpServicePolicy = { allowedTools: [], privateDocumentConversion: true, timeoutMs: 120000 }
export function createMarkItDownParser(configs: McpConfigService, manager: McpConnectionManager): DocumentParser {
  const config = configs.list().find(item => item.presetId === 'markitdown' && item.enabled)
  if (!config) throw new FileAccessError('请在工具与连接中安装并启用 MarkItDown 文档预设。')
  const validate = () => {
    if (!configs.isCurrent(config.id, config.revision)) throw new FileAccessError('文档解析器配置已变化，请重新读取。')
  }
  return {
    version: `markitdown:${MARKITDOWN_VERSION}/mcp:${MARKITDOWN_MCP_VERSION}`,
    configuration: `${config.id}:${config.revision}:plugins=false`, validate,
    convert: async (uri, context) => {
      validate()
      try { const text = await manager.convertDocument(config.id, uri, context); validate(); return text }
      catch (error) { context.signal.throwIfAborted(); throw new FileAccessError(error instanceof Error ? error.message : '文档转换失败，请检查解析器。') }
    }
  }
}
