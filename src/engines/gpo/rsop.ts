/**
 * Conjunto resultante de directivas (RSoP): qué GPO se aplican a un usuario o a un equipo y qué
 * valor gana en cada configuración. Lo usan la terminal de PowerShell (gpresult, Get-GPResultantSetOfPolicy)
 * y el simulador visual "¿qué GPO gana?".
 *
 * Reglas que modela:
 * - Orden de procesamiento: local, sitio, dominio y después cada OU de arriba hacia abajo. La que se
 *   procesa última pisa a las anteriores (gana la más cercana al objeto).
 * - Dentro de un mismo contenedor, el vínculo con orden 1 es el de mayor prioridad (se procesa último).
 * - "Bloquear herencia" en una OU corta los vínculos de los contenedores de arriba, salvo los exigidos.
 * - Un vínculo "exigido" (Enforced) no se puede bloquear y le gana a todo lo de abajo: entre exigidos,
 *   gana el del contenedor más alto.
 * - Filtrado de seguridad: la GPO se aplica solo si el usuario o equipo (o un grupo al que pertenece)
 *   tiene el permiso "Aplicar directiva de grupo".
 * - Filtro WMI: si no se cumple, la GPO no se aplica.
 * - Una GPO puede tener deshabilitada la parte de equipo o la de usuario.
 */

export type GpScope = 'Computer' | 'User'

export interface GpoSetting {
  scope: GpScope
  /** Clave del registro (HKLM\... o HKCU\...) o un nombre interno para las que no son de registro. */
  key: string
  valueName: string
  value: string | number
  /** Nombre que muestra el editor de directivas. */
  label?: string
}

export interface GpoDef {
  id: string
  name: string
  /** AllSettingsEnabled, UserSettingsDisabled, ComputerSettingsDisabled o AllSettingsDisabled. */
  status: 'AllSettingsEnabled' | 'UserSettingsDisabled' | 'ComputerSettingsDisabled' | 'AllSettingsDisabled'
  settings: GpoSetting[]
  /** Quiénes tienen "Aplicar directiva de grupo" (nombres de grupos, usuarios o equipos). */
  apply: string[]
  /** Quiénes pueden leerla sin aplicarla. */
  readers?: string[]
  /** Filtro WMI: nombre y si el equipo lo cumple. */
  wmi?: { name: string; matches: boolean }
}

export interface GpLink {
  gpoId: string
  /** DN del contenedor (el dominio o una OU), o "site:Nombre" para un sitio. */
  target: string
  enabled: boolean
  enforced: boolean
  /** 1 es la prioridad más alta dentro del contenedor. */
  order: number
}

export interface RsopInput {
  gpos: GpoDef[]
  links: GpLink[]
  /** DN de los contenedores con la herencia bloqueada. */
  blocked: string[]
  domainDn: string
  /** DN del contenedor donde está el objeto (su OU o CN=Users). */
  containerDn: string
  /** Sitio del equipo (opcional). */
  site?: string
  /** Nombres (en cualquier capitalización) del objeto y de todos sus grupos, incluidos los anidados. */
  principals: string[]
  scope: GpScope
  /**
   * Para la parte de usuario: los nombres del equipo y sus grupos. Desde 2016 (MS16-072) el equipo
   * lee las GPO de usuario con su propia cuenta, así que si no tiene permiso de lectura no se aplican.
   */
  computerPrincipals?: string[]
}

export type FilterReason = 'Disabled (Link)' | 'Disabled (GPO)' | 'Denied (Security)' | 'Denied (WMI Filter)' | 'Not Applied (Empty)' | 'Blocked (Inheritance)'

export interface RsopEntry {
  gpo: GpoDef
  link: GpLink
  /** Contenedor de donde viene el vínculo, como se lee: "empresa.local" o "empresa.local/Ventas". */
  from: string
}

export interface RsopWinner {
  setting: GpoSetting
  gpo: GpoDef
  /** GPO que también lo configuraban y perdieron (de mayor a menor prioridad). */
  losers: { gpo: GpoDef; value: string | number }[]
}

export interface RsopResult {
  /** GPO aplicadas, de mayor a menor prioridad (como las lista gpresult). */
  applied: RsopEntry[]
  /** GPO que no se aplicaron y por qué. */
  filtered: (RsopEntry & { reason: FilterReason })[]
  /** Valor final de cada configuración. */
  settings: RsopWinner[]
}

/** El nombre está en el conjunto (con o sin el dominio adelante: EMPRESA\\Ventas o Ventas). */
function has(set: Set<string>, name: string) {
  const n = name.toLowerCase()
  return set.has(n) || set.has(n.replace(/^[^\\]+\\/, ''))
}

const norm = (dn: string) => dn.replace(/\s*,\s*/g, ',').toLowerCase()

/** Contenedores desde el dominio hasta el del objeto: [dominio, OU=A, OU=B,OU=A...]. */
export function containerChain(containerDn: string, domainDn: string): string[] {
  const dom = norm(domainDn)
  const parts = containerDn.split(',')
  const chain: string[] = []
  for (let i = parts.length - 1; i >= 0; i--) {
    const dn = parts.slice(i).join(',')
    if (norm(dn) === dom) chain.push(dn)
    else if (/^\s*OU=/i.test(parts[i]) && norm(dn).endsWith(dom)) chain.push(dn)
  }
  if (!chain.length || norm(chain[0]) !== dom) chain.unshift(domainDn)
  return chain
}

