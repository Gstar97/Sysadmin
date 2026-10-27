/**
 * Reglas de avance de la carrera (ver docs/ARQUITECTURA.txt, sección 7).
 * Funciones puras: reciben el contenido y el progreso y devuelven estados derivados.
 */
import type { ContentIndex, LessonEntry, LevelEntry, ModuleEntry } from '@/content/types'
import type { Attempt, CardState, ProgressSnapshot } from './types'

export const LESSON_PASS = 0.7
export const EXAM_PASS = 0.7
export const SKIP_PASS = 0.85
export const RECOMMEND_BELOW = 0.7

export type ModuleStatus = 'sin_empezar' | 'en_curso' | 'completado' | 'completado_por_salteo'

export function isLessonCompleted(snap: ProgressSnapshot, lessonId: string): boolean {
  return snap.lessons[lessonId]?.status === 'completada'
}

/** Un módulo está publicado por completo cuando tiene todas sus lecciones, el laboratorio y el caso real. */
export function isModuleFullyPublished(mod: ModuleEntry): boolean {
  return (
    mod.lessons.length > 0 &&
    mod.planned.length === 0 &&
    (mod.lab ? mod.lab.publicado : true) &&
    (mod.caso ? mod.caso.publicado : true)
  )
}

/** El examen (y el salteo) solo se habilitan con el módulo completo, para no aprobar sobre contenido parcial. */
export function isExamAvailable(mod: ModuleEntry): boolean {
  return isModuleFullyPublished(mod) && mod.lessons.some((l) => l.preguntas > 0)
}

export function allLessonsCompleted(mod: ModuleEntry, snap: ProgressSnapshot): boolean {
  return mod.planned.length === 0 && mod.lessons.length > 0 && mod.lessons.every((l) => isLessonCompleted(snap, l.id))
}

/** Si el estudiante no completó todas las lecciones, el examen cuenta como salteo (85%). */
export function examKindFor(mod: ModuleEntry, snap: ProgressSnapshot): 'examen' | 'salteo' {
  return allLessonsCompleted(mod, snap) ? 'examen' : 'salteo'
}

export function passThreshold(kind: 'examen' | 'salteo' | 'mini_test'): number {
  if (kind === 'salteo') return SKIP_PASS
  if (kind === 'examen') return EXAM_PASS
  return LESSON_PASS
}

export interface Requirement {
  key: 'lecciones' | 'examen' | 'laboratorio' | 'caso'
  label: string
  done: boolean
  detail?: string
}

export function moduleRequirements(mod: ModuleEntry, snap: ProgressSnapshot): Requirement[] {
  const st = snap.modules[mod.id]
  const total = mod.lessons.length + mod.planned.length
  const done = mod.lessons.filter((l) => isLessonCompleted(snap, l.id)).length
  const reqs: Requirement[] = [
    { key: 'lecciones', label: 'Lecciones completadas', done: total > 0 && done === total, detail: `${done} de ${total}` },
  ]
  if (mod.lab) reqs.push({ key: 'laboratorio', label: 'Laboratorio guiado', done: !!st?.labDone })
  if (mod.caso) reqs.push({ key: 'caso', label: 'Caso real resuelto', done: !!st?.caseSolved })
  reqs.push({
    key: 'examen',
    label: 'Examen del módulo (70%)',
    done: !!st?.examPassedAt,
    detail: st?.examBest !== undefined ? `mejor: ${Math.round(st.examBest * 100)}%` : undefined,
  })
  return reqs
}

export function moduleStatus(mod: ModuleEntry, snap: ProgressSnapshot): ModuleStatus {
  const st = snap.modules[mod.id]
  const porCursada = isModuleFullyPublished(mod) && moduleRequirements(mod, snap).every((r) => r.done)
  if (porCursada) return 'completado'
  if (st?.skipPassedAt) return 'completado_por_salteo'
  const started =
    mod.lessons.some((l) => snap.lessons[l.id]) ||
    !!st?.labDone ||
    !!st?.caseSolved ||
    (st?.labChecklist.length ?? 0) > 0 ||
    st?.examBest !== undefined
  return started ? 'en_curso' : 'sin_empezar'
}

