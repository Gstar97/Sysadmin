/**
 * Configuración de un Windows Server: red (placas, IP, DNS, perfil), firewall, nombre y reinicio,
 * zona horaria, sconfig, escritorio remoto, discos y volúmenes, CIM/WMI, actualizaciones y módulos.
 */
import { stableGuid } from './ad'
import { activeProfile, networkCategory, ruleObject } from './machine'
import { connect } from './remoting'
import { asArray, cmdlet, PsError, PsSession, psEquals, wildcardToRegex, type CmdletContext } from './session'
import { disks, type DiskPartition, type DiskState } from './verify-system'
import { psObject, toText, VIEWS, type PsObject } from './values'

const param = (ctx: CmdletContext, n: string) => ctx.params.get(n.toLowerCase())
const has = (ctx: CmdletContext, n: string) => ctx.params.has(n.toLowerCase())
const str = (ctx: CmdletContext, n: string) => (has(ctx, n) ? toText(param(ctx, n)) : undefined)
const list = (ctx: CmdletContext, n: string) => asArray(param(ctx, n))
const formatted = (text: string): PsObject => psObject('__formatted', { text })
const GB = 1024 ** 3

/** Tamaño como lo muestra PowerShell: 100 GB, 59.27 GB, 610 MB. */
export function fmtSize(bytes: number): string {
  const units: [number, string][] = [
    [1024 ** 4, 'TB'],
    [GB, 'GB'],
    [1024 ** 2, 'MB'],
    [1024, 'KB'],
  ]
  for (const [u, n] of units) if (bytes >= u) return `${Number((bytes / u).toFixed(2))} ${n}`
  return `${bytes} B`
}

function isCore(s: PsSession) {
  return s.state.experiencia === 'core'
}

// ---------------------------------------------------------------------------------------
// Red: placas, direcciones, DNS y perfil de red
// ---------------------------------------------------------------------------------------

const IFINDEX = 6

function adapterAlias(s: PsSession) {
  return s.state.red.adaptador
}

function checkAlias(ctx: CmdletContext, cmd: string) {
  const alias = str(ctx, 'InterfaceAlias')
  const idx = param(ctx, 'InterfaceIndex')
  if (alias !== undefined && alias.toLowerCase() !== adapterAlias(ctx.s).toLowerCase()) throw new PsError(`No MSFT_NetIPInterface objects found with property 'InterfaceAlias' equal to '${alias}'.  Verify the value of the property and retry.`, 'ObjectNotFound', `CmdletizationQuery_NotFound_InterfaceAlias,${cmd}`, alias)
  if (idx !== undefined && Number(idx) !== IFINDEX) throw new PsError(`No MSFT_NetIPInterface objects found with property 'InterfaceIndex' equal to '${toText(idx)}'.  Verify the value of the property and retry.`, 'ObjectNotFound', `CmdletizationQuery_NotFound_InterfaceIndex,${cmd}`, toText(idx))
}

function prefixToMask(p: number): string {
  const n = p === 0 ? 0 : (~0 << (32 - p)) >>> 0
  return [24, 16, 8, 0].map((sh) => (n >>> sh) & 255).join('.')
}

function mac(s: PsSession) {
  const g = stableGuid(`mac:${s.state.equipo}`).replace(/-/g, '')
  return `00-15-5D-${g.slice(0, 2)}-${g.slice(2, 4)}-${g.slice(4, 6)}`.toUpperCase()
}

cmdlet('Get-NetAdapter', {
  params: ['Name', 'InterfaceIndex'],
  switches: ['Physical', 'IncludeHidden'],
  positional: ['Name'],
  synopsis: 'Gets the basic network adapter properties.',
  module: 'NetAdapter',
  run(ctx) {
    const r = ctx.s.state.red
    const a = psObject('MSFT_NetAdapter', { Name: r.adaptador, InterfaceDescription: 'Microsoft Hyper-V Network Adapter', ifIndex: IFINDEX, Status: r.conectada ? 'Up' : 'Disconnected', MacAddress: mac(ctx.s), LinkSpeed: r.conectada ? '10 Gbps' : '0 bps' })
    const names = list(ctx, 'Name')
    if (names.length && !names.some((n) => wildcardToRegex(toText(n)).test(r.adaptador))) {
      ctx.writeError(`No MSFT_NetAdapter objects found with property 'Name' equal to '${toText(names[0])}'.  Verify the value of the property and retry.`, 'ObjectNotFound', toText(names[0]))
      return []
    }
    return [a]
  },
})
VIEWS['MSFT_NetAdapter'] = {
  kind: 'table',
  columns: [
    { label: 'Name', value: (o) => o.Name },
    { label: 'InterfaceDescription', value: (o) => o.InterfaceDescription },
    { label: 'ifIndex', value: (o) => o.ifIndex, align: 'right' },
    { label: 'Status', value: (o) => o.Status },
    { label: 'MacAddress', value: (o) => o.MacAddress },
    { label: 'LinkSpeed', value: (o) => o.LinkSpeed, align: 'right' },
  ],
}

for (const v of ['Rename', 'Disable', 'Enable', 'Restart'] as const) {
  cmdlet(`${v}-NetAdapter`, {
    params: ['Name', 'NewName'],
    switches: ['Confirm', 'PassThru'],
    positional: ['Name'],
    synopsis: `${v}s a network adapter.`,
    module: 'NetAdapter',
    run(ctx) {
      const r = ctx.s.state.red
      if (!psEquals(param(ctx, 'Name'), r.adaptador)) throw new PsError(`No MSFT_NetAdapter objects found with property 'Name' equal to '${str(ctx, 'Name')}'.`, 'ObjectNotFound', 'CmdletizationQuery_NotFound_Name', str(ctx, 'Name'))
      if (v === 'Rename') r.adaptador = str(ctx, 'NewName') ?? r.adaptador
      if (v === 'Disable') r.conectada = false
      if (v === 'Enable' || v === 'Restart') r.conectada = true
      return []
    },
  })
}

function ipObject(s: PsSession, ip: string, prefix: number, origin: string): PsObject {
  return psObject('MSFT_NetIPAddress', { IPAddress: ip, InterfaceIndex: IFINDEX, InterfaceAlias: adapterAlias(s), AddressFamily: 'IPv4', Type: 'Unicast', PrefixLength: prefix, PrefixOrigin: origin, SuffixOrigin: origin === 'Dhcp' ? 'Dhcp' : origin === 'WellKnown' ? 'Link' : 'Manual', AddressState: 'Preferred', ValidLifetime: origin === 'Dhcp' ? '7.23:59:59' : 'Infinite ([TimeSpan]::MaxValue)', PreferredLifetime: origin === 'Dhcp' ? '7.23:59:59' : 'Infinite ([TimeSpan]::MaxValue)', SkipAsSource: false, PolicyStore: 'ActiveStore' })
}

cmdlet('Get-NetIPAddress', {
  params: ['AddressFamily', 'InterfaceAlias', 'InterfaceIndex', 'IPAddress'],
  positional: ['IPAddress'],
  synopsis: 'Gets the IP address configuration.',
  module: 'NetTCPIP',
  run(ctx) {
    const r = ctx.s.state.red
    const origin = r.dhcp ? (r.ip.startsWith('169.254.') ? 'WellKnown' : 'Dhcp') : 'Manual'
    const items = [
      ...(r.conectada ? [ipObject(ctx.s, r.ip, r.prefijo, origin)] : []),
      ...((ctx.s.data.extraIps ?? []) as { ip: string; prefijo: number }[]).map((x) => ipObject(ctx.s, x.ip, x.prefijo, 'Manual')),
      psObject('MSFT_NetIPAddress', { IPAddress: '127.0.0.1', InterfaceIndex: 1, InterfaceAlias: 'Loopback Pseudo-Interface 1', AddressFamily: 'IPv4', Type: 'Unicast', PrefixLength: 8, PrefixOrigin: 'WellKnown', SuffixOrigin: 'WellKnown', AddressState: 'Preferred', ValidLifetime: 'Infinite ([TimeSpan]::MaxValue)', PreferredLifetime: 'Infinite ([TimeSpan]::MaxValue)', SkipAsSource: false, PolicyStore: 'ActiveStore' }),
    ]
    return items.filter((i) => (!has(ctx, 'AddressFamily') || psEquals(i.AddressFamily, param(ctx, 'AddressFamily'))) && (!has(ctx, 'InterfaceAlias') || wildcardToRegex(str(ctx, 'InterfaceAlias')!).test(toText(i.InterfaceAlias))) && (!has(ctx, 'InterfaceIndex') || Number(param(ctx, 'InterfaceIndex')) === i.InterfaceIndex) && (!has(ctx, 'IPAddress') || psEquals(i.IPAddress, param(ctx, 'IPAddress'))))
  },
})

function validIp(ip: string) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && ip.split('.').every((o) => Number(o) <= 255)
}

cmdlet('New-NetIPAddress', {
  params: ['InterfaceAlias', 'InterfaceIndex', 'IPAddress', 'PrefixLength', 'DefaultGateway', 'AddressFamily'],
  positional: ['IPAddress'],
  synopsis: 'Creates and configures an IP address.',
  module: 'NetTCPIP',
  whatIf: (ctx) => `Performing the operation "New" on target "IPAddress: ${str(ctx, 'IPAddress')}".`,
  run(ctx) {
    checkAlias(ctx, 'New-NetIPAddress')
    const ip = str(ctx, 'IPAddress') ?? ''
    if (!validIp(ip)) throw new PsError(`Cannot process argument transformation on parameter 'IPAddress'. Invalid IP address: '${ip}'.`, 'InvalidArgument', 'ParameterArgumentTransformationError,New-NetIPAddress', ip)
    const prefix = Number(param(ctx, 'PrefixLength') ?? 8)
    const r = ctx.s.state.red
    const gw = str(ctx, 'DefaultGateway')
    if (!r.dhcp && r.ip === ip) throw new PsError('Instance MSFT_NetIPAddress already exists', 'InvalidArgument', 'Windows System Error 87,New-NetIPAddress', 'MSFT_NetIPAddress')
    if (gw && !r.dhcp && r.puerta_enlace && ctx.s.data.gatewaySet?.[0]) throw new PsError('Instance MSFT_NetRoute already exists', 'InvalidArgument', 'Windows System Error 87,New-NetIPAddress', 'MSFT_NetRoute')
    if (r.dhcp || r.ip.startsWith('169.254.')) {
      // La primera IP fija apaga el DHCP de la placa.
      r.dhcp = false
      r.ip = ip
      r.prefijo = prefix
      r.puerta_enlace = gw ?? ''
    } else ((ctx.s.data.extraIps ??= []) as { ip: string; prefijo: number }[]).push({ ip, prefijo: prefix })
    if (gw) {
      r.puerta_enlace = gw
      ctx.s.data.gatewaySet = [true]
    }
    return [ipObject(ctx.s, ip, prefix, 'Manual')]
  },
})

