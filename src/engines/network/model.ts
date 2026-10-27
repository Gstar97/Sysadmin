/**
 * Modelo de red simulado: equipos, interfaces, enlaces, VLAN, troncales, enrutamiento estático y OSPF.
 * Lo usan la consola tipo Cisco IOS, el armador de topologías y el simulador de paquetes.
 */
import { broadcastOf, formatIpv4, networkOf, parseCidr, parseIpv4, prefixToMask, sameSubnet } from './ip'
import type { DeviceSpec, DeviceType, TopologySpec } from './schema'

export interface IpAddr {
  ip: number
  prefix: number
}

export type PortKind = 'phys' | 'subif' | 'svi' | 'loopback'

export interface Port {
  name: string
  kind: PortKind
  ip?: IpAddr
  shutdown: boolean
  description?: string
  /** Puerto de capa 2 (switchport). En un switch L3, "no switchport" lo vuelve puerto enrutado. */
  switchport: boolean
  /** undefined = dynamic auto (valor de fábrica en Catalyst). */
  mode?: 'access' | 'trunk'
  accessVlan: number
  allowed: 'all' | number[]
  nativeVlan: number
  /** Subinterfaces: interfaz física de la que dependen y VLAN de encapsulación 802.1Q. */
  parent?: string
  encapVlan?: number
  /** Interfaces VLAN (SVI). */
  vlan?: number
}

export interface StaticRoute {
  net: number
  prefix: number
  via?: number
  exitIf?: string
  distance: number
}

export interface OspfConfig {
  pid: number
  routerId?: number
  networks: { net: number; wildcard: number; area: number }[]
  passive: Set<string>
  /** "passive-interface default": todas pasivas salvo las de notPassive. */
  passiveDefault: boolean
  notPassive: Set<string>
  defaultOriginate: boolean
}

export interface Device {
  id: string
  type: DeviceType
  hostname: string
  x: number
  y: number
  ports: Port[]
  gateway?: number
  vlans: Map<number, string>
  routes: StaticRoute[]
  ipRouting: boolean
  ospf?: OspfConfig
  blocked: boolean
  /** IP aprendida por ARP → id del equipo que respondió. */
  arp: Map<number, string>
  /** Direcciones a las que se reenvían los DHCP (ip helper-address), por interfaz. */
  helpers: Map<string, number[]>
  /** Configuración de administración (la usa la consola IOS). */
  mgmt: {
    enableSecret?: string
    enablePassword?: string
    passwordEncryption: boolean
    banner?: string
    domainLookup: boolean
    domainName?: string
    users: Map<string, string>
    lines: Record<'con' | 'vty', { password?: string; login: 'none' | 'line' | 'local'; transport?: string }>
    startup?: string
    rsaBits?: number
    sshVersion?: number
  }
}

export interface Link {
  a: { dev: string; port: string }
  b: { dev: string; port: string }
}

export interface Route {
  code: 'C' | 'L' | 'S' | 'O' | 'O IA' | 'O*E2' | 'S*'
  net: number
  prefix: number
  nextHop?: number
  port?: string
  distance: number
  metric: number
}

export interface L2Endpoint {
  dev: Device
  port: Port
  /** Equipos atravesados desde el origen hasta este punto (incluye switches). */
  trail: string[]
}

export interface Hop {
  from: string
  fromPort: string
  to: string
  toPort: string
  /** Switches atravesados en el camino de capa 2. */
  via: string[]
  vlan?: number
}

export interface PingResult {
  ok: boolean
  source?: number
  target?: number
  forward: Hop[]
  back: Hop[]
  /** Explicación en lenguaje claro de por qué falló. */
  reason?: string
  /** Equipo donde se cortó el camino. */
  failedAt?: string
  /** El router intermedio devolvió "destino inalcanzable" (en IOS se ve como U). */
  unreachable?: boolean
}

// ---------------------------------------------------------------------------------------
// Nombres de interfaz
// ---------------------------------------------------------------------------------------

const IF_TYPES: [string, string, string, string][] = [
  // [nombre completo en minúsculas, nombre canónico, abreviatura corta, abreviatura de "show interfaces trunk"]
  ['gigabitethernet', 'GigabitEthernet', 'Gi', 'Gig'],
  ['fastethernet', 'FastEthernet', 'Fa', 'Fa'],
  ['tengigabitethernet', 'TenGigabitEthernet', 'Te', 'Ten'],
  ['ethernet', 'Ethernet', 'Et', 'Eth'],
  ['serial', 'Serial', 'Se', 'Ser'],
  ['loopback', 'Loopback', 'Lo', 'Lo'],
  ['vlan', 'Vlan', 'Vl', 'Vlan'],
  ['port-channel', 'Port-channel', 'Po', 'Po'],
]

