/**
 * Unidades de systemd del servidor simulado: lectura de archivos .service y .timer
 * (con sus drop-ins), carga y recarga (daemon-reload) y cálculo de fechas de OnCalendar.
 */
import { readSshdConfig } from './hosts'
import type { Service, System } from './system'
import { ROOT_CRED } from './vfs'

const ETC = '/etc/systemd/system'

// ---------------------------------------------------------------------------------------
// Lectura de archivos de unidad
// ---------------------------------------------------------------------------------------

export interface UnitProblem {
  file: string
  line: number
  message: string
}

/** Clave → valores (en orden) de cada sección, ya combinando archivo principal y drop-ins. */
export type UnitSections = Map<string, Map<string, string[]>>

const KNOWN_KEYS: Record<string, string[]> = {
  Unit: [
    'Description', 'Documentation', 'After', 'Before', 'Wants', 'Requires', 'Requisite', 'BindsTo', 'PartOf', 'Conflicts', 'OnFailure', 'OnSuccess',
    'ConditionPathExists', 'ConditionPathIsDirectory', 'AssertPathExists', 'StartLimitIntervalSec', 'StartLimitBurst', 'DefaultDependencies', 'Upholds',
  ],
  Service: [
    'Type', 'ExecStart', 'ExecStartPre', 'ExecStartPost', 'ExecStop', 'ExecStopPost', 'ExecReload', 'Restart', 'RestartSec', 'RemainAfterExit',
    'User', 'Group', 'WorkingDirectory', 'Environment', 'EnvironmentFile', 'TimeoutStartSec', 'TimeoutStopSec', 'TimeoutSec', 'PIDFile', 'KillMode',
    'KillSignal', 'SuccessExitStatus', 'StandardOutput', 'StandardError', 'SyslogIdentifier', 'Nice', 'LimitNOFILE', 'MemoryMax', 'CPUQuota',
    'ProtectSystem', 'ProtectHome', 'PrivateTmp', 'NoNewPrivileges', 'ReadWritePaths', 'DynamicUser', 'UMask', 'RuntimeDirectory', 'StateDirectory',
    'LogsDirectory', 'WatchdogSec', 'NotifyAccess', 'StartLimitIntervalSec', 'StartLimitBurst',
  ],
  Timer: ['OnCalendar', 'OnBootSec', 'OnStartupSec', 'OnActiveSec', 'OnUnitActiveSec', 'OnUnitInactiveSec', 'Persistent', 'Unit', 'AccuracySec', 'RandomizedDelaySec', 'WakeSystem', 'RemainAfterElapse', 'FixedRandomDelay'],
  Install: ['WantedBy', 'RequiredBy', 'Alias', 'Also', 'DefaultInstance', 'UpheldBy'],
}

/** Combina el archivo principal y los drop-ins. Un valor vacío ("ExecStart=") borra lo anterior. */
export function parseUnitFiles(files: { path: string; text: string }[]): { sections: UnitSections; warnings: UnitProblem[] } {
  const sections: UnitSections = new Map()
  const warnings: UnitProblem[] = []
  for (const { path, text } of files) {
    let section: string | undefined
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i].trim()
      const lineNo = i + 1
      while (line.endsWith('\\') && i + 1 < lines.length) {
        line = line.slice(0, -1) + ' ' + lines[++i].trim()
      }
      if (!line || line.startsWith('#') || line.startsWith(';')) continue
      const sec = /^\[(.+)\]$/.exec(line)
      if (sec) {
        section = sec[1]
        if (!KNOWN_KEYS[section]) warnings.push({ file: path, line: lineNo, message: `Unknown section '${section}'. Ignoring.` })
        continue
      }
      const eq = line.indexOf('=')
      if (eq < 0) {
        warnings.push({ file: path, line: lineNo, message: `Missing '=', ignoring line.` })
        continue
      }
      if (!section) {
        warnings.push({ file: path, line: lineNo, message: 'Assignment outside of section. Ignoring.' })
        continue
      }
      if (!KNOWN_KEYS[section]) continue
      const key = line.slice(0, eq).trim()
      const value = line.slice(eq + 1).trim()
      if (!KNOWN_KEYS[section].includes(key)) {
        warnings.push({ file: path, line: lineNo, message: `Unknown key name '${key}' in section '${section}', ignoring.` })
        continue
      }
      if (!sections.has(section)) sections.set(section, new Map())
      const map = sections.get(section)!
      if (value === '') map.set(key, [])
      else map.set(key, [...(map.get(key) ?? []), value])
    }
  }
  return { sections, warnings }
}

