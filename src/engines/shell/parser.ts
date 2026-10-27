/**
 * Analizador de la sintaxis de bash: comillas, variables, sustitución de comandos, aritmética,
 * tuberías, redirecciones, here-documents, if/for/while/until/case, funciones y subshells.
 */

export type Part =
  | { t: 'lit'; v: string; q: boolean }
  | { t: 'var'; name: string; q: boolean; op?: string; arg?: string }
  | { t: 'cmd'; src: string; q: boolean }
  | { t: 'arith'; expr: string; q: boolean }

export interface Word {
  parts: Part[]
}

export interface Redir {
  op: '>' | '>>' | '<' | '2>' | '2>>' | '&>' | '&>>' | '2>&1' | '>&2' | '<<' | '<<<'
  target?: Word
  heredoc?: { body: string; expand: boolean }
}

export type Node =
  | { kind: 'simple'; assigns: { name: string; value: Word }[]; words: Word[]; redirs: Redir[] }
  | { kind: 'pipeline'; negate: boolean; cmds: Node[] }
  | { kind: 'andor'; first: Node; rest: { op: '&&' | '||'; node: Node }[] }
  | { kind: 'list'; items: Node[] }
  | { kind: 'if'; clauses: { cond: Node; body: Node }[]; elseBody?: Node; redirs: Redir[] }
  | { kind: 'for'; name: string; items: Word[] | null; body: Node; redirs: Redir[] }
  | { kind: 'while'; until: boolean; cond: Node; body: Node; redirs: Redir[] }
  | { kind: 'case'; word: Word; items: { patterns: Word[]; body: Node }[]; redirs: Redir[] }
  | { kind: 'group'; body: Node; subshell: boolean; redirs: Redir[] }
  | { kind: 'func'; name: string; body: Node }

export class IncompleteInput extends Error {
  constructor() {
    super('incomplete')
  }
}

export class ShellSyntaxError extends Error {}

type Token =
  | { type: 'word'; word: Word; raw: string; plain: boolean }
  | { type: 'op'; op: string; heredoc?: { body: string; expand: boolean } }
  | { type: 'nl' }
  | { type: 'eof' }

const OP_CHARS = new Set(['|', '&', ';', '<', '>', '(', ')'])
const RESERVED = new Set(['if', 'then', 'elif', 'else', 'fi', 'for', 'in', 'do', 'done', 'while', 'until', 'case', 'esac', 'function', '{', '}', '!', '[[', ']]'])

/** Busca el cierre de $( ... ) respetando comillas y anidamiento. */
function matchParen(src: string, start: number): number {
  let depth = 1
  let i = start
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1)
      if (end < 0) throw new IncompleteInput()
      i = end + 1
      continue
    }
    if (c === '"') {
      i++
      while (i < src.length && src[i] !== '"') i += src[i] === '\\' ? 2 : 1
      if (i >= src.length) throw new IncompleteInput()
      i++
      continue
    }
    if (c === '(') depth++
    if (c === ')') {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  throw new IncompleteInput()
}