/** Normaliza un nombre de interfaz ("g0/1", "gi 0/1", "GigabitEthernet0/1") a su forma canónica. */
export function normalizeIfName(name: string, type?: DeviceType): string | undefined {
  const raw = name.trim()
  if ((type === 'pc' || type === 'servidor') && /^[a-z]+\d*$/i.test(raw)) return raw.toLowerCase()
  const m = /^([a-z-]+)\s*(\d+(?:\/\d+)*(?:\.\d+)?)$/i.exec(raw)
  if (!m) return undefined
  const typed = m[1].toLowerCase()
  const t = IF_TYPES.find(([full]) => full.startsWith(typed))
  return t ? `${t[1]}${m[2]}` : undefined
}

export function shortIfName(name: string, style: 'short' | 'trunk' | 'cdp' = 'short'): string {
  const t = IF_TYPES.find(([, canon]) => name.startsWith(canon) && /^\d/.test(name.slice(canon.length)))
  if (!t) return name
  const num = name.slice(t[1].length)
  if (style === 'trunk') return `${t[3]}${num}`
  if (style === 'cdp') return `${t[3].length === 2 ? t[3] + 's' : t[3]} ${num}`
  return `${t[2]}${num}`
}

function defaultPorts(type: DeviceType, spec: DeviceSpec): string[] {
  switch (type) {
    case 'pc':
    case 'servidor':
      return ['eth0']
    case 'router':
      return spec.interfaces.some((i) => /\d+\/\d+\/\d+/.test(i.nombre))
        ? ['GigabitEthernet0/0/0', 'GigabitEthernet0/0/1', 'GigabitEthernet0/0/2']
        : ['GigabitEthernet0/0', 'GigabitEthernet0/1', 'GigabitEthernet0/2']
    case 'switch':
      return [...Array.from({ length: 24 }, (_, i) => `FastEthernet0/${i + 1}`), 'GigabitEthernet0/1', 'GigabitEthernet0/2']
    case 'switch_l3':
      return [...Array.from({ length: 24 }, (_, i) => `GigabitEthernet1/0/${i + 1}`), ...Array.from({ length: 4 }, (_, i) => `GigabitEthernet1/1/${i + 1}`)]
  }
}

export function isSwitch(d: Device) {
  return d.type === 'switch' || d.type === 'switch_l3'
}

export function isHost(d: Device) {
  return d.type === 'pc' || d.type === 'servidor'
}

/** Equipo que enruta paquetes entre redes. */
export function isRouting(d: Device) {
  return d.type === 'router' || (d.type === 'switch_l3' && d.ipRouting)
}

export function newPort(name: string, kind: PortKind, switchport: boolean, shutdown: boolean): Port {
  return { name, kind, shutdown, switchport, accessVlan: 1, allowed: 'all', nativeVlan: 1 }
}

export function defaultVlanName(id: number) {
  return id === 1 ? 'default' : `VLAN${String(id).padStart(4, '0')}`
}

const RESERVED_VLANS: [number, string][] = [
  [1002, 'fddi-default'],
  [1003, 'token-ring-default'],
  [1004, 'fddinet-default'],
  [1005, 'trnet-default'],
]

function cidr(text: string): IpAddr {
  const c = parseCidr(text)
  if (!c) throw new Error(`Dirección inválida: ${text}`)
  return c
}

// ---------------------------------------------------------------------------------------
// Red
// ---------------------------------------------------------------------------------------

export class Network {
  devices = new Map<string, Device>()
  links: Link[] = []

  constructor(spec: TopologySpec) {
    for (const d of spec.dispositivos) this.addDevice(d)
    for (const l of spec.enlaces) {
      const [ad, ap] = splitEndpoint(l.a)
      const [bd, bp] = splitEndpoint(l.b)
      const da = this.device(ad)
      const db = this.device(bd)
      if (!da || !db) continue
      const pa = normalizeIfName(ap, da.type) ?? ap
      const pb = normalizeIfName(bp, db.type) ?? bp
      this.ensurePort(da, pa)
      this.ensurePort(db, pb)
      this.links.push({ a: { dev: da.id, port: pa }, b: { dev: db.id, port: pb } })
    }
  }