const last = (s: UnitSections, sec: string, key: string) => s.get(sec)?.get(key)?.at(-1)
const all = (s: UnitSections, sec: string, key: string) => (s.get(sec)?.get(key) ?? []).flatMap((v) => v.split(/\s+/)).filter(Boolean)
const yes = (v?: string) => !!v && /^(1|yes|true|on)$/i.test(v)

export interface UnitDef {
  /** Archivo principal (FragmentPath) y drop-ins. */
  path: string
  dropins: string[]
  custom: boolean
  description?: string
  type: string
  execStart: string[]
  execStartPre: string[]
  user?: string
  group?: string
  workingDirectory?: string
  restart: string
  restartSec?: string
  remainAfterExit: boolean
  after: string[]
  wants: string[]
  requires: string[]
  wantedBy: string[]
  hasInstall: boolean
  /** Problemas que impiden usar la unidad ("bad unit file setting"). */
  errors: string[]
  warnings: UnitProblem[]
}

/** Texto de la unidad que trae el paquete de un servicio (no existe como archivo en el simulador). */
export function vendorUnitText(svc: Pick<Service, 'name' | 'description'>): string {
  return `[Unit]\nDescription=${svc.description}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=notify\nExecStart=/usr/sbin/${svc.name}\nExecReload=/bin/kill -HUP $MAINPID\nRestart=on-failure\n\n[Install]\nWantedBy=multi-user.target\n`
}

function dropinFiles(sys: System, unit: string): string[] {
  const dir = `${ETC}/${unit}.d`
  if (!sys.vfs.exists(dir)) return []
  return sys.vfs
    .readdir(dir, ROOT_CRED)
    .filter((f) => f.endsWith('.conf'))
    .sort()
    .map((f) => `${dir}/${f}`)
}

/** Texto de todos los archivos de una unidad: sirve para saber si cambiaron desde la última carga. */
export function unitSignature(sys: System, unit: string): string {
  const main = customFragment(sys, unit)
  const paths = [...(main ? [main] : []), ...dropinFiles(sys, unit)]
  return paths.map((p) => `${p}\n${read(sys, p)}`).join('\n--\n')
}

function read(sys: System, path: string): string {
  try {
    return sys.vfs.readFile(path, ROOT_CRED)
  } catch {
    return ''
  }
}

export function customFragment(sys: System, unit: string): string | undefined {
  const p = `${ETC}/${unit}`
  if (!sys.vfs.exists(p)) return undefined
  // Un enlace a /dev/null es una unidad enmascarada, no un archivo de unidad.
  try {
    if (sys.vfs.stat(p, ROOT_CRED, false).type === 'symlink') return undefined
  } catch {
    return undefined
  }
  return p
}

