/**
 * SSH entre los servidores del ejercicio: ssh (con bastión y ~/.ssh/config), ssh-keygen,
 * ssh-copy-id, ssh-agent y ssh-add, scp, rsync y sshd -t.
 */
import { register, type CommandContext, type Shell } from '../shell'
import type { System } from '../system'
import { FsError, ROOT_CRED, type Cred } from '../vfs'
import { SERVICE_CHECKS, strftime } from './sysinfo'
import {
  clientConfig,
  fingerprintOf,
  hostByIp,
  learnNeighbor,
  hostKey,
  hostTag,
  inbound,
  KEY_TYPES,
  knownLine,
  lookupKnown,
  makeKey,
  parsePub,
  randomArt,
  readPrivate,
  readSshdConfig,
  removeKnown,
  routeTo,
  sourceIp,
  sshdPorts,
  sshdService,
  strictModesProblem,
  type KeyType,
} from '../hosts'

// ---------------------------------------------------------------------------------------
// Registro de sshd en el servidor remoto
// ---------------------------------------------------------------------------------------

function sshLog(sys: System, pid: number, message: string, priority = 6) {
  const unit = sys.distro === 'rocky' ? 'sshd.service' : 'ssh.service'
  sys.journal.push({ time: Date.now(), unit, priority, message, ident: 'sshd', pid })
  const file = sys.distro === 'rocky' ? '/var/log/secure' : '/var/log/auth.log'
  try {
    sys.vfs.writeFile(file, `${strftime('%b %e %T', new Date())} ${sys.hostname} sshd[${pid}]: ${message}\n`, ROOT_CRED, { append: true })
  } catch {
    // sin archivo de registro
  }
}

// ---------------------------------------------------------------------------------------
// Agente de claves (ssh-agent / ssh-add): una lista por sesión de terminal
// ---------------------------------------------------------------------------------------

const AGENTS = new WeakMap<Shell, Map<string, Map<string, { comment: string; type: KeyType; file: string }>>>()

function agentOf(sh: Shell): Map<string, { comment: string; type: KeyType; file: string }> | undefined {
  const sock = sh.vars.get('SSH_AUTH_SOCK')
  if (!sock) return undefined
  return AGENTS.get(sh)?.get(sock)
}

// ---------------------------------------------------------------------------------------
// Conexión
// ---------------------------------------------------------------------------------------

interface ConnectOpts {
  alias: string
  user?: string
  port?: number
  identities: string[]
  jump?: string
  strict?: string
  batch?: boolean
  pubkey?: boolean
  passwordAuth?: boolean
  verbose?: boolean
  /** Solo para ssh-copy-id: entrar con contraseña aunque haya claves. */
  passwordOnly?: boolean
}

interface Session {
  host: System
  user: string
  alias: string
  hostname: string
  method: 'publickey' | 'password'
}

const NOTE_KEY = '[simulador] Respondes "yes" porque este es tu servidor. En uno real, compara la huella con la que te dio quien administra el servidor.\n'

