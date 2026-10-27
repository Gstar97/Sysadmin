/**
 * Recorre la carpeta de contenido, valida cada archivo y arma el índice de la carrera.
 * Lo usan el plugin de Vite (al compilar y en desarrollo) y el script "npm run validar".
 */
import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { DIAGRAM_COMPONENTS, INTERACTIVE_COMPONENTS, REQUIRED_BLOCKS } from '../src/content/component-names'
import { exerciseSchemas, troubleshootingSchema } from '../src/content/exercise-schemas'
import {
  careerSchema,
  flashcardDeckSchema,
  glossarySchema,
  labFrontmatterSchema,
  lessonFrontmatterSchema,
  levelSchema,
  moduleSchema,
  projectFrontmatterSchema,
  questionBankSchema,
  type GlossaryEntry,
} from '../src/content/schemas'
import type { ContentIndex, LessonEntry, LevelEntry, ModuleEntry, SearchDoc } from '../src/content/types'
import { slugify } from '../src/lib/slug'

// Mensajes de validación en español (solo del lado de Node, para no sumar peso a la aplicación).
z.config(z.locales.es())

export interface ScanResult {
  index: ContentIndex
  searchDocs: SearchDoc[]
  errors: string[]
  warnings: string[]
  /** Archivos MDX de lecciones con su cuerpo, para validaciones extra. */
  lessonsBodies: { id: string; file: string; body: string }[]
}

export const MIN_QUESTIONS = 8
export const MAX_QUESTIONS = 15
const HORAS_EXAMEN = 1
const RELLENO = [/lorem|ipsum|contenido pendiente|por completar/i, /\b(TODO|FIXME|TBD)\b/]

const DEFAULT_CAREER = {
  nombre: 'Carrera Sysadmin',
  descripcion: 'Carrera completa de administración de servidores e infraestructura.',
}

function rel(root: string, file: string) {
  return path.relative(root, file).split(path.sep).join('/')
}

function listDirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('_'))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, 'es', { numeric: true }))
}

export function splitFrontmatter(source: string): { data: unknown; body: string; error?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source)
  if (!m) return { data: undefined, body: source, error: 'Falta el bloque de metadatos (frontmatter) entre ---' }
  try {
    return { data: parseYaml(m[1]), body: source.slice(m[0].length) }
  } catch (e) {
    return { data: undefined, body: source.slice(m[0].length), error: `YAML inválido en metadatos: ${(e as Error).message}` }
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => {
      const ruta = i.path.length ? i.path.join('.') : '(raíz)'
      return `    - ${ruta}: ${i.message}`
    })
    .join('\n')
}

/** Quita marcas de Markdown inline para indexar o mostrar texto plano. */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim()
}

/** Convierte el cuerpo MDX en secciones de texto plano (una por título ## o ###). */
export function mdxToSections(body: string): { titulo: string; slug: string; nivel: number; texto: string }[] {
  const lines = body.split(/\r?\n/)
  const sections: { titulo: string; slug: string; nivel: number; texto: string }[] = []
  let current = { titulo: '', slug: '', nivel: 1, texto: '' }
  let inFence = false
  for (const raw of lines) {
    const line = raw
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (!inFence) {
      if (/^(import|export)\s/.test(line)) continue
      const h = /^(#{2,3})\s+(.*)$/.exec(line)
      if (h) {
        sections.push(current)
        const titulo = stripInlineMarkdown(h[2])
        current = { titulo, slug: slugify(titulo), nivel: h[1].length, texto: '' }
        continue
      }
    }
    const plain = inFence
      ? line
      : stripInlineMarkdown(
          line
            .replace(/<[A-Za-z][^<>]*\/>/g, ' ')
            .replace(/<\/?[A-Za-z][^<>]*>/g, ' ')
            .replace(/^\s*[-*>]\s+/, '')
            .replace(/^\s*\d+\.\s+/, ''),
        )
    if (plain.trim()) current.texto += plain.trim() + ' '
  }
  sections.push(current)
  return sections.filter((s) => s.titulo || s.texto.trim())
}

function readYamlFile(file: string): { data?: unknown; error?: string } {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return { data: parseYaml(text, { prettyErrors: true }) }
  } catch (e) {
    return { error: `YAML inválido: ${(e as Error).message}` }
  }
}

