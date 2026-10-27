/** Sistemas numéricos: conversiones entre bases con explicación paso a paso y ejercicios. */
import { pick, randomInt, type Rng } from '@/lib/random'

export type Base = 2 | 8 | 10 | 16

export const BASE_NAMES: Record<Base, string> = { 2: 'binario', 8: 'octal', 10: 'decimal', 16: 'hexadecimal' }

const DIGITS = '0123456789ABCDEF'

export function toBase(n: number, base: Base, minDigits = 1): string {
  return n.toString(base).toUpperCase().padStart(minDigits, '0')
}

/** Interpreta un número escrito en una base. Acepta prefijos 0b, 0x y 0o, espacios y puntos separadores. */
export function fromBase(text: string, base: Base): number | undefined {
  let t = text.trim().replace(/[\s._]/g, '').toUpperCase()
  if (base === 16) t = t.replace(/^0X/, '')
  if (base === 2) t = t.replace(/^0B/, '')
  if (base === 8) t = t.replace(/^0O/, '')
  if (!t) return undefined
  const valid = DIGITS.slice(0, base)
  if ([...t].some((c) => !valid.includes(c))) return undefined
  return parseInt(t, base)
}

/** Agrupa los bits de a 4 (o del tamaño indicado) para leerlos mejor: 1100 0000. */
export function groupBits(bits: string, size = 4): string {
  const padded = bits.padStart(Math.ceil(bits.length / size) * size, '0')
  return padded.match(new RegExp(`.{${size}}`, 'g'))!.join(' ')
}

/** Pasos para convertir un número de una base a otra, como se haría a mano. */
export function explainConversion(n: number, from: Base, to: Base): string[] {
  const steps: string[] = []
  const shown = toBase(n, from)
  if (from === 10 && to === 2) {
    const bits = Math.max(8, n.toString(2).length)
    const weights = Array.from({ length: bits }, (_, i) => 2 ** (bits - 1 - i))
    steps.push(`Pesos de cada posición: ${weights.join(' · ')}.`)
    let rest = n
    const used: string[] = []
    for (const w of weights) {
      if (rest >= w) {
        used.push(`${w} cabe en ${rest} → bit en 1 (queda ${rest - w})`)
        rest -= w
      }
    }
    steps.push(...(used.length ? used : ['El número es 0: todos los bits en 0.']))
    steps.push(`Las posiciones que no se usaron van en 0: ${groupBits(n.toString(2).padStart(bits, '0'))}.`)
    return steps
  }
  if (from === 2 && to === 10) {
    const bits = n.toString(2)
    const terms = [...bits].map((b, i) => ({ b, w: 2 ** (bits.length - 1 - i) })).filter((x) => x.b === '1')
    steps.push(`Cada bit en 1 suma el peso de su posición (de derecha a izquierda: 1, 2, 4, 8, 16, 32, 64, 128...).`)
    steps.push(terms.length ? `${terms.map((t) => t.w).join(' + ')} = ${n}` : 'No hay bits en 1: el valor es 0.')
    return steps
  }
  if ((from === 2 && to === 16) || (from === 16 && to === 2)) {
    const bits = groupBits(n.toString(2))
    const hex = toBase(n, 16)
    steps.push('Cada dígito hexadecimal equivale exactamente a 4 bits (0000 = 0 … 1111 = F).')
    const pairs = bits.split(' ').map((g) => `${g} = ${parseInt(g, 2).toString(16).toUpperCase()}`)
    steps.push(from === 2 ? `Se agrupan los bits de a 4 desde la derecha: ${pairs.join(', ')}.` : `Se reemplaza cada dígito por sus 4 bits: ${pairs.map((p) => p.split(' = ').reverse().join(' = ')).join(', ')}.`)
    steps.push(`Resultado: ${from === 2 ? hex : bits}.`)
    return steps
  }
  if ((from === 2 && to === 8) || (from === 8 && to === 2)) {
    const bits = groupBits(n.toString(2), 3)
    steps.push('Cada dígito octal equivale a 3 bits (000 = 0 … 111 = 7).')
    steps.push(`Grupos de 3 bits: ${bits.split(' ').map((g) => `${g} = ${parseInt(g, 2)}`).join(', ')}.`)
    steps.push(`Resultado: ${from === 2 ? toBase(n, 8) : bits}.`)
    return steps
  }
  if (to === 10) {
    const digits = [...shown]
    const terms = digits.map((d, i) => `${parseInt(d, from)}×${from}^${digits.length - 1 - i}`)
    steps.push(`Cada dígito se multiplica por la potencia de ${from} de su posición: ${terms.join(' + ')}.`)
    steps.push(`= ${digits.map((d, i) => parseInt(d, from) * from ** (digits.length - 1 - i)).join(' + ')} = ${n}.`)
    return steps
  }
  if (from === 10) {
    const rems: string[] = []
    let q = n
    if (q === 0) rems.push('0')
    while (q > 0) {
      rems.push(`${q} ÷ ${to} = ${Math.floor(q / to)}, resto ${DIGITS[q % to]}`)
      q = Math.floor(q / to)
    }
    steps.push(`Se divide por ${to} hasta llegar a 0 y se anotan los restos:`)
    steps.push(...rems)
    steps.push(`Los restos leídos de abajo hacia arriba dan ${toBase(n, to)}.`)
    return steps
  }
  // Entre 8 y 16: se pasa por binario.
  return [...explainConversion(n, from, 2).slice(0, -1), ...explainConversion(n, 2, to)]
}

