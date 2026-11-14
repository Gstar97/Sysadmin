/**
 * Servidor de archivos: permisos NTFS (Get-Acl, Set-Acl, icacls, takeown), recursos compartidos SMB
 * (con enumeración basada en acceso), unidades de red, cuotas y filtros de archivos (FSRM) y
 * espacios de nombres DFS. Las rutas \\servidor\recurso se resuelven en el disco del servidor y se
 * controlan con el permiso del recurso y el NTFS del usuario que inició sesión en el cliente.
 */
import { ace, effectiveAcl, effectiveRights, icaclsText, intersect, LEVEL_RIGHTS, levelOf, shareRights, ICACLS, type Ace, type AceView, type FsTree, type Level, type Right, type SecurityDescriptor, type ShareAce, type ShareLevel } from '../windows/permisos'
import { resolveAny, type AdStore } from './ad'
import { groupNames } from './ad-ops'
import { isDc } from './dns'
import { reach } from './machine'
import { asArray, CONSTRUCTORS, cmdlet, PsError, PsSession, psEquals, type CmdletContext, type FsOp, type UncTarget } from './session'
import { fmtSize } from './system'
import { isPsObject, psObject, toText, VIEWS, type PsObject } from './values'

const param = (ctx: CmdletContext, n: string) => ctx.params.get(n.toLowerCase())
const has = (ctx: CmdletContext, n: string) => ctx.params.has(n.toLowerCase())
const str = (ctx: CmdletContext, n: string) => (has(ctx, n) && param(ctx, n) !== null ? toText(param(ctx, n)) : undefined)
const formatted = (text: string): PsObject => psObject('__formatted', { text })
const MB = 1024 * 1024

function domainStore(s: PsSession): AdStore | undefined {
  return s.data.domainStore?.[0] as AdStore | undefined
}

// ---------------------------------------------------------------------------------------
// Identidades
// ---------------------------------------------------------------------------------------

const WELL_KNOWN: Record<string, string> = {
  administrators: 'BUILTIN\\Administrators',
  'builtin\\administrators': 'BUILTIN\\Administrators',
  users: 'BUILTIN\\Users',
  'builtin\\users': 'BUILTIN\\Users',
  system: 'NT AUTHORITY\\SYSTEM',
  'nt authority\\system': 'NT AUTHORITY\\SYSTEM',
  everyone: 'Everyone',
  todos: 'Everyone',
  'authenticated users': 'NT AUTHORITY\\Authenticated Users',
  'nt authority\\authenticated users': 'NT AUTHORITY\\Authenticated Users',
  'creator owner': 'CREATOR OWNER',
  network: 'NT AUTHORITY\\NETWORK',
  'nt authority\\network': 'NT AUTHORITY\\NETWORK',
  'backup operators': 'BUILTIN\\Backup Operators',
  'builtin\\backup operators': 'BUILTIN\\Backup Operators',
}

/** Nombre canónico de una cuenta (EMPRESA\GG-Ventas, BUILTIN\Users...) o undefined si no existe. */
export function canonicalIdentity(s: PsSession, raw: string): string | undefined {
  const name = raw.trim().replace(/^"|"$/g, '')
  const wk = WELL_KNOWN[name.toLowerCase()]
  if (wk) return wk
  const st = domainStore(s)
  if (st) {
    const bare = name.includes('\\') ? name.split('\\')[1] : name.replace(/@.*$/, '')
    const prefix = name.includes('\\') ? name.split('\\')[0].toLowerCase() : st.netbios.toLowerCase()
    if (prefix === st.netbios.toLowerCase() || prefix === st.domain.toLowerCase()) {
      const o = resolveAny(st, bare)
      if (o) return `${st.netbios}\\${toText(o.SamAccountName ?? o.Name)}`
      if (/^domain (users|admins|computers)$/i.test(bare)) return `${st.netbios}\\${bare.replace(/\b\w/g, (c) => c.toUpperCase())}`
    }
  }
  // Cuentas y grupos locales.
  const local = name.includes('\\') ? name.split('\\') : [s.state.equipo, name]
  if (psEquals(local[0], s.state.equipo) || local[0] === '.') {
    if (((s.data.localUsers ?? []) as PsObject[]).some((u) => psEquals(u.Name, local[1]))) return `${s.state.equipo.toUpperCase()}\\${local[1]}`
    const g = ((s.data.localGroups ?? []) as PsObject[]).find((x) => psEquals(x.Name, local[1]))
    if (g) return `BUILTIN\\${toText(g.Name)}`
  }
  return undefined
}

/** Las cuentas que representan a la persona que inició sesión en "s" (su token). */
export function sessionPrincipals(s: PsSession): string[] {
  if (s.data.userToken) return s.data.userToken as string[]
  const st = domainStore(s)
  const base = ['Everyone', 'NT AUTHORITY\\Authenticated Users']
  const user = s.state.usuario
  let out: string[] = [...base]
  if (st && s.state.dominio) {
    const isBuiltinAdmin = /^administrador$|^administrator$/i.test(user)
    const o = resolveAny(st, isBuiltinAdmin ? 'Administrator' : user)
    if (o) {
      const groups = groupNames(st, o)
      out.push(`${st.netbios}\\${toText(o.SamAccountName ?? o.Name)}`, ...groups.map((g) => `${st.netbios}\\${g}`), 'BUILTIN\\Users')
      if (groups.some((g) => /^(domain|enterprise) admins$/i.test(g)) || isBuiltinAdmin) out.push('BUILTIN\\Administrators')
    } else if (isBuiltinAdmin) out.push(`${st.netbios}\\Administrator`, `${st.netbios}\\Domain Admins`, 'BUILTIN\\Administrators', 'BUILTIN\\Users')
  } else {
    out = [...base, `${s.state.equipo.toUpperCase()}\\${user}`, 'BUILTIN\\Users']
    if (/^administrador$|^administrator$/i.test(user)) out.push('BUILTIN\\Administrators')
  }
  s.data.userToken = out
  return out
}

/** Las cuentas de un usuario del dominio, sin iniciar sesión (para verificar y calcular). */
export function principalsFor(s: PsSession, user: string): string[] {
  const st = domainStore(s)
  const out = ['Everyone', 'NT AUTHORITY\\Authenticated Users']
  if (!st) return out
  const o = resolveAny(st, user.split('\\').pop()!)
  if (!o) return out
  const groups = groupNames(st, o)
  out.push(`${st.netbios}\\${toText(o.SamAccountName ?? o.Name)}`, ...groups.map((g) => `${st.netbios}\\${g}`), 'BUILTIN\\Users')
  if (groups.some((g) => /^(domain|enterprise) admins$/i.test(g))) out.push('BUILTIN\\Administrators')
  return out
}

// ---------------------------------------------------------------------------------------
// Descriptores de seguridad
// ---------------------------------------------------------------------------------------

function sdMap(s: PsSession): Map<string, SecurityDescriptor> {
  return ((s.data.acls ??= [new Map<string, SecurityDescriptor>()]) as Map<string, SecurityDescriptor>[])[0]
}

const k = (p: string) => p.toLowerCase().replace(/\\+$/, '') + (/^[a-z]:$/i.test(p.replace(/\\+$/, '')) ? '\\' : '')

function rootSd(drive: string): SecurityDescriptor {
  if (drive.toUpperCase() === 'C:') {
    return {
      owner: 'NT SERVICE\\TrustedInstaller',
      protected: true,
      entries: [
        ace('BUILTIN\\Administrators', 'FullControl'),
        ace('NT AUTHORITY\\SYSTEM', 'FullControl'),
        ace('BUILTIN\\Users', 'ReadAndExecute'),
        ace('NT AUTHORITY\\Authenticated Users', 'Modify', 'Allow', { oi: true, ci: true, io: true }),
        ace('NT AUTHORITY\\Authenticated Users', ['A'], 'Allow', {}),
      ],
    }
  }
  // Un volumen de datos recién formateado.
  return {
    owner: 'BUILTIN\\Administrators',
    protected: true,
    entries: [
      ace('NT AUTHORITY\\SYSTEM', 'FullControl'),
      ace('BUILTIN\\Administrators', 'FullControl'),
      ace('BUILTIN\\Users', 'ReadAndExecute'),
      ace('BUILTIN\\Users', ['A'], 'Allow', { ci: true }),
      ace('BUILTIN\\Users', ['W'], 'Allow', { ci: true, io: true }),
      ace('CREATOR OWNER', 'FullControl', 'Allow', { oi: true, ci: true, io: true }),
    ],
  }
}

export function getSd(s: PsSession, path: string): SecurityDescriptor | undefined {
  const m = sdMap(s)
  const key = k(path)
  if (m.has(key)) return m.get(key)
  if (/^[a-z]:\\$/i.test(key)) {
    const sd = rootSd(key.slice(0, 2))
    m.set(key, sd)
    return sd
  }
  return undefined
}

function ensureSd(s: PsSession, path: string): SecurityDescriptor {
  const existing = getSd(s, path)
  if (existing) return existing
  const sd: SecurityDescriptor = { owner: 'BUILTIN\\Administrators', protected: false, entries: [] }
  sdMap(s).set(k(path), sd)
  return sd
}

export function treeOf(s: PsSession): FsTree {
  return {
    sd: (p) => getSd(s, p),
    isDir: (p) => /^[a-z]:\\?$/i.test(p) || s.fs.get(p)?.type !== 'file',
    parent: (p) => (/^[a-z]:\\?$/i.test(p) ? undefined : s.fs.parent(p)),
  }
}

export function aclOf(s: PsSession, path: string): AceView[] {
  return effectiveAcl(treeOf(s), path)
}

export function ownerOf(s: PsSession, path: string): string {
  return getSd(s, path)?.owner ?? 'BUILTIN\\Administrators'
}

