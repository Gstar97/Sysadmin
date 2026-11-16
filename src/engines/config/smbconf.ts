/**
 * smb.conf: lectura (la usa el simulador de Samba) y validación para el editor, con los mensajes
 * de testparm y algunos avisos de cosas que testparm acepta pero suelen ser un error.
 */
import type { Diagnostic } from './types'

export interface SmbSection {
  name: string
  params: Map<string, string>
  line: number
}

export interface SmbConf {
  global: Map<string, string>
  shares: SmbSection[]
  messages: string[]
  /** Errores que impiden cargar el archivo (smbd no arranca). */
  fatal: string[]
  /** Lo mismo, con la línea, para el editor. */
  diags: Diagnostic[]
}

/** Sinónimos: se guardan con el nombre canónico (los "inversos" invierten el valor). */
const SYNONYMS: Record<string, [string, boolean]> = {
  writable: ['read only', true],
  writeable: ['read only', true],
  'write ok': ['read only', true],
  browsable: ['browseable', false],
  public: ['guest ok', false],
  'create mode': ['create mask', false],
  'directory mode': ['directory mask', false],
  'allow hosts': ['hosts allow', false],
  'deny hosts': ['hosts deny', false],
  'force create mode': ['force create mode', false],
  'force directory mode': ['force directory mode', false],
  path: ['path', false],
  directory: ['path', false],
  printable: ['printable', false],
  'print ok': ['printable', false],
}

const KNOWN = new Set([
  'workgroup', 'security', 'server string', 'netbios name', 'passdb backend', 'map to guest', 'guest account', 'printing', 'printcap name',
  'load printers', 'cups options', 'include', 'log file', 'max log size', 'logging', 'server role', 'obey pam restrictions', 'unix password sync',
  'passwd program', 'passwd chat', 'pam password change', 'usershare allow guests', 'interfaces', 'bind interfaces only', 'server min protocol',
  'client min protocol', 'server max protocol', 'realm', 'idmap config * : backend', 'idmap config * : range', 'winbind use default domain',
  'template shell', 'template homedir', 'kerberos method', 'dns proxy', 'panic action', 'smb encrypt', 'server signing', 'disable netbios',
  'smb ports', 'restrict anonymous', 'ntlm auth', 'log level', 'unix extensions', 'wide links', 'follow symlinks', 'allow insecure wide links',
  'comment', 'path', 'read only', 'browseable', 'guest ok', 'guest only', 'valid users', 'invalid users', 'write list', 'read list',
  'admin users', 'force user', 'force group', 'create mask', 'directory mask', 'force create mode', 'force directory mode', 'inherit acls',
  'inherit permissions', 'inherit owner', 'hosts allow', 'hosts deny', 'printable', 'vfs objects', 'hide dot files', 'veto files', 'available',
  'store dos attributes', 'map archive', 'map hidden', 'map system', 'ea support', 'acl allow execute always', 'fruit:metadata', 'fruit:model',
  'recycle:repository', 'recycle:keeptree', 'recycle:versions', 'max connections', 'csc policy', 'strict locking', 'oplocks', 'level2 oplocks',
  'dfree command', 'root preexec', 'preexec', 'postexec', 'nt acl support', 'access based share enum', 'hide unreadable', 'smb encrypt',
])

