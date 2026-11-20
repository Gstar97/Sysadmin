/**
 * KVM con libvirt: virsh, virt-install y virt-host-validate.
 *
 * Las máquinas virtuales son "dominios" con su configuración persistente (la de
 * /etc/libvirt/qemu/*.xml) y su estado en marcha; los discos son imágenes de diskimage.ts. La
 * red default (virbr0, 192.168.122.0/24) entrega direcciones por DHCP. En Rocky 10 los
 * servicios son modulares (virtqemud, virtnetworkd, virtstoraged); en Ubuntu, libvirtd. Sin
 * root (ni el grupo libvirt con -c qemu:///system), virsh habla con la sesión del usuario, que
 * está vacía: el mismo desconcierto que en un equipo real.
 */
import { GiB, initialUsage, qsize, readImage, diskUsage, writeImage, parseSize, type ImageFormat } from './diskimage'
import { register, type CommandContext } from './shell'
import { System } from './system'
import { normalizePath, ROOT_CRED } from './vfs'
import type { BashState } from './schema'

export interface DomSnapshot {
  name: string
  created: number
  state: string
  description?: string
}

export interface DomConfig {
  vcpus: number
  maxVcpus: number
  memKiB: number
  maxMemKiB: number
}

export interface Domain {
  name: string
  uuid: string
  state: 'running' | 'shut off' | 'paused'
  id?: number
  cfg: DomConfig
  live: DomConfig
  disks: { target: string; path: string; format: ImageFormat; device: 'disk' | 'cdrom' }[]
  nets: { network?: string; bridge?: string; mac: string; ip?: string }[]
  autostart: boolean
  persistent: boolean
  osinfo: string
  snapshots: DomSnapshot[]
  /** Lo que dejó cloud-init (nombre del equipo y usuario). */
  cloud?: { hostname?: string; user?: string }
  /** Instalando desde un ISO (todavía sin sistema). */
  installing?: boolean
  uefi: boolean
  tcg: boolean
  cpuTime: number
  startedAt?: number
}

export interface LvNetwork {
  name: string
  active: boolean
  autostart: boolean
  bridge: string
  ip: string
  prefix: number
  leases: { mac: string; ip: string; hostname?: string; expires: number }[]
}

export interface Libvirt {
  doms: Map<string, Domain>
  nets: Map<string, LvNetwork>
  pools: Map<string, { path: string; active: boolean; autostart: boolean }>
  nextId: number
}

const LV = new WeakMap<System, Libvirt>()

export function libvirtOf(sys: System): Libvirt {
  let lv = LV.get(sys)
  if (!lv) {
    lv = { doms: new Map(), nets: new Map(), pools: new Map(), nextId: 1 }
    LV.set(sys, lv)
  }
  return lv
}

function hasLibvirt(sys: System) {
  return sys.installed.has(sys.distro === 'rocky' ? 'libvirt' : 'libvirt-daemon-system')
}

const IMAGES = '/var/lib/libvirt/images'

function hex(n: number) {
  return Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('')
}

function newMac() {
  const b = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  return `52:54:00:${b()}:${b()}:${b()}`
}

