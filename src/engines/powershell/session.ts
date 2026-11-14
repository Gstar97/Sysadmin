import type { PsServerState } from './schema'
import type { Lab } from './machine'
import { parsePs, PsIncomplete, PsParseError, type Arg, type Element, type Expr, type ParamSpec, type Redirect, type Stmt } from './parser'
import { formatDefault, getProp, isPsObject, isScriptBlock, propNames, psObject, setProp, toText, typeName, type PsObject, type ScriptBlock } from './values'

export interface OutputChunk {
  text: string
  stream: 'out' | 'err'
}

export class PsError extends Error {
  constructor(
    message: string,
    public category = 'InvalidOperation',
    public errorId = 'InvalidOperation',
    public target = '',
  ) {
    super(message)
  }
}

class ReturnSignal {
  constructor(public value: unknown[]) {}
}
class BreakSignal {}
class ContinueSignal {}
class ExitSignal {
  constructor(public code: number) {}
}
/** Un throw: termina el script (o lo atrapa un try). */
export class ThrowSignal extends Error {
  constructor(public record: PsObject) {
    super(toText(getProp(getProp(record, 'Exception'), 'Message')))
  }
}

/** Tipo de la excepción de un error, como lo muestra PowerShell (para catch [Tipo]). */
function exceptionType(errorId: string): string {
  const first = errorId.split(',')[0]
  if (/Exception$/.test(first)) return first.includes('.') ? first : `System.${first}`
  const map: Record<string, string> = {
    CommandNotFoundException: 'System.Management.Automation.CommandNotFoundException',
    ObjectNotFound: 'Microsoft.PowerShell.Commands.ObjectNotFoundException',
    UnauthorizedAccess: 'System.UnauthorizedAccessException',
    PathNotFound: 'System.Management.Automation.ItemNotFoundException',
    NamedParameterNotFound: 'System.Management.Automation.ParameterBindingException',
    MissingArgument: 'System.Management.Automation.ParameterBindingException',
    AmbiguousParameter: 'System.Management.Automation.ParameterBindingException',
    ParameterArgumentValidationError: 'System.Management.Automation.ParameterBindingValidationException',
  }
  return map[first] ?? 'System.Management.Automation.RuntimeException'
}

export function errorRecord(message: string, category = 'NotSpecified', errorId = 'RuntimeException', target: unknown = null, typeName?: string): PsObject {
  const type = typeName ?? exceptionType(errorId)
  const exception = psObject(type, { Message: message, __toString: message })
  return psObject('System.Management.Automation.ErrorRecord', {
    Exception: exception,
    TargetObject: target,
    CategoryInfo: psObject('System.Management.Automation.ErrorCategoryInfo', { Category: category, Reason: type.split('.').pop(), TargetName: toText(target), __toString: `${category}: (${toText(target)}:String) [], ${type.split('.').pop()}` }),
    FullyQualifiedErrorId: errorId,
    __toString: message,
  })
}

// ---------------------------------------------------------------------------------------
// Sistema de archivos de Windows (sin distinguir mayúsculas)
// ---------------------------------------------------------------------------------------

export interface WinNode {
  name: string
  type: 'file' | 'dir'
  content: string
  mtime: number
  hidden?: boolean
}

export class WinFS {
  nodes = new Map<string, WinNode>()

  key(path: string) {
    return path.toLowerCase().replace(/\\+$/, '') || 'c:'
  }