export function scanContent(contentDir: string): ScanResult {
  const errors: string[] = []
  const warnings: string[] = []
  const searchDocs: SearchDoc[] = []
  const lessonsBodies: ScanResult['lessonsBodies'] = []
  const root = path.resolve(contentDir)
  const err = (file: string, msg: string) => errors.push(`${rel(root, file)}: ${msg}`)
  const warn = (file: string, msg: string) => warnings.push(`${rel(root, file)}: ${msg}`)

  function parseWith<T extends z.ZodType>(schema: T, data: unknown, file: string): z.infer<T> | undefined {
    const r = schema.safeParse(data)
    if (!r.success) {
      err(file, `no cumple el formato esperado:\n${formatZodError(r.error)}`)
      return undefined
    }
    return r.data
  }

  function checkFiller(file: string, text: string) {
    if (RELLENO.some((r) => r.test(text))) err(file, 'contiene texto de relleno o marcas de contenido pendiente')
  }

  function validateExerciseFiles(dir: string, skip: string[]) {
    for (const name of fs.readdirSync(dir)) {
      if (!/\.ya?ml$/.test(name) || skip.includes(name)) continue
      const file = path.join(dir, name)
      const { data, error } = readYamlFile(file)
      if (error) {
        err(file, error)
        continue
      }
      const tipo = (data as { tipo?: string } | null)?.tipo
      if (!tipo) {
        err(file, 'falta el campo "tipo" (terminal, topologia, paquetes, diagrama, ordenar, emparejar, troubleshooting o configuracion)')
        continue
      }
      const schema = exerciseSchemas[tipo as keyof typeof exerciseSchemas]
      if (!schema) {
        err(file, `tipo de ejercicio desconocido: "${tipo}"`)
        continue
      }
      parseWith(schema, data, file)
      checkFiller(file, fs.readFileSync(file, 'utf8'))
    }
  }

  // Carrera y glosario
  let career = DEFAULT_CAREER
  const careerFile = path.join(root, 'carrera.yaml')
  if (fs.existsSync(careerFile)) {
    const { data, error } = readYamlFile(careerFile)
    if (error) err(careerFile, error)
    else career = parseWith(careerSchema, data, careerFile) ?? DEFAULT_CAREER
  } else {
    errors.push('Falta el archivo carrera.yaml en la carpeta de contenido')
  }

  let glossary: GlossaryEntry[] = []
  const glossaryFile = path.join(root, 'glosario.yaml')
  if (fs.existsSync(glossaryFile)) {
    const { data, error } = readYamlFile(glossaryFile)
    if (error) err(glossaryFile, error)
    else glossary = parseWith(glossarySchema, data ?? [], glossaryFile) ?? []
  }

  const levels: LevelEntry[] = []
  const ids = new Map<string, string>()
  const registerId = (id: string, file: string) => {
    if (ids.has(id)) err(file, `el id "${id}" ya se usa en ${ids.get(id)}`)
    else ids.set(id, rel(root, file))
  }

  const nivelesDir = path.join(root, 'niveles')
  for (const levelFolder of listDirs(nivelesDir)) {
    const levelDir = path.join(nivelesDir, levelFolder)
    const levelFile = path.join(levelDir, 'nivel.yaml')
    if (!fs.existsSync(levelFile)) {
      warn(levelDir, 'carpeta sin nivel.yaml; se ignora')
      continue
    }
    const { data: levelData, error: levelError } = readYamlFile(levelFile)
    if (levelError) {
      err(levelFile, levelError)
      continue
    }
    const level = parseWith(levelSchema, levelData, levelFile)
    if (!level) continue
    registerId(level.id, levelFile)

    let proyecto: LevelEntry['proyecto']
    const projectFile = path.join(levelDir, 'proyecto.mdx')
    if (fs.existsSync(projectFile)) {
      const source = fs.readFileSync(projectFile, 'utf8')
      const fm = splitFrontmatter(source)
      if (fm.error) err(projectFile, fm.error)
      const p = parseWith(projectFrontmatterSchema, fm.data, projectFile)
      checkFiller(projectFile, source)
      if (p) proyecto = { titulo: p.titulo, horas: p.horas, entregables: p.entregables, publicado: true }
    } else if (level.proyecto_plan) {
      proyecto = { ...level.proyecto_plan, publicado: false }
    }

    const levelEntry: LevelEntry = {
      id: level.id,
      path: rel(root, levelDir),
      numero: Number(level.id.slice(1)),
      titulo: level.titulo,
      descripcion: level.descripcion,
      perfil_salida: level.perfil_salida,
      insignia: level.insignia,
      proyecto,
      modules: [],
    }

    for (const moduleFolder of listDirs(levelDir)) {
      const moduleDir = path.join(levelDir, moduleFolder)
      const moduleFile = path.join(moduleDir, 'modulo.yaml')
      if (!fs.existsSync(moduleFile)) {
        warn(moduleDir, 'carpeta sin modulo.yaml; se ignora')
        continue
      }
      const { data: moduleData, error: moduleError } = readYamlFile(moduleFile)
      if (moduleError) {
        err(moduleFile, moduleError)
        continue
      }
      const mod = parseWith(moduleSchema, moduleData, moduleFile)
      if (!mod) continue
      registerId(mod.id, moduleFile)
      if (!mod.id.startsWith(`${level.id}-`)) err(moduleFile, `el id "${mod.id}" no pertenece al nivel ${level.id}`)

      let lab: ModuleEntry['lab']
      const labFile = path.join(moduleDir, 'laboratorio.mdx')
      if (fs.existsSync(labFile)) {
        const source = fs.readFileSync(labFile, 'utf8')
        const fm = splitFrontmatter(source)
        if (fm.error) err(labFile, fm.error)
        const l = parseWith(labFrontmatterSchema, fm.data, labFile)
        checkFiller(labFile, source)
        if (l) lab = { ...l, publicado: true }
      } else if (mod.laboratorio_plan) {
        lab = { ...mod.laboratorio_plan, verificacion: [], publicado: false }
      }

      let caso: ModuleEntry['caso']
      const caseFile = path.join(moduleDir, 'caso-real.yaml')
      if (fs.existsSync(caseFile)) {
        const { data, error } = readYamlFile(caseFile)
        if (error) err(caseFile, error)
        else {
          const c = parseWith(troubleshootingSchema, data, caseFile)
          checkFiller(caseFile, fs.readFileSync(caseFile, 'utf8'))
          if (c) caso = { titulo: c.titulo, horas: mod.caso_plan?.horas ?? 1.5, publicado: true }
        }
      } else if (mod.caso_plan) {
        caso = { ...mod.caso_plan, publicado: false }
      }

      validateExerciseFiles(moduleDir, ['modulo.yaml', 'caso-real.yaml'])

      const lessons: LessonEntry[] = []
      for (const lessonFolder of listDirs(moduleDir)) {
        const lessonDir = path.join(moduleDir, lessonFolder)
        const lessonFile = path.join(lessonDir, 'leccion.mdx')
        if (!fs.existsSync(lessonFile)) {
          warn(lessonDir, 'carpeta sin leccion.mdx; se ignora')
          continue
        }
        const source = fs.readFileSync(lessonFile, 'utf8')
        const fm = splitFrontmatter(source)
        if (fm.error) {
          err(lessonFile, fm.error)
          continue
        }
        const meta = parseWith(lessonFrontmatterSchema, fm.data, lessonFile)
        if (!meta) continue
        registerId(meta.id, lessonFile)
        if (!meta.id.startsWith(`${mod.id}-`)) err(lessonFile, `el id "${meta.id}" no pertenece al módulo ${mod.id}`)
        checkFiller(lessonFile, source)
        lessonsBodies.push({ id: meta.id, file: rel(root, lessonFile), body: fm.body })

        const usa = (nombre: string) => new RegExp(`<${nombre}[\\s/>]`).test(fm.body)
        for (const bloque of REQUIRED_BLOCKS) {
          if (!usa(bloque.componente)) err(lessonFile, `falta ${bloque.descripcion} (<${bloque.componente}>)`)
        }
        if (!DIAGRAM_COMPONENTS.some(usa)) {
          err(lessonFile, `necesita al menos un diagrama (${DIAGRAM_COMPONENTS.map((c) => `<${c}>`).join(', ')})`)
        }
        if (!INTERACTIVE_COMPONENTS.some(usa)) {
          err(lessonFile, 'necesita al menos un elemento interactivo')
        }

        let preguntas = 0
        let diagnosticas = 0
        const bankFile = path.join(lessonDir, 'preguntas.yaml')
        if (!fs.existsSync(bankFile)) err(lessonDir, 'falta preguntas.yaml')
        else {
          const { data, error } = readYamlFile(bankFile)
          if (error) err(bankFile, error)
          else {
            const bank = parseWith(questionBankSchema, data, bankFile)
            checkFiller(bankFile, fs.readFileSync(bankFile, 'utf8'))
            if (bank) {
              preguntas = bank.length
              diagnosticas = bank.filter((q) => q.diagnostico).length
              if (bank.length < MIN_QUESTIONS || bank.length > MAX_QUESTIONS) {
                err(bankFile, `el banco tiene ${bank.length} preguntas; debe tener entre ${MIN_QUESTIONS} y ${MAX_QUESTIONS}`)
              }
              if (diagnosticas === 0) warn(bankFile, 'ninguna pregunta está marcada como apta para el diagnóstico')
            }
          }
        }

        let tarjetas = 0
        const cardsFile = path.join(lessonDir, 'tarjetas.yaml')
        if (!fs.existsSync(cardsFile)) err(lessonDir, 'falta tarjetas.yaml')
        else {
          const { data, error } = readYamlFile(cardsFile)
          if (error) err(cardsFile, error)
          else tarjetas = parseWith(flashcardDeckSchema, data, cardsFile)?.length ?? 0
        }

        validateExerciseFiles(lessonDir, ['preguntas.yaml', 'tarjetas.yaml'])

        const sections = mdxToSections(fm.body)
        const secciones = sections.filter((s) => s.titulo && s.nivel === 2).map((s) => ({ titulo: s.titulo, slug: s.slug }))
        const numero = `${level.id.slice(1)}.${mod.id.split('-m')[1]}.${meta.id.split('-l')[1]}`
        for (const s of sections) {
          searchDocs.push({
            id: `${meta.id}#${s.slug || 'inicio'}`,
            tipo: 'leccion',
            titulo: meta.titulo,
            seccion: s.titulo || undefined,
            texto: s.texto.trim(),
            url: `/leccion/${meta.id}${s.slug ? `#${s.slug}` : ''}`,
          })
        }

        const verificado = new Date(`${meta.verificado}-01T00:00:00Z`)
        const unAnio = 365 * 24 * 3600 * 1000
        if (Date.now() - verificado.getTime() > unAnio) {
          warn(lessonFile, `la verificación de datos de actualidad es de ${meta.verificado} (más de un año)`)
        }

        lessons.push({
          id: meta.id,
          moduleId: mod.id,
          levelId: level.id,
          path: rel(root, lessonDir),
          numero,
          titulo: meta.titulo,
          minutos: meta.minutos,
          objetivos: meta.objetivos,
          glosario: meta.glosario,
          verificado: meta.verificado,
          miniTest: meta.mini_test ?? Math.max(5, Math.min(10, preguntas)),
          preguntas,
          diagnosticas,
          tarjetas,
          secciones,
        })
      }

      const publishedIds = new Set(lessons.map((l) => l.id))
      const planned = mod.plan.filter((p) => !publishedIds.has(p.id))
      const horasLecciones = lessons.reduce((s, l) => s + l.minutos / 60, 0) + planned.reduce((s, p) => s + p.horas, 0)
      const horas = horasLecciones + (lab?.horas ?? 0) + HORAS_EXAMEN + (caso?.horas ?? 0)

      levelEntry.modules.push({
        id: mod.id,
        levelId: level.id,
        path: rel(root, moduleDir),
        numero: `${level.id.slice(1)}.${mod.id.split('-m')[1]}`,
        titulo: mod.titulo,
        descripcion: mod.descripcion,
        requiere: mod.requiere,
        examen: mod.examen,
        lessons,
        planned,
        lab,
        caso,
        horas: Math.round(horas * 10) / 10,
      })
      searchDocs.push({
        id: mod.id,
        tipo: 'modulo',
        titulo: `${level.titulo}: ${mod.titulo}`,
        texto: [mod.descripcion ?? '', ...lessons.map((l) => l.titulo), ...planned.map((p) => p.titulo)].join(' '),
        url: `/modulo/${mod.id}`,
      })
    }
    levels.push(levelEntry)
  }
  levels.sort((a, b) => a.numero - b.numero)

  // Validaciones cruzadas
  const moduleIds = new Set(levels.flatMap((l) => l.modules.map((m) => m.id)))
  const lessonIds = new Set(levels.flatMap((l) => l.modules.flatMap((m) => m.lessons.map((x) => x.id))))
  const plannedIds = new Set(levels.flatMap((l) => l.modules.flatMap((m) => m.planned.map((x) => x.id))))
  for (const level of levels) {
    for (const mod of level.modules) {
      for (const req of mod.requiere) {
        if (!moduleIds.has(req)) errors.push(`${mod.path}/modulo.yaml: requiere "${req}", que no existe`)
        if (req === mod.id) errors.push(`${mod.path}/modulo.yaml: un módulo no puede requerirse a sí mismo`)
      }
    }
  }
  const glossaryIds = new Set(glossary.map((g) => g.id))
  for (const entry of glossary) {
    if (entry.leccion && !lessonIds.has(entry.leccion)) {
      if (plannedIds.has(entry.leccion)) {
        warnings.push(`glosario.yaml: "${entry.id}" apunta a la lección ${entry.leccion}, que todavía no está publicada`)
      } else {
        errors.push(`glosario.yaml: "${entry.id}" apunta a la lección ${entry.leccion}, que no existe`)
      }
    }
    searchDocs.push({
      id: `glosario:${entry.id}`,
      tipo: 'glosario',
      titulo: entry.termino,
      texto: [entry.definicion, ...entry.alias].join(' '),
      url: `/glosario#${entry.id}`,
    })
  }
  for (const level of levels) {
    for (const mod of level.modules) {
      for (const lesson of mod.lessons) {
        for (const term of lesson.glosario) {
          if (!glossaryIds.has(term)) errors.push(`${lesson.path}/leccion.mdx: el término "${term}" no está en glosario.yaml`)
        }
      }
    }
  }
  for (const { file, body } of lessonsBodies) {
    for (const m of body.matchAll(/<Termino\s+id=["']([^"']+)["']/g)) {
      if (!glossaryIds.has(m[1])) errors.push(`${file}: <Termino id="${m[1]}"> no está en glosario.yaml`)
    }
  }

  return {
    index: { career, levels, glossary, problems: { errors, warnings } },
    searchDocs,
    errors,
    warnings,
    lessonsBodies,
  }
}