export function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  const pendingHeredocs: { delim: string; strip: boolean; token: { heredoc?: { body: string; expand: boolean } }; expand: boolean }[] = []
  let i = 0

  const readDollar = (quoted: boolean): Part => {
    // src[i] === '$'
    const next = src[i + 1]
    if (next === '(' && src[i + 2] === '(') {
      const end = matchParen(src, i + 3)
      if (src[end + 1] !== ')') throw new ShellSyntaxError('bash: syntax error in arithmetic expression')
      const expr = src.slice(i + 3, end)
      i = end + 2
      return { t: 'arith', expr, q: quoted }
    }
    if (next === '(') {
      const end = matchParen(src, i + 2)
      const inner = src.slice(i + 2, end)
      i = end + 1
      return { t: 'cmd', src: inner, q: quoted }
    }
    if (next === '{') {
      const end = src.indexOf('}', i + 2)
      if (end < 0) throw new IncompleteInput()
      const body = src.slice(i + 2, end)
      i = end + 1
      const m = /^(#?)([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[?$#@*])(?:(:?[-=+?])(.*))?$/s.exec(body)
      if (!m) throw new ShellSyntaxError(`bash: \${${body}}: bad substitution`)
      if (m[1]) return { t: 'var', name: m[2], q: quoted, op: '#' }
      return { t: 'var', name: m[2], q: quoted, op: m[3], arg: m[4] }
    }
    const special = /^[?$#@*0-9!]/.exec(next ?? '')
    if (special) {
      i += 2
      return { t: 'var', name: special[0], q: quoted }
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i + 1))
    if (m) {
      i += 1 + m[0].length
      return { t: 'var', name: m[0], q: quoted }
    }
    i++
    return { t: 'lit', v: '$', q: quoted }
  }

  const readWord = (): Token => {
    const parts: Part[] = []
    let raw = ''
    let plain = true
    const pushLit = (v: string, q: boolean) => {
      const last = parts[parts.length - 1]
      if (last && last.t === 'lit' && last.q === q) last.v += v
      else parts.push({ t: 'lit', v, q })
    }
    while (i < src.length) {
      const c = src[i]
      if (c === ' ' || c === '\t' || c === '\n' || OP_CHARS.has(c)) break
      if (c === '\\') {
        if (src[i + 1] === '\n') {
          i += 2
          continue
        }
        if (i + 1 >= src.length) throw new IncompleteInput()
        pushLit(src[i + 1], true)
        plain = false
        raw += src[i + 1]
        i += 2
        continue
      }
      if (c === "'") {
        const end = src.indexOf("'", i + 1)
        if (end < 0) throw new IncompleteInput()
        pushLit(src.slice(i + 1, end), true)
        plain = false
        i = end + 1
        continue
      }
      if (c === '"') {
        plain = false
        i++
        let buf = ''
        let closed = false
        while (i < src.length) {
          const d = src[i]
          if (d === '"') {
            closed = true
            i++
            break
          }
          if (d === '\\' && i + 1 < src.length && '$`"\\\n'.includes(src[i + 1])) {
            if (src[i + 1] !== '\n') buf += src[i + 1]
            i += 2
            continue
          }
          if (d === '$') {
            if (buf) pushLit(buf, true)
            buf = ''
            parts.push(readDollar(true))
            continue
          }
          if (d === '`') {
            if (buf) pushLit(buf, true)
            buf = ''
            const end = src.indexOf('`', i + 1)
            if (end < 0) throw new IncompleteInput()
            parts.push({ t: 'cmd', src: src.slice(i + 1, end), q: true })
            i = end + 1
            continue
          }
          buf += d
          i++
        }
        if (!closed) throw new IncompleteInput()
        if (buf || parts.length === 0) pushLit(buf, true)
        continue
      }
      if (c === '$') {
        plain = false
        parts.push(readDollar(false))
        continue
      }
      if (c === '`') {
        plain = false
        const end = src.indexOf('`', i + 1)
        if (end < 0) throw new IncompleteInput()
        parts.push({ t: 'cmd', src: src.slice(i + 1, end), q: false })
        i = end + 1
        continue
      }
      pushLit(c, false)
      raw += c
      i++
    }
    return { type: 'word', word: { parts }, raw, plain }
  }

  const readHeredocBodies = () => {
    for (const h of pendingHeredocs) {
      const lines: string[] = []
      let found = false
      while (i < src.length) {
        const nl = src.indexOf('\n', i)
        const line = nl < 0 ? src.slice(i) : src.slice(i, nl)
        i = nl < 0 ? src.length : nl + 1
        const cmp = h.strip ? line.replace(/^\t+/, '') : line
        if (cmp === h.delim) {
          found = true
          break
        }
        lines.push(h.strip ? line.replace(/^\t+/, '') : line)
      }
      if (!found) throw new IncompleteInput()
      h.token.heredoc = { body: lines.length ? lines.join('\n') + '\n' : '', expand: h.expand }
    }
    pendingHeredocs.length = 0
  }

  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t') {
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
      tokens.push({ type: 'nl' })
      i++
      if (pendingHeredocs.length) readHeredocBodies()
      continue
    }
    // Redirecciones con descriptor: 2> 2>> 2>&1 1>&2
    if ((c === '2' || c === '1') && (src[i + 1] === '>' || (c === '1' && src[i + 1] === '>'))) {
      const rest = src.slice(i)
      const m = /^(2>&1|1>&2|2>>|2>|1>>|1>)/.exec(rest)
      if (m) {
        const op = m[1] === '1>&2' ? '>&2' : m[1] === '1>' ? '>' : m[1] === '1>>' ? '>>' : m[1]
        tokens.push({ type: 'op', op })
        i += m[1].length
        continue
      }
    }
    if (OP_CHARS.has(c)) {
      const three = src.slice(i, i + 3)
      const two = src.slice(i, i + 2)
      let op: string
      if (three === '<<-' || three === '&>>' || three === '<<<') op = three
      else if (['||', '&&', ';;', '>>', '<<', '&>', '>&'].includes(two)) op = two
      else op = c
      if (op === '>&' && src[i + 2] === '2') {
        op = '>&2'
      }
      i += op.length
      if (op === '<<' || op === '<<-') {
        while (src[i] === ' ' || src[i] === '\t') i++
        const delimTok = readWord()
        if (delimTok.type !== 'word') throw new ShellSyntaxError('bash: syntax error near unexpected token `newline\'')
        const delim = delimTok.word.parts.map((p) => (p.t === 'lit' ? p.v : '')).join('')
        if (!delim) throw new ShellSyntaxError("bash: syntax error near unexpected token `newline'")
        const tok: { type: 'op'; op: string; heredoc?: { body: string; expand: boolean } } = { type: 'op', op: '<<' }
        tokens.push(tok)
        pendingHeredocs.push({ delim, strip: op === '<<-', token: tok, expand: delimTok.plain })
        continue
      }
      tokens.push({ type: 'op', op })
      continue
    }
    tokens.push(readWord())
  }
  if (pendingHeredocs.length) throw new IncompleteInput()
  tokens.push({ type: 'eof' })
  return tokens
}

