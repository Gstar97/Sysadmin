/** Consola estilo Cisco IOS sobre el modelo de red simulado. */
import { classfulPrefix, formatIpv4, maskToPrefix, networkOf, parseIpv4, prefixToMask, sameSubnet, wildcardToPrefix } from './ip'
import { defaultVlanName, isRouting, isSwitch, Network, newPort, normalizeIfName, shortIfName, type Device, type Port, type Route } from './model'

export interface IosChunk {
  text: string
  stream: 'out' | 'err'
}

export type IosMode = 'user' | 'priv' | 'config' | 'if' | 'if-range' | 'subif' | 'vlan' | 'router' | 'line'

type ArgType = 'ip' | 'mask' | 'num' | 'word' | 'if' | 'rest'
type El = { kw: string } | { arg: ArgType }

interface Command {
  pattern: string
  run: (args: string[], ctx: RunCtx) => string | void
  /** Solo disponible si se cumple (por ejemplo, switchport solo en puertos de switch). */
  when?: () => boolean
}

interface RunCtx {
  line: string
}

interface Compiled {
  els: El[]
  cmd: Command
}

class Invalid extends Error {
  constructor(public tokenIndex: number) {
    super('invalid')
  }
}

const KW_HELP: Record<string, string> = {
  enable: 'Turn on privileged commands',
  disable: 'Turn off privileged commands',
  exit: 'Exit from the EXEC',
  logout: 'Exit from the EXEC',
  ping: 'Send echo messages',
  traceroute: 'Trace route to destination',
  show: 'Show running system information',
  configure: 'Enter configuration mode',
  terminal: 'Configure from the terminal',
  copy: 'Copy from one file to another',
  write: 'Write running configuration to memory, network, or terminal',
  memory: 'Write to NV memory',
  erase: 'Erase a filesystem',
  reload: 'Halt and perform a cold restart',
  do: 'To run exec commands in config mode',
  end: 'Exit from configure mode',
  hostname: 'Set system\'s network name',
  interface: 'Select an interface to configure',
  range: 'interface range command',
  vlan: 'Vlan commands',
  ip: 'Global IP configuration subcommands',
  route: 'Establish static routes',
  routing: 'Enable IP routing',
  'default-gateway': 'Specify default gateway (if not routing IP)',
  router: 'Enable a routing process',
  ospf: 'Open Shortest Path First (OSPF)',
  secret: 'Assign the privileged level secret',
  password: 'Assign the privileged level password',
  service: 'Modify use of network based services',
  'password-encryption': 'Encrypt system passwords',
  banner: 'Define a login banner',
  motd: 'Set Message of the Day banner',
  line: 'Configure a terminal line',
  console: 'Primary terminal line',
  vty: 'Virtual terminal',
  'domain-name': 'Define the default domain name',
  'domain-lookup': 'Enable IP Domain Name System hostname translation',
  username: 'Establish User Name Authentication',
  crypto: 'Encryption module',
  ssh: 'Configure ssh options',
  no: 'Negate a command or set its defaults',
  address: 'Set the IP address of an interface',
  shutdown: 'Shutdown the selected interface',
  description: 'Interface specific description',
  switchport: 'Set switching mode characteristics',
  mode: 'Set trunking mode of the interface',
  access: 'Set access mode characteristics of the interface',
  trunk: 'Set trunking characteristics of the interface',
  allowed: 'Set allowed VLAN characteristics when interface is in trunking mode',
  native: 'Set trunking native characteristics when interface is in trunking mode',
  encapsulation: 'Set encapsulation type for an interface',
  dot1q: 'IEEE 802.1Q Virtual LAN',
  name: 'Ascii name of the VLAN',
  network: 'Enable routing on an IP network',
  area: 'Set the OSPF area ID',
  'router-id': 'router-id for this OSPF process',
  'passive-interface': 'Suppress routing updates on an interface',
  'default-information': 'Control distribution of default information',
  originate: 'Distribute a default route',
  login: 'Enable password checking',
  local: 'Local password checking',
  transport: 'Define transport protocols for line',
  input: 'Define which protocols to use when connecting to the terminal server',
  'exec-timeout': 'Set the EXEC timeout',
  logging: 'Modify message logging facilities',
  synchronous: 'Synchronized message output',
  'running-config': 'Current operating configuration',
  'startup-config': 'Contents of startup configuration',
  brief: 'Brief summary of IP status and configuration',
  interfaces: 'Interface status and configuration',
  version: 'System hardware and software status',
  cdp: 'CDP information',
  neighbors: 'CDP neighbor entries',
  arp: 'ARP table',
  history: 'Display the session command history',
  clock: 'Display the system clock',
  protocols: 'IP routing protocol process parameters and statistics',
  neighbor: 'Neighbor list',
  'helper-address': 'Specify a destination address for UDP broadcasts',
  speed: 'Configure speed operation.',
  duplex: 'Configure duplex operation.',
  'spanning-tree': 'Spanning Tree Subsystem',
  portfast: 'Spanning tree portfast options',
  nonegotiate: 'Device will not engage in negotiation protocol on this interface',
  'mac-address-table': 'MAC forwarding table',
  'mac': 'MAC configuration',
  'address-table': 'MAC forwarding table',
}

const ARG_HELP: Record<ArgType, string> = {
  ip: 'A.B.C.D',
  mask: 'A.B.C.D',
  num: '<0-4294967295>',
  word: 'WORD',
  if: 'interface',
  rest: 'LINE',
}

function compile(cmd: Command): Compiled {
  const els = cmd.pattern.split(/\s+/).map((t): El => (t.startsWith('<') ? { arg: t.slice(1, -1) as ArgType } : { kw: t }))
  return { els, cmd }
}

const IF_PREFIXES = ['gigabitethernet', 'fastethernet', 'tengigabitethernet', 'ethernet', 'serial', 'loopback', 'port-channel']

interface Tok {
  text: string
  pos: number
}

function tokenize(line: string): Tok[] {
  const out: Tok[] = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) out.push({ text: m[0], pos: m.index })
  // Unir "gigabitEthernet 0/1" en un solo token de interfaz.
  for (let i = 0; i < out.length - 1; i++) {
    const t = out[i].text.toLowerCase()
    const next = out[i + 1].text
    if (!/^[a-z-]+$/.test(t) || !/^\d+(\/\d+)*(\.\d+)?$/.test(next)) continue
    const prev = out[i - 1]?.text.toLowerCase() ?? ''
    const isIfType = IF_PREFIXES.some((p) => p.startsWith(t))
    const isVlanIf = 'vlan'.startsWith(t) && t.length >= 1 && prev.length >= 2 && 'interface'.startsWith(prev)
    if (isIfType || isVlanIf) {
      out.splice(i, 2, { text: `${out[i].text}${next}`, pos: out[i].pos })
    }
  }
  return out
}

function argAccepts(type: ArgType, tok: string): boolean {
  switch (type) {
    case 'ip':
    case 'mask':
      return parseIpv4(tok) !== undefined
    case 'num':
      return /^\d+$/.test(tok)
    case 'if':
      return normalizeIfName(tok) !== undefined
    default:
      return true
  }
}

type MatchResult = { ok: true; cmd: Command; args: string[] } | { ok: false; kind: 'invalid' | 'ambiguous' | 'incomplete'; tokenIndex: number }

interface State {
  c: Compiled
  ei: number
  args: string[]
  rest: boolean
}

function step(states: State[], tok: string): { next: State[]; ambiguous: boolean } {
  const lower = tok.toLowerCase()
  const kwCandidates = new Set<string>()
  for (const s of states) {
    const e = s.c.els[s.ei]
    if (e && 'kw' in e && e.kw.startsWith(lower)) kwCandidates.add(e.kw)
  }
  let chosen: string | undefined
  if (kwCandidates.has(lower)) chosen = lower
  else if (kwCandidates.size === 1) chosen = [...kwCandidates][0]
  const next: State[] = []
  for (const s of states) {
    const e = s.c.els[s.ei]
    if (!e) continue
    if ('kw' in e) {
      if (chosen && e.kw === chosen) next.push({ ...s, ei: s.ei + 1 })
    } else if (e.arg === 'rest') {
      const args = [...s.args]
      if (s.rest) args[args.length - 1] += ` ${tok}`
      else args.push(tok)
      next.push({ ...s, args, rest: true })
    } else if (argAccepts(e.arg, tok)) next.push({ ...s, ei: s.ei + 1, args: [...s.args, tok] })
  }
  return { next, ambiguous: kwCandidates.size > 1 && !chosen }
}

function isComplete(s: State) {
  return s.ei === s.c.els.length || (s.rest && s.ei === s.c.els.length - 1)
}

function matchTokens(tokens: Tok[], cmds: Compiled[]): MatchResult {
  let states: State[] = cmds.map((c) => ({ c, ei: 0, args: [], rest: false }))
  for (let i = 0; i < tokens.length; i++) {
    const { next, ambiguous } = step(states, tokens[i].text)
    if (!next.length) return { ok: false, kind: ambiguous ? 'ambiguous' : 'invalid', tokenIndex: i }
    states = next
  }
  const done = states.find(isComplete)
  if (done) return { ok: true, cmd: done.c.cmd, args: done.args }
  return { ok: false, kind: 'incomplete', tokenIndex: tokens.length }
}

// ---------------------------------------------------------------------------------------
// Utilidades de formato
// ---------------------------------------------------------------------------------------

function vlanRanges(ids: number[]): string {
  const sorted = [...new Set(ids)].sort((a, b) => a - b)
  const out: string[] = []
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    out.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]))
    i = j + 1
  }
  return out.join(',')
}

