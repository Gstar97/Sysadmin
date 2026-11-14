/**
 * Resolución de nombres según el DNS que tiene configurado cada equipo: un controlador de dominio
 * responde la zona de su dominio (con los registros SRV que usan los clientes para encontrar un DC)
 * y reenvía los nombres de Internet; un DNS público solo conoce Internet. Así se puede reproducir el
 * clásico "el cliente apunta a 8.8.8.8 y no encuentra el dominio".
 */
import { reach, type Lab } from './machine'
import type { PsServerState } from './schema'
import { cmdlet, PsError, PsSession, psEquals, type CmdletContext } from './session'
import { psObject, toText, VIEWS, type PsObject } from './values'

const PUBLIC_DNS: Record<string, string> = {
  '8.8.8.8': 'dns.google',
  '8.8.4.4': 'dns.google',
  '1.1.1.1': 'one.one.one.one',
  '1.0.0.1': 'one.one.one.one',
  '9.9.9.9': 'dns9.quad9.net',
}

/** Todos los equipos del laboratorio (los ya armados y los que todavía no). */
export function labStates(lab: Lab | undefined): PsServerState[] {
  if (!lab) return []
  const out = new Map<string, PsServerState>()
  for (const s of lab.sessions.values()) out.set(s.state.equipo.toLowerCase(), s.state)
  for (const st of lab.states.values()) if (!out.has(st.equipo.toLowerCase())) out.set(st.equipo.toLowerCase(), st)
  return [...out.values()]
}

/** Es controlador de un dominio que existe en el laboratorio. */
export function isDc(st: PsServerState, lab: Lab | undefined): boolean {
  return !!st.dominio && !!lab?.adStores.has(st.dominio.toLowerCase()) && (!!st.ad || st.controlador_dominio)
}

export function domainControllers(lab: Lab | undefined, domain: string): PsServerState[] {
  return labStates(lab).filter((st) => isDc(st, lab) && st.dominio!.toLowerCase() === domain.toLowerCase())
}

function serviceRunning(s: PsSession, name: string) {
  return ((s.data.services ?? []) as PsObject[]).some((x) => toText(x.Name).toLowerCase() === name.toLowerCase() && x.Status === 'Running')
}

const rec = (Name: string, Type: string, value: string | Record<string, unknown>, Section = 'Answer', TTL = 3600) =>
  psObject('Microsoft.DnsClient.Commands.DnsRecord', { Name, Type, TTL, Section, ...(typeof value === 'string' ? (Type === 'CNAME' ? { NameHost: value } : Type === 'MX' ? { NameExchange: value } : { IPAddress: value }) : value) })

/** Registros de la zona de un dominio, armados con lo que hay en el laboratorio. */
function zoneRecords(server: PsSession): PsObject[] {
  const lab = server.lab
  const d = server.state.dominio!.toLowerCase()
  const dcs = domainControllers(lab, d)
  const out: PsObject[] = []
  for (const dc of dcs) out.push(rec(d, 'A', dc.red.ip, 'Answer', 600))
  for (const st of labStates(lab)) if (st.dominio?.toLowerCase() === d) out.push(rec(`${st.equipo}.${d}`.toLowerCase(), 'A', st.red.ip, 'Answer', 1200))
  const srv = (name: string, port: number) => {
    for (const dc of dcs) out.push(rec(name, 'SRV', { NameTarget: `${dc.equipo}.${d}`.toLowerCase(), Priority: 0, Weight: 100, Port: port }, 'Answer', 600))
  }
  srv(`_ldap._tcp.dc._msdcs.${d}`, 389)
  srv(`_ldap._tcp.${d}`, 389)
  srv(`_kerberos._tcp.${d}`, 88)
  srv(`_kerberos._tcp.dc._msdcs.${d}`, 88)
  srv(`_gc._tcp.${d}`, 3268)
  srv(`_ldap._tcp.pdc._msdcs.${d}`, 389)
  srv(`_ldap._tcp.default-first-site-name._sites.dc._msdcs.${d}`, 389)
  // Lo que tenga cargado el propio servidor (registros del ejercicio).
  for (const r of (server.data.dnsRecords ?? []) as PsObject[]) if (toText(r.Name).toLowerCase().endsWith(d) && !out.some((o) => psEquals(o.Name, r.Name) && psEquals(o.Type, r.Type))) out.push(r)
  return out
}

