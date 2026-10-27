/** Validación de docker-compose.yml (Compose Specification, docker compose v2). */
import type { Diagnostic } from './types'
import { isRecord, parseYaml } from './yaml-tools'

const TOP = new Set(['version', 'name', 'services', 'volumes', 'networks', 'configs', 'secrets', 'include', 'models'])
const SERVICE_KEYS = new Set(
  'annotations attach build blkio_config cap_add cap_drop cgroup cgroup_parent command configs container_name cpu_count cpu_percent cpu_shares cpu_period cpu_quota cpu_rt_runtime cpu_rt_period cpus cpuset credential_spec depends_on deploy develop device_cgroup_rules devices dns dns_opt dns_search domainname driver_opts entrypoint env_file environment expose extends external_links extra_hosts gpus group_add healthcheck hostname image init ipc isolation labels label_file links logging mac_address mem_limit mem_reservation mem_swappiness memswap_limit models network_mode networks oom_kill_disable oom_score_adj pid pids_limit platform ports post_start pre_stop privileged profiles provider pull_policy read_only restart runtime scale secrets security_opt shm_size stdin_open stop_grace_period stop_signal storage_opt sysctls tmpfs tty ulimits use_api_socket user userns_mode uts volumes volumes_from working_dir'.split(
    ' ',
  ),
)
const PORT = /^(?:(?:\[[0-9a-fA-F:]+\]|\d{1,3}(?:\.\d{1,3}){3}):)?(?:\d+(?:-\d+)?:)?\d+(?:-\d+)?(?:\/(?:tcp|udp|sctp))?$/
const RESTART = /^(no|always|unless-stopped|on-failure(:\d+)?)$/

