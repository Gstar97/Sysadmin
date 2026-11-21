/**
 * ZFS: pools (zpool) con espejos, RAIDZ y discos sueltos, su estado y sus errores, scrub y
 * resilver que avanzan con el tiempo (sleep), reemplazo de discos; datasets y volúmenes (zfs)
 * con propiedades, cuotas, instantáneas que guardan de verdad los archivos (rollback los
 * devuelve), clones, y send/receive (también por ssh a otro servidor).
 *
 * En Proxmox, los discos de las VM en un almacenamiento zfspool aparecen como volúmenes del pool,
 * y pvesr replica esos discos a otro nodo del clúster cada tantos minutos.
 */
import { register, type CommandContext } from './shell'
import { System } from './system'
import { ROOT_CRED, normalizePath } from './vfs'
import { GiB, MiB, type Disk } from './storage'
import type { BashState } from './schema'
import { pveOf, pveHooks, fmtTime, type Pve, type PveGuest } from './proxmox'

// ---------------------------------------------------------------------------------------
// Modelo
// ---------------------------------------------------------------------------------------

type MemberState = 'ONLINE' | 'FAULTED' | 'OFFLINE' | 'UNAVAIL' | 'REMOVED' | 'DEGRADED'

interface ZMember {
  dev: string
  state: MemberState
  read: number
  write: number
  cksum: number
  /** El disco está fallando de verdad: aunque se limpien los errores, vuelve a fallar. */
  bad?: boolean
  /** Disco nuevo que lo está reemplazando (zpool replace). */
  replacing?: ZMember
}

interface ZVdev {
  type: 'mirror' | 'raidz1' | 'raidz2' | 'raidz3' | 'disk'
  members: ZMember[]
}

interface TreeEntry {
  rel: string
  type: 'file' | 'dir'
  data: string
  mode: number
  uid: number
  gid: number
  size: number
}

interface ZSnap {
  name: string
  created: number
  /** Bytes que ocupaba el dataset al sacar la instantánea (lo que no se modela archivo por archivo). */
  base: number
  files: TreeEntry[]
}

interface ZDataset {
  name: string
  type: 'filesystem' | 'volume'
  props: Map<string, string>
  /** Lo que ocupa sin contar los archivos que el simulador sigue uno por uno. */
  base: number
  volsize?: number
  snaps: ZSnap[]
  created: number
  origin?: string
}

interface ZScan {
  kind: 'scrub' | 'resilver'
  start: number
  total: number
  done: number
  finished?: number
  repaired: number
  errors: number
}

export interface ZPool {
  name: string
  vdevs: ZVdev[]
  ashift: number
  created: number
  scan?: ZScan
  history: string[]
  datasets: Map<string, ZDataset>
  exported?: boolean
  /** Errores permanentes en archivos (se perdieron datos). */
  dataErrors: string[]
}

const POOLS = new WeakMap<System, Map<string, ZPool>>()

export function pools(sys: System): Map<string, ZPool> {
  let m = POOLS.get(sys)
  if (!m) POOLS.set(sys, (m = new Map()))
  return m
}

const SPEED = 250 * MiB
const DEFAULTS: Record<string, string> = {
  compression: 'on',
  atime: 'on',
  recordsize: '128K',
  quota: 'none',
  reservation: 'none',
  refquota: 'none',
  sync: 'standard',
  copies: '1',
  dedup: 'off',
  readonly: 'off',
  xattr: 'sa',
  acltype: 'off',
  canmount: 'on',
  snapdir: 'hidden',
  volblocksize: '16K',
}
const INHERITABLE = new Set(['compression', 'atime', 'recordsize', 'sync', 'copies', 'dedup', 'readonly', 'xattr', 'acltype', 'snapdir'])

function human(n: number): string {
  if (n < 1024) return `${Math.round(n)}B`
  const units = ['K', 'M', 'G', 'T', 'P']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const s = v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : v.toFixed(0)
  return `${s.replace(/\.?0+$/, (m) => (m.startsWith('.') ? '' : m))}${units[i]}`
}

function parseZSize(t: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)([KMGTP]?)B?$/i.exec(t.trim())
  if (!m) return undefined
  const mult: Record<string, number> = { '': 1, K: 1024, M: MiB, G: GiB, T: 1024 * GiB, P: 1024 ** 5 }
  return Math.round(Number(m[1]) * mult[m[2].toUpperCase()])
}