function isInternetName(s: PsSession, name: string): boolean {
  const n = name.toLowerCase()
  if (n.endsWith('.local') || n.endsWith('.lan') || n.endsWith('.internal') || !n.includes('.')) return false
  return !labStates(s.lab).some((st) => st.dominio && n.endsWith(st.dominio.toLowerCase()))
}

function internetRecords(s: PsSession): PsObject[] {
  return ((s.data.dnsRecords ?? []) as PsObject[]).filter((r) => isInternetName(s, toText(r.Name)))
}

// ---------------------------------------------------------------------------------------
// Zonas de un servidor DNS de Windows
// ---------------------------------------------------------------------------------------

export interface DnsZoneRecord {
  /** Nombre relativo a la zona ("@" para la zona misma). */
  name: string
  type: string
  data: string
  ttl: number
  /** Registro dinámico: fecha de la última actualización (los estáticos no tienen). */
  timestamp?: Date
  preference?: number
}

export interface DnsZone {
  name: string
  kind: 'Primary' | 'Forwarder'
  adIntegrated: boolean
  scope?: 'Domain' | 'Forest' | 'Legacy'
  reverse: boolean
  dynamicUpdate: 'Secure' | 'NonsecureAndSecure' | 'None'
  aging: boolean
  noRefreshDays: number
  refreshDays: number
  masters: string[]
  records: DnsZoneRecord[]
  autoCreated?: boolean
}

export function newZone(name: string, opts: Partial<DnsZone> = {}): DnsZone {
  const n = name.toLowerCase().replace(/\.$/, '')
  return { name: n, kind: 'Primary', adIntegrated: false, reverse: n.endsWith('.in-addr.arpa'), dynamicUpdate: 'None', aging: false, noRefreshDays: 7, refreshDays: 7, masters: [], records: [], ...opts }
}

interface ZoneHolder {
  dnsZones?: DnsZone[]
}

/** La base de AD del dominio de un DC (donde viven las zonas integradas). */
function storeOf(server: PsSession): ZoneHolder | undefined {
  if (!server.state.dominio || !isDc(server.state, server.lab)) return undefined
  return server.lab?.adStores.get(server.state.dominio.toLowerCase()) as ZoneHolder | undefined
}

/** Zonas que atiende un servidor DNS: las integradas en AD (si es DC) y las propias. */
export function serverZones(server: PsSession): DnsZone[] {
  const out: DnsZone[] = []
  const st = storeOf(server)
  if (st) {
    st.dnsZones ??= []
    const d = server.state.dominio!.toLowerCase()
    if (!st.dnsZones.some((z) => z.name === d)) st.dnsZones.push(newZone(d, { adIntegrated: true, scope: 'Domain', dynamicUpdate: 'Secure' }))
    if (!st.dnsZones.some((z) => z.name === `_msdcs.${d}`)) st.dnsZones.push(newZone(`_msdcs.${d}`, { adIntegrated: true, scope: 'Forest', dynamicUpdate: 'Secure' }))
    out.push(...st.dnsZones)
  }
  out.push(...((server.data.dnsZones ??= []) as DnsZone[]))
  return out
}

/** Las zonas propias del servidor (las que no están en AD). */
export function localZones(server: PsSession): DnsZone[] {
  return (server.data.dnsZones ??= []) as DnsZone[]
}

