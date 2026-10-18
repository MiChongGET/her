export function HerMark({ large = false }: { large?: boolean }) {
  return <svg className={`her-mark ${large ? 'her-mark-large' : ''}`} viewBox="0 0 48 48" fill="none" aria-hidden="true"><circle cx="24" cy="24" r="22" fill="currentColor" opacity=".1" /><path d="M15 32V16m18 16V16M15 24c5-4 13-4 18 0" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /><circle cx="24" cy="13" r="1.4" fill="currentColor" /></svg>
}

const paths = {
  plus: 'M12 5v14M5 12h14',
  chat: 'M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l-2 2v-9.5A7.5 7.5 0 0 1 10.5 4h2a7.5 7.5 0 0 1 7.5 7.5Z',
  sidebar: 'M4 4h16v16H4zM9 4v16',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  chevron: 'm7 10 5 5 5-5',
  close: 'm6 6 12 12M18 6 6 18',
  retry: 'M4 10a8 8 0 1 1 1 7M4 4v6h6',
  check: 'm5 12 4 4L19 6',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5',
  edit: 'M4 20h4L19 9l-4-4L4 16v4ZM13 7l4 4',
  paperclip: 'm21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48'
}

export function Icon({ name }: { name: keyof typeof paths | 'settings' }) {
  if (name === 'settings') return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 3-.6 2.4-2 1.2L4 6l-2 3.5 1.8 1.7v2.4L2 15.3 4 19l2.4-.6 2 1.2L9 22h4l.6-2.4 2-1.2L18 19l2-3.7-1.8-1.7v-2.4L20 9.5 18 6l-2.4.6-2-1.2L13 3Z" /><circle cx="11" cy="12.5" r="3" /></svg>
  return <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>
}
