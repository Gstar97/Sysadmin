/**
 * Clúster de Proxmox VE: varios nodos del ejercicio (el equipo propio y los de "servidores")
 * unidos con corosync. Incluye pvecm (crear, unir, estado, votos esperados, dispositivo de
 * quórum, sacar un nodo), el quórum (sin mayoría, /etc/pve queda de solo lectura y no se puede
 * crear ni prender nada), la alta disponibilidad (ha-manager: recursos, reglas de afinidad,
 * modo mantenimiento) y la migración de VM y contenedores entre nodos.
 *
 * El tiempo del clúster avanza con sleep: cuando un nodo se apaga, la alta disponibilidad lo
 * "cerca" (fencing) al minuto y recupera sus VM en otro nodo a los dos minutos, como en un
 * clúster real. Si un nodo con recursos de HA se queda sin quórum, su watchdog lo reinicia.
 *
 * La configuración del clúster (/etc/pve) es compartida: los nodos usan el mismo mapa de
 * almacenamientos, usuarios y permisos. Los discos siguen siendo de cada nodo; al migrar, los
 * volúmenes se mueven con la VM.
 */
import { COMMANDS, register, type CommandContext } from './shell'
import { System } from './system'
import { ROOT_CRED } from './vfs'
import { confPath, fmtTime, guestName, isDriveKey, needRoot, parseDrive, parseOpts, pveOf, saveConf, startGuest, stopGuest, type Pve, type PveGuest } from './proxmox'

export interface ClusterNode {
  name: string
  nodeid: number
  ip: string
  votes: number
  sys: System
  pve: Pve
}

export interface HaResource {
  sid: string
  vmid: number
  type: 'vm' | 'ct'
  state: 'started' | 'stopped' | 'disabled' | 'ignored'
  maxRestart: number
  maxRelocate: number
  /** Nodo donde está (o estaba) el invitado. */
  node: string
  /** Lo que muestra ha-manager status. */
  status: 'started' | 'stopped' | 'fence' | 'recovery' | 'error' | 'freeze' | 'disabled' | 'ignored' | 'request_stop'
}

export interface HaRule {
  id: string
  type: 'node-affinity' | 'resource-affinity'
  resources: string[]
  /** node-affinity: nodo y prioridad (más alto, preferido). */
  nodes: { node: string; prio: number }[]
  strict: boolean
  /** resource-affinity: juntos (positive) o separados (negative). */
  affinity?: 'positive' | 'negative'
  disable?: boolean
}

export interface PveCluster {
  name: string
  version: number
  nodes: ClusterNode[]
  /** Votos esperados forzados con pvecm expected. */
  expected?: number
  qdevice?: { ip: string }
  ha: Map<string, HaResource>
  rules: HaRule[]
  /** Segundos de tiempo simulado (avanza con sleep). */
  clock: number
  /** Cuándo (en clock) dejó de verse cada nodo. */
  down: Map<string, number>
  /** Cuándo (en clock) se quedó sin quórum cada nodo con recursos de HA. */
  lostQuorum: Map<string, number>
  maintenance: Set<string>
  log: string[]
}

const now = () => new Date()

function clusterOf(pve: Pve | undefined): PveCluster | undefined {
  return pve?.cluster
}

function nodeIp(sys: System): string {
  return sys.interfaces.find((i) => i.name === 'vmbr0' && i.ip)?.ip?.split('/')[0] ?? sys.ownIps()[1] ?? '127.0.0.1'
}

/** El nodo responde en la red del clúster: prendido y con la placa del clúster arriba. */
export function nodeOnline(n: ClusterNode): boolean {
  if (n.sys.poweredOff) return false
  return n.sys.interfaces.some((i) => i.up && i.ip?.split('/')[0] === n.ip)
}

function qdeviceUp(c: PveCluster, from: ClusterNode): boolean {
  if (!c.qdevice) return false
  const host = [from.sys, ...from.sys.lab].find((s) => s.ownIps().includes(c.qdevice!.ip))
  return !!host && !host.poweredOff && !!host.services.get('corosync-qnetd')?.active
}

/** Los nodos que se ven entre sí desde ese nodo (su partición). */
function partition(c: PveCluster, from: ClusterNode): ClusterNode[] {
  if (!nodeOnline(from)) return []
  return c.nodes.filter(nodeOnline)
}

export function expectedVotes(c: PveCluster): number {
  return c.expected ?? c.nodes.reduce((s, n) => s + n.votes, 0) + (c.qdevice ? 1 : 0)
}

export function totalVotes(c: PveCluster, from: ClusterNode): number {
  return partition(c, from).reduce((s, n) => s + n.votes, 0) + (qdeviceUp(c, from) ? 1 : 0)
}

export function quorumNeeded(c: PveCluster): number {
  return Math.floor(expectedVotes(c) / 2) + 1
}

export function quorate(c: PveCluster, from: ClusterNode): boolean {
  return nodeOnline(from) && totalVotes(c, from) >= quorumNeeded(c)
}

function self(c: PveCluster, sys: System): ClusterNode {
  return c.nodes.find((n) => n.sys === sys)!
}

/** Si el nodo puede escribir en /etc/pve: sin clúster, siempre; en un clúster, con quórum. */
export function canWrite(pve: Pve, sys: System): boolean {
  const c = clusterOf(pve)
  if (!c) return true
  return quorate(c, self(c, sys))
}

function startService(sys: System, name: string) {
  const s = sys.services.get(name)
  if (!s) return
  s.enabled = true
  if (!s.active) {
    s.active = true
    s.failed = false
    s.since = Date.now()
    s.pid = sys.spawnService(name).pid
  }
}

// ---------------------------------------------------------------------------------------
// corosync.conf
// ---------------------------------------------------------------------------------------

function corosyncConf(c: PveCluster): string {
  const nodes = c.nodes
    .map((n) => `  node {\n    name: ${n.name}\n    nodeid: ${n.nodeid}\n    quorum_votes: ${n.votes}\n    ring0_addr: ${n.ip}\n  }\n`)
    .join('')
  const device = c.qdevice ? `  device {\n    model: net\n    net {\n      algorithm: ffsplit\n      host: ${c.qdevice.ip}\n      tls: on\n    }\n    votes: 1\n  }\n` : ''
  return `logging {\n  debug: off\n  to_syslog: yes\n}\n\nnodelist {\n${nodes}}\n\nquorum {\n${device}  provider: corosync_votequorum\n}\n\ntotem {\n  cluster_name: ${c.name}\n  config_version: ${c.version}\n  interface {\n    linknumber: 0\n  }\n  ip_version: ipv4-6\n  link_mode: passive\n  secauth: on\n  version: 2\n}\n\n`
}

function writeClusterFiles(c: PveCluster) {
  const text = corosyncConf(c)
  for (const n of c.nodes) {
    n.sys.vfs.mkdirp('/etc/corosync', ROOT_CRED)
    n.sys.vfs.writeFile('/etc/corosync/corosync.conf', text, ROOT_CRED, { mode: 0o644 })
    n.sys.vfs.writeFile('/etc/pve/corosync.conf', text, ROOT_CRED, { mode: 0o640 })
    for (const m of c.nodes) n.sys.vfs.mkdirp(`/etc/pve/nodes/${m.name}/qemu-server`, ROOT_CRED)
    writeHaFiles(c, n.sys)
  }
}

