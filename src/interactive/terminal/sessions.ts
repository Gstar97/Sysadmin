/**
 * Interfaz común para las tres consolas (bash, PowerShell e IOS) y sus adaptadores,
 * para que el componente Terminal no dependa del motor concreto.
 */
import type { BashCheck, BashStateInput } from '@/engines/shell/schema'
import type { PsCheck, PsStateInput } from '@/engines/powershell/schema'

export type ShellKind = 'bash' | 'powershell' | 'ios'

export interface Chunk {
  text: string
  stream: 'out' | 'err'
}

export interface EditorState {
  path: string
  content: string
  error?: string
  editor: string
}

export type Completion = { line: string } | { options: string[] } | undefined

export interface CheckResult {
  ok: boolean
  label: string
  reason?: string
}

export interface TermSession {
  kind: ShellKind
  prompt(): string
  /** Prompt de continuación cuando el comando quedó incompleto (comillas o bloques sin cerrar). */
  continuation: string
  run(line: string): Promise<{ chunks: Chunk[]; incomplete?: boolean; refill?: string }>
  complete(line: string): Completion
  history(): string[]
  /** El comando pidió limpiar la pantalla (clear, cls). */
  takeClear(): boolean
  /** Hay que ocultar lo que se escribe (contraseñas). */
  secret(): boolean
  /** Editor de texto abierto por el último comando (nano, vim, crontab -e...). */
  takeEditor(): EditorState | undefined
  saveEditor(state: EditorState, content: string): { ok: boolean; message?: string }
  verify(check: unknown): CheckResult
  /** Equipos a los que se puede conectar la consola (solo IOS). */
  devices?(): { id: string; name: string }[]
  attach?(id: string): void
  currentDevice?(): string
}

function commonPrefix(list: string[]): string {
  if (!list.length) return ''
  let p = list[0]
  for (const s of list) while (!s.startsWith(p)) p = p.slice(0, -1)
  return p
}

function finish(before: string, word: string, candidates: string[], suffix: (c: string) => string): Completion {
  if (!candidates.length) return undefined
  if (candidates.length === 1) return { line: before + candidates[0] + suffix(candidates[0]) }
  const prefix = commonPrefix(candidates)
  if (prefix.length > word.length) return { line: before + prefix }
  return { options: candidates.sort() }
}

// ---------------------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------------------

export async function createBashTerm(state: BashStateInput): Promise<TermSession> {
  const [{ createBashSession, verifyBash, COMMANDS }, { BUILTINS }, { saveEditor }, { ROOT_CRED }] = await Promise.all([
    import('@/engines/shell'),
    import('@/engines/shell/shell'),
    import('@/engines/shell/editor'),
    import('@/engines/shell/vfs'),
  ])
  const sh = createBashSession(state)
  return {
    kind: 'bash',
    prompt: () => sh.prompt(),
    continuation: '> ',
    run: (line) => sh.run(line),
    history: () => sh.history,
    takeClear() {
      const c = sh.pendingClear
      sh.pendingClear = false
      return c
    },
    secret: () => false,
    takeEditor() {
      const e = sh.pendingEditor
      sh.pendingEditor = undefined
      return e
    },
    saveEditor: (st, content) => saveEditor(sh, st, content),
    verify: (check) => verifyBash(sh, check as BashCheck),
    complete(line) {
      const word = /(\S*)$/.exec(line)![1]
      const before = line.slice(0, line.length - word.length)
      const isCommand = !before.trim() || /[|;&]\s*$/.test(before) || /(^|\s)sudo\s+$/.test(before)
      if (isCommand && !word.includes('/')) {
        const names = new Set([...COMMANDS.keys(), ...Object.keys(BUILTINS), ...sh.functions.keys()])
        return finish(before, word, [...names].filter((n) => n.startsWith(word)), () => ' ')
      }
      const slash = word.lastIndexOf('/')
      const dirPart = slash === -1 ? '' : word.slice(0, slash + 1)
      const base = word.slice(slash + 1)
      const dirAbs = sh.resolve(dirPart ? dirPart.replace(/^~(?=\/|$)/, sh.home) : '.')
      let entries: string[]
      try {
        entries = sh.sys.vfs.readdir(dirAbs, sh.cred)
      } catch {
        return undefined
      }
      const isDir = (name: string) => {
        try {
          return sh.sys.vfs.stat(`${dirAbs.replace(/\/$/, '')}/${name}`, ROOT_CRED).type === 'dir'
        } catch {
          return false
        }
      }
      const cands = entries.filter((e) => e.startsWith(base) && (base.startsWith('.') || !e.startsWith('.')))
      const res = finish(before + dirPart, base, cands, (c) => (isDir(c) ? '/' : ' '))
      if (res && 'options' in res) return { options: res.options.map((o) => (isDir(o) ? `${o}/` : o)) }
      return res
    },
  }
}

