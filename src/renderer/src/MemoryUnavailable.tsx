interface Props { onDaily(): void }

export default function MemoryUnavailable({ onDaily }: Props) {
  return <section className="memory-unavailable"><span className="memory-illustration" aria-hidden="true">✳</span><h2>她记得的事</h2><p>记忆功能尚未开放</p><button className="text-button" onClick={onDaily}>回到日常</button></section>
}