cmdlet('Remove-NetIPAddress', {
  params: ['IPAddress', 'InterfaceAlias', 'InterfaceIndex', 'AddressFamily'],
  switches: ['Confirm'],
  positional: ['IPAddress'],
  synopsis: 'Removes an IP address and its configuration.',
  module: 'NetTCPIP',
  run(ctx) {
    const r = ctx.s.state.red
    const targets = [...list(ctx, 'IPAddress').map(toText), ...ctx.input.map((x) => toText((x as PsObject).IPAddress))]
    const extras = (ctx.s.data.extraIps ?? []) as { ip: string; prefijo: number }[]
    for (const ip of targets) {
      if (ip === r.ip) {
        const next = extras.shift()
        if (next) {
          r.ip = next.ip
          r.prefijo = next.prefijo
        } else r.ip = '169.254.12.34'
      } else ctx.s.data.extraIps = extras.filter((x) => x.ip !== ip)
    }
    return []
  },
})

cmdlet('Set-NetIPInterface', {
  params: ['InterfaceAlias', 'InterfaceIndex', 'Dhcp', 'AddressFamily'],
  positional: ['InterfaceAlias'],
  synopsis: 'Modifies an IP interface.',
  module: 'NetTCPIP',
  run(ctx) {
    checkAlias(ctx, 'Set-NetIPInterface')
    const r = ctx.s.state.red
    if (psEquals(param(ctx, 'Dhcp'), 'Enabled')) {
      r.dhcp = true
      r.ip = '169.254.12.34'
      r.prefijo = 16
      r.puerta_enlace = ''
      ctx.host('[simulador] La placa pidió IP por DHCP; como no hay servidor DHCP en esta red, quedó con una dirección APIPA (169.254.x.x).\n')
    }
    return []
  },
})

cmdlet('Get-DnsClientServerAddress', {
  params: ['InterfaceAlias', 'InterfaceIndex', 'AddressFamily'],
  positional: ['InterfaceAlias'],
  synopsis: 'Gets DNS server IP addresses from the TCP/IP properties on an interface.',
  module: 'DnsClient',
  run(ctx) {
    const r = ctx.s.state.red
    return [psObject('MSFT_DNSClientServerAddress', { InterfaceAlias: r.adaptador, InterfaceIndex: IFINDEX, AddressFamily: 'IPv4', ServerAddresses: r.dns.length ? `{${r.dns.join(', ')}}` : '{}' })]
  },
})
VIEWS['MSFT_DNSClientServerAddress'] = {
  kind: 'table',
  columns: [
    { label: 'InterfaceAlias', value: (o) => o.InterfaceAlias },
    { label: 'Interface Index', value: (o) => o.InterfaceIndex, align: 'right' },
    { label: 'Address Family', value: (o) => o.AddressFamily },
    { label: 'ServerAddresses', value: (o) => o.ServerAddresses },
  ],
}

cmdlet('Set-DnsClientServerAddress', {
  params: ['InterfaceAlias', 'InterfaceIndex', 'ServerAddresses'],
  switches: ['ResetServerAddresses', 'Validate'],
  positional: ['InterfaceAlias'],
  synopsis: 'Sets DNS server addresses associated with the TCP/IP properties on an interface.',
  module: 'DnsClient',
  run(ctx) {
    checkAlias(ctx, 'Set-DnsClientServerAddress')
    const r = ctx.s.state.red
    if (has(ctx, 'ResetServerAddresses')) r.dns = []
    else {
      const list2 = list(ctx, 'ServerAddresses').map(toText)
      for (const d of list2) if (!validIp(d)) throw new PsError(`Cannot validate argument on parameter 'ServerAddresses'. The argument "${d}" is not a valid IP address.`, 'InvalidData', 'ParameterArgumentValidationError,Set-DnsClientServerAddress', d)
      r.dns = list2
    }
    return []
  },
})

cmdlet('Clear-DnsClientCache', { synopsis: 'Clears the contents of the DNS client cache.', module: 'DnsClient', run: () => [] })

cmdlet('Get-NetConnectionProfile', {
  params: ['InterfaceAlias', 'InterfaceIndex', 'NetworkCategory'],
  synopsis: 'Gets a connection profile.',
  module: 'NetConnection',
  run(ctx) {
    const r = ctx.s.state.red
    if (!r.conectada) return []
    const cat = networkCategory(ctx.s)
    return [psObject('MSFT_NetConnectionProfile', { Name: ctx.s.state.dominio ?? (r.ip.startsWith('169.254.') ? 'Unidentified network' : 'Network'), InterfaceAlias: r.adaptador, InterfaceIndex: IFINDEX, NetworkCategory: cat, DomainAuthenticationKind: cat === 'DomainAuthenticated' ? 'Ldap' : 'None', IPv4Connectivity: r.ip.startsWith('169.254.') ? 'NoTraffic' : r.puerta_enlace ? 'Internet' : 'LocalNetwork', IPv6Connectivity: 'NoTraffic' })]
  },
})

cmdlet('Set-NetConnectionProfile', {
  params: ['InterfaceAlias', 'InterfaceIndex', 'NetworkCategory', 'Name'],
  synopsis: 'Changes the network category of a connection profile.',
  module: 'NetConnection',
  run(ctx) {
    const cat = str(ctx, 'NetworkCategory') ?? ''
    const ok = ['Public', 'Private'].find((c) => c.toLowerCase() === cat.toLowerCase())
    if (cat.toLowerCase() === 'domainauthenticated') throw new PsError("Unable to set NetworkCategory to 'DomainAuthenticated'. This NetworkCategory type will be set automatically when authenticated to a domain network.", 'InvalidArgument', 'Windows System Error 87,Set-NetConnectionProfile')
    if (!ok) throw new PsError(`Cannot process argument transformation on parameter 'NetworkCategory'. Cannot convert value "${cat}" to type "NetConnectionProfile.NetworkCategory".`, 'InvalidArgument', 'ParameterArgumentTransformationError,Set-NetConnectionProfile')
    if (networkCategory(ctx.s) === 'DomainAuthenticated') throw new PsError("Unable to set NetworkCategory on a DomainAuthenticated network.", 'InvalidOperation', 'Windows System Error 87,Set-NetConnectionProfile')
    ctx.s.data.netProfile = [ok]
    return []
  },
})

function renderIpconfig(s: PsSession, all: boolean): string {
  const r = s.state.red
  if (!r.conectada) return `\nWindows IP Configuration\n\n\nEthernet adapter ${r.adaptador}:\n\n   Media State . . . . . . . . . . . : Media disconnected\n   Connection-specific DNS Suffix  . : \n`
  const head = all ? `   Host Name . . . . . . . . . . . . : ${s.state.equipo}\n   Primary Dns Suffix  . . . . . . . : ${s.state.dominio ?? ''}\n   Node Type . . . . . . . . . . . . : Hybrid\n   IP Routing Enabled. . . . . . . . : No\n   WINS Proxy Enabled. . . . . . . . : No\n\n` : ''
  const apipa = r.ip.startsWith('169.254.')
  const lines = [
    '   Connection-specific DNS Suffix  . : ',
    ...(all ? [`   Description . . . . . . . . . . . : Microsoft Hyper-V Network Adapter`, `   Physical Address. . . . . . . . . : ${mac(s)}`, `   DHCP Enabled. . . . . . . . . . . : ${r.dhcp ? 'Yes' : 'No'}`, `   Autoconfiguration Enabled . . . . : Yes`] : []),
    `   ${apipa ? 'Autoconfiguration IPv4 Address' : 'IPv4 Address'}. . . . . . . . . . . : ${r.ip}${all ? '(Preferred)' : ''}`.replace('Autoconfiguration IPv4 Address. . . . . . . . . . .', 'Autoconfiguration IPv4 Address. .'),
    `   Subnet Mask . . . . . . . . . . . : ${prefixToMask(r.prefijo)}`,
    `   Default Gateway . . . . . . . . . : ${r.puerta_enlace}`,
    ...(all ? [`   DNS Servers . . . . . . . . . . . : ${r.dns.join('\n                                       ') || ''}`, '   NetBIOS over Tcpip. . . . . . . . : Enabled'] : []),
  ]
  return `\nWindows IP Configuration\n\n${head}\nEthernet adapter ${r.adaptador}:\n\n${lines.join('\n')}\n`
}

cmdlet('ipconfig', {
  params: ['all'],
  switches: ['all'],
  synopsis: 'Displays all current TCP/IP network configuration values (ipconfig.exe).',
  run(ctx) {
    const args = ctx.positional.map((p) => toText(p).toLowerCase())
    if (args.includes('/flushdns')) return [formatted('\nWindows IP Configuration\n\nSuccessfully flushed the DNS Resolver Cache.\n')]
    if (args.includes('/registerdns')) return [formatted('\nWindows IP Configuration\n\nRegistration of the DNS resource records for all adapters of this computer has been initiated. Any errors will be reported in the Event Viewer in 15 minutes.\n')]
    return [formatted(renderIpconfig(ctx.s, args.includes('/all')))]
  },
})

cmdlet('Get-NetIPConfiguration', {
  params: ['InterfaceAlias'],
  switches: ['Detailed', 'All'],
  synopsis: 'Gets IP network configuration.',
  module: 'NetTCPIP',
  run(ctx) {
    const r = ctx.s.state.red
    return [formatted(`\n\nInterfaceAlias       : ${r.adaptador}\nInterfaceIndex       : ${IFINDEX}\nInterfaceDescription : Microsoft Hyper-V Network Adapter\nNetProfile.Name      : ${r.conectada ? (ctx.s.state.dominio ?? (r.ip.startsWith('169.254.') ? 'Unidentified network' : 'Network')) : ''}\nIPv4Address          : ${r.conectada ? r.ip : ''}\nIPv4DefaultGateway   : ${r.puerta_enlace}\nDNSServer            : ${r.dns.join('\n                       ')}\n\n`)]
  },
}, ['gip'])

// ---------------------------------------------------------------------------------------
// Firewall
// ---------------------------------------------------------------------------------------

function rules(s: PsSession): PsObject[] {
  return (s.data.firewallRules ??= []) as PsObject[]
}

function profiles(s: PsSession): Record<string, boolean> {
  return ((s.data.firewallProfiles ??= [{ Domain: true, Private: true, Public: true }]) as Record<string, boolean>[])[0]
}