/** Conecta y autentica. Escribe en la terminal lo mismo que ssh; devuelve null si no se pudo. */
async function connect(ctx: CommandContext, o: ConnectOpts, via: System = ctx.sys): Promise<Session | null> {
  const client = ctx.sys
  const cred = ctx.sh.cred
  const home = ctx.sh.home
  const conf = clientConfig(client, cred, home, o.alias)
  const hostname = conf.hostname ?? o.alias
  const user = o.user ?? conf.user ?? ctx.sh.user
  const port = o.port ?? conf.port ?? 22
  const jump = o.jump ?? (conf.proxyJump && conf.proxyJump !== 'none' ? conf.proxyJump : undefined)
  const strict = o.strict ?? conf.strictHostKeyChecking ?? 'ask'
  const batch = o.batch ?? conf.batchMode ?? false
  const dbg = (s: string) => o.verbose && ctx.err(`debug1: ${s}\n`)

  // Con bastión: primero se entra al bastión, y desde ahí se sigue.
  if (jump && via === client) {
    const m = /^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/.exec(jump.split(',')[0])
    if (!m) {
      ctx.err(`ssh: Could not resolve hostname ${jump}: Name or service not known\n`)
      return null
    }
    dbg(`Setting implicit ProxyCommand from ProxyJump: ssh -W '[%h]:%p' ${jump}`)
    const bastion = await connect(ctx, { alias: m[2], user: m[1], port: m[3] ? Number(m[3]) : undefined, identities: o.identities, strict: o.strict, batch, verbose: o.verbose }, client)
    if (!bastion) return null
    sshLog(bastion.host, bastion.host.allocPid(), `Accepted ${bastion.method} for ${bastion.user} from ${sourceIp(client, bastion.host.ownIps()[1])} port ${40000 + (Date.now() % 20000)} ssh2`)
    return connect(ctx, { ...o, jump: undefined }, bastion.host)
  }

  const ip = via.resolveHost(hostname)
  if (!ip) {
    if (via !== client) ctx.err(`channel 0: open failed: connect failed: Name or service not known\nstdio forwarding failed\nConnection closed by UNKNOWN port 65535\n`)
    else ctx.err(`ssh: Could not resolve hostname ${hostname}: Name or service not known\n`)
    return null
  }
  dbg(`Connecting to ${hostname} [${ip}] port ${port}.`)
  learnNeighbor(via, ip)
  const host = hostByIp(via, ip)
  const fail = (why: string) => {
    if (via !== client) ctx.err(`channel 0: open failed: connect failed: ${why}\nstdio forwarding failed\nConnection closed by UNKNOWN port 65535\n`)
    else ctx.err(`ssh: connect to host ${hostname} port ${port}: ${why}\n`)
    return null
  }
  if (!host || !routeTo(via, ip)) return fail('Connection timed out')
  const src = sourceIp(via, ip)
  const fw = inbound(host, port, 'tcp', src)
  if (fw === 'reject') return fail('No route to host')
  if (fw === 'drop') return fail('Connection timed out')
  if (!sshdPorts(host).includes(port)) return fail('Connection refused')
  dbg('Connection established.')

  // La clave del servidor y known_hosts.
  const hk = hostKey(host, 'ed25519', host.hostKeyVariant)
  const hkBody = hk.pub.split(' ')[1]
  const tag = hostTag(hostname, port)
  const khPath = `${home}/.ssh/known_hosts`
  let khText = ''
  try {
    khText = client.vfs.readFile(khPath, cred)
  } catch {
    // todavía no existe
  }
  const known = lookupKnown(khText, [tag], hkBody)
  dbg(`Server host key: ssh-ed25519 ${hk.fingerprint}`)
  if (known.status === 'mismatch') {
    ctx.err(
      `@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\nIT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!\nSomeone could be eavesdropping on you right now (man-in-the-middle attack)!\nIt is also possible that a host key has just been changed.\nThe fingerprint for the ED25519 key sent by the remote host is\n${hk.fingerprint}.\nPlease contact your system administrator.\nAdd correct host key in ${khPath} to get rid of this message.\nOffending ED25519 key in ${khPath}:${known.line}\n  remove with:\n  ssh-keygen -f '${khPath}' -R '${tag}'\nHost key for ${tag} has changed and you have requested strict checking.\nHost key verification failed.\n`,
    )
    return null
  }
  if (known.status === 'unknown') {
    const shown = port === 22 ? `${hostname} (${ip})` : `[${hostname}]:${port} ([${ip}]:${port})`
    if (strict === 'yes') {
      ctx.err(`No ED25519 host key is known for ${tag} and you have requested strict checking.\nHost key verification failed.\n`)
      return null
    }
    if (strict === 'ask') {
      if (batch) {
        ctx.err('Host key verification failed.\n')
        return null
      }
      ctx.err(`The authenticity of host '${shown}' can't be established.\nED25519 key fingerprint is ${hk.fingerprint}.\nThis key is not known by any other names.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? `)
      const answer = ctx.stdin.readLine()
      if (answer === null) ctx.err(`yes\n${NOTE_KEY}`)
      else {
        ctx.err('\n')
        if (!/^yes$/i.test(answer.trim()) && answer.trim() !== hk.fingerprint) {
          ctx.err('Host key verification failed.\n')
          return null
        }
      }
    }
    try {
      if (!client.vfs.exists(`${home}/.ssh`)) client.vfs.mkdir(`${home}/.ssh`, cred, 0o700)
      client.vfs.writeFile(khPath, (khText && !khText.endsWith('\n') ? '\n' : '') + knownLine(client, tag, hk) + '\n', cred, { append: true, mode: 0o644, umask: 0o022 })
      ctx.err(`Warning: Permanently added '${tag}' (ED25519) to the list of known hosts.\n`)
    } catch {
      ctx.err(`Failed to add the host to the list of known hosts (${khPath}).\n`)
    }
  }

  // Autenticación en el servidor.
  const sc = host.sshd!
  const sshPid = host.allocPid()
  const srcPort = 40000 + Math.floor(Math.random() * 20000)
  const u = host.users.get(user)
  const groupsOf = (name: string) => [...host.groups.values()].filter((g) => g.members.includes(name) || g.gid === host.users.get(name)?.gid).map((g) => g.name)
  let denied: string | undefined
  if (!u) denied = `Invalid user ${user} from ${src} port ${srcPort}`
  else if (sc.denyUsers.includes(user)) denied = `User ${user} from ${src} not allowed because listed in DenyUsers`
  else if (sc.allowUsers.length && !sc.allowUsers.some((p) => p.split('@')[0] === user)) denied = `User ${user} from ${src} not allowed because not listed in AllowUsers`
  else if (sc.denyGroups.length && groupsOf(user).some((g) => sc.denyGroups.includes(g))) denied = `User ${user} from ${src} not allowed because a group is listed in DenyGroups`
  else if (sc.allowGroups.length && !groupsOf(user).some((g) => sc.allowGroups.includes(g))) denied = `User ${user} from ${src} not allowed because none of user's groups are listed in AllowGroups`
  if (denied) sshLog(host, sshPid, denied, 6)
  const rootPw = user !== 'root' || sc.permitRootLogin === 'yes'
  const rootKey = user !== 'root' || ['yes', 'prohibit-password', 'forced-commands-only'].includes(sc.permitRootLogin)

  const methods = ['publickey', ...(sc.gssapi ? ['gssapi-keyex', 'gssapi-with-mic'] : []), ...(sc.password ? ['password'] : [])]
  dbg(`Authentications that can continue: ${methods.join(',')}`)

  // 1) Claves.
  if (sc.pubkey && o.pubkey !== false && !o.passwordOnly) {
    const files = [...o.identities, ...conf.identityFiles]
    const explicit = files.length > 0
    const candidates = explicit ? files : ['id_rsa', 'id_ecdsa', 'id_ed25519'].map((f) => `${home}/.ssh/${f}`)
    const agent = agentOf(ctx.sh)
    const tried = new Set<string>()
    const offer: { body: string; file: string; type: KeyType; encrypted: boolean; fromAgent: boolean }[] = []
    for (const [body, k] of agent ?? []) offer.push({ body, file: k.file, type: k.type, encrypted: false, fromAgent: true })
    for (const f0 of candidates) {
      const f = ctx.sh.resolve(f0)
      if (!client.vfs.exists(f)) {
        if (explicit) ctx.err(`Warning: Identity file ${f0} not accessible: No such file or directory.\n`)
        continue
      }
      const st = client.vfs.stat(f, ROOT_CRED)
      if (st.mode & 0o077) {
        ctx.err(
          `@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\nPermissions 0${(st.mode & 0o777).toString(8)} for '${f}' are too open.\nIt is required that your private key files are NOT accessible by others.\nThis private key will be ignored.\nLoad key "${f}": bad permissions\n`,
        )
        continue
      }
      let text: string
      try {
        text = client.vfs.readFile(f, cred)
      } catch {
        ctx.err(`Load key "${f}": Permission denied\n`)
        continue
      }
      const k = readPrivate(text)
      if (!k) continue
      offer.push({ body: k.body, file: f, type: k.type, encrypted: k.encrypted, fromAgent: false })
    }
    const authorized = new Set<string>()
    let problem: string | undefined
    if (u && !denied && rootKey) {
      for (const pattern of sc.authorizedKeysFiles) {
        const rel = pattern.replace(/%h/g, u.home).replace(/%u/g, user).replace(/%%/g, '%')
        const path = rel.startsWith('/') ? rel : `${u.home}/${rel}`
        let text: string
        try {
          text = host.vfs.readFile(path, ROOT_CRED)
        } catch {
          continue
        }
        const bad = sc.strictModes ? strictModesProblem(host, user, path) : undefined
        if (bad) {
          problem = bad
          continue
        }
        for (const line of text.split('\n')) {
          const p = parsePub(line)
          if (p) authorized.add(p.body)
        }
      }
    }
    for (const k of offer) {
      if (tried.has(k.body)) continue
      tried.add(k.body)
      dbg(`Offering public key: ${k.file} ${KEY_TYPES[k.type].label} ${fingerprintOf(k.body)}${k.fromAgent ? ' agent' : ''}`)
      if (!authorized.has(k.body)) continue
      dbg('Server accepts key')
      if (k.encrypted && !agent?.has(k.body)) {
        if (batch) continue
        ctx.err(`Enter passphrase for key '${k.file}': \n[simulador] Escribes la frase de paso de la clave (no la contraseña del servidor). Con ssh-agent y ssh-add la escribes una sola vez por sesión.\n`)
      }
      sshLog(host, sshPid, `Accepted publickey for ${user} from ${src} port ${srcPort} ssh2: ${KEY_TYPES[k.type].label} ${fingerprintOf(k.body)}`)
      return opened(ctx, host, user, o.alias, hostname, 'publickey', sshPid)
    }
    if (problem) sshLog(host, sshPid, problem, 6)
  }

  // 2) Contraseña.
  if (sc.password && o.passwordAuth !== false && !batch) {
    const okPw = !!u && !denied && rootPw && u.hasPassword && !u.locked
    ctx.err(`${user}@${hostname}'s password: \n`)
    if (okPw) {
      ctx.err('[simulador] Escribes la contraseña de la cuenta en el servidor (en pantalla no se ve nada mientras la escribes).\n')
      sshLog(host, sshPid, `Accepted password for ${user} from ${src} port ${srcPort} ssh2`)
      return opened(ctx, host, user, o.alias, hostname, 'password', sshPid)
    }
    ctx.err(`Permission denied, please try again.\n${user}@${hostname}'s password: \nPermission denied, please try again.\n${user}@${hostname}'s password: \n`)
    if (!u) ctx.err(`[simulador] La cuenta ${user} no existe en ${host.hostname}: ninguna contraseña va a funcionar.\n`)
    else if (denied) ctx.err(`[simulador] La configuración de sshd de ${host.hostname} no deja entrar a ${user}, aunque la contraseña sea correcta.\n`)
    else if (!rootPw) ctx.err(`[simulador] PermitRootLogin no permite entrar como root con contraseña.\n`)
    else if (u.locked || !u.hasPassword) ctx.err(`[simulador] La cuenta ${user} no tiene una contraseña con la que se pueda entrar (está bloqueada o vacía).\n`)
    sshLog(host, sshPid, `Failed password for ${u ? '' : 'invalid user '}${user} from ${src} port ${srcPort} ssh2`, 6)
  } else sshLog(host, sshPid, `Connection closed by ${u ? 'authenticating user ' + user + ' ' : 'invalid user ' + user + ' '}${src} port ${srcPort} [preauth]`, 6)
  ctx.err(`${user}@${hostname}: Permission denied (${methods.join(',')}).\n`)
  return null
}

