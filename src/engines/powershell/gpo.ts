/**
 * Módulo GroupPolicy simulado y las herramientas del cliente (gpupdate, gpresult). Las GPO viven en la
 * base del dominio; cada equipo guarda lo último que aplicó (como Windows), así que un cambio en una GPO
 * no se ve en gpresult hasta que el equipo corre gpupdate o reinicia.
 */
import { computeRsop, processingOrder, readableContainer, type GpScope, type GpoSetting, type RsopResult } from '../gpo/rsop'
import { containerExists, dnOf, ouPathToDn, policyLabel, resolveAny, sameDn, stableGuid, type AdStore, type StoredGpo } from './ad'
import { computerTokenGroups, groupNames } from './ad-ops'
import { isDc, locateDc } from './dns'
import { connect } from './remoting'
import { BOOT_HOOKS, cmdlet, PsError, PsSession, psEquals, type CmdletContext } from './session'
import { psObject, toText, withSetter, type PsObject } from './values'

const MODULE = 'GroupPolicy'
const param = (ctx: CmdletContext, n: string) => ctx.params.get(n.toLowerCase())
const has = (ctx: CmdletContext, n: string) => ctx.params.has(n.toLowerCase())
const str = (ctx: CmdletContext, n: string) => (has(ctx, n) && param(ctx, n) !== null ? toText(param(ctx, n)) : undefined)
const formatted = (text: string): PsObject => psObject('__formatted', { text })
const yes = (v: unknown) => v === true || /^(yes|true|1)$/i.test(toText(v))

function gpStore(s: PsSession): AdStore {
  const st = (s.data.ad?.[0] ?? s.data.domainStore?.[0]) as AdStore | undefined
  if (!st) throw new PsError('The specified domain either does not exist or could not be contacted.', 'ResourceUnavailable', 'System.Runtime.InteropServices.COMException,Microsoft.GroupPolicy.Commands')
  st.gpos ??= []
  st.links ??= []
  st.blocked ??= []
  return st
}

function gpCmdlet(name: string, def: Parameters<typeof cmdlet>[1]) {
  cmdlet(name, { ...def, module: MODULE })
}

// ---------------------------------------------------------------------------------------
// Objetos que muestran los cmdlets
// ---------------------------------------------------------------------------------------

function gpoObject(st: AdStore, g: StoredGpo): PsObject {
  const o = psObject('Microsoft.GroupPolicy.Gpo', {
    DisplayName: g.name,
    DomainName: st.domain,
    Owner: `${st.netbios}\\Domain Admins`,
    Id: g.id,
    GpoStatus: g.status,
    Description: g.description,
    CreationTime: g.created,
    ModificationTime: g.modified,
    UserVersion: `AD Version: ${g.userVersion}, SysVol Version: ${g.userVersion}`,
    ComputerVersion: `AD Version: ${g.computerVersion}, SysVol Version: ${g.computerVersion}`,
    WmiFilter: g.wmi ? g.wmi.name : '',
    __toString: g.name,
  })
  // (Get-GPO X).GpoStatus = '...' y .Description = '...' cambian la GPO, como en Windows.
  return withSetter(o, (name, value) => {
    if (/^gpostatus$/i.test(name)) {
      const v = GPO_STATUS.find((x) => psEquals(x, value))
      if (!v) throw new PsError(`Exception setting "GpoStatus": "Cannot convert value "${toText(value)}" to type "Microsoft.GroupPolicy.GpoStatus".`, 'InvalidOperation', 'ExceptionWhenSetting')
      g.status = v
      g.modified = new Date()
      return v
    }
    if (/^description$/i.test(name)) {
      g.description = toText(value)
      g.modified = new Date()
    }
    return undefined
  })
}

const GPO_STATUS: StoredGpo['status'][] = ['AllSettingsEnabled', 'UserSettingsDisabled', 'ComputerSettingsDisabled', 'AllSettingsDisabled']

function linkObject(st: AdStore, l: { gpoId: string; target: string; enabled: boolean; enforced: boolean; order: number }): PsObject {
  const g = st.gpos!.find((x) => x.id === l.gpoId)
  return psObject('Microsoft.GroupPolicy.GpoLink', { GpoId: l.gpoId, DisplayName: g?.name ?? '', Enabled: l.enabled, Enforced: l.enforced, Target: l.target, Order: l.order, __toString: g?.name ?? '' })
}

function findGpo(ctx: CmdletContext, st: AdStore, opts: { name?: string; optional?: boolean } = {}): StoredGpo | undefined {
  const fromInput = ctx.input.find((x) => (x as PsObject)?.__type === 'Microsoft.GroupPolicy.Gpo') as PsObject | undefined
  const guid = str(ctx, 'Guid') ?? str(ctx, 'Id') ?? (fromInput ? toText(fromInput.Id) : undefined)
  const pos = ctx.positional[0] !== undefined ? toText(ctx.positional[0]) : undefined
  const name = opts.name ?? str(ctx, 'Name') ?? str(ctx, 'DisplayName') ?? (pos && !/^\{?[0-9a-f-]{36}\}?$/i.test(pos) ? pos : undefined)
  const id = guid ?? (pos && /^\{?[0-9a-f-]{36}\}?$/i.test(pos) ? pos : undefined)
  const g = id ? st.gpos!.find((x) => x.id.toLowerCase() === id.replace(/[{}]/g, '').toLowerCase()) : st.gpos!.find((x) => psEquals(x.name, name))
  if (!g && !opts.optional) {
    if (id) throw new PsError(`A GPO with ID {${id.replace(/[{}]/g, '')}} was not found in the ${st.domain} domain.`, 'ObjectNotFound', `GpoWithIdNotFound,Microsoft.GroupPolicy.Commands.${ctx.name.replace('-', '')}Command`, id)
    throw new PsError(`A GPO with the display name '${name}' was not found in the ${st.domain} domain.`, 'ObjectNotFound', `GpoWithNameNotFound,Microsoft.GroupPolicy.Commands.${ctx.name.replace('-', '')}Command`, name)
  }
  return g
}

/** Acepta "OU=Ventas,DC=empresa,DC=local", "Empresa/Ventas" o el nombre del dominio. */
function targetDn(st: AdStore, raw: string): string {
  if (psEquals(raw, st.domain) || psEquals(raw, 'dominio')) return st.domainDn
  return ouPathToDn(raw, st.domainDn)
}

function bumpVersion(g: StoredGpo, scope: GpScope) {
  if (scope === 'User') g.userVersion++
  else g.computerVersion++
  g.modified = new Date()
}

// ---------------------------------------------------------------------------------------
// GPO: crear, ver, borrar, renombrar, copiar
// ---------------------------------------------------------------------------------------

gpCmdlet('Get-GPO', {
  params: ['Name', 'Guid', 'Domain', 'Server'],
  switches: ['All'],
  synopsis: 'Gets one GPO or all the GPOs in a domain.',
  run(ctx) {
    const st = gpStore(ctx.s)
    if (has(ctx, 'All')) return st.gpos!.map((g) => gpoObject(st, g))
    if (!has(ctx, 'Name') && !has(ctx, 'Guid') && !ctx.positional.length) {
      ctx.host('\n[simulador] Indicá -Name "Nombre de la GPO", -Guid <id> o -All.\n')
      return []
    }
    return [gpoObject(st, findGpo(ctx, st)!)]
  },
})

