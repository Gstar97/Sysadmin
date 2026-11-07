/**
 * Convergencia de protocolos de enrutamiento, paso a paso, en un grafo chico.
 * - Vector distancia (como RIP): en cada paso, cada router le pasa a sus vecinos su tabla
 *   (con horizonte dividido) y recalcula con lo que le llegó. Las noticias avanzan de a un salto
 *   y una ruta perdida puede tardar varios pasos en desaparecer.
 * - Estado de enlace (como OSPF): el cambio se inunda a todos los routers (un salto por paso) y
 *   cada uno que recibe el aviso recalcula con el mapa completo (Dijkstra).
 */

export interface Enlace {
  a: string
  b: string
  costo: number
  up: boolean
}

export interface Grafo {
  nodos: string[]
  enlaces: Enlace[]
}

export interface Entrada {
  costo: number
  via?: string
}

export type Tabla = Record<string, Entrada>

/** Métrica que se considera inalcanzable (como el 16 de RIP). */
export const INFINITO = 16

function vecinos(g: Grafo, n: string): { v: string; costo: number }[] {
  return g.enlaces.filter((e) => e.up && (e.a === n || e.b === n)).map((e) => ({ v: e.a === n ? e.b : e.a, costo: e.costo }))
}

/** Caminos más cortos desde un nodo con los enlaces que estén arriba (Dijkstra). */
export function dijkstra(g: Grafo, origen: string): Tabla {
  const dist: Record<string, Entrada> = { [origen]: { costo: 0 } }
  const done = new Set<string>()
  while (true) {
    const cand = Object.entries(dist)
      .filter(([n]) => !done.has(n))
      .sort((x, y) => x[1].costo - y[1].costo || x[0].localeCompare(y[0]))[0]
    if (!cand) break
    const [n, d] = cand
    done.add(n)
    for (const { v, costo } of vecinos(g, n)) {
      const c = d.costo + costo
      if (!dist[v] || c < dist[v].costo) dist[v] = { costo: c, via: n === origen ? v : d.via }
    }
  }
  const t: Tabla = {}
  for (const n of g.nodos) t[n] = dist[n] ?? { costo: INFINITO }
  return t
}

export function tablasCorrectas(g: Grafo): Record<string, Tabla> {
  return Object.fromEntries(g.nodos.map((n) => [n, dijkstra(g, n)]))
}

export function igualTabla(a: Tabla, b: Tabla): boolean {
  return Object.keys(b).every((k) => {
    const x = a[k]
    const y = b[k]
    if (y.costo >= INFINITO) return !x || x.costo >= INFINITO
    return !!x && x.costo === y.costo && x.via === y.via
  })
}

// --- Vector distancia --------------------------------------------------------------------

/** Al cortarse un enlace, los dos extremos se dan cuenta enseguida: invalidan lo que pasaba por ahí. */
export function dvDetectar(g: Grafo, tablas: Record<string, Tabla>): Record<string, Tabla> {
  const out: Record<string, Tabla> = {}
  for (const n of g.nodos) {
    const vs = new Set(vecinos(g, n).map((x) => x.v))
    out[n] = Object.fromEntries(Object.entries(tablas[n]).map(([d, e]) => [d, e.via && !vs.has(e.via) ? { costo: INFINITO } : e]))
  }
  return out
}

/** Un intercambio de tablas entre vecinos (todos a la vez), con horizonte dividido. */
export function dvPaso(g: Grafo, tablas: Record<string, Tabla>): Record<string, Tabla> {
  const out: Record<string, Tabla> = {}
  for (const n of g.nodos) {
    const t: Tabla = { [n]: { costo: 0 } }
    for (const d of g.nodos) {
      if (d === n) continue
      let best: Entrada = { costo: INFINITO }
      // Lo que ya tenía por un vecino sigue valiendo lo que ese vecino diga ahora.
      for (const { v, costo } of vecinos(g, n)) {
        const anuncio = tablas[v][d]
        if (!anuncio || anuncio.via === n) continue
        const c = Math.min(INFINITO, anuncio.costo + costo)
        if (c < best.costo || (c === best.costo && best.via !== undefined && v < best.via)) best = c >= INFINITO ? { costo: INFINITO } : { costo: c, via: v }
      }
      t[d] = best
    }
    out[n] = t
  }
  return out
}

export function dvInicial(g: Grafo): Record<string, Tabla> {
  return Object.fromEntries(g.nodos.map((n) => [n, Object.fromEntries(g.nodos.map((d) => [d, d === n ? { costo: 0 } : { costo: INFINITO }]))]))
}

// --- Estado de enlace --------------------------------------------------------------------

/**
 * Quién ya recibió el aviso del cambio. Arrancan los dos extremos del enlace cortado; en cada
 * paso, el aviso avanza un salto por los enlaces que siguen arriba.
 */
export function lsPaso(g: Grafo, enterados: Set<string>): Set<string> {
  const out = new Set(enterados)
  for (const n of enterados) for (const { v } of vecinos(g, n)) out.add(v)
  return out
}

/** Tablas en estado de enlace: el que ya se enteró calcula con el mapa nuevo; el resto sigue con el viejo. */
export function lsTablas(viejo: Grafo, nuevo: Grafo, enterados: Set<string>): Record<string, Tabla> {
  return Object.fromEntries(nuevo.nodos.map((n) => [n, enterados.has(n) ? dijkstra(nuevo, n) : dijkstra(viejo, n)]))
}

export const GRAFO_EJEMPLO: Grafo = {
  nodos: ['A', 'B', 'C', 'D', 'E'],
  enlaces: [
    { a: 'A', b: 'B', costo: 1, up: true },
    { a: 'B', b: 'C', costo: 1, up: true },
    { a: 'C', b: 'D', costo: 1, up: true },
    { a: 'A', b: 'E', costo: 4, up: true },
    { a: 'E', b: 'D', costo: 3, up: true },
    { a: 'B', b: 'E', costo: 2, up: true },
  ],
}
