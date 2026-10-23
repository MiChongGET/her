import type { PendingActionNotice, WorkspaceSelection } from '../../shared/types'
import { Icon } from './Visuals'

interface Props {
  selection: WorkspaceSelection
  overview: PendingActionNotice[]
  onSelect: (selection: WorkspaceSelection) => void
  onOpenPending: (notice: PendingActionNotice) => void
}

export default function WorkspaceNavigation({ selection, onSelect }: Props) {
  return <nav className="workspace-navigation" aria-label="工作区">
    <div className="workspace-sections">
      <button aria-current={selection.section === 'daily' ? 'page' : undefined} onClick={() => onSelect({ section: 'daily' })}><Icon name="chat" />日常</button>
      <button aria-current={selection.section === 'work' ? 'page' : undefined} onClick={() => onSelect({ section: 'work' })}><Icon name="layers" />一起在做的事</button>
      <button aria-current={selection.section === 'memory' ? 'page' : undefined} onClick={() => onSelect({ section: 'memory' })}><Icon name="leaf" />她记得的事</button>
    </div>
  </nav>
}
