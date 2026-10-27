/** Unidades de almacenamiento y de velocidad: decimales (SI) y binarias (IEC). */

export const SIZE_UNITS = {
  B: 1,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  PB: 1e15,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
  PiB: 1024 ** 5,
} as const

export type SizeUnit = keyof typeof SIZE_UNITS

/** Velocidades: en bits por segundo (redes) o en bytes por segundo (discos y descargas). */
export const SPEED_UNITS = {
  'Kbps': 1e3 / 8,
  'Mbps': 1e6 / 8,
  'Gbps': 1e9 / 8,
  'KB/s': 1e3,
  'MB/s': 1e6,
  'GB/s': 1e9,
  'MiB/s': 1024 ** 2,
} as const

export type SpeedUnit = keyof typeof SPEED_UNITS

export function toBytes(value: number, unit: SizeUnit): number {
  return value * SIZE_UNITS[unit]
}

export function fromBytes(bytes: number, unit: SizeUnit): number {
  return bytes / SIZE_UNITS[unit]
}

/** Bytes por segundo. */
export function speedToBytes(value: number, unit: SpeedUnit): number {
  return value * SPEED_UNITS[unit]
}

export function formatNumber(n: number, decimals = 2): string {
  return n.toLocaleString('es', { maximumFractionDigits: decimals, minimumFractionDigits: 0 })
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—'
  if (seconds < 1) return `${formatNumber(seconds * 1000, 0)} ms`
  if (seconds < 60) return `${formatNumber(seconds, 1)} s`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.round(seconds % 60)
  if (h >= 48) return `${formatNumber(seconds / 86400, 1)} días`
  if (h > 0) return `${h} h ${m} min`
  return `${m} min ${s} s`
}

/** Explicación de cuánto tarda en transferirse un archivo. */
export function transferTime(size: number, sizeUnit: SizeUnit, speed: number, speedUnit: SpeedUnit): { seconds: number; pasos: string[] } {
  const bytes = toBytes(size, sizeUnit)
  const bps = speedToBytes(speed, speedUnit)
  const seconds = bytes / bps
  const pasos = [`Tamaño: ${formatNumber(size)} ${sizeUnit} = ${formatNumber(bytes, 0)} bytes${sizeUnit.includes('i') ? ' (unidad binaria: potencias de 1024)' : ''}.`]
  if (speedUnit.endsWith('bps')) {
    pasos.push(`La velocidad está en bits por segundo: ${formatNumber(speed)} ${speedUnit} = ${formatNumber(speed * (speedUnit === 'Kbps' ? 1e3 : speedUnit === 'Mbps' ? 1e6 : 1e9), 0)} bits/s.`)
    pasos.push(`Un byte son 8 bits: ${formatNumber(bps, 0)} bytes/s (${formatNumber(bps / 1e6)} MB/s).`)
  } else pasos.push(`Velocidad: ${formatNumber(bps, 0)} bytes/s.`)
  pasos.push(`Tiempo = tamaño ÷ velocidad = ${formatNumber(bytes, 0)} ÷ ${formatNumber(bps, 0)} = ${formatNumber(seconds)} s ≈ ${formatDuration(seconds)}.`)
  pasos.push('En la práctica tarda algo más: los protocolos agregan encabezados y la red rara vez rinde el 100% de lo contratado.')
  return { seconds, pasos }
}

/** Lo que muestra el sistema operativo para un disco vendido en unidades decimales. */
export function advertisedToBinary(value: number, unit: 'GB' | 'TB'): { gib: number; tib: number; pasos: string[] } {
  const bytes = toBytes(value, unit)
  const gib = bytes / SIZE_UNITS.GiB
  const tib = bytes / SIZE_UNITS.TiB
  return {
    gib,
    tib,
    pasos: [
      `El fabricante usa unidades decimales: ${value} ${unit} = ${formatNumber(bytes, 0)} bytes.`,
      `Windows y muchas herramientas dividen por 1024: ${formatNumber(bytes, 0)} ÷ 1024³ = ${formatNumber(gib)} GiB${unit === 'TB' ? ` (${formatNumber(tib)} TiB)` : ''}.`,
      'No falta espacio: es la misma cantidad de bytes expresada en otra unidad. Windows además escribe "GB" cuando en realidad calcula GiB.',
    ],
  }
}
