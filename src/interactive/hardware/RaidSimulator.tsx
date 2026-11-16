import { useEffect, useState } from 'react'
import { layout, MIN_DISKS, raidInfo, raidState, rebuildHours, type RaidLevel } from '@/engines/hardware/raid'
import { cn } from '@/lib/cn'
import { Button } from '@/ui'
import { Chip, Frame, inputClass } from '../fundamentos/Frame'

const LEVELS: RaidLevel[] = [0, 1, 5, 6, 10]
const SIZES = [1, 4, 8, 16, 20]

const STATE_TEXT = {
  sano: { titulo: 'Sano', clase: 'border-ok bg-ok-soft text-ok' },
  degradado: { titulo: 'Degradado: los datos siguen, pero sin protección completa', clase: 'border-warn bg-warn-soft text-warn' },
  perdido: { titulo: 'Datos perdidos: fallaron más discos de los que soporta este nivel', clase: 'border-bad bg-bad-soft text-bad' },
}

/** Simulador de RAID: elegir nivel y discos, hacer fallar discos y reconstruir. */
export function RaidSimulator({ nivel = 5, discos = 4 }: { nivel?: RaidLevel; discos?: number }) {
  const [level, setLevel] = useState<RaidLevel>(nivel)
  const [n, setN] = useState(Math.max(discos, MIN_DISKS[nivel]))
  const [tb, setTb] = useState(8)
  const [failed, setFailed] = useState<Set<number>>(new Set())
  const [rebuild, setRebuild] = useState<number | undefined>()

  const changeLevel = (l: RaidLevel) => {
    setLevel(l)
    let k = Math.max(n, MIN_DISKS[l])
    if (l === 10 && k % 2) k++
    setN(k)
    setFailed(new Set())
    setRebuild(undefined)
  }
  const changeN = (k: number) => {
    const min = MIN_DISKS[level]
    let v = Math.min(8, Math.max(min, k))
    if (level === 10 && v % 2) v += k > n ? 1 : -1
    setN(Math.min(8, Math.max(min, v)))
    setFailed(new Set())
    setRebuild(undefined)
  }

  useEffect(() => {
    if (rebuild === undefined) return
    const t = setTimeout(() => {
      if (rebuild + 4 >= 100) {
        setFailed(new Set())
        setRebuild(undefined)
      } else setRebuild(rebuild + 4)
    }, 90)
    return () => clearTimeout(t)
  }, [rebuild])

  const info = raidInfo(level, n, tb)
  const state = raidState(level, n, failed)
  const blocks = layout(level, n)
  const toggle = (i: number) => {
    if (rebuild !== undefined) return
    const f = new Set(failed)
    if (f.has(i)) f.delete(i)
    else f.add(i)
    setFailed(f)
  }

  return (
    <Frame titulo="Simulador de RAID">
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="text-sm">
            <span className="block text-muted">Nivel</span>
            <div className="mt-1 flex flex-wrap gap-1">
              {LEVELS.map((l) => (
                <Chip key={l} active={level === l} onClick={() => changeLevel(l)}>
                  RAID {l}
                </Chip>
              ))}
            </div>
          </div>
          <div className="text-sm">
            <span className="block text-muted">Discos</span>
            <div className="mt-1 flex items-center gap-1">
              <button type="button" className="h-9 w-9 rounded border border-line" aria-label="Un disco menos" onClick={() => changeN(n - (level === 10 ? 2 : 1))}>
                −
              </button>
              <span className="w-6 text-center font-mono" aria-live="polite">
                {n}
              </span>
              <button type="button" className="h-9 w-9 rounded border border-line" aria-label="Un disco más" onClick={() => changeN(n + (level === 10 ? 2 : 1))}>
                +
              </button>
            </div>
          </div>
          <label className="text-sm">
            <span className="block text-muted">Tamaño de cada disco</span>
            <select value={tb} onChange={(e) => setTb(Number(e.target.value))} className={cn(inputClass, 'mt-1')}>
              {SIZES.map((s) => (
                <option key={s} value={s}>
                  {s} TB
                </option>
              ))}
            </select>
          </label>
        </div>

        <p className="text-sm text-muted">Tocá un disco para hacerlo fallar (o para "repararlo"). Cada casilla es un bloque: A1, A2... son datos; Ap y Aq, la paridad.</p>

        <div className="flex flex-wrap gap-2" role="group" aria-label="Discos del arreglo">
          {blocks.map((col, i) => {
            const isFailed = failed.has(i)
            const isRebuilding = isFailed && rebuild !== undefined
            return (
              <button
                key={i}
                type="button"
                onClick={() => toggle(i)}
                aria-pressed={isFailed}
                aria-label={`Disco ${i + 1}${isFailed ? ', fallado' : ''}`}
                className={cn('w-[4.75rem] rounded-lg border-2 p-1.5 text-left transition-colors', isFailed ? (isRebuilding ? 'border-warn bg-warn-soft' : 'border-bad bg-bad-soft') : 'border-line bg-surface-2 hover:border-accent')}
              >
                <div className="mb-1 text-center text-xs font-semibold">
                  Disco {i + 1}
                  {level === 10 && <span className="block font-normal text-muted">par {Math.floor(i / 2) + 1}</span>}
                </div>
                <div className="space-y-1">
                  {col.map((b, r) => (
                    <div key={r} className={cn('rounded px-1 py-0.5 text-center font-mono text-xs', isFailed && !isRebuilding ? 'bg-bad-soft text-bad line-through' : /p$|q$/.test(b) ? 'bg-accent-soft text-accent' : 'bg-bg')}>
                      {b}
                    </div>
                  ))}
                </div>
                <div className="mt-1 text-center text-xs">{isRebuilding ? `${rebuild}%` : isFailed ? '✕ falló' : 'OK'}</div>
              </button>
            )
          })}
        </div>

        <div role="status" className={cn('rounded-lg border p-3 text-sm font-semibold', STATE_TEXT[state].clase)}>
          {rebuild !== undefined ? `Reconstruyendo sobre el disco nuevo: ${rebuild}%. Mientras tanto, otra falla puede ser fatal.` : STATE_TEXT[state].titulo}
        </div>

        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted">Capacidad útil</dt>
            <dd className="font-semibold">
              {info.capacidad} TB de {n * tb} TB ({info.eficiencia} %)
            </dd>
          </div>
          <div>
            <dt className="text-muted">Discos que pueden fallar</dt>
            <dd className="font-semibold">{info.tolerancia}</dd>
          </div>
          <div>
            <dt className="text-muted">Lectura / escritura</dt>
            <dd>
              {info.lectura} / {info.escritura}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Reconstruir un disco</dt>
            <dd>{level === 0 ? 'no hay reconstrucción posible' : `unas ${rebuildHours(tb)} horas, leyendo todos los demás discos`}</dd>
          </div>
        </dl>

        <div className="flex flex-wrap gap-2">
          {state === 'degradado' && rebuild === undefined && <Button onClick={() => setRebuild(0)}>Reemplazar los discos fallados y reconstruir</Button>}
          {state === 'perdido' && (
            <Button
              onClick={() => {
                setFailed(new Set())
                setRebuild(undefined)
              }}
            >
              Discos nuevos y restaurar desde el respaldo
            </Button>
          )}
        </div>
        {state === 'perdido' && <p className="text-sm">El RAID protege contra la rotura de discos, no reemplaza al respaldo: con esta combinación de fallas, lo único que trae los datos de vuelta es una copia en otro lado.</p>}
        {level === 5 && tb >= 8 && <p className="text-sm text-muted">Con discos de {tb} TB, la reconstrucción de un RAID 5 lee {(n - 1) * tb} TB sin protección: si en ese tiempo falla otro disco o aparece un sector ilegible, se pierde todo. Por eso, con discos grandes, se prefiere RAID 6 o RAID 10.</p>}
      </div>
    </Frame>
  )
}
