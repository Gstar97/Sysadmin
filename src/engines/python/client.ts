/**
 * Lado de la página de la consola de Python: un único worker compartido, que se carga la primera
 * vez que hace falta y se reemplaza si un programa se pasa del tiempo límite.
 */
import type { PythonCheck } from '@/content/exercise-schemas'
import type { CheckResult, RunResult, Setup } from './runner'
import type { WorkerRequest, WorkerResponse } from './worker'

type SinId<T> = T extends unknown ? Omit<T, 'id'> : never

type Pending = { onOut?: (stream: 'out' | 'err', text: string) => void; resolve(v: WorkerResponse): void }

let worker: Worker | undefined
let ready: Promise<string> | undefined
let nextId = 1
const pending = new Map<number, Pending>()

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const m = e.data
    const p = pending.get(m.id)
    if (!p) return
    if (m.tipo === 'out') p.onOut?.(m.stream, m.text)
    else {
      pending.delete(m.id)
      p.resolve(m)
    }
  }
  worker.onerror = (e) => {
    for (const [id, p] of pending) p.resolve({ id, tipo: 'fail', message: e.message || 'No se pudo iniciar Python en el navegador.' })
    pending.clear()
  }
  return worker
}

function send(req: SinId<WorkerRequest>, onOut?: Pending['onOut']): { id: number; done: Promise<WorkerResponse> } {
  const id = nextId++
  const done = new Promise<WorkerResponse>((resolve) => pending.set(id, { resolve, onOut }))
  getWorker().postMessage({ ...req, id } as WorkerRequest)
  return { id, done }
}

/** Carga Python (unos 13 MB la primera vez; después queda en la caché del navegador). Devuelve la versión. */
export function loadPython(): Promise<string> {
  ready ??= send({ tipo: 'load' }).done.then((r) => {
    if (r.tipo === 'ready') return r.version
    ready = undefined
    throw new Error(r.tipo === 'fail' ? r.message : 'No se pudo cargar Python.')
  })
  return ready
}

function reset() {
  worker?.terminate()
  worker = undefined
  ready = undefined
  for (const [id, p] of pending) p.resolve({ id, tipo: 'fail', message: 'cancelado' })
  pending.clear()
}

export type RunOutcome = { tipo: 'ok'; result: RunResult; checks: CheckResult[] } | { tipo: 'timeout'; segundos: number } | { tipo: 'fail'; message: string }

/** Corre un programa con un tiempo límite; si se pasa, corta el worker (y el próximo arranca de cero). */
export async function runPython(setup: Setup, code: string, checks: PythonCheck[], onOut: (stream: 'out' | 'err', text: string) => void, segundos = 10): Promise<RunOutcome> {
  await loadPython()
  const { done } = send({ tipo: 'run', setup, code, checks }, onOut)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<RunOutcome>((resolve) => {
    timer = setTimeout(() => {
      reset()
      resolve({ tipo: 'timeout', segundos })
    }, segundos * 1000)
  })
  const r = await Promise.race([done.then((m): RunOutcome => (m.tipo === 'done' ? { tipo: 'ok', result: m.result, checks: m.checks } : { tipo: 'fail', message: m.tipo === 'fail' ? m.message : 'respuesta inesperada' })), timeout])
  clearTimeout(timer)
  return r
}
