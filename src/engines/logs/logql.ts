/**
 * Un subconjunto de LogQL (el lenguaje de Loki) sobre los logs de logdb.ts: selector de streams,
 * filtros de línea (|= != |~ !~), parsers (json, logfmt, pattern, regexp), filtros por etiqueta,
 * line_format, label_format, drop, keep y unwrap; y consultas de métricas con count_over_time,
 * rate, bytes_over_time, *_over_time, quantile_over_time, agregaciones con by/without y
 * operadores con escalares o entre vectores.
 */
import { formatDuration, parseDuration } from '../metrics/tsdb'
import type { Labels, LogDb } from './logdb'

export class LogQLError extends Error {}

// ---------------------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------------------

type TokKind = 'str' | 'num' | 'dur' | 'bytes' | 'ident' | 'op' | 'eof'
interface Tok {
  k: TokKind
  v: string
  pos: number
}

const OPS = ['|=', '|~', '!=', '!~', '=~', '==', '>=', '<=', '{', '}', '(', ')', '[', ']', ',', '|', '=', '>', '<', '+', '-', '*', '/', '%', '^']

function lex(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    const start = i
    if (c === '"' || c === '`') {
      let j = i + 1
      let s = ''
      while (j < src.length && src[j] !== c) {
        if (c === '"' && src[j] === '\\') {
          const n = src[j + 1]
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n === '"' || n === '\\' ? n : `\\${n}`
          j += 2
        } else s += src[j++]
      }
      if (j >= src.length) throw err(src, start, 'syntax error: unterminated string')
      out.push({ k: 'str', v: s, pos: start })
      i = j + 1
      continue
    }
    if (/[0-9]/.test(c)) {
      const rest = src.slice(i)
      const dur = /^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h|d|w|y))+(?![A-Za-z0-9])/.exec(rest)
      if (dur) {
        out.push({ k: 'dur', v: dur[0], pos: start })
        i += dur[0].length
        continue
      }
      const by = /^\d+(\.\d+)?([KMGTP]i?B|B)(?![A-Za-z0-9])/i.exec(rest)
      if (by) {
        out.push({ k: 'bytes', v: by[0], pos: start })
        i += by[0].length
        continue
      }
      const num = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(rest)!
      out.push({ k: 'num', v: num[0], pos: start })
      i += num[0].length
      continue
    }
    if (/[a-zA-Z_]/.test(c)) {
      const m = /^[a-zA-Z_][a-zA-Z0-9_.]*/.exec(src.slice(i))!
      out.push({ k: 'ident', v: m[0], pos: start })
      i += m[0].length
      continue
    }
    const op = OPS.find((o) => src.startsWith(o, i))
    if (!op) throw err(src, i, `syntax error: unexpected character '${c}'`)
    out.push({ k: 'op', v: op, pos: start })
    i += op.length
  }
  out.push({ k: 'eof', v: '', pos: src.length })
  return out
}

function err(src: string, pos: number, msg: string): LogQLError {
  const before = src.slice(0, pos).split('\n')
  return new LogQLError(`parse error at line ${before.length}, col ${before.at(-1)!.length + 1}: ${msg}`)
}

// ---------------------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------------------

interface Matcher {
  name: string
  op: '=' | '!=' | '=~' | '!~'
  value: string
  re?: RegExp
}

type LabelFilter =
  | { k: 'cmp'; name: string; op: string; value: string | number; kind: 'str' | 'num' | 'dur' | 'bytes'; re?: RegExp }
  | { k: 'and' | 'or'; l: LabelFilter; r: LabelFilter }

type Stage =
  | { k: 'line'; op: '|=' | '!=' | '|~' | '!~'; value: string; re?: RegExp; alt?: { value: string; re?: RegExp }[] }
  | { k: 'json'; params: { name: string; path: string }[] }
  | { k: 'logfmt' }
  | { k: 'pattern'; parts: { lit?: string; cap?: string }[] }
  | { k: 'regexp'; re: RegExp }
  | { k: 'filter'; f: LabelFilter }
  | { k: 'line_format'; tpl: string }
  | { k: 'label_format'; items: { dst: string; src?: string; tpl?: string }[] }
  | { k: 'drop' | 'keep'; names: string[] }
  | { k: 'unwrap'; name: string; conv?: 'duration' | 'duration_seconds' | 'bytes' }
  | { k: 'decolorize' }

export interface LogExpr {
  matchers: Matcher[]
  stages: Stage[]
}

export type MetricNode =
  | { k: 'num'; v: number }
  | { k: 'range'; fn: string; param?: number; log: LogExpr; range: number; offset: number; by?: string[]; without?: string[] }
  | { k: 'agg'; op: string; param?: number; expr: MetricNode; by?: string[]; without?: string[] }
  | { k: 'bin'; op: string; l: MetricNode; r: MetricNode; bool: boolean; on?: string[]; ignoring?: string[] }
  | { k: 'fn'; fn: 'sort' | 'sort_desc' | 'vector'; expr?: MetricNode; v?: number }

export type Query = { k: 'log'; expr: LogExpr } | { k: 'metric'; expr: MetricNode }

