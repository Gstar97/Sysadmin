export type LessonStatus = 'en_curso' | 'completada'

export interface LessonProgress {
  lessonId: string
  status: LessonStatus
  /** Mejor puntaje del mini test, entre 0 y 1. */
  bestScore: number
  attempts: number
  activeSeconds: number
  firstVisit: string
  lastVisit: string
  completedAt?: string
}

export type AttemptKind = 'mini_test' | 'examen' | 'salteo' | 'diagnostico' | 'simulacro'

export interface AnswerRecord {
  /** lessonId:questionId */
  questionKey: string
  lessonId: string
  correct: boolean
  tags: string[]
}

export interface Attempt {
  id?: number
  kind: AttemptKind
  /** Lección, módulo o nivel evaluado. */
  scopeId: string
  date: string
  score: number
  passed: boolean
  answers: AnswerRecord[]
  durationSeconds?: number
}

export type DiagnosticLabel = 'dominado' | 'repasar' | 'estudiar'

export interface ModuleState {
  moduleId: string
  labChecklist: string[]
  labDone: boolean
  caseSolved: boolean
  caseBestMinutes?: number
  examBest?: number
  examPassedAt?: string
  skipPassedAt?: string
  diagnostic?: DiagnosticLabel
}

export interface LevelState {
  levelId: string
  projectChecklist: string[]
  projectDone: boolean
  badgeEarnedAt?: string
  certificateCode?: string
}

export interface Note {
  lessonId: string
  text: string
  updatedAt: string
}

export interface CardState {
  /** lessonId:cardId */
  key: string
  lessonId: string
  due: string
  stability: number
  difficulty: number
  elapsed_days: number
  scheduled_days: number
  learning_steps: number
  reps: number
  lapses: number
  state: number
  last_review?: string
}

export interface DailyTime {
  date: string
  seconds: number
}

export interface Profile {
  name: string
  dailyCardLimit: number
  createdAt: string
}

export interface DiagnosticProgress {
  startedAt: string
  completedLevels: string[]
  stoppedAtLevel?: string
  finishedAt?: string
}

export interface ProgressSnapshot {
  profile: Profile
  lessons: Record<string, LessonProgress>
  modules: Record<string, ModuleState>
  levels: Record<string, LevelState>
  notes: Record<string, Note>
  cards: Record<string, CardState>
  daily: Record<string, number>
  attempts: Attempt[]
  diagnostic?: DiagnosticProgress
}

export const SCHEMA_VERSION = 1

export function emptySnapshot(now = new Date()): ProgressSnapshot {
  return {
    profile: { name: '', dailyCardLimit: 50, createdAt: now.toISOString() },
    lessons: {},
    modules: {},
    levels: {},
    notes: {},
    cards: {},
    daily: {},
    attempts: [],
  }
}

export function emptyModuleState(moduleId: string): ModuleState {
  return { moduleId, labChecklist: [], labDone: false, caseSolved: false }
}

export function emptyLevelState(levelId: string): LevelState {
  return { levelId, projectChecklist: [], projectDone: false }
}
