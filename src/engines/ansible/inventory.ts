/**
 * Inventarios de Ansible: formato INI y YAML, grupos con hijos, variables de grupo y de equipo,
 * rangos (web[01:03]) y patrones de equipos (all, web:db, web:&prod, web:!web02, web*).
 */
import { parse as parseYaml } from 'yaml'

export interface Inventory {
  /** Equipos en el orden en que aparecen, con sus variables propias. */
  hosts: Map<string, Record<string, unknown>>
  groups: Map<string, { hosts: string[]; children: string[]; vars: Record<string, unknown> }>
  /** Problemas al leerlo (en el formato de los avisos de Ansible). */
  warnings: string[]
}

export class InventoryError extends Error {}

export function emptyInventory(): Inventory {
  const inv: Inventory = { hosts: new Map(), groups: new Map(), warnings: [] }
  group(inv, 'all')
  group(inv, 'ungrouped')
  return inv
}

function group(inv: Inventory, name: string) {
  let g = inv.groups.get(name)
  if (!g) {
    g = { hosts: [], children: [], vars: {} }
    inv.groups.set(name, g)
  }
  return g
}

function addHost(inv: Inventory, name: string, groupName: string, vars: Record<string, unknown>) {
  if (!inv.hosts.has(name)) inv.hosts.set(name, {})
  Object.assign(inv.hosts.get(name)!, vars)
  const g = group(inv, groupName)
  if (!g.hosts.includes(name)) g.hosts.push(name)
}

/** web[01:03].lab → web01.lab, web02.lab, web03.lab (también [a:c]). */
export function expandRange(name: string): string[] {
  const m = /^(.*?)\[([0-9a-z]+):([0-9a-z]+)(?::(\d+))?\](.*)$/.exec(name)
  if (!m) return [name]
  const [, pre, a, b, step, post] = m
  const out: string[] = []
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    for (let i = Number(a); i <= Number(b); i += Number(step ?? 1)) out.push(`${pre}${String(i).padStart(a.length, '0')}${post}`)
  } else for (let c = a.charCodeAt(0); c <= b.charCodeAt(0); c++) out.push(`${pre}${String.fromCharCode(c)}${post}`)
  return out.flatMap(expandRange)
}

