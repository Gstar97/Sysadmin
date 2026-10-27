import { useState, type ReactNode } from 'react'
import { formatIpv4, networkOf, parseIpv4, prefixToMask } from '@/engines/network/ip'
import { defaultVlanName, isSwitch, newPort, shortIfName, type Device, type Network, type Port } from '@/engines/network/model'
import { parseVlanList } from '@/engines/network/ios'
import { cn } from '@/lib/cn'
import { Button, Icon } from '@/ui'
import { DeviceIcon, deviceLabel } from './DeviceIcon'
import { cidrText, parseCidrInput } from './util'

interface Props {
  net: Network
  dev: Device
  editable: boolean
  onChange: () => void
  onDelete?: () => void
  onConsole?: () => void
  config?: string
}

const input = 'min-h-9 rounded-lg border border-line bg-bg px-2 text-sm disabled:opacity-60'

/** Campo de texto que valida al salir (o con Enter) y solo guarda valores correctos. */
function Field({
  value,
  onCommit,
  validate,
  placeholder,
  disabled,
  className,
  label,
}: {
  value: string
  onCommit: (v: string) => void
  validate: (v: string) => string | undefined
  placeholder?: string
  disabled?: boolean
  className?: string
  label: string
}) {
  const [text, setText] = useState(value)
  const [error, setError] = useState<string>()
  const commit = () => {
    if (text === value) return
    const e = validate(text)
    setError(e)
    if (!e) onCommit(text)
  }
  return (
    <span className="inline-flex flex-col">
      <input
        aria-label={label}
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value)
          setError(undefined)
        }}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        className={cn(input, 'font-mono', error && 'border-bad', className)}
        spellCheck={false}
        autoCapitalize="off"
        aria-invalid={!!error}
      />
      {error && <span className="mt-0.5 text-xs text-bad">{error}</span>}
    </span>
  )
}

const validCidr = (v: string) => (!v.trim() || parseCidrInput(v) ? undefined : 'Usa el formato 192.168.1.10/24')
const validIp = (v: string) => (!v.trim() || parseIpv4(v) !== undefined ? undefined : 'Dirección IPv4 inválida')

function Section({ title, children, open = true }: { title: string; children: ReactNode; open?: boolean }) {
  return (
    <details open={open} className="rounded-lg border border-line">
      <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">{title}</summary>
      <div className="space-y-2 px-3 pb-3">{children}</div>
    </details>
  )
}

function peerText(net: Network, d: Device, p: Port) {
  const peer = net.linkOf(d.id, p.name)
  return peer ? `${peer.dev.hostname} ${shortIfName(peer.port.name)}` : 'sin cable'
}

function setIp(p: Port, v: string) {
  p.ip = v.trim() ? parseCidrInput(v) : undefined
}

