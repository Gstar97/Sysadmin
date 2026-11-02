/**
 * DNS del laboratorio: BIND (named) como autoritativo y Unbound como resolvedor con caché.
 * Cada servidor responde con la configuración y las zonas que cargó al arrancar o recargar
 * (editar un archivo de zona no cambia nada hasta "rndc reload" o reiniciar), respetando
 * listen-on, allow-query, recursion, access-control y el firewall, igual que los de verdad.
 */
import { addrList, parseNamed, type NamedProblem, type NamedStmt } from '../config/named'
import { parseZone, type ParsedZone, type ZoneRecord } from '../config/zone'
import { hostByIp, inbound, inSubnet, routeTo, sourceIp } from './hosts'
import type { System } from './system'
import { ROOT_CRED } from './vfs'

// ---------------------------------------------------------------------------------------
// BIND
// ---------------------------------------------------------------------------------------

export interface NamedZone {
  name: string
  type: string
  file?: string
  path?: string
  zone?: ParsedZone
  /** Error al cargarla (archivo inexistente, sin permiso o con errores). */
  loadError?: string[]
}

export interface NamedConfig {
  confPath: string
  problems: NamedProblem[]
  directory: string
  listenOn: string[]
  listenPort: number
  allowQuery: string[]
  allowRecursion?: string[]
  recursion: boolean
  forwarders: string[]
  acls: Record<string, string[]>
  zones: NamedZone[]
}

export function namedConfPath(sys: System) {
  return sys.distro === 'rocky' ? '/etc/named.conf' : '/etc/bind/named.conf'
}

function read(sys: System, path: string): string | undefined {
  try {
    return sys.vfs.readFile(path, ROOT_CRED)
  } catch {
    return undefined
  }
}

/** named.conf con sus include, ya interpretado. */
export function readNamedConfig(sys: System, confPath = namedConfPath(sys)): NamedConfig {
  const problems: NamedProblem[] = []
  const stmts: NamedStmt[] = []
  const visit = (path: string, depth: number) => {
    const text = read(sys, path)
    if (text === undefined) {
      problems.push({ file: path, line: 0, severity: 'error', bind: `open: ${path}: file not found`, explicacion: `No existe ${path}.` })
      return
    }
    const r = parseNamed(text, path)
    problems.push(...r.problems)
    for (const s of r.tree) {
      if (s.name === 'include' && depth < 8) {
        const inc = s.args[0] ?? ''
        if (inc.includes('crypto-policies') || inc.endsWith('.key')) continue
        visit(inc.startsWith('/') ? inc : `${path.slice(0, path.lastIndexOf('/'))}/${inc}`, depth + 1)
      } else stmts.push(s)
    }
  }
  visit(confPath, 0)
  const options = stmts.filter((s) => s.name === 'options').flatMap((s) => s.block ?? [])
  const opt = (n: string) => options.find((o) => o.name === n)
  const directory = opt('directory')?.args[0] ?? (sys.distro === 'rocky' ? '/var/named' : '/var/cache/bind')
  const listen = opt('listen-on')
  const portIdx = listen?.args.indexOf('port') ?? -1
  const acls: Record<string, string[]> = {}
  for (const a of stmts.filter((s) => s.name === 'acl')) if (a.args[0]) acls[a.args[0]] = addrList(a) ?? []
  const zones: NamedZone[] = []
  for (const z of stmts.filter((s) => s.name === 'zone')) {
    const name = (z.args[0] ?? '').toLowerCase().replace(/\.$/, '')
    const type = z.block?.find((o) => o.name === 'type')?.args[0] ?? ''
    const file = z.block?.find((o) => o.name === 'file')?.args[0]
    zones.push({ name, type, file, path: file ? (file.startsWith('/') ? file : `${directory}/${file}`) : undefined })
  }
  return {
    confPath,
    problems,
    directory,
    listenOn: addrList(listen) ?? ['any'],
    listenPort: portIdx >= 0 ? Number(listen!.args[portIdx + 1]) : 53,
    allowQuery: addrList(opt('allow-query')) ?? ['any'],
    allowRecursion: addrList(opt('allow-recursion')),
    recursion: (opt('recursion')?.args[0] ?? 'yes') === 'yes',
    forwarders: (addrList(opt('forwarders')) ?? []).map((x) => x.split(' ')[0]),
    acls,
    zones,
  }
}

