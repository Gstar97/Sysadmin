import { createEmptyCard, fsrs, generatorParameters, Rating, type Card, type Grade } from 'ts-fsrs'
import type { CardState } from '@/progress/types'

export type ReviewGrade = 'otra_vez' | 'dificil' | 'bien' | 'facil'

const gradeToRating: Record<ReviewGrade, Grade> = {
  otra_vez: Rating.Again,
  dificil: Rating.Hard,
  bien: Rating.Good,
  facil: Rating.Easy,
}

export const GRADE_LABELS: Record<ReviewGrade, string> = {
  otra_vez: 'Otra vez',
  dificil: 'Difícil',
  bien: 'Bien',
  facil: 'Fácil',
}

const scheduler = fsrs(generatorParameters({ enable_fuzz: true, request_retention: 0.9 }))

function toCard(s: CardState): Card {
  return {
    due: new Date(s.due),
    stability: s.stability,
    difficulty: s.difficulty,
    elapsed_days: s.elapsed_days,
    scheduled_days: s.scheduled_days,
    learning_steps: s.learning_steps,
    reps: s.reps,
    lapses: s.lapses,
    state: s.state,
    last_review: s.last_review ? new Date(s.last_review) : undefined,
  }
}

function fromCard(key: string, lessonId: string, c: Card): CardState {
  return {
    key,
    lessonId,
    due: c.due.toISOString(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsed_days: c.elapsed_days,
    scheduled_days: c.scheduled_days,
    learning_steps: c.learning_steps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    last_review: c.last_review?.toISOString(),
  }
}

export function newCardState(key: string, lessonId: string, now = new Date()): CardState {
  return fromCard(key, lessonId, createEmptyCard(now))
}

export function reviewCard(state: CardState, grade: ReviewGrade, now = new Date()): CardState {
  const result = scheduler.next(toCard(state), now, gradeToRating[grade])
  return fromCard(state.key, state.lessonId, result.card)
}

/** Próximo vencimiento para cada calificación posible (para mostrar "en 10 min", "en 3 días"...). */
export function previewIntervals(state: CardState, now = new Date()): Record<ReviewGrade, Date> {
  const out = {} as Record<ReviewGrade, Date>
  for (const g of Object.keys(gradeToRating) as ReviewGrade[]) {
    out[g] = scheduler.next(toCard(state), now, gradeToRating[g]).card.due
  }
  return out
}

export function isDue(state: CardState, now = new Date()): boolean {
  return new Date(state.due).getTime() <= now.getTime()
}

export function formatInterval(due: Date, now = new Date()): string {
  const minutes = Math.max(1, Math.round((due.getTime() - now.getTime()) / 60000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h`
  const days = Math.round(hours / 24)
  if (days < 31) return `${days} d`
  const months = Math.round(days / 30)
  return months < 12 ? `${months} meses` : `${Math.round(months / 12)} años`
}