  addDevice(spec: DeviceSpec): Device {
    const sw = spec.tipo === 'switch' || spec.tipo === 'switch_l3'
    const d: Device = {
      id: spec.id,
      type: spec.tipo,
      hostname: spec.nombre ?? spec.id,
      x: spec.x,
      y: spec.y,
      ports: defaultPorts(spec.tipo, spec).map((n) => newPort(n, 'phys', sw, spec.tipo === 'router')),
      gateway: spec.puerta_enlace ? parseIpv4(spec.puerta_enlace) : undefined,
      vlans: new Map(sw ? [[1, 'default'], ...RESERVED_VLANS] : []),
      routes: spec.rutas.map((r) => {
        const c = cidr(r.destino)
        return { net: networkOf(c.ip, c.prefix), prefix: c.prefix, via: parseIpv4(r.via), distance: 1 }
      }),
      ipRouting: spec.tipo === 'router' || (spec.tipo === 'switch_l3' && spec.enrutamiento === true),
      blocked: spec.bloqueado,
      arp: new Map(),
      helpers: new Map(),
      mgmt: {
        passwordEncryption: false,
        domainLookup: true,
        users: new Map(),
        lines: { con: { login: 'none' }, vty: { login: 'none' } },
      },
    }
    if (sw) d.ports.push({ ...newPort('Vlan1', 'svi', false, true), vlan: 1 })
    for (const v of spec.vlans) d.vlans.set(v.id, v.nombre ?? defaultVlanName(v.id))
    for (const i of spec.interfaces) {
      const name = normalizeIfName(i.nombre, spec.tipo) ?? i.nombre
      const p = this.ensurePort(d, name)
      if (i.ip) {
        p.ip = cidr(i.ip)
        if (spec.tipo === 'switch_l3' && p.kind === 'phys') p.switchport = false
      }
      p.shutdown = i.apagada
      if (i.modo) p.mode = i.modo === 'acceso' ? 'access' : 'trunk'
      if (i.vlan) p.accessVlan = i.vlan
      if (i.vlans_permitidas) p.allowed = i.vlans_permitidas === 'todas' ? 'all' : [...i.vlans_permitidas].sort((a, b) => a - b)
      if (i.vlan_nativa) p.nativeVlan = i.vlan_nativa
      if (i.descripcion) p.description = i.descripcion
      for (const s of i.subinterfaces) {
        const subName = normalizeIfName(s.nombre, spec.tipo) ?? s.nombre
        d.ports.push({ ...newPort(subName, 'subif', false, false), parent: name, encapVlan: s.vlan, ip: cidr(s.ip) })
      }
    }
    for (const s of spec.svis) {
      const existing = d.ports.find((p) => p.kind === 'svi' && p.vlan === s.vlan)
      if (existing) {
        existing.ip = cidr(s.ip)
        existing.shutdown = false
      } else d.ports.push({ ...newPort(`Vlan${s.vlan}`, 'svi', false, false), vlan: s.vlan, ip: cidr(s.ip) })
    }
    if (spec.ospf) {
      d.ospf = {
        pid: spec.ospf.proceso,
        routerId: spec.ospf.router_id ? parseIpv4(spec.ospf.router_id) : undefined,
        networks: spec.ospf.redes.map((n) => ({ net: parseIpv4(n.red)!, wildcard: parseIpv4(n.wildcard)!, area: n.area })),
        passive: new Set(spec.ospf.pasivas.map((p) => normalizeIfName(p, spec.tipo) ?? p)),
        passiveDefault: false,
        notPassive: new Set(),
        defaultOriginate: false,
      }
    }
    this.devices.set(d.id, d)
    return d
  }

  /** Busca o crea una interfaz (loopback, VLAN, subinterfaz o física declarada en el ejercicio). */
  ensurePort(d: Device, name: string): Port {
    const existing = this.port(d, name)
    if (existing) return existing
    const sw = isSwitch(d)
    let p: Port
    if (/^Loopback/.test(name)) p = newPort(name, 'loopback', false, false)
    else if (/^Vlan\d+$/.test(name)) p = { ...newPort(name, 'svi', false, false), vlan: Number(name.slice(4)) }
    else if (/\.\d+$/.test(name)) p = { ...newPort(name, 'subif', false, false), parent: name.replace(/\.\d+$/, '') }
    else p = newPort(name, 'phys', sw, d.type === 'router')
    d.ports.push(p)
    return p
  }

  device(idOrName: string): Device | undefined {
    const lower = idOrName.toLowerCase()
    for (const d of this.devices.values()) if (d.id.toLowerCase() === lower) return d
    for (const d of this.devices.values()) if (d.hostname.toLowerCase() === lower) return d
    return undefined
  }

