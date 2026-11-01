import type { BashState } from './schema'
import { builtinTimers, daemonReload, type Timer, type UnitDef } from './units'
import { cpuinfoText } from './hardware'
import { BASE_INSTALLED, ROCKY_PACKAGES, UBUNTU_PACKAGES, type PackageInfo } from './packages'
import { normalizePath, ROOT_CRED, VFS, type Cred } from './vfs'

export interface User {
  name: string
  uid: number
  gid: number
  home: string
  shell: string
  gecos: string
  locked: boolean
  hasPassword: boolean
  maxDays: number
  minDays: number
  warnDays: number
  expire: string
  lastChange: number
}

export interface Group {
  name: string
  gid: number
  members: string[]
}

export interface Service {
  name: string
  description: string
  active: boolean
  enabled: boolean
  failed: boolean
  failMessage?: string
  ports: number[]
  pkg?: string
  since: number
  pid?: number
  masked?: boolean
  /** Definición leída de los archivos de unidad (se actualiza con daemon-reload). */
  unit?: UnitDef
  /** Cómo estaban los archivos de la unidad al cargarla, para avisar si cambiaron. */
  loadedSig?: string
  /** Última ejecución del proceso principal: PID, código ("0/SUCCESS", "203/EXEC"...) y comando. */
  lastExit?: { pid: number; status: string; cmd: string; time: number }
  /** Resultado de la última activación: success, exit-code, resources... */
  result?: string
}

export interface Proc {
  pid: number
  ppid: number
  user: string
  cmd: string
  /** Nombre corto del proceso (lo que muestran top, pgrep y killall); por defecto, el del ejecutable. */
  comm?: string
  cpu: number
  mem: number
  stat: string
  start: number
}

export function commOf(p: Proc): string {
  return p.comm ?? (p.cmd.split(/\s+/)[0].split('/').pop() ?? '').replace(/:$/, '')
}

/** Proceso principal de cada servicio: línea de comandos, usuario y nombre corto, como en un servidor real. */
function serviceProcess(distro: 'rocky' | 'ubuntu', name: string): { cmd: string; user: string; comm: string } {
  const rocky = distro === 'rocky'
  const table: Record<string, { cmd: string; user?: string; comm: string }> = {
    sshd: { cmd: 'sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups', comm: 'sshd' },
    ssh: { cmd: 'sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups', comm: 'sshd' },
    crond: { cmd: '/usr/sbin/crond -n', comm: 'crond' },
    cron: { cmd: '/usr/sbin/cron -f -P', comm: 'cron' },
    chronyd: { cmd: '/usr/sbin/chronyd -F 2', user: 'chrony', comm: 'chronyd' },
    chrony: { cmd: '/usr/sbin/chronyd -F 1', user: '_chrony', comm: 'chronyd' },
    firewalld: { cmd: '/usr/bin/python3 -s /usr/sbin/firewalld --nofork --nopid', comm: 'firewalld' },
    rsyslog: { cmd: '/usr/sbin/rsyslogd -n -iNONE', user: 'syslog', comm: 'rsyslogd' },
    nginx: { cmd: 'nginx: master process /usr/sbin/nginx', comm: 'nginx' },
    httpd: { cmd: '/usr/sbin/httpd -DFOREGROUND', comm: 'httpd' },
    apache2: { cmd: '/usr/sbin/apache2 -k start', comm: 'apache2' },
    mariadb: { cmd: rocky ? '/usr/libexec/mariadbd --basedir=/usr' : '/usr/sbin/mariadbd', user: 'mysql', comm: 'mariadbd' },
    postgresql: { cmd: rocky ? '/usr/bin/postgres -D /var/lib/pgsql/data' : '/usr/lib/postgresql/16/bin/postgres -D /var/lib/postgresql/16/main', user: 'postgres', comm: 'postgres' },
    named: { cmd: rocky ? '/usr/sbin/named -u named -c /etc/named.conf' : '/usr/sbin/named -f -u bind', user: rocky ? 'named' : 'bind', comm: 'named' },
    smb: { cmd: '/usr/sbin/smbd --foreground --no-process-group', comm: 'smbd' },
    smbd: { cmd: '/usr/sbin/smbd --foreground --no-process-group', comm: 'smbd' },
    'nfs-server': { cmd: '[nfsd]', comm: 'nfsd' },
  }
  const t = table[name] ?? { cmd: `/usr/sbin/${name}`, comm: name }
  return { cmd: t.cmd, user: t.user ?? 'root', comm: t.comm }
}

export interface JournalEntry {
  time: number
  unit: string
  priority: number
  message: string
  ident: string
  pid?: number
}

export interface NetIface {
  name: string
  ip?: string
  mac: string
  up: boolean
}

export interface FirewallState {
  running: boolean
  services: Set<string>
  ports: Set<string>
  permServices: Set<string>
  permPorts: Set<string>
}

export interface UfwState {
  active: boolean
  rules: { action: 'allow' | 'deny'; target: string }[]
}

const PRIORITIES = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug']

export function priorityNumber(name: string): number {
  const n = PRIORITIES.indexOf(name)
  return n < 0 ? 6 : n
}

export function priorityName(n: number): string {
  return PRIORITIES[n] ?? 'info'
}

function macFor(seed: string): string {
  let h = 0
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0
  // 52:54:00 es el prefijo de las placas virtuales de QEMU/KVM, el hipervisor del servidor simulado.
  const bytes = [0x52, 0x54, 0x00, (h >> 16) & 0xff, (h >> 8) & 0xff, h & 0xff]
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(':')
}

/** El servidor simulado: archivos, cuentas, servicios, procesos, paquetes, red y registros. */
export class System {
  vfs = new VFS()
  distro: 'rocky' | 'ubuntu'
  hostname: string
  firmware: 'bios' | 'uefi'
  secureBoot: boolean
  users = new Map<string, User>()
  groups = new Map<string, Group>()
  services = new Map<string, Service>()
  timers = new Map<string, Timer>()
  /** Target con el que arranca el sistema (systemctl get-default). */
  defaultTarget = 'multi-user.target'
  /** Parámetros del kernel configurados para el próximo arranque (grubby, grub2-mkconfig). */
  kernelArgs = ''
  /** Última rotación de cada log (estado de logrotate). */
  logrotateState = new Map<string, number>()
  procs: Proc[] = []
  journal: JournalEntry[] = []
  installed = new Set<string>()
  catalog: Record<string, PackageInfo>
  interfaces: NetIface[] = []
  gateway?: string
  dns: string[] = []
  reachable = new Set<string>()
  dnsRecords: Record<string, string> = {}
  /** Hay salida a internet: cualquier IP pública responde si la puerta de enlace funciona. */
  internet = true
  sites: Record<string, string> = {}
  /** Fallos de inicio de sesión de cada usuario (pam_faillock): fecha y origen. */
  faillock = new Map<string, { when: number; source: string }[]>()
  /** Funciones de authselect activadas (familia Red Hat). */
  authselectFeatures = new Set<string>()
  firewall: FirewallState = {
    running: true,
    services: new Set(['ssh', 'dhcpv6-client', 'cockpit']),
    ports: new Set(),
    permServices: new Set(['ssh', 'dhcpv6-client', 'cockpit']),
    permPorts: new Set(),
  }
  ufw: UfwState = { active: false, rules: [] }
  pkgHistory: { id: number; cmdline: string; date: number; altered: number; action?: 'Install' | 'Removed' | 'Upgrade'; names?: string[] }[] = []
  /** Versión instalada cuando difiere de la del catálogo (después de actualizar). */
  versions = new Map<string, string>()
  /** Paquetes instalados con una actualización pendiente. */
  upgradable = new Set<string>()
  /** Cambios de red pendientes de nmcli (se aplican con "nmcli connection up"). */
  nmPending = new Map<string, { address?: string; gateway?: string; dns?: string[] }>()
  bootTime: number
  private nextPid = 800

