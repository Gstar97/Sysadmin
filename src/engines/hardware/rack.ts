/** El constructor de rack: equipos, ubicación por unidades (U) y las reglas de un buen armado. */
export interface RackItemType {
  id: string
  nombre: string
  u: number
  peso: number
  watts: number
  tipo: 'servidor' | 'red' | 'patchera' | 'organizador' | 'ups' | 'almacenamiento' | 'consola'
}

export const RACK_CATALOG: RackItemType[] = [
  { id: 'srv1u', nombre: 'Servidor 1U', u: 1, peso: 17, watts: 250, tipo: 'servidor' },
  { id: 'srv2u', nombre: 'Servidor 2U', u: 2, peso: 28, watts: 400, tipo: 'servidor' },
  { id: 'nas', nombre: 'Almacenamiento 2U', u: 2, peso: 30, watts: 180, tipo: 'almacenamiento' },
  { id: 'sw', nombre: 'Switch 48 puertos 1U', u: 1, peso: 5, watts: 60, tipo: 'red' },
  { id: 'fw', nombre: 'Firewall 1U', u: 1, peso: 4, watts: 40, tipo: 'red' },
  { id: 'patch', nombre: 'Patchera 24 puertos 1U', u: 1, peso: 1, watts: 0, tipo: 'patchera' },
  { id: 'org', nombre: 'Organizador de cables 1U', u: 1, peso: 1, watts: 0, tipo: 'organizador' },
  { id: 'ups', nombre: 'UPS 3000 VA 2U', u: 2, peso: 40, watts: 0, tipo: 'ups' },
  { id: 'kvm', nombre: 'Consola (KVM) 1U', u: 1, peso: 12, watts: 25, tipo: 'consola' },
]

export interface Placed {
  key: string
  typeId: string
  /** Unidad de abajo que ocupa (la 1 es la de más abajo). */
  bottom: number
}

export function typeOf(id: string): RackItemType {
  return RACK_CATALOG.find((t) => t.id === id)!
}

export function occupied(placed: Placed[]): Map<number, Placed> {
  const m = new Map<number, Placed>()
  for (const p of placed) for (let u = p.bottom; u < p.bottom + typeOf(p.typeId).u; u++) m.set(u, p)
  return m
}

/** ¿Entra este equipo con su parte de abajo en esa unidad? */
export function fits(placed: Placed[], typeId: string, bottom: number, height: number, ignoreKey?: string): boolean {
  const t = typeOf(typeId)
  if (bottom < 1 || bottom + t.u - 1 > height) return false
  const occ = occupied(placed.filter((p) => p.key !== ignoreKey))
  for (let u = bottom; u < bottom + t.u; u++) if (occ.has(u)) return false
  return true
}

export interface RackCheck {
  id: string
  ok: boolean
  texto: string
}

/** Las reglas de un rack bien armado, en el orden en que conviene mirarlas. */
export function rackChecks(placed: Placed[], height: number, upsWatts = 2700): RackCheck[] {
  const items = placed.map((p) => ({ ...p, t: typeOf(p.typeId) })).sort((a, b) => a.bottom - b.bottom)
  const checks: RackCheck[] = []
  const ups = items.filter((i) => i.t.tipo === 'ups')
  if (ups.length) checks.push({ id: 'ups-abajo', ok: ups.every((u) => u.bottom <= Math.ceil(height / 4)), texto: 'Las UPS, en la parte de abajo (son lo más pesado: el rack no se vuelca y el piso aguanta)' })
  const heavy = items.filter((i) => i.t.peso >= 25 && i.t.tipo !== 'ups')
  const light = items.filter((i) => i.t.peso < 10 && i.t.tipo !== 'patchera' && i.t.tipo !== 'organizador')
  if (heavy.length && light.length) {
    const ok = Math.max(...heavy.map((h) => h.bottom)) < Math.min(...light.map((l) => l.bottom)) || heavy.every((h) => h.bottom <= height / 2)
    checks.push({ id: 'pesado-abajo', ok, texto: 'Lo pesado (servidores 2U, almacenamiento) en la mitad de abajo' })
  }
  const sw = items.filter((i) => i.t.tipo === 'red' && i.t.id === 'sw')
  const patch = items.filter((i) => i.t.tipo === 'patchera')
  if (sw.length && patch.length) {
    const near = sw.every((s) => patch.some((p) => Math.abs(p.bottom - s.bottom) <= 2))
    checks.push({ id: 'patchera', ok: near, texto: 'Cada switch con su patchera al lado (a una o dos unidades), así los cables cortos van de una al otro' })
  }
  if (sw.length) checks.push({ id: 'red-arriba', ok: sw.every((s) => s.bottom > height / 2), texto: 'Los equipos de red arriba, donde llegan los cables desde el techo o la bandeja' })
  const watts = items.reduce((s, i) => s + i.t.watts, 0)
  if (ups.length) checks.push({ id: 'potencia', ok: watts <= upsWatts * 0.8 * ups.length, texto: `La carga (${watts} W) no supera el 80 % de las UPS (${Math.round(upsWatts * 0.8 * ups.length)} W)` })
  // Huecos: unidades vacías entre equipos dejan que el aire caliente vuelva al frente.
  const occ = occupied(placed)
  if (items.length) {
    const top = Math.max(...items.map((i) => i.bottom + i.t.u - 1))
    const bottom = Math.min(...items.map((i) => i.bottom))
    let gaps = 0
    for (let u = bottom; u <= top; u++) if (!occ.has(u)) gaps++
    checks.push({ id: 'huecos', ok: gaps === 0, texto: gaps === 0 ? 'Sin huecos entre equipos (o tapados con paneles ciegos)' : `Hay ${gaps} U vacías entre equipos: van paneles ciegos para que el aire caliente no vuelva al frente` })
  }
  return checks
}

export function rackTotals(placed: Placed[]) {
  const items = placed.map((p) => typeOf(p.typeId))
  return { u: items.reduce((s, t) => s + t.u, 0), peso: items.reduce((s, t) => s + t.peso, 0), watts: items.reduce((s, t) => s + t.watts, 0) }
}
