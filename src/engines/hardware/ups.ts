/** Cálculos de una UPS: potencia (W y VA), margen y autonomía estimada. */
export interface Load {
  nombre: string
  watts: number
  cantidad: number
}

export interface UpsModel {
  id: string
  nombre: string
  va: number
  watts: number
  /** Energía de las baterías internas (Wh). */
  bateriaWh: number
  tipo: 'interactiva' | 'online'
}

export const UPS_CATALOG: UpsModel[] = [
  { id: 'u1000', nombre: '1000 VA / 600 W, interactiva', va: 1000, watts: 600, bateriaWh: 168, tipo: 'interactiva' },
  { id: 'u1500', nombre: '1500 VA / 1000 W, interactiva', va: 1500, watts: 1000, bateriaWh: 302, tipo: 'interactiva' },
  { id: 'u3000', nombre: '3000 VA / 2700 W, online', va: 3000, watts: 2700, bateriaWh: 648, tipo: 'online' },
  { id: 'u6000', nombre: '6000 VA / 6000 W, online', va: 6000, watts: 6000, bateriaWh: 1296, tipo: 'online' },
]

export const LOAD_CATALOG: Load[] = [
  { nombre: 'Servidor 1U', watts: 250, cantidad: 0 },
  { nombre: 'Servidor 2U', watts: 400, cantidad: 0 },
  { nombre: 'Almacenamiento (NAS) 2U', watts: 180, cantidad: 0 },
  { nombre: 'Switch de 48 puertos', watts: 60, cantidad: 0 },
  { nombre: 'Firewall o router', watts: 40, cantidad: 0 },
  { nombre: 'Monitor de la consola', watts: 25, cantidad: 0 },
]

export interface UpsResult {
  watts: number
  /** VA aproximados de la carga (factor de potencia 0,9). */
  va: number
  /** Porcentaje de la capacidad en W de la UPS que usa la carga. */
  cargaPct: number
  /** Minutos de autonomía estimados. */
  minutos: number
  /** La carga no supera el 80 % de la UPS ni en W ni en VA. */
  conMargen: boolean
  sobrecarga: boolean
}

/** Rendimiento del inversor y descarga útil de la batería: lo que de verdad se aprovecha. */
const EFICIENCIA = 0.8

export function upsCalc(loads: Load[], ups: Pick<UpsModel, 'va' | 'watts' | 'bateriaWh'>, extraWh = 0): UpsResult {
  const watts = loads.reduce((s, l) => s + l.watts * l.cantidad, 0)
  const va = Math.round(watts / 0.9)
  const cargaPct = ups.watts ? Math.round((watts / ups.watts) * 100) : 0
  const wh = (ups.bateriaWh + extraWh) * EFICIENCIA
  const minutos = watts > 0 ? Math.round((wh / watts) * 60) : 0
  return { watts, va, cargaPct, minutos, conMargen: watts <= ups.watts * 0.8 && va <= ups.va * 0.8, sobrecarga: watts > ups.watts || va > ups.va }
}

/** El modelo más chico del catálogo que deja margen y alcanza los minutos pedidos. */
export function recommend(loads: Load[], minutos: number): UpsModel | undefined {
  return UPS_CATALOG.find((u) => {
    const r = upsCalc(loads, u)
    return r.conMargen && r.minutos >= minutos
  })
}
