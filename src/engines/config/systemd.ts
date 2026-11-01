/** Validación de unidades de systemd (.service y .timer), con mensajes que explican cada problema. */
import { parseCalendar, parseTimespan } from '@/engines/shell/units'
import type { Diagnostic } from './types'

const KEYS: Record<string, string[]> = {
  Unit: ['Description', 'Documentation', 'After', 'Before', 'Wants', 'Requires', 'Requisite', 'BindsTo', 'PartOf', 'Conflicts', 'OnFailure', 'OnSuccess', 'ConditionPathExists', 'AssertPathExists', 'StartLimitIntervalSec', 'StartLimitBurst', 'DefaultDependencies'],
  Service: [
    'Type', 'ExecStart', 'ExecStartPre', 'ExecStartPost', 'ExecStop', 'ExecReload', 'Restart', 'RestartSec', 'RemainAfterExit', 'User', 'Group',
    'WorkingDirectory', 'Environment', 'EnvironmentFile', 'TimeoutStartSec', 'TimeoutStopSec', 'TimeoutSec', 'PIDFile', 'KillMode', 'StandardOutput',
    'StandardError', 'SyslogIdentifier', 'Nice', 'LimitNOFILE', 'MemoryMax', 'CPUQuota', 'ProtectSystem', 'ProtectHome', 'PrivateTmp', 'NoNewPrivileges',
    'ReadWritePaths', 'DynamicUser', 'UMask', 'RuntimeDirectory', 'StateDirectory', 'LogsDirectory', 'SuccessExitStatus',
  ],
  Timer: ['OnCalendar', 'OnBootSec', 'OnStartupSec', 'OnActiveSec', 'OnUnitActiveSec', 'OnUnitInactiveSec', 'Persistent', 'Unit', 'AccuracySec', 'RandomizedDelaySec', 'WakeSystem'],
  Install: ['WantedBy', 'RequiredBy', 'Alias', 'Also'],
}

const BOOL_KEYS = ['RemainAfterExit', 'Persistent', 'PrivateTmp', 'NoNewPrivileges', 'DynamicUser', 'WakeSystem', 'DefaultDependencies']
const TIME_KEYS = ['RestartSec', 'TimeoutStartSec', 'TimeoutStopSec', 'TimeoutSec', 'OnBootSec', 'OnStartupSec', 'OnActiveSec', 'OnUnitActiveSec', 'OnUnitInactiveSec', 'AccuracySec', 'RandomizedDelaySec', 'StartLimitIntervalSec']
const TYPES = ['simple', 'exec', 'forking', 'oneshot', 'notify', 'notify-reload', 'dbus', 'idle']
const RESTARTS = ['no', 'on-success', 'on-failure', 'on-abnormal', 'on-watchdog', 'on-abort', 'always']

function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return dp[a.length][b.length]
}

function suggest(key: string, list: string[]): string | undefined {
  const exact = list.find((k) => k.toLowerCase() === key.toLowerCase())
  if (exact) return exact
  let best: string | undefined
  let bestD = 3
  for (const k of list) {
    const d = distance(key.toLowerCase(), k.toLowerCase())
    if (d < bestD) {
      bestD = d
      best = k
    }
  }
  return best
}

export interface SystemdEntry {
  key: string
  value: string
  line: number
}

