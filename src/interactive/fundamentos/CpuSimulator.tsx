import { useEffect, useState } from 'react'
import { createCpu, formatInstruction, OP_HELP, PROGRAMS, stepCpu, type CpuState, type OpCode } from '@/engines/fundamentos/cpu'
import { cn } from '@/lib/cn'
import { Button, Icon } from '@/ui'
import { Chip, Frame } from './Frame'

const PHASES = [
  { id: 'buscar', label: 'Buscar' },
  { id: 'decodificar', label: 'Decodificar' },
  { id: 'ejecutar', label: 'Ejecutar' },
] as const

export function CpuSimulator({ programa = 'suma' }: { programa?: string }) {
  const [programId, setProgramId] = useState(PROGRAMS.some((p) => p.id === programa) ? programa : PROGRAMS[0].id)
  const [withCache, setWithCache] = useState(false)
  const program = PROGRAMS.find((p) => p.id === programId)!
  const [state, setState] = useState<CpuState>(() => createCpu(program, withCache))
  const [running, setRunning] = useState(false)

  useEffect(() => {
    if (!running) return
    if (state.halted) {
      const t = setTimeout(() => setRunning(false), 0)
      return () => clearTimeout(t)
    }
    const t = setTimeout(() => setState((s) => stepCpu(s)), 450)
    return () => clearTimeout(t)
  }, [running, state])

  const reset = (id = programId, cache = withCache) => {
    setRunning(false)
    setState(createCpu(PROGRAMS.find((p) => p.id === id)!, cache))
  }

  return (
    <Frame
      titulo="Simulador de CPU"
      acciones={PROGRAMS.map((p) => (
        <Chip
          key={p.id}
          active={p.id === programId}
          onClick={() => {
            setProgramId(p.id)
            reset(p.id)
          }}
        >
          {p.nombre}
        </Chip>
      ))}
    >
      <p className="mb-3 text-sm text-muted">{program.descripcion}</p>
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <div className="mb-1 text-sm font-medium">Memoria (16 celdas)</div>
          <div className="grid grid-cols-4 gap-1.5" role="list" aria-label="Memoria">
            {state.memory.map((c, i) => (
              <div
                key={i}
                role="listitem"
                className={cn(
                  'relative rounded-md border px-1.5 py-1 font-mono text-xs',
                  i === state.pc && !state.halted ? 'border-accent ring-2 ring-accent/40' : 'border-line',
                  state.touched?.cell === i && (state.touched.kind === 'read' ? 'bg-info-soft' : 'bg-warn-soft'),
                  state.cache?.has(i) && 'outline outline-1 outline-dashed outline-ok',
                )}
                aria-label={`Celda ${i}: ${formatInstruction(c)}${i === state.pc ? ' (apunta el PC)' : ''}`}
              >
                <div className="text-[10px] text-muted">{i}</div>
                <div className={cn('truncate', typeof c === 'number' ? 'text-fg' : 'font-semibold text-accent')}>{formatInstruction(c)}</div>
              </div>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted">Borde verde: la celda a la que apunta el PC. Azul: se leyó. Amarillo: se escribió.{withCache && ' Línea punteada: la celda está en la caché.'}</p>
        </div>
        <div className="space-y-3">
          <div className="flex gap-1" aria-label="Fase del ciclo">
            {PHASES.map((p) => (
              <span key={p.id} className={cn('flex-1 rounded-md border px-2 py-1 text-center text-xs font-medium', state.phase === p.id && !state.halted ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted')}>
                {p.label}
              </span>
            ))}
          </div>
          <dl className="grid grid-cols-3 gap-2 text-center">
            {[
              { k: 'pc', label: 'PC', value: state.pc, hint: 'próxima instrucción' },
              { k: 'ir', label: 'IR', value: state.ir ? formatInstruction(state.ir) : '—', hint: 'instrucción actual' },
              { k: 'acc', label: 'ACC', value: state.acc, hint: 'acumulador' },
            ].map((r) => (
              <div key={r.k} className={cn('rounded-lg border p-2 transition', state.changed === r.k ? 'border-accent bg-accent-soft' : 'border-line')}>
                <dt className="text-xs text-muted">{r.label}</dt>
                <dd className="font-mono text-lg font-semibold">{r.value}</dd>
                <dd className="text-[10px] text-muted">{r.hint}</dd>
              </div>
            ))}
          </dl>
          <div className="rounded-lg bg-surface-2 p-3 text-sm" aria-live="polite">
            {state.message}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span>
              Salida: <span className="font-mono font-semibold">{state.output.length ? state.output.join(' ') : '—'}</span>
            </span>
            <span>
              Ciclos: <span className="font-mono font-semibold">{state.cycles}</span>
            </span>
            {state.cache && (
              <span className="text-muted">
                Caché: {state.cacheHits} aciertos, {state.cacheMisses} fallos
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setState(stepCpu(state))} disabled={state.halted || running}>
              Paso
            </Button>
            <Button variant="secondary" onClick={() => setRunning((r) => !r)} disabled={state.halted}>
              <Icon name={running ? 'pause' : 'play'} className="h-4 w-4" />
              {running ? 'Pausa' : 'Ejecutar todo'}
            </Button>
            <Button variant="ghost" onClick={() => reset()}>
              <Icon name="refresh" className="h-4 w-4" />
              Reiniciar
            </Button>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={withCache}
                onChange={(e) => {
                  setWithCache(e.target.checked)
                  reset(programId, e.target.checked)
                }}
              />
              Con caché (RAM: 100 ciclos, caché: 4)
            </label>
          </div>
        </div>
      </div>
      <details className="mt-4 text-sm">
        <summary className="cursor-pointer font-medium">Instrucciones que entiende esta CPU</summary>
        <dl className="mt-2 grid gap-1 sm:grid-cols-2">
          {(Object.keys(OP_HELP) as OpCode[]).map((op) => (
            <div key={op} className="flex gap-2">
              <dt className="w-14 shrink-0 font-mono font-semibold">{op}</dt>
              <dd className="text-muted">{OP_HELP[op]}</dd>
            </div>
          ))}
        </dl>
      </details>
    </Frame>
  )
}
