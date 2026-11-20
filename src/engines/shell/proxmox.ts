/**
 * Un nodo de Proxmox VE 9 (Debian 13 "trixie"): máquinas virtuales (qm), contenedores LXC (pct),
 * plantillas de contenedores (pveam), almacenamientos (pvesm), respaldos (vzdump, qmrestore,
 * pct restore), usuarios y permisos (pveum), los puentes de red de /etc/network/interfaces con
 * ifreload, y los repositorios de apt (el enterprise da 401 sin suscripción).
 *
 * Cada invitado guarda su configuración en /etc/pve/qemu-server/ID.conf o /etc/pve/lxc/ID.conf,
 * como en el nodo real; los discos son volúmenes de un almacenamiento (local-lvm, un NFS, un
 * Proxmox Backup Server...), con su tamaño, aunque no tengan contenido.
 */
import { GiB, readImage } from './diskimage'
import { register, type CommandContext } from './shell'
import { System } from './system'
import { ROOT_CRED } from './vfs'
import type { BashState } from './schema'

type PveState = NonNullable<BashState['proxmox']>

export interface PveSnapshot {
  name: string
  time: number
  description: string
  vmstate: boolean
  parent?: string
}

export interface PveGuest {
  vmid: number
  type: 'qemu' | 'lxc'
  status: 'running' | 'stopped'
  template: boolean
  conf: Map<string, string>
  snapshots: PveSnapshot[]
  /** El agente de QEMU corre adentro de la VM (o el contenedor tiene red). */
  agent: boolean
  pid?: number
  ip?: string
  /** El sistema invitado ya está instalado (en una VM nueva sin disco preparado, no). */
  osReady: boolean
}

export interface PveStorage {
  id: string
  type: 'dir' | 'lvmthin' | 'lvm' | 'zfspool' | 'nfs' | 'cifs' | 'pbs'
  content: string[]
  path?: string
  server?: string
  export?: string
  datastore?: string
  username?: string
  fingerprint?: string
  totalBytes: number
  enabled: boolean
  shared: boolean
}

export interface PveVolume {
  volid: string
  storage: string
  vmid?: number
  size: number
  format: string
  content: 'images' | 'rootdir' | 'iso' | 'vztmpl' | 'backup'
  ctime: number
  notes?: string
  /** Para los respaldos: qué tenía la configuración del invitado. */
  guest?: { type: 'qemu' | 'lxc'; conf: [string, string][]; vmid: number }
  /** Un respaldo que no se puede borrar (protegido). */
  protected?: boolean
}

export interface Pve {
  node: string
  version: string
  kernel: string
  subscription: boolean
  guests: Map<number, PveGuest>
  storages: Map<string, PveStorage>
  volumes: Map<string, PveVolume>
  users: Map<string, { comment?: string; enabled: boolean }>
  acls: { path: string; ugid: string; role: string }[]
  /** Puentes aplicados (lo que leyó ifreload). */
  bridges: Map<string, { ports: string[]; vlanAware: boolean; address?: string; vids?: string }>
  nextPid: number
}

const PVE = new WeakMap<System, Pve>()

export function pveOf(sys: System): Pve | undefined {
  return PVE.get(sys)
}

export const PVE_VERSION = '9.2.1'
export const PVE_KERNEL = '7.0.4-1-pve'

const TEMPLATES = [
  'debian-13-standard_13.1-2_amd64.tar.zst',
  'debian-12-standard_12.12-1_amd64.tar.zst',
  'ubuntu-24.04-standard_24.04-2_amd64.tar.zst',
  'rockylinux-10-default_20250610_amd64.tar.xz',
  'almalinux-10-default_20250611_amd64.tar.xz',
  'alpine-3.22-default_20250617_amd64.tar.xz',
]

const DEFAULT_INTERFACES = (ip: string, gw: string, nic: string, others: string[] = []) => `auto lo
iface lo inet loopback

iface ${nic} inet manual
${others.map((o) => `\niface ${o} inet manual\n`).join('')}
auto vmbr0
iface vmbr0 inet static
	address ${ip}
	gateway ${gw}
	bridge-ports ${nic}
	bridge-stp off
	bridge-fd 0

source /etc/network/interfaces.d/*
`

const ENTERPRISE = `Types: deb
URIs: https://enterprise.proxmox.com/debian/pve
Suites: trixie
Components: pve-enterprise
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
`
const CEPH_ENTERPRISE = `Types: deb
URIs: https://enterprise.proxmox.com/debian/ceph-squid
Suites: trixie
Components: enterprise
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
`
const NO_SUB = `Types: deb
URIs: http://download.proxmox.com/debian/pve
Suites: trixie
Components: pve-no-subscription
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
`
const DEBIAN_SOURCES = `Types: deb
URIs: http://deb.debian.org/debian/
Suites: trixie trixie-updates
Components: main contrib non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

Types: deb
URIs: http://security.debian.org/debian-security/
Suites: trixie-security
Components: main contrib non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
`

function gb(n: number) {
  return Math.round(n * GiB)
}

function hex(n: number) {
  return Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('')
}

function mac() {
  const b = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase()
  return `BC:24:11:${b()}:${b()}:${b()}`
}

/** "local-lvm:32" o "local-lvm:vm-100-disk-0,size=32G" → partes. */
function parseDrive(v: string): { volid?: string; storage: string; newSize?: number; opts: Map<string, string>; importFrom?: string } {
  const [first, ...rest] = v.split(',')
  const opts = new Map(rest.map((p) => p.split('=') as [string, string]))
  const [storage, vol] = first.split(':')
  if (vol !== undefined && /^\d+(\.\d+)?$/.test(vol)) return { storage, newSize: Number(vol) * GiB, opts, importFrom: opts.get('import-from') }
  return { volid: first.includes(':') ? first : undefined, storage, opts }
}

function sizeStr(b: number) {
  const g = b / GiB
  return Number.isInteger(g) ? `${g}G` : `${Math.round(b / 1024 / 1024)}M`
}

function fmtTime(t: number) {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fileTime(t: number) {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}_${p(d.getMonth() + 1)}_${p(d.getDate())}-${p(d.getHours())}_${p(d.getMinutes())}_${p(d.getSeconds())}`
}

function pbsTime(t: number) {
  return new Date(t).toISOString().replace(/\.\d+Z$/, 'Z')
}

// ---------------------------------------------------------------------------------------
// Inicio
// ---------------------------------------------------------------------------------------

System.initHooks.push((sys, state) => {
  if (!state.proxmox) return
  setupNode(sys, state.proxmox, state)
})

function confPath(g: PveGuest) {
  return g.type === 'qemu' ? `/etc/pve/qemu-server/${g.vmid}.conf` : `/etc/pve/lxc/${g.vmid}.conf`
}

/** Escribe la configuración del invitado como la guarda Proxmox (claves ordenadas y las instantáneas). */
export function saveConf(sys: System, g: PveGuest) {
  const lines = (m: Map<string, string>) => [...m.entries()].filter(([k]) => !k.startsWith('#')).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}: ${v}`).join('\n')
  let text = ''
  const desc = g.conf.get('#description')
  if (desc) text += desc.split('\n').map((l) => `#${l}`).join('\n') + '\n'
  text += lines(g.conf) + '\n'
  for (const s of g.snapshots) text += `\n[${s.name}]\n${s.description ? `description: ${s.description}\n` : ''}${s.parent ? `parent: ${s.parent}\n` : ''}snaptime: ${Math.floor(s.time / 1000)}\n${s.vmstate ? `vmstate: local-lvm:vm-${g.vmid}-state-${s.name}\n` : ''}`
  sys.vfs.mkdirp(confPath(g).replace(/\/[^/]+$/, ''), ROOT_CRED)
  sys.vfs.writeFile(confPath(g), text, ROOT_CRED, { mode: 0o640 })
}

function addVolume(pve: Pve, v: Omit<PveVolume, 'ctime'> & { ctime?: number }) {
  pve.volumes.set(v.volid, { ctime: Date.now(), ...v })
}

function dirOf(_sys: System, st: PveStorage, content: string) {
  const base = st.type === 'nfs' || st.type === 'cifs' ? `/mnt/pve/${st.id}` : (st.path ?? `/mnt/pve/${st.id}`)
  if (content === 'iso') return `${base}/template/iso`
  if (content === 'vztmpl') return `${base}/template/cache`
  if (content === 'backup') return `${base}/dump`
  return `${base}/images`
}

