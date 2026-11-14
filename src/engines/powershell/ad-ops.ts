/**
 * Operación de Active Directory: crear el bosque (Install-ADDSForest), sumar controladores
 * (Install-ADDSDomainController), unir equipos (Add-Computer), roles FSMO, papelera de reciclaje,
 * cuentas de servicio administradas de grupo (gMSA), directivas de contraseña y las herramientas de
 * diagnóstico de siempre: dcdiag, repadmin, netdom, nltest, w32tm y klist.
 */
import {
  adCmdlet,
  allObjects,
  buildAdStore,
  compileFilter,
  compileLdap,
  computed,
  computerObject,
  confirmPrompt,
  containerExists,
  dnOf,
  filterError,
  FSMO_ROLES,
  fsmoOf,
  identityText,
  newSid,
  notFound,
  NS,
  passwordPolicy,
  present,
  resolve,
  resolveAny,
  sameDn,
  sameIdentity,
  search,
  stableGuid,
  store,
  DEFAULT_DOMAIN_POLICY_ID,
  type AdStore,
  type FsmoRole,
  type Pred,
} from './ad'
import { domainControllers, isDc, labStates, locateDc, resolveName } from './dns'
import { DC_RULES, reach, ruleObject } from './machine'
import { asArray, cmdlet, PsError, PsSession, psEquals, type CmdletContext } from './session'
import { restart } from './system'
import { psObject, toText, type PsObject } from './values'

const param = (ctx: CmdletContext, n: string) => ctx.params.get(n.toLowerCase())
const has = (ctx: CmdletContext, n: string) => ctx.params.has(n.toLowerCase())
const str = (ctx: CmdletContext, n: string) => (has(ctx, n) && param(ctx, n) !== null ? toText(param(ctx, n)) : undefined)
const formatted = (text: string): PsObject => psObject('__formatted', { text })
const SITE = 'Default-First-Site-Name'

function serviceRunning(s: PsSession, name: string) {
  return ((s.data.services ?? []) as PsObject[]).some((x) => toText(x.Name).toLowerCase() === name.toLowerCase() && x.Status === 'Running')
}

function fqdn(name: string, domain: string) {
  return `${name}.${domain}`
}

function isSecure(v: unknown) {
  return (v as PsObject)?.__type === 'System.Security.SecureString'
}

function truthyParam(v: unknown) {
  return v === true || /^(true|yes|1)$/i.test(toText(v))
}

/** Hay que reiniciar para que se aplique: se agrega a lo pendiente (Restart-Computer lo ejecuta). */
function onRestart(s: PsSession, fn: () => void) {
  ;((s.data.onRestart ??= []) as (() => void)[]).push(fn)
}

/** Minutos de diferencia de reloj entre dos equipos. */
function skew(a: PsSession, b: PsSession) {
  return Math.abs(a.state.desfase_reloj_min - b.state.desfase_reloj_min)
}

// ---------------------------------------------------------------------------------------
// Credenciales
// ---------------------------------------------------------------------------------------

cmdlet('Get-Credential', {
  params: ['UserName', 'Credential', 'Message', 'Title'],
  positional: ['Credential'],
  synopsis: 'Gets a credential object based on a user name and password.',
  run(ctx) {
    const user = str(ctx, 'UserName') ?? str(ctx, 'Credential') ?? `${ctx.s.state.dominio?.split('.')[0].toUpperCase() ?? ctx.s.state.equipo}\\${ctx.s.state.usuario}`
    ctx.host(`[simulador] Se abre la ventana para escribir la contraseña de ${user}; se da por escrita.\n`)
    return [psObject('System.Management.Automation.PSCredential', { UserName: user, Password: psObject('System.Security.SecureString', { __secure: true, Length: 12 }) })]
  },
}, ['gcred'])

// ---------------------------------------------------------------------------------------
// Promover un servidor a controlador de dominio
// ---------------------------------------------------------------------------------------

const DC_SERVICES: [string, string][] = [
  ['ADWS', 'Active Directory Web Services'],
  ['DNS', 'DNS Server'],
  ['DFSR', 'DFS Replication'],
  ['Kdc', 'Kerberos Key Distribution Center'],
  ['Netlogon', 'Netlogon'],
  ['NTDS', 'Active Directory Domain Services'],
]

/** El servidor pasa a ser controlador del dominio de "st" (lo que pasa al reiniciar después de dcpromo). */
export function promote(s: PsSession, st: AdStore, dnsServers: string[]) {
  s.state.dominio = st.domain
  s.state.controlador_dominio = true
  s.lab?.adStores.set(st.domain.toLowerCase(), st)
  s.data.ad = [st]
  s.data.domainStore = [st]
  const services = (s.data.services ??= []) as PsObject[]
  for (const [name, display] of DC_SERVICES) {
    const sv = services.find((x) => toText(x.Name).toLowerCase() === name.toLowerCase())
    if (sv) Object.assign(sv, { Status: 'Running', StartType: 'Automatic', CanStop: true })
    else services.push(psObject('System.ServiceProcess.ServiceController', { Status: 'Running', Name: name, DisplayName: display, ServiceName: name, StartType: 'Automatic', CanStop: true }))
  }
  for (const f of (s.data.features ?? []) as PsObject[]) {
    if (['ad-domain-services', 'dns', 'rsat-ad-tools', 'rsat-ad-powershell', 'rsat-adds', 'rsat-dns-server', 'gpmc'].includes(toText(f.Name).toLowerCase())) Object.assign(f, { Installed: true, InstallState: 'Installed' })
  }
  const mods = (s.data.modules ??= []) as string[]
  for (const m of ['ActiveDirectory', 'GroupPolicy', 'DnsServer', 'ADDSDeployment']) if (!mods.includes(m)) mods.push(m)
  const rules = (s.data.firewallRules ??= []) as PsObject[]
  for (const r of DC_RULES) if (!rules.some((x) => x.Name === r.name)) rules.push(ruleObject(r))
  delete s.data.netProfile
  const dcOu = `OU=Domain Controllers,${st.domainDn}`
  const c = st.computers.find((x) => toText(x.Name).toLowerCase() === s.state.equipo.toLowerCase())
  if (c) c.__parent = dcOu
  else st.computers.push(computerObject(st, s.state.equipo, dcOu, `Windows Server 2025 ${s.state.edicion}`))
  s.state.red.dns = dnsServers
  delete s.data.tokenGroups
}

const MODES: Record<string, string> = { win2025: 'Windows2025', '10': 'Windows2025', default: 'Windows2025', winthreshold: 'Windows2016', win2016: 'Windows2016', '7': 'Windows2016' }
const OLD_MODES = ['win2008', 'win2008r2', 'win2012', 'win2012r2', '3', '4', '5', '6']

function parseMode(ctx: CmdletContext, name: 'ForestMode' | 'DomainMode'): string {
  const raw = (str(ctx, name) ?? 'Default').toLowerCase()
  if (MODES[raw]) return MODES[raw]
  if (OLD_MODES.includes(raw)) throw new PsError(`Verification of prerequisites for Domain Controller promotion failed. The specified ${name === 'ForestMode' ? 'forest' : 'domain'} functional level is not supported. A new forest created with Windows Server 2025 requires at least the Windows Server 2016 functional level.`, 'InvalidArgument', `Test.VerifyDcPromoCore.DCPromo.General.77,Microsoft.DirectoryServices.Deployment.PowerShell.Commands.InstallADDSForestCommand`)
  throw new PsError(`Cannot bind parameter '${name}'. Cannot convert value "${str(ctx, name)}" to type "Microsoft.DirectoryServices.Deployment.Types.${name === 'ForestMode' ? 'ForestMode' : 'DomainMode'}". Error: "Unable to match the identifier name ${str(ctx, name)} to a valid enumerator name. Specify one of the following enumerator names and try again:\nWin2008, Win2008R2, Win2012, Win2012R2, WinThreshold, Win2025, Default"`, 'InvalidArgument', 'CannotConvertArgumentNoMessage')
}

function promoWarnings(ctx: CmdletContext, domain: string, forest: boolean) {
  const r = ctx.s.state.red
  if (r.dhcp) ctx.host('WARNING: This computer has at least one physical network adapter that does not have static IP address(es) assigned to its IP Properties. If both IPv4 and IPv6 are enabled for a network adapter, both IPv4 and IPv6 static IP addresses should be assigned to both IPv4 and IPv6 Properties of the physical network adapter. Such static IP address(es) assignment should be done to all the physical network adapters for reliable Domain Name System (DNS) operation.\n\n')
  ctx.host('WARNING: Windows Server 2025 domain controllers have a default for the security setting named "Allow cryptography algorithms compatible with Windows NT 4.0" that prevents weaker cryptography algorithms when establishing security channel sessions.\n\nFor more information about this setting, see Knowledge Base article 942564 (http://go.microsoft.com/fwlink/?LinkId=104751).\n\n')
  if (forest) ctx.host(`WARNING: A delegation for this DNS server cannot be created because the authoritative parent zone cannot be found or it does not run Windows DNS server. If you are integrating with an existing DNS infrastructure, you should manually create a delegation to this DNS server in the parent zone to ensure reliable name resolution from outside the domain "${domain}". Otherwise, no action is required.\n\n`)
}

function safeModePassword(ctx: CmdletContext) {
  const pwd = param(ctx, 'SafeModeAdministratorPassword')
  if (pwd === undefined) {
    ctx.host('SafeModeAdministratorPassword: ************\nConfirm SafeModeAdministratorPassword: ************\n[simulador] Sin -SafeModeAdministratorPassword, PowerShell pide la contraseña del modo de restauración (DSRM) dos veces. Guardala bien: es la que se usa para restaurar AD.\n')
    return
  }
  if (!isSecure(pwd)) throw new PsError(`Cannot bind parameter 'SafeModeAdministratorPassword'. Cannot convert the "${toText(pwd)}" value of type "System.String" to type "System.Security.SecureString".`, 'InvalidArgument', 'CannotConvertArgumentNoMessage')
}

function promoConfirm(ctx: CmdletContext) {
  if (has(ctx, 'Force') || ctx.params.get('confirm') === false) return
  ctx.host('The target server will be configured as a domain controller and restarted when this operation is complete.\nDo you want to continue with this operation?\n[Y] Yes  [A] Yes to All  [N] No  [L] No to All  [S] Suspend  [?] Help (default is "Y"): Y\n')
}

function promoResult(ctx: CmdletContext, apply: () => void) {
  onRestart(ctx.s, apply)
  const result = psObject('Microsoft.DirectoryServices.Deployment.Types.DCPromoResult', { Message: 'Operation completed successfully', Context: 'DCPromo.General.3', RebootRequired: false, Status: 'Success' })
  if (has(ctx, 'NoRebootOnCompletion')) {
    ctx.host('WARNING: You must restart this computer to complete the operation.\n')
    return [result]
  }
  ctx.host('\nYou will be signed out shortly; the computer is being restarted to finish promoting it to a domain controller.\n')
  ctx.s.data.promoOutput = [result]
  restart(ctx)
  return [result]
}

function promoCheckBase(ctx: CmdletContext, cmd: string) {
  if (isDc(ctx.s.state, ctx.s.lab)) throw new PsError('Verification of prerequisites for Domain Controller promotion failed. The server is already a domain controller.', 'InvalidOperation', `Test.VerifyDcPromoCore.DCPromo.General.25,Microsoft.DirectoryServices.Deployment.PowerShell.Commands.${cmd}`)
  if (ctx.s.data.onRestart && ((ctx.s.data.onRestart as unknown[]).length > 0) && ctx.s.data.promoPending?.[0]) throw new PsError('Verification of prerequisites for Domain Controller promotion failed. A previous promotion is pending: restart the computer first.', 'InvalidOperation', `Test.VerifyDcPromoCore.DCPromo.General.62,Microsoft.DirectoryServices.Deployment.PowerShell.Commands.${cmd}`)
}