gpCmdlet('New-GPO', {
  params: ['Name', 'Comment', 'Domain', 'StarterGpoName', 'Server'],
  positional: ['Name'],
  synopsis: 'Creates a new GPO.',
  run(ctx) {
    const st = gpStore(ctx.s)
    const name = str(ctx, 'Name') ?? ''
    if (!name) throw new PsError('Cannot validate argument on parameter \'Name\'. The argument is null or empty.', 'InvalidData', 'ParameterArgumentValidationError,Microsoft.GroupPolicy.Commands.NewGpoCommand')
    if (st.gpos!.some((g) => psEquals(g.name, name))) throw new PsError(`The GPO "${name}" already exists in the ${st.domain} domain.`, 'ResourceExists', 'GpoWithNameAlreadyExists,Microsoft.GroupPolicy.Commands.NewGpoCommand', name)
    const now = new Date()
    const g: StoredGpo = { id: stableGuid(`gpo:${name}:${st.gpos!.length}`), name, status: 'AllSettingsEnabled', settings: [], apply: ['Authenticated Users'], readers: ['ENTERPRISE DOMAIN CONTROLLERS'], editors: ['Domain Admins', 'Enterprise Admins', 'SYSTEM'], description: str(ctx, 'Comment') ?? '', created: now, modified: now, userVersion: 0, computerVersion: 0 }
    st.gpos!.push(g)
    return [gpoObject(st, g)]
  },
})

gpCmdlet('Remove-GPO', {
  params: ['Name', 'Guid', 'Domain'],
  switches: ['KeepLinks'],
  positional: ['Name'],
  synopsis: 'Removes a GPO.',
  run(ctx) {
    const st = gpStore(ctx.s)
    const g = findGpo(ctx, st)!
    if (g.id === '31b2f340-016d-11d2-945f-00c04fb984f9' || g.id === '6ac1786c-016f-11d2-945f-00c04fb984f9') throw new PsError(`The GPO "${g.name}" cannot be deleted: it is one of the default GPOs of the domain.`, 'PermissionDenied', 'CannotDeleteDefaultGpo,Microsoft.GroupPolicy.Commands.RemoveGpoCommand', g.name)
    st.gpos = st.gpos!.filter((x) => x !== g)
    if (!has(ctx, 'KeepLinks')) st.links = st.links!.filter((l) => l.gpoId !== g.id)
    return []
  },
})

gpCmdlet('Rename-GPO', {
  params: ['Name', 'Guid', 'TargetName'],
  positional: ['Name', 'TargetName'],
  synopsis: 'Assigns a new display name to a GPO.',
  run(ctx) {
    const st = gpStore(ctx.s)
    const g = findGpo(ctx, st)!
    const t = str(ctx, 'TargetName') ?? ''
    if (st.gpos!.some((x) => x !== g && psEquals(x.name, t))) throw new PsError(`The GPO "${t}" already exists in the ${st.domain} domain.`, 'ResourceExists', 'GpoWithNameAlreadyExists,Microsoft.GroupPolicy.Commands.RenameGpoCommand', t)
    g.name = t
    g.modified = new Date()
    return [gpoObject(st, g)]
  },
})

gpCmdlet('Copy-GPO', {
  params: ['SourceName', 'SourceGuid', 'TargetName'],
  switches: ['CopyAcl'],
  synopsis: 'Copies a GPO.',
  run(ctx) {
    const st = gpStore(ctx.s)
    const src = findGpo(ctx, st, { name: str(ctx, 'SourceName') })!
    const name = str(ctx, 'TargetName') ?? ''
    if (st.gpos!.some((g) => psEquals(g.name, name))) throw new PsError(`The GPO "${name}" already exists in the ${st.domain} domain.`, 'ResourceExists', 'GpoWithNameAlreadyExists,Microsoft.GroupPolicy.Commands.CopyGpoCommand', name)
    const now = new Date()
    const g: StoredGpo = { ...src, id: stableGuid(`gpo:${name}:${st.gpos!.length}`), name, settings: src.settings.map((x) => ({ ...x })), apply: has(ctx, 'CopyAcl') ? [...src.apply] : ['Authenticated Users'], readers: has(ctx, 'CopyAcl') ? [...(src.readers ?? [])] : ['ENTERPRISE DOMAIN CONTROLLERS'], created: now, modified: now }
    st.gpos!.push(g)
    return [gpoObject(st, g)]
  },
})

// ---------------------------------------------------------------------------------------
// Vínculos y herencia
// ---------------------------------------------------------------------------------------

function renumber(st: AdStore, target: string) {
  st.links!.filter((l) => sameDn(l.target, target)).sort((a, b) => a.order - b.order).forEach((l, i) => (l.order = i + 1))
}

gpCmdlet('New-GPLink', {
  params: ['Name', 'Guid', 'Target', 'LinkEnabled', 'Enforced', 'Order', 'Domain'],
  positional: ['Name', 'Target'],
  synopsis: 'Links a GPO to a site, domain, or organizational unit (OU).',
  run(ctx) {
    const st = gpStore(ctx.s)
    const g = findGpo(ctx, st)!
    const t = targetDn(st, str(ctx, 'Target') ?? '')
    if (!containerExists(st, t) || /^CN=/i.test(t)) throw new PsError(`The "${str(ctx, 'Target')}" Scope of Management (SOM) is not valid. A GPO can be linked only to a site, a domain or an organizational unit (CN=Users and CN=Computers are containers, not OUs).`, 'InvalidArgument', 'InvalidSom,Microsoft.GroupPolicy.Commands.NewGPLinkCommand', str(ctx, 'Target'))
    if (st.links!.some((l) => l.gpoId === g.id && sameDn(l.target, t))) throw new PsError(`The GPO named '${g.name}' is already linked to a Scope of Management with Path '${t}'.`, 'InvalidOperation', 'GpoLinkAlreadyExists,Microsoft.GroupPolicy.Commands.NewGPLinkCommand', g.name)
    const siblings = st.links!.filter((l) => sameDn(l.target, t))
    const order = has(ctx, 'Order') ? Math.max(1, Math.min(Number(param(ctx, 'Order')), siblings.length + 1)) : siblings.length + 1
    for (const l of siblings) if (l.order >= order) l.order++
    const link = { gpoId: g.id, target: t, enabled: has(ctx, 'LinkEnabled') ? yes(param(ctx, 'LinkEnabled')) : true, enforced: has(ctx, 'Enforced') ? yes(param(ctx, 'Enforced')) : false, order }
    st.links!.push(link)
    return [linkObject(st, link)]
  },
})

