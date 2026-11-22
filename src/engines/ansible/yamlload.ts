/**
 * Carga YAML como Ansible (YAML 1.1: yes/no son booleanos y 0644 es octal), con las etiquetas
 * !vault y !unsafe, y recordando en qué línea empieza cada diccionario, para los mensajes de
 * error ("The error appears to be in ...: line 12, column 7").
 */
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument, type Node as YNode, type ScalarTag } from 'yaml'
import { VaultString } from './vault'

export class Unsafe {
  constructor(public readonly value: string) {}
}

const TAGS: ScalarTag[] = [
  { tag: '!vault', resolve: (s: string) => new VaultString(s) as unknown as string },
  { tag: '!unsafe', resolve: (s: string) => new Unsafe(s) as unknown as string },
]

export interface Loaded {
  data: unknown
  /** Línea y columna (desde 1) de cada diccionario y lista. */
  where: WeakMap<object, { line: number; col: number }>
  lines: string[]
}

export class YamlLoadError extends Error {
  constructor(
    message: string,
    public readonly line: number,
    public readonly col: number,
  ) {
    super(message)
  }
}

/** El bloque "The error appears to be in..." de Ansible. */
export function errorContext(file: string, lines: string[], line: number, col: number): string {
  const offending = lines[line - 1] ?? ''
  const prev = lines[line - 2]
  return `The error appears to be in '${file}': line ${line}, column ${col}, but may\nbe elsewhere in the file depending on the exact syntax problem.\n\nThe offending line appears to be:\n\n${prev !== undefined && prev.trim() ? `${prev}\n` : '\n'}${offending}\n${' '.repeat(Math.max(0, col - 1))}^ here\n`
}

export function loadYaml(text: string): Loaded {
  const lc = new LineCounter()
  const doc = parseDocument(text, { version: '1.1', customTags: TAGS, lineCounter: lc, prettyErrors: false, uniqueKeys: false })
  const lines = text.split('\n')
  if (doc.errors.length) {
    const e = doc.errors[0]
    const pos = lc.linePos(e.pos[0])
    const msg = e.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, '')
    const friendly = /Implicit map keys need to be followed by map values|Nested mappings are not allowed in compact mappings/.test(msg)
      ? 'mapping values are not allowed in this context'
      : /must be indented|Bad indentation|All mapping items must start at the same column|unexpected/i.test(msg)
        ? 'did not find expected key'
        : msg
    throw new YamlLoadError(friendly, pos.line, pos.col)
  }
  const where = new WeakMap<object, { line: number; col: number }>()
  const toJs = (n: YNode | null | undefined): unknown => {
    if (!n) return null
    if (isAlias(n)) return toJs(n.resolve(doc) as YNode)
    if (isScalar(n)) return n.value
    if (isMap(n)) {
      const out: Record<string, unknown> = {}
      for (const pair of n.items) {
        const k = isScalar(pair.key) ? pair.key.value : toJs(pair.key as YNode)
        const key = String(k)
        if (key === '<<') {
          const merged = toJs(pair.value as YNode)
          for (const m of Array.isArray(merged) ? merged : [merged]) if (m && typeof m === 'object') Object.assign(out, m)
          continue
        }
        out[key] = toJs(pair.value as YNode)
      }
      if (n.range) {
        const p = lc.linePos(n.range[0])
        where.set(out, { line: p.line, col: p.col })
      }
      return out
    }
    if (isSeq(n)) {
      const out = n.items.map((x) => toJs(x as YNode))
      if (n.range) {
        const p = lc.linePos(n.range[0])
        where.set(out, { line: p.line, col: p.col })
      }
      return out
    }
    return null
  }
  return { data: toJs(doc.contents as YNode), where, lines }
}
