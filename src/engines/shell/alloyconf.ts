/**
 * La configuración de Grafana Alloy (config.alloy): el lenguaje de bloques y atributos, la
 * validación de componentes (como alloy fmt y el arranque del servicio) y la evaluación de lo que
 * importa para el laboratorio: qué archivos y qué journal manda cada agente a qué Loki, con qué
 * etiquetas, y qué métricas manda a qué Prometheus.
 */

export class AlloyError extends Error {
  constructor(
    public line: number,
    public col: number,
    msg: string,
  ) {
    super(msg)
  }
}

type Tok = { k: 'ident' | 'str' | 'num' | 'op' | 'eof'; v: string; line: number; col: number }

function lex(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  let line = 1
  let col = 1
  const adv = (n: number) => {
    for (let j = 0; j < n; j++) {
      if (src[i] === '\n') {
        line++
        col = 1
      } else col++
      i++
    }
  }
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      adv(1)
      continue
    }
    if (src.startsWith('//', i)) {
      while (i < src.length && src[i] !== '\n') adv(1)
      continue
    }
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2)
      adv(end < 0 ? src.length - i : end + 2 - i)
      continue
    }
    const L = line
    const C = col
    if (c === '"') {
      let j = i + 1
      let s = ''
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\n') throw new AlloyError(L, C, 'unterminated string literal')
        if (src[j] === '\\') {
          const n = src[j + 1]
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n
          j += 2
        } else s += src[j++]
      }
      if (j >= src.length) throw new AlloyError(L, C, 'unterminated string literal')
      adv(j + 1 - i)
      out.push({ k: 'str', v: s, line: L, col: C })
      continue
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1)
      if (end < 0) throw new AlloyError(L, C, 'unterminated raw string literal')
      const s = src.slice(i + 1, end)
      adv(end + 1 - i)
      out.push({ k: 'str', v: s, line: L, col: C })
      continue
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^-?\d+(\.\d+)?/.exec(src.slice(i))!
      adv(m[0].length)
      out.push({ k: 'num', v: m[0], line: L, col: C })
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i))!
      adv(m[0].length)
      out.push({ k: 'ident', v: m[0], line: L, col: C })
      continue
    }
    if ('{}[](),=+'.includes(c)) {
      adv(1)
      out.push({ k: 'op', v: c, line: L, col: C })
      continue
    }
    throw new AlloyError(L, C, `illegal character ${JSON.stringify(c)}`)
  }
  out.push({ k: 'eof', v: '', line, col })
  return out
}

export type Expr =
  | { k: 'str'; v: string }
  | { k: 'num'; v: number }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'arr'; items: Expr[] }
  | { k: 'obj'; entries: { key: string; value: Expr }[] }
  | { k: 'ref'; path: string; line: number; col: number }
  | { k: 'call'; fn: string; args: Expr[]; line: number; col: number }
  | { k: 'add'; l: Expr; r: Expr }

export interface Block {
  name: string
  label?: string
  attrs: { name: string; value: Expr; line: number; col: number }[]
  blocks: Block[]
  line: number
  col: number
}