export function isModuleComplete(mod: ModuleEntry, snap: ProgressSnapshot): boolean {
  return moduleStatus(mod, snap).startsWith('completado')
}

/** Avance del módulo entre 0 y 1 (lecciones + laboratorio + caso + examen). */
export function moduleFraction(mod: ModuleEntry, snap: ProgressSnapshot): number {
  if (isModuleComplete(mod, snap)) return 1
  const reqs = moduleRequirements(mod, snap)
  const total = mod.lessons.length + mod.planned.length + (reqs.length - 1)
  if (total === 0) return 0
  const lessonsDone = mod.lessons.filter((l) => isLessonCompleted(snap, l.id)).length
  const others = reqs.filter((r) => r.key !== 'lecciones' && r.done).length
  return (lessonsDone + others) / total
}

export function missingRequirements(mod: ModuleEntry, content: ContentIndex, snap: ProgressSnapshot): ModuleEntry[] {
  const all = content.levels.flatMap((l) => l.modules)
  return mod.requiere
    .map((id) => all.find((m) => m.id === id))
    .filter((m): m is ModuleEntry => !!m && !isModuleComplete(m, snap))
}

export function isLevelComplete(level: LevelEntry, snap: ProgressSnapshot): boolean {
  if (level.modules.length === 0) return false
  const modulesOk = level.modules.every((m) => isModuleComplete(m, snap))
  const projectOk = !level.proyecto || (level.proyecto.publicado && !!snap.levels[level.id]?.projectDone)
  return modulesOk && projectOk
}

export function levelFraction(level: LevelEntry, snap: ProgressSnapshot): number {
  if (level.modules.length === 0) return 0
  const parts = level.modules.map((m) => moduleFraction(m, snap))
  const project = level.proyecto ? (snap.levels[level.id]?.projectDone ? 1 : 0) : undefined
  const all = project === undefined ? parts : [...parts, project]
  return all.reduce((s, x) => s + x, 0) / all.length
}

export function careerFraction(content: ContentIndex, snap: ProgressSnapshot): number {
  if (content.levels.length === 0) return 0
  return content.levels.reduce((s, l) => s + levelFraction(l, snap), 0) / content.levels.length
}

// ---------------------------------------------------------------------------------------
// Recomendaciones
// ---------------------------------------------------------------------------------------

export interface LessonScore {
  lessonId: string
  correct: number
  total: number
  ratio: number
}

export function accuracyByLesson(attempt: Pick<Attempt, 'answers'>): LessonScore[] {
  const map = new Map<string, { correct: number; total: number }>()
  for (const a of attempt.answers) {
    const s = map.get(a.lessonId) ?? { correct: 0, total: 0 }
    s.total++
    if (a.correct) s.correct++
    map.set(a.lessonId, s)
  }
  return [...map.entries()].map(([lessonId, s]) => ({ lessonId, ...s, ratio: s.total ? s.correct / s.total : 0 }))
}

/** Lecciones a repasar después de un examen: las que quedaron por debajo del 70% dentro del examen. */
export function lessonsToReview(attempt: Pick<Attempt, 'answers'>): string[] {
  return accuracyByLesson(attempt)
    .filter((s) => s.ratio < RECOMMEND_BELOW)
    .map((s) => s.lessonId)
}

/** Recomendaciones vigentes: de cada módulo no completado, el último examen desaprobado. */
export function pendingRecommendations(content: ContentIndex, snap: ProgressSnapshot): { lessonId: string; moduleId: string; since: string }[] {
  const out: { lessonId: string; moduleId: string; since: string }[] = []
  for (const mod of content.levels.flatMap((l) => l.modules)) {
    if (isModuleComplete(mod, snap)) continue
    const last = [...snap.attempts]
      .filter((a) => a.scopeId === mod.id && (a.kind === 'examen' || a.kind === 'salteo'))
      .sort((a, b) => a.date.localeCompare(b.date))
      .at(-1)
    if (!last || last.passed) continue
    for (const lessonId of lessonsToReview(last)) {
      const visit = snap.lessons[lessonId]?.lastVisit
      if (!visit || visit < last.date) out.push({ lessonId, moduleId: mod.id, since: last.date })
    }
  }
  return out
}

