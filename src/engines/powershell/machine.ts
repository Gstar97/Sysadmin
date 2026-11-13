/**
 * Varios equipos en una misma red: el laboratorio que comparten las sesiones de PowerShell
 * (para Invoke-Command, Enter-PSSession, ping y Test-NetConnection), el firewall de Windows y
 * qué puertos escucha cada equipo.
 */
import type { PsServerState } from './schema'
import type { PsSession } from './session'
import { psObject, toText, type PsObject } from './values'

export class Lab {
  states = new Map<string, PsServerState>()
  sessions = new Map<string, PsSession>()
  /** Base de Active Directory de cada dominio (la comparten todos sus controladores y miembros). */
  adStores = new Map<string, unknown>()
  build?: (state: PsServerState, lab: Lab) => PsSession

  register(state: PsServerState) {
    this.states.set(state.equipo.toLowerCase(), state)
  }

  add(s: PsSession) {
    this.sessions.set(s.state.equipo.toLowerCase(), s)
  }

  /** Busca un equipo por nombre, nombre completo (srv02.empresa.local) o IP; lo arma la primera vez. */
  find(target: string): PsSession | undefined {
    const t = target.toLowerCase().replace(/\.$/, '')
    const match = (st: PsServerState) => {
      const n = st.equipo.toLowerCase()
      return n === t || (st.dominio && `${n}.${st.dominio.toLowerCase()}` === t) || st.red.ip === t
    }
    for (const s of this.sessions.values()) if (match(s.state)) return s
    for (const st of this.states.values()) {
      if (!match(st)) continue
      if (!this.build) return undefined
      const s = this.build(st, this)
      return s
    }
    return undefined
  }
}

// ---------------------------------------------------------------------------------------
// Red y firewall
// ---------------------------------------------------------------------------------------

export type Profile = 'Domain' | 'Private' | 'Public'

/** Categoría de la red: con dominio, DomainAuthenticated; si no, la que se eligió (Public por defecto). */
export function networkCategory(s: PsSession): 'Public' | 'Private' | 'DomainAuthenticated' {
  return (s.data.netProfile?.[0] as string | undefined as 'Public' | 'Private' | 'DomainAuthenticated') ?? (s.state.dominio ? 'DomainAuthenticated' : 'Public')
}

export function activeProfile(s: PsSession): Profile {
  const c = networkCategory(s)
  return c === 'DomainAuthenticated' ? 'Domain' : c
}

function ipNum(ip: string): number {
  return ip.split('.').reduce((a, o) => a * 256 + Number(o), 0)
}

export function sameSubnet(a: string, b: string, prefix: number): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(a) || !/^\d+\.\d+\.\d+\.\d+$/.test(b)) return false
  const size = 2 ** (32 - prefix)
  return Math.floor(ipNum(a) / size) === Math.floor(ipNum(b) / size)
}

function portMatches(spec: string | undefined, port: number | undefined): boolean {
  if (port === undefined) return true
  if (!spec || spec === 'Any') return true
  return spec.split(',').some((p) => {
    const [a, b] = p.trim().split('-').map(Number)
    return b ? port >= a && port <= b : port === a
  })
}

function remoteMatches(spec: string, fromIp: string, s: PsSession): boolean {
  if (!spec || spec === 'Any') return true
  return spec.split(',').some((r) => {
    const x = r.trim()
    if (x === 'LocalSubnet') return sameSubnet(fromIp, s.state.red.ip, s.state.red.prefijo)
    if (x.includes('/')) {
      const [net, p] = x.split('/')
      return sameSubnet(fromIp, net, Number(p))
    }
    return x === fromIp
  })
}

/** ¿El firewall de s deja entrar este tráfico? (con el perfil de red activo). */
export function firewallAllows(s: PsSession, proto: 'TCP' | 'UDP' | 'ICMPv4', port: number | undefined, fromIp: string, icmpType = '8'): boolean {
  const profile = activeProfile(s)
  const profiles = s.data.firewallProfiles?.[0] as Record<Profile, boolean> | undefined
  if (profiles && !profiles[profile]) return true
  const rules = (s.data.firewallRules ?? []) as PsObject[]
  const applies = (r: PsObject) =>
    r.Enabled === 'True' &&
    r.Direction === 'Inbound' &&
    (r.__protocol === 'Any' || r.__protocol === proto) &&
    portMatches(r.__port as string | undefined, port) &&
    (proto !== 'ICMPv4' || r.__icmp === undefined || r.__icmp === 'Any' || r.__icmp === icmpType) &&
    (toText(r.Profile) === 'Any' || toText(r.Profile).split(',').map((x) => x.trim()).includes(profile)) &&
    remoteMatches(toText(r.__remote ?? 'Any'), fromIp, s)
  if (rules.some((r) => applies(r) && r.Action === 'Block')) return false
  return rules.some((r) => applies(r) && r.Action === 'Allow')
}

