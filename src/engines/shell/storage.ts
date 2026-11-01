/**
 * Almacenamiento del servidor simulado: discos, tablas de particiones, firmas de sistemas de
 * archivos, LVM, montajes (que cambian de verdad lo que se ve en el árbol de archivos), swap y
 * archivos borrados que un proceso mantiene abiertos.
 */
import type { System } from './system'
import { normalizePath, ROOT_CRED, type Inode } from './vfs'

export const SECTOR = 512
export const MiB = 1024 ** 2
export const GiB = 1024 ** 3
const EXTENT = 4 * MiB

export type FsType = 'xfs' | 'ext4' | 'vfat' | 'swap' | 'LVM2_member'

export interface FsSig {
  type: FsType
  uuid: string
  label?: string
  /** Tamaño del sistema de archivos (puede ser menor que el dispositivo hasta hacer growfs). */
  size: number
  /** Espacio ocupado por lo que no se modela archivo por archivo (el sistema instalado). */
  baseUsed: number
  /** Raíz del árbol de archivos de este sistema de archivos. */
  rootIno?: number
}

export interface PartEntry {
  num: number
  start: number
  end: number
  /** GPT: nombre del tipo (Linux filesystem, Linux LVM, EFI System...). MBR: código (83, 8e, 82...). */
  type: string
  boot?: boolean
  /** Nombre de la partición (solo GPT, lo pone parted). */
  name?: string
}

export interface Disk {
  name: string
  size: number
  model: string
  label?: 'gpt' | 'dos'
  ptid: string
  parts: PartEntry[]
  major: number
  minor: number
  rota: boolean
}

export interface LV {
  name: string
  size: number
  minor: number
}

export interface VG {
  name: string
  uuid: string
  pvs: string[]
  lvs: LV[]
}

export interface MountEntry {
  source: string
  target: string
  fstype: string
  options: string
  /** Clave del dispositivo en sigs (para los sistemas de archivos reales). */
  dev?: string
  /** Inodo que quedó tapado por el montaje. */
  coveredIno?: number
}

export interface SwapEntry {
  path: string
  type: 'partition' | 'file'
  size: number
  used: number
  prio: number
}

export interface DeletedOpen {
  pid: number
  command: string
  user: string
  path: string
  size: number
  dev: string
}

const GPT_TYPES: Record<string, string> = {
  'linux filesystem': '0FC63DAF-8483-4772-8E79-3D69D8477DE4',
  'linux lvm': 'E6D6D379-F507-44C2-A23C-238F2A3DF928',
  'linux swap': '0657FD6D-A4AB-43C4-84E5-0933C84B4F4F',
  'efi system': 'C12A7328-F81F-11D2-BA4B-00A0C93EC93B',
  'bios boot': '21686148-6449-6E6F-744E-656564454649',
}
export const MBR_TYPES: Record<string, string> = { '83': 'Linux', '8e': 'Linux LVM', '82': 'Linux swap / Solaris', ef: 'EFI (FAT-12/16/32)', '5': 'Extended', '7': 'HPFS/NTFS/exFAT', b: 'W95 FAT32', c: 'W95 FAT32 (LBA)' }

/** Tamaños como los acepta LVM, parted o fallocate: 10G, 512M, 1.5T, 4096 (bytes o MiB según el comando). */
export function parseSize(text: string, defaultUnit = 1): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*([kKmMgGtT]?)(i?[bB])?$/.exec(text.trim())
  if (!m) return undefined
  const mult = { '': defaultUnit, k: 1024, K: 1024, m: MiB, M: MiB, g: GiB, G: GiB, t: 1024 * GiB, T: 1024 * GiB }[m[2]]!
  return Math.round(Number(m[1]) * mult)
}

/** Tamaño como lo muestra lsblk o df -h: 20G, 18.4G, 600M, 1M. */
export function humanBytes(bytes: number, si = false): string {
  const base = si ? 1000 : 1024
  const units = ['B', 'K', 'M', 'G', 'T']
  let v = bytes
  let i = 0
  while (v >= base && i < units.length - 1) {
    v /= base
    i++
  }
  if (i === 0) return `${bytes}B`
  const r = v < 10 ? Math.round(v * 10) / 10 : Math.round(v)
  return `${r}${units[i]}`
}

function hex(n: number, seed: number): string {
  let x = seed >>> 0
  let out = ''
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    out += ((x >>> 16) & 15).toString(16)
  }
  return out
}

