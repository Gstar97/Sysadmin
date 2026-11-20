import { useState } from 'react'
import { evaluar, type Uso, type VmSpec } from '@/engines/virtualizacion/recursos'
import { cn } from '@/lib/cn'
import { Button } from '@/ui'
import { Chip, Frame, inputClass } from '../fundamentos/Frame'

const ESTADO = {
  ok: { texto: 'Bien: el servidor alcanza para lo que se le pide', clase: 'border-ok bg-ok-soft text-ok' },
  ajustado: { texto: 'Ajustado: funciona, pero con poco margen', clase: 'border-warn bg-warn-soft text-warn' },
  problema: { texto: 'Problema: las VM van a andar lentas o no van a arrancar', clase: 'border-bad bg-bad-soft text-bad' },
}

const ESCENARIOS: Record<string, { nombre: string; vms: VmSpec[] }> = {
  oficina: {
    nombre: 'Oficina',
    vms: [
      { nombre: 'dc01', vcpu: 2, ramGb: 4, uso: 'baja', ramUsoPct: 50, so: 'windows' },
      { nombre: 'archivos', vcpu: 2, ramGb: 8, uso: 'baja', ramUsoPct: 40, so: 'windows' },
      { nombre: 'web01', vcpu: 2, ramGb: 4, uso: 'media', ramUsoPct: 45, so: 'ubuntu' },
      { nombre: 'db01', vcpu: 4, ramGb: 16, uso: 'media', ramUsoPct: 80, so: 'ubuntu' },
    ],
  },
  sobrevendido: {
    nombre: 'Prometido de más',
    vms: Array.from({ length: 12 }, (_, i) => ({ nombre: `app${String(i + 1).padStart(2, '0')}`, vcpu: 4, ramGb: 8, uso: (i < 4 ? 'alta' : 'media') as Uso, ramUsoPct: 55, so: 'ubuntu' })),
  },
  monstruo: {
    nombre: 'Una VM enorme',
    vms: [
      { nombre: 'erp', vcpu: 14, ramGb: 32, uso: 'media', ramUsoPct: 70, so: 'windows' },
      { nombre: 'web01', vcpu: 2, ramGb: 4, uso: 'media', ramUsoPct: 45, so: 'ubuntu' },
      { nombre: 'web02', vcpu: 2, ramGb: 4, uso: 'media', ramUsoPct: 45, so: 'ubuntu' },
    ],
  },
}

