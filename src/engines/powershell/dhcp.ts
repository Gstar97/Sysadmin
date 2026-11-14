/**
 * Módulo DhcpServer y el lado del cliente: ámbitos, exclusiones, reservas, opciones, autorización
 * en Active Directory, conmutación por error entre dos servidores y concesiones. Un equipo con
 * red.dhcp pide dirección al arrancar, con ipconfig /renew o al pasar la placa a DHCP; si nadie
 * le contesta, queda con una dirección APIPA (169.254.x.x).
 */
import type { AdStore } from './ad'
import { connect } from './remoting'
import { asArray, BOOT_HOOKS, cmdlet, PsError, PsSession, psEquals, type CmdletContext } from './session'
import { mac } from './system'
import { formatDate, psObject, toText, VIEWS, type PsObject } from './values'

const param = (ctx: CmdletContext, n: string) => ctx.params.get(n.toLowerCase())
const has = (ctx: CmdletContext, n: string) => ctx.params.has(n.toLowerCase())
const str = (ctx: CmdletContext, n: string) => (has(ctx, n) && param(ctx, n) !== null ? toText(param(ctx, n)) : undefined)
const MOD = 'DhcpServer'

// ---------------------------------------------------------------------------------------
// Direcciones
// ---------------------------------------------------------------------------------------

export function ipNum(ip: string): number {
  return ip.split('.').reduce((a, o) => a * 256 + Number(o), 0) >>> 0
}
export function numIp(n: number): string {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.')
}
export function maskPrefix(mask: string): number {
  return ipNum(mask).toString(2).replace(/0+$/, '').length
}
function prefixMask(p: number): string {
  return numIp(p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0)
}
function networkOf(ip: string, mask: string): string {
  return numIp((ipNum(ip) & ipNum(mask)) >>> 0)
}

// ---------------------------------------------------------------------------------------
// Estado de un servidor DHCP
// ---------------------------------------------------------------------------------------

export interface DhcpLease {
  ip: string
  mac: string
  host: string
  expiry: Date
}

export interface DhcpScope {
  id: string
  name: string
  mask: string
  start: string
  end: string
  state: 'Active' | 'Inactive'
  leaseSeconds: number
  exclusions: [string, string][]
  reservations: { ip: string; mac: string; name: string; description: string }[]
  options: Record<number, string[]>
  /** Compartido entre los dos servidores de una conmutación por error. */
  leases: DhcpLease[]
}

export interface DhcpFailover {
  name: string
  partner: string
  mode: 'LoadBalance' | 'HotStandby'
  role: 'Active' | 'Standby'
  loadBalancePercent: number
  reservePercent: number
  scopes: string[]
}

export interface DhcpServerState {
  scopes: DhcpScope[]
  options: Record<number, string[]>
  failovers: DhcpFailover[]
}

function serviceRunning(s: PsSession, name: string) {
  return ((s.data.services ?? []) as PsObject[]).some((x) => toText(x.Name).toLowerCase() === name.toLowerCase() && x.Status === 'Running')
}

function hasDhcpRole(s: PsSession) {
  return ((s.data.features ?? []) as PsObject[]).some((f) => toText(f.Name).toLowerCase() === 'dhcp' && f.Installed)
}

export function dhcpState(s: PsSession): DhcpServerState {
  return ((s.data.dhcp ??= [{ scopes: [], options: {}, failovers: [] }]) as DhcpServerState[])[0]
}

function domainStore(s: PsSession): (AdStore & { dhcpAuthorized?: { name: string; ip: string }[] }) | undefined {
  return s.data.domainStore?.[0] as (AdStore & { dhcpAuthorized?: { name: string; ip: string }[] }) | undefined
}

/** Un servidor DHCP de un dominio solo entrega direcciones si está autorizado en AD. */
export function isAuthorized(s: PsSession): boolean {
  const st = domainStore(s)
  if (!s.state.dominio || !st) return true
  return (st.dhcpAuthorized ?? []).some((x) => psEquals(x.name.split('.')[0], s.state.equipo) || x.ip === s.state.red.ip)
}

function dhcpTarget(ctx: CmdletContext, cmd: string): PsSession {
  const name = str(ctx, 'ComputerName')
  let t = ctx.s
  if (name && !psEquals(name.split('.')[0], ctx.s.state.equipo) && name !== 'localhost') {
    const r = connect(ctx.s, name)
    if (r instanceof PsError) throw new PsError(`Failed to get version of the DHCP server ${name}.`, 'ConnectionError', `WIN32 1722,${cmd}`, name)
    t = r
  }
  if (!hasDhcpRole(t)) throw new PsError(`Failed to get version of the DHCP server ${t.state.equipo}.`, 'ObjectNotFound', `WIN32 1753,${cmd}`, t.state.equipo)
  if (!serviceRunning(t, 'DHCPServer')) throw new PsError(`Failed to get version of the DHCP server ${t.state.equipo}. The RPC server is unavailable.`, 'ConnectionError', `WIN32 1722,${cmd}`, t.state.equipo)
  return t
}

function findScope(t: PsSession, id: string, cmd: string): DhcpScope {
  const sc = dhcpState(t).scopes.find((x) => x.id === id)
  if (!sc) throw new PsError(`Failed to get the scope ${id} on DHCP server ${t.state.equipo}.`, 'ObjectNotFound', `DHCP 20022,${cmd}`, id)
  return sc
}

