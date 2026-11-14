import { z } from 'zod'

const fileSpecSchema = z.union([
  z.string(),
  z.strictObject({ tipo: z.enum(['archivo', 'directorio']).default('archivo'), contenido: z.string().optional(), tamano_mb: z.number().optional() }),
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
      /** Nivel funcional del bosque y del dominio. */
      nivel_funcional: z.enum(['Windows2016', 'Windows2025']).default('Windows2025'),
      /** Papelera de reciclaje de AD activada. */
      papelera: z.boolean().default(false),
      /** OUs con la herencia de directivas bloqueada. */
      bloquear_herencia: z.array(z.string()).default([]),
      gpos: z
        .array(
          z.strictObject({
            nombre: z.string(),
            estado: z.enum(['AllSettingsEnabled', 'UserSettingsDisabled', 'ComputerSettingsDisabled', 'AllSettingsDisabled']).default('AllSettingsEnabled'),
            /** "dominio" o la ruta de una OU ("Empresa/Ventas"). */
            vinculos: z.array(z.strictObject({ a: z.string(), exigido: z.boolean().default(false), habilitado: z.boolean().default(true) })).default([]),
            configuracion: z
              .array(z.strictObject({ clave: z.string(), valor_nombre: z.string(), valor: z.union([z.string(), z.number()]), nombre_visible: z.string().optional() }))
              .default([]),
            /** Quiénes tienen "Aplicar directiva de grupo". */
            aplicar_a: z.array(z.string()).default(['Authenticated Users']),
            /** Quiénes pueden leerla; si falta, los mismos de aplicar_a. */
            lectura: z.array(z.string()).optional(),
            wmi: z.strictObject({ nombre: z.string(), cumple: z.boolean() }).optional(),
          }),
        )
        .default([]),
    })
    .optional(),
  dns: z.array(z.strictObject({ nombre: z.string(), tipo: z.enum(['A', 'AAAA', 'CNAME', 'MX']).default('A'), valor: z.string() })).default([]),
  /** Permisos NTFS explícitos por ruta. */
  permisos: z
    .record(
      z.string(),
      z.strictObject({
        herencia: z.boolean().default(true),
        dueno: z.string().optional(),
        reglas: z
          .array(
            z.strictObject({
              quien: z.string(),
              nivel: z.enum(['FullControl', 'Modify', 'ReadAndExecute', 'Read', 'Write', 'ListDirectory']),
              tipo: z.enum(['permitir', 'denegar']).default('permitir'),
              aplica: z.enum(['carpeta_subcarpetas_archivos', 'carpeta', 'subcarpetas_archivos', 'carpeta_subcarpetas', 'archivos']).default('carpeta_subcarpetas_archivos'),
            }),
          )
          .default([]),
      }),
    )
    .default({}),
  recursos_compartidos: z
    .array(
      z.strictObject({
        nombre: z.string(),
        ruta: z.string(),
        descripcion: z.string().optional(),
        acceso: z.array(z.strictObject({ quien: z.string(), nivel: z.enum(['Full', 'Change', 'Read']), tipo: z.enum(['permitir', 'denegar']).default('permitir') })).default([{ quien: 'Everyone', nivel: 'Read', tipo: 'permitir' }]),
        /** Enumeración basada en acceso. */
        abe: z.boolean().default(false),
      }),
    )
    .default([]),
  cuotas: z.array(z.strictObject({ ruta: z.string(), limite_mb: z.number(), blanda: z.boolean().default(false) })).default([]),
  filtros_archivos: z.array(z.strictObject({ ruta: z.string(), grupos: z.array(z.string()) })).default([]),
  /** Unidades de red del cliente: { 'S:': '\\\\SRV-ARCH01\\Ventas' } */
  unidades_red: z.record(z.string(), z.string()).default({}),
  /** Espacio de nombres DFS de dominio (se guarda en AD). */
  dfs: z.strictObject({ espacio: z.string(), destinos: z.array(z.string()), carpetas: z.array(z.strictObject({ nombre: z.string(), destinos: z.array(z.string()) })).default([]) }).optional(),
  /** Rol de servidor DHCP con sus ámbitos (autorizado en AD si el equipo es de un dominio). */
  dhcp_servidor: z
    .strictObject({
      autorizado: z.boolean().default(true),
      servicio_detenido: z.boolean().default(false),
      ambitos: z
        .array(
          z.strictObject({
            nombre: z.string().optional(),
            inicio: z.string(),
            fin: z.string(),
            prefijo: z.number().int().default(24),
            activo: z.boolean().default(true),
            duracion_dias: z.number().default(8),
            puerta_enlace: z.string().optional(),
            dns: z.array(z.string()).default([]),
            dominio: z.string().optional(),
            exclusiones: z.array(z.tuple([z.string(), z.string()])).default([]),
            reservas: z.array(z.strictObject({ ip: z.string(), mac: z.string(), nombre: z.string().optional() })).default([]),
            concesiones: z.array(z.strictObject({ ip: z.string(), mac: z.string(), nombre: z.string() })).default([]),
          }),
        )
        .default([]),
    })
    .optional(),
  /** Rol de servidor DNS: zonas (además de la del dominio en un DC), reenviadores y limpieza. */
  dns_servidor: z
    .strictObject({
      zonas: z
        .array(
          z.strictObject({
            nombre: z.string(),
            tipo: z.enum(['primaria', 'reenviador_condicional']).default('primaria'),
            integrada_ad: z.boolean().default(true),
            maestros: z.array(z.string()).default([]),
            antiguedad: z.boolean().default(false),
            actualizacion: z.enum(['segura', 'no_segura', 'ninguna']).optional(),
            /** hace_dias: registro dinámico con esa antigüedad (sin él, es estático). */
            registros: z.array(z.strictObject({ nombre: z.string(), tipo: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'PTR', 'TXT']).default('A'), valor: z.string(), hace_dias: z.number().optional() })).default([]),
          }),
        )
        .default([]),
      reenviadores: z.array(z.string()).default([]),
      limpieza: z.boolean().default(false),
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
  z.strictObject({
    gpo: z.string(),
    existe: z.boolean().default(true),
    /** "dominio" o la ruta de una OU. */
    vinculada_a: z.string().optional(),
    exigida: z.boolean().optional(),
    vinculo_habilitado: z.boolean().optional(),
    configura: z.strictObject({ clave: z.string(), valor_nombre: z.string(), valor: z.union([z.string(), z.number()]).optional() }).optional(),
    aplica_a_grupo: z.string().optional(),
  }),
  z.strictObject({ herencia_bloqueada: z.string(), bloqueada: z.boolean().default(true) }),
  /** La GPO se aplica (según el RSoP actual) al usuario o equipo "a". */
  z.strictObject({ gpo_aplicada: z.string(), a: z.string(), aplicada: z.boolean().default(true) }),
  /** En el RSoP de "a", la configuración la gana esa GPO. */
  z.strictObject({ gpo_ganadora: z.string(), a: z.string(), clave: z.string(), valor_nombre: z.string() }),
  z.strictObject({ es_controlador: z.boolean() }),
  z.strictObject({ unido_a: z.string() }),
  z.strictObject({ papelera_ad: z.boolean() }),
  z.strictObject({ reloj_desfase_max: z.number() }),
  z.strictObject({ dns_cliente: z.array(z.string()) }),
  z.strictObject({ fsmo: z.enum(['SchemaMaster', 'DomainNamingMaster', 'PDCEmulator', 'RIDMaster', 'InfrastructureMaster']), en_equipo: z.string() }),
  z.strictObject({ cuenta_servicio: z.string(), existe: z.boolean().default(true), instalada: z.boolean().optional() }),
  z.strictObject({ politica_contrasenas: z.strictObject({ longitud_minima: z.number().optional(), umbral_bloqueo: z.number().optional(), complejidad: z.boolean().optional() }) }),
  z.strictObject({ politica_resultante: z.string(), politica: z.string() }),
  /** Servidor DNS: una zona de este servidor. */
  z.strictObject({ zona_dns: z.string(), existe: z.boolean().default(true), integrada_ad: z.boolean().optional(), inversa: z.boolean().optional(), reenviador_condicional: z.boolean().optional(), antiguedad: z.boolean().optional() }),
  /** Servidor DNS: un registro cargado en una de sus zonas. */
  z.strictObject({ registro_dns: z.string(), tipo: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'PTR', 'TXT']).default('A'), valor: z.string().optional(), existe: z.boolean().default(true) }),
  z.strictObject({ reenviador_dns: z.string() }),
  z.strictObject({ limpieza_dns: z.boolean() }),
  /** Cliente: el nombre se resuelve (con el DNS que tiene configurado este equipo). */
  z.strictObject({ resuelve: z.string(), tipo: z.enum(['A', 'CNAME', 'MX', 'PTR', 'SRV']).default('A'), valor: z.string().optional(), resuelve_bien: z.boolean().default(true) }),
  /** Servidor DHCP: un ámbito y su configuración. */
  z.strictObject({ ambito_dhcp: z.string(), existe: z.boolean().default(true), activo: z.boolean().optional(), inicio: z.string().optional(), fin: z.string().optional(), puerta_enlace: z.string().optional(), dns: z.array(z.string()).optional(), excluye: z.string().optional() }),
  z.strictObject({ reserva_dhcp: z.string(), mac: z.string().optional(), ambito: z.string().optional() }),
  z.strictObject({ dhcp_autorizado: z.boolean() }),
  z.strictObject({ conmutacion_dhcp: z.string(), modo: z.enum(['LoadBalance', 'HotStandby']).optional() }),
  /** NTFS: nivel efectivo de una cuenta (usuario o grupo) sobre una ruta local de este equipo. */
  z.strictObject({ permiso_ntfs: z.string(), para: z.string(), nivel: z.enum(['FullControl', 'Modify', 'ReadAndExecute', 'Read', 'Write', 'None', 'Special']) }),
  z.strictObject({ herencia_ntfs: z.string(), habilitada: z.boolean() }),
  z.strictObject({ recurso_compartido: z.string(), ruta: z.string().optional(), existe: z.boolean().default(true), abe: z.boolean().optional() }),
  z.strictObject({ acceso_compartido: z.string(), cuenta: z.string(), nivel: z.enum(['Full', 'Change', 'Read', 'None']) }),
  /** Por la red: lo que puede hacer un usuario del dominio en \\servidor\recurso\ruta (recurso + NTFS). */
  z.strictObject({ acceso_red: z.string(), usuario: z.string(), nivel: z.enum(['FullControl', 'Modify', 'ReadAndExecute', 'Read', 'Write', 'None', 'Special']) }),
  z.strictObject({ cuota: z.string(), limite_mb: z.number().optional(), blanda: z.boolean().optional() }),
  z.strictObject({ filtro_archivos: z.string(), grupo: z.string().optional() }),
  z.strictObject({ carpeta_dfs: z.string(), destino: z.string().optional() }),
  z.strictObject({ unidad_red: z.string(), ruta: z.string().optional() }),
  /** Cliente: tiene una concesión de DHCP (no una dirección APIPA). */
  z.strictObject({ concesion_dhcp: z.boolean(), direccion: z.string().optional(), de: z.string().optional() }),
])

export const psCheckSchema = z.union([psSingleCheckSchema, z.strictObject({ en: z.string(), verificar: psSingleCheckSchema })])

export type PsState = z.infer<typeof psStateSchema>
export type PsStateInput = z.input<typeof psStateSchema>
export type PsServerState = z.infer<typeof psServerSchema>
export type PsCheck = z.infer<typeof psCheckSchema>
export type PsCheckInput = z.input<typeof psCheckSchema>
