/**
 * jq: el subconjunto que se usa para leer las respuestas JSON de las APIs (Prometheus, Loki,
 * Grafana): campos, .[], tuberías, select, map, construcción de objetos y arreglos, cadenas con
 * \(...), comparaciones, and/or/not, //, if-then-else, length, keys, sort_by, group_by, test,
 * join y compañía, con -r, -c, -e y -n.
 */
import { register } from '../shell'

type J = unknown
class JqError extends Error {}

type Tok = { k: 'num' | 'str' | 'ident' | 'field' | 'op' | 'var' | 'eof'; v: string; parts?: (string | Node)[] }

type Node =
  | { k: 'id' }
  | { k: 'recurse' }
  | { k: 'lit'; v: J }
  | { k: 'str'; parts: (string | Node)[] }
  | { k: 'field'; of: Node; name: string; opt: boolean }
  | { k: 'index'; of: Node; idx: Node; opt: boolean }
  | { k: 'slice'; of: Node; from?: Node; to?: Node }
  | { k: 'iter'; of: Node; opt: boolean }
  | { k: 'pipe'; l: Node; r: Node }
  | { k: 'comma'; l: Node; r: Node }
  | { k: 'bin'; op: string; l: Node; r: Node }
  | { k: 'neg'; e: Node }
  | { k: 'arr'; e?: Node }
  | { k: 'obj'; entries: { key: Node | string; value?: Node }[] }
  | { k: 'call'; name: string; args: Node[] }
  | { k: 'if'; cond: Node; then: Node; els?: Node }
  | { k: 'var'; name: string }
  | { k: 'as'; src: Node; name: string; body: Node }
  | { k: 'try'; e: Node }

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
    if (c === '"') {
      const parts: (string | Node)[] = []
      let s = ''
      i++
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') {
          const n = src[i + 1]
          if (n === '(') {
            let depth = 1
            let j = i + 2
            while (j < src.length && depth) {
              if (src[j] === '(') depth++
              else if (src[j] === ')') depth--
              j++
            }
            if (s) parts.push(s)
            s = ''
            parts.push(parse(src.slice(i + 2, j - 1)))
            i = j
            continue
          }
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n
          i += 2
        } else s += src[i++]
      }
      if (i >= src.length) throw new JqError('syntax error, unexpected end of file, unterminated string')
      i++
      if (s || !parts.length) parts.push(s)
      out.push({ k: 'str', v: '', parts })
      continue
    }
    if (/[0-9]/.test(c)) {
      const m = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i))!
      out.push({ k: 'num', v: m[0] })
      i += m[0].length
      continue
    }
    if (c === '.' && /[A-Za-z_]/.test(src[i + 1] ?? '')) {
      const m = /^\.([A-Za-z_][\w]*)/.exec(src.slice(i))!
      out.push({ k: 'field', v: m[1] })
      i += m[0].length
      continue
    }
    if (c === '.' && src[i + 1] === '"') {
      i++
      continue
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_]\w*)/.exec(src.slice(i))
      if (!m) throw new JqError(`syntax error, unexpected '$'`)
      out.push({ k: 'var', v: m[1] })
      i += m[0].length
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][\w]*/.exec(src.slice(i))!
      out.push({ k: 'ident', v: m[0] })
      i += m[0].length
      continue
    }
    const op = ['//', '==', '!=', '<=', '>=', '..', '|', ',', '.', '[', ']', '(', ')', '{', '}', ':', ';', '+', '-', '*', '/', '%', '<', '>', '?'].find((o) => src.startsWith(o, i))
    if (!op) throw new JqError(`syntax error, unexpected INVALID_CHARACTER (Unix shell quoting issues?)`)
    out.push({ k: 'op', v: op })
    i += op.length
  }
  out.push({ k: 'eof', v: '' })
  return out
}