function writeHaFiles(c: PveCluster, sys: System) {
  sys.vfs.mkdirp('/etc/pve/ha', ROOT_CRED)
  const res = [...c.ha.values()].map((r) => `${r.type}: ${r.vmid}\n\tstate ${r.state}\n${r.maxRestart !== 1 ? `\tmax_restart ${r.maxRestart}\n` : ''}${r.maxRelocate !== 1 ? `\tmax_relocate ${r.maxRelocate}\n` : ''}`).join('\n')
  sys.vfs.writeFile('/etc/pve/ha/resources.cfg', res, ROOT_CRED, { mode: 0o640 })
  sys.vfs.writeFile('/etc/pve/ha/rules.cfg', c.rules.map(ruleText).join('\n'), ROOT_CRED, { mode: 0o640 })
}

function ruleText(r: HaRule): string {
  let t = `${r.type}: ${r.id}\n\tresources ${r.resources.join(',')}\n`
  if (r.type === 'node-affinity') t += `\tnodes ${r.nodes.map((n) => (n.prio !== 1 ? `${n.node}:${n.prio}` : n.node)).join(',')}\n${r.strict ? '\tstrict 1\n' : ''}`
  else t += `\taffinity ${r.affinity ?? 'positive'}\n`
  if (r.disable) t += '\tdisable 1\n'
  return t
}

/** Une un nodo al clúster: comparte la configuración de /etc/pve. */
function addNode(c: PveCluster, sys: System, pve: Pve) {
  const first = c.nodes[0]?.pve
  const id = c.nodes.reduce((m, n) => Math.max(m, n.nodeid), 0) + 1
  c.nodes.push({ name: pve.node, nodeid: id, ip: nodeIp(sys), votes: 1, sys, pve })
  if (first && first !== pve) {
    // Al unirse, la configuración del nodo se reemplaza por la del clúster.
    for (const [k, v] of pve.storages) if (!first.storages.has(k)) first.storages.set(k, v)
    pve.storages = first.storages
    pve.users = first.users
    pve.acls = first.acls
    for (const f of ['/etc/pve/storage.cfg', '/etc/pve/user.cfg']) if (first && c.nodes[0].sys.vfs.exists(f)) sys.vfs.writeFile(f, c.nodes[0].sys.vfs.readFile(f, ROOT_CRED), ROOT_CRED, { mode: 0o640 })
  }
  pve.cluster = c
  startService(sys, 'corosync')
}

// ---------------------------------------------------------------------------------------
// Invitados en el clúster
// ---------------------------------------------------------------------------------------

export function findGuest(c: PveCluster, vmid: number): { node: ClusterNode; g: PveGuest } | undefined {
  for (const n of c.nodes) {
    const g = n.pve.guests.get(vmid)
    if (g) return { node: n, g }
  }
  return undefined
}

/** Los discos del invitado que están en un almacenamiento local (no compartido). */
function localDisks(pve: Pve, g: PveGuest): { key: string; volid: string; cdrom: boolean }[] {
  const out: { key: string; volid: string; cdrom: boolean }[] = []
  for (const [k, v] of g.conf) {
    if (!isDriveKey(k) && !/^(rootfs|mp\d+)$/.test(k)) continue
    const volid = parseDrive(v).volid ?? (/^(rootfs|mp\d+)$/.test(k) ? v.split(',')[0] : undefined)
    if (!volid || volid === 'none') continue
    if (/cloudinit$/.test(volid)) continue
    const st = pve.storages.get(volid.split(':')[0])
    if (st?.shared) continue
    out.push({ key: k, volid, cdrom: v.includes('media=cdrom') })
  }
  return out
}

function moveGuest(src: ClusterNode, dst: ClusterNode, g: PveGuest) {
  src.pve.guests.delete(g.vmid)
  const p = confPath(g)
  if (src.sys.vfs.exists(p)) src.sys.vfs.unlink(p, ROOT_CRED)
  dst.pve.guests.set(g.vmid, g)
  for (const [volid, v] of [...src.pve.volumes]) {
    if (v.vmid !== g.vmid || v.content === 'backup') continue
    src.pve.volumes.delete(volid)
    dst.pve.volumes.set(volid, v)
  }
  saveConf(dst.sys, g)
}

function sidOf(g: PveGuest): string {
  return `${g.type === 'qemu' ? 'vm' : 'ct'}:${g.vmid}`
}

function stamp() {
  return fmtTime(Date.now())
}

/** Migra un invitado. Devuelve el texto de la migración o un error. */
function migrate(_c: PveCluster, src: ClusterNode, dst: ClusterNode, g: PveGuest, online: boolean, withLocal: boolean): { out: string } | { error: string } {
  const t0 = Date.now()
  const running = g.status === 'running'
  if (g.type === 'lxc' && running && !online) return { error: `CT is running - use online migration (--restart) or stop it first` }
  const disks = localDisks(src.pve, g)
  const cd = disks.find((d) => d.cdrom)
  if (cd) return { error: `can't migrate local disk '${cd.volid}': local cdrom image\nERROR: migration aborted (duration 00:00:01): problem with local resource` }
  if (running && g.type === 'qemu' && disks.length && !withLocal) return { error: `ERROR: migration aborted (duration 00:00:01): can't live migrate attached local disks without with-local-disks option` }
  for (const d of disks) {
    const st = d.volid.split(':')[0]
    if (!dst.pve.storages.get(st)?.enabled) return { error: `ERROR: migration aborted (duration 00:00:01): storage '${st}' is not available on node '${dst.name}'` }
  }
  const ts = stamp()
  let out = ''
  const memGb = Number(g.conf.get('memory') ?? 2048) / 1024
  if (g.type === 'lxc') {
    out += `${ts} shutdown CT ${g.vmid}\n${ts} starting migration of CT ${g.vmid} to node '${dst.name}' (${dst.ip})\n`
    for (const d of disks) out += `${ts} found local volume '${d.volid}' (in current VM config)\n${ts} volume '${d.volid}' is '${d.volid}' on the target\n`
    stopGuest(g)
    moveGuest(src, dst, g)
    out += `${ts} start final cleanup\n${ts} start container on target node\n${ts} migration finished successfully (duration 00:00:${String(8 + disks.length * 6).padStart(2, '0')})\n`
    if (running) startGuest(dst.sys, dst.pve, g)
    return { out }
  }
  if (!running) out += `${ts} use dedicated network address for sending migration traffic (${dst.ip})\n${ts} starting migration of VM ${g.vmid} to node '${dst.name}' (${dst.ip})\n`
  else out += `${ts} starting migration of VM ${g.vmid} to node '${dst.name}' (${dst.ip})\n`
  for (const d of disks) out += `${ts} found local disk '${d.volid}' (attached)\n`
  if (running) {
    if (disks.length) out += `${ts} starting VM ${g.vmid} on remote node '${dst.name}'\n${ts} volume '${disks[0].volid}' is '${disks[0].volid}' on the target\n${ts} start remote tunnel\n${ts} ssh tunnel ver 1\n${ts} starting storage migration\n${ts} ${disks[0].key}: start migration to nbd:unix:/run/qemu-server/${g.vmid}_nbd.migrate:exportname=drive-${disks[0].key}\ndrive mirror is starting for drive-${disks[0].key}\ndrive-${disks[0].key}: transferred 20.0 GiB of 20.0 GiB (100.00%) in 1m 4s, ready\nall 'mirror' jobs are ready\n`
    else out += `${ts} starting VM ${g.vmid} on remote node '${dst.name}'\n${ts} start remote tunnel\n${ts} ssh tunnel ver 1\n`
    out += `${ts} starting online/live migration on unix:/run/qemu-server/${g.vmid}.migrate\n${ts} set migration capabilities\n${ts} migration downtime limit: 100 ms\n${ts} migration cachesize: 256.0 MiB\n${ts} set migration parameters\n${ts} start migrate command to unix:/run/qemu-server/${g.vmid}.migrate\n${ts} migration active, transferred ${Math.round(memGb * 180)}.4 MiB of ${memGb.toFixed(1)} GiB VM-state, 1.1 GiB/s\n${ts} average migration speed: ${(memGb * 341).toFixed(1)} MiB/s - downtime 37 ms\n${ts} migration status: completed\n`
    if (disks.length) out += `all 'mirror' jobs are ready\ndrive-${disks[0].key}: Completing block job...\ndrive-${disks[0].key}: Completed successfully.\ndrive-${disks[0].key}: mirror-job finished\n`
  } else {
    for (const d of disks) out += `${ts} copying local disk images\n${ts} ${d.volid}: transferred 20.0 GiB of 20.0 GiB (100.00%)\n`
  }
  const secs = running ? (disks.length ? 72 : 7) : 2 + disks.length * 60
  out += `${ts} migration finished successfully (duration 00:${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')})\n`
  void t0
  const pid = g.pid
  moveGuest(src, dst, g)
  if (running) {
    g.status = 'running'
    g.pid = pid ?? dst.pve.nextPid++
  }
  return { out }
}

