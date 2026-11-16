/**
 * Correo saliente con Postfix: main.cf (postconf), mapas (postmap), alias (newaliases), la cola
 * (mailq, postqueue, postsuper), el envío (sendmail, mail) y la entrega local o a través de un
 * relay con TLS y autenticación SASL. Cada intento queda en el log como lo escribe Postfix.
 */
import { SERVICE_CHECKS, strftime } from './commands/sysinfo'
import { reach } from './http'
import { register, type CommandContext, type Foreground, type IO } from './shell'
import { System } from './system'
import { ROOT_CRED } from './vfs'

// ---------------------------------------------------------------------------------------
// main.cf y postconf
// ---------------------------------------------------------------------------------------

const MAIN_CF = '/etc/postfix/main.cf'

export function postfixVersion(sys: System) {
  return sys.distro === 'rocky' ? '3.8.5' : '3.10.6'
}

function fqdnOf(sys: System) {
  return sys.hostname.includes('.') ? sys.hostname : `${sys.hostname}.localdomain`
}

/** Valores de fábrica (postconf -d) de los parámetros que usa el simulador. */
function defaults(sys: System): Record<string, string> {
  const rocky = sys.distro === 'rocky'
  const host = fqdnOf(sys)
  const db = rocky ? 'lmdb' : 'hash'
  return {
    myhostname: host,
    mydomain: host.split('.').slice(1).join('.') || 'localdomain',
    myorigin: '$myhostname',
    mydestination: '$myhostname, localhost.$mydomain, localhost',
    mynetworks: '127.0.0.0/8 [::ffff:127.0.0.0]/104 [::1]/128',
    mynetworks_style: 'host',
    inet_interfaces: 'all',
    inet_protocols: 'all',
    relayhost: '',
    relay_domains: '',
    default_database_type: db,
    alias_maps: `${db}:/etc/aliases, nis:mail.aliases`,
    alias_database: `${db}:/etc/aliases`,
    smtp_tls_security_level: '',
    smtp_tls_wrappermode: 'no',
    smtp_tls_CAfile: '',
    smtp_tls_CApath: '',
    smtp_sasl_auth_enable: 'no',
    smtp_sasl_password_maps: '',
    smtp_sasl_security_options: 'noplaintext, noanonymous',
    smtp_sasl_tls_security_options: '$smtp_sasl_security_options',
    smtp_sasl_mechanism_filter: '',
    smtp_generic_maps: '',
    sender_canonical_maps: '',
    canonical_maps: '',
    smtpd_tls_security_level: '',
    smtpd_tls_cert_file: '',
    smtpd_tls_key_file: '',
    smtpd_banner: '$myhostname ESMTP $mail_name',
    smtpd_relay_restrictions: 'permit_mynetworks, permit_sasl_authenticated, defer_unauth_destination',
    message_size_limit: '10240000',
    mailbox_size_limit: '51200000',
    recipient_delimiter: '',
    compatibility_level: '0',
    mail_name: 'Postfix',
    mail_version: postfixVersion(sys),
    queue_directory: '/var/spool/postfix',
    command_directory: '/usr/sbin',
    daemon_directory: rocky ? '/usr/libexec/postfix' : '/usr/lib/postfix/sbin',
    data_directory: '/var/lib/postfix',
    mail_owner: 'postfix',
    setgid_group: 'postdrop',
    unknown_local_recipient_reject_code: '550',
    maximal_queue_lifetime: '5d',
    bounce_queue_lifetime: '5d',
    delay_warning_time: '0h',
    biff: 'yes',
    append_dot_mydomain: 'no',
    readme_directory: 'no',
    html_directory: 'no',
    debug_peer_level: '2',
    maillog_file: '',
    smtp_tls_session_cache_database: '',
    smtpd_sasl_auth_enable: 'no',
    sendmail_path: rocky ? '/usr/sbin/sendmail.postfix' : '/usr/sbin/sendmail',
    newaliases_path: rocky ? '/usr/bin/newaliases.postfix' : '/usr/bin/newaliases',
    mailq_path: rocky ? '/usr/bin/mailq.postfix' : '/usr/bin/mailq',
    manpage_directory: '/usr/share/man',
    meta_directory: '/etc/postfix',
    shlib_directory: rocky ? '/usr/lib64/postfix' : '/usr/lib/postfix',
    sample_directory: '/etc/postfix',
    debugger_command: 'PATH=/bin:/usr/bin:/usr/local/bin:/usr/X11R6/bin ddd $daemon_directory/$process_name $process_id & sleep 5',
    mailbox_command: '',
    home_mailbox: '',
    smtp_sasl_auth_soft_bounce: 'yes',
  }
}