cmdlet('Get-NetFirewallProfile', {
  params: ['Name', 'Profile', 'PolicyStore'],
  switches: ['All'],
  positional: ['Name'],
  synopsis: 'Displays settings that apply to the per-profile configurations of the Windows Firewall with Advanced Security.',
  module: 'NetSecurity',
  run(ctx) {
    const want = [...list(ctx, 'Name'), ...list(ctx, 'Profile')].map((x) => toText(x).toLowerCase())
    const p = profiles(ctx.s)
    return (['Domain', 'Private', 'Public'] as const)
      .filter((n) => !want.length || want.includes(n.toLowerCase()))
      .map((n) => psObject('MSFT_NetFirewallProfile', { Name: n, Enabled: p[n] ? 'True' : 'False', DefaultInboundAction: 'NotConfigured', DefaultOutboundAction: 'NotConfigured', AllowInboundRules: 'NotConfigured', NotifyOnListen: 'False', LogFileName: '%systemroot%\\system32\\LogFiles\\Firewall\\pfirewall.log', LogBlocked: 'False', Active: activeProfile(ctx.s) === n ? 'True' : 'False' }))
  },
})

cmdlet('Set-NetFirewallProfile', {
  params: ['Name', 'Profile', 'Enabled', 'DefaultInboundAction', 'DefaultOutboundAction', 'LogBlocked'],
  switches: ['All'],
  positional: ['Name'],
  synopsis: 'Configures settings that apply to the per-profile configurations of the Windows Firewall with Advanced Security.',
  module: 'NetSecurity',
  run(ctx) {
    const names = [...list(ctx, 'Name'), ...list(ctx, 'Profile'), ...ctx.input.map((x) => (x as PsObject).Name)].map(toText)
    const targets = has(ctx, 'All') || !names.length ? ['Domain', 'Private', 'Public'] : names
    const p = profiles(ctx.s)
    if (has(ctx, 'Enabled')) {
      const en = /^(true|1|\$?true)$/i.test(toText(param(ctx, 'Enabled')))
      for (const t of targets) {
        const k = ['Domain', 'Private', 'Public'].find((x) => x.toLowerCase() === t.toLowerCase())
        if (k) p[k] = en
      }
    }
    return []
  },
})

function selectRules(ctx: CmdletContext): PsObject[] {
  const all = rules(ctx.s)
  const fromInput = ctx.input.filter((x) => (x as PsObject)?.__type === 'MSFT_NetFirewallRule') as PsObject[]
  if (fromInput.length) return fromInput.map((x) => all.find((r) => r.Name === x.Name) ?? x)
  const names = list(ctx, 'Name').map(toText)
  const displays = list(ctx, 'DisplayName').map(toText)
  const groups = list(ctx, 'DisplayGroup').map(toText)
  const pos = ctx.positional.map(toText)
  let out = all
  if (names.length || pos.length) out = out.filter((r) => [...names, ...pos].some((n) => wildcardToRegex(n).test(toText(r.Name))))
  if (displays.length) out = out.filter((r) => displays.some((n) => wildcardToRegex(n).test(toText(r.DisplayName))))
  if (groups.length) out = out.filter((r) => groups.some((n) => wildcardToRegex(n).test(toText(r.DisplayGroup))))
  if (has(ctx, 'Enabled')) out = out.filter((r) => psEquals(r.Enabled, param(ctx, 'Enabled')))
  if (has(ctx, 'Direction')) out = out.filter((r) => psEquals(r.Direction, param(ctx, 'Direction')))
  if (has(ctx, 'Action')) out = out.filter((r) => psEquals(r.Action, param(ctx, 'Action')))
  return out
}

function notFound(ctx: CmdletContext, cmd: string) {
  const prop = has(ctx, 'DisplayName') ? 'DisplayName' : has(ctx, 'DisplayGroup') ? 'DisplayGroup' : 'ID'
  const val = str(ctx, 'DisplayName') ?? str(ctx, 'DisplayGroup') ?? str(ctx, 'Name') ?? toText(ctx.positional[0])
  ctx.writeError(`No MSFT_NetFirewallRule objects found with property '${prop}' equal to '${val}'.  Verify the value of the property and retry.`, 'ObjectNotFound', val, `CmdletizationQuery_NotFound_${prop},${cmd}`)
}

const RULE_PARAMS = ['Name', 'DisplayName', 'DisplayGroup', 'Enabled', 'Direction', 'Action', 'PolicyStore', 'Group']

cmdlet('Get-NetFirewallRule', {
  params: RULE_PARAMS,
  switches: ['All'],
  positional: ['Name'],
  synopsis: 'Retrieves firewall rules from the target computer.',
  module: 'NetSecurity',
  run(ctx) {
    const out = selectRules(ctx)
    if (!out.length && (has(ctx, 'Name') || has(ctx, 'DisplayName') || has(ctx, 'DisplayGroup') || ctx.positional.length)) notFound(ctx, 'Get-NetFirewallRule')
    return out
  },
})

for (const [verb, en] of [['Enable', 'True'], ['Disable', 'False']] as const) {
  cmdlet(`${verb}-NetFirewallRule`, {
    params: RULE_PARAMS,
    switches: ['PassThru'],
    positional: ['Name'],
    synopsis: `${verb}s a previously disabled firewall rule.`,
    module: 'NetSecurity',
    whatIf: (ctx) => `${verb} firewall rule "${str(ctx, 'DisplayName') ?? str(ctx, 'Name') ?? str(ctx, 'DisplayGroup')}"`,
    run(ctx) {
      const out = selectRules(ctx)
      if (!out.length) notFound(ctx, `${verb}-NetFirewallRule`)
      for (const r of out) r.Enabled = en
      return has(ctx, 'PassThru') ? out : []
    },
  })
}

cmdlet('New-NetFirewallRule', {
  params: ['DisplayName', 'Name', 'Direction', 'Protocol', 'LocalPort', 'Action', 'Profile', 'RemoteAddress', 'Program', 'Group', 'Description', 'Enabled', 'IcmpType'],
  synopsis: 'Creates a new inbound or outbound firewall rule and adds the rule to the target computer.',
  module: 'NetSecurity',
  run(ctx) {
    const display = str(ctx, 'DisplayName')
    if (!display) throw new PsError("Cannot bind argument to parameter 'DisplayName' because it is an empty string.", 'InvalidData', 'ParameterArgumentValidationErrorEmptyStringNotAllowed,New-NetFirewallRule')
    const proto = (str(ctx, 'Protocol') ?? 'Any').toUpperCase().replace('ICMPV4', 'ICMPv4')
    const port = list(ctx, 'LocalPort').map(toText).join(',') || undefined
    if (port && !['TCP', 'UDP'].includes(proto)) throw new PsError('The port specification is only valid for the TCP and UDP protocols. Specify -Protocol TCP or UDP with -LocalPort.', 'InvalidArgument', 'Windows System Error 87,New-NetFirewallRule')
    const profile = list(ctx, 'Profile').map(toText).join(', ') || 'Any'
    const name = str(ctx, 'Name') ?? `{${stableGuid(`fw:${display}:${rules(ctx.s).length}`)}}`
    const r = ruleObject({ name, display, group: str(ctx, 'Group') ?? '', enabled: !psEquals(param(ctx, 'Enabled') ?? 'True', 'False'), proto: (proto === 'ICMPv4' ? 'ICMPv4' : proto === 'TCP' ? 'TCP' : proto === 'UDP' ? 'UDP' : 'Any'), port, profile, remote: list(ctx, 'RemoteAddress').map(toText).join(',') || 'Any', action: psEquals(param(ctx, 'Action'), 'Block') ? 'Block' : 'Allow', icmp: str(ctx, 'IcmpType') })
    r.Direction = psEquals(param(ctx, 'Direction'), 'Outbound') ? 'Outbound' : 'Inbound'
    r.Description = str(ctx, 'Description') ?? ''
    r.Status = 'The rule was parsed successfully from the store. (65536)'
    rules(ctx.s).push(r)
    return [r]
  },
})

cmdlet('Set-NetFirewallRule', {
  params: [...RULE_PARAMS, 'NewDisplayName', 'Profile', 'RemoteAddress', 'LocalPort', 'Protocol'],
  switches: ['PassThru'],
  positional: ['Name'],
  synopsis: 'Modifies existing firewall rules.',
  module: 'NetSecurity',
  run(ctx) {
    const sel = new Map(ctx.params)
    sel.delete('enabled')
    sel.delete('action')
    const out = selectRules({ ...ctx, params: sel })
    if (!out.length) notFound(ctx, 'Set-NetFirewallRule')
    for (const r of out) {
      if (has(ctx, 'Enabled')) r.Enabled = psEquals(param(ctx, 'Enabled'), 'True') || param(ctx, 'Enabled') === true ? 'True' : 'False'
      if (has(ctx, 'Profile')) r.Profile = list(ctx, 'Profile').map(toText).join(', ')
      if (has(ctx, 'RemoteAddress')) r.__remote = list(ctx, 'RemoteAddress').map(toText).join(',')
      if (has(ctx, 'LocalPort')) r.__port = list(ctx, 'LocalPort').map(toText).join(',')
      if (has(ctx, 'Action')) r.Action = psEquals(param(ctx, 'Action'), 'Block') ? 'Block' : 'Allow'
      if (has(ctx, 'NewDisplayName')) r.DisplayName = str(ctx, 'NewDisplayName')
    }
    return has(ctx, 'PassThru') ? out : []
  },
})

cmdlet('Remove-NetFirewallRule', {
  params: RULE_PARAMS,
  positional: ['Name'],
  synopsis: 'Deletes one or more firewall rules that match the specified criteria.',
  module: 'NetSecurity',
  run(ctx) {
    const out = selectRules(ctx)
    if (!out.length) notFound(ctx, 'Remove-NetFirewallRule')
    ctx.s.data.firewallRules = rules(ctx.s).filter((r) => !out.includes(r))
    return []
  },
})

cmdlet('Get-NetFirewallPortFilter', {
  params: ['Protocol'],
  synopsis: 'Retrieves port filter objects associated with the input firewall rules.',
  module: 'NetSecurity',
  run(ctx) {
    return ctx.input.filter((x) => (x as PsObject)?.__type === 'MSFT_NetFirewallRule').map((r) => psObject('MSFT_NetProtocolPortFilter', { Protocol: (r as PsObject).__protocol, LocalPort: (r as PsObject).__port ?? 'Any', RemotePort: 'Any', IcmpType: (r as PsObject).__icmp ?? 'Any', DynamicTarget: 'Any' }))
  },
})

