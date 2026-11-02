import { AwkError, runAwk } from '../awk'
import { parseArgs } from '../args'
import { register } from '../shell'
import { FsError } from '../vfs'
import { COLOR, lines, readInputs } from './util'

function bracketPosixClasses(p: string): string {
  return p
    .replace(/\[:alpha:\]/g, 'A-Za-z')
    .replace(/\[:digit:\]/g, '0-9')
    .replace(/\[:alnum:\]/g, 'A-Za-z0-9')
    .replace(/\[:space:\]/g, '\\s')
    .replace(/\[:upper:\]/g, 'A-Z')
    .replace(/\[:lower:\]/g, 'a-z')
    .replace(/\[:punct:\]/g, '!-/:-@[-`{-~')
}

/** Convierte una expresión regular básica (BRE, la de grep sin -E) a la sintaxis de JavaScript. */
export function breToJs(p: string): string {
  let out = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '\\' && i + 1 < p.length) {
      const n = p[++i]
      if ('(){}|+?'.includes(n)) out += n
      else out += '\\' + n
    } else if ('(){}|+?'.includes(c)) out += '\\' + c
    else out += c
  }
  return out
}

register(['grep', 'egrep'], {
  usage: 'grep [OPTION]... PATTERNS [FILE]...',
  summary: '  -i  -v  -n  -c  -l  -r  -E  -F  -w  -o  -A NUM  -B NUM  -C NUM  -e PATTERN',
  run(ctx) {
    const a = parseArgs(ctx.args, {
      flags: { i: ['i', 'ignore-case'], v: ['v', 'invert-match'], n: ['n', 'line-number'], c: ['c', 'count'], l: ['l', 'files-with-matches'], r: ['r', 'R', 'recursive'], E: ['E', 'extended-regexp'], F: ['F', 'fixed-strings'], w: ['w', 'word-regexp'], o: ['o', 'only-matching'], q: ['q', 'quiet', 'silent'], s: ['s', 'no-messages'], H: ['H'], h: ['h'], color: ['color'] },
      values: { e: ['e', 'regexp'], A: ['A', 'after-context'], B: ['B', 'before-context'], C: ['C', 'context'] },
    })
    const extended = a.flags.has('E') || ctx.name === 'egrep'
    let rest = a.rest
    let pattern = a.values.get('e')
    if (pattern === undefined) {
      if (!rest.length) {
        ctx.err("Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.\n")
        return 2
      }
      pattern = rest[0]
      rest = rest.slice(1)
    }
    let source = a.flags.has('F') ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : bracketPosixClasses(extended ? pattern : breToJs(pattern))
    if (a.flags.has('w')) source = `\\b(?:${source})\\b`
    let re: RegExp
    try {
      re = new RegExp(source, a.flags.has('i') ? 'gi' : 'g')
    } catch {
      ctx.err(`grep: Invalid regular expression\n`)
      return 2
    }
    const color = ctx.isTTY
    const after = Number(a.values.get('A') ?? a.values.get('C') ?? 0)
    const before = Number(a.values.get('B') ?? a.values.get('C') ?? 0)

    // Archivos (con -r se recorren directorios).
    let files: { name: string; data: string }[] = []
    let code = 1
    let errored = false
    if (a.flags.has('r')) {
      const roots = rest.length ? rest : ['.']
      for (const r of roots) {
        const abs = ctx.sh.resolve(r)
        try {
          ctx.sys.vfs.walk(
            abs,
            ctx.sh.cred,
            (p, node) => {
              if (node.type !== 'file') return
              try {
                files.push({ name: r.replace(/\/$/, '') + p.slice(abs.length), data: ctx.sys.vfs.readFile(p, ctx.sh.cred) })
              } catch {
                if (!a.flags.has('s')) ctx.err(`grep: ${r.replace(/\/$/, '')}${p.slice(abs.length)}: Permission denied\n`)
                errored = true
              }
            },
            (p) => {
              if (!a.flags.has('s')) ctx.err(`grep: ${r.replace(/\/$/, '')}${p.slice(abs.length)}: Permission denied\n`)
              errored = true
            },
          )
        } catch (e) {
          if (e instanceof FsError) {
            ctx.err(`grep: ${r}: ${e.message}\n`)
            errored = true
          } else throw e
        }
      }
    } else {
      const inputs = readInputs({ ...ctx, name: 'grep' }, rest)
      if (typeof inputs === 'number') return 2
      files = inputs
      if (inputs.length < rest.length) errored = true
    }
    const showName = (a.flags.has('H') || files.length > 1 || a.flags.has('r')) && !a.flags.has('h')
    for (const f of files) {
      const ls = lines(f.data)
      let count = 0
      const printed = new Set<number>()
      const emit = (idx: number, sep: string) => {
        if (printed.has(idx)) return
        printed.add(idx)
        const line = ls[idx]
        const prefix = (showName ? `${color ? '\x1b[35m' : ''}${f.name}${color ? COLOR.reset : ''}${sep}` : '') + (a.flags.has('n') ? `${idx + 1}${sep}` : '')
        const shown = color && !a.flags.has('v') ? line.replace(re, (m) => `${COLOR.match}${m}${COLOR.reset}`) : line
        ctx.out(prefix + shown + '\n')
      }
      for (let i = 0; i < ls.length; i++) {
        re.lastIndex = 0
        const matched = re.test(ls[i]) !== a.flags.has('v')
        if (!matched) continue
        count++
        code = 0
        if (a.flags.has('q')) return 0
        if (a.flags.has('c') || a.flags.has('l')) continue
        if (a.flags.has('o') && !a.flags.has('v')) {
          // matchAll copia lastIndex del test anterior: hay que empezar desde el principio de la línea.
          re.lastIndex = 0
          for (const m of ls[i].matchAll(re)) ctx.out((showName ? `${f.name}:` : '') + (a.flags.has('n') ? `${i + 1}:` : '') + (color ? `${COLOR.match}${m[0]}${COLOR.reset}` : m[0]) + '\n')
          continue
        }
        for (let b = Math.max(0, i - before); b < i; b++) emit(b, '-')
        emit(i, ':')
        for (let n = i + 1; n <= Math.min(ls.length - 1, i + after); n++) {
          re.lastIndex = 0
          if (re.test(ls[n]) === a.flags.has('v')) emit(n, '-')
        }
      }
      if (a.flags.has('c')) ctx.out((showName ? `${f.name}:` : '') + count + '\n')
      if (a.flags.has('l') && count > 0) ctx.out(f.name + '\n')
    }
    return errored && code !== 0 ? 2 : code
  },
})

