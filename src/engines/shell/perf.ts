/**
 * Modelo de rendimiento del servidor simulado: un solo cálculo de CPU, memoria, disco y carga
 * a partir de los procesos, para que top, uptime, free, vmstat, iostat, mpstat y sar coincidan.
 */
import type { Proc, System } from './system'

export const NCPU = 2
export const MEM_TOTAL_KB = 3843580

export interface Metrics {
  us: number
  ni: number
  sy: number
  wa: number
  st: number
  id: number
  load: [number, number, number]
  running: number
  blocked: number
  memUsedKb: number
  memFreeKb: number
  cacheKb: number
  availKb: number
  swapUsedKb: number
  swapTotalKb: number
  /** Lectura y escritura totales en el disco, en KB/s. */
  readKbs: number
  writeKbs: number
  /** Porcentaje de uso del disco (tiempo ocupado). */
  util: number
}

export interface PerfState {
  memUsedKb?: number
  cacheKb?: number
  swapUsedKb?: number
  steal?: number
  load?: [number, number, number]
  /** Hace cuántos minutos empezó el problema (para sar: antes de eso, valores normales). */
  incidentMinutes?: number
}

function active(p: Proc) {
  return !p.stat.startsWith('T') && !p.stat.startsWith('Z')
}

export function metrics(sys: System, onlyBase = false): Metrics {
  const st = sys.perf
  const procs = onlyBase ? sys.procs.filter((p) => !p.fromState) : sys.procs
  const live = procs.filter(active)
  const cpuSum = live.reduce((s, p) => s + p.cpu, 0)
  const niced = live.filter((p) => (p.nice ?? 0) > 0).reduce((s, p) => s + p.cpu, 0)
  const cap = NCPU * 100
  const scale = cpuSum > cap ? cap / cpuSum : 1
  const ni = Math.min(100, (niced * scale) / NCPU)
  const us = Math.min(100 - ni, ((cpuSum - niced) * scale) / NCPU)
  const readKbs = live.reduce((s, p) => s + (p.io?.r ?? 0), 0) + 12
  const writeKbs = live.reduce((s, p) => s + (p.io?.w ?? 0), 0) + 35
  const blocked = procs.filter((p) => p.stat.startsWith('D')).length
  const ioMb = (readKbs + writeKbs) / 1024
  const steal = onlyBase ? 0 : (st.steal ?? 0)
  const sy = Math.min(100, 0.6 + us * 0.04 + ioMb * 0.05)
  // iowait es tiempo libre de la CPU mientras espera al disco: no puede superar lo que queda libre.
  const wa = Math.max(0, Math.min(70, ioMb * 0.55 + blocked * 9, 100 - us - ni - sy - steal))
  const id = Math.max(0, 100 - us - ni - sy - wa - steal)
  const running = live.filter((p) => p.stat.startsWith('R') || p.cpu > 50).length || 1
  const base = 0.08 + cpuSum / 100 + blocked + wa / 25
  const load: [number, number, number] = !onlyBase && st.load ? st.load : [base, base * 0.85 + 0.03, base * 0.6 + 0.05]
  const memProcs = procs.reduce((s, p) => s + p.mem, 0)
  const usedDefault = 720 * 1024 + (memProcs * MEM_TOTAL_KB) / 100
  const memUsedKb = Math.min(MEM_TOTAL_KB - 120 * 1024, !onlyBase && st.memUsedKb !== undefined ? st.memUsedKb : usedDefault)
  const cacheKb = Math.max(110 * 1024, Math.min(!onlyBase && st.cacheKb !== undefined ? st.cacheKb : 1300 * 1024, MEM_TOTAL_KB - memUsedKb - 90 * 1024))
  const memFreeKb = Math.max(60 * 1024, MEM_TOTAL_KB - memUsedKb - cacheKb)
  const availKb = memFreeKb + cacheKb * 0.82
  const swapTotalKb = sys.storage.swaps.reduce((a, w) => a + w.size / 1024 - 4, 0)
  const swapUsedKb = Math.min(swapTotalKb, !onlyBase && st.swapUsedKb !== undefined ? st.swapUsedKb : 0)
  const util = Math.min(99.9, ioMb * 1.4 + blocked * 20)
  return { us, ni, sy, wa, st: steal, id, load, running, blocked, memUsedKb, memFreeKb, cacheKb, availKb, swapUsedKb, swapTotalKb, readKbs, writeKbs, util }
}

/** Ruido determinista para que las muestras de sar no sean todas iguales. */
export function jitter(seed: number, amount: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453
  return (x - Math.floor(x) - 0.5) * 2 * amount
}
