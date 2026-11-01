/**
 * systemctl y systemd-analyze: servicios, unidades propias, drop-ins, timers y targets.
 */
import { parse } from '../parser'
import { register, Stdin, type CommandContext } from '../shell'
import type { Service, System } from '../system'
import {
  calendarNext,
  customFragment,
  daemonReload,
  findService,
  findTimer,
  needsReload,
  nextElapse,
  normalizeCalendar,
  parseCalendar,
  parseTimespan,
  parseUnitFiles,
  systemdDate,
  timespan,
  vendorUnitText,
  type Timer,
} from '../units'
import { ROOT_CRED } from '../vfs'
import { entryPid, SERVICE_CHECKS } from './sysinfo'
import { chronyStart, ntpSources } from '../kernel'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n: number) => String(n).padStart(2, '0')
const GREEN = (s: string, tty: boolean) => (tty ? `\x1b[0;1;32m${s}\x1b[0m` : s)
const RED = (s: string, tty: boolean) => (tty ? `\x1b[0;1;31m${s}\x1b[0m` : s)

function journalTime(ms: number): string {
  const d = new Date(ms)
  return `${MONTHS[d.getMonth()]} ${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const ago = (ms: number) => `${timespan(Date.now() - ms)} ago`
const left = (ms: number) => `${timespan(ms - Date.now())} left`

const TARGETS: Record<string, string> = {
  'multi-user.target': 'Multi-User System',
  'graphical.target': 'Graphical Interface',
  'rescue.target': 'Rescue Mode',
  'emergency.target': 'Emergency Mode',
  'basic.target': 'Basic System',
  'sysinit.target': 'System Initialization',
  'network.target': 'Network',
  'network-online.target': 'Network is Online',
  'timers.target': 'Timer Units',
  'sockets.target': 'Socket Units',
  'paths.target': 'Path Units',
  'local-fs.target': 'Local File Systems',
  'remote-fs.target': 'Remote File Systems',
  'swap.target': 'Swaps',
  'getty.target': 'Login Prompts',
  'reboot.target': 'System Reboot',
  'poweroff.target': 'System Power Off',
}

const ACTIVE_TARGETS = ['multi-user.target', 'basic.target', 'sysinit.target', 'network.target', 'network-online.target', 'timers.target', 'sockets.target', 'paths.target', 'local-fs.target', 'remote-fs.target', 'swap.target', 'getty.target']

type Kind = 'service' | 'timer' | 'target' | 'other'

function splitUnit(arg: string): { name: string; kind: Kind; full: string } {
  const m = /^(.+)\.(service|timer|target|socket|mount|path|slice|scope|device|swap)$/.exec(arg)
  if (!m) return { name: arg, kind: 'service', full: `${arg}.service` }
  const kind = (['service', 'timer', 'target'].includes(m[2]) ? m[2] : 'other') as Kind
  return { name: m[1], kind, full: arg }
}

function preset(sys: System) {
  return sys.distro === 'rocky' ? 'disabled' : 'enabled'
}

/** Aviso que systemctl muestra cuando se editó una unidad sin hacer daemon-reload. */
function reloadWarning(ctx: CommandContext, unit: string) {
  if (needsReload(ctx.sys, unit)) ctx.err(`Warning: The unit file, source configuration file or drop-ins of ${unit} changed on disk. Run 'systemctl daemon-reload' to reload units.\n`)
}

function journal(sys: System, unit: string, message: string, priority = 6, ident = 'systemd', pid = 1) {
  sys.journal.push({ time: Date.now(), unit, priority, message, ident, pid })
}

function accessDenied(ctx: CommandContext, verb: string, unit: string): boolean {
  if (ctx.sh.user === 'root') return false
  ctx.err(`Failed to ${verb} ${unit}: Access denied\nSee system logs and 'systemctl status ${unit}' for details.\n`)
  return true
}

// ---------------------------------------------------------------------------------------
// Arranque de servicios
// ---------------------------------------------------------------------------------------

const EXEC_PATH = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin']

/** Separa los prefijos especiales de ExecStart (-, @, +, !, :) del comando. */
function execParts(line: string): { ignoreFailure: boolean; cmd: string; exe: string } {
  const m = /^([-@+!:]*)(.*)$/.exec(line.trim())!
  const cmd = m[2].trim()
  return { ignoreFailure: m[1].includes('-'), cmd, exe: cmd.split(/\s+/)[0] ?? '' }
}

function fail(ctx: CommandContext, svc: Service, status: string, lines: string[], result = 'exit-code', pidIn?: number) {
  const sys = ctx.sys
  const unit = `${svc.name}.service`
  const pid = pidIn ?? sys.allocPid()
  for (const l of lines) journal(sys, unit, l, 3, l.startsWith(`${unit}:`) || l.startsWith('Failed') ? 'systemd' : svc.name, l.startsWith(`${unit}:`) ? 1 : pid)
  journal(sys, unit, `${unit}: Main process exited, code=exited, status=${status}`, 5)
  journal(sys, unit, `${unit}: Failed with result '${result}'.`, 4)
  journal(sys, unit, `Failed to start ${unit} - ${svc.description}.`, 3)
  svc.active = false
  svc.failed = true
  svc.result = result
  svc.since = Date.now()
  svc.pid = undefined
  svc.lastExit = { pid, status, cmd: svc.unit?.execStart[0] ?? '', time: Date.now() }
}

/** Prueba lo que systemd revisa antes de lanzar el proceso: usuario, carpeta y ejecutable. */
function preflight(ctx: CommandContext, svc: Service): { status: string; lines: string[] } | undefined {
  const sys = ctx.sys
  const def = svc.unit!
  const unit = `${svc.name}.service`
  const user = def.user ?? 'root'
  if (!sys.users.has(user)) {
    return { status: '217/USER', lines: [`${unit}: Failed to determine user credentials: No such process`, `${unit}: Failed at step USER spawning ${execParts(def.execStart[0]).exe}: No such process`] }
  }
  if (def.workingDirectory && !sys.vfs.exists(def.workingDirectory)) {
    return { status: '200/CHDIR', lines: [`${unit}: Changing to the requested working directory failed: No such file or directory`, `${unit}: Failed at step CHDIR spawning ${execParts(def.execStart[0]).exe}: No such file or directory`] }
  }
  for (const line of [...def.execStartPre, ...def.execStart]) {
    const { exe } = execParts(line)
    let path = exe
    if (!exe.startsWith('/')) {
      path = EXEC_PATH.map((d) => `${d}/${exe}`).find((p) => sys.vfs.exists(p)) ?? ''
      if (!path) return { status: '203/EXEC', lines: [`${unit}: Unable to locate executable '${exe}': No such file or directory`, `${unit}: Failed at step EXEC spawning ${exe}: No such file or directory`] }
    }
    if (!sys.vfs.exists(path)) {
      return { status: '203/EXEC', lines: [`${unit}: Unable to locate executable '${path}': No such file or directory`, `${unit}: Failed at step EXEC spawning ${path}: No such file or directory`] }
    }
    const node = sys.vfs.stat(path, ROOT_CRED)
    if (node.type === 'dir' || !sys.vfs.can(node, sys.credFor(user), 1)) {
      return { status: '203/EXEC', lines: [`${unit}: Failed to execute ${path}: Permission denied`, `${unit}: Failed at step EXEC spawning ${path}: Permission denied`] }
    }
    // Un script sin "#!" en la primera línea: el kernel no sabe con qué ejecutarlo.
    const isVirtualBinary = /^\/usr\/s?bin\//.test(path) && sys.vfs.readFile(path, ROOT_CRED) === ''
    if (!isVirtualBinary && node.type === 'file' && !sys.vfs.readFile(path, ROOT_CRED).startsWith('#!')) {
      return { status: '203/EXEC', lines: [`${unit}: Failed to execute ${path}: Exec format error`, `${unit}: Failed at step EXEC spawning ${path}: Exec format error`] }
    }
  }
  return undefined
}

/** Ejecuta un comando de ExecStart como lo haría systemd: con el usuario de la unidad y la salida al journal. */
async function runExec(ctx: CommandContext, svc: Service, line: string, pid: number): Promise<number> {
  const def = svc.unit!
  const { cmd, exe } = execParts(line)
  const ident = exe.split('/').pop() ?? svc.name
  let buf = ''
  const flush = (all = false) => {
    const parts = buf.split('\n')
    buf = all ? '' : parts.pop()!
    for (const p of all ? parts.filter((x, i) => x || i < parts.length - 1) : parts) {
      if (p.trim()) journal(ctx.sys, `${svc.name}.service`, p, 6, ident, pid)
    }
  }
  const io = {
    stdin: new Stdin(),
    out: (s: string) => {
      buf += s
      flush()
    },
    err: (s: string) => {
      buf += s
      flush()
    },
    isTTY: false,
  }
  return ctx.sh.asUser(def.user ?? 'root', async () => {
    ctx.sh.cwd = def.workingDirectory ?? '/'
    let code: number
    try {
      code = await ctx.sh.exec(parse(cmd), io)
    } catch (e) {
      code = typeof (e as { code?: number }).code === 'number' ? (e as { code: number }).code : 1
    }
    flush(true)
    return code
  })
}

async function startService(ctx: CommandContext, svc: Service, verb = 'start'): Promise<boolean> {
  const sys = ctx.sys
  const unit = `${svc.name}.service`
  if (svc.masked) {
    ctx.err(`Failed to ${verb} ${unit}: Unit ${unit} is masked.\n`)
    return false
  }
  const def = svc.unit
  if (def?.errors.length) {
    for (const e of def.errors) journal(sys, unit, e, 3)
    ctx.err(`Failed to ${verb} ${unit}: Unit ${unit} has a bad unit file setting.\nSee system logs and 'systemctl status ${unit}' for details.\n`)
    return false
  }
  if (svc.active) return true
  // Servicios de paquetes: se comportan como antes (configuración, puertos ocupados).
  if (!def?.custom) {
    const extra = SERVICE_CHECKS[svc.name]?.(ctx)
    const conflict = [...sys.services.values()].find((o) => o !== svc && o.active && o.ports.some((p) => svc.ports.includes(p)))
    const port = conflict ? svc.ports.find((p) => conflict.ports.includes(p)) : undefined
    const bindError =
      svc.name === 'nginx'
        ? `nginx: [emerg] bind() to 0.0.0.0:${port} failed (98: Address already in use)`
        : svc.name === 'httpd' || svc.name === 'apache2'
          ? `(98)Address already in use: AH00072: make_sock: could not bind to address 0.0.0.0:${port}`
          : `bind() to 0.0.0.0:${port} failed (98: Address already in use)`
    const failure = svc.failMessage ?? extra ?? (conflict ? bindError : undefined)
    if (failure) {
      const pid = sys.allocPid()
      journal(sys, unit, `Starting ${unit} - ${svc.description}...`)
      journal(sys, unit, failure, 3, svc.name, pid)
      journal(sys, unit, `${unit}: Control process exited, code=exited, status=1/FAILURE`, 3)
      journal(sys, unit, `${unit}: Failed with result 'exit-code'.`, 4)
      journal(sys, unit, `Failed to start ${unit} - ${svc.description}.`, 3)
      svc.active = false
      svc.failed = true
      svc.result = 'exit-code'
      svc.since = Date.now()
      svc.lastExit = { pid, status: '1/FAILURE', cmd: `/usr/sbin/${svc.name}`, time: Date.now() }
      ctx.err(`Job for ${unit} failed because the control process exited with error code.\nSee "systemctl status ${unit}" and "journalctl -xeu ${unit}" for details.\n`)
      return false
    }
    svc.active = true
    svc.failed = false
    svc.result = 'success'
    svc.since = Date.now()
    svc.pid = sys.spawnService(svc.name).pid
    journal(sys, unit, `Starting ${unit} - ${svc.description}...`)
    journal(sys, unit, `Started ${unit} - ${svc.description}.`)
    if (svc.name === 'chronyd' || svc.name === 'chrony') {
      chronyStart(sys)
      for (const s of ntpSources(sys)) if (!s.reachable) journal(sys, unit, `Could not resolve address of ${s.name}`, 4, svc.name, svc.pid)
      journal(sys, unit, sys.clock.synced ? `Selected source ${ntpSources(sys).find((s) => s.reachable)?.name ?? ''}` : 'No suitable source for synchronisation', sys.clock.synced ? 6 : 4, svc.name, svc.pid)
    }
    return true
  }
  // Unidades propias.
  journal(sys, unit, `Starting ${unit} - ${svc.description}...`)
  const bad = svc.failMessage ? { status: '1/FAILURE', lines: [svc.failMessage] } : preflight(ctx, svc)
  const jobFailed = (oneshot: boolean) =>
    ctx.err(
      `Job for ${unit} failed because ${oneshot ? 'the control process' : 'the process'} exited with error code.\nSee "systemctl status ${unit}" and "journalctl -xeu ${unit}" for details.\n`,
    )
  if (bad) {
    fail(ctx, svc, bad.status, bad.lines)
    jobFailed(def.type === 'oneshot')
    return false
  }
  if (def.type === 'oneshot') {
    const pid = sys.allocPid()
    for (const line of [...def.execStartPre, ...def.execStart]) {
      const code = await runExec(ctx, svc, line, pid)
      if (code !== 0 && !execParts(line).ignoreFailure) {
        fail(ctx, svc, `${code}/${code === 1 ? 'FAILURE' : code === 2 ? 'INVALIDARGUMENT' : code === 126 ? 'NOPERMISSION' : code === 127 ? 'NOTINSTALLED' : 'n/a'}`, [], 'exit-code', pid)
        svc.lastExit!.cmd = line
        jobFailed(true)
        return false
      }
    }
    svc.failed = false
    svc.result = 'success'
    svc.since = Date.now()
    svc.lastExit = { pid, status: '0/SUCCESS', cmd: def.execStart.at(-1) ?? '', time: Date.now() }
    if (def.remainAfterExit) svc.active = true
    else journal(sys, unit, `${unit}: Deactivated successfully.`)
    journal(sys, unit, `Finished ${unit} - ${svc.description}.`)
    return true
  }
  // simple, exec, notify, forking: el proceso queda corriendo.
  const { cmd } = execParts(def.execStart[0])
  const proc = sys.spawn(def.user ?? 'root', cmd, 0, 0.4, 1, Date.now(), cmd.split(/\s+/)[0].split('/').pop())
  svc.active = true
  svc.failed = false
  svc.result = 'success'
  svc.since = Date.now()
  svc.pid = proc.pid
  journal(sys, unit, `Started ${unit} - ${svc.description}.`)
  return true
}

function stopService(ctx: CommandContext, svc: Service) {
  if (!svc.active) {
    svc.failed = false
    return
  }
  const unit = `${svc.name}.service`
  journal(ctx.sys, unit, `Stopping ${unit} - ${svc.description}...`)
  ctx.sys.procs = ctx.sys.procs.filter((p) => p.pid !== svc.pid && p.cmd !== svc.name)
  svc.active = false
  svc.failed = false
  svc.since = Date.now()
  svc.pid = undefined
  journal(ctx.sys, unit, `${unit}: Deactivated successfully.`)
  journal(ctx.sys, unit, `Stopped ${unit} - ${svc.description}.`)
}

function startTimer(ctx: CommandContext, t: Timer): boolean {
  const unit = `${t.name}.timer`
  if (t.masked) {
    ctx.err(`Failed to start ${unit}: Unit ${unit} is masked.\n`)
    return false
  }
  if (t.errors.length) {
    for (const e of t.errors) journal(ctx.sys, unit, e, 3)
    ctx.err(`Failed to start ${unit}: Unit ${unit} has a bad unit file setting.\nSee system logs and 'systemctl status ${unit}' for details.\n`)
    return false
  }
  if (!t.builtin && !findService(ctx.sys, t.unit)) {
    journal(ctx.sys, unit, `${unit}: Refusing to start, unit ${t.unit}.service to trigger not loaded.`, 3)
    ctx.err(`Failed to start ${unit}: Unit ${t.unit}.service not found.\n`)
    return false
  }
  if (!t.active) {
    t.active = true
    t.since = Date.now()
    journal(ctx.sys, unit, `Started ${unit} - ${t.description}.`)
  }
  return true
}

function stopTimer(ctx: CommandContext, t: Timer) {
  if (!t.active) return
  t.active = false
  t.since = Date.now()
  journal(ctx.sys, `${t.name}.timer`, `${t.name}.timer: Deactivated successfully.`)
  journal(ctx.sys, `${t.name}.timer`, `Stopped ${t.name}.timer - ${t.description}.`)
}

// ---------------------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------------------

function unitFileState(svc: Service): string {
  if (svc.masked) return 'masked'
  if (svc.unit && !svc.unit.hasInstall) return 'static'
  return svc.enabled ? 'enabled' : 'disabled'
}

function triggeredBy(sys: System, name: string): Timer | undefined {
  return [...sys.timers.values()].find((t) => t.unit === name)
}

function serviceStatus(ctx: CommandContext, svc: Service): string {
  const tty = ctx.isTTY
  const def = svc.unit
  const unit = `${svc.name}.service`
  if (svc.masked) {
    return `○ ${unit}\n     Loaded: masked (Reason: Unit ${unit} is masked.)\n     Active: inactive (dead)\n`
  }
  const state = unitFileState(svc)
  const loaded = def?.errors.length ? `bad-setting (Reason: Unit ${unit} has a bad unit file setting.)` : `loaded (${def?.path ?? `/usr/lib/systemd/system/${unit}`}; ${state}${state === 'static' ? '' : `; preset: ${preset(ctx.sys)}`})`
  const exited = def?.type === 'oneshot' && svc.active
  const dot = svc.active ? GREEN('●', tty) : svc.failed ? RED('×', tty) : '○'
  const active = svc.active
    ? `${GREEN(exited ? 'active (exited)' : 'active (running)', tty)} since ${systemdDate(svc.since)}; ${ago(svc.since)}`
    : svc.failed
      ? `${RED('failed', tty)} (Result: ${svc.result ?? 'exit-code'}) since ${systemdDate(svc.since)}; ${ago(svc.since)}`
      : svc.lastExit
        ? `inactive (dead) since ${systemdDate(svc.since)}; ${ago(svc.since)}`
        : 'inactive (dead)'
  let out = `${dot} ${unit} - ${svc.description}\n     Loaded: ${loaded}\n`
  if (def?.dropins.length) {
    const dir = def.dropins[0].slice(0, def.dropins[0].lastIndexOf('/'))
    out += `    Drop-In: ${dir}\n             └─${def.dropins.map((p) => p.split('/').pop()).join(', ')}\n`
  }
  out += `     Active: ${active}\n`
  const trig = triggeredBy(ctx.sys, svc.name)
  if (trig) out += `TriggeredBy: ${trig.active ? GREEN('●', tty) : '○'} ${trig.name}.timer\n`
  if (svc.lastExit && !svc.active) {
    const code = svc.lastExit.status
    out += `    Process: ${svc.lastExit.pid} ExecStart=${execParts(svc.lastExit.cmd).cmd} (code=exited, status=${code})\n   Main PID: ${svc.lastExit.pid} (code=exited, status=${code})\n`
  }
  if (svc.active && svc.pid) {
    const proc = ctx.sys.procs.find((p) => p.pid === svc.pid)
    const cmd = proc?.cmd ?? svc.name
    out += `   Main PID: ${svc.pid} (${proc?.comm ?? cmd.split(/\s+/)[0].split('/').pop()})\n      Tasks: ${svc.ports.length ? 3 : 1} (limit: 22950)\n     Memory: 4.2M\n        CPU: 61ms\n     CGroup: /system.slice/${unit}\n             └─${svc.pid} ${cmd}\n`
  }
  const logs = ctx.sys.journal.filter((j) => j.unit === unit).slice(-8)
  if (logs.length) out += '\n' + logs.map((j) => `${journalTime(j.time)} ${ctx.sys.hostname} ${j.ident}[${entryPid(j)}]: ${j.message}`).join('\n') + '\n'
  return out
}

function timerStatus(ctx: CommandContext, t: Timer): string {
  const tty = ctx.isTTY
  const unit = `${t.name}.timer`
  const state = t.masked ? 'masked' : !t.hasInstall ? 'static' : t.enabled ? 'enabled' : 'disabled'
  const loaded = t.errors.length ? `bad-setting (Reason: Unit ${unit} has a bad unit file setting.)` : `loaded (${t.path}; ${state}${state === 'static' ? '' : `; preset: ${preset(ctx.sys)}`})`
  const next = nextElapse(ctx.sys, t)
  let out = `${t.active ? GREEN('●', tty) : '○'} ${unit} - ${t.description}\n     Loaded: ${loaded}\n`
  out += `     Active: ${t.active ? `${GREEN('active (waiting)', tty)} since ${systemdDate(t.since)}; ${ago(t.since)}` : 'inactive (dead)'}\n`
  if (t.active && next) out += `    Trigger: ${systemdDate(next)}; ${left(next)}\n`
  else if (t.active) out += '    Trigger: n/a\n'
  const target = ctx.sys.services.get(t.unit)
  out += `   Triggers: ${target?.active ? GREEN('●', tty) : target?.failed ? RED('×', tty) : '●'} ${t.unit}.service\n`
  const logs = ctx.sys.journal.filter((j) => j.unit === unit).slice(-5)
  if (logs.length) out += '\n' + logs.map((j) => `${journalTime(j.time)} ${ctx.sys.hostname} ${j.ident}[${entryPid(j)}]: ${j.message}`).join('\n') + '\n'
  return out
}

function targetStatus(ctx: CommandContext, name: string): string {
  const active = ACTIVE_TARGETS.includes(name) || name === ctx.sys.defaultTarget
  const since = ctx.sys.bootTime + 25_000
  return `${active ? GREEN('●', ctx.isTTY) : '○'} ${name} - ${TARGETS[name]}\n     Loaded: loaded (/usr/lib/systemd/system/${name}; ${name === 'multi-user.target' || name === 'graphical.target' ? 'indirect' : 'static'})\n     Active: ${active ? `${GREEN('active', ctx.isTTY)} since ${systemdDate(since)}; ${ago(since)}` : 'inactive (dead)'}\n       Docs: man:systemd.special(7)\n`
}

// ---------------------------------------------------------------------------------------
// systemctl
// ---------------------------------------------------------------------------------------

interface Opts {
  flags: Set<string>
  type?: string
  state?: string
  props: string[]
  signal?: string
  rest: string[]
}

function parseOpts(args: string[]): Opts {
  const o: Opts = { flags: new Set(), props: [], rest: [] }
  const withValue: Record<string, keyof Opts> = { '-t': 'type', '--type': 'type', '--state': 'state', '-p': 'props', '--property': 'props', '-s': 'signal', '--signal': 'signal' }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const eq = a.indexOf('=')
    const key = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a
    if (withValue[key]) {
      const v = a.startsWith('--') && eq > 0 ? a.slice(eq + 1) : args[++i] ?? ''
      const field = withValue[key]
      if (field === 'props') o.props.push(...v.split(','))
      else (o as unknown as Record<string, string>)[field] = v
      continue
    }
    if (/^-p\w/.test(a)) {
      o.props.push(...a.slice(2).split(','))
      continue
    }
    if (a === '--failed') {
      o.state = 'failed'
      continue
    }
    if (a.startsWith('-') && a.length > 1) {
      if (a === '-a' || a === '--all') o.flags.add('all')
      else if (a === '-q' || a === '--quiet') o.flags.add('quiet')
      else if (a === '-l' || a === '--full') o.flags.add('full')
      else o.flags.add(a.replace(/^-+/, ''))
      continue
    }
    o.rest.push(a)
  }
  return o
}

function listUnits(ctx: CommandContext, o: Opts) {
  const sys = ctx.sys
  const tty = ctx.isTTY
  const type = o.type
  const rows: { unit: string; load: string; active: string; sub: string; desc: string; failed: boolean }[] = []
  if (!type || type === 'service') {
    for (const s of [...sys.services.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const active = s.active ? 'active' : s.failed ? 'failed' : 'inactive'
      const sub = s.active ? (s.unit?.type === 'oneshot' ? 'exited' : 'running') : s.failed ? 'failed' : 'dead'
      rows.push({ unit: `${s.name}.service`, load: s.masked ? 'masked' : s.unit?.errors.length ? 'bad-setting' : 'loaded', active, sub, desc: s.description, failed: s.failed })
    }
  }
  if (!type || type === 'timer') {
    for (const t of [...sys.timers.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      rows.push({ unit: `${t.name}.timer`, load: t.errors.length ? 'bad-setting' : 'loaded', active: t.active ? 'active' : 'inactive', sub: t.active ? 'waiting' : 'dead', desc: t.description, failed: false })
    }
  }
  if (!type || type === 'target') {
    for (const [name, desc] of Object.entries(TARGETS)) {
      const on = ACTIVE_TARGETS.includes(name) || name === sys.defaultTarget
      rows.push({ unit: name, load: 'loaded', active: on ? 'active' : 'inactive', sub: on ? 'active' : 'dead', desc, failed: false })
    }
  }
  let list = rows
  const pattern = o.rest[0]
  if (pattern) {
    const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
    list = list.filter((r) => re.test(r.unit) || re.test(r.unit.replace(/\.service$/, '')))
  }
  if (o.state) {
    const states = o.state.split(',')
    list = list.filter((r) => states.includes(r.active) || states.includes(r.sub) || states.includes(r.load))
  } else if (!o.flags.has('all')) list = list.filter((r) => r.active !== 'inactive')
  const w = Math.max(29, ...list.map((r) => r.unit.length)) + 1
  if (!list.length) {
    ctx.out('  UNIT LOAD ACTIVE SUB DESCRIPTION\n\n0 loaded units listed.\n')
    return 0
  }
  ctx.out(`  ${'UNIT'.padEnd(w)} LOAD   ACTIVE   SUB     DESCRIPTION\n`)
  for (const r of list) {
    const line = `${r.unit.padEnd(w)} ${r.load.padEnd(6)} ${r.active.padEnd(8)} ${r.sub.padEnd(7)} ${r.desc}`
    ctx.out(r.failed ? `${RED('●', tty)} ${RED(line, tty)}\n` : `  ${line}\n`)
  }
  ctx.out(
    `\nLegend: LOAD   → Reflects whether the unit definition was properly loaded.\n        ACTIVE → The high-level unit activation state, i.e. generalization of SUB.\n        SUB    → The low-level unit activation state, values depend on unit type.\n\n${list.length} loaded units listed.${o.flags.has('all') ? '' : ' Pass --all to see loaded but inactive units, too.'}\n`,
  )
  return 0
}

function listUnitFiles(ctx: CommandContext, o: Opts) {
  const sys = ctx.sys
  const rows: [string, string][] = []
  if (!o.type || o.type === 'service') for (const s of sys.services.values()) rows.push([`${s.name}.service`, s.masked ? 'masked' : s.unit && !s.unit.hasInstall ? 'static' : s.enabled ? 'enabled' : 'disabled'])
  if (!o.type || o.type === 'timer') for (const t of sys.timers.values()) rows.push([`${t.name}.timer`, t.masked ? 'masked' : !t.hasInstall ? 'static' : t.enabled ? 'enabled' : 'disabled'])
  if (!o.type || o.type === 'target') for (const n of Object.keys(TARGETS)) rows.push([n, n === 'multi-user.target' || n === 'graphical.target' ? 'indirect' : 'static'])
  let list = rows.sort((a, b) => a[0].localeCompare(b[0]))
  if (o.state) list = list.filter((r) => o.state!.split(',').includes(r[1]))
  if (o.rest[0]) {
    const re = new RegExp('^' + o.rest[0].replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
    list = list.filter((r) => re.test(r[0]))
  }
  const w = Math.max(34, ...list.map((r) => r[0].length)) + 1
  ctx.out(`${'UNIT FILE'.padEnd(w)} STATE    PRESET\n`)
  for (const [u, st] of list) ctx.out(`${u.padEnd(w)} ${st.padEnd(8)} ${st === 'static' || st === 'indirect' ? '-' : preset(sys)}\n`)
  ctx.out(`\n${list.length} unit files listed.\n`)
  return 0
}

function listTimers(ctx: CommandContext, o: Opts) {
  const sys = ctx.sys
  const rows = [...sys.timers.values()]
    .filter((t) => t.active || o.flags.has('all'))
    .map((t) => ({ t, next: t.active ? nextElapse(sys, t) : undefined }))
    .sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity))
  const cols = rows.map(({ t, next }) => [
    next ? systemdDate(next) : '-',
    next ? timespan(next - Date.now()) : '-',
    t.last ? systemdDate(t.last) : '-',
    t.last ? ago(t.last) : '-',
    `${t.name}.timer`,
    `${t.unit}.service`,
  ])
  const head = ['NEXT', 'LEFT', 'LAST', 'PASSED', 'UNIT', 'ACTIVATES']
  const widths = head.map((h, i) => Math.max(h.length, ...cols.map((c) => c[i].length)))
  const fmt = (c: string[]) => c.map((v, i) => (i === 1 || i === 3 ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join(' ').trimEnd()
  ctx.out(fmt(head) + '\n')
  for (const c of cols) ctx.out(fmt(c) + '\n')
  ctx.out(`\n${cols.length} timers listed.\n${o.flags.has('all') ? '' : "Pass --all to see loaded but inactive timers, too.\n"}`)
  return 0
}

function catUnit(ctx: CommandContext, u: { name: string; kind: Kind; full: string }): number {
  const sys = ctx.sys
  if (u.kind === 'timer') {
    const t = findTimer(sys, u.name)
    if (!t) {
      ctx.err(`No files found for ${u.full}.\n`)
      return 1
    }
    if (t.builtin) ctx.out(`# ${t.path}\n[Unit]\nDescription=${t.description}\n\n[Timer]\nOnCalendar=${t.onCalendar[0]?.original ?? 'daily'}\nAccuracySec=1h\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`)
    else ctx.out(`# ${t.path}\n${sys.vfs.readFile(t.path, ROOT_CRED)}`)
    return 0
  }
  if (u.kind === 'target' && TARGETS[u.full]) {
    ctx.out(`# /usr/lib/systemd/system/${u.full}\n[Unit]\nDescription=${TARGETS[u.full]}\nDocumentation=man:systemd.special(7)\n`)
    return 0
  }
  const svc = findService(sys, u.name)
  if (!svc) {
    ctx.err(`No files found for ${u.full}.\n`)
    return 1
  }
  const custom = `/etc/systemd/system/${svc.name}.service`
  if (svc.unit?.custom) ctx.out(`# ${custom}\n${sys.vfs.readFile(custom, ROOT_CRED)}`)
  else ctx.out(`# /usr/lib/systemd/system/${svc.name}.service\n${vendorUnitText(svc)}`)
  for (const d of svc.unit?.dropins ?? []) ctx.out(`\n# ${d}\n${sys.vfs.readFile(d, ROOT_CRED)}`)
  return 0
}