function leaseText(sec: number): string {
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d ? `${d}.` : ''}${pad(h)}:${pad(m)}:${pad(sec % 60)}`
}
function parseSpan(v: string): number {
  const m = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})$/.exec(v.trim())
  return m ? Number(m[1] ?? 0) * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]) : 8 * 86400
}

// ---------------------------------------------------------------------------------------
// Autorización y configuración del servidor
// ---------------------------------------------------------------------------------------

cmdlet('Add-DhcpServerInDC', {
  params: ['DnsName', 'IPAddress'],
  switches: ['PassThru'],
  positional: ['DnsName', 'IPAddress'],
  synopsis: 'Adds the computer that runs the DHCP server service to the list of authorized DHCP server services in Active Directory.',
  module: MOD,
  run(ctx) {
    const st = domainStore(ctx.s)
    if (!st) throw new PsError('Failed to initialize directory service access. This computer is not a member of a domain.', 'InvalidOperation', 'DHCP 20070,Add-DhcpServerInDC')
    const name = (str(ctx, 'DnsName') ?? ctx.s.state.equipo).toLowerCase()
    const t = ctx.s.lab?.find(name) ?? ctx.s
    const ip = str(ctx, 'IPAddress') ?? t.state.red.ip
    const fqdn = name.includes('.') ? name : `${name}.${st.domain}`
    st.dhcpAuthorized ??= []
    if (!st.dhcpAuthorized.some((x) => x.name === fqdn)) st.dhcpAuthorized.push({ name: fqdn, ip })
    return []
  },
})

cmdlet('Remove-DhcpServerInDC', {
  params: ['DnsName', 'IPAddress'],
  switches: ['Force'],
  positional: ['DnsName', 'IPAddress'],
  synopsis: 'Deletes the specified DHCP server service from the list of authorized DHCP servers in Active Directory.',
  module: MOD,
  run(ctx) {
    const st = domainStore(ctx.s)
    if (!st) return []
    const name = (str(ctx, 'DnsName') ?? ctx.s.state.equipo).toLowerCase()
    st.dhcpAuthorized = (st.dhcpAuthorized ?? []).filter((x) => !psEquals(x.name.split('.')[0], name.split('.')[0]))
    return []
  },
})

cmdlet('Get-DhcpServerInDC', {
  synopsis: 'Returns a list of DHCP servers authorized in Active Directory.',
  module: MOD,
  run(ctx) {
    const st = domainStore(ctx.s)
    return (st?.dhcpAuthorized ?? []).map((x) => psObject('CimInstance#DhcpServerInDC', { IPAddress: x.ip, DnsName: x.name }))
  },
})
VIEWS['CimInstance#DhcpServerInDC'] = { kind: 'table', columns: [{ label: 'IPAddress', value: (o) => o.IPAddress }, { label: 'DnsName', value: (o) => o.DnsName }] }

cmdlet('Get-DhcpServerSetting', {
  params: ['ComputerName'],
  synopsis: 'Returns DHCP server service configuration information.',
  module: MOD,
  run(ctx) {
    const t = dhcpTarget(ctx, 'Get-DhcpServerSetting')
    return [psObject('__formatted', { text: `\nIsDomainJoined            : ${t.state.dominio ? 'True' : 'False'}\nIsAuthorized              : ${t.state.dominio ? (isAuthorized(t) ? 'True' : 'False') : 'False'}\nDynamicBootp              : True\nRestoreStatus             : False\nConflictDetectionAttempts : 0\nNpsUnreachableAction      : Full\nNapEnabled                : False\nActivatePolicies          : True\n\n` })]
  },
})

// ---------------------------------------------------------------------------------------
// Ámbitos, exclusiones, opciones y reservas
// ---------------------------------------------------------------------------------------

function scopeObject(sc: DhcpScope): PsObject {
  return psObject('CimInstance#DhcpServerv4Scope', { ScopeId: sc.id, SubnetMask: sc.mask, Name: sc.name, State: sc.state, StartRange: sc.start, EndRange: sc.end, LeaseDuration: leaseText(sc.leaseSeconds), __toString: sc.id })
}
VIEWS['CimInstance#DhcpServerv4Scope'] = {
  kind: 'table',
  columns: ['ScopeId', 'SubnetMask', 'Name', 'State', 'StartRange', 'EndRange', 'LeaseDuration'].map((k) => ({ label: k, value: (o: PsObject) => o[k] })),
}

cmdlet('Add-DhcpServerv4Scope', {
  params: ['Name', 'StartRange', 'EndRange', 'SubnetMask', 'State', 'LeaseDuration', 'Description', 'ComputerName'],
  switches: ['PassThru'],
  positional: ['StartRange', 'EndRange', 'SubnetMask', 'Name'],
  synopsis: 'Adds an IPv4 scope on the DHCP server service.',
  module: MOD,
  run(ctx) {
    const t = dhcpTarget(ctx, 'Add-DhcpServerv4Scope')
    const start = str(ctx, 'StartRange')!
    const end = str(ctx, 'EndRange')!
    const mask = str(ctx, 'SubnetMask')!
    const id = networkOf(start, mask)
    if (networkOf(end, mask) !== id || ipNum(end) < ipNum(start)) throw new PsError(`Failed to add scope with start range ${start} and end range ${end}. The range is not valid for the subnet mask ${mask}.`, 'InvalidArgument', 'DHCP 20004,Add-DhcpServerv4Scope', start)
    const d = dhcpState(t)
    if (d.scopes.some((x) => x.id === id)) throw new PsError(`Failed to add scope ${id} on DHCP server ${t.state.equipo}. The specified subnet already exists.`, 'ResourceExists', 'DHCP 20007,Add-DhcpServerv4Scope', id)
    const state = /^inactive$/i.test(str(ctx, 'State') ?? 'Active') ? 'Inactive' : 'Active'
    const sc: DhcpScope = { id, name: str(ctx, 'Name') ?? id, mask, start, end, state, leaseSeconds: has(ctx, 'LeaseDuration') ? parseSpan(str(ctx, 'LeaseDuration')!) : 8 * 86400, exclusions: [], reservations: [], options: {}, leases: [] }
    d.scopes.push(sc)
    return has(ctx, 'PassThru') ? [scopeObject(sc)] : []
  },
})

cmdlet('Get-DhcpServerv4Scope', {
  params: ['ScopeId', 'ComputerName'],
  positional: ['ScopeId'],
  synopsis: 'Returns the IPv4 scope configuration of the specified scopes.',
  module: MOD,
  run(ctx) {
    const t = dhcpTarget(ctx, 'Get-DhcpServerv4Scope')
    const id = str(ctx, 'ScopeId')
    return id ? [scopeObject(findScope(t, id, 'Get-DhcpServerv4Scope'))] : dhcpState(t).scopes.map(scopeObject)
  },
})

cmdlet('Set-DhcpServerv4Scope', {
  params: ['ScopeId', 'Name', 'State', 'LeaseDuration', 'StartRange', 'EndRange', 'ComputerName'],
  switches: ['PassThru'],
  positional: ['ScopeId'],
  synopsis: 'Sets the properties of an existing IPv4 scope.',
  module: MOD,
  run(ctx) {
    const t = dhcpTarget(ctx, 'Set-DhcpServerv4Scope')
    const sc = findScope(t, str(ctx, 'ScopeId')!, 'Set-DhcpServerv4Scope')
    if (has(ctx, 'Name')) sc.name = str(ctx, 'Name')!
    if (has(ctx, 'State')) sc.state = /^inactive$/i.test(str(ctx, 'State')!) ? 'Inactive' : 'Active'
    if (has(ctx, 'LeaseDuration')) sc.leaseSeconds = parseSpan(str(ctx, 'LeaseDuration')!)
    if (has(ctx, 'StartRange')) sc.start = str(ctx, 'StartRange')!
    if (has(ctx, 'EndRange')) sc.end = str(ctx, 'EndRange')!
    return has(ctx, 'PassThru') ? [scopeObject(sc)] : []
  },
})

cmdlet('Remove-DhcpServerv4Scope', {
  params: ['ScopeId', 'ComputerName'],
  switches: ['Force'],
  positional: ['ScopeId'],
  synopsis: 'Deletes the specified IPv4 scopes from the DHCP server service.',
  module: MOD,
  run(ctx) {
    const t = dhcpTarget(ctx, 'Remove-DhcpServerv4Scope')
    const sc = findScope(t, str(ctx, 'ScopeId')!, 'Remove-DhcpServerv4Scope')
    if (dhcpState(t).failovers.some((f) => f.scopes.includes(sc.id))) throw new PsError(`Failed to delete scope ${sc.id}. The scope is part of a failover relationship.`, 'InvalidOperation', 'DHCP 20115,Remove-DhcpServerv4Scope', sc.id)
    const d = dhcpState(t)
    d.scopes = d.scopes.filter((x) => x !== sc)
    return []
  },
})

cmdlet('Add-DhcpServerv4ExclusionRange', {
  params: ['ScopeId', 'StartRange', 'EndRange', 'ComputerName'],
  switches: ['PassThru'],
  positional: ['ScopeId', 'StartRange', 'EndRange'],
  synopsis: 'Adds a range of IPv4 addresses to exclude from distribution in a scope.',
  module: MOD,
  run(ctx) {
    const t = dhcpTarget(ctx, 'Add-DhcpServerv4ExclusionRange')
    const sc = findScope(t, str(ctx, 'ScopeId')!, 'Add-DhcpServerv4ExclusionRange')
    const a = str(ctx, 'StartRange')!
    const b = str(ctx, 'EndRange')!
    if (ipNum(a) < ipNum(sc.start) || ipNum(b) > ipNum(sc.end)) throw new PsError(`Failed to add exclusion range ${a}-${b} to scope ${sc.id}. The range is outside the scope range ${sc.start}-${sc.end}.`, 'InvalidArgument', 'DHCP 20037,Add-DhcpServerv4ExclusionRange', a)
    sc.exclusions.push([a, b])
    return []
  },
})

cmdlet('Get-DhcpServerv4ExclusionRange', {
  params: ['ScopeId', 'ComputerName'],
  positional: ['ScopeId'],
  synopsis: 'Gets the exclusion ranges for a specified IPv4 scope.',
  module: MOD,
  run(ctx) {
    const t = dhcpTarget(ctx, 'Get-DhcpServerv4ExclusionRange')
    const id = str(ctx, 'ScopeId')
    const scopes = id ? [findScope(t, id, 'Get-DhcpServerv4ExclusionRange')] : dhcpState(t).scopes
    return scopes.flatMap((sc) => sc.exclusions.map(([a, b]) => psObject('CimInstance#DhcpServerv4ExclusionRange', { ScopeId: sc.id, StartRange: a, EndRange: b })))
  },
})
VIEWS['CimInstance#DhcpServerv4ExclusionRange'] = { kind: 'table', columns: ['ScopeId', 'StartRange', 'EndRange'].map((k) => ({ label: k, value: (o: PsObject) => o[k] })) }

const OPTION_NAMES: Record<number, [string, string]> = { 3: ['Router', 'IPv4Address'], 6: ['DNS Servers', 'IPv4Address'], 15: ['DNS Domain Name', 'String'], 51: ['Lease', 'DWord'] }

cmdlet('Set-DhcpServerv4OptionValue', {
  params: ['ScopeId', 'Router', 'DnsServer', 'DnsDomain', 'OptionId', 'Value', 'ComputerName'],
  switches: ['Force', 'PassThru'],
  positional: ['OptionId', 'Value'],
  synopsis: 'Sets an IPv4 option value at the server, scope, or reservation level.',
  module: MOD,
  run(ctx) {
    const t = dhcpTarget(ctx, 'Set-DhcpServerv4OptionValue')
    const id = str(ctx, 'ScopeId')
    const target = id ? findScope(t, id, 'Set-DhcpServerv4OptionValue').options : dhcpState(t).options
    if (has(ctx, 'Router')) target[3] = asArray(param(ctx, 'Router')).map(toText)
    if (has(ctx, 'DnsDomain')) target[15] = [str(ctx, 'DnsDomain')!]
    if (has(ctx, 'DnsServer')) {
      const ips = asArray(param(ctx, 'DnsServer')).map(toText)
      // Como Windows: comprueba que cada IP responda como servidor DNS (salvo con -Force).
      if (!has(ctx, 'Force')) {
        for (const ip of ips) {
          const srv = t.lab?.find(ip)
          const ok = srv && ((srv.data.services ?? []) as PsObject[]).some((x) => toText(x.Name) === 'DNS' && x.Status === 'Running')
          if (!ok) throw new PsError(`The DNS server ${ip} is not a valid DNS server.`, 'InvalidArgument', 'DHCP 20055,Set-DhcpServerv4OptionValue', ip)
        }
      }
      target[6] = ips
    }
    if (has(ctx, 'OptionId')) target[Number(str(ctx, 'OptionId'))] = asArray(param(ctx, 'Value')).map(toText)
    return []
  },
})

cmdlet('Get-DhcpServerv4OptionValue', {
  params: ['ScopeId', 'OptionId', 'ComputerName'],
  switches: ['All'],
  positional: ['ScopeId', 'OptionId'],
  synopsis: 'Returns the IPv4 option values for an IPv4 option at the server, scope, or reservation level.',
  module: MOD,
  run(ctx) {
    const t = dhcpTarget(ctx, 'Get-DhcpServerv4OptionValue')
    const id = str(ctx, 'ScopeId')
    const opts = id ? findScope(t, id, 'Get-DhcpServerv4OptionValue').options : dhcpState(t).options
    const all = id ? { ...opts, 51: [String(findScope(t, id, 'Get-DhcpServerv4OptionValue').leaseSeconds)] } : opts
    return Object.entries(all).map(([k, v]) => psObject('CimInstance#DhcpOptionValue', { OptionId: Number(k), Name: OPTION_NAMES[Number(k)]?.[0] ?? `Option ${k}`, Type: OPTION_NAMES[Number(k)]?.[1] ?? 'String', Value: `{${v.join(', ')}}`, VendorClass: '', UserClass: '', PolicyName: '' }))
  },
})
VIEWS['CimInstance#DhcpOptionValue'] = { kind: 'table', columns: ['OptionId', 'Name', 'Type', 'Value', 'VendorClass', 'UserClass', 'PolicyName'].map((k) => ({ label: k, value: (o: PsObject) => o[k] })) }

function normMac(m: string): string {
  const hex = m.replace(/[^0-9a-f]/gi, '').toLowerCase()
  return hex.match(/../g)?.join('-') ?? m.toLowerCase()
}

cmdlet('Add-DhcpServerv4Reservation', {
  params: ['ScopeId', 'IPAddress', 'ClientId', 'Name', 'Description', 'Type', 'ComputerName'],
  switches: ['PassThru'],
  positional: ['ScopeId', 'IPAddress', 'ClientId'],
  synopsis: 'Reserves the specified IPv4 address in the specified scope for the specified client.',
  module: MOD,
  run(ctx) {
    const t = dhcpTarget(ctx, 'Add-DhcpServerv4Reservation')
    const sc = findScope(t, str(ctx, 'ScopeId')!, 'Add-DhcpServerv4Reservation')
    const ip = str(ctx, 'IPAddress')!
    const m = normMac(str(ctx, 'ClientId')!)
    if (networkOf(ip, sc.mask) !== sc.id) throw new PsError(`Failed to add reservation ${ip}. The IP address is not in the scope ${sc.id}.`, 'InvalidArgument', 'DHCP 20020,Add-DhcpServerv4Reservation', ip)
    if (sc.reservations.some((r) => r.ip === ip || r.mac === m)) throw new PsError(`Failed to add reservation ${ip} to scope ${sc.id}. The specified IP address or client ID is already reserved.`, 'ResourceExists', 'DHCP 20022,Add-DhcpServerv4Reservation', ip)
    const taken = sc.leases.find((l) => l.ip === ip && l.mac !== m)
    if (taken) throw new PsError(`Failed to add reservation ${ip} to scope ${sc.id}. The address is leased to another client (${taken.host}).`, 'ResourceExists', 'DHCP 20021,Add-DhcpServerv4Reservation', ip)
    sc.reservations.push({ ip, mac: m, name: str(ctx, 'Name') ?? '', description: str(ctx, 'Description') ?? '' })
    return []
  },
})

cmdlet('Get-DhcpServerv4Reservation', {
  params: ['ScopeId', 'IPAddress', 'ComputerName'],
  positional: ['ScopeId'],
  synopsis: 'Gets IPv4 reservations from the specified scope.',
  module: MOD,
  run(ctx) {
    const t = dhcpTarget(ctx, 'Get-DhcpServerv4Reservation')
    const id = str(ctx, 'ScopeId')
    const scopes = id ? [findScope(t, id, 'Get-DhcpServerv4Reservation')] : dhcpState(t).scopes
    return scopes.flatMap((sc) => sc.reservations.map((r) => psObject('CimInstance#DhcpServerv4Reservation', { IPAddress: r.ip, ScopeId: sc.id, ClientId: r.mac, Name: r.name, Type: 'Both', Description: r.description })))
  },
})
VIEWS['CimInstance#DhcpServerv4Reservation'] = { kind: 'table', columns: ['IPAddress', 'ScopeId', 'ClientId', 'Name', 'Type', 'Description'].map((k) => ({ label: k, value: (o: PsObject) => o[k] })) }

cmdlet('Remove-DhcpServerv4Reservation', {
  params: ['ScopeId', 'IPAddress', 'ClientId', 'ComputerName'],
  positional: ['ScopeId'],
  synopsis: 'Deletes IPv4 reservations.',
  module: MOD,
  run(ctx) {
    const t = dhcpTarget(ctx, 'Remove-DhcpServerv4Reservation')
    for (const sc of dhcpState(t).scopes) sc.reservations = sc.reservations.filter((r) => r.ip !== str(ctx, 'IPAddress') && r.mac !== normMac(str(ctx, 'ClientId') ?? '-'))
    return []
  },
})

cmdlet('Get-DhcpServerv4Lease', {
  params: ['ScopeId', 'IPAddress', 'ClientId', 'ComputerName'],
  switches: ['AllLeases'],
  positional: ['ScopeId'],
  synopsis: 'Gets IPv4 address lease information.',
  module: MOD,
  run(ctx) {
    const t = dhcpTarget(ctx, 'Get-DhcpServerv4Lease')
    const id = str(ctx, 'ScopeId')
    const scopes = id ? [findScope(t, id, 'Get-DhcpServerv4Lease')] : dhcpState(t).scopes
    const out: PsObject[] = []
    for (const sc of scopes) {
      for (const l of sc.leases) {
        const res = sc.reservations.some((r) => r.ip === l.ip)
        out.push(psObject('CimInstance#DhcpServerv4Lease', { IPAddress: l.ip, ScopeId: sc.id, ClientId: l.mac, HostName: l.host, AddressState: res ? 'ActiveReservation' : 'Active', LeaseExpiryTime: res ? '' : formatDate(l.expiry, false) }))
      }
      for (const r of sc.reservations) if (!sc.leases.some((l) => l.ip === r.ip)) out.push(psObject('CimInstance#DhcpServerv4Lease', { IPAddress: r.ip, ScopeId: sc.id, ClientId: r.mac, HostName: r.name, AddressState: 'InactiveReservation', LeaseExpiryTime: '' }))
    }
    return out
  },
})
VIEWS['CimInstance#DhcpServerv4Lease'] = { kind: 'table', columns: ['IPAddress', 'ScopeId', 'ClientId', 'HostName', 'AddressState', 'LeaseExpiryTime'].map((k) => ({ label: k, value: (o: PsObject) => o[k] })) }

function scopeSize(sc: DhcpScope): number {
  let n = ipNum(sc.end) - ipNum(sc.start) + 1
  for (const [a, b] of sc.exclusions) n -= ipNum(b) - ipNum(a) + 1
  return n
}

cmdlet('Get-DhcpServerv4ScopeStatistics', {
  params: ['ScopeId', 'ComputerName'],
  positional: ['ScopeId'],
  synopsis: 'Gets IPv4 scope statistics.',
  module: MOD,
  run(ctx) {
    const t = dhcpTarget(ctx, 'Get-DhcpServerv4ScopeStatistics')
    const id = str(ctx, 'ScopeId')
    const scopes = id ? [findScope(t, id, 'Get-DhcpServerv4ScopeStatistics')] : dhcpState(t).scopes
    return scopes.map((sc) => {
      const total = scopeSize(sc)
      const inUse = sc.leases.length
      return psObject('CimInstance#DhcpServerv4ScopeStatistics', { ScopeId: sc.id, Free: total - inUse - sc.reservations.filter((r) => !sc.leases.some((l) => l.ip === r.ip)).length, InUse: inUse, PercentageInUse: Math.round((inUse / Math.max(1, total)) * 100), Reserved: sc.reservations.length, Pending: 0, SuperscopeName: '' })
    })
  },
})
VIEWS['CimInstance#DhcpServerv4ScopeStatistics'] = { kind: 'table', columns: ['ScopeId', 'Free', 'InUse', 'PercentageInUse', 'Reserved', 'Pending', 'SuperscopeName'].map((k) => ({ label: k, value: (o: PsObject) => o[k] })) }

// ---------------------------------------------------------------------------------------
// Conmutación por error
// ---------------------------------------------------------------------------------------

function cloneConfig(sc: DhcpScope): DhcpScope {
  return { ...sc, exclusions: sc.exclusions.map((e) => [...e] as [string, string]), reservations: sc.reservations.map((r) => ({ ...r })), options: Object.fromEntries(Object.entries(sc.options).map(([k, v]) => [k, [...v]])), leases: sc.leases }
}

cmdlet('Add-DhcpServerv4Failover', {
  params: ['ComputerName', 'Name', 'PartnerServer', 'ScopeId', 'LoadBalancePercent', 'ServerRole', 'ReservePercent', 'MaxClientLeadTime', 'SharedSecret', 'AutoStateTransition', 'StateSwitchInterval'],
  switches: ['Force', 'PassThru'],
  positional: ['ComputerName', 'Name', 'PartnerServer', 'ScopeId'],
  synopsis: 'Adds a new IPv4 failover relationship on the DHCP server service.',
  module: MOD,
  run(ctx) {
    const t = dhcpTarget(ctx, 'Add-DhcpServerv4Failover')
    const partnerName = str(ctx, 'PartnerServer')!
    const p = connect(t, partnerName)
    if (p instanceof PsError || !hasDhcpRole(p) || !serviceRunning(p, 'DHCPServer')) throw new PsError(`Failed to connect to partner DHCP server ${partnerName}.`, 'ConnectionError', 'DHCP 20010,Add-DhcpServerv4Failover', partnerName)
    if (t.state.dominio && !isAuthorized(p)) throw new PsError(`The partner server ${partnerName} is not authorized in Active Directory.`, 'InvalidOperation', 'DHCP 20127,Add-DhcpServerv4Failover', partnerName)
    const ids = asArray(param(ctx, 'ScopeId')).map(toText)
    const scopes = ids.map((id) => findScope(t, id, 'Add-DhcpServerv4Failover'))
    const pd = dhcpState(p)
    for (const sc of scopes) {
      if (pd.scopes.some((x) => x.id === sc.id)) throw new PsError(`Failed to create failover relationship. The scope ${sc.id} already exists on the partner server ${partnerName}.`, 'ResourceExists', 'DHCP 20113,Add-DhcpServerv4Failover', sc.id)
      if (dhcpState(t).failovers.some((f) => f.scopes.includes(sc.id))) throw new PsError(`The scope ${sc.id} is already part of a failover relationship.`, 'ResourceExists', 'DHCP 20112,Add-DhcpServerv4Failover', sc.id)
    }
    const standby = /^standby$/i.test(str(ctx, 'ServerRole') ?? '')
    const name = str(ctx, 'Name') ?? `${t.state.equipo}-${partnerName}`.toLowerCase()
    const mode: DhcpFailover['mode'] = has(ctx, 'ServerRole') ? 'HotStandby' : 'LoadBalance'
    const lb = Number(str(ctx, 'LoadBalancePercent') ?? 50)
    const rp = Number(str(ctx, 'ReservePercent') ?? 5)
    dhcpState(t).failovers.push({ name, partner: p.state.equipo, mode, role: mode === 'HotStandby' && standby ? 'Standby' : 'Active', loadBalancePercent: lb, reservePercent: rp, scopes: ids })
    pd.failovers.push({ name, partner: t.state.equipo, mode, role: mode === 'HotStandby' && !standby ? 'Standby' : 'Active', loadBalancePercent: 100 - lb, reservePercent: rp, scopes: ids })
    for (const sc of scopes) pd.scopes.push(cloneConfig(sc))
    pd.options = { ...dhcpState(t).options, ...pd.options }
    return []
  },
})

cmdlet('Get-DhcpServerv4Failover', {
  params: ['Name', 'ComputerName'],
  positional: ['Name'],
  synopsis: 'Gets the failover relationships configured on the DHCP server service.',
  module: MOD,
  run(ctx) {
    const t = dhcpTarget(ctx, 'Get-DhcpServerv4Failover')
    const name = str(ctx, 'Name')
    const fs = dhcpState(t).failovers.filter((f) => !name || psEquals(f.name, name))
    if (name && !fs.length) throw new PsError(`Failed to get failover relationship ${name} from DHCP server ${t.state.equipo}.`, 'ObjectNotFound', 'DHCP 20114,Get-DhcpServerv4Failover', name)
    return fs.map((f) => {
      const p = t.lab?.find(f.partner)
      const partnerUp = !!p && serviceRunning(p, 'DHCPServer') && p.state.red.conectada
      return psObject('__formatted', { text: `\nName                 : ${f.name}\nPartnerServer        : ${f.partner.toLowerCase()}${t.state.dominio ? `.${t.state.dominio}` : ''}\nMode                 : ${f.mode}\nMessageAuthentication: False\nState                : ${partnerUp ? 'Normal' : 'CommunicationInterrupted'}\nScopeId              : {${f.scopes.join(', ')}}\nMaxClientLeadTime    : 01:00:00\nAutoStateTransition  : False\n${f.mode === 'LoadBalance' ? `LoadBalancePercent   : ${f.loadBalancePercent}\n` : `ServerRole           : ${f.role}\nReservePercent       : ${f.reservePercent}\n`}\n` })
    })
  },
})

cmdlet('Remove-DhcpServerv4Failover', {
  params: ['Name', 'ComputerName'],
  switches: ['Force'],
  positional: ['Name'],
  synopsis: 'Deletes the specified failover relationships.',
  module: MOD,
  run(ctx) {
    const t = dhcpTarget(ctx, 'Remove-DhcpServerv4Failover')
    const f = dhcpState(t).failovers.find((x) => psEquals(x.name, str(ctx, 'Name')))
    if (!f) throw new PsError(`Failed to get failover relationship ${str(ctx, 'Name')}.`, 'ObjectNotFound', 'DHCP 20114,Remove-DhcpServerv4Failover')
    dhcpState(t).failovers = dhcpState(t).failovers.filter((x) => x !== f)
    const p = t.lab?.find(f.partner)
    if (p) {
      const pd = dhcpState(p)
      pd.failovers = pd.failovers.filter((x) => !psEquals(x.name, f.name))
      pd.scopes = pd.scopes.filter((sc) => !f.scopes.includes(sc.id))
    }
    return []
  },
})

cmdlet('Invoke-DhcpServerv4FailoverReplication', {
  params: ['Name', 'ScopeId', 'ComputerName'],
  switches: ['Force'],
  positional: ['Name'],
  synopsis: 'Replicates scope configuration between failover partner servers.',
  module: MOD,
  run(ctx) {
    const t = dhcpTarget(ctx, 'Invoke-DhcpServerv4FailoverReplication')
    const d = dhcpState(t)
    const rels = d.failovers.filter((f) => !has(ctx, 'Name') || psEquals(f.name, str(ctx, 'Name')))
    const done: string[] = []
    for (const f of rels) {
      const p = t.lab?.find(f.partner)
      if (!p) continue
      const pd = dhcpState(p)
      for (const id of f.scopes) {
        const src = d.scopes.find((x) => x.id === id)
        const i = pd.scopes.findIndex((x) => x.id === id)
        if (src && i >= 0) {
          pd.scopes[i] = cloneConfig(src)
          done.push(id)
        }
      }
    }
    if (!has(ctx, 'Force')) ctx.host('[simulador] Sin -Force pide confirmación; se tomó como Sí.\n')
    return done.map((id) => psObject('__formatted', { text: `${id}\n` }))
  },
})

// ---------------------------------------------------------------------------------------
// El cliente: pedir, renovar y liberar
// ---------------------------------------------------------------------------------------

/** Servidores DHCP que pueden atender a un equipo: en su misma red, con el rol corriendo y autorizados. */
function candidateServers(client: PsSession): { srv: PsSession; sc: DhcpScope }[] {
  const out: { srv: PsSession; sc: DhcpScope }[] = []
  const lab = client.lab
  if (!lab || !client.state.red.conectada) return out
  const all = new Set<PsSession>(lab.sessions.values())
  for (const st of lab.states.values()) {
    const x = lab.find(st.equipo)
    if (x) all.add(x)
  }
  for (const srv of all) {
    if (srv === client || !hasDhcpRole(srv) || !serviceRunning(srv, 'DHCPServer') || !srv.state.red.conectada || !isAuthorized(srv)) continue
    for (const sc of dhcpState(srv).scopes) {
      // La misma red de difusión: el servidor está en la red del ámbito.
      if (sc.state === 'Active' && networkOf(srv.state.red.ip, sc.mask) === sc.id) out.push({ srv, sc })
    }
  }
  // En espera activa, el servidor en standby contesta solo si el activo no responde.
  return out.sort((a, b) => standbyRank(a.srv, a.sc) - standbyRank(b.srv, b.sc))
}

function standbyRank(srv: PsSession, sc: DhcpScope): number {
  return dhcpState(srv).failovers.some((f) => f.scopes.includes(sc.id) && f.role === 'Standby') ? 1 : 0
}

function freeAddress(sc: DhcpScope, m: string): string | undefined {
  const res = sc.reservations.find((r) => r.mac === m)
  if (res) return res.ip
  const prev = sc.leases.find((l) => l.mac === m)
  if (prev) return prev.ip
  for (let n = ipNum(sc.start); n <= ipNum(sc.end); n++) {
    const ip = numIp(n)
    if (sc.exclusions.some(([a, b]) => n >= ipNum(a) && n <= ipNum(b))) continue
    if (sc.reservations.some((r) => r.ip === ip)) continue
    if (sc.leases.some((l) => l.ip === ip)) continue
    return ip
  }
  return undefined
}

export interface DhcpResult {
  ok: boolean
  server?: PsSession
  ip?: string
  reason?: 'noserver' | 'full'
}

/** El equipo pide dirección (DISCOVER → OFFER → REQUEST → ACK) y aplica lo que recibe. */
export function dhcpAcquire(client: PsSession): DhcpResult {
  const r = client.state.red
  const m = normMac(mac(client))
  const cands = candidateServers(client)
  let full = false
  for (const { srv, sc } of cands) {
    const ip = freeAddress(sc, m)
    if (!ip) {
      full = true
      continue
    }
    sc.leases = sc.leases.filter((l) => l.mac !== m)
    const host = client.state.dominio ? `${client.state.equipo}.${client.state.dominio}`.toLowerCase() : client.state.equipo
    const lease: DhcpLease = { ip, mac: m, host, expiry: new Date(Date.now() + sc.leaseSeconds * 1000) }
    sc.leases.push(lease)
    // Las concesiones se replican al compañero de conmutación por error.
    for (const f of dhcpState(srv).failovers.filter((x) => x.scopes.includes(sc.id))) {
      const p = srv.lab?.find(f.partner)
      const psc = p && dhcpState(p).scopes.find((x) => x.id === sc.id)
      if (psc && psc.leases !== sc.leases) {
        psc.leases = psc.leases.filter((l) => l.mac !== m)
        psc.leases.push({ ...lease })
      }
    }
    const opts = { ...dhcpState(srv).options, ...sc.options }
    r.dhcp = true
    r.ip = ip
    r.prefijo = maskPrefix(sc.mask)
    r.puerta_enlace = opts[3]?.[0] ?? ''
    r.dns = opts[6] ?? []
    client.data.dhcpLease = [{ server: srv.state.red.ip, obtained: new Date(), expires: lease.expiry, suffix: opts[15]?.[0] ?? '' }]
    return { ok: true, server: srv, ip }
  }
  // Sin respuesta: dirección APIPA.
  r.dhcp = true
  const g = mac(client).split('-')
  r.ip = `169.254.${parseInt(g[4], 16) || 12}.${parseInt(g[5], 16) || 34}`
  r.prefijo = 16
  r.puerta_enlace = ''
  r.dns = []
  client.data.dhcpLease = []
  return { ok: false, reason: full ? 'full' : 'noserver' }
}

export function dhcpRelease(client: PsSession) {
  const m = normMac(mac(client))
  const lab = client.lab
  if (lab) for (const srv of lab.sessions.values()) for (const sc of dhcpState(srv).scopes) sc.leases = sc.leases.filter((l) => l.mac !== m)
  client.state.red.ip = '0.0.0.0'
  client.state.red.puerta_enlace = ''
  client.data.dhcpLease = []
}

/** Datos de la concesión actual para ipconfig /all. */
export function leaseInfo(client: PsSession): { server: string; obtained: Date; expires: Date; suffix: string } | undefined {
  return (client.data.dhcpLease as { server: string; obtained: Date; expires: Date; suffix: string }[] | undefined)?.[0]
}

/** Al arrancar, un equipo con DHCP pide dirección. */
BOOT_HOOKS.push((s) => {
  if (s.state.red.dhcp) dhcpAcquire(s)
})

/** Configuración de DHCP del estado inicial (ámbitos y autorización). */
export function initialDhcp(s: PsSession) {
  const cfg = s.state.dhcp_servidor
  if (!cfg) return
  for (const f of s.data.features as PsObject[]) if (['dhcp', 'rsat-dhcp'].includes(toText(f.Name).toLowerCase())) Object.assign(f, { Installed: true, InstallState: 'Installed' })
  const services = s.data.services as PsObject[]
  if (!services.some((x) => toText(x.Name) === 'DHCPServer')) services.push(psObject('System.ServiceProcess.ServiceController', { Status: cfg.servicio_detenido ? 'Stopped' : 'Running', Name: 'DHCPServer', DisplayName: 'DHCP Server', ServiceName: 'DHCPServer', StartType: 'Automatic', CanStop: !cfg.servicio_detenido }))
  const mods = s.data.modules as string[]
  if (!mods.includes('DhcpServer')) mods.push('DhcpServer')
  const d = dhcpState(s)
  for (const a of cfg.ambitos) {
    const mask = prefixMask(a.prefijo)
    const id = networkOf(a.inicio, mask)
    d.scopes.push({
      id,
      name: a.nombre ?? id,
      mask,
      start: a.inicio,
      end: a.fin,
      state: a.activo ? 'Active' : 'Inactive',
      leaseSeconds: a.duracion_dias * 86400,
      exclusions: a.exclusiones.map((e) => [e[0], e[1]] as [string, string]),
      reservations: a.reservas.map((r) => ({ ip: r.ip, mac: normMac(r.mac), name: r.nombre ?? '', description: '' })),
      options: Object.fromEntries([...(a.puerta_enlace ? [[3, [a.puerta_enlace]]] : []), ...(a.dns.length ? [[6, a.dns]] : []), ...(a.dominio ? [[15, [a.dominio]]] : [])]) as Record<number, string[]>,
      leases: a.concesiones.map((l) => ({ ip: l.ip, mac: normMac(l.mac), host: l.nombre, expiry: new Date(Date.now() + a.duracion_dias * 86_400_000) })),
    })
  }
  if (cfg.autorizado && s.state.dominio) {
    const st = domainStore(s) ?? (s.lab?.adStores.get(s.state.dominio.toLowerCase()) as (AdStore & { dhcpAuthorized?: { name: string; ip: string }[] }) | undefined)
    if (st) {
      st.dhcpAuthorized ??= []
      const fqdn = `${s.state.equipo}.${s.state.dominio}`.toLowerCase()
      if (!st.dhcpAuthorized.some((x) => x.name === fqdn)) st.dhcpAuthorized.push({ name: fqdn, ip: s.state.red.ip })
    }
  }
}
