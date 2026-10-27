import { parseArgs } from '../args'
import { BUILTINS, COMMANDS, formatPrintf, register, type CommandContext } from '../shell'
import { commOf, priorityName, priorityNumber, type JournalEntry, type Service } from '../system'
import { ROOT_CRED } from '../vfs'
import { commandPackage } from '../packages'
import { CPU_FLAGS, dmiBiosText, efibootmgrText, fdiskText, lsblkText } from '../hardware'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number, w = 2) => String(n).padStart(w, '0')

function journalTime(ms: number): string {
  const d = new Date(ms)
  return `${MONTHS[d.getMonth()]} ${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function ago(ms: number): string {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}min ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}min ago`
  return `${Math.floor(h / 24)} days ago`
}

function sinceStamp(ms: number): string {
  const d = new Date(ms)
  return `${DAYS[d.getDay()]} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} UTC`
}

/** Comprobaciones extra al arrancar un servicio (por ejemplo, validar la configuración de nginx). */
export const SERVICE_CHECKS: Record<string, (ctx: CommandContext) => string | undefined> = {}

function unitName(n: string) {
  return n.replace(/\.service$/, '')
}

function canManage(ctx: CommandContext, verb: string, unit: string): boolean {
  if (ctx.sh.user === 'root') return true
  ctx.err(`Failed to ${verb} ${unit}.service: Access denied\nSee system logs and 'systemctl status ${unit}.service' for details.\n`)
  return false
}

function startService(ctx: CommandContext, svc: Service): boolean {
  const extra = SERVICE_CHECKS[svc.name]?.(ctx)
  const conflict = [...ctx.sys.services.values()].find((o) => o !== svc && o.active && o.ports.some((p) => svc.ports.includes(p)))
  const failure = svc.failMessage ?? extra ?? (conflict ? `bind() to 0.0.0.0:${svc.ports.find((p) => conflict.ports.includes(p))} failed (98: Address already in use)` : undefined)
  if (failure) {
    svc.active = false
    svc.failed = true
    svc.since = Date.now()
    const pid = ctx.sys.allocPid()
    ctx.sys.journal.push({ time: Date.now(), unit: `${svc.name}.service`, priority: 3, message: failure, ident: svc.name, pid })
    ctx.sys.journal.push({ time: Date.now(), unit: `${svc.name}.service`, priority: 3, message: `${svc.name}.service: Control process exited, code=exited, status=1/FAILURE`, ident: 'systemd', pid: 1 })
    ctx.sys.journal.push({ time: Date.now(), unit: `${svc.name}.service`, priority: 3, message: `Failed to start ${svc.name}.service - ${svc.description}.`, ident: 'systemd', pid: 1 })
    ctx.err(`Job for ${svc.name}.service failed because the control process exited with error code.\nSee "systemctl status ${svc.name}.service" and "journalctl -xeu ${svc.name}.service" for details.\n`)
    return false
  }
  if (!svc.active) {
    svc.active = true
    svc.failed = false
    svc.since = Date.now()
    svc.pid = ctx.sys.spawnService(svc.name).pid
    ctx.sys.journal.push({ time: Date.now(), unit: `${svc.name}.service`, priority: 6, message: `Started ${svc.name}.service - ${svc.description}.`, ident: 'systemd', pid: 1 })
  }
  return true
}

function stopService(ctx: CommandContext, svc: Service) {
  if (!svc.active) return
  svc.active = false
  svc.failed = false
  svc.since = Date.now()
  ctx.sys.procs = ctx.sys.procs.filter((p) => p.pid !== svc.pid && p.cmd !== svc.name)
  svc.pid = undefined
  ctx.sys.journal.push({ time: Date.now(), unit: `${svc.name}.service`, priority: 6, message: `Stopped ${svc.name}.service - ${svc.description}.`, ident: 'systemd', pid: 1 })
}

function statusText(ctx: CommandContext, svc: Service): string {
  const unitPath = ctx.sys.vfs.exists(`/etc/systemd/system/${svc.name}.service`) ? `/etc/systemd/system/${svc.name}.service` : `/usr/lib/systemd/system/${svc.name}.service`
  const enabled = svc.enabled ? 'enabled' : 'disabled'
  const dot = svc.active ? '\x1b[0;1;32m●\x1b[0m' : svc.failed ? '\x1b[0;1;31m×\x1b[0m' : '○'
  const active = svc.active
    ? `\x1b[0;1;32mactive (running)\x1b[0m since ${sinceStamp(svc.since)}; ${ago(svc.since)}`
    : svc.failed
      ? `\x1b[0;1;31mfailed\x1b[0m (Result: exit-code) since ${sinceStamp(svc.since)}; ${ago(svc.since)}`
      : 'inactive (dead)'
  let out = `${dot} ${svc.name}.service - ${svc.description}\n     Loaded: loaded (${unitPath}; ${enabled}; preset: disabled)\n     Active: ${active}\n`
  if (svc.active && svc.pid) {
    out += `   Main PID: ${svc.pid} (${svc.name})\n      Tasks: ${svc.ports.length ? 3 : 1} (limit: 22950)\n     Memory: 4.2M\n        CPU: 61ms\n     CGroup: /system.slice/${svc.name}.service\n             └─${svc.pid} ${svc.name}\n`
  }
  const logs = ctx.sys.journal.filter((j) => j.unit === `${svc.name}.service`).slice(-5)
  if (logs.length) out += '\n' + logs.map((j) => `${journalTime(j.time)} ${ctx.sys.hostname} ${j.ident}[${j.pid ?? 1}]: ${j.message}`).join('\n') + '\n'
  return out
}

