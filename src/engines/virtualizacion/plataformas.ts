/**
 * Comparar plataformas de virtualización: una matriz de decisión con pesos (lo que importa en cada
 * empresa) y el costo de las licencias en un período, con los precios que cada uno complete. Los
 * puntajes son orientativos (de este curso) y los precios cambian: se editan.
 */
export type Plataforma = 'proxmox' | 'vsphere' | 'hyperv'

export const PLATAFORMAS: { id: Plataforma; nombre: string }[] = [
  { id: 'proxmox', nombre: 'Proxmox VE' },
  { id: 'vsphere', nombre: 'VMware vSphere (VVF)' },
  { id: 'hyperv', nombre: 'Hyper-V (Windows Server Datacenter)' },
]

export interface Criterio {
  id: string
  nombre: string
  detalle: string
  puntajes: Record<Plataforma, number>
}

export const CRITERIOS: Criterio[] = [
  { id: 'costo', nombre: 'Costo de licencias', detalle: 'Lo que cuesta el hipervisor en sí (el cálculo de abajo lo hace con tus números).', puntajes: { proxmox: 5, vsphere: 1, hyperv: 3 } },
  { id: 'ha', nombre: 'Alta disponibilidad y migración', detalle: 'Clúster, migración en vivo, reinicio automático de VM en otro nodo, balanceo.', puntajes: { proxmox: 4, vsphere: 5, hyperv: 4 } },
  { id: 'backup', nombre: 'Ecosistema de respaldo', detalle: 'Herramientas de respaldo de terceros que lo soportan, además de las propias.', puntajes: { proxmox: 4, vsphere: 5, hyperv: 5 } },
  { id: 'soporte', nombre: 'Soporte comercial', detalle: 'Soporte del fabricante y de empresas locales que lo conozcan.', puntajes: { proxmox: 3, vsphere: 4, hyperv: 4 } },
  { id: 'facil', nombre: 'Facilidad de operación', detalle: 'Instalar, administrar el día a día y actualizar.', puntajes: { proxmox: 4, vsphere: 4, hyperv: 3 } },
  { id: 'windows', nombre: 'Integración con Windows', detalle: 'Active Directory, administración desde las herramientas de Microsoft, VM con Windows.', puntajes: { proxmox: 3, vsphere: 4, hyperv: 5 } },
  { id: 'linux', nombre: 'Linux y contenedores', detalle: 'Contenedores LXC, herramientas de Linux, automatización con código abierto.', puntajes: { proxmox: 5, vsphere: 3, hyperv: 3 } },
  { id: 'escala', nombre: 'Escala grande', detalle: 'Cientos de servidores, almacenamiento definido por software, redes virtuales avanzadas.', puntajes: { proxmox: 3, vsphere: 5, hyperv: 4 } },
  { id: 'equipo', nombre: 'Lo que ya sabe el equipo', detalle: 'Cambiá estos puntajes según tu gente: es el criterio que más se subestima.', puntajes: { proxmox: 3, vsphere: 3, hyperv: 3 } },
]

export function puntaje(pesos: Record<string, number>, puntajes: Record<string, Record<Plataforma, number>> = Object.fromEntries(CRITERIOS.map((c) => [c.id, c.puntajes]))): Record<Plataforma, number> {
  const out = { proxmox: 0, vsphere: 0, hyperv: 0 }
  const total = CRITERIOS.reduce((s, c) => s + (pesos[c.id] ?? 0) * 5, 0)
  if (!total) return out
  for (const p of PLATAFORMAS) out[p.id] = Math.round((CRITERIOS.reduce((s, c) => s + (pesos[c.id] ?? 0) * (puntajes[c.id]?.[p.id] ?? 0), 0) / total) * 100)
  return out
}

export interface Infra {
  hosts: number
  /** Procesadores (zócalos) por servidor. */
  zocalos: number
  nucleosPorZocalo: number
  anios: number
  /** Hay VM con Windows Server: hace falta licenciar Windows Server Datacenter en cada host, con cualquier hipervisor. */
  vmsWindows: boolean
}

export interface Precios {
  /** VMware vSphere Foundation: por núcleo y por año. */
  vsphereNucleoAnio: number
  /** Windows Server Datacenter: licencia de 16 núcleos (pago único). */
  windows16: number
  /** Suscripción de Proxmox por zócalo y por año (0 si se usa sin suscripción). */
  proxmoxZocaloAnio: number
}

export interface Costo {
  plataforma: Plataforma
  hipervisor: number
  windows: number
  total: number
  detalle: string[]
}

/** Núcleos de Windows Server a licenciar en un host: todos, con mínimo 8 por procesador y 16 por servidor. */
export function nucleosWindows(i: Infra) {
  const n = i.nucleosPorZocalo + (i.nucleosPorZocalo % 2)
  return Math.max(16, i.zocalos * Math.max(8, n))
}

/** Núcleos de VMware a licenciar en un host: mínimo 16 por procesador. */
export function nucleosVsphere(i: Infra) {
  return i.zocalos * Math.max(16, i.nucleosPorZocalo)
}

export function costos(i: Infra, p: Precios): Costo[] {
  const winNucleos = nucleosWindows(i) * i.hosts
  const winCosto = (winNucleos / 16) * p.windows16
  const fmt = (n: number) => Math.round(n).toLocaleString('es-AR')
  const out: Costo[] = []
  const pveHip = i.hosts * i.zocalos * p.proxmoxZocaloAnio * i.anios
  out.push({ plataforma: 'proxmox', hipervisor: pveHip, windows: i.vmsWindows ? winCosto : 0, total: pveHip + (i.vmsWindows ? winCosto : 0), detalle: [p.proxmoxZocaloAnio ? `Suscripción: ${i.hosts * i.zocalos} zócalos × ${fmt(p.proxmoxZocaloAnio)} × ${i.anios} años` : 'Sin suscripción: el software es libre y gratuito (sin soporte ni repositorio enterprise).'] })
  const vNucleos = nucleosVsphere(i) * i.hosts
  const vHip = vNucleos * p.vsphereNucleoAnio * i.anios
  out.push({ plataforma: 'vsphere', hipervisor: vHip, windows: i.vmsWindows ? winCosto : 0, total: vHip + (i.vmsWindows ? winCosto : 0), detalle: [`Suscripción: ${vNucleos} núcleos (mínimo 16 por procesador) × ${fmt(p.vsphereNucleoAnio)} × ${i.anios} años`] })
  out.push({ plataforma: 'hyperv', hipervisor: winCosto, windows: 0, total: winCosto, detalle: [`Windows Server Datacenter: ${winNucleos} núcleos (mínimo 16 por servidor) = ${winNucleos / 16} licencias de 16 núcleos. Incluye Hyper-V y todas las VM con Windows Server de esos hosts.`] })
  if (i.vmsWindows) for (const c of out.slice(0, 2)) c.detalle.push(`Más Windows Server Datacenter para las VM con Windows: ${winNucleos} núcleos (se licencian los núcleos físicos del host, sea cual sea el hipervisor).`)
  return out
}
