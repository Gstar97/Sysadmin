/**
 * SELinux (Rocky) y AppArmor (Ubuntu): getenforce, setenforce, sestatus, ls/ps/id -Z, chcon,
 * restorecon, semanage, getsebool, setsebool, ausearch, audit2why y aa-status. También nginx -t,
 * porque es donde SELinux se nota primero.
 */
import { COMMANDS, register, type CommandContext } from '../shell'
import { contextOf, policyType, portType, POLICY_PORTS, processDomain, restore, typeOf } from '../selinux'
import { ROOT_CRED } from '../vfs'
import { nginxStartCheck, nginxTest } from '../web'
import { SERVICE_CHECKS, strftime } from './sysinfo'

function rockyOnly(ctx: CommandContext, pkg = 'selinux-utils'): boolean {
  if (ctx.sys.distro === 'rocky') return true
  ctx.err(`Command '${ctx.name}' not found, but can be installed with:\n\nsudo apt install ${pkg}\n\n[simulador] Ubuntu no usa SELinux: su equivalente es AppArmor (sudo aa-status).\n`)
  return false
}

function needRoot(ctx: CommandContext, msg?: string): boolean {
  if (ctx.sh.user === 'root') return true
  ctx.err(msg ?? `${ctx.name}: Permission denied\n`)
  return false
}

const modeName = (m: string) => m[0].toUpperCase() + m.slice(1)

register('getenforce', {
  usage: 'getenforce',
  path: '/usr/sbin',
  run(ctx) {
    if (!rockyOnly(ctx)) return 127
    ctx.out(modeName(ctx.sys.selinux.mode) + '\n')
    return 0
  },
})

register('setenforce', {
  usage: 'setenforce [ Enforcing | Permissive | 1 | 0 ]',
  path: '/usr/sbin',
  run(ctx) {
    if (!rockyOnly(ctx)) return 127
    const se = ctx.sys.selinux
    if (se.mode === 'disabled') {
      ctx.err('setenforce: SELinux is disabled\n')
      return 1
    }
    const v = (ctx.args[0] ?? '').toLowerCase()
    if (!['1', '0', 'enforcing', 'permissive'].includes(v)) {
      ctx.err('usage:  setenforce [ Enforcing | Permissive | 1 | 0 ]\n')
      return 1
    }
    if (!needRoot(ctx, 'setenforce:  setenforce() failed\n')) return 1
    se.mode = v === '1' || v === 'enforcing' ? 'enforcing' : 'permissive'
    return 0
  },
})

register('sestatus', {
  usage: 'sestatus [-b]',
  path: '/usr/sbin',
  run(ctx) {
    if (!rockyOnly(ctx, 'policycoreutils')) return 127
    const se = ctx.sys.selinux
    let cfg = 'enforcing'
    try {
      cfg = /^SELINUX=(\w+)/m.exec(ctx.sys.vfs.readFile('/etc/selinux/config', ROOT_CRED))?.[1] ?? cfg
    } catch {
      // sin archivo
    }
    if (se.mode === 'disabled') {
      ctx.out('SELinux status:                 disabled\n')
      return 0
    }
    ctx.out(`SELinux status:                 enabled\nSELinuxfs mount:                /sys/fs/selinux\nSELinux root directory:         /etc/selinux\nLoaded policy name:             targeted\nCurrent mode:                   ${se.mode}\nMode from config file:          ${cfg}\nPolicy MLS status:              enabled\nPolicy deny_unknown status:     allowed\nMemory protection checking:     actual (secure)\nMax kernel policy version:      33\n`)
    if (ctx.args.includes('-b')) {
      ctx.out('\nPolicy booleans:\n')
      for (const [n, b] of [...se.booleans].sort()) ctx.out(`${n.padEnd(40)}${b.cur ? 'on' : 'off'}\n`)
    }
    return 0
  },
})

// ---------------------------------------------------------------------------------------
// -Z en ls, ps e id
// ---------------------------------------------------------------------------------------

