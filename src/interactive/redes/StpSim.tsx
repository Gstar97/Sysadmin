import { useMemo, useState } from 'react'
import { Network } from '@/engines/network/model'
import { topologySpecSchema } from '@/engines/network/schema'
import { bridgeId, computeStp, compareBridge } from '@/engines/network/stp'
import { cn } from '@/lib/cn'
import { Button } from '@/ui'
import { Chip, Feedback, Frame } from '../fundamentos/Frame'

interface Escenario {
  nombre: string
  switches: { id: string; x: number; y: number }[]
  enlaces: { a: string; pa: string; b: string; pb: string }[]
}

const ESCENARIOS: Escenario[] = [
  {
    nombre: 'Triángulo',
    switches: [
      { id: 'SW1', x: 210, y: 40 },
      { id: 'SW2', x: 60, y: 230 },
      { id: 'SW3', x: 360, y: 230 },
    ],
    enlaces: [
      { a: 'SW1', pa: 'Gi0/1', b: 'SW2', pb: 'Gi0/1' },
      { a: 'SW1', pa: 'Gi0/2', b: 'SW3', pb: 'Gi0/1' },
      { a: 'SW2', pa: 'Gi0/2', b: 'SW3', pb: 'Gi0/2' },
    ],
  },
  {
    nombre: 'Cuadrado con un enlace lento',
    switches: [
      { id: 'SW1', x: 60, y: 40 },
      { id: 'SW2', x: 360, y: 40 },
      { id: 'SW3', x: 360, y: 230 },
      { id: 'SW4', x: 60, y: 230 },
    ],
    enlaces: [
      { a: 'SW1', pa: 'Gi0/1', b: 'SW2', pb: 'Gi0/1' },
      { a: 'SW2', pa: 'Gi0/2', b: 'SW3', pb: 'Gi0/1' },
      { a: 'SW3', pa: 'Gi0/2', b: 'SW4', pb: 'Gi0/2' },
      { a: 'SW4', pa: 'Fa0/1', b: 'SW1', pb: 'Fa0/1' },
    ],
  },
]

const PRIOS = Array.from({ length: 16 }, (_, i) => i * 4096)

function build(e: Escenario, prios: Record<string, number>, cortados: Set<number>) {
  const spec = topologySpecSchema.parse({
    dispositivos: e.switches.map((s) => ({ id: s.id, tipo: 'switch', x: s.x, y: s.y, stp_prioridad: prios[s.id] ?? 32768 })),
    enlaces: e.enlaces.filter((_, i) => !cortados.has(i)).map((l) => ({ a: `${l.a}:${l.pa}`, b: `${l.b}:${l.pb}` })),
  })
  const net = new Network(spec)
  return { net, stp: computeStp(net, 1) }
}

