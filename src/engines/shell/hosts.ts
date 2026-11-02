/**
 * La red del ejercicio: varios servidores simulados que se ven entre sí. Incluye las claves SSH
 * (de usuario y de servidor), known_hosts, la configuración efectiva de sshd y el filtrado de
 * conexiones entrantes de firewalld y ufw.
 */
import type { System } from './system'
import { ROOT_CRED, type Cred } from './vfs'
import { SSHD_KEYWORDS } from '../config/sshd'

// ---------------------------------------------------------------------------------------
// Claves
// ---------------------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Texto que parece aleatorio pero sale siempre igual para la misma semilla (alfabeto base64). */
export function fakeB64(seed: string, len: number): string {
  let h1 = 0x811c9dc5
  let h2 = 0x1234567
  for (const c of seed) {
    h1 = Math.imul(h1 ^ c.charCodeAt(0), 16777619) >>> 0
    h2 = Math.imul(h2 + c.charCodeAt(0), 2654435761) >>> 0
  }
  let out = ''
  for (let i = 0; i < len; i++) {
    h1 = Math.imul(h1 ^ (h1 >>> 15), 2246822507) >>> 0
    h1 = (h1 + h2 + i) >>> 0
    h2 = Math.imul(h2 ^ (h2 >>> 13), 3266489909) >>> 0
    out += B64[(h1 ^ h2) & 63]
  }
  return out
}

export type KeyType = 'ed25519' | 'rsa' | 'ecdsa'

export const KEY_TYPES: Record<KeyType, { algo: string; head: string; len: number; label: string; bits: number }> = {
  ed25519: { algo: 'ssh-ed25519', head: 'AAAAC3NzaC1lZDI1NTE5AAAAI', len: 43, label: 'ED25519', bits: 256 },
  rsa: { algo: 'ssh-rsa', head: 'AAAAB3NzaC1yc2EAAAADAQABAAABgQ', len: 514, label: 'RSA', bits: 3072 },
  ecdsa: { algo: 'ecdsa-sha2-nistp256', head: 'AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBB', len: 87, label: 'ECDSA', bits: 256 },
}

const PRIV_PLAIN = 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW'
const PRIV_ENC = 'b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABD'

export interface KeyPair {
  type: KeyType
  /** Línea del archivo .pub: "ssh-ed25519 AAAA... comentario". */
  pub: string
  priv: string
  fingerprint: string
}

/** Una clave nueva. Como en las de verdad, el archivo privado contiene la parte pública. */
export function makeKey(type: KeyType, seed: string, comment: string, encrypted = false): KeyPair {
  const t = KEY_TYPES[type]
  const body = t.head + fakeB64(`${type}:${seed}`, t.len)
  const pub = `${t.algo} ${body}${comment ? ` ${comment}` : ''}`
  const inner = (encrypted ? PRIV_ENC : PRIV_PLAIN) + fakeB64(`priv:${seed}`, 40) + body + fakeB64(`tail:${seed}`, type === 'rsa' ? 1200 : 120)
  const lines = inner.match(/.{1,70}/g) ?? []
  const priv = `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`
  return { type, pub, priv, fingerprint: fingerprintOf(body) }
}

export function fingerprintOf(body: string): string {
  return `SHA256:${fakeB64(`fp:${body}`, 43)}`
}

/** Tipo y cuerpo (el base64) de una línea de clave pública. */
export function parsePub(line: string): { type: KeyType; body: string; comment: string } | undefined {
  const m = /^\s*(?:\S+\s+)??(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256)\s+(\S+)\s*(.*)$/.exec(line)
  if (!m) return undefined
  const type = (Object.keys(KEY_TYPES) as KeyType[]).find((k) => KEY_TYPES[k].algo === m[1])!
  return { type, body: m[2], comment: m[3].trim() }
}