export function parseVlanList(text: string): number[] | undefined {
  const out: number[] = []
  for (const part of text.split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part)
    if (!m) return undefined
    const a = Number(m[1])
    const b = m[2] ? Number(m[2]) : a
    if (a < 1 || b > 4094 || b < a) return undefined
    for (let v = a; v <= b; v++) out.push(v)
  }
  return out
}

const XLAT = 'dsfd;kfoA,.iyewrkldJKDHSUBsgvca69834ncxv9873254k;fg87'

/** Cifrado "tipo 7" de Cisco (reversible; solo evita que se lea a simple vista). */
export function type7(password: string, seed = 2): string {
  let out = String(seed).padStart(2, '0')
  for (let i = 0; i < password.length; i++) out += (password.charCodeAt(i) ^ XLAT.charCodeAt((seed + i) % XLAT.length)).toString(16).toUpperCase().padStart(2, '0')
  return out
}

/** Hash "tipo 5" simulado (MD5-crypt): el texto es estable para la misma clave, pero no reversible a simple vista. */
function type5(password: string): string {
  const alphabet = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  let h = 0x9e3779b9
  let out = ''
  for (let i = 0; i < 22; i++) {
    for (const ch of password) h = Math.imul(h ^ ch.charCodeAt(0), 2654435761) >>> 0
    h = Math.imul(h ^ (i * 7919), 2246822519) >>> 0
    out += alphabet[h % 64]
  }
  return `$1$mERr$${out}`
}

