/**
 * Windows Server Update Services (módulo UpdateServices) y el cliente de Windows Update:
 * productos y clasificaciones, sincronización, grupos de equipos, aprobar y rechazar, limpieza,
 * y equipos que se registran y se instalan lo aprobado para su grupo. También wusa /uninstall.
 * Los números de KB del catálogo por defecto son de ejemplo.
 */
import type { RsopResult } from '../gpo/rsop'
import { ruleObject } from './machine'
import { asArray, cmdlet, PsError, PsSession, psEquals, type CmdletContext } from './session'
import { formatDate, isPsObject, psObject, toText, VIEWS, withSetter, type PsObject } from './values'

const param = (ctx: CmdletContext, n: string) => ctx.params.get(n.toLowerCase())
const has = (ctx: CmdletContext, n: string) => ctx.params.has(n.toLowerCase())
const str = (ctx: CmdletContext, n: string) => (has(ctx, n) && param(ctx, n) !== null ? toText(param(ctx, n)) : undefined)
const formatted = (text: string): PsObject => psObject('__formatted', { text })
const MOD = 'UpdateServices'

export const CLASSIFICATIONS = ['Critical Updates', 'Security Updates', 'Definition Updates', 'Update Rollups', 'Updates', 'Feature Packs', 'Service Packs', 'Tools', 'Drivers', 'Upgrades']
export const PRODUCTS = ['Windows Server 2025', 'Windows Server 2022', 'Windows 11', 'Windows 10', 'Microsoft Defender Antivirus', 'Microsoft Edge', 'Microsoft 365 Apps/Office 2019/Office LTSC', 'Microsoft SQL Server 2022']

export interface WsusUpdate {
  kb: string
  title: string
  classification: string
  product: string
  superseded: boolean
  declined: boolean
  approvals: Record<string, 'Install' | 'NotApproved'>
  arrival: Date
  /** Al instalarse, necesita reiniciar. */
  reboot: boolean
}

interface WsusComputer {
  name: string
  ip: string
  group: string
  requested: string
  lastReport: Date
  os: string
}

export interface WsusState {
  configured: boolean
  contentDir: string
  synced: boolean
  lastSync?: Date
  products: string[]
  classifications: string[]
  groups: string[]
  catalog: WsusUpdate[]
  computers: WsusComputer[]
  clientTargeting: boolean
}

function d(daysAgo: number) {
  return new Date(Date.now() - daysAgo * 86_400_000)
}

/** Catálogo de ejemplo (noviembre de 2026; los números de KB son de ejemplo). */
export function defaultCatalog(): WsusUpdate[] {
  const u = (kb: string, title: string, classification: string, product: string, days: number, extra: Partial<WsusUpdate> = {}): WsusUpdate => ({ kb, title, classification, product, superseded: false, declined: false, approvals: {}, arrival: d(days), reboot: classification !== 'Definition Updates', ...extra })
  return [
    u('KB5072033', '2026-11 Cumulative Update for Microsoft server operating system version 24H2 for x64-based Systems (KB5072033)', 'Security Updates', 'Windows Server 2025', 4),
    u('KB5072031', '2026-11 Cumulative Update for Windows 11 Version 25H2 for x64-based Systems (KB5072031)', 'Security Updates', 'Windows 11', 4),
    u('KB5071950', '2026-10 Cumulative Update for Windows 11 Version 25H2 for x64-based Systems (KB5071950)', 'Security Updates', 'Windows 11', 32, { superseded: true }),
    u('KB5071948', '2026-10 Cumulative Update for Microsoft server operating system version 24H2 for x64-based Systems (KB5071948)', 'Security Updates', 'Windows Server 2025', 32, { superseded: true }),
    u('KB5072052', '2026-11 Cumulative Update for .NET Framework 3.5 and 4.8.1 for Microsoft server operating system version 24H2 for x64 (KB5072052)', 'Security Updates', 'Windows Server 2025', 4),
    u('KB2267602', 'Security Intelligence Update for Microsoft Defender Antivirus - KB2267602 (Version 1.441.120.0)', 'Definition Updates', 'Microsoft Defender Antivirus', 0, { reboot: false }),
    u('KB890830', 'Windows Malicious Software Removal Tool x64 - v5.141 (KB890830)', 'Update Rollups', 'Windows 11', 4, { reboot: false }),
    u('KB5072210', '2026-11 Update for Windows 11 Version 25H2 for x64-based Systems (KB5072210)', 'Updates', 'Windows 11', 11),
    u('DRV-INTEL-NET', 'Intel - Net - 30.0.1.4', 'Drivers', 'Windows 11', 20, { reboot: true }),
  ]
}

export function wsusState(s: PsSession): WsusState {
  return ((s.data.wsus ??= [{ configured: false, contentDir: '', synced: false, products: [], classifications: ['Critical Updates', 'Security Updates', 'Definition Updates'], groups: ['All Computers', 'Unassigned Computers'], catalog: [], computers: [], clientTargeting: false }]) as WsusState[])[0]
}

function hasRole(s: PsSession) {
  return ((s.data.features ?? []) as PsObject[]).some((f) => toText(f.Name).toLowerCase() === 'updateservices' && f.Installed)
}

