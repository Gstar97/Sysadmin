/**
 * Planificación de canales Wi-Fi: qué ocupa cada canal en el espectro y cuándo dos puntos de
 * acceso vecinos se molestan. En el mismo canal se turnan (comparten el aire); en canales que se
 * pisan sin coincidir, cada uno es ruido para el otro, que es peor.
 */

export type Banda = '2.4' | '5'
export type Ancho = 20 | 40 | 80

export interface Ap {
  id: string
  x: number
  y: number
  banda: Banda
  canal: number
  ancho: Ancho
}

export const CANALES_24 = Array.from({ length: 13 }, (_, i) => i + 1)
/** Canales de 20 MHz de 5 GHz más usados (UNII-1, UNII-2 con DFS y UNII-3). */
export const CANALES_5 = [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165]
export const DFS = (c: number) => c >= 52 && c <= 144

const START_40 = [36, 44, 52, 60, 100, 108, 116, 124, 132, 140, 149, 157]
const START_80 = [36, 52, 100, 116, 132, 149]

/** Rango de frecuencias en MHz que ocupa un AP. */
export function espectro(ap: Pick<Ap, 'banda' | 'canal' | 'ancho'>): [number, number] {
  if (ap.banda === '2.4') {
    const f = 2412 + 5 * (ap.canal - 1)
    return [f - 10, f + 10]
  }
  if (ap.ancho === 20) {
    const f = 5000 + 5 * ap.canal
    return [f - 10, f + 10]
  }
  const starts = ap.ancho === 40 ? START_40 : START_80
  const span = ap.ancho === 40 ? 4 : 12
  const start = [...starts].reverse().find((s) => ap.canal >= s && ap.canal <= s + span) ?? ap.canal
  return [5000 + 5 * start - 10, 5000 + 5 * (start + span) + 10]
}

/** ¿El canal admite ese ancho? (165 solo va en 20 MHz; 144 no forma 80 en todas partes, pero se acepta.) */
export function anchoValido(canal: number, ancho: Ancho): boolean {
  if (ancho === 20) return true
  const starts = ancho === 40 ? START_40 : START_80
  const span = ancho === 40 ? 4 : 12
  return starts.some((s) => canal >= s && canal <= s + span)
}

export type Choque = 'ninguno' | 'cocanal' | 'solapado'

export function choque(a: Ap, b: Ap): Choque {
  if (a.banda !== b.banda) return 'ninguno'
  const [a1, a2] = espectro(a)
  const [b1, b2] = espectro(b)
  if (a2 <= b1 || b2 <= a1) return 'ninguno'
  return a1 === b1 && a2 === b2 ? 'cocanal' : 'solapado'
}

/** Vecinos: los AP que se oyen entre sí (distancia menor que el alcance). */
export function vecinos(aps: Ap[], alcance: number): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < aps.length; i++)
    for (let j = i + 1; j < aps.length; j++) {
      const d = Math.hypot(aps[i].x - aps[j].x, aps[i].y - aps[j].y)
      if (d < alcance * (aps[i].banda === '2.4' ? 1 : 0.85)) out.push([i, j])
    }
  return out
}

/** Una asignación sin choques en 2,4 GHz con 1, 6 y 11 (coloreo voraz), si existe. */
export function sugerir24(aps: Ap[], alcance: number): number[] {
  const pares = vecinos(aps.map((a) => ({ ...a, banda: '2.4' as const })), alcance)
  const res: number[] = []
  aps.forEach((_, i) => {
    const usados = new Set(pares.filter(([a, b]) => (a === i && b < i) || (b === i && a < i)).map(([a, b]) => res[a === i ? b : a]))
    res[i] = [1, 6, 11].find((c) => !usados.has(c)) ?? [1, 6, 11][i % 3]
  })
  return res
}

export const OFICINA_APS: Ap[] = [
  { id: 'AP1', x: 90, y: 80, banda: '2.4', canal: 1, ancho: 20 },
  { id: 'AP2', x: 250, y: 80, banda: '2.4', canal: 3, ancho: 20 },
  { id: 'AP3', x: 410, y: 80, banda: '2.4', canal: 6, ancho: 20 },
  { id: 'AP4', x: 90, y: 230, banda: '2.4', canal: 6, ancho: 20 },
  { id: 'AP5', x: 250, y: 230, banda: '2.4', canal: 11, ancho: 20 },
  { id: 'AP6', x: 410, y: 230, banda: '2.4', canal: 11, ancho: 20 },
]
