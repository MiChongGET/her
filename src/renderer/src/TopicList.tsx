import type { WorkspaceListItem } from '../../shared/types'

interface Props {
  items: WorkspaceListItem[]
  onOpen(id: string): void
  onCreate(): void
  onRename(id: string): void
  onTrash(id: string): void
}

function preview(content: string) {
  if (!content) return '接着聊这件事'
  return content.split('\n').filter(line => !line.trimStart().startsWith('🔧')).join(' ').trim() || '工具调用记录'
}

export default function TopicList({ items, onOpen, onCreate, onRename, onTrash }: Props) {
  const topics = items.filter(item => item.topic?.kind === 'work')
  return <section className="topics-page" aria-label="一起在做的事">
    <div className="topics-heading"><p>有些事，可以慢慢一起聊。</p><button className="primary-button" onClick={onCreate}>另开一个话题</button></div>
    {topics.length === 0 ? <div className="topics-empty"><h3>还没有一起在做的事</h3><p>可以从生活里的一件小事开始。</p><button className="primary-button" onClick={onCreate}>另开一个话题</button></div> :
      <div className="topic-list">{topics.map(({ conversation }) => <article className="topic-card" key={conversation.id}>
        <button className="topic-card-main" aria-label={conversation.title} onClick={() => onOpen(conversation.id)}><span className="topic-card-mark" aria-hidden="true">✳</span><span className="topic-card-copy"><strong>{conversation.title}</strong><small>{preview(conversation.lastMessage)}</small></span><span aria-hidden="true">›</span></button>
        <details className="topic-card-menu"><summary aria-label={`${conversation.title}的更多操作`}>···</summary><div><button onClick={event => { event.currentTarget.closest('details')!.open = false; onRename(conversation.id) }}>重命名</button><button onClick={event => { event.currentTarget.closest('details')!.open = false; onTrash(conversation.id) }}>移到回收站</button></div></details>
      </article>)}</div>}
  </section>
}
