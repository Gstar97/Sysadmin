/**
 * Un Jinja2 chico, con lo que se usa en Ansible: {{ expresiones }} con filtros y tests,
 * {% if %}, {% for %}, {% set %}, {% raw %}, comentarios y control de espacios. Las variables
 * que faltan dan el mismo error que en Ansible ("'x' is undefined"), y una cadena que es una
 * sola expresión devuelve el valor con su tipo (como hace Ansible con "{{ lista }}").
 */
import { parse as parseYaml, stringify as yamlStringify } from 'yaml'

export class JinjaError extends Error {}

/** Una variable que no existe: se puede preguntar si está definida, pero no usar. */
export class Undef {
  constructor(public readonly name: string) {}
}

export type Scope = Record<string, unknown>
export type Filter = (value: unknown, ...args: unknown[]) => unknown

export interface RenderOptions {
  /** Funciones extra (lookup, query...) y filtros propios. */
  globals?: Record<string, (...args: unknown[]) => unknown>
  filters?: Record<string, Filter>
  /** Ansible usa trim_blocks: el salto de línea después de un {% ... %} se borra. */
  trimBlocks?: boolean
  lstripBlocks?: boolean
}

// ---------------------------------------------------------------------------------------
// Valores con la semántica de Python
// ---------------------------------------------------------------------------------------

const isDict = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Undef) && !(v instanceof Kwargs)

export function truthy(v: unknown): boolean {
  if (v instanceof Undef) return false
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false
  if (Array.isArray(v)) return v.length > 0
  if (isDict(v)) return Object.keys(v).length > 0
  return true
}

/** Texto como lo mostraría Python (repr dentro de listas y diccionarios). */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return 'None'
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (typeof v === 'string') return v.includes("'") && !v.includes('"') ? `"${v}"` : `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(', ')}]`
  if (isDict(v)) return `{${Object.entries(v).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(', ')}}`
  return String(v)
}

export function pyStr(v: unknown): string {
  if (v instanceof Undef) throw new JinjaError(`'${v.name}' is undefined`)
  if (typeof v === 'string') return v
  return pyRepr(v)
}

function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => eq(x, b[i]))
  if (isDict(a) && isDict(b)) {
    const ka = Object.keys(a)
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && eq(a[k], b[k]))
  }
  return false
}

function typeName(v: unknown) {
  if (v === null || v === undefined) return 'NoneType'
  if (typeof v === 'string') return 'str'
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float'
  if (typeof v === 'boolean') return 'bool'
  if (Array.isArray(v)) return 'list'
  return 'dict'
}

function cmp(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0
  if (typeof a === 'boolean' || typeof b === 'boolean') return Number(a) - Number(b)
  throw new JinjaError(`'<' not supported between instances of '${typeName(a)}' and '${typeName(b)}'`)
}

function contains(container: unknown, item: unknown): boolean {
  if (typeof container === 'string') return container.includes(pyStr(item))
  if (Array.isArray(container)) return container.some((x) => eq(x, item))
  if (isDict(container)) return typeof item === 'string' && item in container
  throw new JinjaError(`argument of type '${typeName(container)}' is not iterable`)
}

function iterate(v: unknown): unknown[] {
  if (v instanceof Undef) throw new JinjaError(`'${v.name}' is undefined`)
  if (Array.isArray(v)) return v
  if (isDict(v)) return Object.keys(v)
  if (typeof v === 'string') return [...v]
  if (v === null || v === undefined) throw new JinjaError("'NoneType' object is not iterable")
  throw new JinjaError(`'${typeName(v)}' object is not iterable`)
}

/** Compara versiones como el test version de Ansible ("9.4" >= "9"). */
export function compareVersions(a: string, b: string): number {
  const pa = String(a).split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x))
  const pb = String(b).split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x))
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x - y
    return String(x) < String(y) ? -1 : 1
  }
  return 0
}

class Kwargs {
  constructor(public readonly values: Record<string, unknown>) {}
}

function splitArgs(args: unknown[]): { pos: unknown[]; kw: Record<string, unknown> } {
  const pos: unknown[] = []
  let kw: Record<string, unknown> = {}
  for (const a of args) if (a instanceof Kwargs) kw = { ...kw, ...a.values }
  else pos.push(a)
  return { pos, kw }
}

/** Un hash corto y estable, para password_hash y hash sin criptografía de verdad. */
function stableHash(s: string, len: number): string {
  const abc = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  let h1 = 0x811c9dc5
  let h2 = 0x9e3779b9
  for (const c of s) {
    h1 = Math.imul(h1 ^ c.charCodeAt(0), 16777619) >>> 0
    h2 = Math.imul(h2 + c.charCodeAt(0), 2246822507) >>> 0
  }
  let out = ''
  for (let i = 0; i < len; i++) {
    h1 = Math.imul(h1 ^ (h1 >>> 13), 3266489909) >>> 0
    h2 = (h2 + h1 + i) >>> 0
    out += abc[((h1 ^ h2) >>> 0) % abc.length]
  }
  return out
}

const b64e = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))
const b64d = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))

// ---------------------------------------------------------------------------------------
// Filtros y tests
// ---------------------------------------------------------------------------------------

function attrOf(v: unknown, path: string): unknown {
  let cur = v
  for (const p of path.split('.')) cur = isDict(cur) ? cur[p] : Array.isArray(cur) && /^\d+$/.test(p) ? cur[Number(p)] : undefined
  return cur
}