function wrapZ(name: string, decorate: (ctx: CommandContext, lines: string[]) => string[]) {
  const orig = COMMANDS.get(name)
  if (!orig) return
  register(name, {
    ...orig,
    async run(ctx) {
      const zArg = ctx.args.findIndex((a) => /^-[A-Za-z]*Z[A-Za-z]*$/.test(a) || /^[a-zA-Z]*Z[a-zA-Z]*$/.test(a) && name === 'ps' && !a.startsWith('-') && /^[auxefZ]+$/.test(a) || a === '--context')
      if (zArg < 0) return orig.run(ctx)
      if (ctx.sys.distro !== 'rocky' && name !== 'ps') {
        // En Ubuntu, -Z muestra "?" (no hay etiquetas de SELinux).
      }
      const a = ctx.args[zArg]
      const args = [...ctx.args]
      const stripped = a === '--context' ? '' : a.replace('Z', '')
      if (stripped === '' || stripped === '-') args.splice(zArg, 1)
      else args[zArg] = stripped
      let buf = ''
      const code = await orig.run({ ...ctx, args, out: (s) => (buf += s) })
      const lines = buf.replace(/\n$/, '').split('\n')
      if (buf) ctx.out(decorate({ ...ctx, args }, lines).join('\n') + '\n')
      return code
    },
  })
}

wrapZ('ls', (ctx, lines) => {
  const rocky = ctx.sys.distro === 'rocky' && ctx.sys.selinux.mode !== 'disabled'
  const label = (path: string) => (rocky ? contextOf(ctx.sys, path) : '?')
  const targets = ctx.args.filter((a) => !a.startsWith('-'))
  const long = ctx.args.some((a) => /^-[a-zA-Z]*l/.test(a))
  const dirMode = ctx.args.some((a) => /^-[a-zA-Z]*d/.test(a))
  let base = ctx.sh.cwd
  if (targets.length === 1) {
    const abs = ctx.sh.resolve(targets[0])
    base = !dirMode && ctx.sys.vfs.exists(abs) && ctx.sys.vfs.stat(abs, ROOT_CRED).type === 'dir' ? abs : abs.slice(0, abs.lastIndexOf('/')) || '/'
  }
  return lines.map((l) => {
    if (!l || /^total \d/.test(l) || l.endsWith(':')) return l
    if (long) {
      // ls -lZ: la etiqueta va después del grupo.
      const m = /^(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*?)(\S+)$/.exec(l)
      if (!m) return l
      const name = m[6]
      const path = targets.length === 1 && (dirMode || !ctx.sys.vfs.exists(`${base}/${name}`)) ? ctx.sh.resolve(targets[0]) : `${base}/${name}`
      return `${m[1]} ${m[2]} ${m[3]} ${m[4]} ${label(path)} ${m[5]}${name}`
    }
    return l
      .split(/\s{2,}/)
      .filter(Boolean)
      .map((name) => {
        const path = targets.length === 1 && (dirMode || !ctx.sys.vfs.exists(`${base}/${name}`)) ? ctx.sh.resolve(targets[0]) : `${base}/${name}`
        return `${label(path)} ${name}`
      })
      .join('\n')
  })
})

wrapZ('ps', (ctx, lines) => {
  const pids = new Map(ctx.sys.procs.map((p) => [String(p.pid), p]))
  const width = 48
  return lines.map((l, i) => {
    if (i === 0) return 'LABEL'.padEnd(width) + ' ' + l
    const tok = l.trim().split(/\s+/).slice(0, 2).find((t) => pids.has(t))
    const p = tok ? pids.get(tok)! : undefined
    const lab = ctx.sys.distro !== 'rocky' ? (p && ['chronyd', 'rsyslogd'].includes(p.comm ?? '') ? `/usr/sbin/${p.comm} (enforce)` : 'unconfined') : p ? processDomain(p.comm ?? p.cmd.split(' ')[0].split('/').pop()!, p.user) : '-'
    return lab.padEnd(width) + ' ' + l
  })
})

const origId = COMMANDS.get('id')
if (origId) {
  register('id', {
    ...origId,
    run(ctx) {
      if (ctx.args.includes('-Z')) {
        if (ctx.sys.distro !== 'rocky' || ctx.sys.selinux.mode === 'disabled') {
          ctx.err('id: --context (-Z) works only on an SELinux-enabled kernel\n')
          return 1
        }
        ctx.out('unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023\n')
        return 0
      }
      return origId.run(ctx)
    },
  })
}

// ---------------------------------------------------------------------------------------
// Etiquetas de archivos
// ---------------------------------------------------------------------------------------