/** Los archivos de un almacenamiento de tipo directorio también existen en el disco. */
function touchFile(sys: System, pve: Pve, v: PveVolume) {
  const st = pve.storages.get(v.storage)
  if (!st || st.type === 'lvmthin' || st.type === 'lvm' || st.type === 'zfspool' || st.type === 'pbs') return
  const file = v.volid.split(':')[1].replace(/^(iso|vztmpl|backup)\//, '')
  const dir = dirOf(sys, st, v.content)
  sys.vfs.mkdirp(dir, ROOT_CRED)
  const path = `${dir}/${file}`
  sys.vfs.writeFile(path, v.content === 'backup' ? 'VMA\n' : '', ROOT_CRED)
  sys.vfs.stat(path, ROOT_CRED).size = v.size
  if (v.notes !== undefined) sys.vfs.writeFile(`${path}.notes`, v.notes + '\n', ROOT_CRED)
  if (v.content === 'backup') sys.vfs.writeFile(path.replace(/\.(vma|tar)(\.zst)?$/, '.log'), `${fmtTime(v.ctime)} INFO: Starting Backup of VM ${v.vmid}\n${fmtTime(v.ctime + 26000)} INFO: Finished Backup of VM ${v.vmid}\n`, ROOT_CRED)
}

function setupNode(sys: System, p: PveState, state: BashState) {
  const pve: Pve = {
    node: p.nodo ?? sys.hostname,
    version: PVE_VERSION,
    kernel: PVE_KERNEL,
    subscription: p.suscripcion,
    guests: new Map(),
    storages: new Map(),
    volumes: new Map(),
    users: new Map([['root@pam', { comment: '', enabled: true }]]),
    acls: [],
    bridges: new Map(),
    nextPid: 2210,
  }
  PVE.set(sys, pve)
  sys.installPackage('proxmox-ve', true)
  sys.kernelRelease = PVE_KERNEL
  sys.kernelBuild = '#1 SMP PREEMPT_DYNAMIC PMX 7.0.4-1 (2026-10-28T09:15Z)'
  sys.aptMirror = 'http://deb.debian.org/debian trixie/main'
  const w = (path: string, text: string, mode = 0o644) => {
    sys.vfs.mkdirp(path.replace(/\/[^/]+$/, ''), ROOT_CRED)
    sys.vfs.writeFile(path, text, ROOT_CRED, { mode })
  }
  w('/etc/os-release', 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nNAME="Debian GNU/Linux"\nVERSION_ID="13"\nVERSION="13 (trixie)"\nVERSION_CODENAME=trixie\nDEBIAN_VERSION_FULL=13.5\nID=debian\nHOME_URL="https://www.debian.org/"\nSUPPORT_URL="https://www.debian.org/support"\nBUG_REPORT_URL="https://bugs.debian.org/"\n')
  w('/etc/debian_version', '13.5\n')
  if (sys.vfs.exists('/etc/apt/sources.list.d/ubuntu.sources')) sys.vfs.unlink('/etc/apt/sources.list.d/ubuntu.sources', ROOT_CRED)
  w('/etc/apt/sources.list.d/debian.sources', DEBIAN_SOURCES)
  if (p.repos === 'enterprise') {
    w('/etc/apt/sources.list.d/pve-enterprise.sources', ENTERPRISE)
    w('/etc/apt/sources.list.d/ceph.sources', CEPH_ENTERPRISE)
  } else w('/etc/apt/sources.list.d/proxmox.sources', NO_SUB)
  // Red: vmbr0 sobre la placa física, con la IP del nodo.
  const first = sys.interfaces.find((i) => i.name !== 'lo')
  const ip = first?.ip ?? '192.168.10.21/24'
  const gw = state.red.puerta_enlace ?? ip.replace(/\.\d+\/\d+$/, '.1')
  const nic = p.placa ?? 'eno1'
  if (first) {
    first.name = 'vmbr0'
    first.ip = ip
  }
  sys.interfaces.push({ name: nic, mac: first?.mac ?? '00:1b:21:3a:4f:10', up: true, ipv6: [], dhcp: false, speed: 1000, duplex: 'full', autoneg: true, mtu: 1500 })
  const others = sys.interfaces.filter((i) => i.name !== 'lo' && i.name !== 'vmbr0' && i.name !== nic).map((i) => i.name)
  w('/etc/network/interfaces', p.interfaces ?? DEFAULT_INTERFACES(ip, gw, nic, others))
  w('/etc/hosts', `127.0.0.1 localhost.localdomain localhost\n${ip.split('/')[0]} ${sys.hostname}.lab.local ${sys.hostname}\n\n# The following lines are desirable for IPv6 capable hosts\n::1     ip6-localhost ip6-loopback\n`)
  applyInterfaces(sys, pve)
  // Almacenamientos
  const storages = p.almacenamientos.length
    ? p.almacenamientos
    : [
        { id: 'local', tipo: 'dir' as const, contenido: ['iso', 'vztmpl', 'backup'], ruta: '/var/lib/vz', total_gb: 94, compartido: false, activo: true },
        { id: 'local-lvm', tipo: 'lvmthin' as const, contenido: ['images', 'rootdir'], total_gb: 350, compartido: false, activo: true },
      ]
  for (const s of storages) {
    pve.storages.set(s.id, { id: s.id, type: s.tipo, content: s.contenido, path: s.ruta ?? (s.tipo === 'dir' ? `/mnt/${s.id}` : undefined), server: s.servidor, export: s.export, datastore: s.datastore, username: s.usuario, fingerprint: s.huella, totalBytes: gb(s.total_gb), enabled: s.activo, shared: s.compartido || s.tipo === 'nfs' || s.tipo === 'cifs' || s.tipo === 'pbs' })
  }
  writeStorageCfg(sys, pve)
  for (const iso of p.isos) addVolume(pve, { volid: `local:iso/${iso}`, storage: 'local', size: gb(/server|netinst/.test(iso) ? 0.8 : 3.1), format: 'iso', content: 'iso' })
  for (const t of p.plantillas_ct) addVolume(pve, { volid: `local:vztmpl/${t}`, storage: 'local', size: gb(0.13), format: t.endsWith('.zst') ? 'tzst' : 'txz', content: 'vztmpl' })
  for (const v of pve.volumes.values()) touchFile(sys, pve, v)
  // Invitados
  for (const vm of p.vms) {
    const conf = new Map<string, string>([
      ['name', vm.nombre],
      ['memory', String(vm.memoria)],
      ['cores', String(vm.nucleos)],
      ['sockets', '1'],
      ['ostype', vm.so],
      ['scsihw', 'virtio-scsi-single'],
      ['boot', 'order=scsi0;net0'],
      ['smbios1', `uuid=${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`],
      ['vmgenid', `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`],
      ['cpu', 'x86-64-v2-AES'],
    ])
    if (vm.agente) conf.set('agent', '1')
    if (vm.onboot) conf.set('onboot', '1')
    const disks = Object.keys(vm.discos).length ? vm.discos : { scsi0: `local-lvm:vm-${vm.id}-disk-0,iothread=1,size=32G` }
    for (const [k, v] of Object.entries(disks)) {
      conf.set(k, v)
      const d = parseDrive(v)
      if (d.volid && !pve.volumes.has(d.volid)) addVolume(pve, { volid: d.volid, storage: d.storage, vmid: vm.id, size: Number(/size=(\d+)G/.exec(v)?.[1] ?? 32) * GiB, format: 'raw', content: 'images' })
    }
    const nets = Object.keys(vm.red).length ? vm.red : { net0: `virtio=${mac()},bridge=vmbr0,firewall=1` }
    for (const [k, v] of Object.entries(nets)) conf.set(k, /virtio=|e1000=/.test(v) ? v : v.replace(/^virtio/, `virtio=${mac()}`))
    for (const [k, v] of Object.entries(vm.otros)) conf.set(k, v)
    if (vm.plantilla) conf.set('template', '1')
    const g: PveGuest = { vmid: vm.id, type: 'qemu', status: 'stopped', template: vm.plantilla, conf, snapshots: vm.instantaneas.map((n, i, all) => ({ name: n, time: Date.now() - (all.length - i) * 86_400_000, description: '', vmstate: false, parent: i ? all[i - 1] : undefined })), agent: vm.agente, osReady: true }
    if (g.snapshots.length) conf.set('parent', g.snapshots.at(-1)!.name)
    pve.guests.set(vm.id, g)
    if (vm.estado === 'running') startGuest(sys, pve, g)
    saveConf(sys, g)
  }
  for (const ct of p.cts) {
    const conf = new Map<string, string>([
      ['arch', 'amd64'],
      ['hostname', ct.nombre],
      ['memory', String(ct.memoria)],
      ['swap', '512'],
      ['cores', String(ct.nucleos)],
      ['ostype', ct.so],
      ['rootfs', ct.rootfs ?? `local-lvm:vm-${ct.id}-disk-0,size=8G`],
      ['net0', ct.red ?? `name=eth0,bridge=vmbr0,firewall=1,hwaddr=${mac()},ip=dhcp,type=veth`],
    ])
    if (ct.sin_privilegios) conf.set('unprivileged', '1')
    if (ct.onboot) conf.set('onboot', '1')
    const d = parseDrive(conf.get('rootfs')!)
    if (d.volid) addVolume(pve, { volid: d.volid, storage: d.storage, vmid: ct.id, size: Number(/size=(\d+)G/.exec(conf.get('rootfs')!)?.[1] ?? 8) * GiB, format: 'raw', content: 'rootdir' })
    const g: PveGuest = { vmid: ct.id, type: 'lxc', status: 'stopped', template: false, conf, snapshots: [], agent: true, osReady: true }
    pve.guests.set(ct.id, g)
    if (ct.estado === 'running') startGuest(sys, pve, g)
    saveConf(sys, g)
  }
  for (const r of p.respaldos) {
    const g = pve.guests.get(r.vmid)
    const t = Date.now() - r.dias_atras * 86_400_000
    makeBackup(sys, pve, g ?? fakeGuest(r.vmid, r.tipo), r.almacenamiento, t, r.proteger)
  }
  for (const u of p.usuarios) pve.users.set(u.id, { comment: u.comentario, enabled: true })
  for (const a of p.permisos) pve.acls.push({ path: a.ruta, ugid: a.usuario, role: a.rol })
  writeUserCfg(sys, pve)
}

function fakeGuest(vmid: number, type: 'qemu' | 'lxc'): PveGuest {
  return { vmid, type, status: 'stopped', template: false, conf: new Map([[type === 'qemu' ? 'name' : 'hostname', `invitado${vmid}`], ['memory', '2048'], ['cores', '2']]), snapshots: [], agent: false, osReady: true }
}

function writeStorageCfg(sys: System, pve: Pve) {
  let text = ''
  for (const s of pve.storages.values()) {
    text += `${s.type}: ${s.id}\n`
    if (s.type === 'dir') text += `\tpath ${s.path}\n`
    if (s.type === 'lvmthin') text += `\tthinpool data\n\tvgname pve\n`
    if (s.type === 'zfspool') text += `\tpool ${s.path ?? 'rpool/data'}\n\tsparse 1\n`
    if (s.type === 'nfs' || s.type === 'cifs') text += `\texport ${s.export ?? ''}\n\tpath /mnt/pve/${s.id}\n\tserver ${s.server ?? ''}\n`
    if (s.type === 'pbs') text += `\tdatastore ${s.datastore ?? ''}\n\tserver ${s.server ?? ''}\n${s.fingerprint ? `\tfingerprint ${s.fingerprint}\n` : ''}\tusername ${s.username ?? ''}\n`
    text += `\tcontent ${s.content.join(',')}\n`
    if (!s.enabled) text += '\tdisable\n'
    text += '\n'
  }
  sys.vfs.mkdirp('/etc/pve', ROOT_CRED)
  sys.vfs.writeFile('/etc/pve/storage.cfg', text, ROOT_CRED, { mode: 0o640 })
}

function writeUserCfg(sys: System, pve: Pve) {
  let text = ''
  for (const [id, u] of pve.users) text += `user:${id}:${u.enabled ? 1 : 0}:0:::${u.comment ?? ''}::\n`
  text += '\n'
  for (const a of pve.acls) text += `acl:1:${a.path}:${a.ugid}:${a.role}:\n`
  sys.vfs.writeFile('/etc/pve/user.cfg', text, ROOT_CRED, { mode: 0o640 })
}

// ---------------------------------------------------------------------------------------
// Red: /etc/network/interfaces e ifreload
// ---------------------------------------------------------------------------------------

/** Lee /etc/network/interfaces y deja aplicados los puentes (como ifreload -a). Devuelve un error de sintaxis si hay. */
export function applyInterfaces(sys: System, pve: Pve): string | undefined {
  const text = sys.vfs.exists('/etc/network/interfaces') ? sys.vfs.readFile('/etc/network/interfaces', ROOT_CRED) : ''
  const blocks = new Map<string, { attrs: Map<string, string>; auto: boolean; method: string }>()
  let cur: { attrs: Map<string, string>; auto: boolean; method: string } | undefined
  const autos = new Set<string>()
  for (const [n, raw] of text.split('\n').entries()) {
    const l = raw.replace(/#.*$/, '').trim()
    if (!l) continue
    const words = l.split(/\s+/)
    if (words[0] === 'auto' || words[0] === 'allow-hotplug') {
      words.slice(1).forEach((x) => autos.add(x))
      cur = undefined
      continue
    }
    if (words[0] === 'iface') {
      if (words.length < 4) return `error: /etc/network/interfaces: line${n + 1}: invalid iface definition`
      cur = { attrs: new Map(), auto: false, method: words[3] }
      blocks.set(words[1], cur)
      continue
    }
    if (words[0] === 'source') continue
    if (!cur) return `error: /etc/network/interfaces: line${n + 1}: invalid keyword ${words[0]}`
    cur.attrs.set(words[0], words.slice(1).join(' '))
  }
  pve.bridges.clear()
  // Bonds: dos o más placas juntas (active-backup, 802.3ad/LACP, balance-alb...).
  for (const [name, b] of blocks) {
    const slaves = b.attrs.get('bond-slaves')
    if (!slaves) continue
    const list = slaves.split(/\s+/).filter((x) => x !== 'none')
    for (const sl of list) if (!sys.interfaces.some((i) => i.name === sl)) return `error: ${name}: bond slave ${sl} does not exist`
    const mode = b.attrs.get('bond-mode') ?? 'balance-rr'
    if (!['balance-rr', 'active-backup', 'balance-xor', 'broadcast', '802.3ad', 'balance-tlb', 'balance-alb'].includes(mode)) return `error: ${name}: invalid bond-mode ${mode}`
    let iface = sys.interfaces.find((i) => i.name === name)
    if (!iface) {
      iface = { name, mac: sys.interfaces.find((i) => i.name === list[0])?.mac ?? `bc:24:11:${hex(2)}:${hex(2)}:${hex(2)}`, up: autos.has(name), ipv6: [], dhcp: false, speed: 1000 * (mode === 'active-backup' ? 1 : list.length), duplex: 'full', autoneg: false, mtu: 1500 }
      sys.interfaces.push(iface)
    }
    iface.up = autos.has(name)
    const names: Record<string, string> = { 'balance-rr': 'load balancing (round-robin)', 'active-backup': 'fault-tolerance (active-backup)', 'balance-xor': 'load balancing (xor)', broadcast: 'fault-tolerance (broadcast)', '802.3ad': 'IEEE 802.3ad Dynamic link aggregation', 'balance-tlb': 'transmit load balancing', 'balance-alb': 'adaptive load balancing' }
    let proc = `Ethernet Channel Bonding Driver: v${PVE_KERNEL}\n\nBonding Mode: ${names[mode]}\n`
    if (mode === 'active-backup') proc += `Primary Slave: None\nCurrently Active Slave: ${list[0]}\n`
    if (mode === '802.3ad') proc += `Transmit Hash Policy: ${b.attrs.get('bond-xmit-hash-policy') ?? 'layer2'} (0)\n`
    proc += `MII Status: up\nMII Polling Interval (ms): ${b.attrs.get('bond-miimon') ?? '0'}\nUp Delay (ms): 0\nDown Delay (ms): 0\n`
    if (mode === '802.3ad') proc += `\n802.3ad info\nLACP active: on\nLACP rate: slow\nAggregator selection policy (ad_select): stable\n`
    for (const sl of list) proc += `\nSlave Interface: ${sl}\nMII Status: up\nSpeed: 1000 Mbps\nDuplex: full\nLink Failure Count: 0\nPermanent HW addr: ${sys.interfaces.find((i) => i.name === sl)?.mac}\nSlave queue ID: 0\n`
    sys.vfs.mkdirp('/proc/net/bonding', ROOT_CRED)
    sys.vfs.writeFile(`/proc/net/bonding/${name}`, proc, ROOT_CRED)
  }
  for (const [name, b] of blocks) {
    if (!b.attrs.has('bridge-ports')) continue
    const ports = (b.attrs.get('bridge-ports') ?? 'none').split(/\s+/).filter((x) => x !== 'none')
    for (const pt of ports) if (!sys.interfaces.some((i) => i.name === pt) && !blocks.has(pt)) return `error: ${name}: bridge port ${pt} does not exist`
    pve.bridges.set(name, { ports, vlanAware: b.attrs.get('bridge-vlan-aware') === 'yes', address: b.attrs.get('address'), vids: b.attrs.get('bridge-vids') })
    const up = autos.has(name)
    let iface = sys.interfaces.find((i) => i.name === name)
    if (!iface && up) {
      iface = { name, mac: `bc:24:11:${hex(2)}:${hex(2)}:${hex(2)}`, up: true, ipv6: [], dhcp: false, speed: 0, duplex: 'full', autoneg: false, mtu: 1500 }
      sys.interfaces.push(iface)
    }
    if (iface) {
      iface.up = up
      const addr = b.attrs.get('address')
      iface.ip = addr ? (addr.includes('/') ? addr : `${addr}/${b.attrs.get('netmask') ? 24 : 24}`) : undefined
    }
  }
  // Puentes que ya no están en el archivo
  for (const i of [...sys.interfaces]) if (/^vmbr\d+$/.test(i.name) && !pve.bridges.has(i.name)) sys.interfaces.splice(sys.interfaces.indexOf(i), 1)
  return undefined
}

register('ifreload', {
  usage: 'ifreload -a',
  path: '/usr/sbin',
  run(ctx) {
    const pve = pveOf(ctx.sys)
    if (ctx.sh.user !== 'root') {
      ctx.err('error: must be root to run this command\n')
      return 1
    }
    if (!ctx.args.includes('-a')) {
      ctx.err('error: -a or interface list is required\n')
      return 1
    }
    if (!pve) return 0
    const e = applyInterfaces(ctx.sys, pve)
    if (e) {
      ctx.err(e + '\n')
      return 1
    }
    // Los invitados en marcha conectados a un puente que ya no existe pierden la red.
    return 0
  },
})

register('bridge', {
  usage: 'bridge vlan show | bridge link',
  path: '/usr/sbin',
  run(ctx) {
    const pve = pveOf(ctx.sys)
    const [obj, verb] = ctx.args
    if (obj === 'vlan' && (!verb || verb === 'show')) {
      ctx.out('port              vlan-id  \n')
      for (const [name, b] of pve?.bridges ?? []) {
        if (!b.vlanAware) continue
        for (const p of b.ports) ctx.out(`${p.padEnd(18)}1 PVID Egress Untagged\n${' '.repeat(18)}2-4094\n`)
        ctx.out(`${name.padEnd(18)}1 PVID Egress Untagged\n`)
        for (const g of pve!.guests.values()) {
          if (g.status !== 'running') continue
          for (const [k, v] of g.conf) {
            if (!/^net\d+$/.test(k) || !v.includes(`bridge=${name}`)) continue
            const tag = /tag=(\d+)/.exec(v)?.[1]
            const port = g.type === 'qemu' ? `tap${g.vmid}i${k.slice(3)}` : `veth${g.vmid}i${k.slice(3)}`
            ctx.out(`${port.padEnd(18)}${tag ? `${tag} PVID Egress Untagged` : '1 PVID Egress Untagged'}\n`)
          }
        }
      }
      return 0
    }
    if (obj === 'link') {
      let i = 2
      for (const [name, b] of pve?.bridges ?? []) for (const p of b.ports) ctx.out(`${i++}: ${p}: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 master ${name} state forwarding priority 32 cost 4 \n`)
      return 0
    }
    ctx.err('Usage: bridge [ OPTIONS ] OBJECT { COMMAND | help }\nwhere  OBJECT := { link | fdb | mdb | vlan | vni | monitor }\n')
    return 1
  },
})

// ---------------------------------------------------------------------------------------
// apt en Proxmox
// ---------------------------------------------------------------------------------------

System.aptUpdateHooks.push((sys) => {
  const pve = pveOf(sys)
  if (!pve) return undefined
  const dir = '/etc/apt/sources.list.d'
  const files = sys.vfs.exists(dir) ? sys.vfs.readdir(dir, ROOT_CRED).filter((f) => f.endsWith('.sources') || f.endsWith('.list')) : []
  const repos: { url: string; suite: string; comp: string }[] = []
  for (const f of files) {
    const text = sys.vfs.readFile(`${dir}/${f}`, ROOT_CRED)
    if (f.endsWith('.list')) {
      for (const l of text.split('\n')) {
        const m = /^\s*deb\s+(?:\[[^\]]*\]\s+)?(\S+)\s+(\S+)\s+(.+)$/.exec(l)
        if (m) repos.push({ url: m[1].replace(/\/$/, ''), suite: m[2], comp: m[3] })
      }
      continue
    }
    for (const stanza of text.split(/\n\s*\n/)) {
      if (/^Enabled:\s*(no|false)/im.test(stanza)) continue
      const url = /^URIs:\s*(\S+)/m.exec(stanza)?.[1]
      const suites = /^Suites:\s*(.+)$/m.exec(stanza)?.[1]?.split(/\s+/) ?? []
      const comp = /^Components:\s*(.+)$/m.exec(stanza)?.[1] ?? ''
      if (url) for (const s of suites) repos.push({ url: url.replace(/\/$/, ''), suite: s, comp })
    }
  }
  let out = ''
  let err = ''
  let n = 0
  const bad: string[] = []
  for (const r of repos) {
    n++
    if (r.url.includes('enterprise.proxmox.com') && !pve.subscription) {
      out += `Err:${n} ${r.url} ${r.suite} InRelease\n  401  Unauthorized [IP: 212.224.123.70 443]\n`
      bad.push(`${r.url} ${r.suite}`)
    } else if (r.suite !== 'trixie' && !r.suite.startsWith('trixie')) {
      out += `Ign:${n} ${r.url} ${r.suite} InRelease\nErr:${n} ${r.url} ${r.suite} Release\n  404  Not Found [IP: 212.224.123.70 80]\n`
      bad.push(`${r.url} ${r.suite} Release`)
    } else out += `${n % 2 ? 'Hit' : 'Get'}:${n} ${r.url} ${r.suite} InRelease${n % 2 ? '' : ' [47.3 kB]'}\n`
  }
  out += 'Reading package lists... Done\n'
  for (const b of bad) {
    if (b.endsWith('Release')) err += `E: The repository '${b}' does not have a Release file.\nN: Updating from such a repository can't be done securely, and is therefore disabled by default.\nN: See apt-secure(8) manpage for repository creation and user configuration details.\n`
    else {
      const [url, suite] = b.split(' ')
      err += `E: Failed to fetch ${url}/dists/${suite}/InRelease  401  Unauthorized [IP: 212.224.123.70 443]\nE: The repository '${url} ${suite} InRelease' is not signed.\nN: Updating from such a repository can't be done securely, and is therefore disabled by default.\nN: See apt-secure(8) manpage for repository creation and user configuration details.\n`
    }
  }
  if (!bad.length) out += `Building dependency tree... Done\nReading state information... Done\n${sys.upgradable.size ? `${sys.upgradable.size} package${sys.upgradable.size > 1 ? 's' : ''} can be upgraded. Run 'apt list --upgradable' to see ${sys.upgradable.size > 1 ? 'them' : 'it'}.` : 'All packages are up to date.'}\n`
  return { out, err, code: bad.length ? 100 : 0 }
})

// ---------------------------------------------------------------------------------------
// Invitados: arrancar, parar, volúmenes
// ---------------------------------------------------------------------------------------

function bridgeOk(pve: Pve, g: PveGuest): string | undefined {
  for (const [k, v] of g.conf) {
    if (!/^net\d+$/.test(k)) continue
    const br = /bridge=([^,]+)/.exec(v)?.[1]
    if (br && !pve.bridges.has(br)) return `bridge '${br}' does not exist`
  }
  return undefined
}

function guestIp(_sys: System, pve: Pve, g: PveGuest): string | undefined {
  const net = g.conf.get('net0') ?? ''
  const fixed = /ip=(\d+\.\d+\.\d+\.\d+)/.exec(net)?.[1] ?? /ip=(\d+\.\d+\.\d+\.\d+)/.exec(g.conf.get('ipconfig0') ?? '')?.[1]
  if (fixed) return fixed
  const br = /bridge=([^,]+)/.exec(net)?.[1]
  const tag = /tag=(\d+)/.exec(net)?.[1]
  const addr = br ? pve.bridges.get(br)?.address : undefined
  if (!addr && !tag) return undefined
  const base = tag ? `10.${Number(tag) % 256}.0` : addr!.split('/')[0].split('.').slice(0, 3).join('.')
  return `${base}.${100 + (g.vmid % 100)}`
}

export function startGuest(sys: System, pve: Pve, g: PveGuest): string | undefined {
  const e = bridgeOk(pve, g)
  if (e) return e
  if (g.type === 'qemu') {
    for (const [k, v] of g.conf) {
      if (!/^(scsi|virtio|sata|ide)\d+$/.test(k)) continue
      const d = parseDrive(v)
      if (d.volid && d.volid !== 'none' && !pve.volumes.has(d.volid) && !v.includes('media=cdrom')) return `volume '${d.volid}' does not exist`
      if (v.includes('media=cdrom') && d.volid && d.volid !== 'none' && !/cloudinit$/.test(d.volid) && !pve.volumes.has(d.volid)) return `volume '${d.volid}' does not exist`
    }
    const memMb = Number(g.conf.get('memory') ?? 512)
    const used = [...pve.guests.values()].filter((x) => x.status === 'running').reduce((s, x) => s + Number(x.conf.get('memory') ?? 0), 0)
    if ((used + memMb) * 1024 > sys.memTotalKb * 1.5) return `start failed: QEMU exited with code 1\nkvm: cannot set up guest memory 'pc.ram': Cannot allocate memory`
  }
  g.status = 'running'
  g.pid = pve.nextPid++
  g.ip = guestIp(sys, pve, g)
  sys.log(g.type === 'qemu' ? 'qmeventd.service' : 'pve-container@.service', `Starting ${g.type === 'qemu' ? 'VM' : 'CT'} ${g.vmid}`)
  return undefined
}

function stopGuest(g: PveGuest) {
  g.status = 'stopped'
  g.pid = undefined
  g.ip = undefined
}

function storageCheck(pve: Pve, id: string, content: string): string | undefined {
  const st = pve.storages.get(id)
  if (!st) return `storage '${id}' does not exist`
  if (!st.enabled) return `storage '${id}' is disabled`
  if (!st.content.includes(content)) return `storage '${id}' does not support content-type '${content}'`
  return undefined
}

function lvCreated(pve: Pve, storage: string, name: string) {
  const st = pve.storages.get(storage)
  if (st?.type === 'lvmthin' || st?.type === 'lvm') return `  Logical volume "${name}" created.\n`
  return ''
}

function nextDiskName(pve: Pve, storage: string, vmid: number, prefix = 'vm') {
  let i = 0
  while (pve.volumes.has(`${storage}:${prefix}-${vmid}-disk-${i}`)) i++
  return `${prefix}-${vmid}-disk-${i}`
}

function usedBytes(pve: Pve, storage: string) {
  let n = 0
  for (const v of pve.volumes.values()) if (v.storage === storage) n += v.content === 'images' || v.content === 'rootdir' ? v.size * 0.18 : v.size
  return Math.round(n + (pve.storages.get(storage)?.type === 'dir' ? 4.2 * GiB : 0))
}

// ---------------------------------------------------------------------------------------
// Respaldos
// ---------------------------------------------------------------------------------------

function guestName(g: PveGuest) {
  return g.conf.get(g.type === 'qemu' ? 'name' : 'hostname') ?? `${g.vmid}`
}

function diskTotal(pve: Pve, g: PveGuest) {
  let n = 0
  for (const [k, v] of g.conf) {
    if (!/^(scsi|virtio|sata|ide)\d+$|^rootfs$|^mp\d+$/.test(k) || v.includes('media=cdrom')) continue
    const d = parseDrive(v)
    n += d.volid ? (pve.volumes.get(d.volid)?.size ?? 0) : 0
  }
  return n
}

function makeBackup(sys: System, pve: Pve, g: PveGuest, storage: string, time: number, protect = false): PveVolume {
  let t = time
  const st = pve.storages.get(storage)!
  const isPbs = st.type === 'pbs'
  const kind = g.type === 'qemu' ? 'vm' : 'ct'
  const size = Math.max(0.2 * GiB, diskTotal(pve, g) * 0.07)
  // Dos respaldos en el mismo segundo no pueden tener el mismo nombre.
  while ([...pve.volumes.keys()].some((k) => k.includes(`-${g.vmid}-${fileTime(t)}`) || k.endsWith(`/${g.vmid}/${pbsTime(t)}`))) t += 1000
  const volid = isPbs ? `${storage}:backup/${kind}/${g.vmid}/${pbsTime(t)}` : `${storage}:backup/vzdump-${g.type}-${g.vmid}-${fileTime(t)}.${g.type === 'qemu' ? 'vma.zst' : 'tar.zst'}`
  const v: PveVolume = { volid, storage, vmid: g.vmid, size, format: isPbs ? (g.type === 'qemu' ? 'pbs-vm' : 'pbs-ct') : g.type === 'qemu' ? 'vma.zst' : 'tar.zst', content: 'backup', ctime: t, guest: { type: g.type, conf: [...g.conf.entries()], vmid: g.vmid }, protected: protect }
  pve.volumes.set(volid, v)
  touchFile(sys, pve, v)
  return v
}

// ---------------------------------------------------------------------------------------
// qm
// ---------------------------------------------------------------------------------------

function parseOpts(args: string[]): { pos: string[]; opts: Map<string, string> } {
  const pos: string[] = []
  const opts = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('--') || (a.startsWith('-') && a.length > 2 && !/^-\d/.test(a))) {
      const key = a.replace(/^--?/, '')
      if (key.includes('=')) {
        opts.set(key.split('=')[0], key.slice(key.indexOf('=') + 1))
        continue
      }
      const next = args[i + 1]
      if (next !== undefined && (!next.startsWith('-') || /^-\d/.test(next))) {
        opts.set(key, next)
        i++
      } else opts.set(key, '1')
    } else pos.push(a)
  }
  return { pos, opts }
}

