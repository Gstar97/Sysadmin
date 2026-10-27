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
    const a = parseArgs(ctx.args, { flags: { d: ['d', 'delete'], s: ['s', 'squeeze-repeats'] } })
    const input = ctx.stdin.readAll()
    const set1 = expandTrSet(a.rest[0] ?? '')
    const set2 = expandTrSet(a.rest[1] ?? '')
    let out = ''
    for (const c of input) {
      const i = set1.indexOf(c)
      if (a.flags.has('d')) {
        if (i < 0) out += c
      } else if (i >= 0 && set2) out += set2[Math.min(i, set2.length - 1)]
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
  usage: "sed [OPTION]... {script} [input-file]...",
  summary: "  -n  -i  -E  -e script   (s/old/new/[g], /re/d, Np, /re/p)",
  run(ctx) {
    const a = parseArgs(ctx.args, { flags: { n: ['n', 'quiet', 'silent'], i: ['i', 'in-place'], E: ['E', 'r', 'regexp-extended'] }, values: { e: ['e', 'expression'] } })
    let rest = a.rest
    const script = a.values.get('e') ?? rest[0]
    if (!a.values.has('e')) rest = rest.slice(1)
    if (!script) {
      ctx.err('Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...\n')
      return 1
    }
    const toRe = (p: string, flags = '') => new RegExp(bracketPosixClasses(a.flags.has('E') ? p : breToJs(p)), flags)
    type Cmd = { addr?: RegExp | number | '$'; op: 's' | 'd' | 'p'; re?: RegExp; repl?: string; global?: boolean; print?: boolean }
    const cmds: Cmd[] = []
    for (const part of script.split(/;(?![^/]*\/[^/]*\/)/)) {
      const s = part.trim()
      if (!s) continue
      let m = /^(?:(\d+|\$)|\/((?:\\.|[^/])*)\/)?\s*s(.)((?:\\.|(?!\3).)*)\3((?:\\.|(?!\3).)*)\3([gIpi0-9]*)$/.exec(s)
      if (m) {
        const flags = m[6]
        cmds.push({ addr: m[1] ? (m[1] === '$' ? '$' : Number(m[1])) : m[2] !== undefined ? toRe(m[2]) : undefined, op: 's', re: toRe(m[4], (flags.includes('g') ? 'g' : '') + (/[Ii]/.test(flags) ? 'i' : '')), repl: m[5], print: flags.includes('p') })
        continue
      }
      m = /^(?:(\d+|\$)|\/((?:\\.|[^/])*)\/)?\s*([dp])$/.exec(s)
      if (m) {
        cmds.push({ addr: m[1] ? (m[1] === '$' ? '$' : Number(m[1])) : m[2] !== undefined ? toRe(m[2]) : undefined, op: m[3] as 'd' | 'p' })
        continue
      }
      ctx.err(`sed: -e expression #1, char ${s.length}: unknown command: \`${s.slice(-1)}'\n`)
      return 1
    }
    const process = (data: string) => {
      const ls = lines(data)
      let out = ''
      ls.forEach((line, idx) => {
        let current = line
        let deleted = false
        let extra = ''
        for (const c of cmds) {
          const hit = c.addr === undefined || (c.addr === '$' ? idx === ls.length - 1 : typeof c.addr === 'number' ? c.addr === idx + 1 : c.addr.test(current))
          if (!hit) continue
          if (c.op === 'd') {
            deleted = true
            break
          }
          if (c.op === 'p') extra += current + '\n'
          if (c.op === 's') {
            const repl = c.repl!.replace(/\\(\d)/g, '$$$1').replace(/(^|[^\\])&/g, '$1$$&').replace(/\\&/g, '&').replace(/\\\//g, '/')
            const before = current
            current = current.replace(c.re!, repl)
            if (c.print && before !== current) extra += current + '\n'
          }
        }
        if (deleted) return
        out += extra + (a.flags.has('n') ? '' : current + '\n')
      })
      return out
    }
    if (a.flags.has('i')) {
      for (const f of rest) {
        const abs = ctx.sh.resolve(f)
        try {
          const data = ctx.sys.vfs.readFile(abs, ctx.sh.cred)
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
    const inputs = readInputs(ctx, rest)
    if (typeof inputs === 'number') return 2
    ctx.out(process(inputs.map((i) => i.data).join('')))
    return 0
  },
})

register(['awk', 'gawk'], {
  usage: "awk [-F fs] 'program' [file ...]",
  summary: "  Soporta: {print $1}, -F, condiciones /regex/ y $N==valor, NR, NF, $NF, BEGIN/END y sumas simples.",
  run(ctx) {
    const a = parseArgs(ctx.args, { values: { F: ['F', 'field-separator'], v: ['v', 'assign'] } })
    const program = a.rest[0]
    if (!program) {
      ctx.err("usage: awk [-F fs][-v var=value][prog | -f progfile][file ...]\n")
      return 2
    }
    const inputs = readInputs(ctx, a.rest.slice(1))
    if (typeof inputs === 'number') return 2
    const fs = a.values.get('F')
    const vars: Record<string, number | string> = {}
    if (a.values.has('v')) {
      const [k, v] = a.values.get('v')!.split('=')
      vars[k] = v
    }
    // Bloques: [patrón] { acciones }
    const blocks: { pattern: string; action: string }[] = []
    const re = /\s*(BEGIN|END|[^{]*?)\s*\{([^}]*)\}/g
    let m: RegExpExecArray | null
    let consumed = 0
    while ((m = re.exec(program))) {
      blocks.push({ pattern: m[1].trim(), action: m[2].trim() })
      consumed = re.lastIndex
    }
    if (!blocks.length || program.slice(consumed).trim()) {
      const pat = program.slice(consumed).trim() || program.trim()
      blocks.push({ pattern: pat, action: 'print' })
    }
    let NR = 0
    let fields: string[] = []
    let line = ''
    const field = (n: number) => (n === 0 ? line : (fields[n - 1] ?? ''))
    const evalExpr = (expr: string): string | number => {
      const e = expr.trim()
      if (/^".*"$/.test(e)) return e.slice(1, -1).replace(/\\t/g, '\t').replace(/\\n/g, '\n')
      if (/^\d+(\.\d+)?$/.test(e)) return Number(e)
      if (e === 'NR') return NR
      if (e === 'NF') return fields.length
      if (e === '$NF') return fields[fields.length - 1] ?? ''
      let fm = /^\$\(?NF\s*-\s*(\d+)\)?$/.exec(e)
      if (fm) return fields[fields.length - 1 - Number(fm[1])] ?? ''
      fm = /^\$(\d+)$/.exec(e)
      if (fm) return field(Number(fm[1]))
      if (/^[A-Za-z_]\w*$/.test(e)) return vars[e] ?? ''
      const arith = /^(.+?)\s*([-+*/%])\s*(.+)$/.exec(e)
      if (arith) {
        const x = Number(evalExpr(arith[1])) || 0
        const y = Number(evalExpr(arith[3])) || 0
        return arith[2] === '+' ? x + y : arith[2] === '-' ? x - y : arith[2] === '*' ? x * y : arith[2] === '/' ? x / y : x % y
      }
      return e
    }
    const evalPrintArgs = (args: string) => {
      if (!args.trim()) return line
      return args
        .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
        .map((part) =>
          part
            .trim()
            .split(/\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/)
            .map((tok) => String(evalExpr(tok)))
            .join(''),
        )
        .join(' ')
    }
    const matchPattern = (p: string): boolean => {
      if (!p) return true
      const rm = /^\/(.*)\/$/.exec(p)
      if (rm) return new RegExp(rm[1]).test(line)
      const cm = /^(.+?)\s*(==|!=|>=|<=|>|<|~)\s*(.+)$/.exec(p)
      if (cm) {
        const l = evalExpr(cm[1])
        const r = cm[2] === '~' ? cm[3].replace(/^\/|\/$/g, '') : evalExpr(cm[3])
        if (cm[2] === '~') return new RegExp(String(r)).test(String(l))
        const ln = Number(l)
        const rn = Number(r)
        const numeric = !Number.isNaN(ln) && !Number.isNaN(rn) && String(l).trim() !== '' && String(r).trim() !== ''
        const lv = numeric ? ln : String(l)
        const rv = numeric ? rn : String(r)
        switch (cm[2]) {
          case '==':
            return lv === rv
          case '!=':
            return lv !== rv
          case '>':
            return lv > rv
          case '<':
            return lv < rv
          case '>=':
            return lv >= rv
          case '<=':
            return lv <= rv
        }
      }
      return !!evalExpr(p)
    }
    const run = (action: string) => {
      for (const stmt of action.split(';').map((s) => s.trim()).filter(Boolean)) {
        const pm = /^printf\s*\(?\s*"(.*?)"\s*(?:,\s*(.*?))?\)?$/.exec(stmt)
        if (pm) {
          const values = pm[2] ? pm[2].split(',').map((x) => String(evalExpr(x))) : []
          let i = 0
          ctx.out(pm[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/%-?\d*(?:\.\d+)?[sdf]/g, (spec) => {
            const v = values[i++] ?? ''
            const w = Number(/\d+/.exec(spec)?.[0] ?? 0)
            const s = spec.endsWith('f') ? Number(v).toFixed(Number(/\.(\d+)/.exec(spec)?.[1] ?? 6)) : spec.endsWith('d') ? String(Math.trunc(Number(v))) : v
            return spec.includes('-') ? s.padEnd(w) : s.padStart(w)
          }))
          continue
        }
        const pr = /^print\s*(.*)$/.exec(stmt)
        if (pr) {
          ctx.out(evalPrintArgs(pr[1]) + '\n')
          continue
        }
        const asg = /^([A-Za-z_]\w*)\s*(\+=|-=|=)\s*(.+)$/.exec(stmt)
        if (asg) {
          const v = evalExpr(asg[3])
          const cur = Number(vars[asg[1]] ?? 0)
          vars[asg[1]] = asg[2] === '+=' ? cur + Number(v) : asg[2] === '-=' ? cur - Number(v) : v
          continue
        }
        const inc = /^([A-Za-z_]\w*)\+\+$/.exec(stmt)
        if (inc) {
          vars[inc[1]] = Number(vars[inc[1]] ?? 0) + 1
          continue
        }
      }
    }
    for (const b of blocks) if (b.pattern === 'BEGIN') run(b.action)
    for (const inp of inputs) {
      for (const l of lines(inp.data)) {
        NR++
        line = l
        fields = fs ? l.split(fs.length === 1 ? fs : new RegExp(fs)) : l.trim().split(/\s+/).filter(Boolean)
        for (const b of blocks) {
          if (b.pattern === 'BEGIN' || b.pattern === 'END') continue
          if (matchPattern(b.pattern)) run(b.action)
        }
      }
    }
    for (const b of blocks) if (b.pattern === 'END') run(b.action)
    return 0
  },
})

register('diff', {
  usage: 'diff [OPTION]... FILES',
  run(ctx) {
    const files = ctx.args.filter((x) => !x.startsWith('-'))
    if (files.length !== 2) {
      ctx.err("diff: missing operand after '" + (files[0] ?? 'diff') + "'\n")
      return 2
    }
    let a: string[]
    let b: string[]
    try {
      a = lines(ctx.sys.vfs.readFile(ctx.sh.resolve(files[0]), ctx.sh.cred))
      b = lines(ctx.sys.vfs.readFile(ctx.sh.resolve(files[1]), ctx.sh.cred))
    } catch (e) {
      if (e instanceof FsError) {
        ctx.err(`diff: ${e.path}: ${e.message}\n`)
        return 2
      }
      throw e
    }
    // LCS para un diff mínimo en formato normal.
    const n = a.length
    const m = b.length
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    let i = 0
    let j = 0
    let changed = false
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
    const range = (s: number, len: number) => (len <= 1 ? String(s + (len ? 1 : 0)) : `${s + 1},${s + len}`)
    for (const h of hunks) {
      changed = true
      const op = h.del.length && h.add.length ? 'c' : h.del.length ? 'd' : 'a'
      const left = op === 'a' ? String(h.ai) : range(h.ai, h.del.length)
      const right = op === 'd' ? String(h.bj) : range(h.bj, h.add.length)
      ctx.out(`${left}${op}${right}\n`)
      for (const l of h.del) ctx.out(`< ${l}\n`)
      if (op === 'c') ctx.out('---\n')
      for (const l of h.add) ctx.out(`> ${l}\n`)
    }
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
