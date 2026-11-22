/**
 * Un subconjunto amplio de PromQL, escrito de cero sobre las series de tsdb.ts: selectores con
 * matchers, rangos y subconsultas, offset, funciones (rate, increase, irate, delta, deriv,
 * predict_linear, *_over_time, histogram_quantile, label_replace, absent...), agregaciones con
 * by/without, operadores aritméticos, comparaciones (con filtro o bool), and/or/unless y
 * coincidencia de vectores con on/ignoring y group_left/group_right. La semántica sigue a
 * Prometheus 3: ventana de 5 minutos para los valores instantáneos, rangos abiertos a la
 * izquierda y la misma extrapolación en rate e increase.
 */
import { formatDuration, parseDuration, type Labels, type Sample, type Series, type Tsdb } from './tsdb'

export class PromQLError extends Error {}

const LOOKBACK = 300

// ---------------------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------------------

type TokKind = 'num' | 'dur' | 'str' | 'ident' | 'op' | 'eof'
interface Tok {
  k: TokKind
  v: string
  pos: number
}

const OPS = ['==', '!=', '=~', '!~', '>=', '<=', '(', ')', '{', '}', '[', ']', ',', ':', '=', '>', '<', '+', '-', '*', '/', '%', '^', '@']

function lex(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  let brackets = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '[') brackets++
    if (c === ']') brackets = Math.max(0, brackets - 1)
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    const start = i
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const dur = /^(\d+(ms|s|m|h|d|w|y))+/.exec(src.slice(i))
      if (dur && !/^[0-9]*\.?[0-9]+e/i.test(src.slice(i, i + dur[0].length + 1))) {
        out.push({ k: 'dur', v: dur[0], pos: start })
        i += dur[0].length
        continue
      }
      const num = /^(0x[0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/.exec(src.slice(i))!
      out.push({ k: 'num', v: num[0], pos: start })
      i += num[0].length
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      let s = ''
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && c !== '`') {
          const n = src[j + 1]
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n
          j += 2
        } else s += src[j++]
      }
      if (j >= src.length) throw new PromQLError(`1:${start + 1}: parse error: unterminated quoted string ${c}`)
      out.push({ k: 'str', v: s, pos: start })
      i = j + 1
      continue
    }
    if (/[a-zA-Z_]/.test(c) || (c === ':' && brackets === 0)) {
      const m = /^[a-zA-Z_:][a-zA-Z0-9_:.]*/.exec(src.slice(i))!
      out.push({ k: 'ident', v: m[0], pos: start })
      i += m[0].length
      continue
    }
    const op = OPS.find((o) => src.startsWith(o, i))
    if (!op) throw new PromQLError(`1:${i + 1}: parse error: unexpected character: '${c}'`)
    out.push({ k: 'op', v: op, pos: start })
    i += op.length
  }
  out.push({ k: 'eof', v: '', pos: src.length })
  return out
}

// ---------------------------------------------------------------------------------------
// AST y parser
// ---------------------------------------------------------------------------------------

export interface Matcher {
  name: string
  op: '=' | '!=' | '=~' | '!~'
  value: string
  re?: RegExp
}

export type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'sel'; name?: string; matchers: Matcher[]; range?: number; offset: number }
  | { k: 'sub'; expr: Node; range: number; step?: number; offset: number }
  | { k: 'call'; fn: string; args: Node[] }
  | { k: 'agg'; op: string; param?: Node; expr: Node; by?: string[]; without?: string[] }
  | { k: 'bin'; op: string; l: Node; r: Node; bool: boolean; on?: string[]; ignoring?: string[]; group?: 'left' | 'right'; include: string[] }
  | { k: 'neg'; expr: Node }
  | { k: 'paren'; expr: Node }

type VType = 'scalar' | 'vector' | 'matrix' | 'string'

const AGGS = new Set(['sum', 'avg', 'min', 'max', 'count', 'stddev', 'stdvar', 'group', 'topk', 'bottomk', 'quantile', 'count_values', 'limitk'])
const PREC: Record<string, number> = { or: 1, and: 2, unless: 2, '==': 3, '!=': 3, '>': 3, '<': 3, '>=': 3, '<=': 3, '+': 4, '-': 4, '*': 5, '/': 5, '%': 5, atan2: 5, '^': 6 }
const COMPARISON = new Set(['==', '!=', '>', '<', '>=', '<='])
const SETOPS = new Set(['and', 'or', 'unless'])

/** Tipos de argumento de cada función (el último puede repetirse con "...") y lo que devuelve. */
const FUNCS: Record<string, { args: (VType | 'opt-scalar' | 'opt-vector')[]; ret: VType; variadic?: boolean }> = {
  abs: { args: ['vector'], ret: 'vector' },
  absent: { args: ['vector'], ret: 'vector' },
  absent_over_time: { args: ['matrix'], ret: 'vector' },
  avg_over_time: { args: ['matrix'], ret: 'vector' },
  ceil: { args: ['vector'], ret: 'vector' },
  changes: { args: ['matrix'], ret: 'vector' },
  clamp: { args: ['vector', 'scalar', 'scalar'], ret: 'vector' },
  clamp_max: { args: ['vector', 'scalar'], ret: 'vector' },
  clamp_min: { args: ['vector', 'scalar'], ret: 'vector' },
  count_over_time: { args: ['matrix'], ret: 'vector' },
  day_of_week: { args: ['opt-vector'], ret: 'vector' },
  hour: { args: ['opt-vector'], ret: 'vector' },
  delta: { args: ['matrix'], ret: 'vector' },
  deriv: { args: ['matrix'], ret: 'vector' },
  exp: { args: ['vector'], ret: 'vector' },
  floor: { args: ['vector'], ret: 'vector' },
  histogram_quantile: { args: ['scalar', 'vector'], ret: 'vector' },
  idelta: { args: ['matrix'], ret: 'vector' },
  increase: { args: ['matrix'], ret: 'vector' },
  irate: { args: ['matrix'], ret: 'vector' },
  label_join: { args: ['vector', 'string', 'string', 'string'], ret: 'vector', variadic: true },
  label_replace: { args: ['vector', 'string', 'string', 'string', 'string'], ret: 'vector' },
  last_over_time: { args: ['matrix'], ret: 'vector' },
  ln: { args: ['vector'], ret: 'vector' },
  log10: { args: ['vector'], ret: 'vector' },
  log2: { args: ['vector'], ret: 'vector' },
  max_over_time: { args: ['matrix'], ret: 'vector' },
  min_over_time: { args: ['matrix'], ret: 'vector' },
  predict_linear: { args: ['matrix', 'scalar'], ret: 'vector' },
  present_over_time: { args: ['matrix'], ret: 'vector' },
  quantile_over_time: { args: ['scalar', 'matrix'], ret: 'vector' },
  rate: { args: ['matrix'], ret: 'vector' },
  resets: { args: ['matrix'], ret: 'vector' },
  round: { args: ['vector', 'opt-scalar'], ret: 'vector' },
  scalar: { args: ['vector'], ret: 'scalar' },
  sgn: { args: ['vector'], ret: 'vector' },
  sort: { args: ['vector'], ret: 'vector' },
  sort_desc: { args: ['vector'], ret: 'vector' },
  sqrt: { args: ['vector'], ret: 'vector' },
  stddev_over_time: { args: ['matrix'], ret: 'vector' },
  sum_over_time: { args: ['matrix'], ret: 'vector' },
  time: { args: [], ret: 'scalar' },
  timestamp: { args: ['vector'], ret: 'vector' },
  vector: { args: ['scalar'], ret: 'vector' },
}