cmdlet('Get-NetFirewallAddressFilter', {
  synopsis: 'Retrieves address filter objects associated with the input firewall rules.',
  module: 'NetSecurity',
  run(ctx) {
    return ctx.input.filter((x) => (x as PsObject)?.__type === 'MSFT_NetFirewallRule').map((r) => psObject('MSFT_NetAddressFilter', { LocalAddress: 'Any', RemoteAddress: (r as PsObject).__remote ?? 'Any' }))
  },
})

// ---------------------------------------------------------------------------------------
// Nombre, reinicio, información del equipo, zona horaria, sconfig y escritorio remoto
// ---------------------------------------------------------------------------------------

cmdlet('Rename-Computer', {
  params: ['NewName', 'ComputerName', 'DomainCredential', 'LocalCredential'],
  switches: ['Restart', 'Force', 'PassThru'],
  positional: ['NewName'],
  synopsis: 'Renames a computer.',
  run(ctx) {
    const name = str(ctx, 'NewName') ?? ''
    if (!/^[A-Za-z0-9-]{1,15}$/.test(name) || /^\d+$/.test(name)) throw new PsError(`Skip computer '${ctx.s.state.equipo}' with new name '${name}' because the new name is not valid. The new computer name entered is not properly formatted. Standard names may contain letters (a-z, A-Z), numbers (0-9), and hyphens (-), but no spaces or periods (.). The name may not consist entirely of digits, and may not be longer than 63 characters.`, 'InvalidArgument', 'InvalidNewName,Microsoft.PowerShell.Commands.RenameComputerCommand', name)
    if (name.toLowerCase() === ctx.s.state.equipo.toLowerCase()) throw new PsError(`Skip computer '${ctx.s.state.equipo}' with new name '${name}' because the new name is the same as the current name.`, 'InvalidArgument', 'NewNameIsOldName,Microsoft.PowerShell.Commands.RenameComputerCommand', name)
    ctx.s.pending.name = name
    if (has(ctx, 'Restart')) {
      restart(ctx)
      return []
    }
    ctx.host(`WARNING: The changes will take effect after you restart the computer ${ctx.s.state.equipo}.\n`)
    return []
  },
})

/** Aplica lo que estaba pendiente (nombre, dominio, roles) como un reinicio. */
export function restart(ctx: CmdletContext) {
  const s = ctx.s
  if (s.pending.name) {
    s.lab?.sessions.delete(s.state.equipo.toLowerCase())
    s.state.equipo = s.pending.name
    s.lab?.add(s)
    s.pending.name = undefined
  }
  for (const m of s.pending.messages) ctx.host(m)
  s.pending.messages = []
  const pend = s.data.onRestart as (() => void)[] | undefined
  for (const fn of pend ?? []) fn()
  s.data.onRestart = []
  s.data.bootTime = [new Date()]
  ctx.host(`[simulador] ${s.state.equipo} se reinició y ya está de vuelta.\n`)
}

for (const n of ['Restart-Computer', 'Stop-Computer']) {
  cmdlet(n, {
    params: ['ComputerName', 'For', 'Timeout', 'Credential'],
    switches: ['Force', 'Wait'],
    synopsis: n === 'Restart-Computer' ? 'Restarts the operating system on local and remote computers.' : 'Stops (shuts down) local and remote computers.',
    run(ctx) {
      const targets = list(ctx, 'ComputerName').map(toText)
      if (n === 'Stop-Computer') {
        ctx.host('[simulador] El servidor no se apaga en el simulador.\n')
        return []
      }
      if (!targets.length) {
        restart(ctx)
        return []
      }
      for (const t of targets) {
        const r = connect(ctx.s, t)
        if (r instanceof PsError) {
          ctx.writeError(`Failed to restart the computer ${t} with the following error message: The RPC server is unavailable.`, 'OperationStopped', t)
          continue
        }
        restart({ ...ctx, s: r })
      }
      return []
    },
  })
}

const TZ: Record<string, [string, string]> = {
  'Pacific Standard Time': ['(UTC-08:00) Pacific Time (US & Canada)', '-08:00:00'],
  'Eastern Standard Time': ['(UTC-05:00) Eastern Time (US & Canada)', '-05:00:00'],
  'Argentina Standard Time': ['(UTC-03:00) City of Buenos Aires', '-03:00:00'],
  'Montevideo Standard Time': ['(UTC-03:00) Montevideo', '-03:00:00'],
  'E. South America Standard Time': ['(UTC-03:00) Brasilia', '-03:00:00'],
  'Pacific SA Standard Time': ['(UTC-04:00) Santiago', '-04:00:00'],
  'Paraguay Standard Time': ['(UTC-03:00) Asuncion', '-03:00:00'],
  'SA Pacific Standard Time': ['(UTC-05:00) Bogota, Lima, Quito, Rio Branco', '-05:00:00'],
  'Central Standard Time (Mexico)': ['(UTC-06:00) Guadalajara, Mexico City, Monterrey', '-06:00:00'],
  'Romance Standard Time': ['(UTC+01:00) Brussels, Copenhagen, Madrid, Paris', '01:00:00'],
  UTC: ['(UTC) Coordinated Universal Time', '00:00:00'],
}

function tzObject(id: string): PsObject {
  const [display, offset] = TZ[id] ?? [id, '00:00:00']
  return psObject('System.TimeZoneInfo', { Id: id, DisplayName: display, StandardName: id, DaylightName: id.replace('Standard', 'Daylight'), BaseUtcOffset: offset, SupportsDaylightSavingTime: !/Argentina|UTC|Montevideo|SA Pacific|Brasilia|E\. South/.test(id) })
}

cmdlet('Get-TimeZone', {
  params: ['Id', 'Name'],
  switches: ['ListAvailable'],
  positional: ['Name'],
  synopsis: 'Gets the current time zone or a list of available time zones.',
  run(ctx) {
    if (has(ctx, 'ListAvailable')) return Object.keys(TZ).map(tzObject)
    return [tzObject(toText(ctx.s.data.timeZone?.[0] ?? 'Pacific Standard Time'))]
  },
})

cmdlet('Set-TimeZone', {
  params: ['Id', 'Name', 'InputObject'],
  switches: ['PassThru'],
  positional: ['Name'],
  synopsis: 'Sets the system time zone to a specified time zone.',
  run(ctx) {
    const id = str(ctx, 'Id')
    const name = str(ctx, 'Name')
    const found = id ? Object.keys(TZ).find((k) => k.toLowerCase() === id.toLowerCase()) : Object.keys(TZ).find((k) => k.toLowerCase() === name?.toLowerCase() || TZ[k][0].toLowerCase().includes((name ?? '').toLowerCase()))
    if (!found) throw new PsError(`The time zone ${id ? `Id '${id}'` : `name '${name}'`} was not found on the local computer.`, 'InvalidArgument', `TimeZoneNotFound,Microsoft.PowerShell.Commands.SetTimeZoneCommand`, id ?? name)
    ctx.s.data.timeZone = [found]
    return has(ctx, 'PassThru') ? [tzObject(found)] : []
  },
})

cmdlet('tzutil', {
  synopsis: 'tzutil.exe',
  run(ctx) {
    const a = ctx.positional.map(toText)
    if (a[0]?.toLowerCase() === '/g') return [toText(ctx.s.data.timeZone?.[0])]
    if (a[0]?.toLowerCase() === '/s') {
      const found = Object.keys(TZ).find((k) => k.toLowerCase() === (a[1] ?? '').toLowerCase())
      if (!found) return [formatted('Error: Invalid time zone identifier.\n')]
      ctx.s.data.timeZone = [found]
      return []
    }
    if (a[0]?.toLowerCase() === '/l') return [Object.entries(TZ).map(([k, v]) => `${v[0]}\n${k}\n`).join('\n')]
    return [formatted('Windows Time Zone Utility\n\nUsage:\nTZUTIL </? | /g | /s TimeZoneID[_dstoff] | /l>\n')]
  },
})

function productName(s: PsSession) {
  return `Windows Server 2025 ${s.state.edicion}`
}

cmdlet('Get-ComputerInfo', {
  params: ['Property'],
  positional: ['Property'],
  synopsis: 'Gets a consolidated object of system and operating system properties.',
  run(ctx) {
    const st = ctx.s.state
    const o = psObject('Microsoft.PowerShell.Commands.ComputerInfo', {
      WindowsBuildLabEx: '26100.1.amd64fre.ge_release.240331-1435',
      WindowsCurrentVersion: '6.3',
      WindowsEditionId: st.edicion === 'Standard' ? 'ServerStandard' : 'ServerDatacenter',
      WindowsInstallationType: isCore(ctx.s) ? 'Server Core' : 'Server',
      WindowsProductName: productName(ctx.s),
      WindowsVersion: '2009',
      OsName: `Microsoft ${productName(ctx.s)}`,
      OsVersion: '10.0.26100',
      OsBuildNumber: '26100',
      OsArchitecture: '64-bit',
      OsLastBootUpTime: (ctx.s.data.bootTime?.[0] as Date | undefined) ?? new Date(Date.now() - 3 * 86_400_000),
      OsLanguage: 'en-US',
      CsName: st.equipo,
      CsDomain: st.dominio ?? 'WORKGROUP',
      CsPartOfDomain: !!st.dominio,
      CsDomainRole: st.dominio ? (ctx.s.data.ad?.length ? 'PrimaryDomainController' : 'MemberServer') : 'StandaloneServer',
      CsManufacturer: 'Microsoft Corporation',
      CsModel: 'Virtual Machine',
      CsNumberOfLogicalProcessors: 4,
      CsTotalPhysicalMemory: 8 * GB,
      TimeZone: tzObject(toText(ctx.s.data.timeZone?.[0])).DisplayName,
      HyperVisorPresent: true,
    })
    const props = list(ctx, 'Property').map(toText)
    if (!props.length) return [o]
    const sel: Record<string, unknown> = {}
    for (const k of Object.keys(o)) if (!k.startsWith('__') && props.some((p) => wildcardToRegex(p).test(k))) sel[k] = o[k]
    return [psObject('Microsoft.PowerShell.Commands.ComputerInfo', sel)]
  },
}, ['gin'])