function walkPaths(ctx: CommandContext, path: string, recursive: boolean): string[] {
  const out = [path]
  if (!recursive) return out
  const node = ctx.sys.vfs.stat(path, ROOT_CRED, false)
  if (node.type === 'dir') for (const n of [...node.entries!.keys()].sort()) out.push(...walkPaths(ctx, `${path === '/' ? '' : path}/${n}`, true))
  return out
}

register('restorecon', {
  usage: 'restorecon [-R] [-v] [-F] RUTA...',
  summary: '  Vuelve a poner la etiqueta que indica la política (y las reglas de semanage fcontext).\n  -R  recursivo  -v  mostrar lo que cambia  -n  no cambiar nada (con -v, solo mostrar)',
  path: '/usr/sbin',
  run(ctx) {
    if (!rockyOnly(ctx, 'policycoreutils')) return 127
    const flags = ctx.args.filter((a) => a.startsWith('-')).join('')
    const recursive = /[rR]/.test(flags)
    const verbose = flags.includes('v')
    const dry = flags.includes('n')
    const paths = ctx.args.filter((a) => !a.startsWith('-'))
    if (!paths.length) {
      ctx.err('usage:  restorecon [-iIDFUmnprRv0x] [-e excludedir] pathname...\n')
      return 1
    }
    if (ctx.sys.selinux.mode === 'disabled') return 0
    if (!needRoot(ctx)) return 1
    let code = 0
    for (const p of paths) {
      const abs = ctx.sh.resolve(p)
      if (!ctx.sys.vfs.exists(abs, ROOT_CRED, false)) {
        ctx.err(`restorecon: lstat(${p}) failed: No such file or directory\n`)
        code = 1
        continue
      }
      for (const f of walkPaths(ctx, abs, recursive)) {
        const node = ctx.sys.vfs.stat(f, ROOT_CRED, false)
        const saved = node.selabel
        const r = restore(ctx.sys, f)
        if (dry) node.selabel = saved
        if (r && verbose) ctx.out(`Relabeled ${f} from ${r[0]} to ${r[1]}\n`)
      }
    }
    return code
  },
})

register('chcon', {
  usage: 'chcon [-R] -t TIPO RUTA...',
  summary: '  Cambia la etiqueta a mano. Ojo: un restorecon (o un relabel completo) la deshace;\n  para que dure, usa semanage fcontext -a y después restorecon.',
  run(ctx) {
    if (!rockyOnly(ctx)) return 127
    const args = [...ctx.args]
    const ti = args.indexOf('-t')
    const type = ti >= 0 ? args[ti + 1] : undefined
    const recursive = args.some((a) => /^-[a-zA-Z]*R/.test(a))
    const refI = args.findIndex((a) => a.startsWith('--reference='))
    const paths = args.filter((a, i) => !a.startsWith('-') && i !== ti + 1)
    if ((!type && refI < 0) || !paths.length) {
      ctx.err("chcon: missing operand\nTry 'chcon --help' for more information.\n")
      return 1
    }
    if (!needRoot(ctx, `chcon: failed to change context of '${paths[0]}' to 'unconfined_u:object_r:${type}:s0': Operation not permitted\n`)) return 1
    const ref = refI >= 0 ? contextOf(ctx.sys, ctx.sh.resolve(args[refI].split('=')[1])) : undefined
    for (const p of paths) {
      const abs = ctx.sh.resolve(p)
      if (!ctx.sys.vfs.exists(abs)) {
        ctx.err(`chcon: cannot access '${p}': No such file or directory\n`)
        return 1
      }
      for (const f of walkPaths(ctx, abs, recursive)) {
        const cur = contextOf(ctx.sys, f).split(':')
        ctx.sys.vfs.stat(f, ROOT_CRED, false).selabel = ref ?? `${cur[0]}:${cur[1]}:${type}:${cur.slice(3).join(':')}`
      }
    }
    return 0
  },
})

register('matchpathcon', {
  usage: 'matchpathcon RUTA...',
  path: '/usr/sbin',
  run(ctx) {
    if (!rockyOnly(ctx)) return 127
    for (const p of ctx.args.filter((a) => !a.startsWith('-'))) {
      const abs = ctx.sh.resolve(p)
      ctx.out(`${abs}\tsystem_u:object_r:${policyType(ctx.sys, abs)}:s0\n`)
    }
    return 0
  },
})

