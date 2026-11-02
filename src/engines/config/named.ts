/**
 * named.conf de BIND 9: bloques con llaves que terminan en "};", comentarios //, # y /* *\/,
 * include y zonas. Reporta los errores con el formato de named-checkconf.
 */
import type { Diagnostic } from './types'

export interface NamedStmt {
  name: string
  args: string[]
  line: number
  block?: NamedStmt[]
  /** Archivo donde está (para los mensajes). */
  file: string
}

export interface NamedProblem {
  file: string
  line: number
  severity: 'error' | 'warning'
  bind: string
  explicacion: string
}

interface Tok {
  t: string
  line: number
  quoted: boolean
}

function tokenize(text: string, file: string, problems: NamedProblem[]): Tok[] {
  const out: Tok[] = []
  let line = 1
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '\n') {
      line++
      i++
      continue
    }
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '#' || (c === '/' && text[i + 1] === '/')) {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const chunk = end < 0 ? text.slice(i) : text.slice(i, end + 2)
      line += chunk.split('\n').length - 1
      i += chunk.length
      continue
    }
    if (c === '{' || c === '}' || c === ';') {
      out.push({ t: c, line, quoted: false })
      i++
      continue
    }
    if (c === '"') {
      const end = text.indexOf('"', i + 1)
      if (end < 0) {
        problems.push({ file, line, severity: 'error', bind: `${file}:${line}: unterminated quoted string`, explicacion: 'Unas comillas quedaron abiertas: falta cerrar el texto con ".' })
        return out
      }
      const s = text.slice(i + 1, end)
      out.push({ t: s, line, quoted: true })
      line += s.split('\n').length - 1
      i = end + 1
      continue
    }
    let j = i
    while (j < text.length && !/[\s{};"#]/.test(text[j]) && !(text[j] === '/' && (text[j + 1] === '/' || text[j + 1] === '*'))) j++
    out.push({ t: text.slice(i, j), line, quoted: false })
    i = j
  }
  return out
}

const TOP = ['options', 'zone', 'logging', 'include', 'acl', 'key', 'controls', 'view', 'server', 'statistics-channels', 'trust-anchors', 'managed-keys', 'dnssec-policy', 'tls', 'http', 'primaries', 'masters', 'key-store', 'plugin']
const OPTIONS = [
  'directory', 'listen-on', 'listen-on-v6', 'allow-query', 'allow-query-cache', 'allow-recursion', 'allow-transfer', 'allow-update', 'recursion', 'forwarders', 'forward',
  'dnssec-validation', 'dump-file', 'statistics-file', 'memstatistics-file', 'secroots-file', 'recursing-file', 'pid-file', 'session-keyfile', 'managed-keys-directory',
  'geoip-directory', 'include', 'querylog', 'version', 'hostname', 'notify', 'also-notify', 'auth-nxdomain', 'empty-zones-enable', 'max-cache-size', 'minimal-responses',
  'max-cache-ttl', 'max-ncache-ttl', 'blackhole', 'check-names', 'qname-minimization', 'response-policy', 'rate-limit', 'transfer-source', 'notify-source', 'key-directory',
]
const ZONE_OPTS = ['type', 'file', 'allow-update', 'allow-transfer', 'allow-query', 'also-notify', 'notify', 'primaries', 'masters', 'forwarders', 'forward', 'update-policy', 'journal', 'check-names', 'inline-signing', 'dnssec-policy', 'key-directory', 'serial-update-method', 'zone-statistics', 'max-journal-size', 'in-view']
const ZONE_TYPES = ['primary', 'master', 'secondary', 'slave', 'forward', 'hint', 'stub', 'mirror', 'redirect', 'static-stub']
const BOOL = ['yes', 'no', 'true', 'false']

function closest(word: string, list: string[]): string | undefined {
  const dist = (a: string, b: string) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
    for (let j = 1; j <= b.length; j++) d[0][j] = j
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    return d[a.length][b.length]
  }
  const best = list.map((w) => [w, dist(word, w)] as const).sort((a, b) => a[1] - b[1])[0]
  return best && best[1] <= 2 ? best[0] : undefined
}

