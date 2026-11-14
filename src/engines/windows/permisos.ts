/**
 * Permisos NTFS y de recurso compartido, como los evalúa Windows.
 *
 * - Cada permiso es un conjunto de derechos simples (leer, recorrer, escribir, agregar, borrar,
 *   cambiar permisos, tomar posesión).
 * - Las entradas (ACE) se heredan según sus marcas (OI: archivos, CI: carpetas, IO: solo a los
 *   hijos, NP: un solo nivel).
 * - Se evalúan en orden canónico: denegaciones explícitas, permisos explícitos, y después las
 *   heredadas, de la más cercana a la más lejana. Para cada derecho, la primera entrada que lo
 *   menciona decide. Por eso un permiso explícito le gana a una denegación heredada.
 * - Por la red, el acceso es la intersección del permiso del recurso compartido y el NTFS.
 */

export type Right = 'R' | 'X' | 'W' | 'A' | 'D' | 'P' | 'O'
export const ALL_RIGHTS: Right[] = ['R', 'X', 'W', 'A', 'D', 'P', 'O']

export type Level = 'FullControl' | 'Modify' | 'ReadAndExecute' | 'Read' | 'Write' | 'ListDirectory'

export const LEVEL_RIGHTS: Record<Level, Right[]> = {
  FullControl: ['R', 'X', 'W', 'A', 'D', 'P', 'O'],
  Modify: ['R', 'X', 'W', 'A', 'D'],
  ReadAndExecute: ['R', 'X'],
  ListDirectory: ['R', 'X'],
  Read: ['R'],
  Write: ['W', 'A'],
}

/** Abreviaturas de icacls. */
export const ICACLS: Record<string, Right[]> = {
  F: LEVEL_RIGHTS.FullControl,
  M: LEVEL_RIGHTS.Modify,
  RX: LEVEL_RIGHTS.ReadAndExecute,
  R: ['R'],
  W: ['W', 'A'],
  D: ['D'],
  WD: ['W'],
  AD: ['A'],
  X: ['X'],
  WDAC: ['P'],
  WO: ['O'],
}

export interface Ace {
  identity: string
  rights: Right[]
  type: 'Allow' | 'Deny'
  /** Se hereda a los archivos (OI) y a las carpetas (CI). */
  oi: boolean
  ci: boolean
  /** Solo para los hijos, no para el objeto donde está (IO). */
  io: boolean
  /** Solo un nivel (NP). */
  np: boolean
}

export interface AceView extends Ace {
  inherited: boolean
  /** De qué carpeta viene (para las heredadas). */
  from?: string
  /** Distancia en niveles (0: explícita). */
  depth: number
}

export interface SecurityDescriptor {
  owner: string
  /** Herencia deshabilitada. */
  protected: boolean
  entries: Ace[]
}

export function ace(identity: string, rights: Right[] | Level, type: 'Allow' | 'Deny' = 'Allow', flags: Partial<Pick<Ace, 'oi' | 'ci' | 'io' | 'np'>> = { oi: true, ci: true }): Ace {
  return { identity, rights: typeof rights === 'string' ? [...LEVEL_RIGHTS[rights]] : [...rights], type, oi: !!flags.oi, ci: !!flags.ci, io: !!flags.io, np: !!flags.np }
}

/** ¿Una entrada de la carpeta padre llega a un hijo de ese tipo? Devuelve la entrada como queda en el hijo. */
export function inheritTo(a: Ace, childIsDir: boolean): Ace | undefined {
  if (childIsDir ? !a.ci && !a.oi : !a.oi) return undefined
  if (!childIsDir) return { ...a, oi: false, ci: false, io: false, np: false }
  // Una carpeta hija recibe lo de OI solo como "para sus archivos" (IO) si no tiene CI.
  if (!a.ci) return a.np ? undefined : { ...a, io: true }
  if (a.np) return { ...a, oi: false, ci: false, io: false, np: false }
  return { ...a, io: false }
}

export interface FsTree {
  /** Descriptor explícito de una ruta (si tiene). */
  sd(path: string): SecurityDescriptor | undefined
  isDir(path: string): boolean
  parent(path: string): string | undefined
}