function needRoot(ctx: CommandContext): boolean {
  if (ctx.sh.user === 'root') return true
  ctx.err('only root can run this command\n')
  return false
}

function node(ctx: CommandContext): Pve | undefined {
  const pve = pveOf(ctx.sys)
  if (!pve) ctx.err(`bash: ${ctx.name}: command not found\n`)
  return pve
}

const QM_KEYS = new Set(['name', 'memory', 'balloon', 'cores', 'sockets', 'cpu', 'ostype', 'scsihw', 'boot', 'agent', 'onboot', 'startup', 'description', 'tags', 'bios', 'machine', 'efidisk0', 'tpmstate0', 'serial0', 'vga', 'protection', 'ciuser', 'cipassword', 'sshkeys', 'ipconfig0', 'ipconfig1', 'nameserver', 'searchdomain', 'citype', 'numa', 'hotplug', 'kvm'])

function isDriveKey(k: string) {
  return /^(scsi|virtio|sata|ide)\d+$|^efidisk0$|^tpmstate0$/.test(k)
}

/** Aplica opciones de qm create / qm set. Devuelve la salida o un error. */
function applyQmOpts(sys: System, pve: Pve, g: PveGuest, opts: Map<string, string>, creating: boolean): { out: string } | { error: string } {
  let out = ''
  for (const [k, raw] of opts) {
    if (k === 'start' || k === 'pool' || k === 'storage') continue
    if (k === 'delete') {
      for (const d of raw.split(',')) g.conf.delete(d)
      continue
    }
    if (!(QM_KEYS.has(k) || isDriveKey(k) || /^net\d+$/.test(k) || /^unused\d+$/.test(k))) return { error: `400 Parameter verification failed.\n${k}: property is not defined in schema and the schema does not allow additional properties` }
    let v = raw
    if (k === 'sshkeys') {
      const p = v.startsWith('/') ? v : `${'/root'}/${v.replace(/^~\//, '')}`
      if (!sys.vfs.exists(p)) return { error: `400 Parameter verification failed.\nsshkeys: unable to read file '${v}'` }
      v = encodeURIComponent(sys.vfs.readFile(p, ROOT_CRED).trim())
    }
    if (k === 'cipassword') v = '$5$' + hex(16) + '$' + hex(43)
    if (isDriveKey(k)) {
      const d = parseDrive(v)
      if (v.includes('media=cdrom')) {
        if (d.volid && d.volid !== 'none' && !/cloudinit$/.test(d.volid) && !pve.volumes.has(d.volid)) return { error: `400 Parameter verification failed.\n${k}: volume '${d.volid}' does not exist` }
      }
      if (/cloudinit$/.test(d.volid ?? '') || v.endsWith(':cloudinit')) {
        const se = storageCheck(pve, d.storage, 'images')
        if (se) return { error: `400 Parameter verification failed.\n${k}: ${se}` }
        const name = `vm-${g.vmid}-cloudinit`
        addVolume(pve, { volid: `${d.storage}:${name}`, storage: d.storage, vmid: g.vmid, size: 4 * 1024 * 1024, format: 'raw', content: 'images' })
        out += lvCreated(pve, d.storage, name)
        g.conf.set(k, `${d.storage}:${name},media=cdrom`)
        continue
      }
      if (d.newSize !== undefined) {
        const se = storageCheck(pve, d.storage, 'images')
        if (se) return { error: `400 Parameter verification failed.\n${k}: ${se}` }
        let size = d.newSize
        if (d.importFrom) {
          const img = readImage(sys, d.importFrom)
          if (!img) return { error: `400 Parameter verification failed.\n${k}: unable to parse volume ID '${d.importFrom}'` }
          size = img.virtual
        }
        const name = nextDiskName(pve, d.storage, g.vmid)
        addVolume(pve, { volid: `${d.storage}:${name}`, storage: d.storage, vmid: g.vmid, size, format: 'raw', content: 'images' })
        out += lvCreated(pve, d.storage, name)
        if (d.importFrom) out += `transferred 0.0 B of ${(size / GiB).toFixed(1)} GiB (0.00%)\ntransferred ${(size / GiB).toFixed(1)} GiB of ${(size / GiB).toFixed(1)} GiB (100.00%)\n`
        const rest = [...d.opts].filter(([o]) => o !== 'import-from').map(([o, x]) => `${o}=${x}`)
        g.conf.set(k, [`${d.storage}:${name}`, ...rest, `size=${sizeStr(size)}`].join(','))
        continue
      }
      if (d.volid && !v.includes('media=cdrom')) {
        const vol = pve.volumes.get(d.volid)
        if (!vol) return { error: `400 Parameter verification failed.\n${k}: volume '${d.volid}' does not exist` }
        // Si estaba como unused, deja de estarlo.
        for (const [uk, uv] of [...g.conf]) if (/^unused\d+$/.test(uk) && uv === d.volid) g.conf.delete(uk)
        g.conf.set(k, v.includes('size=') ? v : `${v},size=${sizeStr(vol.size)}`)
        continue
      }
      g.conf.set(k, v)
      continue
    }
    if (/^net\d+$/.test(k)) {
      const m = /^(virtio|e1000|e1000e|vmxnet3|rtl8139)(=[0-9A-Fa-f:]+)?(.*)$/.exec(v)
      if (!m) return { error: `400 Parameter verification failed.\n${k}: invalid format - format error\n${k}.model: property is missing and it is not optional` }
      const br = /bridge=([^,]+)/.exec(v)?.[1]
      if (br && !pve.bridges.has(br) && creating) {
        // qm create acepta un puente que no existe; falla al arrancar.
      }
      g.conf.set(k, `${m[1]}=${m[2] ? m[2].slice(1) : mac()}${m[3]}`)
      continue
    }
    if (k === 'description') {
      g.conf.set('#description', v)
      continue
    }
    if (k === 'agent' && /^(1|enabled=1)/.test(v)) g.conf.set(k, v)
    else g.conf.set(k, v)
  }
  return { out }
}

function qmList(pve: Pve): string {
  let out = '      VMID NAME                 STATUS     MEM(MB)    BOOTDISK(GB) PID       \n'
  for (const g of [...pve.guests.values()].filter((x) => x.type === 'qemu').sort((a, b) => a.vmid - b.vmid)) {
    const boot = /order=([^;,]+)/.exec(g.conf.get('boot') ?? '')?.[1] ?? 'scsi0'
    const d = parseDrive(g.conf.get(boot) ?? g.conf.get('scsi0') ?? '')
    const size = d.volid ? (pve.volumes.get(d.volid)?.size ?? 0) / GiB : 0
    out += `${String(g.vmid).padStart(10)} ${guestName(g).padEnd(20)} ${g.status.padEnd(10)} ${(g.conf.get('memory') ?? '512').padEnd(10)} ${size.toFixed(2).padStart(12)} ${String(g.pid ?? 0).padEnd(10)}\n`
  }
  return out
}

