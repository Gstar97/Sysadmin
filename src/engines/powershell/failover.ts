/**
 * Clúster de conmutación por error de Windows Server (Failover Clustering) con Hyper-V: validar,
 * crear el clúster, el testigo (recurso compartido, nube o disco), los volúmenes compartidos
 * (CSV), las VM como roles del clúster, moverlas en vivo, drenar y pausar nodos, y lo que pasa
 * cuando un nodo se cae: sus VM vuelven a arrancar en otro, si sus archivos están en un CSV.
 *
 * El quórum sigue la mayoría de votos (nodos más testigo). Sin testigo, en dos nodos el quórum
 * dinámico le saca el voto a uno: si se cae ese, el clúster sigue; si se cae el otro, se cae todo.
 */
import { asArray, cmdlet, CMDLETS, PsError, type CmdletContext, type PsSession } from './session'
import { psObject, toText, VIEWS, type PsObject } from './values'
import { hyperVOf, readVhd, writeVhd, type HvVm } from './hyperv'
import { disks } from './verify-system'
import { shares } from './files'
import type { Lab } from './machine'
import { computerObject, type AdStore } from './ad'

interface FoCluster {
  name: string
  ip: string
  /** Nodos en orden de ID. */
  nodes: string[]
  down: Set<string>
  paused: Set<string>
  witness?: { type: 'FileShare' | 'Cloud' | 'Disk'; path: string }
  /** Discos del clúster: "Cluster Disk 1", y si es CSV, su carpeta. */
  disks: { name: string; numero: number; csv?: string }[]
  /** Roles de VM: el nombre de la VM y su dueño actual. */
  roles: Map<string, { owner: string; state: 'Online' | 'Offline' | 'Failed'; drainedFrom?: string }>
  log: string[]
}

const CLUSTERS = new WeakMap<Lab, FoCluster[]>()

const param = (ctx: CmdletContext, n: string) => ctx.params.get(n.toLowerCase())
const has = (ctx: CmdletContext, n: string) => ctx.params.has(n.toLowerCase())
const str = (ctx: CmdletContext, n: string) => (has(ctx, n) && param(ctx, n) !== null ? toText(param(ctx, n)) : undefined)
const names = (ctx: CmdletContext, n: string) => asArray(param(ctx, n)).flatMap((x) => toText(x).split(',')).map((x) => x.trim()).filter(Boolean)

function clusters(s: PsSession): FoCluster[] {
  const lab = s.lab!
  let l = CLUSTERS.get(lab)
  if (!l) CLUSTERS.set(lab, (l = []))
  return l
}

function node(s: PsSession, name: string): PsSession | undefined {
  return s.lab?.find(name)
}

function featureOn(s: PsSession, name: string) {
  return ((s.data.features ?? []) as PsObject[]).some((f) => toText(f.Name).toLowerCase() === name.toLowerCase() && f.Installed)
}

/** El clúster del que es parte este equipo. */
function myCluster(s: PsSession): FoCluster | undefined {
  return clusters(s).find((c) => c.nodes.some((n) => n.toLowerCase() === s.state.equipo.toLowerCase()))
}

function upNodes(c: FoCluster) {
  return c.nodes.filter((n) => !c.down.has(n))
}

function witnessUp(s: PsSession, c: FoCluster): boolean {
  if (!c.witness) return false
  if (c.witness.type !== 'FileShare') return true
  const m = /^\\\\([^\\]+)\\/.exec(c.witness.path)
  return !!m && !!node(s, m[1])
}

/** Votos que cuentan: nodos con voto que están arriba, más el testigo. */
function quorumState(s: PsSession, c: FoCluster): { votes: number; total: number; ok: boolean } {
  // Quórum dinámico: con dos nodos y sin testigo, el de ID más alto no vota.
  const voters = !c.witness && c.nodes.length === 2 ? [c.nodes[0]] : c.nodes
  const total = voters.length + (c.witness ? 1 : 0)
  const votes = voters.filter((n) => !c.down.has(n)).length + (witnessUp(s, c) ? 1 : 0)
  return { votes, total, ok: votes >= Math.floor(total / 2) + 1 }
}

function needCluster(ctx: CmdletContext, cmd: string): FoCluster {
  const name = str(ctx, 'Cluster') ?? str(ctx, 'InputObject')
  const c = name ? clusters(ctx.s).find((x) => x.name.toLowerCase() === name.toLowerCase()) : myCluster(ctx.s)
  if (!c) throw new PsError(`The cluster service is not running.  Make sure that the service is running on all nodes in the cluster.\n    There are no more endpoints available from the endpoint mapper`, 'ConnectionError', `ClusterCmdletNotAvailable,Microsoft.FailoverClusters.PowerShell.${cmd.replace('-', '')}Command`, ctx.s.state.equipo)
  if (c.down.has(ctx.s.state.equipo.toUpperCase()) || !quorumState(ctx.s, c).ok)
    throw new PsError(`Failed to connect to cluster '${c.name}'. The cluster service is not running because the cluster lost quorum.`, 'ConnectionError', `ClusterConnectionError,Microsoft.FailoverClusters.PowerShell.${cmd.replace('-', '')}Command`, c.name)
  return c
}