  normalize(path: string, cwd: string, home: string): string {
    let p = path.replace(/\//g, '\\')
    if (p === '~' || p.startsWith('~\\')) p = home + p.slice(1)
    if (/^[A-Za-z]:\\?/.test(p)) {
      // absoluta
    } else if (p.startsWith('\\')) p = 'C:' + p
    else p = `${cwd}\\${p}`
    const drive = p.slice(0, 2).toUpperCase()
    const parts: string[] = []
    for (const seg of p.slice(2).split('\\')) {
      if (!seg || seg === '.') continue
      if (seg === '..') parts.pop()
      else parts.push(seg)
    }
    // Conservar las mayúsculas originales de los nodos existentes.
    let acc = drive
    for (const seg of parts) {
      const candidate = `${acc}\\${seg}`
      const node = this.nodes.get(this.key(candidate))
      acc = node ? `${acc}\\${node.name}` : candidate
    }
    return acc === drive ? `${drive}\\` : acc
  }

  get(path: string) {
    return this.nodes.get(this.key(path))
  }

  parent(path: string) {
    const i = path.lastIndexOf('\\')
    return i <= 2 ? path.slice(0, 2) + '\\' : path.slice(0, i)
  }

  children(path: string): { path: string; node: WinNode }[] {
    const base = this.key(path)
    const out: { path: string; node: WinNode }[] = []
    for (const [k, node] of this.nodes) {
      const parent = k.slice(0, k.lastIndexOf('\\')) || 'c:'
      if (parent === base && k !== base) out.push({ path: `${path.replace(/\\$/, '')}\\${node.name}`, node })
    }
    return out.sort((a, b) => (a.node.type === b.node.type ? a.node.name.localeCompare(b.node.name) : a.node.type === 'dir' ? -1 : 1))
  }

  mkdirp(path: string) {
    const parts = path.split('\\').filter(Boolean)
    let acc = parts[0]
    for (const seg of parts.slice(1)) {
      acc += '\\' + seg
      if (!this.nodes.has(this.key(acc))) this.nodes.set(this.key(acc), { name: seg, type: 'dir', content: '', mtime: Date.now() })
    }
  }

  write(path: string, content: string, append = false) {
    this.mkdirp(this.parent(path))
    const existing = this.get(path)
    const name = path.slice(path.lastIndexOf('\\') + 1)
    if (existing) {
      existing.content = append ? existing.content + content : content
      existing.mtime = Date.now()
    } else this.nodes.set(this.key(path), { name, type: 'file', content, mtime: Date.now() })
  }

  remove(path: string) {
    const k = this.key(path)
    for (const key of [...this.nodes.keys()]) if (key === k || key.startsWith(k + '\\')) this.nodes.delete(key)
  }
}

// ---------------------------------------------------------------------------------------
// Sesión
// ---------------------------------------------------------------------------------------

export interface CmdletContext {
  name: string
  params: Map<string, unknown>
  positional: unknown[]
  input: unknown[]
  hasInput: boolean
  s: PsSession
  /** Error que no corta el pipeline (como Get-Service con un nombre inexistente). */
  writeError: (message: string, category?: string, target?: string, errorId?: string) => void
  host: (text: string) => void
  /** Texto de error ya formateado (el que llega de una sesión remota). */
  errRaw: (text: string) => void
}

export interface CmdletDef {
  run: (ctx: CmdletContext) => unknown[]
  params?: string[]
  switches?: string[]
  /** Nombres de los parámetros posicionales, en orden. */
  positional?: string[]
  synopsis?: string
  syntax?: string
  module?: string
  displayName?: string
  /** Cambia algo: con -WhatIf muestra qué haría (el texto) y no lo hace. */
  whatIf?: (ctx: CmdletContext) => string
  /** Programa clásico (.exe): recibe todo como texto ("-n", "/all", "-type=srv"), sin parámetros de PowerShell. */
  native?: boolean
}

/** Intervalo de tiempo como System.TimeSpan (lo que da restar dos fechas). */
export function timeSpan(ms: number): PsObject {
  const abs = Math.abs(ms)
  const sign = ms < 0 ? -1 : 1
  const days = Math.floor(abs / 86_400_000)
  const hours = Math.floor((abs % 86_400_000) / 3_600_000)
  const minutes = Math.floor((abs % 3_600_000) / 60_000)
  const seconds = Math.floor((abs % 60_000) / 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return psObject('System.TimeSpan', { Days: sign * days, Hours: sign * hours, Minutes: sign * minutes, Seconds: sign * seconds, Milliseconds: sign * (abs % 1000), Ticks: ms * 10_000, TotalDays: ms / 86_400_000, TotalHours: ms / 3_600_000, TotalMinutes: ms / 60_000, TotalSeconds: ms / 1000, TotalMilliseconds: ms, __toString: `${ms < 0 ? '-' : ''}${days ? `${days}.` : ''}${pad(hours)}:${pad(minutes)}:${pad(seconds)}` })
}

/** Lo que corre cada vez que un equipo arranca (por ejemplo, aplicar las GPO de equipo). */
export const BOOT_HOOKS: ((s: PsSession) => void)[] = []

/** Parámetros comunes que aceptan todos los cmdlets. */
const COMMON_PARAMS = ['ErrorAction', 'ErrorVariable', 'WarningAction', 'WarningVariable', 'OutVariable', 'InformationAction', 'Credential']
const COMMON_SWITCHES = ['Verbose', 'Debug', 'WhatIf', 'Confirm']

export const CMDLETS = new Map<string, CmdletDef>()
export const ALIASES = new Map<string, string>()

export function cmdlet(names: string | string[], def: CmdletDef, aliases: string[] = []) {
  const list = Array.isArray(names) ? names : [names]
  for (const n of list) CMDLETS.set(n.toLowerCase(), { ...def, displayName: n })
  for (const a of aliases) ALIASES.set(a.toLowerCase(), list[0])
}

/** Módulos que siempre están (los del propio PowerShell). */
const CORE_MODULES = ['microsoft.powershell.core', 'microsoft.powershell.management', 'microsoft.powershell.utility', 'microsoft.powershell.security', 'microsoft.powershell.diagnostics', 'microsoft.wsman.management']

export function moduleAvailable(s: PsSession, mod?: string): boolean {
  if (!mod) return true
  const m = mod.toLowerCase()
  if (CORE_MODULES.includes(m)) return true
  const list = s.data.modules as string[] | undefined
  if (!list) return true
  return list.some((x) => x.toLowerCase() === m)
}

/** Nombre oficial de un cmdlet a partir de su nombre o alias (sin distinguir mayúsculas). */
export function canonicalName(name: string): string | undefined {
  const lower = name.toLowerCase()
  const target = (ALIASES.get(lower) ?? lower).toLowerCase()
  return CMDLETS.get(target)?.displayName
}

/** Compara como PowerShell: sin distinguir mayúsculas y convirtiendo números cuando conviene. */
export function psEquals(a: unknown, b: unknown, caseSensitive = false): boolean {
  if (typeof a === 'number') return a === Number(b)
  if (typeof a === 'boolean') return a === (typeof b === 'string' ? b.toLowerCase() === 'true' : !!b)
  if (a === null || a === undefined) return b === null || b === undefined
  const sa = toText(a)
  const sb = toText(b)
  return caseSensitive ? sa === sb : sa.toLowerCase() === sb.toLowerCase()
}

export function wildcardToRegex(pattern: string): RegExp {
  return new RegExp('^' + pattern.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' || typeof b === 'number') return Number(a) - Number(b)
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  return toText(a).toLowerCase().localeCompare(toText(b).toLowerCase())
}

export function asArray(v: unknown): unknown[] {
  if (v === null || v === undefined) return []
  return Array.isArray(v) ? v : [v]
}

export function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0 && (v.length > 1 || truthy(v[0]))
  if (typeof v === 'string') return v.length > 0
  return !!v
}

interface FunctionDef {
  params: ParamSpec[]
  body: Stmt[]
  blocks?: { begin?: Stmt[]; process?: Stmt[]; end?: Stmt[] }
}

export class PsSession {
  /** Alcances de variables: [0] es el global; las funciones y los scripts apilan el suyo. */
  scopes: Map<string, unknown>[] = [new Map()]
  /** Índice del alcance del script que se está ejecutando (para $script:). */
  scriptScope = 0
  /** Variables $using: de un Invoke-Command en curso. */
  usingVars?: Map<string, unknown>
  functions = new Map<string, FunctionDef>()
  errors: PsObject[] = []
  fs = new WinFS()
  cwd: string
  home: string
  history: string[] = []
  lastOutput = ''
  pendingClear = false
  executionPolicy = 'RemoteSigned'
  state: PsServerState
  /** Objetos de la sesión (servicios, procesos, AD...) que usan los cmdlets. */
  data: Record<string, unknown[]> = {}
  /** Los demás equipos de la red. */
  lab?: Lab
  /** Sesión remota abierta con Enter-PSSession: lo que se escribe se ejecuta allá. */
  activeRemote?: PsSession
  /** Esta sesión es remota (la abrió otro equipo): no se puede volver a anidar. */
  isRemote = false
  /** Cambios que se aplican al reiniciar (Rename-Computer, Add-Computer, roles). */
  pending: { name?: string; domain?: string; messages: string[] } = { messages: [] }

  get vars(): Map<string, unknown> {
    return this.scopes[0]
  }

  constructor(state: PsServerState) {
    this.state = state
    this.home = `C:\\Users\\${state.usuario}`
    this.cwd = state.directorio
    this.vars.set('true', true)
    this.vars.set('false', false)
    this.vars.set('null', null)
    this.vars.set('home', this.home)
    this.vars.set('pshome', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0')
    this.vars.set('psversiontable', new Map<string, unknown>([['PSVersion', '5.1.26100.2161'], ['PSEdition', 'Desktop'], ['BuildVersion', '10.0.26100.2161']]))
    this.vars.set('error', this.errors)
    this.vars.set('erroractionpreference', 'Continue')
    this.vars.set('?', true)
    this.vars.set('lastexitcode', 0)
  }

  prompt(): string {
    if (this.activeRemote) return `[${this.activeRemote.state.equipo}]: ${this.activeRemote.prompt()}`
    return `PS ${this.cwd}> `
  }

  resolvePath(p: string) {
    return this.fs.normalize(p, this.cwd, this.home)
  }

  getVar(name: string): unknown {
    if (name.toLowerCase().startsWith('env:')) {
      const env: Record<string, string> = {
        computername: this.state.equipo,
        username: this.state.usuario,
        userdomain: this.state.dominio?.split('.')[0].toUpperCase() ?? this.state.equipo,
        userprofile: this.home,
        windir: 'C:\\Windows',
        systemroot: 'C:\\Windows',
        temp: `${this.home}\\AppData\\Local\\Temp`,
        path: 'C:\\Windows\\system32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\',
        os: 'Windows_NT',
      }
      return env[name.slice(4).toLowerCase()] ?? null
    }
    const lower = name.toLowerCase()
    const m = /^(global|script|using|local):(.+)$/.exec(lower)
    if (m) {
      if (m[1] === 'global') return this.scopes[0].get(m[2]) ?? null
      if (m[1] === 'script') return this.scopes[this.scriptScope].get(m[2]) ?? null
      if (m[1] === 'using') return this.usingVars?.get(m[2]) ?? null
      return this.scopes[this.scopes.length - 1].get(m[2]) ?? null
    }
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const v = this.scopes[i].get(lower)
      if (v !== undefined) return v
    }
    return null
  }

  setVar(name: string, value: unknown) {
    const lower = name.toLowerCase()
    const m = /^(global|script|local):(.+)$/.exec(lower)
    if (m) {
      const scope = m[1] === 'global' ? this.scopes[0] : m[1] === 'script' ? this.scopes[this.scriptScope] : this.scopes[this.scopes.length - 1]
      scope.set(m[2], value)
      return
    }
    this.scopes[this.scopes.length - 1].set(lower, value)
  }

  /** Ejecuta algo en un alcance nuevo (función o script) y lo descarta al terminar. */
  withScope<T>(fn: () => T, script = false): T {
    this.scopes.push(new Map())
    const prevScript = this.scriptScope
    if (script) this.scriptScope = this.scopes.length - 1
    try {
      return fn()
    } finally {
      this.scopes.pop()
      this.scriptScope = prevScript
    }
  }

  /** Registra un error en $Error (el más reciente primero, como PowerShell). */
  recordError(rec: PsObject) {
    this.errors.unshift(rec)
    if (this.errors.length > 256) this.errors.length = 256
  }

  async run(source: string): Promise<{ chunks: OutputChunk[]; incomplete?: boolean }> {
    if (this.activeRemote) {
      // Dentro de Enter-PSSession: exit o Exit-PSSession vuelven; lo demás corre en el otro equipo.
      if (/^\s*(exit|exit-pssession)\s*$/i.test(source)) {
        this.history.push(source)
        this.activeRemote = undefined
        this.lastOutput = ''
        return { chunks: [] }
      }
      const r = await this.activeRemote.run(source)
      if (!r.incomplete && source.trim()) this.history.push(source)
      this.lastOutput = this.activeRemote.lastOutput
      return r
    }
    const chunks: OutputChunk[] = []
    const out = (stream: 'out' | 'err') => (text: string) => {
      if (!text) return
      const last = chunks[chunks.length - 1]
      if (last && last.stream === stream) last.text += text
      else chunks.push({ text, stream })
    }
    let stmts: Stmt[]
    try {
      stmts = parsePs(source)
    } catch (e) {
      if (e instanceof PsIncomplete) return { chunks: [], incomplete: true }
      if (e instanceof PsParseError) {
        out('err')(`At line:1 char:1\n+ ${source}\n+ ~\n${e.message}\n    + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException\n    + FullyQualifiedErrorId : ParseError\n \n`)
        this.lastOutput = e.message
        return { chunks }
      }
      throw e
    }
    if (source.trim()) this.history.push(source)
    for (const st of stmts) {
      try {
        const result = this.execStmt(st, out('err'), out('out'))
        if (result.length) out('out')(this.render(result))
      } catch (e) {
        if (e instanceof PsError) {
          this.recordError(errorRecord(e.message, e.category, e.errorId, e.target))
          out('err')(this.formatError(e, st, stmts.length === 1 ? source.trim() : ''))
        } else if (e instanceof ThrowSignal) out('err')(this.throwText(e, st))
        else if (e instanceof ReturnSignal) out('out')(this.render(e.value))
        else if (e instanceof ExitSignal) break
        else if (e instanceof BreakSignal || e instanceof ContinueSignal) continue
        else out('err')(`Error interno del simulador: ${(e as Error).message}\n`)
      }
    }
    this.lastOutput = chunks.map((c) => c.text).join('')
    return { chunks }
  }

  render(items: unknown[]): string {
    const formatted = items.filter((i) => isPsObject(i) && i.__type === '__formatted') as PsObject[]
    if (formatted.length === items.length) return formatted.map((f) => f.text as string).join('')
    return formatDefault(items.map((i) => (isPsObject(i) && i.__type === '__formatted' ? (i.text as string) : i)))
  }

  /** Texto de un throw que nadie atrapó. */
  throwText(e: ThrowSignal, st: Stmt): string {
    const src = st.k === 'pipe' ? st.src : st.k === 'throw' ? `throw${st.value?.k === 'pipe' ? ` ${st.value.src}` : ''}` : 'throw'
    const id = toText(getProp(e.record, 'FullyQualifiedErrorId'))
    return `${e.message}\nAt line:1 char:1\n+ ${src}\n+ ${'~'.repeat(Math.max(1, src.length))}\n    + CategoryInfo          : OperationStopped: (${e.message}:String) [], RuntimeException\n    + FullyQualifiedErrorId : ${id === 'RuntimeException' ? e.message : id}\n \n`
  }

  formatError(e: PsError, st: Stmt, line = ''): string {
    const src = st.k === 'pipe' ? st.src : line
    const cmd = st.k === 'pipe' && st.elements[0]?.k === 'cmd' ? (canonicalName(st.elements[0].name) ?? st.elements[0].name) : ''
    return this.errorText(e, src, cmd)
  }

  /** Error con el formato de Windows PowerShell 5.1 (mensaje, posición y CategoryInfo). */
  errorText(e: PsError, src: string, cmd: string): string {
    const first = e.errorId.split(',')[0]
    const exception = /Exception$/.test(first) ? first.split(/[.:]/).pop()! : `${first.split(':').pop()}Exception`
    return `${cmd ? `${cmd} : ` : ''}${e.message}\nAt line:1 char:1\n+ ${src}\n+ ${'~'.repeat(Math.max(1, src.length))}\n    + CategoryInfo          : ${e.category}: (${e.target}:String) [${cmd}], ${exception}\n    + FullyQualifiedErrorId : ${e.errorId}\n \n`
  }

  // ---------------------------------------------------------------------------
  // Sentencias
  // ---------------------------------------------------------------------------

  /** Profundidad de try en curso: adentro, un error que corta la sentencia sube hasta el catch. */
  tryDepth = 0

  execBlock(body: Stmt[], err: (s: string) => void, host: (s: string) => void): unknown[] {
    const out: unknown[] = []
    for (const st of body) {
      try {
        out.push(...this.execStmt(st, err, host))
        this.vars.set('?', true)
      } catch (e) {
        if (e instanceof PsError && this.tryDepth === 0) {
          this.recordError(errorRecord(e.message, e.category, e.errorId, e.target))
          this.vars.set('?', false)
          err(this.formatError(e, st))
        } else throw e
      }
    }
    return out
  }

  private loopBody(body: Stmt[], err: (s: string) => void, host: (s: string) => void, out: unknown[]): 'break' | 'continue' | undefined {
    try {
      out.push(...this.execBlock(body, err, host))
    } catch (e) {
      if (e instanceof BreakSignal) return 'break'
      if (e instanceof ContinueSignal) return 'continue'
      throw e
    }
    return undefined
  }

  execStmt(st: Stmt, err: (s: string) => void, host: (s: string) => void): unknown[] {
    switch (st.k) {
      case 'pipe':
        if (st.redirects?.length) return this.execRedirected(st, err, host)
        return this.execPipe(st.elements, err, host)
      case 'assign': {
        const value = this.execStmt(st.value, err, host)
        let v: unknown = value.length === 1 ? value[0] : value
        if (st.op !== '=') {
          const current = this.eval(st.target)
          if (st.op === '+=') v = this.add(current, v)
          else if (st.op === '-=') v = Number(current) - Number(v)
          else if (st.op === '*=') v = Number(current) * Number(v)
          else v = Number(current) / Number(v)
        }
        if (st.cast) v = this.cast(st.cast, v)
        this.assign(st.target, v)
        return []
      }
      case 'incr': {
        this.assign(st.target, Number(this.eval(st.target) ?? 0) + st.delta)
        return []
      }
      case 'param':
        return []
      case 'try':
        return this.execTry(st, err, host)
      case 'throw': {
        const v = st.value ? this.execStmt(st.value, err, host) : []
        const val = v.length === 1 ? v[0] : v.length ? v : 'ScriptHalted'
        const rec = isPsObject(val) && val.__type === 'System.Management.Automation.ErrorRecord' ? val : errorRecord(toText(val), 'OperationStopped', toText(val), val)
        this.recordError(rec)
        throw new ThrowSignal(rec)
      }
      case 'switch':
        return this.execSwitch(st, err, host)
      case 'for': {
        const out: unknown[] = []
        if (st.init) this.execStmt(st.init, err, host)
        let guard = 0
        while (!st.cond || truthy(this.single(this.execStmt(st.cond, err, host)))) {
          if (++guard > 5000) throw new PsError('El bucle superó las 5000 vueltas y se detuvo (simulador).')
          if (this.loopBody(st.body, err, host, out) === 'break') break
          if (st.step) this.execStmt(st.step, err, host)
        }
        return out
      }
      case 'do': {
        const out: unknown[] = []
        let guard = 0
        while (true) {
          if (++guard > 5000) throw new PsError('El bucle superó las 5000 vueltas y se detuvo (simulador).')
          if (this.loopBody(st.body, err, host, out) === 'break') break
          const c = truthy(this.single(this.execStmt(st.cond, err, host)))
          if (st.until ? c : !c) break
        }
        return out
      }
      case 'break':
        throw new BreakSignal()
      case 'continue':
        throw new ContinueSignal()
      case 'exit': {
        const v = st.value ? this.single(this.execStmt(st.value, err, host)) : 0
        this.vars.set('lastexitcode', Number(v) || 0)
        throw new ExitSignal(Number(v) || 0)
      }
      case 'if':
        for (const c of st.clauses) {
          const cond = this.execStmt(c.cond, err, host)
          if (truthy(cond.length === 1 ? cond[0] : cond)) return this.execBlock(c.body, err, host)
        }
        return st.elseBody ? this.execBlock(st.elseBody, err, host) : []
      case 'foreach': {
        const coll = this.execStmt(st.coll, err, host).flatMap((x) => asArray(x))
        const out: unknown[] = []
        for (const item of coll) {
          this.setVar(st.varName, item)
          if (this.loopBody(st.body, err, host, out) === 'break') break
        }
        return out
      }
      case 'while': {
        const out: unknown[] = []
        let guard = 0
        while (truthy(this.execStmt(st.cond, err, host)[0])) {
          if (++guard > 5000) throw new PsError('El bucle superó las 5000 vueltas y se detuvo (simulador).')
          if (this.loopBody(st.body, err, host, out) === 'break') break
        }
        return out
      }
      case 'function':
        this.functions.set(st.name.toLowerCase(), { params: st.params, body: st.body, blocks: st.blocks })
        return []
      case 'return':
        throw new ReturnSignal(st.value ? this.execStmt(st.value, err, host) : [])
    }
  }

  single(v: unknown[]): unknown {
    return v.length === 1 ? v[0] : v
  }

  private execTry(st: Extract<Stmt, { k: 'try' }>, err: (s: string) => void, host: (s: string) => void): unknown[] {
    const out: unknown[] = []
    try {
      this.tryDepth++
      try {
        out.push(...this.execBlock(st.body, err, host))
      } finally {
        this.tryDepth--
      }
    } catch (e) {
      let rec: PsObject | undefined
      if (e instanceof ThrowSignal) rec = e.record
      else if (e instanceof PsError) {
        rec = errorRecord(e.message, e.category, e.errorId, e.target)
        this.recordError(rec)
      }
      if (!rec) {
        if (st.fin) out.push(...this.execBlock(st.fin, err, host))
        throw e
      }
      const type = toText(getProp(rec, 'Exception') && (getProp(rec, 'Exception') as PsObject).__type)
      const short = (t: string) => t.toLowerCase().split('.').pop()!
      const handler = st.catches.find((c) => !c.types.length || c.types.some((t) => ['exception', 'system.exception', 'runtimeexception', 'system.management.automation.runtimeexception'].includes(t.toLowerCase()) || short(t) === short(type)))
      if (!handler) {
        if (st.fin) out.push(...this.execBlock(st.fin, err, host))
        throw e
      }
      const prev = this.getVar('_')
      this.setVar('_', rec)
      this.setVar('PSItem', rec)
      try {
        out.push(...this.execBlock(handler.body, err, host))
      } finally {
        this.setVar('_', prev)
        if (st.fin) out.push(...this.execBlock(st.fin, err, host))
      }
      return out
    }
    if (st.fin) out.push(...this.execBlock(st.fin, err, host))
    return out
  }

  private execSwitch(st: Extract<Stmt, { k: 'switch' }>, err: (s: string) => void, host: (s: string) => void): unknown[] {
    const values = this.execStmt(st.value, err, host).flatMap((x) => asArray(x))
    const out: unknown[] = []
    outer: for (const v of values) {
      let matched = false
      const prev = this.getVar('_')
      this.setVar('_', v)
      try {
        for (const c of st.cases) {
          if (c.pattern === 'default') continue
          let ok: boolean
          if (c.pattern.k === 'sb') ok = truthy(this.single(this.execBlock(c.pattern.body, err, host)))
          else {
            const p = this.eval(c.pattern)
            const text = toText(v)
            if (st.flags.regex) {
              const m = new RegExp(toText(p), st.flags.cs ? '' : 'i').exec(text)
              ok = !!m
              if (m) this.setVar('Matches', new Map(m.map((x, i) => [String(i), x])))
            } else if (st.flags.wildcard) ok = wildcardToRegex(toText(p)).test(text)
            else ok = psEquals(v, p, st.flags.cs)
          }
          if (!ok) continue
          matched = true
          const r = this.loopBody(c.body, err, host, out)
          if (r === 'break') break outer
          if (r === 'continue') continue outer
        }
        if (!matched) {
          const d = st.cases.find((c) => c.pattern === 'default')
          if (d && this.loopBody(d.body, err, host, out) === 'break') break
        }
      } finally {
        this.setVar('_', prev)
      }
    }
    return out
  }

  /** Un pipeline con redirecciones: > archivo, >> archivo, 2> archivo, 2>&1, 2>$null. */
  private execRedirected(st: Extract<Stmt, { k: 'pipe' }>, err: (s: string) => void, host: (s: string) => void): unknown[] {
    const rd = (stream: 'out' | 'err') => st.redirects!.find((r: Redirect) => r.stream === stream || r.stream === 'all')
    const outR = rd('out')
    const errR = rd('err')
    const errText: string[] = []
    const merge = !!errR?.merge
    const errSink = (t: string) => {
      if (merge || errR) errText.push(t)
      else err(t)
    }
    const result = this.execPipe(st.elements, errSink, host)
    const target = (r: Redirect) => (r.target ? this.eval(r.target) : null)
    const toFile = (r: Redirect, text: string) => {
      const t = target(r)
      if (t === null || t === undefined) return // $null: se descarta
      const full = this.resolvePath(toText(t))
      this.fs.write(full, text.replace(/\n/g, '\r\n'), r.append)
    }
    let output = result
    if (merge) output = [...result, ...errText.map((t) => t.trimEnd())]
    else if (errR) toFile(errR, errText.join(''))
    if (outR && !outR.merge) {
      toFile(outR, this.render(output).replace(/^\n/, ''))
      return []
    }
    return output
  }

  private assign(target: Expr, value: unknown) {
    if (target.k === 'var') this.setVar(target.name, value)
    else if (target.k === 'member') setProp(this.eval(target.target), target.name, value)
    else if (target.k === 'index') {
      const obj = this.eval(target.target)
      const idx = this.eval(target.index)
      if (Array.isArray(obj)) obj[Number(idx)] = value
      else setProp(obj, toText(idx), value)
    }
  }

  private add(a: unknown, b: unknown): unknown {
    if (Array.isArray(a)) return [...a, ...asArray(b)]
    if (typeof a === 'number') return a + Number(b)
    if (a instanceof Map && b instanceof Map) return new Map([...a, ...b])
    return toText(a) + toText(b)
  }

  execPipe(elements: Element[], err: (s: string) => void, host: (s: string) => void): unknown[] {
    let input: unknown[] = []
    let hasInput = false
    for (const el of elements) {
      if (el.k === 'expr') {
        const v = this.eval(el.e)
        input = el.e.k === 'array' || Array.isArray(v) ? asArray(v) : v === null || v === undefined ? [] : [v]
        hasInput = true
        continue
      }
      input = this.invoke(el.name, el.args, input, hasInput, err, host, el.src.trim())
      hasInput = true
    }
    return input
  }

  invoke(name: string, args: Arg[], input: unknown[], hasInput: boolean, err: (s: string) => void, host: (s: string) => void, src = name): unknown[] {
    const fn = this.functions.get(name.toLowerCase())
    if (fn) return this.callFunction(name, fn, args, input, hasInput, err, host)
    const canonical = canonicalName(name)
    const found = canonical ? CMDLETS.get(canonical.toLowerCase()) : undefined
    // Un cmdlet de un módulo que no está instalado no existe para este equipo.
    const def = found && moduleAvailable(this, found.module) ? found : undefined
    if (!def) {
      if (/\.ps1$/i.test(name)) return this.runScript(name, err, host, args, input, hasInput)
      throw new PsError(
        `The term '${name}' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling of the name, or if a path was included, verify that the path is correct and try again.`,
        'ObjectNotFound',
        'CommandNotFoundException',
        name,
      )
    }
    const params = new Map<string, unknown>()
    const positional: unknown[] = []
    const switches = [...(def.switches ?? []), ...COMMON_SWITCHES.filter((c) => !(def.switches ?? []).includes(c))]
    const known = [...(def.params ?? []), ...COMMON_PARAMS.filter((c) => !(def.params ?? []).includes(c)), ...switches, 'EA']
    args = this.expandSplats(args)
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (a.k === 'splat') continue
      if (a.k === 'value') {
        positional.push(this.eval(a.e))
        continue
      }
      if (def.native) {
        // "-type=srv" llega partido en "-type" y "=srv": se vuelve a juntar.
        const next = args[i + 1]
        const nextText = !a.value && next?.k === 'value' ? toText(this.eval(next.e)) : undefined
        if (nextText?.startsWith('=')) {
          positional.push(`-${a.name}${nextText}`)
          i++
        } else positional.push(`-${a.name}${a.value ? `:${toText(this.eval(a.value))}` : ''}`)
        continue
      }
      const lower = a.name.toLowerCase()
      const matches = known.filter((k) => k.toLowerCase().startsWith(lower))
      const exact = known.find((k) => k.toLowerCase() === lower)
      const match = exact ?? (matches.length === 1 ? matches[0] : undefined)
      if (!match) {
        if (matches.length > 1) throw new PsError(`Parameter cannot be processed because the parameter name '${a.name}' is ambiguous. Possible matches include: ${matches.map((m) => `-${m}`).join(' ')}.`, 'InvalidArgument', 'AmbiguousParameter')
        throw new PsError(`A parameter cannot be found that matches parameter name '${a.name}'.`, 'InvalidArgument', 'NamedParameterNotFound', '')
      }
      if (switches.includes(match)) {
        params.set(match.toLowerCase(), a.value ? truthy(this.eval(a.value)) : true)
        continue
      }
      if (a.value) params.set(match.toLowerCase(), this.eval(a.value))
      else {
        const next = args[i + 1]
        if (!next || next.k !== 'value') throw new PsError(`Missing an argument for parameter '${match}'. Specify a parameter of type 'System.Object' and try again.`, 'InvalidArgument', 'MissingArgument')
        params.set(match.toLowerCase(), this.eval(next.e))
        i++
      }
    }
    // Asignar posicionales
    const posNames = def.positional ?? []
    positional.forEach((v, i) => {
      const pname = posNames[i]
      if (pname && !params.has(pname.toLowerCase())) params.set(pname.toLowerCase(), v)
    })
    if (params.has('ea')) params.set('erroraction', params.get('ea'))
    const action = toText(params.get('erroraction') ?? this.getVar('ErrorActionPreference') ?? 'Continue').toLowerCase()
    const errVar = params.get('errorvariable')
    const ctxBase = { name: canonical!, params, positional, input, hasInput, s: this, host }
    if (params.get('whatif') && def.whatIf) {
      host(`What if: ${def.whatIf(ctxBase as unknown as CmdletContext)}\n`)
      return []
    }
    const result = def.run({
      name: canonical!,
      params,
      positional,
      input,
      hasInput,
      s: this,
      errRaw: err,
      writeError: (message, category = 'ObjectNotFound', target = '', errorId) => {
        const id = errorId ?? `${category},Microsoft.PowerShell.Commands.${canonical!.replace(/-/g, '')}Command`
        if (action === 'stop') throw new PsError(message, category, id, target)
        const rec = errorRecord(message, category, id, target)
        if (action !== 'ignore') this.recordError(rec)
        if (errVar) this.setVar(toText(errVar).replace(/^\+/, ''), [rec])
        this.vars.set('?', false)
        if (action === 'silentlycontinue' || action === 'ignore') return
        err(this.errorText(new PsError(message, category, id, target), src, canonical!))
      },
      host,
    })
    const outVar = params.get('outvariable')
    if (outVar) this.setVar(toText(outVar), result.length === 1 ? result[0] : result)
    return result
  }

  /** @parametros: una tabla hash se convierte en -Nombre valor; un array, en valores posicionales. */
  expandSplats(args: Arg[]): Arg[] {
    if (!args.some((a) => a.k === 'splat')) return args
    const out: Arg[] = []
    for (const a of args) {
      if (a.k !== 'splat') {
        out.push(a)
        continue
      }
      const v = this.getVar(a.name)
      if (v instanceof Map) for (const [k, val] of v) out.push({ k: 'param', name: String(k), value: { k: 'lit', v: val } as unknown as Expr })
      else for (const x of asArray(v)) out.push({ k: 'value', e: { k: 'lit', v: x } as unknown as Expr })
    }
    return out
  }

  /** Llama a una función: arma su alcance, enlaza los parámetros y corre begin/process/end. */
  callFunction(name: string, fn: FunctionDef, args: Arg[], input: unknown[], hasInput: boolean, err: (s: string) => void, host: (s: string) => void): unknown[] {
    return this.withScope(() => {
      const pipelineParam = this.bindParams(name, fn.params, this.expandSplats(args), hasInput)
      this.setVar('input', input)
      const runBody = (body: Stmt[]) => {
        try {
          return this.execBlock(body, err, host)
        } catch (e) {
          if (e instanceof ReturnSignal) return e.value
          throw e
        }
      }
      if (!fn.blocks) return runBody(fn.body)
      const out: unknown[] = []
      if (fn.blocks.begin) out.push(...runBody(fn.blocks.begin))
      if (fn.blocks.process) {
        const items = hasInput ? input : [null]
        for (const item of items) {
          this.setVar('_', item)
          this.setVar('PSItem', item)
          if (pipelineParam && hasInput) this.setVar(pipelineParam, item)
          out.push(...runBody(fn.blocks.process))
        }
      }
      if (fn.blocks.end) out.push(...runBody(fn.blocks.end))
      return out
    })
  }

  /** Enlaza los argumentos con los parámetros declarados; devuelve el que recibe el pipeline. */
  bindParams(owner: string, specs: ParamSpec[], args: Arg[], hasInput = false): string | undefined {
    const positional: unknown[] = []
    const named = new Map<string, unknown>()
    const bound = new Map<string, unknown>()
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (a.k === 'splat') continue
      if (a.k === 'value') {
        positional.push(this.eval(a.e))
        continue
      }
      const spec = specs.find((p) => p.name.toLowerCase() === a.name.toLowerCase()) ?? (() => {
        const ms = specs.filter((p) => p.name.toLowerCase().startsWith(a.name.toLowerCase()))
        return ms.length === 1 ? ms[0] : undefined
      })()
      if (!spec) {
        if (COMMON_SWITCHES.some((c) => c.toLowerCase() === a.name.toLowerCase()) || COMMON_PARAMS.some((c) => c.toLowerCase() === a.name.toLowerCase())) {
          if (!a.value && args[i + 1]?.k === 'value' && !COMMON_SWITCHES.some((c) => c.toLowerCase() === a.name.toLowerCase())) i++
          continue
        }
        if (!specs.length) {
          // Función sin parámetros declarados: queda en $args.
          positional.push(`-${a.name}`)
          continue
        }
        throw new PsError(`A parameter cannot be found that matches parameter name '${a.name}'.`, 'InvalidArgument', `NamedParameterNotFound,${owner}`)
      }
      if (spec.type?.toLowerCase() === 'switch') named.set(spec.name, a.value ? truthy(this.eval(a.value)) : true)
      else if (a.value) named.set(spec.name, this.eval(a.value))
      else {
        const next = args[i + 1]
        if (!next || next.k !== 'value') throw new PsError(`Missing an argument for parameter '${spec.name}'. Specify a parameter of type '${spec.type ? `System.${spec.type.replace(/^string$/i, 'String').replace(/^int$/i, 'Int32')}` : 'System.Object'}' and try again.`, 'InvalidArgument', `MissingArgument,${owner}`)
        named.set(spec.name, this.eval(next.e))
        i++
      }
    }
    const pipelineParam = specs.find((p) => p.pipeline)?.name
    const rest: unknown[] = []
    let pi = 0
    for (const spec of specs) {
      if (named.has(spec.name)) bound.set(spec.name, named.get(spec.name))
      else if (spec.type?.toLowerCase() !== 'switch' && pi < positional.length) bound.set(spec.name, positional[pi++])
    }
    rest.push(...positional.slice(pi))
    for (const spec of specs) {
      let v: unknown
      if (bound.has(spec.name)) v = bound.get(spec.name)
      else if (spec.type?.toLowerCase() === 'switch') v = false
      else if (spec.def) v = this.eval(spec.def)
      else if (spec.mandatory && !(spec.pipeline && hasInput)) {
        throw new PsError(`Cannot process command because of one or more missing mandatory parameters: ${spec.name}.`, 'InvalidArgument', `MissingMandatoryParameter,${owner}`)
      } else v = null
      if (v !== null && spec.validateSet && !asArray(v).every((x) => spec.validateSet!.some((o) => o.toLowerCase() === toText(x).toLowerCase()))) {
        throw new PsError(`Cannot validate argument on parameter '${spec.name}'. The argument "${toText(v)}" does not belong to the set "${spec.validateSet.join(',')}" specified by the ValidateSet attribute. Supply an argument that is in the set and then try the command again.`, 'InvalidData', `ParameterArgumentValidationError,${owner}`)
      }
      if (v !== null && spec.type && spec.type.toLowerCase() !== 'switch') v = this.cast(spec.type, v)
      this.setVar(spec.name, v)
    }
    this.setVar('args', rest)
    this.setVar('PSBoundParameters', new Map([...bound.entries()]))
    return pipelineParam
  }

