/**
 * Permisos de Linux: conversión entre octal y la notación de ls -l, efecto de umask, quién puede
 * hacer qué y generador de ejercicios para la calculadora de permisos.
 */
import { pick, type Rng } from '@/lib/random'

const TRIPLE = (n: number) => (n & 4 ? 'r' : '-') + (n & 2 ? 'w' : '-') + (n & 1 ? 'x' : '-')

/** 0o2750 → "rwxr-s---" (sin el carácter de tipo). */
export function toSymbolic(mode: number): string {
  const tri = (shift: number, special: number, ch: string) => {
    const t = TRIPLE((mode >> shift) & 7)
    if (!(mode & special)) return t
    return t.slice(0, 2) + (t[2] === 'x' ? ch : ch.toUpperCase())
  }
  return tri(6, 0o4000, 's') + tri(3, 0o2000, 's') + tri(0, 0o1000, 't')
}

/** "rwxr-s---" o "drwxr-s---" → 0o2750. Devuelve null si el texto no es válido. */
export function fromSymbolic(text: string): number | null {
  const t = text.trim().replace(/^[-dl]/, (m) => (text.trim().length === 10 ? '' : m))
  if (!/^[r-][w-][xsS-][r-][w-][xsS-][r-][w-][xtT-]$/.test(t)) return null
  let mode = 0
  const bits = [0o400, 0o200, 0o100, 0o40, 0o20, 0o10, 0o4, 0o2, 0o1]
  for (let i = 0; i < 9; i++) {
    const c = t[i]
    if (c === 'r' || c === 'w' || c === 'x' || c === 's' || c === 't') mode |= bits[i]
  }
  if (/[sS]/.test(t[2])) mode |= 0o4000
  if (/[sS]/.test(t[5])) mode |= 0o2000
  if (/[tT]/.test(t[8])) mode |= 0o1000
  return mode
}

export function toOctal(mode: number, withSpecial = (mode & 0o7000) !== 0): string {
  return withSpecial ? (mode & 0o7777).toString(8).padStart(4, '0') : (mode & 0o777).toString(8).padStart(3, '0')
}

export function parseOctal(text: string): number | null {
  const t = text.trim()
  if (!/^[0-7]{3,4}$/.test(t)) return null
  return parseInt(t, 8)
}

/** Permisos con los que se crea un archivo (666) o una carpeta (777) según la umask. */
export function applyUmask(umask: number, dir: boolean): number {
  return (dir ? 0o777 : 0o666) & ~umask
}

/** Cómo se lee cada grupo de permisos, en una línea por clase. */
export function explainMode(mode: number, dir: boolean): string[] {
  const who = ['El dueño', 'El grupo', 'El resto']
  const lines = [6, 3, 0].map((shift, i) => {
    const n = (mode >> shift) & 7
    const parts = dir
      ? [n & 4 && 'ver la lista de archivos', n & 2 && n & 1 && 'crear, borrar y renombrar adentro', n & 1 && 'entrar a la carpeta'].filter(Boolean)
      : [n & 4 && 'leer', n & 2 && 'modificar', n & 1 && 'ejecutar'].filter(Boolean)
    return `${who[i]} (${TRIPLE(n)} = ${n}): ${parts.length ? 'puede ' + parts.join(', ') : 'no puede nada'}.`
  })
  if (mode & 0o4000) lines.push('SUID: el programa se ejecuta con los permisos de su dueño.')
  if (mode & 0o2000) lines.push(dir ? 'SGID: lo que se crea adentro hereda el grupo de la carpeta.' : 'SGID: el programa se ejecuta con los permisos de su grupo.')
  if (mode & 0o1000) lines.push('Sticky: cada usuario solo puede borrar sus propios archivos de la carpeta.')
  return lines
}

// ---------------------------------------------------------------------------------------
// Ejercicios
// ---------------------------------------------------------------------------------------

export type PermExerciseKind = 'sim-oct' | 'oct-sim' | 'umask' | 'acceso'

export interface PermExercise {
  kind: PermExerciseKind
  pregunta: string
  /** Contexto que se muestra como salida de terminal (ls -l). */
  contexto?: string
  /** Respuesta correcta, normalizada. */
  respuesta: string
  /** Para preguntas de sí o no. */
  opciones?: string[]
  pasos: string[]
}

const COMMON_MODES = [0o644, 0o640, 0o600, 0o755, 0o750, 0o700, 0o664, 0o660, 0o775, 0o770, 0o444, 0o400, 0o711, 0o751, 0o604, 0o2770, 0o1777]

function digitSteps(mode: number): string[] {
  return [6, 3, 0].map((shift, i) => {
    const n = (mode >> shift) & 7
    const t = TRIPLE(n)
    const sum = [n & 4 ? 'r=4' : '', n & 2 ? 'w=2' : '', n & 1 ? 'x=1' : ''].filter(Boolean)
    return `${['Dueño', 'Grupo', 'Resto'][i]}: ${t} → ${sum.length ? sum.join(' + ') + ' = ' + n : '0'}`
  })
}

const PEOPLE = [
  { name: 'laura', groups: ['ventas'] },
  { name: 'pedro', groups: ['soporte'] },
  { name: 'carlos', groups: ['ventas', 'soporte'] },
]

