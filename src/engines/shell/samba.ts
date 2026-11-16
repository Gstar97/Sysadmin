/**
 * Samba: smb.conf (testparm), las cuentas de Samba (smbpasswd, pdbedit), smbstatus, el cliente
 * smbclient y mount -t cifs. Cada operación se hace en el servidor como el usuario de Linux que
 * corresponde a la cuenta, pasando por tres filtros: lo que permite el recurso (read only,
 * valid users, write list), los permisos de la carpeta y, en Rocky, SELinux.
 */
import { NETWORK_MOUNTS } from './commands/storage'
import { SERVICE_CHECKS } from './commands/sysinfo'
import { inSubnet } from './hosts'
import { reach } from './http'
import { avc, contextOf, typeOf } from './selinux'
import { register, type CommandContext, type Foreground, type IO } from './shell'
import { System } from './system'
import { basename, dirname, FsError, normalizePath, ROOT_CRED, type Cred, type FsErrorCode, type Inode } from './vfs'

// ---------------------------------------------------------------------------------------
// smb.conf
// ---------------------------------------------------------------------------------------

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
  const conf: SmbConf = { global: new Map(), shares: [], messages: [], fatal: [] }
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
          continue
        }
        val = b ? 'No' : 'Yes'
      }
      key = canon
    }
    if (!KNOWN.has(key)) {
      conf.messages.push(`Unknown parameter encountered: "${key}"`, `Ignoring unknown parameter "${key}"`)
      continue
    }
    if (['read only', 'browseable', 'guest ok', 'guest only', 'printable', 'inherit acls', 'inherit permissions', 'load printers', 'available'].includes(key) && parseBool(val) === undefined) {
      conf.messages.push(`set_variable_helper(${val}): value is not boolean!`, `Error loading services.`)
      conf.fatal.push(`set_variable_helper(${val}): value is not boolean!`)
      continue
    }
    if (global) conf.global.set(key, val)
    else cur!.params.set(key, val)
  }
  return conf
}

function parseBool(v: string): boolean | undefined {
  const x = v.trim().toLowerCase()
  if (['yes', 'true', '1', 'on'].includes(x)) return true
  if (['no', 'false', '0', 'off'].includes(x)) return false
  return undefined
}

const bool = (sec: SmbSection | undefined, key: string, def: boolean) => {
  const v = sec?.params.get(key)
  return v === undefined ? def : (parseBool(v) ?? def)
}
const list = (v: string | undefined) => (v ?? '').split(/[\s,]+/).filter(Boolean)
const octal = (v: string | undefined, def: number) => (v && /^0?[0-7]{3,4}$/.test(v.trim()) ? parseInt(v.trim(), 8) : def)

export function confPath(_sys?: System) {
  return '/etc/samba/smb.conf'
}

export function readSmbConf(sys: System): SmbConf {
  const f = confPath(sys)
  const text = sys.vfs.exists(f) ? sys.vfs.readFile(f, ROOT_CRED) : ''
  const conf = parseSmbConf(text, f)
  for (const inc of [...conf.global.entries()].filter(([k]) => k === 'include').map(([, v]) => v)) {
    if (!sys.vfs.exists(inc)) conf.messages.push(`Can't find include file ${inc}`)
  }
  return conf
}

export function smbVersion(sys: System) {
  return sys.distro === 'rocky' ? '4.23.5' : '4.23.6-Ubuntu'
}

export const smbService = (sys: System) => (sys.distro === 'rocky' ? 'smb' : 'smbd')

// ---------------------------------------------------------------------------------------
// Estado del servidor: cuentas de Samba y lo que cargó smbd
// ---------------------------------------------------------------------------------------

interface SmbState {
  passdb: Map<string, { password: string; enabled: boolean }>
  loaded?: SmbConf
  sessions: { pid: number; user: string; group: string; ip: string; port: number; share: string; since: number }[]
}

const STATE = new WeakMap<System, SmbState>()

export function smbState(sys: System): SmbState {
  let s = STATE.get(sys)
  if (!s) {
    s = { passdb: new Map(), sessions: [] }
    STATE.set(sys, s)
  }
  return s
}

function running(sys: System) {
  return !!sys.services.get(smbService(sys))?.active
}

/** smbd lee smb.conf al arrancar y vuelve a leerlo solo (en Samba los cambios se aplican sin reiniciar). */
function liveConf(sys: System): SmbConf {
  const c = readSmbConf(sys)
  if (!c.fatal.length) smbState(sys).loaded = c
  return smbState(sys).loaded ?? c
}

SERVICE_CHECKS['smb'] = SERVICE_CHECKS['smbd'] = (ctx) => {
  const c = readSmbConf(ctx.sys)
  if (c.fatal.length) {
    for (const m of c.fatal) ctx.sys.log(`${smbService(ctx.sys)}.service`, m, 3)
    return `${c.fatal[0]}\nError loading services.`
  }
  smbState(ctx.sys).loaded = c
  return undefined
}

System.initHooks.push((sys, state) => {
  const spec = state.samba
  if (!spec) return
  for (const u of spec.usuarios) smbState(sys).passdb.set(u.nombre, { password: u.clave, enabled: true })
  if (running(sys)) smbState(sys).loaded = readSmbConf(sys)
  if (spec.usuarios.length) sys.vfs.writeFile('/var/lib/samba/private/passdb.tdb', 'TDB file\n', ROOT_CRED, { mode: 0o600 })
})

// ---------------------------------------------------------------------------------------
// Acceso: sesión, recurso y operaciones
// ---------------------------------------------------------------------------------------

