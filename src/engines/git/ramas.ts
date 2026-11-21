/**
 * Un grafo de commits mínimo para el simulador de ramas: commits, ramas, HEAD y fusiones
 * (avance rápido o commit de fusión), con los comandos de git que lo mueven.
 */

export interface GCommit {
  id: string
  parents: string[]
  mensaje: string
  /** Carril donde se dibuja (la rama en la que se creó). */
  carril: number
  orden: number
}

export interface Grafo {
  commits: GCommit[]
  ramas: Record<string, string>
  /** Rama actual, o un commit suelto. */
  head: { rama: string } | { commit: string }
  carriles: Record<string, number>
  siguiente: number
}

export function inicial(): Grafo {
  return { commits: [{ id: 'c0', parents: [], mensaje: 'Primera versión', carril: 0, orden: 0 }], ramas: { main: 'c0' }, head: { rama: 'main' }, carriles: { main: 0 }, siguiente: 1 }
}

function headId(g: Grafo): string {
  return 'rama' in g.head ? g.ramas[g.head.rama] : g.head.commit
}

function ancestros(g: Grafo, id: string): Set<string> {
  const out = new Set<string>()
  const pila = [id]
  while (pila.length) {
    const c = pila.pop()!
    if (out.has(c)) continue
    out.add(c)
    pila.push(...(g.commits.find((x) => x.id === c)?.parents ?? []))
  }
  return out
}

export interface Resultado {
  grafo: Grafo
  salida: string
  error?: boolean
}

