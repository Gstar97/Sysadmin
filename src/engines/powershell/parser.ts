/**
 * Analizador de un subconjunto de PowerShell: pipelines de cmdlets, parámetros, variables,
 * expresiones con operadores (-eq, -like, -match...), arrays, tablas hash, bloques de script,
 * if/elseif/else, foreach, while y funciones simples.
 */

export type Expr =
  | { k: 'str'; v: string; expand: boolean }
  | { k: 'num'; v: number }
  | { k: 'var'; name: string }
  | { k: 'member'; target: Expr; name: string; call?: Expr[] }
  | { k: 'index'; target: Expr; index: Expr }
  | { k: 'array'; items: Expr[] }
  | { k: 'hash'; entries: { key: string; value: Expr }[] }
  | { k: 'sb'; src: string; body: Stmt[] }
  | { k: 'sub'; body: Stmt[] }
  | { k: 'bin'; op: string; l: Expr; r: Expr }
  | { k: 'un'; op: string; e: Expr }
  | { k: 'bare'; v: string }
  | { k: 'cast'; type: string; e: Expr }
  | { k: 'static'; type: string; member: string; call?: Expr[] }
  | { k: 'range'; from: Expr; to: Expr }

export type Arg = { k: 'param'; name: string; value?: Expr } | { k: 'value'; e: Expr } | { k: 'splat'; name: string }

/** Un parámetro de una función o un script (param(...)). */
export interface ParamSpec {
  name: string
  type?: string
  def?: Expr
  mandatory: boolean
  pipeline: boolean
  validateSet?: string[]
}

/** Redirección al final de un pipeline: > archivo, >> archivo, 2> archivo, 2>&1, *> archivo. */
export interface Redirect {
  stream: 'out' | 'err' | 'all'
  append: boolean
  target?: Expr
  merge?: boolean
}

export type Element = { k: 'cmd'; name: string; args: Arg[]; src: string } | { k: 'expr'; e: Expr }

export type Stmt =
  | { k: 'pipe'; elements: Element[]; src: string; redirects?: Redirect[] }
  | { k: 'assign'; target: Expr; op: '=' | '+=' | '-=' | '*=' | '/='; value: Stmt; cast?: string }
  | { k: 'incr'; target: Expr; delta: 1 | -1 }
  | { k: 'if'; clauses: { cond: Stmt; body: Stmt[] }[]; elseBody?: Stmt[] }
  | { k: 'foreach'; varName: string; coll: Stmt; body: Stmt[] }
  | { k: 'while'; cond: Stmt; body: Stmt[] }
  | { k: 'function'; name: string; params: ParamSpec[]; body: Stmt[]; blocks?: { begin?: Stmt[]; process?: Stmt[]; end?: Stmt[] } }
  | { k: 'param'; params: ParamSpec[] }
  | { k: 'return'; value?: Stmt }
  | { k: 'try'; body: Stmt[]; catches: { types: string[]; body: Stmt[] }[]; fin?: Stmt[] }
  | { k: 'throw'; value?: Stmt }
  | { k: 'switch'; value: Stmt; flags: { wildcard: boolean; regex: boolean; cs: boolean }; cases: { pattern: Expr | 'default'; body: Stmt[] }[] }
  | { k: 'for'; init?: Stmt; cond?: Stmt; step?: Stmt; body: Stmt[] }
  | { k: 'do'; body: Stmt[]; cond: Stmt; until: boolean }
  | { k: 'break' }
  | { k: 'continue' }
  | { k: 'exit'; value?: Stmt }

export class PsIncomplete extends Error {}
export class PsParseError extends Error {}

const COMPARISON = new Set([
  'eq', 'ne', 'gt', 'ge', 'lt', 'le', 'like', 'notlike', 'match', 'notmatch', 'contains', 'notcontains', 'in', 'notin', 'replace', 'split', 'join', 'is', 'isnot',
])
const LOGICAL = new Set(['and', 'or', 'xor'])

