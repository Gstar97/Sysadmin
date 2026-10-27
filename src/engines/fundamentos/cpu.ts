/**
 * CPU didáctica de acumulador: 16 celdas de memoria, registros PC, IR y ACC, y el ciclo
 * buscar → decodificar → ejecutar. Opcionalmente simula una caché para mostrar por qué
 * acceder a la memoria es mucho más lento que trabajar con registros.
 */

export type OpCode = 'LOAD' | 'STORE' | 'ADD' | 'SUB' | 'JMP' | 'JZ' | 'OUT' | 'HLT'

export interface Instruction {
  op: OpCode
  arg?: number
}

export type Cell = Instruction | number

export const OP_HELP: Record<OpCode, string> = {
  LOAD: 'Copia en el acumulador (ACC) el valor de la celda indicada.',
  STORE: 'Guarda el valor del acumulador en la celda indicada.',
  ADD: 'Suma al acumulador el valor de la celda indicada.',
  SUB: 'Resta al acumulador el valor de la celda indicada.',
  JMP: 'Salta: la próxima instrucción será la de la celda indicada.',
  JZ: 'Salta a la celda indicada solo si el acumulador vale 0.',
  OUT: 'Muestra el valor del acumulador (salida).',
  HLT: 'Detiene el programa.',
}

export type Phase = 'buscar' | 'decodificar' | 'ejecutar'

export interface CpuState {
  memory: Cell[]
  pc: number
  ir?: Instruction
  acc: number
  phase: Phase
  halted: boolean
  output: number[]
  cycles: number
  /** Celda leída o escrita en el último paso, para resaltarla. */
  touched?: { cell: number; kind: 'read' | 'write' }
  /** Registro cambiado en el último paso. */
  changed?: 'pc' | 'ir' | 'acc'
  message: string
  cache?: Set<number>
  cacheHits: number
  cacheMisses: number
  steps: number
}

export const RAM_CYCLES = 100
export const CACHE_CYCLES = 4

export interface CpuProgram {
  id: string
  nombre: string
  descripcion: string
  memory: Cell[]
}