function vmOn(s: PsSession, nodeName: string, vm: string): HvVm | undefined {
  const n = node(s, nodeName)
  return n ? hyperVOf(n)?.vms.find((v) => v.name.toLowerCase() === vm.toLowerCase()) : undefined
}

function vmFiles(vm: HvVm): string[] {
  return [...vm.disks, vm.path].filter(Boolean)
}

function onCsv(vm: HvVm): boolean {
  return vmFiles(vm).every((p) => /^C:\\ClusterStorage\\/i.test(p))
}

/** Mueve una VM de un nodo a otro (los archivos en el CSV se ven desde los dos). */
function moveVm(s: PsSession, c: FoCluster, vmName: string, from: string, to: string, keepRunning: boolean): string | undefined {
  const src = node(s, from)
  const dst = node(s, to)
  const hs = src && hyperVOf(src)
  const hd = dst && hyperVOf(dst)
  if (!src || !dst || !hs || !hd) return `Node '${to}' is not reachable.`
  const vm = hs.vms.find((v) => v.name.toLowerCase() === vmName.toLowerCase())
  if (!vm) return `Virtual machine '${vmName}' was not found on node '${from}'.`
  for (const nic of vm.nics) if (nic.switchName && !hd.switches.some((x) => x.name.toLowerCase() === nic.switchName!.toLowerCase())) return `Live migration of '${vm.name}' failed.\nCould not find Ethernet switch '${nic.switchName}' on '${to}'. Every node needs a virtual switch with the same name.`
  if (!onCsv(vm)) return `Live migration of '${vm.name}' failed.\nThe virtual machine '${vm.name}' has files on local storage of '${from}' (${vmFiles(vm).find((p) => !/^C:\\ClusterStorage\\/i.test(p))}). Store them on a Cluster Shared Volume.`
  for (const p of vm.disks) {
    const meta = readVhd(src, p)
    if (meta && !dst.fs.get(p)) writeVhd(dst, p, meta, src.fs.get(p)?.size ?? 0)
  }
  hs.vms.splice(hs.vms.indexOf(vm), 1)
  hd.vms.push(vm)
  if (!keepRunning) vm.state = 'Off'
  const r = c.roles.get(vm.name.toLowerCase())
  if (r) r.owner = to
  return undefined
}

/** Un nodo dejó de estar: sus roles arrancan en otro (si hay quórum y los archivos están en el CSV). */
function failover(s: PsSession, c: FoCluster, down: string) {
  const q = quorumState(s, c)
  for (const [key, r] of c.roles) {
    if (r.owner !== down) continue
    if (!q.ok) {
      r.state = 'Offline'
      continue
    }
    const targets = upNodes(c).filter((n) => !c.paused.has(n))
    const load = (n: string) => [...c.roles.values()].filter((x) => x.owner === n).length
    const to = targets.sort((a, b) => load(a) - load(b))[0]
    const vm = vmOn(s, down, key)
    if (!to || !vm) {
      r.state = 'Failed'
      continue
    }
    const err = moveVm(s, c, vm.name, down, to, false)
    if (err) {
      r.state = 'Failed'
      c.log.push(err)
      continue
    }
    vm.state = 'Running'
    vm.startedAt = Date.now()
    r.state = 'Online'
  }
  if (!q.ok) for (const n of upNodes(c)) for (const vm of hyperVOf(node(s, n)!)?.vms ?? []) if (c.roles.has(vm.name.toLowerCase())) vm.state = 'Off'
}

// ---------------------------------------------------------------------------------------
// Vistas
// ---------------------------------------------------------------------------------------

const table = (cols: string[]) => ({ kind: 'table' as const, columns: cols.map((c) => ({ label: c, value: (o: PsObject) => o[c] })) })
VIEWS['Microsoft.FailoverClusters.PowerShell.Cluster'] = table(['Name'])
VIEWS['Microsoft.FailoverClusters.PowerShell.ClusterNode'] = table(['Name', 'State', 'Type'])
VIEWS['Microsoft.FailoverClusters.PowerShell.ClusterGroup'] = table(['Name', 'OwnerNode', 'State'])
VIEWS['Microsoft.FailoverClusters.PowerShell.ClusterResource'] = table(['Name', 'State', 'OwnerGroup', 'ResourceType'])
VIEWS['Microsoft.FailoverClusters.PowerShell.ClusterQuorumSettings'] = table(['Cluster', 'QuorumResource'])
VIEWS['Microsoft.FailoverClusters.PowerShell.ClusterSharedVolume'] = table(['Name', 'State', 'Node'])
VIEWS['Microsoft.FailoverClusters.PowerShell.ClusterDiskInfo'] = table(['Name', 'Number', 'Size'])

function nodeObj(c: FoCluster, n: string) {
  return psObject('Microsoft.FailoverClusters.PowerShell.ClusterNode', { Name: n, State: c.down.has(n) ? 'Down' : c.paused.has(n) ? 'Paused' : 'Up', Type: 'Node', Id: String(c.nodes.indexOf(n) + 1), Cluster: c.name, NodeWeight: !c.witness && c.nodes.length === 2 && c.nodes.indexOf(n) === 1 ? 0 : 1 })
}