/** Derechos NTFS de un conjunto de cuentas sobre una ruta local del servidor. */
export function ntfsRights(s: PsSession, path: string, principals: string[]): Set<Right> {
  const owner = ownerOf(s, path)
  const who = principals.some((p) => psEquals(p, owner)) ? [...principals, 'CREATOR OWNER'] : principals
  return effectiveRights(aclOf(s, path), who, owner)
}

// ---------------------------------------------------------------------------------------
// Recursos compartidos
// ---------------------------------------------------------------------------------------

export interface Share {
  name: string
  path: string
  description: string
  access: ShareAce[]
  abe: boolean
  special?: boolean
}

export function shares(s: PsSession): Share[] {
  if (!s.data.shares) {
    const list: Share[] = [
      { name: 'ADMIN$', path: 'C:\\Windows', description: 'Remote Admin', access: [{ identity: 'BUILTIN\\Administrators', level: 'Full', type: 'Allow' }], abe: false, special: true },
      { name: 'C$', path: 'C:\\', description: 'Default share', access: [{ identity: 'BUILTIN\\Administrators', level: 'Full', type: 'Allow' }], abe: false, special: true },
      { name: 'IPC$', path: '', description: 'Remote IPC', access: [], abe: false, special: true },
    ]
    if (isDc(s.state, s.lab) && s.state.dominio) {
      const d = s.state.dominio.toLowerCase()
      list.push(
        { name: 'NETLOGON', path: `C:\\Windows\\SYSVOL\\sysvol\\${d}\\SCRIPTS`, description: 'Logon server share', access: [{ identity: 'Everyone', level: 'Read', type: 'Allow' }, { identity: 'BUILTIN\\Administrators', level: 'Full', type: 'Allow' }], abe: false },
        { name: 'SYSVOL', path: 'C:\\Windows\\SYSVOL\\sysvol', description: 'Logon server share', access: [{ identity: 'Everyone', level: 'Read', type: 'Allow' }, { identity: 'BUILTIN\\Administrators', level: 'Full', type: 'Allow' }], abe: false },
      )
      s.fs.mkdirp(`C:\\Windows\\SYSVOL\\sysvol\\${d}\\SCRIPTS`)
    }
    s.data.shares = list
  }
  return s.data.shares as Share[]
}

function findShare(s: PsSession, name: string): Share | undefined {
  return shares(s).find((x) => psEquals(x.name, name))
}

function enableSmbFirewall(s: PsSession) {
  for (const r of (s.data.firewallRules ?? []) as PsObject[]) if (toText(r.DisplayGroup ?? r.Group) === 'File and Printer Sharing' && /SMB-In/.test(toText(r.DisplayName))) r.Enabled = 'True'
}

// ---------------------------------------------------------------------------------------
// Rutas de red
// ---------------------------------------------------------------------------------------

interface DfsRoot {
  namespace: string
  targets: string[]
  folders: { name: string; targets: string[] }[]
}

function dfsRoots(s: PsSession): DfsRoot[] {
  const st = domainStore(s) as (AdStore & { dfs?: DfsRoot[] }) | undefined
  if (st) return (st.dfs ??= [])
  return ((s.data.dfs ??= []) as DfsRoot[])
}

const denied = (unc: string) => new PsError(`Access to the path '${unc}' is denied.`, 'PermissionDenied', 'UnauthorizedAccessException', unc)

/** Resuelve una ruta \\servidor\recurso\... desde el equipo "client". */
export function resolveUnc(client: PsSession, path: string, depth = 0): UncTarget | undefined {
  const parts = path.slice(2).split('\\')
  const [server, shareName, ...rest] = parts
  if (!server || !shareName) return undefined
  // Espacio de nombres DFS (\\empresa.local\Empresa\Ventas): se reemplaza por la carpeta de destino.
  const st = domainStore(client)
  if (st && depth < 3 && (psEquals(server, st.domain) || psEquals(server, st.netbios))) {
    const root = dfsRoots(client).find((r) => psEquals(r.namespace.split('\\').pop(), shareName))
    if (!root) return undefined
    const folder = rest.length ? root.folders.find((f) => psEquals(f.name, rest[0])) : undefined
    const targets = folder ? folder.targets : root.targets
    const remaining = folder ? rest.slice(1) : rest
    for (const t of targets) {
      const srv = client.lab?.find(t.slice(2).split('\\')[0])
      if (!srv || !reach(client, srv.state.red.ip, 445).ok) continue
      const r = resolveUnc(client, [t, ...remaining].join('\\'), depth + 1)
      if (r) return { ...r, uncRoot: `\\\\${server}\\${shareName}${folder ? `\\${folder.name}` : ''}` }
    }
    throw new PsError('The network path was not found.', 'ObjectNotFound', 'NetworkPathNotFound', path)
  }
  const srv = client.lab?.find(server) ?? (psEquals(server, client.state.equipo) || server === 'localhost' ? client : undefined)
  if (!srv) throw new PsError('The network path was not found.', 'ObjectNotFound', 'NetworkPathNotFound', path)
  if (srv !== client && !reach(client, srv.state.red.ip, 445).ok) throw new PsError('The network path was not found.', 'ObjectNotFound', 'NetworkPathNotFound', path)
  const share = findShare(srv, shareName)
  if (!share || !share.path) return undefined
  const principals = [...(srv === client ? sessionPrincipals(client) : sessionPrincipals(client)), 'NT AUTHORITY\\NETWORK']
  // Una cuenta local de otro equipo no se puede autenticar en el servidor.
  const st2 = domainStore(srv)
  const authenticated = srv === client || (!!st2 && !!client.state.dominio && psEquals(client.state.dominio, srv.state.dominio))
  const shareAccess = authenticated ? shareRights(share.access, principals) : new Set<Right>()
  const uncRoot = `\\\\${server}\\${share.name}`
  if (!shareAccess.size) throw denied(uncRoot)
  const localRoot = share.path
  const local = [localRoot.replace(/\\$/, ''), ...rest].join('\\')
  const rights = (p: string) => intersect(ntfsRights(srv, p, principals), shareAccess)
  const need: Record<FsOp, Right> = { list: 'R', read: 'R', write: 'W', create: 'W', mkdir: 'A', delete: 'D' }
  return {
    fs: srv.fs,
    local: local || localRoot,
    uncRoot,
    localRoot,
    check(op, p) {
      if (!rights(p).has(need[op])) throw denied(uncRoot + p.slice(localRoot.replace(/\\$/, '').length))
    },
    visible: share.abe ? (p) => rights(p).has('R') : undefined,
    created(p) {
      const user = principals.find((x) => x.includes('\\') && !/^(BUILTIN|NT AUTHORITY)\\/.test(x))
      if (user) ensureSd(srv, p).owner = user
    },
  }
}

// ---------------------------------------------------------------------------------------
// Cuotas y filtros de archivos (FSRM)
// ---------------------------------------------------------------------------------------

interface Quota {
  path: string
  limitBytes: number
  soft: boolean
  template?: string
  description: string
}
interface FileScreen {
  path: string
  groups: string[]
  active: boolean
}

export const FILE_GROUPS: Record<string, string[]> = {
  'Audio and Video Files': ['*.mp3', '*.mp4', '*.avi', '*.mkv', '*.wav', '*.wma', '*.wmv', '*.mov', '*.flac', '*.m4a'],
  'Backup Files': ['*.bak', '*.bck', '*.bkf', '*.old'],
  'Compressed Files': ['*.zip', '*.rar', '*.7z', '*.gz', '*.tar', '*.cab'],
  'E-mail Files': ['*.pst', '*.ost', '*.eml', '*.msg'],
  'Executable Files': ['*.exe', '*.bat', '*.cmd', '*.com', '*.msi', '*.ps1', '*.vbs', '*.js', '*.scr'],
  'Image Files': ['*.jpg', '*.jpeg', '*.png', '*.gif', '*.bmp', '*.tif', '*.tiff', '*.heic'],
  'Office Files': ['*.docx', '*.xlsx', '*.pptx', '*.doc', '*.xls', '*.ppt', '*.pdf'],
  'System Files': ['*.dll', '*.sys', '*.ini', '*.inf'],
  'Temporary Files': ['*.tmp', '~*'],
  'Text Files': ['*.txt', '*.csv', '*.log'],
  'Web Page Files': ['*.htm', '*.html', '*.css', '*.asp', '*.aspx'],
}

const QUOTA_TEMPLATES: { name: string; mb: number; soft: boolean; description: string }[] = [
  { name: '100 MB Limit', mb: 100, soft: false, description: '' },
  { name: '200 MB Limit Reports to User', mb: 200, soft: false, description: '' },
  { name: '200 MB Limit with 50 MB Extension', mb: 200, soft: false, description: '' },
  { name: '250 MB Extended Limit', mb: 250, soft: false, description: '' },
  { name: 'Monitor 200 GB Volume Usage', mb: 200 * 1024, soft: true, description: '' },
  { name: 'Monitor 500 MB Share', mb: 500, soft: true, description: '' },
]

function fsrm(s: PsSession) {
  return ((s.data.fsrm ??= [{ quotas: [] as Quota[], screens: [] as FileScreen[], templates: [] as { name: string; mb: number; soft: boolean; description: string }[] }]) as { quotas: Quota[]; screens: FileScreen[]; templates: { name: string; mb: number; soft: boolean; description: string }[] }[])[0]
}

function hasFsrm(s: PsSession) {
  return ((s.data.features ?? []) as PsObject[]).some((f) => toText(f.Name).toLowerCase() === 'fs-resource-manager' && f.Installed)
}

function under(path: string, base: string) {
  const p = path.toLowerCase()
  const b = base.toLowerCase().replace(/\\$/, '')
  return p === b || p.startsWith(b + '\\')
}