register('wc', {
  usage: 'wc [OPTION]... [FILE]...',
  summary: '  -l, --lines  -w, --words  -c, --bytes  -m, --chars',
  run(ctx) {
    const a = parseArgs(ctx.args, { flags: { l: ['l', 'lines'], w: ['w', 'words'], c: ['c', 'bytes'], m: ['m', 'chars'] } })
    const inputs = readInputs(ctx, a.rest)
    if (typeof inputs === 'number') return inputs
    const only = a.flags.size > 0
    const totals = [0, 0, 0]
    const rows = inputs.map((inp) => {
      const l = (inp.data.match(/\n/g) ?? []).length
      const w = inp.data.split(/\s+/).filter(Boolean).length
      const c = new TextEncoder().encode(inp.data).length
      totals[0] += l
      totals[1] += w
      totals[2] += c
      return { name: inp.name === '-' ? '' : inp.name, vals: [l, w, c] }
    })
    if (rows.length > 1) rows.push({ name: 'total', vals: totals })
    const width = only && a.flags.size === 1 && inputs.length === 1 ? 0 : Math.max(...rows.flatMap((r) => r.vals.map((v) => String(v).length)))
    for (const r of rows) {
      const parts: number[] = []
      if (!only || a.flags.has('l')) parts.push(r.vals[0])
      if (!only || a.flags.has('w')) parts.push(r.vals[1])
      if (!only || a.flags.has('c') || a.flags.has('m')) parts.push(r.vals[2])
      ctx.out(parts.map((p) => String(p).padStart(width)).join(' ') + (r.name ? ` ${r.name}` : '') + '\n')
    }
    return 0
  },
})

register('sort', {
  usage: 'sort [OPTION]... [FILE]...',
  summary: '  -n  -r  -u  -h  -k FIELD  -t SEP',
  run(ctx) {
    const a = parseArgs(ctx.args, { flags: { n: ['n', 'numeric-sort'], r: ['r', 'reverse'], u: ['u', 'unique'], h: ['h', 'human-numeric-sort'], f: ['f', 'ignore-case'] }, values: { k: ['k', 'key'], t: ['t', 'field-separator'] } })
    const inputs = readInputs(ctx, a.rest)
    if (typeof inputs === 'number') return inputs
    let ls = inputs.flatMap((i) => lines(i.data))
    const sep = a.values.get('t')
    const keySpec = a.values.get('k')
    const keyNum = keySpec ? parseInt(keySpec, 10) : 0
    const numericKey = keySpec?.includes('n') || a.flags.has('n')
    const key = (l: string) => {
      if (!keyNum) return l
      const fields = sep ? l.split(sep) : l.trim().split(/\s+/)
      return fields.slice(keyNum - 1).join(sep ?? ' ')
    }
    const human = (s: string) => {
      const m = /^([\d.]+)([KMGT]?)/i.exec(s.trim())
      if (!m) return 0
      return parseFloat(m[1]) * 1024 ** ' KMGT'.indexOf(m[2].toUpperCase() || ' ')
    }
    ls.sort((x, y) => {
      const kx = key(x)
      const ky = key(y)
      if (a.flags.has('h')) return human(kx) - human(ky)
      if (numericKey) return (parseFloat(kx) || 0) - (parseFloat(ky) || 0) || kx.localeCompare(ky)
      return a.flags.has('f') ? kx.toLowerCase().localeCompare(ky.toLowerCase(), 'en') : kx.localeCompare(ky, 'en')
    })
    if (a.flags.has('r')) ls.reverse()
    if (a.flags.has('u')) ls = ls.filter((l, i) => i === 0 || key(l) !== key(ls[i - 1]))
    if (ls.length) ctx.out(ls.join('\n') + '\n')
    return 0
  },
})