const TYPE_NAME: Record<VType, string> = { scalar: 'scalar', vector: 'instant vector', matrix: 'range vector', string: 'string' }

function pos(src: string, p: number): string {
  const before = src.slice(0, p).split('\n')
  return `${before.length}:${before.at(-1)!.length + 1}`
}

class Parser {
  i = 0
  constructor(
    private t: Tok[],
    private src: string,
  ) {}

  peek(n = 0) {
    return this.t[this.i + n]
  }
  next() {
    return this.t[this.i++]
  }
  err(msg: string, tok = this.peek()): never {
    throw new PromQLError(`${pos(this.src, tok.pos)}: parse error: ${msg}`)
  }
  unexpected(ctx?: string): never {
    const tk = this.peek()
    const what = tk.k === 'eof' ? 'end of input' : tk.k === 'str' ? `string "${tk.v}"` : tk.k === 'num' ? `number "${tk.v}"` : tk.k === 'dur' ? `duration "${tk.v}"` : tk.k === 'ident' ? `identifier "${tk.v}"` : `"${tk.v}"`
    this.err(`unexpected ${what}${ctx ? ` ${ctx}` : ''}`)
  }
  is(v: string) {
    const tk = this.peek()
    return (tk.k === 'op' || tk.k === 'ident') && tk.v === v
  }
  expect(v: string, ctx?: string) {
    if (!this.is(v)) this.unexpected(ctx ?? `, expected "${v}"`)
    return this.next()
  }

  parse(): Node {
    if (this.peek().k === 'eof') this.err('no expression found in input')
    const n = this.binary(0)
    if (this.peek().k !== 'eof') this.unexpected()
    return n
  }

  binOp(): string | undefined {
    const tk = this.peek()
    if (tk.k === 'op' && tk.v in PREC) return tk.v
    if (tk.k === 'ident' && ['and', 'or', 'unless', 'atan2'].includes(tk.v)) return tk.v
    return undefined
  }

  labelList(): string[] {
    this.expect('(')
    const out: string[] = []
    while (!this.is(')')) {
      const tk = this.next()
      if (tk.k !== 'ident') {
        this.i--
        this.unexpected('in grouping opts, expected label')
      }
      out.push(tk.v)
      if (!this.is(')')) this.expect(',', 'in grouping opts, expected "," or ")"')
    }
    this.next()
    return out
  }

  binary(min: number): Node {
    let left = this.unary()
    for (;;) {
      const op = this.binOp()
      if (!op || PREC[op] < min || op === '^') break
      this.next()
      const n: Extract<Node, { k: 'bin' }> = { k: 'bin', op, l: left, r: left, bool: false, include: [] }
      if (this.is('bool')) {
        this.next()
        if (!COMPARISON.has(op)) this.err('bool modifier can only be used on comparison operators')
        n.bool = true
      }
      if (this.is('on') || this.is('ignoring')) {
        const which = this.next().v
        n[which as 'on' | 'ignoring'] = this.labelList()
        if (this.is('group_left') || this.is('group_right')) {
          n.group = this.next().v === 'group_left' ? 'left' : 'right'
          if (this.is('(')) n.include = this.labelList()
        }
      }
      n.r = this.binary(PREC[op] + 1)
      left = n
    }
    return left
  }

  unary(): Node {
    if (this.is('-') || this.is('+')) {
      const neg = this.next().v === '-'
      const e = this.unary()
      if (e.k === 'num') return neg ? { k: 'num', v: -e.v } : e
      return neg ? { k: 'neg', expr: e } : e
    }
    return this.power()
  }

  power(): Node {
    const base = this.postfix(this.primary())
    if (this.is('^')) {
      this.next()
      return { k: 'bin', op: '^', l: base, r: this.unary(), bool: false, include: [] }
    }
    return base
  }

  duration(): number {
    const tk = this.next()
    if (tk.k === 'dur') return parseDuration(tk.v)!
    if (tk.k === 'num' && tk.v === '0') return 0
    this.i--
    this.unexpected('in duration, expected a duration like 5m')
  }

  postfix(n: Node): Node {
    for (;;) {
      if (this.is('[')) {
        const open = this.next()
        const range = this.duration()
        if (this.is(':')) {
          this.next()
          const step = this.is(']') ? undefined : this.duration()
          this.expect(']')
          if (n.k === 'sel' && n.range !== undefined) this.err('subquery is only allowed on instant vector, got range vector', open)
          n = { k: 'sub', expr: n, range, step, offset: 0 }
          continue
        }
        this.expect(']', 'in subquery or range selector, expected "]"')
        if (n.k !== 'sel' || n.range !== undefined || n.offset) this.err(`ranges only allowed for vector selectors`, open)
        n = { ...n, range }
        continue
      }
      if (this.is('offset')) {
        this.next()
        const neg = this.is('-')
        if (neg) this.next()
        const d = this.duration() * (neg ? -1 : 1)
        if (n.k === 'sel' || n.k === 'sub') n = { ...n, offset: d }
        else this.err('offset modifier must be preceded by an instant vector selector or range vector selector or a subquery')
        continue
      }
      return n
    }
  }