function serviceRunning(s: PsSession, name: string): boolean {
  return ((s.data.services ?? []) as PsObject[]).some((x) => toText(x.Name).toLowerCase() === name.toLowerCase() && x.Status === 'Running')
}

/** Qué escucha cada equipo según sus servicios y roles. */
export function listening(s: PsSession, port: number): boolean {
  const map: Record<number, () => boolean> = {
    53: () => serviceRunning(s, 'DNS'),
    80: () => serviceRunning(s, 'W3SVC'),
    88: () => serviceRunning(s, 'Kdc'),
    135: () => serviceRunning(s, 'RpcSs'),
    389: () => serviceRunning(s, 'NTDS'),
    443: () => serviceRunning(s, 'W3SVC'),
    445: () => serviceRunning(s, 'LanmanServer'),
    636: () => serviceRunning(s, 'NTDS'),
    3268: () => serviceRunning(s, 'NTDS'),
    3389: () => !!s.data.rdp?.[0] && serviceRunning(s, 'TermService'),
    5985: () => !!s.data.winrm?.[0] && serviceRunning(s, 'WinRM'),
  }
  return map[port]?.() ?? ((s.data.extraPorts ?? []) as number[]).includes(port)
}

export interface Reach {
  ok: boolean
  target?: PsSession
  ip: string
  /** Por qué falló: name (no existe), down (apagado o desconectado), firewall, closed (nada escucha). */
  reason?: 'name' | 'down' | 'firewall' | 'closed'
}

/** ¿Llega desde 'from' a 'target' (ping si port es undefined, TCP si no)? Solo para equipos del laboratorio. */
export function reach(from: PsSession, targetName: string, port?: number, proto: 'TCP' | 'UDP' = 'TCP'): Reach {
  const t = from.lab?.find(targetName)
  if (!t) return { ok: false, ip: targetName, reason: 'name' }
  if (t === from) return { ok: true, target: t, ip: t.state.red.ip }
  const ip = t.state.red.ip
  if (!t.state.red.conectada || !from.state.red.conectada) return { ok: false, target: t, ip, reason: 'down' }
  // Con IP de APIPA (169.254.x.x) solo se llega a la propia red de enlace local.
  if (from.state.red.ip.startsWith('169.254.') !== ip.startsWith('169.254.')) return { ok: false, target: t, ip, reason: 'down' }
  if (!sameSubnet(from.state.red.ip, ip, from.state.red.prefijo) && !from.state.red.puerta_enlace) return { ok: false, target: t, ip, reason: 'down' }
  if (port === undefined) return firewallAllows(t, 'ICMPv4', undefined, from.state.red.ip) ? { ok: true, target: t, ip } : { ok: false, target: t, ip, reason: 'firewall' }
  if (!firewallAllows(t, proto, port, from.state.red.ip)) return { ok: false, target: t, ip, reason: 'firewall' }
  if (!listening(t, port)) return { ok: false, target: t, ip, reason: 'closed' }
  return { ok: true, target: t, ip }
}

// ---------------------------------------------------------------------------------------
// Reglas de firewall de fábrica (Windows Server 2025)
// ---------------------------------------------------------------------------------------

export interface RuleSeed {
  name: string
  display: string
  group: string
  enabled: boolean
  proto: 'TCP' | 'UDP' | 'ICMPv4' | 'Any'
  port?: string
  profile?: string
  remote?: string
  action?: 'Allow' | 'Block'
  /** Tipo de ICMP (8: eco, el ping; 3:4: hay que fragmentar). Sin tipo, cualquiera. */
  icmp?: string
}

