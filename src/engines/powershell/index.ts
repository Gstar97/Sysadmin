import './cmdlets'
import { buildAdStore, ouPathToDn, store } from './ad'
import { psCheckSchema, psStateSchema, type PsCheck, type PsStateInput } from './schema'
import { asArray, PsSession } from './session'
import { psObject, toText, type PsObject } from './values'

export { PsSession, CMDLETS, ALIASES, canonicalName } from './session'
export { psCheckSchema, psStateSchema }

interface ServiceSeed {
  name: string
  display: string
  status: 'Running' | 'Stopped'
  start: 'Automatic' | 'Manual' | 'Disabled'
}

/** Servicios habituales de un Windows Server 2025 recién instalado. */
const BASE_SERVICES: ServiceSeed[] = [
  { name: 'BITS', display: 'Background Intelligent Transfer Service', status: 'Stopped', start: 'Manual' },
  { name: 'CryptSvc', display: 'Cryptographic Services', status: 'Running', start: 'Automatic' },
  { name: 'Dhcp', display: 'DHCP Client', status: 'Running', start: 'Automatic' },
  { name: 'Dnscache', display: 'DNS Client', status: 'Running', start: 'Automatic' },
  { name: 'EventLog', display: 'Windows Event Log', status: 'Running', start: 'Automatic' },
  { name: 'LanmanServer', display: 'Server', status: 'Running', start: 'Automatic' },
  { name: 'LanmanWorkstation', display: 'Workstation', status: 'Running', start: 'Automatic' },
  { name: 'MpsSvc', display: 'Windows Defender Firewall', status: 'Running', start: 'Automatic' },
  { name: 'Netlogon', display: 'Netlogon', status: 'Stopped', start: 'Manual' },
  { name: 'RpcSs', display: 'Remote Procedure Call (RPC)', status: 'Running', start: 'Automatic' },
  { name: 'Schedule', display: 'Task Scheduler', status: 'Running', start: 'Automatic' },
  { name: 'Spooler', display: 'Print Spooler', status: 'Running', start: 'Automatic' },
  { name: 'TermService', display: 'Remote Desktop Services', status: 'Running', start: 'Manual' },
  { name: 'W32Time', display: 'Windows Time', status: 'Running', start: 'Manual' },
  { name: 'WinDefend', display: 'Microsoft Defender Antivirus Service', status: 'Running', start: 'Automatic' },
  { name: 'WinRM', display: 'Windows Remote Management (WS-Management)', status: 'Running', start: 'Automatic' },
  { name: 'wuauserv', display: 'Windows Update', status: 'Stopped', start: 'Manual' },
]

const DC_SERVICES: ServiceSeed[] = [
  { name: 'ADWS', display: 'Active Directory Web Services', status: 'Running', start: 'Automatic' },
  { name: 'DNS', display: 'DNS Server', status: 'Running', start: 'Automatic' },
  { name: 'DFSR', display: 'DFS Replication', status: 'Running', start: 'Automatic' },
  { name: 'Kdc', display: 'Kerberos Key Distribution Center', status: 'Running', start: 'Automatic' },
  { name: 'Netlogon', display: 'Netlogon', status: 'Running', start: 'Automatic' },
  { name: 'NTDS', display: 'Active Directory Domain Services', status: 'Running', start: 'Automatic' },
]

const BASE_FEATURES: [string, string, boolean][] = [
  ['AD-Domain-Services', 'Active Directory Domain Services', false],
  ['DHCP', 'DHCP Server', false],
  ['DNS', 'DNS Server', false],
  ['FileAndStorage-Services', 'File and Storage Services', true],
  ['FS-FileServer', 'File Server', true],
  ['Hyper-V', 'Hyper-V', false],
  ['Web-Server', 'Web Server (IIS)', false],
  ['NET-Framework-45-Core', '.NET Framework 4.8', true],
  ['RSAT-AD-Tools', 'AD DS and AD LDS Tools', false],
  ['RSAT-DNS-Server', 'DNS Server Tools', false],
  ['Telnet-Client', 'Telnet Client', false],
  ['Windows-Defender', 'Microsoft Defender Antivirus', true],
  ['Windows-Server-Backup', 'Windows Server Backup', false],
  ['PowerShellRoot', 'Windows PowerShell', true],
]

function mkProcess(id: number, name: string, cpu: number, memMb: number, si = 0): PsObject {
  return psObject('System.Diagnostics.Process', {
    Handles: 150 + ((id * 37) % 900),
    NPM: 8 + (id % 40),
    PM: Math.round(memMb * 0.8 * 1024 * 1024),
    WorkingSet: Math.round(memMb * 1024 * 1024),
    CPU: cpu,
    Id: id,
    SI: si,
    ProcessName: name,
    Name: name,
  })
}