export function adZones(server: PsSession): DnsZone[] | undefined {
  const st = storeOf(server)
  if (!st) return undefined
  serverZones(server)
  return st.dnsZones!
}

export function fqdnOf(zone: DnsZone, name: string): string {
  return name === '@' || name === '' ? zone.name : `${name.toLowerCase()}.${zone.name}`
}

/** Dirección IPv4 → nombre de la zona inversa (192.168.10.50 → 50.10.168.192.in-addr.arpa). */
export function reverseName(ip: string): string {
  return `${ip.split('.').reverse().join('.')}.in-addr.arpa`
}

export function zoneRecordObject(zone: DnsZone, r: DnsZoneRecord, name = fqdnOf(zone, r.name)): PsObject {
  const t = r.type.toUpperCase()
  const extra = t === 'CNAME' ? { NameHost: r.data } : t === 'MX' ? { NameExchange: r.data, Preference: r.preference ?? 10 } : t === 'PTR' ? { NameHost: r.data } : t === 'TXT' ? { Strings: r.data } : { IPAddress: r.data }
  return psObject('Microsoft.DnsClient.Commands.DnsRecord', { Name: name, Type: t, TTL: r.ttl, Section: 'Answer', ...extra })
}

/** Todos los registros de una zona como los ve un cliente (los generados más los cargados). */
function zoneAnswers(server: PsSession, zone: DnsZone): PsObject[] {
  const own = zone.records.map((r) => zoneRecordObject(zone, r))
  const d = server.state.dominio?.toLowerCase()
  if (zone.adIntegrated && d && (zone.name === d || zone.name === `_msdcs.${d}`)) {
    const inMsdcs = (n: string) => n.toLowerCase().endsWith(`._msdcs.${d}`)
    const gen = zoneRecords(server).filter((g) => (zone.name === d ? !inMsdcs(toText(g.Name)) : inMsdcs(toText(g.Name))) && !own.some((o) => psEquals(o.Name, g.Name) && psEquals(o.Type, g.Type)))
    return [...own, ...gen]
  }
  return own
}

export interface DnsServerInfo {
  ip: string
  name: string
}

export type DnsResult =
  | { ok: true; server: DnsServerInfo; records: PsObject[]; authoritative: boolean }
  | { ok: false; server: DnsServerInfo; error: 'nxdomain' | 'timeout' | 'noserver' }

