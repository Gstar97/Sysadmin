import './commands/files'
import './commands/text'
import './commands/users'
import './commands/sysinfo'
import './commands/pkg'
import './commands/net'
import { commandPackage } from './packages'
import { bashStateSchema, type BashCheck, type BashStateInput } from './schema'
import { COMMANDS, Shell } from './shell'
import { System } from './system'
import { modeString, ROOT_CRED } from './vfs'

export { Shell, COMMANDS } from './shell'
export { System } from './system'

const BINARY_SIZES: Record<string, number> = { bash: 1389064, ls: 140920, cat: 36448, cp: 141976, mv: 137760, grep: 166560, ps: 145424, systemctl: 309536, sudo: 252608, find: 286040, tar: 528536, ssh: 857472, python3: 15736, vim: 4096832 }

/** Crea en /usr/bin y /usr/sbin un ejecutable (solo la cabecera ELF) por cada comando disponible. */
function installBinaries(sys: System) {
  const add = (path: string, name: string) => {
    if (sys.vfs.exists(path)) return
    sys.vfs.writeFile(path, '\x7fELF\x02\x01\x01', ROOT_CRED)
    const node = sys.vfs.stat(path, ROOT_CRED)
    node.mode = name === 'sudo' ? 0o4111 : 0o755
    node.size = BINARY_SIZES[name] ?? 24_000 + ([...name].reduce((h, c) => h * 31 + c.charCodeAt(0), 7) % 160_000)
  }
  // Herramientas que solo existen en una de las dos familias de distribuciones.
  const otherFamily = sys.distro === 'rocky' ? ['apt', 'apt-get', 'dpkg', 'adduser', 'ufw'] : ['dnf', 'yum', 'rpm', 'firewall-cmd', 'nmcli']
  for (const [name, def] of COMMANDS) {
    if (otherFamily.includes(name)) continue
    const pkg = commandPackage(sys.distro, name)
    if (pkg && !sys.installed.has(pkg)) continue
    add(`${def.path ?? '/usr/bin'}/${name}`, name)
  }
  add('/usr/bin/bash', 'bash')
  if (!sys.vfs.exists('/usr/bin/sh')) sys.vfs.symlink('bash', '/usr/bin/sh', ROOT_CRED)
}

