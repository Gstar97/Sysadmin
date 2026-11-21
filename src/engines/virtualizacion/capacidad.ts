/**
 * Capacidad útil y tolerancia a fallas de distintas formas de organizar discos: espejos y RAIDZ
 * de ZFS (en un servidor) y réplicas o erasure coding de Ceph (repartido entre servidores).
 * Los números son aproximados: ZFS y Ceph reservan algo de espacio para funcionar bien.
 */
export type Esquema = 'mirror' | 'raidz1' | 'raidz2' | 'raidz3' | 'ceph3' | 'ceph2' | 'ec42'

export interface Entrada {
  /** Discos por servidor. */
  discos: number
  tamanoTb: number
  /** Servidores (para Ceph; ZFS es un servidor). */
  nodos: number
}

export interface Resultado {
  esquema: Esquema
  nombre: string
  crudoTb: number
  utilTb: number
  /** Lo que conviene llenar como máximo (ZFS 80 %, Ceph 85 % de lo que queda si se cae un nodo). */
  recomendadoTb: number
  aguanta: string
  /** Si con estos discos o nodos no se puede armar. */
  invalido?: string
  notas: string[]
}

export const ESQUEMAS: { id: Esquema; nombre: string }[] = [
  { id: 'mirror', nombre: 'ZFS en espejos (pares)' },
  { id: 'raidz1', nombre: 'ZFS RAIDZ1' },
  { id: 'raidz2', nombre: 'ZFS RAIDZ2' },
  { id: 'raidz3', nombre: 'ZFS RAIDZ3' },
  { id: 'ceph3', nombre: 'Ceph, 3 copias' },
  { id: 'ceph2', nombre: 'Ceph, 2 copias' },
  { id: 'ec42', nombre: 'Ceph, erasure coding 4+2' },
]

const r1 = (n: number) => Math.round(n * 10) / 10

export function calcular(e: Esquema, x: Entrada): Resultado {
  const nombre = ESQUEMAS.find((s) => s.id === e)!.nombre
  const zfs = !e.startsWith('ceph') && e !== 'ec42'
  const discos = zfs ? x.discos : x.discos * x.nodos
  const crudo = discos * x.tamanoTb
  const base: Resultado = { esquema: e, nombre, crudoTb: r1(crudo), utilTb: 0, recomendadoTb: 0, aguanta: '', notas: [] }
  if (zfs) {
    if (e === 'mirror') {
      if (x.discos < 2) return { ...base, invalido: 'Hacen falta al menos 2 discos.' }
      const pares = Math.floor(x.discos / 2)
      const util = pares * x.tamanoTb
      base.utilTb = r1(util)
      base.aguanta = `1 disco por espejo (hasta ${pares} si fallan en espejos distintos)`
      if (x.discos % 2) base.notas.push('Un disco queda afuera: los espejos van de a pares.')
      base.notas.push('La opción más rápida para VM y la que se reconstruye más rápido; se paga con la mitad del espacio.')
    } else {
      const p = Number(e.slice(-1))
      if (x.discos < p + 2) return { ...base, invalido: `RAIDZ${p} necesita al menos ${p + 2} discos para que tenga sentido.` }
      base.utilTb = r1((x.discos - p) * x.tamanoTb * 0.97)
      base.aguanta = `${p} disco${p > 1 ? 's' : ''} cualquiera${p > 1 ? '' : ''}`
      if (p === 1 && x.tamanoTb >= 4) base.notas.push('Con discos grandes, la reconstrucción tarda horas o días, y si falla otro disco mientras tanto se pierde todo: con discos de 4 TB o más, mejor RAIDZ2.')
      if (x.discos > 12) base.notas.push('Más de 10 a 12 discos en un solo RAIDZ hacen lentas las reconstrucciones: mejor dos grupos.')
      base.notas.push('Buena para archivos y respaldos; para muchas VM, los espejos dan más operaciones por segundo.')
    }
    base.recomendadoTb = r1(base.utilTb * 0.8)
    base.notas.push('ZFS anda mejor por debajo del 80 % de uso.')
    return base
  }
  if (x.nodos < 3) return { ...base, invalido: 'Ceph necesita al menos 3 servidores (por los monitores y las copias en hosts distintos).' }
  if (e === 'ec42') {
    if (x.nodos < 6) return { ...base, invalido: 'Erasure coding 4+2 reparte cada dato en 6 pedazos, cada uno en un servidor distinto: necesita al menos 6 (mejor 7).' }
    base.utilTb = r1((crudo * 4) / 6)
    base.aguanta = '2 servidores'
    base.notas.push('Aprovecha mejor el espacio, pero es más lento para escribir: se usa para respaldos y archivos, no para discos de VM.')
  } else {
    const copias = e === 'ceph3' ? 3 : 2
    base.utilTb = r1(crudo / copias)
    base.aguanta = copias === 3 ? '1 servidor completo (y sigue escribiendo con min_size 2)' : '1 servidor, pero sin margen: con min_size 2 se frena la escritura, y con min_size 1 se arriesgan los datos'
    if (copias === 2) base.notas.push('Dos copias es lo que más se lamenta en Ceph: una sola falla más durante la recuperación y se pierden datos. Lo recomendado es 3.')
  }
  // Si se cae un servidor, los datos se reubican en los que quedan: tiene que haber lugar.
  const porNodo = base.utilTb / x.nodos
  base.recomendadoTb = r1((base.utilTb - porNodo) * 0.85)
  base.notas.push('Ceph empieza a avisar al 85 % de uso y frena la escritura al 95 %. Y si se cae un servidor, sus datos tienen que entrar en los demás.')
  if (x.nodos === 3 && e === 'ceph3') base.notas.push('Con 3 servidores y 3 copias, si se cae uno no hay dónde rehacer la tercera copia: queda degradado hasta que vuelva. Con 4 o más, se recupera solo.')
  return base
}