export function DeviceForm({ net, dev, editable, onChange, onDelete, onConsole, config }: Props) {
  const [showAll, setShowAll] = useState(false)
  const update = (fn: () => void) => {
    fn()
    onChange()
  }
  const phys = dev.ports.filter((p) => p.kind === 'phys')
  const visiblePorts = isSwitch(dev) && !showAll ? phys.filter((p) => net.linkOf(dev.id, p.name)) : phys
  const routing = dev.type === 'router' || dev.type === 'switch_l3'

  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <DeviceIcon type={dev.type} size={32} />
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted">{deviceLabel(dev.type)}</div>
          <Field label="Nombre del equipo" value={dev.hostname} disabled={!editable} validate={(v) => (/^[A-Za-z][\w-]{0,30}$/.test(v) ? undefined : 'Letras, números y guiones, empezando con letra')} onCommit={(v) => update(() => (dev.hostname = v))} />
        </div>
        {onConsole && (
          <Button variant="secondary" onClick={onConsole}>
            <Icon name="terminal" className="h-4 w-4" />
            Consola
          </Button>
        )}
        {onDelete && (
          <Button variant="ghost" onClick={onDelete} aria-label="Quitar equipo">
            <Icon name="trash" className="h-4 w-4" />
          </Button>
        )}
      </div>

      {(dev.type === 'pc' || dev.type === 'servidor') && (
        <Section title="Red">
          {phys.map((p) => (
            <div key={p.name} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-16 font-mono">{p.name}</span>
              <Field label={`IP de ${p.name}`} value={cidrText(p)} disabled={!editable} placeholder="192.168.1.10/24" validate={validCidr} onCommit={(v) => update(() => setIp(p, v))} />
              <span className="text-xs text-muted">{peerText(net, dev, p)}</span>
            </div>
          ))}
          <label className="flex flex-wrap items-center gap-2 text-sm">
            <span className="w-28 text-muted">Puerta de enlace</span>
            <Field label="Puerta de enlace" value={dev.gateway !== undefined ? formatIpv4(dev.gateway) : ''} disabled={!editable} placeholder="192.168.1.1" validate={validIp} onCommit={(v) => update(() => (dev.gateway = v.trim() ? parseIpv4(v) : undefined))} />
          </label>
        </Section>
      )}

      {isSwitch(dev) && (
        <Section title="VLAN">
          <div className="flex flex-wrap gap-1.5">
            {[...dev.vlans.entries()]
              .filter(([id]) => id < 1002)
              .map(([id, name]) => (
                <span key={id} className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs">
                  <span className="font-mono">{id}</span> {name}
                  {editable && id !== 1 && (
                    <button type="button" aria-label={`Borrar VLAN ${id}`} onClick={() => update(() => dev.vlans.delete(id))}>
                      <Icon name="close" className="h-3 w-3" />
                    </button>
                  )}
                </span>
              ))}
          </div>
          {editable && <AddVlan onAdd={(id, name) => update(() => dev.vlans.set(id, name || defaultVlanName(id)))} />}
        </Section>
      )}

      {dev.type !== 'pc' && dev.type !== 'servidor' && (
        <Section title="Interfaces">
          {isSwitch(dev) && (
            <label className="flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
              Mostrar también los puertos sin cable
            </label>
          )}
          {visiblePorts.length === 0 && <p className="text-sm text-muted">Ningún puerto tiene cable todavía.</p>}
          <div className="space-y-2">
            {visiblePorts.map((p) => (
              <PortRow key={p.name} net={net} dev={dev} port={p} editable={editable} update={update} />
            ))}
          </div>
        </Section>
      )}

      {isSwitch(dev) && (
        <Section title={dev.type === 'switch' ? 'Administración' : 'Interfaces VLAN (SVI) y enrutamiento'} open={dev.type === 'switch_l3'}>
          {dev.type === 'switch_l3' && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" disabled={!editable} checked={dev.ipRouting} onChange={(e) => update(() => (dev.ipRouting = e.target.checked))} />
              Enrutamiento entre VLAN activado (<code className="font-mono">ip routing</code>)
            </label>
          )}
          {dev.ports
            .filter((p) => p.kind === 'svi')
            .map((p) => (
              <div key={p.name} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="w-16 font-mono">{p.name}</span>
                <Field label={`IP de ${p.name}`} value={cidrText(p)} disabled={!editable} placeholder="192.168.10.1/24" validate={validCidr} onCommit={(v) => update(() => setIp(p, v))} />
                <label className="flex items-center gap-1 text-xs">
                  <input type="checkbox" disabled={!editable} checked={!p.shutdown} onChange={(e) => update(() => (p.shutdown = !e.target.checked))} />
                  encendida
                </label>
                <span className={cn('text-xs', net.isUp(dev, p) ? 'text-ok' : 'text-muted')}>{net.isUp(dev, p) ? 'activa' : 'inactiva'}</span>
                {editable && p.vlan !== 1 && (
                  <button type="button" aria-label={`Quitar ${p.name}`} onClick={() => update(() => (dev.ports = dev.ports.filter((x) => x !== p)))}>
                    <Icon name="trash" className="h-4 w-4 text-muted" />
                  </button>
                )}
              </div>
            ))}
          {editable && (
            <AddSvi
              onAdd={(vlan, cidr) =>
                update(() => {
                  const existing = dev.ports.find((p) => p.kind === 'svi' && p.vlan === vlan)
                  const p = existing ?? { ...newPort(`Vlan${vlan}`, 'svi', false, false), vlan }
                  p.ip = cidr
                  p.shutdown = false
                  if (!existing) dev.ports.push(p)
                })
              }
            />
          )}
          {dev.type === 'switch' && (
            <label className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted">Puerta de enlace (ip default-gateway)</span>
              <Field label="Puerta de enlace del switch" value={dev.gateway !== undefined ? formatIpv4(dev.gateway) : ''} disabled={!editable} validate={validIp} onCommit={(v) => update(() => (dev.gateway = v.trim() ? parseIpv4(v) : undefined))} />
            </label>
          )}
        </Section>
      )}

      {routing && <RoutesSection dev={dev} editable={editable} update={update} />}
      {routing && <OspfSection net={net} dev={dev} editable={editable} update={update} />}

      {config && (
        <details className="rounded-lg border border-line">
          <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">Ver la configuración equivalente (running-config)</summary>
          <pre className="max-h-80 overflow-auto px-3 pb-3 font-mono text-xs">{config}</pre>
        </details>
      )}
    </div>
  )
}

