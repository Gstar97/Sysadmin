import { useMemo, useState } from 'react'
import { copiaAnterior, simular } from '@/engines/virtualizacion/retencion'
import { cn } from '@/lib/cn'
import { Frame, inputClass } from '../fundamentos/Frame'

const DIAS = 400
const FRECUENCIAS = [
  { horas: 1, nombre: 'cada hora' },
  { horas: 6, nombre: 'cada 6 horas' },
  { horas: 24, nombre: 'una por día' },
]

const CAMPOS = [
  { k: 'last', nombre: 'Últimas (keep-last)' },
  { k: 'hourly', nombre: 'Por hora' },
  { k: 'daily', nombre: 'Diarias' },
  { k: 'weekly', nombre: 'Semanales' },
  { k: 'monthly', nombre: 'Mensuales' },
  { k: 'yearly', nombre: 'Anuales' },
] as const

type Clave = (typeof CAMPOS)[number]['k']

/**
 * Planificador de retención: con una copia cada tanto y una política como la de restic forget o
 * la de Proxmox Backup Server, qué copias quedan, hasta cuándo se puede volver y cuánto ocupan.
 */
export function RetentionPlanner() {
  const [frecuencia, setFrecuencia] = useState(24)
  const [pol, setPol] = useState<Record<Clave, number>>({ last: 0, hourly: 0, daily: 7, weekly: 4, monthly: 12, yearly: 0 })
  const [tamano, setTamano] = useState(500)
  const [cambio, setCambio] = useState(2)
  const [dano, setDano] = useState(45)
  const ahora = useMemo(() => {
    const d = new Date()
    d.setHours(23, 0, 0, 0)
    return d.getTime()
  }, [])
  const sim = useMemo(() => simular({ frecuenciaHoras: frecuencia, dias: DIAS, politica: pol, tamanoGb: tamano, cambioDiarioPct: cambio, ahora }), [frecuencia, pol, tamano, cambio, ahora])
  // Un cuadradito por día: si quedó alguna copia de ese día.
  const porDia = useMemo(() => {
    const out: { dia: number; keep: boolean; razones: string[] }[] = []
    for (let d = 0; d < DIAS; d++) {
      const delDia = sim.copias.filter((c) => Math.floor((ahora - c.t) / 86_400_000) === d)
      const kept = delDia.filter((c) => c.keep)
      out.push({ dia: d, keep: kept.length > 0, razones: [...new Set(kept.flatMap((c) => c.reasons))] })
    }
    return out
  }, [sim, ahora])
  const anterior = copiaAnterior(sim, dano, ahora)
  const perdido = anterior ? Math.round((anterior.dias - dano) * 10) / 10 : undefined

  return (
    <Frame titulo="Planificador de retención">
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap items-end gap-3">
          <label>
            <span className="block text-muted">Frecuencia de las copias</span>
            <select value={frecuencia} onChange={(e) => setFrecuencia(Number(e.target.value))} className={cn(inputClass, 'mt-1')}>
              {FRECUENCIAS.map((f) => (
                <option key={f.horas} value={f.horas}>
                  {f.nombre}
                </option>
              ))}
            </select>
          </label>
          {CAMPOS.map((c) => (
            <label key={c.k}>
              <span className="block text-muted">{c.nombre}</span>
              <input type="number" min={0} max={500} value={pol[c.k]} onChange={(e) => setPol({ ...pol, [c.k]: Math.max(0, Number(e.target.value)) })} className={cn(inputClass, 'mt-1 w-20')} />
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label>
            <span className="block text-muted">Datos a respaldar (GB)</span>
            <input type="number" min={1} value={tamano} onChange={(e) => setTamano(Math.max(1, Number(e.target.value)))} className={cn(inputClass, 'mt-1 w-24')} />
          </label>
          <label>
            <span className="block text-muted">Cambian por día (%)</span>
            <input type="number" min={0} max={100} step={0.5} value={cambio} onChange={(e) => setCambio(Math.max(0, Math.min(100, Number(e.target.value))))} className={cn(inputClass, 'mt-1 w-24')} />
          </label>
        </div>

        <dl className="grid gap-3 sm:grid-cols-4">
          <div className="rounded-lg border border-line bg-surface p-3">
            <dt className="text-muted">Copias que quedan</dt>
            <dd className="font-mono text-lg">{sim.guardadas}</dd>
          </div>
          <div className="rounded-lg border border-line bg-surface p-3">
            <dt className="text-muted">Se puede volver hasta</dt>
            <dd className="font-mono text-lg">{sim.masVieja} días</dd>
          </div>
          <div className="rounded-lg border border-line bg-surface p-3">
            <dt className="text-muted">Pérdida máxima (RPO)</dt>
            <dd className="font-mono text-lg">{frecuencia === 24 ? '1 día' : `${frecuencia} h`}</dd>
          </div>
          <div className="rounded-lg border border-line bg-surface p-3">
            <dt className="text-muted">Espacio aproximado</dt>
            <dd className="font-mono text-lg">{sim.espacioGb >= 1000 ? `${(sim.espacioGb / 1000).toFixed(1)} TB` : `${sim.espacioGb} GB`}</dd>
          </div>
        </dl>

        <div>
          <div className="mb-1 flex justify-between text-xs text-muted">
            <span>hoy</span>
            <span>hace {DIAS} días</span>
          </div>
          <div className="flex flex-wrap gap-[2px]" role="img" aria-label={`Días con una copia guardada en los últimos ${DIAS} días: ${porDia.filter((d) => d.keep).map((d) => d.dia).join(', ')}`}>
            {porDia.map((d) => (
              <span
                key={d.dia}
                title={d.keep ? `hace ${d.dia} días: ${d.razones.join(', ')}` : `hace ${d.dia} días: no queda copia`}
                className={cn('h-3 w-3 rounded-sm', d.keep ? (d.razones.some((r) => r.startsWith('yearly') || r.startsWith('monthly')) ? 'bg-info' : 'bg-ok') : 'bg-line')}
              />
            ))}
          </div>
          <p className="mt-1 text-xs text-muted">Verde: diarias, semanales o últimas. Azul: mensuales o anuales. Gris: ese día no queda ninguna copia. El espacio supone que cada día cambia una parte distinta de los datos; en la práctica suele ser menos, porque cambian casi siempre los mismos archivos.</p>
        </div>

        <div className={cn('rounded-lg border p-3', anterior ? 'border-ok bg-ok-soft' : 'border-bad bg-bad-soft')}>
          <label className="flex flex-wrap items-center gap-2">
            <span>Algo se dañó (o lo cifró un ransomware) hace</span>
            <input type="number" min={0} max={DIAS} value={dano} onChange={(e) => setDano(Math.max(0, Number(e.target.value)))} className={cn(inputClass, 'w-20')} />
            <span>días y te das cuenta hoy.</span>
          </label>
          <p className="mt-2">
            {anterior
              ? `La copia sana más nueva es de hace ${anterior.dias} días. Volvés a cómo estaba todo ese día: se pierde lo que se hizo en los ${perdido} días anteriores al daño, y lo posterior, si no se puede rescatar de otro lado.`
              : 'No queda ninguna copia de antes del daño: con esta política, no hay de dónde volver.'}
          </p>
        </div>
      </div>
    </Frame>
  )
}
