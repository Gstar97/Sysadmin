import { z } from 'zod'
import { iosCheckSchema, iosStateSchema, topologyExerciseSchema } from '../engines/network/schema.ts'
import { psCheckSchema, psStateSchema } from '../engines/powershell/schema.ts'
import { bashCheckSchema, bashStateSchema } from '../engines/shell/schema.ts'

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
          /** ARP viaja directo sobre Ethernet (EtherType 0x0806), sin encabezado IP. */
          arp: z
            .strictObject({
              operacion: z.enum(['solicitud', 'respuesta', 'gratuito']),
              mac_emisor: z.string(),
              ip_emisor: z.string(),
              mac_objetivo: z.string(),
              ip_objetivo: z.string(),
            })
            .optional(),
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

/** Un ejercicio sobre una captura de tráfico simulada (src/engines/captura), para el visor. */
export const capturaTaskSchema = z.discriminatedUnion('tipo', [
  z.strictObject({
    tipo: z.literal('filtro'),
    consigna: z.string().min(1),
    /** Un filtro de visualización que muestra exactamente los paquetes pedidos; vale cualquier otro equivalente. */
    solucion: z.string().min(1),
    pista: z.string().optional(),
    explicacion: z.string().optional(),
  }),
  z.strictObject({
    tipo: z.literal('paquete'),
    consigna: z.string().min(1),
    /** Número del paquete que hay que marcar en la lista. */
    paquete: z.number().int().positive(),
    pista: z.string().optional(),
    explicacion: z.string().optional(),
  }),
  z.strictObject({
    tipo: z.literal('pregunta'),
    consigna: z.string().min(1),
    opciones: z.array(z.string().min(1)).min(2),
    correcta: z.number().int().nonnegative(),
    explicacion: z.string().min(1),
  }),
])

