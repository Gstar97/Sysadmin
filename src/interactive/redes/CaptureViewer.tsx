import { useMemo, useState } from 'react'
import type { CapturaExercise, CapturaTask } from '@/content/exercise-schemas'
import { ESCENARIOS, escenario, info, protocolo, type Pkt } from '@/engines/captura/model'
import { DISPLAY_FIELDS, FilterError, compileDisplay } from '@/engines/captura/filtros'
import { detalle, seguirTcp } from '@/engines/captura/salida'
import { cn } from '@/lib/cn'
import { createRng, shuffle } from '@/lib/random'
import { Button, RichText, renderInline } from '@/ui'
import { Chip, Feedback, Frame } from '../fundamentos/Frame'

/** Colores de fila parecidos a las reglas por defecto de Wireshark. */
function rowTone(p: Pkt): string {
  if (p.tcp?.analysis || p.tcp?.flags.includes('R') || (p.icmp && p.icmp.type === 3) || (p.dns?.response && p.dns.rcode !== 'NOERROR')) return 'bg-bad-soft'
  if (p.arp) return 'bg-warn-soft'
  if (p.dns || p.dhcp || p.udp) return 'bg-info-soft'
  if (p.icmp) return 'bg-accent-soft'
  if (p.tcp && (p.tcp.flags.includes('S') || p.tcp.flags.includes('F'))) return 'bg-surface-2'
  if (p.tls || p.http) return 'bg-ok-soft'
  return ''
}

function compile(expr: string): { pred?: (p: Pkt) => boolean; error?: string } {
  try {
    return { pred: compileDisplay(expr) }
  } catch (e) {
    if (e instanceof FilterError) return { error: e.message }
    throw e
  }
}

const SUGERIDOS = ['dns', 'arp || dhcp', 'tcp.flags.syn == 1', 'tcp.analysis.flags', 'icmp', 'tls.handshake.type == 1', 'ip.addr == 192.168.10.100 && tcp.port == 443', 'dns.flags.rcode != 0']

type Estado = 'ok' | 'mal' | undefined

