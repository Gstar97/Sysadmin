/**
 * Módulo DnsServer: zonas (integradas en AD, de archivo, inversas y reenviadores condicionales),
 * registros, reenviadores, antigüedad y limpieza de registros viejos (scavenging).
 * Las zonas integradas en AD se guardan en la base del dominio, así que se ven en todos los DC.
 */
import { connect } from './remoting'
import { adZones, fqdnOf, isDc, localZones, newZone, serverZones, type DnsZone, type DnsZoneRecord } from './dns'
import { asArray, cmdlet, PsError, PsSession, psEquals, type CmdletContext } from './session'
import { formatDate, psObject, toText, VIEWS, type PsObject } from './values'

const param = (ctx: CmdletContext, n: string) => ctx.params.get(n.toLowerCase())
const has = (ctx: CmdletContext, n: string) => ctx.params.has(n.toLowerCase())
const str = (ctx: CmdletContext, n: string) => (has(ctx, n) && param(ctx, n) !== null ? toText(param(ctx, n)) : undefined)
const bool = (ctx: CmdletContext, n: string) => {
  const v = param(ctx, n)
  return v === true || /^(true|1|\$true)$/i.test(toText(v))
}
const MOD = 'DnsServer'

function serviceRunning(s: PsSession, name: string) {
  return ((s.data.services ?? []) as PsObject[]).some((x) => toText(x.Name).toLowerCase() === name.toLowerCase() && x.Status === 'Running')
}

/** El servidor DNS sobre el que trabaja el cmdlet (-ComputerName o el propio equipo). */
export function dnsTarget(ctx: CmdletContext, cmd: string): PsSession {
  const name = str(ctx, 'ComputerName')
  let t = ctx.s
  if (name && !psEquals(name, ctx.s.state.equipo) && name !== 'localhost' && name !== '.') {
    const r = connect(ctx.s, name)
    if (r instanceof PsError) throw new PsError(`Failed to connect to the DNS server ${name}.`, 'ConnectionError', `WIN32 1722,${cmd}`, name)
    t = r
  }
  const hasRole = ((t.data.features ?? []) as PsObject[]).some((f) => toText(f.Name).toLowerCase() === 'dns' && f.Installed)
  if (!hasRole || !serviceRunning(t, 'DNS')) throw new PsError(`Failed to enumerate zones from the server ${t.state.equipo}.`, 'ObjectNotFound', `WIN32 1722,${cmd}`, t.state.equipo)
  return t
}

function findZone(t: PsSession, name: string, cmd: string): DnsZone {
  const z = serverZones(t).find((x) => x.name === name.toLowerCase().replace(/\.$/, ''))
  if (!z) throw new PsError(`Failed to get the zone information for ${name} on server ${t.state.equipo}.`, 'ObjectNotFound', `WIN32 9601,${cmd}`, name)
  return z
}

/** Zonas creadas solas por el servidor (las inversas de 0, 127 y 255). */
function autoZones(t: PsSession): DnsZone[] {
  const out = ['0.in-addr.arpa', '127.in-addr.arpa', '255.in-addr.arpa'].map((n) => newZone(n, { autoCreated: true }))
  if (isDc(t.state, t.lab)) out.push(newZone('trustanchors', { adIntegrated: true, scope: 'Forest' }))
  return out
}

function zoneObject(z: DnsZone): PsObject {
  return psObject('CimInstance#DnsServerZone', {
    ZoneName: z.name === 'trustanchors' ? 'TrustAnchors' : z.name,
    ZoneType: z.kind,
    IsAutoCreated: !!z.autoCreated,
    IsDsIntegrated: z.adIntegrated,
    IsReverseLookupZone: z.reverse,
    IsSigned: false,
    ReplicationScope: z.adIntegrated ? z.scope ?? 'Domain' : 'None',
    DynamicUpdate: z.dynamicUpdate,
    MasterServers: z.masters.join(', '),
    __toString: z.name,
  })
}