function wsusTarget(ctx: CmdletContext, cmd: string): PsSession {
  const name = str(ctx, 'Name') && cmd === 'Get-WsusServer' ? str(ctx, 'Name') : undefined
  const t = name && !psEquals(name.split('.')[0], ctx.s.state.equipo) ? ctx.s.lab?.find(name) : ctx.s
  if (!t || !hasRole(t)) throw new PsError(`The term '${cmd}' is not recognized as the name of a cmdlet, function, script file, or operable program.\n[simulador] Instalá el rol: Install-WindowsFeature UpdateServices -IncludeManagementTools`, 'ObjectNotFound', 'CommandNotFoundException', cmd)
  const w = wsusState(t)
  if (!w.configured) throw new PsError('The request failed with HTTP status 503: Service Unavailable.\n[simulador] Falta la configuración posterior a la instalación: wsusutil.exe postinstall CONTENT_DIR=D:\\WSUS', 'ConnectionError', 'ServerUnavailable,Microsoft.UpdateServices.Commands.GetWsusServerCommand')
  return t
}

function osOf(s: PsSession): string {
  return /^(PC|NB|WS)/i.test(s.state.equipo) ? 'Windows 11' : 'Windows Server 2025'
}

/** ¿La actualización se aplica a ese equipo? */
function applies(u: WsusUpdate, os: string) {
  return u.product === os || u.product === 'Microsoft Defender Antivirus' || (u.kb === 'KB890830' && /Windows/.test(os))
}

function installed(s: PsSession | undefined, kb: string) {
  return !!s && ((s.data.hotfixes ?? []) as PsObject[]).some((h) => psEquals(h.HotFixID, kb))
}

// ---------------------------------------------------------------------------------------
// wsusutil y el servidor
// ---------------------------------------------------------------------------------------

cmdlet('wsusutil', {
  native: true,
  synopsis: 'wsusutil.exe',
  run(ctx) {
    const args = ctx.positional.map(toText)
    if (!hasRole(ctx.s)) throw new PsError("The term 'wsusutil' is not recognized as the name of a cmdlet, function, script file, or operable program.", 'ObjectNotFound', 'CommandNotFoundException', 'wsusutil')
    const w = wsusState(ctx.s)
    if (args[0]?.toLowerCase() === 'postinstall') {
      const dir = args.find((a) => /^content_dir=/i.test(a))?.split('=')[1]
      if (!dir) return [formatted('Post install has failed.\n[simulador] Indicá la carpeta del contenido: wsusutil.exe postinstall CONTENT_DIR=D:\\WSUS\n')]
      ctx.s.fs.mkdirp(ctx.s.resolvePath(dir))
      w.configured = true
      w.contentDir = dir
      const ports = ((ctx.s.data.extraPorts ??= []) as number[])
      if (!ports.includes(8530)) ports.push(8530, 8531)
      const rules = (ctx.s.data.firewallRules ??= []) as PsObject[]
      if (!rules.some((r) => toText(r.Name) === 'WSUS-Standard-In')) rules.push(ruleObject({ name: 'WSUS-Standard-In', display: 'Windows Server Update Services (HTTP Traffic-In)', group: 'Windows Server Update Services', enabled: true, proto: 'TCP', port: '8530' }))
      return [formatted('Log file is located at C:\\Users\\Administrator\\AppData\\Local\\Temp\\WSUS_PostInstall_20261114T201500.log\nPost install is starting\nPost install has successfully completed\n')]
    }
    if (args[0]?.toLowerCase() === 'reset') return [formatted('[simulador] wsusutil reset vuelve a comprobar el contenido descargado; en un servidor sano no cambia nada.\n')]
    return [formatted('Windows Server Update Services Utility\nUsage:\n  wsusutil postinstall CONTENT_DIR=<ruta>\n  wsusutil reset\n  wsusutil checkhealth\n')]
  },
})

function groupObject(name: string): PsObject {
  return psObject('Microsoft.UpdateServices.Internal.BaseApi.ComputerTargetGroup', { Name: name, Id: name === 'All Computers' ? 'a0a08746-4dbe-4a37-9adf-9e7652c0b421' : name === 'Unassigned Computers' ? 'b73ca6ed-5727-47f3-84de-015e03f6a88a' : `grp-${name.toLowerCase()}`, __toString: name })
}