register('systemctl', {
  usage: 'systemctl [OPTIONS...] COMMAND [UNIT...]',
  summary:
    '  status | start | stop | restart | reload | enable [--now] | disable [--now] | is-active | is-enabled | is-failed\n  list-units [--type=service] [--state=failed] | list-unit-files | daemon-reload | mask | unmask | cat | reset-failed',
  run(ctx) {
    const flags = ctx.args.filter((a) => a.startsWith('-'))
    const [verb, ...rawUnits] = ctx.args.filter((a) => !a.startsWith('-'))
    const units = rawUnits.map(unitName)
    const sys = ctx.sys
    const now = flags.includes('--now')
    const find = (u: string): Service | undefined => sys.services.get(u)
    const notFound = (u: string, action = 'start') => {
      ctx.err(action === 'status' ? `Unit ${u}.service could not be found.\n` : `Failed to ${action} ${u}.service: Unit ${u}.service not found.\n`)
    }
    switch (verb ?? 'list-units') {
      case 'status': {
        if (!units.length) {
          ctx.out(`● ${sys.hostname}\n    State: running\n    Units: ${sys.services.size} loaded\n     Jobs: 0 queued\n   Failed: ${[...sys.services.values()].filter((s) => s.failed).length} units\n`)
          return 0
        }
        let code = 0
        for (const u of units) {
          const svc = find(u)
          if (!svc) {
            notFound(u, 'status')
            code = 4
            continue
          }
          ctx.out(statusText(ctx, svc))
          if (!svc.active) code = 3
        }
        return code
      }
      case 'start':
      case 'restart':
      case 'reload':
      case 'try-restart': {
        let code = 0
        for (const u of units) {
          const svc = find(u)
          if (!svc) {
            notFound(u, verb)
            code = 5
            continue
          }
          if (!canManage(ctx, verb, u)) return 1
          if (svc.enabled === false && (svc as Service & { masked?: boolean }).masked) {
            ctx.err(`Failed to ${verb} ${u}.service: Unit ${u}.service is masked.\n`)
            code = 1
            continue
          }
          if (verb === 'reload' && !svc.active) {
            ctx.err(`Job for ${u}.service invalid.\n`)
            code = 1
            continue
          }
          if (verb === 'restart') stopService(ctx, svc)
          if (verb === 'reload') {
            const err = SERVICE_CHECKS[svc.name]?.(ctx)
            if (err) {
              ctx.err(`Job for ${u}.service failed.\nSee "systemctl status ${u}.service" and "journalctl -xeu ${u}.service" for details.\n`)
              sys.journal.push({ time: Date.now(), unit: `${u}.service`, priority: 3, message: err, ident: u })
              code = 1
            } else sys.journal.push({ time: Date.now(), unit: `${u}.service`, priority: 6, message: `Reloaded ${u}.service - ${svc.description}.`, ident: 'systemd', pid: 1 })
            continue
          }
          if (!startService(ctx, svc)) code = 1
        }
        return code
      }
      case 'stop': {
        for (const u of units) {
          const svc = find(u)
          if (!svc) {
            notFound(u, 'stop')
            return 5
          }
          if (!canManage(ctx, 'stop', u)) return 1
          stopService(ctx, svc)
        }
        return 0
      }
      case 'enable':
      case 'disable': {
        let code = 0
        for (const u of units) {
          const svc = find(u)
          if (!svc) {
            ctx.err(`Failed to ${verb} unit: Unit file ${u}.service does not exist.\n`)
            code = 1
            continue
          }
          if (ctx.sh.user !== 'root') {
            ctx.err(`Failed to ${verb} unit: Access denied\n`)
            return 1
          }
          const want = verb === 'enable'
          if (svc.enabled !== want) {
            svc.enabled = want
            ctx.err(
              want
                ? `Created symlink '/etc/systemd/system/multi-user.target.wants/${u}.service' → '/usr/lib/systemd/system/${u}.service'.\n`
                : `Removed '/etc/systemd/system/multi-user.target.wants/${u}.service'.\n`,
            )
          }
          if (now) {
            if (want) {
              if (!startService(ctx, svc)) code = 1
            } else stopService(ctx, svc)
          }
        }
        return code
      }
      case 'is-active': {
        const svc = find(units[0] ?? '')
        const st = svc ? (svc.active ? 'active' : svc.failed ? 'failed' : 'inactive') : 'inactive'
        if (!flags.includes('--quiet') && !flags.includes('-q')) ctx.out(st + '\n')
        return st === 'active' ? 0 : 3
      }
      case 'is-enabled': {
        const svc = find(units[0] ?? '')
        if (!svc) {
          ctx.err(`Failed to get unit file state for ${units[0]}.service: No such file or directory\n`)
          return 1
        }
        ctx.out((svc.enabled ? 'enabled' : 'disabled') + '\n')
        return svc.enabled ? 0 : 1
      }
      case 'is-failed': {
        const svc = find(units[0] ?? '')
        ctx.out((svc?.failed ? 'failed' : svc?.active ? 'active' : 'inactive') + '\n')
        return svc?.failed ? 0 : 1
      }
      case 'list-units':
      case 'list-unit-files': {
        const stateFilter = flags.find((f) => f.startsWith('--state='))?.split('=')[1]
        let list = [...sys.services.values()].sort((a, b) => a.name.localeCompare(b.name))
        if (stateFilter === 'failed') list = list.filter((s) => s.failed)
        if (stateFilter === 'running' || stateFilter === 'active') list = list.filter((s) => s.active)
        if (verb === 'list-unit-files') {
          ctx.out('UNIT FILE                          STATE    PRESET\n')
          for (const s of list) ctx.out(`${(s.name + '.service').padEnd(34)} ${(s.enabled ? 'enabled' : 'disabled').padEnd(8)} disabled\n`)
          ctx.out(`\n${list.length} unit files listed.\n`)
          return 0
        }
        if (!flags.some((f) => f.includes('all'))) list = list.filter((s) => s.active || s.failed)
        ctx.out('  UNIT                          LOAD   ACTIVE SUB     DESCRIPTION\n')
        for (const s of list) {
          ctx.out(`${s.failed ? '●' : ' '} ${(s.name + '.service').padEnd(29)} loaded ${(s.active ? 'active' : s.failed ? 'failed' : 'inactive').padEnd(6)} ${(s.active ? 'running' : s.failed ? 'failed' : 'dead').padEnd(7)} ${s.description}\n`)
        }
        ctx.out(`\nLOAD   = Reflects whether the unit definition was properly loaded.\nACTIVE = The high-level unit activation state, i.e. generalization of SUB.\nSUB    = The low-level unit activation state, values depend on unit type.\n\n${list.length} loaded units listed.\n`)
        return 0
      }
      case 'daemon-reload': {
        if (ctx.sh.user !== 'root') {
          ctx.err('Failed to reload daemon: Access denied\n')
          return 1
        }
        // Registrar las unidades nuevas de /etc/systemd/system.
        for (const f of sys.vfs.readdir('/etc/systemd/system', ROOT_CRED)) {
          const m = /^(.+)\.service$/.exec(f)
          if (!m || sys.services.has(m[1])) continue
          const text = sys.vfs.readFile(`/etc/systemd/system/${f}`, ROOT_CRED)
          const desc = /^Description=(.*)$/m.exec(text)?.[1] ?? m[1]
          sys.services.set(m[1], { name: m[1], description: desc, active: false, enabled: false, failed: false, ports: [], since: Date.now() })
        }
        return 0
      }
      case 'cat': {
        const svc = find(units[0] ?? '')
        if (!svc) {
          ctx.err(`No files found for ${units[0]}.service.\n`)
          return 1
        }
        const custom = `/etc/systemd/system/${svc.name}.service`
        if (sys.vfs.exists(custom)) ctx.out(`# ${custom}\n${sys.vfs.readFile(custom, ROOT_CRED)}`)
        else ctx.out(`# /usr/lib/systemd/system/${svc.name}.service\n[Unit]\nDescription=${svc.description}\nAfter=network-online.target\n\n[Service]\nType=forking\nExecStart=/usr/sbin/${svc.name}\n\n[Install]\nWantedBy=multi-user.target\n`)
        return 0
      }
      case 'edit': {
        if (!canManage(ctx, 'edit', units[0] ?? '')) return 1
        const path = `/etc/systemd/system/${units[0]}.service.d/override.conf`
        sys.vfs.mkdirp(`/etc/systemd/system/${units[0]}.service.d`, ROOT_CRED)
        ctx.sh.pendingEditor = { path, content: sys.vfs.exists(path) ? sys.vfs.readFile(path, ROOT_CRED) : '[Service]\n', editor: 'systemctl edit' }
        return 0
      }
      case 'mask':
      case 'unmask': {
        const svc = find(units[0] ?? '')
        if (!svc) return 1
        ;(svc as Service & { masked?: boolean }).masked = verb === 'mask'
        if (verb === 'mask') svc.enabled = false
        ctx.err(verb === 'mask' ? `Created symlink '/etc/systemd/system/${svc.name}.service' → '/dev/null'.\n` : `Removed '/etc/systemd/system/${svc.name}.service'.\n`)
        return 0
      }
      case 'reset-failed':
        for (const s of sys.services.values()) s.failed = false
        return 0
      case 'reboot':
      case 'poweroff':
        ctx.err('[simulador] El servidor no se reinicia ni se apaga en el simulador.\n')
        return 0
      default:
        ctx.err(`Unknown command verb '${verb}'.\n`)
        return 1
    }
  },
})

