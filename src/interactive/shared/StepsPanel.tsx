import { cn } from '@/lib/cn'
import { Badge, Button, Callout, Icon, RichText } from '@/ui'

export interface StepLike<C> {
  consigna: string
  verificar: C[]
  pistas: string[]
  solucion: string
  explicacion?: string
}

export interface StepCheckResult {
  ok: boolean
  detalle?: string
}

interface Props<C> {
  pasos: StepLike<C>[]
  step: number
  done: boolean
  checks?: StepCheckResult[]
  label: (c: C) => string
  hints: number
  onHint: () => void
  showSolution: boolean
  onToggleSolution: () => void
  onLoadSolution: (s: string) => void
  /** Qué se completó (para el mensaje final). */
  doneText: string
  loadLabel?: string
}

/** El panel de pasos de los ejercicios de consola (Python, PromQL, LogQL): consigna, verificaciones, pistas y solución. */
export function StepsPanel<C>({ pasos, step, done, checks, label, hints, onHint, showSolution, onToggleSolution, onLoadSolution, doneText, loadLabel = 'Cargarla en el editor' }: Props<C>) {
  const current = pasos[step]
  if (!current) return null
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge tone={done ? 'ok' : 'accent'}>{done ? 'Ejercicio completado' : `Paso ${step + 1} de ${pasos.length}`}</Badge>
        <div className="flex min-w-0 flex-wrap gap-1" aria-hidden>
          {pasos.map((_, i) => (
            <span key={i} className={cn('h-1.5 w-6 rounded-full', i < step || done ? 'bg-ok' : i === step ? 'bg-accent' : 'bg-surface-2')} />
          ))}
        </div>
      </div>
      {done ? (
        <div className="flex items-start gap-2 text-ok">
          <Icon name="check" />
          <p>{doneText}</p>
        </div>
      ) : (
        <>
          <RichText text={current.consigna} />
          <ul className="mt-3 space-y-1 text-sm" aria-label="Verificaciones del paso">
            {current.verificar.map((c, i) => {
              const r = checks?.[i]
              return (
                <li key={i} className={cn('flex items-start gap-2', r ? (r.ok ? 'text-ok' : 'text-bad') : 'text-muted')}>
                  <Icon name={r ? (r.ok ? 'check' : 'x') : 'target'} className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="text-fg">
                    {label(c)}
                    {r && !r.ok && r.detalle && <span className="block font-mono text-xs text-muted [overflow-wrap:anywhere]">{r.detalle}</span>}
                  </span>
                </li>
              )
            })}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            {current.pistas.length > 0 && hints < current.pistas.length && (
              <Button variant="secondary" onClick={onHint}>
                <Icon name="lightbulb" className="h-4 w-4" />
                {hints === 0 ? 'Ver una pista' : 'Otra pista'}
              </Button>
            )}
            <Button variant="ghost" onClick={onToggleSolution}>
              {showSolution ? 'Ocultar solución' : 'Ver solución'}
            </Button>
          </div>
          {hints > 0 && (
            <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm">
              {current.pistas.slice(0, hints).map((p, i) => (
                <li key={i}>
                  <RichText text={p} />
                </li>
              ))}
            </ol>
          )}
          {showSolution && (
            <div className="mt-3 space-y-2">
              <pre className="overflow-x-auto rounded-lg p-3 font-mono text-xs sm:text-sm" style={{ background: 'var(--term-bg)', color: 'var(--term-fg)' }}>
                {current.solucion}
              </pre>
              <Button variant="secondary" onClick={() => onLoadSolution(current.solucion)}>
                {loadLabel}
              </Button>
            </div>
          )}
        </>
      )}
      {step > 0 && !done && pasos[step - 1].explicacion && (
        <Callout tone="ok" title="Sobre el paso anterior" className="mt-3">
          <RichText text={pasos[step - 1].explicacion!} />
        </Callout>
      )}
      {done && pasos[pasos.length - 1].explicacion && (
        <Callout tone="ok" className="mt-3">
          <RichText text={pasos[pasos.length - 1].explicacion!} />
        </Callout>
      )}
    </div>
  )
}