export type NtStatus =
  | 'NT_STATUS_LOGON_FAILURE'
  | 'NT_STATUS_ACCESS_DENIED'
  | 'NT_STATUS_BAD_NETWORK_NAME'
  | 'NT_STATUS_HOST_UNREACHABLE'
  | 'NT_STATUS_IO_TIMEOUT'
  | 'NT_STATUS_CONNECTION_REFUSED'
  | 'NT_STATUS_ACCOUNT_DISABLED'

export interface SmbSession {
  server: System
  conf: SmbConf
  user: string
  guest: boolean
  clientIp: string
  serverIp: string
}

export interface SmbTree {
  sess: SmbSession
  share: SmbSection
  path: string
  cred: Cred
  writable: boolean
  createMask: number
  dirMask: number
  forceCreate: number
  forceDir: number
}

function unixCred(server: System, user: string): Cred | undefined {
  const u = server.users.get(user)
  if (!u) return undefined
  const groups = [...server.groups.values()].filter((g) => g.members.includes(user) || g.gid === u.gid).map((g) => g.gid)
  return { uid: u.uid, gid: u.gid, groups }
}

/** Conecta con el servidor y se autentica. guest: sin usuario (-N). */
export function smbConnect(client: System, host: string, user: string | undefined, password: string | undefined): SmbSession | NtStatus {
  const ip = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : client.resolveHost(host)
  if (!ip) return 'NT_STATUS_HOST_UNREACHABLE'
  const r = reach(client, ip, 445)
  if ('error' in r) return r.error === 'noroute' ? 'NT_STATUS_HOST_UNREACHABLE' : 'NT_STATUS_IO_TIMEOUT'
  const server = r.target
  if (!running(server)) return 'NT_STATUS_CONNECTION_REFUSED'
  const conf = liveConf(server)
  const hostsAllow = list(conf.global.get('hosts allow'))
  if (hostsAllow.length && !hostsAllow.some((h) => hostMatch(h, r.clientIp))) return 'NT_STATUS_ACCESS_DENIED'
  if (!user) return { server, conf, user: 'nobody', guest: true, clientIp: r.clientIp, serverIp: ip }
  const acct = smbState(server).passdb.get(user)
  const mapGuest = (conf.global.get('map to guest') ?? 'Never').toLowerCase()
  if (!acct) {
    if (mapGuest === 'bad user') return { server, conf, user: 'nobody', guest: true, clientIp: r.clientIp, serverIp: ip }
    return 'NT_STATUS_LOGON_FAILURE'
  }
  if (acct.password !== password) return 'NT_STATUS_LOGON_FAILURE'
  if (!acct.enabled) return 'NT_STATUS_ACCOUNT_DISABLED'
  return { server, conf, user, guest: false, clientIp: r.clientIp, serverIp: ip }
}

function hostMatch(spec: string, ip: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(spec)) return inSubnet(ip, spec)
  if (/^\d+\.(\d+\.){0,2}$/.test(spec)) return ip.startsWith(spec)
  if (spec === 'ALL') return true
  return ip === spec || (spec === '127.' && ip.startsWith('127.'))
}

/** ¿El usuario entra en una lista de smb.conf (nombres, @grupo o +grupo)? */
function inList(server: System, user: string, items: string[], share: string): boolean {
  return items.some((it) => {
    const x = it.replace(/%S/g, share)
    if (x.startsWith('@') || x.startsWith('+') || x.startsWith('&')) {
      const g = [...server.groups.values()].find((gr) => gr.name === x.replace(/^[@+&]+/, ''))
      if (!g) return false
      const u = server.users.get(user)
      return g.members.includes(user) || (!!u && u.gid === g.gid)
    }
    return x === user
  })
}

export function treeConnect(sess: SmbSession, name: string): SmbTree | NtStatus {
  const { server, conf } = sess
  let share = conf.shares.find((s) => s.name.toLowerCase() === name.toLowerCase() && s.name.toLowerCase() !== 'homes')
  // [homes]: el recurso con el nombre del usuario es su carpeta personal.
  if (!share && !sess.guest && name.toLowerCase() === sess.user.toLowerCase()) {
    const homes = conf.shares.find((s) => s.name.toLowerCase() === 'homes')
    const u = server.users.get(sess.user)
    if (homes && u) share = { name: sess.user, params: new Map([...homes.params, ['path', homes.params.get('path') ?? u.home]]), line: homes.line }
  }
  if (!share || bool(share, 'printable', false) || bool(share, 'available', true) === false) return 'NT_STATUS_BAD_NETWORK_NAME'
  const p = share.params
  const allow = list(p.get('hosts allow'))
  if (allow.length && !allow.some((h) => hostMatch(h, sess.clientIp))) return 'NT_STATUS_ACCESS_DENIED'
  if (sess.guest && !bool(share, 'guest ok', false)) return 'NT_STATUS_ACCESS_DENIED'
  const user = sess.guest ? (conf.global.get('guest account') ?? 'nobody') : sess.user
  const valid = list(p.get('valid users'))
  if (!sess.guest && valid.length && !inList(server, user, valid, share.name)) return 'NT_STATUS_ACCESS_DENIED'
  if (!sess.guest && inList(server, user, list(p.get('invalid users')), share.name)) return 'NT_STATUS_ACCESS_DENIED'
  const path = normalizePath((p.get('path') ?? '').replace(/%S/g, share.name).replace(/%U/g, user) || '/tmp')
  if (!p.get('path') && share.name.toLowerCase() !== sess.user.toLowerCase()) return 'NT_STATUS_BAD_NETWORK_NAME'
  if (!server.vfs.exists(path)) {
    server.log(`${smbService(server)}.service`, `make_connection_snum: '${path}' does not exist or permission denied when connecting to [${share.name}] Error was No such file or directory`, 3)
    return 'NT_STATUS_BAD_NETWORK_NAME'
  }
  let cred = unixCred(server, p.get('force user') ?? user) ?? { uid: 65534, gid: 65534, groups: [65534] }
  const fg = p.get('force group')
  if (fg) {
    const g = [...server.groups.values()].find((x) => x.name === fg.replace(/^[+@]/, ''))
    if (g) cred = { ...cred, gid: g.gid, groups: [...new Set([g.gid, ...cred.groups])] }
  }
  let writable = !bool(share, 'read only', true)
  if (inList(server, user, list(p.get('write list')), share.name)) writable = true
  if (inList(server, user, list(p.get('read list')), share.name)) writable = false
  return {
    sess,
    share,
    path,
    cred,
    writable,
    createMask: octal(p.get('create mask'), 0o744),
    dirMask: octal(p.get('directory mask'), 0o755),
    forceCreate: octal(p.get('force create mode'), 0),
    forceDir: octal(p.get('force directory mode'), 0),
  }
}

