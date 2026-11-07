/**
 * Ejercicios de decisión de un router: por qué ruta sale un paquete (coincidencia más
 * específica) y qué ruta se instala cuando varias fuentes ofrecen la misma red (distancia
 * administrativa y, dentro de un mismo protocolo, la métrica).
 */
import { pick, randomInt, shuffle, type Rng } from '@/lib/random'

export interface RutaTabla {
  code: 'C' | 'S' | 'O' | 'S*' | 'D'
  net: string
  prefix: number
  iface: string
  via?: string
  ad: number
  metric: number
}

/** Distancias administrativas de Cisco IOS (menor = más confiable). */
export const DISTANCIAS: { fuente: string; ad: number }[] = [
  { fuente: 'Conectada', ad: 0 },
  { fuente: 'Estática', ad: 1 },
  { fuente: 'BGP externo (eBGP)', ad: 20 },
  { fuente: 'EIGRP', ad: 90 },
  { fuente: 'OSPF', ad: 110 },
  { fuente: 'IS-IS', ad: 115 },
  { fuente: 'RIP', ad: 120 },
  { fuente: 'BGP interno (iBGP)', ad: 200 },
]

function ipToInt(ip: string): number {
  return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0
}

function maskOf(prefix: number): number {
  return prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
}

export function contains(r: Pick<RutaTabla, 'net' | 'prefix'>, ip: string): boolean {
  return ((ipToInt(ip) & maskOf(r.prefix)) >>> 0) === ipToInt(r.net)
}

export function routeText(r: RutaTabla): string {
  const dest = `${r.net}/${r.prefix}`
  if (r.code === 'C') return `C     ${dest} is directly connected, ${r.iface}`
  return `${r.code.padEnd(5)} ${dest} [${r.ad}/${r.metric}] via ${r.via}, ${r.iface}`
}

/** La ruta elegida para un destino: la más específica de las que lo contienen (o ninguna). */
export function bestRoute(table: RutaTabla[], ip: string): number | undefined {
  let best: number | undefined
  table.forEach((r, i) => {
    if (contains(r, ip) && (best === undefined || r.prefix > table[best].prefix)) best = i
  })
  return best
}

export interface PreguntaSalida {
  table: RutaTabla[]
  dest: string
  /** Índice de la ruta elegida, o undefined si el paquete se descarta. */
  answer?: number
}

export function randomSalida(rng: Rng): PreguntaSalida {
  const r = (a: number, b: number) => randomInt(rng, a, b)
  const A = r(16, 99)
  const B = r(1, 200)
  const sub = pick(rng, [25, 26])
  const subNet = sub === 25 ? 128 : pick(rng, [64, 128, 192])
  const withDefault = rng() < 0.7
  const withSub = rng() < 0.8
  const table: RutaTabla[] = [
    { code: 'C', net: '192.168.1.0', prefix: 24, iface: 'GigabitEthernet0/0', ad: 0, metric: 0 },
    { code: 'C', net: '10.0.12.0', prefix: 30, iface: 'GigabitEthernet0/1', ad: 0, metric: 0 },
    { code: 'C', net: '10.0.13.0', prefix: 30, iface: 'GigabitEthernet0/2', ad: 0, metric: 0 },
    { code: 'S', net: `10.${A}.0.0`, prefix: 16, via: '10.0.12.2', iface: 'GigabitEthernet0/1', ad: 1, metric: 0 },
    { code: 'O', net: `10.${A}.${B}.0`, prefix: 24, via: '10.0.13.2', iface: 'GigabitEthernet0/2', ad: 110, metric: r(2, 40) },
  ]
  if (withSub) table.push({ code: 'O', net: `10.${A}.${B}.${subNet}`, prefix: sub, via: '10.0.12.2', iface: 'GigabitEthernet0/1', ad: 110, metric: r(41, 90) })
  if (withDefault) {
    table.push({ code: 'C', net: '203.0.113.0', prefix: 30, iface: 'GigabitEthernet0/3', ad: 0, metric: 0 })
    table.push({ code: 'S*', net: '0.0.0.0', prefix: 0, via: '203.0.113.1', iface: 'GigabitEthernet0/3', ad: 1, metric: 0 })
  }
  const size = 1 << (32 - sub)
  const options: (() => string)[] = [
    () => `192.168.1.${r(2, 254)}`,
    () => `10.${A}.${(B + r(1, 254)) % 256}.${r(1, 254)}`,
    () => `10.${A}.${B}.${withSub ? r(1, subNet - 1) : r(1, 254)}`,
    () => `10.${pick(rng, [A + 1, A + 7, 150, 200])}.${r(0, 255)}.${r(1, 254)}`,
    () => `${pick(rng, [8, 34, 142, 151, 185])}.${r(0, 255)}.${r(0, 255)}.${r(1, 254)}`,
  ]
  if (withSub) options.push(() => `10.${A}.${B}.${r(subNet, subNet + size - 1)}`, () => `10.${A}.${B}.${r(subNet, subNet + size - 1)}`)
  const dest = pick(rng, options)()
  // Como en IOS: por red y, al final, la ruta por defecto.
  const sorted = [...table].sort((a, b) => Number(a.prefix === 0) - Number(b.prefix === 0) || ipToInt(a.net) - ipToInt(b.net) || a.prefix - b.prefix)
  return { table: sorted, dest, answer: bestRoute(sorted, dest) }
}