function serverObject(t: PsSession): PsObject {
  const w = wsusState(t)
  const o = psObject('Microsoft.UpdateServices.Internal.BaseApi.UpdateServer', { Name: t.state.equipo, PortNumber: 8530, ServerProtocolVersion: '1.20', UseSecureConnection: false, __toString: t.state.equipo })
  o.__method_createcomputertargetgroup = (name: unknown) => {
    const n = toText(name)
    if (w.groups.some((g) => psEquals(g, n))) throw new PsError(`Exception calling "CreateComputerTargetGroup" with "1" argument(s): "A computer target group with this name already exists."`, 'InvalidOperation', 'WsusObjectAlreadyExistsException')
    w.groups.push(n)
    return groupObject(n)
  }
  o.__method_getcomputertargetgroups = () => w.groups.map(groupObject)
  o.__method_getsubscription = () => {
    const sub = psObject('Microsoft.UpdateServices.Internal.BaseApi.Subscription', { SynchronizeAutomatically: false, NumberOfSynchronizationsPerDay: 1, LastSynchronizationTime: w.lastSync ?? '' })
    sub.__method_startsynchronization = () => {
      synchronize(t)
      return null
    }
    sub.__method_getsynchronizationstatus = () => 'NotProcessing'
    sub.__method_getlastsynchronizationinfo = () => psObject('Microsoft.UpdateServices.Internal.BaseApi.SynchronizationInfo', { StartTime: w.lastSync ?? '', EndTime: w.lastSync ?? '', Result: w.synced ? 'Succeeded' : 'NeverRun', UpdateErrors: '{}' })
    sub.__method_save = () => null
    return withSetter(sub, () => undefined)
  }
  o.__method_getconfiguration = () => {
    const cfg = psObject('Microsoft.UpdateServices.Internal.BaseApi.UpdateServerConfiguration', { TargetingMode: w.clientTargeting ? 'Client' : 'Server', SyncFromMicrosoftUpdate: true, LocalContentCachePath: w.contentDir })
    cfg.__method_save = () => null
    return withSetter(cfg, (name, value) => {
      if (/^targetingmode$/i.test(name)) {
        w.clientTargeting = /^client$/i.test(toText(value))
        return w.clientTargeting ? 'Client' : 'Server'
      }
      return undefined
    })
  }
  return o
}
VIEWS['Microsoft.UpdateServices.Internal.BaseApi.UpdateServer'] = { kind: 'table', columns: ['Name', 'PortNumber', 'ServerProtocolVersion', 'UseSecureConnection'].map((c) => ({ label: c, value: (o: PsObject) => o[c] })) }
VIEWS['Microsoft.UpdateServices.Internal.BaseApi.ComputerTargetGroup'] = { kind: 'table', columns: ['Name', 'Id'].map((c) => ({ label: c, value: (o: PsObject) => o[c] })) }

function synchronize(t: PsSession) {
  const w = wsusState(t)
  if (!w.products.length) throw new PsError('Exception calling "StartSynchronization": "No hay productos seleccionados."\n[simulador] Elegí productos con Get-WsusProduct | Where-Object … | Set-WsusProduct.', 'InvalidOperation', 'WsusInvalidOperation')
  const base = (t.data.wsusCatalog as WsusUpdate[] | undefined) ?? defaultCatalog()
  for (const u of base) {
    if (!w.products.includes(u.product) || !w.classifications.includes(u.classification)) continue
    if (!w.catalog.some((x) => x.kb === u.kb)) w.catalog.push({ ...u, approvals: { ...u.approvals } })
  }
  w.synced = true
  w.lastSync = new Date()
}

cmdlet('Get-WsusServer', {
  params: ['Name', 'PortNumber'],
  switches: ['UseSsl'],
  positional: ['Name'],
  synopsis: 'Gets the value of the WSUS update server object.',
  module: MOD,
  run(ctx) {
    return [serverObject(wsusTarget(ctx, 'Get-WsusServer'))]
  },
})

cmdlet('Set-WsusServerSynchronization', {
  params: ['UpdateServer', 'UssServerName', 'PortNumber'],
  switches: ['SyncFromMU', 'UseSsl'],
  synopsis: 'Sets whether the WSUS server synchronizes from Microsoft Update or from an upstream server.',
  module: MOD,
  run(ctx) {
    wsusTarget(ctx, 'Set-WsusServerSynchronization')
    if (has(ctx, 'UssServerName')) ctx.host('[simulador] Un servidor que sincroniza de otro WSUS (en cascada) se usa en empresas con varias sedes; acá se sincroniza de Microsoft Update.\n')
    return []
  },
})

function classificationObject(title: string, w: WsusState): PsObject {
  return psObject('Microsoft.UpdateServices.Commands.WsusClassification', { Classification: psObject('Microsoft.UpdateServices.Internal.BaseApi.UpdateClassification', { Title: title, __toString: title }), Enabled: w.classifications.includes(title), __title: title })
}
VIEWS['Microsoft.UpdateServices.Commands.WsusClassification'] = { kind: 'table', columns: [{ label: 'Classification', value: (o) => o.__title }, { label: 'Enabled', value: (o) => o.Enabled }] }

cmdlet('Get-WsusClassification', {
  params: ['UpdateServer'],
  synopsis: 'Gets the list of all WSUS classifications.',
  module: MOD,
  run(ctx) {
    const w = wsusState(wsusTarget(ctx, 'Get-WsusClassification'))
    return CLASSIFICATIONS.map((c) => classificationObject(c, w))
  },
})

cmdlet('Set-WsusClassification', {
  params: ['Classification'],
  switches: ['Disable'],
  synopsis: 'Sets whether the classifications of updates that WSUS synchronizes are enabled or disabled.',
  module: MOD,
  run(ctx) {
    const w = wsusState(wsusTarget(ctx, 'Set-WsusClassification'))
    const items = [...ctx.input, ...asArray(param(ctx, 'Classification'))].filter(isPsObject)
    for (const it of items) {
      const title = toText(it.__title ?? (it.Classification as PsObject | undefined)?.Title ?? it.Title)
      if (has(ctx, 'Disable')) w.classifications = w.classifications.filter((c) => c !== title)
      else if (!w.classifications.includes(title)) w.classifications.push(title)
    }
    return []
  },
})

