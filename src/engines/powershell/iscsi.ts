/**
 * Iniciador iSCSI de Windows: el servicio MSiSCSI, los portales, los destinos, la conexión
 * persistente y los discos que aparecen (desconectados, por la política de SAN de Windows Server,
 * hasta que se ponen en línea). Los destinos se definen en el ejercicio (iscsi.portales).
 */
import { asArray, cmdlet, PsError, type CmdletContext, type PsSession } from './session'
import { psObject, toText, VIEWS, type PsObject } from './values'
import { disks } from './verify-system'

interface PortalState {
  ip: string
  destinos: { iqn: string; luns_gb: number[]; permitidos?: string[] }[]
}

interface Conn {
  iqn: string
  portal: string
  persistent: boolean
  disks: number[]
}

const has = (ctx: CmdletContext, n: string) => ctx.params.has(n.toLowerCase())
const str = (ctx: CmdletContext, n: string) => (has(ctx, n) && ctx.params.get(n.toLowerCase()) !== null ? toText(ctx.params.get(n.toLowerCase())) : undefined)

function svcRunning(s: PsSession) {
  return ((s.data.services ?? []) as PsObject[]).some((x) => toText(x.Name).toLowerCase() === 'msiscsi' && x.Status === 'Running')
}

export function initiatorIqn(s: PsSession) {
  return `iqn.1991-05.com.microsoft:${s.state.equipo.toLowerCase()}${s.state.dominio ? '.' + s.state.dominio.toLowerCase() : ''}`
}

function available(s: PsSession): PortalState[] {
  return ((s.state as { iscsi?: { portales: PortalState[] } }).iscsi?.portales ?? []) as PortalState[]
}

function portals(s: PsSession): string[] {
  return ((s.data.iscsiPortals ??= []) as string[])
}

function conns(s: PsSession): Conn[] {
  return ((s.data.iscsiConns ??= []) as Conn[])
}

function needService(ctx: CmdletContext, cmd: string) {
  if (!svcRunning(ctx.s)) throw new PsError(`The Microsoft iSCSI initiator service has not been started.`, 'NotSpecified', `HRESULT 0x80070426,Microsoft.Management.Infrastructure.CimCmdlets.${cmd}`, '')
}

VIEWS['MSFT_iSCSITargetPortal'] = { kind: 'list', columns: ['InitiatorInstanceName', 'InitiatorPortalAddress', 'IsDataDigest', 'IsHeaderDigest', 'TargetPortalAddress', 'TargetPortalPortNumber', 'PSComputerName'].map((c) => ({ label: c, value: (o: PsObject) => o[c] })) }
VIEWS['MSFT_iSCSITarget'] = { kind: 'list', columns: ['IsConnected', 'NodeAddress', 'PSComputerName'].map((c) => ({ label: c, value: (o: PsObject) => o[c] })) }
VIEWS['MSFT_iSCSISession'] = { kind: 'list', columns: ['AuthenticationType', 'InitiatorNodeAddress', 'IsConnected', 'IsPersistent', 'NumberOfConnections', 'SessionIdentifier', 'TargetNodeAddress'].map((c) => ({ label: c, value: (o: PsObject) => o[c] })) }
VIEWS['MSFT_InitiatorPort'] = { kind: 'table', columns: ['InstanceName', 'NodeAddress', 'PortAddress', 'ConnectionType'].map((c) => ({ label: c, value: (o: PsObject) => o[c] })) }

cmdlet('Get-InitiatorPort', {
  synopsis: 'Gets one or more host bus adapter (HBA) initiator ports.',
  module: 'Storage',
  run(ctx) {
    return [psObject('MSFT_InitiatorPort', { InstanceName: 'ROOT\\ISCSIPRT\\0000_0', NodeAddress: initiatorIqn(ctx.s), PortAddress: 'ISCSI ANY PORT', ConnectionType: 'iSCSI' })]
  },
})

cmdlet('New-IscsiTargetPortal', {
  params: ['TargetPortalAddress', 'TargetPortalPortNumber'],
  positional: ['TargetPortalAddress'],
  synopsis: 'Configures an iSCSI target portal.',
  module: 'iSCSI',
  run(ctx) {
    needService(ctx, 'NewIscsiTargetPortal')
    const ip = str(ctx, 'TargetPortalAddress') ?? ''
    if (!available(ctx.s).some((p) => p.ip === ip)) throw new PsError(`A connection to the target was lost, but Initiator successfully reconnected to the target.\nThe target name is not found or is marked as hidden from login.`, 'NotSpecified', 'HRESULT 0xefff0003,New-IscsiTargetPortal', ip)
    if (!portals(ctx.s).includes(ip)) portals(ctx.s).push(ip)
    return [psObject('MSFT_iSCSITargetPortal', { InitiatorInstanceName: '', InitiatorPortalAddress: '', IsDataDigest: false, IsHeaderDigest: false, TargetPortalAddress: ip, TargetPortalPortNumber: 3260, PSComputerName: '' })]
  },
})

cmdlet('Get-IscsiTargetPortal', {
  synopsis: 'Gets iSCSI target portals.',
  module: 'iSCSI',
  run(ctx) {
    needService(ctx, 'GetIscsiTargetPortal')
    return portals(ctx.s).map((ip) => psObject('MSFT_iSCSITargetPortal', { InitiatorInstanceName: '', InitiatorPortalAddress: '', IsDataDigest: false, IsHeaderDigest: false, TargetPortalAddress: ip, TargetPortalPortNumber: 3260, PSComputerName: '' }))
  },
})

