/** Cálculos de RAID para el simulador: capacidad, tolerancia, qué guarda cada disco y si los datos siguen. */
export type RaidLevel = 0 | 1 | 5 | 6 | 10

export const MIN_DISKS: Record<RaidLevel, number> = { 0: 2, 1: 2, 5: 3, 6: 4, 10: 4 }

export interface RaidInfo {
  /** Capacidad útil en TB. */
  capacidad: number
  /** Porcentaje del espacio comprado que se puede usar. */
  eficiencia: number
  /** Descripción de cuántos discos pueden fallar. */
  tolerancia: string
  /** Cuántos discos pueden fallar seguro, sin importar cuáles. */
  fallasSeguras: number
  lectura: string
  escritura: string
}

export function raidInfo(level: RaidLevel, n: number, tb: number): RaidInfo {
  const data = level === 0 ? n : level === 1 ? 1 : level === 5 ? n - 1 : level === 6 ? n - 2 : n / 2
  const capacidad = Math.round(data * tb * 100) / 100
  const eficiencia = Math.round((data / n) * 100)
  switch (level) {
    case 0:
      return { capacidad, eficiencia, tolerancia: 'Ninguno: si falla un disco se pierde todo.', fallasSeguras: 0, lectura: `hasta ${n} veces un disco`, escritura: `hasta ${n} veces un disco` }
    case 1:
      return { capacidad, eficiencia, tolerancia: `Hasta ${n - 1} (queda una copia completa en cada disco).`, fallasSeguras: n - 1, lectura: `hasta ${n} veces un disco`, escritura: 'como un disco' }
    case 5:
      return { capacidad, eficiencia, tolerancia: 'Uno cualquiera.', fallasSeguras: 1, lectura: `hasta ${n - 1} veces un disco`, escritura: 'más lenta: cada escritura recalcula la paridad' }
    case 6:
      return { capacidad, eficiencia, tolerancia: 'Dos cualesquiera.', fallasSeguras: 2, lectura: `hasta ${n - 2} veces un disco`, escritura: 'la más lenta: dos paridades por escritura' }
    case 10:
      return { capacidad, eficiencia, tolerancia: `Uno seguro; hasta ${n / 2} si cada uno es de un par distinto.`, fallasSeguras: 1, lectura: `hasta ${n} veces un disco`, escritura: `hasta ${n / 2} veces un disco` }
  }
}

/** ¿Siguen estando todos los datos con estos discos fallados? */
export function dataSurvives(level: RaidLevel, n: number, failed: ReadonlySet<number>): boolean {
  const f = [...failed].filter((i) => i < n).length
  if (level === 0) return f === 0
  if (level === 1) return f < n
  if (level === 5) return f <= 1
  if (level === 6) return f <= 2
  for (let i = 0; i < n; i += 2) if (failed.has(i) && failed.has(i + 1)) return false
  return true
}

export type RaidState = 'sano' | 'degradado' | 'perdido'

export function raidState(level: RaidLevel, n: number, failed: ReadonlySet<number>): RaidState {
  if (!dataSurvives(level, n, failed)) return 'perdido'
  return [...failed].some((i) => i < n) ? 'degradado' : 'sano'
}

/** Qué guarda cada disco en las primeras filas (para dibujarlo): A1, A2... datos; P y Q, paridad. */
export function layout(level: RaidLevel, n: number, rows = 4): string[][] {
  const disks: string[][] = Array.from({ length: n }, () => [])
  const letters = 'ABCDEFGH'
  for (let r = 0; r < rows; r++) {
    const L = letters[r]
    if (level === 0) for (let d = 0; d < n; d++) disks[d].push(`${L}${d + 1}`)
    else if (level === 1) for (let d = 0; d < n; d++) disks[d].push(L)
    else if (level === 10) for (let d = 0; d < n; d++) disks[d].push(`${L}${Math.floor(d / 2) + 1}`)
    else {
      const parity = level === 5 ? 1 : 2
      // Paridad rotativa (left-symmetric): la P (y la Q) cambian de disco en cada fila.
      const p = (n - 1 - (r % n) + n) % n
      const q = (p + 1) % n
      let k = 1
      for (let d = 0; d < n; d++) {
        if (d === p) disks[d].push(`${L}p`)
        else if (parity === 2 && d === q) disks[d].push(`${L}q`)
        else disks[d].push(`${L}${k++}`)
      }
    }
  }
  return disks
}

/** Horas para reconstruir un disco, a una velocidad sostenida (MB/s). */
export function rebuildHours(tb: number, mbps = 150): number {
  return Math.round(((tb * 1e12) / (mbps * 1e6) / 3600) * 10) / 10
}
