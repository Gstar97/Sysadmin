import { useState } from 'react'
import { DISKS, estimate, WORKLOADS } from '@/engines/fundamentos/storage'
import { formatDuration } from '@/engines/fundamentos/units'
import { cn } from '@/lib/cn'
import { Chip, Frame } from './Frame'

export function DiskComparator() {
  const [wid, setWid] = useState(WORKLOADS[0].id)
  const w = WORKLOADS.find((x) => x.id === wid)!
  const times = DISKS.map((d) => ({ d, t: estimate(d, w) }))
  const maxLog = Math.max(...times.map((x) => Math.log10(x.t + 1)))
  const best = Math.min(...times.map((x) => x.t))
  return (
    <Frame titulo="Comparador de discos">
      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Tipo de carga">
        {WORKLOADS.map((x) => (
          <Chip key={x.id} active={x.id === wid} onClick={() => setWid(x.id)}>
            {x.nombre}
          </Chip>
        ))}
      </div>
      <p className="text-sm">{w.descripcion}</p>
      <p className="mb-3 text-sm text-muted">
        <strong className="text-fg">Lo que importa:</strong> {w.importa}
      </p>
      <ul className="space-y-3">
        {times.map(({ d, t }) => (
          <li key={d.id}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
              <span className="font-medium">{d.nombre}</span>
              <span className={cn('font-mono', t === best && 'font-semibold text-ok')}>{formatDuration(t)}</span>
            </div>
            <div className="mt-1 h-3 rounded-full bg-surface-2" aria-hidden>
              <div className={cn('h-full rounded-full', t === best ? 'bg-ok' : 'bg-accent')} style={{ width: `${Math.max(3, (Math.log10(t + 1) / maxLog) * 100)}%` }} />
            </div>
          </li>
        ))}
      </ul>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-muted">
            <tr>
              <th className="py-1 pr-3 font-medium">Disco</th>
              <th className="py-1 pr-3 font-medium">Secuencial</th>
              <th className="py-1 pr-3 font-medium">IOPS (4 KiB)</th>
              <th className="py-1 pr-3 font-medium">Latencia</th>
              <th className="py-1 font-medium">Costo por TB</th>
            </tr>
          </thead>
          <tbody>
            {DISKS.map((d) => (
              <tr key={d.id} className="border-t border-line">
                <td className="py-1 pr-3">{d.nombre}</td>
                <td className="py-1 pr-3 font-mono">{d.secuencial.toLocaleString('es')} MB/s</td>
                <td className="py-1 pr-3 font-mono">{d.iops.toLocaleString('es')}</td>
                <td className="py-1 pr-3 font-mono">{d.latenciaMs < 1 ? `${d.latenciaMs * 1000} µs` : `${d.latenciaMs} ms`}</td>
                <td className="py-1 font-mono">×{d.costoRelativo}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">
        Valores típicos de fichas técnicas (las IOPS de los SSD se miden con muchas operaciones en paralelo; con una sola a la vez rinden bastante menos). El costo es relativo al disco rígido y cambia con el mercado. Los tiempos son una estimación simple para comparar órdenes de magnitud.
      </p>
    </Frame>
  )
}