  runScript(path: string, err: (s: string) => void, host: (s: string) => void, args: Arg[] = [], input: unknown[] = [], hasInput = false): unknown[] {
    const full = this.resolvePath(path)
    const node = this.fs.get(full)
    if (!node || node.type !== 'file') {
      throw new PsError(`The term '${path}' is not recognized as the name of a cmdlet, function, script file, or operable program.`, 'ObjectNotFound', 'CommandNotFoundException', path)
    }
    if (this.executionPolicy === 'Restricted') {
      throw new PsError(`File ${full} cannot be loaded because running scripts is disabled on this system. For more information, see about_Execution_Policies at https:/go.microsoft.com/fwlink/?LinkID=135170.`, 'SecurityError', 'UnauthorizedAccess', '')
    }
    let stmts: Stmt[]
    try {
      stmts = parsePs(node.content)
    } catch (e) {
      if (e instanceof PsParseError || e instanceof PsIncomplete) throw new PsError(`El script tiene un error de sintaxis: ${e.message}`, 'ParserError', 'ParseException')
      throw e
    }
    return this.withScope(() => {
      const params = stmts[0]?.k === 'param' ? stmts[0].params : []
      this.bindParams(full, params, this.expandSplats(args), hasInput)
      this.setVar('input', input)
      this.setVar('PSScriptRoot', this.fs.parent(full))
      this.setVar('PSCommandPath', full)
      try {
        return this.execBlock(stmts, err, host)
      } catch (e) {
        if (e instanceof ReturnSignal) return e.value
        if (e instanceof ExitSignal) return []
        if (e instanceof ThrowSignal && this.tryDepth === 0) {
          err(`${e.message}\nAt ${full}:1 char:1\n+ throw\n+ ~~~~~\n    + CategoryInfo          : OperationStopped: (${e.message}:String) [], RuntimeException\n    + FullyQualifiedErrorId : ${e.message}\n \n`)
          return []
        }
        throw e
      }
    }, true)
  }

