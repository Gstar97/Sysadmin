import { useEffect, useState, type ReactNode } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router'
import { content } from '@/content'
import { cn } from '@/lib/cn'
import { useTheme, type ThemePreference } from '@/lib/theme'
import { dueCards } from '@/progress/rules'
import { useProgress } from '@/progress/store'
import { Icon, type IconName } from '@/ui'

const NAV: { to: string; label: string; icon: IconName }[] = [
  { to: '/', label: 'Inicio', icon: 'home' },
  { to: '/mapa', label: 'Mapa', icon: 'map' },
  { to: '/repaso', label: 'Repaso', icon: 'cards' },
  { to: '/glosario', label: 'Glosario', icon: 'book' },
  { to: '/galeria', label: 'Galería', icon: 'grid' },
]

const THEME_NEXT: Record<ThemePreference, ThemePreference> = { sistema: 'claro', claro: 'oscuro', oscuro: 'sistema' }
const THEME_LABEL: Record<ThemePreference, string> = { sistema: 'Tema del sistema', claro: 'Tema claro', oscuro: 'Tema oscuro' }

export function Layout({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const location = useLocation()
  const { pref, setPref, isDark } = useTheme()
  const due = useProgress((s) => dueCards(s.snap).length)
  const storageWarning = useProgress((s) => s.storageWarning)

  useEffect(() => setMenuOpen(false), [location.pathname])

  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#contenido" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">
        Saltar al contenido
      </a>
      <header className="no-print sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
          <Link to="/" className="flex items-center gap-2 font-bold text-fg no-underline">
            <img src="/favicon.svg" alt="" className="h-7 w-7" />
            <span className="hidden sm:inline">{content.career.nombre}</span>
          </Link>
          <nav className="ml-4 hidden items-center gap-1 lg:flex" aria-label="Principal">
            {NAV.map((item) => (
              <NavItem key={item.to} {...item} badge={item.to === '/repaso' ? due : 0} />
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <QuickSearch />
            <button
              type="button"
              onClick={() => setPref(THEME_NEXT[pref])}
              className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-fg"
              title={`${THEME_LABEL[pref]} (cambiar)`}
              aria-label={`${THEME_LABEL[pref]}. Cambiar tema`}
            >
              <Icon name={isDark ? 'moon' : 'sun'} />
            </button>
            <NavLink
              to="/ajustes"
              className="hidden rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-fg sm:block"
              aria-label="Ajustes"
              title="Ajustes"
            >
              <Icon name="settings" />
            </NavLink>
            <button
              type="button"
              className="rounded-lg p-2 text-muted hover:bg-surface-2 lg:hidden"
              onClick={() => setMenuOpen((o) => !o)}
              aria-expanded={menuOpen}
              aria-label="Menú"
            >
              <Icon name={menuOpen ? 'close' : 'menu'} />
            </button>
          </div>
        </div>
        {menuOpen && (
          <nav className="border-t border-line bg-surface px-4 py-2 lg:hidden" aria-label="Menú móvil">
            {[...NAV, { to: '/notas', label: 'Mis notas', icon: 'note' as IconName }, { to: '/certificados', label: 'Insignias y certificados', icon: 'award' as IconName }, { to: '/ajustes', label: 'Ajustes', icon: 'settings' as IconName }].map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  cn('flex items-center gap-3 rounded-lg px-3 py-2.5 no-underline', isActive ? 'bg-accent-soft text-accent' : 'text-fg hover:bg-surface-2')
                }
              >
                <Icon name={item.icon} />
                {item.label}
                {item.to === '/repaso' && due > 0 && <span className="ml-auto rounded-full bg-accent px-2 text-xs text-accent-fg">{due}</span>}
              </NavLink>
            ))}
          </nav>
        )}
      </header>

      {storageWarning && (
        <div className="no-print bg-warn-soft px-4 py-2 text-center text-sm text-warn" role="alert">
          {storageWarning}
        </div>
      )}
      {import.meta.env.DEV && content.problems.errors.length > 0 && (
        <div className="no-print bg-bad-soft px-4 py-2 text-sm text-bad" role="alert">
          <strong>El contenido tiene {content.problems.errors.length} errores</strong> (solo se ve en desarrollo):
          <ul className="mt-1 list-disc pl-5">
            {content.problems.errors.slice(0, 8).map((e) => (
              <li key={e} className="whitespace-pre-wrap">
                {e}
              </li>
            ))}
          </ul>
        </div>
      )}

      <main id="contenido" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:py-8">
        {children}
      </main>

      <footer className="no-print border-t border-line py-6 text-center text-sm text-muted">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-4 gap-y-1 px-4">
          <span>El progreso se guarda en este navegador.</span>
          <Link to="/ajustes" className="text-accent">
            Exportar o importar progreso
          </Link>
          <Link to="/notas" className="text-accent">
            Mis notas
          </Link>
          <Link to="/certificados" className="text-accent">
            Insignias
          </Link>
        </div>
      </footer>
    </div>
  )
}

function NavItem({ to, label, icon, badge }: { to: string; label: string; icon: IconName; badge: number }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium no-underline',
          isActive ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-fg',
        )
      }
    >
      <Icon name={icon} className="h-4 w-4" />
      {label}
      {badge > 0 && <span className="rounded-full bg-accent px-1.5 text-xs text-accent-fg">{badge}</span>}
    </NavLink>
  )
}

function QuickSearch() {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault()
        navigate(`/buscar?q=${encodeURIComponent(q.trim())}`)
      }}
      className="relative"
    >
      <label className="flex items-center gap-1 rounded-lg border border-line bg-bg px-2 focus-within:border-accent">
        <Icon name="search" className="h-4 w-4 text-muted" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar"
          aria-label="Buscar en la carrera"
          className="w-20 bg-transparent py-1.5 text-sm outline-none sm:w-40"
        />
      </label>
    </form>
  )
}
