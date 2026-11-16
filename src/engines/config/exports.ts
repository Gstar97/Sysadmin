/**
 * /etc/exports: lectura (la usa el simulador de NFS) y validación para el editor, con los mismos
 * errores y avisos que da exportfs y los que conviene señalar aunque exportfs no los marque.
 */
import type { Diagnostic } from './types'

export interface NfsExport {
  path: string
  client: string
  opts: NfsOpts
  line: number
  file: string
}

export interface NfsOpts {
  rw: boolean
  sync: boolean
  wdelay: boolean
  hide: boolean
  crossmnt: boolean
  subtreeCheck: boolean
  secure: boolean
  rootSquash: boolean
  allSquash: boolean
  anonuid?: number
  anongid?: number
  fsid?: string
  sec: string
}

export interface ExportsParse {
  exports: NfsExport[]
  errors: { line: number; message: string }[]
  warnings: string[]
}

const DEFAULTS: NfsOpts = { rw: false, sync: true, wdelay: true, hide: true, crossmnt: false, subtreeCheck: false, secure: true, rootSquash: true, allSquash: false, sec: 'sys' }

function applyOpt(o: NfsOpts, raw: string): boolean {
  const [k, v] = raw.split('=')
  switch (k) {
    case 'rw': o.rw = true; return true
    case 'ro': o.rw = false; return true
    case 'sync': o.sync = true; return true
    case 'async': o.sync = false; return true
    case 'wdelay': o.wdelay = true; return true
    case 'no_wdelay': o.wdelay = false; return true
    case 'hide': o.hide = true; return true
    case 'nohide': o.hide = false; return true
    case 'crossmnt': o.crossmnt = true; return true
    case 'subtree_check': o.subtreeCheck = true; return true
    case 'no_subtree_check': o.subtreeCheck = false; return true
    case 'secure': o.secure = true; return true
    case 'insecure': o.secure = false; return true
    case 'root_squash': o.rootSquash = true; return true
    case 'no_root_squash': o.rootSquash = false; return true
    case 'all_squash': o.allSquash = true; return true
    case 'no_all_squash': o.allSquash = false; return true
    case 'anonuid': if (!/^\d+$/.test(v ?? '')) return false; o.anonuid = Number(v); return true
    case 'anongid': if (!/^\d+$/.test(v ?? '')) return false; o.anongid = Number(v); return true
    case 'fsid': if (!v) return false; o.fsid = v; return true
    case 'sec': if (!v) return false; o.sec = v; return true
    case 'no_acl': case 'mp': case 'nordirplus': case 'insecure_locks': case 'secure_locks': case 'pnfs': case 'no_pnfs': return true
    default: return false
  }
}