/** De un archivo privado: la parte pública, el tipo y si tiene frase de paso. */
export function readPrivate(text: string): { type: KeyType; body: string; encrypted: boolean } | undefined {
  if (!text.includes('-----BEGIN OPENSSH PRIVATE KEY-----')) return undefined
  const joined = text.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  for (const type of Object.keys(KEY_TYPES) as KeyType[]) {
    const t = KEY_TYPES[type]
    const i = joined.indexOf(t.head)
    if (i >= 0) return { type, body: joined.slice(i, i + t.head.length + t.len), encrypted: joined.startsWith(PRIV_ENC) }
  }
  return undefined
}

/** El dibujo "randomart" que muestra ssh-keygen al crear una clave. */
export function randomArt(type: KeyType, fingerprint: string): string {
  const w = 17
  const h = 9
  const grid = Array.from({ length: h }, () => Array<number>(w).fill(0))
  let x = 8
  let y = 4
  for (const c of fingerprint.slice(7)) {
    let v = B64.indexOf(c)
    for (let k = 0; k < 3; k++) {
      x = Math.max(0, Math.min(w - 1, x + (v & 1 ? 1 : -1)))
      y = Math.max(0, Math.min(h - 1, y + (v & 2 ? 1 : -1)))
      grid[y][x]++
      v >>= 2
    }
  }
  const sym = ' .o+=*BOX@%&#/^'
  grid[4][8] = -1
  grid[y][x] = -2
  const title = `[${KEY_TYPES[type].label} ${KEY_TYPES[type].bits}]`
  const top = `+${title.padStart(Math.floor((w + title.length) / 2), '-').padEnd(w, '-')}+`
  const rows = grid.map((r) => `|${r.map((n) => (n === -1 ? 'S' : n === -2 ? 'E' : sym[Math.min(n, sym.length - 1)])).join('')}|`)
  return [top, ...rows, `+${'[SHA256]'.padStart(12, '-').padEnd(w, '-')}+`].join('\n')
}

// ---------------------------------------------------------------------------------------
// Archivos de SSH de cada servidor
// ---------------------------------------------------------------------------------------

/** Las claves del servidor (las que se guardan en known_hosts de quien se conecta). */
export function hostKey(sys: System, type: KeyType = 'ed25519', variant = ''): KeyPair {
  return makeKey(type, `host:${sys.hostname}:${sys.distro}${variant}`, `root@${sys.hostname}`)
}

const SSHD_ROCKY = `#	$OpenBSD: sshd_config,v 1.104 2021/07/02 05:11:21 dtucker Exp $

# This is the sshd server system-wide configuration file.  See
# sshd_config(5) for more information.

# To modify the system-wide sshd configuration, create a  *.conf  file under
#  /etc/ssh/sshd_config.d/  which will be automatically included below
Include /etc/ssh/sshd_config.d/*.conf

# If you want to change the port on a SELinux system, you have to tell
# SELinux about this change.
# semanage port -a -t ssh_port_t -p tcp #PORTNUMBER
#
#Port 22
#AddressFamily any
#ListenAddress 0.0.0.0
#ListenAddress ::

#HostKey /etc/ssh/ssh_host_rsa_key
#HostKey /etc/ssh/ssh_host_ecdsa_key
#HostKey /etc/ssh/ssh_host_ed25519_key

# Logging
#SyslogFacility AUTH
#LogLevel INFO

# Authentication:

#LoginGraceTime 2m
#PermitRootLogin prohibit-password
#StrictModes yes
#MaxAuthTries 6
#MaxSessions 10

#PubkeyAuthentication yes

# The default is to check both .ssh/authorized_keys and .ssh/authorized_keys2
# but this is overridden so installations will only check .ssh/authorized_keys
AuthorizedKeysFile	.ssh/authorized_keys

# To disable tunneled clear text passwords, change to no here!
#PasswordAuthentication yes
#PermitEmptyPasswords no

# Change to no to disable s/key passwords
#KbdInteractiveAuthentication yes

#AllowAgentForwarding yes
#AllowTcpForwarding yes
#GatewayPorts no
#X11Forwarding no
#PrintMotd yes
#PrintLastLog yes
#TCPKeepAlive yes
#ClientAliveInterval 0
#ClientAliveCountMax 3
#UseDNS no
#PidFile /var/run/sshd.pid
#MaxStartups 10:30:100

# override default of no subsystems
Subsystem	sftp	/usr/libexec/openssh/sftp-server

# Example of overriding settings on a per-user basis
#Match User anoncvs
#	X11Forwarding no
#	AllowTcpForwarding no
#	PermitTTY no
#	ForceCommand cvs server
`