function opened(ctx: CommandContext, host: System, user: string, alias: string, hostname: string, method: 'publickey' | 'password', sshPid: number): Session {
  const uid = host.users.get(user)?.uid ?? 0
  sshLog(host, sshPid, `pam_unix(sshd:session): session opened for user ${user}(uid=${uid}) by ${user}(uid=0)`)
  void ctx
  return { host, user, alias, hostname, method }
}

/** Mensaje de bienvenida de cada distribución y "Last login". */
function welcome(ctx: CommandContext, s: Session) {
  const host = s.host
  const last = host.lastLogins.get(s.user)
  const from = sourceIp(ctx.sys, host.ownIps()[1] ?? '')
  if (host.distro === 'ubuntu') {
    ctx.out(`Welcome to Ubuntu 24.04.3 LTS (GNU/Linux 6.8.0-58-generic x86_64)\n\n * Documentation:  https://help.ubuntu.com\n * Management:     https://landscape.canonical.com\n * Support:        https://ubuntu.com/pro\n\n`)
  } else ctx.out(`Web console: https://${host.hostname}:9090/ or https://${host.ownIps()[1] ?? '127.0.0.1'}:9090/\n\n`)
  if (last) ctx.out(`Last login: ${strftime('%a %b %e %T %Y', new Date(last.time))} from ${last.from}\n`)
  host.lastLogins.set(s.user, { time: Date.now(), from })
}

// ---------------------------------------------------------------------------------------
// ssh
// ---------------------------------------------------------------------------------------

function parseDest(dest: string): { user?: string; host: string; port?: number } {
  const url = /^ssh:\/\/(?:([^@]+)@)?([^:/]+)(?::(\d+))?\/?$/.exec(dest)
  if (url) return { user: url[1], host: url[2], port: url[3] ? Number(url[3]) : undefined }
  const at = dest.lastIndexOf('@')
  return at >= 0 ? { user: dest.slice(0, at), host: dest.slice(at + 1) } : { host: dest }
}

function sshOptions(args: string[]) {
  const o: ConnectOpts & { command: string[]; dest?: string; quiet?: boolean } = { alias: '', identities: [], command: [] }
  const rest = [...args]
  while (rest.length) {
    const a = rest.shift()!
    if (o.dest) {
      o.command.push(a, ...rest)
      break
    }
    if (a === '-p') o.port = Number(rest.shift())
    else if (a.startsWith('-p') && /^\d+$/.test(a.slice(2))) o.port = Number(a.slice(2))
    else if (a === '-i') o.identities.push(rest.shift() ?? '')
    else if (a === '-l') o.user = rest.shift()
    else if (a === '-J') o.jump = rest.shift()
    else if (a === '-o') {
      const [k, ...v] = (rest.shift() ?? '').split(/=|\s+/)
      const val = v.join('=').trim()
      const key = k.toLowerCase()
      if (key === 'stricthostkeychecking') o.strict = val.toLowerCase()
      else if (key === 'batchmode') o.batch = val.toLowerCase() === 'yes'
      else if (key === 'port') o.port = Number(val)
      else if (key === 'user') o.user = val
      else if (key === 'pubkeyauthentication') o.pubkey = val.toLowerCase() !== 'no'
      else if (key === 'passwordauthentication') o.passwordAuth = val.toLowerCase() !== 'no'
      else if (key === 'proxyjump') o.jump = val
      else if (key === 'identityfile') o.identities.push(val)
    } else if (/^-[vqtTNAC46]+$/.test(a)) {
      if (a.includes('v')) o.verbose = true
      if (a.includes('q')) o.quiet = true
    } else if (a.startsWith('-')) {
      // opción no simulada: se ignora
    } else o.dest = a
  }
  return o
}