export function sizeOf(s: PsSession, path: string): number {
  const node = s.fs.get(path)
  if (!node) return 0
  if (node.type === 'file') return node.size ?? node.content.length
  return s.fs.children(path).reduce((a, c) => a + sizeOf(s, c.path), 0)
}

function wildcard(pattern: string, name: string) {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
  return re.test(name)
}

/** Controles del servidor al escribir: filtros de archivos y cuotas (valen también para el administrador). */
function guard(s: PsSession, op: FsOp, path: string, content?: string) {
  if (!hasFsrm(s)) return
  const f = fsrm(s)
  const name = path.slice(path.lastIndexOf('\\') + 1)
  if (op === 'write') {
    for (const sc of f.screens) {
      if (!sc.active || !under(path, sc.path)) continue
      for (const g of sc.groups) {
        const patterns = FILE_GROUPS[g] ?? []
        if (patterns.some((p) => wildcard(p, name))) throw new PsError(`Access to the path '${path}' is denied.`, 'PermissionDenied', 'UnauthorizedAccessException', path)
      }
    }
    for (const q of f.quotas) {
      if (q.soft || !under(path, q.path)) continue
      const before = sizeOf(s, q.path) - (s.fs.get(path)?.content.length ?? 0)
      if (before + (content?.length ?? 0) > q.limitBytes) throw new PsError('There is not enough space on the disk.', 'WriteError', 'IOException', path)
    }
  }
}

// ---------------------------------------------------------------------------------------
// Instalación en cada equipo y estado inicial
// ---------------------------------------------------------------------------------------

const APPLY: Record<string, Partial<Pick<Ace, 'oi' | 'ci' | 'io' | 'np'>>> = {
  carpeta_subcarpetas_archivos: { oi: true, ci: true },
  carpeta: {},
  subcarpetas_archivos: { oi: true, ci: true, io: true },
  carpeta_subcarpetas: { ci: true },
  archivos: { oi: true, io: true },
}

export function installFiles(s: PsSession) {
  s.fs.unc = (path) => resolveUnc(s, path)
  s.fs.guard = (op, path, content) => guard(s, op, path, content)
}

/** Permisos, recursos compartidos, cuotas, filtros y unidades del estado inicial. */
export function initialFiles(s: PsSession) {
  const st = s.state
  for (const [path, spec] of Object.entries(st.archivos)) {
    if (typeof spec !== 'string' && spec.tamano_mb !== undefined) {
      const node = s.fs.get(s.resolvePath(path))
      if (node) node.size = Math.round(spec.tamano_mb * MB)
    }
  }
  for (const [raw, p] of Object.entries(st.permisos)) {
    const path = s.resolvePath(raw)
    s.fs.mkdirp(path)
    const sd = ensureSd(s, path)
    sd.protected = !p.herencia
    if (p.dueno) sd.owner = canonicalIdentity(s, p.dueno) ?? p.dueno
    for (const r of p.reglas) {
      const who = canonicalIdentity(s, r.quien)
      if (!who) throw new Error(`[ejercicio] La cuenta "${r.quien}" de permisos no existe en ${st.equipo}.`)
      sd.entries.push(ace(who, r.nivel as Level, r.tipo === 'denegar' ? 'Deny' : 'Allow', APPLY[r.aplica]))
    }
    // Sin herencia, Windows copia los permisos de arriba si se elige "convertir"; acá se cargan los que trae el ejercicio.
  }
  if (st.recursos_compartidos.length) {
    for (const r of st.recursos_compartidos) {
      const path = s.resolvePath(r.ruta)
      s.fs.mkdirp(path)
      shares(s).push({
        name: r.nombre,
        path,
        description: r.descripcion ?? '',
        abe: r.abe,
        access: r.acceso.map((a) => ({ identity: canonicalIdentity(s, a.quien) ?? a.quien, level: a.nivel, type: a.tipo === 'denegar' ? 'Deny' : 'Allow' })),
      })
    }
    enableSmbFirewall(s)
  }
  if (st.cuotas.length || st.filtros_archivos.length) {
    for (const f of s.data.features as PsObject[]) if (toText(f.Name).toLowerCase() === 'fs-resource-manager') Object.assign(f, { Installed: true, InstallState: 'Installed' })
    const mods = s.data.modules as string[]
    if (!mods.includes('FileServerResourceManager')) mods.push('FileServerResourceManager')
    for (const q of st.cuotas) fsrm(s).quotas.push({ path: s.resolvePath(q.ruta), limitBytes: q.limite_mb * MB, soft: q.blanda, description: '' })
    for (const sc of st.filtros_archivos) fsrm(s).screens.push({ path: s.resolvePath(sc.ruta), groups: sc.grupos, active: true })
  }
  for (const [letter, unc] of Object.entries(st.unidades_red)) s.fs.drives.set(letter.toUpperCase().replace(/:?$/, ':'), unc)
  if (st.dfs) {
    const roots = dfsRoots(s)
    if (!roots.some((r) => psEquals(r.namespace, st.dfs!.espacio))) roots.push({ namespace: st.dfs.espacio, targets: st.dfs.destinos, folders: st.dfs.carpetas.map((c) => ({ name: c.nombre, targets: c.destinos })) })
  }
}

// ---------------------------------------------------------------------------------------
// Get-Acl, Set-Acl y las reglas
// ---------------------------------------------------------------------------------------

function inheritanceFlags(e: Ace) {
  return e.oi && e.ci ? 'ContainerInherit, ObjectInherit' : e.ci ? 'ContainerInherit' : e.oi ? 'ObjectInherit' : 'None'
}
function propagationFlags(e: Ace) {
  return e.io && e.np ? 'NoPropagateInherit, InheritOnly' : e.io ? 'InheritOnly' : e.np ? 'NoPropagateInherit' : 'None'
}

function rightsText(rights: Right[]): string {
  const lvl = levelOf(rights)
  if (lvl === 'FullControl') return 'FullControl'
  if (lvl === 'Modify') return 'Modify, Synchronize'
  if (lvl === 'ReadAndExecute') return 'ReadAndExecute, Synchronize'
  if (lvl === 'Read') return 'Read, Synchronize'
  if (lvl === 'Write') return 'Write, Synchronize'
  const names: Record<Right, string> = { R: 'ReadData', X: 'ExecuteFile', W: 'CreateFiles', A: 'AppendData', D: 'Delete', P: 'ChangePermissions', O: 'TakeOwnership' }
  return rights.map((r) => names[r]).join(', ')
}

function ruleObject(e: Ace & { inherited?: boolean }): PsObject {
  return psObject('System.Security.AccessControl.FileSystemAccessRule', {
    FileSystemRights: rightsText(e.rights),
    AccessControlType: e.type,
    IdentityReference: e.identity,
    IsInherited: !!e.inherited,
    InheritanceFlags: inheritanceFlags(e),
    PropagationFlags: propagationFlags(e),
    __ace: { identity: e.identity, rights: [...e.rights], type: e.type, oi: e.oi, ci: e.ci, io: e.io, np: e.np },
  })
}

function parseRights(v: unknown): Right[] {
  const text = toText(v)
  const out = new Set<Right>()
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const lvl = (['FullControl', 'Modify', 'ReadAndExecute', 'Read', 'Write', 'ListDirectory'] as Level[]).find((l) => psEquals(l, part))
    if (lvl) LEVEL_RIGHTS[lvl].forEach((r) => out.add(r))
    else if (/^(Delete)$/i.test(part)) out.add('D')
    else if (/^(ChangePermissions)$/i.test(part)) out.add('P')
    else if (/^(TakeOwnership)$/i.test(part)) out.add('O')
    else if (/^(ReadData|ListDirectory|ReadAttributes|ReadExtendedAttributes|ReadPermissions)$/i.test(part)) out.add('R')
    else if (/^(ExecuteFile|Traverse)$/i.test(part)) out.add('X')
    else if (/^(WriteData|CreateFiles)$/i.test(part)) out.add('W')
    else if (/^(AppendData|CreateDirectories)$/i.test(part)) out.add('A')
    else if (/^(Synchronize|WriteAttributes|WriteExtendedAttributes)$/i.test(part)) continue
    else throw new PsError(`Cannot convert argument "fileSystemRights", with value: "${text}", for "FileSystemAccessRule" to type "System.Security.AccessControl.FileSystemRights".`, 'InvalidArgument', 'MethodArgumentConversionInvalidCastArgument')
  }
  return [...out]
}

/** [System.Security.AccessControl.FileSystemAccessRule]::new(cuenta, derechos, [herencia, propagación,] tipo) */
function newRule(s: PsSession, args: unknown[]): PsObject {
  const a = args.length === 1 && Array.isArray(args[0]) ? (args[0] as unknown[]) : args
  if (a.length !== 3 && a.length !== 5) throw new PsError(`Cannot find an overload for "FileSystemAccessRule" and the argument count: "${a.length}".`, 'InvalidOperation', 'ConstructorInvokedThrowException')
  const raw = toText(a[0])
  const who = canonicalIdentity(s, raw)
  if (!who) throw new PsError(`Exception calling ".ctor" with "${a.length}" argument(s): "Some or all identity references could not be translated."`, 'InvalidOperation', 'IdentityNotMappedException')
  const rights = parseRights(a[1])
  const inh = a.length === 5 ? toText(a[2]) : 'None'
  const prop = a.length === 5 ? toText(a[3]) : 'None'
  const type = /deny/i.test(toText(a[a.length - 1])) ? 'Deny' : 'Allow'
  return ruleObject({ identity: who, rights, type, oi: /ObjectInherit/i.test(inh), ci: /ContainerInherit/i.test(inh), io: /InheritOnly/i.test(prop), np: /NoPropagate/i.test(prop) })
}