const SSHD_REDHAT = `# This system is following system-wide crypto policy. The changes to
# crypto properties (Ciphers, MACs, ...) will not have any effect in
# this or following included files. To override some configuration option,
# write it before this block or include it before this file.
# Please, see manual pages for update-crypto-policies(8) and sshd_config(5).
Include /etc/crypto-policies/back-ends/opensshserver.config

SyslogFacility AUTHPRIV

ChallengeResponseAuthentication no

GSSAPIAuthentication yes
GSSAPICleanupCredentials no

UsePAM yes

X11Forwarding yes

# It is recommended to use pam_motd in /etc/pam.d/sshd instead of PrintMotd,
# as it is more configurable and versatile than the built-in version.
PrintMotd no
`

const SSHD_UBUNTU = `
# This is the sshd server system-wide configuration file.  See
# sshd_config(5) for more information.

# This sshd was compiled with PATH=/usr/local/bin:/usr/bin:/bin:/usr/games

# The strategy used for options in the default sshd_config shipped with
# OpenSSH is to specify options with their default value where
# possible, but leave them commented.  Uncommented options override the
# default value.

Include /etc/ssh/sshd_config.d/*.conf

# When systemd socket activation is used (the default), the socket
# configuration must be re-generated after changing Port, AddressFamily, or
# ListenAddress.
#
# For changes to take effect, run:
#
#   systemctl daemon-reload
#   systemctl restart ssh.socket
#
#Port 22
#AddressFamily any
#ListenAddress 0.0.0.0
#ListenAddress ::

#HostKey /etc/ssh/ssh_host_rsa_key
#HostKey /etc/ssh/ssh_host_ecdsa_key
#HostKey /etc/ssh/ssh_host_ed25519_key

# Ciphers and keying
#RekeyLimit default none

# Logging
#SyslogFacility AUTH
#LogLevel INFO

# Authentication:

#LoginGraceTime 2m
#PermitRootLogin prohibit-password
#StrictModes yes
#MaxAuthTries 6
#MaxSessions 10

#PubkeyAuthentication yes

# Expect .ssh/authorized_keys2 to be disregarded by default in future.
#AuthorizedKeysFile	.ssh/authorized_keys .ssh/authorized_keys2

# To disable tunneled clear text passwords, change to no here!
#PasswordAuthentication yes
#PermitEmptyPasswords no

# Change to yes to enable challenge-response passwords (beware issues with
# some PAM modules and threads)
KbdInteractiveAuthentication no

UsePAM yes

#AllowAgentForwarding yes
#AllowTcpForwarding yes
#GatewayPorts no
X11Forwarding yes
#X11DisplayOffset 10
#X11UseLocalhost yes
#PermitTTY yes
PrintMotd no
#PrintLastLog yes
#TCPKeepAlive yes
#PermitUserEnvironment no
#Compression delayed
#ClientAliveInterval 0
#ClientAliveCountMax 3
#UseDNS no
#PidFile /run/sshd.pid
#MaxStartups 10:30:100
#PermitTunnel no
#ChrootDirectory none
#VersionAddendum none

# no default banner path
#Banner none

# Allow client to pass locale environment variables
AcceptEnv LANG LC_* COLORTERM NO_COLOR

# override default of no subsystems
Subsystem	sftp	/usr/lib/openssh/sftp-server
`