register('ssh', {
  usage: 'ssh [-p puerto] [-i clave] [-J bastión] [-o opción=valor] [usuario@]servidor [comando]',
  summary: '  -p  puerto  -i  archivo de clave  -J  saltar por un bastión  -v  mostrar el detalle de la conexión\n  -o StrictHostKeyChecking=accept-new  -o PubkeyAuthentication=no  -o BatchMode=yes',
  async run(ctx) {
    const o = sshOptions(ctx.args)
    if (!o.dest) {
      ctx.err('usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] [-B bind_interface] [-b bind_address]\n           [-c cipher_spec] [-D [bind_address:]port] [-E log_file]\n           [-e escape_char] [-F configfile] [-I pkcs11] [-i identity_file]\n           [-J destination] [-L address] [-l login_name] [-m mac_spec]\n           [-O ctl_cmd] [-o option] [-P tag] [-p port] [-R address]\n           [-S ctl_path] [-W host:port] [-w local_tun[:remote_tun]]\n           destination [command [argument ...]]\n')
      return 255
    }
    const d = parseDest(o.dest)
    o.alias = d.host
    o.user = d.user ?? o.user
    o.port = d.port ?? o.port
    if (ctx.args.includes('-G')) {
      // ssh -G: la configuración que usaría, sin conectarse.
      const c = clientConfig(ctx.sys, ctx.sh.cred, ctx.sh.home, d.host)
      const ids = [...o.identities, ...c.identityFiles]
      ctx.out(`host ${d.host}\nuser ${o.user ?? c.user ?? ctx.sh.user}\nhostname ${c.hostname ?? d.host}\nport ${o.port ?? c.port ?? 22}\n${(o.jump ?? c.proxyJump) ? `proxyjump ${o.jump ?? c.proxyJump}\n` : ''}stricthostkeychecking ${o.strict ?? c.strictHostKeyChecking ?? 'ask'}\n${(ids.length ? ids : ['~/.ssh/id_rsa', '~/.ssh/id_ecdsa', '~/.ssh/id_ed25519']).map((f) => `identityfile ${f.replace(ctx.sh.home, '~')}\n`).join('')}`)
      return 0
    }
    const s = await connect(ctx, o)
    if (!s) return 255
    const sh = ctx.sh
    if (o.command.length) {
      return sh.onHost(s.host, s.user, () => sh.runSource(o.command.join(' '), 'bash', [], { stdin: ctx.stdin, out: ctx.out, err: ctx.err, isTTY: false }))
    }
    const shell = s.host.users.get(s.user)?.shell ?? '/bin/bash'
    if (/nologin|false$/.test(shell)) {
      ctx.out('This account is currently not available.\n')
      ctx.err(`Connection to ${s.hostname} closed.\n`)
      return 1
    }
    welcome(ctx, s)
    const priv = s.host.spawn('root', `sshd-session: ${s.user} [priv]`, 0, 0.1, s.host.procs.find((p) => p.comm === 'sshd')?.pid ?? 1, Date.now(), 'sshd-session')
    const sess = s.host.spawn(s.user, `sshd-session: ${s.user}@pts/1`, 0, 0.1, priv.pid, Date.now(), 'sshd-session')
    s.host.spawn(s.user, '-bash', 0, 0.1, sess.pid, Date.now(), 'bash').tty = 'pts/1'
    sh.pushHost(s.host, s.user, s.hostname)
    return 0
  },
})

// ---------------------------------------------------------------------------------------
// ssh-keygen
// ---------------------------------------------------------------------------------------

function readText(sys: System, path: string, cred: Cred): string | undefined {
  try {
    return sys.vfs.readFile(path, cred)
  } catch {
    return undefined
  }
}

