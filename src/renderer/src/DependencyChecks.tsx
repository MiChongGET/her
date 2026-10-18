import { useEffect, useRef, useState } from 'react'
import type { DependencyCheck } from '../../shared/types'

const labels = { ready: '已就绪', missing: '未安装', incompatible: '版本不匹配', permission_required: '需授权' }
const messageOf = (cause: unknown) => cause instanceof Error ? cause.message : '操作未完成'

export default function DependencyChecks({ checks, label = '预设依赖检查' }: { checks: DependencyCheck[]; label?: string }) {
  return checks.length > 0 ? <ul className="mcp-dependency-list" aria-label={label}>{checks.map(check => <DependencyItem key={check.component} check={check} />)}</ul> : null
}
function DependencyItem({ check }: { check: DependencyCheck }) {
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState('')
  const generation = useRef(0)
  useEffect(() => {
    generation.current++; setFeedback(''); setError('')
    return () => { generation.current++ }
  }, [check])
  async function open(url: string) {
    const token = generation.current
    setError(''); setFeedback('')
    try { await window.her.openExternal(url) }
    catch (cause) { if (token === generation.current) setError(`无法打开安装页面：${messageOf(cause)}。请手动访问 ${url}`) }
  }
  async function copy(command: string) {
    const token = generation.current
    setError(''); setFeedback('')
    try {
      await navigator.clipboard.writeText(command)
      if (token === generation.current) setFeedback('已复制，请在终端运行，完成后重新检查。')
    } catch { if (token === generation.current) setError('无法写入剪贴板，请选中下方命令手动复制到终端。') }
  }
  const setup = check.status !== 'ready' ? check.setup : undefined
  return <li><div><strong>{check.component}</strong><span data-state={check.status}>{labels[check.status]}</span>{check.version && <span>{check.version}</span>}</div>
    <p>{check.message}</p>{check.resolvedPath && <code>{check.resolvedPath}</code>}
    {setup && <div className="mcp-dependency-setup">
      <ol>{setup.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
      <div className="mcp-dependency-actions">{setup.links.map(link => <button type="button" className="secondary-button" key={link.url} onClick={() => void open(link.url)}>{link.label}</button>)}
        {setup.command && <button type="button" className="secondary-button" onClick={() => void copy(setup.command!)} aria-label={`复制 ${check.component} 安装命令`}>复制安装命令</button>}
      </div>
      {setup.command && <pre className="mcp-install-command" tabIndex={0} aria-label={`${check.component} 安装命令`}><code>{setup.command}</code></pre>}
      {feedback && <p role="status">{feedback}</p>}{error && <p role="alert" className="error-banner">{error}</p>}
    </div>}
  </li>
}