const SSH_CONFIG_UBUNTU = `
# This is the ssh client system-wide configuration file.  See
# ssh_config(5) for more information.

Include /etc/ssh/ssh_config.d/*.conf

Host *
#   ForwardAgent no
#   PasswordAuthentication yes
#   IdentityFile ~/.ssh/id_rsa
#   IdentityFile ~/.ssh/id_ed25519
#   Port 22
#   StrictHostKeyChecking ask
    SendEnv LANG LC_* COLORTERM NO_COLOR
    HashKnownHosts yes
    GSSAPIAuthentication yes
`

const SSH_CONFIG_ROCKY = `#	$OpenBSD: ssh_config,v 1.35 2020/07/17 03:43:42 dtucker Exp $

# This is the ssh client system-wide configuration file.  See
# ssh_config(5) for more information.

# Configuration data is parsed as follows:
#  1. command line options
#  2. user-specific file
#  3. system-wide file
# Any configuration value is only changed the first time it is set.

# Host *
#   ForwardAgent no
#   PasswordAuthentication yes
#   IdentityFile ~/.ssh/id_rsa
#   IdentityFile ~/.ssh/id_ed25519
#   Port 22
#   StrictHostKeyChecking ask

Include /etc/ssh/ssh_config.d/*.conf
`

/** /etc/ssh: configuración del cliente y del servidor, y las claves del servidor. */
export function installSshFiles(sys: System) {
  const v = sys.vfs
  v.mkdirp('/etc/ssh/sshd_config.d', ROOT_CRED)
  v.mkdirp('/etc/ssh/ssh_config.d', ROOT_CRED)
  if (sys.distro === 'rocky') {
    v.writeFile('/etc/ssh/sshd_config', SSHD_ROCKY, ROOT_CRED, { mode: 0o600 })
    v.writeFile('/etc/ssh/sshd_config.d/50-redhat.conf', SSHD_REDHAT, ROOT_CRED, { mode: 0o600 })
    v.writeFile('/etc/ssh/ssh_config', SSH_CONFIG_ROCKY, ROOT_CRED, { mode: 0o644 })
    v.writeFile('/etc/ssh/ssh_config.d/50-redhat.conf', '# The options here are in the "Match final block" to be applied as the last\n# options and could be potentially overwritten by the user configuration\nMatch final all\n\tInclude /etc/crypto-policies/back-ends/openssh.config\n\tGSSAPIAuthentication yes\n\tForwardX11Trusted yes\n\tSendEnv LANG LC_*\n', ROOT_CRED, { mode: 0o644 })
  } else {
    v.writeFile('/etc/ssh/sshd_config', SSHD_UBUNTU, ROOT_CRED, { mode: 0o644 })
    v.writeFile('/etc/ssh/ssh_config', SSH_CONFIG_UBUNTU, ROOT_CRED, { mode: 0o644 })
  }
  for (const type of ['ecdsa', 'ed25519', 'rsa'] as KeyType[]) {
    const k = hostKey(sys, type)
    v.writeFile(`/etc/ssh/ssh_host_${type}_key`, k.priv, ROOT_CRED, { mode: 0o600 })
    v.writeFile(`/etc/ssh/ssh_host_${type}_key.pub`, k.pub + '\n', ROOT_CRED, { mode: 0o644 })
  }
  const conf = readSshdConfig(sys)
  sys.sshd = conf.conf
  sys.sshSocketPorts = conf.conf.ports
}

// ---------------------------------------------------------------------------------------
// Configuración efectiva de sshd
// ---------------------------------------------------------------------------------------

export interface SshdConf {
  ports: number[]
  permitRootLogin: string
  pubkey: boolean
  password: boolean
  kbdInteractive: boolean
  gssapi: boolean
  allowUsers: string[]
  allowGroups: string[]
  denyUsers: string[]
  denyGroups: string[]
  authorizedKeysFiles: string[]
  strictModes: boolean
  maxAuthTries: number
  banner?: string
}

