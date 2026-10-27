import type { DiagnosticLabel } from '@/progress/types'

/** Corte temprano: 4 errores en las primeras 5 preguntas del nivel. */
export function shouldStopEarly(results: boolean[]): boolean {
  const first = results.slice(0, 5)
  return first.length === 5 && first.filter((r) => !r).length >= 4
}

/** Al terminar un nivel: si quedó por debajo de 40%, el diagnóstico se detiene. */
export const DIAGNOSTIC_STOP_BELOW = 0.4

export function levelStops(results: boolean[]): boolean {
  if (results.length === 0) return false
  if (shouldStopEarly(results)) return true
  const score = results.filter(Boolean).length / results.length
  return score < DIAGNOSTIC_STOP_BELOW
}

export function labelFor(correct: number, total: number): DiagnosticLabel | undefined {
  if (total === 0) return undefined
  if (correct === total) return 'dominado'
  if (correct / total >= 0.5) return 'repasar'
  return 'estudiar'
}

/** Etiqueta cada módulo según las preguntas que le tocaron en el diagnóstico. */
export function labelModules(answers: { moduleId: string; correct: boolean }[]): Record<string, DiagnosticLabel> {
  const map = new Map<string, { c: number; t: number }>()
  for (const a of answers) {
    const s = map.get(a.moduleId) ?? { c: 0, t: 0 }
    s.t++
    if (a.correct) s.c++
    map.set(a.moduleId, s)
  }
  const out: Record<string, DiagnosticLabel> = {}
  for (const [id, s] of map) {
    const label = labelFor(s.c, s.t)
    if (label) out[id] = label
  }
  return out
}

export const DIAGNOSTIC_LABELS: Record<DiagnosticLabel, { texto: string; tono: 'ok' | 'warn' | 'bad' }> = {
  dominado: { texto: 'Dominado', tono: 'ok' },
  repasar: { texto: 'Repasar', tono: 'warn' },
  estudiar: { texto: 'Estudiar', tono: 'bad' },
}
