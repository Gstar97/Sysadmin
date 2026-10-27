import { z } from 'zod'

const cidr = z.string().regex(/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/, 'Dirección con prefijo, por ejemplo 192.168.1.10/24')
const ipv4 = z.string().regex(/^\d{1,3}(\.\d{1,3}){3}$/, 'Dirección IPv4, por ejemplo 192.168.1.1')

export const deviceTypeSchema = z.enum(['pc', 'servidor', 'switch', 'switch_l3', 'router'])

export const interfaceSpecSchema = z.strictObject({
  nombre: z.string(),
  ip: cidr.optional(),
  apagada: z.boolean().default(false),
  modo: z.enum(['acceso', 'troncal']).optional(),
  vlan: z.number().int().min(1).max(4094).optional(),
  vlans_permitidas: z.union([z.literal('todas'), z.array(z.number().int().min(1).max(4094))]).optional(),
  vlan_nativa: z.number().int().min(1).max(4094).optional(),
  descripcion: z.string().optional(),
  subinterfaces: z
    .array(z.strictObject({ nombre: z.string(), vlan: z.number().int().min(1).max(4094), ip: cidr }))
    .default([]),
})

export const deviceSpecSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'Id de equipo sin espacios'),
  tipo: deviceTypeSchema,
  nombre: z.string().optional(),
  x: z.number().default(0),
  y: z.number().default(0),
  interfaces: z.array(interfaceSpecSchema).default([]),
  puerta_enlace: ipv4.optional(),
  vlans: z.array(z.strictObject({ id: z.number().int().min(1).max(4094), nombre: z.string().optional() })).default([]),
  svis: z.array(z.strictObject({ vlan: z.number().int().min(1).max(4094), ip: cidr })).default([]),
  rutas: z.array(z.strictObject({ destino: cidr, via: ipv4 })).default([]),
  enrutamiento: z.boolean().optional(),
  ospf: z
    .strictObject({
      proceso: z.number().int().default(1),
      router_id: ipv4.optional(),
      redes: z.array(z.strictObject({ red: ipv4, wildcard: ipv4, area: z.number().int().default(0) })).default([]),
      pasivas: z.array(z.string()).default([]),
    })
    .optional(),
  bloqueado: z.boolean().default(false),
})

export const linkSpecSchema = z.strictObject({
  a: z.string().regex(/^[^:]+:.+$/, 'Formato equipo:interfaz'),
  b: z.string().regex(/^[^:]+:.+$/, 'Formato equipo:interfaz'),
})

export const objectiveSpecSchema = z.strictObject({
  desde: z.string(),
  hacia: z.string(),
  resultado: z.enum(['ok', 'falla']).default('ok'),
  descripcion: z.string().optional(),
})

export const topologySpecSchema = z.strictObject({
  dispositivos: z.array(deviceSpecSchema).default([]),
  enlaces: z.array(linkSpecSchema).default([]),
})

export const topologyExerciseSchema = z.strictObject({
  tipo: z.literal('topologia'),
  titulo: z.string().optional(),
  consigna: z.string().optional(),
  dispositivos: z.array(deviceSpecSchema).default([]),
  enlaces: z.array(linkSpecSchema).default([]),
  objetivos: z.array(objectiveSpecSchema).default([]),
  editable: z
    .strictObject({
      equipos: z.boolean().default(true),
      enlaces: z.boolean().default(true),
      configuracion: z.boolean().default(true),
    })
    .default({ equipos: true, enlaces: true, configuracion: true }),
  paleta: z.array(deviceTypeSchema).default(['pc', 'servidor', 'switch', 'switch_l3', 'router']),
})

export const iosStateSchema = z.strictObject({
  topologia: topologySpecSchema,
  consola: z.string(),
})

export const iosCheckSchema = z.union([
  z.strictObject({ equipo: z.string().optional(), config_contiene: z.string() }),
  z.strictObject({ equipo: z.string().optional(), vlan: z.number().int(), existe: z.boolean().default(true), nombre: z.string().optional() }),
  z.strictObject({
    equipo: z.string().optional(),
    interfaz: z.string(),
    modo: z.enum(['acceso', 'troncal']).optional(),
    vlan: z.number().int().optional(),
    apagada: z.boolean().optional(),
    ip: z.string().optional(),
  }),
  z.strictObject({ equipo: z.string().optional(), ruta: z.string(), via: z.string().optional() }),
  z.strictObject({ ping: objectiveSpecSchema }),
  z.strictObject({ equipo: z.string().optional(), guardado: z.boolean() }),
  z.strictObject({ salida_contiene: z.string() }),
  z.strictObject({ comando_usado: z.string() }),
])

export type DeviceType = z.infer<typeof deviceTypeSchema>
export type DeviceSpec = z.infer<typeof deviceSpecSchema>
export type InterfaceSpec = z.infer<typeof interfaceSpecSchema>
export type LinkSpec = z.infer<typeof linkSpecSchema>
export type ObjectiveSpec = z.infer<typeof objectiveSpecSchema>
export type TopologySpec = z.infer<typeof topologySpecSchema>
export type TopologyExercise = z.infer<typeof topologyExerciseSchema>
export type IosState = z.infer<typeof iosStateSchema>
export type IosCheck = z.infer<typeof iosCheckSchema>
