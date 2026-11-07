/**
 * PoE (alimentación por el cable de red): estándares IEEE 802.3af/at/bt, potencia que entrega
 * el switch por puerto y la que le llega al equipo después de las pérdidas del cable, y el
 * presupuesto total del switch.
 */
import { pick, randomInt, type Rng } from '@/lib/random'

export type PoeStandard = 'af' | 'at' | 'bt3' | 'bt4'

export const POE_STANDARDS: Record<PoeStandard, { nombre: string; norma: string; pse: number; pd: number; pares: number }> = {
  af: { nombre: 'PoE', norma: '802.3af (Tipo 1)', pse: 15.4, pd: 12.95, pares: 2 },
  at: { nombre: 'PoE+', norma: '802.3at (Tipo 2)', pse: 30, pd: 25.5, pares: 2 },
  bt3: { nombre: 'PoE++ Tipo 3', norma: '802.3bt (Tipo 3)', pse: 60, pd: 51, pares: 4 },
  bt4: { nombre: 'PoE++ Tipo 4', norma: '802.3bt (Tipo 4)', pse: 90, pd: 71.3, pares: 4 },
}

export const ORDER: PoeStandard[] = ['af', 'at', 'bt3', 'bt4']

/** El estándar más chico que le alcanza a un equipo que consume esos vatios. */
export function standardFor(watts: number): PoeStandard | undefined {
  return ORDER.find((s) => POE_STANDARDS[s].pd >= watts)
}

export interface PoeDevice {
  id: string
  nombre: string
  /** Consumo máximo del equipo, en vatios (lo que dice su hoja de datos). */
  watts: number
  cantidad: number
}

export const DEVICE_CATALOG: Omit<PoeDevice, 'cantidad'>[] = [
  { id: 'telefono', nombre: 'Teléfono IP', watts: 5 },
  { id: 'camara', nombre: 'Cámara IP fija', watts: 7 },
  { id: 'ap6', nombre: 'Punto de acceso Wi-Fi 6', watts: 20 },
  { id: 'ap7', nombre: 'Punto de acceso Wi-Fi 7', watts: 40 },
  { id: 'ptz', nombre: 'Cámara PTZ con calefactor', watts: 55 },
  { id: 'pantalla', nombre: 'Pantalla de señalización', watts: 70 },
  { id: 'lector', nombre: 'Lector de acceso con cerradura', watts: 10 },
]

export interface PoeResult {
  lines: { device: PoeDevice; standard?: PoeStandard; reservado: number }[]
  /** Lo que reserva el switch (por clase: lo máximo del estándar de cada puerto). */
  reservado: number
  /** Consumo real estimado (lo que piden los equipos más un 10% de pérdida en el cable). */
  real: number
  presupuesto: number
  puertos: number
  puertosUsados: number
  /** Equipos que ningún estándar alcanza a alimentar, o el switch no soporta. */
  sinPoe: PoeDevice[]
}

/**
 * Cálculo del presupuesto. "maxStandard" es lo que soporta el switch (muchos switches PoE+
 * no entregan PoE++). Con "porClase" el switch reserva el máximo de la clase de cada equipo
 * (lo más común en switches de oficina); si no, asigna según el consumo real (LLDP).
 */
export function poeBudget(devices: PoeDevice[], presupuesto: number, puertos: number, maxStandard: PoeStandard, porClase = true): PoeResult {
  const lines: PoeResult['lines'] = []
  const sinPoe: PoeDevice[] = []
  let reservado = 0
  let real = 0
  let used = 0
  const maxIdx = ORDER.indexOf(maxStandard)
  for (const d of devices) {
    if (d.cantidad <= 0) continue
    const st = standardFor(d.watts)
    used += d.cantidad
    if (!st || ORDER.indexOf(st) > maxIdx) {
      sinPoe.push(d)
      lines.push({ device: d, standard: st, reservado: 0 })
      continue
    }
    const perPort = porClase ? POE_STANDARDS[st].pse : +(d.watts * 1.1).toFixed(1)
    reservado += perPort * d.cantidad
    real += d.watts * 1.1 * d.cantidad
    lines.push({ device: d, standard: st, reservado: +(perPort * d.cantidad).toFixed(1) })
  }
  return { lines, reservado: +reservado.toFixed(1), real: +real.toFixed(1), presupuesto, puertos, puertosUsados: used, sinPoe }
}

export interface PoeExercise {
  enunciado: string
  devices: PoeDevice[]
  presupuesto: number
  puertos: number
  maxStandard: PoeStandard
  alcanza: boolean
  explicacion: string[]
}

const SWITCHES: { presupuesto: number; puertos: number; max: PoeStandard; nombre: string }[] = [
  { presupuesto: 65, puertos: 8, max: 'at', nombre: 'switch de 8 puertos PoE+ con 65 W' },
  { presupuesto: 125, puertos: 8, max: 'at', nombre: 'switch de 8 puertos PoE+ con 125 W' },
  { presupuesto: 195, puertos: 24, max: 'at', nombre: 'switch de 24 puertos PoE+ con 195 W' },
  { presupuesto: 370, puertos: 24, max: 'at', nombre: 'switch de 24 puertos PoE+ con 370 W' },
  { presupuesto: 740, puertos: 48, max: 'bt4', nombre: 'switch de 48 puertos PoE++ con 740 W' },
]

export function generatePoeExercise(rng: Rng): PoeExercise {
  const sw = pick(rng, SWITCHES)
  const kinds = [...DEVICE_CATALOG].sort(() => rng() - 0.5).slice(0, randomInt(rng, 2, 3))
  const devices = kinds.map((k) => ({ ...k, cantidad: randomInt(rng, 1, Math.max(2, Math.floor(sw.puertos / 3))) }))
  const r = poeBudget(devices, sw.presupuesto, sw.puertos, sw.max)
  const alcanza = r.sinPoe.length === 0 && r.reservado <= sw.presupuesto && r.puertosUsados <= sw.puertos
  const explicacion = [
    ...r.lines.map((l) =>
      l.standard && !r.sinPoe.includes(l.device)
        ? `${l.device.cantidad} × ${l.device.nombre} (${l.device.watts} W) → ${POE_STANDARDS[l.standard].nombre}: el switch reserva ${POE_STANDARDS[l.standard].pse} W por puerto = ${l.reservado} W.`
        : `${l.device.nombre} (${l.device.watts} W) necesita ${l.standard ? POE_STANDARDS[l.standard].norma : 'más de 71,3 W, más de lo que da cualquier PoE'} y este switch no lo entrega.`,
    ),
    `Total reservado: ${r.reservado} W de ${sw.presupuesto} W disponibles; puertos: ${r.puertosUsados} de ${sw.puertos}.`,
    alcanza ? 'Alcanza.' : r.sinPoe.length ? 'No alcanza: hay equipos que este switch no puede alimentar.' : r.puertosUsados > sw.puertos ? 'No alcanza: faltan puertos.' : 'No alcanza: se pasa del presupuesto de potencia.',
  ]
  return {
    enunciado: `Tenés un ${sw.nombre} y querés conectar: ${devices.map((d) => `${d.cantidad} × ${d.nombre.toLowerCase()} (${d.watts} W)`).join(', ')}. Si el switch reserva la potencia por clase, ¿alcanza?`,
    devices,
    presupuesto: sw.presupuesto,
    puertos: sw.puertos,
    maxStandard: sw.max,
    alcanza,
    explicacion,
  }
}