/** SELinux en el servidor: smbd solo toca lo etiquetado para Samba (o lo que permitan los booleanos). */
function selinuxAllows(server: System, rpath: string, write: boolean): boolean {
  if (server.distro !== 'rocky' || server.selinux.mode !== 'enforcing') return true
  const b = (n: string) => !!server.selinux.booleans.get(n)?.cur
  if (b('samba_export_all_rw')) return true
  if (!write && b('samba_export_all_ro')) return true
  let p = rpath
  while (!server.vfs.exists(p, ROOT_CRED) && p !== '/') p = dirname(p)
  const ctxs = contextOf(server, p)
  const t = typeOf(ctxs)
  if (t === 'samba_share_t' || t === 'public_content_rw_t') return true
  if (t === 'public_content_t') return !write
  if (/^user_home/.test(t) && b('samba_enable_home_dirs')) return true
  avc(server, 'smbd', write ? 'write' : 'read', `name="${basename(p) || '/'}"`, 'smbd_t', ctxs, server.vfs.stat(p, ROOT_CRED).type === 'dir' ? 'dir' : 'file')
  return false
}

/** Error de una operación en el recurso, o undefined si se puede. */
export function treeCheck(tree: SmbTree, rpath: string, write: boolean): FsErrorCode | undefined {
  if (!running(tree.sess.server)) return 'EIO'
  if (write && !tree.writable) return 'EACCES'
  if (!selinuxAllows(tree.sess.server, rpath, write)) return 'EACCES'
  return undefined
}

function createModeOf(tree: SmbTree) {
  return (mode: number, dir: boolean) => (dir ? ((mode & tree.dirMask) | tree.forceDir) : ((0o766 & tree.createMask) | tree.forceCreate)) & 0o7777
}

function ntOf(e: unknown, notFound: string = 'NT_STATUS_OBJECT_NAME_NOT_FOUND'): string {
  if (e instanceof FsError) {
    if (e.code === 'ENOENT') return notFound
    if (e.code === 'EEXIST') return 'NT_STATUS_OBJECT_NAME_COLLISION'
    if (e.code === 'ENOTEMPTY') return 'NT_STATUS_DIRECTORY_NOT_EMPTY'
    if (e.code === 'ENOTDIR') return 'NT_STATUS_NOT_A_DIRECTORY'
    if (e.code === 'EISDIR') return 'NT_STATUS_FILE_IS_A_DIRECTORY'
  }
  return 'NT_STATUS_ACCESS_DENIED'
}

// ---------------------------------------------------------------------------------------
// testparm, smbpasswd, pdbedit, smbstatus
// ---------------------------------------------------------------------------------------

const ROLE: Record<string, string> = { user: 'ROLE_STANDALONE', ads: 'ROLE_DOMAIN_MEMBER', domain: 'ROLE_DOMAIN_MEMBER' }

function dump(conf: SmbConf): string {
  const g = new Map(conf.global)
  if (!g.has('security')) g.set('security', 'USER')
  else g.set('security', g.get('security')!.toUpperCase())
  let out = '# Global parameters\n[global]\n'
  for (const [k, v] of [...g].filter(([k]) => k !== 'include').sort(([a], [b]) => a.localeCompare(b))) out += `\t${k} = ${v}\n`
  for (const s of conf.shares) {
    out += `\n\n[${s.name}]\n`
    for (const [k, v] of s.params) {
      const val = ['read only', 'browseable', 'guest ok', 'printable', 'inherit acls', 'inherit permissions', 'guest only', 'available'].includes(k) ? (parseBool(v) ? 'Yes' : 'No') : v
      out += `\t${k} = ${val}\n`
    }
  }
  return out
}

register('testparm', {
  usage: 'testparm [-s] [archivo]',
  summary: '  -s   no espera Enter: muestra la configuración efectiva enseguida',
  path: '/usr/bin',
  run(ctx) {
    const file = ctx.args.find((a) => !a.startsWith('-')) ?? '/etc/samba/smb.conf'
    const sys = ctx.sys
    if (!sys.vfs.exists(file)) {
      ctx.err(`Load smb config files from ${file}\nCan't load ${file} - run testparm to debug it\n`)
      return 1
    }
    const conf = parseSmbConf(sys.vfs.readFile(file, ctx.sh.cred), file)
    ctx.err(`Load smb config files from ${file}\n`)
    for (const m of conf.messages) ctx.err(m + '\n')
    if (conf.fatal.length) return 1
    const role = ROLE[(conf.global.get('security') ?? 'user').toLowerCase()] ?? 'ROLE_STANDALONE'
    ctx.err(`Loaded services file OK.\nWeak crypto is allowed by GnuTLS (e.g. NTLM as a compatibility fallback)\n\nServer role: ${role}\n\n`)
    if (!ctx.args.includes('-s')) ctx.err('Press enter to see a dump of your service definitions\n\n')
    ctx.out(dump(conf))
    return 0
  },
})