function parseSince(v: string): number | undefined {
  const now = Date.now()
  if (v === 'today') {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  if (v === 'yesterday') {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.getTime() - 86_400_000
  }
  const m = /^(\d+)\s*(min|minutes?|h|hours?|d|days?)\s+ago$/.exec(v) ?? /^-(\d+)(min|h|d)$/.exec(v)
  if (m) {
    const n = Number(m[1])
    const unit = m[2].startsWith('m') ? 60_000 : m[2].startsWith('h') ? 3_600_000 : 86_400_000
    return now - n * unit
  }
  const t = Date.parse(v.replace(' ', 'T'))
  return Number.isNaN(t) ? undefined : t
}

register('journalctl', {
  usage: 'journalctl [OPTIONS...]',
  summary: '  -u UNIT  -p PRIORITY  -n LINES  -f  -b  -r  -e  -x  --since TIME  --until TIME  --no-pager',
  run(ctx) {
    const a = parseArgs(ctx.args, {
      flags: { f: ['f', 'follow'], b: ['b', 'boot'], r: ['r', 'reverse'], e: ['e', 'pager-end'], x: ['x', 'catalog'], k: ['k', 'dmesg'], nopager: ['no-pager'], q: ['q', 'quiet'] },
      values: { u: ['u', 'unit'], p: ['p', 'priority'], n: ['n', 'lines'], since: ['S', 'since'], until: ['U', 'until'], o: ['o', 'output'], t: ['t', 'identifier'] },
    })
    const user = ctx.sh.user
    const privileged = user === 'root' || ctx.sys.groupsOf(user).some((g) => ['wheel', 'adm', 'systemd-journal'].includes(g))
    if (!privileged) {
      ctx.out('Hint: You are currently not seeing messages from other users and the system.\n      Users in groups \'adm\', \'systemd-journal\', \'wheel\' can see all messages.\n      Pass -q to turn off this notice.\n-- No entries --\n')
      return 0
    }
    let entries: JournalEntry[] = [...ctx.sys.journal]
    if (a.values.has('u')) {
      const unit = a.values.get('u')!.replace(/\.service$/, '')
      entries = entries.filter((e) => e.unit.replace(/\.service$/, '') === unit)
    }
    if (a.values.has('t')) entries = entries.filter((e) => e.ident === a.values.get('t'))
    if (a.values.has('p')) {
      const spec = a.values.get('p')!
      const [lo, hi] = spec.includes('..') ? spec.split('..') : ['0', spec]
      const toN = (s: string) => (/^\d$/.test(s) ? Number(s) : priorityNumber(s))
      entries = entries.filter((e) => e.priority >= toN(lo) && e.priority <= toN(hi))
    }
    if (a.flags.has('k')) entries = entries.filter((e) => e.ident === 'kernel')
    if (a.values.has('since')) {
      const t = parseSince(a.values.get('since')!)
      if (t !== undefined) entries = entries.filter((e) => e.time >= t)
    }
    if (a.values.has('until')) {
      const t = parseSince(a.values.get('until')!)
      if (t !== undefined) entries = entries.filter((e) => e.time <= t)
    }
    entries.sort((x, y) => x.time - y.time)
    const n = a.values.has('n') ? Number(a.values.get('n')) : a.flags.has('e') ? 1000 : undefined
    if (n !== undefined) entries = entries.slice(-n)
    if (a.flags.has('r')) entries.reverse()
    if (!entries.length) {
      ctx.out('-- No entries --\n')
      return 0
    }
    if (a.values.get('o') === 'json') {
      for (const e of entries) ctx.out(JSON.stringify({ __REALTIME_TIMESTAMP: String(e.time * 1000), PRIORITY: String(e.priority), SYSLOG_IDENTIFIER: e.ident, _SYSTEMD_UNIT: e.unit, MESSAGE: e.message }) + '\n')
      return 0
    }
    for (const e of entries) {
      const line = `${journalTime(e.time)} ${ctx.sys.hostname} ${e.ident}[${e.pid ?? 1}]: ${e.message}`
      ctx.out((ctx.isTTY && e.priority <= 3 ? `\x1b[1;31m${line}\x1b[0m` : ctx.isTTY && e.priority === 4 ? `\x1b[1;33m${line}\x1b[0m` : line) + '\n')
    }
    if (a.flags.has('f')) ctx.err('[simulador] journalctl -f se queda mostrando líneas nuevas en vivo; aquí termina enseguida. En un servidor real se corta con Ctrl+C.\n')
    return 0
  },
})

register('logger', {
  usage: 'logger [options] [message]',
  run(ctx) {
    const a = parseArgs(ctx.args, { values: { t: ['t', 'tag'], p: ['p', 'priority'] } })
    const msg = a.rest.join(' ') || ctx.stdin.readAll().trim()
    const prio = a.values.get('p')?.split('.').pop() ?? 'notice'
    const ident = a.values.get('t') ?? ctx.sh.user
    ctx.sys.journal.push({ time: Date.now(), unit: 'user', priority: priorityNumber(prio), message: msg, ident })
    const file = ctx.sys.distro === 'rocky' ? '/var/log/messages' : '/var/log/syslog'
    ctx.sys.vfs.writeFile(file, `${journalTime(Date.now())} ${ctx.sys.hostname} ${ident}: ${msg}\n`, ROOT_CRED, { append: true })
    return 0
  },
})

register('ps', {
  usage: 'ps [options]',
  summary: '  ps aux | ps -ef | ps -u USER | ps -p PID | ps -eo pid,user,%cpu,%mem,cmd --sort=-%cpu',
  run(ctx) {
    const args = ctx.args.join(' ')
    let procs = [...ctx.sys.procs].sort((a, b) => a.pid - b.pid)
    const sort = /--sort=(-?)(%?\w+)/.exec(args)
    if (sort) {
      const key = sort[2].replace('%', '')
      procs.sort((a, b) => {
        const v = (p: typeof a) => (key === 'cpu' ? p.cpu : key === 'mem' ? p.mem : key === 'pid' ? p.pid : 0)
        return sort[1] ? v(b) - v(a) : v(a) - v(b)
      })
    }
    const userFilter = /-u\s+(\S+)/.exec(args)?.[1] ?? /-U\s+(\S+)/.exec(args)?.[1]
    if (userFilter) procs = procs.filter((p) => p.user === userFilter)
    const pidFilter = /-p\s+([\d,]+)/.exec(args)?.[1]
    if (pidFilter) procs = procs.filter((p) => pidFilter.split(',').includes(String(p.pid)))
    const cmdFilter = /-C\s+(\S+)/.exec(args)?.[1]
    if (cmdFilter) procs = procs.filter((p) => commOf(p) === cmdFilter)
    const time = (p: (typeof procs)[number]) => {
      const d = new Date(p.start)
      return Date.now() - p.start > 86_400_000 ? `${MONTHS[d.getMonth()]}${pad(d.getDate())}` : `${pad(d.getHours())}:${pad(d.getMinutes())}`
    }
    const custom = /-o\s+(\S+)/.exec(args)?.[1] ?? /-eo\s+(\S+)/.exec(args)?.[1]
    if (custom) {
      const cols = custom.split(',')
      const head: Record<string, string> = { pid: 'PID', ppid: 'PPID', user: 'USER', '%cpu': '%CPU', '%mem': '%MEM', cmd: 'CMD', comm: 'COMMAND', stat: 'STAT', args: 'COMMAND' }
      ctx.out(cols.map((c) => head[c] ?? c.toUpperCase()).join(' ') + '\n')
      for (const p of procs) {
        ctx.out(
          cols
            .map((c) =>
              c === 'pid' ? String(p.pid).padStart(5) : c === 'ppid' ? String(p.ppid).padStart(5) : c === 'user' ? p.user.padEnd(8) : c === '%cpu' ? p.cpu.toFixed(1).padStart(4) : c === '%mem' ? p.mem.toFixed(1).padStart(4) : c === 'stat' ? p.stat : c === 'comm' ? commOf(p) : p.cmd,
            )
            .join(' ') + '\n',
        )
      }
      return 0
    }
    if (/\b(a?ux|aux)\b/.test(args) || args.includes('-aux')) {
      ctx.out('USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND\n')
      for (const p of procs) {
        ctx.out(`${p.user.padEnd(10).slice(0, 10)} ${String(p.pid).padStart(5)} ${p.cpu.toFixed(1).padStart(4)} ${p.mem.toFixed(1).padStart(4)} ${String(Math.round(20000 + p.mem * 40000)).padStart(6)} ${String(Math.round(4000 + p.mem * 38000)).padStart(5)} ${p.cmd.startsWith('-bash') ? 'pts/0   ' : '?       '} ${p.stat.padEnd(4)} ${time(p).padEnd(5)}   0:${pad(Math.round(p.cpu / 10))} ${p.cmd}\n`)
      }
      return 0
    }
    if (args.includes('-e') || args.includes('-A') || args.includes('-f')) {
      ctx.out('UID          PID    PPID  C STIME TTY          TIME CMD\n')
      for (const p of procs) ctx.out(`${p.user.padEnd(8)} ${String(p.pid).padStart(7)} ${String(p.ppid).padStart(7)}  ${Math.round(p.cpu)} ${time(p).padEnd(5)} ${p.cmd.startsWith('-bash') ? 'pts/0   ' : '?       '}     00:00:0${Math.min(9, Math.round(p.cpu / 10))} ${p.cmd}\n`)
      return 0
    }
    if (userFilter || pidFilter || cmdFilter) {
      ctx.out('    PID TTY          TIME CMD\n')
      for (const p of procs) ctx.out(`${String(p.pid).padStart(7)} ${p.cmd === '-bash' ? 'pts/0   ' : '?       '} 00:00:${pad(Math.min(59, Math.round(p.cpu / 10)))} ${commOf(p)}\n`)
      return procs.length ? 0 : 1
    }
    const shellProc = ctx.sys.procs.find((p) => p.cmd === '-bash' && p.user === ctx.sh.user) ?? ctx.sys.procs.find((p) => p.cmd === '-bash')
    ctx.out(`    PID TTY          TIME CMD\n${String(shellProc?.pid ?? 1300).padStart(7)} pts/0    00:00:00 bash\n${String((shellProc?.pid ?? 1300) + 57).padStart(7)} pts/0    00:00:00 ps\n`)
    return 0
  },
})

const SIGNALS: Record<string, number> = { HUP: 1, INT: 2, QUIT: 3, KILL: 9, TERM: 15, STOP: 19, CONT: 18, USR1: 10, USR2: 12 }

function killProcs(ctx: CommandContext, targets: number[], signal: number): number {
  let code = 0
  for (const pid of targets) {
    const p = ctx.sys.procs.find((x) => x.pid === pid)
    if (!p) {
      ctx.err(`bash: kill: (${pid}) - No such process\n`)
      code = 1
      continue
    }
    if (ctx.sh.user !== 'root' && p.user !== ctx.sh.user) {
      ctx.err(`bash: kill: (${pid}) - Operation not permitted\n`)
      code = 1
      continue
    }
    if (pid === 1) continue
    if (signal === 18) {
      if (p.stat.startsWith('T')) p.stat = p.cpu > 50 ? 'R' : 'S'
      continue
    }
    if (signal === 1 || signal === 10 || signal === 12) continue
    if (signal === 19) {
      p.stat = 'T'
      continue
    }
    ctx.sys.procs = ctx.sys.procs.filter((x) => x.pid !== pid)
    for (const svc of ctx.sys.services.values()) {
      if (svc.pid === pid) {
        svc.active = false
        svc.failed = signal === 9
        svc.pid = undefined
        ctx.sys.journal.push({ time: Date.now(), unit: `${svc.name}.service`, priority: signal === 9 ? 4 : 6, message: `${svc.name}.service: Main process exited, code=killed, status=${signal}/${Object.keys(SIGNALS).find((k) => SIGNALS[k] === signal)}`, ident: 'systemd', pid: 1 })
      }
    }
  }
  return code
}

function parseSignal(arg: string): number | undefined {
  const s = arg.replace(/^-/, '').replace(/^SIG/, '')
  if (/^\d+$/.test(s)) return Number(s)
  return SIGNALS[s.toUpperCase()]
}

register('kill', {
  usage: 'kill [-s SIGNAL | -SIGNAL] PID...',
  summary: '  -l  list signal names\n  -9 / -KILL  force\n  -15 / -TERM  terminate (default)\n  -1 / -HUP  reload',
  run(ctx) {
    const args = [...ctx.args]
    if (args[0] === '-l' || args[0] === '-L') {
      ctx.out(' 1) SIGHUP\t 2) SIGINT\t 3) SIGQUIT\t 9) SIGKILL\t10) SIGUSR1\n12) SIGUSR2\t15) SIGTERM\t18) SIGCONT\t19) SIGSTOP\n')
      return 0
    }
    let signal = 15
    if (args[0] === '-s') {
      args.shift()
      signal = parseSignal(args.shift() ?? 'TERM') ?? 15
    } else if (args[0]?.startsWith('-')) signal = parseSignal(args.shift()!) ?? 15
    if (!args.length) {
      ctx.err('kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]\n')
      return 2
    }
    return killProcs(ctx, args.map(Number), signal)
  },
})

register(['pkill', 'killall'], {
  usage: 'pkill [-SIGNAL] PATTERN',
  run(ctx) {
    // pkill compara con el nombre del proceso; con -f, con la línea de comandos completa.
    const full = ctx.name === 'pkill' && ctx.args.includes('-f')
    const args = ctx.args.filter((x) => !(full && x === '-f'))
    let signal = 15
    if (args[0]?.startsWith('-')) signal = parseSignal(args.shift()!) ?? 15
    const pattern = args[0]
    if (!pattern) {
      ctx.err(`${ctx.name}: no process selection criteria\n`)
      return 2
    }
    let re: RegExp
    try {
      re = new RegExp(pattern)
    } catch {
      ctx.err(`${ctx.name}: invalid pattern\n`)
      return 2
    }
    const pids = ctx.sys.procs.filter((p) => (ctx.name === 'killall' ? commOf(p) === pattern : re.test(full ? p.cmd : commOf(p)))).map((p) => p.pid)
    if (!pids.length) {
      if (ctx.name === 'killall') ctx.err(`${pattern}: no process found\n`)
      return 1
    }
    return killProcs(ctx, pids, signal)
  },
})

register('pgrep', {
  usage: 'pgrep [-l] [-u USER] PATTERN',
  run(ctx) {
    const a = parseArgs(ctx.args, { flags: { l: ['l', 'list-name'], a: ['a', 'list-full'] }, values: { u: ['u'] } })
    const pattern = a.rest[0] ?? ''
    const re = new RegExp(pattern)
    const found = [...ctx.sys.procs].sort((x, y) => x.pid - y.pid).filter((p) => re.test(commOf(p)) && (!a.values.has('u') || p.user === a.values.get('u')))
    for (const p of found) ctx.out(`${p.pid}${a.flags.has('l') ? ' ' + commOf(p) : a.flags.has('a') ? ' ' + p.cmd : ''}\n`)
    return found.length ? 0 : 1
  },
})

function loadAvg(ctx: CommandContext) {
  const busy = ctx.sys.procs.reduce((s, p) => s + p.cpu, 0) / 100
  return [0.08 + busy, 0.12 + busy * 0.8, 0.09 + busy * 0.5].map((x) => x.toFixed(2))
}

function uptimeText(ctx: CommandContext) {
  const mins = Math.floor((Date.now() - ctx.sys.bootTime) / 60_000)
  const days = Math.floor(mins / 1440)
  const hh = Math.floor((mins % 1440) / 60)
  const mm = mins % 60
  return ` ${new Date().toTimeString().slice(0, 8)} up ${days} days, ${String(hh).padStart(2)}:${pad(mm)},  1 user,  load average: ${loadAvg(ctx).join(', ')}`
}

register('uptime', {
  usage: 'uptime [-p]',
  run(ctx) {
    if (ctx.args.includes('-p')) {
      const mins = Math.floor((Date.now() - ctx.sys.bootTime) / 60_000)
      ctx.out(`up ${Math.floor(mins / 1440)} days, ${Math.floor((mins % 1440) / 60)} hours, ${mins % 60} minutes\n`)
    } else ctx.out(uptimeText(ctx) + '\n')
    return 0
  },
})

register(['top', 'htop'], {
  usage: 'top [-b] [-n ITERATIONS]',
  run(ctx) {
    const procs = [...ctx.sys.procs].sort((a, b) => b.cpu - a.cpu || a.pid - b.pid)
    const cpuUsed = Math.min(100, procs.reduce((s, p) => s + p.cpu, 0) / 2)
    ctx.out(
      `top - ${uptimeText(ctx).trim().replace(/^\S+ /, '')}\nTasks: ${procs.length} total,   ${procs.filter((p) => p.stat.startsWith('R')).length} running, ${procs.filter((p) => !p.stat.startsWith('R')).length} sleeping,   0 stopped,   0 zombie\n%Cpu(s): ${cpuUsed.toFixed(1)} us,  0.5 sy,  0.0 ni, ${(99.5 - cpuUsed).toFixed(1)} id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st\nMiB Mem :   3753.5 total,   1484.7 free,    985.2 used,   1349.1 buff/cache\nMiB Swap:   2048.0 total,   2048.0 free,      0.0 used.   2723.1 avail Mem\n\n    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND\n`,
    )
    for (const p of procs.slice(0, 15)) {
      ctx.out(`${String(p.pid).padStart(7)} ${p.user.padEnd(9).slice(0, 9)} 20   0 ${String(Math.round(20000 + p.mem * 40000)).padStart(7)} ${String(Math.round(4000 + p.mem * 38000)).padStart(6)}   2816 ${p.stat[0]} ${p.cpu.toFixed(1).padStart(5)} ${p.mem.toFixed(1).padStart(5)}   0:0${Math.min(9, Math.round(p.cpu / 10))}.12 ${commOf(p)}\n`)
    }
    if (ctx.isTTY && !ctx.args.includes('-b')) ctx.err(`[simulador] ${ctx.name} se actualiza en vivo y se sale con q; aquí se muestra una sola captura.\n`)
    return 0
  },
})

register('free', {
  usage: 'free [-h|-m|-g]',
  run(ctx) {
    const h = ctx.args.includes('-h')
    const m = ctx.args.includes('-m')
    const g = ctx.args.includes('-g')
    // Valores en KiB, como los informa el kernel en /proc/meminfo.
    const human = (kb: number) => {
      if (kb === 0) return '0B'
      const units = ['Ki', 'Mi', 'Gi', 'Ti']
      let v = kb
      let u = 0
      while (v >= 1024 && u < units.length - 1) {
        v /= 1024
        u++
      }
      return `${v < 10 ? v.toFixed(1) : Math.round(v)}${units[u]}`
    }
    const row = (kb: number) => (h ? human(kb) : m ? String(Math.round(kb / 1024)) : g ? String(Math.round(kb / 1048576)) : String(kb))
    const mem = [3843580, 1008840, 1520332, 9620, 1314408, 2788416]
    const cols = ['total', 'used', 'free', 'shared', 'buff/cache', 'available']
    ctx.out(`${''.padEnd(8)}${cols.map((c) => c.padStart(12)).join('')}\n`)
    ctx.out(`${'Mem:'.padEnd(8)}${mem.map((v) => row(v).padStart(12)).join('')}\n`)
    ctx.out(`${'Swap:'.padEnd(8)}${[2097148, 0, 2097148].map((v) => row(v).padStart(12)).join('')}\n`)
    return 0
  },
})

register('uname', {
  usage: 'uname [-a|-r|-n|-m|-s|-o]',
  run(ctx) {
    const kernel = ctx.sys.distro === 'rocky' ? '6.12.0-55.el10.x86_64' : '6.8.0-58-generic'
    const version = ctx.sys.distro === 'rocky' ? '#1 SMP PREEMPT_DYNAMIC Fri Jun 20 12:00:00 UTC 2025' : '#60-Ubuntu SMP PREEMPT_DYNAMIC Fri Mar 14 18:29:48 UTC 2025'
    const f = ctx.args.join('')
    if (!f || f === '-s') ctx.out('Linux\n')
    else if (f.includes('a')) ctx.out(`Linux ${ctx.sys.hostname} ${kernel} ${version} x86_64 x86_64 x86_64 GNU/Linux\n`)
    else {
      const parts: string[] = []
      if (f.includes('s')) parts.push('Linux')
      if (f.includes('n')) parts.push(ctx.sys.hostname)
      if (f.includes('r')) parts.push(kernel)
      if (f.includes('v')) parts.push(version)
      if (f.includes('m')) parts.push('x86_64')
      if (f.includes('o')) parts.push('GNU/Linux')
      ctx.out(parts.join(' ') + '\n')
    }
    return 0
  },
})

register('hostname', {
  usage: 'hostname [-I] [NAME]',
  run(ctx) {
    if (ctx.args[0] === '-I' || ctx.args[0] === '-i') {
      ctx.out(ctx.sys.ownIps().slice(1).join(' ') + ' \n')
      return 0
    }
    if (ctx.args[0]) {
      if (ctx.sh.user !== 'root') {
        ctx.err('hostname: you must be root to change the host name\n')
        return 1
      }
      ctx.sys.hostname = ctx.args[0]
      return 0
    }
    ctx.out(ctx.sys.hostname + '\n')
    return 0
  },
})

register('hostnamectl', {
  usage: 'hostnamectl [set-hostname NAME]',
  run(ctx) {
    if (ctx.args[0] === 'set-hostname' || ctx.args[0] === 'hostname') {
      if (!ctx.args[1]) {
        ctx.out(ctx.sys.hostname + '\n')
        return 0
      }
      if (ctx.sh.user !== 'root') {
        ctx.err('Could not set static hostname: Access denied\n')
        return 1
      }
      ctx.sys.hostname = ctx.args[1]
      ctx.sys.vfs.writeFile('/etc/hostname', ctx.args[1] + '\n', ROOT_CRED)
      return 0
    }
    const os = /PRETTY_NAME="([^"]+)"/.exec(ctx.sys.vfs.readFile('/etc/os-release', ROOT_CRED))?.[1]
    ctx.out(
      ` Static hostname: ${ctx.sys.hostname}\n       Icon name: computer-vm\n         Chassis: vm 🖴\n      Machine ID: 4b0c2f1e9a7d4c55b1e2f30a8d6c7e91\n  Virtualization: kvm\nOperating System: ${os}\n          Kernel: Linux ${ctx.sys.distro === 'rocky' ? '6.12.0-55.el10.x86_64' : '6.8.0-58-generic'}\n    Architecture: x86-64\n`,
    )
    return 0
  },
})