  get adminGroup() {
    return this.distro === 'rocky' ? 'wheel' : 'sudo'
  }

  constructor(state: BashState) {
    const now = Date.now()
    this.bootTime = now - 3 * 86_400_000 - 4 * 3_600_000
    this.distro = state.distro
    this.hostname = state.hostname
    this.firmware = state.firmware
    this.secureBoot = state.firmware === 'uefi' && state.secure_boot
    this.catalog = state.distro === 'rocky' ? ROCKY_PACKAGES : UBUNTU_PACKAGES
    this.vfs.now = () => Date.now()

    this.createBaseFilesystem()
    this.createBaseAccounts()

    // Paquetes base y adicionales
    for (const p of BASE_INSTALLED[this.distro]) this.installPackage(p, true)
    for (const p of state.paquetes.instalados) this.installPackage(p, true)
    for (const p of state.paquetes.actualizables) if (this.installed.has(p)) this.upgradable.add(p)
    for (const p of state.paquetes.disponibles) {
      if (!this.catalog[p]) this.catalog[p] = { summary: `${p} package`, version: '1.0' }
    }

    // Usuarios y grupos del ejercicio. El usuario de la sesión se crea primero para que
    // reciba el UID/GID 1000, como pasa en una instalación recién hecha.
    const currentDefined = state.usuarios.some((u) => u.nombre === state.usuario)
    const usuarios = currentDefined || state.usuario === 'root' ? [...state.usuarios] : [{ nombre: state.usuario, grupos: [], sudo: true, bloqueado: false }, ...state.usuarios]
    usuarios.sort((a, b) => Number(b.nombre === state.usuario) - Number(a.nombre === state.usuario))
    const first = usuarios[0]?.nombre === state.usuario ? usuarios.shift() : undefined
    if (first) this.addUser(first.nombre, { uid: first.uid, shell: first.shell, home: first.home, gecos: first.comentario, createHome: true })
    for (const g of state.grupos) if (!this.groups.has(g.nombre)) this.addGroup(g.nombre, g.gid)
    if (first) usuarios.unshift(first)
    for (const u of usuarios) {
      if (!this.users.has(u.nombre)) this.addUser(u.nombre, { uid: u.uid, shell: u.shell, home: u.home, gecos: u.comentario, createHome: true })
      const user = this.users.get(u.nombre)!
      user.hasPassword = true
      user.locked = u.bloqueado
      for (const g of u.grupos) {
        if (!this.groups.has(g)) this.addGroup(g)
        this.addMember(g, u.nombre)
      }
      if (u.sudo) this.addMember(this.adminGroup, u.nombre)
    }
    for (const g of state.grupos) for (const m of g.miembros) if (this.users.has(m)) this.addMember(g.nombre, m)

    // Archivos del ejercicio
    const entries = Object.entries(state.archivos).sort(([a], [b]) => a.length - b.length)
    for (const [path, spec] of entries) {
      const abs = normalizePath(path)
      this.vfs.mkdirp(abs.slice(0, abs.lastIndexOf('/')) || '/', ROOT_CRED)
      const s = typeof spec === 'string' ? { tipo: 'archivo' as const, contenido: spec } : spec
      if (s.tipo === 'directorio') {
        if (!this.vfs.exists(abs)) this.vfs.mkdir(abs, ROOT_CRED)
      } else if (s.tipo === 'enlace') {
        this.vfs.symlink(s.destino ?? '/', abs, ROOT_CRED)
      } else {
        this.vfs.writeFile(abs, s.contenido ?? '', ROOT_CRED)
      }
      const node = this.vfs.stat(abs, ROOT_CRED, false)
      if (s.modo) node.mode = parseInt(s.modo, 8)
      else if (s.tipo === 'directorio') node.mode = 0o755
      // Sin dueño indicado, lo que está dentro del home de un usuario es de ese usuario
      // (incluidas las carpetas intermedias que se crearon para el archivo).
      const homeUser = [...this.users.values()].find((u) => u.uid >= 1000 && (abs === u.home || abs.startsWith(`${u.home}/`)))
      if (homeUser) {
        let dir = abs.slice(0, abs.lastIndexOf('/'))
        while (dir.length > homeUser.home.length) {
          const d = this.vfs.stat(dir, ROOT_CRED, false)
          if (d.uid === 0) {
            d.uid = homeUser.uid
            d.gid = homeUser.gid
          }
          dir = dir.slice(0, dir.lastIndexOf('/'))
        }
      }
      const owner = s.dueno ?? homeUser?.name
      if (owner) node.uid = this.users.get(owner)?.uid ?? 0
      if (s.grupo) node.gid = this.groups.get(s.grupo)?.gid ?? 0
      else if (owner) node.gid = this.users.get(owner)?.gid ?? 0
    }

    // Servicios del ejercicio (los nombres terminados en .timer configuran timers)
    for (const [name, s] of Object.entries(state.servicios)) {
      if (name.endsWith('.timer')) continue
      if (s.paquete && !this.installed.has(s.paquete)) this.installPackage(s.paquete, true)
      const existing = this.services.get(name)
      const failed = s.fallido && !s.activo
      this.services.set(name, {
        name,
        description: s.descripcion ?? existing?.description ?? `${name} service`,
        active: s.activo,
        enabled: s.habilitado,
        failed,
        failMessage: s.falla,
        ports: s.puertos.length ? s.puertos : existing?.ports ?? [],
        pkg: s.paquete ?? existing?.pkg,
        since: now - (s.hace_minutos ?? 60) * 60_000,
        pid: s.activo ? this.spawnService(name, now - (s.hace_minutos ?? 60) * 60_000).pid : undefined,
        result: failed ? 'exit-code' : undefined,
      })
    }
    // Unidades de systemd: las del sistema y las propias de /etc/systemd/system.
    for (const t of builtinTimers(this)) this.timers.set(t.name, t)
    daemonReload(this)
    for (const [name, s] of Object.entries(state.servicios)) {
      if (!name.endsWith('.timer')) continue
      const t = this.timers.get(name.slice(0, -6))
      if (!t) continue
      t.active = s.activo
      t.enabled = s.habilitado
      t.since = now - (s.hace_minutos ?? 60) * 60_000
      if (s.ultima_hace_minutos !== undefined) t.last = now - s.ultima_hace_minutos * 60_000
    }

    // Red
    this.interfaces = state.red.interfaces.map((i) => ({ name: i.nombre, ip: i.ip, mac: i.mac ?? macFor(i.nombre + state.hostname), up: i.estado === 'UP' }))
    this.gateway = state.red.puerta_enlace
    this.dns = state.red.dns
    for (const h of state.red.alcanzables) this.reachable.add(h)
    if (this.gateway) this.reachable.add(this.gateway)
    this.internet = state.red.internet
    this.dnsRecords = { ...(state.red.internet ? { 'example.com': '93.184.215.14', 'google.com': '142.250.78.14', 'rockylinux.org': '104.21.27.229', 'ubuntu.com': '185.125.190.20' } : {}), ...state.red.registros_dns }
    this.sites = state.red.sitios_web
    for (const [user, n] of Object.entries(state.faillock)) {
      this.faillock.set(user, Array.from({ length: n }, (_, i) => ({ when: Date.now() - (n - i) * 47_000, source: `192.168.56.${23 + i}` })))
    }
    this.vfs.writeFile('/etc/resolv.conf', this.dns.map((d) => `nameserver ${d}`).join('\n') + '\n', ROOT_CRED)

    // Procesos y journal
    this.createBaseProcesses(state.usuario)
    for (const p of state.procesos) this.spawn(p.usuario, p.comando, p.cpu, p.mem)
    for (const j of state.journal) {
      this.journal.push({ time: now - j.hace_minutos * 60_000, unit: j.unidad, priority: priorityNumber(j.prioridad), message: j.mensaje, ident: j.unidad.replace(/\.service$/, '') })
    }
    this.journal.sort((a, b) => a.time - b.time)
    this.syncAccountFiles()
  }

