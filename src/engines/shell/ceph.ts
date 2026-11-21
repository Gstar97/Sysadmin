/**
 * Ceph en Proxmox (pveceph): instalar, iniciar con la red de Ceph, monitores y managers, OSD
 * sobre los discos de cada nodo (en LVM, como hace ceph-volume), pools replicados con size y
 * min_size, y su almacenamiento RBD en Proxmox.
 *
 * El estado (ceph -s, ceph health detail, ceph osd tree, ceph df) sale de lo que pasa en el
 * clúster: si se cae un nodo, sus OSD quedan "down"; a los 10 minutos (si no está el flag noout)
 * se marcan "out" y, si quedan suficientes hosts, los datos se reconstruyen en otro lado. Con
 * menos copias que min_size, los PG quedan inactivos y la entrada y salida se frena.
 */
import { register, type CommandContext } from './shell'
import { System } from './system'
import { ROOT_CRED } from './vfs'
import { GiB, MiB } from './storage'
import type { BashState } from './schema'
import { pveOf, pveHooks, type Pve } from './proxmox'
import { nodeOnline, type ClusterNode, type PveCluster } from './pvecluster'

interface Osd {
  id: number
  host: string
  dev: string
  size: number
  /** El disco se rompió. */
  failed: boolean
  /** ceph osd out manual. */
  manualOut: boolean
  /** Reloj del clúster en que quedó caído (para pasarlo a out a los 10 minutos). */
  downSince?: number
  destroyed?: boolean
}

interface Pool {
  name: string
  id: number
  size: number
  minSize: number
  pgs: number
  stored: number
}

interface Ceph {
  fsid: string
  network?: string
  installed: Set<string>
  mons: string[]
  mgrs: string[]
  osds: Osd[]
  pools: Pool[]
  flags: Set<string>
  /** Reloj propio si no hay clúster de Proxmox. */
  clock: number
}

const CEPH = new WeakMap<object, Ceph>()
const VERSION = '19.2.3'

function keyOf(pve: Pve): object {
  return pve.cluster ?? pve
}

function cephOf(pve: Pve | undefined): Ceph | undefined {
  return pve ? CEPH.get(keyOf(pve)) : undefined
}

function ensure(pve: Pve): Ceph {
  let c = CEPH.get(keyOf(pve))
  if (!c) {
    const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')
    c = { fsid: `${h()}${h()}-${h()}-4${h().slice(1)}-a${h().slice(1)}-${h()}${h()}${h()}`, installed: new Set(), mons: [], mgrs: [], osds: [], pools: [], flags: new Set(), clock: 0 }
    CEPH.set(keyOf(pve), c)
  }
  return c
}

function nodesOf(pve: Pve, sys: System): { name: string; sys: System; online: boolean }[] {
  if (pve.cluster) return pve.cluster.nodes.map((n: ClusterNode) => ({ name: n.name, sys: n.sys, online: nodeOnline(n) }))
  return [{ name: pve.node, sys, online: !sys.poweredOff }]
}

function clock(pve: Pve, c: Ceph): number {
  return (pve.cluster as PveCluster | undefined)?.clock ?? c.clock
}

function osdUp(pve: Pve, sys: System, o: Osd): boolean {
  if (o.failed || o.destroyed) return false
  return !!nodesOf(pve, sys).find((n) => n.name === o.host)?.online
}

/** Actualiza cuándo quedó caído cada OSD. */
function refresh(pve: Pve, sys: System, c: Ceph) {
  const now = clock(pve, c)
  for (const o of c.osds) {
    if (osdUp(pve, sys, o)) o.downSince = undefined
    else if (o.downSince === undefined) o.downSince = now
  }
}

function osdIn(pve: Pve, sys: System, c: Ceph, o: Osd): boolean {
  if (o.destroyed || o.manualOut) return false
  if (osdUp(pve, sys, o)) return true
  if (c.flags.has('noout')) return true
  return clock(pve, c) - (o.downSince ?? clock(pve, c)) < 600
}

function monQuorum(pve: Pve, sys: System, c: Ceph): string[] {
  const online = new Set(nodesOf(pve, sys).filter((n) => n.online).map((n) => n.name))
  return c.mons.filter((m) => online.has(m))
}

function hasQuorum(pve: Pve, sys: System, c: Ceph) {
  return c.mons.length > 0 && monQuorum(pve, sys, c).length > c.mons.length / 2
}

interface PoolHealth {
  pool: Pool
  copies: number
  objects: number
  degraded: number
  inactive: boolean
}