function groupObjs(c: FoCluster): PsObject[] {
  const owner = upNodes(c)[0] ?? c.nodes[0]
  const out = [
    psObject('Microsoft.FailoverClusters.PowerShell.ClusterGroup', { Name: 'Available Storage', OwnerNode: owner, State: 'Online' }),
    psObject('Microsoft.FailoverClusters.PowerShell.ClusterGroup', { Name: 'Cluster Group', OwnerNode: owner, State: 'Online' }),
  ]
  for (const [, r] of c.roles) out.push(psObject('Microsoft.FailoverClusters.PowerShell.ClusterGroup', { Name: roleName(c, r), OwnerNode: r.owner, State: r.state, GroupType: 'VirtualMachine' }))
  return out
}

function roleName(c: FoCluster, r: { owner: string }): string {
  return [...c.roles.entries()].find(([, x]) => x === r)?.[0] ?? ''
}

// ---------------------------------------------------------------------------------------
// Cmdlets
// ---------------------------------------------------------------------------------------

const M = 'FailoverClusters'

cmdlet('Test-Cluster', {
  params: ['Node', 'Include', 'Ignore', 'ReportName'],
  switches: ['Force'],
  synopsis: 'Runs validation tests for failover cluster hardware and settings.',
  module: M,
  run(ctx) {
    const list = names(ctx, 'Node')
    const nodes = list.length ? list : [ctx.s.state.equipo]
    const problems: string[] = []
    const warnings: string[] = []
    const domain = ctx.s.state.dominio
    for (const n of nodes) {
      const t = node(ctx.s, n)
      if (!t) {
        problems.push(`Node '${n}' could not be reached (Inventory - List System Information).`)
        continue
      }
      if (!featureOn(t, 'Failover-Clustering')) problems.push(`The Failover Clustering feature is not installed on node '${t.state.equipo}' (System Configuration - Validate Required Services).`)
      if (!t.state.dominio || t.state.dominio !== domain) problems.push(`Node '${t.state.equipo}' is not a member of the domain '${domain ?? ''}' (System Configuration - Validate Active Directory Configuration).`)
      const sw = hyperVOf(t)?.switches.map((x) => x.name.toLowerCase()).sort().join(',')
      const sw0 = node(ctx.s, nodes[0]) && hyperVOf(node(ctx.s, nodes[0])!)?.switches.map((x) => x.name.toLowerCase()).sort().join(',')
      if (sw !== undefined && sw0 !== undefined && sw !== sw0) warnings.push(`Hyper-V Configuration - Validate Matching Virtual Switch Names: the virtual switches on '${t.state.equipo}' do not match the other nodes.`)
    }
    const shared = disks(node(ctx.s, nodes[0]) ?? ctx.s).filter((d) => d.bus === 'iSCSI' || d.bus === 'SAS')
    if (!shared.length) warnings.push('Storage - List Potential Cluster Disks: no disks were found that are visible from all nodes. You can create the cluster with -NoStorage and add storage later.')
    if (nodes.length === 2) warnings.push('Network - Validate Network Communication: nodes are connected by a single network path. A redundant path (a second network or a NIC team) is recommended.')
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' At ').replace(/-/g, '.').replace(':', '.')
    for (const w of warnings) ctx.host(`WARNING: ${w}\n`)
    for (const p of problems) ctx.host(`WARNING: ${p}\n`)
    ctx.host(`WARNING: Test Result:\n${problems.length ? 'Failed' : warnings.length ? 'ClusterConditionallyApproved' : 'ClusterApproved'}\nTesting has completed for the tests you selected. ${problems.length ? 'Testing found problems that must be fixed before you create the cluster.' : 'You should review the warnings in the Report.'}\n`)
    return [psObject('System.IO.FileInfo', { Mode: '-a----', LastWriteTime: new Date().toLocaleString('en-US'), Length: 412337, Name: `Validation Report ${stamp}.htm` })]
  },
})