// ---------------------------------------------------------------------------------------
// semanage
// ---------------------------------------------------------------------------------------

register('semanage', {
  usage: 'semanage fcontext -a -t TIPO "RUTA(/.*)?"  |  semanage fcontext -l  |  semanage port -a -t TIPO -p tcp PUERTO  |  semanage port -l  |  semanage boolean -l',
  summary: '  fcontext -a  agregar una regla de etiqueta (después: restorecon -Rv RUTA)\n  fcontext -d  borrar una regla  -l  listar\n  port -a/-m/-d  agregar, modificar o borrar un puerto  -l  listar\n  boolean -l  listar los booleanos con su descripción',
  path: '/usr/sbin',
  run(ctx) {
    const se = ctx.sys.selinux
    const [section, ...rest] = ctx.args
    const val = (f: string) => {
      const i = rest.indexOf(f)
      return i >= 0 ? rest[i + 1] : undefined
    }
    const has = (f: string) => rest.includes(f)
    const positional = rest.filter((a, i) => !a.startsWith('-') && !['-t', '-p'].includes(rest[i - 1] ?? ''))
    if (!section || !['fcontext', 'port', 'boolean', 'login', 'user'].includes(section)) {
      ctx.err('usage: semanage [-h]\n                {import,export,login,user,port,ibpkey,ibendport,interface,module,node,fcontext,boolean,permissive,dontaudit}\n                ...\n')
      return 2
    }
    const listing = has('-l') || has('--list')
    if (!listing && !needRoot(ctx, 'ValueError: SELinux policy is not managed or store cannot be accessed.\n')) return 1
    if (section === 'fcontext') {
      if (listing) {
        const local = has('-C')
        if (!local) {
          ctx.out(`${'SELinux fcontext'.padEnd(50)}${'type'.padEnd(18)}Context\n\n`)
          for (const r of ['/var/www(/.*)?:httpd_sys_content_t', '/usr/share/nginx/html(/.*)?:httpd_sys_content_t', '/srv/([^/]*/)?www(/.*)?:httpd_sys_content_t', '/home/[^/]+/\\.ssh(/.*)?:ssh_home_t', '/var/log(/.*)?:var_log_t']) {
            const [re, t] = r.split(/:(?=[a-z_]+$)/)
            ctx.out(`${re.padEnd(50)}${'all files'.padEnd(18)}system_u:object_r:${t}:s0\n`)
          }
        }
        if (se.localRules.length) {
          ctx.out(`\nSELinux fcontext${local ? '' : ' (local)'}`.padEnd(51) + `${'type'.padEnd(18)}Context\n\n`)
          for (const r of se.localRules) ctx.out(`${r.regex.padEnd(50)}${'all files'.padEnd(18)}system_u:object_r:${r.type}:s0\n`)
        }
        return 0
      }
      const spec = positional[0]
      if (!spec) {
        ctx.err('ValueError: Requires file_spec\n')
        return 1
      }
      if (has('-d') || has('--delete')) {
        const before = se.localRules.length
        se.localRules = se.localRules.filter((r) => r.regex !== spec)
        if (before === se.localRules.length) {
          ctx.err(`ValueError: File context for ${spec} is not defined\n`)
          return 1
        }
        return 0
      }
      const type = val('-t')
      if (!type) {
        ctx.err('ValueError: SELinux Type is required\n')
        return 1
      }
      if (se.localRules.some((r) => r.regex === spec) && !has('-m')) {
        ctx.err(`ValueError: File context for ${spec} already defined\n`)
        return 1
      }
      se.localRules = se.localRules.filter((r) => r.regex !== spec)
      se.localRules.push({ regex: spec, type })
      if (!spec.includes('(') && !spec.includes('*')) ctx.err(`[simulador] Esta regla solo vale para "${spec}" exacto. Para incluir lo que está adentro: "${spec}(/.*)?"\n`)
      return 0
    }
    if (section === 'port') {
      if (listing) {
        ctx.out(`${'SELinux Port Type'.padEnd(30)}${'Proto'.padEnd(10)}Port Number\n\n`)
        const rows = POLICY_PORTS.map(([t, p, list]) => [t, p, list] as [string, string, string])
        for (const [k, t] of se.localPorts) {
          const [p, n] = k.split('/')
          const row = rows.find((r) => r[0] === t && r[1] === p)
          if (row) row[2] = `${n}, ${row[2]}`
          else rows.push([t, p, n])
        }
        for (const [t, p, list] of rows.sort((a, b) => a[0].localeCompare(b[0]))) ctx.out(`${t.padEnd(30)}${p.padEnd(10)}${list}\n`)
        return 0
      }
      const proto = val('-p')
      const port = positional[0]
      if (!proto || !port) {
        ctx.err('ValueError: Protocol udp or tcp is required\n')
        return 1
      }
      const key = `${proto}/${port}`
      if (has('-d')) {
        if (!se.localPorts.delete(key)) {
          ctx.err(`ValueError: Port ${key} is defined in policy, cannot be deleted\n`)
          return 1
        }
        return 0
      }
      const type = val('-t')
      if (!type) {
        ctx.err('ValueError: Type is required\n')
        return 1
      }
      const current = portType(ctx.sys, proto, Number(port))
      if (has('-a') && !['reserved_port_t', 'unreserved_port_t'].includes(current)) {
        ctx.err(`ValueError: Port ${key} already defined\n[simulador] Ese puerto ya tiene el tipo ${current}. Para cambiarlo, usa -m en lugar de -a.\n`)
        return 1
      }
      se.localPorts.set(key, type)
      return 0
    }
    if (section === 'boolean') {
      if (listing) {
        ctx.out(`${'SELinux boolean'.padEnd(36)}${'State  Default'.padEnd(16)}Description\n\n`)
        for (const [n, b] of [...se.booleans].sort()) ctx.out(`${n.padEnd(36)}(${(b.cur ? 'on' : 'off').padEnd(5)},${(b.def ? 'on' : 'off').padStart(5)})  ${b.desc}\n`)
        return 0
      }
      const name = positional[0]
      const b = name ? se.booleans.get(name) : undefined
      if (!b) {
        ctx.err(`ValueError: Boolean ${name ?? ''} is not defined\n`)
        return 1
      }
      if (has('--on') || has('-1')) b.cur = b.def = true
      if (has('--off') || has('-0')) b.cur = b.def = false
      return 0
    }
    ctx.out('[simulador] Esta parte de semanage no está simulada.\n')
    return 0
  },
})

