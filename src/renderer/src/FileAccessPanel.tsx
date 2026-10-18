import { useEffect, useRef, useState } from 'react'
import type { DependencyCheck, FileGrant } from '../../shared/types'
import DependencyChecks from './DependencyChecks'

interface Props {
  conversationId?: string
  refreshKey?: number
  persistent?: boolean
  onRevoke?(grant: FileGrant): Promise<void>
}

export default function FileAccessPanel({ conversationId, refreshKey, persistent, onRevoke }: Props) {
  const [grants, setGrants] = useState<FileGrant[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [checks, setChecks] = useState<DependencyCheck[]>([])
  const [checking, setChecking] = useState(false)
  const [parser, setParser] = useState('')
  const generation = useRef(0)
  const diagnostics = useRef(0)
  useEffect(() => {
    const token = ++generation.current
    setGrants([]); setError(''); setLoading(true)
    const load = persistent ? window.her.listPersistentFileGrants() : conversationId ? window.her.listFileGrants(conversationId) : Promise.resolve([])
    void load.then(items => { if (generation.current === token) setGrants(items) })
      .catch(cause => { if (generation.current === token) setError(cause instanceof Error ? cause.message : '无法读取授权。') })
      .finally(() => { if (generation.current === token) setLoading(false) })
    return () => { generation.current++; diagnostics.current++ }
  }, [conversationId, persistent, refreshKey])

  async function revoke(grant: FileGrant) {
    const token = ++generation.current
    setLoading(false); setError('')
    try {
      await (onRevoke ? onRevoke(grant) : window.her.revokeFileGrant(grant.id))
      if (generation.current === token) setGrants(items => items.filter(item => item.id !== grant.id))
    } catch (cause) { if (generation.current === token) setError(cause instanceof Error ? cause.message : '撤销未完成。') }
  }

  async function diagnose() {
    const token = ++diagnostics.current
    setChecking(true); setChecks([]); setParser(''); setError('')
    try {
      const services = await window.her.listMcpServices()
      const service = services.find(item => item.presetId === 'markitdown' && item.enabled)
      const results = await window.her.checkPresetDependencies('markitdown', service?.id ?? '')
      if (diagnostics.current !== token) return
      setChecks(results)
      setParser(service ? '已启用文档解析配置；依赖检查不代表提取成功。' : '尚未启用文档解析配置，请在 MCP 工具中配置 MarkItDown。')
    } catch (cause) { if (diagnostics.current === token) setError(cause instanceof Error ? cause.message : '检查未完成。') }
    finally { if (diagnostics.current === token) setChecking(false) }
  }

  return <section className="file-access" aria-label={persistent ? '长期资料授权' : '当前资料授权'}>
    <details open={persistent || undefined}><summary>{persistent ? '长期目录授权' : '资料授权'}{grants.length ? ` · ${grants.length}` : ''}</summary>
      <p className="file-note">添加文件允许本对话读取；目录按所选范围使用。回答所需的片段和图片会发送给当前模型服务。读取授权不包含修改原文件。</p>
      {loading && <p role="status">正在读取授权…</p>}
      {!loading && !grants.length && <p>暂无授权目录或文件。</p>}
      {grants.map(grant => <div className="file-grant" key={grant.id}><span>{grant.displayName} <small>{grant.scope === 'persistent' ? '长期授权' : '仅本次对话'} · {grant.kind === 'directory' ? '目录' : '文件'}</small></span><button type="button" onClick={() => void revoke(grant)} aria-label={`撤销 ${grant.displayName}`}>撤销</button></div>)}
      <p className="file-note">撤销后不能继续读取；已发送的历史仍保留。永久删除对话会清理其专属资料，长期目录授权保留。</p>
      {persistent && <><button type="button" disabled={checking} onClick={() => void diagnose()}>{checking ? '正在检查…' : '检查解析器依赖'}</button>{parser && <p>{parser}</p>}<DependencyChecks checks={checks} label="解析器依赖检查" /><p className="file-note">PDF 页面按需渲染，实际结果显示在工具记录中。</p></>}
    </details>
    {error && <p role="alert">{error}</p>}
  </section>
}
