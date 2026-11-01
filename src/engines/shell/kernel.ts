/** Estado del kernel y de la hora del servidor simulado: sysctl, módulos y chrony. */
import type { System } from './system'
import { ROOT_CRED } from './vfs'

export const SYSCTL_DEFAULTS: Record<string, string> = {
  'kernel.hostname': '',
  'kernel.osrelease': '',
  'kernel.pid_max': '4194304',
  'kernel.panic': '0',
  'kernel.sysrq': '16',
  'kernel.dmesg_restrict': '1',
  'kernel.kptr_restrict': '1',
  'kernel.randomize_va_space': '2',
  'fs.file-max': '9223372036854775807',
  'fs.protected_hardlinks': '1',
  'fs.protected_symlinks': '1',
  'kernel.core_uses_pid': '1',
  'fs.inotify.max_user_watches': '61186',
  'vm.swappiness': '60',
  'vm.dirty_ratio': '20',
  'vm.dirty_background_ratio': '10',
  'vm.overcommit_memory': '0',
  'vm.max_map_count': '65530',
  'net.ipv4.ip_forward': '0',
  'net.ipv4.tcp_syncookies': '1',
  'net.ipv4.icmp_echo_ignore_all': '0',
  'net.ipv4.conf.all.rp_filter': '1',
  'net.ipv4.conf.all.accept_redirects': '0',
  'net.ipv4.ip_local_port_range': '32768\t60999',
  'net.core.somaxconn': '4096',
  'net.ipv6.conf.all.disable_ipv6': '0',
  'net.ipv6.conf.all.forwarding': '0',
}

export function initKernel(sys: System) {
  for (const [k, v] of Object.entries(SYSCTL_DEFAULTS)) sys.sysctl.set(k, v)
  sys.sysctl.set('kernel.hostname', sys.hostname)
  sys.sysctl.set('kernel.osrelease', sys.distro === 'rocky' ? '6.12.0-55.el10.x86_64' : '6.8.0-58-generic')
  if (sys.distro === 'ubuntu') sys.sysctl.set('kernel.dmesg_restrict', '1')
  for (const [k, v] of sys.sysctl) writeProcSys(sys, k, v)
  for (const m of LOADED_BY_DEFAULT) sys.modules.add(m)
}

export function writeProcSys(sys: System, key: string, value: string) {
  const path = `/proc/sys/${key.replace(/\./g, '/')}`
  sys.vfs.mkdirp(path.slice(0, path.lastIndexOf('/')), ROOT_CRED)
  sys.vfs.writeFile(path, value + '\n', ROOT_CRED)
}


export interface ModInfo {
  desc: string
  deps: string[]
  size: number
  params?: string[]
  file: string
}

