import { describe, expect, it } from 'vitest'
import { createCpu, PROGRAMS, runToEnd, stepCpu } from '@/engines/fundamentos/cpu'
import { checkNumberAnswer, CONVERSIONS, explainConversion, fromBase, generateNumberExercise, octalToPerms, permsToOctal, toBase } from '@/engines/fundamentos/numbers'
import { access, allocate, createMemory, fillCache, memoryStats } from '@/engines/fundamentos/paging'
import { schedule, type Proc } from '@/engines/fundamentos/scheduler'
import { DISKS, estimate, WORKLOADS } from '@/engines/fundamentos/storage'
import { advertisedToBinary, transferTime } from '@/engines/fundamentos/units'
import { createRng } from '@/lib/random'

describe('CPU didáctica', () => {
  it('suma dos números con el ciclo buscar-decodificar-ejecutar', () => {
    let s = createCpu(PROGRAMS[0])
    s = stepCpu(s)
    expect(s.phase).toBe('decodificar')
    expect(s.pc).toBe(1)
    expect(s.ir).toEqual({ op: 'LOAD', arg: 6 })
    s = runToEnd(s)
    expect(s.halted).toBe(true)
    expect(s.output).toEqual([42])
    expect(s.memory[8]).toBe(42)
  })

  it('el bucle cuenta hacia atrás y la caché acelera las vueltas', () => {
    const sin = runToEnd(createCpu(PROGRAMS[1]))
    const con = runToEnd(createCpu(PROGRAMS[1], true))
    expect(sin.output).toEqual([5, 4, 3, 2, 1, 0])
    expect(con.output).toEqual([5, 4, 3, 2, 1, 0])
    expect(con.cycles).toBeLessThan(sin.cycles / 2)
    expect(con.cacheHits).toBeGreaterThan(con.cacheMisses)
  })
})

describe('planificador de CPU', () => {
  const procs: Proc[] = [
    { id: 'A', llegada: 0, rafaga: 5, prioridad: 3 },
    { id: 'B', llegada: 1, rafaga: 3, prioridad: 1 },
    { id: 'C', llegada: 2, rafaga: 1, prioridad: 2 },
  ]
  it('FCFS atiende por orden de llegada', () => {
    const r = schedule(procs, 'fcfs')
    expect(r.segments.map((s) => `${s.id}${s.start}-${s.end}`)).toEqual(['A0-5', 'B5-8', 'C8-9'])
    expect(r.results.find((x) => x.id === 'C')!.espera).toBe(6)
  })
  it('Round Robin con quantum 2 (resuelto a mano)', () => {
    const r = schedule(procs, 'rr', 2)
    expect(r.segments.map((s) => `${s.id}${s.start}-${s.end}`)).toEqual(['A0-2', 'B2-4', 'C4-5', 'A5-7', 'B7-8', 'A8-9'])
    expect(r.esperaPromedio).toBeCloseTo((4 + 4 + 2) / 3)
  })
  it('prioridades con expropiación', () => {
    const r = schedule(procs, 'prioridad')
    expect(r.segments.map((s) => `${s.id}${s.start}-${s.end}`)).toEqual(['A0-1', 'B1-4', 'C4-5', 'A5-9'])
  })
  it('CPU ociosa si no hay procesos listos', () => {
    const r = schedule([{ id: 'X', llegada: 3, rafaga: 2, prioridad: 1 }], 'fcfs')
    expect(r.segments).toEqual([{ id: null, start: 0, end: 3 }, { id: 'X', start: 3, end: 5 }])
  })
})

describe('memoria virtual', () => {
  it('primero usa memoria libre, después descarta caché, después usa swap y al final el OOM killer', () => {
    let s = createMemory(4, 2, [{ id: 'a', nombre: 'web' }, { id: 'b', nombre: 'base de datos' }], 1)
    s = allocate(s, 'a')
    s = allocate(s, 'a')
    s = allocate(s, 'b')
    expect(memoryStats(s)).toMatchObject({ used: 3, cache: 1, free: 0, available: 1 })
    s = allocate(s, 'b')
    expect(memoryStats(s).cache).toBe(0)
    s = allocate(s, 'b')
    expect(memoryStats(s).swapUsed).toBe(1)
    expect(s.swapOuts).toBe(1)
    s = access(s, 'a', 0)
    expect(s.pageFaults).toBe(1)
    s = allocate(s, 'b')
    s = allocate(s, 'b')
    expect(s.procs.find((p) => p.id === 'b')!.alive).toBe(false)
    expect(s.log.some((l) => l.kind === 'oom')).toBe(true)
  })
  it('la caché de disco cuenta como memoria disponible', () => {
    const s = fillCache(createMemory(4, 0, []))
    expect(memoryStats(s)).toMatchObject({ free: 3, cache: 1, available: 4 })
  })
})

describe('sistemas numéricos y unidades', () => {
  it('conversiones', () => {
    expect(toBase(192, 2)).toBe('11000000')
    expect(fromBase('1100 0000', 2)).toBe(192)
    expect(fromBase('0xFF', 16)).toBe(255)
    expect(fromBase('102', 2)).toBeUndefined()
    expect(explainConversion(192, 10, 2).join(' ')).toMatch(/128 cabe en 192/)
    expect(explainConversion(0xc0, 2, 16).at(-1)).toBe('Resultado: C0.')
    expect(permsToOctal('rwxr-x---')).toBe('750')
    expect(octalToPerms('644')).toBe('rw-r--r--')
  })
  it('ejercicios al azar que se corrigen con su respuesta', () => {
    const rng = createRng(11)
    for (let i = 0; i < 2000; i++) {
      const c = CONVERSIONS[i % CONVERSIONS.length]
      const ex = generateNumberExercise(rng, c.id, ((i % 3) + 1) as 1 | 2 | 3)
      expect(checkNumberAnswer(ex, ex.respuesta)).toBe(true)
      expect(ex.pasos.length).toBeGreaterThan(0)
    }
  })
  it('un disco de 1 TB muestra unos 931 GiB y 100 Mbps son 12,5 MB/s', () => {
    expect(advertisedToBinary(1, 'TB').gib).toBeCloseTo(931.32, 1)
    expect(transferTime(1, 'GB', 100, 'Mbps').seconds).toBeCloseTo(80)
    expect(transferTime(1, 'GB', 100, 'MB/s').seconds).toBeCloseTo(10)
  })
  it('discos: NVMe gana en base de datos y el disco rígido es el más barato por TB', () => {
    const bd = WORKLOADS.find((w) => w.id === 'bd')!
    const fastest = [...DISKS].sort((a, b) => estimate(a, bd) - estimate(b, bd))[0]
    expect(fastest.id).toBe('nvme5')
    expect(estimate(DISKS[0], bd) / 3600).toBeGreaterThan(3)
    expect([...DISKS].sort((a, b) => a.costoRelativo - b.costoRelativo)[0].id).toBe('hdd')
  })
})
