/** Convierte texto con secuencias de color ANSI (SGR) en fragmentos con estilo. */

export interface Segment {
  text: string
  fg?: string
  bg?: string
  bold?: boolean
}

const COLORS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']

// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[([0-9;]*)m/g

export function parseAnsi(text: string): Segment[] {
  const out: Segment[] = []
  let state: Omit<Segment, 'text'> = {}
  let last = 0
  let m: RegExpExecArray | null
  SGR.lastIndex = 0
  while ((m = SGR.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), ...state })
    last = SGR.lastIndex
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number)
    for (const c of codes) {
      if (c === 0) state = {}
      else if (c === 1) state = { ...state, bold: true }
      else if (c === 22) state = { ...state, bold: false }
      else if (c >= 30 && c <= 37) state = { ...state, fg: COLORS[c - 30] }
      else if (c >= 90 && c <= 97) state = { ...state, fg: `bright-${COLORS[c - 90]}` }
      else if (c === 39) state = { ...state, fg: undefined }
      else if (c >= 40 && c <= 47) state = { ...state, bg: COLORS[c - 40] }
      else if (c === 49) state = { ...state, bg: undefined }
    }
  }
  if (last < text.length) out.push({ text: text.slice(last), ...state })
  return out
}

export function stripAnsi(text: string): string {
  return text.replace(SGR, '')
}

/** Colores pensados para fondo oscuro, con buen contraste. */
export const ANSI_PALETTE: Record<string, string> = {
  black: '#6e7681',
  red: '#ff7b72',
  green: '#7ee787',
  yellow: '#e3b341',
  blue: '#79c0ff',
  magenta: '#d2a8ff',
  cyan: '#76e3ea',
  white: '#d6dde6',
  'bright-black': '#8b949e',
  'bright-red': '#ffa198',
  'bright-green': '#56d364',
  'bright-yellow': '#f2cc60',
  'bright-blue': '#a5d6ff',
  'bright-magenta': '#e2c5ff',
  'bright-cyan': '#b3f0ff',
  'bright-white': '#ffffff',
}