function poolHealth(pve: Pve, sys: System, c: Ceph): PoolHealth[] {
  const live = c.osds.filter((o) => !o.destroyed)
  const upHosts = new Set(live.filter((o) => osdUp(pve, sys, o)).map((o) => o.host))
  const inWeight = live.filter((o) => osdIn(pve, sys, c, o)).reduce((s, o) => s + o.size, 0)
  // Lo que está en OSD caídos que todavía cuentan como "in" (no se reconstruyó todavía).
  const downInWeight = live.filter((o) => !osdUp(pve, sys, o) && osdIn(pve, sys, c, o)).reduce((s, o) => s + o.size, 0)
  return c.pools.map((p) => {
    const objects = Math.max(2, Math.round(p.stored / (4 * MiB)))
    // Cuando los OSD caídos pasan a "out", los datos se reubican, pero cada copia tiene que estar
    // en un host distinto: con menos hosts que size, faltan copias.
    const copies = Math.min(p.size, upHosts.size)
    const missingByHosts = objects * (p.size - copies)
    const missingByDown = Math.round(objects * copies * (inWeight ? downInWeight / inWeight : 0))
    const degraded = Math.min(objects * p.size, missingByHosts + missingByDown)
    return { pool: p, copies, objects, degraded, inactive: copies < p.minSize }
  })
}

function hb(n: number): string {
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`
}

function kObjs(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(2)}k` : String(n)
}

function healthLines(pve: Pve, sys: System, c: Ceph): { level: 'HEALTH_OK' | 'HEALTH_WARN' | 'HEALTH_ERR'; lines: string[]; detail: string[] } {
  refresh(pve, sys, c)
  const lines: string[] = []
  const detail: string[] = []
  if (c.flags.size) {
    lines.push(`${[...c.flags].join(',')} flag(s) set`)
    detail.push(`[WRN] OSDMAP_FLAGS: ${[...c.flags].join(',')} flag(s) set`)
  }
  const q = monQuorum(pve, sys, c)
  if (q.length < c.mons.length) {
    lines.push(`${c.mons.length - q.length}/${c.mons.length} mons down, quorum ${q.join(',')}`)
    detail.push(`[WRN] MON_DOWN: ${c.mons.length - q.length}/${c.mons.length} mons down, quorum ${q.join(',')}`, ...c.mons.filter((m) => !q.includes(m)).map((m) => `    mon.${m} (rank ${c.mons.indexOf(m)}) addr [v2:${m}:3300/0,v1:${m}:6789/0] is down (out of quorum)`))
  }
  const live = c.osds.filter((o) => !o.destroyed)
  const down = live.filter((o) => !osdUp(pve, sys, o))
  if (down.length) {
    lines.push(`${down.length} osds down`)
    detail.push(`[WRN] OSD_DOWN: ${down.length} osds down`, ...down.map((o) => `    osd.${o.id} (root=default,host=${o.host}) is down`))
    const hostsDown = [...new Set(down.map((o) => o.host))].filter((h) => live.filter((o) => o.host === h).every((o) => !osdUp(pve, sys, o)))
    if (hostsDown.length) {
      lines.push(`${hostsDown.length} host (${live.filter((o) => hostsDown.includes(o.host)).length} osds) down`)
      detail.push(`[WRN] OSD_HOST_DOWN: ${hostsDown.length} host (${live.filter((o) => hostsDown.includes(o.host)).length} osds) down`, ...hostsDown.map((h) => `    host ${h} (root=default) (${live.filter((o) => o.host === h).length} osds) is down`))
    }
  }
  const ph = poolHealth(pve, sys, c)
  const totalObj = ph.reduce((s, p) => s + p.objects * p.pool.size, 0)
  const deg = ph.reduce((s, p) => s + p.degraded, 0)
  const degPgs = ph.filter((p) => p.degraded).reduce((s, p) => s + p.pool.pgs, 0)
  if (deg) {
    const t = `Degraded data redundancy: ${deg}/${totalObj} objects degraded (${((deg / totalObj) * 100).toFixed(3)}%), ${degPgs} pgs degraded, ${degPgs} pgs undersized`
    lines.push(t)
    detail.push(`[WRN] PG_DEGRADED: ${t.replace('Degraded data redundancy: ', 'Degraded data redundancy: ')}`)
  }
  const inactive = ph.filter((p) => p.inactive)
  if (inactive.length) {
    const n = inactive.reduce((s, p) => s + p.pool.pgs, 0)
    lines.push(`Reduced data availability: ${n} pgs inactive`)
    detail.push(`[WRN] PG_AVAILABILITY: Reduced data availability: ${n} pgs inactive`, ...inactive.map((p) => `    pool '${p.pool.name}' has only ${p.copies} of ${p.pool.size} copies, below min_size ${p.pool.minSize}: I/O is blocked`))
  }
  const totalRaw = live.filter((o) => osdIn(pve, sys, c, o)).reduce((s, o) => s + o.size, 0)
  const used = rawUsed(c)
  if (totalRaw && used / totalRaw > 0.85) {
    lines.push(`${live.length} nearfull osd(s)`)
    detail.push(`[WRN] OSD_NEARFULL: ${live.length} nearfull osd(s)`)
  }
  if (!live.length && c.mons.length) {
    lines.push('OSD count 0 < osd_pool_default_size 3')
    detail.push('[WRN] TOO_FEW_OSDS: OSD count 0 < osd_pool_default_size 3')
  }
  const level = inactive.length ? 'HEALTH_WARN' : lines.length ? 'HEALTH_WARN' : 'HEALTH_OK'
  return { level, lines, detail }
}