function getGuest(ctx: CommandContext, pve: Pve, id: string | undefined, type: 'qemu' | 'lxc'): PveGuest | undefined {
  const vmid = Number(id)
  if (!id || !Number.isInteger(vmid)) {
    ctx.err(`400 not enough arguments\n${type === 'qemu' ? 'qm' : 'pct'} ${ctx.args[0]} <vmid> [OPTIONS]\n`)
    return undefined
  }
  const g = pve.guests.get(vmid)
  if (!g || g.type !== type) {
    ctx.err(type === 'qemu' ? `Configuration file 'nodes/${pve.node}/qemu-server/${vmid}.conf' does not exist\n` : `Configuration file 'nodes/${pve.node}/lxc/${vmid}.conf' does not exist\n`)
    return undefined
  }
  return g
}

function snapshotList(g: PveGuest) {
  let out = ''
  let depth = 0
  for (const s of g.snapshots) {
    out += `${'    '.repeat(depth)}\`-> ${s.name.padEnd(30 - depth * 4)} ${fmtTime(s.time)}     ${s.description}\n`
    depth++
  }
  out += `${'    '.repeat(depth)}\`-> current${' '.repeat(Math.max(1, 27 - depth * 4))}You are here!\n`
  return out
}

function snapshotCmd(ctx: CommandContext, sys: System, pve: Pve, g: PveGuest, verb: string, pos: string[], opts: Map<string, string>): number {
  const name = pos[1]
  if (verb === 'listsnapshot') {
    ctx.out(snapshotList(g))
    return 0
  }
  if (!name) {
    ctx.err(`400 not enough arguments\n`)
    return 1
  }
  if (verb === 'snapshot') {
    if (g.snapshots.some((s) => s.name === name)) {
      ctx.err(`snapshot name '${name}' already used\n`)
      return 1
    }
    if (/^current$/.test(name)) {
      ctx.err(`400 Parameter verification failed.\nsnapname: invalid format - invalid configuration ID 'current'\n`)
      return 1
    }
    const vmstate = opts.get('vmstate') === '1' && g.status === 'running' && g.type === 'qemu'
    for (const [k, v] of g.conf) {
      if (!(isDriveKey(k) || k === 'rootfs') || v.includes('media=cdrom')) continue
      const d = parseDrive(v)
      const st = d.volid ? pve.storages.get(d.storage) : undefined
      if (st && (st.type === 'dir' || st.type === 'nfs' || st.type === 'cifs') && pve.volumes.get(d.volid!)?.format === 'raw') {
        ctx.err(`snapshot feature is not available\n`)
        return 1
      }
      if (g.type === 'qemu') ctx.out(`snapshotting '${`drive-${k}`}' (${d.volid})\n`)
      if (st?.type === 'lvmthin') ctx.out(`  Logical volume "snap_${d.volid!.split(':')[1]}_${name}" created.\n`)
    }
    if (vmstate) ctx.out(`saving VM state and RAM using storage 'local-lvm'\n${(Number(g.conf.get('memory') ?? 512) / 4).toFixed(2)} MiB in 0s\ncompleted saving the VM state in 2s, saved ${(Number(g.conf.get('memory') ?? 512) / 4 / 1024).toFixed(2)} GiB\n`)
    g.snapshots.push({ name, time: Date.now(), description: opts.get('description') ?? '', vmstate, parent: g.snapshots.at(-1)?.name })
    g.conf.set('parent', name)
    saveConf(sys, g)
    return 0
  }
  const s = g.snapshots.find((x) => x.name === name)
  if (!s) {
    ctx.err(`snapshot '${name}' does not exist\n`)
    return 1
  }
  if (verb === 'rollback') {
    if (g.snapshots.at(-1) !== s && !opts.has('start')) {
      // Proxmox permite volver a cualquiera; las posteriores siguen existiendo.
    }
    if (s.vmstate) {
      if (g.status !== 'running') startGuest(sys, pve, g)
    } else if (g.status === 'running') stopGuest(g)
    for (const [k, v] of g.conf) {
      if (!(isDriveKey(k) || k === 'rootfs') || v.includes('media=cdrom')) continue
      const d = parseDrive(v)
      if (pve.storages.get(d.storage)?.type === 'lvmthin') ctx.out(`  Logical volume "${d.volid!.split(':')[1]}" successfully removed.\n  Logical volume "${d.volid!.split(':')[1]}" created.\n`)
    }
    if (opts.get('start') === '1' && g.status !== 'running') startGuest(sys, pve, g)
    return 0
  }
  // delsnapshot
  for (const [k, v] of g.conf) {
    if (!(isDriveKey(k) || k === 'rootfs') || v.includes('media=cdrom')) continue
    const d = parseDrive(v)
    if (pve.storages.get(d.storage)?.type === 'lvmthin') ctx.out(`  Logical volume "snap_${d.volid!.split(':')[1]}_${name}" successfully removed.\n`)
  }
  const idx = g.snapshots.indexOf(s)
  const child = g.snapshots[idx + 1]
  if (child) child.parent = s.parent
  g.snapshots.splice(idx, 1)
  if (g.snapshots.length) g.conf.set('parent', g.snapshots.at(-1)!.name)
  else g.conf.delete('parent')
  saveConf(sys, g)
  return 0
}

function destroyGuest(ctx: CommandContext, sys: System, pve: Pve, g: PveGuest, opts: Map<string, string>): number {
  if (g.status === 'running') {
    ctx.err(`${g.type === 'qemu' ? 'VM' : 'CT'} ${g.vmid} is running - destroy failed\n`)
    return 1
  }
  if (g.conf.get('protection') === '1') {
    ctx.err(`can't remove ${g.type === 'qemu' ? 'VM' : 'CT'} ${g.vmid} - protection mode enabled\n`)
    return 1
  }
  // Un clon enlazado depende de la plantilla.
  if (g.template) {
    const base = [...g.conf.values()].map((v) => parseDrive(v).volid).filter((x): x is string => !!x)
    for (const other of pve.guests.values()) {
      if (other === g) continue
      for (const v of other.conf.values()) {
        if (base.some((b) => v.includes(`${b.split(':')[1]}/`))) {
          ctx.err(`base volume '${base[0]}' is still in use by linked cloned\n`)
          return 1
        }
      }
    }
  }
  for (const v of [...pve.volumes.values()]) {
    if (v.vmid !== g.vmid || v.content === 'backup' || v.content === 'iso' || v.content === 'vztmpl') continue
    pve.volumes.delete(v.volid)
    const st = pve.storages.get(v.storage)
    if (st?.type === 'lvmthin') ctx.out(`  Logical volume "${v.volid.split(':')[1].replace(/^base-\d+-disk-\d+\//, '')}" successfully removed.\n`)
  }
  pve.guests.delete(g.vmid)
  if (sys.vfs.exists(confPath(g))) sys.vfs.unlink(confPath(g), ROOT_CRED)
  if (opts.get('purge') === '1') pve.acls = pve.acls.filter((a) => a.path !== `/vms/${g.vmid}`)
  return 0
}

