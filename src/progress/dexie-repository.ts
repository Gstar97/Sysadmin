import Dexie, { type Table } from 'dexie'
import type { ProgressRepository } from './repository'
import {
  emptySnapshot,
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

interface MetaRow {
  key: string
  value: unknown
}

class ProgressDb extends Dexie {
  meta!: Table<MetaRow, string>
  lessons!: Table<LessonProgress, string>
  modules!: Table<ModuleState, string>
  levels!: Table<LevelState, string>
  notes!: Table<Note, string>
  cards!: Table<CardState, string>
  attempts!: Table<Attempt, number>
  daily!: Table<{ date: string; seconds: number }, string>

  constructor(name: string) {
    super(name)
    this.version(1).stores({
      meta: 'key',
      lessons: 'lessonId',
      modules: 'moduleId',
      levels: 'levelId',
      notes: 'lessonId',
      cards: 'key, lessonId, due',
      attempts: '++id, kind, scopeId, date',
      daily: 'date',
    })
  }
}

export class DexieProgressRepository implements ProgressRepository {
  private db: ProgressDb

  constructor(name = 'carrera-sysadmin') {
    this.db = new ProgressDb(name)
  }

  async load(): Promise<ProgressSnapshot> {
    const db = this.db
    const snapshot = emptySnapshot()
    const [profile, diagnostic, lessons, modules, levels, notes, cards, attempts, daily] = await Promise.all([
      db.meta.get('profile'),
      db.meta.get('diagnostic'),
      db.lessons.toArray(),
      db.modules.toArray(),
      db.levels.toArray(),
      db.notes.toArray(),
      db.cards.toArray(),
      db.attempts.orderBy('date').toArray(),
      db.daily.toArray(),
    ])
    if (profile) snapshot.profile = profile.value as Profile
    else await db.meta.put({ key: 'profile', value: snapshot.profile })
    await db.meta.put({ key: 'schemaVersion', value: SCHEMA_VERSION })
    snapshot.diagnostic = diagnostic?.value as DiagnosticProgress | undefined
    for (const l of lessons) snapshot.lessons[l.lessonId] = l
    for (const m of modules) snapshot.modules[m.moduleId] = m
    for (const l of levels) snapshot.levels[l.levelId] = l
    for (const n of notes) snapshot.notes[n.lessonId] = n
    for (const c of cards) snapshot.cards[c.key] = c
    for (const d of daily) snapshot.daily[d.date] = d.seconds
    snapshot.attempts = attempts
    return snapshot
  }

  async saveProfile(profile: Profile) {
    await this.db.meta.put({ key: 'profile', value: profile })
  }
  async putLesson(progress: LessonProgress) {
    await this.db.lessons.put(progress)
  }
  async putModule(state: ModuleState) {
    await this.db.modules.put(state)
  }
  async putLevel(state: LevelState) {
    await this.db.levels.put(state)
  }
  async putNote(note: Note) {
    await this.db.notes.put(note)
  }
  async deleteNote(lessonId: string) {
    await this.db.notes.delete(lessonId)
  }
  async putCards(cards: CardState[]) {
    await this.db.cards.bulkPut(cards)
  }
  async addAttempt(attempt: Attempt) {
    const { id: _id, ...rest } = attempt
    return (await this.db.attempts.add(rest as Attempt)) as number
  }
  async putDaily(date: string, seconds: number) {
    await this.db.daily.put({ date, seconds })
  }
  async saveDiagnostic(progress: DiagnosticProgress | undefined) {
    if (progress) await this.db.meta.put({ key: 'diagnostic', value: progress })
    else await this.db.meta.delete('diagnostic')
  }

  async replaceAll(snapshot: ProgressSnapshot) {
    const db = this.db
    await db.transaction('rw', [db.meta, db.lessons, db.modules, db.levels, db.notes, db.cards, db.attempts, db.daily], async () => {
      await Promise.all([
        db.lessons.clear(),
        db.modules.clear(),
        db.levels.clear(),
        db.notes.clear(),
        db.cards.clear(),
        db.attempts.clear(),
        db.daily.clear(),
        db.meta.clear(),
      ])
      await db.meta.put({ key: 'profile', value: snapshot.profile })
      await db.meta.put({ key: 'schemaVersion', value: SCHEMA_VERSION })
      if (snapshot.diagnostic) await db.meta.put({ key: 'diagnostic', value: snapshot.diagnostic })
      await db.lessons.bulkPut(Object.values(snapshot.lessons))
      await db.modules.bulkPut(Object.values(snapshot.modules))
      await db.levels.bulkPut(Object.values(snapshot.levels))
      await db.notes.bulkPut(Object.values(snapshot.notes))
      await db.cards.bulkPut(Object.values(snapshot.cards))
      await db.attempts.bulkAdd(snapshot.attempts.map(({ id: _id, ...rest }) => rest as Attempt))
      await db.daily.bulkPut(Object.entries(snapshot.daily).map(([date, seconds]) => ({ date, seconds })))
    })
  }

  async clear() {
    await this.replaceAll(emptySnapshot())
  }
}

/** Repositorio en memoria: se usa en las pruebas y si el navegador no permite IndexedDB. */
export class MemoryProgressRepository implements ProgressRepository {
  private snapshot: ProgressSnapshot = emptySnapshot()
  private nextId = 1

  async load() {
    return structuredClone(this.snapshot)
  }
  async saveProfile(profile: Profile) {
    this.snapshot.profile = { ...profile }
  }
  async putLesson(p: LessonProgress) {
    this.snapshot.lessons[p.lessonId] = { ...p }
  }
  async putModule(s: ModuleState) {
    this.snapshot.modules[s.moduleId] = { ...s }
  }
  async putLevel(s: LevelState) {
    this.snapshot.levels[s.levelId] = { ...s }
  }
  async putNote(n: Note) {
    this.snapshot.notes[n.lessonId] = { ...n }
  }
  async deleteNote(lessonId: string) {
    delete this.snapshot.notes[lessonId]
  }
  async putCards(cards: CardState[]) {
    for (const c of cards) this.snapshot.cards[c.key] = { ...c }
  }
  async addAttempt(a: Attempt) {
    const id = this.nextId++
    this.snapshot.attempts.push({ ...a, id })
    return id
  }
  async putDaily(date: string, seconds: number) {
    this.snapshot.daily[date] = seconds
  }
  async saveDiagnostic(p: DiagnosticProgress | undefined) {
    this.snapshot.diagnostic = p
  }
  async replaceAll(s: ProgressSnapshot) {
    this.snapshot = structuredClone(s)
  }
  async clear() {
    this.snapshot = emptySnapshot()
  }
}
