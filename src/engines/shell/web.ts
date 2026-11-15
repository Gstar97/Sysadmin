/**
 * nginx en el servidor simulado.
 *
 * Al arrancar o recargar, nginx lee nginx.conf con sus include y se queda con esa configuración
 * (y con los certificados que leyó en ese momento): editar un archivo no cambia nada hasta el
 * próximo reload, como en el de verdad. Con eso atiende las solicitudes: elige el server por
 * puerto y nombre, la location por la regla de nginx (exacta, prefijo más largo, regex), y
 * sirve archivos (con permisos y SELinux), redirige, hace de proxy inverso con balanceo entre
 * upstreams, pasa PHP a PHP-FPM y escribe access.log y error.log.
 */
import { parseNginx, validateNginx } from '../config/nginx'
import type { NginxDirective } from '../config/types'
import { appOnSocket, appRespond, endpointAt, httpDate, reach, REASON, SERVERS, web, type Endpoint, type HttpRequest, type HttpResponse, type TlsHello } from './http'
import { avc, httpdCanRead, portAllowed, portType } from './selinux'
import type { System } from './system'
import { certsIn, keyIn, type CertData } from './tls'
import { ROOT_CRED } from './vfs'

interface ConfFile {
  path: string
  tree: NginxDirective[]
  /** Dónde lo incluyeron (http, server, location...): ahí se valida cada directiva del archivo. */
  ctx?: NginxContext
}

type NginxContext = NonNullable<Parameters<typeof validateNginx>[1]>
const BLOCK_CTX = new Set(['events', 'http', 'server', 'location', 'upstream', 'stream', 'if', 'map', 'types', 'limit_except'])

function readFiles(sys: System, pattern: string): string[] {
  const abs = pattern.startsWith('/') ? pattern : `/etc/nginx/${pattern}`
  if (!abs.includes('*')) return sys.vfs.exists(abs) ? [abs] : []
  const dir = abs.slice(0, abs.lastIndexOf('/'))
  const glob = abs.slice(abs.lastIndexOf('/') + 1)
  const re = new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
  try {
    return sys.vfs
      .readdir(dir, ROOT_CRED)
      .filter((n) => re.test(n) && !n.startsWith('.'))
      .sort()
      .map((n) => `${dir}/${n}`)
  } catch {
    return []
  }
}

/** nginx.conf con los include ya reemplazados por el contenido de cada archivo. */
function expanded(sys: System, path = '/etc/nginx/nginx.conf', files: ConfFile[] = [], ctx?: NginxContext): NginxDirective[] {
  let text: string
  try {
    text = sys.vfs.readFile(path, ROOT_CRED)
  } catch {
    return []
  }
  const tree = parseNginx(text).tree
  files.push({ path, tree, ctx })
  const walk = (list: NginxDirective[], here?: NginxContext): NginxDirective[] =>
    list.flatMap((d) => {
      if (d.name === 'include' && d.args[0] && !d.args[0].endsWith('mime.types')) return readFiles(sys, d.args[0]).flatMap((f) => expanded(sys, f, files, here ?? 'main'))
      const inner = BLOCK_CTX.has(d.name) ? (d.name as NginxContext) : here
      return d.block ? [{ ...d, block: walk(d.block, inner) }] : [d]
    })
  return walk(tree, ctx)
}

// ---------------------------------------------------------------------------------------
// Modelo de la configuración cargada
// ---------------------------------------------------------------------------------------

interface Listen {
  addr: string
  port: number
  ssl: boolean
  http2: boolean
  def: boolean
}

interface Loc {
  mod: '' | '=' | '^~' | '~' | '~*' | '@'
  path: string
  block: NginxDirective[]
  re?: RegExp
}

interface Server {
  listens: Listen[]
  names: string[]
  block: NginxDirective[]
  locs: Loc[]
  /** Certificado y clave leídos al cargar. */
  cert?: { chain: CertData[]; path: string }
}

interface UpstreamSrv {
  target: string
  weight: number
  backup: boolean
  down: boolean
  maxFails: number
}

interface Upstream {
  name: string
  servers: UpstreamSrv[]
  method: 'rr' | 'least_conn' | 'ip_hash' | 'hash'
}

interface MapDef {
  source: string
  target: string
  entries: [string, string][]
  def: string
}

interface Loaded {
  http: NginxDirective[]
  servers: Server[]
  upstreams: Map<string, Upstream>
  maps: MapDef[]
  user: string
  version: string
}

const LOADED = new WeakMap<System, Loaded>()

function nginxVersion(sys: System): string {
  return sys.distro === 'rocky' ? '1.26.3' : '1.28.3'
}

function parseListen(args: string[]): Listen {
  const first = args[0] ?? '80'
  let addr = '0.0.0.0'
  let port = 80
  const m6 = /^\[([^\]]*)\]:(\d+)$/.exec(first)
  const m4 = /^([\d.]+|\*|localhost):(\d+)$/.exec(first)
  if (m6) {
    addr = '::'
    port = Number(m6[2])
  } else if (m4) {
    addr = m4[1] === '*' ? '0.0.0.0' : m4[1] === 'localhost' ? '127.0.0.1' : m4[1]
    port = Number(m4[2])
  } else if (/^\d+$/.test(first)) port = Number(first)
  else if (/^[\d.]+$/.test(first)) addr = first
  return { addr, port, ssl: args.includes('ssl'), http2: args.includes('http2'), def: args.includes('default_server') || args.includes('default') }
}

function first(block: NginxDirective[], name: string): NginxDirective | undefined {
  return block.find((d) => d.name === name)
}