function productObject(title: string, w: WsusState): PsObject {
  return psObject('Microsoft.UpdateServices.Commands.WsusProduct', { Product: psObject('Microsoft.UpdateServices.Internal.BaseApi.UpdateCategory', { Title: title, __toString: title }), Enabled: w.products.includes(title), __title: title })
}
VIEWS['Microsoft.UpdateServices.Commands.WsusProduct'] = { kind: 'table', columns: [{ label: 'Product', value: (o) => o.__title }, { label: 'Enabled', value: (o) => o.Enabled }] }

cmdlet('Get-WsusProduct', {
  params: ['UpdateServer', 'TitleIncludes'],
  synopsis: 'Gets the list of all products currently available on WSUS by category.',
  module: MOD,
  run(ctx) {
    const w = wsusState(wsusTarget(ctx, 'Get-WsusProduct'))
    const inc = str(ctx, 'TitleIncludes')?.toLowerCase()
    return PRODUCTS.filter((p) => !inc || p.toLowerCase().includes(inc)).map((p) => productObject(p, w))
  },
})

cmdlet('Set-WsusProduct', {
  params: ['Product'],
  switches: ['Disable'],
  synopsis: 'Sets whether the product representing the category of updates to synchronize is enabled or disabled.',
  module: MOD,
  run(ctx) {
    const w = wsusState(wsusTarget(ctx, 'Set-WsusProduct'))
    const items = [...ctx.input, ...asArray(param(ctx, 'Product'))].filter(isPsObject)
    for (const it of items) {
      const title = toText(it.__title ?? (it.Product as PsObject | undefined)?.Title ?? it.Title)
      if (has(ctx, 'Disable')) w.products = w.products.filter((c) => c !== title)
      else if (!w.products.includes(title)) w.products.push(title)
    }
    return []
  },
})

// ---------------------------------------------------------------------------------------
// Actualizaciones: ver, aprobar y rechazar
// ---------------------------------------------------------------------------------------

function computersOf(t: PsSession): { c: WsusComputer; s?: PsSession }[] {
  return wsusState(t).computers.map((c) => ({ c, s: t.lab?.find(c.name) }))
}

function approvalFor(u: WsusUpdate, group: string): 'Install' | 'NotApproved' | undefined {
  return u.approvals[group] ?? u.approvals['All Computers']
}

function updateObject(t: PsSession, u: WsusUpdate): PsObject {
  const comps = computersOf(t)
  const relevant = comps.filter(({ c }) => applies(u, c.os))
  const done = comps.filter(({ c, s }) => !applies(u, c.os) || installed(s, u.kb)).length
  const pct = comps.length ? Math.round((done / comps.length) * 100) : 0
  const approved = u.declined ? 'Declined' : Object.values(u.approvals).includes('Install') ? 'Install' : 'NotApproved'
  return psObject('Microsoft.UpdateServices.Commands.WsusUpdate', {
    Update: psObject('Microsoft.UpdateServices.Internal.BaseApi.Update', { Title: u.title, KnowledgebaseArticles: u.kb.replace(/^KB/, ''), IsSuperseded: u.superseded, IsDeclined: u.declined, ArrivalDate: u.arrival, UpdateClassificationTitle: u.classification, __toString: u.title }),
    Classification: u.classification,
    InstalledOrNotApplicablePercentage: pct,
    Approved: approved,
    ComputersNeedingThisUpdate: relevant.filter(({ s }) => !installed(s, u.kb)).length,
    __kb: u.kb,
  })
}
VIEWS['Microsoft.UpdateServices.Commands.WsusUpdate'] = {
  kind: 'table',
  columns: [
    { label: 'Title', value: (o) => { const t = toText((o.Update as PsObject).Title); return t.length > 60 ? `${t.slice(0, 57)}...` : t } },
    { label: 'Classification', value: (o) => o.Classification },
    { label: 'Installed/NotApplicable Percentage', value: (o) => o.InstalledOrNotApplicablePercentage, align: 'right' },
    { label: 'Approved', value: (o) => o.Approved },
  ],
}

function findUpdates(ctx: CmdletContext, t: PsSession, cmd: string): WsusUpdate[] {
  const w = wsusState(t)
  const items = [...ctx.input, ...asArray(param(ctx, 'Update'))].filter((x) => isPsObject(x) && x.__kb)
  if (!items.length) throw new PsError(`Cannot bind argument to parameter 'Update' because it is null.\n[simulador] Pasale las actualizaciones por la tubería: Get-WsusUpdate … | ${cmd}`, 'InvalidData', `ParameterArgumentValidationErrorNullNotAllowed,Microsoft.UpdateServices.Commands.${cmd.replace('-', '')}Command`)
  return items.map((x) => w.catalog.find((u) => u.kb === toText((x as PsObject).__kb))!).filter(Boolean)
}

