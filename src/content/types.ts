import type { Career, GlossaryEntry } from './schemas'

/** Índice de la carrera que genera el plugin de contenido al compilar (virtual:content). */
export interface ContentIndex {
  career: Career
  levels: LevelEntry[]
  glossary: GlossaryEntry[]
  problems: { errors: string[]; warnings: string[] }
}

export interface PlannedItem {
  titulo: string
  horas: number
}

export interface LevelEntry {
  id: string
  /** Ruta relativa a la carpeta de contenido, por ejemplo "niveles/00-fundamentos". */
  path: string
  numero: number
  titulo: string
  descripcion: string
  perfil_salida: string
  insignia: { nombre: string; color: string }
  proyecto?: { titulo: string; horas: number; entregables: string[]; publicado: boolean }
  modules: ModuleEntry[]
}

export interface ModuleEntry {
  id: string
  levelId: string
  path: string
  numero: string
  titulo: string
  descripcion?: string
  requiere: string[]
  examen: { preguntas: number }
  lessons: LessonEntry[]
  planned: (PlannedItem & { id: string })[]
  lab?: { titulo: string; horas: number; verificacion: string[]; publicado: boolean }
  caso?: { titulo: string; horas: number; publicado: boolean }
  /** Horas estimadas del módulo: lecciones (publicadas y planificadas) + laboratorio + examen + caso. */
  horas: number
}

export interface LessonEntry {
  id: string
  moduleId: string
  levelId: string
  path: string
  numero: string
  titulo: string
  minutos: number
  objetivos: string[]
  glosario: string[]
  verificado: string
  miniTest: number
  preguntas: number
  diagnosticas: number
  tarjetas: number
  secciones: { titulo: string; slug: string }[]
}

export interface SearchDoc {
  id: string
  tipo: 'leccion' | 'modulo' | 'glosario'
  titulo: string
  seccion?: string
  texto: string
  url: string
}