function showProps(ctx: CommandContext, u: { name: string; kind: Kind; full: string }, o: Opts): number {
  const sys = ctx.sys
  const props: Record<string, string> = {}
  if (u.kind === 'timer') {
    const t = findTimer(sys, u.name)
    const next = t ? nextElapse(sys, t) : undefined
    Object.assign(props, {
      Id: u.full,
      Description: t?.description ?? '',
      LoadState: t ? 'loaded' : 'not-found',
      ActiveState: t?.active ? 'active' : 'inactive',
      SubState: t?.active ? 'waiting' : 'dead',
      UnitFileState: t ? (t.enabled ? 'enabled' : 'disabled') : '',
      Unit: t ? `${t.unit}.service` : '',
      TimersCalendar: t?.onCalendar.map((c) => `{ OnCalendar=${normalizeCalendar(c)} ; next_elapse=${next ? systemdDate(next) : 'n/a'} }`).join(' ') ?? '',
      Persistent: t?.persistent ? 'yes' : 'no',
      LastTriggerUSec: t?.last ? systemdDate(t.last) : 'n/a',
      NextElapseUSecRealtime: next ? systemdDate(next) : '',
      FragmentPath: t?.path ?? '',
    })
  } else {
    const svc = findService(sys, u.name)
    const def = svc?.unit
    Object.assign(props, {
      Id: `${u.name}.service`,
      Names: `${u.name}.service`,
      Description: svc?.description ?? '',
      LoadState: !svc ? 'not-found' : svc.masked ? 'masked' : def?.errors.length ? 'bad-setting' : 'loaded',
      ActiveState: svc?.active ? 'active' : svc?.failed ? 'failed' : 'inactive',
      SubState: svc?.active ? (def?.type === 'oneshot' ? 'exited' : 'running') : svc?.failed ? 'failed' : 'dead',
      UnitFileState: svc ? unitFileState(svc) : '',
      Result: svc?.result ?? 'success',
      Type: def?.type ?? 'simple',
      Restart: def?.restart ?? 'no',
      RestartUSec: def?.restartSec ?? '100ms',
      NRestarts: '0',
      MainPID: String(svc?.pid ?? 0),
      ExecMainStatus: svc?.lastExit ? svc.lastExit.status.split('/')[0] : '0',
      User: def?.user ?? '',
      Group: def?.group ?? '',
      WorkingDirectory: def?.workingDirectory ?? '',
      ExecStart: def?.execStart.map((e) => `{ path=${execParts(e).exe} ; argv[]=${execParts(e).cmd} }`).join(' ') ?? '',
      Requires: def?.requires.join(' ') ?? '',
      Wants: def?.wants.join(' ') ?? '',
      After: def?.after.join(' ') ?? '',
      WantedBy: svc?.enabled ? (def?.wantedBy.join(' ') ?? '') : '',
      FragmentPath: def?.path ?? '',
      DropInPaths: def?.dropins.join(' ') ?? '',
      ActiveEnterTimestamp: svc?.active ? systemdDate(svc.since) : '',
      NeedDaemonReload: needsReload(sys, `${u.name}.service`) ? 'yes' : 'no',
    })
  }
  const keys = o.props.length ? o.props : Object.keys(props)
  for (const k of keys) {
    const v = props[k] ?? ''
    ctx.out(o.flags.has('value') ? `${v}\n` : `${k}=${v}\n`)
  }
  return 0
}

