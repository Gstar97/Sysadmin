import { useMemo, useState } from 'react'
import { checkVlsm, randomVlsm, vlsmSolution, type VlsmCheck, type VlsmNeed } from '@/engines/redes/addressing'
import { formatIpv4, parseCidr } from '@/engines/network/ip'
import { cn } from '@/lib/cn'
import { createRng } from '@/lib/random'
import { Button } from '@/ui'
import { Frame, inputClass } from '../fundamentos/Frame'

interface Props {
  /** Red disponible; si no se indica, se genera un caso al azar. */
  red?: string
  areas?: VlsmNeed[]
}

/** Barra con el espacio de la red y lo que ocupa cada subred. */
function SpaceBar({ base, answers, needs, checks }: { base: string; answers: string[]; needs: VlsmNeed[]; checks?: VlsmCheck[] }) {
  const b = parseCidr(base)!
  const total = 2 ** (32 - b.prefix)
  const start = b.ip
  return (
    <div>
      <div className="relative h-8 overflow-hidden rounded-md border border-line bg-surface-2" aria-hidden>
        {answers.map((a, i) => {
          const p = parseCidr(a.trim())
          if (!p) return null
          const size = 2 ** (32 - p.prefix)
          const left = ((p.ip - start) / total) * 100
          if (left < 0 || left >= 100) return null
          const bad = checks && !checks[i].ok
          return (
            <div key={i} className={cn('absolute top-0 flex h-full items-center justify-center overflow-hidden border-r border-bg text-[10px] font-semibold text-accent-fg', bad ? 'bg-bad' : 'bg-accent')} style={{ left: `${left}%`, width: `${Math.min(100 - left, (size / total) * 100)}%` }} title={`${needs[i].nombre}: ${a}`}>
              {needs[i].nombre}
            </div>
          )
        })}
      </div>
      <div className="mt-0.5 flex justify-between font-mono text-[11px] text-muted">
        <span>{formatIpv4(start)}</span>
        <span>{formatIpv4(start + total - 1)}</span>
      </div>
    </div>
  )
}

/** Diseñador VLSM: el estudiante asigna una subred a cada área y el diseñador revisa tamaño, alineación y solapamientos. */
export function VlsmDesigner({ red, areas }: Props) {
  const rng = useMemo(() => createRng(), [])
  const [caso, setCaso] = useState(() => (red && areas ? { base: red, needs: areas } : randomVlsm(rng)))
  const [answers, setAnswers] = useState<string[]>(() => caso.needs.map(() => ''))
  const [checks, setChecks] = useState<VlsmCheck[]>()
  const [showSol, setShowSol] = useState(false)
  const sol = vlsmSolution(caso.base, caso.needs)
  const sorted = [...caso.needs].sort((a, b) => b.hosts - a.hosts)
  const allOk = checks?.every((c) => c.ok)
  const reset = (c: { base: string; needs: VlsmNeed[] }) => {
    setCaso(c)
    setAnswers(c.needs.map(() => ''))
    setChecks(undefined)
    setShowSol(false)
  }
  return (
    <Frame
      titulo="Diseñador VLSM"
      acciones={
        !red && (
          <Button variant="secondary" onClick={() => reset(randomVlsm(rng))}>
            Otro caso
          </Button>
        )
      }
    >
      <div className="space-y-4">
        <p>
          Red disponible: <b className="font-mono">{caso.base}</b>. Asigna a cada área la subred más chica que le alcance, sin superponerse. Consejo: empieza por la más grande ({sorted.map((n) => n.nombre).join(' → ')}).
        </p>
        <div className="space-y-2">
          {caso.needs.map((n, i) => (
            <div key={n.nombre} className="grid items-start gap-1 sm:grid-cols-[10rem_minmax(0,1fr)]">
              <label htmlFor={`vlsm-${i}`} className="pt-2 text-sm">
                <b>{n.nombre}</b> <span className="text-muted">({n.hosts} hosts)</span>
              </label>
              <div>
                <input
                  id={`vlsm-${i}`}
                  className={cn(inputClass, 'w-full max-w-xs', checks && (checks[i].ok ? 'border-ok' : 'border-bad'))}
                  placeholder="red/prefijo"
                  value={answers[i]}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => {
                    const next = [...answers]
                    next[i] = e.target.value
                    setAnswers(next)
                    setChecks(undefined)
                  }}
                />
                {checks && checks[i].problemas.length > 0 && (
                  <ul className={cn('mt-1 list-disc pl-5 text-xs', checks[i].ok ? 'text-muted' : 'text-bad')}>
                    {checks[i].problemas.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                )}
                {checks?.[i].ok && checks[i].capacidad !== undefined && <p className="mt-1 text-xs text-ok">Bien: entran {checks[i].capacidad} hosts.</p>}
              </div>
            </div>
          ))}
        </div>
        <SpaceBar base={caso.base} answers={answers} needs={caso.needs} checks={checks} />
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setChecks(checkVlsm(caso.base, caso.needs, answers))}>Revisar</Button>
          <Button variant="secondary" onClick={() => setShowSol(!showSol)}>
            {showSol ? 'Ocultar solución' : 'Ver una solución'}
          </Button>
        </div>
        {allOk && (
          <p role="status" className="rounded-lg border border-ok bg-ok-soft p-3 text-sm font-semibold text-ok">
            ¡Plan válido! Ninguna subred se superpone y todas alcanzan.
          </p>
        )}
        {showSol && sol && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[360px] text-sm">
              <thead>
                <tr className="text-left text-muted">
                  <th className="p-1 font-medium">Área</th>
                  <th className="p-1 font-medium">Necesita</th>
                  <th className="p-1 font-medium">Subred</th>
                  <th className="p-1 font-medium">Utilizables</th>
                </tr>
              </thead>
              <tbody>
                {sol.map((s) => (
                  <tr key={s.nombre} className="border-t border-line">
                    <td className="p-1">{s.nombre}</td>
                    <td className="p-1">{s.hosts}</td>
                    <td className="p-1 font-mono">{s.red}</td>
                    <td className="p-1">{s.capacidad}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-xs text-muted">Hay otras soluciones válidas: lo importante es que cada bloque empiece en un múltiplo de su tamaño y no se pise con otro.</p>
          </div>
        )}
      </div>
    </Frame>
  )
}