/** Un valor de un inventario INI: números y booleanos como en Python, el resto texto. */
function iniValue(v: string): unknown {
  const s = v.trim()
  if (/^(['"]).*\1$/.test(s)) return s.slice(1, -1)
  if (/^-?\d+$/.test(s)) return Number(s)
  if (/^-?\d+\.\d+$/.test(s)) return Number(s)
  if (s === 'True' || s === 'true') return true
  if (s === 'False' || s === 'false') return false
  return s
}

/** key=value key2="con espacios" (como en las líneas de equipos de un INI). */
export function splitKv(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([\w.-]+)=("(?:[^"\\]|\\.)*"|'[^']*'|\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) out[m[1]] = m[2]
  return out
}

export function parseIni(text: string, file: string, inv = emptyInventory()): Inventory {
  let section = 'ungrouped'
  let kind: 'hosts' | 'vars' | 'children' = 'hosts'
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/(^|\s)[#;].*$/, '').trim()
    if (!line) return
    const sec = /^\[([^\]:]+)(?::(vars|children))?\]$/.exec(line)
    if (sec) {
      section = sec[1]
      kind = (sec[2] as 'vars' | 'children') ?? 'hosts'
      if (/[^\w-]/.test(section)) inv.warnings.push(`Invalid characters were found in group names but not replaced, use -vvvv to see details`)
      group(inv, section)
      return
    }
    if (/^\[/.test(line)) throw new InventoryError(`${file}:${i + 1}: Section [${line.slice(1)} has unknown type`)
    if (kind === 'vars') {
      const m = /^([\w.-]+)\s*=\s*(.*)$/.exec(line)
      if (!m) throw new InventoryError(`${file}:${i + 1}: Expected key=value, got: ${line}`)
      group(inv, section).vars[m[1]] = iniValue(m[2])
      return
    }
    if (kind === 'children') {
      const g = group(inv, section)
      if (!g.children.includes(line)) g.children.push(line)
      group(inv, line)
      return
    }
    const [name, ...rest] = line.split(/\s+/)
    const kv = splitKv(rest.join(' '))
    const vars = Object.fromEntries(Object.entries(kv).map(([k, v]) => [k, iniValue(v)]))
    for (const h of expandRange(name)) {
      const hm = /^([^:]+):(\d+)$/.exec(h)
      addHost(inv, hm ? hm[1] : h, section, hm ? { ...vars, ansible_port: Number(hm[2]) } : vars)
    }
  })
  return finish(inv)
}

export function parseYamlInventory(text: string, file: string, inv = emptyInventory()): Inventory {
  let data: unknown
  try {
    data = parseYaml(text, { version: '1.1' })
  } catch (e) {
    throw new InventoryError(`${file}: ${(e as Error).message.split('\n')[0]}`)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new InventoryError(`${file}: YAML inventory has invalid structure, it should be a dictionary, got: ${Array.isArray(data) ? 'list' : typeof data}`)
  const walk = (name: string, node: unknown) => {
    group(inv, name)
    if (node === null || node === undefined) return
    if (typeof node !== 'object' || Array.isArray(node)) throw new InventoryError(`${file}: Invalid "${name}" entry for "${name}" group, requires a dictionary, found "${Array.isArray(node) ? 'list' : typeof node}" instead.`)
    const n = node as Record<string, unknown>
    for (const k of Object.keys(n)) if (!['hosts', 'vars', 'children'].includes(k)) inv.warnings.push(`Skipping unexpected key (${k}) in group (${name}), only "vars", "children" and "hosts" are valid`)
    if (n.vars && typeof n.vars === 'object') Object.assign(group(inv, name).vars, n.vars)
    if (n.hosts && typeof n.hosts === 'object') {
      for (const [h, hv] of Object.entries(n.hosts as Record<string, unknown>)) {
        for (const e of expandRange(h)) addHost(inv, e, name, (hv && typeof hv === 'object' ? hv : {}) as Record<string, unknown>)
      }
    } else if (n.hosts !== undefined && n.hosts !== null) throw new InventoryError(`${file}: Invalid "hosts" entry for "${name}" group, requires a dictionary, found "${Array.isArray(n.hosts) ? 'list' : typeof n.hosts}" instead.`)
    if (n.children && typeof n.children === 'object') {
      for (const [c, cv] of Object.entries(n.children as Record<string, unknown>)) {
        const g = group(inv, name)
        if (!g.children.includes(c)) g.children.push(c)
        walk(c, cv)
      }
    }
  }
  for (const [name, node] of Object.entries(data as Record<string, unknown>)) walk(name, node)
  return finish(inv)
}

/** Los equipos sin grupo quedan en ungrouped; todo cuelga de all. */
function finish(inv: Inventory): Inventory {
  const all = group(inv, 'all')
  const grouped = new Set<string>()
  for (const [n, g] of inv.groups) if (n !== 'all' && n !== 'ungrouped') for (const h of g.hosts) grouped.add(h)
  const ung = group(inv, 'ungrouped')
  ung.hosts = ung.hosts.filter((h) => !grouped.has(h))
  const isChild = new Set<string>()
  for (const [n, g] of inv.groups) if (n !== 'all') for (const c of g.children) isChild.add(c)
  const top = [...inv.groups.keys()].filter((n) => n !== 'all' && n !== 'ungrouped' && !isChild.has(n))
  all.children = ['ungrouped', ...top]
  return inv
}

/** ¿El texto parece un inventario YAML? */
export function looksYaml(text: string, file: string): boolean {
  return /\.ya?ml$/.test(file) || /^\s*(all|[\w-]+):\s*$/m.test(text.split('\n').find((l) => l.trim() && !l.trim().startsWith('#')) ?? '')
}

export function parseInventory(text: string, file: string, inv = emptyInventory()): Inventory {
  return looksYaml(text, file) ? parseYamlInventory(text, file, inv) : parseIni(text, file, inv)
}

/** Todos los equipos de un grupo, incluidos los de sus hijos, en orden y sin repetir. */
export function groupHosts(inv: Inventory, name: string, seen = new Set<string>()): string[] {
  if (name === 'all') return [...inv.hosts.keys()]
  const g = inv.groups.get(name)
  if (!g || seen.has(name)) return []
  seen.add(name)
  const out = [...g.hosts]
  for (const c of g.children) for (const h of groupHosts(inv, c, seen)) if (!out.includes(h)) out.push(h)
  return out
}

/** Los grupos a los que pertenece un equipo (incluidos los padres), sin all. */
export function hostGroups(inv: Inventory, host: string): string[] {
  const out: string[] = []
  for (const name of inv.groups.keys()) if (name !== 'all' && groupHosts(inv, name).includes(host)) out.push(name)
  return out.sort()
}

/** Grupos de un equipo en el orden de prioridad de Ansible: los padres antes que los hijos. */
export function groupsByDepth(inv: Inventory, host: string): string[] {
  const depth = (g: string, seen = new Set<string>()): number => {
    if (seen.has(g)) return 0
    seen.add(g)
    let d = 0
    for (const [n, x] of inv.groups) if (x.children.includes(g) && n !== 'all') d = Math.max(d, depth(n, seen) + 1)
    return d
  }
  return hostGroups(inv, host).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
}

function glob(pat: string): RegExp {
  return new RegExp(`^${pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
}

/** Resuelve un patrón de equipos. Devuelve los equipos y los patrones que no coincidieron con nada. */
export function matchPattern(inv: Inventory, pattern: string): { hosts: string[]; unmatched: string[] } {
  const parts = pattern.split(/[:,]/).map((p) => p.trim()).filter(Boolean)
  let result: string[] = []
  const unmatched: string[] = []
  const resolve = (p: string): string[] => {
    if (p === 'all' || p === '*') return [...inv.hosts.keys()]
    if (inv.groups.has(p)) return groupHosts(inv, p)
    if (inv.hosts.has(p)) return [p]
    if (p === 'localhost' || p === '127.0.0.1') return ['localhost']
    if (/[*?]/.test(p)) {
      const re = glob(p)
      const out = [...inv.hosts.keys()].filter((h) => re.test(h))
      for (const [g] of inv.groups) if (re.test(g)) for (const h of groupHosts(inv, g)) if (!out.includes(h)) out.push(h)
      return out
    }
    if (p.startsWith('~')) {
      const re = new RegExp(p.slice(1))
      return [...inv.hosts.keys()].filter((h) => re.test(h))
    }
    return []
  }
  for (const raw of parts) {
    const op = raw[0] === '!' ? '!' : raw[0] === '&' ? '&' : ''
    const p = op ? raw.slice(1) : raw
    const hs = resolve(p)
    if (!hs.length) unmatched.push(p)
    if (op === '!') result = result.filter((h) => !hs.includes(h))
    else if (op === '&') result = result.filter((h) => hs.includes(h))
    else for (const h of hs) if (!result.includes(h)) result.push(h)
  }
  return { hosts: result, unmatched }
}