/** Lee main.cf: clave = valor, con las líneas que siguen indentadas. Devuelve también los avisos. */
export function readMainCf(sys: System): { values: Map<string, string>; warnings: string[] } {
  const values = new Map<string, string>()
  const warnings: string[] = []
  if (!sys.vfs.exists(MAIN_CF)) return { values, warnings }
  const lines = sys.vfs.readFile(MAIN_CF, ROOT_CRED).split('\n')
  let last: string | undefined
  lines.forEach((raw, i) => {
    if (/^\s*#/.test(raw) || !raw.trim()) return
    if (/^\s/.test(raw) && last) {
      values.set(last, `${values.get(last)} ${raw.trim()}`)
      return
    }
    const m = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(raw.trim())
    if (!m) {
      warnings.push(`/usr/sbin/postconf: fatal: ${MAIN_CF}, line ${i + 1}: missing '=' after attribute name: "${raw.trim().split(/\s+/)[0]}"`)
      return
    }
    if (values.has(m[1])) warnings.push(`/usr/sbin/postconf: warning: ${MAIN_CF}, line ${i + 1}: overriding earlier entry: ${m[1]}=${values.get(m[1])}`)
    values.set(m[1], m[2].trim())
    last = m[1]
  })
  for (const k of values.keys()) if (!(k in defaults(sys)) && !KNOWN_EXTRA.has(k)) warnings.push(`/usr/sbin/postconf: warning: ${MAIN_CF}: unused parameter: ${k}=${values.get(k)}`)
  return { values, warnings }
}

const KNOWN_EXTRA = new Set(['smtpd_tls_session_cache_database', 'smtp_tls_loglevel', 'smtpd_tls_loglevel', 'smtp_tls_note_starttls_offer', 'tls_random_source', 'smtpd_recipient_restrictions', 'disable_vrfy_command', 'smtpd_helo_required', 'header_checks', 'transport_maps', 'virtual_alias_maps', 'virtual_alias_domains', 'smtp_tls_mandatory_protocols', 'smtp_tls_protocols', 'smtp_tls_mandatory_ciphers'])

/** Valor efectivo de un parámetro, con las $variables expandidas. */
export function param(sys: System, name: string, raw = false): string {
  const d = defaults(sys)
  const vals = readMainCf(sys).values
  const get = (k: string): string => vals.get(k) ?? d[k] ?? ''
  let v = get(name)
  if (raw) return v
  for (let i = 0; i < 5 && /\$\{?\w+\}?/.test(v); i++) v = v.replace(/\$\{?(\w+)\}?/g, (_, k) => get(k))
  // myorigin = /etc/mailname (Debian): el nombre sale de ese archivo.
  if (name === 'myorigin' && v.startsWith('/')) v = sys.vfs.exists(v) ? sys.vfs.readFile(v, ROOT_CRED).split('\n')[0].trim() : fqdnOf(sys)
  return v
}

function writeParam(sys: System, key: string, value: string) {
  const text = sys.vfs.exists(MAIN_CF) ? sys.vfs.readFile(MAIN_CF, ROOT_CRED) : ''
  const lines = text.split('\n')
  const idx = lines.findIndex((l) => new RegExp(`^${key}\\s*=`).test(l))
  if (idx >= 0) {
    let end = idx + 1
    while (end < lines.length && /^\s+\S/.test(lines[end])) end++
    lines.splice(idx, end - idx, `${key} = ${value}`)
  } else {
    if (lines.length && lines[lines.length - 1] === '') lines.pop()
    lines.push(`${key} = ${value}`, '')
  }
  sys.vfs.writeFile(MAIN_CF, lines.join('\n'), ROOT_CRED)
}

register('postconf', {
  usage: "postconf [-n] [-d] [-h] [parámetro...] | postconf -e 'parámetro = valor'",
  summary: '  -n  solo lo que cambió en main.cf\n  -d  valores de fábrica\n  -h  solo el valor\n  -e  cambia main.cf (también: postconf parámetro=valor)',
  path: '/usr/sbin',
  run(ctx) {
    const sys = ctx.sys
    const flags = new Set(ctx.args.filter((a) => /^-[ndhe]+$/.test(a)).flatMap((a) => [...a.slice(1)]))
    const rest = ctx.args.filter((a) => !/^-[ndhe]+$/.test(a))
    const edits = rest.filter((a) => a.includes('='))
    if (flags.has('e') || edits.length) {
      if (ctx.sh.user !== 'root') {
        ctx.err(`postconf: fatal: open ${MAIN_CF} for writing: Permission denied\n`)
        return 1
      }
      for (const e of edits) {
        const i = e.indexOf('=')
        writeParam(sys, e.slice(0, i).trim(), e.slice(i + 1).trim())
      }
      return 0
    }
    const d = defaults(sys)
    const { values, warnings } = readMainCf(sys)
    for (const w of warnings) ctx.err(w + '\n')
    const show = (k: string, v: string) => ctx.out(flags.has('h') ? `${v}\n` : `${k} = ${v}\n`)
    if (!rest.length) {
      if (flags.has('n')) for (const [k, v] of [...values].sort(([a], [b]) => a.localeCompare(b))) show(k, v)
      else for (const k of Object.keys(d).sort()) show(k, flags.has('d') ? d[k] : (values.get(k) ?? d[k]))
      return 0
    }
    let code = 0
    for (const k of rest) {
      if (!(k in d) && !values.has(k) && !KNOWN_EXTRA.has(k)) {
        ctx.err(`postconf: warning: ${k}: unknown parameter\n`)
        code = 1
        continue
      }
      show(k, flags.has('d') ? (d[k] ?? '') : (values.get(k) ?? d[k] ?? ''))
    }
    return code
  },
})

// ---------------------------------------------------------------------------------------
// Mapas: postmap, postalias, newaliases
// ---------------------------------------------------------------------------------------

interface MapSnap {
  /** Contenido del archivo fuente cuando se compiló. */
  source: string
  entries: Map<string, string>
  time: number
}

interface MailState {
  maps: Map<string, MapSnap>
  queue: Msg[]
  log: { id: string; to: string; status: 'sent' | 'deferred' | 'bounced'; relay: string; time: number }[]
  pids: Record<string, number>
}

interface Msg {
  id: string
  from: string
  to: string[]
  subject: string
  body: string
  headers: string
  size: number
  arrival: number
  reason?: string
  uid: number
}

const STATE = new WeakMap<System, MailState>()

function mailState(sys: System): MailState {
  let s = STATE.get(sys)
  if (!s) {
    s = { maps: new Map(), queue: [], log: [], pids: {} }
    STATE.set(sys, s)
  }
  return s
}

const DB_EXT: Record<string, string> = { lmdb: '.lmdb', hash: '.db', btree: '.db', cdb: '.cdb' }

function parseMapSpec(sys: System, spec: string): { type: string; path: string } {
  const m = /^(\w+):(.+)$/.exec(spec.trim())
  return m ? { type: m[1], path: m[2] } : { type: param(sys, 'default_database_type'), path: spec.trim() }
}

function supported(sys: System, type: string): boolean {
  if (sys.distro === 'rocky') return ['lmdb', 'cdb', 'regexp', 'pcre', 'texthash', 'inline', 'static', 'unix', 'nis', 'proxy'].includes(type)
  return ['hash', 'btree', 'lmdb', 'cdb', 'regexp', 'pcre', 'texthash', 'inline', 'static', 'unix', 'nis', 'proxy'].includes(type)
}

function parseMapText(text: string, alias: boolean): Map<string, string> {
  const out = new Map<string, string>()
  for (const raw of text.split('\n')) {
    const l = raw.replace(/#.*$/, '').trim()
    if (!l) continue
    const m = alias ? /^([^:\s]+)\s*:\s*(.+)$/.exec(l) : /^(\S+)\s+(.+)$/.exec(l)
    if (m) out.set(m[1].toLowerCase(), m[2].trim())
  }
  return out
}

function compileMap(sys: System, spec: string, alias: boolean): string | undefined {
  const { type, path } = parseMapSpec(sys, spec)
  if (!supported(sys, type)) return `${alias ? 'postalias' : 'postmap'}: fatal: unsupported dictionary type: ${type}. Is the postfix-${type} package installed?`
  if (!sys.vfs.exists(path)) return `${alias ? 'postalias' : 'postmap'}: fatal: open ${path}: No such file or directory`
  const source = sys.vfs.readFile(path, ROOT_CRED)
  mailState(sys).maps.set(path, { source, entries: parseMapText(source, alias), time: Date.now() })
  const node = sys.vfs.stat(path, ROOT_CRED)
  sys.vfs.writeFile(`${path}${DB_EXT[type] ?? '.db'}`, `\u0000${type.toUpperCase()} map compiled from ${path}\u0000`, ROOT_CRED, { mode: node.mode & 0o777 })
  const db = sys.vfs.stat(`${path}${DB_EXT[type] ?? '.db'}`, ROOT_CRED)
  db.uid = node.uid
  db.gid = node.gid
  db.mode = node.mode & 0o777
  return undefined
}

/** Busca en un mapa compilado, como lo hace Postfix (y avisa si está desactualizado). */
function lookup(sys: System, spec: string, key: string, proc: string, id?: string): { value?: string; error?: string } {
  if (!spec) return {}
  const { type, path } = parseMapSpec(sys, spec)
  if (type === 'inline') {
    const m = /^\{(.*)\}$/.exec(path.trim())
    for (const pair of (m?.[1] ?? '').split(',')) {
      const [k, v] = pair.split('=').map((x) => x.trim())
      if (k?.toLowerCase() === key.toLowerCase()) return { value: v }
    }
    return {}
  }
  if (!supported(sys, type)) {
    mailLog(sys, proc, `${id ? id + ': ' : ''}warning: ${type}:${path} is unavailable. unsupported dictionary type: ${type}`, 4)
    return { error: `lookup error for "${key}"` }
  }
  const snap = mailState(sys).maps.get(path)
  const dbFile = `${path}${DB_EXT[type] ?? '.db'}`
  if (!snap || !sys.vfs.exists(dbFile)) {
    mailLog(sys, proc, `warning: ${type}:${path} is unavailable. open database ${dbFile}: No such file or directory`, 4)
    return { error: `lookup error for "${key}"` }
  }
  const now = sys.vfs.exists(path) ? sys.vfs.readFile(path, ROOT_CRED) : snap.source
  if (now !== snap.source) mailLog(sys, proc, `warning: database ${dbFile} is older than source file ${path}`, 4)
  return { value: snap.entries.get(key.toLowerCase()) }
}

register('postmap', {
  usage: 'postmap [tipo:]archivo | postmap -q clave [tipo:]archivo',
  path: '/usr/sbin',
  run(ctx) {
    const sys = ctx.sys
    const qi = ctx.args.indexOf('-q')
    if (qi >= 0) {
      const key = ctx.args[qi + 1]
      const spec = ctx.args.find((a, i) => i !== qi && i !== qi + 1 && !a.startsWith('-'))
      if (!key || !spec) {
        ctx.err('usage: postmap [-Nfinoprsuvw] [-c config_dir] [-d key] [-q key] [map_type:]file...\n')
        return 1
      }
      const { type, path } = parseMapSpec(sys, spec)
      const snap = mailState(sys).maps.get(path)
      if (!snap || !sys.vfs.exists(`${path}${DB_EXT[type] ?? '.db'}`)) {
        ctx.err(`postmap: fatal: open database ${path}${DB_EXT[type] ?? '.db'}: No such file or directory\n`)
        return 1
      }
      const v = snap.entries.get(key.toLowerCase())
      if (v === undefined) return 1
      ctx.out(v + '\n')
      return 0
    }
    const files = ctx.args.filter((a) => !a.startsWith('-'))
    if (!files.length) {
      ctx.err('usage: postmap [-Nfinoprsuvw] [-c config_dir] [-d key] [-q key] [map_type:]file...\n')
      return 1
    }
    if (ctx.sh.user !== 'root') {
      ctx.err(`postmap: fatal: open database ${parseMapSpec(sys, files[0]).path}${DB_EXT[parseMapSpec(sys, files[0]).type] ?? '.db'}: Permission denied\n`)
      return 1
    }
    for (const f of files) {
      const err = compileMap(sys, f, false)
      if (err) {
        ctx.err(err + '\n')
        return 1
      }
    }
    return 0
  },
})

function aliasCmd(ctx: CommandContext, files: string[]): number {
  const sys = ctx.sys
  if (ctx.sh.user !== 'root') {
    ctx.err(`${ctx.name}: fatal: open database /etc/aliases${DB_EXT[param(sys, 'default_database_type')]}: Permission denied\n`)
    return 1
  }
  const specs = files.length ? files : param(sys, 'alias_database').split(/[\s,]+/).filter(Boolean)
  for (const s of specs) {
    const err = compileMap(sys, s, true)
    if (err) {
      ctx.err(err.replace(/^postalias/, ctx.name === 'newaliases' ? 'newaliases' : 'postalias') + '\n')
      return 1
    }
  }
  return 0
}

register('newaliases', { usage: 'newaliases', path: '/usr/bin', run: (ctx) => aliasCmd(ctx, []) })
register('postalias', { usage: 'postalias [tipo:]archivo', path: '/usr/sbin', run: (ctx) => aliasCmd(ctx, ctx.args.filter((a) => !a.startsWith('-'))) })

// ---------------------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------------------

function procPid(sys: System, proc: string): number {
  const s = mailState(sys)
  s.pids[proc] ??= sys.allocPid()
  return s.pids[proc]
}

export function mailLog(sys: System, proc: string, message: string, priority = 6) {
  const pid = procPid(sys, proc)
  sys.journal.push({ time: Date.now(), unit: 'postfix.service', priority, message, ident: `postfix/${proc}`, pid })
  const file = sys.distro === 'rocky' ? '/var/log/maillog' : '/var/log/mail.log'
  if (sys.distro === 'ubuntu' && !sys.installed.has('rsyslog')) return
  try {
    sys.vfs.writeFile(file, `${strftime('%b %e %T', new Date())} ${sys.hostname} postfix/${proc}[${pid}]: ${message}\n`, ROOT_CRED, { append: true, mode: 0o600 })
  } catch {
    // sin archivo de registro
  }
}

// ---------------------------------------------------------------------------------------
// Relays (los servidores de correo del proveedor) y entrega
// ---------------------------------------------------------------------------------------

export interface Relay {
  servidor: string
  ip: string
  puerto: number
  usuario?: string
  clave?: string
  tls: boolean
  remitentes: string[]
}

const RELAYS = new WeakMap<System, { relays: Relay[]; port25Blocked: boolean }>()

function relayConf(sys: System) {
  return RELAYS.get(sys) ?? { relays: [], port25Blocked: true }
}

function running(sys: System) {
  return !!sys.services.get('postfix')?.active
}

function newId(): string {
  return Array.from({ length: 10 }, () => '0123456789ABCDEF'[Math.floor(Math.random() * 16)]).join('') + 'B'
}

function localPart(addr: string) {
  return addr.replace(/@.*$/, '').toLowerCase()
}

function domainOf(addr: string) {
  return addr.includes('@') ? addr.split('@')[1].toLowerCase() : ''
}

function qualify(sys: System, addr: string): string {
  return addr.includes('@') ? addr : `${addr}@${param(sys, 'myorigin')}`
}

function isLocal(sys: System, addr: string): boolean {
  const d = domainOf(addr)
  if (!d) return true
  return param(sys, 'mydestination').split(/[\s,]+/).filter(Boolean).map((x) => x.toLowerCase()).includes(d)
}

function mboxPath(sys: System, user: string) {
  return sys.distro === 'rocky' ? `/var/spool/mail/${user}` : `/var/mail/${user}`
}

function dateHeader(t: number) {
  return new Date(t).toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, '$1, $2 $3 $4 $5 +0000 (UTC)')
}

/** Entrega local (alias incluidos). Devuelve el error si no se pudo. */
function deliverLocal(sys: System, msg: Msg, rcpt: string, depth = 0): { status: 'sent' | 'bounced' | 'deferred'; text: string; user?: string } {
  const user = localPart(rcpt)
  if (depth < 5) {
    for (const spec of param(sys, 'alias_maps').split(/[\s,]+/).filter((x) => x && !x.startsWith('nis:'))) {
      const r = lookup(sys, spec, user, 'local', msg.id)
      if (r.error) return { status: 'deferred', text: `alias database unavailable` }
      if (r.value) {
        const targets = r.value.split(',').map((x) => x.trim()).filter(Boolean)
        let last: { status: 'sent' | 'bounced' | 'deferred'; text: string; user?: string } = { status: 'sent', text: '' }
        for (const t of targets) {
          if (isLocal(sys, t)) last = deliverLocal(sys, msg, t, depth + 1)
          else {
            // El reenvío es un mensaje nuevo, con su propio identificador de cola.
            const copy = { ...msg, id: newId(), to: [] as string[] }
            queueRemote(sys, copy, t)
            last = { status: 'sent', text: `forwarded as ${copy.id}` }
          }
        }
        return last
      }
    }
  }
  const u = sys.users.get(user)
  if (!u) return { status: 'bounced', text: `unknown user: "${user}"` }
  const path = mboxPath(sys, user)
  const host = param(sys, 'myhostname')
  const mbox = `From ${msg.from}  ${new Date(msg.arrival).toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, '$1 $3 $2 $5 $4')}\nReturn-Path: <${msg.from}>\nX-Original-To: ${rcpt}\nDelivered-To: ${user}@${host}\nReceived: by ${host} (Postfix, from userid ${msg.uid})\n\tid ${msg.id}; ${dateHeader(msg.arrival)}\n${msg.headers}\n${msg.body.replace(/\n?$/, '\n')}\n`
  sys.vfs.mkdirp(path.replace(/\/[^/]+$/, ''), ROOT_CRED)
  const existed = sys.vfs.exists(path)
  sys.vfs.writeFile(path, mbox, ROOT_CRED, { append: true, mode: 0o600 })
  if (!existed) {
    const mailGid = [...sys.groups.values()].find((g) => g.name === 'mail')?.gid ?? 12
    sys.vfs.chown(path, u.uid, mailGid, ROOT_CRED)
    sys.vfs.chmod(path, sys.distro === 'rocky' ? 0o600 : 0o660, ROOT_CRED)
  }
  return { status: 'sent', text: 'delivered to mailbox', user }
}

const pendingRemote: { sys: System; msg: Msg; rcpt: string }[] = []
function queueRemote(sys: System, msg: Msg, rcpt: string) {
  pendingRemote.push({ sys, msg, rcpt })
}

/** Reescribe el remitente para afuera (smtp_generic_maps), como hace el cliente smtp. */
function generic(sys: System, addr: string, id: string): string {
  const spec = param(sys, 'smtp_generic_maps')
  if (!spec) return addr
  for (const key of [addr.toLowerCase(), localPart(addr), `@${domainOf(addr)}`]) {
    const r = lookup(sys, spec, key, 'smtp', id)
    if (r.value) return r.value.includes('@') ? r.value : `${r.value}@${domainOf(addr)}`
  }
  return addr
}

type Attempt = { status: 'sent' | 'deferred' | 'bounced'; relay: string; text: string }

function deliverRemote(sys: System, msg: Msg, rcpt: string): Attempt {
  const rh = param(sys, 'relayhost').trim()
  const cfg = relayConf(sys)
  if (!rh) {
    // Entrega directa: el MX del destinatario, por el puerto 25.
    const domain = domainOf(rcpt)
    const mx = sys.dnsRecords[`MX ${domain}`]?.split(/\s*;\s*/)[0]?.split(/\s+/).pop()
    if (!mx) return { status: 'deferred', relay: 'none', text: `Host or domain name not found. Name service error for name=${domain} type=MX: Host not found, try again` }
    const ip = sys.dnsRecords[mx.replace(/\.$/, '')] ?? '142.250.0.27'
    if (cfg.port25Blocked || !sys.internet) return { status: 'deferred', relay: 'none', text: `connect to ${mx.replace(/\.$/, '')}[${ip}]:25: Connection timed out` }
    return { status: 'sent', relay: `${mx.replace(/\.$/, '')}[${ip}]:25`, text: `250 2.0.0 OK  ${Math.floor(Date.now() / 1000)} - gsmtp` }
  }
  const m = /^\[?([^\]:]+)\]?(?::(\d+))?$/.exec(rh)
  const host = m?.[1] ?? rh
  const port = Number(m?.[2] ?? 25)
  const relay = cfg.relays.find((r) => r.servidor === host)
  if (!relay) return { status: 'deferred', relay: 'none', text: `Host or domain name not found. Name service error for name=${host} type=${rh.startsWith('[') ? 'A' : 'MX'}: Host not found` }
  const where = `${host}[${relay.ip}]:${port}`
  const r = reach(sys, relay.ip, port)
  if (('error' in r && r.error !== 'outside') || !sys.internet || port !== relay.puerto) return { status: 'deferred', relay: 'none', text: `connect to ${host}[${relay.ip}]:${port}: Connection timed out` }
  const tlsLevel = param(sys, 'smtp_tls_security_level') || 'none'
  const wrapper = param(sys, 'smtp_tls_wrappermode') === 'yes'
  if (port === 465 && !wrapper) return { status: 'deferred', relay: where, text: `lost connection with ${host}[${relay.ip}] while receiving the initial server greeting` }
  const tls = wrapper || ['may', 'encrypt', 'verify', 'secure', 'dane'].includes(tlsLevel)
  if (relay.tls && !tls) return { status: 'bounced', relay: where, text: `host ${host}[${relay.ip}] said: 530 5.7.0 Must issue a STARTTLS command first (in reply to MAIL FROM command)` }
  if (tls) mailLog(sys, 'smtp', `Trusted TLS connection established to ${where}: TLSv1.3 with cipher TLS_AES_256_GCM_SHA384 (256/256 bits) key-exchange X25519 server-signature RSA-PSS (2048 bits) server-digest SHA256`)
  let authed = false
  if (relay.usuario) {
    if (param(sys, 'smtp_sasl_auth_enable') !== 'yes') return { status: 'bounced', relay: where, text: `host ${host}[${relay.ip}] said: 530 5.7.0 Authentication Required (in reply to MAIL FROM command)` }
    let cred: string | undefined
    const spec = param(sys, 'smtp_sasl_password_maps')
    for (const key of [rh, host, `[${host}]:${port}`, `[${host}]`]) {
      const l = lookup(sys, spec, key, 'smtp', msg.id)
      if (l.error) return { status: 'deferred', relay: where, text: `delivery temporarily suspended: ${l.error.replace('"' + key + '"', rh)}` }
      if (l.value) {
        cred = l.value
        break
      }
    }
    if (!cred) return { status: 'bounced', relay: where, text: `host ${host}[${relay.ip}] said: 530 5.7.0 Authentication Required (in reply to MAIL FROM command)` }
    const mechOk = sys.distro === 'ubuntu' || sys.installed.has('cyrus-sasl-plain')
    const opts = (tls ? param(sys, 'smtp_sasl_tls_security_options') : param(sys, 'smtp_sasl_security_options')).split(/[\s,]+/)
    if (!mechOk || opts.includes('noplaintext')) {
      mailLog(sys, 'smtp', 'warning: SASL authentication failure: No worthy mechs found', 4)
      return { status: 'deferred', relay: where, text: `SASL authentication failed; cannot authenticate to server ${host}[${relay.ip}]: no mechanism available` }
    }
    const [u, ...pw] = cred.split(':')
    if (u !== relay.usuario || pw.join(':') !== relay.clave) {
      mailLog(sys, 'smtp', `warning: SASL authentication failure: authentication failed`, 4)
      return { status: 'deferred', relay: where, text: `SASL authentication failed; server ${host}[${relay.ip}] said: 535 5.7.8 Error: authentication failed: authentication failure` }
    }
    authed = true
  }
  const sender = generic(sys, msg.from, msg.id)
  if (relay.remitentes.length && !relay.remitentes.map((x) => x.toLowerCase()).includes(sender.toLowerCase())) {
    return { status: 'bounced', relay: where, text: `host ${host}[${relay.ip}] said: 553 5.7.1 <${sender}>: Sender address rejected: not owned by user ${relay.usuario ?? sender} (in reply to MAIL FROM command)` }
  }
  return { status: 'sent', relay: where, text: `250 2.0.0 Ok: queued as ${newId().slice(0, 9)}${authed ? '' : ''}` }
}

