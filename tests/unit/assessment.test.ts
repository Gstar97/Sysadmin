import { describe, expect, it } from 'vitest'
import { questionBankSchema, type Question } from '@/content/schemas'
import { labelModules, levelStops, shouldStopEarly } from '@/engines/assessment/diagnostic'
import { gradeQuestion, normalizeCommand } from '@/engines/assessment/grading'
import { allocate, buildDiagnosticLevel, buildModuleExam, pickMiniTest } from '@/engines/assessment/sampling'
import { createRng } from '@/lib/random'
import preguntas from '../../src/app/pages/gallery/demos/preguntas.yaml'

const bank = questionBankSchema.parse(preguntas)
const q = (id: string) => bank.find((x) => x.id === id) as Question

describe('corrección de preguntas', () => {
  it('opción múltiple y respuesta múltiple', async () => {
    expect((await gradeQuestion(q('d01'), { tipo: 'opcion_multiple', seleccion: 0 })).correct).toBe(true)
    expect((await gradeQuestion(q('d01'), { tipo: 'opcion_multiple', seleccion: 1 })).correct).toBe(false)
    expect((await gradeQuestion(q('d02'), { tipo: 'respuesta_multiple', seleccion: [2, 0, 1] })).correct).toBe(true)
    expect((await gradeQuestion(q('d02'), { tipo: 'respuesta_multiple', seleccion: [0, 1] })).correct).toBe(false)
  })

  it('completar comando: variantes válidas, prompt copiado y errores frecuentes', async () => {
    const c = q('d03')
    expect((await gradeQuestion(c, { tipo: 'completar_comando', texto: 'journalctl -n 20 -u nginx' })).correct).toBe(true)
    expect((await gradeQuestion(c, { tipo: 'completar_comando', texto: '$ journalctl   -u nginx.service --lines=20' })).correct).toBe(true)
    const tail = await gradeQuestion(c, { tipo: 'completar_comando', texto: 'tail -n 20 /var/log/nginx/error.log' })
    expect(tail.correct).toBe(false)
    expect(tail.feedback).toMatch(/journal/)
    expect(normalizeCommand('PS C:\\> Get-Service')).toBe('Get-Service')
  })

  it('completar comando corregido con el simulador', async () => {
    const [sim] = questionBankSchema.parse([
      {
        id: 's1',
        tipo: 'completar_comando',
        enunciado: 'Crea el directorio /srv/web con sus directorios padres.',
        simulador: { estado_inicial: { usuario: 'root' }, verificar: [{ archivo: '/srv/web', tipo: 'directorio' }] },
        explicacion: 'mkdir -p crea los padres que falten.',
      },
    ])
    expect((await gradeQuestion(sim, { tipo: 'completar_comando', texto: 'mkdir -p /srv/web' })).correct).toBe(true)
    expect((await gradeQuestion(sim, { tipo: 'completar_comando', texto: 'cd /srv && mkdir web' })).correct).toBe(true)
    expect((await gradeQuestion(sim, { tipo: 'completar_comando', texto: 'mkdir /srv/www' })).correct).toBe(false)
    const [ps] = questionBankSchema.parse([
      {
        id: 's2',
        tipo: 'completar_comando',
        enunciado: 'Detén el servicio de cola de impresión.',
        simulador: { shell: 'powershell', verificar: [{ servicio: 'Spooler', estado: 'Stopped' }] },
        explicacion: 'Stop-Service detiene un servicio.',
      },
    ])
    expect((await gradeQuestion(ps, { tipo: 'completar_comando', texto: 'Stop-Service -Name Spooler' })).correct).toBe(true)
    expect((await gradeQuestion(ps, { tipo: 'completar_comando', texto: 'spsv spooler' })).correct).toBe(true)
    expect((await gradeQuestion(ps, { tipo: 'completar_comando', texto: 'Get-Service spooler' })).correct).toBe(false)
  })

  it('ordenar pasos y encontrar el error', async () => {
    expect((await gradeQuestion(q('d04'), { tipo: 'ordenar_pasos', orden: [0, 1, 2, 3, 4] })).correct).toBe(true)
    expect((await gradeQuestion(q('d04'), { tipo: 'ordenar_pasos', orden: [1, 0, 2, 3, 4] })).correct).toBe(false)
    expect((await gradeQuestion(q('d06'), { tipo: 'encontrar_error', lineas: [3] })).correct).toBe(true)
    expect((await gradeQuestion(q('d06'), { tipo: 'encontrar_error', lineas: [3, 1] })).correct).toBe(false)
  })
})

describe('armado de mini tests, exámenes y diagnóstico', () => {
  const lessonBank = (lessonId: string, n: number, diag = 0) => ({
    lessonId,
    weight: 60,
    bank: Array.from({ length: n }, (_, i) => ({ ...q('d01'), id: `${lessonId}-${i}`, diagnostico: i < diag })),
  })

  it('reparte respetando mínimo 1 por grupo, pesos y capacidades', () => {
    expect(allocate([{ weight: 1, capacity: 10 }, { weight: 1, capacity: 10 }], 4)).toEqual([2, 2])
    expect(allocate([{ weight: 3, capacity: 10 }, { weight: 1, capacity: 10 }], 8)).toEqual([6, 2])
    expect(allocate([{ weight: 1, capacity: 2 }, { weight: 1, capacity: 10 }], 8)).toEqual([2, 6])
    expect(allocate([{ weight: 100, capacity: 10 }, { weight: 1, capacity: 10 }], 5)[1]).toBeGreaterThanOrEqual(1)
  })

  it('mini test sin repetidas y examen con todas las lecciones, priorizando no vistas', () => {
    const rng = createRng(1)
    const mini = pickMiniTest(rng, lessonBank('L1', 10), 7)
    expect(new Set(mini.map((m) => m.key)).size).toBe(7)
    const banks = [lessonBank('L1', 10), lessonBank('L2', 10), lessonBank('L3', 10)]
    const seen = new Set(Array.from({ length: 6 }, (_, i) => `L1:L1-${i}`))
    const exam = buildModuleExam(rng, banks, 9, seen)
    expect(exam).toHaveLength(9)
    expect(new Set(exam.map((e) => e.lessonId))).toEqual(new Set(['L1', 'L2', 'L3']))
    const l1 = exam.filter((e) => e.lessonId === 'L1').map((e) => e.key)
    expect(l1.every((k) => !seen.has(k))).toBe(true)
  })

  it('diagnóstico: solo preguntas aptas, corte temprano y etiquetas', () => {
    const rng = createRng(3)
    const d = buildDiagnosticLevel(rng, [
      { moduleId: 'm1', weight: 10, banks: [lessonBank('a', 10, 3)] },
      { moduleId: 'm2', weight: 10, banks: [lessonBank('b', 10, 0)] },
    ])
    expect(d.every((x) => x.question.diagnostico)).toBe(true)
    expect(d.every((x) => x.moduleId === 'm1')).toBe(true)
    expect(shouldStopEarly([false, false, true, false, false])).toBe(true)
    expect(shouldStopEarly([false, false, true, true, false])).toBe(false)
    expect(levelStops([true, false, false, true, false, false, false, true, false, false])).toBe(true)
    expect(labelModules([
      { moduleId: 'a', correct: true },
      { moduleId: 'a', correct: true },
      { moduleId: 'b', correct: true },
      { moduleId: 'b', correct: false },
      { moduleId: 'c', correct: false },
    ])).toEqual({ a: 'dominado', b: 'repasar', c: 'estudiar' })
  })
})