VIEWS['CimInstance#DnsServerZone'] = {
  kind: 'table',
  columns: [
    { label: 'ZoneName', value: (o) => o.ZoneName },
    { label: 'ZoneType', value: (o) => o.ZoneType },
    { label: 'IsAutoCreated', value: (o) => o.IsAutoCreated },
    { label: 'IsDsIntegrated', value: (o) => o.IsDsIntegrated },
    { label: 'IsReverseLookupZone', value: (o) => o.IsReverseLookupZone },
    { label: 'IsSigned', value: (o) => o.IsSigned },
  ],
}

function ttlText(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const sec = seconds % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${h >= 24 ? `${Math.floor(h / 24)}.` : ''}${pad(h % 24)}:${pad(m)}:${pad(sec)}`
}

const TYPE_CODE: Record<string, number> = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33 }

function recordObject(z: DnsZone, r: DnsZoneRecord): PsObject {
  const t = r.type.toUpperCase()
  const data = t === 'MX' ? `[${r.preference ?? 10}][${r.data}]` : r.data
  return psObject('CimInstance#DnsServerResourceRecord', {
    HostName: r.name,
    RecordType: t,
    Type: TYPE_CODE[t] ?? 0,
    Timestamp: r.timestamp ?? 0,
    TimeToLive: ttlText(r.ttl),
    RecordData: data,
    __zone: z.name,
    __toString: r.name,
  })
}

VIEWS['CimInstance#DnsServerResourceRecord'] = {
  kind: 'table',
  columns: [
    { label: 'HostName', value: (o) => o.HostName },
    { label: 'RecordType', value: (o) => o.RecordType },
    { label: 'Type', value: (o) => o.Type },
    { label: 'Timestamp', value: (o) => (o.Timestamp instanceof Date ? formatDate(o.Timestamp as Date, false).replace(/:\d\d:\d\d (AM|PM)$/, ':00:00 $1') : '0') },
    { label: 'TimeToLive', value: (o) => o.TimeToLive },
    { label: 'RecordData', value: (o) => o.RecordData },
  ],
}

/** Registros que el servidor muestra en una zona: los cargados más los que se registran solos (DC y equipos del dominio). */
function zoneRecordList(t: PsSession, z: DnsZone): DnsZoneRecord[] {
  const out = [...z.records]
  const d = t.state.dominio?.toLowerCase()
  if (z.adIntegrated && d && z.name === d) {
    const now = new Date()
    const auto: DnsZoneRecord[] = [
      { name: '@', type: 'SOA', data: `[1][dc01.${d}.][hostmaster.${d}.]`, ttl: 3600 },
    ]
    for (const st of (t.lab ? [...new Set([t.state, ...[...t.lab.sessions.values()].map((x) => x.state), ...t.lab.states.values()])] : [t.state])) {
      if (st.dominio?.toLowerCase() !== d) continue
      if (isDc(st, t.lab)) {
        auto.push({ name: '@', type: 'NS', data: `${st.equipo.toLowerCase()}.${d}.`, ttl: 3600 })
        auto.push({ name: '@', type: 'A', data: st.red.ip, ttl: 600, timestamp: now })
      }
      auto.push({ name: st.equipo.toLowerCase(), type: 'A', data: st.red.ip, ttl: 1200, timestamp: now })
    }
    const soa = auto.shift()!
    soa.data = soa.data.replace('dc01', (auto.find((r) => r.type === 'NS')?.data ?? `dc01.${d}.`).split('.')[0])
    for (const a of auto) if (!out.some((r) => r.name === a.name && r.type === a.type && r.data === a.data)) out.push(a)
    out.unshift(soa)
  }
  return out
}

cmdlet('Get-DnsServerZone', {
  params: ['Name', 'ComputerName'],
  positional: ['Name'],
  synopsis: 'Gets details of DNS zones on a DNS server.',
  module: MOD,
  run(ctx) {
    const t = dnsTarget(ctx, 'Get-DnsServerZone')
    const all = [...serverZones(t), ...autoZones(t)].sort((a, b) => a.name.localeCompare(b.name))
    const name = str(ctx, 'Name')
    if (name) return [zoneObject(findZone(t, name, 'Get-DnsServerZone'))]
    return all.map(zoneObject)
  },
})

function scopeOf(ctx: CmdletContext): DnsZone['scope'] | undefined {
  const v = str(ctx, 'ReplicationScope')
  if (!v) return undefined
  const ok = ['Domain', 'Forest', 'Legacy'].find((x) => psEquals(x, v))
  if (!ok) throw new PsError(`Cannot validate argument on parameter 'ReplicationScope'. The argument "${v}" does not belong to the set "Forest,Domain,Legacy,Custom".`, 'InvalidData', 'ParameterArgumentValidationError')
  return ok as DnsZone['scope']
}

/** 192.168.10.0/24 → 10.168.192.in-addr.arpa */
function reverseZoneName(networkId: string): string {
  const [net, bits] = networkId.split('/')
  const octets = net.split('.')
  const keep = Math.max(1, Math.min(3, Math.floor(Number(bits ?? 24) / 8)))
  return `${octets.slice(0, keep).reverse().join('.')}.in-addr.arpa`
}

function addZone(t: PsSession, z: DnsZone, cmd: string) {
  if (serverZones(t).some((x) => x.name === z.name)) throw new PsError(`Failed to create zone ${z.name} on server ${t.state.equipo}.`, 'ResourceExists', `WIN32 9609,${cmd}`, z.name)
  if (z.adIntegrated) {
    const ad = adZones(t)
    if (!ad) throw new PsError(`Failed to create zone ${z.name} on server ${t.state.equipo}. The zone can be integrated with Active Directory only on a domain controller.`, 'InvalidOperation', `WIN32 9611,${cmd}`, z.name)
    ad.push(z)
  } else localZones(t).push(z)
  return []
}

cmdlet('Add-DnsServerPrimaryZone', {
  params: ['Name', 'NetworkId', 'ReplicationScope', 'ZoneFile', 'DynamicUpdate', 'ComputerName'],
  switches: ['PassThru'],
  positional: ['Name'],
  synopsis: 'Adds a primary zone to a DNS server.',
  module: MOD,
  whatIf: (ctx) => `Performing the operation "Add-DnsServerPrimaryZone" on target "${str(ctx, 'Name') ?? str(ctx, 'NetworkId')}".`,
  run(ctx) {
    const t = dnsTarget(ctx, 'Add-DnsServerPrimaryZone')
    const netId = str(ctx, 'NetworkId')
    const name = str(ctx, 'Name') ?? (netId ? reverseZoneName(netId) : undefined)
    if (!name) throw new PsError('Cannot process command because of one or more missing mandatory parameters: Name.', 'InvalidArgument', 'MissingMandatoryParameter')
    const scope = scopeOf(ctx)
    if (!scope && !has(ctx, 'ZoneFile')) throw new PsError('Parameter set cannot be resolved using the specified named parameters. Use -ReplicationScope (zona integrada en AD) o -ZoneFile (zona en un archivo).', 'InvalidArgument', 'AmbiguousParameterSet,Add-DnsServerPrimaryZone')
    const dyn = (str(ctx, 'DynamicUpdate') ?? (scope ? 'Secure' : 'None')) as DnsZone['dynamicUpdate']
    if (dyn === 'Secure' && !scope) throw new PsError(`Failed to create zone ${name}: secure dynamic updates are only available for Active Directory-integrated zones.`, 'InvalidArgument', 'WIN32 9611,Add-DnsServerPrimaryZone', name)
    const z = newZone(name, { adIntegrated: !!scope, scope, dynamicUpdate: dyn })
    addZone(t, z, 'Add-DnsServerPrimaryZone')
    return has(ctx, 'PassThru') ? [zoneObject(z)] : []
  },
})

cmdlet('Add-DnsServerConditionalForwarderZone', {
  params: ['Name', 'MasterServers', 'ReplicationScope', 'ComputerName'],
  switches: ['PassThru'],
  positional: ['Name', 'MasterServers'],
  synopsis: 'Adds a conditional forwarder to a DNS server.',
  module: MOD,
  run(ctx) {
    const t = dnsTarget(ctx, 'Add-DnsServerConditionalForwarderZone')
    const scope = scopeOf(ctx)
    const z = newZone(str(ctx, 'Name')!, { kind: 'Forwarder', adIntegrated: !!scope, scope, masters: asArray(param(ctx, 'MasterServers')).map(toText) })
    addZone(t, z, 'Add-DnsServerConditionalForwarderZone')
    return has(ctx, 'PassThru') ? [zoneObject(z)] : []
  },
})

cmdlet('Remove-DnsServerZone', {
  params: ['Name', 'ComputerName'],
  switches: ['Force'],
  positional: ['Name'],
  synopsis: 'Removes a zone from a DNS server.',
  module: MOD,
  run(ctx) {
    const t = dnsTarget(ctx, 'Remove-DnsServerZone')
    const z = findZone(t, str(ctx, 'Name')!, 'Remove-DnsServerZone')
    if (t.state.dominio && (z.name === t.state.dominio.toLowerCase() || z.name === `_msdcs.${t.state.dominio.toLowerCase()}`)) ctx.host('[simulador] Borrar la zona del dominio deja a todos los equipos sin poder encontrar los controladores. En el simulador no se permite.\n')
    else {
      const ad = adZones(t)
      if (ad?.includes(z)) ad.splice(ad.indexOf(z), 1)
      const loc = localZones(t)
      if (loc.includes(z)) loc.splice(loc.indexOf(z), 1)
    }
    return []
  },
})

// ---------------------------------------------------------------------------------------
// Registros
// ---------------------------------------------------------------------------------------

function relName(z: DnsZone, name: string): string {
  const n = name.toLowerCase().replace(/\.$/, '')
  if (n === '@' || n === z.name) return '@'
  return n.endsWith(`.${z.name}`) ? n.slice(0, -(z.name.length + 1)) : n
}

function addRecord(ctx: CmdletContext, cmd: string, type: string, data: string, extra: Partial<DnsZoneRecord> = {}) {
  const t = dnsTarget(ctx, cmd)
  const z = findZone(t, str(ctx, 'ZoneName')!, cmd)
  if (z.kind === 'Forwarder') throw new PsError(`Failed to create resource record in zone ${z.name}: it is a conditional forwarder.`, 'InvalidOperation', `WIN32 9611,${cmd}`, z.name)
  const name = relName(z, str(ctx, 'Name') ?? '@')
  const ttlArg = str(ctx, 'TimeToLive')
  const ttl = ttlArg ? parseTimeSpan(ttlArg) : 3600
  if (z.records.some((r) => r.name === name && r.type === type && r.data.toLowerCase() === data.toLowerCase())) throw new PsError(`Failed to create resource record ${name} in zone ${z.name} on server ${t.state.equipo}.`, 'ResourceExists', `WIN32 9711,${cmd}`, name)
  if (type === 'CNAME' && z.records.some((r) => r.name === name)) throw new PsError(`Failed to create resource record ${name} in zone ${z.name} on server ${t.state.equipo}. A CNAME record cannot coexist with other records with the same name.`, 'InvalidOperation', `WIN32 9709,${cmd}`, name)
  const rec: DnsZoneRecord = { name, type, data, ttl, ...extra }
  z.records.push(rec)
  // -CreatePtr: el registro inverso, si hay una zona inversa que contenga la dirección.
  if (type === 'A' && has(ctx, 'CreatePtr')) {
    const rev = data.split('.').reverse().join('.') + '.in-addr.arpa'
    const rz = serverZones(t).filter((x) => x.reverse && rev.endsWith(`.${x.name}`)).sort((a, b) => b.name.length - a.name.length)[0]
    if (!rz) ctx.writeError(`Failed to create PTR record. Resource record ${name} in zone ${z.name} on server ${t.state.equipo} is created successfully, but corresponding PTR record could not be created.`, 'ObjectNotFound', name, `WIN32 9715,${cmd}`)
    else rz.records.push({ name: relName(rz, rev), type: 'PTR', data: `${fqdnOf(z, name)}.`, ttl })
  }
  return has(ctx, 'PassThru') ? [recordObject(z, rec)] : []
}

function parseTimeSpan(v: string): number {
  const m = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})$/.exec(v.trim())
  if (m) return Number(m[1] ?? 0) * 86400 + Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4])
  return Number(v) || 3600
}

const REC_PARAMS = ['ZoneName', 'Name', 'TimeToLive', 'ComputerName']

cmdlet('Add-DnsServerResourceRecordA', {
  params: [...REC_PARAMS, 'IPv4Address'],
  switches: ['CreatePtr', 'PassThru', 'AllowUpdateAny'],
  positional: ['ZoneName', 'Name', 'IPv4Address'],
  synopsis: 'Adds a type A resource record to a DNS zone.',
  module: MOD,
  run: (ctx) => addRecord(ctx, 'Add-DnsServerResourceRecordA', 'A', str(ctx, 'IPv4Address')!),
})

cmdlet('Add-DnsServerResourceRecordCName', {
  params: [...REC_PARAMS, 'HostNameAlias'],
  switches: ['PassThru'],
  positional: ['ZoneName', 'Name', 'HostNameAlias'],
  synopsis: 'Adds a type CNAME resource record to a DNS zone.',
  module: MOD,
  run: (ctx) => addRecord(ctx, 'Add-DnsServerResourceRecordCName', 'CNAME', str(ctx, 'HostNameAlias')!.replace(/\.?$/, '.')),
})

cmdlet('Add-DnsServerResourceRecordPtr', {
  params: [...REC_PARAMS, 'PtrDomainName'],
  switches: ['PassThru'],
  positional: ['ZoneName', 'Name', 'PtrDomainName'],
  synopsis: 'Adds a type PTR resource record to a DNS server.',
  module: MOD,
  run: (ctx) => addRecord(ctx, 'Add-DnsServerResourceRecordPtr', 'PTR', str(ctx, 'PtrDomainName')!.replace(/\.?$/, '.')),
})

cmdlet('Add-DnsServerResourceRecordMX', {
  params: [...REC_PARAMS, 'MailExchange', 'Preference'],
  switches: ['PassThru'],
  positional: ['ZoneName', 'Name', 'MailExchange', 'Preference'],
  synopsis: 'Adds an MX resource record to a DNS server.',
  module: MOD,
  run: (ctx) => addRecord(ctx, 'Add-DnsServerResourceRecordMX', 'MX', str(ctx, 'MailExchange')!.replace(/\.?$/, '.'), { preference: Number(str(ctx, 'Preference') ?? 10) }),
})

cmdlet('Add-DnsServerResourceRecord', {
  params: [...REC_PARAMS, 'IPv4Address', 'HostNameAlias', 'PtrDomainName', 'MailExchange', 'Preference', 'DescriptiveText'],
  switches: ['A', 'CName', 'Ptr', 'MX', 'Txt', 'CreatePtr', 'PassThru'],
  positional: ['ZoneName'],
  synopsis: 'Adds a resource record of a specified type to a specified DNS zone.',
  module: MOD,
  run(ctx) {
    const cmd = 'Add-DnsServerResourceRecord'
    if (has(ctx, 'A')) return addRecord(ctx, cmd, 'A', str(ctx, 'IPv4Address')!)
    if (has(ctx, 'CName')) return addRecord(ctx, cmd, 'CNAME', str(ctx, 'HostNameAlias')!.replace(/\.?$/, '.'))
    if (has(ctx, 'Ptr')) return addRecord(ctx, cmd, 'PTR', str(ctx, 'PtrDomainName')!.replace(/\.?$/, '.'))
    if (has(ctx, 'MX')) return addRecord(ctx, cmd, 'MX', str(ctx, 'MailExchange')!.replace(/\.?$/, '.'), { preference: Number(str(ctx, 'Preference') ?? 10) })
    if (has(ctx, 'Txt')) return addRecord(ctx, cmd, 'TXT', str(ctx, 'DescriptiveText') ?? '')
    throw new PsError('Parameter set cannot be resolved using the specified named parameters. Indicá el tipo: -A, -CName, -Ptr, -MX o -Txt.', 'InvalidArgument', 'AmbiguousParameterSet,Add-DnsServerResourceRecord')
  },
})

cmdlet('Get-DnsServerResourceRecord', {
  params: ['ZoneName', 'Name', 'RRType', 'ComputerName'],
  positional: ['ZoneName', 'Name'],
  synopsis: 'Gets resource records from a specified DNS zone.',
  module: MOD,
  run(ctx) {
    const t = dnsTarget(ctx, 'Get-DnsServerResourceRecord')
    const z = findZone(t, str(ctx, 'ZoneName')!, 'Get-DnsServerResourceRecord')
    const name = str(ctx, 'Name')
    const type = str(ctx, 'RRType')?.toUpperCase()
    let recs = zoneRecordList(t, z)
    if (name) recs = recs.filter((r) => r.name === relName(z, name))
    if (type) recs = recs.filter((r) => r.type === type)
    if (name && !recs.length) throw new PsError(`Failed to get ${name} record in ${z.name} zone on ${t.state.equipo} server.`, 'ObjectNotFound', 'WIN32 9714,Get-DnsServerResourceRecord', name)
    return recs.map((r) => recordObject(z, r))
  },
})

cmdlet('Remove-DnsServerResourceRecord', {
  params: ['ZoneName', 'Name', 'RRType', 'RecordData', 'ComputerName'],
  switches: ['Force'],
  positional: ['ZoneName'],
  synopsis: 'Removes specified DNS server resource records from a zone.',
  module: MOD,
  run(ctx) {
    const t = dnsTarget(ctx, 'Remove-DnsServerResourceRecord')
    const input = ctx.input.find((x) => (x as PsObject)?.__type === 'CimInstance#DnsServerResourceRecord') as PsObject | undefined
    const z = findZone(t, str(ctx, 'ZoneName') ?? toText(input?.__zone), 'Remove-DnsServerResourceRecord')
    const name = relName(z, str(ctx, 'Name') ?? toText(input?.HostName))
    const type = (str(ctx, 'RRType') ?? toText(input?.RecordType)).toUpperCase()
    const data = str(ctx, 'RecordData')
    const victims = z.records.filter((r) => r.name === name && r.type === type && (!data || r.data.replace(/\.$/, '').toLowerCase() === data.replace(/\.$/, '').toLowerCase()))
    if (!victims.length) {
      const dynamic = zoneRecordList(t, z).some((r) => r.name === name && r.type === type)
      if (dynamic) ctx.host(`[simulador] ${name} es un registro que el propio equipo vuelve a registrar (dinámico). Si lo borrás, reaparece en la próxima actualización.\n`)
      else throw new PsError(`Failed to get ${name} record in ${z.name} zone on ${t.state.equipo} server.`, 'ObjectNotFound', 'WIN32 9714,Remove-DnsServerResourceRecord', name)
      return []
    }
    if (!has(ctx, 'Force')) ctx.host(`\nConfirm\nRemoving DNS resource record set by name ${name} of type ${type} from zone ${z.name} on ${t.state.equipo} server. Do you want to continue?\n[Y] Yes  [N] No  (default is "Y"): Y\n[simulador] Con -Force no pregunta.\n`)
    z.records = z.records.filter((r) => !victims.includes(r))
    return []
  },
})

// ---------------------------------------------------------------------------------------
// Reenviadores, antigüedad y limpieza
// ---------------------------------------------------------------------------------------

function forwarders(t: PsSession): string[] {
  return (t.data.dnsForwarders ??= []) as string[]
}

cmdlet('Get-DnsServerForwarder', {
  params: ['ComputerName'],
  synopsis: 'Gets forwarder configuration settings on a DNS server.',
  module: MOD,
  run(ctx) {
    const t = dnsTarget(ctx, 'Get-DnsServerForwarder')
    const f = forwarders(t)
    return [psObject('__formatted', { text: `\nUseRootHint        : True\nTimeout(s)         : 3\nEnableReordering   : True\nIPAddress          : ${f.length ? `{${f.join(', ')}}` : ''}\nReorderedIPAddress : ${f.length ? `{${f.join(', ')}}` : ''}\n\n` })]
  },
})

cmdlet(['Add-DnsServerForwarder', 'Set-DnsServerForwarder', 'Remove-DnsServerForwarder'], {
  params: ['IPAddress', 'ComputerName'],
  switches: ['Force', 'PassThru'],
  positional: ['IPAddress'],
  synopsis: 'Adds, replaces or removes server-level forwarders on a DNS server.',
  module: MOD,
  run(ctx) {
    const t = dnsTarget(ctx, ctx.name)
    const ips = asArray(param(ctx, 'IPAddress')).map(toText)
    const f = forwarders(t)
    const op = ctx.name.toLowerCase()
    if (op.startsWith('add')) for (const ip of ips) if (!f.includes(ip)) f.push(ip)
    if (op.startsWith('set')) t.data.dnsForwarders = [...ips]
    if (op.startsWith('remove')) t.data.dnsForwarders = f.filter((x) => !ips.includes(x))
    return []
  },
})

cmdlet('Set-DnsServerZoneAging', {
  params: ['Name', 'Aging', 'NoRefreshInterval', 'RefreshInterval', 'ComputerName'],
  switches: ['PassThru'],
  positional: ['Name'],
  synopsis: 'Configures DNS aging settings for a zone.',
  module: MOD,
  run(ctx) {
    const t = dnsTarget(ctx, 'Set-DnsServerZoneAging')
    const z = findZone(t, str(ctx, 'Name')!, 'Set-DnsServerZoneAging')
    if (has(ctx, 'Aging')) z.aging = bool(ctx, 'Aging')
    if (has(ctx, 'NoRefreshInterval')) z.noRefreshDays = parseTimeSpan(str(ctx, 'NoRefreshInterval')!) / 86400
    if (has(ctx, 'RefreshInterval')) z.refreshDays = parseTimeSpan(str(ctx, 'RefreshInterval')!) / 86400
    return []
  },
})

cmdlet('Get-DnsServerZoneAging', {
  params: ['Name', 'ComputerName'],
  positional: ['Name'],
  synopsis: 'Gets DNS aging settings for a zone.',
  module: MOD,
  run(ctx) {
    const t = dnsTarget(ctx, 'Get-DnsServerZoneAging')
    const z = findZone(t, str(ctx, 'Name')!, 'Get-DnsServerZoneAging')
    return [psObject('__formatted', { text: `\nZoneName             : ${z.name}\nAgingEnabled         : ${z.aging ? 'True' : 'False'}\nAvailForScavengeTime : \nRefreshInterval      : ${z.refreshDays}.00:00:00\nNoRefreshInterval    : ${z.noRefreshDays}.00:00:00\nScavengeServers      : \n\n` })]
  },
})

interface Scavenging {
  enabled: boolean
  intervalDays: number
  last?: Date
}

function scavenging(t: PsSession): Scavenging {
  return ((t.data.dnsScavenging ??= [{ enabled: false, intervalDays: 7 }]) as Scavenging[])[0]
}

cmdlet('Set-DnsServerScavenging', {
  params: ['ScavengingState', 'ScavengingInterval', 'RefreshInterval', 'NoRefreshInterval', 'ComputerName'],
  switches: ['ApplyOnAllZones', 'PassThru'],
  synopsis: 'Changes DNS server scavenging settings.',
  module: MOD,
  run(ctx) {
    const t = dnsTarget(ctx, 'Set-DnsServerScavenging')
    const sc = scavenging(t)
    if (has(ctx, 'ScavengingState')) sc.enabled = bool(ctx, 'ScavengingState')
    if (has(ctx, 'ScavengingInterval')) sc.intervalDays = parseTimeSpan(str(ctx, 'ScavengingInterval')!) / 86400
    if (has(ctx, 'ApplyOnAllZones')) {
      for (const z of serverZones(t)) {
        if (z.kind !== 'Primary') continue
        if (has(ctx, 'ScavengingState')) z.aging = sc.enabled
        if (has(ctx, 'RefreshInterval')) z.refreshDays = parseTimeSpan(str(ctx, 'RefreshInterval')!) / 86400
        if (has(ctx, 'NoRefreshInterval')) z.noRefreshDays = parseTimeSpan(str(ctx, 'NoRefreshInterval')!) / 86400
      }
    }
    return []
  },
})

cmdlet('Get-DnsServerScavenging', {
  params: ['ComputerName'],
  synopsis: 'Gets DNS aging and scavenging settings.',
  module: MOD,
  run(ctx) {
    const t = dnsTarget(ctx, 'Get-DnsServerScavenging')
    const sc = scavenging(t)
    return [psObject('__formatted', { text: `\nNoRefreshInterval  : 7.00:00:00\nRefreshInterval    : 7.00:00:00\nScavengingInterval : ${sc.enabled ? `${sc.intervalDays}.00:00:00` : '00:00:00'}\nScavengingState    : ${sc.enabled ? 'True' : 'False'}\nLastScavengeTime   : ${sc.last ? formatDate(sc.last, false) : ''}\n\n` })]
  },
})

cmdlet('Start-DnsServerScavenging', {
  params: ['ComputerName'],
  switches: ['Force'],
  synopsis: 'Notifies a DNS server to attempt a search for stale resource records.',
  module: MOD,
  run(ctx) {
    const t = dnsTarget(ctx, 'Start-DnsServerScavenging')
    const sc = scavenging(t)
    if (!sc.enabled) {
      ctx.host('[simulador] La limpieza está deshabilitada en el servidor (Set-DnsServerScavenging -ScavengingState $true). No se borró nada.\n')
      return []
    }
    const now = Date.now()
    const removed: string[] = []
    for (const z of serverZones(t)) {
      if (!z.aging) continue
      const limit = (z.noRefreshDays + z.refreshDays) * 86_400_000
      z.records = z.records.filter((r) => {
        const stale = !!r.timestamp && now - r.timestamp.getTime() > limit
        if (stale) removed.push(`${fqdnOf(z, r.name)} (${r.type})`)
        return !stale
      })
    }
    sc.last = new Date()
    if (!has(ctx, 'Force')) ctx.host('[simulador] Sin -Force pide confirmación; se tomó como Sí.\n')
    ctx.host(removed.length ? `[simulador] Se borraron ${removed.length} registros viejos: ${removed.join(', ')}.\n` : '[simulador] No había registros con antigüedad suficiente para borrar.\n')
    return []
  },
})

cmdlet('Clear-DnsServerCache', {
  params: ['ComputerName'],
  switches: ['Force'],
  synopsis: 'Clears resource records from a cache on the DNS server.',
  module: MOD,
  run(ctx) {
    dnsTarget(ctx, 'Clear-DnsServerCache')
    if (!has(ctx, 'Force')) ctx.host('[simulador] Sin -Force pide confirmación; se tomó como Sí.\n')
    return []
  },
})

/** Carga la configuración de DNS del estado inicial del ejercicio. */
export function initialDnsServer(s: PsSession) {
  const cfg = s.state.dns_servidor
  if (!cfg) return
  const now = Date.now()
  for (const z of cfg.zonas) {
    const name = z.nombre.toLowerCase()
    const ad = z.integrada_ad ? adZones(s) : undefined
    const existing = serverZones(s).find((x) => x.name === name)
    const zone =
      existing ??
      newZone(name, {
        kind: z.tipo === 'reenviador_condicional' ? 'Forwarder' : 'Primary',
        adIntegrated: !!ad,
        scope: ad ? 'Domain' : undefined,
        dynamicUpdate: z.actualizacion === 'segura' && ad ? 'Secure' : z.actualizacion === 'no_segura' ? 'NonsecureAndSecure' : ad ? 'Secure' : 'None',
        aging: z.antiguedad,
        masters: z.maestros,
      })
    if (!existing) (ad ?? localZones(s)).push(zone)
    if (existing && z.antiguedad) existing.aging = true
    for (const r of z.registros) {
      const rec: DnsZoneRecord = { name: relName(zone, r.nombre), type: r.tipo, data: ['CNAME', 'PTR', 'MX'].includes(r.tipo) ? r.valor.replace(/\.?$/, '.') : r.valor, ttl: 3600, ...(r.hace_dias !== undefined ? { timestamp: new Date(now - r.hace_dias * 86_400_000) } : {}) }
      if (!zone.records.some((x) => x.name === rec.name && x.type === rec.type && x.data === rec.data)) zone.records.push(rec)
    }
  }
  for (const f of cfg.reenviadores) if (!forwarders(s).includes(f)) forwarders(s).push(f)
  if (cfg.limpieza) scavenging(s).enabled = true
}