gpCmdlet('Set-GPLink', {
  params: ['Name', 'Guid', 'Target', 'LinkEnabled', 'Enforced', 'Order'],
  positional: ['Name', 'Target'],
  synopsis: 'Sets the properties of the specified GPO link.',
  run(ctx) {
    const st = gpStore(ctx.s)
    const g = findGpo(ctx, st)!
    const t = targetDn(st, str(ctx, 'Target') ?? '')
    const link = st.links!.find((l) => l.gpoId === g.id && sameDn(l.target, t))
    if (!link) throw new PsError(`The GPO named '${g.name}' is not linked to a Scope of Management with Path '${t}'.`, 'ObjectNotFound', 'GpoLinkNotFound,Microsoft.GroupPolicy.Commands.SetGPLinkCommand', g.name)
    if (has(ctx, 'LinkEnabled')) link.enabled = yes(param(ctx, 'LinkEnabled'))
    if (has(ctx, 'Enforced')) link.enforced = yes(param(ctx, 'Enforced'))
    if (has(ctx, 'Order')) {
      const siblings = st.links!.filter((l) => sameDn(l.target, t) && l !== link).sort((a, b) => a.order - b.order)
      const pos = Math.max(1, Math.min(Number(param(ctx, 'Order')), siblings.length + 1))
      siblings.splice(pos - 1, 0, link)
      siblings.forEach((l, i) => (l.order = i + 1))
    }
    return [linkObject(st, link)]
  },
})

gpCmdlet('Remove-GPLink', {
  params: ['Name', 'Guid', 'Target'],
  positional: ['Name', 'Target'],
  synopsis: 'Removes a GPO link from a site, domain or organizational unit (OU).',
  run(ctx) {
    const st = gpStore(ctx.s)
    const g = findGpo(ctx, st)!
    const t = targetDn(st, str(ctx, 'Target') ?? '')
    const before = st.links!.length
    st.links = st.links!.filter((l) => !(l.gpoId === g.id && sameDn(l.target, t)))
    if (st.links.length === before) throw new PsError(`The GPO named '${g.name}' is not linked to a Scope of Management with Path '${t}'.`, 'ObjectNotFound', 'GpoLinkNotFound,Microsoft.GroupPolicy.Commands.RemoveGPLinkCommand', g.name)
    renumber(st, t)
    return []
  },
})

function inheritanceObject(st: AdStore, t: string): PsObject {
  const order = processingOrder({ gpos: st.gpos!, links: st.links!, blocked: st.blocked!, domainDn: st.domainDn, containerDn: t, principals: [], scope: 'Computer' })
  const inherited = order.filter((x) => !x.blockedOut).reverse()
  const own = st.links!.filter((l) => sameDn(l.target, t)).sort((a, b) => a.order - b.order)
  const isDomain = sameDn(t, st.domainDn)
  return psObject('Microsoft.GroupPolicy.Som', {
    Name: isDomain ? st.domain : t.split(',')[0].replace(/^OU=/i, '').toLowerCase(),
    ContainerType: isDomain ? 'Domain' : 'OU',
    Path: t.toLowerCase(),
    GpoInheritanceBlocked: st.blocked!.some((b) => sameDn(b, t)) ? 'Yes' : 'No',
    GpoLinks: own.map((l) => linkObject(st, l)),
    InheritedGpoLinks: inherited.map((x) => psObject('Microsoft.GroupPolicy.InheritedGpoLink', { DisplayName: x.entry.gpo.name, GpoId: x.entry.gpo.id, Enabled: x.entry.link.enabled, Enforced: x.entry.link.enforced, Target: x.entry.link.target, Order: x.entry.link.order, __toString: x.entry.gpo.name })),
  })
}

gpCmdlet('Get-GPInheritance', {
  params: ['Target', 'Domain'],
  positional: ['Target'],
  synopsis: 'Gets Group Policy inheritance information for a specified domain or OU.',
  run(ctx) {
    const st = gpStore(ctx.s)
    const t = targetDn(st, str(ctx, 'Target') ?? st.domain)
    if (!containerExists(st, t)) throw new PsError(`The "${str(ctx, 'Target')}" Scope of Management (SOM) is not valid.`, 'InvalidArgument', 'InvalidSom,Microsoft.GroupPolicy.Commands.GetGPInheritanceCommand')
    return [inheritanceObject(st, t)]
  },
})

gpCmdlet('Set-GPInheritance', {
  params: ['Target', 'IsBlocked', 'Domain'],
  positional: ['Target'],
  synopsis: 'Blocks or unblocks inheritance for a specified domain or organizational unit (OU).',
  run(ctx) {
    const st = gpStore(ctx.s)
    const t = targetDn(st, str(ctx, 'Target') ?? '')
    if (!containerExists(st, t)) throw new PsError(`The "${str(ctx, 'Target')}" Scope of Management (SOM) is not valid.`, 'InvalidArgument', 'InvalidSom,Microsoft.GroupPolicy.Commands.SetGPInheritanceCommand')
    const block = yes(param(ctx, 'IsBlocked'))
    st.blocked = st.blocked!.filter((b) => !sameDn(b, t))
    if (block) st.blocked.push(t)
    return [inheritanceObject(st, t)]
  },
})

// ---------------------------------------------------------------------------------------
// Configuraciones (registro y preferencias)
// ---------------------------------------------------------------------------------------

function normalizeKey(key: string): { scope: GpScope; key: string; full: string; hive: string } | undefined {
  const m = /^(HKLM|HKEY_LOCAL_MACHINE|HKCU|HKEY_CURRENT_USER)\\(.+)$/i.exec(key.trim())
  if (!m) return undefined
  const machine = /^HK(LM|EY_LOCAL_MACHINE)$/i.test(m[1])
  return { scope: machine ? 'Computer' : 'User', key: m[2], full: `${machine ? 'HKEY_LOCAL_MACHINE' : 'HKEY_CURRENT_USER'}\\${m[2]}`, hive: machine ? 'LocalMachine' : 'CurrentUser' }
}

const REG_TYPES = ['String', 'ExpandString', 'Binary', 'DWord', 'MultiString', 'QWord']

function setRegistry(ctx: CmdletContext, preference: boolean) {
  const st = gpStore(ctx.s)
  const g = findGpo(ctx, st)!
  let k = normalizeKey(str(ctx, 'Key') ?? '')
  if (preference && !k && has(ctx, 'Context')) k = normalizeKey(`${psEquals(param(ctx, 'Context'), 'User') ? 'HKCU' : 'HKLM'}\\${str(ctx, 'Key')}`)
  if (!k) throw new PsError(`The key "${str(ctx, 'Key')}" is not valid. The key must start with HKLM\\ or HKCU\\ (HKEY_LOCAL_MACHINE or HKEY_CURRENT_USER).`, 'InvalidArgument', `InvalidKey,Microsoft.GroupPolicy.Commands.Set${preference ? 'GPPref' : 'GP'}RegistryValueCommand`, str(ctx, 'Key'))
  const valueName = str(ctx, 'ValueName') ?? ''
  const type = REG_TYPES.find((t) => psEquals(t, param(ctx, 'Type') ?? 'String'))
  if (!type) throw new PsError(`Cannot bind parameter 'Type'. Cannot convert value "${str(ctx, 'Type')}" to type "Microsoft.Win32.RegistryValueKind".`, 'InvalidArgument', 'CannotConvertArgumentNoMessage')
  const raw = param(ctx, 'Value')
  const value = type === 'DWord' || type === 'QWord' ? Number(raw) : toText(raw)
  if (typeof value === 'number' && Number.isNaN(value)) throw new PsError(`The value "${toText(raw)}" is not valid for a ${type} registry value.`, 'InvalidArgument', 'InvalidValue')
  g.settings = g.settings.filter((x) => !(x.scope === k!.scope && psEquals(x.key, k!.full) && psEquals(x.valueName, valueName)))
  const setting: GpoSetting = { scope: k.scope, key: k.full, valueName, value, label: preference ? `${k.scope === 'User' ? 'User' : 'Computer'} Configuration > Preferences > Windows Settings > Registry > ${valueName}` : policyLabel(k.key, valueName) }
  if (preference && psEquals(param(ctx, 'Action') ?? 'Update', 'Delete')) setting.value = '(borrar)'
  g.settings.push(setting)
  bumpVersion(g, k.scope)
  return [gpoObject(st, g)]
}