function strftime(fmt: string, d: Date): string {
  const map: Record<string, string> = {
    Y: String(d.getFullYear()),
    m: pad(d.getMonth() + 1),
    d: pad(d.getDate()),
    H: pad(d.getHours()),
    M: pad(d.getMinutes()),
    S: pad(d.getSeconds()),
    F: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    T: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    A: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()],
    a: DAYS[d.getDay()],
    B: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d.getMonth()],
    b: MONTHS[d.getMonth()],
    s: String(Math.floor(d.getTime() / 1000)),
    Z: 'UTC',
    z: '+0000',
    j: pad(Math.floor((d.getTime() - new Date(d.getFullYear(), 0, 0).getTime()) / 86_400_000), 3),
    u: String(d.getDay() || 7),
    n: '\n',
    '%': '%',
  }
  return fmt.replace(/%([YmdHMSFTAaBbsZzjun%])/g, (_, k: string) => map[k])
}

register('date', {
  usage: 'date [+FORMAT]',
  run(ctx) {
    const d = new Date()
    const fmt = ctx.args.find((a) => a.startsWith('+'))
    if (fmt) ctx.out(strftime(fmt.slice(1), d) + '\n')
    else ctx.out(strftime('%a %b %d %T %Z %Y', d).replace(/ 0(\d) /, '  $1 ') + '\n')
    return 0
  },
})

