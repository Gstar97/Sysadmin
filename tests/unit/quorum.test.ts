import { describe, expect, it } from 'vitest'
import { evaluarQuorum, tolerancia, type NodoQ } from '@/engines/virtualizacion/quorum'

const nodos = (n: number, apagados: number[] = [], ladoB: number[] = []): NodoQ[] =>
  Array.from({ length: n }, (_, i) => ({ nombre: `pve0${i + 1}`, votos: 1, prendido: !apagados.includes(i + 1), lado: ladoB.includes(i + 1) ? 'B' : 'A' }))

describe('Quórum', () => {
  it('tres nodos aguantan uno caído; dos nodos, ninguno', () => {
    expect(evaluarQuorum({ nodos: nodos(3, [3]), qdevice: false }).nivel).toBe('parcial')
    const dos = evaluarQuorum({ nodos: nodos(2, [2]), qdevice: false })
    expect(dos.nivel).toBe('bloqueado')
    expect(dos.necesarios).toBe(2)
    expect(tolerancia(3, false)).toBe(1)
    expect(tolerancia(2, false)).toBe(0)
    expect(tolerancia(2, true)).toBe(1)
  })
  it('con QDevice, dos nodos aguantan la caída de uno', () => {
    const r = evaluarQuorum({ nodos: nodos(2, [2]), qdevice: true })
    expect(r.esperados).toBe(3)
    expect(r.particiones[0].votos).toBe(2)
    expect(r.nivel).toBe('parcial')
  })
  it('cuatro nodos partidos 2 y 2: sin QDevice nadie tiene quórum; con QDevice gana el del ID más bajo', () => {
    expect(evaluarQuorum({ nodos: nodos(4, [], [3, 4]), qdevice: false }).nivel).toBe('bloqueado')
    const r = evaluarQuorum({ nodos: nodos(4, [], [3, 4]), qdevice: true })
    expect(r.particiones.find((p) => p.lado === 'A')!.quorum).toBe(true)
    expect(r.particiones.find((p) => p.lado === 'B')!.quorum).toBe(false)
  })
  it('bajar los votos esperados con la red partida produce split brain', () => {
    expect(evaluarQuorum({ nodos: nodos(2, [], [2]), qdevice: false, esperados: 1 }).nivel).toBe('split-brain')
  })
})