cmdlet('Get-WsusUpdate', {
  params: ['UpdateServer', 'Classification', 'Approval', 'Status', 'UpdateId'],
  synopsis: 'Gets the WSUS update object with details about the update.',
  module: MOD,
  run(ctx) {
    const t = wsusTarget(ctx, 'Get-WsusUpdate')
    const w = wsusState(t)
    if (!w.synced) return []
    const cls = (str(ctx, 'Classification') ?? 'All').toLowerCase()
    const appr = (str(ctx, 'Approval') ?? 'AnyExceptDeclined').toLowerCase()
    const status = (str(ctx, 'Status') ?? 'Any').toLowerCase()
    let list = w.catalog
    if (cls === 'critical') list = list.filter((u) => u.classification === 'Critical Updates')
    if (cls === 'security') list = list.filter((u) => u.classification === 'Security Updates')
    if (cls === 'wsus') list = list.filter((u) => u.classification === 'Updates')
    if (appr === 'anyexceptdeclined') list = list.filter((u) => !u.declined)
    if (appr === 'declined') list = list.filter((u) => u.declined)
    if (appr === 'approved') list = list.filter((u) => !u.declined && Object.values(u.approvals).includes('Install'))
    if (appr === 'unapproved') list = list.filter((u) => !u.declined && !Object.values(u.approvals).includes('Install'))
    if (status === 'needed' || status === 'failedorneeded') list = list.filter((u) => computersOf(t).some(({ c, s }) => applies(u, c.os) && !installed(s, u.kb)))
    if (status === 'installedornotapplicable') list = list.filter((u) => computersOf(t).every(({ c, s }) => !applies(u, c.os) || installed(s, u.kb)))
    return list.map((u) => updateObject(t, u))
  },
})

cmdlet('Approve-WsusUpdate', {
  params: ['Update', 'Action', 'TargetGroupName'],
  synopsis: 'Approves an update to be applied to clients.',
  module: MOD,
  run(ctx) {
    const t = wsusTarget(ctx, 'Approve-WsusUpdate')
    const w = wsusState(t)
    const group = str(ctx, 'TargetGroupName')
    if (!group) throw new PsError('Cannot process command because of one or more missing mandatory parameters: TargetGroupName.', 'InvalidArgument', 'MissingMandatoryParameter')
    const g = w.groups.find((x) => psEquals(x, group))
    if (!g) throw new PsError(`The computer target group '${group}' does not exist.`, 'ObjectNotFound', 'TargetGroupNotFound,Microsoft.UpdateServices.Commands.ApproveWsusUpdateCommand', group)
    const action = (str(ctx, 'Action') ?? 'Install').toLowerCase()
    for (const u of findUpdates(ctx, t, 'Approve-WsusUpdate')) {
      if (u.declined) {
        ctx.writeError(`The update "${u.title}" is declined. Undecline it before approving.`, 'InvalidOperation', u.kb)
        continue
      }
      if (action === 'install') u.approvals[g] = 'Install'
      else if (action === 'notapproved') u.approvals[g] = 'NotApproved'
      else ctx.host(`[simulador] La acción ${str(ctx, 'Action')} no se simula; las habituales son Install y NotApproved.\n`)
    }
    return []
  },
})

cmdlet('Deny-WsusUpdate', {
  params: ['Update'],
  synopsis: 'Declines the update for deployment.',
  module: MOD,
  run(ctx) {
    const t = wsusTarget(ctx, 'Deny-WsusUpdate')
    for (const u of findUpdates(ctx, t, 'Deny-WsusUpdate')) {
      u.declined = true
      u.approvals = {}
    }
    return []
  },
})

// ---------------------------------------------------------------------------------------
// Equipos
// ---------------------------------------------------------------------------------------

function computerObject(c: WsusComputer): PsObject {
  return psObject('Microsoft.UpdateServices.Internal.BaseApi.ComputerTarget', { FullDomainName: c.name, IPAddress: c.ip, LastReportedStatusTime: formatDate(c.lastReport, false), RequestedTargetGroupName: c.requested, OSDescription: c.os, __group: c.group, __name: c.name })
}
VIEWS['Microsoft.UpdateServices.Internal.BaseApi.ComputerTarget'] = {
  kind: 'table',
  columns: [
    { label: 'FullDomainName', value: (o) => o.FullDomainName },
    { label: 'IPAddress', value: (o) => o.IPAddress },
    { label: 'LastReportedStatusTime', value: (o) => o.LastReportedStatusTime },
    { label: 'ComputerTargetGroup', value: (o) => o.__group },
  ],
}

cmdlet('Get-WsusComputer', {
  params: ['UpdateServer', 'ComputerTargetGroups', 'NameIncludes', 'ComputerUpdateStatus'],
  switches: ['IncludeSubgroups', 'IncludeDownstreamComputerTargets'],
  synopsis: 'Gets the WSUS computer object that represents the client computer.',
  module: MOD,
  run(ctx) {
    const w = wsusState(wsusTarget(ctx, 'Get-WsusComputer'))
    const groups = asArray(param(ctx, 'ComputerTargetGroups')).map(toText)
    const inc = str(ctx, 'NameIncludes')?.toLowerCase()
    const list = w.computers.filter((c) => (!groups.length || groups.some((g) => psEquals(g, c.group) || psEquals(g, 'All Computers'))) && (!inc || c.name.toLowerCase().includes(inc)))
    if (!list.length) return [formatted('No computers available.\n')]
    return list.map(computerObject)
  },
})

