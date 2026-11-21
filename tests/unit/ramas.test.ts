import { describe, expect, it } from 'vitest'
import { ejecutar, head, huerfanos, inicial, type Grafo } from '@/engines/git/ramas'

function correr(cmds: string[], g: Grafo = inicial()) {
  let out = ''
  for (const c of cmds) {
    const r = ejecutar(g, c)
    g = r.grafo
    out = r.salida
  }
  return { g, out }
}

describe('simulador de ramas', () => {
  it('avance rápido y commit de fusión', () => {
    let { g, out } = correr(['git switch -c cambio', 'git commit -m "A"', 'git switch main', 'git merge cambio'])
    expect(out).toContain('Fast-forward')
    expect(g.ramas.main).toBe(g.ramas.cambio)
    ;({ g, out } = correr(['git switch -c otra', 'git commit -m B', 'git switch main', 'git commit -m C', 'git merge otra'], g))
    expect(out).toContain('ort')
    const m = g.commits.find((c) => c.id === g.ramas.main)!
    expect(m.parents).toHaveLength(2)
  })
  it('no borra una rama sin fusionar; reset deja huérfanos', () => {
    const { g } = correr(['git switch -c x', 'git commit -m X', 'git switch main'])
    expect(ejecutar(g, 'git branch -d x').error).toBe(true)
    const r = correr(['git commit -m Y', 'git reset --hard HEAD~1'], g)
    expect(huerfanos(r.g).size).toBe(1)
    expect(head(r.g).rama).toBe('main')
  })
})