// ---------------------------------------------------------------------------------------
// Alta disponibilidad: lo que pasa con el tiempo
// ---------------------------------------------------------------------------------------

function haLog(c: PveCluster, text: string) {
  c.log.push(`${fmtTime(Date.now())} ${text}`)
}

/** El mejor nodo para un recurso: el de más prioridad según las reglas, y entre iguales, el menos cargado. */
function pickNode(c: PveCluster, r: HaResource, candidates: ClusterNode[]): ClusterNode | undefined {
  const rule = c.rules.find((x) => !x.disable && x.type === 'node-affinity' && x.resources.includes(r.sid))
  let list = candidates.filter((n) => !c.maintenance.has(n.name))
  if (rule) {
    const prio = (n: ClusterNode) => rule.nodes.find((x) => x.node === n.name)?.prio ?? (rule.strict ? -1 : 0)
    list = list.filter((n) => prio(n) >= 0)
    const best = Math.max(...list.map(prio))
    list = list.filter((n) => prio(n) === best)
  }
  // Separados (afinidad negativa): no al nodo donde ya está el otro recurso.
  for (const ar of c.rules.filter((x) => !x.disable && x.type === 'resource-affinity' && x.affinity === 'negative' && x.resources.includes(r.sid))) {
    const others = ar.resources.filter((s) => s !== r.sid).map((s) => c.ha.get(s)?.node)
    const filtered = list.filter((n) => !others.includes(n.name))
    if (filtered.length) list = filtered
  }
  const load = (n: ClusterNode) => [...n.pve.guests.values()].filter((g) => g.status === 'running').length
  return [...list].sort((a, b) => load(a) - load(b) || a.nodeid - b.nodeid)[0]
}

/** Avanza el estado del clúster: detecta nodos caídos, cerca, recupera y vuelve a su lugar. */
export function haTick(c: PveCluster) {
  haPass(c)
  // Una segunda pasada acomoda lo que la primera movió (por ejemplo, reglas que se combinan).
  haPass(c)
}

function haPass(c: PveCluster) {
  for (const n of c.nodes) {
    if (!nodeOnline(n)) {
      if (!c.down.has(n.name)) c.down.set(n.name, c.clock)
    } else if (c.down.has(n.name)) c.down.delete(n.name)
  }
  const alive = c.nodes.filter(nodeOnline)
  const master = alive.find((n) => quorate(c, n))
  // Nodos sin quórum con recursos de HA activos: el watchdog los reinicia al minuto.
  for (const n of alive) {
    const active = [...c.ha.values()].some((r) => r.node === n.name && r.state === 'started' && n.pve.guests.get(r.vmid)?.status === 'running')
    if (quorate(c, n) || !active) {
      c.lostQuorum.delete(n.name)
      continue
    }
    if (!c.lostQuorum.has(n.name)) c.lostQuorum.set(n.name, c.clock)
    if (c.clock - c.lostQuorum.get(n.name)! >= 60) {
      haLog(c, `watchdog: node '${n.name}' lost quorum with active HA services - self-fencing (reset)`)
      for (const g of n.pve.guests.values()) if (g.status === 'running') stopGuest(g)
      n.sys.journal.push({ time: Date.now(), unit: 'watchdog-mux.service', priority: 2, message: 'client watchdog expired - disable watchdog updates', ident: 'watchdog-mux' })
      c.lostQuorum.delete(n.name)
    }
  }
  if (!master) {
    for (const r of c.ha.values()) if (r.state === 'started') r.status = 'freeze'
    return
  }
  for (const r of c.ha.values()) {
    const where = c.nodes.find((n) => n.name === r.node)
    const found = findGuest(c, r.vmid)
    if (!where || !found) {
      r.status = 'error'
      continue
    }
    if (r.state === 'disabled' || r.state === 'ignored') {
      r.status = r.state
      continue
    }
    if (!nodeOnline(where)) {
      // Nodo caído: se espera a que se cerque (un minuto) y se recupera en otro (dos minutos).
      const since = c.down.get(where.name) ?? c.clock
      if (r.state !== 'started') {
        r.status = r.state
        continue
      }
      if (c.clock - since < 120) {
        r.status = 'fence'
        continue
      }
      const target = pickNode(c, r, alive.filter((n) => quorate(c, n)))
      const local = localDisks(where.pve, found.g).filter((d) => !d.cdrom)
      if (!target) {
        r.status = 'fence'
        continue
      }
      if (local.length) {
        if (r.status !== 'error') haLog(c, `recovery policy for service ${r.sid} failed: local disk '${local[0].volid}' is not available on node '${target.name}'`)
        r.status = 'error'
        continue
      }
      haLog(c, `node '${where.name}': state changed from 'unknown' => 'fence'`)
      haLog(c, `fencing: acknowledged - got agent lock for node '${where.name}'`)
      haLog(c, `recover service '${r.sid}' from fenced node '${where.name}' to node '${target.name}'`)
      found.g.status = 'stopped'
      moveGuest(where, target, found.g)
      r.node = target.name
      startGuest(target.sys, target.pve, found.g)
      r.status = 'started'
      continue
    }
    const g = found.g
    if (r.state === 'stopped') {
      if (g.status === 'running') stopGuest(g)
      r.status = 'stopped'
      continue
    }
    // state started: en marcha, y en el nodo que corresponde (vuelta atrás y mantenimiento).
    if (g.status !== 'running') startGuest(where.sys, where.pve, g)
    r.status = g.status === 'running' ? 'started' : 'error'
    const best = pickNode(c, r, alive.filter((n) => quorate(c, n)))
    const rule = c.rules.find((x) => !x.disable && x.type === 'node-affinity' && x.resources.includes(r.sid))
    const prio = (n?: string) => rule?.nodes.find((x) => x.node === n)?.prio ?? 0
    // Afinidad negativa: si un recurso que tiene que estar separado quedó en el mismo nodo, se mueve.
    const together = c.rules.some((x) => !x.disable && x.type === 'resource-affinity' && x.affinity === 'negative' && x.resources.includes(r.sid) && x.resources.some((o) => o !== r.sid && c.ha.get(o)?.node === where.name))
    const shouldMove = c.maintenance.has(where.name) || (rule && best && prio(best.name) > prio(where.name)) || (together && best && best !== where)
    if (shouldMove && best && best !== where) {
      const m = migrate(c, where, best, g, true, false)
      if ('out' in m) {
        haLog(c, `migrate service '${r.sid}' to node '${best.name}'${c.maintenance.has(where.name) ? ' (node in maintenance mode)' : ''}`)
        r.node = best.name
      }
    }
  }
}

