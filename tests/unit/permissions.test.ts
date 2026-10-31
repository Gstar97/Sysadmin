import { describe, expect, it } from 'vitest'
import { applyUmask, checkPermAnswer, fromSymbolic, generatePermExercise, toOctal, toSymbolic } from '@/engines/linux/permissions'
import { createRng } from '@/lib/random'

describe('permisos de Linux', () => {
  it('octal y notación de ls -l, con bits especiales', () => {
    expect(toSymbolic(0o750)).toBe('rwxr-x---')
    expect(toSymbolic(0o2770)).toBe('rwxrws---')
    expect(toSymbolic(0o1777)).toBe('rwxrwxrwt')
    expect(toSymbolic(0o4644)).toBe('rwSr--r--')
    expect(fromSymbolic('rwxr-s---')).toBe(0o2750)
    expect(fromSymbolic('-rw-r--r--')).toBe(0o644)
    expect(fromSymbolic('rwxrwxrwz')).toBeNull()
    expect(toOctal(0o640)).toBe('640')
    expect(toOctal(0o2770)).toBe('2770')
  })

  it('umask', () => {
    expect(toOctal(applyUmask(0o022, false))).toBe('644')
    expect(toOctal(applyUmask(0o027, true))).toBe('750')
  })

  it('cada ejercicio generado se responde bien con su propia respuesta', () => {
    const rng = createRng(7)
    for (let i = 0; i < 300; i++) {
      const ex = generatePermExercise(rng, ['sim-oct', 'oct-sim', 'umask', 'acceso'])
      expect(checkPermAnswer(ex, ex.respuesta)).toBe(true)
      expect(ex.pasos.length).toBeGreaterThan(0)
    }
    const ex = { kind: 'sim-oct' as const, pregunta: '', respuesta: '640', pasos: [] }
    expect(checkPermAnswer(ex, '0640')).toBe(true)
    expect(checkPermAnswer(ex, '644')).toBe(false)
  })
})
