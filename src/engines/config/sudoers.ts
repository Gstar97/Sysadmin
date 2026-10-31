/** Validación de archivos de sudoers (como visudo), con mensajes que explican cada error. */
import type { Diagnostic } from './types'

const TAGS = /^(NOPASSWD|PASSWD|NOEXEC|EXEC|SETENV|NOSETENV|LOG_INPUT|NOLOG_INPUT|LOG_OUTPUT|NOLOG_OUTPUT|MAIL|NOMAIL|FOLLOW|NOFOLLOW):\s*/

export interface SudoersRule {
  who: string[]
  hosts: string[]
  runas?: string
  tags: string[]
  commands: string[]
  line: number
}

export function validateSudoers(text: string): { rules: SudoersRule[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const rules: SudoersRule[] = []
  const aliases = new Set<string>()
  // Las líneas que terminan en \ continúan en la siguiente.
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = i + 1
    let t = lines[i].trim()
    while (t.endsWith('\\') && i + 1 < lines.length) t = t.slice(0, -1) + ' ' + lines[++i].trim()
    if (!t || (t.startsWith('#') && !/^#include(dir)?\s/.test(t))) continue
    if (/^[#@]include(dir)?\s+\S+/.test(t)) continue
    if (t.startsWith('Defaults')) {
      if (!/^Defaults([:@!>][^\s]+)?\s+\S/.test(t)) diagnostics.push({ line, severity: 'error', message: 'Una línea Defaults necesita al menos una opción, por ejemplo: Defaults env_reset' })
      continue
    }
    const alias = /^(User|Runas|Host|Cmnd)_Alias\s+([A-Z][A-Z0-9_]*)\s*=\s*(.+)$/.exec(t)
    if (alias) {
      aliases.add(alias[2])
      if (alias[1] === 'Cmnd') {
        for (const c of alias[3].split(',').map((x) => x.trim())) {
          if (c !== 'ALL' && !c.startsWith('/') && !aliases.has(c.replace(/^!/, ''))) {
            diagnostics.push({ line, severity: 'error', message: `"${c.split(/\s+/)[0]}" no tiene la ruta completa. sudo exige rutas absolutas para los comandos, por ejemplo /usr/bin/systemctl (which systemctl te la dice).` })
          }
        }
      }
      continue
    }
    if (/^[A-Za-z]+_Alias/.test(t)) {
      diagnostics.push({ line, severity: 'error', message: 'Un alias se define como TIPO_Alias NOMBRE = valores, con el nombre en MAYÚSCULAS (por ejemplo, Cmnd_Alias WEB = /usr/bin/systemctl restart nginx).' })
      continue
    }
    const m = /^(\S+)\s+([^=\s]+)\s*=\s*(.*)$/.exec(t)
    if (!m) {
      diagnostics.push({ line, severity: 'error', message: 'syntax error: una regla tiene la forma QUIÉN EQUIPO=(COMO_QUIÉN) COMANDOS, por ejemplo: %soporte ALL=(root) /usr/bin/systemctl restart nginx' })
      continue
    }
    let rest = m[3].trim()
    let runas: string | undefined
    const ra = /^\(([^)]*)\)\s*/.exec(rest)
    if (rest.startsWith('(') && !ra) {
      diagnostics.push({ line, severity: 'error', message: 'syntax error: falta cerrar el paréntesis de (COMO_QUIÉN).' })
      continue
    }
    if (ra) {
      runas = ra[1]
      rest = rest.slice(ra[0].length)
    }
    const tags: string[] = []
    let tm: RegExpExecArray | null
    while ((tm = TAGS.exec(rest)) !== null) {
      tags.push(tm[1])
      rest = rest.slice(tm[0].length)
    }
    if (/^[A-Z_]+:/.test(rest)) {
      diagnostics.push({ line, severity: 'error', message: `syntax error: "${rest.split(':')[0]}:" no es una etiqueta válida (las habituales son NOPASSWD: y NOEXEC:).` })
      continue
    }
    if (!rest) {
      diagnostics.push({ line, severity: 'error', message: 'syntax error: falta la lista de comandos después del =.' })
      continue
    }
    const commands = rest.split(',').map((c) => c.trim())
    const who = m[1].split(',')
    for (const w of who) {
      if (/^[A-Z][A-Z0-9_]*$/.test(w) && w !== 'ALL' && !aliases.has(w)) {
        diagnostics.push({ line, severity: 'error', message: `"${w}" está en mayúsculas, así que sudo lo interpreta como un alias que no está definido. Los grupos se escriben con % (por ejemplo, %soporte).` })
      }
    }
    for (const c of commands) {
      if (!c) {
        diagnostics.push({ line, severity: 'error', message: 'syntax error: hay una coma de más en la lista de comandos.' })
        continue
      }
      const cmd = c.replace(/^!/, '').split(/\s+/)[0]
      if (cmd !== 'ALL' && !cmd.startsWith('/') && !aliases.has(cmd)) {
        diagnostics.push({ line, severity: 'error', message: `"${cmd}" no tiene la ruta completa. sudo exige rutas absolutas para los comandos, por ejemplo /usr/bin/systemctl (which ${cmd} te la dice).` })
      }
      if (/\*/.test(c.split(/\s+/).slice(1).join(' '))) {
        diagnostics.push({ line, severity: 'warning', message: 'Un comodín (*) en los argumentos permite mucho más de lo que parece: el usuario puede agregar cualquier argumento. Conviene listar los comandos exactos.' })
      }
      if (/^\/(usr\/)?bin\/(bash|sh|su|vi|vim|nano|less)$/.test(cmd)) {
        diagnostics.push({ line, severity: 'warning', message: `Permitir ${cmd} con sudo equivale a dar root completo: desde ahí se puede abrir una terminal de root.` })
      }
    }
    if (tags.includes('NOPASSWD') && commands.includes('ALL')) {
      diagnostics.push({ line, severity: 'warning', message: 'NOPASSWD con ALL permite hacer cualquier cosa como root sin volver a pedir la contraseña: si alguien usa esa cuenta, tiene el servidor.' })
    }
    rules.push({ who, hosts: m[2].split(','), runas, tags, commands, line })
  }
  return { rules, diagnostics }
}
