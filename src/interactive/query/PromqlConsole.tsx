import { useMemo } from 'react'
import type { PromqlExercise } from '@/content/exercise-schemas'
import { runPromql, tsdbFor } from '@/engines/metrics/exercise'
import { PromQLError, rangeQuery } from '@/engines/metrics/promql'
import { metricNames } from '@/engines/metrics/tsdb'
import { QueryConsole, type QueryAdapter } from './QueryConsole'

/** Consola de PromQL sobre las métricas de ejemplo de un ejercicio (con o sin pasos). */
export function PromqlConsole({ exercise }: { exercise: PromqlExercise }) {
  const adapter = useMemo<QueryAdapter>(() => {
    const db = tsdbFor(exercise.metricas)
    return {
      lang: 'PromQL',
      run: (q) => runPromql(db, q),
      graph: (q) => {
        try {
          return rangeQuery(db, q.trim())
        } catch (e) {
          return { error: e instanceof PromQLError ? e.message : (e as Error).message }
        }
      },
      names: metricNames(db),
      now: db.end,
      start: db.start,
      end: db.end,
      step: db.step,
      placeholder: 'Por ejemplo: rate(node_cpu_seconds_total{mode="idle"}[5m])',
    }
  }, [exercise])
  return <QueryConsole adapter={adapter} titulo={exercise.titulo} descripcion={exercise.descripcion} inicial={exercise.consulta_inicial} pasos={exercise.pasos} />
}
