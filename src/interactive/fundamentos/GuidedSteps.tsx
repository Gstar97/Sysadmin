import { useState } from 'react'
import type { GuidedSteps as GuidedStepsData } from '@/content/exercise-schemas'
import { cn } from '@/lib/cn'
import { Button, Icon, ProgressBar, RichText } from '@/ui'
import { Chip } from './Frame'

function load(key: string): number[] {
  try {
    const raw = localStorage.getItem(key)
    if (raw) return (JSON.parse(raw) as number[]).filter((n) => Number.isInteger(n))
  } catch {
    // almacenamiento no disponible
  }
  return []
}

function save(key: string, value: number[]) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // almacenamiento no disponible
  }
}

function Commands({ lines }: { lines: string[] }) {
  const [copied, setCopied] = useState(false)
  if (!lines.length) return null
  return (
    <div className="relative mt-2">
      <pre className="overflow-x-auto rounded-lg p-3 pr-20 font-mono text-sm" style={{ background: 'var(--term-bg)', color: 'var(--term-fg)' }}>
        {lines.join('\n')}
      </pre>
      <button
        type="button"
        className="absolute right-2 top-2 rounded-md border border-white/20 px-2 py-0.5 text-xs text-white/80 hover:bg-white/10"
        onClick={() => {
          void navigator.clipboard?.writeText(lines.join('\n')).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
      >
        {copied ? 'Copiado' : 'Copiar'}
      </button>
    </div>
  )
}

/** Pasos para hacer en la computadora propia, con casillas que se guardan en este navegador. */
export function GuidedSteps({ data, storageKey }: { data: GuidedStepsData; storageKey: string }) {
  const key = `carrera-infra:pasos:${storageKey}`
  const [done, setDone] = useState<number[]>(() => load(key))
  const [open, setOpen] = useState<number>(() => {
    const first = data.pasos.findIndex((_, i) => !load(key).includes(i))
    return first === -1 ? 0 : first
  })
  const [variant, setVariant] = useState<Record<number, number>>({})

  const toggle = (i: number) => {
    const next = done.includes(i) ? done.filter((d) => d !== i) : [...done, i]
    setDone(next)
    save(key, next)
    if (!done.includes(i)) {
      const following = data.pasos.findIndex((_, j) => j > i && !next.includes(j))
      if (following !== -1) setOpen(following)
    }
  }

  const count = data.pasos.filter((_, i) => done.includes(i)).length
  return (
    <div className="my-6 overflow-hidden rounded-xl border border-line bg-surface shadow-card">
      <div className="border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          <Icon name="lab" className="h-4 w-4 text-accent" />
          <h3 className="text-base font-semibold">{data.titulo}</h3>
        </div>
        {data.descripcion && <RichText text={data.descripcion} className="mt-1 text-sm text-muted" />}
        <div className="mt-2 flex items-center gap-3 text-sm">
          <span className="whitespace-nowrap">
            {count} de {data.pasos.length}
          </span>
          <ProgressBar value={count / data.pasos.length} tone={count === data.pasos.length ? 'ok' : 'accent'} label="Pasos completados" />
        </div>
      </div>
      <ol>
        {data.pasos.map((p, i) => {
          const isDone = done.includes(i)
          const isOpen = open === i
          const v = p.variantes[variant[i] ?? 0]
          return (
            <li key={i} className="border-b border-line last:border-b-0">
              <div className="flex items-center gap-3 px-4 py-2">
                <button
                  type="button"
                  aria-label={isDone ? `Desmarcar el paso ${i + 1}` : `Marcar el paso ${i + 1} como hecho`}
                  aria-pressed={isDone}
                  onClick={() => toggle(i)}
                  className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded border-2', isDone ? 'border-ok bg-ok text-white' : 'border-line hover:border-accent')}
                >
                  {isDone && <Icon name="check" className="h-4 w-4" />}
                </button>
                <button type="button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? -1 : i)} className={cn('flex min-h-9 flex-1 items-center gap-2 text-left', isDone && 'text-muted line-through decoration-1')}>
                  <span className="text-sm font-semibold text-muted">{i + 1}.</span>
                  <span className="font-medium">{p.titulo}</span>
                  <Icon name="chevron" className={cn('ml-auto h-4 w-4 shrink-0 transition', isOpen ? 'rotate-90' : '')} />
                </button>
              </div>
              {isOpen && (
                <div className="space-y-2 px-4 pb-4 pl-13 text-sm">
                  {p.detalle && <RichText text={p.detalle} />}
                  <Commands lines={p.comandos} />
                  {p.variantes.length > 0 && (
                    <div>
                      <div className="flex flex-wrap gap-2">
                        {p.variantes.map((x, j) => (
                          <Chip key={x.nombre} active={(variant[i] ?? 0) === j} onClick={() => setVariant((s) => ({ ...s, [i]: j }))}>
                            {x.nombre}
                          </Chip>
                        ))}
                      </div>
                      <div className="mt-2">
                        <RichText text={v.detalle} />
                        <Commands lines={v.comandos} />
                      </div>
                    </div>
                  )}
                  {p.comprobar && (
                    <div className="rounded-lg border border-ok/40 bg-ok-soft p-2">
                      <b>Cómo saber que salió bien</b>
                      <RichText text={p.comprobar} />
                    </div>
                  )}
                  {p.si_falla && (
                    <div className="rounded-lg border border-warn/40 bg-warn-soft p-2">
                      <b>Si algo falla</b>
                      <RichText text={p.si_falla} />
                    </div>
                  )}
                  {!isDone && (
                    <Button variant="secondary" className="min-h-9" onClick={() => toggle(i)}>
                      <Icon name="check" className="h-4 w-4" />
                      Listo, siguiente paso
                    </Button>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