export const FILTERS: Record<string, Filter> = {
  default(v, ...args) {
    const { pos } = splitArgs(args)
    const [def = '', bool = false] = pos
    if (v instanceof Undef || v === undefined) return def
    if (bool && !truthy(v)) return def
    return v
  },
  mandatory(v, msg) {
    if (v instanceof Undef) throw new JinjaError(typeof msg === 'string' ? msg : `Mandatory variable '${v.name}' not defined.`)
    return v
  },
  upper: (v) => pyStr(v).toUpperCase(),
  lower: (v) => pyStr(v).toLowerCase(),
  capitalize: (v) => {
    const s = pyStr(v)
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
  },
  title: (v) => pyStr(v).replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()),
  trim: (v) => pyStr(v).trim(),
  replace: (v, a, b) => pyStr(v).split(pyStr(a)).join(pyStr(b)),
  join(v, sep = '', attr?: unknown) {
    const { pos, kw } = splitArgs([sep, attr])
    const items = iterate(v)
    const a = (kw.attribute as string | undefined) ?? undefined
    return items.map((x) => pyStr(a ? attrOf(x, a) : x)).join(typeof pos[0] === 'string' ? pos[0] : '')
  },
  length: (v) => iterate(v).length,
  count: (v) => iterate(v).length,
  first: (v) => iterate(v)[0] ?? new Undef('first'),
  last: (v) => {
    const it = iterate(v)
    return it[it.length - 1] ?? new Undef('last')
  },
  int(v, def = 0) {
    if (typeof v === 'number') return Math.trunc(v)
    if (typeof v === 'boolean') return Number(v)
    const n = Number.parseInt(pyStr(v).trim(), 10)
    return Number.isNaN(n) ? def : n
  },
  float(v, def = 0) {
    const n = Number.parseFloat(typeof v === 'number' ? String(v) : pyStr(v))
    return Number.isNaN(n) ? def : n
  },
  string: (v) => pyStr(v),
  bool(v) {
    if (typeof v === 'boolean') return v
    if (typeof v === 'number') return v !== 0
    return ['yes', 'on', '1', 'true', 'y', 't'].includes(pyStr(v).trim().toLowerCase())
  },
  list: (v) => [...iterate(v)],
  abs: (v) => Math.abs(Number(v)),
  round(v, precision = 0) {
    const p = 10 ** Number(precision)
    return Math.round(Number(v) * p) / p
  },
  sort(v, ...args) {
    const { pos, kw } = splitArgs(args)
    const reverse = Boolean(kw.reverse ?? pos[0])
    const attr = kw.attribute as string | undefined
    const out = [...iterate(v)].sort((a, b) => cmp(attr ? attrOf(a, attr) : a, attr ? attrOf(b, attr) : b))
    return reverse ? out.reverse() : out
  },
  unique(v) {
    const out: unknown[] = []
    for (const x of iterate(v)) if (!out.some((y) => eq(x, y))) out.push(x)
    return out
  },
  min: (v) => [...iterate(v)].sort(cmp)[0],
  max: (v) => [...iterate(v)].sort(cmp).at(-1),
  sum(v, ...args) {
    const { kw } = splitArgs(args)
    return iterate(v).reduce((s: number, x) => s + Number(kw.attribute ? attrOf(x, kw.attribute as string) : x), Number(kw.start ?? 0))
  },
  map(v, ...args) {
    const { pos, kw } = splitArgs(args)
    if (kw.attribute) return iterate(v).map((x) => attrOf(x, kw.attribute as string) ?? kw.default)
    const name = pos[0] as string
    const f = FILTERS[name]
    if (!f) throw new JinjaError(`No filter named '${name}'.`)
    return iterate(v).map((x) => f(x, ...pos.slice(1)))
  },
  select: (v, test?: unknown, ...args) => iterate(v).filter((x) => (test ? runTest(test as string, x, args) : truthy(x))),
  reject: (v, test?: unknown, ...args) => iterate(v).filter((x) => !(test ? runTest(test as string, x, args) : truthy(x))),
  selectattr: (v, attr, test?: unknown, ...args) => iterate(v).filter((x) => (test ? runTest(test as string, attrOf(x, attr as string), args) : truthy(attrOf(x, attr as string)))),
  rejectattr: (v, attr, test?: unknown, ...args) => iterate(v).filter((x) => !(test ? runTest(test as string, attrOf(x, attr as string), args) : truthy(attrOf(x, attr as string)))),
  dict2items(v, ...args) {
    const { kw } = splitArgs(args)
    if (!isDict(v)) throw new JinjaError('dict2items requires a dictionary')
    return Object.entries(v).map(([k, x]) => ({ [(kw.key_name as string) ?? 'key']: k, [(kw.value_name as string) ?? 'value']: x }))
  },
  items2dict(v, ...args) {
    const { kw } = splitArgs(args)
    const out: Record<string, unknown> = {}
    for (const x of iterate(v)) if (isDict(x)) out[String(x[(kw.key_name as string) ?? 'key'])] = x[(kw.value_name as string) ?? 'value']
    return out
  },
  combine(v, ...args) {
    const { pos, kw } = splitArgs(args)
    const deep = Boolean(kw.recursive)
    const merge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => {
      const out = { ...a }
      for (const [k, x] of Object.entries(b)) out[k] = deep && isDict(out[k]) && isDict(x) ? merge(out[k] as Record<string, unknown>, x) : x
      return out
    }
    return pos.reduce((acc: Record<string, unknown>, x) => merge(acc, x as Record<string, unknown>), v as Record<string, unknown>)
  },
  flatten(v, levels?: unknown) {
    const flat = (xs: unknown[], depth: number): unknown[] => xs.flatMap((x) => (Array.isArray(x) && depth !== 0 ? flat(x, depth - 1) : [x]))
    return flat(iterate(v), levels === undefined ? -1 : Number(levels))
  },
  difference: (a, b) => iterate(a).filter((x) => !iterate(b).some((y) => eq(x, y))),
  intersect: (a, b) => FILTERS.unique(iterate(a).filter((x) => iterate(b).some((y) => eq(x, y)))),
  union: (a, b) => FILTERS.unique([...iterate(a), ...iterate(b)]),
  zip: (a, ...bs) => iterate(a).map((x, i) => [x, ...bs.map((b) => iterate(b)[i])]),
  to_json: (v) => JSON.stringify(v),
  to_nice_json: (v, ...args) => JSON.stringify(v, null, Number(splitArgs(args).kw.indent ?? 4)),
  to_yaml: (v) => yamlStringify(v, { flowCollectionPadding: false }).replace(/\n$/, ''),
  to_nice_yaml: (v, ...args) => yamlStringify(v, { indent: Number(splitArgs(args).kw.indent ?? 4) }),
  from_json: (v) => JSON.parse(pyStr(v)),
  from_yaml: (v) => parseYaml(pyStr(v)),
  regex_replace(v, pattern, repl = '', ...args) {
    const { kw } = splitArgs(args)
    const flags = `g${kw.ignorecase ? 'i' : ''}${kw.multiline ? 'm' : ''}`
    return pyStr(v).replace(new RegExp(pyStr(pattern), flags), pyStr(repl).replace(/\\(\d)/g, '$$$1').replace(/\\g<(\w+)>/g, '$$<$1>'))
  },
  regex_search(v, pattern, ...args) {
    const { pos } = splitArgs(args)
    const m = new RegExp(pyStr(pattern)).exec(pyStr(v))
    if (!m) return null
    if (pos.length) return pos.map((g) => (typeof g === 'string' && /^\\\d+$/.test(g) ? m[Number(g.slice(1))] : m.groups?.[String(g).replace(/^\\g<|>$/g, '')]))
    return m[0]
  },
  regex_findall: (v, pattern) => [...pyStr(v).matchAll(new RegExp(pyStr(pattern), 'g'))].map((m) => (m.length > 2 ? m.slice(1) : (m[1] ?? m[0]))),
  split: (v, sep?: unknown) => (sep === undefined || sep === null ? pyStr(v).trim().split(/\s+/).filter(Boolean) : pyStr(v).split(pyStr(sep))),
  b64encode: (v) => b64e(pyStr(v)),
  b64decode: (v) => b64d(pyStr(v)),
  basename: (v) => pyStr(v).replace(/\/+$/, '').split('/').pop() ?? '',
  dirname: (v) => {
    const s = pyStr(v)
    const i = s.lastIndexOf('/')
    return i <= 0 ? (i === 0 ? '/' : '') : s.slice(0, i)
  },
  quote: (v) => {
    const s = pyStr(v)
    return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'"'"'`)}'`
  },
  password_hash(v, scheme = 'sha512', salt?: unknown) {
    const s = typeof salt === 'string' ? salt : stableHash(`salt:${pyStr(v)}`, 16)
    const id = scheme === 'sha256' ? '5' : scheme === 'md5' ? '1' : '6'
    return `$${id}$${s}$${stableHash(`${s}:${pyStr(v)}`, id === '6' ? 86 : 43)}`
  },
  hash: (v, kind = 'sha1') => stableHash(`${kind}:${pyStr(v)}`, kind === 'md5' ? 32 : 40).toLowerCase().replace(/[^0-9a-f]/g, (c) => '0123456789abcdef'[c.charCodeAt(0) % 16]),
  ternary: (v, a, b, n?: unknown) => (v === null && n !== undefined ? n : truthy(v) ? a : b),
  indent(v, width = 4, first = false) {
    const pad = ' '.repeat(Number(width))
    return pyStr(v)
      .split('\n')
      .map((l, i) => ((i === 0 && !first) || l === '' ? l : pad + l))
      .join('\n')
  },
  center: (v, width = 80) => {
    const s = pyStr(v)
    const total = Math.max(0, Number(width) - s.length)
    return ' '.repeat(Math.floor(total / 2)) + s + ' '.repeat(Math.ceil(total / 2))
  },
  wordcount: (v) => pyStr(v).split(/\s+/).filter(Boolean).length,
  type_debug: (v) => typeName(v),
  dict: (v) => Object.fromEntries(iterate(v) as [string, unknown][]),
  random: (v) => iterate(v)[0],
  shuffle: (v) => [...iterate(v)],
  comment(v) {
    return `#\n${pyStr(v)
      .split('\n')
      .map((l) => `# ${l}`)
      .join('\n')}\n#`
  },
}
FILTERS.d = FILTERS.default