/** Carga los archivos de zona como lo hace named (con el usuario named, que tiene que poder leerlos). */
export function loadZones(sys: System, conf: NamedConfig) {
  const user = sys.users.has('named') ? 'named' : sys.users.has('bind') ? 'bind' : 'root'
  const cred = sys.credFor(user)
  for (const z of conf.zones) {
    if (!['primary', 'master'].includes(z.type) || !z.path) continue
    if (!sys.vfs.exists(z.path)) {
      z.loadError = [`zone ${z.name}/IN: loading from master file ${z.file} failed: file not found`, `zone ${z.name}/IN: not loaded due to errors.`]
      continue
    }
    let text: string
    try {
      text = sys.vfs.readFile(z.path, cred)
    } catch {
      z.loadError = [`zone ${z.name}/IN: loading from master file ${z.file} failed: permission denied`, `zone ${z.name}/IN: not loaded due to errors.`]
      continue
    }
    z.zone = parseZone(text, z.name, z.file)
    const errs = z.zone.problems.filter((p) => p.severity === 'error')
    if (errs.length) z.loadError = [...errs.map((e) => e.bind), `zone ${z.name}/IN: not loaded due to errors.`]
  }
}

interface NamedRuntime {
  conf: NamedConfig
  /** Zonas que está sirviendo (si una recarga falla, sigue con la versión anterior). */
  zones: Map<string, ParsedZone>
}

const namedRuntime = new WeakMap<System, NamedRuntime>()

/** Al arrancar o recargar named: error que impide arrancar, o undefined (y queda cargado). */
export function namedStart(sys: System, reload = false): string | undefined {
  const conf = readNamedConfig(sys)
  const errs = conf.problems.filter((p) => p.severity === 'error')
  if (errs.length) return errs.map((e) => e.bind).join('\n')
  loadZones(sys, conf)
  const prev = reload ? namedRuntime.get(sys) : undefined
  const zones = new Map<string, ParsedZone>()
  const logs: string[] = []
  for (const z of conf.zones) {
    if (z.zone && !z.loadError) {
      zones.set(z.name, z.zone)
      logs.push(`zone ${z.name}/IN: loaded serial ${z.zone.serial ?? 0}`)
    } else if (z.loadError) {
      logs.push(...z.loadError)
      const old = prev?.zones.get(z.name)
      if (old) zones.set(z.name, old)
    }
  }
  // En Rocky, named.service corre "named-checkconf -z" antes de arrancar: una zona con errores lo frena.
  const zoneErrors = conf.zones.filter((z) => z.loadError)
  if (!reload && sys.distro === 'rocky' && zoneErrors.length) return zoneErrors.flatMap((z) => z.loadError!).join('\n')
  namedRuntime.set(sys, { conf, zones })
  for (const l of logs) sys.log('named.service', l, l.includes('not loaded') || l.includes('failed') ? 3 : 6)
  return undefined
}

export function namedActive(sys: System): NamedRuntime | undefined {
  if (!sys.services.get('named')?.active) return undefined
  let rt = namedRuntime.get(sys)
  if (!rt) {
    // Servicio declarado activo por el ejercicio: carga lo que haya.
    if (namedStart(sys)) return undefined
    rt = namedRuntime.get(sys)
  }
  return rt
}

/** Si una dirección (de cliente o de escucha) coincide con una lista de BIND. */
function matchList(sys: System, list: string[], ip: string, acls: Record<string, string[]>, depth = 0): boolean {
  for (const raw of list) {
    const neg = raw.startsWith('!')
    const item = raw.replace(/^!\s*/, '').trim()
    let hit = false
    if (item === 'any') hit = true
    else if (item === 'none') hit = false
    else if (item === 'localhost') hit = sys.ownIps().includes(ip) || ip.startsWith('127.')
    else if (item === 'localnets') hit = ip.startsWith('127.') || sys.interfaces.some((i) => i.up && i.ip && inSubnet(ip, i.ip))
    else if (acls[item] && depth < 4) hit = matchList(sys, acls[item], ip, acls, depth + 1)
    else if (/^\d+(\.\d+){0,3}(\/\d+)?$/.test(item)) {
      const [net, bits] = item.split('/')
      const parts = net.split('.')
      while (parts.length < 4) parts.push('0')
      hit = inSubnet(ip, `${parts.join('.')}/${bits ?? (net.split('.').length * 8 === 32 ? 32 : net.split('.').length * 8)}`)
    }
    if (hit) return !neg
  }
  return false
}