register('ssh-keygen', {
  usage: 'ssh-keygen [-t ed25519|rsa|ecdsa] [-C comentario] [-f archivo] [-N frase]  |  -l -f archivo  |  -y -f clave  |  -R servidor  |  -F servidor',
  summary: '  -t tipo (por defecto ed25519)  -C comentario  -f archivo  -N frase de paso ("" = sin frase)\n  -l  mostrar la huella  -y  mostrar la parte pública  -R  borrar un servidor de known_hosts  -p  cambiar la frase',
  run(ctx) {
    const sys = ctx.sys
    const cred = ctx.sh.cred
    const home = ctx.sh.home
    const args = [...ctx.args]
    const val = (flag: string) => {
      const i = args.indexOf(flag)
      return i >= 0 ? args[i + 1] : undefined
    }
    const has = (flag: string) => args.some((a) => a === flag || (a.startsWith('-') && !a.startsWith('--') && a.length > 2 && a.slice(1).split('').includes(flag.slice(1)) && !['-f', '-t', '-C', '-N', '-b', '-R', '-F', '-P'].includes(a)))
    const file = val('-f')
    const kh = file ? ctx.sh.resolve(file) : `${home}/.ssh/known_hosts`
    if (val('-R') !== undefined) {
      const tag = val('-R')!
      const text = readText(sys, kh, cred)
      if (text === undefined) {
        ctx.err(`do_known_hosts: ${kh}: No such file or directory\n`)
        return 1
      }
      const r = removeKnown(text, tag)
      if (!r.removed.length) {
        ctx.err(`Host ${tag} not found in ${kh}\n`)
        return 0
      }
      sys.vfs.writeFile(`${kh}.old`, text, cred, { mode: 0o600 })
      sys.vfs.writeFile(kh, r.text, cred)
      for (const n of r.removed) ctx.out(`# Host ${tag} found: line ${n}\n`)
      ctx.out(`${kh} updated.\nOriginal contents retained as ${kh}.old\n`)
      return 0
    }
    if (val('-F') !== undefined) {
      const tag = val('-F')!
      const text = readText(sys, kh, cred) ?? ''
      let found = false
      text.split('\n').forEach((l, i) => {
        if (!l.trim() || l.startsWith('#')) return
        const r = removeKnown(l, tag)
        if (r.removed.length) {
          found = true
          ctx.out(`# Host ${tag} found: line ${i + 1} \n${l}\n`)
        }
      })
      return found ? 0 : 1
    }
    if (has('-l') || has('-y')) {
      if (!file) {
        ctx.err('[simulador] Indica el archivo con -f, por ejemplo: ssh-keygen -l -f ~/.ssh/id_ed25519.pub\n')
        return 1
      }
      const path = ctx.sh.resolve(file)
      const text = readText(sys, path, cred)
      if (text === undefined) {
        ctx.err(`${file}: No such file or directory\n`)
        return 255
      }
      const priv = readPrivate(text)
      const pub = parsePub(text.split('\n')[0])
      const body = priv?.body ?? pub?.body
      const type = priv?.type ?? pub?.type
      if (!body || !type) {
        ctx.err(`${file} is not a key file.\n`)
        return 255
      }
      const comment = pub?.comment ?? readText(sys, `${path}.pub`, cred)?.split(' ').slice(2).join(' ').trim() ?? ''
      if (has('-y')) {
        if (priv?.encrypted) ctx.err(`Enter passphrase for "${file}": \n[simulador] Escribes la frase de paso de la clave.\n`)
        ctx.out(`${KEY_TYPES[type].algo} ${body}${comment ? ` ${comment}` : ''}\n`)
      } else ctx.out(`${KEY_TYPES[type].bits} ${fingerprintOf(body)} ${comment || 'no comment'} (${KEY_TYPES[type].label})\n`)
      return 0
    }
    if (has('-p')) {
      const path = ctx.sh.resolve(file ?? `${home}/.ssh/id_ed25519`)
      const text = readText(sys, path, cred)
      const k = text && readPrivate(text)
      if (!k) {
        ctx.err(`Failed to load key ${path}: No such file or directory\n`)
        return 255
      }
      const encrypt = (val('-N') ?? '') !== ''
      sys.vfs.writeFile(path, k.encrypted === encrypt ? text! : rewrap(text!, encrypt), cred, { mode: 0o600 })
      ctx.out('Your identification has been saved with the new passphrase.\n')
      return 0
    }
    // Crear una clave nueva.
    const type = (val('-t') ?? 'ed25519').toLowerCase() as KeyType
    if (!KEY_TYPES[type]) {
      ctx.err(`unknown key type ${val('-t')}\n`)
      return 1
    }
    const comment = val('-C') ?? `${ctx.sh.user}@${sys.hostname}`
    ctx.out(`Generating public/private ${type} key pair.\n`)
    let path = file ? ctx.sh.resolve(file) : `${home}/.ssh/id_${type}`
    if (!file) {
      ctx.out(`Enter file in which to save the key (${path}): `)
      const ans = ctx.stdin.readLine()
      ctx.out('\n')
      if (ans && ans.trim()) path = ctx.sh.resolve(ans.trim())
    }
    const dir = path.slice(0, path.lastIndexOf('/')) || '/'
    if (!sys.vfs.exists(dir)) {
      try {
        sys.vfs.mkdir(dir, cred, 0o700)
        ctx.out(`Created directory '${dir}'.\n`)
      } catch {
        ctx.err(`Could not create directory '${dir}': Permission denied\n`)
        return 1
      }
    }
    if (sys.vfs.exists(path)) {
      ctx.out(`${path} already exists.\nOverwrite (y/n)? `)
      const ans = ctx.stdin.readLine()
      if (ans === null) ctx.out('n\n[simulador] Respondes "n": pisar una clave que ya se usa deja afuera a todos los servidores donde estaba instalada.\n')
      else ctx.out('\n')
      if (!ans || !/^y/i.test(ans.trim())) return 1
    }
    let pass = val('-N')
    if (pass === undefined) {
      ctx.out('Enter passphrase (empty for no passphrase): ')
      const a = ctx.stdin.readLine()
      ctx.out('\nEnter same passphrase again: ')
      const b = ctx.stdin.readLine()
      ctx.out('\n')
      if (a === null) ctx.out('[simulador] Dejaste la frase de paso vacía (Enter dos veces). Para una clave personal conviene ponerle una; para una que usa un proceso automático, se deja vacía.\n')
      else if (a !== b) {
        ctx.out('Passphrases do not match.  Try again.\n')
        return 1
      }
      pass = a ?? ''
    }
    const key = makeKey(type, `${sys.hostname}:${path}:${Date.now()}:${Math.random()}`, comment, pass !== '')
    try {
      sys.vfs.writeFile(path, key.priv, cred, { mode: 0o600 })
      sys.vfs.writeFile(`${path}.pub`, key.pub + '\n', cred, { mode: 0o644 })
    } catch (e) {
      ctx.err(`Saving key "${path}" failed: ${e instanceof FsError ? e.message : 'error'}\n`)
      return 1
    }
    ctx.out(`Your identification has been saved in ${path}\nYour public key has been saved in ${path}.pub\nThe key fingerprint is:\n${key.fingerprint} ${comment}\nThe key's randomart image is:\n${randomArt(type, key.fingerprint)}\n`)
    return 0
  },
})