const RANGE_FNS = new Set(['count_over_time', 'rate', 'bytes_over_time', 'bytes_rate', 'sum_over_time', 'avg_over_time', 'max_over_time', 'min_over_time', 'first_over_time', 'last_over_time', 'stddev_over_time', 'stdvar_over_time', 'quantile_over_time', 'absent_over_time', 'rate_counter'])
const UNWRAP_FNS = new Set(['sum_over_time', 'avg_over_time', 'max_over_time', 'min_over_time', 'first_over_time', 'last_over_time', 'stddev_over_time', 'stdvar_over_time', 'quantile_over_time', 'rate_counter'])
const AGGS = new Set(['sum', 'avg', 'min', 'max', 'count', 'stddev', 'stdvar', 'topk', 'bottomk'])
const PREC: Record<string, number> = { or: 1, and: 2, unless: 2, '==': 3, '!=': 3, '>': 3, '<': 3, '>=': 3, '<=': 3, '+': 4, '-': 4, '*': 5, '/': 5, '%': 5, '^': 6 }

function tokName(t: Tok): string {
  if (t.k === 'eof') return '$end'
  if (t.k === 'str') return 'STRING'
  if (t.k === 'num') return 'NUMBER'
  if (t.k === 'dur') return 'DURATION'
  if (t.k === 'bytes') return 'BYTES'
  if (t.k === 'ident') return RANGE_FNS.has(t.v) || AGGS.has(t.v) || ['json', 'logfmt', 'pattern', 'regexp', 'line_format', 'label_format', 'unwrap', 'by', 'without', 'drop', 'keep'].includes(t.v) ? t.v.toUpperCase() : 'IDENTIFIER'
  return t.v
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
  is(v: string, n = 0) {
    const tk = this.peek(n)
    return (tk.k === 'op' || tk.k === 'ident') && tk.v === v
  }
  fail(expecting?: string): never {
    const tk = this.peek()
    throw err(this.src, tk.pos, `syntax error: unexpected ${tokName(tk)}${expecting ? `, expecting ${expecting}` : ''}`)
  }
  expect(v: string, expecting = v) {
    if (!this.is(v)) this.fail(expecting)
    return this.next()
  }
  str(expecting = 'STRING'): string {
    const tk = this.peek()
    if (tk.k !== 'str') this.fail(expecting)
    this.next()
    return tk.v
  }
  ident(expecting = 'IDENTIFIER'): string {
    const tk = this.peek()
    if (tk.k !== 'ident') this.fail(expecting)
    this.next()
    return tk.v
  }

  parse(): Query {
    if (this.peek().k === 'eof') throw err(this.src, 0, 'syntax error: unexpected $end')
    let q: Query
    if (this.is('{')) q = { k: 'log', expr: this.logExpr() }
    else q = { k: 'metric', expr: this.metric(0) }
    if (this.peek().k !== 'eof') this.fail()
    return q
  }

  selector(): Matcher[] {
    this.expect('{')
    const out: Matcher[] = []
    while (!this.is('}')) {
      const name = this.ident()
      const op = this.next()
      if (op.k !== 'op' || !['=', '!=', '=~', '!~'].includes(op.v)) {
        this.i--
        this.fail('EQ or NEQ or RE or NRE')
      }
      const value = this.str()
      const m: Matcher = { name, op: op.v as Matcher['op'], value }
      if (m.op === '=~' || m.op === '!~') m.re = this.regex(value)
      out.push(m)
      if (!this.is('}')) this.expect(',', 'COMMA or RBRACE')
    }
    this.next()
    const nonEmpty = out.some((m) => (m.op === '=' && m.value !== '') || (m.op === '=~' && !m.re!.test('')))
    if (!nonEmpty) throw new LogQLError('queries require at least one regexp or equality matcher that does not have an empty-compatible value. For instance, app=~".*" does not meet this requirement, but app=~".+" will')
    return out
  }

  regex(v: string): RegExp {
    try {
      return new RegExp(v.replace(/\(\?P</g, '(?<'))
    } catch {
      throw new LogQLError(`invalid regex: ${v}`)
    }
  }

  logExpr(): LogExpr {
    if (this.is('(')) {
      this.next()
      const e = this.logExpr()
      this.expect(')')
      return e
    }
    const matchers = this.selector()
    const stages: Stage[] = []
    for (;;) {
      const tk = this.peek()
      if (tk.k === 'op' && ['|=', '|~', '!~'].includes(tk.v) || (tk.k === 'op' && tk.v === '!=' && this.peek(1).k === 'str')) {
        this.next()
        const value = this.str()
        const st: Extract<Stage, { k: 'line' }> = { k: 'line', op: tk.v as '|=', value }
        if (tk.v === '|~' || tk.v === '!~') st.re = this.regex(value)
        while (this.is('or') && this.peek(1).k === 'str') {
          this.next()
          const v = this.str()
          ;(st.alt ??= []).push({ value: v, re: st.re ? this.regex(v) : undefined })
        }
        stages.push(st)
        continue
      }
      if (this.is('|')) {
        this.next()
        stages.push(this.stage())
        continue
      }
      break
    }
    return { matchers, stages }
  }

  stage(): Stage {
    const tk = this.peek()
    if (tk.k !== 'ident') this.fail('IDENTIFIER or JSON or LOGFMT or PATTERN or REGEXP or LINE_FMT or LABEL_FMT or UNWRAP')
    switch (tk.v) {
      case 'json': {
        this.next()
        const params: { name: string; path: string }[] = []
        while (this.peek().k === 'ident' && this.is('=', 1)) {
          const name = this.ident()
          this.next()
          params.push({ name, path: this.str() })
          if (this.is(',')) this.next()
        }
        return { k: 'json', params }
      }
      case 'logfmt':
        this.next()
        while (this.is('-', 0) && this.peek(1).k === 'ident') {
          this.next()
          this.next()
        }
        return { k: 'logfmt' }
      case 'decolorize':
        this.next()
        return { k: 'decolorize' }
      case 'pattern': {
        this.next()
        const p = this.str()
        const parts: { lit?: string; cap?: string }[] = []
        let last = 0
        for (const m of p.matchAll(/<(\w*)>/g)) {
          if (m.index! > last) parts.push({ lit: p.slice(last, m.index) })
          parts.push({ cap: m[1] })
          last = m.index! + m[0].length
        }
        if (last < p.length) parts.push({ lit: p.slice(last) })
        if (!parts.some((x) => x.cap && x.cap !== '_')) throw new LogQLError(`at least one capture is required`)
        return { k: 'pattern', parts }
      }
      case 'regexp': {
        this.next()
        const re = this.regex(this.str())
        if (!/\(\?<\w+>/.test(re.source)) throw new LogQLError('at least one named capture must be supplied')
        return { k: 'regexp', re }
      }
      case 'line_format':
        this.next()
        return { k: 'line_format', tpl: this.str() }
      case 'label_format': {
        this.next()
        const items: { dst: string; src?: string; tpl?: string }[] = []
        do {
          if (this.is(',')) this.next()
          const dst = this.ident()
          this.expect('=')
          if (this.peek().k === 'str') items.push({ dst, tpl: this.str() })
          else items.push({ dst, src: this.ident() })
        } while (this.is(','))
        return { k: 'label_format', items }
      }
      case 'drop':
      case 'keep': {
        this.next()
        const names: string[] = []
        do {
          if (this.is(',')) this.next()
          names.push(this.ident())
          if (this.is('=') || this.is('=~') || this.is('!=')) {
            this.next()
            this.str()
          }
        } while (this.is(','))
        return { k: tk.v, names }
      }
      case 'unwrap': {
        this.next()
        if ((this.is('duration') || this.is('duration_seconds') || this.is('bytes')) && this.is('(', 1)) {
          const conv = this.next().v as 'duration'
          this.next()
          const name = this.ident()
          this.expect(')')
          return { k: 'unwrap', name, conv }
        }
        return { k: 'unwrap', name: this.ident() }
      }
    }
    return { k: 'filter', f: this.labelFilterOr() }
  }

  labelFilterOr(): LabelFilter {
    let l = this.labelFilterAnd()
    while (this.is('or')) {
      this.next()
      l = { k: 'or', l, r: this.labelFilterAnd() }
    }
    return l
  }
  labelFilterAnd(): LabelFilter {
    let l = this.labelFilter()
    while (this.is('and') || this.is(',')) {
      this.next()
      l = { k: 'and', l, r: this.labelFilter() }
    }
    return l
  }
  labelFilter(): LabelFilter {
    if (this.is('(')) {
      this.next()
      const f = this.labelFilterOr()
      this.expect(')')
      return f
    }
    const name = this.ident()
    const op = this.next()
    if (op.k !== 'op' || !['=', '!=', '=~', '!~', '>', '>=', '<', '<=', '=='].includes(op.v)) {
      this.i--
      this.fail('EQ or NEQ or RE or NRE or GT or GTE or LT or LTE or CMP_EQ')
    }
    const v = this.next()
    if (v.k === 'str') {
      if (!['=', '!=', '=~', '!~'].includes(op.v)) {
        this.i--
        this.fail('NUMBER or DURATION or BYTES')
      }
      return { k: 'cmp', name, op: op.v, value: v.v, kind: 'str', re: op.v === '=~' || op.v === '!~' ? new RegExp(`^(?:${v.v})$`) : undefined }
    }
    if (v.k === 'num') return { k: 'cmp', name, op: op.v === '=' ? '==' : op.v, value: Number(v.v), kind: 'num' }
    if (v.k === 'dur') return { k: 'cmp', name, op: op.v === '=' ? '==' : op.v, value: parseGoDuration(v.v)!, kind: 'dur' }
    if (v.k === 'bytes') return { k: 'cmp', name, op: op.v === '=' ? '==' : op.v, value: parseBytes(v.v)!, kind: 'bytes' }
    this.i--
    this.fail('STRING or NUMBER or DURATION or BYTES')
  }

  grouping(): { by?: string[]; without?: string[] } {
    if (!this.is('by') && !this.is('without')) return {}
    const which = this.next().v
    this.expect('(')
    const names: string[] = []
    while (!this.is(')')) {
      names.push(this.ident())
      if (!this.is(')')) this.expect(',', 'COMMA or RPAREN')
    }
    this.next()
    return which === 'by' ? { by: names } : { without: names }
  }

  /** Expresiones con operadores; on(...) e ignoring(...) eligen qué etiquetas tienen que coincidir. */
  metric(min: number): MetricNode {
    let left = this.metricUnary()
    for (;;) {
      const tk = this.peek()
      const op = (tk.k === 'op' || tk.k === 'ident') && tk.v in PREC ? tk.v : undefined
      if (!op || PREC[op] < min) break
      this.next()
      const n: Extract<MetricNode, { k: 'bin' }> = { k: 'bin', op, l: left, r: left, bool: false }
      if (this.is('bool')) {
        this.next()
        n.bool = true
      }
      if (this.is('on') || this.is('ignoring')) {
        const which = this.next().v as 'on' | 'ignoring'
        this.expect('(')
        const names: string[] = []
        while (!this.is(')')) {
          names.push(this.ident())
          if (!this.is(')')) this.expect(',', 'COMMA or RPAREN')
        }
        this.next()
        n[which] = names
      }
      n.r = this.metric(op === '^' ? PREC[op] : PREC[op] + 1)
      left = n
    }
    return left
  }

  metricUnary(): MetricNode {
    if (this.is('-')) {
      this.next()
      const e = this.metricUnary()
      return e.k === 'num' ? { k: 'num', v: -e.v } : { k: 'bin', op: '*', l: { k: 'num', v: -1 }, r: e, bool: false }
    }
    return this.metricPrimary()
  }

  number(): number {
    const tk = this.peek()
    if (tk.k !== 'num') this.fail('NUMBER')
    this.next()
    return Number(tk.v)
  }

  metricPrimary(): MetricNode {
    const tk = this.peek()
    if (tk.k === 'num') {
      this.next()
      return { k: 'num', v: Number(tk.v) }
    }
    if (this.is('(')) {
      this.next()
      const e = this.metric(0)
      this.expect(')')
      return e
    }
    if (tk.k === 'op' && tk.v === '{') {
      // Una consulta de logs donde se esperaba una métrica.
      this.fail('NUMBER or RANGE_AGGREGATION or VECTOR_AGGREGATION')
    }
    if (tk.k !== 'ident') this.fail()
    if (RANGE_FNS.has(tk.v)) {
      this.next()
      this.expect('(', 'OPEN_PARENTHESIS')
      let param: number | undefined
      if (tk.v === 'quantile_over_time') {
        param = this.number()
        this.expect(',', 'COMMA')
      }
      const log = this.logExpr()
      if (!this.is('[')) this.fail('|= or != or |~ or !~ or | or [')
      this.next()
      const d = this.next()
      if (d.k !== 'dur') {
        this.i--
        this.fail('DURATION')
      }
      this.expect(']', 'CLOSE_BRACKET')
      let offset = 0
      if (this.is('offset')) {
        this.next()
        const od = this.next()
        offset = parseDuration(od.v) ?? 0
      }
      this.expect(')', 'CLOSE_PARENTHESIS')
      const g = this.grouping()
      const unwrap = log.stages.find((s) => s.k === 'unwrap')
      if (UNWRAP_FNS.has(tk.v) && !unwrap) throw new LogQLError(`invalid aggregation ${tk.v} without unwrap`)
      if (!UNWRAP_FNS.has(tk.v) && unwrap && tk.v !== 'rate') throw new LogQLError(`invalid aggregation ${tk.v} with unwrap`)
      if ((g.by || g.without) && !unwrap) throw new LogQLError(`grouping not allowed for ${tk.v} aggregation`)
      return { k: 'range', fn: tk.v, param, log, range: parseDuration(d.v.replace(/\.\d+/, '')) ?? 0, offset, ...g }
    }
    if (AGGS.has(tk.v)) {
      this.next()
      let g = this.grouping()
      this.expect('(', 'OPEN_PARENTHESIS')
      let param: number | undefined
      if (tk.v === 'topk' || tk.v === 'bottomk') {
        param = this.number()
        this.expect(',', 'COMMA')
      }
      const expr = this.metric(0)
      this.expect(')', 'CLOSE_PARENTHESIS')
      if (!g.by && !g.without) g = this.grouping()
      return { k: 'agg', op: tk.v, param, expr, ...g }
    }
    if (tk.v === 'sort' || tk.v === 'sort_desc') {
      this.next()
      this.expect('(')
      const expr = this.metric(0)
      this.expect(')')
      return { k: 'fn', fn: tk.v, expr }
    }
    if (tk.v === 'vector') {
      this.next()
      this.expect('(')
      const v = this.number()
      this.expect(')')
      return { k: 'fn', fn: 'vector', v }
    }
    this.fail()
  }
}

export function parseLogQL(src: string): Query {
  return new Parser(lex(src), src).parse()
}

// ---------------------------------------------------------------------------------------
// Conversión de valores
// ---------------------------------------------------------------------------------------

/** Duración al estilo de Go (1.5s, 250ms, 2h45m) en segundos. */
export function parseGoDuration(s: string): number | undefined {
  const m = /^-?((\d+(\.\d+)?)(ns|us|µs|ms|s|m|h|d|w|y))+$/.exec(s.trim())
  if (!m) return undefined
  const f: Record<string, number> = { ns: 1e-9, us: 1e-6, µs: 1e-6, ms: 1e-3, s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 }
  let total = 0
  for (const x of s.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h|d|w|y)/g)) total += Number(x[1]) * f[x[2]]
  return s.trim().startsWith('-') ? -total : total
}