class Parser {
  i = 0
  constructor(private t: Tok[]) {}
  peek() {
    return this.t[this.i]
  }
  is(v: string) {
    const t = this.peek()
    return (t.k === 'op' || t.k === 'ident') && t.v === v
  }
  eat(v: string) {
    if (!this.is(v)) throw new JqError(`syntax error, unexpected ${this.peek().k === 'eof' ? 'end of file' : `'${this.peek().v}'`}, expecting '${v}'`)
    this.i++
  }
  pipe(): Node {
    let l = this.comma()
    if (this.is('as')) {
      this.i++
      const v = this.peek()
      if (v.k !== 'var') throw new JqError('syntax error, unexpected token, expecting $__loc__ or IDENT')
      this.i++
      this.eat('|')
      return { k: 'as', src: l, name: v.v, body: this.pipe() }
    }
    while (this.is('|')) {
      this.i++
      l = { k: 'pipe', l, r: this.pipe() }
    }
    return l
  }
  comma(): Node {
    let l = this.alt()
    while (this.is(',')) {
      this.i++
      l = { k: 'comma', l, r: this.alt() }
    }
    return l
  }
  alt(): Node {
    let l = this.or()
    while (this.is('//')) {
      this.i++
      l = { k: 'bin', op: '//', l, r: this.or() }
    }
    return l
  }
  or(): Node {
    let l = this.and()
    while (this.is('or')) {
      this.i++
      l = { k: 'bin', op: 'or', l, r: this.and() }
    }
    return l
  }
  and(): Node {
    let l = this.cmp()
    while (this.is('and')) {
      this.i++
      l = { k: 'bin', op: 'and', l, r: this.cmp() }
    }
    return l
  }
  cmp(): Node {
    const l = this.add()
    for (const op of ['==', '!=', '<=', '>=', '<', '>']) {
      if (this.is(op)) {
        this.i++
        return { k: 'bin', op, l, r: this.add() }
      }
    }
    return l
  }
  add(): Node {
    let l = this.mul()
    while (this.is('+') || this.is('-')) {
      const op = this.t[this.i++].v
      l = { k: 'bin', op, l, r: this.mul() }
    }
    return l
  }
  mul(): Node {
    let l = this.post()
    while (this.is('*') || this.is('/') || this.is('%')) {
      const op = this.t[this.i++].v
      l = { k: 'bin', op, l, r: this.post() }
    }
    return l
  }
  suffix(n: Node): Node {
    for (;;) {
      const t = this.peek()
      if (t.k === 'field') {
        this.i++
        const opt = this.is('?')
        if (opt) this.i++
        n = { k: 'field', of: n, name: t.v, opt }
        continue
      }
      if (this.is('.') && this.t[this.i + 1]?.k === 'str') {
        this.i++
        const s = this.t[this.i++]
        n = { k: 'field', of: n, name: String(s.parts?.[0] ?? ''), opt: false }
        continue
      }
      if (this.is('[') || (this.is('.') && this.t[this.i + 1]?.v === '[')) {
        if (this.is('.')) this.i++
        this.i++
        if (this.is(']')) {
          this.i++
          const opt = this.is('?')
          if (opt) this.i++
          n = { k: 'iter', of: n, opt }
          continue
        }
        if (this.is(':')) {
          this.i++
          const to = this.pipe()
          this.eat(']')
          n = { k: 'slice', of: n, to }
          continue
        }
        const idx = this.pipe()
        if (this.is(':')) {
          this.i++
          const to = this.is(']') ? undefined : this.pipe()
          this.eat(']')
          n = { k: 'slice', of: n, from: idx, to }
          continue
        }
        this.eat(']')
        const opt = this.is('?')
        if (opt) this.i++
        n = { k: 'index', of: n, idx, opt }
        continue
      }
      if (this.is('?')) {
        this.i++
        n = { k: 'try', e: n }
        continue
      }
      return n
    }
  }
  post(): Node {
    if (this.is('-')) {
      this.i++
      return { k: 'neg', e: this.post() }
    }
    return this.suffix(this.primary())
  }
  primary(): Node {
    const t = this.peek()
    if (t.k === 'field') return { k: 'id' }
    if (t.k === 'num') {
      this.i++
      return { k: 'lit', v: Number(t.v) }
    }
    if (t.k === 'str') {
      this.i++
      return t.parts!.length === 1 && typeof t.parts![0] === 'string' ? { k: 'lit', v: t.parts![0] } : { k: 'str', parts: t.parts! }
    }
    if (t.k === 'var') {
      this.i++
      return { k: 'var', name: t.v }
    }
    if (this.is('..')) {
      this.i++
      return { k: 'recurse' }
    }
    if (this.is('.')) {
      this.i++
      return { k: 'id' }
    }
    if (this.is('(')) {
      this.i++
      const e = this.pipe()
      this.eat(')')
      return e
    }
    if (this.is('[')) {
      this.i++
      if (this.is(']')) {
        this.i++
        return { k: 'arr' }
      }
      const e = this.pipe()
      this.eat(']')
      return { k: 'arr', e }
    }
    if (this.is('{')) {
      this.i++
      const entries: { key: Node | string; value?: Node }[] = []
      while (!this.is('}')) {
        const k = this.peek()
        let key: Node | string
        if (k.k === 'ident' || k.k === 'num') {
          this.i++
          key = k.v
        } else if (k.k === 'var') {
          this.i++
          entries.push({ key: k.v, value: { k: 'var', name: k.v } })
          if (this.is(',')) this.i++
          continue
        } else if (k.k === 'str') {
          this.i++
          key = k.parts!.length === 1 && typeof k.parts![0] === 'string' ? (k.parts![0] as string) : { k: 'str', parts: k.parts! }
        } else if (this.is('(')) {
          this.i++
          key = this.pipe()
          this.eat(')')
        } else throw new JqError(`syntax error, unexpected '${k.v}'`)
        if (this.is(':')) {
          this.i++
          entries.push({ key, value: this.alt() })
        } else entries.push({ key })
        if (this.is(',')) this.i++
        else break
      }
      this.eat('}')
      return { k: 'obj', entries }
    }
    if (t.k === 'ident') {
      this.i++
      if (t.v === 'true' || t.v === 'false') return { k: 'lit', v: t.v === 'true' }
      if (t.v === 'null') return { k: 'lit', v: null }
      if (t.v === 'if') {
        const cond = this.pipe()
        this.eat('then')
        const then = this.pipe()
        let els: Node | undefined
        if (this.is('elif')) {
          this.t[this.i] = { k: 'ident', v: 'if' }
          els = this.primary()
          return { k: 'if', cond, then, els }
        }
        if (this.is('else')) {
          this.i++
          els = this.pipe()
        }
        this.eat('end')
        return { k: 'if', cond, then, els }
      }
      if (t.v === 'try') return { k: 'try', e: this.post() }
      const args: Node[] = []
      if (this.is('(')) {
        this.i++
        args.push(this.pipe())
        while (this.is(';')) {
          this.i++
          args.push(this.pipe())
        }
        this.eat(')')
      }
      return { k: 'call', name: t.v, args }
    }
    throw new JqError(`syntax error, unexpected ${t.k === 'eof' ? 'end of file' : `'${t.v}'`}`)
  }
}

