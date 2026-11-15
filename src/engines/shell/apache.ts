/**
 * Apache HTTP Server en el servidor simulado (httpd en Rocky, apache2 en Ubuntu).
 *
 * Lee la configuración con sus Include, respeta <IfModule> según los módulos cargados (en
 * Ubuntu, los de mods-enabled), arma los hosts virtuales y atiende solicitudes: elige el host
 * virtual por puerto y ServerName/ServerAlias, aplica <Directory> con Require, .htaccess según
 * AllowOverride, Redirect, RewriteRule, ProxyPass y HTTPS con mod_ssl. Los errores son los de
 * Apache: "Invalid command ... perhaps misspelled or defined by a module not included", 503 si
 * el backend no responde, AH01630 cuando Require deniega.
 */
import { appOnSocket, appRespond, endpointAt, httpDate, reach, REASON, SERVERS, web, type Endpoint, type HttpRequest, type HttpResponse, type TlsHello } from './http'
import { avc, httpdCanRead, portAllowed, portType } from './selinux'
import type { System } from './system'
import { certsIn, keyIn, type CertData } from './tls'
import { ROOT_CRED } from './vfs'

export interface ApDirective {
  name: string
  args: string[]
  file: string
  line: number
  /** Para secciones (<VirtualHost>, <Directory>...). */
  block?: ApDirective[]
}

/** Directivas conocidas y el módulo que las define (undefined: núcleo). */
const KNOWN: Record<string, string | undefined> = {
  serverroot: undefined,
  listen: undefined,
  include: undefined,
  includeoptional: undefined,
  user: undefined,
  group: undefined,
  serveradmin: undefined,
  servername: undefined,
  serveralias: undefined,
  documentroot: undefined,
  errorlog: undefined,
  loglevel: undefined,
  logformat: 'log_config_module',
  customlog: 'log_config_module',
  adddefaultcharset: undefined,
  enablesendfile: undefined,
  options: undefined,
  allowoverride: undefined,
  require: 'authz_core_module',
  directoryindex: 'dir_module',
  loadmodule: undefined,
  pidfile: undefined,
  timeout: undefined,
  keepalive: undefined,
  maxkeepaliverequests: undefined,
  keepalivetimeout: undefined,
  hostnamelookups: undefined,
  accessfilename: undefined,
  servertokens: undefined,
  serversignature: undefined,
  traceenable: undefined,
  mutex: undefined,
  defaultruntimedir: undefined,
  typesconfig: 'mime_module',
  addtype: 'mime_module',
  addhandler: 'mime_module',
  sethandler: undefined,
  alias: 'alias_module',
  scriptalias: 'alias_module',
  redirect: 'alias_module',
  redirectmatch: 'alias_module',
  rewriteengine: 'rewrite_module',
  rewriterule: 'rewrite_module',
  rewritecond: 'rewrite_module',
  rewritebase: 'rewrite_module',
  proxypass: 'proxy_module',
  proxypassreverse: 'proxy_module',
  proxypreservehost: 'proxy_module',
  proxyrequests: 'proxy_module',
  proxytimeout: 'proxy_module',
  requestheader: 'headers_module',
  header: 'headers_module',
  sslengine: 'ssl_module',
  sslcertificatefile: 'ssl_module',
  sslcertificatekeyfile: 'ssl_module',
  sslcertificatechainfile: 'ssl_module',
  sslprotocol: 'ssl_module',
  sslciphersuite: 'ssl_module',
  sslhonorcipherorder: 'ssl_module',
  sslsessiontickets: 'ssl_module',
  sslrandomseed: 'ssl_module',
  sslpassphrasedialog: 'ssl_module',
  sslsessioncache: 'ssl_module',
  sslsessioncachetimeout: 'ssl_module',
  sslcryptodevice: 'ssl_module',
  sslstaplingcache: 'ssl_module',
  protocols: undefined,
  authtype: 'auth_basic_module',
  authname: 'auth_basic_module',
  authuserfile: 'authn_file_module',
  errordocument: undefined,
  startservers: undefined,
  minspareservers: undefined,
  maxspareservers: undefined,
  maxrequestworkers: undefined,
  serverlimit: undefined,
  threadsperchild: undefined,
  maxconnectionsperchild: undefined,
  setenvif: 'setenvif_module',
  browsermatch: 'setenvif_module',
  addoutputfilterbytype: 'filter_module',
  limitrequestbody: undefined,
  fileetag: undefined,
  indexoptions: 'autoindex_module',
  php_value: undefined,
  php_admin_value: undefined,
  define: undefined,
  sslopensslconfcmd: 'ssl_module',
}

const SECTIONS = ['virtualhost', 'directory', 'directorymatch', 'location', 'locationmatch', 'files', 'filesmatch', 'ifmodule', 'ifdefine', 'ifversion', 'proxy', 'requireall', 'requireany', 'limit', 'limitexcept']

/** Módulos que se cargan siempre en el simulador (el núcleo y los de base). */
const BASE_MODULES = ['core_module', 'so_module', 'http_module', 'mpm_event_module', 'unixd_module', 'systemd_module', 'log_config_module', 'version_module']

export function apacheRoot(sys: System): string {
  return sys.distro === 'rocky' ? '/etc/httpd' : '/etc/apache2'
}

export function apacheService(sys: System): string {
  return sys.distro === 'rocky' ? 'httpd' : 'apache2'
}

function mainConf(sys: System): string {
  return sys.distro === 'rocky' ? '/etc/httpd/conf/httpd.conf' : '/etc/apache2/apache2.conf'
}