/** Nombre del dispositivo de device-mapper: los guiones de vg y lv se duplican. */
export function dmName(vg: string, lv: string): string {
  return `${vg.replace(/-/g, '--')}-${lv.replace(/-/g, '--')}`
}

export class Storage {
  disks = new Map<string, Disk>()
  sigs = new Map<string, FsSig>()
  vgs = new Map<string, VG>()
  mounts: MountEntry[] = []
  swaps: SwapEntry[] = []
  deletedOpen: DeletedOpen[] = []
  /** Archivos que los procesos tienen abiertos. */
  openFiles: { pid: number; path: string; ino: number }[] = []
  /** Contenido de /etc/fstab que systemd leyó por última vez (para el aviso de daemon-reload). */
  fstabSeen = ''
  private seed = 7
  private nextDm = 0

  constructor(private sys: System) {
    // Un archivo borrado que un proceso tiene abierto sigue ocupando espacio hasta que el proceso lo cierra.
    sys.vfs.onRelease = (ino, node, path) => {
      for (const o of this.openFiles.filter((f) => f.ino === ino)) {
        const proc = this.sys.procs.find((p) => p.pid === o.pid)
        if (!proc) continue
        this.deletedOpen.push({ pid: o.pid, command: (proc.comm ?? proc.cmd.split(/\s+/)[0].split('/').pop() ?? '').slice(0, 15), user: proc.user, path, size: node.size ?? node.data.length, dev: this.devOfPath(path) ?? '' })
      }
      this.openFiles = this.openFiles.filter((f) => f.ino !== ino)
    }
  }

  /** Archivos borrados todavía abiertos por procesos que siguen vivos. */
  liveDeleted(): DeletedOpen[] {
    this.deletedOpen = this.deletedOpen.filter((d) => this.sys.procs.some((p) => p.pid === d.pid))
    return this.deletedOpen
  }

  newUuid(type: FsType): string {
    this.seed += 7919
    if (type === 'vfat') return `${hex(4, this.seed)}-${hex(4, this.seed + 1)}`.toUpperCase()
    if (type === 'LVM2_member') {
      const a = (n: number, s: number) => {
        const c = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
        let x = s
        let o = ''
        for (let i = 0; i < n; i++) {
          x = (x * 1103515245 + 12345) >>> 0
          o += c[(x >>> 16) % c.length]
        }
        return o
      }
      return [a(6, this.seed), a(4, this.seed + 1), a(4, this.seed + 2), a(4, this.seed + 3), a(4, this.seed + 4), a(4, this.seed + 5), a(6, this.seed + 6)].join('-')
    }
    return `${hex(8, this.seed)}-${hex(4, this.seed + 1)}-4${hex(3, this.seed + 2)}-a${hex(3, this.seed + 3)}-${hex(12, this.seed + 4)}`
  }

  // ---------------------------------------------------------------------------
  // Dispositivos
  // ---------------------------------------------------------------------------

  partPath(disk: string, num: number): string {
    return /\d$/.test(disk) ? `/dev/${disk}p${num}` : `/dev/${disk}${num}`
  }

  lvPath(vg: string, lv: string): string {
    return `/dev/mapper/${dmName(vg, lv)}`
  }

  /** Ruta canónica de un dispositivo: /dev/vg/lv, /dev/disk/by-uuid/... y enlaces → /dev/mapper/..., /dev/sdb1. */
  canonical(path: string): string | undefined {
    let p = normalizePath(path)
    const byUuid = /^\/dev\/disk\/by-uuid\/(.+)$/.exec(p)
    if (byUuid) return this.findBy('uuid', byUuid[1])
    const byLabel = /^\/dev\/disk\/by-label\/(.+)$/.exec(p)
    if (byLabel) return this.findBy('label', byLabel[1])
    const vgLv = /^\/dev\/([^/]+)\/([^/]+)$/.exec(p)
    if (vgLv && this.vgs.get(vgLv[1])?.lvs.some((l) => l.name === vgLv[2])) p = this.lvPath(vgLv[1], vgLv[2])
    return this.size(p) !== undefined ? p : undefined
  }

  findBy(kind: 'uuid' | 'label', value: string): string | undefined {
    for (const [dev, s] of this.sigs) if ((kind === 'uuid' ? s.uuid : s.label) === value) return dev
    return undefined
  }