function devName(d: string) {
  return d.replace(/^\/dev\//, '')
}

function diskOf(sys: System, dev: string): Disk | undefined {
  return sys.storage.disks.get(devName(dev))
}

function memberSize(sys: System, m: ZMember) {
  return diskOf(sys, m.dev)?.size ?? 0
}

function parity(v: ZVdev) {
  return v.type === 'raidz1' ? 1 : v.type === 'raidz2' ? 2 : v.type === 'raidz3' ? 3 : 0
}

/** Lo que entra en el vdev (sin paridad). */
function vdevUsable(sys: System, v: ZVdev) {
  const min = Math.min(...v.members.map((m) => memberSize(sys, m)))
  if (v.type === 'mirror') return min
  if (v.type === 'disk') return memberSize(sys, v.members[0])
  return min * (v.members.length - parity(v))
}

/** Tamaño crudo (el que muestra zpool list: con la paridad de RAIDZ, sin la copia del espejo). */
function vdevRaw(sys: System, v: ZVdev) {
  const min = Math.min(...v.members.map((m) => memberSize(sys, m)))
  if (v.type === 'mirror') return min
  if (v.type === 'disk') return memberSize(sys, v.members[0])
  return min * v.members.length
}

function healthy(m: ZMember) {
  return m.state === 'ONLINE' && !m.replacing
}

function vdevState(v: ZVdev): MemberState {
  const bad = v.members.filter((m) => !(m.state === 'ONLINE' || (m.replacing && m.replacing.state === 'ONLINE' && false))).length
  const ok = v.members.filter((m) => m.state === 'ONLINE').length
  if (v.type === 'disk') return v.members[0].state
  const tolerance = v.type === 'mirror' ? v.members.length - 1 : parity(v)
  if (bad === 0 && v.members.every((m) => !m.replacing)) return 'ONLINE'
  if (v.members.length - ok > tolerance) return 'UNAVAIL'
  return 'DEGRADED'
}

export function poolHealth(p: ZPool): 'ONLINE' | 'DEGRADED' | 'UNAVAIL' | 'FAULTED' {
  const st = p.vdevs.map(vdevState)
  if (st.some((s) => s === 'UNAVAIL' || s === 'FAULTED')) return 'UNAVAIL'
  if (st.some((s) => s !== 'ONLINE')) return 'DEGRADED'
  return 'ONLINE'
}

function poolUsable(sys: System, p: ZPool) {
  return p.vdevs.reduce((s, v) => s + vdevUsable(sys, v), 0) * 0.96
}

function poolRaw(sys: System, p: ZPool) {
  return p.vdevs.reduce((s, v) => s + vdevRaw(sys, v), 0)
}

// ---------------------------------------------------------------------------------------
// Archivos de los datasets (para que las instantáneas guarden algo de verdad)
// ---------------------------------------------------------------------------------------

function mountpoint(p: ZPool, d: ZDataset): string | undefined {
  if (d.type === 'volume') return undefined
  const mp = d.props.get('mountpoint')
  if (mp === 'none' || mp === 'legacy') return undefined
  if (mp) return mp
  // Heredado: el del padre más el resto del nombre.
  const parent = d.name.includes('/') ? p.datasets.get(d.name.slice(0, d.name.lastIndexOf('/'))) : undefined
  if (!parent) return `/${d.name}`
  const pm = mountpoint(p, parent)
  return pm ? normalizePath(`${pm}/${d.name.slice(d.name.lastIndexOf('/') + 1)}`) : undefined
}

function otherMountpoints(sys: System, except: string): string[] {
  const out: string[] = []
  for (const p of pools(sys).values()) for (const d of p.datasets.values()) {
    const mp = mountpoint(p, d)
    if (mp && mp !== except) out.push(mp)
  }
  return out
}

function capture(sys: System, root: string): TreeEntry[] {
  const vfs = sys.vfs
  if (!vfs.exists(root, ROOT_CRED)) return []
  const skip = otherMountpoints(sys, root).filter((m) => m.startsWith(root + '/'))
  const out: TreeEntry[] = []
  const walk = (dir: string) => {
    for (const name of vfs.readdir(dir, ROOT_CRED)) {
      const path = `${dir === '/' ? '' : dir}/${name}`
      if (skip.includes(path)) continue
      const st = vfs.stat(path, ROOT_CRED, false)
      if (st.type === 'dir') {
        out.push({ rel: path.slice(root.length + 1), type: 'dir', data: '', mode: st.mode, uid: st.uid, gid: st.gid, size: 0 })
        walk(path)
      } else if (st.type === 'file') {
        out.push({ rel: path.slice(root.length + 1), type: 'file', data: st.data, mode: st.mode, uid: st.uid, gid: st.gid, size: st.size ?? st.data.length })
      }
    }
  }
  walk(root)
  return out
}

function restore(sys: System, root: string, files: TreeEntry[]) {
  const vfs = sys.vfs
  const skip = otherMountpoints(sys, root).filter((m) => m.startsWith(root + '/'))
  vfs.mkdirp(root, ROOT_CRED)
  for (const name of vfs.readdir(root, ROOT_CRED)) {
    const path = `${root}/${name}`
    if (skip.some((m) => m === path || m.startsWith(path + '/'))) continue
    vfs.removeTree(path, ROOT_CRED)
  }
  for (const f of files) {
    const path = `${root}/${f.rel}`
    if (f.type === 'dir') vfs.mkdirp(path, ROOT_CRED)
    else {
      vfs.mkdirp(path.slice(0, path.lastIndexOf('/')), ROOT_CRED)
      vfs.writeFile(path, f.data, ROOT_CRED, { mode: f.mode })
      const n = vfs.stat(path, ROOT_CRED)
      n.size = f.size
    }
    const n = vfs.stat(path, ROOT_CRED)
    n.uid = f.uid
    n.gid = f.gid
    n.mode = (n.mode & ~0o7777) | (f.mode & 0o7777)
  }
}

function filesBytes(files: TreeEntry[]) {
  return files.reduce((s, f) => s + f.size, 0)
}

function liveBytes(sys: System, p: ZPool, d: ZDataset) {
  const mp = mountpoint(p, d)
  return mp ? filesBytes(capture(sys, mp)) : 0
}

/** Lo que ocupa una instantánea: los datos que ya no están en la versión siguiente. */
function snapUsed(sys: System, p: ZPool, d: ZDataset, i: number) {
  const s = d.snaps[i]
  const next = d.snaps[i + 1]?.files ?? (mountpoint(p, d) ? capture(sys, mountpoint(p, d)!) : s.files)
  const nextMap = new Map(next.map((f) => [f.rel, f.data]))
  const changed = s.files.filter((f) => f.type === 'file' && nextMap.get(f.rel) !== f.data).reduce((a, f) => a + f.size, 0)
  const baseDiff = Math.max(0, s.base - (d.snaps[i + 1]?.base ?? d.base))
  return changed + baseDiff
}

function refer(sys: System, p: ZPool, d: ZDataset) {
  if (d.type === 'volume') return d.base
  return Math.max(96 * 1024, d.base + liveBytes(sys, p, d))
}

function usedOf(sys: System, p: ZPool, d: ZDataset): number {
  const children = [...p.datasets.values()].filter((x) => x.name.startsWith(d.name + '/') && !x.name.slice(d.name.length + 1).includes('/'))
  const snaps = d.snaps.reduce((s, _x, i) => s + snapUsed(sys, p, d, i), 0)
  const own = d.type === 'volume' ? Math.max(d.base, d.props.get('refreservation') === 'none' ? 0 : (d.volsize ?? 0)) : refer(sys, p, d)
  return own + snaps + children.reduce((s, c) => s + usedOf(sys, p, c), 0) + pveZvols(sys, p, d.name).reduce((s, v) => s + v.used, 0)
}

function poolAlloc(sys: System, p: ZPool) {
  const root = p.datasets.get(p.name)!
  const used = usedOf(sys, p, root)
  // En RAIDZ, lo asignado incluye la paridad.
  const v = p.vdevs[0]
  const factor = v && v.type.startsWith('raidz') ? v.members.length / (v.members.length - parity(v)) : 1
  return used * factor
}

function avail(sys: System, p: ZPool, d: ZDataset) {
  const free = Math.max(0, poolUsable(sys, p) - usedOf(sys, p, p.datasets.get(p.name)!))
  let a = free
  let cur: ZDataset | undefined = d
  while (cur) {
    const q = parseZSize(cur.props.get('quota') ?? 'none')
    if (q) a = Math.min(a, Math.max(0, q - usedOf(sys, p, cur)))
    cur = cur.name.includes('/') ? p.datasets.get(cur.name.slice(0, cur.name.lastIndexOf('/'))) : undefined
  }
  return a
}

function prop(p: ZPool, d: ZDataset, k: string): { value: string; source: string } {
  if (d.props.has(k)) return { value: d.props.get(k)!, source: 'local' }
  if (INHERITABLE.has(k)) {
    let cur = d.name.includes('/') ? p.datasets.get(d.name.slice(0, d.name.lastIndexOf('/'))) : undefined
    while (cur) {
      if (cur.props.has(k)) return { value: cur.props.get(k)!, source: `inherited from ${cur.name}` }
      cur = cur.name.includes('/') ? p.datasets.get(cur.name.slice(0, cur.name.lastIndexOf('/'))) : undefined
    }
  }
  return { value: DEFAULTS[k] ?? '-', source: DEFAULTS[k] ? 'default' : '-' }
}

// ---------------------------------------------------------------------------------------
// Proxmox: discos de VM en un zfspool, y pvesr
// ---------------------------------------------------------------------------------------

interface VirtualZvol {
  name: string
  used: number
  volsize: number
  snaps: string[]
}

/** Los discos de VM de un almacenamiento zfspool, como volúmenes de ese dataset. */
function pveZvols(sys: System, p: ZPool, parent: string): VirtualZvol[] {
  const pve = pveOf(sys)
  if (!pve) return []
  const out: VirtualZvol[] = []
  for (const st of pve.storages.values()) {
    if (st.type !== 'zfspool' || st.path !== parent || !p.datasets.has(parent)) continue
    for (const v of pve.volumes.values()) {
      if (v.storage !== st.id || v.content === 'backup') continue
      const name = `${parent}/${v.volid.split(':')[1]}`
      out.push({ name, used: v.size * 0.22, volsize: v.size, snaps: (REPL.get(pve)?.filter((j) => j.vmid === v.vmid && j.last) ?? []).map((j) => `__replicate_${j.id}_${Math.floor(j.last! / 1000)}__`) })
    }
  }
  return out
}

/** Para que proxmox.ts sepa si existe un dataset (pvesm add zfspool). */
export function datasetExists(sys: System, name: string): boolean {
  for (const p of pools(sys).values()) if (!p.exported && p.datasets.has(name)) return true
  return false
}
pveHooks.datasetExists = datasetExists

// ---------------------------------------------------------------------------------------
// Estado inicial
// ---------------------------------------------------------------------------------------

function partitionAsZfs(sys: System, dev: string) {
  const d = diskOf(sys, dev)
  if (!d) return
  d.label = 'gpt'
  const end = Math.floor(d.size / 512) - 16385 - 2048
  d.parts = [
    { num: 1, start: 2048, end, type: 'Solaris /usr & Apple ZFS', name: 'zfs-' + Math.random().toString(16).slice(2, 18) },
    { num: 9, start: end + 1, end: end + 16384, type: 'Solaris reserved 1' },
  ]
  sys.storage.sigs.set(`/dev/${d.name}1`, { type: 'zfs_member', uuid: String(Math.floor(Math.random() * 1e19)), size: d.size, baseUsed: 0 })
  sys.storage.syncDevFiles()
}

function freeDisk(sys: System, dev: string) {
  const d = diskOf(sys, dev)
  if (!d) return
  sys.storage.sigs.delete(`/dev/${d.name}1`)
}

function newPool(name: string, vdevs: ZVdev[], ashift = 12): ZPool {
  const p: ZPool = { name, vdevs, ashift, created: Date.now(), history: [], datasets: new Map(), dataErrors: [] }
  p.datasets.set(name, { name, type: 'filesystem', props: new Map(), base: 96 * 1024, snaps: [], created: Date.now() })
  return p
}

System.initHooks.push((sys, state: BashState) => {
  const z = state.zfs
  if (!z) return
  for (const ps of z.pools) {
    const vdevs: ZVdev[] = (ps.vdevs ?? [{ tipo: ps.tipo, discos: ps.discos }]).map((v) => ({
      type: v.tipo === 'stripe' ? 'disk' : (v.tipo as ZVdev['type']),
      members: v.discos.map((d) => {
        const bad = ps.fallados.includes(d)
        return { dev: d, state: bad ? 'FAULTED' : ps.sin_conectar.includes(d) ? 'UNAVAIL' : 'ONLINE', read: bad ? 47 : 0, write: bad ? 212 : 0, cksum: bad ? 3 : 0, bad } as ZMember
      }),
    }))
    // Un "stripe" de varios discos son varios vdevs de un disco.
    const flat = vdevs.flatMap((v) => (v.type === 'disk' ? v.members.map((m) => ({ type: 'disk' as const, members: [m] })) : [v]))
    const p = newPool(ps.nombre, flat, ps.ashift)
    p.created = Date.now() - 200 * 86_400_000
    p.history.push(`${fmtTime(p.created).replace(' ', '.')} zpool create -o ashift=${ps.ashift} ${ps.nombre} ${flat.map((v) => (v.type === 'disk' ? v.members[0].dev : `${v.type === 'raidz1' ? 'raidz' : v.type} ${v.members.map((m) => m.dev).join(' ')}`)).join(' ')}`)
    const root = p.datasets.get(ps.nombre)!
    for (const [k, v] of Object.entries(ps.propiedades)) root.props.set(k, v)
    for (const ds of ps.datasets) {
      const d: ZDataset = { name: ds.nombre, type: ds.volumen_gb ? 'volume' : 'filesystem', props: new Map(Object.entries(ds.propiedades)), base: ds.usado_gb * GiB, volsize: ds.volumen_gb ? ds.volumen_gb * GiB : undefined, snaps: [], created: Date.now() - 100 * 86_400_000 }
      p.datasets.set(d.name, d)
      ds.instantaneas.forEach((s, i, all) => d.snaps.push({ name: s, created: Date.now() - (all.length - i) * 86_400_000, base: d.base * (0.9 + i * 0.02), files: [] }))
    }
    if (ps.ultimo_scrub_dias !== undefined) {
      const t = Date.now() - ps.ultimo_scrub_dias * 86_400_000
      p.scan = { kind: 'scrub', start: t - 751_000, total: 1, done: 1, finished: t, repaired: 0, errors: 0 }
    }
    p.dataErrors = [...ps.errores_datos]
    pools(sys).set(p.name, p)
    for (const v of flat) for (const m of v.members) partitionAsZfs(sys, m.dev)
    for (const d of p.datasets.values()) {
      const mp = mountpoint(p, d)
      if (mp) sys.vfs.mkdirp(mp, ROOT_CRED)
    }
  }
})

// El tiempo hace avanzar el scrub y el resilver, y la réplica de Proxmox.
System.sleepHooks.push((sys, seconds) => {
  for (const s of [sys, ...sys.lab]) {
    for (const p of pools(s).values()) advanceScan(s, p, seconds * 1000)
    replicationTick(s, seconds)
  }
})

function advanceScan(sys: System, p: ZPool, ms: number) {
  const sc = p.scan
  if (!sc || sc.finished) return
  sc.done = Math.min(sc.total, sc.done + (SPEED * ms) / 1000)
  if (sc.done < sc.total) return
  sc.finished = sc.start + (sc.total / SPEED) * 1000
  if (sc.kind === 'resilver') {
    for (const v of p.vdevs) {
      for (let i = 0; i < v.members.length; i++) {
        const m = v.members[i]
        if (m.replacing) {
          freeDisk(sys, m.dev)
          v.members[i] = { ...m.replacing, replacing: undefined, state: 'ONLINE' }
        }
      }
    }
    p.history.push(`${fmtTime(Date.now()).replace(' ', '.')} [resilver finished]`)
  }
}

// ---------------------------------------------------------------------------------------
// zpool
// ---------------------------------------------------------------------------------------

function parseVdevs(ctx: CommandContext, args: string[]): ZVdev[] | string {
  void ctx.sys
  const out: ZVdev[] = []
  let cur: ZVdev | undefined
  for (const a of args) {
    const kind = { mirror: 'mirror', raidz: 'raidz1', raidz1: 'raidz1', raidz2: 'raidz2', raidz3: 'raidz3' }[a] as ZVdev['type'] | undefined
    if (kind) {
      cur = { type: kind, members: [] }
      out.push(cur)
      continue
    }
    if (['spare', 'log', 'cache', 'special', 'dedup'].includes(a)) return `[simulador] Los vdevs "${a}" son para más adelante; el simulador arma pools con mirror, raidz y discos sueltos.`
    const disk = diskOf(ctx.sys, a)
    if (!disk) return `cannot open '${a}': no such device in /dev\nmust be a full path or shorthand device name`
    const m: ZMember = { dev: disk.name, state: 'ONLINE', read: 0, write: 0, cksum: 0 }
    if (cur) cur.members.push(m)
    else out.push({ type: 'disk', members: [m] })
  }
  for (const v of out) {
    const min = v.type === 'mirror' ? 2 : v.type === 'disk' ? 1 : parity(v) + 1
    if (v.members.length < min) return `invalid vdev specification: ${v.type === 'raidz1' ? 'raidz' : v.type} requires at least ${min} devices`
  }
  return out
}

function inUse(sys: System, dev: string): string | undefined {
  const d = diskOf(sys, dev)!
  for (const p of pools(sys).values()) if (p.vdevs.some((v) => v.members.some((m) => m.dev === d.name || m.replacing?.dev === d.name))) return `/dev/${d.name} is part of active pool '${p.name}'`
  const paths = [`/dev/${d.name}`, ...d.parts.map((x) => sys.storage.partPath(d.name, x.num))]
  for (const path of paths) {
    const h = sys.storage.holder(path)
    if (h) return `/dev/${d.name} is in use and contains a ${sys.storage.sigs.get(path)?.type ?? 'unknown'} filesystem (${h}).`
  }
  return undefined
}

function hasData(sys: System, dev: string): string | undefined {
  const d = diskOf(sys, dev)!
  for (const path of [`/dev/${d.name}`, ...d.parts.map((x) => sys.storage.partPath(d.name, x.num))]) {
    const s = sys.storage.sigs.get(path)
    if (s) return `/dev/${d.name} contains a filesystem of type '${s.type}'`
  }
  if (d.parts.length) return `/dev/${d.name} contains a partition table`
  return undefined
}

function needRoot(ctx: CommandContext) {
  if (ctx.sh.user === 'root') return true
  ctx.err(`This command requires root privileges (try sudo ${ctx.name} ...).\n`)
  return false
}

function getPool(ctx: CommandContext, name: string | undefined): ZPool | undefined {
  const p = name ? pools(ctx.sys).get(name) : undefined
  if (!p || p.exported) {
    ctx.err(`cannot open '${name ?? ''}': no such pool\n`)
    return undefined
  }
  return p
}

function fmtHms(ms: number) {
  const s = Math.round(ms / 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`
}

function dateLong(t: number) {
  return new Date(t).toString().replace(/ GMT.*$/, '').replace(/^(\w+) (\w+) (\d+) (\d+) (.*)$/, (_a, d, m, dd, y, hms) => `${d} ${m} ${String(Number(dd)).padStart(2, ' ')} ${hms} ${y}`)
}

function statusText(_sys: System, p: ZPool, verbose: boolean): string {
  const h = poolHealth(p)
  let out = `  pool: ${p.name}\n state: ${h}\n`
  const faulted = p.vdevs.some((v) => v.members.some((m) => m.state === 'FAULTED'))
  const resilvering = p.scan?.kind === 'resilver' && !p.scan.finished
  if (h === 'DEGRADED' && !resilvering) {
    out += faulted
      ? `status: One or more devices are faulted in response to persistent errors.\n\tSufficient replicas exist for the pool to continue functioning in a\n\tdegraded state.\naction: Replace the faulted device, or use 'zpool clear' to mark the device\n\trepaired.\n`
      : `status: One or more devices has been taken offline by the administrator,\n\tor could not be opened.\n\tSufficient replicas exist for the pool to continue functioning in a\n\tdegraded state.\naction: Online the device using 'zpool online' or replace the device with\n\t'zpool replace'.\n`
  } else if (resilvering) {
    out += `status: One or more devices is currently being resilvered.  The pool will\n\tcontinue to function, possibly in a degraded state.\naction: Wait for the resilver to complete.\n`
  } else if (h === 'UNAVAIL') {
    out += `status: One or more devices could not be used because the label is missing\n\tor invalid.  There are insufficient replicas for the pool to continue\n\tfunctioning.\naction: Destroy and re-create the pool from\n\ta backup source.\n`
  } else if (p.dataErrors.length) {
    out += `status: One or more devices has experienced an error resulting in data\n\tcorruption.  Applications may be affected.\naction: Restore the file in question if possible.  Otherwise restore the\n\tentire pool from backup.\n`
  }
  const sc = p.scan
  if (sc) {
    if (sc.finished) out += sc.kind === 'scrub' ? `  scan: scrub repaired ${human(sc.repaired)} in ${fmtHms(sc.finished - sc.start)} with ${sc.errors} errors on ${dateLong(sc.finished)}\n` : `  scan: resilvered ${human(sc.total)} in ${fmtHms(sc.finished - sc.start)} with ${sc.errors} errors on ${dateLong(sc.finished)}\n`
    else {
      const pct = ((sc.done / sc.total) * 100).toFixed(2)
      const left = fmtHms(((sc.total - sc.done) / SPEED) * 1000)
      out += `  scan: ${sc.kind} in progress since ${dateLong(sc.start)}\n\t${human(sc.done)} / ${human(sc.total)} scanned at ${human(SPEED)}/s, ${human(sc.done)} / ${human(sc.total)} issued at ${human(SPEED)}/s\n\t${sc.kind === 'resilver' ? `${human(sc.done / (p.vdevs[0]?.members.length ?? 1))} resilvered` : `${human(sc.repaired)} repaired`}, ${pct}% done, ${left} to go\n`
    }
  }
  const rowsT: [string, string, number, number, number, string][] = [[p.name, h, 0, 0, 0, '']]
  p.vdevs.forEach((v, i) => {
    const ind = v.type === 'disk' ? '  ' : '    '
    if (v.type !== 'disk') rowsT.push([`  ${v.type}-${i}`, vdevState(v), 0, 0, 0, ''])
    v.members.forEach((m, j) => {
      const note = m.state === 'FAULTED' ? 'too many errors' : m.state === 'UNAVAIL' ? 'cannot open' : ''
      if (m.replacing) {
        rowsT.push([`${ind}replacing-${j}`, 'DEGRADED', 0, 0, 0, ''])
        rowsT.push([`${ind}  ${m.dev}`, m.state, m.read, m.write, m.cksum, note])
        rowsT.push([`${ind}  ${m.replacing.dev}`, 'ONLINE', 0, 0, 0, resilvering ? '(resilvering)' : ''])
      } else rowsT.push([`${ind}${m.dev}`, m.state, m.read, m.write, m.cksum, note])
    })
  })
  const w = Math.max(10, ...rowsT.map((r) => r[0].length))
  const row = (name: string, st: string, r: number, wr: number, ck: number, note = '') => `\t${name.padEnd(w)}  ${st.padEnd(8)} ${String(r).padStart(4)} ${String(wr).padStart(5)} ${String(ck).padStart(5)}${note ? '  ' + note : ''}\n`
  out += `config:\n\n\t${'NAME'.padEnd(w)}  STATE     READ WRITE CKSUM\n`
  for (const r of rowsT) out += row(...r)
  out += '\n'
  if (p.dataErrors.length) {
    out += `errors: Permanent errors have been detected in the following files:\n\n${verbose ? p.dataErrors.map((f) => `        ${f}\n`).join('') : ''}`
    if (!verbose) out += `        (use 'zpool status -v' to see the list of files)\n`
  } else out += 'errors: No known data errors\n'
  return out
}

register('zpool', {
  usage: 'zpool create|status|list|scrub|replace|offline|online|clear|destroy|history|export|import ...',
  summary: '  create [-f] [-o ashift=12] POOL [mirror|raidz|raidz2] DISCOS...\n  status [-v] [POOL]     estado, errores y scrub o resilver\n  list                   tamaño, uso y salud\n  scrub POOL             revisa todos los datos\n  replace POOL VIEJO NUEVO   cambia un disco (resilver)\n  offline|online POOL DISCO    clear POOL [DISCO]',
  path: '/usr/sbin',
  run(ctx) {
    const sys = ctx.sys
    if (sys.distro === 'rocky' && !sys.installed.has('zfs')) {
      ctx.err('bash: zpool: command not found\n')
      return 127
    }
    const [verb, ...rest] = ctx.args
    const flags = new Set(rest.filter((a) => /^-[a-zA-Z]+$/.test(a)).flatMap((a) => a.slice(1).split('')))
    const opts = new Map<string, string>()
    const pos: string[] = []
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '-o' || rest[i] === '-O' || rest[i] === '-m') {
        const kv = rest[++i] ?? ''
        if (rest[i - 1] === '-m') opts.set('mountpoint', kv)
        else opts.set(kv.split('=')[0], kv.split('=').slice(1).join('='))
      } else if (!/^-[a-zA-Z]+$/.test(rest[i])) pos.push(rest[i])
    }
    const all = pools(sys)
    switch (verb) {
      case 'create': {
        if (!needRoot(ctx)) return 1
        const [name, ...devs] = pos
        if (!name || !devs.length) {
          ctx.err('missing pool name\nusage:\n\tcreate [-fnd] [-o property=value] ... \n\t    [-O file-system-property=value] ... \n\t    [-m mountpoint] [-R root] <pool> <vdev> ...\n')
          return 2
        }
        if (all.has(name) && !all.get(name)!.exported) {
          ctx.err(`cannot create '${name}': pool already exists\n`)
          return 1
        }
        const vdevs = parseVdevs(ctx, devs)
        if (typeof vdevs === 'string') {
          ctx.err(vdevs + '\n')
          return 1
        }
        const members = vdevs.flatMap((v) => v.members.map((m) => m.dev))
        for (const m of members) {
          const u = inUse(sys, m)
          if (u) {
            ctx.err(`invalid vdev specification\nuse '-f' to override the following errors:\n${u}\n`)
            return 1
          }
        }
        if (!flags.has('f')) {
          const problems = members.map((m) => hasData(sys, m)).filter(Boolean)
          if (problems.length) {
            ctx.err(`invalid vdev specification\nuse '-f' to override the following errors:\n${problems.join('\n')}\n`)
            return 1
          }
          const sizes = vdevs.map((v) => new Set(v.members.map((m) => memberSize(sys, m))))
          if (sizes.some((s) => s.size > 1)) {
            ctx.err(`invalid vdev specification\nuse '-f' to override the following errors:\nmirror contains devices of different sizes\n`)
            return 1
          }
          if (new Set(vdevs.map((v) => v.type)).size > 1) {
            ctx.err(`invalid vdev specification\nuse '-f' to override the following errors:\nmismatched replication level: both ${vdevs[0].type} and ${vdevs.find((v) => v.type !== vdevs[0].type)!.type} vdevs are present\n`)
            return 1
          }
        }
        const p = newPool(name, vdevs, Number(opts.get('ashift') ?? 12))
        for (const [k, v] of opts) if (k !== 'ashift' && k !== 'mountpoint') p.datasets.get(name)!.props.set(k, v)
        if (opts.get('mountpoint')) p.datasets.get(name)!.props.set('mountpoint', opts.get('mountpoint')!)
        all.set(name, p)
        for (const m of members) partitionAsZfs(sys, m)
        const mp = mountpoint(p, p.datasets.get(name)!)
        if (mp) sys.vfs.mkdirp(mp, ROOT_CRED)
        p.history.push(`${fmtTime(Date.now()).replace(' ', '.')} zpool ${ctx.args.join(' ')}`)
        return 0
      }
      case 'status': {
        const list = pos.length ? pos.map((n) => getPool(ctx, n)).filter((x): x is ZPool => !!x) : [...all.values()].filter((p) => !p.exported)
        if (!list.length && !pos.length) {
          ctx.out('no pools available\n')
          return 0
        }
        if (flags.has('x')) {
          const bad = list.filter((p) => poolHealth(p) !== 'ONLINE' || p.dataErrors.length)
          if (!bad.length) {
            ctx.out('all pools are healthy\n')
            return 0
          }
          ctx.out(bad.map((p) => statusText(sys, p, flags.has('v'))).join('\n'))
          return 0
        }
        ctx.out(list.map((p) => statusText(sys, p, flags.has('v'))).join('\n'))
        return list.length === pos.length || !pos.length ? 0 : 1
      }
      case 'list': {
        const list = (pos.length ? pos.map((n) => getPool(ctx, n)) : [...all.values()].filter((p) => !p.exported)).filter((x): x is ZPool => !!x)
        if (!list.length) {
          ctx.out('no pools available\n')
          return 0
        }
        const rows = list.map((p) => {
          const size = poolRaw(sys, p) * 0.97
          const alloc = poolAlloc(sys, p)
          return [p.name, human(size), human(alloc), human(size - alloc), '-', '-', `${Math.min(60, Math.round((alloc / size) * 20))}%`, `${Math.round((alloc / size) * 100)}%`, '1.00x', poolHealth(p), '-']
        })
        const head = ['NAME', 'SIZE', 'ALLOC', 'FREE', 'CKPOINT', 'EXPANDSZ', 'FRAG', 'CAP', 'DEDUP', 'HEALTH', 'ALTROOT']
        const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)))
        const line = (r: string[]) => r.map((c, i) => (i === 0 || i >= 9 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ').trimEnd() + '\n'
        ctx.out(line(head) + rows.map(line).join(''))
        return 0
      }
      case 'scrub': {
        if (!needRoot(ctx)) return 1
        const p = getPool(ctx, pos[0])
        if (!p) return 1
        if (flags.has('s')) {
          if (!p.scan || p.scan.finished || p.scan.kind !== 'scrub') {
            ctx.err(`cannot cancel scrubbing ${p.name}: there is no active scrub\n`)
            return 1
          }
          p.scan = undefined
          return 0
        }
        if (p.scan && !p.scan.finished) {
          ctx.err(`cannot scrub ${p.name}: currently ${p.scan.kind === 'scrub' ? 'scrubbing' : 'resilvering'}; use 'zpool scrub -s' to cancel current scrub\n`)
          return 1
        }
        p.scan = { kind: 'scrub', start: Date.now(), total: Math.max(1, poolAlloc(sys, p)), done: 0, repaired: 0, errors: p.dataErrors.length }
        p.history.push(`${fmtTime(Date.now()).replace(' ', '.')} zpool scrub ${p.name}`)
        return 0
      }
      case 'replace': {
        if (!needRoot(ctx)) return 1
        const [name, oldDev, newDev] = pos
        const p = getPool(ctx, name)
        if (!p) return 1
        const v = p.vdevs.find((x) => x.members.some((m) => m.dev === devName(oldDev ?? '')))
        const idx = v?.members.findIndex((m) => m.dev === devName(oldDev ?? '')) ?? -1
        if (!v || idx < 0) {
          ctx.err(`cannot replace ${oldDev ?? ''} with ${newDev ?? ''}: no such device in pool\n`)
          return 1
        }
        const target = newDev ?? oldDev!
        const disk = diskOf(sys, target)
        if (!disk) {
          ctx.err(`cannot open '${target}': no such device in /dev\nmust be a full path or shorthand device name\n`)
          return 1
        }
        if (target === oldDev) {
          ctx.err(`cannot replace ${oldDev} with ${oldDev}: ${oldDev} is busy, or device removal is in progress\n[simulador] Si cambiaste el disco físico en la misma bahía, el nuevo aparece con otro nombre: usá ese nombre como tercer argumento.\n`)
          return 1
        }
        const u = inUse(sys, target)
        if (u) {
          ctx.err(`invalid vdev specification\nuse '-f' to override the following errors:\n${u}\n`)
          return 1
        }
        if (disk.size < memberSize(sys, v.members[idx])) {
          ctx.err(`cannot replace ${oldDev} with ${target}: device is too small\n`)
          return 1
        }
        if (v.type === 'disk' && v.members[0].state !== 'ONLINE') {
          ctx.err(`cannot replace ${oldDev} with ${target}: no valid replicas\n`)
          return 1
        }
        v.members[idx].replacing = { dev: disk.name, state: 'ONLINE', read: 0, write: 0, cksum: 0 }
        partitionAsZfs(sys, disk.name)
        const perDisk = poolAlloc(sys, p) / Math.max(1, v.type === 'mirror' ? 1 : v.members.length - parity(v))
        p.scan = { kind: 'resilver', start: Date.now(), total: Math.max(GiB, perDisk), done: 0, repaired: 0, errors: 0 }
        p.history.push(`${fmtTime(Date.now()).replace(' ', '.')} zpool replace ${p.name} ${oldDev} ${target}`)
        return 0
      }
      case 'offline':
      case 'online': {
        if (!needRoot(ctx)) return 1
        const p = getPool(ctx, pos[0])
        if (!p) return 1
        const m = p.vdevs.flatMap((v) => v.members).find((x) => x.dev === devName(pos[1] ?? ''))
        if (!m) {
          ctx.err(`cannot ${verb} ${pos[1] ?? ''}: no such device in pool\n`)
          return 1
        }
        if (verb === 'offline') {
          const v = p.vdevs.find((x) => x.members.includes(m))!
          const okNow = v.members.filter((x) => x.state === 'ONLINE' && x !== m).length
          const need = v.type === 'mirror' ? 1 : v.type === 'disk' ? 1 : v.members.length - parity(v)
          if (okNow < need) {
            ctx.err(`cannot offline ${m.dev}: no valid replicas\n`)
            return 1
          }
          m.state = 'OFFLINE'
        } else {
          if (m.bad) {
            ctx.err(`warning: device '${m.dev}' onlined, but remains in faulted state\nuse 'zpool replace' to replace devices that are no longer present\n`)
            m.state = 'FAULTED'
            return 0
          }
          m.state = 'ONLINE'
        }
        return 0
      }
      case 'clear': {
        if (!needRoot(ctx)) return 1
        const p = getPool(ctx, pos[0])
        if (!p) return 1
        for (const m of p.vdevs.flatMap((v) => v.members)) {
          if (pos[1] && m.dev !== devName(pos[1])) continue
          m.read = m.write = m.cksum = 0
          if (m.state === 'FAULTED') m.state = 'ONLINE'
          // Un disco que está fallando de verdad vuelve a acumular errores enseguida.
          if (m.bad) {
            m.state = 'FAULTED'
            m.read = 3
            m.write = 11
          }
        }
        return 0
      }
      case 'destroy': {
        if (!needRoot(ctx)) return 1
        const p = getPool(ctx, pos[0])
        if (!p) return 1
        for (const d of p.datasets.values()) {
          const mp = mountpoint(p, d)
          if (mp && sys.vfs.exists(mp, ROOT_CRED)) sys.vfs.removeTree(mp, ROOT_CRED)
        }
        for (const m of p.vdevs.flatMap((v) => v.members)) freeDisk(sys, m.dev)
        all.delete(p.name)
        return 0
      }
      case 'history': {
        const p = getPool(ctx, pos[0] ?? [...all.keys()][0])
        if (!p) return 1
        ctx.out(`History for '${p.name}':\n${p.history.join('\n')}\n\n`)
        return 0
      }
      case 'export': {
        if (!needRoot(ctx)) return 1
        const p = getPool(ctx, pos[0])
        if (!p) return 1
        p.exported = true
        return 0
      }
      case 'import': {
        if (!needRoot(ctx)) return 1
        const exp = [...all.values()].filter((p) => p.exported)
        if (!pos[0]) {
          if (!exp.length) ctx.out('no pools available to import\n')
          for (const p of exp) ctx.out(`   pool: ${p.name}\n     id: ${Math.abs(p.created) % 1e19}\n  state: ${poolHealth(p)}\n action: The pool can be imported using its name or numeric identifier.\n config:\n\n\t${p.name}  ${poolHealth(p)}\n\n`)
          return 0
        }
        const p = exp.find((x) => x.name === pos[0])
        if (!p) {
          ctx.err(`cannot import '${pos[0]}': no such pool available\n`)
          return 1
        }
        p.exported = false
        return 0
      }
      case 'get': {
        const p = getPool(ctx, pos[1] ?? [...all.keys()][0])
        if (!p) return 1
        const keys = (pos[0] ?? 'all') === 'all' ? ['size', 'capacity', 'health', 'ashift', 'autoreplace', 'autotrim'] : pos[0].split(',')
        const vals: Record<string, string> = { size: human(poolRaw(sys, p) * 0.97), capacity: `${Math.round((poolAlloc(sys, p) / (poolRaw(sys, p) * 0.97)) * 100)}%`, health: poolHealth(p), ashift: String(p.ashift), autoreplace: 'off', autotrim: 'off' }
        ctx.out(`NAME  PROPERTY     VALUE   SOURCE\n${keys.map((k) => `${p.name}  ${k.padEnd(11)}  ${(vals[k] ?? '-').padEnd(7)} ${k === 'ashift' ? 'local' : '-'}`).join('\n')}\n`)
        return 0
      }
      case 'iostat': {
        for (const p of [...all.values()].filter((x) => !x.exported)) ctx.out(`              capacity     operations     bandwidth\npool        alloc   free   read  write   read  write\n----------  -----  -----  -----  -----  -----  -----\n${p.name.padEnd(10)}  ${human(poolAlloc(sys, p)).padStart(5)}  ${human(poolRaw(sys, p) * 0.97 - poolAlloc(sys, p)).padStart(5)}     42     87  3.1M  9.8M\n----------  -----  -----  -----  -----  -----  -----\n`)
        return 0
      }
      default:
        ctx.err(`unrecognized command '${verb ?? ''}'\nusage: zpool command args ...\nwhere 'command' is one of the following:\n\n\tcreate, destroy, add, attach, detach, replace, scrub, status, list, iostat, history, get, set,\n\toffline, online, clear, import, export\n`)
        return 2
    }
  },
})

// ---------------------------------------------------------------------------------------
// zfs
// ---------------------------------------------------------------------------------------

function findDs(sys: System, name: string): { p: ZPool; d: ZDataset } | undefined {
  const poolName = name.split('/')[0].split('@')[0]
  const p = pools(sys).get(poolName)
  if (!p || p.exported) return undefined
  const d = p.datasets.get(name)
  return d ? { p, d } : undefined
}

interface Row {
  name: string
  type: 'filesystem' | 'volume' | 'snapshot'
  used: number
  avail: number | undefined
  refer: number
  mountpoint: string
  p: ZPool
  d?: ZDataset
}

function rows(sys: System, opts: { types: Set<string>; root?: string; recursive: boolean }): Row[] {
  const out: Row[] = []
  for (const p of pools(sys).values()) {
    if (p.exported) continue
    const names = [...p.datasets.keys(), ...[...p.datasets.keys()].flatMap((n) => pveZvols(sys, p, n).map((z) => z.name))].sort()
    for (const n of names) {
      if (opts.root && !(n === opts.root || (opts.recursive && n.startsWith(opts.root + '/')))) continue
      const d = p.datasets.get(n)
      if (!d) {
        const z = [...p.datasets.keys()].flatMap((x) => pveZvols(sys, p, x)).find((x) => x.name === n)!
        if (opts.types.has('volume')) out.push({ name: n, type: 'volume', used: z.used, avail: avail(sys, p, p.datasets.get(n.slice(0, n.lastIndexOf('/')))!), refer: z.used, mountpoint: '-', p })
        if (opts.types.has('snapshot')) for (const s of z.snaps) out.push({ name: `${n}@${s}`, type: 'snapshot', used: 0, avail: undefined, refer: z.used, mountpoint: '-', p })
        continue
      }
      if (opts.types.has(d.type)) out.push({ name: n, type: d.type, used: usedOf(sys, p, d), avail: avail(sys, p, d), refer: refer(sys, p, d), mountpoint: mountpoint(p, d) ?? (d.type === 'volume' ? '-' : d.props.get('mountpoint') ?? 'none'), p, d })
      if (opts.types.has('snapshot')) d.snaps.forEach((s, i) => out.push({ name: `${n}@${s.name}`, type: 'snapshot', used: snapUsed(sys, p, d, i), avail: undefined, refer: s.base + filesBytes(s.files), mountpoint: '-', p, d }))
    }
  }
  return out
}

function table(head: string[], data: string[][], right: number[]): string {
  const w = head.map((h, i) => Math.max(h.length, ...data.map((r) => r[i].length)))
  const line = (r: string[]) => r.map((c, i) => (right.includes(i) ? c.padStart(w[i]) : c.padEnd(w[i]))).join('  ').trimEnd() + '\n'
  return line(head) + data.map(line).join('')
}

function propValue(sys: System, r: Row, k: string): { value: string; source: string } {
  switch (k) {
    case 'name':
      return { value: r.name, source: '-' }
    case 'type':
      return { value: r.type, source: '-' }
    case 'used':
      return { value: human(r.used), source: '-' }
    case 'avail':
    case 'available':
      return { value: r.avail === undefined ? '-' : human(r.avail), source: '-' }
    case 'refer':
    case 'referenced':
      return { value: human(r.refer), source: '-' }
    case 'mountpoint':
      return r.d && r.d.props.has('mountpoint') ? { value: r.d.props.get('mountpoint')!, source: 'local' } : { value: r.mountpoint, source: r.type === 'filesystem' ? 'default' : '-' }
    case 'compressratio':
      return { value: r.d && prop(r.p, r.d, 'compression').value !== 'off' ? '1.42x' : '1.00x', source: '-' }
    case 'creation':
      return { value: dateLong(r.d?.created ?? Date.now()).replace(/^\w+ /, ''), source: '-' }
    case 'volsize':
      return { value: r.d?.volsize ? human(r.d.volsize) : '-', source: r.d?.volsize ? 'local' : '-' }
    case 'origin':
      return { value: r.d?.origin ?? '-', source: '-' }
    case 'usedbysnapshots':
      return { value: human(r.d ? r.d.snaps.reduce((s, _x, i) => s + snapUsed(sys, r.p, r.d!, i), 0) : 0), source: '-' }
    default:
      return r.d && r.type !== 'snapshot' ? prop(r.p, r.d, k) : { value: '-', source: '-' }
  }
}

function streamOf(_sys: System, _p: ZPool, d: ZDataset, snapName: string, from?: string): string {
  const i = d.snaps.findIndex((s) => s.name === snapName)
  const list = from ? d.snaps.slice(d.snaps.findIndex((s) => s.name === from) + 1, i + 1) : d.snaps.slice(0, i + 1)
  return `ZFSSTREAM:${JSON.stringify({ ds: d.name, type: d.type, volsize: d.volsize, props: [...d.props].filter(([k]) => k !== 'mountpoint'), from: from ?? null, snaps: list.map((s) => ({ name: s.name, created: s.created, base: s.base, files: s.files })) })}\n`
}

register('zfs', {
  usage: 'zfs create|destroy|list|get|set|snapshot|rollback|clone|send|receive ...',
  summary: '  create [-o prop=valor] [-V TAMAÑO] POOL/NOMBRE\n  list [-t snapshot|all] [-r] [-o props]\n  get PROP[,PROP] [NOMBRE]     set PROP=VALOR NOMBRE\n  snapshot [-r] NOMBRE@INSTANTÁNEA     rollback [-r] NOMBRE@INSTANTÁNEA\n  send [-i ANTERIOR] NOMBRE@INSTANTÁNEA | [ssh SERVIDOR] zfs receive [-F] NOMBRE',
  path: '/usr/sbin',
  run(ctx) {
    const sys = ctx.sys
    if (sys.distro === 'rocky' && !sys.installed.has('zfs')) {
      ctx.err('bash: zfs: command not found\n')
      return 127
    }
    const [verb, ...rest] = ctx.args
    const flags = new Set<string>()
    const opts = new Map<string, string>()
    const pos: string[] = []
    let typeOpt: string | undefined
    let colsOpt: string | undefined
    let fromSnap: string | undefined
    let vsize: string | undefined
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]
      if (a === '-o') {
        const kv = rest[++i] ?? ''
        if (verb === 'list' || verb === 'get') colsOpt = kv
        else opts.set(kv.split('=')[0], kv.split('=').slice(1).join('='))
      } else if (a === '-t') typeOpt = rest[++i]
      else if (a === '-i' || a === '-I') fromSnap = rest[++i]
      else if (a === '-V') vsize = rest[++i]
      else if (/^-[a-zA-Z]+$/.test(a)) a.slice(1).split('').forEach((f) => flags.add(f))
      else pos.push(a)
    }
    const writeOp = ['create', 'destroy', 'set', 'snapshot', 'rollback', 'clone', 'receive', 'recv', 'inherit', 'rename']
    if (writeOp.includes(verb ?? '') && !needRoot(ctx)) return 1
    switch (verb) {
      case 'list': {
        const types = new Set((typeOpt ?? 'filesystem,volume').split(',').flatMap((t) => (t === 'all' ? ['filesystem', 'volume', 'snapshot'] : t === 'snap' ? ['snapshot'] : [t])))
        if (pos[0] && !findDs(sys, pos[0]) && !pos[0].includes('@')) {
          ctx.err(`cannot open '${pos[0]}': dataset does not exist\n`)
          return 1
        }
        const list = rows(sys, { types, root: pos[0], recursive: flags.has('r') || !pos[0] })
        if (!list.length) {
          ctx.out(pos[0] ? '' : 'no datasets available\n')
          return 0
        }
        const cols = (colsOpt ?? 'name,used,avail,refer,mountpoint').split(',')
        const head = cols.map((c) => ({ avail: 'AVAIL', available: 'AVAIL', refer: 'REFER', referenced: 'REFER' })[c] ?? c.toUpperCase())
        const data = list.map((r) => cols.map((c) => propValue(sys, r, c).value))
        if (flags.has('H')) ctx.out(data.map((r) => r.join('\t')).join('\n') + '\n')
        else ctx.out(table(head, data, cols.map((c, i) => (['used', 'avail', 'available', 'refer', 'referenced'].includes(c) ? i : -1)).filter((i) => i >= 0)))
        return 0
      }
      case 'get': {
        const keys = (pos[0] ?? 'all').split(',')
        const targets = pos.slice(1)
        const list = targets.length
          ? targets.flatMap((t) => {
              const types = new Set(t.includes('@') || typeOpt === 'all' || typeOpt === 'snapshot' ? ['filesystem', 'volume', 'snapshot'] : ['filesystem', 'volume'])
              const r = rows(sys, { types, root: t.split('@')[0], recursive: flags.has('r') }).filter((x) => (t.includes('@') ? x.name === t : true))
              if (!r.length) ctx.err(`cannot open '${t}': dataset does not exist\n`)
              return r
            })
          : rows(sys, { types: new Set(['filesystem', 'volume']), recursive: true })
        const allKeys = ['type', 'creation', 'used', 'available', 'referenced', 'compressratio', 'mountpoint', 'quota', 'reservation', 'recordsize', 'compression', 'atime', 'sync', 'copies', 'readonly', 'snapdir']
        const data: string[][] = []
        for (const r of list) for (const k of keys[0] === 'all' ? allKeys : keys) {
          const v = propValue(sys, r, k)
          data.push([r.name, k, v.value, v.source])
        }
        const cols = (colsOpt ?? 'name,property,value,source').split(',')
        const idx = cols.map((c) => ['name', 'property', 'value', 'source'].indexOf(c)).filter((i) => i >= 0)
        const sel = data.map((r) => idx.map((i) => r[i]))
        if (flags.has('H')) ctx.out(sel.map((r) => r.join('\t')).join('\n') + (sel.length ? '\n' : ''))
        else ctx.out(table(idx.map((i) => ['NAME', 'PROPERTY', 'VALUE', 'SOURCE'][i]), sel, []))
        return list.length || !targets.length ? 0 : 1
      }
      case 'create': {
        const name = pos[0]
        if (!name) {
          ctx.err('missing filesystem argument\n')
          return 2
        }
        const parent = name.slice(0, name.lastIndexOf('/'))
        const poolName = name.split('/')[0]
        if (!pools(sys).has(poolName) || pools(sys).get(poolName)!.exported) {
          ctx.err(`cannot create '${name}': no such pool '${poolName}'\n`)
          return 1
        }
        const p = pools(sys).get(poolName)!
        if (p.datasets.has(name)) {
          ctx.err(`cannot create '${name}': dataset already exists\n`)
          return 1
        }
        if (!p.datasets.has(parent)) {
          if (!flags.has('p')) {
            ctx.err(`cannot create '${name}': parent does not exist\n`)
            return 1
          }
          const parts = name.split('/')
          for (let i = 2; i < parts.length; i++) {
            const n = parts.slice(0, i).join('/')
            if (!p.datasets.has(n)) p.datasets.set(n, { name: n, type: 'filesystem', props: new Map(), base: 96 * 1024, snaps: [], created: Date.now() })
          }
        }
        if (poolHealth(p) === 'UNAVAIL') {
          ctx.err(`cannot create '${name}': pool I/O is currently suspended\n`)
          return 1
        }
        const size = vsize ? parseZSize(vsize) : undefined
        if (vsize && !size) {
          ctx.err(`bad volume size '${vsize}'\n`)
          return 1
        }
        const d: ZDataset = { name, type: size ? 'volume' : 'filesystem', props: new Map(opts), base: size ? 56 * 1024 : 96 * 1024, volsize: size, snaps: [], created: Date.now() }
        if (size && !flags.has('s') && size > avail(sys, p, p.datasets.get(parent)!)) {
          ctx.err(`cannot create '${name}': out of space\n`)
          return 1
        }
        if (size && flags.has('s')) d.props.set('refreservation', 'none')
        p.datasets.set(name, d)
        const mp = mountpoint(p, d)
        if (mp) sys.vfs.mkdirp(mp, ROOT_CRED)
        p.history.push(`${fmtTime(Date.now()).replace(' ', '.')} zfs ${ctx.args.join(' ')}`)
        return 0
      }
      case 'set': {
        const kv = pos[0]
        const targets = pos.slice(1)
        if (!kv?.includes('=') || !targets.length) {
          ctx.err(`missing ${!kv?.includes('=') ? 'property=value' : 'dataset name'} argument\n`)
          return 2
        }
        const [k, ...vv] = kv.split('=')
        const v = vv.join('=')
        const valid: Record<string, RegExp> = {
          compression: /^(on|off|lz4|zstd(-\d+)?|gzip(-\d)?|lzjb|zle)$/,
          atime: /^(on|off)$/,
          relatime: /^(on|off)$/,
          quota: /^(none|\d+(\.\d+)?[KMGTP]?)$/i,
          refquota: /^(none|\d+(\.\d+)?[KMGTP]?)$/i,
          reservation: /^(none|\d+(\.\d+)?[KMGTP]?)$/i,
          recordsize: /^(512|1K|2K|4K|8K|16K|32K|64K|128K|256K|512K|1M)$/i,
          sync: /^(standard|always|disabled)$/,
          copies: /^[123]$/,
          readonly: /^(on|off)$/,
          mountpoint: /^(\/.*|none|legacy)$/,
          snapdir: /^(hidden|visible)$/,
          dedup: /^(on|off|verify)$/,
          xattr: /^(on|off|sa|dir)$/,
          acltype: /^(off|posix|nfsv4|posixacl)$/,
          volsize: /^\d+(\.\d+)?[KMGTP]?$/i,
        }
        if (!valid[k] && !k.includes(':')) {
          ctx.err(`cannot set property for '${targets[0]}': invalid property '${k}'\n`)
          return 1
        }
        if (valid[k] && !valid[k].test(v)) {
          ctx.err(`cannot set property for '${targets[0]}': '${k}' must be one of ${String(valid[k]).slice(2, 40)}...\n`)
          return 1
        }
        for (const t of targets) {
          const f = findDs(sys, t)
          if (!f) {
            ctx.err(`cannot open '${t}': dataset does not exist\n`)
            return 1
          }
          if (k === 'quota' && v !== 'none' && parseZSize(v)! < usedOf(sys, f.p, f.d)) {
            ctx.err(`cannot set property for '${t}': size is less than current used or reserved space\n`)
            return 1
          }
          const oldMp = mountpoint(f.p, f.d)
          if (k === 'volsize') f.d.volsize = parseZSize(v)
          else f.d.props.set(k, v)
          if (k === 'mountpoint') {
            const nm = mountpoint(f.p, f.d)
            if (oldMp && nm && oldMp !== nm) {
              const files = capture(sys, oldMp)
              sys.vfs.removeTree(oldMp, ROOT_CRED)
              restore(sys, nm, files)
            }
          }
        }
        return 0
      }
      case 'inherit': {
        const f = findDs(sys, pos[1] ?? '')
        if (!f) {
          ctx.err(`cannot open '${pos[1] ?? ''}': dataset does not exist\n`)
          return 1
        }
        f.d.props.delete(pos[0])
        return 0
      }
      case 'snapshot':
      case 'snap': {
        if (!pos.length) {
          ctx.err('missing snapshot argument\n')
          return 2
        }
        for (const s of pos) {
          const [dsName, snap] = s.split('@')
          const f = findDs(sys, dsName)
          if (!f || !snap) {
            ctx.err(`cannot open '${dsName}': dataset does not exist\nusage:\n\tsnapshot [-r] [-o property=value] ... <filesystem|volume>@<snap> ...\n`)
            return 1
          }
          const targets = flags.has('r') ? [...f.p.datasets.values()].filter((d) => d.name === dsName || d.name.startsWith(dsName + '/')) : [f.d]
          for (const d of targets) {
            if (d.snaps.some((x) => x.name === snap)) {
              ctx.err(`cannot create snapshot '${d.name}@${snap}': dataset already exists\n`)
              return 1
            }
            const mp = mountpoint(f.p, d)
            d.snaps.push({ name: snap, created: Date.now(), base: d.base, files: mp ? capture(sys, mp) : [] })
          }
          f.p.history.push(`${fmtTime(Date.now()).replace(' ', '.')} zfs snapshot ${flags.has('r') ? '-r ' : ''}${s}`)
        }
        return 0
      }
      case 'rollback': {
        const s = pos[0] ?? ''
        const [dsName, snap] = s.split('@')
        const f = findDs(sys, dsName)
        const i = f?.d.snaps.findIndex((x) => x.name === snap) ?? -1
        if (!f || i < 0) {
          ctx.err(`cannot open '${s}': dataset does not exist\n`)
          return 1
        }
        const newer = f.d.snaps.slice(i + 1)
        if (newer.length && !flags.has('r')) {
          ctx.err(`cannot rollback to '${s}': more recent snapshots or bookmarks exist\nuse '-r' to force deletion of the following snapshots and bookmarks:\n${newer.map((x) => `${dsName}@${x.name}`).join('\n')}\n`)
          return 1
        }
        f.d.snaps = f.d.snaps.slice(0, i + 1)
        const target = f.d.snaps[i]
        f.d.base = target.base
        const mp = mountpoint(f.p, f.d)
        if (mp) restore(sys, mp, target.files)
        f.p.history.push(`${fmtTime(Date.now()).replace(' ', '.')} zfs rollback ${flags.has('r') ? '-r ' : ''}${s}`)
        return 0
      }
      case 'destroy': {
        const name = pos[0] ?? ''
        if (name.includes('@')) {
          const [dsName, snapSpec] = name.split('@')
          const f = findDs(sys, dsName)
          if (!f) {
            ctx.err(`could not find any snapshots to destroy; check snapshot names.\n`)
            return 1
          }
          const names = snapSpec.includes('%') ? (() => {
            const [a, b] = snapSpec.split('%')
            const ia = f.d.snaps.findIndex((x) => x.name === a)
            const ib = f.d.snaps.findIndex((x) => x.name === b)
            return f.d.snaps.slice(ia, ib + 1).map((x) => x.name)
          })() : snapSpec.split(',')
          const clones = [...f.p.datasets.values()].filter((d) => names.some((n) => d.origin === `${dsName}@${n}`))
          if (clones.length) {
            ctx.err(`cannot destroy snapshot ${dsName}@${names[0]}: snapshot has dependent clones\nuse '-R' to destroy the following datasets:\n${clones.map((c) => c.name).join('\n')}\n`)
            return 1
          }
          const before = f.d.snaps.length
          f.d.snaps = f.d.snaps.filter((x) => !names.includes(x.name))
          if (f.d.snaps.length === before) {
            ctx.err(`could not find any snapshots to destroy; check snapshot names.\n`)
            return 1
          }
          return 0
        }
        const f = findDs(sys, name)
        if (!f) {
          ctx.err(`cannot open '${name}': dataset does not exist\n`)
          return 1
        }
        if (f.d.name === f.p.name) {
          ctx.err(`cannot destroy '${name}': operation does not apply to pools\nuse 'zfs destroy -r ${name}' to destroy all datasets in the pool\nuse 'zpool destroy ${name}' to destroy the pool itself\n`)
          return 1
        }
        const children = [...f.p.datasets.values()].filter((d) => d.name.startsWith(name + '/'))
        if ((children.length || f.d.snaps.length) && !flags.has('r') && !flags.has('R')) {
          ctx.err(`cannot destroy '${name}': filesystem has children\nuse '-r' to destroy the following datasets:\n${[...children.map((c) => c.name), ...f.d.snaps.map((s) => `${name}@${s.name}`)].join('\n')}\n`)
          return 1
        }
        for (const d of [f.d, ...children]) {
          const mp = mountpoint(f.p, d)
          if (mp && sys.vfs.exists(mp, ROOT_CRED)) sys.vfs.removeTree(mp, ROOT_CRED)
          f.p.datasets.delete(d.name)
        }
        return 0
      }
      case 'clone': {
        const [src, dst] = pos
        const [dsName, snap] = (src ?? '').split('@')
        const f = findDs(sys, dsName)
        const s = f?.d.snaps.find((x) => x.name === snap)
        if (!f || !s || !dst) {
          ctx.err(`cannot open '${src ?? ''}': dataset does not exist\n`)
          return 1
        }
        const d: ZDataset = { name: dst, type: f.d.type, props: new Map(opts), base: s.base, volsize: f.d.volsize, snaps: [], created: Date.now(), origin: src }
        f.p.datasets.set(dst, d)
        const mp = mountpoint(f.p, d)
        if (mp) restore(sys, mp, s.files)
        return 0
      }
      case 'rename': {
        const f = findDs(sys, pos[0] ?? '')
        if (!f || !pos[1]) {
          ctx.err(`cannot open '${pos[0] ?? ''}': dataset does not exist\n`)
          return 1
        }
        const oldMp = mountpoint(f.p, f.d)
        f.p.datasets.delete(f.d.name)
        f.d.name = pos[1]
        f.p.datasets.set(pos[1], f.d)
        const nm = mountpoint(f.p, f.d)
        if (oldMp && nm) {
          const files = capture(sys, oldMp)
          sys.vfs.removeTree(oldMp, ROOT_CRED)
          restore(sys, nm, files)
        }
        return 0
      }
      case 'send': {
        const s = pos[0] ?? ''
        const [dsName, snap] = s.split('@')
        const f = findDs(sys, dsName)
        if (!f || !snap || !f.d.snaps.some((x) => x.name === snap)) {
          ctx.err(`cannot open '${s}': dataset does not exist\nusage:\n\tsend [-DnPpRvLecwhb] [-[iI] snapshot] <snapshot>\n`)
          return 1
        }
        if (ctx.isTTY) {
          ctx.err('Error: Stream can not be written to a terminal.\nYou must redirect standard output.\n')
          return 1
        }
        const from = fromSnap?.replace(/^.*@/, '')
        if (from && !f.d.snaps.some((x) => x.name === from)) {
          ctx.err(`cannot open '${fromSnap}': dataset does not exist\n`)
          return 1
        }
        if (flags.has('v')) ctx.err(`${from ? `send from @${from} to ${s}` : `full send of ${s}`} estimated size is ${human(Math.max(4096, from ? 12 * MiB : refer(sys, f.p, f.d)))}\ntotal estimated size is ${human(Math.max(4096, from ? 12 * MiB : refer(sys, f.p, f.d)))}\n`)
        ctx.out(streamOf(sys, f.p, f.d, snap, from))
        return 0
      }
      case 'receive':
      case 'recv': {
        const target = pos[0]
        const input = ctx.stdin.readAll()
        const m = /^ZFSSTREAM:(.*)$/m.exec(input)
        if (!target) {
          ctx.err('missing snapshot argument\n')
          return 2
        }
        if (!m) {
          ctx.err('cannot receive: failed to read from stream\n')
          return 1
        }
        const st = JSON.parse(m[1]) as { ds: string; type: 'filesystem' | 'volume'; volsize?: number; props: [string, string][]; from: string | null; snaps: ZSnap[] }
        const poolName = target.split('/')[0]
        const p = pools(sys).get(poolName)
        if (!p || p.exported) {
          ctx.err(`cannot receive new filesystem stream: dataset does not exist\n`)
          return 1
        }
        const parent = target.slice(0, target.lastIndexOf('/'))
        let d = p.datasets.get(target)
        if (st.from) {
          if (!d) {
            ctx.err(`cannot receive incremental stream: destination '${target}' does not exist\n`)
            return 1
          }
          const last = d.snaps[d.snaps.length - 1]
          if (!last || last.name !== st.from) {
            ctx.err(`cannot receive incremental stream: most recent snapshot of ${target} does not\nmatch incremental source\n`)
            return 1
          }
          const mp = mountpoint(p, d)
          const live = mp ? capture(sys, mp) : []
          const changed = JSON.stringify(live) !== JSON.stringify(last.files)
          if (changed && !flags.has('F')) {
            ctx.err(`cannot receive incremental stream: destination ${target} has been modified\nsince most recent snapshot\n`)
            return 1
          }
        } else {
          if (d && !flags.has('F')) {
            ctx.err(`cannot receive new filesystem stream: destination '${target}' exists\nmust specify -F to overwrite it\n`)
            return 1
          }
          if (!p.datasets.has(parent) && parent) {
            ctx.err(`cannot receive new filesystem stream: dataset does not exist\n`)
            return 1
          }
          d = { name: target, type: st.type, props: new Map(st.props), base: 96 * 1024, volsize: st.volsize, snaps: [], created: Date.now() }
          p.datasets.set(target, d)
        }
        for (const s of st.snaps) d.snaps.push({ ...s })
        const lastSnap = d.snaps[d.snaps.length - 1]
        d.base = lastSnap.base
        const mp = mountpoint(p, d)
        if (mp) restore(sys, mp, lastSnap.files)
        if (flags.has('v')) ctx.out(`receiving ${st.from ? 'incremental' : 'full'} stream of ${st.ds}@${lastSnap.name} into ${target}@${lastSnap.name}\nreceived ${human(Math.max(4096, filesBytes(lastSnap.files) + (st.from ? 0 : lastSnap.base)))} stream in 1 seconds (${human(Math.max(4096, filesBytes(lastSnap.files)))}/sec)\n`)
        return 0
      }
      case 'mount':
        if (!pos.length) {
          for (const p of pools(sys).values()) for (const d of p.datasets.values()) {
            const mp = mountpoint(p, d)
            if (mp) ctx.out(`${d.name.padEnd(24)}  ${mp}\n`)
          }
        }
        return 0
      default:
        ctx.err(`unrecognized command '${verb ?? ''}'\nusage: zfs command args ...\nwhere 'command' is one of the following:\n\n\tcreate, destroy, snapshot, rollback, clone, rename, list, set, get, inherit, send, receive, mount\n`)
        return 2
    }
  },
})

// ---------------------------------------------------------------------------------------
// pvesr: réplica de los discos ZFS de una VM a otro nodo
// ---------------------------------------------------------------------------------------

interface ReplJob {
  id: string
  vmid: number
  target: string
  schedule: string
  /** Minutos entre corridas. */
  every: number
  last?: number
  /** Segundos de tiempo simulado desde la última corrida. */
  since: number
  fail: number
  error?: string
  disabled?: boolean
}

const REPL = new WeakMap<Pve, ReplJob[]>()

function everyOf(schedule: string): number | undefined {
  const m = /^\*\/(\d+)$/.exec(schedule)
  if (m) return Number(m[1])
  if (/^\d{1,2}:\d{2}$/.test(schedule)) return 24 * 60
  if (schedule === 'hourly') return 60
  if (schedule === 'daily') return 24 * 60
  return undefined
}

function zfsVolumes(pve: Pve, g: PveGuest) {
  const vols: { volid: string; storage: string }[] = []
  for (const [k, v] of g.conf) {
    if (!/^(scsi|virtio|sata|ide)\d+$|^efidisk0$|^tpmstate0$|^rootfs$|^mp\d+$/.test(k) || v.includes('media=cdrom')) continue
    const volid = v.split(',')[0]
    if (!volid.includes(':') || /cloudinit$/.test(volid)) continue
    vols.push({ volid, storage: volid.split(':')[0] })
  }
  return vols.map((x) => ({ ...x, type: pve.storages.get(x.storage)?.type }))
}

function runJob(_sys: System, pve: Pve, j: ReplJob): string | undefined {
  const c = pve.cluster
  const n = c?.nodes.find((x) => x.name === j.target)
  const g = pve.guests.get(j.vmid)
  if (!g) return `guest ${j.vmid} is not on this node`
  if (!n || n.sys.poweredOff) return `could not reach target node '${j.target}'`
  for (const v of zfsVolumes(pve, g)) {
    const st = pve.storages.get(v.storage)!
    const pool = st.path ?? ''
    if (!datasetExists(n.sys, pool)) return `storage '${v.storage}': zfs error: cannot open '${pool}': dataset does not exist (on ${j.target})`
    const vol = pve.volumes.get(v.volid)
    if (vol) n.pve.volumes.set(v.volid, { ...vol, replica: true })
  }
  j.last = Date.now()
  j.since = 0
  j.fail = 0
  j.error = undefined
  return undefined
}

function replicationTick(sys: System, seconds: number) {
  void sys
  const pve = pveOf(sys)
  const jobs = pve && REPL.get(pve)
  if (!pve || !jobs) return
  for (const j of jobs) {
    if (j.disabled) continue
    j.since += seconds
    if (j.since >= j.every * 60) {
      const e = runJob(sys, pve, j)
      if (e) {
        j.fail++
        j.error = e
        j.since = 0
      }
    }
  }
}

/** Si un volumen tiene una réplica en otro nodo (para la migración y la alta disponibilidad). */
export function replicatedTo(target: Pve, volid: string): boolean {
  return !!target.volumes.get(volid)?.replica
}

register('pvesr', {
  usage: 'pvesr create-local-job|list|status|delete|disable|enable|schedule-now ...',
  summary: "  create-local-job ID-N NODO --schedule '*/15'   réplica de una VM a otro nodo\n  status | list       estado de las réplicas\n  schedule-now ID     corre la réplica ya",
  path: '/usr/bin',
  run(ctx) {
    const pve = pveOf(ctx.sys)
    if (!pve) {
      ctx.err('bash: pvesr: command not found\n')
      return 127
    }
    const [verb, ...rest] = ctx.args
    const opts = new Map<string, string>()
    const pos: string[] = []
    for (let i = 0; i < rest.length; i++) {
      if (rest[i].startsWith('--')) opts.set(rest[i].slice(2), rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : '1')
      else pos.push(rest[i])
    }
    const jobs = REPL.get(pve) ?? []
    REPL.set(pve, jobs)
    switch (verb) {
      case 'create-local-job': {
        const [id, target] = pos
        const m = /^(\d+)-(\d+)$/.exec(id ?? '')
        if (!m || !target) {
          ctx.err('400 Parameter verification failed.\nid: invalid format - replication job ID must be in the form <GUEST>-<JOBNUM>\n')
          return 255
        }
        const vmid = Number(m[1])
        const g = pve.guests.get(vmid)
        if (!g) {
          ctx.err(`guest '${vmid}' is not on local node\n`)
          return 255
        }
        if (!pve.cluster) {
          ctx.err('[simulador] La réplica es entre nodos de un clúster.\nno such cluster node\n')
          return 255
        }
        if (!pve.cluster.nodes.some((x) => x.name === target)) {
          ctx.err(`400 Parameter verification failed.\ntarget: no such cluster node '${target}'\n`)
          return 255
        }
        if (target === pve.node) {
          ctx.err('400 Parameter verification failed.\ntarget: can\'t sync to local node\n')
          return 255
        }
        const bad = zfsVolumes(pve, g).find((v) => v.type !== 'zfspool')
        if (bad) {
          ctx.err(`missing replicate feature on volume '${bad.volid}'\n[simulador] La réplica solo funciona con discos en un almacenamiento ZFS (zfspool).\n`)
          return 255
        }
        if (jobs.some((j) => j.id === id)) {
          ctx.err(`replication job '${id}' already exists\n`)
          return 255
        }
        const schedule = opts.get('schedule') ?? '*/15'
        const every = everyOf(schedule)
        if (!every) {
          ctx.err(`400 Parameter verification failed.\nschedule: value does not look like a valid calendar event\n`)
          return 255
        }
        const j: ReplJob = { id: id!, vmid, target, schedule, every, since: 0, fail: 0 }
        jobs.push(j)
        // La primera corrida (completa) empieza enseguida.
        const e = runJob(ctx.sys, pve, j)
        if (e) {
          j.fail = 1
          j.error = e
        }
        return 0
      }
      case 'list':
        ctx.out(`JobID      Target                 Schedule  Rate  Enabled\n${jobs.map((j) => `${j.id.padEnd(10)} local/${j.target.padEnd(16)} ${j.schedule.padEnd(9)} -     ${j.disabled ? 'no' : 'yes'}`).join('\n')}${jobs.length ? '\n' : ''}`)
        return 0
      case 'status': {
        const ts = (t?: number) => (t ? fmtTime(t).replace(' ', '_') : '-')
        ctx.out(`JobID      Enabled    Target                           LastSync             NextSync   Duration  FailCount State\n`)
        for (const j of jobs) ctx.out(`${j.id.padEnd(10)} ${(j.disabled ? 'No' : 'Yes').padEnd(10)} ${('local/' + j.target).padEnd(32)} ${ts(j.last).padEnd(20)} ${ts((j.last ?? Date.now()) + j.every * 60_000).padEnd(20)} ${'3.084573'.padStart(9)} ${String(j.fail).padStart(10)} ${j.error ? j.error : 'OK'}\n`)
        return 0
      }
      case 'schedule-now': {
        const j = jobs.find((x) => x.id === pos[0])
        if (!j) {
          ctx.err(`replication job '${pos[0] ?? ''}' does not exist\n`)
          return 255
        }
        const e = runJob(ctx.sys, pve, j)
        if (e) {
          j.fail++
          j.error = e
        }
        return 0
      }
      case 'delete': {
        const i = jobs.findIndex((x) => x.id === pos[0])
        if (i < 0) {
          ctx.err(`replication job '${pos[0] ?? ''}' does not exist\n`)
          return 255
        }
        jobs.splice(i, 1)
        return 0
      }
      case 'disable':
      case 'enable': {
        const j = jobs.find((x) => x.id === pos[0])
        if (!j) {
          ctx.err(`replication job '${pos[0] ?? ''}' does not exist\n`)
          return 255
        }
        j.disabled = verb === 'disable'
        return 0
      }
      default:
        ctx.out('USAGE: pvesr <COMMAND> [ARGS] [OPTIONS]\n\n       pvesr create-local-job <id> <target> [OPTIONS]\n       pvesr delete <id> [OPTIONS]\n       pvesr list\n       pvesr schedule-now <id>\n       pvesr status  [OPTIONS]\n')
        return verb ? 255 : 0
    }
  },
})

// ---------------------------------------------------------------------------------------
// Verificaciones
// ---------------------------------------------------------------------------------------

export function verifyZfs(sys: System, check: object): { ok: boolean; label: string } | undefined {
  if ('zpool' in check) {
    const c = check as { zpool: string; existe?: boolean; estado?: string; tipo?: string; discos?: string[]; scrub_hecho?: boolean; resilver_hecho?: boolean }
    const p = pools(sys).get(c.zpool)
    if (c.existe === false) return { ok: !p || !!p.exported, label: `no existe el pool ${c.zpool}` }
    let ok = !!p && !p.exported
    const parts: string[] = []
    if (ok && c.estado) {
      ok = poolHealth(p!) === c.estado
      parts.push(c.estado)
    }
    if (ok && c.tipo) {
      ok = p!.vdevs.every((v) => (v.type === 'disk' ? 'stripe' : v.type) === c.tipo)
      parts.push(`de tipo ${c.tipo}`)
    }
    if (ok && c.discos) {
      const have = p!.vdevs.flatMap((v) => v.members.map((m) => m.dev)).sort().join(',')
      ok = have === [...c.discos].sort().join(',')
      parts.push(`con los discos ${c.discos.join(', ')}`)
    }
    if (ok && c.scrub_hecho) {
      ok = p!.scan?.kind === 'scrub' && !!p!.scan.finished && Date.now() - p!.scan.finished < 86_400_000
      parts.push('con un scrub terminado')
    }
    if (ok && c.resilver_hecho) {
      ok = p!.scan?.kind === 'resilver' && !!p!.scan.finished
      parts.push('con el resilver terminado')
    }
    return { ok, label: `existe el pool ${c.zpool}${parts.length ? ' ' + parts.join(', ') : ''}` }
  }
  if ('dataset' in check) {
    const c = check as { dataset: string; existe?: boolean; propiedad?: Record<string, string>; instantanea?: string }
    const f = findDs(sys, c.dataset)
    if (c.existe === false) return { ok: !f, label: `no existe el dataset ${c.dataset}` }
    let ok = !!f
    const parts: string[] = []
    for (const [k, v] of Object.entries(c.propiedad ?? {})) {
      if (!ok) break
      ok = prop(f!.p, f!.d, k).value === v || (k === 'volsize' && f!.d.volsize === parseZSize(v))
      parts.push(`${k}=${v}`)
    }
    if (ok && c.instantanea) {
      ok = f!.d.snaps.some((s) => s.name === c.instantanea)
      parts.push(`con la instantánea ${c.instantanea}`)
    }
    return { ok, label: `existe el dataset ${c.dataset}${parts.length ? ' ' + parts.join(', ') : ''}` }
  }
  if ('replica_pve' in check) {
    const c = check as { replica_pve: string; destino?: string; ok?: boolean }
    const pve = pveOf(sys)
    const j = pve ? REPL.get(pve)?.find((x) => x.id === c.replica_pve) : undefined
    let ok = !!j
    if (ok && c.destino) ok = j!.target === c.destino
    if (ok && c.ok !== undefined) ok = !j!.error === c.ok && !!j!.last
    return { ok, label: `existe la réplica ${c.replica_pve}${c.destino ? ` hacia ${c.destino}` : ''}${c.ok ? ', sin errores' : ''}` }
  }
  return undefined
}

void healthy