/** Lee sshd_config como sshd: con Include en su lugar y la PRIMERA aparición de cada opción. */
export function readSshdConfig(sys: System): { conf: SshdConf; errors: string[] } {
  const errors: string[] = []
  const seen = new Map<string, string>()
  const lists: Record<string, string[]> = { port: [], allowusers: [], allowgroups: [], denyusers: [], denygroups: [] }
  const visit = (path: string, depth: number) => {
    let text: string
    try {
      text = sys.vfs.readFile(path, ROOT_CRED)
    } catch {
      if (depth === 0) errors.push(`${path}: No such file or directory`)
      return
    }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].replace(/^\s+/, '')
      if (!t || t.startsWith('#')) continue
      const m = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(t.trimEnd())
      const key = (m ? m[1] : t.trim()).toLowerCase()
      const value = (m ? m[2] : '').replace(/\s+#.*$/, '').trim()
      if (key === 'match') return // lo que sigue es condicional: no cambia los valores generales
      if (!SSHD_KEYWORDS[key]) {
        errors.push(`${path}: line ${i + 1}: Bad configuration option: ${m ? m[1] : t.trim()}`)
        continue
      }
      if (!value) {
        errors.push(`${path} line ${i + 1}: missing argument.`)
        continue
      }
      if (key === 'include') {
        for (const pattern of value.split(/\s+/)) {
          const abs = pattern.startsWith('/') ? pattern : `/etc/ssh/${pattern}`
          const dir = abs.slice(0, abs.lastIndexOf('/'))
          const glob = abs.slice(abs.lastIndexOf('/') + 1)
          if (!glob.includes('*')) {
            if (sys.vfs.exists(abs)) visit(abs, depth + 1)
            continue
          }
          const re = new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
          let names: string[] = []
          try {
            names = sys.vfs.readdir(dir, ROOT_CRED).filter((n) => re.test(n)).sort()
          } catch {
            // sin carpeta
          }
          for (const n of names) visit(`${dir}/${n}`, depth + 1)
        }
        continue
      }
      const kind = SSHD_KEYWORDS[key]
      if (kind === 'yesno' && !/^(yes|no)$/i.test(value)) {
        errors.push(`${path} line ${i + 1}: unsupported option "${value}".`)
        continue
      }
      if (typeof kind === 'object' && !kind.values.some((x) => x.toLowerCase() === value.toLowerCase())) {
        errors.push(`${path} line ${i + 1}: unsupported option "${value}".`)
        continue
      }
      if (key === 'port' && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)) {
        errors.push(`${path} line ${i + 1}: Badly formatted port number.`)
        continue
      }
      if (key in lists) {
        lists[key].push(...value.split(/\s+/))
        continue
      }
      if (!seen.has(key)) seen.set(key, value)
    }
  }
  visit('/etc/ssh/sshd_config', 0)
  const yes = (k: string, def: boolean) => (seen.has(k) ? seen.get(k)!.toLowerCase() === 'yes' : def)
  const conf: SshdConf = {
    ports: lists.port.length ? [...new Set(lists.port.map(Number))] : [22],
    permitRootLogin: (seen.get('permitrootlogin') ?? 'prohibit-password').toLowerCase().replace('without-password', 'prohibit-password'),
    pubkey: yes('pubkeyauthentication', true),
    password: yes('passwordauthentication', true),
    kbdInteractive: yes('kbdinteractiveauthentication', yes('challengeresponseauthentication', true)),
    gssapi: yes('gssapiauthentication', false),
    allowUsers: lists.allowusers,
    allowGroups: lists.allowgroups,
    denyUsers: lists.denyusers,
    denyGroups: lists.denygroups,
    authorizedKeysFiles: (seen.get('authorizedkeysfile') ?? '.ssh/authorized_keys .ssh/authorized_keys2').split(/\s+/),
    strictModes: yes('strictmodes', true),
    maxAuthTries: Number(seen.get('maxauthtries') ?? 6),
    banner: seen.get('banner') && seen.get('banner') !== 'none' ? seen.get('banner') : undefined,
  }
  return { conf, errors }
}

/** Nombre del servicio de SSH en cada distribución. */
export function sshdService(sys: System) {
  return sys.services.get(sys.distro === 'rocky' ? 'sshd' : 'ssh')
}

