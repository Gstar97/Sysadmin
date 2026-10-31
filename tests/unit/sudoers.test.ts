import { describe, expect, it } from 'vitest'
import { validateSudoers } from '@/engines/config/sudoers'

describe('validador de sudoers', () => {
  it('acepta reglas correctas', () => {
    const r = validateSudoers('Cmnd_Alias WEB = /usr/bin/systemctl restart nginx, /usr/bin/systemctl status nginx\n%soporte ALL=(root) WEB\nlaura ALL=(root) NOPASSWD: /usr/bin/journalctl -u nginx\n')
    expect(r.diagnostics).toEqual([])
    expect(r.rules).toHaveLength(2)
    expect(r.rules[1].tags).toEqual(['NOPASSWD'])
  })

  it('explica los errores típicos', () => {
    const errs = (t: string) => validateSudoers(t).diagnostics.map((d) => d.message).join(' | ')
    expect(errs('%soporte ALL=(root) systemctl restart nginx')).toContain('ruta completa')
    expect(errs('SOPORTE ALL=(root) /usr/bin/ls')).toContain('alias que no está definido')
    expect(errs('%soporte ALL=(root /usr/bin/ls')).toContain('paréntesis')
    expect(errs('laura ALL')).toContain('syntax error')
    expect(errs('ana ALL=(ALL) NOPASSWD: ALL')).toContain('NOPASSWD con ALL')
    expect(errs('ana ALL=(root) /usr/bin/vim')).toContain('root completo')
  })
})