  port(d: Device, name: string): Port | undefined {
    const norm = normalizeIfName(name, d.type) ?? name
    return d.ports.find((p) => p.name.toLowerCase() === norm.toLowerCase())
  }

  linkOf(devId: string, portName: string): { dev: Device; port: Port } | undefined {
    for (const l of this.links) {
      const [here, there] = l.a.dev === devId && l.a.port === portName ? [l.a, l.b] : l.b.dev === devId && l.b.port === portName ? [l.b, l.a] : [undefined, undefined]
      if (!here || !there) continue
      const dev = this.devices.get(there.dev)
      const port = dev && this.port(dev, there.port)
      if (dev && port) return { dev, port }
    }
    return undefined
  }

  connect(a: { dev: string; port: string }, b: { dev: string; port: string }) {
    this.links.push({ a, b })
  }

  removeDevice(id: string) {
    this.devices.delete(id)
    this.links = this.links.filter((l) => l.a.dev !== id && l.b.dev !== id)
  }

  removeLink(index: number) {
    this.links.splice(index, 1)
  }

  // -------------------------------------------------------------------------------------
  // Estado de interfaces
  // -------------------------------------------------------------------------------------

  /** Estado como en "show ip interface brief": status y protocolo. */
  portState(d: Device, p: Port): { status: 'up' | 'down' | 'administratively down'; protocol: 'up' | 'down' } {
    if (p.shutdown) return { status: 'administratively down', protocol: 'down' }
    switch (p.kind) {
      case 'loopback':
        return { status: 'up', protocol: 'up' }
      case 'subif': {
        const parent = p.parent ? this.port(d, p.parent) : undefined
        if (!parent) return { status: 'down', protocol: 'down' }
        const ps = this.portState(d, parent)
        return { status: ps.status, protocol: ps.protocol === 'up' && p.encapVlan !== undefined ? 'up' : 'down' }
      }
      case 'svi': {
        if (!p.vlan || !d.vlans.has(p.vlan)) return { status: 'down', protocol: 'down' }
        const active = d.ports.some((q) => q.kind === 'phys' && q.switchport && this.physUp(d, q) && this.carriesVlan(d, q, p.vlan!))
        return { status: 'up', protocol: active ? 'up' : 'down' }
      }
      case 'phys': {
        const up = this.physUp(d, p)
        return { status: up ? 'up' : 'down', protocol: up ? 'up' : 'down' }
      }
    }
  }

  physUp(d: Device, p: Port): boolean {
    if (p.shutdown) return false
    const peer = this.linkOf(d.id, p.name)
    return !!peer && !peer.port.shutdown
  }

  isUp(d: Device, p: Port): boolean {
    return this.portState(d, p).protocol === 'up'
  }

  /** Modo efectivo de un switchport, considerando DTP (dynamic auto forma troncal si el otro extremo es trunk). */
  effectiveMode(d: Device, p: Port): 'access' | 'trunk' {
    if (p.mode) return p.mode
    const peer = this.linkOf(d.id, p.name)
    return peer && isSwitch(peer.dev) && peer.port.switchport && peer.port.mode === 'trunk' ? 'trunk' : 'access'
  }

  allows(p: Port, vlan: number): boolean {
    return p.allowed === 'all' || p.allowed.includes(vlan)
  }

  carriesVlan(d: Device, p: Port, vlan: number): boolean {
    const mode = this.effectiveMode(d, p)
    return mode === 'access' ? p.accessVlan === vlan : this.allows(p, vlan) && d.vlans.has(vlan)
  }

  l3Ports(d: Device): Port[] {
    return d.ports.filter((p) => p.ip && (p.kind !== 'phys' || !p.switchport) && this.isUp(d, p))
  }

  ownsIp(d: Device, ip: number): boolean {
    return d.ports.some((p) => p.ip?.ip === ip && this.isUp(d, p))
  }

  // -------------------------------------------------------------------------------------
  // Capa 2: quién recibe una trama enviada por una interfaz de capa 3
  // -------------------------------------------------------------------------------------