// ---------------------------------------------------------------------------------------
// Unbound
// ---------------------------------------------------------------------------------------

export interface UnboundConfig {
  problems: { file: string; line: number; text: string }[]
  interfaces: string[]
  port: number
  access: { net: string; action: string }[]
  localZones: { name: string; type: string }[]
  localData: { name: string; type: string; data: string }[]
  forwardZones: { name: string; addrs: string[] }[]
}

const UNBOUND_KEYS = ['server', 'interface', 'port', 'access-control', 'local-zone', 'local-data', 'local-data-ptr', 'forward-zone', 'stub-zone', 'name', 'forward-addr', 'stub-addr', 'forward-first', 'do-ip4', 'do-ip6', 'do-udp', 'do-tcp', 'verbosity', 'num-threads', 'hide-identity', 'hide-version', 'prefetch', 'cache-min-ttl', 'cache-max-ttl', 'harden-glue', 'harden-dnssec-stripped', 'use-caps-for-id', 'qname-minimisation', 'private-address', 'private-domain', 'domain-insecure', 'auto-trust-anchor-file', 'trust-anchor-file', 'root-hints', 'directory', 'chroot', 'username', 'pidfile', 'logfile', 'use-syslog', 'include', 'remote-control', 'control-enable', 'control-interface', 'control-use-cert', 'forward-tls-upstream', 'tls-cert-bundle', 'module-config', 'outgoing-interface', 'so-reuseport', 'msg-cache-size', 'rrset-cache-size', 'val-log-level', 'statistics-interval', 'extended-statistics', 'include-toplevel', 'tls-upstream', 'unblock-lan-zones', 'insecure-lan-zones']

export function unboundConfPaths(sys: System): string[] {
  const main = '/etc/unbound/unbound.conf'
  const out = [main]
  const dir = sys.distro === 'rocky' ? '/etc/unbound/conf.d' : '/etc/unbound/unbound.conf.d'
  try {
    for (const f of sys.vfs.readdir(dir, ROOT_CRED).sort()) if (f.endsWith('.conf')) out.push(`${dir}/${f}`)
  } catch {
    // sin carpeta
  }
  return out
}

export function readUnboundConfig(sys: System): UnboundConfig {
  const cfg: UnboundConfig = { problems: [], interfaces: [], port: 53, access: [], localZones: [], localData: [], forwardZones: [] }
  for (const path of unboundConfPaths(sys)) {
    const text = read(sys, path)
    if (text === undefined) continue
    let section = ''
    let fz: { name: string; addrs: string[] } | undefined
    text.split('\n').forEach((rawLine, idx) => {
      const line = rawLine.replace(/#.*/, '').trim()
      if (!line) return
      const m = /^([a-z0-9-]+):\s*(.*)$/i.exec(line)
      if (!m) {
        cfg.problems.push({ file: path, line: idx + 1, text: `${path}:${idx + 1}: error: syntax error` })
        return
      }
      const [, key, rawVal] = m
      const val = rawVal.replace(/^"(.*)"$/, '$1').trim()
      if (!UNBOUND_KEYS.includes(key)) {
        cfg.problems.push({ file: path, line: idx + 1, text: `${path}:${idx + 1}: error: unknown keyword '${key}'` })
        return
      }
      if (['server', 'forward-zone', 'stub-zone', 'remote-control'].includes(key)) {
        section = key
        if (key === 'forward-zone' || key === 'stub-zone') {
          fz = { name: '', addrs: [] }
          cfg.forwardZones.push(fz)
        }
        return
      }
      if (section === 'server') {
        if (key === 'interface') cfg.interfaces.push(val.split('@')[0])
        else if (key === 'port') cfg.port = Number(val)
        else if (key === 'access-control') {
          const [net, action] = val.split(/\s+/)
          cfg.access.push({ net, action: action ?? '' })
          if (!['allow', 'deny', 'refuse', 'allow_snoop', 'deny_non_local', 'refuse_non_local', 'allow_setrd'].includes(action ?? '')) cfg.problems.push({ file: path, line: idx + 1, text: `${path}:${idx + 1}: error: bad access control action ${action ?? ''}` })
        } else if (key === 'local-zone') {
          const mm = /^"?([^"\s]+)"?\s+(\S+)/.exec(rawVal)
          if (mm) cfg.localZones.push({ name: mm[1].toLowerCase().replace(/\.?$/, '.'), type: mm[2] })
        } else if (key === 'local-data') {
          const parts = val.split(/\s+/)
          const tIdx = parts.findIndex((p) => /^(A|AAAA|CNAME|MX|TXT|PTR|NS)$/i.test(p))
          if (tIdx < 1) cfg.problems.push({ file: path, line: idx + 1, text: `${path}:${idx + 1}: error: local-data: bad RR "${val}"` })
          else cfg.localData.push({ name: parts[0].toLowerCase().replace(/\.?$/, '.'), type: parts[tIdx].toUpperCase(), data: parts.slice(tIdx + 1).join(' ') })
        }
      } else if (fz && (section === 'forward-zone' || section === 'stub-zone')) {
        if (key === 'name') fz.name = val.toLowerCase().replace(/\.?$/, '.').replace(/^\.\.$/, '.')
        else if (key === 'forward-addr' || key === 'stub-addr') fz.addrs.push(val.split('@')[0])
      }
    })
  }
  if (!cfg.interfaces.length) cfg.interfaces = ['127.0.0.1']
  return cfg
}

