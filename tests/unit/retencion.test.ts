import { describe, expect, it } from 'vitest'
import { copiaAnterior, simular } from '@/engines/virtualizacion/retencion'

const ahora = Date.UTC(2026, 10, 21, 23)

describe('planificador de retención', () => {
  it('7 diarias, 4 semanales y 12 mensuales: unas 20 copias y casi un año hacia atrás', () => {
    const s = simular({ frecuenciaHoras: 24, dias: 400, politica: { daily: 7, weekly: 4, monthly: 12 }, tamanoGb: 500, cambioDiarioPct: 2, ahora })
    expect(s.guardadas).toBeGreaterThanOrEqual(19)
    expect(s.guardadas).toBeLessThanOrEqual(23)
    expect(s.masVieja).toBeGreaterThan(320)
    expect(s.espacioGb).toBeGreaterThan(500)
  })
  it('solo 7 diarias: un daño de hace 30 días no tiene de dónde volver', () => {
    const s = simular({ frecuenciaHoras: 24, dias: 400, politica: { daily: 7 }, tamanoGb: 100, cambioDiarioPct: 1, ahora })
    expect(s.guardadas).toBe(7)
    expect(copiaAnterior(s, 30, ahora)).toBeUndefined()
    expect(copiaAnterior(s, 3, ahora)?.dias).toBe(3)
  })
  it('copias cada hora con keep-hourly 24', () => {
    const s = simular({ frecuenciaHoras: 1, dias: 10, politica: { hourly: 24, daily: 7 }, tamanoGb: 100, cambioDiarioPct: 1, ahora })
    expect(s.guardadas).toBe(24 + 6)
  })
})