export interface TopicStat {
  lessonId: string
  accuracy: number
  answers: number
}

/** Precisión por lección, ponderando más las respuestas recientes (vida media de 30 días). */
export function topicStats(snap: ProgressSnapshot, now = new Date()): TopicStat[] {
  const map = new Map<string, { w: number; wc: number; n: number }>()
  for (const attempt of snap.attempts) {
    const ageDays = Math.max(0, (now.getTime() - new Date(attempt.date).getTime()) / 86_400_000)
    const weight = Math.pow(0.5, ageDays / 30)
    for (const a of attempt.answers) {
      const s = map.get(a.lessonId) ?? { w: 0, wc: 0, n: 0 }
      s.w += weight
      if (a.correct) s.wc += weight
      s.n++
      map.set(a.lessonId, s)
    }
  }
  return [...map.entries()].map(([lessonId, s]) => ({ lessonId, accuracy: s.w ? s.wc / s.w : 0, answers: s.n }))
}

export const MIN_ANSWERS_FOR_TOPIC = 3

export function weakTopics(snap: ProgressSnapshot, now = new Date()): TopicStat[] {
  return topicStats(snap, now)
    .filter((t) => t.answers >= MIN_ANSWERS_FOR_TOPIC && t.accuracy < 0.6)
    .sort((a, b) => a.accuracy - b.accuracy)
}

export function strongTopics(snap: ProgressSnapshot, now = new Date()): TopicStat[] {
  return topicStats(snap, now)
    .filter((t) => t.answers >= MIN_ANSWERS_FOR_TOPIC && t.accuracy >= 0.85)
    .sort((a, b) => b.accuracy - a.accuracy)
}

export function dueCards(snap: ProgressSnapshot, now = new Date()): CardState[] {
  return Object.values(snap.cards)
    .filter((c) => new Date(c.due).getTime() <= now.getTime())
    .sort((a, b) => a.due.localeCompare(b.due))
}