function delaysText() {
  return 'delay=1.2, delays=0.05/0.02/0.61/0.52'
}

/** Procesa la cola: cada destinatario se entrega, queda diferido o rebota. */
function processQueue(sys: System, ids?: string[]) {
  const st = mailState(sys)
  for (const msg of [...st.queue]) {
    if (ids && !ids.includes(msg.id)) continue
    if (!msg.reason) mailLog(sys, 'qmgr', `${msg.id}: from=<${msg.from}>, size=${msg.size}, nrcpt=${msg.to.length} (queue active)`)
    const left: string[] = []
    for (const rcpt of msg.to) {
      let res: Attempt
      if (isLocal(sys, rcpt)) {
        const lr = deliverLocal(sys, msg, rcpt)
        const full = rcpt.includes('@') ? rcpt : `${rcpt}@${param(sys, 'myhostname')}`
        const to = lr.user ? `${lr.user}@${param(sys, 'myhostname')}` : full
        mailLog(sys, 'local', `${msg.id}: to=<${to}>${lr.user && localPart(rcpt) !== lr.user ? `, orig_to=<${localPart(rcpt)}>` : ''}, relay=local, ${delaysText()}, dsn=${lr.status === 'sent' ? '2.0.0' : lr.status === 'bounced' ? '5.1.1' : '4.3.0'}, status=${lr.status} (${lr.text})`)
        res = { status: lr.status, relay: 'local', text: lr.text }
      } else {
        res = deliverRemote(sys, msg, rcpt)
        mailLog(sys, 'smtp', `${msg.id}: to=<${rcpt}>, relay=${res.relay}, ${delaysText()}, dsn=${res.status === 'sent' ? '2.0.0' : res.status === 'bounced' ? '5.7.0' : '4.4.1'}, status=${res.status} (${res.text})`, res.status === 'sent' ? 6 : 4)
      }
      st.log.push({ id: msg.id, to: rcpt, status: res.status, relay: res.relay, time: Date.now() })
      if (res.status === 'deferred') {
        left.push(rcpt)
        msg.reason = res.text
      }
      if (res.status === 'bounced') bounce(sys, msg, rcpt, res.text)
    }
    msg.to = left
    if (!left.length) {
      st.queue = st.queue.filter((x) => x !== msg)
      mailLog(sys, 'qmgr', `${msg.id}: removed`)
    }
  }
  // Lo que los alias mandaron afuera.
  while (pendingRemote.length) {
    const p = pendingRemote.shift()!
    if (p.sys !== sys) continue
    const res = deliverRemote(sys, p.msg, p.rcpt)
    mailLog(sys, 'smtp', `${p.msg.id}: to=<${p.rcpt}>, relay=${res.relay}, ${delaysText()}, dsn=${res.status === 'sent' ? '2.0.0' : '4.4.1'}, status=${res.status} (${res.text})`)
    st.log.push({ id: p.msg.id, to: p.rcpt, status: res.status, relay: res.relay, time: Date.now() })
    if (res.status === 'deferred') {
      const m = st.queue.find((x) => x.id === p.msg.id)
      if (m) m.to.push(p.rcpt)
      else st.queue.push({ ...p.msg, to: [p.rcpt], reason: res.text })
    }
  }
}

