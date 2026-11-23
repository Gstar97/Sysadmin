/**
 * rsyslog en el laboratorio simulado. Lee su configuración al arrancar (con los include), y cada
 * mensaje local (logger, sshd) pasa por sus reglas: se escribe en los archivos que digan los
 * selectores y se reenvía por TCP o UDP a otros equipos, que lo reciben si tienen rsyslog con
 * imtcp/imudp en ese puerto y el firewall lo deja pasar. Con una cola (queue.type) los mensajes
 * esperan a que vuelva el servidor; sin cola, por TCP se pierden con un aviso y por UDP sin aviso.
 * "rsyslogd -N1" revisa la configuración con los mensajes del real.
 */
import { register } from './shell'
import { System } from './system'
import { ROOT_CRED } from './vfs'
import { hostByIp, inbound, sourceIp } from './hosts'
import { reach } from './http'
import { EXEC_CHECKS } from './commands/systemd'
import { SERVICE_CHECKS } from './commands/sysinfo'
import { VENDOR_UNITS } from './units'
import { SERVICE_LISTEN } from './commands/net'
import { avc, portType } from './selinux'
import { evaluateRsyslog, formatRsyslogError, MAIN_RULESET, parseRsyslog, renderTemplate, RSYSLOG_VERSION, templateText, type RsAction, type RsConfig, type RsInput, type RsMessage } from '../config/rsyslog'

const VERSION_ROCKY = `${RSYSLOG_VERSION}-1.el10`

VENDOR_UNITS['rsyslog'] = `[Unit]\nDescription=System Logging Service\nDocumentation=man:rsyslogd(8)\nDocumentation=https://www.rsyslog.com/doc/\nWants=network.target network-online.target\nAfter=network.target network-online.target\n\n[Service]\nType=notify\nExecStart=/usr/sbin/rsyslogd -n -iNONE\nExecReload=/usr/bin/kill -HUP $MAINPID\nUMask=0066\nStandardOutput=null\nRestart=on-failure\n\n# Increase the default a bit in order to allow many simultaneous\n# files to be monitored, we might need a lot of fds.\nLimitNOFILE=16384\n\n[Install]\nWantedBy=multi-user.target\nAlias=syslog.service\n`

interface Runtime {
  cfg: RsConfig
  /** Entradas de red que pudieron abrir su puerto. */
  listening: RsInput[]
}
const RT = new WeakMap<System, Runtime>()

interface Pending {
  action: Extract<RsAction, { kind: 'fwd' }>
  msg: RsMessage
}
const QUEUES = new WeakMap<System, Map<string, Pending[]>>()
const SUSPENDED = new WeakMap<System, Set<string>>()

function version(sys: System): string {
  return sys.distro === 'rocky' ? VERSION_ROCKY : RSYSLOG_VERSION
}

