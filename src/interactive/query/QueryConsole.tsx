import { useMemo, useRef, useState } from 'react'
import type { QueryCheck } from '@/content/exercise-schemas'
import { evaluateQueryChecks, queryCheckLabel, type CheckResult, type QueryOutcome } from '@/engines/query/checks'
import { cn } from '@/lib/cn'
import { Button, Icon, RichText } from '@/ui'
import { StepsPanel, type StepLike } from '../shared/StepsPanel'
import { LineChart, seriesColor, shortNumber, type ChartSeries } from './LineChart'

type Labels = Record<string, string>

/** Lo que cada lenguaje (PromQL, LogQL) le da a la consola. */
export interface QueryAdapter {
  lang: 'PromQL' | 'LogQL'
  run(query: string): QueryOutcome
  /** Serie de tiempo para la pestaña Gráfico; undefined si la consulta no es de métricas. */
  graph(query: string): { series: { labels: Labels; samples: { t: number; v: number }[] }[]; step: number } | { error: string } | undefined
  /** Métricas (PromQL) o etiquetas y valores (LogQL) para explorar. */
  names: string[]
  now: number
  start: number
  end: number
  step: number
  placeholder: string
}

interface Props {
  adapter: QueryAdapter
  titulo?: string
  descripcion?: string
  inicial?: string
  pasos?: StepLike<QueryCheck>[]
}

const hhmm = (t: number) => new Date(t * 1000).toISOString().slice(11, 16)

export function labelText(l: Labels, withName = true): string {
  const name = withName ? (l.__name__ ?? '') : ''
  const rest = Object.keys(l)
    .filter((k) => k !== '__name__')
    .sort()
  return `${name}{${rest.map((k) => `${k}="${l[k]}"`).join(', ')}}`
}