  l2Reach(d: Device, from: Port): { endpoints: L2Endpoint[]; drops: string[] } {
    const endpoints: L2Endpoint[] = []
    const drops: string[] = []
    const visited = new Set<string>()
    type Frame = { dev: Device; port: Port; tag?: number; trail: string[] }
    const queue: Frame[] = []

    const emit = (dev: Device, port: Port, tag: number | undefined, trail: string[]) => {
      if (port.shutdown) {
        drops.push(`la interfaz ${shortIfName(port.name)} de ${dev.hostname} está apagada (shutdown)`)
        return
      }
      const peer = this.linkOf(dev.id, port.name)
      if (!peer) return
      if (peer.port.shutdown) {
        drops.push(`la interfaz ${shortIfName(peer.port.name)} de ${peer.dev.hostname} está apagada (shutdown)`)
        return
      }
      queue.push({ dev: peer.dev, port: peer.port, tag, trail: [...trail, peer.dev.id] })
    }

    const flood = (dev: Device, vlan: number, except: Port | undefined, trail: string[]) => {
      const key = `${dev.id}:${vlan}`
      if (visited.has(key)) return
      visited.add(key)
      const svi = dev.ports.find((p) => p.kind === 'svi' && p.vlan === vlan && p.ip && !p.shutdown)
      if (svi && svi !== from) endpoints.push({ dev, port: svi, trail })
      let exits = 0
      for (const p of dev.ports) {
        if (p.kind !== 'phys' || !p.switchport || p === except || !this.linkOf(dev.id, p.name)) continue
        const mode = this.effectiveMode(dev, p)
        if (mode === 'access' && p.accessVlan === vlan) {
          emit(dev, p, undefined, trail)
          exits++
        } else if (mode === 'trunk') {
          if (this.allows(p, vlan)) {
            emit(dev, p, vlan === p.nativeVlan ? undefined : vlan, trail)
            exits++
          } else drops.push(`el troncal ${shortIfName(p.name)} de ${dev.hostname} no permite la VLAN ${vlan}`)
        }
      }
      if (!exits && !svi) drops.push(`en ${dev.hostname} la VLAN ${vlan} no sale por ningún otro puerto conectado (revisa troncales y VLAN de acceso)`)
    }

    // Punto de partida
    if (from.kind === 'svi') flood(d, from.vlan!, undefined, [d.id])
    else if (from.kind === 'subif') {
      const parent = from.parent ? this.port(d, from.parent) : undefined
      if (parent) emit(d, parent, from.encapVlan, [d.id])
    } else if (from.kind === 'phys') emit(d, from, undefined, [d.id])

    while (queue.length) {
      const f = queue.shift()!
      const { dev, port } = f
      if (isSwitch(dev) && port.kind === 'phys' && port.switchport) {
        const mode = this.effectiveMode(dev, port)
        let vlan: number
        if (mode === 'access') {
          if (f.tag !== undefined) {
            drops.push(`el puerto ${shortIfName(port.name)} de ${dev.hostname} está en modo acceso y recibió tramas etiquetadas (VLAN ${f.tag}); falta configurarlo como troncal`)
            continue
          }
          vlan = port.accessVlan
        } else {
          vlan = f.tag ?? port.nativeVlan
          if (!this.allows(port, vlan)) {
            drops.push(`el troncal ${shortIfName(port.name)} de ${dev.hostname} no permite la VLAN ${vlan}`)
            continue
          }
        }
        if (!dev.vlans.has(vlan)) {
          drops.push(`la VLAN ${vlan} no existe en ${dev.hostname}`)
          continue
        }
        flood(dev, vlan, port, f.trail)
        continue
      }
      // Equipo de capa 3: PC, servidor, router o puerto enrutado de un switch L3
      if (f.tag === undefined) {
        if (port.ip && (port.kind !== 'phys' || !port.switchport)) endpoints.push({ dev, port, trail: f.trail })
        else if (!port.ip && dev.ports.some((p) => p.kind === 'subif' && p.parent === port.name)) {
          drops.push(`${dev.hostname} recibió tramas sin etiqueta en ${shortIfName(port.name)}, pero esa interfaz solo tiene subinterfaces 802.1Q (el otro extremo debería ser troncal)`)
        }
      } else {
        const sub = dev.ports.find((p) => p.kind === 'subif' && p.parent === port.name && p.encapVlan === f.tag && !p.shutdown && p.ip)
        if (sub) endpoints.push({ dev, port: sub, trail: f.trail })
        else if (isHost(dev)) drops.push(`${dev.hostname} recibió tramas etiquetadas con la VLAN ${f.tag}: el puerto del switch hacia ${dev.hostname} debería estar en modo acceso`)
        else drops.push(`${dev.hostname} no tiene una subinterfaz con "encapsulation dot1Q ${f.tag}" en ${shortIfName(port.name)}`)
      }
    }
    return { endpoints, drops: [...new Set(drops)] }
  }