const unboundRuntime = new WeakMap<System, UnboundConfig>()

export function unboundStart(sys: System): string | undefined {
  const cfg = readUnboundConfig(sys)
  if (cfg.problems.length) return `${cfg.problems[0].text}\nread ${cfg.problems[0].file} failed: ${cfg.problems.length} errors in configuration file`
  unboundRuntime.set(sys, cfg)
  return undefined
}

function unboundActive(sys: System): UnboundConfig | undefined {
  if (!sys.services.get('unbound')?.active) return undefined
  if (!unboundRuntime.get(sys) && unboundStart(sys)) return undefined
  return unboundRuntime.get(sys)
}

// ---------------------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------------------

export interface RR {
  name: string
  ttl: number
  type: string
  data: string
}

export interface DnsAnswer {
  /** Error de comunicación (no llegó respuesta). */
  error?: 'timeout' | 'refused' | 'unreachable'
  status: 'NOERROR' | 'NXDOMAIN' | 'REFUSED' | 'SERVFAIL'
  aa: boolean
  ra: boolean
  answer: RR[]
  authority: RR[]
  server: string
  /** Quién respondió (para la explicación). */
  by?: 'named' | 'unbound' | 'externo'
}

const fqdn = (n: string) => n.toLowerCase().replace(/\.?$/, '.')

/** Resolvedores públicos y los del ejercicio: responden con los registros "de internet". */
function externalLookup(sys: System, name: string, type: string): RR[] {
  const n = name.replace(/\.$/, '')
  const key = type === 'A' ? n : `${type} ${n}`
  const pool = [sys, ...sys.lab]
  for (const s of pool) {
    const v = s.dnsRecords[key]
    if (v) return v.split(/\s*;\s*/).map((d) => ({ name: fqdn(n), ttl: 300, type, data: type === 'MX' || type === 'CNAME' || type === 'NS' || type === 'PTR' ? fqdn(d) : d }))
  }
  return []
}