export function validateCompose(text: string): { data: unknown; diagnostics: Diagnostic[] } {
  const { data, diagnostics, lineOf } = parseYaml(text)
  if (diagnostics.some((d) => d.severity === 'error')) return { data, diagnostics }
  const err = (path: (string | number)[], message: string, severity: Diagnostic['severity'] = 'error') => diagnostics.push({ line: lineOf(path), severity, message })
  if (!isRecord(data)) {
    diagnostics.push({ line: 1, severity: 'error', message: 'El archivo tiene que ser un mapa con la clave "services" en el primer nivel.' })
    return { data, diagnostics }
  }
  for (const k of Object.keys(data)) {
    if (!TOP.has(k) && !k.startsWith('x-')) err([k], `Clave desconocida en el primer nivel: "${k}" (compose: additional property ${k} is not allowed). ¿Quedó mal sangrada?`)
  }
  if ('version' in data) err(['version'], 'El atributo "version" está obsoleto y Docker Compose v2 lo ignora: conviene quitarlo.', 'warning')
  const services = data.services
  if (!isRecord(services) || !Object.keys(services).length) {
    err(['services'], 'Falta la sección "services" con al menos un servicio.')
    return { data, diagnostics }
  }
  const declaredVolumes = isRecord(data.volumes) ? Object.keys(data.volumes) : []
  const declaredNetworks = isRecord(data.networks) ? Object.keys(data.networks) : []
  for (const [name, svc] of Object.entries(services)) {
    const base = ['services', name]
    if (!isRecord(svc)) {
      err(base, `El servicio "${name}" tiene que ser un mapa de opciones (image, ports...).`)
      continue
    }
    for (const k of Object.keys(svc)) if (!SERVICE_KEYS.has(k) && !k.startsWith('x-')) err([...base, k], `"${k}" no es una opción válida de un servicio (compose: services.${name} additional property ${k} is not allowed).`)
    if (!('image' in svc) && !('build' in svc)) err(base, `El servicio "${name}" no tiene "image" ni "build": Compose no sabe qué contenedor crear.`)
    if (Array.isArray(svc.ports)) {
      svc.ports.forEach((p, i) => {
        if (isRecord(p)) {
          if (!('target' in p)) err([...base, 'ports', i], 'En la sintaxis larga de ports falta "target" (puerto del contenedor).')
        } else if (!PORT.test(String(p))) err([...base, 'ports', i], `Puerto "${String(p)}" con formato inválido. Ejemplos válidos: "8080:80", "127.0.0.1:8080:80", "53:53/udp".`)
        else if ((String(p).replace(/^\[[^\]]+\]:|^\d{1,3}(\.\d{1,3}){3}:/, '').match(/\d+/g) ?? []).some((n) => Number(n) < 1 || Number(n) > 65535)) err([...base, 'ports', i], `Puerto fuera de rango en "${String(p)}": los puertos van de 1 a 65535.`)
      })
    } else if (svc.ports !== undefined) err([...base, 'ports'], '"ports" tiene que ser una lista.')
    if (svc.restart !== undefined && !RESTART.test(String(svc.restart === false ? 'no' : svc.restart))) err([...base, 'restart'], `restart "${String(svc.restart)}" no es válido. Opciones: no, always, on-failure, unless-stopped.`)
    if (svc.depends_on !== undefined) {
      const deps = Array.isArray(svc.depends_on) ? svc.depends_on.map(String) : isRecord(svc.depends_on) ? Object.keys(svc.depends_on) : []
      for (const dep of deps) if (!(dep in services)) err([...base, 'depends_on'], `depends_on menciona "${dep}", que no es un servicio de este archivo (compose: service "${name}" depends on undefined service "${dep}").`)
      if (isRecord(svc.depends_on)) {
        for (const [dep, cfg] of Object.entries(svc.depends_on)) {
          const cond = isRecord(cfg) ? cfg.condition : undefined
          if (cond !== undefined && !['service_started', 'service_healthy', 'service_completed_successfully'].includes(String(cond))) err([...base, 'depends_on', dep], `condition "${String(cond)}" no es válida: usa service_started, service_healthy o service_completed_successfully.`)
          if (cond === 'service_healthy' && isRecord(services[dep]) && !('healthcheck' in (services[dep] as object))) err([...base, 'depends_on', dep], `Se espera a que "${dep}" esté healthy, pero "${dep}" no define healthcheck (y su imagen podría no tenerlo).`, 'warning')
        }
      }
    }
    if (Array.isArray(svc.volumes)) {
      svc.volumes.forEach((v, i) => {
        if (typeof v !== 'string') return
        const src = v.split(':')[0]
        if (v.split(':').length >= 2 && !/^[./~$]/.test(src) && !/^[A-Za-z]:\\/.test(src) && !declaredVolumes.includes(src)) {
          err([...base, 'volumes', i], `El volumen "${src}" no está declarado en la sección "volumes" del primer nivel (compose: service "${name}" refers to undefined volume ${src}). Si querías una carpeta, empieza la ruta con ./ o /.`)
        }
      })
    }
    if (svc.networks !== undefined) {
      const nets = Array.isArray(svc.networks) ? svc.networks.map(String) : isRecord(svc.networks) ? Object.keys(svc.networks) : []
      for (const n of nets) if (n !== 'default' && !declaredNetworks.includes(n)) err([...base, 'networks'], `La red "${n}" no está declarada en la sección "networks" del primer nivel (compose: service "${name}" refers to undefined network ${n}).`)
    }
    if (svc.environment !== undefined && !Array.isArray(svc.environment) && !isRecord(svc.environment)) err([...base, 'environment'], 'environment tiene que ser una lista (- CLAVE=valor) o un mapa (CLAVE: valor).')
    if (Array.isArray(svc.environment)) {
      svc.environment.forEach((e, i) => {
        if (typeof e !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]*(=.*)?$/.test(e)) err([...base, 'environment', i], `"${String(e)}" no tiene el formato CLAVE=valor.`)
      })
    }
    if (isRecord(svc.environment)) {
      for (const [k, v] of Object.entries(svc.environment)) if (v !== null && typeof v === 'object') err([...base, 'environment', k], `El valor de ${k} tiene que ser texto o número, no una lista ni un mapa.`)
    }
    if (typeof svc.image === 'string' && /\s/.test(svc.image)) err([...base, 'image'], 'El nombre de la imagen no puede tener espacios.')
    if (typeof svc.image === 'string' && !svc.image.includes(':') && !svc.image.includes('@')) err([...base, 'image'], `La imagen "${svc.image}" no tiene etiqueta: se usará "latest", que puede cambiar sin aviso. Conviene fijar una versión.`, 'warning')
  }
  return { data, diagnostics }
}