export function parseNamed(text: string, file = '/etc/named.conf'): { tree: NamedStmt[]; problems: NamedProblem[] } {
  const problems: NamedProblem[] = []
  const toks = tokenize(text, file, problems)
  let pos = 0
  const err = (line: number, bind: string, explicacion: string) => problems.push({ file, line, severity: 'error', bind: `${file}:${line}: ${bind}`, explicacion })
  const parseList = (depth: number): NamedStmt[] => {
    const list: NamedStmt[] = []
    while (pos < toks.length) {
      const t = toks[pos]
      if (t.t === '}' && !t.quoted) {
        if (depth === 0) {
          err(t.line, "unexpected token near '}'", 'Sobra una llave "}": no hay ningún bloque abierto para cerrar.')
          pos++
          continue
        }
        return list
      }
      if (t.t === ';' && !t.quoted) {
        pos++
        continue
      }
      const stmt: NamedStmt = { name: t.t, args: [], line: t.line, file }
      pos++
      while (pos < toks.length && !(['{', ';', '}'].includes(toks[pos].t) && !toks[pos].quoted)) {
        // Una palabra en otra línea que parece el comienzo de otra sentencia: falta ";".
        if (toks[pos].line > stmt.line && !toks[pos].quoted && (TOP.includes(toks[pos].t) || OPTIONS.includes(toks[pos].t) || ZONE_OPTS.includes(toks[pos].t)) && stmt.args.length > 0) {
          err(toks[pos - 1].line, `missing ';' before '${toks[pos].t}'`, `Falta ";" al final de la línea ${toks[pos - 1].line}: en named.conf cada opción termina con punto y coma.`)
          break
        }
        stmt.args.push(toks[pos].t)
        pos++
      }
      if (toks[pos]?.t === '{' && !toks[pos].quoted) {
        const open = toks[pos].line
        pos++
        stmt.block = parseList(depth + 1)
        if (pos >= toks.length) {
          err(open, "'}' expected near end of file", 'Falta cerrar con "};" el bloque que se abre en esta línea.')
          list.push(stmt)
          return list
        }
        pos++ // }
        const after = toks[pos]
        if (!after || after.t !== ';') {
          err(toks[pos - 1].line, `missing ';' before '${after?.t ?? 'end of file'}'`, 'Después de la llave que cierra un bloque va ";": se escribe "};".')
        } else pos++
      } else if (toks[pos]?.t === ';') pos++
      else if (pos >= toks.length) err(stmt.line, "unexpected end of input", `Falta ";" al final de "${stmt.name}".`)
      list.push(stmt)
    }
    return list
  }
  const tree = parseList(0)
  if (problems.some((p) => p.severity === 'error')) return { tree, problems }

  // Opciones y zonas.
  for (const s of tree) {
    if (!TOP.includes(s.name)) {
      const sug = closest(s.name, TOP)
      err(s.line, `unknown option '${s.name}'`, `"${s.name}" no es una sentencia de named.conf.${sug ? ` ¿Quisiste escribir "${sug}"?` : ''}`)
      continue
    }
    if (s.name === 'options') {
      for (const o of s.block ?? []) {
        if (!OPTIONS.includes(o.name)) {
          const sug = closest(o.name, OPTIONS)
          err(o.line, `unknown option '${o.name}'`, `"${o.name}" no es una opción de BIND.${sug ? ` ¿Quisiste escribir "${sug}"?` : ''}`)
        } else if (o.name === 'recursion' && !BOOL.includes(o.args[0] ?? '')) err(o.line, `'${o.args[0]}': expected a boolean`, 'recursion acepta yes o no.')
      }
    }
    if (s.name === 'zone') {
      const zname = s.args[0]
      if (!zname) {
        err(s.line, "expected quoted string near '{'", 'La zona necesita su nombre entre comillas: zone "empresa.local" IN { ... };')
        continue
      }
      const opts = s.block ?? []
      for (const o of opts) {
        if (!ZONE_OPTS.includes(o.name)) {
          const sug = closest(o.name, ZONE_OPTS)
          err(o.line, `unknown option '${o.name}'`, `"${o.name}" no es una opción de zona.${sug ? ` ¿Quisiste escribir "${sug}"?` : ''}`)
        }
      }
      const type = opts.find((o) => o.name === 'type')?.args[0]
      if (!type) err(s.line, `zone '${zname}': type not present`, 'Cada zona necesita "type": primary (la que tiene los datos), secondary (copia) o forward.')
      else if (!ZONE_TYPES.includes(type)) err(s.line, `zone '${zname}': unknown zone type '${type}'`, `"${type}" no es un tipo de zona. Los más usados: primary, secondary y forward.`)
      else if (['primary', 'master', 'hint', 'redirect'].includes(type) && !opts.some((o) => o.name === 'file')) err(s.line, `zone '${zname}': missing 'file' entry`, 'Una zona primaria necesita "file" con el archivo de zona: file "db.empresa.local";')
      const dup = tree.filter((z) => z.name === 'zone' && z.args[0]?.toLowerCase() === zname.toLowerCase())
      if (dup.length > 1 && dup[0] !== s) err(s.line, `zone '${zname}': already exists previous definition: ${file}:${dup[0].line}`, `La zona "${zname}" ya está definida en la línea ${dup[0].line}.`)
    }
  }
  return { tree, problems }
}

export function validateNamed(text: string): { diagnostics: Diagnostic[] } {
  const { problems } = parseNamed(text)
  return { diagnostics: problems.map((p) => ({ line: p.line, severity: p.severity, message: `${p.explicacion} (named-checkconf: ${p.bind.replace(/^\S+:\d+: /, '')})` })) }
}

/** Lista de direcciones de un bloque (listen-on { 127.0.0.1; any; }). */
export function addrList(stmt: NamedStmt | undefined): string[] | undefined {
  if (!stmt) return undefined
  return (stmt.block ?? []).map((s) => [s.name, ...s.args].join(' '))
}
