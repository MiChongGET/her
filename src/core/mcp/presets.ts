import type { McpPreset } from '../../shared/types'

export const MARKITDOWN_VERSION = '0.1.8'
export const MARKITDOWN_MCP_VERSION = '0.0.1a7'
export const MARKITDOWN_ENV = { MARKITDOWN_ENABLE_PLUGINS: 'false' }
export const PEEKABOO_VERSION = '4.9.3'
export const PEEKABOO_SHA256 = 'ce0f4f9824c64092c03cac759fdd58e174e19f7770f170c9f59bf009410d7d26'
export const PEEKABOO_TOOLS = ['app', 'window', 'see', 'click', 'type', 'press', 'scroll', 'menu'] as const
export const PEEKABOO_ARGS = ['mcp', '--no-remote', '--transport', 'stdio', '--allow-foreground']
export const PEEKABOO_ENV = { PEEKABOO_ALLOW_TOOLS: PEEKABOO_TOOLS.join(','), PEEKABOO_DISABLE_MCP_AUTOCONNECT: 'true' }
export const OPEN_WEBSEARCH_ENV = { MODE: 'stdio', SEARCH_MODE: 'request', DEFAULT_SEARCH_ENGINE: 'bing', ALLOWED_SEARCH_ENGINES: 'bing', USE_PROXY: 'false', OPEN_WEBSEARCH_QUIET_STARTUP: 'true', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' }
/** Presets whose adapter keeps per-conversation observation state, so each conversation gets its own connection. */
export const SCOPED_PRESETS: ReadonlySet<string> = new Set(['peekaboo'])
export const PRESETS: McpPreset[] = [
  { id: 'peekaboo', name: 'Mac 操作 · Peekaboo', version: PEEKABOO_VERSION, defaultEnabled: true, executable: true, environmentDefaults: PEEKABOO_ENV, guidance: '单独安装 @steipete/peekaboo@4.9.3，将原生 peekaboo 放入 ~/.local/share/her/dependencies/peekaboo-4.9.3/peekaboo；不要使用 npm 的 JS wrapper。向实际 Her 宿主授予屏幕录制和辅助功能权限。' },
  { id: 'markitdown', name: '文档读取 · MarkItDown', version: MARKITDOWN_VERSION, defaultEnabled: true, executable: true, environmentDefaults: MARKITDOWN_ENV, guidance: '安装版使用 Her.app/Contents/Resources/dependencies/markitdown/install.sh，源码版使用 resources/dependencies/markitdown/install.sh 将 CPython 3.13.13 和固定哈希锁的 74 个包安装到 ~/.local/share/her/dependencies/markitdown-0.1.8。只开放已授权文件的 read_document，禁用插件；不进行 OCR 或公式重算。' },
  { id: 'open-websearch', name: '可选搜索 · open-webSearch', version: '2.2.0', defaultEnabled: false, executable: true, environmentDefaults: OPEN_WEBSEARCH_ENV, guidance: '安装 Node.js（>=20.18.1）；在 ~/.local/share/her/dependencies/web-tools-v1 用 Her.app/Contents/Resources/mcp-web-dependencies（源码版 resources/mcp-web-dependencies）的固定 lock 安装 open-websearch@2.2.0（禁用 scripts 和浏览器下载）。默认关闭；启用后提供 Bing 请求检索和公开网页提取，MODE=stdio / SEARCH_MODE=request，提取必须 renderMode=request，不使用 Chrome 登录态。'  }
]
