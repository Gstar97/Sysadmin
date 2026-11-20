import { useState } from 'react'
import { costos, CRITERIOS, PLATAFORMAS, puntaje, type Infra, type Plataforma, type Precios } from '@/engines/virtualizacion/plataformas'
import { cn } from '@/lib/cn'
import { Frame, inputClass } from '../fundamentos/Frame'

const fmt = (n: number) => Math.round(n).toLocaleString('es-AR')

/** Comparador de plataformas: matriz de decisión con pesos y el costo de licencias en un período. */
export function PlatformComparator() {
  const [pesos, setPesos] = useState<Record<string, number>>(() => Object.fromEntries(CRITERIOS.map((c) => [c.id, c.id === 'costo' || c.id === 'equipo' ? 3 : 2])))
  const [puntajes, setPuntajes] = useState(() => Object.fromEntries(CRITERIOS.map((c) => [c.id, { ...c.puntajes }])) as Record<string, Record<Plataforma, number>>)
  const [infra, setInfra] = useState<Infra>({ hosts: 3, zocalos: 1, nucleosPorZocalo: 16, anios: 3, vmsWindows: true })
  const [precios, setPrecios] = useState<Precios>({ vsphereNucleoAnio: 200, windows16: 6771, proxmoxZocaloAnio: 355 })
  const score = puntaje(pesos, puntajes)
  const best = Math.max(...Object.values(score))
  const c = costos(infra, precios)
  const minCost = Math.min(...c.map((x) => x.total))

  const num = (v: string, min = 0) => Math.max(min, Number(v) || 0)
  return (
    <Frame titulo="Comparador de plataformas de virtualización">
      <div className="space-y-6">
        <section>
          <h4 className="mb-1 font-semibold">1. Qué importa en tu empresa</h4>
          <p className="mb-2 text-sm text-muted">Poné un peso a cada criterio (0 no importa, 3 importa mucho). Los puntajes de cada plataforma (1 a 5) son orientativos: cambialos si tu realidad es otra.</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead>
                <tr className="text-left text-muted">
                  <th className="p-1 font-medium">Criterio</th>
                  <th className="p-1 font-medium">Peso</th>
                  {PLATAFORMAS.map((p) => (
                    <th key={p.id} className="p-1 font-medium">
                      {p.nombre}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {CRITERIOS.map((cr) => (
                  <tr key={cr.id} className="border-t border-line">
                    <td className="p-1">
                      <span className="font-medium">{cr.nombre}</span>
                      <span className="block text-xs text-muted">{cr.detalle}</span>
                    </td>
                    <td className="p-1">
                      <select value={pesos[cr.id]} aria-label={`Peso de ${cr.nombre}`} onChange={(e) => setPesos({ ...pesos, [cr.id]: Number(e.target.value) })} className={inputClass}>
                        {[0, 1, 2, 3].map((n) => (
                          <option key={n}>{n}</option>
                        ))}
                      </select>
                    </td>
                    {PLATAFORMAS.map((p) => (
                      <td key={p.id} className="p-1">
                        <input type="number" min={1} max={5} value={puntajes[cr.id][p.id]} aria-label={`${cr.nombre} en ${p.nombre}`} onChange={(e) => setPuntajes({ ...puntajes, [cr.id]: { ...puntajes[cr.id], [p.id]: Math.min(5, num(e.target.value, 1)) } })} className={cn(inputClass, 'w-16')} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-3" aria-live="polite">
            {PLATAFORMAS.map((p) => (
              <div key={p.id} className={cn('rounded-lg border p-3', score[p.id] === best && best > 0 ? 'border-ok bg-ok-soft' : 'border-line')}>
                <div className="text-sm">{p.nombre}</div>
                <div className="text-2xl font-semibold">{score[p.id]}</div>
                <div className="text-xs text-muted">de 100</div>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h4 className="mb-1 font-semibold">2. Cuánto cuestan las licencias</h4>
          <p className="mb-2 text-sm text-muted">Los precios cambian y dependen del proveedor: los que vienen cargados son solo de ejemplo. Pedí cotización y completá los tuyos (en la moneda que quieras).</p>
          <div className="grid gap-3 text-sm sm:grid-cols-3">
            <label>
              <span className="block text-muted">Servidores</span>
              <input type="number" min={1} value={infra.hosts} onChange={(e) => setInfra({ ...infra, hosts: num(e.target.value, 1) })} className={cn(inputClass, 'mt-1 w-full')} />
            </label>
            <label>
              <span className="block text-muted">Procesadores por servidor</span>
              <input type="number" min={1} max={8} value={infra.zocalos} onChange={(e) => setInfra({ ...infra, zocalos: num(e.target.value, 1) })} className={cn(inputClass, 'mt-1 w-full')} />
            </label>
            <label>
              <span className="block text-muted">Núcleos por procesador</span>
              <input type="number" min={1} max={256} value={infra.nucleosPorZocalo} onChange={(e) => setInfra({ ...infra, nucleosPorZocalo: num(e.target.value, 1) })} className={cn(inputClass, 'mt-1 w-full')} />
            </label>
            <label>
              <span className="block text-muted">Años a comparar</span>
              <input type="number" min={1} max={10} value={infra.anios} onChange={(e) => setInfra({ ...infra, anios: num(e.target.value, 1) })} className={cn(inputClass, 'mt-1 w-full')} />
            </label>
            <label className="flex items-center gap-2 sm:col-span-2">
              <input type="checkbox" checked={infra.vmsWindows} onChange={(e) => setInfra({ ...infra, vmsWindows: e.target.checked })} />
              Hay máquinas virtuales con Windows Server
            </label>
            <label>
              <span className="block text-muted">vSphere: por núcleo y por año</span>
              <input type="number" min={0} value={precios.vsphereNucleoAnio} onChange={(e) => setPrecios({ ...precios, vsphereNucleoAnio: num(e.target.value) })} className={cn(inputClass, 'mt-1 w-full')} />
            </label>
            <label>
              <span className="block text-muted">Windows Server Datacenter: 16 núcleos</span>
              <input type="number" min={0} value={precios.windows16} onChange={(e) => setPrecios({ ...precios, windows16: num(e.target.value) })} className={cn(inputClass, 'mt-1 w-full')} />
            </label>
            <label>
              <span className="block text-muted">Proxmox: suscripción por procesador y por año</span>
              <input type="number" min={0} value={precios.proxmoxZocaloAnio} onChange={(e) => setPrecios({ ...precios, proxmoxZocaloAnio: num(e.target.value) })} className={cn(inputClass, 'mt-1 w-full')} />
            </label>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-3" aria-live="polite">
            {c.map((x) => (
              <div key={x.plataforma} className={cn('rounded-lg border p-3 text-sm', x.total === minCost ? 'border-ok bg-ok-soft' : 'border-line')}>
                <div>{PLATAFORMAS.find((p) => p.id === x.plataforma)!.nombre}</div>
                <div className="text-2xl font-semibold">{fmt(x.total)}</div>
                <div className="text-xs text-muted">en {infra.anios} años</div>
                <ul className="mt-2 list-disc space-y-1 pl-4 text-xs">
                  {x.detalle.map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">Falta lo que no es licencia: el hardware, el respaldo, la capacitación y las horas de migrar. Una migración también es un costo, y se hace una vez.</p>
        </section>
      </div>
    </Frame>
  )
}
