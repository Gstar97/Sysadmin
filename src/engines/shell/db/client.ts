/**
 * Lo que comparten los clientes: el formato de las tablas de resultados (mysql y psql) y la
 * conexión a un servidor, local por socket o por la red con TCP.
 */
import { reach } from '../http'
import type { System } from '../system'
import type { Result } from './engine'

// ---------------------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------------------

export function cell(v: unknown, kind: 'mariadb' | 'postgres', nullText = 'NULL'): string {
  if (v === null || v === undefined) return kind === 'mariadb' ? nullText : ''
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6)
  if (v instanceof Uint8Array) return '0x' + [...v].map((b) => b.toString(16).padStart(2, '0')).join('')
  return String(v)
}

const isNum = (v: unknown) => typeof v === 'number'
const wid = (s: string) => [...s].length

function pad(s: string, n: number, right: boolean): string {
  const fill = ' '.repeat(Math.max(0, n - wid(s)))
  return right ? fill + s : s + fill
}

/** Tabla de mysql con bordes. */
export function mysqlTable(columns: string[], rows: unknown[][]): string {
  const data = rows.map((r) => r.map((v) => cell(v, 'mariadb')))
  const w = columns.map((c, i) => Math.max(wid(c), ...data.map((r) => wid(r[i] ?? ''))))
  const line = '+' + w.map((n) => '-'.repeat(n + 2)).join('+') + '+'
  const out = [line, '| ' + columns.map((c, i) => pad(c, w[i], false)).join(' | ') + ' |', line]
  for (let r = 0; r < data.length; r++) out.push('| ' + data[r].map((v, i) => pad(v, w[i], isNum(rows[r][i]))).join(' | ') + ' |')
  out.push(line)
  return out.join('\n') + '\n'
}

/** Formato vertical (\G). */
export function mysqlVertical(columns: string[], rows: unknown[][]): string {
  const w = Math.max(...columns.map(wid))
  return rows
    .map((r, i) => `${'*'.repeat(27)} ${i + 1}. row ${'*'.repeat(27)}\n` + columns.map((c, j) => `${pad(c, w, true)}: ${cell(r[j], 'mariadb')}`).join('\n'))
    .join('\n') + '\n'
}

/** Modo batch: columnas separadas por tabulador (lo que ve un script). */
export function mysqlBatch(columns: string[], rows: unknown[][], header: boolean): string {
  const out: string[] = []
  if (header) out.push(columns.join('\t'))
  for (const r of rows) out.push(r.map((v) => cell(v, 'mariadb')).join('\t'))
  return out.length ? out.join('\n') + '\n' : ''
}

/** Tabla de psql (formato alineado). */
export function psqlTable(columns: string[], rows: unknown[][], opts: { tuplesOnly?: boolean; unaligned?: boolean; expanded?: boolean } = {}): string {
  const data = rows.map((r) => r.map((v) => cell(v, 'postgres')))
  if (opts.unaligned) {
    const out = opts.tuplesOnly ? [] : [columns.join('|')]
    out.push(...data.map((r) => r.join('|')))
    if (!opts.tuplesOnly) out.push(`(${rows.length} ${rows.length === 1 ? 'row' : 'rows'})`)
    return out.join('\n') + '\n'
  }
  if (opts.expanded) {
    const w = Math.max(...columns.map(wid))
    return rows.length
      ? data.map((r, i) => `-[ RECORD ${i + 1} ]${'-'.repeat(Math.max(1, w - 8))}+${'-'.repeat(10)}\n` + columns.map((c, j) => `${pad(c, w, false)} | ${r[j]}`).join('\n')).join('\n') + '\n'
      : '(0 rows)\n'
  }
  const w = columns.map((c, i) => Math.max(wid(c), ...data.map((r) => wid(r[i] ?? ''))))
  const out: string[] = []
  if (!opts.tuplesOnly) {
    out.push(' ' + columns.map((c, i) => center(c, w[i])).join(' | ') + ' ')
    out.push(w.map((n) => '-'.repeat(n + 2)).join('+'))
  }
  for (let r = 0; r < data.length; r++) out.push(' ' + data[r].map((v, i) => pad(v, w[i], isNum(rows[r][i]))).join(' | ').replace(/\s+$/, ''))
  if (!opts.tuplesOnly) out.push(`(${rows.length} ${rows.length === 1 ? 'row' : 'rows'})`)
  return out.join('\n') + '\n' + (opts.tuplesOnly ? '' : '\n')
}

function center(s: string, n: number): string {
  const total = n - wid(s)
  const left = Math.floor(total / 2)
  return ' '.repeat(left) + s + ' '.repeat(total - left)
}

export function secs(): string {
  return (0.001 + Math.random() * 0.004).toFixed(3)
}

/** Resultado de MariaDB con el texto del cliente interactivo. */
export function mysqlInteractive(r: Result, vertical: boolean): string {
  switch (r.kind) {
    case 'rows':
      if (!r.rows.length) return r.columns.length ? `Empty set (${secs()} sec)\n\n` : `Empty set (${secs()} sec)\n\n`
      return (vertical ? mysqlVertical(r.columns, r.rows) : mysqlTable(r.columns, r.rows)) + `${r.rows.length} ${r.rows.length === 1 ? 'row' : 'rows'} in set (${secs()} sec)\n\n`
    case 'ok':
      return `Query OK, ${r.affected} ${r.affected === 1 ? 'row' : 'rows'} affected${r.warnings ? `, ${r.warnings} warning${r.warnings > 1 ? 's' : ''}` : ''} (${secs()} sec)\n${r.info ? r.info + '\n' : ''}\n`
    case 'msg':
      return r.text + '\n'
    case 'error':
      return r.text + '\n'
    case 'empty':
      return 'ERROR: No query specified\n\n'
  }
}

// ---------------------------------------------------------------------------------------
// Conexión
// ---------------------------------------------------------------------------------------

export type Target = { sys: System; from: string; tcp: boolean; host: string } | { error: 'resolve' | 'timeout' | 'noroute'; host: string }

/** A qué servidor se conecta un cliente con -h (o sin él: el socket local). */
export function resolveTarget(sys: System, host: string | undefined, port: number): Target {
  if (!host || host === 'localhost') return { sys, from: 'localhost', tcp: false, host: 'localhost' }
  const ip = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : sys.resolveHost(host)
  if (!ip) return { error: 'resolve', host }
  const r = reach(sys, ip, port)
  if ('error' in r) return { error: r.error === 'noroute' ? 'noroute' : 'timeout', host }
  const from = r.target === sys && ip.startsWith('127.') ? 'localhost' : r.clientIp
  return { sys: r.target, from, tcp: true, host }
}

/** ¿El servidor escucha por TCP en esa dirección? (bind-address de MariaDB, listen_addresses de PostgreSQL) */
export function listensOn(setting: string, localIp: string, fromLocal: boolean): boolean {
  const vals = setting.split(',').map((x) => x.trim()).filter(Boolean)
  if (!vals.length || vals.includes('*') || vals.includes('0.0.0.0') || vals.includes('::')) return true
  if (vals.includes('skip-networking')) return false
  if (fromLocal && vals.some((v) => v === '127.0.0.1' || v === 'localhost' || v === '::1')) return true
  return vals.includes(localIp)
}