register('uniq', {
  usage: 'uniq [OPTION]... [INPUT]',
  summary: '  -c, --count  -d, --repeated  -u, --unique  -i',
  run(ctx) {
    const a = parseArgs(ctx.args, { flags: { c: ['c', 'count'], d: ['d', 'repeated'], u: ['u', 'unique'], i: ['i', 'ignore-case'] } })
    const inputs = readInputs(ctx, a.rest.slice(0, 1))
    if (typeof inputs === 'number') return inputs
    const ls = lines(inputs[0].data)
    const groups: { line: string; n: number }[] = []
    for (const l of ls) {
      const last = groups[groups.length - 1]
      if (last && (a.flags.has('i') ? last.line.toLowerCase() === l.toLowerCase() : last.line === l)) last.n++
      else groups.push({ line: l, n: 1 })
    }
    for (const g of groups) {
      if (a.flags.has('d') && g.n < 2) continue
      if (a.flags.has('u') && g.n > 1) continue
      ctx.out((a.flags.has('c') ? `${String(g.n).padStart(7)} ` : '') + g.line + '\n')
    }
    return 0
  },
})

register('cut', {
  usage: 'cut OPTION... [FILE]...',
  summary: '  -d DELIM  -f LIST  -c LIST',
  run(ctx) {
    const a = parseArgs(ctx.args, { values: { d: ['d', 'delimiter'], f: ['f', 'fields'], c: ['c', 'characters'] } })
    const list = a.values.get('f') ?? a.values.get('c')
    if (!list) {
      ctx.err('cut: you must specify a list of bytes, characters, or fields\n')
      return 1
    }
    const ranges = list.split(',').map((r) => {
      const [s, e] = r.split('-')
      return { start: s ? Number(s) : 1, end: r.includes('-') ? (e ? Number(e) : Infinity) : Number(s) }
    })
    const inRange = (n: number) => ranges.some((r) => n >= r.start && n <= r.end)
    const inputs = readInputs(ctx, a.rest)
    if (typeof inputs === 'number') return inputs
    const delim = a.values.get('d') ?? '\t'
    for (const l of inputs.flatMap((i) => lines(i.data))) {
      if (a.values.has('c')) ctx.out([...l].filter((_, i) => inRange(i + 1)).join('') + '\n')
      else {
        if (!l.includes(delim)) {
          ctx.out(l + '\n')
          continue
        }
        ctx.out(l.split(delim).filter((_, i) => inRange(i + 1)).join(delim) + '\n')
      }
    }
    return 0
  },
})

function expandTrSet(s: string): string {
  s = bracketPosixClasses(s.replace(/\[:(alpha|digit|alnum|space|upper|lower|punct):\]/g, (m) => `[${m}]`)).replace(/^\[|\]$/g, '')
  s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t')
  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i + 1] === '-' && i + 2 < s.length) {
      for (let c = s.charCodeAt(i); c <= s.charCodeAt(i + 2); c++) out += String.fromCharCode(c)
      i += 2
    } else out += s[i]
  }
  return out
}

register('tr', {
  usage: 'tr [OPTION]... SET1 [SET2]',
  summary: '  -d, --delete  -s, --squeeze-repeats',
  run(ctx) {
    const a = parseArgs(ctx.args, { flags: { d: ['d', 'delete'], s: ['s', 'squeeze-repeats'], c: ['c', 'C', 'complement'] } })
    const input = ctx.stdin.readAll()
    const set1 = expandTrSet(a.rest[0] ?? '')
    const set2 = expandTrSet(a.rest[1] ?? '')
    const comp = a.flags.has('c')
    let out = ''
    for (const c of input) {
      const i = set1.indexOf(c)
      const inSet = comp ? i < 0 : i >= 0
      if (a.flags.has('d')) {
        if (!inSet) out += c
      } else if (inSet && set2) out += comp ? set2[set2.length - 1] : set2[Math.min(i, set2.length - 1)]
      else out += c
    }
    if (a.flags.has('s')) {
      const sq = set2 || set1
      out = out.replace(/(.)\1+/g, (m, ch: string) => (sq.includes(ch) ? ch : m))
    }
    ctx.out(out)
    return 0
  },
})