/** El aviso de rebote vuelve al remitente si es de este servidor. */
function bounce(sys: System, msg: Msg, rcpt: string, why: string) {
  const id = newId()
  mailLog(sys, 'bounce', `${msg.id}: sender non-delivery notification: ${id}`)
  if (!isLocal(sys, msg.from) || msg.from === 'MAILER-DAEMON' || msg.from === '') return
  const host = param(sys, 'myhostname')
  const nd: Msg = {
    id,
    from: '',
    to: [msg.from],
    subject: 'Undelivered Mail Returned to Sender',
    body: `This is the mail system at host ${host}.\n\nI'm sorry to have to inform you that your message could not\nbe delivered to one or more recipients. It's attached below.\n\n<${rcpt}>: ${why}\n`,
    headers: `From: MAILER-DAEMON@${host} (Mail Delivery System)\nSubject: Undelivered Mail Returned to Sender\nTo: ${msg.from}\nDate: ${dateHeader(Date.now())}\n`,
    size: 2048,
    arrival: Date.now(),
    uid: 0,
  }
  deliverLocal(sys, { ...nd, from: 'MAILER-DAEMON' }, msg.from)
  mailLog(sys, 'local', `${id}: to=<${localPart(msg.from)}@${host}>, relay=local, ${delaysText()}, dsn=2.0.0, status=sent (delivered to mailbox)`)
}