/** Puertos en los que sshd está escuchando ahora (vacío si el servicio no funciona). */
export function sshdPorts(sys: System): number[] {
  if (!sshdService(sys)?.active || !sys.sshd) return []
  // En Ubuntu escucha ssh.socket, que se genera en daemon-reload a partir de sshd_config.
  return sys.distro === 'ubuntu' ? sys.sshSocketPorts : sys.sshd.ports
}

// ---------------------------------------------------------------------------------------
// Red: nombres, rutas y firewall
// ---------------------------------------------------------------------------------------

function ipNum(ip: string): number {
  return ip.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0
}

export function inSubnet(ip: string, cidr: string): boolean {
  const [net, bits = '32'] = cidr.split('/')
  const mask = Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0
  return ((ipNum(ip) & mask) >>> 0) === ((ipNum(net) & mask) >>> 0)
}

/** Si desde este servidor se llega a esa IP (misma red, o declarada alcanzable). */
export function routeTo(from: System, ip: string): boolean {
  if (from.ownIps().includes(ip)) return true
  if (from.interfaces.some((i) => i.up && i.ip && inSubnet(ip, i.ip))) return true
  return from.reachable.has(ip)
}

/** El servidor de la red que tiene esa IP (si dos la comparten, el que respondió el último ARP). */
export function hostByIp(from: System, ip: string): System | undefined {
  if (from.ownIps().includes(ip)) return from
  const owners = from.lab.filter((h) => h.ownIps().includes(ip))
  if (owners.length > 1) {
    const mac = from.neigh.get(ip)?.mac
    return owners.find((h) => h.interfaces.some((i) => i.mac === mac)) ?? owners[0]
  }
  return owners[0]
}

/** MAC de la interfaz de un servidor que tiene esa IP. */
export function macOf(h: System, ip: string): string | undefined {
  return h.interfaces.find((i) => i.ip?.split('/')[0] === ip)?.mac
}

const GATEWAY_MAC = '52:54:00:12:35:02'
const arpTurn = new WeakMap<System, number>()

/**
 * Resolución ARP antes de hablar con una IP: si está en una red conectada, aprende su MAC (o
 * la de la puerta de enlace, si está afuera). Con una IP duplicada, cada vez puede contestar
 * un equipo distinto: por eso las fallas por IP duplicada son intermitentes.
 */
export function learnNeighbor(from: System, ip: string) {
  if (from.ownIps().includes(ip) || ip.startsWith('127.')) return
  const iface = from.interfaces.find((i) => i.up && i.ip && inSubnet(ip, i.ip))
  if (!iface) {
    const gw = from.gateway
    if (gw && gw !== ip && from.interfaces.some((i) => i.up && i.ip && inSubnet(gw, i.ip))) learnNeighbor(from, gw)
    return
  }
  const owners = from.lab.filter((h) => h.ownIps().includes(ip))
  if (owners.length) {
    const turn = arpTurn.get(from) ?? 0
    arpTurn.set(from, turn + 1)
    const h = owners[turn % owners.length]
    from.neigh.set(ip, { mac: macOf(h, ip)!, dev: iface.name, state: 'REACHABLE' })
    return
  }
  if (ip === from.gateway || from.isReachable(ip)) {
    from.neigh.set(ip, { mac: ip === from.gateway ? GATEWAY_MAC : `52:54:00:${ip.split('.').slice(1).map((o) => Number(o).toString(16).padStart(2, '0')).join(':')}`, dev: iface.name, state: 'REACHABLE' })
    return
  }
  from.neigh.set(ip, { mac: '', dev: iface.name, state: 'FAILED' })
}

export const FW_SERVICES: Record<string, string> = { ssh: '22/tcp', http: '80/tcp', https: '443/tcp', 'dhcpv6-client': '546/udp', cockpit: '9090/tcp', dns: '53/udp', mysql: '3306/tcp', postgresql: '5432/tcp', samba: '445/tcp', nfs: '2049/tcp', ntp: '123/udp', smtp: '25/tcp', ftp: '21/tcp' }