class Parser {
  i = 0
  constructor(private t: Tok[]) {}
  peek(n = 0) {
    return this.t[this.i + n]
  }
  next() {
    return this.t[this.i++]
  }
  fail(msg?: string): never {
    const tk = this.peek()
    throw new AlloyError(tk.line, tk.col, msg ?? `expected ${tk.k === 'eof' ? 'block or attribute' : 'attribute assignment or block'}, got ${tk.k === 'eof' ? 'EOF' : tk.k === 'op' ? JSON.stringify(tk.v) : tk.k.toUpperCase()}`)
  }
  expect(v: string) {
    const tk = this.peek()
    if (tk.k !== 'op' || tk.v !== v) throw new AlloyError(tk.line, tk.col, `expected ${v}, got ${tk.k === 'eof' ? 'EOF' : tk.k === 'op' ? tk.v : tk.k.toUpperCase()}`)
    return this.next()
  }
  body(end: string | undefined): Pick<Block, 'attrs' | 'blocks'> {
    const attrs: Block['attrs'] = []
    const blocks: Block[] = []
    for (;;) {
      const tk = this.peek()
      if (end === undefined && tk.k === 'eof') break
      if (end !== undefined && tk.k === 'op' && tk.v === end) break
      if (tk.k !== 'ident') this.fail()
      const nx = this.peek(1)
      if (nx.k === 'op' && nx.v === '=') {
        if (tk.v.includes('.')) throw new AlloyError(tk.line, tk.col, `expected attribute assignment or block, got ${tk.v}`)
        this.next()
        this.next()
        attrs.push({ name: tk.v, value: this.expr(), line: tk.line, col: tk.col })
        continue
      }
      this.next()
      let label: string | undefined
      if (this.peek().k === 'str') label = this.next().v
      this.expect('{')
      const b = this.body('}')
      this.expect('}')
      blocks.push({ name: tk.v, label, ...b, line: tk.line, col: tk.col })
    }
    return { attrs, blocks }
  }
  expr(): Expr {
    let l = this.primary()
    while (this.peek().k === 'op' && this.peek().v === '+') {
      this.next()
      l = { k: 'add', l, r: this.primary() }
    }
    return l
  }
  primary(): Expr {
    const tk = this.next()
    if (tk.k === 'str') return { k: 'str', v: tk.v }
    if (tk.k === 'num') return { k: 'num', v: Number(tk.v) }
    if (tk.k === 'ident') {
      if (tk.v === 'true' || tk.v === 'false') return { k: 'bool', v: tk.v === 'true' }
      if (tk.v === 'null') return { k: 'null' }
      if (this.peek().k === 'op' && this.peek().v === '(') {
        this.next()
        const args: Expr[] = []
        while (!(this.peek().k === 'op' && this.peek().v === ')')) {
          args.push(this.expr())
          if (this.peek().k === 'op' && this.peek().v === ',') this.next()
          else break
        }
        this.expect(')')
        return { k: 'call', fn: tk.v, args, line: tk.line, col: tk.col }
      }
      return { k: 'ref', path: tk.v, line: tk.line, col: tk.col }
    }
    if (tk.k === 'op' && tk.v === '[') {
      const items: Expr[] = []
      while (!(this.peek().k === 'op' && this.peek().v === ']')) {
        items.push(this.expr())
        if (this.peek().k === 'op' && this.peek().v === ',') this.next()
        else break
      }
      this.expect(']')
      return { k: 'arr', items }
    }
    if (tk.k === 'op' && tk.v === '{') {
      const entries: { key: string; value: Expr }[] = []
      while (!(this.peek().k === 'op' && this.peek().v === '}')) {
        const key = this.next()
        if (key.k !== 'ident' && key.k !== 'str') throw new AlloyError(key.line, key.col, `expected object key, got ${key.k === 'op' ? key.v : key.k.toUpperCase()}`)
        this.expect('=')
        entries.push({ key: key.v, value: this.expr() })
        if (this.peek().k === 'op' && this.peek().v === ',') this.next()
        else break
      }
      this.expect('}')
      return { k: 'obj', entries }
    }
    this.i--
    this.fail(`expected expression, got ${tk.k === 'eof' ? 'EOF' : tk.k === 'op' ? tk.v : String(tk.k).toUpperCase()}`)
  }
}

export function parseAlloy(src: string): Block[] {
  return new Parser(lex(src)).body(undefined).blocks
}

// ---------------------------------------------------------------------------------------
// Componentes conocidos
// ---------------------------------------------------------------------------------------

interface CompSpec {
  attrs: string[]
  required?: string[]
  blocks?: Record<string, CompSpec>
  /** Lo que exporta (para validar referencias). */
  exports?: string[]
  /** Bloque sin etiqueta (logging, livedebugging). */
  unlabeled?: boolean
}

const RULE: CompSpec = { attrs: ['source_labels', 'separator', 'regex', 'modulus', 'target_label', 'replacement', 'action'] }
const STAGES: Record<string, CompSpec> = {
  'stage.static_labels': { attrs: ['values'], required: ['values'] },
  'stage.labels': { attrs: ['values'], required: ['values'] },
  'stage.regex': { attrs: ['expression', 'source'], required: ['expression'] },
  'stage.json': { attrs: ['expressions', 'source', 'drop_malformed'], required: ['expressions'] },
  'stage.logfmt': { attrs: ['mapping', 'source'], required: ['mapping'] },
  'stage.drop': { attrs: ['source', 'expression', 'value', 'older_than', 'longer_than', 'drop_counter_reason'] },
  'stage.match': { attrs: ['selector', 'pipeline_name', 'action'], required: ['selector'] },
  'stage.timestamp': { attrs: ['source', 'format', 'location'], required: ['source', 'format'] },
  'stage.label_drop': { attrs: ['values'], required: ['values'] },
}