/** "OU=Ventas,OU=Empresa,DC=empresa,DC=local" → "empresa.local/Empresa/Ventas". */
export function readableContainer(dn: string, domainDn: string): string {
  if (dn.startsWith('site:')) return dn.slice(5)
  const domain = domainDn
    .split(',')
    .map((p) => p.replace(/^\s*DC=/i, ''))
    .join('.')
  const ous = dn
    .split(',')
    .filter((p) => /^\s*OU=/i.test(p))
    .map((p) => p.replace(/^\s*OU=/i, ''))
    .reverse()
  return [domain, ...ous].join('/')
}

function halfEnabled(g: GpoDef, scope: GpScope): boolean {
  if (g.status === 'AllSettingsDisabled') return false
  if (scope === 'User' && g.status === 'UserSettingsDisabled') return false
  if (scope === 'Computer' && g.status === 'ComputerSettingsDisabled') return false
  return true
}

/** Lista de procesamiento: de menor a mayor prioridad (la última gana). */
export function processingOrder(input: RsopInput): { entry: RsopEntry; blockedOut: boolean }[] {
  const chain = containerChain(input.containerDn, input.domainDn)
  const blockedSet = new Set(input.blocked.map(norm))
  // El bloqueo más profundo corta todo lo que está por encima de él.
  let blockAt = -1
  chain.forEach((dn, i) => {
    if (blockedSet.has(norm(dn))) blockAt = i
  })
  const gpoById = new Map(input.gpos.map((g) => [g.id.toLowerCase(), g]))
  const linksOf = (target: string) =>
    input.links
      .filter((l) => norm(l.target) === norm(target))
      .sort((a, b) => b.order - a.order)
      .map((l) => ({ link: l, gpo: gpoById.get(l.gpoId.toLowerCase()) }))
      .filter((x): x is { link: GpLink; gpo: GpoDef } => !!x.gpo)

  const containers = [...(input.site ? [`site:${input.site}`] : []), ...chain]
  // Índice del contenedor en la cadena (los sitios quedan arriba de todo, como el dominio).
  const level = (i: number) => (input.site ? i - 1 : i)
  const normal: { entry: RsopEntry; blockedOut: boolean }[] = []
  const enforced: { entry: RsopEntry; blockedOut: boolean }[][] = []
  containers.forEach((c, i) => {
    const lv = level(i)
    const enf: { entry: RsopEntry; blockedOut: boolean }[] = []
    for (const { link, gpo } of linksOf(c)) {
      const entry = { gpo, link, from: readableContainer(c, input.domainDn) }
      if (link.enforced) enf.push({ entry, blockedOut: false })
      else normal.push({ entry, blockedOut: blockAt > 0 && lv < blockAt })
    }
    enforced.push(enf)
  })
  // Los exigidos van al final; entre ellos gana el contenedor más alto, así que ese se procesa último.
  return [...normal, ...enforced.reverse().flat()]
}

export function computeRsop(input: RsopInput): RsopResult {
  const principals = new Set(input.principals.map((p) => p.toLowerCase()))
  principals.add('authenticated users')
  principals.add('nt authority\\authenticated users')
  principals.add('everyone')
  const computerSet = input.scope === 'User' && input.computerPrincipals ? new Set([...input.computerPrincipals.map((p) => p.toLowerCase()), 'authenticated users', 'everyone']) : undefined
  const applied: RsopEntry[] = []
  const filtered: (RsopEntry & { reason: FilterReason })[] = []
  for (const { entry, blockedOut } of processingOrder(input)) {
    const { gpo, link } = entry
    let reason: FilterReason | undefined
    if (blockedOut) reason = 'Blocked (Inheritance)'
    else if (!link.enabled) reason = 'Disabled (Link)'
    else if (!halfEnabled(gpo, input.scope)) reason = 'Disabled (GPO)'
    else if (!gpo.apply.some((a) => has(principals, a))) reason = 'Denied (Security)'
    else if (computerSet && ![...gpo.apply, ...(gpo.readers ?? [])].some((a) => has(computerSet, a))) reason = 'Denied (Security)'
    else if (gpo.wmi && !gpo.wmi.matches) reason = 'Denied (WMI Filter)'
    else if (!gpo.settings.some((s) => s.scope === input.scope)) reason = 'Not Applied (Empty)'
    if (reason) filtered.push({ ...entry, reason })
    else applied.push(entry)
  }
  // El último en procesarse gana.
  const winners = new Map<string, RsopWinner>()
  for (const { gpo } of applied) {
    for (const st of gpo.settings) {
      if (st.scope !== input.scope) continue
      const k = `${st.key.toLowerCase()}|${st.valueName.toLowerCase()}`
      const prev = winners.get(k)
      winners.set(k, { setting: st, gpo, losers: prev ? [{ gpo: prev.gpo, value: prev.setting.value }, ...prev.losers] : [] })
    }
  }
  return { applied: [...applied].reverse(), filtered: [...filtered].reverse(), settings: [...winners.values()] }
}