function envvars(sys: System, text: string): string {
  if (sys.distro !== 'ubuntu') return text
  return text.replace(/\$\{APACHE_LOG_DIR\}/g, '/var/log/apache2').replace(/\$\{APACHE_RUN_USER\}/g, 'www-data').replace(/\$\{APACHE_RUN_GROUP\}/g, 'www-data').replace(/\$\{APACHE_RUN_DIR\}/g, '/var/run/apache2').replace(/\$\{APACHE_LOCK_DIR\}/g, '/var/lock/apache2').replace(/\$\{APACHE_PID_FILE\}/g, '/var/run/apache2/apache2.pid')
}

function tokenize(line: string): string[] {
  const out: string[] = []
  const re = /"((?:\\.|[^"])*)"|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1] : m[2])
  return out
}

export interface ParseError {
  file: string
  line: number
  message: string
}

function globFiles(sys: System, pattern: string, root: string): string[] {
  const abs = pattern.startsWith('/') ? pattern : `${root}/${pattern}`
  if (!abs.includes('*')) return sys.vfs.exists(abs) ? (sys.vfs.stat(abs, ROOT_CRED).type === 'dir' ? sys.vfs.readdir(abs, ROOT_CRED).sort().map((f) => `${abs}/${f}`) : [abs]) : []
  const dir = abs.slice(0, abs.lastIndexOf('/'))
  const glob = abs.slice(abs.lastIndexOf('/') + 1)
  const re = new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
  try {
    return sys.vfs
      .readdir(dir, ROOT_CRED)
      .filter((n) => re.test(n))
      .sort()
      .map((n) => `${dir}/${n}`)
  } catch {
    return []
  }
}

interface ParseOut {
  tree: ApDirective[]
  errors: ParseError[]
  files: string[]
  modules: Set<string>
}

/** Lee la configuración completa: Include, LoadModule y secciones. */
export function parseApache(sys: System): ParseOut {
  const root = apacheRoot(sys)
  const out: ParseOut = { tree: [], errors: [], files: [], modules: new Set(BASE_MODULES) }
  const readFile = (path: string, optional: boolean, depth: number): ApDirective[] => {
    if (depth > 10) return []
    let text: string
    try {
      text = envvars(sys, sys.vfs.readFile(path, ROOT_CRED))
    } catch {
      if (!optional) out.errors.push({ file: path, line: 0, message: `Could not open configuration file ${path}: No such file or directory` })
      return []
    }
    out.files.push(path)
    const stack: { name: string; d: ApDirective; list: ApDirective[] }[] = []
    let list: ApDirective[] = []
    const top = list
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      let raw = lines[i]
      while (raw.endsWith('\\') && i + 1 < lines.length) raw = raw.slice(0, -1) + ' ' + lines[++i]
      const t = raw.trim()
      if (!t || t.startsWith('#')) continue
      const close = /^<\/(\w+)\s*>$/.exec(t)
      if (close) {
        const top2 = stack.pop()
        if (!top2 || top2.name !== close[1].toLowerCase()) {
          out.errors.push({ file: path, line: i + 1, message: `</${close[1]}> without matching <${close[1]}> section` })
          if (top2) stack.push(top2)
          continue
        }
        list = stack.length ? stack[stack.length - 1].d.block! : top
        continue
      }
      const open = /^<(\w+)(\s+[^>]*)?>$/.exec(t)
      if (open) {
        const name = open[1].toLowerCase()
        if (!SECTIONS.includes(name)) {
          out.errors.push({ file: path, line: i + 1, message: `Invalid command '<${open[1]}', perhaps misspelled or defined by a module not included in the server configuration` })
          continue
        }
        const d: ApDirective = { name, args: tokenize(open[2] ?? ''), file: path, line: i + 1, block: [] }
        list.push(d)
        stack.push({ name, d, list })
        list = d.block!
        continue
      }
      if (t.startsWith('<')) {
        out.errors.push({ file: path, line: i + 1, message: `Syntax error in -C/-c directive` })
        continue
      }
      const [name, ...args] = tokenize(t)
      const lname = name.toLowerCase()
      if (lname === 'include' || lname === 'includeoptional') {
        const files = globFiles(sys, args[0] ?? '', root)
        if (!files.length && lname === 'include' && !(args[0] ?? '').includes('*')) out.errors.push({ file: path, line: i + 1, message: `Could not open configuration file ${args[0]}: No such file or directory` })
        list.push(...files.flatMap((f) => readFile(f, lname === 'includeoptional', depth + 1)))
        continue
      }
      if (lname === 'loadmodule') out.modules.add(args[0])
      list.push({ name: lname, args, file: path, line: i + 1 })
    }
    for (const s of stack) out.errors.push({ file: path, line: s.d.line, message: `<${s.name.replace(/^\w/, (c) => c.toUpperCase()).replace('host', 'Host')}> was not closed.` })
    return top
  }
  out.tree = readFile(mainConf(sys), false, 0)
  // <IfModule>: se resuelven ahora que se sabe qué módulos hay.
  const resolve = (list: ApDirective[]): ApDirective[] =>
    list.flatMap((d) => {
      if (d.name === 'ifmodule') {
        const want = d.args[0] ?? ''
        const neg = want.startsWith('!')
        const mod = want.replace(/^!/, '').replace(/^mod_(\w+)\.c$/, '$1_module')
        const has = out.modules.has(mod) || out.modules.has(`${mod}_module`)
        return has !== neg ? resolve(d.block ?? []) : []
      }
      if (d.name === 'ifdefine' || d.name === 'ifversion') return resolve(d.block ?? [])
      return d.block ? [{ ...d, block: resolve(d.block) }] : [d]
    })
  out.tree = resolve(out.tree)
  // Directivas desconocidas o de módulos que no están cargados.
  const check = (list: ApDirective[]) => {
    for (const d of list) {
      if (d.block) {
        check(d.block)
        continue
      }
      if (!(d.name in KNOWN)) {
        out.errors.push({ file: d.file, line: d.line, message: `Invalid command '${orig(sys, d)}', perhaps misspelled or defined by a module not included in the server configuration` })
        continue
      }
      const mod = KNOWN[d.name]
      if (mod && !out.modules.has(mod)) out.errors.push({ file: d.file, line: d.line, message: `Invalid command '${orig(sys, d)}', perhaps misspelled or defined by a module not included in the server configuration` })
    }
  }
  check(out.tree)
  return out
}