cmdlet('Install-ADDSForest', {
  params: ['DomainName', 'DomainNetbiosName', 'ForestMode', 'DomainMode', 'SafeModeAdministratorPassword', 'DatabasePath', 'LogPath', 'SysvolPath'],
  switches: ['InstallDns', 'NoRebootOnCompletion', 'Force', 'CreateDnsDelegation', 'NoDnsOnNetwork'],
  synopsis: 'Installs a new Active Directory forest configuration.',
  module: 'ADDSDeployment',
  run(ctx) {
    promoCheckBase(ctx, 'InstallADDSForestCommand')
    const domain = str(ctx, 'DomainName')?.toLowerCase()
    if (!domain) throw new PsError('Cannot process command because of one or more missing mandatory parameters: DomainName.', 'InvalidArgument', 'MissingMandatoryParameter,Microsoft.DirectoryServices.Deployment.PowerShell.Commands.InstallADDSForestCommand')
    if (!domain.includes('.')) throw new PsError(`Verification of prerequisites for Domain Controller promotion failed. The domain name "${domain}" is a single-label DNS name. Single-label domain names are not supported; use a name like "empresa.local" or "ad.empresa.com.ar".`, 'InvalidArgument', 'Test.VerifyDcPromoCore.DCPromo.General.13,Microsoft.DirectoryServices.Deployment.PowerShell.Commands.InstallADDSForestCommand', domain)
    if (ctx.s.lab?.adStores.has(domain)) throw new PsError(`Verification of prerequisites for Domain Controller promotion failed. The domain "${domain}" already exists on the network. To add this server to it, use Install-ADDSDomainController.`, 'InvalidArgument', 'Test.VerifyDcPromoCore.DCPromo.General.29,Microsoft.DirectoryServices.Deployment.PowerShell.Commands.InstallADDSForestCommand', domain)
    const netbios = (str(ctx, 'DomainNetbiosName') ?? domain.split('.')[0]).toUpperCase()
    if (netbios.length > 15) throw new PsError(`Verification of prerequisites for Domain Controller promotion failed. The NetBIOS name "${netbios}" is longer than 15 characters.`, 'InvalidArgument', 'Test.VerifyDcPromoCore.DCPromo.General.15,Microsoft.DirectoryServices.Deployment.PowerShell.Commands.InstallADDSForestCommand', netbios)
    const forest = parseMode(ctx, 'ForestMode')
    const dom = parseMode(ctx, 'DomainMode')
    if (forest === 'Windows2025' && dom === 'Windows2016') throw new PsError('Verification of prerequisites for Domain Controller promotion failed. The domain functional level cannot be lower than the forest functional level.', 'InvalidArgument', 'Test.VerifyDcPromoCore.DCPromo.General.78,Microsoft.DirectoryServices.Deployment.PowerShell.Commands.InstallADDSForestCommand')
    safeModePassword(ctx)
    promoWarnings(ctx, domain, true)
    promoConfirm(ctx)
    ctx.s.data.promoPending = [true]
    const s = ctx.s
    return promoResult(ctx, () => {
      const st = buildAdStore({ state: { ...s.state, dominio: domain, ad: { ous: [], usuarios: [], grupos: [], equipos: [], nivel_funcional: forest as 'Windows2025', papelera: false, bloquear_herencia: [], gpos: [] } } } as unknown as PsSession)!
      st.netbios = netbios
      st.forestMode = `${forest}Forest`
      st.domainMode = `${dom}Domain`
      promote(s, st, ['127.0.0.1'])
      s.data.promoPending = [false]
    })
  },
})

cmdlet('Install-ADDSDomainController', {
  params: ['DomainName', 'SiteName', 'SafeModeAdministratorPassword', 'ReplicationSourceDC', 'DatabasePath', 'LogPath', 'SysvolPath'],
  switches: ['InstallDns', 'NoGlobalCatalog', 'NoRebootOnCompletion', 'Force', 'CriticalReplicationOnly'],
  synopsis: 'Installs a domain controller in Active Directory.',
  module: 'ADDSDeployment',
  run(ctx) {
    promoCheckBase(ctx, 'InstallADDSDomainControllerCommand')
    const domain = str(ctx, 'DomainName')?.toLowerCase()
    if (!domain) throw new PsError('Cannot process command because of one or more missing mandatory parameters: DomainName.', 'InvalidArgument', 'MissingMandatoryParameter,Microsoft.DirectoryServices.Deployment.PowerShell.Commands.InstallADDSDomainControllerCommand')
    const found = locateDc(ctx.s, domain)
    if (!found.dc) throw new PsError(`Verification of prerequisites for Domain Controller promotion failed. An Active Directory domain controller for the domain "${domain}" could not be contacted.\n\nEnsure that you supplied the correct DNS domain name.`, 'ObjectNotFound', 'Test.VerifyDcPromoCore.DCPromo.General.17,Microsoft.DirectoryServices.Deployment.PowerShell.Commands.InstallADDSDomainControllerCommand', domain)
    if (ctx.s.state.dominio?.toLowerCase() !== domain && !has(ctx, 'Credential')) throw new PsError(`Verification of prerequisites for Domain Controller promotion failed. This computer is not joined to the domain "${domain}". Supply the credentials of a domain administrator with -Credential (Get-Credential).`, 'InvalidArgument', 'Test.VerifyDcPromoCore.DCPromo.General.33,Microsoft.DirectoryServices.Deployment.PowerShell.Commands.InstallADDSDomainControllerCommand', domain)
    if (skew(ctx.s, found.dc) > 5) throw new PsError('Verification of prerequisites for Domain Controller promotion failed. There is a time and/or date difference between the client and server. (Kerberos allows a difference of up to 5 minutes.)', 'InvalidOperation', 'Test.VerifyDcPromoCore.DCPromo.General.40,Microsoft.DirectoryServices.Deployment.PowerShell.Commands.InstallADDSDomainControllerCommand')
    safeModePassword(ctx)
    promoWarnings(ctx, domain, false)
    promoConfirm(ctx)
    ctx.s.data.promoPending = [true]
    const s = ctx.s
    const partner = found.dc.state.red.ip
    return promoResult(ctx, () => {
      const st = s.lab!.adStores.get(domain) as AdStore
      // Buena práctica: primero el otro DC y después el propio (127.0.0.1).
      promote(s, st, [partner, '127.0.0.1'])
      s.data.promoPending = [false]
    })
  },
})

cmdlet('Test-ADDSForestInstallation', {
  params: ['DomainName', 'SafeModeAdministratorPassword', 'ForestMode', 'DomainMode'],
  switches: ['InstallDns', 'Force'],
  synopsis: 'Runs the prerequisites for installing a new Active Directory forest.',
  module: 'ADDSDeployment',
  run(ctx) {
    const domain = str(ctx, 'DomainName') ?? ''
    const ok = domain.includes('.') && !isDc(ctx.s.state, ctx.s.lab)
    promoWarnings(ctx, domain, true)
    return [psObject('Microsoft.DirectoryServices.Deployment.Types.TestResult', { Message: ok ? 'Operation completed successfully' : 'Verification of prerequisites for Domain Controller promotion failed.', Context: 'Test.VerifyDcPromoCore.DCPromo.General.1', RebootRequired: false, Status: ok ? 'Success' : 'Error' })]
  },
})

// ---------------------------------------------------------------------------------------
// Unir un equipo al dominio
// ---------------------------------------------------------------------------------------

function joinError(s: PsSession, domain: string, msg: string) {
  return new PsError(`Computer '${s.state.equipo}' failed to join domain '${domain}' from its current workgroup 'WORKGROUP' with following error message: ${msg}`, 'OperationStopped', 'FailToJoinDomainFromWorkgroup,Microsoft.PowerShell.Commands.AddComputerCommand', s.state.equipo)
}

cmdlet('Add-Computer', {
  params: ['DomainName', 'OUPath', 'NewName', 'Server', 'ComputerName', 'WorkgroupName', 'Options'],
  switches: ['Restart', 'Force', 'PassThru'],
  positional: ['DomainName'],
  synopsis: 'Add the local computer to a domain or workgroup.',
  run(ctx) {
    const s = ctx.s
    const domain = str(ctx, 'DomainName')?.toLowerCase()
    if (!domain) throw new PsError("[simulador] Indicá el dominio con -DomainName (por ejemplo, Add-Computer -DomainName empresa.local -Credential EMPRESA\\Administrador -Restart).", 'InvalidArgument', 'MissingMandatoryParameter')
    if (isDc(s.state, s.lab)) throw new PsError(`Cannot add computer '${s.state.equipo}' to domain '${domain}' because it is a domain controller.`, 'InvalidOperation', 'InvalidOperation,Microsoft.PowerShell.Commands.AddComputerCommand', s.state.equipo)
    if (s.state.dominio?.toLowerCase() === domain) throw new PsError(`Cannot add computer '${s.state.equipo}' to domain '${domain}' because it is already in that domain.`, 'InvalidOperation', 'AddComputerToSameDomain,Microsoft.PowerShell.Commands.AddComputerCommand', s.state.equipo)
    const found = locateDc(s, domain)
    if (!found.dc) throw joinError(s, domain, 'The specified domain either does not exist or could not be contacted.')
    if (skew(s, found.dc) > 5) throw joinError(s, domain, 'The time at the Primary Domain Controller is different than the time at the Backup Domain Controller or member server by too large an amount.')
    if (!has(ctx, 'Credential')) ctx.host(`[simulador] Sin -Credential, Windows pide usuario y contraseña de una cuenta del dominio que pueda unir equipos (por ejemplo ${domain.split('.')[0].toUpperCase()}\\Administrador); se da por escrita.\n`)
    const st = s.lab!.adStores.get(domain) as AdStore
    const ou = str(ctx, 'OUPath')
    if (ou && !containerExists(st, ou)) throw joinError(s, domain, 'The parameter is incorrect.')
    // La cuenta de equipo se crea (o se reutiliza si estaba creada de antes) en el momento de unirse.
    const name = str(ctx, 'NewName') ?? s.state.equipo
    const existing = st.computers.find((c) => toText(c.Name).toLowerCase() === name.toLowerCase())
    if (existing) {
      existing.Enabled = true
      if (ou) existing.__parent = ou
    } else st.computers.push(computerObject(st, name, ou ?? st.defaultComputers ?? `CN=Computers,${st.domainDn}`, s.state.experiencia === 'core' || /server/i.test(s.state.edicion) ? `Windows Server 2025 ${s.state.edicion}` : 'Windows 11 Pro'))
    if (str(ctx, 'NewName')) s.pending.name = name
    s.data.pendingDomain = [domain]
    onRestart(s, () => {
      s.state.dominio = domain
      s.data.domainStore = [st]
      delete s.data.netProfile
      s.data.pendingDomain = []
      if (s.data.modules && (s.data.modules as string[]).includes('ActiveDirectory')) s.data.ad = [st]
    })
    if (has(ctx, 'Restart')) {
      restart(ctx)
      return []
    }
    ctx.host(`WARNING: The changes will take effect after you restart the computer ${s.state.equipo}.\n`)
    return has(ctx, 'PassThru') ? [psObject('Microsoft.PowerShell.Commands.ComputerChangeInfo', { HasSucceeded: true, ComputerName: s.state.equipo })] : []
  },
})

cmdlet('Remove-Computer', {
  params: ['UnjoinDomainCredential', 'WorkgroupName', 'ComputerName'],
  switches: ['Restart', 'Force', 'PassThru'],
  synopsis: 'Removes the local computer from its domain.',
  run(ctx) {
    const s = ctx.s
    if (!s.state.dominio) throw new PsError(`The computer '${s.state.equipo}' is not in a domain.`, 'InvalidOperation', 'ComputerNotInDomain,Microsoft.PowerShell.Commands.RemoveComputerCommand')
    if (isDc(s.state, s.lab)) throw new PsError('Cannot remove a domain controller from its domain. Demote it first (Uninstall-ADDSDomainController).', 'InvalidOperation', 'InvalidOperation,Microsoft.PowerShell.Commands.RemoveComputerCommand')
    const st = s.data.domainStore?.[0] as AdStore | undefined
    const c = st?.computers.find((x) => toText(x.Name).toLowerCase() === s.state.equipo.toLowerCase())
    if (c && locateDc(s).dc) c.Enabled = false
    onRestart(s, () => {
      s.state.dominio = undefined
      delete s.data.domainStore
      delete s.data.ad
    })
    if (has(ctx, 'Restart')) restart(ctx)
    else ctx.host(`WARNING: The changes will take effect after you restart the computer ${s.state.equipo}.\n`)
    return []
  },
})

cmdlet('Test-ComputerSecureChannel', {
  params: ['Server', 'Credential'],
  switches: ['Repair'],
  synopsis: 'Tests and repairs the secure channel between the local computer and its domain.',
  run(ctx) {
    const s = ctx.s
    if (!s.state.dominio) throw new PsError('Cannot verify the secure channel password for the local computer. Local computer is not joined to a domain.', 'InvalidOperation', 'ComputerNotInDomain,Microsoft.PowerShell.Commands.TestComputerSecureChannelCommand')
    const found = locateDc(s)
    const st = s.data.domainStore?.[0] as AdStore | undefined
    const c = st?.computers.find((x) => toText(x.Name).toLowerCase() === s.state.equipo.toLowerCase())
    if (found.dc && has(ctx, 'Repair')) {
      if (c) {
        c.Enabled = true
        c.__brokenTrust = false
      } else if (st) st.computers.push(computerObject(st, s.state.equipo, `CN=Computers,${st.domainDn}`, `Windows Server 2025 ${s.state.edicion}`))
      return [true]
    }
    return [!!found.dc && !!c && c.Enabled === true && !c.__brokenTrust]
  },
})

// ---------------------------------------------------------------------------------------
// Controladores, bosque y roles FSMO
// ---------------------------------------------------------------------------------------

const ROLE_NUMBERS: Record<string, FsmoRole> = { '0': 'PDCEmulator', '1': 'RIDMaster', '2': 'InfrastructureMaster', '3': 'SchemaMaster', '4': 'DomainNamingMaster' }

function dcStates(ctx: CmdletContext, st: AdStore) {
  const states = domainControllers(ctx.s.lab, st.domain)
  if (!states.length && isDc(ctx.s.state, ctx.s.lab)) return [ctx.s.state]
  return states
}

