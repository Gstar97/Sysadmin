import { useCallback, useEffect, useState } from 'react'
import type { TerminalExercise as Exercise } from '@/content/exercise-schemas'
import { cn } from '@/lib/cn'
import { Badge, Button, Callout, Icon, RichText, Spinner } from '@/ui'
import { createTerm, type CheckResult, type TermSession } from './sessions'
import { Terminal } from './Terminal'

interface Props {
  exercise: Exercise
  /** Se llama una vez cuando se completan todos los pasos. */
  onComplete?: () => void
}

const BANNERS: Record<Exercise['shell'], string> = {
  bash: 'Terminal simulada. Escribe "help" para ver los comandos internos o "man comando" para la ayuda.',
  powershell: 'Windows PowerShell (simulada)\nCopyright (C) Microsoft Corporation. All rights reserved.\n\nUsa Get-Help <comando> para la ayuda y Get-Command para ver los comandos disponibles.',
  ios: 'Consola simulada de un equipo Cisco. Escribe ? para ver los comandos disponibles en cada modo.\n\nPress RETURN to get started.',
}

export function TerminalExercise({ exercise, onComplete }: Props) {
  const [session, setSession] = useState<TermSession>()
  const [error, setError] = useState<string>()
  const [step, setStep] = useState(0)
  const [checks, setChecks] = useState<CheckResult[]>([])
  const [hints, setHints] = useState(0)
  const [showSolution, setShowSolution] = useState(false)
  const [done, setDone] = useState(false)
  const [, setTick] = useState(0)
  const pasos = exercise.pasos

  const [run, setRun] = useState(0)

  useEffect(() => {
    let cancelled = false
    createTerm(exercise.shell, exercise.estado_inicial)
      .then((s) => {
        if (cancelled) return
        setSession(s)
        if (pasos.length) setChecks(pasos[0].verificar.map((c) => ({ ...s.verify(c), ok: false })))
      })
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [exercise, pasos, run])

  const restart = () => {
    setSession(undefined)
    setError(undefined)
    setStep(0)
    setChecks([])
    setHints(0)
    setShowSolution(false)
    setDone(false)
    setRun((r) => r + 1)
  }

  const evaluate = useCallback(
    (s: TermSession, index: number) => {
      const current = pasos[index]
      if (!current) return
      const results = current.verificar.map((c) => s.verify(c))
      setChecks(results)
      if (results.every((r) => r.ok)) {
        if (index + 1 < pasos.length) {
          setStep(index + 1)
          setHints(0)
          setShowSolution(false)
          setChecks(pasos[index + 1].verificar.map((c) => s.verify(c)).map((r) => ({ ...r, ok: false })))
        } else {
          setDone(true)
          onComplete?.()
        }
      }
    },
    [pasos, onComplete],
  )

  if (error) return <Callout tone="bad" title="No se pudo iniciar la terminal">{error}</Callout>
  if (!session) return <Spinner label="Preparando la terminal…" />

  const current = pasos[step]
  const devices = session.devices?.() ?? []

  return (
    <div className="my-6 space-y-3">
      {(exercise.titulo || exercise.descripcion) && (
        <div>
          {exercise.titulo && <h3 className="text-lg font-semibold">{exercise.titulo}</h3>}
          {exercise.descripcion && <RichText text={exercise.descripcion} className="text-muted" />}
        </div>
      )}
      {pasos.length > 0 && (
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge tone={done ? 'ok' : 'accent'}>{done ? 'Ejercicio completado' : `Paso ${step + 1} de ${pasos.length}`}</Badge>
            <div className="flex gap-1" aria-hidden>
              {pasos.map((_, i) => (
                <span key={i} className={cn('h-1.5 w-6 rounded-full', i < step || done ? 'bg-ok' : i === step ? 'bg-accent' : 'bg-surface-2')} />
              ))}
            </div>
          </div>
          {done ? (
            <div className="flex items-start gap-2 text-ok">
              <Icon name="check" />
              <p>Completaste todos los pasos. Puedes seguir practicando en la misma terminal o reiniciarla para empezar de nuevo.</p>
            </div>
          ) : (
            current && (
              <>
                <RichText text={current.consigna} />
                <ul className="mt-3 space-y-1 text-sm" aria-label="Verificaciones del paso">
                  {checks.map((c, i) => (
                    <li key={i} className={cn('flex items-start gap-2', c.ok ? 'text-ok' : 'text-muted')}>
                      <Icon name={c.ok ? 'check' : 'target'} className="mt-0.5 h-4 w-4" />
                      <span>{c.label}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 flex flex-wrap gap-2">
                  {current.pistas.length > 0 && hints < current.pistas.length && (
                    <Button variant="secondary" onClick={() => setHints((h) => h + 1)}>
                      <Icon name="lightbulb" className="h-4 w-4" />
                      {hints === 0 ? 'Ver una pista' : 'Otra pista'}
                    </Button>
                  )}
                  {current.solucion.length > 0 && (
                    <Button variant="ghost" onClick={() => setShowSolution((v) => !v)}>
                      {showSolution ? 'Ocultar solución' : 'Ver solución'}
                    </Button>
                  )}
                  <Button variant="ghost" onClick={() => evaluate(session, step)}>
                    <Icon name="refresh" className="h-4 w-4" />
                    Verificar
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
                  <pre className="mt-3 overflow-x-auto rounded-lg p-3 font-mono text-sm" style={{ background: 'var(--term-bg)', color: 'var(--term-fg)' }}>
                    {current.solucion.join('\n')}
                  </pre>
                )}
              </>
            )
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
      )}
      <Terminal
        session={session}
        banner={BANNERS[exercise.shell]}
        onCommand={() => {
          if (!done) evaluate(session, step)
        }}
        toolbar={
          <>
            {devices.length > 1 && (
              <label className="flex items-center gap-1">
                <span className="sr-only">Equipo conectado a la consola</span>
                <select
                  className="rounded bg-white/10 px-1.5 py-0.5 text-xs text-inherit"
                  value={session.currentDevice?.()}
                  onChange={(e) => {
                    session.attach?.(e.target.value)
                    setTick((t) => t + 1)
                    setSession({ ...session })
                  }}
                >
                  {devices.map((d) => (
                    <option key={d.id} value={d.id} className="text-black">
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button type="button" onClick={restart} className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-white/10" title="Reiniciar la terminal al estado inicial">
              <Icon name="refresh" className="h-3.5 w-3.5" />
              Reiniciar
            </button>
          </>
        }
      />
    </div>
  )
}