function versionOp(op: string): (c: number) => boolean {
  switch (op) {
    case '<':
    case 'lt':
      return (c) => c < 0
    case '<=':
    case 'le':
      return (c) => c <= 0
    case '>':
    case 'gt':
      return (c) => c > 0
    case '>=':
    case 'ge':
      return (c) => c >= 0
    case '!=':
    case 'ne':
      return (c) => c !== 0
    default:
      return (c) => c === 0
  }
}

const isResult = (v: unknown): v is Record<string, unknown> => isDict(v)

export const TESTS: Record<string, (v: unknown, ...args: unknown[]) => boolean> = {
  defined: (v) => !(v instanceof Undef) && v !== undefined,
  undefined: (v) => v instanceof Undef || v === undefined,
  none: (v) => v === null,
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number',
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  float: (v) => typeof v === 'number' && !Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  true: (v) => v === true,
  false: (v) => v === false,
  mapping: (v) => isDict(v),
  sequence: (v) => Array.isArray(v) || typeof v === 'string',
  iterable: (v) => Array.isArray(v) || typeof v === 'string' || isDict(v),
  even: (v) => Number(v) % 2 === 0,
  odd: (v) => Number(v) % 2 === 1,
  divisibleby: (v, n) => Number(v) % Number(n) === 0,
  eq: (v, x) => eq(v, x),
  equalto: (v, x) => eq(v, x),
  sameas: (v, x) => v === x,
  ne: (v, x) => !eq(v, x),
  gt: (v, x) => cmp(v, x) > 0,
  ge: (v, x) => cmp(v, x) >= 0,
  lt: (v, x) => cmp(v, x) < 0,
  le: (v, x) => cmp(v, x) <= 0,
  in: (v, x) => contains(x, v),
  contains: (v, x) => contains(v, x),
  match: (v, p) => new RegExp(`^(?:${pyStr(p)})`).test(pyStr(v)),
  search: (v, p) => new RegExp(pyStr(p)).test(pyStr(v)),
  regex: (v, p) => new RegExp(pyStr(p)).test(pyStr(v)),
  version(v, ...args) {
    const { pos, kw } = splitArgs(args)
    return versionOp(String(kw.operator ?? pos[1] ?? '=='))(compareVersions(pyStr(v), pyStr(pos[0])))
  },
  version_compare: (v, ...args) => TESTS.version(v, ...args),
  subset: (v, x) => iterate(v).every((a) => iterate(x).some((b) => eq(a, b))),
  superset: (v, x) => iterate(x).every((a) => iterate(v).some((b) => eq(a, b))),
  failed: (v) => isResult(v) && v.failed === true,
  succeeded: (v) => isResult(v) && v.failed !== true,
  success: (v) => isResult(v) && v.failed !== true,
  successful: (v) => isResult(v) && v.failed !== true,
  changed: (v) => isResult(v) && v.changed === true,
  change: (v) => isResult(v) && v.changed === true,
  skipped: (v) => isResult(v) && v.skipped === true,
  skip: (v) => isResult(v) && v.skipped === true,
  truthy: (v) => truthy(v),
  falsy: (v) => !truthy(v),
}
TESTS['=='] = TESTS.eq
TESTS['!='] = TESTS.ne
TESTS['>'] = TESTS.gt
TESTS['>='] = TESTS.ge
TESTS['<'] = TESTS.lt
TESTS['<='] = TESTS.le