CONSTRUCTORS.set('system.security.accesscontrol.filesystemaccessrule', newRule)
CONSTRUCTORS.set('filesystemaccessrule', newRule)
CONSTRUCTORS.set('system.security.principal.ntaccount', (_s, args) => {
  const a = args.map(toText)
  return psObject('System.Security.Principal.NTAccount', { Value: a.length === 2 ? `${a[0]}\\${a[1]}` : a[0], __toString: a.length === 2 ? `${a[0]}\\${a[1]}` : a[0] })
})

interface AclState {
  path: string
  owner: string
  protected: boolean
  explicit: Ace[]
  inherited: AceView[]
}

function aclObject(s: PsSession, path: string, st: AclState): PsObject {
  const isDir = s.fs.get(path)?.type !== 'file'
  const all = (): (Ace & { inherited?: boolean })[] => [...st.explicit.map((e) => ({ ...e, inherited: false })), ...(st.protected ? [] : st.inherited.map((e) => ({ ...e, inherited: true })))]
  const o: PsObject = psObject(isDir ? 'System.Security.AccessControl.DirectorySecurity' : 'System.Security.AccessControl.FileSecurity', {
    Path: `Microsoft.PowerShell.Core\\FileSystem::${path}`,
    Owner: st.owner,
    Group: st.owner === 'BUILTIN\\Administrators' ? 'NT AUTHORITY\\SYSTEM' : 'BUILTIN\\Administrators',
    AreAccessRulesProtected: st.protected,
    __acl: st,
    __path: path,
  })
  Object.defineProperty(o, 'Access', { get: () => all().map(ruleObject), enumerable: true })
  Object.defineProperty(o, 'AccessToString', { get: () => all().map((e) => `${e.identity} ${e.type}  ${rightsText(e.rights)}`).join('\n'), enumerable: true })
  const ruleAce = (r: unknown): Ace => {
    if (!isPsObject(r) || !r.__ace) throw new PsError('Cannot convert argument "rule" to type "System.Security.AccessControl.FileSystemAccessRule".', 'InvalidArgument', 'MethodArgumentConversionInvalidCastArgument')
    return r.__ace as Ace
  }
  const same = (a: Ace, b: Ace) => psEquals(a.identity, b.identity) && a.type === b.type && a.oi === b.oi && a.ci === b.ci && a.io === b.io && a.np === b.np
  o.__method_addaccessrule = (r: unknown) => {
    const a = ruleAce(r)
    const ex = st.explicit.find((x) => same(x, a))
    if (ex) ex.rights = [...new Set([...ex.rights, ...a.rights])]
    else st.explicit.push({ ...a })
    return null
  }
  o.__method_setaccessrule = (r: unknown) => {
    const a = ruleAce(r)
    st.explicit = st.explicit.filter((x) => !(psEquals(x.identity, a.identity) && x.type === a.type))
    st.explicit.push({ ...a })
    return null
  }
  o.__method_removeaccessrule = (r: unknown) => {
    const a = ruleAce(r)
    const before = st.explicit.length
    st.explicit = st.explicit.filter((x) => !(same(x, a) && a.rights.every((y) => x.rights.includes(y))))
    return st.explicit.length !== before
  }
  o.__method_removeaccessruleall = (r: unknown) => {
    const a = ruleAce(r)
    st.explicit = st.explicit.filter((x) => !(psEquals(x.identity, a.identity) && x.type === a.type))
    return null
  }
  o.__method_purgeaccessrules = (id: unknown) => {
    const who = canonicalIdentity(s, toText(id)) ?? toText(id)
    st.explicit = st.explicit.filter((x) => !psEquals(x.identity, who))
    return null
  }
  o.__method_setaccessruleprotection = (isProtected: unknown, preserve: unknown) => {
    const p = isProtected === true || /^true$/i.test(toText(isProtected))
    if (p && !st.protected && (preserve === true || /^true$/i.test(toText(preserve)))) {
      // Convertir los heredados en explícitos.
      for (const e of st.inherited) if (!st.explicit.some((x) => same(x, e) && x.rights.join() === e.rights.join())) st.explicit.push({ identity: e.identity, rights: [...e.rights], type: e.type, oi: e.oi, ci: e.ci, io: e.io, np: e.np })
    }
    st.protected = p
    o.AreAccessRulesProtected = p
    return null
  }
  o.__method_setowner = (id: unknown) => {
    const who = canonicalIdentity(s, toText(isPsObject(id) ? id.Value : id))
    if (!who) throw new PsError('Exception calling "SetOwner" with "1" argument(s): "Some or all identity references could not be translated."', 'InvalidOperation', 'IdentityNotMappedException')
    st.owner = who
    o.Owner = who
    return null
  }
  void isDir
  return o
}

function readAcl(s: PsSession, path: string): AclState {
  const sd = getSd(s, path)
  return {
    path,
    owner: ownerOf(s, path),
    protected: !!sd?.protected,
    explicit: (sd?.entries ?? []).map((e) => ({ ...e, rights: [...e.rights] })),
    inherited: aclOf(s, path).filter((e) => e.inherited),
  }
}

VIEWS['System.Security.AccessControl.DirectorySecurity'] = {
  kind: 'table',
  columns: [
    { label: 'Path', value: (o) => toText(o.__path).split('\\').filter(Boolean).pop() ?? toText(o.__path) },
    { label: 'Owner', value: (o) => o.Owner },
    { label: 'Access', value: (o) => { const t = toText(o.AccessToString).split('\n'); return t[0] + (t.length > 1 ? '...' : '') } },
  ],
}
VIEWS['System.Security.AccessControl.FileSecurity'] = VIEWS['System.Security.AccessControl.DirectorySecurity']

function localPath(ctx: CmdletContext, raw: string, cmd: string): { s: PsSession; path: string } {
  const full = ctx.s.resolvePath(raw)
  if (ctx.s.fs.isUnc(full)) {
    const t = resolveUnc(ctx.s, full)
    if (!t) throw new PsError(`Cannot find path '${full}' because it does not exist.`, 'ObjectNotFound', `PathNotFound,Microsoft.PowerShell.Commands.${cmd}`, full)
    const srv = ctx.s.lab?.find(full.slice(2).split('\\')[0]) ?? ctx.s
    return { s: srv, path: t.local }
  }
  if (!ctx.s.fs.get(full) && !/^[A-Za-z]:\\$/.test(full)) throw new PsError(`Cannot find path '${full}' because it does not exist.`, 'ObjectNotFound', `PathNotFound,Microsoft.PowerShell.Commands.${cmd}`, full)
  return { s: ctx.s, path: full }
}

cmdlet('Get-Acl', {
  params: ['Path'],
  switches: ['Audit'],
  positional: ['Path'],
  synopsis: 'Gets the security descriptor for a resource, such as a file or registry key.',
  module: 'Microsoft.PowerShell.Security',
  run(ctx) {
    const paths = has(ctx, 'Path') ? asArray(param(ctx, 'Path')).map(toText) : ctx.input.map((x) => toText(isPsObject(x) ? (x.FullName ?? x) : x))
    return (paths.length ? paths : ['.']).map((raw) => {
      const { s, path } = localPath(ctx, raw, 'GetAclCommand')
      return aclObject(s, path, readAcl(s, path))
    })
  },
})

cmdlet('Set-Acl', {
  params: ['Path', 'AclObject'],
  switches: ['Passthru'],
  positional: ['Path', 'AclObject'],
  synopsis: 'Changes the security descriptor of a specified item, such as a file or a registry key.',
  module: 'Microsoft.PowerShell.Security',
  run(ctx) {
    const acl = (param(ctx, 'AclObject') ?? ctx.input.find((x) => isPsObject(x) && x.__acl)) as PsObject | undefined
    if (!acl || !isPsObject(acl) || !acl.__acl) throw new PsError('Cannot bind argument to parameter \'AclObject\' because it is null.', 'InvalidData', 'ParameterArgumentValidationErrorNullNotAllowed,Microsoft.PowerShell.Commands.SetAclCommand')
    const st = acl.__acl as AclState
    const { s, path } = localPath(ctx, str(ctx, 'Path') ?? st.path, 'SetAclCommand')
    const sd = ensureSd(s, path)
    sd.entries = st.explicit.map((e) => ({ ...e, rights: [...e.rights] }))
    sd.protected = st.protected
    sd.owner = st.owner
    return has(ctx, 'Passthru') ? [aclObject(s, path, readAcl(s, path))] : []
  },
})

// ---------------------------------------------------------------------------------------
// icacls y takeown
// ---------------------------------------------------------------------------------------

function parseIcaclsAce(spec: string): { who: string; flags: Partial<Ace>; rights: Right[] } | undefined {
  const m = /^(.+?):((?:\((?:OI|CI|IO|NP|I)\))*)\(?([A-Z,]+)\)?$/i.exec(spec.replace(/^"|"$/g, ''))
  if (!m) return undefined
  const flags = m[2].toUpperCase()
  const rights = new Set<Right>()
  for (const code of m[3].toUpperCase().split(',')) {
    const r = ICACLS[code]
    if (!r) return undefined
    r.forEach((x) => rights.add(x))
  }
  return { who: m[1], flags: { oi: flags.includes('(OI)'), ci: flags.includes('(CI)'), io: flags.includes('(IO)'), np: flags.includes('(NP)') }, rights: [...rights] }
}

function icaclsList(s: PsSession, path: string, display: string): string {
  const acl = aclOf(s, path)
  const lines = acl.map((e) => icaclsText(e, e.inherited))
  const pad = ' '.repeat(display.length + 1)
  return `${display} ${lines[0] ?? ''}\n${lines.slice(1).map((l) => pad + l).join('\n')}${lines.length > 1 ? '\n' : ''}\n`
}