register('getsebool', {
  usage: 'getsebool -a | getsebool BOOLEANO',
  path: '/usr/sbin',
  run(ctx) {
    if (!rockyOnly(ctx)) return 127
    const se = ctx.sys.selinux
    if (se.mode === 'disabled') {
      ctx.err('getsebool:  SELinux is disabled\n')
      return 1
    }
    const names = ctx.args.includes('-a') ? [...se.booleans.keys()].sort() : ctx.args
    let code = 0
    for (const n of names) {
      const b = se.booleans.get(n)
      if (!b) {
        ctx.err(`Error getting active value for ${n}\n`)
        code = 1
        continue
      }
      ctx.out(`${n} --> ${b.cur ? 'on' : 'off'}\n`)
    }
    return code
  },
})

register('setsebool', {
  usage: 'setsebool [-P] BOOLEANO on|off',
  summary: '  -P  que quede así también después de reiniciar (sin -P, se pierde)',
  path: '/usr/sbin',
  run(ctx) {
    if (!rockyOnly(ctx)) return 127
    const perm = ctx.args.includes('-P')
    const rest = ctx.args.filter((a) => a !== '-P')
    const [name, v] = rest.length === 1 && rest[0].includes('=') ? rest[0].split('=') : rest
    const b = name ? ctx.sys.selinux.booleans.get(name) : undefined
    if (!b || !v) {
      ctx.err(`Boolean ${name ?? ''} is not defined\n`)
      return 1
    }
    if (!needRoot(ctx, 'Could not change active booleans: Permission denied\n')) return 1
    const on = ['on', '1', 'true'].includes(v.toLowerCase())
    b.cur = on
    if (perm) b.def = on
    return 0
  },
})

// ---------------------------------------------------------------------------------------
// Auditoría: ausearch y audit2why
// ---------------------------------------------------------------------------------------