function runTest(name: string, v: unknown, args: unknown[]): boolean {
  const t = TESTS[name]
  if (!t) throw new JinjaError(`No test named '${name}'.`)
  return t(v, ...args)
}

// ---------------------------------------------------------------------------------------
// Expresiones
// ---------------------------------------------------------------------------------------

type Tok = { t: 'num' | 'str' | 'name' | 'op' | 'end'; v: string | number }

const OPS = ['**', '//', '==', '!=', '<=', '>=', '(', ')', '[', ']', '{', '}', ',', '.', ':', '|', '~', '+', '-', '*', '/', '%', '<', '>', '=']

function lex(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (/\d/.test(c)) {
      const m = /^\d+(\.\d+)?/.exec(src.slice(i))!
      out.push({ t: 'num', v: Number(m[0]) })
      i += m[0].length
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      let s = ''
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const n = src[j + 1]
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n === '\\' || n === c ? n : `\\${n}`
          j += 2
        } else s += src[j++]
      }
      if (j >= src.length) throw new JinjaError('unexpected end of template, expected a closing quote')
      out.push({ t: 'str', v: s })
      i = j + 1
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_]\w*/.exec(src.slice(i))!
      out.push({ t: 'name', v: m[0] })
      i += m[0].length
      continue
    }
    const op = OPS.find((o) => src.startsWith(o, i))
    if (!op) throw new JinjaError(`unexpected char '${c}' at ${i}`)
    out.push({ t: 'op', v: op })
    i += op.length
  }
  out.push({ t: 'end', v: '' })
  return out
}

type Node =
  | { k: 'lit'; v: unknown }
  | { k: 'name'; n: string }
  | { k: 'list'; items: Node[] }
  | { k: 'dict'; items: [Node, Node][] }
  | { k: 'attr'; o: Node; n: string }
  | { k: 'item'; o: Node; i: Node }
  | { k: 'slice'; o: Node; a?: Node; b?: Node }
  | { k: 'call'; f: Node; args: Node[]; kw: [string, Node][] }
  | { k: 'filter'; o: Node; n: string; args: Node[]; kw: [string, Node][] }
  | { k: 'test'; o: Node; n: string; args: Node[]; not: boolean }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'not'; a: Node }
  | { k: 'neg'; a: Node }
  | { k: 'cond'; c: Node; a: Node; b?: Node }

class Parser {
  i = 0
  constructor(private toks: Tok[]) {}
  peek(o = 0) {
    return this.toks[this.i + o]
  }
  next() {
    return this.toks[this.i++]
  }
  isOp(v: string, o = 0) {
    const t = this.peek(o)
    return t.t === 'op' && t.v === v
  }
  isName(v: string, o = 0) {
    const t = this.peek(o)
    return t.t === 'name' && t.v === v
  }
  expectOp(v: string) {
    const t = this.next()
    if (t.t !== 'op' || t.v !== v) throw new JinjaError(`expected token '${v}', got '${t.t === 'end' ? 'end of statement block' : t.v}'`)
  }
  expectName(): string {
    const t = this.next()
    if (t.t !== 'name') throw new JinjaError(`expected name, got '${t.v}'`)
    return t.v as string
  }
  atEnd() {
    return this.peek().t === 'end'
  }

