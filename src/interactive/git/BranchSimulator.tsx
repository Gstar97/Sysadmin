import { useEffect, useMemo, useRef, useState } from 'react'
import { ejecutar, head, huerfanos, inicial, type Grafo } from '@/engines/git/ramas'
import { cn } from '@/lib/cn'
import { Frame, inputClass } from '../fundamentos/Frame'

const SUGERIDOS = ['git commit -m "Cambio"', 'git switch -c prueba', 'git switch main', 'git merge prueba', 'git merge --no-ff prueba', 'git log', 'git reset --hard HEAD~1']

function correr(cmds: string[]): { g: Grafo; hist: { cmd: string; salida: string; error?: boolean }[] } {
  let g = inicial()
  const hist: { cmd: string; salida: string; error?: boolean }[] = []
  for (const c of cmds) {
    const r = ejecutar(g, c)
    g = r.grafo
    hist.push({ cmd: c, salida: r.salida, error: r.error })
  }
  return { g, hist }
}

/**
 * Simulador de ramas: se escriben comandos de git y se ve cómo cambia el grafo de commits
 * (commits, ramas, HEAD, avance rápido, commits de fusión y commits que quedan huérfanos).
 */
export function BranchSimulator({ comandos = [] }: { comandos?: string[] }) {
  const base = useMemo(() => correr(comandos), [comandos])
  const [g, setG] = useState<Grafo>(base.g)
  const [hist, setHist] = useState(base.hist.map((h) => ({ ...h, previo: true })))
  const [linea, setLinea] = useState('')
  const log = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight
  }, [hist])

  const enviar = (cmd: string) => {
    if (!cmd.trim()) return
    const r = ejecutar(g, cmd)
    setG(r.grafo)
    setHist((h) => [...h, { cmd, salida: r.salida, error: r.error, previo: false }].slice(-30))
    setLinea('')
  }
  const reiniciar = () => {
    setG(base.g)
    setHist(base.hist.map((h) => ({ ...h, previo: true })))
  }

  const h = head(g)
  const muertos = huerfanos(g)
  const X = (orden: number) => 30 + orden * 58
  const Y = (carril: number) => 34 + carril * 46
  const ancho = Math.max(320, X(g.commits.length) + 90)
  const alto = Math.max(110, Y(Math.max(...g.commits.map((c) => c.carril))) + 60)
  const etiquetas = new Map<string, string[]>()
  for (const [r, id] of Object.entries(g.ramas)) etiquetas.set(id, [...(etiquetas.get(id) ?? []), r])
  const descripcion = `Grafo con ${g.commits.length} commits. Ramas: ${Object.entries(g.ramas)
    .map(([r, id]) => `${r} en ${id}`)
    .join(', ')}. HEAD ${h.rama ? `en la rama ${h.rama}` : `suelto en ${h.id}`}.`

  return (
    <Frame titulo="Simulador de ramas" acciones={<button type="button" onClick={reiniciar} className="rounded-md border border-line px-2 py-1 text-xs">Reiniciar</button>}>
      <div className="space-y-3 text-sm">
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <svg width={ancho} height={alto} viewBox={`0 0 ${ancho} ${alto}`} role="img" aria-label={descripcion} className="block text-fg">
            {g.commits.flatMap((c) =>
              c.parents.map((p) => {
                const pc = g.commits.find((x) => x.id === p)!
                const x1 = X(pc.orden)
                const y1 = Y(pc.carril)
                const x2 = X(c.orden)
                const y2 = Y(c.carril)
                const d = y1 === y2 ? `M${x1} ${y1} L${x2} ${y2}` : `M${x1} ${y1} C ${x1 + 30} ${y1}, ${x2 - 30} ${y2}, ${x2} ${y2}`
                return <path key={`${p}-${c.id}`} d={d} fill="none" stroke="currentColor" strokeWidth={1.6} strokeDasharray={muertos.has(c.id) ? '4 3' : undefined} opacity={muertos.has(c.id) ? 0.4 : 1} />
              }),
            )}
            {g.commits.map((c) => {
              const x = X(c.orden)
              const y = Y(c.carril)
              const esHead = c.id === h.id
              const labels = etiquetas.get(c.id) ?? []
              return (
                <g key={c.id} opacity={muertos.has(c.id) ? 0.4 : 1}>
                  <circle cx={x} cy={y} r={c.parents.length > 1 ? 11 : 9} fill={c.parents.length > 1 ? 'var(--info-soft, #e0e9fd)' : 'var(--surface, #fff)'} stroke="currentColor" strokeWidth={esHead ? 3 : 1.5} />
                  <text x={x} y={y + 24} textAnchor="middle" fontSize={10} fill="currentColor">
                    {c.id}
                  </text>
                  {labels.map((r, i) => (
                    <text key={r} x={x + 14} y={y - 12 - i * 13} fontSize={11} fontWeight={700} fill="currentColor">
                      {r === h.rama ? `HEAD → ${r}` : r}
                    </text>
                  ))}
                  {esHead && !h.rama && (
                    <text x={x + 14} y={y - 12} fontSize={11} fontWeight={700} fill="currentColor">
                      HEAD (suelto)
                    </text>
                  )}
                  <title>{`${c.id}: ${c.mensaje}`}</title>
                </g>
              )
            })}
          </svg>
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            enviar(linea)
          }}
        >
          <label className="sr-only" htmlFor="ramas-cmd">
            Comando de git
          </label>
          <input id="ramas-cmd" value={linea} onChange={(e) => setLinea(e.target.value)} placeholder='git commit -m "mensaje"' className={cn(inputClass, 'min-w-0 flex-1')} autoComplete="off" spellCheck={false} />
          <button type="submit" className="rounded-lg bg-accent px-3 text-white">
            Ejecutar
          </button>
        </form>
        <div className="flex flex-wrap gap-2">
          {SUGERIDOS.map((s) => (
            <button key={s} type="button" onClick={() => enviar(s)} className="rounded-md border border-line px-2 py-1 font-mono text-xs">
              {s}
            </button>
          ))}
        </div>
        <div ref={log} className="max-h-48 overflow-y-auto rounded-lg bg-bg p-2 font-mono text-xs" aria-live="polite">
          {hist.filter((x) => !x.previo).length === 0 && <p className="text-muted">Escribí un comando o tocá uno de los de arriba.</p>}
          {hist
            .filter((x) => !x.previo)
            .map((x, i) => (
              <div key={i} className="mb-1">
                <div>$ {x.cmd}</div>
                {x.salida && <pre className={cn('whitespace-pre-wrap', x.error && 'text-bad')}>{x.salida}</pre>}
              </div>
            ))}
        </div>
        {muertos.size > 0 && <p className="text-xs text-muted">Los commits en gris ya no están en ninguna rama: Git los borra solo después de un tiempo (y se pueden recuperar con git reflog mientras tanto).</p>}
      </div>
    </Frame>
  )
}