const UFW_APPS: Record<string, string[]> = { openssh: ['22/tcp'], 'nginx full': ['80/tcp', '443/tcp'], 'nginx http': ['80/tcp'], 'nginx https': ['443/tcp'], 'apache full': ['80/tcp', '443/tcp'], apache: ['80/tcp'] }

function ufwMatches(target: string, port: number, proto: string, src: string): boolean {
  const t = target.trim().toLowerCase()
  const app = UFW_APPS[t]
  if (app) return app.includes(`${port}/${proto}`)
  const simple = /^(\d+)(?::(\d+))?(?:\/(tcp|udp))?$/.exec(t)
  if (simple) {
    const lo = Number(simple[1])
    const hi = Number(simple[2] ?? simple[1])
    return port >= lo && port <= hi && (!simple[3] || simple[3] === proto)
  }
  const full = /^(?:proto (tcp|udp) )?from (\S+)(?: to any)?(?: port (\d+))?(?: proto (tcp|udp))?$/.exec(t)
  if (full) {
    const p = full[1] ?? full[4]
    const okSrc = full[2] === 'any' || inSubnet(src, full[2].includes('/') ? full[2] : `${full[2]}/32`)
    return okSrc && (!full[3] || Number(full[3]) === port) && (!p || p === proto)
  }
  return false
}

/**
 * Qué hace el firewall del servidor con una conexión entrante: la deja pasar, la rechaza
 * (firewalld responde "prohibido": el cliente ve "No route to host") o la descarta en silencio
 * (ufw: el cliente espera hasta "Connection timed out").
 */
export function inbound(target: System, port: number, proto: 'tcp' | 'udp', src: string): 'ok' | 'reject' | 'drop' {
  if (target.services.get('firewalld')?.active) {
    const fw = target.firewall
    const open = [...fw.services].some((s) => FW_SERVICES[s] === `${port}/${proto}`) || [...fw.ports].some((p) => {
      const m = /^(\d+)(?:-(\d+))?\/(tcp|udp)$/.exec(p)
      return !!m && m[3] === proto && port >= Number(m[1]) && port <= Number(m[2] ?? m[1])
    })
    return open ? 'ok' : 'reject'
  }
  if (target.ufw.active) {
    for (const r of target.ufw.rules) if (ufwMatches(r.target, port, proto, src)) return r.action === 'allow' ? 'ok' : 'drop'
    return 'drop'
  }
  return 'ok'
}

/** La IP con la que este servidor sale hacia otra (la de la interfaz en la misma red). */
export function sourceIp(from: System, to: string): string {
  const i = from.interfaces.find((x) => x.up && x.ip && inSubnet(to, x.ip))
  return (i ?? from.interfaces.find((x) => x.up && x.ip))?.ip?.split('/')[0] ?? '127.0.0.1'
}

// ---------------------------------------------------------------------------------------
// known_hosts
// ---------------------------------------------------------------------------------------

export function hashedHost(name: string, salt: string): string {
  return `|1|${salt}|${fakeB64(`kh:${salt}:${name}`, 27)}=`
}

/** Cómo aparece un servidor en known_hosts: "nombre" o "[nombre]:puerto". */
export function hostTag(name: string, port: number): string {
  return port === 22 ? name : `[${name}]:${port}`
}

function entryMatches(field: string, tag: string): boolean {
  if (field.startsWith('|1|')) {
    const salt = field.split('|')[2]
    return hashedHost(tag, salt) === field
  }
  return field.split(',').includes(tag)
}

export interface KnownLookup {
  status: 'unknown' | 'match' | 'mismatch'
  line?: number
}

export function lookupKnown(text: string, tags: string[], hostKeyBody: string): KnownLookup {
  const lines = text.split('\n')
  let mismatch: number | undefined
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim()
    if (!l || l.startsWith('#')) continue
    const [field, , body] = l.split(/\s+/)
    if (!tags.some((t) => entryMatches(field, t))) continue
    if (body === hostKeyBody) return { status: 'match', line: i + 1 }
    mismatch ??= i + 1
  }
  return mismatch ? { status: 'mismatch', line: mismatch } : { status: 'unknown' }
}