export function buildServiceDef(sys: System, svc: Pick<Service, 'name' | 'description'>): UnitDef {
  const unit = `${svc.name}.service`
  const fragment = customFragment(sys, unit)
  const dropins = dropinFiles(sys, unit)
  const files = [
    fragment ? { path: fragment, text: read(sys, fragment) } : { path: `/usr/lib/systemd/system/${unit}`, text: vendorUnitText(svc) },
    ...dropins.map((p) => ({ path: p, text: read(sys, p) })),
  ]
  const { sections, warnings } = parseUnitFiles(files)
  const type = last(sections, 'Service', 'Type') ?? (sections.get('Service')?.has('BusName') ? 'dbus' : 'simple')
  const execStart = sections.get('Service')?.get('ExecStart') ?? []
  const errors: string[] = []
  if (!sections.has('Service') && fragment) errors.push(`${unit}: Service has no [Service] section. Refusing.`)
  if (!execStart.length) errors.push(`${unit}: Service has no ExecStart=, ExecStop=, or SuccessAction=. Refusing.`)
  if (execStart.length > 1 && type !== 'oneshot') errors.push(`${unit}: Service has more than one ExecStart= setting, which is only allowed for Type=oneshot services. Refusing.`)
  if (!['simple', 'exec', 'forking', 'oneshot', 'notify', 'notify-reload', 'dbus', 'idle'].includes(type)) {
    warnings.push({ file: fragment ?? `/usr/lib/systemd/system/${unit}`, line: 0, message: `Failed to parse service type, ignoring: ${type}` })
  }
  return {
    path: fragment ?? `/usr/lib/systemd/system/${unit}`,
    dropins,
    custom: !!fragment,
    description: last(sections, 'Unit', 'Description'),
    type: ['simple', 'exec', 'forking', 'oneshot', 'notify', 'notify-reload', 'dbus', 'idle'].includes(type) ? type : 'simple',
    execStart,
    execStartPre: sections.get('Service')?.get('ExecStartPre') ?? [],
    user: last(sections, 'Service', 'User'),
    group: last(sections, 'Service', 'Group'),
    workingDirectory: last(sections, 'Service', 'WorkingDirectory'),
    restart: last(sections, 'Service', 'Restart') ?? 'no',
    restartSec: last(sections, 'Service', 'RestartSec'),
    remainAfterExit: yes(last(sections, 'Service', 'RemainAfterExit')),
    after: all(sections, 'Unit', 'After'),
    wants: all(sections, 'Unit', 'Wants'),
    requires: all(sections, 'Unit', 'Requires'),
    wantedBy: all(sections, 'Install', 'WantedBy'),
    hasInstall: !!(sections.get('Install')?.size),
    errors,
    warnings,
  }
}

// ---------------------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------------------

export interface Timer {
  name: string
  description: string
  /** Servicio que activa (sin ".service"). */
  unit: string
  onCalendar: CalendarSpec[]
  onBootSec?: number
  onUnitActiveSec?: number
  persistent: boolean
  randomizedDelay?: number
  enabled: boolean
  active: boolean
  since: number
  last?: number
  builtin: boolean
  path: string
  wantedBy: string[]
  hasInstall: boolean
  masked?: boolean
  errors: string[]
  warnings: UnitProblem[]
  loadedSig: string
}

/** Segundos de un valor de tiempo de systemd: "30", "5min", "1h 30min", "2d". */
export function parseTimespan(v: string): number | undefined {
  const units: Record<string, number> = { us: 1e-6, ms: 0.001, s: 1, sec: 1, second: 1, seconds: 1, m: 60, min: 60, minute: 60, minutes: 60, h: 3600, hr: 3600, hour: 3600, hours: 3600, d: 86400, day: 86400, days: 86400, w: 604800, week: 604800, weeks: 604800 }
  let total = 0
  const re = /(\d+(?:\.\d+)?)\s*([a-z]*)/gy
  const s = v.trim()
  let pos = 0
  while (pos < s.length) {
    re.lastIndex = pos
    const m = re.exec(s)
    if (!m || !m[0]) return undefined
    const mult = m[2] ? units[m[2]] : 1
    if (mult === undefined) return undefined
    total += Number(m[1]) * mult
    pos = re.lastIndex
    while (s[pos] === ' ') pos++
  }
  return s ? total : undefined
}