  // ---------------------------------------------------------------------------
  // Cuentas
  // ---------------------------------------------------------------------------

  credFor(name: string): Cred {
    const u = this.users.get(name)
    if (!u) return ROOT_CRED
    const groups = [u.gid, ...[...this.groups.values()].filter((g) => g.members.includes(name)).map((g) => g.gid)]
    return { uid: u.uid, gid: u.gid, groups }
  }

  userByUid(uid: number): User | undefined {
    for (const u of this.users.values()) if (u.uid === uid) return u
    return undefined
  }

  groupByGid(gid: number): Group | undefined {
    for (const g of this.groups.values()) if (g.gid === gid) return g
    return undefined
  }

  userName(uid: number): string {
    return this.userByUid(uid)?.name ?? String(uid)
  }

  groupName(gid: number): string {
    return this.groupByGid(gid)?.name ?? String(gid)
  }

  groupsOf(name: string): string[] {
    const u = this.users.get(name)
    if (!u) return []
    const primary = this.groupName(u.gid)
    return [primary, ...[...this.groups.values()].filter((g) => g.members.includes(name) && g.name !== primary).map((g) => g.name)]
  }

  nextId(kind: 'uid' | 'gid'): number {
    const used = kind === 'uid' ? [...this.users.values()].map((u) => u.uid) : [...this.groups.values()].map((g) => g.gid)
    let id = 1000
    while (used.includes(id)) id++
    return id
  }

  addGroup(name: string, gid?: number): Group {
    const g = { name, gid: gid ?? this.nextId('gid'), members: [] }
    this.groups.set(name, g)
    return g
  }

  addMember(group: string, user: string) {
    const g = this.groups.get(group)
    if (g && !g.members.includes(user)) g.members.push(user)
  }

  addUser(
    name: string,
    opts: { uid?: number; gid?: number; shell?: string; home?: string; gecos?: string; createHome?: boolean; system?: boolean } = {},
  ): User {
    const uid = opts.uid ?? this.nextId('uid')
    let gid = opts.gid
    if (gid === undefined) {
      const existing = this.groups.get(name)
      gid = existing ? existing.gid : this.addGroup(name, this.groupByGid(uid) ? undefined : uid).gid
    }
    const user: User = {
      name,
      uid,
      gid,
      home: opts.home ?? (name === 'root' ? '/root' : `/home/${name}`),
      shell: opts.shell ?? (this.distro === 'ubuntu' && !opts.createHome ? '/bin/sh' : '/bin/bash'),
      gecos: opts.gecos ?? '',
      locked: true,
      hasPassword: false,
      maxDays: 99999,
      minDays: 0,
      warnDays: 7,
      expire: '',
      lastChange: Math.floor(Date.now() / 86_400_000),
    }
    this.users.set(name, user)
    if (opts.createHome && !this.vfs.exists(user.home)) {
      this.vfs.mkdirp(user.home, ROOT_CRED)
      const home = this.vfs.stat(user.home, ROOT_CRED)
      home.uid = uid
      home.gid = gid
      home.mode = this.distro === 'rocky' ? 0o700 : 0o750
      for (const [f, content] of Object.entries({ '.bashrc': '# .bashrc\n', '.bash_profile': '# .bash_profile\n', '.bash_logout': '# ~/.bash_logout\n' })) {
        this.vfs.writeFile(`${user.home}/${f}`, content, ROOT_CRED)
        const n = this.vfs.stat(`${user.home}/${f}`, ROOT_CRED)
        n.uid = uid
        n.gid = gid
      }
    }
    return user
  }

  /** Reescribe /etc/passwd, /etc/group y /etc/shadow a partir de las cuentas. */
  syncAccountFiles() {
    const users = [...this.users.values()].sort((a, b) => a.uid - b.uid)
    const passwd = users.map((u) => `${u.name}:x:${u.uid}:${u.gid}:${u.gecos}:${u.home}:${u.shell}`).join('\n') + '\n'
    const shadow =
      users
        .map((u) => {
          const hash = u.hasPassword ? `${u.locked ? '!' : ''}$6$rounds=5000$simulado$K9fZ2` : u.locked ? '!!' : ''
          return `${u.name}:${hash}:${u.lastChange}:${u.minDays}:${u.maxDays}:${u.warnDays}:::${u.expire ? Math.floor(new Date(u.expire).getTime() / 86_400_000) : ''}`
        })
        .join('\n') + '\n'
    const groups = [...this.groups.values()].sort((a, b) => a.gid - b.gid)
    const group = groups.map((g) => `${g.name}:x:${g.gid}:${g.members.join(',')}`).join('\n') + '\n'
    for (const [path, data, mode] of [
      ['/etc/passwd', passwd, 0o644],
      ['/etc/shadow', shadow, 0o000],
      ['/etc/group', group, 0o644],
    ] as const) {
      this.vfs.writeFile(path, data, ROOT_CRED)
      this.vfs.stat(path, ROOT_CRED).mode = mode
    }
  }

  // ---------------------------------------------------------------------------
  // Paquetes y servicios
  // ---------------------------------------------------------------------------

  installPackage(name: string, silent = false): boolean {
    const info = this.catalog[name]
    if (!info) return false
    this.installed.add(name)
    if (info.user && !this.users.has(info.user.name)) this.addSystemUser(info.user.name, info.user.uid, info.user.home, info.user.gecos)
    for (const [path, content] of Object.entries(info.files ?? {})) {
      this.vfs.mkdirp(path.slice(0, path.lastIndexOf('/')) || '/', ROOT_CRED)
      if (!this.vfs.exists(path)) this.vfs.writeFile(path, content, ROOT_CRED)
    }
    for (const s of info.services ?? []) {
      if (this.services.has(s.name)) continue
      const active = !!s.activeAfterInstall
      this.services.set(s.name, {
        name: s.name,
        description: s.description,
        active,
        enabled: !!s.enabledByDefault,
        failed: false,
        ports: s.ports,
        pkg: name,
        since: silent ? this.bootTime + 30_000 : Date.now(),
        pid: active ? this.spawnService(s.name, silent ? this.bootTime + 30_000 : Date.now()).pid : undefined,
      })
    }
    return true
  }

  removePackage(name: string) {
    this.installed.delete(name)
    for (const [svc, s] of this.services) if (s.pkg === name) this.services.delete(svc)
  }

  isCommandAvailable(cmd: string, packageOf: (c: string) => string | undefined): boolean {
    const pkg = packageOf(cmd)
    return !pkg || this.installed.has(pkg)
  }

  log(unit: string, message: string, priority = 6) {
    this.journal.push({ time: Date.now(), unit, priority, message, ident: unit.replace(/\.service$/, '') })
  }

  /** PID nuevo, siempre mayor que el anterior y con saltos chicos, como en un sistema real. */
  allocPid() {
    const pid = this.nextPid + Math.floor(Math.random() * 3)
    this.nextPid = pid + 1
    return pid
  }

  spawn(user: string, cmd: string, cpu = 0, mem = 0.1, ppid = 1, start = Date.now(), comm?: string): Proc {
    const p: Proc = { pid: this.allocPid(), ppid, user, cmd, comm, cpu, mem, stat: cpu > 50 ? 'R' : 'S', start }
    this.procs.push(p)
    return p
  }