/** Respuesta de una zona autoritativa. */
function fromZone(zone: ParsedZone, qname: string, type: string): { status: 'NOERROR' | 'NXDOMAIN'; answer: RR[]; authority: RR[] } {
  const recs = zone.records
  const soa = recs.find((r) => r.type === 'SOA')
  const soaRR = soa ? [{ name: soa.name, ttl: Number(soa.data.split(' ').at(-1)), type: 'SOA', data: soa.data }] : []
  const toRR = (r: ZoneRecord): RR => ({ name: r.name, ttl: r.ttl, type: r.type, data: r.data })
  const answer: RR[] = []
  let name = qname
  for (let hops = 0; hops < 8; hops++) {
    const at = recs.filter((r) => r.name === name)
    const exact = at.filter((r) => r.type === type || type === 'ANY')
    if (exact.length) {
      answer.push(...exact.map(toRR))
      return { status: 'NOERROR', answer, authority: [] }
    }
    const cname = at.find((r) => r.type === 'CNAME')
    if (cname) {
      answer.push(toRR(cname))
      name = cname.data
      if (!name.endsWith(zone.origin)) return { status: 'NOERROR', answer, authority: [] }
      continue
    }
    if (at.length || recs.some((r) => r.name.endsWith(`.${name}`))) return { status: 'NOERROR', answer, authority: answer.length ? [] : soaRR }
    return { status: answer.length ? 'NOERROR' : 'NXDOMAIN', answer, authority: soaRR }
  }
  return { status: 'NOERROR', answer, authority: [] }
}

function bestZone<T>(zones: Iterable<[string, T]>, qname: string): [string, T] | undefined {
  let best: [string, T] | undefined
  for (const [n, z] of zones) {
    const zn = fqdn(n)
    if ((qname === zn || qname.endsWith(`.${zn}`) || zn === '.') && (!best || zn.length > fqdn(best[0]).length)) best = [n, z]
  }
  return best
}

/** Consulta "recursiva" que hace un resolvedor hacia afuera (forwarders o internet). */
function recurse(server: System, qname: string, type: string, via: string[], depth: number): { status: DnsAnswer['status']; answer: RR[]; authority: RR[] } {
  if (via.length) {
    for (const f of via) {
      const r = query(server, f, qname, type, depth + 1)
      if (!r.error) return { status: r.status, answer: r.answer, authority: r.authority }
    }
    return { status: 'SERVFAIL', answer: [], authority: [] }
  }
  if (!server.internet || !server.gateway || !server.isReachable(server.gateway)) return { status: 'SERVFAIL', answer: [], authority: [] }
  const answer = externalLookup(server, qname, type)
  if (!answer.length && type === 'A') {
    const cn = externalLookup(server, qname, 'CNAME')
    if (cn.length) return { status: 'NOERROR', answer: [...cn, ...externalLookup(server, cn[0].data, 'A')], authority: [] }
  }
  return { status: answer.length ? 'NOERROR' : 'NXDOMAIN', answer, authority: [] }
}