cmdlet('New-Cluster', {
  params: ['Name', 'Node', 'StaticAddress', 'IgnoreNetwork', 'AdministrativeAccessPoint'],
  switches: ['NoStorage', 'Force'],
  positional: ['Name'],
  synopsis: 'Creates a new failover cluster.',
  module: M,
  run(ctx) {
    const name = str(ctx, 'Name')!
    const list = names(ctx, 'Node').map((n) => node(ctx.s, n)?.state.equipo ?? n.toUpperCase())
    const nodes = list.length ? list : [ctx.s.state.equipo]
    const ip = str(ctx, 'StaticAddress')
    for (const n of nodes) {
      const t = node(ctx.s, n)
      if (!t) throw new PsError(`An error occurred while creating the cluster.\nThe node '${n}' could not be reached.`, 'ConnectionError', 'CreateClusterFailed,Microsoft.FailoverClusters.PowerShell.NewClusterCommand', n)
      if (!featureOn(t, 'Failover-Clustering')) throw new PsError(`An error occurred while creating the cluster.\nThe Failover Clustering feature is not installed on node '${t.state.equipo}'.`, 'InvalidOperation', 'CreateClusterFailed,Microsoft.FailoverClusters.PowerShell.NewClusterCommand', n)
      if (!t.state.dominio) throw new PsError(`An error occurred while creating the cluster.\nNode '${t.state.equipo}' is not joined to a domain. All nodes must be members of the same Active Directory domain.`, 'InvalidOperation', 'CreateClusterFailed,Microsoft.FailoverClusters.PowerShell.NewClusterCommand', n)
      if (myCluster(t)) throw new PsError(`An error occurred while creating the cluster.\nNode '${t.state.equipo}' is already part of a cluster.`, 'InvalidOperation', 'CreateClusterFailed,Microsoft.FailoverClusters.PowerShell.NewClusterCommand', n)
    }
    if (!ip) ctx.host('WARNING: No static address was given: the cluster name will take an address from DHCP.\n')
    const c: FoCluster = { name: name.toUpperCase(), ip: ip ?? '192.168.10.200', nodes, down: new Set(), paused: new Set(), disks: [], roles: new Map(), log: [] }
    if (!has(ctx, 'NoStorage')) {
      const shared = disks(node(ctx.s, nodes[0])!).filter((d) => d.bus === 'iSCSI')
      shared.forEach((d, i) => c.disks.push({ name: `Cluster Disk ${i + 1}`, numero: d.numero }))
    }
    clusters(ctx.s).push(c)
    // El objeto de equipo del clúster (CNO) en Active Directory.
    const ad = ctx.s.state.dominio ? (ctx.s.lab!.adStores.get(ctx.s.state.dominio.toLowerCase()) as AdStore | undefined) : undefined
    if (ad && !ad.computers.some((x) => toText(x.Name).toLowerCase() === c.name.toLowerCase())) ad.computers.push(computerObject(ad, c.name, `CN=Computers,${ad.domainDn}`, ''))
    if (nodes.length === 2) ctx.host(`WARNING: There were issues while creating the clustered role that may prevent it from starting. For more information view the report file below.\nWARNING: Report file location: C:\\Windows\\cluster\\Reports\\Create Cluster Wizard ${c.name} on ${new Date().toISOString().slice(0, 10)}.htm\n[simulador] El aviso es por el quórum: un clúster de dos nodos necesita un testigo (Set-ClusterQuorum).\n`)
    return [psObject('Microsoft.FailoverClusters.PowerShell.Cluster', { Name: c.name })]
  },
})

cmdlet('Get-Cluster', {
  params: ['Name', 'Domain'],
  positional: ['Name'],
  synopsis: 'Gets information about one or more failover clusters.',
  module: M,
  run(ctx) {
    const c = needCluster(ctx, 'Get-Cluster')
    return [psObject('Microsoft.FailoverClusters.PowerShell.Cluster', { Name: c.name, Domain: ctx.s.state.dominio ?? '', DynamicQuorum: 1, WitnessDynamicWeight: c.witness ? 1 : 0 })]
  },
})

cmdlet('Get-ClusterNode', {
  params: ['Name', 'Cluster'],
  positional: ['Name'],
  synopsis: 'Gets information about one or more nodes, or servers, in a failover cluster.',
  module: M,
  run(ctx) {
    const c = needCluster(ctx, 'Get-ClusterNode')
    const want = names(ctx, 'Name').map((x) => x.toUpperCase())
    return c.nodes.filter((n) => !want.length || want.includes(n.toUpperCase())).map((n) => nodeObj(c, n))
  },
})

cmdlet('Get-ClusterQuorum', {
  params: ['Cluster'],
  synopsis: 'Gets information about quorum for a failover cluster.',
  module: M,
  run(ctx) {
    const c = needCluster(ctx, 'Get-ClusterQuorum')
    const res = c.witness ? { FileShare: 'File Share Witness', Cloud: 'Cloud Witness', Disk: c.witness.path }[c.witness.type] : ''
    return [psObject('Microsoft.FailoverClusters.PowerShell.ClusterQuorumSettings', { Cluster: c.name, QuorumResource: res, QuorumType: c.witness ? { FileShare: 'NodeAndFileShareMajority', Cloud: 'NodeAndCloudMajority', Disk: 'NodeAndDiskMajority' }[c.witness.type] : 'NodeMajority' })]
  },
})