export interface Candidata {
  fuente: string
  code: string
  ad: number
  metric: number
  via: string
}

export interface PreguntaInstalada {
  red: string
  candidatas: Candidata[]
  answer: number
}

const FUENTES: Omit<Candidata, 'via' | 'metric'>[] = [
  { fuente: 'Estática', code: 'S', ad: 1 },
  { fuente: 'Estática flotante (distancia 200)', code: 'S', ad: 200 },
  { fuente: 'EIGRP', code: 'D', ad: 90 },
  { fuente: 'OSPF', code: 'O', ad: 110 },
  { fuente: 'RIP', code: 'R', ad: 120 },
  { fuente: 'BGP externo (eBGP)', code: 'B', ad: 20 },
  { fuente: 'BGP interno (iBGP)', code: 'B', ad: 200 },
]

function metricFor(code: string, rng: Rng): number {
  if (code === 'R') return randomInt(rng, 1, 15)
  if (code === 'D') return randomInt(rng, 28000, 160000)
  if (code === 'O') return randomInt(rng, 2, 200)
  return 0
}

export function randomInstalada(rng: Rng): PreguntaInstalada {
  const red = `172.${randomInt(rng, 16, 31)}.${randomInt(rng, 0, 255)}.0/24`
  const vias = shuffle(rng, ['10.0.12.2', '10.0.13.2', '10.0.14.2', '10.0.15.2'])
  let fuentes: Omit<Candidata, 'via' | 'metric'>[]
  if (rng() < 0.3) {
    // Dos rutas OSPF y otra fuente de mayor distancia: decide la métrica.
    const other = pick(rng, FUENTES.filter((f) => f.ad > 110))
    fuentes = [FUENTES[3], FUENTES[3], other]
  } else fuentes = shuffle(rng, FUENTES).slice(0, 3)
  const candidatas = fuentes.map((f, i) => ({ ...f, via: vias[i], metric: metricFor(f.code, rng) }))
  if (candidatas[0].code === 'O' && candidatas[1].code === 'O' && candidatas[0].metric === candidatas[1].metric) candidatas[1].metric += 10
  let answer = 0
  candidatas.forEach((c, i) => {
    const b = candidatas[answer]
    if (c.ad < b.ad || (c.ad === b.ad && c.metric < b.metric)) answer = i
  })
  const order = shuffle(
    rng,
    candidatas.map((_, i) => i),
  )
  return { red, candidatas: order.map((i) => candidatas[i]), answer: order.indexOf(answer) }
}