  matchers(): Matcher[] {
    this.expect('{')
    const out: Matcher[] = []
    while (!this.is('}')) {
      const name = this.next()
      if (name.k !== 'ident' && name.k !== 'str') {
        this.i--
        this.unexpected('in label matching, expected label')
      }
      const op = this.next()
      if (op.k !== 'op' || !['=', '!=', '=~', '!~'].includes(op.v)) {
        this.i--
        this.unexpected('in label matching, expected one of "=", "!=", "=~" or "!~"')
      }
      const val = this.next()
      if (val.k !== 'str') {
        this.i--
        this.unexpected('in label matching, expected string')
      }
      const m: Matcher = { name: name.v, op: op.v as Matcher['op'], value: val.v }
      if (m.op === '=~' || m.op === '!~') {
        try {
          m.re = new RegExp(`^(?:${val.v})$`)
        } catch {
          this.err(`invalid regular expression in label matcher: ${val.v}`, val)
        }
      }
      out.push(m)
      if (!this.is('}')) this.expect(',', 'in label matching, expected "," or "}"')
    }
    this.next()
    return out
  }

  primary(): Node {
    const tk = this.peek()
    if (tk.k === 'num') {
      this.next()
      return { k: 'num', v: Number(tk.v) }
    }
    if (tk.k === 'dur') this.unexpected()
    if (tk.k === 'str') {
      this.next()
      return { k: 'str', v: tk.v }
    }
    if (this.is('(')) {
      this.next()
      const e = this.binary(0)
      this.expect(')', 'in paren expression, expected ")"')
      return { k: 'paren', expr: e }
    }
    if (this.is('{')) {
      const ms = this.matchers()
      if (!ms.some((m) => !(m.op === '=' && m.value === '') && !(m.re && m.re.test('') && m.op === '=~'))) this.err('vector selector must contain at least one non-empty matcher', tk)
      return { k: 'sel', matchers: ms, offset: 0 }
    }
    if (tk.k === 'ident') {
      const name = tk.v
      const low = name.toLowerCase()
      if (low === 'inf' || low === 'nan') {
        this.next()
        return { k: 'num', v: low === 'inf' ? Infinity : NaN }
      }
      if (AGGS.has(name) && (this.peek(1).v === '(' || this.peek(1).v === 'by' || this.peek(1).v === 'without')) return this.aggregation()
      if (this.peek(1).k === 'op' && this.peek(1).v === '(') {
        if (!FUNCS[name]) this.err(`unknown function with name "${name}"`)
        this.next()
        this.next()
        const args: Node[] = []
        while (!this.is(')')) {
          args.push(this.binary(0))
          if (!this.is(')')) this.expect(',', 'in function call, expected "," or ")"')
        }
        this.next()
        return { k: 'call', fn: name, args }
      }
      if (['by', 'without', 'on', 'ignoring', 'bool', 'offset', 'and', 'or', 'unless', 'group_left', 'group_right'].includes(name)) this.unexpected()
      this.next()
      const ms = this.is('{') ? this.matchers() : []
      return { k: 'sel', name, matchers: ms, offset: 0 }
    }
    this.unexpected()
  }

  aggregation(): Node {
    const op = this.next().v
    let by: string[] | undefined
    let without: string[] | undefined
    const grouping = () => {
      if (this.is('by')) {
        this.next()
        by = this.labelList()
      } else if (this.is('without')) {
        this.next()
        without = this.labelList()
      }
    }
    grouping()
    this.expect('(')
    let param: Node | undefined
    if (['topk', 'bottomk', 'quantile', 'count_values', 'limitk'].includes(op)) {
      param = this.binary(0)
      this.expect(',', 'in aggregation, expected ","')
    }
    const expr = this.binary(0)
    this.expect(')', 'in aggregation, expected ")"')
    if (!by && !without) grouping()
    return { k: 'agg', op, param, expr, by, without }
  }
}

export function parse(src: string): Node {
  const n = new Parser(lex(src), src).parse()
  check(n)
  return n
}

/** Tipo de una expresión, con los errores de tipos que da Prometheus. */
function check(n: Node): VType {
  switch (n.k) {
    case 'num':
      return 'scalar'
    case 'str':
      return 'string'
    case 'sel':
      return n.range !== undefined ? 'matrix' : 'vector'
    case 'sub': {
      const t = check(n.expr)
      if (t !== 'vector' && t !== 'scalar') throw new PromQLError(`subquery is only allowed on instant vector, got ${TYPE_NAME[t]} in "${show(n.expr)}"`)
      return 'matrix'
    }
    case 'paren':
      return check(n.expr)
    case 'neg': {
      const t = check(n.expr)
      if (t !== 'scalar' && t !== 'vector') throw new PromQLError(`unary expression only allowed on expressions of type scalar or instant vector, got "${TYPE_NAME[t]}"`)
      return t
    }
    case 'call': {
      const f = FUNCS[n.fn]
      const req = f.args.filter((a) => !a.startsWith('opt-')).length
      if (n.args.length < req || (!f.variadic && n.args.length > f.args.length)) throw new PromQLError(`expected ${f.args.length === req ? req : `${req} or ${f.args.length}`} argument(s) in call to "${n.fn}", got ${n.args.length}`)
      n.args.forEach((a, i) => {
        const want = (f.args[Math.min(i, f.args.length - 1)] ?? 'string').replace('opt-', '') as VType
        const got = check(a)
        if (got !== want) throw new PromQLError(`expected type ${TYPE_NAME[want]} in call to function "${n.fn}", got ${TYPE_NAME[got]}`)
      })
      return f.ret
    }
    case 'agg': {
      const t = check(n.expr)
      if (t !== 'vector') throw new PromQLError(`expected type instant vector in aggregation expression, got ${TYPE_NAME[t]}`)
      if (n.param) {
        const pt = check(n.param)
        const want = n.op === 'count_values' ? 'string' : 'scalar'
        if (pt !== want) throw new PromQLError(`expected type ${TYPE_NAME[want]} in aggregation parameter, got ${TYPE_NAME[pt]}`)
      }
      return 'vector'
    }
    case 'bin': {
      const l = check(n.l)
      const r = check(n.r)
      for (const t of [l, r]) if (t !== 'scalar' && t !== 'vector') throw new PromQLError(`binary expression must contain only scalar and instant vector types`)
      if (SETOPS.has(n.op) && (l !== 'vector' || r !== 'vector')) throw new PromQLError(`set operator "${n.op}" not allowed in binary scalar expression`)
      if (COMPARISON.has(n.op) && l === 'scalar' && r === 'scalar' && !n.bool) throw new PromQLError('comparisons between scalars must use BOOL modifier')
      if ((n.on || n.ignoring) && (l === 'scalar' || r === 'scalar')) throw new PromQLError('vector matching only allowed between instant vectors')
      return l === 'scalar' && r === 'scalar' ? 'scalar' : 'vector'
    }
  }
}