  invokeScriptBlock(sb: ScriptBlock, item: unknown): unknown[] {
    const top = this.scopes[this.scopes.length - 1]
    const prev = top.get('_')
    const prevItem = top.get('psitem')
    this.setVar('_', item)
    this.setVar('PSItem', item)
    try {
      return this.execBlock(sb.body as Stmt[], () => undefined, () => undefined)
    } finally {
      top.set('_', prev)
      top.set('psitem', prevItem)
    }
  }

  // ---------------------------------------------------------------------------
  // Expresiones
  // ---------------------------------------------------------------------------

  expandString(text: string): string {
    let out = ''
    let i = 0
    while (i < text.length) {
      const c = text[i]
      if (c === '`') {
        const n = text[i + 1]
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n === '0' ? '\0' : (n ?? '')
        i += 2
        continue
      }
      if (c === '$' && text[i + 1] === '(') {
        let depth = 0
        let j = i + 1
        do {
          if (text[j] === '(') depth++
          if (text[j] === ')') depth--
          j++
        } while (depth > 0 && j < text.length)
        const inner = text.slice(i + 2, j - 1)
        const v = this.execBlock(parsePs(inner), () => undefined, () => undefined)
        out += v.map(toText).join(' ')
        i = j
        continue
      }
      if (c === '$') {
        const m = /^\$((?:env:)?[A-Za-z_][A-Za-z0-9_]*|_)/i.exec(text.slice(i))
        if (m) {
          out += toText(this.getVar(m[1]))
          i += m[0].length
          continue
        }
      }
      out += c
      i++
    }
    return out
  }