export function validateSystemd(text: string): { diagnostics: Diagnostic[]; entries: SystemdEntry[] } {
  const diagnostics: Diagnostic[] = []
  const entries: SystemdEntry[] = []
  const sections = new Map<string, Map<string, { value: string; line: number }[]>>()
  const sectionLine = new Map<string, number>()
  let section: string | undefined
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = i + 1
    const t = lines[i].trim()
    if (!t || t.startsWith('#') || t.startsWith(';')) continue
    const sec = /^\[(.*)\]$/.exec(t)
    if (sec) {
      const name = sec[1]
      if (!KEYS[name]) {
        const s = suggest(name, Object.keys(KEYS))
        diagnostics.push({ line, severity: 'error', message: `systemd no conoce la sección [${name}] e ignora todo lo que tiene adentro.${s ? ` ¿Quisiste decir [${s}]? Va con la primera letra en mayúscula.` : ' Las secciones son [Unit], [Service], [Timer] e [Install].'}` })
      }
      section = name
      if (!sectionLine.has(name)) sectionLine.set(name, line)
      continue
    }
    if (t.startsWith('[')) {
      diagnostics.push({ line, severity: 'error', message: 'A este encabezado de sección le falta el corchete de cierre: se escribe [Service].' })
      continue
    }
    const eq = t.indexOf('=')
    if (eq < 0) {
      diagnostics.push({ line, severity: 'error', message: 'Falta el signo "=". Cada línea es Opción=valor, por ejemplo ExecStart=/usr/local/bin/app.' })
      continue
    }
    const key = t.slice(0, eq).trim()
    const value = t.slice(eq + 1).trim()
    if (!section) {
      diagnostics.push({ line, severity: 'error', message: `"${key}" está antes de cualquier sección. Todo va debajo de un encabezado como [Unit] o [Service].` })
      continue
    }
    if (!KEYS[section]) continue
    if (!KEYS[section].includes(key)) {
      const elsewhere = Object.entries(KEYS).find(([, ks]) => ks.includes(key))?.[0]
      if (elsewhere) {
        diagnostics.push({ line, severity: 'error', message: `${key} va en la sección [${elsewhere}], no en [${section}]. Aquí systemd la ignora.` })
      } else {
        const s = suggest(key, KEYS[section])
        diagnostics.push({ line, severity: s ? 'error' : 'warning', message: `systemd no conoce la opción "${key}" en [${section}] y la ignora.${s ? ` ¿Quisiste decir ${s}? Las mayúsculas importan.` : ''}` })
      }
      continue
    }
    if (!sections.has(section)) sections.set(section, new Map())
    const map = sections.get(section)!
    if (value === '') map.set(key, [])
    else map.set(key, [...(map.get(key) ?? []), { value, line }])
    entries.push({ key: `${section}.${key}`, value, line })
    // Valores con formato conocido.
    if (BOOL_KEYS.includes(key) && value && !/^(1|0|yes|no|true|false|on|off)$/i.test(value)) {
      diagnostics.push({ line, severity: 'error', message: `${key} es de sí o no: se escribe yes o no (también vale true/false).` })
    }
    if (TIME_KEYS.includes(key) && value && parseTimespan(value) === undefined && value !== 'infinity') {
      diagnostics.push({ line, severity: 'error', message: `"${value}" no es un tiempo válido. Ejemplos: 30 (segundos), 5min, 1h, 2d.` })
    }
    if (key === 'Type' && !TYPES.includes(value)) {
      diagnostics.push({ line, severity: 'error', message: `Type=${value} no existe. Los más usados: simple (el programa se queda corriendo) y oneshot (hace su tarea y termina).` })
    }
    if (key === 'Restart' && !RESTARTS.includes(value)) {
      diagnostics.push({ line, severity: 'error', message: `Restart=${value} no existe. Valores comunes: no, on-failure (si falla) o always (siempre).` })
    }
    if (key === 'OnCalendar' && !parseCalendar(value)) {
      diagnostics.push({ line, severity: 'error', message: `systemd no entiende "${value}" como fecha. Ejemplos: daily, *-*-* 03:00:00, Mon..Fri 08:30. Puedes probarlo con systemd-analyze calendar.` })
    }
    if (key === 'WantedBy') {
      for (const v of value.split(/\s+/)) {
        if (!/\.(target|service|timer)$/.test(v)) diagnostics.push({ line, severity: 'error', message: `"${v}" no es el nombre de una unidad: le falta la extensión, por ejemplo multi-user.target.` })
      }
    }
    if (key === 'ExecStart' || key === 'ExecStartPre' || key === 'ExecStop') {
      const cmd = value.replace(/^[-@+!:]+/, '')
      const exe = cmd.split(/\s+/)[0]
      if (!exe.startsWith('/')) {
        diagnostics.push({ line, severity: 'warning', message: `Conviene la ruta completa del programa (por ejemplo /usr/bin/${exe}). systemd no usa tu PATH: solo busca en unas pocas carpetas fijas.` })
      }
      if (/(\s\||\|\s|>|&&|;\s|\$\()/.test(cmd) && !/^\/(usr\/)?bin\/(ba)?sh\s+-c\s/.test(cmd)) {
        diagnostics.push({ line, severity: 'warning', message: 'systemd ejecuta el programa sin una shell: |, >, && o ; no funcionan aquí. Ponlo en un script o usa /bin/bash -c "...".' })
      }
    }
  }

  const has = (sec: string, key: string) => (sections.get(sec)?.get(key)?.length ?? 0) > 0
  const isTimer = sectionLine.has('Timer')
  if (isTimer) {
    const triggers = ['OnCalendar', 'OnBootSec', 'OnStartupSec', 'OnActiveSec', 'OnUnitActiveSec', 'OnUnitInactiveSec']
    if (!triggers.some((k) => has('Timer', k))) {
      diagnostics.push({ line: sectionLine.get('Timer')!, severity: 'error', message: 'El timer no dice cuándo activarse: falta OnCalendar= (una fecha u hora) u OnBootSec= / OnUnitActiveSec= (un tiempo).' })
    }
    const wanted = sections.get('Install')?.get('WantedBy')?.map((x) => x.value).join(' ') ?? ''
    if (!/timers\.target/.test(wanted)) {
      diagnostics.push({ line: sectionLine.get('Install') ?? lines.length, severity: 'warning', message: 'Para que el timer quede activo después de reiniciar, en [Install] va WantedBy=timers.target (y después systemctl enable).' })
    }
  } else if (sectionLine.has('Service') || !sectionLine.size) {
    const exec = sections.get('Service')?.get('ExecStart') ?? []
    const type = sections.get('Service')?.get('Type')?.at(-1)?.value ?? 'simple'
    if (!sectionLine.has('Service')) {
      diagnostics.push({ line: 1, severity: 'error', message: 'Un .service necesita una sección [Service] con al menos ExecStart=.' })
    } else if (!exec.length) {
      diagnostics.push({ line: sectionLine.get('Service')!, severity: 'error', message: 'Falta ExecStart=: es la línea que dice qué programa arranca el servicio. Sin ella, systemd se niega a usar la unidad.' })
    } else if (exec.length > 1 && type !== 'oneshot') {
      diagnostics.push({ line: exec[1].line, severity: 'error', message: 'Hay más de un ExecStart=. Solo se permite con Type=oneshot; si querías reemplazar el anterior (en un drop-in), primero se pone una línea "ExecStart=" vacía.' })
    }
    if (!sectionLine.has('Install')) {
      diagnostics.push({ line: lines.length, severity: 'warning', message: 'No tiene sección [Install]: no se podrá habilitar al arranque con systemctl enable. Está bien si lo va a lanzar un timer.' })
    }
  }
  return { diagnostics, entries }
}
