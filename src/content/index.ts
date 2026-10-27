import index from 'virtual:content'
import type { ComponentType } from 'react'
import { flashcardDeckSchema, questionBankSchema, type Flashcard, type Question } from './schemas'
import { troubleshootingSchema, type TroubleshootingScenario } from './exercise-schemas'
import type { LessonEntry, LevelEntry, ModuleEntry } from './types'

export type { ContentIndex, LessonEntry, LevelEntry, ModuleEntry, SearchDoc } from './types'

export const content = index

const levelById = new Map<string, LevelEntry>()
const moduleById = new Map<string, ModuleEntry>()
const lessonById = new Map<string, LessonEntry>()
for (const level of index.levels) {
  levelById.set(level.id, level)
  for (const mod of level.modules) {
    moduleById.set(mod.id, mod)
    for (const lesson of mod.lessons) lessonById.set(lesson.id, lesson)
  }
}

/** Todas las lecciones publicadas, en el orden de la carrera. */
export const allLessons: LessonEntry[] = index.levels.flatMap((l) => l.modules.flatMap((m) => m.lessons))
export const allModules: ModuleEntry[] = index.levels.flatMap((l) => l.modules)

export const getLevel = (id: string) => levelById.get(id)
export const getModule = (id: string) => moduleById.get(id)
export const getLesson = (id: string) => lessonById.get(id)

export function lessonNeighbors(id: string): { prev?: LessonEntry; next?: LessonEntry } {
  const i = allLessons.findIndex((l) => l.id === id)
  if (i < 0) return {}
  return { prev: allLessons[i - 1], next: allLessons[i + 1] }
}

export function levelHours(level: LevelEntry): number {
  return level.modules.reduce((s, m) => s + m.horas, 0) + (level.proyecto?.horas ?? 0)
}

export const careerHours = index.levels.reduce((s, l) => s + levelHours(l), 0)

// ---------------------------------------------------------------------------------------
// Carga diferida: cada lección, banco de preguntas y escenario se descarga solo cuando se usa.
// ---------------------------------------------------------------------------------------

type MdxModule = { default: ComponentType<{ components?: Record<string, unknown> }> }

const lessonFiles = import.meta.glob<MdxModule>('@content/niveles/*/*/*/leccion.mdx')
const labFiles = import.meta.glob<MdxModule>('@content/niveles/*/*/laboratorio.mdx')
const projectFiles = import.meta.glob<MdxModule>('@content/niveles/*/proyecto.mdx')
const questionFiles = import.meta.glob<unknown>('@content/niveles/*/*/*/preguntas.yaml', { import: 'default' })
const cardFiles = import.meta.glob<unknown>('@content/niveles/*/*/*/tarjetas.yaml', { import: 'default' })
const caseFiles = import.meta.glob<unknown>('@content/niveles/*/*/caso-real.yaml', { import: 'default' })

function findLoader<T>(files: Record<string, () => Promise<T>>, relPath: string): (() => Promise<T>) | undefined {
  const suffix = `/${relPath}`
  const key = Object.keys(files).find((k) => k.endsWith(suffix))
  return key ? files[key] : undefined
}

export async function loadLessonComponent(lesson: LessonEntry) {
  const loader = findLoader(lessonFiles, `${lesson.path}/leccion.mdx`)
  if (!loader) throw new Error(`No se encontró el archivo de la lección ${lesson.id}`)
  return (await loader()).default
}

export async function loadLabComponent(mod: ModuleEntry) {
  const loader = findLoader(labFiles, `${mod.path}/laboratorio.mdx`)
  return loader ? (await loader()).default : undefined
}

export async function loadProjectComponent(level: LevelEntry) {
  const loader = findLoader(projectFiles, `${level.path}/proyecto.mdx`)
  return loader ? (await loader()).default : undefined
}

const bankCache = new Map<string, Question[]>()

export async function loadQuestionBank(lesson: LessonEntry): Promise<Question[]> {
  const cached = bankCache.get(lesson.id)
  if (cached) return cached
  const loader = findLoader(questionFiles, `${lesson.path}/preguntas.yaml`)
  const bank = loader ? questionBankSchema.parse(await loader()) : []
  bankCache.set(lesson.id, bank)
  return bank
}

export async function loadFlashcards(lesson: LessonEntry): Promise<Flashcard[]> {
  const loader = findLoader(cardFiles, `${lesson.path}/tarjetas.yaml`)
  return loader ? flashcardDeckSchema.parse(await loader()) : []
}

export async function loadCaseScenario(mod: ModuleEntry): Promise<TroubleshootingScenario | undefined> {
  const loader = findLoader(caseFiles, `${mod.path}/caso-real.yaml`)
  return loader ? troubleshootingSchema.parse(await loader()) : undefined
}