cmdlet('icacls', {
  native: true,
  synopsis: 'icacls.exe',
  run(ctx) {
    const args = ctx.positional.map(toText)
    if (!args.length) return [formatted('ICACLS name /save aclfile [/T] [/C] [/L] [/Q]\n...\nICACLS name /grant[:r] Sid:perm[...]\nICACLS name /deny Sid:perm [...]\nICACLS name /remove[:g|:d]] Sid[...]\nICACLS name /inheritance:e|d|r\nICACLS name /setowner user\nICACLS name /reset [/T]\n\n[simulador] Ejemplo: icacls D:\\Datos\\Ventas /grant "EMPRESA\\GG-Ventas:(OI)(CI)M"\n')]
    const raw = args[0]
    let target: { s: PsSession; path: string }
    try {
      target = localPath(ctx, raw, 'icacls')
    } catch {
      return [formatted(`${raw}: The system cannot find the file specified.\nSuccessfully processed 0 files; Failed processing 1 files\n`)]
    }
    const { s, path } = target
    const display = ctx.s.resolvePath(raw)
    const rest = args.slice(1)
    if (!rest.length || rest.every((a) => /^\/(t|c|q|l)$/i.test(a))) return [formatted(`${icaclsList(s, path, display)}Successfully processed 1 files; Failed processing 0 files\n`)]
    const fail = (msg: string) => [formatted(`${msg}\nSuccessfully processed 0 files; Failed processing 1 files\n`)]
    const sd = ensureSd(s, path)
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i].toLowerCase()
      if (a.startsWith('/grant') || a === '/deny') {
        const replace = a === '/grant:r'
        const specs: string[] = []
        while (rest[i + 1] && !rest[i + 1].startsWith('/')) specs.push(rest[++i])
        if (!specs.length) return [formatted('Invalid parameter "' + rest[i] + '"\n')]
        for (const spec of specs) {
          const p = parseIcaclsAce(spec)
          if (!p) return [formatted(`Invalid parameter "${spec}"\n`)]
          const who = canonicalIdentity(s, p.who)
          if (!who) return fail(`${p.who}: No mapping between account names and security IDs was done.`)
          const type = a === '/deny' ? 'Deny' : 'Allow'
          if (replace) sd.entries = sd.entries.filter((e) => !(psEquals(e.identity, who) && e.type === 'Allow'))
          const ex = sd.entries.find((e) => psEquals(e.identity, who) && e.type === type && e.oi === !!p.flags.oi && e.ci === !!p.flags.ci && e.io === !!p.flags.io && e.np === !!p.flags.np)
          if (ex) ex.rights = [...new Set([...ex.rights, ...p.rights])]
          else sd.entries.push({ identity: who, rights: p.rights, type, oi: !!p.flags.oi, ci: !!p.flags.ci, io: !!p.flags.io, np: !!p.flags.np })
        }
      } else if (a.startsWith('/remove')) {
        const only = a.split(':')[1]
        const ids: string[] = []
        while (rest[i + 1] && !rest[i + 1].startsWith('/')) ids.push(rest[++i])
        for (const id of ids) {
          const who = canonicalIdentity(s, id) ?? id
          sd.entries = sd.entries.filter((e) => !(psEquals(e.identity, who) && (!only || (only === 'g' ? e.type === 'Allow' : e.type === 'Deny'))))
        }
      } else if (a.startsWith('/inheritance:')) {
        const mode = a.split(':')[1]
        if (mode === 'e') sd.protected = false
        else if (mode === 'd' || mode === 'r') {
          if (!sd.protected && mode === 'd') for (const e of aclOf(s, path).filter((x) => x.inherited)) sd.entries.push({ identity: e.identity, rights: [...e.rights], type: e.type, oi: e.oi, ci: e.ci, io: e.io, np: e.np })
          sd.protected = true
        } else return [formatted(`Invalid parameter "${rest[i]}"\n`)]
      } else if (a === '/setowner') {
        const who = canonicalIdentity(s, rest[++i] ?? '')
        if (!who) return fail(`${rest[i]}: No mapping between account names and security IDs was done.`)
        sd.owner = who
      } else if (a === '/reset') {
        sd.entries = []
        sd.protected = false
        if (rest.some((x) => /^\/t$/i.test(x))) for (const key of [...sdMap(s).keys()]) if (key.startsWith(k(path) + '\\')) sdMap(s).delete(key)
      } else if (/^\/(t|c|q|l)$/i.test(a)) continue
      else return [formatted(`Invalid parameter "${rest[i]}"\n`)]
    }
    return [formatted(`processed file: ${display}\nSuccessfully processed 1 files; Failed processing 0 files\n`)]
  },
})

cmdlet('takeown', {
  native: true,
  synopsis: 'takeown.exe',
  run(ctx) {
    const args = ctx.positional.map(toText)
    const i = args.findIndex((a) => /^\/f$/i.test(a))
    if (i < 0 || !args[i + 1]) return [formatted('ERROR: Invalid syntax. Value expected for \'/f\'.\nType "TAKEOWN /?" for usage.\n')]
    const { s, path } = localPath(ctx, args[i + 1], 'takeown')
    const toAdmins = args.some((a) => /^\/a$/i.test(a))
    const who = toAdmins ? 'BUILTIN\\Administrators' : sessionPrincipals(ctx.s).find((x) => x.includes('\\') && !/^(BUILTIN|NT AUTHORITY)\\/.test(x)) ?? 'BUILTIN\\Administrators'
    ensureSd(s, path).owner = who
    return [formatted(`\nSUCCESS: The file (or folder): "${ctx.s.resolvePath(args[i + 1])}" now owned by ${toAdmins ? 'the administrators group' : `user "${who}"`}.\n`)]
  },
})

// ---------------------------------------------------------------------------------------
// Recursos compartidos (SMB)
// ---------------------------------------------------------------------------------------

function shareObject(sh: Share): PsObject {
  return psObject('CimInstance#MSFT_SmbShare', { Name: sh.name, ScopeName: '*', Path: sh.path, Description: sh.description, FolderEnumerationMode: sh.abe ? 'AccessBased' : 'Unrestricted', CurrentUsers: 0, ShareType: 'FileSystemDirectory', Special: !!sh.special, __toString: sh.name })
}
VIEWS['CimInstance#MSFT_SmbShare'] = { kind: 'table', columns: ['Name', 'ScopeName', 'Path', 'Description'].map((c) => ({ label: c, value: (o: PsObject) => o[c] })) }

function shareAccessObjects(sh: Share): PsObject[] {
  return sh.access.map((a) => psObject('CimInstance#MSFT_SmbShareAccessControlEntry', { Name: sh.name, ScopeName: '*', AccountName: a.identity, AccessControlType: a.type, AccessRight: a.level }))
}
VIEWS['CimInstance#MSFT_SmbShareAccessControlEntry'] = { kind: 'table', columns: ['Name', 'ScopeName', 'AccountName', 'AccessControlType', 'AccessRight'].map((c) => ({ label: c, value: (o: PsObject) => o[c] })) }

function smbTarget(ctx: CmdletContext): PsSession {
  const cn = str(ctx, 'CimSession') ?? str(ctx, 'ComputerName')
  if (!cn) return ctx.s
  const t = ctx.s.lab?.find(cn)
  if (!t) throw new PsError(`The WinRM client cannot process the request. Cannot find the computer ${cn}.`, 'ConnectionError', 'HRESULT 0x80338000', cn)
  return t
}

function shareByName(ctx: CmdletContext, t: PsSession, cmd: string): Share {
  const input = ctx.input.find((x) => isPsObject(x) && x.__type === 'CimInstance#MSFT_SmbShare') as PsObject | undefined
  const name = str(ctx, 'Name') ?? toText(input?.Name)
  const sh = findShare(t, name)
  if (!sh) throw new PsError(`No MSFT_SMBShare objects found with property 'Name' equal to '${name}'.  Verify the value of the property and retry.`, 'ObjectNotFound', `CmdletizationQuery_NotFound_Name,${cmd}`, name)
  return sh
}

function accounts(ctx: CmdletContext, t: PsSession, n: string, cmd: string): string[] {
  return asArray(param(ctx, n)).flatMap((x) => toText(x).split(',')).map((x) => x.trim()).filter(Boolean).map((x) => {
    const who = canonicalIdentity(t, x)
    if (!who) throw new PsError(`No mapping between account names and security IDs was done.`, 'InvalidArgument', `Windows System Error 1332,${cmd}`, x)
    return who
  })
}

cmdlet('Get-SmbShare', {
  params: ['Name', 'CimSession'],
  switches: ['Special'],
  positional: ['Name'],
  synopsis: 'Retrieves the SMB shares on the computer.',
  module: 'SmbShare',
  run(ctx) {
    const t = smbTarget(ctx)
    const name = str(ctx, 'Name')
    if (name) return [shareObject(shareByName(ctx, t, 'Get-SmbShare'))]
    return shares(t).map(shareObject)
  },
})