function uuid() {
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`
}

/** La red default y el almacén default, como los deja el paquete al instalarse. */
function setupDefaults(sys: System) {
  const lv = libvirtOf(sys)
  if (!lv.nets.has('default')) lv.nets.set('default', { name: 'default', active: sys.distro === 'ubuntu', autostart: true, bridge: 'virbr0', ip: '192.168.122.1', prefix: 24, leases: [] })
  if (!sys.groups.has('libvirt')) sys.addGroup('libvirt')
  if (!lv.pools.has('default')) lv.pools.set('default', { path: IMAGES, active: true, autostart: true })
  sys.vfs.mkdirp(IMAGES, ROOT_CRED, 0o711)
  sys.vfs.mkdirp('/etc/libvirt/qemu/networks/autostart', ROOT_CRED)
  if (!sys.vfs.exists('/etc/libvirt/qemu/networks/default.xml'))
    sys.vfs.writeFile('/etc/libvirt/qemu/networks/default.xml', `<network>\n  <name>default</name>\n  <uuid>${uuid()}</uuid>\n  <forward mode='nat'/>\n  <bridge name='virbr0' stp='on' delay='0'/>\n  <mac address='${newMac()}'/>\n  <ip address='192.168.122.1' netmask='255.255.255.0'>\n    <dhcp>\n      <range start='192.168.122.2' end='192.168.122.254'/>\n    </dhcp>\n  </ip>\n</network>\n`, ROOT_CRED)
  syncBridge(sys)
  if (sys.vmx || sys.physical) {
    if (!sys.groups.has('kvm')) sys.addGroup('kvm', 36)
    if (!sys.vfs.exists('/dev/kvm')) {
      sys.vfs.writeFile('/dev/kvm', '', ROOT_CRED, { mode: 0o660 })
      const n = sys.vfs.stat('/dev/kvm', ROOT_CRED)
      n.gid = sys.groups.get('kvm')!.gid
      n.blockDev = [10, 232]
      n.charDev = true
    }
  }
}

/** virbr0 aparece en ip a mientras la red default está activa. */
function syncBridge(sys: System) {
  const lv = libvirtOf(sys)
  for (const net of lv.nets.values()) {
    const i = sys.interfaces.findIndex((x) => x.name === net.bridge)
    if (net.active && i < 0) sys.interfaces.push({ name: net.bridge, ip: `${net.ip}/${net.prefix}`, mac: newMac(), up: true, ipv6: [], dhcp: false, speed: 0, duplex: 'full', autoneg: false, mtu: 1500 })
    if (!net.active && i >= 0) sys.interfaces.splice(i, 1)
  }
}

for (const pkg of ['libvirt', 'libvirt-daemon-system']) System.installHooks[pkg] = (sys) => setupDefaults(sys)

System.initHooks.push((sys, state) => {
  // Con las extensiones de virtualización, el kernel carga kvm solo al arrancar.
  if (sys.vmx || sys.physical) for (const m of ['kvm_intel', 'kvm']) sys.modules.add(m)
  if (hasLibvirt(sys)) setupDefaults(sys)
  for (const img of state.imagenes_disco ?? []) {
    const virtual = img.virtual_gb * GiB
    const used = img.disco_gb !== undefined ? img.disco_gb * GiB : initialUsage(img.formato, virtual)
    sys.vfs.mkdirp(img.ruta.replace(/\/[^/]+$/, '') || '/', ROOT_CRED)
    writeImage(sys, img.ruta, { format: img.formato, virtual, backing: img.respaldo, backingFmt: img.respaldo ? 'qcow2' : undefined }, used)
    if (img.dueno) {
      const u = sys.users.get(img.dueno)
      if (u) sys.vfs.stat(img.ruta, ROOT_CRED).uid = u.uid
    }
  }
  if (!state.libvirt) return
  const lv = libvirtOf(sys)
  for (const v of state.libvirt.vms) {
    const disk = v.disco ?? `${IMAGES}/${v.nombre}.qcow2`
    if (!sys.vfs.exists(disk)) writeImage(sys, disk, { format: 'qcow2', virtual: 20 * GiB }, 1.4 * GiB)
    const cfg: DomConfig = { vcpus: v.vcpus, maxVcpus: Math.max(v.vcpus, v.vcpus_max ?? v.vcpus), memKiB: v.memoria_mb * 1024, maxMemKiB: Math.max(v.memoria_mb, v.memoria_max_mb ?? v.memoria_mb) * 1024 }
    const d: Domain = {
      name: v.nombre,
      uuid: uuid(),
      state: 'shut off',
      cfg,
      live: { ...cfg },
      disks: [{ target: 'vda', path: disk, format: readImage(sys, disk)?.format ?? 'qcow2', device: 'disk' }],
      nets: [{ network: 'default', mac: newMac() }],
      autostart: v.autostart,
      persistent: true,
      osinfo: v.os,
      snapshots: v.instantaneas.map((s) => ({ name: s, created: Date.now() - 86_400_000, state: 'shutoff' })),
      cloud: { hostname: v.nombre },
      uefi: false,
      tcg: false,
      cpuTime: 0,
    }
    lv.doms.set(d.name, d)
    writeXml(sys, d)
    if (v.estado === 'running') startDom(sys, d)
    if (v.balloon_mb !== undefined && d.state === 'running') d.live.memKiB = v.balloon_mb * 1024
  }
})

// ---------------------------------------------------------------------------------------
// Dominios
// ---------------------------------------------------------------------------------------

function xmlOf(d: Domain): string {
  const disks = d.disks
    .map((k) =>
      k.device === 'cdrom'
        ? `    <disk type='file' device='cdrom'>\n      <driver name='qemu' type='raw'/>\n      <source file='${k.path}'/>\n      <target dev='${k.target}' bus='sata'/>\n      <readonly/>\n    </disk>\n`
        : `    <disk type='file' device='disk'>\n      <driver name='qemu' type='${k.format}' discard='unmap'/>\n      <source file='${k.path}'/>\n      <target dev='${k.target}' bus='virtio'/>\n    </disk>\n`,
    )
    .join('')
  const nets = d.nets
    .map((n) => (n.bridge ? `    <interface type='bridge'>\n      <mac address='${n.mac}'/>\n      <source bridge='${n.bridge}'/>\n      <model type='virtio'/>\n    </interface>\n` : `    <interface type='network'>\n      <mac address='${n.mac}'/>\n      <source network='${n.network}'/>\n      <model type='virtio'/>\n    </interface>\n`))
    .join('')
  const c = d.state === 'running' ? d.live : d.cfg
  return `<domain type='${d.tcg ? 'qemu' : 'kvm'}'${d.state === 'running' && d.id ? ` id='${d.id}'` : ''}>\n  <name>${d.name}</name>\n  <uuid>${d.uuid}</uuid>\n  <metadata>\n    <libosinfo:libosinfo xmlns:libosinfo="http://libosinfo.org/xmlns/libvirt/domain/1.0">\n      <libosinfo:os id="http://${d.osinfo.replace(/^(\D+)([\d.]+)$/, '$1.com/$1/$2')}"/>\n    </libosinfo:libosinfo>\n  </metadata>\n  <memory unit='KiB'>${c.maxMemKiB}</memory>\n  <currentMemory unit='KiB'>${c.memKiB}</currentMemory>\n  <vcpu placement='static'${c.maxVcpus > c.vcpus ? ` current='${c.vcpus}'` : ''}>${c.maxVcpus}</vcpu>\n  <os${d.uefi ? " firmware='efi'" : ''}>\n    <type arch='x86_64' machine='pc-q35-8.2'>hvm</type>\n    <boot dev='hd'/>\n  </os>\n  <features>\n    <acpi/>\n    <apic/>\n  </features>\n  <cpu mode='host-passthrough' check='none' migratable='on'/>\n  <on_poweroff>destroy</on_poweroff>\n  <on_reboot>restart</on_reboot>\n  <on_crash>destroy</on_crash>\n  <devices>\n    <emulator>${'/usr/bin/qemu-system-x86_64'}</emulator>\n${disks}${nets}    <console type='pty'>\n      <target type='serial' port='0'/>\n    </console>\n    <memballoon model='virtio'/>\n  </devices>\n</domain>\n`
}

function writeXml(sys: System, d: Domain) {
  if (!d.persistent) return
  sys.vfs.mkdirp('/etc/libvirt/qemu/autostart', ROOT_CRED)
  const st = d.state
  d.state = 'shut off'
  sys.vfs.writeFile(`/etc/libvirt/qemu/${d.name}.xml`, `<!--\nWARNING: THIS IS AN AUTO-GENERATED FILE. CHANGES TO IT ARE LIKELY TO BE\nOVERWRITTEN AND LOST. Changes to this xml configuration should be made using:\n  virsh edit ${d.name}\nor other application using the libvirt API.\n-->\n\n${xmlOf(d)}`, ROOT_CRED, { mode: 0o600 })
  d.state = st
  const link = `/etc/libvirt/qemu/autostart/${d.name}.xml`
  if (d.autostart && !sys.vfs.exists(link)) sys.vfs.writeFile(link, '', ROOT_CRED)
  if (!d.autostart && sys.vfs.exists(link)) sys.vfs.unlink(link, ROOT_CRED)
}

function startDom(sys: System, d: Domain): string | undefined {
  const lv = libvirtOf(sys)
  for (const k of d.disks) {
    if (k.device === 'cdrom') continue
    if (!sys.vfs.exists(k.path)) return `Cannot access storage file '${k.path}' (as uid:107, gid:107): No such file or directory`
  }
  for (const n of d.nets) {
    if (n.network) {
      const net = lv.nets.get(n.network)
      if (!net) return `Network not found: no network with matching name '${n.network}'`
      if (!net.active) return `Requested operation is not valid: network '${n.network}' is not active`
    } else if (n.bridge && !sys.interfaces.some((i) => i.name === n.bridge)) return `Cannot get interface MTU on '${n.bridge}': No such device`
  }
  d.state = 'running'
  d.id = lv.nextId++
  d.live = { ...d.cfg }
  d.startedAt = Date.now()
  d.tcg = !(sys.vmx || sys.physical)
  // El disco crece la primera vez que arranca (instalación o primer arranque con cloud-init).
  const main = d.disks.find((k) => k.device === 'disk')
  if (main && !d.installing) {
    const meta = readImage(sys, main.path)
    if (meta && meta.format !== 'raw' && diskUsage(sys, main.path) < 0.9 * GiB) writeImage(sys, main.path, meta, Math.min(meta.virtual, 1.1 * GiB + Math.random() * 0.2 * GiB))
  }
  for (const n of d.nets) {
    const net = n.network ? lv.nets.get(n.network) : undefined
    if (!net) continue
    let lease = net.leases.find((l) => l.mac === n.mac)
    if (!lease) {
      const used = new Set(net.leases.map((l) => l.ip))
      let i = 100 + (d.id % 50)
      while (used.has(`192.168.122.${i}`)) i++
      lease = { mac: n.mac, ip: `192.168.122.${i}`, hostname: d.cloud?.hostname ?? (d.installing ? undefined : d.name), expires: Date.now() + 3600_000 }
      net.leases.push(lease)
    }
    n.ip = d.installing ? undefined : lease.ip
  }
  return undefined
}

function stopDom(d: Domain) {
  d.state = 'shut off'
  d.id = undefined
  d.cpuTime += d.startedAt ? (Date.now() - d.startedAt) / 1000 / 20 : 0
  d.startedAt = undefined
  for (const n of d.nets) n.ip = undefined
}

// ---------------------------------------------------------------------------------------
// Conexión
// ---------------------------------------------------------------------------------------

type Conn = { lv: Libvirt; session: boolean } | { error: string }

function daemonFor(sys: System, kind: 'qemu' | 'network' | 'storage') {
  if (sys.distro === 'ubuntu') return 'libvirtd'
  return kind === 'qemu' ? 'virtqemud' : kind === 'network' ? 'virtnetworkd' : 'virtstoraged'
}

const SESSIONS = new WeakMap<System, Map<string, Libvirt>>()

function connect(ctx: CommandContext, uri: string | undefined, kind: 'qemu' | 'network' | 'storage' = 'qemu'): Conn {
  const sys = ctx.sys
  const target = uri ?? ctx.sh.getVar('LIBVIRT_DEFAULT_URI') ?? (ctx.sh.user === 'root' ? 'qemu:///system' : 'qemu:///session')
  if (target === 'qemu:///session') {
    let m = SESSIONS.get(sys)
    if (!m) SESSIONS.set(sys, (m = new Map()))
    let s = m.get(ctx.sh.user)
    if (!s) m.set(ctx.sh.user, (s = { doms: new Map(), nets: new Map(), pools: new Map(), nextId: 1 }))
    return { lv: s, session: true }
  }
  if (target !== 'qemu:///system') return { error: `error: failed to connect to the hypervisor\nerror: no connection driver available for ${target}` }
  const daemon = daemonFor(sys, kind)
  if (!sys.services.get(daemon)?.active) {
    const sock = daemon === 'libvirtd' ? '/var/run/libvirt/libvirt-sock' : `/var/run/libvirt/${daemon}-sock`
    return { error: `error: failed to connect to the hypervisor\nerror: Failed to connect socket to '${sock}': No such file or directory` }
  }
  if (ctx.sh.user !== 'root') {
    const inGroup = sys.groups.get('libvirt')?.members.includes(ctx.sh.user)
    if (!inGroup) return { error: `error: failed to connect to the hypervisor\nerror: authentication unavailable: no polkit agent available to authenticate action 'org.libvirt.unix.manage'` }
  }
  return { lv: libvirtOf(sys), session: false }
}

function table(headers: string[], rows: string[][], widths?: number[]): string {
  const w = widths ?? headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
  const line = (cells: string[]) => ' ' + cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(w[i]))).join('   ').trimEnd()
  const total = w.reduce((a, b) => a + b, 0) + 3 * (w.length - 1) + 2
  return [line(headers), '-'.repeat(total), ...rows.map(line)].join('\n') + '\n'
}

function fmtDate(t: number) {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${sign}${p(Math.floor(Math.abs(off) / 60))}${p(Math.abs(off) % 60)}`
}

