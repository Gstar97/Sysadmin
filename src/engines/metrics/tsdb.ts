/**
 * Series de tiempo sintéticas y reproducibles para practicar PromQL (y para el Prometheus del
 * simulador). Un escenario describe métricas con generadores simples (constante, lineal, onda,
 * contadores con una tasa, eventos, reinicios y huecos) y atajos para lo que exporta un
 * node_exporter o una aplicación web instrumentada.
 */

export type Labels = Record<string, string>

export interface Sample {
  t: number
  v: number
}

export interface Series {
  labels: Labels
  samples: Sample[]
}

export interface Tsdb {
  series: Series[]
  /** Segundos Unix del primer y último instante con datos. */
  start: number
  end: number
  /** Intervalo de muestreo (scrape_interval), en segundos. */
  step: number
}

// ---------------------------------------------------------------------------------------
// Duraciones
// ---------------------------------------------------------------------------------------

const UNITS: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 }

/** "5m", "1h30m", "2d", "500ms" → segundos. Devuelve undefined si no es una duración. */
export function parseDuration(text: string): number | undefined {
  const s = text.trim()
  if (!/^(\d+(ms|s|m|h|d|w|y))+$/.test(s)) return undefined
  let total = 0
  for (const m of s.matchAll(/(\d+)(ms|s|m|h|d|w|y)/g)) total += Number(m[1]) * UNITS[m[2]]
  return total
}

/** Un instante relativo a "ahora" (-30m, -2h, 0) o absoluto en segundos. */
function at(rel: string | number | undefined, now: number, fallback: number): number {
  if (rel === undefined) return fallback
  if (typeof rel === 'number') return now + rel
  const neg = rel.trim().startsWith('-')
  const d = parseDuration(rel.trim().replace(/^[-+]/, ''))
  if (d === undefined) {
    const abs = Date.parse(rel)
    return Number.isNaN(abs) ? fallback : abs / 1000
  }
  return now + (neg ? -d : d)
}