  expr(): Node {
    let n = this.or()
    while (this.isName('if')) {
      this.next()
      const c = this.or()
      let b: Node | undefined
      if (this.isName('else')) {
        this.next()
        b = this.expr()
      }
      n = { k: 'cond', c, a: n, b }
    }
    return n
  }
  or(): Node {
    let n = this.and()
    while (this.isName('or')) {
      this.next()
      n = { k: 'bin', op: 'or', a: n, b: this.and() }
    }
    return n
  }
  and(): Node {
    let n = this.not()
    while (this.isName('and')) {
      this.next()
      n = { k: 'bin', op: 'and', a: n, b: this.not() }
    }
    return n
  }
  not(): Node {
    if (this.isName('not')) {
      this.next()
      return { k: 'not', a: this.not() }
    }
    return this.compare()
  }
  compare(): Node {
    let n = this.math1()
    for (;;) {
      const t = this.peek()
      if (t.t === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(t.v as string)) {
        this.next()
        n = { k: 'bin', op: t.v as string, a: n, b: this.math1() }
      } else if (this.isName('in')) {
        this.next()
        n = { k: 'bin', op: 'in', a: n, b: this.math1() }
      } else if (this.isName('not') && this.isName('in', 1)) {
        this.next()
        this.next()
        n = { k: 'not', a: { k: 'bin', op: 'in', a: n, b: this.math1() } }
      } else return n
    }
  }
  math1(): Node {
    let n = this.concat()
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next().v as string
      n = { k: 'bin', op, a: n, b: this.concat() }
    }
    return n
  }
  concat(): Node {
    let n = this.math2()
    while (this.isOp('~')) {
      this.next()
      n = { k: 'bin', op: '~', a: n, b: this.math2() }
    }
    return n
  }
  math2(): Node {
    let n = this.pow()
    while (this.isOp('*') || this.isOp('/') || this.isOp('//') || this.isOp('%')) {
      const op = this.next().v as string
      n = { k: 'bin', op, a: n, b: this.pow() }
    }
    return n
  }
  pow(): Node {
    let n = this.unary()
    while (this.isOp('**')) {
      this.next()
      n = { k: 'bin', op: '**', a: n, b: this.unary() }
    }
    return n
  }
  unary(): Node {
    if (this.isOp('-')) {
      this.next()
      return { k: 'neg', a: this.unary() }
    }
    if (this.isOp('+')) {
      this.next()
      return this.unary()
    }
    let n = this.postfix(this.primary())
    // filtros y tests
    for (;;) {
      if (this.isOp('|')) {
        this.next()
        const name = this.dotted()
        const { args, kw } = this.isOp('(') ? this.callArgs() : { args: [], kw: [] }
        n = this.postfix({ k: 'filter', o: n, n: name, args, kw })
      } else if (this.isName('is')) {
        this.next()
        let not = false
        if (this.isName('not')) {
          this.next()
          not = true
        }
        const t = this.peek()
        let name: string
        if (t.t === 'name') name = this.dotted()
        else if (t.t === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(t.v as string)) name = this.next().v as string
        else throw new JinjaError(`expected test name, got '${t.v}'`)
        let args: Node[] = []
        if (this.isOp('(')) args = this.callArgs().args
        else if (!this.atEnd() && (this.peek().t === 'str' || this.peek().t === 'num')) args = [this.primary()]
        n = { k: 'test', o: n, n: name, args, not }
      } else return n
    }
  }
  /** Nombres de filtros con colección (ansible.builtin.to_json → to_json). */
  dotted(): string {
    let name = this.expectName()
    while (this.isOp('.') && this.peek(1).t === 'name') {
      this.next()
      name = this.expectName()
    }
    return name
  }
  callArgs(): { args: Node[]; kw: [string, Node][] } {
    this.expectOp('(')
    const args: Node[] = []
    const kw: [string, Node][] = []
    while (!this.isOp(')')) {
      if (this.peek().t === 'name' && this.isOp('=', 1)) {
        const name = this.expectName()
        this.next()
        kw.push([name, this.expr()])
      } else args.push(this.expr())
      if (!this.isOp(',')) break
      this.next()
    }
    this.expectOp(')')
    return { args, kw }
  }
  postfix(n: Node): Node {
    for (;;) {
      if (this.isOp('.')) {
        this.next()
        const t = this.next()
        if (t.t === 'num') n = { k: 'item', o: n, i: { k: 'lit', v: t.v } }
        else if (t.t === 'name') n = { k: 'attr', o: n, n: t.v as string }
        else throw new JinjaError(`expected name after '.', got '${t.v}'`)
      } else if (this.isOp('[')) {
        this.next()
        if (this.isOp(':')) {
          this.next()
          const b = this.isOp(']') ? undefined : this.expr()
          this.expectOp(']')
          n = { k: 'slice', o: n, b }
          continue
        }
        const i = this.expr()
        if (this.isOp(':')) {
          this.next()
          const b = this.isOp(']') ? undefined : this.expr()
          this.expectOp(']')
          n = { k: 'slice', o: n, a: i, b }
          continue
        }
        this.expectOp(']')
        n = { k: 'item', o: n, i }
      } else if (this.isOp('(')) {
        const { args, kw } = this.callArgs()
        n = { k: 'call', f: n, args, kw }
      } else return n
    }
  }
  primary(): Node {
    const t = this.next()
    if (t.t === 'num' || t.t === 'str') {
      let v = t.v
      // "a" "b" se concatenan, como en Python
      while (t.t === 'str' && this.peek().t === 'str') v = `${v}${this.next().v}`
      return { k: 'lit', v }
    }
    if (t.t === 'name') {
      const n = t.v as string
      if (n === 'true' || n === 'True') return { k: 'lit', v: true }
      if (n === 'false' || n === 'False') return { k: 'lit', v: false }
      if (n === 'none' || n === 'None' || n === 'null') return { k: 'lit', v: null }
      return { k: 'name', n }
    }
    if (t.t === 'op' && t.v === '(') {
      const e = this.expr()
      if (this.isOp(',')) {
        const items = [e]
        while (this.isOp(',')) {
          this.next()
          if (this.isOp(')')) break
          items.push(this.expr())
        }
        this.expectOp(')')
        return { k: 'list', items }
      }
      this.expectOp(')')
      return e
    }
    if (t.t === 'op' && t.v === '[') {
      const items: Node[] = []
      while (!this.isOp(']')) {
        items.push(this.expr())
        if (!this.isOp(',')) break
        this.next()
      }
      this.expectOp(']')
      return { k: 'list', items }
    }
    if (t.t === 'op' && t.v === '{') {
      const items: [Node, Node][] = []
      while (!this.isOp('}')) {
        const k = this.expr()
        this.expectOp(':')
        items.push([k, this.expr()])
        if (!this.isOp(',')) break
        this.next()
      }
      this.expectOp('}')
      return { k: 'dict', items }
    }
    if (t.t === 'end') throw new JinjaError('unexpected end of template')
    throw new JinjaError(`unexpected '${t.v}'`)
  }
}

export function parseExpr(src: string): Node {
  const p = new Parser(lex(src))
  const n = p.expr()
  if (!p.atEnd()) throw new JinjaError(`expected token 'end of print statement', got '${p.peek().v}'`)
  return n
}

interface Env {
  scope: Scope
  opts: RenderOptions
}

function lookupName(env: Env, n: string): unknown {
  if (n in env.scope) {
    const v = env.scope[n]
    return v === undefined ? new Undef(n) : v
  }
  if (env.opts.globals && n in env.opts.globals) return env.opts.globals[n]
  if (n === 'range')
    return (a: unknown, b?: unknown, s?: unknown) => {
      const [start, stop, step] = b === undefined ? [0, Number(a), 1] : [Number(a), Number(b), Number(s ?? 1)]
      const out: number[] = []
      for (let i = start; step > 0 ? i < stop : i > stop; i += step) out.push(i)
      return out
    }
  if (n === 'dict') return (...args: unknown[]) => splitArgs(args).kw
  return new Undef(n)
}

function strMethod(s: string, name: string): ((...a: unknown[]) => unknown) | undefined {
  const m: Record<string, (...a: unknown[]) => unknown> = {
    upper: () => s.toUpperCase(),
    lower: () => s.toLowerCase(),
    strip: (c?: unknown) => (c ? s.replace(new RegExp(`^[${c}]+|[${c}]+$`, 'g'), '') : s.trim()),
    lstrip: () => s.trimStart(),
    rstrip: (c?: unknown) => (c ? s.replace(new RegExp(`[${c}]+$`), '') : s.trimEnd()),
    split: (sep?: unknown, max?: unknown) => {
      const parts = sep === undefined || sep === null ? s.trim().split(/\s+/).filter(Boolean) : s.split(String(sep))
      if (max === undefined) return parts
      const n = Number(max)
      return parts.length > n + 1 ? [...parts.slice(0, n), parts.slice(n).join(String(sep ?? ' '))] : parts
    },
    startswith: (p) => s.startsWith(String(p)),
    endswith: (p) => s.endsWith(String(p)),
    replace: (a, b) => s.split(String(a)).join(String(b)),
    join: (xs) => iterate(xs).map(pyStr).join(s),
    format: (...xs) => {
      let i = 0
      return s.replace(/\{(\d*)\}/g, (_m, n) => pyStr(xs[n === '' ? i++ : Number(n)]))
    },
    find: (x) => s.indexOf(String(x)),
    count: (x) => s.split(String(x)).length - 1,
    isdigit: () => /^\d+$/.test(s),
    splitlines: () => s.split(/\r?\n/).filter((l, i, a) => !(i === a.length - 1 && l === '')),
    capitalize: () => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(),
  }
  return m[name]
}