register('timedatectl', {
  usage: 'timedatectl [status | set-timezone ZONE | list-timezones | set-ntp BOOL]',
  run(ctx) {
    const tzFile = '/etc/timezone-simulado'
    const tz = ctx.sys.vfs.exists(tzFile) ? ctx.sys.vfs.readFile(tzFile, ROOT_CRED).trim() : 'UTC'
    const [verb, arg] = ctx.args
    if (verb === 'set-timezone') {
      if (ctx.sh.user !== 'root') {
        ctx.err('Failed to set time zone: Access denied\n')
        return 1
      }
      if (!arg || !/^[A-Z][A-Za-z_]+(\/[A-Za-z_]+)*$|^UTC$/.test(arg)) {
        ctx.err(`Failed to set time zone: Invalid or not installed time zone '${arg ?? ''}'\n`)
        return 1
      }
      ctx.sys.vfs.writeFile(tzFile, arg + '\n', ROOT_CRED)
      return 0
    }
    if (verb === 'list-timezones') {
      ctx.out(['America/Argentina/Buenos_Aires', 'America/Bogota', 'America/Lima', 'America/Mexico_City', 'America/Montevideo', 'America/Santiago', 'Europe/Madrid', 'UTC'].join('\n') + '\n')
      return 0
    }
    if (verb === 'set-ntp') return ctx.sh.user === 'root' ? 0 : 1
    const d = new Date()
    const ntp = ctx.sys.services.get(ctx.sys.distro === 'rocky' ? 'chronyd' : 'chrony')?.active
    ctx.out(
      `               Local time: ${strftime('%a %F %T', d)} ${tz === 'UTC' ? 'UTC' : tz.split('/').pop()}\n           Universal time: ${strftime('%a %F %T', d)} UTC\n                 RTC time: ${strftime('%a %F %T', d)}\n                Time zone: ${tz} (${tz === 'UTC' ? 'UTC, +0000' : 'local'})\nSystem clock synchronized: ${ntp ? 'yes' : 'no'}\n              NTP service: ${ntp ? 'active' : 'inactive'}\n          RTC in local TZ: no\n`,
    )
    return 0
  },
})

