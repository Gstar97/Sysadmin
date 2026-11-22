/** Correr una consulta de PromQL para la consola y validar los ejercicios. */
import type { PromqlExercise } from '@/content/exercise-schemas'
import { evaluateQueryChecks, type QueryOutcome } from '../query/checks'
import { instantQuery, parse, PromQLError, usedFunctions } from './promql'
import { buildTsdb, type Scenario, type Tsdb } from './tsdb'

const cache = new WeakMap<object, Tsdb>()

/** La base de series de un escenario (se arma una vez por escenario). */
export function tsdbFor(sc: Scenario): Tsdb {
  let db = cache.get(sc)
  if (!db) cache.set(sc, (db = buildTsdb(sc)))
  return db
}

export function runPromql(db: Tsdb, query: string): QueryOutcome {
  const q = query.trim()
  let uses = new Set<string>()
  try {
    uses = usedFunctions(parse(q))
    const r = instantQuery(db, q)
    const v = r.value
    if (v.type === 'scalar') return { kind: 'escalar', series: [{ labels: {}, value: v.v }], uses, query: q }
    if (v.type === 'string') return { kind: 'texto', series: [], uses, query: q }
    if (v.type === 'vector') return { kind: 'vector', series: v.v.map((s) => ({ labels: s.labels, value: s.v })), uses, query: q }
    return { kind: 'matriz', series: v.v.map((s) => ({ labels: s.labels, value: s.samples.at(-1)?.v })), uses, query: q }
  } catch (e) {
    return { error: e instanceof PromQLError ? e.message : `error: ${(e as Error).message}`, series: [], uses, query: q }
  }
}

export interface ExerciseProblem {
  level: 'error' | 'warning'
  message: string
}

/** Cada solución cumple su paso, y una consulta vacía no cumple ninguno. */
export function checkPromqlExercise(ex: PromqlExercise): ExerciseProblem[] {
  const problems: ExerciseProblem[] = []
  let db: Tsdb
  try {
    db = buildTsdb(ex.metricas)
  } catch (e) {
    return [{ level: 'error', message: `el escenario de métricas no se pudo armar: ${(e as Error).message}` }]
  }
  if (!db.series.length) problems.push({ level: 'error', message: 'el escenario no tiene ninguna serie' })
  ex.pasos.forEach((p, i) => {
    const o = runPromql(db, p.solucion)
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