// ---------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------

const REDIR_OPS = new Set(['>', '>>', '<', '2>', '2>>', '&>', '&>>', '2>&1', '>&2', '<<', '<<<'])

export function parse(src: string): Node {
  const tokens = tokenize(src)
  let pos = 0
  const peek = () => tokens[pos]
  const next = () => tokens[pos++]
  const isWord = (t: Token, value?: string) => t.type === 'word' && t.plain && (value === undefined || t.raw === value)
  const isOp = (t: Token, op?: string) => t.type === 'op' && (op === undefined || t.op === op)
  const fail = (t: Token): never => {
    if (t.type === 'eof') throw new IncompleteInput()
    const shown = t.type === 'word' ? t.raw : t.type === 'op' ? t.op : 'newline'
    throw new ShellSyntaxError(`bash: syntax error near unexpected token \`${shown}'`)
  }
  const skipNl = () => {
    while (peek().type === 'nl') next()
  }
  const expectWord = (value: string) => {
    skipNl()
    const t = next()
    if (!isWord(t, value)) fail(t)
  }

  function parseRedirs(redirs: Redir[]) {
    while (isOp(peek()) && REDIR_OPS.has((peek() as { op: string }).op)) {
      const t = next() as { type: 'op'; op: string; heredoc?: { body: string; expand: boolean } }
      if (t.op === '2>&1' || t.op === '>&2') {
        redirs.push({ op: t.op })
        continue
      }
      if (t.op === '<<') {
        redirs.push({ op: '<<', heredoc: t.heredoc })
        continue
      }
      const target = next()
      if (target.type !== 'word') fail(target)
      redirs.push({ op: t.op as Redir['op'], target: (target as { word: Word }).word })
    }
  }

  function parseList(terminators: string[]): Node {
    const items: Node[] = []
    skipNl()
    while (true) {
      const t = peek()
      if (t.type === 'eof') break
      if (t.type === 'word' && t.plain && terminators.includes(t.raw)) break
      if (t.type === 'op' && (t.op === ')' || t.op === ';;') && terminators.includes(t.op)) break
      items.push(parseAndOr())
      const sep = peek()
      if (sep.type === 'nl' || (sep.type === 'op' && (sep.op === ';' || sep.op === '&'))) {
        next()
        skipNl()
        continue
      }
      break
    }
    return items.length === 1 ? items[0] : { kind: 'list', items }
  }

  function parseAndOr(): Node {
    const first = parsePipeline()
    const rest: { op: '&&' | '||'; node: Node }[] = []
    while (isOp(peek(), '&&') || isOp(peek(), '||')) {
      const op = (next() as { op: '&&' | '||' }).op
      skipNl()
      rest.push({ op, node: parsePipeline() })
    }
    return rest.length ? { kind: 'andor', first, rest } : first
  }

  function parsePipeline(): Node {
    let negate = false
    if (isWord(peek(), '!')) {
      next()
      negate = true
    }
    const cmds = [parseCommand()]
    while (isOp(peek(), '|')) {
      next()
      skipNl()
      cmds.push(parseCommand())
    }
    return cmds.length === 1 && !negate ? cmds[0] : { kind: 'pipeline', negate, cmds }
  }

  function parseCommand(): Node {
    const t = peek()
    if (t.type === 'eof') throw new IncompleteInput()
    if (t.type === 'op' && t.op === '(') {
      next()
      const body = parseList([')'])
      if (!isOp(next(), ')')) throw new IncompleteInput()
      const redirs: Redir[] = []
      parseRedirs(redirs)
      return { kind: 'group', body, subshell: true, redirs }
    }
    if (t.type === 'word' && t.plain) {
      switch (t.raw) {
        case 'if':
          return parseIf()
        case 'for':
          return parseFor()
        case 'while':
        case 'until':
          return parseWhile(t.raw === 'until')
        case 'case':
          return parseCase()
        case '{': {
          next()
          const body = parseList(['}'])
          expectWord('}')
          const redirs: Redir[] = []
          parseRedirs(redirs)
          return { kind: 'group', body, subshell: false, redirs }
        }
        case 'function': {
          next()
          const nameTok = next()
          if (nameTok.type !== 'word') fail(nameTok)
          if (isOp(peek(), '(')) {
            next()
            if (!isOp(next(), ')')) fail(peek())
          }
          skipNl()
          return { kind: 'func', name: (nameTok as { raw: string }).raw, body: parseCommand() }
        }
      }
      // nombre() { ...; }
      if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(t.raw) && isOp(tokens[pos + 1], '(') && isOp(tokens[pos + 2], ')')) {
        next()
        next()
        next()
        skipNl()
        return { kind: 'func', name: t.raw, body: parseCommand() }
      }
    }
    return parseSimple()
  }

  function parseSimple(): Node {
    const assigns: { name: string; value: Word }[] = []
    const words: Word[] = []
    const redirs: Redir[] = []
    // [[ ... ]]: los operadores && || < > ( ) son parte de la expresión, no de la línea de comandos.
    if (isWord(peek(), '[[')) {
      while (true) {
        const t = next()
        if (t.type === 'eof' || t.type === 'nl') throw new IncompleteInput()
        if (t.type === 'word') {
          words.push(t.word)
          if (t.plain && t.raw === ']]') break
        } else if (t.type === 'op') {
          words.push({ parts: [{ t: 'lit', v: t.op, q: true }] })
        }
      }
      parseRedirs(redirs)
      return { kind: 'simple', assigns, words, redirs }
    }
    while (true) {
      const t = peek()
      if (t.type === 'op' && REDIR_OPS.has(t.op)) {
        parseRedirs(redirs)
        continue
      }
      if (t.type !== 'word') break
      if (words.length === 0) {
        const first = t.word.parts[0]
        if (first && first.t === 'lit' && !first.q) {
          const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(first.v)
          if (m) {
            next()
            const valueParts: Part[] = [{ ...first, v: first.v.slice(m[0].length) }, ...t.word.parts.slice(1)].filter(
              (p) => !(p.t === 'lit' && p.v === ''),
            )
            assigns.push({ name: m[1], value: { parts: valueParts } })
            continue
          }
        }
      }
      next()
      words.push(t.word)
    }
    if (words.length === 0 && assigns.length === 0 && redirs.length === 0) fail(peek())
    return { kind: 'simple', assigns, words, redirs }
  }

  function parseIf(): Node {
    next() // if
    const clauses: { cond: Node; body: Node }[] = []
    const cond = parseList(['then'])
    expectWord('then')
    clauses.push({ cond, body: parseList(['elif', 'else', 'fi']) })
    let elseBody: Node | undefined
    while (true) {
      skipNl()
      const t = next()
      if (isWord(t, 'elif')) {
        const c = parseList(['then'])
        expectWord('then')
        clauses.push({ cond: c, body: parseList(['elif', 'else', 'fi']) })
        continue
      }
      if (isWord(t, 'else')) {
        elseBody = parseList(['fi'])
        expectWord('fi')
        break
      }
      if (isWord(t, 'fi')) break
      fail(t)
    }
    const redirs: Redir[] = []
    parseRedirs(redirs)
    return { kind: 'if', clauses, elseBody, redirs }
  }

  function parseFor(): Node {
    next() // for
    const nameTok = next()
    if (nameTok.type !== 'word') fail(nameTok)
    const name = (nameTok as { raw: string }).raw
    let items: Word[] | null = null
    skipNl()
    if (isWord(peek(), 'in')) {
      next()
      items = []
      while (peek().type === 'word') items.push((next() as { word: Word }).word)
    }
    if (isOp(peek(), ';')) next()
    expectWord('do')
    const body = parseList(['done'])
    expectWord('done')
    const redirs: Redir[] = []
    parseRedirs(redirs)
    return { kind: 'for', name, items, body, redirs }
  }

  function parseWhile(until: boolean): Node {
    next()
    const cond = parseList(['do'])
    expectWord('do')
    const body = parseList(['done'])
    expectWord('done')
    const redirs: Redir[] = []
    parseRedirs(redirs)
    return { kind: 'while', until, cond, body, redirs }
  }

  function parseCase(): Node {
    next() // case
    const wTok = next()
    if (wTok.type !== 'word') fail(wTok)
    expectWord('in')
    const items: { patterns: Word[]; body: Node }[] = []
    skipNl()
    while (!isWord(peek(), 'esac')) {
      if (peek().type === 'eof') throw new IncompleteInput()
      if (isOp(peek(), '(')) next()
      const patterns: Word[] = []
      while (true) {
        const p = next()
        if (p.type !== 'word') fail(p)
        patterns.push((p as { word: Word }).word)
        if (isOp(peek(), '|')) {
          next()
          continue
        }
        break
      }
      if (!isOp(next(), ')')) fail(tokens[pos - 1])
      const body = parseList([';;', 'esac'])
      items.push({ patterns, body })
      if (isOp(peek(), ';;')) next()
      skipNl()
    }
    next() // esac
    const redirs: Redir[] = []
    parseRedirs(redirs)
    return { kind: 'case', word: (wTok as { word: Word }).word, items, redirs }
  }

  const program = parseList([])
  if (peek().type !== 'eof') fail(peek())
  return program
}

export { RESERVED }