cmdlet('systeminfo', {
  synopsis: 'systeminfo.exe',
  run(ctx) {
    const st = ctx.s.state
    const hf = ((ctx.s.data.hotfixes ?? []) as PsObject[]).map((h, i) => `                           [${String(i + 1).padStart(2, '0')}]: ${toText(h.HotFixID)}`)
    return [formatted(`\nHost Name:                 ${st.equipo}\nOS Name:                   Microsoft ${productName(ctx.s)}\nOS Version:                10.0.26100 N/A Build 26100\nOS Manufacturer:           Microsoft Corporation\nOS Configuration:          ${st.dominio ? (ctx.s.data.ad?.length ? 'Primary Domain Controller' : 'Member Server') : 'Standalone Server'}\nOS Build Type:             Multiprocessor Free\nSystem Manufacturer:       Microsoft Corporation\nSystem Model:              Virtual Machine\nSystem Type:               x64-based PC\nTime Zone:                 ${tzObject(toText(ctx.s.data.timeZone?.[0])).DisplayName}\nTotal Physical Memory:     8,192 MB\nDomain:                    ${st.dominio ?? 'WORKGROUP'}\nHotfix(s):                 ${hf.length} Hotfix(s) Installed.\n${hf.join('\n')}\nNetwork Card(s):           1 NIC(s) Installed.\n                           [01]: Microsoft Hyper-V Network Adapter\n                                 Connection Name: ${st.red.adaptador}\n                                 DHCP Enabled:    ${st.red.dhcp ? 'Yes' : 'No'}\n                                 IP address(es)\n                                 [01]: ${st.red.ip}\n`)]
  },
})

cmdlet('sconfig', {
  synopsis: 'Server Configuration tool.',
  run(ctx) {
    const st = ctx.s.state
    const rm = ctx.s.data.winrm?.[0] ? 'Enabled' : 'Disabled'
    const rdp = ctx.s.data.rdp?.[0] ? 'Enabled (all clients)' : 'Disabled'
    const dom = st.dominio ? `Domain: ${st.dominio}` : 'Workgroup: WORKGROUP'
    return [formatted(`================================================================================\n                 Welcome to ${productName(ctx.s)}\n================================================================================\n\n  1)  Domain/workgroup:                   ${dom}\n  2)  Computer name:                      ${st.equipo}${ctx.s.pending.name ? ` (después de reiniciar: ${ctx.s.pending.name})` : ''}\n  3)  Add local administrator\n  4)  Remote management:                  ${rm}\n\n  5)  Update setting:                     Download only\n  6)  Install updates\n  7)  Remote desktop:                     ${rdp}\n\n  8)  Network settings\n  9)  Date and time\n  10) Telemetry setting:                  Required\n  11) Windows activation\n\n  12) Log off user\n  13) Restart server\n  14) Shut down server\n  15) Exit to command line (PowerShell)\n\n[simulador] El menú de sconfig no es interactivo acá. Cada opción tiene su cmdlet: 1 Add-Computer, 2 Rename-Computer, 4 Enable-PSRemoting, 7 Escritorio remoto (Set-ItemProperty fDenyTSConnections 0 y la regla de firewall), 8 New-NetIPAddress y Set-DnsClientServerAddress, 9 Set-TimeZone, 13 Restart-Computer.\n`)]
  },
})

const TS_KEY = /^hklm:\\system\\currentcontrolset\\control\\terminal server$/i

