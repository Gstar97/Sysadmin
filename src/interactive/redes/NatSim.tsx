import { useState } from 'react'
import { inbound, newNat, outbound, type NatState } from '@/engines/redes/nat'
import { Button } from '@/ui'
import { Chip, Frame, inputClass } from '../fundamentos/Frame'
import { cn } from '@/lib/cn'

const INSIDE = [
  { ip: '192.168.1.10', nombre: 'Notebook de Ana' },
  { ip: '192.168.1.11', nombre: 'PC de Luis' },
  { ip: '192.168.1.20', nombre: 'Servidor web' },
]
const SITES = [
  { dest: '142.250.78.14:443', nombre: 'buscador (HTTPS)', proto: 'TCP' as const },
  { dest: '185.125.190.20:443', nombre: 'actualizaciones (HTTPS)', proto: 'TCP' as const },
  { dest: '1.1.1.1:53', nombre: 'DNS público', proto: 'UDP' as const },
]

/** Tabla de traducciones NAT/PAT de un router, con redirección de puertos y CGNAT. */
export function NatSim() {
  const [cgnat, setCgnat] = useState(false)
  const [state, setState] = useState<NatState>(() => newNat('203.0.113.7'))
  const [log, setLog] = useState<{ ok: boolean; text: string }[]>([])
  const [host, setHost] = useState(INSIDE[0].ip)
  const [site, setSite] = useState(0)
  const [port, setPort] = useState(50123)
  const [inPort, setInPort] = useState(443)
  const push = (ok: boolean, text: string) => setLog((l) => [{ ok, text }, ...l].slice(0, 6))
  const toggleCgnat = () => {
    const next = !cgnat
    setCgnat(next)
    const s = next ? newNat('100.72.14.9', '181.30.2.2') : newNat('203.0.113.7')
    setState({ ...s, redirecciones: state.redirecciones })
    setLog([])
  }
  const hasFwd = state.redirecciones.some((r) => r.puerto === 443)
  return (
    <Frame
      titulo="NAT y PAT en el router"
      acciones={
        <Chip active={cgnat} onClick={toggleCgnat}>
          El proveedor usa CGNAT
        </Chip>
      }
    >
      <div className="space-y-4">
        <p className="text-sm">
          Red interna 192.168.1.0/24 · WAN del router: <b className="font-mono">{state.wan}</b>
          {cgnat && (
            <>
              {' '}
              (detrás del CGNAT del proveedor, que sale a internet como <b className="font-mono">{state.publica}</b>)
            </>
          )}
        </p>
        <div className="rounded-lg border border-line p-3">
          <h4 className="mb-2 text-sm font-semibold">1. Un equipo de adentro abre una conexión</h4>
          <div className="flex flex-wrap items-end gap-2 text-sm">
            <label>
              <span className="block text-muted">Equipo</span>
              <select className="min-h-10 rounded-lg border border-line bg-bg px-2" value={host} onChange={(e) => setHost(e.target.value)}>
                {INSIDE.map((h) => (
                  <option key={h.ip} value={h.ip}>
                    {h.nombre} ({h.ip})
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="block text-muted">Puerto de origen</span>
              <input type="number" className={cn(inputClass, 'w-28')} value={port} min={1024} max={65535} onChange={(e) => setPort(Number(e.target.value))} />
            </label>
            <label>
              <span className="block text-muted">Hacia</span>
              <select className="min-h-10 rounded-lg border border-line bg-bg px-2" value={site} onChange={(e) => setSite(Number(e.target.value))}>
                {SITES.map((s, i) => (
                  <option key={s.dest} value={i}>
                    {s.nombre} {s.dest}
                  </option>
                ))}
              </select>
            </label>
            <Button
              onClick={() => {
                const r = outbound(state, host, port, SITES[site].dest, SITES[site].proto)
                setState(r.state)
                push(true, r.explicacion + (cgnat ? ` Después, el CGNAT del proveedor vuelve a traducir ${r.entry.externo} a ${state.publica}: es un NAT doble.` : ''))
              }}
            >
              Conectar
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted">Prueba conectar dos equipos con el mismo puerto de origen: el router tiene que cambiar uno.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-xs">
            <caption className="mb-1 text-left text-sm font-semibold">Tabla de traducciones</caption>
            <thead>
              <tr className="text-left text-muted">
                <th className="p-1 font-medium">Proto</th>
                <th className="p-1 font-medium">Adentro (IP:puerto)</th>
                <th className="p-1 font-medium">Afuera (IP:puerto)</th>
                <th className="p-1 font-medium">Destino</th>
              </tr>
            </thead>
            <tbody>
              {state.tabla.length === 0 && (
                <tr>
                  <td colSpan={4} className="p-1 text-muted">
                    Vacía: todavía nadie salió a internet.
                  </td>
                </tr>
              )}
              {state.tabla.map((e, i) => (
                <tr key={i} className="border-t border-line font-mono">
                  <td className="p-1">{e.proto}</td>
                  <td className="p-1">{e.interno}</td>
                  <td className="p-1">{e.externo}</td>
                  <td className="p-1">{e.destino}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="rounded-lg border border-line p-3">
          <h4 className="mb-2 text-sm font-semibold">2. Alguien de internet intenta entrar</h4>
          <div className="flex flex-wrap items-end gap-2 text-sm">
            <Button
              variant={hasFwd ? 'secondary' : 'primary'}
              onClick={() => {
                setState({ ...state, redirecciones: hasFwd ? state.redirecciones.filter((r) => r.puerto !== 443) : [...state.redirecciones, { proto: 'TCP', puerto: 443, hacia: '192.168.1.20:443' }] })
              }}
            >
              {hasFwd ? 'Quitar la redirección 443 → servidor web' : 'Crear redirección: TCP 443 → 192.168.1.20:443'}
            </Button>
            <label>
              <span className="block text-muted">Puerto al que llega</span>
              <input type="number" className={cn(inputClass, 'w-24')} value={inPort} min={1} max={65535} onChange={(e) => setInPort(Number(e.target.value))} />
            </label>
            <Button
              variant="secondary"
              onClick={() => {
                const r = inbound(state, inPort)
                push(r.ok, r.explicacion)
              }}
            >
              Conectar desde internet
            </Button>
          </div>
        </div>
        <ol className="space-y-2" aria-live="polite">
          {log.map((l, i) => (
            <li key={log.length - i} className={cn('rounded-lg border p-2 text-sm', l.ok ? 'border-ok bg-ok-soft' : 'border-bad bg-bad-soft', i > 0 && 'opacity-70')}>
              {l.text}
            </li>
          ))}
        </ol>
      </div>
    </Frame>
  )
}
