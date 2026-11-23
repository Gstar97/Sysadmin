/** Correr una consulta de LogQL para la consola y validar los ejercicios. */
import type { LogqlExercise } from '@/content/exercise-schemas'
import { evaluateQueryChecks, type QueryOutcome } from '../query/checks'
import type { ExerciseProblem } from '../metrics/exercise'
import { buildLogDb, type LogDb, type LogScenario } from './logdb'
import { evalMetric, LogQLError, metricRange, parseLogQL, queryLogs, usedFeatures } from './logql'

const cache = new WeakMap<object, LogDb>()

export function logDbFor(sc: LogScenario): LogDb {
  let db = cache.get(sc)
  if (!db) cache.set(sc, (db = buildLogDb(sc)))
  return db
}

const message = (e: unknown) => (e instanceof LogQLError ? e.message : `error: ${(e as Error).message}`)

export function runLogql(db: LogDb, query: string): QueryOutcome {
  const q = query.trim()
  let uses = new Set<string>()
  try {
    const p = parseLogQL(q)
    uses = usedFeatures(p)
    if (p.k === 'log') {
      const r = queryLogs(db, p.expr)
      return { kind: 'lineas', series: r.streams.map((labels) => ({ labels })), lines: r.lines, uses, query: q }
    }
    const v = evalMetric(db, p.expr, db.end)
    if (typeof v === 'number') return { kind: 'escalar', series: [{ labels: {}, value: v }], uses, query: q }
    return { kind: 'vector', series: v.map((s) => ({ labels: s.labels, value: s.v })), uses, query: q }
  } catch (e) {
    return { error: message(e), series: [], uses, query: q }
  }
}

export function graphLogql(db: LogDb, query: string) {
  try {
    const p = parseLogQL(query.trim())
    if (p.k === 'log') return undefined
    return metricRange(db, p.expr)
  } catch (e) {
    return { error: message(e) }
  }
}

export function checkLogqlExercise(ex: LogqlExercise): ExerciseProblem[] {
  const problems: ExerciseProblem[] = []
  let db: LogDb
  try {
    db = buildLogDb(ex.logs)
  } catch (e) {
    return [{ level: 'error', message: `los logs de ejemplo no se pudieron armar: ${(e as Error).message}` }]
  }
  if (!db.streams.length) problems.push({ level: 'error', message: 'los logs de ejemplo no tienen ninguna línea' })
  ex.pasos.forEach((p, i) => {
    const o = runLogql(db, p.solucion)
    if (o.error) {
      problems.push({ level: 'error', message: `la solución del paso ${i + 1} da error: ${o.error}` })
      return
    }
    evaluateQueryChecks(o, p.verificar).forEach((r, j) => {
      if (!r.ok) problems.push({ level: 'error', message: `el paso ${i + 1} no se cumple con su solución: verificación ${j + 1} (${JSON.stringify(p.verificar[j])})${r.detalle ? `: ${r.detalle}` : ''}` })
    })
  })
  return problems
}