/** Cambia si una clave privada tiene frase de paso, sin cambiar su parte pública. */
function rewrap(text: string, encrypted: boolean): string {
  const k = readPrivate(text)!
  const joined = text.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const rest = joined.slice(joined.indexOf(k.body) - 40)
  const head = encrypted ? 'b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABD' : 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW'
  const lines = (head + rest).match(/.{1,70}/g) ?? []
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`
}

// ---------------------------------------------------------------------------------------
// ssh-copy-id
// ---------------------------------------------------------------------------------------

register('ssh-copy-id', {
  usage: 'ssh-copy-id [-i clave.pub] [-p puerto] [usuario@]servidor',
  async run(ctx) {
    const args = [...ctx.args]
    let idFile: string | undefined
    let port: number | undefined
    let dest: string | undefined
    const extra: string[] = []
    while (args.length) {
      const a = args.shift()!
      if (a === '-i') idFile = args.shift()
      else if (a.startsWith('-i') && a.length > 2) idFile = a.slice(2)
      else if (a === '-p') port = Number(args.shift())
      else if (a === '-o') extra.push(args.shift() ?? '')
      else if (a === '-f' || a === '-n') continue
      else dest = a
    }
    if (!dest) {
      ctx.err('Usage: /usr/bin/ssh-copy-id [-h|-?|-f|-n|-s|-x] [-i [identity_file]] [-p port] [-F alternative ssh_config file] [-t target_path] [[-o <ssh -o options>] ...] [user@]hostname\n')
      return 1
    }
    const home = ctx.sh.home
    const cred = ctx.sh.cred
    let pubPath: string | undefined
    if (idFile) pubPath = ctx.sh.resolve(idFile.endsWith('.pub') ? idFile : `${idFile}.pub`)
    else pubPath = ['id_ed25519', 'id_ecdsa', 'id_rsa'].map((f) => `${home}/.ssh/${f}.pub`).find((p) => ctx.sys.vfs.exists(p))
    const pubText = pubPath ? readText(ctx.sys, pubPath, cred) : undefined
    const pub = pubText ? parsePub(pubText.split('\n')[0]) : undefined
    if (!pubPath || !pub) {
      ctx.err(`/usr/bin/ssh-copy-id: ERROR: No identities found\n`)
      return 1
    }
    ctx.err(`/usr/bin/ssh-copy-id: INFO: Source of key(s) to be installed: "${pubPath}"\n`)
    const d = parseDest(dest)
    // Primero prueba si la clave ya funciona (sin contraseña), como el script real.
    const probe = await quietConnect(ctx, { alias: d.host, user: d.user, port, identities: [pubPath.replace(/\.pub$/, '')], batch: true })
    if (probe) {
      ctx.err(`/usr/bin/ssh-copy-id: INFO: attempting to log in with the new key(s), to filter out any that are already installed\n\n/usr/bin/ssh-copy-id: WARNING: All keys were skipped because they already exist on the remote system.\n\t\t(if you think this is a mistake, you may want to use -f option)\n\n`)
      return 0
    }
    ctx.err(`/usr/bin/ssh-copy-id: INFO: attempting to log in with the new key(s), to filter out any that are already installed\n/usr/bin/ssh-copy-id: INFO: 1 key(s) remain to be installed -- if you are prompted now it is to install the new keys\n`)
    const s = await connect(ctx, { alias: d.host, user: d.user, port, identities: [], passwordOnly: true })
    if (!s) return 1
    const u = s.host.users.get(s.user)!
    const ucred = s.host.credFor(s.user)
    try {
      if (!s.host.vfs.exists(`${u.home}/.ssh`)) s.host.vfs.mkdir(`${u.home}/.ssh`, ucred, 0o700)
      const ak = `${u.home}/.ssh/authorized_keys`
      const old = readText(s.host, ak, ucred) ?? ''
      s.host.vfs.writeFile(ak, (old && !old.endsWith('\n') ? '\n' : '') + `${KEY_TYPES[pub.type].algo} ${pub.body}${pub.comment ? ` ${pub.comment}` : ''}\n`, ucred, { append: true, mode: 0o600, umask: 0o077 })
    } catch {
      ctx.err(`sh: line 1: .ssh/authorized_keys: Permission denied\n`)
      return 1
    }
    ctx.out(`\nNumber of key(s) added: 1\n\nNow try logging into the machine, with: "ssh ${port ? `-p ${port} ` : ''}'${s.user}@${d.host}'"\nand check to make sure that only the key(s) you wanted were added.\n\n`)
    return 0
  },
})

/** Conecta sin escribir nada en la terminal (para probar si una clave ya funciona). */
async function quietConnect(ctx: CommandContext, o: ConnectOpts): Promise<Session | null> {
  const quiet: CommandContext = { ...ctx, out: () => undefined, err: () => undefined }
  return connect(quiet, { ...o, strict: 'no' })
}

// ---------------------------------------------------------------------------------------
// ssh-agent y ssh-add
// ---------------------------------------------------------------------------------------

register('ssh-agent', {
  usage: 'eval "$(ssh-agent -s)"',
  run(ctx) {
    const pid = ctx.sys.allocPid()
    const sock = `/tmp/ssh-${Math.random().toString(36).slice(2, 14)}/agent.${pid - 1}`
    let agents = AGENTS.get(ctx.sh)
    if (!agents) AGENTS.set(ctx.sh, (agents = new Map()))
    agents.set(sock, new Map())
    ctx.sys.spawn(ctx.sh.user, 'ssh-agent -s', 0, 0.1, 1, Date.now(), 'ssh-agent')
    ctx.out(`SSH_AUTH_SOCK=${sock}; export SSH_AUTH_SOCK;\nSSH_AGENT_PID=${pid}; export SSH_AGENT_PID;\necho Agent pid ${pid};\n`)
    return 0
  },
})

register('ssh-add', {
  usage: 'ssh-add [archivo]  |  ssh-add -l  |  ssh-add -D',
  run(ctx) {
    const agent = agentOf(ctx.sh)
    if (!agent) {
      ctx.err('Could not open a connection to your authentication agent.\n')
      if (!ctx.sh.vars.get('SSH_AUTH_SOCK')) ctx.err('[simulador] Primero arranca el agente en esta sesión: eval "$(ssh-agent -s)"\n')
      return 2
    }
    if (ctx.args.includes('-l')) {
      if (!agent.size) {
        ctx.out('The agent has no identities.\n')
        return 1
      }
      for (const [body, k] of agent) ctx.out(`${KEY_TYPES[k.type].bits} ${fingerprintOf(body)} ${k.comment} (${KEY_TYPES[k.type].label})\n`)
      return 0
    }
    if (ctx.args.includes('-D')) {
      agent.clear()
      ctx.err('All identities removed.\n')
      return 0
    }
    const files = ctx.args.filter((a) => !a.startsWith('-'))
    const home = ctx.sh.home
    const list = files.length ? files.map((f) => ctx.sh.resolve(f)) : ['id_rsa', 'id_ecdsa', 'id_ed25519'].map((f) => `${home}/.ssh/${f}`).filter((p) => ctx.sys.vfs.exists(p))
    let code = 0
    for (const f of list) {
      const text = readText(ctx.sys, f, ctx.sh.cred)
      const k = text && readPrivate(text)
      if (!k) {
        ctx.err(`${f}: No such file or directory\n`)
        code = 1
        continue
      }
      const comment = readText(ctx.sys, `${f}.pub`, ctx.sh.cred)?.trim().split(' ').slice(2).join(' ') || f
      if (k.encrypted) ctx.err(`Enter passphrase for ${f}: \n[simulador] Escribes la frase de paso una vez; mientras dure la sesión, ssh no la vuelve a pedir.\n`)
      agent.set(k.body, { comment, type: k.type, file: f })
      ctx.err(`Identity added: ${f} (${comment})\n`)
    }
    return code
  },
})

// ---------------------------------------------------------------------------------------
// scp y rsync
// ---------------------------------------------------------------------------------------

interface Endpoint {
  sys: System
  cred: Cred
  path: string
  label: string
}

function splitRemote(spec: string): { remote?: string; path: string } {
  const m = /^((?:[^@/:]+@)?[A-Za-z0-9._-]+):(.*)$/.exec(spec)
  if (m && !spec.startsWith('/') && !spec.startsWith('./')) return { remote: m[1], path: m[2] }
  return { path: spec }
}

async function endpoint(ctx: CommandContext, spec: string, opts: { port?: number; identities: string[] }, cache: Map<string, Session>): Promise<Endpoint | null> {
  const r = splitRemote(spec)
  if (!r.remote) return { sys: ctx.sys, cred: ctx.sh.cred, path: ctx.sh.resolve(r.path), label: r.path }
  let s = cache.get(r.remote)
  if (!s) {
    const d = parseDest(r.remote)
    const c = await connect(ctx, { alias: d.host, user: d.user, port: opts.port, identities: opts.identities })
    if (!c) return null
    s = c
    cache.set(r.remote, s)
  }
  const home = s.host.users.get(s.user)?.home ?? '/'
  const p = r.path === '' ? home : r.path.startsWith('/') ? r.path : `${home}/${r.path.replace(/^~\/?/, '')}`
  return { sys: s.host, cred: s.host.credFor(s.user), path: p.replace(/\/+$/, '') || '/', label: r.path }
}

function isDir(e: Endpoint, path = e.path): boolean {
  try {
    return e.sys.vfs.stat(path, e.cred).type === 'dir'
  } catch {
    return false
  }
}

/** Lista de archivos de un árbol, con rutas relativas (las carpetas terminan en /). */
function walk(e: Endpoint, base: string, rel = ''): string[] {
  const out: string[] = []
  const full = rel ? `${base}/${rel}` : base
  for (const n of e.sys.vfs.readdir(full, e.cred).sort()) {
    const r = rel ? `${rel}/${n}` : n
    if (isDir(e, `${base}/${r}`)) out.push(`${r}/`, ...walk(e, base, r))
    else out.push(r)
  }
  return out
}

function writeAs(dst: Endpoint, path: string, data: string, mode: number) {
  dst.sys.vfs.writeFile(path, data, dst.cred, { mode, umask: 0o022 })
}

register('scp', {
  usage: 'scp [-r] [-P puerto] [-i clave] origen... destino   (remoto: [usuario@]servidor:ruta)',
  async run(ctx) {
    const args = [...ctx.args]
    let recursive = false
    let port: number | undefined
    const identities: string[] = []
    const paths: string[] = []
    while (args.length) {
      const a = args.shift()!
      if (a === '-P') port = Number(args.shift())
      else if (a === '-i') identities.push(args.shift() ?? '')
      else if (/^-[rpqvC346]+$/.test(a)) recursive ||= a.includes('r')
      else paths.push(a)
    }
    if (paths.length < 2) {
      ctx.err('usage: scp [-346ABCOpqRrsTv] [-c cipher] [-D sftp_server_path] [-F ssh_config]\n           [-i identity_file] [-J destination] [-l limit] [-o ssh_option]\n           [-P port] [-S program] [-X sftp_option] source ... target\n')
      return 1
    }
    const cache = new Map<string, Session>()
    const dst = await endpoint(ctx, paths[paths.length - 1], { port, identities }, cache)
    if (!dst) return 255
    let code = 0
    for (const spec of paths.slice(0, -1)) {
      const src = await endpoint(ctx, spec, { port, identities }, cache)
      if (!src) return 255
      const name = src.path.split('/').pop() ?? src.path
      if (!src.sys.vfs.exists(src.path)) {
        ctx.err(`scp: ${src.label}: No such file or directory\n`)
        code = 1
        continue
      }
      const target = isDir(dst) ? `${dst.path}/${name}` : dst.path
      try {
        if (isDir(src)) {
          if (!recursive) {
            ctx.err(`scp: ${src.label}: not a regular file\n`)
            code = 1
            continue
          }
          if (!dst.sys.vfs.exists(target)) dst.sys.vfs.mkdir(target, dst.cred, 0o755)
          for (const r of walk(src, src.path)) {
            if (r.endsWith('/')) {
              if (!dst.sys.vfs.exists(`${target}/${r}`)) dst.sys.vfs.mkdir(`${target}/${r.slice(0, -1)}`, dst.cred, 0o755)
            } else {
              const data = src.sys.vfs.readFile(`${src.path}/${r}`, src.cred)
              writeAs(dst, `${target}/${r}`, data, src.sys.vfs.stat(`${src.path}/${r}`, src.cred).mode & 0o777)
              if (ctx.isTTY) ctx.out(progress(r.split('/').pop()!, data.length))
            }
          }
        } else {
          const data = src.sys.vfs.readFile(src.path, src.cred)
          writeAs(dst, target, data, src.sys.vfs.stat(src.path, src.cred).mode & 0o777)
          if (ctx.isTTY) ctx.out(progress(name, data.length))
        }
      } catch (e) {
        const which = e instanceof FsError && e.path.startsWith(dst.path.split('/').slice(0, -1).join('/') || '/') && e.path !== src.path ? target : src.path
        ctx.err(`scp: ${which}: ${e instanceof FsError ? e.message : 'error'}\n`)
        code = 1
      }
    }
    return code
  },
})

function progress(name: string, bytes: number): string {
  const size = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${bytes}`
  return `${name.padEnd(40).slice(0, 40)} 100% ${size.padStart(6)}   ${((bytes / 1024) * 3.1 + 40).toFixed(1)}KB/s   00:00    \n`
}