gpCmdlet('Set-GPRegistryValue', {
  params: ['Name', 'Guid', 'Key', 'ValueName', 'Type', 'Value', 'Domain'],
  switches: ['Additive', 'Disable'],
  positional: ['Name'],
  synopsis: 'Configures one or more registry-based policy settings under either Computer Configuration or User Configuration in a GPO.',
  run: (ctx) => setRegistry(ctx, false),
})

gpCmdlet('Set-GPPrefRegistryValue', {
  params: ['Name', 'Guid', 'Context', 'Key', 'ValueName', 'Type', 'Value', 'Action', 'Order'],
  positional: ['Name'],
  synopsis: 'Configures a Registry preference item under either Computer Configuration or User Configuration in a GPO.',
  run: (ctx) => setRegistry(ctx, true),
})

gpCmdlet('Get-GPRegistryValue', {
  params: ['Name', 'Guid', 'Key', 'ValueName', 'Domain'],
  positional: ['Name'],
  synopsis: 'Retrieves one or more registry-based policy settings under either Computer Configuration or User Configuration in a GPO.',
  run(ctx) {
    const st = gpStore(ctx.s)
    const g = findGpo(ctx, st)!
    const k = normalizeKey(str(ctx, 'Key') ?? '')
    const found = g.settings.filter((x) => k && psEquals(x.key, k.full) && (!has(ctx, 'ValueName') || psEquals(x.valueName, param(ctx, 'ValueName'))))
    if (!found.length) throw new PsError(`The following Group Policy registry setting was not found: "${k?.full ?? str(ctx, 'Key')}${has(ctx, 'ValueName') ? `\\${str(ctx, 'ValueName')}` : ''}".\nParameter name: keyPath`, 'InvalidArgument', 'UnableToRetrievePolicyRegistryItem,Microsoft.GroupPolicy.Commands.GetGPRegistryValueCommand')
    return found.map((x) => psObject('Microsoft.GroupPolicy.PolicyRegistrySetting', { KeyPath: x.key.replace(/^HKEY_[A-Z_]+\\/, ''), FullKeyPath: x.key, Hive: x.scope === 'User' ? 'CurrentUser' : 'LocalMachine', PolicyState: 'Set', Value: x.value, Type: typeof x.value === 'number' ? 'DWord' : 'String', ValueName: x.valueName, HasValue: true }))
  },
})

gpCmdlet('Remove-GPRegistryValue', {
  params: ['Name', 'Guid', 'Key', 'ValueName'],
  positional: ['Name'],
  synopsis: 'Removes one or more registry-based policy settings from either Computer Configuration or User Configuration in a GPO.',
  run(ctx) {
    const st = gpStore(ctx.s)
    const g = findGpo(ctx, st)!
    const k = normalizeKey(str(ctx, 'Key') ?? '')
    const before = g.settings.length
    g.settings = g.settings.filter((x) => !(k && psEquals(x.key, k.full) && (!has(ctx, 'ValueName') || psEquals(x.valueName, param(ctx, 'ValueName')))))
    if (g.settings.length === before) throw new PsError(`The following Group Policy registry setting was not found: "${k?.full ?? str(ctx, 'Key')}".`, 'InvalidArgument', 'UnableToRetrievePolicyRegistryItem,Microsoft.GroupPolicy.Commands.RemoveGPRegistryValueCommand')
    if (k) bumpVersion(g, k.scope)
    return [gpoObject(st, g)]
  },
})

// ---------------------------------------------------------------------------------------
// Permisos (filtrado de seguridad)
// ---------------------------------------------------------------------------------------

const LEVELS = ['None', 'GpoRead', 'GpoApply', 'GpoEdit', 'GpoEditDeleteModifySecurity'] as const

function permissionOf(g: StoredGpo, trustee: string): (typeof LEVELS)[number] {
  if (g.editors.some((x) => psEquals(x, trustee))) return 'GpoEditDeleteModifySecurity'
  if (g.apply.some((x) => psEquals(x, trustee))) return 'GpoApply'
  if ((g.readers ?? []).some((x) => psEquals(x, trustee))) return 'GpoRead'
  return 'None'
}

const WELL_KNOWN = ['Authenticated Users', 'Everyone', 'ENTERPRISE DOMAIN CONTROLLERS', 'SYSTEM']

function trusteeType(st: AdStore, name: string): string {
  if (WELL_KNOWN.some((w) => psEquals(w, name))) return 'WellKnownGroup'
  const o = resolveAny(st, name) ?? st.groups.find((g) => psEquals(g.Name, name))
  return o?.ObjectClass === 'user' ? 'User' : o?.ObjectClass === 'computer' ? 'Computer' : 'Group'
}

function permObject(st: AdStore, g: StoredGpo, trustee: string): PsObject {
  return psObject('Microsoft.GroupPolicy.GPPermission', { Trustee: trustee, TrusteeType: trusteeType(st, trustee), Permission: permissionOf(g, trustee), Inheritable: true, Inherited: false, __toString: trustee })
}

gpCmdlet('Get-GPPermission', {
  params: ['Name', 'Guid', 'TargetName', 'TargetType', 'Domain'],
  switches: ['All'],
  positional: ['Name'],
  synopsis: 'Gets the permission level for one or more security principals on a specified GPO.',
  run(ctx) {
    const st = gpStore(ctx.s)
    const g = findGpo(ctx, st)!
    if (has(ctx, 'TargetName')) {
      const t = str(ctx, 'TargetName')!
      if (permissionOf(g, t) === 'None') throw new PsError(`The trustee "${t}" does not have any permissions on the GPO "${g.name}".`, 'ObjectNotFound', 'TrusteeNotFound,Microsoft.GroupPolicy.Commands.GetGPPermissionCommand', t)
      return [permObject(st, g, t)]
    }
    const names = [...new Set([...g.apply, ...(g.readers ?? []), ...g.editors])]
    return names.map((n) => permObject(st, g, n))
  },
})