  // -------------------------------------------------------------------------------------
  // Tabla de enrutamiento (conectadas, estáticas y OSPF)
  // -------------------------------------------------------------------------------------

  routerId(d: Device): number | undefined {
    if (d.ospf?.routerId !== undefined) return d.ospf.routerId
    const loops = d.ports.filter((p) => p.kind === 'loopback' && p.ip && !p.shutdown).map((p) => p.ip!.ip)
    if (loops.length) return Math.max(...loops)
    const ips = d.ports.filter((p) => p.ip && this.isUp(d, p)).map((p) => p.ip!.ip)
    return ips.length ? Math.max(...ips) : undefined
  }

  ospfIfaces(d: Device): { port: Port; area: number }[] {
    if (!d.ospf || !isRouting(d)) return []
    const out: { port: Port; area: number }[] = []
    for (const p of this.l3Ports(d)) {
      const stmt = d.ospf.networks.find((n) => ((p.ip!.ip & ~n.wildcard) >>> 0) === ((n.net & ~n.wildcard) >>> 0))
      if (stmt) out.push({ port: p, area: stmt.area })
    }
    return out
  }

  isPassive(d: Device, p: Port): boolean {
    if (!d.ospf) return true
    return d.ospf.passiveDefault ? !d.ospf.notPassive.has(p.name) : d.ospf.passive.has(p.name)
  }

  /** Vecinos OSPF de un equipo (adyacencias completas). */
  ospfNeighbors(d: Device): { dev: Device; rid: number; ip: number; localPort: Port; area: number; isDr: boolean; isBdr: boolean }[] {
    const mine = this.ospfIfaces(d)
    const out: ReturnType<Network['ospfNeighbors']> = []
    for (const { port, area } of mine) {
      if (this.isPassive(d, port)) continue
      const { endpoints } = this.l2Reach(d, port)
      const segment: { dev: Device; rid: number; ip: number }[] = []
      for (const e of endpoints) {
        if (e.dev === d || !e.dev.ospf || !e.port.ip) continue
        const theirs = this.ospfIfaces(e.dev).find((x) => x.port === e.port)
        if (!theirs || theirs.area !== area || this.isPassive(e.dev, e.port)) continue
        if (e.port.ip.prefix !== port.ip!.prefix || !sameSubnet(e.port.ip.ip, port.ip!.ip, port.ip!.prefix)) continue
        const rid = this.routerId(e.dev)
        if (rid === undefined || rid === this.routerId(d)) continue
        segment.push({ dev: e.dev, rid, ip: e.port.ip.ip })
      }
      const rids = [this.routerId(d) ?? 0, ...segment.map((s) => s.rid)].sort((a, b) => b - a)
      for (const s of segment) out.push({ ...s, localPort: port, area, isDr: s.rid === rids[0], isBdr: s.rid === rids[1] })
    }
    return out
  }

  private ospfRoutes(d: Device): Route[] {
    if (!d.ospf || !isRouting(d)) return []
    // Dijkstra con costo 1 por enlace sobre el grafo de adyacencias.
    const dist = new Map<Device, { cost: number; first?: { ip: number; port: Port } }>([[d, { cost: 0 }]])
    const queue: Device[] = [d]
    while (queue.length) {
      queue.sort((a, b) => dist.get(a)!.cost - dist.get(b)!.cost)
      const cur = queue.shift()!
      const base = dist.get(cur)!
      for (const n of this.ospfNeighbors(cur)) {
        const cost = base.cost + 1
        if (!dist.has(n.dev) || dist.get(n.dev)!.cost > cost) {
          dist.set(n.dev, { cost, first: base.first ?? { ip: n.ip, port: n.localPort } })
          queue.push(n.dev)
        }
      }
    }
    const myAreas = new Set(this.ospfIfaces(d).map((x) => x.area))
    const connected = this.l3Ports(d).map((p) => ({ net: networkOf(p.ip!.ip, p.ip!.prefix), prefix: p.ip!.prefix }))
    const best = new Map<string, Route>()
    for (const [other, info] of dist) {
      if (other === d || !info.first) continue
      for (const { port, area } of this.ospfIfaces(other)) {
        const prefix = port.kind === 'loopback' ? 32 : port.ip!.prefix
        const net = networkOf(port.ip!.ip, prefix)
        if (connected.some((c) => c.net === net && c.prefix === prefix)) continue
        const key = `${net}/${prefix}`
        const metric = info.cost + 1
        const existing = best.get(key)
        if (!existing || existing.metric > metric) {
          best.set(key, { code: myAreas.has(area) ? 'O' : 'O IA', net, prefix, nextHop: info.first.ip, port: info.first.port.name, distance: 110, metric })
        }
      }
      if (other.ospf?.defaultOriginate && other.routes.some((r) => r.prefix === 0)) {
        const existing = best.get('0/0')
        if (!existing || existing.metric > info.cost) best.set('0/0', { code: 'O*E2', net: 0, prefix: 0, nextHop: info.first.ip, port: info.first.port.name, distance: 110, metric: 1 })
      }
    }
    return [...best.values()]
  }

