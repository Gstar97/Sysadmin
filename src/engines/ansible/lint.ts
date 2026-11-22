/**
 * ansible-lint simulado: las reglas que más aparecen en la práctica, con los mismos nombres,
 * mensajes, perfiles y formato de salida que ansible-lint (6.x).
 */
import { loadYaml, YamlLoadError } from './yamlload'

interface Violation {
  rule: string
  message: string
  file: string
  line: number
  detail: string
}

const PROFILE: Record<string, string> = {
  'load-failure': 'min',
  'syntax-check': 'min',
  'yaml[truthy]': 'basic',
  'yaml[trailing-spaces]': 'basic',
  'yaml[line-length]': 'basic',
  'name[missing]': 'basic',
  'name[play]': 'basic',
  'name[casing]': 'moderate',
  'command-instead-of-module': 'basic',
  'command-instead-of-shell': 'basic',
  'no-free-form': 'basic',
  'risky-octal': 'safety',
  'literal-compare': 'basic',
  'no-jinja-when': 'basic',
  'jinja[spacing]': 'basic',
  'partial-become': 'basic',
  'key-order[task]': 'basic',
  'risky-file-permissions': 'safety',
  'package-latest': 'safety',
  'no-changed-when': 'shared',
  'ignore-errors': 'shared',
  'no-handler': 'shared',
  'fqcn[action-core]': 'production',
  'fqcn[action]': 'production',
}
const TAGS: Record<string, string> = {
  'yaml[truthy]': 'formatting yaml',
  'yaml[trailing-spaces]': 'formatting yaml',
  'yaml[line-length]': 'formatting yaml',
  'name[missing]': 'idiom',
  'name[play]': 'idiom',
  'name[casing]': 'idiom',
  'command-instead-of-module': 'command-shell idiom',
  'command-instead-of-shell': 'command-shell idiom',
  'no-free-form': 'syntax risk',
  'risky-octal': 'formatting',
  'literal-compare': 'idiom',
  'no-jinja-when': 'deprecations',
  'jinja[spacing]': 'formatting',
  'partial-become': 'unpredictability',
  'key-order[task]': 'formatting',
  'risky-file-permissions': 'unpredictability',
  'package-latest': 'idempotency',
  'no-changed-when': 'command-shell idempotency',
  'ignore-errors': 'unpredictability',
  'no-handler': 'idiom',
  'fqcn[action-core]': 'formatting',
  'fqcn[action]': 'formatting',
  'load-failure': 'core unskippable',
}
const ORDER = ['min', 'basic', 'moderate', 'safety', 'shared', 'production']

const BUILTIN = new Set('ping command shell raw script package dnf yum apt service systemd systemd_service copy template file lineinfile blockinfile replace stat user group debug set_fact assert fail meta pause include_vars include_tasks import_tasks include_role import_role setup git get_url uri wait_for reboot hostname cron unarchive package_facts service_facts gather_facts dnf5 known_hosts getent'.split(' '))
const OTHER: Record<string, string> = {
  firewalld: 'ansible.posix.firewalld',
  authorized_key: 'ansible.posix.authorized_key',
  sysctl: 'ansible.posix.sysctl',
  seboolean: 'ansible.posix.seboolean',
  selinux: 'ansible.posix.selinux',
  mount: 'ansible.posix.mount',
  ufw: 'community.general.ufw',
  timezone: 'community.general.timezone',
  postgresql_db: 'community.postgresql.postgresql_db',
  postgresql_user: 'community.postgresql.postgresql_user',
  mysql_db: 'community.mysql.mysql_db',
  mysql_user: 'community.mysql.mysql_user',
  win_feature: 'ansible.windows.win_feature',
  win_service: 'ansible.windows.win_service',
  win_user: 'ansible.windows.win_user',
  win_updates: 'ansible.windows.win_updates',
  win_copy: 'ansible.windows.win_copy',
  win_shell: 'ansible.windows.win_shell',
}
const TASK_KEYS = new Set(
  'name action args async become become_user become_method changed_when check_mode delay delegate_to diff environment failed_when ignore_errors loop loop_control no_log notify poll register retries run_once tags until vars when with_items with_dict listen block rescue always local_action'.split(' '),
)
const MODULE_FOR: Record<string, string> = {
  systemctl: 'systemd',
  service: 'service',
  yum: 'yum',
  dnf: 'dnf',
  apt: 'apt',
  'apt-get': 'apt-get',
  git: 'git',
  curl: 'get_url or uri',
  wget: 'get_url or uri',
  chmod: 'file',
  chown: 'file',
  mkdir: 'file',
  ln: 'file',
  rm: 'file',
  useradd: 'user',
  usermod: 'user',
  crontab: 'cron',
  rsync: 'synchronize',
  tar: 'unarchive',
  unzip: 'unarchive',
  mount: 'mount',
  sed: 'replace, lineinfile or template',
}