gpCmdlet('Set-GPPermission', {
  params: ['Name', 'Guid', 'TargetName', 'TargetType', 'PermissionLevel', 'Domain'],
  switches: ['Replace', 'All'],
  positional: ['Name'],
  synopsis: 'Grants a level of permissions to a security principal for one GPO or for all the GPOs in a domain.',
  run(ctx) {
    const st = gpStore(ctx.s)
    const g = findGpo(ctx, st)!
    const t = str(ctx, 'TargetName') ?? ''
    if (!WELL_KNOWN.some((w) => psEquals(w, t)) && !resolveAny(st, t) && !st.groups.some((x) => psEquals(x.Name, t))) throw new PsError(`The trustee "${t}" could not be found. Check the name and the -TargetType (User, Group or Computer).`, 'ObjectNotFound', 'TrusteeNotFound,Microsoft.GroupPolicy.Commands.SetGPPermissionCommand', t)
    const level = LEVELS.find((l) => psEquals(l, param(ctx, 'PermissionLevel')))
    if (!level) throw new PsError(`Cannot bind parameter 'PermissionLevel'. Cannot convert value "${str(ctx, 'PermissionLevel')}" to type "Microsoft.GroupPolicy.GPPermissionType".`, 'InvalidArgument', 'CannotConvertArgumentNoMessage')
    const current = permissionOf(g, t)
    if (LEVELS.indexOf(level) < LEVELS.indexOf(current) && !has(ctx, 'Replace')) throw new PsError(`The permission level for "${t}" cannot be lowered from ${current} to ${level} unless you specify the Replace parameter.`, 'InvalidOperation', 'PermissionLevelLowered,Microsoft.GroupPolicy.Commands.SetGPPermissionCommand', t)
    const drop = (list: string[]) => list.filter((x) => !psEquals(x, t))
    g.apply = drop(g.apply)
    g.readers = drop(g.readers ?? [])
    g.editors = drop(g.editors)
    if (level === 'GpoApply') g.apply.push(t)
    else if (level === 'GpoRead') g.readers.push(t)
    else if (level !== 'None') g.editors.push(t)
    g.modified = new Date()
    return [gpoObject(st, g)]
  },
})

// ---------------------------------------------------------------------------------------
// Respaldo, restauración, importación e informes
// ---------------------------------------------------------------------------------------

function cloneGpo(g: StoredGpo): StoredGpo {
  return { ...g, settings: g.settings.map((x) => ({ ...x })), apply: [...g.apply], readers: [...(g.readers ?? [])], editors: [...g.editors] }
}

function backupObject(st: AdStore, b: NonNullable<AdStore['gpoBackups']>[number]): PsObject {
  return psObject('Microsoft.GroupPolicy.GpoBackup', { DisplayName: b.gpo.name, GpoId: b.gpo.id, Id: b.id, BackupDirectory: b.path, CreationTime: b.created, DomainName: st.domain, Comment: b.comment })
}

gpCmdlet('Backup-GPO', {
  params: ['Name', 'Guid', 'Path', 'Comment', 'Domain'],
  switches: ['All'],
  positional: ['Name'],
  synopsis: 'Backs up one GPO or all the GPOs in a domain.',
  run(ctx) {
    const st = gpStore(ctx.s)
    const path = ctx.s.resolvePath(str(ctx, 'Path') ?? '')
    if (!ctx.s.fs.get(path)) throw new PsError(`The system cannot find the path specified. (Exception from HRESULT: 0x80070003)`, 'ObjectNotFound', 'System.IO.DirectoryNotFoundException,Microsoft.GroupPolicy.Commands.BackupGpoCommand', path)
    const targets = has(ctx, 'All') ? st.gpos! : [findGpo(ctx, st)!]
    return targets.map((g) => {
      const id = stableGuid(`backup:${g.id}:${(st.gpoBackups ?? []).length}`)
      ctx.s.fs.mkdirp(`${path}\\{${id.toUpperCase()}}\\DomainSysvol\\GPO`)
      ctx.s.fs.write(`${path}\\{${id.toUpperCase()}}\\Backup.xml`, `<?xml version="1.0" encoding="utf-8"?>\r\n<GroupPolicyBackupScheme><GroupPolicyObject><GroupPolicyCoreSettings><ID>{${g.id.toUpperCase()}}</ID><Domain>${st.domain}</Domain><DisplayName>${g.name}</DisplayName></GroupPolicyCoreSettings></GroupPolicyObject></GroupPolicyBackupScheme>\r\n`)
      ctx.s.fs.write(`${path}\\{${id.toUpperCase()}}\\gpreport.xml`, gpoReport(st, g, 'Xml'))
      const b = { id, gpo: cloneGpo(g), path, created: new Date(), comment: str(ctx, 'Comment') ?? '' }
      ;(st.gpoBackups ??= []).push(b)
      return backupObject(st, b)
    })
  },
})

function findBackup(ctx: CmdletContext, st: AdStore, name: string | undefined, guid: string | undefined) {
  const path = ctx.s.resolvePath(str(ctx, 'Path') ?? '')
  const list = (st.gpoBackups ?? []).filter((b) => psEquals(b.path, path) && (guid ? psEquals(b.gpo.id, guid.replace(/[{}]/g, '')) : psEquals(b.gpo.name, name)) && (!has(ctx, 'BackupId') || psEquals(b.id, toText(param(ctx, 'BackupId')).replace(/[{}]/g, ''))))
  const b = list[list.length - 1]
  if (!b) throw new PsError(`The backup of the GPO "${name ?? guid}" was not found in the "${path}" directory.`, 'ObjectNotFound', 'BackupNotFound,Microsoft.GroupPolicy.Commands', name ?? guid)
  return b
}

gpCmdlet('Restore-GPO', {
  params: ['Name', 'Guid', 'Path', 'BackupId', 'Domain'],
  switches: ['All'],
  positional: ['Name'],
  synopsis: 'Restores one GPO or all GPOs in a domain from one or more GPO backup files.',
  run(ctx) {
    const st = gpStore(ctx.s)
    const b = findBackup(ctx, st, str(ctx, 'Name'), str(ctx, 'Guid'))
    const existing = st.gpos!.find((g) => g.id === b.gpo.id)
    const restored = { ...cloneGpo(b.gpo), modified: new Date() }
    if (existing) Object.assign(existing, restored)
    else {
      st.gpos!.push(restored)
      // Los vínculos no son parte del respaldo: una GPO borrada vuelve sin vincular.
      ctx.host(`[simulador] La GPO "${b.gpo.name}" volvió con su configuración y sus permisos, pero sin vínculos: los vínculos viven en las OU, no en la GPO. Volvé a vincularla con New-GPLink.\n`)
    }
    return [gpoObject(st, existing ?? restored)]
  },
})

gpCmdlet('Import-GPO', {
  params: ['BackupGpoName', 'BackupId', 'TargetName', 'TargetGuid', 'Path', 'MigrationTable'],
  switches: ['CreateIfNeeded'],
  synopsis: 'Imports the Group Policy settings from a backed-up GPO into a specified GPO.',
  run(ctx) {
    const st = gpStore(ctx.s)
    const b = findBackup(ctx, st, str(ctx, 'BackupGpoName'), undefined)
    let target = st.gpos!.find((g) => psEquals(g.name, str(ctx, 'TargetName')))
    if (!target) {
      if (!has(ctx, 'CreateIfNeeded')) throw new PsError(`A GPO with the display name '${str(ctx, 'TargetName')}' was not found in the ${st.domain} domain. Use -CreateIfNeeded to create it.`, 'ObjectNotFound', 'GpoWithNameNotFound,Microsoft.GroupPolicy.Commands.ImportGpoCommand')
      const now = new Date()
      target = { ...cloneGpo(b.gpo), id: stableGuid(`gpo:${str(ctx, 'TargetName')}:${st.gpos!.length}`), name: str(ctx, 'TargetName')!, apply: ['Authenticated Users'], readers: ['ENTERPRISE DOMAIN CONTROLLERS'], created: now, modified: now }
      st.gpos!.push(target)
    } else {
      target.settings = b.gpo.settings.map((x) => ({ ...x }))
      target.modified = new Date()
    }
    return [gpoObject(st, target)]
  },
})