function tickAll(sys: System) {
  const seen = new Set<PveCluster>()
  for (const s of [sys, ...sys.lab]) {
    const c = pveOf(s)?.cluster
    if (c && !seen.has(c)) {
      seen.add(c)
      haTick(c)
    }
  }
}

System.sleepHooks.push((sys, seconds) => {
  const seen = new Set<PveCluster>()
  for (const s of [sys, ...sys.lab]) {
    const c = pveOf(s)?.cluster
    if (!c || seen.has(c)) continue
    seen.add(c)
    // De a 10 segundos, para que los cambios pasen en orden.
    for (let t = 0; t < seconds; t += 10) {
      c.clock += Math.min(10, seconds - t)
      haTick(c)
    }
  }
})

System.powerHooks.push((sys, on) => {
  const pve = pveOf(sys)
  if (!pve) return
  const c = pve.cluster
  if (!on) {
    // Todo lo que corría en el nodo se corta.
    for (const g of pve.guests.values()) {
      if (g.status === 'running') stopGuest(g)
    }
    if (c) {
      const n = self(c, sys)
      for (const s of sys.services.values()) if (s.name === 'corosync') s.active = false
      c.down.set(n.name, c.clock)
      sys.journal.push({ time: Date.now(), unit: 'systemd', priority: 6, message: 'System is powering down.', ident: 'systemd' })
      for (const m of c.nodes) if (m !== n && nodeOnline(m)) m.sys.journal.push({ time: Date.now(), unit: 'corosync.service', priority: 5, message: `[KNET  ] link: host: ${n.nodeid} link: 0 is down`, ident: 'corosync' })
    }
    return
  }
  sys.bootTime = Date.now()
  if (c) {
    startService(sys, 'corosync')
    haTick(c)
  }
  // Al arrancar: los que tienen onboot (si hay quórum), salvo los que maneja la HA.
  for (const g of pve.guests.values()) {
    if (c && c.ha.has(sidOf(g))) continue
    if (g.conf.get('onboot') === '1' && (!c || quorate(c, self(c, sys)))) startGuest(sys, pve, g)
  }
  if (c) haTick(c)
})

// ---------------------------------------------------------------------------------------
// Estado inicial: clústeres ya armados
// ---------------------------------------------------------------------------------------

System.labHooks.push((all, states) => {
  const byName = new Map<string, PveCluster>()
  all.forEach((sys, i) => {
    const p = states[i]?.proxmox
    const pve = pveOf(sys)
    if (!p?.cluster || !pve) return
    let c = byName.get(p.cluster)
    if (!c) {
      c = { name: p.cluster, version: 1, nodes: [], ha: new Map(), rules: [], clock: 0, down: new Map(), lostQuorum: new Map(), maintenance: new Set(), log: [] }
      byName.set(p.cluster, c)
    }
    addNode(c, sys, pve)
    c.version = c.nodes.length
    if (p.qdevice) c.qdevice = { ip: p.qdevice }
  })
  all.forEach((sys, i) => {
    const p = states[i]?.proxmox
    const c = pveOf(sys)?.cluster
    if (!p || !c) return
    for (const h of p.ha ?? []) {
      const [type, id] = h.id.split(':')
      const found = findGuest(c, Number(id))
      if (!found) continue
      c.ha.set(h.id, { sid: h.id, vmid: Number(id), type: type as 'vm' | 'ct', state: h.estado, maxRestart: h.max_reinicios, maxRelocate: h.max_reubicaciones, node: found.node.name, status: h.estado === 'started' ? 'started' : 'stopped' })
    }
    for (const r of p.reglas_ha ?? []) c.rules.push({ id: r.id, type: r.tipo, resources: r.recursos, nodes: r.nodos.map((x) => ({ node: x.split(':')[0], prio: Number(x.split(':')[1] ?? 1) })), strict: r.estricta, affinity: r.afinidad })
  })
  for (const c of byName.values()) {
    writeClusterFiles(c)
    for (const n of c.nodes) for (const s of states) if (s?.proxmox?.mantenimiento?.includes(n.name)) c.maintenance.add(n.name)
    // Los nodos que el ejercicio pide apagados.
    haTick(c)
  }
})

// ---------------------------------------------------------------------------------------
// pvecm
// ---------------------------------------------------------------------------------------

function pvecmStatus(c: PveCluster, me: ClusterNode): string {
  const q = quorate(c, me)
  const part = partition(c, me)
  const hex = (n: number) => `0x${n.toString(16).padStart(8, '0')}`
  const date = now().toString().replace(/ GMT.*$/, '').replace(/^(\w+) (\w+) (\d+) (\d+) (.*)$/, '$1 $2 $3 $5 $4')
  const qd = c.qdevice ? (qdeviceUp(c, me) ? ' Qdevice' : '') : ''
  let out = `Cluster information\n-------------------\nName:             ${c.name}\nConfig Version:   ${c.version}\nTransport:        knet\nSecure auth:      on\n\nQuorum information\n------------------\nDate:             ${date}\nQuorum provider:  corosync_votequorum\nNodes:            ${part.length}\nNode ID:          ${hex(me.nodeid)}\nRing ID:          ${part[0]?.nodeid ?? me.nodeid}.${(c.version * 7 + part.length).toString(16)}\nQuorate:          ${q ? 'Yes' : 'No'}\n\nVotequorum information\n----------------------\nExpected votes:   ${expectedVotes(c)}\nHighest expected: ${expectedVotes(c)}\nTotal votes:      ${totalVotes(c, me)}\nQuorum:           ${quorumNeeded(c)} ${q ? '' : 'Activity blocked'}\nFlags:            ${q ? 'Quorate' : ''}${qd}\n\nMembership information\n----------------------\n    Nodeid      Votes${c.qdevice ? '    Qdevice' : ''} Name\n`
  for (const n of part) out += `${hex(n.nodeid)}          ${n.votes}${c.qdevice ? (qdeviceUp(c, me) ? '    A,V,NMW' : '         NR') : ''} ${n.ip}${n === me ? ' (local)' : ''}\n`
  if (c.qdevice && qdeviceUp(c, me)) out += `0x00000000          1            Qdevice\n`
  return out
}

