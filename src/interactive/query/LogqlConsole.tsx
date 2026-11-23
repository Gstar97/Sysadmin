import { useMemo } from 'react'
import type { LogqlExercise } from '@/content/exercise-schemas'
import { graphLogql, logDbFor, runLogql } from '@/engines/logs/exercise'
import { labelValues } from '@/engines/logs/logdb'
import { QueryConsole, type QueryAdapter } from './QueryConsole'

/** Consola de LogQL sobre los logs de ejemplo de un ejercicio (con o sin pasos). */
export function LogqlConsole({ exercise }: { exercise: LogqlExercise }) {
  const adapter = useMemo<QueryAdapter>(() => {
    const db = logDbFor(exercise.logs)
    return {
      lang: 'LogQL',
      run: (q) => runLogql(db, q),
      graph: (q) => graphLogql(db, q),
      names: labelValues(db),
      now: db.end,
      start: db.start,
      end: db.end,
      step: 60,
      placeholder: 'Por ejemplo: {job="nginx"} |= "500"',
    }
  }, [exercise])
  return <QueryConsole adapter={adapter} titulo={exercise.titulo} descripcion={exercise.descripcion} inicial={exercise.consulta_inicial} pasos={exercise.pasos} />
}