function Bar({ value, max, label, extra }: { value: number; max: number; label: string; extra?: string }) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span>{label}</span>
        <span className="font-mono">{extra}</span>
      </div>
      <div className="mt-1 h-3 overflow-hidden rounded-full bg-surface-2" role="img" aria-label={`${label}: ${Math.round(pct)} %`}>
        <div className={cn('h-full rounded-full', pct > 95 ? 'bg-bad' : pct > 80 ? 'bg-warn' : 'bg-ok')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

/** Simulador de recursos virtuales: vCPU y memoria prometidas contra lo que tiene el servidor. */
export function ResourceSimulator() {
  const [nucleos, setNucleos] = useState(8)
  const [ht, setHt] = useState(true)
  const [ram, setRam] = useState(64)
  const [vms, setVms] = useState<VmSpec[]>(ESCENARIOS.oficina.vms)
  const [globo, setGlobo] = useState(false)
  const [compartir, setCompartir] = useState(false)
  const [swap, setSwap] = useState(true)
  const hilos = nucleos * (ht ? 2 : 1)
  const r = evaluar({ hilos, ramGb: ram, reservaGb: Math.max(2, Math.round(ram * 0.06)) }, vms, { globo, compartir, swapHost: swap })
  const set = (i: number, patch: Partial<VmSpec>) => setVms(vms.map((v, j) => (j === i ? { ...v, ...patch } : v)))

  return (
    <Frame titulo="Simulador de recursos virtuales">
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label>
            <span className="block text-muted">Núcleos físicos</span>
            <input type="number" min={1} max={128} value={nucleos} onChange={(e) => setNucleos(Math.max(1, Number(e.target.value)))} className={cn(inputClass, 'mt-1 w-24')} />
          </label>
          <label className="flex min-h-10 items-center gap-2">
            <input type="checkbox" checked={ht} onChange={(e) => setHt(e.target.checked)} />
            Hyper-threading (2 hilos por núcleo)
          </label>
          <label>
            <span className="block text-muted">Memoria (GB)</span>
            <input type="number" min={4} max={4096} value={ram} onChange={(e) => setRam(Math.max(4, Number(e.target.value)))} className={cn(inputClass, 'mt-1 w-24')} />
          </label>
          <div>
            <span className="block text-muted">Escenario</span>
            <div className="mt-1 flex flex-wrap gap-1">
              {Object.entries(ESCENARIOS).map(([id, e]) => (
                <Chip key={id} active={false} onClick={() => setVms(structuredClone(e.vms))}>
                  {e.nombre}
                </Chip>
              ))}
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="text-left text-muted">
                <th className="p-1 font-medium">VM</th>
                <th className="p-1 font-medium">vCPU</th>
                <th className="p-1 font-medium">Memoria (GB)</th>
                <th className="p-1 font-medium">Uso de CPU</th>
                <th className="p-1 font-medium">Memoria que usa de verdad</th>
                <th className="p-1" />
              </tr>
            </thead>
            <tbody>
              {vms.map((v, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="p-1">
                    <input value={v.nombre} aria-label="Nombre de la VM" onChange={(e) => set(i, { nombre: e.target.value })} className={cn(inputClass, 'w-28 font-sans')} />
                  </td>
                  <td className="p-1">
                    <input type="number" min={1} max={64} value={v.vcpu} aria-label={`vCPU de ${v.nombre}`} onChange={(e) => set(i, { vcpu: Math.max(1, Number(e.target.value)) })} className={cn(inputClass, 'w-20')} />
                  </td>
                  <td className="p-1">
                    <input type="number" min={1} max={512} value={v.ramGb} aria-label={`Memoria de ${v.nombre}`} onChange={(e) => set(i, { ramGb: Math.max(1, Number(e.target.value)) })} className={cn(inputClass, 'w-20')} />
                  </td>
                  <td className="p-1">
                    <select value={v.uso} aria-label={`Uso de CPU de ${v.nombre}`} onChange={(e) => set(i, { uso: e.target.value as Uso })} className={cn(inputClass, 'font-sans')}>
                      <option value="baja">baja</option>
                      <option value="media">media</option>
                      <option value="alta">alta</option>
                    </select>
                  </td>
                  <td className="p-1">
                    <input type="range" min={10} max={100} step={5} value={v.ramUsoPct} aria-label={`Memoria que usa de verdad ${v.nombre}`} onChange={(e) => set(i, { ramUsoPct: Number(e.target.value) })} />
                    <span className="ml-1 font-mono text-xs">{v.ramUsoPct} %</span>
                  </td>
                  <td className="p-1">
                    <button type="button" className="h-8 w-8 rounded border border-line" aria-label={`Sacar ${v.nombre}`} onClick={() => setVms(vms.filter((_, j) => j !== i))}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Button variant="secondary" onClick={() => setVms([...vms, { nombre: `vm${vms.length + 1}`, vcpu: 2, ramGb: 4, uso: 'baja', ramUsoPct: 40, so: 'ubuntu' }])}>
          Agregar una VM
        </Button>

        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={globo} onChange={(e) => setGlobo(e.target.checked)} />
            Globo (ballooning)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={compartir} onChange={(e) => setCompartir(e.target.checked)} />
            Compartir páginas iguales (KSM)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={swap} onChange={(e) => setSwap(e.target.checked)} />
            El host tiene swap
          </label>
        </div>

        <div className="space-y-3">
          <Bar label={`CPU: ${r.vcpuTotal} vCPU sobre ${hilos} hilos`} value={r.demandaCpuPct} max={100} extra={`${r.ratio} vCPU por hilo · demanda ${r.demandaCpuPct} %`} />
          <Bar label={`Memoria: ${r.ramAsignadaGb} GB prometidos, ${r.ramNecesariaGb} GB que hay que poner`} value={r.ramNecesariaGb} max={r.ramDisponibleGb} extra={`${r.ramDisponibleGb} GB disponibles`} />
          {(r.recuperadaGloboGb > 0 || r.recuperadaCompartirGb > 0) && (
            <p className="text-xs text-muted">
              Recuperado: {r.recuperadaGloboGb} GB con el globo y {r.recuperadaCompartirGb} GB compartiendo páginas.
            </p>
          )}
        </div>

        <div role="status" className={cn('rounded-lg border p-3 text-sm font-semibold', ESTADO[r.estado].clase)}>
          {ESTADO[r.estado].texto}
        </div>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {r.mensajes.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      </div>
    </Frame>
  )
}