register('sed', {
  usage: "sed [-n] [-E] [-i[SUFIJO]] [-e script]... {script} [archivo]...",
  summary: "  -n  no mostrar cada línea  -E  regex extendidas  -i[.bak]  editar el archivo (con copia)\n  Direcciones: N, $, /re/, N,M, /a/,/b/, y ! para negar.  Comandos: s/a/b/[gIp], d, p, i, a, c, q, =, y/abc/xyz/",
  run(ctx) {
    // Opciones a mano: -i admite un sufijo pegado (-i.bak) y -e puede repetirse.
    let quiet = false
    let ere = false
    let inPlace: string | undefined
    const scripts: string[] = []
    const files: string[] = []
    for (let k = 0; k < ctx.args.length; k++) {
      const x = ctx.args[k]
      if (x === '-e' || x === '--expression') scripts.push(ctx.args[++k] ?? '')
      else if (x.startsWith('--expression=')) scripts.push(x.slice(13))
      else if (x === '-n' || x === '--quiet' || x === '--silent') quiet = true
      else if (x === '-E' || x === '-r' || x === '--regexp-extended') ere = true
      else if (x === '--in-place') inPlace = ''
      else if (x.startsWith('--in-place=')) inPlace = x.slice(11)
      else if (x.startsWith('-i')) inPlace = x.slice(2)
      else if (/^-[nErs]+$/.test(x)) {
        if (x.includes('n')) quiet = true
        if (x.includes('E') || x.includes('r')) ere = true
      } else if (/^-[nE]*i/.test(x)) {
        if (x.includes('n')) quiet = true
        if (x.includes('E')) ere = true
        inPlace = x.slice(x.indexOf('i') + 1)
      } else files.push(x)
    }
    if (!scripts.length) {
      const first = files.shift()
      if (first === undefined) {
        ctx.err('Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...\n')
        return 1
      }
      scripts.push(first)
    }
    const toRe = (p: string, flags = '') => new RegExp(bracketPosixClasses(ere ? p : breToJs(p)), flags)
    type Addr = number | '$' | RegExp
    type Cmd = { a1?: Addr; a2?: Addr; neg: boolean; op: string; re?: RegExp; repl?: string; print?: boolean; text?: string; from?: string; to?: string; inRange?: boolean }
    const cmds: Cmd[] = []
    for (const part of scripts.flatMap((x) => splitSedScript(x))) {
      let t = part.trim()
      if (!t) continue
      const readAddr = (): Addr | undefined => {
        let m = /^(\d+|\$)/.exec(t)
        if (m) {
          t = t.slice(m[0].length)
          return m[1] === '$' ? '$' : Number(m[1])
        }
        m = /^\/((?:\\.|[^/])*)\/(I?)/.exec(t)
        if (m) {
          t = t.slice(m[0].length)
          return toRe(m[1], m[2] ? 'i' : '')
        }
        return undefined
      }
      const a1 = readAddr()
      let a2: Addr | undefined
      if (a1 !== undefined && t.startsWith(',')) {
        t = t.slice(1)
        a2 = readAddr()
      }
      t = t.trimStart()
      let neg = false
      if (t.startsWith('!')) {
        neg = true
        t = t.slice(1).trimStart()
      }
      const bad = () => {
        ctx.err(`sed: -e expression #1, char ${part.length}: unknown command: \`${t.slice(0, 1) || part.slice(-1)}'\n`)
        return 1
      }
      const op = t[0]
      if (op === 's') {
        const d = t[1]
        const e1 = findDelim(t, 2, d)
        const e2 = findDelim(t, e1 + 1, d)
        const flags = t.slice(e2 + 1)
        if (e1 >= t.length - 1 && t[e1] !== d) return bad()
        cmds.push({ a1, a2, neg, op: 's', re: toRe(t.slice(2, e1), (flags.includes('g') ? 'g' : '') + (/[Ii]/.test(flags) ? 'i' : '')), repl: t.slice(e1 + 1, e2), print: flags.includes('p') })
      } else if (op === 'y') {
        const d = t[1]
        const e1 = findDelim(t, 2, d)
        const e2 = findDelim(t, e1 + 1, d)
        cmds.push({ a1, a2, neg, op: 'y', from: t.slice(2, e1), to: t.slice(e1 + 1, e2) })
      } else if (op === 'i' || op === 'a' || op === 'c') {
        cmds.push({ a1, a2, neg, op, text: t.slice(1).replace(/^\s*\\?\s?/, '') })
      } else if (op === 'd' || op === 'p' || op === 'q' || op === '=' || op === 'Q') {
        cmds.push({ a1, a2, neg, op })
      } else return bad()
    }
    const process = (data: string) => {
      const ls = lines(data)
      let out = ''
      const matches = (addr: Addr, line: string, n: number) => (addr === '$' ? n === ls.length : typeof addr === 'number' ? addr === n : addr.test(line))
      for (let idx = 0; idx < ls.length; idx++) {
        const n = idx + 1
        let current = ls[idx]
        let deleted = false
        let after = ''
        let quit = false
        for (const c of cmds) {
          let hit: boolean
          if (c.a1 === undefined) hit = true
          else if (c.a2 === undefined) hit = matches(c.a1, current, n)
          else if (c.inRange) {
            hit = true
            if (typeof c.a2 === 'number' ? n >= c.a2 : matches(c.a2, current, n)) c.inRange = false
          } else if (matches(c.a1, current, n)) {
            hit = true
            c.inRange = !(typeof c.a2 === 'number' ? n >= c.a2 : false)
          } else hit = false
          if (c.neg) hit = !hit
          if (!hit) continue
          if (c.op === 'd') {
            deleted = true
            break
          }
          if (c.op === 'p') out += current + '\n'
          if (c.op === '=') out += n + '\n'
          if (c.op === 'i') out += c.text + '\n'
          if (c.op === 'a') after += c.text + '\n'
          if (c.op === 'c') {
            out += c.text + '\n'
            deleted = true
            break
          }
          if (c.op === 'q' || c.op === 'Q') {
            quit = true
            if (c.op === 'Q') deleted = true
            break
          }
          if (c.op === 'y') current = [...current].map((ch) => (c.from!.includes(ch) ? (c.to![c.from!.indexOf(ch)] ?? ch) : ch)).join('')
          if (c.op === 's') {
            const repl = c
              .repl!.replace(/\\(\d)/g, '$$$1')
              .replace(/(^|[^\\])&/g, '$1$$&')
              .replace(/\\&/g, '&')
              .replace(/\\\//g, '/')
              .replace(/\\n/g, '\n')
              .replace(/\\t/g, '\t')
            const before = current
            current = current.replace(c.re!, repl)
            if (c.print && before !== current) out += current + '\n'
          }
        }
        if (!deleted) out += (quiet ? '' : current + '\n') + after
        else out += after
        if (quit) break
      }
      for (const c of cmds) c.inRange = false
      return out
    }
    if (inPlace !== undefined) {
      if (!files.length) {
        ctx.err('sed: no input files\n')
        return 1
      }
      for (const f of files) {
        const abs = ctx.sh.resolve(f)
        try {
          const data = ctx.sys.vfs.readFile(abs, ctx.sh.cred)
          if (inPlace) ctx.sys.vfs.writeFile(abs + inPlace, data, ctx.sh.cred, { mode: ctx.sys.vfs.stat(abs, ctx.sh.cred).mode & 0o777 })
          ctx.sys.vfs.writeFile(abs, process(data), ctx.sh.cred)
        } catch (e) {
          if (e instanceof FsError) {
            ctx.err(`sed: couldn't edit ${f}: ${e.message}\n`)
            return 4
          }
          throw e
        }
      }
      return 0
    }
    const inputs = readInputs(ctx, files)
    if (typeof inputs === 'number') return 2
    ctx.out(process(inputs.map((x) => x.data).join('')))
    return 0
  },
})

register(['awk', 'gawk'], {
  usage: "awk [-F fs] [-v var=valor] 'programa' [archivo ...]",
  summary: "  Patrones y acciones, BEGIN/END, $1..$NF, NR, NF, arreglos (cuenta[$1]++), for (k in a),\n  if/while/for, printf, length, substr, split, sub, gsub, tolower, toupper.",
  run(ctx) {
    const args = [...ctx.args]
    let fs: string | undefined
    const vars: Record<string, string> = {}
    let program: string | undefined
    const files: string[] = []
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      if (program === undefined && a === '-F') fs = args[++i]
      else if (program === undefined && a.startsWith('-F')) fs = a.slice(2)
      else if (program === undefined && a === '-v') {
        const [k, ...v] = (args[++i] ?? '').split('=')
        vars[k] = v.join('=')
      } else if (program === undefined && a.startsWith('-v')) {
        const [k, ...v] = a.slice(2).split('=')
        vars[k] = v.join('=')
      } else if (program === undefined && a === '-f') {
        try {
          program = ctx.sys.vfs.readFile(ctx.sh.resolve(args[++i] ?? ''), ctx.sh.cred)
        } catch {
          ctx.err(`awk: can't open file ${args[i]}\n`)
          return 2
        }
      } else if (program === undefined) program = a
      else files.push(a)
    }
    if (program === undefined) {
      ctx.err('usage: awk [-F fs][-v var=value][prog | -f progfile][file ...]\n')
      return 2
    }
    if (fs === 't' || fs === '\\t') fs = '\t'
    const inputs = readInputs(ctx, files)
    if (typeof inputs === 'number') return 2
    try {
      return runAwk(program, inputs, { fs, vars }, {
        out: ctx.out,
        err: ctx.err,
        writeFile: (path, data, append) => ctx.sys.vfs.writeFile(ctx.sh.resolve(path), data, ctx.sh.cred, { append, mode: 0o644, umask: ctx.sh.umask }),
      })
    } catch (e) {
      if (e instanceof AwkError) {
        ctx.err(e.message + '\n')
        return 2
      }
      throw e
    }
  },
})