export function buildTimer(sys: System, name: string, path: string): Timer {
  const unit = `${name}.timer`
  const files = [{ path, text: read(sys, path) }, ...dropinFiles(sys, unit).map((p) => ({ path: p, text: read(sys, p) }))]
  const { sections, warnings } = parseUnitFiles(files)
  const errors: string[] = []
  const onCalendar: CalendarSpec[] = []
  for (const v of sections.get('Timer')?.get('OnCalendar') ?? []) {
    const spec = parseCalendar(v)
    if (spec) onCalendar.push(spec)
    else warnings.push({ file: path, line: 0, message: `Failed to parse calendar specification, ignoring: ${v}` })
  }
  const boot = last(sections, 'Timer', 'OnBootSec')
  const active = last(sections, 'Timer', 'OnUnitActiveSec')
  const onBootSec = boot ? parseTimespan(boot) : undefined
  const onUnitActiveSec = active ? parseTimespan(active) : undefined
  if (!onCalendar.length && onBootSec === undefined && onUnitActiveSec === undefined && !last(sections, 'Timer', 'OnActiveSec') && !last(sections, 'Timer', 'OnStartupSec')) {
    errors.push(`${unit}: Timer unit lacks value setting. Refusing.`)
  }
  const target = (last(sections, 'Timer', 'Unit') ?? `${name}.service`).replace(/\.service$/, '')
  const delay = last(sections, 'Timer', 'RandomizedDelaySec')
  return {
    name,
    description: last(sections, 'Unit', 'Description') ?? unit,
    unit: target,
    onCalendar,
    onBootSec,
    onUnitActiveSec,
    persistent: yes(last(sections, 'Timer', 'Persistent')),
    randomizedDelay: delay ? parseTimespan(delay) : undefined,
    enabled: false,
    active: false,
    since: Date.now(),
    builtin: false,
    path,
    wantedBy: all(sections, 'Install', 'WantedBy'),
    hasInstall: !!(sections.get('Install')?.size),
    errors,
    warnings,
    loadedSig: unitSignature(sys, unit),
  }
}

/** Timers que traen las distribuciones: aparecen en "systemctl list-timers". */
export function builtinTimers(sys: System): Timer[] {
  const mk = (name: string, description: string, calendar: string, unit = name, lastAgoMin?: number): Timer => ({
    name,
    description,
    unit,
    onCalendar: [parseCalendar(calendar)!],
    persistent: true,
    enabled: true,
    active: true,
    since: sys.bootTime + 20_000,
    last: lastAgoMin !== undefined ? Date.now() - lastAgoMin * 60_000 : undefined,
    builtin: true,
    path: `/usr/lib/systemd/system/${name}.timer`,
    wantedBy: ['timers.target'],
    hasInstall: true,
    errors: [],
    warnings: [],
    loadedSig: '',
  })
  const list =
    sys.distro === 'rocky'
      ? [
          mk('dnf-makecache', 'dnf makecache --timer', 'hourly', 'dnf-makecache', 38),
          mk('logrotate', 'Daily rotation of log files', 'daily', 'logrotate', 8 * 60 + 12),
          mk('systemd-tmpfiles-clean', 'Daily Cleanup of Temporary Directories', 'daily', 'systemd-tmpfiles-clean', 21 * 60),
          mk('fstrim', 'Discard unused filesystem blocks once a week', 'weekly', 'fstrim', 3 * 24 * 60),
        ]
      : [
          mk('apt-daily', 'Daily apt download activities', '*-*-* 06,18:00', 'apt-daily', 3 * 60 + 4),
          mk('apt-daily-upgrade', 'Daily apt upgrade and clean activities', '*-*-* 06:00', 'apt-daily-upgrade', 6 * 60 + 40),
          mk('logrotate', 'Daily rotation of log files', 'daily', 'logrotate', 8 * 60 + 12),
          mk('man-db', 'Daily man-db regeneration', 'daily', 'man-db', 8 * 60 + 12),
          mk('motd-news', 'Message of the Day', '*-*-* 00,12:00', 'motd-news', 2 * 60 + 51),
          mk('systemd-tmpfiles-clean', 'Daily Cleanup of Temporary Directories', 'daily', 'systemd-tmpfiles-clean', 21 * 60),
          mk('fstrim', 'Discard unused filesystem blocks once a week', 'weekly', 'fstrim', 3 * 24 * 60),
        ]
  return list
}

export function nextElapse(sys: System, t: Timer, from = Date.now()): number | undefined {
  const times: number[] = []
  for (const c of t.onCalendar) {
    const n = calendarNext(c, from)
    if (n !== undefined) times.push(n)
  }
  if (t.onBootSec !== undefined && sys.bootTime + t.onBootSec * 1000 > from) times.push(sys.bootTime + t.onBootSec * 1000)
  if (t.onUnitActiveSec !== undefined) times.push(Math.max(from + 1000, (t.last ?? t.since) + t.onUnitActiveSec * 1000))
  return times.length ? Math.min(...times) : undefined
}

