import { useEffect } from 'react'
import { useProgress } from './store'

const TICK_SECONDS = 15
const IDLE_LIMIT_MS = 2 * 60 * 1000

/**
 * Cuenta el tiempo de estudio activo: solo suma mientras la pestaña está visible y hubo
 * alguna interacción (teclado, mouse, toque o desplazamiento) en los últimos 2 minutos.
 */
export function useActiveTime(lessonId?: string) {
  const addActiveTime = useProgress((s) => s.addActiveTime)

  useEffect(() => {
    let lastInteraction = Date.now()
    const onInteract = () => {
      lastInteraction = Date.now()
    }
    const events = ['keydown', 'pointerdown', 'pointermove', 'scroll', 'touchstart'] as const
    for (const e of events) window.addEventListener(e, onInteract, { passive: true })
    const timer = window.setInterval(() => {
      const active = document.visibilityState === 'visible' && Date.now() - lastInteraction < IDLE_LIMIT_MS
      if (active) void addActiveTime(TICK_SECONDS, lessonId)
    }, TICK_SECONDS * 1000)
    return () => {
      window.clearInterval(timer)
      for (const e of events) window.removeEventListener(e, onInteract)
    }
  }, [addActiveTime, lessonId])
}