export function typeOf(n: Node): VType {
  return check(n)
}

/** La expresión como texto (para mensajes). */
export function show(n: Node): string {
  switch (n.k) {
    case 'num':
      return String(n.v)
    case 'str':
      return JSON.stringify(n.v)
    case 'sel':
      return `${n.name ?? ''}${n.matchers.length ? `{${n.matchers.map((m) => `${m.name}${m.op}${JSON.stringify(m.value)}`).join(', ')}}` : ''}${n.range !== undefined ? `[${formatDuration(n.range)}]` : ''}${n.offset ? ` offset ${formatDuration(n.offset)}` : ''}`
    case 'sub':
      return `${show(n.expr)}[${formatDuration(n.range)}:${n.step ? formatDuration(n.step) : ''}]`
    case 'call':
      return `${n.fn}(${n.args.map(show).join(', ')})`
    case 'agg':
      return `${n.op}${n.by ? ` by (${n.by.join(', ')})` : n.without ? ` without (${n.without.join(', ')})` : ''} (${n.param ? show(n.param) + ', ' : ''}${show(n.expr)})`
    case 'bin':
      return `${show(n.l)} ${n.op} ${show(n.r)}`
    case 'neg':
      return `-${show(n.expr)}`
    case 'paren':
      return `(${show(n.expr)})`
  }
}

/** Funciones usadas en la consulta (para verificar "usá rate"). */
export function usedFunctions(n: Node, out = new Set<string>()): Set<string> {
  switch (n.k) {
    case 'call':
      out.add(n.fn)
      n.args.forEach((a) => usedFunctions(a, out))
      break
    case 'agg':
      out.add(n.op)
      if (n.param) usedFunctions(n.param, out)
      usedFunctions(n.expr, out)
      break
    case 'bin':
      out.add(n.op)
      usedFunctions(n.l, out)
      usedFunctions(n.r, out)
      break
    case 'neg':
    case 'paren':
    case 'sub':
      usedFunctions(n.expr, out)
      break
  }
  return out
}

// ---------------------------------------------------------------------------------------
// Evaluación
// ---------------------------------------------------------------------------------------

export interface VSample {
  labels: Labels
  v: number
  /** Para timestamp(): el instante de la muestra usada. */
  t?: number
}
export interface MSeries {
  labels: Labels
  samples: Sample[]
}
export type Value = { type: 'scalar'; v: number } | { type: 'string'; v: string } | { type: 'vector'; v: VSample[] } | { type: 'matrix'; v: MSeries[] }

