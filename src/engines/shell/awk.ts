/**
 * Un awk chico pero de verdad: patrones y acciones, BEGIN/END, campos, arreglos asociativos,
 * if/while/for/for-in, printf/sprintf, funciones de texto (length, substr, index, split, sub,
 * gsub, match, tolower, toupper) y redirección de print a archivos.
 */

export class AwkError extends Error {}

type Val = string | number

type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 're'; v: string }
  | { t: 'id'; v: string }
  | { t: 'func'; v: string }
  | { t: 'op'; v: string }
  | { t: 'nl' }
  | { t: 'eof' }

const KEYWORDS = new Set(['BEGIN', 'END', 'if', 'else', 'while', 'for', 'do', 'in', 'print', 'printf', 'next', 'exit', 'break', 'continue', 'delete', 'getline', 'return', 'function'])
const BUILTIN_FUNCS = new Set(['length', 'substr', 'index', 'split', 'sub', 'gsub', 'match', 'sprintf', 'tolower', 'toupper', 'int', 'sqrt', 'exp', 'log', 'sin', 'cos', 'atan2', 'rand', 'srand', 'system'])
const OPS = ['+=', '-=', '*=', '/=', '%=', '^=', '**', '==', '!=', '<=', '>=', '&&', '||', '++', '--', '!~', '>>', '{', '}', '(', ')', '[', ']', ';', ',', '+', '-', '*', '/', '%', '^', '!', '>', '<', '|', '?', ':', '~', '$', '=']

function lex(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  const regexAllowed = () => {
    const last = out[out.length - 1]
    if (!last || last.t === 'nl') return true
    if (last.t === 'op') return !([')', ']', '$'].includes(last.v) || last.v === '++' || last.v === '--')
    return false
  }
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\r') {
      i++
      continue
    }
    if (c === '\\' && src[i + 1] === '\n') {
      i += 2
      continue
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '\n') {
      out.push({ t: 'nl' })
      i++
      continue
    }
    if (c === '"') {
      let s = ''
      i++
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') {
          const e = src[i + 1]
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e === '"' ? '"' : e === '\\' ? '\\' : e === '/' ? '/' : '\\' + e
          i += 2
          continue
        }
        s += src[i++]
      }
      i++
      out.push({ t: 'str', v: s })
      continue
    }
    if (c === '/' && regexAllowed()) {
      let s = ''
      i++
      while (i < src.length && src[i] !== '/') {
        if (src[i] === '\\' && src[i + 1] === '/') {
          s += '/'
          i += 2
          continue
        }
        if (src[i] === '\\') {
          s += src[i] + (src[i + 1] ?? '')
          i += 2
          continue
        }
        s += src[i++]
      }
      i++
      out.push({ t: 're', v: s })
      continue
    }
    const num = /^(\d+\.?\d*([eE][-+]?\d+)?|\.\d+)/.exec(src.slice(i))
    if (num) {
      out.push({ t: 'num', v: Number(num[1]) })
      i += num[1].length
      continue
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))
    if (id) {
      i += id[0].length
      const name = id[0]
      if (!KEYWORDS.has(name) && src[i] === '(') out.push({ t: 'func', v: name })
      else out.push({ t: 'id', v: name })
      continue
    }
    const op = OPS.find((o) => src.startsWith(o, i))
    if (!op) throw new AwkError(`awk: cmd. line:1: ${src}\nawk: cmd. line:1: ${' '.repeat(i)}^ syntax error`)
    out.push({ t: 'op', v: op })
    i += op.length
  }
  out.push({ t: 'eof' })
  return out
}

type Expr =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 're'; v: string }
  | { k: 'var'; name: string }
  | { k: 'field'; e: Expr }
  | { k: 'idx'; name: string; keys: Expr[] }
  | { k: 'assign'; op: string; target: Expr; value: Expr }
  | { k: 'cond'; c: Expr; a: Expr; b: Expr }
  | { k: 'bin'; op: string; a: Expr; b: Expr }
  | { k: 'un'; op: string; e: Expr }
  | { k: 'incdec'; op: '++' | '--'; pre: boolean; target: Expr }
  | { k: 'in'; keys: Expr[]; name: string }
  | { k: 'match'; neg: boolean; a: Expr; re: Expr }
  | { k: 'call'; name: string; args: Expr[] }
  | { k: 'group'; e: Expr }