const VIRSH_HELP = `Usage: virsh [options]... [<command_string>]

 Domain Management (help keyword 'domain'):
    autostart, console, define, destroy, dominfo, domstate, dumpxml, list, reboot,
    setmaxmem, setmem, setvcpus, shutdown, start, suspend, resume, undefine
 Domain Monitoring: domifaddr, dommemstat
 Host and Hypervisor: nodeinfo, version
 Networking: net-list, net-info, net-start, net-destroy, net-autostart, net-dhcp-leases
 Storage Pool: pool-list   Storage Volume: vol-list
 Snapshot: snapshot-create-as, snapshot-list, snapshot-revert, snapshot-delete, snapshot-current
`

register('virsh', {
  usage: 'virsh [-c URI] comando [argumentos]',
  summary: VIRSH_HELP,
  path: '/usr/bin',
  run(ctx) {
    const sys = ctx.sys
    const args = [...ctx.args]
    let uri: string | undefined
    if (args[0] === '-c' || args[0] === '--connect') {
      uri = args[1]
      args.splice(0, 2)
    } else if (args[0]?.startsWith('--connect=')) uri = args.shift()!.slice(10)
    const cmd = args.shift()
    if (!cmd || cmd === 'help' || cmd === '--help') {
      ctx.out(VIRSH_HELP)
      return 0
    }
    if (cmd === '--version' || cmd === '-v') {
      ctx.out(`${sys.distro === 'rocky' ? '10.10.0' : '10.0.0'}\n`)
      return 0
    }
    const flags = new Set(args.filter((a) => a.startsWith('--')))
    const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--name', '--description', '--network'].includes(args[i - 1]) && false))
    const opt = (name: string) => {
      const i = args.indexOf(name)
      return i >= 0 ? args[i + 1] : undefined
    }
    const kind = cmd.startsWith('net-') ? 'network' : cmd.startsWith('pool-') || cmd.startsWith('vol-') ? 'storage' : 'qemu'
    const c = connect(ctx, uri, kind)
    if ('error' in c) {
      ctx.err(c.error + '\n')
      return 1
    }
    const lv = c.lv
    const getDom = (name: string | undefined): Domain | undefined => {
      if (!name) {
        ctx.err(`error: command '${cmd}' requires <domain> option\n`)
        return undefined
      }
      const d = lv.doms.get(name) ?? [...lv.doms.values()].find((x) => String(x.id) === name || x.uuid === name)
      if (!d) ctx.err(`error: failed to get domain '${name}'\n`)
      return d
    }
    const fail = (msg: string) => {
      ctx.err(`error: ${msg}\n`)
      return 1
    }
    switch (cmd) {
      case 'version':
        ctx.out(`Compiled against library: libvirt ${sys.distro === 'rocky' ? '10.10.0' : '10.0.0'}\nUsing library: libvirt ${sys.distro === 'rocky' ? '10.10.0' : '10.0.0'}\nUsing API: QEMU ${sys.distro === 'rocky' ? '10.10.0' : '10.0.0'}\nRunning hypervisor: QEMU ${sys.distro === 'rocky' ? '9.1.0' : '8.2.2'}\n\n`)
        return 0
      case 'uri':
        ctx.out(`${c.session ? 'qemu:///session' : 'qemu:///system'}\n`)
        return 0
      case 'nodeinfo':
        ctx.out(`CPU model:           x86_64\nCPU(s):              ${sys.ncpu}\nCPU frequency:       2400 MHz\nCPU socket(s):       1\nCore(s) per socket:  ${sys.ncpu}\nThread(s) per core:  1\nNUMA cell(s):        1\nMemory size:         ${sys.memTotalKb} KiB\n\n`)
        return 0
      case 'list': {
        const all = flags.has('--all')
        const doms = [...lv.doms.values()].filter((d) => (all || d.state !== 'shut off') && (!flags.has('--autostart') || d.autostart) && (!flags.has('--inactive') || d.state === 'shut off'))
        if (flags.has('--name')) {
          ctx.out(doms.map((d) => d.name).join('\n') + (doms.length ? '\n' : '') + '\n')
          return 0
        }
        const sorted = [...doms.filter((d) => d.id).sort((a, b) => a.id! - b.id!), ...doms.filter((d) => !d.id).sort((a, b) => a.name.localeCompare(b.name))]
        ctx.out(table(['Id', 'Name', 'State'], sorted.map((d) => [d.id ? String(d.id) : '-', d.name, d.state])) + '\n')
        return 0
      }
      case 'dominfo': {
        const d = getDom(pos[0])
        if (!d) return 1
        const cf = d.state === 'running' ? d.live : d.cfg
        ctx.out(
          `Id:             ${d.id ?? '-'}\nName:           ${d.name}\nUUID:           ${d.uuid}\nOS Type:        hvm\nState:          ${d.state}\nCPU(s):         ${cf.vcpus}\n${d.state === 'running' ? `CPU time:       ${(d.cpuTime + (Date.now() - (d.startedAt ?? Date.now())) / 1000 / 20 + 8.4).toFixed(1)}s\n` : ''}Max memory:     ${cf.maxMemKiB} KiB\nUsed memory:    ${cf.memKiB} KiB\nPersistent:     ${d.persistent ? 'yes' : 'no'}\nAutostart:      ${d.autostart ? 'enable' : 'disable'}\nManaged save:   no\nSecurity model: ${sys.distro === 'rocky' ? 'selinux' : 'apparmor'}\nSecurity DOI:   0\n${d.state === 'running' ? (sys.distro === 'rocky' ? `Security label: system_u:system_r:svirt_t:s0:c${100 + (d.id ?? 0)},c${400 + (d.id ?? 0)} (enforcing)\n` : `Security label: libvirt-${d.uuid} (enforcing)\n`) : ''}\n`,
        )
        return 0
      }
      case 'domstate': {
        const d = getDom(pos[0])
        if (!d) return 1
        ctx.out(`${d.state}${flags.has('--reason') ? (d.state === 'running' ? ' (booted)' : ' (shutdown)') : ''}\n\n`)
        return 0
      }
      case 'start': {
        const d = getDom(pos[0])
        if (!d) return 1
        if (d.state === 'running') return fail(`Failed to start domain '${d.name}'\nerror: Requested operation is not valid: domain is already running`)
        const err = startDom(sys, d)
        if (err) return fail(`Failed to start domain '${d.name}'\nerror: ${err}`)
        ctx.out(`Domain '${d.name}' started\n\n`)
        return 0
      }
      case 'shutdown':
      case 'destroy':
      case 'reboot':
      case 'suspend':
      case 'resume': {
        const d = getDom(pos[0])
        if (!d) return 1
        if (cmd === 'resume') {
          if (d.state !== 'paused') return fail(`Failed to resume domain '${d.name}'\nerror: Requested operation is not valid: domain is not paused`)
          d.state = 'running'
          ctx.out(`Domain '${d.name}' resumed\n\n`)
          return 0
        }
        if (d.state === 'shut off') return fail(`Failed to ${cmd === 'destroy' ? 'destroy' : cmd} domain '${d.name}'\nerror: Requested operation is not valid: domain is not running`)
        if (cmd === 'suspend') {
          d.state = 'paused'
          ctx.out(`Domain '${d.name}' suspended\n\n`)
          return 0
        }
        if (cmd === 'reboot') {
          ctx.out(`Domain '${d.name}' is being rebooted\n\n`)
          d.live = { ...d.cfg }
          return 0
        }
        stopDom(d)
        if (!d.persistent) lv.doms.delete(d.name)
        ctx.out(cmd === 'destroy' ? `Domain '${d.name}' destroyed\n\n` : `Domain '${d.name}' is being shutdown\n\n`)
        return 0
      }
      case 'autostart': {
        const d = getDom(pos[0])
        if (!d) return 1
        if (!d.persistent) return fail(`Failed to mark domain '${d.name}' as autostarted\nerror: Requested operation is not valid: cannot set autostart for transient domain`)
        d.autostart = !flags.has('--disable')
        writeXml(sys, d)
        ctx.out(d.autostart ? `Domain '${d.name}' marked as autostarted\n\n` : `Domain '${d.name}' unmarked as autostarted\n\n`)
        return 0
      }
      case 'undefine': {
        const d = getDom(pos[0])
        if (!d) return 1
        if (d.snapshots.length && !flags.has('--snapshots-metadata')) return fail(`Failed to undefine domain '${d.name}'\nerror: Requested operation is not valid: cannot delete inactive domain with ${d.snapshots.length} snapshots`)
        if (flags.has('--remove-all-storage') && d.state === 'running') return fail(`Storage removal is only supported for inactive domains`)
        ctx.out(`Domain '${d.name}' has been undefined\n`)
        if (flags.has('--remove-all-storage')) {
          for (const k of d.disks.filter((x) => x.device === 'disk')) {
            if (sys.vfs.exists(k.path)) sys.vfs.unlink(k.path, ROOT_CRED)
            ctx.out(`Volume '${k.target}'(${k.path}) removed.\n`)
          }
        }
        ctx.out('\n')
        if (sys.vfs.exists(`/etc/libvirt/qemu/${d.name}.xml`)) sys.vfs.unlink(`/etc/libvirt/qemu/${d.name}.xml`, ROOT_CRED)
        if (d.state === 'running') d.persistent = false
        else lv.doms.delete(d.name)
        return 0
      }
      case 'dumpxml': {
        const d = getDom(pos[0])
        if (!d) return 1
        if (flags.has('--inactive')) {
          const st = d.state
          d.state = 'shut off'
          ctx.out(xmlOf(d))
          d.state = st
        } else ctx.out(xmlOf(d))
        return 0
      }
      case 'define': {
        const file = pos[0]
        if (!file) return fail(`command 'define' requires <file> option`)
        const path = normalizePath(file.startsWith('/') ? file : `${ctx.sh.cwd}/${file}`)
        if (!sys.vfs.exists(path, ctx.sh.cred)) return fail(`Failed to open file '${file}': No such file or directory`)
        const xml = sys.vfs.readFile(path, ctx.sh.cred)
        const name = /<name>([^<]+)<\/name>/.exec(xml)?.[1]
        if (!name) return fail(`Failed to define domain from ${file}\nerror: XML error: missing domain name information`)
        const memM = /<memory(?:\s+unit='(\w+)')?>(\d+)<\/memory>/.exec(xml)
        const toKiB = (n: number, unit = 'KiB') => (unit === 'MiB' ? n * 1024 : unit === 'GiB' ? n * 1024 * 1024 : n)
        const mem = memM ? toKiB(Number(memM[2]), memM[1]) : 1048576
        const cur = /<currentMemory(?:\s+unit='(\w+)')?>(\d+)<\/currentMemory>/.exec(xml)
        const vcpu = Number(/<vcpu[^>]*>(\d+)<\/vcpu>/.exec(xml)?.[1] ?? 1)
        const curV = Number(/<vcpu[^>]*current='(\d+)'/.exec(xml)?.[1] ?? vcpu)
        const disks = [...xml.matchAll(/<source file='([^']+)'\/>/g)].map((m, i) => ({ target: `vd${String.fromCharCode(97 + i)}`, path: m[1], format: (readImage(sys, m[1])?.format ?? 'qcow2') as ImageFormat, device: 'disk' as const }))
        const existing = lv.doms.get(name)
        const cfg: DomConfig = { vcpus: curV, maxVcpus: vcpu, memKiB: cur ? toKiB(Number(cur[2]), cur[1]) : mem, maxMemKiB: mem }
        if (existing) {
          existing.cfg = cfg
          existing.persistent = true
          writeXml(sys, existing)
        } else {
          const d: Domain = { name, uuid: /<uuid>([^<]+)<\/uuid>/.exec(xml)?.[1] ?? uuid(), state: 'shut off', cfg, live: { ...cfg }, disks, nets: [...xml.matchAll(/<source network='([^']+)'\/>/g)].map((m) => ({ network: m[1], mac: newMac() })), autostart: false, persistent: true, osinfo: 'linux2024', snapshots: [], uefi: /firmware='efi'/.test(xml), tcg: false, cpuTime: 0 }
          lv.doms.set(name, d)
          writeXml(sys, d)
        }
        ctx.out(`Domain '${name}' defined from ${file}\n\n`)
        return 0
      }
      case 'setvcpus': {
        const d = getDom(pos[0])
        if (!d) return 1
        const n = Number(pos[1])
        if (!Number.isInteger(n) || n < 1) return fail(`Numeric value '${pos[1]}' for <count> option is malformed or out of range`)
        const config = flags.has('--config')
        const live = flags.has('--live') || (!config && d.state === 'running') || flags.has('--current') && d.state === 'running'
        if (flags.has('--maximum')) {
          if (!config) return fail(`invalid argument: --maximum must be used with --config only`)
          d.cfg.maxVcpus = n
          if (d.cfg.vcpus > n) d.cfg.vcpus = n
        } else {
          if (config) {
            if (n > d.cfg.maxVcpus) return fail(`invalid argument: requested vcpus is greater than max allowable vcpus for the persistent domain: ${n} > ${d.cfg.maxVcpus}`)
            d.cfg.vcpus = n
          }
          if (live) {
            if (d.state !== 'running') return fail(`Requested operation is not valid: domain is not running`)
            if (n > d.live.maxVcpus) return fail(`invalid argument: requested vcpus is greater than max allowable vcpus for the live domain: ${n} > ${d.live.maxVcpus}`)
            d.live.vcpus = n
          }
          if (!config && !live) d.cfg.vcpus = Math.min(n, d.cfg.maxVcpus)
        }
        writeXml(sys, d)
        return 0
      }
      case 'setmem':
      case 'setmaxmem': {
        const d = getDom(pos[0])
        if (!d) return 1
        const raw = pos[1] ?? ''
        const kib = /^\d+$/.test(raw) ? Number(raw) : Math.round((parseSize(raw) ?? NaN) / 1024)
        if (!Number.isFinite(kib) || kib <= 0) return fail(`Numeric value '${raw}' for <size> option is malformed or out of range`)
        const config = flags.has('--config')
        const live = flags.has('--live') || (!config && d.state === 'running')
        if (cmd === 'setmaxmem') {
          if (d.state === 'running' && !config) return fail(`Unable to change MaxMemorySize\nerror: Requested operation is not valid: cannot resize the maximum memory on an active domain`)
          d.cfg.maxMemKiB = kib
          if (d.cfg.memKiB > kib) d.cfg.memKiB = kib
        } else {
          if (config) {
            if (kib > d.cfg.maxMemKiB) return fail(`invalid argument: cannot set memory higher than max memory`)
            d.cfg.memKiB = kib
          }
          if (live) {
            if (d.state !== 'running') return fail(`Requested operation is not valid: domain is not running`)
            if (kib > d.live.maxMemKiB) return fail(`invalid argument: cannot set memory higher than max memory`)
            d.live.memKiB = kib
          }
          if (!config && !live) d.cfg.memKiB = Math.min(kib, d.cfg.maxMemKiB)
        }
        writeXml(sys, d)
        return 0
      }
      case 'dommemstat': {
        const d = getDom(pos[0])
        if (!d) return 1
        if (d.state !== 'running') return fail(`Failed to get memory statistics for domain '${d.name}'\nerror: Requested operation is not valid: domain is not running`)
        const actual = d.live.memKiB
        const unused = Math.round(actual * 0.42)
        ctx.out(`actual ${actual}\nswap_in 0\nswap_out 0\nmajor_fault 412\nminor_fault 1834410\nunused ${unused}\navailable ${actual - 49152}\nusable ${Math.round(actual * 0.61)}\nlast_update ${Math.floor(Date.now() / 1000)}\ndisk_caches ${Math.round(actual * 0.21)}\nhugetlb_pgalloc 0\nhugetlb_pgfail 0\nrss ${Math.round(Math.min(actual, d.live.maxMemKiB) * 0.71)}\n\n`)
        return 0
      }
      case 'domifaddr': {
        const d = getDom(pos[0])
        if (!d) return 1
        const rows = d.state === 'running' ? d.nets.filter((n) => n.ip).map((n, i) => [`vnet${(d.id ?? 1) - 1 + i}`, n.mac, 'ipv4', `${n.ip}/24`]) : []
        ctx.out(table(['Name', 'MAC address', 'Protocol', 'Address'], rows, [10, 20, 12, 30]) + '\n')
        return 0
      }
      case 'console': {
        const d = getDom(pos[0])
        if (!d) return 1
        if (d.state !== 'running') return fail(`The domain is not running`)
        const host = d.cloud?.hostname ?? d.name
        ctx.out(`Connected to domain '${d.name}'\nEscape character is ^] (Ctrl + ])\n\n`)
        if (d.installing) ctx.out(`(el instalador del sistema está esperando en la consola gráfica: conectate con virt-viewer o desde Cockpit)\n`)
        else ctx.out(`${/ubuntu/.test(d.osinfo) ? 'Ubuntu 24.04.3 LTS' : /rocky|rhel|alma/.test(d.osinfo) ? 'Rocky Linux 10.0 (Red Quartz)\nKernel 6.12.0-55.el10.x86_64 on x86_64' : 'Debian GNU/Linux 13'} ${host} ttyS0\n\n${host} login: \n`)
        ctx.out(`[simulador: la consola se cierra sola; en un equipo real salís con Ctrl+]]\n`)
        return 0
      }
      case 'snapshot-create-as': {
        const d = getDom(pos[0] ?? opt('--domain'))
        if (!d) return 1
        const name = opt('--name') ?? pos[1] ?? String(Math.floor(Date.now() / 1000))
        if (d.snapshots.some((s) => s.name === name)) return fail(`operation failed: domain snapshot '${name}' already exists`)
        const raw = d.disks.find((k) => k.device === 'disk' && k.format !== 'qcow2')
        if (raw && !flags.has('--disk-only')) return fail(`unsupported configuration: internal snapshot for disk ${raw.target} unsupported for storage type ${raw.format}`)
        d.snapshots.push({ name, created: Date.now(), state: d.state === 'running' ? 'running' : 'shutoff', description: opt('--description') ?? pos[2] })
        for (const k of d.disks.filter((x) => x.device === 'disk')) {
          const meta = readImage(sys, k.path)
          if (meta?.format === 'qcow2') {
            meta.snapshots = [...(meta.snapshots ?? []), { id: (meta.snapshots?.at(-1)?.id ?? 0) + 1, name, size: d.state === 'running' ? d.live.memKiB * 1024 * 0.4 : 0, date: Date.now(), vmClock: '0000:12:41.112' }]
            writeImage(sys, k.path, meta, diskUsage(sys, k.path) + (d.state === 'running' ? d.live.memKiB * 1024 * 0.4 : 0))
          }
        }
        ctx.out(`Domain snapshot ${name} created\n`)
        return 0
      }
      case 'snapshot-list': {
        const d = getDom(pos[0])
        if (!d) return 1
        ctx.out(table(['Name', 'Creation Time', 'State'], d.snapshots.map((s) => [s.name, fmtDate(s.created), s.state]), [Math.max(4, ...d.snapshots.map((s) => s.name.length)), 25, 7]) + '\n')
        return 0
      }
      case 'snapshot-current': {
        const d = getDom(pos[0])
        if (!d) return 1
        const s = d.snapshots.at(-1)
        if (!s) return fail(`operation failed: domain '${d.name}' has no current snapshot`)
        ctx.out(`${s.name}\n`)
        return 0
      }
      case 'snapshot-revert':
      case 'snapshot-delete': {
        const d = getDom(pos[0])
        if (!d) return 1
        const name = opt('--snapshotname') ?? pos[1] ?? (flags.has('--current') ? d.snapshots.at(-1)?.name : undefined)
        const s = d.snapshots.find((x) => x.name === name)
        if (!s) return fail(`Domain snapshot not found: no domain snapshot with matching name '${name}'`)
        if (cmd === 'snapshot-delete') {
          d.snapshots = d.snapshots.filter((x) => x !== s)
          for (const k of d.disks.filter((x) => x.device === 'disk')) {
            const meta = readImage(sys, k.path)
            if (meta?.snapshots) writeImage(sys, k.path, { ...meta, snapshots: meta.snapshots.filter((x) => x.name !== name) }, diskUsage(sys, k.path))
          }
          ctx.out(`Domain snapshot ${name} deleted\n\n`)
          return 0
        }
        // Volver a la instantánea: el disco y, si se tomó en marcha, también la memoria.
        if (s.state === 'running') {
          if (d.state !== 'running') startDom(sys, d)
        } else if (d.state === 'running') stopDom(d)
        return 0
      }
      case 'net-list': {
        const nets = [...lv.nets.values()].filter((n) => flags.has('--all') || n.active)
        ctx.out(table(['Name', 'State', 'Autostart', 'Persistent'], nets.map((n) => [n.name, n.active ? 'active' : 'inactive', n.autostart ? 'yes' : 'no', 'yes'])) + '\n')
        return 0
      }
      case 'net-info': {
        const n = lv.nets.get(pos[0] ?? '')
        if (!n) return fail(`failed to get network '${pos[0]}'\nerror: Network not found: no network with matching name '${pos[0]}'`)
        ctx.out(`Name:           ${n.name}\nUUID:           ${uuid()}\nActive:         ${n.active ? 'yes' : 'no'}\nPersistent:     yes\nAutostart:      ${n.autostart ? 'yes' : 'no'}\nBridge:         ${n.bridge}\n\n`)
        return 0
      }
      case 'net-start':
      case 'net-destroy':
      case 'net-autostart': {
        const n = lv.nets.get(pos[0] ?? '')
        if (!n) return fail(`failed to get network '${pos[0]}'\nerror: Network not found: no network with matching name '${pos[0]}'`)
        if (cmd === 'net-autostart') {
          n.autostart = !flags.has('--disable')
          ctx.out(`Network ${n.name} ${n.autostart ? 'marked as autostarted' : 'unmarked as autostarted'}\n\n`)
          return 0
        }
        if (cmd === 'net-start') {
          if (n.active) return fail(`Failed to start network ${n.name}\nerror: Requested operation is not valid: network is already active`)
          n.active = true
          ctx.out(`Network ${n.name} started\n\n`)
        } else {
          if (!n.active) return fail(`Failed to destroy network ${n.name}\nerror: Requested operation is not valid: network is not active`)
          n.active = false
          ctx.out(`Network ${n.name} destroyed\n\n`)
        }
        syncBridge(sys)
        return 0
      }
      case 'net-dhcp-leases': {
        const n = lv.nets.get(pos[0] ?? '')
        if (!n) return fail(`failed to get network '${pos[0]}'\nerror: Network not found: no network with matching name '${pos[0]}'`)
        const running = new Set([...lv.doms.values()].filter((d) => d.state === 'running').flatMap((d) => d.nets.map((x) => x.mac)))
        const rows = n.leases.filter((l) => running.has(l.mac)).map((l) => [fmtDate(l.expires).slice(0, 19), l.mac, 'ipv4', `${l.ip}/24`, l.hostname ?? '-', `ff:56:50:4d:98:00:02:00:00:ab:11:${hex(2)}:${hex(2)}`])
        ctx.out(table(['Expiry Time', 'MAC address', 'Protocol', 'IP address', 'Hostname', 'Client ID or DUID'], rows, [19, 17, 8, 18, 10, 20]) + '\n')
        return 0
      }
      case 'pool-list': {
        const pools = [...lv.pools.entries()].filter(([, p]) => flags.has('--all') || p.active)
        if (flags.has('--details')) {
          const fs = sys.storage
          void fs
          ctx.out(table(['Name', 'State', 'Autostart', 'Persistent', 'Capacity', 'Allocation', 'Available'], pools.map(([n, p]) => [n, p.active ? 'running' : 'inactive', p.autostart ? 'yes' : 'no', 'yes', '48.91 GiB', '12.40 GiB', '36.51 GiB'])) + '\n')
          return 0
        }
        ctx.out(table(['Name', 'State', 'Autostart'], pools.map(([n, p]) => [n, p.active ? 'active' : 'inactive', p.autostart ? 'yes' : 'no'])) + '\n')
        return 0
      }
      case 'vol-list': {
        const pool = lv.pools.get(pos[0] ?? opt('--pool') ?? '')
        if (!pool) return fail(`failed to get pool '${pos[0]}'\nerror: Storage pool not found: no storage pool with matching name '${pos[0]}'`)
        const files = sys.vfs.exists(pool.path) ? sys.vfs.readdir(pool.path, ROOT_CRED).filter((f) => !f.startsWith('.')).sort() : []
        if (flags.has('--details')) {
          ctx.out(table(['Name', 'Path', 'Type', 'Capacity', 'Allocation'], files.map((f) => {
            const p = `${pool.path}/${f}`
            const m = readImage(sys, p)
            return [f, p, 'file', qsize(m?.virtual ?? diskUsage(sys, p)).replace('i', 'i'), qsize(diskUsage(sys, p))]
          })) + '\n')
          return 0
        }
        ctx.out(table(['Name', 'Path'], files.map((f) => [f, `${pool.path}/${f}`])) + '\n')
        return 0
      }
      default:
        ctx.err(`error: unknown command: '${cmd}'\n`)
        return 1
    }
  },
})

// ---------------------------------------------------------------------------------------
// virt-install
// ---------------------------------------------------------------------------------------

function kv(s: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const part of s.split(',')) {
    const i = part.indexOf('=')
    if (i < 0) m.set(part.includes('/') ? 'path' : part, i < 0 && !part.includes('/') ? 'true' : part)
    else m.set(part.slice(0, i), part.slice(i + 1))
  }
  return m
}

