import type { ReactNode } from 'react'

export type IconDevice = 'pc' | 'servidor' | 'switch' | 'switch_l3' | 'router' | 'firewall' | 'internet' | 'dns'

const LABELS: Record<IconDevice, string> = {
  pc: 'PC',
  servidor: 'Servidor',
  switch: 'Switch',
  switch_l3: 'Switch de capa 3',
  router: 'Router',
  firewall: 'Firewall',
  internet: 'Internet',
  dns: 'Servidor DNS',
}

/** Ícono de equipo de red dibujado en SVG (se adapta al tema con currentColor). */
export function DeviceIcon({ type, size = 44, className }: { type: IconDevice; size?: number; className?: string }) {
  let body: ReactNode
  switch (type) {
    case 'pc':
      body = (
        <>
          <rect x="8" y="9" width="32" height="21" rx="2" />
          <path d="M18 38h12M24 30v8" />
          <rect x="11" y="12" width="26" height="15" rx="1" fill="currentColor" opacity="0.12" stroke="none" />
        </>
      )
      break
    case 'servidor':
    case 'dns':
      body = (
        <>
          <rect x="13" y="6" width="22" height="36" rx="2" />
          <path d="M17 13h14M17 19h14M17 25h14" />
          <circle cx="30" cy="35" r="1.6" fill="currentColor" />
          {type === 'dns' && <text x="24" y="33" textAnchor="middle" fontSize="7" fill="currentColor" stroke="none" fontFamily="sans-serif">DNS</text>}
        </>
      )
      break
    case 'switch':
    case 'switch_l3':
      body = (
        <>
          <rect x="4" y="15" width="40" height="18" rx="3" />
          <path d="M11 21h9l-2.5-2.5M20 21l-2.5 2.5M37 27h-9l2.5-2.5M28 27l2.5 2.5" />
          {type === 'switch_l3' && <path d="M24 9v6M21 12l3-3 3 3" />}
        </>
      )
      break
    case 'router':
      body = (
        <>
          <ellipse cx="24" cy="24" rx="19" ry="12" />
          <path d="M14 24h8M18 20l4 4-4 4M34 24h-8M30 20l-4 4 4 4" />
        </>
      )
      break
    case 'firewall':
      body = (
        <>
          <rect x="7" y="10" width="34" height="28" rx="2" />
          <path d="M7 19h34M7 28h34M18 10v9M30 19v9M18 28v10" />
        </>
      )
      break
    case 'internet':
      body = <path d="M14 34a8 8 0 0 1-1-15.9A11 11 0 0 1 34 15a8 8 0 0 1 1 16 6 6 0 0 1-1 .1H14Z" />
      break
  }
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} role="img" aria-label={LABELS[type]}>
      {body}
    </svg>
  )
}

export function deviceLabel(type: IconDevice) {
  return LABELS[type]
}
