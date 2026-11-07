/**
 * Nombres de los componentes que se pueden usar dentro de las lecciones (MDX).
 * El validador usa estas listas para exigir al menos un diagrama y un interactivo por lección.
 */
export const DIAGRAM_COMPONENTS = ['Diagrama', 'DiagramaInteractivo', 'SimuladorPaquetes', 'Topologia', 'SimuladorSwitch', 'SimuladorStp', 'SimuladorConvergencia', 'PlanificadorWifi'] as const

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
  'SimuladorCpu',
  'EscalaLatencias',
  'ComparadorDiscos',
  'PlanificadorCpu',
  'SimuladorMemoria',
  'TableroBits',
  'ConversorBases',
  'CalculadoraUnidades',
  'OperacionesBits',
  'PasosGuiados',
  'SimuladorVim',
  'CalculadoraPermisos',
  'CalculadoraPoe',
  'SimuladorSwitch',
  'ClasificadorIp',
  'DisenadorVlsm',
  'SimuladorNat',
  'SimuladorStp',
  'EjercicioRutas',
  'SimuladorConvergencia',
  'SimuladorFirewall',
  'PlanificadorWifi',
] as const

export const REQUIRED_BLOCKS = [
  { componente: 'ErroresComunes', descripcion: 'la sección de errores comunes' },
  { componente: 'Resumen', descripcion: 'el resumen de puntos clave' },
] as const

/** Propiedad que recibe los datos de cada componente con ejercicio (el validador revisa que se use esa). */
export const DATA_PROPS: Record<string, string> = {
  DiagramaInteractivo: 'datos',
  SimuladorVim: 'ejercicio',
  Topologia: 'ejercicio',
  SimuladorPaquetes: 'escenario',
  Ordenar: 'ejercicio',
  Emparejar: 'ejercicio',
  Troubleshooting: 'escenario',
  EditorConfig: 'ejercicio',
  PasosGuiados: 'ejercicio',
}