register('pvecm', {
  usage: 'pvecm create|add|status|nodes|expected|delnode|qdevice ...',
  summary: '  create NOMBRE        crea un clúster en este nodo\n  add IP               une este nodo al clúster de ese nodo\n  status | nodes       estado, votos y quórum | lista de nodos\n  expected N           fuerza la cantidad de votos esperados\n  delnode NODO         saca del clúster un nodo ya apagado\n  qdevice setup IP     agrega un dispositivo de quórum (corosync-qnetd)',
  path: '/usr/bin',
  run(ctx) {
    const pve = pveOf(ctx.sys)
    if (!pve) {
      ctx.err('bash: pvecm: command not found\n')
      return 127
    }
    if (!needRoot(ctx)) return 1
    const sys = ctx.sys
    tickAll(sys)
    const [verb, ...rest] = ctx.args
    const { pos, opts } = parseOpts(rest)
    const c = pve.cluster
    const me = c ? self(c, sys) : undefined
    const noCluster = () => {
      ctx.err(`Error: Corosync config '/etc/pve/corosync.conf' does not exist - is this node part of a cluster?\n`)
      return 2
    }
    switch (verb) {
      case 'create': {
        const name = pos[0]
        if (!name) {
          ctx.err('400 not enough arguments\npvecm create <clustername> [OPTIONS]\n')
          return 2
        }
        if (c) {
          ctx.err('cluster config \'/etc/pve/corosync.conf\' already exists\n')
          return 2
        }
        if (!/^[A-Za-z][A-Za-z0-9-]{0,14}$/.test(name)) {
          ctx.err(`400 Parameter verification failed.\nclustername: value does not match the regex pattern\n`)
          return 2
        }
        const nc: PveCluster = { name, version: 1, nodes: [], ha: new Map(), rules: [], clock: 0, down: new Map(), lostQuorum: new Map(), maintenance: new Set(), log: [] }
        addNode(nc, sys, pve)
        if (opts.get('link0')) nc.nodes[0].ip = opts.get('link0')!.replace(/^address=/, '')
        writeClusterFiles(nc)
        ctx.out('Corosync Cluster Engine Authentication key generator.\nGathering 2048 bits for key from /dev/urandom.\nWriting corosync key to /etc/corosync/authkey.\nWriting corosync config to /etc/pve/corosync.conf\nRestart corosync and cluster filesystem\n')
        return 0
      }
      case 'add': {
        const ip = pos[0]
        if (!ip) {
          ctx.err('400 not enough arguments\npvecm add <hostname> [OPTIONS]\n')
          return 2
        }
        const targetIp = sys.resolveHost(ip) ?? ip
        const target = sys.lab.find((s) => s.ownIps().includes(targetIp))
        ctx.out(`Please enter superuser (root) password for '${ip}': **********\n[simulador] Pide la clave de root de ${ip}; se da por ingresada.\n`)
        if (!target) {
          ctx.err(`500 Can't connect to ${ip}:8006 (Connection timed out)\n`)
          return 255
        }
        const tc = pveOf(target)?.cluster
        ctx.out(`Establishing API connection with host '${ip}'\nThe authenticity of host '${ip}' can't be established.\nX509 SHA256 key fingerprint is 6C:4E:21:9A:0F:B3:D8:57:12:AE:90:3C:7B:E4:5D:11:C9:08:6A:F2:33:8D:14:B7:5E:0A:C6:29:93:F1:7D:42.\nAre you sure you want to continue connecting (yes/no)? yes\nLogin succeeded.\ncheck cluster join API version\n`)
        const problems: string[] = []
        if (!tc) {
          ctx.err(`500 unable to get cluster config from '${ip}' - is it part of a cluster? (create one there first with pvecm create)\n`)
          return 255
        }
        if (c) problems.push('corosync is already running, is this node already in a cluster?!')
        if (pve.guests.size) problems.push('this host already contains virtual guests')
        if (tc.nodes.some((n) => n.name === pve.node)) problems.push(`nodename '${pve.node}' is already used by a cluster member`)
        if (problems.length) {
          ctx.err(`detected the following error(s):\n${problems.map((p) => `* ${p}`).join('\n')}\nCheck if node may join a cluster failed!\n`)
          return 255
        }
        const tn = self(tc, target)
        if (!quorate(tc, tn)) {
          ctx.err(`500 cluster not ready - no quorum?\n`)
          return 255
        }
        const link = opts.get('link0')?.replace(/^address=/, '')
        if (!link) ctx.out(`No cluster network links passed explicitly, fallback to local node IP '${nodeIp(sys)}'\n`)
        addNode(tc, sys, pve)
        if (link) tc.nodes[tc.nodes.length - 1].ip = link
        tc.version++
        writeClusterFiles(tc)
        ctx.out(`Request addition of this node\nJoin request OK, finishing setup locally\nstopping pve-cluster service\nbackup old database to '/var/lib/pve-cluster/backup/config-${Math.floor(Date.now() / 1000)}.sql.gz'\nwaiting for quorum...OK\n(re)generate node files\ngenerate new node certificate\nmerge authorized SSH keys\ngenerated new node certificate, restart pveproxy and pvedaemon services\nsuccessfully added node '${pve.node}' to cluster.\n`)
        return 0
      }
      case 'status':
        if (!c || !me) return noCluster()
        ctx.out(pvecmStatus(c, me))
        return 0
      case 'nodes': {
        if (!c || !me) return noCluster()
        ctx.out(`\nMembership information\n----------------------\n    Nodeid      Votes Name\n`)
        for (const n of partition(c, me)) ctx.out(`${String(n.nodeid).padStart(10)} ${String(n.votes).padStart(10)} ${n.name}${n === me ? ' (local)' : ''}\n`)
        if (c.qdevice && qdeviceUp(c, me)) ctx.out(`         0          1 Qdevice\n`)
        return 0
      }
      case 'expected': {
        if (!c || !me) return noCluster()
        const n = Number(pos[0])
        if (!Number.isInteger(n) || n < 1) {
          ctx.err('400 Parameter verification failed.\nexpected: type check (\'integer\') failed - got \'' + (pos[0] ?? '') + "'\n")
          return 2
        }
        if (n < totalVotes(c, me)) {
          ctx.err('Unable to set expected votes: CS_ERR_INVALID_PARAM\n')
          return 2
        }
        c.expected = n
        tickAll(sys)
        return 0
      }
      case 'delnode': {
        if (!c || !me) return noCluster()
        const name = pos[0]
        const n = c.nodes.find((x) => x.name === name)
        if (!n) {
          ctx.err(`400 Parameter verification failed.\nnode: no such cluster node '${name ?? ''}'\n`)
          return 2
        }
        if (n === me) {
          ctx.err('Cannot delete myself from cluster!\n')
          return 2
        }
        if (!quorate(c, me)) {
          ctx.err('cluster not ready - no quorum?\n')
          return 2
        }
        if (nodeOnline(n)) ctx.err(`[simulador] ${name} sigue prendido: en un clúster real hay que apagarlo antes, y no volver a prenderlo conectado a la misma red sin reinstalarlo.\n`)
        c.nodes = c.nodes.filter((x) => x !== n)
        n.pve.cluster = undefined
        c.expected = undefined
        c.version++
        writeClusterFiles(c)
        ctx.out(`Killing node ${n.nodeid}\n`)
        return 0
      }
      case 'qdevice': {
        if (!c || !me) return noCluster()
        const sub = pos[0]
        if (sub === 'remove') {
          if (!c.qdevice) {
            ctx.err('error during cfs-locked \'file-corosync_conf\' operation: no QDevice configured!\n')
            return 2
          }
          c.qdevice = undefined
          c.version++
          writeClusterFiles(c)
          ctx.out('Removed Qdevice.\n')
          return 0
        }
        if (sub !== 'setup' || !pos[1]) {
          ctx.err('400 not enough arguments\npvecm qdevice setup <address> [OPTIONS]\n')
          return 2
        }
        const ip = sys.resolveHost(pos[1]) ?? pos[1]
        const host = sys.lab.find((s) => s.ownIps().includes(ip))
        if (c.qdevice) {
          ctx.err('QDevice already configured!\n')
          return 2
        }
        if (c.nodes.length % 2 === 1 && opts.get('force') === undefined) {
          ctx.err('Clusters with an odd node count are not officially supported!\n')
          return 2
        }
        const missing = c.nodes.filter((n) => !n.sys.installed.has('corosync-qdevice'))
        if (missing.length) {
          ctx.err(`[simulador] Falta el paquete corosync-qdevice en: ${missing.map((n) => n.name).join(', ')} (apt install corosync-qdevice en cada nodo).\nCommand 'corosync-qdevice-net-certutil' failed: exit code 127\n`)
          return 2
        }
        if (!host || !host.services.get('corosync-qnetd')?.active) {
          ctx.err(`[simulador] En ${pos[1]} tiene que estar corriendo corosync-qnetd (apt install corosync-qnetd).\nssh: connect to host ${pos[1]} port 22: Connection refused\n`)
          return 2
        }
        c.qdevice = { ip }
        c.version++
        writeClusterFiles(c)
        ctx.out(`INFO: initializing qnetd server\nCertificate database (/etc/corosync/qnetd/nssdb) already exists. Delete it to initialize new db\n\nINFO: copying CA cert and initializing on all nodes\n\nnode '${me.name}': Creating /etc/corosync/qdevice/net/nssdb\n${c.nodes.filter((n) => n !== me).map((n) => `node '${n.name}': Creating /etc/corosync/qdevice/net/nssdb\n`).join('')}\nINFO: generating cert request\nINFO: copying exported cert request to qnetd server\nINFO: sign and export cluster cert\nINFO: import certificate\nINFO: copy and import pk12 cert to all nodes\nINFO: add QDevice to cluster configuration\nINFO: start and enable corosync qdevice daemon on node '${me.name}'...\n${c.nodes.filter((n) => n !== me).map((n) => `INFO: start and enable corosync qdevice daemon on node '${n.name}'...\n`).join('')}Reloading corosync.conf...\nDone\n`)
        return 0
      }
      case 'updatecerts':
        ctx.out('(re)generate node files\nmerge authorized SSH keys\n')
        return 0
      default:
        ctx.out('USAGE: pvecm <COMMAND> [ARGS] [OPTIONS]\n\n       pvecm add <hostname> [OPTIONS]\n       pvecm create <clustername> [OPTIONS]\n       pvecm delnode <node>\n       pvecm expected <expected>\n       pvecm nodes\n       pvecm qdevice remove\n       pvecm qdevice setup <address> [OPTIONS]\n       pvecm status\n       pvecm updatecerts  [OPTIONS]\n')
        return verb ? 2 : 0
    }
  },
})