cmdlet('New-SmbShare', {
  params: ['Name', 'Path', 'Description', 'FullAccess', 'ChangeAccess', 'ReadAccess', 'NoAccess', 'FolderEnumerationMode', 'CachingMode', 'CimSession', 'ConcurrentUserLimit'],
  switches: ['EncryptData', 'ContinuouslyAvailable', 'Temporary'],
  positional: ['Name', 'Path'],
  synopsis: 'Creates an SMB share.',
  module: 'SmbShare',
  run(ctx) {
    const t = smbTarget(ctx)
    const name = str(ctx, 'Name')!
    const path = t.resolvePath(str(ctx, 'Path') ?? '')
    if (findShare(t, name)) throw new PsError('The name has already been shared.', 'ResourceExists', 'Windows System Error 2118,New-SmbShare', name)
    if (!t.fs.get(path) && !/^[A-Za-z]:\\$/.test(path)) throw new PsError('The system cannot find the file specified.', 'ObjectNotFound', 'Windows System Error 2,New-SmbShare', path)
    const access: ShareAce[] = []
    for (const [p, level] of [['FullAccess', 'Full'], ['ChangeAccess', 'Change'], ['ReadAccess', 'Read']] as [string, ShareLevel][]) for (const who of accounts(ctx, t, p, 'New-SmbShare')) access.push({ identity: who, level, type: 'Allow' })
    for (const who of accounts(ctx, t, 'NoAccess', 'New-SmbShare')) access.push({ identity: who, level: 'Full', type: 'Deny' })
    if (!access.length) access.push({ identity: 'Everyone', level: 'Read', type: 'Allow' })
    const sh: Share = { name, path, description: str(ctx, 'Description') ?? '', access, abe: /^accessbased$/i.test(str(ctx, 'FolderEnumerationMode') ?? '') }
    shares(t).push(sh)
    enableSmbFirewall(t)
    return [shareObject(sh)]
  },
})

cmdlet('Set-SmbShare', {
  params: ['Name', 'Description', 'FolderEnumerationMode', 'CachingMode', 'CimSession'],
  switches: ['Force', 'EncryptData', 'PassThru'],
  positional: ['Name'],
  synopsis: 'Modifies the properties of the SMB share.',
  module: 'SmbShare',
  run(ctx) {
    const t = smbTarget(ctx)
    const sh = shareByName(ctx, t, 'Set-SmbShare')
    if (has(ctx, 'Description')) sh.description = str(ctx, 'Description')!
    if (has(ctx, 'FolderEnumerationMode')) sh.abe = /^accessbased$/i.test(str(ctx, 'FolderEnumerationMode')!)
    if (!has(ctx, 'Force')) ctx.host('[simulador] Sin -Force pide confirmación; se tomó como Sí.\n')
    return has(ctx, 'PassThru') ? [shareObject(sh)] : []
  },
})

cmdlet('Remove-SmbShare', {
  params: ['Name', 'CimSession'],
  switches: ['Force'],
  positional: ['Name'],
  synopsis: 'Deletes the specified SMB shares.',
  module: 'SmbShare',
  run(ctx) {
    const t = smbTarget(ctx)
    const sh = shareByName(ctx, t, 'Remove-SmbShare')
    t.data.shares = shares(t).filter((x) => x !== sh)
    if (!has(ctx, 'Force')) ctx.host('[simulador] Sin -Force pide confirmación; se tomó como Sí.\n')
    return []
  },
})

cmdlet('Get-SmbShareAccess', {
  params: ['Name', 'CimSession'],
  positional: ['Name'],
  synopsis: 'Retrieves the ACL of the SMB share.',
  module: 'SmbShare',
  run(ctx) {
    const t = smbTarget(ctx)
    return shareAccessObjects(shareByName(ctx, t, 'Get-SmbShareAccess'))
  },
})

cmdlet(['Grant-SmbShareAccess', 'Revoke-SmbShareAccess', 'Block-SmbShareAccess', 'Unblock-SmbShareAccess'], {
  params: ['Name', 'AccountName', 'AccessRight', 'CimSession'],
  switches: ['Force'],
  positional: ['Name'],
  synopsis: 'Changes the ACL of an SMB share.',
  module: 'SmbShare',
  run(ctx) {
    const t = smbTarget(ctx)
    const op = ctx.name.split('-')[0].toLowerCase()
    const sh = shareByName(ctx, t, ctx.name)
    const who = accounts(ctx, t, 'AccountName', ctx.name)
    const right = ((['Full', 'Change', 'Read'] as ShareLevel[]).find((x) => psEquals(x, str(ctx, 'AccessRight'))) ?? 'Read') as ShareLevel
    for (const w of who) {
      if (op === 'grant') {
        sh.access = sh.access.filter((a) => !(psEquals(a.identity, w) && a.type === 'Allow'))
        sh.access.push({ identity: w, level: right, type: 'Allow' })
      } else if (op === 'revoke') sh.access = sh.access.filter((a) => !(psEquals(a.identity, w) && a.type === 'Allow'))
      else if (op === 'block') sh.access.push({ identity: w, level: 'Full', type: 'Deny' })
      else sh.access = sh.access.filter((a) => !(psEquals(a.identity, w) && a.type === 'Deny'))
    }
    if (!has(ctx, 'Force')) ctx.host('[simulador] Sin -Force pide confirmación; se tomó como Sí.\n')
    return shareAccessObjects(sh)
  },
})

// ---------------------------------------------------------------------------------------
// Unidades de red: net use, New-PSDrive, New-SmbMapping
// ---------------------------------------------------------------------------------------

function mapDrive(ctx: CmdletContext, letter: string, unc: string): string | undefined {
  const l = letter.toUpperCase().replace(/:?$/, ':')
  const full = ctx.s.resolvePath(unc)
  try {
    const t = resolveUnc(ctx.s, full)
    if (!t) return 'The network name cannot be found.'
    t.check?.('list', t.local)
  } catch (e) {
    return e instanceof PsError ? (/denied/.test(e.message) ? 'Access is denied.' : e.message) : 'The network path was not found.'
  }
  if (ctx.s.fs.drives.has(l)) return 'The local device name is already in use.'
  ctx.s.fs.drives.set(l, full)
  return undefined
}

cmdlet('net', {
  native: true,
  synopsis: 'net.exe',
  run(ctx) {
    const args = ctx.positional.map(toText)
    const sub = args[0]?.toLowerCase()
    if (sub === 'share') {
      if (args[1] && args[1].includes('=')) return [formatted('[simulador] Para crear recursos compartidos usá New-SmbShare.\n')]
      const rows = shares(ctx.s).map((sh) => `${sh.name.padEnd(13)}${sh.path.padEnd(31)}${sh.description}`)
      return [formatted(`\nShare name   Resource                        Remark\n\n-------------------------------------------------------------------------------\n${rows.join('\n')}\nThe command completed successfully.\n\n`)]
    }
    if (sub === 'use') {
      const rest = args.slice(1).filter((a) => !/^\/persistent:/i.test(a))
      if (!rest.length) {
        const rows = [...ctx.s.fs.drives].map(([l, u]) => `OK           ${l.padEnd(10)}${u.padEnd(26)}Microsoft Windows Network`)
        return [formatted(`New connections will be remembered.\n\n\nStatus       Local     Remote                    Network\n\n-------------------------------------------------------------------------------\n${rows.join('\n')}${rows.length ? '\n' : ''}The command completed successfully.\n\n`)]
      }
      if (rest.some((a) => /^\/delete$/i.test(a))) {
        ctx.s.fs.drives.delete(rest[0].toUpperCase())
        return [formatted(`${rest[0].toUpperCase()} was deleted successfully.\n\n`)]
      }
      const err = mapDrive(ctx, rest[0], rest[1] ?? '')
      if (err) return [formatted(`System error ${err.includes('denied') ? 5 : err.includes('in use') ? 85 : 53} has occurred.\n\n${err}\n\n`)]
      return [formatted('The command completed successfully.\n\n')]
    }
    return [formatted('The syntax of this command is:\n\nNET\n    [ ACCOUNTS | COMPUTER | CONFIG | CONTINUE | FILE | GROUP | HELP |\n      HELPMSG | LOCALGROUP | PAUSE | SESSION | SHARE | START |\n      STATISTICS | STOP | TIME | USE | USER | VIEW ]\n\n')]
  },
})

cmdlet('New-PSDrive', {
  params: ['Name', 'PSProvider', 'Root', 'Description', 'Scope', 'Credential'],
  switches: ['Persist'],
  positional: ['Name', 'PSProvider', 'Root'],
  synopsis: 'Creates temporary and persistent drives that are associated with a location in an item data store.',
  run(ctx) {
    const name = str(ctx, 'Name')!
    const root = str(ctx, 'Root')!
    if (!/^\\\\/.test(root)) {
      ctx.host('[simulador] Solo se simulan unidades que apuntan a una ruta de red (\\\\servidor\\recurso).\n')
      return []
    }
    const err = mapDrive(ctx, name, root)
    if (err) throw new PsError(err, 'InvalidOperation', 'CouldNotMapNetworkDrive,Microsoft.PowerShell.Commands.NewPSDriveCommand', name)
    return [psObject('System.Management.Automation.PSDriveInfo', { Name: name.replace(':', ''), Used: '', Free: '', Provider: 'FileSystem', Root: root, CurrentLocation: '' })]
  },
})
VIEWS['System.Management.Automation.PSDriveInfo'] = { kind: 'table', columns: ['Name', 'Used', 'Free', 'Provider', 'Root', 'CurrentLocation'].map((c) => ({ label: c, value: (o: PsObject) => o[c] })) }

cmdlet('New-SmbMapping', {
  params: ['LocalPath', 'RemotePath', 'UserName', 'Password'],
  switches: ['Persistent'],
  synopsis: 'Creates an SMB mapping.',
  module: 'SmbShare',
  run(ctx) {
    const err = mapDrive(ctx, str(ctx, 'LocalPath')!, str(ctx, 'RemotePath')!)
    if (err) throw new PsError(err, 'InvalidOperation', 'Windows System Error 5,New-SmbMapping')
    return [psObject('CimInstance#MSFT_SmbMapping', { Status: 'OK', 'Local Path': str(ctx, 'LocalPath')!.toUpperCase(), 'Remote Path': str(ctx, 'RemotePath') })]
  },
})
cmdlet('Get-SmbMapping', {
  synopsis: 'Retrieves the SMB client directory mappings created for a server.',
  module: 'SmbShare',
  run: (ctx) => [...ctx.s.fs.drives].map(([l, u]) => psObject('CimInstance#MSFT_SmbMapping', { Status: 'OK', 'Local Path': l, 'Remote Path': u })),
})
VIEWS['CimInstance#MSFT_SmbMapping'] = { kind: 'table', columns: ['Status', 'Local Path', 'Remote Path'].map((c) => ({ label: c, value: (o: PsObject) => o[c] })) }

