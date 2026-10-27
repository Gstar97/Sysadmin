import { z } from 'zod'
import { iosCheckSchema, iosStateSchema, topologyExerciseSchema } from '../engines/network/schema'
import { psCheckSchema, psStateSchema } from '../engines/powershell/schema'
import { bashCheckSchema, bashStateSchema } from '../engines/shell/schema'

function stepSchema<T extends z.ZodType>(check: T) {
  return z.strictObject({
    consigna: z.string().min(1),
    verificar: z.array(check).min(1, 'Cada paso necesita al menos una verificación'),
    pistas: z.array(z.string()).default([]),
    solucion: z.array(z.string()).default([]),
    explicacion: z.string().optional(),
  })
}

const terminalCommon = {
  tipo: z.literal('terminal'),
  titulo: z.string().optional(),
  descripcion: z.string().optional(),
}

export const bashExerciseSchema = z.strictObject({
  ...terminalCommon,
  shell: z.literal('bash'),
  estado_inicial: bashStateSchema.default(bashStateSchema.parse({})),
  pasos: z.array(stepSchema(bashCheckSchema)).default([]),
})

export const psExerciseSchema = z.strictObject({
  ...terminalCommon,
  shell: z.literal('powershell'),
  estado_inicial: psStateSchema.default(psStateSchema.parse({})),
  pasos: z.array(stepSchema(psCheckSchema)).default([]),
})

export const iosExerciseSchema = z.strictObject({
  ...terminalCommon,
  shell: z.literal('ios'),
  estado_inicial: iosStateSchema,
  pasos: z.array(stepSchema(iosCheckSchema)).default([]),
})

export const terminalExerciseSchema = z.discriminatedUnion('shell', [
  bashExerciseSchema,
  psExerciseSchema,
  iosExerciseSchema,
])

export const packetScenarioSchema = z.strictObject({
  tipo: z.literal('paquetes'),
  titulo: z.string().min(1),
  descripcion: z.string().optional(),
  nodos: z
    .array(
      z.strictObject({
        id: z.string(),
        etiqueta: z.string(),
        tipo: z.enum(['pc', 'servidor', 'switch', 'router', 'firewall', 'internet', 'dns']),
        x: z.number(),
        y: z.number(),
      }),
    )
    .min(2),
  enlaces: z.array(z.strictObject({ a: z.string(), b: z.string() })).default([]),
  pasos: z
    .array(
      z.strictObject({
        desde: z.string(),
        hacia: z.string(),
        titulo: z.string(),
        explicacion: z.string(),
        capas: z.strictObject({
          aplicacion: z.strictObject({ protocolo: z.string(), datos: z.string() }).optional(),
          transporte: z
            .strictObject({
              protocolo: z.enum(['TCP', 'UDP']),
              origen: z.number().int(),
              destino: z.number().int(),
              flags: z.string().optional(),
            })
            .optional(),
          red: z
            .strictObject({ origen: z.string(), destino: z.string(), ttl: z.number().int().optional(), protocolo: z.string().optional() })
            .optional(),
          enlace: z.strictObject({ origen: z.string(), destino: z.string(), tipo: z.string().default('Ethernet II') }).optional(),
        }),
      }),
    )
    .min(1),
})

export const diagramSchema = z.strictObject({
  tipo: z.literal('diagrama'),
  titulo: z.string().optional(),
  puntos: z
    .array(
      z.strictObject({
        id: z.string(),
        titulo: z.string(),
        texto: z.string(),
        area: z.strictObject({ x: z.number(), y: z.number(), ancho: z.number(), alto: z.number() }).optional(),
      }),
    )
    .min(1),
})

export const orderExerciseSchema = z.strictObject({
  tipo: z.literal('ordenar'),
  consigna: z.string().min(1),
  pasos: z.array(z.string().min(1)).min(3),
  explicacion: z.string().optional(),
})

export const matchExerciseSchema = z.strictObject({
  tipo: z.literal('emparejar'),
  consigna: z.string().min(1),
  pares: z.array(z.strictObject({ a: z.string().min(1), b: z.string().min(1) })).min(3),
  explicacion: z.string().optional(),
})

const scenarioNodeSchema = z
  .strictObject({
    situacion: z.string().optional(),
    evidencia: z.array(z.strictObject({ titulo: z.string(), contenido: z.string() })).default([]),
    opciones: z
      .array(
        z.strictObject({
          texto: z.string().min(1),
          ir_a: z.string(),
          minutos: z.number().min(0),
          consecuencia: z.string().optional(),
        }),
      )
      .default([]),
    final: z.enum(['exito', 'fracaso']).optional(),
    resumen: z.string().optional(),
  })
  .refine((n) => n.final !== undefined || n.opciones.length > 0, 'Un nodo sin opciones tiene que ser final')