// ---------------------------------------------------------------------------------------
// ha-manager
// ---------------------------------------------------------------------------------------

function haStatus(c: PveCluster, me: ClusterNode): string {
  const q = quorate(c, me)
  const date = now().toString().replace(/ GMT.*$/, '').replace(/^(\w+) (\w+) (\d+) (\d+) (.*)$/, '$1 $2 $3 $5 $4')
  const master = c.nodes.filter(nodeOnline).find((n) => quorate(c, n))
  let out = `quorum ${q ? 'OK' : 'No quorum on node ' + me.name + '!'}\n`
  if (master) out += `master ${master.name} (active, ${date})\n`
  for (const n of c.nodes) {
    const has = [...c.ha.values()].some((r) => r.node === n.name)
    const st = !nodeOnline(n) ? 'old timestamp - dead?' : c.maintenance.has(n.name) ? 'maintenance mode' : has ? 'active' : 'idle'
    out += `lrm ${n.name} (${st}, ${date})\n`
  }
  for (const r of [...c.ha.values()].sort((a, b) => a.vmid - b.vmid)) out += `service ${r.sid} (${r.node}, ${r.status})\n`
  if ([...c.ha.values()].some((r) => r.status === 'fence')) out += '[simulador] La recuperación tarda unos dos minutos: esperá (por ejemplo, sleep 60) y volvé a mirar.\n'
  return out
}

function parseSid(s: string | undefined): { type: 'vm' | 'ct'; vmid: number; sid: string } | undefined {
  if (!s) return undefined
  const m = /^(?:(vm|ct):)?(\d+)$/.exec(s)
  if (!m) return undefined
  return { type: (m[1] as 'vm' | 'ct') ?? 'vm', vmid: Number(m[2]), sid: `${m[1] ?? 'vm'}:${m[2]}` }
}