register('qm', {
  usage: 'qm <comando> <vmid> [OPCIONES]',
  summary:
    '  list | create | set | config | start | stop | shutdown | reboot | status | destroy\n  clone | template | snapshot | listsnapshot | rollback | delsnapshot\n  disk import | disk resize | importdisk | resize | cloudinit dump | agent | guest cmd',
  path: '/usr/sbin',
  run(ctx) {
    const pve = node(ctx)
    if (!pve) return 127
    const sys = ctx.sys
    const args = [...ctx.args]
    let verb = args.shift() ?? 'help'
    if (verb === 'disk' && args[0]) verb = `disk ${args.shift()}`
    if (verb === 'guest' && args[0]) verb = `guest ${args.shift()}`
    if (verb === 'cloudinit' && args[0]) verb = `cloudinit ${args.shift()}`
    if (verb === 'importdisk') verb = 'disk import'
    if (verb === 'resize') verb = 'disk resize'
    if (verb === 'help' || verb === '--help') {
      ctx.out('USAGE: qm <COMMAND> [ARGS] [OPTIONS]\n\n       qm clone <vmid> <newid> [OPTIONS]\n       qm config <vmid> [OPTIONS]\n       qm create <vmid> [OPTIONS]\n       qm delsnapshot <vmid> <snapname> [OPTIONS]\n       qm destroy <vmid> [OPTIONS]\n       qm disk import <vmid> <source> <storage> [OPTIONS]\n       qm disk resize <vmid> <disk> <size> [OPTIONS]\n       qm list  [OPTIONS]\n       qm listsnapshot <vmid>\n       qm rollback <vmid> <snapname> [OPTIONS]\n       qm set <vmid> [OPTIONS]\n       qm shutdown <vmid> [OPTIONS]\n       qm snapshot <vmid> <snapname> [OPTIONS]\n       qm start <vmid> [OPTIONS]\n       qm status <vmid> [OPTIONS]\n       qm stop <vmid> [OPTIONS]\n       qm template <vmid> [OPTIONS]\n')
      return 0
    }
    if (verb !== 'list' && verb !== 'status' && verb !== 'config' && verb !== 'listsnapshot' && verb !== 'cloudinit dump' && !needRoot(ctx)) return 1
    if (verb === 'list' && !needRoot(ctx)) return 1
    const { pos, opts } = parseOpts(args)
    switch (verb) {
      case 'list':
        ctx.out(qmList(pve))
        return 0
      case 'create': {
        const vmid = Number(pos[0])
        if (!Number.isInteger(vmid) || vmid < 100) {
          ctx.err(`400 Parameter verification failed.\nvmid: value must be at least 100\n`)
          return 1
        }
        if (pve.guests.has(vmid)) {
          ctx.err(`unable to create VM ${vmid} - VM ${vmid} already exists on node '${pve.node}'\n`)
          return 1
        }
        const g: PveGuest = { vmid, type: 'qemu', status: 'stopped', template: false, conf: new Map([['smbios1', `uuid=${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`], ['vmgenid', `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`], ['meta', `creation-qemu=11.0.0,ctime=${Math.floor(Date.now() / 1000)}`]]), snapshots: [], agent: false, osReady: false }
        if (!opts.has('memory')) g.conf.set('memory', '2048')
        if (!opts.has('cores')) g.conf.set('cores', '1')
        if (!opts.has('ostype')) g.conf.set('ostype', 'other')
        if (opts.has('scsi0') && !opts.has('scsihw')) g.conf.set('scsihw', 'lsi')
        pve.guests.set(vmid, g)
        const r = applyQmOpts(sys, pve, g, opts, true)
        if ('error' in r) {
          pve.guests.delete(vmid)
          for (const v of [...pve.volumes.values()]) if (v.vmid === vmid && v.content !== 'backup') pve.volumes.delete(v.volid)
          ctx.err(r.error.startsWith('400') ? `${r.error}\n` : `unable to create VM ${vmid} - ${r.error}\n`)
          return 1
        }
        if (opts.has('scsi0') && [...opts.keys()].some((k) => k === 'scsi0' && opts.get(k)!.includes('import-from'))) g.osReady = true
        ctx.out(r.out)
        saveConf(sys, g)
        if (opts.get('start') === '1') {
          const e = startGuest(sys, pve, g)
          if (e) {
            ctx.err(`${e}\n`)
            return 1
          }
        }
        return 0
      }
      case 'set': {
        const g = getGuest(ctx, pve, pos[0], 'qemu')
        if (!g) return 1
        if (g.template && [...opts.keys()].some((k) => isDriveKey(k))) {
          // Proxmox deja cambiar algunas cosas de una plantilla; los discos base no.
        }
        const r = applyQmOpts(sys, pve, g, opts, false)
        if ('error' in r) {
          ctx.err(`${r.error}\n`)
          return 1
        }
        ctx.out(`update VM ${g.vmid}: ${[...opts].map(([k, v]) => `-${k} ${k === 'cipassword' ? '<hidden>' : v}`).join(' ')}\n${r.out}`)
        saveConf(sys, g)
        return 0
      }
      case 'config': {
        const g = getGuest(ctx, pve, pos[0], 'qemu')
        if (!g) return 1
        const desc = g.conf.get('#description')
        if (desc) ctx.out(`description: ${desc}\n`)
        for (const [k, v] of [...g.conf].filter(([key]) => !key.startsWith('#')).sort(([a], [b]) => a.localeCompare(b))) ctx.out(`${k}: ${v}\n`)
        return 0
      }
      case 'status': {
        const g = getGuest(ctx, pve, pos[0], 'qemu')
        if (!g) return 1
        ctx.out(`status: ${g.status}\n`)
        if (opts.get('verbose') === '1') ctx.out(`cpus: ${g.conf.get('cores')}\nmaxmem: ${Number(g.conf.get('memory') ?? 512) * 1048576}\nname: ${guestName(g)}\nqmpstatus: ${g.status}\n${g.pid ? `pid: ${g.pid}\n` : ''}vmid: ${g.vmid}\n`)
        return 0
      }
      case 'start': {
        const g = getGuest(ctx, pve, pos[0], 'qemu')
        if (!g) return 1
        if (g.template) {
          ctx.err(`start failed: VM ${g.vmid} is a template\n`)
          return 1
        }
        if (g.status === 'running') {
          ctx.err(`VM ${g.vmid} already running\n`)
          return 1
        }
        if ([...g.conf.values()].some((v) => /cloudinit/.test(v))) ctx.out('generating cloud-init ISO\n')
        const e = startGuest(sys, pve, g)
        if (e) {
          ctx.err(`${e}\n`)
          return 1
        }
        return 0
      }
      case 'stop':
      case 'shutdown':
      case 'reboot': {
        const g = getGuest(ctx, pve, pos[0], 'qemu')
        if (!g) return 1
        if (g.status !== 'running') {
          if (verb === 'stop') return 0
          ctx.err(`VM ${g.vmid} not running\n`)
          return 1
        }
        if (verb === 'shutdown' && !g.osReady) {
          ctx.err(`VM quit/powerdown failed - got timeout\n`)
          return 1
        }
        if (verb === 'reboot') return 0
        stopGuest(g)
        return 0
      }
      case 'destroy': {
        const g = getGuest(ctx, pve, pos[0], 'qemu')
        if (!g) return 1
        return destroyGuest(ctx, sys, pve, g, opts)
      }
      case 'template': {
        const g = getGuest(ctx, pve, pos[0], 'qemu')
        if (!g) return 1
        if (g.status === 'running') {
          ctx.err(`you can't convert a running VM to a template\n`)
          return 1
        }
        if (g.template) {
          ctx.err(`you can't convert a template to a template\n`)
          return 1
        }
        for (const [k, v] of [...g.conf]) {
          if (!isDriveKey(k) || v.includes('media=cdrom')) continue
          const d = parseDrive(v)
          if (!d.volid) continue
          const vol = pve.volumes.get(d.volid)!
          const newName = d.volid.split(':')[1].replace(/^vm-/, 'base-')
          pve.volumes.delete(d.volid)
          pve.volumes.set(`${d.storage}:${newName}`, { ...vol, volid: `${d.storage}:${newName}` })
          g.conf.set(k, v.replace(d.volid, `${d.storage}:${newName}`))
          if (pve.storages.get(d.storage)?.type === 'lvmthin') ctx.out(`  Renamed "${d.volid.split(':')[1]}" to "${newName}" in volume group "pve"\n  Logical volume pve/${newName} changed.\n  WARNING: Combining activation change with other commands is not advised.\n`)
        }
        g.template = true
        g.conf.set('template', '1')
        saveConf(sys, g)
        return 0
      }
      case 'clone': {
        const g = getGuest(ctx, pve, pos[0], 'qemu')
        if (!g) return 1
        const newid = Number(pos[1])
        if (!Number.isInteger(newid)) {
          ctx.err('400 not enough arguments\nqm clone <vmid> <newid> [OPTIONS]\n')
          return 1
        }
        if (pve.guests.has(newid)) {
          ctx.err(`unable to create VM ${newid}: config file already exists\n`)
          return 1
        }
        const full = opts.get('full') === '1' || !g.template
        if (!g.template && opts.get('full') === '0') {
          ctx.err(`linked clone feature is only available for templates\n`)
          return 1
        }
        const target = opts.get('storage')
        const conf = new Map(g.conf)
        conf.delete('template')
        conf.delete('parent')
        conf.set('name', opts.get('name') ?? `Copy-of-VM-${guestName(g)}`)
        conf.set('smbios1', `uuid=${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`)
        conf.set('vmgenid', `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`)
        for (const [k, v] of [...conf]) if (/^net\d+$/.test(k)) conf.set(k, v.replace(/=([0-9A-F]{2}:){5}[0-9A-F]{2}/i, `=${mac()}`))
        const ng: PveGuest = { vmid: newid, type: 'qemu', status: 'stopped', template: false, conf, snapshots: [], agent: g.agent, osReady: g.osReady }
        let out = ''
        for (const [k, v] of [...conf]) {
          if (!isDriveKey(k) || v.includes('media=cdrom') && !/cloudinit/.test(v)) continue
          const d = parseDrive(v)
          if (!d.volid) continue
          const vol = pve.volumes.get(d.volid)
          if (!vol) continue
          const st = target ?? d.storage
          if (/cloudinit/.test(v)) {
            const name = `vm-${newid}-cloudinit`
            addVolume(pve, { volid: `${st}:${name}`, storage: st, vmid: newid, size: vol.size, format: 'raw', content: 'images' })
            conf.set(k, `${st}:${name},media=cdrom`)
            out += lvCreated(pve, st, name)
            continue
          }
          const name = nextDiskName(pve, st, newid)
          if (full) {
            out += `create full clone of drive ${k} (${d.volid})\n${lvCreated(pve, st, name)}transferred 0.0 B of ${(vol.size / GiB).toFixed(1)} GiB (0.00%)\ntransferred ${(vol.size / GiB).toFixed(1)} GiB of ${(vol.size / GiB).toFixed(1)} GiB (100.00%)\n`
            addVolume(pve, { volid: `${st}:${name}`, storage: st, vmid: newid, size: vol.size, format: vol.format, content: 'images' })
            conf.set(k, v.replace(d.volid, `${st}:${name}`))
          } else {
            out += `create linked clone of drive ${k} (${d.volid})\n${lvCreated(pve, d.storage, name)}`
            const linked = `${d.volid.split(':')[1]}/${name}`
            addVolume(pve, { volid: `${d.storage}:${linked}`, storage: d.storage, vmid: newid, size: vol.size, format: vol.format, content: 'images' })
            conf.set(k, v.replace(d.volid, `${d.storage}:${linked}`))
          }
        }
        pve.guests.set(newid, ng)
        saveConf(sys, ng)
        ctx.out(out)
        return 0
      }
      case 'snapshot':
      case 'listsnapshot':
      case 'rollback':
      case 'delsnapshot': {
        const g = getGuest(ctx, pve, pos[0], 'qemu')
        if (!g) return 1
        if (g.template && verb !== 'listsnapshot') {
          ctx.err(`you can't snapshot a template\n`)
          return 1
        }
        return snapshotCmd(ctx, sys, pve, g, verb, pos, opts)
      }
      case 'disk import': {
        const g = getGuest(ctx, pve, pos[0], 'qemu')
        if (!g) return 1
        const src = pos[1]
        const storage = pos[2]
        if (!src || !storage) {
          ctx.err('400 not enough arguments\nqm disk import <vmid> <source> <storage> [OPTIONS]\n')
          return 1
        }
        const path = src.startsWith('/') ? src : `${ctx.sh.cwd}/${src}`
        const img = readImage(sys, path)
        if (!sys.vfs.exists(path)) {
          ctx.err(`400 Parameter verification failed.\nsource: unable to parse volume ID '${src}'\n`)
          return 1
        }
        const se = storageCheck(pve, storage, 'images')
        if (se) {
          ctx.err(`${se}\n`)
          return 1
        }
        const size = img?.virtual ?? sys.vfs.stat(path, ROOT_CRED).size ?? 0
        const name = nextDiskName(pve, storage, g.vmid)
        addVolume(pve, { volid: `${storage}:${name}`, storage, vmid: g.vmid, size, format: 'raw', content: 'images' })
        let u = 0
        while (g.conf.has(`unused${u}`)) u++
        g.conf.set(`unused${u}`, `${storage}:${name}`)
        g.osReady = true
        saveConf(sys, g)
        ctx.out(`importing disk '${src}' to VM ${g.vmid} ...\n${lvCreated(pve, storage, name)}  Logical volume pve/${name} changed.\ntransferred 0.0 B of ${(size / GiB).toFixed(1)} GiB (0.00%)\ntransferred ${(size / GiB).toFixed(1)} GiB of ${(size / GiB).toFixed(1)} GiB (100.00%)\nunused${u}: successfully imported disk '${storage}:${name}'\n`)
        return 0
      }
      case 'disk resize': {
        const g = getGuest(ctx, pve, pos[0], 'qemu')
        if (!g) return 1
        const key = pos[1]
        const v = key ? g.conf.get(key) : undefined
        if (!key || !v) {
          ctx.err(`400 Parameter verification failed.\ndisk: value '${key}' does not have a value in the enumeration\n`)
          return 1
        }
        const d = parseDrive(v)
        const vol = d.volid ? pve.volumes.get(d.volid) : undefined
        if (!vol) return 1
        const raw = pos[2] ?? ''
        const m = /^(\+)?(\d+(?:\.\d+)?)([KMGT]?)$/.exec(raw)
        if (!m) {
          ctx.err(`400 Parameter verification failed.\nsize: value does not match the regex pattern\n`)
          return 1
        }
        const mult: Record<string, number> = { '': 1, K: 1024, M: 1024 ** 2, G: GiB, T: 1024 * GiB }
        const n = Number(m[2]) * mult[m[3]]
        const newSize = m[1] ? vol.size + n : n
        if (newSize < vol.size) {
          ctx.err(`shrinking disks is not supported\n`)
          return 1
        }
        const before = vol.size
        vol.size = newSize
        g.conf.set(key, v.replace(/size=[^,]+/, `size=${sizeStr(newSize)}`))
        saveConf(sys, g)
        const lvName = d.volid!.split(':')[1].split('/').pop()
        if (pve.storages.get(d.storage)?.type === 'lvmthin') ctx.out(`  Size of logical volume pve/${lvName} changed from ${(before / GiB).toFixed(2)} GiB (${before / 4194304} extents) to ${(newSize / GiB).toFixed(2)} GiB (${newSize / 4194304} extents).\n  Logical volume pve/${lvName} successfully resized.\n`)
        return 0
      }
      case 'cloudinit dump': {
        const g = getGuest(ctx, pve, pos[0], 'qemu')
        if (!g) return 1
        const type = pos[1]
        if (type === 'user') {
          ctx.out(`#cloud-config\nhostname: ${guestName(g)}\nmanage_etc_hosts: true\nfqdn: ${guestName(g)}\n${g.conf.get('ciuser') ? `user: ${g.conf.get('ciuser')}\n` : ''}${g.conf.get('cipassword') ? `password: ${g.conf.get('cipassword')}\n` : ''}${g.conf.get('sshkeys') ? `ssh_authorized_keys:\n  - ${decodeURIComponent(g.conf.get('sshkeys')!)}\n` : ''}chpasswd:\n  expire: False\nusers:\n  - default\npackage_upgrade: true\n`)
          return 0
        }
        if (type === 'network') {
          const ipc = g.conf.get('ipconfig0') ?? 'ip=dhcp'
          const ip = /ip=([^,]+)/.exec(ipc)?.[1] ?? 'dhcp'
          const gw = /gw=([^,]+)/.exec(ipc)?.[1]
          ctx.out(`version: 1\nconfig:\n    - type: physical\n      name: eth0\n      mac_address: '${(/=([0-9A-F:]{17})/i.exec(g.conf.get('net0') ?? '')?.[1] ?? '').toLowerCase()}'\n      subnets:\n      - type: ${ip === 'dhcp' ? 'dhcp4' : 'static'}\n${ip !== 'dhcp' ? `        address: '${ip.split('/')[0]}'\n        netmask: '255.255.255.0'\n${gw ? `        gateway: '${gw}'\n` : ''}` : ''}`)
          return 0
        }
        ctx.err(`400 Parameter verification failed.\ntype: value '${type ?? ''}' does not have a value in the enumeration 'user, network, meta'\n`)
        return 1
      }
      case 'agent':
      case 'guest cmd': {
        const g = getGuest(ctx, pve, pos[0], 'qemu')
        if (!g) return 1
        const cmd = pos[1]
        if (g.status !== 'running') {
          ctx.err(`VM ${g.vmid} is not running\n`)
          return 1
        }
        if (g.conf.get('agent')?.startsWith('1') !== true) {
          ctx.err(`No QEMU guest agent configured\n`)
          return 1
        }
        if (!g.agent) {
          ctx.err(`QEMU guest agent is not running\n`)
          return 1
        }
        if (cmd === 'ping') return 0
        if (cmd === 'network-get-interfaces') {
          ctx.out(JSON.stringify([{ name: 'lo', 'ip-addresses': [{ 'ip-address': '127.0.0.1', 'ip-address-type': 'ipv4', prefix: 8 }], 'hardware-address': '00:00:00:00:00:00' }, { name: 'eth0', 'ip-addresses': g.ip ? [{ 'ip-address': g.ip, 'ip-address-type': 'ipv4', prefix: 24 }] : [], 'hardware-address': (/=([0-9A-F:]{17})/i.exec(g.conf.get('net0') ?? '')?.[1] ?? '').toLowerCase() }], null, 3) + '\n')
          return 0
        }
        if (cmd === 'get-osinfo') {
          ctx.out(JSON.stringify({ id: 'ubuntu', 'kernel-release': '6.8.0-88-generic', machine: 'x86_64', name: 'Ubuntu', 'pretty-name': 'Ubuntu 24.04.3 LTS', 'version-id': '24.04' }, null, 3) + '\n')
          return 0
        }
        if (cmd === 'fsfreeze-status') {
          ctx.out('thawed\n')
          return 0
        }
        ctx.err(`400 Parameter verification failed.\ncommand: value '${cmd}' does not have a value in the enumeration\n`)
        return 1
      }
      default:
        ctx.err(`unknown command 'qm ${verb}'\n`)
        return 1
    }
  },
})

// ---------------------------------------------------------------------------------------
// pct y pveam
// ---------------------------------------------------------------------------------------

register('pveam', {
  usage: 'pveam update | available [--section system] | download <storage> <plantilla> | list <storage>',
  path: '/usr/bin',
  run(ctx) {
    const pve = node(ctx)
    if (!pve) return 127
    const [verb, ...rest] = ctx.args
    const { pos, opts } = parseOpts(rest)
    if (verb === 'update') {
      if (!needRoot(ctx)) return 1
      ctx.out('update successful\n')
      return 0
    }
    if (verb === 'available') {
      if (opts.get('section') && opts.get('section') !== 'system') return 0
      for (const t of TEMPLATES) ctx.out(`system          ${t}\n`)
      return 0
    }
    if (verb === 'download') {
      if (!needRoot(ctx)) return 1
      const [storage, tpl] = pos
      if (!storage || !tpl) {
        ctx.err('400 not enough arguments\npveam download <storage> <template>\n')
        return 1
      }
      const se = storageCheck(pve, storage, 'vztmpl')
      if (se) {
        ctx.err(`${se}\n`)
        return 1
      }
      if (!TEMPLATES.includes(tpl)) {
        ctx.err(`400 Parameter verification failed.\ntemplate: no such template\n`)
        return 1
      }
      const st = pve.storages.get(storage)!
      const dest = `${dirOf(ctx.sys, st, 'vztmpl')}/${tpl}`
      ctx.out(`downloading http://download.proxmox.com/images/system/${tpl} to ${dest}\n--2026-11-20 10:12:31--  http://download.proxmox.com/images/system/${tpl}\nResolving download.proxmox.com (download.proxmox.com)... 212.224.123.70\nConnecting to download.proxmox.com (download.proxmox.com)|212.224.123.70|:80... connected.\nHTTP request sent, awaiting response... 200 OK\nLength: 129385412 (123M) [application/octet-stream]\nSaving to: '${dest}.tmp_dwnl.4412'\n     0K ........ ........ ........ ........ 25% 48.2M 2s\n 98304K ........ ........ ........ .....   100% 61.4M=2.1s\ndownload of 'http://download.proxmox.com/images/system/${tpl}' to '${dest}' finished\ncalculating checksum...OK, checksum verified\n`)
      addVolume(pve, { volid: `${storage}:vztmpl/${tpl}`, storage, size: 129385412, format: tpl.endsWith('.zst') ? 'tzst' : 'txz', content: 'vztmpl' })
      touchFile(ctx.sys, pve, pve.volumes.get(`${storage}:vztmpl/${tpl}`)!)
      return 0
    }
    if (verb === 'list') {
      const storage = pos[0]
      if (!storage || !pve.storages.has(storage)) {
        ctx.err(`storage '${storage ?? ''}' does not exist\n`)
        return 1
      }
      ctx.out('NAME                                                         SIZE  \n')
      for (const v of pve.volumes.values()) if (v.storage === storage && v.content === 'vztmpl') ctx.out(`${v.volid.padEnd(60)} ${Math.round(v.size / 1048576)}MB\n`)
      return 0
    }
    ctx.err('USAGE: pveam <COMMAND> [ARGS] [OPTIONS]\n       pveam available  [OPTIONS]\n       pveam download <storage> <template>\n       pveam list <storage>\n       pveam update\n')
    return 1
  },
})

function pctList(pve: Pve): string {
  let out = 'VMID       Status     Lock         Name                \n'
  for (const g of [...pve.guests.values()].filter((x) => x.type === 'lxc').sort((a, b) => a.vmid - b.vmid)) out += `${String(g.vmid).padEnd(10)} ${g.status.padEnd(10)} ${''.padEnd(12)} ${guestName(g).padEnd(20)}\n`
  return out
}

const CT_KEYS = new Set(['hostname', 'memory', 'swap', 'cores', 'rootfs', 'unprivileged', 'password', 'ssh-public-keys', 'onboot', 'features', 'nameserver', 'searchdomain', 'ostype', 'description', 'tags', 'start', 'storage', 'protection', 'startup', 'arch'])

