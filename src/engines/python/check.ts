/**
 * Revisión de los ejercicios de Python en Node (npm run validar y pruebas): corre la solución de
 * cada paso con Pyodide y confirma que pasa sus verificaciones, y que el código inicial no las pasa ya.
 */
import type { PythonExercise } from '@/content/exercise-schemas'
import type { ExerciseProblem } from '../exercise-check'
import { runChecks, runProgram, type PyLike } from './runner'

let cached: Promise<PyLike> | undefined

/** Pyodide cargado una sola vez por proceso. */
export function nodePyodide(): Promise<PyLike> {
  cached ??= import('pyodide').then(async (m) => (await m.loadPyodide()) as unknown as PyLike)
  return cached
}

/** Corre un programa y sus verificaciones (para las pruebas). */
export async function evaluar(ex: PythonExercise, paso: number, code: string) {
  const py = await nodePyodide()
  const { result, ns } = await runProgram(py, ex, code)
  const checks = await runChecks(py, ex, ns, result, code, ex.pasos[paso].verificar)
  return { result, checks }
}

export async function checkPythonExercise(ex: PythonExercise): Promise<ExerciseProblem[]> {
  const problems: ExerciseProblem[] = []
  for (let i = 0; i < ex.pasos.length; i++) {
    const p = ex.pasos[i]
    const { result, checks } = await evaluar(ex, i, p.solucion)
    const fallan = checks.filter((c) => !c.ok)
    if (fallan.length)
      problems.push({
        level: 'error',
        message: `paso ${i + 1}: la solución no pasa ${fallan.map((c) => `"${c.label}"${c.detalle ? ` (${c.detalle})` : ''}`).join(', ')}${result.error ? `\n${result.error}` : ''}`,
      })
  }
  if (ex.codigo_inicial.trim()) {
    const { checks } = await evaluar(ex, 0, ex.codigo_inicial)
    if (checks.every((c) => c.ok)) problems.push({ level: 'warning', message: 'el código inicial ya pasa el paso 1' })
  }
  return problems
}