// ---------------------------------------------------------------------------------------
// FSRM: cuotas y filtros de archivos
// ---------------------------------------------------------------------------------------

function fsrmTarget(ctx: CmdletContext, cmd: string): PsSession {
  const t = smbTarget(ctx)
  if (!hasFsrm(t)) throw new PsError(`The term '${cmd}' is not recognized as the name of a cmdlet, function, script file, or operable program.\n[simulador] Instalá el rol: Install-WindowsFeature FS-Resource-Manager -IncludeManagementTools`, 'ObjectNotFound', 'CommandNotFoundException', cmd)
  return t
}

function parseSize(v: unknown): number {
  if (typeof v === 'number') return v
  const m = /^([\d.]+)\s*(KB|MB|GB|TB)?$/i.exec(toText(v).trim())
  if (!m) return Number(v) || 0
  const unit = (m[2] ?? '').toUpperCase()
  return Number(m[1]) * (unit === 'KB' ? 1024 : unit === 'MB' ? MB : unit === 'GB' ? 1024 * MB : unit === 'TB' ? 1024 * 1024 * MB : 1)
}

function quotaObject(s: PsSession, q: Quota): PsObject {
  const usage = sizeOf(s, q.path)
  return psObject('CimInstance#MSFT_FSRMQuota', { Path: q.path, Size: q.limitBytes, SoftLimit: q.soft, Usage: usage, PeakUsage: usage, Template: q.template ?? '', Description: q.description, Disabled: false, __pct: Math.round((usage / Math.max(1, q.limitBytes)) * 100) })
}
VIEWS['CimInstance#MSFT_FSRMQuota'] = {
  kind: 'table',
  columns: [
    { label: 'Path', value: (o) => o.Path },
    { label: 'Size', value: (o) => fmtSize(Number(o.Size)) },
    { label: 'SoftLimit', value: (o) => o.SoftLimit },
    { label: 'Usage', value: (o) => fmtSize(Number(o.Usage)) },
    { label: 'Usage%', value: (o) => `${o.__pct}%` },
    { label: 'Template', value: (o) => o.Template },
  ],
}

cmdlet('New-FsrmQuota', {
  params: ['Path', 'Size', 'Template', 'Description', 'Threshold', 'CimSession'],
  switches: ['SoftLimit', 'Disabled'],
  positional: ['Path'],
  synopsis: 'Creates a FSRM quota.',
  module: 'FileServerResourceManager',
  run(ctx) {
    const t = fsrmTarget(ctx, 'New-FsrmQuota')
    const path = t.resolvePath(str(ctx, 'Path')!)
    if (!t.fs.get(path)) throw new PsError(`The specified path does not exist: ${path}`, 'ObjectNotFound', '0x80070003,New-FsrmQuota', path)
    const f = fsrm(t)
    if (f.quotas.some((q) => psEquals(q.path, path))) throw new PsError(`A quota already exists for ${path}.`, 'ResourceExists', '0x80045306,New-FsrmQuota', path)
    const tpl = str(ctx, 'Template')
    const template = tpl ? [...QUOTA_TEMPLATES, ...f.templates].find((x) => psEquals(x.name, tpl)) : undefined
    if (tpl && !template) throw new PsError(`The specified template was not found: ${tpl}`, 'ObjectNotFound', '0x80045301,New-FsrmQuota', tpl)
    if (!template && !has(ctx, 'Size')) throw new PsError('Cannot process command because of one or more missing mandatory parameters: Size.', 'InvalidArgument', 'MissingMandatoryParameter')
    const q: Quota = { path, limitBytes: has(ctx, 'Size') ? parseSize(param(ctx, 'Size')) : template!.mb * MB, soft: has(ctx, 'SoftLimit') || !!template?.soft, template: template?.name, description: str(ctx, 'Description') ?? '' }
    f.quotas.push(q)
    return [quotaObject(t, q)]
  },
})

cmdlet('Get-FsrmQuota', {
  params: ['Path', 'CimSession'],
  positional: ['Path'],
  synopsis: 'Gets FSRM quotas on the server.',
  module: 'FileServerResourceManager',
  run(ctx) {
    const t = fsrmTarget(ctx, 'Get-FsrmQuota')
    const p = str(ctx, 'Path')
    return fsrm(t).quotas.filter((q) => !p || psEquals(q.path, t.resolvePath(p))).map((q) => quotaObject(t, q))
  },
})

cmdlet('Set-FsrmQuota', {
  params: ['Path', 'Size', 'Description', 'CimSession'],
  switches: ['SoftLimit'],
  positional: ['Path'],
  synopsis: 'Changes configuration settings for a FSRM quota.',
  module: 'FileServerResourceManager',
  run(ctx) {
    const t = fsrmTarget(ctx, 'Set-FsrmQuota')
    const q = fsrm(t).quotas.find((x) => psEquals(x.path, t.resolvePath(str(ctx, 'Path')!)))
    if (!q) throw new PsError(`The specified quota was not found.`, 'ObjectNotFound', '0x80045304,Set-FsrmQuota')
    if (has(ctx, 'Size')) q.limitBytes = parseSize(param(ctx, 'Size'))
    if (has(ctx, 'SoftLimit')) q.soft = param(ctx, 'SoftLimit') !== false
    return []
  },
})

cmdlet('Remove-FsrmQuota', {
  params: ['Path', 'CimSession'],
  switches: ['Confirm', 'Force'],
  positional: ['Path'],
  synopsis: 'Removes a FSRM quota from the server.',
  module: 'FileServerResourceManager',
  run(ctx) {
    const t = fsrmTarget(ctx, 'Remove-FsrmQuota')
    const f = fsrm(t)
    f.quotas = f.quotas.filter((x) => !psEquals(x.path, t.resolvePath(str(ctx, 'Path')!)))
    return []
  },
})

cmdlet('Get-FsrmQuotaTemplate', {
  params: ['Name', 'CimSession'],
  positional: ['Name'],
  synopsis: 'Gets quota templates.',
  module: 'FileServerResourceManager',
  run(ctx) {
    const t = fsrmTarget(ctx, 'Get-FsrmQuotaTemplate')
    return [...QUOTA_TEMPLATES, ...fsrm(t).templates].filter((x) => !has(ctx, 'Name') || psEquals(x.name, str(ctx, 'Name'))).map((x) => psObject('CimInstance#MSFT_FSRMQuotaTemplate', { Name: x.name, Size: fmtSize(x.mb * MB), SoftLimit: x.soft, Description: x.description }))
  },
})
VIEWS['CimInstance#MSFT_FSRMQuotaTemplate'] = { kind: 'table', columns: ['Name', 'Size', 'SoftLimit', 'Description'].map((c) => ({ label: c, value: (o: PsObject) => o[c] })) }

cmdlet('New-FsrmQuotaTemplate', {
  params: ['Name', 'Size', 'Description', 'Threshold', 'CimSession'],
  switches: ['SoftLimit'],
  positional: ['Name'],
  synopsis: 'Creates a FSRM quota template.',
  module: 'FileServerResourceManager',
  run(ctx) {
    const t = fsrmTarget(ctx, 'New-FsrmQuotaTemplate')
    fsrm(t).templates.push({ name: str(ctx, 'Name')!, mb: parseSize(param(ctx, 'Size')) / MB, soft: has(ctx, 'SoftLimit'), description: str(ctx, 'Description') ?? '' })
    return []
  },
})

cmdlet('Get-FsrmFileGroup', {
  params: ['Name', 'CimSession'],
  positional: ['Name'],
  synopsis: 'Gets file groups.',
  module: 'FileServerResourceManager',
  run(ctx) {
    fsrmTarget(ctx, 'Get-FsrmFileGroup')
    return Object.entries(FILE_GROUPS)
      .filter(([n]) => !has(ctx, 'Name') || psEquals(n, str(ctx, 'Name')))
      .map(([n, pats]) => psObject('CimInstance#MSFT_FSRMFileGroup', { Name: n, IncludePattern: `{${pats.slice(0, 6).join(', ')}${pats.length > 6 ? '...' : ''}}`, ExcludePattern: '{}', Description: '' }))
  },
})
VIEWS['CimInstance#MSFT_FSRMFileGroup'] = { kind: 'table', columns: ['Name', 'IncludePattern', 'ExcludePattern'].map((c) => ({ label: c, value: (o: PsObject) => o[c] })) }

cmdlet('New-FsrmFileScreen', {
  params: ['Path', 'IncludeGroup', 'Template', 'Description', 'CimSession'],
  switches: ['Active'],
  positional: ['Path'],
  synopsis: 'Creates a file screen.',
  module: 'FileServerResourceManager',
  run(ctx) {
    const t = fsrmTarget(ctx, 'New-FsrmFileScreen')
    const path = t.resolvePath(str(ctx, 'Path')!)
    const groups = asArray(param(ctx, 'IncludeGroup')).map(toText)
    for (const g of groups) if (!FILE_GROUPS[Object.keys(FILE_GROUPS).find((x) => psEquals(x, g)) ?? '']) throw new PsError(`The specified file group was not found: ${g}`, 'ObjectNotFound', '0x80045301,New-FsrmFileScreen', g)
    const sc: FileScreen = { path, groups: groups.map((g) => Object.keys(FILE_GROUPS).find((x) => psEquals(x, g))!), active: has(ctx, 'Active') }
    fsrm(t).screens.push(sc)
    if (!sc.active) ctx.host('[simulador] Sin -Active, el filtro es pasivo: solo avisa, no bloquea.\n')
    return [psObject('CimInstance#MSFT_FSRMFileScreen', { Path: sc.path, Active: sc.active, IncludeGroup: `{${sc.groups.join(', ')}}`, Template: '', Description: '' })]
  },
})

