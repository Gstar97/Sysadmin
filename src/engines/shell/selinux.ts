/**
 * SELinux en el Rocky simulado (política targeted): etiquetas de archivos por ruta, reglas
 * locales de semanage, tipos de puertos, booleanos y registro de denegaciones (AVC).
 * Ubuntu usa AppArmor: acá solo se guarda su estado básico.
 */
import type { Inode } from './vfs'
import { ROOT_CRED } from './vfs'
import type { System } from './system'

export type SeMode = 'enforcing' | 'permissive' | 'disabled'

export interface SelinuxState {
  mode: SeMode
  /** Reglas agregadas con semanage fcontext -a (las locales ganan a las de la política). */
  localRules: { regex: string; type: string }[]
  /** Puertos agregados con semanage port -a: "tcp/8090" → tipo. */
  localPorts: Map<string, string>
  booleans: Map<string, { cur: boolean; def: boolean; desc: string }>
  /** Número de secuencia de los registros de auditoría. */
  serial: number
}

/** Reglas de la política (las más específicas primero). */
const POLICY: [string, string][] = [
  ['/home/[^/]+/\\.ssh(/.*)?', 'ssh_home_t'],
  ['/root/\\.ssh(/.*)?', 'ssh_home_t'],
  ['/home/[^/]+/public_html(/.*)?', 'httpd_user_content_t'],
  ['/home/[^/]+', 'user_home_dir_t'],
  ['/home/[^/]+/.+', 'user_home_t'],
  ['/home', 'home_root_t'],
  ['/root(/.*)?', 'admin_home_t'],
  ['/var/www/cgi-bin(/.*)?', 'httpd_sys_script_exec_t'],
  ['/var/www(/.*)?', 'httpd_sys_content_t'],
  ['/usr/share/nginx/html(/.*)?', 'httpd_sys_content_t'],
  ['/srv/([^/]*/)?www(/.*)?', 'httpd_sys_content_t'],
  ['/var/log/nginx(/.*)?', 'httpd_log_t'],
  ['/var/log/httpd(/.*)?', 'httpd_log_t'],
  ['/var/log/audit(/.*)?', 'auditd_log_t'],
  ['/var/log(/.*)?', 'var_log_t'],
  ['/var/lib/mysql(/.*)?', 'mysqld_db_t'],
  ['/var/lib/pgsql(/.*)?', 'postgresql_db_t'],
  ['/var/lib/nginx(/.*)?', 'httpd_var_lib_t'],
  ['/var/spool/cron(/.*)?', 'user_cron_spool_t'],
  ['/var/tmp(/.*)?', 'tmp_t'],
  ['/var(/.*)?', 'var_t'],
  ['/srv(/.*)?', 'var_t'],
  ['/etc/shadow.*', 'shadow_t'],
  ['/etc/ssh/ssh_host_.*_key', 'sshd_key_t'],
  ['/etc/nginx(/.*)?', 'httpd_config_t'],
  ['/etc/httpd(/.*)?', 'httpd_config_t'],
  ['/etc/selinux(/.*)?', 'selinux_config_t'],
  ['/etc(/.*)?', 'etc_t'],
  ['/tmp', 'tmp_t'],
  ['/tmp/.+', 'user_tmp_t'],
  ['/usr/sbin/sshd', 'sshd_exec_t'],
  ['/usr/sbin/nginx', 'httpd_exec_t'],
  ['/usr/s?bin(/.*)?', 'bin_t'],
  ['/usr/local/s?bin(/.*)?', 'bin_t'],
  ['/usr(/.*)?', 'usr_t'],
  ['/opt(/.*)?', 'usr_t'],
  ['/boot(/.*)?', 'boot_t'],
  ['/mnt(/.*)?', 'mnt_t'],
  ['/dev(/.*)?', 'device_t'],
  ['/proc(/.*)?', 'proc_t'],
  ['/sys(/.*)?', 'sysfs_t'],
  ['/run(/.*)?', 'var_run_t'],
  ['/', 'root_t'],
]

/** Puertos que ya trae la política (los más usados). */
export const POLICY_PORTS: [string, string, string][] = [
  ['ssh_port_t', 'tcp', '22'],
  ['http_port_t', 'tcp', '80, 81, 443, 488, 8008, 8009, 8443, 9000'],
  ['http_cache_port_t', 'tcp', '8080, 8118, 8123, 10001-10010'],
  ['mysqld_port_t', 'tcp', '1186, 3306, 63132-63164'],
  ['postgresql_port_t', 'tcp', '5432, 9898'],
  ['dns_port_t', 'tcp', '53, 853'],
  ['ntp_port_t', 'udp', '123'],
  ['smtp_port_t', 'tcp', '25, 465, 587'],
  ['websm_port_t', 'tcp', '9090'],
]