register(['env', 'printenv'], {
  usage: 'printenv [VARIABLE]',
  run(ctx) {
    if (ctx.args[0] && !ctx.args[0].includes('=')) {
      const v = ctx.sh.vars.get(ctx.args[0])
      if (v === undefined || !ctx.sh.exported.has(ctx.args[0])) return 1
      ctx.out(v + '\n')
      return 0
    }
    for (const k of [...ctx.sh.exported].sort()) ctx.out(`${k}=${ctx.sh.vars.get(k) ?? ''}\n`)
    return 0
  },
})

register('which', {
  usage: 'which COMMAND...',
  run(ctx) {
    let code = 0
    for (const c of ctx.args) {
      const def = COMMANDS.get(c)
      const available = def && ctx.sys.isCommandAvailable(c, (x) => commandPackage(ctx.sys.distro, x))
      if (available) ctx.out(`${def.path ?? '/usr/bin'}/${c}\n`)
      else {
        if (ctx.sys.distro === 'rocky') ctx.err(`/usr/bin/which: no ${c} in (${ctx.sh.vars.get('PATH')})\n`)
        code = 1
      }
    }
    return code
  },
})

const MAN_DESC: Record<string, string> = {
  ls: 'list directory contents',
  cd: 'change the shell working directory',
  pwd: 'print name of current/working directory',
  mkdir: 'make directories',
  rmdir: 'remove empty directories',
  touch: 'change file timestamps',
  cp: 'copy files and directories',
  mv: 'move (rename) files',
  rm: 'remove files or directories',
  ln: 'make links between files',
  cat: 'concatenate files and print on the standard output',
  less: 'opposite of more',
  head: 'output the first part of files',
  tail: 'output the last part of files',
  find: 'search for files in a directory hierarchy',
  grep: 'print lines that match patterns',
  sort: 'sort lines of text files',
  uniq: 'report or omit repeated lines',
  wc: 'print newline, word, and byte counts for each file',
  cut: 'remove sections from each line of files',
  tr: 'translate or delete characters',
  sed: 'stream editor for filtering and transforming text',
  awk: 'pattern scanning and processing language',
  chmod: 'change file mode bits',
  chown: 'change file owner and group',
  chgrp: 'change group ownership',
  useradd: 'create a new user or update default new user information',
  usermod: 'modify a user account',
  userdel: 'delete a user account and related files',
  groupadd: 'create a new group',
  passwd: 'change user password',
  chage: 'change user password expiry information',
  sudo: 'execute a command as another user',
  su: 'run a command with substitute user and group ID',
  id: 'print real and effective user and group IDs',
  systemctl: 'Control the systemd system and service manager',
  journalctl: 'Print log entries from the systemd journal',
  ps: 'report a snapshot of the current processes',
  kill: 'send a signal to a process',
  top: 'display Linux processes',
  free: 'Display amount of free and used memory in the system',
  lscpu: 'display information about the CPU architecture',
  lsblk: 'list block devices',
  dmidecode: 'DMI table decoder',
  lspci: 'list all PCI devices',
  fdisk: 'manipulate disk partition table',
  efibootmgr: 'manipulate the UEFI Boot Manager',
  mokutil: 'utility to manipulate machine owner keys',
  df: 'report file system space usage',
  du: 'estimate file space usage',
  ip: 'show / manipulate routing, network devices, interfaces and tunnels',
  ping: 'send ICMP ECHO_REQUEST to network hosts',
  ss: 'another utility to investigate sockets',
  curl: 'transfer a URL',
  dnf: 'DNF, the next-generation replacement for YUM',
  apt: 'command-line interface',
  tar: 'an archiving utility',
  stat: 'display file or file system status',
  file: 'determine file type',
  echo: 'display a line of text',
  man: 'an interface to the system reference manuals',
  which: 'shows the full path of (shell) commands',
  date: 'print or set the system date and time',
  uname: 'print system information',
  hostnamectl: 'Control the system hostname',
  tee: 'read from standard input and write to standard output and files',
  crontab: 'maintains crontab files for individual users',
  'firewall-cmd': 'firewalld command line client',
  nano: 'Nano\'s ANOther editor, inspired by Pico',
  vim: 'Vi IMproved, a programmer\'s text editor',
  sha256sum: 'compute and check SHA256 message digest',
  diff: 'compare files line by line',
  history: 'GNU History Library',
  umask: 'set file mode creation mask',
  getfacl: 'get file access control lists',
  setfacl: 'set file access control lists',
}

register(['man', 'apropos'], {
  usage: 'man [-k KEYWORD] PAGE',
  run(ctx) {
    if (ctx.name === 'apropos' || ctx.args[0] === '-k') {
      const kw = (ctx.name === 'apropos' ? ctx.args[0] : ctx.args[1])?.toLowerCase()
      if (!kw) {
        ctx.err('apropos what?\n')
        return 1
      }
      const hits = Object.entries(MAN_DESC).filter(([k, v]) => k.includes(kw) || v.toLowerCase().includes(kw))
      if (!hits.length) {
        ctx.out(`${kw}: nothing appropriate.\n`)
        return 16
      }
      for (const [k, v] of hits.sort()) ctx.out(`${k.padEnd(16)} (1)  - ${v}\n`)
      return 0
    }
    const page = ctx.args.find((a) => !/^\d$/.test(a))
    if (!page) {
      ctx.err('What manual page do you want?\nFor example, try \'man man\'.\n')
      return 1
    }
    const def = COMMANDS.get(page)
    const builtin = page in BUILTINS
    if (!def && !builtin) {
      ctx.err(`No manual entry for ${page}\n`)
      return 16
    }
    const title = `${page.toUpperCase()}(1)`
    ctx.out(
      `${title.padEnd(30)}User Commands${title.padStart(30)}\n\nNAME\n       ${page} - ${MAN_DESC[page] ?? (builtin ? 'bash built-in command' : 'command')}\n\nSYNOPSIS\n       ${def?.usage ?? `${page} [arguments]`}\n\nDESCRIPTION\n${(def?.summary ?? '       See the online documentation for details.').split('\n').map((l) => '       ' + l.trim()).join('\n')}\n\n`,
    )
    if (ctx.isTTY) ctx.err('[simulador] Esta es una versión abreviada; en un servidor real man muestra el manual completo (se sale con q).\n')
    return 0
  },
})