/** Resuelve un nombre como lo haría el cliente DNS de "s" (o preguntándole a "serverIp"). */
export function resolveName(s: PsSession, name: string, type = 'A', serverIp?: string, depth = 0): DnsResult {
  const ip = serverIp ?? s.state.red.dns[0]
  let lower = name.toLowerCase().replace(/\.$/, '')
  if (/^\d+\.\d+\.\d+\.\d+$/.test(lower)) {
    lower = reverseName(lower)
    type = 'PTR'
  }
  if (!ip) return { ok: false, server: { ip: '', name: '' }, error: 'noserver' }
  if ((lower === 'localhost' || (lower === s.state.equipo.toLowerCase() && !s.state.dominio)) && type === 'A') return { ok: true, server: { ip, name: '' }, records: [rec(lower, 'A', lower === 'localhost' ? '127.0.0.1' : s.state.red.ip)], authoritative: true }
  // Sufijo DNS: un nombre corto se completa con el dominio del equipo.
  const candidates = lower.includes('.') ? [lower] : [lower, ...(s.state.dominio ? [`${lower}.${s.state.dominio.toLowerCase()}`] : [])]
  const match = (records: PsObject[]) => {
    for (const c of candidates) {
      const found = records.filter((r) => toText(r.Name).toLowerCase() === c && (psEquals(r.Type, type) || (type === 'A' && r.Type === 'CNAME')))
      if (found.length) return found
    }
    return []
  }
  const local = ip === '127.0.0.1' || ip === '::1' || ip === s.state.red.ip
  // El propio equipo sin el rol DNS (el estado por defecto de muchos ejercicios): se usan los registros del ejercicio.
  const server = local ? (serviceRunning(s, 'DNS') ? s : undefined) : s.lab?.find(ip)
  if (server) {
    const info = { ip, name: server.state.dominio ? `${server.state.equipo}.${server.state.dominio}`.toLowerCase() : server.state.equipo.toLowerCase() }
    if (server !== s && !reach(s, ip, 53, 'UDP').ok) return { ok: false, server: info, error: 'timeout' }
    // Un equipo que no tiene el rol DNS no contesta consultas.
    if (!serviceRunning(server, 'DNS')) return { ok: false, server: info, error: 'timeout' }
    // Zonas del servidor: la más específica que contiene el nombre responde (o reenvía, si es condicional).
    const zones = serverZones(server).sort((a, b) => b.name.length - a.name.length)
    for (const c of candidates) {
      const zone = zones.find((z) => c === z.name || c.endsWith(`.${z.name}`))
      if (!zone) continue
      if (zone.kind === 'Forwarder') {
        if (depth > 3) return { ok: false, server: info, error: 'timeout' }
        for (const m of zone.masters) {
          const r = resolveName(server, c, type, m, depth + 1)
          if (r.ok) return { ok: true, server: info, records: r.records, authoritative: false }
          if (r.error === 'nxdomain') return { ok: false, server: info, error: 'nxdomain' }
        }
        return { ok: false, server: info, error: 'timeout' }
      }
      const found = zoneAnswers(server, zone).filter((r) => toText(r.Name).toLowerCase() === c && (psEquals(r.Type, type) || (type === 'A' && r.Type === 'CNAME')))
      if (found.length) {
        // Un CNAME se sigue hasta la dirección, como hace el servidor.
        const cname = found.find((r) => r.Type === 'CNAME')
        if (cname && type === 'A' && depth < 4) {
          const t = resolveName(server, toText(cname.NameHost), 'A', '127.0.0.1', depth + 1)
          return { ok: true, server: info, records: t.ok ? [cname, ...t.records] : [cname], authoritative: true }
        }
        return { ok: true, server: info, records: found, authoritative: true }
      }
      return { ok: false, server: info, error: 'nxdomain' }
    }
    if (candidates.some((c) => server.state.dominio && c.endsWith(server.state.dominio.toLowerCase()))) return { ok: false, server: info, error: 'nxdomain' }
    if (candidates.some((c) => c.endsWith('.in-addr.arpa'))) return { ok: false, server: info, error: 'nxdomain' }
    if (!server.state.red.puerta_enlace) return { ok: false, server: info, error: 'timeout' }
    const net = match(internetRecords(s))
    return net.length ? { ok: true, server: info, records: net, authoritative: false } : { ok: false, server: info, error: 'nxdomain' }
  }
  if (PUBLIC_DNS[ip]) {
    const info = { ip, name: PUBLIC_DNS[ip] }
    if (!s.state.red.puerta_enlace || !s.state.red.conectada) return { ok: false, server: info, error: 'timeout' }
    const net = match(internetRecords(s))
    return net.length ? { ok: true, server: info, records: net, authoritative: false } : { ok: false, server: info, error: 'nxdomain' }
  }
  // Servidor que no es parte del laboratorio: se usan los registros que trae el ejercicio.
  const found = match((s.data.dnsRecords ?? []) as PsObject[])
  return found.length ? { ok: true, server: { ip, name: 'UnKnown' }, records: found, authoritative: false } : { ok: false, server: { ip, name: 'UnKnown' }, error: 'nxdomain' }
}

