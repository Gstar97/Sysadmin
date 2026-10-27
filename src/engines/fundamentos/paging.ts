/**
 * Memoria virtual simplificada: marcos de RAM, caché de disco, swap y OOM killer.
 * Cada página es un bloque de memoria de un proceso; la RAM tiene una cantidad fija de marcos.
 */

export type FrameContent = { kind: 'free' } | { kind: 'cache' } | { kind: 'page'; proc: string; page: number }

export interface MemProc {
  id: string
  nombre: string
  pages: number
  alive: boolean
}

export interface MemState {
  ram: FrameContent[]
  swap: ({ proc: string; page: number } | null)[]
  procs: MemProc[]
  /** Orden de uso reciente de las páginas en RAM (la primera es la usada hace más tiempo). */
  lru: string[]
  pageFaults: number
  swapOuts: number
  log: { text: string; kind: 'info' | 'swap' | 'fault' | 'oom' | 'cache' }[]
}

const key = (proc: string, page: number) => `${proc}:${page}`

export function createMemory(frames: number, swapSlots: number, procs: { id: string; nombre: string }[], cacheFrames = 0): MemState {
  return {
    ram: Array.from({ length: frames }, (_, i) => (i < cacheFrames ? { kind: 'cache' } : { kind: 'free' })),
    swap: Array.from({ length: swapSlots }, () => null),
    procs: procs.map((p) => ({ ...p, pages: 0, alive: true })),
    lru: [],
    pageFaults: 0,
    swapOuts: 0,
    log: [],
  }
}

function clone(s: MemState): MemState {
  return { ...s, ram: s.ram.map((f) => ({ ...f })), swap: [...s.swap], procs: s.procs.map((p) => ({ ...p })), lru: [...s.lru], log: [...s.log] }
}

function touch(s: MemState, proc: string, page: number) {
  const k = key(proc, page)
  s.lru = [...s.lru.filter((x) => x !== k), k]
}

/** Consigue un marco libre: primero libre, después liberando caché, después mandando a swap la página menos usada. */
function getFrame(s: MemState, forProc: string): number | 'oom' {
  const free = s.ram.findIndex((f) => f.kind === 'free')
  if (free !== -1) return free
  const cache = s.ram.findIndex((f) => f.kind === 'cache')
  if (cache !== -1) {
    s.log.push({ text: 'No quedaba memoria libre: el kernel descartó un bloque de la caché de disco (se puede volver a leer del disco cuando haga falta).', kind: 'cache' })
    return cache
  }
  const slot = s.swap.findIndex((x) => x === null)
  const victimKey = s.lru.find((k) => !k.startsWith(`${forProc}:`)) ?? s.lru[0]
  if (slot === -1 || !victimKey) return 'oom'
  const [vp, vn] = victimKey.split(':')
  const frame = s.ram.findIndex((f) => f.kind === 'page' && f.proc === vp && f.page === Number(vn))
  s.swap[slot] = { proc: vp, page: Number(vn) }
  s.lru = s.lru.filter((k) => k !== victimKey)
  s.swapOuts++
  s.log.push({ text: `RAM llena: la página ${vn} de ${nameOf(s, vp)} (la usada hace más tiempo) se mandó al swap.`, kind: 'swap' })
  return frame
}

function nameOf(s: MemState, id: string) {
  return s.procs.find((p) => p.id === id)?.nombre ?? id
}

function oomKill(s: MemState, requester: string) {
  // El OOM killer elige al proceso que más memoria usa (en Linux, el de mayor oom_score).
  const victim = [...s.procs].filter((p) => p.alive).sort((a, b) => b.pages - a.pages)[0]
  if (!victim) return
  victim.alive = false
  s.ram = s.ram.map((f) => (f.kind === 'page' && f.proc === victim.id ? { kind: 'free' } : f))
  s.swap = s.swap.map((x) => (x && x.proc === victim.id ? null : x))
  s.lru = s.lru.filter((k) => !k.startsWith(`${victim.id}:`))
  s.log.push({ text: `Sin RAM ni swap disponibles. El OOM killer terminó a ${victim.nombre}, el proceso que más memoria usaba (${victim.pages} páginas)${victim.id === requester ? '' : `, aunque el que pidió memoria fue ${nameOf(s, requester)}`}. En el log del sistema quedaría "Out of memory: Killed process".`, kind: 'oom' })
  victim.pages = 0
}

/** Un proceso pide una página más de memoria. */
export function allocate(prev: MemState, proc: string): MemState {
  const s = clone(prev)
  const p = s.procs.find((x) => x.id === proc)
  if (!p || !p.alive) return prev
  let frame = getFrame(s, proc)
  if (frame === 'oom') {
    oomKill(s, proc)
    if (!s.procs.find((x) => x.id === proc)!.alive) return s
    frame = getFrame(s, proc)
    if (frame === 'oom') return s
  }
  const page = p.pages
  s.ram[frame] = { kind: 'page', proc, page }
  p.pages++
  touch(s, proc, page)
  s.log.push({ text: `${p.nombre} reservó la página ${page}.`, kind: 'info' })
  return s
}

/** Un proceso usa una de sus páginas: si está en swap, hay un fallo de página y se trae a la RAM. */
export function access(prev: MemState, proc: string, page: number): MemState {
  const s = clone(prev)
  const p = s.procs.find((x) => x.id === proc)
  if (!p || !p.alive || page >= p.pages) return prev
  const inRam = s.ram.some((f) => f.kind === 'page' && f.proc === proc && f.page === page)
  if (inRam) {
    touch(s, proc, page)
    s.log.push({ text: `${p.nombre} usó su página ${page}: estaba en RAM, acceso inmediato.`, kind: 'info' })
    return s
  }
  const slot = s.swap.findIndex((x) => x && x.proc === proc && x.page === page)
  s.pageFaults++
  s.swap[slot] = null
  const frame = getFrame(s, proc)
  if (frame === 'oom') {
    s.swap[slot] = { proc, page }
    oomKill(s, proc)
    return s
  }
  s.ram[frame] = { kind: 'page', proc, page }
  touch(s, proc, page)
  s.log.push({ text: `Fallo de página: la página ${page} de ${p.nombre} estaba en el swap y hubo que leerla del disco (miles de veces más lento que la RAM).`, kind: 'fault' })
  return s
}

/** El kernel usa memoria libre como caché de disco (se ve como "buff/cache"). */
export function fillCache(prev: MemState): MemState {
  const s = clone(prev)
  const free = s.ram.findIndex((f) => f.kind === 'free')
  if (free === -1) return prev
  s.ram[free] = { kind: 'cache' }
  s.log.push({ text: 'Se leyó un archivo del disco y el kernel guardó una copia en la memoria libre (caché de disco).', kind: 'cache' })
  return s
}

export function memoryStats(s: MemState) {
  const used = s.ram.filter((f) => f.kind === 'page').length
  const cache = s.ram.filter((f) => f.kind === 'cache').length
  const free = s.ram.filter((f) => f.kind === 'free').length
  return { total: s.ram.length, used, cache, free, available: free + cache, swapUsed: s.swap.filter(Boolean).length, swapTotal: s.swap.length }
}