  /** Arranca el proceso principal de un servicio. */
  spawnService(name: string, start = Date.now()): Proc {
    const sp = serviceProcess(this.distro, name)
    return this.spawn(sp.user, sp.cmd, 0, 0.3, 1, start, sp.comm)
  }

  // ---------------------------------------------------------------------------
  // Red
  // ---------------------------------------------------------------------------

  ownIps(): string[] {
    return ['127.0.0.1', ...this.interfaces.filter((i) => i.up && i.ip).map((i) => i.ip!.split('/')[0])]
  }

  resolveHost(name: string): string | undefined {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return name
    if (name === 'localhost' || name === this.hostname) return name === 'localhost' ? '127.0.0.1' : this.ownIps()[1] ?? '127.0.0.1'
    try {
      const hosts = this.vfs.readFile('/etc/hosts', ROOT_CRED)
      for (const line of hosts.split('\n')) {
        const parts = line.replace(/#.*/, '').trim().split(/\s+/)
        if (parts.length > 1 && parts.slice(1).includes(name)) return parts[0]
      }
    } catch {
      // sin /etc/hosts
    }
    if (this.dns.length === 0) return undefined
    return this.dnsRecords[name]
  }

  isReachable(ip: string): boolean {
    if (this.ownIps().includes(ip) || this.reachable.has(ip) || [...this.reachable].some((h) => this.dnsRecords[h] === ip)) return true
    const isPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/.test(ip)
    return this.internet && !isPrivate && !!this.gateway && this.reachable.has(this.gateway)
  }

  // ---------------------------------------------------------------------------
  // Sistema de archivos base
  // ---------------------------------------------------------------------------

  private createBaseFilesystem() {
    const v = this.vfs
    const dirs: [string, number][] = [
      ['/boot', 0o555],
      ['/dev', 0o755],
      ['/etc', 0o755],
      ['/etc/ssh', 0o755],
      ['/etc/sudoers.d', 0o750],
      ['/etc/systemd/system', 0o755],
      ['/etc/cron.d', 0o755],
      ['/etc/skel', 0o755],
      ['/home', 0o755],
      ['/media', 0o755],
      ['/mnt', 0o755],
      ['/opt', 0o755],
      ['/proc', 0o555],
      ['/root', 0o550],
      ['/run', 0o755],
      ['/srv', 0o755],
      ['/sys', 0o555],
      ['/tmp', 0o1777],
      ['/usr', 0o755],
      ['/usr/bin', 0o755],
      ['/usr/sbin', 0o755],
      ['/usr/lib', 0o755],
      ['/usr/lib64', 0o755],
      ['/usr/local', 0o755],
      ['/usr/local/bin', 0o755],
      ['/usr/share', 0o755],
      ['/usr/share/doc', 0o755],
      ['/var', 0o755],
      ['/var/log', 0o755],
      ['/var/tmp', 0o1777],
      ['/var/lib', 0o755],
      ['/var/spool/cron', 0o700],
      ['/var/www', 0o755],
    ]
    for (const [d, mode] of dirs) {
      v.mkdirp(d, ROOT_CRED)
      v.stat(d, ROOT_CRED).mode = mode
    }
    // Rocky y Ubuntu tienen /usr unificado: /bin, /sbin, /lib y /lib64 son enlaces a /usr.
    for (const d of ['bin', 'sbin', 'lib', 'lib64']) v.symlink(`usr/${d}`, `/${d}`, ROOT_CRED)
    const osRelease =
      this.distro === 'rocky'
        ? 'NAME="Rocky Linux"\nVERSION="10.0 (Red Quartz)"\nID="rocky"\nID_LIKE="rhel centos fedora"\nVERSION_ID="10.0"\nPRETTY_NAME="Rocky Linux 10.0 (Red Quartz)"\n'
        : 'PRETTY_NAME="Ubuntu 24.04.2 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nVERSION="24.04.2 LTS (Noble Numbat)"\nID=ubuntu\nID_LIKE=debian\n'
    const files: Record<string, string> = {
      '/etc/os-release': osRelease,
      '/etc/hostname': `${this.hostname}\n`,
      '/etc/hosts': `127.0.0.1   localhost localhost.localdomain\n::1         localhost localhost.localdomain\n`,
      '/etc/fstab':
        '# /etc/fstab\nUUID=6f1c2b8e-1a7d-4c1e-9d5a-2b6f0c3e8a11 /     xfs  defaults 0 0\nUUID=3b2e9f40-7c55-4e0b-b1aa-0d4c8b6f1e22 /boot xfs  defaults 0 0\n' +
        (this.firmware === 'uefi' ? 'UUID=1A2B-3C4D /boot/efi vfat umask=0077,shortname=winnt 0 2\n' : ''),
      '/etc/shells': '/bin/sh\n/bin/bash\n/usr/bin/sh\n/usr/bin/bash\n',
      '/etc/security/faillock.conf': FAILLOCK_CONF,
      ...(this.distro === 'rocky'
        ? { '/etc/yum.repos.d/rocky.repo': ROCKY_REPO, '/etc/yum.repos.d/rocky-extras.repo': ROCKY_EXTRAS_REPO }
        : { '/etc/apt/sources.list.d/ubuntu.sources': UBUNTU_SOURCES, '/etc/apt/sources.list': '# Ubuntu sources have moved to /etc/apt/sources.list.d/ubuntu.sources\n', '/var/log/apt/history.log': '' }),
      ...(this.distro === 'rocky'
        ? { '/etc/security/pwquality.conf': PWQUALITY_CONF, '/etc/authselect/system-auth': systemAuth(false), '/etc/authselect/password-auth': systemAuth(false) }
        : { '/etc/pam.d/common-auth': UBUNTU_COMMON_AUTH, '/etc/pam.d/common-password': UBUNTU_COMMON_PASSWORD }),
      ...(this.distro === 'rocky'
        ? {
            '/etc/pam.d/sshd': '#%PAM-1.0\nauth       substack     password-auth\nauth       include      postlogin\naccount    required     pam_sepermit.so\naccount    required     pam_nologin.so\naccount    include      password-auth\npassword   include      password-auth\nsession    required     pam_selinux.so close\nsession    required     pam_loginuid.so\nsession    required     pam_selinux.so open env_params\nsession    required     pam_namespace.so\nsession    optional     pam_keyinit.so force revoke\nsession    optional     pam_motd.so\nsession    include      password-auth\nsession    include      postlogin\n',
            '/etc/pam.d/sudo': '#%PAM-1.0\nauth       include      system-auth\naccount    include      system-auth\npassword   include      system-auth\nsession    include      system-auth\n',
            '/etc/pam.d/su': '#%PAM-1.0\nauth            required        pam_env.so\nauth            sufficient      pam_rootok.so\n#auth           required        pam_wheel.so use_uid\nauth            substack        system-auth\nauth            include         postlogin\naccount         sufficient      pam_succeed_if.so uid = 0 use_uid quiet\naccount         include         system-auth\npassword        include         system-auth\nsession         include         system-auth\nsession         include         postlogin\n',
            '/etc/pam.d/passwd': '#%PAM-1.0\nauth       include      system-auth\naccount    include      system-auth\npassword   substack     system-auth\n-password  optional     pam_gnome_keyring.so use_authtok\npassword   substack     postlogin\n',
          }
        : {
            '/etc/pam.d/sshd': '# PAM configuration for the Secure Shell service\n\n# Standard Un*x authentication.\n@include common-auth\n\n# Disallow non-root logins when /etc/nologin exists.\naccount    required     pam_nologin.so\n\n# Standard Un*x authorization.\n@include common-account\n\n# Standard Un*x session setup and teardown.\n@include common-session\n\n# Print the message of the day upon successful login.\nsession    optional     pam_motd.so  motd=/run/motd.dynamic\nsession    optional     pam_motd.so noupdate\n\n# Standard Un*x password updating.\n@include common-password\n',
            '/etc/pam.d/sudo': '#%PAM-1.0\n\n# Set up user limits from /etc/security/limits.conf.\nsession    required   pam_limits.so\n\n@include common-auth\n@include common-account\n@include common-session-noninteractive\n',
            '/etc/pam.d/su': '#\n# The PAM configuration file for the Shadow `su\' service\n#\n\n# This allows root to su without passwords (normal operation)\nauth       sufficient pam_rootok.so\n\n# Uncomment this to force users to be a member of group wheel\n# before they can use `su\'.\n# auth       required   pam_wheel.so\n\n@include common-auth\n@include common-account\n@include common-session\n',
          }),
      // Documentación que instalan los paquetes en /usr/share/doc (lección "Obtener ayuda").
      '/usr/share/doc/sudo/README.md':
        'Sudo is a program designed to allow a sysadmin to give limited root privileges\nto users and log root activity. The basic philosophy is to give as few\nprivileges as possible but still allow people to get their work done.\n\nSee the sudoers(5) manual for the policy file format and visudo(8) to edit it.\n',
      [this.distro === 'ubuntu' ? '/usr/share/doc/bash/README' : '/usr/share/doc/bash/FAQ']:
        'This is the Bash FAQ: frequently asked questions about the GNU Bourne-Again Shell.\nFor the complete reference, see bash(1) and the Bash Reference Manual.\n',
      '/usr/share/doc/coreutils/README':
        'These are the GNU core utilities: ls, cp, mv, rm, cat, head, tail, sort, wc and\nmany more. Each program documents its options with --help and in its manual page.\n',
      '/etc/login.defs': 'PASS_MAX_DAYS\t99999\nPASS_MIN_DAYS\t0\nPASS_WARN_AGE\t7\nUID_MIN\t\t1000\nGID_MIN\t\t1000\nUMASK\t\t022\n',
      '/etc/ssh/sshd_config':
        '# Configuración del servidor SSH\n#Port 22\nPermitRootLogin prohibit-password\nPubkeyAuthentication yes\nPasswordAuthentication yes\nKbdInteractiveAuthentication no\nUsePAM yes\nX11Forwarding no\nSubsystem sftp /usr/libexec/openssh/sftp-server\n',
      '/etc/sudoers':
        this.distro === 'rocky'
          ? 'Defaults   !visiblepw\nDefaults    secure_path = /sbin:/bin:/usr/sbin:/usr/bin\nroot    ALL=(ALL)       ALL\n%wheel  ALL=(ALL)       ALL\n#includedir /etc/sudoers.d\n'
          : 'Defaults\tenv_reset\nDefaults\tsecure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"\nroot\tALL=(ALL:ALL) ALL\n%sudo\tALL=(ALL:ALL) ALL\n@includedir /etc/sudoers.d\n',
      '/etc/motd': '',
      '/proc/cpuinfo': cpuinfoText(),
      '/proc/meminfo': 'MemTotal:        3843580 kB\nMemFree:         1520332 kB\nMemAvailable:    2788416 kB\nBuffers:            4268 kB\nCached:          1381420 kB\nSwapTotal:       2097148 kB\nSwapFree:        2097148 kB\n',
      '/proc/loadavg': '0.08 0.12 0.09 1/187 1450\n',
      '/proc/version':
        this.distro === 'rocky'
          ? 'Linux version 6.12.0-55.el10.x86_64 (mockbuild@rocky) (gcc 14.2.1) #1 SMP PREEMPT_DYNAMIC\n'
          : 'Linux version 6.8.0-58-generic (buildd@lcy02-amd64-074) (x86_64-linux-gnu-gcc-13 (Ubuntu 13.3.0-6ubuntu2~24.04) 13.3.0) #60-Ubuntu SMP PREEMPT_DYNAMIC\n',
      ...bootFiles(this.distro, this.firmware),
      ...logrotateFiles(this.distro),
      '/etc/systemd/journald.conf':
        '#  This file is part of systemd.\n#\n# Entries in this file show the compile time defaults. Local configuration\n# should be created by either modifying this file, or by creating "drop-ins" in\n# the journald.conf.d/ subdirectory.\n\n[Journal]\n#Storage=auto\n#Compress=yes\n#SystemMaxUse=\n#SystemKeepFree=\n#MaxRetentionSec=0\n#ForwardToSyslog=no\n',
      '/dev/null': '',
      '/var/log/lastlog': '',
    }
    if (this.distro === 'rocky') {
      files['/var/log/messages'] = ''
      files['/var/log/secure'] = ''
      files['/var/log/cron'] = ''
    } else {
      files['/var/log/syslog'] = ''
      files['/var/log/auth.log'] = ''
      files['/etc/netplan/50-cloud-init.yaml'] = 'network:\n  version: 2\n  ethernets:\n    enp0s3:\n      dhcp4: true\n'
    }
    if (this.firmware === 'uefi') {
      const vendor = this.distro === 'rocky' ? 'rocky' : 'ubuntu'
      v.mkdirp('/sys/firmware/efi/efivars', ROOT_CRED)
      files['/boot/efi/EFI/BOOT/BOOTX64.EFI'] = ''
      files['/boot/efi/EFI/BOOT/fbx64.efi'] = ''
      files[`/boot/efi/EFI/${vendor}/shimx64.efi`] = ''
      files[`/boot/efi/EFI/${vendor}/grubx64.efi`] = ''
      files[`/boot/efi/EFI/${vendor}/grub.cfg`] = ''
    }
    for (const [p, c] of Object.entries(files)) {
      v.mkdirp(p.slice(0, p.lastIndexOf('/')) || '/', ROOT_CRED)
      v.writeFile(p, c, ROOT_CRED)
    }
    this.kernelArgs = KERNEL_ARGS[this.distro]
    for (const d of ['/usr/lib/systemd/system', '/etc/systemd/system/multi-user.target.wants', '/etc/systemd/system/timers.target.wants', '/var/log/journal', '/etc/logrotate.d', '/run/systemd/system']) v.mkdirp(d, ROOT_CRED)
    v.symlink('/usr/lib/systemd/system/multi-user.target', '/etc/systemd/system/default.target', ROOT_CRED)
    if (this.distro === 'ubuntu') v.stat('/usr/lib/rsyslog/rsyslog-rotate', ROOT_CRED).mode = 0o755
    v.stat('/boot/grub2/grubenv'.replace('grub2', this.distro === 'rocky' ? 'grub2' : 'grub'), ROOT_CRED).mode = 0o600
    // La partición EFI se monta con umask=0077: solo root puede ver su contenido.
    if (this.firmware === 'uefi') v.stat('/boot/efi', ROOT_CRED).mode = 0o700
    v.stat('/etc/sudoers', ROOT_CRED).mode = 0o440
    v.stat('/dev/null', ROOT_CRED).mode = 0o666
    v.stat('/etc/ssh/sshd_config', ROOT_CRED).mode = 0o600
    if (this.distro === 'rocky') {
      v.stat('/var/log/secure', ROOT_CRED).mode = 0o600
      v.stat('/var/log/messages', ROOT_CRED).mode = 0o600
      // authselect mantiene system-auth y password-auth y los enlaza desde /etc/pam.d.
      v.mkdirp('/etc/pam.d', ROOT_CRED)
      for (const f of ['system-auth', 'password-auth']) v.symlink(`/etc/authselect/${f}`, `/etc/pam.d/${f}`, ROOT_CRED)
      v.mkdirp('/etc/security/pwquality.conf.d', ROOT_CRED)
    }
  }

  private createBaseAccounts() {
    this.addGroup('root', 0)
    this.users.set('root', {
      name: 'root',
      uid: 0,
      gid: 0,
      home: '/root',
      shell: '/bin/bash',
      gecos: 'root',
      locked: false,
      hasPassword: true,
      maxDays: 99999,
      minDays: 0,
      warnDays: 7,
      expire: '',
      lastChange: 19800,
    })
    const system: [string, number, string, string][] =
      this.distro === 'rocky'
        ? [
            ['bin', 1, '/bin', '/sbin/nologin'],
            ['daemon', 2, '/sbin', '/sbin/nologin'],
            ['adm', 3, '/var/adm', '/sbin/nologin'],
            ['nobody', 65534, '/', '/sbin/nologin'],
            ['sshd', 74, '/usr/share/empty.sshd', '/sbin/nologin'],
            ['chrony', 992, '/var/lib/chrony', '/sbin/nologin'],
          ]
        : [
            ['daemon', 1, '/usr/sbin', '/usr/sbin/nologin'],
            ['bin', 2, '/bin', '/usr/sbin/nologin'],
            ['sys', 3, '/dev', '/usr/sbin/nologin'],
            ['www-data', 33, '/var/www', '/usr/sbin/nologin'],
            ['nobody', 65534, '/nonexistent', '/usr/sbin/nologin'],
            ['sshd', 109, '/run/sshd', '/usr/sbin/nologin'],
          ]
    for (const [name, id, home] of system) this.addSystemUser(name, id, home, name)
    this.addGroup(this.adminGroup, this.distro === 'rocky' ? 10 : 27)
    if (this.distro === 'rocky') {
      this.addGroup('nginx', 990)
      this.addGroup('apache', 48)
    } else {
      this.addGroup('adm', 4)
    }
  }

  /** Cuenta de sistema o de servicio: bloqueada, sin contraseña y sin shell de inicio de sesión. */
  addSystemUser(name: string, uid: number, home: string, gecos: string) {
    if (!this.groups.has(name)) this.addGroup(name, uid)
    const gid = this.groups.get(name)!.gid
    const shell = this.distro === 'rocky' ? '/sbin/nologin' : '/usr/sbin/nologin'
    this.users.set(name, { name, uid, gid, home, shell, gecos, locked: true, hasPassword: false, maxDays: 99999, minDays: 0, warnDays: 7, expire: '', lastChange: 19800 })
  }

  private createBaseProcesses(user: string) {
    // Procesos del sistema que no son servicios instalables; los servicios ya se crearon al instalar sus paquetes.
    const base: [number, string, string][] =
      this.distro === 'rocky'
        ? [
            [1, '/usr/lib/systemd/systemd --switched-root --system --deserialize=46', 'systemd'],
            [612, '/usr/lib/systemd/systemd-journald', 'systemd-journal'],
            [645, '/usr/lib/systemd/systemd-udevd', 'systemd-udevd'],
            [702, '/usr/lib/systemd/systemd-logind', 'systemd-logind'],
            [731, '/usr/sbin/NetworkManager --no-daemon', 'NetworkManager'],
          ]
        : [
            [1, '/sbin/init', 'systemd'],
            [388, '/usr/lib/systemd/systemd-journald', 'systemd-journal'],
            [431, '/usr/lib/systemd/systemd-udevd', 'systemd-udevd'],
            [612, '/usr/lib/systemd/systemd-networkd', 'systemd-network'],
            [702, '/usr/lib/systemd/systemd-logind', 'systemd-logind'],
          ]
    for (const [pid, cmd, comm] of base) {
      this.procs.push({ pid, ppid: pid === 1 ? 0 : 1, user: pid === 612 && this.distro === 'ubuntu' ? 'systemd-network' : 'root', cmd, comm, cpu: 0, mem: pid === 1 ? 0.3 : 0.2, stat: pid === 1 ? 'Ss' : 'Ss', start: this.bootTime })
    }
    // La sesión del usuario empieza después de los servicios del arranque.
    this.nextPid = Math.max(this.nextPid, 1150)
    const sshd = this.spawn('root', `sshd: ${user} [priv]`, 0, 0.1, this.procs.find((p) => p.comm === 'sshd')?.pid ?? 1, Date.now(), 'sshd')
    this.spawn(user, '-bash', 0, 0.1, sshd.pid, Date.now(), 'bash')
  }

}

// ---------------------------------------------------------------------------------------
// Arranque (GRUB, kernel, initramfs) y rotación de logs
// ---------------------------------------------------------------------------------------

export const KERNEL_VERSION = { rocky: '6.12.0-55.el10.x86_64', ubuntu: '6.8.0-58-generic' } as const
export const MACHINE_ID = '4b0c2f1e9a7d4c55b1e2f30a8d6c7e91'

const KERNEL_ARGS = {
  rocky: 'root=/dev/mapper/rl-root ro crashkernel=2G-64G:256M,64G-:512M resume=/dev/mapper/rl-swap rd.lvm.lv=rl/root rd.lvm.lv=rl/swap',
  ubuntu: 'root=/dev/mapper/ubuntu--vg-ubuntu--lv ro',
}

export function rockyBootEntry(args: string): string {
  const k = KERNEL_VERSION.rocky
  return `title Rocky Linux (${k}) 10.0 (Red Quartz)\nversion ${k}\nlinux /vmlinuz-${k}\ninitrd /initramfs-${k}.img $tuned_initrd\noptions ${args}\ngrub_users $grub_users\ngrub_arg --unrestricted\ngrub_class rocky\n`
}

export function grubCfg(distro: 'rocky' | 'ubuntu', cmdlineExtra: string, timeout: string): string {
  if (distro === 'rocky') {
    return `#\n# DO NOT EDIT THIS FILE\n#\n# It is automatically generated by grub2-mkconfig using templates\n# from /etc/grub.d and settings from /etc/default/grub\n#\n\n### BEGIN /etc/grub.d/00_header ###\nset pager=1\nif [ -f \${config_directory}/grubenv ]; then\n  load_env -f \${config_directory}/grubenv\nfi\nset timeout=${timeout}\n### END /etc/grub.d/00_header ###\n\n### BEGIN /etc/grub.d/10_linux ###\ninsmod part_gpt\ninsmod xfs\nset kernelopts="root=/dev/mapper/rl-root ro ${cmdlineExtra}"\nblscfg\n### END /etc/grub.d/10_linux ###\n`
  }
  const k = KERNEL_VERSION.ubuntu
  return `#\n# DO NOT EDIT THIS FILE\n#\n# It is automatically generated by grub-mkconfig using templates\n# from /etc/grub.d and settings from /etc/default/grub\n#\n\n### BEGIN /etc/grub.d/00_header ###\nset timeout=${timeout}\n### END /etc/grub.d/00_header ###\n\n### BEGIN /etc/grub.d/10_linux ###\nmenuentry 'Ubuntu' --class ubuntu --class gnu-linux --class gnu --class os {\n\tlinux\t/vmlinuz-${k} root=/dev/mapper/ubuntu--vg-ubuntu--lv ro ${cmdlineExtra}\n\tinitrd\t/initrd.img-${k}\n}\nmenuentry 'Ubuntu, with Linux ${k} (recovery mode)' --class ubuntu --class gnu-linux --class gnu --class os {\n\tlinux\t/vmlinuz-${k} root=/dev/mapper/ubuntu--vg-ubuntu--lv ro recovery nomodeset dis_ucode_ldr\n\tinitrd\t/initrd.img-${k}\n}\n### END /etc/grub.d/10_linux ###\n`
}

function bootFiles(distro: 'rocky' | 'ubuntu', firmware: 'bios' | 'uefi'): Record<string, string> {
  const k = KERNEL_VERSION[distro]
  if (distro === 'rocky') {
    return {
      '/etc/default/grub':
        'GRUB_TIMEOUT=5\nGRUB_DISTRIBUTOR="$(sed \'s, release .*$,,g\' /etc/system-release)"\nGRUB_DEFAULT=saved\nGRUB_DISABLE_SUBMENU=true\nGRUB_TERMINAL_OUTPUT="console"\nGRUB_CMDLINE_LINUX="crashkernel=2G-64G:256M,64G-:512M resume=/dev/mapper/rl-swap rd.lvm.lv=rl/root rd.lvm.lv=rl/swap"\nGRUB_DISABLE_RECOVERY="true"\nGRUB_ENABLE_BLSCFG=true\n',
      '/boot/grub2/grub.cfg': grubCfg('rocky', 'crashkernel=2G-64G:256M,64G-:512M resume=/dev/mapper/rl-swap rd.lvm.lv=rl/root rd.lvm.lv=rl/swap', '5'),
      '/boot/grub2/grubenv': `# GRUB Environment Block\nsaved_entry=${MACHINE_ID}-${k}\nboot_success=1\n`,
      [`/boot/loader/entries/${MACHINE_ID}-${k}.conf`]: rockyBootEntry(KERNEL_ARGS.rocky),
      [`/boot/loader/entries/${MACHINE_ID}-0-rescue.conf`]: `title Rocky Linux (0-rescue-${MACHINE_ID}) 10.0 (Red Quartz)\nversion 0-rescue-${MACHINE_ID}\nlinux /vmlinuz-0-rescue-${MACHINE_ID}\ninitrd /initramfs-0-rescue-${MACHINE_ID}.img\noptions ${KERNEL_ARGS.rocky}\ngrub_users $grub_users\ngrub_arg --unrestricted\ngrub_class rocky\n`,
      [`/boot/vmlinuz-${k}`]: '',
      [`/boot/initramfs-${k}.img`]: '',
      [`/boot/vmlinuz-0-rescue-${MACHINE_ID}`]: '',
      [`/boot/initramfs-0-rescue-${MACHINE_ID}.img`]: '',
      [`/boot/config-${k}`]: '',
      [`/boot/System.map-${k}`]: '',
      '/proc/cmdline': `BOOT_IMAGE=(hd0,${firmware === 'uefi' ? 'gpt2' : 'msdos1'})/vmlinuz-${k} ${KERNEL_ARGS.rocky}\n`,
      '/etc/dracut.conf': '# PUT YOUR CONFIG IN separate files\n# in /etc/dracut.conf.d named "<name>.conf"\n# SEE man dracut.conf(5) for options\n',
    }
  }
  return {
    '/etc/default/grub':
      '# If you change this file, run \'update-grub\' afterwards to update\n# /boot/grub/grub.cfg.\n# For full documentation of the options in this file, see:\n#   info -f grub -n \'Simple configuration\'\n\nGRUB_DEFAULT=0\nGRUB_TIMEOUT_STYLE=hidden\nGRUB_TIMEOUT=0\nGRUB_DISTRIBUTOR=`( . /etc/os-release; echo ${NAME:-Ubuntu} ) 2>/dev/null || echo Ubuntu`\nGRUB_CMDLINE_LINUX_DEFAULT=""\nGRUB_CMDLINE_LINUX=""\n',
    '/boot/grub/grub.cfg': grubCfg('ubuntu', '', '0'),
    '/boot/grub/grubenv': '# GRUB Environment Block\n',
    [`/boot/vmlinuz-${k}`]: '',
    [`/boot/initrd.img-${k}`]: '',
    [`/boot/config-${k}`]: '',
    [`/boot/System.map-${k}`]: '',
    '/proc/cmdline': `BOOT_IMAGE=/vmlinuz-${k} ${KERNEL_ARGS.ubuntu}\n`,
    '/etc/initramfs-tools/initramfs.conf': '#\n# initramfs.conf\n# Configuration file for mkinitramfs(8). See initramfs.conf(5).\n#\n\nMODULES=most\nBUSYBOX=auto\nCOMPRESS=zstd\n',
  }
}

function logrotateFiles(distro: 'rocky' | 'ubuntu'): Record<string, string> {
  if (distro === 'rocky') {
    return {
      '/etc/logrotate.conf':
        '# see "man logrotate" for details\n\n# global options do not affect preceding include directives\n\n# rotate log files weekly\nweekly\n\n# keep 4 weeks worth of backlogs\nrotate 4\n\n# create new (empty) log files after rotating old ones\ncreate\n\n# use date as a suffix of the rotated file\ndateext\n\n# uncomment this if you want your log files compressed\n#compress\n\n# packages drop log rotation information into this directory\ninclude /etc/logrotate.d\n\n# system-specific logs may be also be configured here.\n',
      '/etc/logrotate.d/rsyslog':
        '/var/log/cron\n/var/log/maillog\n/var/log/messages\n/var/log/secure\n/var/log/spooler\n{\n    missingok\n    sharedscripts\n    postrotate\n        /usr/bin/systemctl -s HUP kill rsyslog.service >/dev/null 2>&1 || true\n    endscript\n}\n',
      '/etc/logrotate.d/dnf': '/var/log/hawkey.log {\n    missingok\n    notifempty\n    rotate 4\n    weekly\n    create\n}\n',
      '/etc/logrotate.d/btmp': '# no packages own btmp -- we\'ll rotate it here\n/var/log/btmp {\n    missingok\n    monthly\n    create 0660 root utmp\n    rotate 1\n}\n',
      '/var/lib/logrotate/logrotate.status': 'logrotate state -- version 2\n',
      '/var/log/maillog': '',
      '/var/log/spooler': '',
      '/var/log/hawkey.log': '',
      '/var/log/btmp': '',
    }
  }
  return {
    '/etc/logrotate.conf':
      '# see "man logrotate" for details\n\n# global options do not affect preceding include directives\n\n# rotate log files weekly\nweekly\n\n# use the adm group by default, since this is the owning group\n# of /var/log/.\nsu root adm\n\n# keep 4 weeks worth of backlogs\nrotate 4\n\n# create new (empty) log files after rotating old ones\ncreate\n\n# use date as a suffix of the rotated file\n#dateext\n\n# uncomment this if you want your log files compressed\n#compress\n\n# packages drop log rotation information into this directory\ninclude /etc/logrotate.d\n\n# system-specific logs may also be configured here.\n',
    '/etc/logrotate.d/rsyslog':
      '/var/log/syslog\n/var/log/mail.log\n/var/log/kern.log\n/var/log/auth.log\n/var/log/user.log\n/var/log/cron.log\n{\n\trotate 4\n\tweekly\n\tmissingok\n\tnotifempty\n\tcompress\n\tdelaycompress\n\tsharedscripts\n\tpostrotate\n\t\t/usr/lib/rsyslog/rsyslog-rotate\n\tendscript\n}\n',
    '/etc/logrotate.d/apt': '/var/log/apt/term.log {\n  rotate 12\n  monthly\n  compress\n  missingok\n  notifempty\n}\n\n/var/log/apt/history.log {\n  rotate 12\n  monthly\n  compress\n  missingok\n  notifempty\n}\n',
    '/usr/lib/rsyslog/rsyslog-rotate': '#!/bin/sh\n\nif [ -d /run/systemd/system ]; then\n    systemctl kill -s HUP rsyslog.service\nelse\n    invoke-rc.d rsyslog rotate > /dev/null\nfi\n',
    '/var/lib/logrotate/status': 'logrotate state -- version 2\n',
    '/var/log/kern.log': '',
  }
}

// ---------------------------------------------------------------------------------------
// Archivos de autenticación (PAM)
// ---------------------------------------------------------------------------------------

const FAILLOCK_CONF = `# Configuration for locking the user after multiple failed
# authentication attempts.
#
# The directory where the user files with the failure records are kept.
# The default is /var/run/faillock.
# dir = /var/run/faillock
#
# Will log the user name into the system log if the user is not found.
# Enabled if option is present.
# audit
#
# Don't print informative messages.
# Enabled if option is present.
# silent
#
# Deny access if the number of consecutive authentication failures
# for this user during the recent interval exceeds n tries.
# The default is 3.
# deny = 3
#
# The length of the interval during which the consecutive
# authentication failures must happen for the user account
# lock out is <replaceable>n</replaceable> seconds.
# The default is 900 (15 minutes).
# fail_interval = 900
#
# The access will be re-enabled after n seconds after the lock out.
# The value 0 has the same meaning as value \`never\` - the access
# will not be re-enabled without resetting the faillock
# entries by the \`faillock\` command.
# The default is 600 (10 minutes).
# unlock_time = 600
#
# Root account can become locked as well as regular accounts.
# Enabled if option is present.
# even_deny_root
`

const PWQUALITY_CONF = `# Configuration for systemwide password quality limits
# Defaults:
#
# Number of characters in the new password that must not be present in the
# old password.
# difok = 1
#
# Minimum acceptable size for the new password (plus one if
# credits are not disabled which is the default). (See pam_cracklib manual.)
# Cannot be set to lower value than 6.
# minlen = 8
#
# The maximum credit for having digits in the new password. If less than 0
# it is the minimum number of digits in the new password.
# dcredit = 0
#
# The maximum credit for having uppercase characters in the new password.
# If less than 0 it is the minimum number of uppercase characters in the new
# password.
# ucredit = 0
#
# The maximum credit for having lowercase characters in the new password.
# If less than 0 it is the minimum number of lowercase characters in the new
# password.
# lcredit = 0
#
# The maximum credit for having other characters in the new password.
# If less than 0 it is the minimum number of other characters in the new
# password.
# ocredit = 0
#
# The minimum number of required classes of characters for the new
# password (digits, uppercase, lowercase, others).
# minclass = 0
#
# The maximum number of allowed consecutive same characters in the new password.
# The check is disabled if the value is 0.
# maxrepeat = 0
#
# Whether to check for the words from the passwd entry GECOS string of the user.
# The check is enabled if the value is not 0.
# gecoscheck = 0
#
# Whether to check for the words from the cracklib dictionary.
# The check is enabled if the value is not 0.
# dictcheck = 1
#
# Prompt user at most N times before returning with error. The default is 1.
# retry = 3
#
# Enforces pwquality checks on the root user password.
# Enabled if the option is present.
# enforce_for_root
`

/** /etc/pam.d/system-auth generado por authselect (perfil local), con o sin faillock. */
export function systemAuth(faillock: boolean): string {
  const fl = (line: string) => (faillock ? line + '\n' : '')
  return `# Generated by authselect
# Do not modify this file manually, use authselect instead. Any user changes will be overwritten.
# You can stop authselect from managing your configuration by calling 'authselect opt-out'.
# See authselect(8) for more details.

auth        required                                     pam_env.so
auth        required                                     pam_faildelay.so delay=2000000
${fl('auth        required                                     pam_faillock.so preauth silent')}auth        sufficient                                   pam_unix.so nullok
${fl('auth        required                                     pam_faillock.so authfail')}auth        required                                     pam_deny.so

${fl('account     required                                     pam_faillock.so')}account     required                                     pam_unix.so

password    requisite                                    pam_pwquality.so local_users_only
password    sufficient                                   pam_unix.so sha512 shadow nullok use_authtok
password    required                                     pam_deny.so

session     optional                                     pam_keyinit.so revoke
session     required                                     pam_limits.so
-session    optional                                     pam_systemd.so
session     [success=1 default=ignore]                   pam_succeed_if.so service in crond quiet use_uid
session     required                                     pam_unix.so
`
}

const UBUNTU_COMMON_AUTH = `#
# /etc/pam.d/common-auth - authentication settings common to all services
#
# This file is included from other service-specific PAM config files,
# and should contain a list of the authentication modules that define
# the central authentication scheme for use on the system.
#
# here are the per-package modules (the "Primary" block)
auth	[success=1 default=ignore]	pam_unix.so nullok
# here's the fallback if no module succeeds
auth	requisite			pam_deny.so
# prime the stack with a positive return value if there isn't one already;
auth	required			pam_permit.so
# and here are more per-package modules (the "Additional" block)
auth	optional			pam_cap.so
# end of pam-auth-update config
`

const UBUNTU_COMMON_PASSWORD = `#
# /etc/pam.d/common-password - password-related modules common to all services
#
# here are the per-package modules (the "Primary" block)
password	[success=1 default=ignore]	pam_unix.so obscure yescrypt
# here's the fallback if no module succeeds
password	requisite			pam_deny.so
# prime the stack with a positive return value if there isn't one already;
password	required			pam_permit.so
# end of pam-auth-update config
`

// ---------------------------------------------------------------------------------------
// Repositorios
// ---------------------------------------------------------------------------------------

const ROCKY_REPO = `# rocky.repo
#
# The mirrorlist system uses the connecting IP address of the client and the
# update status of each mirror to pick current mirrors that are geographically
# close to the client.

[baseos]
name=Rocky Linux $releasever - BaseOS
mirrorlist=https://mirrors.rockylinux.org/mirrorlist?arch=$basearch&repo=BaseOS-$releasever$rltype
#baseurl=http://dl.rockylinux.org/$contentdir/$releasever/BaseOS/$basearch/os/
gpgcheck=1
enabled=1
countme=1
metadata_expire=6h
gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-Rocky-10

[appstream]
name=Rocky Linux $releasever - AppStream
mirrorlist=https://mirrors.rockylinux.org/mirrorlist?arch=$basearch&repo=AppStream-$releasever$rltype
#baseurl=http://dl.rockylinux.org/$contentdir/$releasever/AppStream/$basearch/os/
gpgcheck=1
enabled=1
countme=1
metadata_expire=6h
gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-Rocky-10

[crb]
name=Rocky Linux $releasever - CRB
mirrorlist=https://mirrors.rockylinux.org/mirrorlist?arch=$basearch&repo=CRB-$releasever$rltype
#baseurl=http://dl.rockylinux.org/$contentdir/$releasever/CRB/$basearch/os/
gpgcheck=1
enabled=0
metadata_expire=6h
gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-Rocky-10
`

const ROCKY_EXTRAS_REPO = `[extras]
name=Rocky Linux $releasever - Extras
mirrorlist=https://mirrors.rockylinux.org/mirrorlist?arch=$basearch&repo=extras-$releasever$rltype
#baseurl=http://dl.rockylinux.org/$contentdir/$releasever/extras/$basearch/os/
gpgcheck=1
enabled=1
countme=1
metadata_expire=6h
gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-Rocky-10
`

export const EPEL_REPO = `[epel]
name=Extra Packages for Enterprise Linux $releasever - $basearch
metalink=https://mirrors.fedoraproject.org/metalink?repo=epel-$releasever&arch=$basearch
enabled=1
gpgcheck=1
countme=1
gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-EPEL-10
`

const UBUNTU_SOURCES = `Types: deb
URIs: http://archive.ubuntu.com/ubuntu/
Suites: noble noble-updates noble-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: http://security.ubuntu.com/ubuntu/
Suites: noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
`