register('ausearch', {
  usage: 'ausearch -m avc [-ts recent|today] [-c COMANDO]',
  path: '/usr/sbin',
  run(ctx) {
    if (!rockyOnly(ctx, 'auditd')) return 127
    if (!needRoot(ctx, 'Error opening /var/log/audit/audit.log (Permission denied)\n')) return 1
    const val = (f: string) => {
      const i = ctx.args.indexOf(f)
      return i >= 0 ? ctx.args[i + 1] : undefined
    }
    const ts = val('-ts')
    const since = ts === 'recent' ? Date.now() - 10 * 60_000 : ts === 'today' ? new Date().setHours(0, 0, 0, 0) : 0
    const comm = val('-c')
    const recs = ctx.sys.avcLog.filter((r) => r.time >= since && (!comm || r.comm === comm))
    if (!recs.length) {
      ctx.err('<no matches>\n')
      return 1
    }
    for (const r of recs) ctx.out(`----\ntime->${strftime('%a %b %e %T %Y', new Date(r.time))}\n${r.text}\n`)
    return 0
  },
})

register('audit2why', {
  usage: 'ausearch -m avc -ts recent | audit2why',
  run(ctx) {
    const text = ctx.stdin.readAll()
    const avcs = text.split('\n').filter((l) => l.startsWith('type=AVC'))
    if (!avcs.length) {
      ctx.err('[simulador] audit2why lee denegaciones de la entrada: ausearch -m avc -ts recent | audit2why\n')
      return 1
    }
    for (const l of avcs) {
      ctx.out(`${l}\n\n\tWas caused by:\n`)
      const t = /tcontext=\S+:\S+:(\S+):/.exec(l)?.[1] ?? ''
      if (/user_home_t|user_home_dir_t/.test(t) && /comm="(nginx|httpd)"/.test(l)) {
        ctx.out(`\tThe boolean httpd_read_user_content was set incorrectly. \n\tDescription:\n\tAllow httpd to read user content\n\n\tAllow access by executing:\n\t# setsebool -P httpd_read_user_content 1\n\n`)
        ctx.out('[simulador] Ojo: lo correcto casi siempre es que los archivos del sitio no estén en un home, o etiquetarlos bien, no abrir el booleano.\n')
      } else {
        ctx.out('\t\tMissing type enforcement (TE) allow rule.\n\n\t\tYou can use audit2allow to generate a loadable module to allow this access.\n\n')
        ctx.out(t.endsWith('port_t') ? '[simulador] Para un puerto: semanage port -a -t TIPO -p tcp PUERTO (no un módulo nuevo).\n' : '[simulador] Para archivos en un lugar no estándar: semanage fcontext -a -t TIPO "RUTA(/.*)?" y restorecon -Rv RUTA (no un módulo nuevo).\n')
      }
    }
    return 0
  },
})

// ---------------------------------------------------------------------------------------
// AppArmor (Ubuntu)
// ---------------------------------------------------------------------------------------

const AA_PROFILES = ['/usr/bin/man', '/usr/lib/NetworkManager/nm-dhcp-client.action', '/usr/lib/connman/scripts/dhclient-script', '/usr/lib/snapd/snap-confine', '/usr/sbin/chronyd', '/usr/sbin/rsyslogd', '/usr/sbin/tcpdump', 'lsb_release', 'man_filter', 'man_groff', 'nvidia_modprobe', 'nvidia_modprobe//kmod', 'ubuntu_pro_apt_news', 'unix-chkpwd']

function aaState(ctx: CommandContext): Map<string, 'enforce' | 'complain'> {
  const sys = ctx.sys
  if (!sys.apparmor.size) for (const p of AA_PROFILES) sys.apparmor.set(p, 'enforce')
  return sys.apparmor
}

