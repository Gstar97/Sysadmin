/**
 * Spanning Tree (PVST/RSTP simplificado, una instancia por VLAN): elige el puente raíz, calcula
 * el costo hacia la raíz, el puerto raíz de cada switch y el designado de cada segmento, y deja
 * en bloqueo los puertos que cerrarían un bucle. Un EtherChannel formado cuenta como un solo
 * enlace. Lo usan el motor de red (para no reenviar por puertos bloqueados), la consola
 * (show spanning-tree) y el simulador visual.
 */
import type { Device, Network, Port } from './model'
import { isSwitch } from './model'

export interface BridgeId {
  priority: number
  mac: string
}

export type StpRole = 'root' | 'designated' | 'alternate'

export interface StpPort {
  name: string
  role: StpRole
  forwarding: boolean
  cost: number
  portId: string
  edge: boolean
  /** Nombre del equipo vecino (para explicar). */
  peer?: string
}

export interface StpSwitch {
  dev: Device
  bridge: BridgeId
  rootCost: number
  rootPort?: string
  ports: Map<string, StpPort>
}

export interface StpResult {
  vlan: number
  root?: BridgeId
  rootDev?: string
  switches: Map<string, StpSwitch>
  /** Raíz del grupo de switches conectados al que pertenece cada uno. */
  rootOf?: Map<string, StpSwitch>
}