// ---------------------------------------------------------------------------------------
// Carga y recarga
// ---------------------------------------------------------------------------------------

/** Carga (o recarga) la definición de un servicio y recuerda cómo estaban sus archivos. */
export function loadService(sys: System, svc: Service) {
  const def = buildServiceDef(sys, svc)
  svc.unit = def
  svc.loadedSig = unitSignature(sys, `${svc.name}.service`)
  if (def.custom && def.description) svc.description = def.description
}

/** Busca un servicio; si no está cargado pero existe su archivo en /etc/systemd/system, lo carga (como systemd). */
export function findService(sys: System, name: string): Service | undefined {
  const known = sys.services.get(name)
  if (known) {
    if (!known.unit) loadService(sys, known)
    return known
  }
  if (!customFragment(sys, `${name}.service`)) return undefined
  const svc: Service = { name, description: name, active: false, enabled: false, failed: false, ports: [], since: Date.now() }
  loadService(sys, svc)
  if (!svc.unit?.description) svc.description = `${name}.service`
  sys.services.set(name, svc)
  return svc
}

export function findTimer(sys: System, name: string): Timer | undefined {
  const known = sys.timers.get(name)
  if (known) return known
  const path = customFragment(sys, `${name}.timer`)
  if (!path) return undefined
  const t = buildTimer(sys, name, path)
  sys.timers.set(name, t)
  return t
}

/** El archivo (o un drop-in) cambió después de la última carga: hace falta daemon-reload. */
export function needsReload(sys: System, unit: string): boolean {
  if (unit.endsWith('.timer')) {
    const t = sys.timers.get(unit.slice(0, -6))
    return !!t && !t.builtin && t.loadedSig !== unitSignature(sys, unit)
  }
  const svc = sys.services.get(unit.replace(/\.service$/, ''))
  return !!svc?.unit && svc.loadedSig !== unitSignature(sys, unit)
}

/** systemctl daemon-reload: vuelve a leer todas las unidades. */
export function daemonReload(sys: System) {
  // En Ubuntu, el generador de ssh.socket vuelve a leer Port y ListenAddress de sshd_config.
  if (sys.distro === 'ubuntu') {
    const r = readSshdConfig(sys)
    if (!r.errors.length) sys.sshSocketPorts = r.conf.ports
  }
  // systemd también vuelve a leer /etc/fstab (las unidades .mount).
  sys.storage.fstabSeen = sys.storage.fstabText()
  for (const svc of [...sys.services.values()]) {
    // Una unidad propia cuyo archivo se borró desaparece (si estaba detenida).
    if (svc.unit?.custom && !customFragment(sys, `${svc.name}.service`) && !svc.pkg) {
      if (!svc.active) sys.services.delete(svc.name)
      continue
    }
    loadService(sys, svc)
  }
  const etc = sys.vfs.exists(ETC) ? sys.vfs.readdir(ETC, ROOT_CRED) : []
  for (const f of etc) {
    const m = /^(.+)\.service$/.exec(f)
    if (m && !sys.services.has(m[1])) findService(sys, m[1])
  }
  for (const t of [...sys.timers.values()]) {
    if (t.builtin) continue
    const path = customFragment(sys, `${t.name}.timer`)
    if (!path) {
      if (!t.active) sys.timers.delete(t.name)
      continue
    }
    const fresh = buildTimer(sys, t.name, path)
    Object.assign(t, { ...fresh, enabled: t.enabled, active: t.active, since: t.since, last: t.last })
  }
  for (const f of etc) {
    const m = /^(.+)\.timer$/.exec(f)
    if (m && !sys.timers.has(m[1])) findTimer(sys, m[1])
  }
}

// ---------------------------------------------------------------------------------------
// OnCalendar
// ---------------------------------------------------------------------------------------

interface CalItem {
  start: number | '*'
  end?: number
  rep?: number
}

export interface CalendarSpec {
  original: string
  dow?: number[]
  year: CalItem[]
  month: CalItem[]
  day: CalItem[]
  hour: CalItem[]
  minute: CalItem[]
  second: CalItem[]
}