/** Entra un mensaje (sendmail, mail): queda en la cola y, si Postfix funciona, se intenta enseguida. */
export function submit(sys: System, uid: number, from: string, to: string[], subject: string, body: string, extraHeaders = ''): string {
  const id = newId()
  const user = [...sys.users.values()].find((u) => u.uid === uid)?.name ?? 'root'
  const fromAddr = qualify(sys, from || user)
  const now = Date.now()
  const host = param(sys, 'myhostname')
  const stamp = strftime('%Y%m%d%H%M%S', new Date(now))
  const headers = `${extraHeaders}${/^To:/m.test(extraHeaders) ? '' : `To: ${to.join(', ')}\n`}${subject && !/^Subject:/m.test(extraHeaders) ? `Subject: ${subject}\n` : ''}${/^Message-Id:/im.test(extraHeaders) ? '' : `Message-Id: <${stamp}.${id}@${host}>\n`}Date: ${dateHeader(now)}\n${/^From:/m.test(extraHeaders) ? '' : `From: ${user} <${fromAddr}>\n`}`
  const msg: Msg = { id, from: fromAddr, to: to.map((t) => t.trim()).filter(Boolean), subject, body, headers, size: headers.length + body.length + 160, arrival: now, uid }
  mailState(sys).queue.push(msg)
  if (running(sys)) {
    mailLog(sys, 'pickup', `${id}: uid=${uid} from=<${from || user}>`)
    mailLog(sys, 'cleanup', `${id}: message-id=<${stamp}.${id}@${host}>`)
    processQueue(sys, [id])
  }
  return id
}