register('help', {
  usage: 'help',
  run(ctx) {
    ctx.out(
      `GNU bash, version 5.2.26(1)-release (x86_64-redhat-linux-gnu)\nThese shell commands are defined internally.  Type \`help' to see this list.\n\n ${Object.keys(BUILTINS).sort().join('  ')}\n\n`,
    )
    ctx.err(`[simulador] Comandos disponibles en esta terminal:\n${[...COMMANDS.keys()].sort().join('  ')}\n`)
    return 0
  },
})

register('sleep', {
  usage: 'sleep NUMBER[SUFFIX]',
  run(ctx) {
    if (!ctx.args[0]) {
      ctx.err("sleep: missing operand\nTry 'sleep --help' for more information.\n")
      return 1
    }
    return 0
  },
})

register('nproc', { usage: 'nproc', run: (ctx) => (ctx.out('2\n'), 0) })

register('lscpu', {
  usage: 'lscpu',
  run(ctx) {
    ctx.out(
      `Architecture:             x86_64\n  CPU op-mode(s):         32-bit, 64-bit\n  Address sizes:          46 bits physical, 48 bits virtual\n  Byte Order:             Little Endian\nCPU(s):                   2\n  On-line CPU(s) list:    0,1\nVendor ID:                GenuineIntel\n  BIOS Vendor ID:         QEMU\n  Model name:             Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz\n    BIOS Model name:      pc-q35-9.0  CPU @ 2.0GHz\n    CPU family:           6\n    Model:                79\n    Thread(s) per core:   1\n    Core(s) per socket:   2\n    Socket(s):            1\n    Stepping:             1\n    BogoMIPS:             4799.99\n    Flags:                ${CPU_FLAGS}\nVirtualization features:  \n  Hypervisor vendor:      KVM\n  Virtualization type:    full\nCaches (sum of all):      \n  L1d:                    64 KiB (2 instances)\n  L1i:                    64 KiB (2 instances)\n  L2:                     512 KiB (2 instances)\n  L3:                     35 MiB (1 instance)\nNUMA:                     \n  NUMA node(s):           1\n  NUMA node0 CPU(s):      0,1\n`,
    )
    return 0
  },
})

const DMI: Record<string, string> = {
  bios: '',
  system:
    'Handle 0x0100, DMI type 1, 27 bytes\nSystem Information\n\tManufacturer: QEMU\n\tProduct Name: Standard PC (Q35 + ICH9, 2009)\n\tVersion: pc-q35-9.0\n\tSerial Number: Not Specified\n\tUUID: 4b0c2f1e-9a7d-4c55-b1e2-f30a8d6c7e91\n\tWake-up Type: Power Switch\n\tSKU Number: Not Specified\n\tFamily: Not Specified\n',
  processor:
    'Handle 0x0400, DMI type 4, 48 bytes\nProcessor Information\n\tSocket Designation: CPU 0\n\tType: Central Processor\n\tFamily: Other\n\tManufacturer: QEMU\n\tVersion: pc-q35-9.0\n\tMax Speed: 2000 MHz\n\tCurrent Speed: 2000 MHz\n\tStatus: Populated, Enabled\n\tCore Count: 2\n\tCore Enabled: 2\n\tThread Count: 1\n',
  memory:
    'Handle 0x1000, DMI type 16, 23 bytes\nPhysical Memory Array\n\tLocation: Other\n\tUse: System Memory\n\tError Correction Type: Multi-bit ECC\n\tMaximum Capacity: 4 GB\n\tNumber Of Devices: 1\n\nHandle 0x1100, DMI type 17, 40 bytes\nMemory Device\n\tArray Handle: 0x1000\n\tSize: 4 GB\n\tForm Factor: DIMM\n\tLocator: DIMM 0\n\tType: RAM\n\tSpeed: Unknown\n\tManufacturer: QEMU\n',
}
const DMI_TYPES: Record<string, string> = { '0': 'bios', '1': 'system', '4': 'processor', '16': 'memory', '17': 'memory' }

register('dmidecode', {
  usage: 'dmidecode [-t TYPE] [-s KEYWORD]',
  summary: '  -t bios | system | processor | memory   (o el número de tipo: 0, 1, 4, 17)\n  -s system-manufacturer | system-product-name | bios-version | bios-vendor',
  path: '/usr/sbin',
  run(ctx) {
    if (ctx.sh.user !== 'root') {
      ctx.err('/sys/firmware/dmi/tables/smbios_entry_point: Permission denied\nScanning /dev/mem for entry point.\n/dev/mem: Permission denied\n')
      return 1
    }
    const a = parseArgs(ctx.args, { values: { t: ['t', 'type'], s: ['s', 'string'] } })
    const s = a.values.get('s')
    if (s) {
      const uefi = ctx.sys.firmware === 'uefi'
      const keys: Record<string, string> = { 'system-manufacturer': 'QEMU', 'system-product-name': 'Standard PC (Q35 + ICH9, 2009)', 'bios-vendor': uefi ? 'EDK II' : 'SeaBIOS', 'bios-version': uefi ? 'edk2-stable202408-prebuilt.qemu.org' : '1.16.3-debian-1.16.3-2', 'system-uuid': '4b0c2f1e-9a7d-4c55-b1e2-f30a8d6c7e91' }
      if (!keys[s]) {
        ctx.err(`Invalid string keyword: ${s}\nValid string keywords are:\n  ${Object.keys(keys).join('\n  ')}\n`)
        return 1
      }
      ctx.out(keys[s] + '\n')
      return 0
    }
    const t = a.values.get('t')
    const header = '# dmidecode 3.6\nGetting SMBIOS data from sysfs.\nSMBIOS 2.8 present.\n\n'
    const dmi: Record<string, string> = { ...DMI, bios: dmiBiosText(ctx.sys.firmware) }
    if (!t) {
      ctx.out(header + Object.values(dmi).join('\n'))
      return 0
    }
    const key = dmi[t] ? t : DMI_TYPES[t]
    if (!key) {
      ctx.err(`Invalid type keyword: ${t}\nValid type keywords are:\n  bios\n  system\n  processor\n  memory\n`)
      return 1
    }
    ctx.out(header + dmi[key])
    return 0
  },
})

register('lspci', {
  usage: 'lspci',
  run(ctx) {
    ctx.out(
      '00:00.0 Host bridge: Intel Corporation 82G33/G31/P35/P31 Express DRAM Controller\n00:01.0 VGA compatible controller: Device 1234:1111 (rev 02)\n00:02.0 Ethernet controller: Red Hat, Inc. Virtio network device\n00:03.0 SCSI storage controller: Red Hat, Inc. Virtio SCSI\n00:1f.0 ISA bridge: Intel Corporation 82801IB (ICH9) LPC Interface Controller (rev 02)\n00:1f.2 SATA controller: Intel Corporation 82801IR/IO/IH (ICH9R/DO/DH) 6 port SATA Controller [AHCI mode] (rev 02)\n00:1f.3 SMBus: Intel Corporation 82801I (ICH9 Family) SMBus Controller (rev 02)\n',
    )
    return 0
  },
})