const SHORTHANDS: Record<string, string> = {
  minutely: '*-*-* *:*:00',
  hourly: '*-*-* *:00:00',
  daily: '*-*-* 00:00:00',
  monthly: '*-*-01 00:00:00',
  weekly: 'Mon *-*-* 00:00:00',
  yearly: '*-01-01 00:00:00',
  annually: '*-01-01 00:00:00',
  quarterly: '*-01,04,07,10-01 00:00:00',
  semiannually: '*-01,07-01 00:00:00',
}

const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const DOW_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function dowIndex(s: string): number | undefined {
  const l = s.toLowerCase()
  const full = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const i = DOW_NAMES.indexOf(l)
  if (i >= 0) return i
  const j = full.indexOf(l)
  return j >= 0 ? j : undefined
}

function parseDow(tok: string): number[] | undefined {
  const out = new Set<number>()
  for (const part of tok.split(',')) {
    const [a, b] = part.split('..')
    const ia = dowIndex(a)
    if (ia === undefined) return undefined
    if (b === undefined) out.add(ia)
    else {
      const ib = dowIndex(b)
      if (ib === undefined) return undefined
      // Mon..Fri; los rangos no dan la vuelta por el domingo.
      const from = ia === 0 ? 7 : ia
      const to = ib === 0 ? 7 : ib
      if (to < from) return undefined
      for (let d = from; d <= to; d++) out.add(d % 7)
    }
  }
  return [...out].sort((x, y) => x - y)
}

function parseComp(tok: string, min: number, max: number): CalItem[] | undefined {
  const items: CalItem[] = []
  for (const part of tok.split(',')) {
    const m = /^(\*|\d+)(?:\.\.(\d+))?(?:\/(\d+))?$/.exec(part)
    if (!m) return undefined
    const start = m[1] === '*' ? ('*' as const) : Number(m[1])
    const end = m[2] !== undefined ? Number(m[2]) : undefined
    const rep = m[3] !== undefined ? Number(m[3]) : undefined
    if (start !== '*' && (start < min || start > max)) return undefined
    if (end !== undefined && (start === '*' || end < start || end > max)) return undefined
    if (rep !== undefined && rep < 1) return undefined
    if (start === '*' && end === undefined && rep !== undefined) items.push({ start: min, rep })
    else items.push({ start, end, rep })
  }
  return items
}

/** Interpreta una expresión de OnCalendar. Devuelve undefined si systemd la rechazaría. */
export function parseCalendar(input: string): CalendarSpec | undefined {
  const original = input.trim()
  const text = SHORTHANDS[original.toLowerCase()] ?? original
  const toks = text.split(/\s+/).filter(Boolean)
  if (!toks.length || toks.length > 3) return undefined
  let dow: number[] | undefined
  if (/^[a-z]/i.test(toks[0])) {
    dow = parseDow(toks[0])
    if (!dow) return undefined
    toks.shift()
  }
  let date = '*-*-*'
  let time = '00:00:00'
  if (toks.length === 2) [date, time] = toks
  else if (toks.length === 1) {
    if (toks[0].includes(':')) time = toks[0]
    else date = toks[0]
  } else if (!dow) return undefined
  if (toks.length === 2 && (!date.includes('-') || !time.includes(':'))) return undefined
  const dparts = date.split('-')
  if (dparts.length === 2) dparts.unshift('*')
  if (dparts.length !== 3) return undefined
  const tparts = time.split(':')
  if (tparts.length === 2) tparts.push('00')
  if (tparts.length !== 3) return undefined
  const year = parseComp(dparts[0], 1970, 2199)
  const month = parseComp(dparts[1], 1, 12)
  const day = parseComp(dparts[2], 1, 31)
  const hour = parseComp(tparts[0], 0, 23)
  const minute = parseComp(tparts[1], 0, 59)
  const second = parseComp(tparts[2], 0, 59)
  if (!year || !month || !day || !hour || !minute || !second) return undefined
  return { original, dow, year, month, day, hour, minute, second }
}