SERVICE_CHECKS['postfix'] = (ctx) => {
  const sys = ctx.sys
  const { warnings } = readMainCf(sys)
  const fatal = warnings.find((w) => w.includes('fatal'))
  if (fatal) return fatal.replace('/usr/sbin/postconf', 'postfix')
  if (!sys.vfs.exists('/etc/aliases')) sys.vfs.writeFile('/etc/aliases', ALIASES, ROOT_CRED)
  mailState(sys).pids = {}
  mailLog(sys, 'master', `daemon started -- version ${postfixVersion(sys)}, configuration /etc/postfix`)
  // Al arrancar, el gestor de la cola reintenta lo pendiente.
  processQueue(sys)
  return undefined
}

export const ALIASES = `#
#  Aliases in this file will NOT be expanded in the header from
#  Mail, but WILL be visible over networks or from /bin/mail.
#
#\t>>>>>>>>>>\tThe program "newaliases" must be run after
#\t>> NOTE >>\tthis file is updated for any changes to
#\t>>>>>>>>>>\tshow through to sendmail.
#

# Basic system aliases -- these MUST be present.
mailer-daemon:\tpostmaster
postmaster:\troot

# General redirections for pseudo accounts.
bin:\t\troot
daemon:\t\troot
adm:\t\troot
lp:\t\troot
sync:\t\troot
shutdown:\troot
halt:\t\troot
mail:\t\troot
nobody:\t\troot
postfix:\troot

# Well-known aliases.
abuse:\t\troot
noc:\t\troot
security:\troot
hostmaster:\troot
webmaster:\troot
www:\t\twebmaster

# Person who should get root's mail
#root:\t\tmarc
`

// ---------------------------------------------------------------------------------------
// Estado inicial: relays, cola y alias compilados
// ---------------------------------------------------------------------------------------

System.initHooks.push((sys, state) => {
  const c = state.correo
  if (c) RELAYS.set(sys, { relays: c.relays, port25Blocked: c.puerto25_bloqueado })
  if (!sys.installed.has('postfix')) return
  if (!sys.vfs.exists('/etc/aliases')) sys.vfs.writeFile('/etc/aliases', ALIASES, ROOT_CRED)
  // El paquete deja los alias compilados.
  compileMap(sys, param(sys, 'alias_database'), true)
  for (const m of c?.mapas_compilados ?? []) compileMap(sys, m, false)
  for (const q of c?.cola ?? []) {
    const id = newId()
    const t = Date.now() - q.hace_minutos * 60_000
    mailState(sys).queue.push({ id, from: qualify(sys, q.de), to: [q.para], subject: q.asunto, body: '', headers: `Subject: ${q.asunto}\n`, size: 900 + q.asunto.length, arrival: t, reason: q.motivo, uid: 0 })
  }
})

// ---------------------------------------------------------------------------------------
// mailq, postqueue, postsuper, postfix
// ---------------------------------------------------------------------------------------

function queueListing(sys: System): string {
  const q = mailState(sys).queue
  if (!q.length) return 'Mail queue is empty\n'
  let out = '-Queue ID-  --Size-- ----Arrival Time---- -Sender/Recipient-------\n'
  for (const m of q) {
    const when = strftime('%a %b %e %H:%M:%S', new Date(m.arrival))
    out += `${m.id.padEnd(11)} ${String(m.size).padStart(8)} ${when}  ${m.from}\n`
    if (m.reason) out += `${`(${m.reason})`}\n`
    for (const t of m.to) out += `${' '.repeat(41)}${t}\n`
    out += '\n'
  }
  const kb = Math.ceil(q.reduce((a, m) => a + m.size, 0) / 1024)
  return out + `-- ${kb} Kbytes in ${q.length} Request${q.length === 1 ? '' : 's'}.\n`
}