class SecretAsk implements Foreground {
  secret = true
  constructor(
    private label: string,
    private onLine: (pw: string, io: IO) => Promise<'exit' | void>,
  ) {}
  prompt() {
    return this.label
  }
  line(text: string, io: IO) {
    return this.onLine(text, io)
  }
}

register('smbpasswd', {
  usage: 'smbpasswd [-a|-x|-d|-e] [-s] usuario',
  summary: '  -a  agrega la cuenta (el usuario tiene que existir en Linux)\n  -x  la borra   -d  la deshabilita   -e  la habilita\n  -s  lee la contraseña de la entrada estándar (dos veces)',
  path: '/usr/bin',
  run(ctx) {
    const sys = ctx.sys
    const flags = new Set(ctx.args.filter((a) => /^-[axdes]+$/.test(a)).flatMap((a) => [...a.slice(1)]))
    const user = ctx.args.find((a) => !a.startsWith('-')) ?? ctx.sh.user
    const db = smbState(sys).passdb
    if (ctx.sh.user !== 'root' && (flags.has('a') || flags.has('x') || flags.has('d') || flags.has('e') || user !== ctx.sh.user)) {
      ctx.err('smbpasswd: Failed to open passdb: only root can change other users or add, delete, enable or disable accounts.\n')
      return 1
    }
    const touchDb = () => sys.vfs.writeFile('/var/lib/samba/private/passdb.tdb', 'TDB file\n', ROOT_CRED, { mode: 0o600 })
    if (flags.has('x')) {
      if (!db.delete(user)) {
        ctx.err(`Failed to find entry for user ${user}.\nFailed to delete entry for user ${user}.\n`)
        return 1
      }
      ctx.out(`Deleted user ${user}.\n`)
      return 0
    }
    if (flags.has('d') || flags.has('e')) {
      const a = db.get(user)
      if (!a) {
        ctx.err(`Failed to find entry for user ${user}.\n`)
        return 1
      }
      a.enabled = flags.has('e')
      ctx.out(`${flags.has('e') ? 'Enabled' : 'Disabled'} user ${user}.\n`)
      return 0
    }
    if (!flags.has('a') && !db.has(user)) {
      ctx.err(`Failed to find entry for user ${user}.\nFailed to modify password entry for user ${user}\n`)
      return 1
    }
    const finish = (p1: string, p2: string, io: { out: (s: string) => void; err: (s: string) => void }): number => {
      if (p1 !== p2) {
        io.err('Mismatch - password unchanged.\nUnable to get new password.\n')
        return 1
      }
      if (!sys.users.has(user)) {
        io.err(`Failed to add entry for user ${user}.\n`)
        return 1
      }
      const existed = db.has(user)
      db.set(user, { password: p1, enabled: db.get(user)?.enabled ?? true })
      touchDb()
      if (flags.has('a') && !existed) io.out(`Added user ${user}.\n`)
      return 0
    }
    if (flags.has('s') || !ctx.isTTY) {
      const lines = ctx.stdin.readAll().split('\n')
      return finish(lines[0] ?? '', lines[1] ?? '', ctx)
    }
    let first = ''
    ctx.sh.fg = new SecretAsk('New SMB password:', async (pw) => {
      first = pw
      ctx.sh.fg = new SecretAsk('Retype new SMB password:', async (pw2, io) => {
        ctx.sh.fg = undefined
        ctx.sh.lastExit = finish(first, pw2, io)
        return 'exit'
      })
    })
    return 0
  },
})

register('pdbedit', {
  usage: 'pdbedit -L [-v]',
  path: '/usr/bin',
  run(ctx) {
    if (ctx.sh.user !== 'root') {
      ctx.err('Unable to open passdb database.\n')
      return 1
    }
    const sys = ctx.sys
    if (!ctx.args.some((a) => /^-\w*L/.test(a) || a === '--list')) {
      ctx.err('[simulador] Acá pdbedit solo lista las cuentas: pdbedit -L (con -v, el detalle).\n')
      return 1
    }
    const verbose = ctx.args.some((a) => /^-\w*v/.test(a))
    for (const [name, a] of smbState(sys).passdb) {
      const u = sys.users.get(name)
      if (!verbose) ctx.out(`${name}:${u?.uid ?? ''}:${u?.gecos ?? ''}\n`)
      else ctx.out(`---------------\nUnix username:        ${name}\nNT username:          \nAccount Flags:        [U${a.enabled ? ' ' : 'D'}         ]\nUser SID:             S-1-5-21-3417203281-3172928402-1683329427-${1000 + (u?.uid ?? 0)}\nPrimary Group SID:    S-1-5-21-3417203281-3172928402-1683329427-513\nFull Name:            ${u?.gecos ?? ''}\nHome Directory:       \\\\${sys.hostname.toUpperCase()}\\${name}\nLogon Script:         \nPassword must change: never\n`)
    }
    return 0
  },
})

