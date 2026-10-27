import { isMap, isSeq, LineCounter, parseDocument, type Document } from 'yaml'
import type { Diagnostic } from './types'

export interface ParsedYaml {
  doc: Document
  data: unknown
  diagnostics: Diagnostic[]
  /** Línea (1..n) donde está el valor de una ruta, si existe. */
  lineOf: (path: (string | number)[]) => number
}

const TRANSLATIONS: [RegExp, string][] = [
  [/Tabs are not allowed as indentation/i, 'YAML no permite tabulaciones para sangrar: usa espacios.'],
  [/Implicit map keys need to be followed by map values/i, 'Falta ":" después de la clave, o la línea quedó mal sangrada.'],
  [/All mapping items must start at the same column/i, 'Las claves de un mismo nivel tienen que empezar en la misma columna (revisa la sangría).'],
  [/Nested mappings are not allowed in compact mappings/i, 'Hay dos ":" en la misma línea: si el valor tiene ":", ponlo entre comillas.'],
  [/Map keys must be unique/i, 'Hay una clave repetida en el mismo nivel.'],
  [/Missing closing "quote|Missing closing 'quote/i, 'Faltan comillas de cierre.'],
  [/A block sequence may not be used as an implicit map key/i, 'La lista está mal sangrada respecto de su clave.'],
  [/Sequence items are not allowed on the same line/i, 'Los elementos de una lista (-) van cada uno en su línea.'],
  [/Unexpected scalar at node end|Unexpected flow-map-end|Unexpected/i, 'Hay un elemento inesperado: revisa la sangría y los ":" de esta zona.'],
]

function translate(message: string): string {
  const first = message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, '')
  const t = TRANSLATIONS.find(([re]) => re.test(first))
  return t ? `${t[1]} (${first})` : first
}

export function parseYaml(text: string): ParsedYaml {
  const lc = new LineCounter()
  const doc = parseDocument(text, { lineCounter: lc, prettyErrors: false, uniqueKeys: true })
  const diagnostics: Diagnostic[] = []
  const tabLine = text.split('\n').findIndex((l) => /^ *\t/.test(l))
  if (tabLine !== -1) diagnostics.push({ line: tabLine + 1, column: 1, severity: 'error', message: 'YAML no permite tabulaciones para sangrar: usa espacios (2 por nivel es lo habitual).' })
  for (const e of doc.errors.slice(0, tabLine !== -1 ? 0 : 3)) {
    const pos = e.linePos?.[0] ?? lc.linePos(e.pos[0])
    diagnostics.push({ line: pos.line, column: pos.col, severity: 'error', message: translate(e.message) })
  }
  for (const w of doc.warnings) {
    const pos = w.linePos?.[0] ?? lc.linePos(w.pos[0])
    diagnostics.push({ line: pos.line, column: pos.col, severity: 'warning', message: translate(w.message) })
  }
  const lineOf = (path: (string | number)[]) => {
    // Primero intenta la línea de la clave; si no, la del valor.
    const parent = path.length > 1 ? doc.getIn(path.slice(0, -1), true) : doc.contents
    const last = path[path.length - 1]
    if (isMap(parent)) {
      const pair = parent.items.find((p) => (p.key as { value?: unknown } | null)?.value === last)
      const range = (pair?.key as { range?: [number, number, number] } | undefined)?.range
      if (range) return lc.linePos(range[0]).line
    }
    if (isSeq(parent) && typeof last === 'number') {
      const item = parent.items[last] as { range?: [number, number, number] } | undefined
      if (item?.range) return lc.linePos(item.range[0]).line
    }
    const node = doc.getIn(path, true) as { range?: [number, number, number] } | undefined
    return node?.range ? lc.linePos(node.range[0]).line : 1
  }
  let data: unknown = null
  if (!doc.errors.length) {
    try {
      data = doc.toJS()
    } catch {
      data = null
    }
  }
  return { doc, data, diagnostics, lineOf }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}