function listDependencies(ctx: CommandContext, arg: string | undefined, o: Opts): number {
  const sys = ctx.sys
  const tty = ctx.isTTY
  const dot = (on: boolean, failed = false) => (failed ? RED('●', tty) : on ? GREEN('●', tty) : RED('○', tty))
  const target = arg ?? sys.defaultTarget
  const u = splitUnit(target)
  if (o.flags.has('reverse')) {
    ctx.out(`${u.full}\n`)
    const parents: string[] = []
    if (u.kind === 'service') {
      const svc = findService(sys, u.name)
      if (svc?.enabled) parents.push(...(svc.unit?.wantedBy.length ? svc.unit.wantedBy : ['multi-user.target']))
      const t = triggeredBy(sys, u.name)
      if (t) parents.push(`${t.name}.timer`)
    } else if (u.kind === 'timer') parents.push('timers.target')
    else if (u.full === 'multi-user.target') parents.push('graphical.target')
    parents.forEach((p, i) => ctx.out(`${dot(true)} ${i === parents.length - 1 ? '└─' : '├─'}${p}\n`))
    return 0
  }
  ctx.out(`${u.full}\n`)
  let children: { name: string; on: boolean; failed?: boolean }[] = []
  if (u.kind === 'target') {
    if (u.full === 'multi-user.target' || u.full === 'graphical.target' || u.full === 'default.target') {
      if (u.full === 'graphical.target') children.push({ name: 'multi-user.target', on: true })
      children.push(
        ...[...sys.services.values()].filter((s) => s.enabled).map((s) => ({ name: `${s.name}.service`, on: s.active, failed: s.failed })),
        { name: 'basic.target', on: true },
        { name: 'getty.target', on: true },
        { name: 'remote-fs.target', on: true },
      )
    } else if (u.full === 'timers.target') children = [...sys.timers.values()].filter((t) => t.enabled).map((t) => ({ name: `${t.name}.timer`, on: t.active }))
    else if (u.full === 'basic.target') children = [{ name: 'paths.target', on: true }, { name: 'slices.target', on: true }, { name: 'sockets.target', on: true }, { name: 'sysinit.target', on: true }, { name: 'timers.target', on: true }]
    else if (u.full === 'rescue.target') children = [{ name: 'rescue.service', on: false }, { name: 'sysinit.target', on: true }]
  } else if (u.kind === 'timer') {
    children = [{ name: 'sysinit.target', on: true }, { name: 'time-set.target', on: true }]
  } else {
    const svc = findService(sys, u.name)
    if (!svc) {
      ctx.out('')
      return 0
    }
    children = [...(svc.unit?.requires ?? []), ...(svc.unit?.wants ?? [])].map((n) => ({ name: n, on: true }))
    children.push({ name: 'system.slice', on: true }, { name: 'sysinit.target', on: true })
  }
  children.sort((a, b) => Number(a.name.endsWith('.target')) - Number(b.name.endsWith('.target')) || a.name.localeCompare(b.name))
  children.forEach((c, i) => ctx.out(`${dot(c.on, c.failed)} ${i === children.length - 1 ? '└─' : '├─'}${c.name}\n`))
  return 0
}