/** Línea nueva para known_hosts (Ubuntu guarda los nombres cifrados: HashKnownHosts yes). */
export function knownLine(client: System, tag: string, key: KeyPair): string {
  const [algo, body] = key.pub.split(' ')
  if (client.distro === 'ubuntu') return `${hashedHost(tag, fakeB64(`salt:${tag}:${body}`, 27) + '=')} ${algo} ${body}`
  return `${tag} ${algo} ${body}`
}

export function removeKnown(text: string, tag: string): { text: string; removed: number[] } {
  const removed: number[] = []
  const kept = text.split('\n').filter((l, i) => {
    const field = l.trim().split(/\s+/)[0]
    if (field && !l.trim().startsWith('#') && entryMatches(field, tag)) {
      removed.push(i + 1)
      return false
    }
    return true
  })
  return { text: kept.join('\n'), removed }
}

// ---------------------------------------------------------------------------------------
// ~/.ssh/config del cliente
// ---------------------------------------------------------------------------------------

export interface ClientOpts {
  hostname?: string
  user?: string
  port?: number
  identityFiles: string[]
  proxyJump?: string
  strictHostKeyChecking?: string
  batchMode?: boolean
}

function globMatch(pattern: string, name: string): boolean {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
  return re.test(name)
}

/** Opciones de ~/.ssh/config para un nombre (la primera que aparece gana, como en ssh). */
export function clientConfig(sys: System, cred: Cred, home: string, alias: string): ClientOpts {
  const out: ClientOpts = { identityFiles: [] }
  let text: string
  try {
    text = sys.vfs.readFile(`${home}/.ssh/config`, cred)
  } catch {
    return out
  }
  let active = true
  for (const raw of text.split('\n')) {
    const t = raw.trim()
    if (!t || t.startsWith('#')) continue
    const m = /^(\S+?)(?:\s*=\s*|\s+)(.+)$/.exec(t)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim().replace(/^"|"$/g, '')
    if (key === 'host') {
      const pats = value.split(/\s+/)
      active = pats.some((p) => !p.startsWith('!') && globMatch(p, alias)) && !pats.some((p) => p.startsWith('!') && globMatch(p.slice(1), alias))
      continue
    }
    if (key === 'match') {
      active = /^all$/i.test(value)
      continue
    }
    if (!active) continue
    if (key === 'hostname') out.hostname ??= value.replace(/%h/g, alias)
    else if (key === 'user') out.user ??= value
    else if (key === 'port') out.port ??= Number(value)
    else if (key === 'identityfile') out.identityFiles.push(value.replace(/^~/, home))
    else if (key === 'proxyjump') out.proxyJump ??= value
    else if (key === 'stricthostkeychecking') out.strictHostKeyChecking ??= value.toLowerCase()
    else if (key === 'batchmode') out.batchMode ??= value.toLowerCase() === 'yes'
  }
  return out
}

// ---------------------------------------------------------------------------------------
// StrictModes: permisos que sshd exige en la cuenta del usuario
// ---------------------------------------------------------------------------------------

/** Si los permisos de home, ~/.ssh y authorized_keys permiten usar la clave; si no, el motivo. */
export function strictModesProblem(sys: System, user: string, file: string): string | undefined {
  const u = sys.users.get(user)
  if (!u) return undefined
  const check = (path: string, isDir: boolean) => {
    let st
    try {
      st = sys.vfs.stat(path, ROOT_CRED)
    } catch {
      return undefined
    }
    if (st.uid !== u.uid && st.uid !== 0) return `Authentication refused: bad ownership or modes for ${isDir ? 'directory' : 'file'} ${path}`
    if (st.mode & 0o022) return `Authentication refused: bad ownership or modes for ${isDir ? 'directory' : 'file'} ${path}`
    return undefined
  }
  return check(file, false) ?? check(file.slice(0, file.lastIndexOf('/')), true) ?? check(u.home, true)
}
