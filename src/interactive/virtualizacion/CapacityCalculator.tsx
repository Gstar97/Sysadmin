import { useState } from 'react'
import { calcular, ESQUEMAS, type Esquema } from '@/engines/virtualizacion/capacidad'
import { cn } from '@/lib/cn'
import { Chip, Frame, inputClass } from '../fundamentos/Frame'

/** Calculadora de capacidad útil: ZFS (espejos, RAIDZ) y Ceph (réplicas, erasure coding). */
export function CapacityCalculator({ modo = 'ambos' }: { modo?: 'zfs' | 'ceph' | 'ambos' }) {
  const lista = ESQUEMAS.filter((e) => modo === 'ambos' || (modo === 'zfs' ? !e.id.startsWith('ceph') && e.id !== 'ec42' : e.id.startsWith('ceph') || e.id === 'ec42'))
  const [elegidos, setElegidos] = useState<Esquema[]>(lista.slice(0, 3).map((e) => e.id))
  const [discos, setDiscos] = useState(modo === 'ceph' ? 2 : 6)
  const [tamano, setTamano] = useState(4)
  const [nodos, setNodos] = useState(modo === 'zfs' ? 1 : 3)
  const toggle = (id: Esquema) => setElegidos(elegidos.includes(id) ? elegidos.filter((x) => x !== id) : [...elegidos, id])
  const conCeph = lista.some((e) => e.id.startsWith('ceph') || e.id === 'ec42')
  return (
    <Frame titulo="Calculadora de capacidad">
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label>
            <span className="block text-muted">{conCeph ? 'Discos por servidor' : 'Discos'}</span>
            <input type="number" min={1} max={60} value={discos} onChange={(e) => setDiscos(Math.max(1, Number(e.target.value)))} className={cn(inputClass, 'mt-1 w-24')} />
          </label>
          <label>
            <span className="block text-muted">Tamaño de cada disco (TB)</span>
            <input type="number" min={0.5} step={0.5} max={30} value={tamano} onChange={(e) => setTamano(Math.max(0.5, Number(e.target.value)))} className={cn(inputClass, 'mt-1 w-24')} />
          </label>
          {conCeph && (
            <label>
              <span className="block text-muted">Servidores (Ceph)</span>
              <input type="number" min={1} max={20} value={nodos} onChange={(e) => setNodos(Math.max(1, Number(e.target.value)))} className={cn(inputClass, 'mt-1 w-24')} />
            </label>
          )}
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Esquemas a comparar">
          {lista.map((e) => (
            <Chip key={e.id} active={elegidos.includes(e.id)} onClick={() => toggle(e.id)}>
              {e.nombre}
            </Chip>
          ))}
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          {elegidos.map((id) => {
            const r = calcular(id, { discos, tamanoTb: tamano, nodos })
            return (
              <div key={id} className={cn('rounded-lg border p-3 text-sm', r.invalido ? 'border-bad bg-bad-soft' : 'border-line bg-surface')}>
                <div className="font-semibold">{r.nombre}</div>
                {r.invalido ? (
                  <p className="mt-1">{r.invalido}</p>
                ) : (
                  <>
                    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1">
                      <dt className="text-muted">Crudo</dt>
                      <dd className="font-mono">{r.crudoTb} TB</dd>
                      <dt className="text-muted">Útil</dt>
                      <dd className="font-mono">{r.utilTb} TB</dd>
                      <dt className="text-muted">Para llenar, como máximo</dt>
                      <dd className="font-mono">{r.recomendadoTb} TB</dd>
                      <dt className="text-muted">Aguanta que fallen</dt>
                      <dd>{r.aguanta}</dd>
                    </dl>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
                      {r.notas.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </Frame>
  )
}