function getAttr(o: unknown, n: string, label: string): unknown {
  if (o instanceof Undef) throw new JinjaError(`'${o.name}' is undefined`)
  if (typeof o === 'string') return strMethod(o, n) ?? new Undef(`${label}.${n}`)
  if (isDict(o)) {
    if (n in o) return o[n]
    const methods: Record<string, (...a: unknown[]) => unknown> = {
      items: () => Object.entries(o),
      keys: () => Object.keys(o),
      values: () => Object.values(o),
      get: (k, d = null) => (String(k) in o ? o[String(k)] : d),
    }
    if (n in methods) return methods[n]
    return new Undef(`${label}.${n}`)
  }
  if (Array.isArray(o)) {
    if (n === 'index') return (x: unknown) => o.findIndex((y) => eq(x, y))
    if (n === 'count') return (x: unknown) => o.filter((y) => eq(x, y)).length
    return new Undef(`${label}.${n}`)
  }
  if (o === null) throw new JinjaError(`'None' has no attribute '${n}'`)
  return new Undef(`${label}.${n}`)
}

function label(n: Node): string {
  if (n.k === 'name') return n.n
  if (n.k === 'attr') return `${label(n.o)}.${n.n}`
  if (n.k === 'item') return `${label(n.o)}[...]`
  return 'value'
}

function evalNode(n: Node, env: Env): unknown {
  switch (n.k) {
    case 'lit':
      return n.v
    case 'name':
      return lookupName(env, n.n)
    case 'list':
      return n.items.map((x) => evalNode(x, env))
    case 'dict':
      return Object.fromEntries(n.items.map(([k, v]) => [pyStr(evalNode(k, env)), evalNode(v, env)]))
    case 'attr': {
      const o = evalNode(n.o, env)
      if (o instanceof Undef) throw new JinjaError(`'${o.name}' is undefined`)
      const v = getAttr(o, n.n, label(n.o))
      if (v instanceof Undef && isDict(o)) return new Undef(`${pyRepr(o).length > 80 ? 'dict object' : pyRepr(o)}' has no attribute '${n.n}`)
      return v
    }
    case 'item': {
      const o = evalNode(n.o, env)
      const i = evalNode(n.i, env)
      if (o instanceof Undef) throw new JinjaError(`'${o.name}' is undefined`)
      if (Array.isArray(o) || typeof o === 'string') {
        const idx = Number(i) < 0 ? o.length + Number(i) : Number(i)
        if (idx < 0 || idx >= o.length) throw new JinjaError(`list object has no element ${i}`)
        return o[idx]
      }
      if (isDict(o)) return String(i) in o ? o[String(i)] : new Undef(`dict object' has no attribute '${pyStr(i)}`)
      throw new JinjaError(`'${typeName(o)}' object is not subscriptable`)
    }
    case 'slice': {
      const o = evalNode(n.o, env)
      if (!Array.isArray(o) && typeof o !== 'string') throw new JinjaError(`'${typeName(o)}' object is not subscriptable`)
      const a = n.a ? Number(evalNode(n.a, env)) : undefined
      const b = n.b ? Number(evalNode(n.b, env)) : undefined
      return o.slice(a, b)
    }
    case 'call': {
      const f = evalNode(n.f, env)
      if (typeof f !== 'function') {
        if (f instanceof Undef) throw new JinjaError(`'${f.name}' is undefined`)
        throw new JinjaError(`'${typeName(f)}' object is not callable`)
      }
      const args = n.args.map((x) => evalNode(x, env))
      if (n.kw.length) args.push(new Kwargs(Object.fromEntries(n.kw.map(([k, v]) => [k, evalNode(v, env)]))))
      return (f as (...a: unknown[]) => unknown)(...args)
    }
    case 'filter': {
      const f = env.opts.filters?.[n.n] ?? FILTERS[n.n]
      if (!f) throw new JinjaError(`Could not load "${n.n}": 'No filter named '${n.n}'.'`)
      const v = evalNode(n.o, env)
      const args = n.args.map((x) => evalNode(x, env))
      if (n.kw.length) args.push(new Kwargs(Object.fromEntries(n.kw.map(([k, x]) => [k, evalNode(x, env)]))))
      if (v instanceof Undef && !['default', 'd', 'mandatory'].includes(n.n)) throw new JinjaError(`'${v.name}' is undefined`)
      return f(v, ...args)
    }
    case 'test': {
      const v = evalNode(n.o, env)
      const args = n.args.map((x) => evalNode(x, env))
      if (v instanceof Undef && !['defined', 'undefined'].includes(n.n)) throw new JinjaError(`'${v.name}' is undefined`)
      const r = runTest(n.n, v, args)
      return n.not ? !r : r
    }
    case 'not':
      return !truthy(strict(evalNode(n.a, env)))
    case 'neg':
      return -Number(strict(evalNode(n.a, env)))
    case 'cond':
      return truthy(strict(evalNode(n.c, env))) ? evalNode(n.a, env) : n.b ? evalNode(n.b, env) : ''
    case 'bin': {
      if (n.op === 'and') {
        const a = strict(evalNode(n.a, env))
        return truthy(a) ? strict(evalNode(n.b, env)) : a
      }
      if (n.op === 'or') {
        const a = strict(evalNode(n.a, env))
        return truthy(a) ? a : strict(evalNode(n.b, env))
      }
      const a = strict(evalNode(n.a, env))
      const b = strict(evalNode(n.b, env))
      switch (n.op) {
        case '==':
          return eq(a, b)
        case '!=':
          return !eq(a, b)
        case '<':
          return cmp(a, b) < 0
        case '>':
          return cmp(a, b) > 0
        case '<=':
          return cmp(a, b) <= 0
        case '>=':
          return cmp(a, b) >= 0
        case 'in':
          return contains(b, a)
        case '~':
          return pyStr(a) + pyStr(b)
        case '+':
          if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b]
          if (typeof a === 'string' && typeof b === 'string') return a + b
          if (typeof a === 'number' && typeof b === 'number') return a + b
          throw new JinjaError(`unsupported operand type(s) for +: '${typeName(a)}' and '${typeName(b)}'`)
        case '-':
          return num(a, '-', b) - num(b, '-', a)
        case '*':
          if (typeof a === 'string' && typeof b === 'number') return a.repeat(b)
          return num(a, '*', b) * num(b, '*', a)
        case '/':
          if (num(b, '/', a) === 0) throw new JinjaError('division by zero')
          return num(a, '/', b) / num(b, '/', a)
        case '//':
          if (num(b, '//', a) === 0) throw new JinjaError('integer division or modulo by zero')
          return Math.floor(num(a, '//', b) / num(b, '//', a))
        case '%':
          return ((num(a, '%', b) % num(b, '%', a)) + num(b, '%', a)) % num(b, '%', a)
        case '**':
          return num(a, '**', b) ** num(b, '**', a)
      }
    }
  }
  throw new JinjaError('expresión no soportada')
}