function glob(sys: System, pattern: string): string[] {
  if (!/[*?[]/.test(pattern)) return sys.vfs.exists(pattern) ? [pattern] : []
  const dir = pattern.slice(0, pattern.lastIndexOf('/')) || '/'
  const base = pattern.slice(pattern.lastIndexOf('/') + 1)
  const re = new RegExp(`^${base.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`)
  try {
    return sys.vfs
      .readdir(dir, ROOT_CRED)
      .filter((e) => re.test(e))
      .sort()
      .map((e) => `${dir}/${e}`)
      .filter((p) => sys.vfs.stat(p, ROOT_CRED).type === 'file')
  } catch {
    return []
  }
}

export function loadRsyslog(sys: System, file = '/etc/rsyslog.conf'): RsConfig {
  let text: string
  try {
    text = sys.vfs.readFile(file, ROOT_CRED)
  } catch {
    const cfg = parseRsyslog('', file)
    cfg.errors.push({ file, line: 0, message: `could not open config file '${file}': No such file or directory`, code: 2013 })
    return cfg
  }
  return parseRsyslog(text, file, (pattern) => glob(sys, pattern).map((path) => ({ path, text: sys.vfs.readFile(path, ROOT_CRED) })))
}

function journal(sys: System, message: string, priority = 6) {
  const pid = sys.services.get('rsyslog')?.pid
  sys.journal.push({ time: Date.now(), unit: 'rsyslog.service', priority, message, ident: 'rsyslogd', pid })
}

/** Si SELinux deja que rsyslogd escuche en ese puerto. */
function selinuxBind(sys: System, i: RsInput): boolean {
  if (sys.distro !== 'rocky' || sys.selinux.mode === 'disabled') return true
  const t = portType(sys, i.protocol, i.port)
  if (['syslogd_port_t', 'syslog_tls_port_t'].includes(t) || i.port === 514) return true
  avc(sys, 'rsyslogd', 'name_bind', `src=${i.port}`, 'syslogd_t', `system_u:object_r:${t}:s0`, `${i.protocol}_socket`)
  return sys.selinux.mode === 'permissive'
}

function start(sys: System): Runtime {
  const cfg = loadRsyslog(sys)
  for (const e of cfg.errors) journal(sys, formatRsyslogError(e, version(sys)).replace(/^rsyslogd: /, ''), 3)
  const listening: RsInput[] = []
  for (const i of cfg.inputs) {
    if (selinuxBind(sys, i)) listening.push(i)
    else {
      journal(sys, `${i.type}: could not create ${i.protocol} listener, ignoring port ${i.port} bind-address (null). [v${version(sys)} try https://www.rsyslog.com/e/2077 ]`, 3)
      journal(sys, `cannot bind socket for port ${i.port}: Permission denied [v${version(sys)} try https://www.rsyslog.com/e/2077 ]`, 3)
    }
  }
  const rt = { cfg, listening }
  RT.set(sys, rt)
  journal(sys, `[origin software="rsyslogd" swVersion="${version(sys)}" x-pid="${sys.services.get('rsyslog')?.pid ?? 0}" x-info="https://www.rsyslog.com"] start`)
  return rt
}

function runtime(sys: System): Runtime | undefined {
  if (!sys.services.get('rsyslog')?.active || sys.poweredOff) return undefined
  return RT.get(sys) ?? start(sys)
}

/** Al arrancar: rsyslog arranca aunque haya errores; los anota y sigue con lo que entendió. */
function onStart(sys: System) {
  RT.delete(sys)
  QUEUES.delete(sys)
  queueMicrotask(() => {
    if (sys.services.get('rsyslog')?.active && !RT.has(sys)) start(sys)
  })
}
EXEC_CHECKS['rsyslogd'] = (ctx) => {
  onStart(ctx.sys)
  return undefined
}
SERVICE_CHECKS['rsyslog'] = (ctx) => {
  onStart(ctx.sys)
  return undefined
}

SERVICE_LISTEN['rsyslog'] = (sys) => {
  const rt = runtime(sys)
  return (rt?.listening ?? []).map((i) => ({ proto: i.protocol, local: '0.0.0.0', port: i.port, proc: 'rsyslogd' }))
}

// ---------------------------------------------------------------------------------------
// Mensajes
// ---------------------------------------------------------------------------------------

export interface LocalMessage {
  facility: string
  severity: string
  tag: string
  pid?: number
  msg: string
  time?: number
}

/**
 * Un mensaje generado en este equipo, con la hora de SU reloj (si está desfasado, el servidor
 * central recibe la hora mal). Devuelve false si rsyslog no está andando (el que llama lo escribe
 * directamente, como hacía journald solo).
 */
export function emitSyslog(sys: System, m: LocalMessage): boolean {
  const rt = runtime(sys)
  if (!rt) return false
  // Sin imjournal ni imuxsock, rsyslog no recibe los mensajes locales.
  if (!rt.cfg.modules.has('imjournal') && !rt.cfg.modules.has('imuxsock')) return true
  flushQueues(sys)
  const msg: RsMessage = { facility: m.facility, severity: m.severity, hostname: sys.hostname, fromhost: sys.hostname, fromhostIp: '127.0.0.1', programname: m.tag, pid: m.pid, msg: m.msg, time: m.time ?? Date.now() + sys.clock.offset * 1000, inputname: rt.cfg.modules.has('imjournal') ? 'imjournal' : 'imuxsock' }
  process(sys, rt, msg, MAIN_RULESET, 0)
  return true
}

function process(sys: System, rt: Runtime, msg: RsMessage, ruleset: string, depth: number) {
  for (const a of evaluateRsyslog(rt.cfg, msg, ruleset)) {
    if (a.kind === 'file') writeFile(sys, rt, a, msg)
    else if (a.kind === 'fwd') forward(sys, a, msg, depth)
  }
}

function writeFile(sys: System, rt: Runtime, a: Extract<RsAction, { kind: 'file' }>, msg: RsMessage) {
  if (a.disabled) return
  let path = a.path
  if (a.dynaFile) path = renderTemplate(templateText(rt.cfg, a.dynaFile, a.dynaFile), msg).trim()
  if (!path || !path.startsWith('/')) return
  const line = renderTemplate(templateText(rt.cfg, a.template, rt.cfg.fileTemplate), msg)
  try {
    const dir = path.slice(0, path.lastIndexOf('/')) || '/'
    if (!sys.vfs.exists(dir)) sys.vfs.mkdirp(dir, ROOT_CRED, 0o755)
    const fresh = !sys.vfs.exists(path)
    sys.vfs.writeFile(path, line.endsWith('\n') ? line : `${line}\n`, ROOT_CRED, { append: true })
    if (fresh) {
      if (sys.distro === 'ubuntu') {
        sys.vfs.chmod(path, 0o640, ROOT_CRED)
        const u = sys.users.get('syslog')
        const g = sys.groups.get('adm')
        sys.vfs.chown(path, u?.uid, g?.gid, ROOT_CRED)
      } else sys.vfs.chmod(path, 0o644, ROOT_CRED)
    }
  } catch {
    journal(sys, `file '${path}': open error: Permission denied [v${version(sys)} try https://www.rsyslog.com/e/2433 ]`, 3)
  }
}

type Delivery = { ok: true; target: System; input: RsInput; clientIp: string } | { ok: false; why: 'resolve' | 'refused' | 'noroute' | 'timeout' | 'lost'; ip?: string }

function deliverTo(sys: System, a: Extract<RsAction, { kind: 'fwd' }>): Delivery {
  const ip = /^\d+\.\d+\.\d+\.\d+$/.test(a.target) ? a.target : a.target === 'localhost' ? '127.0.0.1' : sys.resolveHost(a.target)
  if (!ip) return { ok: false, why: 'resolve' }
  if (a.protocol === 'tcp') {
    const r = reach(sys, ip, a.port)
    if ('error' in r) return { ok: false, why: r.error === 'noroute' ? 'noroute' : 'timeout', ip }
    const rt = runtime(r.target)
    const input = rt?.listening.find((i) => i.protocol === 'tcp' && i.port === a.port)
    if (!rt || !input) return { ok: false, why: 'refused', ip }
    return { ok: true, target: r.target, input, clientIp: r.clientIp }
  }
  // UDP: se manda y no hay forma de saber si llegó.
  const target = ip.startsWith('127.') || sys.ownIps().includes(ip) ? sys : hostByIp(sys, ip)
  if (!target || target.poweredOff) return { ok: false, why: 'lost', ip }
  const clientIp = target === sys ? ip : sourceIp(sys, ip)
  if (target !== sys && inbound(target, a.port, 'udp', clientIp) !== 'ok') return { ok: false, why: 'lost', ip }
  const rt = runtime(target)
  const input = rt?.listening.find((i) => i.protocol === 'udp' && i.port === a.port)
  if (!rt || !input) return { ok: false, why: 'lost', ip }
  return { ok: true, target, input, clientIp }
}

function receive(d: Extract<Delivery, { ok: true }>, msg: RsMessage, from: System, depth: number) {
  const rt = runtime(d.target)!
  const remote: RsMessage = { ...msg, fromhost: from.hostname, fromhostIp: d.clientIp, inputname: d.input.type }
  process(d.target, rt, remote, d.input.ruleset && rt.cfg.rulesets.has(d.input.ruleset) ? d.input.ruleset : MAIN_RULESET, depth + 1)
}

function forward(sys: System, a: Extract<RsAction, { kind: 'fwd' }>, msg: RsMessage, depth: number) {
  if (depth > 3) return
  const d = deliverTo(sys, a)
  const sus = SUSPENDED.get(sys) ?? new Set<string>()
  SUSPENDED.set(sys, sus)
  if (d.ok) {
    if (sus.delete(a.id)) journal(sys, `action '${a.id}' resumed (module 'builtin:omfwd') [v${version(sys)} try https://www.rsyslog.com/e/2359 ]`, 6)
    receive(d, msg, sys, depth)
    return
  }
  if (a.protocol === 'tcp' || d.why === 'resolve') {
    if (!sus.has(a.id)) {
      sus.add(a.id)
      const why = d.why === 'resolve' ? undefined : d.why === 'refused' ? 'Connection refused' : d.why === 'noroute' ? 'No route to host' : 'Connection timed out'
      if (why) journal(sys, `cannot connect to ${d.ip}:${a.port}: ${why} [v${version(sys)} try https://www.rsyslog.com/e/2027 ]`, 3)
      else journal(sys, `omfwd: could not get addrinfo for hostname '${a.target}':'${a.port}': Name or service not known [v${version(sys)} try https://www.rsyslog.com/e/2007 ]`, 3)
      journal(sys, `action '${a.id}' suspended (module 'builtin:omfwd'), retry 0. There should be messages before this one giving the reason for suspension. [v${version(sys)} try https://www.rsyslog.com/e/2007 ]`, 4)
    }
  }
  if (a.queued) {
    const q = QUEUES.get(sys) ?? new Map<string, Pending[]>()
    QUEUES.set(sys, q)
    const list = q.get(a.id) ?? []
    list.push({ action: a, msg })
    q.set(a.id, list)
  }
}

/** Reintenta lo que quedó en las colas (cuando el servidor vuelve). */
function flushQueues(sys: System) {
  const q = QUEUES.get(sys)
  if (!q) return
  for (const [id, list] of q) {
    if (!list.length) continue
    const d = deliverTo(sys, list[0].action)
    if (!d.ok) continue
    const sus = SUSPENDED.get(sys)
    if (sus?.delete(id)) journal(sys, `action '${id}' resumed (module 'builtin:omfwd') [v${version(sys)} try https://www.rsyslog.com/e/2359 ]`, 6)
    for (const p of list) receive(d, p.msg, sys, 0)
    q.set(id, [])
  }
}

System.syslogHook = emitSyslog

System.refreshHooks.push((sys) => {
  for (const h of [sys, ...sys.lab]) if (QUEUES.has(h) && h.services.get('rsyslog')?.active) flushQueues(h)
})

// ---------------------------------------------------------------------------------------
// rsyslogd -N1
// ---------------------------------------------------------------------------------------

register('rsyslogd', {
  usage: 'rsyslogd -N1 [-f ARCHIVO]   (revisa la configuración sin arrancar)',
  path: '/usr/sbin',
  run(ctx) {
    const args = ctx.args
    if (args.includes('-v') || args.includes('-version')) {
      ctx.out(`rsyslogd  ${version(ctx.sys)} (aka 2024.12) compiled with:\n\tPLATFORM:\t\t\t\tx86_64-redhat-linux-gnu\n\tFEATURE_REGEXP:\t\t\t\tYes\n\tGSSAPI Kerberos 5 support:\t\tYes\n\tFEATURE_DEBUG (debug build, slow code):\tNo\n\t32bit Atomic operations supported:\tYes\n\t64bit Atomic operations supported:\tYes\n\tmemory allocator:\t\t\tsystem default\n\tRuntime Instrumentation (slow code):\tNo\n\tuuid support:\t\t\t\tYes\n\tsystemd support:\t\t\tYes\n\tConfig file:\t\t\t\t/etc/rsyslog.conf\n\tPID file:\t\t\t\t/var/run/rsyslogd.pid\n\tNumber of Bits in RainerScript integers: 64\n\nSee https://www.rsyslog.com for more information.\n`)
      return 0
    }
    const n = args.findIndex((a) => /^-N/.test(a))
    if (n < 0) {
      ctx.err('[simulador] rsyslogd lo arranca systemd (systemctl start rsyslog). Para revisar la configuración: rsyslogd -N1\n')
      return 1
    }
    const fi = args.indexOf('-f')
    const file = fi >= 0 ? args[fi + 1] : '/etc/rsyslog.conf'
    if (fi >= 0 && file && !file.startsWith('/')) {
      ctx.err(`rsyslogd: -f ${file}: path must be absolute\n`)
      return 1
    }
    const cfg = loadRsyslog(ctx.sys, file)
    ctx.err(`rsyslogd: version ${version(ctx.sys)}, config validation run (level 1), master config ${file}\n`)
    for (const e of cfg.errors) ctx.err(formatRsyslogError(e, version(ctx.sys)) + '\n')
    ctx.err('rsyslogd: End of config validation run. Bye.\n')
    return cfg.errors.length ? 1 : 0
  },
})