/** El nombre de la directiva tal como estaba escrita. */
function orig(sys: System, d: ApDirective): string {
  try {
    const line = envvars(sys, sys.vfs.readFile(d.file, ROOT_CRED)).split('\n')[d.line - 1] ?? ''
    return line.trim().split(/\s+/)[0]
  } catch {
    return d.name
  }
}

/** apachectl configtest: errores de sintaxis, archivos de certificados y DocumentRoot. */
export function apacheTest(sys: System): { errors: string[]; warnings: string[] } {
  const p = parseApache(sys)
  const errors = p.errors.map((e) => (e.line ? `AH00526: Syntax error on line ${e.line} of ${e.file}:\n${e.message}` : e.message))
  const warnings: string[] = []
  if (errors.length) return { errors, warnings }
  const all = flat(p.tree)
  for (const d of all) {
    if (d.name === 'documentroot' && d.args[0] && !sys.vfs.exists(d.args[0])) warnings.push(`AH00112: Warning: DocumentRoot [${d.args[0]}] does not exist`)
    if ((d.name === 'sslcertificatefile' || d.name === 'sslcertificatekeyfile') && d.args[0]) {
      const exists = sys.vfs.exists(d.args[0]) && sys.vfs.readFile(d.args[0], ROOT_CRED).length > 0
      if (!exists) errors.push(`AH00526: Syntax error on line ${d.line} of ${d.file}:\n${d.name === 'sslcertificatefile' ? 'SSLCertificateFile' : 'SSLCertificateKeyFile'}: file '${d.args[0]}' does not exist or is empty`)
    }
  }
  return { errors, warnings }
}

function flat(list: ApDirective[]): ApDirective[] {
  return list.flatMap((d) => (d.block ? [d, ...flat(d.block)] : [d]))
}

// ---------------------------------------------------------------------------------------
// Configuración cargada
// ---------------------------------------------------------------------------------------

interface VHost {
  addr: string
  port: number
  names: string[]
  block: ApDirective[]
  file: string
  line: number
  ssl: boolean
  chain?: CertData[]
}

interface Loaded {
  tree: ApDirective[]
  modules: Set<string>
  listens: { addr: string; port: number }[]
  vhosts: VHost[]
  user: string
}

const LOADED = new WeakMap<System, Loaded>()

function get(list: ApDirective[], name: string): ApDirective | undefined {
  return list.find((d) => d.name === name)
}

function load(sys: System): Loaded {
  const p = parseApache(sys)
  const listens = flat(p.tree)
    .filter((d) => d.name === 'listen')
    .map((d) => {
      const m = /^(?:([\d.]+|\*|\[[^\]]+\]):)?(\d+)$/.exec(d.args[0] ?? '')
      return { addr: !m?.[1] || m[1] === '*' ? '0.0.0.0' : m[1], port: Number(m?.[2] ?? 80) }
    })
  const vhosts: VHost[] = p.tree
    .filter((d) => d.name === 'virtualhost')
    .map((d) => {
      const m = /^(?:([\d.]+|\*|_default_|\[[^\]]+\]):)?(\d+)?$/.exec(d.args[0] ?? '*:80')
      const b = d.block ?? []
      const names = [get(b, 'servername')?.args[0], ...(b.filter((x) => x.name === 'serveralias').flatMap((x) => x.args))].filter((x): x is string => !!x).map((x) => x.toLowerCase())
      const ssl = get(b, 'sslengine')?.args[0]?.toLowerCase() === 'on'
      const certPath = get(b, 'sslcertificatefile')?.args[0]
      let chain: CertData[] | undefined
      if (ssl && certPath && sys.vfs.exists(certPath)) {
        chain = certsIn(sys.vfs.readFile(certPath, ROOT_CRED))
        const extra = get(b, 'sslcertificatechainfile')?.args[0]
        if (extra && sys.vfs.exists(extra)) chain.push(...certsIn(sys.vfs.readFile(extra, ROOT_CRED)))
      }
      return { addr: !m?.[1] || m[1] === '*' || m[1] === '_default_' ? '0.0.0.0' : m[1], port: Number(m?.[2] ?? 80), names, block: b, file: d.file, line: d.line, ssl, chain }
    })
  const user = get(p.tree, 'user')?.args[0] ?? (sys.distro === 'rocky' ? 'apache' : 'www-data')
  return { tree: p.tree, modules: p.modules, listens, vhosts, user }
}

export function apachePrime(sys: System) {
  if (sys.vfs.exists(mainConf(sys)) && !apacheTest(sys).errors.length) LOADED.set(sys, load(sys))
}

function loaded(sys: System): Loaded {
  let l = LOADED.get(sys)
  if (!l) {
    l = load(sys)
    LOADED.set(sys, l)
  }
  return l
}