function PortRow({ net, dev, port: p, editable, update }: { net: Network; dev: Device; port: Port; editable: boolean; update: (fn: () => void) => void }) {
  const up = net.physUp(dev, p)
  const subifs = dev.ports.filter((s) => s.kind === 'subif' && s.parent === p.name)
  const l2 = isSwitch(dev) && p.switchport
  const mode = net.effectiveMode(dev, p)
  return (
    <div className="rounded-lg bg-surface-2 p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('h-2 w-2 rounded-full', up ? 'bg-ok' : 'bg-bad')} aria-label={up ? 'enlace activo' : 'enlace caído'} />
        <span className="font-mono font-medium">{shortIfName(p.name)}</span>
        <span className="text-xs text-muted">→ {peerText(net, dev, p)}</span>
        <label className="ml-auto flex items-center gap-1 text-xs">
          <input type="checkbox" disabled={!editable} checked={!p.shutdown} onChange={(e) => update(() => (p.shutdown = !e.target.checked))} />
          encendida
        </label>
      </div>
      {dev.type === 'switch_l3' && (
        <label className="mt-1 flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            disabled={!editable}
            checked={!p.switchport}
            onChange={(e) =>
              update(() => {
                p.switchport = !e.target.checked
                if (p.switchport) p.ip = undefined
              })
            }
          />
          Puerto enrutado (<code className="font-mono">no switchport</code>)
        </label>
      )}
      {l2 ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            aria-label={`Modo de ${p.name}`}
            disabled={!editable}
            className={input}
            value={p.mode ?? 'auto'}
            onChange={(e) => update(() => (p.mode = e.target.value === 'auto' ? undefined : (e.target.value as 'access' | 'trunk')))}
          >
            <option value="auto">Automático (dynamic auto) → {mode === 'trunk' ? 'troncal' : 'acceso'}</option>
            <option value="access">Acceso</option>
            <option value="trunk">Troncal</option>
          </select>
          {mode === 'access' ? (
            <label className="flex items-center gap-1 text-xs">
              VLAN
              <select aria-label={`VLAN de acceso de ${p.name}`} disabled={!editable} className={input} value={p.accessVlan} onChange={(e) => update(() => (p.accessVlan = Number(e.target.value)))}>
                {[...new Set([...dev.vlans.keys(), p.accessVlan])]
                  .filter((v) => v < 1002)
                  .sort((a, b) => a - b)
                  .map((v) => (
                    <option key={v} value={v}>
                      {v} {dev.vlans.get(v) ?? '(no existe)'}
                    </option>
                  ))}
              </select>
            </label>
          ) : (
            <>
              <label className="flex items-center gap-1 text-xs">
                Permitidas
                <Field
                  label={`VLAN permitidas en ${p.name}`}
                  value={p.allowed === 'all' ? 'todas' : p.allowed.join(',')}
                  disabled={!editable}
                  className="w-28"
                  validate={(v) => (/^\s*todas\s*$/i.test(v) || parseVlanList(v) ? undefined : 'Ej.: 10,20,30-35 o todas')}
                  onCommit={(v) => update(() => (p.allowed = /todas/i.test(v) ? 'all' : parseVlanList(v)!))}
                />
              </label>
              <label className="flex items-center gap-1 text-xs">
                Nativa
                <Field label={`VLAN nativa de ${p.name}`} value={String(p.nativeVlan)} disabled={!editable} className="w-16" validate={(v) => (/^\d+$/.test(v) && +v >= 1 && +v <= 4094 ? undefined : '1 a 4094')} onCommit={(v) => update(() => (p.nativeVlan = Number(v)))} />
              </label>
            </>
          )}
        </div>
      ) : (
        <div className="mt-2 space-y-1.5">
          <Field label={`IP de ${p.name}`} value={cidrText(p)} disabled={!editable} placeholder={subifs.length ? 'sin IP (usa subinterfaces)' : '10.0.0.1/30'} validate={validCidr} onCommit={(v) => update(() => setIp(p, v))} />
          {subifs.map((s) => (
            <div key={s.name} className="flex flex-wrap items-center gap-2 pl-3">
              <span className="font-mono text-xs">{shortIfName(s.name)}</span>
              <span className="text-xs text-muted">VLAN {s.encapVlan}</span>
              <Field label={`IP de ${s.name}`} value={cidrText(s)} disabled={!editable} validate={validCidr} onCommit={(v) => update(() => setIp(s, v))} />
              {editable && (
                <button type="button" aria-label={`Quitar ${s.name}`} onClick={() => update(() => (dev.ports = dev.ports.filter((x) => x !== s)))}>
                  <Icon name="trash" className="h-4 w-4 text-muted" />
                </button>
              )}
            </div>
          ))}
          {editable && dev.type === 'router' && (
            <AddSubif
              onAdd={(vlan, cidr) =>
                update(() => {
                  const name = `${p.name}.${vlan}`
                  if (dev.ports.some((x) => x.name === name)) return
                  dev.ports.push({ ...newPort(name, 'subif', false, false), parent: p.name, encapVlan: vlan, ip: cidr })
                })
              }
            />
          )}
        </div>
      )}
    </div>
  )
}

