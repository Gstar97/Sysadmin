import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { exerciseSchemas } from '@/content/exercise-schemas'
import { checkConfigExercise, checkTerminalExercise, checkTopologyExercise } from '@/engines/exercise-check'
import { optimalPath } from '@/interactive/troubleshooting/Troubleshooting'

const dir = 'src/app/pages/gallery/demos'
const demos = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.yaml') && f !== 'preguntas.yaml')
  .map((f) => ({ file: f, data: parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { tipo: keyof typeof exerciseSchemas } }))

describe('ejercicios de la galería', () => {
  it.each(demos)('$file cumple su esquema', ({ data }) => {
    const r = exerciseSchemas[data.tipo].safeParse(data)
    expect(r.success, r.success ? '' : JSON.stringify(r.error.issues)).toBe(true)
  })

  it.each(demos.filter((d) => d.data.tipo === 'terminal'))('$file se resuelve con su solución de referencia', async ({ data }) => {
    const problems = await checkTerminalExercise(exerciseSchemas.terminal.parse(data))
    expect(problems.filter((p) => p.level === 'error')).toEqual([])
  })

  it.each(demos.filter((d) => d.data.tipo === 'configuracion'))('$file: la solución cumple las reglas y el original no', ({ data }) => {
    expect(checkConfigExercise(exerciseSchemas.configuracion.parse(data))).toEqual([])
  })

  it('la topología no tiene referencias rotas', () => {
    const d = demos.find((x) => x.data.tipo === 'topologia')!
    expect(checkTopologyExercise(exerciseSchemas.topologia.parse(d.data))).toEqual([])
  })

  it('el troubleshooting tiene un camino óptimo que valida antes de reiniciar', () => {
    const d = demos.find((x) => x.data.tipo === 'troubleshooting')!
    const best = optimalPath(exerciseSchemas.troubleshooting.parse(d.data))!
    expect(best.path).toEqual(['n1', 'n2', 'n3', 'n_valid', 'n_check', 'fin_ok'])
    expect(best.minutes).toBe(11)
  })
})