export const BASE_RULES: RuleSeed[] = [
  { name: 'CoreNet-ICMP4-DUFRAG-In', display: 'Core Networking - Destination Unreachable Fragmentation Needed (ICMPv4-In)', group: 'Core Networking', enabled: true, proto: 'ICMPv4', icmp: '3:4' },
  { name: 'FPS-ICMP4-ERQ-In', display: 'File and Printer Sharing (Echo Request - ICMPv4-In)', group: 'File and Printer Sharing', enabled: false, proto: 'ICMPv4', icmp: '8' },
  { name: 'FPS-SMB-In-TCP', display: 'File and Printer Sharing (SMB-In)', group: 'File and Printer Sharing', enabled: false, proto: 'TCP', port: '445' },
  { name: 'FPS-NB_Session-In-TCP', display: 'File and Printer Sharing (NB-Session-In)', group: 'File and Printer Sharing', enabled: false, proto: 'TCP', port: '139' },
  { name: 'RemoteDesktop-UserMode-In-TCP', display: 'Remote Desktop - User Mode (TCP-In)', group: 'Remote Desktop', enabled: false, proto: 'TCP', port: '3389' },
  { name: 'RemoteDesktop-UserMode-In-UDP', display: 'Remote Desktop - User Mode (UDP-In)', group: 'Remote Desktop', enabled: false, proto: 'UDP', port: '3389' },
  { name: 'WINRM-HTTP-In-TCP', display: 'Windows Remote Management (HTTP-In)', group: 'Windows Remote Management', enabled: true, proto: 'TCP', port: '5985', profile: 'Domain, Private' },
  { name: 'WINRM-HTTP-In-TCP-PUBLIC', display: 'Windows Remote Management (HTTP-In)', group: 'Windows Remote Management', enabled: true, proto: 'TCP', port: '5985', profile: 'Public', remote: 'LocalSubnet' },
  { name: 'WMI-WINMGMT-In-TCP', display: 'Windows Management Instrumentation (WMI-In)', group: 'Windows Management Instrumentation (WMI)', enabled: false, proto: 'TCP', port: '135' },
  { name: 'RemoteEventLogSvc-In-TCP', display: 'Remote Event Log Management (RPC)', group: 'Remote Event Log Management', enabled: false, proto: 'TCP', port: '135' },
  { name: 'RVM-VDS-In-TCP', display: 'Remote Volume Management - Virtual Disk Service (RPC)', group: 'Remote Volume Management', enabled: false, proto: 'TCP', port: '135' },
]

export const DC_RULES: RuleSeed[] = [
  { name: 'ADDS-ICMP4-In', display: 'Active Directory Domain Controller - Echo Request (ICMPv4-In)', group: 'Active Directory Domain Services', enabled: true, proto: 'ICMPv4', icmp: '8' },
  { name: 'ADDS-LDAP-TCP-In', display: 'Active Directory Domain Controller - LDAP (TCP-In)', group: 'Active Directory Domain Services', enabled: true, proto: 'TCP', port: '389' },
  { name: 'ADDS-LDAPS-TCP-In', display: 'Active Directory Domain Controller - Secure LDAP (TCP-In)', group: 'Active Directory Domain Services', enabled: true, proto: 'TCP', port: '636' },
  { name: 'ADDS-LDAPGC-TCP-In', display: 'Active Directory Domain Controller - LDAP for Global Catalog (TCP-In)', group: 'Active Directory Domain Services', enabled: true, proto: 'TCP', port: '3268' },
  { name: 'ADDS-Kerberos-TCP-In', display: 'Kerberos Key Distribution Center (TCP-In)', group: 'Kerberos Key Distribution Center', enabled: true, proto: 'TCP', port: '88' },
  { name: 'ADDS-SMB-In-TCP', display: 'Active Directory Domain Controller - SAM/LSA (NP-TCP-In)', group: 'Active Directory Domain Services', enabled: true, proto: 'TCP', port: '445' },
  { name: 'DNSSrv-TCP-In', display: 'DNS (TCP, Incoming)', group: 'DNS Service', enabled: true, proto: 'TCP', port: '53' },
  { name: 'DNSSrv-UDP-In', display: 'DNS (UDP, Incoming)', group: 'DNS Service', enabled: true, proto: 'UDP', port: '53' },
]

export function ruleObject(r: RuleSeed): PsObject {
  return psObject('MSFT_NetFirewallRule', {
    Name: r.name,
    DisplayName: r.display,
    DisplayGroup: r.group,
    Enabled: r.enabled ? 'True' : 'False',
    Profile: r.profile ?? 'Any',
    Direction: 'Inbound',
    Action: r.action ?? 'Allow',
    PrimaryStatus: 'OK',
    __protocol: r.proto,
    __port: r.port,
    __remote: r.remote ?? 'Any',
    __icmp: r.icmp,
  })
}