function dcObject(ctx: CmdletContext, st: AdStore, name: string): PsObject {
  const state = labStates(ctx.s.lab).find((x) => x.equipo.toLowerCase() === name.toLowerCase())
  const f = fsmoOf(st, name)
  const roles = FSMO_ROLES.filter((r) => f[r].toLowerCase() === name.toLowerCase())
  return psObject(`${NS}.ADDomainController`, {
    ComputerObjectDN: `CN=${name},OU=Domain Controllers,${st.domainDn}`,
    DefaultPartition: st.domainDn,
    Domain: st.domain,
    Enabled: true,
    Forest: st.domain,
    HostName: fqdn(name, st.domain),
    InvocationId: stableGuid(`inv:${name}`),
    IPv4Address: state?.red.ip ?? null,
    IPv6Address: null,
    IsGlobalCatalog: true,
    IsReadOnly: false,
    LdapPort: 389,
    Name: name,
    NTDSSettingsObjectDN: `CN=NTDS Settings,CN=${name},CN=Servers,CN=${SITE},CN=Sites,CN=Configuration,${st.domainDn}`,
    OperatingSystem: `Windows Server 2025 ${state?.edicion ?? 'Standard'}`,
    OperatingSystemVersion: '10.0 (26100)',
    OperationMasterRoles: roles,
    Partitions: [`DC=ForestDnsZones,${st.domainDn}`, `DC=DomainDnsZones,${st.domainDn}`, `CN=Schema,CN=Configuration,${st.domainDn}`, `CN=Configuration,${st.domainDn}`, st.domainDn],
    ServerObjectDN: `CN=${name},CN=Servers,CN=${SITE},CN=Sites,CN=Configuration,${st.domainDn}`,
    Site: SITE,
    SslPort: 636,
  })
}

adCmdlet('Get-ADDomainController', {
  params: ['Identity', 'Filter', 'Server', 'DomainName', 'Service'],
  switches: ['Discover', 'ForceDiscover', 'NextClosestSite'],
  positional: ['Identity'],
  synopsis: 'Gets one or more Active Directory domain controllers based on discoverable services criteria, search parameters or by providing a domain controller identifier, such as the NetBIOS name.',
  run(ctx) {
    const st = store(ctx.s)
    const names = dcStates(ctx, st).map((x) => x.equipo)
    if (has(ctx, 'Identity')) {
      const id = identityText(param(ctx, 'Identity')).toLowerCase().split('.')[0]
      const n = names.find((x) => x.toLowerCase() === id)
      if (!n) throw new PsError(`Cannot find directory server with identity: '${identityText(param(ctx, 'Identity'))}'.`, 'ObjectNotFound', `ActiveDirectoryCmdlet:${NS}.ADServerDownException,${NS}.Commands.GetADDomainController`)
      return [dcObject(ctx, st, n)]
    }
    if (has(ctx, 'Filter')) {
      let pred: Pred
      try {
        pred = compileFilter(st, ctx.s, toText(param(ctx, 'Filter')))
      } catch (e) {
        throw filterError(toText(param(ctx, 'Filter')), (e as Error).message, 'GetADDomainController')
      }
      return names.map((n) => dcObject(ctx, st, n)).filter((o) => pred(o))
    }
    const found = locateDc(ctx.s)
    if (!found.dc) throw new PsError('Unable to find a default server with Active Directory Web Services running.', 'ResourceUnavailable', `ActiveDirectoryCmdlet:${NS}.ADServerDownException,${NS}.Commands.GetADDomainController`)
    return [dcObject(ctx, st, found.dc.state.equipo)]
  },
})

adCmdlet('Get-ADForest', {
  params: ['Identity', 'Server'],
  synopsis: 'Gets an Active Directory forest.',
  run(ctx) {
    const st = store(ctx.s)
    const f = fsmoOf(st, ctx.s.state.equipo)
    return [
      psObject(`${NS}.ADForest`, {
        ApplicationPartitions: [`DC=DomainDnsZones,${st.domainDn}`, `DC=ForestDnsZones,${st.domainDn}`],
        CrossForestReferences: [],
        DomainNamingMaster: fqdn(f.DomainNamingMaster, st.domain),
        Domains: [st.domain],
        ForestMode: st.forestMode ?? 'Windows2025Forest',
        GlobalCatalogs: dcStates(ctx, st).map((x) => fqdn(x.equipo, st.domain)),
        Name: st.domain,
        PartitionsContainer: `CN=Partitions,CN=Configuration,${st.domainDn}`,
        RootDomain: st.domain,
        SchemaMaster: fqdn(f.SchemaMaster, st.domain),
        Sites: [SITE],
        SPNSuffixes: [],
        UPNSuffixes: [],
      }),
    ]
  },
})

for (const [cmd, kind] of [['Set-ADForestMode', 'Forest'], ['Set-ADDomainMode', 'Domain']] as const) {
  adCmdlet(cmd, {
    params: ['Identity', `${kind}Mode`, 'Server'],
    positional: ['Identity', `${kind}Mode`],
    synopsis: `Sets the ${kind.toLowerCase()} mode for an Active Directory ${kind.toLowerCase()}.`,
    run(ctx) {
      const st = store(ctx.s)
      const raw = (str(ctx, `${kind}Mode`) ?? '').toLowerCase()
      const value = raw.includes('2025') || raw === '10' ? 'Windows2025' : raw.includes('2016') || raw === '7' ? 'Windows2016' : undefined
      if (!value) throw new PsError(`Cannot bind parameter '${kind}Mode'. Cannot convert value "${str(ctx, `${kind}Mode`)}" to type "${NS}.AD${kind}Mode".`, 'InvalidArgument', 'CannotConvertArgumentNoMessage')
      const current = (kind === 'Forest' ? st.forestMode : st.domainMode) ?? `Windows2025${kind}`
      if (current.startsWith('Windows2025') && value === 'Windows2016') throw new PsError(`The functional level cannot be lowered from ${current} to ${value}${kind}: once the optional features are in use, going back is not supported.`, 'InvalidOperation', `ActiveDirectoryOperationException,${NS}.Commands.Set${kind === 'Forest' ? 'ADForestMode' : 'ADDomainMode'}`)
      confirmPrompt(ctx, `Set`, `${st.domainDn}`)
      if (kind === 'Forest') st.forestMode = `${value}Forest`
      else st.domainMode = `${value}Domain`
      return []
    },
  })
}

adCmdlet('Move-ADDirectoryServerOperationMasterRole', {
  params: ['Identity', 'OperationMasterRole', 'Server'],
  switches: ['Force', 'PassThru'],
  positional: ['Identity', 'OperationMasterRole'],
  synopsis: 'Moves operation master (also known as flexible single master operations or FSMO) roles to an Active Directory directory server.',
  run(ctx) {
    const st = store(ctx.s)
    const target = identityText(param(ctx, 'Identity')).split('.')[0]
    const targetState = dcStates(ctx, st).find((x) => x.equipo.toLowerCase() === target.toLowerCase())
    if (!targetState) throw new PsError(`Cannot find an object with identity: '${target}' under: 'CN=Configuration,${st.domainDn}'.`, 'ObjectNotFound', `ActiveDirectoryCmdlet:${NS}.ADIdentityNotFoundException,${NS}.Commands.MoveADDirectoryServerOperationMasterRole`, target)
    const roles = asArray(param(ctx, 'OperationMasterRole')).flatMap((r) => toText(r).split(',')).map((r) => {
      const t = r.trim()
      const role = ROLE_NUMBERS[t] ?? FSMO_ROLES.find((x) => x.toLowerCase() === t.toLowerCase())
      if (!role) throw new PsError(`Cannot bind parameter 'OperationMasterRole'. Cannot convert value "${t}" to type "${NS}.ADOperationMasterRole". Error: "Unable to match the identifier name ${t} to a valid enumerator name. Specify one of the following enumerator names and try again:\nPDCEmulator, RIDMaster, InfrastructureMaster, SchemaMaster, DomainNamingMaster"`, 'InvalidArgument', 'CannotConvertArgumentNoMessage')
      return role
    })
    const f = fsmoOf(st, ctx.s.state.equipo)
    const targetSession = ctx.s.lab?.find(targetState.equipo) ?? ctx.s
    for (const role of roles) {
      const holder = f[role]
      if (holder.toLowerCase() === target.toLowerCase()) continue
      const holderSession = ctx.s.lab?.find(holder)
      const reachable = !!holderSession && (holderSession === targetSession || reach(targetSession, holderSession.state.red.ip, 389).ok) && serviceRunning(holderSession, 'NTDS')
      if (!reachable && !has(ctx, 'Force')) throw new PsError(`The requested FSMO operation failed. The current FSMO holder could not be contacted.`, 'NotSpecified', `ActiveDirectoryServer:8344,${NS}.Commands.MoveADDirectoryServerOperationMasterRole`)
      if (ctx.params.get('confirm') !== false) ctx.host(`\nMove Operation Master Role\nDo you want to move role '${role}' to server '${fqdn(targetState.equipo, st.domain)}' ?\n[Y] Yes  [A] Yes to All  [N] No  [L] No to All  [S] Suspend  [?] Help (default is "Y"): Y\n`)
      if (!reachable) ctx.host(`[simulador] Tomaste el rol ${role} a la fuerza (seize) porque ${holder} no responde. Ese controlador no puede volver a la red así: hay que reinstalarlo o limpiar sus datos (metadata cleanup).\n`)
      f[role] = targetState.equipo
    }
    return has(ctx, 'PassThru') ? [dcObject(ctx, st, targetState.equipo)] : []
  },
})

// ---------------------------------------------------------------------------------------
// Papelera de reciclaje y objetos borrados
// ---------------------------------------------------------------------------------------

const RECYCLE = 'Recycle Bin Feature'
const PAM = 'Privileged Access Management Feature'

function optionalFeature(st: AdStore, name: string): PsObject {
  const enabled = name === RECYCLE ? !!st.recycleBin : false
  return psObject(`${NS}.ADOptionalFeature`, {
    DistinguishedName: `CN=${name},CN=Optional Features,CN=Directory Service,CN=Windows NT,CN=Services,CN=Configuration,${st.domainDn}`,
    EnabledScopes: enabled ? [`CN=Partitions,CN=Configuration,${st.domainDn}`, `CN=NTDS Settings,CN=${st.fsmo?.SchemaMaster ?? 'DC01'},CN=Servers,CN=${SITE},CN=Sites,CN=Configuration,${st.domainDn}`] : [],
    FeatureGUID: name === RECYCLE ? '766ddcd8-acd0-445e-f3b9-a7f9b6744f2a' : 'ec43e873-cce8-4640-b4ab-07ffe4ab5bcd',
    FeatureScope: ['ForestOrConfigurationSet'],
    IsDisableable: false,
    Name: name,
    ObjectClass: 'msDS-OptionalFeature',
    ObjectGUID: stableGuid(`feature:${name}`),
    RequiredDomainMode: null,
    RequiredForestMode: name === RECYCLE ? 'Windows2008R2Forest' : 'Windows2016Forest',
  })
}

adCmdlet('Get-ADOptionalFeature', {
  params: ['Identity', 'Filter', 'Server'],
  positional: ['Identity'],
  synopsis: 'Gets one or more Active Directory optional features.',
  run(ctx) {
    const st = store(ctx.s)
    const all = [optionalFeature(st, RECYCLE), optionalFeature(st, PAM)]
    if (has(ctx, 'Identity')) {
      const id = identityText(param(ctx, 'Identity'))
      const f = all.find((x) => psEquals(x.Name, id) || psEquals(x.FeatureGUID, id))
      if (!f) throw notFound(st, id, 'GetADOptionalFeature')
      return [f]
    }
    return all
  },
})

adCmdlet('Enable-ADOptionalFeature', {
  params: ['Identity', 'Scope', 'Target', 'Server'],
  positional: ['Identity', 'Scope', 'Target'],
  synopsis: 'Enables an Active Directory optional feature.',
  run(ctx) {
    const st = store(ctx.s)
    const id = identityText(param(ctx, 'Identity'))
    if (!psEquals(id, RECYCLE) && !psEquals(id, PAM)) throw notFound(st, id, 'EnableADOptionalFeature')
    if (!psEquals(param(ctx, 'Scope'), 'ForestOrConfigurationSet')) throw new PsError(`[simulador] La papelera se activa para todo el bosque: -Scope ForestOrConfigurationSet -Target ${st.domain}`, 'InvalidArgument', 'InvalidScope')
    if (psEquals(id, PAM)) {
      ctx.host('[simulador] La administración de acceso privilegiado (PAM) es para más adelante; no se simula.\n')
      return []
    }
    if (st.recycleBin) throw new PsError(`The feature '${RECYCLE}' is already enabled on 'CN=Partitions,CN=Configuration,${st.domainDn}'.`, 'InvalidOperation', `ActiveDirectoryServer:8411,${NS}.Commands.EnableADOptionalFeature`)
    ctx.host(`WARNING: Enabling '${RECYCLE}' on 'CN=Partitions,CN=Configuration,${st.domainDn}' is an irreversible action! You will not be able to disable '${RECYCLE}' on 'CN=Partitions,CN=Configuration,${st.domainDn}' if you proceed.\n`)
    if (ctx.params.get('confirm') !== false) ctx.host(`\nConfirm\nAre you sure you want to perform this action?\nPerforming the operation "Enable" on target "${RECYCLE}".\n[Y] Yes  [A] Yes to All  [N] No  [L] No to All  [S] Suspend  [?] Help (default is "Y"): Y\n`)
    st.recycleBin = true
    return []
  },
})