/** Una consulta DNS desde "client" al servidor "serverIp". */
export function query(client: System, serverIp: string, name: string, type: string, depth = 0): DnsAnswer {
  const qname = fqdn(name)
  const base = { aa: false, ra: false, answer: [], authority: [], server: serverIp }
  if (depth > 5) return { ...base, status: 'SERVFAIL' }
  const loop = serverIp.startsWith('127.') || serverIp === '::1'
  const target = loop ? client : hostByIp(client, serverIp)
  if (!target) {
    // Un resolvedor que no es del laboratorio (el del router o uno público).
    if (!routeTo(client, serverIp) && !client.isReachable(serverIp)) return { ...base, error: 'timeout', status: 'SERVFAIL' }
    if (!client.isReachable(serverIp) && !client.initialDns.includes(serverIp)) return { ...base, error: 'timeout', status: 'SERVFAIL' }
    if (client.dnsDown.includes(serverIp)) return { ...base, error: 'timeout', status: 'SERVFAIL' }
    const r = recurse(client, qname, type, [], depth)
    return { ...base, ra: true, status: r.status, answer: r.answer, authority: r.authority, by: 'externo' }
  }
  if (!loop && !routeTo(client, serverIp)) return { ...base, error: 'timeout', status: 'SERVFAIL' }
  const src = loop ? '127.0.0.1' : sourceIp(client, serverIp)
  if (!loop) {
    const fw = inbound(target, 53, 'udp', src)
    if (fw === 'drop') return { ...base, error: 'timeout', status: 'SERVFAIL' }
    if (fw === 'reject') return { ...base, error: 'unreachable', status: 'SERVFAIL' }
  }
  const named = namedActive(target)
  if (named && named.conf.listenPort === 53 && matchList(target, named.conf.listenOn, loop ? '127.0.0.1' : serverIp, named.conf.acls)) {
    const c = named.conf
    if (!matchList(target, c.allowQuery, src, c.acls)) return { ...base, status: 'REFUSED', ra: false, by: 'named' }
    const z = bestZone(named.zones, qname)
    if (z) {
      const r = fromZone(z[1], qname, type)
      // Un CNAME hacia afuera de la zona lo sigue la recursión si está permitida.
      return { ...base, aa: true, ra: c.recursion, status: r.status, answer: r.answer, authority: r.authority, by: 'named' }
    }
    const recOk = c.recursion && matchList(target, c.allowRecursion ?? ['localnets', 'localhost'], src, c.acls)
    if (!recOk) return { ...base, status: 'REFUSED', ra: false, by: 'named' }
    const r = recurse(target, qname, type, c.forwarders, depth)
    return { ...base, ra: true, status: r.status, answer: r.answer, authority: r.authority, by: 'named' }
  }
  const ub = unboundActive(target)
  if (ub && ub.port === 53 && ub.interfaces.some((i) => i === '0.0.0.0' || i === '::0' || i === (loop ? '127.0.0.1' : serverIp))) {
    // access-control: por defecto solo localhost.
    const rules = [{ net: '127.0.0.0/8', action: 'allow' }, ...ub.access]
    const rule = rules.filter((a) => inSubnet(src, a.net.includes('/') ? a.net : `${a.net}/32`)).sort((a, b) => Number(b.net.split('/')[1] ?? 32) - Number(a.net.split('/')[1] ?? 32))[0]
    if (!rule || rule.action.startsWith('refuse')) return { ...base, status: 'REFUSED', by: 'unbound' }
    if (rule.action.startsWith('deny')) return { ...base, error: 'timeout', status: 'SERVFAIL' }
    const local = ub.localData.filter((d) => d.name === qname && d.type === type).map((d) => ({ name: d.name, ttl: 3600, type: d.type, data: d.data }))
    if (local.length) return { ...base, aa: true, ra: true, status: 'NOERROR', answer: local, by: 'unbound' }
    const lz = ub.localZones.filter((z) => qname === z.name || qname.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0]
    if (lz && ['static', 'refuse', 'deny', 'always_nxdomain'].includes(lz.type)) return { ...base, aa: true, ra: true, status: lz.type === 'refuse' ? 'REFUSED' : 'NXDOMAIN', by: 'unbound' }
    const fwd = bestZone(ub.forwardZones.map((f) => [f.name, f] as [string, typeof f]), qname)
    const r = recurse(target, qname, type, fwd ? fwd[1].addrs : [], depth)
    return { ...base, ra: true, status: r.status, answer: r.answer, authority: r.authority, by: 'unbound' }
  }
  // Nada escucha en el puerto 53: el sistema responde "puerto inalcanzable".
  return { ...base, error: 'refused', status: 'SERVFAIL' }
}

/** Servidores de /etc/resolv.conf. */
export function nameservers(sys: System): string[] {
  const text = read(sys, '/etc/resolv.conf')
  if (text === undefined) return sys.dns
  return text
    .split('\n')
    .map((l) => /^\s*nameserver\s+(\S+)/.exec(l)?.[1])
    .filter((x): x is string => !!x)
}

/** Resolución de nombres del sistema (ping, ssh, curl): prueba cada nameserver en orden. */
export function systemResolve(sys: System, name: string): string | undefined | null {
  const servers = nameservers(sys)
  if (!servers.length) return undefined
  // Solo interviene cuando hay un servidor DNS del laboratorio o la configuración cambió.
  const involved = servers.some((s) => s.startsWith('127.') || hostByIp(sys, s)) || servers.join() !== sys.initialDns.join()
  if (!involved) return null
  for (const s of servers.slice(0, 3)) {
    const r = query(sys, s, name, 'A')
    if (r.error) continue
    const a = r.answer.find((x) => x.type === 'A')
    return a?.data
  }
  return undefined
}

/** Direcciones donde escucha named (para ss). */
export function namedListen(sys: System): string[] | undefined {
  const rt = namedActive(sys)
  if (!rt) return undefined
  return sys.ownIps().filter((ip) => matchList(sys, rt.conf.listenOn, ip, rt.conf.acls))
}

export function unboundListen(sys: System): string[] | undefined {
  const cfg = unboundActive(sys)
  if (!cfg) return undefined
  return cfg.interfaces
}
