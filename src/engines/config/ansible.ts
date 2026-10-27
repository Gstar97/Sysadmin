/** Validación de playbooks de Ansible: estructura, módulos más usados y sus argumentos. */
import type { Diagnostic } from './types'
import { isRecord, parseYaml } from './yaml-tools'

const PLAY_KEYS = new Set(
  'name hosts become become_user become_method become_flags gather_facts gather_subset vars vars_files vars_prompt tasks handlers roles pre_tasks post_tasks remote_user serial strategy tags environment any_errors_fatal max_fail_percentage connection collections module_defaults ignore_errors ignore_unreachable check_mode diff order force_handlers port run_once throttle timeout no_log debugger'.split(' '),
)
const TASK_KEYS = new Set(
  'name become become_user become_method when loop loop_control with_items with_dict with_fileglob with_together with_sequence notify register tags vars ignore_errors ignore_unreachable changed_when failed_when delegate_to delegate_facts run_once until retries delay no_log environment args async poll check_mode diff listen block rescue always any_errors_fatal throttle timeout module_defaults collections action local_action debugger connection'.split(' '),
)

interface ModuleSpec {
  required?: string[][]
  states?: string[]
  bools?: string[]
  freeForm?: boolean
}

const MODULES: Record<string, ModuleSpec> = {
  apt: { required: [['name', 'pkg', 'upgrade', 'update_cache', 'deb', 'autoremove']], states: ['present', 'absent', 'latest', 'build-dep', 'fixed'], bools: ['update_cache', 'autoremove'] },
  dnf: { required: [['name', 'list']], states: ['present', 'absent', 'latest', 'installed', 'removed'], bools: ['update_cache'] },
  yum: { required: [['name', 'list']], states: ['present', 'absent', 'latest', 'installed', 'removed'] },
  package: { required: [['name']], states: ['present', 'absent', 'latest'] },
  service: { required: [['name']], states: ['started', 'stopped', 'restarted', 'reloaded'], bools: ['enabled'] },
  systemd: { states: ['started', 'stopped', 'restarted', 'reloaded'], bools: ['enabled', 'daemon_reload', 'masked'] },
  systemd_service: { states: ['started', 'stopped', 'restarted', 'reloaded'], bools: ['enabled', 'daemon_reload', 'masked'] },
  copy: { required: [['dest']], bools: ['backup', 'force', 'remote_src'] },
  template: { required: [['src'], ['dest']], bools: ['backup', 'force'] },
  file: { required: [['path', 'dest', 'name']], states: ['absent', 'directory', 'file', 'hard', 'link', 'touch'], bools: ['recurse', 'force'] },
  user: { required: [['name']], states: ['present', 'absent'], bools: ['create_home', 'system', 'append', 'remove'] },
  group: { required: [['name']], states: ['present', 'absent'], bools: ['system'] },
  lineinfile: { required: [['path', 'dest']], states: ['present', 'absent'], bools: ['backup', 'create'] },
  blockinfile: { required: [['path', 'dest']], states: ['present', 'absent'], bools: ['backup', 'create'] },
  replace: { required: [['path'], ['regexp']] },
  command: { freeForm: true },
  shell: { freeForm: true },
  raw: { freeForm: true },
  script: { freeForm: true },
  debug: {},
  git: { required: [['repo'], ['dest']] },
  get_url: { required: [['url'], ['dest']] },
  unarchive: { required: [['src'], ['dest']], bools: ['remote_src'] },
  firewalld: { states: ['enabled', 'disabled', 'present', 'absent'], bools: ['permanent', 'immediate'] },
  ufw: { bools: ['logging'] },
  cron: { required: [['name']], states: ['present', 'absent'] },
  mount: { required: [['path']], states: ['mounted', 'unmounted', 'present', 'absent', 'remounted', 'ephemeral'] },
  reboot: {},
  set_fact: {},
  include_tasks: { freeForm: true },
  import_tasks: { freeForm: true },
  include_role: {},
  import_role: {},
  include_vars: { freeForm: true },
  stat: { required: [['path']] },
  wait_for: {},
  uri: { required: [['url']] },
  fail: {},
  assert: { required: [['that']] },
  ping: {},
  setup: {},
  authorized_key: { required: [['user'], ['key']], states: ['present', 'absent'] },
  sysctl: { required: [['name']], states: ['present', 'absent'] },
  hostname: { required: [['name']] },
  timezone: {},
  selinux: { required: [['state']] },
  seboolean: { required: [['name'], ['state']] },
  community_mysql_db: {},
  docker_container: { required: [['name']] },
  meta: { freeForm: true },
  pause: {},
  apt_repository: { required: [['repo']] },
  yum_repository: { required: [['name']] },
  dnf5: { required: [['name']], states: ['present', 'absent', 'latest', 'installed', 'removed'] },
}

function moduleName(key: string): string | undefined {
  const short = key.replace(/^(ansible\.builtin|ansible\.posix|community\.general|community\.docker|community\.mysql)\./, '')
  if (MODULES[short]) return short
  if (key === 'docker_container' || key === 'community.docker.docker_container') return 'docker_container'
  return undefined
}

const BOOL = new Set([true, false, 'yes', 'no', 'true', 'false', 'True', 'False'])