/** Lo que importa de un user-data de cloud-init: el nombre del equipo y el primer usuario. */
function readCloudInit(text: string): { hostname?: string; user?: string } {
  const hostname = /^hostname:\s*(\S+)/m.exec(text)?.[1]
  const user = /^\s*-\s*name:\s*(\S+)/m.exec(text)?.[1] ?? /^user:\s*(\S+)/m.exec(text)?.[1]
  return { hostname, user }
}

register('virt-install', {
  usage: 'virt-install --name NOMBRE --memory MiB --vcpus N --disk ... --osinfo SO [--import|--cdrom ISO] [--network network=default] [--cloud-init user-data=ARCHIVO]',
  path: '/usr/bin',
  run(ctx) {
    const sys = ctx.sys
    const a = ctx.args
    const vals = new Map<string, string[]>()
    const flags = new Set<string>()
    const valued = ['--name', '-n', '--memory', '--ram', '-r', '--vcpus', '--disk', '--osinfo', '--os-variant', '--cdrom', '-c', '--location', '-l', '--network', '-w', '--graphics', '--cloud-init', '--boot', '--console', '--cpu', '--controller', '--connect']
    for (let i = 0; i < a.length; i++) {
      let k = a[i]
      let v: string | undefined
      if (k.startsWith('--') && k.includes('=') && valued.includes(k.split('=')[0])) {
        v = k.slice(k.indexOf('=') + 1)
        k = k.split('=')[0]
      }
      if (valued.includes(k)) {
        if (v === undefined) {
          const next = a[i + 1]
          if (k === '--cloud-init' && (!next || next.startsWith('--'))) v = ''
          else v = a[++i] ?? ''
        }
        const key = { '-n': '--name', '--ram': '--memory', '-r': '--memory', '--os-variant': '--osinfo', '-c': '--cdrom', '-l': '--location', '-w': '--network' }[k] ?? k
        vals.set(key, [...(vals.get(key) ?? []), v])
      } else flags.add(k)
    }
    if (flags.has('--version')) {
      ctx.out('4.1.0\n')
      return 0
    }
    const get = (k: string) => vals.get(k)?.[0]
    const err = (m: string) => {
      ctx.err(`ERROR    ${m}\n`)
      return 1
    }
    if (ctx.sh.user !== 'root' && !sys.groups.get('libvirt')?.members.includes(ctx.sh.user)) return err('Failed to connect socket to \'/var/run/libvirt/' + (sys.distro === 'rocky' ? 'virtqemud-sock' : 'libvirt-sock') + '\': Permission denied')
    const c = connect(ctx, get('--connect') ?? 'qemu:///system')
    if ('error' in c) return err(c.error.replace(/^error: /gm, '').split('\n').pop()!)
    const lv = c.lv
    const name = get('--name')
    if (!name) return err('--name is required')
    if (lv.doms.has(name)) return err(`Guest name '${name}' is already in use.`)
    const memRaw = get('--memory')
    if (!memRaw) return err('--memory amount in MiB is required')
    const memMiB = Number(/(?:memory=)?(\d+)/.exec(memRaw)?.[1])
    const curMem = Number(/currentMemory=(\d+)/.exec(memRaw)?.[1] ?? memMiB)
    const vcpuRaw = get('--vcpus') ?? '1'
    const vcpus = Number(/^(\d+)/.exec(vcpuRaw)?.[1] ?? /vcpus=(\d+)/.exec(vcpuRaw)?.[1] ?? 1)
    const maxv = Number(/maxvcpus=(\d+)/.exec(vcpuRaw)?.[1] ?? vcpus)
    const osinfo = get('--osinfo')
    const cdrom = get('--cdrom') ?? get('--location')
    const imp = flags.has('--import')
    if (!cdrom && !imp && !flags.has('--pxe') && !flags.has('--boot')) return err('An install method must be specified\n(use --location URL, --cdrom CD/ISO, --pxe, --import, --boot hd|cdrom|...)')
    if (!osinfo || osinfo === 'detect=on') return err('--os-variant/--osinfo OS name is required, but no value was set or detected.\n\nThis is now a fatal error. Specifying an OS name is required\nfor modern, performant, and secure virtual machine defaults.\n\nYou can see a full list of possible OS name values with:\n\n   virt-install --osinfo list\n\nIf your Linux distro is not listed, try one of generic values\nsuch as: linux2024, linux2022, linux2020, linux2018, linux2016\n\nIf you just need to get the old behavior back you can use:\n\n  --osinfo detect=on,require=off\n\nOr export VIRTINSTALL_OSINFO_DISABLE_REQUIRE=1')
    const os = osinfo.replace(/^name=|^short-id=/, '').split(',')[0]
    if (cdrom && !sys.vfs.exists(cdrom.startsWith('/') ? cdrom : `${ctx.sh.cwd}/${cdrom}`)) return err(`Validating install media '${cdrom}' failed: Must specify storage creation parameters for non-existent path '${cdrom}'.`)
    // Discos
    const disks: Domain['disks'] = []
    for (const [i, spec] of (vals.get('--disk') ?? []).entries()) {
      if (spec === 'none') continue
      const m = kv(spec)
      const size = m.get('size')
      let path = m.get('path')
      const fmt = (m.get('format') ?? 'qcow2') as ImageFormat
      if (!path) path = `${IMAGES}/${name}${i ? `-${i}` : ''}.${fmt}`
      path = normalizePath(path.startsWith('/') ? path : `${ctx.sh.cwd}/${path}`)
      const backing = m.get('backing_store')
      if (!sys.vfs.exists(path)) {
        if (!size && !backing) return err(`Size must be specified for non existent volume '${path}'`)
        let virtual = size ? Number(size) * GiB : 0
        if (backing) {
          const bm = readImage(sys, backing)
          if (!bm) return err(`Error validating install location: Could not open backing file '${backing}'`)
          virtual = Math.max(virtual, bm.virtual)
        }
        sys.vfs.mkdirp(path.replace(/\/[^/]+$/, ''), ROOT_CRED)
        writeImage(sys, path, { format: fmt, virtual, backing, backingFmt: backing ? 'qcow2' : undefined }, initialUsage(fmt, virtual))
      } else if (size && !imp && i === 0) {
        // virt-install no pisa un archivo existente: lo usa como está.
      }
      disks.push({ target: `vd${String.fromCharCode(97 + disks.length)}`, path, format: readImage(sys, path)?.format ?? fmt, device: 'disk' })
    }
    if (cdrom) disks.push({ target: 'sda', path: cdrom.startsWith('/') ? cdrom : normalizePath(`${ctx.sh.cwd}/${cdrom}`), format: 'raw', device: 'cdrom' })
    // Red
    const nets: Domain['nets'] = []
    for (const spec of vals.get('--network') ?? ['network=default']) {
      if (spec === 'none') continue
      const m = kv(spec)
      if (m.get('bridge')) nets.push({ bridge: m.get('bridge'), mac: m.get('mac') ?? newMac() })
      else nets.push({ network: m.get('network') ?? 'default', mac: m.get('mac') ?? newMac() })
    }
    // cloud-init
    let cloud: Domain['cloud'] = { hostname: name }
    if (vals.has('--cloud-init')) {
      const m = kv(get('--cloud-init') ?? '')
      const ud = m.get('user-data')
      if (ud) {
        const p = normalizePath(ud.startsWith('/') ? ud : `${ctx.sh.cwd}/${ud}`)
        if (!sys.vfs.exists(p, ctx.sh.cred)) return err(`Error: --cloud-init user-data=${ud}: No such file or directory`)
        const ci = readCloudInit(sys.vfs.readFile(p, ctx.sh.cred))
        cloud = { hostname: ci.hostname ?? name, user: ci.user }
      } else cloud = { hostname: name, user: 'root' }
    }
    const cfg: DomConfig = { vcpus, maxVcpus: Math.max(vcpus, maxv), memKiB: curMem * 1024, maxMemKiB: memMiB * 1024 }
    const d: Domain = { name, uuid: uuid(), state: 'shut off', cfg, live: { ...cfg }, disks, nets, autostart: false, persistent: true, osinfo: os, snapshots: [], cloud, installing: !!cdrom && !imp, uefi: /uefi/.test(get('--boot') ?? ''), tcg: false, cpuTime: 0 }
    lv.doms.set(name, d)
    if (!(sys.vmx || sys.physical)) ctx.err('WARNING  KVM acceleration not available, using \'qemu\'\n')
    const totalMem = [...lv.doms.values()].filter((x) => x.state === 'running').reduce((s, x) => s + x.live.memKiB, 0) + cfg.memKiB
    if (totalMem > sys.memTotalKb) ctx.err(`WARNING  Requested memory ${memMiB} MiB is more than the available host memory; guests will compete for RAM\n`)
    if (vals.has('--cloud-init') && !vals.get('--cloud-init')?.[0]) ctx.out('Generated random root password for the cloud-init: (se muestra en la consola la primera vez)\n')
    ctx.out('\nStarting install...\n')
    if (cdrom && !imp) ctx.out(`Retrieving '${cdrom.split('/').pop()}'                     |    0 B  00:00:00 ...\n`)
    const e = startDom(sys, d)
    if (e) {
      lv.doms.delete(name)
      return err(`${e}\nDomain installation does not appear to have been successful.`)
    }
    writeXml(sys, d)
    ctx.out('Creating domain...                                          |         00:00:00\n')
    if (flags.has('--noautoconsole') || flags.has('--wait') === false && (get('--graphics') ?? '').startsWith('vnc')) {
      if (d.installing) ctx.out('Domain is still running. Installation may be in progress.\nYou can reconnect to the console to complete the installation process.\n')
      else ctx.out('Domain creation completed.\n')
    } else {
      ctx.out(`Running text console command: virsh --connect qemu:///system console ${name}\nConnected to domain '${name}'\nEscape character is ^] (Ctrl + ])\n\n`)
      if (!d.installing) ctx.out(`[  OK  ] Finished cloud-final.service - Cloud-init: Final Stage.\n\n${cloud.hostname} login: \n[simulador: la consola se cierra sola]\n\nDomain creation completed.\n`)
      else ctx.out('(instalador en la consola)\n')
    }
    return 0
  },
})