/** Crea una sesión de PowerShell a partir del estado inicial de un ejercicio. */
export function createPsSession(input: PsStateInput = {}): PsSession {
  const state = psStateSchema.parse(input)
  const s = new PsSession(state)
  const fs = s.fs
  const now = Date.now()

  for (const dir of ['C:\\Windows\\System32', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData', 'C:\\Temp', `${s.home}\\Desktop`, `${s.home}\\Documents`, `${s.home}\\Downloads`, `${s.home}\\AppData\\Local\\Temp`]) fs.mkdirp(dir)
  fs.write('C:\\Windows\\System32\\drivers\\etc\\hosts', '# Copyright (c) 1993-2009 Microsoft Corp.\r\n#\r\n# This is a sample HOSTS file used by Microsoft TCP/IP for Windows.\r\n#\r\n# localhost name resolution is handled within DNS itself.\r\n#\t127.0.0.1       localhost\r\n#\t::1             localhost\r\n')
  const appData = fs.get(`${s.home}\\AppData`)
  if (appData) appData.hidden = true
  for (const [path, spec] of Object.entries(state.archivos)) {
    const full = s.resolvePath(path)
    if (typeof spec === 'string') fs.write(full, spec)
    else if (spec.tipo === 'directorio') fs.mkdirp(full)
    else fs.write(full, spec.contenido ?? '')
  }

  // Servicios
  const services = new Map<string, ServiceSeed>()
  for (const sv of [...BASE_SERVICES, ...(state.ad ? DC_SERVICES : [])]) services.set(sv.name.toLowerCase(), sv)
  const failures = new Map<string, string>()
  for (const sv of state.servicios ?? []) {
    services.set(sv.nombre.toLowerCase(), { name: sv.nombre, display: sv.nombre_visible ?? sv.nombre, status: sv.estado, start: sv.inicio })
    if (sv.falla) failures.set(sv.nombre.toLowerCase(), sv.falla)
  }
  s.data.services = [...services.values()].map((sv) =>
    psObject('System.ServiceProcess.ServiceController', {
      Status: sv.status,
      Name: sv.name,
      DisplayName: sv.display,
      ServiceName: sv.name,
      StartType: sv.start,
      CanStop: sv.status === 'Running',
      __fail: failures.get(sv.name.toLowerCase()),
    }),
  )

  // Procesos
  const procs: PsObject[] = [
    mkProcess(0, 'Idle', 0, 0.01),
    mkProcess(4, 'System', 812.4, 0.2),
    mkProcess(372, 'smss', 0.1, 1.2),
    mkProcess(512, 'csrss', 2.3, 5.4),
    mkProcess(588, 'wininit', 0.2, 6.8),
    mkProcess(664, 'services', 9.8, 9.6),
    mkProcess(684, 'lsass', 25.6, state.ad ? 92 : 18),
    mkProcess(812, 'svchost', 12.5, 24),
    mkProcess(876, 'svchost', 30.1, 41),
    mkProcess(1044, 'svchost', 4.4, 12),
    mkProcess(1520, 'spoolsv', 1.1, 14, 0),
    mkProcess(2236, 'MsMpEng', 141.7, 210),
    mkProcess(3120, 'WmiPrvSE', 3.2, 19),
    mkProcess(3876, 'explorer', 18.9, 96, 1),
    mkProcess(4410, 'powershell', 2.7, 78, 1),
  ]
  if (state.ad) procs.push(mkProcess(2480, 'dns', 6.2, 64), mkProcess(2532, 'Microsoft.ActiveDirectory.WebServices', 4.8, 58))
  let nextPid = 5200
  for (const p of state.procesos ?? []) procs.push(mkProcess(nextPid += 64, p.nombre, p.cpu, p.memoria_mb, 1))
  s.data.processes = procs.filter((p) => p.ProcessName !== 'spoolsv' || services.get('spooler')?.status === 'Running')

  // Roles y características
  const features = new Map(BASE_FEATURES.map(([name, display, installed]) => [name.toLowerCase(), { name, display, installed }]))
  if (state.ad) for (const n of ['AD-Domain-Services', 'DNS', 'RSAT-AD-Tools', 'RSAT-DNS-Server']) features.get(n.toLowerCase())!.installed = true
  for (const f of state.caracteristicas ?? []) features.set(f.nombre.toLowerCase(), { name: f.nombre, display: f.nombre_visible, installed: f.instalada })
  s.data.features = [...features.values()].map((f) => psObject('Microsoft.Windows.ServerManager.Commands.Feature', { DisplayName: f.display, Name: f.name, Installed: f.installed, InstallState: f.installed ? 'Installed' : 'Available', FeatureType: 'Role' }))

  // Usuarios y grupos locales (en un controlador de dominio no hay cuentas locales propias).
  s.data.localUsers = [
    psObject('Microsoft.PowerShell.Commands.LocalUser', { Name: state.usuario, Enabled: true, Description: 'Built-in account for administering the computer/domain', FullName: '' }),
    psObject('Microsoft.PowerShell.Commands.LocalUser', { Name: 'DefaultAccount', Enabled: false, Description: 'A user account managed by the system.', FullName: '' }),
    psObject('Microsoft.PowerShell.Commands.LocalUser', { Name: 'Guest', Enabled: false, Description: 'Built-in account for guest access to the computer/domain', FullName: '' }),
  ]
  const localGroup = (Name: string, Description: string, members: string[]) => psObject('Microsoft.PowerShell.Commands.LocalGroup', { Name, Description, __members: members })
  s.data.localGroups = [
    localGroup('Administrators', 'Administrators have complete and unrestricted access to the computer/domain', [state.usuario]),
    localGroup('Backup Operators', 'Backup Operators can override security restrictions for the sole purpose of backing up or restoring files', []),
    localGroup('Event Log Readers', 'Members of this group can read event logs from local machine', []),
    localGroup('Remote Desktop Users', 'Members in this group are granted the right to logon remotely', []),
    localGroup('Users', 'Users are prevented from making accidental or intentional system-wide changes and can run most applications', []),
  ]

  // Eventos
  const event = (log: string, id: number, level: string, provider: string, message: string, minutes: number) =>
    psObject('System.Diagnostics.Eventing.Reader.EventLogRecord', { TimeCreated: new Date(now - minutes * 60_000), Id: id, LevelDisplayName: level, ProviderName: provider, LogName: log, Message: message })
  s.data.events = [
    event('System', 6005, 'Information', 'EventLog', 'The Event log service was started.', 4320),
    event('System', 6013, 'Information', 'EventLog', 'The system uptime is 259200 seconds.', 1440),
    event('System', 7036, 'Information', 'Service Control Manager', 'The Windows Update service entered the stopped state.', 600),
    event('Application', 1000, 'Information', 'Microsoft-Windows-Security-SPP', 'Offline downlevel migration succeeded.', 3000),
    event('Security', 4624, 'Information', 'Microsoft-Windows-Security-Auditing', `An account was successfully logged on.\r\n\r\nAccount Name: ${state.usuario}`, 15),
    ...state.eventos.map((e) => event(e.log, e.id, e.nivel, e.origen, e.mensaje, e.hace_minutos)),
  ]

  // DNS
  const dnsRecord = (Name: string, Type: string, value: string) =>
    psObject('Microsoft.DnsClient.Commands.DnsRecord', { Name, Type, TTL: 3600, Section: 'Answer', ...(Type === 'CNAME' ? { NameHost: value } : Type === 'MX' ? { NameExchange: value } : { IPAddress: value }) })
  const records: PsObject[] = [dnsRecord('localhost', 'A', '127.0.0.1')]
  if (state.dominio) {
    records.push(dnsRecord(state.dominio, 'A', state.red.ip), dnsRecord(`${state.equipo}.${state.dominio}`.toLowerCase(), 'A', state.red.ip))
    for (const c of state.ad?.equipos ?? []) records.push(dnsRecord(`${c.nombre}.${state.dominio}`.toLowerCase(), 'A', '0.0.0.0'))
  }
  records.push(dnsRecord('www.microsoft.com', 'A', '23.45.229.117'), dnsRecord('learn.microsoft.com', 'A', '13.107.246.53'))
  for (const r of state.dns) records.push(dnsRecord(r.nombre, r.tipo, r.valor))
  s.data.dnsRecords = records

  // Active Directory
  const ad = buildAdStore(s)
  if (ad) s.data.ad = [ad]
  return s
}

export interface CheckResult {
  ok: boolean
  label: string
}

/** Comprueba una verificación de ejercicio contra el estado actual de la sesión. */
export function verifyPs(s: PsSession, raw: PsCheck): CheckResult {
  const check = psCheckSchema.parse(raw)
  if ('archivo' in check) {
    const node = s.fs.get(s.resolvePath(check.archivo))
    if (!check.existe) return { ok: !node, label: `${check.archivo} no existe` }
    let ok = !!node
    if (check.contenido_incluye !== undefined) ok &&= !!node && node.content.includes(check.contenido_incluye)
    return { ok, label: `${check.archivo} existe${check.contenido_incluye !== undefined ? ` y contiene "${check.contenido_incluye}"` : ''}` }
  }
  if ('servicio' in check) {
    const svc = (s.data.services as PsObject[]).find((x) => toText(x.Name).toLowerCase() === check.servicio.toLowerCase())
    let ok = !!svc
    const parts: string[] = []
    if (check.estado) {
      ok &&= svc?.Status === check.estado
      parts.push(check.estado === 'Running' ? 'en ejecución' : 'detenido')
    }
    if (check.inicio) {
      ok &&= svc?.StartType === check.inicio
      parts.push(`inicio ${check.inicio}`)
    }
    return { ok, label: `servicio ${check.servicio}: ${parts.join(', ') || 'existe'}` }
  }
  if ('proceso' in check) {
    const found = (s.data.processes as PsObject[]).some((p) => toText(p.ProcessName).toLowerCase() === check.proceso.toLowerCase())
    return { ok: found === check.existe, label: `proceso ${check.proceso} ${check.existe ? 'en ejecución' : 'detenido'}` }
  }
  if ('caracteristica' in check) {
    const f = (s.data.features as PsObject[]).find((x) => toText(x.Name).toLowerCase() === check.caracteristica.toLowerCase())
    return { ok: !!f && f.Installed === check.instalada, label: `${check.caracteristica} ${check.instalada ? 'instalada' : 'no instalada'}` }
  }
  if ('usuario_ad' in check) {
    if (!s.data.ad?.length) return { ok: false, label: `usuario de AD ${check.usuario_ad}` }
    const st = store(s)
    const u = st.users.find((x) => toText(x.SamAccountName).toLowerCase() === check.usuario_ad.toLowerCase())
    if (!check.existe) return { ok: !u, label: `el usuario de AD ${check.usuario_ad} no existe` }
    let ok = !!u
    const parts: string[] = []
    if (check.habilitado !== undefined) {
      ok &&= u?.Enabled === check.habilitado
      parts.push(check.habilitado ? 'habilitado' : 'deshabilitado')
    }
    if (check.en_grupos) {
      const groups = st.groups.filter((g) => asArray(g.__members).some((m) => toText(m).toLowerCase() === check.usuario_ad.toLowerCase())).map((g) => toText(g.Name).toLowerCase())
      ok &&= check.en_grupos.every((g) => groups.includes(g.toLowerCase()))
      parts.push(`en ${check.en_grupos.join(', ')}`)
    }
    if (check.ou) {
      ok &&= !!u && toText(u.__parent).toLowerCase() === ouPathToDn(check.ou, st.domainDn).toLowerCase()
      parts.push(`en la OU ${check.ou}`)
    }
    if (check.departamento) {
      ok &&= !!u && toText(u.Department).toLowerCase() === check.departamento.toLowerCase()
      parts.push(`departamento ${check.departamento}`)
    }
    return { ok, label: `usuario de AD ${check.usuario_ad}${parts.length ? `: ${parts.join(', ')}` : ' existe'}` }
  }
  if ('grupo_ad' in check) {
    if (!s.data.ad?.length) return { ok: false, label: `grupo de AD ${check.grupo_ad}` }
    const st = store(s)
    const g = st.groups.find((x) => toText(x.Name).toLowerCase() === check.grupo_ad.toLowerCase())
    if (!check.existe) return { ok: !g, label: `el grupo de AD ${check.grupo_ad} no existe` }
    let ok = !!g
    if (g && check.miembros) {
      const members = asArray(g.__members).map((m) => toText(m).toLowerCase())
      ok &&= check.miembros.every((m) => members.includes(m.toLowerCase()))
    }
    return { ok, label: `grupo de AD ${check.grupo_ad}${check.miembros ? ` con ${check.miembros.join(', ')}` : ' existe'}` }
  }
  if ('ou' in check) {
    if (!s.data.ad?.length) return { ok: false, label: `OU ${check.ou}` }
    const st = store(s)
    const dn = ouPathToDn(check.ou, st.domainDn).toLowerCase()
    const exists = st.ous.some((o) => `OU=${toText(o.Name)},${toText(o.__parent)}`.toLowerCase() === dn)
    return { ok: exists === check.existe, label: `la OU ${check.ou} ${check.existe ? 'existe' : 'no existe'}` }
  }
  if ('salida_contiene' in check) return { ok: s.lastOutput.toLowerCase().includes(check.salida_contiene.toLowerCase()), label: `la salida muestra "${check.salida_contiene}"` }
  if ('salida_regex' in check) {
    const re = safeRegex(check.salida_regex, 'mi')
    return { ok: !!re && re.test(s.lastOutput), label: 'la salida tiene el formato esperado' }
  }
  const re = safeRegex(check.comando_usado, 'i')
  return { ok: !!re && s.history.some((h) => re.test(h)), label: 'se usó el comando pedido' }
}

function safeRegex(pattern: string, flags: string): RegExp | undefined {
  try {
    return new RegExp(pattern, flags)
  } catch {
    return undefined
  }
}