function expand(items: CalItem[], min: number, max: number): number[] {
  const out = new Set<number>()
  for (const it of items) {
    if (it.start === '*') {
      for (let v = min; v <= max; v++) out.add(v)
      continue
    }
    const end = it.end ?? (it.rep ? max : it.start)
    for (let v = it.start; v <= end; v += it.rep ?? 1) out.add(v)
  }
  return [...out].sort((a, b) => a - b)
}

function fmtItems(items: CalItem[], width: number): string {
  return items
    .map((it) => {
      if (it.start === '*') return '*'
      let s = String(it.start).padStart(width, '0')
      if (it.end !== undefined) s += '..' + String(it.end).padStart(width, '0')
      if (it.rep !== undefined) s += '/' + it.rep
      return s
    })
    .join(',')
}

function fmtDow(dow: number[]): string {
  // Lunes primero, como systemd; los tramos de tres o más días seguidos se escriben como rango.
  const order = [1, 2, 3, 4, 5, 6, 0].filter((d) => dow.includes(d))
  const parts: string[] = []
  for (let i = 0; i < order.length; ) {
    let j = i
    while (j + 1 < order.length && (order[j + 1] === order[j] + 1 || (order[j] === 6 && order[j + 1] === 0))) j++
    if (j - i >= 2) parts.push(`${DOW_LABEL[order[i]]}..${DOW_LABEL[order[j]]}`)
    else for (let k = i; k <= j; k++) parts.push(DOW_LABEL[order[k]])
    i = j + 1
  }
  return parts.join(',')
}

export function normalizeCalendar(c: CalendarSpec): string {
  const date = `${fmtItems(c.year, 4)}-${fmtItems(c.month, 2)}-${fmtItems(c.day, 2)}`
  const time = `${fmtItems(c.hour, 2)}:${fmtItems(c.minute, 2)}:${fmtItems(c.second, 2)}`
  return `${c.dow ? fmtDow(c.dow) + ' ' : ''}${date} ${time}`
}

/** Próxima fecha (en ms) que cumple la expresión, estrictamente después de "from". */
export function calendarNext(c: CalendarSpec, from: number): number | undefined {
  const hours = expand(c.hour, 0, 23)
  const minutes = expand(c.minute, 0, 59)
  const seconds = expand(c.second, 0, 59)
  const start = new Date(from + 1000)
  start.setMilliseconds(0)
  const years = expand(c.year, 1970, 2199)
  const months = expand(c.month, 1, 12)
  const days = expand(c.day, 1, 31)
  const day = new Date(start)
  day.setHours(0, 0, 0, 0)
  for (let i = 0; i < 366 * 8; i++) {
    const y = day.getFullYear()
    const mo = day.getMonth() + 1
    const d = day.getDate()
    const ok =
      years.includes(y) && months.includes(mo) && days.includes(d) && (!c.dow || c.dow.includes(day.getDay()))
    if (ok) {
      const today = i === 0
      for (const h of hours) {
        if (today && h < start.getHours()) continue
        for (const m of minutes) {
          if (today && h === start.getHours() && m < start.getMinutes()) continue
          for (const s of seconds) {
            if (today && h === start.getHours() && m === start.getMinutes() && s < start.getSeconds()) continue
            const t = new Date(day)
            t.setHours(h, m, s, 0)
            return t.getTime()
          }
        }
      }
    }
    day.setDate(day.getDate() + 1)
  }
  return undefined
}

// ---------------------------------------------------------------------------------------
// Formato de fechas y duraciones al estilo de systemd
// ---------------------------------------------------------------------------------------

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

export function systemdDate(ms: number): string {
  const d = new Date(ms)
  return `${DOW_LABEL[d.getDay()]} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} UTC`
}

export function timespan(ms: number): string {
  const s = Math.max(0, Math.round(Math.abs(ms) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}min ${s % 60 ? (s % 60) + 's' : ''}`.trim()
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60 ? (m % 60) + 'min' : ''}`.trim()
  const d = Math.floor(h / 24)
  return `${d} ${d === 1 ? 'day' : 'days'} ${h % 24 ? (h % 24) + 'h' : ''}`.trim()
}
