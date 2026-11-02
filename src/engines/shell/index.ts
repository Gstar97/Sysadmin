import './commands/files'
import './commands/text'
import './commands/users'
import './commands/sysinfo'
import './commands/systemd'
import './commands/perf'
import './commands/kernel'
import './commands/logs'
import './commands/boot'
import './commands/storage'
import './commands/bashcmd'
import './commands/pkg'
import './commands/net'
import './commands/ssh'
import './commands/security'
import './commands/scriptutil'
import { commandPackage, OTHER_FAMILY } from './packages'
import { bashStateSchema, type BashCheck, type BashState, type BashStateInput } from './schema'
import { hostKey, inbound, knownLine, makeKey } from './hosts'
import { COMMANDS, Shell } from './shell'
import { System } from './system'
import { modeString, ROOT_CRED, type Inode } from './vfs'
import { GiB, parseSize } from './storage'

export { Shell, COMMANDS } from './shell'
export { System } from './system'

const BINARY_SIZES: Record<string, number> = { bash: 1389064, ls: 140920, cat: 36448, cp: 141976, mv: 137760, grep: 166560, ps: 145424, systemctl: 309536, sudo: 252608, find: 286040, tar: 528536, ssh: 857472, python3: 15736, vim: 4096832 }

/** Crea en /usr/bin y /usr/sbin un ejecutable (solo la cabecera ELF) por cada comando disponible. */
function installBinaries(sys: System) {
  const add = (path: string, name: string) => {
    if (sys.vfs.exists(path)) return
    sys.vfs.writeFile(path, '\x7fELF\x02\x01\x01', ROOT_CRED)
    const node = sys.vfs.stat(path, ROOT_CRED)
    // Programas con SUID root, como en una instalación real.
    node.mode = name === 'sudo' ? (sys.distro === 'rocky' ? 0o4111 : 0o4755) : ['passwd', 'su', 'gpasswd', 'newgrp', 'mount', 'umount', 'chsh', 'chfn'].includes(name) ? 0o4755 : 0o755
    node.size = BINARY_SIZES[name] ?? 24_000 + ([...name].reduce((h, c) => h * 31 + c.charCodeAt(0), 7) % 160_000)
  }
  // Herramientas que solo existen en una de las dos familias de distribuciones.
  const otherFamily = OTHER_FAMILY[sys.distro]
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
  linkHosts(sys, state)
  return new Shell(sys, state.usuario, state.directorio)
}

