import { useMemo, useState } from 'react'
import { DEVICE_CATALOG, generatePoeExercise, ORDER, poeBudget, POE_STANDARDS, type PoeExercise, type PoeStandard } from '@/engines/redes/poe'
import { cn } from '@/lib/cn'
import { createRng } from '@/lib/random'
import { Button } from '@/ui'
import { Chip, Feedback, Frame, inputClass, Score } from '../fundamentos/Frame'

function Calculator() {
  const [counts, setCounts] = useState<Record<string, number>>({ telefono: 6, camara: 4, ap6: 1 })
  const [budget, setBudget] = useState(195)
  const [ports, setPorts] = useState(24)
  const [max, setMax] = useState<PoeStandard>('at')
  const devices = DEVICE_CATALOG.map((d) => ({ ...d, cantidad: counts[d.id] ?? 0 }))
  const r = poeBudget(devices, budget, ports, max)
  const pct = Math.min(100, (r.reservado / budget) * 100)
  const over = r.reservado > budget
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-sm">
          <span className="block text-muted">Presupuesto PoE del switch (W)</span>
          <input type="number" min={10} max={2000} value={budget} onChange={(e) => setBudget(Math.max(1, Number(e.target.value)))} className={cn(inputClass, 'w-full')} />
        </label>
        <label className="text-sm">
          <span className="block text-muted">Puertos PoE</span>
          <input type="number" min={4} max={52} value={ports} onChange={(e) => setPorts(Math.max(1, Number(e.target.value)))} className={cn(inputClass, 'w-full')} />
        </label>
        <div className="text-sm">
          <span className="block text-muted">Lo máximo que entrega</span>
          <div className="mt-1 flex flex-wrap gap-1">
            {ORDER.map((s) => (
              <Chip key={s} active={max === s} onClick={() => setMax(s)}>
                {POE_STANDARDS[s].nombre}
              </Chip>
            ))}
          </div>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-sm">
          <thead>
            <tr className="text-left text-muted">
              <th className="p-1 font-medium">Equipo</th>
              <th className="p-1 font-medium">Consumo</th>
              <th className="p-1 font-medium">Necesita</th>
              <th className="p-1 font-medium">Cantidad</th>
              <th className="p-1 text-right font-medium">Reserva</th>
            </tr>
          </thead>
          <tbody>
            {r.lines.length === 0 && (
              <tr>
                <td colSpan={5} className="p-2 text-muted">
                  Agrega equipos con los botones +.
                </td>
              </tr>
            )}
            {DEVICE_CATALOG.map((d) => {
              const line = r.lines.find((l) => l.device.id === d.id)
              const st = line?.standard ?? ORDER.find((s) => POE_STANDARDS[s].pd >= d.watts)
              const bad = line && r.sinPoe.includes(line.device)
              return (
                <tr key={d.id} className="border-t border-line">
                  <td className="p-1">{d.nombre}</td>
                  <td className="p-1 font-mono">{d.watts} W</td>
                  <td className={cn('p-1', bad && 'font-semibold text-bad')}>{st ? POE_STANDARDS[st].nombre : 'ningún PoE'}</td>
                  <td className="p-1">
                    <div className="flex items-center gap-1">
                      <button type="button" className="h-8 w-8 rounded border border-line" aria-label={`Quitar ${d.nombre}`} onClick={() => setCounts({ ...counts, [d.id]: Math.max(0, (counts[d.id] ?? 0) - 1) })}>
                        −
                      </button>
                      <span className="w-6 text-center font-mono">{counts[d.id] ?? 0}</span>
                      <button type="button" className="h-8 w-8 rounded border border-line" aria-label={`Agregar ${d.nombre}`} onClick={() => setCounts({ ...counts, [d.id]: (counts[d.id] ?? 0) + 1 })}>
                        +
                      </button>
                    </div>
                  </td>
                  <td className="p-1 text-right font-mono">{line ? (bad ? '—' : `${line.reservado} W`) : ''}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div>
        <div className="mb-1 flex justify-between text-sm">
          <span>
            Reservado: <b className={cn(over && 'text-bad')}>{r.reservado} W</b> de {budget} W
          </span>
          <span className={cn(r.puertosUsados > ports && 'font-semibold text-bad')}>
            Puertos: {r.puertosUsados} de {ports}
          </span>
        </div>
        <div className="h-3 overflow-hidden rounded-full bg-surface-2" role="meter" aria-valuemin={0} aria-valuemax={budget} aria-valuenow={r.reservado} aria-label="Potencia reservada">
          <div className={cn('h-full', over ? 'bg-bad' : pct > 80 ? 'bg-warn' : 'bg-ok')} style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-2 text-sm text-muted">
          Consumo real estimado (con un 10% de pérdida en el cable): {r.real} W. Muchos switches reservan por clase (el máximo del estándar de cada puerto), así que el presupuesto se agota antes de lo que suman los consumos reales.
        </p>
        {r.sinPoe.length > 0 && <p className="mt-1 text-sm font-semibold text-bad">Este switch no puede alimentar: {r.sinPoe.map((d) => d.nombre).join(', ')}.</p>}
      </div>
    </div>
  )
}

function Practice() {
  const rng = useMemo(() => createRng(), [])
  const [ex, setEx] = useState<PoeExercise>(() => generatePoeExercise(rng))
  const [answer, setAnswer] = useState<boolean>()
  const [stats, setStats] = useState({ correct: 0, total: 0, streak: 0 })
  const choose = (v: boolean) => {
    if (answer !== undefined) return
    setAnswer(v)
    const ok = v === ex.alcanza
    setStats((s) => ({ correct: s.correct + (ok ? 1 : 0), total: s.total + 1, streak: ok ? s.streak + 1 : 0 }))
  }
  return (
    <div className="space-y-3">
      <Score {...stats} />
      <p>{ex.enunciado}</p>
      <div className="flex gap-2">
        <Button variant={answer === true ? 'primary' : 'secondary'} onClick={() => choose(true)} disabled={answer !== undefined}>
          Alcanza
        </Button>
        <Button variant={answer === false ? 'primary' : 'secondary'} onClick={() => choose(false)} disabled={answer !== undefined}>
          No alcanza
        </Button>
      </div>
      {answer !== undefined && (
        <>
          <Feedback ok={answer === ex.alcanza} titulo={answer === ex.alcanza ? '¡Correcto!' : 'No es así'} pasos={ex.explicacion} />
          <Button
            onClick={() => {
              setEx(generatePoeExercise(rng))
              setAnswer(undefined)
            }}
          >
            Otro ejercicio
          </Button>
        </>
      )}
    </div>
  )
}

/** Presupuesto PoE de un switch, con práctica de "¿alcanza?". */
export function PoeCalculator({ modo = 'ambos' }: { modo?: 'calculadora' | 'practica' | 'ambos' }) {
  const [tab, setTab] = useState<'calc' | 'practica'>(modo === 'practica' ? 'practica' : 'calc')
  return (
    <Frame
      titulo="Presupuesto PoE"
      acciones={
        modo === 'ambos' && (
          <>
            <Chip active={tab === 'calc'} onClick={() => setTab('calc')}>
              Calculadora
            </Chip>
            <Chip active={tab === 'practica'} onClick={() => setTab('practica')}>
              Práctica
            </Chip>
          </>
        )
      }
    >
      {tab === 'calc' ? <Calculator /> : <Practice />}
    </Frame>
  )
}
