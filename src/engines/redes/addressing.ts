/** Clasificación de direcciones IPv4 y verificación de planes VLSM hechos por el estudiante. */
import { pick, randomInt, type Rng } from '@/lib/random'
import { formatIpv4, networkOf, parseCidr, parseIpv4, prefixForHosts, vlsm } from '@/engines/network/ip'

export type AddressKind = 'privada' | 'publica' | 'loopback' | 'apipa' | 'cgnat' | 'multicast' | 'documentacion' | 'broadcast'

export const ADDRESS_KINDS: { id: AddressKind; nombre: string; rango: string; explicacion: string }[] = [
  { id: 'privada', nombre: 'Privada', rango: '10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16', explicacion: 'Las privadas (RFC 1918) se usan dentro de las redes y no se enrutan en internet: para salir pasan por NAT.' },
  { id: 'publica', nombre: 'Pública', rango: 'el resto de las unicast', explicacion: 'Una dirección pública es única en todo internet y se puede alcanzar desde afuera.' },
  { id: 'loopback', nombre: 'Loopback', rango: '127.0.0.0/8', explicacion: 'Todo 127.x.x.x es el propio equipo: nunca sale a la red.' },
  { id: 'apipa', nombre: 'Enlace local (APIPA)', rango: '169.254.0.0/16', explicacion: 'Un equipo se pone una 169.254.x.x cuando pidió DHCP y nadie le contestó: es la señal típica de "no hay servidor DHCP".' },
  { id: 'cgnat', nombre: 'CGNAT', rango: '100.64.0.0/10', explicacion: 'El rango 100.64.0.0/10 (RFC 6598) lo usan los proveedores para compartir una IP pública entre muchos clientes.' },
  { id: 'multicast', nombre: 'Multicast', rango: '224.0.0.0/4', explicacion: 'De 224 a 239 en el primer número: un mensaje para un grupo de equipos (por ejemplo, OSPF usa 224.0.0.5).' },
  { id: 'documentacion', nombre: 'Documentación', rango: '192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24', explicacion: 'Reservadas para ejemplos en manuales (RFC 5737): no se usan en redes reales.' },
  { id: 'broadcast', nombre: 'Broadcast limitado', rango: '255.255.255.255', explicacion: '255.255.255.255 es "todos los equipos de esta red": la usa, por ejemplo, el primer mensaje de DHCP.' },
]

export function classify(ip: string): AddressKind | undefined {
  const n = parseIpv4(ip)
  if (n === undefined) return undefined
  const inR = (net: string, p: number) => networkOf(n, p) === parseIpv4(net)
  if (ip === '255.255.255.255') return 'broadcast'
  if (inR('10.0.0.0', 8) || inR('172.16.0.0', 12) || inR('192.168.0.0', 16)) return 'privada'
  if (inR('127.0.0.0', 8)) return 'loopback'
  if (inR('169.254.0.0', 16)) return 'apipa'
  if (inR('100.64.0.0', 10)) return 'cgnat'
  if (inR('224.0.0.0', 4)) return 'multicast'
  if (inR('192.0.2.0', 24) || inR('198.51.100.0', 24) || inR('203.0.113.0', 24)) return 'documentacion'
  return 'publica'
}

/** Una dirección al azar de un tipo, incluidas las trampas típicas (172.32.x.x es pública). */
export function randomAddress(rng: Rng): { ip: string; kind: AddressKind } {
  const r = (a: number, b: number) => randomInt(rng, a, b)
  const gens: (() => string)[] = [
    () => `10.${r(0, 255)}.${r(0, 255)}.${r(1, 254)}`,
    () => `172.${r(16, 31)}.${r(0, 255)}.${r(1, 254)}`,
    () => `192.168.${r(0, 255)}.${r(1, 254)}`,
    () => `172.${pick(rng, [15, 32, 33, 40])}.${r(0, 255)}.${r(1, 254)}`,
    () => `${pick(rng, [8, 23, 45, 81, 142, 186, 200])}.${r(0, 255)}.${r(0, 255)}.${r(1, 254)}`,
    () => `127.${r(0, 255)}.${r(0, 255)}.${r(1, 254)}`,
    () => `169.254.${r(1, 254)}.${r(1, 254)}`,
    () => `100.${r(64, 127)}.${r(0, 255)}.${r(1, 254)}`,
    () => `100.${pick(rng, [12, 63, 128, 150])}.${r(0, 255)}.${r(1, 254)}`,
    () => `${r(224, 239)}.${r(0, 255)}.${r(0, 255)}.${r(1, 254)}`,
    () => pick(rng, ['192.0.2', '198.51.100', '203.0.113']) + `.${r(1, 254)}`,
    () => '255.255.255.255',
    () => `192.169.${r(0, 255)}.${r(1, 254)}`,
  ]
  const ip = pick(rng, gens)()
  return { ip, kind: classify(ip)! }
}

