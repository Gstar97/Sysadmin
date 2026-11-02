/**
 * Aritmética de bash: $(( )), (( )), let y los índices de arreglos. Misma precedencia que bash,
 * con asignaciones (= += -= ...), ++ y --, ternario y coma.
 */

export class ArithError extends Error {}

export interface ArithEnv {
  get(name: string, index?: string): string | undefined
  set(name: string, value: string, index?: string): void
}

/** Número de bash: decimal, octal (017), hexadecimal (0x1F) o en cualquier base (2#1010, 16#ff). */
export function parseBashNumber(t: string): number {
  const bad = () => new ArithError(`bash: ${t}: value too great for base (error token is "${t}")`)
  if (/^0[xX]/.test(t)) {
    if (!/^0[xX][0-9a-fA-F]+$/.test(t)) throw bad()
    return parseInt(t.slice(2), 16)
  }
  const m = /^(\d+)#([0-9a-zA-Z@_]+)$/.exec(t)
  if (m) {
    const base = Number(m[1])
    if (base < 2 || base > 64) throw new ArithError(`bash: ${t}: invalid arithmetic base (error token is "${t}")`)
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

const OPS = ['<<=', '>>=', '**', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=']

type Tok = { k: 'num'; v: number } | { k: 'id'; name: string; index?: string } | { k: 'op'; v: string }

function lex(expr: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < expr.length) {
    const c = expr[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    const num = /^(0[xX][0-9a-zA-Z]+|\d+#[0-9a-zA-Z@_]+|\d+)/.exec(expr.slice(i))
    if (num) {
      out.push({ k: 'num', v: parseBashNumber(num[1]) })
      i += num[1].length
      continue
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(expr.slice(i))
    if (id) {
      i += id[0].length
      let index: string | undefined
      if (expr[i] === '[') {
        let depth = 1
        let j = i + 1
        while (j < expr.length && depth) {
          if (expr[j] === '[') depth++
          if (expr[j] === ']') depth--
          j++
        }
        index = expr.slice(i + 1, j - 1)
        i = j
      }
      out.push({ k: 'id', name: id[0], index })
      continue
    }
    const op = OPS.find((o) => expr.startsWith(o, i)) ?? (/[-+*/%()<>!~&|^?:=,]/.test(c) ? c : undefined)
    if (!op) throw new ArithError(`bash: ${expr}: syntax error: invalid arithmetic operator (error token is "${expr.slice(i)}")`)
    out.push({ k: 'op', v: op })
    i += op.length
  }
  return out
}

export function arith(expr: string, env: ArithEnv, depth = 0): number {
  if (!expr.trim()) return 0
  if (depth > 20) throw new ArithError(`bash: ${expr}: expression recursion level exceeded`)
  const toks = lex(expr)
  let pos = 0
  const peek = () => toks[pos]
  const isOp = (v: string) => {
    const t = toks[pos]
    return t?.k === 'op' && t.v === v
  }
  const err = () => {
    const t = toks[pos]
    const shown = t ? (t.k === 'op' ? t.v : t.k === 'num' ? String(t.v) : t.name) : ''
    return new ArithError(`bash: ${expr.trim()}: syntax error: ${t ? 'invalid arithmetic operator' : 'operand expected'} (error token is "${shown}")`)
  }
  const idx = (t: Extract<Tok, { k: 'id' }>) => t.index
  const valueOf = (t: Extract<Tok, { k: 'id' }>): number => {
    const v = env.get(t.name, idx(t))
    if (v === undefined || v.trim() === '') return 0
    const s = v.trim()
    if (/^-?\d+$/.test(s)) return parseInt(s, 10)
    if (/^-?(0[xX][0-9a-fA-F]+|\d+#\w+)$/.test(s)) return s.startsWith('-') ? -parseBashNumber(s.slice(1)) : parseBashNumber(s)
    return arith(s, env, depth + 1)
  }
  const store = (t: Extract<Tok, { k: 'id' }>, v: number) => {
    env.set(t.name, String(v), idx(t))
    return v
  }

  // Precedencia de menor a mayor.
  const comma = (): number => {
    let v = assign()
    while (isOp(',')) {
      pos++
      v = assign()
    }
    return v
  }
  const assign = (): number => {
    const t = peek()
    const n = toks[pos + 1]
    if (t?.k === 'id' && n?.k === 'op' && ['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '|=', '^='].includes(n.v)) {
      pos += 2
      const r = assign()
      const cur = n.v === '=' ? 0 : valueOf(t)
      const res = n.v === '=' ? r : apply(n.v.slice(0, -1), cur, r)
      return store(t, res)
    }
    return ternary()
  }
  const ternary = (): number => {
    const c = or()
    if (isOp('?')) {
      pos++
      const a = assign()
      if (!isOp(':')) throw err()
      pos++
      const b = assign()
      return c ? a : b
    }
    return c
  }
  const bin = (sub: () => number, ops: string[]) => (): number => {
    let v = sub()
    while (peek()?.k === 'op' && ops.includes((peek() as { v: string }).v)) {
      const op = (toks[pos++] as { v: string }).v
      v = apply(op, v, sub())
    }
    return v
  }
  const apply = (op: string, a: number, b: number): number => {
    switch (op) {
      case '+':
        return a + b
      case '-':
        return a - b
      case '*':
        return a * b
      case '/':
      case '%':
        if (b === 0) throw new ArithError(`bash: ${expr.trim()}: division by 0 (error token is "${expr.trim().split(/[/%]/).pop()?.trim()}")`)
        return op === '/' ? Math.trunc(a / b) : a % b
      case '**':
        return a ** b
      case '<<':
        return a << b
      case '>>':
        return a >> b
      case '<':
        return Number(a < b)
      case '>':
        return Number(a > b)
      case '<=':
        return Number(a <= b)
      case '>=':
        return Number(a >= b)
      case '==':
        return Number(a === b)
      case '!=':
        return Number(a !== b)
      case '&':
        return a & b
      case '|':
        return a | b
      case '^':
        return a ^ b
      case '&&':
        return Number(!!a && !!b)
      case '||':
        return Number(!!a || !!b)
    }
    throw err()
  }
  const unary = (): number => {
    const t = peek()
    if (t?.k === 'op') {
      if (t.v === '++' || t.v === '--') {
        pos++
        const id = peek()
        if (id?.k !== 'id') throw err()
        pos++
        return store(id, valueOf(id) + (t.v === '++' ? 1 : -1))
      }
      if (t.v === '!') {
        pos++
        return Number(!unary())
      }
      if (t.v === '~') {
        pos++
        return ~unary()
      }
      if (t.v === '-') {
        pos++
        return -unary()
      }
      if (t.v === '+') {
        pos++
        return unary()
      }
    }
    return power()
  }
  const power = (): number => {
    const b = postfix()
    if (isOp('**')) {
      pos++
      return b ** unary()
    }
    return b
  }
  const postfix = (): number => {
    const t = peek()
    if (t?.k === 'id' && toks[pos + 1]?.k === 'op' && ['++', '--'].includes((toks[pos + 1] as { v: string }).v)) {
      pos += 2
      const old = valueOf(t)
      store(t, old + ((toks[pos - 1] as { v: string }).v === '++' ? 1 : -1))
      return old
    }
    return primary()
  }
  const primary = (): number => {
    const t = toks[pos++]
    if (!t) throw err()
    if (t.k === 'num') return t.v
    if (t.k === 'id') return valueOf(t)
    if (t.v === '(') {
      const v = comma()
      if (!isOp(')')) throw err()
      pos++
      return v
    }
    pos--
    throw err()
  }
  const mul = bin(unary, ['*', '/', '%'])
  const add = bin(mul, ['+', '-'])
  const shift = bin(add, ['<<', '>>'])
  const rel = bin(shift, ['<', '>', '<=', '>='])
  const eq = bin(rel, ['==', '!='])
  const band = bin(eq, ['&'])
  const bxor = bin(band, ['^'])
  const bor = bin(bxor, ['|'])
  const and = bin(bor, ['&&'])
  const or = bin(and, ['||'])
  const v = comma()
  if (pos < toks.length) throw err()
  return v
}
