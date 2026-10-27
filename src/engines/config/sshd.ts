/** Validación de sshd_config (OpenSSH 9.x), con mensajes parecidos a "sshd -t". */
import type { Diagnostic } from './types'

type Kind = 'yesno' | 'number' | 'text' | 'list' | { values: string[] }

const KEYWORDS: Record<string, Kind> = {
  port: 'number',
  listenaddress: 'text',
  addressfamily: { values: ['any', 'inet', 'inet6'] },
  hostkey: 'text',
  permitrootlogin: { values: ['yes', 'no', 'prohibit-password', 'without-password', 'forced-commands-only'] },
  passwordauthentication: 'yesno',
  pubkeyauthentication: 'yesno',
  permitemptypasswords: 'yesno',
  kbdinteractiveauthentication: 'yesno',
  challengeresponseauthentication: 'yesno',
  usepam: 'yesno',
  x11forwarding: 'yesno',
  allowtcpforwarding: { values: ['yes', 'no', 'all', 'local', 'remote'] },
  allowagentforwarding: 'yesno',
  gatewayports: { values: ['yes', 'no', 'clientspecified'] },
  permittunnel: { values: ['yes', 'no', 'point-to-point', 'ethernet'] },
  maxauthtries: 'number',
  maxsessions: 'number',
  maxstartups: 'text',
  logingracetime: 'text',
  clientaliveinterval: 'text',
  clientalivecountmax: 'number',
  allowusers: 'list',
  allowgroups: 'list',
  denyusers: 'list',
  denygroups: 'list',
  authorizedkeysfile: 'list',
  authenticationmethods: 'list',
  subsystem: 'text',
  include: 'text',
  banner: 'text',
  printmotd: 'yesno',
  printlastlog: 'yesno',
  syslogfacility: 'text',
  loglevel: { values: ['QUIET', 'FATAL', 'ERROR', 'INFO', 'VERBOSE', 'DEBUG', 'DEBUG1', 'DEBUG2', 'DEBUG3'] },
  usedns: 'yesno',
  compression: { values: ['yes', 'no', 'delayed'] },
  ciphers: 'text',
  macs: 'text',
  kexalgorithms: 'text',
  acceptenv: 'list',
  chrootdirectory: 'text',
  forcecommand: 'text',
  strictmodes: 'yesno',
  ignorerhosts: 'yesno',
  hostbasedauthentication: 'yesno',
  gssapiauthentication: 'yesno',
  kerberosauthentication: 'yesno',
  tcpkeepalive: 'yesno',
  permituserenvironment: 'text',
  trustedusercakeys: 'text',
  pidfile: 'text',
  match: 'text',
}

const REMOVED: Record<string, string> = {
  protocol: 'La opción Protocol se eliminó: OpenSSH moderno solo habla la versión 2.',
  rsaauthentication: 'RSAAuthentication era del protocolo 1 y ya no existe.',
  useprivilegeseparation: 'UsePrivilegeSeparation ya no existe: la separación de privilegios siempre está activa.',
  serverkeybits: 'ServerKeyBits era del protocolo 1 y ya no existe.',
}

export function validateSshd(text: string): { entries: { key: string; value: string; line: number }[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const entries: { key: string; value: string; line: number }[] = []
  const seen = new Map<string, number>()
  let inMatch = false
  text.split('\n').forEach((raw, i) => {
    const line = i + 1
    const t = raw.trim()
    if (!t || t.startsWith('#')) return
    const m = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(t)
    if (!m) {
      diagnostics.push({ line, severity: 'error', message: `Falta el valor de "${t}" (sshd: missing argument).` })
      return
    }
    const key = m[1]
    const value = m[2].replace(/\s+#.*$/, '').trim()
    const lower = key.toLowerCase()
    if (REMOVED[lower]) {
      diagnostics.push({ line, severity: 'warning', message: `${REMOVED[lower]} (sshd: Deprecated option ${key})` })
      return
    }
    const kind = KEYWORDS[lower]
    if (!kind) {
      diagnostics.push({ line, severity: 'error', message: `Opción desconocida "${key}" (sshd: Bad configuration option: ${key}). Revisa cómo está escrita.` })
      return
    }
    if (lower === 'match') inMatch = true
    entries.push({ key, value, line })
    if (!inMatch && lower !== 'match') {
      // En sshd vale la PRIMERA aparición de cada opción (salvo las que se acumulan).
      if (seen.has(lower) && !['port', 'listenaddress', 'hostkey', 'acceptenv', 'include', 'subsystem', 'allowusers', 'denyusers', 'allowgroups', 'denygroups'].includes(lower)) {
        diagnostics.push({ line, severity: 'warning', message: `"${key}" ya aparece en la línea ${seen.get(lower)}. sshd usa la PRIMERA aparición, así que esta línea no tiene efecto.` })
      } else if (!seen.has(lower)) seen.set(lower, line)
    }
    if (!value) {
      diagnostics.push({ line, severity: 'error', message: `Falta el valor de ${key} (sshd: ${key} missing argument).` })
      return
    }
    if (kind === 'yesno' && !/^(yes|no)$/.test(value)) diagnostics.push({ line, severity: 'error', message: `${key} acepta solo "yes" o "no" (sshd: Bad yes/no argument: ${value}).` })
    if (kind === 'number' && (!/^\d+$/.test(value) || (lower === 'port' && (Number(value) < 1 || Number(value) > 65535)))) diagnostics.push({ line, severity: 'error', message: `${key} espera un número${lower === 'port' ? ' entre 1 y 65535' : ''} (sshd: Badly formatted ${lower === 'port' ? 'port number' : 'number'}).` })
    if (typeof kind === 'object' && !kind.values.some((v) => v.toLowerCase() === value.toLowerCase())) diagnostics.push({ line, severity: 'error', message: `"${value}" no es válido para ${key}. Opciones: ${kind.values.join(', ')}.` })
    if (lower === 'permitrootlogin' && value === 'without-password') diagnostics.push({ line, severity: 'warning', message: '"without-password" es un nombre viejo: hoy se escribe "prohibit-password".' })
    if (lower === 'challengeresponseauthentication') diagnostics.push({ line, severity: 'warning', message: 'ChallengeResponseAuthentication es el nombre viejo de KbdInteractiveAuthentication.' })
  })
  return { entries, diagnostics }
}