export function parseBytes(s: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*([KMGTP]?)(i?)B$/i.exec(s.trim())
  if (!m) return /^\d+$/.test(s.trim()) ? Number(s) : undefined
  const pow = ' KMGTP'.indexOf(m[2].toUpperCase() || ' ')
  return Number(m[1]) * (m[3] ? 1024 : 1000) ** pow
}

// ---------------------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------------------

interface Row {
  labels: Labels
  line: string
  t: number
  value?: number
}

const sanitize = (k: string) => {
  const s = k.replace(/[^a-zA-Z0-9_]/g, '_')
  return /^[0-9]/.test(s) ? `_${s}` : s
}

function flatten(obj: unknown, prefix: string, out: Record<string, string>) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}_${sanitize(k)}` : sanitize(k), out)
  } else if (prefix) out[prefix] = obj === null ? '' : Array.isArray(obj) ? JSON.stringify(obj) : String(obj)
}

function addExtracted(row: Row, extracted: Record<string, string>, streamKeys: Set<string>) {
  for (const [k, v] of Object.entries(extracted)) {
    const key = streamKeys.has(k) ? `${k}_extracted` : k
    row.labels[key] = v
  }
}

function logfmt(line: string): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  const re = /([^\s=]+)(?:=("(?:[^"\\]|\\.)*"|\S*))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) {
    const raw = m[2] ?? ''
    out[sanitize(m[1])] = raw.startsWith('"') ? raw.slice(1, -1).replace(/\\"/g, '"') : raw
  }
  return out
}

function pattern(parts: { lit?: string; cap?: string }[], line: string): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  let pos = 0
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p.lit !== undefined) {
      if (i === 0) {
        if (!line.startsWith(p.lit)) return undefined
        pos = p.lit.length
        continue
      }
      continue
    }
    const nextLit = parts[i + 1]?.lit
    let end = line.length
    if (nextLit !== undefined) {
      end = line.indexOf(nextLit, pos)
      if (end < 0) return undefined
    }
    if (p.cap && p.cap !== '_') out[p.cap] = line.slice(pos, end)
    pos = end + (nextLit?.length ?? 0)
    if (nextLit !== undefined) i++
  }
  return out
}

function template(tpl: string, row: Row): string {
  return tpl.replace(/\{\{-?\s*(\.?[\w]+)((?:\s*\|\s*\w+)*)\s*-?\}\}/g, (_m, name: string, fns: string) => {
    let v = name === '__line__' || name === '.__line__' ? row.line : name === '__timestamp__' ? new Date(row.t * 1000).toISOString() : (row.labels[name.replace(/^\./, '')] ?? '')
    for (const f of fns.split('|').map((x) => x.trim()).filter(Boolean)) {
      if (f === 'ToUpper' || f === 'upper') v = v.toUpperCase()
      else if (f === 'ToLower' || f === 'lower') v = v.toLowerCase()
      else if (f === 'trim' || f === 'TrimSpace') v = v.trim()
    }
    return v
  })
}

function testFilter(f: LabelFilter, row: Row): boolean {
  if (f.k !== 'cmp') return f.k === 'and' ? testFilter(f.l, row) && testFilter(f.r, row) : testFilter(f.l, row) || testFilter(f.r, row)
  const v = row.labels[f.name]
  if (f.kind === 'str') {
    const s = v ?? ''
    if (f.op === '=') return s === f.value
    if (f.op === '!=') return s !== f.value
    if (f.op === '=~') return f.re!.test(s)
    return !f.re!.test(s)
  }
  if (v === undefined) return false
  const n = f.kind === 'dur' ? parseGoDuration(v) : f.kind === 'bytes' ? parseBytes(v) : Number(v)
  if (n === undefined || Number.isNaN(n)) {
    row.labels.__error__ = 'LabelFilterErr'
    row.labels.__error_details__ = f.kind === 'num' ? `strconv.ParseFloat: parsing "${v}": invalid syntax` : `time: invalid duration "${v}"`
    return true
  }
  const x = f.value as number
  switch (f.op) {
    case '==':
      return n === x
    case '!=':
      return n !== x
    case '>':
      return n > x
    case '>=':
      return n >= x
    case '<':
      return n < x
    case '<=':
      return n <= x
  }
  return false
}

function lineMatches(st: Extract<Stage, { k: 'line' }>, line: string): boolean {
  const opts = [{ value: st.value, re: st.re }, ...(st.alt ?? [])]
  const hit = opts.some((o) => (o.re ? o.re.test(line) : line.includes(o.value)))
  return st.op === '|=' || st.op === '|~' ? hit : !hit
}

function runPipeline(stages: Stage[], row: Row, streamKeys: Set<string>): Row | undefined {
  for (const st of stages) {
    switch (st.k) {
      case 'line':
        if (!lineMatches(st, row.line)) return undefined
        break
      case 'decolorize':
        row.line = row.line.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
        break
      case 'json': {
        let obj: unknown
        try {
          obj = JSON.parse(row.line)
        } catch (e) {
          row.labels.__error__ = 'JSONParserErr'
          row.labels.__error_details__ = (e as Error).message
          break
        }
        const out: Record<string, string> = {}
        if (st.params.length) {
          for (const p of st.params) {
            let cur: unknown = obj
            for (const part of p.path.split('.')) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[part.replace(/\[(\d+)\]$/, '')] : undefined
            if (cur !== undefined) out[p.name] = typeof cur === 'object' ? JSON.stringify(cur) : String(cur)
          }
        } else flatten(obj, '', out)
        addExtracted(row, out, streamKeys)
        break
      }
      case 'logfmt': {
        const out = logfmt(row.line)
        if (out) addExtracted(row, out, streamKeys)
        break
      }
      case 'pattern': {
        const out = pattern(st.parts, row.line)
        if (out) addExtracted(row, out, streamKeys)
        break
      }
      case 'regexp': {
        const m = st.re.exec(row.line)
        if (m?.groups) addExtracted(row, Object.fromEntries(Object.entries(m.groups).filter(([, v]) => v !== undefined)) as Record<string, string>, streamKeys)
        break
      }
      case 'filter':
        if (!testFilter(st.f, row)) return undefined
        break
      case 'line_format':
        row.line = template(st.tpl, row)
        break
      case 'label_format':
        for (const it of st.items) {
          if (it.src !== undefined) {
            const v = row.labels[it.src]
            delete row.labels[it.src]
            if (v !== undefined) row.labels[it.dst] = v
          } else row.labels[it.dst] = template(it.tpl!, row)
        }
        break
      case 'drop':
        for (const n of st.names) delete row.labels[n]
        break
      case 'keep':
        for (const k of Object.keys(row.labels)) if (!st.names.includes(k)) delete row.labels[k]
        break
      case 'unwrap': {
        const raw = row.labels[st.name]
        const v = raw === undefined ? undefined : st.conv === 'bytes' ? parseBytes(raw) : st.conv ? parseGoDuration(raw) : Number(raw)
        if (v === undefined || Number.isNaN(v)) {
          row.labels.__error__ = 'SampleExtractionErr'
          row.labels.__error_details__ = raw === undefined ? `label ${st.name} not found` : `strconv.ParseFloat: parsing "${raw}": invalid syntax`
        } else row.value = v
        delete row.labels[st.name]
        break
      }
    }
  }
  return row
}

function matchStream(labels: Labels, ms: Matcher[]): boolean {
  return ms.every((m) => {
    const v = labels[m.name] ?? ''
    if (m.op === '=') return v === m.value
    if (m.op === '!=') return v !== m.value
    if (m.op === '=~') return new RegExp(`^(?:${m.re!.source})$`).test(v)
    return !new RegExp(`^(?:${m.re!.source})$`).test(v)
  })
}

const key = (l: Labels) => JSON.stringify(Object.keys(l).sort().map((k) => [k, l[k]]))

/** Las filas que deja pasar una consulta de logs entre dos instantes (a, b]. */
function select(db: LogDb, e: LogExpr, a: number, b: number): Row[] {
  const out: Row[] = []
  for (const s of db.streams) {
    if (!matchStream(s.labels, e.matchers)) continue
    const streamKeys = new Set(Object.keys(s.labels))
    // Búsqueda binaria del primer elemento después de a.
    let lo = 0
    let hi = s.entries.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (s.entries[mid].t <= a) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < s.entries.length && s.entries[i].t <= b; i++) {
      const en = s.entries[i]
      const r = runPipeline(e.stages, { labels: { ...s.labels }, line: en.line, t: en.t }, streamKeys)
      if (r) out.push(r)
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------
// Evaluación
// ---------------------------------------------------------------------------------------

export interface LogLine {
  labels: Labels
  line: string
  t: number
}

export interface VSample {
  labels: Labels
  v: number
}

function quantile(q: number, vals: number[]): number {
  if (!vals.length) return NaN
  const s = [...vals].sort((x, y) => x - y)
  const rank = q * (s.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.min(s.length - 1, lo + 1)
  return s[lo] + (s[hi] - s[lo]) * (rank - lo)
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
      return a ** b
    case '==':
      return +(a === b)
    case '!=':
      return +(a !== b)
    case '>':
      return +(a > b)
    case '<':
      return +(a < b)
    case '>=':
      return +(a >= b)
    case '<=':
      return +(a <= b)
  }
  return NaN
}

const CMP = new Set(['==', '!=', '>', '<', '>=', '<='])

function pipelineError(rows: Row[]): void {
  const bad = rows.find((r) => r.labels.__error__)
  if (!bad) return
  const shown = Object.fromEntries(Object.entries(bad.labels).filter(([k]) => k !== '__error_details__'))
  throw new LogQLError(
    `pipeline error: '${bad.labels.__error__}' for series: '{${Object.keys(shown)
      .sort()
      .map((k) => `${k}="${shown[k]}"`)
      .join(', ')}}'.\nUse a label filter to intentionally skip this error. (e.g | __error__!="${bad.labels.__error__}").\nTo skip all potential errors you can match empty errors.(e.g __error__="")\nThe label filter can also be specified after unwrap. (e.g | unwrap latency | __error__="" )`,
  )
}

