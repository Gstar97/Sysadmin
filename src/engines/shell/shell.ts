import { arith, ArithError } from './arith'
import { commandPackage } from './packages'
import { IncompleteInput, parse, ShellSyntaxError, tokenize, type Assign, type Node, type Redir, type Word } from './parser'
import { System } from './system'
import { FsError, normalizePath, ROOT_CRED, type Cred } from './vfs'

export interface OutputChunk {
  text: string
  stream: 'out' | 'err'
}

/** Entrada estándar que se consume de a poco (read toma una línea, cat toma todo). */
export class Stdin {
  constructor(private buf = '') {}
  readAll(): string {
    const all = this.buf
    this.buf = ''
    return all
  }
  readLine(): string | null {
    if (!this.buf) return null
    const nl = this.buf.indexOf('\n')
    const line = nl < 0 ? this.buf : this.buf.slice(0, nl)
    this.buf = nl < 0 ? '' : this.buf.slice(nl + 1)
    return line
  }
  get empty() {
    return this.buf.length === 0
  }
}

export interface IO {
  stdin: Stdin
  out: (s: string) => void
  err: (s: string) => void
  isTTY: boolean
}

export interface CommandContext {
  name: string
  args: string[]
  stdin: Stdin
  out: (s: string) => void
  err: (s: string) => void
  sh: Shell
  sys: System
  isTTY: boolean
}

export type CommandFn = (ctx: CommandContext) => number | Promise<number>

export interface CommandDef {
  run: CommandFn
  /** Línea de uso para --help y man. */
  usage?: string
  summary?: string
  /** Ruta donde "vive" el binario (para which/type). */
  path?: string
}

export const COMMANDS = new Map<string, CommandDef>()

export function register(names: string | string[], def: CommandDef) {
  for (const n of Array.isArray(names) ? names : [names]) COMMANDS.set(n, def)
}

export class ExitSignal {
  constructor(public code: number) {}
}
class ReturnSignal {
  constructor(public code: number) {}
}
class LoopSignal {
  constructor(
    public kind: 'break' | 'continue',
    public levels: number,
  ) {}
}

export interface EditorRequest {
  path: string
  content: string
  error?: string
  editor: string
}

const GLOB_CHARS = /[*?[]/

/**
 * Expansión de llaves de bash: a{b,c}d → abd acd; {1..5}, {a..e}, {01..10}, {1..10..2}.
 * Se aplica solo al texto sin comillas y antes que cualquier otra expansión.
 */
export function braceExpand(word: Word): Word[] {
  for (let i = 0; i < word.parts.length; i++) {
    const part = word.parts[i]
    if (part.t !== 'lit' || part.q) continue
    const v = part.v
    for (let start = v.indexOf('{'); start !== -1; start = v.indexOf('{', start + 1)) {
      let depth = 0
      let end = -1
      const commas: number[] = []
      for (let j = start; j < v.length; j++) {
        if (v[j] === '{') depth++
        else if (v[j] === '}') {
          depth--
          if (depth === 0) {
            end = j
            break
          }
        } else if (v[j] === ',' && depth === 1) commas.push(j)
      }
      if (end === -1) break
      const inner = v.slice(start + 1, end)
      let alts: string[] | null = null
      if (commas.length) {
        alts = []
        let from = start + 1
        for (const c of [...commas, end]) {
          alts.push(v.slice(from, c))
          from = c + 1
        }
      } else {
        const r = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$/.exec(inner)
        if (r) alts = braceRange(r[1], r[2], r[3])
      }
      if (!alts) continue
      const prefix = v.slice(0, start)
      const suffix = v.slice(end + 1)
      return alts.flatMap((alt) =>
        braceExpand({ parts: [...word.parts.slice(0, i), { t: 'lit', v: prefix + alt + suffix, q: false }, ...word.parts.slice(i + 1)] }),
      )
    }
  }
  return [word]
}

function braceRange(a: string, b: string, stepText?: string): string[] | null {
  const step = Math.abs(Number(stepText ?? 1)) || 1
  const numeric = /^-?\d+$/.test(a) && /^-?\d+$/.test(b)
  if (!numeric && (/\d/.test(a) || /\d/.test(b))) return null
  const from = numeric ? Number(a) : a.charCodeAt(0)
  const to = numeric ? Number(b) : b.charCodeAt(0)
  const width = numeric && (/^-?0\d/.test(a) || /^-?0\d/.test(b)) ? Math.max(a.replace('-', '').length, b.replace('-', '').length) : 0
  const out: string[] = []
  const dir = from <= to ? 1 : -1
  for (let n = from; dir > 0 ? n <= to : n >= to; n += dir * step) {
    out.push(numeric ? (n < 0 ? '-' : '') + String(Math.abs(n)).padStart(width, '0') : String.fromCharCode(n))
    if (out.length > 10000) break
  }
  return out
}

function globToRegex(segment: string): RegExp {
  let re = '^'
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]
    if (c === '\\' && i + 1 < segment.length) {
      re += segment[++i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '[') {
      const end = segment.indexOf(']', i + 2)
      if (end < 0) re += '\\['
      else {
        let cls = segment.slice(i + 1, end)
        if (cls.startsWith('!')) cls = '^' + cls.slice(1)
        re += `[${cls.replace(/\\/g, '\\\\')}]`
        i = end
      }
    } else re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  }
  return new RegExp(re + '$')
}

/** Coincidencia de patrones de case y [[ == ]]. */
export function matchPattern(text: string, pattern: string): boolean {
  return globToRegex(pattern).test(text)
}

export class Shell {
  /** Servidor de cada nivel de la pila (cambia con ssh; con su y sudo se repite el mismo). */
  private sysStack: System[]
  /** Para los niveles abiertos con ssh: el nombre con el que se conectó (para "Connection to X closed."). */
  private remoteStack: (string | undefined)[]
  private userStack: string[]
  private cwdStack: string[]
  vars = new Map<string, string>()
  exported = new Set<string>()
  positional: string[] = []
  scriptName = '-bash'
  functions = new Map<string, Node>()
  history: string[] = []
  /** Líneas tal como se escribieron, antes de expandir !! y compañía (para verificar ejercicios). */
  typed: string[] = []
  /** Alias del shell interactivo (los que define ~/.bashrc en cada distribución, más los del estudiante). */
  aliases = new Map<string, string>()
  lastExit = 0
  options: { errexit: boolean; nounset: boolean; pipefail: boolean; xtrace?: boolean } = { errexit: false, nounset: false, pipefail: false }
  umask = 0o022
  pendingEditor?: EditorRequest
  pendingClear = false
  /** Salida completa (stdout + stderr) de la última línea ejecutada. */
  lastOutput = ''
  private localsStack: Map<string, { value: string | undefined; array?: Map<string, string>; assoc: boolean }>[] = []
  /** Arreglos: índice (o clave) → valor. Los asociativos además están en assoc. */
  arrays = new Map<string, Map<string, string>>()
  assoc = new Set<string>()
  readonlyVars = new Set<string>()
  /** trap: señal (EXIT, ERR, INT, TERM) → comandos. */
  traps = new Map<string, string>()
  /** exec > archivo: redirección que queda para el resto del script. */
  private persistIO?: { fromOut: (s: string) => void; toOut: (s: string) => void; fromErr: (s: string) => void; toErr: (s: string) => void }
  private funcStack: string[] = []
  private psubCount = 0

  /** <(comando): la salida queda en /dev/fd/63 (62, 61...) para leerla como archivo. */
  private async processSubst(src: string): Promise<string> {
    const out = await this.captureCommand(src)
    const path = `/dev/fd/${63 - (this.psubCount++ % 20)}`
    this.sys.vfs.mkdirp('/dev/fd', ROOT_CRED)
    this.sys.vfs.writeFile(path, out, ROOT_CRED, { mode: 0o666 })
    return path
  }
  private conditionDepth = 0

  constructor(sys: System, user: string, cwd?: string) {
    this.sysStack = [sys]
    this.remoteStack = [undefined]
    this.userStack = [user]
    const home = sys.users.get(user)?.home ?? '/root'
    this.cwdStack = [cwd ? normalizePath(cwd) : home]
    this.umask = user === 'root' ? 0o022 : 0o002
    this.resetEnv()
    this.defaultAliases()
  }

  /** Los alias que traen los archivos de inicio de cada distribución. */
  private defaultAliases() {
    this.aliases.clear()
    const defs: Record<string, string> =
      this.sys.distro === 'ubuntu'
        ? { ls: 'ls --color=auto', grep: 'grep --color=auto', ll: 'ls -alF', la: 'ls -A', l: 'ls -CF' }
        : { ls: 'ls --color=auto', grep: 'grep --color=auto', ll: 'ls -l --color=auto', 'l.': 'ls -d .* --color=auto' }
    for (const [k, v] of Object.entries(defs)) this.aliases.set(k, v)
  }

  /** El servidor donde se ejecutan los comandos ahora (el remoto, si hay una sesión ssh abierta). */
  get sys(): System {
    return this.sysStack[this.sysStack.length - 1]
  }
  /** El servidor donde empezó la sesión (el del ejercicio). */
  get baseSys(): System {
    return this.sysStack[0]
  }
  get user(): string {
    return this.userStack[this.userStack.length - 1]
  }
  get cwd(): string {
    return this.cwdStack[this.cwdStack.length - 1]
  }
  set cwd(v: string) {
    this.cwdStack[this.cwdStack.length - 1] = v
    this.vars.set('PWD', v)
  }
  get cred(): Cred {
    return this.sys.credFor(this.user)
  }
  get home(): string {
    return this.sys.users.get(this.user)?.home ?? '/'
  }
  get depth(): number {
    return this.userStack.length
  }

  private resetEnv() {
    const u = this.sys.users.get(this.user)
    const env: Record<string, string> = {
      HOME: u?.home ?? '/',
      USER: this.user,
      LOGNAME: this.user,
      SHELL: u?.shell ?? '/bin/bash',
      PATH: this.user === 'root' ? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin' : '/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin',
      PWD: this.cwd,
      HOSTNAME: this.sys.hostname,
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
    }
    for (const [k, v] of Object.entries(env)) {
      this.vars.set(k, v)
      this.exported.add(k)
    }
  }

  /** Cambia de usuario (sudo -i, su -). */
  pushUser(user: string, login = true) {
    const home = this.sys.users.get(user)?.home ?? '/'
    this.sysStack.push(this.sys)
    this.remoteStack.push(undefined)
    this.userStack.push(user)
    this.cwdStack.push(login ? home : this.cwd)
    this.umask = user === 'root' ? 0o022 : 0o002
    this.resetEnv()
  }

  /** Abre una sesión en otro servidor (ssh). */
  pushHost(sys: System, user: string, label: string) {
    this.sysStack.push(sys)
    this.remoteStack.push(label)
    this.userStack.push(user)
    this.cwdStack.push(sys.users.get(user)?.home ?? '/')
    this.umask = user === 'root' ? 0o022 : 0o002
    this.resetEnv()
    this.defaultAliases()
  }

  /** Cierra el nivel actual. Devuelve false si era el último, y el nombre del servidor si era una sesión ssh. */
  popUser(): false | { remote?: string } {
    if (this.userStack.length <= 1) return false
    const remote = this.remoteStack.pop()
    this.sysStack.pop()
    this.userStack.pop()
    this.cwdStack.pop()
    this.umask = this.user === 'root' ? 0o022 : 0o002
    this.resetEnv()
    if (remote) this.defaultAliases()
    return { remote }
  }

  /** Ejecuta una acción en otro servidor, como un usuario (ssh servidor comando, scp). */
  async onHost<T>(sys: System, user: string, fn: () => Promise<T>): Promise<T> {
    this.sysStack.push(sys)
    this.remoteStack.push(undefined)
    this.userStack.push(user)
    this.cwdStack.push(sys.users.get(user)?.home ?? '/')
    try {
      return await fn()
    } finally {
      this.sysStack.pop()
      this.remoteStack.pop()
      this.userStack.pop()
      this.cwdStack.pop()
    }
  }

  /** Ejecuta una acción como otro usuario (sudo comando). */
  async asUser<T>(user: string, fn: () => Promise<T>): Promise<T> {
    this.sysStack.push(this.sys)
    this.remoteStack.push(undefined)
    this.userStack.push(user)
    this.cwdStack.push(this.cwd)
    try {
      return await fn()
    } finally {
      this.sysStack.pop()
      this.remoteStack.pop()
      this.userStack.pop()
      this.cwdStack.pop()
    }
  }

  resolve(path: string): string {
    if (path === '~' || path.startsWith('~/')) path = this.home + path.slice(1)
    return normalizePath(path, this.cwd)
  }

