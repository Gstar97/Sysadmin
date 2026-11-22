/** Validación de inventarios de Ansible (INI o YAML), con avisos como los de ansible-inventory. */
import { groupHosts, InventoryError, looksYaml, parseInventory } from '../ansible/inventory'
import type { Diagnostic } from './types'

export function validateInventory(text: string, fileName = 'inventario.ini'): { diagnostics: Diagnostic[]; data?: unknown } {
  const diagnostics: Diagnostic[] = []
  try {
    const inv = parseInventory(text, fileName)
    for (const w of inv.warnings) diagnostics.push({ line: 1, severity: 'warning', message: w })
    if (!looksYaml(text, fileName)) {
      text.split('\n').forEach((raw, i) => {
        const l = raw.replace(/(^|\s)[#;].*$/, '').trim()
        if (/^\[[^\]]*\s[^\]]*\]$/.test(l)) diagnostics.push({ line: i + 1, severity: 'error', message: `El nombre de grupo "${l}" tiene espacios: Ansible lo rechaza.` })
        else if (/^\[[^\]]*-[^\]]*\]$/.test(l)) diagnostics.push({ line: i + 1, severity: 'warning', message: `El grupo ${l} tiene un guion: Ansible lo acepta con un aviso, pero no sirve como nombre de variable; mejor guion bajo.` })
        else if (/^[\w.-]+\s+[\w.-]+=\s*$/.test(l)) diagnostics.push({ line: i + 1, severity: 'error', message: 'Una variable sin valor: va clave=valor, sin espacios alrededor del =.' })
        else if (/^[\w.-]+\s+[\w.-]+\s+=/.test(l)) diagnostics.push({ line: i + 1, severity: 'error', message: 'En la línea de un equipo las variables van como clave=valor, sin espacios alrededor del =.' })
      })
    }
    const children = new Map([...inv.groups].map(([n, g]) => [n, g.children]))
    for (const [n, kids] of children) for (const k of kids) if (k !== 'ungrouped' && n !== 'all' && !inv.groups.get(k)?.hosts.length && !inv.groups.get(k)?.children.length) diagnostics.push({ line: Math.max(1, text.split('\n').findIndex((l) => l.trim() === k) + 1), severity: 'warning', message: `${n} incluye al grupo ${k}, que no tiene ningún equipo.` })
    // Para las reglas yaml_ruta: grupos.web (equipos, con los de los grupos hijos), equipos.web01 (sus variables), variables.web.
    return {
      diagnostics,
      data: {
        grupos: Object.fromEntries([...inv.groups.keys()].map((n) => [n, groupHosts(inv, n)])),
        equipos: Object.fromEntries(inv.hosts),
        variables: Object.fromEntries([...inv.groups].map(([n, g]) => [n, g.vars])),
      },
    }
  } catch (e) {
    const m = /:(\d+): (.*)$/.exec((e as InventoryError).message)
    diagnostics.push({ line: m ? Number(m[1]) : 1, severity: 'error', message: m ? m[2] : (e as Error).message })
    return { diagnostics }
  }
}