register('smbstatus', {
  usage: 'smbstatus [-b|-S]',
  path: '/usr/bin',
  run(ctx) {
    const sys = ctx.sys
    if (ctx.sh.user !== 'root') {
      ctx.err('smbstatus only works as root!\n')
      return 1
    }
    const s = smbState(sys)
    const brief = ctx.args.includes('-b')
    const sharesOnly = ctx.args.includes('-S')
    if (!sharesOnly) {
      ctx.out(`\nSamba version ${smbVersion(sys)}\nPID     Username     Group        Machine                                   Protocol Version  Encryption           Signing              \n${'-'.repeat(136)}\n`)
      for (const x of s.sessions) ctx.out(`${String(x.pid).padEnd(8)}${x.user.padEnd(13)}${x.group.padEnd(13)}${`${x.ip} (ipv4:${x.ip}:${x.port})`.padEnd(42)}SMB3_11           -                    partial(AES-128-GMAC)\n`)
      ctx.out('\n')
    }
    if (!brief) {
      ctx.out(`Service      pid     Machine       Connected at                     Encryption   Signing     \n${'-'.repeat(93)}\n`)
      for (const x of s.sessions) ctx.out(`${x.share.padEnd(13)}${String(x.pid).padEnd(8)}${x.ip.padEnd(14)}${new Date(x.since).toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, '$1 $3 $2 $5 $4 UTC').padEnd(33)}-            -           \n`)
      ctx.out('\nNo locked files\n\n')
    }
    return 0
  },
})

// ---------------------------------------------------------------------------------------
// smbclient
// ---------------------------------------------------------------------------------------

function workgroup(sys: System) {
  return sys.distro === 'rocky' ? 'SAMBA' : 'WORKGROUP'
}