/** Diferencias entre dos listas de líneas, en el formato normal de diff. Devuelve si hubo cambios. */
function diffLines(a: string[], b: string[], out: (s: string) => void): boolean {
  // LCS para un diff mínimo en formato normal.
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  let i = 0
  let j = 0
  const hunks: { del: string[]; add: string[]; ai: number; bj: number }[] = []
  let cur: { del: string[]; add: string[]; ai: number; bj: number } | null = null
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      if (cur) hunks.push(cur)
      cur = null
      i++
      j++
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      cur ??= { del: [], add: [], ai: i, bj: j }
      cur.add.push(b[j++])
    } else {
      cur ??= { del: [], add: [], ai: i, bj: j }
      cur.del.push(a[i++])
    }
  }
  if (cur) hunks.push(cur)
  const range = (st: number, len: number) => (len <= 1 ? String(st + (len ? 1 : 0)) : `${st + 1},${st + len}`)
  for (const h of hunks) {
    const op = h.del.length && h.add.length ? 'c' : h.del.length ? 'd' : 'a'
    const left = op === 'a' ? String(h.ai) : range(h.ai, h.del.length)
    const right = op === 'd' ? String(h.bj) : range(h.bj, h.add.length)
    out(`${left}${op}${right}\n`)
    for (const l of h.del) out(`< ${l}\n`)
    if (op === 'c') out('---\n')
    for (const l of h.add) out(`> ${l}\n`)
  }
  return hunks.length > 0
}