/** Lee el texto de /etc/exports (o de un archivo de /etc/exports.d). */
export function parseExports(text: string, file = '/etc/exports'): ExportsParse {
  const out: ExportsParse = { exports: [], errors: [], warnings: [] }
  // Las líneas que terminan en \ siguen en la siguiente.
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    const start = i + 1
    while (line.endsWith('\\') && i + 1 < lines.length) line = line.slice(0, -1) + ' ' + lines[++i]
    line = line.replace(/#.*$/, '').trim()
    if (!line) continue
    const m = /^("[^"]+"|\S+)\s*(.*)$/.exec(line)!
    const path = m[1].replace(/^"|"$/g, '')
    if (!path.startsWith('/')) {
      out.errors.push({ line: start, message: `exportfs: ${file}:${start}: bad path "${path}"` })
      continue
    }
    const rest = m[2].trim()
    // Cada cliente es "host(opciones)", sin espacio. "host (opciones)" son dos clientes distintos.
    const tokens = rest ? rest.match(/[^\s(]*(\([^)]*\))?/g)!.filter(Boolean) : []
    if (!tokens.length) {
      out.warnings.push(`exportfs: No host name given with ${path} (ro), suggest *(ro) to avoid warning`)
      out.exports.push({ path, client: '*', opts: { ...DEFAULTS }, line: start, file })
      continue
    }
    for (const tok of tokens) {
      const tm = /^([^(]*)(?:\(([^)]*)\))?$/.exec(tok)
      if (!tm) {
        out.errors.push({ line: start, message: `exportfs: ${file}:${start}: syntax error: bad option list` })
        continue
      }
      const host = tm[1]
      const optText = tm[2]
      const opts = { ...DEFAULTS }
      let bad = false
      for (const o of (optText ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
        if (!applyOpt(opts, o)) {
          out.errors.push({ line: start, message: `exportfs: ${file}:${start}: unknown keyword "${o}"` })
          bad = true
        }
      }
      if (bad) continue
      if (!host) out.warnings.push(`exportfs: No host name given with ${path} (${optText}), suggest *(${optText}) to avoid warning`)
      else if (optText === undefined) out.warnings.push(`exportfs: No options for ${path} ${host}: suggest ${host}(sync) to avoid warning`)
      out.exports.push({ path, client: host || '*', opts, line: start, file })
    }
  }
  return out
}


/** Validación para el editor de /etc/exports. */
export function validateExports(text: string): { diagnostics: Diagnostic[] } {
  const r = parseExports(text)
  const diagnostics: Diagnostic[] = []
  for (const e of r.errors) {
    const kw = /unknown keyword "([^"]+)"/.exec(e.message)?.[1]
    const path = /bad path "([^"]+)"/.exec(e.message)?.[1]
    diagnostics.push({
      line: e.line,
      severity: 'error',
      message: kw ? `Opción desconocida "${kw}" (exportfs: unknown keyword "${kw}"). Revisá si está bien escrita.` : path ? `La ruta tiene que ser absoluta, empezando con "/" (exportfs: bad path "${path}").` : e.message,
    })
  }
  const lines = text.split('\n')
  lines.forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '')
    const m = /^\s*(\S+)\s+(.*)$/.exec(line)
    if (!m || !m[1].startsWith('/')) return
    const n = i + 1
    // "host (opciones)": dos clientes. El segundo es todo el mundo.
    const sp = /(\S+)\s+\(([^)]*)\)/.exec(m[2])
    if (sp && !sp[1].endsWith(')')) {
      diagnostics.push({ line: n, severity: 'error', message: `Hay un espacio entre "${sp[1]}" y "(${sp[2]})": son dos clientes distintos. ${sp[1]} queda con las opciones de fábrica (solo lectura) y (${sp[2]}) se aplica a todo el mundo. Sacá el espacio: ${sp[1]}(${sp[2]}).` })
    } else if (/^\s*\(/.test(m[2])) {
      diagnostics.push({ line: n, severity: 'error', message: `Las opciones (${/\(([^)]*)\)/.exec(m[2])?.[1] ?? ''}) no tienen cliente: se aplican a todo el mundo (exportfs: No host name given).` })
    }
    for (const tok of m[2].match(/[^\s(]+(\([^)]*\))?/g) ?? []) {
      const host = tok.replace(/\(.*$/, '')
      if (!tok.includes('(') && host && !sp) diagnostics.push({ line: n, severity: 'warning', message: `${host} no tiene opciones: queda en solo lectura con las de fábrica (exportfs: No options for ...).` })
      if (/^\d+\.\d+\.\d+\.\d+\/(\d+)$/.test(host) && Number(host.split('/')[1]) > 32) diagnostics.push({ line: n, severity: 'error', message: `Máscara inválida en "${host}".` })
      if (/no_root_squash/.test(tok)) diagnostics.push({ line: n, severity: 'warning', message: 'no_root_squash: el root de cada cliente es root en el servidor. Solo si hace falta de verdad (por ejemplo, un respaldo que conserva dueños).' })
      if (host === '*' && /\brw\b/.test(tok)) diagnostics.push({ line: n, severity: 'warning', message: 'Escritura para cualquier equipo que llegue al servidor (*). Mejor una red o equipos concretos.' })
    }
  })
  return { diagnostics }
}
