import { describe, expect, it } from 'vitest'
import { ace, effectiveAcl, effectiveRights, intersect, levelOf, shareRights, icaclsText, type FsTree, type SecurityDescriptor } from '@/engines/windows/permisos'

function tree(sds: Record<string, SecurityDescriptor>, files: string[] = []): FsTree {
  return {
    sd: (p) => sds[p.toLowerCase()],
    isDir: (p) => !files.includes(p),
    parent: (p) => (p.length <= 3 ? undefined : p.lastIndexOf('\\') <= 2 ? p.slice(0, 3) : p.slice(0, p.lastIndexOf('\\'))),
  }
}

const D_ROOT: SecurityDescriptor = {
  owner: 'BUILTIN\\Administrators',
  protected: true,
  entries: [
    ace('NT AUTHORITY\\SYSTEM', 'FullControl'),
    ace('BUILTIN\\Administrators', 'FullControl'),
    ace('BUILTIN\\Users', 'ReadAndExecute'),
    ace('BUILTIN\\Users', ['A'], 'Allow', { ci: true }),
    ace('BUILTIN\\Users', ['W'], 'Allow', { ci: true, io: true }),
    ace('CREATOR OWNER', 'FullControl', 'Allow', { oi: true, ci: true, io: true }),
  ],
}
const maria = ['EMPRESA\\mlopez', 'EMPRESA\\GG-Ventas', 'EMPRESA\\Domain Users', 'BUILTIN\\Users', 'Everyone', 'NT AUTHORITY\\Authenticated Users']

describe('permisos NTFS', () => {
  it('por defecto, en una carpeta nueva de D:, los usuarios leen todo', () => {
    const t = tree({ 'd:\\': D_ROOT })
    const acl = effectiveAcl(t, 'D:\\Datos\\Ventas')
    expect(levelOf(effectiveRights(acl, maria))).toBe('Special')
    expect(effectiveRights(acl, maria).has('R')).toBe(true)
    expect(acl.every((e) => e.inherited)).toBe(true)
  })

  it('herencia deshabilitada con permisos explícitos: solo el grupo del área', () => {
    const t = tree({
      'd:\\': D_ROOT,
      'd:\\datos\\ventas': { owner: 'BUILTIN\\Administrators', protected: true, entries: [ace('BUILTIN\\Administrators', 'FullControl'), ace('EMPRESA\\GG-Ventas', 'Modify')] },
    })
    expect(levelOf(effectiveRights(effectiveAcl(t, 'D:\\Datos\\Ventas'), maria))).toBe('Modify')
    expect(levelOf(effectiveRights(effectiveAcl(t, 'D:\\Datos\\Ventas\\informe.xlsx'), ['EMPRESA\\jperez', 'BUILTIN\\Users']))).toBe('None')
  })

  it('una denegación explícita le gana a un permiso explícito; un permiso explícito le gana a una denegación heredada', () => {
    const t = tree({
      'd:\\': { owner: 'x', protected: true, entries: [ace('EMPRESA\\GG-Ventas', 'Modify'), ace('EMPRESA\\mlopez', ['W', 'A'], 'Deny')] },
      'd:\\a': { owner: 'x', protected: false, entries: [ace('EMPRESA\\mlopez', 'Modify')] },
    })
    expect(effectiveRights(effectiveAcl(t, 'D:\\'), maria).has('W')).toBe(false)
    expect(effectiveRights(effectiveAcl(t, 'D:\\a'), maria).has('W')).toBe(true)
  })

  it('solo carpetas (CI) no llega a los archivos', () => {
    const t = tree({ 'd:\\': { owner: 'x', protected: true, entries: [ace('EMPRESA\\GG-Ventas', 'Modify', 'Allow', { ci: true })] } }, ['D:\\a\\b.txt'])
    expect(effectiveRights(effectiveAcl(t, 'D:\\a'), maria).size).toBe(5)
    expect(effectiveRights(effectiveAcl(t, 'D:\\a\\b.txt'), maria).size).toBe(0)
  })

  it('por la red gana el más restrictivo', () => {
    const ntfs = new Set(['R', 'X', 'W', 'A', 'D'] as const)
    const share = shareRights([{ identity: 'Everyone', level: 'Read', type: 'Allow' }], maria)
    expect(levelOf(intersect(new Set(ntfs), share))).toBe('ReadAndExecute')
  })

  it('icacls muestra las marcas', () => {
    expect(icaclsText(ace('EMPRESA\\GG-Ventas', 'Modify'))).toBe('EMPRESA\\GG-Ventas:(OI)(CI)(M)')
    expect(icaclsText(ace('CREATOR OWNER', 'FullControl', 'Allow', { oi: true, ci: true, io: true }), true)).toBe('CREATOR OWNER:(I)(OI)(CI)(IO)(F)')
  })
})
