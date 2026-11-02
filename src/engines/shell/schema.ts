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
    /** Tamaño aparente del archivo (por ejemplo 2G): para simular archivos grandes. */
    tamano: z.string().optional(),
    /** Tipo de SELinux puesto a mano (por ejemplo user_home_t, como queda al moverlo desde un home). */
    etiqueta: z.string().optional(),
  }),
])

const fsKind = z.enum(['xfs', 'ext4', 'vfat', 'swap'])

const stateShape = {
  distro: z.enum(['rocky', 'ubuntu']).default('rocky'),
  hostname: z.string().default('servidor'),
  /** Cómo arranca la máquina: BIOS heredado (tabla MBR en Rocky) o UEFI (con partición EFI). */
  firmware: z.enum(['bios', 'uefi']).default('bios'),
  secure_boot: z.boolean().default(true),
  /** Modo de SELinux en Rocky. */
  selinux: z.enum(['enforcing', 'permissive', 'disabled']).default('enforcing'),
  /** Booleanos de SELinux que el ejercicio deja activados. */
  booleanos_selinux: z.array(z.string()).default([]),
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
        /**
         * En el servidor del ejercicio: el usuario ya tiene su clave SSH (~/.ssh/id_ed25519).
         * En los demás servidores: esa clave ya está en su authorized_keys.
         */
        clave_ssh: z.boolean().default(false),
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
        /** Empieza en estado "failed" (por ejemplo, se cayó durante la noche). */
        fallido: z.boolean().default(false),
        /** Hace cuánto cambió de estado (por defecto, una hora). */
        hace_minutos: z.number().optional(),
        /** Timers: hace cuánto se ejecutó por última vez. */
        ultima_hace_minutos: z.number().optional(),
        /** Archivos que el proceso del servicio tiene abiertos. */
        abiertos: z.array(z.string()).default([]),
      }),
    )
    .default({}),
  paquetes: z
    .strictObject({
      instalados: z.array(z.string()).default([]),
      disponibles: z.array(z.string()).default([]),
      /** Paquetes instalados que tienen una versión nueva disponible. */
      actualizables: z.array(z.string()).default([]),
    })
    .default({ instalados: [], disponibles: [], actualizables: [] }),
  procesos: z
    .array(
      z.strictObject({
        usuario: z.string(),
        comando: z.string(),
        cpu: z.number().default(0),
        mem: z.number().default(0.1),
        /** Archivos que el proceso tiene abiertos (si se borran, siguen ocupando espacio). */
        abiertos: z.array(z.string()).default([]),
        /** Estado: R (corriendo), S (esperando), D (esperando el disco), T (detenido), Z (zombi). */
        estado: z.enum(['R', 'S', 'D', 'T', 'Z']).optional(),
        nice: z.number().int().min(-20).max(19).optional(),
        /** Lectura y escritura en disco, en MB/s. */
        io_lectura: z.number().optional(),
        io_escritura: z.number().optional(),
        /** No termina con SIGTERM: hace falta SIGKILL. */
        ignora_term: z.boolean().optional(),
        hace_minutos: z.number().optional(),
        /** Texto del comando del proceso padre (si es otro proceso del ejercicio). */
        padre: z.string().optional(),
      }),
    )
    .default([]),
  /** Datos de rendimiento que no salen de los procesos. */
  rendimiento: z
    .strictObject({
      memoria_usada: z.string().optional(),
      cache: z.string().optional(),
      swap_usada: z.string().optional(),
      /** Porcentaje de CPU que el hipervisor le quita a la VM (st). */
      cpu_robada: z.number().optional(),
      carga: z.array(z.number()).length(3).optional(),
      /** Hace cuántos minutos empezó el problema: sar muestra valores normales antes. */
      incidente_desde_minutos: z.number().optional(),
    })
    .default({}),
  /** Discos extra (sdb, sdc...), vacíos o con particiones. */
  discos: z
    .array(
      z.strictObject({
        nombre: z.string().regex(/^sd[b-z]$/),
        tamano: z.string(),
        tabla: z.enum(['gpt', 'msdos']).optional(),
        particiones: z
          .array(
            z.strictObject({
              tamano: z.string(),
              tipo: z.enum(['linux', 'lvm', 'swap']).default('linux'),
              fs: fsKind.optional(),
              montaje: z.string().optional(),
              usado: z.string().optional(),
              fstab: z.boolean().default(true),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
  /** Grupos de volúmenes LVM extra, armados sobre discos enteros o particiones. */
  volumenes: z
    .array(
      z.strictObject({
        vg: z.string(),
        discos: z.array(z.string()),
        lvs: z
          .array(
            z.strictObject({
              nombre: z.string(),
              tamano: z.string(),
              fs: fsKind.optional(),
              montaje: z.string().optional(),
              usado: z.string().optional(),
              fstab: z.boolean().default(true),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
  /** Hora del servidor: zona, desfase del reloj y servidor NTP configurado en chrony. */
  hora: z
    .strictObject({
      zona: z.string().default('UTC'),
      desfase_segundos: z.number().default(0),
      servidor_ntp: z.string().optional(),
    })
    .default({ zona: 'UTC', desfase_segundos: 0 }),
  /** Espacio ocupado en la raíz (por defecto, unos 4,3 GiB del sistema instalado). */
  uso_raiz: z.string().optional(),
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
  /** Intentos fallidos de inicio de sesión registrados por pam_faillock, por usuario. */
  faillock: z.record(z.string(), z.number().int().min(0)).default({}),
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
}

/** Otro servidor de la red del ejercicio (para ssh, scp y el bastión). */
export const remoteHostSchema = z.strictObject({
  ...stateShape,
  /** Dirección en la red; si no se definen interfaces, se crea enp0s3 con esta IP y máscara /24. */
  ip: z.string(),
  /** Si el known_hosts del usuario del ejercicio ya tiene la clave de este servidor (o una vieja). */
  clave_conocida: z.enum(['no', 'si', 'cambiada']).default('no'),
  /** Si el DNS de la red resuelve su nombre (si no, hay que usar la IP o /etc/hosts). */
  en_dns: z.boolean().default(true),
})

export const bashStateSchema = z.strictObject({
  ...stateShape,
  /** Los demás servidores de la red. */
  servidores: z.array(remoteHostSchema).default([]),
})

const singleCheckSchema = z.union([
  z.strictObject({
    archivo: z.string(),
    existe: z.boolean().default(true),
    tipo: z.enum(['archivo', 'directorio', 'enlace']).optional(),
    modo: z.string().regex(/^[0-7]{3,4}$/).optional(),
    dueno: z.string().optional(),
    grupo: z.string().optional(),
    contenido_incluye: z.string().optional(),
    contenido_no_incluye: z.string().optional(),
    contenido_igual: z.string().optional(),
    destino: z.string().optional(),
    /** Cantidad de nombres (enlaces duros) que apuntan al mismo archivo. */
    enlaces: z.number().int().min(1).optional(),
    /** Entrada que tiene que aparecer en la ACL, como la muestra getfacl (ej.: group:auditoria:r-x). */
    acl_incluye: z.string().optional(),
    acl_no_incluye: z.string().optional(),
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
  z.strictObject({ servicio: z.string(), activo: z.boolean().optional(), habilitado: z.boolean().optional(), fallido: z.boolean().optional() }),
  z.strictObject({ paquete: z.string(), instalado: z.boolean().default(true) }),
  z.strictObject({ proceso: z.string(), existe: z.boolean().default(true) }),
  z.strictObject({ salida_contiene: z.string() }),
  z.strictObject({ salida_regex: z.string() }),
  z.strictObject({ comando_usado: z.string() }),
  /** ufw activo (o no) en Ubuntu. */
  z.strictObject({ ufw_activo: z.boolean() }),
  /** El firewall del servidor deja pasar ese puerto (ej.: "80/tcp"), desde cualquier origen o desde la IP dada. */
  z.strictObject({ firewall_permite: z.string(), desde: z.string().optional(), permite: z.boolean().default(true) }),
  z.strictObject({ directorio_actual: z.string() }),
  z.strictObject({ usuario_actual: z.string() }),
  z.strictObject({
    /** Carpeta que tiene que estar montada (o no). */
    montaje: z.string(),
    montado: z.boolean().default(true),
    dispositivo: z.string().optional(),
    tipo: z.string().optional(),
    /** Tamaño mínimo del sistema de archivos montado (por ejemplo 4G). */
    tamano_min: z.string().optional(),
  }),
  z.strictObject({
    /** Entrada de /etc/fstab para esa carpeta. */
    fstab: z.string(),
    existe: z.boolean().default(true),
    tipo: z.string().optional(),
    opciones_incluye: z.string().optional(),
    por_uuid: z.boolean().optional(),
  }),
  z.strictObject({ volumen: z.string(), existe: z.boolean().default(true), tamano_min: z.string().optional() }),
  z.strictObject({ grupo_volumenes: z.string(), existe: z.boolean().default(true), discos: z.array(z.string()).optional() }),
  z.strictObject({ particion: z.string(), existe: z.boolean().default(true), tamano_min: z.string().optional(), fs: z.string().optional() }),
  z.strictObject({ swap: z.string(), activa: z.boolean().default(true) }),
])

/** Una verificación, o la misma en otro servidor de la red: { en: web01, verificar: {...} }. */
export const bashCheckSchema = z.union([singleCheckSchema, z.strictObject({ en: z.string(), verificar: singleCheckSchema })])

export type BashState = z.infer<typeof bashStateSchema>
export type BashStateInput = z.input<typeof bashStateSchema>
export type BashCheck = z.infer<typeof bashCheckSchema>
