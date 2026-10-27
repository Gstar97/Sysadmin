/** Módulo ActiveDirectory simulado: usuarios, grupos, unidades organizativas y equipos de un dominio. */
import { asArray, cmdlet, PsError, PsSession, wildcardToRegex, type CmdletContext, type CmdletDef } from './session'
import { getProp, isPsObject, psObject, toText, type PsObject } from './values'

const AD_MODULE = 'ActiveDirectory'
const NS = 'Microsoft.ActiveDirectory.Management'

export interface AdStore {
  domain: string
  domainDn: string
  netbios: string
  users: PsObject[]
  groups: PsObject[]
  ous: PsObject[]
  computers: PsObject[]
  nextRid: number
}

export const DOMAIN_SID = 'S-1-5-21-3623811015-3361044348-30300820'

/** GUID estable a partir de un texto, para que el mismo objeto muestre siempre el mismo ObjectGUID. */
export function stableGuid(seed: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  const hex: string[] = []
  for (let round = 0; round < 4; round++) {
    for (const ch of `${seed}#${round}`) {
      h1 = Math.imul(h1 ^ ch.charCodeAt(0), 16777619) >>> 0
      h2 = Math.imul(h2 + ch.charCodeAt(0), 2246822519) >>> 0
    }
    hex.push(((h1 ^ h2) >>> 0).toString(16).padStart(8, '0'))
  }
  const s = hex.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20, 32)}`
}

export function domainToDn(domain: string): string {
  return domain
    .split('.')
    .map((p) => `DC=${p}`)
    .join(',')
}

/** Convierte "Empresa/Ventas" en "OU=Ventas,OU=Empresa,DC=..."; si ya es un DN lo deja igual. */
export function ouPathToDn(path: string, domainDn: string): string {
  if (path.includes('=')) return /DC=/i.test(path) ? path : `${path},${domainDn}`
  return [
    ...path
      .split('/')
      .filter(Boolean)
      .reverse()
      .map((p) => `OU=${p}`),
    domainDn,
  ].join(',')
}

export function store(s: PsSession): AdStore {
  const st = s.data.ad?.[0] as AdStore | undefined
  if (!st) {
    throw new PsError(
      'Unable to contact the server. This may be because this server does not exist, it is currently down, or it does not have the Active Directory Web Services running.',
      'ResourceUnavailable',
      `ActiveDirectoryServer:0,${NS}.Commands.GetADUser`,
    )
  }
  return st
}

export function dnOf(o: PsObject): string {
  const prefix = o.ObjectClass === 'organizationalUnit' ? 'OU' : 'CN'
  return `${prefix}=${toText(o.Name)},${toText(o.__parent)}`
}

function sameDn(a: string, b: string) {
  return a.replace(/\s*,\s*/g, ',').toLowerCase() === b.replace(/\s*,\s*/g, ',').toLowerCase()
}

/** Existe el contenedor (dominio, CN=Users, CN=Computers, una OU...). */
function containerExists(st: AdStore, dn: string): boolean {
  if (sameDn(dn, st.domainDn)) return true
  if (['CN=Users', 'CN=Computers', 'CN=Builtin', 'OU=Domain Controllers'].some((c) => sameDn(dn, `${c},${st.domainDn}`))) return true
  return st.ous.some((o) => sameDn(dnOf(o), dn))
}

function allObjects(st: AdStore): PsObject[] {
  return [...st.users, ...st.groups, ...st.ous, ...st.computers]
}

export function newSid(st: AdStore) {
  return `${DOMAIN_SID}-${st.nextRid++}`
}

// ---------------------------------------------------------------------------------------
// Propiedades que se muestran
// ---------------------------------------------------------------------------------------

const DEFAULTS: Record<string, string[]> = {
  user: ['DistinguishedName', 'Enabled', 'GivenName', 'Name', 'ObjectClass', 'ObjectGUID', 'SamAccountName', 'SID', 'Surname', 'UserPrincipalName'],
  group: ['DistinguishedName', 'GroupCategory', 'GroupScope', 'Name', 'ObjectClass', 'ObjectGUID', 'SamAccountName', 'SID'],
  organizationalUnit: ['City', 'Country', 'DistinguishedName', 'LinkedGroupPolicyObjects', 'ManagedBy', 'Name', 'ObjectClass', 'ObjectGUID', 'PostalCode', 'State', 'StreetAddress'],
  computer: ['DistinguishedName', 'DNSHostName', 'Enabled', 'Name', 'ObjectClass', 'ObjectGUID', 'SamAccountName', 'SID', 'UserPrincipalName'],
}

const EXTENDED: Record<string, string[]> = {
  user: ['CanonicalName', 'City', 'Company', 'Created', 'Department', 'Description', 'DisplayName', 'EmailAddress', 'LastLogonDate', 'LockedOut', 'MemberOf', 'Modified', 'Office', 'PasswordLastSet', 'PasswordNeverExpires', 'Title'],
  group: ['CanonicalName', 'Created', 'Description', 'ManagedBy', 'Members', 'MemberOf', 'Modified'],
  organizationalUnit: ['CanonicalName', 'Created', 'Description', 'Modified', 'ProtectedFromAccidentalDeletion'],
  computer: ['CanonicalName', 'Created', 'Description', 'IPv4Address', 'LastLogonDate', 'Modified', 'OperatingSystem', 'OperatingSystemVersion'],
}

const TYPE_BY_CLASS: Record<string, string> = {
  user: `${NS}.ADUser`,
  group: `${NS}.ADGroup`,
  organizationalUnit: `${NS}.ADOrganizationalUnit`,
  computer: `${NS}.ADComputer`,
}

function canonicalName(st: AdStore, dn: string): string {
  const parts = dn.split(',')
  const rdns = parts.filter((p) => !/^DC=/i.test(p)).map((p) => p.split('=')[1])
  return `${st.domain}/${rdns.reverse().join('/')}`
}

function computed(st: AdStore, o: PsObject, prop: string): unknown {
  const dn = dnOf(o)
  switch (prop) {
    case 'DistinguishedName':
      return dn
    case 'CanonicalName':
      return canonicalName(st, dn)
    case 'MemberOf':
      return st.groups.filter((g) => asArray(g.__members).some((m) => sameIdentity(st, toText(m), o))).map(dnOf)
    case 'Members':
      return asArray(o.__members)
        .map((m) => resolveAny(st, toText(m)))
        .filter((x): x is PsObject => !!x)
        .map(dnOf)
    case 'LinkedGroupPolicyObjects':
      return []
    case 'City':
    case 'Country':
    case 'ManagedBy':
    case 'PostalCode':
    case 'State':
    case 'StreetAddress':
      return o[prop] ?? null
  }
  return getProp(o, prop)
}

/** Objeto que devuelve un cmdlet Get-AD*: propiedades por defecto + las pedidas con -Properties. */
export function present(st: AdStore, o: PsObject, requested: unknown[] = []): PsObject {
  const cls = toText(o.ObjectClass)
  const names = new Set(DEFAULTS[cls] ?? [])
  for (const r of requested.map(toText)) {
    if (r === '*') for (const e of EXTENDED[cls] ?? []) names.add(e)
    else {
      const known = [...(EXTENDED[cls] ?? []), ...Object.keys(o)].find((k) => k.toLowerCase() === r.toLowerCase())
      names.add(known ?? r)
    }
  }
  const props: Record<string, unknown> = {}
  for (const n of [...names].sort((a, b) => a.localeCompare(b))) props[n] = computed(st, o, n)
  return psObject(TYPE_BY_CLASS[cls] ?? `${NS}.ADObject`, { ...props, __toString: dnOf(o) })
}

// ---------------------------------------------------------------------------------------
// Búsqueda por identidad y por filtro
// ---------------------------------------------------------------------------------------

function identityText(id: unknown): string {
  if (isPsObject(id)) return toText(getProp(id, 'SamAccountName') ?? getProp(id, 'DistinguishedName') ?? getProp(id, 'Name'))
  return toText(id)
}

function sameIdentity(_st: AdStore, id: string, o: PsObject): boolean {
  const lower = id.toLowerCase()
  return (
    toText(o.SamAccountName).toLowerCase() === lower ||
    toText(o.SamAccountName).toLowerCase() === `${lower}$` ||
    sameDn(dnOf(o), id) ||
    toText(o.ObjectGUID).toLowerCase() === lower ||
    toText(o.SID).toLowerCase() === lower
  )
}

function resolveAny(st: AdStore, id: string): PsObject | undefined {
  return allObjects(st).find((o) => sameIdentity(st, id, o))
}

function notFound(st: AdStore, id: string, cmd: string): PsError {
  return new PsError(`Cannot find an object with identity: '${id}' under: '${st.domainDn}'.`, 'ObjectNotFound', `ActiveDirectoryCmdlet:${NS}.ADIdentityNotFoundException,${NS}.Commands.${cmd}`, id)
}

function resolve(st: AdStore, list: PsObject[], idValue: unknown, cmd: string): PsObject {
  const id = identityText(idValue)
  const found = list.find((o) => sameIdentity(st, id, o))
  if (!found) throw notFound(st, id, cmd)
  return found
}

type Tok = { t: 'id' | 'op' | 'str' | 'num' | 'var' | 'lp' | 'rp'; v: string }

function tokenizeFilter(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '(' || c === ')') {
      out.push({ t: c === '(' ? 'lp' : 'rp', v: c })
      i++
      continue
    }
    if (c === "'" || c === '"') {
      let j = i + 1
      let v = ''
      while (j < src.length && src[j] !== c) v += src[j++]
      if (j >= src.length) throw new Error(`comilla sin cerrar en la posición ${i + 1}`)
      out.push({ t: 'str', v })
      i = j + 1
      continue
    }
    const m = /^-[A-Za-z]+/.exec(src.slice(i)) ?? /^\$[A-Za-z_][\w.]*/.exec(src.slice(i)) ?? /^\d+(\.\d+)?/.exec(src.slice(i)) ?? /^[A-Za-z_*][\w*.-]*/.exec(src.slice(i))
    if (!m) throw new Error(`carácter inesperado '${c}' en la posición ${i + 1}`)
    const v = m[0]
    out.push({ t: v.startsWith('-') ? 'op' : v.startsWith('$') ? 'var' : /^\d/.test(v) ? 'num' : 'id', v })
    i += v.length
  }
  return out
}

type Pred = (o: PsObject) => boolean

function compileFilter(st: AdStore, s: PsSession, src: string): Pred {
  if (src.trim() === '*') return () => true
  const toks = tokenizeFilter(src)
  let pos = 0
  const peek = () => toks[pos]
  const expect = (t: Tok['t']) => {
    const tok = toks[pos++]
    if (!tok || tok.t !== t) throw new Error(`se esperaba ${t === 'rp' ? "')'" : 'un valor'} en la posición ${pos}`)
    return tok
  }
  const value = (): unknown => {
    const tok = toks[pos++]
    if (!tok) throw new Error('falta el valor a comparar')
    if (tok.t === 'str' || tok.t === 'id') return tok.v
    if (tok.t === 'num') return Number(tok.v)
    if (tok.t === 'var') {
      const [name, ...props] = tok.v.slice(1).split('.')
      let v = s.getVar(name)
      for (const p of props) v = getProp(v, p)
      return v
    }
    throw new Error(`valor inesperado '${tok.v}'`)
  }
  const comparison = (): Pred => {
    const prop = expect('id').v
    const opTok = toks[pos++]
    if (!opTok || opTok.t !== 'op') throw new Error(`se esperaba un operador después de '${prop}'`)
    const op = opTok.v.slice(1).toLowerCase()
    const v = value()
    const valid = ['eq', 'ne', 'like', 'notlike', 'gt', 'ge', 'lt', 'le', 'approx', 'bor', 'band', 'recursivematch']
    if (!valid.includes(op)) throw new Error(`operador no admitido '-${op}' (en filtros de AD no existen -match ni -contains)`)
    return (o) => {
      const actual = computed(st, o, Object.keys(o).find((k) => k.toLowerCase() === prop.toLowerCase()) ?? prop)
      const values = Array.isArray(actual) ? actual : [actual]
      return values.some((a) => {
        if (a instanceof Date || v instanceof Date) {
          const x = a instanceof Date ? a.getTime() : NaN
          const y = v instanceof Date ? v.getTime() : new Date(toText(v)).getTime()
          if (Number.isNaN(x)) return op === 'ne'
          return op === 'lt' ? x < y : op === 'le' ? x <= y : op === 'gt' ? x > y : op === 'ge' ? x >= y : op === 'eq' ? x === y : x !== y
        }
        if (typeof a === 'boolean') {
          const b = typeof v === 'boolean' ? v : toText(v).toLowerCase() === 'true'
          return op === 'ne' ? a !== b : a === b
        }
        const at = toText(a)
        const vt = toText(v)
        switch (op) {
          case 'eq':
          case 'approx':
            return at.toLowerCase() === vt.toLowerCase() || (vt.includes('*') && wildcardToRegex(vt).test(at))
          case 'ne':
            return at.toLowerCase() !== vt.toLowerCase()
          case 'like':
            return wildcardToRegex(vt).test(at)
          case 'notlike':
            return !wildcardToRegex(vt).test(at)
          default: {
            const na = Number(a)
            const nv = Number(v)
            const [x, y] = Number.isNaN(na) || Number.isNaN(nv) ? [at.toLowerCase(), vt.toLowerCase()] : [na, nv]
            return op === 'gt' ? x > y : op === 'ge' ? x >= y : op === 'lt' ? x < y : x <= y
          }
        }
      })
    }
  }
  const factor = (): Pred => {
    const tok = peek()
    if (tok?.t === 'op' && tok.v.toLowerCase() === '-not') {
      pos++
      const inner = factor()
      return (o) => !inner(o)
    }
    if (tok?.t === 'lp') {
      pos++
      const inner = expr()
      expect('rp')
      return inner
    }
    return comparison()
  }
  const term = (): Pred => {
    let left = factor()
    while (peek()?.t === 'op' && peek().v.toLowerCase() === '-and') {
      pos++
      const l = left
      const r = factor()
      left = (o) => l(o) && r(o)
    }
    return left
  }
  const expr = (): Pred => {
    let left = term()
    while (peek()?.t === 'op' && peek().v.toLowerCase() === '-or') {
      pos++
      const l = left
      const r = term()
      left = (o) => l(o) || r(o)
    }
    return left
  }
  const pred = expr()
  if (pos < toks.length) throw new Error(`sobra '${toks[pos].v}' en la posición ${pos + 1}`)
  return pred
}

/** Filtro LDAP básico: (attr=valor), (&...), (|...), (!...). */
function compileLdap(st: AdStore, src: string): Pred {
  let pos = 0
  const parse = (): Pred => {
    if (src[pos] !== '(') throw new Error(`se esperaba '(' en la posición ${pos + 1}`)
    pos++
    const op = src[pos]
    if (op === '&' || op === '|') {
      pos++
      const parts: Pred[] = []
      while (src[pos] === '(') parts.push(parse())
      pos++
      return op === '&' ? (o) => parts.every((p) => p(o)) : (o) => parts.some((p) => p(o))
    }
    if (op === '!') {
      pos++
      const inner = parse()
      pos++
      return (o) => !inner(o)
    }
    const end = src.indexOf(')', pos)
    const [attr, val] = src.slice(pos, end).split('=')
    pos = end + 1
    const map: Record<string, string> = { samaccountname: 'SamAccountName', cn: 'Name', name: 'Name', department: 'Department', givenname: 'GivenName', sn: 'Surname', title: 'Title', objectclass: 'ObjectClass', mail: 'EmailAddress', description: 'Description' }
    const prop = map[attr.toLowerCase()] ?? attr
    return (o) => wildcardToRegex(val).test(toText(computed(st, o, prop)))
  }
  return parse()
}

function filterError(src: string, msg: string, cmd: string) {
  return new PsError(`Error parsing query: '${src}' Error Message: '${msg}'.`, 'ParserError', `ActiveDirectoryCmdlet:${NS}.ADFilterParsingException,${NS}.Commands.${cmd}`, src)
}

function search(ctx: CmdletContext, list: PsObject[], cmd: string, noun: string): PsObject[] {
  const st = store(ctx.s)
  const props = asArray(ctx.params.get('properties'))
  if (ctx.params.has('identity')) return [present(st, resolve(st, list, ctx.params.get('identity'), cmd), props)]
  if (!ctx.params.has('filter') && !ctx.params.has('ldapfilter')) {
    if (ctx.input.length) return ctx.input.map((i) => present(st, resolve(st, list, i, cmd), props))
    ctx.host(`\ncmdlet ${noun} at command pipeline position 1\nSupply values for the following parameters:\n(Type !? for Help.)\nFilter: \n[simulador] -Filter es obligatorio cuando no se indica -Identity. Usar -Filter * para traer todos, o -Identity <nombre> para uno solo.\n`)
    return []
  }
  let pred: Pred
  const raw = ctx.params.get('filter')
  const src = ctx.params.has('ldapfilter') ? toText(ctx.params.get('ldapfilter')) : toText(raw)
  try {
    pred = ctx.params.has('ldapfilter') ? compileLdap(st, src) : compileFilter(st, ctx.s, src)
  } catch (e) {
    throw filterError(src, (e as Error).message, cmd)
  }
  const base = ctx.params.has('searchbase') ? toText(ctx.params.get('searchbase')) : undefined
  const scope = toText(ctx.params.get('searchscope') ?? 'Subtree').toLowerCase()
  if (base && !containerExists(st, base)) throw new PsError('Directory object not found', 'ObjectNotFound', `ActiveDirectoryCmdlet:${NS}.ADIdentityNotFoundException,${NS}.Commands.${cmd}`, base)
  return list
    .filter((o) => {
      if (!base) return true
      const parent = toText(o.__parent)
      if (scope === 'onelevel') return sameDn(parent, base)
      if (scope === 'base') return sameDn(dnOf(o), base)
      return sameDn(parent, base) || parent.toLowerCase().endsWith(`,${base.toLowerCase()}`) || sameDn(dnOf(o), base)
    })
    .filter(pred)
    .map((o) => present(st, o, props))
}

/** Registra un cmdlet del módulo ActiveDirectory (solo existe si el ejercicio define un dominio). */
function adCmdlet(name: string, def: CmdletDef) {
  cmdlet(name, {
    ...def,
    module: AD_MODULE,
    run(ctx) {
      if (!ctx.s.data.ad?.length) {
        throw new PsError(
          `The term '${name}' is not recognized as the name of a cmdlet, function, script file, or operable program. Check the spelling of the name, or if a path was included, verify that the path is correct and try again.`,
          'ObjectNotFound',
          'CommandNotFoundException',
          name,
        )
      }
      return def.run(ctx)
    },
  })
}

const SEARCH_PARAMS = ['Identity', 'Filter', 'LDAPFilter', 'Properties', 'SearchBase', 'SearchScope', 'Server', 'ResultSetSize']

function str(ctx: CmdletContext, name: string): string | undefined {
  const v = ctx.params.get(name.toLowerCase())
  return v === undefined || v === null ? undefined : toText(v)
}

function isSecure(v: unknown): boolean {
  return isPsObject(v) && v.__type === 'System.Security.SecureString'
}

function secureError(param: string, v: unknown) {
  return new PsError(
    `Cannot bind parameter '${param}'. Cannot convert the "${toText(v)}" value of type "System.String" to type "System.Security.SecureString".`,
    'InvalidArgument',
    `CannotConvertArgumentNoMessage,${NS}.Commands.NewADUser`,
  )
}

function confirmPrompt(ctx: CmdletContext, op: string, target: string): boolean {
  const c = ctx.params.get('confirm')
  if (c === false) return true
  ctx.host(`\nConfirm\nAre you sure you want to perform this action?\nPerforming the operation "${op}" on target "${target}".\n[Y] Yes  [A] Yes to All  [N] No  [L] No to All  [S] Suspend  [?] Help (default is "Y"): Y\n`)
  return true
}

function stamp(o: PsObject) {
  o.Modified = new Date()
}

// ---------------------------------------------------------------------------------------
// Usuarios
// ---------------------------------------------------------------------------------------

adCmdlet('Get-ADUser', {
  params: SEARCH_PARAMS,
  positional: ['Identity'],
  synopsis: 'Gets one or more Active Directory users.',
  run: (ctx) => search(ctx, store(ctx.s).users, 'GetADUser', 'Get-ADUser'),
})

adCmdlet('New-ADUser', {
  params: ['Name', 'SamAccountName', 'GivenName', 'Surname', 'DisplayName', 'UserPrincipalName', 'Path', 'AccountPassword', 'Enabled', 'Department', 'Title', 'Description', 'EmailAddress', 'Office', 'City', 'Company', 'ChangePasswordAtLogon', 'PasswordNeverExpires', 'OtherAttributes'],
  switches: ['PassThru'],
  positional: ['Name'],
  synopsis: 'Creates an Active Directory user.',
  run(ctx) {
    const st = store(ctx.s)
    const name = str(ctx, 'Name')
    if (!name) throw new PsError("Cannot validate argument on parameter 'Name'. The argument is null or empty.", 'InvalidData', `ParameterArgumentValidationError,${NS}.Commands.NewADUser`)
    const path = str(ctx, 'Path') ?? `CN=Users,${st.domainDn}`
    if (!containerExists(st, path)) throw new PsError('Directory object not found', 'ObjectNotFound', `ActiveDirectoryCmdlet:${NS}.ADIdentityNotFoundException,${NS}.Commands.NewADUser`, path)
    const sam = str(ctx, 'SamAccountName') ?? `$${stableGuid(name).replace(/-/g, '').slice(0, 6).toUpperCase()}-${stableGuid(name + 'x').replace(/-/g, '').slice(0, 12).toUpperCase()}`
    if (sam.length > 20) throw new PsError('The name provided is not a properly formed account name', 'NotSpecified', `ActiveDirectoryServer:1315,${NS}.Commands.NewADUser`, name)
    if (st.users.some((u) => toText(u.SamAccountName).toLowerCase() === sam.toLowerCase()) || allObjects(st).some((o) => sameDn(dnOf(o), `CN=${name},${path}`))) {
      throw new PsError('The specified account already exists', 'ResourceExists', `ActiveDirectoryServer:1316,${NS}.Commands.NewADUser`, `CN=${name},${path}`)
    }
    const pwd = ctx.params.get('accountpassword')
    if (pwd !== undefined && !isSecure(pwd)) throw secureError('AccountPassword', pwd)
    const enabled = ctx.params.get('enabled') === true || toText(ctx.params.get('enabled')).toLowerCase() === 'true'
    if (enabled && pwd === undefined) {
      throw new PsError('Unable to update the password. The value provided for the new password does not meet the length, complexity, or history requirements of the domain.', 'InvalidData', `ActiveDirectoryServer:1325,${NS}.Commands.NewADUser`, `CN=${name},${path}`)
    }
    const now = new Date()
    const u = psObject(`${NS}.ADUser`, {
      Name: name,
      SamAccountName: sam,
      GivenName: str(ctx, 'GivenName') ?? null,
      Surname: str(ctx, 'Surname') ?? null,
      DisplayName: str(ctx, 'DisplayName') ?? null,
      UserPrincipalName: str(ctx, 'UserPrincipalName') ?? null,
      Enabled: enabled,
      Department: str(ctx, 'Department') ?? null,
      Title: str(ctx, 'Title') ?? null,
      Description: str(ctx, 'Description') ?? null,
      EmailAddress: str(ctx, 'EmailAddress') ?? null,
      Office: str(ctx, 'Office') ?? null,
      City: str(ctx, 'City') ?? null,
      Company: str(ctx, 'Company') ?? null,
      LastLogonDate: null,
      LockedOut: false,
      PasswordNeverExpires: ctx.params.get('passwordneverexpires') === true,
      PasswordLastSet: pwd !== undefined && ctx.params.get('changepasswordatlogon') !== true ? now : null,
      ObjectClass: 'user',
      ObjectGUID: stableGuid(`user:${sam}`),
      SID: newSid(st),
      Created: now,
      Modified: now,
      __parent: path,
      __noPassword: pwd === undefined,
    })
    st.users.push(u)
    return ctx.params.get('passthru') ? [present(st, u)] : []
  },
})

const SETTABLE_USER = ['GivenName', 'Surname', 'DisplayName', 'UserPrincipalName', 'Department', 'Title', 'Description', 'EmailAddress', 'Office', 'City', 'Company', 'Enabled', 'PasswordNeverExpires']

adCmdlet('Set-ADUser', {
  params: ['Identity', ...SETTABLE_USER, 'ChangePasswordAtLogon', 'Replace', 'Add', 'Clear', 'SamAccountName'],
  switches: ['PassThru'],
  positional: ['Identity'],
  synopsis: 'Modifies an Active Directory user.',
  run(ctx) {
    const st = store(ctx.s)
    const targets = ctx.params.has('identity') ? [ctx.params.get('identity')] : ctx.input
    const out: PsObject[] = []
    for (const t of targets) {
      const u = resolve(st, st.users, t, 'SetADUser')
      for (const p of [...SETTABLE_USER, 'SamAccountName']) {
        if (ctx.params.has(p.toLowerCase())) {
          const v = ctx.params.get(p.toLowerCase())
          u[p] = p === 'Enabled' || p === 'PasswordNeverExpires' ? v === true || toText(v).toLowerCase() === 'true' : v === null ? null : toText(v)
        }
      }
      if (ctx.params.get('changepasswordatlogon') === true) u.PasswordLastSet = null
      const replace = ctx.params.get('replace')
      if (replace instanceof Map) {
        const ldapMap: Record<string, string> = { department: 'Department', title: 'Title', description: 'Description', mail: 'EmailAddress', physicaldeliveryofficename: 'Office', l: 'City', company: 'Company', givenname: 'GivenName', sn: 'Surname', displayname: 'DisplayName' }
        for (const [k, v] of replace) u[ldapMap[String(k).toLowerCase()] ?? String(k)] = toText(v)
      }
      for (const c of asArray(ctx.params.get('clear'))) {
        const key = Object.keys(u).find((k) => k.toLowerCase() === toText(c).toLowerCase())
        if (key) u[key] = null
      }
      stamp(u)
      if (ctx.params.get('passthru')) out.push(present(st, u))
    }
    return out
  },
})

adCmdlet('Remove-ADUser', {
  params: ['Identity', 'Confirm'],
  positional: ['Identity'],
  synopsis: 'Removes an Active Directory user.',
  run(ctx) {
    const st = store(ctx.s)
    const targets = ctx.params.has('identity') ? [ctx.params.get('identity')] : ctx.input
    for (const t of targets) {
      const u = resolve(st, st.users, t, 'RemoveADUser')
      if (!confirmPrompt(ctx, 'Remove', dnOf(u))) continue
      st.users.splice(st.users.indexOf(u), 1)
      for (const g of st.groups) g.__members = asArray(g.__members).filter((m) => !sameIdentity(st, toText(m), u))
    }
    return []
  },
})

for (const [verb, enabled] of [
  ['Enable', true],
  ['Disable', false],
] as const) {
  adCmdlet(`${verb}-ADAccount`, {
    params: ['Identity'],
    switches: ['PassThru'],
    positional: ['Identity'],
    synopsis: `${verb}s an Active Directory account.`,
    run(ctx) {
      const st = store(ctx.s)
      const targets = ctx.params.has('identity') ? [ctx.params.get('identity')] : ctx.input
      const out: PsObject[] = []
      for (const t of targets) {
        const o = resolve(st, [...st.users, ...st.computers], t, `${verb}ADAccount`)
        if (enabled && o.__noPassword === true) {
          throw new PsError('Unable to update the password. The value provided for the new password does not meet the length, complexity, or history requirements of the domain.', 'InvalidData', `ActiveDirectoryServer:1325,${NS}.Commands.EnableADAccount`)
        }
        o.Enabled = enabled
        stamp(o)
        if (ctx.params.get('passthru')) out.push(present(st, o))
      }
      return out
    },
  })
}

adCmdlet('Unlock-ADAccount', {
  params: ['Identity'],
  switches: ['PassThru'],
  positional: ['Identity'],
  synopsis: 'Unlocks an Active Directory account.',
  run(ctx) {
    const st = store(ctx.s)
    const targets = ctx.params.has('identity') ? [ctx.params.get('identity')] : ctx.input
    for (const t of targets) {
      const u = resolve(st, st.users, t, 'UnlockADAccount')
      u.LockedOut = false
      stamp(u)
    }
    return []
  },
})

adCmdlet('Set-ADAccountPassword', {
  params: ['Identity', 'NewPassword', 'OldPassword'],
  switches: ['Reset', 'PassThru'],
  positional: ['Identity'],
  synopsis: 'Modifies the password of an Active Directory account.',
  run(ctx) {
    const st = store(ctx.s)
    const u = resolve(st, st.users, ctx.params.get('identity') ?? ctx.input[0], 'SetADAccountPassword')
    const pwd = ctx.params.get('newpassword')
    if (pwd === undefined) {
      ctx.host('\n[simulador] Sin -NewPassword, PowerShell pide la contraseña nueva de forma interactiva. Lo habitual en scripts es: -NewPassword (Read-Host -AsSecureString "Contraseña")\n')
      return []
    }
    if (!isSecure(pwd)) throw secureError('NewPassword', pwd)
    if (!ctx.params.get('reset') && !ctx.params.has('oldpassword')) {
      ctx.host('\n[simulador] Sin -Reset hay que indicar la contraseña anterior (-OldPassword). Como administrador se usa -Reset.\n')
      return []
    }
    u.PasswordLastSet = new Date()
    u.__noPassword = false
    stamp(u)
    return []
  },
})

adCmdlet('Search-ADAccount', {
  params: ['TimeSpan', 'SearchBase', 'DateTime'],
  switches: ['AccountDisabled', 'AccountExpired', 'AccountExpiring', 'AccountInactive', 'LockedOut', 'PasswordExpired', 'PasswordNeverExpires', 'UsersOnly', 'ComputersOnly'],
  synopsis: 'Gets Active Directory user, computer, or service accounts.',
  run(ctx) {
    const st = store(ctx.s)
    let list = ctx.params.get('computersonly') ? st.computers : ctx.params.get('usersonly') ? st.users : [...st.users, ...st.computers]
    if (ctx.params.get('accountdisabled')) list = list.filter((o) => !o.Enabled)
    if (ctx.params.get('lockedout')) list = list.filter((o) => o.LockedOut === true)
    if (ctx.params.get('passwordneverexpires')) list = list.filter((o) => o.PasswordNeverExpires === true)
    if (ctx.params.get('accountinactive')) {
      const span = toText(ctx.params.get('timespan') ?? '15')
      const days = Number(/^(\d+)/.exec(span)?.[1] ?? 15)
      const limit = Date.now() - days * 86_400_000
      list = list.filter((o) => !(o.LastLogonDate instanceof Date) || o.LastLogonDate.getTime() < limit)
    }
    const base = str(ctx, 'SearchBase')
    if (base) list = list.filter((o) => toText(o.__parent).toLowerCase().endsWith(base.toLowerCase()))
    return list.map((o) =>
      psObject(`${NS}.ADAccount`, {
        DistinguishedName: dnOf(o),
        Enabled: o.Enabled,
        LastLogonDate: o.LastLogonDate ?? null,
        LockedOut: o.LockedOut ?? false,
        Name: o.Name,
        ObjectClass: o.ObjectClass,
        ObjectGUID: o.ObjectGUID,
        PasswordExpired: false,
        PasswordNeverExpires: o.PasswordNeverExpires ?? false,
        SamAccountName: o.SamAccountName,
        SID: o.SID,
        UserPrincipalName: o.UserPrincipalName ?? null,
        __toString: dnOf(o),
      }),
    )
  },
})

// ---------------------------------------------------------------------------------------
// Grupos
// ---------------------------------------------------------------------------------------

adCmdlet('Get-ADGroup', {
  params: SEARCH_PARAMS,
  positional: ['Identity'],
  synopsis: 'Gets one or more Active Directory groups.',
  run: (ctx) => search(ctx, store(ctx.s).groups, 'GetADGroup', 'Get-ADGroup'),
})

adCmdlet('New-ADGroup', {
  params: ['Name', 'SamAccountName', 'GroupScope', 'GroupCategory', 'Path', 'Description', 'DisplayName', 'ManagedBy'],
  switches: ['PassThru'],
  positional: ['Name', 'GroupScope'],
  synopsis: 'Creates an Active Directory group.',
  run(ctx) {
    const st = store(ctx.s)
    const name = str(ctx, 'Name')!
    const scopeRaw = str(ctx, 'GroupScope')
    if (!scopeRaw) {
      ctx.host(`\ncmdlet New-ADGroup at command pipeline position 1\nSupply values for the following parameters:\nGroupScope: \n[simulador] -GroupScope es obligatorio: DomainLocal, Global o Universal.\n`)
      return []
    }
    const scope = ['DomainLocal', 'Global', 'Universal'].find((x) => x.toLowerCase() === scopeRaw.toLowerCase() || String(['DomainLocal', 'Global', 'Universal'].indexOf(x)) === scopeRaw)
    if (!scope) throw new PsError(`Cannot bind parameter 'GroupScope'. Cannot convert value "${scopeRaw}" to type "${NS}.ADGroupScope". Error: "Unable to match the identifier name ${scopeRaw} to a valid enumerator name. Specify one of the following enumerator names and try again: DomainLocal, Global, Universal"`, 'InvalidArgument', `CannotConvertArgumentNoMessage,${NS}.Commands.NewADGroup`)
    const catRaw = str(ctx, 'GroupCategory') ?? 'Security'
    const category = ['Distribution', 'Security'].find((x) => x.toLowerCase() === catRaw.toLowerCase())
    if (!category) throw new PsError(`Cannot bind parameter 'GroupCategory'. Cannot convert value "${catRaw}" to type "${NS}.ADGroupCategory".`, 'InvalidArgument', `CannotConvertArgumentNoMessage,${NS}.Commands.NewADGroup`)
    const path = str(ctx, 'Path') ?? `CN=Users,${st.domainDn}`
    if (!containerExists(st, path)) throw new PsError('Directory object not found', 'ObjectNotFound', `ActiveDirectoryCmdlet:${NS}.ADIdentityNotFoundException,${NS}.Commands.NewADGroup`, path)
    const sam = str(ctx, 'SamAccountName') ?? name
    if (allObjects(st).some((o) => toText(o.SamAccountName).toLowerCase() === sam.toLowerCase() || sameDn(dnOf(o), `CN=${name},${path}`))) {
      throw new PsError('The specified group already exists', 'ResourceExists', `ActiveDirectoryServer:1318,${NS}.Commands.NewADGroup`, `CN=${name},${path}`)
    }
    const now = new Date()
    const g = psObject(`${NS}.ADGroup`, { Name: name, SamAccountName: sam, GroupScope: scope, GroupCategory: category, Description: str(ctx, 'Description') ?? null, ObjectClass: 'group', ObjectGUID: stableGuid(`group:${sam}`), SID: newSid(st), Created: now, Modified: now, __parent: path, __members: [] })
    st.groups.push(g)
    return ctx.params.get('passthru') ? [present(st, g)] : []
  },
})

adCmdlet('Remove-ADGroup', {
  params: ['Identity', 'Confirm'],
  positional: ['Identity'],
  synopsis: 'Removes an Active Directory group.',
  run(ctx) {
    const st = store(ctx.s)
    const g = resolve(st, st.groups, ctx.params.get('identity') ?? ctx.input[0], 'RemoveADGroup')
    if (confirmPrompt(ctx, 'Remove', dnOf(g))) st.groups.splice(st.groups.indexOf(g), 1)
    return []
  },
})

function memberChange(ctx: CmdletContext, add: boolean, cmd: string) {
  const st = store(ctx.s)
  const g = resolve(st, st.groups, ctx.params.get('identity') ?? ctx.input[0], cmd)
  const members = asArray(ctx.params.get('members') ?? (ctx.params.has('identity') ? ctx.input : []))
  if (!members.length) {
    ctx.host(`\ncmdlet ${add ? 'Add' : 'Remove'}-ADGroupMember at command pipeline position 1\nSupply values for the following parameters:\nMembers[0]: \n[simulador] Indicar los miembros con -Members usuario1,usuario2\n`)
    return []
  }
  const current = asArray(g.__members).map(toText)
  for (const m of members) {
    const obj = resolveAny(st, identityText(m))
    if (!obj || obj.ObjectClass === 'organizationalUnit') throw notFound(st, identityText(m), cmd)
    const sam = toText(obj.SamAccountName)
    const idx = current.findIndex((c) => sameIdentity(st, c, obj))
    if (add && idx === -1) current.push(sam)
    if (!add && idx !== -1) {
      if (!confirmPrompt(ctx, 'Set', dnOf(g))) continue
      current.splice(idx, 1)
    }
  }
  g.__members = current
  stamp(g)
  return []
}

adCmdlet('Add-ADGroupMember', { params: ['Identity', 'Members'], switches: ['PassThru'], positional: ['Identity', 'Members'], synopsis: 'Adds one or more members to an Active Directory group.', run: (ctx) => memberChange(ctx, true, 'AddADGroupMember') })
adCmdlet('Remove-ADGroupMember', { params: ['Identity', 'Members', 'Confirm'], switches: ['PassThru'], positional: ['Identity', 'Members'], synopsis: 'Removes one or more members from an Active Directory group.', run: (ctx) => memberChange(ctx, false, 'RemoveADGroupMember') })

function principal(o: PsObject): PsObject {
  return psObject(`${NS}.ADPrincipal`, {
    distinguishedName: dnOf(o),
    name: o.Name,
    objectClass: o.ObjectClass,
    objectGUID: o.ObjectGUID,
    SamAccountName: o.SamAccountName,
    SID: o.SID,
    __toString: dnOf(o),
  })
}

adCmdlet('Get-ADGroupMember', {
  params: ['Identity'],
  switches: ['Recursive'],
  positional: ['Identity'],
  synopsis: 'Gets the members of an Active Directory group.',
  run(ctx) {
    const st = store(ctx.s)
    const g = resolve(st, st.groups, ctx.params.get('identity') ?? ctx.input[0], 'GetADGroupMember')
    const out: PsObject[] = []
    const seen = new Set<PsObject>()
    const walk = (group: PsObject) => {
      for (const m of asArray(group.__members)) {
        const obj = resolveAny(st, toText(m))
        if (!obj || seen.has(obj)) continue
        seen.add(obj)
        if (obj.ObjectClass === 'group' && ctx.params.get('recursive')) walk(obj)
        else out.push(principal(obj))
      }
    }
    walk(g)
    return out
  },
})

adCmdlet('Get-ADPrincipalGroupMembership', {
  params: ['Identity'],
  positional: ['Identity'],
  synopsis: 'Gets the Active Directory groups that have a specified user, computer, group, or service account.',
  run(ctx) {
    const st = store(ctx.s)
    const o = resolve(st, [...st.users, ...st.groups, ...st.computers], ctx.params.get('identity') ?? ctx.input[0], 'GetADPrincipalGroupMembership')
    const groups = st.groups.filter((g) => asArray(g.__members).some((m) => sameIdentity(st, toText(m), o)))
    const primary = st.groups.find((g) => g.Name === (o.ObjectClass === 'computer' ? 'Domain Computers' : 'Domain Users'))
    if (primary && o.ObjectClass === 'user' && !groups.includes(primary)) groups.unshift(primary)
    return groups.map((g) => present(st, g))
  },
})

// ---------------------------------------------------------------------------------------
// Unidades organizativas, equipos y movimientos
// ---------------------------------------------------------------------------------------

adCmdlet('Get-ADOrganizationalUnit', {
  params: SEARCH_PARAMS,
  positional: ['Identity'],
  synopsis: 'Gets one or more Active Directory organizational units.',
  run: (ctx) => search(ctx, store(ctx.s).ous, 'GetADOrganizationalUnit', 'Get-ADOrganizationalUnit'),
})

adCmdlet('New-ADOrganizationalUnit', {
  params: ['Name', 'Path', 'Description', 'ProtectedFromAccidentalDeletion', 'City', 'Country'],
  switches: ['PassThru'],
  positional: ['Name'],
  synopsis: 'Creates an Active Directory organizational unit.',
  run(ctx) {
    const st = store(ctx.s)
    const name = str(ctx, 'Name')!
    const path = str(ctx, 'Path') ?? st.domainDn
    if (!containerExists(st, path)) throw new PsError('Directory object not found', 'ObjectNotFound', `ActiveDirectoryCmdlet:${NS}.ADIdentityNotFoundException,${NS}.Commands.NewADOrganizationalUnit`, path)
    if (allObjects(st).some((o) => sameDn(dnOf(o), `OU=${name},${path}`))) throw new PsError('An attempt was made to add an object to the directory with a name that is already in use', 'NotSpecified', `ActiveDirectoryServer:8305,${NS}.Commands.NewADOrganizationalUnit`, `OU=${name},${path}`)
    const prot = ctx.params.has('protectedfromaccidentaldeletion') ? ctx.params.get('protectedfromaccidentaldeletion') === true || toText(ctx.params.get('protectedfromaccidentaldeletion')).toLowerCase() === 'true' : true
    const now = new Date()
    const ou = psObject(`${NS}.ADOrganizationalUnit`, { Name: name, Description: str(ctx, 'Description') ?? null, ProtectedFromAccidentalDeletion: prot, ObjectClass: 'organizationalUnit', ObjectGUID: stableGuid(`ou:${name},${path}`), City: str(ctx, 'City') ?? null, Country: str(ctx, 'Country') ?? null, Created: now, Modified: now, __parent: path })
    st.ous.push(ou)
    return ctx.params.get('passthru') ? [present(st, ou)] : []
  },
})

adCmdlet('Set-ADOrganizationalUnit', {
  params: ['Identity', 'Description', 'ProtectedFromAccidentalDeletion', 'City', 'Country'],
  positional: ['Identity'],
  synopsis: 'Modifies an Active Directory organizational unit.',
  run(ctx) {
    const st = store(ctx.s)
    const ou = resolve(st, st.ous, ctx.params.get('identity') ?? ctx.input[0], 'SetADOrganizationalUnit')
    if (ctx.params.has('protectedfromaccidentaldeletion')) {
      const v = ctx.params.get('protectedfromaccidentaldeletion')
      ou.ProtectedFromAccidentalDeletion = v === true || toText(v).toLowerCase() === 'true'
    }
    for (const p of ['Description', 'City', 'Country']) if (ctx.params.has(p.toLowerCase())) ou[p] = str(ctx, p) ?? null
    stamp(ou)
    return []
  },
})

adCmdlet('Remove-ADOrganizationalUnit', {
  params: ['Identity', 'Confirm'],
  switches: ['Recursive'],
  positional: ['Identity'],
  synopsis: 'Removes an Active Directory organizational unit.',
  run(ctx) {
    const st = store(ctx.s)
    const ou = resolve(st, st.ous, ctx.params.get('identity') ?? ctx.input[0], 'RemoveADOrganizationalUnit')
    const dn = dnOf(ou)
    if (ou.ProtectedFromAccidentalDeletion) {
      throw new PsError('Access is denied', 'PermissionDenied', `ActiveDirectoryCmdlet:System.UnauthorizedAccessException,${NS}.Commands.RemoveADOrganizationalUnit`, dn)
    }
    const inside = (o: PsObject) => toText(o.__parent).toLowerCase() === dn.toLowerCase() || toText(o.__parent).toLowerCase().endsWith(`,${dn.toLowerCase()}`)
    const children = allObjects(st).filter(inside)
    if (children.length && !ctx.params.get('recursive')) {
      throw new PsError('The directory service can perform the requested operation only on a leaf object.', 'NotSpecified', `ActiveDirectoryServer:8213,${NS}.Commands.RemoveADOrganizationalUnit`, dn)
    }
    if (!confirmPrompt(ctx, 'Remove', dn)) return []
    for (const key of ['users', 'groups', 'ous', 'computers'] as const) st[key] = st[key].filter((o) => o !== ou && !inside(o))
    return []
  },
})

adCmdlet('Get-ADComputer', {
  params: SEARCH_PARAMS,
  positional: ['Identity'],
  synopsis: 'Gets one or more Active Directory computers.',
  run: (ctx) => search(ctx, store(ctx.s).computers, 'GetADComputer', 'Get-ADComputer'),
})

adCmdlet('Move-ADObject', {
  params: ['Identity', 'TargetPath'],
  switches: ['PassThru'],
  positional: ['Identity', 'TargetPath'],
  synopsis: 'Moves an Active Directory object or a container of objects to a different container or domain.',
  run(ctx) {
    const st = store(ctx.s)
    const id = identityText(ctx.params.get('identity') ?? ctx.input[0])
    const o = resolveAny(st, id)
    if (!o) throw notFound(st, id, 'MoveADObject')
    const target = str(ctx, 'TargetPath') ?? ''
    if (!containerExists(st, target)) throw new PsError('Directory object not found', 'ObjectNotFound', `ActiveDirectoryCmdlet:${NS}.ADIdentityNotFoundException,${NS}.Commands.MoveADObject`, target)
    if (o.ObjectClass === 'organizationalUnit' && o.ProtectedFromAccidentalDeletion) {
      throw new PsError('Access is denied', 'PermissionDenied', `ActiveDirectoryCmdlet:System.UnauthorizedAccessException,${NS}.Commands.MoveADObject`, dnOf(o))
    }
    o.__parent = target
    stamp(o)
    return ctx.params.get('passthru') ? [present(st, o)] : []
  },
})

adCmdlet('Get-ADDomain', {
  params: ['Identity'],
  synopsis: 'Gets an Active Directory domain.',
  run(ctx) {
    const st = store(ctx.s)
    const dc = `${ctx.s.state.equipo}.${st.domain}`
    return [
      psObject(`${NS}.ADDomain`, {
        ComputersContainer: `CN=Computers,${st.domainDn}`,
        DistinguishedName: st.domainDn,
        DNSRoot: st.domain,
        DomainControllersContainer: `OU=Domain Controllers,${st.domainDn}`,
        DomainMode: 'Windows2016Domain',
        DomainSID: DOMAIN_SID,
        Forest: st.domain,
        InfrastructureMaster: dc,
        Name: st.domain.split('.')[0],
        NetBIOSName: st.netbios,
        PDCEmulator: dc,
        RIDMaster: dc,
        UsersContainer: `CN=Users,${st.domainDn}`,
        __toString: st.domainDn,
      }),
    ]
  },
})

adCmdlet('Get-ADDefaultDomainPasswordPolicy', {
  params: ['Identity'],
  synopsis: 'Gets the default password policy for an Active Directory domain.',
  run(ctx) {
    const st = store(ctx.s)
    return [
      psObject(`${NS}.ADDefaultDomainPasswordPolicy`, {
        ComplexityEnabled: true,
        DistinguishedName: st.domainDn,
        LockoutDuration: '00:10:00',
        LockoutObservationWindow: '00:10:00',
        LockoutThreshold: 0,
        MaxPasswordAge: '42.00:00:00',
        MinPasswordAge: '1.00:00:00',
        MinPasswordLength: 7,
        PasswordHistoryCount: 24,
        ReversibleEncryptionEnabled: false,
      }),
    ]
  },
})

/** Crea el dominio simulado a partir del estado del ejercicio. */
export function buildAdStore(s: PsSession): AdStore | undefined {
  const ad = s.state.ad
  if (!ad) return undefined
  const domain = s.state.dominio ?? 'empresa.local'
  const domainDn = domainToDn(domain)
  const st: AdStore = { domain, domainDn, netbios: domain.split('.')[0].toUpperCase(), users: [], groups: [], ous: [], computers: [], nextRid: 1103 }
  const created = new Date(Date.now() - 180 * 86_400_000)
  const usersCn = `CN=Users,${domainDn}`

  const ensureOu = (path: string): string => {
    const dn = ouPathToDn(path, domainDn)
    const parts = dn.split(',')
    for (let i = parts.length - 1; i >= 0; i--) {
      if (!/^OU=/i.test(parts[i])) continue
      const ouDn = parts.slice(i).join(',')
      if (!st.ous.some((o) => sameDn(dnOf(o), ouDn))) {
        st.ous.push(psObject(`${NS}.ADOrganizationalUnit`, { Name: parts[i].slice(3), Description: null, ProtectedFromAccidentalDeletion: true, ObjectClass: 'organizationalUnit', ObjectGUID: stableGuid(`ou:${ouDn}`), Created: created, Modified: created, __parent: parts.slice(i + 1).join(',') }))
      }
    }
    return dn
  }
  st.ous.push(psObject(`${NS}.ADOrganizationalUnit`, { Name: 'Domain Controllers', Description: 'Default container for domain controllers', ProtectedFromAccidentalDeletion: true, ObjectClass: 'organizationalUnit', ObjectGUID: stableGuid('ou:dc'), Created: created, Modified: created, __parent: domainDn }))
  for (const ou of ad.ous) ensureOu(ou)

  const builtinUser = (sam: string, enabled: boolean, rid: number, description: string) =>
    psObject(`${NS}.ADUser`, { Name: sam, SamAccountName: sam, GivenName: null, Surname: null, DisplayName: null, UserPrincipalName: null, Enabled: enabled, Department: null, Title: null, Description: description, EmailAddress: null, Office: null, City: null, Company: null, LastLogonDate: enabled ? new Date() : null, LockedOut: false, PasswordNeverExpires: sam !== 'krbtgt', PasswordLastSet: created, ObjectClass: 'user', ObjectGUID: stableGuid(`user:${sam}`), SID: `${DOMAIN_SID}-${rid}`, Created: created, Modified: created, __parent: usersCn })
  st.users.push(builtinUser(s.state.usuario, true, 500, 'Built-in account for administering the computer/domain'))
  st.users.push(builtinUser('Guest', false, 501, 'Built-in account for guest access to the computer/domain'))
  st.users.push(builtinUser('krbtgt', false, 502, 'Key Distribution Center Service Account'))

  for (const u of ad.usuarios) {
    const name = [u.nombre, u.apellido].filter(Boolean).join(' ')
    const last = u.ultimo_inicio ? new Date(u.ultimo_inicio) : u.habilitado ? new Date(Date.now() - 2 * 86_400_000) : null
    st.users.push(
      psObject(`${NS}.ADUser`, {
        Name: name,
        SamAccountName: u.sam,
        GivenName: u.nombre,
        Surname: u.apellido ?? null,
        DisplayName: name,
        UserPrincipalName: `${u.sam}@${domain}`,
        Enabled: u.habilitado,
        Department: u.departamento ?? null,
        Title: null,
        Description: null,
        EmailAddress: null,
        Office: null,
        City: null,
        Company: null,
        LastLogonDate: last,
        LockedOut: u.bloqueado,
        PasswordNeverExpires: u.contrasena_nunca_vence,
        PasswordLastSet: created,
        ObjectClass: 'user',
        ObjectGUID: stableGuid(`user:${u.sam}`),
        SID: newSid(st),
        Created: created,
        Modified: created,
        __parent: u.ou ? ensureOu(u.ou) : usersCn,
      }),
    )
  }

  const group = (name: string, scope: string, parent: string, members: string[], rid?: number, category = 'Security') =>
    psObject(`${NS}.ADGroup`, { Name: name, SamAccountName: name, GroupScope: scope, GroupCategory: category, Description: null, ObjectClass: 'group', ObjectGUID: stableGuid(`group:${name}`), SID: rid ? `${DOMAIN_SID}-${rid}` : newSid(st), Created: created, Modified: created, __parent: parent, __members: members })
  const builtin = `CN=Builtin,${domainDn}`
  st.groups.push(
    group('Domain Admins', 'Global', usersCn, [s.state.usuario], 512),
    group('Domain Users', 'Global', usersCn, [], 513),
    group('Domain Computers', 'Global', usersCn, [], 515),
    group('Enterprise Admins', 'Universal', usersCn, [s.state.usuario], 519),
    group('Group Policy Creator Owners', 'Global', usersCn, [s.state.usuario], 520),
    group('Administrators', 'DomainLocal', builtin, [s.state.usuario, 'Domain Admins', 'Enterprise Admins'], 544),
    group('Remote Desktop Users', 'DomainLocal', builtin, [], 555),
    group('Backup Operators', 'DomainLocal', builtin, [], 551),
  )
  for (const g of ad.grupos) {
    const existing = st.groups.find((x) => toText(x.Name).toLowerCase() === g.nombre.toLowerCase())
    if (existing) existing.__members = [...asArray(existing.__members), ...g.miembros]
    else st.groups.push(group(g.nombre, g.ambito, g.ou ? ensureOu(g.ou) : usersCn, [...g.miembros], undefined, g.categoria))
  }
  for (const u of ad.usuarios) {
    for (const gn of u.grupos) {
      let g = st.groups.find((x) => toText(x.Name).toLowerCase() === gn.toLowerCase())
      if (!g) {
        g = group(gn, 'Global', usersCn, [])
        st.groups.push(g)
      }
      if (!asArray(g.__members).some((m) => toText(m).toLowerCase() === u.sam.toLowerCase())) g.__members = [...asArray(g.__members), u.sam]
    }
  }

  const computer = (name: string, parent: string, os: string) =>
    psObject(`${NS}.ADComputer`, { Name: name, SamAccountName: `${name}$`, DNSHostName: `${name.toLowerCase()}.${domain}`, Enabled: true, OperatingSystem: os, OperatingSystemVersion: os.includes('Server') ? '10.0 (26100)' : '10.0 (22631)', IPv4Address: null, LastLogonDate: new Date(), Description: null, UserPrincipalName: null, ObjectClass: 'computer', ObjectGUID: stableGuid(`computer:${name}`), SID: newSid(st), Created: created, Modified: created, __parent: parent })
  st.computers.push(computer(s.state.equipo, `OU=Domain Controllers,${domainDn}`, 'Windows Server 2025 Standard'))
  for (const c of ad.equipos) st.computers.push(computer(c.nombre, c.ou ? ensureOu(c.ou) : `CN=Computers,${domainDn}`, c.so ?? 'Windows 11 Pro'))
  return st
}