/** Elección del puente raíz y bloqueo de puertos, con predicción y enlaces que se pueden cortar. */
export function StpSim() {
  const [esc, setEsc] = useState(0)
  const e = ESCENARIOS[esc]
  const [prios, setPrios] = useState<Record<string, number>>({})
  const [cortados, setCortados] = useState<Set<number>>(new Set())
  const [predict, setPredict] = useState(true)
  const [guess, setGuess] = useState<string>()
  const { net, stp } = useMemo(() => build(e, prios, cortados), [e, prios, cortados])
  const revealed = !predict || guess !== undefined
  const root = stp.rootDev
  const reset = (i: number) => {
    setEsc(i)
    setPrios({})
    setCortados(new Set())
    setGuess(undefined)
  }
  const roleOf = (dev: string, port: string) => {
    const name = net.port(net.device(dev)!, port)?.name ?? port
    return stp.switches.get(dev)?.ports.get(name)
  }
  const pos = (id: string) => e.switches.find((s) => s.id === id)!
  const bridges = e.switches.map((s) => ({ id: s.id, b: bridgeId(net.device(s.id)!, 1) })).sort((a, b) => compareBridge(a.b, b.b))
  const blocked = e.enlaces
    .map((l, i) => ({ l, i }))
    .filter(({ l, i }) => !cortados.has(i) && (roleOf(l.a, l.pa)?.role === 'alternate' || roleOf(l.b, l.pb)?.role === 'alternate'))
  return (
    <Frame
      titulo="Spanning Tree: quién es la raíz y qué se bloquea"
      acciones={
        <>
          {ESCENARIOS.map((x, i) => (
            <Chip key={x.nombre} active={esc === i} onClick={() => reset(i)}>
              {x.nombre}
            </Chip>
          ))}
          <Chip active={predict} onClick={() => setPredict(!predict)}>
            Predecir la raíz
          </Chip>
        </>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,17rem)]">
        <div>
          <svg viewBox="0 0 440 290" className="h-auto w-full max-w-[480px]" role="img" aria-label="Topología de switches con los roles de Spanning Tree">
            {e.enlaces.map((l, i) => {
              const a = pos(l.a)
              const b = pos(l.b)
              const off = cortados.has(i)
              const blk = revealed && blocked.some((x) => x.i === i)
              const slow = /^Fa/.test(l.pa)
              const ra = revealed ? roleOf(l.a, l.pa) : undefined
              const rb = revealed ? roleOf(l.b, l.pb) : undefined
              const tag = (r?: { role: string }) => (r ? (r.role === 'root' ? 'R' : r.role === 'designated' ? 'D' : 'B') : '')
              const mx = (a.x + b.x) / 2
              const my = (a.y + b.y) / 2
              return (
                <g key={i}>
                  <line
                    x1={a.x}
                    y1={a.y}
                    x2={b.x}
                    y2={b.y}
                    stroke={off ? 'var(--line)' : blk ? 'var(--bad)' : 'var(--accent)'}
                    strokeWidth={off ? 2 : 4}
                    strokeDasharray={off ? '4 6' : blk ? '10 6' : undefined}
                  />
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={22} className="cursor-pointer" onClick={() => setCortados((c) => (c.has(i) ? new Set([...c].filter((x) => x !== i)) : new Set([...c, i])))}>
                    <title>{off ? 'Reconectar este enlace' : 'Cortar este enlace'}</title>
                  </line>
                  <text x={mx} y={my - 8} textAnchor="middle" fontSize={11} fill="var(--muted)" fontFamily="system-ui">
                    {slow ? '100 Mb/s (costo 19)' : '1 Gb/s (costo 4)'}
                  </text>
                  {!off &&
                    [
                      { p: a, o: b, r: ra, n: l.pa },
                      { p: b, o: a, r: rb, n: l.pb },
                    ].map((z, k) => {
                      const tx = z.p.x + (z.o.x - z.p.x) * 0.22
                      const ty = z.p.y + (z.o.y - z.p.y) * 0.22
                      return (
                        <g key={k}>
                          <circle cx={tx} cy={ty} r={11} fill={z.r?.role === 'alternate' ? 'var(--bad)' : z.r ? 'var(--surface)' : 'var(--surface-2)'} stroke="var(--fg)" />
                          <text x={tx} y={ty + 4} textAnchor="middle" fontSize={11} fontWeight={700} fill={z.r?.role === 'alternate' ? 'var(--accent-fg)' : 'var(--fg)'} fontFamily="system-ui">
                            {tag(z.r)}
                          </text>
                        </g>
                      )
                    })}
                </g>
              )
            })}
            {e.switches.map((s) => {
              const isRoot = revealed && root === s.id
              const b = bridgeId(net.device(s.id)!, 1)
              return (
                <g key={s.id}>
                  <rect x={s.x - 56} y={s.y - 22} width={112} height={44} rx={8} fill={isRoot ? 'var(--warn-soft)' : 'var(--surface)'} stroke={isRoot ? 'var(--warn)' : 'var(--line)'} strokeWidth={isRoot ? 3 : 1.5} />
                  <text x={s.x} y={s.y - 4} textAnchor="middle" fontSize={13} fontWeight={700} fill="var(--fg)" fontFamily="system-ui">
                    {s.id}
                    {isRoot ? ' ★ raíz' : ''}
                  </text>
                  <text x={s.x} y={s.y + 13} textAnchor="middle" fontSize={8.5} fill="var(--muted)" fontFamily="monospace">
                    {b.priority} · {b.mac}
                  </text>
                </g>
              )
            })}
          </svg>
          <p className="text-xs text-muted">R = puerto raíz · D = designado · B = bloqueado (alternativo). Toca un enlace para cortarlo o reconectarlo.</p>
          {predict && guess === undefined && (
            <div className="mt-2">
              <p className="text-sm font-medium">¿Qué switch va a ser el puente raíz?</p>
              <div className="mt-1 flex flex-wrap gap-2">
                {e.switches.map((s) => (
                  <Button key={s.id} variant="secondary" onClick={() => setGuess(s.id)}>
                    {s.id}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {predict && guess !== undefined && (
            <Feedback
              ok={guess === root}
              titulo={guess === root ? `¡Correcto! ${root} es la raíz.` : `La raíz es ${root}.`}
              pasos={[
                'Gana el identificador de puente más bajo: primero la prioridad (la de fábrica es 32768 + número de VLAN) y, si empatan, la MAC más baja.',
                `Orden: ${bridges.map((x) => `${x.id} (${x.b.priority}, ${x.b.mac})`).join(' < ')}.`,
              ]}
            />
          )}
        </div>
        <div className="space-y-3 text-sm">
          <div>
            <h4 className="mb-1 font-semibold">Prioridad de cada switch</h4>
            {e.switches.map((s) => (
              <label key={s.id} className="mb-1 flex items-center justify-between gap-2">
                <span>{s.id}</span>
                <select
                  className="min-h-9 rounded-lg border border-line bg-bg px-2"
                  value={prios[s.id] ?? 32768}
                  onChange={(ev) => {
                    setPrios({ ...prios, [s.id]: Number(ev.target.value) })
                    if (predict) setGuess(undefined)
                  }}
                >
                  {PRIOS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <p className="text-xs text-muted">Se configura de a 4096 (spanning-tree vlan 1 priority 4096). Más baja = más chances de ser raíz.</p>
          </div>
          {revealed && (
            <div aria-live="polite">
              <h4 className="mb-1 font-semibold">Qué pasó</h4>
              <ul className="list-disc space-y-1 pl-5">
                <li>Raíz: {root}. Todos sus puertos son designados.</li>
                {[...stp.switches.values()]
                  .filter((x) => x.dev.id !== root && x.rootPort)
                  .map((x) => (
                    <li key={x.dev.id}>
                      {x.dev.id}: puerto raíz {x.rootPort?.replace('GigabitEthernet', 'Gi').replace('FastEthernet', 'Fa')}, costo hasta la raíz {x.rootCost}.
                    </li>
                  ))}
                <li className={cn(blocked.length ? 'text-bad' : 'text-ok')}>{blocked.length ? `Bloqueado: ${blocked.map((x) => `${x.l.a}–${x.l.b}`).join(', ')}. Sin ese bloqueo habría un bucle.` : 'Ningún enlace bloqueado: no hay bucles.'}</li>
              </ul>
            </div>
          )}
        </div>
      </div>
    </Frame>
  )
}
