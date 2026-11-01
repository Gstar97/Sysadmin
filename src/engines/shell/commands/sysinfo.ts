import { parseArgs } from '../args'
import { checkCrontab } from '../editor'
import { BUILTINS, COMMANDS, formatPrintf, jobFor, register, type CommandContext } from '../shell'
import { commOf, priorityName, priorityNumber, type JournalEntry } from '../system'
import { ROOT_CRED } from '../vfs'
import { commandPackage } from '../packages'
import { CPU_FLAGS, dmiBiosText, efibootmgrText } from '../hardware'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number, w = 2) => String(n).padStart(w, '0')

function journalTime(ms: number): string {
  const d = new Date(ms)
  return `${MONTHS[d.getMonth()]} ${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Comprobaciones extra al arrancar un servicio (por ejemplo, validar la configuración de nginx). */
export const SERVICE_CHECKS: Record<string, (ctx: CommandContext) => string | undefined> = {}

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

/** PID estable para las entradas del journal que no lo guardaron. */
export function entryPid(e: JournalEntry): number {
  if (e.pid !== undefined) return e.pid
  if (e.ident === 'systemd') return 1
  let h = 0
  for (const c of e.ident + Math.floor(e.time / 1000)) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return 900 + (h % 4000)
}

const CATALOG_FAILED = (unit: string) =>
  `░░ Subject: A start job for unit ${unit} has failed\n░░ Defined-By: systemd\n░░ Support: https://wiki.rockylinux.org/\n░░ \n░░ A start job for unit ${unit} has finished with a failure.\n░░ \n░░ The job identifier is 1873 and the job result is failed.`

register('journalctl', {
  usage: 'journalctl [OPTIONS...] [MATCHES...]',
  summary:
    '  -u UNIT  -p PRIORITY  -n LINES  -f  -b [-1]  -r  -e  -x  -k  -g PATTERN  --since TIME  --until TIME\n  -o short|short-iso|cat|json|verbose  --disk-usage  --vacuum-size=SIZE  --vacuum-time=TIME  --list-boots  --no-pager',
  run(ctx) {
    const a = parseArgs(ctx.args, {
      flags: {
        f: ['f', 'follow'], b: ['b', 'boot'], r: ['r', 'reverse'], e: ['e', 'pager-end'], x: ['x', 'catalog'], k: ['k', 'dmesg'], nopager: ['no-pager'], q: ['q', 'quiet'],
        disk: ['disk-usage'], boots: ['list-boots'], utc: ['utc'], nohost: ['no-hostname'],
      },
      values: { u: ['u', 'unit'], p: ['p', 'priority'], n: ['n', 'lines'], since: ['S', 'since'], until: ['U', 'until'], o: ['o', 'output'], t: ['t', 'identifier'], g: ['g', 'grep'], vsize: ['vacuum-size'], vtime: ['vacuum-time'] },
    })
    const user = ctx.sh.user
    const privileged = user === 'root' || ctx.sys.groupsOf(user).some((g) => ['wheel', 'adm', 'systemd-journal'].includes(g))
    if (a.flags.has('disk')) {
      ctx.out(`Archived and active journals take up ${privileged ? '24.0M' : '8.0M'} in the file system.\n`)
      return 0
    }
    if (a.values.has('vsize') || a.values.has('vtime')) {
      if (user !== 'root') {
        ctx.err('Failed to vacuum: Permission denied\n')
        return 1
      }
      ctx.out(`Vacuuming done, freed 0B of archived journals from /var/log/journal/4b0c2f1e9a7d4c55b1e2f30a8d6c7e91.\nVacuuming done, freed 0B of archived journals from /var/log/journal.\n`)
      return 0
    }
    if (a.flags.has('boots')) {
      ctx.out(`IDX BOOT ID                          FIRST ENTRY                 LAST ENTRY\n  0 8c1f2a7e4b6d4e0f9a3b5c7d1e2f3a4b ${new Date(ctx.sys.bootTime).toISOString().replace('T', ' ').slice(0, 19)} UTC ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC\n`)
      return 0
    }
    if (!privileged) {
      ctx.out('Hint: You are currently not seeing messages from other users and the system.\n      Users in groups \'adm\', \'systemd-journal\', \'wheel\' can see all messages.\n      Pass -q to turn off this notice.\n-- No entries --\n')
      return 0
    }
    // "-b -1": un arranque anterior. El simulador solo tiene el arranque actual.
    const bIdx = ctx.args.findIndex((x) => x === '-b' || x === '--boot')
    if (bIdx >= 0 && /^-\d+$/.test(ctx.args[bIdx + 1] ?? '')) {
      ctx.err(`Data from the specified boot (${ctx.args[bIdx + 1]}) is not available: No such boot ID in journal\n`)
      return 1
    }
    let entries: JournalEntry[] = [...ctx.sys.journal]
    const unitsWanted = (a.all.get('u') ?? []).map((u) => (/\.(service|timer|target|scope)$/.test(u) ? u : `${u}.service`))
    // Coincidencias del estilo _SYSTEMD_UNIT=nginx.service o SYSLOG_IDENTIFIER=sudo.
    for (const m of a.rest) {
      const kv = /^(_SYSTEMD_UNIT|SYSLOG_IDENTIFIER|_COMM|PRIORITY)=(.+)$/.exec(m)
      if (!kv) continue
      if (kv[1] === '_SYSTEMD_UNIT') unitsWanted.push(/\./.test(kv[2]) ? kv[2] : `${kv[2]}.service`)
      if (kv[1] === 'SYSLOG_IDENTIFIER' || kv[1] === '_COMM') entries = entries.filter((e) => e.ident === kv[2])
      if (kv[1] === 'PRIORITY') entries = entries.filter((e) => e.priority === Number(kv[2]))
    }
    if (unitsWanted.length) {
      const norm = (u: string) => (/\./.test(u) ? u : `${u}.service`)
      entries = entries.filter((e) => unitsWanted.includes(norm(e.unit)))
    }
    if (a.values.has('t')) entries = entries.filter((e) => e.ident === a.values.get('t'))
    if (a.values.has('p')) {
      const spec = a.values.get('p')!
      const [lo, hi] = spec.includes('..') ? spec.split('..') : ['0', spec]
      const toN = (s: string) => (/^\d$/.test(s) ? Number(s) : priorityNumber(s))
      entries = entries.filter((e) => e.priority >= toN(lo) && e.priority <= toN(hi))
    }
    if (a.values.has('g')) {
      const pat = a.values.get('g')!
      let re: RegExp
      try {
        // Como journalctl: sin mayúsculas en el patrón, no distingue mayúsculas de minúsculas.
        re = new RegExp(pat, pat === pat.toLowerCase() ? 'i' : '')
      } catch {
        ctx.err(`Failed to compile pattern "${pat}"\n`)
        return 1
      }
      entries = entries.filter((e) => re.test(e.message))
    }
    if (a.flags.has('k')) entries = entries.filter((e) => e.ident === 'kernel')
    if (a.values.has('since')) {
      const t = parseSince(a.values.get('since')!)
      if (t === undefined) {
        ctx.err(`Failed to parse timestamp: ${a.values.get('since')}\n`)
        return 1
      }
      entries = entries.filter((e) => e.time >= t)
    }
    if (a.values.has('until')) {
      const t = parseSince(a.values.get('until')!)
      if (t === undefined) {
        ctx.err(`Failed to parse timestamp: ${a.values.get('until')}\n`)
        return 1
      }
      entries = entries.filter((e) => e.time <= t)
    }
    entries.sort((x, y) => x.time - y.time)
    const n = a.values.has('n') ? Number(a.values.get('n')) : a.flags.has('e') ? 1000 : a.flags.has('f') ? 10 : undefined
    if (n !== undefined) entries = entries.slice(-n)
    if (a.flags.has('r')) entries.reverse()
    if (!entries.length) {
      ctx.out('-- No entries --\n')
      return 0
    }
    const fmt = a.values.get('o') ?? 'short'
    const host = a.flags.has('nohost') ? '' : ` ${ctx.sys.hostname}`
    for (const e of entries) {
      const pid = entryPid(e)
      if (fmt === 'json') {
        ctx.out(JSON.stringify({ __REALTIME_TIMESTAMP: String(e.time * 1000), PRIORITY: String(e.priority), SYSLOG_IDENTIFIER: e.ident, _PID: String(pid), _SYSTEMD_UNIT: e.unit, _HOSTNAME: ctx.sys.hostname, MESSAGE: e.message }) + '\n')
        continue
      }
      if (fmt === 'json-pretty' || fmt === 'verbose') {
        const d = new Date(e.time)
        ctx.out(
          fmt === 'verbose'
            ? `${d.toISOString().replace('T', ' ').replace('Z', '')} UTC\n    PRIORITY=${e.priority}\n    SYSLOG_IDENTIFIER=${e.ident}\n    _PID=${pid}\n    _SYSTEMD_UNIT=${e.unit}\n    _HOSTNAME=${ctx.sys.hostname}\n    MESSAGE=${e.message}\n`
            : JSON.stringify({ __REALTIME_TIMESTAMP: String(e.time * 1000), PRIORITY: String(e.priority), SYSLOG_IDENTIFIER: e.ident, _PID: String(pid), _SYSTEMD_UNIT: e.unit, MESSAGE: e.message }, null, '\t') + '\n',
        )
        continue
      }
      let line: string
      if (fmt === 'cat') line = e.message
      else if (fmt === 'short-iso') line = `${new Date(e.time).toISOString().replace(/\.\d+Z$/, '+00:00')}${host} ${e.ident}[${pid}]: ${e.message}`
      else line = `${journalTime(e.time)}${host} ${e.ident}[${pid}]: ${e.message}`
      ctx.out((ctx.isTTY && e.priority <= 3 ? `\x1b[1;31m${line}\x1b[0m` : ctx.isTTY && e.priority === 4 ? `\x1b[1;33m${line}\x1b[0m` : line) + '\n')
      const failed = /^Failed to start (\S+)/.exec(e.message)
      if (a.flags.has('x') && failed && e.ident === 'systemd') ctx.out(CATALOG_FAILED(failed[1]) + '\n')
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

function etime(start: number): string {
  const s = Math.max(1, Math.floor((Date.now() - start) / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${d ? `${d}-` : ''}${d || h ? `${pad(h)}:` : ''}${pad(m)}:${pad(s % 60)}`
}

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
      const head: Record<string, string> = { pid: 'PID', ppid: 'PPID', user: 'USER', '%cpu': '%CPU', '%mem': '%MEM', cmd: 'CMD', comm: 'COMMAND', stat: 'STAT', args: 'COMMAND', ni: ' NI', pri: 'PRI', tty: 'TT', etime: '    ELAPSED' }
      ctx.out(cols.map((c) => head[c] ?? c.toUpperCase()).join(' ') + '\n')
      for (const p of procs) {
        ctx.out(
          cols
            .map((c) =>
              c === 'pid' ? String(p.pid).padStart(5) : c === 'ppid' ? String(p.ppid).padStart(5) : c === 'user' ? p.user.padEnd(8) : c === '%cpu' ? p.cpu.toFixed(1).padStart(4) : c === '%mem' ? p.mem.toFixed(1).padStart(4) : c === 'stat' ? p.stat.padEnd(4) : c === 'comm' ? commOf(p) : c === 'ni' ? String(p.nice ?? 0).padStart(3) : c === 'pri' ? String(19 - (p.nice ?? 0)).padStart(3) : c === 'tty' ? (p.tty ?? '?').padEnd(6) : c === 'etime' ? etime(p.start).padStart(11) : p.cmd,
            )
            .join(' ') + '\n',
        )
      }
      return 0
    }
    if (/\b(a?ux|aux)\b/.test(args) || args.includes('-aux')) {
      ctx.out('USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND\n')
      for (const p of procs) {
        ctx.out(`${p.user.padEnd(10).slice(0, 10)} ${String(p.pid).padStart(5)} ${p.cpu.toFixed(1).padStart(4)} ${p.mem.toFixed(1).padStart(4)} ${String(Math.round(20000 + p.mem * 40000)).padStart(6)} ${String(Math.round(4000 + p.mem * 38000)).padStart(5)} ${(p.tty ?? (p.cmd.startsWith('-bash') ? 'pts/0' : '?')).padEnd(8)} ${p.stat.padEnd(4)} ${time(p).padEnd(5)}   0:${pad(Math.round(p.cpu / 10))} ${p.cmd}\n`)
      }
      return 0
    }
    if (args.includes('-e') || args.includes('-A') || args.includes('-f')) {
      ctx.out('UID          PID    PPID  C STIME TTY          TIME CMD\n')
      for (const p of procs) ctx.out(`${p.user.padEnd(8)} ${String(p.pid).padStart(7)} ${String(p.ppid).padStart(7)}  ${Math.round(p.cpu)} ${time(p).padEnd(5)} ${(p.tty ?? (p.cmd.startsWith('-bash') ? 'pts/0' : '?')).padEnd(8)}     00:00:0${Math.min(9, Math.round(p.cpu / 10))} ${p.cmd}\n`)
      return 0
    }
    if (userFilter || pidFilter || cmdFilter) {
      ctx.out('    PID TTY          TIME CMD\n')
      for (const p of procs) ctx.out(`${String(p.pid).padStart(7)} ${(p.tty ?? (p.cmd === '-bash' ? 'pts/0' : '?')).padEnd(8)} 00:00:${pad(Math.min(59, Math.round(p.cpu / 10)))} ${commOf(p)}\n`)
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
    // Un zombi ya terminó: no se puede matar. Desaparece cuando su padre lo recoge (o muere).
    if (p.stat.startsWith('Z')) continue
    // En espera del disco (D): no atiende señales hasta que vuelve la operación.
    if (p.stat.startsWith('D') && signal !== 18 && signal !== 19) continue
    if (signal === 15 && p.ignoresTerm) continue
    if (signal === 18) {
      if (p.stat.startsWith('T')) p.stat = p.cpu > 50 ? 'R' : 'S'
      continue
    }
    if (signal === 1 || signal === 10 || signal === 12) continue
    if (signal === 19) {
      p.stat = 'T'
      continue
    }
    ctx.sys.procs = ctx.sys.procs.filter((x) => x.pid !== pid && !(x.ppid === pid && x.stat.startsWith('Z')))
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
    // %1, %2...: trabajos de esta terminal.
    const pids: number[] = []
    for (const a of args) {
      if (a.startsWith('%')) {
        const j = jobFor(ctx.sh, a)
        if (!j) {
          ctx.err(`bash: kill: ${a}: no such job\n`)
          return 1
        }
        pids.push(j.pid)
      } else pids.push(Number(a))
    }
    const jobsBefore = ctx.sh.liveJobs().filter((j) => pids.includes(j.pid)).map((j) => ({ ...j }))
    const code = killProcs(ctx, pids, signal)
    for (const j of jobsBefore) {
      const alive = ctx.sys.procs.find((p) => p.pid === j.pid)
      if (!alive) ctx.err(`[${j.id}]+  ${signal === 9 ? 'Killed' : 'Terminated'}${' '.repeat(signal === 9 ? 19 : 15)}${j.text}\n`)
      else if (signal === 19) ctx.err(`\n[${j.id}]+  Stopped                 ${j.text}\n`)
    }
    ctx.sh.liveJobs()
    return code
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
    const a = parseArgs(ctx.args, { flags: { l: ['l', 'list-name'], a: ['a', 'list-full'], f: ['f', 'full'] }, values: { u: ['u'] } })
    const pattern = a.rest[0] ?? ''
    const re = new RegExp(pattern)
    const found = [...ctx.sys.procs].sort((x, y) => x.pid - y.pid).filter((p) => re.test(a.flags.has('f') ? p.cmd : commOf(p)) && (!a.values.has('u') || p.user === a.values.get('u')))
    for (const p of found) ctx.out(`${p.pid}${a.flags.has('l') ? ' ' + commOf(p) : a.flags.has('a') ? ' ' + p.cmd : ''}\n`)
    return found.length ? 0 : 1
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

export function strftime(fmt: string, d: Date): string {
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
    w: String(d.getDay()),
    e: String(d.getDate()).padStart(2),
    y: pad(d.getFullYear() % 100),
    I: pad(((d.getHours() + 11) % 12) + 1),
    p: d.getHours() < 12 ? 'AM' : 'PM',
    R: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    D: `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${pad(d.getFullYear() % 100)}`,
    V: pad(isoWeek(d)),
    n: '\n',
    t: '\t',
    '%': '%',
  }
  return fmt.replace(/%([YmdHMSFTAaBbsZzjuwneyIpRDVt%])/g, (_, k: string) => map[k])
}

function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
}

register('date', {
  usage: 'date [+FORMAT]',
  run(ctx) {
    const d = new Date(Date.now() + ctx.sys.clock.offset * 1000)
    const fmt = ctx.args.find((a) => a.startsWith('+'))
    if (fmt) ctx.out(strftime(fmt.slice(1), d) + '\n')
    else ctx.out(strftime('%a %b %d %T %Z %Y', d).replace(/ 0(\d) /, '  $1 ') + '\n')
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

register('whereis', {
  usage: 'whereis [options] [-BMS directory... -f] name...',
  run(ctx) {
    for (const c of ctx.args.filter((x) => !x.startsWith('-'))) {
      const def = COMMANDS.get(c)
      const available = def && ctx.sys.isCommandAvailable(c, (x) => commandPackage(ctx.sys.distro, x))
      if (!available) {
        ctx.out(`${c}:\n`)
        continue
      }
      const man = MAN_DESC[c] ? ` /usr/share/man/man${MAN_SECTION[c] ?? 1}/${c}.${MAN_SECTION[c] ?? 1}.gz` : ''
      ctx.out(`${c}: ${def.path ?? '/usr/bin'}/${c}${man}\n`)
    }
    return 0
  },
})

register('nl', {
  usage: 'nl [OPTION]... [FILE]...',
  summary: '  -b a  number all lines',
  run(ctx) {
    let all = false
    const files: string[] = []
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i]
      if (a === '-ba' || (a === '-b' && ctx.args[i + 1] === 'a')) {
        all = true
        if (a === '-b') i++
      } else files.push(a)
    }
    let text: string
    try {
      text = files.length ? files.map((f) => ctx.sys.vfs.readFile(ctx.sh.resolve(f), ctx.sh.cred)).join('') : ctx.stdin.readAll()
    } catch (e) {
      ctx.err(`nl: ${files[0]}: ${(e as Error).message}\n`)
      return 1
    }
    let n = 0
    const lines = text.replace(/\n$/, '').split('\n')
    for (const l of lines) {
      if (!all && l === '') ctx.out('       \n')
      else ctx.out(`${String(++n).padStart(6)}\t${l}\n`)
    }
    return 0
  },
})

/** Comandos de administración: sección 8 del manual. El resto va en la 1. */
const MAN_SECTION: Record<string, number> = Object.fromEntries(
  ['useradd', 'usermod', 'userdel', 'groupadd', 'groupdel', 'fdisk', 'visudo', 'shutdown', 'reboot', 'poweroff', 'halt', 'dmidecode', 'lspci', 'efibootmgr', 'ip', 'ss', 'ifconfig', 'adduser', 'ufw', 'dnf', 'yum', 'apt', 'apt-get', 'rpm', 'logrotate', 'grubby', 'grub2-mkconfig', 'grub-mkconfig', 'update-grub', 'dracut', 'update-initramfs', 'faillock', 'authselect'].map((c) => [c, 8]),
)

/** Formatos de archivo (sección 5). */
const MAN_FILES: Record<string, { desc: string; body: string; see: string }> = {
  passwd: {
    desc: 'password file',
    body: 'The /etc/passwd file is a text file that describes user login accounts for the system.\nEach line describes one user and contains seven colon-separated fields:\n\n  login name : optional encrypted password : numerical user ID :\n  numerical group ID : user name or comment field : user home directory :\n  optional user command interpreter\n\nIf the password field is a lower-case "x", then the encrypted password is\nactually stored in the shadow(5) file instead.',
    see: 'login(1), passwd(1), su(1), group(5), shadow(5)',
  },
  shadow: { desc: 'shadowed password file', body: 'shadow is a file which contains the password information for the system\'s\naccounts and optional aging information. This file must not be readable by\nregular users if password security is to be maintained.', see: 'chage(1), passwd(1), passwd(5)' },
  group: { desc: 'user group file', body: 'The /etc/group file is a text file that defines the groups on the system.\nThere is one entry per line, with the following format:\n\n  group_name:password:GID:user_list', see: 'gpasswd(1), groupadd(8), passwd(5)' },
  fstab: { desc: 'static information about the filesystems', body: 'The file fstab contains descriptive information about the filesystems the\nsystem can mount. Each filesystem is described on a separate line; fields\nare separated by tabs or spaces: device, mount point, type, options,\ndump and fsck order.', see: 'mount(8), swapon(8)' },
  hosts: { desc: 'static table lookup for hostnames', body: 'This manual page describes the format of the /etc/hosts file. For each\nhost a single line should be present with the following information:\n\n  IP_address canonical_hostname [aliases...]', see: 'hostname(1), resolv.conf(5)' },
  sudoers: { desc: 'default sudo security policy plugin', body: 'The sudoers policy plugin determines a user\'s sudo privileges. The\nsudoers file should always be edited with the visudo command.', see: 'sudo(8), visudo(8)' },
  'sshd_config': { desc: 'OpenSSH daemon configuration file', body: 'sshd(8) reads configuration data from /etc/ssh/sshd_config. The file\ncontains keyword-argument pairs, one per line. Lines starting with # and\nempty lines are interpreted as comments.', see: 'sshd(8)' },
  'systemd.unit': {
    desc: 'Unit configuration',
    body: 'A unit file is a plain text ini-style file that encodes information about a\nservice, a socket, a device, a mount point, a timer, etc. Sections: [Unit]\n(Description=, After=, Wants=, Requires=) and [Install] (WantedBy=).\n\nSystem units live in /usr/lib/systemd/system (from packages) and\n/etc/systemd/system (local administrator, takes precedence). Drop-in files\nin /etc/systemd/system/NAME.d/*.conf change single settings.',
    see: 'systemctl(1), systemd.service(5), systemd.timer(5)',
  },
  'systemd.service': {
    desc: 'Service unit configuration',
    body: 'The [Service] section: Type= (simple, exec, forking, oneshot, notify),\nExecStart= (command with absolute path), User=, Group=, WorkingDirectory=,\nEnvironment=, Restart= (no, on-failure, always), RestartSec=.\n\nOnly Type=oneshot services may have more than one ExecStart= line.',
    see: 'systemd.unit(5), systemd.exec(5)',
  },
  'systemd.timer': {
    desc: 'Timer unit configuration',
    body: 'A timer unit activates the service with the same name (or Unit=) at the\ngiven times. [Timer] settings: OnCalendar= (calendar event, see\nsystemd.time(7)), OnBootSec=, OnUnitActiveSec=, Persistent= (catch up runs\nmissed while the system was off), RandomizedDelaySec=.\n\nTimers are enabled with WantedBy=timers.target in [Install].',
    see: 'systemd.unit(5), systemd.time(7), systemd-analyze(1)',
  },
  'journald.conf': { desc: 'Journal service configuration files', body: 'Storage= (volatile, persistent, auto, none), SystemMaxUse=, MaxRetentionSec=,\nForwardToSyslog=. With Storage=auto the journal is kept on disk only if\n/var/log/journal exists.', see: 'journalctl(1), systemd-journald.service(8)' },
  'logrotate.conf': { desc: 'logrotate configuration (see logrotate(8))', body: 'Directives: daily, weekly, monthly, rotate N, size N, compress,\ndelaycompress, missingok, notifempty, create MODE OWNER GROUP, copytruncate,\ndateext, su USER GROUP, postrotate ... endscript.', see: 'logrotate(8)' },
  'crontab': { desc: 'tables for driving cron', body: 'A crontab file contains instructions to the cron daemon of the general form:\n"run this command at this time on this date".\n\n  minute  hour  day-of-month  month  day-of-week  command', see: 'cron(8), crontab(1)' },
}

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
  'systemd-analyze': 'Analyze and debug system manager',
  logrotate: 'rotates, compresses, and mails system logs',
  zcat: 'compress or expand files',
  grubby: 'command line tool for configuring grub and zipl',
  'grub2-mkconfig': 'Generate a GRUB configuration file.',
  'grub-mkconfig': 'generate a GRUB configuration file',
  'update-grub': 'stub for grub-mkconfig',
  dracut: 'low-level tool for generating an initramfs/initrd image',
  lsinitrd: 'tool to show the contents of an initramfs image',
  'update-initramfs': 'generate an initramfs image',
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

/** Todas las páginas conocidas: [nombre, sección, descripción]. */
function manIndex(): [string, number, string][] {
  return [
    ...Object.entries(MAN_DESC).map(([k, v]) => [k, MAN_SECTION[k] ?? 1, v] as [string, number, string]),
    ...Object.entries(MAN_FILES).map(([k, v]) => [k, 5, v.desc] as [string, number, string]),
  ]
}

register(['man', 'apropos', 'whatis'], {
  usage: 'man [SECTION] PAGE | man -k KEYWORD | man -f PAGE',
  run(ctx) {
    if (ctx.name === 'whatis' || ctx.args[0] === '-f') {
      const page = ctx.name === 'whatis' ? ctx.args[0] : ctx.args[1]
      const hits = manIndex().filter(([k]) => k === page)
      if (!hits.length) {
        ctx.out(`${page}: nothing appropriate.\n`)
        return 16
      }
      for (const [k, sec, v] of hits.sort((a, b) => a[1] - b[1])) ctx.out(`${`${k} (${sec})`.padEnd(22)} - ${v}\n`)
      return 0
    }
    if (ctx.name === 'apropos' || ctx.args[0] === '-k') {
      const kw = (ctx.name === 'apropos' ? ctx.args[0] : ctx.args[1])?.toLowerCase()
      if (!kw) {
        ctx.err('apropos what?\n')
        return 1
      }
      const hits = manIndex().filter(([k, , v]) => k.includes(kw) || v.toLowerCase().includes(kw))
      if (!hits.length) {
        ctx.out(`${kw}: nothing appropriate.\n`)
        return 16
      }
      for (const [k, sec, v] of hits.sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1])) ctx.out(`${`${k} (${sec})`.padEnd(22)} - ${v}\n`)
      return 0
    }
    const section = ctx.args.find((a) => /^\d$/.test(a))
    const page = ctx.args.find((a) => !/^\d$/.test(a))
    if (!page) {
      ctx.err('What manual page do you want?\nFor example, try \'man man\'.\n')
      return 1
    }
    const file = MAN_FILES[page]
    if (file && (section === '5' || (!section && !COMMANDS.has(page)))) {
      const title = `${page.toUpperCase()}(5)`
      ctx.out(`${title.padEnd(30)}File Formats Manual${title.padStart(30)}\n\nNAME\n       ${page} - ${file.desc}\n\nDESCRIPTION\n${file.body.split('\n').map((l) => '       ' + l).join('\n')}\n\nSEE ALSO\n       ${file.see}\n\n`)
      if (ctx.isTTY) ctx.err('[simulador] Esta es una versión abreviada; en un servidor real man muestra el manual completo (se sale con q).\n')
      return 0
    }
    const def = COMMANDS.get(page)
    const builtin = page in BUILTINS
    const sec = MAN_SECTION[page] ?? 1
    if ((!def && !builtin) || (section && Number(section) !== sec && !(builtin && section === '1'))) {
      ctx.err(section ? `No entry for ${page} in section ${section} of the manual\n` : `No manual entry for ${page}\n`)
      return 16
    }
    const title = `${page.toUpperCase()}(${sec})`
    const kind = sec === 8 ? 'System Management Commands' : 'User Commands'
    ctx.out(
      `${title.padEnd(30)}${kind}${title.padStart(30)}\n\nNAME\n       ${page} - ${MAN_DESC[page] ?? (builtin ? 'bash built-in command' : 'command')}\n\nSYNOPSIS\n       ${def?.usage ?? `${page} [arguments]`}\n\nDESCRIPTION\n${(def?.summary ?? '       See the online documentation for details.').split('\n').map((l) => '       ' + l.trim()).join('\n')}\n\n`,
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
    const bad = checkCrontab(data)
    if (bad) {
      ctx.err(`"${src && src !== '-' ? src : '-'}":${bad.line}: ${bad.message}\nerrors in crontab file, can't install.\n`)
      return 1
    }
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