  eval(e: Expr): unknown {
    if ((e as unknown as { k: string }).k === 'lit') return (e as unknown as { v: unknown }).v
    switch (e.k) {
      case 'str':
        return e.expand ? this.expandString(e.v) : e.v
      case 'num':
        return e.v
      case 'bare':
        return e.v
      case 'var':
        return this.getVar(e.name)
      case 'array':
        return e.items.flatMap((i) => {
          const v = this.eval(i)
          return i.k === 'sub' || i.k === 'array' ? asArray(v) : [v]
        })
      case 'sub': {
        const r = this.execBlock(e.body, () => undefined, () => undefined)
        return r.length === 1 ? r[0] : r
      }
      case 'hash':
        return new Map(e.entries.map((en) => [en.key, this.eval(en.value)]))
      case 'sb':
        return { __sb: true, src: e.src, body: e.body } as ScriptBlock
      case 'range': {
        const from = Number(this.eval(e.from))
        const to = Number(this.eval(e.to))
        const out: number[] = []
        for (let i = from; from <= to ? i <= to : i >= to; i += from <= to ? 1 : -1) out.push(i)
        return out
      }
      case 'index': {
        const target = this.eval(e.target)
        const idx = this.eval(e.index)
        if (Array.isArray(target)) {
          const n = Number(idx)
          return target[n < 0 ? target.length + n : n] ?? null
        }
        if (typeof target === 'string') return target[Number(idx)] ?? null
        return getProp(target, toText(idx))
      }
      case 'member': {
        const target = this.eval(e.target)
        if (e.call) return this.callMethod(target, e.name, e.call.map((a) => this.eval(a)))
        return getProp(target, e.name)
      }
      case 'static':
        return this.callStatic(e.type, e.member, e.call?.map((a) => this.eval(a)))
      case 'cast':
        return this.cast(e.type, this.eval(e.e))
      case 'un': {
        const v = this.eval(e.e)
        return e.op === 'not' ? !truthy(v) : -Number(v)
      }
      case 'bin':
        return this.binary(e.op, e.l, e.r)
    }
  }

