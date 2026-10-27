import type { PsState } from './schema'
import { parsePs, PsIncomplete, PsParseError, type Arg, type Element, type Expr, type Stmt } from './parser'
import { formatDefault, getProp, isPsObject, isScriptBlock, propNames, psObject, setProp, toText, type PsObject, type ScriptBlock } from './values'

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
}

export const CMDLETS = new Map<string, CmdletDef>()
export const ALIASES = new Map<string, string>()

export function cmdlet(names: string | string[], def: CmdletDef, aliases: string[] = []) {
  const list = Array.isArray(names) ? names : [names]
  for (const n of list) CMDLETS.set(n.toLowerCase(), { ...def, displayName: n })
  for (const a of aliases) ALIASES.set(a.toLowerCase(), list[0])
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

export class PsSession {
  vars = new Map<string, unknown>()
  functions = new Map<string, { params: string[]; body: Stmt[] }>()
  fs = new WinFS()
  cwd: string
  home: string
  history: string[] = []
  lastOutput = ''
  pendingClear = false
  executionPolicy = 'RemoteSigned'
  state: PsState
  /** Objetos de la sesión (servicios, procesos, AD...) que usan los cmdlets. */
  data: Record<string, unknown[]> = {}

  constructor(state: PsState) {
    this.state = state
    this.home = `C:\\Users\\${state.usuario}`
    this.cwd = state.directorio
    this.vars.set('true', true)
    this.vars.set('false', false)
    this.vars.set('null', null)
    this.vars.set('home', this.home)
    this.vars.set('pshome', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0')
    this.vars.set('psversiontable', new Map<string, unknown>([['PSVersion', '5.1.26100.2161'], ['PSEdition', 'Desktop'], ['BuildVersion', '10.0.26100.2161']]))
  }

  prompt() {
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
    const v = this.vars.get(name.toLowerCase())
    return v === undefined ? null : v
  }

  setVar(name: string, value: unknown) {
    this.vars.set(name.toLowerCase(), value)
  }

  async run(source: string): Promise<{ chunks: OutputChunk[]; incomplete?: boolean }> {
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
        if (e instanceof PsError) out('err')(this.formatError(e, st))
        else if (e instanceof ReturnSignal) out('out')(this.render(e.value))
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

  formatError(e: PsError, st: Stmt): string {
    const src = st.k === 'pipe' ? st.src : ''
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

  execBlock(body: Stmt[], err: (s: string) => void, host: (s: string) => void): unknown[] {
    const out: unknown[] = []
    for (const st of body) {
      try {
        out.push(...this.execStmt(st, err, host))
      } catch (e) {
        if (e instanceof PsError) err(this.formatError(e, st))
        else throw e
      }
    }
    return out
  }

  execStmt(st: Stmt, err: (s: string) => void, host: (s: string) => void): unknown[] {
    switch (st.k) {
      case 'pipe':
        return this.execPipe(st.elements, err, host)
      case 'assign': {
        const value = this.execStmt(st.value, err, host)
        let v: unknown = value.length === 1 ? value[0] : value
        if (st.op !== '=') {
          const current = this.eval(st.target)
          if (st.op === '+=') v = this.add(current, v)
          else v = Number(current) - Number(v)
        }
        this.assign(st.target, v)
        return []
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
          out.push(...this.execBlock(st.body, err, host))
        }
        return out
      }
      case 'while': {
        const out: unknown[] = []
        let guard = 0
        while (truthy(this.execStmt(st.cond, err, host)[0])) {
          if (++guard > 5000) throw new PsError('El bucle superó las 5000 vueltas y se detuvo (simulador).')
          out.push(...this.execBlock(st.body, err, host))
        }
        return out
      }
      case 'function':
        this.functions.set(st.name.toLowerCase(), { params: st.params, body: st.body })
        return []
      case 'return':
        throw new ReturnSignal(st.value ? this.execStmt(st.value, err, host) : [])
    }
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
    if (fn) {
      // Parámetros: primero los posicionales, después los nombrados (-Nombre valor).
      for (const p of fn.params) this.setVar(p, null)
      const positional: unknown[] = []
      const named: [string, unknown][] = []
      for (let i = 0; i < args.length; i++) {
        const a = args[i]
        if (a.k === 'value') positional.push(this.eval(a.e))
        else if (a.value) named.push([a.name, this.eval(a.value)])
        else if (args[i + 1]?.k === 'value') named.push([a.name, this.eval((args[++i] as { e: Expr }).e)])
        else named.push([a.name, true])
      }
      fn.params.forEach((p, i) => positional[i] !== undefined && this.setVar(p, positional[i]))
      for (const [k, v] of named) this.setVar(k, v)
      this.setVar('input', input)
      try {
        return this.execBlock(fn.body, err, host)
      } catch (e) {
        if (e instanceof ReturnSignal) return e.value
        throw e
      }
    }
    const canonical = canonicalName(name)
    const def = canonical ? CMDLETS.get(canonical.toLowerCase()) : undefined
    if (!def) {
      if (/\.ps1$/i.test(name)) return this.runScript(name, err, host)
      throw new PsError(
        `The term '${name}' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling of the name, or if a path was included, verify that the path is correct and try again.`,
        'ObjectNotFound',
        'CommandNotFoundException',
        name,
      )
    }
    const params = new Map<string, unknown>()
    const positional: unknown[] = []
    const known = [...(def.params ?? []), ...(def.switches ?? [])]
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (a.k === 'value') {
        positional.push(this.eval(a.e))
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
      if (def.switches?.includes(match)) {
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
    return def.run({
      name: canonical!,
      params,
      positional,
      input,
      hasInput,
      s: this,
      writeError: (message, category = 'ObjectNotFound', target = '', errorId) =>
        err(this.errorText(new PsError(message, category, errorId ?? `${category},Microsoft.PowerShell.Commands.${canonical!.replace(/-/g, '')}Command`, target), src, canonical!)),
      host,
    })
  }

  runScript(path: string, err: (s: string) => void, host: (s: string) => void): unknown[] {
    const full = this.resolvePath(path)
    const node = this.fs.get(full)
    if (!node || node.type !== 'file') {
      throw new PsError(`The term '${path}' is not recognized as the name of a cmdlet, function, script file, or operable program.`, 'ObjectNotFound', 'CommandNotFoundException', path)
    }
    if (this.executionPolicy === 'Restricted') {
      throw new PsError(`File ${full} cannot be loaded because running scripts is disabled on this system. For more information, see about_Execution_Policies at https:/go.microsoft.com/fwlink/?LinkID=135170.`, 'SecurityError', 'UnauthorizedAccess', '')
    }
    try {
      return this.execBlock(parsePs(node.content), err, host)
    } catch (e) {
      if (e instanceof ReturnSignal) return e.value
      if (e instanceof PsParseError || e instanceof PsIncomplete) throw new PsError(`El script tiene un error de sintaxis: ${e.message}`, 'ParserError', 'ParseException')
      throw e
    }
  }

  invokeScriptBlock(sb: ScriptBlock, item: unknown): unknown[] {
    const prev = this.vars.get('_')
    this.setVar('_', item)
    this.setVar('PSItem', item)
    try {
      return this.execBlock(sb.body as Stmt[], () => undefined, () => undefined)
    } finally {
      this.vars.set('_', prev)
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
      case 'is':
      case 'isnot':
        return true
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
    if (t === 'pscustomobject' && v instanceof Map) return psObject('System.Management.Automation.PSCustomObject', Object.fromEntries(v))
    return v
  }

  private callStatic(type: string, member: string, args?: unknown[]): unknown {
    const t = type.toLowerCase()
    const m = member.toLowerCase()
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