export const capturaExerciseSchema = z.strictObject({
  tipo: z.literal('captura'),
  titulo: z.string().optional(),
  escenario: z.string().min(1),
  introduccion: z.string().optional(),
  tareas: z.array(capturaTaskSchema).default([]),
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

export const configLanguages = ['nginx', 'compose', 'ansible', 'yaml', 'sshd', 'fstab', 'sudoers', 'systemd', 'zona', 'named', 'kea', 'frr', 'nftables', 'wireguard', 'powershell', 'exports', 'smbconf', 'inventario', 'texto'] as const

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

/** Pasos guiados para hacer en la computadora propia (instalar, configurar), con casillas que se guardan. */
export const guidedStepsSchema = z.strictObject({
  tipo: z.literal('pasos'),
  titulo: z.string().min(1),
  descripcion: z.string().optional(),
  pasos: z
    .array(
      z.strictObject({
        titulo: z.string().min(1),
        detalle: z.string().optional(),
        comandos: z.array(z.string()).default([]),
        /** Contenido de un archivo para escribir (un script, una configuración), con su ruta. */
        archivo: z.strictObject({ ruta: z.string().min(1), contenido: z.string().min(1) }).optional(),
        variantes: z.array(z.strictObject({ nombre: z.string().min(1), detalle: z.string().min(1), comandos: z.array(z.string()).default([]) })).default([]),
        comprobar: z.string().optional(),
        si_falla: z.string().optional(),
      }),
    )
    .min(2),
})

const vimCheckSchema = z.union([
  z.strictObject({ contenido_incluye: z.string() }),
  z.strictObject({ contenido_no_incluye: z.string() }),
  z.strictObject({ contenido_igual: z.string() }),
  z.strictObject({ linea: z.number().int().min(1), texto: z.string() }),
  z.strictObject({ linea_cursor: z.number().int().min(1) }),
  z.strictObject({ modo: z.enum(['normal', 'insert']) }),
  z.strictObject({ guardado: z.boolean() }),
  z.strictObject({ cerrado: z.boolean() }),
  z.strictObject({ numeros: z.boolean() }),
  z.strictObject({ comando_usado: z.string() }),
])

/** Ejercicio de vim: un archivo y pasos que se verifican sobre el mismo buffer, uno detrás de otro. */
export const vimExerciseSchema = z.strictObject({
  tipo: z.literal('vim'),
  titulo: z.string().optional(),
  descripcion: z.string().optional(),
  archivo: z.strictObject({ nombre: z.string().min(1), contenido: z.string() }),
  pasos: z
    .array(
      z.strictObject({
        consigna: z.string().min(1),
        verificar: z.array(vimCheckSchema).min(1),
        pistas: z.array(z.string()).default([]),
        /** Teclas de la solución, con la notación de vim: <Esc>, <CR>, <BS>, <C-r>. */
        solucion: z.string().optional(),
        explicacion: z.string().optional(),
      }),
    )
    .min(1),
})

/** Esquema de cada tipo de archivo de ejercicio, según su campo "tipo". */
/** Verificaciones de un ejercicio de Python: se corren después del código del estudiante, en el mismo espacio de nombres. */
export const pythonCheckSchema = z.union([
  z.strictObject({ salida_contiene: z.string() }),
  z.strictObject({ salida_no_contiene: z.string() }),
  z.strictObject({ error_contiene: z.string() }),
  z.strictObject({ codigo_salida: z.number().int() }),
  /** Código Python con assert; si falla, se muestra el mensaje. */
  z.strictObject({ prueba: z.string(), mensaje: z.string() }),
  z.strictObject({ archivo: z.string(), existe: z.boolean().default(true), contenido_incluye: z.string().optional() }),
  z.strictObject({ sin_error: z.literal(true) }),
  /** El código usa algo (por ejemplo "with open" o "argparse"). */
  z.strictObject({ usa: z.string(), mensaje: z.string().optional() }),
])

/** Un ejercicio de Python (Pyodide): archivos, una API y comandos simulados, y pasos con verificaciones. */
export const pythonExerciseSchema = z.strictObject({
  tipo: z.literal('python'),
  titulo: z.string().min(1),
  descripcion: z.string().optional(),
  /** Archivos que existen antes de correr el código (ruta absoluta: contenido). */
  archivos: z.record(z.string(), z.string()).default({}),
  /** Respuestas del requests simulado: "GET https://..." o la URL sola; con estado, json o texto, una demora en segundos y un token (Bearer) que exige. */
  api: z.record(z.string(), z.strictObject({ estado: z.number().int().default(200), json: z.unknown().optional(), texto: z.string().optional(), demora: z.number().optional(), token: z.string().optional() })).default({}),
  /** Salidas de subprocess.run simulado, por comando exacto. */
  comandos: z.record(z.string(), z.strictObject({ salida: z.string().default(''), error: z.string().default(''), codigo: z.number().int().default(0) })).default({}),
  /** Variables de entorno que ve el programa (os.environ), por ejemplo un token de una API. */
  entorno: z.record(z.string(), z.string()).default({}),
  /** Argumentos de línea de comandos (sys.argv[1:]) al correr el programa. */
  argumentos: z.array(z.string()).default([]),
  /** Carpeta de trabajo; las rutas relativas de archivos y verificaciones salen de acá. */
  directorio: z.string().default('/home/estudiante'),
  codigo_inicial: z.string().default(''),
  pasos: z
    .array(
      z.strictObject({
        consigna: z.string().min(1),
        verificar: z.array(pythonCheckSchema).min(1),
        pistas: z.array(z.string()).default([]),
        /** El programa completo que resuelve el paso. */
        solucion: z.string().min(1),
        explicacion: z.string().optional(),
      }),
    )
    .min(1),
})

// ---------------------------------------------------------------------------------------
// Consultas de métricas (PromQL) y de logs (LogQL)
// ---------------------------------------------------------------------------------------

const labelsSchema = z.record(z.string(), z.string())

const shapeSchema = z.union([
  z.number(),
  z.strictObject({ constante: z.number() }),
  z.strictObject({ lineal: z.strictObject({ desde: z.number(), hasta: z.number() }) }),
  z.strictObject({ onda: z.strictObject({ media: z.number(), amplitud: z.number(), periodo: z.string().optional(), fase: z.number().optional() }) }),
])

/** Series de tiempo sintéticas (src/engines/metrics/tsdb.ts): nodos con node_exporter, apps web y series a medida. */
export const metricsScenarioSchema = z.strictObject({
  /** Instante "ahora" (ISO, por defecto 2026-11-23T14:00:00Z). */
  ahora: z.string().optional(),
  ventana: z.string().optional(),
  paso: z.string().optional(),
  semilla: z.number().optional(),
  nodos: z
    .array(
      z.strictObject({
        instancia: z.string(),
        job: z.string().optional(),
        cpus: z.number().optional(),
        memoria_gb: z.number().optional(),
        carga: z.number().optional(),
        memoria_usada: z.number().optional(),
        disco_gb: z.number().optional(),
        disco_usado: z.number().optional(),
        disco_crece_gb_hora: z.number().optional(),
        red_mbps: z.number().optional(),
        etiquetas: labelsSchema.optional(),
        eventos: z
          .array(z.strictObject({ desde: z.string().optional(), hasta: z.string().optional(), carga: z.number().optional(), memoria_usada: z.number().optional(), disco_crece_gb_hora: z.number().optional(), caido: z.boolean().optional() }))
          .optional(),
      }),
    )
    .optional(),
  http: z
    .array(
      z.strictObject({
        instancia: z.string(),
        job: z.string().optional(),
        rps: z.number().optional(),
        errores: z.number().optional(),
        latencia_ms: z.number().optional(),
        handlers: z.array(z.string()).optional(),
        eventos: z
          .array(z.strictObject({ desde: z.string().optional(), hasta: z.string().optional(), rps: z.number().optional(), errores: z.number().optional(), latencia_ms: z.number().optional(), caido: z.boolean().optional() }))
          .optional(),
      }),
    )
    .optional(),
  series: z
    .array(
      z.strictObject({
        nombre: z.string(),
        etiquetas: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
        tipo: z.enum(['gauge', 'contador']).optional(),
        valor: shapeSchema.optional(),
        inicial: z.number().optional(),
        ruido: z.number().optional(),
        entero: z.boolean().optional(),
        eventos: z
          .array(z.strictObject({ desde: z.string().optional(), hasta: z.string().optional(), valor: z.number().optional(), multiplicar: z.number().optional(), sumar: z.number().optional(), si: labelsSchema.optional() }))
          .optional(),
        reinicios: z.array(z.string()).optional(),
        sin_datos: z.array(z.strictObject({ desde: z.string().optional(), hasta: z.string().optional(), si: labelsSchema.optional() })).optional(),
      }),
    )
    .optional(),
})

/** Verificaciones sobre el resultado de una consulta (PromQL o LogQL). */
export const queryCheckSchema = z.union([
  z.strictObject({ sin_error: z.literal(true) }),
  /** Cantidad exacta de series (o de streams) en el resultado. */
  z.strictObject({ series: z.number().int() }),
  z.strictObject({ series_min: z.number().int() }),
  /** Alguna serie del resultado tiene estas etiquetas. */
  z.strictObject({ contiene: labelsSchema }),
  z.strictObject({ no_contiene: labelsSchema }),
  /** Ninguna serie tiene esta etiqueta (por ejemplo, porque se agregó con sum). */
  z.strictObject({ sin_etiqueta: z.string() }),
  /** Todas las series tienen esta etiqueta. */
  z.strictObject({ con_etiqueta: z.string() }),
  /** Los valores (de las series que coinciden con si) están en el rango. */
  z.strictObject({ valor: z.strictObject({ min: z.number().optional(), max: z.number().optional() }), si: labelsSchema.optional() }),
  /** La consulta usa una función, un operador o una palabra (rate, by, offset, json...). */
  z.strictObject({ usa: z.string(), mensaje: z.string().optional() }),
  z.strictObject({ tipo: z.enum(['vector', 'escalar', 'lineas']) }),
  /** Consultas de logs: cantidad de líneas y su contenido. */
  z.strictObject({ lineas: z.number().int() }),
  z.strictObject({ lineas_min: z.number().int() }),
  z.strictObject({ lineas_contienen: z.string() }),
  z.strictObject({ lineas_no_contienen: z.string() }),
])

const queryStepsSchema = z
  .array(
    z.strictObject({
      consigna: z.string().min(1),
      verificar: z.array(queryCheckSchema).min(1),
      pistas: z.array(z.string()).default([]),
      /** La consulta que resuelve el paso. */
      solucion: z.string().min(1),
      explicacion: z.string().optional(),
    }),
  )
  .default([])

/** Una consola de PromQL sobre métricas de ejemplo; sin pasos, es una consola libre. */
export const promqlExerciseSchema = z.strictObject({
  tipo: z.literal('promql'),
  titulo: z.string().min(1),
  descripcion: z.string().optional(),
  metricas: metricsScenarioSchema,
  consulta_inicial: z.string().default(''),
  pasos: queryStepsSchema,
})

export const exerciseSchemas = {
  terminal: terminalExerciseSchema,
  topologia: topologyExerciseSchema,
  paquetes: packetScenarioSchema,
  diagrama: diagramSchema,
  ordenar: orderExerciseSchema,
  emparejar: matchExerciseSchema,
  troubleshooting: troubleshootingSchema,
  configuracion: configExerciseSchema,
  pasos: guidedStepsSchema,
  vim: vimExerciseSchema,
  captura: capturaExerciseSchema,
  python: pythonExerciseSchema,
  promql: promqlExerciseSchema,
} as const

export type ExerciseKind = keyof typeof exerciseSchemas
export type BashExercise = z.infer<typeof bashExerciseSchema>
export type VimExercise = z.infer<typeof vimExerciseSchema>
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
export type GuidedSteps = z.infer<typeof guidedStepsSchema>
export type CapturaExercise = z.infer<typeof capturaExerciseSchema>
export type CapturaTask = z.infer<typeof capturaTaskSchema>
export type PythonExercise = z.infer<typeof pythonExerciseSchema>
export type PythonCheck = z.infer<typeof pythonCheckSchema>
export type PromqlExercise = z.infer<typeof promqlExerciseSchema>
export type QueryCheck = z.infer<typeof queryCheckSchema>
export type MetricsScenario = z.infer<typeof metricsScenarioSchema>
export type ConfigLanguage = (typeof configLanguages)[number]