/** Al arrancar o recargar Apache. */
export function apacheStartCheck(sys: System): string | undefined {
  if (!sys.vfs.exists(mainConf(sys))) return undefined
  const t = apacheTest(sys)
  if (t.errors.length) return t.errors[0]
  const l = load(sys)
  for (const v of l.vhosts.filter((x) => x.ssl)) {
    const keyPath = get(v.block, 'sslcertificatekeyfile')?.args[0]
    const key = keyPath && sys.vfs.exists(keyPath) ? keyIn(sys.vfs.readFile(keyPath, ROOT_CRED)) : undefined
    if (!v.chain?.length) return `AH02572: Failed to configure at least one certificate and key for ${v.names[0] ?? 'localhost'}:${v.port}`
    if (key && key.id !== v.chain[0].keyId) return `AH02565: Certificate and private key ${v.names[0] ?? 'localhost'}:${v.port}:0 from ${get(v.block, 'sslcertificatefile')?.args[0]} and ${keyPath} do not match`
  }
  const ports = [...new Set(l.listens.map((x) => x.port))]
  for (const p of ports) if (!portAllowed(sys, 'http_port_t', p)) return `(13)Permission denied: AH00072: make_sock: could not bind to address 0.0.0.0:${p}`
  const svc = sys.services.get(apacheService(sys))
  if (svc) svc.ports = ports
  LOADED.set(sys, l)
  return undefined
}

// ---------------------------------------------------------------------------------------
// Atender
// ---------------------------------------------------------------------------------------

function apPage(code: number, sys: System, extra = ''): string {
  const text: Record<number, string> = {
    403: "<p>You don't have permission to access this resource.</p>",
    404: '<p>The requested URL was not found on this server.</p>',
    500: '<p>The server encountered an internal error or\nmisconfiguration and was unable to complete\nyour request.</p>',
    503: '<p>The server is temporarily unable to service your\nrequest due to maintenance downtime or capacity\nproblems. Please try again later.</p>',
    401: "<p>This server could not verify that you\nare authorized to access the document\nrequested.</p>",
    301: '',
    302: '',
  }
  const title = REASON[code] ?? ''
  void sys
  return `<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html><head>\n<title>${code} ${title}</title>\n</head><body>\n<h1>${title.replace(/^Service Temporarily Unavailable$/, 'Service Unavailable')}</h1>\n${text[code] ?? extra}\n</body></html>\n`
}

interface ACtx {
  sys: System
  l: Loaded
  v?: VHost
  req: HttpRequest
  uri: string
}

function apLog(c: ACtx, msg: string, mod = 'core', level = 'error') {
  const d = new Date()
  const stamp = `${d.toUTCString().slice(0, 3)} ${d.toUTCString().slice(8, 11)} ${String(d.getUTCDate()).padStart(2, '0')} ${d.toISOString().slice(11, 23)}000 ${d.getUTCFullYear()}`
  const file = errorLogFile(c)
  const line = `[${stamp}] [${mod}:${level}] [pid ${c.sys.services.get(apacheService(c.sys))?.pid ?? 4242}:tid 4242] [client ${c.req.clientIp}:51234] ${msg}`
  try {
    c.sys.vfs.mkdirp(file.slice(0, file.lastIndexOf('/')), ROOT_CRED)
    c.sys.vfs.writeFile(file, line + '\n', ROOT_CRED, { append: true })
  } catch {
    // sin registro
  }
}

function logDir(sys: System): string {
  return sys.distro === 'rocky' ? '/var/log/httpd' : '/var/log/apache2'
}

function errorLogFile(c: ACtx): string {
  const d = (c.v && get(c.v.block, 'errorlog')) ?? get(c.l.tree, 'errorlog')
  const raw = d?.args[0] ?? (c.sys.distro === 'rocky' ? 'logs/error_log' : '/var/log/apache2/error.log')
  return raw.startsWith('logs/') ? `${logDir(c.sys)}/${raw.slice(5)}` : raw.startsWith('/') ? raw : `${apacheRoot(c.sys)}/${raw}`
}

function accessLogFile(c: ACtx): string | undefined {
  const d = (c.v && get(c.v.block, 'customlog')) ?? get(c.l.tree, 'customlog')
  const raw = d?.args[0] ?? (c.sys.distro === 'rocky' ? 'logs/access_log' : '/var/log/apache2/access.log')
  return raw.startsWith('logs/') ? `${logDir(c.sys)}/${raw.slice(5)}` : raw.startsWith('/') ? raw : `${apacheRoot(c.sys)}/${raw}`
}

function docRoot(c: ACtx): string {
  return ((c.v && get(c.v.block, 'documentroot')?.args[0]) ?? get(c.l.tree, 'documentroot')?.args[0] ?? '/var/www/html').replace(/\/$/, '')
}

/** Las secciones <Directory> que aplican a una ruta, de la más general a la más específica. */
function directories(c: ACtx, path: string): ApDirective[] {
  const all = [...c.l.tree.filter((d) => d.name === 'directory'), ...(c.v?.block.filter((d) => d.name === 'directory') ?? [])]
  return all
    .filter((d) => {
      const dir = (d.args[0] ?? '').replace(/\/$/, '') || '/'
      return dir === '/' || path === dir || path.startsWith(dir + '/')
    })
    .sort((a, b) => (a.args[0] ?? '').length - (b.args[0] ?? '').length)
}

function dirSetting(c: ACtx, path: string, name: string): ApDirective | undefined {
  let found: ApDirective | undefined
  for (const d of directories(c, path)) found = get(d.block ?? [], name) ?? found
  return found
}

function requireResult(list: ApDirective[], ip: string): boolean | undefined {
  const reqs = list.filter((d) => d.name === 'require')
  if (!reqs.length) return undefined
  for (const r of reqs) {
    const [kind, ...rest] = r.args.map((x) => x.toLowerCase())
    if (kind === 'all') return rest[0] === 'granted'
    if (kind === 'ip') return rest.some((n) => ip === n || ip.startsWith(n.replace(/\.0\/\d+$/, '.').replace(/\/\d+$/, '')))
    if (kind === 'local') return ip.startsWith('127.')
  }
  return false
}

