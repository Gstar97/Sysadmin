import { describe, expect, it } from 'vitest'
import { dataSurvives, layout, raidInfo, raidState, rebuildHours } from '@/engines/hardware/raid'
import { recommend, upsCalc, UPS_CATALOG } from '@/engines/hardware/ups'
import { fits, rackChecks } from '@/engines/hardware/rack'

describe('cálculos de RAID', () => {
  it('capacidad, eficiencia y tolerancia', () => {
    expect(raidInfo(5, 4, 8).capacidad).toBe(24)
    expect(raidInfo(6, 6, 4)).toMatchObject({ capacidad: 16, eficiencia: 67, fallasSeguras: 2 })
    expect(raidInfo(10, 4, 4).capacidad).toBe(8)
    expect(raidInfo(1, 2, 4).eficiencia).toBe(50)
  })
  it('qué combinaciones de fallas se sobreviven', () => {
    expect(raidState(5, 4, new Set([2]))).toBe('degradado')
    expect(raidState(5, 4, new Set([1, 2]))).toBe('perdido')
    expect(dataSurvives(10, 4, new Set([0, 2]))).toBe(true)
    expect(dataSurvives(10, 4, new Set([0, 1]))).toBe(false)
    expect(raidState(0, 3, new Set([1]))).toBe('perdido')
  })
  it('la paridad rota entre los discos', () => {
    const l = layout(5, 3, 3)
    expect(l.map((d) => d[0])).toEqual(['A1', 'A2', 'Ap'])
    expect(l.map((d) => d[1])).toEqual(['B1', 'Bp', 'B2'])
    expect(rebuildHours(16)).toBeCloseTo(29.6, 1)
  })
})

describe('UPS', () => {
  it('potencia, margen y autonomía', () => {
    const loads = [{ nombre: 's', watts: 400, cantidad: 2 }]
    const r = upsCalc(loads, UPS_CATALOG[1])
    expect(r).toMatchObject({ watts: 800, va: 889, cargaPct: 80, conMargen: true })
    expect(r.minutos).toBe(18)
    expect(recommend(loads, 30)?.id).toBe('u3000')
  })
})

describe('rack', () => {
  it('no deja superponer equipos y revisa las reglas', () => {
    const placed = [
      { key: 'a', typeId: 'ups', bottom: 1 },
      { key: 'b', typeId: 'srv2u', bottom: 3 },
      { key: 'c', typeId: 'sw', bottom: 40 },
      { key: 'd', typeId: 'patch', bottom: 41 },
    ]
    expect(fits(placed, 'srv1u', 4, 42)).toBe(false)
    expect(fits(placed, 'srv1u', 5, 42)).toBe(true)
    const c = rackChecks(placed, 42)
    expect(c.find((x) => x.id === 'ups-abajo')?.ok).toBe(true)
    expect(c.find((x) => x.id === 'patchera')?.ok).toBe(true)
    expect(c.find((x) => x.id === 'huecos')?.ok).toBe(false)
  })
})
