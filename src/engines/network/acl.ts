/**
 * Listas de acceso (ACL) de Cisco IOS: estándar (solo origen) y extendidas (protocolo, origen,
 * destino y puertos). Se evalúan de arriba hacia abajo, gana la primera que coincide y al final
 * hay un "deny any" implícito que no se ve.
 */
import { formatIpv4, parseIpv4 } from './ip'

export type AclProto = 'ip' | 'icmp' | 'tcp' | 'udp' | 'ospf' | 'gre' | 'esp'

export interface AddrMatch {
  ip: number
  wc: number
}

export interface PortMatch {
  op: 'eq' | 'neq' | 'gt' | 'lt' | 'range'
  ports: number[]
}

export interface AclEntry {
  seq: number
  action: 'permit' | 'deny'
  proto: AclProto
  src: AddrMatch
  srcPort?: PortMatch
  dst: AddrMatch
  dstPort?: PortMatch
  icmpType?: 'echo' | 'echo-reply'
  established?: boolean
  log?: boolean
  matches: number
}

export interface Acl {
  name: string
  kind: 'standard' | 'extended'
  entries: AclEntry[]
  remarks: string[]
}

/** Lo que el filtro necesita saber de un paquete. */
export interface AclPacket {
  src: number
  dst: number
  proto: 'icmp' | 'tcp' | 'udp'
  srcPort?: number
  dstPort?: number
  icmpType?: 'echo' | 'echo-reply'
  /** Segmento TCP de una conexión ya abierta (con ACK): lo que matchea "established". */
  established?: boolean
}

const PORT_NAMES: Record<string, number> = { www: 80, http: 80, ftp: 21, 'ftp-data': 20, telnet: 23, smtp: 25, domain: 53, pop3: 110, ntp: 123, bootps: 67, bootpc: 68, tftp: 69, snmp: 161, isakmp: 500, bgp: 179, ldap: 389, syslog: 514, cmd: 514 }
const SHOW_NAMES: Record<number, string> = { 80: 'www', 21: 'ftp', 23: 'telnet', 25: 'smtp', 53: 'domain', 110: 'pop3', 123: 'ntp', 67: 'bootps', 68: 'bootpc', 69: 'tftp', 161: 'snmp', 500: 'isakmp', 179: 'bgp' }

export function aclKindForNumber(n: number): 'standard' | 'extended' | undefined {
  if ((n >= 1 && n <= 99) || (n >= 1300 && n <= 1999)) return 'standard'
  if ((n >= 100 && n <= 199) || (n >= 2000 && n <= 2699)) return 'extended'
  return undefined
}

function port(tok: string | undefined): number | undefined {
  if (tok === undefined) return undefined
  if (/^\d+$/.test(tok) && Number(tok) <= 65535) return Number(tok)
  return PORT_NAMES[tok.toLowerCase()]
}

/** Lee una dirección: any | host A | A [wildcard] (en las estándar el wildcard es opcional). */
function addr(tokens: string[], i: number, optionalWc: boolean): { m: AddrMatch; next: number } | undefined {
  const t = tokens[i]
  if (t === 'any') return { m: { ip: 0, wc: 0xffffffff }, next: i + 1 }
  if (t === 'host') {
    const ip = parseIpv4(tokens[i + 1] ?? '')
    return ip === undefined ? undefined : { m: { ip, wc: 0 }, next: i + 2 }
  }
  const ip = parseIpv4(t ?? '')
  if (ip === undefined) return undefined
  const wc = parseIpv4(tokens[i + 1] ?? '')
  if (wc === undefined) return optionalWc ? { m: { ip, wc: 0 }, next: i + 1 } : undefined
  return { m: { ip: (ip & ~wc) >>> 0, wc }, next: i + 2 }
}

function portMatch(tokens: string[], i: number): { m?: PortMatch; next: number } | undefined {
  const op = tokens[i]
  if (op === 'eq' || op === 'neq' || op === 'gt' || op === 'lt') {
    const p = port(tokens[i + 1])
    return p === undefined ? undefined : { m: { op, ports: [p] }, next: i + 2 }
  }
  if (op === 'range') {
    const a = port(tokens[i + 1])
    const b = port(tokens[i + 2])
    return a === undefined || b === undefined ? undefined : { m: { op, ports: [a, b] }, next: i + 3 }
  }
  return { next: i }
}