export const COMPONENTS: Record<string, CompSpec> = {
  logging: { attrs: ['level', 'format', 'write_to'], unlabeled: true },
  livedebugging: { attrs: ['enabled'], unlabeled: true },
  'local.file_match': { attrs: ['path_targets', 'sync_period'], required: ['path_targets'], exports: ['targets'] },
  'loki.source.file': { attrs: ['targets', 'forward_to', 'encoding', 'tail_from_end', 'legacy_positions_file'], required: ['targets', 'forward_to'] },
  'loki.source.journal': { attrs: ['format_as_json', 'max_age', 'path', 'relabel_rules', 'matches', 'forward_to', 'labels'], required: ['forward_to'] },
  'loki.relabel': { attrs: ['forward_to', 'max_cache_size'], required: ['forward_to'], blocks: { rule: RULE }, exports: ['receiver', 'rules'] },
  'loki.process': { attrs: ['forward_to'], required: ['forward_to'], blocks: STAGES, exports: ['receiver'] },
  'loki.write': { attrs: ['external_labels', 'max_streams'], blocks: { endpoint: { attrs: ['name', 'url', 'bearer_token', 'headers', 'tenant_id', 'batch_wait', 'batch_size'], required: ['url'] } }, exports: ['receiver'] },
  'prometheus.exporter.unix': { attrs: ['set_collectors', 'enable_collectors', 'disable_collectors', 'include_exporter_metrics', 'procfs_path', 'sysfs_path', 'rootfs_path'], exports: ['targets'] },
  'prometheus.scrape': { attrs: ['targets', 'forward_to', 'job_name', 'scrape_interval', 'scrape_timeout', 'metrics_path', 'scheme'], required: ['targets', 'forward_to'] },
  'prometheus.remote_write': { attrs: ['external_labels'], blocks: { endpoint: { attrs: ['name', 'url', 'remote_timeout', 'headers', 'bearer_token'], required: ['url'] } }, exports: ['receiver'] },
  'discovery.relabel': { attrs: ['targets'], required: ['targets'], blocks: { rule: RULE }, exports: ['output', 'rules'] },
}

function attrOf(b: Block, name: string): Expr | undefined {
  return b.attrs.find((a) => a.name === name)?.value
}

function refs(e: Expr, out: Extract<Expr, { k: 'ref' }>[] = []): Extract<Expr, { k: 'ref' }>[] {
  if (e.k === 'ref') out.push(e)
  else if (e.k === 'arr') e.items.forEach((x) => refs(x, out))
  else if (e.k === 'obj') e.entries.forEach((x) => refs(x.value, out))
  else if (e.k === 'call') e.args.forEach((x) => refs(x, out))
  else if (e.k === 'add') {
    refs(e.l, out)
    refs(e.r, out)
  }
  return out
}

const GLOBAL_REFS = new Set(['constants.hostname', 'constants.os', 'constants.arch'])

/** Valida la configuración como lo hace Alloy al arrancar. Devuelve los bloques si está bien. */
export function validateAlloy(src: string): Block[] {
  const blocks = parseAlloy(src)
  const declared = new Map<string, Block>()
  for (const b of blocks) {
    const spec = COMPONENTS[b.name]
    if (!spec) throw new AlloyError(b.line, b.col, `unrecognized block name "${b.name}"`)
    if (!spec.unlabeled && b.label === undefined) throw new AlloyError(b.line, b.col, `component "${b.name}" must have a label`)
    const id = b.label === undefined ? b.name : `${b.name}.${b.label}`
    const prev = declared.get(id)
    if (prev) throw new AlloyError(b.line, b.col, `block ${id} already declared at ${prev.line}:${prev.col}`)
    declared.set(id, b)
    checkBody(b, spec)
  }
  // Referencias: tienen que apuntar a un componente declarado y a algo que exporte.
  for (const b of blocks) {
    const all = [...b.attrs.map((a) => a.value), ...b.blocks.flatMap((x) => x.attrs.map((a) => a.value))]
    for (const r of all.flatMap((e) => refs(e))) {
      if (GLOBAL_REFS.has(r.path)) continue
      const parts = r.path.split('.')
      const exp = parts.pop()!
      const id = parts.join('.')
      const target = declared.get(id)
      if (!target) throw new AlloyError(r.line, r.col, `component "${id}" does not exist or is out of scope`)
      const spec = COMPONENTS[target.name]
      if (!spec.exports?.includes(exp)) throw new AlloyError(r.line, r.col, `field "${exp}" does not exist`)
    }
  }
  return blocks
}