function deletedView(st: AdStore, o: PsObject): PsObject {
  const guid = toText(o.ObjectGUID)
  return { ...o, Name: `${toText(o.Name)}\nDEL:${guid}`, Deleted: true, isDeleted: true, LastKnownParent: o.__lastParent, __parent: `CN=Deleted Objects,${st.domainDn}`, __deletedOf: guid } as PsObject
}

function presentObject(st: AdStore, o: PsObject, props: unknown[], withDeleted: boolean): PsObject {
  const names = new Set(['DistinguishedName', 'Name', 'ObjectClass', 'ObjectGUID', ...(withDeleted ? ['Deleted'] : [])])
  for (const p of props.map(toText)) {
    if (p === '*') for (const k of Object.keys(o)) if (!k.startsWith('__')) names.add(k)
    else names.add(Object.keys(o).find((k) => k.toLowerCase() === p.toLowerCase()) ?? p)
  }
  const out: Record<string, unknown> = {}
  for (const n of [...names].sort((a, b) => a.localeCompare(b))) {
    if (n === 'DistinguishedName' && o.__deletedOf) out[n] = `CN=${toText(o.Name).replace('\n', '\\0A')},CN=Deleted Objects,${st.domainDn}`
    else if (n === 'Deleted') out[n] = o.Deleted === true ? true : null
    else out[n] = computed(st, o, n)
  }
  return psObject(`${NS}.ADObject`, { ...out, __toString: toText(out.DistinguishedName) })
}

adCmdlet('Get-ADObject', {
  params: ['Identity', 'Filter', 'LDAPFilter', 'Properties', 'SearchBase', 'SearchScope', 'Server', 'ResultSetSize'],
  switches: ['IncludeDeletedObjects'],
  positional: ['Identity'],
  synopsis: 'Gets one or more Active Directory objects.',
  run(ctx) {
    const st = store(ctx.s)
    const include = has(ctx, 'IncludeDeletedObjects')
    const props = asArray(param(ctx, 'Properties'))
    const list = [...allObjects(st), ...(include ? (st.deleted ?? []).map((d) => deletedView(st, d)) : [])]
    if (has(ctx, 'Identity')) {
      const id = identityText(param(ctx, 'Identity'))
      const o = list.find((x) => sameIdentity(st, id, x) || psEquals(x.__deletedOf, id))
      if (!o) throw notFound(st, id, 'GetADObject')
      return [presentObject(st, o, props, include)]
    }
    const src = has(ctx, 'LDAPFilter') ? toText(param(ctx, 'LDAPFilter')) : toText(param(ctx, 'Filter') ?? '')
    if (!src) {
      ctx.host('\n[simulador] -Filter es obligatorio cuando no se indica -Identity. Para ver los borrados: Get-ADObject -Filter \'isDeleted -eq $true\' -IncludeDeletedObjects\n')
      return []
    }
    let pred: Pred
    try {
      pred = has(ctx, 'LDAPFilter') ? compileLdap(st, src) : compileFilter(st, ctx.s, src)
    } catch (e) {
      throw filterError(src, (e as Error).message, 'GetADObject')
    }
    const base = str(ctx, 'SearchBase')
    return list.filter((o) => (!base || toText(o.__parent).toLowerCase().endsWith(base.toLowerCase()) || sameDn(toText(o.__parent), base)) && pred(o)).map((o) => presentObject(st, o, props, include))
  },
})

adCmdlet('Restore-ADObject', {
  params: ['Identity', 'TargetPath', 'NewName', 'Server'],
  switches: ['PassThru'],
  positional: ['Identity'],
  synopsis: 'Restores an Active Directory object.',
  run(ctx) {
    const st = store(ctx.s)
    const ids = has(ctx, 'Identity') ? [param(ctx, 'Identity')] : ctx.input
    const out: PsObject[] = []
    for (const raw of ids) {
      const guid = toText((raw as PsObject)?.ObjectGUID ?? identityText(raw))
      const idx = (st.deleted ?? []).findIndex((d) => psEquals(d.ObjectGUID, guid) || toText(raw).toLowerCase().includes(toText(d.ObjectGUID).toLowerCase()))
      if (idx < 0) throw notFound(st, guid, 'RestoreADObject')
      const d = st.deleted![idx]
      const parent = str(ctx, 'TargetPath') ?? toText(d.__lastParent)
      if (!containerExists(st, parent)) throw new PsError("The operation could not be performed because the object's parent is either uninstantiated or deleted", 'NotSpecified', `ActiveDirectoryServer:8409,${NS}.Commands.RestoreADObject`, parent)
      const restored: PsObject = { ...d, __parent: parent }
      for (const k of ['__deletedAt', '__lastParent', '__groups', '__recyclable']) delete restored[k]
      if (!d.__recyclable) {
        // Sin papelera solo queda la "lápida" (tombstone): vuelve sin grupos ni datos y deshabilitado.
        for (const k of ['Department', 'Title', 'Description', 'EmailAddress', 'Office', 'City', 'Company', 'GivenName', 'Surname', 'DisplayName', 'UserPrincipalName']) if (k in restored) restored[k] = null
        if ('Enabled' in restored) restored.Enabled = false
        restored.__noPassword = true
        ctx.host(`[simulador] La papelera de AD no estaba activa cuando se borró "${toText(d.Name)}": volvió como una lápida reanimada, sin grupos, sin datos y deshabilitada. Con la papelera activa vuelve entera.\n`)
      } else {
        for (const gName of asArray(d.__groups).map(toText)) {
          const g = st.groups.find((x) => psEquals(x.Name, gName))
          if (g && !asArray(g.__members).some((m) => sameIdentity(st, toText(m), d))) g.__members = [...asArray(g.__members), toText(d.SamAccountName ?? d.Name)]
        }
      }
      const key = d.ObjectClass === 'user' ? 'users' : d.ObjectClass === 'group' ? 'groups' : d.ObjectClass === 'organizationalUnit' ? 'ous' : 'computers'
      st[key].push(restored)
      st.deleted!.splice(idx, 1)
      if (has(ctx, 'PassThru')) out.push(present(st, restored))
    }
    return out
  },
})

// ---------------------------------------------------------------------------------------
// Equipos (cuentas creadas a mano)
// ---------------------------------------------------------------------------------------

adCmdlet('New-ADComputer', {
  params: ['Name', 'SamAccountName', 'Path', 'Description', 'Enabled', 'DNSHostName'],
  switches: ['PassThru'],
  positional: ['Name'],
  synopsis: 'Creates a new Active Directory computer object.',
  run(ctx) {
    const st = store(ctx.s)
    const name = str(ctx, 'Name')!
    const path = str(ctx, 'Path') ?? `CN=Computers,${st.domainDn}`
    if (!containerExists(st, path)) throw new PsError('Directory object not found', 'ObjectNotFound', `ActiveDirectoryCmdlet:${NS}.ADIdentityNotFoundException,${NS}.Commands.NewADComputer`, path)
    if (st.computers.some((c) => psEquals(c.Name, name))) throw new PsError('The specified account already exists', 'ResourceExists', `ActiveDirectoryServer:1316,${NS}.Commands.NewADComputer`, name)
    const c = computerObject(st, name, path, '')
    c.OperatingSystem = null
    c.LastLogonDate = null
    c.Description = str(ctx, 'Description') ?? null
    if (has(ctx, 'Enabled')) c.Enabled = truthyParam(param(ctx, 'Enabled'))
    st.computers.push(c)
    return has(ctx, 'PassThru') ? [present(st, c)] : []
  },
})

adCmdlet('Remove-ADComputer', {
  params: ['Identity'],
  positional: ['Identity'],
  synopsis: 'Removes an Active Directory computer.',
  run(ctx) {
    const st = store(ctx.s)
    for (const t of has(ctx, 'Identity') ? [param(ctx, 'Identity')] : ctx.input) {
      const c = resolve(st, st.computers, t, 'RemoveADComputer')
      if (!confirmPrompt(ctx, 'Remove', dnOf(c))) continue
      ;(st.deleted ??= []).push({ ...c, __deletedAt: new Date(), __lastParent: c.__parent, __groups: [], __recyclable: !!st.recycleBin })
      st.computers.splice(st.computers.indexOf(c), 1)
    }
    return []
  },
})

adCmdlet('Set-ADComputer', {
  params: ['Identity', 'Description', 'Enabled', 'Location', 'ManagedBy'],
  positional: ['Identity'],
  synopsis: 'Modifies an Active Directory computer object.',
  run(ctx) {
    const st = store(ctx.s)
    const c = resolve(st, st.computers, param(ctx, 'Identity') ?? ctx.input[0], 'SetADComputer')
    if (has(ctx, 'Description')) c.Description = str(ctx, 'Description') ?? null
    if (has(ctx, 'Enabled')) c.Enabled = truthyParam(param(ctx, 'Enabled'))
    if (has(ctx, 'Location')) c.Location = str(ctx, 'Location') ?? null
    c.Modified = new Date()
    return []
  },
})

// ---------------------------------------------------------------------------------------
// Grupos de un equipo o usuario (para gMSA y filtrado de GPO)
// ---------------------------------------------------------------------------------------

/** Nombres de todos los grupos (directos y anidados) a los que pertenece el objeto. */
export function groupNames(st: AdStore, o: PsObject): string[] {
  const out = new Set<string>()
  const primary = o.ObjectClass === 'computer' ? (sameDn(toText(o.__parent), `OU=Domain Controllers,${st.domainDn}`) ? 'Domain Controllers' : 'Domain Computers') : o.ObjectClass === 'user' ? 'Domain Users' : undefined
  if (primary) out.add(primary)
  const queue: PsObject[] = [o]
  const primaryGroup = primary ? st.groups.find((g) => psEquals(g.Name, primary)) : undefined
  if (primaryGroup) queue.push(primaryGroup)
  while (queue.length) {
    const cur = queue.shift()!
    for (const g of st.groups) {
      if (out.has(toText(g.Name)) && cur !== primaryGroup) continue
      if (asArray(g.__members).some((m) => sameIdentity(st, toText(m), cur) || psEquals(m, cur.Name))) {
        if (!out.has(toText(g.Name))) queue.push(g)
        out.add(toText(g.Name))
      }
    }
  }
  return [...out]
}

/** Grupos con los que arrancó el equipo: Windows no ve un grupo nuevo hasta reiniciar (o purgar los tickets). */
export function computerTokenGroups(s: PsSession, st: AdStore): string[] {
  if (s.data.tokenGroups) return s.data.tokenGroups as string[]
  const c = st.computers.find((x) => psEquals(x.Name, s.state.equipo))
  const groups = c ? groupNames(st, c) : []
  s.data.tokenGroups = groups
  return groups
}

// ---------------------------------------------------------------------------------------
// Cuentas de servicio administradas de grupo (gMSA)
// ---------------------------------------------------------------------------------------

function parseDate(v: unknown): Date | undefined {
  if (v instanceof Date) return v
  if (v === undefined || v === null) return undefined
  const d = new Date(toText(v))
  return Number.isNaN(d.getTime()) ? undefined : d
}

adCmdlet('Add-KdsRootKey', {
  params: ['EffectiveTime'],
  switches: ['EffectiveImmediately', 'LocalTestOnly'],
  synopsis: 'Generates a new root key for the Microsoft Group KdsSvc within Active Directory.',
  module: 'Kds',
  run(ctx) {
    const st = store(ctx.s)
    const effective = has(ctx, 'EffectiveImmediately') ? new Date() : (parseDate(param(ctx, 'EffectiveTime')) ?? new Date(Date.now() + 10 * 86_400_000))
    const id = stableGuid(`kds:${(st.kdsKeys ?? []).length}:${effective.toISOString()}`)
    ;(st.kdsKeys ??= []).push({ id, effective, created: new Date() })
    return [psObject('System.Guid', { Guid: id, __toString: id })]
  },
})

adCmdlet('Get-KdsRootKey', {
  synopsis: 'Gets the root keys for the Microsoft Group Key Distribution Service (KdsSvc) within Active Directory.',
  module: 'Kds',
  run(ctx) {
    const st = store(ctx.s)
    return (st.kdsKeys ?? []).map((k) => psObject('Microsoft.KeyDistributionService.Cmdlets.KdsRootKey', { AttributeOfWrongFormat: null, KeyValue: '{...}', EffectiveTime: k.effective, CreationTime: k.created, IsFormatValid: true, DomainController: `CN=${ctx.s.state.equipo},OU=Domain Controllers,${st.domainDn}`, ServerConfiguration: 'Microsoft.KeyDistributionService.Cmdlets.KdsServerConfiguration', KeyId: k.id, VersionNumber: 1 }))
  },
})