cmdlet('Get-ItemProperty', {
  params: ['Path', 'Name'],
  positional: ['Path', 'Name'],
  synopsis: 'Gets the properties of a specified item.',
  run(ctx) {
    const path = (str(ctx, 'Path') ?? '').replace(/\//g, '\\')
    if (TS_KEY.test(path)) return [psObject('System.Management.Automation.PSCustomObject', { fDenyTSConnections: ctx.s.data.rdp?.[0] ? 0 : 1, PSPath: `Microsoft.PowerShell.Core\\Registry::HKEY_LOCAL_MACHINE\\System\\CurrentControlSet\\Control\\Terminal Server` })]
    throw new PsError(`[simulador] El registro simulado solo tiene la clave del Escritorio remoto (HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server).`, 'NotImplemented', 'NotSupported', path)
  },
}, ['gp'])

cmdlet('Set-ItemProperty', {
  params: ['Path', 'Name', 'Value', 'Type'],
  positional: ['Path', 'Name', 'Value'],
  synopsis: 'Creates or changes the value of a property of an item.',
  run(ctx) {
    const path = (str(ctx, 'Path') ?? '').replace(/\//g, '\\')
    if (TS_KEY.test(path) && psEquals(param(ctx, 'Name'), 'fDenyTSConnections')) {
      ctx.s.data.rdp = [Number(param(ctx, 'Value')) === 0]
      return []
    }
    throw new PsError(`[simulador] El registro simulado solo tiene el valor fDenyTSConnections de HKLM:\\System\\CurrentControlSet\\Control\\Terminal Server.`, 'NotImplemented', 'NotSupported', path)
  },
}, ['sp'])

// ---------------------------------------------------------------------------------------
// Discos, particiones y volúmenes
// ---------------------------------------------------------------------------------------

function diskObject(d: DiskState): PsObject {
  return psObject('MSFT_Disk', { Number: d.numero, FriendlyName: d.modelo, SerialNumber: '', HealthStatus: 'Healthy', OperationalStatus: d.offline ? 'Offline' : 'Online', Size: d.tamano_gb * GB, PartitionStyle: d.estilo, IsOffline: d.offline, IsReadOnly: false, BusType: d.bus, AllocatedSize: d.particiones.reduce((a, p) => a + p.tamano_gb, 0) * GB })
}
VIEWS['MSFT_Disk'] = {
  kind: 'table',
  columns: [
    { label: 'Number', value: (o) => o.Number, align: 'right' },
    { label: 'Friendly Name', value: (o) => o.FriendlyName },
    { label: 'Serial Number', value: (o) => o.SerialNumber },
    { label: 'HealthStatus', value: (o) => o.HealthStatus },
    { label: 'OperationalStatus', value: (o) => o.OperationalStatus },
    { label: 'Total Size', value: (o) => fmtSize(Number(o.Size)), align: 'right' },
    { label: 'Partition Style', value: (o) => o.PartitionStyle },
  ],
}

function getDisk(ctx: CmdletContext, cmd: string): DiskState {
  const n = param(ctx, 'Number') ?? param(ctx, 'DiskNumber') ?? (ctx.input[0] as PsObject | undefined)?.Number ?? ctx.positional[0]
  const d = disks(ctx.s).find((x) => x.numero === Number(n))
  if (!d) throw new PsError(`No MSFT_Disk objects found with property 'Number' equal to '${toText(n)}'.  Verify the value of the property and retry.`, 'ObjectNotFound', `CmdletizationQuery_NotFound_Number,${cmd}`, toText(n))
  return d
}

cmdlet('Get-Disk', {
  params: ['Number', 'FriendlyName'],
  positional: ['Number'],
  synopsis: 'Gets one or more disks visible to the operating system.',
  module: 'Storage',
  run(ctx) {
    if (has(ctx, 'Number') || ctx.positional.length) return [diskObject(getDisk(ctx, 'Get-Disk'))]
    return disks(ctx.s).map(diskObject)
  },
})

cmdlet('Get-PhysicalDisk', {
  params: ['FriendlyName'],
  synopsis: 'Gets a list of all PhysicalDisk objects visible across any available Storage Management Providers.',
  module: 'Storage',
  run(ctx) {
    return disks(ctx.s).map((d) => psObject('MSFT_PhysicalDisk', { DeviceId: String(d.numero), FriendlyName: d.modelo, SerialNumber: '', MediaType: 'Unspecified', CanPool: d.estilo === 'RAW', OperationalStatus: 'OK', HealthStatus: 'Healthy', Usage: 'Auto-Select', Size: fmtSize(d.tamano_gb * GB) }))
  },
})

cmdlet('Set-Disk', {
  params: ['Number', 'IsOffline', 'IsReadOnly'],
  positional: ['Number'],
  synopsis: 'Takes a Disk object or String as input and modifies the disk.',
  module: 'Storage',
  run(ctx) {
    const d = getDisk(ctx, 'Set-Disk')
    if (has(ctx, 'IsOffline')) d.offline = param(ctx, 'IsOffline') === true || psEquals(param(ctx, 'IsOffline'), 'true')
    return []
  },
})

cmdlet('Initialize-Disk', {
  params: ['Number', 'PartitionStyle'],
  switches: ['PassThru'],
  positional: ['Number'],
  synopsis: 'Initializes a RAW disk for first time use, enabling the disk to be formatted and used to store data.',
  module: 'Storage',
  run(ctx) {
    const d = getDisk(ctx, 'Initialize-Disk')
    if (d.offline) throw new PsError('The disk is offline.', 'NotSpecified', 'StorageWMI 41004,Initialize-Disk', toText(d.numero))
    if (d.estilo !== 'RAW') throw new PsError('The disk has already been initialized.', 'NotSpecified', 'StorageWMI 41001,Initialize-Disk', toText(d.numero))
    const style = (str(ctx, 'PartitionStyle') ?? 'GPT').toUpperCase()
    if (!['GPT', 'MBR'].includes(style)) throw new PsError(`Cannot bind parameter 'PartitionStyle'. Cannot convert value "${style}" to type "PartitionStyle".`, 'InvalidArgument', 'CannotConvertArgumentNoMessage,Initialize-Disk')
    if (style === 'MBR' && d.tamano_gb > 2048) ctx.host('WARNING: MBR solo puede usar 2 TB de este disco. Para discos grandes, GPT.\n')
    d.estilo = style as 'GPT' | 'MBR'
    // GPT guarda una partición reservada de Microsoft (MSR) de 16 MB.
    if (style === 'GPT') d.particiones.push({ tamano_gb: 0.016, etiqueta: '', tipo: 'Reserved', usado_gb: 0 })
    return has(ctx, 'PassThru') ? [diskObject(d)] : []
  },
})

function freeGb(d: DiskState) {
  return Math.max(0, d.tamano_gb - d.particiones.reduce((a, p) => a + p.tamano_gb, 0) - 0.001)
}

function usedLetters(s: PsSession) {
  return new Set(['A', 'B', ...disks(s).flatMap((d) => d.particiones.map((p) => p.letra?.toUpperCase()).filter(Boolean) as string[])])
}

function partitionObject(d: DiskState, p: DiskPartition, i: number): PsObject {
  return psObject('MSFT_Partition', { DiskNumber: d.numero, PartitionNumber: i + 1, DriveLetter: p.letra ?? '', Offset: 1048576 + i * 104857600, Size: p.tamano_gb * GB, Type: p.tipo, __disk: d.numero })
}
VIEWS['MSFT_Partition'] = {
  kind: 'table',
  groupBy: (o) => `\n   DiskPath: \\\\?\\scsi#disk&ven_msft&prod_virtual_disk#5&${String(o.__disk).padStart(2, '0')}#{53f56307-b6bf-11d0-94f2-00a0c91efb8b}\n\n`,
  columns: [
    { label: 'PartitionNumber', value: (o) => o.PartitionNumber },
    { label: 'DriveLetter', value: (o) => o.DriveLetter },
    { label: 'Offset', value: (o) => o.Offset },
    { label: 'Size', value: (o) => fmtSize(Number(o.Size)), align: 'right' },
    { label: 'Type', value: (o) => o.Type },
  ],
}

cmdlet('New-Partition', {
  params: ['DiskNumber', 'Size', 'DriveLetter'],
  switches: ['UseMaximumSize', 'AssignDriveLetter'],
  positional: ['DiskNumber'],
  synopsis: 'Creates a new partition on an existing Disk object.',
  module: 'Storage',
  run(ctx) {
    const d = getDisk(ctx, 'New-Partition')
    if (d.offline) throw new PsError('The disk is offline.', 'NotSpecified', 'StorageWMI 41004,New-Partition')
    if (d.estilo === 'RAW') throw new PsError('The disk has not been initialized.', 'NotSpecified', 'StorageWMI 41008,New-Partition')
    const free = freeGb(d)
    const size = has(ctx, 'UseMaximumSize') ? free : Number(param(ctx, 'Size') ?? 0) / GB
    if (!size || size > free + 0.01) throw new PsError('Not enough available capacity', 'NotSpecified', 'StorageWMI 40000,New-Partition')
    let letter = str(ctx, 'DriveLetter')?.toUpperCase()
    const used = usedLetters(ctx.s)
    if (letter && used.has(letter)) throw new PsError('The requested access path is already in use.', 'NotSpecified', 'StorageWMI 42002,New-Partition')
    if (!letter && has(ctx, 'AssignDriveLetter')) letter = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').find((l) => !used.has(l))
    const p: DiskPartition = { letra: letter, tamano_gb: Number(size.toFixed(2)), etiqueta: '', tipo: 'Basic', usado_gb: 0 }
    d.particiones.push(p)
    return [partitionObject(d, p, d.particiones.length - 1)]
  },
})

cmdlet('Get-Partition', {
  params: ['DiskNumber', 'DriveLetter'],
  positional: ['DiskNumber'],
  synopsis: 'Returns a list of all partition objects visible on all disks, or optionally a filtered list using specified parameters.',
  module: 'Storage',
  run(ctx) {
    const out: PsObject[] = []
    for (const d of disks(ctx.s)) {
      if (has(ctx, 'DiskNumber') && Number(param(ctx, 'DiskNumber')) !== d.numero) continue
      d.particiones.forEach((p, i) => {
        if (has(ctx, 'DriveLetter') && !psEquals(p.letra, param(ctx, 'DriveLetter'))) return
        out.push(partitionObject(d, p, i))
      })
    }
    if (!out.length && has(ctx, 'DriveLetter')) throw new PsError(`No MSFT_Partition objects found with property 'DriveLetter' equal to '${str(ctx, 'DriveLetter')}'.  Verify the value of the property and retry.`, 'ObjectNotFound', 'CmdletizationQuery_NotFound_DriveLetter,Get-Partition', str(ctx, 'DriveLetter'))
    return out
  },
})

function findPartition(ctx: CmdletContext, cmd: string): { d: DiskState; p: DiskPartition } {
  const inp = ctx.input[0] as PsObject | undefined
  const letter = (str(ctx, 'DriveLetter') ?? (inp?.DriveLetter as string | undefined) ?? '').toUpperCase()
  for (const d of disks(ctx.s)) {
    if (!letter && inp) {
      const p = d.particiones[Number(inp.PartitionNumber) - 1]
      if (d.numero === inp.DiskNumber && p) return { d, p }
    }
    for (const p of d.particiones) if (letter && p.letra?.toUpperCase() === letter) return { d, p }
  }
  throw new PsError(`No MSFT_Volume objects found with property 'DriveLetter' equal to '${letter}'.  Verify the value of the property and retry.`, 'ObjectNotFound', `CmdletizationQuery_NotFound_DriveLetter,${cmd}`, letter)
}

function volumeObject(p: DiskPartition): PsObject {
  return psObject('MSFT_Volume', { DriveLetter: p.letra ?? '', FriendlyName: p.etiqueta, FileSystemType: p.sistema ?? 'Unknown', DriveType: 'Fixed', HealthStatus: 'Healthy', OperationalStatus: 'OK', SizeRemaining: Math.max(0, p.tamano_gb - p.usado_gb) * GB, Size: p.tamano_gb * GB })
}
VIEWS['MSFT_Volume'] = {
  kind: 'table',
  columns: [
    { label: 'DriveLetter', value: (o) => o.DriveLetter },
    { label: 'FriendlyName', value: (o) => o.FriendlyName },
    { label: 'FileSystemType', value: (o) => o.FileSystemType },
    { label: 'DriveType', value: (o) => o.DriveType },
    { label: 'HealthStatus', value: (o) => o.HealthStatus },
    { label: 'OperationalStatus', value: (o) => o.OperationalStatus },
    { label: 'SizeRemaining', value: (o) => fmtSize(Number(o.SizeRemaining)), align: 'right' },
    { label: 'Size', value: (o) => fmtSize(Number(o.Size)), align: 'right' },
  ],
}

cmdlet('Format-Volume', {
  params: ['DriveLetter', 'FileSystem', 'NewFileSystemLabel', 'AllocationUnitSize', 'Partition'],
  switches: ['Full', 'Force'],
  positional: ['DriveLetter'],
  synopsis: 'Formats one or more existing volumes or a new volume on an existing partition.',
  module: 'Storage',
  run(ctx) {
    const { p } = findPartition(ctx, 'Format-Volume')
    const fs = (str(ctx, 'FileSystem') ?? 'NTFS').toUpperCase().replace('REFS', 'ReFS')
    if (!['NTFS', 'ReFS', 'FAT32'].includes(fs)) throw new PsError(`Cannot bind parameter 'FileSystem'. Cannot convert value "${fs}" to type "FileSystemType".`, 'InvalidArgument', 'CannotConvertArgumentNoMessage,Format-Volume')
    if (fs === 'FAT32' && p.tamano_gb > 32) throw new PsError('The size of the volume is too large for the FAT32 file system (maximum 32 GB with Format-Volume).', 'NotSpecified', 'StorageWMI 43020,Format-Volume')
    if (p.sistema && !has(ctx, 'Force') && ctx.params.get('confirm') !== false) ctx.host('[simulador] Sin -Confirm:$false, PowerShell pregunta antes de borrar los datos del volumen; acá se da por aceptado.\n')
    p.sistema = fs as 'NTFS' | 'ReFS' | 'FAT32'
    p.etiqueta = str(ctx, 'NewFileSystemLabel') ?? ''
    p.usado_gb = fs === 'ReFS' ? Number((p.tamano_gb * 0.012).toFixed(2)) : 0.09
    if (p.letra) ctx.s.fs.mkdirp(`${p.letra}:\\`)
    return [volumeObject(p)]
  },
})

cmdlet('Get-Volume', {
  params: ['DriveLetter', 'FileSystemLabel'],
  positional: ['DriveLetter'],
  synopsis: 'Gets the specified Volume object, or all Volume objects if no filter is provided.',
  module: 'Storage',
  run(ctx) {
    if (has(ctx, 'DriveLetter') || ctx.positional.length) {
      if (!has(ctx, 'DriveLetter')) ctx.params.set('driveletter', ctx.positional[0])
      return [volumeObject(findPartition(ctx, 'Get-Volume').p)]
    }
    return disks(ctx.s).flatMap((d) => d.particiones.filter((p) => p.sistema && p.tipo !== 'Reserved').map(volumeObject))
  },
})

cmdlet('Get-PartitionSupportedSize', {
  params: ['DriveLetter', 'DiskNumber', 'PartitionNumber'],
  synopsis: 'Returns information on supported partition sizes for the specified Disk object.',
  module: 'Storage',
  run(ctx) {
    const { d, p } = findPartition(ctx, 'Get-PartitionSupportedSize')
    return [psObject('System.Management.Automation.PSCustomObject', { SizeMin: Math.ceil(p.usado_gb + 0.05) * GB, SizeMax: (p.tamano_gb + freeGb(d)) * GB })]
  },
})

cmdlet('Resize-Partition', {
  params: ['DriveLetter', 'Size', 'DiskNumber', 'PartitionNumber'],
  positional: ['DriveLetter'],
  synopsis: 'Resizes a partition and the underlying file system.',
  module: 'Storage',
  run(ctx) {
    const { d, p } = findPartition(ctx, 'Resize-Partition')
    const size = Number(param(ctx, 'Size') ?? 0) / GB
    const max = p.tamano_gb + freeGb(d)
    if (size > max + 0.01) throw new PsError('Size Not Supported', 'NotSpecified', 'StorageWMI 4097,Resize-Partition')
    if (size < p.usado_gb) throw new PsError('The size of the extent is less than the minimum of 1MB.', 'NotSpecified', 'StorageWMI 4097,Resize-Partition')
    p.tamano_gb = Number(size.toFixed(2))
    return []
  },
})

cmdlet('Get-PSDrive', {
  params: ['Name', 'PSProvider'],
  positional: ['Name'],
  synopsis: 'Gets drives in the current session.',
  run(ctx) {
    const vols = disks(ctx.s).flatMap((d) => d.particiones).filter((p) => p.letra && p.sistema)
    const fsDrives = vols.map((p) => psObject('System.Management.Automation.PSDriveInfo', { Name: p.letra!, 'Used (GB)': Number(p.usado_gb.toFixed(2)), 'Free (GB)': Number((p.tamano_gb - p.usado_gb).toFixed(2)), Provider: 'FileSystem', Root: `${p.letra}:\\`, CurrentLocation: '' }))
    const others = ['Alias', 'Cert', 'Env', 'Function', 'HKCU', 'HKLM', 'Variable', 'WSMan'].map((n) => psObject('System.Management.Automation.PSDriveInfo', { Name: n, 'Used (GB)': '', 'Free (GB)': '', Provider: { Alias: 'Alias', Cert: 'Certificate', Env: 'Environment', Function: 'Function', HKCU: 'Registry', HKLM: 'Registry', Variable: 'Variable', WSMan: 'WSMan' }[n], Root: n.startsWith('HK') ? (n === 'HKLM' ? 'HKEY_LOCAL_MACHINE' : 'HKEY_CURRENT_USER') : '\\', CurrentLocation: '' }))
    let all = [...fsDrives, ...others].sort((a, b) => toText(a.Name).localeCompare(toText(b.Name)))
    if (has(ctx, 'PSProvider')) all = all.filter((x) => psEquals(x.Provider, param(ctx, 'PSProvider')))
    if (has(ctx, 'Name')) all = all.filter((x) => list(ctx, 'Name').some((n) => psEquals(x.Name, n)))
    return all
  },
}, ['gdr'])
VIEWS['System.Management.Automation.PSDriveInfo'] = {
  kind: 'table',
  columns: [
    { label: 'Name', value: (o) => o.Name },
    { label: 'Used (GB)', value: (o) => o['Used (GB)'], align: 'right' },
    { label: 'Free (GB)', value: (o) => o['Free (GB)'], align: 'right' },
    { label: 'Provider', value: (o) => o.Provider },
    { label: 'Root', value: (o) => o.Root },
  ],
}

// ---------------------------------------------------------------------------------------
// CIM / WMI, actualizaciones instaladas
// ---------------------------------------------------------------------------------------

function cimData(s: PsSession, cls: string): PsObject[] | undefined {
  const st = s.state
  const c = cls.toLowerCase()
  const T = (name: string, props: Record<string, unknown>) => psObject(`Microsoft.Management.Infrastructure.CimInstance#root/cimv2/${name}`, props)
  if (c === 'win32_operatingsystem')
    return [T('Win32_OperatingSystem', { SystemDirectory: 'C:\\Windows\\system32', Organization: '', BuildNumber: '26100', RegisteredUser: 'Windows User', SerialNumber: '00454-60000-00001-AA111', Version: '10.0.26100', Caption: `Microsoft ${productName(s)}`, CSName: st.equipo, LastBootUpTime: (s.data.bootTime?.[0] as Date | undefined) ?? new Date(Date.now() - 3 * 86_400_000), TotalVisibleMemorySize: 8388608, FreePhysicalMemory: 4718592, OSArchitecture: '64-bit' })]
  if (c === 'win32_computersystem') return [T('Win32_ComputerSystem', { Name: st.equipo, PrimaryOwnerName: 'Windows User', Domain: st.dominio ?? 'WORKGROUP', TotalPhysicalMemory: 8 * GB, Model: 'Virtual Machine', Manufacturer: 'Microsoft Corporation', PartOfDomain: !!st.dominio, NumberOfLogicalProcessors: 4 })]
  if (c === 'win32_logicaldisk')
    return disks(s)
      .flatMap((d) => d.particiones)
      .filter((p) => p.letra && p.sistema)
      .map((p) => T('Win32_LogicalDisk', { DeviceID: `${p.letra}:`, DriveType: 3, ProviderName: '', VolumeName: p.etiqueta, Size: Math.round(p.tamano_gb * GB), FreeSpace: Math.round((p.tamano_gb - p.usado_gb) * GB), FileSystem: p.sistema }))
  if (c === 'win32_service') return ((s.data.services ?? []) as PsObject[]).map((x) => T('Win32_Service', { ProcessId: x.Status === 'Running' ? 1000 + toText(x.Name).length * 17 : 0, Name: x.Name, StartMode: x.StartType === 'Automatic' ? 'Auto' : x.StartType, State: x.Status, Status: 'OK', ExitCode: 0, DisplayName: x.DisplayName, StartName: 'LocalSystem' }))
  if (c === 'win32_quickfixengineering') return ((s.data.hotfixes ?? []) as PsObject[]).map((h) => T('Win32_QuickFixEngineering', { Source: '', Description: h.Description, HotFixID: h.HotFixID, InstalledBy: h.InstalledBy, InstalledOn: h.InstalledOn }))
  if (c === 'win32_processor') return [T('Win32_Processor', { DeviceID: 'CPU0', Name: 'Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz', Caption: 'Intel64 Family 6 Model 106 Stepping 6', MaxClockSpeed: 2000, SocketDesignation: 'None', Manufacturer: 'GenuineIntel', NumberOfCores: 4, NumberOfLogicalProcessors: 4 })]
  if (c === 'win32_bios') return [T('Win32_BIOS', { SMBIOSBIOSVersion: 'Hyper-V UEFI Release v4.1', Manufacturer: 'Microsoft Corporation', Name: 'Hyper-V UEFI Release v4.1', SerialNumber: `${stableGuid(`bios:${st.equipo}`).slice(0, 4)}-${stableGuid(`bios:${st.equipo}`).slice(9, 13)}`.toUpperCase(), Version: 'VRTUAL - 1' })]
  return undefined
}

const CIM_COLUMNS: Record<string, string[]> = {
  win32_operatingsystem: ['SystemDirectory', 'Organization', 'BuildNumber', 'RegisteredUser', 'SerialNumber', 'Version'],
  win32_computersystem: ['Name', 'PrimaryOwnerName', 'Domain', 'TotalPhysicalMemory', 'Model', 'Manufacturer'],
  win32_logicaldisk: ['DeviceID', 'DriveType', 'ProviderName', 'VolumeName', 'Size', 'FreeSpace'],
  win32_service: ['ProcessId', 'Name', 'StartMode', 'State', 'Status', 'ExitCode'],
  win32_quickfixengineering: ['Source', 'Description', 'HotFixID', 'InstalledBy', 'InstalledOn'],
  win32_processor: ['DeviceID', 'Name', 'Caption', 'MaxClockSpeed', 'SocketDesignation', 'Manufacturer'],
  win32_bios: ['SMBIOSBIOSVersion', 'Manufacturer', 'Name', 'SerialNumber', 'Version'],
}
for (const [cls, cols] of Object.entries(CIM_COLUMNS)) {
  const name = cls.replace('win32_', 'Win32_').replace(/_(\w)/, (_m, c: string) => `_${c.toUpperCase()}`)
  const proper = Object.keys({ Win32_OperatingSystem: 1, Win32_ComputerSystem: 1, Win32_LogicalDisk: 1, Win32_Service: 1, Win32_QuickFixEngineering: 1, Win32_Processor: 1, Win32_BIOS: 1 }).find((k) => k.toLowerCase() === cls) ?? name
  VIEWS[`Microsoft.Management.Infrastructure.CimInstance#root/cimv2/${proper}`] = { kind: 'table', columns: cols.map((c) => ({ label: c, value: (o: PsObject) => o[c] })) }
}

/** Filtro WQL simple: "DriveType=3", "Name='Spooler'", "State='Running' AND StartMode='Auto'". */
function wqlFilter(items: PsObject[], filter?: string): PsObject[] {
  if (!filter) return items
  const conds = filter.split(/\s+AND\s+/i).map((c) => /^\s*(\w+)\s*(=|<>|!=|LIKE)\s*'?([^']*)'?\s*$/i.exec(c))
  return items.filter((o) =>
    conds.every((m) => {
      if (!m) return true
      const v = toText(o[Object.keys(o).find((k) => k.toLowerCase() === m[1].toLowerCase()) ?? m[1]])
      if (m[2].toUpperCase() === 'LIKE') return new RegExp('^' + m[3].replace(/%/g, '.*') + '$', 'i').test(v)
      return m[2] === '=' ? v.toLowerCase() === m[3].toLowerCase() : v.toLowerCase() !== m[3].toLowerCase()
    }),
  )
}

function cimQuery(ctx: CmdletContext, cmd: string, wmi: boolean): unknown[] {
  const cls = str(ctx, 'ClassName') ?? str(ctx, 'Class') ?? toText(ctx.positional[0] ?? '')
  const computers = list(ctx, 'ComputerName').map(toText)
  const run = (s: PsSession, tag?: string) => {
    const items = cimData(s, cls)
    if (!items) throw new PsError(wmi ? 'Invalid class "' + cls + '"' : `Invalid class`, 'MetadataError', `HRESULT 0x80041010,Microsoft.Management.Infrastructure.CimCmdlets.${cmd.replace('-', '')}Command`, cls)
    let out = wqlFilter(items, str(ctx, 'Filter'))
    const props = list(ctx, 'Property').map(toText)
    if (props.length) out = out.map((o) => psObject(o.__type, Object.fromEntries(Object.entries(o).filter(([k]) => k.startsWith('__') || props.some((p) => p.toLowerCase() === k.toLowerCase())))))
    return tag ? out.map((o) => ({ ...o, PSComputerName: tag })) : out
  }
  if (!computers.length) return run(ctx.s)
  const out: unknown[] = []
  for (const c of computers) {
    const r = connect(ctx.s, c)
    if (r instanceof PsError) {
      ctx.writeError(`WinRM cannot complete the operation. Verify that the specified computer name is valid, that the computer is accessible over the network, and that a firewall exception for the WinRM service is enabled and allows access from this computer.`, 'ConnectionError', c, `HRESULT 0x80338126,Microsoft.Management.Infrastructure.CimCmdlets.${cmd.replace('-', '')}Command`)
      continue
    }
    out.push(...run(r, r.state.equipo))
  }
  return out
}

cmdlet('Get-CimInstance', {
  params: ['ClassName', 'Filter', 'ComputerName', 'Property', 'Namespace', 'CimSession', 'Query'],
  positional: ['ClassName'],
  synopsis: 'Gets the CIM instances of a class from a CIM server.',
  module: 'CimCmdlets',
  run: (ctx) => cimQuery(ctx, 'Get-CimInstance', false),
}, ['gcim'])

cmdlet('Get-WmiObject', {
  params: ['Class', 'Filter', 'ComputerName', 'Property', 'Namespace'],
  positional: ['Class'],
  synopsis: 'Gets instances of WMI classes or information about the available classes (Windows PowerShell 5.1).',
  run(ctx) {
    if (ctx.s.data.pwsh?.[0]) throw new PsError(`The term 'Get-WmiObject' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling of the name, or if a path was included, verify that the path is correct and try again.`, 'ObjectNotFound', 'CommandNotFoundException', 'Get-WmiObject')
    return cimQuery(ctx, 'Get-WmiObject', true)
  },
}, ['gwmi'])

cmdlet('Get-HotFix', {
  params: ['Id', 'ComputerName', 'Description'],
  positional: ['Id'],
  synopsis: 'Gets the hotfixes that are installed on local or remote computers.',
  run(ctx) {
    const targets = list(ctx, 'ComputerName').map(toText)
    const sessions: PsSession[] = []
    if (!targets.length) sessions.push(ctx.s)
    for (const t of targets) {
      const r = connect(ctx.s, t)
      if (r instanceof PsError) {
        ctx.writeError('The RPC server is unavailable. (Exception from HRESULT: 0x800706BA)', 'InvalidOperation', t, 'System.Runtime.InteropServices.COMException,Microsoft.PowerShell.Commands.GetHotFixCommand')
        continue
      }
      sessions.push(r)
    }
    const ids = list(ctx, 'Id').map(toText)
    const out = sessions.flatMap((s) => ((s.data.hotfixes ?? []) as PsObject[]).map((h) => ({ ...h, Source: s.state.equipo }) as PsObject))
    const filtered = ids.length ? out.filter((h) => ids.some((i) => psEquals(h.HotFixID, i))) : out
    if (ids.length && !filtered.length) ctx.writeError(`Cannot find the requested hotfix on the '${ctx.s.state.equipo}' computer. Verify the input and run the command again.`, 'ObjectNotFound', ids[0])
    return filtered
  },
})
VIEWS['System.Management.ManagementObject#root\\cimv2\\Win32_QuickFixEngineering'] = {
  kind: 'table',
  columns: [
    { label: 'Source', value: (o) => o.Source },
    { label: 'Description', value: (o) => o.Description },
    { label: 'HotFixID', value: (o) => o.HotFixID },
    { label: 'InstalledBy', value: (o) => o.InstalledBy },
    { label: 'InstalledOn', value: (o) => (o.InstalledOn instanceof Date ? `${o.InstalledOn.getMonth() + 1}/${o.InstalledOn.getDate()}/${o.InstalledOn.getFullYear()} 12:00:00 AM` : o.InstalledOn) },
  ],
}

// ---------------------------------------------------------------------------------------
// Módulos y PowerShell 7
// ---------------------------------------------------------------------------------------

const MODULE_INFO: Record<string, [string, string]> = {
  ActiveDirectory: ['1.0.1.0', 'C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules'],
  ADDSDeployment: ['1.0.0.0', 'C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules'],
  GroupPolicy: ['1.0.0.0', 'C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules'],
  DnsServer: ['2.0.0.0', 'C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules'],
  DhcpServer: ['2.0.0.0', 'C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules'],
  PSWindowsUpdate: ['2.2.1.5', 'C:\\Program Files\\WindowsPowerShell\\Modules'],
  ImportExcel: ['7.8.10', 'C:\\Program Files\\WindowsPowerShell\\Modules'],
  Pester: ['3.4.0', 'C:\\Program Files\\WindowsPowerShell\\Modules'],
  PSScriptAnalyzer: ['1.24.0', 'C:\\Program Files\\WindowsPowerShell\\Modules'],
}

/** Lo que hay en la galería de PowerShell (PSGallery) en el simulador. */
const GALLERY: Record<string, [string, string]> = {
  PSWindowsUpdate: ['2.2.1.5', 'This module contain cmdlets to manage Windows Update Client.'],
  ImportExcel: ['7.8.10', 'PowerShell module to import/export Excel spreadsheets, without Excel.'],
  Pester: ['5.7.1', 'Pester provides a framework for running BDD style Tests to execute and validate PowerShell commands inside of PowerShell.'],
  PSScriptAnalyzer: ['1.24.0', 'PSScriptAnalyzer provides script analysis and checks for potential code defects in the scripts by applying a group of built-in or customized rules on the scripts being analyzed.'],
  dbatools: ['2.7.6', 'The community module that enables SQL Server Pros to automate database development and server administration'],
}

function modules(s: PsSession): string[] {
  return (s.data.modules ??= []) as string[]
}

function moduleObject(name: string): PsObject {
  const [version, dir] = MODULE_INFO[name] ?? ['1.0.0.0', 'C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules']
  return psObject('System.Management.Automation.PSModuleInfo', { ModuleType: MODULE_INFO[name] ? 'Manifest' : 'Manifest', Version: version, Name: name, ExportedCommands: '{...}', __dir: dir })
}
VIEWS['System.Management.Automation.PSModuleInfo'] = {
  kind: 'table',
  groupBy: (o) => `\n    Directory: ${toText(o.__dir)}\n\n`,
  columns: [
    { label: 'ModuleType', value: (o) => o.ModuleType },
    { label: 'Version', value: (o) => o.Version },
    { label: 'Name', value: (o) => o.Name },
    { label: 'ExportedCommands', value: (o) => o.ExportedCommands },
  ],
}

cmdlet('Get-Module', {
  params: ['Name'],
  switches: ['ListAvailable', 'All'],
  positional: ['Name'],
  synopsis: 'List the modules imported in the current session or that can be imported from the PSModulePath.',
  module: 'Microsoft.PowerShell.Core',
  run(ctx) {
    const names = list(ctx, 'Name').map(toText)
    const loaded = ((ctx.s.data.loadedModules ??= ['Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility', 'PSReadLine']) as string[])
    const src = has(ctx, 'ListAvailable') ? modules(ctx.s) : loaded
    return src.filter((m) => !names.length || names.some((n) => wildcardToRegex(n).test(m))).sort().map(moduleObject)
  },
}, ['gmo'])

cmdlet('Import-Module', {
  params: ['Name', 'MinimumVersion', 'RequiredVersion'],
  switches: ['Force', 'PassThru', 'Global'],
  positional: ['Name'],
  synopsis: 'Adds modules to the current session.',
  module: 'Microsoft.PowerShell.Core',
  run(ctx) {
    const out: PsObject[] = []
    for (const n of list(ctx, 'Name').map(toText)) {
      const found = modules(ctx.s).find((m) => m.toLowerCase() === n.toLowerCase())
      if (!found) {
        ctx.writeError(`The specified module '${n}' was not loaded because no valid module file was found in any module directory.`, 'ResourceUnavailable', n, 'Modules_ModuleNotFound,Microsoft.PowerShell.Commands.ImportModuleCommand')
        continue
      }
      const loaded = ((ctx.s.data.loadedModules ??= ['Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility', 'PSReadLine']) as string[])
      if (!loaded.includes(found)) loaded.push(found)
      if (has(ctx, 'PassThru')) out.push(moduleObject(found))
    }
    return out
  },
}, ['ipmo'])

cmdlet('Find-Module', {
  params: ['Name', 'Repository'],
  positional: ['Name'],
  synopsis: 'Finds modules in a repository that match specified criteria.',
  module: 'PowerShellGet',
  run(ctx) {
    const names = list(ctx, 'Name').map(toText)
    if (!ctx.s.state.red.puerta_enlace) throw new PsError('Unable to resolve package source \'https://www.powershellgallery.com/api/v2\'.', 'ObjectNotFound', 'SourceNotFound,Microsoft.PowerShell.PackageManagement.Cmdlets.FindPackage')
    const out = Object.entries(GALLERY)
      .filter(([n]) => !names.length || names.some((x) => wildcardToRegex(x).test(n)))
      .map(([n, [v, d]]) => psObject('Microsoft.PowerShell.Commands.PSRepositoryItemInfo', { Version: v, Name: n, Repository: 'PSGallery', Description: d }))
    if (!out.length) ctx.writeError(`No match was found for the specified search criteria and module name '${names[0]}'. Try Get-PSRepository to see all available registered module repositories.`, 'ObjectNotFound', names[0], 'NoMatchFoundForCriteria,Microsoft.PowerShell.PackageManagement.Cmdlets.FindPackage')
    return out
  },
})
VIEWS['Microsoft.PowerShell.Commands.PSRepositoryItemInfo'] = {
  kind: 'table',
  columns: [
    { label: 'Version', value: (o) => o.Version },
    { label: 'Name', value: (o) => o.Name },
    { label: 'Repository', value: (o) => o.Repository },
    { label: 'Description', value: (o) => o.Description },
  ],
}

cmdlet('Install-Module', {
  params: ['Name', 'Scope', 'RequiredVersion', 'Repository'],
  switches: ['Force', 'AllowClobber', 'SkipPublisherCheck'],
  positional: ['Name'],
  synopsis: 'Downloads one or more modules from a repository, and installs them on the local computer.',
  module: 'PowerShellGet',
  run(ctx) {
    if (!ctx.s.state.red.puerta_enlace) throw new PsError("Unable to resolve package source 'https://www.powershellgallery.com/api/v2'.", 'ObjectNotFound', 'SourceNotFound,Microsoft.PowerShell.PackageManagement.Cmdlets.InstallPackage')
    for (const n of list(ctx, 'Name').map(toText)) {
      const found = Object.keys(GALLERY).find((g) => g.toLowerCase() === n.toLowerCase())
      if (!found) {
        ctx.writeError(`No match was found for the specified search criteria and module name '${n}'. Try Get-PSRepository to see all available registered module repositories.`, 'ObjectNotFound', n, 'NoMatchFoundForCriteria,Microsoft.PowerShell.PackageManagement.Cmdlets.InstallPackage')
        continue
      }
      if (!ctx.s.data.nuget?.[0]) {
        ctx.host('NuGet provider is required to continue\nPowerShellGet requires NuGet provider version \'2.8.5.201\' or newer to interact with NuGet-based repositories. The NuGet provider must be available in \'C:\\Program Files\\PackageManagement\\ProviderAssemblies\'. Do you want PowerShellGet to install and import the NuGet provider now?\n[Y] Yes  [N] No  [S] Suspend  [?] Help (default is "Y"): Y\n')
        ctx.s.data.nuget = [true]
      }
      if (!has(ctx, 'Force')) ctx.host("\nUntrusted repository\nYou are installing the modules from an untrusted repository. If you trust this repository, change its InstallationPolicy value by running the Set-PSRepository cmdlet. Are you sure you want to install the modules from 'PSGallery'?\n[Y] Yes  [A] Yes to All  [N] No  [L] No to All  [S] Suspend  [?] Help (default is \"N\"): Y\n")
      if (!modules(ctx.s).includes(found)) modules(ctx.s).push(found)
      MODULE_INFO[found] ??= [GALLERY[found][0], has(ctx, 'Scope') && psEquals(param(ctx, 'Scope'), 'CurrentUser') ? `C:\\Users\\${ctx.s.state.usuario}\\Documents\\WindowsPowerShell\\Modules` : 'C:\\Program Files\\WindowsPowerShell\\Modules']
    }
    return []
  },
})

cmdlet('pwsh', {
  params: ['Command', 'File', 'NoProfile'],
  synopsis: 'PowerShell 7 (pwsh.exe).',
  run(ctx) {
    if (!ctx.s.state.powershell7) throw new PsError("The term 'pwsh' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling of the name, or if a path was included, verify that the path is correct and try again.", 'ObjectNotFound', 'CommandNotFoundException', 'pwsh')
    ctx.host('[simulador] PowerShell 7.6 está instalado en este equipo (pwsh). La terminal sigue en Windows PowerShell 5.1; para ver la diferencia, compará $PSVersionTable en cada uno.\n')
    return [psObject('System.Management.Automation.PSCustomObject', { PSVersion: '7.6.0', PSEdition: 'Core', OS: 'Microsoft Windows 10.0.26100' })]
  },
})
