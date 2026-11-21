import { useState } from 'react'
import { evaluarQuorum, tolerancia, type Lado, type NodoQ } from '@/engines/virtualizacion/quorum'
import { cn } from '@/lib/cn'
import { Chip, Frame, inputClass } from '../fundamentos/Frame'

const NIVEL = {
  ok: { titulo: 'Todo en orden', clase: 'border-ok bg-ok-soft' },
  parcial: { titulo: 'Funciona con lo que queda', clase: 'border-warn bg-warn-soft' },
  bloqueado: { titulo: 'Clúster bloqueado', clase: 'border-bad bg-bad-soft' },
  'split-brain': { titulo: 'Split brain', clase: 'border-bad bg-bad-soft' },
}

const mk = (n: number): NodoQ[] => Array.from({ length: n }, (_, i) => ({ nombre: `pve0${i + 1}`, votos: 1, prendido: true, lado: 'A' as Lado }))

const ESCENARIOS: { id: string; nombre: string; nodos: NodoQ[]; qdevice: boolean; corte: boolean }[] = [
  { id: 'dos', nombre: 'Dos nodos, se cae uno', nodos: mk(2).map((n, i) => ({ ...n, prendido: i === 0 })), qdevice: false, corte: false },
  { id: 'dosq', nombre: 'Dos nodos con QDevice', nodos: mk(2).map((n, i) => ({ ...n, prendido: i === 0 })), qdevice: true, corte: false },
  { id: 'tres', nombre: 'Tres nodos, se cae uno', nodos: mk(3).map((n, i) => ({ ...n, prendido: i !== 2 })), qdevice: false, corte: false },
  { id: 'cuatro', nombre: 'Cuatro nodos, red partida 2 y 2', nodos: mk(4).map((n, i) => ({ ...n, lado: i < 2 ? 'A' : 'B' })), qdevice: false, corte: true },
  { id: 'salas', nombre: 'Cinco nodos en dos salas', nodos: mk(5).map((n, i) => ({ ...n, lado: i < 3 ? 'A' : 'B' })), qdevice: false, corte: true },
]