export const troubleshootingSchema = z
  .strictObject({
    tipo: z.literal('troubleshooting'),
    titulo: z.string().min(1),
    descripcion: z.string().optional(),
    inicio: z.string(),
    nodos: z.record(z.string(), scenarioNodeSchema),
  })
  .superRefine((s, ctx) => {
    if (!s.nodos[s.inicio]) ctx.addIssue({ code: 'custom', message: `El nodo de inicio "${s.inicio}" no existe` })
    for (const [id, nodo] of Object.entries(s.nodos)) {
      for (const op of nodo.opciones) {
        if (!s.nodos[op.ir_a]) {
          ctx.addIssue({ code: 'custom', message: `El nodo "${id}" apunta a "${op.ir_a}", que no existe` })
        }
      }
    }
    // Debe existir al menos un camino de inicio a un final exitoso.
    const visitados = new Set<string>()
    const pila = [s.inicio]
    let hayExito = false
    while (pila.length) {
      const id = pila.pop()!
      if (visitados.has(id) || !s.nodos[id]) continue
      visitados.add(id)
      if (s.nodos[id].final === 'exito') hayExito = true
      for (const op of s.nodos[id].opciones) pila.push(op.ir_a)
    }
    if (!hayExito) ctx.addIssue({ code: 'custom', message: 'No hay ningún camino que llegue a un final exitoso' })
  })

const configRuleSchema = z.discriminatedUnion('tipo', [
  z.strictObject({ tipo: z.literal('sin_errores'), mensaje: z.string().default('El archivo no tiene errores de sintaxis') }),
  z.strictObject({ tipo: z.literal('contiene'), regex: z.string(), mensaje: z.string() }),
  z.strictObject({ tipo: z.literal('no_contiene'), regex: z.string(), mensaje: z.string() }),
  z.strictObject({
    tipo: z.literal('directiva'),
    contexto: z.string(),
    nombre: z.string(),
    valor_regex: z.string().optional(),
    mensaje: z.string(),
  }),
  z.strictObject({
    tipo: z.literal('yaml_ruta'),
    ruta: z.string(),
    existe: z.boolean().default(true),
    igual: z.unknown().optional(),
    contiene: z.unknown().optional(),
    regex: z.string().optional(),
    mensaje: z.string(),
  }),
])

export const configLanguages = ['nginx', 'compose', 'ansible', 'yaml', 'sshd', 'fstab', 'texto'] as const

export const configExerciseSchema = z.strictObject({
  tipo: z.literal('configuracion'),
  titulo: z.string().optional(),
  consigna: z.string().min(1),
  lenguaje: z.enum(configLanguages),
  nombre_archivo: z.string().optional(),
  archivo_inicial: z.string(),
  reglas: z.array(configRuleSchema).default([{ tipo: 'sin_errores', mensaje: 'El archivo no tiene errores de sintaxis' }]),
  solucion: z.string().optional(),
})

/** Esquema de cada tipo de archivo de ejercicio, según su campo "tipo". */
export const exerciseSchemas = {
  terminal: terminalExerciseSchema,
  topologia: topologyExerciseSchema,
  paquetes: packetScenarioSchema,
  diagrama: diagramSchema,
  ordenar: orderExerciseSchema,
  emparejar: matchExerciseSchema,
  troubleshooting: troubleshootingSchema,
  configuracion: configExerciseSchema,
} as const

export type ExerciseKind = keyof typeof exerciseSchemas
export type BashExercise = z.infer<typeof bashExerciseSchema>
export type PsExercise = z.infer<typeof psExerciseSchema>
export type IosExercise = z.infer<typeof iosExerciseSchema>
export type TerminalExercise = z.infer<typeof terminalExerciseSchema>
export type PacketScenario = z.infer<typeof packetScenarioSchema>
export type DiagramSpec = z.infer<typeof diagramSchema>
export type OrderExercise = z.infer<typeof orderExerciseSchema>
export type MatchExercise = z.infer<typeof matchExerciseSchema>
export type TroubleshootingScenario = z.infer<typeof troubleshootingSchema>
export type ConfigExercise = z.infer<typeof configExerciseSchema>
export type ConfigRule = z.infer<typeof configRuleSchema>
export type ConfigLanguage = (typeof configLanguages)[number]
