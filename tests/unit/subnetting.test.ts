import { describe, expect, it } from 'vitest'
import { checkField, generateExercise, parsePrefix, SUBNET_TYPES, type Difficulty } from '@/engines/subnetting'
import { createRng } from '@/lib/random'

describe('entrenador de subnetting', () => {
  it('genera miles de ejercicios válidos que se corrigen con su propia respuesta', () => {
    const rng = createRng(7)
    for (let i = 0; i < 1500; i++) {
      for (const t of SUBNET_TYPES) {
        const ex = generateExercise(rng, t.id, ((i % 3) + 1) as Difficulty)
        expect(ex.enunciado.length).toBeGreaterThan(10)
        expect(ex.pasos.length).toBeGreaterThan(0)
        for (const f of ex.campos) {
          expect(f.respuesta).not.toMatch(/NaN|undefined/)
          expect(checkField(f, f.respuesta)).toBe(true)
        }
      }
    }
  })

  it('acepta formas equivalentes de una respuesta', () => {
    expect(parsePrefix('/26')).toBe(26)
    expect(parsePrefix('26')).toBe(26)
    expect(parsePrefix('255.255.255.192')).toBe(26)
    expect(checkField({ id: 'm', etiqueta: '', formato: 'prefijo', respuesta: '/26' }, '255.255.255.192')).toBe(true)
    expect(checkField({ id: 'n', etiqueta: '', formato: 'numero', respuesta: '4094' }, '4.094')).toBe(true)
    expect(checkField({ id: 's', etiqueta: '', formato: 'si_no', respuesta: 'sí' }, 'si')).toBe(true)
    expect(checkField({ id: 's', etiqueta: '', formato: 'si_no', respuesta: 'no' }, 'si')).toBe(false)
    expect(checkField({ id: 'v', etiqueta: '', formato: 'ipv6', respuesta: '2001:db8::/48' }, '2001:0db8:0:0:0:0:0:0/48')).toBe(true)
    expect(checkField({ id: 'i', etiqueta: '', formato: 'ipv4', respuesta: '10.0.0.0' }, '10.0.0.1')).toBe(false)
  })
})
