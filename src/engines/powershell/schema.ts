import { z } from 'zod'

const fileSpecSchema = z.union([
  z.string(),
  z.strictObject({ tipo: z.enum(['archivo', 'directorio']).default('archivo'), contenido: z.string().optional() }),
])

const diskSchema = z.strictObject({
  numero: z.number().int().min(0),
  tamano_gb: z.number().positive(),
  modelo: z.string().default('Msft Virtual Disk'),
  estilo: z.enum(['RAW', 'GPT', 'MBR']).default('RAW'),
  offline: z.boolean().default(false),
  bus: z.enum(['SCSI', 'SAS', 'SATA', 'NVMe', 'iSCSI', 'Virtual']).default('SAS'),
  particiones: z
    .array(
      z.strictObject({
        letra: z.string().optional(),
        tamano_gb: z.number().positive(),
        sistema: z.enum(['NTFS', 'ReFS', 'FAT32']).optional(),
        etiqueta: z.string().default(''),
        tipo: z.enum(['Basic', 'System', 'Reserved', 'Recovery']).default('Basic'),
        usado_gb: z.number().default(0),
      }),
    )
    .default([]),
})

const firewallRuleSchema = z.strictObject({
  nombre: z.string(),
  nombre_visible: z.string(),
  grupo: z.string().optional(),
  habilitada: z.boolean().default(true),
  direccion: z.enum(['Inbound', 'Outbound']).default('Inbound'),
  accion: z.enum(['Allow', 'Block']).default('Allow'),
  protocolo: z.enum(['TCP', 'UDP', 'ICMPv4', 'Any']).default('TCP'),
  puerto: z.string().optional(),
  perfil: z.string().default('Any'),
  origen: z.string().default('Any'),
})

const stateShape = {
  equipo: z.string().default('SRV01'),
  /** Edición y tipo de instalación. */
  edicion: z.enum(['Standard', 'Datacenter', 'Datacenter: Azure Edition']).default('Standard'),
  experiencia: z.enum(['escritorio', 'core']).default('escritorio'),
  zona_horaria: z.string().default('Pacific Standard Time'),
  /** Desfase del reloj respecto del controlador de dominio, en minutos (Kerberos tolera 5). */
  desfase_reloj_min: z.number().default(0),
  powershell7: z.boolean().default(false),
  /** Controlador de dominio de un dominio que ya existe en el laboratorio (comparte su base de AD). */
  controlador_dominio: z.boolean().default(false),
  politica_ejecucion: z.enum(['Restricted', 'AllSigned', 'RemoteSigned', 'Unrestricted', 'Bypass']).default('RemoteSigned'),
  /** WinRM escuchando (Windows Server lo trae activado). */
  remoting: z.boolean().default(true),
  escritorio_remoto: z.boolean().default(false),
  trusted_hosts: z.string().default(''),
  /** Módulos de PowerShell instalados además de los de fábrica. */
  modulos: z.array(z.string()).default([]),
  actualizaciones: z
    .array(z.strictObject({ id: z.string(), descripcion: z.string().default('Security Update'), hace_dias: z.number().default(20) }))
    .optional(),
  discos: z.array(diskSchema).optional(),
  firewall: z
    .strictObject({
      perfiles: z.strictObject({ Domain: z.boolean().default(true), Private: z.boolean().default(true), Public: z.boolean().default(true) }).default({ Domain: true, Private: true, Public: true }),
      reglas: z.array(firewallRuleSchema).default([]),
      /** Reglas de fábrica que arrancan habilitadas (por nombre interno o visible). */
      habilitar: z.array(z.string()).default([]),
    })
    .default({ perfiles: { Domain: true, Private: true, Public: true }, reglas: [], habilitar: [] }),
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
            bloqueado: z.boolean().default(false),
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
  dns: z.array(z.strictObject({ nombre: z.string(), tipo: z.enum(['A', 'AAAA', 'CNAME', 'MX']).default('A'), valor: z.string() })).default([]),
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
      adaptador: z.string().default('Ethernet'),
      /** Recibe la IP por DHCP (o APIPA 169.254.x.x si no hay servidor). */
      dhcp: z.boolean().default(false),
      perfil: z.enum(['Public', 'Private', 'DomainAuthenticated']).optional(),
      conectada: z.boolean().default(true),
    })
    .default({ ip: '192.168.10.10', prefijo: 24, puerta_enlace: '192.168.10.1', dns: ['192.168.10.10'], alcanzables: [], adaptador: 'Ethernet', dhcp: false, conectada: true }),
}

/** Otro equipo de la red, al que se llega con Invoke-Command, Enter-PSSession, ping o Test-NetConnection. */
export const psServerSchema = z.strictObject(stateShape)

export const psStateSchema = z.strictObject({
  ...stateShape,
  servidores: z.array(psServerSchema).default([]),
})

const psSingleCheckSchema = z.union([
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
  z.strictObject({ nombre_equipo: z.string(), pendiente: z.boolean().optional() }),
  z.strictObject({ ip: z.string(), prefijo: z.number().int().optional(), puerta_enlace: z.string().optional(), dns: z.array(z.string()).optional() }),
  z.strictObject({ perfil_red: z.enum(['Public', 'Private', 'DomainAuthenticated']) }),
  z.strictObject({ regla_firewall: z.string(), habilitada: z.boolean().default(true) }),
  z.strictObject({ permite: z.string(), desde: z.string().optional(), permite_acceso: z.boolean().default(true) }),
  z.strictObject({ disco: z.number().int(), estilo: z.enum(['RAW', 'GPT', 'MBR']).optional(), offline: z.boolean().optional() }),
  z.strictObject({ volumen: z.string(), sistema: z.enum(['NTFS', 'ReFS', 'FAT32']).optional(), etiqueta: z.string().optional(), tamano_min_gb: z.number().optional() }),
  z.strictObject({ zona_horaria: z.string() }),
  z.strictObject({ remoting: z.boolean() }),
  z.strictObject({ escritorio_remoto: z.boolean() }),
  z.strictObject({ variable: z.string(), valor: z.string().optional(), existe: z.boolean().default(true) }),
  z.strictObject({ funcion: z.string(), existe: z.boolean().default(true) }),
])

export const psCheckSchema = z.union([psSingleCheckSchema, z.strictObject({ en: z.string(), verificar: psSingleCheckSchema })])

export type PsState = z.infer<typeof psStateSchema>
export type PsStateInput = z.input<typeof psStateSchema>
export type PsServerState = z.infer<typeof psServerSchema>
export type PsCheck = z.infer<typeof psCheckSchema>
export type PsCheckInput = z.input<typeof psCheckSchema>