cmdlet('Get-FsrmFileScreen', {
  params: ['Path', 'CimSession'],
  positional: ['Path'],
  synopsis: 'Gets file screens.',
  module: 'FileServerResourceManager',
  run(ctx) {
    const t = fsrmTarget(ctx, 'Get-FsrmFileScreen')
    return fsrm(t).screens.map((sc) => psObject('CimInstance#MSFT_FSRMFileScreen', { Path: sc.path, Active: sc.active, IncludeGroup: `{${sc.groups.join(', ')}}`, Template: '', Description: '' }))
  },
})
VIEWS['CimInstance#MSFT_FSRMFileScreen'] = { kind: 'table', columns: ['Path', 'Active', 'IncludeGroup', 'Template'].map((c) => ({ label: c, value: (o: PsObject) => o[c] })) }

// ---------------------------------------------------------------------------------------
// DFS Namespaces
// ---------------------------------------------------------------------------------------

function dfsCheck(ctx: CmdletContext, cmd: string) {
  const mods = (ctx.s.data.modules ?? []) as string[]
  if (!mods.some((m) => m.toLowerCase() === 'dfsn')) throw new PsError(`The term '${cmd}' is not recognized as the name of a cmdlet, function, script file, or operable program.\n[simulador] Instalá el rol (FS-DFS-Namespace) o las herramientas (RSAT-DFS-Mgmt-Con).`, 'ObjectNotFound', 'CommandNotFoundException', cmd)
}

function findRoot(ctx: CmdletContext, path: string): DfsRoot | undefined {
  const parts = path.replace(/^\\\\/, '').split('\\')
  return dfsRoots(ctx.s).find((r) => psEquals(r.namespace, `\\\\${parts[0]}\\${parts[1]}`))
}

cmdlet('New-DfsnRoot', {
  params: ['Path', 'TargetPath', 'Type', 'Description'],
  positional: ['Path', 'TargetPath', 'Type'],
  synopsis: 'Creates a DFS namespace.',
  module: 'DFSN',
  run(ctx) {
    dfsCheck(ctx, 'New-DfsnRoot')
    const path = str(ctx, 'Path')!
    const target = str(ctx, 'TargetPath')!
    const [server, share] = target.replace(/^\\\\/, '').split('\\')
    const srv = ctx.s.lab?.find(server) ?? (psEquals(server, ctx.s.state.equipo) ? ctx.s : undefined)
    if (!srv || !findShare(srv, share)) throw new PsError(`The share ${target} does not exist. Create it before creating the namespace.`, 'ObjectNotFound', 'Windows System Error 2,New-DfsnRoot', target)
    if (!((srv.data.features ?? []) as PsObject[]).some((f) => toText(f.Name).toLowerCase() === 'fs-dfs-namespace' && f.Installed)) throw new PsError(`The DFS Namespace service is not installed on ${server}.`, 'InvalidOperation', 'Windows System Error 1060,New-DfsnRoot', server)
    if (findRoot(ctx, path)) throw new PsError(`The namespace ${path} already exists.`, 'ResourceExists', 'Windows System Error 183,New-DfsnRoot', path)
    dfsRoots(ctx.s).push({ namespace: path, targets: [target], folders: [] })
    return [psObject('CimInstance#DfsnRoot', { Path: path, Type: str(ctx, 'Type') ?? 'Domain V2', Properties: '{Site Costing}', TimeToLiveSec: 300, State: 'Online', Description: str(ctx, 'Description') ?? '' })]
  },
})
VIEWS['CimInstance#DfsnRoot'] = { kind: 'table', columns: ['Path', 'Type', 'Properties', 'TimeToLiveSec', 'State', 'Description'].map((c) => ({ label: c, value: (o: PsObject) => o[c] })) }

cmdlet('Get-DfsnRoot', {
  params: ['Path', 'Domain'],
  positional: ['Path'],
  synopsis: 'Gets settings for DFS namespaces.',
  module: 'DFSN',
  run(ctx) {
    dfsCheck(ctx, 'Get-DfsnRoot')
    return dfsRoots(ctx.s).map((r) => psObject('CimInstance#DfsnRoot', { Path: r.namespace, Type: 'Domain V2', Properties: '{Site Costing}', TimeToLiveSec: 300, State: 'Online', Description: '' }))
  },
})

cmdlet(['New-DfsnFolder', 'New-DfsnFolderTarget'], {
  params: ['Path', 'TargetPath', 'Description', 'State'],
  positional: ['Path', 'TargetPath'],
  synopsis: 'Creates a DFS namespace folder or adds a folder target.',
  module: 'DFSN',
  run(ctx) {
    dfsCheck(ctx, ctx.name)
    const path = str(ctx, 'Path')!
    const target = str(ctx, 'TargetPath')!
    const root = findRoot(ctx, path)
    if (!root) throw new PsError(`Cannot get DFS folder properties on "${path}". The namespace does not exist.`, 'ObjectNotFound', 'Windows System Error 1168,' + ctx.name, path)
    const name = path.replace(/^\\\\/, '').split('\\').slice(2).join('\\')
    let f = root.folders.find((x) => psEquals(x.name, name))
    if (ctx.name === 'New-DfsnFolder') {
      if (f) throw new PsError(`The folder ${path} already exists.`, 'ResourceExists', 'Windows System Error 183,New-DfsnFolder', path)
      f = { name, targets: [] }
      root.folders.push(f)
    } else if (!f) throw new PsError(`The folder ${path} does not exist.`, 'ObjectNotFound', 'Windows System Error 1168,New-DfsnFolderTarget', path)
    if (!f.targets.some((x) => psEquals(x, target))) f.targets.push(target)
    return [psObject('CimInstance#DfsnFolderTarget', { Path: path, TargetPath: target, State: 'Online', ReferralPriorityClass: 'sitecost-normal', ReferralPriorityRank: 0 })]
  },
})

cmdlet('Get-DfsnFolder', {
  params: ['Path'],
  positional: ['Path'],
  synopsis: 'Gets settings for a DFS namespace folder.',
  module: 'DFSN',
  run(ctx) {
    dfsCheck(ctx, 'Get-DfsnFolder')
    const p = str(ctx, 'Path') ?? ''
    const root = findRoot(ctx, p.replace(/\\\*$/, ''))
    return (root?.folders ?? []).map((f) => psObject('CimInstance#DfsnFolder', { Path: `${root!.namespace}\\${f.name}`, Description: '', State: 'Online', TimeToLiveSec: 1800 }))
  },
})
VIEWS['CimInstance#DfsnFolder'] = { kind: 'table', columns: ['Path', 'Description', 'State', 'TimeToLiveSec'].map((c) => ({ label: c, value: (o: PsObject) => o[c] })) }

cmdlet('Get-DfsnFolderTarget', {
  params: ['Path'],
  positional: ['Path'],
  synopsis: 'Gets settings for targets of a DFS namespace folder.',
  module: 'DFSN',
  run(ctx) {
    dfsCheck(ctx, 'Get-DfsnFolderTarget')
    const p = str(ctx, 'Path')!
    const root = findRoot(ctx, p)
    const name = p.replace(/^\\\\/, '').split('\\').slice(2).join('\\')
    const f = root?.folders.find((x) => psEquals(x.name, name))
    return (f?.targets ?? []).map((t) => psObject('CimInstance#DfsnFolderTarget', { Path: p, TargetPath: t, State: 'Online', ReferralPriorityClass: 'sitecost-normal', ReferralPriorityRank: 0 }))
  },
})
VIEWS['CimInstance#DfsnFolderTarget'] = { kind: 'table', columns: ['Path', 'TargetPath', 'State', 'ReferralPriorityClass', 'ReferralPriorityRank'].map((c) => ({ label: c, value: (o: PsObject) => o[c] })) }

cmdlet('Remove-DfsnFolder', {
  params: ['Path'],
  switches: ['Force'],
  positional: ['Path'],
  synopsis: 'Removes a folder from a DFS namespace.',
  module: 'DFSN',
  run(ctx) {
    dfsCheck(ctx, 'Remove-DfsnFolder')
    const p = str(ctx, 'Path')!
    const root = findRoot(ctx, p)
    const name = p.replace(/^\\\\/, '').split('\\').slice(2).join('\\')
    if (root) root.folders = root.folders.filter((x) => !psEquals(x.name, name))
    return []
  },
})

/** Para el Simulador de permisos y las verificaciones: el acceso por la red de un usuario. */
export function networkLevel(client: PsSession, user: string, unc: string): string {
  const parts = unc.slice(2).split('\\')
  const srv = client.lab?.find(parts[0]) ?? client
  const sh = findShare(srv, parts[1])
  if (!sh) return 'None'
  const principals = [...principalsFor(srv, user), 'NT AUTHORITY\\NETWORK']
  const local = [sh.path.replace(/\\$/, ''), ...parts.slice(2)].join('\\')
  return levelOf(intersect(ntfsRights(srv, local, principals), shareRights(sh.access, principals)))
}

export function localLevel(s: PsSession, user: string, path: string): string {
  const who = canonicalIdentity(s, user)
  const principals = /\\/.test(user) && !who ? [user] : who && /^(BUILTIN|NT AUTHORITY)\\|^Everyone$|^CREATOR OWNER$/.test(who) ? [who] : principalsFor(s, user)
  return levelOf(ntfsRights(s, s.resolvePath(path), principals))
}

export { findShare }
