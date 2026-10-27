import { beforeAll, describe, expect, it } from 'vitest'
import { scanContent } from '../../build/content-scan'
import type { ContentIndex } from '@/content/types'
import { MemoryProgressRepository } from '@/progress/dexie-repository'
import { examKindFor, isExamAvailable, lessonsToReview, moduleStatus, nextStep } from '@/progress/rules'
import { useProgress } from '@/progress/store'

let content: ContentIndex

beforeAll(async () => {
  content = scanContent('tests/fixtures/content').index
  await useProgress.getState().init(content, new MemoryProgressRepository())
})

const answers = (lessonId: string, ok: number, total: number) =>
  Array.from({ length: total }, (_, i) => ({ questionKey: `${lessonId}:p${i}`, lessonId, correct: i < ok, tags: [] }))

describe('reglas de avance', () => {
  it('flujo completo: lección, examen, laboratorio, caso e insignia', async () => {
    const mod = content.levels[0].modules[0]
    const store = useProgress.getState
    expect(isExamAvailable(mod)).toBe(true)
    expect(moduleStatus(mod, store().snap)).toBe('sin_empezar')
    expect(nextStep(content, store().snap).kind).toBe('leccion')

    // Mini test por debajo de 70%: no completa
    const fail = await store().recordMiniTest({ lessonId: 'n0-m1-l1', score: 0.6, answers: answers('n0-m1-l1', 3, 5), cardIds: ['t1', 't2'] })
    expect(fail.passed).toBe(false)
    expect(examKindFor(mod, store().snap)).toBe('salteo')
    const ok = await store().recordMiniTest({ lessonId: 'n0-m1-l1', score: 0.8, answers: answers('n0-m1-l1', 4, 5), cardIds: ['t1', 't2'] })
    expect(ok).toEqual({ passed: true, newlyCompleted: true })
    expect(Object.keys(store().snap.cards)).toHaveLength(2)
    expect(examKindFor(mod, store().snap)).toBe('examen')

    // Examen al 70% aprueba; faltan laboratorio y caso
    await store().recordExam({ moduleId: mod.id, kind: 'examen', score: 0.7, answers: answers('n0-m1-l1', 7, 10) })
    expect(moduleStatus(mod, store().snap)).toBe('en_curso')
    await store().setLabChecklist(mod.id, mod.lab!.verificacion, mod.lab!.verificacion.length)
    await store().markCaseSolved(mod.id, 12)
    expect(moduleStatus(mod, store().snap)).toBe('completado')

    // Proyecto entregado: insignia del nivel
    const level = content.levels[0]
    await store().setProjectChecklist(level.id, level.proyecto!.entregables, level.proyecto!.entregables.length)
    expect(store().snap.levels[level.id].badgeEarnedAt).toBeDefined()
    expect(store().snap.levels[level.id].certificateCode).toMatch(/^N0-[A-Z2-9]{10}$/)
  })

  it('el salteo necesita 85% y recomienda solo las lecciones falladas', async () => {
    await useProgress.getState().resetAll()
    const store = useProgress.getState
    const mod = content.levels[0].modules[0]
    const r1 = await store().recordExam({ moduleId: mod.id, kind: 'salteo', score: 0.8, answers: answers('n0-m1-l1', 8, 10) })
    expect(r1.passed).toBe(false)
    expect(lessonsToReview({ answers: [...answers('a', 1, 4), ...answers('b', 4, 4)] })).toEqual(['a'])
    const r2 = await store().recordExam({ moduleId: mod.id, kind: 'salteo', score: 0.9, answers: answers('n0-m1-l1', 9, 10) })
    expect(r2.passed).toBe(true)
    expect(moduleStatus(mod, store().snap)).toBe('completado_por_salteo')
  })
})
