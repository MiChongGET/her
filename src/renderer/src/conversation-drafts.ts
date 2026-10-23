import type { FileReference } from '../../shared/types'

export interface ConversationDraft {
  text: string
  files: FileReference[]
  revision: number
  scroll?: { top: number; following: boolean }
}
