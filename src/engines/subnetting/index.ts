/**
 * Generador y corrector de ejercicios de subnetting (IPv4 e IPv6) con explicación paso a paso.
 */
import { pick, randomInt, type Rng } from '@/lib/random'
import {
  broadcastOf,
  compressIpv6,
  expandIpv6,
  formatIpv4,
  ipv6Network,
  maskToPrefix,
  networkOf,
  parseIpv4,
  prefixForHosts,
  prefixToMask,
  sameSubnet,
  subnetInfo,
  toBinary,
  vlsm,
} from '@/engines/network/ip'

export type SubnetExerciseType =
  | 'red'
  | 'broadcast'
  | 'rango'
  | 'hosts'
  | 'mascara'
  | 'subredes'
  | 'wildcard'
  | 'misma_red'
  | 'vlsm'
  | 'sumarizacion'
  | 'ipv6_abreviar'
  | 'ipv6_expandir'
  | 'ipv6_red'

export const SUBNET_TYPES: { id: SubnetExerciseType; nombre: string }[] = [
  { id: 'red', nombre: 'Dirección de red' },
  { id: 'broadcast', nombre: 'Broadcast' },
  { id: 'rango', nombre: 'Rango de hosts' },
  { id: 'hosts', nombre: 'Cantidad de hosts' },
  { id: 'mascara', nombre: 'Máscara según hosts' },
  { id: 'subredes', nombre: 'Dividir en subredes' },
  { id: 'wildcard', nombre: 'Wildcard' },
  { id: 'misma_red', nombre: '¿Misma red?' },
  { id: 'vlsm', nombre: 'VLSM' },
  { id: 'sumarizacion', nombre: 'Sumarización' },
  { id: 'ipv6_abreviar', nombre: 'IPv6: abreviar' },
  { id: 'ipv6_expandir', nombre: 'IPv6: expandir' },
  { id: 'ipv6_red', nombre: 'IPv6: prefijo de red' },
]

export type Difficulty = 1 | 2 | 3

export type FieldFormat = 'ipv4' | 'prefijo' | 'numero' | 'si_no' | 'ipv6'

export interface Field {
  id: string
  etiqueta: string
  formato: FieldFormat
  respuesta: string
}

export interface SubnetExercise {
  tipo: SubnetExerciseType
  enunciado: string
  campos: Field[]
  pasos: string[]
}

// ---------------------------------------------------------------------------------------
// Corrección
// ---------------------------------------------------------------------------------------

/** Acepta "/26", "26" o "255.255.255.192" y devuelve el prefijo. */
export function parsePrefix(text: string): number | undefined {
  const t = text.trim()
  const m = /^\/?(\d{1,2})$/.exec(t)
  if (m) {
    const n = Number(m[1])
    return n <= 32 ? n : undefined
  }
  const mask = parseIpv4(t)
  return mask === undefined ? undefined : maskToPrefix(mask)
}

export function checkField(field: Field, answer: string): boolean {
  const a = answer.trim()
  if (!a) return false
  switch (field.formato) {
    case 'ipv4': {
      const v = parseIpv4(a)
      return v !== undefined && v === parseIpv4(field.respuesta)
    }
    case 'prefijo': {
      const p = parsePrefix(a)
      return p !== undefined && p === parsePrefix(field.respuesta)
    }
    case 'numero':
      return Number(a.replace(/[.\s]/g, '')) === Number(field.respuesta)
    case 'si_no':
      return /^s[ií]?$/i.test(a) ? field.respuesta === 'sí' : /^no?$/i.test(a) ? field.respuesta === 'no' : false
    case 'ipv6': {
      const [addr, pre] = a.split('/')
      const [eaddr, epre] = field.respuesta.split('/')
      if (pre !== epre) return false
      const x = expandIpv6(addr)
      return !!x && x === expandIpv6(eaddr)
    }
  }
}

// ---------------------------------------------------------------------------------------
// Generación
// ---------------------------------------------------------------------------------------

function pickPrefix(r: R, d: Difficulty): number {
  if (d === 1) return r.pick([8, 16, 24, 24, 25, 26])
  if (d === 2) return r.int(24, 30)
  return r.pick([r.int(17, 23), r.int(25, 30), r.int(12, 16)])
}