async function enableUnit(ctx: CommandContext, verb: 'enable' | 'disable', u: { name: string; kind: Kind; full: string }, now: boolean): Promise<number> {
  const sys = ctx.sys
  const want = verb === 'enable'
  if (u.kind === 'timer') {
    const t = findTimer(sys, u.name)
    if (!t) {
      ctx.err(`Failed to ${verb} unit: Unit file ${u.full} does not exist.\n`)
      return 1
    }
    if (ctx.sh.user !== 'root') {
      ctx.err(`Failed to ${verb} unit: Access denied\n`)
      return 1
    }
    if (!t.hasInstall) {
      noInstall(ctx)
      if (now) return (want ? startTimer(ctx, t) : (stopTimer(ctx, t), true)) ? 0 : 1
      return 0
    }
    if (t.enabled !== want) {
      t.enabled = want
      const wants = t.wantedBy[0] ?? 'timers.target'
      ctx.err(want ? `Created symlink '/etc/systemd/system/${wants}.wants/${u.full}' → '${t.path}'.\n` : `Removed '/etc/systemd/system/${wants}.wants/${u.full}'.\n`)
    }
    if (now) {
      if (want) return startTimer(ctx, t) ? 0 : 1
      stopTimer(ctx, t)
    }
    return 0
  }
  const svc = findService(sys, u.name)
  if (!svc) {
    ctx.err(`Failed to ${verb} unit: Unit file ${u.name}.service does not exist.\n`)
    return 1
  }
  if (ctx.sh.user !== 'root') {
    ctx.err(`Failed to ${verb} unit: Access denied\n`)
    return 1
  }
  if (svc.masked && want) {
    ctx.err(`Failed to enable unit: Unit file /etc/systemd/system/${u.name}.service is masked.\n`)
    return 1
  }
  if (svc.unit && !svc.unit.hasInstall) {
    noInstall(ctx)
  } else if (svc.enabled !== want) {
    svc.enabled = want
    const wants = svc.unit?.wantedBy[0] ?? 'multi-user.target'
    const path = svc.unit?.path ?? `/usr/lib/systemd/system/${u.name}.service`
    ctx.err(want ? `Created symlink '/etc/systemd/system/${wants}.wants/${u.name}.service' → '${path}'.\n` : `Removed '/etc/systemd/system/${wants}.wants/${u.name}.service'.\n`)
  }
  if (now) {
    if (want) return (await startService(ctx, svc)) ? 0 : 1
    stopService(ctx, svc)
  }
  return 0
}