function mailq(ctx: CommandContext): number {
  if (!running(ctx.sys)) {
    ctx.err('postqueue: fatal: Queue report unavailable - mail system is down\n')
    return 69
  }
  ctx.out(queueListing(ctx.sys))
  return 0
}

register('mailq', { usage: 'mailq', path: '/usr/bin', run: mailq })

register('postqueue', {
  usage: 'postqueue -p | -f | -i ID',
  summary: '  -p  muestra la cola (igual que mailq)\n  -f  reintenta ya todo lo diferido\n  -i  reintenta un mensaje',
  path: '/usr/sbin',
  run(ctx) {
    const sys = ctx.sys
    if (ctx.args.includes('-p')) return mailq(ctx)
    if (ctx.args.includes('-f') || ctx.args.includes('-i')) {
      if (!running(sys)) {
        ctx.err('postqueue: fatal: Cannot flush mail queue - mail system is down\n')
        return 69
      }
      const id = ctx.args.includes('-i') ? ctx.args[ctx.args.indexOf('-i') + 1] : undefined
      processQueue(sys, id ? [id] : undefined)
      return 0
    }
    ctx.err('postqueue: fatal: usage: postqueue -f | postqueue -i queueid | postqueue -j | postqueue -p | postqueue -s site\n')
    return 64
  },
})

register('postsuper', {
  usage: 'postsuper -d ID|ALL [deferred]',
  path: '/usr/sbin',
  run(ctx) {
    const sys = ctx.sys
    if (ctx.sh.user !== 'root') {
      ctx.err('postsuper: fatal: use of this command is reserved for the superuser\n')
      return 1
    }
    const di = ctx.args.indexOf('-d')
    if (di < 0) {
      ctx.err('postsuper: fatal: usage: postsuper [-c config_dir] [-d queue_id (delete)] [-h queue_id (hold)] [-H queue_id (un-hold)] [-p (purge temporary files)] [-r queue_id (requeue)] [-s (structure fix)] [-S (structure fix and sanity check)] [-v (verbose)] [queue...]\n')
      return 1
    }
    const what = ctx.args[di + 1]
    const st = mailState(sys)
    const before = st.queue.length
    if (what === 'ALL') st.queue = ctx.args[di + 2] === 'deferred' ? st.queue.filter((m) => !m.reason) : []
    else st.queue = st.queue.filter((m) => m.id !== what)
    const n = before - st.queue.length
    if (n) ctx.err(`postsuper: Deleted: ${n} message${n === 1 ? '' : 's'}\n`)
    if (n && what !== 'ALL') mailLog(sys, 'postsuper', `${what}: removed`)
    return 0
  },
})

register('postfix', {
  usage: 'postfix check | status | start | stop | reload | flush',
  path: '/usr/sbin',
  run(ctx) {
    const sys = ctx.sys
    const verb = ctx.args[0]
    if (ctx.sh.user !== 'root') {
      ctx.err('postfix: fatal: to submit mail, use the Postfix sendmail command\npostfix: fatal: the postfix command is reserved for the superuser\n')
      return 1
    }
    if (verb === 'check') {
      const w = readMainCf(sys).warnings.map((x) => x.replace('/usr/sbin/postconf', 'postfix/postfix-script'))
      for (const x of w) ctx.err(x + '\n')
      return w.some((x) => x.includes('fatal')) ? 1 : 0
    }
    if (verb === 'status') {
      if (running(sys)) ctx.err(`postfix/postfix-script: the Postfix mail system is running: PID: ${sys.services.get('postfix')!.pid ?? 1123}\n`)
      else ctx.err('postfix/postfix-script: the Postfix mail system is not running\n')
      return running(sys) ? 0 : 1
    }
    if (verb === 'flush') {
      processQueue(sys)
      return 0
    }
    if (verb === 'reload') {
      if (!running(sys)) {
        ctx.err('postfix/postfix-script: fatal: the Postfix mail system is not running\n')
        return 1
      }
      ctx.err('postfix/postfix-script: refreshing the Postfix mail system\n')
      mailLog(sys, 'master', 'reload -- version ' + postfixVersion(sys) + ', configuration /etc/postfix')
      return 0
    }
    ctx.err(`[simulador] Usá systemctl ${verb ?? 'status'} postfix: así systemd sabe en qué estado está el servicio.\n`)
    return 1
  },
})

// ---------------------------------------------------------------------------------------
// sendmail y mail
// ---------------------------------------------------------------------------------------

function parseMessage(text: string): { headers: string; body: string; subject: string; to: string[] } {
  const i = text.search(/\n\s*\n/)
  const head = i >= 0 && /^[\w-]+:/.test(text) ? text.slice(0, i) : ''
  const body = head ? text.slice(i).replace(/^\n\s*\n/, '') : text
  const subject = /^Subject:\s*(.*)$/im.exec(head)?.[1] ?? ''
  const to = (/^To:\s*(.*)$/im.exec(head)?.[1] ?? '').split(',').map((x) => x.replace(/.*<([^>]+)>.*/, '$1').trim()).filter(Boolean)
  return { headers: head ? head + '\n' : '', body, subject, to }
}

register(['sendmail', 'sendmail.postfix'], {
  usage: 'sendmail [-f remitente] [-t] destinatario...  (el mensaje por la entrada estándar)',
  path: '/usr/sbin',
  run(ctx) {
    const sys = ctx.sys
    let from = ''
    let fromHeaders = false
    const rcpts: string[] = []
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i]
      if (a === '-f' || a === '-r') from = ctx.args[++i] ?? ''
      else if (a.startsWith('-f') && a.length > 2) from = a.slice(2)
      else if (a === '-t') fromHeaders = true
      else if (a === '-bp') return mailq(ctx)
      else if (a.startsWith('-')) continue
      else rcpts.push(a)
    }
    const text = ctx.stdin.readAll()
    const m = parseMessage(text.replace(/\n\.\n?$/, '\n'))
    const to = fromHeaders ? [...m.to, ...rcpts] : rcpts
    if (!to.length) {
      ctx.err('sendmail: fatal: No recipient addresses found in message header\n')
      return 75
    }
    submit(sys, ctx.sh.cred.uid, from, to, m.subject, m.body, m.headers)
    return 0
  },
})

