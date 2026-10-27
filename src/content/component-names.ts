/**
 * Nombres de los componentes que se pueden usar dentro de las lecciones (MDX).
 * El validador usa estas listas para exigir al menos un diagrama y un interactivo por lección.
 */
export const DIAGRAM_COMPONENTS = ['Diagrama', 'DiagramaInteractivo', 'SimuladorPaquetes', 'Topologia'] as const

export const INTERACTIVE_COMPONENTS = [
  'Terminal',
  'Subnetting',
  'Topologia',
  'SimuladorPaquetes',
  'DiagramaInteractivo',
  'Ordenar',
  'Emparejar',
  'Troubleshooting',
  'EditorConfig',
  'Pregunta',
] as const

export const REQUIRED_BLOCKS = [
  { componente: 'ErroresComunes', descripcion: 'la sección de errores comunes' },
  { componente: 'Resumen', descripcion: 'el resumen de puntos clave' },
] as const