function noInstall(ctx: CommandContext) {
  ctx.err(
    'The unit files have no installation config (WantedBy=, RequiredBy=, UpheldBy=,\nAlso=, or Alias= settings in the [Install] section, and DefaultInstance= for\ntemplate units). This means they are not meant to be enabled or disabled using systemctl.\n \nPossible reasons for having these kinds of units are:\n• A unit may be statically enabled by being symlinked from another unit\'s\n  .wants/, .requires/, or .upholds/ directory.\n• A unit\'s purpose may be to act as a helper for some other unit which has\n  a requirement dependency on it.\n• A unit may be started when needed via activation (socket, path, timer,\n  D-Bus, udev, scripted systemctl call, ...).\n• In case of template units, the unit is meant to be enabled with some\n  instance name specified.\n',
  )
}

register('systemctl', {
  usage: 'systemctl [OPTIONS...] COMMAND [UNIT...]',
  summary:
    '  status | start | stop | restart | reload | enable [--now] | disable [--now] | is-active | is-enabled | is-failed\n  list-units [--type=service|timer] [--state=failed] | --failed | list-unit-files | list-timers | list-dependencies\n  cat | edit [--full] | show [-p PROP] | daemon-reload | mask | unmask | reset-failed | get-default | set-default | isolate',
  async run(ctx) {
    const o = parseOpts(ctx.args)
    const [verbIn, ...args] = o.rest
    const verb = verbIn ?? 'list-units'
    const sys = ctx.sys
    const units = args.map(splitUnit)
    const now = o.flags.has('now')
    o.rest = args
    switch (verb) {
      case 'list-units':
        return listUnits(ctx, o)
      case 'list-unit-files':
        return listUnitFiles(ctx, o)
      case 'list-timers':
        return listTimers(ctx, o)
      case 'list-dependencies':
        return listDependencies(ctx, args[0], o)
      case 'status': {
        if (!units.length) {
          const failed = [...sys.services.values()].filter((s) => s.failed).length
          ctx.out(`● ${sys.hostname}\n    State: ${failed ? RED('degraded', ctx.isTTY) : GREEN('running', ctx.isTTY)}\n    Units: ${sys.services.size + sys.timers.size + Object.keys(TARGETS).length} loaded (incl. loaded aliases)\n     Jobs: 0 queued\n   Failed: ${failed} units\n    Since: ${systemdDate(sys.bootTime)}; ${ago(sys.bootTime)}\n`)
          return 0
        }
        let code = 0
        units.forEach((u, i) => {
          if (i) ctx.out('\n')
          if (u.kind === 'timer') {
            const t = findTimer(sys, u.name)
            if (!t) {
              ctx.err(`Unit ${u.full} could not be found.\n`)
              code = 4
              return
            }
            ctx.out(timerStatus(ctx, t))
            reloadWarning(ctx, u.full)
            if (!t.active) code = 3
            return
          }
          if (u.kind === 'target' && TARGETS[u.full]) {
            ctx.out(targetStatus(ctx, u.full))
            return
          }
          const svc = u.kind === 'service' ? findService(sys, u.name) : undefined
          if (!svc) {
            ctx.err(`Unit ${u.full} could not be found.\n`)
            code = 4
            return
          }
          ctx.out(serviceStatus(ctx, svc))
          reloadWarning(ctx, u.full)
          if (!svc.active) code = 3
        })
        return code
      }
      case 'start':
      case 'restart':
      case 'reload':
      case 'try-restart':
      case 'reload-or-restart': {
        if (!units.length) {
          ctx.err('Too few arguments.\n')
          return 1
        }
        let code = 0
        for (const u of units) {
          if (u.kind === 'timer') {
            const t = findTimer(sys, u.name)
            if (!t) {
              ctx.err(`Failed to ${verb} ${u.full}: Unit ${u.full} not found.\n`)
              code = 5
              continue
            }
            if (accessDenied(ctx, verb, u.full)) return 1
            reloadWarning(ctx, u.full)
            if (verb === 'restart') stopTimer(ctx, t)
            if (!startTimer(ctx, t)) code = 1
            continue
          }
          if (u.kind === 'target') {
            ctx.err(`[simulador] Los targets se cambian con "systemctl isolate ${u.full}" o se eligen para el arranque con "systemctl set-default".\n`)
            continue
          }
          const svc = findService(sys, u.name)
          if (!svc) {
            ctx.err(`Failed to ${verb} ${u.full}: Unit ${u.full} not found.\n`)
            code = 5
            continue
          }
          if (accessDenied(ctx, verb, u.full)) return 1
          reloadWarning(ctx, u.full)
          if (verb === 'try-restart' && !svc.active) continue
          if (verb === 'reload') {
            if (!svc.active) {
              ctx.err(`Job for ${u.full} invalid.\n`)
              code = 1
              continue
            }
            const err = SERVICE_CHECKS[svc.name]?.(ctx)
            if (err) {
              ctx.err(`Job for ${u.full} failed.\nSee "systemctl status ${u.full}" and "journalctl -xeu ${u.full}" for details.\n`)
              journal(sys, u.full, err, 3, svc.name, svc.pid)
              code = 1
            } else {
              journal(sys, u.full, `Reloading ${u.full} - ${svc.description}...`)
              journal(sys, u.full, `Reloaded ${u.full} - ${svc.description}.`)
            }
            continue
          }
          if (verb !== 'start') stopService(ctx, svc)
          if (!(await startService(ctx, svc, verb))) code = 1
        }
        return code
      }
      case 'stop': {
        for (const u of units) {
          if (u.kind === 'timer') {
            const t = findTimer(sys, u.name)
            if (!t) {
              ctx.err(`Failed to stop ${u.full}: Unit ${u.full} not loaded.\n`)
              return 5
            }
            if (accessDenied(ctx, 'stop', u.full)) return 1
            stopTimer(ctx, t)
            continue
          }
          const svc = findService(sys, u.name)
          if (!svc) {
            ctx.err(`Failed to stop ${u.full}: Unit ${u.full} not loaded.\n`)
            return 5
          }
          if (accessDenied(ctx, 'stop', u.full)) return 1
          stopService(ctx, svc)
        }
        return 0
      }
      case 'enable':
      case 'disable':
      case 'reenable': {
        if (!units.length) {
          ctx.err('Too few arguments.\n')
          return 1
        }
        let code = 0
        for (const u of units) {
          if (verb === 'reenable') {
            await enableUnit(ctx, 'disable', u, false)
            code ||= await enableUnit(ctx, 'enable', u, false)
          } else code ||= await enableUnit(ctx, verb, u, now)
        }
        return code
      }
      case 'is-active':
      case 'is-failed':
      case 'is-enabled': {
        let code = verb === 'is-failed' ? 1 : 0
        let anyOk = false
        for (const u of units) {
          let st: string
          if (u.kind === 'timer') {
            const t = findTimer(sys, u.name)
            st = verb === 'is-enabled' ? (t ? (t.masked ? 'masked' : !t.hasInstall ? 'static' : t.enabled ? 'enabled' : 'disabled') : 'not-found') : t?.active ? 'active' : 'inactive'
          } else if (u.kind === 'target' && TARGETS[u.full]) {
            st = verb === 'is-enabled' ? (u.full === 'multi-user.target' ? 'indirect' : 'static') : ACTIVE_TARGETS.includes(u.full) ? 'active' : 'inactive'
          } else {
            const svc = findService(sys, u.name)
            if (verb === 'is-enabled') {
              if (!svc) {
                ctx.err(`Failed to get unit file state for ${u.full}: No such file or directory\n`)
                return 1
              }
              st = unitFileState(svc)
            } else st = svc ? (svc.active ? 'active' : svc.failed ? 'failed' : 'inactive') : 'inactive'
          }
          if (!o.flags.has('quiet')) ctx.out(st + '\n')
          const ok = verb === 'is-active' ? st === 'active' : verb === 'is-failed' ? st === 'failed' : ['enabled', 'static', 'indirect', 'alias'].includes(st)
          if (ok) anyOk = true
          if (!ok && verb !== 'is-failed') code = verb === 'is-enabled' ? 1 : 3
        }
        if (verb === 'is-failed') return anyOk ? 0 : 1
        return code
      }
      case 'daemon-reload':
      case 'daemon-reexec': {
        if (ctx.sh.user !== 'root') {
          ctx.err('Failed to reload daemon: Access denied\n')
          return 1
        }
        daemonReload(sys)
        // Las advertencias de sintaxis quedan en el journal, como en un servidor real.
        for (const s of sys.services.values()) for (const w of s.unit?.custom || s.unit?.dropins.length ? s.unit.warnings : []) journal(sys, `${s.name}.service`, `${w.file}${w.line ? ':' + w.line : ''}: ${w.message}`, 4)
        for (const t of sys.timers.values()) for (const w of t.warnings) journal(sys, `${t.name}.timer`, `${w.file}${w.line ? ':' + w.line : ''}: ${w.message}`, 4)
        journal(sys, 'init.scope', 'Reloading requested from client PID ' + sys.allocPid() + ' (systemctl)...')
        journal(sys, 'init.scope', 'Reloading finished in 112 ms.')
        return 0
      }
      case 'cat': {
        if (!units.length) {
          ctx.err('Too few arguments.\n')
          return 1
        }
        let code = 0
        units.forEach((u, i) => {
          if (i) ctx.out('\n')
          code ||= catUnit(ctx, u)
        })
        return code
      }
      case 'show':
        return showProps(ctx, units[0] ?? { name: 'systemd', kind: 'service', full: 'systemd' }, o)
      case 'edit': {
        const u = units[0]
        if (!u) {
          ctx.err('Too few arguments.\n')
          return 1
        }
        if (ctx.sh.user !== 'root') {
          ctx.err(`Failed to edit ${u.full}: Access denied\n`)
          return 1
        }
        const exists = u.kind === 'timer' ? findTimer(sys, u.name) : findService(sys, u.name)
        if (!exists && !o.flags.has('force')) {
          ctx.err(`No files found for ${u.full}.\nRun 'systemctl edit --force --full ${u.full}' to create a new unit.\n`)
          return 1
        }
        if (o.flags.has('full')) {
          const path = `/etc/systemd/system/${u.full}`
          let content = ''
          if (sys.vfs.exists(path)) content = sys.vfs.readFile(path, ROOT_CRED)
          else if (exists && u.kind === 'service') content = vendorUnitText(exists as Service)
          ctx.sh.pendingEditor = { path, content, editor: 'systemctl edit' }
          return 0
        }
        const dir = `/etc/systemd/system/${u.full}.d`
        const path = `${dir}/override.conf`
        sys.vfs.mkdirp(dir, ROOT_CRED)
        const svc = u.kind === 'service' ? (exists as Service | undefined) : undefined
        const original = svc ? (svc.unit?.custom ? sys.vfs.readFile(svc.unit.path, ROOT_CRED) : vendorUnitText(svc)) : ''
        const current = sys.vfs.exists(path) ? sys.vfs.readFile(path, ROOT_CRED) : ''
        const content =
          `### Editing ${path}\n### Anything between here and the comment below will become the contents of the drop-in file\n\n${current}\n` +
          `### Edits below this comment will be discarded\n` +
          (svc ? `\n\n### ${svc.unit?.path ?? `/usr/lib/systemd/system/${u.full}`}\n${original.trimEnd().split('\n').map((l) => (l ? `# ${l}` : '#')).join('\n')}\n` : '')
        ctx.sh.pendingEditor = { path, content, editor: 'systemctl edit' }
        return 0
      }
      case 'mask':
      case 'unmask': {
        let code = 0
        for (const u of units) {
          if (accessDenied(ctx, verb, u.full)) return 1
          const target: { masked?: boolean; enabled: boolean } | undefined = u.kind === 'timer' ? findTimer(sys, u.name) : findService(sys, u.name)
          if (!target) {
            ctx.err(`Failed to ${verb} unit: Unit ${u.full} does not exist.\n`)
            code = 1
            continue
          }
          const link = `/etc/systemd/system/${u.full}`
          if (verb === 'mask') {
            if (customFragment(sys, u.full)) {
              ctx.err(`Failed to mask unit: File ${link} already exists.\n`)
              code = 1
              continue
            }
            target.masked = true
            target.enabled = false
            if (!sys.vfs.exists(link)) sys.vfs.symlink('/dev/null', link, ROOT_CRED)
            ctx.err(`Created symlink '${link}' → '/dev/null'.\n`)
          } else if (target.masked) {
            target.masked = false
            if (sys.vfs.exists(link) && !customFragment(sys, u.full)) sys.vfs.unlink(link, ROOT_CRED)
            ctx.err(`Removed '${link}'.\n`)
          }
        }
        return code
      }
      case 'reset-failed':
        for (const s of sys.services.values()) {
          if (units.length && !units.some((u) => u.name === s.name)) continue
          s.failed = false
        }
        return 0
      case 'kill': {
        const svc = units[0] ? findService(sys, units[0].name) : undefined
        if (!svc) {
          ctx.err(`Failed to kill unit ${units[0]?.full ?? ''}: Unit not loaded.\n`)
          return 1
        }
        if (accessDenied(ctx, 'kill', units[0].full)) return 1
        const sig = (o.signal ?? 'TERM').replace(/^SIG/, '')
        if (['TERM', 'KILL', '9', '15'].includes(sig)) {
          stopService(ctx, svc)
          if (sig === 'KILL' || sig === '9') {
            svc.failed = true
            svc.result = 'signal'
          }
        }
        return 0
      }
      case 'get-default':
        ctx.out(sys.defaultTarget + '\n')
        return 0
      case 'set-default': {
        const t = args[0]
        if (!t) {
          ctx.err('Too few arguments.\n')
          return 1
        }
        if (ctx.sh.user !== 'root') {
          ctx.err('Failed to set default target: Access denied\n')
          return 1
        }
        if (!TARGETS[t]) {
          ctx.err(`Failed to set default target: Unit file ${t} does not exist.\n`)
          return 1
        }
        sys.defaultTarget = t
        try {
          sys.vfs.unlink('/etc/systemd/system/default.target', ROOT_CRED)
        } catch {
          // no había enlace
        }
        sys.vfs.symlink(`/usr/lib/systemd/system/${t}`, '/etc/systemd/system/default.target', ROOT_CRED)
        ctx.err(`Removed '/etc/systemd/system/default.target'.\nCreated symlink '/etc/systemd/system/default.target' → '/usr/lib/systemd/system/${t}'.\n`)
        return 0
      }
      case 'isolate':
      case 'rescue':
      case 'emergency':
      case 'default': {
        if (ctx.sh.user !== 'root') {
          ctx.err('Failed to start target: Access denied\n')
          return 1
        }
        const t = verb === 'isolate' ? args[0] : verb === 'default' ? sys.defaultTarget : `${verb}.target`
        ctx.err(
          `[simulador] En un servidor real, pasar a ${t} detiene todo lo que ese target no necesita${t === 'rescue.target' || t === 'emergency.target' ? ': se cortan las sesiones SSH y solo queda la consola' : ''}. Aquí no se cambia de target para que no pierdas la sesión.\n`,
        )
        return 0
      }
      case 'reboot':
      case 'poweroff':
      case 'halt':
        if (ctx.sh.user !== 'root') {
          ctx.err('Call to Reboot failed: Access denied\n')
          return 1
        }
        ctx.err('[simulador] El servidor no se reinicia ni se apaga en el simulador.\n')
        return 0
      default:
        ctx.err(`Unknown command verb '${verb}'.\n`)
        return 1
    }
  },
})

// ---------------------------------------------------------------------------------------
// systemd-analyze
// ---------------------------------------------------------------------------------------

register('systemd-analyze', {
  usage: 'systemd-analyze [OPTIONS...] COMMAND ...',
  summary: '  time | blame | critical-chain | calendar EXPR | timespan VALUE | verify FILE...',
  async run(ctx) {
    const [verb = 'time', ...rest] = ctx.args.filter((a) => !a.startsWith('--'))
    const sys = ctx.sys
    switch (verb) {
      case 'time':
        ctx.out(
          sys.firmware === 'uefi'
            ? 'Startup finished in 1.912s (firmware) + 1.204s (loader) + 1.517s (kernel) + 3.288s (initrd) + 9.874s (userspace) = 17.795s\nmulti-user.target reached after 9.861s in userspace.\n'
            : 'Startup finished in 1.517s (kernel) + 3.288s (initrd) + 9.874s (userspace) = 14.679s\nmulti-user.target reached after 9.861s in userspace.\n',
        )
        return 0
      case 'blame': {
        const base: [string, string][] = [
          ['5.402s', sys.distro === 'rocky' ? 'NetworkManager-wait-online.service' : 'systemd-networkd-wait-online.service'],
          ['2.118s', sys.distro === 'rocky' ? 'dnf-makecache.service' : 'apt-daily.service'],
          ['1.301s', 'kdump.service'],
          ['812ms', 'firewalld.service'],
        ]
        for (const s of sys.services.values()) if (s.enabled && !base.some((b) => b[1] === `${s.name}.service`)) base.push([`${100 + ((s.name.length * 37) % 400)}ms`, `${s.name}.service`])
        base.push(['94ms', 'systemd-journald.service'], ['61ms', 'systemd-udevd.service'], ['33ms', 'systemd-tmpfiles-setup.service'])
        for (const [t, n] of base) ctx.out(`${t.padStart(7)} ${n}\n`)
        return 0
      }
      case 'critical-chain':
        ctx.out(`The time when unit became active or started is printed after the "@" character.\nThe time the unit took to start is printed after the "+" character.\n\n${sys.defaultTarget} @9.861s\n└─${sys.distro === 'rocky' ? 'sshd' : 'ssh'}.service @9.640s +219ms\n  └─network.target @9.611s\n    └─${sys.distro === 'rocky' ? 'NetworkManager' : 'systemd-networkd'}.service @4.181s +402ms\n      └─basic.target @4.120s\n        └─sysinit.target @4.103s\n`)
        return 0
      case 'calendar': {
        const expr = ctx.args.slice(ctx.args.indexOf('calendar') + 1).filter((a) => !a.startsWith('--')).join(' ')
        const iterations = Number(/--iterations=(\d+)/.exec(ctx.args.join(' '))?.[1] ?? 1)
        const spec = parseCalendar(expr)
        if (!spec) {
          ctx.err(`Failed to parse calendar specification '${expr}': Invalid argument\nHint: this expression is a valid timestamp. Use 'systemd-analyze timestamp "${expr}"' instead?\n`.replace(/Hint.*\n$/, /^\d{4}-\d{2}-\d{2}/.test(expr) ? '$&' : ''))
          return 1
        }
        ctx.out(`  Original form: ${expr}\nNormalized form: ${normalizeCalendar(spec)}\n`)
        let from = Date.now()
        for (let i = 0; i < iterations; i++) {
          const next = calendarNext(spec, from)
          if (!next) break
          ctx.out(`${i === 0 ? '    Next elapse' : `       Iter. #${i + 1}`}: ${systemdDate(next)}\n`)
          if (i === 0) ctx.out(`       From now: ${timespan(next - Date.now())} left\n`)
          from = next
        }
        return 0
      }
      case 'verify': {
        let code = 0
        for (const f of rest) {
          const path = ctx.sh.resolve(f)
          if (!sys.vfs.exists(path)) {
            ctx.err(`Failed to prepare filename ${f}: No such file or directory\n`)
            code = 1
            continue
          }
          const text = sys.vfs.readFile(path, ctx.sh.cred)
          const { sections, warnings } = parseUnitFiles([{ path, text }])
          for (const w of warnings) ctx.err(`${path}:${w.line}: ${w.message}\n`)
          const name = path.split('/').pop()!
          if (name.endsWith('.service')) {
            const ex = sections.get('Service')?.get('ExecStart') ?? []
            const type = sections.get('Service')?.get('Type')?.at(-1) ?? 'simple'
            if (!ex.length) {
              ctx.err(`${name}: Service has no ExecStart=, ExecStop=, or SuccessAction=. Refusing.\n`)
              code = 1
            } else if (ex.length > 1 && type !== 'oneshot') {
              ctx.err(`${name}: Service has more than one ExecStart= setting, which is only allowed for Type=oneshot services. Refusing.\n`)
              code = 1
            }
            for (const e of ex) {
              const exe = execParts(e).exe
              if (exe.startsWith('/') && !sys.vfs.exists(exe)) {
                ctx.err(`${name}: Command ${exe} is not executable: No such file or directory\n`)
                code = 1
              }
            }
          }
          if (name.endsWith('.timer')) {
            const cal = sections.get('Timer')?.get('OnCalendar') ?? []
            for (const c of cal) if (!parseCalendar(c)) ctx.err(`${path}: Failed to parse calendar specification, ignoring: ${c}\n`)
            const target = sections.get('Timer')?.get('Unit')?.at(-1) ?? name.replace(/\.timer$/, '.service')
            if (!sys.vfs.exists(`/etc/systemd/system/${target}`) && !sys.services.has(target.replace(/\.service$/, ''))) {
              ctx.err(`${name}: Failed to create ${name}/start: Unit ${target} not found.\n`)
              code = 1
            }
            if (!cal.some((c) => parseCalendar(c)) && !sections.get('Timer')?.size) {
              ctx.err(`${name}: Timer unit lacks value setting. Refusing.\n`)
              code = 1
            }
          }
          if (warnings.length) code = code || 0
        }
        return code
      }
      case 'timespan': {
        for (const v of rest) {
          const n = parseTimespan(v)
          if (n === undefined) {
            ctx.err(`Failed to parse time span '${v}': Invalid argument\n`)
            return 1
          }
          ctx.out(`Original: ${v}\n      μs: ${Math.round(n * 1e6)}\n   Human: ${timespan(n * 1000)}\n`)
        }
        return 0
      }
      default:
        ctx.err(`Unknown command verb '${verb}'.\n`)
        return 1
    }
  },
})