function checkBody(b: Block, spec: CompSpec) {
  for (const a of b.attrs) if (!spec.attrs.includes(a.name)) throw new AlloyError(a.line, a.col, `unrecognized attribute name "${a.name}"`)
  for (const r of spec.required ?? []) if (!b.attrs.some((a) => a.name === r)) throw new AlloyError(b.line, b.col, `missing required attribute "${r}"`)
  for (const sub of b.blocks) {
    const s = spec.blocks?.[sub.name]
    if (!s) throw new AlloyError(sub.line, sub.col, `unrecognized block name "${sub.name}"`)
    checkBody(sub, s)
  }
  if ((b.name === 'loki.write' || b.name === 'prometheus.remote_write') && !b.blocks.some((x) => x.name === 'endpoint')) {
    // Alloy arranca igual, pero no manda nada: lo dejamos pasar (como el real).
  }
}

/** Formato canónico (alloy fmt): dos espacios de sangría y los "=" alineados. */
export function formatAlloy(src: string): string {
  const blocks = parseAlloy(src)
  const out: string[] = []
  const ex = (e: Expr, ind: string): string => {
    switch (e.k) {
      case 'str':
        return JSON.stringify(e.v)
      case 'num':
        return String(e.v)
      case 'bool':
        return String(e.v)
      case 'null':
        return 'null'
      case 'ref':
        return e.path
      case 'add':
        return `${ex(e.l, ind)} + ${ex(e.r, ind)}`
      case 'call':
        return `${e.fn}(${e.args.map((a) => ex(a, ind)).join(', ')})`
      case 'arr':
        if (!e.items.length) return '[]'
        if (e.items.every((i) => i.k !== 'obj' && i.k !== 'arr')) return `[${e.items.map((i) => ex(i, ind)).join(', ')}]`
        return `[${e.items.map((i) => ex(i, ind + '  ')).join(', ')}]`
      case 'obj': {
        if (!e.entries.length) return '{}'
        const w = Math.max(...e.entries.map((x) => (/^[A-Za-z_]\w*$/.test(x.key) ? x.key : JSON.stringify(x.key)).length))
        return `{\n${e.entries.map((x) => `${ind}  ${(/^[A-Za-z_]\w*$/.test(x.key) ? x.key : JSON.stringify(x.key)).padEnd(w)} = ${ex(x.value, ind + '  ')},`).join('\n')}\n${ind}}`
      }
    }
  }
  const block = (b: Block, ind: string) => {
    out.push(`${ind}${b.name}${b.label !== undefined ? ` ${JSON.stringify(b.label)}` : ''} {`)
    const w = Math.max(0, ...b.attrs.map((a) => a.name.length))
    for (const a of b.attrs) out.push(`${ind}  ${a.name.padEnd(w)} = ${ex(a.value, ind + '  ')}`)
    for (const s of b.blocks) {
      if (b.attrs.length || s !== b.blocks[0]) out.push('')
      block(s, ind + '  ')
    }
    out.push(`${ind}}`)
  }
  blocks.forEach((b, i) => {
    if (i) out.push('')
    block(b, '')
  })
  return out.join('\n') + '\n'
}

// ---------------------------------------------------------------------------------------
// Evaluación
// ---------------------------------------------------------------------------------------

export type Value = string | number | boolean | null | Value[] | { [k: string]: Value } | { __recv: string }

export interface Env {
  hostname: string
  env: Record<string, string>
}

function evalExpr(e: Expr, scope: (path: string) => Value | undefined, env: Env): Value {
  switch (e.k) {
    case 'str':
    case 'num':
    case 'bool':
      return e.v
    case 'null':
      return null
    case 'arr':
      return e.items.map((x) => evalExpr(x, scope, env))
    case 'obj':
      return Object.fromEntries(e.entries.map((x) => [x.key, evalExpr(x.value, scope, env)]))
    case 'add': {
      const l = evalExpr(e.l, scope, env)
      const r = evalExpr(e.r, scope, env)
      return typeof l === 'number' && typeof r === 'number' ? l + r : `${l}${r}`
    }
    case 'ref':
      if (e.path === 'constants.hostname') return env.hostname
      if (e.path === 'constants.os') return 'linux'
      if (e.path === 'constants.arch') return 'amd64'
      return scope(e.path) ?? null
    case 'call': {
      const args = e.args.map((a) => evalExpr(a, scope, env))
      if (e.fn === 'array.concat') return args.flatMap((a) => (Array.isArray(a) ? a : []))
      if (e.fn === 'sys.env' || e.fn === 'env') return env.env[String(args[0])] ?? ''
      if (e.fn === 'coalesce') return args.find((a) => a !== null && a !== '' && !(Array.isArray(a) && !a.length)) ?? null
      if (e.fn === 'string.format' || e.fn === 'format') {
        let i = 1
        return String(args[0]).replace(/%[sdv]/g, () => String(args[i++] ?? ''))
      }
      if (e.fn === 'string.join') return (args[0] as Value[]).map(String).join(String(args[1]))
      if (e.fn === 'string.to_lower') return String(args[0]).toLowerCase()
      if (e.fn === 'string.to_upper') return String(args[0]).toUpperCase()
      return null
    }
  }
}