/** MAC base del switch (la que usa en su identificador de puente). */
export function bridgeMac(d: Device): string {
  let h = 2166136261
  for (const ch of `bridge/${d.id}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0
  const hex = `00${(0xd0 + (h & 0x0f)).toString(16)}${h.toString(16).padStart(8, '0')}`
  return `${hex.slice(0, 4)}.${hex.slice(4, 8)}.${hex.slice(8, 12)}`
}

export function bridgeId(d: Device, vlan: number): BridgeId {
  return { priority: (d.stpPriority.get(vlan) ?? d.stpPriority.get(0) ?? 32768) + vlan, mac: bridgeMac(d) }
}

export function compareBridge(a: BridgeId, b: BridgeId): number {
  return a.priority - b.priority || (a.mac < b.mac ? -1 : a.mac > b.mac ? 1 : 0)
}

/** Costo de un puerto según su velocidad (método corto de 802.1D, el de fábrica en Catalyst). */
export function portCost(p: Port): number {
  if (/^TenGigabit/i.test(p.name)) return 2
  if (/^Gigabit/i.test(p.name)) return 4
  if (/^Port-channel/i.test(p.name)) return 3
  return 19
}

function portNumber(d: Device, p: Port): number {
  const phys = d.ports.filter((x) => x.kind === 'phys' && !/^Port-channel/.test(x.name))
  const i = phys.indexOf(p)
  return i >= 0 ? i + 1 : 64 + Number(/(\d+)$/.exec(p.name)?.[1] ?? 0)
}

/** Si dos modos de EtherChannel forman el canal (LACP: active/passive; PAgP: desirable/auto; on con on). */
export function channelCompatible(a?: string, b?: string): boolean {
  if (!a || !b) return false
  if (a === 'on' || b === 'on') return a === b
  const lacp = ['active', 'passive']
  const pagp = ['desirable', 'auto']
  if (lacp.includes(a) && lacp.includes(b)) return a === 'active' || b === 'active'
  if (pagp.includes(a) && pagp.includes(b)) return a === 'desirable' || b === 'desirable'
  return false
}

interface Segment {
  a: { dev: Device; port: Port; logical: string }
  b: { dev: Device; port: Port; logical: string }
  members: { a: Port; b: Port }[]
  cost: number
}

/** Árbol para una VLAN. */
export function computeStp(net: Network, vlan: number): StpResult {
  const switches = new Map<string, StpSwitch>()
  for (const d of net.devices.values()) {
    if (!isSwitch(d) || !d.vlans.has(vlan)) continue
    switches.set(d.id, { dev: d, bridge: bridgeId(d, vlan), rootCost: Infinity, ports: new Map() })
  }
  if (!switches.size) return { vlan, switches }

  // Segmentos entre switches (los EtherChannel formados se agrupan en uno solo).
  const segs: Segment[] = []
  const seen = new Set<string>()
  for (const sw of switches.values()) {
    const d = sw.dev
    for (const p of d.ports) {
      if (p.kind !== 'phys' || !p.switchport || /^Port-channel/.test(p.name)) continue
      if (!net.physUp(d, p) || !net.carriesVlan(d, p, vlan)) continue
      const peer = net.linkOf(d.id, p.name)!
      const key = [`${d.id}/${p.name}`, `${peer.dev.id}/${peer.port.name}`].sort().join('|')
      if (seen.has(key)) continue
      seen.add(key)
      const other = switches.get(peer.dev.id)
      if (!other || !peer.port.switchport || !net.carriesVlan(peer.dev, peer.port, vlan)) {
        // Puerto hacia un equipo final (o un router): siempre designado.
        sw.ports.set(p.name, { name: p.name, role: 'designated', forwarding: true, cost: portCost(p), portId: `128.${portNumber(d, p)}`, edge: !!p.portfast, peer: peer.dev.hostname })
        continue
      }
      const bundled = p.channel && peer.port.channel && channelCompatible(p.channel.mode, peer.port.channel.mode)
      if (bundled) {
        const la = `Port-channel${p.channel!.group}`
        const lb = `Port-channel${peer.port.channel!.group}`
        const existing = segs.find((s) => s.a.dev === d && s.a.logical === la && s.b.dev === peer.dev && s.b.logical === lb)
        if (existing) {
          existing.members.push({ a: p, b: peer.port })
          continue
        }
        const pa = net.port(d, la) ?? p
        const pb = net.port(peer.dev, lb) ?? peer.port
        segs.push({ a: { dev: d, port: pa, logical: la }, b: { dev: peer.dev, port: pb, logical: lb }, members: [{ a: p, b: peer.port }], cost: 3 })
      } else segs.push({ a: { dev: d, port: p, logical: p.name }, b: { dev: peer.dev, port: peer.port, logical: peer.port.name }, members: [{ a: p, b: peer.port }], cost: portCost(p) })
    }
  }

  // Cada grupo de switches conectados entre sí tiene su propia raíz: el puente más bajo.
  const comp = new Map<string, number>()
  let nComp = 0
  for (const sw of switches.values()) {
    if (comp.has(sw.dev.id)) continue
    const stack = [sw.dev.id]
    comp.set(sw.dev.id, nComp)
    while (stack.length) {
      const id = stack.pop()!
      for (const sg of segs) {
        const other = sg.a.dev.id === id ? sg.b.dev.id : sg.b.dev.id === id ? sg.a.dev.id : undefined
        if (other && !comp.has(other)) {
          comp.set(other, nComp)
          stack.push(other)
        }
      }
    }
    nComp++
  }
  const roots: StpSwitch[] = []
  for (let c = 0; c < nComp; c++) {
    const r = [...switches.values()].filter((x) => comp.get(x.dev.id) === c).sort((x, y) => compareBridge(x.bridge, y.bridge))[0]
    r.rootCost = 0
    roots.push(r)
  }
  const root = roots.find((r) => [...switches.values()].some((x) => x !== r && comp.get(x.dev.id) === comp.get(r.dev.id))) ?? roots[0]
  // Dijkstra simple: costo de cada switch hasta la raíz de su grupo.
  const done = new Set<string>()
  for (;;) {
    const cur = [...switches.values()].filter((s) => !done.has(s.dev.id) && s.rootCost < Infinity).sort((a, b) => a.rootCost - b.rootCost)[0]
    if (!cur) break
    done.add(cur.dev.id)
    for (const s of segs) {
      const [me, other] = s.a.dev === cur.dev ? [s.a, s.b] : s.b.dev === cur.dev ? [s.b, s.a] : [undefined, undefined]
      if (!me || !other) continue
      const o = switches.get(other.dev.id)!
      const c = cur.rootCost + s.cost
      if (c < o.rootCost) o.rootCost = c
    }
  }

  // Puerto raíz: el de menor costo hacia la raíz; empate: menor puente vecino, menor puerto vecino.
  for (const sw of switches.values()) {
    if (roots.includes(sw) || sw.rootCost === Infinity) continue
    let best: { port: string; cost: number; bridge: BridgeId; peerPort: number } | undefined
    for (const s of segs) {
      const [me, other] = s.a.dev === sw.dev ? [s.a, s.b] : s.b.dev === sw.dev ? [s.b, s.a] : [undefined, undefined]
      if (!me || !other) continue
      const o = switches.get(other.dev.id)!
      const cand = { port: me.logical, cost: o.rootCost + s.cost, bridge: o.bridge, peerPort: portNumber(other.dev, other.port) }
      if (!best || cand.cost < best.cost || (cand.cost === best.cost && (compareBridge(cand.bridge, best.bridge) < 0 || (compareBridge(cand.bridge, best.bridge) === 0 && cand.peerPort < best.peerPort)))) best = cand
    }
    sw.rootPort = best?.port
  }

  // Designado de cada segmento; el otro extremo es raíz o queda en bloqueo (alternativo).
  for (const s of segs) {
    const A = switches.get(s.a.dev.id)!
    const B = switches.get(s.b.dev.id)!
    const cmp = A.rootCost - B.rootCost || compareBridge(A.bridge, B.bridge) || portNumber(s.a.dev, s.a.port) - portNumber(s.b.dev, s.b.port)
    const [des, other] = cmp <= 0 ? [{ sw: A, end: s.a, m: 'a' as const }, { sw: B, end: s.b, m: 'b' as const }] : [{ sw: B, end: s.b, m: 'b' as const }, { sw: A, end: s.a, m: 'a' as const }]
    const otherRole: StpRole = other.sw.rootPort === other.end.logical ? 'root' : 'alternate'
    const setRole = (sw: StpSwitch, end: Segment['a'], m: 'a' | 'b', role: StpRole, peer: Device) => {
      const info = (name: string, port: Port) => ({ name, role, forwarding: role !== 'alternate', cost: s.cost, portId: `128.${portNumber(end.dev, port)}`, edge: false, peer: peer.hostname })
      sw.ports.set(end.logical, info(end.logical, end.port))
      if (end.logical.startsWith('Port-channel')) for (const mem of s.members) sw.ports.set(mem[m].name, { ...info(mem[m].name, mem[m]), cost: portCost(mem[m]) })
    }
    setRole(des.sw, des.end, des.m, 'designated', other.sw.dev)
    setRole(other.sw, other.end, other.m, otherRole, des.sw.dev)
  }
  const rootOf = new Map<string, StpSwitch>()
  for (const r of roots) for (const x of switches.values()) if (comp.get(x.dev.id) === comp.get(r.dev.id)) rootOf.set(x.dev.id, r)
  return { vlan, root: root.bridge, rootDev: root.dev.id, switches, rootOf }
}

/** Si un puerto de switch reenvía tramas de esa VLAN (no está bloqueado por STP). */
export function stpForwarding(stp: StpResult, d: Device, p: Port): boolean {
  const info = stp.switches.get(d.id)?.ports.get(p.name)
  return !info || info.forwarding
}