cmdlet('Add-WsusComputer', {
  params: ['Computer', 'TargetGroupName'],
  synopsis: 'Adds a specified client computer to a specified target group.',
  module: MOD,
  run(ctx) {
    const w = wsusState(wsusTarget(ctx, 'Add-WsusComputer'))
    const g = w.groups.find((x) => psEquals(x, str(ctx, 'TargetGroupName')))
    if (!g) throw new PsError(`The computer target group '${str(ctx, 'TargetGroupName')}' does not exist.`, 'ObjectNotFound', 'TargetGroupNotFound', str(ctx, 'TargetGroupName'))
    if (w.clientTargeting) ctx.host('[simulador] El servidor está en "segmentación del lado del cliente": la próxima vez que el equipo se reporte, vuelve al grupo que diga su GPO.\n')
    const items = [...ctx.input, ...asArray(param(ctx, 'Computer'))].filter(isPsObject)
    for (const it of items) {
      const c = w.computers.find((x) => psEquals(x.name, it.__name))
      if (c) c.group = g
    }
    return []
  },
})

cmdlet('Invoke-WsusServerCleanup', {
  params: ['UpdateServer'],
  switches: ['CleanupObsoleteComputers', 'CleanupObsoleteUpdates', 'CleanupUnneededContentFiles', 'CompressUpdates', 'DeclineExpiredUpdates', 'DeclineSupersededUpdates'],
  synopsis: 'Performs the process of cleanup on a specified WSUS server.',
  module: MOD,
  run(ctx) {
    const w = wsusState(wsusTarget(ctx, 'Invoke-WsusServerCleanup'))
    const lines: string[] = []
    if (has(ctx, 'DeclineSupersededUpdates')) {
      const sup = w.catalog.filter((u) => u.superseded && !u.declined)
      for (const u of sup) {
        u.declined = true
        u.approvals = {}
      }
      lines.push(`Superseded Updates Declined: ${sup.length}`)
    }
    if (has(ctx, 'DeclineExpiredUpdates')) lines.push('Expired Updates Declined: 0')
    if (has(ctx, 'CleanupObsoleteUpdates')) lines.push('Obsolete Updates Deleted:0')
    if (has(ctx, 'CompressUpdates')) lines.push('Updates Compressed:3')
    if (has(ctx, 'CleanupObsoleteComputers')) {
      const before = w.computers.length
      w.computers = w.computers.filter((c) => Date.now() - c.lastReport.getTime() < 30 * 86_400_000)
      lines.push(`Obsolete Computers Deleted:${before - w.computers.length}`)
    }
    if (has(ctx, 'CleanupUnneededContentFiles')) lines.push('Diskspace Freed:2147483648')
    return [formatted(lines.join('\n') + '\n')]
  },
})

// ---------------------------------------------------------------------------------------
// El cliente: de dónde saca las actualizaciones, buscar, instalar y desinstalar
// ---------------------------------------------------------------------------------------

interface ClientConfig {
  server?: string
  group?: string
}

/** Configuración del cliente: lo que trae la GPO (o el estado del ejercicio). */
export function clientConfig(s: PsSession): ClientConfig {
  const applied = s.data.gpApplied?.[0] as { computer?: RsopResult } | undefined
  const settings = applied?.computer?.settings ?? []
  const val = (key: RegExp, name: string) => settings.find((x) => key.test(x.setting.key.toLowerCase()) && psEquals(x.setting.valueName, name))?.setting.value
  const wu = /software\\policies\\microsoft\\windows\\windowsupdate$/
  const au = /software\\policies\\microsoft\\windows\\windowsupdate\\au$/
  const useServer = Number(val(au, 'UseWUServer') ?? 0) === 1
  const server = useServer ? toText(val(wu, 'WUServer') ?? '') : undefined
  const group = Number(val(wu, 'TargetGroupEnabled') ?? 0) === 1 ? toText(val(wu, 'TargetGroup') ?? '') : undefined
  const st = s.state.wsus_cliente
  return { server: server || st?.servidor, group: group || st?.grupo }
}

function wsusOf(client: PsSession): { srv?: PsSession; reason?: string } {
  const cfg = clientConfig(client)
  if (!cfg.server) return { reason: 'microsoft' }
  const m = /^https?:\/\/([^:/]+)(?::(\d+))?/i.exec(cfg.server)
  const srv = m ? client.lab?.find(m[1]) : undefined
  if (!srv || !hasRole(srv) || !wsusState(srv).configured) return { reason: 'noserver' }
  return { srv }
}