function load(sys: System): Loaded {
  const tree = expanded(sys)
  const http = first(tree, 'http')?.block ?? []
  const upstreams = new Map<string, Upstream>()
  for (const u of http.filter((d) => d.name === 'upstream')) {
    const b = u.block ?? []
    upstreams.set(u.args[0], {
      name: u.args[0],
      method: b.some((d) => d.name === 'least_conn') ? 'least_conn' : b.some((d) => d.name === 'ip_hash') ? 'ip_hash' : b.some((d) => d.name === 'hash') ? 'hash' : 'rr',
      servers: b
        .filter((d) => d.name === 'server')
        .map((d) => ({
          target: d.args[0],
          weight: Number(d.args.find((a) => a.startsWith('weight='))?.slice(7) ?? 1),
          backup: d.args.includes('backup'),
          down: d.args.includes('down'),
          maxFails: Number(d.args.find((a) => a.startsWith('max_fails='))?.slice(10) ?? 1),
        })),
    })
  }
  const maps: MapDef[] = http
    .filter((d) => d.name === 'map')
    .map((d) => {
      const entries = (d.block ?? []).map((e) => [e.name, e.args[0] ?? ''] as [string, string])
      return { source: d.args[0], target: d.args[1], entries: entries.filter(([k]) => k !== 'default'), def: entries.find(([k]) => k === 'default')?.[1] ?? '' }
    })
  const httpCert = first(http, 'ssl_certificate')?.args[0]
  const httpKey = first(http, 'ssl_certificate_key')?.args[0]
  const servers: Server[] = http
    .filter((d) => d.name === 'server')
    .map((s) => {
      const b = s.block ?? []
      const listens = b.filter((d) => d.name === 'listen').map((d) => parseListen(d.args))
      const locs: Loc[] = b
        .filter((d) => d.name === 'location')
        .map((d) => {
          const [a, c] = d.args
          const mod = (c !== undefined ? a : '') as Loc['mod']
          const path = c !== undefined ? c : a.startsWith('@') ? a : a
          let re: RegExp | undefined
          if (mod === '~' || mod === '~*') {
            try {
              re = new RegExp(path, mod === '~*' ? 'i' : '')
            } catch {
              re = undefined
            }
          }
          return { mod: a.startsWith('@') ? '@' : mod, path, block: d.block ?? [], re }
        })
      const srv: Server = { listens: listens.length ? listens : [{ addr: '0.0.0.0', port: 80, ssl: false, http2: false, def: false }], names: first(b, 'server_name')?.args ?? [''], block: b, locs }
      const certPath = first(b, 'ssl_certificate')?.args[0] ?? httpCert
      if (certPath && sys.vfs.exists(certPath)) {
        try {
          srv.cert = { chain: certsIn(sys.vfs.readFile(certPath, ROOT_CRED)), path: certPath }
        } catch {
          srv.cert = undefined
        }
      }
      void httpKey
      return srv
    })
  return { http, servers, upstreams, maps, user: workerUser(sys), version: nginxVersion(sys) }
}

/** Toma la configuración actual como la cargada (nginx ya corría al empezar el ejercicio). */
export function nginxPrime(sys: System) {
  if (sys.vfs.exists('/etc/nginx/nginx.conf') && !nginxTest(sys).length) LOADED.set(sys, load(sys))
}

function loaded(sys: System): Loaded {
  let l = LOADED.get(sys)
  if (!l) {
    l = load(sys)
    LOADED.set(sys, l)
  }
  return l
}

/** Lo que usan los otros módulos: los server con su puerto, carpeta y nombres. */
export interface NginxServer {
  ports: number[]
  defaultServer: boolean
  root: string
  index: string[]
  names: string[]
}

export function nginxServers(sys: System): NginxServer[] {
  const l = load(sys)
  const httpRoot = first(l.http, 'root')?.args[0]
  const httpIndex = first(l.http, 'index')?.args
  return l.servers.map((s) => ({
    ports: [...new Set(s.listens.map((x) => x.port))],
    defaultServer: s.listens.some((x) => x.def),
    root: first(s.block, 'root')?.args[0] ?? httpRoot ?? '/usr/share/nginx/html',
    index: first(s.block, 'index')?.args ?? httpIndex ?? ['index.html'],
    names: s.names,
  }))
}

// ---------------------------------------------------------------------------------------
// nginx -t y arranque
// ---------------------------------------------------------------------------------------

function sslError(path: string, what: 'certificate' | 'certificate key'): string {
  return `nginx: [emerg] cannot load ${what} "${path}": BIO_new_file() failed (SSL: error:80000002:system library::No such file or directory:calling fopen(${path}, r) error:10000080:BIO routines::no such file)`
}

/** Errores como los de nginx -t (vacío si está bien). */
export function nginxTest(sys: System): string[] {
  const files: ConfFile[] = []
  const tree = expanded(sys, '/etc/nginx/nginx.conf', files)
  if (!files.length) return ['nginx: [emerg] open() "/etc/nginx/nginx.conf" failed (2: No such file or directory)']
  const errs: string[] = []
  const seen = new Set<string>()
  for (const f of files) {
    if (seen.has(f.path)) continue
    seen.add(f.path)
    const text = sys.vfs.readFile(f.path, ROOT_CRED)
    for (const d of validateNginx(text, f.ctx).diagnostics) {
      if (d.severity !== 'error') continue
      const eng = /\(nginx: ([^)]+)\)/.exec(d.message)?.[1]
      const name = /"([^"]+)"/.exec(d.message)?.[1]
      const msg = eng === 'unknown directive' ? `unknown directive "${name}"` : eng ?? d.message
      errs.push(`nginx: [emerg] ${msg} in ${f.path}:${d.line}`)
    }
  }
  if (errs.length) return errs
  // Lo que se revisa recién al cargar: upstreams, certificados y claves.
  const http = first(tree, 'http')?.block ?? []
  const ups = new Set(http.filter((d) => d.name === 'upstream').map((d) => d.args[0]))
  const httpCert = first(http, 'ssl_certificate')?.args[0]
  const httpKey = first(http, 'ssl_certificate_key')?.args[0]
  for (const s of http.filter((d) => d.name === 'server')) {
    const b = s.block ?? []
    const names = new Set<string>()
    for (const l of b.filter((d) => d.name === 'location')) {
      const key = l.args.join(' ')
      if (names.has(key)) errs.push(`nginx: [emerg] duplicate location "${l.args.at(-1)}" in /etc/nginx/nginx.conf:${l.line}`)
      names.add(key)
      for (const p of (l.block ?? []).filter((d) => d.name === 'proxy_pass')) {
        const m = /^https?:\/\/([^/:]+)(?::\d+)?/.exec(p.args[0] ?? '')
        if (m && !ups.has(m[1]) && !/^[\d.]+$/.test(m[1]) && m[1] !== 'localhost' && !m[1].startsWith('unix') && !sys.resolveHost(m[1])) errs.push(`nginx: [emerg] host not found in upstream "${m[1]}" in /etc/nginx/nginx.conf:${p.line}`)
      }
    }
    const ssl = b.some((d) => d.name === 'listen' && d.args.includes('ssl'))
    const cert = first(b, 'ssl_certificate')?.args[0] ?? httpCert
    const key = first(b, 'ssl_certificate_key')?.args[0] ?? httpKey
    if (cert) {
      if (!sys.vfs.exists(cert)) {
        errs.push(sslError(cert, 'certificate'))
        continue
      }
      const certs = certsIn(sys.vfs.readFile(cert, ROOT_CRED))
      if (!certs.length) {
        errs.push(`nginx: [emerg] cannot load certificate "${cert}": PEM_read_bio_X509_AUX() failed (SSL: error:0480006C:PEM routines::no start line:Expecting: TRUSTED CERTIFICATE)`)
        continue
      }
      if (!key) {
        errs.push(`nginx: [emerg] no "ssl_certificate_key" is defined for certificate "${cert}" in /etc/nginx/nginx.conf:${s.line}`)
        continue
      }
      if (!sys.vfs.exists(key)) {
        errs.push(sslError(key, 'certificate key'))
        continue
      }
      const k = keyIn(sys.vfs.readFile(key, ROOT_CRED))
      if (!k) {
        errs.push(`nginx: [emerg] cannot load certificate key "${key}": PEM_read_bio_PrivateKey() failed (SSL: error:1E08010C:DECODER routines::unsupported)`)
        continue
      }
      if (k.enc) {
        errs.push(`nginx: [emerg] cannot load certificate key "${key}": PEM_read_bio_PrivateKey() failed (SSL: error:1C800064:Provider routines::bad decrypt)`)
        continue
      }
      if (k.id !== certs[0].keyId) errs.push(`nginx: [emerg] SSL_CTX_use_PrivateKey("${key}") failed (SSL: error:05800074:x509 certificate routines::key values mismatch)`)
    } else if (ssl) {
      // Sin certificado, nginx arranca, pero cada saludo TLS falla (y lo anota en error.log).
    }
  }
  return errs
}