cmdlet('Set-ClusterQuorum', {
  params: ['Cluster', 'FileShareWitness', 'DiskWitness', 'AccountName', 'AccessKey', 'Endpoint'],
  switches: ['NodeMajority', 'CloudWitness', 'NoWitness'],
  synopsis: 'Configures quorum options for a failover cluster.',
  module: M,
  run(ctx) {
    const c = needCluster(ctx, 'Set-ClusterQuorum')
    if (has(ctx, 'NodeMajority') || has(ctx, 'NoWitness')) {
      c.witness = undefined
    } else if (has(ctx, 'FileShareWitness')) {
      const path = str(ctx, 'FileShareWitness')!
      const m = /^\\\\([^\\]+)\\(.+)$/.exec(path)
      const srv = m && node(ctx.s, m[1])
      if (!m || !srv || !shares(srv).some((x) => x.name.toLowerCase() === m[2].toLowerCase()))
        throw new PsError(`There was an error configuring the file share witness '${path}'.\nUnable to save property changes for 'File Share Witness'.\nThe network name cannot be found.`, 'InvalidArgument', 'ClusterWitnessFailed,Microsoft.FailoverClusters.PowerShell.SetClusterQuorumCommand', path)
      if (c.nodes.some((n) => n.toLowerCase() === m[1].toLowerCase())) throw new PsError(`The file share witness cannot be hosted on a node of the same cluster.`, 'InvalidArgument', 'ClusterWitnessFailed,Microsoft.FailoverClusters.PowerShell.SetClusterQuorumCommand', path)
      c.witness = { type: 'FileShare', path }
    } else if (has(ctx, 'CloudWitness')) {
      if (!str(ctx, 'AccountName') || !str(ctx, 'AccessKey')) throw new PsError(`Cannot validate argument on parameter 'AccountName'. The argument is null or empty.`, 'InvalidData', 'ParameterArgumentValidationError,Microsoft.FailoverClusters.PowerShell.SetClusterQuorumCommand', '')
      c.witness = { type: 'Cloud', path: `https://${str(ctx, 'AccountName')}.blob.core.windows.net` }
    } else if (has(ctx, 'DiskWitness')) {
      const d = c.disks.find((x) => x.name.toLowerCase() === str(ctx, 'DiskWitness')!.toLowerCase())
      if (!d) throw new PsError(`The cluster resource '${str(ctx, 'DiskWitness')}' could not be found.`, 'ObjectNotFound', 'ClusterObjectNotFound,Microsoft.FailoverClusters.PowerShell.SetClusterQuorumCommand', str(ctx, 'DiskWitness'))
      if (d.csv) throw new PsError(`A Cluster Shared Volume cannot be used as the disk witness.`, 'InvalidOperation', 'ClusterWitnessFailed,Microsoft.FailoverClusters.PowerShell.SetClusterQuorumCommand', d.name)
      c.witness = { type: 'Disk', path: d.name }
    }
    const res = c.witness ? { FileShare: 'File Share Witness', Cloud: 'Cloud Witness', Disk: c.witness.path }[c.witness.type] : ''
    return [psObject('Microsoft.FailoverClusters.PowerShell.ClusterQuorumSettings', { Cluster: c.name, QuorumResource: res })]
  },
})

cmdlet('Get-ClusterAvailableDisk', {
  params: ['Cluster'],
  synopsis: 'Gets information about the disks that can support failover clustering and are visible to all nodes, but are not yet part of the set of clustered disks.',
  module: M,
  run(ctx) {
    const c = needCluster(ctx, 'Get-ClusterAvailableDisk')
    const all = c.nodes.map((n) => disks(node(ctx.s, n)!).filter((d) => d.bus === 'iSCSI'))
    return all[0].filter((d) => all.every((l) => l.some((x) => x.numero === d.numero)) && !c.disks.some((x) => x.numero === d.numero)).map((d) => psObject('Microsoft.FailoverClusters.PowerShell.ClusterDiskInfo', { Name: `Cluster Disk ${c.disks.length + 1}`, Number: d.numero, Size: `${d.tamano_gb} GB`, Cluster: c.name }))
  },
})

cmdlet('Add-ClusterDisk', {
  params: ['InputObject', 'Cluster'],
  synopsis: 'Makes a new disk available for use in a failover cluster.',
  module: M,
  run(ctx) {
    const c = needCluster(ctx, 'Add-ClusterDisk')
    const items = [...ctx.input, ...asArray(param(ctx, 'InputObject'))].filter((x) => (x as PsObject)?.Number !== undefined) as PsObject[]
    return items.map((d) => {
      const name = `Cluster Disk ${c.disks.length + 1}`
      c.disks.push({ name, numero: Number(d.Number) })
      return psObject('Microsoft.FailoverClusters.PowerShell.ClusterResource', { Name: name, State: 'Online', OwnerGroup: 'Available Storage', ResourceType: 'Physical Disk' })
    })
  },
})