/** La clave raíz se puede usar recién 10 horas después de su fecha efectiva (para que replique). */
function kdsReady(st: AdStore) {
  return (st.kdsKeys ?? []).some((k) => k.effective.getTime() <= Date.now() - 10 * 3_600_000 + 60_000)
}

adCmdlet('New-ADServiceAccount', {
  params: ['Name', 'DNSHostName', 'PrincipalsAllowedToRetrieveManagedPassword', 'Path', 'Description', 'Enabled', 'KerberosEncryptionType', 'ManagedPasswordIntervalInDays', 'SamAccountName'],
  switches: ['PassThru', 'RestrictToSingleComputer'],
  positional: ['Name'],
  synopsis: 'Creates a new Active Directory managed service account or group managed service account object.',
  run(ctx) {
    const st = store(ctx.s)
    const name = str(ctx, 'Name')!
    if (name.length > 15) throw new PsError('The name provided is not a properly formed account name', 'InvalidArgument', `ActiveDirectoryServer:1315,${NS}.Commands.NewADServiceAccount`, name)
    if (!has(ctx, 'RestrictToSingleComputer') && !kdsReady(st)) {
      if ((st.kdsKeys ?? []).length) ctx.host('[simulador] La clave raíz de KDS existe pero todavía no es efectiva: con -EffectiveImmediately igual hay que esperar 10 horas a que replique. En un laboratorio de un solo DC se usa Add-KdsRootKey -EffectiveTime ((Get-Date).AddHours(-10)).\n')
      else ctx.host('[simulador] Para crear una gMSA primero hace falta la clave raíz de KDS: Add-KdsRootKey -EffectiveImmediately (en producción, y esperar 10 horas) o, en un laboratorio, Add-KdsRootKey -EffectiveTime ((Get-Date).AddHours(-10)).\n')
      throw new PsError('Key does not exist', 'NotSpecified', `ActiveDirectoryServer:0,${NS}.Commands.NewADServiceAccount`, name)
    }
    if (!has(ctx, 'RestrictToSingleComputer') && !has(ctx, 'DNSHostName')) throw new PsError("Cannot process command because of one or more missing mandatory parameters: DNSHostName.", 'InvalidArgument', `MissingMandatoryParameter,${NS}.Commands.NewADServiceAccount`)
    if (allObjects(st).some((o) => psEquals(o.SamAccountName, `${name}$`))) throw new PsError('The specified account already exists', 'ResourceExists', `ActiveDirectoryServer:1316,${NS}.Commands.NewADServiceAccount`, name)
    const principals = asArray(param(ctx, 'PrincipalsAllowedToRetrieveManagedPassword')).map(toText)
    for (const p of principals) if (!resolveAny(st, p)) throw notFound(st, p, 'NewADServiceAccount')
    const now = new Date()
    const msa = psObject(`${NS}.ADServiceAccount`, { Name: name, SamAccountName: `${name}$`, DNSHostName: str(ctx, 'DNSHostName') ?? null, Enabled: true, UserPrincipalName: null, Description: str(ctx, 'Description') ?? null, KerberosEncryptionType: 'RC4, AES128, AES256', ManagedPasswordIntervalInDays: Number(param(ctx, 'ManagedPasswordIntervalInDays') ?? 30), ObjectClass: 'msDS-GroupManagedServiceAccount', ObjectGUID: stableGuid(`gmsa:${name}`), SID: newSid(st), Created: now, Modified: now, __parent: str(ctx, 'Path') ?? `CN=Managed Service Accounts,${st.domainDn}`, __principals: principals })
    ;(st.serviceAccounts ??= []).push(msa)
    return has(ctx, 'PassThru') ? [present(st, msa)] : []
  },
})

adCmdlet('Get-ADServiceAccount', {
  params: ['Identity', 'Filter', 'LDAPFilter', 'Properties', 'SearchBase', 'Server'],
  positional: ['Identity'],
  synopsis: 'Gets one or more Active Directory managed service accounts or group managed service accounts.',
  run: (ctx) => search(ctx, store(ctx.s).serviceAccounts ?? [], 'GetADServiceAccount', 'Get-ADServiceAccount'),
})

adCmdlet('Set-ADServiceAccount', {
  params: ['Identity', 'PrincipalsAllowedToRetrieveManagedPassword', 'Description'],
  positional: ['Identity'],
  synopsis: 'Modifies an Active Directory managed service account or group managed service account object.',
  run(ctx) {
    const st = store(ctx.s)
    const msa = resolve(st, st.serviceAccounts ?? [], param(ctx, 'Identity') ?? ctx.input[0], 'SetADServiceAccount')
    if (has(ctx, 'PrincipalsAllowedToRetrieveManagedPassword')) msa.__principals = asArray(param(ctx, 'PrincipalsAllowedToRetrieveManagedPassword')).map(toText)
    if (has(ctx, 'Description')) msa.Description = str(ctx, 'Description') ?? null
    msa.Modified = new Date()
    return []
  },
})

/** Este equipo puede pedir la contraseña de la gMSA (directo o por un grupo, según su ticket actual). */
function canRetrieve(s: PsSession, st: AdStore, msa: PsObject): boolean {
  const mine = [s.state.equipo, `${s.state.equipo}$`, ...computerTokenGroups(s, st)].map((x) => x.toLowerCase())
  return asArray(msa.__principals).some((p) => mine.includes(toText(p).toLowerCase()))
}

adCmdlet('Install-ADServiceAccount', {
  params: ['Identity'],
  switches: ['Force'],
  positional: ['Identity'],
  synopsis: 'Installs an Active Directory managed service account on a computer or caches a group managed service account on a computer.',
  run(ctx) {
    const st = store(ctx.s)
    const msa = resolve(st, st.serviceAccounts ?? [], param(ctx, 'Identity') ?? ctx.input[0], 'InstallADServiceAccount')
    if (!canRetrieve(ctx.s, st, msa)) throw new PsError(`Cannot install service account. Error Message: 'An unspecified error has occurred'.`, 'WriteError', `InstallADServiceAccount:PerformOperation:InstallServiceAcccountFailure,${NS}.Commands.InstallADServiceAccount`, toText(msa.Name))
    const installed = (ctx.s.data.installedMsas ??= []) as string[]
    if (!installed.includes(toText(msa.Name).toLowerCase())) installed.push(toText(msa.Name).toLowerCase())
    return []
  },
})

adCmdlet('Test-ADServiceAccount', {
  params: ['Identity'],
  positional: ['Identity'],
  synopsis: 'Tests a managed service account from a computer.',
  run(ctx) {
    const st = store(ctx.s)
    const msa = resolve(st, st.serviceAccounts ?? [], param(ctx, 'Identity') ?? ctx.input[0], 'TestADServiceAccount')
    if (canRetrieve(ctx.s, st, msa)) return [true]
    ctx.host(`WARNING: Test failed for Managed Service Account ${toText(msa.Name)}. If standalone Managed Service Account, the account is linked to another computer object in the Active Directory. If group Managed Service Account, either this computer does not have permission to use the group MSA or this computer does not support all the Kerberos encryption types required for the gMSA. See the MSA operational log for more information.\n`)
    return [false]
  },
})

// ---------------------------------------------------------------------------------------
// Directivas de contraseña (la del dominio y las específicas, FGPP)
// ---------------------------------------------------------------------------------------

const PWD_PARAMS = ['MinPasswordLength', 'ComplexityEnabled', 'LockoutThreshold', 'LockoutDuration', 'LockoutObservationWindow', 'MaxPasswordAge', 'MinPasswordAge', 'PasswordHistoryCount', 'ReversibleEncryptionEnabled']

function readPwdParams(ctx: CmdletContext, target: Record<string, unknown>) {
  for (const p of PWD_PARAMS) {
    if (!has(ctx, p)) continue
    const v = param(ctx, p)
    if (p.endsWith('Enabled')) target[p] = truthyParam(v)
    else if (/Age|Duration|Window/.test(p)) target[p] = /^\d+$/.test(toText(v)) ? `${toText(v)}.00:00:00` : toText(v)
    else target[p] = Number(v)
  }
}

adCmdlet('Set-ADDefaultDomainPasswordPolicy', {
  params: ['Identity', ...PWD_PARAMS],
  positional: ['Identity'],
  synopsis: 'Modifies the default password policy for an Active Directory domain.',
  run(ctx) {
    const st = store(ctx.s)
    const pol = passwordPolicy(st)
    readPwdParams(ctx, pol)
    // La directiva del dominio vive en la Default Domain Policy.
    const ddp = st.gpos?.find((g) => g.id === DEFAULT_DOMAIN_POLICY_ID)
    if (ddp) {
      const set = (vn: string, v: unknown) => {
        const x = ddp.settings.find((s) => s.valueName === vn)
        if (x) x.value = toText(v)
      }
      set('MinimumPasswordLength', pol.MinPasswordLength)
      set('PasswordComplexity', pol.ComplexityEnabled ? 1 : 0)
      set('LockoutBadCount', pol.LockoutThreshold)
      ddp.computerVersion++
      ddp.modified = new Date()
    }
    return []
  },
})

adCmdlet('New-ADFineGrainedPasswordPolicy', {
  params: ['Name', 'Precedence', 'Description', 'DisplayName', 'ProtectedFromAccidentalDeletion', ...PWD_PARAMS],
  switches: ['PassThru'],
  positional: ['Name', 'Precedence'],
  synopsis: 'Creates a new Active Directory fine-grained password policy.',
  run(ctx) {
    const st = store(ctx.s)
    const name = str(ctx, 'Name')!
    if (!has(ctx, 'Precedence')) throw new PsError('Cannot process command because of one or more missing mandatory parameters: Precedence.', 'InvalidArgument', `MissingMandatoryParameter,${NS}.Commands.NewADFineGrainedPasswordPolicy`)
    if ((st.fgpp ?? []).some((p) => psEquals(p.Name, name))) throw new PsError('An attempt was made to add an object to the directory with a name that is already in use', 'NotSpecified', `ActiveDirectoryServer:8305,${NS}.Commands.NewADFineGrainedPasswordPolicy`, name)
    const props: Record<string, unknown> = { ...passwordPolicy(st) }
    readPwdParams(ctx, props)
    const pol = psObject(`${NS}.ADFineGrainedPasswordPolicy`, {
      AppliesTo: [],
      ...props,
      DistinguishedName: `CN=${name},CN=Password Settings Container,CN=System,${st.domainDn}`,
      Name: name,
      ObjectClass: 'msDS-PasswordSettings',
      ObjectGUID: stableGuid(`pso:${name}`),
      Precedence: Number(param(ctx, 'Precedence')),
      ProtectedFromAccidentalDeletion: has(ctx, 'ProtectedFromAccidentalDeletion') ? truthyParam(param(ctx, 'ProtectedFromAccidentalDeletion')) : true,
      __toString: `CN=${name},CN=Password Settings Container,CN=System,${st.domainDn}`,
    })
    ;(st.fgpp ??= []).push(pol)
    return has(ctx, 'PassThru') ? [pol] : []
  },
})

function findFgpp(ctx: CmdletContext, st: AdStore, cmd: string): PsObject {
  const id = identityText(param(ctx, 'Identity') ?? ctx.input[0])
  const p = (st.fgpp ?? []).find((x) => psEquals(x.Name, id) || sameDn(toText(x.DistinguishedName), id))
  if (!p) throw notFound(st, id, cmd)
  return p
}

adCmdlet('Get-ADFineGrainedPasswordPolicy', {
  params: ['Identity', 'Filter', 'Properties'],
  positional: ['Identity'],
  synopsis: 'Gets one or more Active Directory fine-grained password policies.',
  run(ctx) {
    const st = store(ctx.s)
    if (has(ctx, 'Identity')) return [findFgpp(ctx, st, 'GetADFineGrainedPasswordPolicy')]
    const src = toText(param(ctx, 'Filter') ?? '*')
    let pred: Pred
    try {
      pred = compileFilter(st, ctx.s, src)
    } catch (e) {
      throw filterError(src, (e as Error).message, 'GetADFineGrainedPasswordPolicy')
    }
    return (st.fgpp ?? []).filter((p) => pred(p))
  },
})

for (const [verb, add] of [['Add', true], ['Remove', false]] as const) {
  adCmdlet(`${verb}-ADFineGrainedPasswordPolicySubject`, {
    params: ['Identity', 'Subjects'],
    positional: ['Identity', 'Subjects'],
    synopsis: `${verb}s one or more users or global security groups ${add ? 'to' : 'from'} an Active Directory fine-grained password policy.`,
    run(ctx) {
      const st = store(ctx.s)
      const p = findFgpp(ctx, st, `${verb}ADFineGrainedPasswordPolicySubject`)
      for (const sub of asArray(param(ctx, 'Subjects')).map(identityText)) {
        const o = resolveAny(st, sub) ?? st.groups.find((g) => psEquals(g.Name, sub))
        if (!o) throw notFound(st, sub, `${verb}ADFineGrainedPasswordPolicySubject`)
        const dn = dnOf(o)
        const list = asArray(p.AppliesTo).map(toText)
        p.AppliesTo = add ? [...new Set([...list, dn])] : list.filter((x) => !sameDn(x, dn))
      }
      return []
    },
  })
}