function parse(src: string): Node {
  const p = new Parser(lex(src))
  const n = p.pipe()
  if (p.peek().k !== 'eof') throw new JqError(`syntax error, unexpected '${p.peek().v}'`)
  return n
}

const typeOf = (v: J) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v)
const truthy = (v: J) => v !== null && v !== false

function cmp(a: J, b: J): number {
  const order = ['null', 'boolean', 'number', 'string', 'array', 'object']
  const ta = order.indexOf(typeOf(a))
  const tb = order.indexOf(typeOf(b))
  if (ta !== tb) return ta - tb
  if (typeof a === 'number' || typeof a === 'boolean') return Number(a) - Number(b)
  if (typeof a === 'string') return a < (b as string) ? -1 : a > (b as string) ? 1 : 0
  return JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0
}

function show(v: J): string {
  return typeOf(v) === 'string' ? JSON.stringify(v) : JSON.stringify(v)
}

function evalNode(n: Node, input: J, env: Map<string, J>): J[] {
  const one = (e: Node, x: J = input) => evalNode(e, x, env)
  switch (n.k) {
    case 'id':
      return [input]
    case 'lit':
      return [n.v]
    case 'var':
      if (!env.has(n.name)) throw new JqError(`$${n.name} is not defined`)
      return [env.get(n.name)]
    case 'recurse': {
      const out: J[] = []
      const walk = (v: J) => {
        out.push(v)
        if (Array.isArray(v)) v.forEach(walk)
        else if (v && typeof v === 'object') Object.values(v).forEach(walk)
      }
      walk(input)
      return out
    }
    case 'str': {
      let outs: string[] = ['']
      for (const p of n.parts) {
        if (typeof p === 'string') outs = outs.map((o) => o + p)
        else {
          const vals = one(p)
          outs = outs.flatMap((o) => vals.map((v) => o + (typeof v === 'string' ? v : JSON.stringify(v))))
        }
      }
      return outs
    }
    case 'field':
      return one(n.of).flatMap((v) => {
        if (v === null) return [null]
        if (typeOf(v) !== 'object') {
          if (n.opt) return []
          throw new JqError(`Cannot index ${typeOf(v)} with "${n.name}"`)
        }
        const r = (v as Record<string, J>)[n.name]
        return [r === undefined ? null : r]
      })
    case 'index':
      return one(n.of).flatMap((v) =>
        one(n.idx).flatMap((i) => {
          if (v === null) return [null]
          if (Array.isArray(v) && typeof i === 'number') {
            const r = v[i < 0 ? v.length + i : i]
            return [r === undefined ? null : r]
          }
          if (typeOf(v) === 'object' && typeof i === 'string') {
            const r = (v as Record<string, J>)[i]
            return [r === undefined ? null : r]
          }
          if (n.opt) return []
          throw new JqError(`Cannot index ${typeOf(v)} with ${typeOf(i)}`)
        }),
      )
    case 'slice':
      return one(n.of).map((v) => {
        const from = n.from ? (one(n.from)[0] as number) : undefined
        const to = n.to ? (one(n.to)[0] as number) : undefined
        if (typeof v === 'string' || Array.isArray(v)) return v.slice(from ?? 0, to)
        return null
      })
    case 'iter':
      return one(n.of).flatMap((v) => {
        if (Array.isArray(v)) return v
        if (v && typeof v === 'object') return Object.values(v)
        if (n.opt) return []
        throw new JqError(`Cannot iterate over ${typeOf(v)} (${show(v)})`)
      })
    case 'try':
      try {
        return one(n.e)
      } catch {
        return []
      }
    case 'pipe':
      return one(n.l).flatMap((v) => evalNode(n.r, v, env))
    case 'comma':
      return [...one(n.l), ...one(n.r)]
    case 'as':
      return one(n.src).flatMap((v) => evalNode(n.body, input, new Map([...env, [n.name, v]])))
    case 'neg':
      return one(n.e).map((v) => -(v as number))
    case 'arr':
      return [n.e ? one(n.e) : []]
    case 'obj': {
      let outs: Record<string, J>[] = [{}]
      for (const e of n.entries) {
        const keys = typeof e.key === 'string' ? [e.key] : one(e.key).map(String)
        const vals = e.value ? one(e.value) : typeof e.key === 'string' ? [(input as Record<string, J>)?.[e.key] ?? null] : [null]
        outs = outs.flatMap((o) => keys.flatMap((k) => vals.map((v) => ({ ...o, [k]: v }))))
      }
      return outs
    }
    case 'if':
      return one(n.cond).flatMap((c) => (truthy(c) ? one(n.then) : n.els ? one(n.els) : [input]))
    case 'bin': {
      if (n.op === 'and' || n.op === 'or') return one(n.l).flatMap((a) => (n.op === 'and' && !truthy(a) ? [false] : n.op === 'or' && truthy(a) ? [true] : one(n.r).map((b) => truthy(b))))
      if (n.op === '//') {
        const l = (() => {
          try {
            return one(n.l).filter(truthy)
          } catch {
            return []
          }
        })()
        return l.length ? l : one(n.r)
      }
      const out: J[] = []
      for (const b of one(n.r))
        for (const a of one(n.l)) {
          switch (n.op) {
            case '==':
              out.push(cmp(a, b) === 0)
              break
            case '!=':
              out.push(cmp(a, b) !== 0)
              break
            case '<':
              out.push(cmp(a, b) < 0)
              break
            case '<=':
              out.push(cmp(a, b) <= 0)
              break
            case '>':
              out.push(cmp(a, b) > 0)
              break
            case '>=':
              out.push(cmp(a, b) >= 0)
              break
            case '+':
              if (a === null) out.push(b)
              else if (b === null) out.push(a)
              else if (typeof a === 'number' && typeof b === 'number') out.push(a + b)
              else if (typeof a === 'string' && typeof b === 'string') out.push(a + b)
              else if (Array.isArray(a) && Array.isArray(b)) out.push([...a, ...b])
              else if (typeOf(a) === 'object' && typeOf(b) === 'object') out.push({ ...(a as object), ...(b as object) })
              else throw new JqError(`${typeOf(a)} (${show(a)}) and ${typeOf(b)} (${show(b)}) cannot be added`)
              break
            case '-':
              if (typeof a === 'number' && typeof b === 'number') out.push(a - b)
              else if (Array.isArray(a) && Array.isArray(b)) out.push(a.filter((x) => !b.some((y) => cmp(x, y) === 0)))
              else throw new JqError(`${typeOf(a)} (${show(a)}) and ${typeOf(b)} (${show(b)}) cannot be subtracted`)
              break
            case '*':
              out.push((a as number) * (b as number))
              break
            case '/':
              if (typeof a === 'string' && typeof b === 'string') out.push(a.split(b))
              else {
                if (b === 0) throw new JqError(`${typeOf(a)} (${show(a)}) and number (0) cannot be divided because the divisor is zero`)
                out.push((a as number) / (b as number))
              }
              break
            case '%':
              out.push((a as number) % (b as number))
              break
          }
        }
      return out
    }
    case 'call':
      return call(n, input, env)
  }
}