export function evalMetric(db: LogDb, n: MetricNode, t: number): VSample[] | number {
  switch (n.k) {
    case 'num':
      return n.v
    case 'fn': {
      if (n.fn === 'vector') return [{ labels: {}, v: n.v! }]
      const v = evalMetric(db, n.expr!, t)
      if (typeof v === 'number') return v
      return [...v].sort((a, b) => (n.fn === 'sort' ? a.v - b.v : b.v - a.v))
    }
    case 'range': {
      const end = t - n.offset
      const rows = select(db, n.log, end - n.range, end)
      pipelineError(rows)
      const groups = new Map<string, { labels: Labels; rows: Row[] }>()
      for (const r of rows) {
        const { __error_details__: _d, ...labels0 } = r.labels
        let labels = labels0
        if (n.by) labels = Object.fromEntries(n.by.filter((k) => labels0[k] !== undefined).map((k) => [k, labels0[k]]))
        else if (n.without) labels = Object.fromEntries(Object.entries(labels0).filter(([k]) => !n.without!.includes(k)))
        const k = key(labels)
        let g = groups.get(k)
        if (!g) groups.set(k, (g = { labels, rows: [] }))
        g.rows.push(r)
      }
      if (n.fn === 'absent_over_time') {
        if (rows.length) return []
        return [{ labels: Object.fromEntries(n.log.matchers.filter((m) => m.op === '=').map((m) => [m.name, m.value])), v: 1 }]
      }
      const out: VSample[] = []
      for (const g of groups.values()) {
        const vals = g.rows.map((r) => r.value ?? 0)
        const bytes = g.rows.reduce((s, r) => s + new TextEncoder().encode(r.line).length, 0)
        let v: number
        switch (n.fn) {
          case 'count_over_time':
            v = g.rows.length
            break
          case 'rate':
            v = (g.rows[0].value !== undefined ? vals.reduce((a, b) => a + b, 0) : g.rows.length) / n.range
            break
          case 'bytes_over_time':
            v = bytes
            break
          case 'bytes_rate':
            v = bytes / n.range
            break
          case 'sum_over_time':
            v = vals.reduce((a, b) => a + b, 0)
            break
          case 'avg_over_time':
            v = vals.reduce((a, b) => a + b, 0) / vals.length
            break
          case 'max_over_time':
            v = Math.max(...vals)
            break
          case 'min_over_time':
            v = Math.min(...vals)
            break
          case 'first_over_time':
            v = vals[0]
            break
          case 'last_over_time':
            v = vals[vals.length - 1]
            break
          case 'stddev_over_time':
          case 'stdvar_over_time': {
            const m = vals.reduce((a, b) => a + b, 0) / vals.length
            const variance = vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length
            v = n.fn === 'stddev_over_time' ? Math.sqrt(variance) : variance
            break
          }
          case 'quantile_over_time':
            v = quantile(n.param ?? 0.5, vals)
            break
          default:
            v = g.rows.length
        }
        out.push({ labels: g.labels, v })
      }
      return out
    }
    case 'agg': {
      const v = evalMetric(db, n.expr, t)
      if (typeof v === 'number') throw new LogQLError('aggregation over a scalar is not supported')
      const groups = new Map<string, { labels: Labels; items: VSample[] }>()
      for (const s of v) {
        const labels = n.by ? Object.fromEntries(n.by.filter((k) => s.labels[k] !== undefined).map((k) => [k, s.labels[k]])) : n.without ? Object.fromEntries(Object.entries(s.labels).filter(([k]) => !n.without!.includes(k))) : {}
        const k = key(labels)
        let g = groups.get(k)
        if (!g) groups.set(k, (g = { labels, items: [] }))
        g.items.push(s)
      }
      const out: VSample[] = []
      for (const g of groups.values()) {
        const vals = g.items.map((s) => s.v)
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length
        switch (n.op) {
          case 'sum':
            out.push({ labels: g.labels, v: vals.reduce((a, b) => a + b, 0) })
            break
          case 'avg':
            out.push({ labels: g.labels, v: mean })
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
          case 'stddev':
          case 'stdvar': {
            const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length
            out.push({ labels: g.labels, v: n.op === 'stddev' ? Math.sqrt(variance) : variance })
            break
          }
          case 'topk':
          case 'bottomk':
            out.push(...[...g.items].sort((a, b) => (n.op === 'topk' ? b.v - a.v : a.v - b.v)).slice(0, n.param ?? 1))
            break
        }
      }
      return out
    }
    case 'bin': {
      const L = evalMetric(db, n.l, t)
      const R = evalMetric(db, n.r, t)
      const cmp = CMP.has(n.op)
      if (typeof L === 'number' && typeof R === 'number') return arith(n.op, L, R)
      if (n.op === 'and' || n.op === 'or' || n.op === 'unless') {
        if (typeof L === 'number' || typeof R === 'number') throw new LogQLError(`unexpected literal for right leg of logical/set binary operation (${n.op})`)
        const sig = (l: Labels) => key(n.on ? Object.fromEntries(n.on.map((k) => [k, l[k] ?? ''])) : Object.fromEntries(Object.entries(l).filter(([k]) => !(n.ignoring ?? []).includes(k))))
        const rs = new Set(R.map((s) => sig(s.labels)))
        if (n.op === 'and') return L.filter((s) => rs.has(sig(s.labels)))
        if (n.op === 'unless') return L.filter((s) => !rs.has(sig(s.labels)))
        const ls = new Set(L.map((s) => sig(s.labels)))
        return [...L, ...R.filter((s) => !ls.has(sig(s.labels)))]
      }
      if (typeof R === 'number' || typeof L === 'number') {
        const vec = (typeof L === 'number' ? R : L) as VSample[]
        const sc = (typeof L === 'number' ? L : R) as number
        const out: VSample[] = []
        for (const s of vec) {
          const r = typeof L === 'number' ? arith(n.op, sc, s.v) : arith(n.op, s.v, sc)
          if (cmp && !n.bool) {
            if (r) out.push(s)
          } else out.push({ labels: s.labels, v: r })
        }
        return out
      }
      const sig = (l: Labels) => key(n.on ? Object.fromEntries(n.on.map((k) => [k, l[k] ?? ''])) : Object.fromEntries(Object.entries(l).filter(([k]) => !(n.ignoring ?? []).includes(k))))
      const right = new Map<string, VSample>()
      for (const s of R) {
        const k = sig(s.labels)
        if (right.has(k)) throw new LogQLError('multiple matches for labels: many-to-one matching must be explicit (group_left/group_right)')
        right.set(k, s)
      }
      const out: VSample[] = []
      for (const s of L) {
        const o = right.get(sig(s.labels))
        if (!o) continue
        const r = arith(n.op, s.v, o.v)
        if (cmp && !n.bool) {
          if (r) out.push(s)
        } else out.push({ labels: n.on ? Object.fromEntries(n.on.filter((k) => s.labels[k] !== undefined).map((k) => [k, s.labels[k]])) : s.labels, v: r })
      }
      return out
    }
  }
}