export function generatePermExercise(rng: Rng, kinds: PermExerciseKind[]): PermExercise {
  const kind = pick(rng, kinds)
  if (kind === 'sim-oct' || kind === 'oct-sim') {
    const mode = pick(rng, COMMON_MODES.filter((m) => !(m & 0o7000) || rng() < 0.4))
    const special = (mode & 0o7000) !== 0
    if (kind === 'sim-oct') {
      return {
        kind,
        pregunta: `¿Qué número octal corresponde a ${toSymbolic(mode)}?`,
        respuesta: toOctal(mode, special),
        pasos: [...digitSteps(mode), ...(special ? ['El bit especial va adelante: SUID 4, SGID 2, sticky 1.'] : []), `Resultado: ${toOctal(mode, special)}`],
      }
    }
    return {
      kind,
      pregunta: `¿Cómo se ven los permisos ${toOctal(mode, special)} en ls -l? (escribe los 9 caracteres, como rw-r--r--)`,
      respuesta: toSymbolic(mode),
      pasos: [...digitSteps(mode).map((s) => s.replace(/: (.+) → (.+)$/, ': $2 → $1')), `Resultado: ${toSymbolic(mode)}`],
    }
  }
  if (kind === 'umask') {
    const umask = pick(rng, [0o022, 0o002, 0o027, 0o077, 0o007])
    const dir = rng() < 0.5
    const result = applyUmask(umask, dir)
    return {
      kind,
      pregunta: `Con umask ${toOctal(umask, true)}, ¿con qué permisos (en octal) se crea ${dir ? 'una carpeta nueva' : 'un archivo nuevo'}?`,
      respuesta: toOctal(result),
      pasos: [
        `${dir ? 'Las carpetas' : 'Los archivos'} se piden con ${dir ? '777 (rwxrwxrwx)' : '666 (rw-rw-rw-)'}.`,
        `La umask ${toOctal(umask)} (${TRIPLE((umask >> 6) & 7)}${TRIPLE((umask >> 3) & 7)}${TRIPLE(umask & 7)}) dice qué permisos se quitan.`,
        `Se quitan esos bits: ${toSymbolic(dir ? 0o777 : 0o666)} → ${toSymbolic(result)} = ${toOctal(result)}.`,
      ],
    }
  }
  // acceso: ¿puede una persona hacer algo?
  const dir = rng() < 0.4
  const owner = pick(rng, PEOPLE)
  const group = pick(rng, ['ventas', 'soporte'])
  const mode = dir ? pick(rng, [0o770, 0o750, 0o755, 0o700, 0o2770, 0o751]) : pick(rng, [0o640, 0o660, 0o644, 0o600, 0o664, 0o604])
  const person = pick(rng, PEOPLE.filter((p) => p.name !== owner.name))
  const actions = dir
    ? [
        { text: 'crear un archivo dentro de la carpeta', need: 3 },
        { text: 'ver la lista de archivos con ls -l', need: 4 + 1 },
        { text: 'entrar a la carpeta con cd', need: 1 },
      ]
    : [
        { text: 'leer el archivo', need: 4 },
        { text: 'modificar el archivo', need: 2 },
      ]
  const action = pick(rng, actions)
  const inGroup = person.groups.includes(group)
  const shift = inGroup ? 3 : 0
  const bits = (mode >> shift) & 7
  const allowed = (bits & action.need) === action.need
  const name = dir ? 'compartido' : 'informe.txt'
  const needText = action.need === 3 ? 'w y x' : action.need === 5 ? 'r y x' : action.need === 4 ? 'r' : action.need === 2 ? 'w' : 'x'
  return {
    kind,
    pregunta: `¿Puede ${person.name} (grupos: ${person.groups.join(', ')}) ${action.text}?`,
    contexto: `$ ls -l${dir ? 'd' : ''} ${name}\n${dir ? 'd' : '-'}${toSymbolic(mode)}. 2 ${owner.name.padEnd(6)} ${group.padEnd(7)} 4096 Oct 30 10:12 ${name}`,
    respuesta: allowed ? 'si' : 'no',
    opciones: ['si', 'no'],
    pasos: [
      `${person.name} no es el dueño (${owner.name}).`,
      inGroup ? `${person.name} pertenece al grupo ${group}: se usan los permisos del grupo, ${TRIPLE(bits)}.` : `${person.name} no pertenece al grupo ${group}: se usan los permisos del resto, ${TRIPLE(bits)}.`,
      `Para ${action.text} hace falta ${needText}${dir ? ' sobre la carpeta' : ''}. ${allowed ? 'Los tiene: puede.' : 'No los tiene: no puede.'}`,
    ],
  }
}

export function checkPermAnswer(ex: PermExercise, answer: string): boolean {
  const a = answer.trim().toLowerCase().replace(/^sí$/, 'si')
  if (ex.kind === 'oct-sim') return a === ex.respuesta || a === '-' + ex.respuesta
  if (ex.kind === 'sim-oct' || ex.kind === 'umask') return a.replace(/^0(?=[0-7]{3}$)/, '') === ex.respuesta.replace(/^0(?=[0-7]{3}$)/, '')
  return a === ex.respuesta
}