class BodyInput implements Foreground {
  lines: string[] = []
  constructor(private done: (body: string, io: IO) => void) {}
  prompt() {
    return ''
  }
  async line(text: string, io: IO): Promise<'exit' | void> {
    if (text === '.') {
      this.done(this.lines.join('\n') + '\n', io)
      return 'exit'
    }
    this.lines.push(text)
  }
}

register(['mail', 'mailx', 's-nail'], {
  usage: 'mail -s "asunto" [-r remitente] destinatario...   (el cuerpo por la entrada estándar)',
  summary: '  -s  asunto\n  -r  remitente\n  sin destinatario: muestra los mensajes del buzón',
  path: '/usr/bin',
  run(ctx) {
    const sys = ctx.sys
    let subject = ''
    let from = ''
    const rcpts: string[] = []
    let headersOnly = false
    for (let i = 0; i < ctx.args.length; i++) {
      const a = ctx.args[i]
      if (a === '-s') subject = ctx.args[++i] ?? ''
      else if (a === '-r') from = ctx.args[++i] ?? ''
      else if (a === '-a' && sys.distro === 'ubuntu') {
        const h = ctx.args[++i] ?? ''
        if (/^From:/i.test(h)) from = h.replace(/^From:\s*/i, '').replace(/.*<([^>]+)>.*/, '$1')
      } else if (a === '-H') headersOnly = true
      else if (!a.startsWith('-')) rcpts.push(a)
    }
    const user = ctx.sh.user
    if (!rcpts.length) {
      const path = mboxPath(sys, user)
      const text = sys.vfs.exists(path) ? sys.vfs.readFile(path, ROOT_CRED) : ''
      const msgs = text.split(/^From /m).filter((x) => x.trim())
      if (!msgs.length) {
        ctx.err(sys.distro === 'rocky' ? `s-nail: No mail for ${user} at ${path}\n` : `No mail for ${user}\n`)
        return 1
      }
      if (!headersOnly) ctx.out(`${sys.distro === 'rocky' ? 's-nail version v14.9.24.  Type `?\' for help' : `"${path}": ${msgs.length} message${msgs.length === 1 ? '' : 's'} ${msgs.length} new`}\n${sys.distro === 'rocky' ? `${path}: ${msgs.length} message${msgs.length === 1 ? '' : 's'} ${msgs.length} new\n` : ''}`)
      msgs.forEach((mm, i) => {
        const fromH = /^From:\s*(.*)$/m.exec(mm)?.[1].replace(/.*<([^>]+)>.*/, '$1') ?? mm.split(/\s/)[0]
        const subj = /^Subject:\s*(.*)$/m.exec(mm)?.[1] ?? ''
        const lines = mm.split('\n').length
        ctx.out(`${i === msgs.length - 1 ? '>' : ' '}N  ${String(i + 1).padStart(2)} ${fromH.slice(0, 18).padEnd(18)} ${strftime('%Y-%m-%d %H:%M', new Date())}  ${lines}/${mm.length}   "${subj}"\n`)
      })
      if (!headersOnly) ctx.err('[simulador] Para leer un mensaje completo: cat ' + path + ' (o less).\n')
      return 0
    }
    if (!sys.vfs.exists('/usr/sbin/sendmail') && !sys.installed.has('postfix')) {
      ctx.err(`${sys.distro === 'rocky' ? 's-nail' : 'mail'}: /usr/sbin/sendmail: No such file or directory\n${sys.distro === 'rocky' ? 's-nail: ... message not sent\n' : ''}`)
      return 1
    }
    const send = (body: string) => submit(sys, ctx.sh.cred.uid, from, rcpts, subject, body, from ? `From: ${from}\n` : '')
    const piped = ctx.stdin.readAll()
    if (piped || !ctx.isTTY) {
      send(piped)
      return 0
    }
    ctx.err('[simulador] Escribí el cuerpo del mensaje y terminá con una línea que tenga solo un punto (en un equipo real, también con Ctrl+D).\n')
    ctx.sh.fg = new BodyInput((body) => {
      ctx.sh.fg = undefined
      send(body)
    })
    return 0
  },
})

// ---------------------------------------------------------------------------------------
// Verificaciones
// ---------------------------------------------------------------------------------------

export function verifyMail(sys: System, check: object): { ok: boolean; label: string } | undefined {
  if ('correo_enviado' in check) {
    const c = check as { correo_enviado: string; estado?: string; via?: string }
    const estado = c.estado ?? 'sent'
    const ok = mailState(sys).log.some((l) => l.to.toLowerCase() === c.correo_enviado.toLowerCase() && l.status === estado && (!c.via || l.relay.startsWith(c.via)))
    const word = estado === 'sent' ? 'entregado' : estado === 'deferred' ? 'diferido' : 'rebotado'
    return { ok, label: `correo para ${c.correo_enviado} ${word}${c.via ? ` por ${c.via}` : ''}` }
  }
  if ('cola_vacia' in check) {
    const c = check as { cola_vacia: boolean }
    return { ok: (mailState(sys).queue.length === 0) === c.cola_vacia, label: c.cola_vacia ? 'la cola de correo está vacía' : 'hay mensajes en la cola de correo' }
  }
  return undefined
}

/** Para ss: dónde escucha Postfix (inet_interfaces). */
export function postfixListen(sys: System): string[] {
  const v = param(sys, 'inet_interfaces').toLowerCase()
  if (v === 'all') return ['0.0.0.0']
  return v
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((x) => (x === 'localhost' || x === 'loopback-only' ? '127.0.0.1' : x))
    .filter((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x))
}

/** Al instalar Postfix: el nombre del servidor en la configuración, /etc/mailname y los alias. */
System.installHooks['postfix'] = (sys: System) => {
  const host = fqdnOf(sys)
  if (sys.vfs.exists(MAIN_CF)) {
    const text = sys.vfs.readFile(MAIN_CF, ROOT_CRED)
    if (text.includes('__HOST__')) sys.vfs.writeFile(MAIN_CF, text.replace(/__HOST__/g, host).replace(/__SHORT__/g, sys.hostname.split('.')[0]), ROOT_CRED)
  }
  if (sys.distro === 'ubuntu' && !sys.vfs.exists('/etc/mailname')) sys.vfs.writeFile('/etc/mailname', `${host}\n`, ROOT_CRED)
  if (!sys.vfs.exists('/etc/aliases')) sys.vfs.writeFile('/etc/aliases', ALIASES.replace(/#root:\t\tmarc/, sys.distro === 'ubuntu' ? '' : '#root:\t\tmarc'), ROOT_CRED)
  compileMap(sys, param(sys, 'alias_database'), true)
}
