/** Escenarios de métricas y de logs de ejemplo (los usan las consolas de PromQL y LogQL y el simulador). */
import { z } from 'zod'

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

const relRange = { desde: z.string().optional(), hasta: z.string().optional() }

/** Logs de ejemplo (src/engines/logs/logdb.ts): SSH, nginx, una app con JSON y streams a medida. */
export const logsScenarioSchema = z.strictObject({
  ahora: z.string().optional(),
  ventana: z.string().optional(),
  semilla: z.number().optional(),
  ssh: z
    .array(
      z.strictObject({
        host: z.string(),
        distro: z.enum(['ubuntu', 'rocky']).optional(),
        usuarios: z.array(z.string()).optional(),
        accesos_hora: z.number().optional(),
        fallidos_minuto: z.number().optional(),
        ataques: z.array(z.strictObject({ ...relRange, ip: z.string(), por_minuto: z.number(), usuarios: z.array(z.string()).optional() })).optional(),
      }),
    )
    .optional(),
  nginx: z
    .array(
      z.strictObject({
        host: z.string(),
        rps: z.number().optional(),
        errores: z.number().optional(),
        paths: z.array(z.string()).optional(),
        eventos: z.array(z.strictObject({ ...relRange, rps: z.number().optional(), errores: z.number().optional(), lento_ms: z.number().optional() })).optional(),
      }),
    )
    .optional(),
  app: z
    .array(
      z.strictObject({
        host: z.string(),
        app: z.string().optional(),
        por_minuto: z.number().optional(),
        errores: z.number().optional(),
        eventos: z.array(z.strictObject({ ...relRange, errores: z.number().optional(), mensaje_error: z.string().optional(), latencia_ms: z.number().optional() })).optional(),
      }),
    )
    .optional(),
  streams: z
    .array(
      z.strictObject({
        etiquetas: labelsSchema,
        lineas: z
          .array(
            z.strictObject({
              plantilla: z.string(),
              cada: z.string().optional(),
              por_minuto: z.number().optional(),
              ...relRange,
              valores: z.record(z.string(), z.union([z.array(z.string()), z.strictObject({ min: z.number(), max: z.number(), decimales: z.number().optional() })])).optional(),
            }),
          )
          .optional(),
        fijas: z.array(z.strictObject({ en: z.string(), linea: z.string() })).optional(),
      }),
    )
    .optional(),
})

