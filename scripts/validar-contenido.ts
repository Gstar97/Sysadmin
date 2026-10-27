/**
 * Valida todo el contenido de la carrera: esquemas, bloques obligatorios de cada lección,
 * referencias, texto de relleno y que los ejercicios tengan solución.
 * Uso: npm run validar   (o CONTENT_DIR=otra/carpeta npm run validar)
 */
import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { scanContent } from '../build/content-scan'
import { configExerciseSchema, terminalExerciseSchema } from '../src/content/exercise-schemas'
import { checkConfigExercise, checkTerminalExercise, checkTopologyExercise, type ExerciseProblem } from '../src/engines/exercise-check'
import { topologyExerciseSchema } from '../src/engines/network/schema'

const contentDir = path.resolve(process.env.CONTENT_DIR ?? 'content')
const color = process.stdout.isTTY ? (c: number, t: string) => `\x1b[${c}m${t}\x1b[0m` : (_: number, t: string) => t

function yamlFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return yamlFiles(p)
    return /\.ya?ml$/.test(e.name) && !['nivel.yaml', 'modulo.yaml', 'preguntas.yaml', 'tarjetas.yaml'].includes(e.name) ? [p] : []
  })
}

async function main() {
  const res = scanContent(contentDir)
  const errors = [...res.errors]
  const warnings = [...res.warnings]

  for (const file of yamlFiles(path.join(contentDir, 'niveles'))) {
    const relFile = path.relative(contentDir, file)
    let data: { tipo?: string } | null
    try {
      data = parse(fs.readFileSync(file, 'utf8'))
    } catch {
      continue // el escáner ya informó el error de sintaxis
    }
    let problems: ExerciseProblem[] = []
    if (data?.tipo === 'terminal') {
      const ex = terminalExerciseSchema.safeParse(data)
      if (ex.success) problems = await checkTerminalExercise(ex.data)
    } else if (data?.tipo === 'configuracion') {
      const ex = configExerciseSchema.safeParse(data)
      if (ex.success) problems = checkConfigExercise(ex.data)
    } else if (data?.tipo === 'topologia') {
      const ex = topologyExerciseSchema.safeParse(data)
      if (ex.success) problems = checkTopologyExercise(ex.data)
    }
    for (const p of problems) (p.level === 'error' ? errors : warnings).push(`${relFile}: ${p.message}`)
  }

  const levels = res.index.levels
  const modules = levels.flatMap((l) => l.modules)
  const lessons = modules.flatMap((m) => m.lessons)
  const planned = modules.reduce((s, m) => s + m.planned.length, 0)
  console.log(`Contenido en ${path.relative(process.cwd(), contentDir) || '.'}: ${levels.length} niveles, ${modules.length} módulos, ${lessons.length} lecciones publicadas y ${planned} planificadas.`)
  for (const w of warnings) console.log(color(33, `aviso: ${w}`))
  for (const e of errors) console.log(color(31, `error: ${e}`))
  if (errors.length) {
    console.log(color(31, `\n${errors.length} ${errors.length === 1 ? 'error' : 'errores'}: corrígelos antes de compilar.`))
    process.exit(1)
  }
  console.log(color(32, `Todo en orden${warnings.length ? ` (${warnings.length} ${warnings.length === 1 ? 'aviso' : 'avisos'})` : ''}.`))
}

void main()
