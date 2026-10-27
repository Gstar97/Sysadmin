import type { Question } from '@/content/schemas'
import { shuffle, type Rng } from '@/lib/random'

export interface ExamQuestion {
  /** lessonId:questionId */
  key: string
  lessonId: string
  question: Question
}

export interface BankForLesson {
  lessonId: string
  /** Peso para repartir preguntas (minutos u horas de la lección). */
  weight: number
  bank: Question[]
}

/** Prefiere preguntas no vistas y completa con vistas si hace falta. */
function choose(rng: Rng, items: ExamQuestion[], count: number, seen: Set<string>): ExamQuestion[] {
  const unseen = shuffle(
    rng,
    items.filter((i) => !seen.has(i.key)),
  )
  const seenOnes = shuffle(
    rng,
    items.filter((i) => seen.has(i.key)),
  )
  return [...unseen, ...seenOnes].slice(0, count)
}

/**
 * Reparte `total` entre grupos según su peso, con al menos 1 por grupo y sin superar la
 * capacidad de cada uno. Después del mínimo, cada pregunta va al grupo más lejos de su cuota.
 */
export function allocate(groups: { weight: number; capacity: number }[], total: number): number[] {
  const n = groups.length
  const out = new Array<number>(n).fill(0)
  if (n === 0 || total <= 0) return out
  const capacity = groups.map((g) => Math.max(0, g.capacity))
  let remaining = Math.min(total, capacity.reduce((s, c) => s + c, 0))
  for (let i = 0; i < n && remaining > 0; i++) {
    if (capacity[i] > 0) {
      out[i] = 1
      remaining--
    }
  }
  const weights = groups.map((g) => Math.max(g.weight, 0.0001))
  const weightSum = weights.reduce((s, w) => s + w, 0)
  const target = weights.map((w) => (w / weightSum) * Math.min(total, capacity.reduce((s, c) => s + c, 0)))
  while (remaining > 0) {
    let best = -1
    for (let i = 0; i < n; i++) {
      if (out[i] >= capacity[i]) continue
      if (best < 0 || target[i] - out[i] > target[best] - out[best]) best = i
    }
    if (best < 0) break
    out[best]++
    remaining--
  }
  return out
}

function toExamQuestions(b: BankForLesson): ExamQuestion[] {
  return b.bank.map((q) => ({ key: `${b.lessonId}:${q.id}`, lessonId: b.lessonId, question: q }))
}

export function pickMiniTest(rng: Rng, b: BankForLesson, count: number): ExamQuestion[] {
  return shuffle(rng, toExamQuestions(b)).slice(0, Math.min(count, b.bank.length))
}

/** Examen de módulo: al menos una pregunta por lección y el resto según el peso de cada lección. */
export function buildModuleExam(rng: Rng, banks: BankForLesson[], total: number, seen: Set<string> = new Set()): ExamQuestion[] {
  const usable = banks.filter((b) => b.bank.length > 0)
  const counts = allocate(
    usable.map((b) => ({ weight: b.weight, capacity: b.bank.length })),
    total,
  )
  const picked = usable.flatMap((b, i) => choose(rng, toExamQuestions(b), counts[i], seen))
  return shuffle(rng, picked)
}

export interface DiagnosticModuleInput {
  moduleId: string
  weight: number
  banks: BankForLesson[]
}

/** Diagnóstico de un nivel: solo preguntas marcadas como aptas, al menos una por módulo. */
export function buildDiagnosticLevel(rng: Rng, modules: DiagnosticModuleInput[], total = 10): (ExamQuestion & { moduleId: string })[] {
  const pools = modules
    .map((m) => ({
      moduleId: m.moduleId,
      weight: m.weight,
      items: m.banks.flatMap((b) => toExamQuestions({ ...b, bank: b.bank.filter((q) => q.diagnostico) })),
    }))
    .filter((p) => p.items.length > 0)
  const counts = allocate(
    pools.map((p) => ({ weight: p.weight, capacity: p.items.length })),
    total,
  )
  // Ordenadas por módulo para que el diagnóstico avance de lo básico a lo avanzado.
  return pools.flatMap((p, i) => shuffle(rng, p.items).slice(0, counts[i]).map((q) => ({ ...q, moduleId: p.moduleId })))
}

/** Orden en que se muestran opciones y pasos (se mezclan en cada intento). */
export interface Presentation {
  optionOrder: number[]
  stepOrder: number[]
}

export function presentationFor(rng: Rng, q: Question): Presentation {
  const optionOrder = 'opciones' in q ? shuffle(rng, q.opciones.map((_, i) => i)) : []
  let stepOrder: number[] = []
  if (q.tipo === 'ordenar_pasos') {
    const ids = q.pasos.map((_, i) => i)
    stepOrder = shuffle(rng, ids)
    // Evitar que aparezca ya ordenado.
    if (stepOrder.every((v, i) => v === i) && ids.length > 1) stepOrder = [...ids.slice(1), ids[0]]
  }
  return { optionOrder, stepOrder }
}