function workerUser(sys: System): string {
  const m = /^\s*user\s+([^;\s]+)/m.exec((() => {
    try {
      return sys.vfs.readFile('/etc/nginx/nginx.conf', ROOT_CRED)
    } catch {
      return ''
    }
  })())
  return m?.[1] ?? (sys.distro === 'rocky' ? 'nginx' : 'www-data')
}

/** Al arrancar o recargar nginx: sintaxis, certificados y puertos (SELinux puede impedir usar uno). */
export function nginxStartCheck(sys: System): string | undefined {
  // Un servicio nginx que el ejercicio declara sin instalar el paquete no tiene configuración que revisar.
  if (!sys.vfs.exists('/etc/nginx/nginx.conf')) return undefined
  const errs = nginxTest(sys)
  if (errs.length) return `${errs[0]}`
  const l = load(sys)
  const ports = [...new Set(l.servers.flatMap((s) => s.listens.map((x) => x.port)))]
  for (const p of ports) if (!portAllowed(sys, 'http_port_t', p)) return `nginx: [emerg] bind() to 0.0.0.0:${p} failed (13: Permission denied)`
  const svc = sys.services.get('nginx')
  if (svc) svc.ports = ports
  LOADED.set(sys, l)
  return undefined
}

// ---------------------------------------------------------------------------------------
// Registros
// ---------------------------------------------------------------------------------------

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function timeLocal(d = new Date()): string {
  const mon = d.toUTCString().slice(8, 11)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCDate())}/${mon}/${d.getUTCFullYear()}:${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`
}

function logPath(_sys: System, block: NginxDirective[][], name: 'error_log' | 'access_log'): string | undefined {
  for (const b of block) {
    const d = first(b, name)
    if (d) return d.args[0] === 'off' ? undefined : d.args[0]
  }
  return `/var/log/nginx/${name === 'error_log' ? 'error' : 'access'}.log`
}

function append(sys: System, path: string | undefined, line: string) {
  if (!path) return
  try {
    sys.vfs.mkdirp(path.slice(0, path.lastIndexOf('/')), ROOT_CRED)
    sys.vfs.writeFile(path, line + '\n', ROOT_CRED, { append: true })
  } catch {
    // sin registro
  }
}

// ---------------------------------------------------------------------------------------
// Atender una solicitud
// ---------------------------------------------------------------------------------------

interface Ctx {
  sys: System
  l: Loaded
  srv: Server
  req: HttpRequest
  uri: string
  args: string
  seq: number
  pid: number
  /** Las capas de configuración aplicables, de la más específica a la más general. */
  layers: NginxDirective[][]
  docRoot: string
}

const MIME: Record<string, string> = { html: 'text/html', htm: 'text/html', css: 'text/css', js: 'application/javascript', json: 'application/json', txt: 'text/plain', png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml', ico: 'image/x-icon', xml: 'text/xml', pdf: 'application/pdf' }

function page(c: Ctx, code: number): string {
  const tokens = inherited(c, 'server_tokens')?.args[0] !== 'off'
  return `<html>\r\n<head><title>${code} ${REASON[code] ?? ''}</title></head>\r\n<body>\r\n<center><h1>${code} ${REASON[code] ?? ''}</h1></center>\r\n<hr><center>nginx${tokens ? `/${c.l.version}` : ''}</center>\r\n</body>\r\n</html>\r\n`
}

function inherited(c: Ctx, name: string): NginxDirective | undefined {
  for (const b of c.layers) {
    const d = first(b, name)
    if (d) return d
  }
  return undefined
}

/** proxy_set_header y add_header se heredan solo si el nivel actual no define ninguno. */
function inheritedAll(c: Ctx, name: string): NginxDirective[] {
  for (const b of c.layers) {
    const ds = b.filter((d) => d.name === name)
    if (ds.length) return ds
  }
  return []
}

function vars(c: Ctx, name: string): string {
  const r = c.req
  const host = (r.headers['host'] ?? c.srv.names[0] ?? '').replace(/:\d+$/, '')
  switch (name) {
    case 'host':
      return host
    case 'http_host':
      return r.headers['host'] ?? ''
    case 'remote_addr':
    case 'realip_remote_addr':
      return r.clientIp
    case 'scheme':
      return r.scheme
    case 'https':
      return r.scheme === 'https' ? 'on' : ''
    case 'request_uri':
      return r.path
    case 'uri':
    case 'document_uri':
      return c.uri
    case 'args':
    case 'query_string':
      return c.args
    case 'is_args':
      return c.args ? '?' : ''
    case 'request_method':
      return r.method
    case 'server_name':
      return c.srv.names[0] ?? ''
    case 'server_port':
      return String(r.port)
    case 'server_addr':
      return r.localIp
    case 'document_root':
    case 'realpath_root':
      return c.docRoot
    case 'fastcgi_script_name':
      return c.uri
    case 'proxy_add_x_forwarded_for':
      return r.headers['x-forwarded-for'] ? `${r.headers['x-forwarded-for']}, ${r.clientIp}` : r.clientIp
    case 'request':
      return `${r.method} ${r.path} HTTP/1.1`
  }
  if (name.startsWith('http_')) return r.headers[name.slice(5).replace(/_/g, '-')] ?? ''
  if (name.startsWith('arg_')) return new URLSearchParams(c.args).get(name.slice(4)) ?? ''
  const map = c.l.maps.find((m) => m.target === `$${name}`)
  if (map) {
    const src = expand(c, map.source)
    for (const [k, v] of map.entries) {
      const key = k.replace(/^['"]|['"]$/g, '')
      if (key.startsWith('~')) {
        try {
          if (new RegExp(key.slice(1).replace(/^\*/, ''), key.startsWith('~*') ? 'i' : '').test(src)) return v.replace(/^['"]|['"]$/g, '')
        } catch {
          continue
        }
      } else if (key === src) return v.replace(/^['"]|['"]$/g, '')
    }
    return map.def.replace(/^['"]|['"]$/g, '')
  }
  return ''
}

function expand(c: Ctx, text: string, captures: string[] = []): string {
  return text.replace(/\$(\d|\{?[a-z_][a-z0-9_]*\}?)/gi, (_, n: string) => {
    if (/^\d$/.test(n)) return captures[Number(n)] ?? ''
    return vars(c, n.replace(/[{}]/g, ''))
  })
}

function hostMatch(names: string[], host: string): number {
  // 3: exacto, 2: comodín adelante, 1: comodín atrás, 0.5: regex, 0: nada.
  let best = 0
  for (const n of names) {
    const name = n.toLowerCase()
    if (name === host) return 3
    if (name.startsWith('*.') && host.endsWith(name.slice(1))) best = Math.max(best, 2)
    else if (name.startsWith('.') && (host === name.slice(1) || host.endsWith(name))) best = Math.max(best, 2)
    else if (name.endsWith('.*') && host.startsWith(name.slice(0, -1))) best = Math.max(best, 1)
    else if (name.startsWith('~')) {
      try {
        if (new RegExp(name.slice(1)).test(host)) best = Math.max(best, 0.5)
      } catch {
        // regex inválida
      }
    }
  }
  return best
}

function listensOn(l: Listen, port: number, localIp: string): boolean {
  if (l.port !== port) return false
  if (l.addr === '0.0.0.0' || l.addr === '::') return true
  return l.addr === localIp || (l.addr.startsWith('127.') && localIp.startsWith('127.'))
}

function pickServer(l: Loaded, port: number, localIp: string, host: string): Server | undefined {
  const cands = l.servers.filter((s) => s.listens.some((x) => listensOn(x, port, localIp)))
  if (!cands.length) return undefined
  let best: Server | undefined
  let score = 0
  for (const s of cands) {
    const sc = hostMatch(s.names, host)
    if (sc > score) {
      score = sc
      best = s
    }
  }
  return best ?? cands.find((s) => s.listens.some((x) => x.port === port && x.def)) ?? cands[0]
}

function pickLocation(srv: Server, uri: string): { loc?: Loc; captures: string[] } {
  const exact = srv.locs.find((l) => l.mod === '=' && l.path === uri)
  if (exact) return { loc: exact, captures: [] }
  const prefixes = srv.locs.filter((l) => (l.mod === '' || l.mod === '^~') && uri.startsWith(l.path)).sort((a, b) => b.path.length - a.path.length)
  const longest = prefixes[0]
  if (longest?.mod === '^~') return { loc: longest, captures: [] }
  for (const l of srv.locs) {
    if ((l.mod === '~' || l.mod === '~*') && l.re) {
      const m = l.re.exec(uri)
      if (m) return { loc: l, captures: [...m] }
    }
  }
  return { loc: longest, captures: [] }
}

function respond(c: Ctx, status: number, body?: string, headers: [string, string][] = []): HttpResponse {
  return { status, headers: [['Content-Type', 'text/html'], ...headers], body: body ?? page(c, status) }
}

function errorLog(c: Ctx, msg: string, level = 'error', extra = '') {
  const host = c.req.headers['host'] ?? ''
  const line = `${stamp()} [${level}] ${c.pid}#${c.pid}: *${c.seq} ${msg}, client: ${c.req.clientIp}, server: ${c.srv.names[0] ?? ''}, request: "${c.req.method} ${c.req.path} HTTP/1.1"${extra}${host ? `, host: "${host}"` : ''}`
  append(c.sys, logPath(c.sys, [...c.layers], 'error_log') ?? '/var/log/nginx/error.log', line)
}