register('systemd-detect-virt', {
  usage: 'systemd-detect-virt [--vm|--container]',
  path: '/usr/bin',
  run(ctx) {
    if (ctx.sys.physical || ctx.args.includes('--container') || ctx.args.includes('-c')) {
      ctx.out('none\n')
      return 1
    }
    ctx.out('kvm\n')
    return 0
  },
})

register('virt-host-validate', {
  usage: 'virt-host-validate [qemu|lxc]',
  path: '/usr/bin',
  run(ctx) {
    const sys = ctx.sys
    const kvm = sys.vmx || sys.physical
    const line = (t: string, r: string) => ctx.out(`  QEMU: ${t.padEnd(70, ' ')}: ${r}\n`)
    const pass = '\x1b[32mPASS\x1b[0m'
    const fail = (s: string) => `\x1b[31mFAIL\x1b[0m (${s})`
    line('Checking for hardware virtualization', kvm ? pass : fail('Only emulated CPUs are available, performance will be significantly limited'))
    if (kvm) {
      line("Checking if device '/dev/kvm' exists", pass)
      line("Checking if device '/dev/kvm' is accessible", pass)
    }
    line("Checking if device '/dev/vhost-net' exists", pass)
    line("Checking if device '/dev/net/tun' exists", pass)
    for (const c of ['cpu', 'cpuacct', 'cpuset', 'memory', 'devices', 'blkio']) line(`Checking for cgroup '${c}' controller support`, pass)
    line('Checking for device assignment IOMMU support', sys.physical ? pass : '\x1b[33mWARN\x1b[0m (No ACPI DMAR table found, IOMMU either disabled in BIOS or not supported by this hardware platform)')
    line('Checking for secure guest support', '\x1b[33mWARN\x1b[0m (Unknown if this platform has Secure Guest support)')
    return kvm ? 0 : 1
  },
})

