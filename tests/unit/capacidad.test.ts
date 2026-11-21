import { describe, expect, it } from 'vitest'
import { calcular } from '@/engines/virtualizacion/capacidad'

describe('Capacidad', () => {
  it('ZFS', () => {
    expect(calcular('mirror', { discos: 4, tamanoTb: 4, nodos: 1 }).utilTb).toBe(8)
    expect(calcular('raidz2', { discos: 6, tamanoTb: 4, nodos: 1 }).utilTb).toBeCloseTo(15.5, 0)
    expect(calcular('raidz1', { discos: 3, tamanoTb: 8, nodos: 1 }).notas.join(' ')).toContain('RAIDZ2')
    expect(calcular('raidz3', { discos: 4, tamanoTb: 4, nodos: 1 }).invalido).toBeTruthy()
  })
  it('Ceph', () => {
    const r = calcular('ceph3', { discos: 2, tamanoTb: 4, nodos: 3 })
    expect(r.crudoTb).toBe(24)
    expect(r.utilTb).toBe(8)
    expect(r.recomendadoTb).toBeLessThan(6)
    expect(calcular('ceph3', { discos: 4, tamanoTb: 4, nodos: 2 }).invalido).toContain('3 servidores')
    expect(calcular('ec42', { discos: 2, tamanoTb: 4, nodos: 4 }).invalido).toContain('6')
  })
})
