import type { Question } from '@/content/schemas'

/** Respuesta del estudiante. Los índices siempre se refieren al orden original del archivo. */
export type Response =
  | { tipo: 'opcion_multiple' | 'interpretar_salida'; seleccion: number | null }
  | { tipo: 'respuesta_multiple'; seleccion: number[] }
  | { tipo: 'completar_comando'; texto: string }
  | { tipo: 'ordenar_pasos'; orden: number[] }
  | { tipo: 'encontrar_error'; lineas: number[] }

export interface GradeResult {
  correct: boolean
  /** Comentario específico para esta respuesta (por ejemplo, un error frecuente detectado). */
  feedback?: string
}

export function emptyResponse(q: Question, stepOrder?: number[]): Response {
  switch (q.tipo) {
    case 'opcion_multiple':
    case 'interpretar_salida':
      return { tipo: q.tipo, seleccion: null }
    case 'respuesta_multiple':
      return { tipo: q.tipo, seleccion: [] }
    case 'completar_comando':
      return { tipo: q.tipo, texto: '' }
    case 'ordenar_pasos':
      return { tipo: q.tipo, orden: stepOrder ?? q.pasos.map((_, i) => i) }
    case 'encontrar_error':
      return { tipo: q.tipo, lineas: [] }
  }
}

export function isAnswered(r: Response): boolean {
  switch (r.tipo) {
    case 'opcion_multiple':
    case 'interpretar_salida':
      return r.seleccion !== null
    case 'respuesta_multiple':
      return r.seleccion.length > 0
    case 'completar_comando':
      return r.texto.trim().length > 0
    case 'ordenar_pasos':
      return true
    case 'encontrar_error':
      return r.lineas.length > 0
  }
}

/** Normaliza un comando escrito: quita el prompt si lo copiaron y unifica espacios. */
export function normalizeCommand(text: string): string {
  return text
    .trim()
    .replace(/^(\$|#|>|PS [^>]*>)\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function sameSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  const sa = new Set(a)
  return b.every((x) => sa.has(x))
}

function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern)
  } catch {
    return null
  }
}

export async function gradeQuestion(q: Question, r: Response): Promise<GradeResult> {
  if (q.tipo !== r.tipo) return { correct: false }
  switch (q.tipo) {
    case 'opcion_multiple':
    case 'interpretar_salida': {
      const sel = (r as { seleccion: number | null }).seleccion
      return { correct: sel !== null && !!q.opciones[sel]?.correcta }
    }
    case 'respuesta_multiple': {
      const correctas = q.opciones.flatMap((o, i) => (o.correcta ? [i] : []))
      return { correct: sameSet(correctas, (r as { seleccion: number[] }).seleccion) }
    }
    case 'ordenar_pasos': {
      const orden = (r as { orden: number[] }).orden
      return { correct: orden.length === q.pasos.length && orden.every((v, i) => v === i) }
    }
    case 'encontrar_error':
      return { correct: sameSet(q.lineas_con_error, (r as { lineas: number[] }).lineas) }
    case 'completar_comando': {
      const texto = normalizeCommand((r as { texto: string }).texto)
      const frecuente = q.errores_frecuentes.find((e) => safeRegex(e.patron)?.test(texto))
      if (q.aceptadas.some((a) => normalizeCommand(a) === texto)) return { correct: true }
      if (q.patrones.some((p) => safeRegex(p)?.test(texto))) return { correct: true }
      if (q.simulador && texto) {
        const { gradeWithSimulator } = await import('@/engines/shell/question')
        const ok = await gradeWithSimulator(q.simulador, texto)
        if (ok) return { correct: true }
      }
      return { correct: false, feedback: frecuente?.explicacion }
    }
  }
}

/** Texto de la respuesta correcta, para mostrar en la corrección. */
export function correctAnswerText(q: Question): string {
  switch (q.tipo) {
    case 'opcion_multiple':
    case 'interpretar_salida':
      return q.opciones.find((o) => o.correcta)?.texto ?? ''
    case 'respuesta_multiple':
      return q.opciones
        .filter((o) => o.correcta)
        .map((o) => o.texto)
        .join(' · ')
    case 'completar_comando':
      return q.aceptadas[0] ?? q.simulador?.comparar_con ?? ''
    case 'ordenar_pasos':
      return q.pasos.map((p, i) => `${i + 1}. ${p}`).join('\n')
    case 'encontrar_error':
      return `Línea${q.lineas_con_error.length > 1 ? 's' : ''} ${q.lineas_con_error.join(', ')}`
  }
}