/** Interpreta "permit tcp any host 10.0.0.1 eq 443" (sin número de secuencia). Devuelve un error si no es válida. */
export function parseAclLine(kind: 'standard' | 'extended', line: string): Omit<AclEntry, 'seq' | 'matches'> | { error: string; at: number } {
  const tokens = line.trim().split(/\s+/)
  const action = tokens[0]
  if (action !== 'permit' && action !== 'deny') return { error: 'se espera permit o deny', at: 0 }
  let i = 1
  if (kind === 'standard') {
    const s = addr(tokens, i, true)
    if (!s) return { error: 'dirección de origen inválida', at: i }
    i = s.next
    const log = tokens[i] === 'log'
    if (log) i++
    if (i < tokens.length) return { error: 'sobra texto', at: i }
    return { action, proto: 'ip', src: s.m, dst: { ip: 0, wc: 0xffffffff }, log }
  }
  const proto = tokens[i] as AclProto
  if (!['ip', 'icmp', 'tcp', 'udp', 'ospf', 'gre', 'esp'].includes(proto)) return { error: 'protocolo desconocido', at: i }
  i++
  const s = addr(tokens, i, false)
  if (!s) return { error: 'dirección de origen inválida (any, host A o A WILDCARD)', at: i }
  i = s.next
  let srcPort: PortMatch | undefined
  if (proto === 'tcp' || proto === 'udp') {
    const p = portMatch(tokens, i)
    if (!p) return { error: 'puerto inválido', at: i }
    srcPort = p.m
    i = p.next
  }
  const d = addr(tokens, i, false)
  if (!d) return { error: 'dirección de destino inválida (any, host A o A WILDCARD)', at: i }
  i = d.next
  let dstPort: PortMatch | undefined
  let icmpType: AclEntry['icmpType']
  let established = false
  if (proto === 'tcp' || proto === 'udp') {
    const p = portMatch(tokens, i)
    if (!p) return { error: 'puerto inválido', at: i }
    dstPort = p.m
    i = p.next
    if (proto === 'tcp' && tokens[i] === 'established') {
      established = true
      i++
    }
  }
  if (proto === 'icmp' && (tokens[i] === 'echo' || tokens[i] === 'echo-reply')) {
    icmpType = tokens[i] as AclEntry['icmpType']
    i++
  }
  const log = tokens[i] === 'log'
  if (log) i++
  if (i < tokens.length) return { error: 'sobra texto', at: i }
  return { action, proto, src: s.m, srcPort, dst: d.m, dstPort, icmpType, established, log }
}

function addrMatches(m: AddrMatch, ip: number): boolean {
  return ((ip & ~m.wc) >>> 0) === ((m.ip & ~m.wc) >>> 0)
}

function portMatches(m: PortMatch | undefined, p: number | undefined): boolean {
  if (!m) return true
  if (p === undefined) return false
  if (m.op === 'eq') return p === m.ports[0]
  if (m.op === 'neq') return p !== m.ports[0]
  if (m.op === 'gt') return p > m.ports[0]
  if (m.op === 'lt') return p < m.ports[0]
  return p >= m.ports[0] && p <= m.ports[1]
}

export function entryMatches(e: AclEntry, p: AclPacket): boolean {
  if (e.proto !== 'ip' && e.proto !== p.proto) return false
  if (!addrMatches(e.src, p.src) || !addrMatches(e.dst, p.dst)) return false
  if (e.proto === 'tcp' || e.proto === 'udp') {
    if (!portMatches(e.srcPort, p.srcPort) || !portMatches(e.dstPort, p.dstPort)) return false
    if (e.established && !p.established) return false
  }
  if (e.proto === 'icmp' && e.icmpType && e.icmpType !== p.icmpType) return false
  return true
}

/** Primera entrada que coincide (y suma al contador), o undefined si cae en el deny implícito. */
export function evaluateAcl(acl: Acl, p: AclPacket, count = true): AclEntry | undefined {
  const e = acl.entries.find((x) => entryMatches(x, p))
  if (e && count) e.matches++
  return e
}

function fmtAddr(m: AddrMatch, standardShow = false): string {
  if (m.wc === 0xffffffff) return 'any'
  if (m.wc === 0) return standardShow ? formatIpv4(m.ip) : `host ${formatIpv4(m.ip)}`
  return standardShow ? `${formatIpv4(m.ip)}, wildcard bits ${formatIpv4(m.wc)}` : `${formatIpv4(m.ip)} ${formatIpv4(m.wc)}`
}

function fmtPort(m?: PortMatch): string {
  if (!m) return ''
  const n = (x: number) => SHOW_NAMES[x] ?? String(x)
  return m.op === 'range' ? ` range ${n(m.ports[0])} ${n(m.ports[1])}` : ` ${m.op} ${n(m.ports[0])}`
}

/** Una entrada como en la configuración (sin número de secuencia). */
export function formatEntry(kind: 'standard' | 'extended', e: AclEntry): string {
  if (kind === 'standard') return `${e.action} ${e.src.wc === 0 ? formatIpv4(e.src.ip) : fmtAddr(e.src)}${e.log ? ' log' : ''}`
  return `${e.action} ${e.proto} ${fmtAddr(e.src)}${fmtPort(e.srcPort)} ${fmtAddr(e.dst)}${fmtPort(e.dstPort)}${e.established ? ' established' : ''}${e.icmpType ? ` ${e.icmpType}` : ''}${e.log ? ' log' : ''}`
}

/** show access-lists */
export function showAcl(acl: Acl): string {
  const head = `${acl.kind === 'standard' ? 'Standard' : 'Extended'} IP access list ${acl.name}\n`
  return (
    head +
    acl.entries
      .map((e) => {
        const body = acl.kind === 'standard' ? `${e.action} ${fmtAddr(e.src, true)}${e.log ? ' log' : ''}` : formatEntry('extended', e)
        return `    ${e.seq} ${body}${e.matches ? ` (${e.matches} match${e.matches === 1 ? '' : 'es'})` : ''}\n`
      })
      .join('')
  )
}

export function newAcl(name: string, kind: 'standard' | 'extended'): Acl {
  return { name, kind, entries: [], remarks: [] }
}

/** Agrega una entrada al final (o con un número de secuencia dado). */
export function addEntry(acl: Acl, entry: Omit<AclEntry, 'seq' | 'matches'>, seq?: number): void {
  const s = seq ?? (acl.entries.length ? Math.max(...acl.entries.map((e) => e.seq)) + 10 : 10)
  acl.entries = acl.entries.filter((e) => e.seq !== s)
  acl.entries.push({ ...entry, seq: s, matches: 0 })
  acl.entries.sort((a, b) => a.seq - b.seq)
}