// ---------------------------------------------------------------------------------------
// PowerShell
// ---------------------------------------------------------------------------------------

export async function createPsTerm(state: PsStateInput): Promise<TermSession> {
  const { createPsSession, verifyPs, CMDLETS, ALIASES } = await import('@/engines/powershell')
  const s = createPsSession(state)
  return {
    kind: 'powershell',
    prompt: () => s.prompt(),
    continuation: '>> ',
    run: (line) => s.run(line),
    history: () => s.history,
    takeClear() {
      const c = s.pendingClear
      s.pendingClear = false
      return c
    },
    secret: () => false,
    takeEditor: () => undefined,
    saveEditor: () => ({ ok: false }),
    verify: (check) => verifyPs(s, check as PsCheck),
    complete(line) {
      const word = /(\S*)$/.exec(line)![1]
      const before = line.slice(0, line.length - word.length)
      if (word.startsWith('-')) {
        const cmd = /^\s*(\S+)/.exec(line)?.[1]?.toLowerCase()
        const def = cmd ? CMDLETS.get(ALIASES.get(cmd)?.toLowerCase() ?? cmd) : undefined
        if (!def) return undefined
        const params = [...(def.params ?? []), ...(def.switches ?? [])].map((p) => `-${p}`)
        return finish(before, word, params.filter((p) => p.toLowerCase().startsWith(word.toLowerCase())), () => ' ')
      }
      const isCommand = !before.trim() || /[|;]\s*$/.test(before)
      if (isCommand && !/[\\/]/.test(word)) {
        const names = [...CMDLETS.values()].map((d) => d.displayName!).filter((n) => n.toLowerCase().startsWith(word.toLowerCase()))
        if (names.length === 1) return { line: before + names[0] + ' ' }
        if (names.length > 1) {
          const prefix = commonPrefix(names.map((n) => n.toLowerCase()))
          if (prefix.length > word.length) return { line: before + names[0].slice(0, prefix.length) }
          return { options: names.sort() }
        }
      }
      const sep = Math.max(word.lastIndexOf('\\'), word.lastIndexOf('/'))
      const dirPart = sep === -1 ? '' : word.slice(0, sep + 1)
      const base = word.slice(sep + 1).replace(/^['"]/, '')
      const dir = s.resolvePath(dirPart || '.')
      const children = s.fs.children(dir)
      const cands = children.filter((c) => c.node.name.toLowerCase().startsWith(base.toLowerCase())).map((c) => c.node.name)
      const quote = (name: string) => (/\s/.test(name) ? `'${dirPart}${name}'` : `${dirPart}${name}`)
      if (cands.length === 1) return { line: before + quote(cands[0]) + (children.find((c) => c.node.name === cands[0])!.node.type === 'dir' ? '\\' : ' ') }
      if (cands.length > 1) return { options: cands.sort() }
      return undefined
    },
  }
}

// ---------------------------------------------------------------------------------------
// Cisco IOS
// ---------------------------------------------------------------------------------------

export async function createIosTerm(state: unknown): Promise<TermSession> {
  const [{ createIosSession }, { wrapIos }] = await Promise.all([import('@/engines/network'), import('./ios-term')])
  return wrapIos(createIosSession(state))
}

export function createTerm(kind: ShellKind, state: unknown): Promise<TermSession> {
  if (kind === 'bash') return createBashTerm((state ?? {}) as BashStateInput)
  if (kind === 'powershell') return createPsTerm((state ?? {}) as PsStateInput)
  return createIosTerm(state)
}