/** Consulta de logs: las líneas de la ventana, de la más nueva a la más vieja. */
export function queryLogs(db: LogDb, e: LogExpr, limit = 1000): { lines: LogLine[]; streams: Labels[] } {
  const rows = select(db, e, db.start - 1, db.end)
  rows.sort((a, b) => b.t - a.t)
  const shown = rows.slice(0, limit)
  const streams = new Map<string, Labels>()
  for (const r of shown) {
    delete r.labels.__error_details__
    streams.set(key(r.labels), r.labels)
  }
  return { lines: shown.map((r) => ({ labels: r.labels, line: r.line, t: r.t })), streams: [...streams.values()] }
}

/** Consulta de métricas por rango (para el gráfico). */
export function metricRange(db: LogDb, n: MetricNode, step?: number): { series: { labels: Labels; samples: { t: number; v: number }[] }[]; step: number } {
  const st = step ?? Math.max(60, Math.ceil((db.end - db.start) / 200 / 60) * 60)
  const series = new Map<string, { labels: Labels; samples: { t: number; v: number }[] }>()
  for (let t = db.start + st; t <= db.end; t += st) {
    const v = evalMetric(db, n, t)
    const list = typeof v === 'number' ? [{ labels: {}, v }] : v
    for (const s of list) {
      const k = key(s.labels)
      let m = series.get(k)
      if (!m) series.set(k, (m = { labels: s.labels, samples: [] }))
      m.samples.push({ t, v: s.v })
    }
  }
  return { series: [...series.values()], step: st }
}

/** Qué usa la consulta (para las verificaciones "usá json", "usá count_over_time"). */
export function usedFeatures(q: Query): Set<string> {
  const out = new Set<string>()
  const log = (e: LogExpr) => {
    for (const s of e.stages) {
      if (s.k === 'line') out.add(s.op)
      else if (s.k === 'filter') out.add('filtro de etiquetas')
      else out.add(s.k)
    }
  }
  const metric = (n: MetricNode) => {
    if (n.k === 'range') {
      out.add(n.fn)
      log(n.log)
    } else if (n.k === 'agg') {
      out.add(n.op)
      metric(n.expr)
    } else if (n.k === 'bin') {
      out.add(n.op)
      metric(n.l)
      metric(n.r)
    } else if (n.k === 'fn' && n.expr) {
      out.add(n.fn)
      metric(n.expr)
    }
  }
  if (q.k === 'log') log(q.expr)
  else metric(q.expr)
  return out
}

export { formatDuration }