type Stmt =
  | { k: 'print'; args: Expr[]; redir?: { op: string; target: Expr } }
  | { k: 'printf'; args: Expr[]; redir?: { op: string; target: Expr } }
  | { k: 'expr'; e: Expr }
  | { k: 'if'; c: Expr; a: Stmt; b?: Stmt }
  | { k: 'while'; c: Expr; body: Stmt }
  | { k: 'do'; c: Expr; body: Stmt }
  | { k: 'for'; init?: Expr; c?: Expr; step?: Expr; body: Stmt }
  | { k: 'forin'; v: string; arr: string; body: Stmt }
  | { k: 'block'; body: Stmt[] }
  | { k: 'next' }
  | { k: 'exit'; e?: Expr }
  | { k: 'break' }
  | { k: 'continue' }
  | { k: 'delete'; name: string; keys?: Expr[] }

interface Rule {
  kind: 'begin' | 'end' | 'main'
  pattern?: Expr
  range?: [Expr, Expr]
  action?: Stmt
}

function parse(src: string): Rule[] {
  const toks = lex(src)
  let p = 0
  const peek = () => toks[p]
  const isOp = (v: string) => {
    const t = toks[p]
    return t.t === 'op' && t.v === v
  }
  const isId = (v: string) => {
    const t = toks[p]
    return t.t === 'id' && t.v === v
  }
  const fail = (): never => {
    const t = toks[p]
    const shown = t.t === 'eof' ? 'end of file' : t.t === 'nl' ? 'newline' : 'v' in t ? String(t.v) : ''
    throw new AwkError(`awk: syntax error at source line 1\n context is\n\t>>> ${shown} <<<`)
  }
  const expectOp = (v: string) => {
    if (!isOp(v)) fail()
    p++
  }
  const skipNl = () => {
    while (toks[p].t === 'nl' || isOp(';')) p++
  }
  const skipNlOnly = () => {
    while (toks[p].t === 'nl') p++
  }

  // Expresiones (de menor a mayor precedencia)
  const expr = (noGt = false, noIn = false): Expr => ternary(noGt, noIn)
  const ternary = (noGt: boolean, noIn: boolean): Expr => {
    const c = or(noGt, noIn)
    if (isOp('?')) {
      p++
      skipNlOnly()
      const a = ternary(noGt, noIn)
      skipNlOnly()
      expectOp(':')
      skipNlOnly()
      const b = ternary(noGt, noIn)
      return { k: 'cond', c, a, b }
    }
    if (toks[p].t === 'op' && ['=', '+=', '-=', '*=', '/=', '%=', '^='].includes((toks[p] as { v: string }).v) && (c.k === 'var' || c.k === 'field' || c.k === 'idx')) {
      const op = (toks[p++] as { v: string }).v
      skipNlOnly()
      return { k: 'assign', op, target: c, value: ternary(noGt, noIn) }
    }
    return c
  }
  const or = (noGt: boolean, noIn: boolean): Expr => {
    let a = and(noGt, noIn)
    while (isOp('||')) {
      p++
      skipNlOnly()
      a = { k: 'bin', op: '||', a, b: and(noGt, noIn) }
    }
    return a
  }
  const and = (noGt: boolean, noIn: boolean): Expr => {
    let a = inExpr(noGt, noIn)
    while (isOp('&&')) {
      p++
      skipNlOnly()
      a = { k: 'bin', op: '&&', a, b: inExpr(noGt, noIn) }
    }
    return a
  }
  const inExpr = (noGt: boolean, noIn: boolean): Expr => {
    let a = matchE(noGt)
    while (!noIn && isId('in')) {
      p++
      const name = (toks[p++] as { v: string }).v
      a = { k: 'in', keys: [a], name }
    }
    return a
  }
  const matchE = (noGt: boolean): Expr => {
    let a = rel(noGt)
    while (isOp('~') || isOp('!~')) {
      const neg = (toks[p++] as { v: string }).v === '!~'
      a = { k: 'match', neg, a, re: rel(noGt) }
    }
    return a
  }
  const rel = (noGt: boolean): Expr => {
    const a = concat(noGt)
    const t = toks[p]
    if (t.t === 'op' && ['<', '<=', '==', '!=', '>=', ...(noGt ? [] : ['>'])].includes(t.v)) {
      p++
      return { k: 'bin', op: t.v, a, b: concat(noGt) }
    }
    return a
  }
  const startsPrimary = () => {
    const t = toks[p]
    if (t.t === 'num' || t.t === 'str' || t.t === 're' || t.t === 'func') return true
    if (t.t === 'id') return !KEYWORDS.has(t.v) || t.v === 'getline'
    if (t.t === 'op') return ['$', '(', '!', '-', '+', '++', '--'].includes(t.v)
    return false
  }
  const concat = (noGt: boolean): Expr => {
    let a = add()
    while (startsPrimary() && !isOp('-') && !isOp('+') && !isOp('!')) a = { k: 'bin', op: 'concat', a, b: add() }
    void noGt
    return a
  }
  const add = (): Expr => {
    let a = mul()
    while (isOp('+') || isOp('-')) {
      const op = (toks[p++] as { v: string }).v
      a = { k: 'bin', op, a, b: mul() }
    }
    return a
  }
  const mul = (): Expr => {
    let a = unary()
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = (toks[p++] as { v: string }).v
      a = { k: 'bin', op, a, b: unary() }
    }
    return a
  }
  const unary = (): Expr => {
    if (isOp('!')) {
      p++
      return { k: 'un', op: '!', e: unary() }
    }
    if (isOp('-')) {
      p++
      return { k: 'un', op: '-', e: unary() }
    }
    if (isOp('+')) {
      p++
      return { k: 'un', op: '+', e: unary() }
    }
    return power()
  }
  const power = (): Expr => {
    const a = postfix()
    if (isOp('^') || isOp('**')) {
      p++
      return { k: 'bin', op: '^', a, b: unary() }
    }
    return a
  }
  const postfix = (): Expr => {
    if (isOp('++') || isOp('--')) {
      const op = (toks[p++] as { v: string }).v as '++' | '--'
      return { k: 'incdec', op, pre: true, target: primary() }
    }
    const e = primary()
    if ((isOp('++') || isOp('--')) && (e.k === 'var' || e.k === 'field' || e.k === 'idx')) {
      const op = (toks[p++] as { v: string }).v as '++' | '--'
      return { k: 'incdec', op, pre: false, target: e }
    }
    return e
  }
  const primary = (): Expr => {
    const t = toks[p++]
    if (t.t === 'num') return { k: 'num', v: t.v }
    if (t.t === 'str') return { k: 'str', v: t.v }
    if (t.t === 're') return { k: 're', v: t.v }
    if (t.t === 'op' && t.v === '$') {
      if (isOp('++') || isOp('--')) return { k: 'field', e: postfix() }
      return { k: 'field', e: primaryNoPostfix() }
    }
    if (t.t === 'op' && t.v === '(') {
      const first = expr(false, false)
      if (isOp(',')) {
        // (a, b) in arr
        const keys = [first]
        while (isOp(',')) {
          p++
          keys.push(expr())
        }
        expectOp(')')
        if (!isId('in')) fail()
        p++
        const name = (toks[p++] as { v: string }).v
        return { k: 'in', keys, name }
      }
      expectOp(')')
      return { k: 'group', e: first }
    }
    if (t.t === 'func') {
      expectOp('(')
      const args: Expr[] = []
      skipNlOnly()
      if (!isOp(')')) {
        args.push(expr())
        while (isOp(',')) {
          p++
          skipNlOnly()
          args.push(expr())
        }
      }
      expectOp(')')
      return { k: 'call', name: t.v, args }
    }
    if (t.t === 'id') {
      if (t.v === 'length' && !isOp('(')) return { k: 'call', name: 'length', args: [] }
      if (isOp('[')) {
        p++
        const keys = [expr()]
        while (isOp(',')) {
          p++
          keys.push(expr())
        }
        expectOp(']')
        return { k: 'idx', name: t.v, keys }
      }
      return { k: 'var', name: t.v }
    }
    p--
    return fail()
  }
  const primaryNoPostfix = (): Expr => primary()

  const simpleOrBlock = (): Stmt => {
    skipNlOnly()
    if (isOp('{')) return block()
    const s = statement()
    return s
  }
  const block = (): Stmt => {
    expectOp('{')
    const body: Stmt[] = []
    skipNl()
    while (!isOp('}')) {
      if (peek().t === 'eof') fail()
      body.push(statement())
      skipNl()
    }
    p++
    return { k: 'block', body }
  }
  const endStmt = () => {
    if (isOp(';') || toks[p].t === 'nl') {
      p++
      return
    }
    if (isOp('}') || toks[p].t === 'eof') return
    fail()
  }
  const printArgs = (): { args: Expr[]; redir?: { op: string; target: Expr } } => {
    const args: Expr[] = []
    const stop = () => isOp(';') || isOp('}') || toks[p].t === 'nl' || toks[p].t === 'eof' || isOp('>') || isOp('>>') || isOp('|')
    if (!stop()) {
      if (isOp('(')) {
        // print (a, b) o print (a)(b)
        const save = p
        p++
        const inner = [expr(false)]
        while (isOp(',')) {
          p++
          inner.push(expr(false))
        }
        if (isOp(')') && (stop() || toks[p + 1].t === 'nl' || [';', '}', '>', '>>', '|'].includes((toks[p + 1] as { v?: string }).v ?? '') || toks[p + 1].t === 'eof')) {
          p++
          args.push(...inner)
        } else {
          p = save
          args.push(expr(true))
        }
      } else args.push(expr(true))
      while (isOp(',')) {
        p++
        skipNlOnly()
        args.push(expr(true))
      }
    }
    let redir: { op: string; target: Expr } | undefined
    if (isOp('>') || isOp('>>') || isOp('|')) {
      const op = (toks[p++] as { v: string }).v
      redir = { op, target: concat(true) }
    }
    return { args, redir }
  }
  const statement = (): Stmt => {
    skipNlOnly()
    if (isOp('{')) return block()
    if (isOp(';')) {
      p++
      return { k: 'block', body: [] }
    }
    const t = toks[p]
    if (t.t === 'id') {
      switch (t.v) {
        case 'print':
        case 'printf': {
          p++
          const r = printArgs()
          endStmt()
          return { k: t.v, args: r.args, redir: r.redir }
        }
        case 'if': {
          p++
          expectOp('(')
          const c = expr()
          expectOp(')')
          const a = simpleOrBlock()
          const save = p
          skipNl()
          if (isId('else')) {
            p++
            return { k: 'if', c, a, b: simpleOrBlock() }
          }
          p = save
          return { k: 'if', c, a }
        }
        case 'while': {
          p++
          expectOp('(')
          const c = expr()
          expectOp(')')
          if (isOp(';')) {
            p++
            return { k: 'while', c, body: { k: 'block', body: [] } }
          }
          return { k: 'while', c, body: simpleOrBlock() }
        }
        case 'do': {
          p++
          const body = simpleOrBlock()
          skipNl()
          if (!isId('while')) fail()
          p++
          expectOp('(')
          const c = expr()
          expectOp(')')
          endStmt()
          return { k: 'do', c, body }
        }
        case 'for': {
          p++
          expectOp('(')
          if (toks[p].t === 'id' && toks[p + 1].t === 'id' && (toks[p + 1] as { v: string }).v === 'in' && toks[p + 3]?.t === 'op' && (toks[p + 3] as { v: string }).v === ')') {
            const v = (toks[p] as { v: string }).v
            const arr = (toks[p + 2] as { v: string }).v
            p += 4
            return { k: 'forin', v, arr, body: simpleOrBlock() }
          }
          const init = isOp(';') ? undefined : expr()
          expectOp(';')
          skipNlOnly()
          const c = isOp(';') ? undefined : expr()
          expectOp(';')
          skipNlOnly()
          const step = isOp(')') ? undefined : expr()
          expectOp(')')
          return { k: 'for', init, c, step, body: simpleOrBlock() }
        }
        case 'next':
          p++
          endStmt()
          return { k: 'next' }
        case 'exit': {
          p++
          const e = isOp(';') || isOp('}') || toks[p].t === 'nl' || toks[p].t === 'eof' ? undefined : expr()
          endStmt()
          return { k: 'exit', e }
        }
        case 'break':
          p++
          endStmt()
          return { k: 'break' }
        case 'continue':
          p++
          endStmt()
          return { k: 'continue' }
        case 'delete': {
          p++
          const name = (toks[p++] as { v: string }).v
          let keys: Expr[] | undefined
          if (isOp('[')) {
            p++
            keys = [expr()]
            while (isOp(',')) {
              p++
              keys.push(expr())
            }
            expectOp(']')
          }
          endStmt()
          return { k: 'delete', name, keys }
        }
      }
    }
    const e = expr()
    endStmt()
    return { k: 'expr', e }
  }

  const rules: Rule[] = []
  skipNl()
  while (peek().t !== 'eof') {
    if (isId('BEGIN') || isId('END')) {
      const kind = (toks[p++] as { v: string }).v === 'BEGIN' ? 'begin' : 'end'
      skipNlOnly()
      rules.push({ kind, action: block() })
    } else if (isOp('{')) rules.push({ kind: 'main', action: block() })
    else {
      const pattern = expr()
      let range: [Expr, Expr] | undefined
      if (isOp(',')) {
        p++
        range = [pattern, expr()]
      }
      const action = isOp('{') ? block() : undefined
      rules.push({ kind: 'main', pattern: range ? undefined : pattern, range, action })
    }
    skipNl()
  }
  return rules
}