function taskWalk(tasks: unknown, cb: (t: Record<string, unknown>, handler: boolean) => void, handler = false) {
  if (!Array.isArray(tasks)) return
  for (const t of tasks) {
    if (!t || typeof t !== 'object') continue
    const r = t as Record<string, unknown>
    if ('block' in r) {
      taskWalk(r.block, cb, handler)
      taskWalk(r.rescue, cb, handler)
      taskWalk(r.always, cb, handler)
    } else cb(r, handler)
  }
}

function moduleKey(r: Record<string, unknown>): string | undefined {
  return Object.keys(r).find((k) => !TASK_KEYS.has(k) && !k.startsWith('with_'))
}

export function lintFiles(files: { name: string; text: string }[]): { output: string; failures: number } {
  const vs: Violation[] = []
  for (const f of files) {
    const lines = f.text.split('\n')
    // reglas de texto
    lines.forEach((l, i) => {
      if (/[ \t]+$/.test(l)) vs.push({ rule: 'yaml[trailing-spaces]', message: 'Trailing spaces', file: f.name, line: i + 1, detail: '' })
      if (l.length > 160) vs.push({ rule: 'yaml[line-length]', message: `Line too long (${l.length} > 160 characters)`, file: f.name, line: i + 1, detail: '' })
      const tr = /:\s+(yes|no|Yes|No|YES|NO|True|False|TRUE|FALSE|on|off)\s*(#.*)?$/.exec(l)
      if (tr && !l.trim().startsWith('#')) vs.push({ rule: 'yaml[truthy]', message: `Truthy value should be one of [false, true]`, file: f.name, line: i + 1, detail: '' })
      for (const m of l.matchAll(/\{\{(\S[^}]*?|[^}]*?\S)\}\}/g)) {
        if (!/^\s.*\s$/.test(m[1])) vs.push({ rule: 'jinja[spacing]', message: `Jinja2 spacing could be improved: ${m[0]} -> {{ ${m[1].trim()} }}`, file: f.name, line: i + 1, detail: '' })
      }
    })
    let loaded
    try {
      loaded = loadYaml(f.text)
    } catch (e) {
      const ye = e as YamlLoadError
      vs.push({ rule: 'load-failure', message: `Failed to load YAML file: ${ye.message}`, file: f.name, line: ye.line ?? 1, detail: '' })
      continue
    }
    const data = loaded.data
    const where = (o: object) => loaded.where.get(o)?.line ?? 1
    const isPlaybook = Array.isArray(data) && data.some((p) => p && typeof p === 'object' && ('hosts' in p || 'import_playbook' in p))
    const isTasks = Array.isArray(data) && !isPlaybook && /(^|\/)(tasks|handlers)\//.test(f.name)
    const checkTask = (r: Record<string, unknown>, handler: boolean) => {
      const mod = moduleKey(r)
      const line = where(r)
      const label = `Task/Handler: ${r.name ?? mod ?? 'unnamed'}`
      if (!r.name) vs.push({ rule: 'name[missing]', message: 'All tasks should be named.', file: f.name, line, detail: label })
      else if (typeof r.name === 'string' && /^[a-zñáéíóú]/.test(r.name)) vs.push({ rule: 'name[casing]', message: 'All names should start with an uppercase letter.', file: f.name, line, detail: label })
      if (r.name && Object.keys(r)[0] !== 'name' && !('block' in r)) vs.push({ rule: 'key-order[task]', message: `You can improve the task key order to: name, ${mod ?? ''}`.replace(/, $/, ''), file: f.name, line, detail: label })
      if (!mod) return
      const short = mod.split('.').pop()!
      if (!mod.includes('.')) {
        if (BUILTIN.has(short)) vs.push({ rule: 'fqcn[action-core]', message: `Use FQCN for builtin module actions (${mod}).`, file: f.name, line, detail: label })
        else if (OTHER[short]) vs.push({ rule: 'fqcn[action]', message: `Use FQCN for module actions, such \`${OTHER[short]}\`.`, file: f.name, line, detail: label })
      }
      const args = r[mod]
      if (typeof args === 'string' && /\w+=/.test(args) && !['command', 'shell', 'raw', 'meta', 'include_tasks', 'import_tasks'].includes(short)) vs.push({ rule: 'no-free-form', message: `Avoid using free-form when calling module actions. (${mod})`, file: f.name, line, detail: label })
      if (['command', 'shell'].includes(short)) {
        const cmd = typeof args === 'string' ? args : String((args as Record<string, unknown>)?.cmd ?? '')
        const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>
        if (r.changed_when === undefined && !a.creates && !a.removes && !/(^|\s)(creates|removes)=/.test(cmd) && !handler) vs.push({ rule: 'no-changed-when', message: 'Commands should not change things if nothing needs doing.', file: f.name, line, detail: label })
        const first = cmd.trim().split(/\s+/)[0]?.replace(/^.*\//, '')
        if (first && MODULE_FOR[first]) vs.push({ rule: 'command-instead-of-module', message: `${first} used in place of ${MODULE_FOR[first]} module`, file: f.name, line, detail: label })
        if (short === 'shell' && !/[|&;<>*?$`(){}[\]~]/.test(cmd)) vs.push({ rule: 'command-instead-of-shell', message: 'Use shell only when shell functionality is required.', file: f.name, line, detail: label })
      }
      if (['copy', 'template', 'file'].includes(short) && args && typeof args === 'object') {
        const a = args as Record<string, unknown>
        const state = String(a.state ?? 'file')
        if (a.mode === undefined && !(short === 'file' && ['absent', 'link'].includes(state))) vs.push({ rule: 'risky-file-permissions', message: 'File permissions unset or incorrect.', file: f.name, line, detail: label })
        if (typeof a.mode === 'number' && !/mode:\s*0\d/.test(loaded.lines.slice(line - 1, line + 10).join('\n'))) vs.push({ rule: 'risky-octal', message: 'Octal file permissions must contain leading zero or be a string.', file: f.name, line, detail: label })
      }
      if (['package', 'dnf', 'yum', 'apt'].includes(short) && args && typeof args === 'object' && (args as Record<string, unknown>).state === 'latest') vs.push({ rule: 'package-latest', message: 'Package installs should not use latest.', file: f.name, line, detail: label })
      const whens = r.when === undefined ? [] : Array.isArray(r.when) ? r.when : [r.when]
      for (const w of whens) {
        const s = String(w)
        if (/\{\{|\{%/.test(s)) vs.push({ rule: 'no-jinja-when', message: 'No Jinja2 in when.', file: f.name, line, detail: label })
        if (/(==|!=)\s*(True|False|true|false)\b/.test(s)) vs.push({ rule: 'literal-compare', message: "Don't compare to literal True/False.", file: f.name, line, detail: label })
        if (/\.changed\b|is\s+changed/.test(s) && !handler) vs.push({ rule: 'no-handler', message: 'Tasks that run when changed should likely be handlers.', file: f.name, line, detail: label })
      }
      if (r.become_user !== undefined && r.become === undefined) vs.push({ rule: 'partial-become', message: 'become_user should have a corresponding become at the play or task level.', file: f.name, line, detail: label })
      if (r.ignore_errors !== undefined && r.ignore_errors !== false && !r.register) vs.push({ rule: 'ignore-errors', message: 'Use failed_when and specify error conditions instead of using ignore_errors.', file: f.name, line, detail: label })
    }
    if (isPlaybook) {
      for (const p of data as Record<string, unknown>[]) {
        if (!p || typeof p !== 'object') continue
        if ('hosts' in p && !p.name) vs.push({ rule: 'name[play]', message: 'All plays should be named.', file: f.name, line: where(p), detail: '' })
        for (const k of ['pre_tasks', 'tasks', 'post_tasks']) taskWalk(p[k], checkTask)
        taskWalk(p.handlers, checkTask, true)
      }
    } else if (isTasks) taskWalk(data, checkTask, /(^|\/)handlers\//.test(f.name))
  }
  vs.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
  const n = vs.length
  const nFiles = files.length
  const worst = vs.length ? Math.min(...vs.map((v) => ORDER.indexOf(PROFILE[v.rule] ?? 'basic'))) : ORDER.length
  const last = worst === 0 ? undefined : ORDER[worst - 1]
  if (!n) return { output: `\nPassed: 0 failure(s), 0 warning(s) on ${nFiles} files. Last profile that met the validation criteria was 'production'.\n`, failures: 0 }
  let out = `WARNING  Listing ${n} violation(s) that are fatal\n`
  for (const v of vs) out += `${v.rule}: ${v.message}\n${v.file}:${v.line}${v.detail ? ` ${v.detail}` : ''}\n\n`
  out += 'Read documentation for instructions on how to ignore specific rule violations.\n\n# Rule Violation Summary\n\n  count tag                       profile    rule associated tags\n'
  const counts = new Map<string, number>()
  for (const v of vs) counts.set(v.rule, (counts.get(v.rule) ?? 0) + 1)
  for (const [rule, c] of [...counts].sort((a, b) => ORDER.indexOf(PROFILE[a[0]] ?? 'basic') - ORDER.indexOf(PROFILE[b[0]] ?? 'basic') || a[0].localeCompare(b[0]))) {
    out += `${String(c).padStart(7)} ${rule.padEnd(25)} ${(PROFILE[rule] ?? 'basic').padEnd(10)} ${TAGS[rule] ?? ''}\n`
  }
  out += `\nFailed: ${n} failure(s), 0 warning(s) on ${nFiles} files.${last ? ` Last profile that met the validation criteria was '${last}'.` : ''}\n`
  return { output: out, failures: n }
}