export const PROGRAMS: CpuProgram[] = [
  {
    id: 'suma',
    nombre: 'Sumar dos números',
    descripcion: 'Suma el contenido de las celdas 6 y 7, guarda el resultado en la 8 y lo muestra.',
    memory: [{ op: 'LOAD', arg: 6 }, { op: 'ADD', arg: 7 }, { op: 'STORE', arg: 8 }, { op: 'OUT' }, { op: 'HLT' }, 0, 25, 17, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  {
    id: 'cuenta',
    nombre: 'Cuenta regresiva (bucle)',
    descripcion: 'Muestra 5, 4, 3, 2, 1 y 0. Repite las mismas instrucciones, así que con la caché activada se nota que las vueltas siguientes son mucho más rápidas.',
    memory: [{ op: 'LOAD', arg: 10 }, { op: 'OUT' }, { op: 'SUB', arg: 11 }, { op: 'JZ', arg: 5 }, { op: 'JMP', arg: 1 }, { op: 'OUT' }, { op: 'HLT' }, 0, 0, 0, 5, 1, 0, 0, 0, 0],
  },
]

export function formatInstruction(c: Cell): string {
  if (typeof c === 'number') return String(c)
  return c.arg === undefined ? c.op : `${c.op} ${c.arg}`
}

export function createCpu(program: CpuProgram, withCache = false): CpuState {
  return {
    memory: program.memory.map((c) => (typeof c === 'number' ? c : { ...c })),
    pc: 0,
    acc: 0,
    phase: 'buscar',
    halted: false,
    output: [],
    cycles: 0,
    message: 'Listo para empezar: el contador de programa (PC) apunta a la celda 0.',
    cache: withCache ? new Set() : undefined,
    cacheHits: 0,
    cacheMisses: 0,
    steps: 0,
  }
}

function memoryCost(s: CpuState, cell: number): { cost: number; note: string } {
  if (!s.cache) return { cost: RAM_CYCLES, note: `acceso a RAM: ${RAM_CYCLES} ciclos` }
  if (s.cache.has(cell)) {
    s.cacheHits++
    return { cost: CACHE_CYCLES, note: `estaba en caché: ${CACHE_CYCLES} ciclos` }
  }
  s.cache.add(cell)
  s.cacheMisses++
  return { cost: RAM_CYCLES, note: `no estaba en caché, se trae de la RAM: ${RAM_CYCLES} ciclos` }
}

/** Avanza una fase del ciclo de instrucción. Devuelve un estado nuevo. */
export function stepCpu(prev: CpuState): CpuState {
  if (prev.halted) return prev
  const s: CpuState = { ...prev, memory: [...prev.memory], output: [...prev.output], cache: prev.cache ? new Set(prev.cache) : undefined, touched: undefined, changed: undefined, steps: prev.steps + 1 }
  if (s.phase === 'buscar') {
    const cell = s.memory[s.pc]
    const { cost, note } = memoryCost(s, s.pc)
    s.cycles += cost
    s.touched = { cell: s.pc, kind: 'read' }
    if (typeof cell === 'number') {
      s.halted = true
      s.message = `La celda ${s.pc} contiene un dato (${cell}), no una instrucción: el programa se detuvo por error.`
      return s
    }
    s.ir = { ...cell }
    s.message = `BUSCAR: se lee la celda ${s.pc} (${note}) y se copia "${formatInstruction(cell)}" en el registro de instrucción (IR). El PC pasa a ${s.pc + 1}.`
    s.pc = s.pc + 1
    s.changed = 'ir'
    s.phase = 'decodificar'
    return s
  }
  if (s.phase === 'decodificar') {
    s.cycles += 1
    s.message = `DECODIFICAR: la unidad de control interpreta ${formatInstruction(s.ir!)}. ${OP_HELP[s.ir!.op]}`
    s.phase = 'ejecutar'
    return s
  }
  // ejecutar
  const { op, arg } = s.ir!
  s.cycles += 1
  const read = (cell: number) => {
    const { cost, note } = memoryCost(s, cell)
    s.cycles += cost - 1
    s.touched = { cell, kind: 'read' }
    const v = s.memory[cell]
    return { value: typeof v === 'number' ? v : 0, note }
  }
  switch (op) {
    case 'LOAD': {
      const { value, note } = read(arg!)
      s.acc = value
      s.changed = 'acc'
      s.message = `EJECUTAR: ACC ← celda ${arg} = ${value} (${note}).`
      break
    }
    case 'ADD':
    case 'SUB': {
      const { value, note } = read(arg!)
      const before = s.acc
      s.acc = op === 'ADD' ? s.acc + value : s.acc - value
      s.changed = 'acc'
      s.message = `EJECUTAR: la ALU calcula ${before} ${op === 'ADD' ? '+' : '−'} ${value} = ${s.acc} (${note}).`
      break
    }
    case 'STORE': {
      const { cost } = memoryCost(s, arg!)
      s.cycles += cost - 1
      s.memory[arg!] = s.acc
      s.touched = { cell: arg!, kind: 'write' }
      s.message = `EJECUTAR: se escribe ${s.acc} en la celda ${arg}.`
      break
    }
    case 'JMP':
      s.pc = arg!
      s.changed = 'pc'
      s.message = `EJECUTAR: salto incondicional; el PC pasa a ${arg}.`
      break
    case 'JZ':
      if (s.acc === 0) {
        s.pc = arg!
        s.changed = 'pc'
        s.message = `EJECUTAR: el ACC vale 0, así que salta a la celda ${arg}.`
      } else s.message = `EJECUTAR: el ACC vale ${s.acc} (no es 0): no salta y sigue en la celda ${s.pc}.`
      break
    case 'OUT':
      s.output.push(s.acc)
      s.message = `EJECUTAR: se muestra el valor del ACC: ${s.acc}.`
      break
    case 'HLT':
      s.halted = true
      s.message = 'EJECUTAR: fin del programa.'
      break
  }
  s.phase = 'buscar'
  return s
}

/** Ejecuta hasta el final (con un límite para no colgarse si el programa tiene un bucle infinito). */
export function runToEnd(s: CpuState, maxSteps = 1000): CpuState {
  let cur = s
  for (let i = 0; i < maxSteps && !cur.halted; i++) cur = stepCpu(cur)
  return cur
}
