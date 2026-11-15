/**
 * HTTP en el laboratorio simulado: solicitudes y respuestas, las aplicaciones que corren detrás
 * de un proxy (servicios de systemd que escuchan en un puerto o en un socket), y el lado del
 * cliente que usan curl, wget, certbot y las verificaciones (resolver el nombre, llegar por la
 * red, pasar el firewall, negociar TLS y verificar la cadena del certificado).
 */
import type { System } from './system'
import { hostByIp, inbound, learnNeighbor, routeTo, sourceIp } from './hosts'
import { reaches } from './commands/net'
import { LE_R11, ROOTS, issue, newKey, trustedRoots, verifyChain, type CertData, type VerifyResult } from './tls'
import { ROOT_CRED } from './vfs'

export interface HttpRequest {
  method: string
  scheme: 'http' | 'https'
  /** Nombre que escribió el cliente (va en Host y en SNI). */
  host: string
  port: number
  /** Ruta con la consulta: /buscar?q=1 */
  path: string
  /** Encabezados con el nombre en minúsculas. */
  headers: Record<string, string>
  body: string
  clientIp: string
  /** IP local del servidor por la que entró la conexión. */
  localIp: string
}

export interface HttpResponse {
  status: number
  headers: [string, string][]
  body: string
  /** HTTP/2 negociado por ALPN. */
  h2?: boolean
}

export interface TlsHello {
  chain: CertData[]
  protocols: string[]
  h2: boolean
}

/** Algo que atiende conexiones en un puerto: nginx, Apache o una aplicación. */
export interface Endpoint {
  /** undefined: no hay TLS en ese puerto. Con error: el servidor corta el saludo TLS. */
  tls?: (sni: string) => TlsHello | { error: string }
  handle: (req: HttpRequest) => HttpResponse
  /** Nombre del programa (para ss y para los mensajes). */
  name: string
}

export const REASON: Record<number, string> = {
  100: 'Continue',
  101: 'Switching Protocols',
  103: 'Early Hints',
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  206: 'Partial Content',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  413: 'Request Entity Too Large',
  414: 'Request-URI Too Large',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Temporarily Unavailable',
  504: 'Gateway Time-out',
}

export function header(res: HttpResponse, name: string): string | undefined {
  return res.headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1]
}

export function httpDate(ms = Date.now()): string {
  return new Date(ms).toUTCString()
}

// ---------------------------------------------------------------------------------------
// Estado web de cada servidor
// ---------------------------------------------------------------------------------------

export interface AppSpec {
  escucha?: string
  cuerpo?: string
  eco_encabezados: boolean
  websocket: boolean
  demora_s: number
  codigo: number
  tipo_contenido: string
}

export interface WebRuntime {
  apps: Record<string, AppSpec>
  /** DNS público (lo que ve Let's Encrypt): nombre → IP pública. */
  publicDns: Record<string, string>
  publicIp?: string
  /** Puertos que el router de borde deja pasar desde internet hasta este servidor. */
  inboundFromInternet: number[]
  /** Turno de cada upstream para el round robin. */
  rr: Map<string, number>
  /** Servidores de un upstream marcados como caídos (max_fails) hasta tal hora. */
  failedUntil: Map<string, number>
  requestSeq: number
}

const RUNTIME = new WeakMap<System, WebRuntime>()

export function web(sys: System): WebRuntime {
  let r = RUNTIME.get(sys)
  if (!r) {
    r = { apps: {}, publicDns: {}, inboundFromInternet: [], rr: new Map(), failedUntil: new Map(), requestSeq: 0 }
    RUNTIME.set(sys, r)
  }
  return r
}