register('pct', {
  usage: 'pct <comando> <vmid> [OPCIONES]',
  summary: '  list | create | set | config | start | stop | shutdown | reboot | status | destroy | exec | enter\n  snapshot | listsnapshot | rollback | delsnapshot | restore',
  path: '/usr/sbin',
  run(ctx) {
    const pve = node(ctx)
    if (!pve) return 127
    const sys = ctx.sys
    const args = [...ctx.args]
    const verb = args.shift() ?? 'help'
    if (!needRoot(ctx)) return 1
    const dashdash = args.indexOf('--')
    const execCmd = dashdash >= 0 ? args.splice(dashdash).slice(1) : []
    const { pos, opts } = parseOpts(args)
    switch (verb) {
      case 'list':
        ctx.out(pctList(pve))
        return 0
      case 'create': {
        const vmid = Number(pos[0])
        const tpl = pos[1]
        if (!Number.isInteger(vmid) || !tpl) {
          ctx.err('400 not enough arguments\npct create <vmid> <ostemplate> [OPTIONS]\n')
          return 1
        }
        if (pve.guests.has(vmid)) {
          ctx.err(`unable to create CT ${vmid} - CT ${vmid} already exists on node '${pve.node}'\n`)
          return 1
        }
        if (!pve.volumes.has(tpl)) {
          ctx.err(`unable to create CT ${vmid} - volume '${tpl}' does not exist\n`)
          return 1
        }
        for (const k of opts.keys()) {
          if (!CT_KEYS.has(k) && !/^(net|mp)\d+$/.test(k)) {
            ctx.err(`400 Parameter verification failed.\n${k}: property is not defined in schema and the schema does not allow additional properties\n`)
            return 1
          }
        }
        const rootfs = opts.get('rootfs') ?? `${opts.get('storage') ?? 'local'}:4`
        const d = parseDrive(rootfs)
        const se = storageCheck(pve, d.storage, 'rootdir')
        if (se) {
          ctx.err(`unable to create CT ${vmid} - ${se}\n`)
          return 1
        }
        const size = d.newSize ?? 4 * GiB
        const name = nextDiskName(pve, d.storage, vmid)
        const hostname = opts.get('hostname') ?? `CT${vmid}`
        const os = /^[^:]+:vztmpl\/([a-z]+)/.exec(tpl)?.[1] ?? 'debian'
        const conf = new Map<string, string>([
          ['arch', 'amd64'],
          ['hostname', hostname],
          ['memory', opts.get('memory') ?? '512'],
          ['swap', opts.get('swap') ?? '512'],
          ['cores', opts.get('cores') ?? '1'],
          ['ostype', os === 'rockylinux' ? 'centos' : os],
          ['rootfs', `${d.storage}:${name},size=${sizeStr(size)}`],
        ])
        if (opts.get('unprivileged') === '1') conf.set('unprivileged', '1')
        if (opts.has('features')) conf.set('features', opts.get('features')!)
        if (opts.has('onboot')) conf.set('onboot', opts.get('onboot')!)
        for (const [k, v] of opts) {
          if (!/^net\d+$/.test(k)) continue
          const br = /bridge=([^,]+)/.exec(v)?.[1]
          if (br && !pve.bridges.has(br)) {
            ctx.err(`unable to create CT ${vmid} - bridge '${br}' does not exist\n`)
            return 1
          }
          conf.set(k, v.includes('hwaddr=') ? v : v.replace(/(name=[^,]+)/, `$1,hwaddr=${mac()}`) + ',type=veth')
        }
        if (opts.has('ssh-public-keys')) {
          const p = opts.get('ssh-public-keys')!
          if (!sys.vfs.exists(p.startsWith('/') ? p : `/root/${p.replace(/^~\//, '')}`)) {
            ctx.err(`unable to create CT ${vmid} - unable to read file '${p}'\n`)
            return 1
          }
        }
        addVolume(pve, { volid: `${d.storage}:${name}`, storage: d.storage, vmid, size, format: 'raw', content: 'rootdir' })
        const g: PveGuest = { vmid, type: 'lxc', status: 'stopped', template: false, conf, snapshots: [], agent: true, osReady: true }
        pve.guests.set(vmid, g)
        saveConf(sys, g)
        ctx.out(`${lvCreated(pve, d.storage, name)}Creating filesystem with ${size / 4096} 4k blocks and ${size / 16384} inodes\nFilesystem UUID: ${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}\nSuperblock backups stored on blocks: \n\t32768, 98304, 163840, 229376, 294912, 819200, 884736\nextracting archive '${dirOf(sys, pve.storages.get(tpl.split(':')[0])!, 'vztmpl')}/${tpl.split('/').pop()}'\nTotal bytes read: 524595200 (501MiB, 255MiB/s)\nDetected container architecture: amd64\nCreating SSH host key 'ssh_host_ed25519_key' - this may take some time ...\ndone: SHA256:${hex(43)} root@${hostname}\n`)
        if (!opts.get('unprivileged') || opts.get('unprivileged') === '0') ctx.err('')
        if (opts.get('start') === '1') startGuest(sys, pve, g)
        return 0
      }
      case 'set': {
        const g = getGuest(ctx, pve, pos[0], 'lxc')
        if (!g) return 1
        for (const [k, v] of opts) {
          if (k === 'delete') {
            for (const x of v.split(',')) g.conf.delete(x)
            continue
          }
          if (!CT_KEYS.has(k) && !/^(net|mp)\d+$/.test(k)) {
            ctx.err(`400 Parameter verification failed.\n${k}: property is not defined in schema and the schema does not allow additional properties\n`)
            return 1
          }
          if (k === 'unprivileged') {
            ctx.err(`400 Parameter verification failed.\nunprivileged: unable to modify read-only option: 'unprivileged'\n`)
            return 1
          }
          g.conf.set(k, v)
        }
        saveConf(sys, g)
        return 0
      }
      case 'config': {
        const g = getGuest(ctx, pve, pos[0], 'lxc')
        if (!g) return 1
        for (const [k, v] of [...g.conf].filter(([key]) => !key.startsWith('#')).sort(([a], [b]) => a.localeCompare(b))) ctx.out(`${k}: ${v}\n`)
        return 0
      }
      case 'status': {
        const g = getGuest(ctx, pve, pos[0], 'lxc')
        if (!g) return 1
        ctx.out(`status: ${g.status}\n`)
        return 0
      }
      case 'start': {
        const g = getGuest(ctx, pve, pos[0], 'lxc')
        if (!g) return 1
        if (g.status === 'running') {
          ctx.err(`CT ${g.vmid} already running\n`)
          return 1
        }
        const e = startGuest(sys, pve, g)
        if (e) {
          ctx.err(`${e}\n`)
          return 1
        }
        return 0
      }
      case 'stop':
      case 'shutdown':
      case 'reboot': {
        const g = getGuest(ctx, pve, pos[0], 'lxc')
        if (!g) return 1
        if (g.status !== 'running') {
          if (verb === 'stop') return 0
          ctx.err(`CT ${g.vmid} not running\n`)
          return 1
        }
        if (verb !== 'reboot') stopGuest(g)
        return 0
      }
      case 'destroy': {
        const g = getGuest(ctx, pve, pos[0], 'lxc')
        if (!g) return 1
        return destroyGuest(ctx, sys, pve, g, opts)
      }
      case 'exec':
      case 'enter': {
        const g = getGuest(ctx, pve, pos[0], 'lxc')
        if (!g) return 1
        if (g.status !== 'running') {
          ctx.err(`CT ${g.vmid} not running\n`)
          return 1
        }
        if (verb === 'enter') {
          ctx.out(`[simulador: pct enter abre una consola dentro del contenedor ${guestName(g)} como root. Acá podés usar pct exec ${g.vmid} -- comando]\n`)
          return 0
        }
        const [c, ...cargs] = execCmd
        if (!c) {
          ctx.err('400 not enough arguments\npct exec <vmid> [<extra-args>]\n')
          return 1
        }
        const host = guestName(g)
        if (c === 'hostname') ctx.out(`${host}\n`)
        else if (c === 'ip') ctx.out(`lo               UNKNOWN        127.0.0.1/8 ::1/128 \neth0@if${30 + g.vmid % 10}        UP             ${g.ip ? `${g.ip}/24 ` : ''}fe80::be24:11ff:fe${hex(2)}:${hex(4)}/64 \n`)
        else if (c === 'cat' && cargs[0] === '/etc/os-release') ctx.out(/ubuntu/.test(g.conf.get('ostype') ?? '') ? 'PRETTY_NAME="Ubuntu 24.04.3 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\n' : /alpine/.test(g.conf.get('ostype') ?? '') ? 'NAME="Alpine Linux"\nID=alpine\nVERSION_ID=3.22.2\nPRETTY_NAME="Alpine Linux v3.22"\n' : 'PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nNAME="Debian GNU/Linux"\nVERSION_ID="13"\nID=debian\n')
        else if (c === 'id') ctx.out('uid=0(root) gid=0(root) groups=0(root)\n')
        else if (c === 'uname') ctx.out(cargs.includes('-r') ? `${PVE_KERNEL}\n` : `Linux ${host} ${PVE_KERNEL} #1 SMP PREEMPT_DYNAMIC PMX 7.0.4-1 x86_64 GNU/Linux\n`)
        else if (c === 'free') ctx.out(`               total        used        free      shared  buff/cache   available\nMem:           ${g.conf.get('memory')}Mi        41Mi       ${Number(g.conf.get('memory')) - 60}Mi       0.0Ki        18Mi       ${Number(g.conf.get('memory')) - 41}Mi\nSwap:          ${g.conf.get('swap')}Mi          0B       ${g.conf.get('swap')}Mi\n`)
        else if (c === 'nproc') ctx.out(`${g.conf.get('cores')}\n`)
        else if (c === 'ping') ctx.out(g.ip ? `PING ${cargs.at(-1)} 56(84) bytes of data.\n64 bytes from ${cargs.at(-1)}: icmp_seq=1 ttl=63 time=1.21 ms\n\n--- ${cargs.at(-1)} ping statistics ---\n1 packets transmitted, 1 received, 0% packet loss, time 0ms\n` : `ping: connect: Network is unreachable\n`)
        else ctx.out(`[simulador: el contenedor ejecutó "${execCmd.join(' ')}"; acá solo se simulan hostname, ip, cat /etc/os-release, id, uname, free, nproc y ping]\n`)
        return 0
      }
      case 'snapshot':
      case 'listsnapshot':
      case 'rollback':
      case 'delsnapshot': {
        const g = getGuest(ctx, pve, pos[0], 'lxc')
        if (!g) return 1
        return snapshotCmd(ctx, sys, pve, g, verb, pos, opts)
      }
      case 'restore':
        return restore(ctx, pve, 'lxc', pos, opts)
      default:
        ctx.err(`unknown command 'pct ${verb}'\n`)
        return 1
    }
  },
})

// ---------------------------------------------------------------------------------------
// pvesm
// ---------------------------------------------------------------------------------------

register('pvesm', {
  usage: 'pvesm status | list <almacenamiento> [--content tipo] | add <tipo> <id> [opciones] | set <id> [opciones] | remove <id>',
  path: '/usr/sbin',
  run(ctx) {
    const pve = node(ctx)
    if (!pve) return 127
    const sys = ctx.sys
    const [verb, ...rest] = ctx.args
    const { pos, opts } = parseOpts(rest)
    if (!needRoot(ctx)) return 1
    switch (verb) {
      case 'status': {
        ctx.out('Name             Type     Status           Total            Used       Available        %\n')
        for (const s of pve.storages.values()) {
          if (opts.get('content') && !s.content.includes(opts.get('content')!)) continue
          if (!s.enabled) {
            ctx.out(`${s.id.padEnd(16)} ${s.type.padStart(8)} ${'disabled'.padStart(8)} ${'0'.padStart(15)} ${'0'.padStart(15)} ${'0'.padStart(15)}    N/A\n`)
            continue
          }
          const total = Math.round(s.totalBytes / 1024)
          const used = Math.round(usedBytes(pve, s.id) / 1024)
          ctx.out(`${s.id.padEnd(16)} ${s.type.padStart(8)} ${'active'.padStart(8)} ${String(total).padStart(15)} ${String(used).padStart(15)} ${String(total - used).padStart(15)} ${((used / total) * 100).toFixed(2).padStart(7)}%\n`)
        }
        return 0
      }
      case 'list': {
        const id = pos[0]
        const st = id ? pve.storages.get(id) : undefined
        if (!st) {
          ctx.err(`storage '${id ?? ''}' does not exist\n`)
          return 1
        }
        const content = opts.get('content')
        const vols = [...pve.volumes.values()].filter((v) => v.storage === id && (!content || v.content === content) && (!opts.has('vmid') || v.vmid === Number(opts.get('vmid')))).sort((a, b) => a.volid.localeCompare(b.volid))
        const w = Math.max(5, ...vols.map((v) => v.volid.length))
        ctx.out(`${'Volid'.padEnd(w)} ${'Format'.padEnd(7)} ${'Type'.padEnd(8)} ${'Size'.padStart(12)} VMID\n`)
        for (const v of vols) ctx.out(`${v.volid.padEnd(w)} ${v.format.padEnd(7)} ${v.content.padEnd(8)} ${String(Math.round(v.size)).padStart(12)} ${v.vmid ?? ''}\n`)
        return 0
      }
      case 'add': {
        const [type, id] = pos
        if (!type || !id) {
          ctx.err('400 not enough arguments\npvesm add <type> <storage> [OPTIONS]\n')
          return 1
        }
        if (pve.storages.has(id)) {
          ctx.err(`create storage failed: storage ID '${id}' already defined\n`)
          return 1
        }
        const types = ['dir', 'nfs', 'cifs', 'pbs', 'lvmthin', 'lvm', 'zfspool']
        if (!types.includes(type)) {
          ctx.err(`400 Parameter verification failed.\ntype: value '${type}' does not have a value in the enumeration '${types.join(', ')}'\n`)
          return 1
        }
        const content = (opts.get('content') ?? (type === 'pbs' ? 'backup' : type === 'dir' ? 'iso,vztmpl,backup' : 'images,rootdir')).split(',')
        if (type === 'nfs' || type === 'cifs') {
          if (!opts.get('server') || !opts.get(type === 'nfs' ? 'export' : 'share')) {
            ctx.err(`400 Parameter verification failed.\n${!opts.get('server') ? 'server' : type === 'nfs' ? 'export' : 'share'}: property is missing and it is not optional\n`)
            return 1
          }
          const host = sys.lab.find((h) => h.ownIps().includes(opts.get('server')!) || h.hostname === opts.get('server'))
          if (!host) {
            ctx.err(`create storage failed: storage '${id}' is not online\n`)
            return 1
          }
        }
        if (type === 'pbs') {
          for (const req of ['server', 'datastore', 'username']) {
            if (!opts.get(req)) {
              ctx.err(`400 Parameter verification failed.\n${req}: property is missing and it is not optional\n`)
              return 1
            }
          }
          if (!opts.get('password')) {
            ctx.err(`create storage failed: error fetching datastores - 401 Unauthorized\n`)
            return 1
          }
          if (!opts.get('fingerprint')) {
            ctx.err(`create storage failed: error fetching datastores - fingerprint '${hex(2)}:${hex(2)}:...' not verified, abort!\n`)
            return 1
          }
        }
        if (type === 'dir' && !opts.get('path')) {
          ctx.err(`400 Parameter verification failed.\npath: property is missing and it is not optional\n`)
          return 1
        }
        pve.storages.set(id, { id, type: type as PveStorage['type'], content, path: opts.get('path'), server: opts.get('server'), export: opts.get('export') ?? opts.get('share'), datastore: opts.get('datastore'), username: opts.get('username'), fingerprint: opts.get('fingerprint'), totalBytes: type === 'pbs' ? 2000 * GiB : type === 'nfs' ? 1000 * GiB : 200 * GiB, enabled: opts.get('disable') !== '1', shared: ['nfs', 'cifs', 'pbs'].includes(type) || opts.get('shared') === '1' })
        if (type === 'nfs' || type === 'cifs') sys.vfs.mkdirp(`/mnt/pve/${id}`, ROOT_CRED)
        writeStorageCfg(sys, pve)
        if (type === 'pbs') ctx.out(`Successfully added storage '${id}'\n`)
        return 0
      }
      case 'set': {
        const st = pve.storages.get(pos[0] ?? '')
        if (!st) {
          ctx.err(`storage '${pos[0] ?? ''}' does not exist\n`)
          return 1
        }
        if (opts.has('content')) st.content = opts.get('content')!.split(',')
        if (opts.has('disable')) st.enabled = opts.get('disable') !== '1'
        writeStorageCfg(sys, pve)
        return 0
      }
      case 'prune-backups': {
        const st = pve.storages.get(pos[0] ?? '')
        if (!st) {
          ctx.err(`storage '${pos[0] ?? ''}' does not exist\n`)
          return 1
        }
        const keepLast = Number(opts.get('keep-last') ?? 0)
        const keepDaily = Number(opts.get('keep-daily') ?? 0)
        const keepWeekly = Number(opts.get('keep-weekly') ?? 0)
        const keepMonthly = Number(opts.get('keep-monthly') ?? 0)
        if (!keepLast && !keepDaily && !keepWeekly && !keepMonthly) {
          ctx.err('no prune options specified - aborting (use --keep-all 1 to keep everything)\n')
          return 1
        }
        const dry = opts.get('dry-run') === '1'
        const byVm = new Map<number, PveVolume[]>()
        for (const v of pve.volumes.values()) if (v.storage === st.id && v.content === 'backup' && (!opts.has('vmid') || v.vmid === Number(opts.get('vmid')))) byVm.set(v.vmid ?? 0, [...(byVm.get(v.vmid ?? 0) ?? []), v])
        ctx.out('Backup                                                       Backup-ID  Time                 Keep\n')
        for (const [vmid, list] of [...byVm].sort(([a], [b]) => a - b)) {
          const sorted = list.sort((a, b) => b.ctime - a.ctime)
          const keep = new Set<PveVolume>()
          sorted.slice(0, keepLast).forEach((v) => keep.add(v))
          const bucket = (n: number, key: (d: Date) => string) => {
            const seen = new Set<string>()
            for (const v of sorted) {
              if (seen.size >= n) break
              const k = key(new Date(v.ctime))
              if (seen.has(k)) continue
              seen.add(k)
              keep.add(v)
            }
          }
          if (keepDaily) bucket(keepDaily, (d) => d.toDateString())
          if (keepWeekly) bucket(keepWeekly, (d) => `${d.getFullYear()}-${Math.floor((d.getTime() / 86_400_000 + 4) / 7)}`)
          if (keepMonthly) bucket(keepMonthly, (d) => `${d.getFullYear()}-${d.getMonth()}`)
          for (const v of sorted) {
            const verdict = v.protected ? 'protected' : keep.has(v) ? 'keep' : 'remove'
            ctx.out(`${v.volid.padEnd(60)} ${String(vmid).padEnd(10)} ${fmtTime(v.ctime).padEnd(20)} ${verdict}\n`)
            if (verdict === 'remove' && !dry) {
              pve.volumes.delete(v.volid)
              const dir = dirOf(sys, st, 'backup')
              const file = `${dir}/${v.volid.split('/').pop()}`
              for (const f of [file, `${file}.notes`, file.replace(/\.(vma|tar)(\.zst)?$/, '.log')]) if (sys.vfs.exists(f)) sys.vfs.unlink(f, ROOT_CRED)
            }
          }
        }
        return 0
      }
      case 'remove': {
        if (!pve.storages.delete(pos[0] ?? '')) {
          ctx.err(`storage '${pos[0] ?? ''}' does not exist\n`)
          return 1
        }
        writeStorageCfg(sys, pve)
        return 0
      }
      default:
        ctx.err('USAGE: pvesm <COMMAND> [ARGS] [OPTIONS]\n       pvesm add <type> <storage> [OPTIONS]\n       pvesm list <storage> [OPTIONS]\n       pvesm remove <storage>\n       pvesm set <storage> [OPTIONS]\n       pvesm status  [OPTIONS]\n')
        return 1
    }
  },
})