function rawUsed(c: Ceph) {
  return c.pools.reduce((s, p) => s + p.stored * p.size, 0) + c.osds.filter((o) => !o.destroyed).length * 1.1 * GiB
}

function status(pve: Pve, sys: System, c: Ceph): string {
  const h = healthLines(pve, sys, c)
  const q = monQuorum(pve, sys, c)
  const live = c.osds.filter((o) => !o.destroyed)
  const up = live.filter((o) => osdUp(pve, sys, o)).length
  const inn = live.filter((o) => osdIn(pve, sys, c, o)).length
  const online = new Set(nodesOf(pve, sys).filter((n) => n.online).map((n) => n.name))
  const mgrs = c.mgrs.filter((m) => online.has(m))
  const ph = poolHealth(pve, sys, c)
  const pgs = c.pools.reduce((s, p) => s + p.pgs, 0)
  const objects = ph.reduce((s, p) => s + p.objects, 0)
  const stored = c.pools.reduce((s, p) => s + p.stored, 0)
  const total = live.filter((o) => osdIn(pve, sys, c, o)).reduce((s, o) => s + o.size, 0)
  const used = rawUsed(c)
  let out = `  cluster:\n    id:     ${c.fsid}\n    health: ${h.level}\n${h.lines.map((l) => `            ${l}\n`).join('')}\n  services:\n`
  out += `    mon: ${c.mons.length} daemons, quorum ${q.join(',')} (age ${q.length < c.mons.length ? '2m' : '3h'})${q.length < c.mons.length ? `, out of quorum: ${c.mons.filter((m) => !q.includes(m)).join(', ')}` : ''}\n`
  out += `    mgr: ${mgrs.length ? `${mgrs[0]}(active, since 3h)${mgrs.length > 1 ? `, standbys: ${mgrs.slice(1).join(', ')}` : ''}` : 'no daemons active'}\n`
  out += `    osd: ${live.length} osds: ${up} up (since ${up < live.length ? '2m' : '3h'}), ${inn} in (since 3h)${c.flags.size ? `\n         flags ${[...c.flags].join(',')}` : ''}\n\n`
  out += `  data:\n    pools:   ${c.pools.length} pools, ${pgs} pgs\n    objects: ${kObjs(objects)} objects, ${hb(stored)}\n    usage:   ${hb(used)} used, ${hb(Math.max(0, total - used))} / ${hb(total)} avail\n`
  const bad = ph.filter((p) => p.degraded || p.inactive)
  if (!pgs) out += '    pgs:\n'
  else if (!bad.length) out += `    pgs:     ${pgs} active+clean\n`
  else {
    const deg = ph.reduce((s, p) => s + p.degraded, 0)
    const totalObj = ph.reduce((s, p) => s + p.objects * p.pool.size, 0)
    out += `    pgs:     ${deg}/${totalObj} objects degraded (${((deg / totalObj) * 100).toFixed(3)}%)\n`
    const groups = new Map<string, number>()
    for (const p of ph) {
      const k = p.inactive ? 'undersized+degraded+peered' : p.degraded ? 'active+undersized+degraded' : 'active+clean'
      groups.set(k, (groups.get(k) ?? 0) + p.pool.pgs)
    }
    for (const [k, n] of groups) out += `             ${n} ${k}\n`
  }
  return out
}

function osdTree(pve: Pve, sys: System, c: Ceph): string {
  const live = c.osds.filter((o) => !o.destroyed)
  const w = (b: number) => (b / (1024 * GiB)).toFixed(5)
  const hosts = [...new Set(live.map((o) => o.host))]
  let out = `ID  CLASS  WEIGHT   TYPE NAME       STATUS  REWEIGHT  PRI-AFF\n-1         ${w(live.reduce((s, o) => s + o.size, 0))}  root default\n`
  hosts.forEach((h, i) => {
    const os = live.filter((o) => o.host === h)
    out += `${String(-3 - i * 2).padStart(2)}         ${w(os.reduce((s, o) => s + o.size, 0))}      host ${h}\n`
    for (const o of os) out += `${String(o.id).padStart(2)}    hdd  ${w(o.size)}          osd.${o.id}${' '.repeat(Math.max(1, 6 - String(o.id).length))}${(osdUp(pve, sys, o) ? 'up' : 'down').padStart(4)}   ${osdIn(pve, sys, c, o) ? '1.00000' : '      0'}  1.00000\n`
  })
  return out
}