cmdlet('Get-IscsiTarget', {
  params: ['NodeAddress'],
  synopsis: 'Gets iSCSI targets.',
  module: 'iSCSI',
  run(ctx) {
    needService(ctx, 'GetIscsiTarget')
    return available(ctx.s)
      .filter((p) => portals(ctx.s).includes(p.ip))
      .flatMap((p) => p.destinos.map((d) => psObject('MSFT_iSCSITarget', { IsConnected: conns(ctx.s).some((c) => c.iqn === d.iqn), NodeAddress: d.iqn, PSComputerName: '' })))
  },
})

cmdlet('Connect-IscsiTarget', {
  params: ['NodeAddress', 'IsPersistent', 'TargetPortalAddress', 'AuthenticationType', 'ChapUsername', 'ChapSecret', 'InputObject'],
  switches: ['IsMultipathEnabled'],
  synopsis: 'Establishes a connection between the local iSCSI initiator and an iSCSI target device.',
  module: 'iSCSI',
  run(ctx) {
    needService(ctx, 'ConnectIscsiTarget')
    const fromPipe = ctx.input.find((x) => (x as PsObject)?.NodeAddress) as PsObject | undefined
    const iqn = str(ctx, 'NodeAddress') ?? toText(fromPipe?.NodeAddress)
    const p = available(ctx.s).find((x) => portals(ctx.s).includes(x.ip) && x.destinos.some((d) => d.iqn === iqn))
    const d = p?.destinos.find((x) => x.iqn === iqn)
    if (!p || !d) throw new PsError(`The target name is not found or is marked as hidden from login.`, 'NotSpecified', 'HRESULT 0xefff0003,Connect-IscsiTarget', iqn)
    if (d.permitidos && !d.permitidos.includes(initiatorIqn(ctx.s))) throw new PsError(`Authorization Failure.`, 'NotSpecified', 'HRESULT 0xefff0012,Connect-IscsiTarget', iqn)
    if (conns(ctx.s).some((c) => c.iqn === iqn)) throw new PsError(`The target has already been logged in via an iSCSI session.`, 'NotSpecified', 'HRESULT 0xefff003f,Connect-IscsiTarget', iqn)
    const list = disks(ctx.s)
    const nums: number[] = []
    for (const gb of d.luns_gb) {
      const numero = Math.max(0, ...list.map((x) => x.numero)) + 1
      list.push({ numero, tamano_gb: gb, modelo: 'LIO-ORG lun', estilo: 'RAW', offline: true, bus: 'iSCSI', particiones: [] } as (typeof list)[number])
      nums.push(numero)
    }
    const persistent = /^(\$?true|1)$/i.test(str(ctx, 'IsPersistent') ?? 'false')
    conns(ctx.s).push({ iqn, portal: p.ip, persistent, disks: nums })
    return [psObject('MSFT_iSCSISession', { AuthenticationType: 'NONE', InitiatorNodeAddress: initiatorIqn(ctx.s), IsConnected: true, IsPersistent: persistent, NumberOfConnections: 1, SessionIdentifier: `ffffa30e1f0e7010-400001370000000${conns(ctx.s).length}`, TargetNodeAddress: iqn })]
  },
})

cmdlet('Get-IscsiSession', {
  synopsis: 'Gets information about established iSCSI sessions.',
  module: 'iSCSI',
  run(ctx) {
    return conns(ctx.s).map((c, i) => psObject('MSFT_iSCSISession', { AuthenticationType: 'NONE', InitiatorNodeAddress: initiatorIqn(ctx.s), IsConnected: true, IsPersistent: c.persistent, NumberOfConnections: 1, SessionIdentifier: `ffffa30e1f0e7010-400001370000000${i + 1}`, TargetNodeAddress: c.iqn }))
  },
})

cmdlet('Disconnect-IscsiTarget', {
  params: ['NodeAddress', 'SessionIdentifier'],
  switches: ['Confirm', 'Force'],
  synopsis: 'Disconnects sessions to the specified iSCSI target object.',
  module: 'iSCSI',
  run(ctx) {
    const iqn = str(ctx, 'NodeAddress') ?? toText((ctx.input[0] as PsObject | undefined)?.NodeAddress)
    const c = conns(ctx.s).find((x) => x.iqn === iqn)
    if (!c) throw new PsError(`The session does not exist.`, 'NotSpecified', 'HRESULT 0xefff001c,Disconnect-IscsiTarget', iqn)
    ctx.s.data.disks = disks(ctx.s).filter((d) => !c.disks.includes(d.numero))
    ctx.s.data.iscsiConns = conns(ctx.s).filter((x) => x !== c)
    return []
  },
})

export function verifyIscsiWin(s: PsSession, check: Record<string, unknown>): { ok: boolean; label: string } | undefined {
  if (!('iscsi_conectado' in check)) return undefined
  const iqn = String(check.iscsi_conectado)
  const c = conns(s).find((x) => x.iqn === iqn)
  let ok = !!c
  if (ok && check.persistente) ok = c!.persistent
  return { ok, label: `el equipo está conectado al destino iSCSI ${iqn}${check.persistente ? ' de forma persistente' : ''}` }
}

void asArray
