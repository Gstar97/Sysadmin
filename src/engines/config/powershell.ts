/** Validación de scripts de PowerShell para el editor: errores de sintaxis y alias en lugar de nombres completos. */
import { parsePs, PsIncomplete, PsParseError } from '../powershell/parser'
import type { Diagnostic } from './types'

const ALIASES: Record<string, string> = {
  gci: 'Get-ChildItem', ls: 'Get-ChildItem', dir: 'Get-ChildItem', gsv: 'Get-Service', gps: 'Get-Process', ps: 'Get-Process',
  '?': 'Where-Object', where: 'Where-Object', '%': 'ForEach-Object', foreach: 'ForEach-Object', select: 'Select-Object',
  sort: 'Sort-Object', ft: 'Format-Table', fl: 'Format-List', sls: 'Select-String', gc: 'Get-Content', cat: 'Get-Content',
  icm: 'Invoke-Command', gcim: 'Get-CimInstance', gwmi: 'Get-WmiObject', iwr: 'Invoke-WebRequest', echo: 'Write-Output',
}

function parses(text: string): 'ok' | 'error' | 'incomplete' {
  try {
    parsePs(text)
    return 'ok'
  } catch (e) {
    if (e instanceof PsIncomplete) return 'incomplete'
    if (e instanceof PsParseError) return 'error'
    return 'error'
  }
}

export function validatePowerShell(text: string): { diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const lines = text.split('\n')
  const whole = parses(text)
  if (whole === 'incomplete') diagnostics.push({ line: lines.length, severity: 'error', message: 'Falta cerrar algo: una llave }, un paréntesis ) o unas comillas.' })
  if (whole === 'error') {
    // La primera línea a partir de la cual el texto deja de ser válido.
    let line = lines.length
    for (let i = 1; i <= lines.length; i++) {
      if (parses(lines.slice(0, i).join('\n')) === 'error') {
        line = i
        break
      }
    }
    let message = 'Error de sintaxis.'
    try {
      parsePs(text)
    } catch (e) {
      message = (e as Error).message
    }
    diagnostics.push({ line, severity: 'error', message })
  }
  // Alias al principio de un comando (después de una tubería, un punto y coma o una llave).
  let inBlockComment = false
  lines.forEach((raw, i) => {
    let l = raw
    if (inBlockComment) {
      const end = l.indexOf('#>')
      if (end < 0) return
      inBlockComment = false
      l = l.slice(end + 2)
    }
    const start = l.indexOf('<#')
    if (start >= 0 && l.indexOf('#>', start) < 0) {
      inBlockComment = true
      l = l.slice(0, start)
    }
    l = l.replace(/#.*$/, '').replace(/'[^']*'|"[^"]*"/g, '""')
    const re = /(^|[|;{(=]\s*)(\?|%|[a-z]+)(?=\s|$)/gi
    for (const m of l.matchAll(re)) {
      const a = m[2].toLowerCase()
      // foreach ( … ) es la instrucción del lenguaje, no el alias.
      if (a === 'foreach' && /^\s*\(/.test(l.slice((m.index ?? 0) + m[0].length))) continue
      if (ALIASES[a]) diagnostics.push({ line: i + 1, column: (m.index ?? 0) + m[1].length + 1, severity: 'warning', message: `"${m[2]}" es un alias: en un script conviene ${ALIASES[a]}.` })
    }
  })
  return { diagnostics }
}