function esc(t: string) {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function settingValue(x: GpoSetting) {
  return typeof x.value === 'number' ? String(x.value) : x.value
}

function gpoReport(st: AdStore, g: StoredGpo, type: string): string {
  const links = st.links!.filter((l) => l.gpoId === g.id)
  if (/xml/i.test(type)) return `<?xml version="1.0" encoding="utf-16"?>\r\n<GPO xmlns="http://www.microsoft.com/GroupPolicy/Settings">\r\n  <Identifier><Identifier>{${g.id}}</Identifier><Domain>${st.domain}</Domain></Identifier>\r\n  <Name>${esc(g.name)}</Name>\r\n  <CreatedTime>${g.created.toISOString()}</CreatedTime>\r\n  <ModifiedTime>${g.modified.toISOString()}</ModifiedTime>\r\n${links.map((l) => `  <LinksTo><SOMName>${esc(readableContainer(l.target, st.domainDn).split('/').pop()!)}</SOMName><SOMPath>${esc(readableContainer(l.target, st.domainDn))}</SOMPath><Enabled>${l.enabled}</Enabled><NoOverride>${l.enforced}</NoOverride></LinksTo>\r\n`).join('')}${g.settings.map((x) => `  <${x.scope}><Policy><Name>${esc(x.label ?? x.valueName)}</Name><Key>${esc(x.key)}</Key><ValueName>${esc(x.valueName)}</ValueName><Value>${esc(settingValue(x))}</Value></Policy></${x.scope}>\r\n`).join('')}</GPO>\r\n`
  const rows = (scope: GpScope) => g.settings.filter((x) => x.scope === scope).map((x) => `<tr><td>${esc(x.label ?? `${x.key}\\${x.valueName}`)}</td><td>${esc(settingValue(x))}</td></tr>`).join('') || '<tr><td colspan="2">No settings defined.</td></tr>'
  return `<html><head><title>${esc(g.name)}</title></head><body><h1>${esc(g.name)}</h1><p>Data collected on: ${new Date().toLocaleString('en-US').replace(',', '')}</p><h2>Links</h2><table><tr><th>Location</th><th>Enforced</th><th>Link Status</th></tr>${links.map((l) => `<tr><td>${esc(readableContainer(l.target, st.domainDn))}</td><td>${l.enforced ? 'Yes' : 'No'}</td><td>${l.enabled ? 'Enabled' : 'Disabled'}</td></tr>`).join('')}</table><h2>Security Filtering</h2><p>${g.apply.map(esc).join('<br>')}</p><h2>Computer Configuration (${g.status === 'ComputerSettingsDisabled' || g.status === 'AllSettingsDisabled' ? 'Disabled' : 'Enabled'})</h2><table>${rows('Computer')}</table><h2>User Configuration (${g.status === 'UserSettingsDisabled' || g.status === 'AllSettingsDisabled' ? 'Disabled' : 'Enabled'})</h2><table>${rows('User')}</table></body></html>\r\n`
}

gpCmdlet('Get-GPOReport', {
  params: ['Name', 'Guid', 'ReportType', 'Path', 'Domain'],
  switches: ['All'],
  positional: ['Name'],
  synopsis: 'Generates a report either in XML or HTML format for a specified GPO or for all GPOs in a domain.',
  run(ctx) {
    const st = gpStore(ctx.s)
    if (!has(ctx, 'ReportType')) throw new PsError("Cannot process command because of one or more missing mandatory parameters: ReportType.", 'InvalidArgument', 'MissingMandatoryParameter,Microsoft.GroupPolicy.Commands.GetGpoReportCommand')
    const targets = has(ctx, 'All') ? st.gpos! : [findGpo(ctx, st)!]
    const text = targets.map((g) => gpoReport(st, g, toText(param(ctx, 'ReportType')))).join('')
    if (has(ctx, 'Path')) {
      ctx.s.fs.write(ctx.s.resolvePath(str(ctx, 'Path')!), text)
      return []
    }
    return [text]
  },
})

// ---------------------------------------------------------------------------------------
// RSoP: qué recibe un equipo o un usuario
// ---------------------------------------------------------------------------------------

/** RSoP calculado ahora con la base del dominio (lo que el equipo recibiría con un gpupdate). */
export function rsopFor(st: AdStore, target: PsObject, scope: GpScope, computerSession?: PsSession, computer?: PsObject): RsopResult {
  const own = [toText(target.Name), toText(target.SamAccountName)]
  const principals = target.ObjectClass === 'computer' && computerSession ? [...own, ...computerTokenGroups(computerSession, st)] : [...own, ...groupNames(st, target)]
  let computerPrincipals: string[] | undefined
  if (scope === 'User' && computer) computerPrincipals = [toText(computer.Name), toText(computer.SamAccountName), ...(computerSession ? computerTokenGroups(computerSession, st) : groupNames(st, computer))]
  return computeRsop({ gpos: st.gpos ?? [], links: st.links ?? [], blocked: st.blocked ?? [], domainDn: st.domainDn, containerDn: toText(target.__parent), principals, scope, computerPrincipals })
}

export interface AppliedPolicy {
  when: Date
  dc: string
  computer?: RsopResult
  user?: RsopResult
  userName: string
}

function findUser(st: AdStore, name: string): PsObject | undefined {
  const n = name.replace(/^[^\\]+\\/, '')
  return st.users.find((u) => psEquals(u.SamAccountName, n))
}

/** Lo que hace gpupdate: baja las GPO y guarda el resultado en el equipo. */
export function applyGroupPolicy(s: PsSession, st: AdStore, dc: string, userName = s.state.usuario, scope: 'both' | 'computer' | 'user' = 'both'): AppliedPolicy {
  const prev = s.data.gpApplied?.[0] as AppliedPolicy | undefined
  const computer = st.computers.find((c) => psEquals(c.Name, s.state.equipo))
  const user = findUser(st, userName)
  const result: AppliedPolicy = {
    when: new Date(Date.now() + s.state.desfase_reloj_min * 60_000),
    dc,
    userName,
    computer: scope === 'user' ? prev?.computer : computer ? rsopFor(st, computer, 'Computer', s) : undefined,
    user: scope === 'computer' ? prev?.user : user ? rsopFor(st, user, 'User', s, computer) : undefined,
  }
  s.data.gpApplied = [result]
  return result
}

/** Al armar el laboratorio, los equipos del dominio ya tienen aplicadas las GPO de ese momento. */
export function initialGroupPolicy(s: PsSession) {
  const st = s.data.domainStore?.[0] as AdStore | undefined
  if (!st || !s.state.dominio) return
  st.gpos ??= []
  st.links ??= []
  st.blocked ??= []
  const dcName = isDc(s.state, s.lab) ? s.state.equipo : (st.fsmo?.PDCEmulator ?? s.state.equipo)
  applyGroupPolicy(s, st, `${dcName}.${st.domain}`)
}

function gpupdateText(s: PsSession, scope: 'both' | 'computer' | 'user'): string {
  const head = 'Updating policy...\n\n'
  const parts = (msg: (who: string) => string) => (scope === 'both' ? ['Computer', 'User'] : [scope === 'computer' ? 'Computer' : 'User']).map(msg).join('\n')
  if (!s.state.dominio) return head + parts((w) => `${w} Policy update has completed successfully.`) + '\n\n'
  const found = locateDc(s)
  const st = s.data.domainStore?.[0] as AdStore | undefined
  const fail = (reason: string) => head + parts((w) => `${w} policy could not be updated successfully. The following errors were encountered:\n\n${reason} `) + '\n\nTo diagnose the failure, review the event log or run GPRESULT /H GPReport.html from the command line to access information about Group Policy results.\n'
  if (!found.dc || !st) return fail('The processing of Group Policy failed. Windows could not obtain the name of a domain controller. This could be caused by a name resolution failure. Verify your Domain Name System (DNS) is configured and working correctly.')
  if (Math.abs(found.dc.state.desfase_reloj_min - s.state.desfase_reloj_min) > 5) return fail('The processing of Group Policy failed. Windows could not authenticate to the Active Directory service on a domain controller. (LDAP Bind function call failed). Look in the details tab for error code and description.')
  const comp = st.computers.find((c) => psEquals(c.Name, s.state.equipo))
  if (!comp || comp.Enabled === false || comp.__brokenTrust) return fail('The processing of Group Policy failed because of lack of network connectivity to a domain controller. This may be a transient condition. A success message would be generated once the machine gets connected to the domain controller and Group Policy has successfully processed.')
  applyGroupPolicy(s, st, `${found.dc.state.equipo}.${st.domain}`, s.state.usuario, scope)
  return head + parts((w) => `${w} Policy update has completed successfully.`) + '\n\n'
}

cmdlet('gpupdate', {
  native: true,
  synopsis: 'gpupdate.exe',
  run(ctx) {
    const args = ctx.positional.map((a) => toText(a).toLowerCase())
    const target = args.find((a) => a.startsWith('/target:'))?.split(':')[1]
    return [formatted(gpupdateText(ctx.s, target === 'computer' ? 'computer' : target === 'user' ? 'user' : 'both'))]
  },
})

gpCmdlet('Invoke-GPUpdate', {
  params: ['Computer', 'Target', 'RandomDelayInMinutes'],
  switches: ['Force', 'Boot', 'LogOff', 'AsJob'],
  synopsis: 'Schedules a remote Group Policy refresh (gpupdate) on the specified host.',
  run(ctx) {
    const name = str(ctx, 'Computer') ?? ctx.s.state.equipo
    const t = connect(ctx.s, name)
    if (t instanceof PsError) throw new PsError(`Computer "${name}" is not responding. The target computer is either turned off or Remote Scheduled Tasks Management Firewall rules are disabled.`, 'OperationTimeout', 'COMException,Microsoft.GroupPolicy.Commands.InvokeGPUpdateCommand', name)
    const text = gpupdateText(t, str(ctx, 'Target')?.toLowerCase() === 'computer' ? 'computer' : str(ctx, 'Target')?.toLowerCase() === 'user' ? 'user' : 'both')
    if (/could not be updated/.test(text)) ctx.writeError(`The Group Policy refresh on "${name}" failed. ${text.split('\n').find((l) => l.startsWith('The processing')) ?? ''}`, 'NotSpecified', name)
    return []
  },
})

const REASONS: Record<string, string> = {
  'Disabled (Link)': 'Disabled (Link)',
  'Disabled (GPO)': 'Disabled (GPO)',
  'Denied (Security)': 'Denied (Security)',
  'Denied (WMI Filter)': 'Denied (WMI Filter)',
  'Not Applied (Empty)': 'Not Applied (Empty)',
}

function dwordBytes(n: number) {
  return [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255].join(', ')
}

function settingsBlock(r: RsopResult, scope: GpScope): string {
  const reg = r.settings.filter((w) => /^HKEY_/i.test(w.setting.key))
  const sec = r.settings.filter((w) => /^Security\\/i.test(w.setting.key))
  let out = ''
  if (sec.length) {
    out += '\n    Account Policies\n    ----------------\n'
    for (const w of sec) out += `        GPO: ${w.gpo.name}\n            Policy:            ${w.setting.valueName}\n            ${scope} Setting:  ${settingValue(w.setting)}\n\n`
  }
  out += '\n    Administrative Templates\n    ------------------------\n'
  if (!reg.length) out += '        N/A\n'
  for (const w of reg) {
    const v = w.setting.value
    out += `        GPO: ${w.gpo.name}\n            KeyName:     ${w.setting.key.replace(/^HKEY_[A-Z_]+\\/, '')}\\${w.setting.valueName}\n            Value:       ${typeof v === 'number' ? dwordBytes(v) : v}\n            State:       Enabled\n${w.losers.length ? `            [simulador] También lo configuraban (y perdieron): ${w.losers.map((l) => `${l.gpo.name} = ${l.value}`).join('; ')}\n` : ''}\n`
  }
  return out
}

function section(st: AdStore, title: string, objDn: string, r: RsopResult | undefined, applied: AppliedPolicy, groups: string[], verbose: boolean, kind: 'computer' | 'user'): string {
  const line = '-'.repeat(title.length)
  if (!r) return `\n${title}\n${line}\n    [simulador] No hay datos de directivas para este ${kind === 'user' ? 'usuario' : 'equipo'}.\n`
  const when = applied.when.toLocaleString('en-US').replace(',', ' at')
  const appliedList = r.applied.map((e) => `        ${e.gpo.name}`).join('\n') || '        N/A'
  const filtered = [...r.filtered.filter((f) => f.reason !== 'Blocked (Inheritance)').map((f) => `        ${f.gpo.name}\n            Filtering:  ${REASONS[f.reason] ?? f.reason}`), '        Local Group Policy\n            Filtering:  Not Applied (Empty)'].join('\n\n')
  return `\n${title}\n${line}\n    ${objDn}\n    Last time Group Policy was applied: ${when}\n    Group Policy was applied from:      ${applied.dc}\n    Group Policy slow link threshold:   500 kbps\n    Domain Name:                        ${st.netbios}\n    Domain Type:                        Windows 2008 or later\n\n    Applied Group Policy Objects\n    -----------------------------\n${appliedList}\n\n    The following GPOs were not applied because they were filtered out\n    -------------------------------------------------------------------\n${filtered}\n\n    The ${kind} is a part of the following security groups\n    ${'-'.repeat(kind === 'user' ? 47 : 51)}\n${groups.map((g) => `        ${g}`).join('\n')}\n${verbose ? settingsBlock(r, kind === 'user' ? 'User' : 'Computer') : ''}`
}

cmdlet('gpresult', {
  native: true,
  synopsis: 'gpresult.exe',
  run(ctx) {
    const s = ctx.s
    const args = ctx.positional.map(toText)
    const lower = args.map((a) => a.toLowerCase())
    const valueAfter = (flag: string) => {
      const i = lower.findIndex((a) => a === flag || a.startsWith(`${flag}:`))
      if (i < 0) return undefined
      return lower[i].includes(':') ? args[i].split(':').slice(1).join(':') : args[i + 1]
    }
    const scope = valueAfter('/scope')?.toLowerCase()
    const userArg = valueAfter('/user')
    const html = valueAfter('/h')
    const verbose = lower.includes('/v') || lower.includes('/z')
    if (!lower.some((a) => ['/r', '/v', '/z', '/h'].includes(a) || a.startsWith('/h:'))) return [formatted('\nGPRESULT [/S system [/U username [/P [password]]]] [/SCOPE scope]\n           [/USER targetusername] [/R | /V | /Z] [(/X | /H) <filename> [/F]]\n\n[simulador] Lo habitual: gpresult /r, gpresult /r /scope computer, gpresult /h C:\\Temp\\informe.html\n')]
    const st = s.data.domainStore?.[0] as AdStore | undefined
    const applied = s.data.gpApplied?.[0] as AppliedPolicy | undefined
    const userName = userArg ?? s.state.usuario
    if (!st || !s.state.dominio || !applied) return [formatted(`\nINFO: The user "${s.state.equipo}\\${userName}" does not have RSoP data.\n`)]
    const user = findUser(st, userName)
    if (userArg && (!user || !psEquals(applied.userName, user.SamAccountName))) return [formatted(`\nINFO: The user "${st.netbios}\\${userArg}" does not have RSoP data.\n`)]
    const comp = st.computers.find((c) => psEquals(c.Name, s.state.equipo))
    const dcRole = isDc(s.state, s.lab)
    const header = `\nMicrosoft (R) Windows (R) Operating System Group Policy Result tool v2.0\n© Microsoft Corporation. All rights reserved.\n\nCreated on ${new Date(Date.now() + s.state.desfase_reloj_min * 60_000).toLocaleString('en-US').replace(',', ' at')}\n\n\nRSOP data for ${st.netbios}\\${userName} on ${s.state.equipo} : Logging Mode\n${'-'.repeat(`RSOP data for ${st.netbios}\\${userName} on ${s.state.equipo} : Logging Mode`.length)}\n\nOS Configuration:            ${dcRole ? 'Primary Domain Controller' : /Windows 11/.test(toText(comp?.OperatingSystem)) ? 'Member Workstation' : 'Member Server'}\nOS Version:                  10.0.26100\nSite Name:                   Default-First-Site-Name\nRoaming Profile:             N/A\nLocal Profile:               C:\\Users\\${userName}\nConnected over a slow link?: No\n`
    const compGroups = ['BUILTIN\\Administrators', 'Everyone', 'BUILTIN\\Users', 'NT AUTHORITY\\NETWORK', 'NT AUTHORITY\\Authenticated Users', 'This Organization', `${s.state.equipo.toUpperCase()}$`, ...(comp ? computerTokenGroups(s, st) : []), 'System Mandatory Level']
    const extra = user ? groupNames(st, user).filter((g) => g !== 'Domain Users') : []
    // Solo los administradores del dominio son administradores locales de las PC por defecto.
    const isAdmin = extra.some((g) => /^(domain|enterprise) admins$/i.test(g)) || !user
    const userGroups = ['Domain Users', 'Everyone', 'BUILTIN\\Users', ...(isAdmin ? ['BUILTIN\\Administrators'] : []), 'NT AUTHORITY\\INTERACTIVE', 'NT AUTHORITY\\Authenticated Users', 'This Organization', 'LOCAL', ...extra, isAdmin ? 'High Mandatory Level' : 'Medium Mandatory Level']
    let text = header
    if (scope !== 'user') text += section(st, 'COMPUTER SETTINGS', comp ? dnOf(comp) : '', applied.computer, applied, compGroups, verbose, 'computer')
    if (scope !== 'computer') text += section(st, 'USER SETTINGS', user ? dnOf(user) : '', applied.user, applied, userGroups, verbose, 'user')
    if (html) {
      const path = s.resolvePath(html)
      s.fs.write(path, `<html><head><title>Group Policy Results</title></head><body><pre>${esc(text)}</pre></body></html>\r\n`)
      return []
    }
    return [formatted(text + '\n')]
  },
})

gpCmdlet('Get-GPResultantSetOfPolicy', {
  params: ['Computer', 'User', 'ReportType', 'Path'],
  synopsis: 'Gets and writes the RSoP information for a user, a computer, or both to a file.',
  run(ctx) {
    const name = str(ctx, 'Computer') ?? ctx.s.state.equipo
    const t = psEquals(name, ctx.s.state.equipo) || psEquals(name, 'localhost') ? ctx.s : connect(ctx.s, name)
    if (t instanceof PsError) throw new PsError(`The RSoP data could not be collected from "${name}". The RPC server is unavailable.`, 'OperationStopped', 'RsopFailure,Microsoft.GroupPolicy.Commands.GetGPResultantSetOfPolicyCommand', name)
    const applied = t.data.gpApplied?.[0] as AppliedPolicy | undefined
    if (!applied) throw new PsError(`The computer "${name}" does not have RSoP data. It is not a member of a domain or has not processed Group Policy yet.`, 'ObjectNotFound', 'NoRsopData,Microsoft.GroupPolicy.Commands.GetGPResultantSetOfPolicyCommand', name)
    const list = (r?: RsopResult) => (r ? r.applied.map((e) => `<li>${esc(e.gpo.name)} <small>(${esc(e.from)})</small></li>`).join('') : '')
    const report = `<html><head><title>Group Policy Results - ${esc(t.state.equipo)}</title></head><body><h1>${esc(t.state.equipo)}\\${esc(applied.userName)}</h1><h2>Computer Details</h2><ul>${list(applied.computer)}</ul><h2>User Details</h2><ul>${list(applied.user)}</ul></body></html>\r\n`
    if (has(ctx, 'Path')) ctx.s.fs.write(ctx.s.resolvePath(str(ctx, 'Path')!), report)
    return [psObject('Microsoft.GroupPolicy.Rsop', { ReportType: str(ctx, 'ReportType') ?? 'Html', Path: str(ctx, 'Path') ?? '', Computer: t.state.equipo, User: applied.userName })]
  },
})

// Para el resto del motor: armar un objeto de AD por nombre (usuario o equipo).
export function adPrincipal(st: AdStore, name: string): PsObject | undefined {
  return findUser(st, name) ?? st.computers.find((c) => psEquals(c.Name, name.replace(/\$$/, ''))) ?? resolveAny(st, name)
}

// Al arrancar, el equipo baja las GPO si encuentra un controlador de dominio.
BOOT_HOOKS.push((s) => {
  const st = s.data.domainStore?.[0] as AdStore | undefined
  if (!st || !s.state.dominio) return
  const found = locateDc(s)
  if (found.dc && Math.abs(found.dc.state.desfase_reloj_min - s.state.desfase_reloj_min) <= 5) applyGroupPolicy(s, st, `${found.dc.state.equipo}.${st.domain}`)
})