function Tarea({ t, i, pkts, aplicado, seleccion, estado, setEstado }: { t: CapturaTask; i: number; pkts: Pkt[]; aplicado: string; seleccion?: number; estado: Estado; setEstado: (e: Estado) => void }) {
  const [elegida, setElegida] = useState<number>()
  // Las opciones se muestran mezcladas (en los datos, la correcta suele ir primera).
  const orden = useMemo(() => (t.tipo === 'pregunta' ? shuffle(createRng(), t.opciones.map((_, k) => k)) : []), [t])
  const [mensaje, setMensaje] = useState<string>()
  const comprobar = () => {
    if (t.tipo === 'filtro') {
      const want = new Set(pkts.filter(compileDisplay(t.solucion)).map((p) => p.n))
      const c = compile(aplicado)
      if (!aplicado.trim()) return (setEstado('mal'), setMensaje('Primero escribí un filtro arriba y aplicalo (Enter o el botón Aplicar).'))
      if (!c.pred) return (setEstado('mal'), setMensaje('El filtro aplicado tiene un error de sintaxis.'))
      const got = pkts.filter(c.pred).map((p) => p.n)
      const sobran = got.filter((n) => !want.has(n)).length
      const faltan = [...want].filter((n) => !got.includes(n)).length
      if (!sobran && !faltan) return (setEstado('ok'), setMensaje(undefined))
      setEstado('mal')
      setMensaje(`Tu filtro muestra ${got.length} paquete${got.length === 1 ? '' : 's'}: ${sobran ? `${sobran} que no van` : ''}${sobran && faltan ? ' y ' : ''}${faltan ? `le faltan ${faltan}` : ''}.`)
    } else if (t.tipo === 'paquete') {
      if (seleccion === undefined) return (setEstado('mal'), setMensaje('Tocá un paquete de la lista para marcarlo.'))
      if (seleccion === t.paquete) return (setEstado('ok'), setMensaje(undefined))
      setEstado('mal')
      setMensaje(`El paquete ${seleccion} no es. Mirá el detalle de los que están cerca.`)
    }
  }
  return (
    <div className="space-y-2 rounded-lg border border-line p-3 text-sm">
      <div className="font-semibold">
        Tarea {i + 1}: <span className="font-normal">{renderInline(t.consigna)}</span>
      </div>
      {t.tipo === 'pregunta' ? (
        <div className="flex flex-col gap-1.5">
          {orden.map((k) => ({ o: t.opciones[k], k })).map(({ o, k }) => (
            <button
              key={k}
              type="button"
              disabled={estado === 'ok'}
              onClick={() => {
                setElegida(k)
                setEstado(k === t.correcta ? 'ok' : 'mal')
              }}
              className={cn('min-h-9 rounded-lg border px-3 py-1.5 text-left', elegida === k ? (k === t.correcta ? 'border-ok bg-ok-soft' : 'border-bad bg-bad-soft') : 'border-line hover:bg-surface-2')}
            >
              {renderInline(o)}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={comprobar} disabled={estado === 'ok'}>
            {t.tipo === 'filtro' ? 'Comprobar el filtro aplicado' : `Comprobar el paquete marcado${seleccion !== undefined ? ` (${seleccion})` : ''}`}
          </Button>
          {t.pista && estado === 'mal' && <span className="text-xs text-muted">Pista: {t.pista}</span>}
        </div>
      )}
      {estado === 'ok' && <Feedback ok titulo="¡Bien!" pasos={t.explicacion ? [t.explicacion] : t.tipo === 'filtro' ? [`Una solución posible: ${t.solucion}`] : []} />}
      {estado === 'mal' && t.tipo === 'pregunta' && <Feedback ok={false} titulo="No es esa." pasos={['Volvé a mirar la captura y probá otra vez.']} />}
      {estado === 'mal' && mensaje && <p className="text-bad" role="status">{mensaje}</p>}
    </div>
  )
}

/** Visor de capturas tipo Wireshark: lista, filtros de visualización, detalle por capas y seguir conversación TCP. */
export function CaptureViewer({ ejercicio }: { ejercicio?: CapturaExercise }) {
  const [escId, setEscId] = useState(ejercicio?.escenario ?? 'visita-web')
  const esc = useMemo(() => escenario(escId)!, [escId])
  const [texto, setTexto] = useState('')
  const [aplicado, setAplicado] = useState('')
  const [sel, setSel] = useState<number>()
  const [seguir, setSeguir] = useState<number>()
  const [estados, setEstados] = useState<Estado[]>(() => (ejercicio?.tareas ?? []).map(() => undefined))
  const live = compile(texto)
  const filtrado = useMemo(() => {
    const c = compile(aplicado)
    return c.pred ? esc.paquetes.filter(c.pred) : esc.paquetes
  }, [aplicado, esc])
  const p = sel !== undefined ? esc.paquetes[sel - 1] : undefined
  const conv = seguir !== undefined ? seguirTcp(esc.paquetes, seguir) : undefined
  const aplicar = (v = texto) => {
    if (compile(v).error) return
    setTexto(v)
    setAplicado(v)
  }
  const cambiar = (id: string) => {
    setEscId(id)
    setSel(undefined)
    setSeguir(undefined)
    setTexto('')
    setAplicado('')
  }
  const hechas = estados.filter((e) => e === 'ok').length

  return (
    <Frame
      className="[font-variant-ligatures:none]"
      titulo={ejercicio?.titulo ?? 'Visor de capturas'}
      acciones={
        !ejercicio &&
        ESCENARIOS.map((id) => (
          <Chip key={id} active={id === escId} onClick={() => cambiar(id)}>
            {escenario(id)!.titulo}
          </Chip>
        ))
      }
    >
      <div className="space-y-3">
        <RichText text={ejercicio?.introduccion ?? esc.descripcion} className="text-sm text-muted" />
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            aplicar()
          }}
        >
          <label className="sr-only" htmlFor={`filtro-${escId}`}>
            Filtro de visualización
          </label>
          <input
            id={`filtro-${escId}`}
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            placeholder="Filtro de visualización, por ejemplo: dns || arp"
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            list={`campos-${escId}`}
            aria-invalid={!!live.error}
            className={cn('min-h-10 min-w-0 flex-1 basis-56 rounded-lg border px-3 font-mono text-sm', !texto.trim() ? 'border-line bg-bg' : live.error ? 'border-bad bg-bad-soft' : 'border-ok bg-ok-soft')}
          />
          <datalist id={`campos-${escId}`}>
            {DISPLAY_FIELDS.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          <Button type="submit" disabled={!!live.error}>
            Aplicar
          </Button>
          {aplicado && (
            <Button variant="secondary" onClick={() => aplicar('')}>
              Limpiar
            </Button>
          )}
        </form>
        {texto.trim() && live.error && (
          <p className="text-xs text-bad" role="status">
            {live.error}
          </p>
        )}
        {!ejercicio && (
          <div className="flex flex-wrap gap-1.5 text-xs">
            <span className="text-muted">Probá:</span>
            {SUGERIDOS.map((s) => (
              <button key={s} type="button" className="rounded border border-line px-1.5 py-0.5 font-mono hover:bg-surface-2" onClick={() => aplicar(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        <div className="max-h-72 overflow-auto rounded-lg border border-line">
          <table className="w-full min-w-[640px] border-collapse font-mono text-xs">
            <caption className="sr-only">Paquetes de la captura {esc.titulo}</caption>
            <thead className="sticky top-0 bg-surface text-left">
              <tr className="border-b border-line">
                {['N.º', 'Tiempo', 'Origen', 'Destino', 'Protocolo', 'Largo', 'Info'].map((h) => (
                  <th key={h} scope="col" className="px-2 py-1 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtrado.map((x) => (
                <tr
                  key={x.n}
                  tabIndex={0}
                  aria-selected={sel === x.n}
                  onClick={() => setSel(x.n)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setSel(x.n)
                    }
                  }}
                  className={cn('cursor-pointer border-b border-line/50 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]', rowTone(x), sel === x.n && 'outline outline-2 -outline-offset-2 outline-[var(--accent)]')}
                >
                  <td className="px-2 py-0.5 text-right">{x.n}</td>
                  <td className="px-2 py-0.5">{x.t.toFixed(6)}</td>
                  <td className="px-2 py-0.5">{x.ip?.src ?? x.arp?.sha ?? x.eth.src}</td>
                  <td className="px-2 py-0.5">{x.ip?.dst ?? (x.arp ? (x.eth.dst === 'ff:ff:ff:ff:ff:ff' ? 'Broadcast' : x.arp.tha) : x.eth.dst)}</td>
                  <td className="px-2 py-0.5">{protocolo(x)}</td>
                  <td className="px-2 py-0.5 text-right">{x.size}</td>
                  <td className="whitespace-nowrap px-2 py-0.5">{info(x)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!filtrado.length && <p className="p-3 text-sm text-muted">Ningún paquete coincide con el filtro.</p>}
        </div>
        <p className="text-xs text-muted" aria-live="polite">
          Mostrados: {filtrado.length} de {esc.paquetes.length}
          {aplicado && <> · filtro: <code>{aplicado}</code></>}
        </p>
        {p ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm font-semibold">Detalle del paquete {p.n}</h4>
              {p.tcp && (
                <Button variant="secondary" onClick={() => setSeguir(seguir === p.tcp!.stream ? undefined : p.tcp!.stream)}>
                  {seguir === p.tcp.stream ? 'Cerrar la conversación' : 'Seguir la conversación TCP'}
                </Button>
              )}
              {p.tcp && (
                <Button variant="secondary" onClick={() => aplicar(`tcp.stream == ${p.tcp!.stream}`)}>
                  Filtrar esta conversación
                </Button>
              )}
            </div>
            <div className="space-y-1 rounded-lg border border-line p-2 font-mono text-xs">
              {detalle(p).map((s, k) => (
                <details key={`${p.n}-${k}`} open={k >= 2}>
                  <summary className="cursor-pointer [overflow-wrap:anywhere]">{s.titulo}</summary>
                  <ul className="ml-5 space-y-0.5 text-muted">
                    {s.lineas.map((l, j) => (
                      <li key={j} className="[overflow-wrap:anywhere]">
                        {l}
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted">Tocá un paquete para ver sus capas.</p>
        )}
        {conv && (
          <div className="rounded-lg border border-line p-2">
            <h4 className="mb-1 text-sm font-semibold">Conversación TCP {seguir} (cliente {conv.cliente})</h4>
            <div className="max-h-60 space-y-1 overflow-auto font-mono text-xs">
              {conv.lineas.length ? (
                conv.lineas.map((l, k) => (
                  <pre key={k} className={cn('whitespace-pre-wrap rounded px-2 py-1 [overflow-wrap:anywhere]', l.de === 'cliente' ? 'bg-bad-soft' : 'bg-info-soft')}>
                    {l.texto}
                  </pre>
                ))
              ) : (
                <p className="text-muted">Esta conversación no tiene datos: solo el saludo y el cierre.</p>
              )}
            </div>
            <p className="mt-1 text-xs text-muted">En rojo lo que mandó el cliente; en azul lo que contestó el servidor (como en Wireshark).</p>
          </div>
        )}
        {ejercicio && ejercicio.tareas.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-semibold">
              Tareas ({hechas} de {ejercicio.tareas.length})
            </h4>
            {ejercicio.tareas.map((t, i) => (
              <Tarea key={i} t={t} i={i} pkts={esc.paquetes} aplicado={aplicado} seleccion={sel} estado={estados[i]} setEstado={(e) => setEstados((s) => s.map((x, j) => (j === i ? e : x)))} />
            ))}
            {hechas === ejercicio.tareas.length && <Feedback ok titulo="¡Terminaste todas las tareas de esta captura!" pasos={[]} />}
          </div>
        )}
      </div>
    </Frame>
  )
}