/** Crea los otros servidores de la red del ejercicio y los conecta entre sí. */
function linkHosts(base: System, state: BashState) {
  if (!state.servidores.length) return
  const remotes = state.servidores.map((h) => {
    const { ip, clave_conocida: _k, en_dns: _d, ...rest } = h
    const red = h.red.interfaces.length === 1 && h.red.interfaces[0].ip === '192.168.1.10/24' ? { ...h.red, interfaces: [{ nombre: 'enp0s3', ip: ip.includes('/') ? ip : `${ip}/24`, estado: 'UP' as const }] } : h.red
    const sys = new System({ ...rest, red, servidores: [] })
    installBinaries(sys)
    return { spec: h, sys, ip: ip.split('/')[0] }
  })
  const all = [base, ...remotes.map((r) => r.sys)]
  for (const s of all) s.lab = all.filter((x) => x !== s)
  // El DNS interno resuelve los nombres de los servidores (salvo los que el ejercicio excluye).
  const names: Record<string, string> = {}
  for (const r of remotes) if (r.spec.en_dns) names[r.sys.hostname] = r.ip
  const baseIp = base.ownIps()[1]
  if (baseIp) names[base.hostname] = baseIp
  for (const s of all) for (const [n, ip] of Object.entries(names)) s.dnsRecords[n] ??= ip
  // known_hosts del usuario del ejercicio.
  const user = base.users.get(state.usuario)
  if (!user) return
  // Clave SSH ya creada e instalada donde el ejercicio lo indica.
  if (state.usuarios.some((u) => u.nombre === user.name && u.clave_ssh)) {
    const key = makeKey('ed25519', `estado:${base.hostname}:${user.name}`, `${user.name}@${base.hostname}`)
    const cred = base.credFor(user.name)
    if (!base.vfs.exists(`${user.home}/.ssh`)) base.vfs.mkdir(`${user.home}/.ssh`, cred, 0o700)
    base.vfs.writeFile(`${user.home}/.ssh/id_ed25519`, key.priv, cred, { mode: 0o600 })
    base.vfs.writeFile(`${user.home}/.ssh/id_ed25519.pub`, key.pub + '\n', cred, { mode: 0o644 })
    for (const r of remotes) {
      for (const ru of r.spec.usuarios.filter((x) => x.clave_ssh)) {
        const u = r.sys.users.get(ru.nombre)
        if (!u) continue
        const rc = r.sys.credFor(u.name)
        if (!r.sys.vfs.exists(`${u.home}/.ssh`)) r.sys.vfs.mkdir(`${u.home}/.ssh`, rc, 0o700)
        r.sys.vfs.writeFile(`${u.home}/.ssh/authorized_keys`, key.pub + '\n', rc, { append: true, mode: 0o600 })
      }
    }
  }
  const lines: string[] = []
  for (const r of remotes) {
    if (r.spec.clave_conocida === 'no') continue
    if (r.spec.clave_conocida === 'cambiada') r.sys.hostKeyVariant = ':reinstalado'
    const key = hostKey(r.sys, 'ed25519')
    lines.push(knownLine(base, r.sys.hostname, key), knownLine(base, r.ip, key))
  }
  if (lines.length) {
    const cred = base.credFor(user.name)
    if (!base.vfs.exists(`${user.home}/.ssh`)) base.vfs.mkdir(`${user.home}/.ssh`, cred, 0o700)
    base.vfs.writeFile(`${user.home}/.ssh/known_hosts`, lines.join('\n') + '\n', cred, { mode: 0o644, umask: 0o022 })
  }
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

/** Entradas de la ACL de un archivo, con el formato de getfacl (sin comentarios). */
function aclEntries(sys: System, node: Inode): string[] {
  const t = (p: number) => (p & 4 ? 'r' : '-') + (p & 2 ? 'w' : '-') + (p & 1 ? 'x' : '-')
  const out = [`user::${t((node.mode >> 6) & 7)}`]
  if (node.acl) {
    for (const [uid, p] of node.acl.users) out.push(`user:${sys.userName(uid)}:${t(p)}`)
    out.push(`group::${t(node.acl.groupObj)}`)
    for (const [gid, p] of node.acl.groups) out.push(`group:${sys.groupName(gid)}:${t(p)}`)
    out.push(`mask::${t(node.acl.mask)}`)
  } else out.push(`group::${t((node.mode >> 3) & 7)}`)
  out.push(`other::${t(node.mode & 7)}`)
  const d = node.defaultAcl
  if (d) {
    out.push(`default:user::${t(d.user)}`)
    for (const [uid, p] of d.users) out.push(`default:user:${sys.userName(uid)}:${t(p)}`)
    out.push(`default:group::${t(d.group)}`)
    for (const [gid, p] of d.groups) out.push(`default:group:${sys.groupName(gid)}:${t(p)}`)
    out.push(`default:other::${t(d.other)}`)
  }
  return out
}

/** Comprueba una verificación de ejercicio contra el estado actual del sistema simulado. */
export function verifyBash(sh: Shell, check: BashCheck): CheckResult {
  if ('en' in check) {
    const host = [sh.baseSys, ...sh.baseSys.lab].find((h) => h.hostname === check.en)
    if (!host) return { ok: false, label: `en ${check.en} (ese servidor no existe en el ejercicio)` }
    const r = verifyOn(host, sh, check.verificar)
    return { ok: r.ok, label: `en ${check.en}: ${r.label}` }
  }
  return verifyOn(sh.baseSys, sh, check)
}

function verifyOn(sys: System, sh: Shell, check: Exclude<BashCheck, { en: string }>): CheckResult {
  if ('ufw_activo' in check) return { ok: sys.ufw.active === check.ufw_activo, label: `ufw ${check.ufw_activo ? 'activo' : 'inactivo'}` }
  if ('firewall_permite' in check) {
    const [port, proto = 'tcp'] = check.firewall_permite.split('/')
    const res = inbound(sys, Number(port), proto === 'udp' ? 'udp' : 'tcp', check.desde ?? '203.0.113.10') === 'ok'
    return { ok: res === check.permite, label: `el firewall ${check.permite ? 'deja pasar' : 'bloquea'} ${check.firewall_permite}${check.desde ? ` desde ${check.desde}` : ''}` }
  }
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
      if (check.contenido_no_incluye !== undefined) {
        ok &&= !node.data.includes(check.contenido_no_incluye)
        parts.push(`no contiene "${check.contenido_no_incluye}"`)
      }
      if (check.contenido_igual !== undefined) {
        ok &&= node.data.replace(/\n+$/, '') === check.contenido_igual.replace(/\n+$/, '')
        parts.push('contenido exacto')
      }
      if (check.destino) {
        ok &&= own.type === 'symlink' && own.data === check.destino
        parts.push(`apunta a ${check.destino}`)
      }
      if (check.acl_incluye !== undefined || check.acl_no_incluye !== undefined) {
        const text = aclEntries(sys, node).join('\n')
        if (check.acl_incluye !== undefined) {
          ok &&= text.split('\n').includes(check.acl_incluye)
          parts.push(`ACL con ${check.acl_incluye}`)
        }
        if (check.acl_no_incluye !== undefined) {
          ok &&= !text.includes(check.acl_no_incluye)
          parts.push(`ACL sin ${check.acl_no_incluye}`)
        }
      }
      if (check.enlaces !== undefined) {
        ok &&= node.nlink === check.enlaces
        parts.push(`${check.enlaces} ${check.enlaces === 1 ? 'nombre' : 'nombres (enlaces duros)'}`)
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
    const timer = check.servicio.endsWith('.timer') ? sys.timers.get(check.servicio.slice(0, -6)) : undefined
    const s = timer ?? sys.services.get(check.servicio.replace(/\.service$/, ''))
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
    if (check.fallido !== undefined) {
      ok &&= !timer && (s as { failed?: boolean } | undefined)?.failed === check.fallido
      parts.push(check.fallido ? 'en estado failed' : 'sin fallas')
    }
    return { ok, label: `${timer ? 'timer' : 'servicio'} ${check.servicio}: ${parts.join(', ') || 'existe'}` }
  }
  if ('paquete' in check) {
    return { ok: sys.installed.has(check.paquete) === check.instalado, label: `paquete ${check.paquete} ${check.instalado ? 'instalado' : 'no instalado'}` }
  }
  if ('montaje' in check) {
    const st = sys.storage
    const target = check.montaje.replace(/\/$/, '') || '/'
    const m = st.mounts.find((x) => x.target === target)
    if (check.montado === false) return { ok: !m, label: `${target} desmontado` }
    let ok = !!m
    const parts: string[] = []
    if (check.dispositivo) {
      ok &&= !!m && m.dev === st.canonical(check.dispositivo)
      parts.push(`con ${check.dispositivo}`)
    }
    if (check.tipo) {
      ok &&= m?.fstype === check.tipo
      parts.push(`(${check.tipo})`)
    }
    if (check.tamano_min) {
      const min = parseSize(check.tamano_min, GiB) ?? 0
      ok &&= !!m?.dev && (st.sigs.get(m.dev)?.size ?? 0) >= min * 0.98
      parts.push(`de al menos ${check.tamano_min}`)
    }
    return { ok, label: `${target} montado ${parts.join(' ')}`.trim() }
  }
  if ('fstab' in check) {
    const st = sys.storage
    const target = check.fstab.replace(/\/$/, '') || '/'
    const e = st.readFstab().find((x) => x.target === target || (target === 'swap' && x.type === 'swap'))
    if (check.existe === false) return { ok: !e, label: `/etc/fstab sin entrada para ${target}` }
    let ok = !!e
    const parts: string[] = []
    if (check.tipo) {
      ok &&= e?.type === check.tipo
      parts.push(check.tipo)
    }
    if (check.opciones_incluye) {
      ok &&= !!e && e.options.split(',').includes(check.opciones_incluye)
      parts.push(`con ${check.opciones_incluye}`)
    }
    if (check.por_uuid) {
      ok &&= !!e && e.spec.startsWith('UUID=') && !!st.resolveSpec(e.spec)
      parts.push('por UUID')
    }
    return { ok, label: `/etc/fstab monta ${target} ${parts.join(' ')}`.trim() }
  }
  if ('volumen' in check) {
    const [vgName, lvName] = check.volumen.split('/')
    const lv = sys.storage.vgs.get(vgName)?.lvs.find((l) => l.name === lvName)
    if (check.existe === false) return { ok: !lv, label: `el volumen ${check.volumen} no existe` }
    let ok = !!lv
    if (check.tamano_min) ok &&= !!lv && lv.size >= (parseSize(check.tamano_min, GiB) ?? 0) * 0.98
    return { ok, label: `volumen lógico ${check.volumen}${check.tamano_min ? ` de al menos ${check.tamano_min}` : ''}` }
  }
  if ('grupo_volumenes' in check) {
    const vg = sys.storage.vgs.get(check.grupo_volumenes)
    if (check.existe === false) return { ok: !vg, label: `el grupo de volúmenes ${check.grupo_volumenes} no existe` }
    let ok = !!vg
    if (check.discos) ok &&= !!vg && check.discos.every((d) => vg.pvs.includes(d.startsWith('/dev/') ? d : `/dev/${d}`))
    return { ok, label: `grupo de volúmenes ${check.grupo_volumenes}${check.discos ? ` con ${check.discos.join(' y ')}` : ''}` }
  }
  if ('particion' in check) {
    const st = sys.storage
    const size = st.size(check.particion)
    if (check.existe === false) return { ok: size === undefined, label: `${check.particion} no existe` }
    let ok = size !== undefined
    if (check.tamano_min) ok &&= (size ?? 0) >= (parseSize(check.tamano_min, GiB) ?? 0) * 0.98
    if (check.fs) ok &&= st.sigs.get(check.particion)?.type === check.fs
    return { ok, label: `partición ${check.particion}${check.fs ? ` con ${check.fs}` : ''}` }
  }
  if ('swap' in check) {
    const st = sys.storage
    const key = st.canonical(check.swap) ?? check.swap
    const on = st.swaps.some((w) => w.path === key)
    const want = check.activa !== false
    return { ok: on === want, label: `swap ${check.swap} ${want ? 'activa' : 'desactivada'}` }
  }
  if ('proceso' in check) {
    const found = sys.procs.some((p) => p.cmd.includes(check.proceso))
    return { ok: found === check.existe, label: `proceso ${check.proceso} ${check.existe ? 'en ejecución' : 'terminado'}` }
  }
  if ('salida_contiene' in check) {
    return { ok: stripAnsi(sh.lastOutput).includes(check.salida_contiene), label: `la salida muestra "${check.salida_contiene}"` }
  }
  if ('salida_no_contiene' in check) {
    return { ok: !stripAnsi(sh.lastOutput).includes(check.salida_no_contiene), label: `la salida no muestra "${check.salida_no_contiene}"` }
  }
  if ('salida_regex' in check) {
    const re = safeRegex(check.salida_regex, 'm')
    return { ok: !!re && re.test(stripAnsi(sh.lastOutput)), label: 'la salida tiene el formato esperado' }
  }
  if ('comando_usado' in check) {
    const re = safeRegex(check.comando_usado)
    return { ok: !!re && (sh.history.some((h) => re.test(h)) || sh.typed.some((h) => re.test(h))), label: 'se usó el comando pedido' }
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