export interface NumberExercise {
  from: Base
  to: Base
  value: number
  pregunta: string
  respuesta: string
  pasos: string[]
}

export type ConversionKind = 'dec-bin' | 'bin-dec' | 'dec-hex' | 'hex-dec' | 'bin-hex' | 'hex-bin' | 'dec-oct' | 'oct-bin'

export const CONVERSIONS: { id: ConversionKind; nombre: string; from: Base; to: Base }[] = [
  { id: 'dec-bin', nombre: 'Decimal → binario', from: 10, to: 2 },
  { id: 'bin-dec', nombre: 'Binario → decimal', from: 2, to: 10 },
  { id: 'dec-hex', nombre: 'Decimal → hexadecimal', from: 10, to: 16 },
  { id: 'hex-dec', nombre: 'Hexadecimal → decimal', from: 16, to: 10 },
  { id: 'bin-hex', nombre: 'Binario → hexadecimal', from: 2, to: 16 },
  { id: 'hex-bin', nombre: 'Hexadecimal → binario', from: 16, to: 2 },
  { id: 'dec-oct', nombre: 'Decimal → octal', from: 10, to: 8 },
  { id: 'oct-bin', nombre: 'Octal → binario', from: 8, to: 2 },
]

export function generateNumberExercise(rng: Rng, kind: ConversionKind, difficulty: 1 | 2 | 3): NumberExercise {
  const conv = CONVERSIONS.find((c) => c.id === kind)!
  const max = difficulty === 1 ? 31 : difficulty === 2 ? 255 : 65535
  // En dificultad media se priorizan valores típicos de máscaras y octetos.
  const value = difficulty === 2 && rng() < 0.3 ? pick(rng, [128, 192, 224, 240, 248, 252, 254, 255, 172, 168, 10, 100]) : randomInt(rng, difficulty === 1 ? 1 : 2, max)
  const shown = conv.from === 2 ? groupBits(toBase(value, 2, difficulty === 1 ? 4 : 8)) : toBase(value, conv.from)
  const answer = conv.to === 2 ? toBase(value, 2) : toBase(value, conv.to)
  return {
    from: conv.from,
    to: conv.to,
    value,
    pregunta: `Convierte ${shown}${conv.from === 10 ? '' : ` (${BASE_NAMES[conv.from]})`} a ${BASE_NAMES[conv.to]}.`,
    respuesta: answer,
    pasos: explainConversion(value, conv.from, conv.to),
  }
}

export function checkNumberAnswer(ex: NumberExercise, answer: string): boolean {
  return fromBase(answer, ex.to) === ex.value
}

/** Permisos de Linux: de "rwxr-x---" a 750 y al revés. */
export function permsToOctal(perms: string): string | undefined {
  if (!/^[r-][w-][x-][r-][w-][x-][r-][w-][x-]$/.test(perms)) return undefined
  let out = ''
  for (let i = 0; i < 9; i += 3) {
    const g = perms.slice(i, i + 3)
    out += String((g[0] === 'r' ? 4 : 0) + (g[1] === 'w' ? 2 : 0) + (g[2] === 'x' ? 1 : 0))
  }
  return out
}

export function octalToPerms(octal: string): string | undefined {
  if (!/^[0-7]{3}$/.test(octal)) return undefined
  return [...octal].map((d) => {
    const n = Number(d)
    return `${n & 4 ? 'r' : '-'}${n & 2 ? 'w' : '-'}${n & 1 ? 'x' : '-'}`
  }).join('')
}