  /** Resuelve el primer campo de fstab o el argumento de mount: UUID=, LABEL=, rutas. */
  resolveSpec(spec: string): string | undefined {
    if (spec.startsWith('UUID=')) return this.findBy('uuid', spec.slice(5).replace(/"/g, ''))
    if (spec.startsWith('LABEL=')) return this.findBy('label', spec.slice(6).replace(/"/g, ''))
    return this.canonical(spec)
  }

  /** Tamaño de un dispositivo de bloques (o undefined si no existe). */
  size(path: string): number | undefined {
    const disk = /^\/dev\/([a-z]+|nvme\d+n\d+|vd[a-z])$/.exec(path)
    if (disk && this.disks.has(disk[1])) return this.disks.get(disk[1])!.size
    const part = /^\/dev\/([a-z]+|nvme\d+n\d+)p?(\d+)$/.exec(path)
    if (part && this.disks.has(part[1])) {
      const p = this.disks.get(part[1])!.parts.find((x) => x.num === Number(part[2]))
      return p ? (p.end - p.start + 1) * SECTOR : undefined
    }
    const lv = this.findLv(path)
    if (lv) return lv.lv.size
    return undefined
  }

  findLv(path: string): { vg: VG; lv: LV } | undefined {
    for (const vg of this.vgs.values()) for (const lv of vg.lvs) if (this.lvPath(vg.name, lv.name) === path || `/dev/${vg.name}/${lv.name}` === path) return { vg, lv }
    return undefined
  }

  /** Tamaño de un PV en extents usables (el primer MiB es para los metadatos de LVM). */
  pvExtents(pv: string): number {
    return Math.max(0, Math.floor(((this.size(pv) ?? 0) - MiB) / EXTENT))
  }

  vgTotal(vg: VG): number {
    return vg.pvs.reduce((s, p) => s + this.pvExtents(p), 0) * EXTENT
  }

  vgFree(vg: VG): number {
    return this.vgTotal(vg) - vg.lvs.reduce((s, l) => s + l.size, 0)
  }

  vgOf(pv: string): VG | undefined {
    return [...this.vgs.values()].find((v) => v.pvs.includes(pv))
  }

  /** Espacio del PV usado por LV (se reparte en orden entre los PV del VG). */
  pvUsed(pv: string): number {
    const vg = this.vgOf(pv)
    if (!vg) return 0
    let need = vg.lvs.reduce((s, l) => s + l.size, 0)
    for (const p of vg.pvs) {
      const cap = this.pvExtents(p) * EXTENT
      const take = Math.min(cap, need)
      if (p === pv) return take
      need -= take
    }
    return 0
  }

  addLv(vg: VG, name: string, size: number): LV {
    const lv = { name, size, minor: this.nextDm++ }
    vg.lvs.push(lv)
    this.syncDevFiles()
    return lv
  }

  /** Qué está usando un dispositivo: montado, swap activa, PV de un VG, o tiene particiones. */
  holder(path: string): string | undefined {
    const m = this.mounts.find((x) => x.dev === path)
    if (m) return `mounted on ${m.target}`
    if (this.swaps.some((s) => s.path === path)) return 'used as swap'
    const vg = this.vgOf(path)
    if (vg) return `in use by volume group ${vg.name}`
    return undefined
  }

  // ---------------------------------------------------------------------------
  // Archivos de /dev
  // ---------------------------------------------------------------------------

  syncDevFiles() {
    const vfs = this.sys.vfs
    vfs.mkdirp('/dev/mapper', ROOT_CRED)
    vfs.mkdirp('/dev/disk/by-uuid', ROOT_CRED)
    // Borrar los que ya no existen.
    const minors = new Set([...this.vgs.values()].flatMap((v) => v.lvs.map((l) => l.minor)))
    for (const f of vfs.readdir('/dev', ROOT_CRED)) {
      const dm = /^dm-(\d+)$/.exec(f)
      if ((/^(sd[a-z]\d*|vd[a-z]\d*)$/.test(f) && this.size(`/dev/${f}`) === undefined) || (dm && !minors.has(Number(dm[1])))) vfs.unlink(`/dev/${f}`, ROOT_CRED)
    }
    for (const f of vfs.readdir('/dev/mapper', ROOT_CRED)) if (f !== 'control' && !this.findLv(`/dev/mapper/${f}`)) vfs.unlink(`/dev/mapper/${f}`, ROOT_CRED)
    for (const f of vfs.readdir('/dev/disk/by-uuid', ROOT_CRED)) vfs.unlink(`/dev/disk/by-uuid/${f}`, ROOT_CRED)
    for (const vgName of vfs.readdir('/dev', ROOT_CRED)) {
      const st = vfs.stat(`/dev/${vgName}`, ROOT_CRED, false)
      if (st.type === 'dir' && !['mapper', 'disk', 'shm', 'pts', 'net'].includes(vgName) && !this.vgs.has(vgName)) vfs.removeTree(`/dev/${vgName}`, ROOT_CRED)
    }
    const mk = (path: string, major: number, minor: number) => {
      if (!vfs.exists(path, ROOT_CRED, false)) vfs.writeFile(path, '', ROOT_CRED)
      const n = vfs.stat(path, ROOT_CRED, false)
      n.blockDev = [major, minor]
      n.mode = 0o660
      n.gid = this.sys.groups.get('disk')?.gid ?? 6
    }
    for (const d of this.disks.values()) {
      mk(`/dev/${d.name}`, d.major, d.minor)
      for (const p of d.parts) mk(this.partPath(d.name, p.num), d.major, d.minor + p.num)
    }
    for (const vg of this.vgs.values()) {
      for (const lv of vg.lvs) {
        mk(`/dev/dm-${lv.minor}`, 253, lv.minor)
        const mapper = this.lvPath(vg.name, lv.name)
        if (!vfs.exists(mapper, ROOT_CRED, false)) vfs.symlink(`../dm-${lv.minor}`, mapper, ROOT_CRED)
        vfs.mkdirp(`/dev/${vg.name}`, ROOT_CRED)
        if (!vfs.exists(`/dev/${vg.name}/${lv.name}`, ROOT_CRED, false)) vfs.symlink(`../dm-${lv.minor}`, `/dev/${vg.name}/${lv.name}`, ROOT_CRED)
      }
    }
    for (const [dev, s] of this.sigs) {
      if (!dev.startsWith('/dev/') || s.type === 'LVM2_member') continue
      const real = this.findLv(dev) ? `../../dm-${this.findLv(dev)!.lv.minor}` : `../../${dev.slice(5)}`
      if (!vfs.exists(`/dev/disk/by-uuid/${s.uuid}`, ROOT_CRED, false)) vfs.symlink(real, `/dev/disk/by-uuid/${s.uuid}`, ROOT_CRED)
    }
  }

  // ---------------------------------------------------------------------------
  // Uso de espacio
  // ---------------------------------------------------------------------------

  /** Bytes de los archivos de un árbol, sin entrar en otros montajes. */
  treeBytes(rootIno: number): number {
    const vfs = this.sys.vfs
    const covered = new Set(this.mounts.map((m) => this.mountRootIno(m)).filter((x): x is number => x !== undefined && x !== rootIno))
    const seen = new Set<number>()
    let total = 0
    const visit = (ino: number) => {
      if (seen.has(ino) || covered.has(ino)) return
      seen.add(ino)
      const n: Inode | undefined = vfs.inodes.get(ino)
      if (!n) return
      if (n.type === 'dir') {
        total += 4096
        for (const c of n.entries!.values()) visit(c)
      } else if (n.type === 'file' && !n.blockDev) total += n.size ?? n.data.length
    }
    visit(rootIno)
    return total
  }

  mountRootIno(m: MountEntry): number | undefined {
    return m.dev ? this.sigs.get(m.dev)?.rootIno : undefined
  }

  used(dev: string): number {
    const s = this.sigs.get(dev)
    if (!s) return 0
    const open = this.liveDeleted().filter((d) => d.dev === dev).reduce((a, d) => a + d.size, 0)
    return Math.min(s.size, s.baseUsed + (s.rootIno !== undefined ? this.treeBytes(s.rootIno) : 0) + open)
  }

  /** Dispositivo que contiene una ruta (el montaje más largo que la incluye). */
  devOfPath(path: string): string | undefined {
    const abs = normalizePath(path)
    let best: MountEntry | undefined
    for (const m of this.mounts) {
      if (!m.dev) continue
      if (abs === m.target || abs.startsWith(m.target === '/' ? '/' : m.target + '/')) {
        if (!best || m.target.length > best.target.length) best = m
      }
    }
    return best?.dev
  }

  mountOfPath(path: string): MountEntry | undefined {
    const abs = normalizePath(path)
    let best: MountEntry | undefined
    for (const m of this.mounts) {
      if (abs === m.target || abs.startsWith(m.target === '/' ? '/' : m.target + '/')) {
        if (!best || m.target.length > best.target.length) best = m
      }
    }
    return best
  }

  // ---------------------------------------------------------------------------
  // Montar y desmontar
  // ---------------------------------------------------------------------------

  /** Crea el árbol vacío de un sistema de archivos nuevo (ext4 trae lost+found). */
  makeFs(dev: string, type: FsType, label?: string, size?: number): FsSig {
    const vfs = this.sys.vfs
    const sig: FsSig = { type, uuid: this.newUuid(type), label, size: size ?? this.size(dev) ?? 0, baseUsed: 0 }
    if (type === 'xfs' || type === 'ext4' || type === 'vfat') {
      sig.rootIno = vfs.newDetachedDir(0o755)
      if (type === 'ext4') {
        const lf = vfs.newDetachedDir(0o700)
        vfs.get(sig.rootIno).entries!.set('lost+found', lf)
        vfs.get(sig.rootIno).nlink++
      }
      // Metadatos del sistema de archivos: un poco de espacio ocupado desde el principio.
      sig.baseUsed = type === 'xfs' ? Math.min(sig.size, Math.round(sig.size * 0.007) + 70 * MiB) : type === 'ext4' ? Math.min(sig.size, Math.round(sig.size * 0.012) + 24 * MiB) : 4096
    }
    this.sigs.set(dev, sig)
    this.syncDevFiles()
    return sig
  }

  mount(dev: string, target: string, fstype: string, options: string): void {
    const sig = this.sigs.get(dev)!
    const vfs = this.sys.vfs
    const abs = normalizePath(target)
    const covered = abs === '/' ? undefined : vfs.mountAt(abs, sig.rootIno!)
    this.mounts.push({ source: dev, target: abs, fstype, options, dev, coveredIno: covered })
    if (/\bro\b/.test(options)) vfs.get(sig.rootIno!).mode = vfs.get(sig.rootIno!).mode
  }

  unmount(m: MountEntry): void {
    if (m.coveredIno !== undefined) this.sys.vfs.mountAt(m.target, m.coveredIno)
    this.mounts = this.mounts.filter((x) => x !== m)
  }

  // ---------------------------------------------------------------------------
  // fstab
  // ---------------------------------------------------------------------------

  readFstab(): { spec: string; target: string; type: string; options: string; dump: string; pass: string; line: number }[] {
    const text = this.fstabText()
    const out: ReturnType<Storage['readFstab']> = []
    text.split('\n').forEach((raw, i) => {
      const l = raw.trim()
      if (!l || l.startsWith('#')) return
      const f = l.split(/\s+/)
      out.push({ spec: f[0], target: f[1] ?? '', type: f[2] ?? '', options: f[3] ?? 'defaults', dump: f[4] ?? '0', pass: f[5] ?? '0', line: i + 1 })
    })
    return out
  }

  fstabText(): string {
    try {
      return this.sys.vfs.readFile('/etc/fstab', ROOT_CRED)
    } catch {
      return ''
    }
  }
}

// ---------------------------------------------------------------------------------------
// Disposición inicial: la que deja el instalador de cada distribución
// ---------------------------------------------------------------------------------------

export const ROOT_UUID = { rocky: '6f1c2b8e-1a7d-4c1e-9d5a-2b6f0c3e8a11', ubuntu: 'a8c3f0d2-5e1b-4f7a-9c2d-1b6e8f0a3d54' }
export const BOOT_UUID = { rocky: '3b2e9f40-7c55-4e0b-b1aa-0d4c8b6f1e22', ubuntu: '5c7d9e1f-2a3b-4c5d-8e9f-0a1b2c3d4e5f' }
export const EFI_UUID = '1A2B-3C4D'

export interface ExtraDisk {
  nombre: string
  tamano: string
}

/** Arma el disco del sistema, sus sistemas de archivos y los montajes del arranque. */
export function installLayout(st: Storage, sys: System, extra: ExtraDisk[], rootUsed?: number) {
  const distro = sys.distro
  const uefi = sys.firmware === 'uefi'
  const total = 41943040
  const sda: Disk = { name: 'sda', size: total * SECTOR, model: 'QEMU HARDDISK', label: 'gpt', ptid: '3F1A9C2E-6B7D-4E21-9A55-0C8D2B4E7F10', parts: [], major: 8, minor: 0, rota: true }
  let pv: string
  let bootDev: string
  let efiDev: string | undefined
  if (distro === 'rocky') {
    if (!uefi) {
      sda.label = 'dos'
      sda.ptid = '0x6c1e4f2a'
      sda.parts = [
        { num: 1, start: 2048, end: 2099199, type: '83', boot: true },
        { num: 2, start: 2099200, end: 41943039, type: '8e' },
      ]
      bootDev = '/dev/sda1'
      pv = '/dev/sda2'
    } else {
      sda.parts = [
        { num: 1, start: 2048, end: 1230847, type: 'EFI System' },
        { num: 2, start: 1230848, end: 3327999, type: 'Linux filesystem' },
        { num: 3, start: 3328000, end: 41940991, type: 'Linux LVM' },
      ]
      efiDev = '/dev/sda1'
      bootDev = '/dev/sda2'
      pv = '/dev/sda3'
    }
  } else if (!uefi) {
    sda.parts = [
      { num: 1, start: 2048, end: 4095, type: 'BIOS boot' },
      { num: 2, start: 4096, end: 4198399, type: 'Linux filesystem' },
      { num: 3, start: 4198400, end: 41940991, type: 'Linux filesystem' },
    ]
    bootDev = '/dev/sda2'
    pv = '/dev/sda3'
  } else {
    sda.parts = [
      { num: 1, start: 2048, end: 2099199, type: 'EFI System' },
      { num: 2, start: 2099200, end: 6293503, type: 'Linux filesystem' },
      { num: 3, start: 6293504, end: 41940991, type: 'Linux filesystem' },
    ]
    efiDev = '/dev/sda1'
    bootDev = '/dev/sda2'
    pv = '/dev/sda3'
  }
  st.disks.set('sda', sda)
  let minor = 16
  for (const d of extra) {
    const size = parseSize(d.tamano, GiB) ?? 10 * GiB
    st.disks.set(d.nombre, { name: d.nombre, size, model: 'QEMU HARDDISK', ptid: '', parts: [], major: 8, minor, rota: true })
    minor += 16
  }

  const vfs = sys.vfs
  const rootType: FsType = distro === 'rocky' ? 'xfs' : 'ext4'
  st.sigs.set(pv, { type: 'LVM2_member', uuid: st.newUuid('LVM2_member'), size: st.size(pv)!, baseUsed: 0 })
  const vgName = distro === 'rocky' ? 'rl' : 'ubuntu-vg'
  const vg: VG = { name: vgName, uuid: st.newUuid('LVM2_member'), pvs: [pv], lvs: [] }
  st.vgs.set(vgName, vg)
  const ext = st.pvExtents(pv)
  let rootLv: LV
  if (distro === 'rocky') {
    rootLv = st.addLv(vg, 'root', (ext - 512) * EXTENT)
    const swap = st.addLv(vg, 'swap', 512 * EXTENT)
    st.sigs.set(st.lvPath(vgName, swap.name), { type: 'swap', uuid: st.newUuid('swap'), size: swap.size, baseUsed: 0 })
    st.swaps.push({ path: st.lvPath(vgName, 'swap'), type: 'partition', size: swap.size, used: 0, prio: -2 })
  } else {
    rootLv = st.addLv(vg, 'ubuntu-lv', ext * EXTENT)
  }
  const rootDev = st.lvPath(vgName, rootLv.name)
  st.sigs.set(rootDev, { type: rootType, uuid: ROOT_UUID[distro], size: rootLv.size, baseUsed: rootUsed ?? 4_400 * MiB, rootIno: vfs.root })
  st.mounts.push({ source: rootDev, target: '/', fstype: rootType, options: rootType === 'xfs' ? 'rw,relatime,seclabel,attr2,inode64,logbufs=8,logbsize=32k,noquota' : 'rw,relatime', dev: rootDev })

  // /boot y /boot/efi: el contenido que ya está en el árbol pasa a ser de su sistema de archivos.
  const adopt = (dev: string, target: string, type: FsType, uuid: string, used: number, options: string) => {
    const ino = vfs.resolve(target, ROOT_CRED)
    const under = vfs.newDetachedDir(0o755)
    vfs.mountAt(target, ino)
    st.sigs.set(dev, { type, uuid, size: st.size(dev)!, baseUsed: used, rootIno: ino })
    st.mounts.push({ source: dev, target, fstype: type, options, dev, coveredIno: under })
  }
  adopt(bootDev, '/boot', rootType, BOOT_UUID[distro], 290 * MiB, rootType === 'xfs' ? 'rw,relatime,seclabel,attr2,inode64,logbufs=8,logbsize=32k,noquota' : 'rw,relatime')
  if (efiDev) adopt(efiDev, '/boot/efi', 'vfat', EFI_UUID, 7 * MiB, 'rw,relatime,fmask=0077,dmask=0077,codepage=437,iocharset=ascii,shortname=winnt,errors=remount-ro')
  if (distro === 'ubuntu') {
    vfs.writeFile('/swap.img', '', ROOT_CRED, { mode: 0o600 })
    vfs.stat('/swap.img', ROOT_CRED).size = 2 * GiB
    st.sigs.set('/swap.img', { type: 'swap', uuid: st.newUuid('swap'), size: 2 * GiB, baseUsed: 0 })
    st.swaps.push({ path: '/swap.img', type: 'file', size: 2 * GiB, used: 0, prio: -2 })
  }
  st.syncDevFiles()
  vfs.writeFile('/etc/fstab', defaultFstab(sys, rootDev, bootDev, efiDev), ROOT_CRED)
  st.fstabSeen = st.fstabText()
}

function defaultFstab(sys: System, rootDev: string, bootDev: string, efiDev?: string): string {
  if (sys.distro === 'rocky') {
    return (
      '\n#\n# /etc/fstab\n# Created by anaconda on Mon Oct 12 09:41:27 2026\n#\n' +
      "# Accessible filesystems, by reference, are maintained under '/dev/disk/'.\n" +
      '# See man pages fstab(5), findfs(8), mount(8) and/or blkid(8) for more info.\n#\n' +
      "# After editing this file, run 'systemctl daemon-reload' to update systemd\n# units generated from this file.\n#\n" +
      `${rootDev.padEnd(23)} /                       xfs     defaults        0 0\n` +
      `UUID=${BOOT_UUID.rocky} /boot                   xfs     defaults        0 0\n` +
      (efiDev ? `UUID=${EFI_UUID}          /boot/efi               vfat    umask=0077,shortname=winnt 0 2\n` : '') +
      `/dev/mapper/rl-swap     none                    swap    defaults        0 0\n`
    )
  }
  return (
    "# /etc/fstab: static file system information.\n#\n# Use 'blkid' to print the universally unique identifier for a\n" +
    '# device; this may be used with UUID= as a more robust way to name devices\n# that works even if disks are added and removed. See fstab(5).\n#\n' +
    '# <file system> <mount point>   <type>  <options>       <dump>  <pass>\n' +
    `# / was on /dev/ubuntu-vg/ubuntu-lv during curtin installation\n/dev/disk/by-uuid/${ROOT_UUID.ubuntu} / ext4 defaults 0 1\n` +
    `# /boot was on ${bootDev} during curtin installation\n/dev/disk/by-uuid/${BOOT_UUID.ubuntu} /boot ext4 defaults 0 1\n` +
    (efiDev ? `# /boot/efi was on ${efiDev} during curtin installation\n/dev/disk/by-uuid/${EFI_UUID} /boot/efi vfat defaults 0 1\n` : '') +
    '/swap.img\tnone\tswap\tsw\t0\t0\n'
  )
}

interface StatePart {
  tamano: string
  tipo: 'linux' | 'lvm' | 'swap'
  fs?: 'xfs' | 'ext4' | 'vfat' | 'swap'
  montaje?: string
  usado?: string
  fstab: boolean
}
interface StateDisk {
  nombre: string
  tamano: string
  tabla?: 'gpt' | 'msdos'
  particiones: StatePart[]
}
interface StateVg {
  vg: string
  discos: string[]
  lvs: { nombre: string; tamano: string; fs?: 'xfs' | 'ext4' | 'vfat' | 'swap'; montaje?: string; usado?: string; fstab: boolean }[]
}

/** Crea lo que describe el ejercicio: particiones, volúmenes, sistemas de archivos, montajes y fstab. */
export function applyStateStorage(st: Storage, sys: System, disks: StateDisk[], vgs: StateVg[]) {
  const fstab: string[] = []
  const finish = (dev: string, fs: StatePart['fs'], montaje?: string, usado?: string, inFstab = true) => {
    if (!fs) return
    if (fs === 'swap') {
      st.sigs.set(dev, { type: 'swap', uuid: st.newUuid('swap'), size: st.size(dev)!, baseUsed: 0 })
      st.swaps.push({ path: dev, type: 'partition', size: st.size(dev)!, used: 0, prio: -3 - st.swaps.length })
      if (inFstab) fstab.push(`UUID=${st.sigs.get(dev)!.uuid} none swap defaults 0 0`)
      return
    }
    const sig = st.makeFs(dev, fs)
    if (usado) sig.baseUsed = Math.min(sig.size, parseSize(usado, GiB) ?? 0)
    if (montaje) {
      sys.vfs.mkdirp(montaje, ROOT_CRED)
      st.mount(dev, normalizePath(montaje), fs, fs === 'xfs' ? 'rw,relatime,seclabel,attr2,inode64,logbufs=8,logbsize=32k,noquota' : 'rw,relatime')
      if (inFstab) fstab.push(`UUID=${sig.uuid} ${montaje} ${fs} defaults 0 0`)
    }
  }
  for (const d of disks) {
    const disk = st.disks.get(d.nombre)!
    if (!d.particiones.length && !d.tabla) continue
    disk.label = d.tabla === 'msdos' ? 'dos' : 'gpt'
    disk.ptid = disk.label === 'gpt' ? st.newUuid('xfs').toUpperCase() : '0x' + st.newUuid('vfat').replace('-', '').toLowerCase()
    let cursor = 2048
    const lastSector = disk.label === 'gpt' ? Math.floor((disk.size / SECTOR - 33) / 2048) * 2048 - 1 : disk.size / SECTOR - 1
    d.particiones.forEach((p, i) => {
      const bytes = p.tamano === '100%' ? (lastSector - cursor + 1) * SECTOR : (parseSize(p.tamano, GiB) ?? GiB)
      const end = Math.min(lastSector, cursor + bytes / SECTOR - 1)
      const type = disk.label === 'gpt' ? { linux: 'Linux filesystem', lvm: 'Linux LVM', swap: 'Linux swap' }[p.tipo] : { linux: '83', lvm: '8e', swap: '82' }[p.tipo]
      disk.parts.push({ num: i + 1, start: cursor, end, type })
      cursor = end + 1
      if (p.tipo === 'lvm') st.sigs.set(st.partPath(disk.name, i + 1), { type: 'LVM2_member', uuid: st.newUuid('LVM2_member'), size: (end - disk.parts[i].start + 1) * SECTOR, baseUsed: 0 })
    })
    st.syncDevFiles()
    d.particiones.forEach((p, i) => finish(st.partPath(disk.name, i + 1), p.fs, p.montaje, p.usado, p.fstab))
  }
  for (const v of vgs) {
    const pvs = v.discos.map((x) => (x.startsWith('/dev/') ? x : `/dev/${x}`))
    for (const pv of pvs) if (!st.sigs.has(pv)) st.sigs.set(pv, { type: 'LVM2_member', uuid: st.newUuid('LVM2_member'), size: st.size(pv) ?? 0, baseUsed: 0 })
    const vg: VG = { name: v.vg, uuid: st.newUuid('LVM2_member'), pvs, lvs: [] }
    st.vgs.set(v.vg, vg)
    for (const lv of v.lvs) {
      const size = Math.ceil((parseSize(lv.tamano, GiB) ?? GiB) / EXTENT) * EXTENT
      st.addLv(vg, lv.nombre, Math.min(size, st.vgFree(vg)))
      finish(st.lvPath(v.vg, lv.nombre), lv.fs, lv.montaje, lv.usado, lv.fstab)
    }
  }
  st.syncDevFiles()
  if (fstab.length) {
    sys.vfs.writeFile('/etc/fstab', st.fstabText() + fstab.join('\n') + '\n', ROOT_CRED)
    st.fstabSeen = st.fstabText()
  }
}

/** Montajes virtuales que aparecen en mount y findmnt (no son discos). */
export const VIRTUAL_MOUNTS: { source: string; target: string; fstype: string; options: string }[] = [
  { source: 'proc', target: '/proc', fstype: 'proc', options: 'rw,nosuid,nodev,noexec,relatime' },
  { source: 'sysfs', target: '/sys', fstype: 'sysfs', options: 'rw,nosuid,nodev,noexec,relatime' },
  { source: 'devtmpfs', target: '/dev', fstype: 'devtmpfs', options: 'rw,nosuid,size=4096k,nr_inodes=482110,mode=755' },
  { source: 'tmpfs', target: '/dev/shm', fstype: 'tmpfs', options: 'rw,nosuid,nodev' },
  { source: 'tmpfs', target: '/run', fstype: 'tmpfs', options: 'rw,nosuid,nodev,size=768716k,nr_inodes=819200,mode=755' },
]

export { GPT_TYPES, EXTENT }