register('df', {
  usage: 'df [OPTION]... [FILE]...',
  summary: '  -h, --human-readable (potencias de 1024)  -H, --si (potencias de 1000)  -T, --print-type',
  run(ctx) {
    const si = ctx.args.some((a) => /^-\w*H/.test(a) || a === '--si')
    const h = si || ctx.args.some((a) => /^-\w*h/.test(a) || a === '--human-readable')
    const T = ctx.args.some((a) => /^-\w*T/.test(a))
    const root = ctx.sys.distro === 'rocky' ? '/dev/mapper/rl-root' : '/dev/mapper/ubuntu--vg-ubuntu--lv'
    const fsType = ctx.sys.distro === 'rocky' ? 'xfs' : 'ext4'
    const rows = [
      [root, fsType, 17_811_456, 4_712_840, '/'],
      ...(ctx.sys.firmware === 'uefi' ? ([['/dev/sda1', 'vfat', 613_160, 7_256, '/boot/efi']] as const) : []),
      [ctx.sys.firmware === 'uefi' ? '/dev/sda2' : ctx.sys.distro === 'rocky' ? '/dev/sda1' : '/dev/sda2', ctx.sys.distro === 'rocky' ? 'xfs' : 'ext4', 983_040, 296_960, '/boot'],
      ['tmpfs', 'tmpfs', 1_921_788, 0, '/dev/shm'],
      ['tmpfs', 'tmpfs', 768_716, 8_840, '/run'],
    ] as const
    // Como coreutils: redondea hacia arriba, con un decimal por debajo de 10.
    const human = (v: number, suffix: string) => `${v < 10 ? (Math.ceil(v * 10) / 10).toFixed(1) : Math.ceil(v)}${suffix}`
    const fmt = (kb: number) => {
      if (!h) return String(kb)
      if (kb === 0) return '0'
      const base = si ? 1000 : 1024
      const bytes = kb * 1024
      return bytes >= base ** 3 ? human(bytes / base ** 3, 'G') : human(bytes / base ** 2, 'M')
    }
    ctx.out(`${'Filesystem'.padEnd(36)}${T ? 'Type   ' : ''}${(h ? 'Size' : '1K-blocks').padStart(10)}${'Used'.padStart(10)}${'Avail'.padStart(10)} Use% Mounted on\n`)
    for (const [dev, type, size, used, mount] of rows) {
      ctx.out(`${dev.padEnd(36)}${T ? type.padEnd(7) : ''}${fmt(size).padStart(10)}${fmt(used).padStart(10)}${fmt(size - used).padStart(10)} ${String(Math.ceil((used / size) * 100)).padStart(3)}% ${mount}\n`)
    }
    return 0
  },
})

register('lsblk', {
  usage: 'lsblk',
  run(ctx) {
    ctx.out(lsblkText(ctx.sys.distro, ctx.sys.firmware))
    return 0
  },
})

register('fdisk', {
  usage: 'fdisk -l [DEVICE]',
  summary: '  -l, --list  muestra las tablas de particiones',
  path: '/usr/sbin',
  run(ctx) {
    if (!ctx.args.some((a) => a === '-l' || a === '--list')) {
      ctx.err('[simulador] En este simulador fdisk solo lista las particiones: usa fdisk -l. Modificar particiones se practica en el nivel de Linux.\n')
      return 1
    }
    if (ctx.sh.user !== 'root') {
      ctx.err('fdisk: cannot open /dev/sda: Permission denied\n')
      return 1
    }
    const dev = ctx.args.find((a) => a.startsWith('/dev/'))
    if (dev && dev !== '/dev/sda') {
      ctx.err(`fdisk: cannot open ${dev}: No such file or directory\n`)
      return 1
    }
    ctx.out(fdiskText(ctx.sys.distro, ctx.sys.firmware))
    return 0
  },
})

register('efibootmgr', {
  usage: 'efibootmgr [-v]',
  summary: '  -v  muestra la ruta de cada entrada de arranque',
  path: '/usr/sbin',
  run(ctx) {
    if (ctx.sys.firmware !== 'uefi') {
      ctx.err('EFI variables are not supported on this system.\n')
      return 2
    }
    ctx.out(efibootmgrText(ctx.sys.distro, ctx.args.some((a) => /^-\w*v/.test(a))))
    return 0
  },
})

register('mokutil', {
  usage: 'mokutil --sb-state',
  run(ctx) {
    if (!ctx.args.includes('--sb-state')) {
      ctx.err('[simulador] Solo está disponible mokutil --sb-state.\n')
      return 1
    }
    if (ctx.sys.firmware !== 'uefi') {
      ctx.err('EFI variables are not supported on this system\n')
      return 1
    }
    ctx.out(ctx.sys.secureBoot ? 'SecureBoot enabled\n' : 'SecureBoot disabled\n')
    return 0
  },
})

register('dmesg', {
  usage: 'dmesg',
  run(ctx) {
    if (ctx.sh.user !== 'root') {
      ctx.err('dmesg: read kernel buffer failed: Operation not permitted\n')
      return 1
    }
    ctx.out('[    0.000000] Linux version ' + (ctx.sys.distro === 'rocky' ? '6.12.0-55.el10.x86_64' : '6.8.0-58-generic') + '\n[    0.000000] Command line: BOOT_IMAGE=(hd0,msdos1)/vmlinuz root=/dev/mapper/rl-root ro\n[    1.204331] sd 0:0:0:0: [sda] 41943040 512-byte logical blocks: (21.5 GB/20.0 GiB)\n[    2.581092] XFS (dm-0): Mounting V5 Filesystem\n[    3.912577] e1000: enp0s3 NIC Link is Up 1000 Mbps Full Duplex, Flow Control: RX\n')
    for (const j of ctx.sys.journal.filter((e) => e.ident === 'kernel')) ctx.out(`[${((j.time - ctx.sys.bootTime) / 1000).toFixed(6).padStart(12)}] ${j.message}\n`)
    return 0
  },
})

register(['reboot', 'shutdown', 'poweroff', 'halt'], {
  usage: 'shutdown [OPTIONS...] [TIME] [WALL...]',
  path: '/usr/sbin',
  run(ctx) {
    if (ctx.sh.user !== 'root') {
      ctx.err('Call to Reboot failed: Access denied\n')
      return 1
    }
    ctx.err('[simulador] El servidor no se reinicia ni se apaga en el simulador. En producción, antes de hacerlo hay que avisar y tener una ventana de mantenimiento.\n')
    return 0
  },
})

register('crontab', {
  usage: 'crontab [-u user] [-l | -e | -r]',
  summary: '  -l  list  -e  edit  -r  remove\n  Formato: minuto hora día-del-mes mes día-de-la-semana comando',
  run(ctx) {
    const a = parseArgs(ctx.args, { flags: { l: ['l'], e: ['e'], r: ['r'] }, values: { u: ['u'] } })
    const user = a.values.get('u') ?? ctx.sh.user
    if (user !== ctx.sh.user && ctx.sh.user !== 'root') {
      ctx.err('must be privileged to use -u\n')
      return 1
    }
    const dir = ctx.sys.distro === 'rocky' ? '/var/spool/cron' : '/var/spool/cron/crontabs'
    ctx.sys.vfs.mkdirp(dir, ROOT_CRED)
    const file = `${dir}/${user}`
    if (a.flags.has('l')) {
      if (!ctx.sys.vfs.exists(file)) {
        ctx.err(`no crontab for ${user}\n`)
        return 1
      }
      ctx.out(ctx.sys.vfs.readFile(file, ROOT_CRED))
      return 0
    }
    if (a.flags.has('r')) {
      if (ctx.sys.vfs.exists(file)) ctx.sys.vfs.unlink(file, ROOT_CRED)
      return 0
    }
    if (a.flags.has('e')) {
      ctx.sh.pendingEditor = { path: file, content: ctx.sys.vfs.exists(file) ? ctx.sys.vfs.readFile(file, ROOT_CRED) : '', editor: 'crontab' }
      return 0
    }
    // crontab ARCHIVO o desde la entrada estándar
    const src = a.rest[0]
    const data = src && src !== '-' ? ctx.sys.vfs.readFile(ctx.sh.resolve(src), ctx.sh.cred) : ctx.stdin.readAll()
    ctx.sys.vfs.writeFile(file, data, ROOT_CRED)
    return 0
  },
})

// printf también como comando externo
register('printf', { usage: 'printf FORMAT [ARGUMENT]...', run: (ctx) => (ctx.out(formatPrintf(ctx.args[0] ?? '', ctx.args.slice(1))), 0) })
register('echo', { usage: 'echo [-neE] [STRING]...', run: (ctx) => BUILTINS.echo(ctx.sh, ctx.args, { stdin: ctx.stdin, out: ctx.out, err: ctx.err, isTTY: ctx.isTTY }) })
register('pwd', { usage: 'pwd', run: (ctx) => (ctx.out(ctx.sh.cwd + '\n'), 0) })
register('clear', { usage: 'clear', run: (ctx) => ((ctx.sh.pendingClear = true), 0) })
register(['true'], { usage: 'true', run: () => 0 })
register(['false'], { usage: 'false', run: () => 1 })

export { priorityName }
