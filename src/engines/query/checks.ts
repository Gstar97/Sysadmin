/**
 * Verificaciones de los ejercicios de consultas (PromQL y LogQL): las dos consolas producen un
 * QueryOutcome y estas funciones lo comparan con lo que pide el paso.
 */
import type { QueryCheck } from '@/content/exercise-schemas'

export type Labels = Record<string, string>

export interface QueryOutcome {
  error?: string
  /** vector, escalar, matriz (rango) o líneas de log. */
  kind?: 'vector' | 'escalar' | 'matriz' | 'lineas' | 'texto'
  /** Series del resultado con su valor (en vectores y escalares) o streams en los logs. */
  series: { labels: Labels; value?: number }[]
  lines?: { labels: Labels; line: string; t: number }[]
  /** Funciones, operadores y palabras clave que usa la consulta. */
  uses: Set<string>
  query: string
}

export interface CheckResult {
  ok: boolean
  detalle?: string
}

const fmtLabels = (l: Labels) => `{${Object.entries(l).map(([k, v]) => `${k}="${v}"`).join(', ')}}`
const has = (s: Labels, want: Labels) => Object.entries(want).every(([k, v]) => s[k] === v)
const num = (v: number) => (Math.abs(v) >= 1e6 || (Math.abs(v) < 0.001 && v !== 0) ? v.toExponential(3) : String(Math.round(v * 1000) / 1000))

export function queryCheckLabel(c: QueryCheck): string {
  if ('sin_error' in c) return 'La consulta corre sin errores'
  if ('series' in c) return c.series === 0 ? 'El resultado está vacío' : `El resultado tiene ${c.series === 1 ? 'una serie' : `${c.series} series`}`
  if ('series_min' in c) return `El resultado tiene al menos ${c.series_min} ${c.series_min === 1 ? 'serie' : 'series'}`
  if ('contiene' in c) return `Aparece la serie ${fmtLabels(c.contiene)}`
  if ('no_contiene' in c) return `No aparece la serie ${fmtLabels(c.no_contiene)}`
  if ('sin_etiqueta' in c) return `El resultado ya no tiene la etiqueta ${c.sin_etiqueta}`
  if ('con_etiqueta' in c) return `Cada serie conserva la etiqueta ${c.con_etiqueta}`
  if ('valor' in c) {
    const { min, max } = c.valor
    const r = min !== undefined && max !== undefined ? `entre ${num(min)} y ${num(max)}` : min !== undefined ? `de ${num(min)} o más` : `de ${num(max!)} o menos`
    return `${c.si ? `La serie ${fmtLabels(c.si)} tiene` : 'Los valores son'} ${r}`.replace('tiene de', 'vale').replace('son de', 'son')
  }
  if ('usa' in c) return c.mensaje ?? `La consulta usa ${c.usa}`
  if ('tipo' in c) return c.tipo === 'escalar' ? 'El resultado es un escalar' : c.tipo === 'lineas' ? 'El resultado son líneas de log' : 'El resultado es un vector instantáneo'
  if ('lineas' in c) return c.lineas === 0 ? 'No aparece ninguna línea' : `Aparecen ${c.lineas === 1 ? 'una línea' : `${c.lineas} líneas`}`
  if ('lineas_min' in c) return `Aparecen al menos ${c.lineas_min} líneas`
  if ('lineas_contienen' in c) return `Todas las líneas contienen "${c.lineas_contienen}"`
  return `Ninguna línea contiene "${c.lineas_no_contienen}"`
}

export function evaluateQueryChecks(o: QueryOutcome, checks: QueryCheck[]): CheckResult[] {
  return checks.map((c): CheckResult => {
    if ('usa' in c) {
      const word = c.usa
      const re = new RegExp(`(^|[^\\w])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w]|$)`)
      return { ok: o.uses.has(word) || re.test(o.query.replace(/"(?:[^"\\]|\\.)*"|`[^`]*`/g, '""')) }
    }
    if (o.error) return { ok: false, detalle: o.error }
    if ('sin_error' in c) return { ok: true }
    const n = o.series.length
    if ('series' in c) return { ok: n === c.series, detalle: `tiene ${n}` }
    if ('series_min' in c) return { ok: n >= c.series_min, detalle: `tiene ${n}` }
    if ('contiene' in c) return { ok: o.series.some((s) => has(s.labels, c.contiene)) }
    if ('no_contiene' in c) return { ok: !o.series.some((s) => has(s.labels, c.no_contiene)) }
    if ('sin_etiqueta' in c) return { ok: n > 0 && o.series.every((s) => s.labels[c.sin_etiqueta] === undefined) }
    if ('con_etiqueta' in c) return { ok: n > 0 && o.series.every((s) => s.labels[c.con_etiqueta] !== undefined) }
    if ('valor' in c) {
      const target = o.series.filter((s) => !c.si || has(s.labels, c.si))
      if (!target.length) return { ok: false, detalle: c.si ? 'esa serie no está en el resultado' : 'el resultado está vacío' }
      const bad = target.find((s) => s.value === undefined || Number.isNaN(s.value) || (c.valor.min !== undefined && s.value < c.valor.min) || (c.valor.max !== undefined && s.value > c.valor.max))
      return { ok: !bad, detalle: bad ? `${fmtLabels(bad.labels)} vale ${bad.value === undefined ? '(sin valor)' : num(bad.value)}` : undefined }
    }
    if ('tipo' in c) {
      const k = o.kind === 'matriz' ? 'vector de rango' : o.kind
      return { ok: (c.tipo === 'escalar' ? 'escalar' : c.tipo) === o.kind, detalle: `es ${k === 'escalar' ? 'un escalar' : k === 'lineas' ? 'una lista de líneas' : `un ${k}`}` }
    }
    const lines = o.lines ?? []
    if ('lineas' in c) return { ok: lines.length === c.lineas, detalle: `aparecen ${lines.length}` }
    if ('lineas_min' in c) return { ok: lines.length >= c.lineas_min, detalle: `aparecen ${lines.length}` }
    if ('lineas_contienen' in c) {
      const bad = lines.find((l) => !l.line.includes(c.lineas_contienen))
      return { ok: lines.length > 0 && !bad, detalle: bad ? bad.line.slice(0, 120) : lines.length ? undefined : 'no hay líneas' }
    }
    const bad = lines.find((l) => l.line.includes(c.lineas_no_contienen))
    return { ok: !bad, detalle: bad?.line.slice(0, 120) }
  })
}