adCmdlet('Remove-ADFineGrainedPasswordPolicy', {
  params: ['Identity'],
  positional: ['Identity'],
  synopsis: 'Removes an Active Directory fine-grained password policy.',
  run(ctx) {
    const st = store(ctx.s)
    const p = findFgpp(ctx, st, 'RemoveADFineGrainedPasswordPolicy')
    if (p.ProtectedFromAccidentalDeletion) throw new PsError('Access is denied', 'PermissionDenied', `ActiveDirectoryCmdlet:System.UnauthorizedAccessException,${NS}.Commands.RemoveADFineGrainedPasswordPolicy`, toText(p.DistinguishedName))
    if (!confirmPrompt(ctx, 'Remove', toText(p.DistinguishedName))) return []
    st.fgpp = (st.fgpp ?? []).filter((x) => x !== p)
    return []
  },
})

/** La FGPP que le toca a un usuario: primero las asignadas directo, si no por grupos globales; gana la de menor Precedence. */
export function resultantPolicy(st: AdStore, user: PsObject): PsObject | undefined {
  const byPrec = (a: PsObject, b: PsObject) => Number(a.Precedence) - Number(b.Precedence)
  const direct = (st.fgpp ?? []).filter((p) => asArray(p.AppliesTo).some((dn) => sameDn(toText(dn), dnOf(user)))).sort(byPrec)
  if (direct.length) return direct[0]
  const groups = groupNames(st, user)
    .map((n) => st.groups.find((g) => psEquals(g.Name, n)))
    .filter((g): g is PsObject => !!g && g.GroupScope === 'Global' && g.GroupCategory !== 'Distribution')
    .map(dnOf)
  return (st.fgpp ?? []).filter((p) => asArray(p.AppliesTo).some((dn) => groups.some((g) => sameDn(g, toText(dn))))).sort(byPrec)[0]
}

adCmdlet('Get-ADUserResultantPasswordPolicy', {
  params: ['Identity'],
  positional: ['Identity'],
  synopsis: 'Gets the resultant password policy for a user.',
  run(ctx) {
    const st = store(ctx.s)
    const u = resolve(st, st.users, param(ctx, 'Identity') ?? ctx.input[0], 'GetADUserResultantPasswordPolicy')
    const p = resultantPolicy(st, u)
    return p ? [p] : []
  },
})

// ---------------------------------------------------------------------------------------
// Herramientas de diagnóstico: dcdiag, repadmin, netdom, nltest, w32tm, klist
// ---------------------------------------------------------------------------------------

/** dcdiag y repadmin vienen con las herramientas de AD DS (o en el propio DC). */
function hasAdTools(s: PsSession) {
  return isDc(s.state, s.lab) || ((s.data.features ?? []) as PsObject[]).some((f) => ['rsat-adds', 'rsat-ad-tools'].includes(toText(f.Name).toLowerCase()) && f.Installed)
}

function notRecognized(name: string) {
  return new PsError(`The term '${name}' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling of the name, or if a path was included, verify that the path is correct and try again.`, 'ObjectNotFound', 'CommandNotFoundException', name)
}

/** Si el otro DC responde para replicar; si no, el código de error de repadmin. */
function replicationError(from: PsSession, to: PsSession): [number, string] | undefined {
  if (from === to) return undefined
  if (!reach(from, to.state.red.ip, 389).ok || !serviceRunning(to, 'NTDS')) return [1722, 'The RPC server is unavailable.']
  if (skew(from, to) > 5) return [1398, 'There is a time and/or date difference between the client and server.']
  return undefined
}

function domainDcSessions(s: PsSession, st: AdStore): PsSession[] {
  return domainControllers(s.lab, st.domain)
    .map((x) => s.lab?.find(x.equipo))
    .filter((x): x is PsSession => !!x)
}

function dcdiagTarget(ctx: CmdletContext, args: string[]): { t: PsSession; st: AdStore } {
  if (!hasAdTools(ctx.s)) throw notRecognized('dcdiag')
  const sArg = args.find((a) => /^\/s:/i.test(a))?.slice(3)
  const t = sArg ? ctx.s.lab?.find(sArg) : isDc(ctx.s.state, ctx.s.lab) ? ctx.s : locateDc(ctx.s).dc
  if (!t || !isDc(t.state, t.lab)) throw new PsError('[simulador] Indicá un controlador de dominio con /s:NOMBRE (o ejecutá dcdiag en un DC).', 'InvalidArgument', 'NoServer')
  return { t, st: t.lab!.adStores.get(t.state.dominio!.toLowerCase()) as AdStore }
}

function dnsHealthy(t: PsSession): boolean {
  // El DC tiene que usarse a sí mismo u otro DC como DNS, nunca solo uno público.
  const dcIps = domainControllers(t.lab, t.state.dominio!).map((x) => x.red.ip)
  return t.state.red.dns.some((ip) => ip === '127.0.0.1' || dcIps.includes(ip)) && resolveName(t, `${t.state.equipo}.${t.state.dominio}`).ok
}

cmdlet('dcdiag', {
  native: true,
  synopsis: 'dcdiag.exe',
  run(ctx) {
    const args = ctx.positional.map(toText)
    const { t, st } = dcdiagTarget(ctx, args)
    const quiet = args.some((a) => /^\/q$/i.test(a))
    const test = args.find((a) => /^\/test:/i.test(a))?.slice(6).toLowerCase()
    const n = t.state.equipo
    const out: string[] = ['', 'Directory Server Diagnosis', '', 'Performing initial setup:', '   Trying to find home server...', `   Home Server = ${n}`, '   * Identified AD Forest. ', '   Done gathering initial info.', '']
    const line = (name: string, ok: boolean, details: string[] = [], who = n) => {
      if (quiet && ok) return
      out.push(`      Starting test: ${name}`, ...details.map((d) => `         ${d}`), `         ......................... ${who} ${ok ? 'passed' : 'failed'} test ${name}`)
    }
    if (test === 'dns') {
      const ok = dnsHealthy(t)
      const gw = !!t.state.red.puerta_enlace
      out.push('Doing initial required tests', '   ', `   Testing server: ${SITE}\\${n}`, '      Starting test: Connectivity', `         ......................... ${n} passed test Connectivity`, '', 'Doing primary tests', '   ', `   Testing server: ${SITE}\\${n}`, '   ', '      Starting test: DNS', '         ', '         DNS Tests are running and not hung. Please wait a few minutes...')
      if (!ok) out.push(`         TEST: Basic (Basc)`, `            Error: No LDAP connectivity`, `            The DNS client of ${n} is not using a DNS server that hosts the zone ${st.domain}: ${t.state.red.dns.join(', ') || '(none)'}.`, `            Warning: adapter [00000001] Microsoft Hyper-V Network Adapter has invalid DNS server: ${t.state.red.dns[0] ?? ''} (<name unavailable>)`, '         TEST: Records registration (RReg)', `            Error: Missing A record at DNS server ${t.state.red.dns[0] ?? ''} : ${n}.${st.domain}`)
      out.push(`         ......................... ${n} ${ok ? 'passed' : 'failed'} test DNS`, '   ', '   Running partition tests on : ForestDnsZones', '', '   Running partition tests on : DomainDnsZones', '', '   Running partition tests on : Schema', '', '   Running partition tests on : Configuration', '', `   Running partition tests on : ${st.domain.split('.')[0]}`, '', `   Running enterprise tests on : ${st.domain}`, '      Starting test: DNS', '         Test results for domain controllers:', '            ', `            DC: ${n}.${st.domain}`, `            Domain: ${st.domain}`, '', '         Summary of test results for DNS servers used by the above domain', '         controllers:', '', '         Summary of DNS test results:', '', '                                            Auth Basc Forw Del  Dyn  RReg Ext', '            _________________________________________________________________', `            Domain: ${st.domain}`, `               ${n.padEnd(29)}${ok ? 'PASS' : 'PASS'} ${ok ? 'PASS' : 'FAIL'} ${gw ? 'PASS' : 'WARN'} n/a  PASS ${ok ? 'PASS' : 'FAIL'} n/a  `, '         ', `         ......................... ${st.domain} ${ok ? 'passed' : 'failed'} test DNS`)
      return [formatted(out.join('\n') + '\n')]
    }
    const connectivity = dnsHealthy(t) && serviceRunning(t, 'NTDS')
    out.push('Doing initial required tests', '   ', `   Testing server: ${SITE}\\${n}`)
    line('Connectivity', connectivity, connectivity ? [] : [`The host ${stableGuid(`dsa:${n}`)}._msdcs.${st.domain} could not be resolved to an IP address. Check the DNS server, DHCP, server name, etc.`, 'Got error while checking LDAP and RPC connectivity. Please check your firewall settings.'])
    out.push('', 'Doing primary tests', '   ', `   Testing server: ${SITE}\\${n}`)
    if (!connectivity) {
      out.push(`      Skipping all tests, because server ${n} is not responding to directory service requests.`)
    } else {
      const svcNeeded = ['DFSR', 'Dnscache', 'Kdc', 'LanmanServer', 'LanmanWorkstation', 'Netlogon', 'NTDS', 'RpcSs', 'W32Time']
      const stopped = svcNeeded.filter((x) => !serviceRunning(t, x))
      const f = fsmoOf(st, n)
      const others = domainDcSessions(t, st).filter((x) => x !== t)
      const repl = others.map((o) => [o, replicationError(t, o)] as const).filter(([, e]) => e)
      const holderDown = FSMO_ROLES.map((r) => [r, f[r]] as const).filter(([, h]) => {
        const hs = t.lab?.find(h)
        return !hs || (hs !== t && !!replicationError(t, hs))
      })
      const sysErrors = ((t.data.events ?? []) as PsObject[]).filter((e) => e.LogName === 'System' && e.LevelDisplayName === 'Error' && Date.now() - (e.TimeCreated as Date).getTime() < 3_600_000 * 24)
      line('Advertising', serviceRunning(t, 'Netlogon') && serviceRunning(t, 'Kdc'), serviceRunning(t, 'Netlogon') && serviceRunning(t, 'Kdc') ? [] : [`Warning: DsGetDcName returned information for \\\\${others[0]?.state.equipo ?? n}.${st.domain}, when we were trying to reach ${n}.`, 'SERVER IS NOT RESPONDING or IS NOT CONSIDERED SUITABLE.'])
      line('FrsEvent', true)
      line('DFSREvent', true)
      line('SysVolCheck', serviceRunning(t, 'DFSR'))
      line('KccEvent', true)
      line('KnowsOfRoleHolders', !holderDown.length, holderDown.map(([r, h]) => `Warning: ${h} is the ${r === 'PDCEmulator' ? 'PDC' : r.replace('Master', '')} Owner, but is not responding to DS RPC Bind.`))
      line('MachineAccount', true)
      line('NCSecDesc', true)
      line('NetLogons', serviceRunning(t, 'Netlogon'), serviceRunning(t, 'Netlogon') ? [] : [`[${n}] User credentials does not have permission to perform this operation.`, `The account used for this test must have network logon privileges for this machine's domain.`])
      line('ObjectsReplicated', true)
      line('Replications', !repl.length, repl.flatMap(([o, e]) => [`[Replications Check,${n}] A recent replication attempt failed:`, `   From ${o.state.equipo} to ${n}`, `   Naming Context: ${st.domainDn}`, `   The replication generated an error (${e![0]}):`, `   ${e![1]}`, `   The failure occurred at ${new Date().toISOString().slice(0, 19).replace('T', ' ')}.`]))
      line('RidManager', !holderDown.some(([r]) => r === 'RIDMaster'))
      line('Services', !stopped.length, stopped.map((x) => `${x} Service is stopped on [${n}]`))
      line('SystemLog', !sysErrors.length, sysErrors.slice(0, 3).flatMap((e) => [`An error event occurred.  EventID: 0x${Number(e.Id).toString(16).toUpperCase().padStart(8, '0')}`, `   Time Generated: ${(e.TimeCreated as Date).toLocaleString('en-US').replace(',', '')}`, `   Event String:`, `   ${toText(e.Message)}`]))
      line('VerifyReferences', true)
      out.push('   ', '   ')
      for (const p of ['ForestDnsZones', 'DomainDnsZones', 'Schema', 'Configuration', st.domain.split('.')[0]]) {
        out.push(`   Running partition tests on : ${p}`)
        line('CheckSDRefDom', true, [], p)
        line('CrossRefValidation', true, [], p)
        out.push('')
      }
      out.push(`   Running enterprise tests on : ${st.domain}`)
      const pdcOk = !holderDown.some(([r]) => r === 'PDCEmulator')
      line('LocatorCheck', pdcOk, pdcOk ? [] : ['Warning: DcGetDcName(PDC_REQUIRED) call failed, error 1355', 'A Primary Domain Controller could not be located.', 'The server holding the PDC role is down.'], st.domain)
      line('Intersite', true, [], st.domain)
    }
    // dcdiag /q solo muestra los errores.
    if (quiet) return [formatted(out.filter((l) => /^\s{9}/.test(l) && !/^\s*Starting test/.test(l)).join('\n') + (out.some((l) => /failed test/.test(l)) ? '\n' : ''))]
    return [formatted(out.join('\n') + '\n')]
  },
})