function smbDate(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getFullYear()}`
}

function sizeOfServer(tree: SmbTree): [number, number] {
  const st = tree.sess.server.storage
  const m = st.mountOfPath(tree.path)
  const sig = m?.dev ? st.sigs.get(m.dev) : undefined
  const size = Math.floor((sig?.size ?? 17 * 1024 ** 3) / 1024)
  return [size, size - Math.floor((m?.dev ? st.used(m.dev) : 4 * 1024 ** 3) / 1024)]
}

function statusLine(e: NtStatus): string {
  return e === 'NT_STATUS_LOGON_FAILURE' || e === 'NT_STATUS_ACCOUNT_DISABLED' ? `session setup failed: ${e}` : `tree connect failed: ${e}`
}

class SmbRepl implements Foreground {
  cwd = '\\'
  constructor(
    private tree: SmbTree,
    private ctx: CommandContext,
  ) {}
  prompt() {
    return `smb: ${this.cwd}${this.cwd.endsWith('\\') ? '' : '\\'}> `
  }
  async line(text: string, io: IO): Promise<'exit' | void> {
    const r = runSmbCommand(this, text, io, this.ctx)
    if (r === 'exit') {
      this.ctx.sh.fg = undefined
      return 'exit'
    }
  }
  get t() {
    return this.tree
  }
}

function rpathOf(repl: SmbRepl, name: string): string {
  const rel = name.startsWith('\\') || name.startsWith('/') ? name : `${repl.cwd}\\${name}`
  return normalizePath(`${repl.t.path}/${rel.replace(/\\/g, '/')}`)
}

function smbShow(rpath: string, tree: SmbTree): string {
  const rel = rpath.slice(tree.path.length).replace(/\//g, '\\')
  return rel || '\\'
}

function runSmbCommand(repl: SmbRepl, text: string, io: { out: (s: string) => void; err: (s: string) => void }, ctx: CommandContext): 'exit' | number {
  const tree = repl.t
  const v = tree.sess.server.vfs
  const parts = text.trim().match(/"[^"]*"|\S+/g)?.map((x) => x.replace(/^"|"$/g, '')) ?? []
  const [cmd, ...args] = parts
  if (!cmd) return 0
  const deny = (rp: string, write: boolean) => treeCheck(tree, rp, write)
  switch (cmd.toLowerCase()) {
    case 'exit':
    case 'quit':
    case 'q':
    case 'bye':
      return 'exit'
    case 'help':
    case '?':
      io.out('?              allinfo        altname        archive        backup\nblocksize      cancel         case_sensitive cd             chmod\nchown          close          del            deltree        dir\ndu             echo           exit           get            getfacl\nhardlink       help           history        iosize         lcd\nlink           lock           lowercase      ls             l\nmask           md             mget           mkdir          more\nmput           newer          notify         open           posix\nprint          prompt         put            pwd            q\nqueue          quit           readlink       rd             recurse\nreget          rename         reput          rm             rmdir\nshowacls       setea          setmode        scopy          stat\nsymlink        tar            tarmode        timeout        translate\nunlock         volume         vuid           wdel           logon\nlistconnect    showconnect    tcon           tdis           tid\nutimes         logoff         ..             !\n')
      return 0
    case 'pwd':
      io.out(`Current directory is \\\\${tree.sess.serverIp}\\${tree.share.name}${repl.cwd}\n`)
      return 0
    case 'ls':
    case 'dir':
    case 'l': {
      const rp = rpathOf(repl, '')
      const d = deny(rp, false)
      let names: string[]
      try {
        if (d) throw new FsError(d, rp)
        names = v.readdir(rp, tree.cred)
      } catch (e) {
        io.err(`${ntOf(e)} listing ${smbShow(rp, tree).replace(/\\$/, '')}\\*\n`)
        return 1
      }
      const self = v.stat(rp, ROOT_CRED)
      const parent = v.stat(dirname(rp), ROOT_CRED)
      const row = (name: string, n: Inode) => `  ${name.padEnd(36)}${(n.type === 'dir' ? 'D' : 'N').padStart(1)}${String(n.type === 'dir' ? 0 : n.data.length).padStart(9)}  ${smbDate(n.mtime)}\n`
      let out = row('.', self) + row('..', parent)
      for (const name of names.filter((x) => !x.startsWith('.') || true)) out += row(name, v.stat(`${rp}/${name}`, ROOT_CRED))
      const [blocks, avail] = sizeOfServer(tree)
      io.out(`${out}\n\t\t${blocks} blocks of size 1024. ${avail} blocks available\n`)
      return 0
    }
    case 'cd': {
      if (!args[0]) {
        io.out(`Current directory is ${repl.cwd}\n`)
        return 0
      }
      const rp = rpathOf(repl, args[0])
      if (!rp.startsWith(tree.path) || !v.exists(rp, tree.cred) || v.stat(rp, tree.cred).type !== 'dir') {
        io.err(`cd ${smbShow(rp, tree)}\\: NT_STATUS_OBJECT_NAME_NOT_FOUND\n`)
        return 1
      }
      repl.cwd = smbShow(rp, tree)
      return 0
    }
    case 'get': {
      if (!args[0]) {
        io.err('get <filename> [localname]\n')
        return 1
      }
      const rp = rpathOf(repl, args[0])
      let data: string
      try {
        const d = deny(rp, false)
        if (d) throw new FsError(d, rp)
        data = v.readFile(rp, tree.cred)
      } catch (e) {
        io.err(`${ntOf(e)} opening remote file ${smbShow(rp, tree)}\n`)
        return 1
      }
      const local = ctx.sh.resolve(args[1] ?? basename(rp))
      try {
        ctx.sys.vfs.writeFile(local, data, ctx.sh.cred, { umask: ctx.sh.umask })
      } catch {
        io.err(`Error opening local file ${args[1] ?? basename(rp)}\n`)
        return 1
      }
      io.out(`getting file ${smbShow(rp, tree)} of size ${data.length} as ${args[1] ?? basename(rp)} (${Math.max(0.1, data.length / 1024 / 0.001).toFixed(1)} KiloBytes/sec) (average ${Math.max(0.1, data.length / 1024 / 0.001).toFixed(1)} KiloBytes/sec)\n`)
      return 0
    }
    case 'put': {
      if (!args[0]) {
        io.err('put <filename> [remotename]\n')
        return 1
      }
      const localPath = ctx.sh.resolve(args[0])
      let data: string
      try {
        data = ctx.sys.vfs.readFile(localPath, ctx.sh.cred)
      } catch {
        io.err(`${args[0]} does not exist\n`)
        return 1
      }
      const rp = rpathOf(repl, args[1] ?? basename(args[0]))
      try {
        const d = deny(rp, true)
        if (d) throw new FsError(d, rp)
        const existed = v.exists(rp, tree.cred)
        v.writeFile(rp, data, tree.cred, existed ? {} : { mode: createModeOf(tree)(0o666, false), umask: 0 })
      } catch (e) {
        io.err(`${ntOf(e)} opening remote file ${smbShow(rp, tree)}\n`)
        return 1
      }
      const kb = Math.max(0.1, data.length / 1024 / 0.001).toFixed(1)
      io.out(`putting file ${args[0]} as ${smbShow(rp, tree)} (${kb} kb/s) (average ${kb} kb/s)\n`)
      return 0
    }
    case 'mkdir':
    case 'md': {
      const rp = rpathOf(repl, args[0] ?? '')
      try {
        const d = deny(rp, true)
        if (d) throw new FsError(d, rp)
        v.mkdir(rp, tree.cred, createModeOf(tree)(0o777, true), 0)
      } catch (e) {
        io.err(`${ntOf(e)} making remote directory ${smbShow(rp, tree)}\n`)
        return 1
      }
      return 0
    }
    case 'rmdir':
    case 'rd': {
      const rp = rpathOf(repl, args[0] ?? '')
      try {
        const d = deny(rp, true)
        if (d) throw new FsError(d, rp)
        v.rmdir(rp, tree.cred)
      } catch (e) {
        io.err(`${ntOf(e)} removing remote directory file ${smbShow(rp, tree)}\n`)
        return 1
      }
      return 0
    }
    case 'del':
    case 'rm': {
      const rp = rpathOf(repl, args[0] ?? '')
      try {
        const d = deny(rp, true)
        if (d) throw new FsError(d, rp)
        v.unlink(rp, tree.cred)
      } catch (e) {
        io.err(`${ntOf(e, 'NT_STATUS_NO_SUCH_FILE')} deleting remote file ${smbShow(rp, tree)}\n`)
        return 1
      }
      return 0
    }
    case 'lcd':
      ctx.sh.cwd = ctx.sh.resolve(args[0] ?? ctx.sh.home)
      io.out(`Current directory is ${ctx.sh.cwd}\n`)
      return 0
    default:
      io.err(`${cmd}: command not found\n`)
      return 1
  }
}

/** -U usuario, -U usuario%clave, -U 'DOMINIO\usuario', -A archivo de credenciales. */
function parseUser(ctx: CommandContext, args: string[]): { user?: string; password?: string; anon: boolean } {
  let user: string | undefined
  let password: string | undefined
  let anon = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-N' || a === '--no-pass') anon = true
    else if (a === '-U' || a === '--user') user = args[++i]
    else if (a.startsWith('--user=')) user = a.slice(7)
    else if (a.startsWith('-U') && a.length > 2) user = a.slice(2)
    else if (a === '-A' || a === '--authentication-file') {
      const f = args[++i]
      try {
        const text = ctx.sys.vfs.readFile(ctx.sh.resolve(f), ctx.sh.cred)
        user = /^username\s*=\s*(.+)$/m.exec(text)?.[1].trim() ?? user
        password = /^password\s*=\s*(.+)$/m.exec(text)?.[1].trim() ?? password
      } catch {
        /* sin archivo: pide la contraseña */
      }
    }
  }
  if (user?.includes('%')) {
    const [u, ...p] = user.split('%')
    user = u
    password = p.join('%')
  }
  if (user) user = user.replace(/^.*[\\/]/, '')
  return { user, password, anon }
}

function listShares(sess: SmbSession, io: { out: (s: string) => void }) {
  const rows = sess.conf.shares.filter((s) => s.name.toLowerCase() !== 'homes' && bool(s, 'browseable', true) && !bool(s, 'printable', false))
  let out = `\n\tSharename       Type      Comment\n\t---------       ----      -------\n`
  for (const s of rows) out += `\t${s.name.padEnd(16)}Disk      ${s.params.get('comment') ?? ''}\n`
  out += `\tIPC$            IPC       IPC Service (${sess.conf.global.get('server string') ?? `Samba ${smbVersion(sess.server)}`})\n`
  if (!sess.guest && sess.conf.shares.some((s) => s.name.toLowerCase() === 'homes')) out += `\t${sess.user.padEnd(16)}Disk      Home Directories\n`
  io.out(out + 'SMB1 disabled -- no workgroup available\n')
}

register('smbclient', {
  usage: "smbclient -L //servidor [-U usuario] | smbclient //servidor/recurso [-U usuario[%clave]] [-c 'comando; comando']",
  summary: "  -L        lista los recursos del servidor\n  -U        usuario (usuario%clave para no escribirla)\n  -N        sin usuario (invitado)\n  -A        archivo con username= y password=\n  -c        comandos separados por ; (ls, cd, get, put, mkdir, rm)",
  path: '/usr/bin',
  async run(ctx) {
    const args = [...ctx.args]
    const li = args.indexOf('-L')
    const listMode = li >= 0
    const target = listMode ? args[li + 1] : args.find((a) => /^(\/\/|\\\\)/.test(a))
    if (!target) {
      ctx.err('Usage: smbclient [-?EgqBNPkV] [-?|--help] [--usage] [-M|--message=HOST] [-I|--ip-address=IP]\n        [-E|--stderr] [-L|--list=HOST] [-T|--tar=<c|x>IXFvgbNan] ... service <password>\n')
      return 1
    }
    const m = /^(?:\/\/|\\\\)([^/\\]+)(?:[/\\]([^/\\]+))?/.exec(target) ?? [target, target.replace(/^\/\/|^\\\\/, ''), undefined]
    const host = m[1]
    const shareName = m[2]
    const cIdx = args.indexOf('-c')
    const commands = cIdx >= 0 ? args[cIdx + 1] : undefined
    const u = parseUser(ctx, args)
    const user = u.anon ? undefined : (u.user ?? ctx.sh.user)
    const go = (pw: string | undefined, io: IO | CommandContext): number | 'repl' => {
      const sess = smbConnect(ctx.sys, host, user, pw)
      if (typeof sess === 'string') {
        if (sess === 'NT_STATUS_HOST_UNREACHABLE' || sess === 'NT_STATUS_IO_TIMEOUT' || sess === 'NT_STATUS_CONNECTION_REFUSED') io.err(`do_connect: Connection to ${host} failed (Error ${sess})\n`)
        else io.err(`${statusLine(sess)}\n`)
        return 1
      }
      if (sess.guest && !user) io.out('Anonymous login successful\n')
      if (listMode) {
        listShares(sess, io)
        return 0
      }
      const tree = treeConnect(sess, shareName ?? '')
      if (typeof tree === 'string') {
        io.err(`tree connect failed: ${tree}\n`)
        return 1
      }
      const repl = new SmbRepl(tree, ctx)
      if (commands !== undefined) {
        let code = 0
        for (const c of commands.split(';')) {
          const r = runSmbCommand(repl, c, io, ctx)
          if (r === 'exit') break
          if (r) code = r
        }
        return code
      }
      if (!ctx.isTTY) return 0
      io.out('Try "help" to get a list of possible commands.\n')
      ctx.sh.fg = repl
      return 'repl'
    }
    if (user && u.password === undefined) {
      if (!ctx.isTTY) {
        ctx.err('[simulador] Con la entrada redirigida no se puede escribir la contraseña: usá -U usuario%clave o -A archivo.\n')
        return 1
      }
      ctx.sh.fg = new SecretAsk(`Password for [${workgroup(ctx.sys)}\\${user}]:`, async (pw, io) => {
        ctx.sh.fg = undefined
        const r = go(pw, io)
        if (r === 'repl') return
        ctx.sh.lastExit = r
        return 'exit'
      })
      return 0
    }
    const r = go(u.password, ctx)
    return r === 'repl' ? 0 : r
  },
})

// ---------------------------------------------------------------------------------------
// mount -t cifs
// ---------------------------------------------------------------------------------------

let nextPid = 40210

function cifsMount(ctx: CommandContext, spec: string, target: string, type: string | undefined, options: string, auto = false): string | undefined | null {
  if (type !== 'cifs' && type !== 'smb3' && !(!type && /^(\/\/|\\\\)/.test(spec))) return null
  const sys = ctx.sys
  const abs = normalizePath(target)
  if (!sys.installed.has('cifs-utils')) return 'bad option; for several filesystems (e.g. nfs, cifs) you might need a /sbin/mount.<type> helper program.'
  const m = /^(?:\/\/|\\\\)([^/\\]+)[/\\]([^/\\]+)/.exec(spec)
  if (!m) return 'mount error(22): Invalid argument\nRefer to the mount.cifs(8) manual page (e.g. man mount.cifs) and kernel log messages (dmesg)'
  if (!sys.vfs.exists(abs)) return `mount error(2): No such file or directory\nRefer to the mount.cifs(8) manual page (e.g. man mount.cifs) and kernel log messages (dmesg)`
  if (sys.storage.mounts.some((x) => x.target === abs && (!auto || x.fstype !== 'autofs'))) return `mount error(16): Device or resource busy\nRefer to the mount.cifs(8) manual page (e.g. man mount.cifs) and kernel log messages (dmesg)`
  const [, host, shareName] = m
  const opts = new Map<string, string>()
  for (const o of options.split(',').filter(Boolean)) {
    const i = o.indexOf('=')
    opts.set(i < 0 ? o : o.slice(0, i), i < 0 ? '' : o.slice(i + 1))
  }
  let user = opts.get('username') ?? opts.get('user')
  let password = opts.get('password') ?? opts.get('pass')
  const credFile = opts.get('credentials') ?? opts.get('cred')
  if (credFile) {
    try {
      const text = sys.vfs.readFile(credFile, ROOT_CRED)
      user = /^(?:username|user)\s*=\s*(.+)$/m.exec(text)?.[1].trim() ?? user
      password = /^(?:password|pass)\s*=\s*(.+)$/m.exec(text)?.[1].trim() ?? password
    } catch {
      return `error 2 (No such file or directory) opening credential file ${credFile}`
    }
  }
  const guest = opts.has('guest')
  if (!guest && password === undefined) return 'mount error(13): Permission denied\n[simulador] mount.cifs pediría la contraseña: pasala con credentials=/ruta/al/archivo (lo recomendable) o password= en -o.'
  const sess = smbConnect(sys, host, guest ? undefined : (user ?? 'root'), password)
  const help = '\nRefer to the mount.cifs(8) manual page (e.g. man mount.cifs) and kernel log messages (dmesg)'
  const ip = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : sys.resolveHost(host)
  if (typeof sess === 'string') {
    if (sess === 'NT_STATUS_HOST_UNREACHABLE') return ip ? `mount error(113): could not connect to ${ip}Unable to find suitable address.` : `mount error: could not resolve address for ${host}: Unknown error`
    if (sess === 'NT_STATUS_IO_TIMEOUT') return `mount error(112): Host is down${help}`
    if (sess === 'NT_STATUS_CONNECTION_REFUSED') return `mount error(111): could not connect to ${ip}Unable to find suitable address.`
    return `mount error(13): Permission denied${help}`
  }
  const tree = treeConnect(sess, shareName)
  if (tree === 'NT_STATUS_BAD_NETWORK_NAME') return `mount error(2): No such file or directory${help}`
  if (typeof tree === 'string') return `mount error(13): Permission denied${help}`
  const uidOpt = opts.get('uid')
  const gidOpt = opts.get('gid')
  const lookupU = (v?: string) => (v === undefined ? 0 : /^\d+$/.test(v) ? Number(v) : (sys.users.get(v)?.uid ?? 0))
  const lookupG = (v?: string) => (v === undefined ? 0 : /^\d+$/.test(v) ? Number(v) : ([...sys.groups.values()].find((g) => g.name === v)?.gid ?? 0))
  const uid = lookupU(uidOpt)
  const gid = lookupG(gidOpt)
  const fileMode = octal(opts.get('file_mode'), 0o755)
  const dirMode = octal(opts.get('dir_mode'), 0o755)
  const ro = opts.has('ro')
  const final = [
    ro ? 'ro' : 'rw',
    'relatime',
    `vers=${opts.get('vers') ?? '3.1.1'}`,
    'cache=strict',
    `username=${guest ? '' : user}`,
    `uid=${uid}`,
    uidOpt ? 'forceuid' : 'noforceuid',
    `gid=${gid}`,
    gidOpt ? 'forcegid' : 'noforcegid',
    `addr=${sess.serverIp}`,
    `file_mode=0${fileMode.toString(8)}`,
    `dir_mode=0${dirMode.toString(8)}`,
    'soft',
    'nounix',
    'serverino',
    'mapposix',
    'rsize=4194304',
    'wsize=4194304',
    'bsize=1048576',
    'retrans=1',
    'echo_interval=60',
    'actimeo=1',
    'closetimeo=1',
  ].join(',')
  const [blocks, avail] = sizeOfServer(tree)
  const pid = nextPid++
  const st = smbState(sess.server)
  st.sessions.push({ pid, user: sess.user, group: tree.sess.server.groupName(tree.cred.gid), ip: sess.clientIp, port: 50412 + st.sessions.length, share: tree.share.name, since: Date.now() })
  sys.storage.mounts.push({
    source: `//${host}/${shareName}`,
    target: abs,
    fstype: 'cifs',
    options: final,
    remote: { size: () => blocks * 1024, used: () => (blocks - avail) * 1024 },
    onUnmount: () => {
      st.sessions = st.sessions.filter((x) => x.pid !== pid)
    },
  })
  sys.vfs.addRemote({
    target: abs,
    vfs: sess.server.vfs,
    path: tree.path,
    cred: () => tree.cred,
    readonly: ro,
    // Todo se ve con el dueño y los permisos de las opciones: el núcleo del cliente revisa eso primero.
    check: (local, write, rpath) => {
      if (write && local.uid !== 0) {
        const bits = local.uid === uid ? (dirMode >> 6) & 7 : local.gid === gid || local.groups.includes(gid) ? (dirMode >> 3) & 7 : dirMode & 7
        if (!(bits & 2)) return 'EACCES'
      }
      return treeCheck(tree, rpath, write)
    },
    view: (n) => ({ ...n, uid, gid, mode: (n.mode & ~0o7777) | (n.type === 'dir' ? dirMode : fileMode), acl: undefined }),
    createMode: createModeOf(tree),
  })
  return undefined
}

NETWORK_MOUNTS.push(cifsMount)
