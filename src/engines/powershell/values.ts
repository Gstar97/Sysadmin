/** Valores de PowerShell: objetos con tipo, tablas hash, bloques de script y su formato en pantalla. */

export interface PsObject {
  __type: string
  [prop: string]: unknown
}

export interface ScriptBlock {
  __sb: true
  src: string
  body: unknown
}

export interface SecureString {
  __type: 'System.Security.SecureString'
  __secure: true
}

export type PsValue = unknown

export function psObject(type: string, props: Record<string, unknown>): PsObject {
  return { __type: type, ...props }
}

export function isPsObject(v: unknown): v is PsObject {
  return !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Map) && '__type' in (v as object)
}

export function isScriptBlock(v: unknown): v is ScriptBlock {
  return !!v && typeof v === 'object' && (v as ScriptBlock).__sb === true
}

export function typeName(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'string') return 'System.String'
  if (typeof v === 'number') return Number.isInteger(v) ? 'System.Int32' : 'System.Double'
  if (typeof v === 'boolean') return 'System.Boolean'
  if (Array.isArray(v)) return 'System.Object[]'
  if (v instanceof Map) return 'System.Collections.Hashtable'
  if (v instanceof Date) return 'System.DateTime'
  if (isScriptBlock(v)) return 'System.Management.Automation.ScriptBlock'
  if (isPsObject(v)) return v.__type
  return 'System.Management.Automation.PSCustomObject'
}

/** Propiedades visibles de un objeto (sin las internas que empiezan con __). */
export function propNames(v: unknown): string[] {
  if (v instanceof Map) return ['Name', 'Value']
  if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) return Object.keys(v).filter((k) => !k.startsWith('__'))
  if (typeof v === 'string') return ['Length']
  return []
}

/** Acceso a propiedades sin distinguir mayúsculas, con enumeración de miembros en colecciones. */
export function getProp(v: unknown, name: string): unknown {
  if (v === null || v === undefined) return null
  const lower = name.toLowerCase()
  if (Array.isArray(v)) {
    if (lower === 'count' || lower === 'length') return v.length
    const out = v.map((x) => getProp(x, name)).filter((x) => x !== null && x !== undefined)
    return out.flat()
  }
  if (typeof v === 'string') {
    if (lower === 'length') return v.length
    return null
  }
  if (v instanceof Map) {
    if (lower === 'count') return v.size
    if (lower === 'keys') return [...v.keys()]
    if (lower === 'values') return [...v.values()]
    for (const [k, val] of v) if (String(k).toLowerCase() === lower) return val
    return null
  }
  if (v instanceof Date) {
    const map: Record<string, number> = { year: v.getFullYear(), month: v.getMonth() + 1, day: v.getDate(), hour: v.getHours(), minute: v.getMinutes(), second: v.getSeconds(), dayofweek: v.getDay() }
    if (lower in map) return map[lower]
    if (lower === 'date') return new Date(v.getFullYear(), v.getMonth(), v.getDate())
    return null
  }
  if (typeof v === 'object') {
    for (const k of Object.keys(v)) if (k.toLowerCase() === lower) return (v as Record<string, unknown>)[k]
  }
  return null
}

export function setProp(v: unknown, name: string, value: unknown) {
  if (v instanceof Map) {
    for (const k of v.keys()) {
      if (String(k).toLowerCase() === name.toLowerCase()) {
        v.set(k, value)
        return
      }
    }
    v.set(name, value)
    return
  }
  if (v && typeof v === 'object') {
    const key = Object.keys(v).find((k) => k.toLowerCase() === name.toLowerCase()) ?? name
    ;(v as Record<string, unknown>)[key] = value
  }
}

// ---------------------------------------------------------------------------------------
// Conversión a texto
// ---------------------------------------------------------------------------------------