export interface RelabelRule {
  source_labels?: string[]
  separator?: string
  regex?: string
  target_label?: string
  replacement?: string
  action?: string
}

/** Un destino de los logs: aplica etiquetas y reglas y termina en uno o más loki.write. */
export interface LogSink {
  staticLabels: Record<string, string>
  rules: RelabelRule[]
  /** Etiquetas que saca stage.label_drop. */
  drop: string[]
  /** Expresiones de stage.drop: las líneas que coinciden no se mandan. */
  dropLines: RegExp[]
  urls: string[]
  externalLabels: Record<string, string>
}

export interface LogSource {
  kind: 'file' | 'journal'
  /** Archivos: patrón (__path__) y etiquetas del objetivo. */
  targets?: Record<string, string>[]
  /** Journal: etiquetas fijas y reglas (relabel_rules) sobre __journal__systemd_unit y compañía. */
  labels?: Record<string, string>
  journalRules?: RelabelRule[]
  sinks: LogSink[]
}

export interface MetricsPipeline {
  /** Lo que exporta prometheus.exporter.unix (instance y job) y a qué remote_write va. */
  instance: string
  job: string
  urls: string[]
}

export interface AlloyPlan {
  logs: LogSource[]
  metrics: MetricsPipeline[]
}

/** Qué manda este agente y adónde. */
export function planAlloy(blocks: Block[], env: Env): AlloyPlan {
  const byId = new Map<string, Block>()
  for (const b of blocks) if (b.label !== undefined) byId.set(`${b.name}.${b.label}`, b)
  const rulesOf = (b: Block): RelabelRule[] =>
    b.blocks
      .filter((x) => x.name === 'rule')
      .map((r) => Object.fromEntries(r.attrs.map((a) => [a.name, evalExpr(a.value, scope, env)])) as RelabelRule)
  const scope = (path: string): Value | undefined => {
    const parts = path.split('.')
    const exp = parts.pop()!
    const id = parts.join('.')
    const b = byId.get(id)
    if (!b) return undefined
    if (b.name === 'local.file_match' && exp === 'targets') return evalExpr(attrOf(b, 'path_targets')!, scope, env)
    if (b.name === 'discovery.relabel' && exp === 'output') return evalExpr(attrOf(b, 'targets')!, scope, env)
    if (b.name === 'prometheus.exporter.unix' && exp === 'targets') return [{ __address__: '127.0.0.1:12345', instance: env.hostname, job: 'integrations/unix', __unix__: 'true' }]
    if (exp === 'receiver') return { __recv: id }
    if (exp === 'rules') return { __rules: id } as unknown as Value
    return undefined
  }
  const sinkFrom = (recv: string, seen = new Set<string>()): LogSink[] => {
    if (seen.has(recv)) return []
    seen.add(recv)
    const b = byId.get(recv)
    if (!b) return []
    if (b.name === 'loki.write') {
      const urls = b.blocks.filter((x) => x.name === 'endpoint').map((x) => String(evalExpr(attrOf(x, 'url')!, scope, env)))
      const ext = attrOf(b, 'external_labels')
      return [{ staticLabels: {}, rules: [], drop: [], dropLines: [], urls, externalLabels: ext ? (evalExpr(ext, scope, env) as Record<string, string>) : {} }]
    }
    const next = ((evalExpr(attrOf(b, 'forward_to')!, scope, env) as Value[]) ?? []).flatMap((r) => (r && typeof r === 'object' && '__recv' in (r as object) ? sinkFrom((r as { __recv: string }).__recv, seen) : []))
    if (b.name === 'loki.relabel') {
      const rules = rulesOf(b)
      return next.map((s) => ({ ...s, rules: [...rules, ...s.rules] }))
    }
    if (b.name === 'loki.process') {
      const st: Record<string, string> = {}
      const drop: string[] = []
      const dropLines: RegExp[] = []
      for (const stage of b.blocks) {
        if (stage.name === 'stage.static_labels') Object.assign(st, evalExpr(attrOf(stage, 'values')!, scope, env) as Record<string, string>)
        if (stage.name === 'stage.label_drop') drop.push(...((evalExpr(attrOf(stage, 'values')!, scope, env) as string[]) ?? []))
        if (stage.name === 'stage.drop') {
          const ex = attrOf(stage, 'expression')
          if (ex) {
            try {
              dropLines.push(new RegExp(String(evalExpr(ex, scope, env))))
            } catch {
              // expresión inválida: Alloy no arrancaría, ya lo valida el servicio
            }
          }
        }
      }
      return next.map((s) => ({ ...s, staticLabels: { ...st, ...s.staticLabels }, drop: [...drop, ...s.drop], dropLines: [...dropLines, ...s.dropLines] }))
    }
    return next
  }
  const forward = (b: Block) => ((evalExpr(attrOf(b, 'forward_to')!, scope, env) as Value[]) ?? []).flatMap((r) => (r && typeof r === 'object' && '__recv' in (r as object) ? sinkFrom((r as { __recv: string }).__recv) : []))
  const logs: LogSource[] = []
  const metrics: MetricsPipeline[] = []
  for (const b of blocks) {
    if (b.name === 'loki.source.file') {
      const targets = ((evalExpr(attrOf(b, 'targets')!, scope, env) as Value[]) ?? []).filter((x) => x && typeof x === 'object' && !Array.isArray(x)) as Record<string, string>[]
      logs.push({ kind: 'file', targets, sinks: forward(b) })
    } else if (b.name === 'loki.source.journal') {
      const labels = attrOf(b, 'labels') ? (evalExpr(attrOf(b, 'labels')!, scope, env) as Record<string, string>) : {}
      const rr = attrOf(b, 'relabel_rules')
      let journalRules: RelabelRule[] = []
      if (rr?.k === 'ref') {
        const id = rr.path.split('.').slice(0, -1).join('.')
        const rb = byId.get(id)
        if (rb) journalRules = rulesOf(rb)
      }
      logs.push({ kind: 'journal', labels, journalRules, sinks: forward(b) })
    } else if (b.name === 'prometheus.scrape') {
      const targets = ((evalExpr(attrOf(b, 'targets')!, scope, env) as Value[]) ?? []) as Record<string, string>[]
      const fw = ((evalExpr(attrOf(b, 'forward_to')!, scope, env) as Value[]) ?? []).flatMap((r) => {
        const id = r && typeof r === 'object' && '__recv' in (r as object) ? (r as { __recv: string }).__recv : undefined
        const rb = id ? byId.get(id) : undefined
        return rb?.name === 'prometheus.remote_write' ? rb.blocks.filter((x) => x.name === 'endpoint').map((x) => String(evalExpr(attrOf(x, 'url')!, scope, env))) : []
      })
      for (const t of targets) if (t.__unix__) metrics.push({ instance: t.instance, job: t.job, urls: fw })
    }
  }
  return { logs, metrics }
}