/** Dónde está el archivo para esa URI según root o alias. */
function filePath(c: Ctx, loc: Loc | undefined, uri: string): string {
  const alias = loc ? first(loc.block, 'alias')?.args[0] : undefined
  if (alias && loc && loc.mod !== '~' && loc.mod !== '~*') return alias + uri.slice(loc.path.length)
  return c.docRoot.replace(/\/$/, '') + uri
}

function canRead(c: Ctx, path: string): 'ok' | 'missing' | 'forbidden' | 'dir' {
  const sys = c.sys
  const cred = sys.credFor(sys.users.has(c.l.user) ? c.l.user : 'root')
  const parts = path.split('/').filter(Boolean)
  let cur = ''
  for (let i = 0; i < parts.length; i++) {
    cur += `/${parts[i]}`
    if (!sys.vfs.exists(cur)) return 'missing'
    const node = sys.vfs.stat(cur, ROOT_CRED)
    if (node.type === 'dir' && i < parts.length - 1 && !sys.vfs.can(node, cred, 1)) return 'forbidden'
  }
  if (!parts.length) return 'dir'
  const node = sys.vfs.stat(path, ROOT_CRED)
  if (node.type === 'dir') return 'dir'
  if (!sys.vfs.can(node, cred, 4)) return 'forbidden'
  if (!httpdCanRead(sys, path)) return 'forbidden'
  return 'ok'
}

function serveFile(c: Ctx, path: string): HttpResponse {
  const node = c.sys.vfs.stat(path, ROOT_CRED)
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const type = MIME[ext] ?? 'application/octet-stream'
  return {
    status: 200,
    headers: [
      ['Content-Type', type],
      ['Last-Modified', httpDate(node.mtime ?? Date.now())],
      ['ETag', `"${(node.mtime ?? 0).toString(16).slice(-8)}-${node.data.length.toString(16)}"`],
      ['Accept-Ranges', 'bytes'],
    ],
    body: node.data,
  }
}

