/** Validación de archivos de configuración y corrección de las reglas de cada ejercicio. */
import type { ConfigLanguage, ConfigRule } from '@/content/exercise-schemas'
import { validateAnsible } from './ansible'
import { validateCompose } from './compose'
import { validateFstab } from './fstab'
import { findDirectives, validateNginx } from './nginx'
import { validateSshd } from './sshd'
import type { Diagnostic, NginxDirective } from './types'
import { parseYaml } from './yaml-tools'

export type { Diagnostic } from './types'

export interface Validation {
  diagnostics: Diagnostic[]
  data?: unknown
  tree?: NginxDirective[]
  entries?: { key: string; value: string; line: number }[]
}

export function validateConfig(lang: ConfigLanguage, text: string): Validation {
  switch (lang) {
    case 'nginx':
      return validateNginx(text)
    case 'compose':
      return validateCompose(text)
    case 'ansible':
      return validateAnsible(text)
    case 'yaml': {
      const { data, diagnostics } = parseYaml(text)
      return { data, diagnostics }
    }
    case 'sshd':
      return validateSshd(text)
    case 'fstab':
      return { diagnostics: validateFstab(text).diagnostics }
    case 'texto':
      return { diagnostics: [] }
  }
}

/** Valores en una ruta como "services.web.ports", "[0].tasks[1].name" o "services.*.image". */
export function valuesAt(data: unknown, path: string): unknown[] {
  const segments = path.match(/\[\d+\]|[^.[\]]+/g) ?? []
  let current: unknown[] = [data]
  for (const seg of segments) {
    const next: unknown[] = []
    for (const v of current) {
      if (v === null || typeof v !== 'object') continue
      if (seg === '*') next.push(...(Array.isArray(v) ? v : Object.values(v)))
      else if (/^\[\d+\]$/.test(seg)) {
        if (Array.isArray(v)) {
          const item = v[Number(seg.slice(1, -1))]
          if (item !== undefined) next.push(item)
        }
      } else if (!Array.isArray(v) && seg in (v as object)) next.push((v as Record<string, unknown>)[seg])
    }
    current = next
  }
  return current
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return String(a) === String(b)
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  }
  return false
}

function safeRegex(pattern: string, flags = ''): RegExp | undefined {
  try {
    return new RegExp(pattern, flags)
  } catch {
    return undefined
  }
}

export interface RuleResult {
  ok: boolean
  mensaje: string
}

export function evaluateRules(lang: ConfigLanguage, text: string, rules: ConfigRule[], validation = validateConfig(lang, text)): RuleResult[] {
  return rules.map((r) => {
    switch (r.tipo) {
      case 'sin_errores':
        return { ok: !validation.diagnostics.some((d) => d.severity === 'error'), mensaje: r.mensaje }
      case 'contiene':
        return { ok: !!safeRegex(r.regex, 'm')?.test(text), mensaje: r.mensaje }
      case 'no_contiene':
        return { ok: !safeRegex(r.regex, 'm')?.test(text), mensaje: r.mensaje }
      case 'directiva': {
        const re = r.valor_regex ? safeRegex(r.valor_regex) : undefined
        if (lang === 'nginx') {
          const found = findDirectives(validation.tree ?? [], r.contexto, r.nombre)
          return { ok: found.some((d) => !re || re.test(d.args.join(' '))), mensaje: r.mensaje }
        }
        const entries = validation.entries ?? []
        const found = entries.filter((e) => e.key.toLowerCase() === r.nombre.toLowerCase())
        // En sshd vale la primera aparición.
        const first = found[0]
        return { ok: !!first && (!re || re.test(first.value)), mensaje: r.mensaje }
      }
      case 'yaml_ruta': {
        const values = validation.data !== undefined ? valuesAt(validation.data, r.ruta) : []
        if (!r.existe) return { ok: values.length === 0, mensaje: r.mensaje }
        let ok = values.length > 0
        if (ok && r.igual !== undefined) ok = values.some((v) => deepEqual(v, r.igual))
        if (ok && r.contiene !== undefined) ok = values.some((v) => (Array.isArray(v) ? v.some((x) => deepEqual(x, r.contiene)) : typeof v === 'string' ? v.includes(String(r.contiene)) : false))
        if (ok && r.regex) {
          const re = safeRegex(r.regex)
          ok = !!re && values.some((v) => re.test(typeof v === 'string' ? v : JSON.stringify(v)))
        }
        return { ok, mensaje: r.mensaje }
      }
    }
  })
}
