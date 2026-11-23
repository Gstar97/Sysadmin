/**
 * Logs de ejemplo para practicar LogQL: streams con etiquetas (como los que manda Alloy a Loki)
 * y líneas generadas a partir de plantillas, con atajos para los logs de SSH, el access log de
 * nginx y una aplicación que escribe JSON. Todo es reproducible (semilla fija).
 */
import { DEFAULT_NOW, parseDuration } from '../metrics/tsdb'

export type Labels = Record<string, string>

export interface LogEntry {
  /** Segundos Unix (con milisegundos). */
  t: number
  line: string
}

export interface LogStream {
  labels: Labels
  /** Ordenadas de la más vieja a la más nueva. */
  entries: LogEntry[]
}

export interface LogDb {
  streams: LogStream[]
  start: number
  end: number
}

type Values = Record<string, string[] | { min: number; max: number; decimales?: number }>

export interface LineTemplate {
  /** Texto con {campos}; {campo} sale de valores, o de los automáticos (pid, puerto, hora_syslog...). */
  plantilla: string
  /** Una línea cada tanto (2m, 30s), con algo de variación. */
  cada?: string
  /** O una cantidad promedio por minuto (al azar, como llegan los eventos reales). */
  por_minuto?: number
  desde?: string
  hasta?: string
  valores?: Values
}

export interface StreamSpec {
  etiquetas: Labels
  lineas?: LineTemplate[]
  /** Líneas puntuales: en un instante (relativo, como -1h12m) con un texto fijo. */
  fijas?: { en: string; linea: string }[]
}

export interface SshSpec {
  host: string
  /** auth.log (Ubuntu) o secure (Rocky). */
  distro?: 'ubuntu' | 'rocky'
  usuarios?: string[]
  /** Inicios de sesión legítimos por hora. */
  accesos_hora?: number
  /** Intentos fallidos de fondo por minuto (bots de internet). */
  fallidos_minuto?: number
  ataques?: { desde?: string; hasta?: string; ip: string; por_minuto: number; usuarios?: string[] }[]
}

export interface NginxSpec {
  host: string
  rps?: number
  errores?: number
  paths?: string[]
  eventos?: { desde?: string; hasta?: string; rps?: number; errores?: number; lento_ms?: number }[]
}

export interface AppSpec {
  host: string
  app?: string
  por_minuto?: number
  errores?: number
  eventos?: { desde?: string; hasta?: string; errores?: number; mensaje_error?: string; latencia_ms?: number }[]
}