export function parseSmbConf(text: string, file = '/etc/samba/smb.conf'): SmbConf {
  const conf: SmbConf = { global: new Map(), shares: [], messages: [], fatal: [], diags: [] }
  let cur: SmbSection | undefined
  let global = true
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]
    const n = i + 1
    while (line.trimEnd().endsWith('\\') && i + 1 < lines.length) line = line.trimEnd().slice(0, -1) + ' ' + lines[++i].trim()
    const t = line.trim()
    if (!t || t.startsWith('#') || t.startsWith(';')) continue
    if (t.startsWith('[')) {
      const m = /^\[([^\]]+)\]\s*$/.exec(t)
      if (!m) {
        conf.fatal.push(`Bad section name in ${file} line ${n}: ${t}`)
        conf.diags.push({ line: n, severity: 'error', message: `Sección mal escrita: falta el "]" o sobra algo después (testparm: Bad section name).` })
        continue
      }
      const name = m[1].trim()
      if (name.toLowerCase() === 'global') {
        global = true
        cur = undefined
      } else {
        global = false
        cur = conf.shares.find((s) => s.name.toLowerCase() === name.toLowerCase())
        if (!cur) {
          cur = { name, params: new Map(), line: n }
          conf.shares.push(cur)
        }
      }
      continue
    }
    const eq = t.indexOf('=')
    if (eq < 0) {
      conf.messages.push(`Ignoring badly formed line in configuration file: ${t}`)
      conf.diags.push({ line: n, severity: 'error', message: `Falta el "=": cada línea es "parámetro = valor" (testparm: Ignoring badly formed line).` })
      continue
    }
    let key = t.slice(0, eq).trim().toLowerCase().replace(/\s+/g, ' ')
    let val = t.slice(eq + 1).trim()
    const syn = SYNONYMS[key]
    if (syn) {
      const [canon, invert] = syn
      if (invert) {
        const b = parseBool(val)
        if (b === undefined) {
          conf.messages.push(`set_variable_helper(${val}): value is not boolean!`, `Error loading services.`)
          conf.fatal.push(`set_variable_helper(${val}): value is not boolean!`)
          conf.diags.push({ line: n, severity: 'error', message: `"${val}" no es un valor válido para ${key}: yes o no (testparm: value is not boolean). Con este error, smbd no arranca.` })
          continue
        }
        val = b ? 'No' : 'Yes'
      }
      key = canon
    }
    if (!KNOWN.has(key)) {
      conf.messages.push(`Unknown parameter encountered: "${key}"`, `Ignoring unknown parameter "${key}"`)
      conf.diags.push({ line: n, severity: 'error', message: `Parámetro desconocido "${key}": Samba lo ignora sin avisar (testparm: Ignoring unknown parameter). Revisá si está bien escrito.` })
      continue
    }
    if (['read only', 'browseable', 'guest ok', 'guest only', 'printable', 'inherit acls', 'inherit permissions', 'load printers', 'available'].includes(key) && parseBool(val) === undefined) {
      conf.messages.push(`set_variable_helper(${val}): value is not boolean!`, `Error loading services.`)
      conf.fatal.push(`set_variable_helper(${val}): value is not boolean!`)
      conf.diags.push({ line: n, severity: 'error', message: `"${val}" no es un valor válido para ${key}: yes o no (testparm: value is not boolean). Con este error, smbd no arranca.` })
      continue
    }
    if (global) conf.global.set(key, val)
    else cur!.params.set(key, val)
  }
  return conf
}

export function parseBool(v: string): boolean | undefined {
  const x = v.trim().toLowerCase()
  if (['yes', 'true', '1', 'on'].includes(x)) return true
  if (['no', 'false', '0', 'off'].includes(x)) return false
  return undefined
}


/** Validación para el editor de smb.conf. */
export function validateSmbConf(text: string): { diagnostics: Diagnostic[] } {
  const c = parseSmbConf(text)
  const diagnostics = [...c.diags]
  for (const sh of c.shares) {
    const name = sh.name.toLowerCase()
    if (['homes', 'printers', 'print$'].includes(name)) continue
    if (!sh.params.has('path')) diagnostics.push({ line: sh.line, severity: 'error', message: `El recurso [${sh.name}] no tiene path: no hay carpeta para compartir.` })
    const guest = parseBool(sh.params.get('guest ok') ?? 'no')
    const ro = parseBool(sh.params.get('read only') ?? 'yes')
    if (guest && ro === false) diagnostics.push({ line: sh.line, severity: 'warning', message: `[${sh.name}] permite escribir sin usuario (guest ok y escritura): cualquiera de la red puede borrar o llenar la carpeta.` })
    if (!sh.params.has('valid users') && !guest) diagnostics.push({ line: sh.line, severity: 'warning', message: `[${sh.name}] no tiene valid users: entra cualquier usuario de Samba. Si es para un área, limitalo a su grupo (valid users = @grupo).` })
  }
  return { diagnostics }
}