const BOOLEANS: [string, boolean, string][] = [
  ['httpd_can_network_connect', false, 'Allow HTTPD scripts and modules to connect to the network using TCP.'],
  ['httpd_can_network_connect_db', false, 'Allow HTTPD scripts and modules to connect to databases over the network.'],
  ['httpd_enable_homedirs', false, 'Allow httpd to read home directories'],
  ['httpd_read_user_content', false, 'Allow httpd to read user content'],
  ['httpd_use_nfs', false, 'Allow httpd to access nfs file systems'],
  ['ssh_sysadm_login', false, 'Allow ssh logins as sysadm_r:sysadm_t'],
  ['samba_enable_home_dirs', false, 'Allow samba to share users home directories.'],
  ['ftpd_full_access', false, 'Allow ftpd to full access'],
  ['use_nfs_home_dirs', false, 'Support NFS home directories'],
  ['nis_enabled', false, 'Allow system to run with NIS'],
]

export function newSelinux(): SelinuxState {
  return {
    mode: 'enforcing',
    localRules: [],
    localPorts: new Map(),
    booleans: new Map(BOOLEANS.map(([n, d, desc]) => [n, { cur: d, def: d, desc }])),
    serial: 1200,
  }
}

function matchRule(regex: string, path: string): boolean {
  try {
    return new RegExp(`^(?:${regex})$`).test(path)
  } catch {
    return false
  }
}

/** Tipo que la política (más las reglas locales) asigna a una ruta. */
export function policyType(sys: System, path: string): string {
  const se = sys.selinux
  for (const r of [...se.localRules].reverse()) if (matchRule(r.regex, path)) return r.type
  for (const [re, t] of POLICY) if (matchRule(re, path)) return t
  return 'default_t'
}

function defaultContext(sys: System, path: string): string {
  const user = /^\/(home|tmp)\//.test(path) ? 'unconfined_u' : 'system_u'
  return `${user}:object_r:${policyType(sys, path)}:s0`
}

/** Contexto completo de un archivo (el que muestra ls -Z). */
export function contextOf(sys: System, path: string, node?: Inode): string {
  const n = node ?? (sys.vfs.exists(path, ROOT_CRED, false) ? sys.vfs.stat(path, ROOT_CRED, false) : undefined)
  if (n?.selabel) return n.selabel
  return defaultContext(sys, path)
}

export function typeOf(ctx: string): string {
  return ctx.split(':')[2] ?? ctx
}

/** mv conserva la etiqueta: se fija la que tenía antes de cambiar de lugar (también en lo de adentro). */
export function installSelinuxHooks(sys: System) {
  sys.vfs.onRename = (node, from) => {
    const fix = (n: Inode, path: string) => {
      if (!n.selabel) n.selabel = contextOf(sys, path, n)
      if (n.type === 'dir') for (const [name, ino] of n.entries!) fix(sys.vfs.get(ino), `${path}/${name}`)
    }
    if (sys.selinux.mode !== 'disabled') fix(node, from)
  }
}

/** restorecon: vuelve a la etiqueta de la política. Devuelve [antes, después] si cambió. */
export function restore(sys: System, path: string): [string, string] | undefined {
  const node = sys.vfs.stat(path, ROOT_CRED, false)
  const before = contextOf(sys, path, node)
  node.selabel = undefined
  const def = defaultContext(sys, path)
  // restorecon cambia el tipo y conserva el usuario SELinux (salvo con -F).
  const after = `${before.split(':')[0]}:${def.split(':').slice(1).join(':')}`
  if (after !== def) node.selabel = after
  return before === after ? undefined : [before, after]
}

// ---------------------------------------------------------------------------------------
// Puertos
// ---------------------------------------------------------------------------------------

function inList(list: string, port: number): boolean {
  return list.split(/,\s*/).some((x) => {
    const [lo, hi = lo] = x.split('-').map(Number)
    return port >= lo && port <= hi
  })
}

export function portType(sys: System, proto: string, port: number): string {
  const local = sys.selinux.localPorts.get(`${proto}/${port}`)
  if (local) return local
  for (const [t, p, list] of POLICY_PORTS) if (p === proto && inList(list, port)) return t
  return port < 1024 ? 'reserved_port_t' : 'unreserved_port_t'
}

/** Qué puertos puede usar cada servicio confinado. */
const BINDS: Record<string, string[]> = {
  ssh_port_t: ['ssh_port_t'],
  http_port_t: ['http_port_t', 'http_cache_port_t'],
}