register('ha-manager', {
  usage: 'ha-manager add|remove|set|status|config|migrate|relocate|rules|crm-command ...',
  summary: '  add vm:ID [--state started]     pone una VM bajo alta disponibilidad\n  status | config                 estado | recursos configurados\n  migrate vm:ID NODO              migra en vivo (relocate: apagando)\n  rules add node-affinity ID --resources vm:ID --nodes pve01:2,pve02:1\n  crm-command node-maintenance enable|disable NODO',
  path: '/usr/sbin',
  run(ctx) {
    const pve = pveOf(ctx.sys)
    if (!pve) {
      ctx.err('bash: ha-manager: command not found\n')
      return 127
    }
    const c = pve.cluster
    const [verb, ...rest] = ctx.args
    if (!c) {
      if (verb === 'status') {
        ctx.out('quorum OK\n')
        return 0
      }
      ctx.err('[simulador] La alta disponibilidad necesita un clúster (pvecm create).\nunable to read file \'/etc/pve/corosync.conf\'\n')
      return 2
    }
    const me = self(c, ctx.sys)
    tickAll(ctx.sys)
    const { pos, opts } = parseOpts(rest)
    const write = () => {
      if (!quorate(c, me)) {
        ctx.err('cluster not ready - no quorum?\n')
        return false
      }
      return true
    }
    const save = () => {
      for (const n of c.nodes) writeHaFiles(c, n.sys)
      haTick(c)
    }
    switch (verb) {
      case 'status':
        ctx.out(haStatus(c, me))
        return 0
      case 'config':
        for (const r of c.ha.values()) ctx.out(`${r.sid}\n\tstate ${r.state}\n${r.maxRestart !== 1 ? `\tmax_restart ${r.maxRestart}\n` : ''}${r.maxRelocate !== 1 ? `\tmax_relocate ${r.maxRelocate}\n` : ''}\n`)
        return 0
      case 'add': {
        if (!needRoot(ctx) || !write()) return 2
        const s = parseSid(pos[0])
        if (!s) {
          ctx.err(`400 Parameter verification failed.\nsid: unable to parse service id '${pos[0] ?? ''}'\n`)
          return 2
        }
        const found = findGuest(c, s.vmid)
        if (!found || (found.g.type === 'qemu') !== (s.type === 'vm')) {
          ctx.err(`no such ${s.type === 'vm' ? 'VM' : 'CT'} '${s.vmid}'\n`)
          return 2
        }
        if (c.ha.has(s.sid)) {
          ctx.err(`resource ID '${s.sid}' already defined\n`)
          return 2
        }
        const state = (opts.get('state') ?? 'started') as HaResource['state']
        c.ha.set(s.sid, { sid: s.sid, vmid: s.vmid, type: s.type, state, maxRestart: Number(opts.get('max_restart') ?? 1), maxRelocate: Number(opts.get('max_relocate') ?? 1), node: found.node.name, status: 'request_stop' })
        save()
        return 0
      }
      case 'remove': {
        if (!needRoot(ctx) || !write()) return 2
        const s = parseSid(pos[0])
        if (!s || !c.ha.delete(s.sid)) {
          ctx.err(`resource '${pos[0] ?? ''}' does not exist\n`)
          return 2
        }
        save()
        return 0
      }
      case 'set': {
        if (!needRoot(ctx) || !write()) return 2
        const s = parseSid(pos[0])
        const r = s ? c.ha.get(s.sid) : undefined
        if (!r) {
          ctx.err(`resource '${pos[0] ?? ''}' does not exist\n`)
          return 2
        }
        if (opts.has('state')) r.state = opts.get('state') as HaResource['state']
        if (opts.has('max_restart')) r.maxRestart = Number(opts.get('max_restart'))
        if (opts.has('max_relocate')) r.maxRelocate = Number(opts.get('max_relocate'))
        save()
        return 0
      }
      case 'migrate':
      case 'relocate': {
        if (!needRoot(ctx) || !write()) return 2
        const s = parseSid(pos[0])
        const r = s ? c.ha.get(s.sid) : undefined
        const target = c.nodes.find((n) => n.name === pos[1])
        if (!r) {
          ctx.err(`service '${pos[0] ?? ''}' not managed by HA\n`)
          return 2
        }
        if (!target) {
          ctx.err(`400 Parameter verification failed.\nnode: no such cluster node '${pos[1] ?? ''}'\n`)
          return 2
        }
        const res = haMove(c, r, target, verb === 'migrate')
        if ('error' in res) {
          ctx.err(res.error + '\n')
          return 2
        }
        ctx.out(`[simulador] El CRM pidió ${verb === 'migrate' ? 'migrar' : 'reubicar'} ${r.sid} a ${target.name}; ya quedó allá.\n`)
        return 0
      }
      case 'crm-command': {
        if (!needRoot(ctx) || !write()) return 2
        if (pos[0] === 'node-maintenance' && (pos[1] === 'enable' || pos[1] === 'disable')) {
          const n = c.nodes.find((x) => x.name === pos[2])
          if (!n) {
            ctx.err(`400 Parameter verification failed.\nnode: no such cluster node '${pos[2] ?? ''}'\n`)
            return 2
          }
          if (pos[1] === 'enable') c.maintenance.add(n.name)
          else c.maintenance.delete(n.name)
          haTick(c)
          return 0
        }
        if (pos[0] === 'migrate' || pos[0] === 'relocate') return COMMANDS.get('ha-manager')!.run({ ...ctx, args: [pos[0], ...pos.slice(1)] }) as number
        ctx.err('USAGE: ha-manager crm-command node-maintenance enable|disable <node>\n')
        return 2
      }
      case 'rules': {
        const sub = pos[0]
        if (sub === 'config' || sub === 'list') {
          ctx.out(c.rules.map(ruleText).join('\n'))
          return 0
        }
        if (!needRoot(ctx) || !write()) return 2
        if (sub === 'remove') {
          const before = c.rules.length
          c.rules = c.rules.filter((r) => r.id !== pos[1])
          if (c.rules.length === before) {
            ctx.err(`no such rule '${pos[1] ?? ''}'\n`)
            return 2
          }
          save()
          return 0
        }
        if (sub === 'add' && (pos[1] === 'node-affinity' || pos[1] === 'resource-affinity') && pos[2]) {
          const resources = (opts.get('resources') ?? '').split(',').filter(Boolean)
          if (!resources.length) {
            ctx.err('400 Parameter verification failed.\nresources: property is missing and it is not optional\n')
            return 2
          }
          const bad = resources.find((x) => !c.ha.has(parseSid(x)?.sid ?? x))
          if (bad) {
            ctx.err(`400 Parameter verification failed.\nresources: resource '${bad}' is not configured as HA resource\n`)
            return 2
          }
          if (c.rules.some((r) => r.id === pos[2])) {
            ctx.err(`rule '${pos[2]}' already defined\n`)
            return 2
          }
          const nodes = (opts.get('nodes') ?? '').split(',').filter(Boolean).map((x) => ({ node: x.split(':')[0], prio: Number(x.split(':')[1] ?? 1) }))
          if (pos[1] === 'node-affinity' && !nodes.length) {
            ctx.err('400 Parameter verification failed.\nnodes: property is missing and it is not optional\n')
            return 2
          }
          const badNode = nodes.find((n) => !c.nodes.some((x) => x.name === n.node))
          if (badNode) {
            ctx.err(`400 Parameter verification failed.\nnodes: no such cluster node '${badNode.node}'\n`)
            return 2
          }
          c.rules.push({ id: pos[2], type: pos[1], resources: resources.map((x) => parseSid(x)?.sid ?? x), nodes, strict: opts.get('strict') === '1', affinity: (opts.get('affinity') as 'positive' | 'negative') ?? (pos[1] === 'resource-affinity' ? 'positive' : undefined) })
          save()
          return 0
        }
        ctx.err('USAGE: ha-manager rules add <type> <rule> --resources <sid,...> [--nodes <node>[:<prio>],...] [--strict 1]\n       ha-manager rules config | remove <rule>\n')
        return 2
      }
      default:
        ctx.out('USAGE: ha-manager <COMMAND> [ARGS] [OPTIONS]\n\n       ha-manager add <sid> [OPTIONS]\n       ha-manager config  [OPTIONS]\n       ha-manager migrate <sid> <node>\n       ha-manager relocate <sid> <node>\n       ha-manager remove <sid>\n       ha-manager rules add <type> <rule> [OPTIONS]\n       ha-manager set <sid> [OPTIONS]\n       ha-manager status  [OPTIONS]\n       ha-manager crm-command node-maintenance enable|disable <node>\n')
        return verb ? 2 : 0
    }
  },
})

function haMove(c: PveCluster, r: HaResource, target: ClusterNode, live: boolean): { ok: true } | { error: string } {
  const found = findGuest(c, r.vmid)
  if (!found) return { error: `no such VM '${r.vmid}'` }
  if (found.node === target) return { ok: true }
  if (!nodeOnline(target)) return { error: `node '${target.name}' seems to be offline` }
  const res = migrate(c, found.node, target, found.g, live && found.g.status === 'running', false)
  if ('error' in res) return res
  r.node = target.name
  if (!live && r.state === 'started' && found.g.status !== 'running') startGuest(target.sys, target.pve, found.g)
  return { ok: true }
}

// ---------------------------------------------------------------------------------------
// qm y pct en un clúster: quórum, IDs únicos, HA y migrate
// ---------------------------------------------------------------------------------------

const WRITE_VERBS = new Set(['create', 'set', 'start', 'stop', 'shutdown', 'reboot', 'destroy', 'clone', 'template', 'snapshot', 'rollback', 'delsnapshot', 'restore', 'resize', 'importdisk', 'disk', 'migrate', 'enter', 'exec', 'mount'])