/** Busca un controlador del dominio como lo hace Windows: registro SRV en el DNS y conexión por LDAP. */
export function locateDc(s: PsSession, domain?: string): { dc?: PsSession; reason?: 'dns' | 'down' | 'nodomain' } {
  const d = (domain ?? s.state.dominio)?.toLowerCase()
  if (!d) return { reason: 'nodomain' }
  if (isDc(s.state, s.lab) && s.state.dominio?.toLowerCase() === d && serviceRunning(s, 'NTDS')) return { dc: s }
  for (const server of s.state.red.dns) {
    const r = resolveName(s, `_ldap._tcp.dc._msdcs.${d}`, 'SRV', server)
    if (!r.ok) continue
    for (const x of r.records) {
      const dc = s.lab?.find(toText(x.NameTarget))
      if (dc && reach(s, dc.state.red.ip, 389).ok && serviceRunning(dc, 'NTDS')) return { dc }
    }
    return { reason: 'down' }
  }
  return { reason: 'dns' }
}

// ---------------------------------------------------------------------------------------
// Resolve-DnsName y nslookup
// ---------------------------------------------------------------------------------------

VIEWS['Microsoft.DnsClient.Commands.DnsRecord_SRV'] = {
  kind: 'table',
  columns: [
    { label: 'Name', value: (o) => o.Name },
    { label: 'Type', value: (o) => o.Type },
    { label: 'TTL', value: (o) => o.TTL, align: 'right' },
    { label: 'Section', value: (o) => o.Section },
    { label: 'NameTarget', value: (o) => o.NameTarget },
    { label: 'Priority', value: (o) => o.Priority },
    { label: 'Weight', value: (o) => o.Weight },
    { label: 'Port', value: (o) => o.Port },
  ],
}

VIEWS['Microsoft.DnsClient.Commands.DnsRecord_PTR'] = {
  kind: 'table',
  columns: [
    { label: 'Name', value: (o) => o.Name },
    { label: 'Type', value: (o) => o.Type },
    { label: 'TTL', value: (o) => o.TTL, align: 'right' },
    { label: 'Section', value: (o) => o.Section },
    { label: 'NameHost', value: (o) => toText(o.NameHost).replace(/\.$/, '') },
  ],
}

function dnsError(name: string, error: string, cmd = 'ResolveDnsName') {
  if (error === 'timeout') return new PsError(`${name} : This operation returned because the timeout period expired`, 'OperationTimeout', `ERROR_TIMEOUT,Microsoft.DnsClient.Commands.${cmd}`, name)
  if (error === 'noserver') return new PsError(`${name} : No DNS servers configured for local system`, 'ResourceUnavailable', `DNS_ERROR_NO_DNS_SERVERS,Microsoft.DnsClient.Commands.${cmd}`, name)
  return new PsError(`${name} : DNS name does not exist`, 'ResourceUnavailable', `DNS_ERROR_RCODE_NAME_ERROR,Microsoft.DnsClient.Commands.${cmd}`, name)
}

cmdlet('Resolve-DnsName', {
  params: ['Name', 'Type', 'Server'],
  switches: ['DnsOnly', 'NoHostsFile', 'QuickTimeout'],
  positional: ['Name', 'Type'],
  synopsis: 'Performs a DNS name query resolution for the specified name.',
  module: 'DnsClient',
  run(ctx: CmdletContext) {
    const name = toText(ctx.params.get('name') ?? '')
    const type = toText(ctx.params.get('type') ?? 'A').toUpperCase()
    const server = ctx.params.has('server') ? toText(ctx.params.get('server')) : undefined
    const serverIp = server && !/^\d+\.\d+\.\d+\.\d+$/.test(server) ? ctx.s.lab?.find(server)?.state.red.ip ?? server : server
    const r = resolveName(ctx.s, name, type, serverIp)
    if (!r.ok) throw dnsError(name, r.error)
    return r.records.map((x) => (x.Type === 'SRV' ? { ...x, __type: 'Microsoft.DnsClient.Commands.DnsRecord_SRV' } : x.Type === 'PTR' || x.Type === 'CNAME' ? { ...x, __type: 'Microsoft.DnsClient.Commands.DnsRecord_PTR' } : x))
  },
})

