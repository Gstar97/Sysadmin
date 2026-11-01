/**
 * Kernel y hora: sysctl, lsmod, modinfo, modprobe, rmmod, timedatectl, chronyc, y tareas únicas
 * con at, atq y atrm.
 */
import { parseArgs } from '../args'
import { chronyService, chronyStart, LOADED_BY_DEFAULT, modprobeConf, MODS, norm, ntpSources, users, writeProcSys, ZONE_OFFSET, ZONES } from '../kernel'
import { register, type CommandContext } from '../shell'
import type { System } from '../system'
import { ROOT_CRED } from '../vfs'
import { strftime, tzInfo } from './sysinfo'

// ---------------------------------------------------------------------------------------
// sysctl
// ---------------------------------------------------------------------------------------

function sysctlFiles(sys: System): string[] {
  const files: string[] = []
  for (const dir of ['/usr/lib/sysctl.d', '/etc/sysctl.d']) {
    if (!sys.vfs.exists(dir)) continue
    for (const f of sys.vfs.readdir(dir, ROOT_CRED).sort()) if (f.endsWith('.conf')) files.push(`${dir}/${f}`)
  }
  if (sys.vfs.exists('/etc/sysctl.conf')) files.push('/etc/sysctl.conf')
  return files
}

function applySysctlFile(ctx: CommandContext, path: string, quiet = false): number {
  let text: string
  try {
    text = ctx.sys.vfs.readFile(path, ctx.sh.cred)
  } catch {
    ctx.err(`sysctl: cannot open "${path}": No such file or directory\n`)
    return 1
  }
  let code = 0
  if (!quiet) ctx.out(`* Applying ${path} ...\n`)
  for (const raw of text.split('\n')) {
    const l = raw.trim()
    if (!l || l.startsWith('#') || l.startsWith(';')) continue
    const m = /^-?([\w./-]+)\s*=\s*(.*)$/.exec(l)
    if (!m) continue
    const key = m[1].replace(/\//g, '.')
    if (!ctx.sys.sysctl.has(key)) {
      ctx.err(`sysctl: cannot stat /proc/sys/${key.replace(/\./g, '/')}: No such file or directory\n`)
      code = 1
      continue
    }
    ctx.sys.sysctl.set(key, m[2])
    writeProcSys(ctx.sys, key, m[2])
    ctx.out(`${key} = ${m[2]}\n`)
  }
  return code
}

register('sysctl', {
  usage: 'sysctl [-a] [-n] [-w CLAVE=VALOR] [-p [ARCHIVO]] [--system] [CLAVE...]',
  summary: '  -a  todas · -w  cambiar ahora · -p  aplicar /etc/sysctl.conf (o el archivo) · --system  aplicar todos los .conf',
  path: '/usr/sbin',
  run(ctx) {
    const a = parseArgs(ctx.args, { flags: { a: ['a', 'A', 'all'], n: ['n', 'values'], N: ['N', 'names'], w: ['w', 'write'], system: ['system'], q: ['q', 'quiet'] }, values: { p: ['p', 'load'] } })
    const sys = ctx.sys
    if (a.flags.has('system')) {
      if (ctx.sh.user !== 'root') {
        ctx.err('sysctl: permission denied on key "vm.swappiness"\n')
        return 1
      }
      let code = 0
      for (const f of sysctlFiles(sys)) code ||= applySysctlFile(ctx, f)
      return code
    }
    if (ctx.args.includes('-p') || a.values.has('p')) {
      if (ctx.sh.user !== 'root') {
        ctx.err('sysctl: permission denied on key "vm.swappiness"\n')
        return 1
      }
      const file = a.values.get('p') && !a.values.get('p')!.includes('=') ? a.values.get('p')! : '/etc/sysctl.conf'
      return applySysctlFile(ctx, file, true)
    }
    const show = (k: string) => ctx.out(a.flags.has('n') ? `${sys.sysctl.get(k)}\n` : a.flags.has('N') ? `${k}\n` : `${k} = ${sys.sysctl.get(k)}\n`)
    if (a.flags.has('a') || !a.rest.length) {
      for (const k of [...sys.sysctl.keys()].sort()) show(k)
      return 0
    }
    let code = 0
    for (const item of a.rest) {
      const eq = item.indexOf('=')
      const key = (eq >= 0 ? item.slice(0, eq) : item).trim().replace(/\//g, '.')
      if (!sys.sysctl.has(key)) {
        ctx.err(`sysctl: cannot stat /proc/sys/${key.replace(/\./g, '/')}: No such file or directory\n`)
        code = 255
        continue
      }
      if (eq >= 0) {
        if (!a.flags.has('w')) {
          ctx.err(`sysctl: "${item}" must be of the form name=value — use -w to write\n`)
        }
        if (ctx.sh.user !== 'root') {
          ctx.err(`sysctl: permission denied on key "${key}"\n`)
          code = 1
          continue
        }
        const value = item.slice(eq + 1).trim()
        sys.sysctl.set(key, value)
        writeProcSys(sys, key, value)
        if (!a.flags.has('q')) ctx.out(`${key} = ${value}\n`)
      } else show(key)
    }
    return code
  },
})

// ---------------------------------------------------------------------------------------
// Módulos del kernel
// ---------------------------------------------------------------------------------------

register('lsmod', {
  usage: 'lsmod',
  path: '/usr/sbin',
  run(ctx) {
    ctx.out('Module                  Size  Used by\n')
    for (const m of [...ctx.sys.modules].sort().reverse()) {
      const u = users(ctx.sys, m)
      ctx.out(`${m.padEnd(19)} ${String(MODS[m]?.size ?? 16384).padStart(9)}  ${u.length}${u.length ? ' ' + u.join(',') : ''}\n`)
    }
    return 0
  },
})

register('modinfo', {
  usage: 'modinfo MÓDULO',
  path: '/usr/sbin',
  run(ctx) {
    const fIdx = ctx.args.indexOf('-F')
    const name = ctx.args.find((x, i) => !x.startsWith('-') && i !== fIdx + 1)
    const m = name ? MODS[norm(name)] : undefined
    if (!name || !m) {
      ctx.err(`modinfo: ERROR: Module ${name ?? ''} not found.\n`)
      return 1
    }
    const kv = ctx.sys.distro === 'rocky' ? '6.12.0-55.el10.x86_64' : '6.8.0-58-generic'
    const field = ctx.args.includes('-F') ? ctx.args[ctx.args.indexOf('-F') + 1] : undefined
    const rows: [string, string][] = [
      ['filename', `/lib/modules/${kv}/${m.file}`],
      ['description', m.desc],
      ['license', 'GPL'],
      ['depends', m.deps.join(',')],
      ['intree', 'Y'],
      ['name', norm(name)],
      ['vermagic', `${kv} SMP preempt mod_unload modversions `],
      ...(m.params ?? []).map((p) => ['parm', p] as [string, string]),
    ]
    for (const [k, v] of rows) if (!field || field === k) ctx.out(field ? `${v}\n` : `${(k + ':').padEnd(16)}${v}\n`)
    return 0
  },
})

register('modprobe', {
  usage: 'modprobe [-r] MÓDULO',
  summary: '  -r  quitar el módulo (y los que dependen de él, si nadie más los usa)\n  -n -v  mostrar qué haría sin hacerlo',
  path: '/usr/sbin',
  run(ctx) {
    const remove = ctx.args.includes('-r') || ctx.args.includes('--remove')
    const dry = ctx.args.includes('-n') || ctx.args.includes('--dry-run')
    const verbose = ctx.args.includes('-v') || ctx.args.includes('--verbose')
    const name = ctx.args.find((x) => !x.startsWith('-'))
    if (!name) {
      ctx.err('modprobe: ERROR: missing parameters. See -h.\n')
      return 1
    }
    const mod = norm(name)
    const sys = ctx.sys
    if (ctx.sh.user !== 'root' && !dry) {
      ctx.err(`modprobe: ERROR: could not insert '${mod}': Operation not permitted\n`)
      return 1
    }
    if (!MODS[mod]) {
      ctx.err(`modprobe: FATAL: Module ${name} not found in directory /lib/modules/${sys.distro === 'rocky' ? '6.12.0-55.el10.x86_64' : '6.8.0-58-generic'}\n`)
      return 1
    }
    if (remove) {
      const u = users(sys, mod)
      if (u.length) {
        ctx.err(`modprobe: FATAL: Module ${mod} is in use.\n`)
        return 1
      }
      if (mod === 'xfs' || mod === 'dm_mod' || mod === 'libata') {
        ctx.err(`modprobe: FATAL: Module ${mod} is in use.\n`)
        return 1
      }
      if (!dry) {
        sys.modules.delete(mod)
        for (const d of MODS[mod].deps) if (!users(sys, d).length && !LOADED_BY_DEFAULT.includes(d)) sys.modules.delete(d)
      }
      return 0
    }
    const { install } = modprobeConf(sys)
    if (install.has(mod)) {
      const cmd = install.get(mod)!
      if (verbose) ctx.out(`install ${cmd}\n`)
      if (/\/(bin\/)?(false|true)$/.test(cmd.trim())) {
        if (cmd.trim().endsWith('false')) {
          ctx.err(`modprobe: ERROR: Error running install command '${cmd}' for module ${mod}: retcode 1\nmodprobe: ERROR: could not insert '${mod}': Invalid argument\n`)
          return 1
        }
        return 0
      }
    }
    if (sys.modules.has(mod)) return 0
    const load = (m: string) => {
      for (const d of MODS[m]?.deps ?? []) load(d)
      if (!sys.modules.has(m)) {
        if (verbose || dry) ctx.out(`insmod /lib/modules/${sys.distro === 'rocky' ? '6.12.0-55.el10.x86_64' : '6.8.0-58-generic'}/${MODS[m].file}\n`)
        if (!dry) sys.modules.add(m)
      }
    }
    load(mod)
    return 0
  },
})

register('rmmod', {
  usage: 'rmmod MÓDULO',
  path: '/usr/sbin',
  run(ctx) {
    const name = ctx.args.find((x) => !x.startsWith('-'))
    const mod = norm(name ?? '')
    if (ctx.sh.user !== 'root') {
      ctx.err(`rmmod: ERROR: could not remove '${mod}': Operation not permitted\n`)
      return 1
    }
    if (!ctx.sys.modules.has(mod)) {
      ctx.err(`rmmod: ERROR: Module ${mod} is not currently loaded\n`)
      return 1
    }
    const u = users(ctx.sys, mod)
    if (u.length) {
      ctx.err(`rmmod: ERROR: Module ${mod} is in use by: ${u.join(' ')}\n`)
      return 1
    }
    ctx.sys.modules.delete(mod)
    return 0
  },
})

// ---------------------------------------------------------------------------------------
// Hora: timedatectl y chronyc
// ---------------------------------------------------------------------------------------

register('timedatectl', {
  usage: 'timedatectl [status | set-timezone ZONA | list-timezones | set-ntp true|false | timesync-status]',
  run(ctx) {
    const sys = ctx.sys
    const [verb = 'status', arg] = ctx.args.filter((x) => !x.startsWith('-'))
    if (verb === 'set-timezone') {
      if (ctx.sh.user !== 'root') {
        ctx.err('Failed to set time zone: Access denied\n')
        return 1
      }
      if (!arg || !ZONES.includes(arg)) {
        ctx.err(`Failed to set time zone: Invalid or not installed time zone '${arg ?? ''}'\n`)
        return 1
      }
      sys.clock.timezone = arg
      try {
        sys.vfs.unlink('/etc/localtime', ROOT_CRED)
      } catch {
        // no existía
      }
      sys.vfs.symlink(`../usr/share/zoneinfo/${arg}`, '/etc/localtime', ROOT_CRED)
      if (sys.distro === 'ubuntu') sys.vfs.writeFile('/etc/timezone', arg + '\n', ROOT_CRED)
      return 0
    }
    if (verb === 'list-timezones') {
      ctx.out(ZONES.slice(1).sort().concat('UTC').join('\n') + '\n')
      return 0
    }
    if (verb === 'set-ntp') {
      if (ctx.sh.user !== 'root') {
        ctx.err('Failed to set ntp: Access denied\n')
        return 1
      }
      const svc = chronyService(sys)
      if (svc) {
        const on = arg === 'true' || arg === 'yes' || arg === '1'
        svc.active = on
        svc.enabled = on
        if (on) chronyStart(sys)
        else sys.clock.synced = false
      }
      return 0
    }
    if (verb === 'show-timesync' || verb === 'timesync-status') {
      ctx.err('[simulador] timesync-status es de systemd-timesyncd. Con chrony, usa chronyc tracking y chronyc sources.\n')
      return 1
    }
    const d = new Date(Date.now() + sys.clock.offset * 1000)
    const svc = chronyService(sys)
    const ntp = !!svc?.active
    const tzName = sys.clock.timezone
    const tz = tzInfo(tzName, ZONE_OFFSET)
    const utc = tzInfo('UTC', ZONE_OFFSET)
    ctx.out(
      `               Local time: ${strftime('%a %F %T %Z', d, tz)}\n           Universal time: ${strftime('%a %F %T', d, utc)} UTC\n                 RTC time: ${strftime('%a %F %T', d, utc)}\n                Time zone: ${tzName} (${tz.abbr}, ${strftime('%z', d, tz)})\nSystem clock synchronized: ${ntp && sys.clock.synced ? 'yes' : 'no'}\n              NTP service: ${ntp ? 'active' : 'inactive'}\n          RTC in local TZ: no\n`,
    )
    return 0
  },
})

register('chronyc', {
  usage: 'chronyc [sources [-v] | tracking | sourcestats | makestep | activity]',
  run(ctx) {
    const sys = ctx.sys
    const svc = chronyService(sys)
    const verb = ctx.args.find((x) => !x.startsWith('-')) ?? 'tracking'
    if (!svc?.active) {
      ctx.err('506 Cannot talk to daemon\n')
      return 1
    }
    const sources = ntpSources(sys)
    if (verb === 'sources') {
      ctx.out(`MS Name/IP address         Stratum Poll Reach LastRx Last sample               \n===============================================================================\n`)
      sources.forEach((s, i) => {
        const names = [s.name]
        for (const [j, n] of names.entries()) {
          if (s.reachable) {
            const mark = i === 0 && j === 0 && sys.clock.synced ? '^*' : '^+'
            ctx.out(`${mark} ${n.slice(0, 27).padEnd(27)} ${String(2 + ((i + j) % 2)).padStart(2)}   6   377    ${String(20 + i * 7).padStart(2)}   ${`+${120 + i * 37}us[ +${150 + i * 41}us]`.padEnd(18)} +/-   ${12 + i * 5}ms\n`)
          } else ctx.out(`^? ${n.slice(0, 27).padEnd(27)}  0   6     0     -     +0ns[   +0ns] +/-    0ns\n`)
        }
      })
      if (ctx.args.includes('-v')) ctx.out('\n  ^* = sincronizado con esta fuente · ^+ = combinada · ^? = sin respuesta\n')
      return 0
    }
    if (verb === 'tracking') {
      const best = sources.find((s) => s.reachable)
      if (!best || !sys.clock.synced) {
        ctx.out(`Reference ID    : 00000000 ()\nStratum         : 0\nRef time (UTC)  : Thu Jan 01 00:00:00 1970\nSystem time     : ${Math.abs(sys.clock.offset).toFixed(9)} seconds ${sys.clock.offset >= 0 ? 'fast' : 'slow'} of NTP time\nLast offset     : +0.000000000 seconds\nRMS offset      : 0.000000000 seconds\nFrequency       : 0.000 ppm slow\nResidual freq   : +0.000 ppm\nSkew            : 0.000 ppm\nRoot delay      : 1.000000000 seconds\nRoot dispersion : 1.000000000 seconds\nUpdate interval : 0.0 seconds\nLeap status     : Not synchronised\n`)
        return 0
      }
      ctx.out(`Reference ID    : C0A80101 (${best.name})\nStratum         : 3\nRef time (UTC)  : ${strftime('%a %b %d %T %Y', new Date(), tzInfo('UTC', ZONE_OFFSET))}\nSystem time     : ${Math.abs(sys.clock.offset).toFixed(9)} seconds ${sys.clock.offset >= 0 ? 'fast' : 'slow'} of NTP time\nLast offset     : +0.000089113 seconds\nRMS offset      : 0.000120531 seconds\nFrequency       : 12.345 ppm slow\nResidual freq   : +0.001 ppm\nSkew            : 0.035 ppm\nRoot delay      : 0.028441371 seconds\nRoot dispersion : 0.001204887 seconds\nUpdate interval : 64.2 seconds\nLeap status     : Normal\n`)
      return 0
    }
    if (verb === 'makestep') {
      if (ctx.sh.user !== 'root') {
        ctx.err('501 Not authorised\n')
        return 1
      }
      if (!sources.some((s) => s.reachable)) {
        ctx.out('200 OK\n')
        return 0
      }
      sys.clock.offset = 0.000412
      sys.clock.synced = true
      ctx.out('200 OK\n')
      return 0
    }
    if (verb === 'activity') {
      const on = sources.filter((s) => s.reachable).length
      ctx.out(`200 OK\n${on} sources online\n${sources.length - on} sources offline\n0 sources doing burst (return to online)\n0 sources doing burst (return to offline)\n0 sources with unknown address\n`)
      return 0
    }
    if (verb === 'sourcestats') {
      ctx.out('Name/IP Address            NP  NR  Span  Frequency  Freq Skew  Offset  Std Dev\n==============================================================================\n')
      for (const s of sources.filter((x) => x.reachable)) ctx.out(`${s.name.slice(0, 26).padEnd(26)}  12   7   11m     +0.012      0.041   +120us    52us\n`)
      return 0
    }
    ctx.err(`Unrecognized command\n`)
    return 1
  },
})

// ---------------------------------------------------------------------------------------
// at: una tarea, una sola vez
// ---------------------------------------------------------------------------------------

function parseAtTime(spec: string): number | undefined {
  const s = spec.trim().toLowerCase()
  const now = new Date()
  const rel = /^now\s*\+\s*(\d+)\s*(minutes?|min|hours?|days?)$/.exec(s)
  if (rel) {
    const n = Number(rel[1])
    const mult = rel[2].startsWith('h') ? 3_600_000 : rel[2].startsWith('d') ? 86_400_000 : 60_000
    return Date.now() + n * mult
  }
  if (s === 'now') return Date.now()
  if (s === 'midnight') {
    const d = new Date(now)
    d.setHours(24, 0, 0, 0)
    return d.getTime()
  }
  if (s === 'noon') {
    const d = new Date(now)
    d.setHours(12, 0, 0, 0)
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  const hm = /^(\d{1,2}):(\d{2})(\s+tomorrow)?$/.exec(s)
  if (hm) {
    const d = new Date(now)
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0)
    if (hm[3] || d.getTime() < Date.now()) d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  return undefined
}

register('at', {
  usage: 'at HORA   (lee los comandos de la entrada estándar)',
  summary: '  Ejemplos: echo "comando" | at 23:30 · at now + 10 minutes · at midnight\n  atq lista las tareas pendientes; atrm N borra una.',
  run(ctx) {
    const spec = ctx.args.filter((x) => !x.startsWith('-')).join(' ')
    if (ctx.args.includes('-l')) return listAt(ctx)
    if (!spec) {
      ctx.err('Garbled time\n')
      return 1
    }
    if (!ctx.sys.services.get('atd')?.active) {
      ctx.err(`[simulador] atd no está funcionando: instala el paquete at y arráncalo (sudo systemctl enable --now atd).\n`)
      return 1
    }
    const when = parseAtTime(spec)
    if (when === undefined) {
      ctx.err('syntax error. Last token seen: ' + spec.split(/\s+/).pop() + '\nGarbled time\n')
      return 1
    }
    const commands = ctx.stdin.readAll()
    if (!commands.trim()) {
      ctx.err('warning: commands will be executed using /bin/sh\n[simulador] at lee los comandos de la entrada estándar: echo "comando" | at ' + spec + '\n')
      return 1
    }
    const id = (ctx.sys.atJobs.reduce((m, j) => Math.max(m, j.id), 0) || 0) + 1
    ctx.sys.atJobs.push({ id, when, user: ctx.sh.user, commands, queue: 'a' })
    ctx.err(`warning: commands will be executed using /bin/sh\njob ${id} at ${strftime('%a %b %e %H:%M:00 %Y', new Date(when))}\n`)
    return 0
  },
})

function listAt(ctx: CommandContext) {
  for (const j of [...ctx.sys.atJobs].sort((a, b) => a.when - b.when)) {
    if (ctx.sh.user !== 'root' && j.user !== ctx.sh.user) continue
    ctx.out(`${j.id}\t${strftime('%a %b %e %H:%M:00 %Y', new Date(j.when))} ${j.queue} ${j.user}\n`)
  }
  return 0
}

register('atq', { usage: 'atq', run: (ctx) => listAt(ctx) })

register('atrm', {
  usage: 'atrm N...',
  run(ctx) {
    let code = 0
    for (const a of ctx.args) {
      const j = ctx.sys.atJobs.find((x) => x.id === Number(a))
      if (!j || (ctx.sh.user !== 'root' && j.user !== ctx.sh.user)) {
        ctx.err(`Cannot find jobid ${a}\n`)
        code = 1
        continue
      }
      ctx.sys.atJobs = ctx.sys.atJobs.filter((x) => x !== j)
    }
    return code
  },
})