// ---------------------------------------------------------------------------------------
// vzdump, qmrestore
// ---------------------------------------------------------------------------------------

register('vzdump', {
  usage: 'vzdump <vmid>... | --all [--storage ID] [--mode snapshot|suspend|stop] [--compress zstd] [--notes-template TEXTO]',
  path: '/usr/bin',
  run(ctx) {
    const pve = node(ctx)
    if (!pve) return 127
    if (!needRoot(ctx)) return 1
    const sys = ctx.sys
    const { pos, opts } = parseOpts(ctx.args)
    const storage = opts.get('storage') ?? 'local'
    const mode = opts.get('mode') ?? 'snapshot'
    const ids = opts.get('all') === '1' ? [...pve.guests.keys()].sort((a, b) => a - b) : pos.flatMap((x) => x.split(',')).map(Number)
    if (!ids.length) {
      ctx.err('400 Parameter verification failed.\nvmid: property is missing and it is not optional\n')
      return 1
    }
    const se = storageCheck(pve, storage, 'backup')
    if (se) {
      ctx.err(`ERROR: Backup of VM ${ids[0]} failed - ${se}\n`)
      return 255
    }
    const st = pve.storages.get(storage)!
    ctx.out(`INFO: starting new backup job: vzdump ${ctx.args.join(' ')}\n`)
    let failed = 0
    for (const id of ids) {
      const g = pve.guests.get(id)
      if (!g) {
        ctx.err(`ERROR: Backup of VM ${id} failed - unable to find VM '${id}'\n`)
        failed++
        continue
      }
      if (g.template && g.type === 'qemu') {
        // Una plantilla se respalda igual que una VM detenida.
      }
      const t = Date.now()
      const kind = g.type === 'qemu' ? 'qemu' : 'lxc'
      ctx.out(`INFO: Starting Backup of VM ${id} (${kind})\nINFO: Backup started at ${fmtTime(t)}\nINFO: status = ${g.status}\n`)
      if (g.type === 'qemu') ctx.out(`INFO: VM Name: ${guestName(g)}\n`)
      else ctx.out(`INFO: CT Name: ${guestName(g)}\n`)
      for (const [k, v] of g.conf) {
        if (!(isDriveKey(k) || k === 'rootfs') || v.includes('media=cdrom')) continue
        const d = parseDrive(v)
        ctx.out(`INFO: include disk '${k}' '${d.volid}' ${sizeStr(pve.volumes.get(d.volid!)?.size ?? 0)}\n`)
      }
      ctx.out(`INFO: backup mode: ${mode}\nINFO: ionice priority: 7\n`)
      if (mode === 'stop' && g.status === 'running') ctx.out(`INFO: stopping virtual guest\n`)
      if (mode === 'snapshot' && g.type === 'qemu' && g.status === 'running' && g.conf.get('agent')?.startsWith('1') && g.agent) ctx.out('INFO: issuing guest-agent \'fs-freeze\' command\nINFO: issuing guest-agent \'fs-thaw\' command\n')
      if (mode === 'snapshot' && g.type === 'qemu' && g.status === 'running' && !(g.conf.get('agent')?.startsWith('1') && g.agent)) ctx.out('INFO: skipping guest-agent \'fs-freeze\', agent configured but not running?\n')
      const previous = [...pve.volumes.values()].some((x) => x.content === 'backup' && x.storage === storage && x.vmid === id)
      const v = makeBackup(sys, pve, g, storage, t)
      if (opts.get('notes-template')) {
        v.notes = opts.get('notes-template')!.replace('{{guestname}}', guestName(g)).replace('{{vmid}}', String(id)).replace('{{node}}', pve.node)
        touchFile(sys, pve, v)
      }
      if (opts.get('protected') === '1') v.protected = true
      if (st.type === 'pbs') ctx.out(`INFO: creating Proxmox Backup Server archive '${v.volid.split(':backup/')[1]}'\nINFO: started backup task '${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}'\n${previous && g.status === 'running' ? `INFO: scsi0: dirty-bitmap status: OK (1.2 GiB of ${sizeStr(diskTotal(pve, g))} dirty)\nINFO: using fast incremental mode (dirty-bitmap), 1.2 GiB dirty of ${sizeStr(diskTotal(pve, g))} total\nINFO: 100% (1.2 GiB of 1.2 GiB) in 6s, read: 204.8 MiB/s, write: 198.1 MiB/s\nINFO: backup was done incrementally, reused ${(diskTotal(pve, g) / GiB - 1.2).toFixed(2)} GiB (96%)\nINFO: transferred 1.20 GiB in 6 seconds (204.8 MiB/s)\n` : `INFO: scsi0: dirty-bitmap status: ${g.status === 'running' ? 'created new' : 'existing bitmap was invalid and has been cleared'}\nINFO:  14% (4.5 GiB of ${sizeStr(diskTotal(pve, g))}) in 3s, read: 1.5 GiB/s, write: 98.7 MiB/s\nINFO: 100% (${sizeStr(diskTotal(pve, g))} of ${sizeStr(diskTotal(pve, g))}) in 31s, read: 1.0 GiB/s, write: 41.3 MiB/s\nINFO: backup is sparse: ${(diskTotal(pve, g) / GiB * 0.86).toFixed(2)} GiB (86%) total zero data\nINFO: backup was done incrementally, reused ${(diskTotal(pve, g) / GiB * 0.86).toFixed(2)} GiB (86%)\nINFO: transferred ${(diskTotal(pve, g) / GiB).toFixed(2)} GiB in 31 seconds (1.0 GiB/s)\n`}`)
      else {
        const file = `${dirOf(sys, st, 'backup')}/${v.volid.split('/').pop()}`
        ctx.out(`INFO: creating vzdump archive '${file}'\n`)
        if (g.type === 'qemu') ctx.out(`INFO: starting kvm to execute backup task\n`.repeat(g.status === 'running' ? 0 : 1) + `INFO:   9% (2.9 GiB of ${sizeStr(diskTotal(pve, g))}) in 3s, read: 1003.4 MiB/s, write: 214.0 MiB/s\nINFO: 100% (${sizeStr(diskTotal(pve, g))} of ${sizeStr(diskTotal(pve, g))}) in 24s, read: 1.3 GiB/s, write: 59.1 MiB/s\nINFO: backup is sparse: ${(diskTotal(pve, g) / GiB * 0.86).toFixed(2)} GiB (86%) total zero data\nINFO: transferred ${(diskTotal(pve, g) / GiB).toFixed(2)} GiB in 24 seconds (1.3 GiB/s)\n`)
        else ctx.out(`INFO: Total bytes written: ${Math.round(v.size * 3.1)} (${(v.size * 3.1 / GiB).toFixed(1)}GiB, 312MiB/s)\n`)
        ctx.out(`INFO: archive file size: ${(v.size / GiB).toFixed(2)}GB\n`)
        if (v.notes) ctx.out(`INFO: adding notes to backup\n`)
      }
      if (mode === 'stop' && g.status === 'running') ctx.out(`INFO: restarting vm\n`)
      ctx.out(`INFO: Finished Backup of VM ${id} (00:00:2${id % 10})\nINFO: Backup finished at ${fmtTime(t + 26000)}\n`)
    }
    if (failed) {
      ctx.out('INFO: Backup job finished with errors\n')
      ctx.err('job errors\n')
      return 255
    }
    ctx.out('INFO: Backup job finished successfully\n')
    return 0
  },
})

function restore(ctx: CommandContext, pve: Pve, type: 'qemu' | 'lxc', pos: string[], opts: Map<string, string>): number {
  const sys = ctx.sys
  const [archive, idRaw] = pos
  const vmid = Number(idRaw)
  if (!archive || !Number.isInteger(vmid)) {
    ctx.err(type === 'qemu' ? '400 not enough arguments\nqmrestore <archive> <vmid> [OPTIONS]\n' : '400 not enough arguments\npct restore <vmid> <ostemplate> [OPTIONS]\n')
    return 1
  }
  // El archivo puede ser una ruta o un volumen ("local:backup/..." o "pbs01:backup/vm/100/...").
  let vol = pve.volumes.get(archive)
  if (!vol && archive.startsWith('/')) vol = [...pve.volumes.values()].find((v) => v.content === 'backup' && archive.endsWith(v.volid.split('/').pop()!))
  if (!vol) {
    ctx.err(`400 Parameter verification failed.\narchive: unable to parse volume ID '${archive}'\n`)
    return 1
  }
  if (!vol.guest || vol.guest.type !== type) {
    ctx.err(type === 'qemu' ? `unable to restore VM ${vmid} - backup '${archive}' is not a VM backup\n` : `unable to restore CT ${vmid} - backup '${archive}' is not a CT backup\n`)
    return 1
  }
  const existing = pve.guests.get(vmid)
  if (existing && opts.get('force') !== '1') {
    ctx.err(type === 'qemu' ? `unable to restore VM ${vmid} - VM ${vmid} already exists on node '${pve.node}'\n` : `unable to restore CT ${vmid} - CT ${vmid} already exists on node '${pve.node}'\n`)
    return 1
  }
  if (existing && existing.status === 'running') {
    ctx.err(`unable to restore VM ${vmid} - VM is running\n`)
    return 1
  }
  if (existing) {
    for (const v of [...pve.volumes.values()]) if (v.vmid === vmid && v.content !== 'backup') pve.volumes.delete(v.volid)
    pve.guests.delete(vmid)
  }
  const storage = opts.get('storage')
  const conf = new Map(vol.guest.conf)
  conf.delete('parent')
  let out = type === 'qemu' ? `restore vma archive: zstd -q -d -c ${archive} | vma extract -v -r /var/tmp/vzdumptmp${Math.floor(Math.random() * 90000) + 10000}.fifo - /var/tmp/vzdumptmp\nCFG: size: 712 name: qemu-server.conf\n` : `recovering backed-up configuration from '${archive}'\n`
  for (const [k, v] of [...conf]) {
    if (!(isDriveKey(k) || k === 'rootfs') || v.includes('media=cdrom') && !/cloudinit/.test(v)) continue
    const d = parseDrive(v)
    if (!d.volid) continue
    const st = storage ?? d.storage
    const se = storageCheck(pve, st, type === 'qemu' ? 'images' : 'rootdir')
    if (se) {
      ctx.err(`${out}unable to restore ${type === 'qemu' ? 'VM' : 'CT'} ${vmid} - ${se}\n`)
      return 1
    }
    const size = Number(/size=(\d+)G/.exec(v)?.[1] ?? 8) * GiB
    const name = /cloudinit/.test(v) ? `vm-${vmid}-cloudinit` : nextDiskName(pve, st, vmid)
    addVolume(pve, { volid: `${st}:${name}`, storage: st, vmid, size, format: 'raw', content: type === 'qemu' ? 'images' : 'rootdir' })
    conf.set(k, v.replace(d.volid, `${st}:${name}`))
    if (type === 'qemu' && !/cloudinit/.test(v) && vol.storage && pve.storages.get(vol.storage)?.type === 'pbs') {
      const pst = pve.storages.get(vol.storage)!
      const snap = vol.volid.split(':backup/')[1]
      out = out.startsWith('restore vma') ? '' : out
      out += `${lvCreated(pve, st, name)}new volume ID is '${st}:${name}'\nrestore proxmox backup image: /usr/bin/pbs-restore --repository ${pst.username}@${pst.server}:${pst.datastore} ${snap} drive-${k}.img.fidx /dev/pve/${name} --verbose --format raw --skip-zero\nconnecting to repository '${pst.username}@${pst.server}:${pst.datastore}'\nopen block backend for target '/dev/pve/${name}'\nstarting to restore snapshot '${snap}'\ndownload and verify backup index\nprogress 1% (read ${Math.round(size / 100)} bytes, zeroes = 86% (${Math.round(size / 100 * 0.86)} bytes), duration 0 sec)\nprogress 100% (read ${size} bytes, zeroes = 86% (${Math.round(size * 0.86)} bytes), duration 19 sec)\nrestore image complete (bytes=${size}, duration=19.42s, speed=1687.20MB/s)\n`
    } else if (type === 'qemu' && !/cloudinit/.test(v)) out += `DEV: dev_id=1 size: ${size} devname: drive-${k}\nCTIME: ${new Date(vol.ctime).toString().slice(0, 24)}\n${lvCreated(pve, st, name)}new volume ID is '${st}:${name}'\nmap 'drive-${k}' to '/dev/pve/${name}' (write zeros = 0)\nprogress 1% (read ${Math.round(size / 100)} bytes, duration 0 sec)\nprogress 100% (read ${size} bytes, duration 21 sec)\ntotal bytes read ${size}, sparse bytes ${Math.round(size * 0.86)} (86%)\nspace reduction due to 4K zero blocks 0.41%\n`
    else if (!/cloudinit/.test(v)) out += `${lvCreated(pve, st, name)}Creating filesystem with ${size / 4096} 4k blocks and ${size / 16384} inodes\nrestoring '${archive}' now..\n`
  }
  if (opts.get('unique') === '1') {
    for (const [k, v] of [...conf]) if (/^net\d+$/.test(k)) conf.set(k, v.replace(/([0-9A-F]{2}:){5}[0-9A-F]{2}/i, mac()))
  }
  if (type === 'qemu') out += 'rescan volumes...\n'
  else out += 'merging backed-up and given configuration..\n'
  const g: PveGuest = { vmid, type, status: 'stopped', template: conf.get('template') === '1', conf, snapshots: [], agent: !!conf.get('agent'), osReady: true }
  pve.guests.set(vmid, g)
  saveConf(sys, g)
  ctx.out(out)
  if (opts.get('start') === '1') startGuest(sys, pve, g)
  return 0
}