export function validateAnsible(text: string): { data: unknown; diagnostics: Diagnostic[] } {
  const { data, diagnostics, lineOf } = parseYaml(text)
  if (diagnostics.some((d) => d.severity === 'error')) return { data, diagnostics }
  const err = (path: (string | number)[], message: string, severity: Diagnostic['severity'] = 'error') => diagnostics.push({ line: lineOf(path), severity, message })
  if (!Array.isArray(data)) {
    diagnostics.push({ line: 1, severity: 'error', message: 'Un playbook es una lista de plays: cada play empieza con "- name:" o "- hosts:" en la primera columna.' })
    return { data, diagnostics }
  }
  data.forEach((play, pi) => {
    if (!isRecord(play)) {
      err([pi], 'Cada play tiene que ser un mapa (hosts, tasks...).')
      return
    }
    if ('import_playbook' in play || 'ansible.builtin.import_playbook' in play) return
    for (const k of Object.keys(play)) if (!PLAY_KEYS.has(k)) err([pi, k], `"${k}" no es un atributo válido de un play (ansible: '${k}' is not a valid attribute for a Play).${moduleName(k) ? ' Si es un módulo, va dentro de "tasks".' : ''}`)
    if (!('hosts' in play)) err([pi], 'El play no tiene "hosts": Ansible no sabe en qué equipos ejecutarlo (ansible: the field \'hosts\' is required but was not set).')
    const handlerNames = new Set<string>()
    if (Array.isArray(play.handlers)) {
      for (const h of play.handlers) {
        if (isRecord(h)) {
          if (typeof h.name === 'string') handlerNames.add(h.name)
          if (typeof h.listen === 'string') handlerNames.add(h.listen)
        }
      }
    }
    for (const section of ['pre_tasks', 'tasks', 'post_tasks', 'handlers']) {
      const list = play[section]
      if (list === undefined || list === null) continue
      if (!Array.isArray(list)) {
        err([pi, section], `"${section}" tiene que ser una lista de tareas (cada una empieza con "- name:").`)
        continue
      }
      list.forEach((task, ti) => checkTask(task, [pi, section, ti], err, handlerNames, section === 'handlers'))
    }
  })
  return { data, diagnostics }
}

function checkTask(task: unknown, path: (string | number)[], err: (p: (string | number)[], m: string, s?: Diagnostic['severity']) => void, handlers: Set<string>, isHandler: boolean) {
  if (!isRecord(task)) {
    err(path, 'Cada tarea tiene que ser un mapa: "- name: ..." seguido del módulo.')
    return
  }
  if ('block' in task) {
    for (const part of ['block', 'rescue', 'always']) {
      const list = task[part]
      if (Array.isArray(list)) list.forEach((t, i) => checkTask(t, [...path, part, i], err, handlers, isHandler))
    }
    return
  }
  const actions = Object.keys(task).filter((k) => !TASK_KEYS.has(k))
  if (!task.name) err(path, 'La tarea no tiene "name": funciona, pero la salida de Ansible queda difícil de leer.', 'warning')
  if (actions.length === 0) {
    err(path, 'La tarea no tiene ningún módulo (ansible: no module/action detected in task).')
    return
  }
  if (actions.length > 1) {
    const known = actions.filter((a) => moduleName(a))
    err(path, known.length > 1 ? `Hay dos módulos en la misma tarea: ${known.join(' y ')} (ansible: conflicting action statements). Sepáralos en dos tareas.` : `Atributos desconocidos en la tarea: ${actions.join(', ')}. ¿Quedó mal sangrado el argumento de un módulo?`)
    return
  }
  const key = actions[0]
  const mod = moduleName(key)
  if (!mod) {
    err([...path, key], `Ansible no conoce el módulo "${key}" (couldn't resolve module/action '${key}'). Revisa cómo está escrito o usa su nombre completo (ansible.builtin.${key}).`)
    return
  }
  const spec = MODULES[mod]
  let args = task[key]
  // Sintaxis antigua en una línea: "service: name=nginx state=started".
  if (typeof args === 'string' && !spec.freeForm && /^\w+=/.test(args)) {
    args = Object.fromEntries(args.split(/\s+/).map((kv) => kv.split('=') as [string, string]))
  }
  if (spec.freeForm && (typeof args === 'string' || args === null)) {
    if (!args && !(isRecord(task.args) && task.args.cmd)) err([...path, key], `El módulo ${mod} necesita un comando.`)
  } else if (args !== null && args !== undefined && !isRecord(args)) {
    if (!spec.freeForm) err([...path, key], `Los argumentos de ${mod} van como mapa (clave: valor) en las líneas siguientes, con más sangría.`)
  } else if (isRecord(args)) {
    for (const group of spec.required ?? []) {
      if (!group.some((g) => g in args)) err([...path, key], `Al módulo ${mod} le falta "${group[0]}" (ansible: missing required arguments: ${group[0]}).`)
    }
    if (spec.states && 'state' in args && !spec.states.includes(String(args.state))) err([...path, key, 'state'], `state "${String(args.state)}" no es válido para ${mod}. Opciones: ${spec.states.join(', ')}.`)
    for (const b of spec.bools ?? []) if (b in args && !BOOL.has(args[b] as string | boolean)) err([...path, key, b], `"${b}" espera true o false.`)
    if (mod === 'service' && !('state' in args) && !('enabled' in args)) err([...path, key], 'service necesita al menos "state" o "enabled" para hacer algo.')
  } else if (spec.required?.length) {
    err([...path, key], `El módulo ${mod} necesita argumentos.`)
  }
  if ('loop' in task && Object.keys(task).some((k) => k.startsWith('with_'))) err(path, 'No se pueden usar "loop" y "with_..." en la misma tarea.')
  if (!isHandler && task.notify !== undefined) {
    const list = Array.isArray(task.notify) ? task.notify.map(String) : [String(task.notify)]
    for (const n of list) if (!handlers.has(n)) err([...path, 'notify'], `notify llama a "${n}", pero no hay un handler con ese nombre (ansible: The requested handler '${n}' was not found).`)
  }
}