cmdlet('Get-ClusterResource', {
  params: ['Name', 'Cluster'],
  positional: ['Name'],
  synopsis: 'Gets information about one or more resources in a failover cluster.',
  module: M,
  run(ctx) {
    const c = needCluster(ctx, 'Get-ClusterResource')
    const out: PsObject[] = [
      psObject('Microsoft.FailoverClusters.PowerShell.ClusterResource', { Name: 'Cluster IP Address', State: 'Online', OwnerGroup: 'Cluster Group', ResourceType: 'IP Address' }),
      psObject('Microsoft.FailoverClusters.PowerShell.ClusterResource', { Name: 'Cluster Name', State: 'Online', OwnerGroup: 'Cluster Group', ResourceType: 'Network Name' }),
    ]
    if (c.witness) out.push(psObject('Microsoft.FailoverClusters.PowerShell.ClusterResource', { Name: c.witness.type === 'Disk' ? c.witness.path : c.witness.type === 'Cloud' ? 'Cloud Witness' : 'File Share Witness', State: witnessUp(ctx.s, c) ? 'Online' : 'Failed', OwnerGroup: 'Cluster Group', ResourceType: c.witness.type === 'Disk' ? 'Physical Disk' : c.witness.type === 'Cloud' ? 'Cloud Witness' : 'File Share Witness' }))
    for (const d of c.disks.filter((x) => !x.csv && c.witness?.path !== x.name)) out.push(psObject('Microsoft.FailoverClusters.PowerShell.ClusterResource', { Name: d.name, State: 'Online', OwnerGroup: 'Available Storage', ResourceType: 'Physical Disk' }))
    for (const [k, r] of c.roles) {
      out.push(psObject('Microsoft.FailoverClusters.PowerShell.ClusterResource', { Name: `Virtual Machine ${k}`, State: r.state, OwnerGroup: k, ResourceType: 'Virtual Machine' }))
      out.push(psObject('Microsoft.FailoverClusters.PowerShell.ClusterResource', { Name: `Virtual Machine Configuration ${k}`, State: r.state === 'Failed' ? 'Failed' : 'Online', OwnerGroup: k, ResourceType: 'Virtual Machine Configuration' }))
    }
    const want = names(ctx, 'Name').map((x) => x.toLowerCase())
    return out.filter((o) => !want.length || want.includes(toText(o.Name).toLowerCase()))
  },
})

cmdlet('Get-ClusterSharedVolume', {
  params: ['Name', 'Cluster'],
  synopsis: 'Gets information about Cluster Shared Volumes in a failover cluster.',
  module: M,
  run(ctx) {
    const c = needCluster(ctx, 'Get-ClusterSharedVolume')
    return c.disks.filter((d) => d.csv).map((d) => psObject('Microsoft.FailoverClusters.PowerShell.ClusterSharedVolume', { Name: d.name, State: 'Online', Node: upNodes(c)[0], SharedVolumeInfo: d.csv }))
  },
})

cmdlet('Add-ClusterSharedVolume', {
  params: ['Name', 'InputObject', 'Cluster'],
  positional: ['Name'],
  synopsis: 'Makes a volume available in Cluster Shared Volumes in a failover cluster.',
  module: M,
  run(ctx) {
    const c = needCluster(ctx, 'Add-ClusterSharedVolume')
    const name = str(ctx, 'Name') ?? toText((ctx.input[0] as PsObject | undefined)?.Name)
    const d = c.disks.find((x) => x.name.toLowerCase() === (name ?? '').toLowerCase())
    if (!d) throw new PsError(`The cluster resource '${name}' could not be found.`, 'ObjectNotFound', 'ClusterObjectNotFound,Microsoft.FailoverClusters.PowerShell.AddClusterSharedVolumeCommand', name)
    if (c.witness?.type === 'Disk' && c.witness.path === d.name) throw new PsError(`The disk '${d.name}' is the witness disk and cannot be added to Cluster Shared Volumes.`, 'InvalidOperation', 'AddClusterSharedVolumeFailed,Microsoft.FailoverClusters.PowerShell.AddClusterSharedVolumeCommand', d.name)
    if (!d.csv) d.csv = `C:\\ClusterStorage\\Volume${c.disks.filter((x) => x.csv).length + 1}`
    for (const n of c.nodes) node(ctx.s, n)?.fs.mkdirp(d.csv)
    return [psObject('Microsoft.FailoverClusters.PowerShell.ClusterSharedVolume', { Name: d.name, State: 'Online', Node: upNodes(c)[0] })]
  },
})

cmdlet('Add-ClusterVirtualMachineRole', {
  params: ['VMName', 'Name', 'Cluster', 'VirtualMachine'],
  positional: ['VMName'],
  synopsis: 'Creates a clustered virtual machine, that is, a virtual machine that can be failed over if necessary to a different server in the failover cluster.',
  module: M,
  run(ctx) {
    const c = needCluster(ctx, 'Add-ClusterVirtualMachineRole')
    const vmName = str(ctx, 'VMName') ?? toText((ctx.input[0] as PsObject | undefined)?.Name)
    const owner = c.nodes.find((n) => vmOn(ctx.s, n, vmName))
    if (!owner) throw new PsError(`No virtual machine named '${vmName}' was found on the nodes of cluster '${c.name}'.`, 'ObjectNotFound', 'ClusterObjectNotFound,Microsoft.FailoverClusters.PowerShell.AddClusterVirtualMachineRoleCommand', vmName)
    const vm = vmOn(ctx.s, owner, vmName)!
    if (!onCsv(vm)) ctx.host(`WARNING: The virtual machine '${vm.name}' has files on local storage (${vmFiles(vm).find((p) => !/^C:\\ClusterStorage\\/i.test(p))}). It will not be able to fail over to another node until they are moved to a Cluster Shared Volume (Move-VMStorage).\n`)
    c.roles.set(vm.name.toLowerCase(), { owner, state: vm.state === 'Running' ? 'Online' : 'Offline' })
    return [psObject('Microsoft.FailoverClusters.PowerShell.ClusterGroup', { Name: vm.name, OwnerNode: owner, State: vm.state === 'Running' ? 'Online' : 'Offline' })]
  },
})

