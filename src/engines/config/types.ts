export interface Diagnostic {
  /** Línea (empieza en 1). */
  line: number
  /** Columna (empieza en 1), si se conoce. */
  column?: number
  severity: 'error' | 'warning'
  message: string
}

/** Árbol de una configuración de nginx. */
export interface NginxDirective {
  name: string
  args: string[]
  line: number
  /** Línea donde termina (si ocupa varias, suele faltar un punto y coma). */
  endLine: number
  block?: NginxDirective[]
}