/** Dónde escucha una aplicación: lo que dice su unidad (--bind, -b, --port, PORT=) o el ejercicio. */
export function appListen(sys: System, name: string): { ip: string; port?: number; socket?: string } | undefined {
  const spec = web(sys).apps[name]
  if (!spec) return undefined
  const svc = sys.services.get(name)
  let text = ''
  if (svc?.unit?.path) {
    try {
      text = sys.vfs.readFile(svc.unit.path, ROOT_CRED)
    } catch {
      text = ''
    }
  }
  const exec = /^\s*ExecStart\s*=\s*(.*)$/m.exec(text)?.[1] ?? ''
  const bind = /(?:--bind|-b)[ =]+(\S+)/.exec(exec)?.[1]
  const portOpt = /--port[ =]+(\d+)/.exec(exec)?.[1]
  const envPort = /^\s*Environment\s*=\s*"?PORT=(\d+)/m.exec(text)?.[1]
  const where = bind ?? (portOpt ? `127.0.0.1:${portOpt}` : envPort ? `0.0.0.0:${envPort}` : spec.escucha)
  if (!where) return undefined
  if (where.startsWith('unix:')) return { ip: '', socket: where.slice(5) }
  const m = /^(?:(\[?[\d.:a-f]*\]?|localhost|\*):)?(\d+)$/.exec(where)
  if (!m) return undefined
  const ip = !m[1] || m[1] === '*' ? '0.0.0.0' : m[1] === 'localhost' ? '127.0.0.1' : m[1]
  return { ip, port: Number(m[2]) }
}