cmdlet('Get-ClusterGroup', {
  params: ['Name', 'Cluster'],
  positional: ['Name'],
  synopsis: 'Gets information about one or more clustered roles (resource groups) in a failover cluster.',
  module: M,
  run(ctx) {
    const c = needCluster(ctx, 'Get-ClusterGroup')
    const want = names(ctx, 'Name').map((x) => x.toLowerCase())
    return groupObjs(c).filter((o) => !want.length || want.includes(toText(o.Name).toLowerCase()))
  },
})

cmdlet('Move-ClusterVirtualMachineRole', {
  params: ['Name', 'Node', 'MigrationType', 'Cluster', 'InputObject'],
  positional: ['Name', 'Node'],
  synopsis: 'Moves the ownership of a clustered virtual machine to a different node.',
  module: M,
  run(ctx) {
    const c = needCluster(ctx, 'Move-ClusterVirtualMachineRole')
    const name = (str(ctx, 'Name') ?? toText((ctx.input[0] as PsObject | undefined)?.Name)).toLowerCase()
    const r = c.roles.get(name)
    if (!r) throw new PsError(`The cluster group '${name}' could not be found.`, 'ObjectNotFound', 'ClusterObjectNotFound,Microsoft.FailoverClusters.PowerShell.MoveClusterVirtualMachineRoleCommand', name)
    const to = c.nodes.find((n) => n.toLowerCase() === (str(ctx, 'Node') ?? '').toLowerCase()) ?? upNodes(c).find((n) => n !== r.owner)
    if (!to || c.down.has(to)) throw new PsError(`The node '${str(ctx, 'Node') ?? ''}' is not up.`, 'InvalidOperation', 'MoveClusterGroupFailed,Microsoft.FailoverClusters.PowerShell.MoveClusterVirtualMachineRoleCommand', to)
    const type = str(ctx, 'MigrationType') ?? 'Live'
    const vm = vmOn(ctx.s, r.owner, name)
    const running = vm?.state === 'Running'
    const err = moveVm(ctx.s, c, name, r.owner, to, true)
    if (err) throw new PsError(err, 'InvalidOperation', 'MoveClusterGroupFailed,Microsoft.FailoverClusters.PowerShell.MoveClusterVirtualMachineRoleCommand', name)
    if (running && /^quick$/i.test(type)) ctx.host('[simulador] Quick: la VM se guarda (Saved), se pasa y se restaura; los usuarios notan un corte de unos segundos. Live no corta.\n')
    return [psObject('Microsoft.FailoverClusters.PowerShell.ClusterGroup', { Name: vm?.name ?? name, OwnerNode: to, State: r.state })]
  },
})

cmdlet('Suspend-ClusterNode', {
  params: ['Name', 'Cluster', 'ForceDrain'],
  switches: ['Drain', 'Wait'],
  positional: ['Name'],
  synopsis: 'Suspends activity on a failover cluster node, that is, pauses the node.',
  module: M,
  run(ctx) {
    const c = needCluster(ctx, 'Suspend-ClusterNode')
    const n = c.nodes.find((x) => x.toLowerCase() === (str(ctx, 'Name') ?? ctx.s.state.equipo).toLowerCase())
    if (!n) throw new PsError(`The cluster node '${str(ctx, 'Name')}' was not found.`, 'ObjectNotFound', 'ClusterObjectNotFound,Microsoft.FailoverClusters.PowerShell.SuspendClusterNodeCommand', str(ctx, 'Name'))
    c.paused.add(n)
    if (has(ctx, 'Drain')) {
      for (const [k, r] of c.roles) {
        if (r.owner !== n) continue
        const to = upNodes(c).filter((x) => !c.paused.has(x))[0]
        if (!to) continue
        const err = moveVm(ctx.s, c, k, n, to, true)
        if (err) {
          ctx.writeError(err, 'InvalidOperation', k)
          continue
        }
        r.drainedFrom = n
      }
    }
    return [nodeObj(c, n)]
  },
})

cmdlet('Resume-ClusterNode', {
  params: ['Name', 'Cluster', 'Failback'],
  positional: ['Name'],
  synopsis: 'Resumes activity on a failover cluster node after you have suspended it (that is, paused it).',
  module: M,
  run(ctx) {
    const c = needCluster(ctx, 'Resume-ClusterNode')
    const n = c.nodes.find((x) => x.toLowerCase() === (str(ctx, 'Name') ?? ctx.s.state.equipo).toLowerCase())
    if (!n) throw new PsError(`The cluster node '${str(ctx, 'Name')}' was not found.`, 'ObjectNotFound', 'ClusterObjectNotFound,Microsoft.FailoverClusters.PowerShell.ResumeClusterNodeCommand', str(ctx, 'Name'))
    c.paused.delete(n)
    if (/^immediate$/i.test(str(ctx, 'Failback') ?? '')) {
      for (const [k, r] of c.roles) if (r.drainedFrom === n && !moveVm(ctx.s, c, k, r.owner, n, true)) r.drainedFrom = undefined
    }
    return [nodeObj(c, n)]
  },
})