/** Ejecuta un comando de git sobre el grafo (sin tocar el original). */
export function ejecutar(g0: Grafo, linea: string): Resultado {
  const g: Grafo = structuredClone(g0)
  const t = linea.trim().replace(/\s+/g, ' ').split(' ')
  if (t[0] !== 'git') return { grafo: g0, salida: `Este simulador solo entiende comandos de git (git commit, git branch, git switch, git merge, git log).`, error: true }
  const [, cmd, ...args] = t
  const rama = 'rama' in g.head ? g.head.rama : undefined
  const nuevoCommit = (mensaje: string, parents: string[]) => {
    const id = `c${g.siguiente++}`
    const carril = rama ? g.carriles[rama] : (g.commits.find((c) => c.id === parents[0])?.carril ?? 0)
    g.commits.push({ id, parents, mensaje, carril, orden: g.commits.length })
    if (rama) g.ramas[rama] = id
    else g.head = { commit: id }
    return id
  }
  switch (cmd) {
    case 'commit': {
      const m = /-m ["']?(.+?)["']?$/.exec(linea)?.[1] ?? `Cambio ${g.siguiente}`
      const id = nuevoCommit(m, [headId(g)])
      return { grafo: g, salida: `[${rama ?? 'HEAD suelto'} ${id}] ${m}` }
    }
    case 'branch': {
      if (!args.length) return { grafo: g, salida: Object.keys(g.ramas).map((r) => `${r === rama ? '* ' : '  '}${r}`).join('\n') }
      if (args[0] === '-d' || args[0] === '-D') {
        const r = args[1]
        if (!g.ramas[r]) return { grafo: g0, salida: `error: branch '${r}' not found`, error: true }
        if (r === rama) return { grafo: g0, salida: `error: cannot delete branch '${r}' (es la rama actual)`, error: true }
        if (args[0] === '-d' && !ancestros(g, headId(g)).has(g.ramas[r])) return { grafo: g0, salida: `error: the branch '${r}' is not fully merged.\nSi estás seguro, git branch -D ${r}`, error: true }
        delete g.ramas[r]
        return { grafo: g, salida: `Deleted branch ${r}.` }
      }
      const r = args[0]
      if (g.ramas[r]) return { grafo: g0, salida: `fatal: a branch named '${r}' already exists`, error: true }
      g.ramas[r] = headId(g)
      g.carriles[r] = Math.max(...Object.values(g.carriles)) + 1
      return { grafo: g, salida: '' }
    }
    case 'switch':
    case 'checkout': {
      const crear = args[0] === '-c' || args[0] === '-b'
      const r = crear ? args[1] : args[0]
      if (!r) return { grafo: g0, salida: 'fatal: missing branch or commit argument', error: true }
      if (crear) {
        if (g.ramas[r]) return { grafo: g0, salida: `fatal: a branch named '${r}' already exists`, error: true }
        g.ramas[r] = headId(g)
        g.carriles[r] = Math.max(...Object.values(g.carriles)) + 1
        g.head = { rama: r }
        return { grafo: g, salida: `Switched to a new branch '${r}'` }
      }
      if (g.ramas[r]) {
        g.head = { rama: r }
        return { grafo: g, salida: `Switched to branch '${r}'` }
      }
      if (g.commits.some((c) => c.id === r)) {
        g.head = { commit: r }
        return { grafo: g, salida: `HEAD is now at ${r} (HEAD suelto: los commits que hagas acá no quedan en ninguna rama)` }
      }
      return { grafo: g0, salida: `fatal: invalid reference: ${r}`, error: true }
    }
    case 'merge': {
      const noFf = args.includes('--no-ff')
      const r = args.find((a) => !a.startsWith('-'))
      if (!r || !g.ramas[r]) return { grafo: g0, salida: `merge: ${r ?? ''} - not something we can merge`, error: true }
      const h = headId(g)
      const o = g.ramas[r]
      if (ancestros(g, h).has(o)) return { grafo: g0, salida: 'Already up to date.' }
      if (ancestros(g, o).has(h) && !noFf) {
        if (rama) g.ramas[rama] = o
        else g.head = { commit: o }
        return { grafo: g, salida: `Updating ${h}..${o}\nFast-forward (avance rápido: ${rama ?? 'HEAD'} solo se movió hasta ${o})` }
      }
      const id = nuevoCommit(`Merge branch '${r}'`, [h, o])
      return { grafo: g, salida: `Merge made by the 'ort' strategy. (commit de fusión ${id}, con dos padres)` }
    }
    case 'log': {
      const lista = [...ancestros(g, headId(g))].map((id) => g.commits.find((c) => c.id === id)!).sort((a, b) => b.orden - a.orden)
      return { grafo: g, salida: lista.map((c) => `${c.id} ${c.mensaje}`).join('\n') }
    }
    case 'status':
      return { grafo: g, salida: rama ? `On branch ${rama}\nnothing to commit, working tree clean` : `HEAD detached at ${headId(g)}` }
    case 'reset': {
      const hard = args.includes('--hard')
      const target = args.find((a) => !a.startsWith('-'))
      const id = target === 'HEAD~1' || target === 'HEAD^' ? g.commits.find((c) => c.id === headId(g))?.parents[0] : target
      if (!id || !g.commits.some((c) => c.id === id)) return { grafo: g0, salida: `fatal: ambiguous argument '${target ?? ''}'`, error: true }
      if (rama) g.ramas[rama] = id
      return { grafo: g, salida: `${hard ? 'HEAD is now at' : 'Unstaged changes after reset:'} ${id}` }
    }
    default:
      return { grafo: g0, salida: `git: '${cmd ?? ''}' no está en este simulador. Probá: commit -m, branch, switch (-c), merge (--no-ff), log, reset --hard HEAD~1.`, error: true }
  }
}

export function head(g: Grafo) {
  return { id: headId(g), rama: 'rama' in g.head ? g.head.rama : undefined }
}

/** Commits que ya no se alcanzan desde ninguna rama (quedarían huérfanos). */
export function huerfanos(g: Grafo): Set<string> {
  const vivos = new Set<string>()
  for (const id of [...Object.values(g.ramas), headId(g)]) for (const a of ancestros(g, id)) vivos.add(a)
  return new Set(g.commits.filter((c) => !vivos.has(c.id)).map((c) => c.id))
}
