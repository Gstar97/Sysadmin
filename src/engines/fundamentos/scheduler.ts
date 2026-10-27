/** Planificador de CPU: FCFS, turnos rotativos (Round Robin) y prioridades con expropiación. */

export interface Proc {
  id: string
  llegada: number
  rafaga: number
  /** 1 = la más alta. */
  prioridad: number
}

export type Algorithm = 'fcfs' | 'rr' | 'prioridad'

export interface Segment {
  id: string | null
  start: number
  end: number
}

export interface ProcResult extends Proc {
  inicio: number
  fin: number
  espera: number
  retorno: number
  respuesta: number
}

export interface Schedule {
  segments: Segment[]
  results: ProcResult[]
  cambiosDeContexto: number
  esperaPromedio: number
  retornoPromedio: number
  respuestaPromedio: number
}

export function schedule(procs: Proc[], algorithm: Algorithm, quantum = 2): Schedule {
  const remaining = new Map(procs.map((p) => [p.id, p.rafaga]))
  const firstRun = new Map<string, number>()
  const finish = new Map<string, number>()
  const segments: Segment[] = []
  const sorted = [...procs].sort((a, b) => a.llegada - b.llegada || a.id.localeCompare(b.id))
  let time = 0
  let current: string | null = null
  let sliceUsed = 0
  const queue: string[] = []
  let nextArrival = 0
  const total = procs.reduce((s, p) => s + p.rafaga, 0)
  let guard = 0

  const admit = () => {
    while (nextArrival < sorted.length && sorted[nextArrival].llegada <= time) queue.push(sorted[nextArrival++].id)
  }
  const push = (id: string | null, from: number, to: number) => {
    const last = segments[segments.length - 1]
    if (last && last.id === id && last.end === from) last.end = to
    else segments.push({ id, start: from, end: to })
  }

  admit()
  while ([...finish.keys()].length < procs.length && guard++ < total * 4 + 1000) {
    // Elegir proceso
    if (algorithm === 'prioridad') {
      const ready: string[] = [...queue, ...(current ? [current] : [])]
      if (ready.length) {
        const pr = (id: string) => procs.find((p) => p.id === id)!.prioridad
        const best: string = ready.sort((a: string, b: string) => pr(a) - pr(b) || procs.findIndex((p) => p.id === a) - procs.findIndex((p) => p.id === b))[0]
        if (best !== current) {
          if (current) queue.push(current)
          queue.splice(queue.indexOf(best), 1)
          current = best
        }
      }
    } else if (!current && queue.length) {
      current = queue.shift()!
      sliceUsed = 0
    }
    if (!current) {
      // CPU ociosa hasta la próxima llegada
      const nextT = sorted[nextArrival]?.llegada ?? time + 1
      push(null, time, nextT)
      time = nextT
      admit()
      continue
    }
    if (!firstRun.has(current)) firstRun.set(current, time)
    push(current, time, time + 1)
    time++
    sliceUsed++
    remaining.set(current, remaining.get(current)! - 1)
    admit()
    if (remaining.get(current) === 0) {
      finish.set(current, time)
      current = null
      sliceUsed = 0
    } else if (algorithm === 'rr' && sliceUsed >= quantum) {
      queue.push(current)
      current = null
      sliceUsed = 0
    }
  }

  const results: ProcResult[] = procs.map((p) => {
    const fin = finish.get(p.id) ?? time
    const retorno = fin - p.llegada
    return { ...p, inicio: firstRun.get(p.id) ?? 0, fin, retorno, espera: retorno - p.rafaga, respuesta: (firstRun.get(p.id) ?? 0) - p.llegada }
  })
  const busy = segments.filter((s) => s.id)
  let cambios = 0
  for (let i = 1; i < busy.length; i++) if (busy[i].id !== busy[i - 1].id) cambios++
  const avg = (k: 'espera' | 'retorno' | 'respuesta') => results.reduce((s, r) => s + r[k], 0) / Math.max(1, results.length)
  return { segments, results, cambiosDeContexto: cambios, esperaPromedio: avg('espera'), retornoPromedio: avg('retorno'), respuestaPromedio: avg('respuesta') }
}
