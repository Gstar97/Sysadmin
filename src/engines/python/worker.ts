/// <reference lib="webworker" />
/**
 * Worker que corre Python (Pyodide) fuera de la página: así un programa largo o un bucle infinito
 * no congela la pantalla, y se puede cortar terminando el worker.
 */
import type { PythonCheck } from '@/content/exercise-schemas'
import { runChecks, runProgram, type PyLike, type Setup } from './runner'

export type WorkerRequest = { id: number; tipo: 'run'; setup: Setup; code: string; checks: PythonCheck[] } | { id: number; tipo: 'load' }

export type WorkerResponse =
  | { id: number; tipo: 'ready'; version: string }
  | { id: number; tipo: 'out'; stream: 'out' | 'err'; text: string }
  | { id: number; tipo: 'done'; result: import('./runner').RunResult; checks: import('./runner').CheckResult[] }
  | { id: number; tipo: 'fail'; message: string }

declare const self: DedicatedWorkerGlobalScope

let loading: Promise<PyLike> | undefined

function load() {
  loading ??= (async () => {
    const base = `${import.meta.env.BASE_URL}pyodide/`
    const mod = (await import(/* @vite-ignore */ `${base}pyodide.mjs`)) as { loadPyodide(o: { indexURL: string }): Promise<PyLike> }
    return mod.loadPyodide({ indexURL: base })
  })()
  return loading
}

let queue = Promise.resolve()

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  queue = queue.then(async () => {
    try {
      const py = await load()
      if (msg.tipo === 'load') {
        self.postMessage({ id: msg.id, tipo: 'ready', version: String(py.runPython('import sys\nsys.version.split()[0]')) } satisfies WorkerResponse)
        return
      }
      const { result, ns } = await runProgram(py, msg.setup, msg.code, (stream, text) => self.postMessage({ id: msg.id, tipo: 'out', stream, text } satisfies WorkerResponse))
      const checks = await runChecks(py, msg.setup, ns, result, msg.code, msg.checks)
      ;(ns as { destroy?(): void }).destroy?.()
      self.postMessage({ id: msg.id, tipo: 'done', result, checks } satisfies WorkerResponse)
    } catch (err) {
      self.postMessage({ id: msg.id, tipo: 'fail', message: String((err as Error).message ?? err) } satisfies WorkerResponse)
    }
  })
}