for (const verb of ['Stop-ClusterNode', 'Start-ClusterNode']) {
  cmdlet(verb, {
    params: ['Name', 'Cluster'],
    positional: ['Name'],
    synopsis: verb === 'Stop-ClusterNode' ? 'Stops the Cluster service on a node in a failover cluster.' : 'Starts the Cluster service on a node in a failover cluster.',
    module: M,
    run(ctx) {
      const name = str(ctx, 'Name') ?? ctx.s.state.equipo
      const c = myCluster(ctx.s) ?? needCluster(ctx, verb)
      const n = c.nodes.find((x) => x.toLowerCase() === name.toLowerCase())
      if (!n) throw new PsError(`The cluster node '${name}' was not found.`, 'ObjectNotFound', `ClusterObjectNotFound,Microsoft.FailoverClusters.PowerShell.${verb.replace('-', '')}Command`, name)
      if (verb === 'Stop-ClusterNode') {
        c.down.add(n)
        failover(ctx.s, c, n)
      } else {
        c.down.delete(n)
        if (quorumState(ctx.s, c).ok) for (const [k, r] of c.roles) if (r.state !== 'Online') {
          const vm = vmOn(ctx.s, r.owner, k)
          if (vm) {
            vm.state = 'Running'
            r.state = 'Online'
          }
        }
      }
      return [nodeObj(c, n)]
    },
  })
}

// Stop-Computer -ComputerName a un nodo de un clúster: se apaga y sus roles pasan a otro.
{
  const def = CMDLETS.get('stop-computer')!
  const run = def.run
  def.run = (ctx) => {
    const targets = asArray(ctx.params.get('computername')).map(toText)
    const done: string[] = []
    for (const t of targets) {
      const s = node(ctx.s, t)
      const c = s && myCluster(s)
      if (!s || !c || s === ctx.s) continue
      const n = c.nodes.find((x) => x.toLowerCase() === s.state.equipo.toLowerCase())!
      c.down.add(n)
      failover(ctx.s, c, n)
      done.push(t)
      ctx.host(`[simulador] ${s.state.equipo} se apagó. El clúster lo nota en unos segundos y pasa sus roles a otro nodo.\n`)
    }
    if (done.length && done.length === targets.length) return []
    return run(ctx)
  }
}

// ---------------------------------------------------------------------------------------
// Verificaciones
// ---------------------------------------------------------------------------------------

export function verifyFailover(s: PsSession, check: Record<string, unknown>): { ok: boolean; label: string } | undefined {
  if ('cluster_win' in check) {
    const k = check as { cluster_win: string; nodos?: number; testigo?: string; quorum?: boolean; csv?: number }
    const c = clusters(s).find((x) => x.name.toLowerCase() === k.cluster_win.toLowerCase())
    let ok = !!c
    const parts: string[] = []
    if (ok && k.nodos !== undefined) {
      ok = c!.nodes.length === k.nodos
      parts.push(`con ${k.nodos} nodos`)
    }
    if (ok && k.testigo) {
      ok = (c!.witness?.type ?? 'Ninguno') === k.testigo
      parts.push(k.testigo === 'Ninguno' ? 'sin testigo' : `con testigo ${k.testigo}`)
    }
    if (ok && k.quorum !== undefined) {
      ok = quorumState(s, c!).ok === k.quorum
      parts.push(k.quorum ? 'con quórum' : 'sin quórum')
    }
    if (ok && k.csv !== undefined) {
      ok = c!.disks.filter((d) => d.csv).length === k.csv
      parts.push(`${k.csv} volúmenes compartidos (CSV)`)
    }
    return { ok, label: `existe el clúster ${k.cluster_win}${parts.length ? ' ' + parts.join(', ') : ''}` }
  }
  if ('rol_cluster' in check) {
    const k = check as { rol_cluster: string; propietario?: string; estado?: string }
    const c = clusters(s).find((x) => x.roles.has(k.rol_cluster.toLowerCase()))
    const r = c?.roles.get(k.rol_cluster.toLowerCase())
    let ok = !!r
    const parts: string[] = []
    if (ok && k.propietario) {
      ok = r!.owner.toLowerCase() === k.propietario.toLowerCase()
      parts.push(`en ${k.propietario}`)
    }
    if (ok && k.estado) {
      ok = r!.state === k.estado
      parts.push(k.estado)
    }
    return { ok, label: `${k.rol_cluster} es un rol del clúster${parts.length ? ' ' + parts.join(', ') : ''}` }
  }
  if ('nodo_cluster' in check) {
    const k = check as { nodo_cluster: string; estado: string }
    const c = clusters(s).find((x) => x.nodes.some((n) => n.toLowerCase() === k.nodo_cluster.toLowerCase()))
    const n = c?.nodes.find((x) => x.toLowerCase() === k.nodo_cluster.toLowerCase())
    const st = c && n ? (c.down.has(n) ? 'Down' : c.paused.has(n) ? 'Paused' : 'Up') : undefined
    return { ok: st === k.estado, label: `el nodo ${k.nodo_cluster} está ${k.estado}` }
  }
  return undefined
}