register('diff', {
  usage: 'diff [-r] [-q] ARCHIVO1 ARCHIVO2',
  summary: '  -r  comparar carpetas completas  -q  solo decir si difieren',
  run(ctx) {
    const flags = ctx.args.filter((x) => x.startsWith('-')).join('')
    const recursive = /r/.test(flags) || ctx.args.includes('--recursive')
    const brief = /q/.test(flags) || ctx.args.includes('--brief')
    const files = ctx.args.filter((x) => !x.startsWith('-') || x === '-')
    if (files.length !== 2) {
      ctx.err("diff: missing operand after '" + (files[0] ?? 'diff') + "'\n")
      return 2
    }
    const vfs = ctx.sys.vfs
    const cred = ctx.sh.cred
    const isDir = (p: string) => vfs.exists(p, cred) && vfs.stat(p, cred).type === 'dir'
    let changed = false
    let trouble = false
    const compareFiles = (pa: string, pb: string, shownA: string, shownB: string, header: boolean) => {
      let a: string
      let b: string
      try {
        a = shownA === '-' ? ctx.stdin.readAll() : vfs.readFile(pa, cred)
        b = shownB === '-' ? ctx.stdin.readAll() : vfs.readFile(pb, cred)
      } catch (e) {
        if (e instanceof FsError) {
          ctx.err(`diff: ${e.path}: ${e.message}\n`)
          trouble = true
          return
        }
        throw e
      }
      if (a === b) return
      changed = true
      if (brief) {
        ctx.out(`Files ${shownA} and ${shownB} differ\n`)
        return
      }
      if (header) ctx.out(`diff -r ${shownA} ${shownB}\n`)
      diffLines(lines(a), lines(b), ctx.out)
    }
    const compareDirs = (pa: string, pb: string, shownA: string, shownB: string) => {
      const na = new Set(vfs.readdir(pa, cred))
      const nb = new Set(vfs.readdir(pb, cred))
      for (const name of [...new Set([...na, ...nb])].sort()) {
        const ca = `${pa}/${name}`
        const cb = `${pb}/${name}`
        if (!na.has(name)) {
          ctx.out(`Only in ${shownB}: ${name}\n`)
          changed = true
          continue
        }
        if (!nb.has(name)) {
          ctx.out(`Only in ${shownA}: ${name}\n`)
          changed = true
          continue
        }
        const da = isDir(ca)
        const db = isDir(cb)
        if (da && db) {
          if (recursive) compareDirs(ca, cb, `${shownA}/${name}`, `${shownB}/${name}`)
          else ctx.out(`Common subdirectories: ${shownA}/${name} and ${shownB}/${name}\n`)
        } else if (da !== db) {
          ctx.out(`File ${da ? shownA : shownB}/${name} is a directory while file ${da ? shownB : shownA}/${name} is a regular file\n`)
          changed = true
        } else compareFiles(ca, cb, `${shownA}/${name}`, `${shownB}/${name}`, true)
      }
    }
    const [fa, fb] = files
    const pa = fa === '-' ? '-' : ctx.sh.resolve(fa)
    const pb = fb === '-' ? '-' : ctx.sh.resolve(fb)
    for (const [p, f] of [[pa, fa], [pb, fb]]) {
      if (p !== '-' && !vfs.exists(p, cred)) {
        ctx.err(`diff: ${f}: No such file or directory\n`)
        return 2
      }
    }
    const da = pa !== '-' && isDir(pa)
    const db = pb !== '-' && isDir(pb)
    if (da && db) compareDirs(pa, pb, fa.replace(/\/$/, ''), fb.replace(/\/$/, ''))
    else if (da || db) {
      // diff archivo carpeta: compara con el archivo del mismo nombre dentro de la carpeta.
      const name = (da ? fb : fa).split('/').pop()!
      if (da) compareFiles(`${pa}/${name}`, pb, `${fa.replace(/\/$/, '')}/${name}`, fb, false)
      else compareFiles(pa, `${pb}/${name}`, fa, `${fb.replace(/\/$/, '')}/${name}`, false)
    } else compareFiles(pa, pb, fa, fb, false)
    if (trouble) return 2
    return changed ? 1 : 0
  },
})