/** El equipo se reporta a su WSUS: se registra (o actualiza su grupo) y devuelve lo que necesita. */
function report(client: PsSession, srv: PsSession): WsusUpdate[] {
  const w = wsusState(srv)
  const cfg = clientConfig(client)
  const name = client.state.dominio ? `${client.state.equipo}.${client.state.dominio}`.toLowerCase() : client.state.equipo.toLowerCase()
  let c = w.computers.find((x) => psEquals(x.name, name))
  const requested = cfg.group ?? ''
  if (!c) {
    c = { name, ip: client.state.red.ip, group: 'Unassigned Computers', requested, lastReport: new Date(), os: osOf(client) }
    w.computers.push(c)
  }
  c.lastReport = new Date()
  c.requested = requested
  c.ip = client.state.red.ip
  if (w.clientTargeting && requested) {
    const g = w.groups.find((x) => psEquals(x, requested))
    c.group = g ?? 'Unassigned Computers'
  }
  return w.catalog.filter((u) => !u.declined && applies(u, c.os) && !installed(client, u.kb))
}

cmdlet(['UsoClient', 'wuauclt'], {
  native: true,
  synopsis: 'UsoClient.exe / wuauclt.exe',
  run(ctx) {
    const s = ctx.s
    const op = ctx.positional.map(toText).join(' ').toLowerCase()
    const target = wsusOf(s)
    if (target.reason === 'microsoft') {
      ctx.host('[simulador] Este equipo no tiene un servidor WSUS configurado: busca actualizaciones directo en Microsoft Update.\n')
      return []
    }
    if (!target.srv) {
      ctx.host(`[simulador] La GPO apunta a ${clientConfig(s).server}, pero ahí no responde un WSUS configurado. En el registro de Windows Update aparecería el error 0x8024401C o 0x80244022.\n`)
      return []
    }
    const srv = target.srv
    const needed = report(s, srv)
    const w = wsusState(srv)
    const c = w.computers.find((x) => x.name.startsWith(s.state.equipo.toLowerCase()))!
    if (/startscan|detectnow|reportnow|scaninstallwait/.test(op)) ctx.host(`[simulador] ${s.state.equipo} se reportó a ${srv.state.equipo} (grupo ${c.group}). Necesita ${needed.length} actualizaciones.\n`)
    if (/startinstall|scaninstallwait|updatenow/.test(op)) {
      const ok = needed.filter((u) => approvalFor(u, c.group) === 'Install')
      // Un acumulativo reemplazado no se instala si está el nuevo (aprobado o ya instalado).
      const approved = ok.filter((u) => !u.superseded || !w.catalog.some((n) => !n.superseded && n.product === u.product && n.classification === u.classification && (ok.includes(n) || installed(s, n.kb))))
      if (!approved.length) ctx.host('[simulador] No hay actualizaciones aprobadas para su grupo.\n')
      for (const u of approved) {
        ;((s.data.hotfixes ??= []) as PsObject[]).push(psObject('System.Management.ManagementObject#root\\cimv2\\Win32_QuickFixEngineering', { Source: s.state.equipo, Description: u.classification === 'Security Updates' ? 'Security Update' : 'Update', HotFixID: u.kb, InstalledBy: 'NT AUTHORITY\\SYSTEM', InstalledOn: new Date() }))
        if (u.reboot) s.pending.messages.push(`Reinicio pendiente por ${u.kb}`)
      }
      if (approved.length) ctx.host(`[simulador] Se instalaron ${approved.map((u) => u.kb).join(', ')}${approved.some((u) => u.reboot) ? '. Hace falta reiniciar.' : '.'}\n`)
    }
    return []
  },
})

cmdlet('wusa', {
  native: true,
  synopsis: 'wusa.exe',
  run(ctx) {
    const args = ctx.positional.map(toText)
    const kb = args.find((a) => /^\/kb:/i.test(a))?.split(':')[1]
    if (args.some((a) => /^\/uninstall$/i.test(a)) && kb) {
      const id = `KB${kb.replace(/^KB/i, '')}`
      const list = (ctx.s.data.hotfixes ??= []) as PsObject[]
      const i = list.findIndex((h) => psEquals(h.HotFixID, id))
      if (i < 0) {
        ctx.host(`[simulador] ${id} no está instalada en este equipo. (wusa termina con el código 0x80240017 sin mostrar nada con /quiet.)\n`)
        return []
      }
      list.splice(i, 1)
      ctx.s.pending.messages.push(`Reinicio pendiente por desinstalar ${id}`)
      ctx.host(`[simulador] Se desinstaló ${id}${args.some((a) => /^\/norestart$/i.test(a)) ? '; queda pendiente reiniciar' : ''}. Si el WSUS la sigue aprobando para este grupo, se vuelve a instalar en la próxima búsqueda.\n`)
      return []
    }
    return [formatted('[simulador] Uso: wusa /uninstall /kb:<número> [/quiet] [/norestart]\n')]
  },
})

