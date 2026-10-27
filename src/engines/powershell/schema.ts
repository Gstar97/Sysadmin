import { z } from 'zod'

const fileSpecSchema = z.union([
  z.string(),
  z.strictObject({ tipo: z.enum(['archivo', 'directorio']).default('archivo'), contenido: z.string().optional() }),
])

export const psStateSchema = z.strictObject({
  equipo: z.string().default('SRV01'),
  usuario: z.string().default('Administrador'),
  dominio: z.string().optional(),
  directorio: z.string().default('C:\\Users\\Administrador'),
  archivos: z.record(z.string(), fileSpecSchema).default({}),
  servicios: z
    .array(
      z.strictObject({
        nombre: z.string(),
        nombre_visible: z.string().optional(),
        estado: z.enum(['Running', 'Stopped']).default('Running'),
        inicio: z.enum(['Automatic', 'Manual', 'Disabled']).default('Automatic'),
        falla: z.string().optional(),
      }),
    )
    .optional(),
  procesos: z
    .array(
      z.strictObject({
        nombre: z.string(),
        cpu: z.number().default(0),
        memoria_mb: z.number().default(20),
      }),
    )
    .optional(),
  caracteristicas: z
    .array(z.strictObject({ nombre: z.string(), nombre_visible: z.string(), instalada: z.boolean().default(false) }))
    .optional(),
  ad: z
    .strictObject({
      ous: z.array(z.string()).default([]),
      usuarios: z
        .array(
          z.strictObject({
            sam: z.string(),
            nombre: z.string(),
            apellido: z.string().optional(),
            ou: z.string().optional(),
            habilitado: z.boolean().default(true),
            grupos: z.array(z.string()).default([]),
            departamento: z.string().optional(),
            ultimo_inicio: z.string().optional(),
            contrasena_nunca_vence: z.boolean().default(false),
          }),
        )
        .default([]),
      grupos: z
        .array(
          z.strictObject({
            nombre: z.string(),
            ambito: z.enum(['Global', 'DomainLocal', 'Universal']).default('Global'),
            categoria: z.enum(['Security', 'Distribution']).default('Security'),
            ou: z.string().optional(),
            miembros: z.array(z.string()).default([]),
          }),
        )
        .default([]),
      equipos: z
        .array(z.strictObject({ nombre: z.string(), ou: z.string().optional(), so: z.string().optional() }))
        .default([]),
    })
    .optional(),
  eventos: z
    .array(
      z.strictObject({
        log: z.enum(['System', 'Application', 'Security']),
        id: z.number().int(),
        nivel: z.enum(['Information', 'Warning', 'Error']).default('Information'),
        origen: z.string(),
        mensaje: z.string(),
        hace_minutos: z.number().default(30),
      }),
    )
    .default([]),
  red: z
    .strictObject({
      ip: z.string().default('192.168.10.10'),
      prefijo: z.number().int().default(24),
      puerta_enlace: z.string().default('192.168.10.1'),
      dns: z.array(z.string()).default(['192.168.10.10']),
      alcanzables: z.array(z.string()).default([]),
    })
    .default({ ip: '192.168.10.10', prefijo: 24, puerta_enlace: '192.168.10.1', dns: ['192.168.10.10'], alcanzables: [] }),
})

export const psCheckSchema = z.union([
  z.strictObject({ archivo: z.string(), existe: z.boolean().default(true), contenido_incluye: z.string().optional() }),
  z.strictObject({
    servicio: z.string(),
    estado: z.enum(['Running', 'Stopped']).optional(),
    inicio: z.enum(['Automatic', 'Manual', 'Disabled']).optional(),
  }),
  z.strictObject({ proceso: z.string(), existe: z.boolean().default(true) }),
  z.strictObject({ caracteristica: z.string(), instalada: z.boolean().default(true) }),
  z.strictObject({
    usuario_ad: z.string(),
    existe: z.boolean().default(true),
    habilitado: z.boolean().optional(),
    en_grupos: z.array(z.string()).optional(),
    ou: z.string().optional(),
    departamento: z.string().optional(),
  }),
  z.strictObject({ grupo_ad: z.string(), existe: z.boolean().default(true), miembros: z.array(z.string()).optional() }),
  z.strictObject({ ou: z.string(), existe: z.boolean().default(true) }),
  z.strictObject({ salida_contiene: z.string() }),
  z.strictObject({ salida_regex: z.string() }),
  z.strictObject({ comando_usado: z.string() }),
])

export type PsState = z.infer<typeof psStateSchema>
export type PsStateInput = z.input<typeof psStateSchema>
export type PsCheck = z.infer<typeof psCheckSchema>