/** Ejecuta una página PHP muy simple: echo/print de textos unidos con ".", PHP_VERSION, date('Y') y phpinfo(). */
function runPhp(sys: System, path: string): string {
  let src: string
  try {
    src = sys.vfs.readFile(path, ROOT_CRED)
  } catch {
    return ''
  }
  const version = sys.distro === 'rocky' ? '8.3.19' : '8.5.4'
  const value = (expr: string): string => {
    let out = ''
    const re = /\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|(PHP_VERSION)|(PHP_OS)|date\(\s*['"]Y['"]\s*\)|(\d+))\s*(?:[.,]|$)/y
    let m: RegExpExecArray | null
    while (re.lastIndex < expr.length && (m = re.exec(expr))) {
      if (m[1] !== undefined) out += m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
      else if (m[2] !== undefined) out += m[2].replace(/\\'/g, "'")
      else if (m[3]) out += version
      else if (m[4]) out += 'Linux'
      else if (m[5]) out += m[5]
      else out += String(new Date(Date.now() + sys.clock.offset * 1000).getUTCFullYear())
      if (!m[0]) break
    }
    return out
  }
  return src.replace(/<\?php([\s\S]*?)(\?>\n?|$)/g, (_, code: string) => {
    let out = ''
    for (const stmt of code.split(';')) {
      const t = stmt.trim()
      if (/^phpinfo\s*\(\s*\)$/.test(t)) out += `<h1>PHP Version ${version}</h1>\n<table><tr><td>Server API</td><td>FPM/FastCGI</td></tr></table>\n`
      const m = /^(?:echo|print)\b\s*([\s\S]*)$/.exec(t)
      if (m) out += value(/^\(([\s\S]*)\)$/.exec(m[1])?.[1] ?? m[1])
    }
    return out
  })
}

/** Dónde escucha PHP-FPM según su pool, y si está corriendo. */
export function fpmListen(sys: System): { service: string; listen: string } | undefined {
  const candidates = sys.distro === 'rocky' ? [['php-fpm', '/etc/php-fpm.d/www.conf']] : [...sys.services.keys()].filter((n) => /^php[\d.]+-fpm$/.test(n)).map((n) => [n, `/etc/php/${n.slice(3, -4)}/fpm/pool.d/www.conf`])
  for (const [service, conf] of candidates) {
    if (!sys.services.has(service)) continue
    let text: string
    try {
      text = sys.vfs.readFile(conf, ROOT_CRED)
    } catch {
      text = ''
    }
    const listen = /^\s*listen\s*=\s*(\S+)/m.exec(text)?.[1] ?? (sys.distro === 'rocky' ? '/run/php-fpm/www.sock' : `/run/php/php${service.slice(3, -4)}-fpm.sock`)
    return { service, listen }
  }
  return undefined
}

function networkConnectAllowed(sys: System, port: number): boolean {
  if (sys.distro !== 'rocky' || sys.selinux.mode === 'disabled') return true
  if (sys.selinux.booleans.get('httpd_can_network_connect')?.cur) return true
  const t = portType(sys, 'tcp', port)
  if (t === 'http_port_t') return true
  avc(sys, 'nginx', 'name_connect', `dest=${port}`, 'httpd_t', `system_u:object_r:${t}:s0`, 'tcp_socket')
  return sys.selinux.mode === 'permissive'
}

type UpResult = { res: HttpResponse } | { err: string; kind: 'refused' | 'timeout' | 'denied' | 'nofile' }

/** Conecta con un destino de upstream (host:puerto o unix:/ruta) y le pasa la solicitud. */
function callUpstream(c: Ctx, target: string, req: HttpRequest, fastcgi: boolean): UpResult {
  const sys = c.sys
  const where = target.replace(/^https?:\/\//, '')
  if (where.startsWith('unix:')) {
    const sock = where.slice(5).replace(/:$/, '')
    if (fastcgi) {
      const fpm = fpmListen(sys)
      if (!fpm || !sys.services.get(fpm.service)?.active || fpm.listen !== sock) return { err: `connect() to unix:${sock} failed (2: No such file or directory)`, kind: 'nofile' }
      return { res: { status: 200, headers: [], body: '' } }
    }
    const app = appOnSocket(sys, sock)
    if (!app) return { err: `connect() to unix:${sock} failed (2: No such file or directory)`, kind: 'nofile' }
    return { res: appRespond(sys, app, req) }
  }
  const m = /^([^:/]+)(?::(\d+))?/.exec(where)
  if (!m) return { err: 'invalid upstream', kind: 'refused' }
  const port = Number(m[2] ?? 80)
  const ip = /^\d+\.\d+\.\d+\.\d+$/.test(m[1]) ? m[1] : m[1] === 'localhost' ? '127.0.0.1' : sys.resolveHost(m[1]) ?? m[1]
  if (!networkConnectAllowed(sys, port)) return { err: `connect() to ${ip}:${port} failed (13: Permission denied)`, kind: 'denied' }
  if (fastcgi) {
    const fpm = fpmListen(sys)
    if (!fpm || !sys.services.get(fpm.service)?.active || !fpm.listen.endsWith(`:${port}`)) return { err: `connect() failed (111: Connection refused)`, kind: 'refused' }
    return { res: { status: 200, headers: [], body: '' } }
  }
  const r = reach(sys, ip, port)
  if ('error' in r) return r.error === 'outside' ? { res: { status: 200, headers: [['Server', 'nginx']], body: `<h1>${m[1]}</h1>\n` } } : { err: r.error === 'timeout' ? 'upstream timed out (110: Connection timed out)' : `connect() failed (113: No route to host)`, kind: r.error === 'timeout' ? 'timeout' : 'refused' }
  const ep = endpointAt(r.target, port, r.localIp)
  if (!ep) return { err: `connect() failed (111: Connection refused)`, kind: 'refused' }
  const res = ep.handle({ ...req, clientIp: r.clientIp, localIp: r.localIp, port })
  return { res }
}

/** Los destinos en el orden en que nginx los probaría para esta solicitud. */
function upstreamOrder(c: Ctx, up: Upstream): UpstreamSrv[] {
  const rt = web(c.sys)
  const live = up.servers.filter((s) => !s.down && !s.backup)
  const backups = up.servers.filter((s) => !s.down && s.backup)
  if (!live.length) return backups
  let start: number
  if (up.method === 'ip_hash') {
    const h = c.req.clientIp.split('.').slice(0, 3).reduce((a, b) => a * 113 + Number(b), 0)
    start = h % live.length
  } else {
    // Round robin con pesos: una lista con cada servidor repetido según su peso.
    const wheel = live.flatMap((s, i) => Array.from({ length: Math.max(1, s.weight) }, () => i))
    const turn = rt.rr.get(up.name) ?? 0
    rt.rr.set(up.name, turn + 1)
    start = wheel[turn % wheel.length]
  }
  return [...live.slice(start), ...live.slice(0, start), ...backups]
}

function proxy(c: Ctx, loc: Loc, pass: string, fastcgi: boolean): HttpResponse {
  const sys = c.sys
  const r = c.req
  // Destino y URI que se manda.
  const pm = /^(https?:\/\/)?(unix:[^:]+:?|[^/]+)(\/.*)?$/.exec(pass)
  const name = pm?.[2] ?? pass
  const passUri = pm?.[3]
  let uri = r.path
  if (!fastcgi && passUri !== undefined && loc.mod !== '~' && loc.mod !== '~*') uri = passUri + (c.uri + (c.args ? `?${c.args}` : '')).slice(loc.path.length)
  const headers: Record<string, string> = {}
  if (!fastcgi) {
    const up = c.l.upstreams.get(name.replace(/:\d+$/, ''))
    headers['host'] = up ? up.name : name.replace(/:80$/, '')
    headers['connection'] = 'close'
    for (const [k, v] of Object.entries(r.headers)) if (!['host', 'connection', 'upgrade'].includes(k)) headers[k] = v
    for (const d of inheritedAll(c, 'proxy_set_header')) {
      const v = expand(c, d.args[1] ?? '')
      if (v === '') delete headers[d.args[0].toLowerCase()]
      else headers[d.args[0].toLowerCase()] = v
    }
    const http11 = inherited(c, 'proxy_http_version')?.args[0] === '1.1'
    if (!http11 && headers['upgrade']) delete headers['upgrade']
  }
  const sub: HttpRequest = { ...r, path: uri, headers }
  const up = c.l.upstreams.get(name)
  const order: string[] = up ? upstreamOrder(c, up).map((s) => s.target) : [name]
  if (up && !order.length) {
    errorLog(c, `no live upstreams while connecting to upstream`, 'error', `, upstream: "http://${up.name}${uri}"`)
    return respond(c, 502)
  }
  let lastKind: UpResult | undefined
  for (const t of order) {
    const res = callUpstream(c, t, sub, fastcgi)
    if ('res' in res) {
      if (fastcgi) return php(c)
      const delay = web(sys).apps ? 0 : 0
      void delay
      const out: HttpResponse = { status: res.res.status, headers: res.res.headers.filter(([k]) => !['server', 'date', 'connection'].includes(k.toLowerCase())), body: res.res.body }
      if (res.res.status === 101) out.headers.push(['Connection', 'upgrade'])
      return out
    }
    lastKind = res
    const scheme = fastcgi ? 'fastcgi' : 'http'
    errorLog(c, `${res.err} while connecting to upstream`, 'error', `, upstream: "${scheme}://${t.startsWith('unix:') ? t : t}${fastcgi ? '' : uri}"`)
  }
  if (lastKind && 'kind' in lastKind && lastKind.kind === 'timeout') return respond(c, 504)
  return respond(c, 502)
}

function php(c: Ctx): HttpResponse {
  const params = inheritedAll(c, 'fastcgi_param')
  const script = params.find((d) => d.args[0] === 'SCRIPT_FILENAME')
  if (!script) {
    errorLog(c, 'FastCGI sent in stderr: "Primary script unknown" while reading response header from upstream')
    return { status: 404, headers: [['Content-Type', 'text/html; charset=UTF-8']], body: 'File not found.\n' }
  }
  const file = expand(c, script.args[1] ?? '')
  if (!c.sys.vfs.exists(file)) {
    errorLog(c, 'FastCGI sent in stderr: "Primary script unknown" while reading response header from upstream')
    return { status: 404, headers: [['Content-Type', 'text/html; charset=UTF-8']], body: 'File not found.\n' }
  }
  return { status: 200, headers: [['Content-Type', 'text/html; charset=UTF-8'], ['X-Powered-By', `PHP/${c.sys.distro === 'rocky' ? '8.3.19' : '8.5.4'}`]], body: runPhp(c.sys, file) }
}

function ipAllowed(c: Ctx): boolean {
  for (const b of c.layers) {
    const rules = b.filter((d) => d.name === 'allow' || d.name === 'deny')
    if (!rules.length) continue
    for (const d of rules) {
      const a = d.args[0]
      const hit = a === 'all' || a === c.req.clientIp || (a.includes('/') && cidr(c.req.clientIp, a))
      if (hit) return d.name === 'allow'
    }
    return true
  }
  return true
}

function cidr(ip: string, net: string): boolean {
  const n = (x: string) => x.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0
  const [base, bits] = net.split('/')
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !/^\d+\.\d+\.\d+\.\d+$/.test(base)) return false
  const mask = Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0
  return ((n(ip) & mask) >>> 0) === ((n(base) & mask) >>> 0)
}

function sizeOf(v: string): number {
  const m = /^(\d+)([kmg]?)$/i.exec(v)
  if (!m) return 1024 * 1024
  return Number(m[1]) * ({ '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()] ?? 1)
}

/** Una pasada de procesamiento en una location (puede terminar en un redireccionamiento interno). */
function handleUri(c: Ctx, depth = 0): HttpResponse {
  if (depth > 10) {
    errorLog(c, `rewrite or internal redirection cycle while internally redirecting to "${c.uri}"`)
    return respond(c, 500)
  }
  const { loc, captures } = pickLocation(c.srv, c.uri)
  const httpRoot = first(c.l.http, 'root')?.args[0]
  c.layers = [...(loc ? [loc.block] : []), c.srv.block, c.l.http]
  c.docRoot = first(loc?.block ?? [], 'root')?.args[0] ?? first(c.srv.block, 'root')?.args[0] ?? httpRoot ?? (c.sys.distro === 'rocky' ? '/usr/share/nginx/html' : '/var/www/html')
  if (!loc && !c.srv.locs.length) c.layers = [c.srv.block, c.l.http]

  if (!ipAllowed(c)) {
    errorLog(c, 'access forbidden by rule')
    return respond(c, 403)
  }
  const auth = inherited(c, 'auth_basic')
  if (auth && auth.args[0] !== 'off') {
    const header = c.req.headers['authorization'] ?? ''
    const file = inherited(c, 'auth_basic_user_file')?.args[0]
    let ok = false
    if (header.startsWith('Basic ') && file) {
      const user = (atob(header.slice(6)).split(':')[0] ?? '').trim()
      try {
        ok = c.sys.vfs.readFile(file, ROOT_CRED).split('\n').some((line) => line.split(':')[0] === user)
      } catch {
        errorLog(c, `open() "${file}" failed (2: No such file or directory)`, 'crit')
        return respond(c, 500)
      }
      if (!ok) errorLog(c, `user "${user}" was not found in "${file}"`)
    }
    if (!ok) return respond(c, 401, undefined, [['WWW-Authenticate', `Basic realm=${JSON.stringify(auth.args[0])}`]])
  }
  const max = sizeOf(inherited(c, 'client_max_body_size')?.args[0] ?? '1m')
  if (max > 0 && c.req.body.length > max) {
    errorLog(c, `client intended to send too large body: ${c.req.body.length} bytes`)
    return respond(c, 413)
  }
  // rewrite y return (en el orden en que aparecen, en la location)
  for (const d of loc?.block ?? []) {
    if (d.name === 'rewrite') {
      let re: RegExp
      try {
        re = new RegExp(d.args[0])
      } catch {
        continue
      }
      const m = re.exec(c.uri)
      if (!m) continue
      const to = expand(c, d.args[1], [...m])
      const flag = d.args[2]
      if (flag === 'permanent' || flag === 'redirect' || /^https?:\/\//.test(to)) return respond(c, flag === 'permanent' ? 301 : 302, undefined, [['Location', /^https?:\/\//.test(to) ? to : `${c.req.scheme}://${vars(c, 'host')}${to}`]])
      const [path, q] = to.split('?')
      c.uri = path
      if (q) c.args = q
      if (flag === 'last') return handleUri(c, depth + 1)
    }
    if (d.name === 'return') return doReturn(c, d, captures)
    if (d.name === 'if' && ifTrue(c, d.args)) {
      const r = (d.block ?? []).find((x) => x.name === 'return')
      if (r) return doReturn(c, r, captures)
    }
  }
  // contenido
  const pass = loc ? first(loc.block, 'proxy_pass')?.args[0] : undefined
  if (pass && loc) return proxy(c, loc, expand(c, pass), false)
  const fcgi = loc ? first(loc.block, 'fastcgi_pass')?.args[0] : undefined
  if (fcgi && loc) {
    const tf = first(loc.block, 'try_files')
    if (tf && tf.args.at(-1) === '=404' && !c.sys.vfs.exists(filePath(c, loc, c.uri))) return respond(c, 404)
    const up = c.l.upstreams.get(fcgi)
    return up ? proxy(c, { ...loc }, fcgi, true) : proxy(c, loc, fcgi.startsWith('unix:') ? fcgi : fcgi, true)
  }
  const tryFiles = loc ? first(loc.block, 'try_files') ?? first(c.srv.block, 'try_files') : first(c.srv.block, 'try_files')
  if (tryFiles) {
    const list = tryFiles.args
    for (const a of list.slice(0, -1)) {
      const u = expand(c, a)
      const p = filePath(c, loc, u.replace(/\/$/, '') || '/')
      const st = canRead(c, p)
      if (u.endsWith('/') ? st === 'dir' : st === 'ok') return staticUri(c, loc, u)
      if (st === 'forbidden' && !u.endsWith('/')) return staticUri(c, loc, u)
    }
    const last = list.at(-1) ?? '=404'
    if (last.startsWith('=')) return respond(c, Number(last.slice(1)))
    if (last.startsWith('@')) {
      const named = c.srv.locs.find((l) => l.path === last)
      const np = named ? first(named.block, 'proxy_pass')?.args[0] : undefined
      if (named && np) {
        c.layers = [named.block, c.srv.block, c.l.http]
        return proxy(c, named, expand(c, np), false)
      }
      return respond(c, 500)
    }
    const [path, q] = expand(c, last).split('?')
    c.uri = path
    if (q !== undefined) c.args = q
    return handleUri(c, depth + 1)
  }
  return staticUri(c, loc, c.uri, depth)
}

/** Condición de un if: ($host = x), ($scheme != https), ($http_user_agent ~* bot), ($var). */
function ifTrue(c: Ctx, args: string[]): boolean {
  const text = args.join(' ').replace(/^\(\s*|\s*\)$/g, '')
  const m = /^(\$\w+)\s*(=|!=|~\*|~|!~\*|!~)\s*(.+)$/.exec(text)
  if (!m) {
    const v = /^\$\w+$/.test(text) ? expand(c, text) : ''
    return v !== '' && v !== '0'
  }
  const val = expand(c, m[1])
  const want = m[3].replace(/^["']|["']$/g, '')
  if (m[2] === '=') return val === want
  if (m[2] === '!=') return val !== want
  try {
    const hit = new RegExp(want, m[2].includes('*') ? 'i' : '').test(val)
    return m[2].startsWith('!') ? !hit : hit
  } catch {
    return false
  }
}

/** return, if y rewrite a nivel de server (antes de elegir location), en orden. */
function serverRewrite(c: Ctx, block: NginxDirective[]): HttpResponse | undefined {
  for (const d of block) {
    if (d.name === 'return') return doReturn(c, d, [])
    if (d.name === 'if' && ifTrue(c, d.args)) {
      const r = (d.block ?? []).find((x) => x.name === 'return')
      if (r) return doReturn(c, r, [])
    }
    if (d.name === 'rewrite') {
      let re: RegExp
      try {
        re = new RegExp(d.args[0])
      } catch {
        continue
      }
      const m = re.exec(c.uri)
      if (!m) continue
      const to = expand(c, d.args[1], [...m])
      const flag = d.args[2]
      if (flag === 'permanent' || flag === 'redirect' || /^https?:\/\//.test(to)) return respond(c, flag === 'permanent' ? 301 : 302, undefined, [['Location', /^https?:\/\//.test(to) ? to : `${c.req.scheme}://${vars(c, 'host')}${to}`]])
      const [path, q] = to.split('?')
      c.uri = path
      if (q) c.args = q
    }
  }
  return undefined
}

function doReturn(c: Ctx, d: NginxDirective, captures: string[]): HttpResponse {
  const code = Number(d.args[0])
  if (Number.isNaN(code)) return respond(c, 302, undefined, [['Location', expand(c, d.args[0], captures)]])
  const text = d.args[1] !== undefined ? expand(c, d.args[1], captures) : undefined
  if ([301, 302, 303, 307, 308].includes(code)) {
    const to = text ?? ''
    const loc = /^https?:\/\//.test(to) ? to : `${c.req.scheme}://${vars(c, 'host')}${to}`
    return respond(c, code, undefined, [['Location', loc]])
  }
  if (text !== undefined) return { status: code, headers: [['Content-Type', inherited(c, 'default_type')?.args[0] ?? 'application/octet-stream']], body: text + (text.endsWith('\n') ? '' : '') }
  return respond(c, code)
}

function staticUri(c: Ctx, loc: Loc | undefined, uri: string, depth = 0): HttpResponse {
  const path = filePath(c, loc, uri)
  const st = canRead(c, path.replace(/\/$/, '') || '/')
  if (st === 'missing') {
    errorLog(c, `open() "${path}" failed (2: No such file or directory)`)
    return respond(c, 404)
  }
  if (st === 'forbidden') {
    errorLog(c, `open() "${path}" failed (13: Permission denied)`)
    return respond(c, 403)
  }
  if (st === 'dir') {
    if (!uri.endsWith('/')) return respond(c, 301, undefined, [['Location', `${c.req.scheme}://${vars(c, 'host')}${uri}/`]])
    const index = inherited(c, 'index')?.args ?? ['index.html']
    const dir = path.replace(/\/$/, '')
    for (const i of index) {
      const f = `${dir}/${i}`
      if (c.sys.vfs.exists(f)) {
        // El índice es un redireccionamiento interno (puede terminar en la location de PHP).
        c.uri = uri + i
        return handleUri(c, depth + 1)
      }
    }
    if (inherited(c, 'autoindex')?.args[0] === 'on') {
      const items = c.sys.vfs.readdir(dir, ROOT_CRED).filter((n) => !n.startsWith('.'))
      return { status: 200, headers: [['Content-Type', 'text/html']], body: `<html>\r\n<head><title>Index of ${uri}</title></head>\r\n<body>\r\n<h1>Index of ${uri}</h1><hr><pre><a href="../">../</a>\r\n${items.map((n) => `<a href="${n}">${n}</a>`).join('\r\n')}\r\n</pre><hr></body>\r\n</html>\r\n` }
    }
    errorLog(c, `directory index of "${dir}/" is forbidden`)
    return respond(c, 403)
  }
  return serveFile(c, path)
}

function withErrorPages(c: Ctx, res: HttpResponse, depth: number): HttpResponse {
  if (res.status < 400 || depth > 0) return res
  for (const d of inheritedAll(c, 'error_page')) {
    const codes = d.args.slice(0, -1).filter((a) => /^\d+$/.test(a)).map(Number)
    const override = d.args.find((a) => /^=\d*$/.test(a))
    if (!codes.includes(res.status)) continue
    const target = d.args.at(-1)!
    if (/^https?:\/\//.test(target)) return respond(c, 302, undefined, [['Location', target]])
    c.uri = target
    const inner = handleUri(c, 1)
    const headers = inner.headers.filter(([k]) => !['last-modified', 'etag', 'accept-ranges'].includes(k.toLowerCase()))
    return { ...inner, headers, status: override ? Number(override.slice(1) || inner.status) : res.status }
  }
  return res
}

function addHeaders(c: Ctx, res: HttpResponse) {
  const okCodes = [200, 201, 204, 206, 301, 302, 303, 304, 307, 308]
  for (const d of inheritedAll(c, 'add_header')) {
    if (!okCodes.includes(res.status) && d.args[2] !== 'always') continue
    res.headers.push([d.args[0], expand(c, d.args[1] ?? '')])
  }
}

function nginxHandle(sys: System, srv: Server, req: HttpRequest): HttpResponse {
  const l = loaded(sys)
  const rt = web(sys)
  rt.requestSeq++
  const pid = sys.services.get('nginx')?.pid ?? 1234
  const [uri, args] = req.path.split(/\?(.*)/s, 2)
  const c: Ctx = { sys, l, srv, req, uri: decodeURIComponent(uri || '/'), args: args ?? '', seq: rt.requestSeq, pid: pid + 1, layers: [srv.block, l.http], docRoot: '' }
  let res: HttpResponse
  // HTTP plano a un puerto con TLS
  const plainToTls = req.scheme === 'http' && srv.listens.some((x) => x.port === req.port && x.ssl)
  if (plainToTls) res = respond(c, 400, `<html>\r\n<head><title>400 The plain HTTP request was sent to HTTPS port</title></head>\r\n<body>\r\n<center><h1>400 Bad Request</h1></center>\r\n<center>The plain HTTP request was sent to HTTPS port</center>\r\n<hr><center>nginx/${l.version}</center>\r\n</body>\r\n</html>\r\n`)
  else {
    // return y rewrite a nivel de server se aplican antes de elegir location.
    c.layers = [srv.block, l.http]
    const early = serverRewrite(c, srv.block)
    if (early) res = early
    else {
      res = handleUri(c)
      res = withErrorPages(c, res, 0)
    }
  }
  addHeaders(c, res)
  const tokens = inherited(c, 'server_tokens')?.args[0] !== 'off'
  res.headers = [['Server', tokens ? `nginx/${l.version}` : 'nginx'], ['Date', httpDate()], ...res.headers.filter(([k]) => k.toLowerCase() !== 'content-length'), ['Content-Length', String(res.body.length)], ['Connection', 'keep-alive']]
  // access.log, con el formato "main" de la distribución
  const xff = req.headers['x-forwarded-for'] ?? '-'
  const line = `${req.clientIp} - - [${timeLocal()}] "${req.method} ${req.path} HTTP/1.1" ${res.status} ${res.body.length} "${req.headers['referer'] ?? '-'}" "${req.headers['user-agent'] ?? '-'}"${sys.distro === 'rocky' ? ` "${xff}"` : ''}`
  append(sys, logPath(sys, c.layers, 'access_log'), line)
  return res
}

function nginxTls(sys: System, port: number, localIp: string, sni: string): TlsHello | { error: string } {
  const l = loaded(sys)
  const srv = pickServer({ ...l, servers: l.servers.filter((s) => s.listens.some((x) => x.ssl && listensOn(x, port, localIp))) }, port, localIp, sni)
  if (!srv?.cert?.chain.length) {
    append(sys, '/var/log/nginx/error.log', `${stamp()} [error] ${(sys.services.get('nginx')?.pid ?? 1234) + 1}#0: *${web(sys).requestSeq + 1} no "ssl_certificate" is defined in server listening on SSL port while SSL handshaking, client: 127.0.0.1, server: 0.0.0.0:${port}`)
    return { error: 'no certificate' }
  }
  const protos = first(srv.block, 'ssl_protocols')?.args ?? first(l.http, 'ssl_protocols')?.args ?? ['TLSv1.2', 'TLSv1.3']
  const h2 = first(srv.block, 'http2')?.args[0] === 'on' || first(l.http, 'http2')?.args[0] === 'on' || srv.listens.some((x) => x.http2)
  const ciphers = first(srv.block, 'ssl_ciphers')?.args[0] ?? first(l.http, 'ssl_ciphers')?.args[0]
  return { chain: srv.cert.chain, protocols: protos, h2, ciphers }
}

/** El motor de nginx se ofrece para atender un puerto. */
SERVERS.push((sys, port, localIp) => {
  const svc = sys.services.get('nginx')
  if (!svc?.active) return undefined
  if (!sys.vfs.exists('/etc/nginx/nginx.conf') && port === 80) {
    return { name: 'nginx', handle: () => ({ status: 200, headers: [['Server', `nginx/${nginxVersion(sys)}`], ['Content-Type', 'text/html']], body: '<h1>Welcome to nginx!</h1>\n' }) }
  }
  const l = loaded(sys)
  const listens = l.servers.flatMap((s) => s.listens).filter((x) => listensOn(x, port, localIp))
  if (!listens.length) return undefined
  const ssl = listens.some((x) => x.ssl)
  const ep: Endpoint = {
    name: 'nginx',
    handle: (req) => nginxHandle(sys, pickServer(l, port, localIp, (req.headers['host'] ?? '').replace(/:\d+$/, '').toLowerCase())!, req),
  }
  if (ssl) ep.tls = (sni) => nginxTls(sys, port, localIp, sni)
  return ep
})

/** Compatibilidad: lo que antes devolvía un pedido simple (para quien todavía lo use). */
export function nginxServe(sys: System, port: number, urlPath: string): { status: number; body: string; server: string } | undefined {
  const ep = endpointAt(sys, port, '127.0.0.1')
  if (!ep || ep.name !== 'nginx') return undefined
  const res = ep.handle({ method: 'GET', scheme: 'http', host: 'localhost', port, path: urlPath, headers: { host: 'localhost', 'user-agent': 'curl/8.12.1' }, body: '', clientIp: '127.0.0.1', localIp: '127.0.0.1' })
  return { status: res.status, body: res.body, server: res.headers.find(([k]) => k === 'Server')?.[1] ?? 'nginx' }
}

/** nginx -T: la configuración completa, archivo por archivo. */
export function nginxDump(sys: System): string {
  const files: ConfFile[] = []
  expanded(sys, '/etc/nginx/nginx.conf', files)
  return files
    .map((f) => {
      try {
        return `# configuration file ${f.path}:\n${sys.vfs.readFile(f.path, ROOT_CRED)}\n`
      } catch {
        return ''
      }
    })
    .join('')
}