/** WSUS y el cliente del estado inicial del ejercicio. */
export function initialWsus(s: PsSession) {
  const cfg = s.state.wsus
  if (!cfg) return
  for (const f of s.data.features as PsObject[]) if (['updateservices', 'updateservices-services', 'updateservices-rsat'].includes(toText(f.Name).toLowerCase())) Object.assign(f, { Installed: true, InstallState: 'Installed' })
  const mods = s.data.modules as string[]
  if (!mods.includes('UpdateServices')) mods.push('UpdateServices')
  const services = s.data.services as PsObject[]
  if (!services.some((x) => toText(x.Name) === 'WsusService')) services.push(psObject('System.ServiceProcess.ServiceController', { Status: 'Running', Name: 'WsusService', DisplayName: 'WSUS Service', ServiceName: 'WsusService', StartType: 'Automatic', CanStop: true }))
  const w = wsusState(s)
  w.configured = cfg.configurado
  w.contentDir = 'D:\\WSUS'
  if (cfg.configurado) {
    const ports = ((s.data.extraPorts ??= []) as number[])
    if (!ports.includes(8530)) ports.push(8530)
    ;(s.data.firewallRules as PsObject[]).push(ruleObject({ name: 'WSUS-Standard-In', display: 'Windows Server Update Services (HTTP Traffic-In)', group: 'Windows Server Update Services', enabled: true, proto: 'TCP', port: '8530' }))
  }
  w.groups.push(...cfg.grupos.filter((g) => !w.groups.includes(g)))
  w.clientTargeting = cfg.segmentacion_cliente
  if (cfg.productos.length) w.products = [...cfg.productos]
  if (cfg.clasificaciones.length) w.classifications = [...cfg.clasificaciones]
  if (cfg.sincronizado) synchronize(s)
  for (const a of cfg.aprobaciones) {
    const u = w.catalog.find((x) => x.kb === a.kb)
    if (u) u.approvals[a.grupo] = a.accion === 'no_aprobada' ? 'NotApproved' : 'Install'
  }
  for (const kb of cfg.rechazadas) {
    const u = w.catalog.find((x) => x.kb === kb)
    if (u) u.declined = true
  }
  for (const c of cfg.equipos) w.computers.push({ name: c.nombre.toLowerCase(), ip: c.ip ?? '', group: c.grupo, requested: c.grupo, lastReport: new Date(Date.now() - (c.hace_dias ?? 0) * 86_400_000), os: /^(PC|NB|WS)/i.test(c.nombre) ? 'Windows 11' : 'Windows Server 2025' })
}

export function verifyWsus(s: PsSession, check: Record<string, unknown>): { ok: boolean; label: string } | undefined {
  if ('wsus_listo' in check) {
    const w = hasRole(s) ? wsusState(s) : undefined
    const ok = !!w && w.configured && w.synced
    return { ok: ok === check.wsus_listo, label: `WSUS de ${s.state.equipo} está configurado y sincronizado` }
  }
  if ('wsus_grupo' in check) {
    const w = wsusState(s)
    return { ok: w.groups.some((g) => psEquals(g, check.wsus_grupo)), label: `existe el grupo de equipos ${toText(check.wsus_grupo)} en WSUS` }
  }
  if ('wsus_clasificacion' in check) {
    const w = wsusState(s)
    const on = w.classifications.includes(toText(check.wsus_clasificacion))
    return { ok: on === (check.habilitada ?? true), label: `la clasificación ${toText(check.wsus_clasificacion)} está ${(check.habilitada ?? true) ? 'habilitada' : 'deshabilitada'}` }
  }
  if ('wsus_producto' in check) {
    const w = wsusState(s)
    const on = w.products.includes(toText(check.wsus_producto))
    return { ok: on === (check.habilitado ?? true), label: `el producto ${toText(check.wsus_producto)} está ${(check.habilitado ?? true) ? 'habilitado' : 'deshabilitado'}` }
  }
  if ('wsus_aprobacion' in check) {
    const w = wsusState(s)
    const u = w.catalog.find((x) => x.kb === check.wsus_aprobacion)
    const want = check.accion === 'NotApproved' ? 'NotApproved' : 'Install'
    const got = u?.approvals[toText(check.grupo)]
    const ok = check.aprobada === false ? got !== 'Install' : got === want
    return { ok: !!u && ok, label: `${toText(check.wsus_aprobacion)} ${check.aprobada === false ? 'no está aprobada' : want === 'Install' ? 'está aprobada para instalar' : 'está como no aprobada'} en el grupo ${toText(check.grupo)}` }
  }
  if ('wsus_rechazada' in check) {
    const w = wsusState(s)
    const u = w.catalog.find((x) => x.kb === check.wsus_rechazada)
    return { ok: !!u && u.declined === (check.rechazada ?? true), label: `${toText(check.wsus_rechazada)} ${(check.rechazada ?? true) ? 'está rechazada' : 'no está rechazada'} en WSUS` }
  }
  if ('wsus_equipo' in check) {
    const w = wsusState(s)
    const c = w.computers.find((x) => x.name.split('.')[0] === toText(check.wsus_equipo).toLowerCase())
    return { ok: !!c && (!check.grupo || psEquals(c.group, check.grupo)), label: `${toText(check.wsus_equipo)} está registrado en WSUS${check.grupo ? ` en el grupo ${toText(check.grupo)}` : ''}` }
  }
  if ('actualizacion' in check) {
    const on = installed(s, toText(check.actualizacion))
    return { ok: on === (check.instalada ?? true), label: `${toText(check.actualizacion)} ${(check.instalada ?? true) ? 'está instalada' : 'no está instalada'} en ${s.state.equipo}` }
  }
  return undefined
}