for (const cmd of ['qm', 'pct']) {
  const def = COMMANDS.get(cmd)!
  const run = def.run
  def.run = (ctx: CommandContext) => {
    const pve = pveOf(ctx.sys)
    const c = pve?.cluster
    if (!pve || !c) {
      if (ctx.args[0] === 'migrate' && pve) {
        ctx.err('no such cluster node\n[simulador] Para migrar hace falta un clúster (pvecm create y pvecm add).\n')
        return 2
      }
      return run(ctx)
    }
    tickAll(ctx.sys)
    const me = self(c, ctx.sys)
    const verb = ctx.args[0] ?? ''
    const type = cmd === 'qm' ? 'qemu' : 'lxc'
    if (WRITE_VERBS.has(verb) && ctx.sh.user === 'root' && !quorate(c, me)) {
      ctx.err(`${verb === 'create' ? `unable to create ${cmd === 'qm' ? 'VM' : 'CT'} ${ctx.args[1] ?? ''} - ` : ''}cluster not ready - no quorum?\n`)
      return 255
    }
    const vmid = Number(ctx.args[1])
    if (verb === 'create' && Number.isInteger(vmid)) {
      const other = findGuest(c, vmid)
      if (other && other.node !== me) {
        ctx.err(`unable to create ${cmd === 'qm' ? 'VM' : 'CT'} ${vmid}: config file already exists\n[simulador] El ID ${vmid} ya lo usa un invitado en ${other.node.name}: los IDs son únicos en todo el clúster.\n`)
        return 255
      }
    }
    // Invitados bajo HA: start, stop y shutdown se le piden al administrador de HA.
    const sid = `${cmd === 'qm' ? 'vm' : 'ct'}:${vmid}`
    const ha = c.ha.get(sid)
    if (ha && (verb === 'start' || verb === 'stop' || verb === 'shutdown') && ctx.sh.user === 'root') {
      const found = findGuest(c, vmid)
      if (found && found.node === me) {
        ha.state = verb === 'start' ? 'started' : 'stopped'
        ctx.out(`Requesting HA ${verb === 'start' ? 'start' : 'stop'} for ${cmd === 'qm' ? 'VM' : 'CT'} ${vmid}\n`)
        for (const n of c.nodes) writeHaFiles(c, n.sys)
        haTick(c)
        return 0
      }
    }
    if (verb !== 'migrate') return run(ctx)
    if (!needRoot(ctx)) return 1
    const { pos, opts } = parseOpts(ctx.args.slice(1))
    const g = pve.guests.get(Number(pos[0]))
    if (!g || g.type !== type) {
      const elsewhere = findGuest(c, Number(pos[0]))
      ctx.err(`Configuration file 'nodes/${pve.node}/${cmd === 'qm' ? 'qemu-server' : 'lxc'}/${pos[0] ?? ''}.conf' does not exist\n${elsewhere ? `[simulador] Está en ${elsewhere.node.name}: migrate se ejecuta en el nodo donde está el invitado.\n` : ''}`)
      return 2
    }
    const target = c.nodes.find((n) => n.name === pos[1])
    if (!pos[1]) {
      ctx.err(`400 not enough arguments\n${cmd} migrate <vmid> <target> [OPTIONS]\n`)
      return 2
    }
    if (!target) {
      ctx.err(`400 Parameter verification failed.\ntarget: no such cluster node '${pos[1]}'\n`)
      return 2
    }
    if (target === me) {
      ctx.err(`400 Parameter verification failed.\ntarget: target is local node.\n`)
      return 2
    }
    if (!nodeOnline(target)) {
      ctx.err(`500 Can't connect to ${target.ip}:8006 (No route to host)\nnode '${target.name}' seems to be offline\n`)
      return 2
    }
    if (ha) {
      ctx.out(`Requesting HA migration for ${cmd === 'qm' ? 'VM' : 'CT'} ${g.vmid} to node ${target.name}\n`)
      const res = haMove(c, ha, target, true)
      if ('error' in res) {
        ctx.err(res.error + '\n')
        return 2
      }
      return 0
    }
    const online = opts.has('online') || opts.has('restart')
    if (cmd === 'qm' && g.status === 'running' && !online) {
      ctx.err(`can't migrate running VM without --online\n`)
      return 255
    }
    if (cmd === 'qm' && g.status !== 'running' && online) ctx.out(`VM isn't running. Doing offline migration instead.\n`)
    const res = migrate(c, me, target, g, online && g.status === 'running', opts.has('with-local-disks'))
    if ('error' in res) {
      ctx.err(res.error + '\n')
      return 255
    }
    ctx.out(res.out)
    return 0
  }
}

// ---------------------------------------------------------------------------------------
// Verificaciones
// ---------------------------------------------------------------------------------------

export function verifyCluster(sys: System, check: object): { ok: boolean; label: string } | undefined {
  const pve = pveOf(sys)
  const c = pve?.cluster
  if ('pve_cluster' in check) {
    const k = check as { pve_cluster: string; nodos?: number; en_linea?: number; quorum?: boolean; qdevice?: boolean; votos_esperados?: number }
    let ok = !!c && c.name === k.pve_cluster
    const parts: string[] = []
    const me = c ? self(c, sys) : undefined
    if (c) haTick(c)
    if (ok && k.nodos !== undefined) {
      ok = c!.nodes.length === k.nodos
      parts.push(`con ${k.nodos} nodos`)
    }
    if (ok && k.en_linea !== undefined) {
      ok = c!.nodes.filter(nodeOnline).length === k.en_linea
      parts.push(`${k.en_linea} en línea`)
    }
    if (ok && k.quorum !== undefined) {
      ok = quorate(c!, me!) === k.quorum
      parts.push(k.quorum ? 'con quórum' : 'sin quórum')
    }
    if (ok && k.qdevice !== undefined) {
      ok = !!c!.qdevice === k.qdevice
      parts.push(k.qdevice ? 'con dispositivo de quórum' : 'sin dispositivo de quórum')
    }
    if (ok && k.votos_esperados !== undefined) {
      ok = expectedVotes(c!) === k.votos_esperados
      parts.push(`${k.votos_esperados} votos esperados`)
    }
    return { ok, label: `el nodo es parte del clúster ${k.pve_cluster}${parts.length ? ' ' + parts.join(', ') : ''}` }
  }
  if ('pve_ha' in check) {
    const k = check as { pve_ha: string; existe?: boolean; estado?: string; nodo?: string; regla?: string; mantenimiento?: string }
    if (c) haTick(c)
    const r = c?.ha.get(k.pve_ha)
    if (k.existe === false) return { ok: !r, label: `${k.pve_ha} no está bajo alta disponibilidad` }
    let ok = !!r
    const parts: string[] = []
    if (ok && k.estado) {
      ok = r!.status === k.estado
      parts.push(`en estado ${k.estado}`)
    }
    if (ok && k.nodo) {
      ok = r!.node === k.nodo
      parts.push(`en ${k.nodo}`)
    }
    if (ok && k.regla) {
      ok = !!c!.rules.find((x) => x.id === k.regla && x.resources.includes(k.pve_ha))
      parts.push(`con la regla ${k.regla}`)
    }
    return { ok, label: `${k.pve_ha} está bajo alta disponibilidad${parts.length ? ' ' + parts.join(', ') : ''}` }
  }
  if ('pve_mantenimiento' in check) {
    const k = check as { pve_mantenimiento: string; activo?: boolean }
    const on = !!c?.maintenance.has(k.pve_mantenimiento)
    const want = k.activo ?? true
    return { ok: on === want, label: `${k.pve_mantenimiento} ${want ? 'está' : 'no está'} en modo mantenimiento` }
  }
  if ('pve_encendido' in check) {
    const k = check as { pve_encendido: string; encendido?: boolean }
    const host = [sys, ...sys.lab].find((s) => s.hostname === k.pve_encendido)
    const want = k.encendido ?? true
    return { ok: !!host && host.poweredOff === !want, label: `${k.pve_encendido} está ${want ? 'prendido' : 'apagado'}` }
  }
  return undefined
}

/** Dónde está un invitado en el clúster (para la verificación pve_vm con nodo). */
export function guestNode(sys: System, vmid: number): string | undefined {
  const c = pveOf(sys)?.cluster
  if (!c) return pveOf(sys)?.guests.has(vmid) ? pveOf(sys)!.node : undefined
  haTick(c)
  return findGuest(c, vmid)?.node.name
}

export function clusterGuest(sys: System, vmid: number): PveGuest | undefined {
  const c = pveOf(sys)?.cluster
  return c ? findGuest(c, vmid)?.g : pveOf(sys)?.guests.get(vmid)
}

void guestName