function macFor(dev: Device, port: Port): string {
  let h = 2166136261
  for (const ch of `${dev.id}/${port.parent ?? port.name}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0
  const hex = `0001${h.toString(16).padStart(8, '0')}`
  return `${hex.slice(0, 4)}.${hex.slice(4, 8)}.${hex.slice(8, 12)}`
}

function platform(d: Device) {
  return d.type === 'router' ? 'C2900' : d.type === 'switch' ? '2960' : '3650'
}

/** Marca de tiempo de los mensajes de log (como "*Oct 27 14:11:48.018"). */
function logStamp(d = new Date()) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const p = (n: number) => String(n).padStart(2, '0')
  return `*${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, '0')}`
}

function clockText(d = new Date()) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const p = (n: number) => String(n).padStart(2, '0')
  return `*${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, '0')} UTC ${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${d.getUTCDate()} ${d.getUTCFullYear()}`
}

// ---------------------------------------------------------------------------------------
// Configuración en texto (show running-config)
// ---------------------------------------------------------------------------------------

export function runningConfig(d: Device): string {
  const L: string[] = []
  const m = d.mgmt
  L.push('!', d.type === 'router' ? 'version 15.1' : 'version 15.0', 'no service timestamps log datetime msec', 'no service timestamps debug datetime msec', m.passwordEncryption ? 'service password-encryption' : 'no service password-encryption', '!', `hostname ${d.hostname}`, '!')
  if (m.enableSecret) L.push(`enable secret 5 ${type5(m.enableSecret)}`)
  if (m.enablePassword) L.push(m.passwordEncryption ? `enable password 7 ${type7(m.enablePassword)}` : `enable password ${m.enablePassword}`)
  if (m.enableSecret || m.enablePassword) L.push('!')
  if (m.domainName) L.push(`ip domain-name ${m.domainName}`)
  if (!m.domainLookup) L.push('no ip domain-lookup')
  if (m.domainName || !m.domainLookup) L.push('!')
  for (const [u, pw] of m.users) L.push(`username ${u} secret 5 ${type5(pw)}`)
  if (m.users.size) L.push('!')
  if (m.rsaBits && m.sshVersion) L.push(`ip ssh version ${m.sshVersion}`, '!')
  if (d.type === 'switch_l3' && d.ipRouting) L.push('ip routing', '!')
  if (isSwitch(d)) L.push('spanning-tree mode pvst', '!')
  const ordered = orderedPorts(d)
  for (const p of ordered) {
    L.push(`interface ${p.name}`)
    if (p.description) L.push(` description ${p.description}`)
    if (p.kind === 'subif' && p.encapVlan !== undefined) L.push(` encapsulation dot1Q ${p.encapVlan}`)
    if (p.kind === 'phys' && isSwitch(d)) {
      if (!p.switchport) L.push(' no switchport')
      else {
        if (p.accessVlan !== 1) L.push(` switchport access vlan ${p.accessVlan}`)
        if (p.nativeVlan !== 1) L.push(` switchport trunk native vlan ${p.nativeVlan}`)
        if (p.allowed !== 'all') L.push(` switchport trunk allowed vlan ${p.allowed.length ? vlanRanges(p.allowed) : 'none'}`)
        if (p.mode) L.push(` switchport mode ${p.mode}`)
      }
    }
    if (p.ip) L.push(` ip address ${formatIpv4(p.ip.ip)} ${formatIpv4(prefixToMask(p.ip.prefix))}`)
    else if (!(p.kind === 'phys' && isSwitch(d) && p.switchport)) L.push(' no ip address')
    for (const h of d.helpers.get(p.name) ?? []) L.push(` ip helper-address ${formatIpv4(h)}`)
    if (p.kind === 'phys' && d.type === 'router') L.push(' duplex auto', ' speed auto')
    if (p.shutdown) L.push(' shutdown')
    L.push('!')
  }
  if (d.ospf) {
    L.push(`router ospf ${d.ospf.pid}`)
    if (d.ospf.routerId !== undefined) L.push(` router-id ${formatIpv4(d.ospf.routerId)}`)
    L.push(' log-adjacency-changes')
    if (d.ospf.passiveDefault) {
      L.push(' passive-interface default')
      for (const p of d.ospf.notPassive) L.push(` no passive-interface ${p}`)
    } else for (const p of d.ospf.passive) L.push(` passive-interface ${p}`)
    for (const n of d.ospf.networks) L.push(` network ${formatIpv4(n.net)} ${formatIpv4(n.wildcard)} area ${n.area}`)
    if (d.ospf.defaultOriginate) L.push(' default-information originate')
    L.push('!')
  }
  if (d.type === 'router' || d.type === 'switch_l3') L.push('ip classless')
  for (const r of d.routes) L.push(`ip route ${formatIpv4(r.net)} ${formatIpv4(prefixToMask(r.prefix))} ${r.exitIf ?? formatIpv4(r.via!)}${r.distance !== 1 ? ` ${r.distance}` : ''}`)
  if (d.gateway !== undefined && isSwitch(d)) L.push(`ip default-gateway ${formatIpv4(d.gateway)}`)
  L.push('!', 'ip flow-export version 9', '!')
  if (m.banner !== undefined) L.push(`banner motd ^C${m.banner}^C`, '!')
  const lineBlock = (name: string, cfg: Device['mgmt']['lines']['con']) => {
    L.push(name)
    if (cfg.password) L.push(m.passwordEncryption ? ` password 7 ${type7(cfg.password, 8)}` : ` password ${cfg.password}`)
    if (cfg.login === 'line') L.push(' login')
    if (cfg.login === 'local') L.push(' login local')
    if (cfg.transport) L.push(` transport input ${cfg.transport}`)
    L.push('!')
  }
  lineBlock('line con 0', m.lines.con)
  if (d.type === 'router') L.push('line aux 0', '!')
  lineBlock('line vty 0 4', m.lines.vty)
  if (isSwitch(d)) {
    L.push('line vty 5 15')
    if (m.lines.vty.login === 'line') L.push(' login')
    if (m.lines.vty.login === 'local') L.push(' login local')
    L.push('!')
  }
  L.push('!', 'end')
  return L.join('\n') + '\n'
}

function orderedPorts(d: Device): Port[] {
  const phys = d.ports.filter((p) => p.kind === 'phys')
  const out: Port[] = []
  for (const p of phys) {
    out.push(p)
    out.push(...d.ports.filter((s) => s.kind === 'subif' && s.parent === p.name))
  }
  out.push(...d.ports.filter((p) => p.kind === 'loopback'))
  out.push(...d.ports.filter((p) => p.kind === 'svi').sort((a, b) => (a.vlan ?? 0) - (b.vlan ?? 0)))
  return out
}

/** Copia profunda de la parte configurable de un equipo (para startup-config y reload). */
function snapshot(d: Device) {
  return structuredClone({ hostname: d.hostname, ports: d.ports, gateway: d.gateway, routes: d.routes, ipRouting: d.ipRouting, ospf: d.ospf, mgmt: { ...d.mgmt, startup: undefined }, helpers: d.helpers })
}

// ---------------------------------------------------------------------------------------
// Sesión
// ---------------------------------------------------------------------------------------

export class IosSession {
  net: Network
  dev: Device
  mode: IosMode = 'user'
  ports: Port[] = []
  vlanCtx: number[] = []
  lineCtx: 'con' | 'vty' = 'con'
  history: string[] = []
  lastOutput = ''
  pendingClear = false
  /** Esperando una contraseña (la terminal oculta lo que se escribe). */
  secretInput = false
  private awaiting?: { kind: 'enable' | 'console'; tries: number }
  private saved = new Map<string, { config: string; snap: ReturnType<typeof snapshot> }>()
  private modeByDevice = new Map<string, IosMode>()

  constructor(net: Network, deviceId: string) {
    this.net = net
    const d = net.device(deviceId)
    if (!d) throw new Error(`No existe el equipo ${deviceId} en la topología`)
    this.dev = d
    for (const dev of net.devices.values()) {
      if (dev.type === 'router' || isSwitch(dev)) this.saved.set(dev.id, { config: runningConfig(dev), snap: snapshot(dev) })
    }
  }

  /** Cambia la consola a otro equipo (como mover el cable de consola). */
  attach(deviceId: string) {
    const d = this.net.device(deviceId)
    if (!d) return
    this.modeByDevice.set(this.dev.id, this.mode)
    this.dev = d
    this.mode = this.modeByDevice.get(d.id) ?? 'user'
    if (this.mode !== 'user' && this.mode !== 'priv') this.mode = 'priv'
    this.awaiting = undefined
    this.secretInput = false
  }

  isSaved(d: Device = this.dev): boolean {
    return this.saved.get(d.id)?.config === runningConfig(d)
  }

  prompt(): string {
    if (this.awaiting) return 'Password: '
    const h = this.dev.hostname
    const suffix: Record<IosMode, string> = {
      user: '>',
      priv: '#',
      config: '(config)#',
      if: '(config-if)#',
      'if-range': '(config-if-range)#',
      subif: '(config-subif)#',
      vlan: '(config-vlan)#',
      router: '(config-router)#',
      line: '(config-line)#',
    }
    return h + suffix[this.mode]
  }

  async run(line: string): Promise<{ chunks: IosChunk[]; refill?: string }> {
    const res = this.exec(line)
    this.lastOutput = res.text
    return { chunks: res.text ? [{ text: res.text, stream: 'out' }] : [], refill: res.refill }
  }

  private exec(raw: string): { text: string; refill?: string } {
    if (this.awaiting) return { text: this.checkPassword(raw) }
    const line = raw.replace(/\s+$/, '')
    if (line.endsWith('?')) return this.help(line.slice(0, -1))
    if (!line.trim()) return { text: '' }
    if (line.trim().startsWith('!')) return { text: '' }
    this.history.push(line)
    const before = this.stateSnapshot()
    const text = this.dispatch(line, this.mode)
    const events = this.events(before)
    return { text: text + events }
  }

  // -------------------------------------------------------------------------------------
  // Contraseñas
  // -------------------------------------------------------------------------------------

  private checkPassword(input: string): string {
    const a = this.awaiting!
    const m = this.dev.mgmt
    if (a.kind === 'enable') {
      const ok = m.enableSecret !== undefined ? input === m.enableSecret : input === m.enablePassword
      if (ok) {
        this.awaiting = undefined
        this.secretInput = false
        this.mode = 'priv'
        return ''
      }
      a.tries++
      if (a.tries >= 3) {
        this.awaiting = undefined
        this.secretInput = false
        return '% Bad secrets\n\n'
      }
      return ''
    }
    if (input === m.lines.con.password) {
      this.awaiting = undefined
      this.secretInput = false
      return '\n'
    }
    a.tries++
    if (a.tries >= 3) {
      a.tries = 0
      return '% Bad passwords\n\nUser Access Verification\n\n'
    }
    return ''
  }

  private loginBanner(): string {
    const m = this.dev.mgmt
    let out = `\n\n${this.dev.hostname} con0 is now available\n\n\n\n\n\nPress RETURN to get started.\n\n\n`
    if (m.banner) out += `${m.banner}\n\n`
    if (m.lines.con.login === 'line' && m.lines.con.password) {
      out += 'User Access Verification\n\n'
      this.awaiting = { kind: 'console', tries: 0 }
      this.secretInput = true
    }
    return out
  }

  // -------------------------------------------------------------------------------------
  // Eventos del sistema (%LINK, %LINEPROTO, %OSPF)
  // -------------------------------------------------------------------------------------

  private stateSnapshot() {
    const ports = new Map(this.dev.ports.map((p) => [p.name, this.net.portState(this.dev, p)]))
    const nbrs = new Map(this.net.ospfNeighbors(this.dev).map((n) => [`${n.rid}|${n.localPort.name}`, n]))
    return { ports, nbrs, hostname: this.dev.hostname }
  }

  private events(before: ReturnType<IosSession['stateSnapshot']>): string {
    let out = ''
    for (const p of orderedPorts(this.dev)) {
      const prev = before.ports.get(p.name)
      const cur = this.net.portState(this.dev, p)
      if (!prev) {
        if (p.kind === 'loopback' || p.kind === 'svi') out += `\n%LINK-5-CHANGED: Interface ${p.name}, changed state to ${cur.status}\n`
        if (cur.protocol === 'up') out += `\n%LINEPROTO-5-UPDOWN: Line protocol on Interface ${p.name}, changed state to up\n`
        continue
      }
      if (prev.status !== cur.status && p.kind !== 'subif') out += `\n%LINK-5-CHANGED: Interface ${p.name}, changed state to ${cur.status}\n`
      if (prev.protocol !== cur.protocol && p.kind !== 'subif') out += `\n%LINEPROTO-5-UPDOWN: Line protocol on Interface ${p.name}, changed state to ${cur.protocol}\n`
    }
    if (this.dev.ospf) {
      const now = this.net.ospfNeighbors(this.dev)
      const pid = this.dev.ospf.pid
      for (const n of now) {
        if (!before.nbrs.has(`${n.rid}|${n.localPort.name}`)) out += `\n${logStamp()}: %OSPF-5-ADJCHG: Process ${pid}, Nbr ${formatIpv4(n.rid)} on ${n.localPort.name} from LOADING to FULL, Loading Done\n`
      }
      for (const [key, n] of before.nbrs) {
        if (!now.some((x) => `${x.rid}|${x.localPort.name}` === key)) out += `\n${logStamp()}: %OSPF-5-ADJCHG: Process ${pid}, Nbr ${formatIpv4(n.rid)} on ${n.localPort.name} from FULL to DOWN, Neighbor Down: Interface down or detached\n`
      }
    }
    return out
  }

  // -------------------------------------------------------------------------------------
  // Despacho de comandos
  // -------------------------------------------------------------------------------------

  private commandsFor(mode: IosMode): Compiled[] {
    const list = this.table(mode).filter((c) => !c.when || c.when())
    return list.map(compile)
  }

  private dispatch(line: string, mode: IosMode): string {
    // Filtros de salida: show ... | include texto
    let filter: ((text: string) => string) | undefined
    let cmdLine = line
    const pipe = line.indexOf('|')
    if (pipe !== -1 && /^\s*(do\s+)?(sh|sho|show|wr|write)/i.test(line)) {
      cmdLine = line.slice(0, pipe)
      const f = /^\s*(i|in|inc|incl|inclu|includ|include|e|ex|exc|excl|exclu|exclud|exclude|b|be|beg|begi|begin|s|se|sec|sect|secti|sectio|section)\s+(.+)$/i.exec(line.slice(pipe + 1))
      if (!f) return `${' '.repeat(this.prompt().length + pipe + 2)}^\n% Invalid input detected at '^' marker.\n\n`
      const kind = f[1][0].toLowerCase()
      const re = safeRegex(f[2].trim())
      filter = (text) => {
        const lines = text.split('\n')
        if (kind === 'i') return lines.filter((l) => re.test(l)).join('\n') + '\n'
        if (kind === 'e') return lines.filter((l) => !re.test(l)).join('\n') + '\n'
        if (kind === 'b') {
          const i = lines.findIndex((l) => re.test(l))
          return i === -1 ? '' : lines.slice(i).join('\n')
        }
        const out: string[] = []
        for (let i = 0; i < lines.length; i++) {
          if (!/^\s/.test(lines[i]) && re.test(lines[i])) {
            out.push(lines[i])
            while (i + 1 < lines.length && /^\s/.test(lines[i + 1])) out.push(lines[++i])
          }
        }
        return out.join('\n') + (out.length ? '\n' : '')
      }
    }
    const tokens = tokenize(cmdLine)
    const cmds = this.commandsFor(mode)
    const res = matchTokens(tokens, cmds)
    if (!res.ok) {
      if (res.kind === 'ambiguous') return `% Ambiguous command:  "${cmdLine.trim()}"\n`
      if (res.kind === 'incomplete') return '% Incomplete command.\n\n'
      if ((mode === 'user' || mode === 'priv') && res.tokenIndex === 0 && tokens.length === 1) {
        const host = tokens[0].text
        return this.dev.mgmt.domainLookup
          ? `Translating "${host}"...domain server (255.255.255.255)\n% Unknown command or computer name, or unable to find computer address\n`
          : `Translating "${host}"\n% Unknown command or computer name, or unable to find computer address\n`
      }
      return this.invalidAt(tokens, res.tokenIndex)
    }
    try {
      const out = res.cmd.run(res.args, { line: cmdLine }) ?? ''
      return filter ? filter(out) : out
    } catch (e) {
      if (e instanceof Invalid) return this.invalidAt(tokens, e.tokenIndex)
      throw e
    }
  }

  private invalidAt(tokens: Tok[], index: number): string {
    const pos = tokens[Math.min(index, tokens.length - 1)]?.pos ?? 0
    return `${' '.repeat(this.prompt().length + pos)}^\n% Invalid input detected at '^' marker.\n\n`
  }

  private help(before: string): { text: string; refill: string } {
    const tokens = tokenize(before)
    const partial = before.length && !/\s$/.test(before) ? tokens.pop()?.text : undefined
    let states: State[] = this.commandsFor(this.mode).map((c) => ({ c, ei: 0, args: [], rest: false }))
    for (const t of tokens) {
      states = step(states, t.text).next
      if (!states.length) return { text: this.invalidAt([...tokens, { text: '', pos: before.length }], tokens.indexOf(t)), refill: before }
    }
    const entries = new Map<string, string>()
    let cr = false
    for (const s of states) {
      if (isComplete(s) && partial === undefined) cr = true
      const e = s.c.els[s.ei]
      if (!e) continue
      if ('kw' in e) {
        if (partial === undefined || e.kw.startsWith(partial.toLowerCase())) entries.set(e.kw, KW_HELP[e.kw] ?? '')
      } else if (partial === undefined) entries.set(ARG_HELP[e.arg], '')
    }
    if (!entries.size && !cr) return { text: '% Unrecognized command\n', refill: before }
    let text = ''
    if (partial !== undefined) text = [...entries.keys()].sort().join('  ') + '\n'
    else {
      for (const [k, v] of [...entries.entries()].sort((a, b) => a[0].localeCompare(b[0]))) text += `  ${k.padEnd(16)} ${v}\n`
      if (cr) text += '  <cr>\n'
    }
    return { text: text + '\n', refill: before }
  }

  /** Autocompletado con Tab: completa la palabra si hay una sola opción. */
  complete(line: string): string | undefined {
    const tokens = tokenize(line)
    if (!tokens.length || /\s$/.test(line)) return undefined
    const last = tokens.pop()!
    let states: State[] = this.commandsFor(this.mode).map((c) => ({ c, ei: 0, args: [], rest: false }))
    for (const t of tokens) states = step(states, t.text).next
    const kws = new Set<string>()
    for (const s of states) {
      const e = s.c.els[s.ei]
      if (e && 'kw' in e && e.kw.startsWith(last.text.toLowerCase())) kws.add(e.kw)
    }
    if (kws.size !== 1) return undefined
    return `${line.slice(0, last.pos)}${[...kws][0]} `
  }

  // -------------------------------------------------------------------------------------
  // Tabla de comandos por modo
  // -------------------------------------------------------------------------------------

  private table(mode: IosMode): Command[] {
    switch (mode) {
      case 'user':
        return [...this.execCommands(false)]
      case 'priv':
        return [...this.execCommands(true)]
      case 'config':
        return [...this.configCommands(), ...this.common()]
      case 'if':
      case 'if-range':
      case 'subif':
        return [...this.interfaceCommands(), ...this.configEntryCommands(), ...this.common()]
      case 'vlan':
        return [
          { pattern: 'name <word>', run: (a) => this.vlanCtx.forEach((v) => this.dev.vlans.set(v, a[0])) },
          { pattern: 'no name', run: () => this.vlanCtx.forEach((v) => this.dev.vlans.set(v, defaultVlanName(v))) },
          ...this.configEntryCommands(),
          ...this.common(),
        ]
      case 'router':
        return [...this.routerCommands(), ...this.configEntryCommands(), ...this.common()]
      case 'line':
        return [...this.lineCommands(), ...this.configEntryCommands(), ...this.common()]
    }
  }

  /** exit, end y do (en todos los modos de configuración). */
  private common(): Command[] {
    return [
      {
        pattern: 'exit',
        run: () => {
          this.mode = this.mode === 'config' ? 'priv' : 'config'
          this.ports = []
          return this.mode === 'priv' ? `${logStamp()}: %SYS-5-CONFIG_I: Configured from console by console\n` : ''
        },
      },
      {
        pattern: 'end',
        run: () => {
          this.mode = 'priv'
          this.ports = []
          return `\n${logStamp()}: %SYS-5-CONFIG_I: Configured from console by console\n`
        },
      },
      { pattern: 'do <rest>', run: (a) => this.dispatch(a[0], 'priv') },
    ]
  }

  /** Comandos de modo configuración que también se pueden usar desde submodos (cambian de submodo). */
  private configEntryCommands(): Command[] {
    return this.configCommands().filter((c) => /^(interface|vlan|router|line|no interface|no vlan|no router)/.test(c.pattern))
  }

  private execCommands(priv: boolean): Command[] {
    const d = () => this.dev
    const cmds: Command[] = [
      {
        pattern: 'enable',
        run: () => {
          if (this.mode === 'priv') return ''
          if (d().mgmt.enableSecret !== undefined || d().mgmt.enablePassword !== undefined) {
            this.awaiting = { kind: 'enable', tries: 0 }
            this.secretInput = true
            return ''
          }
          this.mode = 'priv'
          return ''
        },
      },
      { pattern: 'exit', run: () => this.logout() },
      { pattern: 'logout', run: () => this.logout() },
      { pattern: 'ping <word>', run: (a) => this.ping(a[0]) },
      { pattern: 'traceroute <word>', run: (a) => this.traceroute(a[0]) },
      ...this.showCommands(priv),
    ]
    if (priv) {
      cmds.push(
        { pattern: 'disable', run: () => void (this.mode = 'user') },
        {
          pattern: 'configure terminal',
          run: () => {
            this.mode = 'config'
            return 'Enter configuration commands, one per line.  End with CNTL/Z.\n'
          },
        },
        { pattern: 'copy running-config startup-config', run: () => 'Destination filename [startup-config]? \n' + this.save() },
        { pattern: 'write memory', run: () => this.save() },
        { pattern: 'write', run: () => this.save() },
        {
          pattern: 'erase startup-config',
          run: () => {
            this.saved.set(this.dev.id, { config: '', snap: factorySnapshot(this.dev) })
            return 'Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]\n[OK]\nErase of nvram: complete\n%SYS-7-NV_BLOCK_INIT: Initialized the geometry of nvram\n'
          },
        },
        { pattern: 'reload', run: () => this.reload() },
        {
          pattern: 'clear arp-cache',
          run: () => void this.dev.arp.clear(),
        },
        {
          pattern: 'clear ip ospf process',
          run: () => 'Reset ALL OSPF processes? [no]: yes\n',
        },
      )
    }
    return cmds
  }

  private logout(): string {
    this.mode = 'user'
    return this.loginBanner()
  }

  private save(): string {
    this.saved.set(this.dev.id, { config: runningConfig(this.dev), snap: snapshot(this.dev) })
    return 'Building configuration...\n[OK]\n'
  }

  private reload(): string {
    let out = ''
    if (!this.isSaved()) out += 'System configuration has been modified. Save? [yes/no]: no\n[simulador] No se guardó: los cambios que no estaban en startup-config se pierden al reiniciar.\n'
    out += 'Proceed with reload? [confirm]\n%SYS-5-RELOAD: Reload requested by console. Reload Reason: Reload Command.\n\n'
    const saved = this.saved.get(this.dev.id)
    const snap = structuredClone(saved?.snap ?? factorySnapshot(this.dev))
    Object.assign(this.dev, { hostname: snap.hostname, ports: snap.ports, gateway: snap.gateway, routes: snap.routes, ipRouting: snap.ipRouting, ospf: snap.ospf, helpers: snap.helpers })
    this.dev.mgmt = { ...snap.mgmt, startup: undefined }
    this.dev.arp.clear()
    this.mode = 'user'
    this.pendingClear = false
    return out + 'System Bootstrap, Version 15.1(4)M4, RELEASE SOFTWARE (fc1)\n...\n' + this.loginBanner()
  }

  // -------------------------------------------------------------------------------------
  // show
  // -------------------------------------------------------------------------------------

  private showCommands(priv: boolean): Command[] {
    const cmds: Command[] = [
      { pattern: 'show ip interface brief', run: () => this.showIpIntBrief() },
      { pattern: 'show ip route', run: () => this.showIpRoute() },
      {
        pattern: 'show ip route <word>',
        run: (a) => {
          const kinds: Record<string, string[]> = { ospf: ['O', 'O IA', 'O*E2'], static: ['S', 'S*'], connected: ['C', 'L'] }
          const key = Object.keys(kinds).find((k) => k.startsWith(a[0].toLowerCase()))
          if (!key) throw new Invalid(3)
          return this.showIpRoute(kinds[key])
        },
      },
      { pattern: 'show ip ospf neighbor', run: () => this.showOspfNeighbor() },
      { pattern: 'show ip protocols', run: () => this.showIpProtocols() },
      { pattern: 'show vlan brief', run: () => this.showVlanBrief(), when: () => isSwitch(this.dev) },
      { pattern: 'show vlan', run: () => this.showVlanBrief(), when: () => isSwitch(this.dev) },
      { pattern: 'show interfaces trunk', run: () => this.showTrunk(), when: () => isSwitch(this.dev) },
      { pattern: 'show interfaces <if>', run: (a) => this.showInterface(a[0]) },
      { pattern: 'show cdp neighbors', run: () => this.showCdp() },
      { pattern: 'show arp', run: () => this.showArp() },
      { pattern: 'show ip arp', run: () => this.showArp() },
      { pattern: 'show mac-address-table', run: () => this.showMac(), when: () => isSwitch(this.dev) },
      { pattern: 'show mac address-table', run: () => this.showMac(), when: () => isSwitch(this.dev) },
      { pattern: 'show version', run: () => this.showVersion() },
      { pattern: 'show history', run: () => this.history.map((h) => `  ${h}`).join('\n') + '\n' },
      { pattern: 'show clock', run: () => `${clockText()}\n` },
    ]
    if (priv) {
      cmds.push(
        { pattern: 'show running-config', run: () => this.showRun() },
        { pattern: 'show startup-config', run: () => this.showStartup() },
      )
    }
    return cmds
  }

  private showRun(): string {
    const text = runningConfig(this.dev)
    return `Building configuration...\n\nCurrent configuration : ${text.length} bytes\n${text}\n`
  }

  private showStartup(): string {
    const s = this.saved.get(this.dev.id)
    if (!s?.config) return 'startup-config is not present\n'
    return `Using ${s.config.length} bytes\n${s.config}\n`
  }

  private showIpIntBrief(): string {
    let out = 'Interface              IP-Address      OK? Method Status                Protocol \n'
    for (const p of orderedPorts(this.dev)) {
      const st = this.net.portState(this.dev, p)
      out += `${p.name.padEnd(23)}${(p.ip ? formatIpv4(p.ip.ip) : 'unassigned').padEnd(16)}YES ${(p.ip ? 'manual' : 'unset').padEnd(7)}${st.status.padEnd(22)}${st.protocol} \n`
    }
    return out
  }

  private showVlanBrief(): string {
    let out = '\nVLAN Name                             Status    Ports\n---- -------------------------------- --------- -------------------------------\n'
    const ids = [...this.dev.vlans.keys()].sort((a, b) => a - b)
    for (const id of ids) {
      const ports = this.dev.ports.filter((p) => p.kind === 'phys' && p.switchport && p.accessVlan === id && this.net.effectiveMode(this.dev, p) === 'access').map((p) => shortIfName(p.name))
      const status = id >= 1002 && id <= 1005 ? 'act/unsup' : 'active'
      const lines: string[] = []
      for (let i = 0; i < Math.max(1, ports.length); i += 4) lines.push(ports.slice(i, i + 4).join(', '))
      out += `${String(id).padEnd(5)}${this.dev.vlans.get(id)!.slice(0, 32).padEnd(33)}${status.padEnd(10)}${lines[0]}\n`
      for (const l of lines.slice(1)) out += `${' '.repeat(48)}${l}\n`
    }
    return out + '\n'
  }

  private showTrunk(): string {
    const trunks = this.dev.ports.filter((p) => p.kind === 'phys' && p.switchport && this.net.effectiveMode(this.dev, p) === 'trunk' && this.net.physUp(this.dev, p))
    if (!trunks.length) return ''
    const active = (p: Port) => [...this.dev.vlans.keys()].filter((v) => v < 1002 && this.net.allows(p, v))
    let out = '\nPort        Mode         Encapsulation  Status        Native vlan\n'
    for (const p of trunks) out += `${shortIfName(p.name, 'trunk').padEnd(12)}${(p.mode === 'trunk' ? 'on' : 'auto').padEnd(13)}${'802.1q'.padEnd(15)}${'trunking'.padEnd(14)}${p.nativeVlan}\n`
    out += '\nPort        Vlans allowed on trunk\n'
    for (const p of trunks) out += `${shortIfName(p.name, 'trunk').padEnd(12)}${p.allowed === 'all' ? '1-4094' : p.allowed.length ? vlanRanges(p.allowed) : 'none'}\n`
    out += '\nPort        Vlans allowed and active in management domain\n'
    for (const p of trunks) out += `${shortIfName(p.name, 'trunk').padEnd(12)}${vlanRanges(active(p)) || 'none'}\n`
    out += '\nPort        Vlans in spanning tree forwarding state and not pruned\n'
    for (const p of trunks) out += `${shortIfName(p.name, 'trunk').padEnd(12)}${vlanRanges(active(p)) || 'none'}\n`
    return out + '\n'
  }

  private showInterface(name: string): string {
    const p = this.net.port(this.dev, name)
    if (!p) throw new Invalid(2)
    const st = this.net.portState(this.dev, p)
    const hw = p.kind === 'loopback' ? 'Loopback' : p.kind === 'svi' ? 'EtherSVI' : p.name.startsWith('Fast') ? 'Lance' : 'CN Gigabit Ethernet'
    const mac = macFor(this.dev, p)
    let out = `${p.name} is ${st.status}, line protocol is ${st.protocol}${p.kind === 'phys' && isSwitch(this.dev) ? (st.protocol === 'up' ? ' (connected)' : ' (notconnect)') : ''}\n`
    out += `  Hardware is ${hw}, address is ${mac} (bia ${mac})\n`
    if (p.description) out += `  Description: ${p.description}\n`
    if (p.ip) out += `  Internet address is ${formatIpv4(p.ip.ip)}/${p.ip.prefix}\n`
    if (p.kind === 'subif') out += `  Encapsulation 802.1Q Virtual LAN, Vlan ID  ${p.encapVlan ?? 1}.\n`
    out += `  MTU 1500 bytes, BW ${p.name.startsWith('Fast') ? '100000' : '1000000'} Kbit/sec, DLY 10 usec,\n     reliability 255/255, txload 1/255, rxload 1/255\n`
    if (p.kind === 'phys') out += `  ${st.protocol === 'up' ? 'Full-duplex, 1000Mb/s' : 'Auto-duplex, Auto-speed'}, media type is RJ45\n`
    out += '  5 minute input rate 0 bits/sec, 0 packets/sec\n  5 minute output rate 0 bits/sec, 0 packets/sec\n     0 input errors, 0 CRC, 0 frame, 0 overrun, 0 ignored\n     0 output errors, 0 collisions, 0 interface resets\n'
    return out
  }

  private showIpRoute(codes?: string[]): string {
    const table = this.net.routingTable(this.dev).filter((r) => !codes || codes.includes(r.code))
    let out =
      'Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP\n       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area\n       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2\n       E1 - OSPF external type 1, E2 - OSPF external type 2, E - EGP\n       i - IS-IS, L1 - IS-IS level-1, L2 - IS-IS level-2, ia - IS-IS inter area\n       * - candidate default, U - per-user static route, o - ODR\n       P - periodic downloaded static route\n\n'
    if (!isRouting(this.dev) && this.dev.type !== 'router') {
      const gw = this.dev.gateway
      out = gw !== undefined ? `Default gateway is ${formatIpv4(gw)}\n\nHost               Gateway           Last Use    Total Uses  Interface\nICMP redirect cache is empty\n` : 'Default gateway is not set\n\nHost               Gateway           Last Use    Total Uses  Interface\nICMP redirect cache is empty\n'
      return out
    }
    const def = table.find((r) => r.prefix === 0)
    out += def?.nextHop !== undefined ? `Gateway of last resort is ${formatIpv4(def.nextHop)} to network 0.0.0.0\n\n` : def ? 'Gateway of last resort is 0.0.0.0 to network 0.0.0.0\n\n' : 'Gateway of last resort is not set\n\n'
    const groups = new Map<number, Route[]>()
    for (const r of table.filter((x) => x.prefix > 0)) {
      const major = networkOf(r.net, classfulPrefix(r.net))
      groups.set(major, [...(groups.get(major) ?? []), r])
    }
    const describe = (r: Route) => {
      const dest = `${formatIpv4(r.net)}/${r.prefix}`
      if (r.code === 'C' || r.code === 'L' || ((r.code === 'S' || r.code === 'S*') && r.nextHop === undefined)) return `${dest} is directly connected, ${r.port}`
      if (r.code === 'S' || r.code === 'S*') return `${dest} [${r.distance}/0] via ${formatIpv4(r.nextHop!)}`
      return `${dest} [${r.distance}/${r.metric}] via ${formatIpv4(r.nextHop!)}, 00:0${Math.min(9, 1 + (r.net % 9))}:${String(10 + (r.net % 49)).padStart(2, '0')}, ${r.port}`
    }
    for (const [major, routes] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
      routes.sort((a, b) => a.net - b.net || a.prefix - b.prefix)
      const cp = classfulPrefix(major)
      const single = routes.length === 1 && routes[0].prefix === cp
      if (single) {
        out += `${routes[0].code.padEnd(6)}${describe(routes[0])}\n`
        continue
      }
      const masks = new Set(routes.map((r) => r.prefix))
      out += masks.size > 1 ? `      ${formatIpv4(major)}/${cp} is variably subnetted, ${routes.length} subnets, ${masks.size} masks\n` : `      ${formatIpv4(major)}/${[...masks][0]} is subnetted, ${routes.length} subnets\n`
      for (const r of routes) out += `${r.code.padEnd(9)}${describe(r)}\n`
    }
    if (def) out += `${def.code.padEnd(6)}${describe(def)}\n`
    return out + '\n'
  }

  private showOspfNeighbor(): string {
    if (!this.dev.ospf) return ''
    let out = '\n\nNeighbor ID     Pri   State           Dead Time   Address         Interface\n'
    for (const n of this.net.ospfNeighbors(this.dev)) {
      const state = n.isDr ? 'FULL/DR' : n.isBdr ? 'FULL/BDR' : 'FULL/DROTHER'
      out += `${formatIpv4(n.rid).padEnd(16)}${'1'.padStart(3)}   ${state.padEnd(16)}00:00:3${n.rid % 10}    ${formatIpv4(n.ip).padEnd(16)}${n.localPort.name}\n`
    }
    return out
  }

  private showIpProtocols(): string {
    const o = this.dev.ospf
    if (!o) return '\n'
    const rid = this.net.routerId(this.dev)
    let out = `\nRouting Protocol is "ospf ${o.pid}"\n  Outgoing update filter list for all interfaces is not set\n  Incoming update filter list for all interfaces is not set\n  Router ID ${rid !== undefined ? formatIpv4(rid) : '0.0.0.0'}\n  Number of areas in this router is 1. 1 normal 0 stub 0 nssa\n  Maximum path: 4\n  Routing for Networks:\n`
    for (const n of o.networks) out += `    ${formatIpv4(n.net)} ${formatIpv4(n.wildcard)} area ${n.area}\n`
    const passive = o.passiveDefault ? this.dev.ports.filter((p) => p.ip && !o.notPassive.has(p.name)).map((p) => p.name) : [...o.passive]
    if (passive.length) out += `  Passive Interface(s): \n${passive.map((p) => `    ${p}\n`).join('')}`
    out += '  Routing Information Sources:  \n    Gateway         Distance      Last Update \n'
    for (const n of this.net.ospfNeighbors(this.dev)) out += `    ${formatIpv4(n.rid).padEnd(16)}${'110'.padStart(8)}      00:01:12\n`
    return out + '  Distance: (default is 110)\n\n'
  }

  private showCdp(): string {
    let out = 'Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge\n                  S - Switch, H - Host, I - IGMP, r - Repeater, P - Phone\nDevice ID    Local Intrf   Holdtme    Capability   Platform    Port ID\n'
    for (const p of this.dev.ports.filter((x) => x.kind === 'phys')) {
      if (!this.net.physUp(this.dev, p)) continue
      const peer = this.net.linkOf(this.dev.id, p.name)
      if (!peer || peer.dev.type === 'pc' || peer.dev.type === 'servidor') continue
      const cap = peer.dev.type === 'router' ? 'R' : peer.dev.type === 'switch' ? 'S' : 'R S'
      out += `${peer.dev.hostname.padEnd(13)}${shortIfName(p.name, 'cdp').padEnd(15)}${'155'.padEnd(11)}${cap.padStart(9).padEnd(13)}${platform(peer.dev).padEnd(12)}${shortIfName(peer.port.name, 'cdp')}\n`
    }
    return out
  }

  private showArp(): string {
    let out = 'Protocol  Address          Age (min)  Hardware Addr   Type   Interface\n'
    const rows: [number, string, string, string][] = []
    for (const p of this.net.l3Ports(this.dev)) rows.push([p.ip!.ip, '-', macFor(this.dev, p), p.name])
    for (const [ip, devId] of this.dev.arp) {
      const other = this.net.devices.get(devId)
      const port = other?.ports.find((x) => x.ip?.ip === ip)
      const local = this.net.l3Ports(this.dev).find((x) => sameSubnet(x.ip!.ip, ip, x.ip!.prefix))
      if (other && port && local) rows.push([ip, '0', macFor(other, port), local.name])
    }
    for (const [ip, age, mac, ifn] of rows.sort((a, b) => a[0] - b[0])) out += `Internet  ${formatIpv4(ip).padEnd(17)}${age.padStart(9)}   ${mac.padEnd(16)}ARPA   ${ifn}\n`
    return out
  }

  private showMac(): string {
    let out = '          Mac Address Table\n-------------------------------------------\n\nVlan    Mac Address       Type        Ports\n----    -----------       --------    -----\n'
    for (const p of this.dev.ports.filter((x) => x.kind === 'phys' && x.switchport)) {
      if (!this.net.physUp(this.dev, p)) continue
      const peer = this.net.linkOf(this.dev.id, p.name)
      if (!peer) continue
      const vlan = this.net.effectiveMode(this.dev, p) === 'access' ? p.accessVlan : p.nativeVlan
      out += `${String(vlan).padStart(4)}    ${macFor(peer.dev, peer.port).padEnd(18)}DYNAMIC     ${shortIfName(p.name)}\n`
    }
    return out
  }

  private showVersion(): string {
    const d = this.dev
    const img = d.type === 'router' ? 'C2900 Software (C2900-UNIVERSALK9-M), Version 15.1(4)M4' : d.type === 'switch' ? 'C2960 Software (C2960-LANBASEK9-M), Version 15.0(2)SE4' : 'IOS-XE Software, Catalyst L3 Switch Software (CAT3K_CAA-UNIVERSALK9-M), Version 16.3.2'
    return `Cisco IOS Software, ${img}, RELEASE SOFTWARE (fc1)\nTechnical Support: http://www.cisco.com/techsupport\nCopyright (c) 1986-2016 by Cisco Systems, Inc.\n\n${d.hostname} uptime is 1 hour, 12 minutes\nSystem image file is "flash:${d.type === 'router' ? 'c2900-universalk9-mz.SPA.151-4.M4.bin' : d.type === 'switch' ? 'c2960-lanbasek9-mz.150-2.SE4.bin' : 'cat3k_caa-universalk9.16.03.02.SPA.bin'}"\n\ncisco ${d.type === 'router' ? 'CISCO2911/K9' : d.type === 'switch' ? 'WS-C2960-24TT-L' : 'WS-C3650-24PS'} processor with 491520K bytes of memory.\n${d.ports.filter((p) => p.kind === 'phys').length} Ethernet interfaces\n\nConfiguration register is 0x2102\n\n`
  }

  // -------------------------------------------------------------------------------------
  // ping y traceroute
  // -------------------------------------------------------------------------------------

  private ping(target: string): string {
    const ip = parseIpv4(target)
    if (ip === undefined) {
      return this.dev.mgmt.domainLookup ? `Translating "${target}"...domain server (255.255.255.255)\n% Unrecognized host or address, or protocol not running.\n\n` : `% Unrecognized host or address, or protocol not running.\n\n`
    }
    const hop = this.net.lookup(this.dev, ip)
    const firstArp = 'nextHop' in hop && !this.dev.arp.has(hop.nextHop)
    const r = this.net.ping(this.dev.id, target)
    let marks: string
    let ok = 0
    if (r.ok) {
      marks = firstArp && r.forward.length ? '.!!!!' : '!!!!!'
      ok = marks.split('!').length - 1
    } else marks = r.unreachable ? 'U.U.U' : '.....'
    let out = `Type escape sequence to abort.\nSending 5, 100-byte ICMP Echos to ${formatIpv4(ip)}, timeout is 2 seconds:\n${marks}\nSuccess rate is ${ok * 20} percent (${ok}/5)${ok ? ', round-trip min/avg/max = 0/0/1 ms' : ''}\n\n`
    if (!r.ok && r.reason) out += `[simulador] ${r.reason}\n\n`
    return out
  }

  private traceroute(target: string): string {
    const ip = parseIpv4(target)
    if (ip === undefined) return '% Unrecognized host or address, or protocol not running.\n\n'
    const r = this.net.ping(this.dev.id, target)
    let out = `Type escape sequence to abort.\nTracing the route to ${formatIpv4(ip)}\n\n`
    r.forward.forEach((h, i) => {
      const dev = this.net.devices.get(h.to)!
      const port = this.net.port(dev, h.toPort)
      out += `  ${String(i + 1).padStart(2)}   ${(port?.ip ? formatIpv4(port.ip.ip) : '*').padEnd(16)}0 msec    0 msec    0 msec\n`
    })
    if (!r.ok) {
      for (let i = r.forward.length + 1; i <= r.forward.length + 3; i++) out += `  ${String(i).padStart(2)}   *         *         *\n`
      if (r.reason) out += `\n[simulador] ${r.reason}\n`
    }
    return out + '\n'
  }

  // -------------------------------------------------------------------------------------
  // Configuración global
  // -------------------------------------------------------------------------------------

  private configCommands(): Command[] {
    const d = () => this.dev
    const sw = () => isSwitch(this.dev)
    const l3 = () => this.dev.type === 'router' || this.dev.type === 'switch_l3'
    return [
      {
        pattern: 'hostname <word>',
        run: (a) => {
          d().hostname = a[0]
        },
      },
      { pattern: 'interface <if>', run: (a) => this.enterInterface(a[0], 1) },
      { pattern: 'interface range <rest>', run: (a) => this.enterRange(a[0]) },
      {
        pattern: 'no interface <if>',
        run: (a) => {
          const p = this.net.port(d(), a[0])
          if (!p || p.kind === 'phys') throw new Invalid(2)
          d().ports = d().ports.filter((x) => x !== p)
        },
      },
      { pattern: 'vlan <word>', when: sw, run: (a) => this.enterVlan(a[0]) },
      {
        pattern: 'no vlan <word>',
        when: sw,
        run: (a) => {
          const ids = parseVlanList(a[0])
          if (!ids) throw new Invalid(2)
          for (const v of ids) {
            if (v === 1 || (v >= 1002 && v <= 1005)) return `%Default VLAN ${v} may not be deleted.\n`
            d().vlans.delete(v)
          }
        },
      },
      { pattern: 'ip route <ip> <mask> <word>', when: l3, run: (a) => this.addRoute(a[0], a[1], a[2], 1) },
      { pattern: 'ip route <ip> <mask> <word> <num>', when: l3, run: (a) => this.addRoute(a[0], a[1], a[2], Number(a[3])) },
      {
        pattern: 'no ip route <ip> <mask> <word>',
        when: l3,
        run: (a) => {
          const net = parseIpv4(a[0])!
          const prefix = maskToPrefix(parseIpv4(a[1])!) ?? 32
          d().routes = d().routes.filter((r) => !(r.net === networkOf(net, prefix) && r.prefix === prefix && (formatIpv4(r.via ?? -1) === a[2] || r.exitIf === normalizeIfName(a[2]))))
        },
      },
      {
        pattern: 'ip routing',
        when: l3,
        run: () => {
          d().ipRouting = true
        },
      },
      {
        pattern: 'no ip routing',
        when: () => this.dev.type === 'switch_l3',
        run: () => {
          d().ipRouting = false
        },
      },
      {
        pattern: 'ip default-gateway <ip>',
        run: (a) => {
          d().gateway = parseIpv4(a[0])
        },
      },
      {
        pattern: 'no ip default-gateway',
        run: () => {
          d().gateway = undefined
        },
      },
      {
        pattern: 'router ospf <num>',
        when: l3,
        run: (a) => {
          const pid = Number(a[0])
          if (pid < 1 || pid > 65535) throw new Invalid(2)
          if (d().ospf && d().ospf!.pid !== pid) return '% OSPF: Only one OSPF process is supported in this simulator\n'
          d().ospf ??= { pid, networks: [], passive: new Set(), passiveDefault: false, notPassive: new Set(), defaultOriginate: false }
          this.mode = 'router'
        },
      },
      {
        pattern: 'no router ospf <num>',
        when: l3,
        run: () => {
          d().ospf = undefined
        },
      },
      {
        pattern: 'enable secret <rest>',
        run: (a) => {
          const pw = a[0].replace(/^[05]\s+/, '')
          if (d().mgmt.enablePassword === pw) return 'The enable secret you have chosen is the same as your enable password.\nThis is not recommended.  Re-enter the enable secret.\n\n'
          d().mgmt.enableSecret = pw
        },
      },
      {
        pattern: 'enable password <rest>',
        run: (a) => {
          d().mgmt.enablePassword = a[0].replace(/^[07]\s+/, '')
        },
      },
      {
        pattern: 'no enable secret',
        run: () => {
          d().mgmt.enableSecret = undefined
        },
      },
      {
        pattern: 'no enable password',
        run: () => {
          d().mgmt.enablePassword = undefined
        },
      },
      {
        pattern: 'service password-encryption',
        run: () => {
          d().mgmt.passwordEncryption = true
        },
      },
      {
        pattern: 'no service password-encryption',
        run: () => {
          d().mgmt.passwordEncryption = false
        },
      },
      { pattern: 'banner motd <rest>', run: (a) => this.setBanner(a[0]) },
      {
        pattern: 'no banner motd',
        run: () => {
          d().mgmt.banner = undefined
        },
      },
      { pattern: 'line console <num>', run: () => this.enterLine('con') },
      { pattern: 'line con <num>', run: () => this.enterLine('con') },
      { pattern: 'line vty <num> <num>', run: () => this.enterLine('vty') },
      {
        pattern: 'ip domain-name <word>',
        run: (a) => {
          d().mgmt.domainName = a[0]
        },
      },
      {
        pattern: 'ip domain-lookup',
        run: () => {
          d().mgmt.domainLookup = true
        },
      },
      {
        pattern: 'no ip domain-lookup',
        run: () => {
          d().mgmt.domainLookup = false
        },
      },
      { pattern: 'username <word> secret <rest>', run: (a) => void d().mgmt.users.set(a[0], a[1]) },
      { pattern: 'username <word> password <rest>', run: (a) => void d().mgmt.users.set(a[0], a[1]) },
      { pattern: 'username <word> privilege <num> secret <rest>', run: (a) => void d().mgmt.users.set(a[0], a[2]) },
      { pattern: 'crypto key generate rsa', run: () => this.rsa(1024) },
      { pattern: 'crypto key generate rsa general-keys modulus <num>', run: (a) => this.rsa(Number(a[0])) },
      {
        pattern: 'ip ssh version <num>',
        run: (a) => {
          const v = Number(a[0])
          if (v !== 1 && v !== 2) throw new Invalid(3)
          if (!d().mgmt.rsaBits || (v === 2 && d().mgmt.rsaBits! < 768)) return 'Please create RSA keys to enable SSH (and of atleast 768 bits for SSH v2).\n'
          d().mgmt.sshVersion = v
        },
      },
      { pattern: 'spanning-tree mode <word>', when: sw, run: () => '' },
    ]
  }

  private rsa(bits: number): string {
    const m = this.dev.mgmt
    if (this.dev.hostname === 'Router' || this.dev.hostname === 'Switch') return '% Please define a hostname other than Router.\n'
    if (!m.domainName) return '% Please define a domain-name first.\n'
    m.rsaBits = bits
    return `The name for the keys will be: ${this.dev.hostname}.${m.domainName}\n\n% The key modulus size is ${bits} bits\n% Generating ${bits} bit RSA keys, keys will be non-exportable...[OK]\n\n${logStamp()}: %SSH-5-ENABLED: SSH 1.99 has been enabled\n`
  }

  private setBanner(text: string): string | void {
    const delim = text[0]
    const end = text.indexOf(delim, 1)
    if (end === -1) {
      this.dev.mgmt.banner = text.slice(1)
      return `Enter TEXT message.  End with the character '${delim}'.\n[simulador] Escribe el banner completo en una sola línea, entre dos delimitadores: banner motd #Texto#\n`
    }
    this.dev.mgmt.banner = text.slice(1, end)
  }

  private addRoute(netText: string, maskText: string, via: string, distance: number): string | void {
    const net = parseIpv4(netText)!
    const prefix = maskToPrefix(parseIpv4(maskText)!)
    if (prefix === undefined) return '%Inconsistent address and mask\n'
    if (networkOf(net, prefix) !== net) return '%Inconsistent address and mask\n'
    const viaIp = parseIpv4(via)
    const exitIf = viaIp === undefined ? normalizeIfName(via) : undefined
    if (viaIp === undefined && (!exitIf || !this.net.port(this.dev, exitIf))) throw new Invalid(4)
    this.dev.routes = this.dev.routes.filter((r) => !(r.net === net && r.prefix === prefix && r.via === viaIp && r.exitIf === exitIf))
    this.dev.routes.push({ net, prefix, via: viaIp, exitIf: exitIf ? this.net.port(this.dev, exitIf)!.name : undefined, distance })
  }

  private enterVlan(text: string): string | void {
    const ids = parseVlanList(text)
    if (!ids) throw new Invalid(1)
    for (const v of ids) if (!this.dev.vlans.has(v)) this.dev.vlans.set(v, defaultVlanName(v))
    this.vlanCtx = ids
    this.mode = 'vlan'
  }

  private enterLine(which: 'con' | 'vty') {
    this.lineCtx = which
    this.mode = 'line'
  }

  private enterInterface(name: string, tokenIndex: number): string | void {
    const d = this.dev
    const norm = normalizeIfName(name)
    if (!norm) throw new Invalid(tokenIndex)
    let p = this.net.port(d, norm)
    if (!p) {
      if (/^Loopback\d+$/.test(norm) && d.type !== 'pc') p = this.net.ensurePort(d, norm)
      else if (/^Vlan\d+$/.test(norm) && isSwitch(d)) {
        const vlan = Number(norm.slice(4))
        if (vlan < 1 || vlan > 4094) throw new Invalid(tokenIndex)
        p = { ...newPort(norm, 'svi', false, false), vlan }
        d.ports.push(p)
      } else if (/\.\d+$/.test(norm)) {
        const parent = this.net.port(d, norm.replace(/\.\d+$/, ''))
        if (!parent || parent.kind !== 'phys' || parent.switchport) throw new Invalid(tokenIndex)
        p = this.net.ensurePort(d, norm)
      } else throw new Invalid(tokenIndex)
    }
    this.ports = [p]
    this.mode = p.kind === 'subif' ? 'subif' : 'if'
  }

  private enterRange(text: string): string | void {
    const d = this.dev
    const ports: Port[] = []
    for (const part of text.split(',')) {
      const m = /^\s*([a-z-]+)\s*((?:\d+\/)*)(\d+)\s*(?:-\s*(\d+))?\s*$/i.exec(part)
      if (!m) throw new Invalid(2)
      const from = Number(m[3])
      const to = m[4] ? Number(m[4]) : from
      for (let i = from; i <= to; i++) {
        const p = this.net.port(d, `${m[1]}${m[2]}${i}`)
        if (!p) throw new Invalid(2)
        ports.push(p)
      }
    }
    this.ports = ports
    this.mode = 'if-range'
  }

  // -------------------------------------------------------------------------------------
  // Configuración de interfaces
  // -------------------------------------------------------------------------------------

  private interfaceCommands(): Command[] {
    const each = (fn: (p: Port) => string | void) => () => {
      let out = ''
      for (const p of this.ports) out += fn(p) ?? ''
      return out
    }
    const switchPort = () => isSwitch(this.dev) && this.ports.every((p) => p.kind === 'phys')
    const l2 = () => switchPort() && this.ports.every((p) => p.switchport)
    const canIp = () => this.ports.every((p) => !(p.kind === 'phys' && isSwitch(this.dev) && (this.dev.type === 'switch' || p.switchport)))
    return [
      { pattern: 'ip address <ip> <mask>', when: canIp, run: (a) => this.setIp(a[0], a[1]) },
      { pattern: 'no ip address', when: canIp, run: each((p) => void (p.ip = undefined)) },
      { pattern: 'shutdown', run: each((p) => void (p.shutdown = true)) },
      { pattern: 'no shutdown', run: each((p) => void (p.shutdown = false)) },
      { pattern: 'description <rest>', run: (a) => each((p) => void (p.description = a[0]))() },
      { pattern: 'no description', run: each((p) => void (p.description = undefined)) },
      {
        pattern: 'switchport mode access',
        when: l2,
        run: each((p) => void (p.mode = 'access')),
      },
      {
        pattern: 'switchport mode trunk',
        when: l2,
        run: each((p) => void (p.mode = 'trunk')),
      },
      { pattern: 'switchport mode dynamic <word>', when: l2, run: each((p) => void (p.mode = undefined)) },
      { pattern: 'no switchport mode', when: l2, run: each((p) => void (p.mode = undefined)) },
      {
        pattern: 'switchport access vlan <num>',
        when: l2,
        run: (a) => {
          const v = Number(a[0])
          if (v < 1 || v > 4094) throw new Invalid(3)
          let out = ''
          if (!this.dev.vlans.has(v)) {
            this.dev.vlans.set(v, defaultVlanName(v))
            out = '% Access VLAN does not exist. Creating vlan ' + v + '\n'
          }
          for (const p of this.ports) p.accessVlan = v
          return out
        },
      },
      { pattern: 'no switchport access vlan', when: l2, run: each((p) => void (p.accessVlan = 1)) },
      { pattern: 'switchport trunk allowed vlan <rest>', when: l2, run: (a) => this.setAllowed(a[0]) },
      { pattern: 'no switchport trunk allowed vlan', when: l2, run: each((p) => void (p.allowed = 'all')) },
      {
        pattern: 'switchport trunk native vlan <num>',
        when: l2,
        run: (a) => {
          const v = Number(a[0])
          if (v < 1 || v > 4094) throw new Invalid(4)
          for (const p of this.ports) p.nativeVlan = v
        },
      },
      { pattern: 'no switchport trunk native vlan', when: l2, run: each((p) => void (p.nativeVlan = 1)) },
      { pattern: 'switchport trunk encapsulation dot1q', when: () => l2() && this.dev.type === 'switch_l3', run: () => '' },
      { pattern: 'switchport nonegotiate', when: l2, run: () => '' },
      {
        pattern: 'no switchport',
        when: () => switchPort() && this.dev.type === 'switch_l3',
        run: each((p) => {
          p.switchport = false
        }),
      },
      {
        pattern: 'switchport',
        when: () => switchPort() && this.dev.type === 'switch_l3',
        run: each((p) => {
          p.switchport = true
          p.ip = undefined
        }),
      },
      {
        pattern: 'encapsulation dot1q <num>',
        when: () => this.mode === 'subif',
        run: (a) => {
          const v = Number(a[0])
          if (v < 1 || v > 4094) throw new Invalid(2)
          for (const p of this.ports) p.encapVlan = v
        },
      },
      {
        pattern: 'encapsulation dot1q <num> native',
        when: () => this.mode === 'subif',
        run: (a) => {
          for (const p of this.ports) p.encapVlan = Number(a[0])
        },
      },
      {
        pattern: 'ip helper-address <ip>',
        when: canIp,
        run: (a) =>
          each((p) => {
            const list = this.dev.helpers.get(p.name) ?? []
            const ip = parseIpv4(a[0])!
            if (!list.includes(ip)) this.dev.helpers.set(p.name, [...list, ip])
          })(),
      },
      { pattern: 'no ip helper-address <ip>', when: canIp, run: (a) => each((p) => void this.dev.helpers.set(p.name, (this.dev.helpers.get(p.name) ?? []).filter((x) => x !== parseIpv4(a[0]))))() },
      { pattern: 'speed <word>', when: () => this.ports.every((p) => p.kind === 'phys'), run: () => '' },
      { pattern: 'duplex <word>', when: () => this.ports.every((p) => p.kind === 'phys'), run: () => '' },
      {
        pattern: 'spanning-tree portfast',
        when: l2,
        run: () =>
          '%Warning: portfast should only be enabled on ports connected to a single\n host. Connecting hubs, concentrators, switches, bridges, etc... to this\n interface  when portfast is enabled, can cause temporary bridging loops.\n Use with CAUTION\n\n',
      },
    ]
  }

  private setIp(ipText: string, maskText: string): string | void {
    const ip = parseIpv4(ipText)!
    const mask = parseIpv4(maskText)!
    const prefix = maskToPrefix(mask)
    if (prefix === undefined) return `Bad mask 0x${mask.toString(16).toUpperCase()} for address ${ipText}\n`
    if (prefix < 31 && (networkOf(ip, prefix) === ip || ((ip | ~prefixToMask(prefix)) >>> 0) === ip)) return `Bad mask /${prefix} for address ${ipText}\n`
    for (const p of this.ports) {
      const overlap = this.dev.ports.find((x) => x !== p && x.ip && (sameSubnet(x.ip.ip, ip, Math.min(x.ip.prefix, prefix))))
      if (overlap && this.dev.type !== 'pc') return `% ${formatIpv4(networkOf(ip, prefix))} overlaps with ${overlap.name}\n`
      p.ip = { ip, prefix }
    }
  }

  private setAllowed(text: string): string | void {
    const t = text.trim().toLowerCase()
    for (const p of this.ports) {
      const current = p.allowed === 'all' ? Array.from({ length: 4094 }, (_, i) => i + 1) : p.allowed
      if (t === 'all') p.allowed = 'all'
      else if (t === 'none') p.allowed = []
      else {
        const m = /^(add|remove|except)\s+(.+)$/.exec(t)
        const list = parseVlanList(m ? m[2] : t)
        if (!list) throw new Invalid(4)
        if (!m) p.allowed = list
        else if (m[1] === 'add') p.allowed = [...new Set([...current, ...list])].sort((a, b) => a - b)
        else if (m[1] === 'remove') p.allowed = current.filter((v) => !list.includes(v))
        else p.allowed = Array.from({ length: 4094 }, (_, i) => i + 1).filter((v) => !list.includes(v))
        if (p.allowed.length === 4094) p.allowed = 'all'
      }
    }
  }

  // -------------------------------------------------------------------------------------
  // OSPF y líneas
  // -------------------------------------------------------------------------------------

  private routerCommands(): Command[] {
    const o = () => this.dev.ospf!
    return [
      {
        pattern: 'network <ip> <mask> area <num>',
        run: (a) => {
          const net = parseIpv4(a[0])!
          const wildcard = parseIpv4(a[1])!
          if (wildcardToPrefix(wildcard) === undefined) return '% OSPF: Invalid wildcard mask\n'
          const area = Number(a[2])
          const existing = o().networks.find((n) => n.net === net && n.wildcard === wildcard)
          if (existing && existing.area !== area) return `% OSPF: "network ${a[0]} ${a[1]} area ${existing.area}" is already configured\n`
          if (!existing) o().networks.push({ net, wildcard, area })
        },
      },
      {
        pattern: 'no network <ip> <mask> area <num>',
        run: (a) => {
          o().networks = o().networks.filter((n) => !(n.net === parseIpv4(a[0]) && n.wildcard === parseIpv4(a[1])))
        },
      },
      {
        pattern: 'router-id <ip>',
        run: (a) => {
          const had = this.net.ospfNeighbors(this.dev).length > 0
          o().routerId = parseIpv4(a[0])
          return had ? '% OSPF: Reload or use "clear ip ospf process" command, for this to take effect\n' : ''
        },
      },
      {
        pattern: 'no router-id',
        run: () => {
          o().routerId = undefined
        },
      },
      {
        pattern: 'passive-interface default',
        run: () => {
          o().passiveDefault = true
          o().notPassive.clear()
        },
      },
      {
        pattern: 'no passive-interface default',
        run: () => {
          o().passiveDefault = false
          o().passive.clear()
        },
      },
      {
        pattern: 'passive-interface <if>',
        run: (a) => {
          const p = this.net.port(this.dev, a[0])
          if (!p) throw new Invalid(1)
          if (o().passiveDefault) o().notPassive.delete(p.name)
          else o().passive.add(p.name)
        },
      },
      {
        pattern: 'no passive-interface <if>',
        run: (a) => {
          const p = this.net.port(this.dev, a[0])
          if (!p) throw new Invalid(2)
          if (o().passiveDefault) o().notPassive.add(p.name)
          else o().passive.delete(p.name)
        },
      },
      { pattern: 'default-information originate', run: () => void (o().defaultOriginate = true) },
      { pattern: 'no default-information originate', run: () => void (o().defaultOriginate = false) },
      { pattern: 'log-adjacency-changes', run: () => '' },
      { pattern: 'auto-cost reference-bandwidth <num>', run: () => '% OSPF: Reference bandwidth is changed.\n        Please ensure reference bandwidth is consistent across all routers.\n' },
    ]
  }

  private lineCommands(): Command[] {
    const cfg = () => this.dev.mgmt.lines[this.lineCtx]
    return [
      { pattern: 'password <rest>', run: (a) => void (cfg().password = a[0].replace(/^7\s+/, '')) },
      { pattern: 'no password', run: () => void (cfg().password = undefined) },
      {
        pattern: 'login',
        run: () => {
          cfg().login = 'line'
          return cfg().password ? '' : '% Login disabled on line 0, until \'password\' is set\n'
        },
      },
      { pattern: 'login local', run: () => void (cfg().login = 'local') },
      { pattern: 'no login', run: () => void (cfg().login = 'none') },
      {
        pattern: 'transport input <rest>',
        when: () => this.lineCtx === 'vty',
        run: (a) => {
          const v = a[0].toLowerCase()
          if (!/^(ssh|telnet|all|none|ssh telnet|telnet ssh)$/.test(v)) throw new Invalid(2)
          cfg().transport = v
        },
      },
      { pattern: 'exec-timeout <num> <num>', run: () => '' },
      { pattern: 'logging synchronous', run: () => '' },
    ]
  }
}

function factorySnapshot(d: Device) {
  const copy = structuredClone({ hostname: d.type === 'router' ? 'Router' : 'Switch', ports: d.ports.filter((p) => p.kind === 'phys').map((p) => ({ ...newPort(p.name, 'phys', isSwitch(d), d.type === 'router') })), gateway: undefined, routes: [], ipRouting: d.type === 'router', ospf: undefined, mgmt: { passwordEncryption: false, domainLookup: true, users: new Map<string, string>(), lines: { con: { login: 'none' as const }, vty: { login: 'none' as const } }, startup: undefined }, helpers: new Map<string, number[]>() })
  if (isSwitch(d)) copy.ports.push({ ...newPort('Vlan1', 'svi', false, true), vlan: 1 })
  return copy as ReturnType<typeof snapshot>
}

function safeRegex(text: string): RegExp {
  try {
    return new RegExp(text)
  } catch {
    return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  }
}