export function portAllowed(sys: System, wanted: string, port: number): boolean {
  if (sys.distro !== 'rocky' || sys.selinux.mode === 'disabled') return true
  const t = portType(sys, 'tcp', port)
  const ok = (BINDS[wanted] ?? [wanted]).includes(t)
  if (!ok) {
    const comm = wanted === 'ssh_port_t' ? 'sshd' : 'nginx'
    const dom = wanted === 'ssh_port_t' ? 'sshd_t' : 'httpd_t'
    avc(sys, comm, 'name_bind', `src=${port}`, dom, `system_u:object_r:${t}:s0`, 'tcp_socket')
    return sys.selinux.mode === 'permissive'
  }
  return true
}

// ---------------------------------------------------------------------------------------
// Acceso de los servicios a los archivos
// ---------------------------------------------------------------------------------------

const HTTPD_READ = ['httpd_sys_content_t', 'httpd_sys_rw_content_t', 'httpd_sys_script_exec_t', 'public_content_t', 'public_content_rw_t', 'httpd_user_content_t', 'httpd_config_t', 'usr_t', 'etc_t']

/** Si el servidor web (httpd_t) puede leer el archivo; registra la denegación si no. */
export function httpdCanRead(sys: System, path: string, comm = 'nginx'): boolean {
  if (sys.distro !== 'rocky' || sys.selinux.mode === 'disabled') return true
  const t = typeOf(contextOf(sys, path))
  const b = sys.selinux.booleans
  const ok = HTTPD_READ.includes(t) || (t === 'user_home_t' && b.get('httpd_read_user_content')!.cur) || (['user_home_dir_t', 'home_root_t'].includes(t) && b.get('httpd_enable_homedirs')!.cur)
  if (ok) return true
  const name = path.split('/').pop() ?? path
  const ino = sys.vfs.exists(path) ? sys.vfs.stat(path, ROOT_CRED).ino : 0
  avc(sys, comm, sys.vfs.exists(path) && sys.vfs.stat(path, ROOT_CRED).type === 'dir' ? 'search' : 'read', `name="${name}" dev="dm-0" ino=${ino}`, 'httpd_t', contextOf(sys, path), sys.vfs.exists(path) && sys.vfs.stat(path, ROOT_CRED).type === 'dir' ? 'dir' : 'file')
  return sys.selinux.mode === 'permissive'
}

export interface AvcRecord {
  time: number
  serial: number
  text: string
  comm: string
  tcontext: string
  perm: string
}

/** Registra una denegación como lo hace el kernel en /var/log/audit/audit.log. */
export function avc(sys: System, comm: string, perm: string, extra: string, domain: string, tcontext: string, tclass: string) {
  const se = sys.selinux
  const time = Date.now()
  se.serial++
  const pid = sys.procs.find((p) => (p.comm ?? '').startsWith(comm))?.pid ?? sys.allocPid()
  const stamp = `${(time / 1000).toFixed(3)}:${se.serial}`
  const text = `type=AVC msg=audit(${stamp}): avc:  denied  { ${perm} } for  pid=${pid} comm="${comm}" ${extra} scontext=system_u:system_r:${domain}:s0 tcontext=${tcontext} tclass=${tclass} permissive=${se.mode === 'permissive' ? 1 : 0}`
  sys.avcLog.push({ time, serial: se.serial, text, comm, tcontext, perm })
  try {
    sys.vfs.mkdirp('/var/log/audit', ROOT_CRED, 0o700)
    sys.vfs.writeFile('/var/log/audit/audit.log', text + '\n', ROOT_CRED, { append: true, mode: 0o600 })
  } catch {
    // sin registro
  }
  sys.journal.push({ time, unit: 'kernel', priority: 5, message: `audit: ${text.replace(/^type=AVC msg=audit\(([^)]+)\): /, 'type=1400 audit($1): ')}`, ident: 'kernel', pid: 0 })
}

/** Dominio de cada proceso (lo que muestra ps -Z). */
export function processDomain(comm: string, user: string): string {
  const map: Record<string, string> = { systemd: 'init_t', nginx: 'httpd_t', httpd: 'httpd_t', sshd: 'sshd_t', 'sshd-session': 'sshd_t', chronyd: 'chronyd_t', crond: 'crond_t', firewalld: 'firewalld_t', rsyslogd: 'syslogd_t', 'systemd-journal': 'syslogd_t', 'systemd-journald': 'syslogd_t', mariadbd: 'mysqld_t', postgres: 'postgresql_t', auditd: 'auditd_t', 'systemd-logind': 'systemd_logind_t', 'systemd-udevd': 'udev_t', NetworkManager: 'NetworkManager_t' }
  if (map[comm]) return `system_u:system_r:${map[comm]}:s0`
  if (user !== 'root' || ['bash', '-bash', 'sudo', 'ps', 'top'].includes(comm)) return 'unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023'
  return 'system_u:system_r:unconfined_service_t:s0'
}