// ---------------------------------------------------------------------------------------
// Verificaciones
// ---------------------------------------------------------------------------------------

export function verifyLibvirt(sys: System, check: object): { ok: boolean; label: string } | undefined {
  if ('dominio' in check) {
    const c = check as { dominio: string; existe?: boolean; estado?: string; vcpus?: number; memoria_mb?: number; autostart?: boolean; instantanea?: string; red?: string }
    const d = libvirtOf(sys).doms.get(c.dominio)
    const exists = !!d && d.persistent
    if (c.existe === false) return { ok: !d, label: `la máquina virtual ${c.dominio} no existe` }
    let ok = exists
    const parts: string[] = []
    if (ok && c.estado !== undefined) {
      ok = d!.state === c.estado
      parts.push(`en estado ${c.estado}`)
    }
    if (ok && c.vcpus !== undefined) {
      ok = d!.cfg.vcpus === c.vcpus
      parts.push(`con ${c.vcpus} vCPU`)
    }
    if (ok && c.memoria_mb !== undefined) {
      ok = d!.cfg.maxMemKiB === c.memoria_mb * 1024
      parts.push(`con ${c.memoria_mb} MiB`)
    }
    if (ok && c.autostart !== undefined) {
      ok = d!.autostart === c.autostart
      parts.push(c.autostart ? 'que arranca sola con el equipo' : 'sin arranque automático')
    }
    if (ok && c.instantanea !== undefined) {
      ok = d!.snapshots.some((s) => s.name === c.instantanea)
      parts.push(`con la instantánea ${c.instantanea}`)
    }
    if (ok && c.red !== undefined) {
      ok = d!.nets.some((n) => n.network === c.red || n.bridge === c.red)
      parts.push(`conectada a ${c.red}`)
    }
    return { ok, label: `la máquina virtual ${c.dominio} existe${parts.length ? ' ' + parts.join(', ') : ''}` }
  }
  if ('imagen_disco' in check) {
    const c = check as { imagen_disco: string; formato?: string; respaldo?: string; tamano_virtual_gb?: number }
    const m = readImage(sys, c.imagen_disco)
    let ok = !!m
    if (ok && c.formato) ok = m!.format === c.formato
    if (ok && c.respaldo) ok = (m!.backing ?? '').endsWith(c.respaldo)
    if (ok && c.tamano_virtual_gb !== undefined) ok = Math.round(m!.virtual / GiB) === c.tamano_virtual_gb
    return { ok, label: `la imagen ${c.imagen_disco}${c.formato ? ` en formato ${c.formato}` : ''}${c.respaldo ? ` con base ${c.respaldo}` : ''}${c.tamano_virtual_gb !== undefined ? ` de ${c.tamano_virtual_gb} GiB` : ''}` }
  }
  if ('red_libvirt' in check) {
    const c = check as { red_libvirt: string; activa?: boolean; autostart?: boolean }
    const n = libvirtOf(sys).nets.get(c.red_libvirt)
    let ok = !!n
    if (ok && c.activa !== undefined) ok = n!.active === c.activa
    if (ok && c.autostart !== undefined) ok = n!.autostart === c.autostart
    return { ok, label: `la red ${c.red_libvirt} de libvirt${c.activa ? ' activa' : ''}${c.autostart ? ' y con arranque automático' : ''}` }
  }
  return undefined
}

export type LibvirtState = NonNullable<BashState['libvirt']>