function call(n: Extract<Node, { k: 'call' }>, input: J, env: Map<string, J>): J[] {
  const a = (i: number, x: J = input) => evalNode(n.args[i], x, env)
  const arr = () => {
    if (!Array.isArray(input)) throw new JqError(`Cannot iterate over ${typeOf(input)}`)
    return input
  }
  switch (n.name) {
    case 'empty':
      return []
    case 'not':
      return [!truthy(input)]
    case 'length':
      return [input === null ? 0 : typeof input === 'string' || Array.isArray(input) ? input.length : typeof input === 'object' ? Object.keys(input as object).length : Math.abs(input as number)]
    case 'keys':
      return [Array.isArray(input) ? input.map((_, i) => i) : Object.keys(input as object).sort()]
    case 'values':
      return input === null ? [] : [input]
    case 'has':
      return a(0).map((k) => (Array.isArray(input) ? (k as number) < input.length : Object.prototype.hasOwnProperty.call(input, k as string)))
    case 'type':
      return [typeOf(input)]
    case 'select':
      return a(0).some(truthy) ? [input] : []
    case 'map':
      return [arr().flatMap((x) => a(0, x))]
    case 'map_values':
      return [Object.fromEntries(Object.entries(input as object).map(([k, v]) => [k, a(0, v)[0]]))]
    case 'to_entries':
      return [Object.entries(input as object).map(([key, value]) => ({ key, value }))]
    case 'from_entries':
      return [Object.fromEntries(arr().map((e) => { const o = e as Record<string, J>; return [String(o.key ?? o.name ?? o.k), o.value ?? o.v] }))]
    case 'with_entries':
      return [Object.fromEntries(Object.entries(input as object).flatMap(([key, value]) => a(0, { key, value }).map((e) => { const o = e as Record<string, J>; return [String(o.key), o.value] })))]
    case 'add':
      return [arr().reduce((s: J, x) => (s === null ? x : evalNode({ k: 'bin', op: '+', l: { k: 'lit', v: s }, r: { k: 'lit', v: x } }, null, env)[0]), null)]
    case 'sort':
      return [[...arr()].sort(cmp)]
    case 'sort_by':
      return [[...arr()].sort((x, y) => cmp(a(0, x)[0], a(0, y)[0]))]
    case 'group_by': {
      const groups = new Map<string, J[]>()
      for (const x of [...arr()].sort((p, q) => cmp(a(0, p)[0], a(0, q)[0]))) {
        const k = JSON.stringify(a(0, x)[0])
        if (!groups.has(k)) groups.set(k, [])
        groups.get(k)!.push(x)
      }
      return [[...groups.values()]]
    }
    case 'unique':
      return [[...new Map(arr().map((x) => [JSON.stringify(x), x])).values()].sort(cmp)]
    case 'reverse':
      return [typeof input === 'string' ? [...input].reverse().join('') : [...arr()].reverse()]
    case 'min':
      return [arr().length ? [...arr()].sort(cmp)[0] : null]
    case 'max':
      return [arr().length ? [...arr()].sort(cmp).at(-1) : null]
    case 'min_by':
    case 'max_by': {
      const s = [...arr()].sort((x, y) => cmp(a(0, x)[0], a(0, y)[0]))
      return [s.length ? (n.name === 'min_by' ? s[0] : s.at(-1)) : null]
    }
    case 'first':
      return n.args.length ? a(0).slice(0, 1) : [arr()[0] ?? null]
    case 'last':
      return n.args.length ? a(0).slice(-1) : [arr().at(-1) ?? null]
    case 'limit':
      return a(1).slice(0, a(0)[0] as number)
    case 'tostring':
      return [typeof input === 'string' ? input : JSON.stringify(input)]
    case 'tonumber':
      return [typeof input === 'number' ? input : Number(input)]
    case 'ascii_downcase':
      return [String(input).toLowerCase()]
    case 'ascii_upcase':
      return [String(input).toUpperCase()]
    case 'test':
      return a(0).map((re) => new RegExp(String(re)).test(String(input)))
    case 'startswith':
      return a(0).map((s) => String(input).startsWith(String(s)))
    case 'endswith':
      return a(0).map((s) => String(input).endsWith(String(s)))
    case 'contains':
      return a(0).map((b) => (typeof input === 'string' ? input.includes(String(b)) : JSON.stringify(input).includes(JSON.stringify(b).replace(/^\{|\}$/g, ''))))
    case 'split':
      return a(0).map((s) => String(input).split(String(s)))
    case 'join':
      return a(0).map((s) => arr().map((x) => (x === null ? '' : typeof x === 'string' ? x : JSON.stringify(x))).join(String(s)))
    case 'ltrimstr':
      return a(0).map((s) => (String(input).startsWith(String(s)) ? String(input).slice(String(s).length) : input))
    case 'rtrimstr':
      return a(0).map((s) => (String(input).endsWith(String(s)) ? String(input).slice(0, -String(s).length) : input))
    case 'floor':
      return [Math.floor(input as number)]
    case 'ceil':
      return [Math.ceil(input as number)]
    case 'round':
      return [Math.round(input as number)]
    case 'tojson':
      return [JSON.stringify(input)]
    case 'fromjson':
      return [JSON.parse(String(input))]
    case 'todate':
    case 'todateiso8601':
      return [new Date((input as number) * 1000).toISOString().replace(/\.\d+Z$/, 'Z')]
    case 'now':
      return [Date.now() / 1000]
    case 'any':
      return [arr().some(truthy)]
    case 'all':
      return [arr().every(truthy)]
    case 'range':
      return Array.from({ length: Math.max(0, a(0)[0] as number) }, (_, i) => i)
    case 'error':
      throw new JqError(n.args.length ? String(a(0)[0]) : String(input))
  }
  throw new JqError(`${n.name}/${n.args.length} is not defined`)
}

