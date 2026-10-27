import { z } from 'zod'

const fileSpecSchema = z.union([
  z.string(),
  z.strictObject({
    tipo: z.enum(['archivo', 'directorio', 'enlace']).default('archivo'),
    contenido: z.string().optional(),
    modo: z.string().regex(/^[0-7]{3,4}$/, 'Modo octal, por ejemplo 0644').optional(),
    dueno: z.string().optional(),
    grupo: z.string().optional(),
    destino: z.string().optional(),
  }),
])

export const bashStateSchema = z.strictObject({
  distro: z.enum(['rocky', 'ubuntu']).default('rocky'),
  hostname: z.string().default('servidor'),
  /** Cómo arranca la máquina: BIOS heredado (tabla MBR en Rocky) o UEFI (con partición EFI). */
  firmware: z.enum(['bios', 'uefi']).default('bios'),
  secure_boot: z.boolean().default(true),
  usuario: z.string().default('estudiante'),
  directorio: z.string().optional(),
  usuarios: z
    .array(
      z.strictObject({
        nombre: z.string(),
        uid: z.number().int().optional(),
        grupos: z.array(z.string()).default([]),
        shell: z.string().optional(),
        home: z.string().optional(),
        sudo: z.boolean().default(false),
        comentario: z.string().optional(),
        bloqueado: z.boolean().default(false),
      }),
    )
    .default([]),
  grupos: z
    .array(z.strictObject({ nombre: z.string(), gid: z.number().int().optional(), miembros: z.array(z.string()).default([]) }))
    .default([]),
  archivos: z.record(z.string(), fileSpecSchema).default({}),
  servicios: z
    .record(
      z.string(),
      z.strictObject({
        activo: z.boolean().default(false),
        habilitado: z.boolean().default(false),
        descripcion: z.string().optional(),
        falla: z.string().optional(),
        puertos: z.array(z.number().int()).default([]),
        paquete: z.string().optional(),
      }),
    )
    .default({}),
  paquetes: z
    .strictObject({
      instalados: z.array(z.string()).default([]),
      disponibles: z.array(z.string()).default([]),
    })
    .default({ instalados: [], disponibles: [] }),
  procesos: z
    .array(
      z.strictObject({
        usuario: z.string(),
        comando: z.string(),
        cpu: z.number().default(0),
        mem: z.number().default(0.1),
      }),
    )
    .default([]),
  red: z
    .strictObject({
      interfaces: z
        .array(
          z.strictObject({
            nombre: z.string(),
            ip: z.string().optional(),
            mac: z.string().optional(),
            estado: z.enum(['UP', 'DOWN']).default('UP'),
          }),
        )
        .default([{ nombre: 'enp0s3', ip: '192.168.1.10/24', estado: 'UP' }]),
      puerta_enlace: z.string().optional().default('192.168.1.1'),
      dns: z.array(z.string()).default(['192.168.1.1']),
      alcanzables: z.array(z.string()).default([]),
      internet: z.boolean().default(true),
      registros_dns: z.record(z.string(), z.string()).default({}),
      sitios_web: z.record(z.string(), z.string()).default({}),
    })
    .default({
      interfaces: [{ nombre: 'enp0s3', ip: '192.168.1.10/24', estado: 'UP' }],
      puerta_enlace: '192.168.1.1',
      dns: ['192.168.1.1'],
      alcanzables: [],
      internet: true,
      registros_dns: {},
      sitios_web: {},
    }),
  journal: z
    .array(
      z.strictObject({
        unidad: z.string(),
        mensaje: z.string(),
        prioridad: z.enum(['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug']).default('info'),
        hace_minutos: z.number().default(10),
      }),
    )
    .default([]),
})

export const bashCheckSchema = z.union([
  z.strictObject({
    archivo: z.string(),
    existe: z.boolean().default(true),
    tipo: z.enum(['archivo', 'directorio', 'enlace']).optional(),
    modo: z.string().regex(/^[0-7]{3,4}$/).optional(),
    dueno: z.string().optional(),
    grupo: z.string().optional(),
    contenido_incluye: z.string().optional(),
    contenido_igual: z.string().optional(),
    destino: z.string().optional(),
  }),
  z.strictObject({
    usuario: z.string(),
    existe: z.boolean().default(true),
    en_grupos: z.array(z.string()).optional(),
    shell: z.string().optional(),
    home: z.string().optional(),
    bloqueado: z.boolean().optional(),
  }),
  z.strictObject({ grupo: z.string(), existe: z.boolean().default(true), miembros: z.array(z.string()).optional() }),
  z.strictObject({ servicio: z.string(), activo: z.boolean().optional(), habilitado: z.boolean().optional() }),
  z.strictObject({ paquete: z.string(), instalado: z.boolean().default(true) }),
  z.strictObject({ proceso: z.string(), existe: z.boolean().default(true) }),
  z.strictObject({ salida_contiene: z.string() }),
  z.strictObject({ salida_regex: z.string() }),
  z.strictObject({ comando_usado: z.string() }),
  z.strictObject({ directorio_actual: z.string() }),
  z.strictObject({ usuario_actual: z.string() }),
])

export type BashState = z.infer<typeof bashStateSchema>
export type BashStateInput = z.input<typeof bashStateSchema>
export type BashCheck = z.infer<typeof bashCheckSchema>