  private binary(op: string, le: Expr, re: Expr): unknown {
    if (op === 'and') return truthy(this.eval(le)) && truthy(this.eval(re))
    if (op === 'or') return truthy(this.eval(le)) || truthy(this.eval(re))
    if (op === 'xor') return truthy(this.eval(le)) !== truthy(this.eval(re))
    const l = this.eval(le)
    const r = this.eval(re)
    switch (op) {
      case '+':
        return this.add(l, r)
      case '-':
        // Fecha menos fecha da un intervalo (TimeSpan) con Days, Hours, TotalHours…
        if (l instanceof Date && r instanceof Date) return timeSpan(l.getTime() - r.getTime())
        if (l instanceof Date) return new Date(l.getTime() - Number(r))
        return Number(l) - Number(r)
      case '*':
        return typeof l === 'string' ? l.repeat(Number(r)) : Number(l) * Number(r)
      case '/':
        return Number(l) / Number(r)
      case '%':
        return Number(l) % Number(r)
      case 'join':
        return asArray(l).map(toText).join(toText(r))
      case 'split':
        return toText(l).split(new RegExp(toText(r), 'i'))
      case 'replace': {
        const [pat, rep] = Array.isArray(r) ? r : [r, '']
        return toText(l).replace(new RegExp(toText(pat), 'gi'), toText(rep).replace(/\$(\d)/g, '$$$1'))
      }
      case 'contains':
      case 'notcontains': {
        const has = asArray(l).some((x) => psEquals(x, r))
        return op === 'contains' ? has : !has
      }
      case 'in':
      case 'notin': {
        const has = asArray(r).some((x) => psEquals(l, x))
        return op === 'in' ? has : !has
      }
      case 'f':
        return formatOperator(toText(l), asArray(r))
      case 'is':
      case 'isnot': {
        const want = toText(r).replace(/^\[|\]$/g, '').toLowerCase()
        const t = typeName(l).toLowerCase()
        const short: Record<string, string[]> = { string: ['system.string'], int: ['system.int32'], int32: ['system.int32'], double: ['system.double', 'system.int32'], bool: ['system.boolean'], array: ['system.object[]'], hashtable: ['system.collections.hashtable'], datetime: ['system.datetime'], pscustomobject: ['system.management.automation.pscustomobject'] }
        const ok = (short[want] ?? [want, `system.${want}`]).includes(t) || t.endsWith(`.${want}`)
        return op === 'is' ? ok : !ok
      }
      case 'as':
        try {
          return this.cast(toText(r).replace(/^\[|\]$/g, ''), l)
        } catch {
          return null
        }
    }
    // Operadores de comparación: con un array a la izquierda, filtran.
    const test = (x: unknown): boolean => {
      switch (op.replace(/^c/, '')) {
        case 'eq':
          return psEquals(x, r, op.startsWith('c'))
        case 'ne':
          return !psEquals(x, r, op.startsWith('c'))
        case 'gt':
          return compare(x, r) > 0
        case 'ge':
          return compare(x, r) >= 0
        case 'lt':
          return compare(x, r) < 0
        case 'le':
          return compare(x, r) <= 0
        case 'like':
          return wildcardToRegex(toText(r)).test(toText(x))
        case 'notlike':
          return !wildcardToRegex(toText(r)).test(toText(x))
        case 'match': {
          const m = new RegExp(toText(r), op.startsWith('c') ? '' : 'i').exec(toText(x))
          if (m) this.setVar('Matches', new Map(m.map((v, i) => [String(i), v])))
          return !!m
        }
        case 'notmatch':
          return !new RegExp(toText(r), 'i').test(toText(x))
      }
      throw new PsError(`Unexpected operator '-${op}'.`, 'ParserError', 'UnexpectedToken')
    }
    if (Array.isArray(l)) return l.filter(test)
    return test(l)
  }