  routingTable(d: Device): Route[] {
    const routes: Route[] = []
    for (const p of this.l3Ports(d)) {
      routes.push({ code: 'C', net: networkOf(p.ip!.ip, p.ip!.prefix), prefix: p.ip!.prefix, port: p.name, distance: 0, metric: 0 })
      if (p.ip!.prefix < 32) routes.push({ code: 'L', net: p.ip!.ip, prefix: 32, port: p.name, distance: 0, metric: 0 })
    }
    if (!isRouting(d)) return routes
    for (const r of d.routes) {
      const key = (x: Route) => x.net === r.net && x.prefix === r.prefix
      if (routes.some((x) => key(x) && x.distance <= r.distance)) continue
      if (r.exitIf) {
        const p = this.port(d, r.exitIf)
        if (p && this.isUp(d, p)) routes.push({ code: r.prefix === 0 ? 'S*' : 'S', net: r.net, prefix: r.prefix, port: p.name, nextHop: r.via, distance: r.distance, metric: 0 })
      } else if (r.via !== undefined && routes.some((x) => x.code === 'C' && sameSubnet(r.via!, x.net, x.prefix))) {
        routes.push({ code: r.prefix === 0 ? 'S*' : 'S', net: r.net, prefix: r.prefix, nextHop: r.via, distance: r.distance, metric: 0 })
      }
    }
    for (const o of this.ospfRoutes(d)) {
      const same = routes.find((x) => x.net === o.net && x.prefix === o.prefix)
      if (!same) routes.push(o)
      else if (same.distance > o.distance) routes.splice(routes.indexOf(same), 1, o)
    }
    return routes
  }

  /** Busca la ruta más específica hacia un destino y resuelve el siguiente salto y la interfaz de salida. */
  lookup(d: Device, dst: number): { port: Port; nextHop: number; route?: Route } | { error: string } {
    if (!isRouting(d)) {
      const ports = this.l3Ports(d)
      if (!ports.length) {
        const anyIp = d.ports.find((p) => p.ip && (p.kind !== 'phys' || !p.switchport))
        if (anyIp) return { error: `la interfaz ${shortIfName(anyIp.name)} de ${d.hostname} está caída (${anyIp.shutdown ? 'apagada con shutdown' : 'sin cable o con el otro extremo apagado'})` }
        return { error: `${d.hostname} no tiene ninguna dirección IP configurada` }
      }
      const direct = ports.find((p) => sameSubnet(p.ip!.ip, dst, p.ip!.prefix))
      if (direct) return { port: direct, nextHop: dst }
      if (d.gateway === undefined) return { error: `${d.hostname} no tiene puerta de enlace configurada y ${formatIpv4(dst)} está en otra red` }
      const gwPort = ports.find((p) => sameSubnet(p.ip!.ip, d.gateway!, p.ip!.prefix))
      if (!gwPort) return { error: `la puerta de enlace ${formatIpv4(d.gateway)} de ${d.hostname} no está en su misma red` }
      return { port: gwPort, nextHop: d.gateway }
    }
    const table = this.routingTable(d).filter((r) => r.code !== 'L')
    const matches = table.filter((r) => networkOf(dst, r.prefix) === r.net).sort((a, b) => b.prefix - a.prefix || a.distance - b.distance)
    for (const r of matches) {
      if (r.port && (r.code === 'C' || r.nextHop === undefined)) {
        const p = this.port(d, r.port)!
        return { port: p, nextHop: r.code === 'C' ? dst : (r.nextHop ?? dst), route: r }
      }
      if (r.port && r.nextHop !== undefined) return { port: this.port(d, r.port)!, nextHop: r.nextHop, route: r }
      if (r.nextHop !== undefined) {
        const conn = table.find((x) => x.code === 'C' && sameSubnet(r.nextHop!, x.net, x.prefix))
        if (conn) return { port: this.port(d, conn.port!)!, nextHop: r.nextHop, route: r }
      }
    }
    return { error: `${d.hostname} no tiene una ruta hacia ${formatIpv4(dst)} (ni ruta por defecto)` }
  }

