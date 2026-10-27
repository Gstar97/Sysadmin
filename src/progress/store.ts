import { create } from 'zustand'
import type { ContentIndex } from '@/content/types'
import { newCardState, reviewCard, type ReviewGrade } from '@/engines/srs'
import { DexieProgressRepository, MemoryProgressRepository } from './dexie-repository'
import type { ProgressRepository } from './repository'
import { dayKey, isLevelComplete, LESSON_PASS, passThreshold } from './rules'
import {
  emptyLevelState,
  emptyModuleState,
  emptySnapshot,
  type AnswerRecord,
  type Attempt,
  type DiagnosticLabel,
  type LessonProgress,
  type ProgressSnapshot,
  type Profile,
} from './types'

export interface ProgressStore {
  ready: boolean
  persistent: boolean | null
  storageWarning?: string
  snap: ProgressSnapshot
  init(content: ContentIndex, repository?: ProgressRepository): Promise<void>
  touchLesson(lessonId: string): Promise<void>
  recordMiniTest(input: {
    lessonId: string
    score: number
    answers: AnswerRecord[]
    cardIds: string[]
    durationSeconds?: number
  }): Promise<{ passed: boolean; newlyCompleted: boolean }>
  recordExam(input: {
    moduleId: string
    kind: 'examen' | 'salteo'
    score: number
    answers: AnswerRecord[]
    durationSeconds?: number
  }): Promise<{ passed: boolean }>
  recordDiagnosticLevel(input: {
    levelId: string
    answers: AnswerRecord[]
    score: number
    labels: Record<string, DiagnosticLabel>
    stopped: boolean
    finished: boolean
  }): Promise<void>
  labelModules(labels: Record<string, DiagnosticLabel>): Promise<void>
  resetDiagnostic(): Promise<void>
  setLabChecklist(moduleId: string, checked: string[], total: number): Promise<void>
  markCaseSolved(moduleId: string, minutes: number): Promise<void>
  setProjectChecklist(levelId: string, checked: string[], total: number): Promise<void>
  saveNote(lessonId: string, text: string): Promise<void>
  review(cardKey: string, grade: ReviewGrade): Promise<void>
  addActiveTime(seconds: number, lessonId?: string): Promise<void>
  updateProfile(partial: Partial<Profile>): Promise<void>
  importSnapshot(snapshot: ProgressSnapshot): Promise<void>
  resetAll(): Promise<void>
}

let repo: ProgressRepository = new MemoryProgressRepository()
let contentIndex: ContentIndex | undefined

function randomCode(length = 10): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('')
}