  private cast(type: string, v: unknown): unknown {
    const t = type.toLowerCase()
    if (t === 'int' || t === 'int32' || t === 'int64' || t === 'long') return Math.round(Number(v))
    if (t === 'double' || t === 'decimal') return Number(v)
    if (t === 'string') return toText(v)
    if (t === 'bool') return truthy(v)
    if (t === 'datetime') return new Date(toText(v))
    if (t === 'array' || t.endsWith('[]')) return asArray(v)
    if ((t === 'pscustomobject' || t === 'psobject') && v instanceof Map) return psObject('System.Management.Automation.PSCustomObject', Object.fromEntries(v))
    if (t === 'void') return null
    if (t === 'ordered' || t === 'hashtable') return v
    if (t === 'version') return toText(v)
    if (t === 'ipaddress') {
      const text = toText(v)
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(text) || text.split('.').some((o) => Number(o) > 255)) throw new PsError(`Cannot convert value "${text}" to type "System.Net.IPAddress". Error: "An invalid IP address was specified."`, 'InvalidArgument', 'InvalidCastParseTargetInvocation')
      return text
    }
    if (t === 'int' || t === 'int32') return v
    return v
  }

  private callStatic(type: string, member: string, args?: unknown[]): unknown {
    const t = type.toLowerCase()
    const m = member.toLowerCase()
    if (t === 'string' || t === 'system.string') {
      const a = args ?? []
      if (m === 'join') return asArray(a[1]).concat(a.slice(2)).map((x) => toText(x)).join(toText(a[0]))
      if (m === 'isnullorempty') return a[0] === null || a[0] === undefined || toText(a[0]) === ''
      if (m === 'isnullorwhitespace') return a[0] === null || a[0] === undefined || toText(a[0]).trim() === ''
      if (m === 'empty') return ''
    }
    if (t === 'math') {
      const a = (args ?? []).map(Number)
      if (m === 'round') return a[1] !== undefined ? Number(a[0].toFixed(a[1])) : Math.round(a[0])
      if (m === 'floor') return Math.floor(a[0])
      if (m === 'ceiling') return Math.ceil(a[0])
      if (m === 'max') return Math.max(...a)
      if (m === 'min') return Math.min(...a)
      if (m === 'pow') return a[0] ** a[1]
      if (m === 'sqrt') return Math.sqrt(a[0])
      if (m === 'pi') return Math.PI
    }
    if (t === 'datetime' && m === 'now') return new Date()
    if (t === 'environment' && m === 'machinename') return this.state.equipo
    if (t === 'string' && m === 'isnullorempty') return !args?.[0]
    throw new PsError(`Method invocation failed because [${type}] does not contain a method named '${member}'.`, 'InvalidOperation', 'MethodNotFound')
  }

  private callMethod(target: unknown, name: string, args: unknown[]): unknown {
    const m = name.toLowerCase()
    if (typeof target === 'string') {
      switch (m) {
        case 'toupper':
          return target.toUpperCase()
        case 'tolower':
          return target.toLowerCase()
        case 'trim':
          return target.trim()
        case 'trimend':
          return target.trimEnd()
        case 'trimstart':
          return target.trimStart()
        case 'split':
          return target.split(toText(args[0] ?? ' '))
        case 'replace':
          return target.split(toText(args[0])).join(toText(args[1]))
        case 'contains':
          return target.includes(toText(args[0]))
        case 'startswith':
          return target.toLowerCase().startsWith(toText(args[0]).toLowerCase())
        case 'endswith':
          return target.toLowerCase().endsWith(toText(args[0]).toLowerCase())
        case 'substring':
          return target.substr(Number(args[0]), args[1] !== undefined ? Number(args[1]) : undefined)
        case 'indexof':
          return target.indexOf(toText(args[0]))
        case 'padleft':
          return target.padStart(Number(args[0]), toText(args[1] ?? ' '))
        case 'padright':
          return target.padEnd(Number(args[0]), toText(args[1] ?? ' '))
        case 'tostring':
          return target
      }
    }
    if (m === 'tostring') {
      if (target instanceof Date && args[0]) return formatDotnetDate(target, toText(args[0]))
      return toText(target)
    }
    if (m === 'gettype') {
      const full = target === null ? 'null' : target instanceof Date ? 'System.DateTime' : typeof target === 'string' ? 'System.String' : typeof target === 'boolean' ? 'System.Boolean' : typeof target === 'number' ? (Number.isInteger(target) ? 'System.Int32' : 'System.Double') : Array.isArray(target) ? 'System.Object[]' : target instanceof Map ? 'System.Collections.Hashtable' : isPsObject(target) ? target.__type.replace(/^Deserialized\./, '') : 'System.Object'
      const short = full.split('.').pop()!
      return psObject('System.RuntimeType', { IsPublic: true, IsSerial: true, Name: short, BaseType: full === 'System.Object' ? null : 'System.Object', FullName: full, __toString: full })
    }
    if (target instanceof Date) {
      if (m === 'addmonths') {
        const d = new Date(target)
        d.setMonth(d.getMonth() + Number(args[0]))
        return d
      }
      if (m === 'addyears') {
        const d = new Date(target)
        d.setFullYear(d.getFullYear() + Number(args[0]))
        return d
      }
      if (m === 'addseconds') return new Date(target.getTime() + Number(args[0]) * 1000)
    }
    if (target instanceof Date) {
      if (m === 'adddays') return new Date(target.getTime() + Number(args[0]) * 86_400_000)
      if (m === 'addhours') return new Date(target.getTime() + Number(args[0]) * 3_600_000)
      if (m === 'addminutes') return new Date(target.getTime() + Number(args[0]) * 60_000)
    }
    if (Array.isArray(target)) {
      if (m === 'contains') return target.some((x) => psEquals(x, args[0]))
      if (m === 'add') {
        target.push(args[0])
        return null
      }
    }
    if (target instanceof Map) {
      if (m === 'add') {
        target.set(toText(args[0]), args[1])
        return null
      }
      if (m === 'containskey') return [...target.keys()].some((k) => psEquals(k, args[0]))
      if (m === 'remove') {
        target.delete(toText(args[0]))
        return null
      }
    }
    if (isPsObject(target) && typeof target[`__method_${m}`] === 'function') {
      return (target[`__method_${m}`] as (...a: unknown[]) => unknown)(...args)
    }
    throw new PsError(`Method invocation failed because [${target === null ? 'null' : isPsObject(target) ? target.__type : typeof target}] does not contain a method named '${name}'.`, 'InvalidOperation', 'MethodNotFound')
  }

  /** Valor de una "propiedad" para Select-Object, Sort-Object, etc.: nombre o hashtable calculada. */
  propertyValue(item: unknown, prop: unknown): unknown {
    if (isScriptBlock(prop)) return this.invokeScriptBlock(prop, item)[0] ?? null
    if (prop instanceof Map) {
      const expr = getProp(prop, 'Expression') ?? getProp(prop, 'E')
      return isScriptBlock(expr) ? this.invokeScriptBlock(expr, item)[0] ?? null : getProp(item, toText(expr))
    }
    return getProp(item, toText(prop))
  }

  propertyLabel(prop: unknown): string {
    if (prop instanceof Map) return toText(getProp(prop, 'Name') ?? getProp(prop, 'Label') ?? getProp(prop, 'N') ?? getProp(prop, 'L'))
    return toText(prop)
  }

  allProps(item: unknown): string[] {
    return propNames(item)
  }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Formato de fecha al estilo .NET (yyyy, MM, M, dd, d, HH, hh, h, mm, ss, tt, MMM, dddd). */