register('aa-status', {
  usage: 'aa-status',
  path: '/usr/sbin',
  run(ctx) {
    if (ctx.sys.distro !== 'ubuntu') {
      ctx.err(`bash: ${ctx.name}: command not found\n[simulador] Rocky usa SELinux, no AppArmor: prueba getenforce o sestatus.\n`)
      return 127
    }
    if (!needRoot(ctx, 'apparmor module is loaded.\nYou do not have enough privilege to read the profile set.\n')) return 4
    const st = aaState(ctx)
    const enforce = [...st].filter(([, m]) => m === 'enforce').map(([p]) => p).sort()
    const complain = [...st].filter(([, m]) => m === 'complain').map(([p]) => p).sort()
    const procs = ctx.sys.procs.filter((p) => st.has(`/usr/sbin/${p.comm}`))
    const pin = (mode: string) => procs.filter((p) => st.get(`/usr/sbin/${p.comm}`) === mode)
    ctx.out(`apparmor module is loaded.\n${st.size} profiles are loaded.\n${enforce.length} profiles are in enforce mode.\n${enforce.map((p) => `   ${p}\n`).join('')}${complain.length} profiles are in complain mode.\n${complain.map((p) => `   ${p}\n`).join('')}0 profiles are in prompt mode.\n0 profiles are in kill mode.\n0 profiles are in unconfined mode.\n${procs.length} processes have profiles defined.\n${pin('enforce').length} processes are in enforce mode.\n${pin('enforce').map((p) => `   /usr/sbin/${p.comm} (${p.pid}) \n`).join('')}${pin('complain').length} processes are in complain mode.\n${pin('complain').map((p) => `   /usr/sbin/${p.comm} (${p.pid}) \n`).join('')}0 processes are in prompt mode.\n0 processes are in kill mode.\n0 processes are unconfined but have a profile defined.\n0 processes are in mixed mode.\n`)
    return 0
  },
})
COMMANDS.set('apparmor_status', COMMANDS.get('aa-status')!)

for (const [name, mode] of [['aa-complain', 'complain'], ['aa-enforce', 'enforce']] as const) {
  register(name, {
    usage: `${name} PERFIL`,
    path: '/usr/sbin',
    run(ctx) {
      if (!needRoot(ctx, `${name}: Permission denied\n`)) return 1
      const st = aaState(ctx)
      for (const a of ctx.args) {
        const prof = a.startsWith('/etc/apparmor.d/') ? '/' + a.slice('/etc/apparmor.d/'.length).replace(/\./g, '/') : a
        if (!st.has(prof)) {
          ctx.err(`Profile for ${a} not found, skipping\n`)
          continue
        }
        st.set(prof, mode)
        ctx.out(`Setting ${prof} to ${mode} mode.\n`)
      }
      return 0
    },
  })
}

// ---------------------------------------------------------------------------------------
// nginx -t y el arranque de nginx
// ---------------------------------------------------------------------------------------

register('nginx', {
  usage: 'nginx -t  |  nginx -T  |  nginx -s reload  |  nginx -v',
  path: '/usr/sbin',
  run(ctx) {
    if (ctx.args.includes('-v') || ctx.args.includes('-V')) {
      ctx.err('nginx version: nginx/1.26.3\n')
      return 0
    }
    if (ctx.args.includes('-t') || ctx.args.includes('-T')) {
      if (ctx.sh.user !== 'root') {
        ctx.err('nginx: [alert] could not open error log file: open() "/var/log/nginx/error.log" failed (13: Permission denied)\n')
      }
      const errs = nginxTest(ctx.sys)
      if (errs.length) {
        ctx.err(`${errs[0]}\nnginx: configuration file /etc/nginx/nginx.conf test failed\n`)
        return 1
      }
      ctx.err('nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful\n')
      if (ctx.args.includes('-T')) {
        try {
          ctx.out(`# configuration file /etc/nginx/nginx.conf:\n${ctx.sys.vfs.readFile('/etc/nginx/nginx.conf', ROOT_CRED)}\n`)
        } catch {
          // sin archivo
        }
      }
      return 0
    }
    if (ctx.args[0] === '-s') {
      if (!ctx.sys.services.get('nginx')?.active) {
        ctx.err('nginx: [error] open() "/run/nginx.pid" failed (2: No such file or directory)\n')
        return 1
      }
      const err = nginxStartCheck(ctx.sys)
      if (err) {
        ctx.err(err + '\n')
        return 1
      }
      return 0
    }
    ctx.err('[simulador] nginx se maneja como servicio: sudo systemctl start nginx. Para revisar la configuración: sudo nginx -t\n')
    return 1
  },
})

SERVICE_CHECKS.nginx = (ctx) => nginxStartCheck(ctx.sys)

export { typeOf }