function strict(v: unknown): unknown {
  if (v instanceof Undef) throw new JinjaError(`'${v.name}' is undefined`)
  return v
}

function num(v: unknown, op: string, other: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return Number(v)
  throw new JinjaError(`unsupported operand type(s) for ${op}: '${typeName(v)}' and '${typeName(other)}'`)
}

/** Evalúa una expresión suelta (un when, un that, un loop sin llaves). */
export function evaluate(expr: string, scope: Scope, opts: RenderOptions = {}): unknown {
  return evalNode(parseExpr(expr), { scope, opts })
}

// ---------------------------------------------------------------------------------------
// Plantillas
// ---------------------------------------------------------------------------------------

type TNode = { k: 'text'; s: string } | { k: 'out'; e: Node } | { k: 'if'; branches: { c?: Node; body: TNode[] }[] } | { k: 'for'; vars: string[]; it: Node; cond?: Node; body: TNode[]; else: TNode[] } | { k: 'set'; name: string; e: Node }

interface RawTok {
  k: 'text' | 'var' | 'block'
  s: string
  line: number
}

function tokenize(src: string, opts: RenderOptions): RawTok[] {
  const out: RawTok[] = []
  let i = 0
  let line = 1
  const trimBlocks = opts.trimBlocks ?? true
  while (i < src.length) {
    const m = /\{\{|\{%|\{#/.exec(src.slice(i))
    if (!m) {
      out.push({ k: 'text', s: src.slice(i), line })
      break
    }
    const start = i + m.index
    let text = src.slice(i, start)
    const tag = m[0]
    const strip = src[start + 2] === '-'
    if (strip) text = text.replace(/\s+$/, '')
    else if (opts.lstripBlocks && tag !== '{{') text = text.replace(/[ \t]+$/, (ws) => (/(^|\n)[ \t]*$/.test(text) ? '' : ws))
    if (text) out.push({ k: 'text', s: text, line })
    line += src.slice(i, start).split('\n').length - 1
    const close = tag === '{{' ? '}}' : tag === '{%' ? '%}' : '#}'
    let j = start + 2 + (strip ? 1 : 0)
    // buscar el cierre fuera de comillas
    let q: string | null = null
    let end = -1
    let depth = 0
    for (; j < src.length; j++) {
      const c = src[j]
      if (q) {
        if (c === '\\') j++
        else if (c === q) q = null
      } else if (c === '"' || c === "'") q = c
      else if (depth === 0 && src.startsWith(close, j)) {
        end = j
        break
      } else if (tag !== '{#' && '{[('.includes(c)) depth++
      else if (tag !== '{#' && '}])'.includes(c) && depth > 0) depth--
    }
    if (end < 0) throw new JinjaError(tag === '{#' ? 'Missing end of comment tag' : `unexpected end of template, expected '${close}'.`)
    const rstrip = src[end - 1] === '-' && end - 1 >= start + 2
    const inner = src.slice(start + 2 + (strip ? 1 : 0), rstrip ? end - 1 : end).trim()
    line += src.slice(start, end).split('\n').length - 1
    i = end + 2
    if (tag === '{%' && /^raw$/.test(inner)) {
      const r = /\{%-?\s*endraw\s*-?%\}/.exec(src.slice(i))
      if (!r) throw new JinjaError("Unexpected end of template. Jinja was looking for the following tags: 'endraw'.")
      let raw = src.slice(i, i + r.index)
      if (trimBlocks && raw.startsWith('\n')) raw = raw.slice(1)
      out.push({ k: 'text', s: raw, line })
      line += raw.split('\n').length - 1
      i += r.index + r[0].length
      if (trimBlocks && src[i] === '\n') i++
      continue
    }
    if (tag === '{{') out.push({ k: 'var', s: inner, line })
    else if (tag === '{%') out.push({ k: 'block', s: inner, line })
    if (rstrip) {
      while (i < src.length && /\s/.test(src[i])) i++
    } else if (tag !== '{{' && trimBlocks && src[i] === '\n') {
      i++
      line++
    }
  }
  return out
}

function parseTemplate(src: string, opts: RenderOptions): TNode[] {
  const toks = tokenize(src, opts)
  let pos = 0
  const body = (ends: string[]): { nodes: TNode[]; end: string } => {
    const nodes: TNode[] = []
    while (pos < toks.length) {
      const t = toks[pos++]
      if (t.k === 'text') nodes.push({ k: 'text', s: t.s })
      else if (t.k === 'var') nodes.push({ k: 'out', e: withLine(() => parseExpr(t.s), t.line) })
      else {
        const word = /^\w+/.exec(t.s)?.[0] ?? ''
        const rest = t.s.slice(word.length).trim()
        if (ends.includes(word)) {
          pos--
          return { nodes, end: word }
        }
        if (word === 'if') {
          const branches: { c?: Node; body: TNode[] }[] = []
          let cond: Node | undefined = withLine(() => parseExpr(rest), t.line)
          for (;;) {
            const b = body(['elif', 'else', 'endif'])
            branches.push({ c: cond, body: b.nodes })
            const endTok = toks[pos++]
            if (!endTok) throw new JinjaError("Unexpected end of template. Jinja was looking for the following tags: 'elif' or 'else' or 'endif'. The innermost block that needs to be closed is 'if'.")
            if (b.end === 'endif') break
            cond = b.end === 'elif' ? withLine(() => parseExpr(endTok.s.slice(4).trim()), endTok.line) : undefined
          }
          nodes.push({ k: 'if', branches })
        } else if (word === 'for') {
          const m = /^(\w+(?:\s*,\s*\w+)*)\s+in\s+([\s\S]+?)(?:\s+if\s+([\s\S]+))?$/.exec(rest)
          if (!m) throw new JinjaError(`line ${t.line}: expected 'in'`)
          const vars = m[1].split(',').map((x) => x.trim())
          const it = withLine(() => parseExpr(m[2]), t.line)
          const cond = m[3] ? withLine(() => parseExpr(m[3]), t.line) : undefined
          const b = body(['else', 'endfor'])
          let els: TNode[] = []
          pos++
          if (b.end === 'else') {
            const e = body(['endfor'])
            els = e.nodes
            pos++
          }
          if (pos > toks.length) throw new JinjaError("Unexpected end of template. Jinja was looking for the following tags: 'endfor' or 'else'. The innermost block that needs to be closed is 'for'.")
          nodes.push({ k: 'for', vars, it, cond, body: b.nodes, else: els })
        } else if (word === 'set') {
          const m = /^(\w+)\s*=\s*([\s\S]+)$/.exec(rest)
          if (!m) throw new JinjaError(`line ${t.line}: expected '=' in set`)
          nodes.push({ k: 'set', name: m[1], e: withLine(() => parseExpr(m[2]), t.line) })
        } else if (['endif', 'endfor', 'elif', 'else'].includes(word)) {
          throw new JinjaError(`line ${t.line}: Encountered unknown tag '${word}'.`)
        } else throw new JinjaError(`line ${t.line}: Encountered unknown tag '${word}'.`)
      }
    }
    if (ends.length) throw new JinjaError(`Unexpected end of template. Jinja was looking for the following tags: ${ends.map((e) => `'${e}'`).join(' or ')}.`)
    return { nodes, end: '' }
  }
  return body([]).nodes
}

function withLine<T>(fn: () => T, line: number): T {
  try {
    return fn()
  } catch (e) {
    if (e instanceof JinjaError && !/^line \d+/.test(e.message)) throw new JinjaError(`line ${line}: ${e.message}`)
    throw e
  }
}

function exec(nodes: TNode[], env: Env, out: string[]) {
  for (const n of nodes) {
    if (n.k === 'text') out.push(n.s)
    else if (n.k === 'out') out.push(pyStr(evalNode(n.e, env)))
    else if (n.k === 'set') env.scope[n.name] = evalNode(n.e, env)
    else if (n.k === 'if') {
      const b = n.branches.find((x) => !x.c || truthy(strict(evalNode(x.c, env))))
      if (b) exec(b.body, env, out)
    } else if (n.k === 'for') {
      const raw = evalNode(n.it, env)
      let items = iterate(raw)
      const unpack = (item: unknown): Scope => {
        if (n.vars.length === 1) return { [n.vars[0]]: item }
        const parts = Array.isArray(item) ? item : iterate(item)
        return Object.fromEntries(n.vars.map((v, i) => [v, parts[i]]))
      }
      if (n.cond) items = items.filter((it) => truthy(evalNode(n.cond!, { scope: child(env.scope, unpack(it)), opts: env.opts })))
      if (!items.length) {
        exec(n.else, env, out)
        continue
      }
      items.forEach((it, i) => {
        const loop = { index: i + 1, index0: i, first: i === 0, last: i === items.length - 1, length: items.length, revindex: items.length - i, revindex0: items.length - i - 1 }
        const inner: Env = { scope: child(env.scope, { ...unpack(it), loop }), opts: env.opts }
        exec(n.body, inner, out)
      })
    }
  }
}

/** Un alcance nuevo que ve el anterior sin copiarlo (así no se resuelve todo de entrada). */
function child(parent: Scope, own: Scope): Scope {
  return Object.assign(Object.create(parent) as Scope, own)
}

/** Arma el texto de una plantilla. */
export function render(src: string, scope: Scope, opts: RenderOptions = {}): string {
  const nodes = parseTemplate(src, opts)
  const out: string[] = []
  exec(nodes, { scope: child(scope, {}), opts }, out)
  return out.join('')
}

/** ¿Tiene algo para resolver? */
export const hasJinja = (s: string) => /\{\{|\{%/.test(s)

/**
 * Resuelve un valor de Ansible: los textos con {{ }} se arman, y si el texto es una sola
 * expresión, devuelve el valor con su tipo (una lista sigue siendo una lista).
 */
export function templateValue(v: unknown, scope: Scope, opts: RenderOptions = {}, depth = 0): unknown {
  if (depth > 20) throw new JinjaError('recursive loop detected in template string')
  if (typeof v === 'string') {
    if (!hasJinja(v)) return v
    const toks = /^\s*\{\{/.test(v) && /\}\}\s*$/.test(v) ? tokenize(v.trim(), opts) : []
    if (toks.length === 1 && toks[0].k === 'var') {
      const r = evaluate(toks[0].s, scope, opts)
      if (r instanceof Undef) throw new JinjaError(`'${r.name}' is undefined`)
      return typeof r === 'string' && hasJinja(r) ? templateValue(r, scope, opts, depth + 1) : r
    }
    return render(v, scope, opts)
  }
  if (Array.isArray(v)) return v.map((x) => templateValue(x, scope, opts, depth))
  if (isDict(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, templateValue(x, scope, opts, depth)]))
  return v
}

/**
 * Una vista de las variables que resuelve las plantillas al leerlas (como Ansible, que deja
 * "{{ otra }}" sin resolver hasta que se usa).
 */
export function lazyScope(vars: Scope, opts: RenderOptions = {}): Scope {
  const cache = new Map<string, unknown>()
  const resolving = new Set<string>()
  const scope: Scope = new Proxy(vars, {
    get(target, key) {
      if (typeof key !== 'string') return undefined
      if (!(key in target)) return undefined
      if (cache.has(key)) return cache.get(key)
      if (resolving.has(key)) throw new JinjaError(`recursive loop detected in template string: {{ ${key} }}`)
      resolving.add(key)
      try {
        const v = templateValue(target[key], scope, opts)
        cache.set(key, v)
        return v
      } finally {
        resolving.delete(key)
      }
    },
    has: (target, key) => key in target,
  })
  return scope
}