register('qmrestore', {
  usage: 'qmrestore <archivo> <vmid> [--storage ID] [--unique 1] [--force 1]',
  path: '/usr/sbin',
  run(ctx) {
    const pve = node(ctx)
    if (!pve) return 127
    if (!needRoot(ctx)) return 1
    const { pos, opts } = parseOpts(ctx.args)
    return restore(ctx, pve, 'qemu', pos, opts)
  },
})

// ---------------------------------------------------------------------------------------
// pveversion, pveum, pvesubscription
// ---------------------------------------------------------------------------------------

register('pveversion', {
  usage: 'pveversion [-v]',
  path: '/usr/bin',
  run(ctx) {
    const pve = node(ctx)
    if (!pve) return 127
    const head = `pve-manager/${pve.version}/7a3b9c4e1f2d5a68 (running kernel: ${pve.kernel})\n`
    if (!ctx.args.includes('-v') && !ctx.args.includes('--verbose')) {
      ctx.out(head)
      return 0
    }
    ctx.out(`proxmox-ve: ${pve.version.replace(/\.\d+$/, '.0')} (running kernel: ${pve.kernel})\npve-manager: ${pve.version} (running version: ${pve.version}/7a3b9c4e1f2d5a68)\nproxmox-kernel-helper: 9.0.4\nproxmox-kernel-7.0: 7.0.4-1\nceph-fuse: 19.2.3-pve1\ncorosync: 3.1.9-pve2\ncriu: 4.1.1-1\nifupdown2: 3.3.0-1+pmx10\nlibpve-cluster-perl: 9.0.6\nlibpve-storage-perl: 9.0.13\nlxc-pve: 7.0.0-1\nlxcfs: 6.0.4-pve1\nproxmox-backup-client: 4.2.1-1\nproxmox-widget-toolkit: 5.1.2\npve-container: 6.0.13\npve-firewall: 6.0.3\npve-ha-manager: 5.0.5\npve-qemu-kvm: 11.0.0-2\nqemu-server: 9.0.22\nzfsutils-linux: 2.4.0-pve1\n`)
    return 0
  },
})

register('pvesubscription', {
  usage: 'pvesubscription get | set <clave>',
  path: '/usr/bin',
  run(ctx) {
    const pve = node(ctx)
    if (!pve) return 127
    if (ctx.args[0] === 'get') {
      ctx.out(pve.subscription ? `checktime: 1795161600\nkey: pve2c-${hex(10)}\nlevel: c\nnextduedate: 2027-11-19\nproductname: Proxmox VE Community Subscription 2 CPUs/year\nstatus: active\n` : 'message: There is no subscription key\nserverid: 7F2C1A9E3B4D5C6F8A0B1C2D3E4F5A6B\nstatus: notfound\nurl: https://www.proxmox.com/en/proxmox-virtual-environment/pricing\n')
      return 0
    }
    ctx.err('USAGE: pvesubscription <COMMAND> [ARGS] [OPTIONS]\n       pvesubscription get\n       pvesubscription set <key>\n')
    return 1
  },
})

const ROLES = ['Administrator', 'NoAccess', 'PVEAdmin', 'PVEAuditor', 'PVEDatastoreAdmin', 'PVEDatastoreUser', 'PVEMappingAdmin', 'PVEMappingUser', 'PVEPoolAdmin', 'PVEPoolUser', 'PVESDNAdmin', 'PVESDNUser', 'PVESysAdmin', 'PVETemplateUser', 'PVEUserAdmin', 'PVEVMAdmin', 'PVEVMUser']

register('pveum', {
  usage: 'pveum user add|list|delete ... | acl modify|list ... | role list',
  path: '/usr/sbin',
  run(ctx) {
    const pve = node(ctx)
    if (!pve) return 127
    const sys = ctx.sys
    if (!needRoot(ctx)) return 1
    const [obj, verb, ...rest] = ctx.args
    const { pos, opts } = parseOpts(rest)
    if (obj === 'user' || obj === 'useradd') {
      if (verb === 'add') {
        const id = pos[0]
        if (!id || !/^[^@\s]+@(pve|pam)$/.test(id)) {
          ctx.err(`400 Parameter verification failed.\nuserid: value does not match the regex pattern\n`)
          return 1
        }
        if (pve.users.has(id)) {
          ctx.err(`create user failed: user '${id}' already exists\n`)
          return 1
        }
        if (id.endsWith('@pam') && !sys.users.has(id.split('@')[0])) {
          // Proxmox acepta el usuario; no va a poder entrar hasta que exista en Linux.
        }
        pve.users.set(id, { comment: opts.get('comment'), enabled: true })
        writeUserCfg(sys, pve)
        return 0
      }
      if (verb === 'list') {
        ctx.out('┌─────────────┬─────────┬───────┬────────┬────────┬───────────┬────────┬──────┬──────────┬────────────┬────────┐\n│ userid      │ comment │ email │ enable │ expire │ firstname │ groups │ keys │ lastname │ realm-type │ tokens │\n╞═════════════╪═════════╪═══════╪════════╪════════╪═══════════╪════════╪══════╪══════════╪════════════╪════════╡\n')
        for (const [id, u] of pve.users) ctx.out(`│ ${id.padEnd(11)} │ ${(u.comment ?? '').padEnd(7)} │       │ ${u.enabled ? '1' : '0'}      │ 0      │           │        │      │          │ ${id.split('@')[1].padEnd(10)} │        │\n`)
        ctx.out('└─────────────┴─────────┴───────┴────────┴────────┴───────────┴────────┴──────┴──────────┴────────────┴────────┘\n')
        return 0
      }
      if (verb === 'delete') {
        if (!pve.users.delete(pos[0] ?? '')) {
          ctx.err(`delete user failed: no such user ('${pos[0] ?? ''}')\n`)
          return 1
        }
        pve.acls = pve.acls.filter((a) => a.ugid !== pos[0])
        writeUserCfg(sys, pve)
        return 0
      }
    }
    if (obj === 'passwd') {
      ctx.out(`Enter new password: ********\nRetype new password: ********\n`)
      ctx.err('[simulador: se aceptó la contraseña]\n')
      return pve.users.has(verb ?? '') ? 0 : (ctx.err(`change password failed: user '${verb}' does not exist\n`), 1)
    }
    if (obj === 'acl' && verb === 'modify') {
      const path = pos[0]
      const role = opts.get('roles')
      const user = opts.get('users') ?? opts.get('groups')
      if (!path || !role || !user) {
        ctx.err('400 Parameter verification failed.\nroles: property is missing and it is not optional\n')
        return 1
      }
      for (const r of role.split(',')) {
        if (!ROLES.includes(r)) {
          ctx.err(`role '${r}' does not exist\n`)
          return 1
        }
      }
      for (const u of user.split(',')) {
        if (opts.get('users') && !pve.users.has(u)) {
          ctx.err(`user '${u}' does not exist\n`)
          return 1
        }
        for (const r of role.split(',')) {
          if (opts.get('delete') === '1') pve.acls = pve.acls.filter((a) => !(a.path === path && a.ugid === u && a.role === r))
          else if (!pve.acls.some((a) => a.path === path && a.ugid === u && a.role === r)) pve.acls.push({ path, ugid: u, role: r })
        }
      }
      writeUserCfg(sys, pve)
      return 0
    }
    if (obj === 'acl' && verb === 'list') {
      for (const a of pve.acls) ctx.out(`${a.path.padEnd(12)} ${a.ugid.padEnd(16)} ${a.role.padEnd(14)} propagate=1\n`)
      return 0
    }
    if (obj === 'role' && verb === 'list') {
      for (const r of ROLES) ctx.out(`${r}\n`)
      return 0
    }
    ctx.err('USAGE: pveum <COMMAND> [ARGS] [OPTIONS]\n       pveum acl modify <path> --roles <string> [OPTIONS]\n       pveum acl list\n       pveum role list\n       pveum user add <userid> [OPTIONS]\n       pveum user delete <userid>\n       pveum user list\n       pveum passwd <userid>\n')
    return 1
  },
})

// ---------------------------------------------------------------------------------------
// Verificaciones
// ---------------------------------------------------------------------------------------

export function verifyProxmox(sys: System, check: object): { ok: boolean; label: string } | undefined {
  const pve = pveOf(sys)
  if ('pve_vm' in check || 'pve_ct' in check) {
    const c = check as { pve_vm?: number; pve_ct?: number; existe?: boolean; estado?: string; nombre?: string; plantilla?: boolean; config?: Record<string, string>; instantanea?: string }
    const id = (c.pve_vm ?? c.pve_ct)!
    const type = c.pve_vm !== undefined ? 'qemu' : 'lxc'
    const what = type === 'qemu' ? `la VM ${id}` : `el contenedor ${id}`
    const g = pve?.guests.get(id)
    if (c.existe === false) return { ok: !g || g.type !== type, label: `${what} no existe` }
    let ok = !!g && g.type === type
    const parts: string[] = []
    if (ok && c.estado) {
      ok = g!.status === c.estado
      parts.push(c.estado === 'running' ? 'en marcha' : 'detenido')
    }
    if (ok && c.nombre) {
      ok = guestName(g!) === c.nombre
      parts.push(`con el nombre ${c.nombre}`)
    }
    if (ok && c.plantilla !== undefined) {
      ok = g!.template === c.plantilla
      parts.push(c.plantilla ? 'convertida en plantilla' : 'que no es plantilla')
    }
    if (ok && c.instantanea) {
      ok = g!.snapshots.some((s) => s.name === c.instantanea)
      parts.push(`con la instantánea ${c.instantanea}`)
    }
    for (const [k, v] of Object.entries(c.config ?? {})) {
      if (!ok) break
      ok = (g!.conf.get(k) ?? '').includes(v)
      parts.push(`${k} con "${v}"`)
    }
    return { ok, label: `${what} existe${parts.length ? ' ' + parts.join(', ') : ''}` }
  }
  if ('pve_respaldo' in check) {
    const c = check as { pve_respaldo: number; almacenamiento?: string; cantidad?: number }
    const n = [...(pve?.volumes.values() ?? [])].filter((v) => v.content === 'backup' && v.vmid === c.pve_respaldo && (!c.almacenamiento || v.storage === c.almacenamiento)).length
    return { ok: n >= (c.cantidad ?? 1), label: `hay ${c.cantidad && c.cantidad > 1 ? `${c.cantidad} respaldos` : 'un respaldo'} de ${c.pve_respaldo}${c.almacenamiento ? ` en ${c.almacenamiento}` : ''}` }
  }
  if ('pve_almacenamiento' in check) {
    const c = check as { pve_almacenamiento: string; tipo?: string; contenido_incluye?: string; activo?: boolean; existe?: boolean }
    const st = pve?.storages.get(c.pve_almacenamiento)
    if (c.existe === false) return { ok: !st, label: `el almacenamiento ${c.pve_almacenamiento} no existe` }
    let ok = !!st
    if (ok && c.tipo) ok = st!.type === c.tipo
    if (ok && c.contenido_incluye) ok = c.contenido_incluye.split(',').every((x) => st!.content.includes(x))
    if (ok && c.activo !== undefined) ok = st!.enabled === c.activo
    return { ok, label: `el almacenamiento ${c.pve_almacenamiento}${c.tipo ? ` de tipo ${c.tipo}` : ''}${c.contenido_incluye ? ` para ${c.contenido_incluye}` : ''}` }
  }
  if ('pve_puente' in check) {
    const c = check as { pve_puente: string; vlan_aware?: boolean; puerto?: string; direccion?: string }
    const b = pve?.bridges.get(c.pve_puente)
    let ok = !!b && sys.interfaces.some((i) => i.name === c.pve_puente && i.up)
    if (ok && c.vlan_aware !== undefined) ok = b!.vlanAware === c.vlan_aware
    if (ok && c.puerto) ok = b!.ports.includes(c.puerto)
    if (ok && c.direccion) ok = b!.address === c.direccion
    return { ok, label: `el puente ${c.pve_puente} aplicado${c.vlan_aware ? ' y con VLAN (vlan-aware)' : ''}${c.puerto ? ` sobre ${c.puerto}` : ''}` }
  }
  if ('pve_usuario' in check) {
    const c = check as { pve_usuario: string; rol?: string; ruta_acl?: string }
    let ok = !!pve?.users.has(c.pve_usuario)
    if (ok && c.rol) ok = pve!.acls.some((a) => a.ugid === c.pve_usuario && a.role === c.rol && (!c.ruta_acl || a.path === c.ruta_acl))
    return { ok, label: `el usuario ${c.pve_usuario} de Proxmox${c.rol ? ` con el rol ${c.rol}${c.ruta_acl ? ` en ${c.ruta_acl}` : ''}` : ''}` }
  }
  return undefined
}