function privateHost(r: R, prefix: number): number {
  const base = r.pick(['10', '172', '192'])
  let ip: number
  if (base === '10') ip = parseIpv4(`10.${r.int(0, 255)}.${r.int(0, 255)}.${r.int(0, 255)}`)!
  else if (base === '172') ip = parseIpv4(`172.${r.int(16, 31)}.${r.int(0, 255)}.${r.int(0, 255)}`)!
  else ip = parseIpv4(`192.168.${r.int(0, 255)}.${r.int(0, 255)}`)!
  // Evitar que salga justo la red o el broadcast.
  const info = subnetInfo(ip, prefix)
  if (prefix < 31 && (ip === info.network || ip === info.broadcast)) return info.firstHost + Math.floor((info.lastHost - info.firstHost) / 2)
  return ip
}

function cidr(ip: number, prefix: number) {
  return `${formatIpv4(ip)}/${prefix}`
}

/** Octeto "interesante": el primero que la máscara no cubre por completo. */
function interestingOctet(prefix: number) {
  return Math.min(3, Math.floor(prefix / 8))
}

function blockExplanation(ip: number, prefix: number): string[] {
  const octet = interestingOctet(prefix)
  const maskOctet = (prefixToMask(prefix) >>> (24 - octet * 8)) & 255
  const block = 256 - maskOctet
  const value = (ip >>> (24 - octet * 8)) & 255
  const start = Math.floor(value / block) * block
  const names = ['primer', 'segundo', 'tercer', 'cuarto']
  if (prefix % 8 === 0) return [`Con /${prefix} la máscara termina justo en un octeto: la red es la IP con los octetos de host en 0.`]
  return [
    `Atajo: el octeto interesante es el ${names[octet]} (máscara ${maskOctet}). Tamaño del bloque: 256 − ${maskOctet} = ${block}.`,
    `Los bloques empiezan en 0, ${block}, ${block * 2}, ${block * 3}… El valor ${value} cae en el bloque que empieza en ${start} y termina en ${start + block - 1}.`,
  ]
}

function binarySteps(ip: number, prefix: number): string[] {
  const net = networkOf(ip, prefix)
  return [
    `IP en binario:      ${toBinary(ip)}`,
    `Máscara /${prefix}:${' '.repeat(Math.max(1, 10 - String(prefix).length))}${toBinary(prefixToMask(prefix))}`,
    `AND bit a bit:      ${toBinary(net)} → ${formatIpv4(net)}`,
  ]
}

interface R {
  int(min: number, max: number): number
  pick<T>(items: readonly T[]): T
  next(): number
}

