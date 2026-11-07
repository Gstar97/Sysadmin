import { useMemo, useState } from 'react'
import { GRAFO_EJEMPLO, INFINITO, dvDetectar, dvInicial, dvPaso, igualTabla, lsPaso, lsTablas, tablasCorrectas, type Grafo, type Tabla } from '@/engines/redes/convergencia'
import { cn } from '@/lib/cn'
import { Button } from '@/ui'
import { Chip, Frame } from '../fundamentos/Frame'

type Modo = 'dv' | 'ls'

const POS: Record<string, { x: number; y: number }> = {
  A: { x: 60, y: 60 },
  B: { x: 230, y: 60 },
  C: { x: 400, y: 60 },
  D: { x: 400, y: 230 },
  E: { x: 150, y: 230 },
}

function converged(g: Grafo): Record<string, Tabla> {
  let t = dvInicial(g)
  for (let i = 0; i < 20; i++) t = dvPaso(g, t)
  return t
}

/** Cómo se enteran los routers de un cambio: vector distancia contra estado de enlace. */
export function ConvergenceSim() {
  const [modo, setModo] = useState<Modo>('dv')
  const [g, setG] = useState<Grafo>(() => structuredClone(GRAFO_EJEMPLO))
  const [prev, setPrev] = useState<Grafo>(() => structuredClone(GRAFO_EJEMPLO))
  const [dv, setDv] = useState(() => converged(GRAFO_EJEMPLO))
  const [enterados, setEnterados] = useState<Set<string>>(() => new Set(GRAFO_EJEMPLO.nodos))
  const [paso, setPaso] = useState(0)
  const [sel, setSel] = useState('A')

  const tablas = modo === 'dv' ? dv : lsTablas(prev, g, enterados)
  const correctas = useMemo(() => tablasCorrectas(g), [g])
  const ok = (n: string) => igualTabla(tablas[n], correctas[n])
  const todos = g.nodos.every(ok)

  const reset = (m: Modo = modo) => {
    setModo(m)
    const base = structuredClone(GRAFO_EJEMPLO)
    setG(base)
    setPrev(structuredClone(base))
    setDv(converged(base))
    setEnterados(new Set(base.nodos))
    setPaso(0)
  }
  const fromScratch = () => {
    setDv(dvInicial(g))
    setPrev({ nodos: g.nodos, enlaces: g.enlaces.map((e) => ({ ...e, up: false })) })
    setEnterados(new Set())
    setPaso(0)
  }
  const toggle = (i: number) => {
    const before = structuredClone(g)
    const next = structuredClone(g)
    next.enlaces[i].up = !next.enlaces[i].up
    const ends = [next.enlaces[i].a, next.enlaces[i].b]
    setG(next)
    // Estado de enlace: el resto sigue con el mapa que conocía hasta ahora.
    setPrev(enterados.size === g.nodos.length ? before : prev)
    setEnterados(new Set(ends))
    setDv(dvDetectar(next, dv))
    setPaso(0)
  }
  const step = () => {
    if (modo === 'dv') setDv(dvPaso(g, dv))
    else setEnterados(lsPaso(g, enterados))
    setPaso((p) => p + 1)
  }

  const t = tablas[sel]
  return (
    <Frame
      titulo="Convergencia: cómo se enteran los routers de un cambio"
      acciones={
        <>
          <Chip active={modo === 'dv'} onClick={() => reset('dv')}>
            Vector distancia (RIP)
          </Chip>
          <Chip active={modo === 'ls'} onClick={() => reset('ls')}>
            Estado de enlace (OSPF)
          </Chip>
        </>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]">
        <div>
          <svg viewBox="0 0 460 290" className="h-auto w-full max-w-[480px]" role="img" aria-label="Cinco routers unidos por enlaces con su costo; los que tienen la tabla al día se ven en verde">
            {g.enlaces.map((e, i) => {
              const a = POS[e.a]
              const b = POS[e.b]
              return (
                <g key={i}>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={e.up ? 'var(--accent)' : 'var(--bad)'} strokeWidth={e.up ? 4 : 2} strokeDasharray={e.up ? undefined : '6 6'} />
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="transparent" strokeWidth={22} className="cursor-pointer" onClick={() => toggle(i)}>
                    <title>{e.up ? 'Cortar este enlace' : 'Reconectar este enlace'}</title>
                  </line>
                  <text x={(a.x + b.x) / 2 + 8} y={(a.y + b.y) / 2 - 6} fontSize={12} fill="var(--muted)" fontFamily="system-ui">
                    {e.up ? `costo ${e.costo}` : 'cortado'}
                  </text>
                </g>
              )
            })}
            {g.nodos.map((n) => {
              const p = POS[n]
              const good = ok(n)
              return (
                <g key={n} className="cursor-pointer" onClick={() => setSel(n)}>
                  <circle cx={p.x} cy={p.y} r={24} fill={good ? 'var(--ok-soft)' : 'var(--warn-soft)'} stroke={sel === n ? 'var(--fg)' : good ? 'var(--ok)' : 'var(--warn)'} strokeWidth={sel === n ? 3.5 : 2} />
                  <text x={p.x} y={p.y + 5} textAnchor="middle" fontSize={15} fontWeight={700} fill="var(--fg)" fontFamily="system-ui">
                    {n}
                  </text>
                  {modo === 'ls' && !enterados.has(n) && (
                    <text x={p.x} y={p.y + 42} textAnchor="middle" fontSize={10.5} fill="var(--muted)" fontFamily="system-ui">
                      no se enteró
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
          <p className="text-xs text-muted">Tocá un enlace para cortarlo o reconectarlo, y un router para ver su tabla. Verde: tabla al día. Amarillo: desactualizada.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button onClick={step} disabled={todos}>
              {modo === 'dv' ? 'Siguiente intercambio' : 'Siguiente salto del aviso'}
            </Button>
            <Button variant="secondary" onClick={() => reset()}>
              Reiniciar
            </Button>
            {modo === 'dv' && (
              <Button variant="secondary" onClick={fromScratch}>
                Routers recién encendidos
              </Button>
            )}
            <span className={cn('text-sm font-medium', todos ? 'text-ok' : 'text-warn')} aria-live="polite">
              {todos ? (paso ? `Convergió en ${paso} ${paso === 1 ? 'paso' : 'pasos'}.` : 'Todas las tablas al día.') : `Paso ${paso}: todavía hay tablas desactualizadas.`}
            </span>
          </div>
        </div>
        <div className="space-y-3 text-sm">
          <div>
            <h4 className="mb-1 font-semibold">Tabla de {sel}</h4>
            <table className="w-full font-mono text-xs">
              <thead>
                <tr className="text-left text-muted">
                  <th className="py-1">Destino</th>
                  <th>Costo</th>
                  <th>Por</th>
                </tr>
              </thead>
              <tbody>
                {g.nodos
                  .filter((d) => d !== sel)
                  .map((d) => {
                    const e = t[d]
                    const right = correctas[sel][d]
                    const bad = !(e.costo >= INFINITO ? right.costo >= INFINITO : e.costo === right.costo && e.via === right.via)
                    return (
                      <tr key={d} className={cn(bad && 'text-warn')}>
                        <td className="py-0.5">{d}</td>
                        <td>{e.costo >= INFINITO ? '∞' : e.costo}</td>
                        <td>{e.costo >= INFINITO ? '—' : e.via}</td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted">
            {modo === 'dv'
              ? 'Cada router solo sabe lo que le cuentan sus vecinos ("a D llego con costo 3"). Las noticias avanzan de a un vecino por intercambio. En RIP, los intercambios periódicos son cada 30 segundos.'
              : 'Cada router tiene el mapa completo. El aviso del cambio se inunda a todos en milisegundos y cada uno recalcula su tabla con Dijkstra apenas lo recibe.'}
          </p>
        </div>
      </div>
    </Frame>
  )
}