export const MODS: Record<string, ModInfo> = {
  xfs: { desc: 'SGI XFS with ACLs, security attributes, scrub, quota, no debug enabled', deps: ['libcrc32c'], size: 2834432, file: 'kernel/fs/xfs/xfs.ko.xz' },
  ext4: { desc: 'Fourth Extended Filesystem', deps: ['mbcache', 'jbd2'], size: 1101824, file: 'kernel/fs/ext4/ext4.ko.xz' },
  libcrc32c: { desc: 'CRC32c (Castagnoli) calculations', deps: [], size: 12288, file: 'kernel/lib/libcrc32c.ko.xz' },
  mbcache: { desc: 'Meta block cache (for extended attributes)', deps: [], size: 16384, file: 'kernel/fs/mbcache.ko.xz' },
  jbd2: { desc: 'Journaling layer for ext4', deps: [], size: 200704, file: 'kernel/fs/jbd2/jbd2.ko.xz' },
  dm_mod: { desc: 'device-mapper driver', deps: [], size: 237568, params: ['major:The major number of the device mapper (uint)'], file: 'kernel/drivers/md/dm-mod.ko.xz' },
  virtio_net: { desc: 'Virtio network driver', deps: ['net_failover'], size: 77824, params: ['napi_weight:int', 'csum:bool', 'gso:bool'], file: 'kernel/drivers/net/virtio_net.ko.xz' },
  net_failover: { desc: 'Failover driver for Paravirtual drivers', deps: ['failover'], size: 24576, file: 'kernel/drivers/net/net_failover.ko.xz' },
  failover: { desc: 'Generic failover infrastructure/interface', deps: [], size: 16384, file: 'kernel/net/core/failover.ko.xz' },
  e1000: { desc: 'Intel(R) PRO/1000 Network Driver', deps: [], size: 184320, params: ['TxDescriptors:Number of transmit descriptors (array of int)', 'debug:Debug level (0=none,...,16=all) (int)'], file: 'kernel/drivers/net/ethernet/intel/e1000/e1000.ko.xz' },
  sd_mod: { desc: 'SCSI disk (sd) driver', deps: [], size: 77824, file: 'kernel/drivers/scsi/sd_mod.ko.xz' },
  ahci: { desc: 'AHCI SATA low-level driver', deps: ['libahci', 'libata'], size: 49152, file: 'kernel/drivers/ata/ahci.ko.xz' },
  libahci: { desc: 'Common AHCI SATA low-level routines', deps: ['libata'], size: 53248, file: 'kernel/drivers/ata/libahci.ko.xz' },
  libata: { desc: 'Library module for ATA devices', deps: [], size: 450560, file: 'kernel/drivers/ata/libata.ko.xz' },
  nf_tables: { desc: 'Framework for packet filtering and classification', deps: ['nfnetlink'], size: 380928, file: 'kernel/net/netfilter/nf_tables.ko.xz' },
  nfnetlink: { desc: 'Netfilter messages via netlink socket', deps: [], size: 20480, file: 'kernel/net/netfilter/nfnetlink.ko.xz' },
  loop: { desc: 'Loopback device support', deps: [], size: 40960, params: ['max_loop:Maximum number of loop devices (int)'], file: 'kernel/drivers/block/loop.ko.xz' },
  overlay: { desc: 'Overlay filesystem', deps: [], size: 237568, file: 'kernel/fs/overlayfs/overlay.ko.xz' },
  br_netfilter: { desc: 'Linux ethernet netfilter firewall bridge', deps: ['bridge'], size: 36864, file: 'kernel/net/bridge/br_netfilter.ko.xz' },
  bridge: { desc: 'Ethernet bridge', deps: ['stp', 'llc'], size: 438272, file: 'kernel/net/bridge/bridge.ko.xz' },
  stp: { desc: 'Spanning Tree Protocol', deps: ['llc'], size: 12288, file: 'kernel/net/802/stp.ko.xz' },
  llc: { desc: 'Logical Link Control', deps: [], size: 32768, file: 'kernel/net/llc/llc.ko.xz' },
  usb_storage: { desc: 'USB Mass Storage driver for Linux', deps: [], size: 94208, params: ['delay_use:time to delay before using a new device (uint)', 'quirks:supplemental list of device IDs and their quirks (string)'], file: 'kernel/drivers/usb/storage/usb-storage.ko.xz' },
  vfat: { desc: 'VFAT filesystem support', deps: ['fat'], size: 24576, file: 'kernel/fs/fat/vfat.ko.xz' },
  fat: { desc: 'FAT filesystem support', deps: [], size: 106496, file: 'kernel/fs/fat/fat.ko.xz' },
  wireguard: { desc: 'WireGuard secure network tunnel', deps: ['curve25519_x86_64', 'libchacha20poly1305'], size: 118784, file: 'kernel/drivers/net/wireguard/wireguard.ko.xz' },
  curve25519_x86_64: { desc: 'Curve25519 algorithm, ADX optimized', deps: [], size: 36864, file: 'kernel/arch/x86/crypto/curve25519-x86_64.ko.xz' },
  libchacha20poly1305: { desc: 'ChaCha20Poly1305 AEAD construction', deps: [], size: 16384, file: 'kernel/lib/crypto/libchacha20poly1305.ko.xz' },
  kvm_intel: { desc: 'KVM support for Intel processors', deps: ['kvm'], size: 471040, params: ['nested:bool'], file: 'kernel/arch/x86/kvm/kvm-intel.ko.xz' },
  kvm: { desc: 'Kernel-based Virtual Machine', deps: [], size: 1409024, file: 'kernel/arch/x86/kvm/kvm.ko.xz' },
}

export const LOADED_BY_DEFAULT = ['xfs', 'libcrc32c', 'dm_mod', 'virtio_net', 'net_failover', 'failover', 'e1000', 'sd_mod', 'ahci', 'libahci', 'libata', 'nf_tables', 'nfnetlink', 'loop', 'vfat', 'fat']