  // -------------------------------------------------------------------------------------
  // Ping
  // -------------------------------------------------------------------------------------

  /** Resuelve "PC1", "R1" o "192.168.1.10" a una IP de destino. */
  resolveTarget(target: string): number | undefined {
    const ip = parseIpv4(target)
    if (ip !== undefined) return ip
    const d = this.device(target)
    if (!d) return undefined
    const p = d.ports.find((x) => x.ip && x.kind !== 'loopback') ?? d.ports.find((x) => x.ip)
    return p?.ip?.ip
  }

  private walk(start: Device, dst: number, srcHint?: number): { ok: true; hops: Hop[]; dest: Device; source: number } | { ok: false; hops: Hop[]; reason: string; failedAt: string; source?: number; unreachable?: boolean } {
    const hops: Hop[] = []
    let dev = start
    let source = srcHint
    for (let ttl = 0; ttl < 32; ttl++) {
      if (this.ownsIp(dev, dst)) {
        if (dev.blocked && dev !== start) return { ok: false, hops, reason: `${dev.hostname} recibió el paquete pero no responde: tiene un firewall que bloquea ICMP`, failedAt: dev.id, source }
        return { ok: true, hops, dest: dev, source: source ?? dst }
      }
      if (dev !== start && !isRouting(dev)) {
        return { ok: false, hops, reason: `el paquete llegó a ${dev.hostname}, que no enruta paquetes. Revisa la puerta de enlace o las rutas que apuntan a ${dev.hostname}`, failedAt: dev.id, source }
      }
      const r = this.lookup(dev, dst)
      if ('error' in r) return { ok: false, hops, reason: r.error, failedAt: dev.id, source, unreachable: dev !== start }
      source ??= r.port.ip!.ip
      const { endpoints, drops } = this.l2Reach(dev, r.port)
      const next = endpoints.find((e) => e.port.ip?.ip === r.nextHop)
      if (!next) {
        const where = `${dev.hostname} (${shortIfName(r.port.name)})`
        const hint = drops.length ? ` Posible causa: ${drops.join('; ')}.` : r.port.kind === 'phys' && !this.linkOf(dev.id, r.port.name) ? ' La interfaz no tiene cable conectado.' : ''
        const what = r.nextHop === dst ? `el destino ${formatIpv4(dst)}` : `el siguiente salto ${formatIpv4(r.nextHop)}`
        return { ok: false, hops, reason: `desde ${where} nadie respondió al ARP por ${what}.${hint}`, failedAt: dev.id, source }
      }
      dev.arp.set(r.nextHop, next.dev.id)
      hops.push({ from: dev.id, fromPort: r.port.name, to: next.dev.id, toPort: next.port.name, via: next.trail.slice(1, -1), vlan: r.port.kind === 'svi' ? r.port.vlan : r.port.encapVlan })
      dev = next.dev
    }
    return { ok: false, hops, reason: 'el paquete quedó dando vueltas entre routers hasta agotar el TTL (bucle de enrutamiento)', failedAt: dev.id, source }
  }

  ping(from: string, to: string): PingResult {
    const src = this.device(from)
    if (!src) return { ok: false, forward: [], back: [], reason: `no existe el equipo ${from}` }
    const dst = this.resolveTarget(to)
    if (dst === undefined) return { ok: false, forward: [], back: [], reason: `no se puede resolver ${to}` }
    const fwd = this.walk(src, dst)
    if (!fwd.ok) return { ok: false, source: fwd.source, target: dst, forward: fwd.hops, back: [], reason: fwd.reason, failedAt: fwd.failedAt, unreachable: fwd.unreachable }
    if (fwd.dest === src) return { ok: true, source: dst, target: dst, forward: [], back: [] }
    const back = this.walk(fwd.dest, fwd.source)
    if (!back.ok) return { ok: false, source: fwd.source, target: dst, forward: fwd.hops, back: back.hops, reason: `la ida llega, pero la respuesta no vuelve: ${back.reason}`, failedAt: back.failedAt }
    return { ok: true, source: fwd.source, target: dst, forward: fwd.hops, back: back.hops }
  }
}

function splitEndpoint(text: string): [string, string] {
  const i = text.indexOf(':')
  return [text.slice(0, i), text.slice(i + 1)]
}

export function formatMask(prefix: number) {
  return formatIpv4(prefixToMask(prefix))
}

export { broadcastOf, formatIpv4 }