class NextSig {}
class ExitSig {
  constructor(public code: number) {}
}
class BreakSig {}
class ContinueSig {}

export interface AwkIO {
  out: (s: string) => void
  err: (s: string) => void
  writeFile: (path: string, data: string, append: boolean) => void
}

const isNumStr = (s: string) => /^\s*[-+]?(\d+\.?\d*([eE][-+]?\d+)?|\.\d+)\s*$/.test(s)

export function runAwk(program: string, inputs: { name: string; data: string }[], opts: { fs?: string; vars?: Record<string, string> }, io: AwkIO): number {
  const rules = parse(program)
  const vars = new Map<string, Val>([
    ['FS', opts.fs ?? ' '],
    ['OFS', ' '],
    ['ORS', '\n'],
    ['NR', 0],
    ['NF', 0],
    ['FNR', 0],
    ['SUBSEP', '\u001c'],
    ['RSTART', 0],
    ['RLENGTH', -1],
    ['OFMT', '%.6g'],
    ['CONVFMT', '%.6g'],
  ])
  for (const [k, v] of Object.entries(opts.vars ?? {})) vars.set(k, v.replace(/\\n/g, '\n').replace(/\\t/g, '\t'))
  const arrays = new Map<string, Map<string, Val>>()
  let fields: string[] = []
  let record = ''
  const files = new Map<string, string>()

  const num = (v: Val): number => (typeof v === 'number' ? v : isNumStr(v) ? Number(v) : parseFloat(v) || 0)
  const str = (v: Val): string => (typeof v === 'string' ? v : Number.isInteger(v) ? String(v) : fmtG(v))
  const fmtG = (n: number) => {
    const s = n.toPrecision(6)
    return String(Number(s))
  }
  const bool = (v: Val) => (typeof v === 'number' ? v !== 0 : v !== '')
  const splitFields = (rec: string, fs: string): string[] => {
    if (fs === ' ') return rec.trim() ? rec.trim().split(/[ \t\n]+/) : []
    if (rec === '') return []
    if (fs.length === 1 && fs !== ' ') return rec.split(fs === '|' || fs === '.' ? fs : new RegExp(fs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    return rec.split(new RegExp(fs))
  }
  const setRecord = (rec: string) => {
    record = rec
    fields = splitFields(rec, str(vars.get('FS')!))
    vars.set('NF', fields.length)
  }
  const rebuild = () => {
    record = fields.join(str(vars.get('OFS')!))
  }
  const getField = (i: number): Val => {
    if (i === 0) return record
    const f = fields[i - 1]
    return f === undefined ? '' : f
  }
  const setField = (i: number, v: string) => {
    if (i === 0) {
      setRecord(v)
      return
    }
    while (fields.length < i) fields.push('')
    fields[i - 1] = v
    vars.set('NF', fields.length)
    rebuild()
  }
  const arr = (name: string) => {
    let a = arrays.get(name)
    if (!a) arrays.set(name, (a = new Map()))
    return a
  }
  const key = (keys: Expr[]) => keys.map((k) => str(evalE(k))).join(str(vars.get('SUBSEP')!))
  const toRe = (e: Expr): RegExp => {
    if (e.k === 're') return new RegExp(e.v)
    return new RegExp(str(evalE(e)))
  }
  const compare = (a: Expr, b: Expr, op: string): number => {
    const av = evalE(a)
    const bv = evalE(b)
    const numeric = (x: Val, e: Expr) => typeof x === 'number' || ((e.k === 'field' || e.k === 'var' || e.k === 'idx') && isNumStr(x))
    let r: number
    if (numeric(av, a) && numeric(bv, b)) {
      const x = num(av)
      const y = num(bv)
      r = x < y ? -1 : x > y ? 1 : 0
    } else {
      const x = str(av)
      const y = str(bv)
      r = x < y ? -1 : x > y ? 1 : 0
    }
    switch (op) {
      case '<':
        return Number(r < 0)
      case '<=':
        return Number(r <= 0)
      case '>':
        return Number(r > 0)
      case '>=':
        return Number(r >= 0)
      case '==':
        return Number(r === 0)
      default:
        return Number(r !== 0)
    }
  }
  const assignTo = (target: Expr, v: Val): Val => {
    if (target.k === 'var') vars.set(target.name, v)
    else if (target.k === 'field') setField(num(evalE(target.e)), str(v))
    else if (target.k === 'idx') arr(target.name).set(key(target.keys), v)
    if (target.k === 'var' && target.name === 'NF') {
      fields.length = num(v)
      rebuild()
    }
    if (target.k === 'var' && target.name === '$0') setRecord(str(v))
    return v
  }
  const readTarget = (target: Expr): Val => {
    if (target.k === 'var') return vars.get(target.name) ?? ''
    if (target.k === 'field') return getField(num(evalE(target.e)))
    if (target.k === 'idx') return arr(target.name).get(key(target.keys)) ?? ''
    return ''
  }

  const evalE = (e: Expr): Val => {
    switch (e.k) {
      case 'num':
        return e.v
      case 'str':
        return e.v
      case 're':
        return Number(new RegExp(e.v).test(record))
      case 'group':
        return evalE(e.e)
      case 'var':
        return vars.get(e.name) ?? ''
      case 'field':
        return getField(num(evalE(e.e)))
      case 'idx': {
        const a = arr(e.name)
        const k = key(e.keys)
        if (!a.has(k)) a.set(k, '')
        return a.get(k)!
      }
      case 'in':
        return Number(arr(e.name).has(key(e.keys)))
      case 'assign': {
        if (e.op === '=') return assignTo(e.target, evalE(e.value))
        const cur = num(readTarget(e.target))
        const v = num(evalE(e.value))
        const r = e.op === '+=' ? cur + v : e.op === '-=' ? cur - v : e.op === '*=' ? cur * v : e.op === '/=' ? cur / v : e.op === '%=' ? cur % v : cur ** v
        return assignTo(e.target, r)
      }
      case 'incdec': {
        const cur = num(readTarget(e.target))
        const nv = cur + (e.op === '++' ? 1 : -1)
        assignTo(e.target, nv)
        return e.pre ? nv : cur
      }
      case 'cond':
        return bool(evalE(e.c)) ? evalE(e.a) : evalE(e.b)
      case 'un':
        if (e.op === '!') return Number(!bool(evalE(e.e)))
        if (e.op === '-') return -num(evalE(e.e))
        return num(evalE(e.e))
      case 'match': {
        const r = toRe(e.re).test(str(evalE(e.a)))
        return Number(e.neg ? !r : r)
      }
      case 'bin': {
        if (e.op === '&&') return Number(bool(evalE(e.a)) && bool(evalE(e.b)))
        if (e.op === '||') return Number(bool(evalE(e.a)) || bool(evalE(e.b)))
        if (e.op === 'concat') return str(evalE(e.a)) + str(evalE(e.b))
        if (['<', '<=', '>', '>=', '==', '!='].includes(e.op)) return compare(e.a, e.b, e.op)
        const a = num(evalE(e.a))
        const b = num(evalE(e.b))
        switch (e.op) {
          case '+':
            return a + b
          case '-':
            return a - b
          case '*':
            return a * b
          case '/':
            if (b === 0) throw new AwkError('awk: division by zero')
            return a / b
          case '%':
            if (b === 0) throw new AwkError('awk: division by zero in %')
            return a % b
          case '^':
            return a ** b
        }
        return 0
      }
      case 'call':
        return call(e.name, e.args)
    }
  }

  const call = (name: string, args: Expr[]): Val => {
    const s = (i: number) => str(evalE(args[i]))
    switch (name) {
      case 'length':
        if (!args.length) return [...record].length
        if (args[0].k === 'var' && arrays.has(args[0].name)) return arrays.get(args[0].name)!.size
        return [...s(0)].length
      case 'substr': {
        const t = [...s(0)]
        const m = Math.round(num(evalE(args[1])))
        const n = args[2] ? Math.round(num(evalE(args[2]))) : Infinity
        const start = Math.max(1, m)
        const end = n === Infinity ? t.length + 1 : m + n
        return t.slice(start - 1, Math.max(start - 1, end - 1)).join('')
      }
      case 'index':
        return s(0).indexOf(s(1)) + 1
      case 'split': {
        const target = args[1]
        if (target.k !== 'var') throw new AwkError('awk: split: second argument is not an array')
        const parts = args[2] ? (args[2].k === 're' ? s(0).split(new RegExp(args[2].v)) : splitFields(s(0), s(2))) : splitFields(s(0), str(vars.get('FS')!))
        const a = new Map<string, Val>()
        parts.forEach((x, i) => a.set(String(i + 1), x))
        arrays.set(target.name, a)
        return parts.length
      }
      case 'sub':
      case 'gsub': {
        const re = toRe(args[0])
        const target = args[2] ?? { k: 'field', e: { k: 'num', v: 0 } }
        const cur = str(readTarget(target as Expr))
        const repl = s(1)
        let count = 0
        const g = new RegExp(re.source, name === 'gsub' ? 'g' : '')
        const res = cur.replace(g, (m) => {
          count++
          return repl.split('\\&').map((part) => part.replace(/&/g, m)).join('&')
        })
        if (count) assignTo(target as Expr, res)
        return count
      }
      case 'match': {
        const m = toRe(args[1]).exec(s(0))
        vars.set('RSTART', m ? m.index + 1 : 0)
        vars.set('RLENGTH', m ? m[0].length : -1)
        return m ? m.index + 1 : 0
      }
      case 'sprintf':
        return sprintf(s(0), args.slice(1).map((a) => evalE(a)))
      case 'tolower':
        return s(0).toLowerCase()
      case 'toupper':
        return s(0).toUpperCase()
      case 'int':
        return Math.trunc(num(evalE(args[0])))
      case 'sqrt':
        return Math.sqrt(num(evalE(args[0])))
      case 'exp':
        return Math.exp(num(evalE(args[0])))
      case 'log':
        return Math.log(num(evalE(args[0])))
      case 'sin':
        return Math.sin(num(evalE(args[0])))
      case 'cos':
        return Math.cos(num(evalE(args[0])))
      case 'atan2':
        return Math.atan2(num(evalE(args[0])), num(evalE(args[1])))
      case 'rand':
        return Math.random()
      case 'srand':
        return 0
      case 'system':
        return 0
    }
    if (!BUILTIN_FUNCS.has(name)) throw new AwkError(`awk: calling undefined function ${name}`)
    return ''
  }

  const sprintf = (fmt: string, vals: Val[]): string => {
    let i = 0
    return fmt.replace(/%([-+ 0#]*)(\d+|\*)?(?:\.(\d+|\*))?([sdiouxXeEfgGc%])/g, (_m, flags: string, w: string | undefined, prec: string | undefined, conv: string) => {
      if (conv === '%') return '%'
      const width = w === '*' ? num(vals[i++] ?? 0) : w ? Number(w) : 0
      const precision = prec === '*' ? num(vals[i++] ?? 0) : prec !== undefined ? Number(prec) : undefined
      const v = vals[i++] ?? ''
      let out: string
      switch (conv) {
        case 's':
          out = str(v)
          if (precision !== undefined) out = out.slice(0, precision)
          break
        case 'c':
          out = typeof v === 'number' ? String.fromCharCode(v) : str(v).slice(0, 1)
          break
        case 'd':
        case 'i':
        case 'u':
          out = String(Math.trunc(num(v)))
          break
        case 'o':
          out = Math.trunc(num(v)).toString(8)
          break
        case 'x':
          out = Math.trunc(num(v)).toString(16)
          break
        case 'X':
          out = Math.trunc(num(v)).toString(16).toUpperCase()
          break
        case 'e':
        case 'E':
          out = num(v).toExponential(precision ?? 6)
          if (conv === 'E') out = out.toUpperCase()
          break
        case 'g':
        case 'G':
          out = String(Number(num(v).toPrecision(precision || 6)))
          break
        default:
          out = num(v).toFixed(precision ?? 6)
      }
      if (flags.includes('+') && /[dife]/.test(conv) && num(v) >= 0) out = '+' + out
      if (out.length < width) {
        if (flags.includes('-')) out = out.padEnd(width)
        else if (flags.includes('0') && conv !== 's') out = out.startsWith('-') ? '-' + out.slice(1).padStart(width - 1, '0') : out.padStart(width, '0')
        else out = out.padStart(width)
      }
      return out
    })
  }

  const emit = (text: string, redir?: { op: string; target: Expr }) => {
    if (!redir) {
      io.out(text)
      return
    }
    const path = str(evalE(redir.target))
    if (redir.op === '|') {
      io.out(text)
      return
    }
    const append = redir.op === '>>' || files.has(path)
    io.writeFile(path, text, append)
    files.set(path, '')
  }

  const exec = (s: Stmt): void => {
    switch (s.k) {
      case 'print': {
        const text = s.args.length ? s.args.map((a) => str(evalE(a))).join(str(vars.get('OFS')!)) : record
        emit(text + str(vars.get('ORS')!), s.redir)
        return
      }
      case 'printf': {
        if (!s.args.length) return
        emit(sprintf(str(evalE(s.args[0])), s.args.slice(1).map((a) => evalE(a))), s.redir)
        return
      }
      case 'expr':
        evalE(s.e)
        return
      case 'if':
        if (bool(evalE(s.c))) exec(s.a)
        else if (s.b) exec(s.b)
        return
      case 'while': {
        let guard = 0
        while (bool(evalE(s.c))) {
          if (++guard > 1e6) throw new AwkError('awk: el bucle no termina')
          try {
            exec(s.body)
          } catch (e) {
            if (e instanceof BreakSig) break
            if (e instanceof ContinueSig) continue
            throw e
          }
        }
        return
      }
      case 'do': {
        let guard = 0
        do {
          if (++guard > 1e6) throw new AwkError('awk: el bucle no termina')
          try {
            exec(s.body)
          } catch (e) {
            if (e instanceof BreakSig) break
            if (e instanceof ContinueSig) continue
            throw e
          }
        } while (bool(evalE(s.c)))
        return
      }
      case 'for': {
        if (s.init) evalE(s.init)
        let guard = 0
        while (!s.c || bool(evalE(s.c))) {
          if (++guard > 1e6) throw new AwkError('awk: el bucle no termina')
          try {
            exec(s.body)
          } catch (e) {
            if (e instanceof BreakSig) break
            if (!(e instanceof ContinueSig)) throw e
          }
          if (s.step) evalE(s.step)
        }
        return
      }
      case 'forin': {
        for (const k of [...arr(s.arr).keys()]) {
          vars.set(s.v, k)
          try {
            exec(s.body)
          } catch (e) {
            if (e instanceof BreakSig) break
            if (!(e instanceof ContinueSig)) throw e
          }
        }
        return
      }
      case 'block':
        for (const x of s.body) exec(x)
        return
      case 'next':
        throw new NextSig()
      case 'exit':
        throw new ExitSig(s.e ? num(evalE(s.e)) : 0)
      case 'break':
        throw new BreakSig()
      case 'continue':
        throw new ContinueSig()
      case 'delete':
        if (s.keys) arr(s.name).delete(key(s.keys))
        else arrays.set(s.name, new Map())
        return
    }
  }

  let code = 0
  const ranges = new Map<Rule, boolean>()
  try {
    for (const r of rules.filter((x) => x.kind === 'begin')) exec(r.action!)
    const main = rules.filter((x) => x.kind === 'main')
    const needInput = main.length > 0 || rules.some((x) => x.kind === 'end')
    if (needInput) {
      let nr = 0
      for (const inp of inputs) {
        vars.set('FILENAME', inp.name === '-' ? '' : inp.name)
        let fnr = 0
        const recs = inp.data.split('\n')
        if (recs[recs.length - 1] === '') recs.pop()
        for (const rec of recs) {
          nr++
          fnr++
          vars.set('NR', nr)
          vars.set('FNR', fnr)
          setRecord(rec)
          try {
            for (const r of main) {
              let hit: boolean
              if (r.range) {
                const on = ranges.get(r) ?? false
                if (!on) {
                  hit = bool(evalE(r.range[0]))
                  if (hit) ranges.set(r, !bool(evalE(r.range[1])))
                } else {
                  hit = true
                  if (bool(evalE(r.range[1]))) ranges.set(r, false)
                }
              } else hit = !r.pattern || bool(evalE(r.pattern))
              if (!hit) continue
              if (r.action) exec(r.action)
              else io.out(record + str(vars.get('ORS')!))
            }
          } catch (e) {
            if (e instanceof NextSig) continue
            throw e
          }
        }
      }
    }
  } catch (e) {
    if (e instanceof ExitSig) code = e.code
    else throw e
  }
  try {
    for (const r of rules.filter((x) => x.kind === 'end')) exec(r.action!)
  } catch (e) {
    if (e instanceof ExitSig) code = e.code
    else throw e
  }
  return code
}