export const norm = (n: string) => n.replace(/-/g, '_')

export function users(sys: System, mod: string): string[] {
  return [...sys.modules].filter((m) => MODS[m]?.deps.includes(mod))
}

export function modprobeConf(sys: System): { blacklist: Set<string>; install: Map<string, string> } {
  const blacklist = new Set<string>()
  const install = new Map<string, string>()
  for (const dir of ['/etc/modprobe.d', '/usr/lib/modprobe.d']) {
    if (!sys.vfs.exists(dir)) continue
    for (const f of sys.vfs.readdir(dir, ROOT_CRED)) {
      if (!f.endsWith('.conf')) continue
      for (const raw of sys.vfs.readFile(`${dir}/${f}`, ROOT_CRED).split('\n')) {
        const l = raw.trim().split(/\s+/)
        if (l[0] === 'blacklist' && l[1]) blacklist.add(norm(l[1]))
        if (l[0] === 'install' && l[1]) install.set(norm(l[1]), l.slice(2).join(' '))
      }
    }
  }
  return { blacklist, install }
}

/** Módulos que se cargan al arrancar (modules-load.d), menos los de la lista negra. */
export function bootModules(sys: System) {
  const { blacklist } = modprobeConf(sys)
  for (const m of [...sys.modules]) if (blacklist.has(m) && !LOADED_BY_DEFAULT.includes(m)) sys.modules.delete(m)
}


export const ZONES = ['UTC', 'America/Argentina/Buenos_Aires', 'America/Bogota', 'America/Caracas', 'America/Guatemala', 'America/La_Paz', 'America/Lima', 'America/Mexico_City', 'America/Montevideo', 'America/New_York', 'America/Santiago', 'America/Sao_Paulo', 'Europe/Madrid', 'Europe/London']

export const ZONE_OFFSET: Record<string, string> = { UTC: '+0000', 'America/Argentina/Buenos_Aires': '-0300', 'America/Bogota': '-0500', 'America/Caracas': '-0400', 'America/Guatemala': '-0600', 'America/La_Paz': '-0400', 'America/Lima': '-0500', 'America/Mexico_City': '-0600', 'America/Montevideo': '-0300', 'America/New_York': '-0500', 'America/Santiago': '-0300', 'America/Sao_Paulo': '-0300', 'Europe/Madrid': '+0100', 'Europe/London': '+0000' }

export function chronyService(sys: System) {
  return sys.services.get(sys.distro === 'rocky' ? 'chronyd' : 'chrony')
}

export function chronyConfPath(sys: System) {
  return sys.distro === 'rocky' ? '/etc/chrony.conf' : '/etc/chrony/chrony.conf'
}

/** Servidores de chrony.conf y si se puede llegar a cada uno. */
export function ntpSources(sys: System): { name: string; reachable: boolean; pool: boolean }[] {
  let text: string
  try {
    text = sys.vfs.readFile(chronyConfPath(sys), ROOT_CRED)
  } catch {
    return []
  }
  const out: { name: string; reachable: boolean; pool: boolean }[] = []
  for (const raw of text.split('\n')) {
    const m = /^\s*(server|pool)\s+(\S+)/.exec(raw)
    if (!m) continue
    const name = m[2]
    const known = /(^|\.)pool\.ntp\.org$|^time\.(cloudflare\.com|google\.com|windows\.com)$|^ntp\.ubuntu\.com$|^ntp\.shoa\.cl$/.test(name)
    const reachable = sys.internet ? known || sys.reachable.has(name) : sys.reachable.has(name)
    out.push({ name, reachable, pool: m[1] === 'pool' })
  }
  return out
}

/** Al arrancar chronyd: si hay una fuente alcanzable, sincroniza (con makestep corrige saltos grandes). */
export function chronyStart(sys: System) {
  const sources = ntpSources(sys)
  const ok = sources.some((s) => s.reachable)
  sys.clock.synced = ok
  if (ok) {
    let text = ''
    try {
      text = sys.vfs.readFile(chronyConfPath(sys), ROOT_CRED)
    } catch {
      // sin configuración
    }
    if (/^\s*makestep\s/m.test(text) || Math.abs(sys.clock.offset) < 1) sys.clock.offset = 0.000412
  }
}

