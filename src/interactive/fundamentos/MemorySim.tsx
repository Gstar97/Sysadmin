import { useState } from 'react'
import { access, allocate, createMemory, fillCache, memoryStats, type MemState } from '@/engines/fundamentos/paging'
import { cn } from '@/lib/cn'
import { Button, Icon } from '@/ui'
import { Frame } from './Frame'

const PROCS = [
  { id: 'web', nombre: 'servidor web' },
  { id: 'bd', nombre: 'base de datos' },
  { id: 'rep', nombre: 'reporte mensual' },
]
const COLORS: Record<string, string> = { web: '#0ea5e9', bd: '#8b5cf6', rep: '#f59e0b' }

function initial(): MemState {
  let s = createMemory(12, 4, PROCS)
  s = allocate(s, 'web')
  s = allocate(s, 'web')
  s = allocate(s, 'bd')
  s = allocate(s, 'bd')
  s = allocate(s, 'bd')
  s = fillCache(fillCache(fillCache(s)))
  return { ...s, log: [{ text: 'Arranque: el servidor web y la base de datos están corriendo y el kernel usa parte de la memoria libre como caché de disco.', kind: 'info' }] }
}

export function MemorySim() {
  const [s, setS] = useState<MemState>(initial)
  const st = memoryStats(s)
  const pageSize = 256 // MiB por página, para que los números se parezcan a "free -m"

  return (
    <Frame
      titulo="Memoria RAM, caché y swap"
      acciones={
        <Button variant="ghost" onClick={() => setS(initial())}>
          <Icon name="refresh" className="h-4 w-4" />
          Reiniciar
        </Button>
      }
    >
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <div className="mb-1 text-sm font-medium">RAM ({s.ram.length} marcos de {pageSize} MiB)</div>
          <div className="grid grid-cols-6 gap-1" aria-label="Marcos de RAM">
            {s.ram.map((f, i) => (
              <div
                key={i}
                className={cn('flex h-11 items-center justify-center rounded text-[10px] font-medium', f.kind === 'free' && 'border border-dashed border-line text-muted', f.kind === 'cache' && 'bg-surface-2 text-muted')}
                style={f.kind === 'page' ? { background: COLORS[f.proc], color: 'white' } : undefined}
                title={f.kind === 'page' ? `${PROCS.find((p) => p.id === f.proc)?.nombre}, página ${f.page}` : f.kind === 'cache' ? 'caché de disco' : 'libre'}
              >
                {f.kind === 'page' ? `${f.proc}:${f.page}` : f.kind === 'cache' ? 'caché' : 'libre'}
              </div>
            ))}
          </div>
          <div className="mb-1 mt-3 text-sm font-medium">Swap en disco ({s.swap.length} espacios)</div>
          <div className="grid grid-cols-6 gap-1" aria-label="Espacios de swap">
            {s.swap.map((x, i) => (
              <div key={i} className={cn('flex h-9 items-center justify-center rounded text-[10px]', !x && 'border border-dashed border-line text-muted')} style={x ? { background: COLORS[x.proc], color: 'white', opacity: 0.75 } : undefined}>
                {x ? `${x.proc}:${x.page}` : 'vacío'}
              </div>
            ))}
          </div>
          <pre className="mt-3 overflow-x-auto rounded-lg p-2 font-mono text-[11px] leading-snug" style={{ background: 'var(--term-bg)', color: 'var(--term-fg)' }} aria-label="Lo que mostraría free -m">
            {`$ free -m\n               total        used        free  buff/cache   available\nMem:     ${String(st.total * pageSize).padStart(10)}  ${String(st.used * pageSize).padStart(10)}  ${String(st.free * pageSize).padStart(10)}  ${String(st.cache * pageSize).padStart(10)}  ${String(st.available * pageSize).padStart(10)}\nSwap:    ${String(st.swapTotal * pageSize).padStart(10)}  ${String(st.swapUsed * pageSize).padStart(10)}  ${String((st.swapTotal - st.swapUsed) * pageSize).padStart(10)}`}
          </pre>
          <p className="mt-1 text-xs text-muted">Fallos de página: {s.pageFaults} · Páginas enviadas al swap: {s.swapOuts}</p>
        </div>
        <div className="space-y-2">
          {s.procs.map((p) => (
            <div key={p.id} className={cn('rounded-lg border p-2', p.alive ? 'border-line' : 'border-bad bg-bad-soft')}>
              <div className="flex items-center gap-2 text-sm font-medium">
                <span className="h-3 w-3 rounded-sm" style={{ background: COLORS[p.id] }} />
                {p.nombre}
                <span className="ml-auto text-xs text-muted">{p.alive ? `${p.pages} páginas` : 'terminado por el OOM killer'}</span>
              </div>
              {p.alive && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Button variant="secondary" className="min-h-8 px-2 text-xs" onClick={() => setS(allocate(s, p.id))}>
                    Pedir memoria
                  </Button>
                  {Array.from({ length: p.pages }, (_, page) => {
                    const inSwap = s.swap.some((x) => x && x.proc === p.id && x.page === page)
                    return (
                      <button key={page} type="button" onClick={() => setS(access(s, p.id, page))} className={cn('min-h-8 rounded-md border px-2 text-xs', inSwap ? 'border-warn text-warn' : 'border-line')} title={inSwap ? 'Está en el swap: usarla provoca un fallo de página' : 'Está en RAM'}>
                        usar {page}
                        {inSwap ? ' (swap)' : ''}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          ))}
          <Button variant="ghost" className="min-h-8 text-xs" onClick={() => setS(fillCache(s))} disabled={st.free === 0}>
            Leer un archivo grande (usa caché)
          </Button>
          <ol className="max-h-56 space-y-1 overflow-y-auto rounded-lg bg-surface-2 p-2 text-xs" aria-live="polite" aria-label="Qué pasó">
            {[...s.log].reverse().map((l, i) => (
              <li key={s.log.length - i} className={cn(l.kind === 'oom' && 'font-semibold text-bad', l.kind === 'fault' && 'text-warn', l.kind === 'swap' && 'text-info')}>
                {l.text}
              </li>
            ))}
          </ol>
        </div>
      </div>
      <p className="mt-3 text-xs text-muted">
        Prueba: haz que el reporte mensual pida memoria varias veces. Primero se ocupa la memoria libre, después el kernel descarta caché, después manda páginas poco usadas al swap y, si todo se llena, el OOM killer termina un proceso.
      </p>
    </Frame>
  )
}
