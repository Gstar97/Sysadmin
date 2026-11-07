import { useState } from 'react'
import { age, BROADCAST, sameAction, sendFrame, type FrameResult, type MacEntry, type SwitchAction, type SwitchHost } from '@/engines/redes/macswitch'
import { cn } from '@/lib/cn'
import { Button } from '@/ui'
import { Chip, Feedback, Frame, Score } from '../fundamentos/Frame'

const HOSTS: SwitchHost[] = [
  { id: 'a', nombre: 'PC-A', mac: 'aa:aa:aa:00:00:0a', puerto: 1 },
  { id: 'b', nombre: 'PC-B', mac: 'aa:aa:aa:00:00:0b', puerto: 2 },
  { id: 'c', nombre: 'Impresora', mac: 'aa:aa:aa:00:00:0c', puerto: 3 },
  { id: 'd', nombre: 'Servidor', mac: 'aa:aa:aa:00:00:0d', puerto: 4 },
]
const PORTS = 4

function actionText(a: SwitchAction): string {
  if (a.tipo === 'reenviar') return `Reenviar solo por el puerto ${a.puerto}`
  if (a.tipo === 'inundar') return `Inundar por los puertos ${a.puertos.join(', ')}`
  return 'Descartar (filtrar)'
}

/** Simulación del aprendizaje de la tabla MAC de un switch, con predicción antes de ver la respuesta. */
export function MacTableSim() {
  const [tabla, setTabla] = useState<MacEntry[]>([])
  const [from, setFrom] = useState('a')
  const [to, setTo] = useState('b')
  const [predict, setPredict] = useState(true)
  const [guess, setGuess] = useState<SwitchAction>()
  const [last, setLast] = useState<FrameResult & { desde: SwitchHost; destino: string }>()
  const [stats, setStats] = useState({ correct: 0, total: 0, streak: 0 })
  const desde = HOSTS.find((h) => h.id === from)!
  const destMac = to === 'bcast' ? BROADCAST : HOSTS.find((h) => h.id === to)!.mac
  const preview = sendFrame(tabla, PORTS, desde, destMac)
  const options: SwitchAction[] = [{ tipo: 'inundar', puertos: Array.from({ length: PORTS }, (_, i) => i + 1).filter((p) => p !== desde.puerto) }, ...HOSTS.filter((h) => h.puerto !== desde.puerto).map((h) => ({ tipo: 'reenviar', puerto: h.puerto }) as SwitchAction), { tipo: 'descartar' }]
  const send = (g?: SwitchAction) => {
    if (g) {
      const ok = sameAction(g, preview.accion)
      setStats((s) => ({ correct: s.correct + (ok ? 1 : 0), total: s.total + 1, streak: ok ? s.streak + 1 : 0 }))
    }
    setGuess(g)
    setLast({ ...preview, desde, destino: destMac })
    setTabla(preview.tabla)
  }
  const lit = (p: number) => {
    if (!last) return undefined
    if (p === last.desde.puerto) return 'in'
    const a = last.accion
    if (a.tipo === 'reenviar' && a.puerto === p) return 'out'
    if (a.tipo === 'inundar' && a.puertos.includes(p)) return 'out'
    return undefined
  }
  return (
    <Frame
      titulo="Así aprende un switch"
      acciones={
        <>
          <Chip active={predict} onClick={() => setPredict(!predict)}>
            Predecir antes
          </Chip>
          <Button
            variant="secondary"
            onClick={() => {
              setTabla(age(tabla, 300))
              setLast(undefined)
            }}
          >
            Pasan 5 minutos
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setTabla([])
              setLast(undefined)
            }}
          >
            Reiniciar
          </Button>
        </>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]">
        <div>
          <svg viewBox="0 0 400 210" className="h-auto w-full max-w-[460px]" role="img" aria-label="Switch con cuatro equipos conectados">
            <rect x={110} y={20} width={180} height={54} rx={8} fill="var(--surface-2)" stroke="var(--line)" />
            <text x={200} y={44} textAnchor="middle" fontSize={14} fill="var(--fg)" fontFamily="system-ui">
              Switch
            </text>
            {HOSTS.map((h, i) => {
              const px = 135 + i * 43
              const hx = 50 + i * 100
              const s = lit(h.puerto)
              return (
                <g key={h.id}>
                  <line x1={px} y1={74} x2={hx} y2={150} stroke={s ? (s === 'in' ? 'var(--accent)' : 'var(--ok)') : 'var(--line)'} strokeWidth={s ? 4 : 2} />
                  <rect x={px - 9} y={60} width={18} height={12} rx={2} fill={s ? (s === 'in' ? 'var(--accent)' : 'var(--ok)') : 'var(--surface)'} stroke="var(--line)" />
                  <text x={px} y={56} textAnchor="middle" fontSize={11} fill="var(--muted)" fontFamily="system-ui">
                    {h.puerto}
                  </text>
                  <rect x={hx - 42} y={150} width={84} height={44} rx={6} fill="var(--surface)" stroke={h.id === from ? 'var(--accent)' : 'var(--line)'} />
                  <text x={hx} y={168} textAnchor="middle" fontSize={12} fill="var(--fg)" fontFamily="system-ui">
                    {h.nombre}
                  </text>
                  <text x={hx} y={184} textAnchor="middle" fontSize={9} fill="var(--muted)" fontFamily="monospace">
                    …{h.mac.slice(-5)}
                  </text>
                </g>
              )
            })}
          </svg>
          <div className="mt-3 flex flex-wrap items-end gap-3 text-sm">
            <label>
              <span className="block text-muted">Enviá</span>
              <select className="min-h-10 rounded-lg border border-line bg-bg px-2" value={from} onChange={(e) => setFrom(e.target.value)}>
                {HOSTS.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.nombre}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="block text-muted">a</span>
              <select className="min-h-10 rounded-lg border border-line bg-bg px-2" value={to} onChange={(e) => setTo(e.target.value)}>
                {HOSTS.filter((h) => h.id !== from).map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.nombre} ({h.mac})
                  </option>
                ))}
                <option value="bcast">Todos (broadcast ff:ff:ff:ff:ff:ff)</option>
              </select>
            </label>
            {!predict && <Button onClick={() => send()}>Enviar trama</Button>}
          </div>
          {predict && (
            <div className="mt-3">
              <p className="text-sm font-medium">¿Qué hará el switch con esta trama?</p>
              <div className="mt-1 flex flex-wrap gap-2">
                {options.map((o, i) => (
                  <Button key={i} variant="secondary" onClick={() => send(o)}>
                    {actionText(o)}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {last && (
            <div aria-live="polite">
              {guess ? <Feedback ok={sameAction(guess, last.accion)} titulo={sameAction(guess, last.accion) ? `¡Correcto! ${actionText(last.accion)}.` : `No: el switch decide ${actionText(last.accion).toLowerCase()}.`} pasos={[last.explicacion]} /> : <p className="mt-3 rounded-lg bg-surface-2 p-3 text-sm">{last.explicacion}</p>}
            </div>
          )}
          {predict && stats.total > 0 && (
            <div className="mt-2">
              <Score {...stats} />
            </div>
          )}
        </div>
        <div>
          <h4 className="mb-1 text-sm font-semibold">Tabla de direcciones MAC</h4>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted">
                <th className="p-1 font-medium">MAC</th>
                <th className="p-1 font-medium">Puerto</th>
                <th className="p-1 font-medium">Edad</th>
              </tr>
            </thead>
            <tbody>
              {tabla.length === 0 && (
                <tr>
                  <td colSpan={3} className="p-1 text-muted">
                    Vacía: el switch recién encendido no conoce a nadie.
                  </td>
                </tr>
              )}
              {tabla.map((e) => (
                <tr key={e.mac} className={cn('border-t border-line', last?.aprendida.mac === e.mac && 'bg-accent-soft')}>
                  <td className="p-1 font-mono">{e.mac}</td>
                  <td className="p-1">{e.puerto}</td>
                  <td className="p-1">{e.edad} s</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted">Las entradas que no se usan durante 300 segundos se borran (es el tiempo por defecto en la mayoría de los switches).</p>
        </div>
      </div>
    </Frame>
  )
}