register('xargs', {
  usage: 'xargs [OPTION]... COMMAND [INITIAL-ARGS]...',
  async run(ctx) {
    let i0 = 0
    let perArg: number | undefined
    while (i0 < ctx.args.length && ctx.args[i0].startsWith('-')) {
      if (ctx.args[i0] === '-n') {
        perArg = Number(ctx.args[i0 + 1])
        i0 += 2
      } else if (/^-n\d+$/.test(ctx.args[i0])) {
        perArg = Number(ctx.args[i0].slice(2))
        i0++
      } else i0++
    }
    const cmd = ctx.args.length > i0 ? ctx.args.slice(i0) : ['echo']
    const items = ctx.stdin.readAll().split(/\s+/).filter(Boolean)
    const per = perArg || items.length || 1
    let code = 0
    for (let i = 0; i < Math.max(items.length, 1); i += per) {
      const chunk = items.slice(i, i + per)
      if (!chunk.length && items.length) break
      code = await ctx.sh.invoke([...cmd, ...chunk], { stdin: ctx.stdin, out: ctx.out, err: ctx.err, isTTY: ctx.isTTY })
    }
    return code
  },
})

register('rev', {
  usage: 'rev [FILE]...',
  run(ctx) {
    const inputs = readInputs(ctx, ctx.args)
    if (typeof inputs === 'number') return inputs
    for (const l of inputs.flatMap((i) => lines(i.data))) ctx.out([...l].reverse().join('') + '\n')
    return 0
  },
})

register('column', {
  usage: 'column -t [-s SEP] [FILE]',
  run(ctx) {
    const a = parseArgs(ctx.args, { flags: { t: ['t'] }, values: { s: ['s'] } })
    const inputs = readInputs(ctx, a.rest)
    if (typeof inputs === 'number') return inputs
    const rows = inputs.flatMap((i) => lines(i.data)).map((l) => (a.values.has('s') ? l.split(a.values.get('s')!) : l.trim().split(/\s+/)))
    const widths: number[] = []
    for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)))
    for (const r of rows) ctx.out(r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join('  ') + '\n')
    return 0
  },
})

// ---------------------------------------------------------------------------------------
// Ver los bytes de un archivo: od, hexdump, xxd
// ---------------------------------------------------------------------------------------

function bytesOf(data: string): Uint8Array {
  return new TextEncoder().encode(data)
}

const printable = (b: number) => b >= 0x20 && b < 0x7f

register('od', {
  usage: 'od [-c] [-An] [-t x1] [FILE]...',
  run(ctx) {
    let mode = 'o2' as 'c' | 'x1' | 'o2'
    let addr = 'o' as 'o' | 'd' | 'x' | 'n'
    const files: string[] = []
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i]
      if (a === '-c') mode = 'c'
      else if (a === '-b') mode = 'o2'
      else if (a === '-t' || a.startsWith('-t')) {
        const t = a === '-t' ? ctx.args[++i] : a.slice(2)
        if (t === 'x1' || t === 'x1z') mode = 'x1'
        else if (t === 'c') mode = 'c'
        else {
          ctx.err(`od: invalid type string '${t}'\n[simulador] Tipos disponibles: -t x1 (hexadecimal) y -c (caracteres)\n`)
          return 1
        }
      } else if (a === '-A' || a.startsWith('-A')) {
        const v = a === '-A' ? ctx.args[++i] : a.slice(2)
        addr = (v as typeof addr) ?? 'o'
      } else files.push(a)
    }
    const inputs = readInputs(ctx, files)
    if (typeof inputs === 'number') return inputs
    const bytes = bytesOf(inputs.map((x) => x.data).join(''))
    const fmtAddr = (n: number) => (addr === 'n' ? '' : addr === 'd' ? String(n).padStart(7, '0') : addr === 'x' ? n.toString(16).padStart(6, '0') : n.toString(8).padStart(7, '0'))
    const ESC: Record<number, string> = { 0: '\\0', 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r' }
    for (let off = 0; off < bytes.length; off += 16) {
      const chunk = [...bytes.slice(off, off + 16)]
      let cells: string
      if (mode === 'c') cells = chunk.map((b) => (ESC[b] ?? (printable(b) ? String.fromCharCode(b) : b.toString(8).padStart(3, '0'))).padStart(4)).join('')
      else if (mode === 'x1') cells = chunk.map((b) => ` ${b.toString(16).padStart(2, '0')}`).join('')
      else {
        const words: string[] = []
        for (let i = 0; i < chunk.length; i += 2) words.push((chunk[i] | ((chunk[i + 1] ?? 0) << 8)).toString(8).padStart(6, '0'))
        cells = words.map((w) => ` ${w}`).join('')
      }
      ctx.out(`${fmtAddr(off)}${cells}\n`)
    }
    if (addr !== 'n') ctx.out(`${fmtAddr(bytes.length)}\n`)
    return 0
  },
})

