import { useMemo, useState } from 'react'
import { schedule, type Algorithm, type Proc } from '@/engines/fundamentos/scheduler'
import { cn } from '@/lib/cn'
import { Button, Icon } from '@/ui'
import { Chip, Frame } from './Frame'

const COLORS = ['#0ea5e9', '#f59e0b', '#8b5cf6', '#10b981', '#ef4444', '#ec4899']
const ALGOS: { id: Algorithm; nombre: string; detalle: string }[] = [
  { id: 'fcfs', nombre: 'Por orden de llegada', detalle: 'FCFS: el primero que llega usa la CPU hasta terminar. Simple, pero un proceso largo hace esperar a todos.' },
  { id: 'rr', nombre: 'Turnos rotativos', detalle: 'Round Robin: cada proceso usa la CPU durante un "quantum" y vuelve a la cola. Ningún proceso acapara la CPU.' },
  { id: 'prioridad', nombre: 'Prioridades', detalle: 'El proceso listo con mayor prioridad (número más bajo) se ejecuta, y desaloja al que esté corriendo si llega uno más prioritario.' },
]

const INITIAL: Proc[] = [
  { id: 'A', llegada: 0, rafaga: 6, prioridad: 3 },
  { id: 'B', llegada: 1, rafaga: 2, prioridad: 1 },
  { id: 'C', llegada: 2, rafaga: 4, prioridad: 2 },
  { id: 'D', llegada: 3, rafaga: 1, prioridad: 4 },
]

export function SchedulerSim() {
  const [procs, setProcs] = useState<Proc[]>(INITIAL)
  const [algo, setAlgo] = useState<Algorithm>('rr')
  const [quantum, setQuantum] = useState(2)
  const result = useMemo(() => schedule(procs, algo, quantum), [procs, algo, quantum])
  const all = useMemo(() => ALGOS.map((a) => ({ a, r: schedule(procs, a.id, quantum) })), [procs, quantum])
  const end = result.segments.at(-1)?.end ?? 0
  const color = (id: string) => COLORS[procs.findIndex((p) => p.id === id) % COLORS.length]

  const update = (i: number, field: keyof Proc, value: number) => setProcs((ps) => ps.map((p, j) => (j === i ? { ...p, [field]: Math.max(field === 'rafaga' || field === 'prioridad' ? 1 : 0, Math.min(20, value || 0)) } : p)))

  return (
    <Frame
      titulo="Planificador de CPU"
      acciones={ALGOS.map((a) => (
        <Chip key={a.id} active={a.id === algo} onClick={() => setAlgo(a.id)}>
          {a.nombre}
        </Chip>
      ))}
    >
      <p className="mb-3 text-sm text-muted">{ALGOS.find((a) => a.id === algo)!.detalle}</p>
      {algo === 'rr' && (
        <label className="mb-3 flex items-center gap-2 text-sm">
          Quantum:
          <input type="number" min={1} max={10} value={quantum} onChange={(e) => setQuantum(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} className="w-16 rounded-lg border border-line bg-bg px-2 py-1" />
          unidades de tiempo
        </label>
      )}
      <div className="overflow-x-auto">
        <div className="relative min-w-[480px] px-2" aria-label="Diagrama de Gantt: qué proceso usa la CPU en cada momento">
          <div className="flex h-10">
            {result.segments.map((s, i) => (
              <div key={i} className={cn('flex items-center justify-center border-r border-bg text-sm font-semibold', !s.id && 'bg-surface-2 text-muted')} style={{ width: `${((s.end - s.start) / end) * 100}%`, background: s.id ? color(s.id) : undefined, color: s.id ? 'white' : undefined }} title={`${s.id ?? 'CPU ociosa'}: ${s.start} a ${s.end}`}>
                {s.id ?? '—'}
              </div>
            ))}
          </div>
          <div className="relative h-5 text-[10px] text-muted">
            {Array.from({ length: end + 1 }, (_, t) => (
              <span key={t} className="absolute -translate-x-1/2" style={{ left: `${(t / end) * 100}%` }}>
                {t}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-sm">
          <thead className="text-muted">
            <tr>
              <th className="py-1 pr-2 font-medium">Proceso</th>
              <th className="py-1 pr-2 font-medium">Llega</th>
              <th className="py-1 pr-2 font-medium">Necesita CPU</th>
              <th className="py-1 pr-2 font-medium">Prioridad</th>
              <th className="py-1 pr-2 font-medium">Termina</th>
              <th className="py-1 pr-2 font-medium">Espera</th>
              <th className="py-1 font-medium">Respuesta</th>
            </tr>
          </thead>
          <tbody>
            {procs.map((p, i) => {
              const r = result.results.find((x) => x.id === p.id)!
              return (
                <tr key={p.id} className="border-t border-line">
                  <td className="py-1 pr-2">
                    <span className="inline-block h-3 w-3 rounded-sm align-middle" style={{ background: color(p.id) }} /> {p.id}
                  </td>
                  {(['llegada', 'rafaga', 'prioridad'] as const).map((f) => (
                    <td key={f} className="py-1 pr-2">
                      <input aria-label={`${f} de ${p.id}`} type="number" value={p[f]} onChange={(e) => update(i, f, Number(e.target.value))} className="w-14 rounded border border-line bg-bg px-1" />
                    </td>
                  ))}
                  <td className="py-1 pr-2 font-mono">{r.fin}</td>
                  <td className="py-1 pr-2 font-mono">{r.espera}</td>
                  <td className="py-1 font-mono">{r.respuesta}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {procs.length < 6 && (
          <Button variant="ghost" onClick={() => setProcs((ps) => [...ps, { id: String.fromCharCode(65 + ps.length), llegada: ps.length, rafaga: 3, prioridad: 2 }])}>
            + Proceso
          </Button>
        )}
        {procs.length > 2 && (
          <Button variant="ghost" onClick={() => setProcs((ps) => ps.slice(0, -1))}>
            − Proceso
          </Button>
        )}
        <Button variant="ghost" onClick={() => setProcs(INITIAL)}>
          <Icon name="refresh" className="h-4 w-4" />
          Valores iniciales
        </Button>
      </div>
      <div className="mt-4">
        <div className="mb-1 text-sm font-medium">Comparación de los tres algoritmos con estos procesos</div>
        <table className="w-full text-left text-sm">
          <thead className="text-muted">
            <tr>
              <th className="py-1 pr-2 font-medium">Algoritmo</th>
              <th className="py-1 pr-2 font-medium">Espera promedio</th>
              <th className="py-1 pr-2 font-medium">Respuesta promedio</th>
              <th className="py-1 font-medium">Cambios de contexto</th>
            </tr>
          </thead>
          <tbody>
            {all.map(({ a, r }) => (
              <tr key={a.id} className={cn('border-t border-line', a.id === algo && 'font-semibold')}>
                <td className="py-1 pr-2">{a.nombre}</td>
                <td className="py-1 pr-2 font-mono">{r.esperaPromedio.toFixed(2)}</td>
                <td className="py-1 pr-2 font-mono">{r.respuestaPromedio.toFixed(2)}</td>
                <td className="py-1 font-mono">{r.cambiosDeContexto}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted">Espera: tiempo que el proceso pasó listo pero sin CPU. Respuesta: cuánto tardó en ejecutarse por primera vez (lo que percibe una persona frente a la pantalla). Cada cambio de contexto tiene un pequeño costo para el sistema.</p>
      </div>
    </Frame>
  )
}