/** Respuesta de una aplicación (el programa de la empresa detrás del proxy). */
export function appRespond(sys: System, name: string, req: HttpRequest): HttpResponse {
  const spec = web(sys).apps[name]!
  const wantsWs = (req.headers['upgrade'] ?? '').toLowerCase() === 'websocket'
  if (spec.websocket && wantsWs) {
    if (!/upgrade/i.test(req.headers['connection'] ?? '')) return { status: 400, headers: [['Content-Type', 'text/plain']], body: 'Can "Upgrade" only to "WebSocket".\n' }
    return { status: 101, headers: [['Upgrade', 'websocket'], ['Connection', 'Upgrade'], ['Sec-WebSocket-Accept', 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=']], body: '' }
  }
  if (spec.websocket && req.path.startsWith('/ws')) return { status: 400, headers: [['Content-Type', 'text/plain']], body: 'Can "Upgrade" only to "WebSocket".\n' }
  let body = spec.cuerpo ?? `<h1>${name}</h1>\n`
  if (!body.endsWith('\n')) body += '\n'
  if (spec.eco_encabezados) {
    const keys = ['host', 'x-real-ip', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'connection', 'upgrade']
    body += `Método: ${req.method}\nRuta pedida: ${req.path}\nIP que ve la aplicación: ${req.clientIp}\n` + keys.map((k) => `${k}: ${req.headers[k] ?? '(sin enviar)'}`).join('\n') + '\n'
    if (req.body) body += `Cuerpo recibido: ${req.body}\n`
    for (const [k, v] of Object.entries(req.headers)) if (k.startsWith('x-') && !keys.includes(k)) body += `${k}: ${v}\n`
  }
  const server = name.includes('node') ? 'Node.js' : 'gunicorn'
  return { status: spec.codigo, headers: [['Server', server], ['Content-Type', spec.tipo_contenido]], body }
}

/** Aplicaciones del ejercicio que están corriendo y escuchan en ese puerto. */
function appOnPort(sys: System, port: number, localIp: string): string | undefined {
  for (const name of Object.keys(web(sys).apps)) {
    if (!sys.services.get(name)?.active) continue
    const l = appListen(sys, name)
    if (!l?.port || l.port !== port) continue
    if (l.ip === '0.0.0.0' || l.ip === '::' || l.ip === localIp || (l.ip === '127.0.0.1' && localIp.startsWith('127.'))) return name
  }
  return undefined
}

export function appOnSocket(sys: System, path: string): string | undefined {
  for (const name of Object.keys(web(sys).apps)) {
    if (!sys.services.get(name)?.active) continue
    if (appListen(sys, name)?.socket === path) return name
  }
  return undefined
}

/** Los motores de servidor web se registran acá (nginx y Apache) para no crear dependencias circulares. */
export const SERVERS: ((sys: System, port: number, localIp: string) => Endpoint | undefined)[] = []

export function endpointAt(sys: System, port: number, localIp: string): Endpoint | undefined {
  for (const f of SERVERS) {
    const e = f(sys, port, localIp)
    if (e) return e
  }
  const app = appOnPort(sys, port, localIp)
  if (app) return { name: app, handle: (req) => appRespond(sys, app, req) }
  return undefined
}

/** Si algo escucha en ese puerto (para ss y para el arranque de otros servicios). */
export function listening(sys: System, port: number): boolean {
  return !!endpointAt(sys, port, '0.0.0.0') || !!endpointAt(sys, port, '127.0.0.1')
}

// ---------------------------------------------------------------------------------------
// Cliente
// ---------------------------------------------------------------------------------------

export interface FetchOpts {
  method?: string
  headers?: Record<string, string>
  body?: string
  /** --resolve: nombre:puerto → IP */
  resolve?: Record<string, string>
  insecure?: boolean
  caFile?: string
  /** Versiones TLS que acepta el cliente. */
  tlsMin?: string
  tlsMax?: string
  /** Pedir HTTP/1.1 aunque el servidor ofrezca HTTP/2. */
  http1?: boolean
  userAgent?: string
  /** Desde internet (Let's Encrypt validando, o el celular de alguien). */
  fromInternet?: boolean
}

export interface TlsInfo {
  chain: CertData[]
  version: string
  cipher: string
  verify: VerifyResult
  h2: boolean
}

export type FetchResult =
  | { ok: true; res: HttpResponse; ip: string; port: number; tls?: TlsInfo; rtt: number; req: HttpRequest }
  | { ok: false; code: number; message: string; ip?: string; port?: number; tls?: TlsInfo; stage: 'url' | 'resolve' | 'connect' | 'tls' | 'verify' | 'reply' }

export function parseUrl(url: string): { scheme: 'http' | 'https'; host: string; port: number; path: string } | undefined {
  const m = /^(?:(https?):\/\/)?(\[[^\]]+\]|[^/:?#]+)(?::(\d+))?([/?][^#]*)?$/i.exec(url.trim())
  if (!m) return undefined
  const scheme = (m[1]?.toLowerCase() ?? 'http') as 'http' | 'https'
  const path = m[4] ? (m[4].startsWith('?') ? `/${m[4]}` : m[4]) : '/'
  return { scheme, host: m[2].toLowerCase(), port: m[3] ? Number(m[3]) : scheme === 'https' ? 443 : 80, path }
}

const TLS_ORDER = ['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3']

/** Certificados de los sitios de internet (genéricos y válidos). */
const internetCerts = new Map<string, CertData[]>()
function internetChain(host: string): CertData[] {
  let chain = internetCerts.get(host)
  if (!chain) {
    const key = newKey('EC', 256, `internet:${host}`)
    const leaf = issue({ subject: { CN: host }, san: [`DNS:${host}`, `DNS:www.${host.replace(/^www\./, '')}`], days: 90, startDays: -20, key, issuer: { cert: LE_R11, keyId: LE_R11.keyId } })
    chain = [leaf, LE_R11]
    internetCerts.set(host, chain)
  }
  return chain
}

export function openSslVersion(sys: System): string {
  return sys.distro === 'rocky' ? 'OpenSSL/3.5.1' : 'OpenSSL/3.5.5'
}

/** Hace una solicitud HTTP desde un servidor del laboratorio, como lo haría curl. */
export type Reach = { target: System; localIp: string; clientIp: string; rtt: number } | { error: 'timeout' | 'noroute' | 'outside' }

/**
 * Cómo llega una conexión TCP desde un servidor a una IP y puerto: qué equipo la recibe, con qué
 * IP de origen, o por qué no llega (firewall que descarta o rechaza, sin ruta). "outside" es una
 * IP alcanzable que no es de ningún equipo del laboratorio (internet u otra red).
 */
export function reach(from: System, ip: string, port: number, fromInternet = false): Reach {
  if (fromInternet) {
    const all = [from, ...from.lab]
    const target = all.find((s) => web(s).publicIp === ip)
    if (!target || !web(target).inboundFromInternet.includes(port)) return { error: 'timeout' }
    const clientIp = '23.178.112.104'
    if (inbound(target, port, 'tcp', clientIp) !== 'ok') return { error: 'timeout' }
    return { target, localIp: target.ownIps().find((x) => !x.startsWith('127.')) ?? '127.0.0.1', clientIp, rtt: 0.04 }
  }
  if (ip.startsWith('127.') || from.ownIps().includes(ip)) return { target: from, localIp: ip, clientIp: ip.startsWith('127.') ? '127.0.0.1' : ip, rtt: 0.00005 }
  learnNeighbor(from, ip)
  const remote = hostByIp(from, ip)
  if (remote && remote !== from) {
    if (!routeTo(from, ip) && !reaches(from, ip)) return { error: 'timeout' }
    const clientIp = sourceIp(from, ip)
    const fw = inbound(remote, port, 'tcp', clientIp)
    if (fw === 'reject') return { error: 'noroute' }
    if (fw === 'drop') return { error: 'timeout' }
    return { target: remote, localIp: ip, clientIp, rtt: 0.0006 }
  }
  if (reaches(from, ip)) return { error: 'outside' }
  return { error: 'timeout' }
}

export function fetchHttp(from: System, url: string, o: FetchOpts = {}): FetchResult {
  const u = parseUrl(url)
  if (!u) return { ok: false, code: 3, message: 'URL rejected: Malformed input to a URL function', stage: 'url' }
  const forced = o.resolve?.[`${u.host}:${u.port}`]
  let ip: string | undefined
  if (forced) ip = forced
  else if (o.fromInternet) ip = web(from).publicDns[u.host] ?? (/^\d+\.\d+\.\d+\.\d+$/.test(u.host) ? u.host : undefined)
  else ip = /^\d+\.\d+\.\d+\.\d+$/.test(u.host) ? u.host : from.resolveHost(u.host)
  if (!ip) return { ok: false, code: 6, message: `Could not resolve host: ${u.host}`, stage: 'resolve' }

  const timeout = () => ({ ok: false as const, code: 28, message: `Failed to connect to ${u.host} port ${u.port} after 3002 ms: Timeout was reached`, ip, port: u.port, stage: 'connect' as const })
  const r = reach(from, ip, u.port, !!o.fromInternet)
  if ('error' in r) {
    if (r.error === 'timeout') return timeout()
    if (r.error === 'noroute') return { ok: false, code: 7, message: `Failed to connect to ${u.host} port ${u.port} after 1 ms: No route to host`, ip, port: u.port, stage: 'connect' }
    // Un sitio de internet o de otra red: responde algo genérico.
    const body = from.sites[u.host] ?? from.sites[ip] ?? `<!doctype html>\n<html><head><title>${u.host}</title></head><body><h1>${u.host}</h1></body></html>\n`
    const req: HttpRequest = { method: o.method ?? 'GET', scheme: u.scheme, host: u.host, port: u.port, path: u.path, headers: {}, body: '', clientIp: sourceIp(from, ip), localIp: ip }
    let tls: TlsInfo | undefined
    if (u.scheme === 'https') {
      const chain = internetChain(u.host)
      tls = { chain, version: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384', verify: verifyChain(chain, trustedRoots(from, o.caFile), u.host), h2: false }
      if (!o.insecure && tls.verify.code !== 'ok') return verifyFail(u.host, tls, ip, u.port)
    }
    return { ok: true, res: { status: 200, headers: [['Server', 'nginx'], ['Content-Type', 'text/html; charset=utf-8']], body, h2: tls?.h2 }, ip, port: u.port, tls, rtt: 0.024, req }
  }
  const { target, localIp, clientIp, rtt } = r
  const refused = () => ({ ok: false as const, code: 7, message: `Failed to connect to ${u.host} port ${u.port} after 1 ms: Couldn't connect to server`, ip, port: u.port, stage: 'connect' as const })

  const ep = endpointAt(target, u.port, localIp)
  if (!ep) return refused()

  const headers: Record<string, string> = { host: u.port === (u.scheme === 'https' ? 443 : 80) ? u.host : `${u.host}:${u.port}`, 'user-agent': o.userAgent ?? 'curl/8.12.1', accept: '*/*' }
  for (const [k, v] of Object.entries(o.headers ?? {})) headers[k.toLowerCase()] = v
  if (o.body !== undefined) {
    headers['content-length'] = String(o.body.length)
    headers['content-type'] ??= 'application/x-www-form-urlencoded'
  }
  const req: HttpRequest = { method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'), scheme: u.scheme, host: u.host, port: u.port, path: u.path, headers, body: o.body ?? '', clientIp, localIp }

  let tls: TlsInfo | undefined
  if (u.scheme === 'https') {
    if (!ep.tls) return { ok: false, code: 35, message: `${openSslVersion(from)}: error:0A00010B:SSL routines::wrong version number`, ip, port: u.port, stage: 'tls' }
    const hello = ep.tls(u.host)
    if ('error' in hello) return { ok: false, code: 35, message: `${openSslVersion(from)}: error:0A000438:SSL routines::tlsv1 alert internal error`, ip, port: u.port, stage: 'tls' }
    const min = TLS_ORDER.indexOf(o.tlsMin ?? 'TLSv1.2')
    const max = TLS_ORDER.indexOf(o.tlsMax ?? 'TLSv1.3')
    const agreed = [...hello.protocols].filter((p) => {
      const i = TLS_ORDER.indexOf(p)
      return i >= min && i <= max
    }).sort((a, b) => TLS_ORDER.indexOf(b) - TLS_ORDER.indexOf(a))[0]
    if (!agreed) return { ok: false, code: 35, message: `${openSslVersion(from)}: error:0A00042E:SSL routines::tlsv1 alert protocol version`, ip, port: u.port, stage: 'tls' }
    tls = {
      chain: hello.chain,
      version: agreed,
      cipher: agreed === 'TLSv1.3' ? 'TLS_AES_256_GCM_SHA384' : 'ECDHE-RSA-AES256-GCM-SHA384',
      verify: verifyChain(hello.chain, trustedRoots(from, o.caFile), u.host),
      h2: hello.h2 && !o.http1,
    }
    if (!o.insecure && tls.verify.code !== 'ok') return verifyFail(u.host, tls, ip, u.port)
  }
  const res = ep.handle(req)
  if (tls?.h2) res.h2 = true
  return { ok: true, res, ip, port: u.port, tls, rtt, req }
}

function verifyFail(host: string, tls: TlsInfo, ip: string, port: number): FetchResult {
  const msg: Record<string, string> = {
    expired: 'SSL certificate problem: certificate has expired',
    not_yet: 'SSL certificate problem: certificate is not yet valid',
    self_signed: 'SSL certificate problem: self-signed certificate',
    self_signed_chain: 'SSL certificate problem: self-signed certificate in certificate chain',
    issuer: 'SSL certificate problem: unable to get local issuer certificate',
    hostname: `SSL: no alternative certificate subject name matches target host name '${host}'`,
  }
  return { ok: false, code: 60, message: msg[tls.verify.code], ip, port, tls, stage: 'verify' }
}

/** Para las verificaciones de los ejercicios: la misma solicitud, sin mostrar nada. */
export function probe(from: System, url: string, o: FetchOpts = {}): FetchResult {
  return fetchHttp(from, url, o)
}

/** Certificados de los sitios públicos conocidos (para s_client contra internet). */
export function publicChain(host: string): CertData[] {
  return internetChain(host)
}

export { ROOTS }