export function formatDate(d: Date, long = true): string {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const h = d.getHours() % 12 || 12
  const time = `${h}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`
  if (!long) return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${time}`
  return `${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${time}`
}

export function toText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e7) / 1e7)
  if (typeof v === 'string') return v
  if (v instanceof Date) return formatDate(v, false)
  if (Array.isArray(v)) return v.map(toText).join(' ')
  if (v instanceof Map) return 'System.Collections.Hashtable'
  if (isScriptBlock(v)) return v.src
  if (isPsObject(v)) {
    if (v.__type === 'System.Security.SecureString') return 'System.Security.SecureString'
    if (typeof v.__toString === 'string') return v.__toString
    const name = getProp(v, 'Name') ?? getProp(v, 'FullName')
    if (name !== null) return toText(name)
    return v.__type
  }
  return '@{' + propNames(v).map((k) => `${k}=${toText((v as Record<string, unknown>)[k])}`).join('; ') + '}'
}

/** Texto de una celda de tabla: las colecciones se muestran entre llaves, como en PowerShell. */
function cellText(v: unknown): string {
  if (Array.isArray(v)) return `{${v.map(toText).join(', ')}}`
  return toText(v)
}

export interface View {
  kind: 'table' | 'list'
  columns: { label: string; value: (o: PsObject) => unknown; align?: 'left' | 'right' }[]
  /** Encabezado de grupo (por ejemplo "Directory: C:\..."). */
  groupBy?: (o: PsObject) => string
}

export const VIEWS: Record<string, View> = {}

export function formatTable(items: unknown[], columns: { label: string; value: (o: unknown) => unknown; align?: 'left' | 'right' }[], width = 118): string {
  const rows = items.map((it) => columns.map((c) => cellText(c.value(it))))
  const widths = columns.map((c, i) => Math.max(c.label.length, ...rows.map((r) => r[i].length)))
  // Ajustar al ancho de la terminal recortando la última columna.
  const total = widths.reduce((s, w) => s + w + 1, 0)
  if (total > width) widths[widths.length - 1] = Math.max(columns[columns.length - 1].label.length, widths[widths.length - 1] - (total - width))
  const fmt = (text: string, i: number) => {
    let t = text
    if (t.length > widths[i]) t = t.slice(0, Math.max(0, widths[i] - 3)) + '...'
    return columns[i].align === 'right' ? t.padStart(widths[i]) : t.padEnd(widths[i])
  }
  const lines = [
    columns.map((c, i) => fmt(c.label, i)).join(' ').trimEnd(),
    columns.map((c, i) => (columns[i].align === 'right' ? '-'.repeat(c.label.length).padStart(widths[i]) : '-'.repeat(c.label.length).padEnd(widths[i]))).join(' ').trimEnd(),
    ...rows.map((r) => r.map((cell, i) => fmt(cell, i)).join(' ').trimEnd()),
  ]
  return '\n' + lines.join('\n') + '\n\n'
}

export function formatList(items: unknown[], props?: (o: unknown) => { label: string; value: unknown }[]): string {
  const blocks = items.map((it) => {
    const entries = props ? props(it) : propNames(it).map((k) => ({ label: k, value: getProp(it, k) }))
    const w = Math.max(0, ...entries.map((e) => e.label.length))
    return entries.map((e) => `${e.label.padEnd(w)} : ${cellText(e.value)}`).join('\n')
  })
  return '\n' + blocks.join('\n\n') + '\n\n'
}

function isScalar(v: unknown): boolean {
  return v === null || v === undefined || typeof v !== 'object' || v instanceof Date
}

/** Formato por defecto de la salida de un pipeline (lo que hace Out-Default). */
export function formatDefault(items: unknown[]): string {
  let out = ''
  let i = 0
  while (i < items.length) {
    const first = items[i]
    if (isScalar(first) || isScriptBlock(first)) {
      if (first instanceof Date) out += `\n${formatDate(first)}\n\n`
      else out += toText(first) + '\n'
      i++
      continue
    }
    // Agrupar elementos consecutivos del mismo tipo.
    const t = typeName(first)
    let j = i
    while (j < items.length && typeName(items[j]) === t && !isScalar(items[j])) j++
    const group = items.slice(i, j)
    i = j
    if (first instanceof Map) {
      out += formatTable(
        group.flatMap((m) => [...(m as Map<string, unknown>).entries()].map(([k, v]) => ({ Name: k, Value: v }))),
        [
          { label: 'Name', value: (o) => (o as { Name: string }).Name },
          { label: 'Value', value: (o) => (o as { Value: unknown }).Value },
        ],
      )
      continue
    }
    const view = VIEWS[t]
    if (view) {
      if (view.groupBy) {
        const groups = new Map<string, PsObject[]>()
        for (const g of group as PsObject[]) groups.set(view.groupBy(g), [...(groups.get(view.groupBy(g)) ?? []), g])
        for (const [header, members] of groups) {
          out += header
          out += view.kind === 'table' ? formatTable(members, view.columns as never).replace(/^\n/, '') : formatList(members, (o) => view.columns.map((c) => ({ label: c.label, value: c.value(o as PsObject) })))
        }
      } else if (view.kind === 'table') out += formatTable(group, view.columns as never)
      else out += formatList(group, (o) => view.columns.map((c) => ({ label: c.label, value: c.value(o as PsObject) })))
      continue
    }
    const props = propNames(first)
    if (props.length <= 4) out += formatTable(group, props.map((p) => ({ label: p, value: (o: unknown) => getProp(o, p) })))
    else out += formatList(group)
  }
  return out
}