register('rsync', {
  usage: 'rsync -av [--delete] [-n] origen destino   (remoto: [usuario@]servidor:ruta)',
  summary: '  -a  archivo (recursivo, conserva permisos y fechas)  -v  mostrar los archivos  -z  comprimir\n  -n  probar sin copiar (--dry-run)  --delete  borrar en el destino lo que ya no está en el origen\n  Ojo con la barra final: "origen/" copia el contenido; "origen" copia la carpeta.',
  async run(ctx) {
    const flags = ctx.args.filter((a) => a.startsWith('-'))
    const paths = ctx.args.filter((a, i) => !a.startsWith('-') && ctx.args[i - 1] !== '-e')
    const short = flags.filter((f) => !f.startsWith('--')).join('')
    const recursive = /[ar]/.test(short)
    const verbose = short.includes('v')
    const dry = short.includes('n') || flags.includes('--dry-run')
    const del = flags.includes('--delete')
    if (paths.length < 2) {
      ctx.err('rsync  version 3.4.1  protocol version 32\nUsage: rsync [OPTION]... SRC [SRC]... DEST\n')
      return 1
    }
    const cache = new Map<string, Session>()
    const srcSpec = paths[0]
    const src = await endpoint(ctx, srcSpec, { identities: [] }, cache)
    if (!src) return 255
    const dst = await endpoint(ctx, paths[paths.length - 1], { identities: [] }, cache)
    if (!dst) return 255
    for (const e of [src, dst]) {
      if (e.sys !== ctx.sys && !e.sys.installed.has('rsync')) {
        ctx.err('bash: line 1: rsync: command not found\nrsync: connection unexpectedly closed (0 bytes received so far) [sender]\nrsync error: error in rsync protocol data stream (code 12) at io.c(232) [sender=3.4.1]\n')
        return 12
      }
    }
    if (!src.sys.vfs.exists(src.path)) {
      ctx.err(`rsync: [sender] link_stat "${src.path}" failed: No such file or directory (2)\nrsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1338) [sender=3.4.1]\n`)
      return 23
    }
    const contents = srcSpec.endsWith('/')
    const srcIsDir = isDir(src)
    if (srcIsDir && !recursive) {
      ctx.out(`skipping directory ${srcSpec.replace(/\/$/, '')}\n`)
      return 0
    }
    const base = srcIsDir && !contents ? `${dst.path}/${src.path.split('/').pop()}` : srcIsDir ? dst.path : isDir(dst) ? `${dst.path}/${src.path.split('/').pop()}` : dst.path
    const list = srcIsDir ? walk(src, src.path) : ['']
    const lines: string[] = []
    let bytes = 0
    let total = 0
    try {
      if (srcIsDir && !dst.sys.vfs.exists(base)) {
        if (!dry) dst.sys.vfs.mkdirp(base, dst.cred)
        if (!contents) lines.push(`${src.path.split('/').pop()}/`)
      }
      for (const r of list) {
        const from = r ? `${src.path}/${r.replace(/\/$/, '')}` : src.path
        const to = r ? `${base}/${r.replace(/\/$/, '')}` : base
        const shown = !srcIsDir ? src.path.split('/').pop()! : contents ? r : `${src.path.split('/').pop()}/${r}`
        if (r.endsWith('/')) {
          if (!dst.sys.vfs.exists(to)) {
            if (!dry) dst.sys.vfs.mkdir(to, dst.cred, 0o755)
            lines.push(shown)
          }
          continue
        }
        const data = src.sys.vfs.readFile(from, src.cred)
        total += data.length
        const old = dst.sys.vfs.exists(to) ? readText(dst.sys, to, dst.cred) : undefined
        if (old === data) continue
        if (!dry) writeAs(dst, to, data, src.sys.vfs.stat(from, src.cred).mode & 0o777)
        bytes += data.length
        lines.push(shown)
      }
      if (del && srcIsDir && dst.sys.vfs.exists(base)) {
        const have = new Set(list.map((x) => x.replace(/\/$/, '')))
        for (const r of walk(dst, base).reverse()) {
          const k = r.replace(/\/$/, '')
          if (have.has(k)) continue
          if (!dry) dst.sys.vfs.removeTree(`${base}/${k}`, dst.cred)
          lines.unshift(`deleting ${contents ? '' : `${src.path.split('/').pop()}/`}${r}`)
        }
      }
    } catch (e) {
      ctx.err(`rsync: ${e instanceof FsError ? `[receiver] mkstemp "${e.path}" failed: ${e.message}` : 'error'}\nrsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1338) [generator=3.4.1]\n`)
      return 23
    }
    if (verbose) {
      ctx.out(`sending incremental file list\n${lines.map((l) => l + '\n').join('')}\nsent ${bytes + 120 + lines.length * 40} bytes  received ${35 + lines.length * 12} bytes  ${(bytes / 2 + 300).toFixed(2)} bytes/sec\ntotal size is ${total}  speedup is ${(total / Math.max(1, bytes + 155)).toFixed(2)}${dry ? ' (DRY RUN)' : ''}\n`)
    }
    return 0
  },
})

