import { useMemo, useState } from 'react'
import type { TroubleshootingScenario } from '@/content/exercise-schemas'
import { cn } from '@/lib/cn'
import { Badge, Button, Callout, Icon, RichText } from '@/ui'

interface Props {
  scenario: TroubleshootingScenario
  /** Se llama al llegar a un final exitoso, con los minutos que llevó. */
  onSolved?: (minutes: number) => void
}

interface Visit {
  node: string
  /** Opción elegida en ese nodo (índice), si ya se eligió. */
  choice?: number
}

/** Camino de menor tiempo desde el inicio hasta un final exitoso (Dijkstra sobre los minutos). */
export function optimalPath(s: TroubleshootingScenario): { minutes: number; path: string[] } | undefined {
  const dist = new Map<string, number>([[s.inicio, 0]])
  const prev = new Map<string, string>()
  const queue = [s.inicio]
  const done = new Set<string>()
  while (queue.length) {
    queue.sort((a, b) => dist.get(a)! - dist.get(b)!)
    const id = queue.shift()!
    if (done.has(id)) continue
    done.add(id)
    const node = s.nodos[id]
    if (node.final === 'exito') {
      const path = [id]
      while (prev.has(path[0])) path.unshift(prev.get(path[0])!)
      return { minutes: dist.get(id)!, path }
    }
    for (const op of node.opciones) {
      const d = dist.get(id)! + op.minutos
      if (!dist.has(op.ir_a) || d < dist.get(op.ir_a)!) {
        dist.set(op.ir_a, d)
        prev.set(op.ir_a, id)
        queue.push(op.ir_a)
      }
    }
  }
  return undefined
}

/** Los escenarios de decisión (todas las opciones con 0 minutos) no muestran reloj ni comparan con el camino más corto. */
export function isTimed(s: TroubleshootingScenario): boolean {
  return Object.values(s.nodos).some((n) => n.opciones.some((o) => o.minutos > 0))
}

export function Troubleshooting({ scenario, onSolved }: Props) {
  const [visits, setVisits] = useState<Visit[]>([{ node: scenario.inicio }])
  const optimal = useMemo(() => optimalPath(scenario), [scenario])
  const timed = useMemo(() => isTimed(scenario), [scenario])
  const current = visits[visits.length - 1]
  const node = scenario.nodos[current.node]
  const minutes = visits.reduce((sum, v) => sum + (v.choice !== undefined ? scenario.nodos[v.node].opciones[v.choice].minutos : 0), 0)
  const last = visits.length > 1 ? visits[visits.length - 2] : undefined
  const lastOption = last?.choice !== undefined ? scenario.nodos[last.node].opciones[last.choice] : undefined

  const choose = (i: number) => {
    const op = node.opciones[i]
    const next: Visit[] = [...visits.slice(0, -1), { node: current.node, choice: i }, { node: op.ir_a }]
    setVisits(next)
    if (scenario.nodos[op.ir_a].final === 'exito') {
      const total = next.reduce((sum, v) => sum + (v.choice !== undefined ? scenario.nodos[v.node].opciones[v.choice].minutos : 0), 0)
      onSolved?.(total)
    }
  }

  const restart = () => setVisits([{ node: scenario.inicio }])

  return (
    <div className="my-6 rounded-xl border border-line bg-surface shadow-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-4">
        <div className="min-w-0 flex-1">
          <h3 className="text-lg font-semibold">{scenario.titulo}</h3>
          {scenario.descripcion && <RichText text={scenario.descripcion} className="text-sm text-muted" />}
        </div>
        {timed && (
          <Badge tone="neutral">
            <Icon name="clock" className="h-3.5 w-3.5" />
            {minutes} min
          </Badge>
        )}
      </div>
      <div className="space-y-4 p-4">
        {lastOption?.consecuencia && (
          <Callout tone={node.final === 'fracaso' ? 'bad' : 'info'} title="Lo que pasó">
            <RichText text={lastOption.consecuencia} />
          </Callout>
        )}
        {node.situacion && <RichText text={node.situacion} />}
        {node.evidencia.length > 0 && (
          <div className="space-y-2">
            {node.evidencia.map((e, i) => (
              <details key={i} open={i === 0} className="rounded-lg border border-line">
                <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{e.titulo}</summary>
                <pre className="overflow-x-auto px-3 pb-3 font-mono text-xs leading-relaxed sm:text-sm" style={{ background: 'var(--term-bg)', color: 'var(--term-fg)' }}>
                  {e.contenido}
                </pre>
              </details>
            ))}
          </div>
        )}
        {node.final ? (
          <div className="space-y-3">
            <Callout tone={node.final === 'exito' ? 'ok' : 'bad'} title={node.final === 'exito' ? (timed ? `Problema resuelto en ${minutes} minutos` : 'Buena decisión') : timed ? 'Este camino no resolvió el problema' : 'Esta decisión no fue la mejor'}>
              {node.resumen && <RichText text={node.resumen} />}
            </Callout>
            {timed && optimal && node.final === 'exito' && (
              <p className="text-sm text-muted">
                {minutes <= optimal.minutes ? '¡Elegiste el camino más rápido posible!' : `El camino más corto lleva ${optimal.minutes} minutos (tardaste ${minutes - optimal.minutes} más). Repasa qué conviene revisar primero.`}
              </p>
            )}
            <Button onClick={restart}>
              <Icon name="refresh" className="h-4 w-4" />
              {node.final === 'exito' ? 'Volver a empezar' : 'Intentar de nuevo'}
            </Button>
          </div>
        ) : (
          <div className="space-y-2" role="group" aria-label="¿Qué haces?">
            <div className="text-sm font-semibold">¿Qué haces?</div>
            {node.opciones.map((op, i) => (
              <button key={i} type="button" onClick={() => choose(i)} className="flex min-h-11 w-full items-center gap-3 rounded-lg border border-line px-3 py-2 text-left hover:border-accent hover:bg-accent-soft">
                <Icon name="arrowRight" className="h-4 w-4 text-accent" />
                <span className="flex-1">{op.texto}</span>
              </button>
            ))}
          </div>
        )}
        {visits.length > 1 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted">Tu recorrido ({visits.length - 1} decisiones)</summary>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              {visits
                .filter((v) => v.choice !== undefined)
                .map((v, i) => {
                  const op = scenario.nodos[v.node].opciones[v.choice!]
                  const inOptimal = optimal?.path.includes(op.ir_a) && optimal.path.includes(v.node)
                  return (
                    <li key={i} className={cn(inOptimal ? 'text-fg' : 'text-muted')}>
                      {op.texto} {timed && <span className="text-xs">({op.minutos} min)</span>}
                    </li>
                  )
                })}
            </ol>
            {visits.length > 1 && !node.final && (
              <button
                type="button"
                className="mt-2 text-xs text-accent underline"
                onClick={() => setVisits((vs) => {
                  const trimmed = vs.slice(0, -1)
                  return [...trimmed.slice(0, -1), { node: trimmed[trimmed.length - 1].node }]
                })}
              >
                Deshacer la última decisión
              </button>
            )}
          </details>
        )}
      </div>
    </div>
  )
}