  displayPath(abs: string): string {
    const home = this.home
    if (abs === home) return '~'
    if (home !== '/' && abs.startsWith(home + '/')) return '~' + abs.slice(home.length)
    return abs
  }

  prompt(): string {
    const sym = this.user === 'root' ? '#' : '$'
    if (this.sys.distro === 'ubuntu') {
      return `\x1b[01;32m${this.user}@${this.sys.hostname}\x1b[00m:\x1b[01;34m${this.displayPath(this.cwd)}\x1b[00m${sym} `
    }
    const shown = this.cwd === this.home ? '~' : this.cwd === '/' ? '/' : this.cwd.slice(this.cwd.lastIndexOf('/') + 1)
    return `[${this.user}@${this.sys.hostname} ${shown}]${sym} `
  }

  /** Ejecuta una línea (o varias) escritas por el estudiante. */
  async run(source: string): Promise<{ chunks: OutputChunk[]; incomplete?: boolean }> {
    const chunks: OutputChunk[] = []
    const push = (stream: 'out' | 'err') => (text: string) => {
      if (!text) return
      const last = chunks[chunks.length - 1]
      if (last && last.stream === stream) last.text += text
      else chunks.push({ text, stream })
    }
    if (source.trim()) this.typed.push(source.replace(/\n$/, ''))
    this.sys.refreshVirtual()
    const hist = this.expandHistory(source)
    if ('error' in hist) {
      push('err')(hist.error + '\n')
      this.lastExit = 1
      this.lastOutput = hist.error
      return { chunks }
    }
    if (hist.changed) {
      source = hist.text
      push('out')(source.replace(/\n$/, '') + '\n')
    }
    let node: Node
    try {
      node = parse(source)
    } catch (e) {
      if (e instanceof IncompleteInput) return { chunks: [], incomplete: true }
      if (e instanceof ShellSyntaxError) {
        push('err')(e.message + '\n')
        this.lastExit = 2
        this.lastOutput = e.message
        return { chunks }
      }
      throw e
    }
    if (source.trim()) this.history.push(source.replace(/\n$/, ''))
    try {
      this.lastExit = await this.exec(node, { stdin: new Stdin(), out: push('out'), err: push('err'), isTTY: true })
    } catch (e) {
      if (e instanceof ExitSignal) {
        this.lastExit = e.code
        const popped = this.popUser()
        if (!popped) push('out')('logout\n')
        else if (popped.remote) push('out')(`logout\nConnection to ${popped.remote} closed.\n`)
      } else if (e instanceof ReturnSignal || e instanceof LoopSignal) {
        // return/break fuera de contexto: se ignora como en bash interactivo
      } else {
        push('err')(`bash: error interno del simulador: ${(e as Error).message}\n`)
        this.lastExit = 1
      }
    }
    this.lastOutput = chunks.map((c) => c.text).join('')
    return { chunks }
  }

