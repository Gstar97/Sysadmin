import { z } from 'zod'
import {
  SCHEMA_VERSION,
  type Attempt,
  type CardState,
  type DiagnosticProgress,
  type LessonProgress,
  type LevelState,
  type ModuleState,
  type Note,
  type Profile,
  type ProgressSnapshot,
} from './types'

/**
 * Única puerta de acceso al progreso guardado. Hoy la implementa IndexedDB (dexie-repository.ts);
 * cuando haya usuarios y base de datos, alcanza con otra implementación que hable con la API.
 */
export interface ProgressRepository {
  load(): Promise<ProgressSnapshot>
  saveProfile(profile: Profile): Promise<void>
  putLesson(progress: LessonProgress): Promise<void>
  putModule(state: ModuleState): Promise<void>
  putLevel(state: LevelState): Promise<void>
  putNote(note: Note): Promise<void>
  deleteNote(lessonId: string): Promise<void>
  putCards(cards: CardState[]): Promise<void>
  addAttempt(attempt: Attempt): Promise<number>
  putDaily(date: string, seconds: number): Promise<void>
  saveDiagnostic(progress: DiagnosticProgress | undefined): Promise<void>
  replaceAll(snapshot: ProgressSnapshot): Promise<void>
  clear(): Promise<void>
}

// ---------------------------------------------------------------------------------------
// Formato del archivo de exportación
// ---------------------------------------------------------------------------------------

const answerSchema = z.object({
  questionKey: z.string(),
  lessonId: z.string(),
  correct: z.boolean(),
  tags: z.array(z.string()).default([]),
})

export const exportFileSchema = z.object({
  app: z.literal('carrera-sysadmin'),
  schemaVersion: z.number().int(),
  exportedAt: z.string(),
  data: z.object({
    profile: z.object({ name: z.string(), dailyCardLimit: z.number(), createdAt: z.string() }),
    lessons: z.array(
      z.object({
        lessonId: z.string(),
        status: z.enum(['en_curso', 'completada']),
        bestScore: z.number(),
        attempts: z.number(),
        activeSeconds: z.number(),
        firstVisit: z.string(),
        lastVisit: z.string(),
        completedAt: z.string().optional(),
      }),
    ),
    modules: z.array(
      z.object({
        moduleId: z.string(),
        labChecklist: z.array(z.string()),
        labDone: z.boolean(),
        caseSolved: z.boolean(),
        caseBestMinutes: z.number().optional(),
        examBest: z.number().optional(),
        examPassedAt: z.string().optional(),
        skipPassedAt: z.string().optional(),
        diagnostic: z.enum(['dominado', 'repasar', 'estudiar']).optional(),
      }),
    ),
    levels: z.array(
      z.object({
        levelId: z.string(),
        projectChecklist: z.array(z.string()),
        projectDone: z.boolean(),
        badgeEarnedAt: z.string().optional(),
        certificateCode: z.string().optional(),
      }),
    ),
    notes: z.array(z.object({ lessonId: z.string(), text: z.string(), updatedAt: z.string() })),
    cards: z.array(
      z.object({
        key: z.string(),
        lessonId: z.string(),
        due: z.string(),
        stability: z.number(),
        difficulty: z.number(),
        elapsed_days: z.number(),
        scheduled_days: z.number(),
        learning_steps: z.number(),
        reps: z.number(),
        lapses: z.number(),
        state: z.number(),
        last_review: z.string().optional(),
      }),
    ),
    attempts: z.array(
      z.object({
        kind: z.enum(['mini_test', 'examen', 'salteo', 'diagnostico', 'simulacro']),
        scopeId: z.string(),
        date: z.string(),
        score: z.number(),
        passed: z.boolean(),
        answers: z.array(answerSchema),
        durationSeconds: z.number().optional(),
      }),
    ),
    daily: z.array(z.object({ date: z.string(), seconds: z.number() })),
    diagnostic: z
      .object({
        startedAt: z.string(),
        completedLevels: z.array(z.string()),
        stoppedAtLevel: z.string().optional(),
        finishedAt: z.string().optional(),
      })
      .optional(),
  }),
})

export type ExportFile = z.infer<typeof exportFileSchema>

export function snapshotToExport(snapshot: ProgressSnapshot, now = new Date()): ExportFile {
  return {
    app: 'carrera-sysadmin',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    data: {
      profile: snapshot.profile,
      lessons: Object.values(snapshot.lessons),
      modules: Object.values(snapshot.modules),
      levels: Object.values(snapshot.levels),
      notes: Object.values(snapshot.notes),
      cards: Object.values(snapshot.cards),
      attempts: snapshot.attempts.map(({ id: _id, ...rest }) => rest),
      daily: Object.entries(snapshot.daily).map(([date, seconds]) => ({ date, seconds })),
      diagnostic: snapshot.diagnostic,
    },
  }
}

/** Valida un archivo exportado y lo convierte en un estado de progreso. Lanza un error legible si no sirve. */
export function exportToSnapshot(raw: unknown): ProgressSnapshot {
  const parsed = exportFileSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error('El archivo no es una exportación válida de la Carrera Sysadmin.')
  }
  if (parsed.data.schemaVersion > SCHEMA_VERSION) {
    throw new Error('El archivo fue creado con una versión más nueva de la plataforma.')
  }
  const d = parsed.data.data
  const byKey = <T, K extends keyof T>(items: T[], key: K) =>
    Object.fromEntries(items.map((i) => [String(i[key]), i])) as Record<string, T>
  return {
    profile: d.profile,
    lessons: byKey(d.lessons, 'lessonId'),
    modules: byKey(d.modules, 'moduleId'),
    levels: byKey(d.levels, 'levelId'),
    notes: byKey(d.notes, 'lessonId'),
    cards: byKey(d.cards, 'key'),
    attempts: d.attempts,
    daily: Object.fromEntries(d.daily.map((x) => [x.date, x.seconds])),
    diagnostic: d.diagnostic,
  }
}
