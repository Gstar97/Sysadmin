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
    /** Hace cuántos días se modificó por última vez (para find -mtime, logrotate, limpiezas). */
    antiguedad_dias: z.number().optional(),
  }),
])

const fsKind = z.enum(['xfs', 'ext4', 'vfat', 'swap'])

const stateShape = {
  distro: z.enum(['rocky', 'ubuntu']).default('rocky'),
  hostname: z.string().default('servidor'),
  /** Cómo arranca la máquina: BIOS heredado (tabla MBR en Rocky) o UEFI (con partición EFI). */
  firmware: z.enum(['bios', 'uefi']).default('bios'),
  /** El equipo: núcleos, memoria y si la CPU expone la virtualización (vmx) a lo que corre adentro. */
  equipo: z
    .strictObject({
      cpus: z.number().int().min(1).default(2),
      memoria_gb: z.number().default(4),
      /** Un servidor físico (no muestra el hipervisor en lscpu). */
      fisico: z.boolean().default(false),
      /** La CPU tiene extensiones de virtualización (en una VM: virtualización anidada activada). */
      vmx: z.boolean().default(false),
      modelo: z.string().optional(),
    })
    .default({ cpus: 2, memoria_gb: 4, fisico: false, vmx: false }),
  secure_boot: z.boolean().default(true),
  /** Modo de SELinux en Rocky. */
  selinux: z.enum(['enforcing', 'permissive', 'disabled']).default('enforcing'),
  /** Booleanos de SELinux que el ejercicio deja activados. */
  booleanos_selinux: z.array(z.string()).default([]),
  /** Servicios que firewalld ya deja pasar (en la configuración activa y en la permanente). */
  servicios_firewall: z.array(z.string()).default([]),
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
            ipv6: z.array(z.string()).default([]),
            /** Pide la dirección por DHCP al levantar la conexión (sin ip fija). */
            dhcp: z.boolean().default(false),
            /** Velocidad negociada en Mb/s y dúplex (ethtool). */
            velocidad: z.number().int().default(1000),
            duplex: z.enum(['full', 'half']).default('full'),
            autonegociacion: z.boolean().default(true),
            mtu: z.number().int().default(1500),
          }),
        )
        .default([{ nombre: 'enp0s3', ip: '192.168.1.10/24', estado: 'UP', ipv6: [], dhcp: false, velocidad: 1000, duplex: 'full', autonegociacion: true, mtu: 1500 }]),
      puerta_enlace: z.string().optional().default('192.168.1.1'),
      dns: z.array(z.string()).default(['192.168.1.1']),
      alcanzables: z.array(z.string()).default([]),
      internet: z.boolean().default(true),
      registros_dns: z.record(z.string(), z.string()).default({}),
      sitios_web: z.record(z.string(), z.string()).default({}),
      /** Resolvedores (que no son del laboratorio) que no responden. */
      dns_caidos: z.array(z.string()).default([]),
      /** Rutas estáticas configuradas al arrancar (además de la ruta por defecto). */
      rutas: z.array(z.strictObject({ red: z.string(), via: z.string() })).default([]),
      /**
       * Redes de otras sedes: sus equipos responden solo si el tráfico sale por ese router
       * (si sale por la puerta de enlace por defecto, se pierde).
       */
      redes_remotas: z.array(z.strictObject({ red: z.string(), via: z.string() })).default([]),
      /** Escenario de tráfico que ve tcpdump en vivo (los de src/engines/captura). */
      trafico: z.string().optional(),
      /** Saltos que muestra mtr hacia un destino: IP, pérdida en % y demora en ms. */
      saltos: z.record(z.string(), z.array(z.strictObject({ ip: z.string(), perdida: z.number().default(0), ms: z.number().default(1) }))).default({}),
      /** MTU menor en el camino hacia una red (un túnel, por ejemplo) y el router que avisa "hay que fragmentar". */
      mtu_camino: z.array(z.strictObject({ red: z.string(), mtu: z.number().int(), router: z.string() })).default([]),
      /** Segundos que tarda un servidor web en empezar a responder (por nombre o IP); lo muestra curl -w. */
      demora_servidor: z.record(z.string(), z.number()).default({}),
      /** Puertos TCP abiertos de un equipo alcanzable (por IP o nombre); si no se declara, responde en todos. */
      puertos_abiertos: z.record(z.string(), z.array(z.number().int())).default({}),
    })
    .default({
      interfaces: [{ nombre: 'enp0s3', ip: '192.168.1.10/24', estado: 'UP', ipv6: [], dhcp: false, velocidad: 1000, duplex: 'full', autonegociacion: true, mtu: 1500 }],
      puerta_enlace: '192.168.1.1',
      dns: ['192.168.1.1'],
      alcanzables: [],
      internet: true,
      registros_dns: {},
      sitios_web: {},
      dns_caidos: [],
      rutas: [],
      redes_remotas: [],
      saltos: {},
      mtu_camino: [],
      demora_servidor: {},
      puertos_abiertos: {},
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
  /** Servicios web: aplicaciones detrás del proxy, DNS público, certificados y Let's Encrypt. */
  web: z
    .strictObject({
      /** Aplicaciones que corren como servicio de systemd (el nombre es el del servicio). */
      aplicaciones: z
        .record(
          z.string(),
          z.strictObject({
            /** "127.0.0.1:8001", "0.0.0.0:3000" o "unix:/run/app/app.sock" (si la unidad no dice otra cosa con --bind o PORT=). */
            escucha: z.string().optional(),
            cuerpo: z.string().optional(),
            /** La página muestra los encabezados que le llegaron (Host, X-Forwarded-For...). */
            eco_encabezados: z.boolean().default(false),
            websocket: z.boolean().default(false),
            demora_s: z.number().default(0),
            codigo: z.number().int().default(200),
            tipo_contenido: z.string().default('text/html; charset=utf-8'),
          }),
        )
        .default({}),
      /** Lo que responde el DNS público (lo que ve Let's Encrypt): nombre → IP pública. */
      dominios_publicos: z.record(z.string(), z.string()).default({}),
      /** IP pública con la que se ve este servidor desde internet (NAT del borde). */
      ip_publica: z.string().optional(),
      /** Puertos que el router de borde reenvía desde internet hasta este servidor. */
      puertos_publicados: z.array(z.number().int()).default([]),
      /** Certificados ya instalados. */
      certificados: z
        .array(
          z.strictObject({
            certificado: z.string(),
            clave: z.string(),
            cn: z.string(),
            san: z.array(z.string()).default([]),
            emisor: z.enum(['letsencrypt', 'staging', 'autofirmado', 'ca_interna']).default('letsencrypt'),
            dias_restantes: z.number().default(60),
            dias_emitido: z.number().default(30),
            /** El archivo trae también el intermedio (fullchain). */
            con_intermedio: z.boolean().default(true),
          }),
        )
        .default([]),
      /** Autoridad certificante interna: certificado y clave en estos archivos. */
      ca_interna: z.strictObject({ cn: z.string(), certificado: z.string(), clave: z.string() }).optional(),
      /** Autoridades internas en las que confía este equipo (por CN; ya en el almacén del sistema). */
      confia_en: z.array(z.string()).default([]),
      /** Un certificado de Let's Encrypt ya emitido con certbot. */
      certbot: z
        .strictObject({
          dominios: z.array(z.string()).min(1),
          metodo: z.enum(['nginx', 'webroot']).default('nginx'),
          webroot: z.string().optional(),
          dias_restantes: z.number().default(60),
          /** Comando que se ejecuta después de renovar (deploy hook). */
          hook: z.string().optional(),
        })
        .optional(),
    })
    .default({ aplicaciones: {}, dominios_publicos: {}, puertos_publicados: [], certificados: [], confia_en: [] }),
  /** Datos SMART de discos físicos (por ruta, ej. /dev/sdb). Sin esto, el disco es virtual y no tiene SMART. */
  smart: z
    .record(
      z.string(),
      z.strictObject({
        estado: z.enum(['ok', 'fallando']).default('ok'),
        reasignados: z.number().int().default(0),
        pendientes: z.number().int().default(0),
        horas: z.number().int().default(25812),
        temperatura: z.number().int().default(36),
        familia: z.string().default('Seagate Exos 7E10'),
        modelo: z.string().default('ST4000NM024B'),
        serie: z.string().default('ZC1A2B3C'),
      }),
    )
    .optional(),
  /** La placa de gestión del servidor (iDRAC, iLO, IPMI). */
  bmc: z
    .strictObject({
      ip: z.string(),
      usuario: z.string().default('admin'),
      clave: z.string(),
      modelo: z.string().default('PowerEdge R760'),
      fuente1: z.boolean().default(true),
      fuente2: z.boolean().default(true),
      sensores: z
        .strictObject({
          ventilador1: z.number().default(5880),
          ventilador2: z.number().default(5760),
          temp_entrada: z.number().default(23),
          temp_salida: z.number().default(35),
          temp_cpu: z.number().default(48),
          consumo: z.number().default(212),
        })
        .default({ ventilador1: 5880, ventilador2: 5760, temp_entrada: 23, temp_salida: 35, temp_cpu: 48, consumo: 212 }),
      eventos: z.array(z.strictObject({ fecha: z.string(), hora: z.string(), texto: z.string() })).default([]),
    })
    .optional(),
  /** Máquinas virtuales de KVM/libvirt que ya existen en este equipo. */
  libvirt: z
    .strictObject({
      vms: z
        .array(
          z.strictObject({
            nombre: z.string(),
            vcpus: z.number().int().default(1),
            vcpus_max: z.number().int().optional(),
            memoria_mb: z.number().int().default(1024),
            memoria_max_mb: z.number().int().optional(),
            /** Memoria que le dejó el globo (ballooning) mientras corre. */
            balloon_mb: z.number().int().optional(),
            disco: z.string().optional(),
            estado: z.enum(['running', 'shut off']).default('shut off'),
            autostart: z.boolean().default(false),
            os: z.string().default('ubuntu24.04'),
            instantaneas: z.array(z.string()).default([]),
          }),
        )
        .default([]),
    })
    .optional(),
  /** El equipo es un nodo de Proxmox VE 9 (Debian 13): conviene usuario root y equipo con varios núcleos. */
  proxmox: z
    .strictObject({
      nodo: z.string().optional(),
      suscripcion: z.boolean().default(false),
      /** Repositorios de apt como quedan al instalar (enterprise) o ya cambiados (no-subscription). */
      repos: z.enum(['enterprise', 'no-subscription']).default('enterprise'),
      /** La placa física sobre la que va vmbr0. */
      placa: z.string().optional(),
      /** Contenido de /etc/network/interfaces (si no, vmbr0 sobre la placa con la IP del equipo). */
      interfaces: z.string().optional(),
      almacenamientos: z
        .array(
          z.strictObject({
            id: z.string(),
            tipo: z.enum(['dir', 'lvmthin', 'lvm', 'zfspool', 'nfs', 'cifs', 'pbs']),
            contenido: z.array(z.string()),
            ruta: z.string().optional(),
            servidor: z.string().optional(),
            export: z.string().optional(),
            datastore: z.string().optional(),
            usuario: z.string().optional(),
            huella: z.string().optional(),
            total_gb: z.number().default(100),
            compartido: z.boolean().default(false),
            activo: z.boolean().default(true),
          }),
        )
        .default([]),
      isos: z.array(z.string()).default([]),
      plantillas_ct: z.array(z.string()).default([]),
      vms: z
        .array(
          z.strictObject({
            id: z.number().int(),
            nombre: z.string(),
            memoria: z.number().int().default(2048),
            nucleos: z.number().int().default(2),
            so: z.string().default('l26'),
            discos: z.record(z.string(), z.string()).default({}),
            red: z.record(z.string(), z.string()).default({}),
            estado: z.enum(['running', 'stopped']).default('stopped'),
            plantilla: z.boolean().default(false),
            /** El agente de QEMU está instalado y corriendo dentro de la VM. */
            agente: z.boolean().default(false),
            onboot: z.boolean().default(false),
            instantaneas: z.array(z.string()).default([]),
            otros: z.record(z.string(), z.string()).default({}),
          }),
        )
        .default([]),
      cts: z
        .array(
          z.strictObject({
            id: z.number().int(),
            nombre: z.string(),
            memoria: z.number().int().default(512),
            nucleos: z.number().int().default(1),
            so: z.string().default('debian'),
            rootfs: z.string().optional(),
            red: z.string().optional(),
            estado: z.enum(['running', 'stopped']).default('stopped'),
            sin_privilegios: z.boolean().default(true),
            onboot: z.boolean().default(false),
          }),
        )
        .default([]),
      respaldos: z.array(z.strictObject({ vmid: z.number().int(), tipo: z.enum(['qemu', 'lxc']).default('qemu'), almacenamiento: z.string().default('local'), dias_atras: z.number().default(1), proteger: z.boolean().default(false) })).default([]),
      usuarios: z.array(z.strictObject({ id: z.string(), comentario: z.string().optional() })).default([]),
      permisos: z.array(z.strictObject({ ruta: z.string(), usuario: z.string(), rol: z.string() })).default([]),
      /** El nodo ya es parte de un clúster con ese nombre: los nodos del ejercicio con el mismo nombre forman el clúster. */
      cluster: z.string().optional(),
      /** IP del equipo con corosync-qnetd que da el voto extra (dispositivo de quórum). */
      qdevice: z.string().optional(),
      /** Recursos de alta disponibilidad (vm:ID o ct:ID). */
      ha: z
        .array(z.strictObject({ id: z.string(), estado: z.enum(['started', 'stopped', 'disabled', 'ignored']).default('started'), max_reinicios: z.number().int().default(1), max_reubicaciones: z.number().int().default(1) }))
        .default([]),
      /** Reglas de HA: afinidad a nodos ("pve01:2") o entre recursos. */
      reglas_ha: z
        .array(
          z.strictObject({
            id: z.string(),
            tipo: z.enum(['node-affinity', 'resource-affinity']).default('node-affinity'),
            recursos: z.array(z.string()),
            nodos: z.array(z.string()).default([]),
            estricta: z.boolean().default(false),
            afinidad: z.enum(['positive', 'negative']).optional(),
          }),
        )
        .default([]),
      /** Nodos en modo mantenimiento. */
      mantenimiento: z.array(z.string()).default([]),
    })
    .optional(),
  /** Pools de ZFS ya creados sobre los discos del ejercicio (sdb, sdc...). */
  zfs: z
    .strictObject({
      pools: z
        .array(
          z.strictObject({
            nombre: z.string(),
            tipo: z.enum(['mirror', 'raidz1', 'raidz2', 'raidz3', 'stripe']).default('mirror'),
            discos: z.array(z.string()).default([]),
            /** Varios grupos (por ejemplo, dos espejos): si se define, reemplaza a tipo y discos. */
            vdevs: z.array(z.strictObject({ tipo: z.enum(['mirror', 'raidz1', 'raidz2', 'raidz3', 'stripe']), discos: z.array(z.string()) })).optional(),
            ashift: z.number().int().default(12),
            propiedades: z.record(z.string(), z.string()).default({}),
            datasets: z
              .array(
                z.strictObject({
                  nombre: z.string(),
                  usado_gb: z.number().default(0),
                  volumen_gb: z.number().optional(),
                  propiedades: z.record(z.string(), z.string()).default({}),
                  instantaneas: z.array(z.string()).default([]),
                }),
              )
              .default([]),
            /** Discos con errores (FAULTED): el disco está fallando de verdad. */
            fallados: z.array(z.string()).default([]),
            /** Discos que no aparecen (UNAVAIL). */
            sin_conectar: z.array(z.string()).default([]),
            ultimo_scrub_dias: z.number().optional(),
            /** Archivos con errores permanentes (se perdieron datos). */
            errores_datos: z.array(z.string()).default([]),
          }),
        )
        .default([]),
    })
    .optional(),
  /** Imágenes de disco de máquinas virtuales (qcow2, raw, vmdk, vhdx) que ya están en el equipo. */
  imagenes_disco: z
    .array(
      z.strictObject({
        ruta: z.string(),
        formato: z.enum(['qcow2', 'raw', 'vmdk', 'vhdx', 'vdi']).default('qcow2'),
        virtual_gb: z.number(),
        /** Lo que ocupa en el disco (si no se dice: casi nada en las dinámicas, todo en raw). */
        disco_gb: z.number().optional(),
        respaldo: z.string().optional(),
        dueno: z.string().optional(),
        /** El sistema instalado adentro (una VM exportada de otro hipervisor). */
        sistema: z.strictObject({ so: z.enum(['windows', 'linux']), uefi: z.boolean().default(false), drivers_virtio: z.boolean().optional() }).optional(),
      }),
    )
    .default([]),
  /** Una UPS conectada por USB (la lee el driver usbhid-ups de NUT). */
  ups: z
    .strictObject({
      marca: z.string().default('APC'),
      modelo: z.string().default('Smart-UPS 1500'),
      potencia_w: z.number().default(1000),
      carga: z.number().default(34),
      bateria: z.number().default(100),
      autonomia_min: z.number().default(25),
      estado: z.string().default('OL'),
    })
    .optional(),
  /** Arreglos RAID por software que ya existen (mdadm), con discos fallados o de repuesto. */
  raid: z
    .array(
      z.strictObject({
        nombre: z.string(),
        nivel: z.union([z.literal(0), z.literal(1), z.literal(5), z.literal(6), z.literal(10)]),
        discos: z.array(z.string()),
        repuestos: z.array(z.string()).default([]),
        fallados: z.array(z.string()).default([]),
        fs: z.enum(['xfs', 'ext4']).optional(),
        montaje: z.string().optional(),
        /** Fracción ocupada (0 a 1). */
        usado: z.number().optional(),
      }),
    )
    .default([]),
  /** Correo: los servidores del proveedor que sirven de relay, la cola y los mapas ya compilados. */
  correo: z
    .strictObject({
      relays: z
        .array(
          z.strictObject({
            servidor: z.string(),
            ip: z.string(),
            puerto: z.number().int().default(587),
            usuario: z.string().optional(),
            clave: z.string().optional(),
            /** Exige STARTTLS antes de autenticar. */
            tls: z.boolean().default(true),
            /** Remitentes que el proveedor acepta para esa cuenta (vacío: cualquiera). */
            remitentes: z.array(z.string()).default([]),
          }),
        )
        .default([]),
      /** El proveedor de internet o de la nube bloquea la salida por el puerto 25. */
      puerto25_bloqueado: z.boolean().default(true),
      /** Mapas que ya se compilaron con postmap (ej.: lmdb:/etc/postfix/sasl_passwd). */
      mapas_compilados: z.array(z.string()).default([]),
      /** Mensajes que ya esperan en la cola. */
      cola: z.array(z.strictObject({ de: z.string(), para: z.string(), asunto: z.string().default(''), motivo: z.string(), hace_minutos: z.number().default(60) })).default([]),
    })
    .optional(),
  /** Cuentas de Samba ya creadas con smbpasswd (el usuario de Linux tiene que existir). */
  samba: z.strictObject({ usuarios: z.array(z.strictObject({ nombre: z.string(), clave: z.string() })).default([]) }).optional(),
  /** Bases de datos del servidor (MariaDB y PostgreSQL). */
  bases_datos: z
    .strictObject({
      mariadb: z
        .strictObject({
          /** nombre de la base → SQL que crea sus tablas y datos. */
          bases: z.record(z.string(), z.string()).default({}),
          usuarios: z
            .array(
              z.strictObject({
                usuario: z.string(),
                host: z.string().default('localhost'),
                clave: z.string().optional(),
                /** Como en GRANT: "SELECT, INSERT ON tienda.*" */
                permisos: z.array(z.string()).default([]),
              }),
            )
            .default([]),
          /** log_bin activado (con su configuración en el archivo del servidor). */
          binlog: z.boolean().default(false),
          /** Lo que pasó después del estado inicial, con la hora: queda en el binlog. */
          historia: z.array(z.strictObject({ hora: z.string(), base: z.string(), sql: z.string() })).default([]),
          /** Respaldos ya hechos con mysqldump en una hora de la historia. */
          respaldos: z.array(z.strictObject({ archivo: z.string(), hora: z.string(), bases: z.array(z.string()), comprimido: z.boolean().default(false) })).default([]),
        })
        .optional(),
      postgresql: z
        .strictObject({
          bases: z.record(z.string(), z.strictObject({ sql: z.string().default(''), dueno: z.string().default('postgres') })).default({}),
          roles: z
            .array(z.strictObject({ nombre: z.string(), clave: z.string().optional(), login: z.boolean().default(true), superusuario: z.boolean().default(false), crear_bases: z.boolean().default(false) }))
            .default([]),
          /** En Rocky: el cluster ya se creó con postgresql-setup --initdb. */
          inicializado: z.boolean().default(true),
        })
        .optional(),
    })
    .optional(),
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
  z.strictObject({ salida_no_contiene: z.string() }),
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
  /**
   * Resolución DNS desde este servidor: el nombre responde (con esa IP, si se indica) usando el
   * servidor dado o los de /etc/resolv.conf. Con estado: NXDOMAIN, REFUSED o sin_respuesta.
   */
  z.strictObject({
    resuelve: z.string(),
    tipo: z.string().default('A'),
    servidor: z.string().optional(),
    responde: z.string().optional(),
    estado: z.enum(['NOERROR', 'NXDOMAIN', 'REFUSED', 'SERVFAIL', 'sin_respuesta']).default('NOERROR'),
  }),
  /** Desde este servidor se llega (o no) a esa IP, siguiendo su tabla de rutas. */
  z.strictObject({ alcanza: z.string(), resultado: z.enum(['ok', 'falla']).default('ok') }),
  /** La tabla de rutas tiene esa red (por ese siguiente salto, y guardada en NetworkManager si persistente). */
  z.strictObject({ ruta: z.string(), via: z.string().optional(), persistente: z.boolean().optional() }),
  /** La interfaz tiene una IPv4 dentro de esa red (por ejemplo, recibida por DHCP). */
  z.strictObject({ interfaz: z.string(), ip_en: z.string().optional(), ipv6: z.string().optional(), activa: z.boolean().optional() }),
  /**
   * Una solicitud HTTP desde este servidor (como curl): el código, un texto del cuerpo, un
   * encabezado, si el certificado es válido. Con desde_internet, como la haría alguien de afuera.
   */
  z.strictObject({
    http: z.string(),
    metodo: z.string().optional(),
    estado: z.number().int().optional(),
    contiene: z.string().optional(),
    no_contiene: z.string().optional(),
    encabezado: z.strictObject({ nombre: z.string(), contiene: z.string().optional(), existe: z.boolean().default(true) }).optional(),
    /** Certificado válido para el nombre (true), o que la conexión falle por el certificado (false). */
    tls_valido: z.boolean().optional(),
    http2: z.boolean().optional(),
    /** Como curl -k: no verificar el certificado. */
    inseguro: z.boolean().default(false),
    encabezados: z.record(z.string(), z.string()).optional(),
    desde_internet: z.boolean().default(false),
    /** La conexión tiene que fallar (rechazada, tiempo agotado). */
    falla: z.boolean().optional(),
  }),
  /** Un archivo de certificado: nombre, SAN, emisor, vigencia, si es de una CA, si coincide con una clave. */
  z.strictObject({
    certificado: z.string(),
    cn: z.string().optional(),
    san_incluye: z.string().optional(),
    emisor_contiene: z.string().optional(),
    autofirmado: z.boolean().optional(),
    es_ca: z.boolean().optional(),
    vigente: z.boolean().optional(),
    dias_min: z.number().optional(),
    /** Ruta de la clave privada que tiene que corresponder al certificado. */
    clave: z.string().optional(),
    /** El archivo trae también el intermedio. */
    con_cadena: z.boolean().optional(),
  }),
  /** El almacén de confianza del sistema tiene una CA con ese nombre (CN). */
  z.strictObject({ confia_en: z.string(), confia: z.boolean().default(true) }),
  /** Un módulo de Apache cargado (o no), por ejemplo rewrite o proxy_http. */
  z.strictObject({ modulo_apache: z.string(), cargado: z.boolean().default(true) }),
  /** Un booleano de SELinux encendido (o apagado), en la sesión y persistente. */
  z.strictObject({ booleano_selinux: z.string(), valor: z.boolean().default(true) }),
  /** Una base de datos existe (o no). */
  z.strictObject({ base_datos: z.string(), motor: z.enum(['mariadb', 'postgresql']), existe: z.boolean().default(true) }),
  /** El resultado (primera celda) de una consulta hecha como administrador. */
  z.strictObject({ consulta_bd: z.string(), motor: z.enum(['mariadb', 'postgresql']), base: z.string(), resultado: z.string() }),
  /** La UPS que publica upsd tiene ese estado (OL, OB, LB). */
  z.strictObject({ ups_estado: z.string(), ups: z.string() }),
  /** Una máquina virtual de libvirt: si existe, su estado, vCPU, memoria (MiB), arranque automático, una instantánea o su red. */
  z.strictObject({ dominio: z.string(), existe: z.boolean().optional(), estado: z.enum(['running', 'shut off', 'paused']).optional(), vcpus: z.number().int().optional(), memoria_mb: z.number().int().optional(), autostart: z.boolean().optional(), instantanea: z.string().optional(), red: z.string().optional() }),
  /** Una imagen de disco: formato, archivo base y tamaño virtual. */
  z.strictObject({ imagen_disco: z.string(), formato: z.string().optional(), respaldo: z.string().optional(), tamano_virtual_gb: z.number().optional() }),
  z.strictObject({ red_libvirt: z.string(), activa: z.boolean().optional(), autostart: z.boolean().optional() }),
  /** Una VM (pve_vm) o un contenedor (pve_ct) de Proxmox: estado, nombre, plantilla, instantánea y valores de su configuración. */
  z.strictObject({ pve_vm: z.number().int(), existe: z.boolean().optional(), estado: z.enum(['running', 'stopped']).optional(), nombre: z.string().optional(), plantilla: z.boolean().optional(), instantanea: z.string().optional(), config: z.record(z.string(), z.string()).optional(), arranca: z.boolean().optional(), con_red: z.boolean().optional(), nodo: z.string().optional() }),
  /** Un pool de ZFS: salud, tipo, discos, y si terminó un scrub o un resilver. */
  z.strictObject({ zpool: z.string(), existe: z.boolean().optional(), estado: z.enum(['ONLINE', 'DEGRADED', 'UNAVAIL', 'FAULTED']).optional(), tipo: z.enum(['mirror', 'raidz1', 'raidz2', 'raidz3', 'stripe']).optional(), discos: z.array(z.string()).optional(), scrub_hecho: z.boolean().optional(), resilver_hecho: z.boolean().optional() }),
  /** Un dataset o volumen de ZFS: propiedades e instantáneas. */
  z.strictObject({ dataset: z.string(), existe: z.boolean().optional(), propiedad: z.record(z.string(), z.string()).optional(), instantanea: z.string().optional() }),
  /** Una tarea de réplica de Proxmox (pvesr). */
  z.strictObject({ replica_pve: z.string(), destino: z.string().optional(), ok: z.boolean().optional() }),
  /** Clúster de Proxmox: nombre, nodos, cuántos en línea, quórum, dispositivo de quórum y votos esperados. */
  z.strictObject({ pve_cluster: z.string(), nodos: z.number().int().optional(), en_linea: z.number().int().optional(), quorum: z.boolean().optional(), qdevice: z.boolean().optional(), votos_esperados: z.number().int().optional() }),
  /** Un recurso de alta disponibilidad (vm:ID): estado que muestra ha-manager, nodo y regla. */
  z.strictObject({ pve_ha: z.string(), existe: z.boolean().optional(), estado: z.string().optional(), nodo: z.string().optional(), regla: z.string().optional() }),
  z.strictObject({ pve_mantenimiento: z.string(), activo: z.boolean().optional() }),
  /** Un servidor del ejercicio prendido o apagado. */
  z.strictObject({ pve_encendido: z.string(), encendido: z.boolean().optional() }),
  z.strictObject({ pve_ct: z.number().int(), existe: z.boolean().optional(), estado: z.enum(['running', 'stopped']).optional(), nombre: z.string().optional(), instantanea: z.string().optional(), config: z.record(z.string(), z.string()).optional(), nodo: z.string().optional() }),
  /** Respaldos de un invitado (en un almacenamiento): al menos uno, o exactamente cantidad. */
  z.strictObject({ pve_respaldo: z.number().int(), almacenamiento: z.string().optional(), cantidad: z.number().int().optional() }),
  z.strictObject({ pve_almacenamiento: z.string(), tipo: z.string().optional(), contenido_incluye: z.string().optional(), activo: z.boolean().optional(), existe: z.boolean().optional() }),
  z.strictObject({ pve_puente: z.string(), vlan_aware: z.boolean().optional(), puerto: z.string().optional(), direccion: z.string().optional() }),
  z.strictObject({ pve_usuario: z.string(), rol: z.string().optional(), ruta_acl: z.string().optional() }),
  /** upsmon ordenó (o no) el apagado del servidor. */
  z.strictObject({ apagado_ups: z.boolean() }),
  /** Estado de un arreglo RAID: sano, degradado, reconstruyendo, sincronizando o fallado. */
  z.strictObject({ raid: z.string(), nivel: z.number().int().optional(), estado: z.enum(['sano', 'degradado', 'reconstruyendo', 'sincronizando', 'fallado']).optional(), activos: z.number().int().optional(), repuestos: z.number().int().optional() }),
  /** Un correo que Postfix entregó (o dejó diferido, o rebotó) para ese destinatario. */
  z.strictObject({ correo_enviado: z.string(), estado: z.enum(['sent', 'deferred', 'bounced']).default('sent'), via: z.string().optional() }),
  z.strictObject({ cola_vacia: z.boolean() }),
  /** Una carpeta exportada por NFS (lo aplicado con exportfs, no solo el archivo). */
  z.strictObject({ exportado: z.string(), cliente: z.string().optional(), opciones_incluye: z.string().optional(), existe: z.boolean().default(true) }),
  /** Un usuario de la base: si existe y si tiene (o no) un permiso. */
  z.strictObject({
    usuario_bd: z.string(),
    motor: z.enum(['mariadb', 'postgresql']),
    host: z.string().optional(),
    existe: z.boolean().default(true),
    permiso: z.string().optional(),
    base: z.string().optional(),
    tabla: z.string().optional(),
    tiene: z.boolean().default(true),
    clave: z.string().optional(),
  }),
])

/** Una verificación, o la misma en otro servidor de la red: { en: web01, verificar: {...} }. */
export const bashCheckSchema = z.union([singleCheckSchema, z.strictObject({ en: z.string(), verificar: singleCheckSchema })])

export type BashState = z.infer<typeof bashStateSchema>
export type BashStateInput = z.input<typeof bashStateSchema>
export type BashCheck = z.infer<typeof bashCheckSchema>