function AddVlan({ onAdd }: { onAdd: (id: number, name: string) => void }) {
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const valid = /^\d+$/.test(id) && +id >= 2 && +id <= 1001
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (!valid) return
        onAdd(Number(id), name.trim().replace(/\s+/g, '_').toUpperCase())
        setId('')
        setName('')
      }}
    >
      <input aria-label="Número de VLAN" className={cn(input, 'w-20 font-mono')} placeholder="10" value={id} onChange={(e) => setId(e.target.value)} inputMode="numeric" />
      <input aria-label="Nombre de VLAN" className={cn(input, 'w-36')} placeholder="VENTAS" value={name} onChange={(e) => setName(e.target.value)} />
      <Button type="submit" variant="secondary" disabled={!valid}>
        Agregar VLAN
      </Button>
    </form>
  )
}

function AddSvi({ onAdd }: { onAdd: (vlan: number, cidr: { ip: number; prefix: number }) => void }) {
  const [vlan, setVlan] = useState('')
  const [ip, setIpText] = useState('')
  const cidr = parseCidrInput(ip)
  const valid = /^\d+$/.test(vlan) && +vlan >= 1 && +vlan <= 4094 && !!cidr
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (!valid) return
        onAdd(Number(vlan), cidr!)
        setVlan('')
        setIpText('')
      }}
    >
      <input aria-label="VLAN de la interfaz" className={cn(input, 'w-20 font-mono')} placeholder="VLAN" value={vlan} onChange={(e) => setVlan(e.target.value)} inputMode="numeric" />
      <input aria-label="IP de la interfaz VLAN" className={cn(input, 'w-40 font-mono')} placeholder="192.168.10.1/24" value={ip} onChange={(e) => setIpText(e.target.value)} />
      <Button type="submit" variant="secondary" disabled={!valid}>
        Agregar interfaz VLAN
      </Button>
    </form>
  )
}

function AddSubif({ onAdd }: { onAdd: (vlan: number, cidr: { ip: number; prefix: number }) => void }) {
  const [vlan, setVlan] = useState('')
  const [ip, setIpText] = useState('')
  const cidr = parseCidrInput(ip)
  const valid = /^\d+$/.test(vlan) && +vlan >= 1 && +vlan <= 4094 && !!cidr
  return (
    <form
      className="flex flex-wrap items-center gap-2 pl-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (!valid) return
        onAdd(Number(vlan), cidr!)
        setVlan('')
        setIpText('')
      }}
    >
      <input aria-label="VLAN de la subinterfaz" className={cn(input, 'w-20 font-mono')} placeholder="VLAN" value={vlan} onChange={(e) => setVlan(e.target.value)} inputMode="numeric" />
      <input aria-label="IP de la subinterfaz" className={cn(input, 'w-40 font-mono')} placeholder="192.168.10.1/24" value={ip} onChange={(e) => setIpText(e.target.value)} />
      <Button type="submit" variant="ghost" disabled={!valid}>
        + Subinterfaz (router-on-a-stick)
      </Button>
    </form>
  )
}

