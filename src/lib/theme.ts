import { useEffect, useState, useSyncExternalStore } from 'react'

export type ThemePreference = 'sistema' | 'claro' | 'oscuro'

function readPreference(): ThemePreference {
  try {
    const v = localStorage.getItem('tema')
    if (v === 'claro' || v === 'oscuro') return v
  } catch {
    // Sin acceso al almacenamiento: se usa la preferencia del sistema.
  }
  return 'sistema'
}

function apply(pref: ThemePreference) {
  const root = document.documentElement
  if (pref === 'sistema') delete root.dataset.theme
  else root.dataset.theme = pref === 'oscuro' ? 'dark' : 'light'
}

/** Preferencia de tema (sistema, claro u oscuro), guardada en el navegador. */
export function useTheme() {
  const [pref, setPref] = useState<ThemePreference>(readPreference)

  useEffect(() => {
    apply(pref)
    try {
      if (pref === 'sistema') localStorage.removeItem('tema')
      else localStorage.setItem('tema', pref)
    } catch {
      // Ignorar: el tema igual se aplica durante esta visita.
    }
  }, [pref])

  const isDark =
    pref === 'oscuro' || (pref === 'sistema' && typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches)

  return { pref, setPref, isDark }
}

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const mq = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-color-scheme: dark)') : undefined
  mq?.addEventListener('change', onChange)
  return () => {
    observer.disconnect()
    mq?.removeEventListener('change', onChange)
  }
}

function isDarkNow() {
  const t = document.documentElement.dataset.theme
  if (t) return t === 'dark'
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
}

/** Tema efectivo actual (sigue los cambios de preferencia y del sistema). */
export function useIsDark(): boolean {
  return useSyncExternalStore(subscribeTheme, isDarkNow, () => false)
}