export function formatDuration(sec: number): string {
  if (sec === 0) return '0s'
  let rest = Math.round(sec * 1000)
  let out = ''
  for (const [u, f] of [['y', 31536000000], ['w', 604800000], ['d', 86400000], ['h', 3600000], ['m', 60000], ['s', 1000], ['ms', 1]] as const) {
    const n = Math.floor(rest / f)
    if (n) {
      out += `${n}${u}`
      rest -= n * f
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------
// Escenario
// ---------------------------------------------------------------------------------------

/** Forma de una señal en el tiempo. */
export type Shape =
  | number
  | { constante: number }
  | { lineal: { desde: number; hasta: number } }
  | { onda: { media: number; amplitud: number; periodo?: string; fase?: number } }

export interface MetricEvent {
  desde?: string
  hasta?: string
  /** Reemplaza el valor (gauge) o la tasa (contador). */
  valor?: number
  /** Multiplica el valor o la tasa. */
  multiplicar?: number
  /** Suma al valor o a la tasa. */
  sumar?: number
  /** Solo para las series con estas etiquetas. */
  si?: Labels
}

export interface SeriesSpec {
  nombre: string
  /** Etiquetas; un valor que es lista genera una serie por cada combinación. */
  etiquetas?: Record<string, string | string[]>
  tipo?: 'gauge' | 'contador'
  /** Gauge: la señal. Contador: la tasa por segundo. */
  valor?: Shape
  /** Contador: valor al principio de la ventana. */
  inicial?: number
  /** Ruido relativo (0.05 = ±5 %), reproducible. */
  ruido?: number
  eventos?: MetricEvent[]
  /** Contadores: instantes en que el proceso se reinicia y el contador vuelve a cero. */
  reinicios?: string[]
  /** Períodos sin datos (el equipo no respondía). */
  sin_datos?: { desde?: string; hasta?: string; si?: Labels }[]
  /** Redondear a entero (cantidad de procesos, conexiones...). */
  entero?: boolean
}

export interface NodeSpec {
  /** host:puerto del node_exporter, por ejemplo web01:9100. */
  instancia: string
  job?: string
  cpus?: number
  memoria_gb?: number
  /** Uso de CPU entre 0 y 1. */
  carga?: number
  /** Memoria usada (sin caché) entre 0 y 1. */
  memoria_usada?: number
  disco_gb?: number
  /** Disco usado al principio de la ventana, entre 0 y 1. */
  disco_usado?: number
  /** Crecimiento del disco en GB por hora (positivo llena el disco). */
  disco_crece_gb_hora?: number
  red_mbps?: number
  /** Eventos: carga, memoria_usada, disco_crece_gb_hora o caido entre desde y hasta. */
  eventos?: { desde?: string; hasta?: string; carga?: number; memoria_usada?: number; disco_crece_gb_hora?: number; caido?: boolean }[]
  /** Etiquetas extra para todas sus series (env, rol...). */
  etiquetas?: Labels
}

export interface HttpSpec {
  instancia: string
  job?: string
  /** Pedidos por segundo. */
  rps?: number
  /** Fracción de respuestas 5xx. */
  errores?: number
  /** Latencia típica (mediana) en milisegundos. */
  latencia_ms?: number
  handlers?: string[]
  eventos?: { desde?: string; hasta?: string; rps?: number; errores?: number; latencia_ms?: number; caido?: boolean }[]
}

export interface Scenario {
  /** Instante "ahora" (ISO). */
  ahora?: string
  /** Cuánto hacia atrás hay datos (6h por defecto). */
  ventana?: string
  /** Intervalo de muestreo (15s por defecto). */
  paso?: string
  semilla?: number
  nodos?: NodeSpec[]
  http?: HttpSpec[]
  series?: SeriesSpec[]
}

export const DEFAULT_NOW = '2026-11-23T14:00:00Z'

// ---------------------------------------------------------------------------------------
// Generadores
// ---------------------------------------------------------------------------------------

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

function shapeAt(shape: Shape | undefined, t: number, start: number, end: number): number {
  if (shape === undefined) return 0
  if (typeof shape === 'number') return shape
  if ('constante' in shape) return shape.constante
  if ('lineal' in shape) return shape.lineal.desde + ((shape.lineal.hasta - shape.lineal.desde) * (t - start)) / Math.max(1, end - start)
  const p = parseDuration(shape.onda.periodo ?? '24h') ?? 86400
  return shape.onda.media + shape.onda.amplitud * Math.sin((2 * Math.PI * t) / p + (shape.onda.fase ?? 0))
}

function matches(labels: Labels, si?: Labels): boolean {
  return !si || Object.entries(si).every(([k, v]) => labels[k] === v)
}

function expand(etiquetas: Record<string, string | string[]> | undefined): Labels[] {
  let out: Labels[] = [{}]
  for (const [k, v] of Object.entries(etiquetas ?? {})) {
    const vals = Array.isArray(v) ? v : [v]
    out = out.flatMap((l) => vals.map((x) => ({ ...l, [k]: String(x) })))
  }
  return out
}

interface Ctx {
  now: number
  start: number
  end: number
  step: number
  seed: number
}

function times(c: Ctx): number[] {
  const out: number[] = []
  // Muestras alineadas al paso, como los scrapes de Prometheus. Empiezan 15 minutos antes de la
  // ventana, como un Prometheus que ya venía corriendo: así rate() tiene datos completos al principio.
  for (let t = Math.ceil((c.start - PREROLL) / c.step) * c.step; t <= c.end; t += c.step) out.push(t)
  return out
}

/** Genera las series de un SeriesSpec. */
function buildSpec(spec: SeriesSpec, c: Ctx): Series[] {
  const out: Series[] = []
  for (const extra of expand(spec.etiquetas)) {
    const labels: Labels = { __name__: spec.nombre, ...extra }
    const key = JSON.stringify(labels)
    const rand = rng(hash(key) ^ c.seed)
    const counter = spec.tipo === 'contador'
    const resets = (spec.reinicios ?? []).map((r) => at(r, c.now, c.start)).sort((a, b) => a - b)
    const gaps = (spec.sin_datos ?? []).filter((g) => matches(labels, g.si)).map((g) => [at(g.desde, c.now, c.start), at(g.hasta, c.now, c.end)] as const)
    const evs = (spec.eventos ?? []).filter((e) => matches(labels, e.si)).map((e) => ({ ...e, a: at(e.desde, c.now, c.start), b: at(e.hasta, c.now, c.end) }))
    let acc = spec.inicial ?? 0
    let prevT: number | undefined
    let ri = 0
    const samples: Sample[] = []
    for (const t of times(c)) {
      let v = shapeAt(spec.valor, t, c.start, c.end)
      for (const e of evs) {
        if (t < e.a || t > e.b) continue
        if (e.valor !== undefined) v = e.valor
        if (e.multiplicar !== undefined) v *= e.multiplicar
        if (e.sumar !== undefined) v += e.sumar
      }
      if (spec.ruido) v *= 1 + (rand() * 2 - 1) * spec.ruido
      if (counter) {
        if (prevT !== undefined) acc += Math.max(0, v) * (t - prevT)
        while (ri < resets.length && resets[ri] <= t) {
          if (prevT !== undefined && resets[ri] > prevT) acc = Math.max(0, v) * (t - resets[ri])
          ri++
        }
        prevT = t
        v = acc
      }
      if (gaps.some(([a, b]) => t >= a && t <= b)) continue
      samples.push({ t, v: spec.entero ? Math.round(v) : v })
    }
    out.push({ labels, samples })
  }
  return out
}

const GB = 1024 ** 3
const PREROLL = 900

/** Las series que expone un node_exporter (las más usadas). */
function buildNode(n: NodeSpec, c: Ctx): Series[] {
  const job = n.job ?? 'node'
  const base: Labels = { instance: n.instancia, job, ...(n.etiquetas ?? {}) }
  const cpus = n.cpus ?? 2
  const mem = (n.memoria_gb ?? 4) * GB
  const disk = (n.disco_gb ?? 50) * GB
  const rand = rng(hash(n.instancia) ^ c.seed)
  const ev = (t: number) => (n.eventos ?? []).filter((e) => t >= at(e.desde, c.now, c.start) && t <= at(e.hasta, c.now, c.end))
  const down = (t: number) => ev(t).some((e) => e.caido)
  const param = <K extends 'carga' | 'memoria_usada' | 'disco_crece_gb_hora'>(t: number, k: K, def: number) => {
    let v = n[k] ?? def
    for (const e of ev(t)) if (e[k] !== undefined) v = e[k]!
    return v
  }
  const ts = times(c)
  const series = new Map<string, Series>()
  const push = (name: string, extra: Labels, t: number, v: number) => {
    const labels = { __name__: name, ...base, ...extra }
    const key = JSON.stringify(labels)
    let s = series.get(key)
    if (!s) series.set(key, (s = { labels, samples: [] }))
    s.samples.push({ t, v })
  }
  const up: Series = { labels: { __name__: 'up', ...base }, samples: [] }
  const cpuAcc: Record<string, number> = {}
  let rx = 0
  let tx = 0
  let used = disk * (n.disco_usado ?? 0.4)
  let prev: number | undefined
  const boot = c.start - 86400 * 12 - (hash(n.instancia) % 86400)
  for (const t of ts) {
    const dt = prev === undefined ? 0 : t - prev
    prev = t
    const load = Math.min(1, Math.max(0, param(t, 'carga', 0.15) * (1 + (rand() * 2 - 1) * 0.15)))
    const shares: Record<string, number> = { user: load * 0.65, system: load * 0.25, iowait: load * 0.06, steal: 0.002, idle: Math.max(0, 1 - load * 0.96 - 0.002) }
    for (let i = 0; i < cpus; i++) for (const [mode, f] of Object.entries(shares)) cpuAcc[`${i}/${mode}`] = (cpuAcc[`${i}/${mode}`] ?? (mode === 'idle' ? 900000 : 20000) + i * 1000) + f * dt * (0.95 + rand() * 0.1)
    used = Math.min(disk * 0.999, Math.max(0, used + (param(t, 'disco_crece_gb_hora', 0) * GB * dt) / 3600))
    const mbps = (n.red_mbps ?? 2) * (0.7 + rand() * 0.6)
    rx += ((mbps * 1e6) / 8) * dt
    tx += ((mbps * 0.4 * 1e6) / 8) * dt
    if (down(t)) {
      up.samples.push({ t, v: 0 })
      continue
    }
    up.samples.push({ t, v: 1 })
    for (let i = 0; i < cpus; i++) for (const mode of Object.keys(shares)) push('node_cpu_seconds_total', { cpu: String(i), mode }, t, cpuAcc[`${i}/${mode}`])
    push('node_load1', {}, t, load * cpus * (0.9 + rand() * 0.25))
    push('node_load5', {}, t, load * cpus)
    push('node_load15', {}, t, load * cpus * 0.97)
    const memUsed = Math.min(0.99, param(t, 'memoria_usada', 0.45) * (0.98 + rand() * 0.04))
    push('node_memory_MemTotal_bytes', {}, t, mem)
    push('node_memory_MemAvailable_bytes', {}, t, Math.round(mem * (1 - memUsed)))
    push('node_memory_MemFree_bytes', {}, t, Math.round(mem * (1 - memUsed) * 0.3))
    const fs: Labels = { device: '/dev/sda2', fstype: 'xfs', mountpoint: '/' }
    push('node_filesystem_size_bytes', fs, t, disk)
    push('node_filesystem_avail_bytes', fs, t, Math.round(disk - used - disk * 0.02))
    push('node_filesystem_free_bytes', fs, t, Math.round(disk - used))
    push('node_filesystem_readonly', fs, t, 0)
    push('node_network_receive_bytes_total', { device: 'eth0' }, t, Math.round(rx))
    push('node_network_transmit_bytes_total', { device: 'eth0' }, t, Math.round(tx))
    push('node_boot_time_seconds', {}, t, boot)
    push('node_time_seconds', {}, t, t)
  }
  return [up, ...series.values()]
}

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

/** Una aplicación web instrumentada: http_requests_total y el histograma de latencia. */
function buildHttp(h: HttpSpec, c: Ctx): Series[] {
  const job = h.job ?? 'api'
  const base: Labels = { instance: h.instancia, job }
  const handlers = h.handlers ?? ['/api/productos', '/api/carrito']
  const rand = rng(hash(h.instancia + job) ^ c.seed)
  const ev = (t: number) => (h.eventos ?? []).filter((e) => t >= at(e.desde, c.now, c.start) && t <= at(e.hasta, c.now, c.end))
  const param = <K extends 'rps' | 'errores' | 'latencia_ms'>(t: number, k: K, def: number) => {
    let v = h[k] ?? def
    for (const e of ev(t)) if (e[k] !== undefined) v = e[k]!
    return v
  }
  const series = new Map<string, Series>()
  const acc = new Map<string, number>()
  const push = (name: string, extra: Labels, t: number, inc: number) => {
    const labels = { __name__: name, ...base, ...extra }
    const key = JSON.stringify(labels)
    const v = (acc.get(key) ?? 0) + inc
    acc.set(key, v)
    let s = series.get(key)
    if (!s) series.set(key, (s = { labels, samples: [] }))
    s.samples.push({ t, v })
  }
  const up: Series = { labels: { __name__: 'up', ...base }, samples: [] }
  let prev: number | undefined
  for (const t of times(c)) {
    const dt = prev === undefined ? 0 : t - prev
    prev = t
    if (ev(t).some((e) => e.caido)) {
      up.samples.push({ t, v: 0 })
      continue
    }
    up.samples.push({ t, v: 1 })
    const rps = param(t, 'rps', 20) * (0.85 + rand() * 0.3)
    const err = Math.min(1, param(t, 'errores', 0.002))
    const lat = param(t, 'latencia_ms', 80) / 1000
    handlers.forEach((hd, i) => {
      const share = i === 0 ? 0.6 : 0.4 / Math.max(1, handlers.length - 1)
      const n = rps * share * dt
      push('http_requests_total', { handler: hd, method: 'GET', code: '200' }, t, n * (1 - err) * 0.97)
      push('http_requests_total', { handler: hd, method: 'GET', code: '404' }, t, n * (1 - err) * 0.03)
      push('http_requests_total', { handler: hd, method: 'GET', code: '500' }, t, n * err)
      // Latencias con distribución log-normal alrededor de la mediana.
      for (const le of BUCKETS) {
        const z = Math.log(le / lat) / 0.6
        push('http_request_duration_seconds_bucket', { handler: hd, le: String(le) }, t, n * 0.5 * (1 + erf(z / Math.SQRT2)))
      }
      push('http_request_duration_seconds_bucket', { handler: hd, le: '+Inf' }, t, n)
      push('http_request_duration_seconds_count', { handler: hd }, t, n)
      push('http_request_duration_seconds_sum', { handler: hd }, t, n * lat * 1.2)
    })
  }
  return [up, ...series.values()]
}

function erf(x: number): number {
  // Abramowitz y Stegun 7.1.26
  const s = Math.sign(x)
  const a = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * a)
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a)
  return s * y
}

export function buildTsdb(sc: Scenario = {}): Tsdb {
  const now = Date.parse(sc.ahora ?? DEFAULT_NOW) / 1000
  const span = parseDuration(sc.ventana ?? '6h') ?? 21600
  const step = parseDuration(sc.paso ?? '15s') ?? 15
  const c: Ctx = { now, start: now - span, end: now, step, seed: sc.semilla ?? 1 }
  const series: Series[] = []
  for (const n of sc.nodos ?? []) series.push(...buildNode(n, c))
  for (const h of sc.http ?? []) series.push(...buildHttp(h, c))
  for (const s of sc.series ?? []) series.push(...buildSpec(s, c))
  return { series: series.filter((s) => s.samples.length), start: c.start, end: now, step }
}

/** Nombres de métrica distintos (para autocompletar y para la lista de la consola). */
export function metricNames(db: Tsdb): string[] {
  return [...new Set(db.series.map((s) => s.labels.__name__))].sort()
}