// ---------------------------------------------------------------------------------------
// sshd -t / -T y la configuración que toma el servicio al arrancar
// ---------------------------------------------------------------------------------------

register('sshd', {
  usage: 'sshd -t  (revisar la configuración)  |  sshd -T  (mostrar la configuración efectiva)',
  path: '/usr/sbin',
  run(ctx) {
    if (ctx.sh.user !== 'root') {
      ctx.err('sshd: no hostkeys available -- exiting.\n')
      return 1
    }
    const r = readSshdConfig(ctx.sys)
    if (r.errors.length) {
      for (const e of r.errors) ctx.err(e + '\n')
      ctx.err(`/etc/ssh/sshd_config: terminating, ${r.errors.length} bad configuration options\n`)
      return 255
    }
    if (ctx.args.includes('-T')) {
      const c = r.conf
      const rows: [string, string][] = [
        ...c.ports.map((p) => ['port', String(p)] as [string, string]),
        ['permitrootlogin', c.permitRootLogin],
        ['pubkeyauthentication', c.pubkey ? 'yes' : 'no'],
        ['passwordauthentication', c.password ? 'yes' : 'no'],
        ['kbdinteractiveauthentication', c.kbdInteractive ? 'yes' : 'no'],
        ['gssapiauthentication', c.gssapi ? 'yes' : 'no'],
        ['strictmodes', c.strictModes ? 'yes' : 'no'],
        ['maxauthtries', String(c.maxAuthTries)],
        ['authorizedkeysfile', c.authorizedKeysFiles.join(' ')],
        ...(c.allowUsers.length ? [['allowusers', c.allowUsers.join(' ')] as [string, string]] : []),
        ...(c.allowGroups.length ? [['allowgroups', c.allowGroups.join(' ')] as [string, string]] : []),
        ...(c.denyUsers.length ? [['denyusers', c.denyUsers.join(' ')] as [string, string]] : []),
      ]
      for (const [k, v] of rows) ctx.out(`${k} ${v}\n`)
    }
    return 0
  },
})

/** Al arrancar, reiniciar o recargar sshd: si la configuración es válida, pasa a ser la que usa. */
function sshdCheck(ctx: CommandContext): string | undefined {
  const sys = ctx.sys
  const r = readSshdConfig(sys)
  if (r.errors.length) return `${r.errors[0]}\n/etc/ssh/sshd_config: terminating, ${r.errors.length} bad configuration options`
  const svc = sshdService(sys)
  const ports = sys.distro === 'ubuntu' ? sys.sshSocketPorts : r.conf.ports
  const blocked = ports.filter((p) => !sys.selinuxPortAllowed('ssh_port_t', p))
  if (blocked.length) {
    const ok = ports.filter((p) => !blocked.includes(p))
    const msgs = blocked.map((p) => `error: Bind to port ${p} on 0.0.0.0 failed: Permission denied.`)
    if (!ok.length) return `${msgs.join('\n')}\nfatal: Cannot bind any address.`
    for (const m of msgs) sys.journal.push({ time: Date.now(), unit: 'sshd.service', priority: 3, message: m, ident: 'sshd', pid: svc?.pid })
  }
  sys.sshd = { ...r.conf, ports: ports.filter((p) => !blocked.includes(p)) }
  if (svc) svc.ports = sys.sshd.ports
  return undefined
}
SERVICE_CHECKS.sshd = sshdCheck
SERVICE_CHECKS.ssh = sshdCheck

export { connect as sshConnect }
