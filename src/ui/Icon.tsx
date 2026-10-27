import { cn } from '@/lib/cn'

const paths = {
  home: 'M3 11.5 12 4l9 7.5M5 10v10h5v-6h4v6h5V10',
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Zm0 0v14m6-12v14',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm9 16-4.3-4.3',
  book: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5Zm0 14a2 2 0 0 1 2-2h13',
  cards: 'M7 4h11a2 2 0 0 1 2 2v11M4 8h11a2 2 0 0 1 2 2v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8Z',
  note: 'M5 4h10l4 4v12H5V4Zm10 0v4h4M8 12h8M8 16h5',
  award: 'M12 3a6 6 0 1 0 0 12 6 6 0 0 0 0-12Zm-3.5 11L7 21l5-2 5 2-1.5-7',
  settings:
    'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm7.4 3c0-.5 0-1-.1-1.4l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2.4-1.4L14 2h-4l-.5 2.2A7 7 0 0 0 7 5.6l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.8l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2.4 1.4L10 22h4l.5-2.2a7 7 0 0 0 2.4-1.4l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.4Z',
  grid: 'M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-6v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12.5l4.5 4.5L19 7',
  x: 'M7 7l10 10M17 7 7 17',
  arrowRight: 'M5 12h14m-6-6 6 6-6 6',
  arrowLeft: 'M19 12H5m6-6-6 6 6 6',
  chevron: 'M9 6l6 6-6 6',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4v5l3 2',
  play: 'M7 5v14l11-7L7 5Z',
  pause: 'M8 5v14M16 5v14',
  terminal: 'M4 5h16v14H4V5Zm3 4 3 3-3 3m5 0h5',
  flag: 'M5 21V4m0 0h11l-2 4 2 4H5',
  lightbulb: 'M9 18h6m-5 3h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z',
  alert: 'M12 4 2.5 20h19L12 4Zm0 6v4m0 3v.5',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 8v5m0-8v.5',
  lock: 'M6 11h12v9H6v-9Zm2 0V8a4 4 0 1 1 8 0v3',
  download: 'M12 4v11m-5-5 5 5 5-5M5 20h14',
  upload: 'M12 20V9m-5 5 5-5 5 5M5 4h14',
  refresh: 'M20 11A8 8 0 0 0 6.3 6.3L4 8.5M4 4v4.5h4.5M4 13a8 8 0 0 0 13.7 4.7L20 15.5M20 20v-4.5h-4.5',
  layers: 'M12 3 3 8l9 5 9-5-9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
  lab: 'M9 3h6M10 3v6L5 19a1.5 1.5 0 0 0 1.3 2h11.4a1.5 1.5 0 0 0 1.3-2l-5-10V3',
  target: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10Zm0 4a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z',
  print: 'M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7v-7Z',
  trash: 'M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3',
} as const

export type IconName = keyof typeof paths

export function Icon({ name, className, title }: { name: IconName; className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('h-5 w-5 shrink-0', className)}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      <path d={paths[name]} />
    </svg>
  )
}