export const useProgress = create<ProgressStore>((set, get) => {
  const nowIso = () => new Date().toISOString()

  /** Revisa si algún nivel quedó completo y entrega la insignia y el certificado. */
  async function awardBadges() {
    if (!contentIndex) return
    const snap = get().snap
    for (const level of contentIndex.levels) {
      const state = snap.levels[level.id]
      if (state?.badgeEarnedAt || !isLevelComplete(level, snap)) continue
      const updated = { ...(state ?? emptyLevelState(level.id)), badgeEarnedAt: nowIso(), certificateCode: `${level.id.toUpperCase()}-${randomCode()}` }
      set((s) => ({ snap: { ...s.snap, levels: { ...s.snap.levels, [level.id]: updated } } }))
      await repo.putLevel(updated)
    }
  }

  async function addAttempt(attempt: Attempt) {
    const id = await repo.addAttempt(attempt)
    set((s) => ({ snap: { ...s.snap, attempts: [...s.snap.attempts, { ...attempt, id }] } }))
  }

  return {
    ready: false,
    persistent: null,
    snap: emptySnapshot(),

    async init(content, repository) {
      contentIndex = content
      if (repository) repo = repository
      else {
        try {
          repo = new DexieProgressRepository()
          await repo.load()
        } catch {
          repo = new MemoryProgressRepository()
          set({ storageWarning: 'Este navegador no permite guardar el progreso. Se perderá al cerrar la pestaña.' })
        }
      }
      const snap = await repo.load()
      let persistent: boolean | null = null
      try {
        if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
          persistent = (await navigator.storage.persisted()) || (await navigator.storage.persist())
        }
      } catch {
        persistent = null
      }
      set({ snap, ready: true, persistent })
      await awardBadges()
    },

    async touchLesson(lessonId) {
      const now = nowIso()
      const prev = get().snap.lessons[lessonId]
      const next: LessonProgress = prev
        ? { ...prev, lastVisit: now }
        : { lessonId, status: 'en_curso', bestScore: 0, attempts: 0, activeSeconds: 0, firstVisit: now, lastVisit: now }
      set((s) => ({ snap: { ...s.snap, lessons: { ...s.snap.lessons, [lessonId]: next } } }))
      await repo.putLesson(next)
    },

    async recordMiniTest({ lessonId, score, answers, cardIds, durationSeconds }) {
      const now = nowIso()
      const passed = score >= LESSON_PASS
      await addAttempt({ kind: 'mini_test', scopeId: lessonId, date: now, score, passed, answers, durationSeconds })
      const prev = get().snap.lessons[lessonId] ?? {
        lessonId,
        status: 'en_curso' as const,
        bestScore: 0,
        attempts: 0,
        activeSeconds: 0,
        firstVisit: now,
        lastVisit: now,
      }
      const newlyCompleted = passed && prev.status !== 'completada'
      const next: LessonProgress = {
        ...prev,
        attempts: prev.attempts + 1,
        bestScore: Math.max(prev.bestScore, score),
        lastVisit: now,
        status: passed || prev.status === 'completada' ? 'completada' : 'en_curso',
        completedAt: prev.completedAt ?? (passed ? now : undefined),
      }
      const cards = { ...get().snap.cards }
      const newCards = []
      if (passed) {
        for (const id of cardIds) {
          const key = `${lessonId}:${id}`
          if (!cards[key]) {
            const c = newCardState(key, lessonId)
            cards[key] = c
            newCards.push(c)
          }
        }
      }
      set((s) => ({ snap: { ...s.snap, lessons: { ...s.snap.lessons, [lessonId]: next }, cards } }))
      await repo.putLesson(next)
      if (newCards.length) await repo.putCards(newCards)
      await awardBadges()
      return { passed, newlyCompleted }
    },

    async recordExam({ moduleId, kind, score, answers, durationSeconds }) {
      const now = nowIso()
      const passed = score >= passThreshold(kind)
      await addAttempt({ kind, scopeId: moduleId, date: now, score, passed, answers, durationSeconds })
      const prev = get().snap.modules[moduleId] ?? emptyModuleState(moduleId)
      const next = {
        ...prev,
        examBest: Math.max(prev.examBest ?? 0, score),
        examPassedAt: prev.examPassedAt ?? (passed && kind === 'examen' ? now : undefined),
        skipPassedAt: prev.skipPassedAt ?? (passed && kind === 'salteo' ? now : undefined),
      }
      set((s) => ({ snap: { ...s.snap, modules: { ...s.snap.modules, [moduleId]: next } } }))
      await repo.putModule(next)
      await awardBadges()
      return { passed }
    },

    async recordDiagnosticLevel({ levelId, answers, score, labels, stopped, finished }) {
      const now = nowIso()
      await addAttempt({ kind: 'diagnostico', scopeId: levelId, date: now, score, passed: !stopped, answers })
      await get().labelModules(labels)
      const prev = get().snap.diagnostic ?? { startedAt: now, completedLevels: [] }
      const next = {
        ...prev,
        completedLevels: [...new Set([...prev.completedLevels, levelId])],
        stoppedAtLevel: stopped ? levelId : prev.stoppedAtLevel,
        finishedAt: finished || stopped ? now : undefined,
      }
      set((s) => ({ snap: { ...s.snap, diagnostic: next } }))
      await repo.saveDiagnostic(next)
    },

    async labelModules(labels) {
      const modules = { ...get().snap.modules }
      const changed = []
      for (const [moduleId, label] of Object.entries(labels)) {
        const updated = { ...(modules[moduleId] ?? emptyModuleState(moduleId)), diagnostic: label }
        modules[moduleId] = updated
        changed.push(updated)
      }
      set((s) => ({ snap: { ...s.snap, modules } }))
      for (const m of changed) await repo.putModule(m)
    },

    async resetDiagnostic() {
      const modules = { ...get().snap.modules }
      const changed = []
      for (const [id, m] of Object.entries(modules)) {
        if (m.diagnostic) {
          modules[id] = { ...m, diagnostic: undefined }
          changed.push(modules[id])
        }
      }
      set((s) => ({ snap: { ...s.snap, modules, diagnostic: undefined } }))
      for (const m of changed) await repo.putModule(m)
      await repo.saveDiagnostic(undefined)
    },

    async setLabChecklist(moduleId, checked, total) {
      const prev = get().snap.modules[moduleId] ?? emptyModuleState(moduleId)
      const next = { ...prev, labChecklist: checked, labDone: total > 0 && checked.length >= total }
      set((s) => ({ snap: { ...s.snap, modules: { ...s.snap.modules, [moduleId]: next } } }))
      await repo.putModule(next)
      await awardBadges()
    },

    async markCaseSolved(moduleId, minutes) {
      const prev = get().snap.modules[moduleId] ?? emptyModuleState(moduleId)
      const best = prev.caseBestMinutes === undefined ? minutes : Math.min(prev.caseBestMinutes, minutes)
      const next = { ...prev, caseSolved: true, caseBestMinutes: best }
      set((s) => ({ snap: { ...s.snap, modules: { ...s.snap.modules, [moduleId]: next } } }))
      await repo.putModule(next)
      await awardBadges()
    },

    async setProjectChecklist(levelId, checked, total) {
      const prev = get().snap.levels[levelId] ?? emptyLevelState(levelId)
      const next = { ...prev, projectChecklist: checked, projectDone: total > 0 && checked.length >= total }
      set((s) => ({ snap: { ...s.snap, levels: { ...s.snap.levels, [levelId]: next } } }))
      await repo.putLevel(next)
      await awardBadges()
    },

    async saveNote(lessonId, text) {
      if (!text.trim()) {
        set((s) => {
          const notes = { ...s.snap.notes }
          delete notes[lessonId]
          return { snap: { ...s.snap, notes } }
        })
        await repo.deleteNote(lessonId)
        return
      }
      const note = { lessonId, text, updatedAt: nowIso() }
      set((s) => ({ snap: { ...s.snap, notes: { ...s.snap.notes, [lessonId]: note } } }))
      await repo.putNote(note)
    },

    async review(cardKey, grade) {
      const card = get().snap.cards[cardKey]
      if (!card) return
      const next = reviewCard(card, grade)
      set((s) => ({ snap: { ...s.snap, cards: { ...s.snap.cards, [cardKey]: next } } }))
      await repo.putCards([next])
    },

    async addActiveTime(seconds, lessonId) {
      if (seconds <= 0) return
      const day = dayKey()
      const snap = get().snap
      const daily = (snap.daily[day] ?? 0) + seconds
      let lessonUpdate: LessonProgress | undefined
      if (lessonId && snap.lessons[lessonId]) {
        lessonUpdate = { ...snap.lessons[lessonId], activeSeconds: snap.lessons[lessonId].activeSeconds + seconds }
      }
      set((s) => ({
        snap: {
          ...s.snap,
          daily: { ...s.snap.daily, [day]: daily },
          lessons: lessonUpdate ? { ...s.snap.lessons, [lessonUpdate.lessonId]: lessonUpdate } : s.snap.lessons,
        },
      }))
      await repo.putDaily(day, daily)
      if (lessonUpdate) await repo.putLesson(lessonUpdate)
    },

    async updateProfile(partial) {
      const profile = { ...get().snap.profile, ...partial }
      set((s) => ({ snap: { ...s.snap, profile } }))
      await repo.saveProfile(profile)
    },

    async importSnapshot(snapshot) {
      await repo.replaceAll(snapshot)
      set({ snap: await repo.load() })
      await awardBadges()
    },

    async resetAll() {
      await repo.clear()
      set({ snap: await repo.load() })
    },
  }
})