function RoutesSection({ dev, editable, update }: { dev: Device; editable: boolean; update: (fn: () => void) => void }) {
  const [dest, setDest] = useState('')
  const [via, setVia] = useState('')
  const d = parseCidrInput(dest)
  const v = parseIpv4(via)
  return (
    <Section title="Rutas estáticas" open={dev.routes.length > 0}>
      {dev.routes.length === 0 && <p className="text-sm text-muted">Sin rutas estáticas.</p>}
      {dev.routes.map((r, i) => (
        <div key={i} className="flex items-center gap-2 font-mono text-sm">
          <span>
            {formatIpv4(r.net)}/{r.prefix} → {r.exitIf ?? formatIpv4(r.via!)}
          </span>
          {editable && (
            <button type="button" aria-label="Quitar ruta" onClick={() => update(() => dev.routes.splice(i, 1))}>
              <Icon name="trash" className="h-4 w-4 text-muted" />
            </button>
          )}
        </div>
      ))}
      {editable && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!d || v === undefined) return
            update(() => dev.routes.push({ net: networkOf(d.ip, d.prefix), prefix: d.prefix, via: v, distance: 1 }))
            setDest('')
            setVia('')
          }}
        >
          <input aria-label="Red de destino" className={cn(input, 'w-40 font-mono')} placeholder="10.0.2.0/24 o 0.0.0.0/0" value={dest} onChange={(e) => setDest(e.target.value)} />
          <input aria-label="Siguiente salto" className={cn(input, 'w-32 font-mono')} placeholder="siguiente salto" value={via} onChange={(e) => setVia(e.target.value)} />
          <Button type="submit" variant="secondary" disabled={!d || v === undefined}>
            Agregar ruta
          </Button>
        </form>
      )}
    </Section>
  )
}

function OspfSection({ net, dev, editable, update }: { net: Network; dev: Device; editable: boolean; update: (fn: () => void) => void }) {
  const [network, setNetwork] = useState('')
  const [area, setArea] = useState('0')
  const parsed = parseCidrInput(network)
  const o = dev.ospf
  const neighbors = o ? net.ospfNeighbors(dev) : []
  return (
    <Section title="OSPF" open={!!o}>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          disabled={!editable}
          checked={!!o}
          onChange={(e) =>
            update(() => {
              dev.ospf = e.target.checked ? { pid: 1, networks: [], passive: new Set(), passiveDefault: false, notPassive: new Set(), defaultOriginate: false } : undefined
            })
          }
        />
        OSPF activado (proceso 1)
      </label>
      {o && (
        <>
          <div className="text-xs text-muted">
            Router ID: {net.routerId(dev) !== undefined ? formatIpv4(net.routerId(dev)!) : 'ninguno'} · Vecinos: {neighbors.length ? neighbors.map((n) => n.dev.hostname).join(', ') : 'ninguno'}
          </div>
          {o.networks.map((n, i) => (
            <div key={i} className="flex items-center gap-2 font-mono text-sm">
              network {formatIpv4(n.net)} {formatIpv4(n.wildcard)} area {n.area}
              {editable && (
                <button type="button" aria-label="Quitar red de OSPF" onClick={() => update(() => o.networks.splice(i, 1))}>
                  <Icon name="trash" className="h-4 w-4 text-muted" />
                </button>
              )}
            </div>
          ))}
          {editable && (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                if (!parsed) return
                const wildcard = ~prefixToMask(parsed.prefix) >>> 0
                update(() => o.networks.push({ net: networkOf(parsed.ip, parsed.prefix), wildcard, area: Number(area) || 0 }))
                setNetwork('')
              }}
            >
              <input aria-label="Red a anunciar" className={cn(input, 'w-40 font-mono')} placeholder="10.0.0.0/30" value={network} onChange={(e) => setNetwork(e.target.value)} />
              <input aria-label="Área" className={cn(input, 'w-16 font-mono')} value={area} onChange={(e) => setArea(e.target.value)} inputMode="numeric" />
              <Button type="submit" variant="secondary" disabled={!parsed}>
                Anunciar red
              </Button>
            </form>
          )}
          <div className="flex flex-wrap gap-3 text-xs">
            <span className="text-muted">Interfaces pasivas:</span>
            {dev.ports
              .filter((p) => p.ip)
              .map((p) => (
                <label key={p.name} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    disabled={!editable}
                    checked={net.isPassive(dev, p)}
                    onChange={(e) =>
                      update(() => {
                        if (o.passiveDefault) {
                          if (e.target.checked) o.notPassive.delete(p.name)
                          else o.notPassive.add(p.name)
                        } else if (e.target.checked) o.passive.add(p.name)
                        else o.passive.delete(p.name)
                      })
                    }
                  />
                  <span className="font-mono">{shortIfName(p.name)}</span>
                </label>
              ))}
          </div>
        </>
      )}
    </Section>
  )
}
