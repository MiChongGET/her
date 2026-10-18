import { join } from 'node:path'
import type { DependencyCheck, DependencySetup } from '../../shared/types'
import { PEEKABOO_SHA256, PEEKABOO_VERSION } from './presets'

// Help is generated from known components, never from diagnostic text or a service command.
export function dependencySetup(presetId: string, check: DependencyCheck, resourcesRoot?: string): DependencySetup | undefined {
  if (check.status === 'ready') return
  const { component, status } = check
  if (presetId === 'peekaboo') {
    if (status === 'permission_required' && ['Screen Recording', 'Accessibility', 'Event Synthesizing', 'macOS 权限'].includes(component)) {
      return { links: [], steps: ['打开「系统设置 → 隐私与安全性」，为实际运行的宿主开启「屏幕录制」和「辅助功能」：安装版为 Her，开发版为 Electron。', '退出并重新打开对应宿主，然后重新检查依赖。权限需要由你在 macOS 中确认。'] }
    }
    if (component === 'Peekaboo' && status !== 'permission_required') return {
      links: [{ label: `下载 Peekaboo ${PEEKABOO_VERSION}`, url: `https://registry.npmjs.org/@steipete/peekaboo/-/peekaboo-${PEEKABOO_VERSION}.tgz` }],
      steps: [`下载并解压固定版本 ${PEEKABOO_VERSION} 的发布包，取出 package/peekaboo（macOS arm64 原生程序）。`, `创建目录 ~/.local/share/her/dependencies/peekaboo-${PEEKABOO_VERSION}，将程序放入其中，文件名为 peekaboo。`, `在终端运行 chmod u+x ~/.local/share/her/dependencies/peekaboo-${PEEKABOO_VERSION}/peekaboo 赋予可执行权限。`, `用 shasum -a 256 校验程序，预期 SHA256：${PEEKABOO_SHA256}。`, '安装后重新检查依赖，再按提示授予 macOS 权限。']
    }
    return
  }
  if (presetId === 'markitdown' && component === 'MarkItDown' && status !== 'permission_required') return {
    links: [{ label: '查看 uv 安装步骤', url: 'https://docs.astral.sh/uv/getting-started/installation/' }],
    steps: ['先按官方步骤安装 uv，再在终端运行下方安装命令。', '安装脚本下载 CPython 3.13.13 和固定版本 MarkItDown 0.1.8 及解析依赖，保存到 ~/.local/share/her/dependencies/markitdown-0.1.8。请保留 uv 管理的 Python。', '如已有不兼容安装，先将旧目录移走备份，再运行脚本；完成后重新检查解析器依赖。'],
    ...(resourcesRoot ? { command: `sh ${shellQuote(join(resourcesRoot, 'dependencies/markitdown/install.sh'))}` } : {})
  }
  if (!['playwright', 'open-websearch'].includes(presetId)) return
  if (component === 'Playwright 扩展' && presetId === 'playwright') return {
    links: [{ label: '安装官方 Playwright 扩展', url: 'https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm' }],
    steps: ['在希望使用的 Chrome 中安装官方扩展。已安装则无需重装。', '测试连接时，在扩展页面批准连接并选择允许使用的标签页。依赖检查不会启动浏览器，仍显示待授权；实际连接结果以「测试连接」为准。']
  }
  if (status === 'permission_required') return
  if (component === 'Node.js' || component === 'npm') return {
    links: [{ label: '下载 Node.js（含 npm）', url: 'https://nodejs.org/en/download' }],
    steps: ['从官网选择 macOS 的 LTS 安装包（含 npm），需要 Node.js ≥20.18.1。', '使用官方安装包的默认位置 /usr/local/bin，或 Homebrew 的 /opt/homebrew/bin；Her 不读取终端 PATH。安装完成后重新检查依赖。']
  }
  if (component === 'Chrome' && presetId === 'playwright') return {
    links: [{ label: '下载 Google Chrome', url: 'https://www.google.com/chrome/' }],
    steps: ['安装 Google Chrome 到 /Applications/Google Chrome.app，然后重新检查依赖。', '接着按扩展指引安装并授权官方 Playwright 扩展。']
  }
  const packages = presetId === 'playwright' ? ['@playwright/mcp', 'playwright', 'playwright-core'] : ['open-websearch']
  if (!packages.includes(component)) return
  return {
    links: [{ label: '查看 Node.js 安装步骤', url: 'https://nodejs.org/en/download' }],
    steps: ['先安装 Node.js（含 npm），再把下方命令复制到终端运行。', '使用 Her 附带的固定依赖锁安装 Playwright MCP 0.0.83 和 open-webSearch 2.2.0；不下载浏览器，也不会自动启用服务。', '安装后重新检查依赖。Playwright 仍需要 Chrome 扩展授权。'],
    ...(resourcesRoot ? { command: [
      'mkdir -p "$HOME/.local/share/her/dependencies/web-tools-v1"',
      `cp ${shellQuote(join(resourcesRoot, 'mcp-web-dependencies/package.json'))} ${shellQuote(join(resourcesRoot, 'mcp-web-dependencies/package-lock.json'))} "$HOME/.local/share/her/dependencies/web-tools-v1/"`,
      'cd "$HOME/.local/share/her/dependencies/web-tools-v1"',
      'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --ignore-scripts'
    ].join(' &&\n') } : {})
  }
}
function shellQuote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'" }
