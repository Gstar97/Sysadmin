import { z } from 'zod'

export const levelIdSchema = z.string().regex(/^n\d+$/, 'El id de nivel debe tener la forma n0, n1...')
export const moduleIdSchema = z.string().regex(/^n\d+-m\d+$/, 'El id de módulo debe tener la forma n1-m2')
export const lessonIdSchema = z.string().regex(/^n\d+-m\d+-l\d+$/, 'El id de lección debe tener la forma n1-m2-l3')

export const careerSchema = z.strictObject({
  nombre: z.string().min(1),
  descripcion: z.string().min(1),
})

const plannedItemSchema = z.strictObject({
  titulo: z.string().min(1),
  horas: z.number().positive(),
})

export const levelSchema = z.strictObject({
  id: levelIdSchema,
  titulo: z.string().min(1),
  descripcion: z.string().min(1),
  perfil_salida: z.string().min(1),
  insignia: z.strictObject({
    nombre: z.string().min(1),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color en formato #rrggbb'),
  }),
  proyecto_plan: plannedItemSchema.extend({ entregables: z.array(z.string()).min(1) }).optional(),
})

export const moduleSchema = z.strictObject({
  id: moduleIdSchema,
  titulo: z.string().min(1),
  descripcion: z.string().optional(),
  requiere: z.array(moduleIdSchema).default([]),
  examen: z
    .strictObject({ preguntas: z.number().int().min(5).max(60).default(20) })
    .default({ preguntas: 20 }),
  plan: z.array(plannedItemSchema.extend({ id: lessonIdSchema })).default([]),
  laboratorio_plan: plannedItemSchema.optional(),
  caso_plan: plannedItemSchema.optional(),
})

export const lessonFrontmatterSchema = z.strictObject({
  id: lessonIdSchema,
  titulo: z.string().min(1),
  minutos: z.number().int().positive(),
  objetivos: z.array(z.string().min(1)).min(2, 'Cada lección necesita al menos 2 objetivos'),
  glosario: z.array(z.string()).default([]),
  verificado: z.string().regex(/^\d{4}-\d{2}$/, 'Fecha de verificación en formato AAAA-MM'),
  mini_test: z.number().int().min(5).max(10).optional(),
})

export const labFrontmatterSchema = z.strictObject({
  titulo: z.string().min(1),
  horas: z.number().positive(),
  verificacion: z.array(z.string().min(1)).min(1, 'El laboratorio necesita una lista de verificación'),
})

export const projectFrontmatterSchema = z.strictObject({
  titulo: z.string().min(1),
  horas: z.number().positive(),
  entregables: z.array(z.string().min(1)).min(1),
})

// ---------------------------------------------------------------------------------------
// Preguntas
// ---------------------------------------------------------------------------------------

const questionBase = {
  id: z.string().min(1),
  enunciado: z.string().min(1),
  dificultad: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  diagnostico: z.boolean().default(false),
  etiquetas: z.array(z.string()).default([]),
}

const optionSchema = z.strictObject({
  texto: z.string().min(1),
  correcta: z.boolean().default(false),
  explicacion: z.string().min(1, 'Cada opción debe explicar por qué es correcta o incorrecta'),
})

const singleChoiceOptions = z
  .array(optionSchema)
  .min(2)
  .refine((ops) => ops.filter((o) => o.correcta).length === 1, 'Debe haber exactamente una opción correcta')

export const questionSchema = z.discriminatedUnion('tipo', [
  z.strictObject({
    ...questionBase,
    tipo: z.literal('opcion_multiple'),
    opciones: singleChoiceOptions,
  }),
  z.strictObject({
    ...questionBase,
    tipo: z.literal('respuesta_multiple'),
    opciones: z
      .array(optionSchema)
      .min(3)
      .refine((ops) => ops.some((o) => o.correcta), 'Debe haber al menos una opción correcta'),
  }),
  z.strictObject({
    ...questionBase,
    tipo: z.literal('interpretar_salida'),
    salida: z.string().min(1),
    opciones: singleChoiceOptions,
  }),
  z
    .strictObject({
      ...questionBase,
      tipo: z.literal('completar_comando'),
      prompt: z.string().default('$ '),
      aceptadas: z.array(z.string()).default([]),
      patrones: z.array(z.string()).default([]),
      simulador: z
        .strictObject({
          estado_inicial: z.unknown().optional(),
          comparar_con: z.string().optional(),
          verificar: z.array(z.unknown()).default([]),
        })
        .optional(),
      errores_frecuentes: z
        .array(z.strictObject({ patron: z.string(), explicacion: z.string() }))
        .default([]),
      explicacion: z.string().min(1),
    })
    .refine(
      (q) => q.aceptadas.length > 0 || q.patrones.length > 0 || q.simulador,
      'Una pregunta de completar comando necesita aceptadas, patrones o simulador',
    ),
  z.strictObject({
    ...questionBase,
    tipo: z.literal('ordenar_pasos'),
    pasos: z.array(z.string().min(1)).min(3),
    explicacion: z.string().min(1),
  }),
  z.strictObject({
    ...questionBase,
    tipo: z.literal('encontrar_error'),
    lenguaje: z.string().default('texto'),
    archivo: z.string().min(1),
    lineas_con_error: z.array(z.number().int().positive()).min(1),
    explicacion: z.string().min(1),
  }),
])

export const questionBankSchema = z
  .array(questionSchema)
  .refine((qs) => new Set(qs.map((q) => q.id)).size === qs.length, 'Hay ids de preguntas repetidos')

export const flashcardSchema = z.strictObject({
  id: z.string().min(1),
  frente: z.string().min(1),
  dorso: z.string().min(1),
})

export const flashcardDeckSchema = z
  .array(flashcardSchema)
  .refine((cs) => new Set(cs.map((c) => c.id)).size === cs.length, 'Hay ids de tarjetas repetidos')

export const glossaryEntrySchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/, 'El id del término va en minúsculas, números y guiones'),
  termino: z.string().min(1),
  alias: z.array(z.string()).default([]),
  definicion: z.string().min(1),
  leccion: lessonIdSchema.optional(),
})

export const glossarySchema = z
  .array(glossaryEntrySchema)
  .refine((es) => new Set(es.map((e) => e.id)).size === es.length, 'Hay términos repetidos en el glosario')

export type Career = z.infer<typeof careerSchema>
export type LevelFile = z.infer<typeof levelSchema>
export type ModuleFile = z.infer<typeof moduleSchema>
export type LessonFrontmatter = z.infer<typeof lessonFrontmatterSchema>
export type LabFrontmatter = z.infer<typeof labFrontmatterSchema>
export type ProjectFrontmatter = z.infer<typeof projectFrontmatterSchema>
export type Question = z.infer<typeof questionSchema>
export type QuestionType = Question['tipo']
export type Flashcard = z.infer<typeof flashcardSchema>
export type GlossaryEntry = z.infer<typeof glossaryEntrySchema>