function normalizeOp(raw: string): string | null {
  const op = raw.toLowerCase()
  const base = /^[ci](eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin|replace|split)$/.test(op) ? op.slice(1) : op
  return COMPARISON.has(base) || LOGICAL.has(base) || ['f', 'not', 'band', 'bor'].includes(base) ? (op.startsWith('c') && base !== op ? `c${base}` : base) : null
}

export function parsePs(src: string): Stmt[] {
  let pos = 0
  const eof = () => pos >= src.length
  const peek = (n = 0) => src[pos + n] ?? ''
  const skipWs = (newlines = false) => {
    while (!eof()) {
      const c = peek()
      if (c === ' ' || c === '\t' || c === '\r' || (newlines && c === '\n')) pos++
      else if (c === '`' && peek(1) === '\n') pos += 2
      else if (c === '<' && peek(1) === '#') {
        const end = src.indexOf('#>', pos + 2)
        if (end < 0) throw new PsIncomplete()
        pos = end + 2
      } else if (c === '#') {
        while (!eof() && peek() !== '\n') pos++
      } else break
    }
  }
  const expect = (ch: string) => {
    skipWs(true)
    if (eof()) throw new PsIncomplete()
    if (peek() !== ch) throw new PsParseError(`Missing '${ch}'`)
    pos++
  }
  const word = (): string => {
    const m = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(pos))
    return m ? m[0] : ''
  }

  /** Lee desde un '[' hasta su ']' (respetando paréntesis y comillas) y devuelve el texto completo. */
  const readBracket = (): string => {
    const start = pos
    let depth = 0
    let quote = ''
    while (true) {
      if (eof()) throw new PsIncomplete()
      const c = peek()
      if (quote) {
        if (c === quote) quote = ''
      } else if (c === "'" || c === '"') quote = c
      else if (c === '[' || c === '(') depth++
      else if (c === ']' || c === ')') {
        depth--
        if (depth === 0) {
          pos++
          break
        }
      }
      pos++
    }
    return src.slice(start, pos)
  }

  /** Lista de parámetros: [Parameter(Mandatory)][string]$Nombre = 'valor', [switch]$Force */
  function parseParamList(): ParamSpec[] {
    expect('(')
    const out: ParamSpec[] = []
    let cur: ParamSpec = { name: '', mandatory: false, pipeline: false }
    while (true) {
      skipWs(true)
      if (eof()) throw new PsIncomplete()
      const c = peek()
      if (c === ')') {
        pos++
        if (cur.name) out.push(cur)
        break
      }
      if (c === ',') {
        pos++
        if (cur.name) out.push(cur)
        cur = { name: '', mandatory: false, pipeline: false }
        continue
      }
      if (c === '[') {
        const inner = readBracket().slice(1, -1).trim()
        if (/^[A-Za-z0-9_.]+(\[\])?$/.test(inner)) cur.type = inner
        else {
          const attr = (/^([A-Za-z.]+)/.exec(inner)?.[1] ?? '').toLowerCase()
          if (attr === 'parameter') {
            cur.mandatory = /\bMandatory\b(?!\s*=\s*\$false)/i.test(inner)
            cur.pipeline = /\bValueFromPipeline\b(?!ByPropertyName)(?!\s*=\s*\$false)/i.test(inner)
          }
          if (attr === 'validateset') cur.validateSet = [...inner.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2])
        }
        continue
      }
      if (c === '$') {
        pos++
        const n = word()
        if (!n) throw new PsParseError('Missing variable name in parameter list.')
        pos += n.length
        cur.name = n
        skipWs()
        if (peek() === '=' && peek(1) !== '=') {
          pos++
          skipWs(true)
          cur.def = parseUnary()
        }
        continue
      }
      throw new PsParseError(`Unexpected token '${c}' in parameter list.`)
    }
    return out
  }

  function parseStatements(endChar?: string): Stmt[] {
    // Un bloque nuevo ({ } o @( )) dentro de los argumentos de un método vuelve a aceptar comas.
    const saved = inCallArgs
    inCallArgs = 0
    try {
      return parseStatementsInner(endChar)
    } finally {
      inCallArgs = saved
    }
  }

  function parseStatementsInner(endChar?: string): Stmt[] {
    const out: Stmt[] = []
    while (true) {
      skipWs(true)
      while (peek() === ';') {
        pos++
        skipWs(true)
      }
      if (eof()) {
        if (endChar) throw new PsIncomplete()
        break
      }
      if (endChar && peek() === endChar) break
      out.push(parseStatement())
    }
    return out
  }

  function parseBlock(): Stmt[] {
    expect('{')
    const body = parseStatements('}')
    pos++
    return body
  }

  function parseCondition(): Stmt {
    expect('(')
    skipWs(true)
    const st = parseStatement()
    expect(')')
    return st
  }

  function parseStatement(): Stmt {
    skipWs()
    // [CmdletBinding()] antes del param(...) de un script o función: no cambia nada acá.
    const attrLine = /^\[(CmdletBinding|OutputType)\b/i.exec(src.slice(pos))
    if (attrLine) {
      readBracket()
      skipWs(true)
      return parseStatement()
    }
    // Asignación con tipo: [int]$x = 5
    const typed = /^\[([A-Za-z0-9_.]+(\[\])?)\]\s*(?=\$)/.exec(src.slice(pos))
    if (typed) {
      const save = pos
      pos += typed[0].length
      const target = parsePostfix()
      skipWs()
      if (peek() === '=' && peek(1) !== '=') {
        pos++
        skipWs(true)
        return { k: 'assign', target, op: '=', value: parseStatement(), cast: typed[1] }
      }
      pos = save
    }
    const kw = word().toLowerCase()
    const rest = src.slice(pos)
    if (kw === 'param' && /^param\s*\(/i.test(rest)) {
      pos += 5
      skipWs()
      return { k: 'param', params: parseParamList() }
    }
    if (kw === 'try' && /^try\s*\{/i.test(rest)) {
      pos += 3
      const body = parseBlock()
      const catches: { types: string[]; body: Stmt[] }[] = []
      let fin: Stmt[] | undefined
      while (true) {
        const save = pos
        skipWs(true)
        const w = word().toLowerCase()
        if (w === 'catch') {
          pos += 5
          skipWs()
          const types: string[] = []
          while (peek() === '[') {
            const m = /^\[([A-Za-z0-9_.]+)\]/.exec(src.slice(pos))
            if (!m) throw new PsParseError('Unexpected token in catch type.')
            types.push(m[1])
            pos += m[0].length
            skipWs()
            if (peek() === ',') {
              pos++
              skipWs(true)
            }
          }
          catches.push({ types, body: parseBlock() })
        } else if (w === 'finally') {
          pos += 7
          fin = parseBlock()
          break
        } else {
          pos = save
          break
        }
      }
      if (!catches.length && !fin) throw new PsParseError('The Try statement is missing its Catch or Finally block.')
      return { k: 'try', body, catches, fin }
    }
    if (kw === 'throw') {
      pos += 5
      skipWs()
      if (eof() || peek() === '\n' || peek() === ';' || peek() === '}') return { k: 'throw' }
      return { k: 'throw', value: parsePipeline() }
    }
    if (kw === 'switch' && /^switch\s*[-(]/i.test(rest)) {
      pos += 6
      const flags = { wildcard: false, regex: false, cs: false }
      while (true) {
        skipWs()
        const m = /^-(wildcard|regex|exact|casesensitive)\b/i.exec(src.slice(pos))
        if (!m) break
        pos += m[0].length
        const f = m[1].toLowerCase()
        if (f === 'wildcard') flags.wildcard = true
        if (f === 'regex') flags.regex = true
        if (f === 'casesensitive') flags.cs = true
      }
      const value = parseCondition()
      expect('{')
      const cases: { pattern: Expr | 'default'; body: Stmt[] }[] = []
      while (true) {
        skipWs(true)
        while (peek() === ';') {
          pos++
          skipWs(true)
        }
        if (eof()) throw new PsIncomplete()
        if (peek() === '}') {
          pos++
          break
        }
        let pattern: Expr | 'default'
        if (/^default\s*\{/i.test(src.slice(pos))) {
          pos += 7
          pattern = 'default'
        } else pattern = peek() === '{' ? parsePrimary() : parsePostfix()
        cases.push({ pattern, body: parseBlock() })
      }
      return { k: 'switch', value, flags, cases }
    }
    if (kw === 'for' && /^for\s*\(/i.test(rest)) {
      pos += 3
      expect('(')
      skipWs(true)
      const init = peek() === ';' ? undefined : parseStatement()
      expect(';')
      skipWs(true)
      const cond = peek() === ';' ? undefined : parseStatement()
      expect(';')
      skipWs(true)
      const step = peek() === ')' ? undefined : parseStatement()
      expect(')')
      return { k: 'for', init, cond, step, body: parseBlock() }
    }
    if (kw === 'do' && /^do\s*\{/i.test(rest)) {
      pos += 2
      const body = parseBlock()
      skipWs(true)
      const w = word().toLowerCase()
      if (w !== 'while' && w !== 'until') throw new PsParseError("Missing while or until keyword in do loop.")
      pos += w.length
      return { k: 'do', body, cond: parseCondition(), until: w === 'until' }
    }
    if ((kw === 'break' || kw === 'continue') && /^(break|continue)\b/i.test(rest)) {
      pos += kw.length
      return { k: kw }
    }
    if (kw === 'exit' && /^exit\b/i.test(rest)) {
      pos += 4
      skipWs()
      if (eof() || peek() === '\n' || peek() === ';' || peek() === '}') return { k: 'exit' }
      return { k: 'exit', value: parsePipeline() }
    }
    if (kw === 'if') {
      pos += 2
      const clauses = [{ cond: parseCondition(), body: parseBlock() }]
      let elseBody: Stmt[] | undefined
      while (true) {
        const save = pos
        skipWs(true)
        const w = word().toLowerCase()
        if (w === 'elseif') {
          pos += 6
          clauses.push({ cond: parseCondition(), body: parseBlock() })
        } else if (w === 'else') {
          pos += 4
          elseBody = parseBlock()
          break
        } else {
          pos = save
          break
        }
      }
      return { k: 'if', clauses, elseBody }
    }
    if (kw === 'foreach' && /^foreach\s*\(/i.test(src.slice(pos))) {
      pos += 7
      expect('(')
      skipWs()
      if (peek() !== '$') throw new PsParseError('Missing variable name after foreach.')
      pos++
      const varName = word()
      pos += varName.length
      skipWs()
      if (word().toLowerCase() !== 'in') throw new PsParseError("Missing 'in' after variable in foreach loop.")
      pos += 2
      skipWs()
      const coll = parseStatement()
      expect(')')
      return { k: 'foreach', varName, coll, body: parseBlock() }
    }
    if (kw === 'while' && /^while\s*\(/i.test(src.slice(pos))) {
      pos += 5
      return { k: 'while', cond: parseCondition(), body: parseBlock() }
    }
    if ((kw === 'function' || kw === 'filter') && /^(function|filter)\s+[A-Za-z_]/i.test(rest)) {
      pos += kw.length
      skipWs()
      const name = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(pos))![0]
      pos += name.length
      skipWs()
      let params: ParamSpec[] = peek() === '(' ? parseParamList() : []
      let body = parseBlock()
      if (body[0]?.k === 'param') {
        params = body[0].params
        body = body.slice(1)
      }
      // Bloques begin / process / end de una función avanzada.
      const named = (st: Stmt) => (st.k === 'pipe' && st.elements.length === 1 && st.elements[0].k === 'cmd' && /^(begin|process|end)$/i.test(st.elements[0].name) && st.elements[0].args.length === 1 && st.elements[0].args[0].k === 'value' && st.elements[0].args[0].e.k === 'sb' ? st.elements[0] : undefined)
      if (body.length && body.every((st) => named(st))) {
        const blocks: { begin?: Stmt[]; process?: Stmt[]; end?: Stmt[] } = {}
        for (const st of body) {
          const el = named(st)!
          const sb = (el.args[0] as { k: 'value'; e: { k: 'sb'; body: Stmt[] } }).e
          blocks[el.name.toLowerCase() as 'begin'] = sb.body
        }
        return { k: 'function', name, params, body: [], blocks }
      }
      if (kw === 'filter') return { k: 'function', name, params, body: [], blocks: { process: body } }
      return { k: 'function', name, params, body }
    }
    if (kw === 'return') {
      pos += 6
      skipWs()
      if (eof() || peek() === '\n' || peek() === ';' || peek() === '}') return { k: 'return' }
      return { k: 'return', value: parsePipeline() }
    }
    // Asignación: $x = ..., $x.Prop = ..., $x += ..., (Get-Algo).Prop = ...
    if (peek() === '$' || peek() === '(') {
      const paren = peek() === '('
      const save = pos
      try {
        const target = parsePostfix()
        skipWs()
        const assignable = paren ? target.k === 'member' || target.k === 'index' : target.k === 'var' || target.k === 'member' || target.k === 'index'
        const incr = /^(\+\+|--)(?![\w$])/.exec(src.slice(pos))?.[0]
        if (incr && assignable) {
          pos += 2
          return { k: 'incr', target, delta: incr === '++' ? 1 : -1 }
        }
        const op = /^(\+=|-=|\*=|\/=|=(?!=))/.exec(src.slice(pos))?.[0]
        if (op && assignable) {
          pos += op.length
          skipWs(true)
          return { k: 'assign', target, op: op as '=' | '+=' | '-=', value: parseStatement() }
        }
      } catch (e) {
        if (e instanceof PsIncomplete) throw e
      }
      pos = save
    }
    return parsePipeline()
  }

  function parsePipeline(): Stmt {
    const start = pos
    const elements: Element[] = [parseElement()]
    const redirects: Redirect[] = []
    while (true) {
      skipWs()
      if (peek() === '|' && peek(1) !== '|') {
        pos++
        skipWs(true)
        if (eof()) throw new PsIncomplete()
        elements.push(parseElement())
        continue
      }
      const r = /^([*1-6])?(>>?)(&1)?/.exec(src.slice(pos))
      if (r && peek() !== '-') {
        pos += r[0].length
        const stream = r[1] === '2' ? 'err' : r[1] === '*' ? 'all' : 'out'
        if (r[3]) redirects.push({ stream, append: false, merge: true })
        else {
          skipWs()
          redirects.push({ stream, append: r[2] === '>>', target: parseArgPrimary() })
        }
        continue
      }
      break
    }
    return { k: 'pipe', elements, src: src.slice(start, pos).trim(), ...(redirects.length ? { redirects } : {}) }
  }

  function parseElement(): Element {
    skipWs()
    const c = peek()
    const start = pos
    if (c === '&') {
      pos++
      skipWs()
      const nameExpr = parsePrimary()
      const name = nameExpr.k === 'str' || nameExpr.k === 'bare' ? nameExpr.v : ''
      return { k: 'cmd', name, args: parseArgs(), src: src.slice(start, pos) }
    }
    // ? y % son alias de Where-Object y ForEach-Object cuando van al principio de un comando.
    if ((c === '?' || c === '%') && /^[?%](\s|$)/.test(src.slice(pos))) {
      pos++
      return { k: 'cmd', name: c === '?' ? 'Where-Object' : 'ForEach-Object', args: parseArgs(), src: src.slice(start, pos) }
    }
    if (/[A-Za-z]/.test(c) || ((c === '.' || c === '\\') && /[\\/A-Za-z]/.test(peek(1)))) {
      const m = /^[A-Za-z0-9_.\\/:-]+/.exec(src.slice(pos))!
      // "-not" o números no son comandos.
      const name = m[0]
      pos += name.length
      return { k: 'cmd', name, args: parseArgs(), src: src.slice(start, pos) }
    }
    return { k: 'expr', e: parseExpr() }
  }

  function parseArgs(): Arg[] {
    const args: Arg[] = []
    while (true) {
      skipWs()
      const c = peek()
      if (eof() || c === '\n' || c === ';' || c === ')' || c === '}' || (c === '|' && peek(1) !== '|')) break
      if (/^([*1-6])?>/.test(src.slice(pos))) break
      if (c === '@' && /[A-Za-z_]/.test(peek(1))) {
        pos++
        const n = word()
        pos += n.length
        args.push({ k: 'splat', name: n })
        continue
      }
      if (c === '-' && /[A-Za-z]/.test(peek(1))) {
        pos++
        const m = /^[A-Za-z][A-Za-z0-9_]*/.exec(src.slice(pos))!
        pos += m[0].length
        if (peek() === ':') {
          pos++
          args.push({ k: 'param', name: m[0], value: parseArgValue() })
        } else args.push({ k: 'param', name: m[0] })
        continue
      }
      args.push({ k: 'value', e: parseArgValue() })
    }
    return args
  }

  /** Valor en modo argumento: admite listas separadas por comas (a,b,c). */
  function parseArgValue(): Expr {
    const items = [parseArgPrimary()]
    while (peek() === ',') {
      pos++
      skipWs(true)
      items.push(parseArgPrimary())
    }
    return items.length === 1 ? items[0] : { k: 'array', items }
  }

  function parseArgPrimary(): Expr {
    skipWs()
    const c = peek()
    if (c === '$' || c === '"' || c === "'" || c === '(' || c === '@' || c === '{' || c === '[') return parsePostfix()
    if (/[0-9]/.test(c)) {
      const m = /^\d+(\.\d+)?(kb|mb|gb|tb)?(?=[\s,;)|}]|$)/i.exec(src.slice(pos))
      if (m) {
        pos += m[0].length
        return numberLiteral(m[0])
      }
    }
    const m = /^[^\s,;|(){}]+/.exec(src.slice(pos))
    if (!m) throw new PsParseError(`Unexpected token '${c}'`)
    pos += m[0].length
    return { k: 'bare', v: m[0] }
  }

  function numberLiteral(text: string): Expr {
    const m = /^(\d+(?:\.\d+)?)(kb|mb|gb|tb)?$/i.exec(text)!
    const mult = { kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }[(m[2] ?? '').toLowerCase() as 'kb'] ?? 1
    return { k: 'num', v: parseFloat(m[1]) * mult }
  }

  // Expresiones: lógicas < comparación < suma < producto < coma < rango < unario < sufijos
  function parseExpr(): Expr {
    let left = parseComparison()
    while (true) {
      skipWs()
      const m = /^-(and|or|xor)\b/i.exec(src.slice(pos))
      if (!m) break
      pos += m[0].length
      skipWs(true)
      left = { k: 'bin', op: m[1].toLowerCase(), l: left, r: parseComparison() }
    }
    return left
  }

  function parseComparison(): Expr {
    let left = parseAdditive()
    while (true) {
      skipWs()
      const m = /^-([A-Za-z]+)\b/.exec(src.slice(pos))
      const op = m ? normalizeOp(m[1]) : null
      if (!m || !op || LOGICAL.has(op) || op === 'not') break
      pos += m[0].length
      skipWs(true)
      left = { k: 'bin', op, l: left, r: parseAdditive() }
    }
    return left
  }

  function parseAdditive(): Expr {
    let left = parseMultiplicative()
    while (true) {
      skipWs()
      const c = peek()
      if ((c === '+' || c === '-') && peek(1) !== '=' && !(c === '-' && /[A-Za-z]/.test(peek(1)))) {
        pos++
        skipWs(true)
        left = { k: 'bin', op: c, l: left, r: parseMultiplicative() }
      } else break
    }
    return left
  }

  function parseMultiplicative(): Expr {
    let left = parseComma()
    while (true) {
      skipWs()
      const c = peek()
      if ((c === '*' || c === '/' || c === '%') && peek(1) !== '=') {
        pos++
        skipWs(true)
        left = { k: 'bin', op: c, l: left, r: parseComma() }
      } else break
    }
    return left
  }

  /** Dentro de los argumentos de un método la coma separa argumentos, no arma un array. */
  let inCallArgs = 0

  function parseComma(): Expr {
    const items = [parseRange()]
    while (true) {
      skipWs()
      if (peek() !== ',' || inCallArgs > 0) break
      pos++
      skipWs(true)
      items.push(parseRange())
    }
    return items.length === 1 ? items[0] : { k: 'array', items }
  }

  function parseRange(): Expr {
    const from = parseUnary()
    if (peek() === '.' && peek(1) === '.') {
      pos += 2
      return { k: 'range', from, to: parseUnary() }
    }
    return from
  }

  function parseUnary(): Expr {
    skipWs()
    const m = /^-not\b/i.exec(src.slice(pos))
    if (m) {
      pos += m[0].length
      skipWs()
      return { k: 'un', op: 'not', e: parseUnary() }
    }
    if (peek() === '!') {
      pos++
      return { k: 'un', op: 'not', e: parseUnary() }
    }
    if (peek() === '-' && /[0-9$(]/.test(peek(1))) {
      pos++
      return { k: 'un', op: '-', e: parseUnary() }
    }
    return parsePostfix()
  }

  function parseCallArgs(): Expr[] {
    // pos está en '('
    pos++
    const args: Expr[] = []
    skipWs(true)
    if (peek() === ')') {
      pos++
      return args
    }
    while (true) {
      skipWs(true)
      inCallArgs++
      try {
        args.push(parseComparison())
      } finally {
        inCallArgs--
      }
      skipWs(true)
      if (peek() === ',') {
        pos++
        continue
      }
      if (peek() === ')') {
        pos++
        break
      }
      if (eof()) throw new PsIncomplete()
      throw new PsParseError("Missing ')' in method call.")
    }
    return args
  }

  function parsePostfix(): Expr {
    let e = parsePrimary()
    while (true) {
      if (peek() === '.' && /[A-Za-z_]/.test(peek(1))) {
        pos++
        const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(pos))![0]
        pos += name.length
        e = peek() === '(' ? { k: 'member', target: e, name, call: parseCallArgs() } : { k: 'member', target: e, name }
        continue
      }
      if (peek() === '[' && e.k !== 'bare') {
        pos++
        const index = parseExpr()
        expect(']')
        e = { k: 'index', target: e, index }
        continue
      }
      break
    }
    return e
  }

  function readDoubleQuoted(): string {
    pos++
    let out = ''
    while (true) {
      if (eof()) throw new PsIncomplete()
      const c = peek()
      if (c === '"' && peek(1) === '"') {
        out += '`"'
        pos += 2
        continue
      }
      if (c === '"') {
        pos++
        break
      }
      if (c === '`') {
        out += c + peek(1)
        pos += 2
        continue
      }
      if (c === '$' && peek(1) === '(') {
        // copiar la subexpresión completa respetando paréntesis
        let depth = 0
        const start = pos
        pos++
        do {
          if (eof()) throw new PsIncomplete()
          if (peek() === '(') depth++
          if (peek() === ')') depth--
          pos++
        } while (depth > 0)
        out += src.slice(start, pos)
        continue
      }
      out += c
      pos++
    }
    return out
  }

  function parsePrimary(): Expr {
    skipWs()
    const c = peek()
    if (eof()) throw new PsIncomplete()
    if (c === "'") {
      let out = ''
      pos++
      while (true) {
        if (eof()) throw new PsIncomplete()
        if (peek() === "'" && peek(1) === "'") {
          out += "'"
          pos += 2
          continue
        }
        if (peek() === "'") {
          pos++
          break
        }
        out += peek()
        pos++
      }
      return { k: 'str', v: out, expand: false }
    }
    if (c === '"') return { k: 'str', v: readDoubleQuoted(), expand: true }
    if (c === '$') {
      if (peek(1) === '(') {
        pos += 2
        const body = parseStatements(')')
        pos++
        return { k: 'sub', body }
      }
      if (peek(1) === '{') {
        const end = src.indexOf('}', pos)
        if (end < 0) throw new PsIncomplete()
        const name = src.slice(pos + 2, end)
        pos = end + 1
        return { k: 'var', name }
      }
      const m = /^\$((?:env|global|script|using|local):)?([A-Za-z_?][A-Za-z0-9_]*|_|\?)/i.exec(src.slice(pos))
      if (!m) {
        pos++
        return { k: 'str', v: '$', expand: false }
      }
      pos += m[0].length
      return { k: 'var', name: (m[1] ?? '').toLowerCase() + m[2] }
    }
    if (c === '(') {
      pos++
      skipWs(true)
      const saved = inCallArgs
      inCallArgs = 0
      let st: Stmt
      try {
        st = parseStatement()
      } finally {
        inCallArgs = saved
      }
      expect(')')
      if (st.k === 'pipe' && st.elements.length === 1 && st.elements[0].k === 'expr') return st.elements[0].e
      return { k: 'sub', body: [st] }
    }
    if (c === '@' && (peek(1) === '"' || peek(1) === "'") && /^@["'][ \t]*\r?\n/.test(src.slice(pos))) {
      const q = peek(1)
      const startBody = src.indexOf('\n', pos) + 1
      const close = src.indexOf(`\n${q}@`, startBody - 1)
      if (close < 0) throw new PsIncomplete()
      const text = src.slice(startBody, close).replace(/\r$/, '')
      pos = close + 3
      return q === '"' ? { k: 'str', v: text.replace(/"/g, '`"'), expand: true } : { k: 'str', v: text, expand: false }
    }
    if (c === '@' && peek(1) === '(') {
      pos += 2
      const saved = inCallArgs
      inCallArgs = 0
      let body: Stmt[]
      try {
        body = parseStatements(')')
      } finally {
        inCallArgs = saved
      }
      pos++
      return { k: 'array', items: [{ k: 'sub', body }] }
    }
    if (c === '@' && peek(1) === '{') {
      pos += 2
      const entries: { key: string; value: Expr }[] = []
      while (true) {
        skipWs(true)
        while (peek() === ';') {
          pos++
          skipWs(true)
        }
        if (peek() === '}') {
          pos++
          break
        }
        if (eof()) throw new PsIncomplete()
        let key: string
        if (peek() === "'" || peek() === '"') {
          const k = parsePrimary()
          key = k.k === 'str' ? k.v : ''
        } else {
          const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(pos))
          if (!m) throw new PsParseError('Missing key before \'=\' in hash literal.')
          key = m[0]
          pos += key.length
        }
        skipWs()
        if (peek() !== '=') throw new PsParseError("Missing '=' operator after key in hash literal.")
        pos++
        skipWs(true)
        // El valor puede ser una instrucción (if, switch, un comando con tubería), como en PowerShell.
        skipWs()
        if (/^(if|switch|foreach|for|while|try)\b/i.test(src.slice(pos)) || /^[A-Za-z][\w]*-[A-Za-z]/.test(src.slice(pos))) {
          const st = parseStatement()
          entries.push({ key, value: st.k === 'pipe' && st.elements.length === 1 && st.elements[0].k === 'expr' ? st.elements[0].e : { k: 'sub', body: [st] } })
        } else entries.push({ key, value: parseExpr() })
      }
      return { k: 'hash', entries }
    }
    if (c === '{') {
      const start = pos
      const body = parseBlock()
      return { k: 'sb', src: src.slice(start + 1, pos - 1).trim(), body }
    }
    if (c === '[') {
      const m = /^\[([A-Za-z0-9_.]+(\[\])?)\]/.exec(src.slice(pos))
      if (m) {
        pos += m[0].length
        if (peek() === ':' && peek(1) === ':') {
          pos += 2
          const member = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(pos))![0]
          pos += member.length
          return peek() === '(' ? { k: 'static', type: m[1], member, call: parseCallArgs() } : { k: 'static', type: m[1], member }
        }
        skipWs()
        return { k: 'cast', type: m[1], e: parseUnary() }
      }
    }
    if (/[0-9]/.test(c)) {
      const m = /^\d+(\.\d+)?(kb|mb|gb|tb)?/i.exec(src.slice(pos))!
      pos += m[0].length
      return numberLiteral(m[0])
    }
    const m = /^[A-Za-z_][A-Za-z0-9_.\\:-]*/.exec(src.slice(pos))
    if (m) {
      pos += m[0].length
      return { k: 'bare', v: m[0] }
    }
    throw new PsParseError(`Unexpected token '${c}' in expression or statement.`)
  }

  return parseStatements()
}