const OVERRIDES: Record<string, string> = { require: 'AuthConfig', authtype: 'AuthConfig', authname: 'AuthConfig', authuserfile: 'AuthConfig', rewriteengine: 'FileInfo', rewriterule: 'FileInfo', rewritecond: 'FileInfo', rewritebase: 'FileInfo', redirect: 'FileInfo', errordocument: 'FileInfo', header: 'FileInfo', options: 'Options', directoryindex: 'Indexes' }

/** Lee los .htaccess desde DocumentRoot hasta la carpeta del archivo, si AllowOverride lo permite. */
function htaccess(c: ACtx, dirPath: string): { list: ApDirective[] } | { error: string } {
  const root = docRoot(c)
  const out: ApDirective[] = []
  const parts = dirPath.slice(root.length).split('/').filter(Boolean)
  let cur = root
  for (let i = 0; i <= parts.length; i++) {
    if (i > 0) cur += `/${parts[i - 1]}`
    const file = `${cur}/.htaccess`
    if (!c.sys.vfs.exists(file)) continue
    const allow = (dirSetting(c, cur, 'allowoverride')?.args ?? ['None']).map((x) => x.toLowerCase())
    if (allow.includes('none')) continue
    const text = c.sys.vfs.readFile(file, ROOT_CRED)
    const lines = text.split('\n')
    for (let n = 0; n < lines.length; n++) {
      const t = lines[n].trim()
      if (!t || t.startsWith('#') || t.startsWith('<')) continue
      const [name, ...args] = tokenize(t)
      const lname = name.toLowerCase()
      const mod = KNOWN[lname]
      if (!(lname in KNOWN) || (mod && !c.l.modules.has(mod))) return { error: `${file}: Invalid command '${name}', perhaps misspelled or defined by a module not included in the server configuration` }
      const need = OVERRIDES[lname]
      if (!allow.includes('all') && (!need || !allow.includes(need.toLowerCase()))) return { error: `${file}: ${name} not allowed here` }
      out.push({ name: lname, args, file, line: n + 1 })
    }
  }
  return { list: out }
}

