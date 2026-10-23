import herLogo from '../../../resources/branding/her-final/her-logo.svg?url'
import samanthaAvatar from '../../../resources/branding/her-final/samantha-avatar.png?url'

export function HerMark({ large = false }: { large?: boolean }) {
  return <img className={`her-mark ${large ? 'her-mark-large' : ''}`} src={herLogo} width="48" height="32" alt="Her" />
}

export function SamanthaAvatar() {
  return <img className="samantha-avatar" src={samanthaAvatar} width="36" height="36" alt="" aria-hidden="true" />
}

const paths = {
  compact: 'M4 8h6M7 5l3 3-3 3M20 16h-6m3-3-3 3 3 3M4 16h4M16 8h4',
  plus: 'M12 5v14M5 12h14',
  chat: 'M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l-2 2v-9.5A7.5 7.5 0 0 1 10.5 4h2a7.5 7.5 0 0 1 7.5 7.5Z',
  layers: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
  leaf: 'M20 4c-10 0-16 5-16 12a4 4 0 0 0 4 4c7 0 12-6 12-16ZM4 20c3-5 7-8 12-10',
  sidebar: 'M4 4h16v16H4zM9 4v16',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  chevron: 'm7 10 5 5 5-5',
  close: 'm6 6 12 12M18 6 6 18',
  retry: 'M4 10a8 8 0 1 1 1 7M4 4v6h6',
  check: 'm5 12 4 4L19 6',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5',
  edit: 'M4 20h4L19 9l-4-4L4 16v4ZM13 7l4 4',
  paperclip: 'm21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48',
  lock: 'M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5z'
}

export function Icon({ name }: { name: keyof typeof paths | 'settings' }) {
  if (name === 'settings') return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 3-.6 2.4-2 1.2L4 6l-2 3.5 1.8 1.7v2.4L2 15.3 4 19l2.4-.6 2 1.2L9 22h4l.6-2.4 2-1.2L18 19l2-3.7-1.8-1.7v-2.4L20 9.5 18 6l-2.4.6-2-1.2L13 3Z" /><circle cx="11" cy="12.5" r="3" /></svg>
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}