  /**
   * Expansión del historial de bash interactivo: !!, !$, !n, !-n y !texto.
   * Como en bash, no se aplica dentro de comillas simples ni a un ! seguido de espacio, = o (.
   */
  private expandHistory(src: string): { text: string; changed: boolean } | { error: string } {
    if (!src.includes('!')) return { text: src, changed: false }
    // Las líneas de un here-document no pasan por la expansión del historial.
    if (src.includes('\n') && /<<-?\s*['"]?\w/.test(src)) {
      const lines = src.split('\n')
      const out: string[] = []
      const pending: string[] = []
      let changed = false
      for (const line of lines) {
        if (pending.length) {
          out.push(line)
          if (line.replace(/^\t+/, '') === pending[0]) pending.shift()
          continue
        }
        const r = this.expandHistoryLine(line)
        if ('error' in r) return r
        changed ||= r.changed
        out.push(r.text)
        for (const m of line.matchAll(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/g)) if (line[m.index! + 2] !== '<') pending.push(m[2])
      }
      return { text: out.join('\n'), changed }
    }
    return this.expandHistoryLine(src)
  }

  private expandHistoryLine(src: string): { text: string; changed: boolean } | { error: string } {
    if (!src.includes('!')) return { text: src, changed: false }
    let out = ''
    let changed = false
    let inSingle = false
    for (let i = 0; i < src.length; i++) {
      const c = src[i]
      if (c === '!' && src[i - 1] === '{' && src[i - 2] === '$') {
        out += c
        continue
      }
      if (c === "'" ) inSingle = !inSingle
      if (c === '\\' && !inSingle) {
        out += c + (src[i + 1] ?? '')
        i++
        continue
      }
      if (c !== '!' || inSingle) {
        out += c
        continue
      }
      const rest = src.slice(i + 1)
      const m = /^(!|\$|-?\d+|[A-Za-z_./][\w./-]*)/.exec(rest)
      if (!m) {
        out += c
        continue
      }
      const tok = m[1]
      let entry: string | undefined
      if (tok === '!' || tok === '$') entry = this.history[this.history.length - 1]
      else if (/^-\d+$/.test(tok)) entry = this.history[this.history.length + Number(tok)]
      else if (/^\d+$/.test(tok)) entry = this.history[Number(tok) - 1]
      else entry = [...this.history].reverse().find((h) => h.startsWith(tok))
      if (entry === undefined) return { error: `bash: !${tok}: event not found` }
      if (tok === '$') {
        const words = entry.trim().split(/\s+/)
        entry = words[words.length - 1]
      }
      out += entry
      changed = true
      i += tok.length
    }
    return { text: out, changed }
  }

  // ---------------------------------------------------------------------------
  // Ejecución del árbol
  // ---------------------------------------------------------------------------

  async exec(node: Node, io: IO): Promise<number> {
    switch (node.kind) {
      case 'list': {
        let code = 0
        for (const item of node.items) {
          code = await this.exec(item, io)
          this.lastExit = code
          if (code !== 0 && this.conditionDepth === 0 && this.traps.has('ERR')) await this.runTrap('ERR', io)
          this.checkErrexit(code)
        }
        return code
      }
      case 'andor': {
        this.conditionDepth++
        let code: number
        try {
          code = await this.exec(node.first, io)
          this.lastExit = code
          for (const { op, node: next } of node.rest) {
            if ((op === '&&' && code === 0) || (op === '||' && code !== 0)) {
              code = await this.exec(next, io)
              this.lastExit = code
            }
          }
        } finally {
          this.conditionDepth--
        }
        return code
      }
      case 'pipeline':
        return this.execPipeline(node.cmds, node.negate, io)
      case 'simple':
        return this.execSimple(node, io)
      case 'if':
        return this.withRedirs(node.redirs, io, async (rio) => {
          for (const clause of node.clauses) {
            if ((await this.cond(clause.cond, rio)) === 0) return this.exec(clause.body, rio)
          }
          return node.elseBody ? this.exec(node.elseBody, rio) : 0
        })
      case 'for':
        return this.withRedirs(node.redirs, io, async (rio) => {
          const items = node.items ? (await Promise.all(node.items.flatMap((w) => braceExpand(w)).map((w) => this.expandWord(w)))).flat() : [...this.positional]
          let code = 0
          for (const item of items) {
            this.setVar(node.name, item)
            try {
              code = await this.exec(node.body, rio)
            } catch (e) {
              if (e instanceof LoopSignal) {
                if (e.levels > 1) throw new LoopSignal(e.kind, e.levels - 1)
                if (e.kind === 'break') break
                continue
              }
              throw e
            }
          }
          return code
        })
      case 'while':
        return this.withRedirs(node.redirs, io, async (rio) => {
          let code = 0
          let guard = 0
          while (true) {
            if (++guard > 10000) {
              rio.err('bash: simulador: el bucle superó las 10000 vueltas y se detuvo\n')
              return 1
            }
            const c = await this.cond(node.cond, rio)
            if (node.until ? c === 0 : c !== 0) break
            try {
              code = await this.exec(node.body, rio)
            } catch (e) {
              if (e instanceof LoopSignal) {
                if (e.levels > 1) throw new LoopSignal(e.kind, e.levels - 1)
                if (e.kind === 'break') break
                continue
              }
              throw e
            }
          }
          return code
        })
      case 'case':
        return this.withRedirs(node.redirs, io, async (rio) => {
          const value = (await this.expandWord(node.word, { split: false, glob: false })).join(' ')
          for (const item of node.items) {
            for (const p of item.patterns) {
              const pattern = (await this.expandWord(p, { split: false, glob: false })).join(' ')
              if (matchPattern(value, pattern)) return this.exec(item.body, rio)
            }
          }
          return 0
        })
      case 'bg':
        return this.startJob(node.body, node.text, io)
      case 'group':
        return this.withRedirs(node.redirs, io, async (rio) => {
          if (!node.subshell) return this.exec(node.body, rio)
          const saved = this.saveState()
          try {
            return await this.exec(node.body, rio)
          } catch (e) {
            if (e instanceof ExitSignal) return e.code
            throw e
          } finally {
            this.restoreState(saved)
          }
        })
      case 'func':
        this.functions.set(node.name, node.body)
        return 0
      case 'arith':
        return this.withRedirs(node.redirs, io, async (rio) => {
          try {
            const v = evalArith(await this.expandArithText(node.expr), this)
            if (this.options.xtrace) rio.err(`${this.ps4()}(( ${node.expr.trim()} ))\n`)
            return v !== 0 ? 0 : 1
          } catch (e) {
            if (e instanceof ExpansionError) {
              rio.err(e.message + '\n')
              return 1
            }
            throw e
          }
        })
      case 'forArith':
        return this.withRedirs(node.redirs, io, async (rio) => {
          let code = 0
          let guard = 0
          const ev = async (x: string) => (x.trim() ? evalArith(await this.expandArithText(x), this) : 1)
          await ev(node.init || '0')
          while ((await ev(node.cond)) !== 0) {
            if (++guard > 100000) {
              rio.err('[simulador] El bucle se cortó después de 100000 vueltas.\n')
              break
            }
            try {
              code = await this.exec(node.body, rio)
            } catch (e) {
              if (e instanceof LoopSignal) {
                if (e.levels > 1) throw new LoopSignal(e.kind, e.levels - 1)
                if (e.kind === 'break') break
              } else throw e
            }
            await ev(node.step || '0')
          }
          return code
        })
    }
  }

  private async cond(node: Node, io: IO): Promise<number> {
    this.conditionDepth++
    try {
      return await this.exec(node, io)
    } finally {
      this.conditionDepth--
    }
  }

  private checkErrexit(code: number) {
    if (code !== 0 && this.options.errexit && this.conditionDepth === 0 && this.scriptName !== '-bash') {
      throw new ExitSignal(code)
    }
  }

  private saveState() {
    return {
      cwd: this.cwd,
      vars: new Map(this.vars),
      arrays: new Map([...this.arrays].map(([k, v]) => [k, new Map(v)])),
      assoc: new Set(this.assoc),
      exported: new Set(this.exported),
      positional: [...this.positional],
      options: { ...this.options },
      umask: this.umask,
      traps: new Map(this.traps),
      persistIO: this.persistIO,
    }
  }

  private restoreState(s: ReturnType<Shell['saveState']>) {
    this.cwd = s.cwd
    this.vars = s.vars
    this.arrays = s.arrays
    this.assoc = s.assoc
    this.exported = s.exported
    this.positional = s.positional
    this.options = s.options
    this.umask = s.umask
    this.traps = s.traps
    this.persistIO = s.persistIO
  }

  private async execPipeline(cmds: Node[], negate: boolean, io: IO): Promise<number> {
    let input = io.stdin
    let code = 0
    const codes: number[] = []
    for (let i = 0; i < cmds.length; i++) {
      const last = i === cmds.length - 1
      let buffer = ''
      const out = last ? io.out : (s: string) => (buffer += s)
      // Cada parte de una tubería corre aparte: lo que cambie (variables, cd) no queda.
      const saved = cmds.length > 1 ? this.saveState() : undefined
      try {
        code = await this.exec(cmds[i], { stdin: input, out, err: io.err, isTTY: last && io.isTTY })
      } catch (e) {
        if (!(e instanceof ExitSignal) || !saved) throw e
        code = e.code
      } finally {
        if (saved) this.restoreState(saved)
      }
      codes.push(code)
      input = new Stdin(buffer)
    }
    if (this.options.pipefail) code = [...codes].reverse().find((c) => c !== 0) ?? 0
    return negate ? (code === 0 ? 1 : 0) : code
  }

  /** Aplica redirecciones a un bloque (if, for, while, { }). */
  private async withRedirs(redirs: Redir[], io: IO, fn: (io: IO) => Promise<number>): Promise<number> {
    if (redirs.length === 0) return fn(io)
    const prepared = await this.prepareRedirs(redirs, io)
    if (typeof prepared === 'number') return prepared
    try {
      return await fn(prepared.io)
    } finally {
      prepared.flush()
    }
  }

  private async prepareRedirs(redirs: Redir[], io: IO): Promise<{ io: IO; flush: () => void } | number> {
    let { stdin, out, err } = io
    let isTTY = io.isTTY
    const writes: { path: string; data: () => string }[] = []
    const fileSink = (path: string, append: boolean) => {
      if (path === '/dev/null') return () => undefined
      // Igual que bash: el archivo se crea (o se vacía con >) antes de ejecutar el comando.
      if (!append || !this.sys.vfs.exists(path, this.cred)) this.sys.vfs.writeFile(path, '', this.cred, { mode: 0o666, umask: this.umask })
      else this.sys.vfs.writeFile(path, '', this.cred, { append: true })
      let buf = ''
      writes.push({ path, data: () => buf })
      return (s: string) => {
        buf += s
      }
    }
    try {
      for (const r of redirs) {
        if (r.op === '2>&1') {
          err = out
          continue
        }
        if (r.op === '>&2') {
          out = err
          isTTY = false
          continue
        }
        if (r.op === '<<') {
          const body = r.heredoc?.body ?? ''
          stdin = new Stdin(r.heredoc?.expand ? await this.expandHeredoc(body) : body)
          continue
        }
        const target = (await this.expandWord(r.target!, { split: false })).join(' ')
        if (r.op === '<<<') {
          stdin = new Stdin(target + '\n')
          continue
        }
        const path = this.resolve(target)
        if (r.op === '<') {
          stdin = new Stdin(this.sys.vfs.readFile(path, this.cred))
        } else if (r.op === '>' || r.op === '>>') {
          out = fileSink(path, r.op === '>>')
          isTTY = false
        } else if (r.op === '2>' || r.op === '2>>') {
          err = fileSink(path, r.op === '2>>')
        } else if (r.op === '&>' || r.op === '&>>') {
          const sink = fileSink(path, r.op === '&>>')
          out = sink
          err = sink
          isTTY = false
        }
      }
    } catch (e) {
      if (e instanceof FsError) {
        io.err(`bash: ${e.path.replace(this.cwd + '/', '')}: ${e.message}\n`)
        return 1
      }
      throw e
    }
    const flush = () => {
      for (const w of writes) {
        const data = w.data()
        if (data) {
          try {
            this.sys.vfs.writeFile(w.path, data, this.cred, { append: true })
          } catch {
            // ya se validó el permiso al abrir
          }
        }
      }
    }
    return { io: { stdin, out, err, isTTY }, flush }
  }

  /** Reemplaza la primera palabra por su alias (solo en el shell interactivo y si no va entre comillas). */
  private async applyAlias(first: Word | undefined, argv: string[]): Promise<string[]> {
    if (!first || this.scriptName !== '-bash' || argv.length === 0) return argv
    if (first.parts.length !== 1 || first.parts[0].t !== 'lit' || first.parts[0].q) return argv
    const value = this.aliases.get(argv[0])
    if (value === undefined) return argv
    let node: Node
    try {
      node = parse(value)
    } catch {
      return argv
    }
    if (node.kind !== 'simple' || node.words.length === 0) return argv
    const expanded: string[] = []
    for (const w of node.words.flatMap((x) => braceExpand(x))) expanded.push(...(await this.expandWord(w)))
    return [...expanded, ...argv.slice(1)]
  }

  private async execSimple(node: Extract<Node, { kind: 'simple' }>, io: IO): Promise<number> {
    if (node.line !== undefined && this.scriptName !== '-bash' && !this.noLine) this.vars.set('LINENO', String(node.line))
    const isTest = node.words[0]?.parts.length === 1 && node.words[0].parts[0].t === 'lit' && node.words[0].parts[0].v === '[['
    let argv: string[]
    try {
      argv = []
      const words = isTest ? node.words : node.words.flatMap((w) => braceExpand(w))
      for (const w of words) argv.push(...(await this.expandWord(w, isTest ? { split: false, glob: false } : {})))
      argv = await this.applyAlias(node.words[0], argv)
    } catch (e) {
      if (e instanceof ExpansionError) {
        io.err(e.message + '\n')
        if (this.scriptName !== '-bash') throw new ExitSignal(1)
        return 1
      }
      throw e
    }

    if (argv.length === 0) {
      for (const a of node.assigns) {
        const r = await this.doAssign(a, io)
        if (r !== 0) {
          if (this.scriptName !== '-bash' && this.readonlyHit) throw new ExitSignal(1)
          return r
        }
      }
      if (this.options.xtrace && node.assigns.length) io.err(node.assigns.map((a) => `${this.ps4()}${a.name}${a.index !== undefined ? `[${a.index}]` : ''}${a.append ? '+' : ''}=${a.array ? '(...)' : this.vars.get(a.name) ?? this.getVar(a.name) ?? ''}`).join('\n') + '\n')
      if (node.redirs.length) {
        const prepared = await this.prepareRedirs(node.redirs, io)
        if (typeof prepared === 'number') return prepared
        prepared.flush()
      }
      return 0
    }

    // VAR=valor comando: la variable vale solo para ese comando.
    const restore: [string, string | undefined][] = []
    for (const a of node.assigns) {
      restore.push([a.name, this.vars.get(a.name)])
      this.vars.set(a.name, (await this.expandWord(a.value, { split: false, glob: false })).join(' '))
    }
    // declare/local/readonly con arreglos: nombre=( ... )
    if (['declare', 'typeset', 'local', 'readonly'].includes(argv[0])) {
      for (const w of node.words) {
        if (!w.array) continue
        const lit = w.parts[0]?.t === 'lit' ? w.parts[0].v : ''
        const m = /^([A-Za-z_]\w*)(\+?)=/.exec(lit)
        if (!m) continue
        if (argv[0] === 'local') this.declareLocal(m[1])
        if (argv.slice(1).some((x) => /^-\w*A/.test(x))) this.assoc.add(m[1])
        await this.doAssign({ name: m[1], append: m[2] === '+', value: { parts: [] }, array: w.array }, io)
        const idx = argv.findIndex((x) => x.startsWith(`${m[1]}=`) || x.startsWith(`${m[1]}+=`))
        if (idx > 0) argv[idx] = m[1]
      }
    }
    if (this.options.xtrace) io.err(`${this.ps4()}${argv.map(traceQuote).join(' ')}\n`)
    try {
      // exec > archivo: desde ahí, lo que iba a la terminal va al archivo.
      const pio = this.persistIO
      const baseIO = pio ? { ...io, out: io.out === pio.fromOut ? pio.toOut : io.out, err: io.err === pio.fromErr ? pio.toErr : io.err, isTTY: io.out === pio.fromOut && pio.toOut !== pio.fromOut ? false : io.isTTY } : io
      if (argv[0] === 'exec' && argv.length === 1) return this.execRedirect(node.redirs, baseIO, io)
      const prepared = await this.prepareRedirs(node.redirs, baseIO)
      if (typeof prepared === 'number') return prepared
      try {
        return await this.invoke(argv, prepared.io)
      } finally {
        prepared.flush()
      }
    } finally {
      for (const [k, v] of restore) {
        if (v === undefined) this.vars.delete(k)
        else this.vars.set(k, v)
      }
    }
  }

  private readonlyHit = false

  /** Busca un ejecutable en las carpetas del PATH, en orden. */
  findInPath(name: string): { path: string; binary: boolean } | undefined {
    for (const dir of (this.getVar('PATH') ?? '').split(':')) {
      if (!dir) continue
      const path = `${dir.replace(/\/$/, '')}/${name}`
      try {
        if (!this.sys.vfs.exists(path, this.cred)) continue
        const node = this.sys.vfs.stat(path, this.cred)
        if (node.type !== 'file' || !this.sys.vfs.can(node, this.cred, 1)) continue
        return { path, binary: node.data.startsWith('\x7fELF') }
      } catch {
        continue
      }
    }
    return undefined
  }
  /** Dentro de un trap o de $( ), LINENO no cambia (sigue siendo la línea del script). */
  private noLine = 0

  /** Ejecuta lo que se registró con trap para esa señal (sin que un error ahí corte nada). */
  private async runTrap(sig: string, io: IO) {
    const cmd = this.traps.get(sig)
    if (!cmd) return
    const saved = this.lastExit
    this.traps.delete(sig === 'EXIT' ? 'EXIT' : '__none__')
    const pio = this.persistIO
    const tio = pio ? { ...io, out: io.out === pio.fromOut ? pio.toOut : io.out, err: io.err === pio.fromErr ? pio.toErr : io.err } : io
    this.noLine++
    try {
      await this.exec(parse(cmd), tio)
    } catch (e) {
      if (!(e instanceof ExitSignal || e instanceof ReturnSignal || e instanceof LoopSignal)) throw e
    } finally {
      this.noLine--
    }
    this.lastExit = saved
  }

  /** exec sin comando: las redirecciones quedan para el resto del script (exec >> log 2>&1). */
  private async execRedirect(redirs: Redir[], cur: IO, orig: IO): Promise<number> {
    let out = cur.out
    let err = cur.err
    try {
      for (const r of redirs) {
        if (r.op === '2>&1') {
          err = out
          continue
        }
        if (r.op === '>&2') {
          out = err
          continue
        }
        if (!r.target) continue
        const path = this.resolve((await this.expandWord(r.target, { split: false })).join(' '))
        if (path === '/dev/null') {
          const sink = () => undefined
          if (r.op.startsWith('2')) err = sink
          else if (r.op.startsWith('&')) out = err = sink
          else out = sink
          continue
        }
        const append = r.op.endsWith('>>')
        if (!append || !this.sys.vfs.exists(path, this.cred)) this.sys.vfs.writeFile(path, '', this.cred, { mode: 0o666, umask: this.umask })
        const cred = this.cred
        const sink = (txt: string) => {
          try {
            this.sys.vfs.writeFile(path, txt, cred, { append: true })
          } catch {
            // sin permiso: se pierde, como en bash
          }
        }
        this.sys.vfs.writeFile(path, '', cred, { append: true })
        if (r.op === '2>' || r.op === '2>>') err = sink
        else if (r.op === '&>' || r.op === '&>>') out = err = sink
        else out = sink
      }
    } catch (e) {
      if (e instanceof FsError) {
        cur.err(`bash: ${e.path}: ${e.message}\n`)
        return 1
      }
      throw e
    }
    this.persistIO = { fromOut: this.persistIO?.fromOut ?? orig.out, toOut: out, fromErr: this.persistIO?.fromErr ?? orig.err, toErr: err }
    return 0
  }

  /** Una asignación: x=1, x+=1, a[2]=x, a=(uno dos), m=([clave]=valor). */
  async doAssign(a: Assign, io: IO): Promise<number> {
    this.readonlyHit = false
    if (this.readonlyVars.has(a.name)) {
      io.err(`bash: ${a.name}: readonly variable\n`)
      this.readonlyHit = true
      return 1
    }
    try {
      if (a.array) {
        if (this.assoc.has(a.name)) {
          const m = a.append ? new Map(this.arrays.get(a.name) ?? []) : new Map<string, string>()
          for (const w of a.array) {
            const text = (await this.expandWord(w, { split: false, glob: false })).join(' ')
            const kv = /^\[([^\]]+)\]=(.*)$/s.exec(text)
            if (kv) m.set(kv[1], kv[2])
          }
          this.arrays.set(a.name, m)
          this.vars.delete(a.name)
          return 0
        }
        const values: string[] = []
        const explicit = new Map<string, string>()
        for (const w of a.array) {
          const first = w.parts[0]
          if (first?.t === 'lit' && !first.q && /^\[[^\]]+\]=/.test(first.v)) {
            const text = (await this.expandWord(w, { split: false, glob: false })).join(' ')
            const kv = /^\[([^\]]+)\]=(.*)$/s.exec(text)!
            explicit.set(String(evalArith(kv[1], this)), kv[2])
          } else values.push(...(await this.expandWord(w)))
        }
        if (explicit.size) this.setArray(a.name, explicit, a.append)
        else this.setArray(a.name, values, a.append)
        return 0
      }
      const v = (await this.expandWord(a.value, { split: false, glob: false })).join(' ')
      if (a.index !== undefined) {
        const key = await this.expandText(a.index)
        const cur = a.append ? (this.getElem(a.name, key) ?? '') : ''
        this.setElem(a.name, key, cur + v)
        return 0
      }
      if (a.append && this.vars.get(a.name) !== undefined && /^-?\d+$/.test(this.vars.get(a.name)!) && this.integerVars.has(a.name)) {
        this.setVar(a.name, String(Number(this.vars.get(a.name)) + evalArith(v, this)))
        return 0
      }
      this.setVar(a.name, a.append ? (this.getVar(a.name) ?? '') + v : this.integerVars.has(a.name) ? String(evalArith(v, this)) : v)
      return 0
    } catch (e) {
      if (e instanceof ExpansionError) {
        io.err(e.message + '\n')
        return 1
      }
      throw e
    }
  }

  integerVars = new Set<string>()
  /** shopt: nullglob, dotglob, extglob... */
  shopts = new Set<string>(['extglob'])

  /** Ejecuta un comando ya expandido: builtin, función, script o comando del sistema. */
  async invoke(argv: string[], io: IO): Promise<number> {
    const [name, ...args] = argv
    const builtin = BUILTINS[name]
    if (builtin) return builtin(this, args, io)

    const fn = this.functions.get(name)
    if (fn) {
      const savedPos = this.positional
      this.positional = args
      this.localsStack.push(new Map())
      this.funcStack.push(name)
      try {
        return await this.exec(fn, io)
      } catch (e) {
        if (e instanceof ReturnSignal) return e.code
        throw e
      } finally {
        const locals = this.localsStack.pop()!
        for (const [k, v] of locals) {
          this.arrays.delete(k)
          this.assoc.delete(k)
          if (v.value === undefined) this.vars.delete(k)
          else this.vars.set(k, v.value)
          if (v.array) this.arrays.set(k, v.array)
          if (v.assoc) this.assoc.add(k)
        }
        this.funcStack.pop()
        this.positional = savedPos
      }
    }

    if (name.includes('/')) {
      const path = this.resolve(name)
      const base = path.slice(path.lastIndexOf('/') + 1)
      if (/^\/(usr\/)?s?bin\//.test(path) && COMMANDS.has(base)) return this.runCommand(base, args, io)
      return this.runScript(path, name, args, io, true)
    }

    // Scripts propios en el PATH (/usr/local/bin, ~/bin...): van antes que los programas del sistema que estén más adelante en el PATH.
    const inPath = this.findInPath(name)
    if (inPath && !inPath.binary) return this.runScript(inPath.path, name, args, io, true)

    const def = COMMANDS.get(name)
    if (def) {
      const pkg = commandPackage(this.sys.distro, name)
      if (pkg && !this.sys.installed.has(pkg)) {
        io.err(`bash: ${name}: command not found\n`)
        return 127
      }
      return this.runCommand(name, args, io)
    }
    io.err(`bash: ${name}: command not found\n`)
    return 127
  }

  async runCommand(name: string, args: string[], io: IO): Promise<number> {
    const def = COMMANDS.get(name)!
    if (args.includes('--help') && def.usage) {
      io.out(`Usage: ${def.usage}\n${def.summary ? `${def.summary}\n` : ''}`)
      return 0
    }
    try {
      return await def.run({ name, args, stdin: io.stdin, out: io.out, err: io.err, sh: this, sys: this.sys, isTTY: io.isTTY })
    } catch (e) {
      if (e instanceof FsError) {
        io.err(`${name}: ${e.path}: ${e.message}\n`)
        return 1
      }
      throw e
    }
  }

  /** Trabajos en segundo plano de esta sesión (comando &). */
  jobs: { id: number; pid: number; text: string; state: 'Running' | 'Stopped' }[] = []

  /**
   * comando &: los programas que en la realidad siguen corriendo (sleep, yes, tail -f, bucles
   * infinitos) quedan como un proceso en segundo plano; el resto se ejecuta enseguida.
   */
  async startJob(body: Node, text: string, io: IO): Promise<number> {
    const id = (this.jobs.at(-1)?.id ?? 0) + 1
    const long = longRunning(body)
    const shellPid = this.sys.procs.find((p) => p.cmd === '-bash' && p.user === this.user)?.pid ?? 1
    let nohup = false
    let inner = body
    if (inner.kind === 'simple' && inner.words[0]?.parts.length === 1 && inner.words[0].parts[0].t === 'lit' && inner.words[0].parts[0].v === 'nohup') {
      nohup = true
      inner = { ...inner, words: inner.words.slice(1) }
    }
    if (long) {
      const cmd = text.replace(/^nohup\s+/, '')
      const proc = this.sys.spawn(this.user, cmd, long.cpu, 0.1, shellPid, Date.now())
      proc.stat = long.cpu > 50 ? 'R' : 'S'
      proc.tty = 'pts/0'
      this.jobs.push({ id, pid: proc.pid, text, state: 'Running' })
      io.err(`[${id}] ${proc.pid}\n`)
      if (nohup) io.err("nohup: ignoring input and appending output to 'nohup.out'\n")
      return 0
    }
    const pid = this.sys.allocPid()
    io.err(`[${id}] ${pid}\n`)
    const code = await this.exec(inner, nohup ? { ...io, out: (t) => this.appendNohup(t) } : io)
    io.err(`[${id}]+  ${code === 0 ? 'Done' : `Exit ${code}`}${' '.repeat(20)}${text}\n`)
    return 0
  }

  private appendNohup(text: string) {
    try {
      this.sys.vfs.writeFile(this.resolve('nohup.out'), text, this.cred, { append: true, mode: 0o600, umask: this.umask })
    } catch {
      // sin permiso en la carpeta actual
    }
  }

  /** Trabajos cuyo proceso sigue vivo. */
  liveJobs() {
    this.jobs = this.jobs.filter((j) => this.sys.procs.some((p) => p.pid === j.pid))
    for (const j of this.jobs) j.state = this.sys.procs.find((p) => p.pid === j.pid)!.stat.startsWith('T') ? 'Stopped' : 'Running'
    return this.jobs
  }

  /** bash script.sh: no hace falta el permiso de ejecución. */
  async runScriptWith(path: string, shown: string, args: string[], io: IO, options: Partial<Shell['options']>): Promise<number> {
    this.pendingScriptOptions = options
    try {
      return await this.runScript(path, shown, args, io, false)
    } finally {
      this.pendingScriptOptions = undefined
    }
  }

  private pendingScriptOptions?: Partial<Shell['options']>

  /** Ejecuta un archivo como script de bash. */
  async runScript(path: string, shown: string, args: string[], io: IO, needExec: boolean): Promise<number> {
    const vfs = this.sys.vfs
    let source: string
    try {
      const node = vfs.stat(path, this.cred)
      if (node.type === 'dir') {
        io.err(`bash: ${shown}: Is a directory\n`)
        return 126
      }
      if (needExec && !vfs.can(node, this.cred, 1)) {
        io.err(`bash: ${shown}: Permission denied\n`)
        return 126
      }
      source = vfs.readFile(path, this.cred)
    } catch (e) {
      if (e instanceof FsError) {
        io.err(`bash: ${shown}: ${e.message}\n`)
        return e.code === 'ENOENT' ? 127 : 126
      }
      throw e
    }
    return this.runSource(source, shown, args, io, { options: this.pendingScriptOptions })
  }

  /** Ejecuta un texto como script de bash (bash script.sh, bash -c '...'). */
  async runSource(source: string, shown: string, args: string[], io: IO, opts: { syntaxOnly?: boolean; options?: Partial<Shell['options']> } = {}): Promise<number> {
    if (source.includes('\r\n')) {
      // Igual que en Linux: el \r al final del shebang o de los comandos rompe el script.
      const first = source.split('\n')[0]
      if (first.startsWith('#!')) {
        io.err(`bash: ${shown}: ${first.slice(2).replace('\r', '')}^M: bad interpreter: No such file or directory\n`)
        return 126
      }
    }
    let node: Node
    try {
      node = parse(source.endsWith('\n') ? source : source + '\n')
    } catch (e) {
      if (e instanceof IncompleteInput) {
        io.err(`${shown}: line ${source.split('\n').length}: syntax error: unexpected end of file\n`)
        return 2
      }
      if (e instanceof ShellSyntaxError) {
        io.err(`${shown}: ${e.message.replace(/^bash: /, '')}\n`)
        return 2
      }
      throw e
    }
    if (opts.syntaxOnly) return 0
    const saved = this.saveState()
    const savedName = this.scriptName
    const savedFns = new Map(this.functions)
    this.positional = args
    this.scriptName = shown
    this.options = { errexit: false, nounset: false, pipefail: false, ...opts.options }
    this.traps = new Map()
    this.persistIO = undefined
    this.vars.set('OPTIND', '1')
    this.vars.delete('__OPTSUB')
    let code = 0
    try {
      code = await this.exec(node, io)
      return code
    } catch (e) {
      if (e instanceof ExitSignal) return (code = e.code)
      if (e instanceof ReturnSignal) return (code = e.code)
      throw e
    } finally {
      if (this.traps.has('EXIT')) {
        this.lastExit = code
        await this.runTrap('EXIT', io)
      }
      this.restoreState(saved)
      this.scriptName = savedName
      this.functions = savedFns
    }
  }

  // ---------------------------------------------------------------------------
  // Variables y expansión
  // ---------------------------------------------------------------------------

  getVar(name: string): string | undefined {
    switch (name) {
      case '?':
        return String(this.lastExit)
      case '$':
        return String(this.sys.procs.find((p) => p.cmd === '-bash' && p.user === this.user)?.pid ?? this.sys.procs.find((p) => p.cmd === '-bash')?.pid ?? 4721)
      case '#':
        return String(this.positional.length)
      case '@':
      case '*':
        return this.positional.join(' ')
      case '0':
        return this.scriptName
      case 'UID':
        return String(this.cred.uid)
      case 'RANDOM':
        return String(Math.floor(Math.random() * 32768))
      case 'FUNCNAME':
        return this.funcStack[this.funcStack.length - 1]
      case 'LINENO':
        return this.vars.get('LINENO') ?? '1'
    }
    if (/^\d+$/.test(name)) return this.positional[Number(name) - 1]
    const arr = this.arrays.get(name)
    if (arr) return arr.get('0')
    return this.vars.get(name)
  }

  setVar(name: string, value: string) {
    const arr = this.arrays.get(name)
    if (arr && !this.assoc.has(name)) {
      arr.set('0', value)
      return
    }
    this.vars.set(name, value)
  }

  /** Índice de un arreglo: aritmética en los indexados, texto en los asociativos. */
  arrayKey(name: string, index: string): string {
    if (this.assoc.has(name)) return index
    const n = evalArith(index, this)
    if (n < 0) {
      const keys = [...(this.arrays.get(name)?.keys() ?? [])].map(Number)
      return String((keys.length ? Math.max(...keys) + 1 : 0) + n)
    }
    return String(n)
  }

  getElem(name: string, index: string): string | undefined {
    const arr = this.arrays.get(name)
    if (!arr) return index === '0' || (!this.assoc.has(name) && evalArith(index, this) === 0) ? this.getVar(name) : undefined
    return arr.get(this.arrayKey(name, index))
  }

  setElem(name: string, index: string, value: string) {
    let arr = this.arrays.get(name)
    if (!arr) {
      arr = new Map()
      const scalar = this.vars.get(name)
      if (scalar !== undefined && !this.assoc.has(name)) arr.set('0', scalar)
      this.vars.delete(name)
      this.arrays.set(name, arr)
    }
    arr.set(this.arrayKey(name, index), value)
  }

  /** Valores de un arreglo en orden (los indexados por número). */
  arrayValues(name: string): string[] {
    const arr = this.arrays.get(name)
    if (!arr) {
      const v = this.vars.get(name)
      return v === undefined ? [] : [v]
    }
    return this.arrayKeys(name).map((k) => arr.get(k) ?? '')
  }

  arrayKeys(name: string): string[] {
    const arr = this.arrays.get(name)
    if (!arr) return this.vars.has(name) ? ['0'] : []
    const keys = [...arr.keys()]
    return this.assoc.has(name) ? keys : keys.sort((a, b) => Number(a) - Number(b))
  }

  setArray(name: string, values: string[] | Map<string, string>, append = false) {
    const arr = append ? (this.arrays.get(name) ?? new Map<string, string>()) : new Map<string, string>()
    if (values instanceof Map) for (const [k, v] of values) arr.set(k, v)
    else {
      let next = append && arr.size ? Math.max(...[...arr.keys()].map(Number).filter((n) => !Number.isNaN(n))) + 1 : 0
      for (const v of values) arr.set(String(next++), v)
    }
    this.vars.delete(name)
    this.arrays.set(name, arr)
  }

  unsetVar(name: string) {
    this.vars.delete(name)
    this.arrays.delete(name)
    this.assoc.delete(name)
    this.exported.delete(name)
  }

  declareLocal(name: string, value?: string) {
    const scope = this.localsStack[this.localsStack.length - 1]
    if (!scope) return false
    if (scope.has(name) && value === undefined) return true
    if (!scope.has(name)) scope.set(name, { value: this.vars.get(name), array: this.arrays.get(name), assoc: this.assoc.has(name) })
    this.arrays.delete(name)
    this.assoc.delete(name)
    if (value !== undefined) this.vars.set(name, value)
    else this.vars.delete(name)
    return true
  }

  private async expandHeredoc(body: string): Promise<string> {
    // Expande $VAR, ${VAR} y $(...) dentro del here-document.
    let out = ''
    let i = 0
    while (i < body.length) {
      const c = body[i]
      if (c === '\\' && (body[i + 1] === '$' || body[i + 1] === '`' || body[i + 1] === '\\')) {
        out += body[i + 1]
        i += 2
        continue
      }
      if (c === '$') {
        const m = /^\$(\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[?$#@*0-9]|\([^)]*\))/.exec(body.slice(i))
        if (m) {
          const w = await this.expandWord({ parts: [] }, { split: false, glob: false, raw: m[0] })
          out += w.join(' ')
          i += m[0].length
          continue
        }
      }
      out += c
      i++
    }
    return out
  }

  async expandWord(word: Word, opts: { split?: boolean; glob?: boolean; raw?: string } = {}): Promise<string[]> {
    const split = opts.split ?? true
    const glob = opts.glob ?? true
    if (opts.raw !== undefined) {
      // Expansión de un fragmento suelto (here-docs).
      const node = parse(`: ${opts.raw.replace(/\n/g, ' ')}`)
      if (node.kind === 'simple' && node.words[1]) return this.expandWord(node.words[1], { split: false, glob: false })
      return [opts.raw]
    }
    // "$@" o "${a[@]}" solos y vacíos: ninguna palabra.
    if (word.parts.length === 1 && word.parts[0].t === 'var' && word.parts[0].q && !word.parts[0].op && (word.parts[0].name === '@' || word.parts[0].index === '@') && !word.parts[0].mode) {
      const r = await this.expandVar(word.parts[0])
      return split ? r.values : [r.values.join(' ')]
    }
    const fields: { text: string; pattern: string; hasGlob: boolean; quotedEmpty: boolean }[] = []
    let cur = { text: '', pattern: '', hasGlob: false, quotedEmpty: false }
    let started = false
    const appendQuoted = (s: string) => {
      cur.text += s
      cur.pattern += s.replace(/[*?[\\]/g, '\\$&')
      started = true
      if (s === '') cur.quotedEmpty = true
    }
    const appendUnquotedLit = (s: string) => {
      cur.text += s
      cur.pattern += s
      if (GLOB_CHARS.test(s)) cur.hasGlob = true
      if (s) started = true
    }
    const appendExpansion = (s: string, quoted: boolean) => {
      if (quoted || !split) {
        appendQuoted(s)
        return
      }
      const ifs = this.vars.get('IFS')
      const pieces = ifs === undefined || ifs === ' \t\n' ? s.split(/[ \t\n]+/) : ifs === '' ? [s] : s.split(new RegExp(`[${ifs.replace(/[\]\\^-]/g, '\\$&')}]${/^[ \t\n]+$/.test(ifs) ? '+' : ''}`))
      pieces.forEach((p, idx) => {
        if (idx > 0) {
          if (started || cur.text) fields.push(cur)
          cur = { text: '', pattern: '', hasGlob: false, quotedEmpty: false }
          started = false
        }
        if (p) {
          cur.text += p
          cur.pattern += p
          if (GLOB_CHARS.test(p)) cur.hasGlob = true
          started = true
        }
      })
    }

    for (let idx = 0; idx < word.parts.length; idx++) {
      const part = word.parts[idx]
      if (part.t === 'lit') {
        let v = part.v
        if (!part.q && idx === 0 && v.startsWith('~')) {
          const m = /^~([A-Za-z0-9_-]*)(\/|$)/.exec(v)
          if (m) {
            const home = m[1] ? this.sys.users.get(m[1])?.home : this.home
            if (home) v = home + v.slice(1 + m[1].length)
          }
        }
        if (part.q) appendQuoted(v)
        else appendUnquotedLit(v)
      } else if (part.t === 'var') {
        const r = await this.expandVar(part)
        if (r.multi && part.q && r.sep === ' ' && split) {
          // "$@" y "${a[@]}": cada valor es una palabra aparte.
          r.values.forEach((v, k) => {
            if (k > 0) {
              fields.push(cur)
              cur = { text: '', pattern: '', hasGlob: false, quotedEmpty: false }
            }
            appendQuoted(v)
          })
        } else if (r.multi && !part.q) r.values.forEach((v, k) => appendExpansion((k > 0 ? ' ' : '') + v, false))
        else appendExpansion(r.values.join(r.sep), part.q)
      } else if (part.t === 'psub') {
        appendQuoted(await this.processSubst(part.src))
      } else if (part.t === 'cmd') {
        const output = await this.captureCommand(part.src)
        appendExpansion(output.replace(/\n+$/, ''), part.q)
      } else if (part.t === 'arith') {
        const expanded = await this.expandArithText(part.expr)
        appendExpansion(String(evalArith(expanded, this)), part.q)
      }
    }
    if (started || cur.text || cur.quotedEmpty) fields.push(cur)

    const result: string[] = []
    for (const f of fields) {
      if (glob && f.hasGlob) {
        const matches = this.glob(f.pattern)
        if (matches.length) {
          result.push(...matches)
          continue
        }
        if (this.shopts.has('nullglob')) continue
      }
      result.push(f.text)
    }
    return result
  }

  private async expandArithText(expr: string): Promise<string> {
    if (!expr.includes('$') && !expr.includes('`')) return expr
    return this.expandText(expr)
  }

  /** Expande un texto como si estuviera entre comillas dobles ($var, ${...}, $(...), $((...))). */
  async expandText(text: string): Promise<string> {
    if (!/[$`\\]/.test(text)) return text
    try {
      const toks = tokenize(`"${text.replace(/(?<!\\)"/g, '\\"')}"`)
      const w = toks.find((t) => t.type === 'word') as { word: Word } | undefined
      if (!w) return text
      return (await this.expandWord(w.word, { split: false, glob: false })).join(' ')
    } catch (e) {
      if (e instanceof ExpansionError) throw e
      return text
    }
  }

  /** Prefijo de la traza de bash -x (PS4). */
  ps4(): string {
    return this.vars.get('PS4') ?? '+ '
  }

  /** Expande ${...}. Devuelve varios valores para "$@" y "${a[@]}". */
  private async expandVar(part: Extract<Word['parts'][number], { t: 'var' }>): Promise<{ values: string[]; multi: boolean; sep: string }> {
    const one = (v: string) => ({ values: [v], multi: false, sep: ' ' })
    const name = part.name
    if (part.index !== undefined && part.index !== '@' && part.index !== '*' && /[$`]/.test(part.index)) part = { ...part, index: await this.expandText(part.index) }
    const isArrayRef = part.index === '@' || part.index === '*'
    const allArgs = name === '@' || name === '*'
    const sepFor = (star: boolean) => (star ? (this.vars.get('IFS') ?? ' ')[0] ?? '' : ' ')
    // ${!x} indirecta, ${!a[@]} claves
    if (part.mode === 'indirect') {
      const target = this.getVar(name) ?? ''
      const m = /^([A-Za-z_]\w*)(?:\[(.+)\])?$/.exec(target)
      if (!m) return one('')
      return one((m[2] !== undefined ? this.getElem(m[1], m[2]) : this.getVar(m[1])) ?? '')
    }
    if (part.mode === 'keys') return { values: this.arrayKeys(name), multi: true, sep: sepFor(part.index === '*') }
    if (part.mode === 'len') {
      if (isArrayRef) return one(String(this.arrayValues(name).length))
      if (allArgs) return one(String(this.positional.length))
      const v = part.index !== undefined ? this.getElem(name, part.index) : this.getVar(name)
      return one(String([...(v ?? '')].length))
    }
    // Lista de valores (arreglo completo o todos los argumentos).
    let list: string[] | undefined
    if (isArrayRef) list = this.arrayValues(name)
    else if (allArgs) list = [...this.positional]
    const star = part.index === '*' || name === '*'
    const value: string | undefined = list ? (list.length ? list.join(sepFor(star)) : undefined) : part.index !== undefined ? this.getElem(name, part.index) : this.getVar(name)
    const set = value !== undefined
    const arg = async () => (part.arg !== undefined ? this.expandText(part.arg.replace(/^"(.*)"$/s, '$1')) : '')
    const op = part.op
    if (op === ':-' || op === '-') {
      if ((op === ':-' && !value) || (op === '-' && !set)) return one(await arg())
    } else if (op === ':=' || op === '=') {
      if ((op === ':=' && !value) || (op === '=' && !set)) {
        const v = await arg()
        if (part.index !== undefined && !isArrayRef) this.setElem(name, part.index, v)
        else this.setVar(name, v)
        return one(v)
      }
    } else if (op === ':+' || op === '+') {
      return one((op === ':+' ? !!value : set) ? await arg() : '')
    } else if (op === ':?' || op === '?') {
      if ((op === ':?' && !value) || (op === '?' && !set)) throw new ExpansionError(`bash: ${name}: ${(await arg()) || (op === ':?' ? 'parameter null or not set' : 'parameter not set')}`)
    } else if (op) {
      const transform = await this.patternOp(op, part.arg ?? '')
      if (list) {
        const vals = transform ? list.map(transform) : list
        if (op === ':') {
          const [offS, lenS] = splitTop(part.arg ?? '')
          const off = evalArith(offS || '0', this)
          const start = off < 0 ? Math.max(0, vals.length + off) : off
          const sliced = lenS !== undefined ? vals.slice(start, start + evalArith(lenS, this)) : vals.slice(start)
          return { values: sliced, multi: true, sep: sepFor(star) }
        }
        return { values: vals, multi: true, sep: sepFor(star) }
      }
      if (op === ':') {
        const [offS, lenS] = splitTop(part.arg ?? '')
        const v = [...(value ?? '')]
        const off = evalArith(offS || '0', this)
        const start = off < 0 ? Math.max(0, v.length + off) : off
        let end = v.length
        if (lenS !== undefined) {
          const len = evalArith(lenS, this)
          end = len < 0 ? v.length + len : start + len
        }
        return one(v.slice(start, end).join(''))
      }
      return one(transform ? transform(value ?? '') : (value ?? ''))
    }
    if (list) return { values: list, multi: true, sep: sepFor(star) }
    if (!set && this.options.nounset && !/^[?$#@*0]$/.test(name)) throw new ExpansionError(`bash: ${name}${part.index !== undefined ? `[${part.index}]` : ''}: unbound variable`)
    return one(value ?? '')
  }

  /** # ## % %% / // /# /% ^ ^^ , ,, : una función que transforma cada valor. */
  private async patternOp(op: string, rawArg: string): Promise<((v: string) => string) | undefined> {
    if (op === ':') return undefined
    const toRe = (pat: string, anchor: 'start' | 'end' | 'full' | 'none', lazy: boolean) => {
      let src = ''
      for (let k = 0; k < pat.length; k++) {
        const c = pat[k]
        if (c === '\\' && k + 1 < pat.length) src += pat[++k].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        else if (c === '*') src += lazy ? '.*?' : '.*'
        else if (c === '?') src += '.'
        else if (c === '[') {
          const b = bracketToRe(pat, k)
          if (b) {
            src += b.re
            k = b.end
          } else src += '\\['
        } else src += c.replace(/[.+^${}()|\]\\]/g, '\\$&')
      }
      return new RegExp(anchor === 'start' ? `^(?:${src})` : anchor === 'end' ? `(?:${src})$` : anchor === 'full' ? `^(?:${src})$` : src, 's')
    }
    if (op === '^' || op === '^^' || op === ',' || op === ',,') {
      const pat = rawArg ? toRe(await this.expandText(rawArg), 'full', false) : undefined
      const conv = (ch: string) => (!pat || pat.test(ch) ? (op[0] === '^' ? ch.toUpperCase() : ch.toLowerCase()) : ch)
      return (v) => (op.length === 2 ? [...v].map(conv).join('') : v ? conv(v[0]) + v.slice(1) : v)
    }
    if (op === '#' || op === '##' || op === '%' || op === '%%') {
      const pat = toRe(await this.expandText(rawArg.replace(/^"(.*)"$/s, '$1')), 'full', false)
      return (v) => {
        const chars = [...v]
        if (op === '#' || op === '##') {
          const order = op === '#' ? chars.map((_, k) => k).concat(chars.length) : [chars.length, ...chars.map((_, k) => chars.length - 1 - k)]
          for (const k of order) if (pat.test(chars.slice(0, k).join(''))) return chars.slice(k).join('')
        } else {
          const order = op === '%' ? [chars.length, ...chars.map((_, k) => chars.length - 1 - k)] : chars.map((_, k) => k).concat(chars.length)
          for (const k of order) if (pat.test(chars.slice(k).join(''))) return chars.slice(0, k).join('')
        }
        return v
      }
    }
    // / // /# /%: patrón/reemplazo
    const sl = findUnescapedSlash(rawArg)
    const pat = await this.expandText(sl < 0 ? rawArg : rawArg.slice(0, sl))
    const rep = sl < 0 ? '' : await this.expandText(rawArg.slice(sl + 1))
    const re = toRe(pat, op === '/#' ? 'start' : op === '/%' ? 'end' : 'none', false)
    if (!pat) return (v) => v
    if (op === '//') {
      const g = new RegExp(re.source, 'gs')
      return (v) => v.replace(g, () => rep)
    }
    return (v) => v.replace(re, () => rep)
  }

  async captureCommand(src: string): Promise<string> {
    let out = ''
    const saved = this.saveState()
    this.noLine++
    try {
      const node = parse(src)
      await this.exec(node, { stdin: new Stdin(), out: (s) => (out += s), err: () => undefined, isTTY: false })
    } catch (e) {
      if (!(e instanceof ExitSignal)) {
        // errores de sintaxis dentro de $( ) se ignoran
      }
    } finally {
      this.noLine--
      const exit = this.lastExit
      this.restoreState(saved)
      this.lastExit = exit
    }
    return out
  }

  glob(pattern: string): string[] {
    const absolute = pattern.startsWith('/')
    const segments = pattern.split('/').filter((s, i) => s !== '' || i === 0)
    let bases: string[] = [absolute ? '/' : '']
    for (const seg of segments) {
      if (seg === '' && absolute) continue
      const next: string[] = []
      for (const base of bases) {
        const dir = base === '' ? this.cwd : this.resolve(base)
        if (!GLOB_CHARS.test(seg)) {
          const candidate = base === '' ? seg.replace(/\\(.)/g, '$1') : base === '/' ? `/${seg}` : `${base}/${seg}`
          if (this.sys.vfs.exists(this.resolve(candidate.replace(/\\(.)/g, '$1')), this.cred, false)) next.push(candidate.replace(/\\(.)/g, '$1'))
          continue
        }
        let names: string[]
        try {
          names = this.sys.vfs.readdir(dir, this.cred)
        } catch {
          continue
        }
        const re = globToRegex(seg)
        for (const n of names) {
          if (n.startsWith('.') && !seg.startsWith('.') && !this.shopts.has('dotglob')) continue
          if (re.test(n)) next.push(base === '' ? n : base === '/' ? `/${n}` : `${base}/${n}`)
        }
      }
      bases = next
    }
    return bases.filter((b) => b !== '' && b !== '/').sort((a, b) => a.localeCompare(b, 'en'))
  }
}

export class ExpansionError extends Error {}

/** Separa "offset:largo" de ${v:offset:largo} (respetando paréntesis). */
/** Cómo muestra bash -x cada palabra: entre comillas simples si hace falta. */
function traceQuote(w: string): string {
  if (w === '') return "''"
  return /^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`
}

const POSIX_CLASSES: Record<string, string> = { space: '\\s', blank: ' \\t', digit: '0-9', alpha: 'A-Za-z', alnum: 'A-Za-z0-9', upper: 'A-Z', lower: 'a-z', punct: '!-\\/:-@\\[-`{-~', xdigit: '0-9A-Fa-f', print: '\\x20-\\x7e', graph: '\\x21-\\x7e', cntrl: '\\x00-\\x1f' }

/** [abc], [!a-z], [[:space:]]: la clase de un patrón de bash como expresión regular. */
export function bracketToRe(pat: string, start: number): { re: string; end: number } | undefined {
  let k = start + 1
  let neg = false
  if (pat[k] === '!' || pat[k] === '^') {
    neg = true
    k++
  }
  let body = ''
  let first = true
  while (k < pat.length) {
    if (pat[k] === ']' && !first) return { re: `[${neg ? '^' : ''}${body}]`, end: k }
    first = false
    const cls = /^\[:([a-z]+):\]/.exec(pat.slice(k))
    if (cls) {
      body += POSIX_CLASSES[cls[1]] ?? ''
      k += cls[0].length
      continue
    }
    const ch = pat[k]
    body += ch === '\\' || ch === ']' || ch === '[' || ch === '^' ? '\\' + ch : ch
    k++
  }
  return undefined
}

function splitTop(arg: string): [string, string | undefined] {
  let depth = 0
  for (let k = 0; k < arg.length; k++) {
    if (arg[k] === '(') depth++
    if (arg[k] === ')') depth--
    if (arg[k] === ':' && depth === 0) return [arg.slice(0, k), arg.slice(k + 1)]
  }
  return [arg, undefined]
}

function findUnescapedSlash(s: string): number {
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '\\') {
      k++
      continue
    }
    if (s[k] === '/') return k
  }
  return -1
}

// ---------------------------------------------------------------------------------------
// Aritmética $(( ))
// ---------------------------------------------------------------------------------------


/** Aritmética de bash ($(( )), (( )), let), con asignaciones y arreglos. */
export function evalArith(expr: string, sh?: Shell): number {
  try {
    return arith(expr, {
      get: (name, index) => (sh ? (index !== undefined ? sh.getElem(name, index) : sh.getVar(name)) : undefined),
      set: (name, value, index) => {
        if (!sh) return
        if (sh.readonlyVars.has(name)) throw new ExpansionError(`bash: ${name}: readonly variable`)
        if (index !== undefined) sh.setElem(name, index, value)
        else sh.setVar(name, value)
      },
    })
  } catch (e) {
    if (e instanceof ArithError) throw new ExpansionError(e.message)
    throw e
  }
}

// ---------------------------------------------------------------------------------------
// Comandos internos (builtins)
// ---------------------------------------------------------------------------------------

type Builtin = (sh: Shell, args: string[], io: IO) => number | Promise<number>

function unescapeEcho(s: string): string {
  return s.replace(/\\(n|t|\\|e|a|r|0[0-7]{0,3})/g, (_, c: string) =>
    c === 'n' ? '\n' : c === 't' ? '\t' : c === '\\' ? '\\' : c === 'e' ? '\x1b' : c === 'r' ? '\r' : c === 'a' ? '' : String.fromCharCode(parseInt(c, 8)),
  )
}

export function formatPrintf(format: string, args: string[]): string {
  const fmt = unescapeEcho(format)
  let out = ''
  let argi = 0
  const spec = /%([-0 +#]*)(\d*)(?:\.(\d+))?([sdifxXoc%b])/g
  do {
    let consumed = false
    out += fmt.replace(spec, (_, flags: string, width: string, prec: string, conv: string) => {
      if (conv === '%') return '%'
      const arg = args[argi++] ?? ''
      consumed = true
      let s: string
      switch (conv) {
        case 'd':
        case 'i':
          s = String(parseInt(arg, 10) || 0)
          break
        case 'f':
          s = (parseFloat(arg) || 0).toFixed(prec ? Number(prec) : 6)
          break
        case 'x':
          s = (parseInt(arg, 10) || 0).toString(16)
          break
        case 'X':
          s = (parseInt(arg, 10) || 0).toString(16).toUpperCase()
          break
        case 'o':
          s = (parseInt(arg, 10) || 0).toString(8)
          break
        case 'c':
          s = arg.charAt(0)
          break
        case 'b':
          s = unescapeEcho(arg)
          break
        default:
          s = prec ? arg.slice(0, Number(prec)) : arg
      }
      const w = Number(width || 0)
      if (s.length < w) s = flags.includes('-') ? s.padEnd(w) : flags.includes('0') && conv !== 's' ? s.padStart(w, '0') : s.padStart(w)
      return s
    })
    if (!consumed) break
  } while (argi < args.length)
  return out
}

function fileTest(sh: Shell, op: string, path: string): boolean {
  const vfs = sh.sys.vfs
  const abs = sh.resolve(path)
  try {
    if (op === '-L' || op === '-h') return vfs.stat(abs, sh.cred, false).type === 'symlink'
    const node = vfs.stat(abs, sh.cred)
    switch (op) {
      case '-e':
        return true
      case '-f':
        return node.type === 'file'
      case '-d':
        return node.type === 'dir'
      case '-s':
        return node.type === 'dir' || node.data.length > 0
      case '-r':
        return vfs.can(node, sh.cred, 4)
      case '-w':
        return vfs.can(node, sh.cred, 2)
      case '-x':
        return vfs.can(node, sh.cred, 1)
    }
  } catch {
    return false
  }
  return false
}

const UNARY = new Set(['-e', '-f', '-d', '-s', '-r', '-w', '-x', '-L', '-h', '-z', '-n'])
const BINARY = new Set(['=', '==', '!=', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '=~', '<', '>'])

export function evalTest(sh: Shell, args: string[], extended: boolean): boolean {
  let pos = 0
  const peek = () => args[pos]
  const primary = (): boolean => {
    const t = args[pos]
    if (t === '!') {
      pos++
      return !primary()
    }
    if (t === '(') {
      pos++
      const v = orExpr()
      pos++ // )
      return v
    }
    if (UNARY.has(t) && args[pos + 1] !== undefined && !BINARY.has(args[pos + 1])) {
      pos += 2
      const a = args[pos - 1]
      if (t === '-z') return a.length === 0
      if (t === '-n') return a.length > 0
      return fileTest(sh, t, a)
    }
    if (BINARY.has(args[pos + 1] ?? '')) {
      const a = args[pos]
      const op = args[pos + 1]
      const b = args[pos + 2] ?? ''
      pos += 3
      const na = parseInt(a, 10)
      const nb = parseInt(b, 10)
      const numeric = op.startsWith('-')
      if (numeric && (Number.isNaN(na) || Number.isNaN(nb))) {
        throw new ExpansionError(`bash: [: ${Number.isNaN(na) ? a : b}: integer expression expected`)
      }
      switch (op) {
        case '=':
        case '==':
          return extended ? matchPattern(a, b) : a === b
        case '!=':
          return extended ? !matchPattern(a, b) : a !== b
        case '-eq':
          return na === nb
        case '-ne':
          return na !== nb
        case '-lt':
          return na < nb
        case '-le':
          return na <= nb
        case '-gt':
          return na > nb
        case '-ge':
          return na >= nb
        case '<':
          return a < b
        case '>':
          return a > b
        case '=~': {
          try {
            const m = new RegExp(b).exec(a)
            if (m) sh.setArray('BASH_REMATCH', [...m].map((x) => x ?? ''))
            else sh.setArray('BASH_REMATCH', [])
            return !!m
          } catch {
            return false
          }
        }
      }
    }
    pos++
    return (t ?? '').length > 0
  }
  const andExpr = (): boolean => {
    let v = primary()
    while (peek() === '&&' || peek() === '-a') {
      pos++
      const r = primary()
      v = v && r
    }
    return v
  }
  const orExpr = (): boolean => {
    let v = andExpr()
    while (peek() === '||' || peek() === '-o') {
      pos++
      const r = andExpr()
      v = v || r
    }
    return v
  }
  if (args.length === 0) return false
  return orExpr()
}

/** Programas que no terminan solos (o tardan): quedan como trabajo en segundo plano. */
function longRunning(node: Node): { cpu: number } | undefined {
  if (node.kind === 'while' || node.kind === 'for') return { cpu: 99.7 }
  if (node.kind === 'pipeline') return longRunning(node.cmds[0])
  if (node.kind !== 'simple') return undefined
  const words = node.words.map((w) => w.parts.map((p) => (p.t === 'lit' ? p.v : '')).join(''))
  if (words[0] === 'nohup') words.shift()
  const [cmd, ...rest] = words
  const base = (cmd ?? '').split('/').pop()
  if (base === 'sleep') return Number(rest[0]?.replace(/[smhd]$/, '') ?? 0) > 1 || /[mhd]$/.test(rest[0] ?? '') || rest[0] === 'infinity' ? { cpu: 0 } : undefined
  if (base === 'yes' || ((base === 'md5sum' || base === 'sha256sum' || base === 'gzip') && rest.includes('/dev/urandom'))) return { cpu: 99.7 }
  if (base === 'dd' && rest.some((r) => /^if=\/dev\/(zero|urandom)/.test(r)) && rest.some((r) => r === 'of=/dev/null')) return { cpu: 99.7 }
  if (base === 'tail' && rest.some((r) => r === '-f' || r === '-F')) return { cpu: 0 }
  if (base === 'ping' && !rest.includes('-c')) return { cpu: 0 }
  if (base === 'top' || base === 'watch' || base === 'vmstat' || base === 'iostat') return { cpu: 0.3 }
  if (/\.sh$/.test(base ?? '') && rest.length === 0 && /(^|\/)(largo|infinito|loop|bucle)/.test(cmd ?? '')) return { cpu: 50 }
  return undefined
}

export function jobFor(sh: Shell, spec: string | undefined) {
  const jobs = sh.liveJobs()
  if (!spec || spec === '%%' || spec === '%+' || spec === '%') return jobs.at(-1)
  if (spec === '%-') return jobs.at(-2)
  const n = /^%?(\d+)$/.exec(spec)
  if (n) return jobs.find((j) => j.id === Number(n[1]))
  const name = spec.replace(/^%\??/, '')
  return jobs.find((j) => j.text.includes(name))
}

export const BUILTINS: Record<string, Builtin> = {
  jobs: (sh, args, io) => {
    const jobs = sh.liveJobs()
    const l = args.includes('-l')
    const p = args.includes('-p')
    jobs.forEach((j, i) => {
      const mark = i === jobs.length - 1 ? '+' : i === jobs.length - 2 ? '-' : ' '
      if (p) io.out(`${j.pid}\n`)
      else io.out(`[${j.id}]${mark}  ${l ? `${j.pid} ` : ''}${j.state.padEnd(24)}${j.text}${j.state === 'Running' ? ' &' : ''}\n`)
    })
    return 0
  },
  fg: (sh, args, io) => {
    const j = jobFor(sh, args[0])
    if (!j) {
      io.err(`bash: fg: ${args[0] ?? 'current'}: no such job\n`)
      return 1
    }
    io.out(j.text + '\n')
    const proc = sh.sys.procs.find((p) => p.pid === j.pid)
    if (proc && /^sleep\b/.test(j.text)) {
      // sleep en primer plano: termina cuando se cumple el tiempo.
      sh.sys.procs = sh.sys.procs.filter((p) => p.pid !== j.pid)
      return 0
    }
    io.err('[simulador] El trabajo pasó al primer plano. En un servidor real, la terminal queda ocupada hasta que termine; se corta con Ctrl+C o se manda de nuevo atrás con Ctrl+Z y bg.\n')
    sh.sys.procs = sh.sys.procs.filter((p) => p.pid !== j.pid)
    io.out('^C\n')
    return 130
  },
  bg: (sh, args, io) => {
    const j = jobFor(sh, args[0])
    if (!j) {
      io.err(`bash: bg: ${args[0] ?? 'current'}: no such job\n`)
      return 1
    }
    if (j.state === 'Running') {
      io.err(`bash: bg: job ${j.id} already in background\n`)
      return 0
    }
    j.state = 'Running'
    const proc = sh.sys.procs.find((p) => p.pid === j.pid)
    if (proc) proc.stat = proc.cpu > 50 ? 'R' : 'S'
    io.out(`[${j.id}]+ ${j.text} &\n`)
    return 0
  },
  disown: (sh, args, io) => {
    const j = jobFor(sh, args[0])
    if (!j) {
      io.err(`bash: disown: ${args[0] ?? 'current'}: no such job\n`)
      return 1
    }
    sh.jobs = sh.jobs.filter((x) => x !== j)
    return 0
  },
  wait: (sh) => {
    // Los trabajos que terminan solos (sleep) terminan; los infinitos quedarían esperando para siempre.
    const sleepers = sh.liveJobs().filter((j) => /^sleep\b/.test(j.text))
    sh.sys.procs = sh.sys.procs.filter((p) => !sleepers.some((j) => j.pid === p.pid))
    return 0
  },
  ':': () => 0,
  true: () => 0,
  false: () => 1,
  echo: (_sh, args, io) => {
    let newline = true
    let escapes = false
    let i = 0
    while (i < args.length && /^-[neE]+$/.test(args[i])) {
      if (args[i].includes('n')) newline = false
      if (args[i].includes('e')) escapes = true
      if (args[i].includes('E')) escapes = false
      i++
    }
    const text = args.slice(i).join(' ')
    io.out((escapes ? unescapeEcho(text) : text) + (newline ? '\n' : ''))
    return 0
  },
  printf: (_sh, args, io) => {
    if (!args.length) {
      io.err('printf: usage: printf [-v var] format [arguments]\n')
      return 2
    }
    io.out(formatPrintf(args[0], args.slice(1)))
    return 0
  },
  cd: (sh, args, io) => {
    const target = args[0] === undefined || args[0] === '~' ? sh.home : args[0] === '-' ? (sh.vars.get('OLDPWD') ?? sh.cwd) : args[0]
    const abs = sh.resolve(target)
    try {
      const node = sh.sys.vfs.stat(abs, sh.cred)
      if (node.type !== 'dir') {
        io.err(`bash: cd: ${args[0]}: Not a directory\n`)
        return 1
      }
      if (!sh.sys.vfs.can(node, sh.cred, 1)) {
        io.err(`bash: cd: ${args[0]}: Permission denied\n`)
        return 1
      }
    } catch (e) {
      if (e instanceof FsError) {
        io.err(`bash: cd: ${args[0]}: ${e.message}\n`)
        return 1
      }
      throw e
    }
    sh.vars.set('OLDPWD', sh.cwd)
    sh.cwd = abs
    if (args[0] === '-') io.out(abs + '\n')
    return 0
  },
  pwd: (sh, _args, io) => {
    io.out(sh.cwd + '\n')
    return 0
  },
  export: (sh, args, io) => {
    if (args.length === 0 || args[0] === '-p') {
      for (const k of [...sh.exported].sort()) io.out(`declare -x ${k}="${sh.vars.get(k) ?? ''}"\n`)
      return 0
    }
    for (const a of args) {
      const [k, ...v] = a.split('=')
      if (v.length) sh.vars.set(k, v.join('='))
      sh.exported.add(k)
    }
    return 0
  },
  unset: (sh, args, io) => {
    const onlyFn = args.includes('-f')
    for (const a of args.filter((x) => !x.startsWith('-'))) {
      const el = /^([A-Za-z_]\w*)\[(.+)\]$/.exec(a)
      if (el) {
        sh.arrays.get(el[1])?.delete(sh.arrayKey(el[1], el[2]))
        continue
      }
      if (sh.readonlyVars.has(a)) {
        io.err(`bash: unset: ${a}: cannot unset: readonly variable\n`)
        return 1
      }
      if (!onlyFn) sh.unsetVar(a)
      if (onlyFn || !sh.vars.has(a)) sh.functions.delete(a)
    }
    return 0
  },
  local: (sh, args, io) => {
    const flags = args.filter((a) => /^-[aAirx]+$/.test(a)).join('')
    for (const a of args.filter((x) => !/^-[aAirx]+$/.test(x))) {
      const [k, ...v] = a.split('=')
      if (!sh.declareLocal(k, v.length ? v.join('=') : undefined)) {
        io.err('bash: local: can only be used in a function\n')
        return 1
      }
      if (flags.includes('A')) {
        sh.assoc.add(k)
        if (!sh.arrays.has(k)) sh.arrays.set(k, new Map())
      } else if (flags.includes('a') && !sh.arrays.has(k)) sh.arrays.set(k, new Map())
      if (flags.includes('i')) sh.integerVars.add(k)
      if (flags.includes('r')) sh.readonlyVars.add(k)
    }
    return 0
  },
  declare: (sh, args, io) => declareBuiltin(sh, args, io, 'declare'),
  typeset: (sh, args, io) => declareBuiltin(sh, args, io, 'typeset'),
  readonly: (sh, args, io) => declareBuiltin(sh, ['-r', ...args], io, 'readonly'),
  let: (sh, args, io) => {
    let v = 0
    try {
      for (const a of args) v = evalArith(a, sh)
    } catch (e) {
      if (e instanceof ExpansionError) {
        io.err(e.message.replace(/^bash: /, 'bash: let: ') + '\n')
        return 1
      }
      throw e
    }
    return v !== 0 ? 0 : 1
  },
  mapfile: (sh, args, io) => mapfileBuiltin(sh, args, io),
  shopt: (sh, args, io) => {
    const known = ['nullglob', 'dotglob', 'extglob', 'globstar', 'failglob', 'nocaseglob', 'lastpipe', 'expand_aliases']
    const flag = args.find((a) => a === '-s' || a === '-u' || a === '-p' || a === '-q')
    const names = args.filter((a) => !a.startsWith('-'))
    for (const n of names) {
      if (!known.includes(n)) {
        io.err(`bash: shopt: ${n}: invalid shell option name\n`)
        return 1
      }
    }
    if (flag === '-s') names.forEach((n) => sh.shopts.add(n))
    else if (flag === '-u') names.forEach((n) => sh.shopts.delete(n))
    else if (flag === '-q') return names.every((n) => sh.shopts.has(n)) ? 0 : 1
    else for (const n of names.length ? names : known) io.out(`${n.padEnd(16)}${sh.shopts.has(n) ? 'on' : 'off'}\n`)
    return 0
  },
  getopts: (sh, args, io) => {
    // getopts "ab:c" opt [args...]: una opción por llamada, con OPTIND y OPTARG.
    const [spec = '', name = 'opt', ...rest] = args
    const list = rest.length ? rest : sh.positional
    const silent = spec.startsWith(':')
    const opts = silent ? spec.slice(1) : spec
    let ind = Number(sh.vars.get('OPTIND') ?? '1') || 1
    let sub = Number(sh.vars.get('__OPTSUB') ?? '1') || 1
    const word = list[ind - 1]
    if (!word || word === '--' || !word.startsWith('-') || word === '-') {
      if (word === '--') sh.vars.set('OPTIND', String(ind + 1))
      sh.setVar(name, '?')
      sh.vars.delete('__OPTSUB')
      return 1
    }
    const ch = word[sub]
    const advance = () => {
      if (sub + 1 >= word.length) {
        ind++
        sub = 1
      } else sub++
    }
    const pos = opts.indexOf(ch)
    if (pos < 0 || ch === ':') {
      advance()
      sh.vars.set('OPTIND', String(ind))
      sh.vars.set('__OPTSUB', String(sub))
      sh.setVar(name, '?')
      if (silent) sh.setVar('OPTARG', ch)
      else io.err(`${sh.getVar('0')}: illegal option -- ${ch}\n`)
      return 0
    }
    if (opts[pos + 1] === ':') {
      let value: string | undefined
      if (sub + 1 < word.length) value = word.slice(sub + 1)
      else value = list[ind]
      const used = sub + 1 < word.length ? 1 : 2
      ind += used
      sub = 1
      sh.vars.set('OPTIND', String(ind))
      sh.vars.set('__OPTSUB', '1')
      if (value === undefined) {
        if (silent) {
          sh.setVar(name, ':')
          sh.setVar('OPTARG', ch)
        } else {
          io.err(`${sh.getVar('0')}: option requires an argument -- ${ch}\n`)
          sh.setVar(name, '?')
        }
        return 0
      }
      sh.setVar('OPTARG', value)
      sh.setVar(name, ch)
      return 0
    }
    advance()
    sh.vars.set('OPTIND', String(ind))
    sh.vars.set('__OPTSUB', String(sub))
    sh.setVar(name, ch)
    return 0
  },
  readarray: (sh, args, io) => mapfileBuiltin(sh, args, io),
  trap: (sh, args, io) => {
    if (!args.length || args[0] === '-p') {
      for (const [sig, cmd] of sh.traps) io.out(`trap -- '${cmd}' ${sig}\n`)
      return 0
    }
    if (args[0] === '-l') {
      io.out(' 1) SIGHUP\t 2) SIGINT\t 3) SIGQUIT\t 9) SIGKILL\t15) SIGTERM\n')
      return 0
    }
    const [cmd, ...sigs] = args
    for (const raw of sigs) {
      const sig = raw.toUpperCase().replace(/^SIG/, '').replace(/^0$/, 'EXIT')
      if (cmd === '-' || cmd === '') sh.traps.delete(sig)
      else sh.traps.set(sig, cmd)
    }
    return 0
  },
  exec: async (sh, args, io) => {
    // exec comando: lo ejecuta y el shell termina con su código.
    const code = await sh.invoke(args, io)
    throw new ExitSignal(code)
  },
  set: (sh, args, io) => {
    if (args.length === 0) {
      for (const [k, v] of [...sh.vars].sort()) io.out(`${k}=${v}\n`)
      return 0
    }
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      const on = a.startsWith('-')
      if (a === '-o' || a === '+o') {
        const opt = args[++i]
        if (opt === 'pipefail') sh.options.pipefail = on
        if (opt === 'errexit') sh.options.errexit = on
        if (opt === 'nounset') sh.options.nounset = on
        if (opt === 'xtrace') sh.options.xtrace = on
        continue
      }
      if (/^[-+][euxo]+$/.test(a)) {
        if (a.includes('e')) sh.options.errexit = on
        if (a.includes('u')) sh.options.nounset = on
        if (a.includes('x')) sh.options.xtrace = on
        if (a.includes('o') && args[i + 1] === 'pipefail') {
          sh.options.pipefail = on
          i++
        }
        continue
      }
      if (a === '--') {
        sh.positional = args.slice(i + 1)
        break
      }
    }
    return 0
  },
  shift: (sh, args) => {
    const n = Number(args[0] ?? 1)
    if (n > sh.positional.length) return 1
    sh.positional = sh.positional.slice(n)
    return 0
  },
  exit: (sh, args) => {
    throw new ExitSignal(args[0] !== undefined ? Number(args[0]) & 255 : sh.lastExit)
  },
  logout: (sh) => {
    throw new ExitSignal(sh.lastExit)
  },
  return: (sh, args) => {
    throw new ReturnSignal(args[0] !== undefined ? Number(args[0]) & 255 : sh.lastExit)
  },
  break: (_sh, args) => {
    throw new LoopSignal('break', Number(args[0] ?? 1))
  },
  continue: (_sh, args) => {
    throw new LoopSignal('continue', Number(args[0] ?? 1))
  },
  read: (sh, args, io) => {
    let raw = false
    let arrayName: string | undefined
    const names: string[] = []
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (/^-[rsa]+$/.test(a) && (a.includes('r') || a.includes('s') || a.includes('a'))) {
        if (a.includes('r')) raw = true
        if (a.includes('a')) arrayName = args[++i]
      } else if (a === '-p') {
        const prompt = args[++i] ?? ''
        if (io.stdin.empty) io.err(prompt)
      } else if (a === '-t' || a === '-n' || a === '-d') i++
      else names.push(a)
    }
    let line = io.stdin.readLine()
    if (line === null) return 1
    if (!raw) line = line.replace(/\\(.)/g, '$1')
    const vars = names.length ? names : ['REPLY']
    const ifs = sh.vars.get('IFS')
    const parts = ifs !== undefined && ifs !== ' \t\n' ? line.split(new RegExp(`[${ifs.replace(/[\]\\^-]/g, '\\$&')}]`)) : line.trim().split(/\s+/)
    if (arrayName) {
      sh.setArray(arrayName, line.trim() === '' && (ifs === undefined || ifs === ' \t\n') ? [] : parts)
      return 0
    }
    vars.forEach((v, idx) => sh.setVar(v, idx === vars.length - 1 ? parts.slice(idx).join(ifs && ifs !== ' \t\n' ? ifs[0] : ' ') : (parts[idx] ?? '')))
    return 0
  },
  test: (sh, args, io) => {
    try {
      return evalTest(sh, args, false) ? 0 : 1
    } catch (e) {
      io.err(e instanceof Error ? e.message.replace('[:', 'test:') + '\n' : '')
      return 2
    }
  },
  '[': (sh, args, io) => {
    if (args[args.length - 1] !== ']') {
      io.err("bash: [: missing `]'\n")
      return 2
    }
    try {
      return evalTest(sh, args.slice(0, -1), false) ? 0 : 1
    } catch (e) {
      io.err((e as Error).message + '\n')
      return 2
    }
  },
  '[[': (sh, args, io) => {
    if (args[args.length - 1] !== ']]') {
      io.err("bash: syntax error near unexpected token `newline'\n")
      return 2
    }
    // La expresión regular de =~ puede llevar ( ) |: se junta en un solo argumento.
    const a = args.slice(0, -1)
    for (let k = a.indexOf('=~'); k >= 0 && k < a.length; k = a.indexOf('=~', k + 1)) {
      let end = k + 1
      while (end < a.length && a[end] !== '&&' && a[end] !== '||') end++
      a.splice(k + 1, end - k - 1, a.slice(k + 1, end).join(''))
    }
    try {
      return evalTest(sh, a, true) ? 0 : 1
    } catch (e) {
      io.err((e as Error).message + '\n')
      return 2
    }
  },
  '.': (sh, args, io) => BUILTINS.source(sh, args, io),
  source: async (sh, args, io) => {
    if (!args[0]) {
      io.err('bash: source: filename argument required\n')
      return 2
    }
    const path = sh.resolve(args[0])
    try {
      const src = sh.sys.vfs.readFile(path, sh.cred)
      return await sh.exec(parse(src.endsWith('\n') ? src : src + '\n'), io)
    } catch (e) {
      if (e instanceof FsError) {
        io.err(`bash: ${args[0]}: ${e.message}\n`)
        return 1
      }
      throw e
    }
  },
  type: (sh, args, io) => {
    let code = 0
    if (args[0] === '-t') {
      for (const a of args.slice(1)) {
        const kind = sh.aliases.has(a) ? 'alias' : RESERVED_WORDS.has(a) ? 'keyword' : sh.functions.has(a) ? 'function' : BUILTINS[a] ? 'builtin' : COMMANDS.has(a) && sh.sys.isCommandAvailable(a, (c) => commandPackage(sh.sys.distro, c)) ? 'file' : ''
        if (kind) io.out(kind + '\n')
        else code = 1
      }
      return code
    }
    for (const a of args) {
      if (sh.aliases.has(a)) io.out(`${a} is aliased to \`${sh.aliases.get(a)}'\n`)
      else if (BUILTINS[a]) io.out(`${a} is a shell builtin\n`)
      else if (sh.functions.has(a)) io.out(`${a} is a function\n`)
      else if (sh.findInPath(a) && !sh.findInPath(a)!.binary) io.out(`${a} is ${sh.findInPath(a)!.path}\n`)
      else if (COMMANDS.has(a) && sh.sys.isCommandAvailable(a, (c) => commandPackage(sh.sys.distro, c))) {
        io.out(`${a} is ${COMMANDS.get(a)!.path ?? '/usr/bin'}/${a}\n`)
      } else {
        io.err(`bash: type: ${a}: not found\n`)
        code = 1
      }
    }
    return code
  },
  history: (sh, args, io) => {
    if (args[0] === '-c') {
      sh.history.length = 0
      return 0
    }
    const n = args[0] ? Number(args[0]) : sh.history.length
    sh.history.slice(-n).forEach((h, i, arr) => io.out(`${String(sh.history.length - arr.length + i + 1).padStart(5)}  ${h}\n`))
    return 0
  },
  umask: (sh, args, io) => {
    if (!args.length) {
      io.out(sh.umask.toString(8).padStart(4, '0') + '\n')
      return 0
    }
    if (args[0] === '-S') {
      const m = ~sh.umask & 0o777
      const t = (s: number) => (m & (4 << s) ? 'r' : '') + (m & (2 << s) ? 'w' : '') + (m & (1 << s) ? 'x' : '')
      io.out(`u=${t(6)},g=${t(3)},o=${t(0)}\n`)
      return 0
    }
    if (!/^[0-7]{1,4}$/.test(args[0])) {
      io.err(`bash: umask: ${args[0]}: octal number out of range\n`)
      return 1
    }
    sh.umask = parseInt(args[0], 8)
    return 0
  },
  alias: (sh, args, io) => {
    const show = (k: string) => io.out(`alias ${k}='${sh.aliases.get(k)}'\n`)
    if (!args.length || args[0] === '-p') {
      ;[...sh.aliases.keys()].sort().forEach(show)
      return 0
    }
    let code = 0
    for (const a of args) {
      const eq = a.indexOf('=')
      if (eq > 0) sh.aliases.set(a.slice(0, eq), a.slice(eq + 1))
      else if (sh.aliases.has(a)) show(a)
      else {
        io.err(`bash: alias: ${a}: not found\n`)
        code = 1
      }
    }
    return code
  },
  unalias: (sh, args, io) => {
    if (args[0] === '-a') {
      sh.aliases.clear()
      return 0
    }
    let code = 0
    for (const a of args) {
      if (!sh.aliases.delete(a)) {
        io.err(`bash: unalias: ${a}: not found\n`)
        code = 1
      }
    }
    return code
  },
  command: (sh, args, io) => {
    if (args[0] === '-v' || args[0] === '-V') {
      let code = 0
      for (const a of args.slice(1)) {
        if (sh.aliases.has(a)) io.out(args[0] === '-v' ? `alias ${a}='${sh.aliases.get(a)}'\n` : `${a} is aliased to \`${sh.aliases.get(a)}'\n`)
        else if (BUILTINS[a]) io.out(args[0] === '-v' ? `${a}\n` : `${a} is a shell builtin\n`)
        else if (sh.functions.has(a)) io.out(args[0] === '-v' ? `${a}\n` : `${a} is a function\n`)
        else if (sh.findInPath(a) && !sh.findInPath(a)!.binary) io.out(`${sh.findInPath(a)!.path}\n`)
        else if (COMMANDS.has(a) && sh.sys.isCommandAvailable(a, (c) => commandPackage(sh.sys.distro, c))) io.out(`${COMMANDS.get(a)!.path ?? '/usr/bin'}/${a}\n`)
        else code = 1
      }
      return code
    }
    // command nombre args: ejecuta sin buscar alias ni funciones.
    return args.length ? sh.invoke(args, io) : 0
  },
  clear: (sh) => {
    sh.pendingClear = true
    return 0
  },
}

const RESERVED_WORDS = new Set(['if', 'then', 'elif', 'else', 'fi', 'for', 'in', 'do', 'done', 'while', 'until', 'case', 'esac', 'function', '{', '}', '!', '[[', ']]', 'select', 'time'])

/** declare / typeset / readonly: -a -A -i -r -x -p y -f. */
function declareBuiltin(sh: Shell, args: string[], io: IO, name: string): number {
  const flags = args.filter((a) => /^[-+][aAirxpfF]+$/.test(a)).join('')
  const names = args.filter((a) => !/^[-+][aAirxpfF]+$/.test(a))
  if (flags.includes('p') || (!names.length && (flags.includes('r') || flags === '' || flags.includes('x')))) {
    const show = names.length ? names : name === 'readonly' ? [...sh.readonlyVars] : [...new Set([...sh.vars.keys(), ...sh.arrays.keys()])].sort()
    let code = 0
    for (const n of show) {
      const arr = sh.arrays.get(n)
      const opts = `${arr ? (sh.assoc.has(n) ? 'A' : 'a') : ''}${sh.integerVars.has(n) ? 'i' : ''}${sh.readonlyVars.has(n) ? 'r' : ''}${sh.exported.has(n) ? 'x' : ''}` || '-'
      if (arr) io.out(`declare -${opts} ${n}=(${sh.arrayKeys(n).map((k) => `[${k}]="${arr.get(k)}"`).join(' ')})\n`)
      else if (sh.vars.has(n)) io.out(`declare -${opts.replace(/^-$/, '-')} ${n}="${sh.vars.get(n)}"\n`)
      else {
        io.err(`bash: declare: ${n}: not found\n`)
        code = 1
      }
    }
    return code
  }
  if (flags.includes('f')) {
    for (const [fn] of sh.functions) io.out(`declare -f ${fn}\n`)
    return 0
  }
  const plus = args.some((a) => a.startsWith('+'))
  for (const item of names) {
    const [k, ...v] = item.split('=')
    if (sh.readonlyVars.has(k) && v.length) {
      io.err(`bash: ${k}: readonly variable\n`)
      return 1
    }
    if (flags.includes('A')) {
      sh.assoc.add(k)
      if (!sh.arrays.has(k)) sh.arrays.set(k, new Map())
    } else if (flags.includes('a') && !sh.arrays.has(k)) sh.setArray(k, sh.vars.has(k) ? [sh.vars.get(k)!] : [])
    if (flags.includes('i')) {
      if (plus) sh.integerVars.delete(k)
      else sh.integerVars.add(k)
    }
    if (v.length) sh.setVar(k, sh.integerVars.has(k) ? String(evalArith(v.join('='), sh)) : v.join('='))
    if (flags.includes('x')) {
      if (plus) sh.exported.delete(k)
      else sh.exported.add(k)
    }
    if (flags.includes('r')) sh.readonlyVars.add(k)
  }
  return 0
}

/** mapfile -t arreglo < archivo: una línea por elemento. */
function mapfileBuiltin(sh: Shell, args: string[], io: IO): number {
  const strip = args.includes('-t')
  const name = args.filter((a) => !a.startsWith('-')).pop() ?? 'MAPFILE'
  const lines: string[] = []
  let line: string | null
  while ((line = io.stdin.readLine()) !== null) lines.push(strip ? line : line + '\n')
  sh.setArray(name, lines)
  return 0
}