export function formatDotnetDate(d: Date, fmt: string): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const h12 = d.getHours() % 12 || 12
  const map: Record<string, string> = {
    yyyy: String(d.getFullYear()),
    yy: pad(d.getFullYear() % 100),
    MMMM: MONTHS[d.getMonth()],
    MMM: MONTHS[d.getMonth()].slice(0, 3),
    MM: pad(d.getMonth() + 1),
    M: String(d.getMonth() + 1),
    dddd: DAYS[d.getDay()],
    ddd: DAYS[d.getDay()].slice(0, 3),
    dd: pad(d.getDate()),
    d: String(d.getDate()),
    HH: pad(d.getHours()),
    H: String(d.getHours()),
    hh: pad(h12),
    h: String(h12),
    mm: pad(d.getMinutes()),
    ss: pad(d.getSeconds()),
    tt: d.getHours() < 12 ? 'AM' : 'PM',
  }
  return fmt.replace(/yyyy|yy|MMMM|MMM|MM|M|dddd|ddd|dd|d|HH|H|hh|h|mm|ss|tt/g, (t) => map[t])
}


/** El operador -f: "{0} tiene {1:N1} GB" -f $nombre, $tamano (con ancho y formatos de .NET). */
export function formatOperator(fmt: string, args: unknown[]): string {
  return fmt.replace(/\{\{|\}\}|\{(\d+)(?:,(-?\d+))?(?::([^}]*))?\}/g, (m, idx, width, spec) => {
    if (m === '{{') return '{'
    if (m === '}}') return '}'
    const v = args[Number(idx)]
    let text: string
    if (spec && typeof v === 'number') {
      const kind = spec[0].toUpperCase()
      const digits = spec.length > 1 ? Number(spec.slice(1)) : undefined
      if (kind === 'N') text = v.toLocaleString('en-US', { minimumFractionDigits: digits ?? 2, maximumFractionDigits: digits ?? 2 })
      else if (kind === 'F') text = v.toFixed(digits ?? 2)
      else if (kind === 'P') text = (v * 100).toFixed(digits ?? 2) + ' %'
      else if (kind === 'D') text = String(Math.trunc(v)).padStart(digits ?? 0, '0')
      else if (kind === 'X') text = Math.trunc(v).toString(16).toUpperCase().padStart(digits ?? 0, '0')
      else if (/^0+(\.0+)?$/.test(spec)) {
        const dec = spec.includes('.') ? spec.split('.')[1].length : 0
        text = v.toFixed(dec).padStart(spec.length, '0')
      } else if (/^#+(\.#+)?$/.test(spec) || /^[#0,]+(\.[#0]+)?$/.test(spec)) text = v.toFixed(spec.includes('.') ? spec.split('.')[1].length : 0)
      else text = toText(v)
    } else if (spec && v instanceof Date) text = formatDotnetDate(v, spec)
    else text = toText(v)
    if (width) {
      const w = Number(width)
      text = w < 0 ? text.padEnd(-w) : text.padStart(w)
    }
    return text
  })
}
