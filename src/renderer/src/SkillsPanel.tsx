import { useEffect, useRef, useState } from 'react'
import type { BuiltinSkill } from '../../shared/types'

export default function SkillsPanel() {
  const [skills, setSkills] = useState<BuiltinSkill[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string>()
  const [error, setError] = useState('')
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    async function load() {
      try {
        if (typeof window.her.listSkills !== 'function') {
          if (mounted.current) setError('技能接口尚未加载，请完全退出并重新打开 Her。')
          return
        }
        const items = await window.her.listSkills()
        if (mounted.current) setSkills(items)
      } catch { if (mounted.current) setError('无法加载技能，请完全退出并重新打开 Her 后重试。') }
      finally { if (mounted.current) setLoading(false) }
    }
    void load()
    return () => { mounted.current = false }
  }, [])

  async function toggle(skill: BuiltinSkill) {
    setSaving(skill.id); setError('')
    try {
      const items = await window.her.setSkillEnabled(skill.id, !skill.enabled)
      if (mounted.current) setSkills(items)
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : '技能设置未能保存，请重试。') }
    finally { if (mounted.current) setSaving(undefined) }
  }

  return <section className="skills-panel" aria-label="内置技能">
    <div className="skills-heading"><h3>内置技能</h3><p>技能为助手提供操作方法。启停将在后续任务中生效，MCP 服务连接单独管理。</p></div>
    {loading && <p role="status">正在加载技能…</p>}
    {error && <p className="error-banner" role="alert">{error}</p>}
    {skills.map(skill => <article className="skill-card" aria-label={skill.name} key={skill.id}>
      <div className="skill-card-heading"><div><h4>{skill.name}</h4><span className="skill-version">{skill.version}</span></div>
        <label className="skill-toggle"><input type="checkbox" aria-label={`启用 ${skill.name}`} checked={skill.enabled} disabled={saving !== undefined} onChange={() => void toggle(skill)} />{saving === skill.id ? '正在保存…' : skill.enabled ? '已启用' : '已停用'}</label>
      </div>
      <p>{skill.description}</p>
      {skill.id === 'ego-browser' && <p className="skill-note">需要安装 ego lite 并完成首次引导。停用后将禁止新的浏览器操作，已开始的动作需确认实际结果。</p>}
      <button type="button" className="secondary-button" onClick={() => void window.her.openExternal(skill.sourceUrl).catch(() => { if (mounted.current) setError('无法打开技能来源。') })}>查看来源</button>
      <details className="skill-source"><summary>查看原文</summary><pre>{skill.content}</pre></details>
    </article>)}
  </section>
}