function repadminTarget(ctx: CmdletContext, name?: string): { t: PsSession; st: AdStore } {
  if (!hasAdTools(ctx.s)) throw notRecognized('repadmin')
  const t = name && name !== '*' ? ctx.s.lab?.find(name) : isDc(ctx.s.state, ctx.s.lab) ? ctx.s : locateDc(ctx.s).dc
  if (!t || !isDc(t.state, t.lab)) throw new PsError(`[simulador] repadmin necesita llegar a un controlador de dominio${name ? ` (${name} no lo es o no responde)` : ''}.`, 'InvalidArgument', 'NoServer')
  return { t, st: t.lab!.adStores.get(t.state.dominio!.toLowerCase()) as AdStore }
}

const fmtTime = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ')

cmdlet('repadmin', {
  native: true,
  synopsis: 'repadmin.exe',
  run(ctx) {
    const args = ctx.positional.map(toText)
    const cmd = (args[0] ?? '').toLowerCase()
    const { t, st } = repadminTarget(ctx, args[1] && !args[1].startsWith('/') ? args[1] : undefined)
    const dcs = domainDcSessions(t, st)
    const ncs = [st.domainDn, `CN=Configuration,${st.domainDn}`, `CN=Schema,CN=Configuration,${st.domainDn}`, `DC=DomainDnsZones,${st.domainDn}`, `DC=ForestDnsZones,${st.domainDn}`]
    const now = new Date()
    if (cmd === '/replsummary') {
      const rows = (dir: 'src' | 'dst') =>
        dcs.map((d) => {
          const partners = dcs.filter((x) => x !== d)
          const fails = partners.filter((p) => (dir === 'src' ? replicationError(p, d) : replicationError(d, p)))
          const err = fails.length ? (dir === 'src' ? replicationError(fails[0], d) : replicationError(d, fails[0])) : undefined
          const total = partners.length * 5
          const pct = total ? Math.round((fails.length * 5 * 100) / total) : 0
          const delta = fails.length ? '02h:14m:07s' : '      03m:12s'
          return ` ${d.state.equipo.padEnd(20)}${delta.padStart(14)}  ${String(fails.length * 5).padStart(5)} / ${String(total).padStart(3)}  ${String(pct).padStart(3)}${err ? `  (${err[0]}) ${err[1]}` : ''}`
        })
      return [formatted(`Replication Summary Start Time: ${fmtTime(now)}\n\nBeginning data collection for replication summary, this may take awhile:\n  ${'.'.repeat(dcs.length * 2)}\n\n\nSource DSA          largest delta    fails/total %%   error\n${rows('src').join('\n')}\n\n\nDestination DSA     largest delta    fails/total %%   error\n${rows('dst').join('\n')}\n\n`)]
    }
    if (cmd === '/showrepl') {
      const inbound = dcs.filter((x) => x !== t)
      let text = `\nRepadmin: running command /showrepl against full DC ${t === ctx.s ? 'localhost' : `${t.state.equipo}.${st.domain}`}\n${SITE}\\${t.state.equipo}\nDSA Options: IS_GC \nSite Options: (none)\nDSA object GUID: ${stableGuid(`dsa:${t.state.equipo}`)}\nDSA invocationID: ${stableGuid(`inv:${t.state.equipo}`)}\n\n==== INBOUND NEIGHBORS ======================================\n`
      for (const nc of ncs) {
        text += `\n${nc}\n`
        for (const p of inbound) {
          const e = replicationError(t, p)
          text += `    ${SITE}\\${p.state.equipo} via RPC\n        DSA object GUID: ${stableGuid(`dsa:${p.state.equipo}`)}\n`
          text += e ? `        Last attempt @ ${fmtTime(now)} failed, result ${e[0]} (0x${e[0].toString(16)}):\n            ${e[1]}\n        ${3 + (e[0] % 7)} consecutive failure(s).\n        Last success @ ${fmtTime(new Date(now.getTime() - 8_047_000))}.\n` : `        Last attempt @ ${fmtTime(new Date(now.getTime() - 192_000))} was successful.\n`
        }
      }
      if (!inbound.length) text += '\n[simulador] Este controlador es el único del dominio: no tiene vecinos de los que replicar.\n'
      return [formatted(text)]
    }
    if (cmd === '/syncall') {
      let text = `Syncing all NC's held on ${t.state.equipo}.\n`
      let errors = 0
      for (const nc of ncs) {
        text += `Syncing partition: ${nc}\n`
        for (const p of dcs.filter((x) => x !== t)) {
          const e = replicationError(t, p)
          if (e) {
            errors++
            text += `SyncAll reported the following errors:\nError issuing replication: ${e[0]} (0x${e[0].toString(16)}):\n    From: ${stableGuid(`dsa:${p.state.equipo}`)}._msdcs.${st.domain}\n    To  : ${stableGuid(`dsa:${t.state.equipo}`)}._msdcs.${st.domain}\n`
          } else text += `CALLBACK MESSAGE: The following replication is in progress:\n    From: ${stableGuid(`dsa:${p.state.equipo}`)}._msdcs.${st.domain}\n    To  : ${stableGuid(`dsa:${t.state.equipo}`)}._msdcs.${st.domain}\nCALLBACK MESSAGE: The following replication completed successfully:\n    From: ${stableGuid(`dsa:${p.state.equipo}`)}._msdcs.${st.domain}\n    To  : ${stableGuid(`dsa:${t.state.equipo}`)}._msdcs.${st.domain}\n`
        }
      }
      text += errors ? '' : 'CALLBACK MESSAGE: SyncAll Finished.\nSyncAll terminated with no errors.\n'
      return [formatted(text)]
    }
    if (cmd === '/queue') return [formatted(`Repadmin: running command /queue against full DC ${t.state.equipo}.${st.domain}\nQueue contains 0 items.\n`)]
    return [formatted('Usage: repadmin <cmd> <args> [/u:{domain\\user}] [/pw:{password|*}]\n\nSupported <cmd>s (use /? for help):\n     /replsummary    Summarizes the replication state and relative health of a forest.\n     /showrepl       Displays the replication partners for each directory partition.\n     /syncall        Synchronizes a specified domain controller with all replication partners.\n     /queue          Displays inbound replication requests that the DC needs to issue.\n')]
  },
})

cmdlet('netdom', {
  native: true,
  synopsis: 'netdom.exe',
  run(ctx) {
    const args = ctx.positional.map((a) => toText(a).toLowerCase())
    if (!hasAdTools(ctx.s)) throw notRecognized('netdom')
    const st = (ctx.s.data.domainStore?.[0] ?? ctx.s.data.ad?.[0]) as AdStore | undefined
    if (!st) return [formatted('The specified domain either does not exist or could not be contacted.\n\nThe command failed to complete successfully.\n')]
    if (args[0] === 'query' && args[1] === 'fsmo') {
      const f = fsmoOf(st, ctx.s.state.equipo)
      return [formatted(`Schema master               ${fqdn(f.SchemaMaster, st.domain)}\nDomain naming master        ${fqdn(f.DomainNamingMaster, st.domain)}\nPDC                         ${fqdn(f.PDCEmulator, st.domain)}\nRID pool manager            ${fqdn(f.RIDMaster, st.domain)}\nInfrastructure master       ${fqdn(f.InfrastructureMaster, st.domain)}\nThe command completed successfully.\n\n`)]
    }
    if (args[0] === 'query' && args[1] === 'dc') return [formatted(`List of domain controllers with accounts in the domain:\n\n${domainControllers(ctx.s.lab, st.domain).map((x) => x.equipo.toUpperCase()).join('\n')}\nThe command completed successfully.\n\n`)]
    return [formatted('The syntax of this command is:\n\nNETDOM [ ADD | COMPUTERNAME | JOIN | MOVE | QUERY | REMOVE | MOVENT4BDC | RENAMECOMPUTER | RESET | RESETPWD | TRUST | VERIFY ]\n\n[simulador] Disponibles: netdom query fsmo, netdom query dc.\n')]
  },
})

cmdlet('nltest', {
  native: true,
  synopsis: 'nltest.exe',
  run(ctx) {
    const args = ctx.positional.map(toText)
    const a = args[0] ?? ''
    const m = /^\/(dsgetdc|sc_query|dclist|sc_verify):(.+)$/i.exec(a)
    if (!m) return [formatted('Usage: nltest [/OPTIONS]\n\n    /DSGETDC:<DomainName> - Call DsGetDcName\n    /SC_QUERY:<DomainName> - Query Secure Channel for <Domain>\n    /DCLIST:<DomainName> - Get list of DC\'s for <DomainName>\n')]
    const verb = m[1].toLowerCase()
    const domain = m[2].toLowerCase()
    const found = locateDc(ctx.s, domain)
    if (!found.dc) {
      if (verb === 'dsgetdc') return [formatted('Getting DC name failed: Status = 1355 0x54b ERROR_NO_SUCH_DOMAIN\n')]
      if (verb === 'dclist') return [formatted(`Get list of DCs in domain '${domain}' from ''.\nI_NetGetDCList failed: Status = 1355 0x54b ERROR_NO_SUCH_DOMAIN\n`)]
      return [formatted(`Flags: 0\nTrusted DC Name \nTrusted DC Connection Status Status = 1311 0x51f ERROR_NO_LOGON_SERVERS\nThe command completed successfully\n`)]
    }
    const dc = found.dc
    const st = ctx.s.lab!.adStores.get(domain) as AdStore
    const pdc = fsmoOf(st, dc.state.equipo).PDCEmulator.toLowerCase() === dc.state.equipo.toLowerCase()
    if (verb === 'dsgetdc') return [formatted(`           DC: \\\\${dc.state.equipo}.${domain}\n      Address: \\\\${dc.state.red.ip}\n     Dom Guid: ${stableGuid(`domain:${domain}`)}\n     Dom Name: ${domain}\n  Forest Name: ${domain}\n Dc Site Name: ${SITE}\nOur Site Name: ${SITE}\n        Flags: ${pdc ? 'PDC ' : ''}GC DS LDAP KDC TIMESERV ${pdc ? 'GTIMESERV ' : ''}WRITABLE DNS_DC DNS_DOMAIN DNS_FOREST CLOSE_SITE FULL_SECRET WS DS_8 DS_9 DS_10 KEYLIST DS_13\nThe command completed successfully\n`)]
    if (verb === 'dclist') return [formatted(`Get list of DCs in domain '${domain}' from '\\\\${dc.state.equipo}.${domain}'.\n${domainControllers(ctx.s.lab, domain).map((x) => `    ${x.equipo}.${domain}${fsmoOf(st, x.equipo).PDCEmulator === x.equipo ? ' [PDC] ' : '       '} [DS] Site: ${SITE}`).join('\n')}\nThe command completed successfully\n`)]
    if (ctx.s.state.dominio?.toLowerCase() !== domain) return [formatted('I_NetLogonControl failed: Status = 1355 0x54b ERROR_NO_SUCH_DOMAIN\n')]
    return [formatted(`Flags: 30 HAS_IP  HAS_TIMESERV\nTrusted DC Name \\\\${dc.state.equipo}.${domain}\nTrusted DC Connection Status Status = 0 0x0 NERR_Success\nThe command completed successfully\n`)]
  },
})

// --- Hora (w32tm) -----------------------------------------------------------------------

function pdcOf(s: PsSession): PsSession | undefined {
  const st = s.data.domainStore?.[0] as AdStore | undefined
  if (!st) return undefined
  return s.lab?.find(fsmoOf(st, s.state.equipo).PDCEmulator) ?? (isDc(s.state, s.lab) ? s : undefined)
}

/** ReferenceId de w32tm: la IP de la fuente en hexadecimal. */
function refId(s: PsSession, src: string): string {
  const ip = s.lab?.find(src.split(',')[0])?.state.red.ip ?? '20.101.57.9'
  return `0x${ip.split('.').map((o) => Number(o).toString(16).padStart(2, '0')).join('').toUpperCase()} (source IP:  ${ip})`
}

function timeSource(s: PsSession): string {
  if (s.data.timeSource?.[0]) return toText(s.data.timeSource[0])
  if (!s.state.dominio) return 'time.windows.com,0x8'
  const pdc = pdcOf(s)
  if (pdc === s) return 'Local CMOS Clock'
  const dc = locateDc(s).dc
  return dc && dc !== s ? `${dc.state.equipo}.${s.state.dominio}` : 'Local CMOS Clock'
}