function rewrite(c: ACtx, rules: ApDirective[], subject: string, perDir: boolean): { redirect?: [number, string]; uri?: string; proxy?: string; forbidden?: boolean; gone?: boolean } | undefined {
  if (!rules.some((d) => d.name === 'rewriteengine' && d.args[0]?.toLowerCase() === 'on')) return undefined
  let conds: ApDirective[] = []
  let current = subject
  for (const d of rules) {
    if (d.name === 'rewritecond') {
      conds.push(d)
      continue
    }
    if (d.name !== 'rewriterule') continue
    const myConds = conds
    conds = []
    let re: RegExp
    try {
      re = new RegExp(d.args[0])
    } catch {
      continue
    }
    const m = re.exec(current)
    if (!m) continue
    const condOk = myConds.every((cd) => {
      const val = (cd.args[0] ?? '').replace(/%\{HTTPS\}/g, c.req.scheme === 'https' ? 'on' : 'off').replace(/%\{HTTP_HOST\}/g, c.req.headers['host'] ?? '').replace(/%\{REQUEST_URI\}/g, c.req.path).replace(/%\{REQUEST_FILENAME\}/g, docRoot(c) + c.uri)
      const pat = cd.args[1] ?? ''
      if (pat === '!-f') return !c.sys.vfs.exists(val) || c.sys.vfs.stat(val, ROOT_CRED).type !== 'file'
      if (pat === '!-d') return !c.sys.vfs.exists(val) || c.sys.vfs.stat(val, ROOT_CRED).type !== 'dir'
      if (pat === '-f') return c.sys.vfs.exists(val) && c.sys.vfs.stat(val, ROOT_CRED).type === 'file'
      const neg = pat.startsWith('!')
      try {
        return new RegExp(pat.replace(/^!/, ''), /\[.*NC.*\]/.test(cd.args[2] ?? '') ? 'i' : '').test(val) !== neg
      } catch {
        return false
      }
    })
    if (!condOk) continue
    const flags = (d.args[2] ?? '').replace(/[[\]]/g, '').split(',').map((x) => x.trim().toUpperCase())
    let to = (d.args[1] ?? '-').replace(/\$(\d)/g, (_, n) => m[Number(n)] ?? '').replace(/%\{HTTP_HOST\}/g, (c.req.headers['host'] ?? '').replace(/:\d+$/, '')).replace(/%\{REQUEST_URI\}/g, c.req.path)
    if (flags.includes('F')) return { forbidden: true }
    if (flags.includes('G')) return { gone: true }
    if (flags.includes('P')) return { proxy: to }
    const r = flags.find((f) => f === 'R' || f.startsWith('R='))
    if (r || /^https?:\/\//.test(to)) {
      const code = r && r.includes('=') ? Number(r.split('=')[1]) : 302
      if (!/^https?:\/\//.test(to)) to = `${c.req.scheme}://${(c.req.headers['host'] ?? '').replace(/:\d+$/, '')}${perDir ? '/' : ''}${to.replace(/^\//, perDir ? '' : '/')}`
      return { redirect: [code, to] }
    }
    if (to !== '-') current = perDir ? to : to
    if (flags.includes('L')) return { uri: perDir ? `/${current.replace(/^\//, '')}` : current }
  }
  return current !== subject ? { uri: perDir ? `/${current.replace(/^\//, '')}` : current } : undefined
}

function proxyAllowed(sys: System, port: number): boolean {
  if (sys.distro !== 'rocky' || sys.selinux.mode === 'disabled') return true
  if (sys.selinux.booleans.get('httpd_can_network_connect')?.cur) return true
  const t = portType(sys, 'tcp', port)
  if (t === 'http_port_t') return true
  avc(sys, 'httpd', 'name_connect', `dest=${port}`, 'httpd_t', `system_u:object_r:${t}:s0`, 'tcp_socket')
  return sys.selinux.mode === 'permissive'
}

function apProxy(c: ACtx, target: string): HttpResponse {
  if (!c.l.modules.has('proxy_http_module') && /^https?:/.test(target)) {
    apLog(c, `AH01144: No protocol handler was valid for the URL ${c.req.path} (scheme 'http'). If you are using a DSO version of mod_proxy, make sure the proxy submodules are included in the configuration using LoadModule.`, 'proxy', 'warn')
    return { status: 500, headers: [['Content-Type', 'text/html; charset=iso-8859-1']], body: apPage(500, c.sys) }
  }
  const sock = /^unix:([^|]+)\|/.exec(target)?.[1]
  const preserve = (c.v && get(c.v.block, 'proxypreservehost')?.args[0]?.toLowerCase()) === 'on'
  const m = /^https?:\/\/([^/:]+)(?::(\d+))?(\/.*)?$/.exec(target.replace(/^unix:[^|]+\|/, ''))
  const port = Number(m?.[2] ?? 80)
  const host = m?.[1] ?? 'localhost'
  const headers: Record<string, string> = { ...c.req.headers, host: preserve ? c.req.headers['host'] ?? host : `${host}${m?.[2] ? `:${port}` : ''}`, 'x-forwarded-for': c.req.headers['x-forwarded-for'] ? `${c.req.headers['x-forwarded-for']}, ${c.req.clientIp}` : c.req.clientIp, 'x-forwarded-host': c.req.headers['host'] ?? '', 'x-forwarded-server': c.v?.names[0] ?? '' }
  for (const d of c.v?.block.filter((x) => x.name === 'requestheader' && x.args[0]?.toLowerCase() === 'set') ?? []) headers[(d.args[1] ?? '').toLowerCase()] = (d.args[2] ?? '').replace(/%\{REQUEST_SCHEME\}s/g, c.req.scheme)
  const req: HttpRequest = { ...c.req, path: m?.[3] ?? '/', headers }
  if (sock) {
    const app = appOnSocket(c.sys, sock)
    if (!app) {
      apLog(c, `(2)No such file or directory: AH02454: HTTP: attempt to connect to Unix domain socket ${sock} (localhost) failed`, 'proxy')
      return { status: 503, headers: [['Content-Type', 'text/html; charset=iso-8859-1']], body: apPage(503, c.sys) }
    }
    return appRespond(c.sys, app, req)
  }
  const ip = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : host === 'localhost' ? '127.0.0.1' : c.sys.resolveHost(host) ?? host
  const fail = (why: string): HttpResponse => {
    apLog(c, `${why}: AH00957: http: attempt to connect to ${ip}:${port} (${host}:${port}) failed`, 'proxy')
    apLog(c, `AH01114: HTTP: failed to make connection to backend: ${host}`, 'proxy_http')
    return { status: 503, headers: [['Content-Type', 'text/html; charset=iso-8859-1']], body: apPage(503, c.sys) }
  }
  if (!proxyAllowed(c.sys, port)) return fail('(13)Permission denied')
  const r = reach(c.sys, ip, port)
  if ('error' in r) return r.error === 'outside' ? { status: 200, headers: [], body: `<h1>${host}</h1>\n` } : fail(r.error === 'timeout' ? '(110)Connection timed out' : '(113)No route to host')
  const ep = endpointAt(r.target, port, r.localIp)
  if (!ep) return fail('(111)Connection refused')
  return ep.handle({ ...req, clientIp: r.clientIp, localIp: r.localIp, port })
}

function apHandle(sys: System, l: Loaded, v: VHost | undefined, req: HttpRequest): HttpResponse {
  const [uri] = req.path.split('?')
  const c: ACtx = { sys, l, v, req, uri: decodeURIComponent(uri || '/') }
  const scope = v?.block ?? l.tree
  const page = (code: number): HttpResponse => ({ status: code, headers: [['Content-Type', 'text/html; charset=iso-8859-1']], body: apPage(code, sys) })
  // Redirect en el host virtual
  for (const d of scope.filter((x) => x.name === 'redirect')) {
    const [a, b, cc] = d.args
    const status = /^\d+$/.test(a) ? Number(a) : a === 'permanent' ? 301 : a === 'temp' ? 302 : undefined
    const from = status !== undefined || ['permanent', 'temp', 'seeother'].includes(a) ? b : a
    const to = status !== undefined || ['permanent', 'temp', 'seeother'].includes(a) ? cc : b
    if (from && to && (c.uri === from || c.uri.startsWith(from.replace(/\/$/, '') + '/'))) {
      const rest = c.uri.slice(from.replace(/\/$/, '').length)
      return { status: status ?? 302, headers: [['Location', to.replace(/\/$/, '') + rest], ['Content-Type', 'text/html; charset=iso-8859-1']], body: apPage(status ?? 302, sys) }
    }
  }
  // RewriteRule en el host virtual
  const rw = rewrite(c, scope, c.uri, false)
  if (rw?.redirect) return { status: rw.redirect[0], headers: [['Location', rw.redirect[1]], ['Content-Type', 'text/html; charset=iso-8859-1']], body: apPage(rw.redirect[0], sys) }
  if (rw?.forbidden) return page(403)
  if (rw?.proxy) return apProxy(c, rw.proxy)
  if (rw?.uri) c.uri = rw.uri
  // ProxyPass
  for (const d of scope.filter((x) => x.name === 'proxypass')) {
    const [prefix, target] = d.args
    if (!prefix || !target) continue
    if (target === '!') {
      if (c.uri.startsWith(prefix)) break
      continue
    }
    if (c.uri === prefix || c.uri.startsWith(prefix.endsWith('/') ? prefix : prefix + '/') || (prefix === '/' && c.uri.startsWith('/'))) {
      const rest = c.uri.slice(prefix.length)
      const q = req.path.includes('?') ? req.path.slice(req.path.indexOf('?')) : ''
      const base = target.replace(/^unix:[^|]+\|/, '')
      return apProxy(c, target.replace(base, base.replace(/\/?$/, target.endsWith('/') ? '/' : '') + rest.replace(/^\//, target.endsWith('/') ? '' : '/') + q))
    }
  }
  // Archivos
  const root = docRoot(c)
  let path = root + c.uri
  const parts = path.split('/').filter(Boolean)
  let cur = ''
  for (const p of parts) {
    cur += `/${p}`
    if (!sys.vfs.exists(cur)) break
  }
  const exists = sys.vfs.exists(path)
  const isDir = exists && sys.vfs.stat(path, ROOT_CRED).type === 'dir'
  const dirPath = isDir ? path.replace(/\/$/, '') : path.slice(0, path.lastIndexOf('/')) || '/'
  // Require de <Directory>
  let allowed: boolean | undefined
  for (const d of directories(c, dirPath)) allowed = requireResult(d.block ?? [], req.clientIp) ?? allowed
  const ht = exists || sys.vfs.exists(dirPath) ? htaccess(c, dirPath) : { list: [] }
  if ('error' in ht) {
    apLog(c, ht.error, 'core', 'alert')
    return page(500)
  }
  const htAllowed = requireResult(ht.list, req.clientIp)
  if (htAllowed !== undefined) allowed = htAllowed
  if (allowed === false) {
    apLog(c, `AH01630: client denied by server configuration: ${path}`, 'authz_core')
    return page(403)
  }
  const hrw = rewrite(c, ht.list, c.uri.replace(/^\//, ''), true)
  if (hrw?.redirect) return { status: hrw.redirect[0], headers: [['Location', hrw.redirect[1]], ['Content-Type', 'text/html; charset=iso-8859-1']], body: apPage(hrw.redirect[0], sys) }
  if (hrw?.forbidden) return page(403)
  if (hrw?.uri) {
    c.uri = hrw.uri
    path = root + c.uri
  }
  if (!sys.vfs.exists(path)) return page(404)
  const cred = sys.credFor(sys.users.has(l.user) ? l.user : 'root')
  let node = sys.vfs.stat(path, ROOT_CRED)
  if (node.type === 'dir') {
    if (!c.uri.endsWith('/')) return { status: 301, headers: [['Location', `${req.scheme}://${(req.headers['host'] ?? '').replace(/:\d+$/, '')}${c.uri}/`], ['Content-Type', 'text/html; charset=iso-8859-1']], body: apPage(301, sys) }
    const idx = (ht.list.find((d) => d.name === 'directoryindex') ?? dirSetting(c, path, 'directoryindex') ?? get(scope, 'directoryindex') ?? get(l.tree, 'directoryindex'))?.args ?? ['index.html']
    const found = idx.map((i) => `${path.replace(/\/$/, '')}/${i}`).find((f) => sys.vfs.exists(f))
    if (!found) {
      const opts = (dirSetting(c, path, 'options')?.args ?? []).map((x) => x.toLowerCase())
      if (opts.includes('indexes') || opts.includes('+indexes')) return { status: 200, headers: [['Content-Type', 'text/html;charset=UTF-8']], body: `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">\n<html>\n <head>\n  <title>Index of ${c.uri}</title>\n </head>\n <body>\n<h1>Index of ${c.uri}</h1>\n${sys.vfs.readdir(path, ROOT_CRED).filter((n) => !n.startsWith('.')).map((n) => `<a href="${n}">${n}</a><br>`).join('\n')}\n</body></html>\n` }
      apLog(c, `AH01276: Cannot serve directory ${path.replace(/\/?$/, '/')}: No matching DirectoryIndex (${idx.join(',')}) found, and server-generated directory index forbidden by Options directive`, 'autoindex')
      return page(403)
    }
    path = found
    node = sys.vfs.stat(path, ROOT_CRED)
  }
  // Cada carpeta del camino tiene que poder atravesarse.
  let walk = ''
  for (const p of path.split('/').filter(Boolean).slice(0, -1)) {
    walk += `/${p}`
    if (!sys.vfs.can(sys.vfs.stat(walk, ROOT_CRED), cred, 1)) {
      apLog(c, `AH00035: access to ${c.uri} denied (filesystem path '${walk}') because search permissions are missing on a component of the path`)
      return page(403)
    }
  }
  if (!sys.vfs.can(node, cred, 4) || !httpdCanRead(sys, path, 'httpd')) {
    apLog(c, `AH00132: file permissions deny server access: ${path}`)
    return page(403)
  }
  const ext = path.split('.').pop() ?? ''
  const type = ({ html: 'text/html; charset=UTF-8', css: 'text/css', js: 'text/javascript', txt: 'text/plain; charset=UTF-8', json: 'application/json' } as Record<string, string>)[ext] ?? 'text/plain; charset=UTF-8'
  return { status: 200, headers: [['Last-Modified', httpDate(node.mtime ?? Date.now())], ['ETag', `"${node.data.length.toString(16)}-${(node.mtime ?? 0).toString(16).slice(-8)}"`], ['Accept-Ranges', 'bytes'], ['Content-Type', type]], body: node.data }
}

function pickVhost(l: Loaded, port: number, localIp: string, host: string, ssl?: boolean): VHost | undefined {
  const cands = l.vhosts.filter((v) => v.port === port && (v.addr === '0.0.0.0' || v.addr === localIp) && (ssl === undefined || v.ssl === ssl))
  return cands.find((v) => v.names.includes(host)) ?? cands.find((v) => v.names.some((n) => n.startsWith('*.') && host.endsWith(n.slice(1)))) ?? cands[0]
}

function serverHeader(sys: System, l: Loaded): string {
  const tokens = (get(l.tree, 'servertokens')?.args[0] ?? 'Full').toLowerCase()
  const v = sys.distro === 'rocky' ? '2.4.63' : '2.4.66'
  if (tokens === 'prod' || tokens === 'productonly') return 'Apache'
  return sys.distro === 'rocky' ? `Apache/${v} (Rocky Linux)${l.modules.has('ssl_module') ? ' OpenSSL/3.5.1' : ''}` : `Apache/${v} (Ubuntu)`
}

SERVERS.push((sys, port, localIp) => {
  const svc = sys.services.get(apacheService(sys))
  if (!svc?.active) return undefined
  if (!sys.vfs.exists(mainConf(sys))) return undefined
  const l = loaded(sys)
  if (!l.listens.some((x) => x.port === port && (x.addr === '0.0.0.0' || x.addr === localIp))) return undefined
  const ssl = l.vhosts.some((v) => v.port === port && v.ssl)
  const ep: Endpoint = {
    name: svc.name,
    handle: (req) => {
      const host = (req.headers['host'] ?? '').replace(/:\d+$/, '').toLowerCase()
      const v = pickVhost(l, port, localIp, host, ssl ? req.scheme === 'https' : undefined)
      let res: HttpResponse
      if (ssl && req.scheme === 'http') res = { status: 400, headers: [['Content-Type', 'text/html; charset=iso-8859-1']], body: `<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html><head>\n<title>400 Bad Request</title>\n</head><body>\n<h1>Bad Request</h1>\n<p>Your browser sent a request that this server could not understand.<br />\nReason: You're speaking plain HTTP to an SSL-enabled server port.<br />\n Instead use the HTTPS scheme to access this URL, please.<br />\n</p>\n</body></html>\n` }
      else res = apHandle(sys, l, v, req)
      for (const d of (v?.block ?? l.tree).filter((x) => x.name === 'header' && ['set', 'always'].includes((x.args[0] ?? '').toLowerCase()))) {
        const a = d.args[0].toLowerCase() === 'always' ? d.args.slice(1) : d.args
        res.headers.push([a[1] ?? '', a[2] ?? ''])
      }
      res.headers = [['Date', httpDate()], ['Server', serverHeader(sys, l)], ...res.headers, ['Content-Length', String(res.body.length)]]
      const c: ACtx = { sys, l, v, req, uri: req.path }
      const file = accessLogFile(c)
      if (file) {
        try {
          sys.vfs.mkdirp(file.slice(0, file.lastIndexOf('/')), ROOT_CRED)
          const d = new Date()
          const p2 = (n: number) => String(n).padStart(2, '0')
          sys.vfs.writeFile(file, `${req.clientIp} - - [${p2(d.getUTCDate())}/${d.toUTCString().slice(8, 11)}/${d.getUTCFullYear()}:${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000] "${req.method} ${req.path} HTTP/1.1" ${res.status} ${res.body.length} "-" "${req.headers['user-agent'] ?? '-'}"\n`, ROOT_CRED, { append: true })
        } catch {
          // sin registro
        }
      }
      return res
    },
  }
  if (ssl)
    ep.tls = (sni): TlsHello | { error: string } => {
      const v = pickVhost(l, port, localIp, sni.toLowerCase(), true)
      if (!v?.chain?.length) return { error: 'no certificate' }
      const protos = (get(v.block, 'sslprotocol')?.args ?? ['all', '-SSLv3', '-TLSv1', '-TLSv1.1']).map((x) => x.toLowerCase())
      const list = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3'].filter((p) => {
        const key = p.toLowerCase()
        if (protos.includes(`-${key}`)) return false
        return protos.includes('all') || protos.includes(key) || protos.includes(`+${key}`)
      })
      const h2 = (get(v.block, 'protocols')?.args ?? []).includes('h2') && l.modules.has('http2_module')
      return { chain: v.chain, protocols: list, h2 }
    }
  return ep
})

/** apachectl -S */
export function apacheDumpVhosts(sys: System): string {
  const l = load(sys)
  const byPort = new Map<string, VHost[]>()
  for (const v of l.vhosts) {
    const k = `${v.addr === '0.0.0.0' ? '*' : v.addr}:${v.port}`
    byPort.set(k, [...(byPort.get(k) ?? []), v])
  }
  let out = 'VirtualHost configuration:\n'
  for (const [k, list] of byPort) {
    out += `${k.padEnd(23)}is a NameVirtualHost\n`
    const first = list[0]
    out += `         default server ${first.names[0] ?? sys.hostname} (${first.file}:${first.line})\n`
    for (const v of list) {
      out += `         port ${v.port} namevhost ${v.names[0] ?? sys.hostname} (${v.file}:${v.line})\n`
      for (const a of v.names.slice(1)) out += `                 alias ${a}\n`
    }
  }
  const root = apacheRoot(sys)
  out += `ServerRoot: "${root}"\nMain DocumentRoot: "${get(l.tree, 'documentroot')?.args[0] ?? '/var/www/html'}"\nMain ErrorLog: "${sys.distro === 'rocky' ? '/etc/httpd/logs/error_log' : '/var/log/apache2/error.log'}"\nMutex default: dir="/run/${sys.distro === 'rocky' ? 'httpd' : 'lock/apache2'}/" mechanism=default \nPidFile: "/run/${sys.distro === 'rocky' ? 'httpd/httpd' : 'apache2/apache2'}.pid"\nDefine: DUMP_VHOSTS\nDefine: DUMP_RUN_CFG\nUser: name="${l.user}" id=${sys.users.get(l.user)?.uid ?? 48}\nGroup: name="${l.user}" id=${sys.users.get(l.user)?.gid ?? 48}\n`
  return out
}

export function apacheModules(sys: System): string[] {
  return [...parseApache(sys).modules]
}

export { appRespond, web }
