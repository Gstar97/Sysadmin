import { commandPackage } from './packages'
import { IncompleteInput, parse, ShellSyntaxError, type Node, type Redir, type Word } from './parser'
import { System } from './system'
import { FsError, normalizePath, type Cred } from './vfs'

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
  sys: System
  private userStack: string[]
  private cwdStack: string[]
  vars = new Map<string, string>()
  exported = new Set<string>()
  positional: string[] = []
  scriptName = '-bash'
  functions = new Map<string, Node>()
  history: string[] = []
  lastExit = 0
  options = { errexit: false, nounset: false, pipefail: false }
  umask = 0o022
  pendingEditor?: EditorRequest
  pendingClear = false
  /** Salida completa (stdout + stderr) de la última línea ejecutada. */
  lastOutput = ''
  private localsStack: Map<string, string | undefined>[] = []
  private conditionDepth = 0

  constructor(sys: System, user: string, cwd?: string) {
    this.sys = sys
    this.userStack = [user]
    const home = sys.users.get(user)?.home ?? '/root'
    this.cwdStack = [cwd ? normalizePath(cwd) : home]
    this.umask = user === 'root' ? 0o022 : 0o002
    this.resetEnv()
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
    this.userStack.push(user)
    this.cwdStack.push(login ? home : this.cwd)
    this.umask = user === 'root' ? 0o022 : 0o002
    this.resetEnv()
  }

  popUser(): boolean {
    if (this.userStack.length <= 1) return false
    this.userStack.pop()
    this.cwdStack.pop()
    this.umask = this.user === 'root' ? 0o022 : 0o002
    this.resetEnv()
    return true
  }

  /** Ejecuta una acción como otro usuario (sudo comando). */
  async asUser<T>(user: string, fn: () => Promise<T>): Promise<T> {
    this.userStack.push(user)
    this.cwdStack.push(this.cwd)
    try {
      return await fn()
    } finally {
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
        if (!this.popUser()) push('out')('logout\n')
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
          const items = node.items ? (await Promise.all(node.items.map((w) => this.expandWord(w)))).flat() : [...this.positional]
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
    return { cwd: this.cwd, vars: new Map(this.vars), exported: new Set(this.exported), positional: [...this.positional], options: { ...this.options }, umask: this.umask }
  }

  private restoreState(s: ReturnType<Shell['saveState']>) {
    this.cwd = s.cwd
    this.vars = s.vars
    this.exported = s.exported
    this.positional = s.positional
    this.options = s.options
    this.umask = s.umask
  }

  private async execPipeline(cmds: Node[], negate: boolean, io: IO): Promise<number> {
    let input = io.stdin
    let code = 0
    const codes: number[] = []
    for (let i = 0; i < cmds.length; i++) {
      const last = i === cmds.length - 1
      let buffer = ''
      const out = last ? io.out : (s: string) => (buffer += s)
      code = await this.exec(cmds[i], { stdin: input, out, err: io.err, isTTY: last && io.isTTY })
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
      if (!append || !this.sys.vfs.exists(path, this.cred)) this.sys.vfs.writeFile(path, '', this.cred, { mode: 0o666 & ~this.umask })
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

  private async execSimple(node: Extract<Node, { kind: 'simple' }>, io: IO): Promise<number> {
    const isTest = node.words[0]?.parts.length === 1 && node.words[0].parts[0].t === 'lit' && node.words[0].parts[0].v === '[['
    let argv: string[]
    try {
      argv = []
      for (const w of node.words) argv.push(...(await this.expandWord(w, isTest ? { split: false, glob: false } : {})))
    } catch (e) {
      if (e instanceof ExpansionError) {
        io.err(e.message + '\n')
        if (this.scriptName !== '-bash') throw new ExitSignal(1)
        return 1
      }
      throw e
    }

    if (argv.length === 0) {
      for (const a of node.assigns) this.setVar(a.name, (await this.expandWord(a.value, { split: false, glob: false })).join(' '))
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
    try {
      const prepared = await this.prepareRedirs(node.redirs, io)
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
      try {
        return await this.exec(fn, io)
      } catch (e) {
        if (e instanceof ReturnSignal) return e.code
        throw e
      } finally {
        const locals = this.localsStack.pop()!
        for (const [k, v] of locals) {
          if (v === undefined) this.vars.delete(k)
          else this.vars.set(k, v)
        }
        this.positional = savedPos
      }
    }

    if (name.includes('/')) {
      const path = this.resolve(name)
      const base = path.slice(path.lastIndexOf('/') + 1)
      if (/^\/(usr\/)?s?bin\//.test(path) && COMMANDS.has(base)) return this.runCommand(base, args, io)
      return this.runScript(path, name, args, io, true)
    }

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
    const saved = this.saveState()
    const savedName = this.scriptName
    const savedFns = new Map(this.functions)
    this.positional = args
    this.scriptName = shown
    this.options = { errexit: false, nounset: false, pipefail: false }
    try {
      return await this.exec(node, io)
    } catch (e) {
      if (e instanceof ExitSignal) return e.code
      if (e instanceof ReturnSignal) return e.code
      throw e
    } finally {
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
    }
    if (/^\d+$/.test(name)) return this.positional[Number(name) - 1]
    return this.vars.get(name)
  }

  setVar(name: string, value: string) {
    this.vars.set(name, value)
  }

  declareLocal(name: string, value?: string) {
    const scope = this.localsStack[this.localsStack.length - 1]
    if (!scope) return false
    if (!scope.has(name)) scope.set(name, this.vars.get(name))
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
    // "$@" entre comillas: un argumento por parámetro.
    if (word.parts.length === 1 && word.parts[0].t === 'var' && word.parts[0].name === '@' && word.parts[0].q) {
      return [...this.positional]
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
      const pieces = s.split(/[ \t\n]+/)
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
        appendExpansion(this.expandVar(part), part.q)
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
      }
      result.push(f.text)
    }
    return result
  }

  private async expandArithText(expr: string): Promise<string> {
    let out = expr
    for (const m of [...expr.matchAll(/\$\(([^)]*)\)/g)]) {
      out = out.replace(m[0], (await this.captureCommand(m[1])).trim())
    }
    return out.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*|[0-9#?])\}?/g, (_, n) => this.getVar(n) ?? '0')
  }

  private expandVar(part: Extract<Word['parts'][number], { t: 'var' }>): string {
    const value = this.getVar(part.name)
    if (part.op === '#') return String((value ?? '').length)
    switch (part.op) {
      case ':-':
        return value ? value : (part.arg ?? '')
      case '-':
        return value !== undefined ? value : (part.arg ?? '')
      case ':=':
        if (!value) {
          this.setVar(part.name, part.arg ?? '')
          return part.arg ?? ''
        }
        return value
      case ':+':
        return value ? (part.arg ?? '') : ''
      case ':?':
        if (!value) throw new ExpansionError(`bash: ${part.name}: ${part.arg || 'parameter null or not set'}`)
        return value
    }
    if (value === undefined && this.options.nounset && !/^[?$#@*0]$/.test(part.name)) {
      throw new ExpansionError(`bash: ${part.name}: unbound variable`)
    }
    return value ?? ''
  }

  async captureCommand(src: string): Promise<string> {
    let out = ''
    const saved = this.saveState()
    try {
      const node = parse(src)
      await this.exec(node, { stdin: new Stdin(), out: (s) => (out += s), err: () => undefined, isTTY: false })
    } catch (e) {
      if (!(e instanceof ExitSignal)) {
        // errores de sintaxis dentro de $( ) se ignoran
      }
    } finally {
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
          if (n.startsWith('.') && !seg.startsWith('.')) continue
          if (re.test(n)) next.push(base === '' ? n : base === '/' ? `/${n}` : `${base}/${n}`)
        }
      }
      bases = next
    }
    return bases.filter((b) => b !== '' && b !== '/').sort((a, b) => a.localeCompare(b, 'en'))
  }
}

export class ExpansionError extends Error {}

// ---------------------------------------------------------------------------------------
// Aritmética $(( ))
// ---------------------------------------------------------------------------------------

/** Número de bash: decimal, octal (017), hexadecimal (0x1F) o en cualquier base (2#1010, 16#ff). */
function parseBashNumber(t: string): number {
  const bad = () => new ExpansionError(`bash: ${t}: value too great for base (error token is "${t}")`)
  if (/^0[xX]/.test(t)) {
    if (!/^0[xX][0-9a-fA-F]+$/.test(t)) throw bad()
    return parseInt(t.slice(2), 16)
  }
  const m = /^(\d+)#([0-9a-zA-Z@_]+)$/.exec(t)
  if (m) {
    const base = Number(m[1])
    if (base < 2 || base > 64) throw new ExpansionError(`bash: ${t}: invalid arithmetic base (error token is "${t}")`)
    const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ@_'
    let v = 0
    for (const ch of m[2]) {
      const d = base <= 36 ? alphabet.indexOf(ch.toLowerCase()) : alphabet.indexOf(ch)
      if (d < 0 || d >= base) throw bad()
      v = v * base + d
    }
    return v
  }
  if (/^0\d+$/.test(t)) {
    if (/[89]/.test(t)) throw bad()
    return parseInt(t, 8)
  }
  return parseInt(t, 10)
}

/** Aritmética de bash ($(( )) y let), con la misma precedencia de operadores que bash. */
export function evalArith(expr: string, sh?: Shell): number {
  const tokens = expr.match(/0[xX][0-9a-zA-Z]+|\d+#[0-9a-zA-Z@_]+|\d+|[A-Za-z_][A-Za-z0-9_]*|\*\*|<<|>>|<=|>=|==|!=|&&|\|\||[-+*/%()<>!~&|^]/g) ?? []
  let pos = 0
  const peek = () => tokens[pos]
  const next = () => tokens[pos++]
  const primary = (): number => {
    const t = next()
    if (t === undefined) return 0
    if (t === '(') {
      const v = or()
      next()
      return v
    }
    if (t === '-') return -primary()
    if (t === '+') return primary()
    if (t === '!') return primary() ? 0 : 1
    if (t === '~') return ~primary()
    if (/^\d/.test(t)) return parseBashNumber(t)
    const v = sh?.getVar(t)
    if (!v) return 0
    return /^\s*-?\d/.test(v) ? (/^-?(0[xX]|\d+#|0\d)/.test(v.trim()) ? parseBashNumber(v.trim()) : parseInt(v, 10) || 0) : 0
  }
  const power = (): number => {
    const base = primary()
    if (peek() === '**') {
      next()
      return base ** power()
    }
    return base
  }
  const binary = (sub: () => number, ops: string[], apply: (op: string, a: number, b: number) => number) => (): number => {
    let v = sub()
    while (ops.includes(peek())) {
      const op = next()
      v = apply(op, v, sub())
    }
    return v
  }
  const mul = binary(power, ['*', '/', '%'], (op, a, b) => {
    if ((op === '/' || op === '%') && b === 0) throw new ExpansionError('bash: division by 0 (error token is "0")')
    return op === '*' ? a * b : op === '/' ? Math.trunc(a / b) : a % b
  })
  const add = binary(mul, ['+', '-'], (op, a, b) => (op === '+' ? a + b : a - b))
  const shift = binary(add, ['<<', '>>'], (op, a, b) => (op === '<<' ? a << b : a >> b))
  const rel = binary(shift, ['<', '>', '<=', '>='], (op, a, b) => Number(op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : a >= b))
  const eq = binary(rel, ['==', '!='], (op, a, b) => Number(op === '==' ? a === b : a !== b))
  const band = binary(eq, ['&'], (_, a, b) => a & b)
  const bxor = binary(band, ['^'], (_, a, b) => a ^ b)
  const bor = binary(bxor, ['|'], (_, a, b) => a | b)
  const and = binary(bor, ['&&'], (_, a, b) => Number(!!a && !!b))
  const or: () => number = binary(and, ['||'], (_, a, b) => Number(!!a || !!b))
  return or()
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
            if (m) sh.vars.set('BASH_REMATCH', m[0])
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

export const BUILTINS: Record<string, Builtin> = {
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
  unset: (sh, args) => {
    for (const a of args.filter((x) => !x.startsWith('-'))) {
      sh.vars.delete(a)
      sh.exported.delete(a)
      sh.functions.delete(a)
    }
    return 0
  },
  local: (sh, args, io) => {
    for (const a of args) {
      const [k, ...v] = a.split('=')
      if (!sh.declareLocal(k, v.length ? v.join('=') : undefined)) {
        io.err('bash: local: can only be used in a function\n')
        return 1
      }
    }
    return 0
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
        continue
      }
      if (/^[-+][euxo]+$/.test(a)) {
        if (a.includes('e')) sh.options.errexit = on
        if (a.includes('u')) sh.options.nounset = on
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
    const names: string[] = []
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-r') raw = true
      else if (args[i] === '-p') io.err(args[++i] ?? '')
      else if (args[i] === '-s') continue
      else names.push(args[i])
    }
    let line = io.stdin.readLine()
    if (line === null) return 1
    if (!raw) line = line.replace(/\\(.)/g, '$1')
    const vars = names.length ? names : ['REPLY']
    const ifs = sh.vars.get('IFS')
    const parts = ifs !== undefined && ifs !== ' \t\n' ? line.split(new RegExp(`[${ifs.replace(/[\]\\^-]/g, '\\$&')}]`)) : line.trim().split(/\s+/)
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
    try {
      return evalTest(sh, args.slice(0, -1), true) ? 0 : 1
    } catch (e) {
      io.err((e as Error).message + '\n')
      return 2
    }
  },
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
    for (const a of args) {
      if (BUILTINS[a]) io.out(`${a} is a shell builtin\n`)
      else if (sh.functions.has(a)) io.out(`${a} is a function\n`)
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
  alias: () => 0,
  clear: (sh) => {
    sh.pendingClear = true
    return 0
  },
}