/** Crea una sesión de bash a partir del estado inicial de un ejercicio. */
export function createBashSession(input: BashStateInput = {}): Shell {
  const state = bashStateSchema.parse(input)
  const sys = new System(state)
  installBinaries(sys)
  return new Shell(sys, state.usuario, state.directorio)
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

export interface CheckResult {
  ok: boolean
  /** Descripción legible de lo que se verifica. */
  label: string
}

/** Comprueba una verificación de ejercicio contra el estado actual del sistema simulado. */
export function verifyBash(sh: Shell, check: BashCheck): CheckResult {
  const sys = sh.sys
  if ('archivo' in check) {
    const exists = sys.vfs.exists(check.archivo, ROOT_CRED, false)
    const parts: string[] = []
    let ok = exists === check.existe
    if (!check.existe) return { ok, label: `${check.archivo} no existe` }
    if (exists) {
      const own = sys.vfs.stat(check.archivo, ROOT_CRED, false)
      const node = own.type === 'symlink' && check.tipo !== 'enlace' ? sys.vfs.stat(check.archivo, ROOT_CRED) : own
      if (check.tipo) {
        const t = { archivo: 'file', directorio: 'dir', enlace: 'symlink' }[check.tipo]
        ok &&= node.type === t
        parts.push(check.tipo)
      }
      if (check.modo) {
        ok &&= (node.mode & 0o7777) === parseInt(check.modo, 8)
        parts.push(`permisos ${check.modo} (${modeString({ type: node.type, mode: parseInt(check.modo, 8) }).slice(1)})`)
      }
      if (check.dueno) {
        ok &&= sys.userName(node.uid) === check.dueno
        parts.push(`dueño ${check.dueno}`)
      }
      if (check.grupo) {
        ok &&= sys.groupName(node.gid) === check.grupo
        parts.push(`grupo ${check.grupo}`)
      }
      if (check.contenido_incluye !== undefined) {
        ok &&= node.data.includes(check.contenido_incluye)
        parts.push(`contiene "${check.contenido_incluye}"`)
      }
      if (check.contenido_igual !== undefined) {
        ok &&= node.data.replace(/\n+$/, '') === check.contenido_igual.replace(/\n+$/, '')
        parts.push('contenido exacto')
      }
      if (check.destino) {
        ok &&= own.type === 'symlink' && own.data === check.destino
        parts.push(`apunta a ${check.destino}`)
      }
    } else {
      if (check.tipo) parts.push(check.tipo)
    }
    return { ok, label: `${check.archivo}${parts.length ? `: ${parts.join(', ')}` : ' existe'}` }
  }
  if ('usuario' in check) {
    const u = sys.users.get(check.usuario)
    if (!check.existe) return { ok: !u, label: `el usuario ${check.usuario} no existe` }
    let ok = !!u
    const parts: string[] = []
    if (u && check.en_grupos) {
      const gs = sys.groupsOf(u.name)
      ok &&= check.en_grupos.every((g) => gs.includes(g))
      parts.push(`en ${check.en_grupos.join(', ')}`)
    }
    if (check.shell) {
      ok &&= u?.shell === check.shell
      parts.push(`shell ${check.shell}`)
    }
    if (check.home) {
      ok &&= u?.home === check.home
      parts.push(`home ${check.home}`)
    }
    if (check.bloqueado !== undefined) {
      ok &&= u?.locked === check.bloqueado
      parts.push(check.bloqueado ? 'bloqueado' : 'desbloqueado')
    }
    return { ok, label: `usuario ${check.usuario}${parts.length ? `: ${parts.join(', ')}` : ' existe'}` }
  }
  if ('grupo' in check) {
    const g = sys.groups.get(check.grupo)
    if (!check.existe) return { ok: !g, label: `el grupo ${check.grupo} no existe` }
    let ok = !!g
    if (g && check.miembros) ok &&= check.miembros.every((m) => g.members.includes(m) || sys.users.get(m)?.gid === g.gid)
    return { ok, label: `grupo ${check.grupo}${check.miembros ? ` con ${check.miembros.join(', ')}` : ' existe'}` }
  }
  if ('servicio' in check) {
    const s = sys.services.get(check.servicio)
    let ok = !!s
    const parts: string[] = []
    if (check.activo !== undefined) {
      ok &&= s?.active === check.activo
      parts.push(check.activo ? 'activo' : 'detenido')
    }
    if (check.habilitado !== undefined) {
      ok &&= s?.enabled === check.habilitado
      parts.push(check.habilitado ? 'habilitado al arranque' : 'deshabilitado')
    }
    return { ok, label: `servicio ${check.servicio}: ${parts.join(', ') || 'existe'}` }
  }
  if ('paquete' in check) {
    return { ok: sys.installed.has(check.paquete) === check.instalado, label: `paquete ${check.paquete} ${check.instalado ? 'instalado' : 'no instalado'}` }
  }
  if ('proceso' in check) {
    const found = sys.procs.some((p) => p.cmd.includes(check.proceso))
    return { ok: found === check.existe, label: `proceso ${check.proceso} ${check.existe ? 'en ejecución' : 'terminado'}` }
  }
  if ('salida_contiene' in check) {
    return { ok: stripAnsi(sh.lastOutput).includes(check.salida_contiene), label: `la salida muestra "${check.salida_contiene}"` }
  }
  if ('salida_regex' in check) {
    const re = safeRegex(check.salida_regex, 'm')
    return { ok: !!re && re.test(stripAnsi(sh.lastOutput)), label: 'la salida tiene el formato esperado' }
  }
  if ('comando_usado' in check) {
    const re = safeRegex(check.comando_usado)
    return { ok: !!re && sh.history.some((h) => re.test(h)), label: 'se usó el comando pedido' }
  }
  if ('directorio_actual' in check) {
    return { ok: sh.cwd === check.directorio_actual, label: `estar en ${check.directorio_actual}` }
  }
  return { ok: sh.user === check.usuario_actual, label: `sesión como ${check.usuario_actual}` }
}

function safeRegex(pattern: string, flags?: string): RegExp | undefined {
  try {
    return new RegExp(pattern, flags)
  } catch {
    return undefined
  }
}
