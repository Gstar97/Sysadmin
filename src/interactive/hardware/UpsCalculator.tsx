import { useState } from 'react'
import { LOAD_CATALOG, recommend, upsCalc, UPS_CATALOG, type Load } from '@/engines/hardware/ups'
import { cn } from '@/lib/cn'
import { Frame, inputClass } from '../fundamentos/Frame'

/** Calculadora de UPS: la carga en W y VA, el margen y la autonomía estimada. */
export function UpsCalculator() {
  const [loads, setLoads] = useState<Load[]>(() => LOAD_CATALOG.map((l) => ({ ...l, cantidad: l.nombre === 'Servidor 2U' ? 2 : l.nombre.startsWith('Switch') || l.nombre.startsWith('Firewall') ? 1 : 0 })))
  const [upsId, setUpsId] = useState('u1500')
  const [needMin, setNeedMin] = useState(10)
  const ups = UPS_CATALOG.find((u) => u.id === upsId)!
  const r = upsCalc(loads, ups)
  const rec = recommend(loads, needMin)
  const set = (i: number, cantidad: number) => setLoads(loads.map((l, j) => (j === i ? { ...l, cantidad: Math.max(0, cantidad) } : l)))
  const pct = Math.min(100, r.cargaPct)
  return (
    <Frame titulo="Calculadora de UPS">
      <div className="space-y-4">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[380px] text-sm">
            <thead>
              <tr className="text-left text-muted">
                <th className="p-1 font-medium">Equipo</th>
                <th className="p-1 font-medium">Consumo típico</th>
                <th className="p-1 font-medium">Cantidad</th>
                <th className="p-1 text-right font-medium">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {loads.map((l, i) => (
                <tr key={l.nombre} className="border-t border-line">
                  <td className="p-1">{l.nombre}</td>
                  <td className="p-1">
                    <input type="number" min={1} max={3000} value={l.watts} aria-label={`Consumo de ${l.nombre} en watts`} onChange={(e) => setLoads(loads.map((x, j) => (j === i ? { ...x, watts: Math.max(1, Number(e.target.value)) } : x)))} className={cn(inputClass, 'w-24')} /> W
                  </td>
                  <td className="p-1">
                    <div className="flex items-center gap-1">
                      <button type="button" className="h-8 w-8 rounded border border-line" aria-label={`Quitar ${l.nombre}`} onClick={() => set(i, l.cantidad - 1)}>
                        −
                      </button>
                      <span className="w-6 text-center font-mono">{l.cantidad}</span>
                      <button type="button" className="h-8 w-8 rounded border border-line" aria-label={`Agregar ${l.nombre}`} onClick={() => set(i, l.cantidad + 1)}>
                        +
                      </button>
                    </div>
                  </td>
                  <td className="p-1 text-right font-mono">{l.watts * l.cantidad} W</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="block text-muted">UPS</span>
            <select value={upsId} onChange={(e) => setUpsId(e.target.value)} className={cn(inputClass, 'mt-1 w-full font-sans')}>
              {UPS_CATALOG.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.nombre} ({u.bateriaWh} Wh)
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-muted">Minutos que hacen falta (apagar ordenado, o esperar al generador)</span>
            <input type="number" min={1} max={240} value={needMin} onChange={(e) => setNeedMin(Math.max(1, Number(e.target.value)))} className={cn(inputClass, 'mt-1 w-28')} />
          </label>
        </div>

        <div>
          <div className="mb-1 flex flex-wrap justify-between gap-2 text-sm">
            <span>
              Carga: <b className={cn(r.sobrecarga && 'text-bad')}>{r.watts} W</b> (unos {r.va} VA) de {ups.watts} W / {ups.va} VA
            </span>
            <span className={cn('font-semibold', r.cargaPct > 80 ? 'text-bad' : 'text-ok')}>{r.cargaPct} %</span>
          </div>
          <div className="h-3 overflow-hidden rounded-full bg-surface-2" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={r.cargaPct} aria-label="Carga de la UPS">
            <div className={cn('h-full', r.sobrecarga ? 'bg-bad' : r.cargaPct > 80 ? 'bg-warn' : 'bg-ok')} style={{ width: `${pct}%` }} />
          </div>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted">Autonomía estimada</dt>
              <dd className={cn('font-semibold', r.minutos < needMin && 'text-bad')}>{r.watts ? `${r.minutos} minutos` : '—'}</dd>
            </div>
            <div>
              <dt className="text-muted">Para esta carga y {needMin} minutos</dt>
              <dd className="font-semibold">{r.watts === 0 ? '—' : rec ? rec.nombre : 'Ninguna del catálogo: hacen falta baterías externas o repartir la carga'}</dd>
            </div>
          </dl>
          <p className="mt-2 text-sm text-muted">
            La autonomía es una estimación (energía de las baterías × 0,8 / carga): la real sale de la tabla del fabricante, y baja con los años de la batería. Conviene no pasar del 80 % de la UPS, para tener margen y que los arranques no la sobrecarguen.
          </p>
          {r.sobrecarga && <p className="mt-1 text-sm font-semibold text-bad">Sobrecarga: ante un corte, la UPS se apaga y corta a todos.</p>}
        </div>
      </div>
    </Frame>
  )
}
