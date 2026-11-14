import { describe, expect, it } from 'vitest'
import { ace } from '@/engines/windows/permisos'
import { __test } from '@/interactive/windows/PermissionSimulator'

const { INICIAL, INICIAL_RED, DESAFIOS_NTFS, DESAFIOS_RED, ROOT } = __test
const clone = <T,>(x: T): T => structuredClone(x)
const base = [ace('BUILTIN\\Administrators', 'FullControl'), ace('NT AUTHORITY\\SYSTEM', 'FullControl')]

describe('Simulador de permisos: los desafíos se pueden resolver', () => {
  it('NTFS', () => {
    const e = clone(INICIAL)
    expect(DESAFIOS_NTFS.map((d) => d.ok(e))).toEqual([false, false, false])
    e.sds[`${ROOT}\\Ventas`] = { owner: 'BUILTIN\\Administrators', protected: true, entries: [...clone(base), ace('EMPRESA\\DL-Ventas-Modificar', 'Modify')] }
    e.sds[`${ROOT}\\Ventas\\Precios`] = { owner: 'BUILTIN\\Administrators', protected: false, entries: [ace('EMPRESA\\GG-Pasantes', ['W', 'A', 'D'], 'Deny')] }
    e.sds[`${ROOT}\\Compras`] = { owner: 'BUILTIN\\Administrators', protected: true, entries: [...clone(base), ace('EMPRESA\\DL-Compras-Modificar', 'Modify')] }
    expect(DESAFIOS_NTFS.map((d) => d.ok(e))).toEqual([true, true, true])
  })

  it('por la red', () => {
    const e = clone(INICIAL_RED)
    expect(DESAFIOS_RED.map((d) => d.ok(e))).toEqual([false, false, false])
    e.share = [{ identity: 'NT AUTHORITY\\Authenticated Users', level: 'Full', type: 'Allow' }]
    e.sds[`${ROOT}\\Ventas`].entries.push(ace('EMPRESA\\GG-Pasantes', ['D'], 'Deny'))
    expect(DESAFIOS_RED.map((d) => d.ok(e))).toEqual([true, true, true])
  })
})