/** Todas las entradas que aplican a una ruta, en orden canónico (con las heredadas). */
export function effectiveAcl(tree: FsTree, path: string): AceView[] {
  const chain: { path: string; sd?: SecurityDescriptor }[] = []
  let cur: string | undefined = path
  while (cur) {
    const sd = tree.sd(cur)
    chain.push({ path: cur, sd })
    if (sd?.protected) break
    cur = tree.parent(cur)
  }
  // Recorremos desde arriba propagando hacia abajo.
  let carried: AceView[] = []
  for (let i = chain.length - 1; i >= 0; i--) {
    const node = chain[i]
    const explicit: AceView[] = (node.sd?.entries ?? []).map((e) => ({ ...e, inherited: false, depth: 0 }))
    const here = [...explicit, ...carried]
    if (i === 0) {
      // Orden canónico: explícitas (denegar, permitir) y después cada nivel heredado (denegar, permitir).
      const depths = [...new Set(carried.map((e) => e.depth))].sort((a, b) => a - b)
      const byType = (x: AceView[]) => [...x.filter((e) => e.type === 'Deny'), ...x.filter((e) => e.type === 'Allow')]
      return [...byType(explicit), ...depths.flatMap((d) => byType(carried.filter((e) => e.depth === d)))]
    }
    const childIsDir = tree.isDir(chain[i - 1].path)
    const next: AceView[] = []
    for (const e of here) {
      const inh = inheritTo(e, childIsDir)
      if (inh) next.push({ ...inh, inherited: true, from: e.inherited ? e.from : node.path, depth: e.depth + 1 })
    }
    carried = next
  }
  return carried
}

/** Las entradas que aplican al objeto mismo (sin las IO). */
export function applicable(acl: AceView[]): AceView[] {
  return acl.filter((e) => !e.io)
}

/** Derechos efectivos de alguien con estos SID (nombres) sobre una ACL. */
export function effectiveRights(acl: AceView[], principals: string[], owner?: string): Set<Right> {
  const who = new Set(principals.map((p) => p.toLowerCase()))
  const out = new Set<Right>()
  for (const r of ALL_RIGHTS) {
    for (const e of applicable(acl)) {
      if (!who.has(e.identity.toLowerCase()) || !e.rights.includes(r)) continue
      if (e.type === 'Allow') out.add(r)
      break
    }
  }
  // El dueño siempre puede cambiar los permisos.
  if (owner && who.has(owner.toLowerCase())) out.add('P')
  return out
}

export function levelOf(rights: Set<Right> | Right[]): Level | 'None' | 'Special' {
  const set = new Set(rights)
  if (!set.size) return 'None'
  for (const l of ['FullControl', 'Modify', 'ReadAndExecute', 'Read', 'Write'] as Level[]) {
    const want = LEVEL_RIGHTS[l]
    if (want.length === set.size && want.every((r) => set.has(r))) return l
  }
  return 'Special'
}

/** Nombre en castellano, como en la pestaña Seguridad. */
export const LEVEL_ES: Record<string, string> = {
  FullControl: 'Control total',
  Modify: 'Modificar',
  ReadAndExecute: 'Lectura y ejecución',
  ListDirectory: 'Mostrar el contenido de la carpeta',
  Read: 'Lectura',
  Write: 'Escritura',
  None: 'Sin acceso',
  Special: 'Permisos especiales',
}

// ---------------------------------------------------------------------------------------
// Recursos compartidos
// ---------------------------------------------------------------------------------------

export type ShareLevel = 'Full' | 'Change' | 'Read'
export const SHARE_RIGHTS: Record<ShareLevel, Right[]> = {
  Full: ALL_RIGHTS,
  Change: ['R', 'X', 'W', 'A', 'D'],
  Read: ['R', 'X'],
}

export interface ShareAce {
  identity: string
  level: ShareLevel
  type: 'Allow' | 'Deny'
}

export function shareRights(entries: ShareAce[], principals: string[]): Set<Right> {
  const who = new Set(principals.map((p) => p.toLowerCase()))
  const allow = new Set<Right>()
  const deny = new Set<Right>()
  for (const e of entries) {
    if (!who.has(e.identity.toLowerCase())) continue
    for (const r of SHARE_RIGHTS[e.level]) (e.type === 'Allow' ? allow : deny).add(r)
  }
  for (const r of deny) allow.delete(r)
  return allow
}

/** Por la red: lo que permiten los dos (gana el más restrictivo). */
export function intersect(a: Set<Right>, b: Set<Right>): Set<Right> {
  return new Set([...a].filter((r) => b.has(r)))
}

/** Texto de icacls para una entrada: GG-Ventas:(OI)(CI)(M) */
export function icaclsText(e: AceView | Ace, inherited = false): string {
  const flags = `${inherited ? '(I)' : ''}${e.oi ? '(OI)' : ''}${e.ci ? '(CI)' : ''}${e.io ? '(IO)' : ''}${e.np ? '(NP)' : ''}`
  const lvl = levelOf(e.rights)
  const code = lvl === 'FullControl' ? 'F' : lvl === 'Modify' ? 'M' : lvl === 'ReadAndExecute' ? 'RX' : lvl === 'Read' ? 'R' : lvl === 'Write' ? 'W' : e.rights.map((r) => ({ R: 'RD', X: 'X', W: 'WD', A: 'AD', D: 'D', P: 'WDAC', O: 'WO' })[r]).join(',')
  return `${e.identity}:${flags}${e.type === 'Deny' ? '(DENY)' : ''}(${code})`
}