/** Aplica reglas de relabel (replace, keep, drop, labeldrop, labelkeep) a un conjunto de etiquetas. */
export function relabel(labels: Record<string, string>, rules: RelabelRule[]): Record<string, string> | undefined {
  let l = { ...labels }
  for (const r of rules) {
    const action = r.action ?? 'replace'
    const src = (r.source_labels ?? []).map((k) => l[k] ?? '').join(r.separator ?? ';')
    const re = new RegExp(`^(?:${r.regex ?? '(.*)'})$`)
    if (action === 'replace') {
      const m = re.exec(src)
      if (!m || !r.target_label) continue
      const v = (r.replacement ?? '$1').replace(/\$\{?(\d+)\}?/g, (_x, g) => m[Number(g)] ?? '')
      if (v === '') delete l[r.target_label]
      else l[r.target_label] = v
    } else if (action === 'keep') {
      if (!re.test(src)) return undefined
    } else if (action === 'drop') {
      if (re.test(src)) return undefined
    } else if (action === 'labeldrop') {
      l = Object.fromEntries(Object.entries(l).filter(([k]) => !re.test(k)))
    } else if (action === 'labelkeep') {
      l = Object.fromEntries(Object.entries(l).filter(([k]) => re.test(k)))
    }
  }
  return l
}