function pretty(v: J, compact: boolean, ind = ''): string {
  if (compact) return JSON.stringify(v)
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => `${ind}  ${pretty(x, false, ind + '  ')}`).join(',\n')}\n${ind}]` : '[]'
  if (v && typeof v === 'object') {
    const e = Object.entries(v)
    return e.length ? `{\n${e.map(([k, x]) => `${ind}  ${JSON.stringify(k)}: ${pretty(x, false, ind + '  ')}`).join(',\n')}\n${ind}}` : '{}'
  }
  return JSON.stringify(v)
}

/** Varios documentos JSON seguidos (como los acepta jq). */
function parseInputs(text: string): J[] {
  const out: J[] = []
  let i = 0
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++
    if (i >= text.length) break
    let depth = 0
    let inStr = false
    let j = i
    for (; j < text.length; j++) {
      const c = text[j]
      if (inStr) {
        if (c === '\\') j++
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') inStr = true
      else if (c === '{' || c === '[') depth++
      else if (c === '}' || c === ']') depth--
      if (depth === 0 && (c === '}' || c === ']' || (c === '"' && !inStr) || /\s/.test(text[j + 1] ?? ' '))) {
        j++
        break
      }
    }
    const chunk = text.slice(i, j).trim()
    try {
      out.push(JSON.parse(chunk))
    } catch {
      throw new JqError(`parse error: Invalid numeric literal at line 1, column ${chunk.length + 1}`)
    }
    i = j
  }
  return out
}

register('jq', {
  usage: "jq [-r] [-c] [-e] [-n] 'FILTRO' [ARCHIVO...]",
  path: '/usr/bin',
  run(ctx) {
    const flags = new Set<string>()
    const rest: string[] = []
    for (const a of ctx.args) {
      if (/^-[a-zA-Z]+$/.test(a)) for (const f of a.slice(1)) flags.add(f)
      else if (a === '--raw-output') flags.add('r')
      else if (a === '--compact-output') flags.add('c')
      else rest.push(a)
    }
    const [filter = '.', ...files] = rest
    let node: Node
    try {
      node = parse(filter)
    } catch (e) {
      ctx.err(`jq: error: ${(e as Error).message}:\n${filter}\njq: 1 compile error\n`)
      return 3
    }
    let text = ''
    if (flags.has('n')) text = 'null'
    else if (files.length) {
      for (const f of files) {
        try {
          text += ctx.sys.vfs.readFile(f.startsWith('/') ? f : `${ctx.sh.cwd}/${f}`, ctx.sh.cred) + '\n'
        } catch {
          ctx.err(`jq: error: Could not open ${f}: No such file or directory\n`)
          return 2
        }
      }
    } else text = ctx.stdin.readAll()
    let inputs: J[]
    try {
      inputs = parseInputs(text)
    } catch (e) {
      ctx.err(`jq: error (at <stdin>:1): ${(e as Error).message}\n`)
      return 2
    }
    let last: J = null
    let any = false
    for (const input of inputs) {
      let outs: J[]
      try {
        outs = evalNode(node, input, new Map())
      } catch (e) {
        ctx.err(`jq: error (at <stdin>:${text.split('\n').length - 1}): ${(e as Error).message}\n`)
        return 5
      }
      for (const o of outs) {
        any = true
        last = o
        ctx.out((flags.has('r') && typeof o === 'string' ? o : pretty(o, flags.has('c'))) + '\n')
      }
    }
    if (flags.has('e')) return !any ? 4 : truthy(last) ? 0 : 1
    return 0
  },
})