function df(pve: Pve, sys: System, c: Ceph): string {
  const live = c.osds.filter((o) => !o.destroyed && osdIn(pve, sys, c, o))
  const total = live.reduce((s, o) => s + o.size, 0)
  const used = rawUsed(c)
  const pct = total ? ((used / total) * 100).toFixed(2) : '0'
  let out = `--- RAW STORAGE ---\nCLASS     SIZE    AVAIL     USED  RAW USED  %RAW USED\nhdd    ${hb(total).padStart(7)}  ${hb(total - used).padStart(7)}  ${hb(used).padStart(7)}   ${hb(used).padStart(7)}  ${pct.padStart(9)}\nTOTAL  ${hb(total).padStart(7)}  ${hb(total - used).padStart(7)}  ${hb(used).padStart(7)}   ${hb(used).padStart(7)}  ${pct.padStart(9)}\n\n--- POOLS ---\nPOOL  ID  PGS   STORED  OBJECTS     USED  %USED  MAX AVAIL\n`
  for (const p of c.pools) {
    const maxAvail = ((total - used) / p.size) * 0.95
    out += `${p.name.padEnd(5)} ${String(p.id).padStart(2)}  ${String(p.pgs).padStart(3)}  ${hb(p.stored).padStart(7)}  ${kObjs(Math.max(2, Math.round(p.stored / (4 * MiB)))).padStart(7)}  ${hb(p.stored * p.size).padStart(7)}  ${(total ? ((p.stored * p.size) / total) * 100 : 0).toFixed(2).padStart(5)}  ${hb(maxAvail).padStart(9)}\n`
  }
  return out
}

function ensureMgrPool(c: Ceph) {
  if (!c.pools.some((p) => p.name === '.mgr') && c.osds.length && c.mgrs.length) c.pools.unshift({ name: '.mgr', id: 1, size: 3, minSize: 2, pgs: 1, stored: 577 * 1024 })
}