export function dayKey(date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function lastDaysSeconds(snap: ProgressSnapshot, days: number, now = new Date()): { date: string; seconds: number }[] {
  const out: { date: string; seconds: number }[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const key = dayKey(d)
    out.push({ date: key, seconds: snap.daily[key] ?? 0 })
  }
  return out
}

export function totalSeconds(snap: ProgressSnapshot): number {
  return Object.values(snap.daily).reduce((s, x) => s + x, 0)
}

// ---------------------------------------------------------------------------------------
// Próximo paso recomendado
// ---------------------------------------------------------------------------------------

export interface NextStep {
  kind: 'repaso' | 'recomendada' | 'leccion' | 'laboratorio' | 'caso' | 'examen' | 'salteo' | 'proyecto' | 'diagnostico' | 'galeria' | 'fin'
  title: string
  description: string
  url: string
  warning?: string
}

function firstIncompleteLesson(mod: ModuleEntry, snap: ProgressSnapshot): LessonEntry | undefined {
  return mod.lessons.find((l) => !isLessonCompleted(snap, l.id))
}

function stepWithinModule(mod: ModuleEntry, snap: ProgressSnapshot): NextStep | undefined {
  const lesson = firstIncompleteLesson(mod, snap)
  if (lesson) {
    return {
      kind: 'leccion',
      title: `${snap.lessons[lesson.id] ? 'Continuar' : 'Empezar'}: ${lesson.titulo}`,
      description: `Lección ${lesson.numero} del módulo ${mod.titulo}.`,
      url: `/leccion/${lesson.id}`,
    }
  }
  if (!isModuleFullyPublished(mod)) return undefined
  const st = snap.modules[mod.id]
  if (mod.lab && !st?.labDone) {
    return { kind: 'laboratorio', title: `Laboratorio: ${mod.titulo}`, description: mod.lab.titulo, url: `/laboratorio/${mod.id}` }
  }
  if (mod.caso && !st?.caseSolved) {
    return { kind: 'caso', title: `Caso real: ${mod.caso.titulo}`, description: `Cierre del módulo ${mod.titulo}.`, url: `/caso/${mod.id}` }
  }
  if (!st?.examPassedAt) {
    return {
      kind: 'examen',
      title: `Examen del módulo ${mod.numero}`,
      description: `${mod.titulo}: se aprueba con 70%.`,
      url: `/examen/${mod.id}`,
    }
  }
  return undefined
}

export function nextStep(content: ContentIndex, snap: ProgressSnapshot, now = new Date()): NextStep {
  const due = dueCards(snap, now).length
  if (due > 0) {
    return {
      kind: 'repaso',
      title: `Hay ${due} ${due === 1 ? 'tarjeta' : 'tarjetas'} para repasar`,
      description: 'Unos minutos de repaso espaciado fijan lo aprendido mucho mejor que releer.',
      url: '/repaso',
    }
  }

  const recs = pendingRecommendations(content, snap)
  if (recs.length) {
    const lesson = content.levels.flatMap((l) => l.modules.flatMap((m) => m.lessons)).find((l) => l.id === recs[0].lessonId)
    if (lesson) {
      return {
        kind: 'recomendada',
        title: `Repasar: ${lesson.titulo}`,
        description: 'Es uno de los temas que fallaron en el último examen. Después se puede volver a rendir.',
        url: `/leccion/${lesson.id}`,
      }
    }
  }

  const modules = content.levels.flatMap((l) => l.modules)
  const enCurso = modules
    .filter((m) => moduleStatus(m, snap) === 'en_curso')
    .map((m) => ({
      m,
      last: Math.max(0, ...m.lessons.map((l) => new Date(snap.lessons[l.id]?.lastVisit ?? 0).getTime())),
    }))
    .sort((a, b) => b.last - a.last)
  for (const { m } of enCurso) {
    const step = stepWithinModule(m, snap)
    if (step) return step
  }

  for (const level of content.levels) {
    for (const mod of level.modules) {
      if (isModuleComplete(mod, snap)) continue
      const faltan = missingRequirements(mod, content, snap)
      const warning = faltan.length
        ? `Conviene ver antes: ${faltan.map((f) => `${f.numero} ${f.titulo}`).join(', ')}.`
        : undefined
      if (snap.modules[mod.id]?.diagnostic === 'dominado' && isExamAvailable(mod)) {
        return {
          kind: 'salteo',
          title: `Rendir el examen de salteo de ${mod.numero} ${mod.titulo}`,
          description: 'El diagnóstico lo marcó como dominado. Con 85% o más, el módulo queda completado.',
          url: `/examen/${mod.id}`,
          warning,
        }
      }
      const step = stepWithinModule(mod, snap)
      if (step) return { ...step, warning }
    }
    if (level.proyecto?.publicado && level.modules.every((m) => isModuleComplete(m, snap)) && !snap.levels[level.id]?.projectDone) {
      return {
        kind: 'proyecto',
        title: `Proyecto integrador: ${level.proyecto.titulo}`,
        description: `Cierre del nivel ${level.numero} - ${level.titulo}.`,
        url: `/proyecto/${level.id}`,
      }
    }
  }

  const anyPublished = modules.some((m) => m.lessons.length > 0)
  if (!anyPublished) {
    return {
      kind: 'galeria',
      title: 'Recorrer la galería de componentes',
      description: 'Las lecciones se publican por etapas. Mientras tanto, se pueden probar todos los interactivos.',
      url: '/galeria',
    }
  }
  return {
    kind: 'fin',
    title: 'Todo lo publicado está completo',
    description: 'Se puede repasar con las tarjetas o rendir simulacros mientras se publican los próximos niveles.',
    url: '/mapa',
  }
}