export interface LogScenario {
  ahora?: string
  ventana?: string
  semilla?: number
  ssh?: SshSpec[]
  nginx?: NginxSpec[]
  app?: AppSpec[]
  streams?: StreamSpec[]
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function at(rel: string | undefined, now: number, fallback: number): number {
  if (rel === undefined) return fallback
  const neg = rel.trim().startsWith('-')
  const d = parseDuration(rel.trim().replace(/^[-+]/, ''))
  if (d === undefined) {
    const abs = Date.parse(rel)
    return Number.isNaN(abs) ? fallback : abs / 1000
  }
  return now + (neg ? -d : d)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number, w = 2) => String(n).padStart(w, '0')

export function syslogTime(t: number): string {
  const d = new Date(t * 1000)
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

export function nginxTime(t: number): string {
  const d = new Date(t * 1000)
  return `${pad(d.getUTCDate())}/${MONTHS[d.getUTCMonth()]}/${d.getUTCFullYear()}:${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`
}

/** Instantes de una plantilla: cada N segundos con variación, o al azar con una tasa promedio. */
function instants(tpl: { cada?: string; por_minuto?: number }, a: number, b: number, rand: () => number): number[] {
  const out: number[] = []
  if (tpl.cada) {
    const every = parseDuration(tpl.cada) ?? 60
    for (let t = a + rand() * every; t <= b; t += every * (0.8 + rand() * 0.4)) out.push(t)
    return out
  }
  const rate = (tpl.por_minuto ?? 1) / 60
  if (rate <= 0) return out
  for (let t = a - Math.log(1 - rand()) / rate; t <= b; t += -Math.log(1 - rand()) / rate) out.push(t)
  return out
}

function fill(tpl: string, values: Values, t: number, rand: () => number): string {
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => {
    const v = values[k]
    if (Array.isArray(v)) return v[Math.floor(rand() * v.length)]
    if (v) {
      const n = v.min + rand() * (v.max - v.min)
      return v.decimales ? n.toFixed(v.decimales) : String(Math.round(n))
    }
    if (k === 'pid') return String(1000 + Math.floor(rand() * 60000))
    if (k === 'puerto') return String(1024 + Math.floor(rand() * 64000))
    if (k === 'hora_syslog') return syslogTime(t)
    if (k === 'hora_nginx') return nginxTime(t)
    if (k === 'hora_iso') return new Date(t * 1000).toISOString()
    return m
  })
}

function push(map: Map<string, LogStream>, labels: Labels, e: LogEntry) {
  const k = JSON.stringify(Object.keys(labels).sort().map((x) => [x, labels[x]]))
  let s = map.get(k)
  if (!s) map.set(k, (s = { labels, entries: [] }))
  s.entries.push(e)
}

const BOT_USERS = ['root', 'admin', 'test', 'ubuntu', 'oracle', 'postgres', 'user', 'guest', 'deploy', 'git']
const BOT_IPS = ['203.0.113.17', '198.51.100.23', '192.0.2.144', '203.0.113.88', '198.51.100.201']

function buildSsh(s: SshSpec, now: number, start: number, map: Map<string, LogStream>, seed: number) {
  const rand = rng(hash(`ssh:${s.host}`) ^ seed)
  const distro = s.distro ?? 'ubuntu'
  const labels: Labels = { job: 'system', host: s.host, filename: distro === 'rocky' ? '/var/log/secure' : '/var/log/auth.log', service_name: 'sshd' }
  const users = s.usuarios ?? ['ana']
  const line = (t: number, msg: string) => push(map, labels, { t, line: `${syslogTime(t)} ${s.host} sshd[${1000 + Math.floor(rand() * 60000)}]: ${msg}` })
  for (const t of instants({ por_minuto: (s.accesos_hora ?? 4) / 60 }, start, now, rand)) {
    const u = users[Math.floor(rand() * users.length)]
    const port = 40000 + Math.floor(rand() * 20000)
    line(t, `Accepted publickey for ${u} from 192.168.10.5 port ${port} ssh2: ED25519 SHA256:q7Lw3n0mS1xVd8yGQk2xR6pHf0aZt4bE9cJ5uN1oPXs`)
    line(t + 0.02, `pam_unix(sshd:session): session opened for user ${u}(uid=1000) by ${u}(uid=0)`)
  }
  const fail = (t: number, ip: string, user: string) => {
    const port = 1024 + Math.floor(rand() * 64000)
    if (user === 'root' || users.includes(user)) line(t, `Failed password for ${user} from ${ip} port ${port} ssh2`)
    else {
      line(t, `Invalid user ${user} from ${ip} port ${port}`)
      line(t + 0.4, `Failed password for invalid user ${user} from ${ip} port ${port} ssh2`)
    }
  }
  for (const t of instants({ por_minuto: s.fallidos_minuto ?? 0.3 }, start, now, rand)) fail(t, BOT_IPS[Math.floor(rand() * BOT_IPS.length)], BOT_USERS[Math.floor(rand() * BOT_USERS.length)])
  for (const a of s.ataques ?? []) {
    const us = a.usuarios ?? BOT_USERS
    for (const t of instants({ por_minuto: a.por_minuto }, at(a.desde, now, start), at(a.hasta, now, now), rand)) fail(t, a.ip, us[Math.floor(rand() * us.length)])
  }
}

function buildNginx(n: NginxSpec, now: number, start: number, map: Map<string, LogStream>, seed: number) {
  const rand = rng(hash(`nginx:${n.host}`) ^ seed)
  const labels: Labels = { job: 'nginx', host: n.host, filename: '/var/log/nginx/access.log', service_name: 'nginx' }
  const paths = n.paths ?? ['/', '/api/productos', '/api/carrito', '/api/pedidos', '/static/app.js', '/favicon.ico']
  const clients = ['181.47.12.9', '190.210.33.120', '200.45.8.77', '186.22.140.3', '201.235.9.66', '45.170.22.81']
  const agents = ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148', 'curl/8.9.1']
  const evs = (n.eventos ?? []).map((e) => ({ ...e, a: at(e.desde, now, start), b: at(e.hasta, now, now) }))
  const param = (t: number, k: 'rps' | 'errores' | 'lento_ms', def: number) => {
    let v = n[k === 'lento_ms' ? 'rps' : k] as number | undefined
    if (k === 'lento_ms') v = undefined
    for (const e of evs) if (t >= e.a && t <= e.b && e[k] !== undefined) v = e[k]
    return v ?? def
  }
  // Tasa variable: se generan candidatos con la tasa máxima y se descartan según la del momento.
  const maxRps = Math.max(n.rps ?? 0.5, ...evs.map((e) => e.rps ?? 0))
  for (const t of instants({ por_minuto: maxRps * 60 }, start, now, rand)) {
    if (rand() > param(t, 'rps', 0.5) / maxRps) continue
    const path = paths[Math.floor(rand() * paths.length)]
    const err = param(t, 'errores', 0.01)
    const r = rand()
    const status = r < err ? (rand() < 0.7 ? 500 : 502) : path === '/favicon.ico' && rand() < 0.5 ? 404 : r < err + 0.04 ? 304 : 200
    const size = status >= 500 ? 157 + Math.floor(rand() * 20) : status === 304 ? 0 : 200 + Math.floor(rand() * 20000)
    const rt = (param(t, 'lento_ms', 40) * (0.3 + rand() * 1.4)) / 1000
    const ip = clients[Math.floor(rand() * clients.length)]
    push(map, labels, { t, line: `${ip} - - [${nginxTime(t)}] "GET ${path} HTTP/1.1" ${status} ${size} "-" "${agents[Math.floor(rand() * agents.length)]}" rt=${rt.toFixed(3)}` })
  }
}

function buildApp(a: AppSpec, now: number, start: number, map: Map<string, LogStream>, seed: number) {
  const rand = rng(hash(`app:${a.host}:${a.app}`) ^ seed)
  const app = a.app ?? 'tienda-api'
  const labels: Labels = { job: app, host: a.host, service_name: app }
  const evs = (a.eventos ?? []).map((e) => ({ ...e, a: at(e.desde, now, start), b: at(e.hasta, now, now) }))
  const ev = (t: number) => evs.filter((e) => t >= e.a && t <= e.b)
  const paths = ['/api/productos', '/api/carrito', '/api/pedidos', '/api/usuarios/login']
  for (const t of instants({ por_minuto: a.por_minuto ?? 20 }, start, now, rand)) {
    let errRate = a.errores ?? 0.01
    let lat = 60
    let msgErr = 'database query failed: connection refused'
    for (const e of ev(t)) {
      if (e.errores !== undefined) errRate = e.errores
      if (e.latencia_ms !== undefined) lat = e.latencia_ms
      if (e.mensaje_error) msgErr = e.mensaje_error
    }
    const path = paths[Math.floor(rand() * paths.length)]
    const isErr = rand() < errRate
    const dur = Math.round(lat * (0.4 + rand() * 1.3))
    const obj: Record<string, unknown> = isErr
      ? { ts: new Date(t * 1000).toISOString(), level: 'error', msg: msgErr, method: 'GET', path, status: 500, duration_ms: dur, request_id: `req-${Math.floor(rand() * 1e8).toString(16)}` }
      : { ts: new Date(t * 1000).toISOString(), level: rand() < 0.05 ? 'warn' : 'info', msg: 'request completed', method: path.endsWith('login') ? 'POST' : 'GET', path, status: 200, duration_ms: dur, request_id: `req-${Math.floor(rand() * 1e8).toString(16)}` }
    if (obj.level === 'warn') obj.msg = 'slow request'
    push(map, labels, { t, line: JSON.stringify(obj) })
  }
}

function buildStream(s: StreamSpec, now: number, start: number, map: Map<string, LogStream>, seed: number) {
  const rand = rng(hash(JSON.stringify(s.etiquetas)) ^ seed)
  for (const tpl of s.lineas ?? []) {
    for (const t of instants(tpl, at(tpl.desde, now, start), at(tpl.hasta, now, now), rand)) push(map, s.etiquetas, { t, line: fill(tpl.plantilla, tpl.valores ?? {}, t, rand) })
  }
  for (const f of s.fijas ?? []) {
    const t = at(f.en, now, now)
    push(map, s.etiquetas, { t, line: fill(f.linea, {}, t, rand) })
  }
}

export function buildLogDb(sc: LogScenario = {}): LogDb {
  const now = Date.parse(sc.ahora ?? DEFAULT_NOW) / 1000
  const span = parseDuration(sc.ventana ?? '6h') ?? 21600
  const start = now - span
  const seed = sc.semilla ?? 1
  const map = new Map<string, LogStream>()
  for (const s of sc.ssh ?? []) buildSsh(s, now, start, map, seed)
  for (const n of sc.nginx ?? []) buildNginx(n, now, start, map, seed)
  for (const a of sc.app ?? []) buildApp(a, now, start, map, seed)
  for (const s of sc.streams ?? []) buildStream(s, now, start, map, seed)
  const streams = [...map.values()]
  for (const s of streams) s.entries.sort((a, b) => a.t - b.t)
  return { streams: streams.filter((s) => s.entries.length), start, end: now }
}

/** Etiquetas y valores (para el explorador de la consola). */
export function labelValues(db: LogDb): string[] {
  const out = new Set<string>()
  for (const s of db.streams) for (const [k, v] of Object.entries(s.labels)) out.add(`${k}="${v}"`)
  return [...out].sort()
}