function makeOsd(sys: System, c: Ceph, host: string, dev: string): Osd | string {
  const d = sys.storage.disks.get(dev.replace(/^\/dev\//, ''))
  if (!d) return `unable to get device info for '${dev}'`
  const path = `/dev/${d.name}`
  if (d.parts.length || sys.storage.holder(path) || sys.storage.sigs.has(path)) return `device '${path}' is already in use`
  const id = c.osds.reduce((m, o) => Math.max(m, o.id + 1), 0)
  const vg = `ceph-${Math.random().toString(16).slice(2, 10)}-${Math.random().toString(16).slice(2, 6)}`
  sys.storage.sigs.set(path, { type: 'LVM2_member', uuid: sys.storage.newUuid('LVM2_member'), size: d.size, baseUsed: 0 })
  const v = { name: vg, uuid: sys.storage.newUuid('LVM2_member'), pvs: [path], lvs: [] }
  sys.storage.vgs.set(vg, v)
  sys.storage.addLv(v, `osd-block-${Math.random().toString(16).slice(2, 10)}`, d.size - 4 * MiB)
  const o: Osd = { id, host, dev: path, size: d.size, failed: false, manualOut: false }
  c.osds.push(o)
  return o
}

// ---------------------------------------------------------------------------------------
// Estado inicial: Ceph ya armado en el clúster
// ---------------------------------------------------------------------------------------

System.labHooks.push((all, states) => {
  all.forEach((sys, i) => {
    const st = (states[i] as BashState | undefined)?.proxmox?.ceph
    const pve = pveOf(sys)
    if (!st || !pve) return
    const c = ensure(pve)
    c.network = st.red
    const nodes = pve.cluster ? pve.cluster.nodes : [{ name: pve.node, sys }]
    for (const n of nodes) {
      c.installed.add(n.name)
      n.sys.installPackage('ceph-common', true)
    }
    c.mons = st.mons.length ? st.mons : nodes.map((n) => n.name).slice(0, 3)
    c.mgrs = [...c.mons]
    for (const o of st.osds) {
      const n = nodes.find((x) => x.name === o.nodo)
      if (!n) continue
      const r = makeOsd(n.sys, c, o.nodo, o.disco)
      if (typeof r !== 'string') r.failed = o.fallado
    }
    ensureMgrPool(c)
    for (const p of st.pools) {
      c.pools.push({ name: p.nombre, id: c.pools.length + 1, size: p.size, minSize: p.min_size, pgs: 128, stored: p.usado_gb * GiB })
      if (!pve.storages.has(p.nombre)) pve.storages.set(p.nombre, { id: p.nombre, type: 'rbd', content: ['images', 'rootdir'], path: p.nombre, totalBytes: 1, enabled: true, shared: true })
    }
    for (const n of nodes) writeConf(n.sys, c)
  })
})

function writeConf(sys: System, c: Ceph) {
  sys.vfs.mkdirp('/etc/pve', ROOT_CRED)
  sys.vfs.writeFile('/etc/pve/ceph.conf', `[global]\n\tauth_client_required = cephx\n\tauth_cluster_required = cephx\n\tauth_service_required = cephx\n\tcluster_network = ${c.network ?? ''}\n\tfsid = ${c.fsid}\n\tmon_allow_pool_delete = true\n\tmon_host = ${c.mons.join(' ')}\n\tosd_pool_default_min_size = 2\n\tosd_pool_default_size = 3\n\tpublic_network = ${c.network ?? ''}\n\n[client]\n\tkeyring = /etc/pve/priv/$cluster.$name.keyring\n`, ROOT_CRED, { mode: 0o640 })
  sys.vfs.mkdirp('/etc/ceph', ROOT_CRED)
  if (!sys.vfs.exists('/etc/ceph/ceph.conf', ROOT_CRED)) sys.vfs.symlink('/etc/pve/ceph.conf', '/etc/ceph/ceph.conf', ROOT_CRED)
}

// Sin clúster de Proxmox, el reloj de Ceph avanza con sleep.
System.sleepHooks.push((sys, seconds) => {
  const pve = pveOf(sys)
  const c = cephOf(pve)
  if (c && !pve?.cluster) c.clock += seconds
})

pveHooks.rbdPool = (sys, pool) => !!cephOf(pveOf(sys))?.pools.some((p) => p.name === pool)

// ---------------------------------------------------------------------------------------
// pveceph y ceph
// ---------------------------------------------------------------------------------------

function needInstalled(ctx: CommandContext, pve: Pve, c: Ceph | undefined): c is Ceph {
  if (!c || !c.installed.has(pve.node)) {
    ctx.err(`binary not installed: /usr/bin/ceph-mon\n[simulador] Primero: pveceph install --repository no-subscription\n`)
    return false
  }
  return true
}

function needInit(ctx: CommandContext, c: Ceph): boolean {
  if (!c.network) {
    ctx.err(`pveceph configuration not initialized - missing '/etc/pve/ceph.conf'\n[simulador] Primero: pveceph init --network 10.10.20.0/24\n`)
    return false
  }
  return true
}

register('pveceph', {
  usage: 'pveceph install|init|mon create|mgr create|osd create|osd destroy|pool create|status ...',
  summary: '  install --repository no-subscription\n  init --network RED/PREFIJO\n  mon create | mgr create\n  osd create /dev/sdX | osd destroy ID --cleanup\n  pool create NOMBRE [--size 3 --min_size 2] --add_storages\n  status',
  path: '/usr/bin',
  run(ctx) {
    const pve = pveOf(ctx.sys)
    if (!pve) {
      ctx.err('bash: pveceph: command not found\n')
      return 127
    }
    if (ctx.sh.user !== 'root') {
      ctx.err('only root can run this command\n')
      return 1
    }
    const [verb, sub, ...rest] = ctx.args
    const all = [sub, ...rest].filter((x): x is string => x !== undefined)
    const opts = new Map<string, string>()
    const pos: string[] = []
    for (let i = 0; i < all.length; i++) {
      if (all[i].startsWith('--')) opts.set(all[i].slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[++i] : '1')
      else pos.push(all[i])
    }
    let c = cephOf(pve)
    switch (verb) {
      case 'install': {
        const repo = opts.get('repository') ?? 'enterprise'
        if (repo === 'enterprise' && !pve.subscription) {
          ctx.out(`HINT: The no-subscription repository is not the best choice for production setups.\nProceed with using the 'enterprise' repository? [Y/n] y\nupdate available package list\n`)
          ctx.err(`E: Failed to fetch https://enterprise.proxmox.com/debian/ceph-squid/dists/trixie/InRelease  401  Unauthorized [IP: 170.130.165.90 443]\napt failed during ceph installation (25600)\n[simulador] Sin suscripción, el repositorio es no-subscription: pveceph install --repository no-subscription\n`)
          return 1
        }
        c = ensure(pve)
        c.installed.add(pve.node)
        ctx.sys.installPackage('ceph-common', true)
        ctx.out(`update available package list\nstart installation\nReading package lists... Done\nBuilding dependency tree... Done\nThe following NEW packages will be installed:\n  ceph ceph-base ceph-mds ceph-mgr ceph-mon ceph-osd ceph-volume ...\n0 upgraded, 64 newly installed, 0 to remove and 0 not upgraded.\n...\ninstalled Ceph ${VERSION} Squid successfully!\n\nreloading API to load new Ceph RADOS library...\n`)
        return 0
      }
      case 'init': {
        if (!needInstalled(ctx, pve, c)) return 1
        if (c.network) {
          ctx.err(`ceph cluster already initialized ('/etc/pve/ceph.conf' exists)\n`)
          return 1
        }
        const net = opts.get('network')
        if (!net || !/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(net)) {
          ctx.err(`400 Parameter verification failed.\nnetwork: invalid format - value does not look like a valid CIDR network\n`)
          return 1
        }
        c.network = net
        for (const n of nodesOf(pve, ctx.sys)) writeConf(n.sys, c)
        return 0
      }
      case 'mon':
      case 'mgr': {
        if (!needInstalled(ctx, pve, c) || !needInit(ctx, c)) return 1
        const list = verb === 'mon' ? c.mons : c.mgrs
        if (sub === 'create') {
          if (list.includes(pve.node)) {
            ctx.err(`ceph ${verb === 'mon' ? 'monitor' : 'manager'} directory '/var/lib/ceph/${verb}/ceph-${pve.node}' already exists\n`)
            return 1
          }
          list.push(pve.node)
          if (verb === 'mon') {
            ctx.out(`unable to get monitor info from DNS SRV with service name: ceph-mon\ncreating new monitor keyring\ncreating /etc/pve/priv/ceph.mon.keyring\nimporting contents of /etc/pve/priv/ceph.client.admin.keyring into /etc/pve/priv/ceph.mon.keyring\nmonmaptool: monmap file /tmp/monmap\nmonmaptool: generated fsid ${c.fsid}\n${c.mons.length === 1 ? "created the first monitor, assume it's safe to disable insecure global ID reclaim for new setup\n" : ''}Created symlink '/etc/systemd/system/ceph-mon.target.wants/ceph-mon@${pve.node}.service' -> '/usr/lib/systemd/system/ceph-mon@.service'.\n`)
            if (!c.mgrs.length) {
              c.mgrs.push(pve.node)
              ctx.out(`creating manager directory '/var/lib/ceph/mgr/ceph-${pve.node}'\ncreating keys for 'mgr.${pve.node}'\nsetting owner for directory\nenabling service 'ceph-mgr@${pve.node}.service'\nstarting service 'ceph-mgr@${pve.node}.service'\n`)
            }
          } else ctx.out(`creating manager directory '/var/lib/ceph/mgr/ceph-${pve.node}'\ncreating keys for 'mgr.${pve.node}'\nsetting owner for directory\nenabling service 'ceph-mgr@${pve.node}.service'\nstarting service 'ceph-mgr@${pve.node}.service'\n`)
          for (const n of nodesOf(pve, ctx.sys)) writeConf(n.sys, c)
          return 0
        }
        if (sub === 'destroy') {
          const name = pos[1] ?? pve.node
          const i = list.indexOf(name)
          if (i < 0) {
            ctx.err(`no such ${verb} '${name}'\n`)
            return 1
          }
          list.splice(i, 1)
          return 0
        }
        ctx.err(`USAGE: pveceph ${verb} create|destroy\n`)
        return 1
      }
      case 'osd': {
        if (!needInstalled(ctx, pve, c) || !needInit(ctx, c)) return 1
        if (!hasQuorum(pve, ctx.sys, c)) {
          ctx.err(`rados_connect failed - Connection timed out (500)\n[simulador] No hay monitores con quórum: pveceph mon create primero.\n`)
          return 1
        }
        if (sub === 'create') {
          const dev = pos[1]
          if (!dev) {
            ctx.err('400 not enough arguments\npveceph osd create <dev> [OPTIONS]\n')
            return 1
          }
          const r = makeOsd(ctx.sys, c, pve.node, dev)
          if (typeof r === 'string') {
            ctx.err(`${r}\n`)
            return 1
          }
          ensureMgrPool(c)
          ctx.out(`create OSD on ${r.dev} (bluestore)\nwiping block device ${r.dev}\n200+0 records in\n200+0 records out\n209715200 bytes (210 MB, 200 MiB) copied, 0.421 s, 498 MB/s\nRunning command: /bin/ceph-authtool --gen-print-key\nRunning command: /bin/ceph --cluster ceph --name client.bootstrap-osd --keyring /var/lib/ceph/bootstrap-osd/ceph.keyring -i - osd new\nRunning command: vgcreate --force --yes ${ctx.sys.storage.vgOf(r.dev)?.name} ${r.dev}\n stdout: Physical volume "${r.dev}" successfully created.\n stdout: Volume group "${ctx.sys.storage.vgOf(r.dev)?.name}" successfully created\n--> ceph-volume lvm activate successful for osd ID: ${r.id}\n--> ceph-volume lvm create successful for: ${r.dev}\n`)
          return 0
        }
        if (sub === 'destroy') {
          const id = Number(pos[1])
          const o = c.osds.find((x) => x.id === id && !x.destroyed)
          if (!o) {
            ctx.err(`osd.${pos[1] ?? ''} does not exist\n`)
            return 1
          }
          if (o.host !== pve.node) {
            ctx.err(`OSD osd.${id} is not on this node (it's on ${o.host})\n`)
            return 1
          }
          if (osdIn(pve, ctx.sys, c, o)) {
            ctx.err(`osd is in use (in == 1)\n[simulador] Primero sacalo con ceph osd out ${id} y esperá que termine de mover los datos.\n`)
            return 1
          }
          if (osdUp(pve, ctx.sys, o)) {
            ctx.err(`osd is still running (up == 1)\n[simulador] Pará el servicio: systemctl stop ceph-osd@${id}\n`)
            return 1
          }
          o.destroyed = true
          ctx.out(`destroy OSD osd.${id}\nRemove osd.${id} from the CRUSH map\nRemove the osd.${id} authentication key.\nRemove OSD osd.${id}\n${opts.has('cleanup') ? `Running command: /sbin/lvremove -f ...\nRunning command: /sbin/vgremove -f ...\n--> Zapping successful for OSD: ${id}\n` : ''}`)
          if (opts.has('cleanup')) {
            const vg = ctx.sys.storage.vgOf(o.dev)
            if (vg) ctx.sys.storage.vgs.delete(vg.name)
            ctx.sys.storage.sigs.delete(o.dev)
            ctx.sys.storage.syncDevFiles()
          }
          return 0
        }
        ctx.err('USAGE: pveceph osd create|destroy\n')
        return 1
      }
      case 'pool': {
        if (!needInstalled(ctx, pve, c) || !needInit(ctx, c)) return 1
        if (sub === 'create') {
          const name = pos[1]
          if (!name) {
            ctx.err('400 not enough arguments\npveceph pool create <name> [OPTIONS]\n')
            return 1
          }
          if (c.pools.some((p) => p.name === name)) {
            ctx.err(`pool '${name}' already exists\n`)
            return 1
          }
          const size = Number(opts.get('size') ?? 3)
          const minSize = Number(opts.get('min_size') ?? 2)
          ensureMgrPool(c)
          c.pools.push({ name, id: c.pools.length + 1, size, minSize, pgs: 128, stored: 0 })
          ctx.out(`pool ${name}: applying size = ${size}\npool ${name}: applying application = rbd\npool ${name}: applying min_size = ${minSize}\npool ${name}: applying pg_autoscale_mode = on\npool ${name}: applying pg_num = 128\n`)
          if (size < 3 || minSize < 2) ctx.err(`[simulador] size ${size} y min_size ${minSize}: con menos de 3 copias o min_size 1, una falla puede dejarte sin datos o con datos inconsistentes. Lo recomendado es 3 y 2.\n`)
          if (opts.has('add_storages')) {
            pve.storages.set(name, { id: name, type: 'rbd', content: ['images', 'rootdir'], path: name, totalBytes: 1, enabled: true, shared: true })
          }
          return 0
        }
        if (sub === 'ls') {
          ctx.out(`Name   Size Min Size PG Num\n${c.pools.map((p) => `${p.name.padEnd(6)} ${String(p.size).padStart(4)} ${String(p.minSize).padStart(8)} ${String(p.pgs).padStart(6)}`).join('\n')}\n`)
          return 0
        }
        ctx.err('USAGE: pveceph pool create|ls\n')
        return 1
      }
      case 'status':
        if (!needInstalled(ctx, pve, c)) return 1
        ctx.out(status(pve, ctx.sys, c))
        return 0
      default:
        ctx.out('USAGE: pveceph <COMMAND> [ARGS] [OPTIONS]\n\n       pveceph init  [OPTIONS]\n       pveceph install  [OPTIONS]\n       pveceph mgr create  [OPTIONS]\n       pveceph mon create  [OPTIONS]\n       pveceph osd create <dev> [OPTIONS]\n       pveceph osd destroy <osdid> [OPTIONS]\n       pveceph pool create <name> [OPTIONS]\n       pveceph pool ls\n       pveceph status\n')
        return verb ? 1 : 0
    }
  },
})

register('ceph', {
  usage: 'ceph -s | health [detail] | osd tree | df | osd set|unset noout | osd out|in ID | osd pool ls detail',
  path: '/usr/bin',
  run(ctx) {
    const pve = pveOf(ctx.sys)
    const c = cephOf(pve)
    if (!pve || !c || !c.installed.has(pve.node)) {
      ctx.err('bash: ceph: command not found\n')
      return 127
    }
    if (!c.mons.length || !hasQuorum(pve, ctx.sys, c)) {
      ctx.err(`${new Date().toISOString().replace('T', ' ').slice(0, 19)}.124 7f3a monclient(hunting): authenticate timed out after 300\n[errno 110] RADOS timed out (error connecting to the cluster)\n`)
      return 1
    }
    const a = ctx.args
    const cmd = a.filter((x) => !x.startsWith('-') || x === '-s').join(' ')
    if (a[0] === '-s' || a[0] === 'status' || a[0] === '--status') {
      ctx.out(status(pve, ctx.sys, c))
      return 0
    }
    if (a[0] === 'health') {
      const h = healthLines(pve, ctx.sys, c)
      if (a[1] === 'detail') ctx.out(`${h.level}${h.lines.length ? `: ${h.lines.join('; ')}` : ''}\n${h.detail.map((l) => l + '\n').join('')}`)
      else ctx.out(`${h.level}${h.lines.length ? `: ${h.lines.join('; ')}` : ''}\n`)
      return 0
    }
    if (cmd === 'osd tree') {
      refresh(pve, ctx.sys, c)
      ctx.out(osdTree(pve, ctx.sys, c))
      return 0
    }
    if (a[0] === 'df') {
      ctx.out(df(pve, ctx.sys, c))
      return 0
    }
    if (a[0] === 'osd' && (a[1] === 'set' || a[1] === 'unset')) {
      if (!['noout', 'norebalance', 'nobackfill', 'norecover', 'noscrub', 'nodeep-scrub'].includes(a[2] ?? '')) {
        ctx.err(`Invalid command: ${a[2] ?? ''} not in full|pause|noup|nodown|noout|noin|nobackfill|norebalance|norecover|noscrub|nodeep-scrub|notieragent\n`)
        return 22
      }
      if (a[1] === 'set') c.flags.add(a[2])
      else c.flags.delete(a[2])
      ctx.err(`${a[2]} is ${a[1] === 'set' ? 'set' : 'unset'}\n`)
      return 0
    }
    if (a[0] === 'osd' && (a[1] === 'out' || a[1] === 'in')) {
      const o = c.osds.find((x) => x.id === Number(String(a[2]).replace(/^osd\./, '')) && !x.destroyed)
      if (!o) {
        ctx.err(`osd.${a[2] ?? ''} does not exist\n`)
        return 2
      }
      o.manualOut = a[1] === 'out'
      ctx.err(`marked ${a[1]} osd.${o.id}. \n`)
      return 0
    }
    if (a[0] === 'osd' && a[1] === 'pool' && a[2] === 'ls') {
      ctx.out(c.pools.map((p) => (a[3] === 'detail' ? `pool ${p.id} '${p.name}' replicated size ${p.size} min_size ${p.minSize} crush_rule 0 object_hash rjenkins pg_num ${p.pgs} pgp_num ${p.pgs} autoscale_mode on application ${p.name === '.mgr' ? 'mgr' : 'rbd'}` : p.name)).join('\n') + '\n')
      return 0
    }
    if (a[0] === 'osd' && a[1] === 'pool' && a[2] === 'set') {
      const p = c.pools.find((x) => x.name === a[3])
      if (!p) {
        ctx.err(`Error ENOENT: unrecognized pool '${a[3] ?? ''}'\n`)
        return 2
      }
      if (a[4] === 'size') p.size = Number(a[5])
      else if (a[4] === 'min_size') p.minSize = Number(a[5])
      ctx.err(`set pool ${p.id} ${a[4]} to ${a[5]}\n`)
      return 0
    }
    if (cmd === 'mon stat') {
      const q = monQuorum(pve, ctx.sys, c)
      ctx.out(`e${c.mons.length}: ${c.mons.length} mons at {${c.mons.map((m) => `${m}=[v2:${m}:3300/0,v1:${m}:6789/0]`).join(',')}} removed_ranks: {} disallowed_leaders: {}, election epoch 42, leader 0 ${q[0]}, quorum ${q.map((_m, i) => i).join(',')} ${q.join(',')}\n`)
      return 0
    }
    if (a[0] === 'versions' || a[0] === '-v' || a[0] === '--version') {
      ctx.out(`ceph version ${VERSION} (cd1b6c2a4f4f8a3e1c34b1a2f0d9f6c1e5b7a8d3) squid (stable)\n`)
      return 0
    }
    ctx.err(`no valid command found; 10 closest matches:\nosd tree\nosd df\nosd set <key>\nosd unset <key>\nosd out <ids>...\nosd in <ids>...\nosd pool ls [detail]\nhealth [detail]\ndf\nstatus\nError EINVAL: invalid command\n`)
    return 22
  },
})

// ---------------------------------------------------------------------------------------
// Verificaciones
// ---------------------------------------------------------------------------------------

export function verifyCeph(sys: System, check: object): { ok: boolean; label: string } | undefined {
  if (!('ceph' in check)) return undefined
  const k = check as { ceph: string; mons?: number; osds?: number; osds_up?: number; pool?: string; size?: number; min_size?: number; flag?: string }
  const pve = pveOf(sys)
  const c = cephOf(pve)
  if (!pve || !c) return { ok: false, label: 'Ceph está instalado en el clúster' }
  const h = healthLines(pve, sys, c)
  let ok = k.ceph === 'cualquiera' || h.level === k.ceph
  const parts: string[] = []
  if (k.ceph !== 'cualquiera') parts.push(`en ${k.ceph}`)
  if (ok && k.mons !== undefined) {
    ok = c.mons.length === k.mons
    parts.push(`${k.mons} monitores`)
  }
  if (ok && k.osds !== undefined) {
    ok = c.osds.filter((o) => !o.destroyed).length === k.osds
    parts.push(`${k.osds} OSD`)
  }
  if (ok && k.osds_up !== undefined) {
    ok = c.osds.filter((o) => !o.destroyed && osdUp(pve, sys, o)).length === k.osds_up
    parts.push(`${k.osds_up} OSD funcionando`)
  }
  if (ok && k.pool) {
    const p = c.pools.find((x) => x.name === k.pool)
    ok = !!p && (k.size === undefined || p.size === k.size) && (k.min_size === undefined || p.minSize === k.min_size)
    parts.push(`con el pool ${k.pool}${k.size ? ` (size ${k.size}${k.min_size ? `, min_size ${k.min_size}` : ''})` : ''}`)
  }
  if (ok && k.flag) {
    ok = c.flags.has(k.flag)
    parts.push(`con el flag ${k.flag}`)
  }
  return { ok, label: `Ceph está ${parts.join(', ')}` }
}