cmdlet('nslookup', {
  native: true,
  synopsis: 'nslookup.exe',
  run(ctx) {
    const args = ctx.positional.map(toText)
    let type = 'A'
    const rest: string[] = []
    for (const a of args) {
      const m = /^-(?:type|q|querytype)=(\w+)$/i.exec(a)
      if (m) type = m[1].toUpperCase()
      else rest.push(a)
    }
    const [name, serverArg] = rest
    if (!name) return [psObject('__formatted', { text: '[simulador] nslookup interactivo no está disponible; usá nslookup <nombre> [servidor].\n' })]
    const serverIp = serverArg ? (/^\d+\.\d+\.\d+\.\d+$/.test(serverArg) ? serverArg : ctx.s.lab?.find(serverArg)?.state.red.ip ?? serverArg) : undefined
    const r = resolveName(ctx.s, name, type, serverIp)
    // nslookup busca el nombre del servidor con una consulta inversa: sin zona inversa, "UnKnown".
    let serverName = PUBLIC_DNS[r.server.ip] ?? 'UnKnown'
    if (!PUBLIC_DNS[r.server.ip] && r.server.ip) {
      const ptr = resolveName(ctx.s, r.server.ip === '127.0.0.1' ? ctx.s.state.red.ip : r.server.ip, 'PTR', r.server.ip)
      if (ptr.ok) serverName = toText(ptr.records[0].NameHost).replace(/\.$/, '')
    }
    const head = r.server.ip ? `Server:  ${serverName}\nAddress:  ${r.server.ip}\n\n` : ''
    if (!r.ok) {
      if (r.error === 'timeout') return [psObject('__formatted', { text: `DNS request timed out.\n    timeout was 2 seconds.\nServer:  UnKnown\nAddress:  ${r.server.ip}\n\nDNS request timed out.\n    timeout was 2 seconds.\n*** Request to UnKnown timed-out\n` })]
      if (r.error === 'noserver') return [psObject('__formatted', { text: '*** Default servers are not available\nServer:  UnKnown\nAddress:  127.0.0.1\n\n*** UnKnown can\'t find ' + name + ': No response from server\n' })]
      return [psObject('__formatted', { text: `${head}*** ${serverName} can't find ${name}: Non-existent domain\n` })]
    }
    let body = r.authoritative ? '' : 'Non-authoritative answer:\n'
    if (type === 'SRV') {
      for (const x of r.records) body += `${toText(x.Name)}\tSRV service location:\n          priority       = ${x.Priority}\n          weight         = ${x.Weight}\n          port           = ${x.Port}\n          svr hostname   = ${x.NameTarget}\n`
      for (const x of r.records) {
        const t = ctx.s.lab?.find(toText(x.NameTarget))
        if (t) body += `${toText(x.NameTarget)}\tinternet address = ${t.state.red.ip}\n`
      }
    } else if (type === 'PTR') {
      for (const x of r.records) body += `${toText(x.Name)}\tname = ${toText(x.NameHost).replace(/\.$/, '')}\n`
    } else if (r.records.some((x) => x.Type === 'CNAME')) {
      const c = r.records.find((x) => x.Type === 'CNAME')!
      const a = r.records.filter((x) => x.Type === 'A')
      body += `Name:    ${toText(c.NameHost).replace(/\.$/, '')}\n${a.length ? `Address:  ${toText(a[0].IPAddress)}\n` : ''}Aliases:  ${toText(c.Name)}\n`
    } else {
      const ips = r.records.map((x) => toText(x.IPAddress ?? x.NameHost))
      body += `Name:    ${toText(r.records[0].Name)}\n${ips.length > 1 ? `Addresses:  ${ips.join('\n          ')}` : `Address:  ${ips[0]}`}\n`
    }
    return [psObject('__formatted', { text: `${head}${body}\n` })]
  },
})