cmdlet('w32tm', {
  native: true,
  synopsis: 'w32tm.exe',
  run(ctx) {
    const s = ctx.s
    const args = ctx.positional.map(toText)
    const lower = args.map((a) => a.toLowerCase())
    if (!serviceRunning(s, 'W32Time') && !lower.includes('/stripchart')) return [formatted('The following error occurred: The service has not been started. (0x80070426)\n')]
    if (lower[0] === '/query') {
      const src = timeSource(s)
      if (lower[1] === '/source') return [formatted(`${src}\n`)]
      if (lower[1] === '/peers') return [formatted(`#Peers: 1\n\nPeer: ${src}\nState: Active\nTime Remaining: 512.2345678s\nMode: 3 (Client)\nStratum: ${src === 'Local CMOS Clock' ? 0 : 2} (secondary reference - syncd by (S)NTP)\nPeerPoll Interval: 10 (1024s)\nHostPoll Interval: 10 (1024s)\n`)]
      const local = src === 'Local CMOS Clock'
      const last = new Date(Date.now() + s.state.desfase_reloj_min * 60_000 - 1_200_000)
      return [formatted(`Leap Indicator: ${local ? '3(not synchronized)' : '0(no warning)'}\nStratum: ${local ? '1 (primary reference - syncd by radio clock)' : src.includes('.') && !src.includes(',') ? '4 (secondary reference - syncd by (S)NTP)' : '3 (secondary reference - syncd by (S)NTP)'}\nPrecision: -23 (119.209ns per tick)\nRoot Delay: ${local ? '0.0000000s' : '0.0312561s'}\nRoot Dispersion: ${local ? '10.0000000s' : '0.0446418s'}\nReferenceId: ${local ? '0x4C4F434C (source name:  "LOCL")' : refId(s, src)}\nLast Successful Sync Time: ${last.toLocaleString('en-US').replace(',', '')}\nSource: ${src}\nPoll Interval: 6 (64s)\n`)]
    }
    if (lower[0] === '/config') {
      const peers = args.find((a) => /^\/manualpeerlist:/i.test(a))?.replace(/^\/manualpeerlist:/i, '').replace(/^"|"$/g, '')
      const flags = lower.find((a) => a.startsWith('/syncfromflags:'))?.split(':')[1]
      if (flags === 'domhier') delete s.data.timeSource
      else if (peers) s.data.timeSource = [peers.split(/[ ,]/)[0]]
      if (!lower.includes('/update')) return [formatted('The command completed successfully.\n[simulador] Sin /update el servicio de hora no toma la configuración nueva hasta reiniciarse.\n')]
      return [formatted('The command completed successfully.\n')]
    }
    if (lower[0] === '/resync') {
      const src = timeSource(s)
      const head = 'Sending resync command to local computer\n'
      if (src === 'Local CMOS Clock') return [formatted(`${head}The computer did not resync because no time data was available.\n`)]
      if (/\./.test(src) && s.state.dominio && src.toLowerCase().endsWith(s.state.dominio.toLowerCase())) {
        const pdc = pdcOf(s)
        const dc = locateDc(s).dc
        if (!dc || !pdc) return [formatted(`${head}The computer did not resync because no time data was available.\n`)]
        s.state.desfase_reloj_min = pdc.state.desfase_reloj_min
        return [formatted(`${head}The command completed successfully.\n`)]
      }
      // Fuente externa (pool.ntp.org, time.windows.com...): hace falta salida a Internet.
      if (!s.state.red.puerta_enlace) return [formatted(`${head}The computer did not resync because no time data was available.\n`)]
      s.state.desfase_reloj_min = 0
      return [formatted(`${head}The command completed successfully.\n`)]
    }
    if (lower[0] === '/stripchart') {
      const target = args.find((a) => /^\/computer:/i.test(a))?.slice(10) ?? ''
      const samples = Number(args.find((a) => /^\/samples:/i.test(a))?.slice(9) ?? 3)
      const t = s.lab?.find(target)
      if (!t) return [formatted(`Tracking ${target} [0.0.0.0:123].\nThe following error occurred: No such host is known. (0x80072AF9)\n`)]
      const off = (t.state.desfase_reloj_min - s.state.desfase_reloj_min) * 60
      const now = new Date(Date.now() + s.state.desfase_reloj_min * 60_000)
      const rows = Array.from({ length: samples }, (_, i) => `${new Date(now.getTime() + i * 2000).toTimeString().slice(0, 8)}, ${off >= 0 ? '+' : '-'}${Math.abs(off + i * 0.0001).toFixed(7).padStart(10, '0')}s`)
      return [formatted(`Tracking ${target} [${t.state.red.ip}:123].\nCollecting ${samples} samples.\nThe current time is ${now.toLocaleString('en-US').replace(',', '')}.\n${rows.join('\n')}\n`)]
    }
    return [formatted('w32tm [/? | /register | /unregister ]\n  query [/computer:<target>] [/source] [/configuration] [/peers] [/status] [/verbose]\n  config [/computer:<target>] [/update] [/manualpeerlist:<peers>] [/syncfromflags:<source>] [/reliable:(YES|NO)]\n  resync [/computer:<computer>] [/nowait] [/rediscover] [/soft]\n  stripchart /computer:<target> [/period:<refresh>] [/dataonly] [/samples:<count>]\n')]
  },
})

// --- Tickets de Kerberos (klist) --------------------------------------------------------

cmdlet('klist', {
  native: true,
  synopsis: 'klist.exe',
  run(ctx) {
    const s = ctx.s
    const args = ctx.positional.map((a) => toText(a).toLowerCase())
    const system = args.includes('-li') && args[args.indexOf('-li') + 1] === '0x3e7'
    const logon = system ? '0:0x3e7' : '0:0x2b6f1'
    if (args.includes('purge')) {
      if (system) delete s.data.tokenGroups
      s.data.ticketsPurged = [true]
      return [formatted(`\nCurrent LogonId is ${logon}\n${system ? 'Targeted LogonId is 0:0x3e7\n' : ''}\tDeleting all tickets:\n\tTicket(s) purged!\n`)]
    }
    const found = s.state.dominio ? locateDc(s) : {}
    const ok = !!found.dc && skew(s, found.dc) <= 5
    if (!ok || (s.data.ticketsPurged?.[0] && !args.includes('get'))) {
      if (s.data.ticketsPurged?.[0] && ok) s.data.ticketsPurged = [false]
      return [formatted(`\nCurrent LogonId is ${logon}\n\nCached Tickets: (0)\n`)]
    }
    const d = s.state.dominio!.toUpperCase()
    const who = system ? `${s.state.equipo.toUpperCase()}$` : s.state.usuario
    const start = new Date(Date.now() + s.state.desfase_reloj_min * 60_000 - 1_800_000)
    const end = new Date(start.getTime() + 10 * 3_600_000)
    const renew = new Date(start.getTime() + 7 * 86_400_000)
    const t = (i: number, server: string, flags: string) => `#${i}>\tClient: ${who} @ ${d}\n\tServer: ${server} @ ${d}\n\tKerbTicket Encryption Type: AES-256-CTS-HMAC-SHA1-96\n\tTicket Flags ${flags}\n\tStart Time: ${start.toLocaleString('en-US').replace(',', '')} (local)\n\tEnd Time:   ${end.toLocaleString('en-US').replace(',', '')} (local)\n\tRenew Time: ${renew.toLocaleString('en-US').replace(',', '')} (local)\n\tSession Key Type: AES-256-CTS-HMAC-SHA1-96\n\tCache Flags: ${i === 0 ? '0x1 -> PRIMARY ' : '0 '}\n\tKdc Called: ${found.dc!.state.equipo}.${s.state.dominio}\n`
    return [formatted(`\nCurrent LogonId is ${logon}\n\nCached Tickets: (2)\n\n${t(0, `krbtgt/${d}`, '0x40e10000 -> forwardable renewable initial pre_authent name_canonicalize ')}\n${t(1, `ldap/${found.dc!.state.equipo.toLowerCase()}.${s.state.dominio}/${s.state.dominio}`, '0x40a50000 -> forwardable renewable pre_authent ok_as_delegate name_canonicalize ')}`)]
  },
})


// ---------------------------------------------------------------------------------------
// redircmp / redirusr y delegación con dsacls
// ---------------------------------------------------------------------------------------

for (const [tool, key, label] of [['redircmp', 'defaultComputers', 'computers'], ['redirusr', 'defaultUsers', 'users']] as const) {
  cmdlet(tool, {
    native: true,
    synopsis: `${tool}.exe`,
    run(ctx) {
      if (!hasAdTools(ctx.s)) throw notRecognized(tool)
      const st = store(ctx.s)
      const dn = ctx.positional.map(toText).join(' ').replace(/^"|"$/g, '')
      if (!dn) return [formatted(`Usage: ${tool} container-dn\n\n[simulador] Ejemplo: ${tool} "OU=Equipos,OU=Empresa,${st.domainDn}"\n`)]
      if (!containerExists(st, dn) || !/^OU=/i.test(dn)) return [formatted(`Error, unable to modify the wellKnownObjects attribute. Verify that the domain functional level of the domain is at least Windows Server 2003.\n[simulador] Revisá que la OU exista: ${dn}\n`)]
      st[key] = dn
      return [formatted(`Redirection was successful.\n[simulador] Los ${label === 'computers' ? 'equipos que se unan' : 'usuarios que se creen sin -Path'} al dominio van a quedar en ${dn}.\n`)]
    },
  })
}

const RIGHTS: Record<string, string> = { 'reset password': 'Reset Password', 'change password': 'Change Password' }

cmdlet('dsacls', {
  native: true,
  synopsis: 'dsacls.exe',
  run(ctx) {
    if (!hasAdTools(ctx.s)) throw notRecognized('dsacls')
    const st = store(ctx.s)
    const args = ctx.positional.map(toText)
    const dn = (args[0] ?? '').replace(/^"|"$/g, '')
    if (!dn) return [formatted('Displays or modifies permissions (ACLS) of an Active Directory Domain Services (AD DS) Object\n\nDSACLS object [/I:TSP] [/N] [/P:YN] [/G <group/user>:<perms> [...]] [/R <group/user> [...]]\n')]
    if (!containerExists(st, dn) && !allObjects(st).some((o) => sameDn(dnOf(o), dn))) return [formatted(`The specified directory service attribute or value does not exist.\nThe command failed to complete successfully.\n`)]
    const g = args.findIndex((a) => /^\/G$/i.test(a))
    const r = args.findIndex((a) => /^\/R$/i.test(a))
    if (g >= 0) {
      // /G "EMPRESA\Mesa-Ayuda:CA;Reset Password;user"
      const spec = args.slice(g + 1).join(' ').replace(/^"|"$/g, '')
      const m = /^([^:]+):([A-Z]+)(?:;([^;]+))?(?:;([^;]+))?$/i.exec(spec)
      if (!m) return [formatted('The parameter is incorrect.\nThe command failed to complete successfully.\n')]
      const trustee = m[1].replace(/^[^\\]+\\/, '')
      if (!st.groups.some((x) => psEquals(x.Name, trustee)) && !st.users.some((x) => psEquals(x.SamAccountName, trustee))) return [formatted(`No mapping between account names and security IDs was done.\nThe command failed to complete successfully.\n`)]
      const right = m[2].toUpperCase() === 'CA' ? (RIGHTS[(m[3] ?? '').toLowerCase()] ?? m[3] ?? 'Control Access') : m[2].toUpperCase() === 'GA' ? 'Full Control' : m[2].toUpperCase() === 'RP' ? 'Read Property' + (m[3] ? ` ${m[3]}` : '') : m[2].toUpperCase() === 'WP' ? 'Write Property' + (m[3] ? ` ${m[3]}` : '') : m[2]
      ;(st.delegations ??= []).push({ dn, trustee, right, objectType: m[4] ?? m[3] ?? '' })
    }
    if (r >= 0) {
      const who = (args[r + 1] ?? '').replace(/^"|"$/g, '').replace(/^[^\\]+\\/, '')
      st.delegations = (st.delegations ?? []).filter((d) => !(sameDn(d.dn, dn) && psEquals(d.trustee, who)))
    }
    const mine = (st.delegations ?? []).filter((d) => sameDn(d.dn, dn) || dn.toLowerCase().endsWith(`,${d.dn.toLowerCase()}`))
    const lines = [
      'Owner: EMPRESA\\Domain Admins',
      'Group: EMPRESA\\Domain Admins',
      '',
      'Access list:',
      'Allow EMPRESA\\Domain Admins          FULL CONTROL',
      'Allow NT AUTHORITY\\SYSTEM             FULL CONTROL',
      'Allow NT AUTHORITY\\Authenticated Users  SPECIAL ACCESS',
      '                                       READ PERMISSONS',
      '                                       LIST CONTENTS',
      '                                       READ PROPERTY',
      ...mine.map((d) => `Allow ${st.netbios}\\${d.trustee.padEnd(25)} ${d.right.toUpperCase()}${d.objectType ? `  <Inherited to ${d.objectType}>` : ''}`),
      'Deny  Everyone                        SPECIAL ACCESS',
      '                                       DELETE',
      '                                       DELETE TREE',
      '',
      'The command completed successfully',
    ]
    return [formatted(lines.join('\n') + '\n')]
  },
})