// ---------------------------------------------------------------------------------------
// VLSM
// ---------------------------------------------------------------------------------------

export interface VlsmNeed {
  nombre: string
  hosts: number
}

export interface VlsmCheck {
  nombre: string
  ok: boolean
  problemas: string[]
  /** Hosts que entran en lo que puso el estudiante. */
  capacidad?: number
}

/** Revisa la subred que el estudiante asignó a cada área. */
export function checkVlsm(base: string, needs: VlsmNeed[], answers: string[]): VlsmCheck[] {
  const b = parseCidr(base)!
  const baseNet = networkOf(b.ip, b.prefix)
  const baseEnd = baseNet + 2 ** (32 - b.prefix) - 1
  const parsed = answers.map((a) => parseCidr(a.trim()))
  return needs.map((n, i) => {
    const problemas: string[] = []
    const p = parsed[i]
    if (!answers[i]?.trim()) return { nombre: n.nombre, ok: false, problemas: ['Falta la subred.'] }
    if (!p) return { nombre: n.nombre, ok: false, problemas: ['Escribila como red/prefijo, por ejemplo 192.168.20.0/26.'] }
    const size = 2 ** (32 - p.prefix)
    const capacidad = p.prefix >= 31 ? size : size - 2
    const net = networkOf(p.ip, p.prefix)
    if (net !== p.ip) problemas.push(`${formatIpv4(p.ip)} no es una dirección de red con /${p.prefix}: la red sería ${formatIpv4(net)}/${p.prefix} (cada bloque de ${size} empieza en un múltiplo de ${size}).`)
    if (capacidad < n.hosts) problemas.push(`Un /${p.prefix} tiene ${capacidad} direcciones utilizables y ${n.nombre} necesita ${n.hosts}: como mínimo hace falta un /${prefixForHosts(n.hosts)}.`)
    else if (p.prefix < prefixForHosts(n.hosts)) problemas.push(`Alcanza, pero sobra: con un /${prefixForHosts(n.hosts)} entran ${n.hosts} hosts y se desperdicia menos espacio.`)
    if (net < baseNet || net + size - 1 > baseEnd) problemas.push(`Está fuera de la red disponible ${base}.`)
    parsed.forEach((o, j) => {
      if (j === i || !o) return
      const on = networkOf(o.ip, o.prefix)
      const oe = on + 2 ** (32 - o.prefix) - 1
      if (net <= oe && on <= net + size - 1) problemas.push(`Se superpone con la de ${needs[j].nombre} (${answers[j].trim()}).`)
    })
    const fatal = problemas.filter((x) => !x.startsWith('Alcanza'))
    return { nombre: n.nombre, ok: fatal.length === 0, problemas, capacidad }
  })
}

/** La solución de referencia (de mayor a menor, cada una pegada a la anterior). */
export function vlsmSolution(base: string, needs: VlsmNeed[]): { nombre: string; red: string; hosts: number; capacidad: number }[] | undefined {
  const b = parseCidr(base)!
  const r = vlsm(networkOf(b.ip, b.prefix), b.prefix, needs.map((n) => ({ name: n.nombre, hosts: n.hosts })))
  if (!r) return undefined
  return r.map((a) => ({ nombre: a.name, red: `${formatIpv4(a.network)}/${a.prefix}`, hosts: a.hosts, capacidad: 2 ** (32 - a.prefix) - 2 }))
}

export function randomVlsm(rng: Rng): { base: string; needs: VlsmNeed[] } {
  const areas = ['Ventas', 'Administración', 'Depósito', 'IT', 'Gerencia', 'Invitados', 'Servidores', 'Enlace WAN']
  for (;;) {
    const base = `${pick(rng, ['192.168', '172.16', '10.20'])}.${randomInt(rng, 0, 50) * (rng() < 0.5 ? 1 : 2)}.0/24`
    const k = randomInt(rng, 3, 5)
    const chosen = [...areas].sort(() => rng() - 0.5).slice(0, k)
    const needs = chosen.map((nombre) => ({ nombre, hosts: nombre === 'Enlace WAN' ? 2 : randomInt(rng, 5, 100) }))
    if (vlsmSolution(base, needs)) return { base, needs }
  }
}