export function generateExercise(rng: Rng, tipo: SubnetExerciseType, d: Difficulty): SubnetExercise {
  const r: R = { int: (a, b) => randomInt(rng, a, b), pick: (items) => pick(rng, items), next: rng }
  switch (tipo) {
    case 'red': {
      const prefix = pickPrefix(r, d)
      const ip = privateHost(r, prefix)
      const net = networkOf(ip, prefix)
      return {
        tipo,
        enunciado: `¿Cuál es la dirección de red de ${cidr(ip, prefix)}?`,
        campos: [{ id: 'red', etiqueta: 'Dirección de red', formato: 'ipv4', respuesta: formatIpv4(net) }],
        pasos: [...binarySteps(ip, prefix), ...blockExplanation(ip, prefix)],
      }
    }
    case 'broadcast': {
      const prefix = pickPrefix(r, d)
      const ip = privateHost(r, prefix)
      const bc = broadcastOf(ip, prefix)
      return {
        tipo,
        enunciado: `¿Cuál es la dirección de broadcast de ${cidr(ip, prefix)}?`,
        campos: [{ id: 'bc', etiqueta: 'Broadcast', formato: 'ipv4', respuesta: formatIpv4(bc) }],
        pasos: [
          `Red: ${formatIpv4(networkOf(ip, prefix))} (IP AND máscara).`,
          `El broadcast tiene todos los bits de host en 1: ${toBinary(bc)} → ${formatIpv4(bc)}.`,
          ...blockExplanation(ip, prefix),
          'El broadcast es la última dirección del bloque.',
        ],
      }
    }
    case 'rango': {
      const prefix = pickPrefix(r, d === 1 ? 2 : d)
      const ip = privateHost(r, Math.min(prefix, 30))
      const info = subnetInfo(ip, Math.min(prefix, 30))
      return {
        tipo,
        enunciado: `¿Cuál es el rango de hosts utilizables de ${cidr(ip, info.prefix)}?`,
        campos: [
          { id: 'primero', etiqueta: 'Primer host', formato: 'ipv4', respuesta: formatIpv4(info.firstHost) },
          { id: 'ultimo', etiqueta: 'Último host', formato: 'ipv4', respuesta: formatIpv4(info.lastHost) },
        ],
        pasos: [`Red: ${formatIpv4(info.network)} · Broadcast: ${formatIpv4(info.broadcast)}.`, 'El primer host es la red + 1 y el último es el broadcast − 1.', ...blockExplanation(ip, info.prefix)],
      }
    }
    case 'hosts': {
      const prefix = d === 1 ? r.pick([24, 25, 26, 27, 28]) : d === 2 ? r.int(20, 30) : r.int(9, 30)
      const hostBits = 32 - prefix
      return {
        tipo,
        enunciado: `¿Cuántos hosts utilizables tiene una red /${prefix}?`,
        campos: [{ id: 'hosts', etiqueta: 'Hosts utilizables', formato: 'numero', respuesta: String(2 ** hostBits - 2) }],
        pasos: [`Bits de host: 32 − ${prefix} = ${hostBits}.`, `Direcciones totales: 2^${hostBits} = ${2 ** hostBits}.`, `Se restan 2 (red y broadcast): ${2 ** hostBits} − 2 = ${2 ** hostBits - 2}.`],
      }
    }
    case 'mascara': {
      const hosts = d === 1 ? r.pick([10, 25, 50, 100, 200]) : d === 2 ? r.int(3, 500) : r.int(500, 60000)
      const prefix = prefixForHosts(hosts)
      return {
        tipo,
        enunciado: `Una red necesita ${hosts} hosts. ¿Cuál es la máscara más pequeña (con menos direcciones) que alcanza?`,
        campos: [{ id: 'mascara', etiqueta: 'Máscara o prefijo', formato: 'prefijo', respuesta: `/${prefix}` }],
        pasos: [
          `Se busca el menor n tal que 2^n − 2 ≥ ${hosts}.`,
          `2^${32 - prefix} − 2 = ${2 ** (32 - prefix) - 2} alcanza${32 - prefix > 2 ? `; 2^${31 - prefix} − 2 = ${2 ** (31 - prefix) - 2} no alcanza` : ''}.`,
          `Bits de host: ${32 - prefix} → prefijo /${prefix} = ${formatIpv4(prefixToMask(prefix))}.`,
        ],
      }
    }
    case 'subredes': {
      const basePrefix = d === 1 ? 24 : d === 2 ? r.pick([16, 20, 22, 24]) : r.int(12, 24)
      const bits = r.int(1, Math.min(d === 1 ? 3 : 6, 30 - basePrefix))
      const needed = r.int(2 ** (bits - 1) + 1, 2 ** bits)
      const ip = networkOf(privateHost(r, basePrefix), basePrefix)
      const newPrefix = basePrefix + bits
      const size = 2 ** (32 - newPrefix)
      return {
        tipo,
        enunciado: `Hay que dividir ${cidr(ip, basePrefix)} en al menos ${needed} subredes del mismo tamaño. ¿Qué prefijo tienen las subredes y cuántos hosts entran en cada una?`,
        campos: [
          { id: 'prefijo', etiqueta: 'Nuevo prefijo', formato: 'prefijo', respuesta: `/${newPrefix}` },
          { id: 'hosts', etiqueta: 'Hosts por subred', formato: 'numero', respuesta: String(size - 2) },
        ],
        pasos: [
          `Se piden bits prestados: el menor n tal que 2^n ≥ ${needed} → n = ${bits} (2^${bits} = ${2 ** bits} subredes).`,
          `Nuevo prefijo: ${basePrefix} + ${bits} = /${newPrefix} (${formatIpv4(prefixToMask(newPrefix))}).`,
          `Cada subred tiene 2^${32 - newPrefix} = ${size} direcciones → ${size - 2} hosts utilizables.`,
          `Las primeras subredes: ${[0, 1, 2].filter((i) => i < 2 ** bits).map((i) => cidr((ip + i * size) >>> 0, newPrefix)).join(', ')}…`,
        ],
      }
    }
    case 'wildcard': {
      const prefix = d === 1 ? r.pick([8, 16, 24, 30]) : r.int(16, 30)
      const mask = prefixToMask(prefix)
      const wc = ~mask >>> 0
      return {
        tipo,
        enunciado: `¿Cuál es la wildcard (máscara comodín) de ${formatIpv4(mask)}? (se usa en ACL y en "network" de OSPF)`,
        campos: [{ id: 'wc', etiqueta: 'Wildcard', formato: 'ipv4', respuesta: formatIpv4(wc) }],
        pasos: ['La wildcard es la máscara invertida: cada octeto es 255 menos el de la máscara.', `${formatIpv4(mask)} → ${formatIpv4(wc)}.`],
      }
    }
    case 'misma_red': {
      const prefix = pickPrefix(r, d === 1 ? 2 : d)
      const a = privateHost(r, prefix)
      const size = 2 ** (32 - prefix)
      const same = r.next() < 0.5
      let b = same ? networkOf(a, prefix) + 1 + r.int(0, Math.max(0, size - 3)) : (a + size * r.pick([1, -1])) >>> 0
      if (!same && sameSubnet(a, b, prefix)) b = (b + size) >>> 0
      const res = sameSubnet(a, b, prefix)
      return {
        tipo,
        enunciado: `Con máscara /${prefix} (${formatIpv4(prefixToMask(prefix))}), ¿${formatIpv4(a)} y ${formatIpv4(b)} están en la misma red? Responde sí o no.`,
        campos: [{ id: 'misma', etiqueta: '¿Misma red?', formato: 'si_no', respuesta: res ? 'sí' : 'no' }],
        pasos: [`Red de ${formatIpv4(a)}: ${formatIpv4(networkOf(a, prefix))}.`, `Red de ${formatIpv4(b)}: ${formatIpv4(networkOf(b >>> 0, prefix))}.`, res ? 'Las dos redes coinciden: se comunican sin pasar por un router.' : 'Las redes son distintas: necesitan un router (o puerta de enlace) para comunicarse.'],
      }
    }
    case 'vlsm': {
      const base = networkOf(privateHost(r, 24), 24)
      const count = d === 1 ? 2 : d === 2 ? 3 : 4
      const sizes = [r.int(60, 120), r.int(20, 58), r.int(8, 28), r.int(2, 6)].slice(0, count)
      const names = ['Ventas', 'Administración', 'Soporte', 'Enlace WAN'].slice(0, count)
      const needs = sizes.map((h, i) => ({ name: names[i], hosts: h }))
      const plan = vlsm(base, 24, needs)!
      return {
        tipo,
        enunciado: `Con la red ${cidr(base, 24)} y asignando de mayor a menor (VLSM), ¿qué subred le toca a cada área? Necesidades: ${needs.map((n) => `${n.name} ${n.hosts} hosts`).join(', ')}.`,
        campos: plan.flatMap((p): Field[] => [
          { id: p.name, etiqueta: `${p.name}: red`, formato: 'ipv4', respuesta: formatIpv4(p.network) },
          { id: `${p.name}-p`, etiqueta: `${p.name}: prefijo`, formato: 'prefijo', respuesta: `/${p.prefix}` },
        ]),
        pasos: [
          'Se ordenan las necesidades de mayor a menor y se asigna cada bloque al principio del espacio libre.',
          ...plan.map((p) => `${p.name}: ${p.hosts} hosts → /${p.prefix} (${2 ** (32 - p.prefix) - 2} hosts) → ${cidr(p.network, p.prefix)}, broadcast ${formatIpv4(broadcastOf(p.network, p.prefix))}.`),
        ],
      }
    }
    case 'sumarizacion': {
      const prefix = d === 1 ? 24 : r.pick([24, 25, 26])
      const n = d === 3 ? r.pick([4, 8]) : r.pick([2, 4])
      const summaryPrefix = prefix - Math.log2(n)
      const start = networkOf(privateHost(r, summaryPrefix), summaryPrefix)
      const size = 2 ** (32 - prefix)
      const nets = Array.from({ length: n }, (_, i) => cidr((start + i * size) >>> 0, prefix))
      return {
        tipo,
        enunciado: `¿Cuál es la ruta sumarizada más específica que cubre exactamente estas redes? ${nets.join(', ')}`,
        campos: [
          { id: 'red', etiqueta: 'Red sumarizada', formato: 'ipv4', respuesta: formatIpv4(start) },
          { id: 'prefijo', etiqueta: 'Prefijo', formato: 'prefijo', respuesta: `/${summaryPrefix}` },
        ],
        pasos: [`Son ${n} redes contiguas de /${prefix}: se agrupan quitando log2(${n}) = ${Math.log2(n)} ${Math.log2(n) === 1 ? 'bit' : 'bits'} del prefijo.`, `Bits en común: /${summaryPrefix}. La red resumen empieza en la primera: ${cidr(start, summaryPrefix)}.`, `Comprobación: ${cidr(start, summaryPrefix)} va de ${formatIpv4(start)} a ${formatIpv4(broadcastOf(start, summaryPrefix))}.`],
      }
    }
    case 'ipv6_abreviar':
    case 'ipv6_expandir': {
      const groups = Array.from({ length: 8 }, (_, i) => (i === 0 ? '2001' : i === 1 ? 'db8' : r.next() < 0.45 ? '0' : r.int(0, 0xffff).toString(16)))
      if (!groups.slice(2).some((g, i, arr) => g === '0' && arr[i + 1] === '0')) {
        const at = r.int(2, 6)
        groups[at] = '0'
        groups[at + 1] = '0'
      }
      const full = expandIpv6(groups.join(':'))!
      const short = compressIpv6(full)!
      if (tipo === 'ipv6_abreviar') {
        return {
          tipo,
          enunciado: `Escribe en su forma abreviada (RFC 5952): ${full}`,
          campos: [{ id: 'v6', etiqueta: 'Dirección abreviada', formato: 'ipv6', respuesta: short }],
          pasos: ['Regla 1: se quitan los ceros a la izquierda de cada grupo (0db8 → db8, 0000 → 0).', 'Regla 2: la secuencia más larga de grupos en 0 se reemplaza por "::" (una sola vez).', `Resultado: ${short}`],
        }
      }
      return {
        tipo,
        enunciado: `Escribe la forma completa (8 grupos de 4 dígitos) de: ${short}`,
        campos: [{ id: 'v6', etiqueta: 'Dirección completa', formato: 'ipv6', respuesta: full }],
        pasos: ['Se completa cada grupo con ceros a la izquierda hasta tener 4 dígitos.', `El "::" representa los grupos en 0 que faltan para llegar a 8: ${8 - short.split(':').filter(Boolean).length} grupos.`, `Resultado: ${full}`],
      }
    }
    case 'ipv6_red': {
      const prefix = r.pick([48, 56, 64])
      const addr = compressIpv6(`2001:db8:${r.int(0, 0xffff).toString(16)}:${r.int(0, 0xffff).toString(16)}:${r.int(0, 0xffff).toString(16)}:${r.int(0, 0xffff).toString(16)}:${r.int(0, 0xffff).toString(16)}:${r.int(1, 0xffff).toString(16)}`)!
      const net = ipv6Network(addr, prefix)!
      return {
        tipo,
        enunciado: `¿Cuál es el prefijo de red de ${addr}/${prefix}? (escríbelo con su /${prefix})`,
        campos: [{ id: 'v6', etiqueta: 'Prefijo de red', formato: 'ipv6', respuesta: `${net}/${prefix}` }],
        pasos: [`Cada grupo tiene 16 bits: /${prefix} son los primeros ${prefix / 16} grupos${prefix % 16 ? ' y parte del siguiente' : ''}.`, 'El resto se pone en 0 y se abrevia.', `Resultado: ${net}/${prefix}`],
      }
    }
  }
}

export function mask(prefix: number) {
  return formatIpv4(prefixToMask(prefix))
}