/** Consola de consultas (PromQL o LogQL) sobre datos de ejemplo, con tabla, gráfico, líneas y pasos que se verifican solos. */
export function QueryConsole({ adapter, titulo, descripcion, inicial = '', pasos = [] }: Props) {
  const [query, setQuery] = useState(inicial)
  const [outcome, setOutcome] = useState<QueryOutcome>()
  const [graph, setGraph] = useState<{ series: ChartSeries[]; step: number } | { error: string }>()
  const [tab, setTab] = useState<'tabla' | 'grafico'>('tabla')
  const [step, setStep] = useState(0)
  const [done, setDone] = useState(false)
  const [checks, setChecks] = useState<CheckResult[]>()
  const [hints, setHints] = useState(0)
  const [showSolution, setShowSolution] = useState(false)
  const [explorar, setExplorar] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const current = pasos[step]

  const ejecutar = (q = query) => {
    const o = adapter.run(q)
    setOutcome(o)
    const g = o.error ? undefined : adapter.graph(q)
    setGraph(g === undefined ? undefined : 'error' in g ? g : { series: g.series.map((s) => ({ name: labelText(s.labels), samples: s.samples })), step: g.step })
    if (o.kind === 'lineas') setTab('tabla')
    if (!current || done) return
    const r = evaluateQueryChecks(o, current.verificar)
    setChecks(r)
    if (r.every((c) => c.ok)) {
      if (step + 1 >= pasos.length) setDone(true)
      else {
        setStep(step + 1)
        setHints(0)
        setShowSolution(false)
        setChecks(undefined)
      }
    }
  }

  const cargar = (q: string) => {
    setQuery(q)
    input.current?.focus()
  }

  const insertar = (name: string) => {
    const el = input.current
    if (!el) return cargar(name)
    const a = el.selectionStart ?? query.length
    const b = el.selectionEnd ?? query.length
    const next = query.slice(0, a) + name + query.slice(b)
    setQuery(next)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(a + name.length, a + name.length)
    })
  }

  const reiniciar = () => {
    setQuery(inicial)
    setOutcome(undefined)
    setGraph(undefined)
    setStep(0)
    setDone(false)
    setChecks(undefined)
    setHints(0)
    setShowSolution(false)
  }

  const rows = useMemo(() => outcome?.series ?? [], [outcome])
  const lines = outcome?.lines ?? []
  const nombre = titulo ?? `Consola de ${adapter.lang}`
  const rowsShown = useMemo(() => rows.slice(0, 200), [rows])

  return (
    <section className="my-6 space-y-3" aria-label={nombre}>
      {(titulo || descripcion) && (
        <div>
          {titulo && <h3 className="text-lg font-semibold">{titulo}</h3>}
          {descripcion && <RichText text={descripcion} className="text-muted" />}
        </div>
      )}
      {current && (
        <StepsPanel
          pasos={pasos}
          step={step}
          done={done}
          checks={checks}
          label={queryCheckLabel}
          hints={hints}
          onHint={() => setHints((h) => h + 1)}
          showSolution={showSolution}
          onToggleSolution={() => setShowSolution((v) => !v)}
          onLoadSolution={cargar}
          doneText="Completaste todos los pasos. Podés seguir probando consultas sobre los mismos datos o reiniciar el ejercicio."
          loadLabel="Cargarla en la consola"
        />
      )}
      <div className="overflow-hidden rounded-xl border border-line shadow-card">
        <div className="flex items-center gap-2 border-b border-line bg-surface-2 px-3 py-1.5 text-xs text-muted">
          <Icon name="search" className="h-4 w-4" />
          <span className="font-mono">{adapter.lang}</span>
          <span className="ml-auto">
            datos de ejemplo de {hhmm(adapter.start)} a {hhmm(adapter.end)} UTC
          </span>
        </div>
        <textarea
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              ejecutar()
            }
          }}
          rows={Math.min(6, Math.max(2, query.split('\n').length))}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={adapter.placeholder}
          aria-label={`Consulta de ${adapter.lang} (Enter para ejecutar, Mayúsculas+Enter para una línea nueva)`}
          className="block w-full resize-y bg-surface p-3 font-mono text-sm text-fg outline-none focus:ring-2 focus:ring-inset focus:ring-accent"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => ejecutar()}>
          <Icon name="play" className="h-4 w-4" />
          Ejecutar
        </Button>
        <Button variant="ghost" onClick={reiniciar}>
          <Icon name="refresh" className="h-4 w-4" />
          Reiniciar
        </Button>
        <Button variant="ghost" onClick={() => setExplorar((v) => !v)} aria-expanded={explorar}>
          <Icon name="layers" className="h-4 w-4" />
          {adapter.lang === 'PromQL' ? 'Métricas' : 'Etiquetas'}
        </Button>
        <span className="text-xs text-muted">Enter ejecuta; Mayúsculas+Enter, línea nueva.</span>
      </div>
      {explorar && (
        <div className="flex max-h-40 flex-wrap gap-1 overflow-auto rounded-xl border border-line bg-surface p-2">
          {adapter.names.map((n) => (
            <button key={n} type="button" onClick={() => insertar(n)} className="rounded-md bg-surface-2 px-2 py-0.5 font-mono text-xs hover:bg-accent-soft">
              {n}
            </button>
          ))}
        </div>
      )}
      <div className="rounded-xl border border-line bg-surface" aria-live="polite">
        {!outcome && <p className="p-3 text-sm text-muted">Escribí una consulta y ejecutala para ver el resultado.</p>}
        {outcome?.error && (
          <pre className="whitespace-pre-wrap p-3 font-mono text-sm text-bad [overflow-wrap:anywhere]" role="alert">
            {outcome.error}
          </pre>
        )}
        {outcome && !outcome.error && (
          <>
            {outcome.kind !== 'lineas' && (
              <div className="flex gap-1 border-b border-line p-1.5" role="tablist">
                {(['tabla', 'grafico'] as const).map((t) => (
                  <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn('rounded-md px-3 py-1 text-sm', tab === t ? 'bg-accent-soft font-medium text-fg' : 'text-muted hover:bg-surface-2')}>
                    {t === 'tabla' ? 'Tabla' : 'Gráfico'}
                  </button>
                ))}
                <span className="ml-auto self-center pr-2 text-xs text-muted">
                  {outcome.kind === 'escalar' ? 'escalar' : `${rows.length} ${rows.length === 1 ? 'serie' : 'series'}`} · a las {hhmm(adapter.now)}
                </span>
              </div>
            )}
            {outcome.kind === 'lineas' ? (
              <div>
                <div className="border-b border-line px-3 py-1.5 text-xs text-muted">
                  {lines.length} {lines.length === 1 ? 'línea' : 'líneas'} de {rows.length} {rows.length === 1 ? 'stream' : 'streams'}
                  {lines.length > 200 && ' (se muestran las 200 más nuevas)'}
                </div>
                <ol className="max-h-96 overflow-auto font-mono text-xs">
                  {lines.slice(0, 200).map((l, i) => (
                    <li key={i} className="flex gap-2 border-b border-line/60 px-3 py-1 last:border-0" title={labelText(l.labels, false)}>
                      <span className="shrink-0 text-muted">{new Date(l.t * 1000).toISOString().slice(11, 19)}</span>
                      <span className="whitespace-pre-wrap [overflow-wrap:anywhere]">{l.line}</span>
                    </li>
                  ))}
                </ol>
              </div>
            ) : tab === 'tabla' ? (
              rows.length === 0 ? (
                <p className="p-3 text-sm text-muted">Sin resultados: ninguna serie cumple la consulta en este momento.</p>
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {rowsShown.map((r, i) => (
                      <tr key={i} className="border-b border-line/60 last:border-0">
                        <td className="px-3 py-1.5 font-mono text-xs [overflow-wrap:anywhere]">{outcome.kind === 'escalar' ? 'escalar' : labelText(r.labels)}</td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono text-xs">{r.value === undefined ? '' : fmtValue(r.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            ) : graph === undefined ? (
              <p className="p-3 text-sm text-muted">Esta consulta no se puede graficar.</p>
            ) : 'error' in graph ? (
              <pre className="whitespace-pre-wrap p-3 font-mono text-sm text-bad">{graph.error}</pre>
            ) : (
              <div className="p-2">
                <LineChart series={graph.series} start={adapter.start} end={adapter.end} step={graph.step} label={`Gráfico de ${query}`} />
                <ul className="mt-1 max-h-28 space-y-0.5 overflow-auto px-2 text-xs">
                  {graph.series.slice(0, 30).map((s, i) => (
                    <li key={i} className="flex items-center gap-1.5">
                      <span className="inline-block h-2 w-3 shrink-0 rounded-sm" style={{ background: seriesColor(i) }} />
                      <span className="font-mono [overflow-wrap:anywhere]">{s.name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}

function fmtValue(v: number): string {
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v)
  if (!Number.isFinite(v)) return Number.isNaN(v) ? 'NaN' : v > 0 ? '+Inf' : '-Inf'
  const s = String(+v.toPrecision(10))
  return Math.abs(v) >= 1e6 ? `${s} (${shortNumber(v)})` : s
}