/** Simulador de quórum: nodos que se caen, redes que se parten, QDevice y votos esperados. */
export function QuorumSimulator() {
  const [nodos, setNodos] = useState<NodoQ[]>(mk(3))
  const [qdevice, setQdevice] = useState(false)
  const [qdevicePrendido, setQdevicePrendido] = useState(true)
  const [corte, setCorte] = useState(false)
  const [forzar, setForzar] = useState(false)
  const [esperados, setEsperados] = useState(1)
  const [escenario, setEscenario] = useState<string | null>(null)
  const efectivos = nodos.map((n) => ({ ...n, lado: corte ? n.lado : ('A' as Lado) }))
  const r = evaluarQuorum({ nodos: efectivos, qdevice, qdevicePrendido, esperados: forzar ? esperados : undefined })
  const set = (i: number, patch: Partial<NodoQ>) => {
    setEscenario(null)
    setNodos(nodos.map((n, j) => (j === i ? { ...n, ...patch } : n)))
  }
  const cantidad = (n: number) => {
    setEscenario(null)
    setNodos(Array.from({ length: n }, (_, i) => nodos[i] ?? { nombre: `pve0${i + 1}`, votos: 1, prendido: true, lado: 'A' }))
  }
  const cargar = (id: string) => {
    const e = ESCENARIOS.find((x) => x.id === id)!
    setEscenario(id)
    setNodos(e.nodos.map((n) => ({ ...n })))
    setQdevice(e.qdevice)
    setQdevicePrendido(true)
    setCorte(e.corte)
    setForzar(false)
  }
  const nivel = NIVEL[r.nivel]

  return (
    <Frame titulo="Simulador de quórum">
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Escenarios">
          {ESCENARIOS.map((e) => (
            <Chip key={e.id} active={escenario === e.id} onClick={() => cargar(e.id)}>
              {e.nombre}
            </Chip>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-4 text-sm">
          <label>
            <span className="block text-muted">Nodos</span>
            <select value={nodos.length} onChange={(e) => cantidad(Number(e.target.value))} className={cn(inputClass, 'mt-1 w-20')}>
              {[2, 3, 4, 5, 6, 7].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-h-10 items-center gap-2">
            <input type="checkbox" checked={qdevice} onChange={(e) => (setEscenario(null), setQdevice(e.target.checked))} />
            Dispositivo de quórum (QDevice)
          </label>
          {qdevice && (
            <label className="flex min-h-10 items-center gap-2">
              <input type="checkbox" checked={qdevicePrendido} onChange={(e) => (setEscenario(null), setQdevicePrendido(e.target.checked))} />
              QDevice prendido
            </label>
          )}
          <label className="flex min-h-10 items-center gap-2">
            <input type="checkbox" checked={corte} onChange={(e) => (setEscenario(null), setCorte(e.target.checked))} />
            Se corta la red entre dos grupos
          </label>
          <label className="flex min-h-10 items-center gap-2">
            <input type="checkbox" checked={forzar} onChange={(e) => (setEscenario(null), setForzar(e.target.checked))} />
            Forzar votos esperados (pvecm expected)
          </label>
          {forzar && (
            <label>
              <span className="block text-muted">Votos esperados</span>
              <input type="number" min={1} max={8} value={esperados} onChange={(e) => setEsperados(Math.max(1, Number(e.target.value)))} className={cn(inputClass, 'mt-1 w-20')} />
            </label>
          )}
        </div>

        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {nodos.map((n, i) => (
            <li key={n.nombre} className={cn('rounded-lg border p-3 text-sm', n.prendido ? 'border-line bg-surface' : 'border-line bg-surface-2 text-muted')}>
              <div className="font-mono font-semibold">{n.nombre}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" onClick={() => set(i, { prendido: !n.prendido })} aria-pressed={n.prendido} className={cn('min-h-9 rounded-md border px-2', n.prendido ? 'border-ok text-ok' : 'border-bad text-bad')}>
                  {n.prendido ? 'Prendido' : 'Apagado'}
                </button>
                {corte && (
                  <button type="button" onClick={() => set(i, { lado: n.lado === 'A' ? 'B' : 'A' })} className="min-h-9 rounded-md border border-line px-2 hover:bg-surface-2" aria-label={`${n.nombre}: lado ${n.lado}, cambiar de lado`}>
                    Lado {n.lado}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>

        <div className="grid gap-2 sm:grid-cols-2">
          {r.particiones.map((p) => (
            <div key={p.lado} className={cn('rounded-lg border p-3 text-sm', p.quorum ? 'border-ok bg-ok-soft' : 'border-bad bg-bad-soft')}>
              <div className="font-semibold">{corte ? `Lado ${p.lado}` : 'Nodos prendidos'}: {p.quorum ? 'con quórum' : 'sin quórum'}</div>
              <div className="mt-1 font-mono">
                {p.votos} de {r.necesarios} votos necesarios{p.conQdevice ? ' (incluye el del QDevice)' : ''}
              </div>
              <div className="mt-1 text-muted">{p.nodos.join(', ')}</div>
            </div>
          ))}
          {!r.particiones.length && <div className="rounded-lg border border-bad bg-bad-soft p-3 text-sm">No hay nodos prendidos.</div>}
        </div>

        <div role="status" className={cn('rounded-lg border p-3 text-sm', nivel.clase)}>
          <div className="font-semibold">{nivel.titulo}</div>
          <p className="mt-1">{r.resumen}</p>
          <p className="mt-2 text-muted">
            Votos esperados: {r.esperados}. Con {nodos.length} nodos{qdevice ? ' y QDevice' : ''}, {tolerancia(nodos.length, qdevice) === 0 ? 'el clúster no aguanta que se caiga ningún nodo.' : tolerancia(nodos.length, qdevice) === 1 ? 'el clúster aguanta que se caiga un nodo.' : `el clúster aguanta que se caigan ${tolerancia(nodos.length, qdevice)} nodos a la vez.`}
          </p>
        </div>
      </div>
    </Frame>
  )
}
