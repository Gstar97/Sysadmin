import { describe, expect, it } from 'vitest'
import { createVim, isModified, statusLine, verifyVim, vimKeys } from '@/engines/vim'

const conf = 'Port 22\nPermitRootLogin yes\nPasswordAuthentication yes\n# fin\n'

describe('simulador de vim', () => {
  it('modos, inserción y guardado', () => {
    let s = createVim(conf, 'sshd_config')
    s = vimKeys(s, 'GoMaxAuthTries 3<Esc>')
    expect(s.lines[4]).toBe('MaxAuthTries 3')
    expect(s.mode).toBe('normal')
    expect(isModified(s)).toBe(true)
    s = vimKeys(s, ':q<CR>')
    expect(s.quit).toBe(false)
    expect(statusLine(s).left).toContain('E37')
    s = vimKeys(s, ':wq<CR>')
    expect(s.quit).toBe(true)
    expect(verifyVim(s, { guardado: true }).ok).toBe(true)
  })

  it('movimientos, borrar, copiar, deshacer y contadores', () => {
    let s = createVim('uno\ndos\ntres\ncuatro\ncinco\n')
    s = vimKeys(s, '3G')
    expect(s.row).toBe(2)
    s = vimKeys(s, '2dd')
    expect(s.lines).toEqual(['uno', 'dos', 'cinco'])
    s = vimKeys(s, 'u')
    expect(s.lines).toEqual(['uno', 'dos', 'tres', 'cuatro', 'cinco'])
    s = vimKeys(s, '<C-r>')
    expect(s.lines.length).toBe(3)
    s = vimKeys(s, 'ggyyGp')
    expect(s.lines).toEqual(['uno', 'dos', 'cinco', 'uno'])
    s = vimKeys(s, 'gg0x')
    expect(s.lines[0]).toBe('no')
    s = vimKeys(s, 'rN')
    expect(s.lines[0]).toBe('No')
    expect(verifyVim(s, { comando_usado: '^\\d*dd$' }).ok).toBe(true)
  })

  it('palabras, búsqueda y reemplazo', () => {
    let s = createVim(conf)
    s = vimKeys(s, 'jwcwno<Esc>')
    expect(s.lines[1]).toBe('PermitRootLogin no')
    s = vimKeys(s, 'gg/Password<CR>')
    expect(s.row).toBe(2)
    s = vimKeys(s, '/zzz<CR>')
    expect(statusLine(s)).toEqual({ left: 'E486: Pattern not found: zzz', error: true })
    s = vimKeys(s, ':%s/yes/no/g<CR>')
    expect(s.lines.join('\n')).not.toContain('yes')
    s = vimKeys(s, ':set nu<CR>')
    expect(s.numbers).toBe(true)
    s = vimKeys(s, ':q!<CR>')
    expect(s.quit && isModified(s)).toBe(true)
  })

  it('w, b, e, $ y dw', () => {
    let s = createVim('listen 80 default_server;')
    s = vimKeys(s, 'w')
    expect(s.col).toBe(7)
    s = vimKeys(s, 'e')
    expect(s.col).toBe(8)
    s = vimKeys(s, '$')
    expect(s.col).toBe(24)
    s = vimKeys(s, '0wdw')
    expect(s.lines[0]).toBe('listen default_server;')
    s = vimKeys(s, 'Ab')
    expect(s.mode).toBe('insert')
  })
})