register('hexdump', {
  usage: 'hexdump -C [FILE]...',
  run(ctx) {
    const files = ctx.args.filter((a) => !a.startsWith('-'))
    if (!ctx.args.includes('-C')) ctx.err('[simulador] El simulador muestra siempre el formato canónico (-C), que es el que se usa en la práctica.\n')
    const inputs = readInputs(ctx, files)
    if (typeof inputs === 'number') return inputs
    const bytes = bytesOf(inputs.map((x) => x.data).join(''))
    for (let off = 0; off < bytes.length; off += 16) {
      const chunk = [...bytes.slice(off, off + 16)]
      const hex = chunk.map((b) => b.toString(16).padStart(2, '0'))
      const left = hex.slice(0, 8).join(' ')
      const right = hex.slice(8).join(' ')
      const ascii = chunk.map((b) => (printable(b) ? String.fromCharCode(b) : '.')).join('')
      ctx.out(`${off.toString(16).padStart(8, '0')}  ${left.padEnd(23)}  ${right.padEnd(23)}  |${ascii}|\n`)
    }
    ctx.out(`${bytes.length.toString(16).padStart(8, '0')}\n`)
    return 0
  },
})

register('xxd', {
  usage: 'xxd [FILE]',
  run(ctx) {
    const inputs = readInputs(ctx, ctx.args.filter((a) => !a.startsWith('-')))
    if (typeof inputs === 'number') return inputs
    const bytes = bytesOf(inputs.map((x) => x.data).join(''))
    for (let off = 0; off < bytes.length; off += 16) {
      const chunk = [...bytes.slice(off, off + 16)]
      const groups: string[] = []
      for (let i = 0; i < chunk.length; i += 2) groups.push(chunk.slice(i, i + 2).map((b) => b.toString(16).padStart(2, '0')).join(''))
      const ascii = chunk.map((b) => (printable(b) ? String.fromCharCode(b) : '.')).join('')
      ctx.out(`${off.toString(16).padStart(8, '0')}: ${groups.join(' ').padEnd(39)}  ${ascii}\n`)
    }
    return 0
  },
})

// ---------------------------------------------------------------------------------------
// Finales de línea: dos2unix y unix2dos
// ---------------------------------------------------------------------------------------

for (const [name, toUnix] of [
  ['dos2unix', true],
  ['unix2dos', false],
] as const) {
  register(name, {
    usage: `${name} FILE...`,
    run(ctx) {
      const files = ctx.args.filter((a) => !a.startsWith('-'))
      if (!files.length) {
        ctx.err(`${name}: [simulador] indica el archivo a convertir, por ejemplo: ${name} script.sh\n`)
        return 1
      }
      let code = 0
      for (const f of files) {
        const abs = ctx.sh.resolve(f)
        try {
          const data = ctx.sys.vfs.readFile(abs, ctx.sh.cred)
          const converted = toUnix ? data.replace(/\r\n/g, '\n') : data.replace(/\r?\n/g, '\r\n')
          ctx.sys.vfs.writeFile(abs, converted, ctx.sh.cred)
          ctx.err(`${name}: converting file ${f} to ${toUnix ? 'Unix' : 'DOS'} format...\n`)
        } catch (e) {
          if (e instanceof FsError) {
            ctx.err(`${name}: Failed to open ${f}: ${e.message}\n`)
            code = 1
          } else throw e
        }
      }
      return code
    },
  })
}

/** Separa los comandos de sed por ; o salto de línea, sin cortar dentro de s/.../.../ ni /regex/. */
function splitSedScript(script: string): string[] {
  const out: string[] = []
  let cur = ''
  let i = 0
  while (i < script.length) {
    const c = script[i]
    if (c === ';' || c === '\n') {
      out.push(cur)
      cur = ''
      i++
      continue
    }
    if (c === '/' && cur.trim() === '') {
      // dirección /regex/
      const end = findDelim(script, i + 1, '/')
      cur += script.slice(i, end + 1)
      i = end + 1
      continue
    }
    if ((c === 's' || c === 'y') && /^\s*((\d+|\$|\/(?:\\.|[^/])*\/I?)(\s*,\s*(\d+|\$|\/(?:\\.|[^/])*\/I?))?)?\s*!?\s*$/.test(cur) && i + 1 < script.length) {
      const d = script[i + 1]
      const a = findDelim(script, i + 2, d)
      const b = findDelim(script, a + 1, d)
      let k = b + 1
      while (k < script.length && /[gIpi0-9w]/.test(script[k])) k++
      cur += script.slice(i, k)
      i = k
      continue
    }
    cur += c
    i++
  }
  out.push(cur)
  return out
}

function findDelim(s: string, start: number, d: string): number {
  let k = start
  while (k < s.length) {
    if (s[k] === '\\') {
      k += 2
      continue
    }
    if (s[k] === d) return k
    k++
  }
  return s.length - 1
}
