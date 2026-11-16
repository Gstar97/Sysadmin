import { useMemo, useState, type DragEvent } from 'react'
import { fits, occupied, rackChecks, rackTotals, RACK_CATALOG, typeOf, type Placed } from '@/engines/hardware/rack'
import { cn } from '@/lib/cn'
import { Button } from '@/ui'
import { Frame } from '../fundamentos/Frame'

const COLORS: Record<string, string> = {
  servidor: 'bg-accent-soft border-accent',
  almacenamiento: 'bg-accent-soft border-accent',
  red: 'bg-info-soft border-info',
  patchera: 'bg-surface-2 border-line',
  organizador: 'bg-surface-2 border-line',
  ups: 'bg-warn-soft border-warn',
  consola: 'bg-ok-soft border-ok',
}

const ROW = 22

/**
 * Constructor de rack: poner los equipos en sus unidades y ver si el armado respeta las reglas
 * (peso abajo, red arriba con su patchera, potencia de la UPS, sin huecos).
 */
export function RackBuilder({ altura = 24, inventario }: { altura?: number; inventario?: string[] }) {
  const initial = useMemo(() => (inventario ?? []).map((id, i) => ({ key: `inv${i}`, typeId: id })), [inventario])
  const [pending, setPending] = useState(initial)
  const [placed, setPlaced] = useState<Placed[]>([])
  const [selected, setSelected] = useState<{ key: string; typeId: string; from: 'inv' | 'rack' } | undefined>()
  const [msg, setMsg] = useState('')
  const [seq, setSeq] = useState(0)
  const free = !inventario

  const occ = occupied(placed)
  const checks = rackChecks(placed, altura)
  const totals = rackTotals(placed)
  const done = !free && pending.length === 0 && checks.every((c) => c.ok)

  const place = (key: string, typeId: string, bottom: number, from: 'inv' | 'rack' | 'catalog') => {
    if (!fits(placed, typeId, bottom, altura, from === 'rack' ? key : undefined)) {
      setMsg(`No entra: ${typeOf(typeId).nombre} ocupa ${typeOf(typeId).u} U desde la ${bottom} y se superpone con otro equipo o se sale del rack.`)
      return
    }
    setMsg('')
    if (from === 'rack') setPlaced(placed.map((p) => (p.key === key ? { ...p, bottom } : p)))
    else {
      setPlaced([...placed, { key: from === 'catalog' ? `c${seq}` : key, typeId, bottom }])
      setSeq(seq + 1)
      if (from === 'inv') setPending(pending.filter((p) => p.key !== key))
    }
    setSelected(undefined)
  }

  const remove = (p: Placed) => {
    setPlaced(placed.filter((x) => x.key !== p.key))
    if (!free) setPending([...pending, { key: p.key, typeId: p.typeId }])
    setSelected(undefined)
  }

  const onDrop = (e: DragEvent, u: number) => {
    e.preventDefault()
    const data = e.dataTransfer.getData('text/plain')
    if (!data) return
    const [from, key, typeId] = data.split('|') as ['inv' | 'rack' | 'catalog', string, string]
    place(key, typeId, u, from)
  }

  const slots = Array.from({ length: altura }, (_, i) => altura - i)
  const palette = free ? RACK_CATALOG.map((t) => ({ key: t.id, typeId: t.id })) : pending

  return (
    <Frame titulo={`Constructor de rack (${altura} U)`}>
      <div className="grid gap-4 md:grid-cols-[minmax(0,14rem)_minmax(0,16rem)_minmax(0,1fr)]">
        <div>
          <h4 className="mb-2 text-sm font-semibold">{free ? 'Equipos' : 'Por ubicar'}</h4>
          {palette.length === 0 && <p className="text-sm text-muted">No queda nada por ubicar.</p>}
          <ul className="space-y-1">
            {palette.map((p) => {
              const t = typeOf(p.typeId)
              const active = selected?.key === p.key
              return (
                <li key={p.key}>
                  <button
                    type="button"
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData('text/plain', `${free ? 'catalog' : 'inv'}|${p.key}|${p.typeId}`)}
                    onClick={() => setSelected(active ? undefined : { key: p.key, typeId: p.typeId, from: 'inv' })}
                    aria-pressed={active}
                    className={cn('w-full rounded-lg border px-2 py-1 text-left text-sm', COLORS[t.tipo], active && 'ring-2 ring-accent')}
                  >
                    <span className="font-medium">{t.nombre}</span>
                    <span className="block text-xs text-muted">
                      {t.u} U · {t.peso} kg{t.watts ? ` · ${t.watts} W` : ''}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          <p className="mt-2 text-xs text-muted">Elegí un equipo y tocá la unidad del rack donde va su parte de abajo, o arrastralo. Tocá un equipo del rack para moverlo o sacarlo.</p>
        </div>

        <div className="rounded-lg border-2 border-fg/60 bg-surface-2 p-1" role="grid" aria-label="Rack">
          <div className="relative" style={{ height: altura * ROW }}>
            {slots.map((u, i) => {
              const taken = occ.has(u)
              return (
                <button
                  key={u}
                  type="button"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => onDrop(e, u)}
                  onClick={() => selected && place(selected.key, selected.typeId, u, selected.from === 'inv' ? (free ? 'catalog' : 'inv') : 'rack')}
                  aria-label={`Unidad ${u}${taken ? ', ocupada' : ''}`}
                  className={cn('absolute left-0 right-0 flex items-center border-b border-dashed border-line/60 text-left', !taken && selected && 'hover:bg-accent-soft')}
                  style={{ top: i * ROW, height: ROW }}
                >
                  <span className="w-6 text-right font-mono text-[10px] text-muted">{u}</span>
                </button>
              )
            })}
            {placed.map((p) => {
              const t = typeOf(p.typeId)
              const top = (altura - (p.bottom + t.u - 1)) * ROW
              const active = selected?.key === p.key
              return (
                <div key={p.key} className={cn('absolute left-7 right-1 flex items-center justify-between gap-1 rounded border px-1 text-xs', COLORS[t.tipo], active && 'ring-2 ring-accent')} style={{ top: top + 1, height: t.u * ROW - 2 }}>
                  <button type="button" draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', `rack|${p.key}|${p.typeId}`)} onClick={() => setSelected(active ? undefined : { key: p.key, typeId: p.typeId, from: 'rack' })} className="min-w-0 flex-1 truncate text-left font-medium">
                    {t.nombre}
                  </button>
                  {active && (
                    <button type="button" onClick={() => remove(p)} className="rounded border border-line bg-surface px-1" aria-label={`Sacar ${t.nombre}`}>
                      ✕
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        <div className="space-y-3 text-sm">
          <dl className="grid grid-cols-3 gap-2">
            <div>
              <dt className="text-muted">Ocupado</dt>
              <dd className="font-semibold">
                {totals.u} de {altura} U
              </dd>
            </div>
            <div>
              <dt className="text-muted">Peso</dt>
              <dd className="font-semibold">{totals.peso} kg</dd>
            </div>
            <div>
              <dt className="text-muted">Consumo</dt>
              <dd className="font-semibold">{totals.watts} W</dd>
            </div>
          </dl>
          {msg && (
            <p role="alert" className="rounded border border-bad bg-bad-soft p-2 text-bad">
              {msg}
            </p>
          )}
          <h4 className="font-semibold">Revisión del armado</h4>
          {checks.length === 0 ? (
            <p className="text-muted">Ubicá algunos equipos para ver la revisión.</p>
          ) : (
            <ul className="space-y-1" aria-live="polite">
              {checks.map((c) => (
                <li key={c.id} className={cn('flex gap-2', c.ok ? 'text-ok' : 'text-bad')}>
                  <span aria-hidden>{c.ok ? '✓' : '✗'}</span>
                  <span className="text-fg">{c.texto}</span>
                </li>
              ))}
            </ul>
          )}
          {done && (
            <p role="status" className="rounded-lg border border-ok bg-ok-soft p-2 font-semibold text-ok">
              Rack armado: todo ubicado y sin problemas. Falta lo que no se ve acá: rotular cada cable en las dos puntas y anotar el plano del rack en la documentación.
            </p>
          )}
          <Button
            variant="secondary"
            onClick={() => {
              setPlaced([])
              setPending(initial)
              setSelected(undefined)
              setMsg('')
            }}
          >
            Empezar de nuevo
          </Button>
        </div>
      </div>
    </Frame>
  )
}