function lastIndexAtOrBefore(s: Sample[], t: number): number {
  let lo = 0
  let hi = s.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (s[mid].t <= t) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

function matchAll(labels: Labels, name: string | undefined, ms: Matcher[]): boolean {
  if (name !== undefined && labels.__name__ !== name) return false
  for (const m of ms) {
    const v = labels[m.name] ?? ''
    if (m.op === '=' && v !== m.value) return false
    if (m.op === '!=' && v === m.value) return false
    if (m.op === '=~' && !m.re!.test(v)) return false
    if (m.op === '!~' && m.re!.test(v)) return false
  }
  return true
}

function dropName(l: Labels): Labels {
  const { __name__: _n, ...rest } = l
  return rest
}

function sigOf(l: Labels, on?: string[], ignoring?: string[]): string {
  const keys = on ? on : Object.keys(l).filter((k) => k !== '__name__' && !(ignoring ?? []).includes(k))
  return JSON.stringify(keys.sort().map((k) => [k, l[k] ?? '']))
}

export function labelsKey(l: Labels): string {
  return JSON.stringify(Object.keys(l).sort().map((k) => [k, l[k]]))
}

function arith(op: string, a: number, b: number): number {
  switch (op) {
    case '+':
      return a + b
    case '-':
      return a - b
    case '*':
      return a * b
    case '/':
      return a / b
    case '%':
      return a % b
    case '^':
      return Math.pow(a, b)
    case 'atan2':
      return Math.atan2(a, b)
    case '==':
      return a === b ? 1 : 0
    case '!=':
      return a !== b ? 1 : 0
    case '>':
      return a > b ? 1 : 0
    case '<':
      return a < b ? 1 : 0
    case '>=':
      return a >= b ? 1 : 0
    case '<=':
      return a <= b ? 1 : 0
  }
  return NaN
}

function linreg(s: Sample[], t0: number): { slope: number; intercept: number } {
  let n = 0
  let sx = 0
  let sy = 0
  let sxy = 0
  let sxx = 0
  for (const p of s) {
    const x = p.t - t0
    n++
    sx += x
    sy += p.v
    sxy += x * p.v
    sxx += x * x
  }
  const cov = sxy - (sx * sy) / n
  const varx = sxx - (sx * sx) / n
  const slope = varx === 0 ? 0 : cov / varx
  return { slope, intercept: sy / n - (slope * sx) / n }
}

/** rate, increase y delta con la extrapolación de Prometheus. */
function extrapolated(s: Sample[], t: number, range: number, isCounter: boolean, isRate: boolean): number | undefined {
  if (s.length < 2) return undefined
  const first = s[0]
  const last = s[s.length - 1]
  let result = last.v - first.v
  if (isCounter) {
    let prev = first.v
    for (const p of s.slice(1)) {
      if (p.v < prev) result += prev
      prev = p.v
    }
  }
  const rangeStart = t - range
  let toStart = first.t - rangeStart
  let toEnd = t - last.t
  const sampled = last.t - first.t
  const avg = sampled / (s.length - 1)
  const threshold = avg * 1.1
  if (toStart >= threshold) toStart = avg / 2
  if (isCounter && result > 0 && first.v >= 0) {
    const toZero = sampled * (first.v / result)
    if (toZero < toStart) toStart = toZero
  }
  if (toEnd >= threshold) toEnd = avg / 2
  let factor = (sampled + toStart + toEnd) / sampled
  if (isRate) factor /= range
  return result * factor
}

function quantile(q: number, vals: number[]): number {
  if (!vals.length) return NaN
  if (q < 0) return -Infinity
  if (q > 1) return Infinity
  const s = [...vals].sort((a, b) => a - b)
  const rank = q * (s.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.min(s.length - 1, lo + 1)
  return s[lo] + (s[hi] - s[lo]) * (rank - lo)
}

function bucketQuantile(q: number, buckets: { le: number; v: number }[]): number {
  if (q < 0) return -Infinity
  if (q > 1) return Infinity
  const b = [...buckets].sort((a, c) => a.le - c.le)
  if (b.length < 2 || b[b.length - 1].le !== Infinity) return NaN
  // Los contadores de buckets deberían ser monótonos; si no, se corrigen como hace Prometheus.
  for (let i = 1; i < b.length; i++) if (b[i].v < b[i - 1].v) b[i].v = b[i - 1].v
  const total = b[b.length - 1].v
  if (total === 0) return NaN
  const rank = q * total
  let i = b.findIndex((x) => x.v >= rank)
  if (i === b.length - 1) return b[b.length - 2].le
  if (i === 0 && b[0].le <= 0) return b[0].le
  let start = 0
  let count = b[i].v
  let prevCount = 0
  if (i > 0) {
    start = b[i - 1].le
    prevCount = b[i - 1].v
    count -= prevCount
  }
  if (i < 0) i = b.length - 1
  return start + (b[i].le - start) * ((rank - prevCount) / count)
}

export class Engine {
  constructor(public db: Tsdb) {}

  private selectSeries(n: Extract<Node, { k: 'sel' }>): Series[] {
    return this.db.series.filter((s) => matchAll(s.labels, n.name, n.matchers))
  }

  eval(n: Node, t: number): Value {
    switch (n.k) {
      case 'num':
        return { type: 'scalar', v: n.v }
      case 'str':
        return { type: 'string', v: n.v }
      case 'paren':
        return this.eval(n.expr, t)
      case 'neg': {
        const v = this.eval(n.expr, t)
        if (v.type === 'scalar') return { type: 'scalar', v: -v.v }
        if (v.type === 'vector') return { type: 'vector', v: v.v.map((s) => ({ labels: dropName(s.labels), v: -s.v })) }
        return v
      }
      case 'sel': {
        const at = t - n.offset
        if (n.range !== undefined) {
          const out: MSeries[] = []
          for (const s of this.selectSeries(n)) {
            const hi = lastIndexAtOrBefore(s.samples, at)
            if (hi < 0) continue
            let lo = hi
            while (lo >= 0 && s.samples[lo].t > at - n.range) lo--
            const samples = s.samples.slice(lo + 1, hi + 1)
            if (samples.length) out.push({ labels: s.labels, samples })
          }
          return { type: 'matrix', v: out }
        }
        const out: VSample[] = []
        for (const s of this.selectSeries(n)) {
          const i = lastIndexAtOrBefore(s.samples, at)
          if (i < 0 || s.samples[i].t <= at - LOOKBACK) continue
          out.push({ labels: s.labels, v: s.samples[i].v, t: s.samples[i].t })
        }
        return { type: 'vector', v: out }
      }
      case 'sub': {
        const at = t - n.offset
        const step = n.step ?? 60
        const series = new Map<string, MSeries>()
        let ts = Math.floor((at - n.range) / step) * step
        if (ts <= at - n.range) ts += step
        for (; ts <= at; ts += step) {
          const v = this.eval(n.expr, ts)
          const list = v.type === 'scalar' ? [{ labels: {}, v: v.v }] : v.type === 'vector' ? v.v : []
          for (const s of list) {
            const k = labelsKey(s.labels)
            let m = series.get(k)
            if (!m) series.set(k, (m = { labels: s.labels, samples: [] }))
            m.samples.push({ t: ts, v: s.v })
          }
        }
        return { type: 'matrix', v: [...series.values()] }
      }
      case 'call':
        return this.call(n, t)
      case 'agg':
        return this.aggregate(n, t)
      case 'bin':
        return this.binary(n, t)
    }
  }

  private vec(n: Node, t: number): VSample[] {
    const v = this.eval(n, t)
    if (v.type !== 'vector') throw new PromQLError('expected instant vector')
    return v.v
  }
  private mat(n: Node, t: number): MSeries[] {
    const v = this.eval(n, t)
    if (v.type !== 'matrix') throw new PromQLError('expected range vector')
    return v.v
  }
  private scal(n: Node, t: number): number {
    const v = this.eval(n, t)
    if (v.type !== 'scalar') throw new PromQLError('expected scalar')
    return v.v
  }
  private str(n: Node, t: number): string {
    const v = this.eval(n, t)
    if (v.type !== 'string') throw new PromQLError('expected string')
    return v.v
  }

  private rangeOf(n: Node): number {
    if (n.k === 'sel') return n.range ?? 0
    if (n.k === 'sub') return n.range
    if (n.k === 'paren') return this.rangeOf(n.expr)
    return 0
  }

  private call(n: Extract<Node, { k: 'call' }>, t: number): Value {
    const a = n.args
    const mapV = (f: (v: number, s: VSample) => number, keepName = false): Value => ({
      type: 'vector',
      v: this.vec(a[0], t).map((s) => ({ labels: keepName ? s.labels : dropName(s.labels), v: f(s.v, s) })),
    })
    const overTime = (f: (s: Sample[]) => number | undefined, keepName = false): Value => {
      const out: VSample[] = []
      for (const m of this.mat(a[a.length - 1], t)) {
        const v = f(m.samples)
        if (v !== undefined) out.push({ labels: keepName ? m.labels : dropName(m.labels), v })
      }
      return { type: 'vector', v: out }
    }
    switch (n.fn) {
      case 'time':
        return { type: 'scalar', v: t }
      case 'vector':
        return { type: 'vector', v: [{ labels: {}, v: this.scal(a[0], t) }] }
      case 'scalar': {
        const v = this.vec(a[0], t)
        return { type: 'scalar', v: v.length === 1 ? v[0].v : NaN }
      }
      case 'abs':
        return mapV(Math.abs)
      case 'ceil':
        return mapV(Math.ceil)
      case 'floor':
        return mapV(Math.floor)
      case 'exp':
        return mapV(Math.exp)
      case 'sqrt':
        return mapV(Math.sqrt)
      case 'ln':
        return mapV(Math.log)
      case 'log2':
        return mapV(Math.log2)
      case 'log10':
        return mapV(Math.log10)
      case 'sgn':
        return mapV(Math.sign)
      case 'round': {
        const to = a[1] ? this.scal(a[1], t) : 1
        return mapV((v) => Math.floor(v / to + 0.5) * to)
      }
      case 'clamp_min': {
        const m = this.scal(a[1], t)
        return mapV((v) => Math.max(v, m))
      }
      case 'clamp_max': {
        const m = this.scal(a[1], t)
        return mapV((v) => Math.min(v, m))
      }
      case 'clamp': {
        const lo = this.scal(a[1], t)
        const hi = this.scal(a[2], t)
        if (lo > hi) return { type: 'vector', v: [] }
        return mapV((v) => Math.min(hi, Math.max(lo, v)))
      }
      case 'timestamp':
        return mapV((_v, s) => s.t ?? t)
      case 'hour':
      case 'day_of_week': {
        const f = (sec: number) => (n.fn === 'hour' ? new Date(sec * 1000).getUTCHours() : new Date(sec * 1000).getUTCDay())
        if (!a.length) return { type: 'vector', v: [{ labels: {}, v: f(t) }] }
        return mapV((v) => f(v))
      }
      case 'sort':
      case 'sort_desc': {
        const v = this.vec(a[0], t)
        return { type: 'vector', v: [...v].sort((x, y) => (n.fn === 'sort' ? x.v - y.v : y.v - x.v)) }
      }
      case 'absent': {
        if (this.vec(a[0], t).length) return { type: 'vector', v: [] }
        return { type: 'vector', v: [{ labels: absentLabels(a[0]), v: 1 }] }
      }
      case 'absent_over_time': {
        if (this.mat(a[0], t).length) return { type: 'vector', v: [] }
        return { type: 'vector', v: [{ labels: absentLabels(a[0]), v: 1 }] }
      }
      case 'rate':
      case 'increase':
      case 'delta': {
        const range = this.rangeOf(a[0])
        return overTime((s) => extrapolated(s, t, range, n.fn !== 'delta', n.fn === 'rate'))
      }
      case 'irate':
      case 'idelta':
        return overTime((s) => {
          if (s.length < 2) return undefined
          const [p, l] = s.slice(-2)
          let d = l.v - p.v
          if (n.fn === 'irate' && l.v < p.v) d = l.v
          return n.fn === 'irate' ? d / (l.t - p.t) : d
        })
      case 'deriv':
        return overTime((s) => (s.length < 2 ? undefined : linreg(s, t).slope))
      case 'predict_linear': {
        const d = this.scal(a[1], t)
        const out: VSample[] = []
        for (const m of this.mat(a[0], t)) {
          if (m.samples.length < 2) continue
          const { slope, intercept } = linreg(m.samples, t)
          out.push({ labels: dropName(m.labels), v: slope * d + intercept })
        }
        return { type: 'vector', v: out }
      }
      case 'avg_over_time':
        return overTime((s) => s.reduce((x, p) => x + p.v, 0) / s.length)
      case 'sum_over_time':
        return overTime((s) => s.reduce((x, p) => x + p.v, 0))
      case 'min_over_time':
        return overTime((s) => Math.min(...s.map((p) => p.v)))
      case 'max_over_time':
        return overTime((s) => Math.max(...s.map((p) => p.v)))
      case 'count_over_time':
        return overTime((s) => s.length)
      case 'last_over_time':
        return overTime((s) => s[s.length - 1].v, true)
      case 'present_over_time':
        return overTime(() => 1)
      case 'stddev_over_time':
        return overTime((s) => {
          const m = s.reduce((x, p) => x + p.v, 0) / s.length
          return Math.sqrt(s.reduce((x, p) => x + (p.v - m) ** 2, 0) / s.length)
        })
      case 'quantile_over_time': {
        const q = this.scal(a[0], t)
        return overTime((s) => quantile(q, s.map((p) => p.v)))
      }
      case 'changes':
        return overTime((s) => s.slice(1).filter((p, i) => p.v !== s[i].v).length)
      case 'resets':
        return overTime((s) => s.slice(1).filter((p, i) => p.v < s[i].v).length)
      case 'histogram_quantile': {
        const q = this.scal(a[0], t)
        const groups = new Map<string, { labels: Labels; b: { le: number; v: number }[] }>()
        for (const s of this.vec(a[1], t)) {
          const le = s.labels.le
          if (le === undefined) continue
          const { le: _le, ...rest } = dropName(s.labels)
          const k = labelsKey(rest)
          let g = groups.get(k)
          if (!g) groups.set(k, (g = { labels: rest, b: [] }))
          g.b.push({ le: le === '+Inf' ? Infinity : Number(le), v: s.v })
        }
        return { type: 'vector', v: [...groups.values()].map((g) => ({ labels: g.labels, v: bucketQuantile(q, g.b) })) }
      }
      case 'label_replace': {
        const [dst, repl, src, re] = [1, 2, 3, 4].map((i) => this.str(a[i], t))
        let rx: RegExp
        try {
          rx = new RegExp(`^(?:${re})$`)
        } catch {
          throw new PromQLError(`invalid regular expression in label_replace(): ${re}`)
        }
        return {
          type: 'vector',
          v: this.vec(a[0], t).map((s) => {
            const m = rx.exec(s.labels[src] ?? '')
            if (!m) return s
            const val = repl.replace(/\$\{?(\w+)\}?/g, (_x, g) => (/^\d+$/.test(g) ? (m[Number(g)] ?? '') : (m.groups?.[g] ?? '')))
            const labels = { ...s.labels }
            if (val === '') delete labels[dst]
            else labels[dst] = val
            return { ...s, labels }
          }),
        }
      }
      case 'label_join': {
        const dst = this.str(a[1], t)
        const sep = this.str(a[2], t)
        const srcs = a.slice(3).map((x) => this.str(x, t))
        return { type: 'vector', v: this.vec(a[0], t).map((s) => ({ ...s, labels: { ...s.labels, [dst]: srcs.map((k) => s.labels[k] ?? '').join(sep) } })) }
      }
    }
    throw new PromQLError(`function "${n.fn}" not implemented`)
  }

  private aggregate(n: Extract<Node, { k: 'agg' }>, t: number): Value {
    const input = this.vec(n.expr, t)
    const groupLabels = (l: Labels): Labels => {
      if (n.by) return Object.fromEntries(n.by.filter((k) => l[k] !== undefined && l[k] !== '').map((k) => [k, l[k]]))
      if (n.without) return Object.fromEntries(Object.entries(dropName(l)).filter(([k]) => !n.without!.includes(k)))
      return {}
    }
    const groups = new Map<string, { labels: Labels; items: VSample[] }>()
    for (const s of input) {
      const gl = groupLabels(s.labels)
      const k = labelsKey(gl)
      let g = groups.get(k)
      if (!g) groups.set(k, (g = { labels: gl, items: [] }))
      g.items.push(s)
    }
    const param = n.param ? (n.op === 'count_values' ? NaN : this.scal(n.param, t)) : NaN
    const out: VSample[] = []
    for (const g of groups.values()) {
      const vals = g.items.map((s) => s.v)
      switch (n.op) {
        case 'sum':
          out.push({ labels: g.labels, v: vals.reduce((a, b) => a + b, 0) })
          break
        case 'avg':
          out.push({ labels: g.labels, v: vals.reduce((a, b) => a + b, 0) / vals.length })
          break
        case 'min':
          out.push({ labels: g.labels, v: Math.min(...vals) })
          break
        case 'max':
          out.push({ labels: g.labels, v: Math.max(...vals) })
          break
        case 'count':
          out.push({ labels: g.labels, v: vals.length })
          break
        case 'group':
          out.push({ labels: g.labels, v: 1 })
          break
        case 'stddev':
        case 'stdvar': {
          const m = vals.reduce((a, b) => a + b, 0) / vals.length
          const v = vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length
          out.push({ labels: g.labels, v: n.op === 'stddev' ? Math.sqrt(v) : v })
          break
        }
        case 'quantile':
          out.push({ labels: g.labels, v: quantile(param, vals) })
          break
        case 'topk':
        case 'bottomk':
        case 'limitk': {
          const k = Math.floor(param)
          const sorted = n.op === 'limitk' ? g.items : [...g.items].sort((a, b) => (n.op === 'topk' ? b.v - a.v : a.v - b.v))
          out.push(...sorted.slice(0, Math.max(0, k)))
          break
        }
        case 'count_values': {
          const label = this.str(n.param!, t)
          const counts = new Map<string, number>()
          for (const v of vals) counts.set(fmt(v), (counts.get(fmt(v)) ?? 0) + 1)
          for (const [v, c] of counts) out.push({ labels: { ...g.labels, [label]: v }, v: c })
          break
        }
      }
    }
    return { type: 'vector', v: out }
  }

  private binary(n: Extract<Node, { k: 'bin' }>, t: number): Value {
    const L = this.eval(n.l, t)
    const R = this.eval(n.r, t)
    const cmp = COMPARISON.has(n.op)
    if (L.type === 'scalar' && R.type === 'scalar') return { type: 'scalar', v: arith(n.op, L.v, R.v) }
    if (L.type === 'vector' && R.type === 'scalar') return { type: 'vector', v: this.vs(L.v, R.v, n, false) }
    if (L.type === 'scalar' && R.type === 'vector') return { type: 'vector', v: this.vs(R.v, L.v, n, true) }
    if (L.type !== 'vector' || R.type !== 'vector') throw new PromQLError('invalid binary operation')
    const l = L.v
    const r = R.v
    if (SETOPS.has(n.op)) {
      const sigs = (v: VSample[]) => new Set(v.map((s) => sigOf(s.labels, n.on, n.ignoring)))
      if (n.op === 'and') {
        const rs = sigs(r)
        return { type: 'vector', v: l.filter((s) => rs.has(sigOf(s.labels, n.on, n.ignoring))) }
      }
      if (n.op === 'unless') {
        const rs = sigs(r)
        return { type: 'vector', v: l.filter((s) => !rs.has(sigOf(s.labels, n.on, n.ignoring))) }
      }
      const ls = sigs(l)
      return { type: 'vector', v: [...l, ...r.filter((s) => !ls.has(sigOf(s.labels, n.on, n.ignoring)))] }
    }
    const one = n.group === 'left' ? r : n.group === 'right' ? l : r
    const many = n.group === 'right' ? r : l
    const index = new Map<string, VSample>()
    for (const s of one) {
      const k = sigOf(s.labels, n.on, n.ignoring)
      if (index.has(k)) {
        const side = n.group === 'right' ? 'left' : 'right'
        throw new PromQLError(`found duplicate series for the match group ${fmtSig(k)} on the ${side} hand-side of the operation: [${fmtLabels(index.get(k)!.labels)}, ${fmtLabels(s.labels)}];many-to-many matching not allowed: matching labels must be unique on one side`)
      }
      index.set(k, s)
    }
    const out: VSample[] = []
    const seen = new Map<string, string>()
    for (const s of many) {
      const k = sigOf(s.labels, n.on, n.ignoring)
      const o = index.get(k)
      if (!o) continue
      const [lv, rv] = n.group === 'right' ? [o.v, s.v] : [s.v, o.v]
      const v = arith(n.op, lv, rv)
      if (cmp && !n.bool && v === 0) continue
      let labels: Labels
      if (n.group) {
        labels = cmp && !n.bool ? { ...s.labels } : dropName(s.labels)
        for (const inc of n.include) {
          if (o.labels[inc] !== undefined) labels[inc] = o.labels[inc]
          else delete labels[inc]
        }
      } else {
        const base = cmp && !n.bool ? s.labels : dropName(s.labels)
        labels = n.on ? Object.fromEntries(Object.entries(base).filter(([key]) => n.on!.includes(key))) : { ...base }
        if (n.ignoring && !n.on) for (const i of n.ignoring) delete labels[i]
      }
      const rk = labelsKey(labels)
      if (!n.group && seen.has(rk)) throw new PromQLError(`multiple matches for labels: many-to-one matching must be explicit (group_left/group_right)`)
      seen.set(rk, k)
      out.push({ labels, v: cmp && !n.bool ? lv : v })
    }
    return { type: 'vector', v: out }
  }

  /** Vector con escalar (si flipped, el escalar está a la izquierda). */
  private vs(v: VSample[], sc: number, n: Extract<Node, { k: 'bin' }>, flipped: boolean): VSample[] {
    const cmp = COMPARISON.has(n.op)
    const out: VSample[] = []
    for (const s of v) {
      const r = flipped ? arith(n.op, sc, s.v) : arith(n.op, s.v, sc)
      if (cmp && !n.bool) {
        if (r) out.push(s)
        continue
      }
      out.push({ labels: dropName(s.labels), v: r })
    }
    return out
  }
}

function absentLabels(n: Node): Labels {
  if (n.k === 'sel') return Object.fromEntries(n.matchers.filter((m) => m.op === '=').map((m) => [m.name, m.value]))
  if (n.k === 'paren') return absentLabels(n.expr)
  return {}
}

// ---------------------------------------------------------------------------------------
// Formato y consultas
// ---------------------------------------------------------------------------------------

/** Como strconv.FormatFloat(v, 'f', -1, 64) de Go, que es lo que muestra Prometheus. */
export function fmt(v: number): string {
  if (Number.isNaN(v)) return 'NaN'
  if (v === Infinity) return '+Inf'
  if (v === -Infinity) return '-Inf'
  const s = String(v)
  if (!/e/.test(s)) return s
  const [m, e] = s.split('e')
  const exp = Number(e)
  const neg = m.startsWith('-')
  const digits = m.replace('-', '').replace('.', '')
  const point = m.replace('-', '').indexOf('.') === -1 ? m.replace('-', '').length : m.replace('-', '').indexOf('.')
  const p = point + exp
  const out = p <= 0 ? `0.${'0'.repeat(-p)}${digits}` : p >= digits.length ? digits + '0'.repeat(p - digits.length) : `${digits.slice(0, p)}.${digits.slice(p)}`
  return (neg ? '-' : '') + out
}

export function fmtLabels(l: Labels): string {
  const name = l.__name__ ?? ''
  const rest = Object.keys(l)
    .filter((k) => k !== '__name__')
    .sort()
  return `${name}{${rest.map((k) => `${k}="${l[k]}"`).join(', ')}}`
}

function fmtSig(k: string): string {
  return `{${(JSON.parse(k) as [string, string][]).map(([a, b]) => `${a}="${b}"`).join(', ')}}`
}

export interface InstantResult {
  resultType: 'vector' | 'scalar' | 'matrix' | 'string'
  value: Value
}

export function instantQuery(db: Tsdb, query: string, t = db.end): InstantResult {
  const n = parse(query)
  const v = new Engine(db).eval(n, t)
  return { resultType: v.type, value: v }
}

export interface RangeResult {
  series: MSeries[]
  /** Paso de evaluación (segundos). */
  step: number
}

/** Consulta por rango (la pestaña Graph): evalúa en cada paso y junta por etiquetas. */
export function rangeQuery(db: Tsdb, query: string, start = db.start, end = db.end, step?: number): RangeResult {
  const n = parse(query)
  const ty = typeOf(n)
  if (ty !== 'vector' && ty !== 'scalar') throw new PromQLError(`invalid expression type "${TYPE_NAME[ty]}" for range query, must be Scalar or instant Vector`)
  const st = step ?? Math.max(db.step, Math.ceil((end - start) / 250 / 15) * 15)
  const eng = new Engine(db)
  const series = new Map<string, MSeries>()
  for (let t = start; t <= end; t += st) {
    const v = eng.eval(n, t)
    const list = v.type === 'scalar' ? [{ labels: {}, v: v.v }] : v.type === 'vector' ? v.v : []
    for (const s of list) {
      const k = labelsKey(s.labels)
      let m = series.get(k)
      if (!m) series.set(k, (m = { labels: s.labels, samples: [] }))
      m.samples.push({ t, v: s.v })
    }
  }
  return { series: [...series.values()], step: st }
}

/** El resultado como lo muestra promtool query instant. */
export function formatInstant(r: InstantResult, t: number): string {
  const v = r.value
  if (v.type === 'scalar') return `scalar: ${fmt(v.v)} @[${t}]`
  if (v.type === 'string') return `string: ${v.v} @[${t}]`
  if (v.type === 'vector') return v.v.map((s) => `${fmtLabels(s.labels)} => ${fmt(s.v)} @[${t}]`).join('\n')
  return v.v.map((s) => `${fmtLabels(s.labels)} =>\n${s.samples.map((p) => `${fmt(p.v)} @[${p.t}]`).join('\n')}`).join('\n')
}

export type { Labels, Sample, Series, Tsdb }
